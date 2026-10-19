// Relief editor (REWRITE-PLAN §5 rows 8 and 29): click a compact-raster relief sprite (clicked()'s fallback leg:
// pickRelief materializes the <use> glyphs), resize it, drag it, then two brush strokes: bulk remove and bulk add
// (the add scatters icons with Math.random, seeded per step by the harness). The camera must not move during either
// stroke. Closing compacts the glyphs back into the raster.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

// the densest relief cluster of the parity fixture (swamp, 20 sprites within 20x12 world units)
const CLUSTER: [number, number] = [1213.6, 354.8];

const script: EditorScript = {
  name: "relief",
  editor: "editReliefIcon",
  dialog: "#reliefEditor",
  rows: [8, 29],
  description: "select a relief sprite, resize, drag, brush-remove, brush-add, close",
  steps: [
    // the parity fixture shows every layer: hide the data overlays that cover the editable features
    { op: "display", off: CLUTTER },
    // the area fills above #terrain take the pointer from the glyphs (the drag must start on the <use>)
    { op: "display", off: ["zones", "states", "provinces", "religions", "cultures"] },
    { op: "camera", k: 8, focus: { world: CLUSTER } },
    { op: "click", target: { relief: "nearest" }, expect: { editor: "editReliefIcon", dialog: "#reliefEditor" } },
    { op: "input", id: "reliefSizeNumber", value: 21, note: "size 21" },
    { op: "drag", target: { selected: true }, path: [[6, 4], [12, 8], [18, 10]], note: "drag the icon" },
    { op: "button", id: "reliefBulkRemove", note: "bulk remove mode" },
    {
      op: "drag",
      target: { point: { world: CLUSTER }, offset: [-60, -20] },
      path: [[20, 0], [40, 10], [60, 20], [80, 20]],
      brush: true,
      note: "brush remove"
    },
    { op: "button", id: "reliefBulkAdd", note: "bulk add mode" },
    {
      op: "drag",
      target: { point: { world: CLUSTER }, offset: [-80, 60] },
      path: [[20, 0], [40, -6], [60, -10]],
      brush: true,
      note: "brush add (seeded)"
    },
    { op: "close", dialog: "#reliefEditor" }
  ]
};
export default script;
