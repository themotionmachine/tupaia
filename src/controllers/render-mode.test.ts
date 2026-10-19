// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { escapeBlocked, type IntentRenderer, installRenderMode, type RenderModeApi } from "./render-mode";

class FakeRenderer implements IntentRenderer {
  edit = false;
  calls: boolean[] = [];
  editor = "";
  frame = true; // a frame exists and is current once not held
  held = false;
  current = true; // the frame on screen has every DOM revision
  setIntent(edit: boolean): void {
    this.edit = edit;
    this.calls.push(edit);
    this.held = true; // like the renderer: any change of intent re-judges the frame
  }
  intentProbe() {
    const suspended = this.editor || (this.edit ? "edit mode" : "");
    if (!suspended && this.held && this.frame) this.held = false;
    return { editor: this.editor, ready: !suspended && this.frame && !this.held, current: this.current, lost: false };
  }
}

let renderer: FakeRenderer | null;
let gpuActive: boolean;
let notices: string[];
let api: RenderModeApi;

const indicator = () => document.getElementById("renderModeIndicator") as HTMLButtonElement;
function press(code: string, key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
  const down = new KeyboardEvent("keydown", { code, key, bubbles: true, cancelable: true, composed: true, ...init });
  target.dispatchEvent(down);
  const up = new KeyboardEvent("keyup", { code, key, bubbles: true, cancelable: true, composed: true, ...init });
  target.dispatchEvent(up);
  return { down, up };
}
const backslash = (target?: EventTarget, init?: KeyboardEventInit) => press("Backslash", "\\", init, target);
const pressEscape = () => press("Escape", "Escape");
function dialog(): HTMLElement {
  const element = document.createElement("div");
  element.className = "ui-dialog";
  element.textContent = "editor";
  document.body.append(element);
  return element;
}

beforeEach(() => {
  document.body.innerHTML = "";
  renderer = new FakeRenderer();
  gpuActive = true;
  notices = [];
  // happy-dom lays nothing out: treat every connected, non-display:none element as shown
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    const hidden = (this as HTMLElement).style?.display === "none" || !this.isConnected;
    return (hidden ? [] : [{}]) as unknown as DOMRectList;
  });
  api = installRenderMode({
    renderer: () => renderer,
    gpuActive: () => gpuActive,
    notice: text => notices.push(text)
  });
});

afterEach(() => {
  api.dispose();
  vi.restoreAllMocks();
});

describe("indicator", () => {
  it("shows Navigate with the shortcut and a tip, and exposes window.renderMode", () => {
    expect(indicator().dataset.mode).toBe("navigate");
    expect(indicator().textContent).toContain("Navigate");
    expect(indicator().dataset.shortcut).toBe("\\");
    expect(indicator().dataset.tip).toMatch(/Navigate mode/);
    expect(indicator().title).toMatch(/Shortcut: \\/);
    expect(window.renderMode).toBe(api);
  });

  it("reads Updating while the GPU frame on screen predates an edit, then Navigate", () => {
    renderer!.current = false;
    expect(api.state()).toMatchObject({ mode: "preparing", label: "Updating" });
    expect(indicator().textContent).toContain("Updating");
    renderer!.current = true;
    expect(api.state().mode).toBe("navigate");
  });

  it("records where the last request came from", () => {
    expect(api.state().lastChange).toBeNull();
    indicator().click();
    expect(api.state().lastChange).toMatchObject({ intent: "edit", via: "click" });
    backslash();
    expect(api.state().lastChange).toMatchObject({ intent: "navigate", via: "key" });
    api.set("edit");
    pressEscape();
    expect(api.state().lastChange).toMatchObject({ intent: "navigate", via: "esc" });
  });

  it("click toggles Edit and back", () => {
    indicator().click();
    expect(renderer!.edit).toBe(true);
    expect(indicator().dataset.mode).toBe("edit");
    indicator().click();
    expect(renderer!.edit).toBe(false);
    expect(indicator().dataset.mode).toBe("navigate");
  });

  it("shows Preparing while the frame is not current, then Navigate", () => {
    api.set("edit");
    renderer!.frame = false; // edits made in Edit: the resume prepare has not committed yet
    api.set("navigate");
    expect(indicator().dataset.mode).toBe("preparing");
    renderer!.frame = true;
    expect(api.state().mode).toBe("navigate");
    expect(indicator().dataset.mode).toBe("navigate");
  });

  it("shows automatic Edit while an editor is open and returns to Navigate when it closes", () => {
    renderer!.editor = "editor dialog open";
    expect(api.state()).toMatchObject({ mode: "edit", auto: true, intent: "navigate" });
    expect(indicator().textContent).toContain("Edit · editor");
    expect(renderer!.calls).toEqual([false]); // the automatic Edit never touches the intent
    renderer!.editor = "";
    expect(api.state().mode).toBe("navigate");
  });

  it("applies the intent to a renderer that appears late (lazy GPU module)", () => {
    const late = renderer!;
    renderer = null;
    api.set("edit");
    expect(api.state().mode).toBe("edit");
    renderer = late;
    late.calls = [];
    api.state();
    expect(late.calls).toEqual([true]);
    api.state();
    expect(late.calls).toEqual([true]); // once
  });

  it("shows Preparing while the GPU module loads and SVG after a fallback", () => {
    renderer = null;
    expect(api.state().mode).toBe("preparing");
    gpuActive = false;
    expect(api.state().mode).toBe("unavailable");
    expect(indicator().textContent).toContain("SVG");
    backslash();
    expect(api.state().mode).toBe("unavailable");
    indicator().click();
    expect(notices.at(-1)).toMatch(/GPU rendering is off/);
  });

  it("dispose removes the indicator and returns the renderer to Navigate", () => {
    api.set("edit");
    api.dispose();
    expect(indicator()).toBeNull();
    expect(renderer!.edit).toBe(false);
    expect(window.renderMode).toBeUndefined();
    api = installRenderMode({ renderer: () => renderer, gpuActive: () => true, notice: () => {} });
  });
});

