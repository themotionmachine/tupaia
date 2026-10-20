// Units editor (REWRITE-PLAN §5 rows 29 and 30; features/overlays split, EDIT-B): open it from the Tools panel, change
// the distance unit and scale (the scale bar is redrawn), the temperature scale (the temperature layer is redrawn, so
// that overlay stays on), the height exponent (calculateTemperatures rewrites grid.cells.temp), the population rates
// (top-level lets, hashed by editor-replay-page.ts), then restore the defaults, close.
import type { EditorScript } from "../editor-replay-core.ts";

const script: EditorScript = {
  name: "units",
  editor: "editUnits",
  dialog: "#unitsEditor",
  rows: [29, 30],
  description: "open from Tools, distance unit and scale, temperature scale, height exponent, population rates, restore, close",
  steps: [
    // decluttered like the other editor scripts (the D12 resume goal is judged on these), but the temperature overlay
    // stays on: the temperature scale change redraws it
    { op: "display", off: ["goods", "markets", "precipitation", "population", "military"] },
    { op: "display", off: ["zones", "states", "provinces", "religions", "cultures"] },
    { op: "open", button: "editUnitsButton", expect: { editor: "editUnits", dialog: "#unitsEditor" } },
    { op: "input", id: "distanceUnitInput", value: "km", event: "change", note: "kilometers (the scale bar label)" },
    { op: "input", id: "distanceScaleInput", value: 7, event: "change", note: "7 km per pixel (the scale bar length)" },
    { op: "input", id: "temperatureScale", value: "°F", event: "change", note: "Fahrenheit (the temperature layer is redrawn)" },
    { op: "input", id: "heightExponentInput", value: 2.2, note: "height exponent (temperatures recomputed)" },
    { op: "input", id: "populationRateInput", value: 800, event: "change", note: "population rate" },
    { op: "input", id: "urbanizationInput", value: 1.5, event: "change", note: "urbanization" },
    { op: "input", id: "urbanDensityInput", value: 12, event: "change", note: "urban density" },
    { op: "button", id: "unitsRestore", mustChange: true, note: "restore the default units" },
    { op: "close", dialog: "#unitsEditor" }
  ]
};
export default script;
