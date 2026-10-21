import { quadtree } from "d3";
import { createReliefViewport, type ReliefViewport } from "./relief-viewport";

interface Glyph {
  x: number;
  y: number;
  markup: string;
  sourceId?: string;
  radius: number;
  order: number;
}
type Bounds = [number, number, number, number];
interface Entry {
  image: SVGImageElement;
  overlay: SVGGElement;
  tree: ReturnType<typeof quadtree<Glyph>>;
  radius: number;
  visible: Map<number, SVGElement>;
  bounds: Bounds | null;
  originalVisibility: string;
  originalStyle: string | null;
  shown: boolean;
  raster?: ReliefViewport;
  rasterScale: number;
}
const cache = new WeakMap<SVGImageElement, Entry>();
const active = new Set<Entry>();
const namespace = "http://www.w3.org/2000/svg";
let mapRoot: Element | null = null;
let images: SVGImageElement[] = [];
let imagesDirty = true;
let observer: MutationObserver | undefined;
let symbolObserver: MutationObserver | undefined;
let symbolRefresh = 0;
const imageSelector = "image[data-relief],image[data-burg-vectors]";
const expectedStyles = new WeakMap<SVGImageElement, string | null>();
let dirtyMetadata = new WeakSet<SVGImageElement>();
let unavailable = new WeakSet<SVGImageElement>();
let lastCamera: [number, number, number, number, number] | undefined;
function mutations(records: MutationRecord[]): void {
  for (const record of records) {
    if (record.type === "attributes") {
      const target = record.target as SVGImageElement;
      if (!target.matches?.(imageSelector)) continue;
      if (
        record.attributeName === "style" &&
        expectedStyles.has(target) &&
        expectedStyles.get(target) === target.getAttribute("style")
      )
        continue;
      dirtyMetadata.add(target);
      imagesDirty = true;
      continue;
    }
    if ((record.target as Element).closest?.("[data-dense-zoom]")) continue;
    if (
      [...record.addedNodes, ...record.removedNodes].some(node => {
        const element = node as Element;
        if (element.hasAttribute?.("data-dense-zoom")) return false;
        return element.matches?.(imageSelector) || element.querySelector?.(imageSelector);
      })
    )
      imagesDirty = true;
  }
}
function mapImages(): SVGImageElement[] {
  const nextRoot = document.getElementById("map");
  if (nextRoot !== mapRoot) {
    observer?.disconnect();
    symbolObserver?.disconnect();
    if (symbolRefresh) cancelAnimationFrame(symbolRefresh);
    symbolRefresh = 0;
    for (const entry of active) release(entry);
    mapRoot = nextRoot;
    images = [];
    imagesDirty = true;
    dirtyMetadata = new WeakSet();
    unavailable = new WeakSet();
    if (mapRoot) {
      observer = new MutationObserver(mutations);
      observer.observe(mapRoot, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [
          "data-relief",
          "data-burg-vectors",
          "style",
          "class",
          "transform",
          "filter",
          "mask",
          "clip-path",
          "x",
          "y",
          "width",
          "height",
          "opacity"
        ]
      });
      if (typeof document.createElement === "function") {
        symbolObserver = new MutationObserver(records => {
          const relevant = records.some(record => {
            const target = record.target as Element;
            return (
              target.id === "terrain" ||
              target.closest?.("symbol") ||
              [...record.addedNodes, ...record.removedNodes].some(node => {
                const element = node as Element;
                return element.tagName?.toLowerCase() === "symbol" || element.querySelector?.("symbol");
              })
            );
          });
          if (!relevant) return;
          for (const entry of active) if (entry.image.hasAttribute("data-relief")) dirtyMetadata.add(entry.image);
          if (!symbolRefresh)
            symbolRefresh = requestAnimationFrame(() => {
              symbolRefresh = 0;
              if (lastCamera) refreshDenseZoom(...lastCamera);
            });
        });
        const options = { subtree: true, childList: true, characterData: true, attributes: true };
        const globalDefs = document.getElementById("defElements");
        if (globalDefs) symbolObserver.observe(globalDefs, options);
        for (const defs of mapRoot.querySelectorAll("defs")) symbolObserver.observe(defs, options);
        const terrain = mapRoot.querySelector("#terrain");
        if (terrain) symbolObserver.observe(terrain, { attributes: true });
      }
    }
  }
  // Synchronous editing followed by refresh can precede observer delivery.
  mutations(observer?.takeRecords() || []);
  if (images.some(image => !image.isConnected)) imagesDirty = true;
  if (imagesDirty) {
    images = mapRoot ? [...mapRoot.querySelectorAll<SVGImageElement>(imageSelector)] : [];
    imagesDirty = false;
  }
  return images;
}
function restoreImageVisibility(image: SVGImageElement): void {
  const marker = image.getAttribute("data-zoom-visibility");
  if (marker) {
    try {
      const [original, value, priority, hidden] = JSON.parse(marker);
      if (
        (typeof original === "string" || original === null) &&
        typeof value === "string" &&
        typeof priority === "string" &&
        typeof hidden === "string"
      ) {
        if (image.getAttribute("style") === hidden) {
          if (original === null) image.removeAttribute("style");
          else image.setAttribute("style", original);
        } else {
          if (value) image.style.setProperty("visibility", value, priority);
          else image.style.removeProperty("visibility");
          if (original === null && !image.style.cssText.trim()) image.removeAttribute("style");
        }
      } else image.style.removeProperty("visibility");
    } catch {
      image.style.removeProperty("visibility");
    }
  } else image.style.removeProperty("visibility");
  image.removeAttribute("data-zoom-visibility");
  image.removeAttribute("data-zoom-hidden");
  expectedStyles.set(image, image.getAttribute("style"));
}
function show(entry: Entry, shown: boolean): void {
  if (entry.shown === shown) return;
  entry.shown = shown;
  if (shown) {
    entry.overlay.style.removeProperty("display");
    const priority = entry.image.style.getPropertyPriority?.("visibility") || "";
    entry.image.style.visibility = "hidden";
    expectedStyles.set(entry.image, entry.image.getAttribute("style"));
    entry.image.setAttribute(
      "data-zoom-visibility",
      JSON.stringify([entry.originalStyle, entry.originalVisibility, priority, entry.image.getAttribute("style") || ""])
    );
    entry.image.setAttribute("data-zoom-hidden", "");
  } else {
    entry.overlay.style.display = "none";
    restoreImageVisibility(entry.image);
  }
}
function release(entry: Entry): void {
  entry.raster?.dispose();
  entry.overlay.remove();
  entry.visible.clear();
  entry.bounds = null;
  if (entry.shown) restoreImageVisibility(entry.image);
  active.delete(entry);
  cache.delete(entry.image);
}
export function clearDenseZoom(root: ParentNode): void {
  // Live-root cleanup releases indexes as well; snapshot clones have no cached entries.
  const container = root as Node;
  if (typeof container.contains === "function")
    for (const entry of active) if (container.contains(entry.image)) release(entry);
  for (const overlay of root.querySelectorAll("[data-dense-zoom]")) overlay.remove();
  for (const image of root.querySelectorAll<SVGImageElement>("image[data-zoom-hidden]")) {
    restoreImageVisibility(image);
  }
}
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;")
    .replace(/\t/g, "&#9;");
}
function glyphs(image: SVGImageElement): Glyph[] | undefined {
  const relief = image.getAttribute("data-relief");
  if (relief !== null) {
    try {
      const data: unknown = JSON.parse(relief);
      if (
        !Array.isArray(data) ||
        !data.every(
          r =>
            r &&
            typeof r.i === "string" &&
            typeof r.x === "number" &&
            typeof r.y === "number" &&
            typeof r.s === "number" &&
            Number.isFinite(r.x) &&
            Number.isFinite(r.y) &&
            Number.isFinite(r.s) &&
            r.s > 0
        )
      )
        return;
      return data.map((r, order) => ({
        order,
        sourceId: r.i,
        x: r.x + r.s / 2,
        y: r.y + r.s / 2,
        radius: r.s,
        markup: `<use href="${escapeAttribute(r.i)}" x="${r.x}" y="${r.y}" width="${r.s}" height="${r.s}"/>`
      }));
    } catch {
      return;
    }
  }
  const template = document.createElementNS(namespace, "g");
  template.innerHTML = image.getAttribute("data-burg-vectors") || "";
  return [...template.querySelectorAll<SVGUseElement>("use")]
    .map((use, order) => ({
      order,
      x: Number(use.getAttribute("x")),
      y: Number(use.getAttribute("y")),
      radius: 30,
      markup: use.outerHTML
    }))
    .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
}
const terrainPaint = ["fill", "stroke", "stroke-width", "font-size", "class", "filter", "mask", "clip-path"];
/** Whether #terrain's own paint lets relief glyphs come from the raster viewport instead of per-glyph <use> nodes. */
export function terrainAllowsRaster(terrain: SVGElement | null): boolean {
  if (!terrain) return true;
  // An empty or "none" filter/mask/clip-path (the pale and light presets write mask="") paints exactly like no attribute;
  // only a value that changes the glyphs' look forces the per-glyph <use> fallback.
  const inert = (name: string, value: string | null | undefined) =>
    !value?.trim() || (["filter", "mask", "clip-path"].includes(name) && value.trim().toLowerCase() === "none");
  return terrainPaint.every(
    name => inert(name, terrain.getAttribute(name)) && inert(name, terrain.style?.getPropertyValue?.(name))
  );
}
function createEntry(image: SVGImageElement): Entry | undefined {
  const unsupportedImage = ["class", "transform", "filter", "mask", "clip-path", "opacity"];
  if (
    unsupportedImage.some(name => image.hasAttribute(name)) ||
    ["hidden", "collapse"].includes(image.style.visibility) ||
    (typeof image.style.item === "function" && [...image.style].some(name => name !== "visibility"))
  )
    return;
  if (
    image.hasAttribute("data-relief") &&
    ((image.hasAttribute("x") && Number(image.getAttribute("x")) !== 0) ||
      (image.hasAttribute("y") && Number(image.getAttribute("y")) !== 0) ||
      (image.hasAttribute("width") &&
        typeof graphWidth === "number" &&
        Number(image.getAttribute("width")) !== graphWidth) ||
      (image.hasAttribute("height") &&
        typeof graphHeight === "number" &&
        Number(image.getAttribute("height")) !== graphHeight))
  )
    return;
  const points = glyphs(image);
  if (!points) return;
  const overlay = document.createElementNS(namespace, "g");
  overlay.setAttribute("data-dense-zoom", "");
  const rasterSupported = terrainAllowsRaster(image.closest("#terrain") as SVGElement | null);
  const entry: Entry = {
    image,
    overlay,
    raster:
      rasterSupported && points.every(point => point.sourceId)
        ? createReliefViewport(overlay, () => {
            if (lastCamera && image.isConnected && cache.get(image) === entry) {
              if (!entry.raster?.ready) entry.bounds = null;
              refreshDenseZoom(...lastCamera);
            }
          })
        : undefined,
    rasterScale: 0,
    tree: quadtree(
      points,
      p => p.x,
      p => p.y
    ),
    radius: points.reduce((radius, p) => Math.max(radius, p.radius), 0),
    visible: new Map(),
    bounds: null,
    originalVisibility: image.style.visibility,
    originalStyle: image.getAttribute("style"),
    shown: false
  };
  return entry;
}
function inside(inner: Bounds, outer: Bounds): boolean {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}
function reconcile(entry: Entry, viewport: Bounds, scale: number): void {
  const paddingX = (viewport[2] - viewport[0]) * 0.2;
  const paddingY = (viewport[3] - viewport[1]) * 0.2;
  const bounds: Bounds = [
    viewport[0] - paddingX,
    viewport[1] - paddingY,
    viewport[2] + paddingX,
    viewport[3] + paddingY
  ];
  const [x0, y0, x1, y1] = bounds,
    radius = entry.radius;
  const visible: Glyph[] = [];
  entry.tree.visit((node, left, top, right, bottom) => {
    if (left - radius > x1 || right + radius < x0 || top - radius > y1 || bottom + radius < y0) return true;
    if (!node.length) {
      let leaf = node;
      do {
        const p = leaf.data;
        if (p.x + p.radius >= x0 && p.x - p.radius <= x1 && p.y + p.radius >= y0 && p.y - p.radius <= y1)
          visible.push(p);
        leaf = leaf.next!;
      } while (leaf);
    }
    return false;
  });
  visible.sort((a, b) => a.order - b.order);
  if (entry.raster?.paint(visible, bounds, scale)) {
    entry.visible.clear();
    entry.bounds = bounds;
    entry.rasterScale = scale;
    return;
  }
  if (entry.raster?.pending) {
    if (entry.visible.size) {
      entry.overlay.replaceChildren();
      entry.visible.clear();
    }
    entry.bounds = bounds;
    entry.rasterScale = scale;
    return;
  }
  entry.raster?.dispose();
  entry.raster = undefined;
  entry.rasterScale = scale;
  const wanted = new Set(visible.map(p => p.order));
  for (const [key, node] of entry.visible)
    if (!wanted.has(key)) {
      node.remove();
      entry.visible.delete(key);
    }
  let previous: SVGElement | null = null;
  for (const glyph of visible) {
    let node = entry.visible.get(glyph.order);
    if (!node) {
      const template = document.createElementNS(namespace, "g");
      template.innerHTML = glyph.markup;
      node = (template.firstElementChild as SVGElement | null) || undefined;
      if (!node) continue;
      entry.visible.set(glyph.order, node);
    }
    const next: ChildNode | null = previous ? previous.nextSibling : entry.overlay.firstChild;
    if (node !== next) entry.overlay.insertBefore(node, next);
    previous = node;
  }
  entry.bounds = bounds;
}
// Overview uses one bitmap. Deep zoom keeps a stable padded set of crisp glyph nodes.
// Interior pans require neither another spatial query nor a DOM reconciliation.
function refreshDenseZoom(k: number, x: number, y: number, width: number, height: number): void {
  lastCamera = [k, x, y, width, height];
  const images = mapImages();
  const live = new Set(images);
  for (const entry of active) if (!entry.image.isConnected || !live.has(entry.image)) release(entry);
  if (!Number.isFinite(k) || k <= 4) {
    for (const entry of active) show(entry, false);
    return;
  }
  const viewport: Bounds = [-x / k, -y / k, (width - x) / k, (height - y) / k];
  for (const image of images) {
    const changed = dirtyMetadata.has(image);
    dirtyMetadata.delete(image);
    if (changed) unavailable.delete(image);
    let entry = cache.get(image);
    if (entry && (changed || entry.overlay.parentElement !== image.parentElement)) {
      release(entry);
      entry = undefined;
    }
    if (!entry) {
      if (unavailable.has(image)) continue;
      entry = createEntry(image);
      if (!entry) {
        unavailable.add(image);
        continue;
      }
      cache.set(image, entry);
      active.add(entry);
      image.after(entry.overlay);
    }
    if (entry.raster?.failed) {
      entry.raster.dispose();
      entry.raster = undefined;
      entry.bounds = null;
    }
    if (entry.raster?.ready) entry.visible.clear();
    const oversized =
      entry.bounds &&
      (entry.bounds[2] - entry.bounds[0] > (viewport[2] - viewport[0]) * 2.5 ||
        entry.bounds[3] - entry.bounds[1] > (viewport[3] - viewport[1]) * 2.5);
    if (
      !entry.bounds ||
      oversized ||
      !inside(viewport, entry.bounds) ||
      (entry.raster?.ready && !entry.raster.covers(viewport)) ||
      (entry.raster && (k > entry.rasterScale * 1.2 || k < entry.rasterScale / 1.5))
    )
      reconcile(entry, viewport, k);
    show(entry, !entry.raster?.pending || entry.raster.ready);
  }
}
export function waitDenseZoomReady(timeoutMs = 15000): Promise<void> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (![...active].some(entry => entry.raster?.pending)) return resolve();
      if (performance.now() - started > timeoutMs) return reject(new Error("Dense viewport rendering timed out"));
      setTimeout(poll, 10);
    };
    poll();
  });
}
declare global {
  interface Window {
    refreshDenseZoom: typeof refreshDenseZoom;
    waitDenseZoomReady: typeof waitDenseZoomReady;
    readonly denseZoomPending: boolean;
  }
}
window.refreshDenseZoom = refreshDenseZoom;

window.waitDenseZoomReady = waitDenseZoomReady;
Object.defineProperty(window, "denseZoomPending", {
  configurable: true,
  get: () => [...active].some(entry => entry.raster?.pending)
});
