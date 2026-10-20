// Trade caravans live against frozen (W3b PAINT). Run it through bench/gate/gate.ts (`gate trade-live`), which holds
// the EXCLUSIVE host lock and sets GATE_OUT_DIR. See docs/performance/webgl-rewrite/GATE.md.
//
// One ?renderer=gpu page (1280x720, TRADE_DPR, default 2) on the parity fixture with its preamble: every layer on, the
// heaviest document the gate has. Two arms, alternated per rep (live first on even reps, frozen first on odd ones):
//   live    TradeAnimation.restart(): the default 30 concurrent caravans moving
//   frozen  __cons.freezeTrade(): caravans interrupted and the animation stopped
// Each arm measures, after a short settle:
//   idle  2 s of requestAnimationFrame (fps, frame p95) with a Chrome trace of the main thread (Layerize, Paint), the
//         GPU frames drawn, how far the caravans moved (TradeAnimation.transformOf: the pose the GPU mirrors) and how
//         many caravan transform attributes were written to the SVG meanwhile (0 while the canvas covers it)
//   prepare-to-current  gpuRenderer.invalidate() (a forced full re-prepare, every compat run dirty) until the frame
//         holds the new revision on screen (currentMs), and until its refinement is done too (refinedMs)
// Fails when the live median prepare-to-current is more than 2x the frozen median, when the live arm has no moving
// caravans (the comparison would be vacuous), on page errors, or when the page leaves the GPU path. TRADE_REPS
// (default 3) sets the reps.
import { createServer } from "node:http";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { type CDPSession, chromium, type Page } from "playwright";

const root = resolve(import.meta.dirname, "../..");
const dist = resolve(root, "dist");
const output = resolve(process.env.GATE_OUT_DIR || process.cwd(), "trade-live.json");
const REPS = Math.max(1, Number(process.env.TRADE_REPS || 3));
const DPR = Number(process.env.TRADE_DPR || 2);
const MAP = resolve(process.env.TRADE_MAP || resolve(root, "tests/fixtures/parity/parity-v1.map"));
const LIMIT = 2; // live prepare-to-current may be at most this many times the frozen one

const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
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
if (!address || typeof address === "string") throw Error("No server");
const origin = "http://127.0.0.1:" + address.port;

const median = (values: number[]) => {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor((s.length - 1) / 2);
  return s.length % 2 ? s[mid] : (s[mid] + s[mid + 1]) / 2;
};

type Arm = "live" | "frozen";
interface Sample {
  arm: Arm;
  rep: number;
  caravans: number;
  idle: {
    fps: number;
    p95: number;
    frames: number;
    gpuFrames: number;
    moved: number; // caravans whose pose changed over the window
    domWrites: number; // caravan transform attributes written to the SVG over the window
    layerizeMs: number;
    layerizeCount: number;
    paintMs: number;
  };
  prepare: { currentMs: number | null; refinedMs: number | null; outcome: string | null; phases: Record<string, number> | null };
  caravanTelemetry: unknown;
}

const report: Record<string, unknown> & { errors: string[]; samples: Sample[] } = {
  runStartedUtc: new Date().toISOString(),
  map: MAP,
  dpr: DPR,
  reps: REPS,
  limit: LIMIT,
  errors: [],
  samples: []
};

