// Coastline settings editor (REWRITE-PLAN §5 rows 29 and 30; features/overlays split, EDIT-B): open it from the Tools
// panel, apply the Rocky and Smooth presets, reset one slider, switch the fractal coastline off and on, and put the
// Default preset back (the settings are module state that outlives a map load, so the script leaves them as it found
// them). Every change redraws the coastline and lake shores (drawFeatures), the largest path rebuild of any editor.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const script: EditorScript = {
  name: "coastline-settings",
  editor: "editCoastlineSettings",
  dialog: "#coastlineSettingsDialog",
  rows: [29, 30],
  description: "open the coastline settings, apply presets, reset a slider, toggle the fractal off and on, restore, close",
  steps: [
    { op: "display", off: CLUTTER },
    { op: "display", off: ["zones", "states", "provinces", "religions", "cultures"] },
    { op: "camera", k: 2, focus: { world: [640, 360] } },
    { op: "open", button: "editCoastlineSettings", expect: { editor: "editCoastlineSettings", dialog: "#coastlineSettingsDialog" } },
    { op: "button", id: "coastPreset_Rocky", dom: true, mustChange: true, note: "Rocky preset" },
    { op: "button", id: "coastBaseAmplitudeReset", dom: true, mustChange: true, note: "reset the roughness amplitude" },
    { op: "button", id: "coastPreset_Smooth", dom: true, mustChange: true, note: "Smooth preset" },
    { op: "button", css: "#coastEnabledTrack", dom: true, mustChange: true, note: "fractal coastline off" },
    { op: "button", css: "#coastEnabledTrack", dom: true, mustChange: true, note: "fractal coastline on" },
    { op: "button", id: "coastPreset_Default", dom: true, mustChange: true, note: "Default preset back" },
    { op: "close", dialog: "#coastlineSettingsDialog" }
  ]
};
export default script;
