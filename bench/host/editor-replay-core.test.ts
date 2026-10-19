// node --test bench/host/editor-replay-core.test.ts — the replay verdict rules, and the shipped scripts' shape.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  armQuery,
  checkGpuStep,
  checkRecording,
  compareStep,
  type EditorScript,
  judgeArm,
  parseArms,
  type StepObservation,
  validateScript
} from "./editor-replay-core.ts";

const step = (over: Partial<StepObservation> = {}): StepObservation => ({
  index: 1,
  op: "click",
  camera: { k: 8, x: -100, y: -200 },
  cameraMoves: 0,
  model: { "pack.burgs": "a", "pack.cells.h": "b" },
  modelChanged: [],
  dom: { "#viewbox>#labels": "x", "#defs": "y" },
  domDelta: ["#burgLabel44 @transform=translate(3,1)"],
  domDeltaCount: 1,
  calls: { dispatchClick: 1, editBurg: 1 },
  dialogs: ["#burgEditor"],
  errors: [],
  hitKey: "#burgLabel44",
  ms: 10,
  ...over
});

const gpu = (over = {}) => ({ active: "gpu", fallbackReason: null, state: "suspended", suspendedReason: "editor dialog open", canvasVisible: false, pending: true, ...over });

const script: EditorScript = {
  name: "burg",
  editor: "editBurg",
  dialog: "#burgEditor",
  rows: [29],
  description: "test",
  steps: [
    { op: "camera", k: 8, focus: { burg: 1 } },
    { op: "click", target: { burg: 1 }, expect: { editor: "editBurg", dialog: "#burgEditor" } },
    { op: "input", id: "burgName", value: "x" },
    { op: "close", dialog: "#burgEditor" }
  ]
};

describe("arms", () => {
  it("maps arms to URL flags and requires the svg recording arm", () => {
    assert.equal(armQuery("svg"), "");
    assert.equal(armQuery("gpu"), "&renderer=gpu");
    assert.equal(armQuery("gpu-select"), "&renderer=gpu&gpu-select");
    assert.deepEqual(parseArms(undefined), ["svg", "gpu", "gpu-select"]);
    assert.deepEqual(parseArms("svg,gpu"), ["svg", "gpu"]);
    assert.throws(() => parseArms("gpu"), /recording/);
    assert.throws(() => parseArms("svg,webgpu"), /unknown arm/);
  });
});

