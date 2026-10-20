// Per-run raster window (COST, W3). A world compat run used to be decoded over the whole world region (or the whole
// visible region when refined), read back with getImageData and alpha-scanned, whatever its size: 2560x1440 for one
// regiment. Here the run is decoded only over a window of that same pixel grid, sized from the live geometry, so the
// raster, the readback and the scan follow the run's footprint. The window is a pixel-aligned sub-rectangle of the
// full raster, at the same density and phase, so the result equals the full raster cropped to it.
//
// It fails safe. A run whose reach cannot be bounded from geometry (a filter on it, in it or above it; a measurement
// that throws) is cut over the full region. A windowed raster whose ink touches a window edge that is not an edge of
// the full region, or that came out fully transparent, may have lost pixels outside the window: it is cut again over
// the full region. Only content disconnected from the run's geometry and farther than the padding can escape both.
import type { PixelBounds } from "./budget";
import { alphaBounds, cropRegion, padBounds } from "./budget";
import { cropRaster, type Region, rasterizeRun } from "./compat";

// Padding around the geometric bounds: world units (strokes, markers, glyph overhang) plus raster pixels (screen-space
// effects: text-shadow, non-scaling strokes).
export const WINDOW_PAD_UNITS = 2;
export const WINDOW_PAD_PX = 12;
// A window covering at least this share of the full raster is not worth it: the full raster is cut directly.
export const WINDOW_MAX_SHARE = 0.6;

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };

// The box `rect` (local user units) maps to through `m`.
export function transformBox(rect: { x: number; y: number; width: number; height: number }, m: Matrix): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height]
  ]) {
    xs.push(m.a * x + m.c * y + m.e);
    ys.push(m.b * x + m.d * y + m.f);
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

export const union = (a: Box | null, b: Box): Box =>
  a ? { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) } : b;

// A filter anywhere it can reach the run's pixels: on an element, inside it, or on an ancestor below #viewbox. The
// export clone carries inlined computed styles, so a stylesheet filter shows as a style declaration there.
const FILTERED = /(^|;)\s*filter\s*:(?!\s*none\s*(;|$))/i;
const filtered = (element: Element) =>
  (element.hasAttribute("filter") && element.getAttribute("filter") !== "none") ||
  FILTERED.test(element.getAttribute("style") || "");

export function reachesFilter(clones: readonly Element[]): boolean {
  const seen = new Set<Element>();
  for (const element of clones) {
    if (filtered(element) || element.querySelector('[filter]:not([filter="none"]), [style*="filter"]')) {
      if (filtered(element)) return true;
      for (const inner of element.querySelectorAll("[filter], [style*='filter']")) if (filtered(inner)) return true;
    }
    for (
      let node = element.parentElement;
      node && node.id !== "viewbox" && !seen.has(node);
      node = node.parentElement
    ) {
      seen.add(node);
      if (filtered(node)) return true;
    }
  }
  return false;
}

// Elements a zero-size box can still paint at: a stroked point (a round- or square-capped zero-length subpath, a lone
// "M x y z" dot) has no geometric extent, but its cap is ink. getBBox excludes strokes, so such a dot measured 0x0 and
// was left out of the run's box: a dot apart from the rest of its run fell outside the window (COST2 item 4).
// An empty path (no d) paints nothing and measures 0x0 at the origin: it must not drag the box there.
const POINT_CONTENT = 'path[d]:not([d=""]),line,polyline[points]:not([points=""]),polygon[points]:not([points=""])';
const paintsPoint = (element: Element) => {
  try {
    return element.matches?.(POINT_CONTENT) || !!element.querySelector?.(POINT_CONTENT);
  } catch {
    return true;
  }
};

// World boxes of the live elements (each bounding box through its screen CTM relative to #viewbox's), unpadded. Empty
// elements (nothing rendered) give none; a zero-size box of an element that can paint a point (paintsPoint) is that
// point. null when unknown (a measurement failed or the matrix is singular).
export function elementBoxes(lives: readonly Element[], viewbox: Element): Box[] | null {
  try {
    const root = (viewbox as SVGGraphicsElement).getScreenCTM();
    if (!root) return null;
    const inverse = root.inverse();
    const boxes: Box[] = [];
    for (const element of lives) {
      const graphics = element as SVGGraphicsElement;
      if (typeof graphics.getBBox !== "function") return null;
      const bbox = graphics.getBBox();
      const ctm = graphics.getScreenCTM();
      if (!ctm) return null;
      if (!(bbox.width > 0 || bbox.height > 0) && !paintsPoint(element)) continue;
      const m = inverse.multiply(ctm);
      if (![m.a, m.b, m.c, m.d, m.e, m.f].every(Number.isFinite)) return null;
      boxes.push(transformBox(bbox, m));
    }
    return boxes;
  } catch {
    return null;
  }
}

