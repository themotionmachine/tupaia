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
  return () => {
    for (let i = removed.length - 1; i >= 0; i--) {
      const [parent, child, next] = removed[i];
      parent.insertBefore(child, next);
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

// World runs render a world region with the #viewbox transform removed; screen runs (overlays outside #viewbox)
// render the svg viewport as-is. The clone is restored after serialization so it can serve the next run.
export async function rasterizeRun(
  clone: SVGSVGElement,
  elements: Element[],
  region: Region,
  pixelWidth: number,
  pixelHeight: number,
  screen: boolean
): Promise<HTMLCanvasElement> {
  const viewbox = clone.querySelector("#viewbox");
  if (!viewbox) throw new Error("clone without #viewbox");
  const undo = isolate(clone, new Set(elements));
  const saved = ["width", "height", "viewBox", "preserveAspectRatio"].map(
    name => [name, clone.getAttribute(name)] as const
  );
  const transform = viewbox.getAttribute("transform");
  let markup: string;
  let undoDefinitions = () => {};
  try {
    if (!screen) viewbox.removeAttribute("transform");
    clone.setAttribute("width", String(pixelWidth));
    clone.setAttribute("height", String(pixelHeight));
    clone.setAttribute("viewBox", `${region.x} ${region.y} ${region.width} ${region.height}`);
    clone.setAttribute("preserveAspectRatio", "none");
    undoDefinitions = isolateEmblemDefinitions(clone);
    markup = new XMLSerializer().serializeToString(clone);
  } finally {
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
// (see fitScale in prepare), so huge worlds get a lower density instead of a forced floor over the budget.
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
