// Label editor (REWRITE-PLAN §5 rows 10 and 29): click-select the custom label "Straight Name" (label900) on a tspan,
// change its text, drag the label, drag one of its path control points (the textPath d in #defs changes), close.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const script: EditorScript = {
  name: "label",
  editor: "editLabel",
  dialog: "#labelEditor",
  rows: [10, 29],
  description: "select label900, change text, drag label, drag a path control point, close",
  steps: [
    // the parity fixture shows every layer: hide the data overlays that cover the editable features
    { op: "display", off: CLUTTER },
    // the label's box centre (499.7..615.0, 376.3..398.3); a css focus would read a culled label's empty box at k 1
    { op: "camera", k: 4, focus: { world: [557.3, 387.3] } },
    { op: "click", target: { label: "label900" }, expect: { editor: "editLabel", dialog: "#labelEditor" } },
    { op: "input", id: "labelText", value: "Replay Straight", note: "text" },
    { op: "drag", target: { label: "label900" }, path: [[10, 0], [24, -6], [32, -10]], note: "drag the label" },
    { op: "drag", target: { css: "#controlPoints circle", nth: 1 }, path: [[0, 8], [4, 16], [6, 20]], note: "drag a control point" },
    { op: "close", dialog: "#labelEditor" }
  ]
};
export default script;
