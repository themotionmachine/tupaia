// Navigate/Edit interaction mode under ?renderer=gpu (decision D10). Pure: no DOM, timers or GL; unit-tested in
// intent.test.ts. The controller (controllers/render-mode.ts) feeds it the renderer's intentProbe() and key events.
//
// Navigate: the GPU canvas shows the map (rendering-only fast path; clicks still recover through the canonical SVG).
// Edit: the canonical SVG is shown with its picking and editors; the GPU is suspended exactly as an open editor
// suspends it. Edit is either chosen (the user asked: it stays until they leave) or automatic (an editor or
// customization opened from Navigate: Navigate returns when the last one closes, as before this mode existed).
// Preparing: Navigate was asked for, but the GPU frame is not current yet (first prepare, a resume after edits, a
// context restore). The canonical SVG stays on screen, correct and usable, until the GPU frame catches up.

export type Intent = "navigate" | "edit";
export type ModeView = "navigate" | "edit" | "preparing" | "unavailable";

export interface IntentInputs {
  intent: Intent; // what the user last asked for
  editor: string; // non-empty while an editor dialog or customization is open
  ready: boolean; // the GPU frame is drawable and current
  available: boolean; // a GPU renderer exists (false after a fallback to SVG)
}

export interface ModeDisplay {
  mode: ModeView;
  auto: boolean; // Edit only because an editor is open, not chosen
  label: string;
  tip: string;
}

export const MODE_KEY_CODE = "Backslash";
export const MODE_KEY_LABEL = "\\";

export function modeView(inputs: IntentInputs): ModeDisplay {
  if (!inputs.available)
    return {
      mode: "unavailable",
      auto: false,
      label: "SVG",
      tip: "GPU rendering is off (fell back to SVG); everything is editable"
    };
  if (inputs.intent === "edit")
    return {
      mode: "edit",
      auto: false,
      label: "Edit",
      tip: "Edit mode: the editable SVG map is shown. Click, or press Esc, to return to Navigate"
    };
  if (inputs.editor)
    return {
      mode: "edit",
      auto: true,
      label: "Edit",
      tip: "Edit mode while the editor is open. Navigate returns when it closes"
    };
  if (!inputs.ready)
    return {
      mode: "preparing",
      auto: false,
      label: "Preparing",
      tip: "Preparing the GPU view. The editable SVG map stays on screen until it is ready"
    };
  return {
    mode: "navigate",
    auto: false,
    label: "Navigate",
    tip: "Navigate mode: fast GPU view. Click to switch to Edit"
  };
}

export interface RequestOutcome {
  intent: Intent;
  notice?: string; // shown to the user when the request cannot take effect yet
}

// The toggle asks for the other mode than the one displayed. Navigate cannot show while an editor is open: the
// request is kept (Navigate returns when the editor closes) and the user is told why the map stays in Edit.
export function requestMode(target: Intent, inputs: IntentInputs): RequestOutcome {
  if (target === "navigate" && inputs.editor)
    return { intent: "navigate", notice: "Close the editor to return to Navigate mode" };
  return { intent: target };
}

export function toggleTarget(inputs: IntentInputs): Intent {
  return modeView(inputs).mode === "edit" ? "navigate" : "edit";
}

export interface KeyLike {
  code: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  isComposing?: boolean;
  keyCode?: number;
  defaultPrevented: boolean;
}

export interface KeyContext {
  editable: boolean; // the event comes from a text field, select or contenteditable
  selection: boolean; // text is selected (FMG's own hotkeys stand down then too)
  blocking: boolean; // a dialog, editor, customization, placement tool, menu panel or the palette is open
  inputs: IntentInputs;
}

export type KeyAction = "toggle" | "leave-edit" | null;

// \ toggles; Esc leaves a chosen Edit only when nothing that Esc closes is open (FMG's Esc closes dialogs and the menu
// on keyup, so a first Esc closes the editor and a second one leaves Edit). Never while typing, composing, with
// modifiers (Ctrl/Cmd/Alt combos belong to the browser and FMG) or on auto-repeat.
export function keyAction(event: KeyLike, context: KeyContext): KeyAction {
  if (!context.inputs.available || event.defaultPrevented || event.repeat) return null;
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (context.editable || context.selection) return null;
  if ((event.code === MODE_KEY_CODE || event.key === MODE_KEY_LABEL) && !event.shiftKey) return "toggle";
  if (event.key === "Escape" && !event.shiftKey) {
    if (context.blocking || context.inputs.editor) return null;
    return context.inputs.intent === "edit" ? "leave-edit" : null;
  }
  return null;
}
