// Per-layer golden (G-C, PROOF-PLAN §4; decisions D1 and D5 in PHASE1-PLAN.md). Run it through bench/gate/gate.ts
// (`gate golden ...`), which takes a shared host-lock slot and sets GATE_OUT_DIR (evidence directory).
//
// For every (style preset, dpr, layer family, k) cell it renders ONE build of dist/ with only that family visible
// (golden-isolation.ts) and captures, from the same DOM state, the GPU arm (canvas shown) and the SVG arm (canvas
// hidden) at device resolution. SVG is the reference, GPU the candidate: a check never compares GPU with GPU. It then
// computes SSIM, over16, over44 and the changed fraction (golden-metrics.ts), writes both PNGs plus a diff heatmap,
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
//   GOLDEN_READING   conservative | over44 (which "≤0.5 % at Δ≤44" reading gates) default conservative
//   GOLDEN_KEEP      all | fail: keep PNGs for every cell or only failing ones   default all
//   GOLDEN_CENSUS    census expectations JSON (same shape as the census.json this writes)
//   GOLDEN_BREAK     none | drop-batch: self-test only, deliberately drops the GPU arm's bottom-most fill/stroke batch
// Output in GATE_OUT_DIR: golden.json (report; `failure` is null on a pass), census.json, cells/<preset>/d<dpr>/*.png.
// Exit 0 when a report was written (verdicts are in it), 1 on a harness error.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, relative, resolve } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright";
import { type CensusCounts, type CellMetrics, heatmap, judgeCell, measureCell, type Reading } from "../golden-metrics.ts";
import { decodePng, encodePng } from "../png.ts";
import { type Family, parsePresets, parseZooms, selectFamilies } from "./golden-families.ts";
import { isolateLayer } from "./golden-isolation.ts";

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
const reading = (env.GOLDEN_READING || "conservative") as Reading;
const keep = env.GOLDEN_KEEP || "all";
const breakMode = env.GOLDEN_BREAK || "none";
if (!/^#[\da-f]{6}$/i.test(bg)) throw Error(`GOLDEN_BG must be #rrggbb, got ${bg}`);
if (!["over44", "conservative"].includes(reading)) throw Error(`GOLDEN_READING must be conservative|over44`);
if (!["all", "fail"].includes(keep)) throw Error(`GOLDEN_KEEP must be all|fail`);
if (!["none", "drop-batch"].includes(breakMode)) throw Error(`GOLDEN_BREAK must be none|drop-batch`);
if (dprs.some(d => d !== 1 && d !== 2)) throw Error("GOLDEN_DPR must be 1 and/or 2");
if (!zooms.length) throw Error("GOLDEN_K is empty");

const mapText = readFileSync(mapPath, "utf8");
const mapSha = createHash("sha256").update(readFileSync(mapPath)).digest("hex");
const expectations = env.GOLDEN_CENSUS ? JSON.parse(readFileSync(env.GOLDEN_CENSUS, "utf8")) : null;
const zoomsFor = (family: Family) => [...new Set([...zooms, ...(family.coast ? coastZooms : [])])].sort((a, b) => a - b);
const allZooms = [...new Set(families.flatMap(zoomsFor))].sort((a, b) => a - b);

interface Cell {
  key: string;
  preset: string;
  dpr: number;
  family: string;
  id: string;
  k: number;
  pass: boolean;
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
  images?: Record<string, string>;
  seconds?: number;
}

const report = {
  schema: 1,
  runStartedUtc: new Date().toISOString(),
  fixture: { path: mapPath, sha256: mapSha },
  args: { layers: families.map(f => f.name), k: zooms, coastk: coastZooms, dpr: dprs, preset: presets, bg, reading, keep, break: breakMode },
  census: env.GOLDEN_CENSUS || null,
  diagnosticBreak: breakMode !== "none" ? `${breakMode}: the GPU arm is deliberately broken; this run is expected to FAIL` : null,
  errors: [] as string[],
  warnings: [] as string[],
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
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.origin === origin || (route.request().method() === "GET" && url.hostname === "fonts.gstatic.com") ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  page.on("pageerror", e => report.errors.push(e.message));
  page.on("console", m => {
    if (["warning", "error"].includes(m.type()) && report.warnings.length < 80) report.warnings.push(m.text().slice(0, 1000));
  });
  page.on("dialog", d => d.dismiss());
  await page.goto(`${origin}/?local&seed=7319&width=1280&height=720&renderer=gpu`);
  await page.evaluate(async () => {
    const ready = await (globalThis as any).__tupaia.call("ready", { timeoutMs: 120000 });
    if (!ready.ok) throw Error(JSON.stringify(ready));
  });
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
  await page.evaluate(async text => {
    const w = globalThis as any;
    await w.__tupaia.fns.loadMap({ text, timeoutMs: 120000 });
    await w.__tupaia.settle();
  }, mapText);
  if (preset !== "map") {
    const r = await page.evaluate(p => (globalThis as any).__tupaia.call("display", { stylePreset: p }), preset);
    if (!r.ok) problems.push(`stylePreset ${preset}: ${JSON.stringify(r).slice(0, 300)}`);
  }
  for (const toggle of toggles) {
    const r = await page.evaluate(t => (globalThis as any).__tupaia.call("display", { on: [t] }), toggle);
    if (!r.ok) problems.push(`toggle ${toggle}: ${JSON.stringify(r).slice(0, 300)}`);
  }
  await settleApp(page);
  return problems;
}

const zoomTo = (page: Page, k: number) =>
  page.evaluate(async k => {
    const w = globalThis as any;
    w.d3
      .select("#map")
      .call((0, eval)("zoom").transform, w.d3.zoomIdentity.translate(640 - (w.graphWidth * k) / 2, 360 - (w.graphHeight * k) / 2).scale(k));
    await w.__tupaia.settle();
    await Promise.all([w.reliefRenderReady, w.burgRenderReady]);
  }, k);

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

// Self-test only: removes one fill/stroke batch from the GPU frame (a dropped path) and redraws. SVG is untouched.
const dropBatch = (page: Page) =>
  page.evaluate(async () => {
    const r = (globalThis as any).gpuRenderer;
    const batches: any[] | undefined = r?.prepared?.frame?.batches;
    if (!batches?.length) return { dropped: null, total: 0 };
    // The bottom-most fill/stroke batch: for ocean that is the opaque #oceanBase fill. (The largest batch by count
    // is a poor pick: ocean's is a faint depth ring whose loss stays under one code value.)
    let index = batches.findIndex(b => b.kind === "fill" || b.kind === "stroke");
    if (index < 0) index = 0;
    const frames = () => (globalThis as any).rendererStatus?.()?.gpu?.frames ?? null;
    const before = frames();
    const [gone] = batches.splice(index, 1);
    r.requestDraw();
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    return {
      dropped: { index, kind: gone.kind, count: gone.count ?? null },
      total: batches.length + 1,
      kinds: [...batches.slice(0, index), gone, ...batches.slice(index)].map((b: any) => `${b.kind}:${b.count ?? "-"}`),
      framesDrawn: (frames() ?? 0) - (before ?? 0)
    };
  });

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
      if (target)
        for (const e of target.querySelectorAll("path,polygon,polyline,rect,circle,ellipse,line,text,use,image"))
          if ((e as any).checkVisibility ? (e as any).checkVisibility({ visibilityProperty: true }) : true) domDrawables++;
      return { layer, sink, compatRunElements, runsReadable, domDrawables, build: w.__gpuSceneCensus?.last?.build ?? null };
    },
    { id: family.id, root: !!family.root }
  );

