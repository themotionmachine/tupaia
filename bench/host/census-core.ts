// Pure judgments for the CENSUS checks (bench/host/{toggle-census,resize-print,customization,memory-cycles}.ts and the
// preset summary of `gate presets`). No browser, no I/O: bench/host/census-core.test.ts proves each rule can fail.
//
// Principle (PHASE1-PLAN D1, PROOF-PLAN §4): a renderer claim is the GPU arm against the SVG arm of the same build.
// Where the rule is an absolute property (a button is off, a layer paints nothing, a canvas has a size) it is asserted
// against what the SVG arm / the DOM says, never against another GPU run.
import { MIN_INK_PIXELS } from "../golden-metrics.ts";

export type CheckStatus = "PASS" | "FAIL" | "INFO" | "SKIP";
export interface Check {
  id: string;
  row: string;
  status: CheckStatus;
  detail: string;
  evidence?: string;
}
export const pass = (id: string, row: string, detail: string, evidence?: string): Check => ({ id, row, status: "PASS", detail, evidence });
export const fail = (id: string, row: string, detail: string, evidence?: string): Check => ({ id, row, status: "FAIL", detail, evidence });
export const info = (id: string, row: string, detail: string, evidence?: string): Check => ({ id, row, status: "INFO", detail, evidence });
export const skip = (id: string, row: string, detail: string): Check => ({ id, row, status: "SKIP", detail });
/** pass when `problems` is empty, otherwise a fail listing them. */
export const judged = (id: string, row: string, problems: string[], okDetail: string, evidence?: string): Check =>
  problems.length ? fail(id, row, problems.join("; "), evidence) : pass(id, row, okDetail, evidence);

/** One line for the gate: the failing checks, or null. */
export function failureSummary(checks: Check[], limit = 6): string | null {
  const bad = checks.filter(c => c.status === "FAIL");
  if (!bad.length) return null;
  return `${bad.length} check(s) failed: ${bad.slice(0, limit).map(c => `${c.id} (${c.detail.slice(0, 160)})`).join("; ")}${bad.length > limit ? "; ..." : ""}`;
}

// ---------------------------------------------------------------- toggle census (row 26)

/** Budgets a toggle must keep. Tighten them as the renderer learns to flip a visibility flag instead of re-preparing. */
export const TOGGLE_BUDGET = {
  /** committed full prepares one toggle click may cause (the DOM change, plus one for a fade or a font arriving) */
  maxPreparesPerToggle: 2,
  /** toggle-coherence floor: the GPU's ink as a share of the SVG's after a layer is turned back on. NOT a fidelity gate. */
  onInkRatioMin: 0.3
} as const;

export interface LayerFacts {
  present: boolean;
  display?: string;
  visibility?: string;
  children?: number;
  drawables?: number;
  layer?: { native: number; compat: number } | null;
  compatRunElements?: number;
  runsReadable?: boolean;
}

export interface ToggleObservation {
  name: string;
  /** the toggle button's li has class buttonoff */
  buttonOff: boolean;
  facts: LayerFacts;
  gpu: { active: string | null; fallbackReason?: string; timedOut?: boolean; state?: string | null; hiddenReason?: string };
  /** pixels that differ from the arm's own blank (golden-metrics measureCell) */
  inkSvg: number | null;
  inkGpu: number | null;
  inkRatio: number | null;
  /** whether the layer is a root overlay (scaleBar, vignette): the renderer's per-layer report has no row for it */
  root?: boolean;
  /**
   * What the GPU reported for the layer in the state before the click (the layer on). A layer with a clip-path or mask
   * keeps reporting its mask's shapes (14 native elements for `mask="url(#land)"`) after the layer is emptied, so an
   * "off" layer must report FEWER elements than it did when on, not necessarily none. Absent: the report must be 0.
   */
  beforeCount?: number;
}

/** How many native + compat elements the GPU reports for the layer, counting compat runs for a root overlay. */
export function gpuCount(facts: LayerFacts, root?: boolean): number {
  if (root) return facts.compatRunElements ?? 0;
  return (facts.layer?.native ?? 0) + (facts.layer?.compat ?? 0);
}

const gpuProblem = (o: ToggleObservation): string | null =>
  o.gpu.active !== "gpu" ? `GPU not active (${o.gpu.fallbackReason ?? o.gpu.state ?? "no frame"})` : o.gpu.timedOut ? "GPU frame did not become current within 120 s" : null;

