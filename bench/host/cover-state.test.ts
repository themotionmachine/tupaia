import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type CoverState, coverApplies, coverProblems } from "./cover-state.ts";

const gpuArm = (over: Partial<CoverState> = {}): CoverState => ({
  gpu: true,
  canvasShown: true,
  optedOut: false,
  armed: true,
  active: true,
  wanted: true,
  enabled: true,
  issue: "",
  viewboxVisibility: "hidden",
  ...over
});
const svgArm = (over: Partial<CoverState> = {}): CoverState =>
  gpuArm({ canvasShown: false, active: false, viewboxVisibility: "visible", ...over });

describe("coverProblems", () => {
  it("passes an armed, active GPU arm and an uncovered SVG arm", () => {
    assert.deepEqual(coverProblems(gpuArm(), svgArm()), []);
  });

  it("fails a GPU arm whose cover applies but is not active, or was never armed", () => {
    assert.match(coverProblems(gpuArm({ active: false, viewboxVisibility: "visible" }), svgArm()).join(), /not active/);
    assert.match(coverProblems(gpuArm({ armed: false, active: false }), svgArm()).join(), /not armed/);
  });

  it("accepts a fail-closed GPU arm: a filtered/transparent canvas, an ineligible model, an opt-out", () => {
    assert.deepEqual(coverProblems(gpuArm({ enabled: false, active: false }), svgArm()), []);
    assert.deepEqual(coverProblems(gpuArm({ issue: "author CSS: x", active: false }), svgArm()), []);
    assert.deepEqual(coverProblems(gpuArm({ optedOut: true, armed: false, active: false }), svgArm({ optedOut: true })), []);
    assert.equal(coverApplies(gpuArm({ enabled: false })), false);
  });

  it("fails an SVG arm shot under the cover", () => {
    assert.match(coverProblems(gpuArm(), svgArm({ active: true })).join(), /SVG arm was shot under the cover/);
    assert.match(coverProblems(gpuArm(), svgArm({ viewboxVisibility: "hidden" })).join(), /SVG arm/);
  });

  it("fails an active cover with the canvas not shown, in either arm (a blank map)", () => {
    const blank = { canvasShown: false, active: true, viewboxVisibility: "hidden" };
    assert.match(coverProblems(gpuArm(blank), svgArm()).join(), /active with the canvas not shown in the GPU arm/);
    assert.match(coverProblems(gpuArm(), svgArm(blank)).join(), /active with the canvas not shown in the SVG arm/);
    // a hidden canvas with the cover lifted is the honest SVG arm
    assert.deepEqual(coverProblems(gpuArm(), svgArm({ canvasShown: false, active: false })), []);
  });

  it("judges nothing on an svg page", () => {
    const page = { ...svgArm(), gpu: false, armed: false };
    assert.deepEqual(coverProblems(page, page), []);
  });
});
