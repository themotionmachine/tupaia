// States editor (REWRITE-PLAN §5 rows 1 and 29, regions): open it from the Tools panel, rename a capital, change an
// expansionism value, then the manual assignment brush (customization 2, painting into the #temp overlay): two
// strokes, undo the last stroke (statesManuallyUndo resets the overlay from its snapshot), paint again, apply
// (pack.cells.state, burg.state and provinces change), close.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

// a state 8 cell on its border with state 5 (Azarag)
const BORDER: [number, number] = [549.3, 271.9];

const script: EditorScript = {
  name: "states",
  editor: "editStates",
  dialog: "#statesEditor",
  rows: [1, 29],
  description: "open the states editor, rename a capital, expansionism, brush two strokes, undo one, apply, close",
  steps: [
    { op: "display", off: CLUTTER },
    { op: "camera", k: 8, focus: { world: BORDER } },
    { op: "open", button: "editStatesButton", expect: { editor: "editStates", dialog: "#statesEditor" } },
    { op: "input", css: '#statesBodySection div.states[data-id="5"] .stateCapital', value: "Replay Capital", note: "rename a capital" },
    { op: "input", css: '#statesBodySection div.states[data-id="6"] .statePower', value: 2.5, event: "change", note: "expansionism" },
    { op: "button", id: "statesManually", note: "enter manual assignment (customization 2)" },
    { op: "input", css: "#statesBrush", value: 6, uiOnly: true, note: "brush size" },
    { op: "button", css: '#statesBodySection div.states[data-id="5"]', note: "select state 5 as the paint" },
    { op: "drag", target: { point: { world: BORDER } }, path: [[16, 0], [32, 8], [48, 8]], brush: true, note: "stroke 1" },
    { op: "drag", target: { point: { world: BORDER }, offset: [0, 40] }, path: [[-16, 0], [-32, 4], [-48, 4]], brush: true, note: "stroke 2" },
    { op: "button", id: "statesManuallyUndo", mustChange: true, note: "undo stroke 2" },
    { op: "drag", target: { point: { world: BORDER }, offset: [50, 118] }, path: [[12, 0], [24, 4], [36, 6]], brush: true, note: "stroke 3" },
    { op: "button", id: "statesManuallyApply", mustChange: true, note: "apply the assignment" },
    { op: "close", dialog: "#statesEditor" }
  ]
};
export default script;
