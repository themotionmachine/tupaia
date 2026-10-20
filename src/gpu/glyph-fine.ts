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
import { DETAIL_RESERVE, GPU_BUDGET } from "./budget";
import type { GpuDevice, TrackedBuffer, TrackedTexture } from "./device";
import type { Frame } from "./framegraph";
import type { Prepared } from "./prepare";
import { GLYPH_ATLAS, GLYPH_FLOATS, GlyphAtlas, glyphAtlasRows, layoutLabels } from "./text";

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

const owners = new WeakSet<Prepared>();
const cuts = new WeakMap<Prepared, number>();

function dropFine(frame: Frame, device: GpuDevice): void {
  device.release(frame.fineGlyphs);
  device.release(frame.fineAtlas);
  frame.fineGlyphs = frame.fineAtlas = null;
  frame.fineScale = 0;
}

// The frame's fine resources die with it: wrap its release once (prepare.ts owns the rest of the frame's resources).
function own(prepared: Prepared, device: GpuDevice): void {
  if (owners.has(prepared)) return;
  owners.add(prepared);
  const base = prepared.release;
  prepared.release = () => {
    dropFine(prepared.frame, device);
    base();
  };
}

export type FineOutcome = "cut" | "current" | "none" | "stale" | "budget" | `mismatch ${string}` | `failed ${string}`;

// Re-cut the frame's native labels at `scale` device px per world unit. `stale()` is polled after every await; a newer
// call for the same frame supersedes this one. The fine set replaces the previous one only when complete.
export async function refineGlyphs(
  prepared: Prepared,
  device: GpuDevice,
  scale: number,
  stale: () => boolean
): Promise<FineOutcome> {
  if (!wantsFineGlyphs(prepared, scale)) {
    // at the bucket (or with no labels) the bucket set is exact: free a fine set cut for another scale
    if (prepared.frame.fineScale && !same(prepared.frame.fineScale, scale)) dropFine(prepared.frame, device);
    return prepared.frame.fineGlyphs ? "current" : "none";
  }
  const token = (cuts.get(prepared) ?? 0) + 1;
  cuts.set(prepared, token);
  const outcome = await cut(prepared, device, scale, () => cuts.get(prepared) !== token || stale() || device.lost);
  // a fine set for another scale is never drawn again: free it unless a newer cut owns the frame now
  if (outcome !== "cut" && outcome !== "stale" && prepared.frame.fineScale && !same(prepared.frame.fineScale, scale))
    dropFine(prepared.frame, device);
  return outcome;
}

async function cut(prepared: Prepared, device: GpuDevice, scale: number, stale: () => boolean): Promise<FineOutcome> {
  const labels = prepared.glyphLabels!;
  const { glyphs: bucketGlyphs, glyphCount } = prepared.payload;
  const bucketRows = glyphAtlasRows(bucketGlyphs, glyphCount);
  let atlas: GlyphAtlas | null = null;
  let data: Float32Array | null = null;
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
      const batch = await layoutLabels([label.element], scale, atlas);
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
  prepared.frame.fineGlyphs = buffer;
  prepared.frame.fineAtlas = texture;
  prepared.frame.fineScale = scale;
  return "cut";
}
