// P1 GPU backend (loaded lazily behind ?renderer=gpu). A WebGL2 canvas sits directly above <svg id="map"> with
// pointer-events:none; the SVG stays underneath as the d3.zoom gesture owner and the canonical, exportable document.
// During motion the camera only changes uniforms; exact (settled) updates still write the canonical SVG, after which
// the frame is re-prepared from it. Whenever the GPU cannot show a correct frame the canvas is hidden, never blank.
// Between inexact and exact updates, hover still sees the previous SVG transform. Clicks synchronize and re-hit-test
// the canonical SVG before editor dispatch. GPU selection remains separately opt-in via ?gpu-select. An open editor
// suspends the GPU, and hide() writes the GPU camera before revealing the canonical SVG.
import { canvasAntialias, DETAIL_RESERVE, GPU_BUDGET, windowAllowance } from "./budget";
import { type Camera, parseViewboxTransform, screenToWorld, type Viewport } from "./camera";
import { forgetCompatClone, type Region } from "./compat";
import { compatDirt, watchCompatInputs } from "./compat-reuse";
import { type DefinitionStats, DefinitionWatch } from "./definitions";
import { GpuDevice } from "./device";
import {
  type ClickTelemetry,
  createTelemetry,
  READY_KINDS,
  type RoutedEvent,
  recoverClick,
  routeClick
} from "./editor-dispatch";
import { HiddenEmblemCulling } from "./emblem-culling";
import { FrameGraph } from "./framegraph";
import { GpuFrameTimer, type TimingTelemetry, timingRequested } from "./gpu-timer";
import {
  customizationMode,
  editorState,
  type FilterSource,
  hiddenReason,
  IDLE_WATCH_MS,
  rootFilter
} from "./lifecycle";
import { classify, pixelRecords, TRADE_LAYER, TradeMarkers } from "./markers";
import { describeMutation, MOTION_IDLE, prepareStale, prepareStart, settleAction } from "./motion";
import { NetChange } from "./net-change";
import { type PickHit, resolveLeaf } from "./pick";
import {
  BudgetError,
  type CompatReuse,
  compatReuseEnabled,
  hasDetail,
  type Prepared,
  prepareFrame,
  type RetainedFrame,
  refineCompat,
  refineRequest,
  refineView,
  refreshOverlays as refreshOverlayBatches,
  releaseDetail,
  retainFrame
} from "./prepare";
import { scaleBucket } from "./raster";
import { glyphTarget } from "./relief-pick";
import { RestoreClock, type RestoreTiming } from "./restore-phases";
import type { Rgba } from "./scene";
import { SceneCache } from "./scene-cache";
import { type GlyphInfo, type GpuSelection, type ReliefCandidate, selectAt } from "./selection";
import { GlyphAtlas } from "./text";

export interface CameraUpdate {
  scale: number;
  x: number;
  y: number;
  exact?: boolean;
}

export interface GpuTelemetry {
  state: "waiting" | "preparing" | "active" | "suspended" | "lost";
  world: number;
  revision: number;
  frameRevision: number | null; // the DOM revision of the prepared frame (null: none); < revision means it is behind
  prepares: number;
  lastPrepareMs: number | null;
  frames: number;
  lastFrameMs: number | null;
  contextLosses: number;
  lastRestoreMs: number | null; // loss -> first restored frame; the 500 ms target is not yet measured on hosts
  restore: RestoreTiming | null; // the latest recovery split into phases (restore-phases.ts); null before any loss
  pending: boolean;
  refinementPending: boolean;
  moving: boolean;
  // static DOM revisions (full re-prepare) and the last record that caused one; prepares deferred or aborted by motion
  invalidations: { count: number; last: string };
  motionDeferrals: number;
  suspendDeferrals: number; // prepares deferred or aborted because an open editor suspended a renderer with a frame
  // records classify() skipped as pixel-neutral viewport decoration (culling, hatch scale, dense-zoom overlays)
  neutralMutations: number;
  // full prepares begun / swapped in while `moving` was true (a frame-less renderer may start mid-gesture)
  preparesWhileMoving: { starts: number; commits: number };
  // the most recent prepare that started: why it was scheduled, whether a frame existed, motion at start, outcome
  // phases: ms since the job started at each prepareFrame checkpoint (scene, clone, screen, windows, world, buffers)
  lastPrepare: {
    reason: PrepareReason;
    hadFrame: boolean;
    moving: boolean;
    outcome: PrepareOutcome;
    phases: Record<string, number>;
    reuse?: CompatReuse; // compat runs that reused the previous frame's rasters, and why the others did not
  } | null;
  // re-prepares that exceeded the caps only beside the previous frame: it was released (SVG shown) and the frame
  // rebuilt alone ("swap" prepare). A lone frame that still does not fit falls back to SVG.
  swapDrops: number;
  // tracked allocation estimate (uploads × mip/MSAA factors), not measured GPU usage; peak includes frame swaps
  memory: {
    basis: "tracked-allocations";
    gpu: ReturnType<GpuDevice["memory"]>;
    peak: number;
    preparePeak: number | null; // latest prepare's own high-water (set in its finally), null before the first prepare
    budget: number;
    cpu: number;
  };
  layers: Prepared["layers"];
  compat: Prepared["compat"] | null;
  suspendedReason: string;
  // resume hold (D13): the canvas stays hidden after a suspension that changed the model until the frame is current.
  // active: held now (heldMs so far, revisions that arrived since it began); holds: holds begun; skipped: suspensions
  // that ended with no revision (the last frame came back at once); lastMs: duration of the last finished hold;
  // netUnchanged: suspensions with revisions whose net DOM change was nil (no hold either), netUnsure: ones the net
  // test could not judge (the revision rule held); net: the last verdict and what decided it
  hold: {
    active: boolean;
    heldMs: number | null;
    revisions: number;
    holds: number;
    skipped: number;
    lastMs: number | null;
    netUnchanged: number;
    netUnsure: number;
    net: { verdict: string; detail: string } | null;
  };
  definitions: DefinitionStats; // svg#defElements batches that re-prepared (referenced by the map) or were ignored
  dialogScans: number; // editor dialog scans (editorReason recomputes after a document mutation only)
  pickProfile: { queries: number; statusMs: number; indexMs: number };
  // state "active" means a frame is prepared and drawable; canvasVisible is whether the GPU canvas is on screen now
  canvasVisible: boolean;
  sourceCurrent: boolean;
  // why the canvas is hidden now ("" = it may show; lifecycle.ts hiddenReason), from the cached editor state
  hiddenReason: string;
  // the root #map filter forwarded as the canvas CSS filter ("" none), or why the GPU frame refuses it
  rootFilter: { css: string; refused: string };
  drawBatches: { submitted: number; culled: number };
  stateCalls: { issued: number; skipped: number }; // last frame's cached GL state setters (gl-state.ts)
  // last frame's full-viewport composites / stencil clears / group mask fills drawn and culled off-view
  passes: { composites: number; stencilClears: number; maskFills: number; maskCulled: number };
  timing: TimingTelemetry | null; // opt-in diagnostics only (gpu-timer.ts); null in ordinary runs
  tessellation: Prepared["tessellation"] | null;
  markers: number; // trade markers mirrored into the last frame
  // canonical bitmap viewport crops: "missing" = the view is outside the committed window, SVG shown meanwhile
  windows: {
    coverage: "none" | "covered" | "missing";
    bytes: number;
    margin: number;
    refreshes: number;
    misses: number;
    detailReleases: number; // refreshes that freed compat detail to fit the canonical crops
  };
  // screen-overlay lane (e.g. #scaleBar redraws): committed in-place batch refreshes, refreshes handed to a full
  // prepare (new/hidden/unsupported overlay or over budget), superseded jobs, pending roots and the last job's outcome
  overlays: { refreshes: number; fulls: number; stale: number; pending: number; lastMs: number | null; last: string };
  // bounded recent-work trace (performance.now() ms) to attribute main-thread stalls: background jobs with their
  // reason/outcome, static revisions with their record, and browser long tasks (>50 ms) when the API exists
  trace: { now: number; jobs: TraceEntry[]; longTasks: { at: number; ms: number }[] };
}

export interface TraceEntry {
  kind: "prepare" | "overlay" | "window" | "refine" | "revision";
  at: number;
  ms: number | null; // null while running, or for an instantaneous event
  detail: string;
}
const TRACE_LIMIT = 24;

