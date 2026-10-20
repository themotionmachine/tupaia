// Zones editor (REWRITE-PLAN §5 rows 7 and 29, regions): open it from the Tools panel, rename a zone, retype it, hide
// another, add a zone layer, then the manual assignment brush (customization 10: the zones layer is redrawn as one
// polygon per cell): paint, erase mode, cancel (the layer is redrawn from pack.zones), paint again, apply
// (zone.cells change), close. The zones editor has no undo button.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

// zone 6 (Schisman Crusade) cell 2497; the cells around it are 40 to 70 world units apart in client px at k 8
const CELL: [number, number] = [963.4, 454.3];

const script: EditorScript = {
  name: "zones",
  editor: "editZones",
  dialog: "#zonesEditor",
  rows: [7, 29],
  description: "open the zones editor, rename, retype, hide, add a zone, paint/erase/cancel, paint/apply, close",
  steps: [
    { op: "display", off: CLUTTER },
    // the cell sits left of the screen centre: the editor dialog takes the right half of the map
    { op: "camera", k: 8, focus: { world: [CELL[0] + 40, CELL[1]] } },
    { op: "open", button: "editZonesButton", expect: { editor: "editZones", dialog: "#zonesEditor" } },
    { op: "input", css: '#zonesBodySection div.states[data-id="6"] .zoneName', value: "Replay Crusade", note: "rename a zone" },
    { op: "input", css: '#zonesBodySection div.states[data-id="6"] .zoneType', value: "Replay", note: "retype a zone" },
    { op: "button", css: '#zonesBodySection div.states[data-id="7"] .zoneHide', mustChange: true, note: "hide zone 7" },
    { op: "button", id: "zonesAdd", mustChange: true, note: "add a zone layer" },
    { op: "button", id: "zonesManually", note: "enter manual assignment (customization 10)" },
    { op: "input", css: "#zonesBrush", value: 4, uiOnly: true, note: "brush size (a single cell per move)" },
    { op: "button", css: '#zonesBodySection div.states[data-id="6"]', note: "select zone 6 as the paint" },
    // cells 2498, 2499 and 2500 are land outside the zone, east of its cell 2497 (offsets from CELL at k 8)
    { op: "drag", target: { point: { world: CELL }, offset: [28, -36] }, path: [[47, 28], [94, 56], [100, 122]], brush: true, note: "paint" },
    { op: "button", id: "zonesRemove", note: "erase mode" },
    { op: "drag", target: { point: { world: CELL }, offset: [32, 84] }, path: [[-40, 23], [-80, 46]], brush: true, note: "erase" },
    { op: "button", id: "zonesManuallyCancel", mustChange: true, note: "cancel the assignment" },
    { op: "button", id: "zonesManually", note: "enter manual assignment again" },
    { op: "button", css: '#zonesBodySection div.states[data-id="6"]', note: "select zone 6 again" },
    { op: "drag", target: { point: { world: CELL }, offset: [28, -36] }, path: [[47, 28], [94, 56]], brush: true, note: "paint to apply" },
    { op: "button", id: "zonesManuallyApply", mustChange: true, note: "apply the assignment" },
    { op: "close", dialog: "#zonesEditor" }
  ]
};
export default script;