describe("keys", () => {
  it("\\ toggles Navigate <-> Edit and is consumed (keydown and keyup)", () => {
    const seen: string[] = [];
    const legacy = (event: KeyboardEvent) => seen.push(`${event.type}:${event.code}`);
    document.addEventListener("keydown", legacy);
    document.addEventListener("keyup", legacy);
    const { down } = backslash();
    expect(down.defaultPrevented).toBe(true);
    expect(api.state().mode).toBe("edit");
    backslash();
    expect(api.state().mode).toBe("navigate");
    expect(seen).toEqual([]);
    document.removeEventListener("keydown", legacy);
    document.removeEventListener("keyup", legacy);
  });

  it("is ignored while typing in inputs, textareas, selects and contenteditable", () => {
    const fields = [
      document.createElement("input"),
      document.createElement("textarea"),
      document.createElement("select"),
      Object.assign(document.createElement("div"), { contentEditable: "true" })
    ];
    for (const field of fields) {
      document.body.append(field);
      const { down } = backslash(field);
      expect(down.defaultPrevented).toBe(false);
      expect(api.state().mode).toBe("navigate");
    }
    // a child of a contenteditable host counts too
    const host = Object.assign(document.createElement("div"), { contentEditable: "true" });
    const child = document.createElement("span");
    host.append(child);
    document.body.append(host);
    backslash(child);
    expect(api.state().mode).toBe("navigate");
  });

  it("leaves Ctrl/Cmd/Alt/Shift combinations alone", () => {
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
      const { down } = backslash(document.body, init);
      expect(down.defaultPrevented).toBe(false);
    }
    expect(api.state().mode).toBe("navigate");
  });

  it("Esc returns from a chosen Edit when no dialog is open", () => {
    api.set("edit");
    pressEscape();
    expect(api.state().mode).toBe("navigate");
  });

  it("Esc with an editor open is left to FMG (it closes the editor); a second Esc leaves Edit", () => {
    api.set("edit");
    const editor = dialog();
    renderer!.editor = "editor dialog open";
    pressEscape();
    expect(api.state()).toMatchObject({ mode: "edit", intent: "edit" });
    editor.remove(); // FMG's keyup closed it
    renderer!.editor = "";
    expect(api.state().mode).toBe("edit"); // a chosen Edit outlives the editor
    pressEscape();
    expect(api.state().mode).toBe("navigate");
  });

  it("Esc is blocked by any dialog, the menu panel, a placement tool or an open <dialog>", () => {
    api.set("edit");
    const blockers: (() => HTMLElement)[] = [
      dialog,
      () => Object.assign(document.createElement("div"), { className: "dialog" }),
      () => Object.assign(document.createElement("div"), { id: "options" }),
      () => {
        const bar = Object.assign(document.createElement("div"), { id: "addFeature" });
        bar.innerHTML = '<button class="pressed"></button>';
        return bar;
      },
      () => {
        const modal = document.createElement("dialog");
        modal.setAttribute("open", "");
        return modal;
      }
    ];
    for (const make of blockers) {
      const element = make();
      document.body.append(element);
      expect(escapeBlocked()).toBe(true);
      pressEscape();
      expect(api.state().intent).toBe("edit");
      element.remove();
    }
    expect(escapeBlocked()).toBe(false);
  });

  it("a hidden dialog or menu does not block Esc", () => {
    api.set("edit");
    const hidden = dialog();
    hidden.style.display = "none";
    const options = Object.assign(document.createElement("div"), { id: "options" });
    options.style.display = "none";
    document.body.append(options);
    pressEscape();
    expect(api.state().mode).toBe("navigate");
  });

  it("\\ under an open editor keeps Edit, explains why and returns to Navigate on close", () => {
    api.set("edit");
    renderer!.editor = "editor dialog open";
    backslash();
    expect(notices.at(-1)).toMatch(/Close the editor/);
    expect(api.state()).toMatchObject({ mode: "edit", auto: true, intent: "navigate" });
    renderer!.editor = "";
    expect(api.state().mode).toBe("navigate");
  });

  it("\\ from Preparing goes back to Edit (cancels the resume)", () => {
    api.set("edit");
    renderer!.frame = false;
    api.set("navigate");
    expect(api.state().mode).toBe("preparing");
    backslash();
    expect(api.state().mode).toBe("edit");
    expect(renderer!.edit).toBe(true);
  });

  it("does not probe the renderer for keys that cannot act (typing stays cheap)", () => {
    const probe = vi.spyOn(renderer!, "intentProbe");
    const input = document.createElement("input");
    document.body.append(input);
    for (const key of "typing a name #1") press(key === " " ? "Space" : "KeyA", key, {}, input);
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not react to FMG hotkeys", () => {
    for (const [code, key] of [
      ["KeyE", "e"],
      ["KeyS", "s"],
      ["Tab", "Tab"],
      ["Digit2", "2"]
    ]) {
      const { down } = press(code, key);
      expect(down.defaultPrevented).toBe(false);
    }
    expect(api.state().mode).toBe("navigate");
  });
});

