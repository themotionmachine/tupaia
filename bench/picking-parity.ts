// G-P picking parity: the GPU selection against the real SVG click path, per world, view and cohort.
// Oracle = document.elementFromPoint on the canonical SVG + the clicked() branch rules (picking-oracle.ts), including
// its pickBurg/pickRelief canvas fallback at d3.mouse(viewbox) coordinates. The GPU side = window.gpuSelect
// (src/gpu/selection.ts: the PickIndex hit classified like clicked(), plus the same fallbacks) at the same CSS pixel;
// raw window.gpuPick ids are kept and reported. Cells are compared separately: findCell at the GPU camera vs. a
// brute-force nearest-site oracle at the SVG CTM, with a disclosed <=1px border band excluded.
// Everything runs in an isolated local browser (PICK_LAUNCHER, default metal: ANGLE on the host GPU, checked by the
// adapter probe): local GET + fonts.gstatic GET only, service workers blocked.
// Protocol v2 (schema 2): v1 called window.pickRelief per sample, which materializes <use> glyphs into #terrain and so
// mutated the scene mid-run. v2 freezes the relief regime (PICK_RELIEF_MODE compact | materialized) before the GPU is
// readied, samples read-only in two passes (A: elementFromPoint + gpuPick/gpuSelect; B: pickBurg, then the pure
// peekRelief, only for points no DOM branch matched), and rejects the run if anything structural changed in between.
// Protocol v3 (schema 3, PICK W3):
// - Gate = D3 (PHASE1-PLAN): the semantic outcome (gpuSelect vs clicked()) per cohort, every cohort with >=50 meaningful
//   samples at >=99.5%; burg, label, marker, river, ice and regiment must reach 50 on the parity and shared worlds or
//   the run fails (route is gated wherever it reaches 50). Raw gpuPick agreement is reported only.
// - Edge band (disclosed, PICK_EDGE_BAND CSS px, default EDGE_BAND_PX; 0 = strict): pass A also probes EDGE_RING points
//   on a circle of that radius; a sample whose clicked() outcome changes there sits on a boundary Blink only
//   approximates (Skia stroke outline vs the true offset) and is excluded from the cohort gate. The band has its own
//   floor (BAND_MIN_RATE: the world's band and every band cohort with n>=50), so a hit-shape change smaller than the
//   band still fails. row.gate.strict keeps the all-samples verdicts (reported), row.gate.edgeBand the band verdicts.
// - Views: one world is sampled at up to PICK_VIEWS cameras at zoom k (planViews: the primary camera, then windows on
//   the required kinds the earlier ones show too few of); each view has its own quiet window, guard and passes.
// - Targeted cohorts come from each element's own geometry, never from hit testing: fill points by isPointInFill,
//   route points along getPointAtLength within the stroke width, text points inside glyph extents, regiment points in
//   their rects, marker and emblem points in their boxes, burg anchors and jitter as before.
// - elementFromPoint is cache-busted per sample: Blink caches the last hit per 1/64 CSS px cell (LayoutUnit), so two
//   queries in one cell would get the first one's answer; the hit test itself uses the exact point.
// - The shared world has no regiments: it is enriched with the app's own regenerateMilitary() under a seeded
//   Math.random (row.enrichment), so the regiment cohort exists there too.
// - A sample whose elementFromPoint is null (no element at all) is excluded like an occluded one.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { adapterMatches, launcherFrom, launchOptions, probeAdapter } from "./host/launcher.ts";
import { resolveFixture } from "./host/fixtures/index.ts";
import {
  bisectorDistance,
  type ChainDesc,
  classifyClick,
  cohortGate,
  compareSelections,
  BAND_MIN_RATE,
  EDGE_BAND_PX,
  EDGE_RING,
  edgeBandGate,
  inEdgeBand,
  COMPARABLE,
  MIN_COHORT,
  MIN_RATE,
  mulberry32,
  type MutationCounts,
  needsFallback,
  normalizeGpu,
  planViews,
  REQUIRED,
  REQUIRED_WORLDS,
  type SceneProbe,
  sceneChanges,
  type Selection,
  selectDiagnostics,
  tally
} from "./picking-oracle.ts";

const dpr = Number(process.env.PICK_DPR || 2);
const zoom = Number(process.env.PICK_ZOOM || 2);
const phase = process.env.PICK_PHASE || "settled";
const name = process.env.PICK_NAME || "picking";
const output = process.env.PICK_OUTPUT || "/tmp/tupaia-picking-parity.json";
const mapPath = process.env.PICK_MAP || "/tmp/tupaia-navigation-shared-v8.map";
const worlds = (process.env.PICK_WORLDS || "parity,shared,100k").split(",");
const reliefMode = process.env.PICK_RELIEF_MODE || "compact";
const launcher = launcherFrom(process.env.PICK_LAUNCHER);
const maxViews = Number(process.env.PICK_VIEWS || 4);
const edgeBand = Number(process.env.PICK_EDGE_BAND ?? EDGE_BAND_PX);
if (!(edgeBand >= 0 && edgeBand <= 1)) throw new Error("PICK_EDGE_BAND must be 0..1 CSS px");
if (!["compact", "materialized"].includes(reliefMode)) throw new Error("PICK_RELIEF_MODE must be compact or materialized");
if (![1, 2].includes(dpr)) throw new Error("PICK_DPR must be 1 or 2");
if (![1, 2, 4, 8].includes(zoom)) throw new Error("PICK_ZOOM must be 1, 2, 4 or 8");
if (!["settled", "motion"].includes(phase)) throw new Error("PICK_PHASE must be settled or motion");
if (!(maxViews >= 1 && maxViews <= 8)) throw new Error("PICK_VIEWS must be 1..8");
if (worlds.some(world => !["parity", "shared", "100k", "100k-labels"].includes(world)))
  throw new Error("PICK_WORLDS: parity,shared,100k,100k-labels");
// 100k-labels is a fixture on the 100k map already loaded by the row right before it (never regenerated)
if (worlds.some((world, i) => world === "100k-labels" && worlds[i - 1] !== "100k"))
  throw new Error("PICK_WORLDS: 100k-labels must directly follow 100k");
if (existsSync(output)) throw new Error("PICK_OUTPUT exists; results are immutable: " + output);
const diagnosticsPath = output.replace(/\.json$/, "") + ".diagnostics.json";
if (existsSync(diagnosticsPath)) throw new Error("diagnostics exist; results are immutable: " + diagnosticsPath);
const diagnosticRows: { world: string; view: number; rows: unknown[] }[] = [];

const UNIFORM = 500; // primary view only
const TARGET = 120; // targeted samples per generator kind per world, spread over the views' elements
// per-kind overrides: on the parity fixture the goods data layer covers most rivers, so only ~1 river point in 6 is a
// river click there, and about half of those fall in the edge band of a thin river polygon
const TARGET_BY_KIND: Record<string, number> = { river: 1200 };
const PER_ELEMENT_BY_KIND: Record<string, number> = { river: 24 };
const PER_ELEMENT = 12; // at most this many targeted samples on one element
const NEED_VISIBLE = 10; // planViews: elements of each required kind the views should show between them
const JITTER = 2; // CSS px
const TOLERANCE = 0; // gpuPick tolerance; SVG hit testing has none
const CELL_BAND = 1; // CSS px from a Voronoi border, excluded from the cell gate only
const VIEW = { width: 1280, height: 720 };
// generator kinds: their samples feed the cohort of the same name (burgLabel feeds burg)
const GENERATORS = ["burg", "burgLabel", "label", "marker", "river", "route", "ice", "regiment", "lake", "emblem"];
const PLAN_KINDS = ["burg", "label", "marker", "river", "route", "ice", "regiment"];

const parityPath = process.env.PICK_PARITY_MAP || (worlds.includes("parity") ? resolveFixture("parity").path : "");