/** After a click that turned the layer OFF: class, display, layer report, GPU state and both arms must agree it is gone. */
export function judgeToggleOff(o: ToggleObservation): string[] {
  const problems: string[] = [];
  if (!o.buttonOff) problems.push("class: the button is not buttonoff");
  if (o.facts.present && o.facts.display !== "none" && o.facts.visibility !== "hidden" && (o.facts.drawables ?? 0) > 0) problems.push(`display: ${o.facts.drawables} drawable element(s) still visible in the SVG`);
  const reported = gpuCount(o.facts, o.root);
  if (!o.root && o.beforeCount != null) {
    if (o.beforeCount > 0 && reported >= o.beforeCount) problems.push(`layer report: the GPU still reports ${reported} element(s), as many as before the toggle`);
  } else if (reported > 0) problems.push(`layer report: the GPU still reports ${reported} element(s)`);
  const g = gpuProblem(o);
  if (g) problems.push(g);
  if (o.inkGpu != null && o.inkGpu >= MIN_INK_PIXELS) problems.push(`GPU frame still paints ${o.inkGpu} px of the layer${o.inkSvg != null && o.inkSvg < MIN_INK_PIXELS ? " (the SVG paints none)" : ""}`);
  if (o.inkSvg != null && o.inkSvg >= MIN_INK_PIXELS) problems.push(`SVG still paints ${o.inkSvg} px of the layer (the toggle did not hide it)`);
  return problems;
}

/** After a click that turned the layer back ON: the same five views must agree it is there, and the GPU must keep up. */
export function judgeToggleOn(o: ToggleObservation, floor: number = TOGGLE_BUDGET.onInkRatioMin): string[] {
  const problems: string[] = [];
  if (o.buttonOff) problems.push("class: the button is still buttonoff");
  if (!o.facts.present) problems.push("display: the layer element is missing");
  else if (o.facts.display === "none") problems.push("display: the layer is display:none");
  else if ((o.facts.drawables ?? 0) === 0) problems.push("display: no visible drawable element in the layer");
  if (gpuCount(o.facts, o.root) === 0) problems.push("layer report: the GPU reports no native or compat element");
  const g = gpuProblem(o);
  if (g) problems.push(g);
  if (o.inkSvg != null && o.inkSvg < MIN_INK_PIXELS) problems.push("SVG arm paints nothing (the layer is empty after the toggle)");
  else if (o.inkGpu != null && o.inkGpu < MIN_INK_PIXELS) problems.push("GPU frame paints nothing of a layer the SVG paints");
  else if (o.inkRatio != null && o.inkRatio < floor) problems.push(`GPU ink is ${(o.inkRatio * 100).toFixed(0)}% of the SVG's (coherence floor ${floor * 100}%)`);
  return problems;
}

export interface PrepareCost {
  prepares: number;
  invalidations: number;
  lastPrepareMs: number | null;
  /** click to a current GPU frame, ms */
  currentMs: number;
}

export function judgePrepares(cost: PrepareCost, budget: number = TOGGLE_BUDGET.maxPreparesPerToggle): string[] {
  return cost.prepares > budget ? [`${cost.prepares} committed prepares for one toggle (budget ${budget})`] : [];
}

// ---------------------------------------------------------------- reorder (row 27)

export interface FrameMetrics {
  ssim: number;
  over16Fraction: number;
  changedFraction?: number;
}
/** D1 thresholds for a whole frame (PROOF-PLAN §4): SSIM >= 0.95 and over16 <= 1 %. */
export const FRAME_D1 = { ssimMin: 0.95, over16Max: 0.01 } as const;

export function judgeReorder(args: {
  moved: boolean; // the layer's DOM position changed
  svgChanged: number; // fraction of SVG pixels that differ before vs after the move (the move must be visible)
  after: FrameMetrics; // GPU against SVG after the move
  gpu: { active: string | null; timedOut?: boolean; fallbackReason?: string };
  gpuChanged: number; // fraction of GPU pixels that differ before vs after the move
  minChange?: number;
}): string[] {
  const problems: string[] = [];
  const min = args.minChange ?? 0.002;
  if (!args.moved) problems.push("the layer did not move in the DOM");
  if (args.svgChanged < min) problems.push(`vacuous: the move changed ${(args.svgChanged * 100).toFixed(3)}% of the SVG frame (needs >= ${min * 100}%)`);
  if (args.gpu.active !== "gpu") problems.push(`GPU not active (${args.gpu.fallbackReason ?? "no frame"})`);
  else if (args.gpu.timedOut) problems.push("GPU frame did not become current within 120 s");
  if (args.after.ssim < FRAME_D1.ssimMin) problems.push(`SSIM ${args.after.ssim.toFixed(4)} < ${FRAME_D1.ssimMin} against the SVG after the move`);
  if (args.after.over16Fraction > FRAME_D1.over16Max) problems.push(`over16 ${(args.after.over16Fraction * 100).toFixed(3)}% > ${FRAME_D1.over16Max * 100}% against the SVG after the move`);
  // the GPU must have followed the move: when the SVG frame changed visibly, the GPU frame changed too
  if (args.svgChanged >= min && args.gpuChanged < args.svgChanged / 4) problems.push(`the GPU frame changed ${(args.gpuChanged * 100).toFixed(3)}% where the SVG changed ${(args.svgChanged * 100).toFixed(3)}% (stale draw order)`);
  return problems;
}

