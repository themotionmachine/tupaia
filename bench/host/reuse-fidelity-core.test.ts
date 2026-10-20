import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFINITION_VISIBLE_PX, judgeExercised, judgeRaced, judgeReuse, type ReuseObservation } from "./reuse-fidelity-core.ts";

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

test("a definition edit is judged whether or not the raster was kept, once it is visible", () => {
  const visible = DEFINITION_VISIBLE_PX + 1;
  // the run was re-cut (nothing kept): still judged, and as close to the SVG as fresh: PASS
  assert.equal(judgeReuse(base({ edit: "definition", family: "emblems", layerId: "emblems", kept: { worldKept: 0, keptLayers: [] }, visiblePx: visible })).status, "PASS");
  // a stale raster that kept the old colours is further from the new SVG than the fresh frame: FAIL
  const stale = { ssim: 0.8, over16Fraction: 0.05, over16OfInk: 0.9, inkRatio: 0.6 };
  const v = judgeReuse(base({ edit: "definition", family: "emblems", layerId: "emblems", visiblePx: visible, reused: stale }));
  assert.equal(v.status, "FAIL");
  assert.equal(v.exercised, true);
});

test("a definition edit that changes no pixel of the family proves nothing (INFO, not exercised)", () => {
  const v = judgeReuse(base({ edit: "definition", family: "zones", layerId: "zones", visiblePx: 3, reused: { ...good, ssim: 0.4 } }));
  assert.equal(v.status, "INFO");
  assert.equal(v.exercised, false);
  assert.match(v.problems[0], /needs 100/);
  assert.equal(judgeExercised("definition", [v]).length, 1);
});

test("a fresh control that reused something fails even when the definition edit was invisible", () => {
  assert.equal(judgeReuse(base({ edit: "definition", visiblePx: 0, freshKept: 2 })).status, "FAIL");
});

test("a capture that raced a redraw in every attempt is a failure, not an INFO", () => {
  assert.deepEqual(judgeRaced("move/markers", []), []);
  assert.equal(judgeRaced("move/markers", ["current", "refined"]).length, 1);
});
