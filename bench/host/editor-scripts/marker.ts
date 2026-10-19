// Marker editor (REWRITE-PLAN §5 rows 13 and 29): click-select a marker, resize it through the editor, drag it to a
// new spot (pack.markers x/y/cell change on drag end), close. Unlike the other scripts it keeps every layer of the
// parity fixture on (the data overlays add ~170 compat runs), so its resume is the dense-map data point.
import type { EditorScript } from "../editor-replay-core.ts";

const script: EditorScript = {
  name: "marker",
  editor: "editMarker",
  dialog: "#markerEditor",
  rows: [13, 29],
  description: "click-select marker 43, resize, drag 40 px, close",
  steps: [
    { op: "camera", k: 8, focus: { marker: 43 } },
    { op: "click", target: { marker: 43 }, expect: { editor: "editMarker", dialog: "#markerEditor" } },
    { op: "input", id: "markerSize", value: 36, note: "size 36" },
    { op: "drag", target: { marker: 43 }, path: [[10, 4], [24, 10], [40, 16]], note: "drag the marker" },
    { op: "close", dialog: "#markerEditor" }
  ]
};
export default script;
