// Charts overview (statistics): open it from the Tools panel (a lazy dialog), plot two charts (the stacked bar of the
// default entity, then cultures by area with a different chart type), close. It changes no map data: the replay holds
// the model and the model DOM still, and the GPU must suspend for the dialog and resume to a current frame on close.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const script: EditorScript = {
  name: "charts",
  editor: "overviewCharts",
  dialog: "#chartsOverview",
  rows: [29],
  description: "open the charts overview, plot two charts, close (no model change)",
  steps: [
    { op: "display", off: CLUTTER },
    { op: "camera", k: 2, focus: { world: [640, 360] } },
    { op: "open", button: "overviewChartsButton", expect: { dialog: "#chartsOverview" } },
    { op: "button", css: "#chartsOverview__form button[type=submit]", note: "plot the default chart" },
    { op: "input", id: "chartsOverview__entitiesSelect", value: "cultures", event: "change", uiOnly: true, note: "entity: cultures" },
    { op: "input", id: "chartsOverview__chartType", value: "normalizedStackedBar", event: "change", uiOnly: true, note: "normalized bars" },
    { op: "button", css: "#chartsOverview__form button[type=submit]", note: "plot cultures" },
    { op: "close", dialog: "#chartsOverview" }
  ]
};
export default script;
