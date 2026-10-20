// River editor (REWRITE-PLAN §5 rows 29 and 30; features/overlays split, EDIT-B): click-select river 228 (the fixture's
// widest, 15 cells), rename it, retype it, change its source width and width factor (the path d is redrawn), drag a
// control point (river.points/cells change and the path is redrawn), close. Opening the editor forces the cells layer on
// and closing turns it off again, like the route editor.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const script: EditorScript = {
  name: "river",
  editor: "editRiver",
  dialog: "#riverEditor",
  rows: [29, 30],
  description: "select river 228, rename, retype, source width, width factor, drag a control point, close",
  steps: [
    { op: "display", off: CLUTTER },
    // the area fills above #rivers take the pointer on a thin river
    { op: "display", off: ["zones", "states", "provinces", "religions", "cultures"] },
    { op: "camera", k: 16, focus: { world: [259.95, 397.46] } },
    { op: "click", target: { css: "#rivers path#river228" }, expect: { editor: "editRiver", dialog: "#riverEditor" } },
    { op: "input", id: "riverName", value: "Replay Water", note: "rename" },
    { op: "input", id: "riverType", value: "creek", note: "type" },
    { op: "input", id: "riverSourceWidth", value: 0.8, note: "source width (redraws the path)" },
    { op: "input", id: "riverWidthFactor", value: 2, note: "width factor (redraws the path)" },
    { op: "drag", target: { css: "#controlPoints circle", nth: "middle" }, path: [[6, 4], [14, 10], [22, 14]], note: "drag a control point" },
    { op: "close", dialog: "#riverEditor" }
  ]
};
export default script;
