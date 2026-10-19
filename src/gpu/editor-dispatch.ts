// Canonical SVG click recovery for ?renderer=gpu; GPU selection is separately opt-in with &gpu-select.
// public/modules/ui/editors.js clicked() asks window.gpuClickRoute(d3.event) first:
//   null   -> legacy: clicked() dispatches the native event unchanged (the default for everything below)
//   false  -> dropped: the click is swallowed after the canonical camera is synced (fail-closed)
//   {event} -> dispatched once through d3.customEvent with a canonical target from SVG recovery or ready GPU selection
// The native target is canonical whenever the SVG camera matches the GPU camera, so then the GPU selection only runs
// in shadow when enabled (agreement telemetry) and never changes dispatch. During motion the GPU hook skips the SVG
// transform write (renderer.camera), so the browser hit-tests a stale view: there, a selection of a READY kind whose
// target passes clicked()'s own branch test is routed (after syncing the canonical camera, so the editor reads a
// current SVG); anything else (unready kind, unavailable index, canvas fallbacks, unresolved target) syncs the
// camera and takes the legacy path at the current camera: the SVG hit test re-run after the sync (never the element
// under the stale view). A re-run hit outside #viewbox (which clicked() would not have received) drops the click.
// A stale-view hit on the bare #map background never reaches clicked() (its listener is on #viewbox): recoverClick
// syncs the camera and re-dispatches the click once to the SVG's re-run hit if that lies inside #viewbox.
// Other hits outside #viewbox (legend, rulers) are not camera-transformed, so they stay where the browser sent them.
import type { GpuSelection, SelectionKind } from "./selection";

// clicked()'s branches in its own order (editors.js). "fallback": no element branch, the pickBurg/pickRelief leg;
// "ignored": the target is less than four levels deep and clicked() returns at once.
export type ClickBranch =
  | "emblems"
  | "rivers"
  | "routes"
  | "labels"
  | "burgLabels"
  | "burgIcons"
  | "ice"
  | "terrain"
  | "markers"
  | "markets"
  | "goodsIcons"
  | "goodsCells"
  | "goodsBurgs"
  | "coastline"
  | "lakes"
  | "armies"
  | "fallback"
  | "ignored";

// Replica of clicked()'s fixed-depth tests; kept in step with editors.js (editor-dispatch.test.ts pins the order).
export function clickedBranch(el: Element | null): ClickBranch {
  const parent = el?.parentElement;
  const grand = parent?.parentElement;
  const great = grand?.parentElement;
  const ancestor = great?.parentElement;
  if (!el || !parent || !grand || !great || !ancestor) return "ignored";
  if (grand.id === "emblems") return "emblems";
  if (parent.id === "rivers") return "rivers";
  if (grand.id === "routes") return "routes";
  if (ancestor.id === "labels" && el.tagName === "tspan") return "labels";
  if (grand.id === "burgLabels") return "burgLabels";
  if (grand.id === "burgIcons") return "burgIcons";
  if (parent.id === "ice") return "ice";
  if (parent.id === "terrain") return "terrain";
  if (grand.id === "markers" || great.id === "markers") return "markers";
  if (grand.id === "markets" && el.tagName !== "path") return "markets";
  if (grand.id === "goodsIcons") return "goodsIcons";
  if (parent.id === "goodsCells") return "goodsCells";
  if (grand.id === "goodsBurgs") return "goodsBurgs";
  if (grand.id === "coastline") return "coastline";
  if (grand.id === "lakes") return "lakes";
  if (great.id === "armies") return "armies";
  return "fallback";
}

// What the editor a branch opens actually reads from d3.event.target: the label editor climbs tspan -> textPath -> text,
// the marker editor takes closest("svg"); every other branch reads the element itself.
function subject(el: Element, branch: ClickBranch): Element | null {
  if (branch === "labels") return el.closest("text");
  if (branch === "markers") return el.closest("svg");
  return el;
}

// The element clicked() must receive for the selection: a label's index element is its <text>, but clicked() opens the
// label editor only for a tspan four levels below #labels; every other kind dispatches its resolved target as is.
// null when there is no element target (canvas fallbacks, uncommitted relief, unresolved leaf).
export function dispatchTarget(selection: GpuSelection): Element | null {
  const target = selection.target;
  if (!target?.isConnected) return null;
  if (selection.kind === "label") return target.closest("text")?.querySelector(":scope > textPath > tspan") ?? null;
  return target;
}

