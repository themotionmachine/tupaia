import { quadtree } from "d3";
export interface ReliefSprite {
  i: string;
  x: number;
  y: number;
  s: number;
}
const namespace = "http://www.w3.org/2000/svg";
const sprites = new Map<string, Promise<HTMLImageElement>>();
const decodedSprites = new Map<string, HTMLImageElement>();
const sourceSignatures = new Map<string, string>();
export function loadReliefSprite(id: string): Promise<HTMLImageElement> {
  return sprite(id);
}
export function peekReliefSprite(id: string): HTMLImageElement | undefined {
  return decodedSprites.get(id);
}
const rasterSprites = new Map<string, HTMLCanvasElement>();
export function peekReliefRasterSprite(id: string): HTMLCanvasElement | undefined {
  const symbol = document.querySelector(id);
  if (
    !symbol ||
    symbol.outerHTML !== sourceSignatures.get(id) ||
    [...symbol.attributes].some(attribute => !["id", "viewBox"].includes(attribute.name)) ||
    symbol.querySelector("use,[class],[filter],[mask],[clip-path]")
  )
    return;
  const cached = rasterSprites.get(id);
  if (cached) {
    rasterSprites.delete(id);
    rasterSprites.set(id, cached);
    return cached;
  }
  const source = decodedSprites.get(id);
  if (!source) return;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 512;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.drawImage(source, 0, 0, 512, 512);
  rasterSprites.set(id, canvas);
  if (rasterSprites.size > 48) rasterSprites.delete(rasterSprites.keys().next().value!);
  return canvas;
}
let revision = 0;
let indexedRaster: Element | null = null;
let icons: ReliefSprite[] = [];
let tree = quadtree<ReliefSprite>()
  .x(d => d.x + d.s / 2)
  .y(d => d.y + d.s / 2);
