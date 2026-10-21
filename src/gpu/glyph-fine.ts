// GLYPHZ (W4a): label glyphs re-cut at the settled camera's exact device scale.
//
// A prepare cuts every glyph at the raster bucket, the power of two at or above k * dpr (raster.ts scaleBucket), so
// zooming within a bucket reuses the atlas. Between powers of two that mask is shown minified (up to 2x), where Skia
// rasterizes each glyph at its exact size: stems land on different pixels, and an unrotated glyph's baseline is no
// longer on a whole device row (the shader's rowSnap needs one texel per device px). Fresh frames at k 1.1-1.9 missed
// the D11 coverage cap on the labels layer (over16 22-37% of the layer's ink, W3b GLYPH2 freshD11).
//
// On settle the renderer re-lays out the frame's native labels (Prepared.glyphLabels) at k * dpr into a fine atlas of
// their own and uploads it beside the bucket set. Every label must lay out to the same instance count, so the frame's
// glyph batches (first, count) index both sets alike; any difference (a label that would now route to compat, an atlas
// that does not fit) keeps the bucket set. The framegraph draws the fine set only while the camera is at its scale
// (fineGlyphsAt), so a gesture shows the bucket set (minified, never magnified) until the next settle re-cuts.
// Only between powers of two: at a bucket the bucket set is already exact, and above the bucket cap (k * dpr > 16) the
// glyphs would outgrow the atlas, so those keep the bucket set.
//
// GLYPH3 (W4b): the placed cut. Even at the exact scale a glyph cell is cut axis-aligned at sub-pixel phase 0 and
// resampled at the glyph's angle and pen phase, where Skia rasterizes each SVG glyph in place (PHASE1-PLAN D14: the
// rotated state labels at k 1 missed the D11 coverage cap, 23.7% over16 of the labels' ink on parity's native variant,
// 25.4% under cyberpunk). After the scale step, the settle lays out again the native labels that reach the view, for
// their glyph places only (text.ts GlyphPlace, a measuring atlas), and cuts every glyph that reaches the view into a
// placed atlas (text.ts PlacedGlyphAtlas) at its rotation and device position: a device-aligned cell drawn texel for
// pixel. The frame then draws a copy of the glyph instances it draws at this scale (fine or bucket) with those
// glyphs swapped for their placed cells, the placed atlas bound beside the set's own. Keyed by the whole camera (a
// pan moves the sub-pixel phase and the view): a settle elsewhere cuts again; a gesture at the same scale keeps the
// cells, resampled at their new phase, and one at another scale draws the set beneath.
import { DETAIL_RESERVE, GPU_BUDGET } from "./budget";
import type { GpuDevice, TrackedBuffer, TrackedTexture } from "./device";
import type { Frame } from "./framegraph";
import type { Prepared } from "./prepare";
import {
  GLYPH_ATLAS,
  GLYPH_FLOATS,
  GlyphAtlas,
  type GlyphPlace,
  glyphAtlasRows,
  layoutLabels,
  PlacedGlyphAtlas,
  placedInstance,
  placePen
} from "./text";

// relative scale match: the glyph shader's rowSnap allows 1e-3 of a cell's texels, so this is well inside it
const SCALE_MATCH = 1e-4;
// extra fine-atlas rows over the bucket set's (the fine cells are smaller; a shelf can still break differently)
const ROW_SLACK = 64;
// main-thread slice between yields while laying out (ms)
const SLICE_MS = 8;

const same = (a: number, b: number) => Math.abs(a / b - 1) < SCALE_MATCH;

// The fine set the framegraph draws at device scale `scale` (k * dpr), or null for the bucket set.
export function fineGlyphsAt(
  frame: Pick<Frame, "fineGlyphs" | "fineAtlas" | "fineScale">,
  scale: number
): { glyphs: TrackedBuffer; atlas: TrackedTexture } | null {
  const { fineGlyphs, fineAtlas, fineScale } = frame;
  if (!fineGlyphs || !fineAtlas || !fineScale || !(scale > 0) || !same(fineScale, scale)) return null;
  return { glyphs: fineGlyphs, atlas: fineAtlas };
}

// Whether a settle at device scale `scale` would re-cut: the frame has native labels, the scale is strictly between
// powers of two below the bucket, and the fine set on the frame is for another scale.
export function wantsFineGlyphs(
  prepared: Pick<Prepared, "bucket" | "frame" | "glyphLabels" | "payload">,
  scale: number
): boolean {
  if (!prepared.glyphLabels?.length || !prepared.payload.glyphCount) return false;
  if (!(scale > 0) || scale >= prepared.bucket || same(scale, prepared.bucket)) return false;
  return !(prepared.frame.fineScale && prepared.frame.fineGlyphs && same(prepared.frame.fineScale, scale));
}

