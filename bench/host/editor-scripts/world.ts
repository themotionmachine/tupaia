// World configurator (terrain and climate): open "Configure World" from the options panel, change the equator
// temperature (auto-apply on: calculateTemperatures, generatePrecipitation, rivers, biomes and lake names are
// recomputed from the edited climate), set the Northern world preset (map size and latitude), restore the winds,
// close. The configurator edits `options` (a top-level let), grid.cells.temp/prec and pack rivers and biomes.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const script: EditorScript = {
  name: "world",
  editor: "editWorld",
  dialog: "#worldConfigurator",
  rows: [29],
  description: "open the world configurator, equator temperature, Northern preset, turn and restore a wind, close",
  steps: [
    { op: "display", off: CLUTTER },
    { op: "camera", k: 2, focus: { world: [640, 360] } },
    { op: "open", button: "configureWorld", expect: { editor: "editWorld", dialog: "#worldConfigurator" } },
    { op: "input", id: "temperatureEquatorInput", value: 34, note: "equator temperature (auto-apply)" },
    { op: "button", id: "wcNorthern", dom: true, mustChange: true, note: "Northern preset" },
    { op: "button", css: "#globeWindArrows circle:nth-of-type(3)", dom: true, mustChange: true, note: "turn the wind of tier 2 on the globe" },
    { op: "button", id: "restoreWinds", dom: true, mustChange: true, note: "restore the default winds" },
    { op: "close", dialog: "#worldConfigurator" }
  ]
};
export default script;
