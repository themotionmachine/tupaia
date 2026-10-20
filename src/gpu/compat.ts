// Explicit compatibility lane: elements the native passes cannot reproduce exactly (filters, clip-paths, nested
// opacity, foreign images, shadowed text...) are rasterized from the detached export clone (prepareMapClone: styles,
// fonts and images inlined) and composited in DOM order. Never used for elements the native passes draw.
import { prepareMapClone } from "../io/export";
import { alphaBounds, cropRegion, type PixelBounds, padBounds } from "./budget";
import { isolateEmblemDefinitions } from "./compat-assets";
import { compatDirt } from "./compat-reuse";

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export { resolveInClone } from "./clone-map";

// `stamp`: the reuse tracker's epoch when the clone was cut (compat-reuse.ts), taken before the copy starts so a change
// racing it can only make the stamp older than the content, never newer.
let cached: { revision: number; clone: Promise<SVGSVGElement>; stamp: number } | null = null;

export function compatClone(revision: number): Promise<SVGSVGElement> {
  return stampedClone(revision).then(entry => entry.clone);
}

export function stampedClone(revision: number): Promise<{ clone: SVGSVGElement; stamp: number }> {
  if (cached?.revision !== revision) {
    const stamp = compatDirt.now();
    // keep #debug: the scene walks the live #viewbox, where editors draw their overlays (#controlPoints...)
    const clone = prepareMapClone("gpu", { debug: true });
    cached = { revision, clone, stamp };
    clone.catch(() => {
      if (cached?.clone === clone) cached = null;
    });
  }
  const { clone, stamp } = cached;
  return clone.then(element => ({ clone: element, stamp }));
}

// A replaced world or a disposed renderer: no raster cut before now may be reused.
export function forgetCompatClone(): void {
  cached = null;
  compatDirt.all("clone forgotten");
}

// Detaches everything but `keep` (and the ancestors needed to reach it) so serialization stays small.
// Returns an undo function that reinserts in reverse order.
export function isolate(root: Element, keep: Set<Element>): () => void {
  const removed: [Element, Element, Node | null][] = [];
  const ids = idMap(root); // before pruning: the map must hold the pruned ids too
  const containsKept = new Set<Element>();
  for (const element of keep)
    for (let node = element.parentElement; node && node !== root.parentElement; node = node.parentElement)
      containsKept.add(node);
  const visit = (element: Element) => {
    for (const child of [...element.children]) {
      if (keep.has(child) || child.tagName === "defs" || child.tagName === "style") continue;
      if (containsKept.has(child)) visit(child);
      else {
        removed.push([element, child, child.nextSibling]);
        child.remove();
      }
    }
  };
  visit(root);
  // Keep all definitions: references can target descendants (paint servers, clip paths, charges), and
  // stylesheet rules can affect siblings. Outer-SVG <use> reachability alone is not a safe pruning rule.
  const holder = holdReferenced(
    root,
    ids,
    keep,
    removed.map(([, child]) => child)
  );
  return () => {
    for (let i = removed.length - 1; i >= 0; i--) {
      const [parent, child, next] = removed[i];
      parent.insertBefore(child, next);
    }
    holder?.remove();
  };
}

// Elements that can name another by id: url() paint/clip/mask/filter/marker references, and href (including the
// namespaced xlink:href, which an un-namespaced attribute selector cannot match, hence the tag names).
const REFERENCING =
  '[clip-path],[mask],[filter],[fill*="url("],[stroke*="url("],[style*="url("],[marker-start],[marker-mid],[marker-end],' +
  "[href],use,textPath,pattern,linearGradient,radialGradient,feImage,image,tref";
const URL_ID = /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/g;

function referencedIds(element: Element, out: string[]): void {
  for (const node of [element, ...element.querySelectorAll(REFERENCING)]) {
    for (const { name, value } of Array.from(node.attributes)) {
      if (name === "href" || name === "xlink:href") {
        if (value.startsWith("#")) out.push(value.slice(1));
      } else if (value.includes("url(")) for (const match of value.matchAll(URL_ID)) out.push(match[1]);
    }
  }
}

// Every id of a clone, built once: isolation only detaches and reinserts its nodes, never replaces them.
const idMaps = new WeakMap<Element, Map<string, Element>>();
function idMap(root: Element): Map<string, Element> {
  let map = idMaps.get(root);
  if (!map) {
    map = new Map();
    for (const node of root.querySelectorAll("[id]")) if (!map.has(node.id)) map.set(node.id, node);
    idMaps.set(root, map);
  }
  return map;
}

