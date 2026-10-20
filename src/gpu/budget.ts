// GPU memory policy. All figures are the device's tracked allocation estimate (bytes this renderer uploaded or
// allocated, mipmaps and MSAA included), not measured process GPU usage.
import type { Region } from "./compat";

export const GPU_BUDGET = 160 << 20; // steady-state target for everything the renderer tracks
export const TARGET_BUDGET = 80 << 20; // offscreen group target (MSAA colour + depth/stencil + resolve texture)
export const MIN_COMPAT_BUDGET = 16 << 20; // least useful world compat share; below it the frame fails to SVG
export const PEAK_LIMIT = 256 << 20; // transient ceiling while a replacement set coexists with the one it replaces
export const DETAIL_RESERVE = 8 << 20; // steady headroom settle-time detail leaves for window refreshes
// prepare-time details of sharp runs (labels, icons, markers) for the first frame: at most this, within the steady room
export const FIRST_DETAIL_BUDGET = 32 << 20;
// Room world rasters leave the view's sharp-run detail when zoomed past their base resolution (prepare detailShare).
export const DETAIL_SHARE = 48 << 20;
// Wall time the first frame's detail may add to a prepare (firstDetails): runs it has not started by then wait for the
// settle refinement. A cap on time to the first current GPU frame (D12), not on legibility.
export const FIRST_DETAIL_MS = 1500;

// Explicit steady headroom a prepare leaves unspent (RES2). What it plans is exact (the pending vertex and glyph-atlas
// estimates match the uploads byte for byte), but some steady allocations happen outside its accounting after it
// commits: a screen overlay refreshed with a larger crop (the scale bar's text at another zoom), the trade-marker
// instance buffer growing with the markers in flight, a bitmap window refresh beside a detail. Before, the steady
// share ended exactly at GPU_BUDGET with the resident renderer textures uncounted, and the dense parity world at k 1
// held 160.64 MiB.
export const STEADY_SLACK = 2 << 20;

// What a prepare sets aside from the steady budget before its own share: the group target this backing store gets
// (targetReserve), the resident allocations no frame owns (trade-marker sprite textures, about 0.6 MiB at DPR 2, the
// instance and unit-quad buffers: prepare.ts residentBytes) and STEADY_SLACK.
export function steadyReserve(target: number, resident: number, slack = STEADY_SLACK): number {
  return Math.max(0, target) + Math.max(0, resident) + Math.max(0, slack);
}

// Telemetry assertion: the tracked total once a frame is committed (no prepare in flight, so no old+new overlap) must
// stay within the steady budget. Returns the overrun in bytes (0 when within budget).
export function steadyOverrun(total: number, budget = GPU_BUDGET): number {
  return Math.max(0, total - budget);
}

// Bytes a bitmap window refresh may commit. The new set is allocated before the old one (`windowBytes`) is released,
// so it must fit the peak room now and, once the old set is gone, the steady budget.
export function windowAllowance(total: number, windowBytes: number, budget = GPU_BUDGET, peak = PEAK_LIMIT): number {
  return Math.max(0, Math.min(peak - total, budget - (total - windowBytes)));
}

// Compat raster bytes a prepare may still allocate: its steady share (budget minus target reserve and what the new
// frame already owns or will upload) and the peak room left beside the previous frame (`total` = tracked now).
// `reserve` is what the steady budget holds back before this frame's bytes: prepareFrame passes steadyReserve (the
// group target the framegraph allocates for this backing store, the resident allocations and STEADY_SLACK); the
// default is the flat TARGET_BUDGET of before.
export function compatAllowance(
  total: number,
  own: number,
  pending: number,
  budget = GPU_BUDGET,
  peak = PEAK_LIMIT,
  reserve = TARGET_BUDGET
): number {
  return Math.max(0, Math.min(budget - reserve - own - pending, peak - total - pending));
}

