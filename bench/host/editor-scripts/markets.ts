// Markets overview (REWRITE-PLAN §5 rows 29 and 30; features/overlays split, EDIT-B): open it from the Tools panel
// (the markets layer is the subject, so it stays on), open market 7's stock dialog from its row and rename it, close
// that dialog (the overview stays), then the manual assignment brush (customization 15, painting into the #marketsTemp
// overlay): two strokes, undo the last, a third, apply (pack.cells.market and burg.market change), then the add mode
// (customization 16: a click on a burg founds a market there), close.
import type { EditorScript } from "../editor-replay-core.ts";

// a market 1 / market 7 border (cells 108 and 148); the overview is not an element hit, so every pointer action is a map point
const BORDER: [number, number] = [600, 90];

const script: EditorScript = {
  name: "markets",
  editor: "marketsOverview",
  dialog: "#marketsOverview",
  rows: [29, 30],
  description: "open the markets overview, market 7's dialog and rename, manual brush (2 strokes, undo, 1 stroke, apply), add a market on a burg, close",
  steps: [
    { op: "display", off: ["goods", "precipitation", "population", "temperature", "military"] },
    { op: "camera", k: 8, focus: { world: BORDER } },
    { op: "open", button: "overviewMarketsButton", expect: { dialog: "#marketsOverview" } },
    { op: "button", css: '#marketsOverviewBody .states.market[data-id="7"]', expect: { dialog: "#marketOverview" }, note: "market 7's stock dialog" },
    { op: "input", id: "marketOverviewName", value: "Replay Mart", note: "rename market 7" },
    { op: "close", dialog: "#marketOverview", note: "close the stock dialog, the overview stays" },
    { op: "button", id: "marketsManually", note: "manual assignment (customization 15)" },
    { op: "button", css: '#marketsOverviewBody .states.market[data-id="7"]', note: "select market 7 as the paint" },
    { op: "input", id: "marketsBrush", value: 12, uiOnly: true, note: "brush size" },
    { op: "drag", target: { point: { world: BORDER } }, path: [[16, 0], [32, 8], [48, 8]], brush: true, note: "stroke 1" },
    { op: "drag", target: { point: { world: BORDER }, offset: [0, 50] }, path: [[-16, 0], [-32, 4], [-48, 4]], brush: true, note: "stroke 2" },
    { op: "button", id: "marketsManuallyUndo", mustChange: true, note: "undo stroke 2" },
    { op: "drag", target: { point: { world: BORDER }, offset: [60, 100] }, path: [[12, 0], [24, 4], [36, 6]], brush: true, note: "stroke 3" },
    { op: "button", id: "marketsManuallyApply", mustChange: true, note: "apply the assignment" },
    { op: "button", id: "marketsAdd", note: "add mode (customization 16)" },
    // burg 49 is in market 1 and not a market center; its icon sits off its cell, so aim at the cell centre (568.5, 77.6)
    { op: "click", target: { point: { world: BORDER }, offset: [-252, -99] }, note: "click burg 49: a new market" },
    { op: "close", dialog: "#marketsOverview" }
  ]
};
export default script;
