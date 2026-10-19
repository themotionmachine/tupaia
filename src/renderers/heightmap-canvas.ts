import { quadtree } from "d3";

type Bounds = [number, number, number, number];
export function intersects(a: Bounds, b: Bounds): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
let canvas: HTMLCanvasElement;
let context: CanvasRenderingContext2D;
let geometry: number[][][];
let bounds: Bounds[];
let index: ReturnType<typeof quadtree<number>>;
let radius = 0;
let ocean = true;
let palette: (height: number) => string;
let frame = 0;
const dirty = new Set<number>();
function paint(i: number): void {
  const height = grid.cells.h[i];
  if (!ocean && height < 20) return;
  const polygon = geometry[i];
  if (!polygon.length) return;
  context.beginPath();
  context.moveTo(polygon[0][0], polygon[0][1]);
  for (let j = 1; j < polygon.length; j++) context.lineTo(polygon[j][0], polygon[j][1]);
  context.closePath();
  context.fillStyle = palette(height);
  context.fill();
}
function renderHeightmapCanvas(renderOcean: boolean, color: (height: number) => string): void {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  dirty.clear();
  ocean = renderOcean;
  palette = color;
  const group = document.getElementById("heights");
  if (!group) return;
  const host = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
  host.setAttribute("width", String(graphWidth));
  host.setAttribute("height", String(graphHeight));
  host.setAttribute("pointer-events", "none");
  canvas = document.createElement("canvas");
  const resolution = Math.min(2, 4096 / Math.max(graphWidth, graphHeight));
  canvas.width = Math.max(1, Math.ceil(graphWidth * resolution));
  canvas.height = Math.max(1, Math.ceil(graphHeight * resolution));
  canvas.style.width = `${graphWidth}px`;
  canvas.style.height = `${graphHeight}px`;
  host.appendChild(canvas);
  group.replaceChildren(host);
  context = canvas.getContext("2d")!;
  context.scale(resolution, resolution);
  geometry = Array.from(grid.cells.i as number[], i => getGridPolygon(i));
  bounds = geometry.map(polygon => {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const [x, y] of polygon) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    return [x0, y0, x1, y1];
  });
  radius = 0;
  for (const i of grid.cells.i) {
    const [x, y] = grid.points[i];
    const b = bounds[i];
    radius = Math.max(radius, x - b[0], b[2] - x, y - b[1], b[3] - y);
    paint(i);
  }
  index = quadtree(
    Array.from(grid.cells.i),
    i => grid.points[i][0],
    i => grid.points[i][1]
  );
}
function redrawHeightmapCells(selection: Iterable<number>): void {
  if (!canvas?.isConnected) return;
  for (const cell of selection) dirty.add(cell);
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (!canvas.isConnected) {
      dirty.clear();
      return;
    }
    const area: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (const cell of dirty) {
      const b = bounds[cell];
      area[0] = Math.min(area[0], b[0] - 1);
      area[1] = Math.min(area[1], b[1] - 1);
      area[2] = Math.max(area[2], b[2] + 1);
      area[3] = Math.max(area[3], b[3] + 1);
    }
    dirty.clear();
    context.save();
    context.beginPath();
    context.rect(area[0], area[1], area[2] - area[0], area[3] - area[1]);
    context.clip();
    context.clearRect(area[0], area[1], area[2] - area[0], area[3] - area[1]);
    const candidates: number[] = [];
    index.visit((node, x0, y0, x1, y1) => {
      if (!intersects([x0 - radius, y0 - radius, x1 + radius, y1 + radius], area)) return true;
      if (!node.length) {
        let leaf = node;
        do {
          if (intersects(bounds[leaf.data], area)) candidates.push(leaf.data);
          leaf = leaf.next!;
        } while (leaf);
      }
      return false;
    });
    candidates.sort((a, b) => a - b).forEach(paint);
    context.restore();
  });
}
declare global {
  var getGridPolygon: (i: number) => [number, number][];
  interface Window {
    renderHeightmapCanvas: typeof renderHeightmapCanvas;
    redrawHeightmapCells: typeof redrawHeightmapCells;
  }
}
window.renderHeightmapCanvas = renderHeightmapCanvas;
window.redrawHeightmapCells = redrawHeightmapCells;
