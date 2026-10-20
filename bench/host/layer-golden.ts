// Per-layer golden (G-C, PROOF-PLAN §4; decisions D1 and D5 in PHASE1-PLAN.md). Run it through bench/gate/gate.ts
// (`gate golden ...`), which takes a shared host-lock slot and sets GATE_OUT_DIR (evidence directory).
//
// For every (style preset, dpr, layer family, k) cell it renders ONE build of dist/ with only that family visible
// (golden-isolation.ts) and captures, from the same DOM state, the GPU arm (canvas shown) and the SVG arm (canvas
// hidden) at device resolution. SVG is the reference, GPU the candidate: a check never compares GPU with GPU. It then
// computes SSIM, over16, over44, the changed fraction and the D11 per-layer coverage (golden-metrics.ts), writes both
// PNGs plus a diff heatmap,
// and records the layer census: what the GPU scene classifier routed native / compat / skipped for the family
// (rendererStatus().gpu.layers plus the opt-in src/gpu/scene-census.ts sink). A family that paints nothing in either
// arm fails. An optional census expectations file turns a silent routing change into a failure.
//
// Environment (all optional; gate.ts maps its arguments onto these):
//   GOLDEN_MAP       .map fixture to load (default GATE_MAP)
//   GOLDEN_LAYERS    "all" or comma list of families (golden-families.ts)       default all
//   GOLDEN_K         comma list of zoom factors                                  default 1,4
//   GOLDEN_COAST_K   extra zooms for the coastline families (landmass, lakes, coastline)   default none
//   GOLDEN_DPR       comma list of device pixel ratios                           default 2
//   GOLDEN_PRESET    "map" (keep the fixture's style), "all" or comma list       default default
//   GOLDEN_BG        backdrop #rrggbb                                            default #ffffff
//   GOLDEN_READING   over44 | conservative (which "≤0.5 % at Δ≤44" reading gates; D11)  default over44
//                    Coverage (the layer's own ink, COVERAGE in golden-metrics.ts) gates under both readings.
//   GOLDEN_KEEP      all | fail: keep PNGs for every cell or only failing ones   default all
//   GOLDEN_CENSUS    census expectations JSON (same shape as the census.json this writes)
//   GOLDEN_BREAK     self-test only, breaks the GPU arm after its frame is drawn (the SVG arm is untouched):
//                      none | drop-batch: drops the bottom-most fill/stroke batch (a dropped path)
//                      thin-stroke: halves the width of every stroke batch (thinner strokes)
//                      drop-icon: drops every 4th leaf draw batch and a quarter of sprite instances (dropped icons)
//   GOLDEN_GPU_ARM   how the GPU arm is captured                                     default canvas
//                      canvas: the canvas alone, over an opaque cover of the backdrop colour slipped between svg#map
//                        and the canvas, so the SVG underneath can never count as GPU output
//                      composite: the canvas over the live SVG (the pre-W2 capture; diagnosis only)
//                      probe: canvas (judged) plus the composite and the canvas over a magenta cover; any pixel that
//                        differs between them is the SVG or the cover showing through the canvas, and fails the cell
//   GOLDEN_SVG_REF  auto | vector | seen: what the SVG arm is for a family whose SVG display is a perf bitmap of its own
//                    vectors (the burg icons, burg-canvas.ts; the cell mesh, cell-mesh-canvas.ts)       default auto
//                      seen: the bitmap as the app displays it (the pre-W3 reference)
//                      vector: the same SVG with the bitmap swapped back for its vectors, taken after the GPU arm
//                      auto: per family, whichever the GPU is built to reproduce (DENSE below): vector for the burgs
//                        (the GPU draws the restored vectors on purpose), seen for the cell mesh (the GPU keeps the
//                        displayed asset on purpose, scene.ts). The other reference is always measured and reported.
//   GOLDEN_SETTLE_MS the SVG arm is shot until two consecutive shots this far apart agree to within 64 px (default 400; 0
//                    = one shot), so a reference that is still changing (a lazy raster, a refinement) is waited out or
//                    fails as a harness error.
//   GOLDEN_PRECOA    1 (default): render every emblem COA symbol before the first capture. 0: leave them lazy, as the app
//                    does, so the cell catches the GPU/lazy-COA race (see `coa-race` in gate.ts golden-selftest).
//   GOLDEN_COA_LATE  1: for the emblems family, the COA symbols arrive AFTER the GPU prepared, the lazy-COA race made
//                    deterministic. The app inserts each symbol into #coas (svg#defElements, outside svg#map) only after
//                    fetching its charges, so a prepare can precede it. Per cell: #coas is emptied, a revision inside
//                    svg#map forces a prepare (the frame is built, refined and current WITHOUT the emblems), then the
//                    symbols are put back. A renderer that follows #coas re-prepares and the cell passes; one that does
//                    not keeps the empty frame and the cell fails the D11 coverage gate. Implies GOLDEN_PRECOA=0 for
//                    the cell. Used by `gate coa-race`.
//   GOLDEN_PARAMS    extra gpu-* URL flags for the page, "+"-joined (e.g. gpu-native-shapes=1)  default none
//   GOLDEN_CAMERAS   fixture | centered: which camera frames a cell. "fixture" (default when GOLDEN_MAP is the parity
//                    fixture) uses the manifest's recorded presets; "centered" centres the whole map at k
//
// With the parity fixture (tests/fixtures/parity, bench/host/fixtures/README.md) the runner also injects the fixture's
// page script before the first frame and runs `__parity.preamble()` after loading (cells layer, #debug content, the
// Rendering select), turns the app's hideLabels rule off (it hides every label above k ~6, which would empty the k 8
// label goldens), and frames each family with the camera preset that covers it. A family with several covering
// presets (zones: three hatch sets at k 4) yields one cell per preset: the first keeps the plain key, the others get
// "@<camera id>" appended.
// Output in GATE_OUT_DIR: golden.json (report; `failure` is null on a pass), census.json, cells/<preset>/d<dpr>/*.png.
// Exit 0 when a report was written (verdicts are in it), 1 on a harness error.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, relative, resolve } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright";
import { type CensusCounts, type CellMetrics, COVERAGE, DEFAULT_READING, heatmap, judgeCell, measureCell, type Reading } from "../golden-metrics.ts";
import { decodePng, encodePng } from "../png.ts";
import { type Family, parsePresets, parseZooms, selectFamilies } from "./golden-families.ts";
import { isolateLayer } from "./golden-isolation.ts";
import { type CameraPreset, COVERS_BY_FAMILY, resolveFixture } from "./fixtures/index.ts";

