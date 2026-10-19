// Burg editor (REWRITE-PLAN §5 rows 12 and 29): click-select burg 44 by its label, rename it, change its population,
// fine-tune its label by dragging, then relocate it with the creator-mode "Relocate" button and a map click (pack.burgs
// x/y/cell and cells.burg change), close.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const script: EditorScript = {
  name: "burg",
  editor: "editBurg",
  dialog: "#burgEditor",
  rows: [12, 29],
  description: "select burg 44, rename, population, drag label, relocate by map click, close",
  steps: [
    // the parity fixture shows every layer: hide the data overlays that cover the editable features
    { op: "display", off: CLUTTER },
    { op: "camera", k: 8, focus: { burg: 44 } },
    { op: "click", target: { burg: 44 }, expect: { editor: "editBurg", dialog: "#burgEditor" } },
    { op: "input", id: "burgName", value: "Replay Khiz", note: "rename" },
    { op: "input", id: "burgPopulation", value: 7.5, event: "change", note: "population" },
    { op: "drag", target: { burg: 44 }, path: [[8, 3], [20, 8], [30, 12]], note: "fine-tune the label" },
    { op: "button", id: "burgRelocate", note: "relocate mode" },
    { op: "click", target: { point: { burg: 44 }, offset: [56, 36] }, note: "relocate click" },
    { op: "close", dialog: "#burgEditor" }
  ]
};
export default script;
