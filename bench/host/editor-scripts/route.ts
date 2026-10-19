// Route editor (REWRITE-PLAN §5 rows 9 and 29): click-select route 18 (7 points), rename it, drag its middle control
// point (pack.routes points and the cells' route connections change), close. Opening the editor forces the cells layer
// on and closing turns it off again, the flow whose GPU resume PERF measures.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const script: EditorScript = {
  name: "route",
  editor: "editRoute",
  dialog: "#routeEditor",
  rows: [9, 29],
  description: "select route 18, rename, drag the middle control point, close",
  steps: [
    // the parity fixture shows every layer: hide the data overlays that cover the editable features
    { op: "display", off: CLUTTER },
    // k 16: a trail stroke is ~4 px wide at k 8, too thin for the ±2 px robust click point
    { op: "camera", k: 16, focus: { route: 18 } },
    { op: "click", target: { route: 18 }, expect: { editor: "editRoute", dialog: "#routeEditor" } },
    { op: "input", id: "routeName", value: "Replay Trail", note: "rename" },
    { op: "drag", target: { css: "#controlPoints circle", nth: "middle" }, path: [[6, 4], [14, 10], [22, 14]], note: "drag a control point" },
    { op: "close", dialog: "#routeEditor" }
  ]
};
export default script;