// ---------------------------------------------------------------- presets (row 28)

export interface GoldenCellLike {
  key: string;
  preset: string;
  family: string;
  k: number;
  pass: boolean;
  failures?: string[];
  census?: { native: number; compat: number; skipped: number } | null;
  metrics?: { ssim?: number; over16Fraction?: number; over44Fraction?: number } | null;
  renderer?: { active?: string; fallbackReason?: string };
}
export interface PresetRow {
  preset: string;
  cells: number;
  pass: number;
  fail: number;
  /** failing here but passing under the baseline preset for the same (family, k): the preset caused it */
  induced: number;
  /** native / compat / skipped element counts summed over the preset's cells */
  native: number;
  compat: number;
  skipped: number;
  /** compat / (native + compat) */
  compatShare: number | null;
  hard: string[]; // GPU fallback, timeouts, harness errors: never acceptable under any preset
  failing: string[]; // "family/k" of every failing cell
  inducedCells: string[];
  worst: { cell: string; ssim: number | null; over16: number | null } | null;
}

const HARD = /GPU not active|did not settle|harness:|fallback/i;
const cellId = (c: GoldenCellLike) => `${c.family}/k${c.k}${/@/.test(c.key) ? c.key.slice(c.key.indexOf("@")) : ""}`;

/** Aggregates one golden report (cells of several presets) by preset. `baseline` is the preset the induced count is relative to. */
export function summarizePresets(cells: GoldenCellLike[], baseline = "default"): { rows: PresetRow[]; byFamily: Record<string, Record<string, number | null>> } {
  const presets = [...new Set(cells.map(c => c.preset))];
  const base = new Map(cells.filter(c => c.preset === baseline).map(c => [cellId(c), c]));
  const rows = presets.map<PresetRow>(preset => {
    const mine = cells.filter(c => c.preset === preset);
    const failed = mine.filter(c => !c.pass);
    const induced = preset === baseline ? [] : failed.filter(c => base.get(cellId(c))?.pass);
    const sum = (key: "native" | "compat" | "skipped") => mine.reduce((n, c) => n + (c.census?.[key] ?? 0), 0);
    const native = sum("native");
    const compat = sum("compat");
    const withMetrics = failed.filter(c => c.metrics?.over16Fraction != null).sort((a, b) => (b.metrics!.over16Fraction ?? 0) - (a.metrics!.over16Fraction ?? 0))[0];
    return {
      preset,
      cells: mine.length,
      pass: mine.length - failed.length,
      fail: failed.length,
      induced: induced.length,
      native,
      compat,
      skipped: sum("skipped"),
      compatShare: native + compat ? compat / (native + compat) : null,
      hard: failed.flatMap(c => (c.failures ?? []).filter(f => HARD.test(f)).map(f => `${cellId(c)}: ${f.slice(0, 160)}`)),
      failing: failed.map(cellId),
      inducedCells: induced.map(cellId),
      worst: withMetrics ? { cell: cellId(withMetrics), ssim: withMetrics.metrics?.ssim ?? null, over16: withMetrics.metrics?.over16Fraction ?? null } : null
    };
  });
  // compat share by family and preset: which layers a preset pushes into the compat lane
  const byFamily: Record<string, Record<string, number | null>> = {};
  for (const family of [...new Set(cells.map(c => c.family))]) {
    byFamily[family] = {};
    for (const preset of presets) {
      const mine = cells.filter(c => c.preset === preset && c.family === family);
      const native = mine.reduce((n, c) => n + (c.census?.native ?? 0), 0);
      const compat = mine.reduce((n, c) => n + (c.census?.compat ?? 0), 0);
      byFamily[family][preset] = native + compat ? compat / (native + compat) : null;
    }
  }
  return { rows, byFamily };
}

