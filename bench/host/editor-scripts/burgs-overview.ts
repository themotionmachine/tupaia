// Burgs overview (REWRITE-PLAN §5 rows 29 and 30; features/overlays split, EDIT-B): open it from the Tools panel, lock
// and unlock every burg (model only), regenerate the burg names (relabels the map, seeded per step by the harness),
// lock one burg, filter by state (UI only), remove burg 17 through the confirmation dialog, add a burg on the freed
// cell with the overview's add-burg click mode, close.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const C: [number, number] = [667, 309.9];

const script: EditorScript = {
  name: "burgs-overview",
  editor: "overviewBurgs",
  dialog: "#burgsOverview",
  rows: [29, 30],
  description: "open the burgs overview, lock all twice, regenerate names, lock one, filter, remove burg 17, add a burg, close",
  steps: [
    { op: "display", off: CLUTTER },
    { op: "display", off: ["zones", "states", "provinces", "religions", "cultures"] },
    { op: "camera", k: 4, focus: { world: C } },
    { op: "open", button: "overviewBurgsButton", expect: { editor: "overviewBurgs", dialog: "#burgsOverview" } },
    { op: "button", id: "burgsLockAll", mustChange: true, note: "lock every burg" },
    { op: "button", id: "burgsLockAll", mustChange: true, note: "unlock every burg" },
    { op: "button", id: "regenerateBurgNames", mustChange: true, note: "regenerate the burg names (seeded)" },
    { op: "button", css: '#burgsBody div.states[data-id="17"] .locks', dom: true, mustChange: true, note: "lock burg 17 (model only)" },
    { op: "button", css: '#burgsBody div.states[data-id="17"] .locks', dom: true, mustChange: true, note: "unlock burg 17" },
    { op: "input", id: "burgsFilterState", value: "1", event: "change", uiOnly: true, note: "filter the list by state 1" },
    { op: "button", css: '#burgsBody div.states[data-id="17"] .icon-trash-empty', dom: true, note: "remove burg 17: asks to confirm" },
    { op: "button", css: '.ui-dialog-buttonset button:has-text("Remove")', mustChange: true, note: "confirm" },
    { op: "button", id: "addNewBurg", note: "add-burg mode" },
    { op: "click", target: { point: { world: C } }, note: "click the freed cell: a new burg" },
    { op: "close", dialog: "#burgsOverview" }
  ]
};
export default script;
