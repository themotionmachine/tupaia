// River creator (REWRITE-PLAN §5 rows 29 and 30; features/overlays split, EDIT-B): from the river editor of river 228,
// "create a river by selecting cells" opens the creator (it closes the river editor and forces the cells layer on), four
// map clicks pick cells, completing pushes pack.rivers, writes cells.r, appends a new <path id="river<N>"> to #rivers
// and opens the river editor on it; rename the new river there and close.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const C: [number, number] = [525, 428];

const script: EditorScript = {
  name: "river-create",
  editor: "createRiver",
  dialog: "#riverCreator",
  rows: [29, 30],
  description: "river 228's editor opens the creator, click four cells, complete (a new river), rename, close",
  steps: [
    { op: "display", off: CLUTTER },
    { op: "display", off: ["zones", "states", "provinces", "religions", "cultures"] },
    { op: "camera", k: 16, focus: { world: [259.95, 397.46] } },
    { op: "click", target: { css: "#rivers path#river228" }, expect: { editor: "editRiver", dialog: "#riverEditor" }, note: "open the river editor" },
    { op: "button", id: "riverCreateSelectingCells", expect: { editor: "createRiver", dialog: "#riverCreator" }, note: "open the river creator (the river editor closes)" },
    { op: "camera", k: 6, focus: { world: C } },
    { op: "click", target: { point: { world: C }, offset: [30, -78] }, note: "cell 1" },
    { op: "click", target: { point: { world: C }, offset: [-18, 0] }, note: "cell 2" },
    { op: "click", target: { point: { world: C }, offset: [-54, 84] }, note: "cell 3" },
    { op: "click", target: { point: { world: C }, offset: [-60, 150] }, note: "cell 4" },
    { op: "button", id: "riverCreatorComplete", expect: { editor: "editRiver", dialog: "#riverEditor" }, mustChange: true, note: "complete: a new river, the river editor opens on it" },
    { op: "input", id: "riverName", value: "Replay New River", note: "rename" },
    { op: "close", dialog: "#riverEditor" }
  ]
};
export default script;