// The camera a settle refines for: CSS px = world * k + (x, y), a CSS viewport of width x height at dpr.
export interface GlyphCamera {
  x: number;
  y: number;
  k: number;
  dpr: number;
  width: number;
  height: number;
}

// The placed set the framegraph draws at device scale `scale` (it sits on the set drawn at that scale: dropFine drops
// it with the fine set it copies), or null.
export function placedGlyphsAt(
  frame: Pick<Frame, "placedGlyphs" | "placedAtlas" | "placedScale">,
  scale: number
): { glyphs: TrackedBuffer; atlas: TrackedTexture } | null {
  const { placedGlyphs, placedAtlas, placedScale } = frame;
  if (!placedGlyphs || !placedAtlas || !placedScale || !(scale > 0) || !same(placedScale, scale)) return null;
  return { glyphs: placedGlyphs, atlas: placedAtlas };
}

// The placed cut's key: the glyph set it copies, the camera to the bit (a pan moves every pen's phase) and the view.
function placedKey(base: "fine" | "bucket", camera: GlyphCamera): string {
  return `${base} ${camera.k} ${camera.x} ${camera.y} ${camera.width}x${camera.height}@${camera.dpr}`;
}

// Whether a settle at `camera` would cut placed glyphs: the frame has native labels and no placed cut for this camera
// over the set it will draw (the fine set when the scale step keeps or cuts one).
export function wantsPlacedGlyphs(
  prepared: Pick<Prepared, "bucket" | "frame" | "glyphLabels" | "payload">,
  camera: GlyphCamera
): boolean {
  const scale = camera.k * camera.dpr;
  if (!prepared.glyphLabels?.length || !prepared.payload.glyphCount || !(scale > 0)) return false;
  const fine = wantsFineGlyphs(prepared, scale) || !!fineGlyphsAt(prepared.frame, scale);
  return prepared.frame.placedKey !== placedKey(fine ? "fine" : "bucket", camera);
}

// Whether the settle has glyph work: a fine set to cut or free, or a placed cut.
export function glyphRefineWanted(
  prepared: Pick<Prepared, "bucket" | "frame" | "glyphLabels" | "payload">,
  camera: GlyphCamera
): boolean {
  const scale = camera.k * camera.dpr;
  return (
    wantsFineGlyphs(prepared, scale) ||
    (!!prepared.frame.fineGlyphs && !fineGlyphsAt(prepared.frame, scale)) ||
    wantsPlacedGlyphs(prepared, camera)
  );
}

const owners = new WeakSet<Prepared>();
const cuts = new WeakMap<Prepared, number>();
// the fine set's instances on the CPU (a placed cut copies the set it sits on)
const fineData = new WeakMap<Frame, Float32Array>();
// Each label's glyph places at one scale (null: it laid out differently from the frame's instances), by its first
// instance. Places depend on the scale only, not on the camera's translation, so a pan settle lays nothing out again;
// the fine cut records them as it lays out. A new revision is a new Prepared.
const placeCache = new WeakMap<Prepared, { scale: number; labels: Map<number, (GlyphPlace | null)[] | null> }>();

function cachedPlaces(prepared: Prepared, scale: number): Map<number, (GlyphPlace | null)[] | null> {
  const cached = placeCache.get(prepared);
  if (cached && same(cached.scale, scale)) return cached.labels;
  const labels = new Map<number, (GlyphPlace | null)[] | null>();
  placeCache.set(prepared, { scale, labels });
  return labels;
}

function dropPlaced(frame: Frame, device: GpuDevice): void {
  device.release(frame.placedGlyphs);
  device.release(frame.placedAtlas);
  frame.placedGlyphs = frame.placedAtlas = null;
  frame.placedScale = 0;
  frame.placedKey = undefined;
}

function dropFine(frame: Frame, device: GpuDevice): void {
  device.release(frame.fineGlyphs);
  device.release(frame.fineAtlas);
  frame.fineGlyphs = frame.fineAtlas = null;
  frame.fineScale = 0;
  fineData.delete(frame);
  // a placed set copies the instances of the set it sits on
  dropPlaced(frame, device);
}

// The frame's fine resources die with it: wrap its release once (prepare.ts owns the rest of the frame's resources).
function own(prepared: Prepared, device: GpuDevice): void {
  if (owners.has(prepared)) return;
  owners.add(prepared);
  const base = prepared.release;
  prepared.release = () => {
    dropFine(prepared.frame, device);
    dropPlaced(prepared.frame, device);
    base();
  };
}

export type FineOutcome = "cut" | "current" | "none" | "stale" | "budget" | `mismatch ${string}` | `failed ${string}`;

