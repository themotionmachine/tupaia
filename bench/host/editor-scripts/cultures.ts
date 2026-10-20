// Cultures editor (REWRITE-PLAN §5 rows 1 and 29, regions): open it from the Tools panel, rename a culture, change an
// expansionism value and a type, then the manual assignment brush (customization 4, painting polygons into the #temp
// staging group): two strokes, undo the last (temp.innerHTML restored from the history), paint again, apply
// (pack.cells.culture and burg.culture change), then the add mode (customization 9), close.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

// a border of cultures 1 and 5 (the longest of the fixture)
const BORDER: [number, number] = [389, 355];

const script: EditorScript = {
  name: "cultures",
  editor: "editCultures",
  dialog: "#culturesEditor",
  rows: [2, 29],
  description: "open the cultures editor, rename, expansionism, type, brush two strokes, undo one, apply, add a culture by click, close",
  steps: [
    { op: "display", off: CLUTTER },
    // the border sits left of the screen centre: the editor dialog takes the right half of the map
    { op: "camera", k: 8, focus: { world: [BORDER[0] + 40, BORDER[1]] } },
    { op: "open", button: "editCulturesButton", expect: { editor: "editCultures", dialog: "#culturesEditor" } },
    { op: "input", css: '#culturesBody div.states[data-id="5"] .cultureName', value: "Replay Folk", note: "rename a culture" },
    { op: "input", css: '#culturesBody div.states[data-id="3"] .cultureExpan', value: 3.5, event: "change", note: "expansionism" },
    { op: "input", css: '#culturesBody div.states[data-id="4"] .cultureType', value: "Nomadic", event: "change", note: "type" },
    { op: "button", id: "culturesManually", note: "enter manual assignment (customization 4)" },
    { op: "input", css: "#culturesBrush", value: 5, uiOnly: true, note: "brush size" },
    { op: "button", css: '#culturesBody div.states[data-id="5"]', note: "select culture 5 as the paint" },
    { op: "drag", target: { point: { world: [383, 351] } }, path: [[24, 20], [48, 40], [72, 56]], brush: true, note: "stroke 1" },
    { op: "drag", target: { point: { world: [395, 360] } }, path: [[-24, -10], [-48, -20], [-60, -30]], brush: true, note: "stroke 2" },
    { op: "button", id: "culturesManuallyUndo", mustChange: true, note: "undo stroke 2" },
    { op: "drag", target: { point: { world: [389, 355] }, offset: [0, 24] }, path: [[20, 8], [40, 16]], brush: true, note: "stroke 3" },
    { op: "button", id: "culturesManuallyApply", mustChange: true, note: "apply the assignment" },
    // add mode (customization 9): a map click on a land cell adds a culture centred there
    { op: "button", id: "culturesAdd", note: "add mode (customization 9)" },
    { op: "click", target: { point: { world: [395, 360] } }, note: "click a land cell: a new culture" },
    { op: "close", dialog: "#culturesEditor" }
  ]
};
export default script;
