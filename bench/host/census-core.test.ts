import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type GoldenCellLike,
  type MemorySnapshot,
  type ToggleObservation,
  expectedBacking,
  failureSummary,
  fail,
  judgeFrameAfter,
  judgeGeometry,
  judgeGrowth,
  judgeMemory,
  judgeOnStateFidelity,
  judgePrepares,
  emptyInBothArms,
  judgePresets,
  judgeReorder,
  judgeToggleOff,
  judgeToggleOn,
  judged,
  pass,
  summarizePresets,
  TOGGLE_BUDGET
} from "./census-core.ts";

const gpu = { active: "gpu", state: "active", hiddenReason: "" };
const off = (extra: Partial<ToggleObservation> = {}): ToggleObservation => ({
  name: "rivers",
  buttonOff: true,
  facts: { present: true, display: "inline", visibility: "visible", children: 0, drawables: 0, layer: null, compatRunElements: 0 },
  gpu,
  inkSvg: 0,
  inkGpu: 0,
  inkRatio: 0,
  ...extra
});
const on = (extra: Partial<ToggleObservation> = {}): ToggleObservation => ({
  name: "rivers",
  buttonOff: false,
  facts: { present: true, display: "inline", visibility: "visible", children: 40, drawables: 40, layer: { native: 40, compat: 0 }, compatRunElements: 0 },
  gpu,
  inkSvg: 5000,
  inkGpu: 4800,
  inkRatio: 0.96,
  ...extra
});

test("a toggle that agrees everywhere passes off and on", () => {
  assert.deepEqual(judgeToggleOff(off()), []);
  assert.deepEqual(judgeToggleOn(on()), []);
});

test("off: each of the five views can fail on its own", () => {
  assert.match(judgeToggleOff(off({ buttonOff: false })).join(), /class/);
  assert.match(judgeToggleOff(off({ facts: { present: true, display: "inline", visibility: "visible", drawables: 3, layer: null } })).join(), /display: 3 drawable/);
  assert.match(judgeToggleOff(off({ facts: { present: true, display: "none", drawables: 0, layer: { native: 14, compat: 0 } } })).join(), /layer report: the GPU still reports 14/);
  assert.match(judgeToggleOff(off({ gpu: { active: "svg", fallbackReason: "boom" } })).join(), /GPU not active \(boom\)/);
  assert.match(judgeToggleOff(off({ inkGpu: 90, inkSvg: 0 })).join(), /GPU frame still paints 90 px.*SVG paints none/);
  assert.match(judgeToggleOff(off({ inkSvg: 90 })).join(), /SVG still paints 90 px/);
  assert.match(judgeToggleOff(off({ gpu: { active: "gpu", timedOut: true } })).join(), /did not become current/);
});

test("off: a masked layer keeps its mask's shapes in the report, so the report must shrink, not vanish", () => {
  const masked = (n: number) => off({ beforeCount: 15, facts: { present: true, display: "inline", visibility: "visible", drawables: 0, layer: { native: n, compat: 0 } } });
  assert.deepEqual(judgeToggleOff(masked(14)), [], "15 elements on, 14 (the mask) off");
  assert.match(judgeToggleOff(masked(15)).join(), /as many as before the toggle/);
  assert.deepEqual(judgeToggleOff(off({ beforeCount: 0, facts: { present: true, display: "inline", drawables: 0, layer: { native: 3, compat: 0 } } })), [], "nothing to learn from an empty layer");
  assert.match(judgeToggleOff(off({ beforeCount: 15, root: true, facts: { present: true, display: "inline", drawables: 0, compatRunElements: 1 } })).join(), /still reports 1/, "a root overlay must report none");
});

test("off: a hidden-by-display layer with leftover children is gone (display:none counts)", () => {
  assert.deepEqual(judgeToggleOff(off({ facts: { present: true, display: "none", visibility: "visible", drawables: 7, layer: null } })), []);
});

