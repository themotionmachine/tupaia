// Node-side, browser-free part of the G-E editor replay (PROOF-PLAN §5; bench/host/editor-replay.ts runs it): the
// script vocabulary, script validation, and the comparison of a replayed arm against the SVG recording. Pure, so
// `node --test bench/host/editor-replay-core.test.ts` pins the verdict rules without a browser.

export const ARMS = ["svg", "gpu", "gpu-select"] as const;
export type Arm = (typeof ARMS)[number];

// The query string each arm adds to the app URL. svg is the stock renderer (no flag); gpu is rendering-only (clicks
// hit the canonical SVG natively); gpu-select also routes clicks through the GPU pick index (editor-dispatch.ts).
export function armQuery(arm: Arm): string {
  return arm === "svg" ? "" : arm === "gpu" ? "&renderer=gpu" : "&renderer=gpu&gpu-select";
}

export function parseArms(text: string | undefined): Arm[] {
  const list = (text ?? "").trim() ? text!.split(",").map(s => s.trim()) : [...ARMS];
  for (const arm of list) if (!(ARMS as readonly string[]).includes(arm)) throw new Error(`unknown arm ${arm}; arms are ${ARMS.join(", ")}`);
  if (!list.includes("svg")) throw new Error("the svg arm is the recording; it must be in the arm list");
  return [...new Set(list)] as Arm[];
}

// ------------------------------------------------------------------ script vocabulary

/** A world point, resolved in the recording (svg) arm from the model, then frozen into the recording. */
export type Focus =
  | { world: [number, number] }
  | { burg: number }
  | { marker: number }
  | { route: number }
  | { css: string };

/**
 * What a pointer action aims at. Resolved in the svg arm to an integer client point whose canonical hit lies in the
 * target (and its ±2 px neighbours do too, so a 1 px difference in layout cannot change the hit). The replay arms reuse
 * that point and check that the canonical SVG hit there names the same element.
 */
export type Target =
  | { burg: number } // the burg's label, #burgLabels text[data-id]
  | { label: string } // a #labels text by id; the hit must be a tspan (clicked()'s labels branch)
  | { route: number } // #routes path#route<i>
  | { marker: number } // #markers svg#marker<i>
  | { relief: "nearest" } // the compact-raster relief sprite nearest the view centre that clicked() would pick
  | { selected: true } // the editor's current elSelected
  | { css: string; nth?: number | "middle" | "last" } // any element under svg#map, e.g. "#controlPoints circle"
  | { point: Focus; offset?: [number, number] }; // a map point (creator modes, brushes): no element required

export interface Expect {
  editor?: string;
  dialog?: string;
}

/** A form control or button: its element id, or a selector (`css`). Exactly one of the two. */
export type Control = { id: string; css?: undefined } | { css: string; id?: undefined };

export type Step =
  // layer visibility through the bridge's display tool (MCP names, e.g. "goods"): view state, the same in every arm
  | { op: "display"; on?: string[]; off?: string[]; note?: string }
  | { op: "camera"; k: number; focus: Focus; note?: string }
  | { op: "click"; target: Target; expect?: Expect; note?: string }
  // Open an editor from the Tools panel by clicking its button (#editStatesButton): the editors with no map target.
  | { op: "open"; button: string; expect?: Expect; note?: string }
  // Set a form control (by id, or any selector under the page) and fire its event. `checked` drives a checkbox.
  // `uiOnly`: the control sets editor state that no model/DOM/canvas change shows by itself (a brush size)
  | ({ op: "input"; value?: string | number; checked?: boolean; event?: "input" | "change"; uiOnly?: boolean; note?: string } & Control)
  // Click a button: by id, or by a Playwright selector (e.g. `.ui-dialog-buttonset button:has-text("Keep")`).
  // `mustChange`: the recording must show the click changed the model or the model DOM (an undo that undoes nothing
  // proves nothing). `dom`: click through the DOM (el.click()) instead of a pointer click, for a control in the
  // collapsed options panel that no pointer can reach (the heightmap editor's template and image buttons).
  | ({ op: "button"; expect?: Expect; mustChange?: boolean; dom?: boolean; note?: string } & Control)
  // node drag or brush stroke: mouse down on the target, move through `path` (client px offsets from the start), up.
  // The camera must not move at any point of it (PROOF-PLAN §5 "no camera pan during a brush stroke").
  | { op: "drag"; target: Target; path: [number, number][]; brush?: boolean; note?: string }
  // Close the editor: the dialog's titlebar close button, or `via` (a selector) for an editor that ends otherwise
  // (heightmap: #exitCustomization). The resume is measured from this click.
  | { op: "close"; dialog: string; via?: string; note?: string }
  | { op: "key"; key: string; note?: string };

