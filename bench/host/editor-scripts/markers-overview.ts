// Markers overview (REWRITE-PLAN §5 rows 29 and 30; features/overlays split, EDIT-B): open it from the Tools panel (it
// stays on the markers layer, so the data overlays that cover it are hidden), invert the pin of every marker and back
// (the group's `pinned` attribute and a redraw), pin and lock one marker, add a marker from the overview (the add-marker
// click mode of the Tools panel, then a map click appends an <svg id="marker<N>">), remove marker 43 through the
// confirmation dialog, filter the list, close.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const C: [number, number] = [525, 428];

const script: EditorScript = {
  name: "markers-overview",
  editor: "overviewMarkers",
  dialog: "#markersOverview",
  rows: [29, 30],
  description: "open the markers overview, invert pins twice, pin and lock one, add a marker by click, remove marker 43, filter, close",
  steps: [
    { op: "display", off: CLUTTER },
    { op: "display", off: ["zones", "states", "provinces", "religions", "cultures"] },
    { op: "camera", k: 6, focus: { world: C } },
    { op: "open", button: "overviewMarkersButton", expect: { editor: "overviewMarkers", dialog: "#markersOverview" } },
    { op: "button", id: "markersInverPin", mustChange: true, note: "invert every pin (all pinned)" },
    { op: "button", id: "markersInverPin", mustChange: true, note: "invert again (none pinned)" },
    { op: "button", css: '#markersBody div.states[data-i="43"] .icon-pin', dom: true, mustChange: true, note: "pin marker 43" },
    { op: "button", css: '#markersBody div.states[data-i="43"] .locks', dom: true, mustChange: true, note: "lock marker 43 (model only)" },
    { op: "button", id: "markersAddFromOverview", note: "add-marker mode" },
    { op: "click", target: { point: { world: C }, offset: [-18, 0] }, note: "click the map: a new marker" },
    { op: "button", css: '#markersBody div.states[data-i="44"] .icon-trash-empty', dom: true, note: "remove marker 44: asks to confirm" },
    { op: "button", css: '.ui-dialog-buttonset button:has-text("Remove")', mustChange: true, note: "confirm" },
    { op: "input", id: "markersSearch", value: "ruin", uiOnly: true, note: "filter the list" },
    { op: "close", dialog: "#markersOverview" }
  ]
};
export default script;
