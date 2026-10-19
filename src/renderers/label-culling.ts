import { quadtree } from "d3";

interface LabelPoint {
  x: number;
  y: number;
  element: SVGElement;
  halfWidth: number;
  halfHeight: number;
}
let root: Element | null = null;
let dirty = true;
let visible = new Set<SVGElement>();
let index = quadtree<LabelPoint>()
  .x(d => d.x)
  .y(d => d.y);
let observer: MutationObserver;
let extent = 200;
let refreshFrame = 0;
const zoomFonts = new WeakMap<Element, string>();
function noteZoomLabelSize(element: Element, value: number): void {
  zoomFonts.set(element, String(value));
}
let lastViewport: [number, number, number, number, number] | null = null;
function transientZoomNode(node: Node): boolean {
  const element = node as Element;
  const selector = "[data-dense-zoom], [data-zone-hatch-clone]";
  return Boolean(
    element.hasAttribute?.("data-dense-zoom") ||
      element.hasAttribute?.("data-zone-hatch-clone") ||
      element.closest?.(selector) ||
      node.parentElement?.closest?.(selector)
  );
}

function rebuild(): void {
  const points: LabelPoint[] = [];
  visible.clear();
  extent = 200;
  const view = document.getElementById("viewbox") as unknown as SVGGraphicsElement;
  const elements = [...document.querySelectorAll<SVGElement>("#labels text, #burgIcons use, #anchors use")].filter(
    element => !element.closest?.("[data-dense-zoom]")
  );
  // display:none labels must be exposed together before any bounds read; final culling runs before paint.
  for (const element of elements) element.classList.remove("viewport-culled");
  const inverse = view?.getCTM?.()?.inverse();
  for (const element of elements) {
    let x = Number(element.getAttribute("x"));
    let y = Number(element.getAttribute("y"));
    let halfWidth = 200,
      halfHeight = 30;
    const graphics = element as SVGGraphicsElement;
    if (graphics.getBBox) {
      try {
        const box = graphics.getBBox();
        x = box.x + box.width / 2;
        y = box.y + box.height / 2;
        const font = typeof getComputedStyle === "function" ? parseFloat(getComputedStyle(element).fontSize) : 0;
        const desired = Number(element.parentElement?.getAttribute("data-size"));
        const fontMargin = font > 0 && desired > font ? desired / font : 1;
        halfWidth = (box.width * fontMargin) / 2 + 20;
        halfHeight = (box.height * fontMargin) / 2 + 20;
        const matrix = graphics.getCTM();
        if (inverse && matrix) {
          const relative = inverse.multiply(matrix);
          const px = relative.a * x + relative.c * y + relative.e;
          const py = relative.b * x + relative.d * y + relative.f;
          const width = Math.abs(relative.a) * halfWidth + Math.abs(relative.c) * halfHeight;
          halfHeight = Math.abs(relative.b) * halfWidth + Math.abs(relative.d) * halfHeight;
          halfWidth = width;
          x = px;
          y = py;
        }
      } catch {
        /* A hidden SVG layer may have no measurable box yet. */
      }
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push({ x, y, element, halfWidth, halfHeight });
    extent = Math.max(extent, halfWidth, halfHeight);
    visible.add(element);
  }
  index = quadtree(
    points,
    d => d.x,
    d => d.y
  );
  dirty = false;
}
function cullMapLabels(k: number, x: number, y: number, width: number, height: number): void {
  lastViewport = [k, x, y, width, height];
  const nextRoot = document.getElementById("viewbox");
  if (!nextRoot) return;
  if (nextRoot !== root) {
    observer?.disconnect();
    root = nextRoot;
    dirty = true;
    let css: Element | null = document.getElementById("map-label-culling-style");
    if (!css) {
      css = document.createElementNS("http://www.w3.org/2000/svg", "style");
      css.id = "map-label-culling-style";
      document.getElementById("map")?.appendChild(css);
    }
    css.textContent = ".viewport-culled{display:none!important;pointer-events:none!important}";
    observer = new MutationObserver(records => {
      const changed = records.some(record => {
        const element = record.target as Element;
        if (transientZoomNode(record.target)) return false;
        if (element.tagName === "image" && record.type === "attributes") return false;
        if (record.type === "childList") {
          const nodes = [...record.addedNodes, ...record.removedNodes];
          if (nodes.length && nodes.every(transientZoomNode)) return false;
        }
        if (record.attributeName === "font-size" && zoomFonts.get(element) === element.getAttribute("font-size"))
          return false;
        if (record.attributeName === "class") {
          const clean = (value: string | null) =>
            (value || "")
              .split(/\s+/)
              .filter(name => name !== "viewport-culled")
              .sort()
              .join(" ");
          return clean(record.oldValue) !== clean(element.getAttribute("class"));
        }
        return true;
      });
      if (!changed) return;
      dirty = true;
      if (lastViewport && !refreshFrame)
        refreshFrame = requestAnimationFrame(() => {
          refreshFrame = 0;
          if (dirty && lastViewport) cullMapLabels(...lastViewport);
        });
    });
    for (const id of ["labels", "burgIcons", "anchors", "defs"]) {
      const layer = id === "defs" ? document.querySelector?.("#map > defs") : document.getElementById(id);
      if (layer)
        observer.observe(layer, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeOldValue: true,
          characterData: true,
          attributeFilter: [
            "x",
            "y",
            "dx",
            "dy",
            "d",
            "href",
            "transform",
            "font-size",
            "font-family",
            "font-weight",
            "style",
            "class",
            "data-size"
          ]
        });
    }
  }
  if (dirty) rebuild();
  // Padding covers long settlement names and glyphs beyond their anchor point.
  const padding = 20;
  const x0 = -x / k - padding,
    y0 = -y / k - padding;
  const x1 = (width - x) / k + padding,
    y1 = (height - y) / k + padding;
  const next = new Set<SVGElement>();
  index.visit((node, left, top, right, bottom) => {
    if (left - extent > x1 || top - extent > y1 || right + extent < x0 || bottom + extent < y0) return true;
    if (!node.length) {
      let leaf = node;
      do {
        const { x: px, y: py, element, halfWidth, halfHeight } = leaf.data;
        if (px + halfWidth >= x0 && px - halfWidth <= x1 && py + halfHeight >= y0 && py - halfHeight <= y1)
          next.add(element);
        leaf = leaf.next!;
      } while (leaf);
    }
    return false;
  });
  for (const element of visible) if (!next.has(element)) element.classList.add("viewport-culled");
  for (const element of next) if (!visible.has(element)) element.classList.remove("viewport-culled");
  visible = next;
}
declare global {
  interface Window {
    cullMapLabels: typeof cullMapLabels;
    noteZoomLabelSize: typeof noteZoomLabelSize;
  }
}
window.cullMapLabels = cullMapLabels;

window.noteZoomLabelSize = noteZoomLabelSize;