export interface EditorScript {
  /** File name under editor-scripts/, e.g. "burg". */
  name: string;
  /** The editor global the script exercises, e.g. "editBurg". */
  editor: string;
  /** Its jQuery UI dialog content id, e.g. "#burgEditor". */
  dialog: string;
  /** REWRITE-PLAN §5 rows the script gives evidence for. */
  rows: number[];
  description: string;
  steps: Step[];
}

const OPS = new Set(["display", "camera", "click", "open", "input", "button", "drag", "close", "key"]);

export function validateScript(script: EditorScript): string[] {
  const errors: string[] = [];
  const at = (i: number, message: string) => errors.push(`${script.name} step ${i}: ${message}`);
  if (!script.name || !/^[a-z][a-z0-9-]*$/.test(script.name)) errors.push(`bad script name ${JSON.stringify(script.name)}`);
  if (!/^[A-Za-z]\w*$/.test(script.editor ?? "")) errors.push(`${script.name}: editor must be a global function name`);
  if (!/^#[\w-]+$/.test(script.dialog ?? "")) errors.push(`${script.name}: dialog must be "#id"`);
  if (!Array.isArray(script.steps) || !script.steps.length) errors.push(`${script.name}: no steps`);
  let opened = false;
  (script.steps ?? []).forEach((step, i) => {
    if (!OPS.has(step.op)) return at(i, `unknown op ${step.op}`);
    if (step.op === "camera" && !(step.k >= 1 && step.k <= 20)) at(i, "camera k must be within the app's 1..20");
    if (step.op === "display" && !(step.on?.length || step.off?.length)) at(i, "display needs on or off layers");
    if ((step.op === "click" || step.op === "open" || step.op === "button") && step.expect?.dialog === script.dialog) opened = true;
    if (step.op === "open" && !/^[A-Za-z][\w-]*$/.test(step.button ?? "")) at(i, "open needs a Tools button id");
    if (step.op === "input" || step.op === "button") {
      if (!!step.id === !!step.css) at(i, `${step.op} needs exactly one of id or css`);
      if (step.op === "input" && step.value === undefined && step.checked === undefined) at(i, "input needs a value or checked");
    }
    if (step.op === "drag") {
      if (!step.path?.length) at(i, "drag needs a path");
      else if (step.path.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) at(i, "drag path entries are [dx, dy]");
    }
    if (step.op === "close" && !/^#[\w-]+$/.test(step.dialog)) at(i, 'close needs a dialog "#id"');
  });
  if (!opened) errors.push(`${script.name}: no click, open or button step expects ${script.dialog} to open`);
  const last = script.steps?.[script.steps.length - 1];
  if (last && last.op !== "close") errors.push(`${script.name}: the last step must close the editor (the resume is measured there)`);
  return errors;
}

// ------------------------------------------------------------------ observations

export interface Camera {
  k: number;
  x: number;
  y: number;
}

export interface GpuState {
  active: string | null;
  fallbackReason: string | null;
  state: string | null;
  suspendedReason: string | null;
  canvasVisible: boolean | null;
  pending: boolean | null;
  settledMs?: number | null;
}

export interface Resume {
  /** Close input (the trusted click on the dialog's close button) to the first current GPU frame on screen. */
  currentMs: number | null;
  /** Close input to the first frame that is also refined (no refinement pending, not moving). */
  refinedMs: number | null;
  timedOut: boolean;
  prepares: number | null;
  lastPrepareMs: number | null;
  lastPrepare?: unknown;
}

export interface StepObservation {
  index: number;
  op: Step["op"];
  note?: string;
  /** Client point the pointer action used (frozen from the svg arm). */
  point?: { x: number; y: number };
  /** Path of the canonical SVG element under `point` before the action. */
  hitKey?: string | null;
  camera: Camera;
  /** Pointer moves during the step that saw a camera other than the step's starting one. */
  cameraMoves: number;
  /** pack/grid/notes section hashes after the step. */
  model: Record<string, string>;
  /** Sections whose hash this step changed. */
  modelChanged: string[];
  /** Per-layer hashes of the model DOM (svg#map children, #viewbox children) after the step. */
  dom: Record<string, string>;
  /** Net model-DOM changes of the step: attribute values, child lists and text, by element path. */
  domDelta: string[];
  domDeltaCount: number;
  /** 2d canvases inside svg#map whose pixels this step changed (their hashes are part of `dom`). */
  canvasChanged?: string[];
  /** Calls during the step: dispatchClick and each editor global. */
  calls: Record<string, number>;
  /** Editor dialogs open after the step. */
  dialogs: string[];
  errors: string[];
  gpu?: GpuState;
  /** gpu-select: click-route outcomes during the step (routed/resynced/dropped/legacy deltas). */
  routes?: Record<string, number>;
  resume?: Resume;
  ms: number;
}

// ------------------------------------------------------------------ comparison

const MAX_LIST = 6;

function setDiff(a: readonly string[], b: readonly string[]): string[] {
  const other = new Set(b);
  return a.filter(x => !other.has(x));
}

/**
 * Mismatches of one replayed step against the recorded (svg) step: the same canonical hit, the same pack/grid and
 * model-DOM state and deltas, the same dispatch counts (more = double dispatch), the same dialogs, and no camera move.
 */
export function compareStep(rec: StepObservation, rep: StepObservation): string[] {
  const out: string[] = [];
  const tag = `step ${rec.index} ${rec.op}${rec.note ? ` (${rec.note})` : ""}`;
  if (rec.hitKey !== undefined && rec.hitKey !== rep.hitKey) out.push(`${tag}: canonical hit ${rep.hitKey} != recorded ${rec.hitKey}`);
  const modelKeys = [...new Set([...Object.keys(rec.model), ...Object.keys(rep.model)])].sort();
  const modelDiff = modelKeys.filter(k => rec.model[k] !== rep.model[k]);
  if (modelDiff.length) out.push(`${tag}: model differs in ${modelDiff.slice(0, MAX_LIST).join(", ")}${modelDiff.length > MAX_LIST ? ` (+${modelDiff.length - MAX_LIST})` : ""}`);
  const domKeys = [...new Set([...Object.keys(rec.dom), ...Object.keys(rep.dom)])].sort();
  const domDiff = domKeys.filter(k => rec.dom[k] !== rep.dom[k]);
  if (domDiff.length) out.push(`${tag}: model DOM differs in ${domDiff.slice(0, MAX_LIST).join(", ")}${domDiff.length > MAX_LIST ? ` (+${domDiff.length - MAX_LIST})` : ""}`);
  if (rec.domDeltaCount !== rep.domDeltaCount || setDiff(rec.domDelta, rep.domDelta).length || setDiff(rep.domDelta, rec.domDelta).length) {
    const missing = setDiff(rec.domDelta, rep.domDelta).slice(0, 3);
    const extra = setDiff(rep.domDelta, rec.domDelta).slice(0, 3);
    out.push(`${tag}: DOM delta ${rep.domDeltaCount} entries vs recorded ${rec.domDeltaCount}; missing ${JSON.stringify(missing)} extra ${JSON.stringify(extra)}`);
  }
  for (const name of [...new Set([...Object.keys(rec.calls), ...Object.keys(rep.calls)])].sort()) {
    const a = rec.calls[name] ?? 0;
    const b = rep.calls[name] ?? 0;
    if (b > a) out.push(`${tag}: double dispatch: ${name} called ${b}x (recorded ${a}x)`);
    else if (b < a) out.push(`${tag}: missing dispatch: ${name} called ${b}x (recorded ${a}x)`);
  }
  if (rec.dialogs.join() !== rep.dialogs.join()) out.push(`${tag}: dialogs [${rep.dialogs}] != recorded [${rec.dialogs}]`);
  if (rep.cameraMoves) out.push(`${tag}: camera moved during the pointer action (${rep.cameraMoves} moves)`);
  if (rep.camera.k !== rec.camera.k || rep.camera.x !== rec.camera.x || rep.camera.y !== rec.camera.y)
    out.push(`${tag}: camera ${JSON.stringify(rep.camera)} != recorded ${JSON.stringify(rec.camera)}`);
  for (const error of rep.errors) out.push(`${tag}: page error ${error}`);
  return out;
}

/** The GPU-arm invariants of one step: suspended (canvas hidden) while an editor is open, resumed after the close. */
export function checkGpuStep(step: StepObservation, arm: Arm, resumeLimitMs: number): string[] {
  if (arm === "svg") return [];
  const out: string[] = [];
  const tag = `step ${step.index} ${step.op}`;
  const gpu = step.gpu;
  if (!gpu) return [`${tag}: no GPU state recorded`];
  if (gpu.active !== "gpu") return [`${tag}: GPU fell back: ${gpu.fallbackReason}`];
  // The renderer must reach a current frame after every action that leaves no editor open (camera moves, the close):
  // null = rp.settle gave up. A display step is skipped: it never waits (the camera step after it does).
  if (!step.dialogs.length && step.op !== "display" && gpu.settledMs === null)
    out.push(`${tag}: the GPU never reached a current frame (settle gave up) with no editor open`);
  if (step.dialogs.length) {
    if (!gpu.suspendedReason) out.push(`${tag}: editor open but the GPU is not suspended`);
    if (gpu.canvasVisible) {
      const stale = (step as { staleCanvas?: { over16: number; fraction: number } }).staleCanvas;
      out.push(`${tag}: editor open but the GPU canvas is still on screen${stale ? ` (${stale.over16} px differ from the SVG under it by >16)` : ""}`);
    }
  }
  if (step.op === "close" && !step.dialogs.length) {
    const resume = step.resume;
    if (!resume) out.push(`${tag}: no resume measured`);
    else if (resume.currentMs == null) out.push(`${tag}: GPU did not resume within ${resumeLimitMs} ms`);
    else if (resume.refinedMs == null) out.push(`${tag}: GPU resumed but did not refine within ${resumeLimitMs} ms`);
    if (gpu.suspendedReason) out.push(`${tag}: still suspended after close: ${gpu.suspendedReason}`);
  }
  if (arm === "gpu-select" && step.routes) {
    const total = Object.values(step.routes).reduce((a, b) => a + b, 0);
    if (total > 1) out.push(`${tag}: ${total} click-route outcomes for one action ${JSON.stringify(step.routes)}`);
    if (step.routes.dropped) out.push(`${tag}: click dropped by the GPU route at an exact camera`);
  }
  return out;
}

/** Problems with the recording itself (svg arm): a script that does not do what it says proves nothing. */
export function checkRecording(script: EditorScript, steps: StepObservation[]): string[] {
  const out: string[] = [];
  steps.forEach((step, i) => {
    const spec = script.steps[i];
    const tag = `${script.name} step ${i} ${step.op}`;
    if (step.cameraMoves) out.push(`${tag}: camera moved in the svg recording`);
    for (const error of step.errors) out.push(`${tag}: page error in the svg recording: ${error}`);
    const opens = spec?.op === "click" || spec?.op === "open" || spec?.op === "button";
    if (opens && spec.expect?.editor && (step.calls[spec.expect.editor] ?? 0) !== 1)
      out.push(`${tag}: expected one ${spec.expect.editor} call, got ${step.calls[spec.expect.editor] ?? 0}`);
    if (opens && spec.expect?.dialog && !step.dialogs.includes(spec.expect.dialog))
      out.push(`${tag}: expected ${spec.expect.dialog} open, open: [${step.dialogs}]`);
    if (spec && (spec.op === "drag" || (spec.op === "input" && !spec.uiOnly) || (spec.op === "button" && spec.mustChange)) && !step.domDeltaCount && !step.modelChanged.length && !step.canvasChanged?.length)
      out.push(`${tag}: changed nothing (a no-op step proves nothing)`);
  });
  const last = steps[steps.length - 1];
  if (last && last.dialogs.length) out.push(`${script.name}: editor still open after the last step: [${last.dialogs}]`);
  return out;
}

export interface ArmVerdict {
  script: string;
  arm: Arm;
  pass: boolean;
  failures: string[];
  resume: Resume | null;
  steps: number;
}

export function judgeArm(script: EditorScript, arm: Arm, recorded: StepObservation[], replayed: StepObservation[], resumeLimitMs: number): ArmVerdict {
  const failures: string[] = [];
  if (arm === "svg") failures.push(...checkRecording(script, recorded));
  else {
    if (replayed.length !== recorded.length) failures.push(`${script.name}: replayed ${replayed.length} of ${recorded.length} steps`);
    for (let i = 0; i < Math.min(recorded.length, replayed.length); i++) failures.push(...compareStep(recorded[i], replayed[i]));
    for (const step of replayed) failures.push(...checkGpuStep(step, arm, resumeLimitMs));
  }
  const closing = [...replayed].reverse().find(s => s.op === "close" && s.resume);
  return { script: script.name, arm, pass: failures.length === 0, failures, resume: closing?.resume ?? null, steps: replayed.length };
}