const env = process.env;
const root = resolve(import.meta.dirname, "../..");
const dist = resolve(root, "dist");
const outDir = resolve(env.GATE_OUT_DIR || process.cwd());
const mapPath = resolve(env.GOLDEN_MAP || env.GATE_MAP || "/tmp/tupaia-navigation-shared-v8.map");
const families = selectFamilies(env.GOLDEN_LAYERS || "all");
const zooms = parseZooms(env.GOLDEN_K || "1,4");
const coastZooms = parseZooms(env.GOLDEN_COAST_K || "");
const dprs = parseZooms(env.GOLDEN_DPR || "2");
const presets = parsePresets(env.GOLDEN_PRESET || "default");
const bg = env.GOLDEN_BG || "#ffffff";
const reading = (env.GOLDEN_READING || DEFAULT_READING) as Reading;
const keep = env.GOLDEN_KEEP || "all";
const breakMode = env.GOLDEN_BREAK || "none";
const gpuArm = env.GOLDEN_GPU_ARM || "canvas";
const svgRefArg = env.GOLDEN_SVG_REF || "auto";
const settleMs = Number(env.GOLDEN_SETTLE_MS ?? 400);
const coaLate = env.GOLDEN_COA_LATE === "1";
const preCoa = (env.GOLDEN_PRECOA ?? "1") !== "0" && !coaLate;
if (!["auto", "vector", "seen"].includes(svgRefArg)) throw Error("GOLDEN_SVG_REF must be auto|vector|seen");
if (!Number.isFinite(settleMs) || settleMs < 0) throw Error("GOLDEN_SETTLE_MS must be a number of ms >= 0");
const urlParams = (env.GOLDEN_PARAMS || "").split("+").filter(Boolean);
if (urlParams.some(kv => !/^gpu-[a-z0-9-]+=[\w.-]*$/.test(kv))) throw Error("GOLDEN_PARAMS entries must be gpu-<flag>=<value>");
if (!/^#[\da-f]{6}$/i.test(bg)) throw Error(`GOLDEN_BG must be #rrggbb, got ${bg}`);
if (!["over44", "conservative"].includes(reading)) throw Error(`GOLDEN_READING must be conservative|over44`);
if (!["all", "fail"].includes(keep)) throw Error(`GOLDEN_KEEP must be all|fail`);
if (!["none", "drop-batch", "thin-stroke", "drop-icon"].includes(breakMode)) throw Error(`GOLDEN_BREAK must be none|drop-batch|thin-stroke|drop-icon`);
if (!["canvas", "composite", "probe"].includes(gpuArm)) throw Error(`GOLDEN_GPU_ARM must be canvas|composite|probe`);
if (dprs.some(d => d !== 1 && d !== 2)) throw Error("GOLDEN_DPR must be 1 and/or 2");
if (!zooms.length) throw Error("GOLDEN_K is empty");

const mapText = readFileSync(mapPath, "utf8");
const mapSha = createHash("sha256").update(readFileSync(mapPath)).digest("hex");
// The parity fixture is recognised by content (sha256 of the file), whichever path the gate resolved it to.
const parity = (() => {
  try {
    const fx = resolveFixture("parity");
    return fx.sha256 === mapSha ? fx : null;
  } catch {
    return null;
  }
})();
const cameraMode = env.GOLDEN_CAMERAS || (parity ? "fixture" : "centered");
if (!["fixture", "centered"].includes(cameraMode)) throw Error("GOLDEN_CAMERAS must be fixture|centered");
if (cameraMode === "fixture" && !parity) throw Error("GOLDEN_CAMERAS=fixture needs the parity fixture as GOLDEN_MAP");
const expectations = env.GOLDEN_CENSUS ? JSON.parse(readFileSync(env.GOLDEN_CENSUS, "utf8")) : null;
const zoomsFor = (family: Family) => [...new Set([...zooms, ...(family.coast ? coastZooms : [])])].sort((a, b) => a - b);

// ------------------------------------------------------------------ cameras

interface Camera {
  id: string;
  k: number;
  x?: number; // d3 zoom translate; absent = centre the whole map (graphWidth x graphHeight) at k
  y?: number;
}
// What the manifest's camera `covers` tags say about a family (shared with build-parity-fixture.ts --verify).
const COVERS = COVERS_BY_FAMILY;
const fmtId = (k: number) => String(k).replace(".", "p");
// d3 zoom that centres the whole map at k (the pre-parity framing, and the one for any k without a preset)
const centered = (k: number): Camera => ({ id: `centered-k${fmtId(k)}`, k });
const toCamera = (c: CameraPreset): Camera => ({ id: c.id, k: c.k, x: c.x, y: c.y });
function camerasFor(family: Family, k: number): Camera[] {
  if (cameraMode === "centered" || !parity?.cameras || !parity.manifest) return [centered(k)];
  const pool = [...parity.cameras, ...parity.manifest.coastlineSwitch];
  const atK = pool.filter(c => c.k === k);
  const covering = atK.filter(c => c.covers.some(t => (COVERS[family.name] ?? []).includes(t)));
  if (covering.length) return covering.map(toCamera);
  // the world view at k 1, the showcase at k > 1, the coastline frame for the odd coast zooms; else centred
  const fallback = atK.find(c => c.id === (k === 1 ? "k1-world" : `k${fmtId(k)}-showcase`)) ?? atK.find(c => c.covers.includes("coastline-filter"));
  return [fallback ? toCamera(fallback) : centered(k)];
}
// Work list: one entry per camera, in zoom order, with the (family, plain-key?) pairs captured there.
const plan = (() => {
  const byCamera = new Map<string, { camera: Camera; items: { family: Family; first: boolean }[] }>();
  for (const family of families)
    for (const k of zoomsFor(family))
      camerasFor(family, k).forEach((camera, index) => {
        const slot = byCamera.get(camera.id) ?? { camera, items: [] };
        slot.items.push({ family, first: index === 0 });
        byCamera.set(camera.id, slot);
      });
  return [...byCamera.values()].sort((a, b) => a.camera.k - b.camera.k || a.camera.id.localeCompare(b.camera.id));
})();

interface Cell {
  key: string;
  preset: string;
  dpr: number;
  family: string;
  id: string;
  k: number;
  camera?: string;
  pass: boolean;
  // pass | coverage (fails only the D11 coverage gate) | gap (a whole-frame gate: SSIM, over16, the reading's third
  // clause) | empty | census (routing drift only) | harness
  class?: string;
  failures: string[];
  notes?: string[];
  gates?: Record<string, boolean>;
  metrics?: CellMetrics;
  census?: CensusCounts | null;
  expected?: CensusCounts | null;
  censusKinds?: Record<string, number> | null;
  compatRunElements?: number;
  domDrawables?: number;
  renderer?: { active: string; fallbackReason?: string; layers?: unknown };
  dropped?: unknown;
  // GPU_ARM=probe: pixels where the composite or the canvas-over-magenta capture differs from the canvas-only one
  showThrough?: { composite: number; magenta: number } | null;
  // emblem COA symbols that were still missing when the cell was captured (async renderGroupCOAs)
  pendingCoas?: number;
  images?: Record<string, string>;
  seconds?: number;
  // SVG-arm reference: "svg" (the SVG as shown, no dense bitmap), "vector" (a dense bitmap swapped back for its vectors;
  // see DENSE) or "seen" (the dense bitmap as shown). otherRef is the verdict against the other reference, bitmapVsVector how
  // far the shown bitmap is from its vectors; both are info only.
  svgRef?: string;
  // GOLDEN_COA_LATE: the symbols were held back until the GPU frame was built, then returned
  coaLate?: { symbols: number; preparesBefore: number; preparesAfter: number; reprepared: boolean };
  svgShots?: number;
  svgVector?: { bitmaps: number };
  otherRef?: { ref: string; pass: boolean; failures: string[]; ssim: number; over16Fraction: number; over44Fraction: number; inkSvg: number; inkGpu: number; inkRatio: number; over16OfInk: number };
  bitmapVsVector?: { ssim: number; over16OfInk: number; inkBitmap: number; inkVector: number };
}

const report = {
  schema: 1,
  runStartedUtc: new Date().toISOString(),
  fixture: { path: mapPath, sha256: mapSha },
  args: { layers: families.map(f => f.name), svgRef: svgRefArg, settleMs, preCoa, coaLate, k: zooms, coastk: coastZooms, dpr: dprs, preset: presets, bg, reading, keep, break: breakMode, gpuArm, params: urlParams, cameras: cameraMode, parity: !!parity },
  coverage: COVERAGE,
  census: env.GOLDEN_CENSUS || null,
  diagnosticBreak: breakMode !== "none" ? `${breakMode}: the GPU arm is deliberately broken; this run is expected to FAIL` : null,
  errors: [] as string[],
  warnings: [] as string[],
  // requests the route allowlist aborted (they log "Failed to load resource: net::ERR_FAILED" in the console)
  aborted: [] as string[],
  failure: null as string | null,
  summary: null as unknown,
  cells: [] as Cell[]
};
const census: { schema: number; fixtureSha256: string; cells: Record<string, CensusCounts & { kinds?: Record<string, number> | null }> } = {
  schema: 1,
  fixtureSha256: mapSha,
  cells: {}
};

const log = (message: string) => console.log(`[golden] ${message}`);
const write = () => {
  writeFileSync(join(outDir, "golden.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, "census.json"), `${JSON.stringify(census, null, 2)}\n`);
};

// ------------------------------------------------------------------ static server for dist/

const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json" };
const server = createServer((request, response) => {
  const path = resolve(dist, `.${new URL(request.url || "/", "http://localhost").pathname}`);
  if (!path.startsWith(`${dist}/`) && path !== dist) return void response.writeHead(403).end();
  try {
    const file = path === dist ? resolve(dist, "index.html") : path;
    response.setHeader("content-type", mime[extname(file)] || "application/octet-stream");
    response.end(readFileSync(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (!address || typeof address === "string") throw Error("no server address");
const origin = `http://127.0.0.1:${address.port}`;

// ------------------------------------------------------------------ page helpers

async function openContext(dpr: number): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: dpr, serviceWorkers: "block" });
  await context.addInitScript(() => {
    localStorage.setItem("autosaveInterval", "0");
    localStorage.setItem("azgaarAssistant", "hide");
    (globalThis as any).__gpuSceneCensus = {}; // opt-in census sink read by src/gpu/scene-census.ts
  });
  const scripts = ["bridge.js", "bridge-mutations.js", ...readdirSync(resolve(root, "mcp/src/bridge-ext")).filter(n => n.endsWith(".js")).sort().map(n => `bridge-ext/${n}`)];
  await context.addInitScript(scripts.map(n => readFileSync(resolve(root, "mcp/src", n), "utf8")).join("\n"));
  if (parity?.pageScript) await context.addInitScript(parity.pageScript); // __parity.preamble / census, before the first frame
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || (route.request().method() === "GET" && url.hostname === "fonts.gstatic.com")) return route.continue();
    const what = `${route.request().method()} ${route.request().resourceType()} ${url.href.slice(0, 200)}`;
    if (!report.aborted.includes(what) && report.aborted.length < 40) report.aborted.push(what);
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  page.on("pageerror", e => report.errors.push(e.message));
  page.on("console", m => {
    if (["warning", "error"].includes(m.type()) && report.warnings.length < 80) report.warnings.push(m.text().slice(0, 1000));
  });
  page.on("dialog", d => d.dismiss());
  await page.goto(`${origin}/?local&seed=7319&width=1280&height=720&renderer=gpu${urlParams.map(kv => `&${kv}`).join("")}`);
  await page.evaluate(async () => {
    const ready = await (globalThis as any).__tupaia.call("ready", { timeoutMs: 120000 });
    if (!ready.ok) throw Error(JSON.stringify(ready));
  });
  // Page chrome whose state changes on its own timer is hidden for the whole run (both arms alike), before any capture:
  //   - the bottom tip bar ("Map is successfully loaded", cleared a few seconds later): a GPU blank captured while it
  //     showed and an SVG blank after it cleared differed by ~77K px of "ink";
  //   - the Navigate/Edit indicator (src/controllers/render-mode.ts), which can still read "Updating" for a moment after
  //     the renderer reports a current frame: 2.5K px between two captures of one frame (GPU_ARM=probe).
  await page.addStyleTag({ content: "#tooltip, #renderModeIndicator { visibility: hidden !important; }" });
  return { context, page };
}

const settleApp = (page: Page) =>
  page.evaluate(async () => {
    const w = globalThis as any;
    await w.__tupaia.settle();
    await Promise.all([w.reliefRenderReady, w.burgRenderReady]);
    w.d3.select("#tradeAnimation").selectAll("*").interrupt();
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
  });

async function loadFixture(page: Page, preset: string, toggles: string[]): Promise<string[]> {
  const problems: string[] = [];
  // The Navigate/Edit indicator (gpu arm only; its text changes with the renderer state: "Updating" vs "Navigate") is page chrome, not a layer: left visible it
  // shows up as ~2.5k px of ink in whichever cell catches it mid-change.
  await page.addStyleTag({ content: "#renderModeIndicator { visibility: hidden !important; }" });
  await page.evaluate(async text => {
    const w = globalThis as any;
    await w.__tupaia.fns.loadMap({ text, timeoutMs: 120000 });
    // The "Map is successfully loaded" toast (7 s, bottom of the frame) otherwise lands in whichever arm of the first cell is captured inside that window.
    w.clearMainTip?.();
    await w.__tupaia.settle();
  }, mapText);
  if (preset !== "map") {
    const r = await page.evaluate(p => (globalThis as any).__tupaia.call("display", { stylePreset: p }), preset);
    if (!r.ok) problems.push(`stylePreset ${preset}: ${JSON.stringify(r).slice(0, 300)}`);
  }
  if (parity) {
    // what the file does not carry (cells layer, #debug content, Rendering select), then labels at every zoom
    const did = await page.evaluate(async () => {
      const w = globalThis as any;
      const did: string[] = await w.__parity.preamble();
      if (w.hideLabels.checked) {
        w.hideLabels.checked = false;
        w.invokeActiveZooming();
        did.push("hideLabels-off");
      }
      return did;
    });
    log(`parity preamble: ${did.join(", ") || "nothing to do"}`);
  }
  for (const toggle of toggles) {
    const r = await page.evaluate(t => (globalThis as any).__tupaia.call("display", { on: [t] }), toggle);
    if (!r.ok) problems.push(`toggle ${toggle}: ${JSON.stringify(r).slice(0, 300)}`);
  }
  // Render every emblem's COA symbol now, before any capture. The app renders a group's COAs lazily when zoom styling
  // first shows it, inserting each symbol into #coas (in svg#defElements, outside svg#map) after fetching its charges.
  // The GPU renderer does not observe #coas (only the opt-in compat reuse does), so a prepare that races those
  // fetches keeps a raster with the emblems missing (seen ad hoc: emblems k 4 GPU ink 79K vs SVG 173K px). That race
  // is a renderer finding, not something a parity cell should measure by luck; with the symbols in place first, zoom
  // styling only flips group classes, which the renderer does observe. GOLDEN_PRECOA=0 skips this on purpose: it is the
  // `coa-race` self-test arm, which must FAIL while the renderer misses a symbol arriving in #coas after its prepare.
  const coas = !preCoa ? null : await page.evaluate(async () => {
    const w = globalThis as any;
    if (!w.COArenderer || !w.renderGroupCOAs) return "no COA renderer";
    for (const g of document.querySelectorAll<SVGGElement>("svg#map #emblems > g"))
      if (g.children.length && !g.children[0].getAttribute("href")) await w.renderGroupCOAs(g);
    const missing = () =>
      [...document.querySelectorAll("svg#map #emblems use")].filter(use => {
        const href = use.getAttribute("href") ?? "";
        return !href.startsWith("#") || !document.getElementById(href.slice(1));
      }).length;
    const deadline = performance.now() + 30000;
    while (missing() && performance.now() < deadline) await new Promise(done => setTimeout(done, 50));
    return missing() ? `${missing()} emblem COA symbol(s) missing after 30 s` : null;
  });
  if (coas) problems.push(`emblems: ${coas}`);
  await settleApp(page);
  return problems;
}

const zoomTo = (page: Page, camera: Camera) =>
  page.evaluate(async ({ k, x, y }) => {
    const w = globalThis as any;
    const tx = x ?? 640 - (w.graphWidth * k) / 2;
    const ty = y ?? 360 - (w.graphHeight * k) / 2;
    w.d3.select("#map").call((0, eval)("zoom").transform, w.d3.zoomIdentity.translate(tx, ty).scale(k));
    await w.__tupaia.settle();
    await Promise.all([w.reliefRenderReady, w.burgRenderReady]);
  }, camera);

// The app's zoom styling (updateZoomStyling: label sizes, emblem group visibility and the COAs it renders lazily, ruler
// sizes) only touches layers that are visible when the camera moves, and isolation had the next family hidden then:
// the W1-merge sweep caught emblems at k 4 still in their k 1 state (burg and province groups hidden, ink 0 in both
// arms). So with the family shown, run it again as the app does after every zoom, then wait for the COA symbols it
// asked for (renderGroupCOAs sets each href at once and inserts the symbol into #coas after fetching its charges).
// Returns the visible emblem <use>s whose symbol is still missing after 20 s (0 when settled).
const applyZoomStyling = (page: Page) =>
  page.evaluate(async () => {
    const w = globalThis as any;
    w.invokeActiveZooming?.();
    // checkVisibility() is not reliable for SVG content here (it reported uses inside display:none groups as visible)
    const shown = (element: Element) => {
      for (let node: Element | null = element; node && node.id !== "map"; node = node.parentElement) if (getComputedStyle(node).display === "none") return false;
      return getComputedStyle(element).visibility === "visible";
    };
    const missing = () =>
      [...document.querySelectorAll("svg#map #emblems use")].filter(use => {
        if (!shown(use)) return false;
        const href = use.getAttribute("href") ?? use.getAttribute("xlink:href") ?? "";
        return !href.startsWith("#") || !document.getElementById(href.slice(1));
      }).length;
    const deadline = performance.now() + 20000;
    while (missing() && performance.now() < deadline) await new Promise(done => setTimeout(done, 50));
    return missing();
  });

// Waits for a GPU frame of the current DOM revision, drawn and refined, or for a fallback. Returns the status.
async function waitGpu(page: Page): Promise<{ active: string; fallbackReason?: string; timedOut?: boolean }> {
  let timedOut = false;
  try {
    await page.waitForFunction(
      () => {
        const s = (globalThis as any).rendererStatus?.();
        const c = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
        if (s?.active === "svg" && s?.fallbackReason) return true;
        const g = s?.gpu;
        return g?.state === "active" && !g.pending && !g.refinementPending && g.canvasVisible && !!c && getComputedStyle(c).display !== "none";
      },
      {},
      { timeout: 60000, polling: 50 }
    );
  } catch {
    timedOut = true;
  }
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const status = await page.evaluate(() => {
    const s = (globalThis as any).rendererStatus?.();
    return { active: s?.active, fallbackReason: s?.fallbackReason || undefined };
  });
  return timedOut ? { ...status, timedOut } : status;
}

// GOLDEN_COA_LATE (see the header): build the GPU frame with #coas empty, then bring the symbols back. Returns what
// happened; `reprepared` is whether the renderer prepared again within 5 s of the symbols arriving.
const gpuPrepares = (page: Page) => page.evaluate(() => (globalThis as any).rendererStatus?.()?.gpu?.prepares ?? -1);
async function lateCoas(page: Page): Promise<{ symbols: number; preparesBefore: number; preparesAfter: number; reprepared: boolean }> {
  const symbols = await page.evaluate(() => {
    const w = globalThis as any;
    const coas = document.getElementById("coas");
    if (!coas) return -1;
    w.__goldenCoas = [...coas.childNodes];
    coas.replaceChildren();
    // a revision inside svg#map: the renderer prepares now, against a #coas without symbols
    document.querySelector("svg#map #emblems")?.setAttribute("data-golden-coa-late", String(Date.now()));
    return w.__goldenCoas.length;
  });
  if (symbols <= 0) throw Error(symbols < 0 ? "GOLDEN_COA_LATE: no #coas" : "GOLDEN_COA_LATE: #coas holds no symbols to hold back");
  const start = await gpuPrepares(page);
  await page.waitForFunction(n => ((globalThis as any).rendererStatus?.()?.gpu?.prepares ?? -1) > n, start - 1, { timeout: 20000, polling: 50 }).catch(() => {});
  await waitGpu(page); // the frame as it stands without the symbols: current and refined
  const preparesBefore = await gpuPrepares(page);
  await page.evaluate(() => {
    const w = globalThis as any;
    document.getElementById("coas")!.append(...w.__goldenCoas);
    delete w.__goldenCoas;
  });
  const reprepared = await page
    .waitForFunction(n => ((globalThis as any).rendererStatus?.()?.gpu?.prepares ?? -1) > n, preparesBefore, { timeout: 5000, polling: 50 })
    .then(() => true, () => false);
  await waitGpu(page);
  return { symbols, preparesBefore, preparesAfter: await gpuPrepares(page), reprepared };
}

// Self-test only: breaks the GPU frame in place and redraws. SVG is untouched. Each mode reports what it changed; a
// mode that changed nothing makes the cell fail as a harness error (a no-op break would make the self-test vacuous).
//   drop-batch:  removes the bottom-most fill/stroke batch (for ocean that is the opaque #oceanBase fill; the largest
//                batch by count is a poor pick: ocean's is a faint depth ring whose loss stays under one code value)
//   thin-stroke: halves the width of every stroke batch, including inside groups (thinner borders, rivers, routes)
//   drop-icon:   drops every 4th leaf draw batch (fill, stroke, sprites, glyphs; the icons and small shapes the renderer
//                draws separately, e.g. goods and zones) and the last quarter of every sprite batch's instances
const breakFrame = (page: Page, mode: string) =>
  page.evaluate(async mode => {
    const r = (globalThis as any).gpuRenderer;
    const batches: any[] | undefined = r?.prepared?.frame?.batches;
    if (!batches?.length) return { dropped: null, changed: 0, total: 0 };
    const frames = () => (globalThis as any).rendererStatus?.()?.gpu?.frames ?? null;
    const before = frames();
    const all: any[] = [];
    const walk = (list: any[]) => {
      for (const b of list) {
        all.push(b);
        if (b.kind === "group" && Array.isArray(b.children)) walk(b.children);
      }
    };
    walk(batches);
    let dropped: unknown = null;
    let changed = 0;
    if (mode === "drop-batch") {
      let index = batches.findIndex(b => b.kind === "fill" || b.kind === "stroke");
      if (index < 0) index = 0;
      const [gone] = batches.splice(index, 1);
      dropped = { index, kind: gone.kind, count: gone.count ?? null };
      changed = 1;
    } else if (mode === "thin-stroke") {
      for (const b of all)
        if (b.kind === "stroke" && b.width > 0) {
          b.width *= 0.5;
          changed++;
        }
      dropped = changed ? { strokes: changed } : null;
    } else if (mode === "drop-icon") {
      // every 4th leaf draw (fill, stroke, sprites, glyphs) in frame order, groups included: the icons and small
      // shapes the renderer draws as separate batches; then the last quarter of each sprite batch's instances
      const leaves = ["fill", "stroke", "sprites", "glyphs"];
      const drop = new Set(all.filter(b => leaves.includes(b.kind)).filter((_, i) => i % 4 === 3));
      const prune = (list: any[]) => {
        for (let i = list.length - 1; i >= 0; i--) {
          if (drop.has(list[i])) list.splice(i, 1);
          else if (list[i].kind === "group" && Array.isArray(list[i].children)) prune(list[i].children);
        }
      };
      prune(batches);
      let instances = 0;
      for (const b of all)
        if (b.kind === "sprites" && !drop.has(b) && b.count > 1) {
          const keep = Math.ceil(b.count * 0.75);
          instances += b.count - keep;
          b.count = keep;
        }
      changed = drop.size + (instances ? 1 : 0);
      dropped = changed ? { batchesDropped: drop.size, of: all.filter(b => leaves.includes(b.kind)).length, spriteInstancesDropped: instances } : null;
    }
    r.requestDraw();
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    return {
      dropped,
      changed,
      total: all.length,
      kinds: all.map((b: any) => `${b.kind}:${b.count ?? "-"}`).slice(0, 60),
      framesDrawn: (frames() ?? 0) - (before ?? 0)
    };
  }, mode);

const readCensus = (page: Page, family: Family) =>
  page.evaluate(
    ({ id, root }) => {
      const w = globalThis as any;
      const svg = document.querySelector("svg#map")!;
      const target = (root ? svg : svg.querySelector("#viewbox")!).querySelector(`:scope > #${CSS.escape(id)}`);
      const status = w.rendererStatus?.();
      const layer = status?.gpu?.layers?.[id] ?? null;
      const sink = w.__gpuSceneCensus?.last?.layers?.[id] ?? null;
      let compatRunElements = 0;
      // gpuRenderer.prepared is renderer-internal: if its shape changes, say so instead of counting 0
      const runs = w.gpuRenderer?.prepared?.runs;
      const runsReadable = Array.isArray(runs);
      for (const run of runsReadable ? runs : []) for (const e of run.elements ?? []) if (target && (e === target || target.contains(e))) compatRunElements++;
      let domDrawables = 0;
      // computed display along the ancestry (checkVisibility() reported uses inside display:none groups as visible)
      const hidden = new Map<Element, boolean>();
      const displayed = (node: Element | null): boolean => {
        if (!node || node === target) return !!node && getComputedStyle(node).display !== "none";
        let v = hidden.get(node);
        if (v === undefined) hidden.set(node, (v = getComputedStyle(node).display !== "none" && displayed(node.parentElement)));
        return v;
      };
      if (target)
        for (const e of target.querySelectorAll("path,polygon,polyline,rect,circle,ellipse,line,text,use,image"))
          if (displayed(e) && getComputedStyle(e).visibility === "visible") domDrawables++;
      return { layer, sink, compatRunElements, runsReadable, domDrawables, build: w.__gpuSceneCensus?.last?.build ?? null };
    },
    { id: family.id, root: !!family.root }
  );

const twoFrames = (page: Page) => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
const gpuStamp = (page: Page) =>
  page.evaluate(() => {
    const g = (globalThis as any).rendererStatus?.()?.gpu;
    return g ? `${g.prepares}/${g.revision}/${g.canvasVisible}` : "none";
  });
// An opaque cover slipped between svg#map and the GPU canvas (same rect as the canvas, below it in paint order). It is
// outside svg#map, so the renderer's observer does not see it and nothing is re-prepared; null removes it.
const setCover = (page: Page, colour: string | null) =>
  page.evaluate(colour => {
    const canvas = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
    let div = document.getElementById("__goldenCover");
    if (!colour) return void div?.remove();
    if (!canvas) throw Error("no GPU canvas to cover under");
    if (!div) {
      div = document.createElement("div");
      div.id = "__goldenCover";
    }
    if (div.nextElementSibling !== canvas) canvas.before(div);
    const rect = canvas.getBoundingClientRect();
    Object.assign(div.style, {
      position: "fixed",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      background: colour,
      pointerEvents: "none"
    });
  }, colour);
const countDiff = (a: Buffer, b: Buffer) => {
  const x = decodePng(a);
  const y = decodePng(b);
  let n = 0;
  for (let i = 0; i < x.data.length; i += 4) if (x.data[i] !== y.data[i] || x.data[i + 1] !== y.data[i + 1] || x.data[i + 2] !== y.data[i + 2]) n++;
  return n;
};

// The GPU arm (see GOLDEN_GPU_ARM), then the SVG arm (canvas hidden), from one DOM state. A GPU re-prepare between
// the shots would mean the arms are not the same frame, so it is an error.
async function captureArms(page: Page): Promise<{ gpu: Buffer; svg: Buffer; svgShots: number; svgSettled: boolean; showThrough: { composite: number; magenta: number } | null; probe: Record<string, Buffer> }> {
  const stamp = await gpuStamp(page);
  let gpu: Buffer;
  let showThrough: { composite: number; magenta: number } | null = null;
  let probe: Record<string, Buffer> = {};
  if (gpuArm === "composite") gpu = await page.screenshot({ animations: "disabled" });
  else {
    const composite = gpuArm === "probe" ? await page.screenshot({ animations: "disabled" }) : null;
    let magenta: Buffer | null = null;
    try {
      if (composite) {
        await setCover(page, "#ff00ff");
        await twoFrames(page);
        magenta = await page.screenshot({ animations: "disabled" });
      }
      await setCover(page, bg);
      await twoFrames(page);
      gpu = await page.screenshot({ animations: "disabled" });
    } finally {
      await setCover(page, null);
    }
    if (composite && magenta) {
      showThrough = { composite: countDiff(composite, gpu), magenta: countDiff(magenta, gpu) };
      probe = { composite, magenta };
    }
  }
  const old = await hideCanvas(page);
  await twoFrames(page);
  const settle = await shootSvg(page);
  await showCanvas(page, old);
  const after = await gpuStamp(page);
  if (after !== stamp) throw Error(`GPU frame changed while the arms were captured (prepares/revision/visible ${stamp} → ${after})`);
  return { gpu, svg: settle.png, svgShots: settle.shots, svgSettled: settle.settled, svgMoving: settle.moving, showThrough, probe };
}

const hideCanvas = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
    if (!c) return null;
    const value = c.style.visibility;
    c.style.visibility = "hidden";
    return value;
  });
const showCanvas = (page: Page, value: string | null) =>
  page.evaluate(value => {
    const c = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
    if (c) c.style.visibility = value || "";
  }, value);

// One SVG-arm shot (the canvas must be hidden already) that waits for the reference to hold still: shots GOLDEN_SETTLE_MS
// apart repeat until two in a row differ by at most SETTLE_NOISE_PX pixels (at most 6 shots). Chromium's own raster is
// not bit-stable shot to shot: 9 px of one emblem frame flickered between identical-DOM shots (measured), so exact
// equality would fail good cells. A reference still changing after that (a lazy raster, a refinement) is reported as not
// settled, with where, and fails the cell as a harness error.
const SETTLE_NOISE_PX = 64;
async function shootSvg(page: Page): Promise<{ png: Buffer; shots: number; settled: boolean; moving?: string }> {
  let png = await page.screenshot({ animations: "disabled" });
  if (settleMs === 0) return { png, shots: 1, settled: true };
  let moving: string | undefined;
  for (let shots = 2; shots <= 6; shots++) {
    await page.waitForTimeout(settleMs);
    const next = await page.screenshot({ animations: "disabled" });
    const change = next.equals(png) ? { n: 0, where: "" } : describeChange(png, next);
    png = next;
    if (change.n <= SETTLE_NOISE_PX) return { png, shots, settled: true };
    moving = change.where;
  }
  return { png, shots: 6, settled: false, moving };
}
// how many pixels two shots of the SVG arm differ in, and "N px differ in x0,y0-x1,y1" (device px)
function describeChange(a: Buffer, b: Buffer): { n: number; where: string } {
  const x = decodePng(a);
  const y = decodePng(b);
  let n = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let i = 0; i < x.data.length; i += 4)
    if (x.data[i] !== y.data[i] || x.data[i + 1] !== y.data[i + 1] || x.data[i + 2] !== y.data[i + 2]) {
      const px = (i / 4) % x.width, py = Math.floor(i / 4 / x.width);
      n++;
      x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
    }
  return { n, where: `${n} px differ in ${x0},${y0}-${x1},${y1}` };
}

// ------------------------------------------------------------------ SVG reference for dense bitmap layers
//
// Two layers are drawn by the app as ONE raster of their own vectors, for speed (commit 9a5021eb): the burg icons
// (burg-canvas.ts, <image data-burg-vectors>) and the cell mesh (cell-mesh-canvas.ts, <image data-cell-mesh>). The raster
// is cut once at min(dpr, 2) px per map unit (the burg SVG is first decoded at 1 px per unit), so in SVG mode it is
// shown upscaled by k and stays blurry for every zoom up to 4, where dense-zoom.ts swaps in crisp vector <use>s (burgs,
// k > 4). It never sharpens with time (the settle shots below prove it), so it is not a transient: it is what SVG mode
// shows. What the GPU is meant to reproduce differs by layer:
//   burgs: the scene routes the export clone, which restores the icons' vectors ("restored burg vectors"), so the GPU
//          draws crisp icons on purpose. Against the shown bitmap the cells measured the bitmap's blur (ink ratio
//          0.21-0.63), not the icons. Reference: the vector form, the same SVG with the bitmap swapped back for its
//          vectors (what saves, exports and editors use).
//   cells: the scene keeps the displayed asset ("cell mesh bitmap" compat, scene.ts) unless gpu-native-cells=1, so the
//          GPU's frame is meant to equal what SVG mode shows. Reference: the bitmap as shown.
// Either way the other reference is measured against the same GPU frame and reported (`otherRef`), and how far the bitmap
// is from its vectors too (`bitmapVsVector`). The swap happens after the GPU arm is shot, in the app's own state.
type DenseKind = "burgs" | "cells";
const DENSE: Record<string, { kind: DenseKind; ref: "vector" | "seen" }> = { icons: { kind: "burgs", ref: "vector" }, cells: { kind: "cells", ref: "seen" } };

// Swaps the bitmap for vectors in the live DOM; returns what it swapped, or null when SVG shows no bitmap here.
const vectorize = (page: Page, kind: DenseKind) =>
  page.evaluate(kind => {
    const w = globalThis as any;
    if (kind === "burgs") {
      const bitmaps = [...document.querySelectorAll("svg#map #burgIcons image[data-burg-vectors], svg#map #anchors image[data-burg-vectors]")].filter(i => !i.hasAttribute("data-zoom-hidden"));
      if (!bitmaps.length) return null;
      w.prepareBurgIcons(); // editing mode: restores every group's <use>s and stops the app re-compacting them
      return { bitmaps: bitmaps.length };
    }
    const group = document.getElementById("cells");
    const image = group?.querySelector<SVGImageElement>("image[data-cell-mesh]");
    if (!group || !image) return null;
    const graph = (0, eval)("customization") === 1 ? w.grid : w.pack;
    let d = "";
    for (let n = 0; n < graph.cells.i.length; n++) {
      const vertices = graph.cells.v[graph.cells.i[n]];
      if (!vertices.length) continue;
      const start = graph.vertices.p[vertices[0]];
      d += `M${start[0]} ${start[1]}`;
      for (let i = 1; i < vertices.length; i++) d += `L${graph.vertices.p[vertices[i]][0]} ${graph.vertices.p[vertices[i]][1]}`;
      d += "Z";
    }
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    w.__goldenCellImage = image;
    group.replaceChildren(path); // stroke, width and opacity come from #cells, as for the bitmap's source
    return { bitmaps: 1 };
  }, kind);
// The vector-form SVG shot of a dense family (GPU canvas hidden for the shot), then the bitmap is put back and the app
// and the GPU settle again. null when SVG shows no bitmap here (the burgs above k 4 already show vectors).
async function captureVector(page: Page, kind: DenseKind): Promise<{ png: Buffer; shots: number; settled: boolean; moving?: string; swapped: number } | null> {
  const old = await hideCanvas(page);
  let swapped: { bitmaps: number } | null = null;
  try {
    swapped = await vectorize(page, kind);
    if (!swapped) return null;
    await twoFrames(page);
    return { ...(await shootSvg(page)), swapped: swapped.bitmaps };
  } finally {
    await showCanvas(page, old);
    if (swapped) await restoreBitmap(page, kind);
  }
}
// Puts the bitmap back (the app's own compaction for the burgs), then waits for the app and the GPU to settle again.
async function restoreBitmap(page: Page, kind: DenseKind): Promise<void> {
  await page.evaluate(async kind => {
    const w = globalThis as any;
    if (kind === "burgs") {
      w.finishBurgIcons();
      await w.burgRenderReady;
    } else if (w.__goldenCellImage) {
      document.getElementById("cells")?.replaceChildren(w.__goldenCellImage);
      delete w.__goldenCellImage;
    }
  }, kind);
  await settleApp(page);
  await waitGpu(page);
}

// The blanks: every family hidden, captured in both arms. They are what "painted nothing" looks like in each arm
// (backdrop + page chrome). Each arm's ink is measured against its own blank: translucent page chrome over the
// canvas blends a code value differently from the same chrome over the SVG (the top-left menu button: 39 px at dpr 2).
async function captureBlanks(page: Page): Promise<{ gpu: Buffer; svg: Buffer; gpuStatus: Awaited<ReturnType<typeof waitGpu>> }> {
  await page.evaluate(isolateLayer, { id: null, bg });
  await settleApp(page);
  await page.evaluate(isolateLayer, { id: null, bg });
  const gpuStatus = await waitGpu(page);
  return { ...(await captureArms(page)), gpuStatus };
}

// One word per cell for the per-layer table: what failed first, in order of how much it says about the GPU arm.
function classify(cell: Cell, gates: Record<string, boolean>): string {
  if (cell.pass) return "pass";
  if (cell.failures.some(f => f.startsWith("harness:") || f.startsWith("GPU not active") || f.startsWith("GPU frame did not") || f.startsWith("GPU arm is not"))) return "harness";
  if (!gates.populated) return "empty";
  if (!gates.ssim || !gates.over16 || !gates[reading]) return "gap";
  if (!gates.coverage) return "coverage";
  return "census";
}

// ------------------------------------------------------------------ run

const fmt = (k: number) => String(k).replace(".", "p");
const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--use-angle=metal", "--enable-gpu"] });
try {
  mkdirSync(outDir, { recursive: true });
  for (const dpr of dprs) {
    const { context, page } = await openContext(dpr);
    try {
      for (const preset of presets) {
        log(`dpr ${dpr} preset ${preset}: loading ${mapPath}`);
        const toggles = [...new Set(families.map(f => f.toggle).filter((t): t is string => !!t))];
        const problems = await loadFixture(page, preset, toggles);
        for (const p of problems) report.warnings.push(p);
        const cellDir = join(outDir, "cells", preset, `d${dpr}`);
        mkdirSync(cellDir, { recursive: true });
        await zoomTo(page, plan[0].camera);
        const blanks = await captureBlanks(page);
        writeFileSync(join(cellDir, "blank-svg.png"), blanks.svg);
        writeFileSync(join(cellDir, "blank-gpu.png"), blanks.gpu);
        const blankSvg = decodePng(blanks.svg);
        // without a presented GPU blank, both arms are measured against the SVG blank (and the note says so)
        const gpuBlankOk = blanks.gpuStatus.active === "gpu" && !blanks.gpuStatus.timedOut;
        if (!gpuBlankOk) report.warnings.push(`${preset}/d${dpr}: no GPU blank frame (${JSON.stringify(blanks.gpuStatus)}); GPU ink measured against the SVG blank`);
        const blankGpu = gpuBlankOk ? decodePng(blanks.gpu) : blankSvg;
        for (const { camera, items } of plan) {
          const k = camera.k;
          await zoomTo(page, camera);
          for (const { family, first } of items) {
            const started = Date.now();
            const key = `${preset}/d${dpr}/${family.name}/k${k}${first ? "" : `@${camera.id}`}`;
            const cell: Cell = { key, preset, dpr, family: family.name, id: family.id, k, camera: camera.id, pass: false, failures: [] };
            report.cells.push(cell);
            try {
              const toggleProblem = problems.find(p => family.toggle && p.startsWith(`toggle ${family.toggle}:`));
              if (toggleProblem) cell.failures.push(toggleProblem);
              const coaProblem = family.id === "emblems" && problems.find(p => p.startsWith("emblems:"));
              if (coaProblem) cell.failures.push(`harness: ${coaProblem}`);
              await page.evaluate(isolateLayer, { id: family.id, root: family.root, bg });
              await settleApp(page);
              await page.evaluate(isolateLayer, { id: family.id, root: family.root, bg });
              cell.pendingCoas = await applyZoomStyling(page);
              if (cell.pendingCoas) cell.failures.push(`harness: ${cell.pendingCoas} visible emblem(s) still without a COA symbol after 20 s`);
              await settleApp(page);
              await page.evaluate(isolateLayer, { id: family.id, root: family.root, bg });
              const status = await waitGpu(page);
              cell.renderer = status;
              if (status.active !== "gpu") cell.failures.push(`GPU not active: ${status.fallbackReason ?? "no frame"}`);
              else if (status.timedOut) cell.failures.push("GPU frame did not settle within 60 s");
              if (coaLate && family.id === "emblems") {
                cell.coaLate = await lateCoas(page);
                if (!cell.coaLate.reprepared) cell.notes = [...(cell.notes ?? []), "the renderer did not prepare again when the COA symbols arrived"];
              }
              if (breakMode !== "none") {
                const dropped = await breakFrame(page, breakMode);
                cell.dropped = dropped;
                // the self-test must break something; a no-op here would make it vacuous
                if (!dropped.dropped) cell.failures.push(`harness: break=${breakMode} found nothing to break in gpuRenderer.prepared.frame.batches`);
              }
              const seen = await readCensus(page, family);
              if (family.root && !seen.runsReadable) cell.failures.push("harness: gpuRenderer.prepared.runs is not readable; root-family GPU census unknown");
              cell.domDrawables = seen.domDrawables;
              cell.compatRunElements = seen.compatRunElements;
              cell.censusKinds = seen.sink?.kinds ?? null;
              cell.census = family.root
                ? { native: 0, compat: seen.compatRunElements, skipped: 0 }
                : seen.layer
                  ? { native: seen.layer.native, compat: seen.layer.compat, skipped: seen.sink?.skipped ?? 0 }
                  : seen.sink
                    ? { native: 0, compat: 0, skipped: seen.sink.skipped }
                    : null;
              census.cells[key] = { ...(cell.census ?? { native: 0, compat: 0, skipped: 0 }), kinds: cell.censusKinds };
              cell.expected = expectations?.cells?.[key] ? { native: expectations.cells[key].native, compat: expectations.cells[key].compat, skipped: expectations.cells[key].skipped } : null;
              const shots = await captureArms(page);
              if (gpuArm === "probe") {
                cell.showThrough = shots.showThrough;
                const t = shots.showThrough;
                if (!t) cell.failures.push("harness: GOLDEN_GPU_ARM=probe captured no composite");
                else if (t.composite || t.magenta) {
                  cell.failures.push(`GPU arm is not the canvas alone: ${t.composite} px differ from the composite (SVG under the canvas), ${t.magenta} px over a magenta cover`);
                  const base = join(cellDir, `${family.name}-k${fmt(k)}${first ? "" : `@${camera.id}`}`);
                  for (const [name, png] of Object.entries(shots.probe)) writeFileSync(`${base}-probe-${name}.png`, png);
                }
              }
              cell.svgShots = shots.svgShots;
              if (!shots.svgSettled) cell.failures.push(`harness: the SVG arm was still changing after ${shots.svgShots} shots ${settleMs} ms apart (${shots.svgMoving})`);
              // dense bitmap families: the vector form is the reference (GOLDEN_SVG_REF), the shown bitmap is reported
              let svgPng = shots.svg;
              let otherPng: Buffer | null = null; // the dense family's other SVG reference
              cell.svgRef = "svg";
              const dense = DENSE[family.id];
              if (dense) {
                const ref = svgRefArg === "auto" ? dense.ref : svgRefArg;
                const vec = await captureVector(page, dense.kind);
                if (vec) {
                  if (!vec.settled) cell.failures.push(`harness: the vector-form SVG arm was still changing after ${vec.shots} shots (${vec.moving})`);
                  otherPng = ref === "vector" ? shots.svg : vec.png;
                  if (ref === "vector") svgPng = vec.png;
                  cell.svgRef = ref;
                  cell.svgVector = { bitmaps: vec.swapped };
                  const g = decodePng(shots.gpu);
                  const m = measureCell(decodePng(otherPng), g, blankSvg, blankGpu);
                  const v = judgeCell({ metrics: m, census: cell.census, domDrawables: cell.domDrawables, expected: null }, reading);
                  // the other reference, against the same GPU frame: info only
                  cell.otherRef = { ref: ref === "vector" ? "seen" : "vector", pass: v.pass, failures: v.failures, ssim: m.ssim, over16Fraction: m.over16Fraction, over44Fraction: m.over44Fraction, inkSvg: m.inkSvg, inkGpu: m.inkGpu, inkRatio: m.inkRatio, over16OfInk: m.over16OfInk };
                  // how far the shown bitmap is from its own vectors: the blur, as the same metrics
                  const blur = measureCell(decodePng(shots.svg), decodePng(vec.png), blankSvg, blankSvg);
                  cell.bitmapVsVector = { ssim: blur.ssim, over16OfInk: blur.over16OfInk, inkBitmap: blur.inkSvg, inkVector: blur.inkGpu };
                } // else SVG shows vectors already (burgs above k 4): svgRef stays "svg"
              }
              const svg = decodePng(svgPng);
              const gpu = decodePng(shots.gpu);
              cell.metrics = measureCell(svg, gpu, blankSvg, blankGpu);
              const verdict = judgeCell({ metrics: cell.metrics, census: cell.census, domDrawables: cell.domDrawables, expected: cell.expected }, reading);
              cell.gates = verdict.gates;
              if (verdict.notes.length) cell.notes = [...(cell.notes ?? []), ...verdict.notes];
              cell.failures.push(...verdict.failures);
              cell.pass = cell.failures.length === 0;
              cell.class = classify(cell, verdict.gates);
              if (keep === "all" || !cell.pass) {
                const base = join(cellDir, `${family.name}-k${fmt(k)}${first ? "" : `@${camera.id}`}`);
                writeFileSync(`${base}-svg.png`, svgPng);
                if (otherPng) writeFileSync(`${base}-svg-${cell.otherRef?.ref === "seen" ? "bitmap" : "vector"}.png`, otherPng);
                writeFileSync(`${base}-gpu.png`, shots.gpu);
                writeFileSync(`${base}-diff.png`, encodePng(heatmap(svg, gpu)));
                cell.images = { svg: relative(outDir, `${base}-svg.png`), gpu: relative(outDir, `${base}-gpu.png`), diff: relative(outDir, `${base}-diff.png`) };
              }
            } catch (error) {
              cell.failures.push(`harness: ${String(error).slice(0, 500)}`);
              cell.pass = false;
              cell.class = "harness";
            }
            cell.seconds = Number(((Date.now() - started) / 1000).toFixed(1));
            const m = cell.metrics;
            log(
              `${cell.pass ? "PASS" : "FAIL"} ${key}${m ? ` ssim ${m.ssim.toFixed(4)} over16 ${(m.over16Fraction * 100).toFixed(3)}% over44 ${(m.over44Fraction * 100).toFixed(3)}% changed ${(m.changedFraction * 100).toFixed(2)}%` : ""}` +
                `${cell.census ? ` census n${cell.census.native}/c${cell.census.compat}/s${cell.census.skipped}` : ""}${cell.svgRef && cell.svgRef !== "svg" ? ` ref ${cell.svgRef}` : ""}${cell.otherRef ? ` (vs ${cell.otherRef.ref}: ${cell.otherRef.pass ? "pass" : "fail"} ratio ${cell.otherRef.inkRatio.toFixed(3)} o16ink ${(cell.otherRef.over16OfInk * 100).toFixed(1)}%)` : ""}${cell.pass ? "" : ` :: ${cell.failures.join("; ")}`}${cell.notes ? ` [note: ${cell.notes.join("; ")}]` : ""}`
            );
            write();
          }
        }
        await page.evaluate(isolateLayer, { id: null, restore: true });
      }
    } finally {
      await context.close();
    }
  }
  if (expectations && expectations.fixtureSha256 && expectations.fixtureSha256 !== mapSha)
    report.errors.push(`census expectations are for fixture ${String(expectations.fixtureSha256).slice(0, 12)}, not ${mapSha.slice(0, 12)}`);
} catch (error) {
  report.errors.push(`harness: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  const failed = report.cells.filter(c => !c.pass);
  const byFamily: Record<string, { pass: number; fail: number }> = {};
  const byClass: Record<string, number> = {};
  // family → "k1:pass k4:coverage ..." (the per-layer table)
  const table: Record<string, string[]> = {};
  for (const c of report.cells) {
    byFamily[c.family] ??= { pass: 0, fail: 0 };
    byFamily[c.family][c.pass ? "pass" : "fail"]++;
    const cls = c.class ?? (c.pass ? "pass" : "harness");
    byClass[cls] = (byClass[cls] ?? 0) + 1;
    (table[`${c.preset}/d${c.dpr}/${c.family}`] ??= []).push(`${c.key.split("/").pop()}:${cls}`);
  }
  report.summary = {
    cells: report.cells.length,
    pass: report.cells.length - failed.length,
    fail: failed.length,
    empty: report.cells.filter(c => c.gates && !c.gates.populated).length,
    byClass,
    // cells the default (over44) reading passes and the strict (conservative) reading would fail
    strictOnly: report.cells.filter(c => c.pass && c.gates && !c.gates.conservative).length,
    byFamily,
    table: Object.fromEntries(Object.entries(table).map(([k, v]) => [k, v.join(" ")]))
  };
  const validation = report.warnings.some(w => /GL_INVALID_|Feedback loop/i.test(w));
  const reasons: string[] = [];
  if (report.errors.length) reasons.push(`${report.errors.length} page/harness error(s): ${report.errors[0].split("\n")[0].slice(0, 200)}`);
  if (validation) reasons.push("WebGL validation warning; reject render result");
  if (!report.cells.length) reasons.push("no cells captured");
  if (failed.length) reasons.push(`${failed.length}/${report.cells.length} cells failed: ${failed.slice(0, 8).map(c => `${c.key} (${c.failures[0] ?? "?"})`).join("; ")}${failed.length > 8 ? "; ..." : ""}`);
  report.failure = reasons.length ? reasons.join(" | ") : null;
  write();
  log(report.failure ? `FAIL ${report.failure}` : `PASS ${report.cells.length} cells`);
  await browser.close();
  await new Promise<void>(done => server.close(() => done()));
}
