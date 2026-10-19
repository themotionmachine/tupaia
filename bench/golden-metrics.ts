// Per-cell math and verdict for the per-layer golden runner (bench/host/layer-golden.ts). No I/O, no DOM.
//
// A cell is one (preset, dpr, layer family, k) capture: the SVG arm (reference), the GPU arm (candidate) and a blank
// (every layer hidden, canvas hidden) of the same page, all at device resolution. D1 (PHASE1-PLAN.md): the layer is
// judged on its own, SVG against GPU of the same build, with the PROOF-PLAN §4 thresholds as written:
//   SSIM ≥ 0.95, over16 ≤ 1 %, and "≤ 0.5 % of pixels at Δ ≤ 44".
// The last clause has two readings (P2-FIDELITY-MEASUREMENT.md §1):
//   - "over44" (default): at most 0.5 % of pixels differ by more than 44;
//   - "conservative": changed (Δ > 0) ≤ 0.5 % AND maxDelta ≤ 44.
// Both are always reported; `reading` picks the one that gates. Choosing the reading is Ryan's call.
// A layer that paints nothing in either arm fails ("empty layer is a failure, not a pass").
import { GATES, type Rgba, rgbDiff, ssim } from "./fidelity-metrics.ts";

export const D1 = {
  ssimMin: GATES.ssimMin,
  over16Max: GATES.over16Max,
  over44Max: GATES.referenceChangedMax,
  conservativeChangedMax: GATES.referenceChangedMax,
  conservativeMaxDelta: GATES.referenceMaxDelta
} as const;

export type Reading = "over44" | "conservative";
// Fewer differing pixels than this against the blank means the arm painted nothing.
export const MIN_INK_PIXELS = 4;

export interface CellMetrics {
  width: number;
  height: number;
  ssim: number;
  minSsim: number;
  changedFraction: number;
  over16Fraction: number;
  over44Fraction: number;
  maxDelta: number;
  meanMaxChannelDelta: number;
  // pixels that differ from the blank in each arm, and in either
  inkSvg: number;
  inkGpu: number;
  inkUnion: number;
  // diagnostics normalised by the layer's own footprint (not gated: D1 gates whole-frame fractions)
  over16OfInk: number;
  over44OfInk: number;
}

const delta = (a: ArrayLike<number>, b: ArrayLike<number>, i: number) =>
  Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));

// `blank` is the SVG arm with every layer hidden; `gpuBlank` the GPU arm's (defaults to the same image).
export function measureCell(svg: Rgba, gpu: Rgba, blank: Rgba, gpuBlank: Rgba = blank): CellMetrics {
  const diff = rgbDiff(svg, gpu); // validates both (size, 8-bit, opaque)
  const s = ssim(svg, gpu);
  for (const b of [blank, gpuBlank]) if (b.width !== svg.width || b.height !== svg.height) throw new Error("blank size differs from the cell");
  let inkSvg = 0;
  let inkGpu = 0;
  let inkUnion = 0;
  for (let i = 0; i < svg.data.length; i += 4) {
    const a = delta(svg.data, blank.data, i) > 0;
    const b = delta(gpu.data, gpuBlank.data, i) > 0;
    if (a) inkSvg++;
    if (b) inkGpu++;
    if (a || b) inkUnion++;
  }
  return {
    width: diff.width,
    height: diff.height,
    ssim: s.ssim,
    minSsim: s.minSsim,
    changedFraction: diff.changedFraction,
    over16Fraction: diff.over16Fraction,
    over44Fraction: diff.over44Fraction,
    maxDelta: diff.maxDelta,
    meanMaxChannelDelta: diff.meanMaxChannelDelta,
    inkSvg,
    inkGpu,
    inkUnion,
    over16OfInk: inkUnion ? diff.over16 / inkUnion : 0,
    over44OfInk: inkUnion ? diff.over44 / inkUnion : 0
  };
}

export interface CensusCounts {
  native: number;
  compat: number;
  skipped: number;
}