const padBox = (box: Box, pad: number): Box => ({
  x0: box.x0 - pad,
  y0: box.y0 - pad,
  x1: box.x1 + pad,
  y1: box.y1 + pad
});

// The run box of element boxes (elementBoxes): their union padded by WINDOW_PAD_UNITS; an empty box for none.
export function boundsOf(boxes: readonly Box[] | null): Box | null {
  if (!boxes) return null;
  const box = boxes.reduce<Box | null>(union, null);
  return box ? padBox(box, WINDOW_PAD_UNITS) : { x0: 0, y0: 0, x1: 0, y1: 0 };
}

// World bounds of the live elements (union of their bounding boxes through their screen CTM relative to #viewbox's),
// padded by WINDOW_PAD_UNITS; null when unknown (a measurement failed or the matrix is singular). Empty elements
// (nothing rendered) add nothing; a zero-size box of an element that can paint a point (paintsPoint) adds that point;
// a run with no extent at all gives an empty box, never a guess.
export const liveBounds = (lives: readonly Element[], viewbox: Element): Box | null =>
  boundsOf(elementBoxes(lives, viewbox));

// What of a run reaches `region`: the union of its element boxes (each padded by WINDOW_PAD_UNITS) clipped to the
// region, null when none reaches it. The run box (boundsOf) of labels spread over the world spans the world, where the
// few labels in a zoomed view reach a small part of it.
export function boundsWithin(
  boxes: readonly Box[],
  region: { x: number; y: number; width: number; height: number }
): Box | null {
  const [rx1, ry1] = [region.x + region.width, region.y + region.height];
  let reach: Box | null = null;
  for (const box of boxes) {
    const padded = padBox(box, WINDOW_PAD_UNITS);
    const clipped = {
      x0: Math.max(padded.x0, region.x),
      y0: Math.max(padded.y0, region.y),
      x1: Math.min(padded.x1, rx1),
      y1: Math.min(padded.y1, ry1)
    };
    if (clipped.x1 > clipped.x0 && clipped.y1 > clipped.y0) reach = union(reach, clipped);
  }
  return reach;
}

// Label culling hides off-screen labels and emblems with `.viewport-culled{display:none!important}` (label-culling.ts),
// which getBBox cannot measure, while the export clone strips the class and rasterizes them (export.ts). The culling
// sheets are switched off for the synchronous measurement and back on before any paint or observer can see it (a
// CSSOM flag, not a DOM mutation).
const CULLING = ".viewport-culled{display:none";

export interface Measured {
  elements: readonly Element[];
  screen: boolean;
  bounds?: Box | null;
  boxes?: Box[] | null; // its elements' own boxes (elementBoxes), measured with `bounds`
}

// Sets `bounds` (liveBounds) and `boxes` (elementBoxes) on every world item that has no bounds yet, in one pass with
// label culling off.
export function measureBounds(items: readonly Measured[], viewbox: Element): void {
  const todo = items.filter(item => !item.screen && item.bounds === undefined);
  if (!todo.length) return;
  // Turning the sheet off and on restyles and repaints the whole map, and every repaint re-layerizes it (hundreds of ms
  // on a dense map): only when a culled element is measured.
  const culled = todo.some(item =>
    item.elements.some(
      element => element.classList?.contains("viewport-culled") || !!element.querySelector?.(".viewport-culled")
    )
  );
  const sheets: CSSStyleSheet[] = [];
  const svg = (viewbox as SVGGraphicsElement).ownerSVGElement ?? viewbox.parentElement;
  for (const style of (culled && svg?.querySelectorAll("style")) || []) {
    const sheet = (style as HTMLStyleElement).sheet;
    if (sheet && !sheet.disabled && (style.textContent || "").replace(/\s+/g, "").includes(CULLING)) {
      sheet.disabled = true;
      sheets.push(sheet);
    }
  }
  try {
    for (const item of todo) {
      item.boxes = elementBoxes(item.elements, viewbox);
      item.bounds = boundsOf(item.boxes);
    }
  } finally {
    for (const sheet of sheets) sheet.disabled = false;
  }
}

