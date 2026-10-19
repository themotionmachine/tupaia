import { test } from "node:test";
import assert from "node:assert/strict";
import { attributeTrace } from "./trace.ts";

test("attributes renderer input layout separately from paint and raster", () => {
  const base = { pid: 1, tid: 2 };
  const traceEvents = [
    { ...base, name: "thread_name", ph: "M", ts: 0, args: { name: "CrRendererMain" } },
    { ...base, name: "navigation:gesture:start", ph: "R", ts: 1000 },
    { ...base, name: "EventDispatch", ph: "X", ts: 1100, dur: 1000 },
    { ...base, name: "navigation:input:start", ph: "R", ts: 1150 },
    { ...base, name: "Layout", ph: "X", ts: 1200, dur: 500 },
    { ...base, name: "navigation:input:end", ph: "R", ts: 1800 },
    { ...base, name: "Layout", ph: "X", ts: 3000, dur: 100 },
    { ...base, name: "Paint", ph: "X", ts: 3300, dur: 200 },
    { ...base, tid: 3, name: "RasterTask", ph: "X", ts: 3500, dur: 600 },
    { ...base, name: "navigation:gesture:end", ph: "R", ts: 5000 },
    { ...base, name: "Layout", ph: "X", ts: 6000, dur: 1000 }
  ];
  const result = attributeTrace({ traceEvents });
  assert.equal(result.input.totalMs, 1);
  assert.equal(result.layout.count, 2);
  assert.equal(result.layoutInsideInput.totalMs, 0.5);
  assert.equal(result.layoutInsideSyntheticInput.totalMs, 0.5);
  assert.equal(result.syntheticInput.totalMs, 0.65);
  assert.equal(result.paint.totalMs, 0.2);
  assert.equal(result.raster.totalMs, 0.6);
  assert.equal(result.gestureDurationMs, 4);
});

test("refuses traces without attribution metadata", () => {
  assert.throws(() => attributeTrace({ traceEvents: [] }), /main-thread metadata/);
});
