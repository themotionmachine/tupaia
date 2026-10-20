// Relief editor, the rest of its controls (REWRITE-PLAN §5 rows 8 and 29; features/overlays split, EDIT-B; the W1
// relief script covers size, drag and the two brushes): select a compact-raster relief sprite (pickRelief materializes
// the <use> glyphs), change its icon type, copy it, send it to the back and the front, then remove it through the
// confirmation dialog, which also closes the editor (closing compacts the glyphs back into the raster).
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

// the densest relief cluster of the parity fixture (swamp, 20 sprites within 20x12 world units)
const CLUSTER: [number, number] = [1213.6, 354.8];

const script: EditorScript = {
  name: "relief-icons",
  editor: "editReliefIcon",
  dialog: "#reliefEditor",
  rows: [8, 29],
  description: "select a relief sprite, change its icon, copy, back, front, remove (confirm closes the editor)",
  steps: [
    { op: "display", off: CLUTTER },
    { op: "display", off: ["zones", "states", "provinces", "religions", "cultures"] },
    { op: "camera", k: 8, focus: { world: CLUSTER } },
    { op: "click", target: { relief: "nearest" }, expect: { editor: "editReliefIcon", dialog: "#reliefEditor" } },
    { op: "button", css: '#reliefIconsDiv svg[data-type="#relief-hill-1"]', dom: true, mustChange: true, note: "change the sprite to a hill" },
    { op: "button", id: "reliefCopy", mustChange: true, note: "copy the sprite" },
    { op: "button", id: "reliefMoveBack", mustChange: true, note: "send it to the back" },
    { op: "button", id: "reliefMoveFront", mustChange: true, note: "bring it to the front" },
    { op: "button", id: "reliefRemove", note: "remove: asks to confirm" },
    { op: "close", dialog: "#reliefEditor", via: '.ui-dialog-buttonset button:has-text("Remove")', note: "confirm: the sprite goes and the editor closes itself" }
  ]
};
export default script;