// Bytes per device px of a single-sample group's mask coverage (framegraph maskCoverage): an R8 colour attachment, red =
// luminance. It was an RGBA8 texture (W3b STROKE3) the steady share never counted: 14.06 MiB at 1280x720 DPR 2, and the
// parity replay held 163-165 MiB once a masked group first drew after a prepare that planned to 160 MiB (W3c BUDGET).
export const MASK_BYTES_PER_PIXEL = 1;

// Samples of the group target the framegraph allocates for a `width` x `height` backing store (framegraph composite):
// none by default (W3b STROKE3, canvasAntialias); with ?gpu-msaa=1, targetSamples within TARGET_BUDGET.
export function groupSamples(
  width: number,
  height: number,
  maxSamples: number,
  dpr: number,
  msaa = msaaFlag()
): number {
  return msaa ? targetSamples(width, height, maxSamples, TARGET_BUDGET, dpr) : 0;
}

// Every per-screen allocation the framegraph makes for one backing store: the group target (MSAA colour + depth/stencil +
// resolve texture, or colour texture + depth/stencil) and, for a frame with masked groups on a single-sample target, the
// mask coverage attachment beside it (it shares the target's depth/stencil). Both are tracked as targets (device.ts).
export function screenTargetBytes(width: number, height: number, samples: number, masked: boolean): number {
  return targetBytes(width, height, samples) + (masked && !samples ? width * height * MASK_BYTES_PER_PIXEL : 0);
}

// What the steady share holds back for the framegraph's per-screen targets (screenTargetBytes), sized with the same
// sample policy the framegraph uses (groupSamples), so the composite never allocates past what the prepare reserved.
// `masked`: the frame has a masked group (framegraph hasMaskedGroup); unknown callers reserve the mask. Capped at
// TARGET_BUDGET so the reserve is never larger than the flat one of before: only a backing store over about 10M device
// px (8 B/px past 80 MiB, a 5K display at DPR 2) reaches the cap, and the steady telemetry reports what it leaves out.
// At DPR 2 the target has no MSAA: 1512x982 CSS px is a 47.5 MB target, 1280x720 29.5 MB, against the flat 80 MiB the
// steady share used to set aside, which left the canonical bitmap windows of a 1512x982 world no room at load.
export function targetReserve(
  width: number,
  height: number,
  maxSamples: number,
  dpr: number,
  masked = true,
  msaa = msaaFlag()
): number {
  const [w, h] = [Math.max(1, Math.round(width)), Math.max(1, Math.round(height))];
  return Math.min(TARGET_BUDGET, screenTargetBytes(w, h, groupSamples(w, h, maxSamples, dpr, msaa), masked));
}

export interface PixelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Tight bounds of pixels with non-zero alpha in RGBA data; null when the raster is fully transparent.
export function alphaBounds(data: ArrayLike<number>, width: number, height: number): PixelBounds | null {
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    let first = -1;
    for (let x = 0; x < width; x++)
      if (data[row + x * 4 + 3]) {
        first = x;
        break;
      }
    if (first < 0) continue;
    let last = first;
    for (let x = width - 1; x > first; x--)
      if (data[row + x * 4 + 3]) {
        last = x;
        break;
      }
    if (y0 > y) y0 = y;
    y1 = y;
    if (x0 > first) x0 = first;
    if (x1 < last) x1 = last;
  }
  return y1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

// Grows bounds by `pad` transparent pixels (so linear filtering fades to zero at the edge), clamped to the raster.
export function padBounds(bounds: PixelBounds, pad: number, width: number, height: number): PixelBounds {
  const x = Math.max(0, bounds.x - pad);
  const y = Math.max(0, bounds.y - pad);
  return {
    x,
    y,
    width: Math.min(width, bounds.x + bounds.width + pad) - x,
    height: Math.min(height, bounds.y + bounds.height + pad) - y
  };
}

// World rect covered by a pixel sub-rectangle of a raster of `region` — same pixel density, no resampling.
export function cropRegion(region: Region, pixelWidth: number, pixelHeight: number, bounds: PixelBounds): Region {
  const [sx, sy] = [region.width / pixelWidth, region.height / pixelHeight];
  return {
    x: region.x + bounds.x * sx,
    y: region.y + bounds.y * sy,
    width: bounds.width * sx,
    height: bounds.height * sy
  };
}

