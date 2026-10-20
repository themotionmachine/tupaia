// Shared browser harness for the CENSUS checks (toggle-census.ts, resize-print.ts, customization.ts, memory-cycles.ts;
// REWRITE-PLAN §5 rows 25-28 and 39, PROOF-PLAN gate gap 16). Node side only; the page-side helpers live in the
// functions passed to page.evaluate, which must stay self-contained (they are serialised).
//
// What it gives a check:
//   - a static server for dist/ and a launcher-checked Chromium (launcher.ts: Metal by default);
//   - openPage(): one fresh page under ?renderer=gpu or ?renderer=svg with the MCP bridge, the parity page script and
//     page error / console collection, the way the golden and replay runners open theirs;
//   - loadParity(): the fixture load path of the golden (loadMap, __parity.preamble(), hideLabels off, every layer the
//     families need turned on), so a census check starts from the same populated world;
//   - waitCurrent(): "the GPU frame shows the current DOM" (not pending, not refining, canvas visible, overlays done),
//     the strict reading of the golden's waitGpu;
//   - captureArms(): GPU arm (canvas shown) and SVG arm (canvas hidden) from the SAME DOM state, so a verdict is
//     always the GPU against the SVG reference of one build, never GPU against GPU.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, resolve } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import type { Rgba } from "../fidelity-metrics.ts";
import { decodePng } from "../png.ts";
import { FAMILIES } from "./golden-families.ts";
import { adapterMatches, type Launcher, launcherFrom, launchOptions, probeAdapter } from "./launcher.ts";
import { resolveFixture } from "./fixtures/index.ts";

export const ROOT = resolve(import.meta.dirname, "../..");
export const DIST = resolve(ROOT, "dist");
export const VIEWPORT = { width: 1280, height: 720 };

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json" };

export interface Served {
  origin: string;
  server: Server;
  close(): Promise<void>;
}

