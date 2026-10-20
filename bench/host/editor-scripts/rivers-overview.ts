// Rivers overview (REWRITE-PLAN §5 rows 29 and 30; features/overlays split, EDIT-B): open it from the Tools panel, toggle
// the basin highlight on and off (every river path gets a fill attribute, then loses it), filter the list, switch on the
// add-river mode and click a cell (Rivers.* routes a new river downhill and appends its <path> to #rivers), remove
// river 228 through the row's trash icon and the confirmation dialog, close.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const C: [number, number] = [525, 428];

const script: EditorScript = {
  name: "rivers-overview",
  editor: "overviewRivers",
  dialog: "#riversOverview",
  rows: [29, 30],
  description: "open the rivers overview, basin highlight on/off, filter, add a river by click, remove river 228, close",
  steps: [
    { op: "display", off: CLUTTER },
    { op: "display", off: ["zones", "states", "provinces", "religions", "cultures"] },
    { op: "camera", k: 6, focus: { world: C } },
    { op: "open", button: "overviewRiversButton", expect: { editor: "overviewRivers", dialog: "#riversOverview" } },
    { op: "button", id: "riversBasinHighlight", mustChange: true, note: "highlight the basins" },
    { op: "button", id: "riversBasinHighlight", mustChange: true, note: "basin highlight off" },
    { op: "input", id: "riversSearch", value: "dand", uiOnly: true, note: "filter the list" },
    { op: "input", id: "riversSearch", value: "", uiOnly: true, note: "clear the filter" },
    { op: "button", id: "addNewRiver", note: "add-river mode" },
    { op: "click", target: { point: { world: C }, offset: [-18, 0] }, note: "click a cell: a new river flows downhill" },
    { op: "button", css: '#riversBody div.states[data-id="228"] .icon-trash-empty', dom: true, note: "remove river 228: asks to confirm" },
    { op: "button", css: '.ui-dialog-buttonset button:has-text("Remove")', mustChange: true, note: "confirm" },
    { op: "close", dialog: "#riversOverview" }
  ]
};
export default script;
