import {
  buildPaletteIndex,
  defaultPaletteActive,
  normalizePaletteText,
  type PaletteActionId,
  type PaletteCandidate,
  type PaletteWorld,
  paletteCandidate,
  resolvePaletteLocation,
  searchPalette
} from "./command-palette-search";

// Classic main.js owns these globals, including the lexical D3 zoom controller.
declare const zoom: { scaleExtent(): number[] };
declare function resetZoom(duration?: number): void;

export interface CommandPalette {
  open(): void;
  close(): void;
  dispose(): void;
}

interface PaletteView {
  dialog: HTMLDialogElement;
  input: HTMLInputElement;
  list: HTMLDivElement;
  status: HTMLParagraphElement;
  world: PaletteWorld | null;
  index: PaletteCandidate[];
  results: PaletteCandidate[];
  active: number;
  restore: HTMLElement | SVGElement | null;
}

const launcherSelector = "[data-command-palette], #openCommandPalette";
const lifecycleEvents = ["map:loading", "map:loaded", "map:generated", "map:resampled"];
let installed: CommandPalette | null = null;

function visible(element: Element): boolean {
  return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
}

function currentWorld(): PaletteWorld | null {
  // The deferred classic scripts may not have initialized their lexical globals yet.
  try {
    if (typeof pack === "undefined" || typeof modules === "undefined" || !modules.editors) return null;
    if (!Array.isArray(pack.burgs) || !Array.isArray(pack.states) || !Array.isArray(pack.routes)) return null;
    if (!Array.isArray(pack.cells?.p) || !(graphWidth > 0) || !(graphHeight > 0)) return null;
    if (!(svgWidth > 0) || !(svgHeight > 0) || typeof zoomTo !== "function") return null;
    if (
      ["loading", "mapOverlay"].some(id => {
        const overlay = document.getElementById(id);
        return overlay && visible(overlay);
      })
    )
      return null;
    return pack;
  } catch {
    return null;
  }
}

function editableEvent(event: KeyboardEvent): boolean {
  return event
    .composedPath()
    .some(
      target =>
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          !!target.closest(
            "input, textarea, select, [role='textbox'], [contenteditable]:not([contenteditable='false'])"
          ))
    );
}

function creationBlock(): string | undefined {
  if (typeof customization !== "undefined" && customization) return "Finish customization first";
  if (Array.from(document.querySelectorAll(".dialog, .ui-dialog")).some(visible))
    return "Close the current editor first";
  if (document.querySelector("#addFeature button.pressed")) return "Finish the current placement tool first";
  return undefined;
}

function actionCandidates(ready: boolean): PaletteCandidate[] {
  const blocked = ready ? creationBlock() : "The map is not ready yet";
  const label = paletteCandidate(
    { kind: "action", id: "add-label" },
    "Add a label",
    "Click the map to place it",
    "text name annotation"
  );
  const route = paletteCandidate(
    { kind: "action", id: "draw-route" },
    "Draw a route",
    "Connect places on the map",
    "add road path trail"
  );
  const whole = paletteCandidate(
    { kind: "action", id: "whole-map" },
    "Show the whole map",
    "Return to the full map view",
    "reset zoom out overview"
  );
  label.disabled = blocked || (!document.getElementById("addLabel") ? "Label tool is unavailable" : undefined);
  route.disabled = blocked || (!document.getElementById("addRoute") ? "Route tool is unavailable" : undefined);
  whole.disabled = !ready ? "The map is not ready yet" : undefined;
  return [label, route, whole, ...modeCandidates()];
}