test("off: a root overlay is counted by its compat runs, not by the layer report", () => {
  const root = off({ root: true, facts: { present: true, display: "inline", drawables: 0, layer: { native: 9, compat: 0 }, compatRunElements: 0 } });
  assert.deepEqual(judgeToggleOff(root), [], "the layer row of a root overlay is not read");
  assert.match(judgeToggleOff(off({ root: true, facts: { present: true, display: "inline", drawables: 0, compatRunElements: 2 } })).join(), /still reports 2/);
});

test("on: each view can fail, and the ink floor is a ratio of the SVG's", () => {
  assert.match(judgeToggleOn(on({ buttonOff: true })).join(), /still buttonoff/);
  assert.match(judgeToggleOn(on({ facts: { present: false } })).join(), /missing/);
  assert.match(judgeToggleOn(on({ facts: { present: true, display: "none", drawables: 40, layer: { native: 1, compat: 0 } } })).join(), /display:none/);
  assert.match(judgeToggleOn(on({ facts: { present: true, display: "inline", drawables: 0, layer: { native: 1, compat: 0 } } })).join(), /no visible drawable/);
  assert.match(judgeToggleOn(on({ facts: { present: true, display: "inline", drawables: 5, layer: { native: 0, compat: 0 } } })).join(), /no native or compat/);
  assert.match(judgeToggleOn(on({ inkGpu: 0, inkRatio: 0 })).join(), /GPU frame paints nothing/);
  assert.match(judgeToggleOn(on({ inkSvg: 0, inkGpu: 0, inkRatio: 0 })).join(), /SVG arm paints nothing/);
  assert.match(judgeToggleOn(on({ inkGpu: 1000, inkRatio: 0.2 })).join(), /20% of the SVG's/);
  assert.deepEqual(judgeToggleOn(on({ inkGpu: 1600, inkRatio: 0.32 })), [], "just over the floor passes");
  assert.deepEqual(judgeToggleOn(on({ inkGpu: 1000, inkRatio: 0.2 }), 0.1), []);
});

test("prepares per toggle are a budget", () => {
  const cost = { prepares: 1, invalidations: 50, lastPrepareMs: 20, currentMs: 100 };
  assert.deepEqual(judgePrepares(cost), []);
  assert.deepEqual(judgePrepares({ ...cost, prepares: TOGGLE_BUDGET.maxPreparesPerToggle }), []);
  assert.match(judgePrepares({ ...cost, prepares: TOGGLE_BUDGET.maxPreparesPerToggle + 1 }).join(), /2 committed prepares/);
});

test("on-state fidelity: the round trip must leave the layer looking as it did, GPU against SVG", () => {
  const before = { ssim: 0.9894, over16Fraction: 0.0065, over16OfInk: 0.08, inkRatio: 0.657 };
  const args = { label: "rivers", before, after: { ...before }, gpu };
  assert.deepEqual(judgeOnStateFidelity(args), [], "identical metrics pass");
  assert.deepEqual(judgeOnStateFidelity({ ...args, after: { ...before, ssim: 0.9885, over16Fraction: 0.0066 } }), [], "sub-margin noise passes");
  // a GPU frame left at 50 % opacity or redrawn with the wrong fills: right footprint, wrong pixels
  const faded = { ssim: 0.97, over16Fraction: 0.019, over16OfInk: 0.55, inkRatio: 0.657 };
  const problems = judgeOnStateFidelity({ ...args, after: faded }).join(" | ");
  assert.match(problems, /SSIM fell from 0.9894 to 0.9700/);
  assert.match(problems, /over16 rose from 0.650% to 1.900%/);
  assert.match(problems, /over16 of the layer's ink rose/);
  // sparse layer: whole-frame over16 and SSIM barely move, the layer-scoped view still catches it
  const sparse = { ssim: 0.9999, over16Fraction: 0.0001, over16OfInk: 0.0, inkRatio: 0.98 };
  assert.match(judgeOnStateFidelity({ label: "compass", before: sparse, after: { ...sparse, over16OfInk: 0.6 }, gpu }).join(), /over16 of the layer's ink rose from 0.0% to 60.0%/);
  assert.match(judgeOnStateFidelity({ ...args, after: { ...before, inkRatio: 0.3 } }).join(), /ink ratio fell/);
  assert.match(judgeOnStateFidelity({ ...args, gpu: { active: "svg", fallbackReason: "lost" } }).join(), /GPU not active/);
  assert.match(judgeOnStateFidelity({ ...args, gpu: { active: "gpu", timedOut: true } }).join(), /did not become current/);
  // a baseline already outside D1 (a golden gap) is not blamed on the toggle, but may not get worse
  const gap = { ssim: 0.91, over16Fraction: 0.42 };
  assert.deepEqual(judgeOnStateFidelity({ label: "provinces", before: gap, after: { ...gap }, gpu }), []);
  assert.match(judgeOnStateFidelity({ label: "provinces", before: gap, after: { ssim: 0.91, over16Fraction: 0.6 }, gpu }).join(), /over16 .* worse than the baseline|over16 rose/);
});

test("reorder: the move must be visible in the SVG, followed by the GPU, and within D1", () => {
  const ok = { moved: true, svgChanged: 0.39, gpuChanged: 0.39, after: { ssim: 0.996, over16Fraction: 0.0036 }, gpu };
  assert.deepEqual(judgeReorder(ok), []);
  assert.match(judgeReorder({ ...ok, moved: false }).join(), /did not move/);
  assert.match(judgeReorder({ ...ok, svgChanged: 0.0001, gpuChanged: 0.0001 }).join(), /vacuous/);
  assert.match(judgeReorder({ ...ok, gpuChanged: 0.01 }).join(), /stale draw order/);
  assert.match(judgeReorder({ ...ok, after: { ssim: 0.9, over16Fraction: 0.0036 } }).join(), /SSIM 0.9000/);
  assert.match(judgeReorder({ ...ok, after: { ssim: 0.996, over16Fraction: 0.05 } }).join(), /over16 5.000%/);
  assert.match(judgeReorder({ ...ok, gpu: { active: "svg", fallbackReason: "x" } }).join(), /GPU not active/);
});

const cell = (preset: string, family: string, k: number, ok: boolean, extra: Partial<GoldenCellLike> = {}): GoldenCellLike => ({
  key: `${preset}/d2/${family}/k${k}`,
  preset,
  family,
  k,
  pass: ok,
  failures: ok ? [] : ["ssim 0.9 < 0.95"],
  census: { native: 8, compat: 2, skipped: 1 },
  metrics: { ssim: ok ? 0.99 : 0.9, over16Fraction: ok ? 0 : 0.05 },
  ...extra
});

test("preset summary: compat share, induced failures and the worst cell", () => {
  const cells = [
    cell("default", "ocean", 1, true),
    cell("default", "rivers", 1, false),
    cell("ancient", "ocean", 1, false, { census: { native: 2, compat: 8, skipped: 0 } }),
    cell("ancient", "rivers", 1, false),
    cell("light", "ocean", 1, true),
    cell("light", "rivers", 1, true)
  ];
  const { rows, byFamily } = summarizePresets(cells);
  const ancient = rows.find(r => r.preset === "ancient")!;
  assert.equal(ancient.fail, 2);
  assert.equal(ancient.induced, 1, "rivers already fails under default, ocean fails only under ancient");
  assert.deepEqual(ancient.inducedCells, ["ocean/k1"]);
  assert.equal(ancient.compatShare, 10 / 20);
  assert.equal(rows.find(r => r.preset === "light")!.induced, 0);
  assert.equal(rows.find(r => r.preset === "default")!.induced, 0);
  assert.equal(byFamily.ocean.ancient, 0.8);
  assert.equal(byFamily.ocean.default, 0.2);
  assert.equal(ancient.worst?.over16, 0.05);
});

const gated = (preset: string, family: string, gates: Record<string, boolean>): GoldenCellLike => {
  const ok = Object.values(gates).every(Boolean);
  return cell(preset, family, 1, ok, { gates, failures: ok ? [] : ["conservative: changed 0.9% (max 0.5%)"] });
};
const allGates = { ssim: true, over16: true, over44: true, conservative: true, coverage: true, populated: true };

test("preset induced is counted per gate: a cell that already fails one gate cannot hide a regression of another", () => {
  const cells = [
    // texture fails the conservative gate under the baseline, but passes ssim and over16 there
    gated("default", "texture", { ...allGates, conservative: false }),
    gated("ancient", "texture", { ...allGates, conservative: false, ssim: false, over16: false }),
    // a cell that fails only a gate that also fails under the baseline is not induced
    gated("ancient", "ocean", { ...allGates, conservative: false }),
    gated("default", "ocean", { ...allGates, conservative: false }),
    gated("light", "texture", { ...allGates, conservative: false }),
    gated("light", "ocean", { ...allGates, conservative: false })
  ];
  const { rows } = summarizePresets(cells, "default", "conservative");
  const ancient = rows.find(r => r.preset === "ancient")!;
  assert.equal(ancient.induced, 1);
  assert.deepEqual(ancient.inducedCells, ["texture/k1"]);
  assert.deepEqual(ancient.inducedGates, { ssim: 1, over16: 1 });
  assert.equal(rows.find(r => r.preset === "light")!.induced, 0);
  assert.match(judgePresets(rows).join(), /ancient: 1 cell\(s\) fail a gate under this preset that passes under the baseline \(ssim 1, over16 1;/);
});

test("preset induced follows the reading: over44 (the D11 default) gates, conservative only when asked", () => {
  const cells = [gated("default", "ocean", allGates), gated("gloom", "ocean", { ...allGates, over44: false })];
  assert.equal(summarizePresets(cells, "default", "conservative").rows.find(r => r.preset === "gloom")!.induced, 0, "over44 is not gated under the conservative reading");
  assert.equal(summarizePresets(cells).rows.find(r => r.preset === "gloom")!.induced, 1, "the default reading is over44");
});

test("preset induced counts the D11 coverage gate, and inducedFromPass only cells that fully pass under the baseline", () => {
  const cells = [
    // passes everything under default, loses ink under night: induced by coverage, and from a pass
    gated("default", "burgs", allGates),
    gated("night", "burgs", { ...allGates, coverage: false }),
    // already fails coverage under default and fails it again under night: not induced
    gated("default", "rivers", { ...allGates, coverage: false }),
    gated("night", "rivers", { ...allGates, coverage: false }),
    // fails coverage under default, and under night loses ssim as well: induced (ssim) but not from a pass
    gated("default", "routes", { ...allGates, coverage: false }),
    gated("night", "routes", { ...allGates, coverage: false, ssim: false })
  ];
  const night = summarizePresets(cells).rows.find(r => r.preset === "night")!;
  assert.deepEqual(night.inducedCells.sort(), ["burgs/k1", "routes/k1"]);
  assert.deepEqual(night.inducedGates, { coverage: 1, ssim: 1 });
  assert.equal(night.inducedFromPass, 1);
});

test("preset hard failures are anchored on the golden's own phrases, not any mention of a fallback", () => {
  const cells = [
    cell("default", "ocean", 1, true),
    cell("night", "ocean", 1, false, { failures: ["ink footprint note: compat fallback took 40% of the elements"] }),
    cell("pale", "ocean", 1, false, { failures: ["GPU not active: webgl2 lost"] }),
    cell("gloom", "ocean", 1, false, { failures: ["GPU frame did not settle within 60 s"] }),
    cell("light", "ocean", 1, false, { failures: ["harness: boom"] })
  ];
  const { rows } = summarizePresets(cells);
  assert.equal(rows.find(r => r.preset === "night")!.hard.length, 0);
  for (const p of ["pale", "gloom", "light"]) assert.equal(rows.find(r => r.preset === p)!.hard.length, 1, p);
});

test("preset verdict: hard failures always fail, metric failures only past the allowance", () => {
  const cells = [cell("default", "ocean", 1, true), cell("gloom", "ocean", 1, false), cell("night", "ocean", 1, false, { failures: ["GPU not active: boom"] })];
  const { rows } = summarizePresets(cells);
  const problems = judgePresets(rows);
  assert.equal(problems.length, 2);
  assert.match(problems.join(" | "), /gloom: 1 cell\(s\) fail a gate under this preset/);
  assert.match(problems.join(" | "), /night: 1 hard failure/);
  assert.deepEqual(judgePresets(rows, 1).filter(p => /gloom/.test(p)), [], "an allowance of 1 forgives gloom");
  assert.equal(judgePresets(rows, 1).filter(p => /night/.test(p)).length, 1, "but never a hard failure");
});

test("preset exceptions (D14) forgive only the named induced cell, never a hard failure or another cell", () => {
  const cells = [
    cell("default", "ocean", 1, true),
    cell("default", "labels", 1, true),
    cell("cyberpunk", "labels", 1, false),
    cell("night", "labels", 1, false),
    cell("light", "labels", 1, false, { failures: ["GPU not active: boom"] })
  ];
  const { rows } = summarizePresets(cells);
  const exceptions = { "cyberpunk/labels/k1": "test", "light/labels/k1": "test" };
  const problems = judgePresets(rows, 0, exceptions);
  assert.equal(problems.filter(p => /cyberpunk/.test(p)).length, 0, "the named cell is exempt");
  assert.equal(problems.filter(p => /night/.test(p)).length, 1, "the same family under another preset is not");
  assert.equal(problems.filter(p => /light: 1 hard failure/.test(p)).length, 1, "an exception never forgives a hard failure");
  assert.equal(judgePresets(rows, 0, {}).filter(p => /cyberpunk/.test(p)).length, 1, "without the exception it fails");
});

test("preset cells empty in both arms are N/A: listed apart, neither failing nor induced; one empty arm still fails", () => {
  const empty = (preset: string, family: string, inkSvg: number, inkGpu: number, routed = 1): GoldenCellLike => {
    const failures = [
      ...(inkSvg < 4 ? [`empty in SVG arm (ink ${inkSvg} px, 1 drawables)`] : []),
      ...(inkGpu < 4 || !routed ? [`empty in GPU arm (ink ${inkGpu} px, ${routed} routed)`] : [])
    ];
    return cell(preset, family, 1, false, { failures, metrics: { ssim: 1, over16Fraction: 0, inkSvg, inkGpu }, gates: { ...allGates, populated: false } });
  };
  const cells = [
    gated("default", "vignette", allGates),
    gated("default", "coastline", allGates),
    gated("default", "borders", allGates),
    gated("default", "rivers", allGates),
    // clean: vignette opacity 0 paints nothing in either arm
    empty("clean", "vignette", 0, 0),
    // monochrome: coastline stroke-width 0, the GPU routes nothing and paints nothing either
    empty("monochrome", "coastline", 0, 0, 0),
    // the SVG paints, the GPU does not: a real miss
    empty("night", "borders", 5000, 0),
    // the GPU paints where the SVG is empty: a real miss too
    empty("night", "rivers", 0, 900)
  ];
  const { rows } = summarizePresets(cells);
  const clean = rows.find(r => r.preset === "clean")!;
  assert.deepEqual(clean.notApplicable, ["vignette/k1"]);
  assert.equal(clean.fail, 0);
  assert.equal(clean.induced, 0);
  assert.deepEqual(clean.failing, []);
  assert.deepEqual(rows.find(r => r.preset === "monochrome")!.notApplicable, ["coastline/k1"]);
  const night = rows.find(r => r.preset === "night")!;
  assert.deepEqual(night.notApplicable, []);
  assert.deepEqual(night.inducedCells.sort(), ["borders/k1", "rivers/k1"]);
  assert.deepEqual(night.inducedGates, { populated: 2 });
  const problems = judgePresets(rows);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^night: 2 cell\(s\)/);
  // an empty-both cell that also failed something else (a harness error) is not N/A
  const odd = cell("clean", "vignette", 1, false, { failures: ["empty in SVG arm (ink 0 px, 1 drawables)", "harness: boom"], metrics: { inkSvg: 0, inkGpu: 0 } });
  assert.equal(emptyInBothArms(odd), false);
  // a cell without ink metrics cannot be classified N/A
  assert.equal(emptyInBothArms(cell("clean", "vignette", 1, false, { failures: ["empty in SVG arm (ink 0 px, 1 drawables)"], metrics: null })), false);
});

const snap = (cycle: number, extra: Partial<MemorySnapshot> = {}): MemorySnapshot => ({
  cycle,
  heap: 100 * 1048576,
  nodes: 20000,
  listeners: 900,
  documents: 3,
  gpuTracked: 50_000_000,
  gpuCpu: 20_000_000,
  canvases: 1,
  contexts: 4,
  ...extra
});
const series = (f: (cycle: number) => Partial<MemorySnapshot>) => Array.from({ length: 12 }, (_, i) => snap(i, f(i)));

test("memory: a flat series passes", () => {
  assert.deepEqual(judgeMemory(series(() => ({}))).problems, []);
});

test("memory: each leak is named", () => {
  const heap = judgeMemory(series(i => ({ heap: (100 + i * 3) * 1048576 }))).problems.join();
  assert.match(heap, /JS heap grew/);
  assert.match(judgeMemory(series(i => ({ nodes: 20000 + i * 400 }))).problems.join(), /DOM nodes grew/);
  assert.match(judgeMemory(series(i => ({ listeners: 900 + i * 20 }))).problems.join(), /event listeners grew/);
  assert.match(judgeMemory(series(i => ({ documents: 3 + (i > 5 ? 1 : 0) }))).problems.join(), /extra document/);
  assert.match(judgeMemory(series(i => ({ gpuTracked: 50_000_000 + i * 2_000_000 }))).problems.join(), /tracked GPU allocations drifted/);
  assert.match(judgeMemory(series(i => ({ gpuCpu: 20_000_000 + i * 4_000_000 }))).problems.join(), /CPU payload drifted/);
  assert.match(judgeMemory(series(i => ({ canvases: 1 + (i > 5 ? 1 : 0) }))).problems.join(), /extra GPU canvas/);
  assert.match(judgeMemory(series(i => ({ contexts: 4 + (i > 5 ? 1 : 0) }))).problems.join(), /extra canvas/);
});

test("memory: growth inside the slack passes, and the warm-up is not counted", () => {
  assert.deepEqual(judgeMemory(series(i => ({ heap: (i < 3 ? 60 : 100 + (i % 2)) * 1048576 }))).problems, [], "heap before the warm-up cycle is ignored");
  assert.deepEqual(judgeMemory(series(i => ({ heap: (100 + i * 0.5) * 1048576 }))).problems, [], "5 MB over the run is inside the 12 MB slack");
});

test("memory: too few cycles past the warm-up cannot be judged", () => {
  assert.match(judgeMemory([snap(0), snap(1), snap(2), snap(3), snap(4)]).problems.join(), /need cycles past the warm-up/);
});

test("memory: judgeGrowth compares any two snapshots", () => {
  assert.deepEqual(judgeGrowth(snap(5), snap(15)).problems, []);
  assert.match(judgeGrowth(snap(5), snap(15, { heap: 140 * 1048576 })).problems.join(), /JS heap grew 40.0 MB/);
});

test("backing store: css size times min(dpr, 2), capped by the texture limit", () => {
  assert.deepEqual(expectedBacking(1280, 720, 2), { w: 2560, h: 1440 });
  assert.deepEqual(expectedBacking(1280, 720, 3), { w: 2560, h: 1440 }, "dpr is capped at 2");
  assert.deepEqual(expectedBacking(1280, 720, 1), { w: 1280, h: 720 });
  assert.deepEqual(expectedBacking(9000, 4000, 2, 8192), { w: 8192, h: 3641 });
});

test("geometry: the canvas covers the svg and its backing store follows dpr", () => {
  const svg = { w: 1280, h: 720, left: 0, top: 0 };
  const canvas = { cssW: 1280, cssH: 720, w: 2560, h: 1440, left: 0, top: 0 };
  assert.deepEqual(judgeGeometry(canvas, svg, 2), []);
  assert.match(judgeGeometry({ ...canvas, cssW: 900 }, svg, 2).join(), /canvas css 900x720 but svg is 1280x720/);
  assert.match(judgeGeometry({ ...canvas, left: 40 }, svg, 2).join(), /canvas at 40,0/);
  assert.match(judgeGeometry({ ...canvas, w: 1280, h: 720 }, svg, 2).join(), /backing store 1280x720, expected 2560x1440 at dpr 2/);
  assert.match(judgeGeometry(canvas, svg, 1).join(), /expected 1280x720 at dpr 1/, "a stale backing store after a dpr change");
  assert.deepEqual(judgeGeometry(null, svg, 2), ["no GPU canvas"]);
});

test("frame after a viewport change: current, within D1 and not worse than before", () => {
  const before = { ssim: 0.996, over16Fraction: 0.003 };
  const ok = { label: "grow", before, after: { ssim: 0.995, over16Fraction: 0.004 }, gpu };
  assert.deepEqual(judgeFrameAfter(ok), []);
  assert.match(judgeFrameAfter({ ...ok, after: { ssim: 0.94, over16Fraction: 0.004 } }).join(), /SSIM 0.9400 < 0.95/);
  assert.match(judgeFrameAfter({ ...ok, after: { ssim: 0.995, over16Fraction: 0.02 } }).join(), /over16 2.000% > 1%/);
  assert.match(judgeFrameAfter({ ...ok, before: { ssim: 0.999, over16Fraction: 0 }, after: { ssim: 0.96, over16Fraction: 0.004 } }).join(), /SSIM fell/);
  // a baseline already outside D1 (a scene fidelity gap) only has to not get worse
  const gap = { ssim: 0.99, over16Fraction: 0.012 };
  assert.deepEqual(judgeFrameAfter({ ...ok, before: gap, after: { ssim: 0.99, over16Fraction: 0.012 } }), []);
  assert.match(judgeFrameAfter({ ...ok, before: gap, after: { ssim: 0.99, over16Fraction: 0.07 } }).join(), /worse than the baseline 1.200%/);
  assert.match(judgeFrameAfter({ ...ok, gpu: { active: "svg", fallbackReason: "lost" } }).join(), /GPU not active \(lost\)/);
  assert.match(judgeFrameAfter({ ...ok, gpu: { active: "gpu", timedOut: true } }).join(), /did not become current/);
});

test("check helpers: judged and failureSummary", () => {
  assert.equal(judged("a", "26", [], "fine").status, "PASS");
  const bad = judged("b", "26", ["one", "two"], "fine");
  assert.equal(bad.status, "FAIL");
  assert.equal(bad.detail, "one; two");
  assert.equal(failureSummary([pass("a", "1", "")]), null);
  const summary = failureSummary([pass("a", "1", ""), fail("b", "1", "broke"), fail("c", "1", "also")])!;
  assert.match(summary, /^2 check\(s\) failed: b \(broke\); c \(also\)$/);
});
