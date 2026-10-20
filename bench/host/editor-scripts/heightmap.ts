// Heightmap editor (REWRITE-PLAN §5 rows 14 and 29, terrain): open it from the Tools panel in Erase mode (the only
// mode with the template editor), run a template, undo and redo it with the template undo/redo buttons (history of
// grid.cells.h snapshots), then brush strokes (raise, elevate), the brush undo/redo, a line feature, smooth and
// disrupt, and finish with "Exit customization" (finalizeHeightmap: Erase mode regenerates rivers, biomes,
// cultures, states, burgs ... from the edited heights). The editor sits in customization 1 on `grid`, painting a 2d
// canvas (#heights); the GPU stays suspended for all of it and resumes on the regenerated map.
//
// The brush drops moves by event time stamp (`~~timeStamp % 5`); the replay page pins mousemove stamps to multiples
// of 5 so every arm applies the same moves (editor-replay-page.ts). Math.random is seeded per step, and the
// template editor's generateSeed() draws from it, so the template is the same in every arm.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const script: EditorScript = {
  name: "heightmap",
  editor: "editHeightmap",
  dialog: "#brushesPanel",
  rows: [14, 29],
  description: "erase mode: template run/undo/redo, raise and elevate strokes, undo/redo, line, smooth, disrupt, finalize",
  steps: [
    // the layers on when the editor opens come back when it closes: fewer of them, a lighter resume
    { op: "display", off: CLUTTER },
    { op: "camera", k: 2, focus: { world: [640, 360] } },
    { op: "open", button: "editHeightmapButton", expect: { editor: "editHeightmap", dialog: "#alert" } },
    { op: "button", css: '.ui-dialog:has(#alert) .ui-dialog-buttonset button:has-text("Erase")', expect: { dialog: "#brushesPanel" }, note: "erase mode" },
    { op: "button", id: "applyTemplate", dom: true, expect: { dialog: "#templateEditor" }, note: "template editor" },
    { op: "input", id: "templateSelect", value: "pangea", event: "change", uiOnly: true, note: "pick the Pangea template (fills the template editor)" },
    { op: "button", id: "templateRun", mustChange: true, note: "run the template (seeded)" },
    { op: "button", id: "templateUndo", mustChange: true, note: "template undo" },
    { op: "button", id: "templateRedo", mustChange: true, note: "template redo" },
    // both dialogs sit top right: the template editor would cover the brush panel's buttons
    { op: "button", css: ".ui-dialog:has(> #templateEditor) .ui-dialog-titlebar-close", note: "close the template editor" },
    { op: "button", id: "brushRaise", note: "raise brush" },
    { op: "drag", target: { point: { world: [500, 360] } }, path: [[20, 0], [40, 10], [60, 10]], brush: true, note: "raise stroke" },
    { op: "button", id: "brushElevate", note: "elevate brush" },
    { op: "drag", target: { point: { world: [560, 300] } }, path: [[24, 8], [48, 16], [72, 16]], brush: true, note: "elevate stroke" },
    { op: "button", id: "undo", mustChange: true, note: "brush undo" },
    { op: "button", id: "redo", mustChange: true, note: "brush redo" },
    { op: "button", id: "brushLine", note: "line brush" },
    { op: "click", target: { point: { world: [480, 420] } }, note: "line start" },
    { op: "click", target: { point: { world: [560, 460] } }, note: "line end (a range of the line power)" },
    { op: "button", id: "smoothHeights", mustChange: true, note: "smooth all heights" },
    { op: "button", id: "disruptHeights", mustChange: true, note: "disrupt all heights (seeded)" },
    { op: "close", dialog: "#brushesPanel", via: "#exitCustomization" }
  ]
};
export default script;
