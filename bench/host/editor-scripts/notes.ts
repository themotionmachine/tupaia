// Notes editor (REWRITE-PLAN §5 rows 29 and 30; features/overlays split, EDIT-B): open it from the Tools panel (the
// parity fixture carries 115 notes: regiment and marker legends), switch to marker 9's note, rename it, type into its
// legend (a contenteditable; blur writes it back; the tinymce CDN is blocked in the harness, so the plain div is the
// editor), toggle the pin option, remove the note (confirmation dialog; the editor shows the next note), close.
// `notes` is a top-level let of main.js and is hashed through its binding (editor-replay-page.ts modelHashes).
import type { EditorScript } from "../editor-replay-core.ts";
import { CLUTTER } from "./common.ts";

const script: EditorScript = {
  name: "notes",
  editor: "editNotes",
  dialog: "#notesEditor",
  rows: [29, 30],
  description: "open from Tools, pick marker9's note, rename, type a legend, pin, remove, close",
  steps: [
    // decluttered like the other editor scripts: the D12 resume goal is judged on these, not on the every-layer map
    { op: "display", off: CLUTTER },
    { op: "display", off: ["zones", "states", "provinces", "religions", "cultures"] },
    { op: "open", button: "editNotesButton", expect: { editor: "editNotes", dialog: "#notesEditor" } },
    { op: "input", id: "notesSelect", value: "marker9", event: "change", uiOnly: true, note: "show marker9's note (the editor only fills its fields)" },
    { op: "input", id: "notesName", value: "Replay Dungeon", note: "rename the note" },
    { op: "button", css: "#notesLegend", note: "focus the legend" },
    { op: "key", key: "R" },
    { op: "key", key: "w" },
    { op: "button", css: "#notesName", mustChange: true, note: "blur the legend (writes it to the note)" },
    { op: "button", id: "notesPin", note: "pin the notes box (options.pinNotes)" },
    { op: "button", id: "notesRemove", note: "remove the note: asks to confirm" },
    { op: "button", css: '.ui-dialog-buttonset button:has-text("Remove")', mustChange: true, note: "confirm: the note goes, the editor shows the next one" },
    { op: "close", dialog: "#notesEditor" }
  ]
};
export default script;
