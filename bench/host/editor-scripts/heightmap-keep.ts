// Heightmap editor, Keep mode (REWRITE-PLAN §5 rows 14 and 29, terrain): the cheap leave of the editor. Keep mode edits
// land heights only (the "only land cells" filter is forced, the coastline stays) and keeps every other data layer:
// finalizeHeightmap runs restoreKeptData (pack.cells.h from grid.cells.h) instead of the Erase mode regeneration of
// the heightmap script. Strokes lower and smooth, then the brush undo/redo and a global smooth, and "Exit
// customization". See heightmap.ts for the Erase mode flow and for the brush time-stamp pin.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

// a land point of the parity fixture (grid cell 2873, height 23)
const LAND: [number, number] = [730, 408];

const script: EditorScript = {
  name: "heightmap-keep",
  editor: "editHeightmap",
  dialog: "#brushesPanel",
  rows: [14, 29],
  description: "keep mode: lower and smooth strokes, undo/redo, smooth all, finalize without regenerating",
  steps: [
    { op: "display", off: CLUTTER },
    { op: "camera", k: 2, focus: { world: [640, 360] } },
    { op: "open", button: "editHeightmapButton", expect: { editor: "editHeightmap", dialog: "#alert" } },
    { op: "button", css: '.ui-dialog:has(#alert) .ui-dialog-buttonset button:has-text("Keep")', expect: { dialog: "#brushesPanel" }, note: "keep mode" },
    { op: "button", id: "brushLower", note: "lower brush" },
    { op: "drag", target: { point: { world: LAND } }, path: [[16, 0], [32, 8], [48, 8]], brush: true, note: "lower stroke" },
    { op: "button", id: "brushSmooth", note: "smooth brush" },
    { op: "drag", target: { point: { world: LAND }, offset: [0, 30] }, path: [[16, 0], [32, -6], [48, -6]], brush: true, note: "smooth stroke" },
    { op: "button", id: "undo", mustChange: true, note: "brush undo" },
    { op: "button", id: "redo", mustChange: true, note: "brush redo" },
    { op: "button", id: "smoothHeights", mustChange: true, note: "smooth all heights" },
    { op: "close", dialog: "#brushesPanel", via: "#exitCustomization" }
  ]
};
export default script;