// A kept element can reach a pruned one through a definition: a state halo is clipped by <clipPath><use href="#state0">
// whose target is the native #statesBody path. Pruned, that clip is empty and the halo raster came out blank. The
// references of the kept elements are followed (through definitions too); each pruned subtree holding a target moves
// into a <defs> (referable, never painted) until the undo puts it back. Returns the holder (null when none was needed).
function holdReferenced(
  root: Element,
  ids: Map<string, Element>,
  keep: Set<Element>,
  pruned: Element[]
): Element | null {
  if (!pruned.length) return null;
  const queue: string[] = [];
  for (const element of keep) referencedIds(element, queue);
  if (!queue.length) return null;
  const prunedSet = new Set(pruned);
  const seen = new Set<string>();
  const scanned = new Set<Element>();
  let holder: Element | null = null;
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const target = ids.get(id);
    if (!target) continue;
    let owner: Element | null = null;
    for (let node: Element | null = target; node && node !== root; node = node.parentElement)
      if (prunedSet.has(node)) {
        owner = node;
        break;
      }
    const scan = owner ?? target;
    if (owner) {
      holder ??= root.appendChild(root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "defs"));
      holder.appendChild(owner);
      prunedSet.delete(owner);
    }
    if (scanned.has(scan)) continue;
    scanned.add(scan);
    referencedIds(scan, queue);
  }
  return holder;
}

// Group opacity is the GPU's: scene.ts turns every group below #viewbox with opacity < 1 into a group draw that
// composites its children (compat rasters included) at that opacity, and a nested one becomes the compat element
// itself. A compat raster cut with those ancestors intact carries their opacity once more (provinces at 0.7 drew at
// 0.49). Sets each such ancestor to opacity 1 (attribute and inline style, which beats the inlined computed style and
// any stylesheet rule) and returns the undo. The elements' own opacity stays in the raster.
export function liftGroupOpacity(viewbox: Element, elements: Iterable<Element>): () => void {
  const saved: [Element, string | null, string | null][] = [];
  const seen = new Set<Element>();
  for (const element of elements)
    for (let node = element.parentElement; node && node !== viewbox; node = node.parentElement) {
      if (seen.has(node)) continue;
      seen.add(node);
      const style = (node as unknown as ElementCSSInlineStyle).style;
      const attribute = node.getAttribute("opacity");
      const inline = style?.getPropertyValue("opacity") ?? "";
      const below = (value: string | null) => !!value && value.trim() !== "" && Number(value) !== 1;
      if (!below(attribute) && !below(inline)) continue;
      saved.push([node, attribute, node.getAttribute("style")]);
      node.setAttribute("opacity", "1");
      if (below(inline)) style.setProperty("opacity", "1");
    }
  return () => {
    for (let i = saved.length - 1; i >= 0; i--) {
      const [node, attribute, style] = saved[i];
      attribute === null ? node.removeAttribute("opacity") : node.setAttribute("opacity", attribute);
      style === null ? node.removeAttribute("style") : node.setAttribute("style", style);
    }
  };
}

function decode(markup: string, width: number, height: number): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return reject(new Error("Canvas2D unavailable"));
      context.drawImage(image, 0, 0, width, height);
      resolve(canvas);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("compat raster decode failed"));
    };
    image.src = url;
  });
}

