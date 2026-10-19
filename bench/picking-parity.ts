// G-P picking parity: GPU pick index vs. the real SVG click path, per fixture and camera.
// Oracle = document.elementFromPoint on the canonical SVG + the clicked() branch rules (picking-oracle.ts), including
// its pickBurg/pickRelief canvas fallback at d3.mouse(viewbox) coordinates. The GPU side = window.gpuPick at the same
// CSS pixel, normalized to an editor selection; raw ids are kept too. Cells are compared separately: findCell at the
// GPU camera vs. a brute-force nearest-site oracle at the SVG CTM, with a disclosed <=1px border band excluded.
// Everything runs in an isolated local browser: local GET + fonts.gstatic GET only, service workers blocked.
// Protocol v2 (schema 2): v1 called window.pickRelief per sample, which materializes <use> glyphs into #terrain and so
// mutated the scene mid-run. v2 freezes the relief regime (PICK_RELIEF_MODE compact | materialized) before the GPU is
// readied, samples read-only in two passes (A: elementFromPoint + gpuPick/gpuSelect; B: pickBurg, then the pure
// peekRelief, only for points no DOM branch matched), and rejects the run if anything structural changed in between.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import {
  bisectorDistance,
  type ChainDesc,
  classifyClick,
  compareSelections,
  COMPARABLE,
  GATED,
  mulberry32,
  type MutationCounts,
  needsFallback,
  normalizeGpu,
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
const worlds = (process.env.PICK_WORLDS || "shared,100k,100k-labels").split(",");
const reliefMode = process.env.PICK_RELIEF_MODE || "compact";
if (!["compact", "materialized"].includes(reliefMode)) throw new Error("PICK_RELIEF_MODE must be compact or materialized");
if (![1, 2].includes(dpr)) throw new Error("PICK_DPR must be 1 or 2");
if (![1, 2, 4, 8].includes(zoom)) throw new Error("PICK_ZOOM must be 1, 2, 4 or 8");
if (!["settled", "motion"].includes(phase)) throw new Error("PICK_PHASE must be settled or motion");
if (worlds.some(world => !["shared", "100k", "100k-labels"].includes(world))) throw new Error("PICK_WORLDS: shared,100k,100k-labels");
// 100k-labels is a fixture on the 100k map already loaded by the row right before it (never regenerated)
if (worlds.some((world, i) => world === "100k-labels" && worlds[i - 1] !== "100k"))
  throw new Error("PICK_WORLDS: 100k-labels must directly follow 100k");
if (existsSync(output)) throw new Error("PICK_OUTPUT exists; results are immutable: " + output);
const diagnosticsPath = output.replace(/\.json$/, "") + ".diagnostics.json";
if (existsSync(diagnosticsPath)) throw new Error("diagnostics exist; results are immutable: " + diagnosticsPath);
const diagnosticRows: { world: string; rows: unknown[] }[] = [];

const UNIFORM = 500;
const TARGETED_PER_KIND = 150; // per kind: centers and one seeded jitter each
const JITTER = 2; // CSS px
const TOLERANCE = 0; // gpuPick tolerance; SVG hit testing has none
const CELL_BAND = 1; // CSS px from a Voronoi border, excluded from the cell gate only
const VIEW = { width: 1280, height: 720 };

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
const sharedText = readFileSync(mapPath, "utf8");
const fixtureHash = createHash("sha256").update(sharedText).digest("hex");

