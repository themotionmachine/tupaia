import { describe, expect, it } from "vitest";
import {
  type IntentInputs,
  type KeyContext,
  type KeyLike,
  keyAction,
  modeView,
  requestMode,
  toggleTarget
} from "./intent";

const base: IntentInputs = { intent: "navigate", editor: "", ready: true, available: true };
const with_ = (patch: Partial<IntentInputs>): IntentInputs => ({ ...base, ...patch });

function key(patch: Partial<KeyLike>): KeyLike {
  return {
    code: "Backslash",
    key: "\\",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 220,
    defaultPrevented: false,
    ...patch
  };
}
const esc = (patch: Partial<KeyLike> = {}) => key({ code: "Escape", key: "Escape", keyCode: 27, ...patch });
const ctx = (patch: Partial<KeyContext> = {}, inputs: Partial<IntentInputs> = {}): KeyContext => ({
  editable: false,
  selection: false,
  blocking: false,
  ...patch,
  inputs: with_(inputs)
});

describe("modeView", () => {
  it("Navigate only with a ready frame, no editor and the navigate intent", () => {
    expect(modeView(base).mode).toBe("navigate");
    expect(modeView(with_({ ready: false })).mode).toBe("preparing");
  });

  it("chosen Edit wins over everything but a fallback, and is not auto", () => {
    expect(modeView(with_({ intent: "edit", ready: false }))).toMatchObject({ mode: "edit", auto: false });
    expect(modeView(with_({ intent: "edit", editor: "editor dialog open" }))).toMatchObject({
      mode: "edit",
      auto: false
    });
  });

  it("an editor opened from Navigate is automatic Edit", () => {
    expect(modeView(with_({ editor: "editor dialog open" }))).toMatchObject({ mode: "edit", auto: true });
    expect(modeView(with_({ editor: "editor customization 1", ready: false }))).toMatchObject({
      mode: "edit",
      auto: true
    });
  });

  it("is unavailable after a fallback to SVG, whatever was asked", () => {
    expect(modeView(with_({ available: false, intent: "edit" })).mode).toBe("unavailable");
  });

  it("every view has a label and a tip (the shortcut is appended by FMG's tip bar)", () => {
    for (const inputs of [base, with_({ ready: false }), with_({ intent: "edit" }), with_({ editor: "x" })]) {
      const view = modeView(inputs);
      expect(view.label).not.toBe("");
      expect(view.tip).not.toBe("");
    }
    expect(modeView(with_({ intent: "edit" })).tip).toContain("Esc");
  });
});

describe("transitions", () => {
  it("the toggle asks for the other displayed mode", () => {
    expect(toggleTarget(base)).toBe("edit");
    expect(toggleTarget(with_({ ready: false }))).toBe("edit"); // Preparing -> Edit cancels the resume
    expect(toggleTarget(with_({ intent: "edit" }))).toBe("navigate");
    expect(toggleTarget(with_({ editor: "editor dialog open" }))).toBe("navigate");
  });

  it("Navigate under an open editor is kept for its close and explained", () => {
    const outcome = requestMode("navigate", with_({ intent: "edit", editor: "editor dialog open" }));
    expect(outcome.intent).toBe("navigate");
    expect(outcome.notice).toMatch(/Close the editor/);
    // still displayed as (automatic) Edit until the editor closes, then Preparing/Navigate
    expect(modeView(with_({ intent: outcome.intent, editor: "editor dialog open" }))).toMatchObject({
      mode: "edit",
      auto: true
    });
    expect(modeView(with_({ intent: outcome.intent, ready: false })).mode).toBe("preparing");
  });

  it("Edit is always granted, Navigate without an editor has no notice", () => {
    expect(requestMode("edit", base)).toEqual({ intent: "edit" });
    expect(requestMode("edit", with_({ editor: "x" }))).toEqual({ intent: "edit" });
    expect(requestMode("navigate", with_({ intent: "edit" }))).toEqual({ intent: "navigate" });
  });

  it("an editor opened under a chosen Edit leaves the chosen Edit in place when it closes", () => {
    const open = with_({ intent: "edit", editor: "editor dialog open" });
    expect(modeView(open)).toMatchObject({ mode: "edit", auto: false });
    expect(modeView({ ...open, editor: "" })).toMatchObject({ mode: "edit", auto: false });
  });
});

describe("keyAction", () => {
  it("\\ toggles from any mode", () => {
    expect(keyAction(key({}), ctx())).toBe("toggle");
    expect(keyAction(key({}), ctx({}, { intent: "edit" }))).toBe("toggle");
    expect(keyAction(key({}), ctx({ blocking: true }, { editor: "x" }))).toBe("toggle");
  });

  it("matches the \\ character on layouts where it sits elsewhere", () => {
    expect(keyAction(key({ code: "IntlBackslash" }), ctx())).toBe("toggle");
    expect(keyAction(key({ key: "#", code: "Backslash" }), ctx())).toBe("toggle"); // physical key, other layout
  });

  it("never while typing, selecting, composing or repeating", () => {
    expect(keyAction(key({}), ctx({ editable: true }))).toBeNull();
    expect(keyAction(key({}), ctx({ selection: true }))).toBeNull();
    expect(keyAction(key({ isComposing: true }), ctx())).toBeNull();
    expect(keyAction(key({ keyCode: 229 }), ctx())).toBeNull();
    expect(keyAction(key({ repeat: true }), ctx())).toBeNull();
    expect(keyAction(key({ defaultPrevented: true }), ctx())).toBeNull();
  });

  it("leaves modifier combinations to the browser and FMG (Shift+\\ is |)", () => {
    for (const mod of ["ctrlKey", "metaKey", "altKey", "shiftKey"] as const)
      expect(keyAction(key({ [mod]: true }), ctx())).toBeNull();
  });

  it("does nothing after a fallback to SVG", () => {
    expect(keyAction(key({}), ctx({}, { available: false }))).toBeNull();
    expect(keyAction(esc(), ctx({}, { available: false, intent: "edit" }))).toBeNull();
  });

  it("Esc leaves a chosen Edit only when nothing else would take the Esc", () => {
    expect(keyAction(esc(), ctx({}, { intent: "edit" }))).toBe("leave-edit");
    expect(keyAction(esc(), ctx({ blocking: true }, { intent: "edit" }))).toBeNull();
    expect(keyAction(esc(), ctx({}, { intent: "edit", editor: "editor dialog open" }))).toBeNull();
    expect(keyAction(esc(), ctx({ editable: true }, { intent: "edit" }))).toBeNull();
    expect(keyAction(esc({ shiftKey: true }), ctx({}, { intent: "edit" }))).toBeNull();
  });

  it("Esc is not taken in Navigate, Preparing or automatic Edit", () => {
    expect(keyAction(esc(), ctx())).toBeNull();
    expect(keyAction(esc(), ctx({}, { ready: false }))).toBeNull();
    expect(keyAction(esc(), ctx({}, { editor: "editor dialog open" }))).toBeNull();
  });

  it("ignores every other key, including FMG's letter and digit hotkeys", () => {
    for (const [code, k] of [
      ["KeyE", "e"],
      ["KeyN", "n"],
      ["Tab", "Tab"],
      ["Digit1", "1"],
      ["Slash", "/"],
      ["Backquote", "`"],
      ["BracketRight", "]"]
    ])
      expect(keyAction(key({ code, key: k }), ctx())).toBeNull();
  });
});
