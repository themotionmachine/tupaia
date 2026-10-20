// Burg groups editor (REWRITE-PLAN §5 rows 29 and 30; features/overlays split, EDIT-B): reached from the burgs overview
// (its Configure button). Raise the village group's population ceiling and apply (every burg is re-grouped, the burg
// icons and labels are redrawn), reopen it, restore the defaults and apply again, then close the overview.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const C: [number, number] = [667, 309.9];
const APPLY = '.ui-dialog-buttonset button:has-text("Apply")';

const script: EditorScript = {
  name: "burg-groups",
  editor: "editBurgGroups",
  dialog: "#burgGroupsEditor",
  rows: [29, 30],
  description: "burgs overview, burg groups: raise the village ceiling, apply, restore the defaults, apply, close",
  steps: [
    { op: "display", off: CLUTTER },
    { op: "display", off: ["zones", "states", "provinces", "religions", "cultures"] },
    { op: "camera", k: 4, focus: { world: C } },
    { op: "open", button: "overviewBurgsButton", expect: { dialog: "#burgsOverview" } },
    { op: "button", id: "burgsGroupsEditorButton", dom: true, expect: { editor: "editBurgGroups", dialog: "#burgGroupsEditor" }, note: "configure the groups" },
    { op: "input", css: '#burgGroupsBody tr[name="village"] input[name="max"]', value: 6, event: "change", uiOnly: true, note: "village ceiling 6" },
    { op: "button", css: APPLY, mustChange: true, note: "apply: burgs re-grouped, icons redrawn" },
    { op: "button", id: "burgsGroupsEditorButton", dom: true, note: "configure the groups again" },
    { op: "button", css: '.ui-dialog-buttonset button:has-text("Restore")', dom: true, note: "restore the default groups" },
    { op: "button", css: APPLY, mustChange: true, note: "apply the defaults" },
    { op: "close", dialog: "#burgsOverview" }
  ]
};
export default script;
