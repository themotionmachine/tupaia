let observed: Element | null = null;
let observer: MutationObserver;
let frame = 0;
// Cell mesh is one canvas path, with no per-cell nodes or multi-megabyte SVG path string.
function drawCellsCanvas(): void {
  const group = document.getElementById("cells");
  if (!group) return;
  const graph = customization === 1 ? grid : pack;
  const style = getComputedStyle(group);
  const canvas = document.createElement("canvas");
  const resolution = Math.min(window.devicePixelRatio || 1, 2, 4096 / Math.max(graphWidth, graphHeight));
  canvas.width = Math.max(1, Math.ceil(graphWidth * resolution));
  canvas.height = Math.max(1, Math.ceil(graphHeight * resolution));
  const context = canvas.getContext("2d");
  if (!context) return;
  context.scale(resolution, resolution);
  context.strokeStyle = style.stroke;
  const strokeWidth = parseFloat(style.strokeWidth);
  context.lineWidth = Number.isFinite(strokeWidth) && strokeWidth > 0 ? strokeWidth : 1;
  const strokeOpacity = parseFloat(style.strokeOpacity);
  context.globalAlpha = Number.isFinite(strokeOpacity) ? strokeOpacity : 1;
  context.beginPath();
  for (const cell of graph.cells.i) {
    const vertices = graph.cells.v[cell];
    if (!vertices.length) continue;
    const start = graph.vertices.p[vertices[0]];
    context.moveTo(start[0], start[1]);
    for (let i = 1; i < vertices.length; i++) {
      const point = graph.vertices.p[vertices[i]];
      context.lineTo(point[0], point[1]);
    }
    context.closePath();
  }
  if (style.stroke !== "none" && strokeWidth !== 0) context.stroke();
  const image = document.createElementNS("http://www.w3.org/2000/svg", "image");
  image.setAttribute("width", String(graphWidth));
  image.setAttribute("height", String(graphHeight));
  image.setAttribute("href", canvas.toDataURL());
  image.setAttribute("pointer-events", "none");
  image.setAttribute("data-cell-mesh", "1");
  group.replaceChildren(image);
  canvas.width = canvas.height = 0;
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