// Kinds whose GPU selection matched the SVG oracle on every eligible sample of the final picking matrix
// (COMPLETION-RUN-2026-10-16.md): marker passed the gate (>=50 samples, >=99.5%) in all 8 100k-world cells
// (DPR 1/2 x zoom 2/4 x compact/materialized relief) with zero mismatches in every cell, and the stale-camera marker cohort of bench/renderer-integration.ts.
// Shared-world cells have under 50 markers each (disclosed). Burg fails the gate, label lacks 50 samples in most cells, routes are ungated.
export const READY_KINDS: ReadonlySet<SelectionKind> = new Set<SelectionKind>(["marker"]);

export interface ClickCounts {
  routed: number; // stale camera, dispatched with the GPU target
  resynced: number; // stale camera, not routed: camera synced, dispatched with the SVG's re-run hit target
  dropped: number; // stale camera, not routed and the re-run SVG hit is outside #viewbox: click swallowed
  legacy: number; // current camera: native dispatch
  agree: number; // shadow: GPU dispatch target denotes the same editor subject as the native target
  disagree: number;
  unavailable: number; // index could not answer (never treated as an empty hit)
  errors: number; // a dependency threw while handling this kind (counted, never silent)
}

// Why a click was swallowed: the re-run SVG hit lies outside #viewbox (clicked() would never have received it), or a
// dependency threw on a stale view (fail-closed: the stale native target is not used).
export type DropReason = "outside-viewbox" | "error";

export interface ClickTelemetry {
  byKind: Record<string, ClickCounts>; // "error" holds clicks whose GPU selection threw
  recovered: number; // stale-view background clicks re-dispatched into #viewbox (recoverClick)
  unrecovered: number; // stale-view background clicks whose re-run hit is still outside #viewbox (a drop)
  dropReasons: Record<DropReason, number>; // every swallowed click, by reason (routeClick and recoverClick)
  errors: number; // all dependency throws, across routeClick and recoverClick
  disagreements: { kind: string; native: string; gpu: string }[]; // first few, for diagnosis
  unavailableReasons: string[]; // first few pickStatus reasons behind an unavailable selection, for diagnosis
  lastMs: number;
}

export interface ClickRouteDeps {
  select: ((x: number, y: number) => GpuSelection) | null; // null: canonical SVG recovery without GPU selection
  origin(): [number, number]; // #map client offset
  stale(): boolean; // renderer.canonicalCameraStale()
  sync(): void; // renderer.syncCanonicalCamera()
  // The legacy (SVG) hit test at client px after sync: the topmost element if it lies inside #viewbox, else null.
  // The SVG side only; the GPU selection above never consults it.
  resolve(clientX: number, clientY: number): Element | null;
  ready: ReadonlySet<SelectionKind>;
}

// The fields d3 handlers and jQuery UI position({of: event}) read, with the target replaced. Default actions and
// propagation still act on the native event.
export interface RoutedEvent {
  type: string;
  target: Element;
  currentTarget: EventTarget | null;
  clientX: number;
  clientY: number;
  pageX: number;
  pageY: number;
  screenX: number;
  screenY: number;
  button: number;
  buttons: number;
  detail: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  native: MouseEvent;
  preventDefault(): void;
  stopPropagation(): void;
}

export function routedEvent(event: MouseEvent, target: Element): RoutedEvent {
  return {
    type: event.type,
    target,
    currentTarget: event.currentTarget,
    clientX: event.clientX,
    clientY: event.clientY,
    pageX: event.pageX,
    pageY: event.pageY,
    screenX: event.screenX,
    screenY: event.screenY,
    button: event.button,
    buttons: event.buttons,
    detail: event.detail,
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    native: event,
    preventDefault: () => event.preventDefault(),
    stopPropagation: () => event.stopPropagation()
  };
}

export function createTelemetry(): ClickTelemetry {
  return {
    byKind: {},
    recovered: 0,
    unrecovered: 0,
    dropReasons: { "outside-viewbox": 0, error: 0 },
    errors: 0,
    disagreements: [],
    unavailableReasons: [],
    lastMs: 0
  };
}

const emptyCounts = (): ClickCounts => ({
  routed: 0,
  resynced: 0,
  dropped: 0,
  legacy: 0,
  agree: 0,
  disagree: 0,
  unavailable: 0,
  errors: 0
});

export interface RecoverDeps {
  stale(): boolean;
  sync(): void;
  background(el: EventTarget | null): boolean; // the bare #map element (nothing of #viewbox under the stale view)
  resolve(clientX: number, clientY: number): Element | null; // as ClickRouteDeps.resolve
}

