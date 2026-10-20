// Lake editor (REWRITE-PLAN §5 rows 29 and 30; features/overlays split, EDIT-B): click-select lake 12 (freshwater,
// 48 shore vertices), rename it, move it to the salt group (the <use> changes parent in #lakes), drag a shore vertex
// (pack.vertices.p and the shared #feature_12 path in defs change), close.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const script: EditorScript = {
  name: "lake",
  editor: "editLake",
  dialog: "#lakeEditor",
  rows: [29, 30],
  description: "select lake 12, rename, change group, drag shore vertex 0, close",
  steps: [
    { op: "display", off: CLUTTER },
    { op: "display", off: ["zones", "states", "provinces", "religions", "cultures"] },
    { op: "camera", k: 16, focus: { world: [323, 507] } },
    { op: "click", target: { css: '#lakes use[data-f="12"]' }, expect: { editor: "editLake", dialog: "#lakeEditor" } },
    { op: "input", id: "lakeName", value: "Replay Mere", note: "rename" },
    { op: "input", id: "lakeGroup", value: "salt", event: "change", note: "move to the salt group" },
    { op: "drag", target: { css: "#vertices circle", nth: 0 }, path: [[4, 3], [9, 6], [14, 8]], note: "drag a shore vertex" },
    { op: "close", dialog: "#lakeEditor" }
  ]
};
export default script;