export interface RasterWindow {
  region: Region; // the world rect of the window, on the full raster's pixel grid
  px: PixelBounds; // the window's pixels inside the full raster
  // the window edges that are not edges of the full raster: ink there may continue outside the window
  open: { left: boolean; top: boolean; right: boolean; bottom: boolean };
}

// The pixel-aligned window of a `width` x `height` raster of `full` covering `box` (world units) plus `padPx` raster
// pixels; null when the box misses the region.
export function gridWindow(full: Region, width: number, height: number, box: Box, padPx: number): RasterWindow | null {
  const [sx, sy] = [width / full.width, height / full.height];
  const left = Math.max(0, Math.floor((box.x0 - full.x) * sx) - padPx);
  const top = Math.max(0, Math.floor((box.y0 - full.y) * sy) - padPx);
  const right = Math.min(width, Math.ceil((box.x1 - full.x) * sx) + padPx);
  const bottom = Math.min(height, Math.ceil((box.y1 - full.y) * sy) + padPx);
  if (!(right > left && bottom > top)) return null;
  const px = { x: left, y: top, width: right - left, height: bottom - top };
  return {
    region: cropRegion(full, width, height, px),
    px,
    open: { left: left > 0, top: top > 0, right: right < width, bottom: bottom < height }
  };
}

// Ink on an open edge: the run may continue outside the window.
export function touchesOpenEdge(ink: PixelBounds, width: number, height: number, open: RasterWindow["open"]): boolean {
  return (
    (open.left && ink.x === 0) ||
    (open.top && ink.y === 0) ||
    (open.right && ink.x + ink.width === width) ||
    (open.bottom && ink.y + ink.height === height)
  );
}

// What a windowed cut did (telemetry): window, full (unbounded or not worth it), a fallback to full after the window
// (clipped: ink on an open edge; empty: no ink at all), or missed (its box misses the region: transparent, not cut).
export type WindowOutcome = "window" | "full" | "unbounded" | "clipped" | "empty" | "missed";

export interface WindowStats {
  window: number;
  full: number;
  unbounded: number;
  clipped: number;
  empty: number;
  missed: number;
  pixels: number; // decoded raster pixels
  fullPixels: number; // what full-region cuts of the same runs would have decoded
  decodeMs: number; // serialize + decode (its wait for the image load included)
  scanMs: number; // readback, alpha scan and crop
  batches: number; // decodes shared by several windowed runs (WindowBatches)
  batched: number; // windowed runs cut from a shared decode (counted in `window` too)
  // ?gpu-compat-window=verify: every windowed cut is also cut over the full region and compared (its crop rect and
  // its pixels); the full cut is the one used
  verify?: {
    runs: number;
    rectMismatch: number;
    differingPixels: number;
    maxDelta: number;
    worst: { run: string; pixels: number; maxDelta: number }[]; // the runs that differ, most pixels first (up to 8)
  };
}

export const newWindowStats = (): WindowStats => ({
  window: 0,
  full: 0,
  unbounded: 0,
  clipped: 0,
  empty: 0,
  missed: 0,
  pixels: 0,
  fullPixels: 0,
  decodeMs: 0,
  scanMs: 0,
  batches: 0,
  batched: 0
});

// ?gpu-compat-window=0 cuts every run over the full region, as before W3 (A/B); =verify cuts both and compares.
// =control compares two full cuts instead: the noise floor of the decoder itself.
function windowMode(): "on" | "off" | "verify" | "control" {
  try {
    const value = new URLSearchParams(globalThis.location?.search ?? "").get("gpu-compat-window");
    return value === "0" ? "off" : value === "verify" ? "verify" : value === "control" ? "control" : "on";
  } catch {
    return "on";
  }
}

