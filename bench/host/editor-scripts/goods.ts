// Goods editor (REWRITE-PLAN §5 rows 29 and 30; features/overlays split, EDIT-B): open it from the Tools panel (it
// forces the goods layer on and redraws it, so that overlay stays on), toggle a good's map display, the percentage
// view, the master display checkbox off and on, then the resource assign mode (customization 14: the cells layer is
// forced on, a click on a cell sets or clears a bonus resource and redraws the goods layer), exit it, close.
import type { EditorScript } from "../editor-replay-core.ts";

const C: [number, number] = [525, 428];

const script: EditorScript = {
  name: "goods",
  editor: "goodsEditor",
  dialog: "#goodsEditor",
  rows: [29, 30],
  description: "open the goods editor, toggle displays and percentages, assign a resource to two cells and clear one, close",
  steps: [
    { op: "display", off: ["markets", "precipitation", "population", "temperature", "military"] },
    { op: "camera", k: 8, focus: { world: C } },
    { op: "open", button: "editGoods", expect: { dialog: "#goodsEditor" } },
    { op: "button", css: "#goodsBody .goodDisplayed", dom: true, mustChange: true, note: "toggle the first good's map display" },
    { op: "button", id: "goodsPercentage", dom: true, note: "percentage view" },
    { op: "button", id: "goodsPercentage", dom: true, note: "absolute view" },
    { op: "input", id: "goodsDisplayAll", checked: false, mustChange: true, note: "hide every good" },
    { op: "input", id: "goodsDisplayAll", checked: true, mustChange: true, note: "show every good" },
    { op: "button", id: "goodsAssign", note: "resource assign mode (customization 14, cells forced on)" },
    { op: "button", css: '#goodsBody div.states[data-id="3"]', note: "select good 3" },
    { op: "click", target: { point: { world: C }, offset: [-40, -30] }, note: "cell A: assign the resource" },
    { op: "click", target: { point: { world: C }, offset: [60, 40] }, note: "cell B: assign the resource" },
    { op: "click", target: { point: { world: C }, offset: [-40, -30] }, note: "cell A again: clears it" },
    { op: "button", id: "goodsAssign", note: "leave the assign mode" },
    { op: "close", dialog: "#goodsEditor" }
  ]
};
export default script;