export type PrepareReason =
  | "initial"
  | "world"
  | "revision"
  | "settle-wanted"
  | "settle-revision"
  | "settle-bucket"
  | "behind"
  | "resize"
  | "restore"
  | "swap"
  | "resume";
type PrepareOutcome = "running" | "committed" | "stale" | "failed" | "swap-dropped";

interface Globals {
  graphWidth?: number;
  graphHeight?: number;
  gpuRenderer?: GpuRenderer | null;
  gpuPick?: ((x: number, y: number, tolerance?: number) => PickHit | null) | null;
  gpuSelect?: ((x: number, y: number, tolerance?: number) => GpuSelection) | null;
  pickBurg?: (x: number, y: number) => number | undefined;
  pickRelief?: (x: number, y: number) => Element | null;
  peekRelief?: (x: number, y: number) => ReliefCandidate | null;
  gpuClickRoute?: ((event: MouseEvent) => RoutedEvent | false | null) | null;
  gpuClickTelemetry?: ClickTelemetry | null;
}
const page = globalThis as unknown as Globals;
const PREPARE_DELAY = 120;
const SETTLE_DELAY = 100;
// Refresh bitmap crops in the background once the view comes this close (CSS px) to the committed window edge,
// capped at half the margin it was captured with, so motion normally never reaches an uncovered view.
const WINDOW_EDGE = 240;

function clearColor(svg: Element): Rgba {
  for (let node: Element | null = svg; node; node = node.parentElement) {
    const match = getComputedStyle(node)
      .backgroundColor.match(/[\d.]+/g)
      ?.map(Number);
    if (match && (match[3] ?? 1) > 0) return [match[0] / 255, match[1] / 255, match[2] / 255, match[3] ?? 1];
  }
  return [1, 1, 1, 1];
}

export class GpuRenderer {
  readonly canvas = document.createElement("canvas");
  private device: GpuDevice;
  private graph: FrameGraph;
  private atlas = new GlyphAtlas();
  private prepared: Prepared | null = null;
  private view: Camera;
  private viewport: Viewport = { width: 1, height: 1, dpr: 1 };
  private clear: Rgba = [1, 1, 1, 1];
  private generation = 0;
  private refines = 0;
  private revision = 0;
  private world = 0;
  private worldEpoch = 0; // bumped with the world (worldReplaced, dispose); keys the CPU scene cache
  private readonly scenes = new SceneCache(); // one CPU scene reused by context-restore prepares (scene-cache.ts)
  private retained: RetainedFrame | null = null; // CPU payload of the frame a context loss destroyed (PERF B1)
  private preparing = false;
  private moving = false;
  private prepareWanted = false; // deferred or aborted by motion; the next settle prepares
  private suspendWanted = false; // deferred or aborted by an open editor; resume() prepares once it closes
  private suspendedReason = "";
  private raf = 0;
  private prepareTimer = 0;
  private settleTimer = 0;
  private motionTimer = 0;
  private invalidations = { count: 0, last: "" };
  private motionDeferrals = 0;
  private suspendDeferrals = 0;
  private neutralMutations = 0;
  private preparesWhileMoving = { starts: 0, commits: 0 };
  private prepareReason: PrepareReason = "initial"; // reason of the scheduled (not yet started) prepare
  private lastPrepare: GpuTelemetry["lastPrepare"] = null;
  private swapDrops = 0;
  private activeRefinements = 0;
  private windowTimer = 0;
  private windowJob = false;
  private windowMiss = ""; // camera key whose crop could not fit: no retry until the view changes
  private edgeMiss = ""; // same, for a proactive edge refresh while the view was still covered
  private windowStats = { refreshes: 0, misses: 0, detailReleases: 0 };
  private pendingOverlays = new Set<Element>(); // changed screen-overlay roots not yet refreshed in the frame
  private overlayTimer = 0;
  private overlayJob = false;
  private overlayStats = { refreshes: 0, fulls: 0, stale: 0, lastMs: null as number | null, last: "" };
  private jobs: TraceEntry[] = [];
  private longTasks: { at: number; ms: number }[] = [];
  private longTaskObserver: PerformanceObserver | null = null;
  private lostAt = 0;
  private timer: GpuFrameTimer | null = null; // only when the gpu-timing bench requests it
  private stats = { prepares: 0, lastPrepareMs: null as number | null, frames: 0, lastFrameMs: null as number | null };
  private losses = { count: 0, lastRestoreMs: null as number | null };
  // high-water of tracked bytes: lifetime (folded in at each prepare start) and the latest prepare's own peak
  private peaks = { lifetime: 0, lastPrepare: null as number | null };
  private recovery = new RestoreClock(() => performance.now());
  private mutations: MutationObserver;
  // LIFE3: svg#defElements (COAs, icon symbols, patterns) outside svg#map; a change the map references re-prepares
  private definitions: DefinitionWatch;
  private stopCompatWatch: () => void = () => {};
  // compat raster reuse (prepare.ts compatReuseEnabled, on by default; ?gpu-compat-reuse=0 opts out): only then are the reuse tracker fed and the
  // document-wide outside-input watcher installed, and previous details carried; off, prepare and refine release
  // details as before. Fixed per page load (URL flag or build env).
  private readonly compatReuse = compatReuseEnabled();
  // editor dialog visibility (editorReason): dirty on any document mutation that could change it
  // While suspended, a closing dialog is the only change that can resume an otherwise idle renderer (no camera, prepare
  // or draw follows it): re-check on the next frame. draw() hides again (a no-op) if the editor is still open.
  // Likewise an opening dialog: nothing else may follow it, and without a draw the last GPU frame would stay on screen
  // over the SVG the editor changes (editor replay, bench/host/editor-replay.ts).
  // A replaced #map (a load in progress, or one that failed before map:loaded) hides the previous world at once.
  // A dialog wrapper's own change is also where a suspension starts (D13): seen here, before the map records of the
  // same task are classified (mutated() drains this observer first), so an editor that edits as it opens counts the
  // edit as made inside it.
  private dialogs = new MutationObserver(records => this.dialogsChanged(records));
  private dialogsChanged(records: MutationRecord[]): void {
    this.dialogsDirty = true;
    if (!this.sourceCurrent()) return void this.active();
    const touched = records.some(touchesDialog);
    if (touched && this.suspendedFrom === null) this.editorReason();
    this.resume();
    if (this.suspendedReason || touched) this.requestDraw();
  }
  private dialogsDirty = true;
  private dialogShown = false;
  private dialogScans = 0;
  // summed per-query cost split (coarse performance.now; meaningful over many queries): availability vs index
  private pickProfile = { queries: 0, statusMs: 0, indexMs: 0 };
  private emblemCulling: HiddenEmblemCulling | null = null;
  private markers: TradeMarkers;
  private resizes: ResizeObserver;
  private onWindowResize = () => this.resize();
  // --- LIFE: lifecycle hooks (lifecycle.ts decides; these feed it) ---
  private printing = false; // beforeprint..afterprint: the canonical SVG is printed, the canvas stays hidden
  private rootFilterState = { css: "", refused: "" };
  private customizationSeen: unknown = undefined;
  private idleWatch = 0;
  // Customization modes set a bare global no event announces: poll it so entering one hides the canvas (and leaving it
  // resumes) without waiting for the next camera, mutation or draw.
  private watchIdle = () => {
    const mode = customizationMode();
    if (mode === this.customizationSeen) return;
    this.customizationSeen = mode;
    this.active();
    this.requestDraw();
  };
  // A face that a committed or in-flight layout measured without (fontReady reason: slow, failed, unavailable) has
  // arrived: those labels took the compat lane, so re-prepare. Loads the layout itself awaited never re-prepare.
  private onFontsLoaded = () => {
    if (!this.atlas.fontsArrived()) return;
    compatDirt.all("font loaded");
    this.invalidations.last = "font loaded";
    this.traceJob("revision", "font loaded")();
    this.invalidate(false);
  };
  // Print renders the canonical SVG (index.css hides canvases): it must hold the GPU camera and every emblem.
  private onBeforePrint = () => {
    this.printing = true;
    this.syncSvgCamera();
    this.hide();
  };
  private onAfterPrint = () => {
    this.printing = false;
    this.requestDraw();
  };
  // --- end LIFE ---

