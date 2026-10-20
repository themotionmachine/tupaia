// Namesbase editor (cultures' name generation data): open it from the Tools panel (a lazy dialog), pick another
// namesbase, rename it, change its length limits, edit its names data (rebuilds the Markov chain), close. The data
// lives in `nameBases` (a top-level let), not in pack: it joins the replay's model hashes. Nothing on the map changes.
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const script: EditorScript = {
  name: "namesbase",
  editor: "editNamesBase",
  dialog: "#namesbaseEditor",
  rows: [29],
  description: "open the namesbase editor, pick a base, rename, limits, names data, close",
  steps: [
    { op: "display", off: CLUTTER },
    { op: "camera", k: 2, focus: { world: [640, 360] } },
    { op: "open", button: "editNamesBaseButton", expect: { dialog: "#namesbaseEditor" } },
    { op: "input", id: "namesbaseSelect", value: "2", event: "change", uiOnly: true, note: "pick base 2" },
    { op: "input", id: "namesbaseName", value: "Replay base", note: "rename the base" },
    { op: "input", id: "namesbaseMin", value: 3, note: "minimum length" },
    { op: "input", id: "namesbaseTextarea", value: "Alba,Berun,Cador,Dunmere,Eskel,Fenwick,Garrow", event: "change", note: "names data" },
    { op: "close", dialog: "#namesbaseEditor" }
  ]
};
export default script;