export interface CellInput {
  metrics: CellMetrics;
  // what the GPU scene routed for this family (null when the renderer reported nothing for it)
  census: CensusCounts | null;
  domDrawables: number; // visible drawable SVG elements in the family (SVG arm)
  expected?: CensusCounts | null; // optional census expectation for this cell
}

export interface CellVerdict {
  pass: boolean;
  failures: string[];
  gates: { ssim: boolean; over16: boolean; over44: boolean; conservative: boolean; populated: boolean; census: boolean };
}

const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

export function judgeCell(input: CellInput, reading: Reading = "over44"): CellVerdict {
  const m = input.metrics;
  for (const v of [m.ssim, m.over16Fraction, m.over44Fraction, m.changedFraction]) if (!Number.isFinite(v)) throw new Error("non-finite metric");
  const failures: string[] = [];
  const routed = input.census ? input.census.native + input.census.compat : 0;
  const svgEmpty = m.inkSvg < MIN_INK_PIXELS || input.domDrawables === 0;
  const gpuEmpty = m.inkGpu < MIN_INK_PIXELS || routed === 0;
  if (svgEmpty) failures.push(`empty in SVG arm (ink ${m.inkSvg} px, ${input.domDrawables} drawables)`);
  if (gpuEmpty) failures.push(`empty in GPU arm (ink ${m.inkGpu} px, ${routed} routed)`);
  const gates = {
    ssim: m.ssim >= D1.ssimMin,
    over16: m.over16Fraction <= D1.over16Max,
    over44: m.over44Fraction <= D1.over44Max,
    conservative: m.changedFraction <= D1.conservativeChangedMax && m.maxDelta <= D1.conservativeMaxDelta,
    populated: !svgEmpty && !gpuEmpty,
    census: true
  };
  if (!gates.ssim) failures.push(`ssim ${m.ssim.toFixed(4)} < ${D1.ssimMin}`);
  if (!gates.over16) failures.push(`over16 ${pct(m.over16Fraction)} > ${pct(D1.over16Max)}`);
  if (reading === "over44" && !gates.over44) failures.push(`over44 ${pct(m.over44Fraction)} > ${pct(D1.over44Max)}`);
  if (reading === "conservative" && !gates.conservative)
    failures.push(`conservative: changed ${pct(m.changedFraction)} (max ${pct(D1.conservativeChangedMax)}), maxDelta ${m.maxDelta} (max ${D1.conservativeMaxDelta})`);
  if (input.expected) {
    const drift = censusDrift(input.expected, input.census);
    if (drift.length) {
      gates.census = false;
      failures.push(`census changed: ${drift.join(", ")}`);
    }
  }
  return { pass: failures.length === 0, failures, gates };
}

export function censusDrift(expected: CensusCounts, observed: CensusCounts | null): string[] {
  const out: string[] = [];
  for (const key of ["native", "compat", "skipped"] as const) {
    const was = expected[key];
    const now = observed?.[key] ?? 0;
    if (was !== now) out.push(`${key} ${was}→${now}`);
  }
  return out;
}

// Diff heatmap at capture resolution: unchanged pixels show the SVG arm faded to 25 % (for context), 0 < Δ ≤ 16 light
// blue, 16 < Δ ≤ 44 orange, Δ > 44 red.
export function heatmap(svg: Rgba, gpu: Rgba): Rgba {
  if (svg.width !== gpu.width || svg.height !== gpu.height) throw new Error("heatmap size mismatch");
  const data = new Uint8Array(svg.width * svg.height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const d = delta(svg.data, gpu.data, i);
    let rgb: [number, number, number];
    if (d > 44) rgb = [220, 20, 20];
    else if (d > 16) rgb = [255, 150, 0];
    else if (d > 0) rgb = [120, 180, 255];
    else {
      const y = 0.299 * svg.data[i] + 0.587 * svg.data[i + 1] + 0.114 * svg.data[i + 2];
      const v = Math.round(255 - (255 - y) * 0.25);
      rgb = [v, v, v];
    }
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = 255;
  }
  return { width: svg.width, height: svg.height, data };
}