// Navigate/Edit mode commands exist only while controllers/render-mode.ts is installed (?renderer=gpu).
function modeCandidates(): PaletteCandidate[] {
  const mode = window.renderMode?.state();
  if (!mode) return [];
  const navigate = paletteCandidate(
    { kind: "action", id: "navigate-mode" },
    "Navigate mode",
    "Fast GPU view for panning and zooming (\\)",
    "gpu fast view browse pan zoom render"
  );
  const edit = paletteCandidate(
    { kind: "action", id: "edit-mode" },
    "Edit mode",
    "Editable SVG map with editors and picking (\\)",
    "svg editors editing pick select canonical"
  );
  const off = mode.mode === "unavailable" ? "GPU rendering is off" : undefined;
  navigate.disabled =
    off || (mode.intent === "navigate" && mode.mode !== "edit" ? "Already in Navigate mode" : undefined);
  edit.disabled = off || (mode.intent === "edit" ? "Already in Edit mode" : undefined);
  return [navigate, edit];
}

function createStyles(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = /* css */ `
    #commandPalette {
      box-sizing: border-box; width: min(560px, calc(100vw - 24px));
      max-height: min(640px, calc(100dvh - 32px)); margin: min(16vh, 100px) auto auto;
      padding: 0; overflow: auto; border: 1px solid #95858d; border-radius: 12px;
      background: #fffdfa; color: #29252c; box-shadow: 0 16px 56px #251e3133;
      font: 15px/1.4 system-ui, sans-serif; text-align: left;
    }
    #commandPalette::backdrop { background: #221b2a33; }
    #commandPalette .palette-heading { display: flex; align-items: center; gap: 12px; padding: 16px 18px 8px; }
    #commandPalette h2 { margin: 0; flex: 1; font: 600 14px/1.4 system-ui, sans-serif; }
    #commandPalette .palette-close {
      min-width: 44px; min-height: 44px; margin: -8px -8px -8px 0; padding: 4px;
      border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit;
    }
    #commandPalette input {
      box-sizing: border-box; display: block; width: calc(100% - 36px); height: 46px;
      margin: 8px 18px 12px; padding: 10px 12px; border: 1px solid #95858d;
      border-radius: 7px; background: white; color: #29252c; font: inherit;
    }
    #commandPalette :focus-visible { outline: 2px solid #624954; outline-offset: 2px; }
    #commandPalette .palette-results { padding: 0 8px; max-height: 370px; overflow: auto; }
    #commandPalette [role="option"] { min-height: 44px; padding: 8px 10px; border-radius: 7px; cursor: pointer; }
    #commandPalette [aria-selected="true"] { background: #eae2e8; outline: 1px solid #c4b3bf; outline-offset: -1px; }
    #commandPalette [aria-disabled="true"] { color: #625c64; cursor: default; }
    #commandPalette .palette-name { display: block; font-weight: 550; overflow-wrap: anywhere; }
    #commandPalette .palette-detail { display: block; font-size: 12px; color: #655c67; }
    #commandPalette .palette-status { margin: 12px 18px; font-size: 12px; color: #655c67; }
    #commandPalette .palette-footer { margin: 0; padding: 10px 18px; border-top: 1px solid #e6e0e5; font-size: 12px; color: #655c67; }
    @media (max-height: 540px) { #commandPalette { margin-top: 12px; } #commandPalette .palette-results { max-height: 36vh; } }
  `;
  document.head.append(style);
  return style;
}

