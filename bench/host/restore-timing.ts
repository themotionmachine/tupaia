// Context-loss restore timing (PERF packet, research B0/B1/B2). Run it through bench/gate/gate.ts (`gate restore`),
// which holds the EXCLUSIVE host lock and sets GATE_OUT_DIR and GATE_MAP. See docs/performance/webgl-rewrite/GATE.md.
//
// One page, one world, a fixed settled camera. Each sample loses the WebGL context at rest (WEBGL_lose_context),
// restores it, and reads the renderer's own restore clock (rendererStatus().gpu.restore, restore-phases.ts):
// lossToDrawMs, the prepare and its steps. restoredToDrawMs = lossToDrawMs - lossToRestoredMs leaves out the harness's
// own loss window. While the context is restoring, CDP mouse moves (no button: hover, never a camera gesture) arrive
// every ~16 ms and each one's event timestamp -> next requestAnimationFrame is recorded (input responsiveness during
// the restore prepare, the B2 metric).
//
// Arms are URL query fragments applied with history.replaceState between samples (the renderer reads its experiment
// switches per prepare), interleaved ABBA across reps so drift and warm-up fall on every arm alike:
//   RESTORE_ARMS   comma list of arms; an arm is "base" or "&"-joined key=value params, e.g. "gpu-slice-ms=50"
//   RESTORE_REPS   samples per arm (default 3)
//   RESTORE_WORLD  100k (generated, the research diagnostic's world) or shared (GATE_MAP fixture); default 100k
//   RESTORE_COLD   "1": bump the DOM revision (gpuRenderer.invalidate) right before each loss: a cold restore
//   RESTORE_ZOOM   camera zoom (default 3.5, native-recovery's wheel camera); RESTORE_DPR (default 2)
//   RESTORE_INPUT  "0" disables the hover input
// Each sample also screenshots the settled frame before the loss and after the restore and counts the pixels that
// differ by more than 16 (trade caravans move between the two shots, so a small count is expected): a restore that
// rebuilds a different frame (a retained payload gone wrong) shows up there.
import { createServer } from "node:http";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";
import { decodePng } from "../png.ts";

const root = resolve(import.meta.dirname, "../..");
const dist = resolve(root, "dist");
const output = resolve(process.env.GATE_OUT_DIR || process.cwd(), "restore-timing.json");
const ARMS = (process.env.RESTORE_ARMS || "base").split(",").map(arm => arm.trim()).filter(Boolean);
const REPS = Math.max(1, Number(process.env.RESTORE_REPS || 3));
const WORLD = process.env.RESTORE_WORLD === "shared" ? "shared" : "100k";
const COLD = process.env.RESTORE_COLD === "1";
const ZOOM = Number(process.env.RESTORE_ZOOM || 3.5);
const DPR = Number(process.env.RESTORE_DPR || 2);
const INPUT = process.env.RESTORE_INPUT !== "0";

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

const summarize = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? null;
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: s.at(-1) ?? null };
};
const diff = (a: Buffer, b: Buffer) => {
  const [p, q] = [decodePng(a), decodePng(b)];
  if (p.width !== q.width || p.height !== q.height) return { pixels: p.width * p.height, over16: -1, max: -1 };
  let over16 = 0;
  let max = 0;
  for (let i = 0; i < p.data.length; i += 4) {
    let d = 0;
    for (let j = 0; j < 3; j++) d = Math.max(d, Math.abs(p.data[i + j] - q.data[i + j]));
    if (d > 16) over16++;
    if (d > max) max = d;
  }
  return { pixels: p.width * p.height, over16, max };
};
const median = (values: (number | null | undefined)[]) => {
  const s = values.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] + (s.length % 2 ? 0 : (s[s.length / 2] - s[Math.floor((s.length - 1) / 2)]) / 2) : null;
};

