import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeExercised, judgeReuse, type ReuseObservation } from "./reuse-fidelity-core.ts";

const good = { ssim: 0.99, over16Fraction: 0.001, over16OfInk: 0.05, inkRatio: 0.98 };
const base = (over: Partial<ReuseObservation> = {}): ReuseObservation => ({
  edit: "move",
  family: "markers",
  layerId: "markers",
  kept: { worldKept: 2, keptLayers: ["markers", "emblems"] },
  freshKept: 0,
  reused: good,
  fresh: good,
  gpu: { active: "gpu" },
  ...over
});

test("a reused frame as close to the SVG as the fresh one passes", () => {
  assert.equal(judgeReuse(base()).status, "PASS");
});

test("a stale reused raster fails: further from the SVG than the fresh frame", () => {
  const stale = { ssim: 0.9, over16Fraction: 0.02, over16OfInk: 0.6, inkRatio: 0.7 };
  const v = judgeReuse(base({ reused: stale }));
  assert.equal(v.status, "FAIL");
  assert.ok(v.problems.some(p => /SSIM/.test(p)));
  assert.ok(v.problems.some(p => /ink/.test(p)));
});

test("a cell that reused nothing of the family is reported, not judged", () => {
  const v = judgeReuse(base({ kept: { worldKept: 3, keptLayers: ["emblems"] }, reused: { ...good, ssim: 0.5 } }));
  assert.equal(v.status, "INFO");
  assert.equal(v.exercised, false);
});

test("a fresh control that reused rasters fails (it would not be a control)", () => {
  assert.equal(judgeReuse(base({ freshKept: 1 })).status, "FAIL");
  assert.equal(judgeReuse(base({ freshKept: 1, kept: null })).status, "FAIL");
});

test("the GPU must be on the frame it measures", () => {
  assert.equal(judgeReuse(base({ gpu: { active: "svg", fallbackReason: "budget" } })).status, "FAIL");
});

test("an edit that no family reused across is vacuous", () => {
  assert.deepEqual(judgeExercised("zoom", [judgeReuse(base())]), []);
  assert.equal(judgeExercised("zoom", [judgeReuse(base({ kept: null }))]).length, 1);
});
