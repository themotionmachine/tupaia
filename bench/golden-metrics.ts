// Per-cell math and verdict for the per-layer golden runner (bench/host/layer-golden.ts). No I/O, no DOM.
//
// A cell is one (preset, dpr, layer family, k) capture: the SVG arm (reference), the GPU arm (candidate) and a blank
// (every layer hidden, canvas hidden) of the same page, all at device resolution. D1 (PHASE1-PLAN.md): the layer is
// judged on its own, SVG against GPU of the same build, with the PROOF-PLAN §4 thresholds as written:
//   SSIM ≥ 0.95, over16 ≤ 1 %, and "≤ 0.5 % of pixels at Δ ≤ 44".
// D11 (Ryan, 2026-10-19) fixes the reading of the last clause and adds a per-layer coverage gate in the same change:
//   - "over44" (the default): at most 0.5 % of pixels differ by more than 44;
//   - "conservative" (the strict reading, still available and always reported): changed (Δ > 0) ≤ 0.5 % AND
//     maxDelta ≤ 44. It fails on invisible rounding and anti-aliasing (91 of 160 parity cells at W1);
//   - coverage (gates under BOTH readings): every whole-frame fraction above is diluted by the frame, so a small layer
//     can lose most of its ink and pass. COVERAGE (below) judges the layer against its own footprint.
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
export const DEFAULT_READING: Reading = "over44";
// Fewer differing pixels than this against the blank means the arm painted nothing.
export const MIN_INK_PIXELS = 4;
// D11 coverage gate, measured on the layer's own ink (pixels that differ from the blank in either arm), not the frame.
//   ink:    min(inkSvg, inkGpu) ≥ inkRatioMin × max(inkSvg, inkGpu) − slackPx
//           Symmetric: the GPU may neither lose more than 10 % of the layer's ink (thin strokes, dropped icons) nor
//           paint more than ~11 % extra (heavier strokes, a filter spread wider).
//   over16: over16 pixels ≤ over16OfInkMax × inkUnion + slackPx
//           At most one in five of the layer's own ink pixels may differ visibly (Δ > 16).
// slackPx is the tiny-layer guard, in device pixels: 16 px is a 2×2 CSS-px dot at dpr 2. It is negligible for any
// real layer (the smallest parity layer, burgs at k 8, has ~940 ink px) and stops a 30-pixel layer from failing on a
// few anti-aliased edge pixels: a 30 px layer must keep ≥ 11 px of ink and may have ≤ 22 px over Δ16.
// The numbers come from the W1 parity sweep (golden-20261019T210438-859Z, 160 cells, Metal, dpr 2):
//   - cells whose differences are rounding or anti-aliasing only (inspected: grid, ice, vignette, ocean, temperature,
//     borders k 4/8 dash and dot edges, markers k 4, rulers) have inkRatio ≥ 0.925 and over16OfInk ≤ 18.5 % (borders
//     k 4, the nearest pass);
//   - the real gaps the whole-frame gates miss all fall outside: inkRatio burgs 0.21-0.63, coordinates 0.55-0.67,
//     rivers 0.66-0.89, military 0.60/0.72, borders/routes k 1 0.83, states k 8 0.84; over16OfInk coastline k 1.6-2.5
//     30-31 % (natively stroked, heavier than the SVG), routes k 2-8 28-60 % (dash phase), labels k 1 27.6 %
//     (glyphs misregistered), markers k 1/2 30-35 % (emoji), emblems k 1/2 55-61 % (shield gradient).
// The empty gap in the evidence (18.5 % ↔ 27.6 %) is where a cap belongs; 20 % is the round number nearest the
// passing side, so the gate errs toward catching a gap. Changing these is a gate change: say so loudly.
export const COVERAGE = { inkRatioMin: 0.9, over16OfInkMax: 0.2, slackPx: 16 } as const;

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
  over16Px: number; // pixels with Δ > 16 (over16Fraction × frame)
  // normalised by the layer's own footprint (inkUnion): over16OfInk gates (COVERAGE), over44OfInk is reported
  over16OfInk: number;
  over44OfInk: number;
  // min(inkSvg, inkGpu) / max(...): 1 when both arms paint the same footprint, 0 when one is empty
  inkRatio: number;
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
    over16Px: diff.over16,
    over16OfInk: inkUnion ? diff.over16 / inkUnion : 0,
    over44OfInk: inkUnion ? diff.over44 / inkUnion : 0,
    inkRatio: Math.max(inkSvg, inkGpu) ? Math.min(inkSvg, inkGpu) / Math.max(inkSvg, inkGpu) : 0
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
  // non-gating observations (today: what the strict reading says about a cell the over44 reading passes)
  notes: string[];
  // every gate is computed and reported under either reading; `reading` picks which of over44/conservative gates.
  // coverage = coverageInk && coverageOver16 (D11), gated under both readings (an empty arm fails as empty instead).
  gates: {
    ssim: boolean;
    over16: boolean;
    over44: boolean;
    conservative: boolean;
    coverage: boolean;
    coverageInk: boolean;
    coverageOver16: boolean;
    populated: boolean;
    census: boolean;
  };
}