async function captureArms(page: Page): Promise<{ gpu: Buffer; svg: Buffer }> {
  const gpu = await page.screenshot({ animations: "disabled" });
  const old = await page.evaluate(() => {
    const c = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
    if (!c) return null;
    const value = c.style.visibility;
    c.style.visibility = "hidden";
    return value;
  });
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const svg = await page.screenshot({ animations: "disabled" });
  await page.evaluate(value => {
    const c = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
    if (c) c.style.visibility = value || "";
  }, old);
  return { gpu, svg };
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
        await zoomTo(page, allZooms[0]);
        const blanks = await captureBlanks(page);
        writeFileSync(join(cellDir, "blank-svg.png"), blanks.svg);
        writeFileSync(join(cellDir, "blank-gpu.png"), blanks.gpu);
        const blankSvg = decodePng(blanks.svg);
        // without a presented GPU blank, both arms are measured against the SVG blank (and the note says so)
        const gpuBlankOk = blanks.gpuStatus.active === "gpu" && !blanks.gpuStatus.timedOut;
        if (!gpuBlankOk) report.warnings.push(`${preset}/d${dpr}: no GPU blank frame (${JSON.stringify(blanks.gpuStatus)}); GPU ink measured against the SVG blank`);
        const blankGpu = gpuBlankOk ? decodePng(blanks.gpu) : blankSvg;
        for (const k of allZooms) {
          await zoomTo(page, k);
          for (const family of families.filter(f => zoomsFor(f).includes(k))) {
            const started = Date.now();
            const key = `${preset}/d${dpr}/${family.name}/k${k}`;
            const cell: Cell = { key, preset, dpr, family: family.name, id: family.id, k, pass: false, failures: [] };
            report.cells.push(cell);
            try {
              const toggleProblem = problems.find(p => family.toggle && p.startsWith(`toggle ${family.toggle}:`));
              if (toggleProblem) cell.failures.push(toggleProblem);
              await page.evaluate(isolateLayer, { id: family.id, root: family.root, bg });
              await settleApp(page);
              await page.evaluate(isolateLayer, { id: family.id, root: family.root, bg });
              const status = await waitGpu(page);
              cell.renderer = status;
              if (status.active !== "gpu") cell.failures.push(`GPU not active: ${status.fallbackReason ?? "no frame"}`);
              else if (status.timedOut) cell.failures.push("GPU frame did not settle within 60 s");
              if (breakMode === "drop-batch") {
                const dropped = await dropBatch(page);
                cell.dropped = dropped;
                // the self-test must break something; a no-op here would make it vacuous
                if (!dropped.dropped) cell.failures.push("harness: break=drop-batch found no gpuRenderer.prepared.frame.batches to drop");
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
              const svg = decodePng(shots.svg);
              const gpu = decodePng(shots.gpu);
              cell.metrics = measureCell(svg, gpu, blankSvg, blankGpu);
              const verdict = judgeCell({ metrics: cell.metrics, census: cell.census, domDrawables: cell.domDrawables, expected: cell.expected }, reading);
              cell.gates = verdict.gates;
              if (verdict.notes.length) cell.notes = verdict.notes;
              cell.failures.push(...verdict.failures);
              cell.pass = cell.failures.length === 0;
              if (keep === "all" || !cell.pass) {
                const base = join(cellDir, `${family.name}-k${fmt(k)}`);
                writeFileSync(`${base}-svg.png`, shots.svg);
                writeFileSync(`${base}-gpu.png`, shots.gpu);
                writeFileSync(`${base}-diff.png`, encodePng(heatmap(svg, gpu)));
                cell.images = { svg: relative(outDir, `${base}-svg.png`), gpu: relative(outDir, `${base}-gpu.png`), diff: relative(outDir, `${base}-diff.png`) };
              }
            } catch (error) {
              cell.failures.push(`harness: ${String(error).slice(0, 500)}`);
              cell.pass = false;
            }
            cell.seconds = Number(((Date.now() - started) / 1000).toFixed(1));
            const m = cell.metrics;
            log(
              `${cell.pass ? "PASS" : "FAIL"} ${key}${m ? ` ssim ${m.ssim.toFixed(4)} over16 ${(m.over16Fraction * 100).toFixed(3)}% over44 ${(m.over44Fraction * 100).toFixed(3)}% changed ${(m.changedFraction * 100).toFixed(2)}%` : ""}` +
                `${cell.census ? ` census n${cell.census.native}/c${cell.census.compat}/s${cell.census.skipped}` : ""}${cell.pass ? "" : ` :: ${cell.failures.join("; ")}`}${cell.notes ? ` [note: ${cell.notes.join("; ")}]` : ""}`
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
  for (const c of report.cells) {
    byFamily[c.family] ??= { pass: 0, fail: 0 };
    byFamily[c.family][c.pass ? "pass" : "fail"]++;
  }
  report.summary = {
    cells: report.cells.length,
    pass: report.cells.length - failed.length,
    fail: failed.length,
    empty: report.cells.filter(c => c.gates && !c.gates.populated).length,
    // passing cells whose layer footprint differs between arms (not gated; see INK_NOTE in golden-metrics.ts)
    passWithNotes: report.cells.filter(c => c.pass && c.notes?.length).map(c => c.key),
    byFamily
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