/** The presets verdict: hard failures always fail; metric failures fail only past `allowInduced` per preset. */
export function judgePresets(rows: PresetRow[], allowInduced = 0): string[] {
  const problems: string[] = [];
  for (const r of rows) {
    if (r.hard.length) problems.push(`${r.preset}: ${r.hard.length} hard failure(s), first ${r.hard[0]}`);
    else if (r.induced > allowInduced) problems.push(`${r.preset}: ${r.induced} cell(s) fail only under this preset (${r.inducedCells.slice(0, 5).join(", ")}${r.induced > 5 ? ", ..." : ""})`);
  }
  return problems;
}

// ---------------------------------------------------------------- memory (gate gap 16)

export interface MemorySnapshot {
  cycle: number;
  /** JS heap after a forced GC, bytes */
  heap: number;
  /** DOM counters (CDP Memory.getDOMCounters) */
  nodes: number;
  listeners: number;
  documents: number;
  /** the renderer's tracked allocation estimate and CPU payload, bytes */
  gpuTracked: number | null;
  gpuCpu: number | null;
  canvases: number;
  contexts: number;
}

export const MEMORY_LIMITS = {
  /** heap after the last cycle may exceed the heap after the warm-up cycle by this many bytes (JIT, caches settle) */
  heapSlackBytes: 6 * 1024 * 1024,
  /** ... and by this fraction of it */
  heapSlackFraction: 0.05,
  /** DOM nodes and listeners after the last cycle vs the warm-up cycle */
  nodeSlackFraction: 0.05,
  nodeSlackAbs: 400,
  listenerSlackAbs: 60,
  /** tracked GPU bytes are deterministic for one world: allow this much drift */
  gpuSlackFraction: 0.02
} as const;

/** Judges growth between two snapshots of the same world at the same size. */
export function judgeGrowth(base: MemorySnapshot, last: MemorySnapshot, limits = MEMORY_LIMITS): { problems: string[]; growth: Record<string, number> } {
  const problems: string[] = [];
  const growth = {
    heap: last.heap - base.heap,
    nodes: last.nodes - base.nodes,
    listeners: last.listeners - base.listeners,
    documents: last.documents - base.documents,
    gpuTracked: (last.gpuTracked ?? 0) - (base.gpuTracked ?? 0),
    gpuCpu: (last.gpuCpu ?? 0) - (base.gpuCpu ?? 0),
    canvases: last.canvases - base.canvases,
    contexts: last.contexts - base.contexts
  };
  const heapLimit = Math.max(limits.heapSlackBytes, base.heap * limits.heapSlackFraction);
  if (growth.heap > heapLimit) problems.push(`JS heap grew ${(growth.heap / 1048576).toFixed(1)} MB over cycles ${base.cycle}..${last.cycle} (limit ${(heapLimit / 1048576).toFixed(1)} MB)`);
  if (growth.nodes > Math.max(limits.nodeSlackAbs, base.nodes * limits.nodeSlackFraction)) problems.push(`DOM nodes grew by ${growth.nodes} (${base.nodes} to ${last.nodes})`);
  if (growth.listeners > limits.listenerSlackAbs) problems.push(`event listeners grew by ${growth.listeners} (${base.listeners} to ${last.listeners})`);
  if (growth.documents > 0) problems.push(`${growth.documents} extra document(s) alive (detached frames)`);
  if (base.gpuTracked != null && last.gpuTracked != null && Math.abs(growth.gpuTracked) > base.gpuTracked * limits.gpuSlackFraction) problems.push(`tracked GPU allocations drifted ${growth.gpuTracked} bytes (${base.gpuTracked} to ${last.gpuTracked})`);
  if (base.gpuCpu != null && last.gpuCpu != null && Math.abs(growth.gpuCpu) > base.gpuCpu * limits.gpuSlackFraction + 1048576) problems.push(`renderer CPU payload drifted ${growth.gpuCpu} bytes (${base.gpuCpu} to ${last.gpuCpu})`);
  if (growth.canvases > 0) problems.push(`${growth.canvases} extra GPU canvas(es) in the document`);
  if (growth.contexts > 0) problems.push(`${growth.contexts} extra canvas(es)/WebGL context(s)`);
  return { problems, growth };
}

