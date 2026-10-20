// Provinces editor (REWRITE-PLAN §5 rows 2 and 29, regions): open it from the Tools panel, recolour the provinces,
// then the manual assignment brush (customization 11, polygons staged in the provinces layer's #temp): a stroke that
// is cancelled, a stroke that is applied (pack.cells.province changes, borders and poles are redrawn), then the add
// mode (customization 12: a map click creates a province, emblem included), close. No undo button.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

// a border of provinces 1 and 4, both of state 1 (a brush only moves cells inside the paint province's state)
const BORDER: [number, number] = [773, 500];

const script: EditorScript = {
  name: "provinces",
  editor: "editProvinces",
  dialog: "#provincesEditor",
  rows: [5, 29],
  description: "open the provinces editor, recolour, brush then cancel, brush then apply, add a province by click, close",
  steps: [
    { op: "display", off: CLUTTER },
    // the border sits left of the screen centre: the editor dialog takes the right half of the map
    { op: "camera", k: 8, focus: { world: [BORDER[0] + 40, BORDER[1]] } },
    { op: "open", button: "editProvincesButton", expect: { editor: "editProvinces", dialog: "#provincesEditor" } },
    { op: "button", id: "provincesRecolor", mustChange: true, note: "recolour (random colours, seeded)" },
    { op: "button", id: "provincesManually", note: "enter manual assignment (customization 11)" },
    { op: "input", css: "#provincesBrush", value: 4, uiOnly: true, note: "brush size (a single cell per move)" },
    { op: "button", css: '#provincesBodySection div.states[data-id="4"]', note: "select province 4 as the paint" },
    // cells 2781 and 2780 are province 1, the border cell 2782 province 4 (offsets from BORDER at k 8)
    { op: "drag", target: { point: { world: BORDER }, offset: [-31, -4] }, path: [[-20, -2], [-40, -4], [-62, -4]], brush: true, note: "stroke, to be cancelled" },
    { op: "button", id: "provincesManuallyCancel", mustChange: true, note: "cancel the assignment" },
    { op: "button", id: "provincesManually", note: "enter manual assignment again" },
    { op: "button", css: '#provincesBodySection div.states[data-id="1"]', note: "select province 1 as the paint" },
    { op: "drag", target: { point: { world: BORDER }, offset: [31, 0] }, path: [[14, -14], [28, -28], [35, -59]], brush: true, note: "stroke, to be applied" },
    { op: "button", id: "provincesManuallyApply", mustChange: true, note: "apply the assignment" },
    { op: "button", id: "provincesAdd", note: "add mode (customization 12)" },
    { op: "click", target: { point: { world: BORDER }, offset: [-19, 103] }, note: "click a land cell: a new province" },
    { op: "close", dialog: "#provincesEditor" }
  ]
};
export default script;