// Indices of world `rects` ordered by their area inside `visible` (smallest first, stable on ties). Settle refinement
// is a greedy fill of the remaining budget, so refining in painter order lets large smooth fills starve sparse
// high-frequency runs (labels, icons) that lose most from the blurry base. Draw order is unaffected. Area alone misses
// sparse text/marker runs scattered across the view (their alpha bounds span it like an ocean pattern), so runs
// flagged `sharp` come first, each group smallest first.
export function refineOrder(
  rects: readonly (readonly [number, number, number, number])[],
  visible: Region,
  sharp: readonly boolean[] = []
): number[] {
  const area = rects.map(([x, y, width, height]) => {
    const w = Math.min(x + width, visible.x + visible.width) - Math.max(x, visible.x);
    const h = Math.min(y + height, visible.y + visible.height) - Math.max(y, visible.y);
    return Math.max(0, w) * Math.max(0, h);
  });
  const rank = (index: number) => (sharp[index] ? 0 : 1);
  return rects.map((_, index) => index).sort((a, b) => rank(a) - rank(b) || area[a] - area[b] || a - b);
}

// Linear downscale that brings `bytes` within `budget` (1 when it already fits).
export function fitScale(bytes: number, budget: number): number {
  return bytes <= budget ? 1 : Math.sqrt(Math.max(0, budget) / bytes);
}

export function targetBytes(width: number, height: number, samples: number): number {
  return samples ? width * height * 4 * samples * 2 + width * height * 4 : width * height * 8;
}

// Most MSAA samples (4, 2, else none) whose target fits the budget: 1080p DPR1 keeps 4×, 1440p 2×, DPR2 laptop
// backing stores (2880×1800) none — their pixel density stands in for MSAA instead of a 100+ MiB multisampled target.
export function targetSamples(
  width: number,
  height: number,
  maxSamples: number,
  budget = TARGET_BUDGET,
  dpr = 1
): number {
  // At Retina density spend the allocation on crisp labels/markers rather than duplicate MSAA samples.
  if (dpr >= 2) return 0;
  for (const samples of [4, 2])
    if (samples <= maxSamples && targetBytes(width, height, samples) <= budget) return samples;
  return 0;
}

// The canvas's own (default) framebuffer: no MSAA at any DPR (W3b STROKE3). Hardware MSAA edges are a sample off SVG's:
// ANGLE's Metal backend samples a multisampled WebGL target at the standard 4x pattern mirrored in y (a slanted fill
// edge: 1253 of 1258 edge pixels match the mirrored pattern, SVG's 1249 the standard one;
// ~/.tupaia-gates/w3b-stroke3/exp/msaa.mjs), so at DPR 1 every MSAA fill edge differed from SVG by a sample (shared
// rivers k 1: 31.6 % of the ink over Δ16). Without it, fills take the fringe pass with SVG's own sample positions
// (shaders.ts coverage models), as at DPR 2. A 4× multisampled 2560×1440 drawing buffer was also ~118 MB outside the
// tracked budget, and its per-frame GPU cost delayed compositor-frame acks to ~13 ms on M1 Max/Metal
// (P2-TIMING-DIAGNOSIS.md). Fixed at context creation; ?gpu-msaa=1 restores 4× at DPR 1 (and on group targets) for A/B.
export function canvasAntialias(dpr = 1, msaa = msaaFlag()): boolean {
  return msaa && dpr < 2;
}
export function msaaFlag(): boolean {
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").get("gpu-msaa") === "1";
  } catch {
    return false;
  }
}

// Relief atlas cell edge: the largest icon's on-screen size at this raster bucket (power of two, 16..256), so sprites
// are sampled near 1:1 instead of minified from 256 px through blurry mip levels.
export function reliefCell(maxIconSize: number, bucket: number, max = 256): number {
  const pixels = Math.max(1, maxIconSize * bucket) + 2;
  return Math.min(max, Math.max(16, 2 ** Math.ceil(Math.log2(pixels))));
}
