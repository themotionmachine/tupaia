const editing = new Set<string>();
let observed = new WeakSet<Element>();
let observedRoot: Element | null = null;
let refreshFrame = 0;
const pending = new Set<string>();
let styleObserver: MutationObserver | undefined;
function observer(): MutationObserver {
  if (styleObserver) return styleObserver;
  styleObserver = new MutationObserver(records => {
    for (const record of records) {
      const ancestor = record.target as Element;
      for (const image of ancestor.querySelectorAll<SVGImageElement>("image[data-path-vectors]"))
        if (image.parentElement?.id) pending.add(image.parentElement.id);
    }
    if (!pending.size || refreshFrame) return;
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = 0;
      const ids = [...pending];
      pending.clear();
      for (const id of ids) {
        const group = document.getElementById(id);
        if (group) restorePathVectorsIn(group);
        compactPathLayer(id);
      }
    });
  });
  return styleObserver;
}
export function restorePathVectorsIn(root: ParentNode): void {
  for (const image of root.querySelectorAll<SVGImageElement>("image[data-path-vectors]")) {
    image.parentElement!.innerHTML = image.getAttribute("data-path-vectors")!;
  }
}
function preparePathLayer(id: string): void {
  editing.add(id);
  const group = document.getElementById(id);
  if (group) restorePathVectorsIn(group);
}
function finishPathLayer(id: string): void {
  editing.delete(id);
  compactPathLayer(id);
}
// Rasterize aggregated geometry once: the SVG still owns layer order, masks and filters.
export function compactPathLayer(id: string): void {
  if (editing.has(id) || typeof Path2D === "undefined") return;
  const group = document.getElementById(id);
  if (!group) return;
  const mapRoot = document.getElementById("map");
  if (observedRoot !== mapRoot) {
    styleObserver?.disconnect();
    observed = new WeakSet();
    observedRoot = mapRoot;
    pending.clear();
  }
  for (let ancestor: Element | null = group; ancestor; ancestor = ancestor.parentElement) {
    if (observed.has(ancestor)) continue;
    observed.add(ancestor);
    observer().observe(ancestor, {
      attributes: true,
      attributeFilter: ["style", "class", "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "opacity"]
    });
  }
  const elements = [...group.querySelectorAll<SVGGraphicsElement>(":scope > path, :scope > rect")];
  if (!elements.length || elements.length !== group.children.length) return;
  const styles = elements.map(element => getComputedStyle(element));
  // Custom pattern fills stay vector until their pattern can be rasterized faithfully.
  if (
    styles.some(
      style =>
        style.fill.startsWith("url(") ||
        style.stroke.startsWith("url(") ||
        (style.filter && style.filter !== "none") ||
        (style.clipPath && style.clipPath !== "none") ||
        (style.mask && style.mask !== "none") ||
        style.vectorEffect === "non-scaling-stroke"
    )
  )
    return;
  const markup = group.innerHTML;
  const canvas = document.createElement("canvas");
  const resolution = Math.min(window.devicePixelRatio || 1, 2, 4096 / Math.max(graphWidth, graphHeight));
  canvas.width = Math.max(1, Math.ceil(graphWidth * resolution));
  canvas.height = Math.max(1, Math.ceil(graphHeight * resolution));
  const context = canvas.getContext("2d");
  if (!context) return;
  context.scale(resolution, resolution);
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index],
      style = styles[index];
    const path = new Path2D(element.getAttribute("d") || "");
    if (element.tagName === "rect")
      path.rect(
        Number(element.getAttribute("x")),
        Number(element.getAttribute("y")),
        Number(element.getAttribute("width")),
        Number(element.getAttribute("height"))
      );
    context.save();
    const transform = element.transform?.baseVal.consolidate()?.matrix;
    if (transform) context.transform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
    const opacity = Number(style.opacity || 1);
    if (style.fill !== "none") {
      context.globalAlpha = opacity * Number(style.fillOpacity || 1);
      context.fillStyle = style.fill;
      context.fill(path, style.fillRule === "evenodd" ? "evenodd" : "nonzero");
    }
    if (style.stroke !== "none" && parseFloat(style.strokeWidth) > 0) {
      context.globalAlpha = opacity * Number(style.strokeOpacity || 1);
      context.strokeStyle = style.stroke;
      context.lineWidth = parseFloat(style.strokeWidth);
      context.lineJoin = style.strokeLinejoin as CanvasLineJoin;
      context.lineCap = style.strokeLinecap as CanvasLineCap;
      if (style.strokeDasharray !== "none")
        context.setLineDash(style.strokeDasharray.split(/[ ,]+/).map(value => parseFloat(value)));
      context.lineDashOffset = parseFloat(style.strokeDashoffset) || 0;
      context.stroke(path);
    }
    context.restore();
  }
  const image = document.createElementNS("http://www.w3.org/2000/svg", "image");
  image.setAttribute("width", String(graphWidth));
  image.setAttribute("height", String(graphHeight));
  image.setAttribute("pointer-events", "none");
  image.setAttribute("data-path-vectors", markup);
  image.setAttribute("href", canvas.toDataURL());
  group.replaceChildren(image);
  canvas.width = canvas.height = 0;
}
declare global {
  interface Window {
    compactPathLayer: typeof compactPathLayer;
    preparePathLayer: typeof preparePathLayer;
    finishPathLayer: typeof finishPathLayer;
  }
}
window.compactPathLayer = compactPathLayer;
window.preparePathLayer = preparePathLayer;
window.finishPathLayer = finishPathLayer;