export async function serveDist(): Promise<Served> {
  const server = createServer((request, response) => {
    if (request.method !== "GET") return void response.writeHead(405).end();
    const path = resolve(DIST, `.${new URL(request.url || "/", "http://localhost").pathname}`);
    if (!path.startsWith(`${DIST}/`) && path !== DIST) return void response.writeHead(403).end();
    try {
      const file = path === DIST ? resolve(DIST, "index.html") : path;
      response.setHeader("content-type", MIME[extname(file)] || "application/octet-stream");
      response.end(readFileSync(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("no server address");
  return { origin: `http://127.0.0.1:${address.port}`, server, close: () => new Promise<void>(done => server.close(() => done())) };
}

export interface Sink {
  errors: string[];
  warnings: string[];
}

export interface OpenOptions {
  dpr: number;
  renderer: "gpu" | "svg";
  launcher: Launcher;
  viewport?: { width: number; height: number };
  sink: Sink;
  label?: string;
  parity?: boolean; // inject the parity fixture's page script (default true)
  census?: boolean; // install the opt-in scene census sink (default false)
}

export interface OpenedPage {
  context: BrowserContext;
  page: Page;
  adapter: { renderer: string | null; vendor: string | null };
}

const BRIDGE = ["bridge.js", "bridge-mutations.js", ...readdirSync(resolve(ROOT, "mcp/src/bridge-ext")).filter(n => n.endsWith(".js")).sort().map(n => `bridge-ext/${n}`)];

export async function openPage(browser: Browser, origin: string, options: OpenOptions): Promise<OpenedPage> {
  const { sink, label = options.renderer } = options;
  const context = await browser.newContext({ viewport: options.viewport ?? VIEWPORT, deviceScaleFactor: options.dpr, serviceWorkers: "block", acceptDownloads: false });
  // app origin only: init scripts also run in opaque-origin frames, where localStorage throws
  await context.addInitScript((localOrigin: string) => {
    if (location.origin !== localOrigin) return;
    localStorage.setItem("autosaveInterval", "0");
    localStorage.setItem("azgaarAssistant", "hide");
    (globalThis as any).__name ??= (fn: unknown) => fn;
  }, origin);
  if (options.census) await context.addInitScript(() => ((globalThis as any).__gpuSceneCensus = {}));
  await context.addInitScript(BRIDGE.map(n => readFileSync(resolve(ROOT, "mcp/src", n), "utf8")).join("\n"));
  if (options.parity !== false) await context.addInitScript(readFileSync(resolve(import.meta.dirname, "fixtures/parity-page.js"), "utf8"));
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.origin === origin || (route.request().method() === "GET" && url.hostname === "fonts.gstatic.com") ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  page.on("pageerror", error => sink.errors.push(`${label}: ${error.message}`));
  page.on("console", message => {
    if (["warning", "error"].includes(message.type()) && sink.warnings.length < 120) sink.warnings.push(`${label}: ${message.text().slice(0, 600)}`);
  });
  page.on("dialog", dialog => dialog.dismiss());
  const { width, height } = options.viewport ?? VIEWPORT;
  await page.goto(`${origin}/?local&seed=7319&width=${width}&height=${height}&renderer=${options.renderer}`);
  await page.evaluate(async () => {
    const ready = await (globalThis as any).__tupaia.call("ready", { timeoutMs: 120000 });
    if (!ready.ok) throw Error(JSON.stringify(ready));
  });
  const adapter = await page.evaluate(probeAdapter);
  if (options.renderer === "gpu" && !adapterMatches(options.launcher, adapter.renderer)) throw Error(`launcher ${options.launcher} got WebGL adapter ${adapter.renderer}`);
  return { context, page, adapter };
}

export async function launch(launcherName: string | undefined): Promise<{ browser: Browser; launcher: Launcher }> {
  const launcher = launcherFrom(launcherName);
  return { browser: await chromium.launch(launchOptions(launcher)), launcher };
}

/** Bridge `display` names of every family that has an app toggle (golden-families.ts). */
export const FAMILY_TOGGLES = [...new Set(FAMILIES.map(f => f.toggle).filter((t): t is string => !!t))];

export interface FixtureInfo {
  path: string;
  text: string;
  sha256: string;
}

export function parityFixture(override?: string): FixtureInfo {
  const fx = resolveFixture("parity");
  const path = override ? resolve(override) : fx.path;
  const text = readFileSync(path, "utf8");
  return { path, text, sha256: override ? "custom" : fx.sha256 };
}

/**
 * Loads the fixture through the app's own load path and brings the world to the state the golden measures: the
 * parity preamble (cells layer, #debug content, Rendering select), labels at every zoom, and every family toggle on.
 */
export async function loadParity(page: Page, fixture: FixtureInfo, toggles: string[] = FAMILY_TOGGLES): Promise<string[]> {
  const problems: string[] = [];
  await page.evaluate(async text => {
    const w = globalThis as any;
    const result = await w.__tupaia.fns.loadMap({ text, timeoutMs: 120000 });
    if (result?.ok === false) throw Error(JSON.stringify(result));
    await w.__tupaia.settle();
  }, fixture.text);
  await page.evaluate(async () => {
    const w = globalThis as any;
    if (w.__parity?.preamble) await w.__parity.preamble();
    if (w.hideLabels?.checked) {
      w.hideLabels.checked = false;
      w.invokeActiveZooming();
    }
  });
  for (const toggle of toggles) {
    const r = await page.evaluate(t => (globalThis as any).__tupaia.call("display", { on: [t] }), toggle);
    if (!r.ok) problems.push(`toggle ${toggle}: ${JSON.stringify(r).slice(0, 300)}`);
  }
  await settleApp(page);
  return problems;
}

/** App-side quiet: bridge settle, relief/burg renders, trade animation stopped (it moves between screenshots), 2 rAF. */
export const settleApp = (page: Page) =>
  page.evaluate(async () => {
    const w = globalThis as any;
    await w.__tupaia.settle();
    await Promise.all([w.reliefRenderReady, w.burgRenderReady]);
    w.d3.select("#tradeAnimation").selectAll("*").interrupt();
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
  });

/** Waits for jQuery / CSS animations (layer fades) to end; d3 transitions of a layer are covered by `extraMs`. */
export const settleFades = (page: Page, extraMs = 0) =>
  page.evaluate(async extra => {
    const w = globalThis as any;
    const started = performance.now();
    while (performance.now() - started < 4000) {
      const jq = w.jQuery?.(":animated").length ?? 0;
      if (!jq && !document.getAnimations().length) break;
      await new Promise(done => setTimeout(done, 40));
    }
    if (extra) await new Promise(done => setTimeout(done, extra));
  }, extraMs);

export interface GpuWait {
  active: string | null;
  fallbackReason?: string;
  timedOut?: boolean;
  ms: number;
}

/**
 * `refined: false` stops at the first current frame (the D12 "current" reading, where the edit is in the frame);
 * `refined` (default) also waits for the refinement and for motion to end, as the golden does before it captures.
 * The strict "current frame" wait: the GPU renders the current DOM (nothing pending, no refinement, no overlay refresh
 * queued, the source SVG is the document's #map) and its canvas is on screen, or it fell back to SVG. The golden's
 * waitGpu does not look at overlays or sourceCurrent; a toggle or reorder can leave exactly those pending.
 */
export async function waitCurrent(page: Page, timeout = 120000, refined = true): Promise<GpuWait> {
  const started = Date.now();
  let timedOut = false;
  try {
    await page.waitForFunction(
      (needRefined: boolean) => {
        const s = (globalThis as any).rendererStatus?.();
        if (s?.active === "svg" && s?.fallbackReason) return true;
        const g = s?.gpu;
        const c = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
        return !!g && g.state === "active" && !g.pending && !(needRefined && (g.refinementPending || g.moving)) && g.sourceCurrent !== false && !(g.overlays?.pending > 0) && g.canvasVisible && !!c && getComputedStyle(c).display !== "none";
      },
      refined,
      { timeout, polling: 50 }
    );
  } catch {
    timedOut = true;
  }
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const status = await page.evaluate(() => {
    const s = (globalThis as any).rendererStatus?.();
    return { active: s?.active ?? null, fallbackReason: s?.fallbackReason || undefined };
  });
  return { ...status, ms: Date.now() - started, ...(timedOut ? { timedOut } : {}) };
}

export interface Arms {
  gpu: Buffer;
  svg: Buffer;
}

/** GPU arm (canvas shown) then SVG arm (canvas visibility hidden) from one DOM state, at device resolution. */
// The Navigate/Edit pill (gpu page only) animates and changes with the mode; it is chrome, not map, in both arms.
const HIDE_CHROME = "#renderModeIndicator { visibility: hidden !important; }";
export async function captureArms(page: Page): Promise<Arms> {
  const gpu = await page.screenshot({ animations: "disabled", style: HIDE_CHROME });
  const old = await page.evaluate(() => {
    const c = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
    if (!c) return null;
    const value = c.style.visibility;
    c.style.visibility = "hidden";
    return value;
  });
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const svg = await page.screenshot({ animations: "disabled", style: HIDE_CHROME });
  await page.evaluate(value => {
    const c = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
    if (c) c.style.visibility = value || "";
  }, old);
  return { gpu, svg };
}

export const decode = (buffer: Buffer): Rgba => decodePng(buffer);

/** Page function: show only the listed #viewbox children / root overlays (by id), hide the rest; idempotent. */
export function isolateLayers(args: { ids: string[]; bg?: string; restore?: boolean }): { shown: string[]; hidden: number } {
  const page = globalThis as any;
  const svg = document.querySelector<SVGSVGElement>("svg#map");
  const view = svg?.querySelector(":scope > #viewbox");
  if (!svg || !view) throw Error("isolateLayers: svg#map > #viewbox not found");
  const backdrop = svg.parentElement as HTMLElement;
  const state: { saved: Map<Element, string>; bg: [string, string, string, string] | null; applied: string | null } = (page.__censusIsolation ??= { saved: new Map(), bg: null, applied: null });
  const put = (element: Element, value: string) => ((element as SVGElement).style.display = value);
  if (args.restore) {
    for (const [element, value] of state.saved) put(element, value);
    if (state.bg) {
      svg.style.setProperty("background-color", state.bg[0], state.bg[1]);
      backdrop.style.setProperty("background-color", state.bg[2], state.bg[3]);
    }
    delete page.__censusIsolation;
    return { shown: [], hidden: 0 };
  }
  const keep = new Set(args.ids);
  const inert = new Set(["defs", "style", "script", "title", "desc", "metadata"]);
  const wanted = new Set<Element>();
  for (const element of view.children) if (!keep.has(element.id)) wanted.add(element);
  for (const element of svg.children) if (element !== view && !keep.has(element.id) && !inert.has(element.tagName)) wanted.add(element);
  for (const [element, value] of [...state.saved]) {
    if (wanted.has(element)) continue;
    put(element, value);
    state.saved.delete(element);
  }
  for (const element of wanted) {
    if (!state.saved.has(element)) state.saved.set(element, (element as SVGElement).style.display);
    if ((element as SVGElement).style.display !== "none") put(element, "none");
  }
  if (args.bg && state.applied !== args.bg) {
    const read = (el: HTMLElement | SVGElement) => [el.style.getPropertyValue("background-color"), el.style.getPropertyPriority("background-color")];
    state.bg ??= [...read(svg), ...read(backdrop)] as [string, string, string, string];
    svg.style.setProperty("background-color", "transparent", "important");
    backdrop.style.setProperty("background-color", args.bg, "important");
    state.applied = args.bg;
  }
  return { shown: [...keep].filter(id => document.getElementById(id)), hidden: wanted.size };
}

/** Page function: d3 zoom to (k, x, y) (or centred on the map when x and y are absent), then wait for the app. */
export function zoomTo(camera: { k: number; x?: number; y?: number }): Promise<{ k: number; x: number; y: number }> {
  const w = globalThis as any;
  const tx = camera.x ?? 640 - (w.graphWidth * camera.k) / 2;
  const ty = camera.y ?? 360 - (w.graphHeight * camera.k) / 2;
  w.d3.select("#map").call((0, eval)("zoom").transform, w.d3.zoomIdentity.translate(tx, ty).scale(camera.k));
  return (async () => {
    await w.__tupaia.settle();
    await Promise.all([w.reliefRenderReady, w.burgRenderReady]);
    const t = w.d3.zoomTransform(document.getElementById("map"));
    return { k: t.k, x: t.x, y: t.y };
  })();
}

/** Page function: a compact, JSON-safe copy of the renderer telemetry a census check cares about. */
export function gpuProbe(): any {
  const w = globalThis as any;
  const s = w.rendererStatus?.();
  const g = s?.gpu;
  const canvas = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
  const svg = document.querySelector("svg#map") as SVGSVGElement | null;
  const rect = svg?.getBoundingClientRect();
  const cr = canvas?.getBoundingClientRect();
  const lp = g?.lastPrepare;
  return {
    active: s?.active ?? null,
    fallbackReason: s?.fallbackReason || undefined,
    state: g?.state ?? null,
    prepares: g?.prepares ?? 0,
    revision: g?.revision ?? 0,
    invalidations: g?.invalidations?.count ?? 0,
    lastInvalidation: g?.invalidations?.last ?? "",
    neutral: g?.neutralMutations ?? 0,
    frames: g?.frames ?? 0,
    lastPrepareMs: g?.lastPrepareMs ?? null,
    lastPrepare: lp ? { reason: lp.reason, outcome: lp.outcome, hadFrame: lp.hadFrame } : null,
    pending: !!g?.pending,
    refinementPending: !!g?.refinementPending,
    moving: !!g?.moving,
    canvasVisible: !!g?.canvasVisible,
    suspendedReason: g?.suspendedReason ?? "",
    hiddenReason: g?.hiddenReason ?? "",
    sourceCurrent: g?.sourceCurrent !== false,
    overlays: g?.overlays ?? null,
    windows: g?.windows?.coverage ?? null,
    markers: g?.markers ?? 0,
    memory: g?.memory ? { gpu: g.memory.gpu, cpu: g.memory.cpu, peak: g.memory.peak } : null,
    contextLosses: g?.contextLosses ?? 0,
    layers: g?.layers ?? {},
    canvas: canvas
      ? { cssW: canvas.style.width, cssH: canvas.style.height, w: canvas.width, h: canvas.height, display: getComputedStyle(canvas).display, visibility: getComputedStyle(canvas).visibility, left: cr?.left, top: cr?.top, rectW: cr?.width, rectH: cr?.height }
      : null,
    svg: rect ? { w: rect.width, h: rect.height, left: rect.left, top: rect.top } : null,
    dpr: window.devicePixelRatio,
    inner: [innerWidth, innerHeight]
  };
}

/** Page function: draws counted for a layer element id under #viewbox (or the root): visible drawable descendants. */
export function layerFacts(args: { id: string; root?: boolean }): any {
  const w = globalThis as any;
  const svg = document.querySelector("svg#map")!;
  const parent = args.root ? svg : svg.querySelector("#viewbox")!;
  const target = parent.querySelector(`:scope > #${CSS.escape(args.id)}`) as SVGElement | null;
  if (!target) return { present: false };
  const style = getComputedStyle(target);
  let drawables = 0;
  let any = 0;
  for (const e of target.querySelectorAll("path,polygon,polyline,rect,circle,ellipse,line,text,use,image")) {
    any++;
    if ((e as any).checkVisibility ? (e as any).checkVisibility({ visibilityProperty: true }) : true) drawables++;
  }
  const status = w.rendererStatus?.();
  const layer = status?.gpu?.layers?.[args.id] ?? null;
  let compatRunElements = 0;
  const runs = w.gpuRenderer?.prepared?.runs;
  for (const run of Array.isArray(runs) ? runs : []) for (const e of run.elements ?? []) if (e === target || target.contains(e)) compatRunElements++;
  return {
    present: true,
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    children: any,
    drawables,
    layer: layer ? { native: layer.native ?? 0, compat: layer.compat ?? 0 } : null,
    compatRunElements,
    runsReadable: Array.isArray(runs)
  };
}

export interface CheckLike {
  id: string;
  row: string;
  status: "PASS" | "FAIL" | "INFO" | "SKIP";
  detail: string;
  evidence?: string;
}

export function writeJson(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}
