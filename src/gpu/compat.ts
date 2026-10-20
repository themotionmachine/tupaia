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

const SVG_NS = "http://www.w3.org/2000/svg";

// The one <canvas> a <foreignObject> hosts (the heightmap editor's #heights, the manual-assignment paint overlay), or
// null when it hosts anything else.
function hostedCanvas(host: Element): HTMLCanvasElement | null {
  const children = [...host.children];
  const canvas = children[0];
  return children.length === 1 && canvas.tagName.toLowerCase() === "canvas" ? (canvas as HTMLCanvasElement) : null;
}

const cssLength = (value: string | undefined, fallback: string) => {
  const match = /^\s*([\d.]+)(px)?\s*$/.exec(value ?? "");
  return match ? match[1] : fallback;
};

// A <foreignObject> must never reach the decoded SVG image: Chrome taints the canvas it is drawn into, and the texture
// upload then fails ("Tainted canvases may not be loaded") and the whole frame falls back. A clone's canvas is blank
// anyway (cloneNode copies no pixels). Each foreignObject inside a kept clone element whose live counterpart (same
// index among the element's foreignObjects) hosts one <canvas> becomes an <image> of that live canvas's pixels (a data
// URL, the only image source an SVG image may load), laid out over the canvas's CSS box; every other foreignObject left
// in the clone is detached for the serialization. Returns the undo. `encode` is injectable for tests.
export function bridgeForeignObjects(
  clone: Element,
  kept: readonly Element[],
  live: readonly Element[] | undefined,
  encode: (canvas: HTMLCanvasElement) => string = canvas => canvas.toDataURL()
): () => void {
  const all = [...clone.querySelectorAll("foreignObject")];
  if (!all.length) return () => {};
  const swaps: [Element, Element][] = [];
  const handled = new Set<Element>();
  const within = (element: Element) => [
    ...(element.tagName === "foreignObject" ? [element] : []),
    ...element.querySelectorAll("foreignObject")
  ];
  kept.forEach((element, i) => {
    const source = live?.[i];
    if (!source) return;
    const copies = within(element);
    const originals = within(source);
    if (copies.length !== originals.length) return;
    copies.forEach((copy, j) => {
      const canvas = hostedCanvas(originals[j]);
      if (!canvas?.width || !canvas.height) return;
      let href: string;
      try {
        href = encode(canvas);
      } catch {
        return; // a tainted live canvas: detached below like any other foreignObject
      }
      const image = clone.ownerDocument.createElementNS(SVG_NS, "image");
      for (const name of ["x", "y", "transform", "opacity", "style", "class"]) {
        const value = copy.getAttribute(name);
        if (value !== null) image.setAttribute(name, value);
      }
      image.setAttribute("width", cssLength(canvas.style?.width, copy.getAttribute("width") ?? "0"));
      image.setAttribute("height", cssLength(canvas.style?.height, copy.getAttribute("height") ?? "0"));
      image.setAttribute("preserveAspectRatio", "none");
      image.setAttribute("href", href);
      swaps.push([copy, image]);
      handled.add(copy);
    });
  });
  const removed: [Element, Node, Node | null][] = [];
  for (const [copy, image] of swaps) copy.replaceWith(image);
  for (const host of all)
    if (!handled.has(host) && host.parentNode) {
      removed.push([host, host.parentNode, host.nextSibling]);
      host.remove();
    }
  return () => {
    for (let i = removed.length - 1; i >= 0; i--) {
      const [host, parent, next] = removed[i];
      parent.insertBefore(host, next);
    }
    for (const [copy, image] of swaps) image.replaceWith(copy);
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

// Mask and clip rects sized in viewport percentages (#water and #fog: x 0, y 0, width and height 100%) resolve against
// the live svg#map viewport (the window, svgWidth x svgHeight) in the masked element's user space, so on a map larger
// than the window the live SVG masks everything past world x svgWidth / y svgHeight. A raster's document has its own
// size and viewBox (the run's region), where they resolved against the region instead: the GPU drew the water-masked
// texture over the whole 1680x849 demo map where SVG stops at 1280x720 (corpus demo-v1.112 texture over16 9.3%), and a
// settle detail (region = the view) would mask differently again. Pins them to the live viewport for serialization.
// Returns an undo function.
export function pinViewportPercentages(clone: Element, width: number, height: number): () => void {
  const changed: [Element, string, string][] = [];
  if (!(width > 0) || !(height > 0)) return () => {};
  for (const rect of clone.querySelectorAll("mask rect, clipPath rect"))
    for (const [name, size] of [
      ["x", width],
      ["y", height],
      ["width", width],
      ["height", height]
    ] as const) {
      const value = rect.getAttribute(name);
      const match = value?.trim().match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)%$/i);
      if (!value || !match) continue;
      changed.push([rect, name, value]);
      rect.setAttribute(name, String((Number(match[1]) / 100) * size));
    }
  return () => {
    for (let i = changed.length - 1; i >= 0; i--) changed[i][0].setAttribute(changed[i][1], changed[i][2]);
  };
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
  // raster px per live CSS px. The decoded document is sized in live CSS px (pixel size / cssScale) and drawn at the
  // pixel size: what is specified in screen px rather than user units (text-shadow, vector-effect=non-scaling-stroke,
  // whose stroke and dashes the #coordinates grid uses) keeps its live size. Before, the document was its pixel size:
  // the regiment glow and the coordinate grid came out at half width at dpr 2. Plain content renders identically
  // (Chrome rasterizes an SVG image at its destination size).
  cssScale = 1,
  // the live elements `elements` were resolved from (same order): the pixels of a canvas a <foreignObject> hosts
  live?: readonly Element[]
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
  let undoForeign = () => {};
  let undoPercent = () => {};
  try {
    // before the raster's own size and viewBox replace the live viewport the percentages resolve against
    undoPercent = pinViewportPercentages(clone, Number(saved[0][1]), Number(saved[1][1]));
    if (!screen) {
      viewbox.removeAttribute("transform");
      undoOpacity = liftGroupOpacity(viewbox, elements);
    }
    const scale = cssScale > 0 && Number.isFinite(cssScale) ? cssScale : 1;
    clone.setAttribute("width", String(pixelWidth / scale));
    clone.setAttribute("height", String(pixelHeight / scale));
    clone.setAttribute("viewBox", `${region.x} ${region.y} ${region.width} ${region.height}`);
    clone.setAttribute("preserveAspectRatio", "none");
    clone.removeAttribute("filter");
    undoDefinitions = isolateEmblemDefinitions(clone);
    undoForeign = bridgeForeignObjects(clone, elements, live);
    markup = new XMLSerializer().serializeToString(clone);
  } finally {
    undoForeign();
    undoPercent();
    undoOpacity();
    undoDefinitions();
    undo();
    for (const [name, value] of saved) value === null ? clone.removeAttribute(name) : clone.setAttribute(name, value);
    if (transform !== null) viewbox.setAttribute("transform", transform);
  }
  // Restore the shared clone before yielding: preparation and refinement may decode concurrently.
  return decode(markup, pixelWidth, pixelHeight);
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
