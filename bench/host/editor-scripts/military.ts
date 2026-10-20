// Military overview and regiments overview (REWRITE-PLAN §5 rows 29 and 30; features/overlays split, EDIT-B): open the
// military overview from the Tools panel (it forces the states, borders and military layers on; military is the subject,
// so it stays on), change state 2's war alert (every regiment's strength text in #armies is rewritten), the percentage
// view, open state 3's regiments list (a second dialog) and switch its filter, close it, recalculate the military of
// every state (Military.generate rebuilds the #armies layer; Math.random is seeded per step), close.
import type { EditorScript } from "../editor-replay-core.ts";

const script: EditorScript = {
  name: "military",
  editor: "overviewMilitary",
  dialog: "#militaryOverview",
  rows: [29, 30],
  description: "open the military overview, war alert, percentage view, regiments list and filter, recalculate, close",
  steps: [
    { op: "display", off: ["goods", "markets", "precipitation", "population", "temperature"] },
    { op: "open", button: "overviewMilitaryButton", expect: { editor: "overviewMilitary", dialog: "#militaryOverview" } },
    { op: "input", css: '#militaryBody div.states[data-id="2"] input[type="number"]', value: 1.5, event: "change", mustChange: true, note: "state 2 war alert" },
    { op: "button", id: "militaryPercentage", dom: true, note: "percentage view" },
    { op: "button", id: "militaryPercentage", dom: true, note: "absolute view" },
    { op: "button", css: '#militaryBody div.states[data-id="3"] span.icon-list-bullet', dom: true, expect: { dialog: "#regimentsOverview" }, note: "state 3's regiments" },
    { op: "input", id: "regimentsFilter", value: "-1", event: "change", uiOnly: true, note: "all states" },
    { op: "close", dialog: "#regimentsOverview", note: "close the regiments list, the military overview stays" },
    { op: "button", id: "militaryOverviewRecalculate", note: "recalculate: asks to confirm" },
    { op: "button", css: '.ui-dialog-buttonset button:has-text("Recalculate")', mustChange: true, note: "confirm: every regiment is regenerated" },
    { op: "close", dialog: "#militaryOverview" }
  ]
};
export default script;
