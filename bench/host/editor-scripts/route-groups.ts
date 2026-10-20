// Route groups editor (REWRITE-PLAN §5 rows 9 and 29; features/overlays split, EDIT-B): reached from the route editor
// (select route 18, press the group Edit button). Add a group through the prompt (a new, empty <g id="route-routegroupnew"> (FMG strips the hyphens from the typed name)
// under #routes), close the groups editor, move route 18 into the new group with the route editor's group select (the
// path is re-parented and takes the group's stroke style), close.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const script: EditorScript = {
  name: "route-groups",
  editor: "editRouteGroups",
  dialog: "#routeGroupsEditor",
  rows: [9, 29],
  description: "route 18's editor, route groups: add a group, move the route into it, close",
  steps: [
    { op: "display", off: CLUTTER },
    { op: "camera", k: 16, focus: { route: 18 } },
    { op: "click", target: { route: 18 }, expect: { dialog: "#routeEditor" } },
    { op: "button", id: "routeGroupEdit", dom: true, expect: { editor: "editRouteGroups", dialog: "#routeGroupsEditor" }, note: "open the groups editor" },
    { op: "button", id: "routeGroupsEditorAdd", note: "add a group: opens the prompt" },
    { op: "button", css: '#promptForm button[type="submit"]', dom: true, mustChange: true, note: "confirm the default name" },
    { op: "close", dialog: "#routeGroupsEditor", note: "close the groups editor only" },
    { op: "input", id: "routeGroup", value: "route-routegroupnew", mustChange: true, note: "move route 18 into the new group" },
    { op: "close", dialog: "#routeEditor" }
  ]
};
export default script;
