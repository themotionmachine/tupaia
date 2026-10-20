// Emblem editor (REWRITE-PLAN §5 rows 29 and 30; features/overlays split, EDIT-B): click-select state 7's emblem
// (clicked()'s emblems branch; state emblems are only visible below zoom ~4, so k 3), drag it (coa.x/y), resize it
// (the <use> is removed and re-appended), change its shield (the COA <svg> in defs is re-rendered), regenerate the
// coat of arms (COA.generate uses Math.random, seeded per step by the harness), close.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const script: EditorScript = {
  name: "emblem",
  editor: "editEmblem",
  dialog: "#emblemEditor",
  rows: [29, 30],
  description: "select state 7's emblem, resize, shield, regenerate, close",
  steps: [
    { op: "display", off: CLUTTER },
    { op: "display", off: ["zones", "states", "provinces", "religions", "cultures"] },
    { op: "camera", k: 3, focus: { world: [879, 550] } },
    { op: "click", target: { css: '#stateEmblems > use[data-i="7"]' }, expect: { editor: "editEmblem", dialog: "#emblemEditor" } },
    // drag first: the size input re-appends the <use>, which loses its drag behavior (an FMG quirk, the pan takes over)
    { op: "drag", target: { css: '#stateEmblems > use[data-i="7"]' }, path: [[8, 4], [20, 10], [30, 14]], note: "drag the emblem" },
    { op: "input", id: "emblemSizeNumber", value: 1.4, note: "size 1.4" },
    { op: "input", id: "emblemShapeSelector", value: "swiss", event: "input", note: "shield swiss" },
    { op: "button", id: "emblemsRegenerate", note: "regenerate the arms (seeded)" },
    { op: "close", dialog: "#emblemEditor" }
  ]
};
export default script;