function compare(
  a: { canvas: HTMLCanvasElement; rect: Region } | null,
  b: { canvas: HTMLCanvasElement; rect: Region } | null,
  verify: NonNullable<WindowStats["verify"]>,
  run: string
): void {
  verify.runs++;
  const close = (x: number, y: number) => Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(x));
  if (!a || !b) {
    if (a !== b) verify.rectMismatch++;
    return;
  }
  const [r, s] = [a.rect, b.rect];
  if (
    !close(r.x, s.x) ||
    !close(r.y, s.y) ||
    !close(r.width, s.width) ||
    !close(r.height, s.height) ||
    a.canvas.width !== b.canvas.width ||
    a.canvas.height !== b.canvas.height
  ) {
    verify.rectMismatch++;
    return;
  }
  const { width, height } = a.canvas;
  const da = a.canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
  const db = b.canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
  let pixels = 0;
  let max = 0;
  for (let i = 0; i < da.length; i += 4) {
    let delta = 0;
    for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(da[i + c] - db[i + c]));
    if (delta) {
      pixels++;
      max = Math.max(max, delta);
    }
  }
  verify.differingPixels += pixels;
  verify.maxDelta = Math.max(verify.maxDelta, max);
  if (pixels) {
    verify.worst.push({ run, pixels, maxDelta: max });
    verify.worst.sort((x, y) => y.pixels - x.pixels).splice(8);
  }
}

// A world run's raster over `full` at `width` x `height`, alpha-cropped: the result of cropRaster on the full raster
// (null: fully transparent), cut over the run's window when its bounds (measureBounds) allow. `clones` are the run's
// elements in `clone`.
export async function rasterizeWindowed(args: {
  clone: SVGSVGElement;
  clones: Element[];
  full: Region;
  width: number;
  height: number;
  cssScale: number;
  stats?: WindowStats;
  bounds: Box | null; // measureBounds
  verifying?: boolean; // the windowed half of a verify cut
  live?: readonly Element[]; // rasterizeRun's `live`: the run's live elements, for the canvases a <foreignObject> hosts
}): Promise<{ canvas: HTMLCanvasElement; rect: Region } | null> {
  const { clone, clones, full, width, height, cssScale, stats, live } = args;
  const count = (outcome: WindowOutcome, pixels: number) => {
    if (!stats) return;
    stats[outcome]++;
    stats.pixels += pixels;
    stats.fullPixels += width * height;
  };
  const timed = async <T>(key: "decodeMs" | "scanMs", work: () => T | Promise<T>): Promise<T> => {
    const started = performance.now();
    try {
      return await work();
    } finally {
      if (stats) stats[key] += Math.round((performance.now() - started) * 10) / 10;
    }
  };
  const whole = async (outcome: WindowOutcome, spent = 0) => {
    const canvas = await timed("decodeMs", () =>
      rasterizeRun(clone, clones, full, width, height, false, cssScale, live)
    );
    count(outcome, spent + width * height);
    return timed("scanMs", () => cropRaster(canvas, full));
  };
  const mode = args.verifying ? "on" : windowMode();
  if (mode === "off") return whole("full");
  if (mode === "verify" || mode === "control") {
    const windowed =
      mode === "verify"
        ? await rasterizeWindowed({ ...args, stats: undefined, verifying: true })
        : cropRaster(await rasterizeRun(clone, clones, full, width, height, false, cssScale, live), full);
    const reference = await whole("full");
    if (stats) {
      stats.verify ??= { runs: 0, rectMismatch: 0, differingPixels: 0, maxDelta: 0, worst: [] };
      const first = clones[0];
      compare(windowed, reference, stats.verify, `${first?.parentElement?.id ?? ""}>${first?.id || first?.tagName}`);
    }
    if (windowed) windowed.canvas.width = windowed.canvas.height = 0;
    return reference;
  }
  const box = args.bounds;
  if (!box || reachesFilter(clones)) return whole("unbounded");
  if (box.x1 <= box.x0 && box.y1 <= box.y0) return whole("empty"); // nothing measurable: cut it as before
  const window = gridWindow(full, width, height, box, WINDOW_PAD_PX);
  // The run's padded box misses the region: nothing of it is drawn there, as a windowed cut assumes for the pixels
  // outside its window. It used to be cut over the whole region to find that out: at a zoomed settle every run outside
  // the view decoded and scanned the full visible raster (goods at k 8: 174 of them, 890 M pixels, 9.5 s).
  if (!window) {
    count("missed", 0);
    return null;
  }
  const { px } = window;
  if (px.width * px.height >= WINDOW_MAX_SHARE * width * height) return whole("full");
  const canvas = await timed("decodeMs", () =>
    rasterizeRun(clone, clones, window.region, px.width, px.height, false, cssScale, live)
  );
  let ink: PixelBounds | null;
  try {
    ink = await timed("scanMs", () =>
      alphaBounds(canvas.getContext("2d")!.getImageData(0, 0, px.width, px.height).data, px.width, px.height)
    );
  } catch {
    canvas.width = canvas.height = 0;
    return whole("unbounded", px.width * px.height);
  }
  const spent = px.width * px.height;
  if (!ink || touchesOpenEdge(ink, px.width, px.height, window.open)) {
    canvas.width = canvas.height = 0;
    return whole(ink ? "clipped" : "empty", spent);
  }
  count("window", 0);
  if (stats) stats.pixels += spent;
  // cropRaster's 1 px padding, inside the window (ink is at least 1 px from every open edge)
  const kept = padBounds(ink, 1, px.width, px.height);
  if (kept.width === px.width && kept.height === px.height) return { canvas, rect: window.region };
  const cropped = document.createElement("canvas");
  cropped.width = kept.width;
  cropped.height = kept.height;
  const context = cropped.getContext("2d");
  if (!context) throw new Error("Canvas2D unavailable");
  context.drawImage(canvas, kept.x, kept.y, kept.width, kept.height, 0, 0, kept.width, kept.height);
  canvas.width = canvas.height = 0;
  return { canvas: cropped, rect: cropRegion(window.region, px.width, px.height, kept) };
}