const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--use-angle=metal", "--enable-gpu"] });
const report: any = { check: "restore", runStartedUtc: new Date().toISOString(), world: WORLD, cold: COLD, zoom: ZOOM, dpr: DPR, input: INPUT, arms: ARMS, reps: REPS, errors: [] as string[], warnings: [] as string[], failure: null as string | null, samples: [] as any[] };
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: DPR, serviceWorkers: "block" });
  await context.addInitScript(({ origin }) => {
    if (location.origin !== origin) return;
    localStorage.setItem("autosaveInterval", "0");
    localStorage.setItem("azgaarAssistant", "hide");
  }, { origin });
  const scripts = ["bridge.js", "bridge-mutations.js", ...readdirSync(resolve(root, "mcp/src/bridge-ext")).filter(n => n.endsWith(".js")).sort().map(n => "bridge-ext/" + n)];
  await context.addInitScript(scripts.map(n => readFileSync(resolve(root, "mcp/src", n), "utf8")).join("\n"));
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    return route.request().method() === "GET" && (url.origin === origin || url.hostname === "fonts.gstatic.com") ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  page.on("pageerror", e => report.errors.push(e.message));
  page.on("console", m => {
    if (["warning", "error"].includes(m.type()) && report.warnings.length < 50) report.warnings.push(m.text().slice(0, 1000));
  });
  page.on("dialog", d => d.dismiss());
  await page.goto(origin + "/?local&seed=7319&width=1280&height=720&renderer=gpu");
  await page.evaluate(async ({ text }) => {
    const w = globalThis as any;
    const ready = await w.__tupaia.call("ready", { timeoutMs: 120000 });
    if (!ready.ok) throw Error(JSON.stringify(ready));
    await w.__tupaia.fns.loadMap({ text, timeoutMs: 120000 });
    await w.__tupaia.call("display", { on: ["heightmap", "relief"] });
    await w.__tupaia.settle();
  }, { text: readFileSync(process.env.GATE_MAP || "/tmp/tupaia-navigation-shared-v8.map", "utf8") });
  if (WORLD === "100k")
    await page.evaluate(async () => {
      const w = globalThis as any;
      await w.__tupaia.fns.generateMap({ cells: 100000, seed: "7319", template: "continents", width: 1280, height: 720 });
      await w.__tupaia.call("display", { on: ["heightmap", "relief"] });
      await w.__tupaia.settle();
    });
  await page.evaluate(async () => {
    const w = globalThis as any;
    const shown = await w.__tupaia.call("display", { on: ["emblems"] });
    if (!shown.ok) throw Error(JSON.stringify(shown));
    await w.__tupaia.settle();
    await Promise.all([w.reliefRenderReady, w.burgRenderReady]);
  });
  await page.evaluate(k => {
    const w = globalThis as any;
    w.d3.select("#map").call((0, eval)("zoom").transform, w.d3.zoomIdentity.translate(640 - (w.graphWidth * k) / 2, 360 - (w.graphHeight * k) / 2).scale(k));
  }, ZOOM);
  const settled = () =>
    page.waitForFunction(() => {
      const s = (globalThis as any).rendererStatus?.();
      return s?.active === "gpu" && s.gpu?.canvasVisible && !s.gpu.pending && !s.gpu.refinementPending && s.gpu.state !== "lost";
    }, {}, { timeout: 120000, polling: 50 });
  await page.evaluate(async () => {
    const w = globalThis as any;
    await w.__tupaia.settle();
    await Promise.all([w.reliefRenderReady, w.burgRenderReady]);
  });
  await settled();
  report.contextProperties = await page.evaluate(() => {
    const gl = (document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement)?.getContext("webgl2");
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");
    return gl ? { adapter: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null, inputPending: typeof (navigator as any).scheduling?.isInputPending === "function" } : null;
  });
  report.world = { name: WORLD, ...(await page.evaluate(() => ({ cells: (globalThis as any).pack?.cells?.i?.length, emblems: document.querySelectorAll("#emblems use").length, labels: document.querySelectorAll("#labels text").length }))) };
  const session = await context.newCDPSession(page);
  await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
  const allKeys = [...new Set(ARMS.flatMap(arm => (arm === "base" ? [] : arm.split("&").map(p => p.split("=")[0]))))];

  for (let rep = 0; rep < REPS; rep++) {
    const order = rep % 2 ? [...ARMS].reverse() : ARMS;
    for (const arm of order) {
      await page.evaluate(({ arm, allKeys }) => {
        const url = new URL(location.href);
        for (const key of allKeys) url.searchParams.delete(key);
        if (arm !== "base") for (const part of arm.split("&")) {
          const at = part.indexOf("=");
          url.searchParams.set(at < 0 ? part : part.slice(0, at), at < 0 ? "1" : part.slice(at + 1));
        }
        history.replaceState(history.state, "", url);
      }, { arm, allKeys });
      await settled();
      await page.waitForTimeout(500);
      const shotBefore = await page.screenshot();
      const before = await page.evaluate(({ cold }) => {
        const w = globalThis as any;
        const g = w.rendererStatus().gpu;
        const state: any = (w.__restoreProbe = { events: [] as [number, number][], tasks: [] as [number, number][], restoreAt: 0 });
        const onEvent = (e: Event) => {
          const stamp = e.timeStamp;
          requestAnimationFrame(() => state.events.push([stamp, performance.now() - stamp]));
        };
        window.addEventListener("mousemove", onEvent, true);
        const observer = new PerformanceObserver(list => {
          for (const e of list.getEntries()) state.tasks.push([e.startTime, e.duration]);
        });
        observer.observe({ type: "longtask", buffered: false });
        state.cleanup = () => {
          window.removeEventListener("mousemove", onEvent, true);
          observer.disconnect();
        };
        if (cold) w.gpuRenderer.invalidate();
        const canvas = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement;
        const ext = canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context");
        if (!ext) throw Error("WEBGL_lose_context unavailable");
        w.__restoreExt = ext;
        const revision = g.revision;
        ext.loseContext();
        return { revision, prepares: g.prepares, search: location.search };
      }, { cold: COLD });
      await page.waitForFunction(() => (globalThis as any).rendererStatus?.().gpu?.state === "lost", {}, { timeout: 15000, polling: 10 });
      let moving = INPUT;
      const mover = (async () => {
        let i = 0;
        while (moving) {
          i++;
          await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640 + 120 * Math.sin(i / 9), y: 360 + 80 * Math.cos(i / 7) });
          await new Promise(done => setTimeout(done, 16));
        }
      })();
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        const w = globalThis as any;
        w.__restoreProbe.restoreAt = performance.now();
        w.__restoreExt.restoreContext();
        delete w.__restoreExt;
      });
      await page.waitForFunction(() => {
        const r = (globalThis as any).rendererStatus?.().gpu?.restore;
        return r && r.outcome !== "restoring";
      }, {}, { timeout: 120000, polling: 20 });
      const drawn = await page.evaluate(() => {
        const w = globalThis as any;
        const g = w.rendererStatus().gpu;
        return { at: performance.now(), restore: g.restore, lastPrepare: g.lastPrepare, lastPrepareMs: g.lastPrepareMs, revision: g.revision, memory: g.memory };
      });
      moving = false;
      await mover;
      await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
      await settled();
      await page.waitForTimeout(300);
      const shotAfter = await page.screenshot();
      const after = await page.evaluate(({ drawnAt }) => {
        const w = globalThis as any;
        const s = w.__restoreProbe;
        s.cleanup();
        const inWindow = (at: number) => at >= s.restoreAt && at <= drawnAt;
        const events = s.events.filter(([at]: [number, number]) => inWindow(at)).map(([, ms]: [number, number]) => ms);
        const tasks = s.tasks.filter(([at]: [number, number]) => inWindow(at)).map(([, ms]: [number, number]) => ms);
        delete w.__restoreProbe;
        return { events, tasks, settledMs: performance.now() - drawnAt, prepares: w.rendererStatus().gpu.prepares };
      }, { drawnAt: drawn.at });
      const r = drawn.restore ?? {};
      const sample = {
        rep,
        arm,
        search: before.search,
        outcome: r.outcome,
        sameRevision: drawn.revision === before.revision,
        lossToDrawMs: r.lossToDrawMs,
        restoredToDrawMs: r.lossToDrawMs != null && r.lossToRestoredMs != null ? r.lossToDrawMs - r.lossToRestoredMs : null,
        prepareMs: r.prepareMs,
        failedPrepares: r.failedPrepares,
        steps: r.steps,
        phases: drawn.lastPrepare?.phases,
        reason: drawn.lastPrepare?.reason,
        reuse: drawn.lastPrepare?.reuse && { cloned: drawn.lastPrepare.reuse.cloned, worldKept: drawn.lastPrepare.reuse.worldKept, reasons: drawn.lastPrepare.reuse.reasons },
        retained: drawn.lastPrepare?.reuse?.retained ?? null,
        eventToRaf: summarize(after.events),
        longTasks: { ...summarize(after.tasks), totalMs: Math.round(after.tasks.reduce((n: number, t: number) => n + t, 0)) },
        settleAfterDrawMs: Math.round(after.settledMs),
        pixelsVsBeforeLoss: diff(shotBefore, shotAfter),
        memory: drawn.memory
      };
      report.samples.push(sample);
      console.log(JSON.stringify({ rep, arm, outcome: sample.outcome, lossToDrawMs: sample.lossToDrawMs, restoredToDrawMs: sample.restoredToDrawMs, prepareMs: sample.prepareMs, steps: sample.steps, eventToRafP95: sample.eventToRaf.p95, n: sample.eventToRaf.n }));
      if (sample.outcome !== "drawn") throw Error(`restore ${sample.outcome} on arm ${arm}`);
      if (!COLD && !sample.sameRevision) report.warnings.push(`rep ${rep} arm ${arm}: revision changed during a same-revision restore`);
    }
  }
  report.summary = Object.fromEntries(
    ARMS.map(arm => {
      const rows = report.samples.filter((s: any) => s.arm === arm);
      const steps = [...new Set(rows.flatMap((s: any) => Object.keys(s.steps ?? {})))] as string[];
      return [arm, {
        n: rows.length,
        lossToDrawMs: median(rows.map((s: any) => s.lossToDrawMs)),
        restoredToDrawMs: median(rows.map((s: any) => s.restoredToDrawMs)),
        prepareMs: median(rows.map((s: any) => s.prepareMs)),
        steps: Object.fromEntries(steps.map(step => [step, median(rows.map((s: any) => s.steps?.[step]))])),
        eventToRafP95: median(rows.map((s: any) => s.eventToRaf.p95)),
        eventToRafMax: Math.max(...rows.map((s: any) => s.eventToRaf.max ?? 0)),
        longTaskMs: median(rows.map((s: any) => s.longTasks.totalMs)),
        sameRevision: rows.every((s: any) => s.sameRevision),
        retained: rows.map((s: any) => s.retained),
        over16VsBeforeLossMax: Math.max(...rows.map((s: any) => s.pixelsVsBeforeLoss.over16))
      }];
    })
  );
  report.limitations = "Injected WEBGL_lose_context at rest and CDP hover input; lossToDrawMs ends at the first restored draw() call (not photons). Medians of few samples: descriptive, not a gate.";
  await session.detach();
} catch (e) {
  report.failure = String(e);
} finally {
  if (report.warnings.some((w: string) => /GL_INVALID_|Feedback loop/i.test(w))) report.failure ??= "WebGL validation warning; reject timing result";
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary ?? report.failure));
  await browser.close();
  await new Promise<void>(done => server.close(() => done()));
}
