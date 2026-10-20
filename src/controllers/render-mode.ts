// Navigate/Edit mode UI under ?renderer=gpu (decision D10): the mode indicator, the \ and Esc keys and the
// window.renderMode API the command palette uses. Loaded only when the GPU renderer was requested
// (controllers/index.ts); the default SVG renderer never imports it. The state machine is src/gpu/intent.ts; the
// renderer side is GpuRenderer.setIntent()/intentProbe() (the MODE block in src/gpu/renderer.ts).
import {
  type Intent,
  type IntentInputs,
  keyAction,
  MODE_KEY_LABEL,
  type ModeDisplay,
  maybeModeKey,
  modeView,
  requestMode,
  toggleTarget
} from "../gpu/intent";

export interface IntentRenderer {
  setIntent(edit: boolean): void;
  intentProbe(): {
    editor: string;
    ready: boolean;
    current?: boolean;
    lost: boolean;
    holdMs?: number;
    holdRevisions?: number;
  };
}

export type ChangeSource = "key" | "esc" | "click" | "palette" | "api";

export interface RenderModeApi {
  // lastChange: the most recent request and where it came from (diagnostics: a harness click that lands on the indicator)
  state(): ModeDisplay & { intent: Intent; lastChange: { intent: Intent; via: ChangeSource; at: number } | null };
  set(intent: Intent, via?: ChangeSource): ModeDisplay;
  toggle(): ModeDisplay;
  dispose(): void;
}

interface Host {
  renderer(): IntentRenderer | null; // window.gpuRenderer
  gpuActive(): boolean; // the router still runs (or is loading) the GPU backend
  notice(text: string): void;
}

const POLL_MS = 200;
let installed: RenderModeApi | null = null;

function shown(element: Element): boolean {
  return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
}