// ---- batched windows (COST2) ---------------------------------------------------------------------------------------

// Each cut has a fixed cost whatever its window: isolating the run in the clone, serializing it with every definition
// and font of the map, decoding that SVG document and reading it back (about 25 ms on the parity world). A layer that
// interleaves native and compat content cuts into many small runs, each paying it: the goods editor's plates (a compat
// rect, circle and icon, then native text) made 234 world runs, 6.5 s of world rasters at every resume.
// Runs whose windows are pairwise disjoint are therefore decoded together, once, over the union of their windows: the
// same pixel grid, so each window of the shared raster holds what that run's own windowed cut would (the other runs'
// ink stays in their own windows, as a windowed cut already assumes). Each run is then scanned and cropped from its
// window as rasterizeWindowed does. Any doubt sends a run back to its own cut: no ink in its window (rasterizeWindowed
// decides between empty and a full cut), and ink on an open window edge in any run of the batch (that run may reach
// into a neighbour's window, so the whole batch is cut again one by one).
export const BATCH_MAX_PIXELS = 1 << 23; // the shared decode (32 MiB of transient canvas)

export interface BatchMember {
  clones: Element[];
  live?: readonly Element[];
  bounds: Box | null;
}

interface Planned<K> {
  key: K;
  member: BatchMember;
  window: RasterWindow;
}

const disjoint = (a: PixelBounds, b: PixelBounds) =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

const unionPx = (a: PixelBounds | null, b: PixelBounds): PixelBounds => {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y
  };
};

type Cut = { canvas: HTMLCanvasElement; rect: Region };

// Groups the windowed runs among `members` (in order) into batches of pairwise disjoint windows whose union stays
// under `maxPixels`; a run that rasterizeWindowed would not window (unbounded, filtered, empty, missed, too large) is
// left out. Only batches of two or more are kept. Exported for tests.
export function planBatches<K>(
  members: Iterable<[K, BatchMember]>,
  full: Region,
  width: number,
  height: number,
  maxPixels = BATCH_MAX_PIXELS
): Planned<K>[][] {
  const batches: { items: Planned<K>[]; px: PixelBounds | null }[] = [];
  for (const [key, member] of members) {
    const box = member.bounds;
    if (!box || box.x1 <= box.x0 || box.y1 <= box.y0) continue;
    const window = gridWindow(full, width, height, box, WINDOW_PAD_PX);
    if (!window || window.px.width * window.px.height >= WINDOW_MAX_SHARE * width * height) continue;
    if (reachesFilter(member.clones)) continue;
    const item = { key, member, window };
    let placed = false;
    for (const batch of batches) {
      const merged = unionPx(batch.px, window.px);
      if (merged.width * merged.height > maxPixels) continue;
      if (!batch.items.every(other => disjoint(other.window.px, window.px))) continue;
      batch.items.push(item);
      batch.px = merged;
      placed = true;
      break;
    }
    if (!placed) batches.push({ items: [item], px: { ...window.px } });
  }
  return batches.filter(batch => batch.items.length > 1).map(batch => batch.items);
}

// Cuts planned batches on demand: take(key) resolves to the run's windowed raster from its batch's shared decode
// (null never: a run without ink falls back), or undefined when the run is not batched or fell back (the caller cuts it
// with rasterizeWindowed). The first take of a member decodes its whole batch; results are handed out once.
export class WindowBatches<K> {
  private readonly batchOf = new Map<K, number>();
  private readonly planned: Planned<K>[][];
  private readonly results: (Promise<Map<K, Cut>> | null)[];

