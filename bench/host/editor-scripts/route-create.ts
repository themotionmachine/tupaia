// Route creator (REWRITE-PLAN §5 rows 29 and 30; features/overlays split, EDIT-B): the Tools panel's "add route" opens
// the creator (the cells layer is forced on), three map clicks add route points and draw a temporary <path id="routeTemp">
// in the chosen group, completing the route renames #routeTemp to #route<N>, registers pack.routes and the cells' route
// links and opens the route editor on it; rename the route there and close. The REPLAY route script covers editing an
// existing route; this one covers creation and the #routeTemp -> #route<N> rename.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const C: [number, number] = [525, 428];

const script: EditorScript = {
  name: "route-create",
  editor: "createRoute",
  dialog: "#routeCreator",
  rows: [29, 30],
  description: "open the route creator, click three points, pick the trails group, complete (the #routeTemp rename), rename, close",
  steps: [
    { op: "display", off: CLUTTER },
    { op: "display", off: ["zones", "states", "provinces", "religions", "cultures"] },
    { op: "camera", k: 6, focus: { world: C } },
    { op: "open", button: "addRoute", expect: { editor: "createRoute", dialog: "#routeCreator" } },
    { op: "click", target: { point: { world: C }, offset: [30, -78] }, note: "route point 1" },
    { op: "click", target: { point: { world: C }, offset: [-18, 0] }, note: "route point 2" },
    { op: "click", target: { point: { world: C }, offset: [-54, 84] }, note: "route point 3" },
    { op: "input", id: "routeCreatorGroupSelect", value: "trails", event: "change", note: "redraw #routeTemp in the trails group" },
    { op: "button", id: "routeCreatorComplete", expect: { editor: "editRoute", dialog: "#routeEditor" }, mustChange: true, note: "complete: #routeTemp becomes #route<N>, the route editor opens" },
    { op: "input", id: "routeName", value: "Replay New Trail", note: "rename" },
    { op: "close", dialog: "#routeEditor" }
  ]
};
export default script;