const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--use-angle=metal", "--enable-gpu"] });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: DPR, serviceWorkers: "block" });
  await context.addInitScript(() => {
    localStorage.setItem("autosaveInterval", "0");
    localStorage.setItem("azgaarAssistant", "hide");
  });
  const scripts = ["bridge.js", "bridge-mutations.js", ...readdirSync(resolve(root, "mcp/src/bridge-ext")).filter(n => n.endsWith(".js")).sort().map(n => "bridge-ext/" + n)];
  await context.addInitScript(scripts.map(n => readFileSync(resolve(root, "mcp/src", n), "utf8")).join("\n"));
  await context.addInitScript({ path: resolve(import.meta.dirname, "fixtures/parity-page.js") });
  await context.addInitScript({ path: resolve(import.meta.dirname, "consumers-page.js") });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.origin === origin || (route.request().method() === "GET" && url.hostname === "fonts.gstatic.com") ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(300000);
  page.on("pageerror", error => report.errors.push(error.message));
  page.on("dialog", dialog => dialog.dismiss());
  await page.goto(`${origin}/?local&seed=7319&width=1280&height=720&renderer=gpu`);
  await page.evaluate(async text => {
    const w = globalThis as any;
    const ready = await w.__tupaia.call("ready", { timeoutMs: 120000 });
    if (!ready.ok) throw Error(JSON.stringify(ready));
    await w.__tupaia.fns.loadMap({ text, timeoutMs: 120000 });
    await w.__tupaia.settle();
    await w.__parity.preamble();
  }, readFileSync(MAP, "utf8"));
  await gpuSettled(page);
  report.contextProperties = await page.evaluate(() => {
    const gl = (document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null)?.getContext("webgl2");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    return gl ? { adapter: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null } : null;
  });
  const cdp = await context.newCDPSession(page);

  for (let rep = 0; rep < REPS; rep++) {
    const order: Arm[] = rep % 2 ? ["frozen", "live"] : ["live", "frozen"];
    for (const arm of order) report.samples.push(await sample(page, cdp, arm, rep));
  }

  const arms = (arm: Arm) => report.samples.filter(s => s.arm === arm);
  const summary = (arm: Arm) => {
    const samples = arms(arm);
    return {
      currentMs: median(samples.map(s => s.prepare.currentMs ?? Number.NaN)),
      refinedMs: median(samples.map(s => s.prepare.refinedMs ?? Number.NaN)),
      fps: median(samples.map(s => s.idle.fps)),
      p95: median(samples.map(s => s.idle.p95)),
      layerizeMsPerFrame: median(samples.map(s => (s.idle.frames ? s.idle.layerizeMs / s.idle.frames : 0))),
      caravans: median(samples.map(s => s.caravans)),
      moved: median(samples.map(s => s.idle.moved)),
      domWrites: median(samples.map(s => s.idle.domWrites)),
      gpuFrames: median(samples.map(s => s.idle.gpuFrames))
    };
  };
  const live = summary("live");
  const frozen = summary("frozen");
  const ratio = live.currentMs !== null && frozen.currentMs ? live.currentMs / frozen.currentMs : null;
  report.summary = { live, frozen, ratio: ratio === null ? null : Math.round(ratio * 100) / 100 };
  const status = await page.evaluate(() => (globalThis as any).rendererStatus?.());
  report.status = { active: status?.active, fallbackReason: status?.fallbackReason ?? null, caravans: status?.gpu?.caravans ?? null };
  const failures: string[] = [];
  if (status?.active !== "gpu") failures.push(`left the GPU path: ${status?.fallbackReason}`);
  if (!live.caravans || !live.moved) failures.push(`live arm has no moving caravans (${live.caravans} caravans, ${live.moved} moved)`);
  if (arms("live").some(s => s.prepare.currentMs === null) || arms("frozen").some(s => s.prepare.currentMs === null))
    failures.push("a forced re-prepare never became current");
  else if (ratio === null || ratio > LIMIT)
    failures.push(`prepare-to-current with trade live is ${ratio?.toFixed(2)}x frozen (${live.currentMs} ms vs ${frozen.currentMs} ms; limit ${LIMIT}x)`);
  if (report.errors.length) failures.push(`${report.errors.length} page error(s)`);
  report.failure = failures.length ? failures.join("; ") : null;
} catch (error) {
  report.failure = String(error instanceof Error ? error.stack || error.message : error);
} finally {
  writeFileSync(output, JSON.stringify(report, null, 1));
  await browser.close();
  server.close();
}
console.log(JSON.stringify({ summary: report.summary, failure: report.failure }));
process.exit(report.failure ? 1 : 0);

async function gpuSettled(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const s = (globalThis as any).rendererStatus?.();
      if (s?.active === "svg" && s?.fallbackReason) return true;
      const g = s?.gpu;
      return s?.active === "gpu" && g?.canvasVisible && !g.pending && g.state === "active" && !g.refinementPending;
    },
    {},
    { timeout: 600000, polling: 100 }
  );
}

