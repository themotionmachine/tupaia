import {
  emblemClassSignature,
  forgetEmblemClass,
  rememberEmblemClass,
  TRANSIENT_EMBLEM_CLASS
} from "../renderers/emblems/transient-classes";
import type { Camera, Viewport } from "./camera";
import { type CoverStatus, SvgCover } from "./svg-cover";

interface Entry {
  element: SVGGraphicsElement;
  bounds: [number, number, number, number];
}
const animated = (element: Element) =>
  element.getAnimations({ subtree: true }).some(animation => animation.playState !== "finished") ||
  !!element.querySelector("animate,animateMotion,animateTransform,set");

// Only the copy underneath an OPAQUE GPU frame is culled. Chrome changes SVG raster/compositor decisions
// when offscreen <use>s disappear; restoring all classes BEFORE revealing SVG preserves its original pixels.
// Geometry remains canonical: prepare-time hit extraction temporarily exposes transiently culled leaves.
// PANEND (W4b): the same conditions (an opaque frame that covers the whole SVG) admit the SVG cover (svg-cover.ts),
// which stops the model's paint altogether; while it is on, nothing is culled (hidden paint costs nothing to keep).
// The emblem-only paint suppression this class offered for motion is gone: the renderer never used it (toggling it
// cost two whole-document layerizes a gesture), and the cover subsumes it.
export class HiddenEmblemCulling {
  private cover: SvgCover | null;
  private coverWanted = false;
  private coverDirty = true; // the cover's eligibility must be checked again before it applies
  // The renderer is moving (its last update passed cull=false): a source change seen meanwhile must not cull either.
  // Before W4b the queued update re-culled at the gesture-start camera mid-gesture whenever a COA arrived in #coas as
  // emblems panned into view: hundreds of class writes, a whole-document layerize (~150 ms on parity) during motion.
  private held = false;
  private root: SVGSVGElement | null = null;
  private layer: Element | null = null;
  private definitions: Element | null = null;
  private owned = new Map<Element, string | null>();
  private entries: Entry[] = [];
  private dirty = true;
  private appearanceDirty = true;
  private canCover = false;
  private opaque = false;
  private last: { camera: Camera; viewport: Viewport } | null = null;
  private raf = 0;
  private rebuilds = 0;
  private observer: MutationObserver;
  private fontChanged = () => {
    this.dirty = true;
    this.queue();
  };

