// Diplomacy editor (REWRITE-PLAN §5 rows 6 and 29, regions): open it from the Tools panel, pick a state by clicking
// the map (the editor rebinds the viewbox click), change its relations to two states through the "Change relations"
// dialog, open and close the relations matrix, regenerate the relations (seeded) and reset them, close. The
// relations live in pack.states[].diplomacy; the state fills recolour to show them.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

// a land cell of state 2 without a burg
const STATE_2: [number, number] = [207.1, 307];

const script: EditorScript = {
  name: "diplomacy",
  editor: "editDiplomacy",
  dialog: "#diplomacyEditor",
  rows: [6, 29],
  description: "open the diplomacy editor, pick a state on the map, change relations, matrix, regenerate, reset, close",
  steps: [
    { op: "display", off: CLUTTER },
    // the state sits left of the screen centre: the editor dialog takes the right half of the map
    { op: "camera", k: 3, focus: { world: [STATE_2[0] + 60, STATE_2[1]] } },
    { op: "open", button: "editDiplomacyButton", expect: { editor: "editDiplomacy", dialog: "#diplomacyEditor" } },
    { op: "click", target: { point: { world: STATE_2 } }, note: "click state 2 on the map" },
    { op: "button", css: '#diplomacyBodySection div.states[data-id="5"] .changeRelations', expect: { dialog: "#alert" }, note: "change relations of state 5" },
    { op: "input", css: 'input[name="relationSelect"][value="Enemy"]', checked: true, uiOnly: true, note: "at war with" },
    { op: "input", css: "#selectState6", checked: true, uiOnly: true, note: "and state 6" },
    { op: "button", css: '.ui-dialog:has(#relationsForm) .ui-dialog-buttonset button:has-text("Apply")', mustChange: true, note: "apply" },
    { op: "button", id: "diplomacyShowMatrix", expect: { dialog: "#diplomacyMatrix" }, note: "relations matrix" },
    { op: "button", css: ".ui-dialog:has(> #diplomacyMatrix) .ui-dialog-titlebar-close", note: "close the matrix" },
    { op: "button", id: "diplomacyRegenerate", mustChange: true, note: "regenerate the relations (seeded)" },
    { op: "button", id: "diplomacyReset", mustChange: true, note: "reset the relations of the selected state" },
    { op: "close", dialog: "#diplomacyEditor" }
  ]
};
export default script;