/** Judges growth between the warm-up snapshot (first one at or after `warmup`) and the last. Needs >= 3 cycles past it. */
export function judgeMemory(snaps: MemorySnapshot[], warmup = 3, limits = MEMORY_LIMITS): { problems: string[]; growth: Record<string, number> } {
  const base = snaps.find(s => s.cycle >= warmup);
  const last = snaps[snaps.length - 1];
  if (!base || !last || last.cycle - base.cycle < 3) return { problems: [`only ${snaps.length} snapshots: need cycles past the warm-up (${warmup})`], growth: {} };
  return judgeGrowth(base, last, limits);
}

// ---------------------------------------------------------------- resize / DPR / print (row 39)

/** What the renderer should size its backing store to: css size x min(dpr, 2), capped by the texture limit. */
export function expectedBacking(cssWidth: number, cssHeight: number, dpr: number, maxTexture = 16384): { w: number; h: number } {
  const d = Math.min(dpr, 2);
  const w = Math.max(1, Math.round(cssWidth * d));
  const h = Math.max(1, Math.round(cssHeight * d));
  const scale = Math.min(1, maxTexture / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

export interface CanvasGeometry {
  cssW: number; // canvas.style.width in px
  cssH: number;
  w: number; // canvas.width (backing store)
  h: number;
  left: number;
  top: number;
}
export interface SvgGeometry {
  w: number;
  h: number;
  left: number;
  top: number;
}

/** The canvas must cover the svg exactly and its backing store must match its css size at the capped DPR. */
export function judgeGeometry(canvas: CanvasGeometry | null, svg: SvgGeometry | null, dpr: number, tolerancePx = 1.01): string[] {
  if (!canvas || !svg) return [`${!canvas ? "no GPU canvas" : "no svg#map"}`];
  const problems: string[] = [];
  if (Math.abs(canvas.cssW - svg.w) > tolerancePx || Math.abs(canvas.cssH - svg.h) > tolerancePx) problems.push(`canvas css ${canvas.cssW}x${canvas.cssH} but svg is ${svg.w}x${svg.h}`);
  if (Math.abs(canvas.left - svg.left) > tolerancePx || Math.abs(canvas.top - svg.top) > tolerancePx) problems.push(`canvas at ${canvas.left},${canvas.top} but svg at ${svg.left},${svg.top}`);
  const want = expectedBacking(svg.w, svg.h, dpr);
  if (Math.abs(canvas.w - want.w) > 1 || Math.abs(canvas.h - want.h) > 1) problems.push(`backing store ${canvas.w}x${canvas.h}, expected ${want.w}x${want.h} at dpr ${Math.min(dpr, 2)}`);
  return problems;
}

/** Frame check after a viewport change: the GPU must be current and still within D1 of the SVG, and not worse than before. */
export function judgeFrameAfter(args: {
  label: string;
  before: FrameMetrics;
  after: FrameMetrics;
  gpu: { active: string | null; timedOut?: boolean; fallbackReason?: string };
}): string[] {
  const problems: string[] = [];
  if (args.gpu.active !== "gpu") return [`${args.label}: GPU not active (${args.gpu.fallbackReason ?? "no frame"})`];
  if (args.gpu.timedOut) problems.push(`${args.label}: GPU frame did not become current within 60 s`);
  // D1 is absolute when the baseline (the frame before the viewport/mode change) is itself inside D1. A baseline that
  // already breaches D1 is a golden fidelity gap of the scene, not this check's finding: then the change must not make
  // it worse (over16 within 0.5 points, SSIM within 0.02).
  const baselineInside = args.before.ssim >= FRAME_D1.ssimMin && args.before.over16Fraction <= FRAME_D1.over16Max;
  if (baselineInside) {
    if (args.after.ssim < FRAME_D1.ssimMin) problems.push(`${args.label}: SSIM ${args.after.ssim.toFixed(4)} < ${FRAME_D1.ssimMin}`);
    if (args.after.over16Fraction > FRAME_D1.over16Max) problems.push(`${args.label}: over16 ${(args.after.over16Fraction * 100).toFixed(3)}% > ${FRAME_D1.over16Max * 100}%`);
  } else if (args.after.over16Fraction > args.before.over16Fraction + 0.005) {
    problems.push(`${args.label}: over16 ${(args.after.over16Fraction * 100).toFixed(3)}% worse than the baseline ${(args.before.over16Fraction * 100).toFixed(3)}% (baseline already outside D1)`);
  }
  if (args.after.ssim < args.before.ssim - 0.02) problems.push(`${args.label}: SSIM fell from ${args.before.ssim.toFixed(4)} to ${args.after.ssim.toFixed(4)}`);
  return problems;
}