describe("collision guard", () => {
  // FMG's hotkeys.js binds almost every letter, digit and punctuation key (with and without Shift); the mode key must
  // stay one it does not bind, or both would fire.
  const hotkeys = readFileSync(resolve(__dirname, "../../public/modules/ui/hotkeys.js"), "utf8");
  // FMG's character bindings (`key === "#"` etc.): these follow the layout, so they are what the mode must never take
  const fmgKeys = [...hotkeys.matchAll(/key === "((?:[^"\\]|\\.)+)"/g)].map(match => JSON.parse(`"${match[1]}"`));
  // What the physical Backslash key types, unshifted and shifted, on common layouts
  const backslashKeyTypes: Record<string, string[]> = {
    US: ["\\", "|"],
    "UK ISO": ["#", "~"],
    German: ["#", "'"],
    "French AZERTY": ["*", "µ"],
    Swiss: ["$", "£"],
    Spanish: ["ç", "Ç"],
    Italian: ["ù", "§"],
    Nordic: ["'", "*"],
    Portuguese: ["~", "^"]
  };

  it("FMG's hotkeys.js binds neither the Backslash code nor the \\ or | characters", () => {
    expect(fmgKeys).toContain("#"); // the parse sees FMG's character bindings
    expect(hotkeys).not.toMatch(/Backslash/);
    expect(fmgKeys).not.toContain("\\");
    expect(fmgKeys).not.toContain("|");
  });

  it("the Backslash key reaches FMG on every layout where it types an FMG character binding", () => {
    const fmgUp: string[] = [];
    const listener = (event: KeyboardEvent) => fmgUp.push(event.key);
    document.addEventListener("keyup", listener); // where hotkeys.js listens
    try {
      for (const [layout, typed] of Object.entries(backslashKeyTypes))
        for (const [index, key] of typed.entries()) {
          if (key === "\\" || !fmgKeys.includes(key)) continue;
          fmgUp.length = 0;
          const { down } = press("Backslash", key, { shiftKey: index === 1 });
          expect(down.defaultPrevented, `${layout} ${key}`).toBe(false);
          expect(fmgUp, `${layout} ${key}`).toEqual([key]);
          expect(api.state().mode, `${layout} ${key}`).toBe("navigate");
        }
    } finally {
      document.removeEventListener("keyup", listener);
    }
  });

  it("no FMG character binding toggles the mode, whichever key types it", () => {
    for (const key of fmgKeys)
      for (const code of ["Backslash", "IntlBackslash", "Digit3"]) {
        const { down } = press(code, key);
        expect(down.defaultPrevented, `${code} ${key}`).toBe(false);
      }
    expect(api.state().mode).toBe("navigate");
    expect(renderer!.calls).toEqual([false]);
  });

  it("no other module binds Backslash", () => {
    const palette = readFileSync(resolve(__dirname, "command-palette.ts"), "utf8");
    expect(palette).not.toMatch(/Backslash/);
  });
});