function editableTarget(event: Event): boolean {
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

// What a first Esc would close instead (FMG closes dialogs and the menu on Esc keyup), or a modal that owns the keys.
export function escapeBlocked(doc: Document = document): boolean {
  if (typeof customization !== "undefined" && customization) return true;
  if ([...doc.querySelectorAll(".ui-dialog, .dialog")].some(shown)) return true;
  if ([...doc.querySelectorAll("dialog")].some(dialog => (dialog as HTMLDialogElement).open)) return true;
  if (doc.querySelector("#addFeature button.pressed")) return true;
  const options = doc.getElementById("options");
  return !!options && shown(options);
}

function createStyles(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = /* css */ `
    #renderModeIndicator {
      position: fixed; left: 11px; bottom: 11px; z-index: 3; /* bottom-left: clear of the menu, dialogs and tip bar */
      display: inline-flex; align-items: center; gap: 0.45em;
      padding: 0.35em 0.7em; border: 1px solid var(--dark-solid, #5e4fa2); border-radius: 3px;
      background: var(--bg-main, #ccc8); color: #111;
      font: bold 12px/1.2 var(--sans-serif, Helvetica, Arial, sans-serif);
      cursor: pointer; user-select: none; transition: background-color 0.2s;
    }
    #renderModeIndicator > * { pointer-events: none; } /* FMG's showDataTip reads data-shortcut off the target */
    #renderModeIndicator:hover { background: var(--header-active, #5e4fa2); color: white; }
    #renderModeIndicator:focus-visible { outline: 2px solid var(--header-active, #5e4fa2); outline-offset: 2px; }
    #renderModeIndicator .mode-dot { width: 0.65em; height: 0.65em; border-radius: 50%; background: #2e8b57; }
    #renderModeIndicator[data-mode="edit"] .mode-dot { background: #c2410c; border-radius: 1px; }
    #renderModeIndicator[data-mode="preparing"] .mode-dot {
      background: transparent; border: 2px solid #8a7d0b; border-top-color: transparent;
      width: 0.5em; height: 0.5em; animation: renderModeSpin 0.9s linear infinite;
    }
    #renderModeIndicator[data-mode="unavailable"] .mode-dot { background: #777; }
    #renderModeIndicator kbd {
      font: 11px var(--monospace, Consolas, monospace); padding: 0 0.3em;
      border: 1px solid currentColor; border-radius: 2px; opacity: 0.6;
    }
    @keyframes renderModeSpin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { #renderModeIndicator[data-mode="preparing"] .mode-dot { animation: none; } }
    @media print { #renderModeIndicator { display: none; } }
  `;
  document.head.append(style);
  return style;
}

export function installRenderMode(host: Host): RenderModeApi {
  if (installed) return installed;
  let intent: Intent = "navigate";
  let applied: IntentRenderer | null = null; // the renderer instance that has the current intent
  let appliedIntent: Intent | null = null;
  let display: ModeDisplay | null = null;
  let lastChange: { intent: Intent; via: ChangeSource; at: number } | null = null;
  const consumed = new Set<string>();
  const styles = createStyles();
  const button = document.createElement("button");
  button.type = "button";
  button.id = "renderModeIndicator";
  button.setAttribute("aria-live", "polite");
  button.setAttribute("aria-keyshortcuts", MODE_KEY_LABEL);
  button.dataset.shortcut = MODE_KEY_LABEL;
  button.innerHTML = `<span class="mode-dot" aria-hidden="true"></span><span class="mode-label"></span><kbd aria-hidden="true">${MODE_KEY_LABEL}</kbd>`;
  const label = button.querySelector<HTMLSpanElement>(".mode-label")!;
  document.body.append(button);

  function inputs(): IntentInputs {
    const renderer = host.renderer();
    if (!renderer) return { intent, editor: "", ready: false, available: host.gpuActive() };
    const probe = renderer.intentProbe();
    return {
      intent,
      editor: probe.editor,
      ready: probe.ready,
      current: probe.current ?? true,
      available: true,
      holdMs: probe.holdMs ?? 0,
      holdRevisions: probe.holdRevisions ?? 0
    };
  }

  // Pushes the intent to a renderer that lacks it: a change, or a renderer that appeared after the request.
  function apply(): void {
    const renderer = host.renderer();
    if (!renderer || (renderer === applied && appliedIntent === intent)) return;
    applied = renderer;
    appliedIntent = intent;
    renderer.setIntent(intent === "edit");
  }

  function update(): ModeDisplay {
    apply();
    const next = modeView(inputs());
    if (
      display &&
      display.mode === next.mode &&
      display.auto === next.auto &&
      display.label === next.label &&
      display.tip === next.tip
    )
      return next;
    display = next;
    button.dataset.mode = next.mode;
    button.dataset.auto = String(next.auto);
    button.dataset.tip = next.tip;
    button.title = `${next.tip}. Shortcut: ${MODE_KEY_LABEL}`;
    label.textContent = next.mode === "edit" && next.auto ? "Edit · editor" : next.label;
    button.setAttribute("aria-label", `Map mode: ${label.textContent}. ${next.tip}`);
    return next;
  }

  function set(target: Intent, via: ChangeSource = "api"): ModeDisplay {
    const outcome = requestMode(target, inputs());
    intent = outcome.intent;
    lastChange = { intent, via, at: Math.round(performance.now()) };
    if (outcome.notice) host.notice(outcome.notice);
    return update();
  }

  function toggle(via: ChangeSource = "api"): ModeDisplay {
    const current = inputs();
    if (!current.available) {
      host.notice("GPU rendering is off; the map is already editable");
      return update();
    }
    return set(toggleTarget(current), via);
  }

  function keydown(event: KeyboardEvent): void {
    if (!maybeModeKey(event)) return; // every other keystroke (typing included) costs one comparison, no probe
    const action = keyAction(event, {
      editable: editableTarget(event),
      selection: !!window.getSelection()?.toString(),
      blocking: event.key === "Escape" && escapeBlocked(),
      inputs: inputs()
    });
    if (!action) return;
    if (action === "toggle") {
      // \ is unbound in FMG; its keyup is swallowed anyway so a later binding cannot double-fire
      event.preventDefault();
      event.stopImmediatePropagation();
      consumed.add(event.code || event.key);
      toggle("key");
    } else set("navigate", "esc"); // Esc keyup still reaches FMG, which then has nothing to close
  }

  function keyup(event: KeyboardEvent): void {
    const code = event.code || event.key;
    if (!consumed.delete(code)) return;
    event.stopImmediatePropagation();
  }

  const click = (event: MouseEvent) => {
    event.stopPropagation();
    toggle("click");
  };
  const hover = (event: MouseEvent) => {
    const show = (window as { showDataTip?: (event: MouseEvent) => void }).showDataTip;
    if (typeof show === "function") show(event);
  };
  const blur = () => consumed.clear();
  button.addEventListener("click", click);
  button.addEventListener("mousemove", hover);
  window.addEventListener("keydown", keydown, true);
  window.addEventListener("keyup", keyup, true);
  window.addEventListener("blur", blur);
  const timer = window.setInterval(update, POLL_MS);
  update();

  installed = {
    state: () => ({ ...update(), intent, lastChange }),
    set,
    toggle: () => toggle(),
    dispose() {
      window.clearInterval(timer);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup, true);
      window.removeEventListener("blur", blur);
      button.remove();
      styles.remove();
      const renderer = host.renderer();
      if (renderer && intent === "edit") renderer.setIntent(false);
      installed = null;
      if (window.renderMode === api) window.renderMode = undefined;
    }
  };
  const api = installed;
  window.renderMode = api;
  return api;
}

// The live page: window.gpuRenderer appears when the lazy GPU module has loaded, and goes away on a fallback.
export function installForPage(): RenderModeApi {
  return installRenderMode({
    renderer: () => (window as { gpuRenderer?: IntentRenderer | null }).gpuRenderer ?? null,
    gpuActive: () => {
      const status = (window as { rendererStatus?: () => { active: string } }).rendererStatus;
      return typeof status === "function" ? status().active === "gpu" : true;
    },
    notice: text => {
      const tip = (window as { tip?: (text: string, main: boolean, type: string, time: number) => void }).tip;
      if (typeof tip === "function") tip(text, false, "warn", 2500);
    }
  });
}

declare global {
  interface Window {
    renderMode?: RenderModeApi;
  }
}
