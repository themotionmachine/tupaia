// Biomes editor (REWRITE-PLAN §5 rows 4 and 29, terrain): open it from the Tools panel, rename a biome, change a
// habitability (recalculates the population), add a custom biome (biomesData, a top-level let outside pack/grid),
// then the manual assignment brush (customization 6, polygons staged in the biomes layer's #temp): two strokes,
// cancel, a stroke that is applied (pack.cells.biome changes), close. The biomes editor has no undo button.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

// a border of biomes 5 and 6 (the longest of the fixture)
const BORDER: [number, number] = [540, 338];

const script: EditorScript = {
  name: "biomes",
  editor: "editBiomes",
  dialog: "#biomesEditor",
  rows: [4, 29],
  description: "open the biomes editor, rename, habitability, add a biome, brush then cancel, brush then apply, close",
  steps: [
    { op: "display", off: CLUTTER },
    // the border sits left of the screen centre: the editor dialog takes the right half of the map
    { op: "camera", k: 8, focus: { world: [BORDER[0] + 40, BORDER[1]] } },
    { op: "open", button: "editBiomesButton", expect: { editor: "editBiomes", dialog: "#biomesEditor" } },
    { op: "input", css: '#biomesBody div.biomes[data-id="5"] .biomeName', value: "Replay Meadow", event: "change", note: "rename a biome" },
    { op: "input", css: '#biomesBody div.biomes[data-id="6"] .biomeHabitability', value: 70, event: "change", note: "habitability" },
    { op: "button", id: "biomesAdd", mustChange: true, note: "add a custom biome" },
    { op: "button", id: "biomesManually", note: "enter manual assignment (customization 6)" },
    { op: "input", css: "#biomesBrush", value: 5, uiOnly: true, note: "brush size" },
    { op: "button", css: '#biomesBody div.biomes[data-id="6"]', note: "select biome 6 as the paint" },
    // cells 1558 and 1559 are biome 5 on the border, 1557, 1662 and 1663 biome 6 (offsets from BORDER at k 8)
    { op: "drag", target: { point: { world: BORDER }, offset: [-60, -45] }, path: [[-10, -4], [-20, -8], [-26, -10]], brush: true, note: "stroke 1" },
    { op: "drag", target: { point: { world: BORDER }, offset: [76, -24] }, path: [[8, 4], [16, 8], [24, 12]], brush: true, note: "stroke 2" },
    { op: "button", id: "biomesManuallyCancel", mustChange: true, note: "cancel the assignment" },
    { op: "button", id: "biomesManually", note: "enter manual assignment again" },
    { op: "button", css: '#biomesBody div.biomes[data-id="6"]', note: "select biome 6 again" },
    { op: "drag", target: { point: { world: BORDER }, offset: [-60, -45] }, path: [[30, 5], [60, 10], [90, 15], [120, 20], [136, 21]], brush: true, note: "stroke to apply" },
    { op: "button", id: "biomesManuallyApply", mustChange: true, note: "apply the assignment" },
    { op: "close", dialog: "#biomesEditor" }
  ]
};
export default script;
