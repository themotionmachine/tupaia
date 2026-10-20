// Regiment editor (REWRITE-PLAN §5 rows 29 and 30; features/overlays split, EDIT-B): click-select regiment 1-0 (the
// military layer is the target, so unlike the other scripts it stays on), rename it, change a unit count, switch it
// to a fleet and back (the box geometry is rewritten), drag the regiment, drag its base marker and its rotation
// control (reg.x/y, bx/by, angle), split it (a new regiment is drawn below), close.
import type { EditorScript } from "../editor-replay-core.ts";

const script: EditorScript = {
  name: "regiment",
  editor: "editRegiment",
  dialog: "#regimentEditor",
  rows: [29, 30],
  description: "select regiment 1-0, rename, unit count, land/fleet, drag, drag base, rotate, split, close",
  steps: [
    // the parity fixture shows every layer: hide the data overlays that cover the armies (not "military": it is the target)
    { op: "display", off: ["goods", "markets", "precipitation", "population", "temperature"] },
    { op: "display", off: ["zones", "states", "provinces", "religions", "cultures"] },
    { op: "camera", k: 8, focus: { world: [748.1, 506.04] } },
    { op: "click", target: { css: "#armies #regiment1-0 > rect" }, expect: { editor: "editRegiment", dialog: "#regimentEditor" } },
    { op: "input", id: "regimentName", value: "Replay Guard", event: "change", note: "rename" },
    { op: "input", css: '#regimentComposition input[data-u="infantry"]', value: 4000, event: "change", note: "infantry count" },
    { op: "button", id: "regimentType", note: "land to fleet" },
    { op: "button", id: "regimentType", note: "fleet to land" },
    { op: "drag", target: { css: "#armies #regiment1-0 > rect" }, path: [[10, 6], [24, 14], [40, 20]], note: "drag the regiment" },
    { op: "drag", target: { css: "#regimentBase circle" }, path: [[6, 4], [14, 8], [20, 10]], note: "drag the base" },
    { op: "drag", target: { css: "#rotationControl" }, path: [[0, 10], [-6, 24], [-14, 30]], note: "rotate" },
    { op: "button", id: "regimentSplit", note: "split (a new regiment is drawn)" },
    { op: "close", dialog: "#regimentEditor" }
  ]
};
export default script;