// Capture-phase #map click listener: the element to re-dispatch the click to (the caller stops the native event and
// dispatches once; clicked() then sees a current camera and takes the legacy path), or null to leave the click alone.
export function recoverClick(deps: RecoverDeps, event: MouseEvent, telemetry: ClickTelemetry): Element | null {
  try {
    if (!deps.background(event.target) || !deps.stale()) return null;
    deps.sync();
    const canonical = deps.resolve(event.clientX, event.clientY);
    if (canonical) telemetry.recovered++;
    else {
      // the click stays on the bare #map, which clicked() never receives: a drop, reason outside-viewbox
      telemetry.unrecovered++;
      telemetry.dropReasons["outside-viewbox"]++;
    }
    return canonical;
  } catch {
    // nothing is re-dispatched: the native click stays on #map (a background target, never a clicked() branch)
    telemetry.errors++;
    return null;
  }
}

const describe = (el: Element | null) => (el ? `${el.tagName}#${el.id}` : "null");

// Outcomes (each increments exactly one per-kind counter, and a drop also a dropReasons entry):
//   current camera                      -> legacy (null: native event; GPU selection shadow-compared)
//   stale, selection routable and ready -> routed (sync, then GPU target)
//   stale, anything else (including select:null) -> sync, then resynced (SVG re-run hit inside #viewbox) or dropped/outside-viewbox
//   stale, a dependency threw           -> dropped/error (fail-closed; the stale native target is never dispatched)
//   current camera, a dependency threw  -> legacy (null) with errors++ (the native event is canonical)
// A selection that threw is treated as unready: it still syncs and takes the resynced/dropped path, under key "error".
export function routeClick(deps: ClickRouteDeps, event: MouseEvent, telemetry: ClickTelemetry): RoutedEvent | false | null {
  const start = performance.now();
  let key = "error";
  let stale: boolean | null = null;
  const counts = (): ClickCounts => (telemetry.byKind[key] ??= emptyCounts());
  const drop = (reason: DropReason): false => {
    counts().dropped++;
    telemetry.dropReasons[reason]++;
    return false;
  };
  try {
    stale = deps.stale();
    const [ox, oy] = deps.select ? deps.origin() : [0, 0];
    let selection: GpuSelection | null = null;
    try {
      if (deps.select) selection = deps.select(event.clientX - ox, event.clientY - oy);
      else key = "canonical";
    } catch {
      telemetry.errors++;
      counts().errors++;
    }
    const unavailable = selection?.branch === "unavailable";
    if (selection) key = unavailable ? "unavailable" : selection.kind;
    if (unavailable) {
      counts().unavailable++;
      if (telemetry.unavailableReasons.length < 20) telemetry.unavailableReasons.push(selection?.unavailable ?? "");
    }
    const target = selection ? dispatchTarget(selection) : null;
    const branch = target ? clickedBranch(target) : null;
    const routable = !!selection && !!target && branch === selection.branch && selection.via === "index";
    // shadow comparison against the canonical target (native, or re-resolved after a camera sync)
    const compare = (canonical: Element | null) => {
      if (!selection || unavailable) return;
      const nativeBranch = clickedBranch(canonical);
      const same = routable
        ? nativeBranch === branch && subject(canonical!, nativeBranch) === subject(target!, branch!)
        : !target && (nativeBranch === "fallback" || nativeBranch === "ignored");
      if (same) counts().agree++;
      else {
        counts().disagree++;
        if (telemetry.disagreements.length < 20)
          telemetry.disagreements.push({ kind: key, native: describe(canonical), gpu: describe(target) });
      }
    };
    if (!stale) {
      const native = event.target as Element | null;
      compare(typeof native?.closest === "function" ? native : null);
      counts().legacy++;
      return null;
    }
    deps.sync();
    if (selection && routable && deps.ready.has(selection.kind)) {
      counts().routed++;
      return routedEvent(event, target!);
    }
    // legacy path at the current camera: the SVG's own hit test, re-run once the canonical transform is written
    const canonical = deps.resolve(event.clientX, event.clientY);
    compare(canonical);
    if (canonical) {
      counts().resynced++;
      return routedEvent(event, canonical);
    }
    return drop("outside-viewbox");
  } catch {
    telemetry.errors++;
    counts().errors++;
    // current camera: the native event is canonical, so it is left to clicked()
    if (stale === false) return null;
    // stale view (or unknown camera state): the native target is stale, so the click is swallowed and counted
    return drop("error");
  } finally {
    telemetry.lastMs = performance.now() - start;
  }
}