const dist = resolve("dist");
const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json"
};
const blocked: string[] = [];
const server = createServer((request, response) => {
  if (request.method !== "GET") return void response.writeHead(405).end();
  const path = resolve(dist, "." + new URL(request.url || "/", "http://localhost").pathname);
  if (!path.startsWith(dist + "/") && path !== dist) return void response.writeHead(403).end();
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
if (!address || typeof address === "string") throw new Error("Missing local server");
const origin = "http://127.0.0.1:" + address.port;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const sharedText = worlds.includes("shared") ? readFileSync(mapPath, "utf8") : "";
const parityText = parityPath ? readFileSync(parityPath, "utf8") : "";

const report: any = {
  schema: 3,
  protocol: "v3",
  name,
  config: {
    dpr,
    zoom,
    phase,
    worlds,
    reliefMode,
    launcher,
    adapter: null,
    map: mapPath,
    mapSha256: sharedText ? sha(sharedText) : null,
    parityMap: parityPath || null,
    paritySha256: parityText ? sha(parityText) : null,
    generated: { cells: 100000, seed: "7319", template: "continents", width: 1280, height: 720 },
    viewport: VIEW,
    uniform: UNIFORM,
    targetPerKind: TARGET,
    targetByKind: TARGET_BY_KIND,
    edgeBandPx: edgeBand,
    edgeRing: EDGE_RING,
    perElement: PER_ELEMENT,
    perElementByKind: PER_ELEMENT_BY_KIND,
    maxViews,
    jitterPx: JITTER,
    gpuTolerancePx: TOLERANCE,
    cellBorderBandPx: CELL_BAND,
    oracle:
      "frozen relief regime; elementFromPoint (cache-busted) on canonical SVG + clicked() DOM branches; only if none " +
      "matched: pickBurg, then read-only peekRelief (href@x,y descriptor) at viewbox CTM; pickRelief never called",
    guards:
      "TradeAnimation.stop() in setup, MutationObserver on #map, #terrain FNV hash + child count, relief revision, prepared GPU scene, " +
      "camera, pickRelief call counter, sampled targets still connected; any change rejects the view and its world",
    gpu: "window.gpuSelect(svg-local CSS px, tolerance 0) = PickIndex hit classified like clicked() + its fallbacks; raw gpuPick reported",
    gate: `D3: semantic outcome per cohort, n>=${MIN_COHORT} at >=${MIN_RATE * 100}%; required cohorts ${REQUIRED.join(",")} on ${REQUIRED_WORLDS.join(",")}; edge band ${edgeBand} CSS px gated apart at >=${BAND_MIN_RATE * 100}% (world and band cohorts n>=${MIN_COHORT}; strict tally reported); cells exact outside the band`,
    cells: "findCell at GPU camera world vs brute-force nearest pack.cells.p at SVG CTM world (CPU, no GPU id buffer)",
    required: REQUIRED,
    requiredWorlds: REQUIRED_WORLDS,
    comparable: COMPARABLE,
    network: "local GET + fonts.gstatic.com GET only; service workers blocked; autosave 0"
  },
  results: [],
  blockedRequests: blocked,
  failure: null
};

const browser = await chromium.launch(launchOptions(launcher));
try {
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: dpr, serviceWorkers: "block" });
  await context.addInitScript(() => {
    localStorage.setItem("autosaveInterval", "0");
    localStorage.setItem("azgaarAssistant", "hide");
  });
  const scripts = [
    "bridge.js",
    "bridge-mutations.js",
    ...readdirSync("mcp/src/bridge-ext")
      .filter(file => file.endsWith(".js"))
      .sort()
      .map(file => "bridge-ext/" + file)
  ];
  await context.addInitScript(scripts.map(file => readFileSync("mcp/src/" + file, "utf8")).join("\n"));
  await context.route("**/*", route => {
    const request = route.request();
    const url = new URL(request.url());
    const fonts = url.origin === "https://fonts.gstatic.com";
    if (request.method() === "GET" && (url.origin === origin || fonts)) return route.continue();
    blocked.push(request.method() + " " + url.origin + url.pathname);
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(300000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.dismiss());
  await page.goto(origin + "/?local&seed=7319&width=1280&height=720&renderer=gpu&gpu-select");
  await page.evaluate(async () => {
    const result = await (globalThis as any).__tupaia.call("ready", { timeoutMs: 120000 });
    if (!result.ok) throw new Error(JSON.stringify(result));
  });
  const adapter = await page.evaluate(probeAdapter);
  report.config.adapter = adapter;
  if (!adapterMatches(launcher, adapter.renderer))
    throw new Error(`launcher ${launcher} did not get its adapter: ${JSON.stringify(adapter)}`);

  // One camera at zoom k on world centre (x, y) (null: the primary rule, the live burg nearest the map centre), the
  // relief regime frozen, the trade caravans stopped, the GPU steady and the scene quiet. Returns the setup probes.
  const setCamera = (centre: [number, number] | null) =>
    page.evaluate(async ({ k, reliefMode, centre }) => {
        const w = globalThis as any;
        // one observer configuration for the quiet window, the self-test and the sampling guard
        w.__pickObserve = { childList: true, attributes: true, characterData: true, subtree: true };
        // bench-local scene fingerprint (SceneProbe); reads only
        w.__pickProbe = () => {
          const terrain = document.getElementById("terrain");
          const html = terrain?.outerHTML ?? "";
          let hash = 0x811c9dc5;
          for (let i = 0; i < html.length; i++) hash = Math.imul(hash ^ html.charCodeAt(i), 0x01000193);
          const prepared = w.gpuRenderer?.prepared ?? null;
          w.__pickPrepared ??= new WeakMap();
          w.__pickPreparedNext ??= 1;
          const identity = (value: object | null) => {
            if (!value) return 0;
            if (!w.__pickPrepared.has(value)) w.__pickPrepared.set(value, w.__pickPreparedNext++);
            return w.__pickPrepared.get(value);
          };
          const rect = document.getElementById("map")!.getBoundingClientRect();
          const globals = [(0, eval)("scale"), (0, eval)("viewX"), (0, eval)("viewY")].join(",");
          return {
            regime: terrain?.querySelector(":scope > image[data-relief]")
              ? "compact"
              : terrain?.querySelector(":scope > use")
                ? "materialized"
                : "none",
            terrainHash: (hash >>> 0).toString(16) + ":" + html.length,
            terrainChildren: terrain?.childElementCount ?? -1,
            revision: w.reliefRevision?.() ?? -1,
            prepared: identity(prepared),
            preparedRevision: prepared?.revision ?? -1,
            sourceRevision: w.rendererStatus?.()?.gpu?.revision ?? -1,
            pickIndex: identity(prepared?.pick ?? null),
            camera: (document.getElementById("viewbox")?.getAttribute("transform") ?? "") + "|" + globals,
            layout: [rect.x, rect.y, rect.width, rect.height, innerWidth, innerHeight, devicePixelRatio].join(",")
          };
        };
        let x: number, y: number;
        if (centre) [x, y] = centre;
        else {
          // deterministic camera: centered on the live burg nearest the map center (map center at k=1)
          const cx = w.graphWidth / 2,
            cy = w.graphHeight / 2;
          x = cx;
          y = cy;
          if (k > 1) {
            let best = Infinity;
            for (const burg of w.pack.burgs)
              if (burg?.i && !burg.removed) {
                const d = (burg.x - cx) ** 2 + (burg.y - cy) ** 2;
                if (d < best) [best, x, y] = [d, burg.x, burg.y];
              }
          }
        }
        const target = { k, x: 640 - x * k, y: 360 - y * k };
        w.d3
          .select("#map")
          .call((0, eval)("zoom").transform, w.d3.zoomIdentity.translate(target.x, target.y).scale(target.k));
        await new Promise(done => setTimeout(done, 350));
        if (w.waitDenseZoomReady) await w.waitDenseZoomReady(15000);
        await w.reliefRenderReady;
        // freeze the relief regime before the GPU index the samples read is (re)prepared
        const setup = {
          before: w.__pickProbe(),
          materializeCalls: 0,
          tradeAnimation: { groups: 0, stopped: false },
          after: null as any
        };
        // the ambient caravans (#tradeAnimation g, each with a click-target circle) add and remove nodes every segment;
        // the first v2 pilot was rejected on them, so the oracle freezes the scene by stopping the module (view-only)
        setup.tradeAnimation.groups = document.querySelectorAll("#tradeAnimation > g").length;
        if (w.TradeAnimation?.stop) {
          w.TradeAnimation.stop();
          setup.tradeAnimation.stopped = true;
        }
        // stopped means no caravan left and none scheduled; otherwise the scene cannot pass as stable
        const tradeStopped = () =>
          document.querySelectorAll("#tradeAnimation > g").length === 0 && (w.TradeAnimation?.activeCount ?? 0) === 0;
        if (setup.tradeAnimation.groups && !tradeStopped()) {
          // clear() removes through the `tradeAnimation` global selection; record whether it still names the live group
          const live = [...document.querySelectorAll("#tradeAnimation")];
          const selected = (0, eval)("typeof tradeAnimation === 'undefined' ? null : tradeAnimation.node()");
          setup.tradeAnimation.residue = {
            groups: document.querySelectorAll("#tradeAnimation > g").length,
            activeCount: w.TradeAnimation?.activeCount ?? null,
            liveContainers: live.length,
            selectionIsLive: live.includes(selected),
            selectionConnected: !!selected?.isConnected
          };
          // stop() must leave no caravan in any container (clear() also removes groups orphaned by a world load); the
          // bench no longer removes residue itself, so any leftover group or active segment rejects the run
          throw new Error("TradeAnimation.stop did not stop: " + JSON.stringify(setup.tradeAnimation.residue));
        }
        if (reliefMode === "materialized") {
          w.prepareReliefIcons();
          setup.materializeCalls++;
          await new Promise(done => setTimeout(done, 350));
        }
        const settled = async () => {
          const start = performance.now();
          while (true) {
            const status = w.rendererStatus?.();
            const gpu = status?.gpu;
            if (status?.active !== "gpu") throw new Error("GPU fell back: " + status?.fallbackReason);
            if (
              gpu?.canvasVisible &&
              gpu.sourceCurrent &&
              gpu.windows?.coverage === "covered" &&
              !gpu.pending &&
              !gpu.refinementPending &&
              !gpu.moving
            )
              return;
            if (performance.now() - start > 30000) {
              const flags = ["canvasVisible", "sourceCurrent", "pending", "refinementPending", "moving"]
                .map(key => key + "=" + gpu?.[key])
                .join(" ");
              const why = JSON.stringify({
                state: gpu?.state,
                suspendedReason: gpu?.suspendedReason,
                revision: gpu?.revision,
                preparedRevision: w.gpuRenderer?.prepared?.revision ?? null,
                lastPrepare: gpu?.lastPrepare
              }).slice(0, 600);
              throw new Error(`GPU did not reach steady readiness: ${flags} coverage=${gpu?.windows?.coverage} ${why}`);
            }
            await new Promise(done => setTimeout(done, 25));
          }
        };
        await settled();
        // quiet window: no mutation of any kind (the guard's own options) for 500 ms, then steady again
        const map = document.getElementById("map")!;
        let last = performance.now();
        let churn: string[] = [];
        const quiet = new MutationObserver(records => {
          last = performance.now();
          for (const r of records.slice(0, 4))
            churn = [...churn.slice(-11), r.type + ":" + (r.target as Element).tagName + "#" + ((r.target as Element).id || "") + ":" + (r.attributeName || "")];
        });
        try {
          quiet.observe(map, w.__pickObserve);
          const begin = performance.now();
          while (performance.now() - last < 500) {
            if (performance.now() - begin > 20000) throw new Error("scene did not go quiet after setup: " + churn.join(" "));
            await new Promise(done => setTimeout(done, 50));
          }
        } finally {
          quiet.disconnect();
        }
        await settled();
        await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
        if (setup.tradeAnimation.groups && !tradeStopped()) throw new Error("trade caravans resumed during setup");
        setup.after = w.__pickProbe();
        return { requested: target, center: { x, y }, setup };
      }, { k: zoom, reliefMode, centre });

  // Element world centres per plan kind, read at k 1 where nothing is culled for being off screen.
  const inventory = () =>
    page.evaluate(async () => {
      const w = globalThis as any;
      w.d3.select("#map").call((0, eval)("zoom").transform, w.d3.zoomIdentity);
      await new Promise(done => setTimeout(done, 350));
      const inverse = (document.getElementById("viewbox") as any).getScreenCTM().inverse();
      const centres = (selector: string) =>
        [...document.querySelectorAll(selector)].flatMap(element => {
          const r = element.getBoundingClientRect();
          if (!(r.width > 0 || r.height > 0)) return [];
          const p = new DOMPoint(r.x + r.width / 2, r.y + r.height / 2).matrixTransform(inverse);
          return [[p.x, p.y] as [number, number]];
        });
      const burgs = (w.pack.burgs as any[]).filter(b => b?.i && !b.removed).map(b => [b.x, b.y] as [number, number]);
      return {
        map: { width: w.graphWidth as number, height: w.graphHeight as number },
        kinds: {
          burg: burgs,
          label: centres("#labels text"),
          marker: centres("#markers > svg"),
          river: centres("#rivers > path"),
          route: centres("#routes path"),
          ice: centres("#ice > *"),
          regiment: centres("#armies > g > g")
        } as Record<string, [number, number][]>
      };
    });

  // Targeted points of one view, from each element's own geometry (no hit testing). `quota` per generator kind is
  // what the earlier views left; `used` lists element keys earlier views already sampled.
  const targets = (seed: number, quota: Record<string, number>, used: Record<string, string[]>) =>
    page.evaluate(
      ({ seed, quota, used, perElement, perElementByKind, jitter }) => {
        const w = globalThis as any;
        let a = seed >>> 0;
        const random = () => {
          a = (a + 0x6d2b79f5) >>> 0;
          let t = a;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const inside = (p: { x: number; y: number }) => p.x > 2 && p.y > 2 && p.x < 1278 && p.y < 718;
        const screen = (element: any, x: number, y: number) => new DOMPoint(x, y).matrixTransform(element.getScreenCTM());
        const onScreen = (element: Element) => {
          const r = element.getBoundingClientRect();
          return (r.width > 0 || r.height > 0) && r.right > 2 && r.bottom > 2 && r.left < 1278 && r.top < 718;
        };
        type Point = { x: number; y: number };
        const fillPoint = (element: any): Point | null => {
          const b = element.getBBox();
          for (let k = 0; k < 120; k++) {
            const lx = b.x + random() * b.width,
              ly = b.y + random() * b.height;
            if (element.isPointInFill(new DOMPoint(lx, ly))) return screen(element, lx, ly);
          }
          return null;
        };
        const strokePoint = (element: any): Point | null => {
          const length = element.getTotalLength();
          if (!(length > 0)) return null;
          const s = random() * length;
          const p = element.getPointAtLength(s);
          const q = element.getPointAtLength(Math.min(length, s + 0.05));
          const r = element.getPointAtLength(Math.max(0, s - 0.05));
          const dx = q.x - r.x,
            dy = q.y - r.y,
            d = Math.hypot(dx, dy);
          if (!d) return null;
          const half = (Number.parseFloat(getComputedStyle(element).strokeWidth) || 1) / 2;
          const off = (random() * 2 - 1) * 0.9 * half;
          return screen(element, p.x - (dy / d) * off, p.y + (dx / d) * off);
        };
        const glyphPoint = (element: any): Point | null => {
          const n = element.getNumberOfChars?.() ?? 0;
          for (let k = 0; k < 8 && n > 0; k++) {
            const e = element.getExtentOfChar(Math.floor(random() * n));
            if (!(e.width > 0 && e.height > 0)) continue;
            return screen(element, e.x + (0.1 + 0.8 * random()) * e.width, e.y + (0.1 + 0.8 * random()) * e.height);
          }
          return null;
        };
        const boxPoint = (element: Element): Point | null => {
          const r = element.getBoundingClientRect();
          return r.width > 0 && r.height > 0 ? { x: r.x + r.width * (0.2 + 0.6 * random()), y: r.y + r.height * (0.2 + 0.6 * random()) } : null;
        };
        const regimentPoint = (element: Element): Point | null => {
          const rects = [...element.querySelectorAll(":scope > rect")] as any[];
          if (!rects.length) return null;
          const rect = rects[Math.floor(random() * rects.length)];
          const b = rect.getBBox();
          return screen(rect, b.x + (0.1 + 0.8 * random()) * b.width, b.y + (0.1 + 0.8 * random()) * b.height);
        };
        const kinds: Record<string, { list: () => [string, any][]; point: (element: any, n: number) => Point | null }> = {
          burg: {
            list: () =>
              (w.pack.burgs as any[])
                .filter(b => b?.i && !b.removed)
                .map(b => ["b" + b.i, b] as [string, any]),
            // the anchor itself, then seeded jitter around it
            point: (b, n) => {
              const p = new DOMPoint(b.x, b.y).matrixTransform((document.getElementById("viewbox") as any).getScreenCTM());
              if (!n) return p;
              const angle = random() * Math.PI * 2;
              return { x: p.x + Math.cos(angle) * jitter, y: p.y + Math.sin(angle) * jitter };
            }
          },
          burgLabel: { list: () => select("#burgLabels text"), point: glyphPoint },
          label: { list: () => select("#labels text"), point: glyphPoint },
          marker: { list: () => select("#markers > svg"), point: boxPoint },
          river: { list: () => select("#rivers > path"), point: fillPoint },
          route: { list: () => select("#routes path"), point: strokePoint },
          ice: { list: () => select("#ice > *"), point: fillPoint },
          regiment: { list: () => select("#armies > g > g"), point: regimentPoint },
          lake: { list: () => select("#lakes path"), point: fillPoint },
          emblem: { list: () => select("#emblems use"), point: boxPoint }
        };
        function select(selector: string): [string, Element][] {
          return [...document.querySelectorAll(selector)].map((element, i) => [element.id || selector + ":" + i, element]);
        }
        const points: { x: number; y: number; source: string }[] = [];
        const keys: Record<string, string[]> = {};
        const available: Record<string, number> = {};
        for (const [kind, want] of Object.entries(quota)) {
          keys[kind] = [];
          const done = new Set(used[kind] ?? []);
          const candidates = kinds[kind]
            .list()
            .filter(([key, element]) => {
              if (done.has(key)) return false;
              if (kind !== "burg") return onScreen(element);
              const p = new DOMPoint(element.x, element.y).matrixTransform((document.getElementById("viewbox") as any).getScreenCTM());
              return inside(p);
            })
            .map(entry => [random(), entry] as const)
            .sort((p, q) => p[0] - q[0])
            .map(([, entry]) => entry);
          available[kind] = candidates.length;
          if (want <= 0 || !candidates.length) continue;
          const per = Math.max(kind === "burg" ? 2 : 1, Math.min(perElementByKind[kind] ?? perElement, Math.ceil(want / candidates.length)));
          let made = 0;
          for (const [key, element] of candidates) {
            if (made >= want) break;
            let any = false;
            for (let n = 0; n < per && made < want; n++) {
              const p = kinds[kind].point(element, n);
              if (!p || !inside(p)) continue;
              points.push({ x: p.x, y: p.y, source: kind === "burg" ? (n ? "burg-jitter" : "burg-center") : kind + "-target" });
              made++;
              any = true;
            }
            if (any) keys[kind].push(key);
          }
        }
        const mapRect = document.getElementById("map")!.getBoundingClientRect();
        return { points, keys, available, mapOffset: [mapRect.x, mapRect.y] as [number, number] };
      },
      { seed, quota, used, perElement: PER_ELEMENT, perElementByKind: PER_ELEMENT_BY_KIND, jitter: JITTER }
    );

  // One view: camera, targeted (and, on the primary view, uniform) points, guarded passes A-C, cells, sample rows.
  const runView = async (world: string, index: number, centre: [number, number] | null, quota: Record<string, number>, used: Record<string, string[]>) => {
    const view: any = { index, errors: [] };
    const camera = await setCamera(centre);
    view.camera = { requested: camera.requested, center: camera.center };
    view.regime = { requested: reliefMode, setup: camera.setup };
    if (camera.setup.after.regime !== reliefMode)
      throw new Error("relief regime " + camera.setup.after.regime + " after setup, requested " + reliefMode);

    const seed = ({ parity: 3, shared: 1 } as Record<string, number>)[world] ?? 2;
    const viewSeed = seed * 1000 + zoom * 10 + dpr + index * 7919;
    const random = mulberry32(viewSeed);
    const uniform = index ? [] : Array.from({ length: UNIFORM }, () => [random() * VIEW.width, random() * VIEW.height]);
    const picked = await targets(viewSeed * 31, quota, used);
    const mapOffset = picked.mapOffset;
    const points: { x: number; y: number; source: string }[] = [
      ...uniform.map(([x, y]) => ({ x, y, source: "uniform" })),
      ...picked.points
    ];
    view.sampling = {
      seed: viewSeed,
      uniform: uniform.length,
      targetedAvailable: picked.available,
      targeted: Object.fromEntries(Object.entries(picked.keys).map(([kind, keys]) => [kind, { elements: keys.length, points: picked.points.filter(p => p.source.startsWith(kind === "burg" ? "burg-" : kind + "-")).length }])),
      total: points.length,
      mapOffset
    };

    if (phase === "motion") {
      // hold a real drag: inexact camera updates move the GPU uniforms while the SVG keeps the previous transform
      await page.mouse.move(640, 360);
      await page.mouse.down();
      for (let i = 1; i <= 6; i++) await page.mouse.move(640 + i * 6, 360 + i * 4);
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    }

      // guards: observer + committing-call counter installed before pass A, read after pass B
      const install = await page.evaluate(() => {
        const w = globalThis as any;
        // every record of every kind counts; the first 20 are logged so a rejection names its source
        const name = (node: Node) =>
          node instanceof Element ? node.tagName + (node.id ? "#" + node.id : "") : node.nodeName;
        const counter = () => {
          const state = { counts: { childList: 0, attributes: 0, characterData: 0 }, log: [] as unknown[] };
          const note = (record: MutationRecord) => {
            state.counts[record.type]++;
            if (state.log.length < 20)
              state.log.push({
                type: record.type,
                target: name(record.target) + " < " + (record.target.parentElement ? name(record.target.parentElement) : ""),
                ...(record.attributeName ? { attribute: record.attributeName, old: record.oldValue?.slice(0, 80) } : {}),
                ...(record.type === "childList"
                  ? { added: [...record.addedNodes].slice(0, 4).map(name), removed: [...record.removedNodes].slice(0, 4).map(name) }
                  : {})
              });
          };
          const observer = new MutationObserver(records => records.forEach(note));
          return { state, note, observer };
        };
        const options = { ...w.__pickObserve, attributeOldValue: true };
        // self-test on a detached SVG (no renderer invalidation): each hit-relevant edit must register under these options
        const ns = "http://www.w3.org/2000/svg";
        const root = document.createElementNS(ns, "svg");
        const circle = root.appendChild(document.createElementNS(ns, "circle"));
        const text = root.appendChild(document.createElementNS(ns, "text"));
        text.textContent = "label";
        const edits: [string, () => void][] = [
          ["font-size", () => text.setAttribute("font-size", "20")],
          ["radius", () => circle.setAttribute("r", "4")],
          ["display", () => circle.setAttribute("display", "none")],
          ["pointer-events", () => circle.setAttribute("pointer-events", "none")],
          ["style", () => circle.style.setProperty("pointer-events", "all")],
          ["geometry x", () => text.setAttribute("x", "5")],
          ["transform", () => circle.setAttribute("transform", "translate(1,2)")],
          ["text data", () => (text.firstChild!.nodeValue = "lebal")],
          ["node insert", () => root.appendChild(document.createElementNS(ns, "path"))]
        ];
        const selfTest: Record<string, MutationCounts> = {};
        for (const [label, edit] of edits) {
          const probe = counter();
          probe.observer.observe(root, options);
          edit();
          probe.observer.takeRecords().forEach(probe.note);
          probe.observer.disconnect();
          selfTest[label] = probe.state.counts;
        }
        const live = counter();
        const guard: any = {
          ...live,
          pickReliefCalls: 0,
          materializeCalls: 0,
          original: w.pickRelief,
          prepare: w.prepareReliefIcons,
          targets: []
        };
        guard.observer.observe(document.getElementById("map")!, options);
        if (guard.original)
          w.pickRelief = (...args: unknown[]) => (guard.pickReliefCalls++, guard.original(...args));
        if (guard.prepare)
          w.prepareReliefIcons = (...args: unknown[]) => (guard.materializeCalls++, guard.prepare(...args));
        w.__pickGuard = guard;
        return { probe: w.__pickProbe() as SceneProbe, selfTest };
      });
      const probeBefore = install.probe;
      // the run is invalid unless each self-test edit alone is enough to reject it
      const blind = Object.entries(install.selfTest)
        .filter(([, counts]) => !sceneChanges(probeBefore, probeBefore, counts, 0).length)
        .map(([label]) => label);
      // idempotent: restores the wrappers and disconnects the observer whatever pass A/B threw
      const teardown = () =>
        page.evaluate(() => {
          const w = globalThis as any;
          const guard = w.__pickGuard;
          if (!guard) return null;
          delete w.__pickGuard;
          guard.observer.takeRecords().forEach(guard.note);
          guard.observer.disconnect();
          if (guard.original) w.pickRelief = guard.original;
          if (guard.prepare) w.prepareReliefIcons = guard.prepare;
          return {
            probe: w.__pickProbe() as SceneProbe,
            mutations: guard.state.counts as MutationCounts,
            mutationLog: guard.state.log,
            pickReliefCalls: guard.pickReliefCalls as number,
            materializeCalls: guard.materializeCalls as number,
            targets: guard.targets.length as number,
            disconnected: guard.targets.filter((element: Element) => !element.isConnected).length as number
          };
        });
      const passes = async () => {
      const sampled = await page.evaluate(
        ({ points, tolerance, mapOffset, edgeBand, edgeRing }) => {
          const w = globalThis as any;
          const status = w.rendererStatus?.();
          const viewbox = document.getElementById("viewbox") as any;
          const transform = viewbox.getAttribute("transform");
          const globalsCamera = { k: (0, eval)("scale"), x: (0, eval)("viewX"), y: (0, eval)("viewY") };
          const inverse = viewbox.getScreenCTM().inverse();
          // Blink keeps the last hit-test results keyed by the 1/64 CSS px cell of the point and answers a later query
          // in the same cell from that cache, though the test itself is exact: two queries elsewhere evict it
          const bust = () => {
            document.elementFromPoint(0.3, 0.3);
            document.elementFromPoint(1.7, 1.7);
          };
          const describe = (start: Element | null) => {
            const chain: any[] = [];
            let node: Element | null = start;
            for (let i = 0; i < 5; i++) {
              chain.push(
                node
                  ? {
                      tag: node.tagName,
                      id: node.id || "",
                      ...((node as HTMLElement).dataset?.id !== undefined ? { dataId: (node as HTMLElement).dataset.id } : {})
                    }
                  : null
              );
              node = node?.parentElement ?? null;
            }
            const closestSvg = start?.closest("svg");
            const text = start?.tagName === "tspan" ? start.parentElement?.parentElement : null;
            // a materialized glyph: which <use> instance editReliefIcon would open, keyed like relief-canvas reliefKey
            const instance =
              start?.tagName === "use" && start.parentElement?.id === "terrain"
                ? (start.id || "") +
                  "|" +
                  start.getAttribute("href") +
                  "@" +
                  start.getAttribute("x") +
                  "," +
                  start.getAttribute("y")
                : null;
            return {
              chain,
              ...(closestSvg ? { closestSvgId: closestSvg.id } : {}),
              ...(text ? { textId: text.id } : {}),
              ...(instance !== null ? { instance } : {})
            };
          };
          const map = document.getElementById("map")!;
          const timings: [pick: number, select: number][] = [];
          const targets: Element[] = (w.__pickGuard.targets = []);
          // pass A: read-only hit tests only; the canvas fallbacks wait for pass B
          const rows = points.map(({ x, y, source }) => {
            bust();
            const hit = document.elementFromPoint(x, y);
            const inMap = !!hit && map.contains(hit);
            if (hit && inMap) targets.push(hit);
            // edge band: probe hits on the band circle that differ from the centre's element (consecutive probes sit
            // in distinct 1/64 px cells, so Blink's last-hit cache never answers for them)
            const ring: (ReturnType<typeof describe> | null)[] = [];
            if (hit && inMap && edgeBand > 0)
              for (let j = 0; j < edgeRing; j++) {
                const a = (2 * Math.PI * j) / edgeRing;
                const probe = document.elementFromPoint(x + edgeBand * Math.cos(a), y + edgeBand * Math.sin(a));
                if (probe !== hit) ring.push(probe && map.contains(probe) ? describe(probe) : null);
              }
            const world = new DOMPoint(x, y).matrixTransform(inverse);
            const t0 = performance.now();
            const gpu = w.gpuPick?.(x - mapOffset[0], y - mapOffset[1], tolerance) ?? null;
            const t1 = performance.now();
            const gpuElement = gpu?.id ? document.getElementById(gpu.id) : null;
            // production pipeline (src/gpu/selection.ts); serialized like the oracle's relief descriptor
            const t2 = performance.now();
            const picked = w.gpuSelect?.(x - mapOffset[0], y - mapOffset[1], tolerance) ?? null;
            timings.push([t1 - t0, performance.now() - t2]);
            // gpuSelect is read-only: a relief candidate's id is already the reliefKey descriptor
            const semantic = picked
              ? { kind: picked.kind, id: picked.id, branch: picked.branch, via: picked.via, glyph: picked.glyph ?? null,
                  unavailable: picked.unavailable ?? null }
              : null;
            return {
              x,
              y,
              source,
              inMap,
              svg: inMap ? describe(hit) : null,
              ring: ring.length ? ring : null,
              outside: inMap ? undefined : hit ? hit.tagName + "#" + hit.id : null,
              fallbackAvailable: !!w.pickRelief,
              svgWorld: [world.x, world.y],
              gpu,
              gpuDesc: gpuElement ? describe(gpuElement) : null,
              semantic
            };
          });
          // query latency (performance.now, coarsened by the browser) and the prepared PickIndex footprint
          const quantile = (values: number[], q: number) =>
            values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))] : null;
          const series = (i: 0 | 1) => timings.map(t => t[i]);
          const query = {
            samples: timings.length,
            pickMs: { p50: quantile(series(0), 0.5), p95: quantile(series(0), 0.95), max: quantile(series(0), 1) },
            selectMs: { p50: quantile(series(1), 0.5), p95: quantile(series(1), 0.95), max: quantile(series(1), 1) },
            pickIndexBytes: w.gpuRenderer?.prepared?.pick?.bytes?.() ?? null,
            // cumulative renderer split (whole run, timed + untimed queries): availability guard vs index query
            profile: (() => {
              const t = w.gpuRenderer?.telemetry?.();
              return t ? { ...t.pickProfile, dialogScans: t.dialogScans } : null;
            })(),
            // materialized #terrain: [href, unsupported reason | null, instances] per href, from prepared data
            reliefSupport: w.gpuRenderer?.reliefSupport?.() ?? null
          };
          return { status, transform, globalsCamera, rows, query };
        },
        { points, tolerance: TOLERANCE, mapOffset, edgeBand, edgeRing: EDGE_RING }
      );

      // pass B: clicked()'s canvas fallbacks, only where no DOM branch matched; burg first, relief only without a burg
      const unmatched = sampled.rows
        .map((r, i) => (r.fallbackAvailable && needsFallback(r.svg as ChainDesc | null) ? i : -1))
        .filter(i => i >= 0);
      const fallbacks: Record<number, { burg: number | null; relief: string | null }> = await page.evaluate(
        ({ queries }) => {
          const w = globalThis as any;
          const out: Record<number, { burg: number | null; relief: string | null }> = {};
          for (const [i, x, y] of queries) {
            const burg = w.pickBurg?.(x, y) || null;
            out[i] = { burg, relief: burg ? null : (w.peekRelief?.(x, y)?.key ?? null) };
          }
          return out;
        },
        { queries: unmatched.map(i => [i, ...sampled.rows[i].svgWorld] as [number, number, number]) }
      );
      // pass C (diagnostics only, still under the guard): for a few representative semantic mismatches per class, the
      // native SVG geometry of the expected and candidate elements beside our indexed items. Expected global hit testing
      // stays expected-only; the candidate side is read by id with geometry queries, never by point hit testing.
      const chosen = selectDiagnostics(
        sampled.rows.flatMap((r, i) =>
          r.semantic && r.svg
            ? [{ i, expected: classifyClick(r.svg as ChainDesc, { available: r.fallbackAvailable, queried: i in fallbacks, ...(fallbacks[i] ?? {}) }), actual: r.semantic as Selection }]
            : []
        )
      );
      const probes = Object.entries(chosen).flatMap(([name, list]) =>
        list.map(({ i, expected, actual }) => {
          const r = sampled.rows[i];
          return { name, i, x: r.x, y: r.y, source: r.source, world: r.svgWorld, expected, semantic: actual, gpuRaw: r.gpu };
        })
      );
      const geometry = await page.evaluate(
        ({ probes }) => {
          const w = globalThis as any;
          const round = (v: number) => Math.round(v * 1000) / 1000;
          const matrix = (m: DOMMatrix | null) => (m ? [m.a, m.b, m.c, m.d, m.e, m.f].map(round) : null);
          const rect = (b: { x: number; y: number; width: number; height: number }) => [b.x, b.y, b.width, b.height].map(round);
          const local = (element: any, x: number, y: number) => {
            const ctm = element.getScreenCTM?.();
            if (!ctm) return null;
            const p = new DOMPoint(x, y).matrixTransform(ctm.inverse());
            return [round(p.x), round(p.y)];
          };
          const styleOf = (element: Element) => {
            const s = getComputedStyle(element);
            return {
              pointerEvents: s.pointerEvents,
              visibility: s.visibility,
              display: s.display,
              overflow: s.overflow,
              fill: s.fill,
              stroke: s.stroke,
              clipPath: s.clipPath
            };
          };
          const text = (element: any, x: number, y: number) => {
            const s = getComputedStyle(element);
            const at = local(element, x, y);
            const n = element.getNumberOfChars();
            const chars = [];
            for (let k = 0; k < Math.min(n, 40); k++) {
              try {
                chars.push({
                  k,
                  extent: rect(element.getExtentOfChar(k)),
                  start: [element.getStartPositionOfChar(k).x, element.getStartPositionOfChar(k).y].map(round),
                  end: [element.getEndPositionOfChar(k).x, element.getEndPositionOfChar(k).y].map(round)
                });
              } catch (error) {
                chars.push({ k, error: String(error) });
              }
            }
            // Chrome's own hit band for this <text> (expected-side elementsFromPoint, diagnostics only): local extents of
            // the run of points whose stack contains it, scanned through the sample point and the bbox centre
            const ctm = element.getScreenCTM();
            const box = element.getBBox();
            const band = (axis: "x" | "y", through: [number, number]) => {
              const lo = (axis === "x" ? box.x : box.y) - 3,
                hi = (axis === "x" ? box.x + box.width : box.y + box.height) + 3;
              let first = null,
                last = null;
              for (let v = lo; v <= hi; v += 1 / 16) {
                const q = new DOMPoint(axis === "x" ? v : through[0], axis === "y" ? v : through[1]).matrixTransform(ctm);
                if (document.elementsFromPoint(q.x, q.y).some(e => e === element || element.contains(e))) {
                  first ??= v;
                  last = v;
                }
              }
              return first === null ? null : [round(first), round(last!)];
            };
            const centre: [number, number] = [box.x + box.width / 2, box.y + box.height / 2];
            const chromeBand = at
              ? {
                  yAtSampleX: band("y", at as [number, number]),
                  xAtSampleY: band("x", at as [number, number]),
                  yAtCentre: band("y", centre),
                  bbox: rect(box)
                }
              : null;
            return {
              chromeBand,
              font: { size: s.fontSize, family: s.fontFamily, weight: s.fontWeight, letterSpacing: s.letterSpacing },
              anchor: s.textAnchor,
              baseline: { dominant: s.dominantBaseline, alignment: s.alignmentBaseline },
              attributes: Object.fromEntries(
                ["x", "y", "dx", "dy", "transform", "text-anchor", "letter-spacing", "font-size"].map(a => [a, element.getAttribute(a)])
              ),
              children: [...element.children].map((c: Element) => c.tagName + (c.getAttribute("x") ? " x=" + c.getAttribute("x") : "") + (c.getAttribute("dy") ? " dy=" + c.getAttribute("dy") : "")),
              content: element.textContent?.slice(0, 60),
              chars: n,
              charAtLocal: at ? element.getCharNumAtPosition(new DOMPoint(at[0], at[1])) : null,
              cells: chars
            };
          };
          const element = (el: any, x: number, y: number) => {
            if (!el) return null;
            const chain = [];
            for (let node = el; node && chain.length < 6; node = node.parentElement)
              chain.push(node.tagName + (node.id ? "#" + node.id : ""));
            const svg = el.tagName === "svg" ? el : el.parentElement?.closest("svg");
            const nested = svg?.ownerSVGElement ? svg : null;
            let bbox = null;
            try {
              bbox = rect(el.getBBox());
            } catch {}
            const textEl = el.tagName === "text" ? el : el.closest?.("text");
            return {
              chain,
              screenCTM: matrix(el.getScreenCTM?.() ?? null),
              local: local(el, x, y),
              bbox,
              style: styleOf(el),
              ...(textEl ? { text: text(textEl, x, y), textId: textEl.id } : {}),
              ...(nested
                ? {
                    nestedSvg: {
                      id: nested.id,
                      attributes: Object.fromEntries(
                        ["x", "y", "width", "height", "viewBox", "preserveAspectRatio", "overflow"].map(a => [a, nested.getAttribute(a)])
                      ),
                      screenCTM: matrix(nested.getScreenCTM()),
                      parentScreenCTM: matrix(nested.parentElement?.getScreenCTM?.() ?? null),
                      style: styleOf(nested),
                      leaves: [...nested.querySelectorAll("*")].slice(0, 8).map((leaf: any) => {
                        let box = null;
                        try {
                          box = rect(leaf.getBBox());
                        } catch {}
                        return { tag: leaf.tagName, id: leaf.id, href: leaf.getAttribute("href"), bbox: box, local: local(leaf, x, y), style: styleOf(leaf) };
                      })
                    }
                  }
                : {})
            };
          };
          const pick = w.gpuRenderer?.prepared?.pick;
          const status = w.rendererStatus?.()?.gpu;
          return probes.map(p => {
            const expectedHit = document.elementFromPoint(p.x, p.y); // expected side only
            const expectedId = expectedHit ? expectedHit.id || expectedHit.parentElement?.closest("[id]")?.id || "" : "";
            const candidateId = p.gpuRaw?.id ?? "";
            const candidate = candidateId ? document.getElementById(candidateId) : null;
            const ids = [expectedId, candidateId, expectedHit?.closest("text")?.id ?? "", expectedHit?.closest("svg")?.id ?? ""].filter(Boolean);
            return {
              expectedElement: element(expectedHit, p.x, p.y),
              candidateElement: element(candidate, p.x, p.y),
              pickItems: pick?.inspect?.(p.world[0], p.world[1], ids, w.gpuRenderer?.view?.k ? 1 / w.gpuRenderer.view.k : 0) ?? null,
              namedIds: ids,
              revision: { prepared: w.gpuRenderer?.prepared?.revision ?? null, source: status?.revision ?? null, sourceCurrent: status?.sourceCurrent }
            };
          });
        },
        { probes }
      );
      const diagnostics = probes.map((p, k) => {
        const g = geometry[k];
        // keep rings only for the named ids; other candidates are listed by order/id/kind/hit
        const items = (g.pickItems ?? []).map((item: any) =>
          g.namedIds.includes(item.id) ? item : { ...item, rings: undefined, ringCount: item.rings.length }
        );
        return { ...p, ...g, pickItems: items };
      });
      return { sampled, unmatched, fallbacks, diagnostics };
      };
      let result: Awaited<ReturnType<typeof passes>>;
      let guardAfter: Awaited<ReturnType<typeof teardown>>;
      try {
        result = await passes();
      } finally {
        guardAfter = await teardown();
      }
      const { sampled, unmatched, fallbacks, diagnostics } = result;
      diagnosticRows.push({ world, view: index, rows: diagnostics });
      if (!guardAfter) throw new Error("scene guard vanished before teardown");
      const changes = sceneChanges(probeBefore, guardAfter.probe, guardAfter.mutations, guardAfter.pickReliefCalls);
      if (guardAfter.materializeCalls) changes.push("prepareReliefIcons calls: " + guardAfter.materializeCalls);
      if (guardAfter.disconnected) changes.push("sampled targets disconnected: " + guardAfter.disconnected);
      if (blind.length) changes.push("guard self-test missed: " + blind.join(", "));
      view.sceneGuard = {
        before: probeBefore,
        after: guardAfter.probe,
        selfTest: install.selfTest,
        mutations: guardAfter.mutations,
        mutationLog: guardAfter.mutationLog,
        pickReliefCalls: guardAfter.pickReliefCalls,
        materializeCalls: guardAfter.materializeCalls,
        targets: guardAfter.targets,
        disconnected: guardAfter.disconnected,
        fallbackQueries: unmatched.length,
        changes,
        valid: !changes.length
      };
      if (changes.length) view.errors.push("rejected: scene changed during sampling: " + changes.join("; "));

      if (phase === "motion") {
        view.motionStatusAfterSampling = await page.evaluate(() => (globalThis as any).rendererStatus?.());
        await page.mouse.up();
      }

      // cells: GPU camera from the globals main.js writes on every camera update; oracle = brute-force nearest site
      const cells = await page.evaluate(
        ({ rows, band }) => {
          const w = globalThis as any;
          const k = (0, eval)("scale"),
            vx = (0, eval)("viewX"),
            vy = (0, eval)("viewY");
          const p = w.pack.cells.p as [number, number][];
          return rows.map(({ x, y, svgWorld, mapOffset }: any) => {
            const gx = (x - mapOffset[0] - vx) / k,
              gy = (y - mapOffset[1] - vy) / k;
            const gpuCell = w.findCell(gx, gy);
            let best = -1,
              second = -1,
              bd = Infinity,
              sd = Infinity;
            for (let i = 0; i < p.length; i++) {
              const d = (p[i][0] - svgWorld[0]) ** 2 + (p[i][1] - svgWorld[1]) ** 2;
              if (d < bd) {
                second = best;
                sd = bd;
                best = i;
                bd = d;
              } else if (d < sd) {
                second = i;
                sd = d;
              }
            }
            return { gpuCell, oracleCell: best, runnerUp: second, k, band };
          });
        },
        { rows: sampled.rows.map(r => ({ x: r.x, y: r.y, svgWorld: r.svgWorld, mapOffset })), band: CELL_BAND }
      );
      const sites = await page.evaluate(
        (ids: number[]) => ids.map(i => (globalThis as any).pack.cells.p[i]),
        cells.flatMap(c => [c.oracleCell, c.runnerUp])
      );


      const t = sampled.status?.gpu;
      const [, tx, ty, tk] = /translate\(([-\d.e]+)[ ,]+([-\d.e]+)\)\s*scale\(([-\d.e]+)/.exec(sampled.transform || "") || [];
      const aligned =
        !!tk &&
        Math.abs(+tk - sampled.globalsCamera.k) < 1e-6 &&
        Math.abs(+tx - sampled.globalsCamera.x) < 1e-3 &&
        Math.abs(+ty - sampled.globalsCamera.y) < 1e-3;
      view.rendererStatus = {
        active: sampled.status?.active,
        state: t?.state,
        canvasVisible: t?.canvasVisible,
        sourceCurrent: t?.sourceCurrent,
        windows: t?.windows?.coverage,
        pending: t?.pending,
        refinementPending: t?.refinementPending,
        moving: t?.moving,
        suspendedReason: t?.suspendedReason ?? null,
        compat: t?.compat ?? null
      };
      view.oracleCamera = { svgTransform: sampled.transform, globals: sampled.globalsCamera, aligned };
      view.query = sampled.query;
      const ready =
        sampled.status?.active === "gpu" &&
        t?.state === "active" &&
        t?.canvasVisible &&
        t?.sourceCurrent &&
        t?.windows?.coverage === "covered" &&
        !t?.pending &&
        !t?.refinementPending;
      view.gpuReady = !!ready;
      if (phase === "settled" && !ready) view.errors.push("GPU not active/visible/current/covered/ready at sampling");
      if (phase === "settled" && !aligned) view.errors.push("SVG oracle camera not aligned with exact camera");
      view.valid = view.sceneGuard.valid && (phase !== "settled" || (!!ready && !!aligned));

      const samples = sampled.rows.map((r, i) => {
        const fallback = { available: r.fallbackAvailable, queried: i in fallbacks, ...(fallbacks[i] ?? {}) };
        const expected: Selection = r.svg
          ? classifyClick(r.svg as ChainDesc, fallback)
          : { kind: "none", id: "", branch: "outside-map" };
        const actual = normalizeGpu(r.gpuDesc as ChainDesc | null, r.gpu?.id || "", r.gpu?.depth || 0);
        const svgRawId = r.svg ? (r.svg.chain.find((n: any) => n?.id)?.id ?? "") : "";
        const c = cells[i];
        const s1 = sites[i * 2],
          s2 = sites[i * 2 + 1];
        const borderPx = s1 && s2 ? bisectorDistance(r.svgWorld[0], r.svgWorld[1], s1, s2) * c.k : Infinity;
        return {
          i,
          view: index,
          x: r.x,
          y: r.y,
          source: r.source,
          inMap: r.inMap,
          edge: inEdgeBand(r.svg as ChainDesc | null, r.ring as (ChainDesc | null)[] | null),
          outside: r.outside,
          svgTarget: r.svg?.chain[0] ?? null,
          svgRawId,
          expected,
          fallback,
          gpuRaw: r.gpu,
          actual,
          outcome: compareSelections(expected, actual),
          semantic: r.semantic as (Selection & { via: string }) | null,
          semanticOutcome: r.semantic ? compareSelections(expected, r.semantic as Selection) : null,
          cell: { gpu: c.gpuCell, oracle: c.oracleCell, borderPx, inBand: borderPx <= CELL_BAND }
        };
      });
      return { view, samples, keys: picked.keys };
  };

  for (const world of worlds) {
    const row: any = { world, phase, errors: [], views: [] };
    report.results.push(row);
    try {
      if (world !== "100k-labels") {
        const text = world === "shared" ? sharedText : world === "parity" ? parityText : "";
        row.enrichment = await page.evaluate(
          async ({ world, text }) => {
            const runtime = (globalThis as any).__tupaia;
            const w = globalThis as any;
            const result =
              world === "100k"
                ? await runtime.fns.generateMap({
                    cells: 100000,
                    seed: "7319",
                    template: "continents",
                    width: 1280,
                    height: 720,
                    timeoutMs: 300000
                  })
                : await runtime.fns.loadMap({ text, timeoutMs: 300000 });
            if (result?.ok === false) throw new Error(JSON.stringify(result));
            const displayed = await runtime.call("display", { on: ["heightmap", "relief"] });
            if (!displayed.ok) throw new Error(JSON.stringify(displayed));
            await Promise.all([w.reliefRenderReady, w.burgRenderReady]);
            // the shared world has no regiments: the app's own Tools > Regenerate > Military, under a seeded Math.random
            let enrichment = null;
            if (world === "shared" && !document.querySelector("#armies > g > g")) {
              const native = Math.random;
              let a = 0x5eed;
              Math.random = () => {
                a = (a + 0x6d2b79f5) >>> 0;
                let t = a;
                t = Math.imul(t ^ (t >>> 15), t | 1);
                t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
              };
              try {
                w.regenerateMilitary();
              } finally {
                Math.random = native;
              }
              enrichment = { kind: "regiments", api: "regenerateMilitary() with Math.random = mulberry32(0x5eed)", regiments: document.querySelectorAll("#armies > g > g").length };
            }
            await runtime.settle();
            return enrichment;
          },
          { world, text }
        );
      }
      if (world === "100k-labels") {
        const base = report.results[report.results.length - 2];
        if (base?.world !== "100k" || base.errors.length) throw new Error("100k-labels needs an error-free 100k row before it");
        row.fixture = { kind: "label", added: 0, texts: "Fx01..Fx64", api: "__tupaia.call(\"add\", { type: \"label\", phase: \"apply\", items })" };
        // 64 labels through the app's own add (bridge-mutations.js FNS.add, label handler), in-memory DOM only
        const placed = await page.evaluate(
          async ({ k, cells }) => {
            const runtime = (globalThis as any).__tupaia;
            const w = globalThis as any;
            // same centre as the primary camera: live burg nearest the map centre (map centre at k=1)
            const cx = w.graphWidth / 2,
              cy = w.graphHeight / 2;
            let x = cx,
              y = cy;
            if (k > 1) {
              let best = Infinity;
              for (const burg of w.pack.burgs)
                if (burg?.i && !burg.removed) {
                  const d = (burg.x - cx) ** 2 + (burg.y - cy) ** 2;
                  if (d < best) [best, x, y] = [d, burg.x, burg.y];
                }
            }
            // 8 x 8 screen grid inside x 60..1220, y 60..660, then to world at the camera: wx = x + (sx - 640) / k
            const items = Array.from({ length: cells }, (_, n) => {
              const sx = 60 + (1160 * ((n % 8) + 0.5)) / 8,
                sy = 60 + (600 * (Math.floor(n / 8) + 0.5)) / 8;
              return { at: { x: x + (sx - 640) / k, y: y + (sy - 360) / k }, text: "Fx" + String(n + 1).padStart(2, "0") };
            });
            // phase "apply" is required (runBatch validates only otherwise); item failures set value.errors, not ok=false
            const result = await runtime.call("add", { type: "label", phase: "apply", items });
            const created = result.value?.created ?? [];
            if (!result.ok || result.value?.aborted || result.value?.errors?.length || created.length !== cells)
              throw new Error("label fixture add failed: " + JSON.stringify(result).slice(0, 600));
            await runtime.settle?.();
            return { added: created.length, center: { x, y } };
          },
          { k: zoom, cells: 64 }
        );
        row.fixture.added = placed.added;
        row.fixture.center = placed.center;
      }

      // the views: the primary camera, then windows on whatever required kind it shows too few of
      const stock = await inventory();
      const primary = await setCamera(null);
      const centre: [number, number] = [primary.center.x, primary.center.y];
      const centres =
        world === "100k-labels"
          ? [centre]
          : planViews(stock.kinds, centre, zoom, {
              width: VIEW.width,
              height: VIEW.height,
              mapWidth: stock.map.width,
              mapHeight: stock.map.height,
              need: NEED_VISIBLE,
              max: maxViews,
              kinds: PLAN_KINDS
            });
      row.plan = {
        inventory: Object.fromEntries(Object.entries(stock.kinds).map(([kind, list]) => [kind, list.length])),
        views: centres.map(c => c.map(v => Math.round(v * 100) / 100))
      };
      if (row.fixture && (row.fixture.center.x !== centre[0] || row.fixture.center.y !== centre[1]))
        throw new Error("fixture centre differs from camera centre: " + JSON.stringify([row.fixture.center, centre]));

      const quota: Record<string, number> = Object.fromEntries(GENERATORS.map(kind => [kind, TARGET_BY_KIND[kind] ?? TARGET]));
      const used: Record<string, string[]> = Object.fromEntries(GENERATORS.map(kind => [kind, []]));
      const samples: any[] = [];
      for (const [index, c] of centres.entries()) {
        try {
          const done = await runView(world, index, index ? c : null, quota, used);
          row.views.push(done.view);
          for (const error of done.view.errors) row.errors.push(`view ${index}: ${error}`);
          samples.push(...done.samples);
          for (const [kind, keys] of Object.entries(done.keys)) {
            used[kind].push(...keys);
            quota[kind] -= done.view.sampling.targeted[kind]?.points ?? 0;
          }
        } catch (error) {
          row.views.push({ index, errors: [String((error as Error)?.stack || error)], valid: false });
          row.errors.push(`view ${index}: ` + String((error as Error)?.stack || error));
        }
      }

      // Occluded: the topmost element is page UI over the map (e.g. #collapsible), so a real click there never reaches
      // clicked() under either renderer and no editor can open. No element at all: the same, nothing receives the
      // click. Kept in samples/mismatches, counted, and excluded from the agreement sets (gates) only;
      // occludedGpuHits reports what the candidate index would have claimed there.
      const occluded = samples.filter(s => !s.inMap && !!s.outside);
      const noHit = samples.filter(s => !s.inMap && !s.outside);
      const eligible = samples.filter(s => s.inMap);
      const bySource = (prefix: string) => eligible.filter(s => s.source.startsWith(prefix));
      const sets = { uniform: bySource("uniform"), targeted: eligible.filter(s => s.source !== "uniform"), all: eligible };
      row.counts = {
        total: samples.length,
        views: row.views.length,
        uniform: sets.uniform.length,
        targeted: sets.targeted.length,
        bySource: Object.fromEntries([...new Set(samples.map(s => s.source))].map(source => [source, samples.filter(s => s.source === source).length])),
        outsideMap: samples.filter(s => !s.inMap).length,
        occludedExcluded: occluded.length,
        noHitExcluded: noHit.length,
        occludedGpuHits: occluded.filter(s => s.gpuRaw).length,
        occludedBy: Object.fromEntries(
          [...new Set(occluded.map(s => s.outside))].map(o => [o, occluded.filter(s => s.outside === o).length])
        ),
        gpuRawHits: samples.filter(s => s.gpuRaw).length,
        gpuUnresolvedIds: samples.filter(s => s.actual.branch === "unresolved-id").length,
        svgBranches: Object.fromEntries(
          [...new Set(samples.map(s => s.expected.branch))].map(b => [b, samples.filter(s => s.expected.branch === b).length])
        ),
        gpuLayers: Object.fromEntries(
          [...new Set(samples.map(s => s.gpuRaw?.layer ?? "null"))].map(l => [
            l,
            samples.filter(s => (s.gpuRaw?.layer ?? "null") === l).length
          ])
        )
      };
      const cellRows = samples.filter(s => s.inMap);
      const outsideBand = cellRows.filter(s => !s.cell.inBand);
      row.cells = {
        sampled: cellRows.length,
        inBand: cellRows.length - outsideBand.length,
        gated: outsideBand.length,
        agree: outsideBand.filter(s => s.cell.gpu === s.cell.oracle).length,
        inBandAgree: cellRows.filter(s => s.cell.inBand && s.cell.gpu === s.cell.oracle).length
      };
      // raw gpuPick ids normalized to a selection: reported only (D3)
      row.agreement = { note: "raw window.gpuPick normalized by picking-oracle normalizeGpu; reported only, never gated (D3)" } as any;
      for (const [label, set] of Object.entries(sets)) {
        const raw = set.filter(s => s.inMap);
        row.agreement[label] = {
          kinds: tally(set),
          noneAgree: set.filter(s => s.outcome === "agree-none").length,
          rawIdAgree: raw.filter(s => (s.gpuRaw?.id ?? "") === s.svgRawId).length,
          rawIdCompared: raw.length
        };
      }
      // D3 gate: the semantic outcome (window.gpuSelect) against the same oracle, per cohort
      const valid = row.views.length === centres.length && row.views.every((v: any) => v.valid);
      if (!samples.every(s => s.semantic)) throw new Error("gpuSelect unavailable on " + samples.filter(s => !s.semantic).length + " samples");
      const pairs = (set: typeof eligible) => set.map(s => ({ expected: s.expected, actual: s.semantic as Selection }));
      const gated = eligible.filter(s => !s.edge);
      const kinds = tally(pairs(gated));
      const required = REQUIRED_WORLDS.includes(world) ? REQUIRED : [];
      const verdict = cohortGate(kinds, { valid, settled: phase === "settled", required });
      // the same verdicts over every eligible sample, edge band included: reported, never gated
      const strict = cohortGate(tally(pairs(eligible)), { valid, settled: phase === "settled", required });
      const banded = eligible.filter(s => s.edge);
      const bandKinds = tally(pairs(banded));
      const bandAgree = banded.filter(s => s.semanticOutcome === "agree" || s.semanticOutcome === "agree-none").length;
      // the band is gated at its own floor (BAND_MIN_RATE), so a sub-band hit-shape regression cannot hide in it
      const band = edgeBandGate({ n: banded.length, agree: bandAgree }, bandKinds, { valid, settled: phase === "settled" });
      const cellsPass = valid && phase === "settled" && row.cells.gated > 0 && row.cells.agree === row.cells.gated;
      row.gate = {
        cohorts: verdict.cohorts,
        cells: { n: row.cells.gated, agree: row.cells.agree, rate: row.cells.gated ? row.cells.agree / row.cells.gated : null, pass: cellsPass },
        edgeBand: {
          px: edgeBand,
          excluded: banded.length,
          agree: bandAgree,
          minRate: BAND_MIN_RATE,
          kinds: Object.fromEntries(
            Object.entries(bandKinds).map(([kind, t]) => [kind, { n: t.expected + t.extra + t.wrongInto, agree: t.agree }])
          ),
          cohorts: band.cohorts,
          failures: band.failures
        },
        strict: {
          note: "every eligible sample, edge band included; reported only",
          cohorts: Object.fromEntries(
            Object.entries(strict.cohorts).map(([kind, c]) => [kind, { ...c, status: c.status === "rejected" ? c.status : "reported", wouldBe: c.status }])
          ),
          failures: strict.failures
        },
        failures: [...verdict.failures, ...band.failures, ...(phase === "settled" && valid && !cellsPass ? [`cells ${row.cells.agree}/${row.cells.gated}`] : [])],
        note: `D3: actual = window.gpuSelect; a cohort with n>=${MIN_COHORT} needs >=${MIN_RATE * 100}%; n = expected + extra + wrongInto; samples within the ${edgeBand} CSS px edge band gated separately at >=${BAND_MIN_RATE * 100}% per world and per band cohort with n>=${MIN_COHORT} (strict = all, reported)`
      };
      row.semantic = {
        note: "actual = window.gpuSelect (src/gpu/selection.ts); oracle unchanged",
        kinds,
        bySource: Object.fromEntries(
          Object.entries(sets).map(([label, set]) => [label, tally(set.map(s => ({ expected: s.expected, actual: s.semantic as Selection })))])
        ),
        via: Object.fromEntries(
          [...new Set(eligible.map(s => s.semantic!.via))].map(v => [v, eligible.filter(s => s.semantic!.via === v).length])
        ),
        mismatches: eligible
          .filter(s => s.semanticOutcome === "missing" || s.semanticOutcome === "extra" || s.semanticOutcome === "wrong")
          .map(s => ({
            i: s.i,
            view: s.view,
            x: s.x,
            y: s.y,
            edge: s.edge,
            source: s.source,
            svgRawId: s.svgRawId,
            expected: s.expected,
            gpuRaw: s.gpuRaw,
            semantic: s.semantic,
            outcome: s.semanticOutcome
          }))
      };
      const mismatches = samples.filter(
        s =>
          s.outcome === "missing" ||
          s.outcome === "extra" ||
          s.outcome === "wrong" ||
          (!s.cell.inBand && s.inMap && s.cell.gpu !== s.cell.oracle)
      );
      row.mismatchCount = mismatches.length;
      row.mismatches = mismatches;
      row.samples = samples;
    } catch (error) {
      row.errors.push(String((error as Error)?.stack || error));
    }
  }
  report.pageErrors = errors;
  // fixture rows (labeled dense world) never enter the natural failure, exit code or gates; their own errors and verdicts are separate
  const natural = report.results.filter((r: any) => !r.fixture);
  const failed = natural.filter((r: any) => r.errors.length || r.gate?.failures?.length);
  if (failed.length)
    report.failure = failed
      .map((r: any) => r.world + ": " + [...r.errors, ...(r.gate?.failures ?? [])].join("; "))
      .join(" | ");
  const fixtureFailed = report.results.filter((r: any) => r.fixture && r.errors.length);
  if (fixtureFailed.length) report.fixtureFailure = fixtureFailed.map((r: any) => r.world + ": " + r.errors.join("; ")).join(" | ");
  // same frozen rule (>=50 eligible, rate >= 99.5%, cells exact) as the natural gates, reported under its own key only
  report.fixtureVerdicts = Object.fromEntries(
    report.results
      .filter((r: any) => r.fixture)
      .map((r: any) => [
        r.world,
        {
          label: r.gate?.cohorts?.label ?? null,
          cells: r.gate?.cells ?? null,
          pass: r.gate?.cohorts?.label?.status === "pass" && !!r.gate?.cells?.pass,
          errors: r.errors.length
        }
      ])
  );
} catch (error) {
  report.failure = String((error as Error)?.stack || error);
} finally {
  await browser.close();
  await new Promise<void>(done => server.close(() => done()));
}
writeFileSync(output, JSON.stringify(report));
// small, pretty, multi-line companion; the raw report schema is unchanged
writeFileSync(
  diagnosticsPath,
  JSON.stringify(
    {
      note:
        "diagnostics only, never part of any gate: <=5 semantic mismatches per class and view, read-only native SVG " +
        "geometry (expected via elementFromPoint, candidate by id) beside PickIndex.inspect items (topmost first)",
      report: output,
      config: report.config && { dpr, zoom, phase, reliefMode, launcher, adapter: report.config.adapter },
      worlds: diagnosticRows
    },
    null,
    1
  )
);
const cohortLine = (c: any) => `${c.agree}/${c.n}${c.rate === null ? "" : " " + (100 * c.rate).toFixed(2) + "%"} ${c.status}${c.required ? "*" : ""}`;
const summary = {
  name,
  schema: report.schema,
  protocol: report.protocol,
  config: { dpr, zoom, phase, worlds, reliefMode, launcher, adapter: report.config.adapter?.renderer ?? null },
  failure: report.failure,
  fixtureFailure: report.fixtureFailure,
  fixtureVerdicts: report.fixtureVerdicts,
  blocked: blocked.length,
  results: report.results.map((r: any) => ({
    world: r.world,
    fixture: r.fixture,
    enrichment: r.enrichment,
    plan: r.plan,
    views: (r.views ?? []).map((v: any) => ({
      index: v.index,
      camera: v.camera?.requested,
      valid: v.valid,
      sampling: v.sampling && { total: v.sampling.total, targeted: v.sampling.targeted },
      sceneGuard: v.sceneGuard && { valid: v.sceneGuard.valid, changes: v.sceneGuard.changes, mutations: v.sceneGuard.mutations },
      oracleAligned: v.oracleCamera?.aligned,
      gpuReady: v.gpuReady,
      pickP95Ms: v.query?.pickMs?.p95,
      selectP95Ms: v.query?.selectMs?.p95,
      errors: v.errors
    })),
    counts: r.counts,
    cohorts: r.gate && Object.fromEntries(Object.entries(r.gate.cohorts).map(([k, c]) => [k, cohortLine(c)])),
    edgeBand: r.gate?.edgeBand && {
      px: r.gate.edgeBand.px,
      excluded: r.gate.edgeBand.excluded,
      agree: r.gate.edgeBand.agree,
      cohorts: Object.fromEntries(Object.entries(r.gate.edgeBand.cohorts ?? {}).map(([k, c]) => [k, cohortLine(c)]))
    },
    strict: r.gate?.strict && Object.fromEntries(Object.entries(r.gate.strict.cohorts).map(([k, c]: [string, any]) => [k, cohortLine({ ...c, status: c.wouldBe })])),
    cells: r.gate?.cells,
    gateFailures: r.gate?.failures,
    raw: r.agreement && {
      cohorts: Object.fromEntries(
        Object.entries(r.agreement.all.kinds as Record<string, any>).map(([k, t]) => [k, `${t.agree}/${t.expected + t.extra + t.wrongInto}`])
      ),
      ids: `${r.agreement.all.rawIdAgree}/${r.agreement.all.rawIdCompared}`
    },
    semantic: r.semantic && { via: r.semantic.via, mismatchCount: r.semantic.mismatches?.length },
    firstSemanticMismatches: (r.semantic?.mismatches || []).slice(0, 20).map((m: any) => ({
      view: m.view,
      x: +m.x.toFixed(2),
      y: +m.y.toFixed(2),
      source: m.source,
      edge: m.edge,
      outcome: m.outcome,
      expected: m.expected.kind + ":" + m.expected.id + "(" + m.expected.branch + ")",
      gpu: m.gpuRaw ? m.gpuRaw.layer + "/" + m.gpuRaw.id : null,
      actual: m.semantic.kind + ":" + m.semantic.id + "(" + m.semantic.branch + ")"
    })),
    errors: r.errors
  }))
};
console.log(JSON.stringify(summary));
if (report.failure) process.exitCode = 1;