// The settle's glyph work at `camera`: the scale step (fine set), then the placed cut over whichever set the frame
// then draws. `stale()` is polled after every await; a newer call for the same frame supersedes this one. Each set
// replaces the previous one only when complete. Returns "<scale step> placed <placed step>".
export async function refineGlyphs(
  prepared: Prepared,
  device: GpuDevice,
  camera: GlyphCamera,
  stale: () => boolean
): Promise<string> {
  const scale = camera.k * camera.dpr;
  const token = (cuts.get(prepared) ?? 0) + 1;
  cuts.set(prepared, token);
  const superseded = () => cuts.get(prepared) !== token || stale() || device.lost;
  let fine: FineOutcome;
  if (!wantsFineGlyphs(prepared, scale)) {
    // at the bucket (or with no labels) the bucket set is exact: free a fine set cut for another scale
    if (prepared.frame.fineScale && !same(prepared.frame.fineScale, scale)) dropFine(prepared.frame, device);
    fine = prepared.frame.fineGlyphs ? "current" : "none";
  } else {
    fine = await cut(prepared, device, scale, superseded);
    // a fine set for another scale is never drawn again: free it unless a newer cut owns the frame now
    if (fine !== "cut" && fine !== "stale" && prepared.frame.fineScale && !same(prepared.frame.fineScale, scale))
      dropFine(prepared.frame, device);
  }
  if (fine === "stale") return "stale";
  const placed = wantsPlacedGlyphs(prepared, camera)
    ? await cutPlaced(prepared, device, camera, superseded)
    : "current";
  return `${fine} placed ${placed}`;
}

// How far (world units) a glyph instance's quad can reach from its anchor, at any rotation.
function reaches(data: Float32Array, i: number): number {
  const o = i * GLYPH_FLOATS;
  return Math.abs(data[o + 3]) + Math.abs(data[o + 4]) + data[o + 5] + data[o + 6];
}

let placeMeasure: CanvasRenderingContext2D | null | undefined;

async function cutPlaced(
  prepared: Prepared,
  device: GpuDevice,
  camera: GlyphCamera,
  stale: () => boolean
): Promise<string> {
  const frame = prepared.frame;
  const scale = camera.k * camera.dpr;
  const fine = !!fineGlyphsAt(frame, scale);
  const base = fine ? fineData.get(frame) : prepared.payload.glyphs;
  const count = prepared.payload.glyphCount;
  if (!base || base.length < count * GLYPH_FLOATS) return "failed no base instances";
  placeMeasure ??= document.createElement("canvas").getContext("2d");
  if (!placeMeasure) return "failed no canvas";
  const key = placedKey(fine ? "fine" : "bucket", camera);
  const view = { width: Math.round(camera.width * camera.dpr), height: Math.round(camera.height * camera.dpr) };
  const cache = cachedPlaces(prepared, scale);
  let measuring: GlyphAtlas | null = null;
  const atlas = new PlacedGlyphAtlas(placeMeasure);
  const swaps: [number, ReturnType<PlacedGlyphAtlas["add"]>][] = [];
  let [skipped, full] = [0, 0];
  let slice = performance.now();
  for (const label of prepared.glyphLabels!) {
    // only labels with an instance that can reach the view are laid out again
    let near = false;
    for (let i = label.first; i < label.first + label.count && !near; i++) {
      const o = i * GLYPH_FLOATS;
      const reach = reaches(base, i) * scale + 4;
      const dx = (base[o] * camera.k + camera.x) * camera.dpr;
      const dy = (base[o + 1] * camera.k + camera.y) * camera.dpr;
      near = dx > -reach && dy > -reach && dx < view.width + reach && dy < view.height + reach;
    }
    if (!near) continue;
    if (performance.now() - slice > SLICE_MS) {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (stale()) return "stale";
      slice = performance.now();
    }
    let places = cache.get(label.first);
    if (places === undefined) {
      // laid out for its places only: a measuring atlas cuts no cell
      measuring ??= new GlyphAtlas(1, false);
      const laid: (GlyphPlace | null)[] = [];
      const batch = await layoutLabels([label.element], scale, measuring, laid);
      if (stale()) return "stale";
      places = !batch.failed.length && batch.count === label.count && laid.length === label.count ? laid : null;
      cache.set(label.first, places);
    }
    // a label that lays out differently now keeps its cells (the instances it would replace are not its glyphs)
    if (!places) {
      skipped++;
      continue;
    }
    for (const [j, place] of places.entries()) {
      if (!place) continue;
      const cell = atlas.add(place, placePen(place, camera), view);
      if (cell) swaps.push([label.first + j, cell]);
      else if (atlas.rows >= GLYPH_ATLAS - 1) full++;
    }
  }
  if (!swaps.length) {
    dropPlaced(frame, device);
    frame.placedKey = key; // nothing to place in this view: do not lay out again until the camera moves
    return skipped ? `none (${skipped} labels laid out differently)` : "none";
  }
  if (!atlas.paintAll()) return "failed no canvas";
  const data = new Float32Array(base.subarray(0, count * GLYPH_FLOATS));
  for (const [index, cell] of swaps) {
    const o = index * GLYPH_FLOATS;
    placedInstance(cell!, camera, base.subarray(o + 11, o + 15), data, o);
  }
  const rows = Math.max(1, Math.min(GLYPH_ATLAS, atlas.rows));
  const bytes = GLYPH_ATLAS * rows * 4 + data.byteLength;
  const held = (frame.placedGlyphs?.bytes ?? 0) + (frame.placedAtlas?.bytes ?? 0);
  if (device.memory().total - held + bytes > GPU_BUDGET - DETAIL_RESERVE) {
    atlas.release();
    return "budget";
  }
  let texture: TrackedTexture | null = null;
  let buffer: TrackedBuffer | null = null;
  try {
    texture = device.texture("glyph atlas (placed)", atlas.canvas!, { rows });
    buffer = device.buffer("glyphs (placed)", data);
  } catch (error) {
    device.release(texture);
    device.release(buffer);
    return `failed ${String(error).slice(0, 120)}`;
  } finally {
    atlas.release();
  }
  own(prepared, device);
  dropPlaced(frame, device);
  frame.placedGlyphs = buffer;
  frame.placedAtlas = texture;
  frame.placedScale = scale;
  frame.placedKey = key;
  const notes = [skipped && `${skipped} labels laid out differently`, full && `${full} glyphs past a full atlas`];
  const note = notes.filter(Boolean).join(", ");
  return `cut ${swaps.length}${note ? ` (${note})` : ""}`;
}