  constructor(
    private svg: SVGSVGElement,
    private fallBack: (reason: string) => void,
    private readonly pickingEnabled = true
  ) {
    const style = this.canvas.style;
    Object.assign(style, { position: "fixed", pointerEvents: "none", display: "none" });
    this.canvas.dataset.gpuRenderer = "";
    svg.after(this.canvas);
    // observers and listeners are attached only after the device and programs exist, so a failure here leaves nothing
    try {
      this.device = new GpuDevice(
        this.canvas,
        { lost: () => this.lost(), restored: () => this.restored() },
        { antialias: canvasAntialias(globalThis.devicePixelRatio || 1) }
      );
    } catch (error) {
      this.canvas.remove();
      throw error;
    }
    try {
      this.graph = new FrameGraph(this.device);
    } catch (error) {
      this.device.dispose();
      this.canvas.remove();
      throw error;
    }
    if (timingRequested()) this.timer = new GpuFrameTimer(this.device.gl);
    this.markers = new TradeMarkers(
      this.device,
      () => this.requestDraw(),
      reason => this.fallBack(reason)
    );
    this.view = parseViewboxTransform(svg.querySelector("#viewbox")?.getAttribute("transform") ?? null);
    // GPU code writes only the #viewbox transform to the live SVG (syncSvgCamera), so classify() ignores it to avoid
    // self-triggering. Live trade-marker ticks/adds/removes only redraw (instances are re-read per frame); changes inside
    // a screen overlay (e.g. #scaleBar redraws) refresh only that overlay's batch; any other record is a static
    // revision and re-prepares.
    this.mutations = new MutationObserver(records => this.mutated(records));
    this.mutations.observe(svg, MAP_OBSERVED);
    // created after `mutations`, so a task that both names a definition from the map and adds it is classified in
    // that order (the reference is seen before the definition is judged)
    this.definitions = new DefinitionWatch(
      () => this.svg,
      reason => this.definitionChanged(reason)
    );
    this.dialogs.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden"]
    });
    this.emblemCulling = new HiddenEmblemCulling(() => this.svg, this.canvas);
    this.observeLongTasks();
    if (this.compatReuse) this.stopCompatWatch = watchCompatInputs();
    this.resizes = new ResizeObserver(() => this.resize());
    this.resizes.observe(svg);
    window.addEventListener("resize", this.onWindowResize);
    window.addEventListener("beforeprint", this.onBeforePrint);
    window.addEventListener("afterprint", this.onAfterPrint);
    document.fonts?.addEventListener("loadingdone", this.onFontsLoaded);
    this.customizationSeen = customizationMode();
    this.idleWatch = window.setInterval(this.watchIdle, IDLE_WATCH_MS);
    this.applyRootFilter();
    this.resize();
    this.schedulePrepare(0, "initial");
  }

  // main.js camera hook. true = handled by uniforms (SVG transform write skipped). Exact updates return false so the
  // canonical transform is written, and the GPU follows in the same frame.
  // Motion is tracked even while the canvas is inactive, so a stale flag can neither block nor admit prepares.
  camera(update: CameraUpdate): boolean {
    this.view = { k: update.scale, x: update.x, y: update.y };
    if (update.exact) this.stopped();
    else this.motion();
    if (!this.active()) return false;
    // outside the bitmap window the SVG takes the camera (canvas hidden) until a background refresh covers it
    if (!this.covered()) return false;
    this.emblemCulling?.update(this.view, this.viewport, this.clear[3] === 1, this.moving);
    this.requestDraw();
    return !update.exact;
  }

  // main.js style/visible/details hooks: decoration is synced to the canonical SVG only on exact updates.
  defers(update: CameraUpdate): boolean {
    return this.active() && this.covered() && !update.exact;
  }

  // Why the prepared index cannot answer a pick now (null = it can; an empty hit is then a legitimate miss). Fail-closed
  // on: no prepared frame, a lost/disposed device, a replaced #map, a DOM revision the frame has not caught up with
  // (including same-task mutations still queued in the observer: drained here through the observer's own path, so a
  // stale target never routes), an editor suspension (the SVG is canonical) and a pending/in-flight overlay refresh.
  // The index is world-space vector data read through the current camera, so a cached unchanged frame stays valid
  // during camera motion and outside the bitmap windows (those only crop paint). Per query, never per frame.
  pickStatus(): string | null {
    if (!this.pickingEnabled) return "GPU selection disabled; canonical SVG targeting";
    const records = this.mutations.takeRecords();
    if (records.length) this.mutated(records);
    const prepared = this.prepared;
    if (this.device.disposed) return "disposed";
    if (this.device.lost) return "context lost";
    if (!prepared) return "not prepared";
    if (this.svg !== document.querySelector<SVGSVGElement>("#map")) return "source replaced";
    // an open editor first: opening it mutates the SVG, so the revision guard would otherwise mask the cause
    const suspended = this.editorReason();
    if (suspended) return `suspended: ${suspended}`;
    if (prepared.revision !== this.revision) return `stale revision ${prepared.revision} < ${this.revision}`;
    if (this.pendingOverlays.size || this.overlayJob) return "overlay refresh pending";
    return null;
  }

  pick(x: number, y: number, tolerance = 3): PickHit | null {
    const start = performance.now();
    const status = this.prepared ? this.pickStatus() : "not prepared";
    const checked = performance.now();
    const profile = this.pickProfile;
    profile.queries++;
    profile.statusMs += checked - start;
    if (!this.prepared || status !== null) return null;
    // a root overlay drawn above the world (e.g. #scaleBar) takes the hit, as it does in SVG
    const overlay = this.prepared.overlays.pick(x, y, tolerance);
    if (overlay) return overlay;
    const [wx, wy] = screenToWorld(this.view, x, y);
    // one CSS px in world units: the pointer square Chrome hit-tests text cells with (HitShape.square)
    const hit = this.prepared.pick.pick(wx, wy, tolerance / this.view.k, undefined, 1 / this.view.k);
    profile.indexMs += performance.now() - checked;
    return hit;
  }

  // The live #terrain <use> a pick instance names; null when the prepared frame is behind a DOM revision or the group
  // no longer matches what was indexed (glyphTarget). Read per call, never per frame.
  // A boxed instance of an unsupported href is never resolved: it stays terrain-unsupported.
  glyphAt(hit: PickHit): Element | null {
    const prepared = this.prepared;
    if (!prepared?.relief || hit.instance === undefined || prepared.revision !== this.revision) return null;
    const icon = prepared.relief.icons[hit.instance];
    if (!icon || prepared.relief.support.get(icon.i)?.reason !== null) return null;
    return glyphTarget(prepared.relief.group, prepared.relief.icons, hit.instance);
  }

  // The live anonymous leaf a depth > 0 hit names under its [id] ancestor (PickHit.path); null when the prepared frame
  // is behind a DOM revision or the path no longer leads to an anonymous element. selectAt re-checks the ancestry.
  leafAt(hit: PickHit, ancestor: Element): Element | null {
    const prepared = this.prepared;
    if (!prepared || !hit.path || prepared.revision !== this.revision) return null;
    return resolveLeaf(ancestor, hit.path);
  }

  // Whether the canonical #viewbox transform differs from the GPU camera: during motion the camera hook skips the SVG
  // write, so a native hit test (and d3.mouse) resolves against the old camera until the exact update.
  canonicalCameraStale(): boolean {
    const svg = parseViewboxTransform(this.svg.querySelector("#viewbox")?.getAttribute("transform") ?? null);
    const { k, x, y } = this.view;
    return svg.k !== k || svg.x !== x || svg.y !== y;
  }

  // Writes the GPU camera to the canonical SVG (editor fallback: the legacy path then reads a current SVG).
  syncCanonicalCamera(): void {
    this.syncSvgCamera();
  }

  // Diagnostics for a relief pick instance from prepare-time data only (no DOM read): its href, index and the href's
  // unsupported reason (null when the narrowphase decided the hit).
  glyphInfo(hit: PickHit): GlyphInfo | null {
    const relief = this.prepared?.relief;
    const icon = hit.instance === undefined ? undefined : relief?.icons[hit.instance];
    if (!relief || !icon) return null;
    const support = relief.support.get(icon.i);
    return { index: hit.instance!, href: icon.i, reason: support ? support.reason : "unread" };
  }

  // Per-href support of the prepared materialized relief: [href, reason (null = supported), instances].
  reliefSupport(): [string, string | null, number][] | null {
    const support = this.prepared?.relief?.support;
    return support ? Array.from(support, ([href, { reason, instances }]) => [href, reason, instances]) : null;
  }

  // World point under SVG-local CSS px at the GPU camera (what clicked()'s fallbacks read via d3.mouse(viewbox)).
  worldAt(x: number, y: number): [number, number] | null {
    return this.prepared && this.pickStatus() === null ? screenToWorld(this.view, x, y) : null;
  }

  worldReplaced(world: number): void {
    this.net.fail("world replaced");
    this.emblemCulling?.reset();
    this.world = world;
    this.generation++;
    this.worldEpoch++;
    this.scenes.clear();
    this.retained = null;
    const current = document.querySelector<SVGSVGElement>("#map");
    if (current && current !== this.svg) {
      this.mutations.disconnect();
      this.resizes.unobserve(this.svg);
      this.svg = current;
      current.after(this.canvas);
      this.mutations.observe(current, MAP_OBSERVED);
      this.resizes.observe(current);
    }
    this.definitions.attach();
    this.definitions.mapChanged();
    // the replaced #map is canonical: adopt its camera so hiding cannot write the previous world's transform over it
    const transform = this.svg.querySelector("#viewbox")?.getAttribute("transform");
    if (transform != null) this.view = parseViewboxTransform(transform);
    this.applyRootFilter();
    this.moving = this.prepareWanted = this.suspendWanted = false;
    clearTimeout(this.motionTimer);
    this.motionTimer = 0;
    this.pendingOverlays.clear(); // roots of the replaced document; the new world prepares from scratch
    this.drop();
    this.markers.release();
    forgetCompatClone();
    this.resize();
    this.schedulePrepare(0, "world");
  }

  telemetry(): GpuTelemetry {
    const state = this.device.lost
      ? "lost"
      : this.suspendedReason
        ? "suspended"
        : this.prepared
          ? "active"
          : this.preparing
            ? "preparing"
            : "waiting";
    const windows = this.prepared?.windows;
    return {
      state,
      world: this.world,
      revision: this.revision,
      frameRevision: this.prepared?.revision ?? null,
      ...this.stats,
      contextLosses: this.losses.count,
      lastRestoreMs: this.losses.lastRestoreMs,
      restore: this.recovery.snapshot(),
      pending:
        this.preparing ||
        this.prepareWanted ||
        this.suspendWanted ||
        !!this.prepareTimer ||
        this.prepared?.revision !== this.revision,
      refinementPending: !!this.settleTimer || this.activeRefinements > 0,
      moving: this.moving,
      invalidations: { ...this.invalidations },
      motionDeferrals: this.motionDeferrals,
      suspendDeferrals: this.suspendDeferrals,
      neutralMutations: this.neutralMutations,
      preparesWhileMoving: { ...this.preparesWhileMoving },
      lastPrepare: this.lastPrepare && { ...this.lastPrepare, phases: { ...this.lastPrepare.phases } },
      swapDrops: this.swapDrops,
      memory: {
        basis: "tracked-allocations",
        gpu: this.device.memory(), // steady: what is tracked now
        peak: Math.max(this.peaks.lifetime, this.device.peak()),
        preparePeak: this.peaks.lastPrepare, // latest prepare's own high-water (old + new coexisting), separate from steady
        budget: GPU_BUDGET,
        // cpuBytes already includes the glyph atlas canvas; without a frame only the atlas is retained
        cpu: this.prepared?.cpuBytes ?? this.atlas.canvas.width * this.atlas.canvas.height * 4
      },
      layers: this.prepared?.layers ?? {},
      compat: this.prepared?.compat ?? null,
      suspendedReason: this.suspendedReason,
      hold: {
        active: this.intentHold,
        heldMs: this.intentHold ? Math.round(performance.now() - this.holdFrom.at) : null,
        revisions: this.intentHold ? this.revision - this.holdFrom.revision : 0,
        ...this.holdStats,
        net: this.net.last && { ...this.net.last }
      },
      definitions: { ...this.definitions.stats },
      dialogScans: this.dialogScans,
      pickProfile: { ...this.pickProfile },
      canvasVisible: this.canvas.style.display !== "none",
      sourceCurrent: this.sourceCurrent(),
      hiddenReason: this.hiddenReason(this.suspendedReason),
      rootFilter: { ...this.rootFilterState },
      drawBatches: { ...this.graph.drawBatches },
      stateCalls: { ...this.graph.state.counts },
      passes: { ...this.graph.passes },
      timing: this.timer?.telemetry() ?? null,
      tessellation: this.prepared?.tessellation ?? null,
      markers: this.markers.count,
      windows: {
        coverage: !windows ? "none" : windows.covers(this.view, this.viewport) ? "covered" : "missing",
        bytes: windows?.bytes ?? 0,
        margin: windows?.margin ?? 0,
        ...this.windowStats
      },
      overlays: { ...this.overlayStats, pending: this.pendingOverlays.size },
      trace: {
        now: performance.now(),
        jobs: this.jobs.map(entry => ({ ...entry })),
        longTasks: this.longTasks.map(entry => ({ ...entry }))
      }
    };
  }

  // Starts a trace entry; the returned callback closes it with its duration and final detail.
  private traceJob(kind: TraceEntry["kind"], detail: string): (detail?: string) => void {
    const entry: TraceEntry = { kind, at: performance.now(), ms: null, detail };
    this.jobs.push(entry);
    if (this.jobs.length > TRACE_LIMIT) this.jobs.shift();
    return (final = entry.detail) => {
      entry.ms = performance.now() - entry.at;
      entry.detail = final;
    };
  }

  private observeLongTasks(): void {
    if (typeof PerformanceObserver !== "function" || !PerformanceObserver.supportedEntryTypes?.includes("longtask"))
      return;
    this.longTaskObserver = new PerformanceObserver(list => {
      for (const task of list.getEntries()) {
        this.longTasks.push({ at: task.startTime, ms: task.duration });
        if (this.longTasks.length > TRACE_LIMIT) this.longTasks.shift();
      }
    });
    this.longTaskObserver.observe({ type: "longtask" });
  }

  dispose(): void {
    this.stopCompatWatch();
    this.emblemCulling?.dispose();
    this.recovery.dispose();
    this.generation++;
    this.worldEpoch++;
    this.scenes.clear();
    this.retained = null;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.prepareTimer);
    clearTimeout(this.settleTimer);
    clearTimeout(this.motionTimer);
    clearTimeout(this.windowTimer);
    clearTimeout(this.overlayTimer);
    this.mutations.disconnect();
    this.definitions.dispose();
    this.dialogs.disconnect();
    this.suspendWanted = false; // no resume after disposal
    this.longTaskObserver?.disconnect();
    this.resizes.disconnect();
    window.removeEventListener("resize", this.onWindowResize);
    window.removeEventListener("beforeprint", this.onBeforePrint);
    window.removeEventListener("afterprint", this.onAfterPrint);
    document.fonts?.removeEventListener("loadingdone", this.onFontsLoaded);
    clearInterval(this.idleWatch);
    this.syncSvgCamera();
    this.drop();
    this.markers.release();
    this.timer?.dispose(this.device.lost);
    this.graph.dispose();
    this.device.dispose();
    this.canvas.remove();
    forgetCompatClone();
  }

  // The canvas is shown by draw() right after a successful render, and hidden here whenever it cannot be correct
  // (lifecycle.ts hiddenReason). A replaced #map also drops the frame: a load that fails before map:loaded must never
  // leave the previous world drawn over its partial replacement; the next worldReplaced prepares the new one.
  private active(): boolean {
    this.suspendedReason = this.editorReason();
    if (!this.suspendedReason) this.resume();
    const reason = this.hiddenReason(this.suspendedReason) || (this.intentHeld() ? "resume hold" : ""); // MODE: D13 hold
    if (reason === "source replaced" && this.prepared) this.drop();
    if (reason) this.hide();
    return !reason;
  }

  private hiddenReason(editor: string): string {
    return hiddenReason({
      prepared: !!this.prepared,
      lost: this.device.lost,
      sourceCurrent: this.sourceCurrent(),
      printing: this.printing,
      editor,
      root: this.rootFilterState.refused,
      markersPending: this.markers.pending
    });
  }

  private sourceCurrent(): boolean {
    return this.svg === document.querySelector<SVGSVGElement>("#map");
  }

  // Forwards the root #map filter to the canvas, or refuses the frame when the canvas cannot reproduce it.
  private applyRootFilter(): void {
    const computed = getComputedStyle(this.svg).filter;
    const next = rootFilter(
      computed || this.svg.getAttribute("filter"),
      id => document.getElementById(id) as unknown as FilterSource | null
    );
    if (this.canvas.style.filter !== next.css) this.canvas.style.filter = next.css;
    if (next.refused === this.rootFilterState.refused && next.css === this.rootFilterState.css) return;
    if (next.refused) console.info(`GPU frame hidden: ${next.refused}`);
    this.rootFilterState = next;
    this.requestDraw();
  }

  // The prepared bitmap crops cover the current view. Otherwise the canvas hides (SVG shown, never a frame missing
  // its canonical bitmaps) and a background refresh is scheduled.
  private covered(): boolean {
    const windows = this.prepared?.windows;
    if (!windows || windows.covers(this.view, this.viewport)) return true;
    this.hide();
    this.refreshWindows();
    return false;
  }

  // Re-crops the prepared frame's canonical bitmaps around the latest camera, off the input/rAF path. The prepared
  // frame keeps drawing meanwhile; a superseded, lost or replaced frame drops the job (the manager releases its
  // textures). Never rebuilds the frame or touches the source DOM.
  private refreshWindows(edge = false): void {
    const prepared = this.prepared;
    if (!prepared?.windows || this.windowJob || this.windowTimer || this.device.lost) return;
    if ((edge ? this.edgeMiss : this.windowMiss) === this.cameraKey()) return;
    this.windowTimer = window.setTimeout(async () => {
      this.windowTimer = 0;
      const windows = prepared.windows!;
      const generation = this.generation;
      const key = this.cameraKey();
      const stale = () =>
        generation !== this.generation || this.prepared !== prepared || this.device.lost || this.device.disposed;
      if (stale()) return;
      this.windowJob = true;
      const done = this.traceJob("window", edge ? "edge" : "miss");
      const refresh = () =>
        windows.refresh(this.view, this.viewport, stale, windowAllowance(this.device.memory().total, windows.bytes));
      try {
        let committed = await refresh();
        // Canonical crops outrank optional compat detail: free it, recompute the allowance and retry once. Settle
        // re-refines afterwards within whatever room the new crops leave. Only for an uncovered view: a proactive edge
        // refresh is optional too, and evicting detail for it would cycle release -> refresh -> re-refine.
        if (!committed && !edge && !stale() && hasDetail(prepared)) {
          this.refines++; // an in-flight refinement would refill the room
          releaseDetail(prepared, this.device);
          this.windowStats.detailReleases++;
          committed = await refresh();
          if (!stale() && !this.moving) this.scheduleSettle();
        }
        if (committed) {
          this.windowStats.refreshes++;
          this.windowMiss = this.edgeMiss = "";
        } else if (!stale() && key === this.cameraKey()) {
          // over budget even visible-only: retried once the camera changes. Only an uncovered view is a miss (the SVG
          // keeps it); a proactive edge refresh that cannot fit leaves the still-covering crops drawing.
          if (windows.covers(this.view, this.viewport)) this.edgeMiss = key;
          else {
            this.windowStats.misses++;
            this.windowMiss = key;
            console.info(`GPU window miss at k=${this.view.k} (${this.device.memory().total} B tracked)`);
          }
        }
      } catch (error) {
        if (!stale()) this.fallBack(`GPU bitmap window failed: ${errorText(error)}`);
        return;
      } finally {
        this.windowJob = false;
        done(stale() ? "stale" : undefined);
      }
      if (!stale()) this.requestDraw();
    }, 0);
  }

  // Screen-overlay lane: re-rasterizes only the changed overlays' prepared batches, off the observer callback, while the
  // frame keeps drawing the previous overlay pixels (one job ≈ one decode). Waits for an in-flight prepare, whose clone
  // may predate the change, and is re-kicked after it. A superseded job re-queues its roots; one the lane cannot do
  // (new/hidden/unsupported overlay, over budget) becomes a canonical revision, so no change is ever dropped.
  private refreshOverlays(): void {
    const prepared = this.prepared;
    if (!prepared || !this.pendingOverlays.size || this.overlayJob || this.overlayTimer || this.preparing) return;
    if (this.device.lost || this.moving) return; // gestures keep the main thread; settle() re-kicks
    this.overlayTimer = window.setTimeout(async () => {
      this.overlayTimer = 0;
      const generation = this.generation;
      const revision = this.revision;
      const { width, height, dpr } = this.viewport;
      const stale = () =>
        generation !== this.generation ||
        revision !== this.revision ||
        this.prepared !== prepared ||
        this.preparing ||
        width !== this.viewport.width ||
        height !== this.viewport.height ||
        dpr !== this.viewport.dpr ||
        this.device.lost ||
        this.device.disposed;
      if (stale()) return; // the next prepare or resize re-kicks with the roots still pending
      const roots = [...this.pendingOverlays];
      this.pendingOverlays.clear();
      this.overlayJob = true;
      const started = performance.now();
      const done = this.traceJob("overlay", "running");
      let outcome: "committed" | "stale" | "full" | "failed" = "failed";
      try {
        outcome = await refreshOverlayBatches(
          prepared,
          { ...this.ctx(generation, prepared, this.refines), stale },
          roots
        );
      } catch (error) {
        if (!stale()) console.warn(`GPU overlay refresh failed, re-preparing: ${errorText(error)}`);
      } finally {
        this.overlayJob = false;
      }
      this.overlayStats.lastMs = performance.now() - started;
      this.overlayStats.last = outcome;
      done(outcome === "committed" || !stale() ? outcome : "stale");
      if (outcome === "committed") {
        this.overlayStats.refreshes++;
        this.requestDraw();
      } else if (stale()) {
        // superseded: a revision re-prepares from the live DOM; otherwise retry the same roots on the next kick
        this.overlayStats.stale++;
        if (revision === this.revision && generation === this.generation)
          for (const root of roots) if (root.isConnected) this.pendingOverlays.add(root);
      } else {
        this.overlayStats.fulls++;
        this.invalidate(false); // the overlay's own records already dirtied its run
        return;
      }
      this.refreshOverlays();
    }, 0);
  }

  private cameraKey(): string {
    const { k, x, y } = this.view;
    const { width, height, dpr } = this.viewport;
    return `${k} ${x} ${y} ${width} ${height} ${dpr}`;
  }

  private hide(): void {
    this.emblemCulling?.reveal();
    if (this.canvas.style.display === "none") return;
    this.syncSvgCamera();
    this.canvas.style.display = "none";
  }

  // ---- MODE (W1, decision D10; resume display D13, W2 LIFE2): Navigate/Edit intent and the resume hold. The state
  // machine is in intent.ts and the UI in controllers/render-mode.ts. Outside this block: editorScan() below (wrapped by
  // editorReason() here), the hold in the visibility test in active(), and holding() in prepare()'s motion inputs.
  // Edit suspends exactly like an open editor (reason "edit mode"). Every suspension (an editor or customization
  // opened from Navigate, a chosen Edit, or both) records the DOM revision it began at. When it ends, a suspension
  // that changed the model (any static revision since it began, same-task edits of the close included) ends in a hold:
  // the canvas stays hidden, with the canonical SVG shown and usable and the indicator on "Preparing", until the GPU
  // frame has caught up with every revision, so a frame from before the edit is never shown as the map (D13). One
  // that changed nothing returns to the last GPU frame at once (still "Updating" if that frame was already behind
  // before the suspension, e.g. a zoom-dependent DOM write). While held, motion does not abort or defer the prepare:
  // the SVG is what is on screen, so no stale frame can be revealed and the GPU view returns as soon as possible.
  // W3 LIFE3: "changed" is the net change of the model DOM (net-change.ts), not any revision. A suspension whose
  // records leave svg#map as it was (an editor opened and closed: burg icons swapped to vectors and back, a marker
  // raised) returns to the last GPU frame at once ("Updating" while the re-prepare its revisions asked for runs).
  // When the test cannot tell (records it cannot place, too many, a changed definition outside svg#map) the revision
  // rule decides, as before.
  private intentEdit = false;
  private intentHold = false;
  private suspendedFrom: number | null = null; // revision at which the current suspension began (null: none)
  private holdFrom = { at: 0, revision: 0 }; // when the current hold began, and the revision it waits for then
  private holdStats = { holds: 0, lastMs: null as number | null, skipped: 0, netUnchanged: 0, netUnsure: 0 };
  private readonly net = new NetChange();

  setIntent(edit: boolean): void {
    const records = this.mutations.takeRecords(); // edits made before the request belong before the suspension
    if (records.length) this.mutated(records);
    this.intentEdit = edit;
    this.active(); // Edit: hides now (camera synced). Navigate: runs the prepare the suspension deferred, if any.
    this.requestDraw();
  }

  // Cheap per-poll state for the mode indicator. editor: an open dialog or customization (not the Edit intent);
  // ready: the GPU canvas is on screen (not suspended or held, a frame, a live device, no pending markers, the view
  // inside the bitmap windows: whatever hides it hides "Navigate"); current: that frame has every DOM revision;
  // holdMs/holdRevisions: how long the resume hold has waited and how many revisions arrived since it began (a model
  // that keeps changing keeps the hold on: the indicator says why instead of spinning silently).
  intentProbe(): {
    editor: string;
    ready: boolean;
    current: boolean;
    lost: boolean;
    holdMs: number;
    holdRevisions: number;
  } {
    const reason = this.editorReason();
    if (reason && this.canvas.style.display !== "none") this.active();
    const current = this.prepared?.revision === this.revision;
    const held = !reason && this.intentHeld();
    return {
      editor: reason === "edit mode" ? "" : reason,
      ready: !reason && !!this.prepared && !this.device.lost && !held && this.canvas.style.display !== "none",
      current,
      lost: this.device.lost,
      holdMs: held ? Math.round(performance.now() - this.holdFrom.at) : 0,
      holdRevisions: held ? this.revision - this.holdFrom.revision : 0
    };
  }

  // Why the GPU is suspended: an open editor or customization first (the dialog scan), else the Edit intent. Also the
  // one place a suspension's start and end are seen (every path that shows or prepares asks it first).
  private editorReason(): string {
    const reason = this.editorScan() || (this.intentEdit ? "edit mode" : "");
    if (reason) {
      if (this.suspendedFrom === null) {
        this.suspendedFrom = this.revision;
        this.net.begin();
      }
    } else if (this.suspendedFrom !== null) this.suspensionEnded(this.suspendedFrom);
    return reason;
  }

  private suspensionEnded(from: number): void {
    this.suspendedFrom = null;
    // the close's own edits (an editor applying its change as it closes, in the same task) count as made inside it
    const records = this.mutations.takeRecords();
    this.net.note(records);
    this.definitions.flush();
    const net = this.net.end(this.svg); // before mutated(): it may see a dialog opening in the same task (a new session)
    if (records.length) this.mutated(records);
    if (this.revision === from) {
      this.holdStats.skipped++;
      return;
    }
    if (net === "unchanged") {
      this.holdStats.netUnchanged++;
      return;
    }
    if (net === "unsure") this.holdStats.netUnsure++;
    if (!this.intentHold) {
      this.holdStats.holds++;
      this.holdFrom = { at: performance.now(), revision: this.revision };
    }
    this.intentHold = true;
  }

  // Only asked while not suspended (active() and intentProbe() test the suspension first): the hold clears when the
  // prepared frame has every revision, including those that arrived while it was held.
  private intentHeld(): boolean {
    if (this.intentHold && this.prepared?.revision === this.revision) {
      this.intentHold = false;
      this.holdStats.lastMs = Math.round(performance.now() - this.holdFrom.at);
    }
    return this.intentHold;
  }

  // The canvas is hidden for a resume hold: motion moves the SVG, not a GPU frame, so it need not stop a prepare.
  private holding(): boolean {
    return this.intentHold && this.canvas.style.display === "none";
  }
  // ---- end MODE ----

  // Editors draw into and read the live SVG; GPU drawing is suspended (SVG shown) while one is open. Experimental.
  // `customization` is a top-level `let` in classic main.js: a global binding, but not a window property.
  // The dialog scan is cached and recomputed only after a document mutation that can show or hide a dialog (an added or
  // removed node, a style/class/hidden change anywhere): queued records are drained first, so an open() or close() in
  // the same task is seen before the next query. CSSOM rule edits are not observed (no editor uses them).
  private editorScan(): string {
    const mode = customizationMode();
    if (typeof mode === "number" && mode) return editorState(mode, false);
    if (this.dialogs.takeRecords().length) this.dialogsDirty = true;
    if (this.dialogsDirty) {
      this.dialogsDirty = false;
      this.dialogShown = [...document.querySelectorAll<HTMLElement>(".ui-dialog")].some(isShown);
      this.dialogScans++;
    }
    return editorState(mode, this.dialogShown);
  }

  // The SVG under a hidden canvas must show the GPU camera; transform-only writes are ignored by the observer.
  private syncSvgCamera(): void {
    const viewbox = this.svg.querySelector("#viewbox");
    const { k, x, y } = this.view;
    const transform = `translate(${x} ${y}) scale(${k})`;
    if (viewbox && viewbox.getAttribute("transform") !== transform) viewbox.setAttribute("transform", transform);
  }

  private mutated(records: MutationRecord[]): void {
    this.noticeSuspension();
    this.net.note(records);
    if (records.some(record => record.target === this.svg && record.type === "attributes")) this.applyRootFilter();
    const roots: Element[] = [];
    const change = classify(
      records,
      record => (this.invalidations.last = describeMutation(record)),
      () => this.neutralMutations++,
      root => roots.push(root as Element)
    );
    // per record, for compat raster reuse: which runs a change can reach (compat-reuse.ts)
    if (this.compatReuse && (change === "static" || change === "overlay")) compatDirt.note(pixelRecords(records));
    if (change === "static") {
      this.definitions.mapChanged();
      this.traceJob("revision", this.invalidations.last)();
      this.invalidate(false);
      return;
    }
    if (change === "overlay") {
      // A world-layer overlay root (#coordinates, markers.ts VIEW_OVERLAYS) has no in-place refresh yet: the lane would
      // answer "full" one timer hop later, and meanwhile neither an in-flight prepare nor a refine would see the change
      // (the lane never bumps the revision). It is a revision now; only screen overlays (children of svg#map) wait for
      // the lane. prepare.ts refreshOverlays() needs a world-run path before #coordinates can skip the full prepare.
      const view = roots.find(root => root.parentNode !== this.svg);
      if (view) {
        this.invalidations.last = `view overlay #${view.id}`;
        this.traceJob("revision", this.invalidations.last)();
        this.invalidate(false);
        return;
      }
      for (const root of roots) this.pendingOverlays.add(root);
      this.refreshOverlays();
    }
    if (change !== "none") this.requestDraw();
  }

  // A suspension that begins in the same task as these records must see them (D13): an editor dialog that opens and
  // edits at once (its records wait on the dialog observer, which may be notified after this one), or a customization
  // mode, a bare global no event announces, set together with its first DOM writes.
  private noticeSuspension(): void {
    if (this.suspendedFrom !== null) return;
    const pending = this.dialogs.takeRecords();
    if (pending.length) this.dialogsChanged(pending);
    else if (typeof customizationMode() === "number" && customizationMode()) this.editorReason();
  }

  // A definition the map references changed outside svg#map (definitions.ts): a static revision. No record of it
  // reaches the net-change test, so a suspension it lands in is judged by the revision rule.
  private definitionChanged(reason: string): void {
    this.net.fail(reason);
    compatDirt.all(reason);
    this.invalidations.last = reason;
    this.traceJob("revision", reason)();
    this.invalidate(false);
  }

  // `forced`: a re-prepare no observed mutation explains (bench controls), so no compat raster may be reused
  private invalidate(forced = true): void {
    if (forced) compatDirt.all("forced re-prepare");
    this.revision++;
    this.invalidations.count++;
    this.schedulePrepare(PREPARE_DELAY, "revision");
  }

  // Inexact camera: the gesture owns the main thread. A pending settle or in-flight refinement is cancelled (the next
  // stop reschedules it); the watchdog ends motion that never receives an exact update (e.g. a cancelled gesture).
  private motion(): void {
    this.moving = true;
    clearTimeout(this.settleTimer);
    this.settleTimer = 0;
    if (this.activeRefinements) this.refines++;
    clearTimeout(this.motionTimer);
    this.motionTimer = window.setTimeout(() => {
      this.motionTimer = 0;
      this.stopped();
    }, MOTION_IDLE);
  }

  private stopped(): void {
    clearTimeout(this.motionTimer);
    this.motionTimer = 0;
    this.moving = false;
    this.refreshOverlays();
    this.scheduleSettle();
  }

  // A closed editor runs the prepare it suspended, once. An in-flight job re-checks in its finally block instead.
  private resume(): void {
    if (!this.suspendWanted || this.preparing || this.editorReason()) return;
    this.suspendWanted = false;
    this.schedulePrepare(0, "resume");
  }

  private schedulePrepare(delay: number, reason: PrepareReason): void {
    clearTimeout(this.prepareTimer);
    this.prepareReason = reason;
    this.prepareTimer = window.setTimeout(() => {
      this.prepareTimer = 0;
      void this.prepare();
    }, delay);
  }

  private scheduleSettle(): void {
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = 0;
      void this.settle();
    }, SETTLE_DELAY);
  }

  private bucket(): number {
    return scaleBucket(this.view.k * this.viewport.dpr);
  }

  private worldRegion(): Region {
    const width = page.graphWidth || this.viewport.width;
    const height = page.graphHeight || this.viewport.height;
    return { x: 0, y: 0, width, height };
  }

  private async prepare(): Promise<void> {
    // a replaced #map waits for worldReplaced (map:loaded); a load that failed half way never re-prepares the old world
    if (!this.sourceCurrent() || !this.svg.querySelector("#viewbox")) return;
    // Keep navigation on the drawable frame: hover/style/resize work waits for the next settle (motion.ts). A replaced
    // world has no prepared frame and still prepares immediately. An open editor hides the canvas, so a prepare that
    // would only replace a frame waits for its close (resume()).
    this.suspendedReason = this.editorReason();
    const start = prepareStart({
      preparing: this.preparing,
      lost: this.device.lost,
      hasFrame: !!this.prepared,
      moving: this.moving && !this.holding(), // MODE (D13): a held frame is hidden, motion cannot reveal it
      suspended: !!this.suspendedReason
    });
    if (start === "skip") return;
    if (start === "suspend") {
      this.suspendWanted = true;
      this.suspendDeferrals++;
      return;
    }
    if (start === "defer") {
      this.prepareWanted = true;
      this.motionDeferrals++;
      return;
    }
    this.prepareWanted = false;
    this.preparing = true;
    const generation = this.generation;
    const revision = this.revision;
    const job = { generation, revision, hadFrame: !!this.prepared };
    let sourceChanged = false; // the prepare gave up on a DOM change that bumped no revision (prepareFrame's sourceChanged)
    const record: NonNullable<GpuTelemetry["lastPrepare"]> = {
      reason: this.prepareReason,
      hadFrame: job.hadFrame,
      moving: this.moving,
      outcome: "running",
      phases: {}
    };
    this.lastPrepare = record;
    if (this.moving) this.preparesWhileMoving.starts++;
    const started = performance.now();
    const recovering = this.recovery.prepareStart();
    const done = this.traceJob("prepare", record.reason);
    // a gesture that starts mid-prepare aborts it at the next checkpoint; the previous frame keeps drawing
    const stale = () => {
      const reason = prepareStale(job, {
        generation: this.generation,
        revision: this.revision,
        moving: this.moving && !this.holding(),
        lost: this.device.lost,
        disposed: this.device.disposed,
        suspended: !!this.editorReason()
      });
      if (reason === "motion" && !this.prepareWanted) {
        this.prepareWanted = true;
        this.motionDeferrals++;
      }
      if (reason === "suspended" && !this.suspendWanted) {
        this.suspendWanted = true;
        this.suspendDeferrals++;
      }
      return reason !== "" || !this.sourceCurrent();
    };
    try {
      this.atlas.clear();
      // Cancels an in-flight refinement; its detail is dropped to lower the old+new swap peak. With reuse on, prepareFrame
      // drops only the detail it does not carry over (after the scene phase).
      this.refines++;
      if (!this.compatReuse && this.prepared) releaseDetail(this.prepared, this.device);
      // per-prepare high-water (old frame + new allocations); the lifetime peak keeps what the reset discards
      this.peaks.lifetime = Math.max(this.peaks.lifetime, this.device.peak());
      this.device.resetPeak();
      const next = await prepareFrame(this.svg, {
        device: this.device,
        revision,
        bucket: this.bucket(),
        world: this.worldRegion(),
        screen: this.viewport,
        camera: { ...this.view },
        atlas: this.atlas,
        stale,
        sourceChanged: () => {
          sourceChanged = true;
          this.revision++; // the cached scene and export clone predate the change
        },
        mark: step => {
          record.phases[step] = Math.round(performance.now() - started);
          if (recovering) this.recovery.prepareStep(recovering, step);
        },
        scenes: this.scenes,
        worldEpoch: this.worldEpoch,
        picking: this.pickingEnabled,
        previous: this.prepared,
        retained: this.retained
      });
      if (next) record.reuse = next.compat.reuse;
      if (!next) {
        record.outcome = "stale";
        return;
      }
      // motion can begin during the last synchronous chunk, after the final checkpoint: never swap frames mid-gesture
      if (stale()) {
        record.outcome = "stale";
        next.release();
        return;
      }
      this.drop();
      this.prepared = next;
      this.retained = null;
      this.stats.prepares++;
      record.outcome = "committed";
      if (this.moving) this.preparesWhileMoving.commits++;
      this.stats.lastPrepareMs = performance.now() - started;
      if (!this.moving)
        this.view = parseViewboxTransform(this.svg.querySelector("#viewbox")!.getAttribute("transform"));
      this.clear = clearColor(this.svg);
      this.applyRootFilter();
      this.requestDraw();
      // crisp initial idle frame: refine compat runs for the current view without waiting for a camera gesture
      if (!this.moving) this.scheduleSettle();
    } catch (error) {
      record.outcome = "failed";
      if (generation !== this.generation || this.device.lost) return;
      // over the caps beside the previous frame: free it (canonical SVG shows) and rebuild alone instead of falling back
      if (error instanceof BudgetError && job.hadFrame && this.prepared) {
        record.outcome = "swap-dropped";
        this.swapDrops++;
        this.drop();
        this.schedulePrepare(0, "swap");
      } else this.fallBack(`GPU prepare failed: ${errorText(error)}`);
    } finally {
      this.recovery.prepareEnd(recovering, record.outcome === "committed");
      this.peaks.lastPrepare = this.device.peak();
      done(`${record.reason} ${record.outcome}`);
      this.preparing = false;
      // a newer world, restored context or DOM revision arrived while this job ran
      const behind = generation !== this.generation || this.revision !== revision || !this.prepared || sourceChanged;
      if (behind && !this.device.lost && !this.device.disposed && !this.prepareTimer) {
        // a frame under an open editor waits for its close (resume); a frame-less renderer still prepares now
        if (this.prepared && this.editorReason()) this.suspendWanted = true;
        else this.schedulePrepare(PREPARE_DELAY, "behind");
      }
      this.resume();
      // overlay changes that waited for this job (its clone may predate them)
      if (!behind && !this.device.disposed) this.refreshOverlays();
    }
  }

  // After motion stops: run a prepare deferred by motion or needed by a new revision/raster bucket, else sharpen compat
  // runs for the visible area. A frame-less renderer and an in-flight prepare reschedule themselves.
  private async settle(): Promise<void> {
    const prepared = this.prepared;
    if (!prepared || this.preparing || this.moving) return;
    this.refreshOverlays();
    const action = settleAction({
      wanted: this.prepareWanted,
      revisionCurrent: prepared.revision === this.revision,
      bucketCurrent: prepared.bucket === this.bucket(),
      refinable: prepared.runs.some(run => !run.screen)
    });
    if (action === "prepare")
      return this.schedulePrepare(
        0,
        this.prepareWanted ? "settle-wanted" : prepared.revision !== this.revision ? "settle-revision" : "settle-bucket"
      );
    if (action === "none" || !this.active()) return;
    const { visible, pixels } = refineView(this.view, this.viewport);
    const generation = this.generation;
    const token = ++this.refines; // a newer settle or prepare supersedes this refinement
    // with reuse on, refineCompat itself releases every detail it does not keep for this view before measuring room;
    // off, details cut for this very request (the prepare's first-frame details) are left for it to keep
    if (!this.compatReuse) releaseDetail(prepared, this.device, refineRequest(visible, pixels));
    this.requestDraw();
    this.activeRefinements++;
    const done = this.traceJob("refine", "running");
    let outcome = "failed";
    try {
      // headroom below the steady budget so a window refresh can usually fit beside the detail
      const ctx = this.ctx(generation, prepared, token);
      const refined = await refineCompat(prepared, ctx, visible, pixels, GPU_BUDGET - DETAIL_RESERVE);
      const reuse = prepared.compat.refine;
      outcome = `${refined ? "committed" : "skipped"}${reuse && this.compatReuse ? ` kept ${reuse.kept} cut ${reuse.rasterized}` : ""}`;
      if (refined && this.prepared === prepared) this.requestDraw();
    } catch {
      // detail is optional: the base compat raster keeps drawing
    } finally {
      this.activeRefinements--;
      done(outcome);
    }
  }

  private ctx(generation: number, prepared: Prepared, token: number) {
    return {
      device: this.device,
      revision: prepared.revision,
      bucket: prepared.bucket,
      world: this.worldRegion(),
      screen: this.viewport,
      camera: { ...this.view },
      atlas: this.atlas,
      stale: () =>
        generation !== this.generation ||
        prepared.revision !== this.revision ||
        this.prepared !== prepared ||
        token !== this.refines ||
        this.device.lost
    };
  }

  private requestDraw(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private draw(): void {
    // The context can be lost before `webglcontextlost` fires (device.lost still false); targets would be incomplete.
    if (!this.active() || !this.covered() || this.device.gl.isContextLost()) return;
    const started = performance.now();
    const markers = this.markers.collect(this.svg.querySelector(`#viewbox > #${TRADE_LAYER}`));
    if (this.markers.issue) {
      this.fallBack(`GPU trade markers: ${this.markers.issue}`);
      return;
    }
    if (this.markers.pending) {
      this.hide();
      return;
    }
    const timer = this.timer;
    if (timer) {
      const rendering = performance.now();
      timer.begin();
      try {
        this.graph.render(this.prepared!.frame, this.view, this.viewport, this.clear, markers);
      } finally {
        timer.end({
          cpuMs: performance.now() - rendering,
          // render() zeroes the counters when the frame starts, so this is the frame's own count
          stateIssued: this.graph.state.counts.issued,
          ...this.graph.passes
        });
      }
    } else this.graph.render(this.prepared!.frame, this.view, this.viewport, this.clear, markers);
    if (this.canvas.style.display !== "block") this.canvas.style.display = "block";
    this.emblemCulling?.update(this.view, this.viewport, this.clear[3] === 1, this.moving);
    this.stats.frames++;
    this.stats.lastFrameMs = performance.now() - started;
    const windows = this.prepared!.windows;
    const edge = Math.min(WINDOW_EDGE, (windows?.margin ?? 0) / 2);
    if (windows && edge > 0 && !windows.covers(this.view, this.viewport, edge)) this.refreshWindows(true);
    if (this.lostAt) {
      this.losses.lastRestoreMs = performance.now() - this.lostAt;
      this.lostAt = 0;
      this.recovery.drawn();
    }
  }

  private resize(): void {
    const rect = this.svg.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    Object.assign(this.canvas.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`
    });
    const changed = rect.width !== this.viewport.width || rect.height !== this.viewport.height;
    const dprChanged = Math.min(dpr, 2) !== this.viewport.dpr;
    this.viewport = { width: Math.max(1, rect.width), height: Math.max(1, rect.height), dpr: Math.min(dpr, 2) };
    if (!this.device.lost) this.device.resize(this.viewport.width, this.viewport.height, dpr);
    // screen-space compat runs are rasterized at viewport size
    if ((changed || dprChanged) && this.prepared?.runs.some(run => run.screen))
      this.schedulePrepare(PREPARE_DELAY, "resize");
    this.requestDraw();
  }

  // Miss keys belong to the dropped frame's crops: a re-prepared, replaced or restored frame retries at the same camera.
  private drop(): void {
    this.hide();
    this.prepared?.release();
    this.prepared = null;
    this.windowMiss = this.edgeMiss = "";
  }

  // The SVG shows (camera synced) while resources are gone; releases are no-ops on a lost device.
  private lost(): void {
    this.losses.count++;
    this.lostAt = performance.now();
    this.recovery.lost();
    this.generation++;
    this.prepareWanted = this.suspendWanted = false; // restored() prepares unconditionally
    // PERF B1: keep the frame's CPU payload for a same-revision restore. Any prepare since the frame (in flight, aborted
    // or released) has cleared the glyph atlas: retainFrame checks the atlas generation the frame recorded.
    this.retained = retainFrame(this.prepared, this.atlas) ?? this.retained;
    this.drop();
    this.markers.forget();
    this.timer?.lose();
  }

  // The old graph's programs/VAOs died with the lost context (the device already forgot them); deleting them through
  // the new context would be invalid, so the graph is simply rebuilt and the frame re-prepared.
  private restored(): void {
    this.recovery.restored();
    try {
      this.graph = new FrameGraph(this.device);
      this.timer?.restore(this.device.gl);
      this.resize();
      this.recovery.graphReady();
      this.schedulePrepare(0, "restore");
    } catch (error) {
      this.fallBack(`GPU restore failed: ${errorText(error)}`);
    }
  }
}

// characterDataOldValue: the D13 net-change test (net-change.ts) needs the original text of an edited text node
const MAP_OBSERVED: MutationObserverInit = {
  subtree: true,
  childList: true,
  attributes: true,
  attributeOldValue: true,
  characterData: true,
  characterDataOldValue: true
};

// A mutation that can open a jQuery UI dialog: its wrapper added, or the wrapper's own style/class changed.
function touchesDialog(record: MutationRecord): boolean {
  if (record.target instanceof Element && record.target.classList.contains("ui-dialog")) return true;
  for (const node of record.addedNodes)
    if (node instanceof Element && node.classList.contains("ui-dialog")) return true;
  return false;
}

// Computed visibility: jQuery UI dialogs that were closed (or never opened) stay in the DOM hidden by CSS.
function isShown(element: HTMLElement): boolean {
  if (element.checkVisibility) return element.checkVisibility({ checkVisibilityCSS: true });
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let detachRecover: (() => void) | null = null;

export function createGpuRenderer(fallBack: (reason: string) => void): GpuRenderer {
  const svg = document.getElementById("map");
  if (!(svg instanceof SVGSVGElement)) throw new Error("missing <svg id=map>");
  const gpuSelection = new URLSearchParams(location.search).has("gpu-select");
  const renderer = new GpuRenderer(svg, fallBack, gpuSelection);
  page.gpuRenderer = renderer;
  page.gpuPick = (x, y, tolerance) => renderer.pick(x, y, tolerance);
  // canvas fallbacks are read per call: their modules may load after the renderer. Read-only: the relief leg peeks
  // (no glyph materialization); committing a relief selection stays pickRelief's job.
  page.gpuSelect = (x, y, tolerance) =>
    selectAt(
      {
        unavailable: () => renderer.pickStatus(),
        pick: (px, py, t) => renderer.pick(px, py, t),
        world: (px, py) => renderer.worldAt(px, py),
        element: id => document.getElementById(id),
        glyph: hit => renderer.glyphAt(hit),
        leaf: (hit, ancestor) => renderer.leafAt(hit, ancestor),
        glyphInfo: hit => renderer.glyphInfo(hit),
        fallbacks: !!page.pickRelief,
        pickBurg: page.pickBurg,
        peekRelief: page.peekRelief
      },
      x,
      y,
      tolerance
    );
  // Canonical click recovery is required whenever the GPU defers SVG camera writes. Only GPU target selection
  // is experimental: without ?gpu-select the handler never queries the index and re-runs the native SVG hit test.
  {
    const telemetry = createTelemetry();
    const select = page.gpuSelect;
    const stale = () => renderer.canonicalCameraStale();
    const sync = () => renderer.syncCanonicalCamera();
    const resolve = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y);
      return hit && document.getElementById("viewbox")?.contains(hit) ? hit : null;
    };
    page.gpuClickTelemetry = telemetry;
    page.gpuClickRoute = event =>
      routeClick(
        {
          select: gpuSelection ? (x, y) => select(x, y, 0) : null,
          origin: () => {
            const rect = document.getElementById("map")?.getBoundingClientRect();
            return [rect?.left ?? 0, rect?.top ?? 0];
          },
          stale,
          sync,
          resolve,
          ready: READY_KINDS
        },
        event,
        telemetry
      );
    // on the document, matched against the live #map: a world load may replace the element the renderer started with
    const background = (el: EventTarget | null) => !!el && el === document.getElementById("map");
    const recover = (event: MouseEvent) => {
      const target = recoverClick({ stale, sync, background, resolve }, event, telemetry);
      if (!target) return;
      event.stopImmediatePropagation();
      target.dispatchEvent(new MouseEvent("click", event)); // once: the re-dispatched target is inside #viewbox
    };
    document.addEventListener("click", recover, true);
    detachRecover = () => document.removeEventListener("click", recover, true);
  }
  return renderer;
}

export function detachGpuGlobals(renderer: GpuRenderer): void {
  if (page.gpuRenderer !== renderer) return;
  detachRecover?.();
  detachRecover = null;
  page.gpuRenderer = null;
  page.gpuPick = null;
  page.gpuSelect = null;
  page.gpuClickRoute = null;
  page.gpuClickTelemetry = null;
}
