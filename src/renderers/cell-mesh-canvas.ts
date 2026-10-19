let observed: Element | null = null;
let observer: MutationObserver;
let frame = 0;
// Last raster with the exact inputs it was drawn from: editors (route, coastline...) toggle the mesh on every open, and
// redrawing 100k cells is a multi-second stroke + encode for the same pixels.
let cached: { key: string; href: string } | null = null;
const scratch = new Float64Array(1);
const words = new Uint32Array(scratch.buffer);

// Exact geometry key: every vertex index and every coordinate bit, so a reused raster is never stale.
export function meshKey(cells: { i: ArrayLike<number>; v: number[][] }, points: number[][]): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  const mix = (value: number) => {
    a = Math.imul(a ^ value, 16777619);
    b = Math.imul(b ^ value, 2246822519) ^ (a >>> 15);
  };
  for (let n = 0; n < cells.i.length; n++) {
    const vertices = cells.v[cells.i[n]];
    mix(vertices.length);
    for (const vertex of vertices) {
      const point = points[vertex];
      scratch[0] = point[0];
      mix(words[0]);
      mix(words[1]);
      scratch[0] = point[1];
      mix(words[0]);
      mix(words[1]);
    }
  }
  return `${cells.i.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
}

function measure(name: string, start: number): number {
  const end = performance.now();
  performance.measure(`cells-mesh:${name}`, { start, end });
  return end;
}

// Cell mesh is one canvas path, with no per-cell nodes or multi-megabyte SVG path string.
function drawCellsCanvas(): void {
  const group = document.getElementById("cells");
  if (!group) return;
  let t = performance.now();
  const graph = customization === 1 ? grid : pack;
  const style = getComputedStyle(group);
  const resolution = Math.min(window.devicePixelRatio || 1, 2, 4096 / Math.max(graphWidth, graphHeight));
  const strokeWidth = parseFloat(style.strokeWidth);
  const strokeOpacity = parseFloat(style.strokeOpacity);
  const key = [
    meshKey(graph.cells, graph.vertices.p),
    graphWidth,
    graphHeight,
    resolution,
    style.stroke,
    style.strokeWidth,
    style.strokeOpacity
  ].join("|");
  t = measure("key", t);
  if (cached?.key !== key) {
    const href = rasterize(graph, style, resolution, strokeWidth, strokeOpacity, t);
    if (href === null) return;
    cached = { key, href };
  }
  attach(group, cached.href);
}

interface MeshGraph {
  cells: { i: ArrayLike<number>; v: number[][] };
  vertices: { p: number[][] };
}

function rasterize(
  graph: MeshGraph,
  style: CSSStyleDeclaration,
  resolution: number,
  strokeWidth: number,
  strokeOpacity: number,
  t: number
): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(graphWidth * resolution));
  canvas.height = Math.max(1, Math.ceil(graphHeight * resolution));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.scale(resolution, resolution);
  context.strokeStyle = style.stroke;
  context.lineWidth = Number.isFinite(strokeWidth) && strokeWidth > 0 ? strokeWidth : 1;
  context.globalAlpha = Number.isFinite(strokeOpacity) ? strokeOpacity : 1;
  // One path string parsed natively: ~800k moveTo/lineTo calls on the context took >10 s at 100k cells. Same
  // subpaths in the same order and a single stroke, so overlapping edges blend exactly as before.
  let d = "";
  for (let n = 0; n < graph.cells.i.length; n++) {
    const vertices = graph.cells.v[graph.cells.i[n]];
    if (!vertices.length) continue;
    const start = graph.vertices.p[vertices[0]];
    d += `M${start[0]} ${start[1]}`;
    for (let i = 1; i < vertices.length; i++) {
      const point = graph.vertices.p[vertices[i]];
      d += `L${point[0]} ${point[1]}`;
    }
    d += "Z";
  }
  const path = new Path2D(d);
  t = measure("path", t);
  if (style.stroke !== "none" && strokeWidth !== 0) context.stroke(path);
  t = measure("stroke", t);
  const href = canvas.toDataURL();
  measure("encode", t);
  canvas.width = canvas.height = 0;
  return href;
}

function attach(group: HTMLElement, href: string): void {
  const image = document.createElementNS("http://www.w3.org/2000/svg", "image");
  image.setAttribute("width", String(graphWidth));
  image.setAttribute("height", String(graphHeight));
  image.setAttribute("href", href);
  image.setAttribute("pointer-events", "none");
  image.setAttribute("data-cell-mesh", "1");
  group.replaceChildren(image);
  if (observed !== group) {
    observer?.disconnect();
    observed = group;
    observer = new MutationObserver(() => {
      if (frame || !group.querySelector("image[data-cell-mesh]")) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (group.isConnected && layerIsOn("toggleCells")) drawCellsCanvas();
      });
    });
    observer.observe(group, {
      attributes: true,
      attributeFilter: ["stroke", "stroke-width", "stroke-opacity", "style"]
    });
  }
}
declare global {
  interface Window {
    drawCellsCanvas: typeof drawCellsCanvas;
  }
}
window.drawCellsCanvas = drawCellsCanvas;
