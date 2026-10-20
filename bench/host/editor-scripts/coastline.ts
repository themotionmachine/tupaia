// Coastline editor (REWRITE-PLAN §5 rows 29 and 30; features/overlays split, EDIT-B): click-select the coastline of
// island 4 (15 shore vertices; the coastline is a stroked <use>, so the click is a map point on the stroke and the
// hit must name the same element), move it to the lake_island group (the <use> changes parent in #coastline), drag a
// shore vertex (pack.vertices.p and the shared #feature_4 path in defs change), close.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

// a point on the island-4 coastline path (feature_4 at 37% of its length)
const SHORE: [number, number] = [974.67, 173.78];

const script: EditorScript = {
  name: "coastline",
  editor: "editCoastline",
  dialog: "#coastlineEditor",
  rows: [29, 30],
  description: "select island 4's coastline, change group, drag a shore vertex, close",
  steps: [
    { op: "display", off: CLUTTER },
    { op: "display", off: ["zones", "states", "provinces", "religions", "cultures"] },
    { op: "camera", k: 16, focus: { world: SHORE } },
    { op: "click", target: { point: { world: SHORE } }, expect: { editor: "editCoastline", dialog: "#coastlineEditor" } },
    { op: "input", id: "coastlineGroup", value: "lake_island", event: "change", note: "move to the lake_island group" },
    { op: "drag", target: { css: "#vertices circle", nth: 0 }, path: [[4, 3], [9, 6], [14, 8]], note: "drag a shore vertex" },
    { op: "close", dialog: "#coastlineEditor" }
  ]
};
export default script;
