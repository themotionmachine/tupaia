// Ice editor (REWRITE-PLAN §5 rows 29 and 30; features/overlays split, EDIT-B): click-select iceberg 6, resize it,
// randomize its shape (Math.random, seeded per step by the harness), drag it (pack.ice offset and the polygon's
// transform), then select glacier 8 (a second editIce open with the dialog still up) and drag that, close.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const script: EditorScript = {
  name: "ice",
  editor: "editIce",
  dialog: "#iceEditor",
  rows: [29, 30],
  description: "select iceberg 6, resize, randomize, drag; select glacier 8, drag; close",
  steps: [
    { op: "display", off: CLUTTER },
    { op: "display", off: ["zones", "states", "provinces", "religions", "cultures"] },
    { op: "camera", k: 8, focus: { world: [1023, 47] } },
    { op: "click", target: { css: '#ice > [data-id="6"]' }, expect: { editor: "editIce", dialog: "#iceEditor" } },
    { op: "input", id: "iceSize", value: 2.2, note: "iceberg size" },
    { op: "button", id: "iceRandomize", note: "randomize the shape (seeded)" },
    { op: "drag", target: { css: '#ice > [data-id="6"]' }, path: [[8, 4], [20, 10], [34, 16]], note: "drag the iceberg" },
    { op: "camera", k: 8, focus: { world: [717, 68] } },
    { op: "click", target: { css: '#ice > [data-id="8"]' }, expect: { editor: "editIce" }, note: "select the glacier" },
    { op: "drag", target: { css: '#ice > [data-id="8"]' }, path: [[8, 6], [20, 12], [30, 18]], note: "drag the glacier" },
    { op: "close", dialog: "#iceEditor" }
  ]
};
export default script;
