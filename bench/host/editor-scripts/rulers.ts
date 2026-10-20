// Measurers (rulers) in the units editor (REWRITE-PLAN §5 rows 29 and 30; features/overlays split, EDIT-B): the tools
// live at the bottom of the Units dialog. Open it, then place a linear ruler and drag its end point, draw an opisometer
// (free curve, optimized on release), a planimeter (closed curve with an area label), and a route opisometer along
// route 18 (it only tracks cells that carry a route); click a measurer's label to delete it; remove all rulers
// (confirmation dialog); close. The measurers are DOM in #ruler and `rulers.data` (hashed by editor-replay-page.ts).
// Everything runs at k 2: addRuler puts the new ruler 200 world units below the screen's top quarter, so a higher zoom
// would push it off screen.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const CENTER: [number, number] = [640, 360];
// route 18 (7 points, all cells connected) at k 2 about CENTER: p0 on screen (474.7, 424.5), offsets 2 * (p_i - p0)
const ROUTE_START: [number, number] = [557.33, 392.27];
const ROUTE_PATH: [number, number][] = [[-14.3, 25], [-22.4, 39.8], [-24.6, 58.9], [-34.5, 74.7], [-44.3, 90.6], [-50, 115.4]];

const script: EditorScript = {
  name: "rulers",
  editor: "editUnits",
  dialog: "#unitsEditor",
  rows: [29, 30],
  description: "units editor measurers: ruler (drag end), opisometer, planimeter, route opisometer, delete one, remove all, close",
  steps: [
    { op: "display", off: CLUTTER },
    { op: "display", off: ["zones", "states", "provinces", "religions", "cultures"] },
    { op: "camera", k: 2, focus: { world: CENTER } },
    { op: "open", button: "editUnitsButton", expect: { editor: "editUnits", dialog: "#unitsEditor" } },
    { op: "button", id: "addLinearRuler", mustChange: true, note: "place a linear ruler" },
    { op: "drag", target: { css: "#ruler > g:last-child .rulerPoints circle", nth: 0 }, path: [[0, -20], [-12, -50], [-20, -80]], note: "drag the ruler's end point" },
    { op: "button", id: "addOpisometer", note: "opisometer mode" },
    { op: "drag", target: { point: { world: CENTER }, offset: [-440, -260] }, path: [[40, 20], [90, 50], [150, 60], [210, 40], [260, 10]], brush: true, note: "draw an opisometer" },
    { op: "button", id: "addPlanimeter", note: "planimeter mode" },
    { op: "drag", target: { point: { world: CENTER }, offset: [260, -210] }, path: [[30, 30], [80, 50], [110, 90], [80, 130], [30, 120], [-4, 70], [-6, 20]], brush: true, note: "draw a planimeter" },
    { op: "button", id: "addRouteOpisometer", note: "route opisometer mode" },
    { op: "drag", target: { point: { world: ROUTE_START } }, path: ROUTE_PATH, brush: true, note: "measure along route 18" },
    { op: "click", target: { css: "#ruler g.planimeter text" }, note: "click the planimeter's label: it is removed" },
    { op: "button", id: "removeRulers", note: "remove all rulers: asks to confirm" },
    { op: "button", css: '.ui-dialog-buttonset button:has-text("Remove")', mustChange: true, note: "confirm" },
    { op: "close", dialog: "#unitsEditor" }
  ]
};
export default script;
