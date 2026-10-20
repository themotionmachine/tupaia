// Routes overview (REWRITE-PLAN §5 rows 29 and 30; features/overlays split, EDIT-B): open it from the Tools panel, lock
// every route and unlock them again (pack.routes lock flags), lock route 18 alone, remove it through the row's trash icon
// and the confirmation dialog (Routes.remove drops the <path> and the cells' links), filter the list, close.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const script: EditorScript = {
  name: "routes-overview",
  editor: "overviewRoutes",
  dialog: "#routesOverview",
  rows: [29, 30],
  description: "open the routes overview, lock all and unlock all, lock route 18, remove it, filter, close",
  steps: [
    { op: "display", off: CLUTTER },
    { op: "display", off: ["zones", "states", "provinces", "religions", "cultures"] },
    { op: "camera", k: 4, focus: { world: [545, 421] } },
    { op: "open", button: "overviewRoutesButton", expect: { editor: "overviewRoutes", dialog: "#routesOverview" } },
    { op: "button", id: "routesLockAll", mustChange: true, note: "lock every route" },
    { op: "button", id: "routesLockAll", mustChange: true, note: "unlock every route" },
    { op: "button", css: '#routesBody div.states[data-id="18"] .locks', dom: true, mustChange: true, note: "lock route 18" },
    { op: "button", css: '#routesBody div.states[data-id="18"] .icon-trash-empty', dom: true, note: "remove route 18: asks to confirm" },
    { op: "button", css: '.ui-dialog-buttonset button:has-text("Remove")', mustChange: true, note: "confirm" },
    { op: "input", id: "routesSearch", value: "road", uiOnly: true, note: "filter the list" },
    { op: "close", dialog: "#routesOverview" }
  ]
};
export default script;
