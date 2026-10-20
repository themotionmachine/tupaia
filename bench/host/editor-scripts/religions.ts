// Religions editor (REWRITE-PLAN §5 rows 3 and 29, regions): open it from the Tools panel, rename a religion, change
// its type and deity, then the manual assignment brush (customization 7, polygons staged in #temp) twice: a stroke
// that "do not overwrite existing" stops, one that is cancelled (the #temp group is removed, pack.cells.religion
// untouched), and one that is applied (pack.cells.religion changes), close. The religions editor has no undo button.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

// a border of religions 1 and 17
const BORDER: [number, number] = [556, 228];

const script: EditorScript = {
  name: "religions",
  editor: "editReligions",
  dialog: "#religionsEditor",
  rows: [3, 29],
  description: "open the religions editor, rename, type, deity, protected brush, brush then cancel, brush then apply, close",
  steps: [
    { op: "display", off: CLUTTER },
    // the border sits left of the screen centre: the editor dialog takes the right half of the map
    { op: "camera", k: 8, focus: { world: [BORDER[0] + 40, BORDER[1]] } },
    { op: "open", button: "editReligions", expect: { editor: "editReligions", dialog: "#religionsEditor" } },
    { op: "input", css: '#religionsBody div.states[data-id="17"] .religionName', value: "Replay Creed", note: "rename a religion" },
    { op: "input", css: '#religionsBody div.states[data-id="17"] .religionType', value: "Heresy", event: "change", note: "type" },
    { op: "input", css: '#religionsBody div.states[data-id="17"] .religionDeity', value: "The Replayer", note: "deity" },
    { op: "button", id: "religionsManually", note: "enter manual assignment (customization 7)" },
    { op: "input", css: "#religionsBrush", value: 5, uiOnly: true, note: "brush size" },
    { op: "button", css: '#religionsBody div.states[data-id="17"]', note: "select religion 17 as the paint" },
    // every border cell has a religion: with "do not overwrite existing" on, this stroke stages nothing
    { op: "input", css: "#religionsManuallyProtect", checked: true, uiOnly: true, note: "do not overwrite existing" },
    { op: "drag", target: { point: { world: [563, 224] } }, path: [[-24, 20], [-48, 40], [-72, 56]], brush: true, note: "protected stroke (stages nothing)" },
    { op: "input", css: "#religionsManuallyProtect", checked: false, uiOnly: true, note: "overwrite allowed" },
    { op: "drag", target: { point: { world: [563, 224] } }, path: [[-24, 20], [-48, 40], [-72, 56]], brush: true, note: "stroke, to be cancelled" },
    { op: "button", id: "religionsManuallyCancel", mustChange: true, note: "cancel the assignment" },
    { op: "button", id: "religionsManually", note: "enter manual assignment again" },
    { op: "button", css: '#religionsBody div.states[data-id="17"]', note: "select religion 17 again" },
    { op: "drag", target: { point: { world: [549, 232] } }, path: [[24, -20], [48, -40], [72, -56]], brush: true, note: "stroke, to be applied" },
    { op: "button", id: "religionsManuallyApply", mustChange: true, note: "apply the assignment" },
    { op: "close", dialog: "#religionsEditor" }
  ]
};
export default script;