async function cut(prepared: Prepared, device: GpuDevice, scale: number, stale: () => boolean): Promise<FineOutcome> {
  const labels = prepared.glyphLabels!;
  const { glyphs: bucketGlyphs, glyphCount } = prepared.payload;
  const bucketRows = glyphAtlasRows(bucketGlyphs, glyphCount);
  let atlas: GlyphAtlas | null = null;
  let data: Float32Array | null = null;
  const placed = new Map<number, (GlyphPlace | null)[] | null>();
  // first in a fine atlas about the bucket set's height, then once more in a full one if that filled up
  for (const rows of [Math.min(GLYPH_ATLAS, bucketRows + ROW_SLACK), GLYPH_ATLAS]) {
    atlas = new GlyphAtlas(rows);
    data = new Float32Array(glyphCount * GLYPH_FLOATS);
    let full = false;
    let slice = performance.now();
    for (const label of labels) {
      // a re-cut lays out every label (35-40 ms on the shared map): yield between slices so a gesture that starts
      // meanwhile gets the main thread (and supersedes the cut through stale())
      if (performance.now() - slice > SLICE_MS) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (stale()) return "stale";
        slice = performance.now();
      }
      const places: (GlyphPlace | null)[] = [];
      const batch = await layoutLabels([label.element], scale, atlas, places);
      if (stale()) return "stale";
      const reason = batch.failed[0]?.reason;
      if (reason === "glyph atlas full") {
        full = true;
        break;
      }
      if (reason) return `mismatch ${label.element.id || "label"}: ${reason}`;
      if (batch.count !== label.count)
        return `mismatch ${label.element.id || "label"}: ${batch.count} instances, bucket ${label.count}`;
      data.set(batch.instances, label.first * GLYPH_FLOATS);
      placed.set(label.first, places.length === label.count ? places : null);
    }
    if (!full) break;
    if (rows === GLYPH_ATLAS) return "failed glyph atlas full";
  }
  if (!atlas || !data) return "failed no atlas";
  const rows = Math.min(atlas.canvas.height, glyphAtlasRows(data, glyphCount));
  const bytes = atlas.canvas.width * rows * 4 + data.byteLength;
  // the same steady headroom the compat refinement keeps (renderer.ts settle)
  if (device.memory().total + bytes > GPU_BUDGET - DETAIL_RESERVE) return "budget";
  let texture: TrackedTexture | null = null;
  let buffer: TrackedBuffer | null = null;
  try {
    texture = device.texture("glyph atlas (fine)", atlas.canvas, { rows });
    buffer = device.buffer("glyphs (fine)", data);
  } catch (error) {
    device.release(texture);
    device.release(buffer);
    return `failed ${String(error).slice(0, 120)}`;
  } finally {
    // the canvas is not needed once uploaded (a context loss drops the fine set; the next settle re-cuts)
    atlas.canvas.width = atlas.canvas.height = 0;
  }
  own(prepared, device);
  dropFine(prepared.frame, device);
  fineData.set(prepared.frame, data);
  const cache = cachedPlaces(prepared, scale);
  for (const [first, places] of placed) cache.set(first, places);
  prepared.frame.fineGlyphs = buffer;
  prepared.frame.fineAtlas = texture;
  prepared.frame.fineScale = scale;
  return "cut";
}