describe("validateScript", () => {
  it("accepts a well-formed script", () => assert.deepEqual(validateScript(script), []));
  it("requires an opening click, a final close and sane steps", () => {
    const bad: EditorScript = {
      ...script,
      steps: [
        { op: "camera", k: 40, focus: { burg: 1 } },
        { op: "click", target: { burg: 1 } },
        { op: "drag", target: { burg: 1 }, path: [] }
      ]
    };
    const errors = validateScript(bad).join("\n");
    assert.match(errors, /camera k/);
    assert.match(errors, /drag needs a path/);
    assert.match(errors, /no click step expects #burgEditor/);
    assert.match(errors, /last step must close/);
  });
  it("accepts every shipped editor script", async () => {
    const dir = join(import.meta.dirname, "editor-scripts");
    const names = readdirSync(dir).filter(f => f.endsWith(".ts") && f !== "common.ts");
    assert.ok(names.length >= 5, `found ${names.join(", ")}`);
    for (const name of names) {
      const loaded = (await import(join(dir, name))).default as EditorScript;
      assert.equal(loaded.name, name.slice(0, -3));
      assert.deepEqual(validateScript(loaded), [], name);
    }
  });
});

describe("compareStep", () => {
  it("passes an identical replay", () => assert.deepEqual(compareStep(step(), step()), []));
  it("names the model sections and DOM layers that differ", () => {
    const out = compareStep(step(), step({ model: { "pack.burgs": "Z", "pack.cells.h": "b" }, dom: { "#viewbox>#labels": "Q", "#defs": "y" } })).join("\n");
    assert.match(out, /model differs in pack\.burgs/);
    assert.match(out, /model DOM differs in #viewbox>#labels/);
  });
  it("reports the DOM delta entries missing and extra", () => {
    const out = compareStep(step(), step({ domDelta: ["#burgLabel44 @transform=translate(4,1)"] })).join("\n");
    assert.match(out, /DOM delta/);
    assert.match(out, /translate\(3,1\)/);
    assert.match(out, /translate\(4,1\)/);
  });
  it("calls more dispatches double dispatch, fewer missing", () => {
    assert.match(compareStep(step(), step({ calls: { dispatchClick: 2, editBurg: 1 } })).join(), /double dispatch: dispatchClick called 2x/);
    assert.match(compareStep(step(), step({ calls: { dispatchClick: 1 } })).join(), /missing dispatch: editBurg/);
  });
  it("fails a camera move, a different hit, other dialogs and page errors", () => {
    const out = compareStep(step(), step({ cameraMoves: 3, hitKey: "#zone1", dialogs: [], errors: ["boom"] })).join("\n");
    assert.match(out, /camera moved/);
    assert.match(out, /canonical hit #zone1/);
    assert.match(out, /dialogs \[\]/);
    assert.match(out, /page error boom/);
  });
});

describe("checkGpuStep", () => {
  it("requires suspension with the canvas hidden while an editor is open", () => {
    assert.deepEqual(checkGpuStep(step({ gpu: gpu() }), "gpu", 1000), []);
    assert.match(checkGpuStep(step({ gpu: gpu({ canvasVisible: true }) }), "gpu", 1000).join(), /canvas is still on screen/);
    assert.match(checkGpuStep(step({ gpu: gpu({ suspendedReason: null }) }), "gpu", 1000).join(), /not suspended/);
    assert.match(checkGpuStep(step({ gpu: gpu({ active: "svg", fallbackReason: "lost" }) }), "gpu", 1000).join(), /fell back: lost/);
    assert.deepEqual(checkGpuStep(step(), "svg", 1000), []);
  });
  it("requires a measured, refined resume after the close", () => {
    const closed = (resume: any) => step({ op: "close", dialogs: [], gpu: gpu({ state: "active", suspendedReason: null, canvasVisible: true }), resume });
    assert.deepEqual(checkGpuStep(closed({ currentMs: 900, refinedMs: 1500, timedOut: false, prepares: 1, lastPrepareMs: 800 }), "gpu", 60000), []);
    assert.match(checkGpuStep(closed(undefined), "gpu", 60000).join(), /no resume measured/);
    assert.match(checkGpuStep(closed({ currentMs: null, refinedMs: null, timedOut: true, prepares: 0, lastPrepareMs: null }), "gpu", 60000).join(), /did not resume/);
    assert.match(checkGpuStep(closed({ currentMs: 900, refinedMs: null, timedOut: true, prepares: 1, lastPrepareMs: 1 }), "gpu", 60000).join(), /did not refine/);
  });
  it("allows at most one click-route outcome per action on gpu-select, never a drop", () => {
    assert.deepEqual(checkGpuStep(step({ gpu: gpu(), routes: { legacy: 1 } }), "gpu-select", 1000), []);
    assert.match(checkGpuStep(step({ gpu: gpu(), routes: { legacy: 1, resynced: 1 } }), "gpu-select", 1000).join(), /2 click-route outcomes/);
    assert.match(checkGpuStep(step({ gpu: gpu(), routes: { dropped: 1 } }), "gpu-select", 1000).join(), /dropped/);
  });
});

describe("checkRecording / judgeArm", () => {
  const recorded = [
    step({ index: 0, op: "camera", calls: {}, dialogs: [], hitKey: undefined, domDelta: [], domDeltaCount: 0 }),
    step({ index: 1, op: "click" }),
    step({ index: 2, op: "input", calls: {}, modelChanged: ["pack.burgs"] }),
    step({ index: 3, op: "close", calls: {}, dialogs: [], hitKey: undefined })
  ];
  it("accepts a recording that does what the script says", () => assert.deepEqual(checkRecording(script, recorded), []));
  it("rejects a recording whose click opened nothing or whose input changed nothing", () => {
    const bad = recorded.map((s, i) =>
      i === 1 ? { ...s, calls: { dispatchClick: 1 }, dialogs: [] } : i === 2 ? { ...s, modelChanged: [], domDelta: [], domDeltaCount: 0 } : s
    );
    const out = checkRecording(script, bad).join("\n");
    assert.match(out, /expected one editBurg call, got 0/);
    assert.match(out, /expected #burgEditor open/);
    assert.match(out, /changed nothing/);
  });
  it("judges a replay arm step by step and keeps the resume", () => {
    const resume = { currentMs: 1200, refinedMs: 2000, timedOut: false, prepares: 1, lastPrepareMs: 1000 };
    const replayed = recorded.map((s, i) => ({
      ...s,
      gpu: i === 0 || i === 3 ? gpu({ state: "active", suspendedReason: null, canvasVisible: true }) : gpu(),
      resume: i === 3 ? resume : undefined
    }));
    const pass = judgeArm(script, "gpu", recorded, replayed, 60000);
    assert.equal(pass.pass, true, pass.failures.join("; "));
    assert.deepEqual(pass.resume, resume);
    const broken = replayed.map((s, i) => (i === 2 ? { ...s, model: { ...s.model, "pack.burgs": "changed" } } : s));
    const fail = judgeArm(script, "gpu", recorded, broken, 60000);
    assert.equal(fail.pass, false);
    assert.match(fail.failures.join(), /step 2 input: model differs in pack\.burgs/);
    assert.match(judgeArm(script, "gpu", recorded, replayed.slice(0, 2), 60000).failures.join(), /replayed 2 of 4/);
  });
});
