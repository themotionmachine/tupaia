// node --test bench/host/editor-replay-core.test.ts — the replay verdict rules, and the shipped scripts' shape.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  armQuery,
  checkGpuStep,
  checkRecording,
  checkStaleResume,
  compareStep,
  type EditorScript,
  judgeArm,
  maxSteadyBytes,
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
    assert.match(errors, /no click, open or button step expects #burgEditor/);
    assert.match(errors, /last step must close/);
  });
  it("accepts the Tools-panel open op, selector controls and a close via another button", () => {
    const tools: EditorScript = {
      ...script,
      steps: [
        { op: "open", button: "editBurgsButton", expect: { editor: "editBurg", dialog: "#burgEditor" } },
        { op: "input", css: "#burgsBody .name", value: "x" },
        { op: "input", id: "check", checked: true, uiOnly: true },
        { op: "button", css: '.ui-dialog-buttonset button:has-text("Keep")', mustChange: true },
        { op: "close", dialog: "#burgEditor", via: "#exitCustomization" }
      ]
    };
    assert.deepEqual(validateScript(tools), []);
  });
  it("rejects a control with both or neither of id and css, an input with no value, a bad open button", () => {
    const bad = {
      ...script,
      steps: [
        { op: "open", button: "#editBurgsButton", expect: { dialog: "#burgEditor" } },
        { op: "input", id: "a", css: "#a", value: "x" },
        { op: "input", id: "b" },
        { op: "button" },
        { op: "close", dialog: "#burgEditor" }
      ]
    } as unknown as EditorScript;
    const errors = validateScript(bad).join("\n");
    assert.match(errors, /open needs a Tools button id/);
    assert.match(errors, /step 1: input needs exactly one of id or css/);
    assert.match(errors, /step 2: input needs a value or checked/);
    assert.match(errors, /step 3: button needs exactly one of id or css/);
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
  it("fails a GPU arm that never reached a current frame with no editor open (settledMs null)", () => {
    const idle = (over = {}) => step({ op: "camera", dialogs: [], gpu: gpu({ state: "active", suspendedReason: null, canvasVisible: true, settledMs: 120, ...over }) });
    assert.deepEqual(checkGpuStep(idle(), "gpu", 1000), []);
    assert.match(checkGpuStep(idle({ settledMs: null }), "gpu", 1000).join(), /never reached a current frame/);
    // a display step does not wait for the GPU (the camera step after it does)
    assert.deepEqual(checkGpuStep({ ...idle({ settledMs: null }), op: "display" }, "gpu", 1000), []);
    // with an editor open the suspended/hidden checks speak for it
    assert.deepEqual(checkGpuStep(step({ gpu: gpu({ settledMs: null }) }), "gpu", 1000), []);
  });
  it("requires a measured, refined resume after the close", () => {
    const closed = (resume: any) => step({ op: "close", dialogs: [], gpu: gpu({ state: "active", suspendedReason: null, canvasVisible: true }), resume });
    assert.deepEqual(checkGpuStep(closed({ currentMs: 900, refinedMs: 1500, timedOut: false, prepares: 1, lastPrepareMs: 800 }), "gpu", 60000), []);
    assert.match(checkGpuStep(closed(undefined), "gpu", 60000).join(), /no resume measured/);
    assert.match(checkGpuStep(closed({ currentMs: null, refinedMs: null, timedOut: true, prepares: 0, lastPrepareMs: null }), "gpu", 60000).join(), /did not resume/);
    assert.match(checkGpuStep(closed({ currentMs: 900, refinedMs: null, timedOut: true, prepares: 1, lastPrepareMs: 1 }), "gpu", 60000).join(), /did not refine/);
  });
  // RES2: the dense parity world held 160.64 MiB against the 160 MiB steady budget at W3 and no check saw it
  it("fails a settled step or a refined resume over the steady GPU budget, and reports the arm's maximum", () => {
    const budget = 160 * 2 ** 20;
    const idle = (total: number, settledMs: number | null = 100) =>
      step({ op: "camera", dialogs: [], gpu: gpu({ state: "active", suspendedReason: null, canvasVisible: true, settledMs, memory: { total, budget } }) });
    assert.deepEqual(checkGpuStep(idle(budget), "gpu", 1000), []);
    assert.match(checkGpuStep(idle(budget + 671089), "gpu", 1000).join(), /steady GPU memory 160\.64 MiB over the 160\.00 MiB budget/);
    // not settled (a prepare may be in flight: old and new frames coexist up to PEAK_LIMIT): not a steady reading
    assert.deepEqual(checkGpuStep(idle(budget + 1, null), "gpu", 1000).filter(f => /steady/.test(f)), []);
    const closed = step({
      op: "close",
      dialogs: [],
      gpu: gpu({ state: "active", suspendedReason: null, canvasVisible: true }),
      resume: { currentMs: 900, refinedMs: 1500, timedOut: false, prepares: 1, lastPrepareMs: 800, steadyBytes: budget + 1, budget }
    });
    assert.match(checkGpuStep(closed, "gpu", 60000).join(), /at the refined frame over the 160\.00 MiB budget/);
    assert.equal(maxSteadyBytes([idle(10), closed, idle(20, null)]), budget + 1);
    assert.equal(maxSteadyBytes([step()]), null);
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
  it("counts a canvas repaint as a change, and holds a mustChange button to it", () => {
    const undo: EditorScript = { ...script, steps: [...script.steps.slice(0, 3), { op: "button", id: "undo", mustChange: true }, script.steps[3]] };
    const base = recorded.slice(0, 3);
    const none = [...base, step({ index: 3, op: "button", calls: {}, hitKey: undefined, domDelta: [], domDeltaCount: 0 }), { ...recorded[3], index: 4 }];
    assert.match(checkRecording(undo, none).join(), /step 3 button: changed nothing/);
    const painted = [...base, { ...none[3], canvasChanged: ["canvas #temp>canvas:0"] }, { ...recorded[3], index: 4 }];
    assert.deepEqual(checkRecording(undo, painted), []);
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

describe("D13 stale resume", () => {
  const resume = (staleShown: number) => ({
    currentMs: 900,
    refinedMs: 1500,
    timedOut: false,
    prepares: 1,
    lastPrepareMs: 800,
    staleShown,
    staleFirst: staleShown ? { at: 16, frameRevision: 3, revision: 5, via: "reveal" } : null
  });
  const open = step({ index: 1, domDeltaCount: 0, domDelta: [] });
  const settled = { gpu: gpu({ state: "active", suspendedReason: null, canvasVisible: true, pending: false }) }; // a step whose GPU frame is current
  const edit = step({ index: 2, op: "input", domDeltaCount: 2 });
  const quiet = step({ index: 2, op: "input", domDeltaCount: 0, domDelta: [], modelChanged: [] });
  const close = (staleShown: number, over: Partial<StepObservation> = {}) =>
    step({ index: 3, op: "close", dialogs: [], domDeltaCount: 0, domDelta: [], resume: resume(staleShown), ...over });

  it("fails a changing session whose close showed a frame older than the DOM", () => {
    const out = checkStaleResume([open, edit, close(2)]);
    assert.equal(out.length, 1);
    assert.match(out[0], /stale GPU frame visible after a changing edit closed, 2x \(first \+16 ms via reveal: frame revision 3 < 5\)/);
  });

  it("passes a changing session with no stale frame, and a session that changed nothing", () => {
    assert.deepEqual(checkStaleResume([open, edit, close(0)]), []);
    assert.deepEqual(checkStaleResume([open, quiet, close(3)]), []);
  });

  it("a change made by the close itself or in the model only counts; each session is judged on its own", () => {
    assert.equal(checkStaleResume([open, quiet, close(1, { domDeltaCount: 1 })]).length, 1);
    assert.equal(checkStaleResume([open, step({ index: 2, op: "input", domDeltaCount: 0, modelChanged: ["pack.burgs"] }), close(1)]).length, 1);
    const moved = { "#viewbox>#labels": "x2", "#defs": "y" }; // the second session's edit, net
    assert.deepEqual(checkStaleResume([open, edit, close(0), step({ index: 4 }), close(1, { index: 5, dom: moved })]).length, 1);
    assert.deepEqual(checkStaleResume([open, edit, close(0, settled), step({ index: 4, domDeltaCount: 0 }), close(1, { index: 5 })]), []);
  });

  it("judges the net change from the step before the open to the close (W3 LIFE3 net-change reading)", () => {
    const before = step({ index: 0, op: "display", dialogs: [], dom: { "#viewbox>#icons": "raster" }, ...settled });
    const swapped = step({ index: 1, dom: { "#viewbox>#icons": "vectors" } }); // open: rasters to vectors
    const restored = { dom: { "#viewbox>#icons": "raster" } };
    // the DOM moved on open and came back on close: nothing changed, the last frame may show
    assert.deepEqual(checkStaleResume([before, swapped, close(2, restored)]), []);
    // the close left it different: changed, a stale frame fails
    assert.equal(checkStaleResume([before, swapped, close(2, { dom: { "#viewbox>#icons": "moved" } })]).length, 1);
    // a net change of the model the map paints from outside svg#map (a coat of arms in pack.burgs) counts although
    // the DOM came back
    const coa = { "pack.burgs": "coa edited", "pack.cells.h": "b" };
    const modelEdit = step({ index: 2, op: "input", modelChanged: ["pack.burgs"], model: coa, dom: { "#viewbox>#icons": "vectors" } });
    assert.equal(checkStaleResume([before, swapped, modelEdit, close(2, { index: 3, model: coa, ...restored })]).length, 1);
    // the model changed and changed back (burg groups: apply, restore the defaults, apply), or changed only where the
    // map does not paint from (options): the SVG shows what it showed, the last frame may show
    assert.deepEqual(checkStaleResume([before, swapped, modelEdit, close(2, { index: 3, ...restored })]), []);
    const settings = step({ index: 2, op: "input", modelChanged: ["options"], model: { ...before.model, options: "2" } });
    assert.deepEqual(checkStaleResume([before, swapped, settings, close(2, { index: 3, model: settings.model, ...restored })]), []);
    // steps before the open (display, camera) are not part of the session
    const display = step({ index: 0, op: "display", dialogs: [], domDeltaCount: 5, dom: { "#viewbox>#icons": "raster" }, ...settled });
    assert.deepEqual(checkStaleResume([display, swapped, close(1, restored)]), []);
  });

  it("exempts a net-unchanged session only when the step before the open had a settled GPU frame", () => {
    const dom = { "#viewbox>#icons": "raster" };
    const restored = { dom };
    const swapped = step({ index: 1, dom: { "#viewbox>#icons": "vectors" } });
    const base = (over: Partial<StepObservation>) => step({ index: 0, op: "display", dialogs: [], dom, ...over });
    // settled base, nothing changed net: a stale frame may show
    assert.deepEqual(checkStaleResume([base(settled), swapped, close(2, restored)]), []);
    // the frame was already behind (pending) or unknown at the base: the net-unchanged exemption does not apply
    for (const unsettled of [{ gpu: gpu({ state: "active", suspendedReason: null, canvasVisible: true, pending: true }) }, {}, { gpu: gpu({ pending: null }) }])
      assert.equal(checkStaleResume([base(unsettled), swapped, close(2, restored)]).length, 1);
    // edits made in a customization mode before any dialog opens are folded into the base (documented limit)
    const edit = step({ index: 0, op: "input", dialogs: [], dom: { "#viewbox>#icons": "edited" }, domDeltaCount: 3, ...settled });
    assert.deepEqual(checkStaleResume([edit, step({ index: 1, dom: { "#viewbox>#icons": "edited" } }), close(2, { dom: { "#viewbox>#icons": "edited" } })]), []);
  });
});