const report: any = {
  schema: 2,
  protocol: "v2",
  name,
  config: {
    dpr,
    zoom,
    phase,
    worlds,
    reliefMode,
    map: mapPath,
    mapSha256: fixtureHash,
    generated: { cells: 100000, seed: "7319", template: "continents", width: 1280, height: 720 },
    viewport: VIEW,
    uniform: UNIFORM,
    targetedPerKind: TARGETED_PER_KIND,
    jitterPx: JITTER,
    gpuTolerancePx: TOLERANCE,
    cellBorderBandPx: CELL_BAND,
    oracle:
      "frozen relief regime; elementFromPoint on canonical SVG + clicked() DOM branches; only if none matched: " +
      "pickBurg, then read-only peekRelief (href@x,y descriptor) at viewbox CTM; pickRelief never called",
    guards:
      "TradeAnimation.stop() in setup, MutationObserver childList on #map, #terrain FNV hash + child count, relief revision, prepared GPU scene, " +
      "camera, pickRelief call counter, sampled targets still connected; any change rejects the run",
    gpu: "window.gpuPick(svg-local CSS px, tolerance 0) -> DOM element by id -> editor selection",
    cells: "findCell at GPU camera world vs brute-force nearest pack.cells.p at SVG CTM world (CPU, no GPU id buffer)",
    gated: GATED,
    comparable: COMPARABLE,
    network: "local GET + fonts.gstatic.com GET only; service workers blocked; autosave 0"
  },
  results: [],
  blockedRequests: blocked,
  failure: null
};