let maxSize = 0;
function sprite(id: string): Promise<HTMLImageElement> {
  const cached = sprites.get(id);
  if (cached) return cached;
  const symbol = document.querySelector(id);
  if (symbol) sourceSignatures.set(id, symbol.outerHTML);
  const result = new Promise<HTMLImageElement>((resolve, reject) => {
    if (!symbol) return reject(new Error(`Missing relief symbol ${id}`));
    const source = `<svg xmlns="${namespace}" viewBox="${symbol.getAttribute("viewBox") || "0 0 100 100"}">${symbol.innerHTML}</svg>`;
    const url = URL.createObjectURL(new Blob([source], { type: "image/svg+xml" }));
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      decodedSprites.set(id, image);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Cannot decode relief symbol ${id}`));
    };
    image.src = url;
  });
  sprites.set(id, result);
  return result;
}
function vectors(data: ReliefSprite[]): string {
  return data.map(r => `<use href="${r.i}" x="${r.x}" y="${r.y}" width="${r.s}" height="${r.s}"/>`).join("");
}
// Embedded raster removes per-glyph DOM; exact placements remain editable and serializable.
export async function renderReliefCanvas(data: ReliefSprite[]): Promise<void> {
  const group = document.getElementById("terrain");
  if (!group) return;
  const current = ++revision;
  const image = document.createElementNS(namespace, "image");
  image.setAttribute("width", String(graphWidth));
  image.setAttribute("height", String(graphHeight));
  image.setAttribute("data-relief", JSON.stringify(data));
  image.setAttribute("data-relief-count", String(data.length));
  image.setAttribute("pointer-events", "none");
  group.replaceChildren(image);
  const canvas = document.createElement("canvas");
  const resolution = Math.min(window.devicePixelRatio || 1, 2, 4096 / Math.max(graphWidth, graphHeight));
  canvas.width = Math.max(1, Math.ceil(graphWidth * resolution));
  canvas.height = Math.max(1, Math.ceil(graphHeight * resolution));
  const context = canvas.getContext("2d");
  if (!context) {
    materializeRelief(group);
    return;
  }
  context.scale(resolution, resolution);
  const ids = [...new Set(data.map(icon => icon.i))];
  try {
    const decoded = await Promise.all(ids.map(sprite));
    if (current !== revision || document.getElementById("terrain") !== group || image.parentElement !== group) return;
    const atlas = new Map(ids.map((id, index) => [id, decoded[index]]));
    for (const icon of data) context.drawImage(atlas.get(icon.i)!, icon.x, icon.y, icon.s, icon.s);
    image.setAttribute("href", canvas.toDataURL());
  } catch (error) {
    if (current !== revision) return;
    console.warn("Relief raster failed; retaining vector glyphs", error);
    materializeRelief(group);
  } finally {
    canvas.width = canvas.height = 0;
  }
}
function reliefData(value: string | null): ReliefSprite[] | undefined {
  try {
    const data: unknown = JSON.parse(value || "");
    if (
      !Array.isArray(data) ||
      !data.every(
        icon =>
          icon &&
          typeof icon.i === "string" &&
          typeof icon.x === "number" &&
          typeof icon.y === "number" &&
          typeof icon.s === "number" &&
          Number.isFinite(icon.x) &&
          Number.isFinite(icon.y) &&
          Number.isFinite(icon.s) &&
          icon.s > 0
      )
    )
      return;
    return data as ReliefSprite[];
  } catch {
    return;
  }
}
// Synchronous snapshots can run before asynchronous sprite decode finishes. Only those
// snapshots need a self-contained vector image fallback; ordinary redraws avoid building it.
export function materializeRelief(root: ParentNode): void {
  for (const image of root.querySelectorAll<SVGImageElement>("image[data-relief]:not([href])")) {
    const data = reliefData(image.getAttribute("data-relief"));
    if (!data) continue;
    const symbols = [...new Set(data.map(icon => icon.i))]
      .map(id => document.querySelector(id)?.outerHTML || "")
      .join("");
    const source = `<svg xmlns="${namespace}" width="${image.getAttribute("width")}" height="${image.getAttribute("height")}"><defs>${symbols}</defs>${vectors(data)}</svg>`;
    image.setAttribute("href", `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`);
  }
}
export interface ReliefSerialization {
  marker: string;
  markup: string;
}
let snapshotSerial = 0;
function xmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;")
    .replace(/\t/g, "&#9;");
}
// Serialize canonical glyphs as strings after XMLSerializer; no per-glyph clone DOM and
// no duplicate PNG/placement payload in project files. Custom vector glyphs remain untouched.
export function prepareReliefSerialization(root: ParentNode): ReliefSerialization[] {
  const replacements: ReliefSerialization[] = [];
  for (const image of root.querySelectorAll<SVGImageElement>("#terrain > image[data-relief]")) {
    const allowed = new Set(["width", "height", "data-relief", "data-relief-count", "pointer-events", "href"]);
    if (
      Array.from(image.attributes).some(
        attribute => !allowed.has(attribute.name) && !(attribute.name === "style" && !attribute.value.trim())
      )
    )
      continue;
    const data = reliefData(image.getAttribute("data-relief"));
    if (!data) continue;
    const declaration =
      image.parentElement?.lookupNamespaceURI(null) === namespace ? "" : ' xmlns="http://www.w3.org/2000/svg"';
    const markup = data
      .map(
        icon =>
          `<use${declaration} href="${xmlAttribute(icon.i)}" x="${icon.x}" y="${icon.y}" width="${icon.s}" height="${icon.s}"/>`
      )
      .join("");
    const name = `tupaia-relief-snapshot-${++snapshotSerial}`;
    image.replaceWith(document.createComment(name));
    replacements.push({ marker: `<!--${name}-->`, markup });
  }
  return replacements;
}
export function getReliefIcons(): ReliefSprite[] {
  const raster = document.querySelector("#terrain > image[data-relief]");
  if (raster) return JSON.parse(raster.getAttribute("data-relief")!) as ReliefSprite[];
  return Array.from(document.querySelectorAll<SVGUseElement>("#terrain > use"), element => ({
    i: element.getAttribute("href") || element.getAttribute("xlink:href") || "",
    x: Number(element.getAttribute("x")),
    y: Number(element.getAttribute("y")),
    s: Number(element.getAttribute("width"))
  }));
}
function prepareReliefIcons(): void {
  const raster = document.querySelector("#terrain > image[data-relief]");
  if (!raster) return;
  const data = getReliefIcons();
  ++revision;
  indexedRaster = null;
  document.getElementById("terrain")!.innerHTML = vectors(data);
}
function pickRelief(x: number, y: number): SVGUseElement | null {
  const raster = document.querySelector("#terrain > image[data-relief]");
  if (!raster || !layerIsOn("toggleRelief")) return null;
  if (indexedRaster !== raster) {
    icons = JSON.parse(raster.getAttribute("data-relief")!) as ReliefSprite[];
    tree = quadtree(
      icons,
      d => d.x + d.s / 2,
      d => d.y + d.s / 2
    );
    maxSize = icons.reduce((size, icon) => Math.max(size, icon.s), 0);
    indexedRaster = raster;
  }
  let selected: ReliefSprite | undefined;
  tree.visit((node, x0, y0, x1, y1) => {
    if (x0 > x + maxSize || y0 > y + maxSize || x1 < x - maxSize || y1 < y - maxSize) return true;
    if (!node.length) {
      let leaf = node;
      do {
        const icon = leaf.data;
        if (
          x >= icon.x &&
          x <= icon.x + icon.s &&
          y >= icon.y &&
          y <= icon.y + icon.s &&
          (!selected || icon.y + icon.s > selected.y + selected.s)
        )
          selected = icon;
        leaf = leaf.next!;
      } while (leaf);
    }
    return false;
  });
  if (!selected) return null;
  const index = icons.indexOf(selected);
  prepareReliefIcons();
  return document.querySelectorAll<SVGUseElement>("#terrain > use")[index] || null;
}
function compactRelief(): void {
  const group = document.getElementById("terrain");
  const elements = Array.from(document.querySelectorAll<SVGUseElement>("#terrain > use"));
  if (!group || !elements.length || group.children.length !== elements.length) return;
  const supported = new Set(["href", "xlink:href", "xmlns:xlink", "x", "y", "width", "height"]);
  for (const element of elements) {
    for (const attribute of Array.from(element.attributes)) {
      if (supported.has(attribute.name)) continue;
      if (
        attribute.name === "class" &&
        attribute.value.split(/\s+/).every(name => !name || name === "draggable" || name === "viewport-culled")
      )
        continue;
      if (
        attribute.name === "style" &&
        attribute.value
          .split(";")
          .every(
            rule => !rule.trim() || ["touch-action", "-webkit-tap-highlight-color"].includes(rule.split(":")[0].trim())
          )
      )
        continue;
      // Custom per-glyph filters, transforms, styles and IDs retain their exact SVG semantics.
      return;
    }
    const href = element.getAttribute("href") || element.getAttribute("xlink:href");
    const x = Number(element.getAttribute("x")),
      y = Number(element.getAttribute("y"));
    const width = Number(element.getAttribute("width")),
      height = Number(element.getAttribute("height"));
    if (!href?.startsWith("#") || ![x, y, width, height].every(Number.isFinite) || width <= 0 || width !== height)
      return;
  }
  window.reliefRenderReady = renderReliefCanvas(getReliefIcons());
}
declare global {
  interface Window {
    reliefRenderReady?: Promise<void>;
    pickRelief: typeof pickRelief;
    compactRelief: typeof compactRelief;
    getReliefIcons: typeof getReliefIcons;
    prepareReliefIcons: typeof prepareReliefIcons;
  }
}
window.pickRelief = pickRelief;
window.compactRelief = compactRelief;

window.getReliefIcons = getReliefIcons;
window.prepareReliefIcons = prepareReliefIcons;