async function sample(page: Page, cdp: CDPSession, arm: Arm, rep: number): Promise<Sample> {
  if (arm === "live") {
    await page.evaluate(() => (globalThis as any).TradeAnimation.restart());
    await page.waitForTimeout(2500);
  } else {
    await page.evaluate(() => (globalThis as any).__cons.freezeTrade());
    await page.waitForTimeout(1500);
  }
  await gpuSettled(page);
  const caravans = await page.evaluate(() => document.querySelectorAll("#tradeAnimation > g").length);

  const events: any[] = [];
  const collect = (event: { value: any[] }) => events.push(...event.value);
  cdp.on("Tracing.dataCollected", collect);
  const complete = new Promise(done => cdp.once("Tracing.tracingComplete", done));
  await cdp.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline,blink,cc,toplevel", transferMode: "ReportEvents" });
  const idle = await page.evaluate(async (ms: number) => {
    const w = globalThis as any;
    // the pose the GPU mirrors (builds before W3b PAINT wrote every tick to the attribute)
    const pose = (g: Element) => w.TradeAnimation.transformOf?.(g) ?? g.getAttribute("transform");
    const poses = () => new Map([...document.querySelectorAll("#tradeAnimation > g")].map(g => [g, pose(g)]));
    const before = poses();
    let domWrites = 0;
    const layer = document.getElementById("tradeAnimation");
    const observer = new MutationObserver(records => {
      domWrites += records.filter(r => r.attributeName === "transform").length;
    });
    if (layer) observer.observe(layer, { subtree: true, attributes: true, attributeFilter: ["transform"] });
    const frames0 = w.rendererStatus().gpu.frames;
    const gaps: number[] = [];
    let last = performance.now();
    const start = last;
    await new Promise<void>(done => {
      const frame = () => {
        const now = performance.now();
        gaps.push(now - last);
        last = now;
        if (now - start < ms) requestAnimationFrame(frame);
        else done();
      };
      requestAnimationFrame(frame);
    });
    observer.disconnect();
    const after = poses();
    let moved = 0;
    for (const [group, pose] of after) if (before.has(group) && before.get(group) !== pose) moved++;
    gaps.sort((a, b) => a - b);
    return {
      fps: Math.round((gaps.length * 1000) / ms),
      p95: Math.round(gaps[Math.floor(gaps.length * 0.95)] ?? 0),
      frames: gaps.length,
      gpuFrames: w.rendererStatus().gpu.frames - frames0,
      moved,
      domWrites
    };
  }, 2000);
  await cdp.send("Tracing.end");
  await complete;
  cdp.off("Tracing.dataCollected", collect);
  const names = new Map<string, string>();
  for (const e of events) if (e.ph === "M" && e.name === "thread_name") names.set(`${e.pid}:${e.tid}`, e.args.name);
  const main = events.filter(e => e.ph === "X" && e.dur && names.get(`${e.pid}:${e.tid}`) === "CrRendererMain");
  const total = (name: string) => main.filter(e => e.name === name).reduce((ms, e) => ms + e.dur / 1000, 0);

  const prepare = await page.evaluate(async () => {
    const w = globalThis as any;
    const t0 = performance.now();
    w.gpuRenderer.invalidate();
    let currentMs: number | null = null;
    for (;;) {
      await new Promise(done => setTimeout(done, 20));
      const g = w.rendererStatus().gpu;
      if (currentMs === null && !g.pending && g.state === "active" && g.canvasVisible && g.frameRevision === g.revision)
        currentMs = Math.round(performance.now() - t0);
      if (currentMs !== null && !g.refinementPending) break;
      if (performance.now() - t0 > 180000) break;
    }
    const g = w.rendererStatus().gpu;
    return {
      currentMs,
      refinedMs: currentMs === null ? null : Math.round(performance.now() - t0),
      outcome: g.lastPrepare?.outcome ?? null,
      phases: g.lastPrepare?.phases ?? null
    };
  });
  const caravanTelemetry = await page.evaluate(() => (globalThis as any).rendererStatus().gpu.caravans ?? null);
  const result: Sample = {
    arm,
    rep,
    caravans,
    idle: {
      ...idle,
      layerizeMs: Math.round(total("Layerize")),
      layerizeCount: main.filter(e => e.name === "Layerize").length,
      paintMs: Math.round(total("Paint"))
    },
    prepare,
    caravanTelemetry
  };
  console.log(JSON.stringify({ arm, rep, caravans, fps: result.idle.fps, layerizeMs: result.idle.layerizeMs, domWrites: result.idle.domWrites, moved: result.idle.moved, currentMs: prepare.currentMs, refinedMs: prepare.refinedMs }));
  return result;
}