  constructor(
    private svg: () => SVGSVGElement,
    private canvas: HTMLCanvasElement,
    coverEnabled = true
  ) {
    this.cover = coverEnabled ? new SvgCover() : null;
    this.observer = new MutationObserver(records => this.changed(records));
    this.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true
    });
    document.fonts.addEventListener("loadingdone", this.fontChanged);
  }

  status(): {
    paintSuppressed: boolean;
    cover: (CoverStatus & { wanted: boolean }) | null;
    hidden: number;
    tracked: number;
    rebuilds: number;
    enabled: boolean;
  } {
    return {
      // the model SVG's paint is suppressed under the canvas (the cover); also the marker
      // bench/renderer-bundle-boundary.ts looks for in GPU presentation code
      paintSuppressed: !!this.cover?.active,
      cover: this.cover && { ...this.cover.status(), wanted: this.coverWanted },
      hidden: this.owned.size,
      tracked: this.entries.length,
      rebuilds: this.rebuilds,
      enabled: this.canCover && this.opaque
    };
  }

  private changed(records: MutationRecord[]): void {
    const local: Element[] = []; // what the records touched, for the cover's local check
    let appeared = false; // nodes or ids anywhere: a reference the cover found unresolved may resolve now
    for (const record of records) {
      const target = record.target as Element;
      if (target === this.canvas) {
        this.appearanceDirty = true;
        continue;
      }
      const source =
        this.layer?.contains(target) ||
        this.definitions?.contains(target) ||
        ((!!target.closest?.("defs") || !!target.querySelector?.("defs")) && !target.closest("#fantasyMap"));
      if (
        source &&
        record.attributeName === "class" &&
        emblemClassSignature(record.oldValue) === emblemClassSignature(target.getAttribute("class"))
      )
        continue;
      const tag = target.nodeName.toLowerCase();
      const stylesheet = tag === "style" || tag === "link" || target.parentElement?.nodeName.toLowerCase() === "style";
      const ancestor = target === this.root || target.contains?.(this.canvas);
      const added = [...record.addedNodes, ...record.removedNodes].some(node => {
        const element = node as Element;
        return (
          element.matches?.("style,link,defs,#emblems,#coas") ||
          element.querySelector?.("style,link,defs,#emblems,#coas")
        );
      });
      if (source || stylesheet || ancestor || added) {
        this.dirty = true;
        if (stylesheet || ancestor || added) this.appearanceDirty = true;
      }
      // The cover: sheets changed (rescan the rules), or an ancestor's attributes (a class an author rule keys on) need
      // the full check; an ancestor's children (the export clone's host svg coming and going under <body>) do not
      const sheets = stylesheet || [...record.addedNodes, ...record.removedNodes].some(sheetNode);
      if (sheets) this.cover?.sheetsChanged();
      if (sheets || (ancestor && record.type === "attributes")) this.coverDirty = true;
      if (record.addedNodes.length || record.attributeName === "id") appeared = true;
      const kind = this.coverDirty ? "" : coverRecord(record, this.root, id => !!this.cover?.follows(id));
      if (kind === "full" || (kind === "local" && !this.cover?.active)) this.coverDirty = true;
      else if (kind === "local") {
        if (record.type === "attributes") local.push(target);
        else for (const node of record.addedNodes) if (node instanceof Element) local.push(node);
      }
    }
    // Visibility changes used by canonical previews must reveal the original SVG synchronously at this checkpoint.
    if (this.canvas.style.display === "none" || this.canvas.style.visibility === "hidden" || this.canvas.hidden)
      this.reveal();
    else {
      // A change that could make the cover alter a canonical hit (an explicit hidden or visible* pointer-events, a link,
      // an author rule) ends it here, before any later event is dispatched against the model.
      if (this.cover?.active) {
        if (appeared && !this.coverDirty) local.push(...this.cover.resolved());
        const issue = !this.coverDirty && local.length ? this.cover.checkLocal(local) : "";
        // an issue stands until a full check clears it; "full" (a new reference) asks for one now
        if (issue) this.coverDirty = true;
        if (issue === "full" ? !this.coverEligible() : issue || (this.coverDirty && !this.coverEligible()))
          this.uncover();
      }
      if (this.dirty || this.appearanceDirty || (this.coverDirty && this.coverWanted)) this.queue();
    }
  }

  private coverEligible(): boolean {
    if (!this.coverDirty) return this.cover!.issue === "";
    this.coverDirty = false;
    return this.cover!.eligible(this.root ?? this.svg());
  }

  private uncover(): void {
    if (!this.cover?.active) return;
    this.cover.apply(false);
    this.dirty = true; // culling bounds are not rebuilt while covered
  }

  private queue(): void {
    if (!this.opaque || !this.last || this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.last) this.update(this.last.camera, this.last.viewport, this.opaque, this.coverWanted, !this.held);
    });
  }

  private restore(element: Element, original: string | null): void {
    forgetEmblemClass(element);
    const current = element.getAttribute("class");
    if (emblemClassSignature(current) === emblemClassSignature(original)) {
      if (original === null) element.removeAttribute("class");
      else element.setAttribute("class", original);
    } else {
      // Preserve unrelated author edits made while our transient token was present.
      element.classList.remove(TRANSIENT_EMBLEM_CLASS);
      if (original === null && !element.getAttribute("class")) element.removeAttribute("class");
    }
  }

  reveal(): void {
    this.uncover();
    for (const [element, original] of this.owned) this.restore(element, original);
    this.owned.clear();
  }

  reset(): void {
    this.reveal();
    this.root = null;
    this.layer = this.definitions = null;
    this.entries = [];
    this.dirty = true;
    this.appearanceDirty = true;
    this.coverDirty = true;
  }

  private rebuild(): void {
    this.reveal();
    this.entries = [];
    const root = this.root!;
    this.layer = root.querySelector("#emblems");
    this.definitions = document.getElementById("coas");
    this.dirty = false;
    this.rebuilds++;
    const viewbox = root.querySelector<SVGGraphicsElement>("#viewbox");
    const world = viewbox?.getScreenCTM();
    if (!world || !this.layer || animated(this.layer)) return;
    let inverse: DOMMatrix;
    try {
      inverse = world.inverse();
    } catch {
      return;
    }
    // Effects on ancestors can bring offscreen ink back into the viewport. Unknown effects remain unculled.
    for (let node: Element | null = this.layer; node; node = node.parentElement) {
      const css = getComputedStyle(node);
      if (
        (css.filter && css.filter !== "none") ||
        (css.maskImage && css.maskImage !== "none") ||
        node.getAnimations().some(animation => animation.playState !== "finished")
      )
        return;
      if (node === root) break;
    }
    for (const element of this.layer.querySelectorAll<SVGGraphicsElement>("use")) {
      if (element.classList.contains(TRANSIENT_EMBLEM_CLASS)) continue; // another controller owns this hidden state
      const href = element.getAttribute("href") ?? element.getAttribute("xlink:href") ?? "";
      if (!/^#(?:burg|state|province)COA\d+$/.test(href)) continue;
      const source = document.getElementById(href.slice(1));
      if (!source || source.tagName !== "svg" || !this.definitions?.contains(source) || animated(source)) continue;
      let effects = false;
      for (let node = element.parentElement; node && node !== this.layer; node = node.parentElement) {
        const css = getComputedStyle(node);
        if ((css.filter && css.filter !== "none") || (css.maskImage && css.maskImage !== "none")) {
          effects = true;
          break;
        }
      }
      if (effects) continue;
      const css = getComputedStyle(element),
        sourceCss = getComputedStyle(source);
      if ((sourceCss.filter && sourceCss.filter !== "none") || (sourceCss.maskImage && sourceCss.maskImage !== "none"))
        continue;
      if (css.display === "none" || css.visibility !== "visible" || (css.filter && css.filter !== "none")) continue;
      if (!["hidden", "clip"].includes(sourceCss.overflow)) continue;
      const box = element.getBBox(),
        matrix = element.getScreenCTM();
      if (!matrix || !(box.width > 0 && box.height > 0)) continue; // unresolved async COA: keep visible
      const m = inverse.multiply(matrix);
      const xs: number[] = [],
        ys: number[] = [];
      for (const [x, y] of [
        [box.x, box.y],
        [box.x + box.width, box.y],
        [box.x + box.width, box.y + box.height],
        [box.x, box.y + box.height]
      ]) {
        xs.push(m.a * x + m.c * y + m.e);
        ys.push(m.b * x + m.d * y + m.f);
      }
      const bounds: Entry["bounds"] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      if (bounds.every(Number.isFinite)) this.entries.push({ element, bounds });
    }
  }

  // `cover`: the renderer wants the SVG cover (armed by motion: GpuRenderer.camera). `cull`: false while moving, where
  // only the cover may change (culling writes wait for rest).
  update(camera: Camera, viewport: Viewport, opaque: boolean, cover = false, cull = true): void {
    this.coverWanted = cover && !!this.cover;
    this.held = !cull;
    if (this.last && (this.last.viewport.width !== viewport.width || this.last.viewport.height !== viewport.height))
      this.appearanceDirty = true;
    this.last = { camera: { ...camera }, viewport: { ...viewport } };
    this.opaque = opaque;
    const root = this.svg();
    if (root !== this.root) {
      this.reset();
      this.root = root;
    }
    // Drain source changes before using cached bounds, including changes earlier in this same task.
    const records = this.observer.takeRecords();
    if (records.length) this.changed(records);
    if (this.appearanceDirty) {
      const css = getComputedStyle(this.canvas);
      this.canCover =
        css.display !== "none" &&
        css.visibility === "visible" &&
        !animated(this.canvas) &&
        Number(css.opacity) === 1 &&
        (!css.filter || css.filter === "none") &&
        (!css.maskImage || css.maskImage === "none") &&
        (!css.backdropFilter || css.backdropFilter === "none") &&
        (!css.clipPath || css.clipPath === "none") &&
        (!css.transform || css.transform === "none") &&
        (!css.mixBlendMode || css.mixBlendMode === "normal");
      for (let node = this.canvas.parentElement; this.canCover && node; node = node.parentElement) {
        const ancestor = getComputedStyle(node);
        if (
          Number(ancestor.opacity) !== 1 ||
          (ancestor.filter && ancestor.filter !== "none") ||
          (ancestor.maskImage && ancestor.maskImage !== "none") ||
          (ancestor.transform && ancestor.transform !== "none") ||
          (ancestor.backdropFilter && ancestor.backdropFilter !== "none") ||
          (ancestor.clipPath && ancestor.clipPath !== "none") ||
          (ancestor.mixBlendMode && ancestor.mixBlendMode !== "normal") ||
          node.getAnimations().some(animation => animation.playState !== "finished")
        )
          this.canCover = false;
      }
      const covered = this.canvas.getBoundingClientRect(),
        original = root.getBoundingClientRect();
      this.canCover &&=
        covered.left <= original.left &&
        covered.top <= original.top &&
        covered.right >= original.right &&
        covered.bottom >= original.bottom;
      this.appearanceDirty = false;
    }
    if (!opaque || !this.canCover || !(camera.k > 0)) {
      this.reveal();
      return;
    }
    if (this.coverWanted && this.coverEligible()) {
      // nothing paints under the cover: culled emblems come back at rest (cheap now), so the model is whole when
      // revealed. A held (moving) update writes nothing: the culls of the gesture that armed the cover stay until rest.
      this.cover!.apply(true);
      if (!cull) return;
      for (const [element, original] of this.owned) this.restore(element, original);
      this.owned.clear();
      return;
    }
    this.uncover();
    if (!cull) return;
    if (this.dirty) {
      try {
        this.rebuild();
      } catch {
        // Optional presentation work must never turn an unusual native SVG geometry failure into a blank frame.
        this.reveal();
        this.entries = [];
        this.dirty = false;
      }
    }
    const padding = 160;
    for (const {
      element,
      bounds: [left, top, right, bottom]
    } of this.entries) {
      const outside =
        right * camera.k + camera.x < -padding ||
        left * camera.k + camera.x > viewport.width + padding ||
        bottom * camera.k + camera.y < -padding ||
        top * camera.k + camera.y > viewport.height + padding;
      if (outside && !this.owned.has(element)) {
        this.owned.set(element, element.getAttribute("class"));
        rememberEmblemClass(element, element.getAttribute("class"));
        element.classList.add(TRANSIENT_EMBLEM_CLASS);
      } else if (!outside && this.owned.has(element)) {
        this.restore(element, this.owned.get(element)!);
        this.owned.delete(element);
      }
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    this.cover?.dispose();
    document.fonts.removeEventListener("loadingdone", this.fontChanged);
    this.reveal();
    this.entries = [];
    this.last = null;
    this.opaque = false;
  }
}

// A stylesheet node, or a subtree holding one (the export clone's host carries none of the model's sheets).
const sheetNode = (node: Node) => {
  const element = node as Element;
  return !!(element.matches?.("style,link") || element.querySelector?.("style,link"));
};

// Attributes whose change can alter what the cover would hide or make hittable (or what an author rule matches).
const COVER_ATTRIBUTES = new Set([
  "visibility",
  "pointer-events",
  "style",
  "class",
  "id",
  "tabindex",
  "contenteditable",
  "href",
  "xlink:href"
]);

// A record that can change the cover's eligibility: an added subtree or a relevant attribute in the model or in a
// definition outside it (a <use> instantiates those under the cover). Geometry, transforms and text never can.
// "local": the touched elements alone can tell (SvgCover.checkLocal); "full": an id change can retarget references.
function coverRecord(
  record: MutationRecord,
  root: Element | null,
  followed: (id: string) => boolean
): "" | "local" | "full" {
  const target = record.target as Element;
  const inside = (!!root && root.contains(target)) || !!target.closest?.("defs, symbol, #defElements");
  if (!inside) return "";
  if (record.type === "attributes") {
    const name = record.attributeName ?? "";
    // a new id can retarget a reference the last full check followed; any other (d3's append().attr("id")) is local
    if (name === "id") return followed(target.id) ? "full" : "local";
    return COVER_ATTRIBUTES.has(name) ? "local" : "";
  }
  return record.type === "childList" && record.addedNodes.length > 0 ? "local" : "";
}
