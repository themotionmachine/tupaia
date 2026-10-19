import { getPackPolygon } from "../utils/graphUtils";
export interface CellPaintOverlay {
  paint: (changes: Map<number, number>, selection: Iterable<number>) => void;
  reset: (changes: Map<number, number>) => void;
}
export function createCellPaintOverlay(group: Element, colors: (entity: number) => string): CellPaintOverlay {
  const host = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
  host.setAttribute("width", String(graphWidth));
  host.setAttribute("height", String(graphHeight));
  host.setAttribute("pointer-events", "none");
  const canvas = document.createElement("canvas");
  const resolution = Math.min(window.devicePixelRatio || 1, 2, 4096 / Math.max(graphWidth, graphHeight));
  canvas.width = Math.max(1, Math.ceil(graphWidth * resolution));
  canvas.height = Math.max(1, Math.ceil(graphHeight * resolution));
  canvas.style.width = `${graphWidth}px`;
  canvas.style.height = `${graphHeight}px`;
  host.appendChild(canvas);
  group.replaceChildren(host);
  const context = canvas.getContext("2d")!;
  context.scale(resolution, resolution);
  function paint(changes: Map<number, number>, selection: Iterable<number>): void {
    for (const cell of selection) {
      const entity = changes.get(cell);
      if (entity === undefined) continue;
      const polygon = getPackPolygon(cell, pack);
      if (!polygon.length) continue;
      context.beginPath();
      context.moveTo(polygon[0][0], polygon[0][1]);
      for (let i = 1; i < polygon.length; i++) context.lineTo(polygon[i][0], polygon[i][1]);
      context.closePath();
      context.fillStyle = context.strokeStyle = colors(entity);
      context.fill();
      context.stroke();
    }
  }
  return {
    paint,
    reset(changes) {
      context.clearRect(0, 0, graphWidth, graphHeight);
      paint(changes, changes.keys());
    }
  };
}
