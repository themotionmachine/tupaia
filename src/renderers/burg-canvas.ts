import { quadtree } from "d3";

const namespace = "http://www.w3.org/2000/svg";
let editing = false;
let generation = 0;
let burgTree: ReturnType<typeof quadtree<{ i: number; x: number; y: number }>>;
let indexedBurgs: unknown;
let styleObserver: MutationObserver | undefined;
let observedGroups = new WeakSet<SVGGElement>();
let observedRoot: Element | null = null;
let refreshFrame = 0;
export function restoreBurgVectorsIn(root: ParentNode): void {
  for (const image of root.querySelectorAll<SVGImageElement>(
    "#burgIcons image[data-burg-vectors], #anchors image[data-burg-vectors]"
  )) {
    image.parentElement!.innerHTML = image.getAttribute("data-burg-vectors")!;
  }
}
function restoreBurgVectors(): void {
  generation++;
  restoreBurgVectorsIn(document);
}
function prepareBurgIcons(): void {
  editing = true;
  restoreBurgVectors();
}
async function rasterizeGroup(group: SVGGElement, revision: number): Promise<void> {
  const uses = [...group.querySelectorAll<SVGUseElement>("use")];
  uses.forEach(use => {
    use.classList.remove("viewport-culled");
  });
  const markup = group.innerHTML;
  if (!uses.length) return;
  const computed = getComputedStyle(group);
  const padding = parseFloat(computed.fontSize) * 4 + parseFloat(computed.strokeWidth) * 4 + 20;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const ids = new Set<string>();
  for (const use of uses) {
    const x = Number(use.getAttribute("x")),
      y = Number(use.getAttribute("y"));
    x0 = Math.min(x0, x - padding);
    y0 = Math.min(y0, y - padding);
    x1 = Math.max(x1, x + padding);
    y1 = Math.max(y1, y + padding);
    const href = use.getAttribute("href") || use.getAttribute("xlink:href");
    if (href) ids.add(href);
  }
  const width = x1 - x0,
    height = y1 - y0;
  const definitions = [...ids].map(id => document.querySelector(id)?.outerHTML || "").join("");
  const style = [
    "fill",
    "fill-opacity",
    "stroke",
    "stroke-opacity",
    "stroke-width",
    "stroke-linejoin",
    "stroke-linecap",
    "font-size"
  ]
    .map(name => `${name}:${computed.getPropertyValue(name)}`)
    .join(";");
  const source = `<svg xmlns="${namespace}" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="${x0} ${y0} ${width} ${height}" style="${style}"><defs>${definitions}</defs>${markup}</svg>`;
  const image = document.createElementNS(namespace, "image");
  image.setAttribute("x", String(x0));
  image.setAttribute("y", String(y0));
  image.setAttribute("width", String(width));
  image.setAttribute("height", String(height));
  image.setAttribute("pointer-events", "none");
  image.setAttribute("data-burg-vectors", markup);
  image.setAttribute("href", `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`);
  group.replaceChildren(image);
  const bitmap = new Image();
  bitmap.src = image.getAttribute("href")!;
  try {
    await bitmap.decode();
    if (revision !== generation || image.parentNode !== group) return;
    const canvas = document.createElement("canvas");
    const resolution = Math.min(window.devicePixelRatio || 1, 2, 4096 / Math.max(width, height));
    canvas.width = Math.max(1, Math.ceil(width * resolution));
    canvas.height = Math.max(1, Math.ceil(height * resolution));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    image.setAttribute("href", canvas.toDataURL());
    canvas.width = canvas.height = 0;
  } catch (error) {
    console.warn("Settlement raster unavailable; retaining embedded vectors", error);
  }
}
function compactBurgIcons(): void {
  if (editing) return;
  const currentRoot = document.getElementById("burgIcons");
  if (currentRoot !== observedRoot) {
    styleObserver?.disconnect();
    observedGroups = new WeakSet();
    observedRoot = currentRoot;
  }
  restoreBurgVectors();
  const revision = generation;
  const groups = document.querySelectorAll<SVGGElement>("#burgIcons > g, #anchors > g");
  styleObserver ??= new MutationObserver(() => {
    if (editing || refreshFrame) return;
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = 0;
      restoreBurgVectors();
      for (const group of document.querySelectorAll<SVGGElement>("#burgIcons > g")) {
        const icon = group.dataset.icon;
        if (icon)
          group.querySelectorAll("use").forEach(use => {
            use.setAttribute("href", icon);
          });
      }
      compactBurgIcons();
    });
  });
  for (const group of groups) {
    if (observedGroups.has(group)) continue;
    observedGroups.add(group);
    styleObserver.observe(group, {
      attributes: true,
      attributeFilter: [
        "fill",
        "fill-opacity",
        "stroke",
        "stroke-opacity",
        "stroke-width",
        "font-size",
        "style",
        "data-icon"
      ]
    });
  }
  window.burgRenderReady = Promise.all([...groups].map(group => rasterizeGroup(group, revision))).then(() => {});
}
function finishBurgIcons(): void {
  invalidateBurgIndex();
  editing = false;
  compactBurgIcons();
}
function pickBurg(x: number, y: number): number | undefined {
  if (!document.querySelector("#burgIcons image[data-burg-vectors]") || !layerIsOn("toggleBurgIcons")) return;
  if (indexedBurgs !== pack.burgs) {
    burgTree = quadtree(
      pack.burgs.filter(b => b?.i && !b.removed).map(b => ({ i: b.i!, x: b.x, y: b.y })),
      b => b.x,
      b => b.y
    );
    indexedBurgs = pack.burgs;
  }
  const nearest = burgTree.find(x, y, 20);
  if (!nearest) return;
  const burg = pack.burgs[nearest.i];
  const group = document.querySelector<SVGGElement>(`#burgIcons > g#${burg.group}`);
  const radius = group ? parseFloat(getComputedStyle(group).fontSize) : 3;
  if (Math.hypot(x - nearest.x, y - nearest.y) <= radius) return nearest.i;
}
function invalidateBurgIndex(): void {
  indexedBurgs = undefined;
}
declare global {
  interface Window {
    prepareBurgIcons: typeof prepareBurgIcons;
    finishBurgIcons: typeof finishBurgIcons;
    compactBurgIcons: typeof compactBurgIcons;
    pickBurg: typeof pickBurg;
    burgRenderReady?: Promise<void>;
  }
}

export { compactBurgIcons, invalidateBurgIndex, restoreBurgVectors };

window.prepareBurgIcons = prepareBurgIcons;
window.finishBurgIcons = finishBurgIcons;
window.compactBurgIcons = compactBurgIcons;
window.pickBurg = pickBurg;