// D11 coverage on the layer's own ink (see COVERAGE). Pure, so the runner's report and the unit tests share it.
export function coverageOf(m: Pick<CellMetrics, "inkSvg" | "inkGpu" | "inkUnion" | "over16Px">): { ink: boolean; over16: boolean } {
  const lo = Math.min(m.inkSvg, m.inkGpu);
  const hi = Math.max(m.inkSvg, m.inkGpu);
  return {
    ink: lo >= COVERAGE.inkRatioMin * hi - COVERAGE.slackPx,
    over16: m.over16Px <= COVERAGE.over16OfInkMax * m.inkUnion + COVERAGE.slackPx
  };
}

const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

export function judgeCell(input: CellInput, reading: Reading = DEFAULT_READING): CellVerdict {
  const m = input.metrics;
  for (const v of [m.ssim, m.over16Fraction, m.over44Fraction, m.changedFraction]) if (!Number.isFinite(v)) throw new Error("non-finite metric");
  const failures: string[] = [];
  const routed = input.census ? input.census.native + input.census.compat : 0;
  const svgEmpty = m.inkSvg < MIN_INK_PIXELS || input.domDrawables === 0;
  const gpuEmpty = m.inkGpu < MIN_INK_PIXELS || routed === 0;
  if (svgEmpty) failures.push(`empty in SVG arm (ink ${m.inkSvg} px, ${input.domDrawables} drawables)`);
  if (gpuEmpty) failures.push(`empty in GPU arm (ink ${m.inkGpu} px, ${routed} routed)`);
  const populated = !svgEmpty && !gpuEmpty;
  const cover = coverageOf(m);
  const gates = {
    ssim: m.ssim >= D1.ssimMin,
    over16: m.over16Fraction <= D1.over16Max,
    over44: m.over44Fraction <= D1.over44Max,
    conservative: m.changedFraction <= D1.conservativeChangedMax && m.maxDelta <= D1.conservativeMaxDelta,
    coverage: cover.ink && cover.over16,
    coverageInk: cover.ink,
    coverageOver16: cover.over16,
    populated,
    census: true
  };
  if (!gates.ssim) failures.push(`ssim ${m.ssim.toFixed(4)} < ${D1.ssimMin}`);
  if (!gates.over16) failures.push(`over16 ${pct(m.over16Fraction)} > ${pct(D1.over16Max)}`);
  if (reading === "over44" && !gates.over44) failures.push(`over44 ${pct(m.over44Fraction)} > ${pct(D1.over44Max)}`);
  if (reading === "conservative" && !gates.conservative)
    failures.push(`conservative: changed ${pct(m.changedFraction)} (max ${pct(D1.conservativeChangedMax)}), maxDelta ${m.maxDelta} (max ${D1.conservativeMaxDelta})`);
  // an empty arm already failed as such; its coverage is reported in `gates` but not listed a second time
  if (populated && !gates.coverageInk)
    failures.push(`coverage: ink ${m.inkGpu} GPU vs ${m.inkSvg} SVG px (ratio ${m.inkRatio.toFixed(3)} < ${COVERAGE.inkRatioMin})`);
  if (populated && !gates.coverageOver16) failures.push(`coverage: over16 is ${pct(m.over16OfInk)} of the layer's ink (max ${pct(COVERAGE.over16OfInkMax)})`);
  if (input.expected) {
    const drift = censusDrift(input.expected, input.census);
    if (drift.length) {
      gates.census = false;
      failures.push(`census changed: ${drift.join(", ")}`);
    }
  }
  // non-gating: the strict reading's verdict on a cell the default reading passes (both are in `gates` too)
  const notes: string[] = [];
  if (reading === "over44" && failures.length === 0 && !gates.conservative)
    notes.push(`strict reading fails: changed ${pct(m.changedFraction)}, maxDelta ${m.maxDelta}`);
  return { pass: failures.length === 0, failures, notes, gates };
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