// text-shadow on SVG text ignores the element's transforms (the viewBox mapping included): its lengths are CSS px of
// the document, which the live page zooms by its device pixel ratio and an SVG decoded as an image does not. A raster
// cut at `cssScale` raster px per live CSS px scales them to match: the live regiment banners' 4 px glow came out at
// half width at k 1 (dpr 2), a quarter at k 4. Lengths in style attributes and <style> rules alike; 1 is a no-op.
export function scaleTextShadows(markup: string, cssScale: number): string {
  if (!(cssScale > 0) || Math.abs(cssScale - 1) < 1e-6 || !markup.includes("text-shadow")) return markup;
  return markup.replace(
    /(text-shadow\s*:\s*)([^;"}<]+)/g,
    (_, name: string, value: string) =>
      name + value.replace(/(-?(?:\d+\.?\d*|\.\d+))px/g, (__, n: string) => `${+(Number(n) * cssScale).toFixed(3)}px`)
  );
}

// World runs render a world region with the #viewbox transform removed; screen runs (overlays outside #viewbox)
// render the svg viewport as-is. The clone is restored after serialization so it can serve the next run.
export async function rasterizeRun(
  clone: SVGSVGElement,
  elements: Element[],
  region: Region,
  pixelWidth: number,
  pixelHeight: number,
  screen: boolean,
  cssScale = 1 // raster px per live CSS px (scaleTextShadows)
): Promise<HTMLCanvasElement> {
  const viewbox = clone.querySelector("#viewbox");
  if (!viewbox) throw new Error("clone without #viewbox");
  const undo = isolate(clone, new Set(elements));
  // LIFE: the root filter is applied to the whole canvas (renderer.ts root filter), never inside a raster
  const saved = ["width", "height", "viewBox", "preserveAspectRatio", "filter"].map(
    name => [name, clone.getAttribute(name)] as const
  );
  const transform = viewbox.getAttribute("transform");
  let markup: string;
  let undoDefinitions = () => {};
  let undoOpacity = () => {};
  try {
    if (!screen) {
      viewbox.removeAttribute("transform");
      undoOpacity = liftGroupOpacity(viewbox, elements);
    }
    clone.setAttribute("width", String(pixelWidth));
    clone.setAttribute("height", String(pixelHeight));
    clone.setAttribute("viewBox", `${region.x} ${region.y} ${region.width} ${region.height}`);
    clone.setAttribute("preserveAspectRatio", "none");
    clone.removeAttribute("filter");
    undoDefinitions = isolateEmblemDefinitions(clone);
    markup = new XMLSerializer().serializeToString(clone);
  } finally {
    undoOpacity();
    undoDefinitions();
    undo();
    for (const [name, value] of saved) value === null ? clone.removeAttribute(name) : clone.setAttribute(name, value);
    if (transform !== null) viewbox.setAttribute("transform", transform);
  }
  // Restore the shared clone before yielding: preparation and refinement may decode concurrently.
  return decode(scaleTextShadows(markup, cssScale), pixelWidth, pixelHeight);
}

// Decode resolution for world runs: the desired density capped by MAX_TEXTURE_SIZE and by a per-run decode pixel cap
// (the transient CPU canvas; 4096² also fits Safari's canvas area limit). GPU memory is bounded after alpha cropping
// (fitScale, or the ladder below with compat reuse on, in prepare), so huge worlds get a lower density instead of a
// forced floor over the budget.
export function compatResolution(
  runs: number,
  world: Region,
  desired: number,
  maxTexture: number,
  maxPixels = 1 << 24
): number {
  if (!runs) return 0;
  const bySize = maxTexture / Math.max(world.width, world.height);
  const byPixels = Math.sqrt(maxPixels / (world.width * world.height));
  return Math.min(desired, bySize, byPixels);
}

// With compat reuse on (prepare.ts compatReuseEnabled), world rasters shrink under budget pressure along a fixed ladder,
// base·2^(-level/LADDER_STEPS), never to an exact fit (off, they fit exactly, fitScale).
// A frame's world rasters all sit at one level, so two prepares whose budgets differ a little (a cells mesh, a route
// edit, the previous frame's size) land on the same level and a clean run's raster stays reusable (compat-reuse.ts).
export const LADDER_STEPS = 4;
// A step down aims this far under the room, so the next prepare's slightly different budget still fits at that level.
export const LADDER_HEADROOM = 0.85;

export const ladderScale = (level: number): number => 2 ** (-level / LADDER_STEPS);

// The lowest level ≥ `from` at which `bytes`, measured at level `from`, fit `room` (bytes scale with the square of the
// linear density; scaleRaster floors each side, so the result never exceeds the estimate).
export function ladderFit(bytes: number, room: number, from: number): number {
  let level = from;
  while (level < from + 64 && bytes * (ladderScale(level) / ladderScale(from)) ** 2 > room) level++;
  return level;
}

// Where a prepare that keeps world rasters starts: the previous frame's level `from`, or the level a full re-prepare
// would reach with the previous frame's world bytes (measured at `from`) when that is higher (sharper): level 0 when
// they fit the room there, else the ladder fit under LADDER_HEADROOM. Without it a reused frame never steps back up.
export function ladderStart(from: number, bytes: number, room: number): number {
  const atBase = bytes / ladderScale(from) ** 2;
  return Math.min(from, atBase <= room ? 0 : ladderFit(atBase, room * LADDER_HEADROOM, 0));
}

// Crops a decoded raster to its non-transparent pixels plus 1 px transparent padding and returns the world rect of the
// kept pixels: copied, never resampled. null when fully transparent; the raster unchanged when it cannot be read back.
export function cropRaster(
  canvas: HTMLCanvasElement,
  region: Region
): { canvas: HTMLCanvasElement; rect: Region } | null {
  const { width, height } = canvas;
  let bounds: PixelBounds | null;
  try {
    bounds = alphaBounds(canvas.getContext("2d")!.getImageData(0, 0, width, height).data, width, height);
  } catch {
    return { canvas, rect: region };
  }
  if (!bounds) return null;
  const kept = padBounds(bounds, 1, width, height);
  if (kept.width === width && kept.height === height) return { canvas, rect: region };
  const cropped = resized(canvas, kept, kept.width, kept.height);
  canvas.width = canvas.height = 0; // drop the full-size backing store now
  return { canvas: cropped, rect: cropRegion(region, width, height, kept) };
}

// Budget-pressure fallback only: resamples a cropped raster by `scale` (same world rect, fewer pixels).
export function scaleRaster(canvas: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  if (scale >= 1) return canvas;
  // floored so the scaled bytes never exceed scale² of the source (the budget fit)
  const [w, h] = [Math.max(1, Math.floor(canvas.width * scale)), Math.max(1, Math.floor(canvas.height * scale))];
  const scaled = resized(canvas, { x: 0, y: 0, width: canvas.width, height: canvas.height }, w, h);
  canvas.width = canvas.height = 0;
  return scaled;
}

function resized(source: HTMLCanvasElement, from: PixelBounds, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas2D unavailable");
  context.drawImage(source, from.x, from.y, from.width, from.height, 0, 0, width, height);
  return canvas;
}
