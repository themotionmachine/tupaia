import {
  emblemClassSignature,
  forgetEmblemClass,
  rememberEmblemClass,
  TRANSIENT_EMBLEM_CLASS
} from "../renderers/emblems/transient-classes";
import type { Camera, Viewport } from "./camera";
import { HiddenEmblemPaint } from "./emblem-paint";

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
export class HiddenEmblemCulling {
  private paint = new HiddenEmblemPaint();
  private paintReady = false;
  private moving = false;
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
    private canvas: HTMLCanvasElement
  ) {
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

  status() {
    return {
      paintSuppressed: this.paint.active,
      paintEligible: this.paintReady,
      paintIssue: this.paint.issue,
      hidden: this.owned.size,
      tracked: this.entries.length,
      rebuilds: this.rebuilds,
      enabled: this.canCover && this.opaque
    };
  }

  private changed(records: MutationRecord[]): void {
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
    }
    if (this.dirty) this.paint.set(false);
    // Visibility changes used by canonical previews must reveal the original SVG synchronously at this checkpoint.
    if (this.canvas.style.display === "none" || this.canvas.style.visibility === "hidden" || this.canvas.hidden)
      this.reveal();
    else if (this.dirty || this.appearanceDirty) this.queue();
  }

  private queue(): void {
    if (!this.opaque || !this.last || this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.last) this.update(this.last.camera, this.last.viewport, this.opaque, this.moving);
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
    this.paint.set(false);
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
  }

  private rebuild(): void {
    this.reveal();
    this.entries = [];
    this.paintReady = false;
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
    this.paintReady = this.paint.eligible(root, this.layer, this.definitions);
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

  update(camera: Camera, viewport: Viewport, opaque: boolean, moving = false): void {
    this.moving = moving;
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
    this.paint.set(this.paintReady && moving);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    this.paint.dispose();
    document.fonts.removeEventListener("loadingdone", this.fontChanged);
    this.reveal();
    this.entries = [];
    this.last = null;
    this.opaque = false;
  }
}