const browser = await chromium.launch({ headless: true });
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
  await page.goto(origin + "/?local&seed=7319&width=1280&height=720&renderer=gpu");
  await page.evaluate(async () => {
    const result = await (globalThis as any).__tupaia.call("ready", { timeoutMs: 120000 });
    if (!result.ok) throw new Error(JSON.stringify(result));
  });

  for (const world of worlds) {
    const row: any = { world, phase, errors: [] };
    report.results.push(row);
    try {
      if (world !== "100k-labels") await page.evaluate(
        async ({ world, text }) => {
          const runtime = (globalThis as any).__tupaia;
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
          await Promise.all([(globalThis as any).reliefRenderReady, (globalThis as any).burgRenderReady]);
          await runtime.settle();
        },
        { world, text: world === "shared" ? sharedText : "" }
      );
      if (world === "100k-labels") {
        const base = report.results[report.results.length - 2];
        if (base?.world !== "100k" || base.errors.length) throw new Error("100k-labels needs an error-free 100k row before it");
        row.fixture = { kind: "label", added: 0, texts: "Fx01..Fx64", api: "__tupaia.call(\"add\", { type: \"label\", phase: \"apply\", items })" };
        // 64 labels through the app's own add (bridge-mutations.js FNS.add, label handler), in-memory DOM only
        const placed = await page.evaluate(
          async ({ k, cells }) => {
            const runtime = (globalThis as any).__tupaia;
            const w = globalThis as any;
            // same centre as the camera below: live burg nearest the map centre (map centre at k=1)
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
      const camera = await page.evaluate(async ({ k, reliefMode }) => {
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
        // deterministic camera: centered on the live burg nearest the map center (map center at k=1)
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
      }, { k: zoom, reliefMode });
      row.camera = { requested: camera.requested, center: camera.center };
      if (row.fixture && (row.fixture.center.x !== camera.center.x || row.fixture.center.y !== camera.center.y))
        throw new Error("fixture centre differs from camera centre: " + JSON.stringify([row.fixture.center, camera.center]));
      row.regime = { requested: reliefMode, setup: camera.setup };
      if (camera.setup.after.regime !== reliefMode)
        throw new Error("relief regime " + camera.setup.after.regime + " after setup, requested " + reliefMode);

      // seeded uniform points + targeted supplements (burg anchors, label boxes, marker boxes)
      const seed = (world === "shared" ? 1 : 2) * 1000 + zoom * 10 + dpr;
      const random = mulberry32(seed);
      const uniform = Array.from({ length: UNIFORM }, () => [random() * VIEW.width, random() * VIEW.height]);
      const anchors: Record<string, [number, number][]> = await page.evaluate(() => {
        const w = globalThis as any;
        const inside = (x: number, y: number) => x > 2 && y > 2 && x < 1278 && y < 718;
        const mapRect = document.getElementById("map")!.getBoundingClientRect();
        const ctm = (document.getElementById("viewbox") as any).getScreenCTM();
        const burgs: [number, number][] = [];
        for (const burg of w.pack.burgs)
          if (burg?.i && !burg.removed) {
            const p = new DOMPoint(burg.x, burg.y).matrixTransform(ctm);
            if (inside(p.x, p.y)) burgs.push([p.x, p.y]);
          }
        const boxes = (selector: string) =>
          [...document.querySelectorAll(selector)]
            .map(element => element.getBoundingClientRect())
            .filter(rect => rect.width > 0 && rect.height > 0)
            .map(rect => [rect.x + rect.width / 2, rect.y + rect.height / 2] as [number, number])
            .filter(([x, y]) => inside(x, y));
        return {
          burg: burgs,
          label: boxes("#labels text tspan"),
          burgLabel: boxes("#burgLabels text"),
          marker: boxes("#markers > svg"),
          mapOffset: [[mapRect.x, mapRect.y]]
        };
      });
      const mapOffset = anchors.mapOffset[0];
      delete anchors.mapOffset;
      const points: { x: number; y: number; source: string }[] = uniform.map(([x, y]) => ({ x, y, source: "uniform" }));
      const targetedAvailable: Record<string, number> = {};
      for (const [kind, list] of Object.entries(anchors)) {
        targetedAvailable[kind] = list.length;
        const pickRandom = mulberry32(seed * 31 + kind.length);
        const chosen = [...list]
          .map(point => [pickRandom(), point] as const)
          .sort((a, b) => a[0] - b[0])
          .slice(0, TARGETED_PER_KIND);
        for (const [, [x, y]] of chosen) {
          points.push({ x, y, source: kind + "-center" });
          const angle = pickRandom() * Math.PI * 2;
          points.push({ x: x + Math.cos(angle) * JITTER, y: y + Math.sin(angle) * JITTER, source: kind + "-jitter" });
        }
      }
      row.sampling = { seed, uniform: UNIFORM, targetedAvailable, total: points.length, mapOffset };

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
        ({ points, tolerance, mapOffset }) => {
          const w = globalThis as any;
          const status = w.rendererStatus?.();
          const viewbox = document.getElementById("viewbox") as any;
          const transform = viewbox.getAttribute("transform");
          const globalsCamera = { k: (0, eval)("scale"), x: (0, eval)("viewX"), y: (0, eval)("viewY") };
          const inverse = viewbox.getScreenCTM().inverse();
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
            const hit = document.elementFromPoint(x, y);
            const inMap = !!hit && map.contains(hit);
            if (hit && inMap) targets.push(hit);
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
        { points, tolerance: TOLERANCE, mapOffset }
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
      diagnosticRows.push({ world, rows: diagnostics });
      if (!guardAfter) throw new Error("scene guard vanished before teardown");
      const changes = sceneChanges(probeBefore, guardAfter.probe, guardAfter.mutations, guardAfter.pickReliefCalls);
      if (guardAfter.materializeCalls) changes.push("prepareReliefIcons calls: " + guardAfter.materializeCalls);
      if (guardAfter.disconnected) changes.push("sampled targets disconnected: " + guardAfter.disconnected);
      if (blind.length) changes.push("guard self-test missed: " + blind.join(", "));
      row.sceneGuard = {
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
      if (changes.length) row.errors.push("rejected: scene changed during sampling: " + changes.join("; "));

      if (phase === "motion") {
        row.motionStatusAfterSampling = await page.evaluate(() => (globalThis as any).rendererStatus?.());
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
      row.rendererStatus = {
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
      row.oracleCamera = { svgTransform: sampled.transform, globals: sampled.globalsCamera, aligned };
      row.query = sampled.query;
      const ready =
        sampled.status?.active === "gpu" &&
        t?.state === "active" &&
        t?.canvasVisible &&
        t?.sourceCurrent &&
        t?.windows?.coverage === "covered" &&
        !t?.pending &&
        !t?.refinementPending;
      row.gpuReady = !!ready;
      if (phase === "settled" && !ready) row.errors.push("GPU not active/visible/current/covered/ready at sampling");
      if (phase === "settled" && !aligned) row.errors.push("SVG oracle camera not aligned with exact camera");

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
          x: r.x,
          y: r.y,
          source: r.source,
          inMap: r.inMap,
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
      // Occluded: the topmost element is page UI over the map (e.g. #collapsible), so a real click there never reaches
      // clicked() under either renderer and no editor can open. Kept in samples/mismatches, counted, and excluded from
      // the agreement sets (gates) only; occludedGpuHits reports what the candidate index would have claimed there.
      const occluded = samples.filter(s => !s.inMap && !!s.outside);
      const eligible = samples.filter(s => s.inMap || !s.outside);
      const bySource = (prefix: string) => eligible.filter(s => s.source.startsWith(prefix));
      const sets = { uniform: bySource("uniform"), targeted: eligible.filter(s => s.source !== "uniform"), all: eligible };
      row.counts = {
        total: samples.length,
        uniform: sets.uniform.length,
        targeted: sets.targeted.length,
        outsideMap: samples.filter(s => !s.inMap).length,
        occludedExcluded: occluded.length,
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
      const outside = cellRows.filter(s => !s.cell.inBand);
      row.cells = {
        sampled: cellRows.length,
        inBand: cellRows.length - outside.length,
        gated: outside.length,
        agree: outside.filter(s => s.cell.gpu === s.cell.oracle).length,
        inBandAgree: cellRows.filter(s => s.cell.inBand && s.cell.gpu === s.cell.oracle).length
      };
      row.agreement = {} as any;
      for (const [label, set] of Object.entries(sets)) {
        const kinds = tally(set);
        const raw = set.filter(s => s.inMap);
        row.agreement[label] = {
          kinds,
          noneAgree: set.filter(s => s.outcome === "agree-none").length,
          rawIdAgree: raw.filter(s => (s.gpuRaw?.id ?? "") === s.svgRawId).length,
          rawIdCompared: raw.length
        };
      }
      // a rejected (scene-changed) run or a denominator under 50 never passes; < 50 is reported as insufficient
      // and a settled pass also needs the GPU ready and the oracle camera aligned (P3 audit: was valid-only)
      const valid = row.sceneGuard.valid && (phase !== "settled" || (!!ready && !!aligned));
      const verdict = (denominator: number, agree: number) =>
        !valid
          ? "rejected"
          : denominator < 50
            ? "insufficient"
            : phase === "settled" && agree / denominator >= 0.995
              ? "pass"
              : "fail";
      const gate: any = {};
      for (const kind of GATED) {
        const k = row.agreement.all.kinds[kind];
        const denominator = k ? k.expected + k.extra + k.wrongInto : 0;
        gate[kind] = {
          denominator,
          agree: k?.agree ?? 0,
          rate: denominator ? (k!.agree / denominator) : null,
          pass: valid && phase === "settled" && denominator >= 50 && k!.agree / denominator >= 0.995,
          status: verdict(denominator, k?.agree ?? 0)
        };
      }
      gate.cells = {
        denominator: row.cells.gated,
        rate: row.cells.gated ? row.cells.agree / row.cells.gated : null,
        pass: valid && phase === "settled" && row.cells.gated > 0 && row.cells.agree === row.cells.gated
      };
      gate.note = "burg/label/marker need >=50 meaningful samples and >=99.5%; rate = agree/(expected+extra+wrongInto)";
      row.gate = gate;
      // Same oracle, same rule, actual = window.gpuSelect (raw hit + clicked() fallbacks at the GPU camera). Reported
      // beside the raw gpuPick gate, never merged into it; absent when the page exposes no gpuSelect.
      const piped = eligible.filter(s => s.semantic);
      if (samples.every(s => s.semantic)) {
        const kinds = tally(piped.map(s => ({ expected: s.expected, actual: s.semantic as Selection })));
        const semanticGate: any = {};
        for (const kind of GATED) {
          const k = kinds[kind];
          const denominator = k ? k.expected + k.extra + k.wrongInto : 0;
          semanticGate[kind] = {
            denominator,
            agree: k?.agree ?? 0,
            rate: denominator ? k!.agree / denominator : null,
            pass: valid && phase === "settled" && denominator >= 50 && k!.agree / denominator >= 0.995,
            status: verdict(denominator, k?.agree ?? 0)
          };
        }
        row.semantic = {
          note: "actual = window.gpuSelect (src/gpu/selection.ts); oracle unchanged; separate from raw gpuPick gate",
          kinds,
          gate: semanticGate,
          via: Object.fromEntries(
            [...new Set(piped.map(s => s.semantic!.via))].map(v => [v, piped.filter(s => s.semantic!.via === v).length])
          ),
          mismatches: piped
            .filter(s => s.semanticOutcome === "missing" || s.semanticOutcome === "extra" || s.semanticOutcome === "wrong")
            .map(s => ({
              i: s.i,
              x: s.x,
              y: s.y,
              source: s.source,
              svgRawId: s.svgRawId,
              expected: s.expected,
              gpuRaw: s.gpuRaw,
              semantic: s.semantic,
              outcome: s.semanticOutcome
            }))
        };
      } else {
        row.semantic = { note: "gpuSelect unavailable on " + samples.filter(s => !s.semantic).length + " samples" };
      }
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
  const failed = report.results.filter((r: any) => !r.fixture && r.errors.length);
  if (failed.length) report.failure = failed.map((r: any) => r.world + ": " + r.errors.join("; ")).join(" | ");
  const fixtureFailed = report.results.filter((r: any) => r.fixture && r.errors.length);
  if (fixtureFailed.length) report.fixtureFailure = fixtureFailed.map((r: any) => r.world + ": " + r.errors.join("; ")).join(" | ");
  // same frozen rule (>=50 eligible, rate >= 99.5%, cells exact) as the natural gates, reported under its own key only
  report.fixtureVerdicts = Object.fromEntries(
    report.results
      .filter((r: any) => r.fixture)
      .map((r: any) => [
        r.world,
        {
          label: r.gate?.label ?? null,
          cells: r.gate?.cells ?? null,
          pass: !!(r.gate?.label?.pass && r.gate?.cells?.pass),
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
        "diagnostics only, never part of any gate: <=5 semantic mismatches per class, read-only native SVG geometry " +
        "(expected via elementFromPoint, candidate by id) beside PickIndex.inspect items (topmost first)",
      report: output,
      config: report.config && { dpr, zoom, phase, reliefMode, mapSha256: fixtureHash },
      worlds: diagnosticRows
    },
    null,
    1
  )
);
const summary = {
  name,
  schema: report.schema,
  protocol: report.protocol,
  config: { dpr, zoom, phase, worlds, reliefMode },
  failure: report.failure,
  fixtureFailure: report.fixtureFailure,
  fixtureVerdicts: report.fixtureVerdicts,
  blocked: blocked.length,
  results: report.results.map((r: any) => ({
    world: r.world,
    fixture: r.fixture,
    camera: r.camera?.requested,
    regime: r.regime && {
      requested: r.regime.requested,
      materializeCalls: r.regime.setup.materializeCalls,
      before: r.regime.setup.before,
      after: r.regime.setup.after
    },
    sceneGuard: r.sceneGuard && { ...r.sceneGuard, before: undefined, after: undefined },
    rendererStatus: r.rendererStatus,
    oracleAligned: r.oracleCamera?.aligned,
    counts: r.counts,
    cells: r.cells,
    gate: r.gate,
    kinds: r.agreement?.all?.kinds,
    raw: r.agreement && { agree: r.agreement.all.rawIdAgree, of: r.agreement.all.rawIdCompared },
    mismatchCount: r.mismatchCount,
    semantic: r.semantic && {
      gate: r.semantic.gate,
      via: r.semantic.via,
      kinds: r.semantic.kinds,
      mismatchCount: r.semantic.mismatches?.length,
      note: r.semantic.note
    },
    firstMismatches: (r.mismatches || []).slice(0, 20).map((m: any) => ({
      x: +m.x.toFixed(1),
      y: +m.y.toFixed(1),
      source: m.source,
      outcome: m.outcome,
      svg: m.svgTarget && m.svgTarget.tag + "#" + m.svgTarget.id,
      expected: m.expected.kind + ":" + m.expected.id + "(" + m.expected.branch + ")",
      gpu: m.gpuRaw ? m.gpuRaw.layer + "/" + m.gpuRaw.id : null,
      actual: m.actual.kind + ":" + m.actual.id,
      cell: m.cell.gpu !== m.cell.oracle && !m.cell.inBand ? m.cell : undefined
    })),
    errors: r.errors
  }))
};
console.log(JSON.stringify(summary));
if (report.failure) process.exitCode = 1;