/** Install once; legacy globals and dialog DOM are read/created only when opened. */
export function initializeCommandPalette(): CommandPalette {
  if (installed) return installed;
  let view: PaletteView | null = null;
  let styles: HTMLStyleElement | null = null;
  let composing = false;
  const consumed = new Set<string>();
  const modifiers = new Set<string>();

  function close(): void {
    const previous = view;
    if (!previous) return;
    view = null;
    composing = false;
    previous.dialog.close();
    previous.dialog.remove();
    const restore =
      previous.restore?.isConnected &&
      previous.restore !== document.body &&
      !previous.restore.matches(":disabled, [inert]") &&
      visible(previous.restore)
        ? previous.restore
        : document.querySelector<HTMLElement>(launcherSelector);
    restore?.focus({ preventScroll: true });
  }

  function refresh(): void {
    if (!view) return;
    if (view.world !== currentWorld()) {
      close();
      return;
    }
    const actions = actionCandidates(!!view.world);
    const query = normalizePaletteText(view.input.value);
    const matches = query
      ? searchPalette([...view.index, ...actions], query)
      : { results: actions, total: actions.length };
    view.results = matches.results;
    view.active = defaultPaletteActive(view.results, query);
    view.list.replaceChildren();
    view.results.forEach((result, index) => {
      const option = document.createElement("div");
      option.id = `commandPaletteOption${index}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-disabled", String(!!result.disabled));
      const name = document.createElement("span");
      name.className = "palette-name";
      name.textContent = result.label;
      const detail = document.createElement("span");
      detail.className = "palette-detail";
      detail.textContent = result.disabled || result.detail;
      option.append(name, detail);
      option.addEventListener("mousedown", event => event.preventDefault());
      option.addEventListener("click", () => activate(index));
      view!.list.append(option);
    });
    view.status.textContent = !view.world
      ? "The map is not ready yet. Try again when it has finished loading."
      : !query
        ? "Search settlements, states and routes, or choose a drawing tool."
        : matches.total
          ? `${matches.total} result${matches.total === 1 ? "" : "s"}${matches.total > matches.results.length ? ` · Showing ${matches.results.length}` : ""}`
          : "No matches. Try another name, or search for a drawing tool.";
    selectActive();
  }

  function selectActive(): void {
    if (!view) return;
    const active = view.active;
    Array.from(view.list.children).forEach((option, index) => {
      option.setAttribute("aria-selected", String(index === active));
    });
    const selected = view.list.children[view.active];
    if (selected) {
      view.input.setAttribute("aria-activedescendant", selected.id);
      selected.scrollIntoView({ block: "nearest" });
    } else view.input.removeAttribute("aria-activedescendant");
  }

  function move(direction: number): void {
    if (!view?.results.length) return;
    const count = view.results.length;
    let next = view.active < 0 ? (direction > 0 ? -1 : 0) : view.active;
    for (let i = 0; i < count; i++) {
      next = (next + direction + count) % count;
      if (!view.results[next].disabled) {
        view.active = next;
        view.input.focus();
        selectActive();
        return;
      }
    }
  }

  function activate(index: number): void {
    if (!view) return;
    const result = view.results[index];
    if (!result) {
      // Enter with nothing preselected: say why the best match is unavailable instead of guessing.
      const blocked = index < 0 && normalizePaletteText(view.input.value) && view.results[0]?.disabled;
      if (blocked) view.status.textContent = `${view.results[0].label} is unavailable: ${blocked}.`;
      return;
    }
    const world = currentWorld();
    if (!world || world !== view.world) {
      close();
      return;
    }
    if (result.key.kind === "action") {
      const action = actionCandidates(true).find(candidate => candidate.key.id === result.key.id);
      if (!action || action.disabled) {
        refresh();
        return;
      }
      const id: PaletteActionId = result.key.id;
      close();
      if (id === "whole-map") resetZoom(motionDuration());
      else if (id === "navigate-mode" || id === "edit-mode")
        window.renderMode?.set(id === "edit-mode" ? "edit" : "navigate");
      else document.getElementById(id === "add-label" ? "addLabel" : "addRoute")?.click();
      return;
    }
    const location = resolvePaletteLocation(
      world,
      result.key,
      { width: svgWidth, height: svgHeight },
      zoom.scaleExtent()
    );
    if (!location) {
      view.index = buildPaletteIndex(world);
      refresh();
      if (view) view.status.textContent = "That place is no longer available. Choose another result.";
      return;
    }
    close();
    zoomTo(location.x, location.y, location.scale, motionDuration());
  }

  function motionDuration(): number {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180;
  }

  function open(): void {
    if (view) {
      view.input.focus();
      return;
    }
    if (!styles) styles = createStyles();
    const dialog = document.createElement("dialog");
    dialog.id = "commandPalette";
    dialog.setAttribute("aria-labelledby", "commandPaletteTitle");
    dialog.innerHTML = `<div class="palette-heading"><h2 id="commandPaletteTitle">Find a place or start sketching</h2><button type="button" class="palette-close" aria-label="Close search">Esc</button></div>
      <input id="commandPaletteInput" type="search" role="combobox" aria-label="Search places and drawing tools" aria-autocomplete="list" aria-expanded="true" aria-controls="commandPaletteResults" autocomplete="off" spellcheck="false" placeholder="Search settlements, states, routes…">
      <div id="commandPaletteResults" class="palette-results" role="listbox" aria-label="Places and drawing tools"></div>
      <p class="palette-status" role="status" aria-live="polite" aria-atomic="true"></p>
      <p class="palette-footer">↑↓ Navigate &nbsp; ↵ Go &nbsp; Esc Close</p>`;
    const world = currentWorld();
    const focused = document.activeElement;
    view = {
      dialog,
      input: dialog.querySelector("input")!,
      list: dialog.querySelector<HTMLDivElement>(".palette-results")!,
      status: dialog.querySelector<HTMLParagraphElement>(".palette-status")!,
      world,
      index: world ? buildPaletteIndex(world) : [],
      results: [],
      active: -1,
      restore: focused instanceof HTMLElement || focused instanceof SVGElement ? focused : null
    };
    dialog.querySelector("button")!.addEventListener("click", close);
    dialog.addEventListener("click", event => event.stopPropagation());
    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      if (!composing) close();
    });
    dialog.addEventListener("close", () => {
      if (view?.dialog === dialog) close();
    });
    view.input.addEventListener("input", refresh);
    view.input.addEventListener("compositionstart", () => {
      composing = true;
    });
    view.input.addEventListener("compositionend", () => {
      composing = false;
      refresh();
    });
    document.body.append(dialog);
    dialog.showModal();
    view.input.focus();
    refresh();
  }

  function remember(event: KeyboardEvent): void {
    consumed.add(event.code || event.key);
    if (event.ctrlKey) modifiers.add("Control");
    if (event.metaKey) modifiers.add("Meta");
  }

  function keydown(event: KeyboardEvent): void {
    const shortcut =
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      (event.code === "KeyK" || event.key.toLowerCase() === "k");
    if (!view) {
      const code = event.code || event.key;
      if (event.repeat && consumed.has(code)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!event.repeat) {
        consumed.delete(code);
        modifiers.delete(event.key);
      }
      if (!shortcut || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return;
      if (editableEvent(event) || window.getSelection()?.toString()) return;
      remember(event);
      event.preventDefault();
      event.stopImmediatePropagation();
      open();
      return;
    }
    // Legacy map shortcuts execute on keyup, including keys that close this dialog.
    remember(event);
    event.stopImmediatePropagation();
    if (event.isComposing || event.keyCode === 229 || composing) return;
    if (shortcut || event.key === "Escape") {
      event.preventDefault();
      if (!event.repeat) close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && event.target === view.input) {
      event.preventDefault();
      if (!event.repeat) activate(view.active);
    }
  }

  function keyup(event: KeyboardEvent): void {
    const code = event.code || event.key;
    if (view || consumed.has(code) || modifiers.has(event.key)) {
      event.stopImmediatePropagation();
      consumed.delete(code);
      modifiers.delete(event.key);
    }
  }

  function blur(): void {
    consumed.clear();
    modifiers.clear();
    composing = false;
  }

  function launch(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target.closest(launcherSelector) : null;
    if (!target) return;
    event.preventDefault();
    open();
  }

  window.addEventListener("keydown", keydown, true);
  window.addEventListener("keyup", keyup, true);
  window.addEventListener("blur", blur);
  document.addEventListener("click", launch);
  for (const event of lifecycleEvents) window.addEventListener(event, close);
  installed = {
    open,
    close,
    dispose() {
      close();
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup, true);
      window.removeEventListener("blur", blur);
      document.removeEventListener("click", launch);
      for (const event of lifecycleEvents) window.removeEventListener(event, close);
      styles?.remove();
      consumed.clear();
      modifiers.clear();
      installed = null;
    }
  };
  return installed;
}