  constructor(
    private readonly args: {
      clone: SVGSVGElement;
      full: Region;
      width: number;
      height: number;
      cssScale: number;
      stats?: WindowStats;
    },
    members: Iterable<[K, BatchMember]>,
    maxPixels = BATCH_MAX_PIXELS
  ) {
    const batches = windowMode() === "on" ? planBatches(members, args.full, args.width, args.height, maxPixels) : [];
    this.planned = batches;
    batches.forEach((batch, i) => {
      for (const item of batch) this.batchOf.set(item.key, i);
    });
    this.results = batches.map(() => null);
  }

  get size(): number {
    return this.batchOf.size;
  }

  async take(key: K): Promise<Cut | undefined> {
    const index = this.batchOf.get(key);
    if (index === undefined) return undefined;
    this.batchOf.delete(key);
    this.results[index] ??= this.cut(this.planned[index]);
    const results = await this.results[index];
    const result = results.get(key);
    results.delete(key);
    return result;
  }

  // Frees every cut no take collected (the caller gave up on the remaining runs).
  async dispose(): Promise<void> {
    this.batchOf.clear();
    for (const pending of this.results) {
      if (!pending) continue;
      const results = await pending.catch(() => new Map<K, Cut>());
      for (const { canvas } of results.values()) canvas.width = canvas.height = 0;
      results.clear();
    }
  }

  private async cut(batch: Planned<K>[]): Promise<Map<K, Cut>> {
    const { clone, full, width, height, cssScale, stats } = this.args;
    const out = new Map<K, Cut>();
    // a member no longer in the clone (refreshOverlays rewrites it) is cut on its own
    const items = batch.filter(item => item.member.clones.every(element => clone.contains(element)));
    if (items.length < 2) return out;
    let px: PixelBounds | null = null;
    for (const item of items) px = unionPx(px, item.window.px);
    const union = px!;
    const region = cropRegion(full, width, height, union);
    const elements = items.flatMap(item => item.member.clones);
    const live = items.every(item => item.member.live?.length === item.member.clones.length)
      ? items.flatMap(item => [...item.member.live!])
      : undefined;
    const started = performance.now();
    const canvas = await rasterizeRun(clone, elements, region, union.width, union.height, false, cssScale, live);
    const scanned = performance.now();
    if (stats) {
      stats.decodeMs += Math.round((scanned - started) * 10) / 10;
      stats.batches++;
      stats.pixels += union.width * union.height;
    }
    try {
      const context = canvas.getContext("2d");
      if (!context) return out;
      const found: { item: Planned<K>; ink: PixelBounds }[] = [];
      for (const item of items) {
        const { px: window } = item.window;
        const [x, y] = [window.x - union.x, window.y - union.y];
        const ink = alphaBounds(
          context.getImageData(x, y, window.width, window.height).data,
          window.width,
          window.height
        );
        // no ink: rasterizeWindowed decides (an empty window is cut again over the full region)
        if (!ink) continue;
        // ink on an open edge: this run may continue into a neighbour's window, so no window of the batch is trusted
        if (touchesOpenEdge(ink, window.width, window.height, item.window.open)) {
          for (const { canvas: cut } of out.values()) cut.width = cut.height = 0;
          out.clear();
          return out;
        }
        found.push({ item, ink });
      }
      for (const { item, ink } of found) {
        const { px: window } = item.window;
        const kept = padBounds(ink, 1, window.width, window.height);
        const cropped = document.createElement("canvas");
        cropped.width = kept.width;
        cropped.height = kept.height;
        const target = cropped.getContext("2d");
        if (!target) throw new Error("Canvas2D unavailable");
        target.drawImage(
          canvas,
          window.x - union.x + kept.x,
          window.y - union.y + kept.y,
          kept.width,
          kept.height,
          0,
          0,
          kept.width,
          kept.height
        );
        out.set(item.key, { canvas: cropped, rect: cropRegion(item.window.region, window.width, window.height, kept) });
        if (stats) {
          stats.window++;
          stats.batched++;
          stats.fullPixels += width * height;
        }
      }
      return out;
    } finally {
      canvas.width = canvas.height = 0;
      if (stats) stats.scanMs += Math.round((performance.now() - scanned) * 10) / 10;
    }
  }
}
