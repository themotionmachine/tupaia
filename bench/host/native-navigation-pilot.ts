// Ported from the Codex host harness (control/native-navigation-pilot.ts). Run it through bench/gate/gate.ts, which holds the
// host lock and sets GATE_OUT_DIR (evidence directory) and GATE_MAP (shared-v8 fixture). See docs/performance/webgl-rewrite/GATE.md.
//
// CDP-injected pan-near, pan-wide and wheel-zoom per world (NAV_WORLDS, default shared,100k,parity):
//   shared  the shared-v8 fixture with heightmap and relief on; pans at k 8, the wheel zoom from k 3.5
//   100k    a generated 100k-cell world with heightmap and relief on; same cameras
//   parity  (W4a PAN) the parity fixture with its preamble: every layer on, trade caravans live as loaded, the heaviest
//           document the gate has. Pans and the wheel zoom at k 2 (NAV_PARITY_K), the dense view where PAINT (W3b) saw
//           ~10 fps pans: every SVG write under the canvas cost a ~150 ms layerize there.
// Per gesture: frame interval and event-to-next-rAF summaries, the GPU-presented fraction, and from a Chrome trace of the
// gesture the main thread's Layerize (count, total, max, per frame, events over 16 ms), Paint and style totals. The
// trace is split at the last input event (a console.timeStamp): `layerizeMotion` is what the gesture itself cost,
// `layerizeSettle` what came after it (the exact camera update writes the model SVG once at rest). Fails only on
// errors; timings are descriptive. The parity pans also report the W4a targets (frame p95 <= 16.7 ms over the whole
// gesture, no Layerize over 16 ms during motion) as `targets`, not gated.
import { chromium, type CDPSession, type Page } from "playwright";
import { createServer } from "node:http";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";

const root = resolve(import.meta.dirname, "../.."); // repo root: bench/host -> ../..
const dist = resolve(root, "dist");
const output = resolve(process.env.GATE_OUT_DIR || process.cwd(), process.env.SMOKE_NAME || "gpu-smoke");
const WORLDS = (process.env.NAV_WORLDS || "shared,100k,parity").split(",").map(w => w.trim()).filter(Boolean);
const PARITY_MAP = resolve(process.env.NAV_PARITY_MAP || resolve(root, "tests/fixtures/parity/parity-v1.map"));
const PARITY_K = Number(process.env.NAV_PARITY_K || 2);
const DPR = Number(process.env.SMOKE_DPR || 1);
const arm = process.env.NAV_RENDERER || "gpu";
const TARGET_FRAME_P95 = 16.7;
const TARGET_LAYERIZE_MAX = 16;

const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
const server = createServer((request, response) => {
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

const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--use-angle=metal", "--enable-gpu"] });
const report: Record<string, unknown> & { errors: string[]; warnings: string[]; failure: string | null } = {
  diagnosticNoMsaa: process.env.SMOKE_NO_MSAA === "1",
  diagnosticOpaqueCanvas: process.env.SMOKE_OPAQUE_CANVAS === "1",
  diagnosticHiddenRelief: process.env.SMOKE_HIDE_RELIEF === "1",
  runStartedUtc: new Date().toISOString(),
  worlds: WORLDS,
  errors: [],
  warnings: [],
  failure: null,
  status: null,
  diff: null,
  animation: null
};

const summarize = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, p50: s[Math.floor(s.length * 0.5)] || 0, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] || 0, max: s.at(-1) || 0 };
};

// Main-thread (CrRendererMain) totals of a trace: Layerize is Chrome's PaintArtifactCompositor::Update, the cost W3b
// PAINT found every SVG write under the canvas pays (the whole document is re-layerized). `frames` and `motionFrames`
// are the frame intervals of the whole gesture and of its motion (up to the "nav-input-end" time stamp).
function traceSummary(events: any[], frames: number, motionFrames: number) {
  const names = new Map<string, string>();
  for (const e of events) if (e.ph === "M" && e.name === "thread_name") names.set(`${e.pid}:${e.tid}`, e.args.name);
  const main = events.filter(e => e.ph === "X" && typeof e.dur === "number" && names.get(`${e.pid}:${e.tid}`) === "CrRendererMain");
  const durations = (name: string, keep: (e: any) => boolean = () => true) =>
    main.filter(e => e.name === name && keep(e)).map(e => e.dur / 1000);
  const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0);
  const stats = (values: number[], count: number) => ({
    count: values.length,
    totalMs: total(values),
    maxMs: Math.max(0, ...values),
    msPerFrame: count ? total(values) / count : 0,
    over16: values.filter(ms => ms > 16).length
  });
  const start = events.find(e => e.name === "TimeStamp" && e.args?.data?.message === "nav-input-start")?.ts;
  const end = events.find(e => e.name === "TimeStamp" && e.args?.data?.message === "nav-input-end")?.ts ?? Infinity;
  // The longest Layerize over 16 ms during motion, for diagnosis: when (ms from the first input), the main-thread work
  // just before it in the same frame and, with NAV_TRACE_INVALIDATIONS=1, the invalidation records that led to it.
  const worst = main.filter(e => e.name === "Layerize" && e.ts < end && e.dur > 16000).sort((a, b) => b.dur - a.dur)[0];
  const label = (e: any) => {
    const data = e.args?.data ?? {};
    const where = data.url ? ` ${String(data.url).split("/").pop()}:${data.lineNumber}` : "";
    return `${e.name}${data.type ? `(${data.type})` : ""}${data.functionName ? `[${data.functionName}]` : ""}${where}`;
  };
  const invalidations = (around: any) => {
    const counts = new Map<string, number>();
    for (const e of events) {
      if (!/InvalidationTracking/.test(e.name) || e.ts > around.ts || e.ts < around.ts - 50000) continue;
      const data = e.args?.data ?? {};
      const key = `${e.name.replace("InvalidationTracking", "")}: ${data.reason || ""} ${data.nodeName || ""}`.trim().slice(0, 140);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key, n]) => `${n}x ${key}`);
  };
  return {
    layerize: stats(durations("Layerize"), frames),
    layerizeMotion: stats(durations("Layerize", e => e.ts < end), motionFrames),
    layerizeSettle: stats(durations("Layerize", e => e.ts >= end), Math.max(0, frames - motionFrames)),
    layerizeMotionWorst: worst
      ? {
          ms: worst.dur / 1000,
          atMs: start === undefined ? null : Math.round((worst.ts - start) / 1000),
          before: main
            .filter(e => e.ts < worst.ts && e.ts > worst.ts - 30000 && /^(FunctionCall|TimerFire|EventDispatch|FireAnimationFrame|UpdateLayoutTree|ParseHTML|XHRReadyStateChange)$/.test(e.name))
            .slice(-10)
            .map(e => `${label(e)} +${Math.round((e.ts - worst.ts) / 1000)}ms ${(e.dur / 1000).toFixed(1)}ms`),
          invalidations: invalidations(worst)
        }
      : null,
    inputEndMarked: Number.isFinite(end),
    paintMs: total(durations("Paint")),
    styleMs: total(durations("UpdateLayoutTree")),
    longestTaskMs: Math.max(0, ...main.filter(e => e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask").map(e => e.dur / 1000))
  };
}

async function traced<T>(session: CDPSession, run: () => Promise<T>): Promise<{ events: any[]; result: T }> {
  const events: any[] = [];
  const collect = (event: { value: any[] }) => events.push(...event.value);
  session.on("Tracing.dataCollected", collect);
  const complete = new Promise(done => session.once("Tracing.tracingComplete", done));
  // NAV_TRACE_INVALIDATIONS=1 (diagnosis only: it slows style and layout invalidation) records what invalidated
  const invalidationTracking = process.env.NAV_TRACE_INVALIDATIONS === "1" ? ",disabled-by-default-devtools.timeline.invalidationTracking" : "";
  await session.send("Tracing.start", { categories: `devtools.timeline,disabled-by-default-devtools.timeline,blink,cc,toplevel${invalidationTracking}`, transferMode: "ReportEvents" });
  try {
    const result = await run();
    return { events, result };
  } finally {
    await session.send("Tracing.end");
    await complete;
    session.off("Tracing.dataCollected", collect);
  }
}

async function settled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = globalThis as any;
    await w.__tupaia.settle();
    await Promise.all([w.reliefRenderReady, w.burgRenderReady]);
  });
}

// A press point the map pans from: the view centre unless an element with its own drag (a ruler, the legend) or a root
// overlay is there, else the nearest point on a ring around it that is inside #viewbox and clear of them.
async function pressPoint(page: Page): Promise<{ x: number; y: number; target: string }> {
  return page.evaluate(() => {
    const avoid = "#ruler, #legend, #scaleBar";
    for (let radius = 0; radius < 400; radius += 7)
      for (let angle = 0; angle < 360; angle += radius ? 15 : 360) {
        const x = Math.round(640 + radius * Math.cos((angle * Math.PI) / 180));
        const y = Math.round(360 + radius * Math.sin((angle * Math.PI) / 180));
        const element = document.elementFromPoint(x, y);
        if (element?.closest("#viewbox") && !element.closest(avoid))
          return { x, y, target: `${element.tagName.toLowerCase()}${element.id ? "#" + element.id : ""} in #${element.parentElement?.id || "?"}` };
      }
    return { x: 640, y: 360, target: "none found" };
  });
}

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: DPR, serviceWorkers: "block" });
  if (process.env.SMOKE_NO_MSAA === "1") await context.addInitScript(() => ((globalThis as any).__benchNoMsaa = true));
  if (process.env.SMOKE_OPAQUE_CANVAS === "1") await context.addInitScript(() => ((globalThis as any).__benchOpaqueCanvas = true));
  if (process.env.SMOKE_OPAQUE_CANVAS === "1" || process.env.SMOKE_NO_MSAA === "1")
    await context.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      (HTMLCanvasElement.prototype as any).getContext = function (kind: string, options: any) {
        const w = globalThis as any;
        return (original as any).call(this, kind, kind === "webgl2" ? { ...options, ...(w.__benchOpaqueCanvas ? { alpha: false } : {}), ...(w.__benchNoMsaa ? { antialias: false } : {}) } : options);
      };
    });
  await context.addInitScript(() => {
    localStorage.setItem("autosaveInterval", "0");
    localStorage.setItem("azgaarAssistant", "hide");
  });
  const scripts = ["bridge.js", "bridge-mutations.js", ...readdirSync(resolve(root, "mcp/src/bridge-ext")).filter(n => n.endsWith(".js")).sort().map(n => "bridge-ext/" + n)];
  await context.addInitScript(scripts.map(n => readFileSync(resolve(root, "mcp/src", n), "utf8")).join("\n"));
  await context.addInitScript({ path: resolve(import.meta.dirname, "fixtures/parity-page.js") }); // __parity.preamble
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.origin === origin || (route.request().method() === "GET" && url.hostname === "fonts.gstatic.com") ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  page.on("pageerror", e => report.errors.push(e.message));
  page.on("console", m => {
    if (["warning", "error"].includes(m.type()) && report.warnings.length < 50) report.warnings.push(m.text().slice(0, 1000));
  });
  page.on("dialog", d => d.dismiss());
  await page.goto(origin + "/?local&seed=7319&width=1280&height=720&renderer=" + arm);
  await page.evaluate(() => (globalThis as any).__tupaia.call("ready", { timeoutMs: 120000 }).then((ready: any) => {
    if (!ready.ok) throw Error(JSON.stringify(ready));
  }));
  const session = await context.newCDPSession(page);
  const runs: Record<string, unknown>[] = [];

  for (const world of WORLDS) {
    page.setDefaultTimeout(world === "parity" ? 600000 : 90000);
    if (world === "shared")
      await page.evaluate(
        async ({ text, hideRelief }) => {
          const w = globalThis as any;
          await w.__tupaia.fns.loadMap({ text, timeoutMs: 120000 });
          const shown = await w.__tupaia.call("display", hideRelief ? { on: ["heightmap"], off: ["relief"] } : { on: ["heightmap", "relief"] });
          if (!shown.ok) throw Error(JSON.stringify(shown));
        },
        { text: readFileSync(process.env.GATE_MAP || "/tmp/tupaia-navigation-shared-v8.map", "utf8"), hideRelief: process.env.SMOKE_HIDE_RELIEF === "1" }
      );
    else if (world === "100k")
      await page.evaluate(async () => {
        const w = globalThis as any;
        await w.__tupaia.fns.generateMap({ cells: 100000, seed: "7319", template: "continents", width: 1280, height: 720 });
        await w.__tupaia.call("display", { on: ["heightmap", "relief"] });
      });
    else if (world === "parity")
      await page.evaluate(async text => {
        const w = globalThis as any;
        await w.__tupaia.fns.loadMap({ text, timeoutMs: 120000 });
        await w.__tupaia.settle();
        await w.__parity.preamble();
      }, readFileSync(PARITY_MAP, "utf8"));
    else throw Error(`unknown world ${world}`);
    await settled(page);
    if (!report.contextProperties)
      report.contextProperties = await page.evaluate(() => {
        const gl = (document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement)?.getContext("webgl2");
        return gl ? { attributes: gl.getContextAttributes(), samples: gl.getParameter(gl.SAMPLES) } : null;
      });

    for (const gesture of ["pan-near", "pan-wide", "wheel-zoom"]) {
      const k = world === "parity" ? PARITY_K : gesture === "wheel-zoom" ? 3.5 : 8;
      await page.evaluate(k => {
        const w = globalThis as any;
        w.d3.select("#map").call((0, eval)("zoom").transform, w.d3.zoomIdentity.translate(640 - (w.graphWidth * k) / 2, 360 - (w.graphHeight * k) / 2).scale(k));
      }, k);
      const readyStart = Date.now();
      await settled(page);
      if (arm === "gpu")
        await page.waitForFunction(
          () => {
            const s = (globalThis as any).rendererStatus?.();
            return s?.active === "gpu" && s.gpu?.canvasVisible && !s.gpu.pending && !s.gpu.refinementPending;
          },
          {},
          { timeout: world === "parity" ? 600000 : 30000 }
        );
      const readyWaitMs = Date.now() - readyStart;
      const press = await pressPoint(page);
      const idle = await page.evaluate(
        () =>
          new Promise<number[]>(resolve => {
            const times: number[] = [];
            let previous = 0;
            const tick = (t: number) => {
              if (previous) times.push(t - previous);
              previous = t;
              if (times.length < 120) requestAnimationFrame(tick);
              else resolve(times);
            };
            requestAnimationFrame(tick);
          })
      );
      await page.evaluate(() => {
        const w = globalThis as any;
        const gpu0 = w.rendererStatus?.().gpu;
        const state: any = (w.__nativeNav = {
          running: true,
          intervals: [] as number[],
          events: [] as number[],
          tasks: [] as number[],
          gpuFrames: 0,
          frames: 0,
          previous: 0,
          preparesAtStart: gpu0?.prepares || 0,
          preparesDuring: [] as number[],
          movingFrames: 0,
          cameras: [] as number[][],
          inputEnd: 0,
          windowsAtStart: gpu0?.windows ? { refreshes: gpu0.windows.refreshes, misses: gpu0.windows.misses, gaps: gpu0.windows.gaps ?? 0 } : null,
          panAtStart: gpu0?.pan ? { ...gpu0.pan } : null
        });
        const event = (e: Event) => {
          const stamp = e.timeStamp;
          requestAnimationFrame(() => state.events.push(performance.now() - stamp));
        };
        window.addEventListener("mousemove", event, true);
        window.addEventListener("wheel", event, true);
        const observer = new PerformanceObserver(list => {
          for (const e of list.getEntries()) state.tasks.push(e.duration);
        });
        observer.observe({ type: "longtask", buffered: false });
        state.cleanup = () => {
          window.removeEventListener("mousemove", event, true);
          window.removeEventListener("wheel", event, true);
          observer.disconnect();
        };
        const tick = (t: number) => {
          if (!state.running) return;
          if (state.previous) state.intervals.push(t - state.previous);
          state.previous = t;
          state.frames++;
          const gpu = w.rendererStatus?.().gpu;
          if (gpu?.canvasVisible) state.gpuFrames++;
          state.preparesDuring.push(gpu?.prepares || 0);
          if (gpu?.moving) state.movingFrames++;
          state.cameras.push([(0, eval)("scale"), (0, eval)("viewX"), (0, eval)("viewY")]);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const { events, result: data } = await traced(session, async () => {
        await page.evaluate(() => console.timeStamp("nav-input-start"));
        if (gesture !== "wheel-zoom") await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: press.x, y: press.y, button: "left", buttons: 1, clickCount: 1 });
        for (let frame = 0; frame < 120; frame++) {
          if (gesture === "wheel-zoom") await session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: press.x, y: press.y, deltaX: 0, deltaY: frame < 60 ? -8 : 8 });
          else {
            const amount = gesture === "pan-near" ? 60 : 600;
            await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: press.x + amount * Math.sin((frame / 120) * Math.PI * 4), y: press.y + 60 * Math.sin((frame / 120) * Math.PI * 2), button: "left", buttons: 1 });
          }
          await new Promise(done => setTimeout(done, 8));
        }
        // the motion/settle boundary, in the trace and in the frame intervals
        await page.evaluate(() => {
          const s = (globalThis as any).__nativeNav;
          s.inputEnd = s.intervals.length;
          console.timeStamp("nav-input-end");
        });
        if (gesture !== "wheel-zoom") await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: press.x, y: press.y, button: "left", buttons: 0, clickCount: 1 });
        return page.evaluate(async () => {
          await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
          const w = globalThis as any;
          const s = w.__nativeNav;
          s.running = false;
          s.cleanup();
          delete s.cleanup;
          return s;
        });
      });
      await page.waitForTimeout(800);
      await settled(page);
      const status = await page.evaluate(() => {
        const w = globalThis as any;
        const renderer = w.rendererStatus?.();
        return {
          renderer,
          cells: w.pack.cells.i.length,
          caravans: document.querySelectorAll("#tradeAnimation > g").length,
          finalCameraExact: document.querySelector("#viewbox")?.getAttribute("transform") === `translate(${(0, eval)("viewX")} ${(0, eval)("viewY")}) scale(${(0, eval)("scale")})`
        };
      });
      const frame = summarize(data.intervals);
      const motionFrame = summarize(data.intervals.slice(0, data.inputEnd));
      const trace = traceSummary(events, data.intervals.length, data.inputEnd);
      const windows = status.renderer?.gpu?.windows;
      const pan = status.renderer?.gpu?.pan;
      const panAtStart = data.panAtStart;
      const run: Record<string, unknown> = {
        world,
        gesture,
        k,
        inputMethod: "cdp-input",
        injected: true,
        physicalInput: false,
        press,
        readyWaitMs,
        deviceScaleFactor: DPR,
        frame,
        motionFrame,
        idleFrame: summarize(idle),
        eventToNextRaf: summarize(data.events),
        longTasks: summarize(data.tasks),
        gpuPresentedFraction: data.gpuFrames / data.frames,
        preparesDuringMotion: Math.max(...data.preparesDuring) - data.preparesAtStart,
        movingFrameFraction: data.movingFrames / data.frames,
        cameraChanged: new Set(data.cameras.map((v: number[]) => v.join(","))).size > 1,
        ...trace,
        windowsDuringMotion: windows && data.windowsAtStart
          ? {
              refreshes: windows.refreshes - data.windowsAtStart.refreshes,
              misses: windows.misses - data.windowsAtStart.misses,
              gaps: (windows.gaps ?? 0) - data.windowsAtStart.gaps
            }
          : null,
        // W4a pan cache (FrameGraph.pan) over the gesture: moving frames drawn shifted, (re)builds, zoom frames drawn
        // without it, refusals for room; null on a build without it
        panCache: pan && panAtStart
          ? Object.fromEntries(["shifts", "rebuilds", "zooms", "refused", "strips"].map(key => [key, pan[key] - panAtStart[key]]))
          : null,
        ...status
      };
      if (world === "parity" && gesture !== "wheel-zoom")
        run.targets = {
          frameP95: frame.p95 <= TARGET_FRAME_P95,
          layerizeMax: trace.layerizeMotion.maxMs <= TARGET_LAYERIZE_MAX,
          limits: { frameP95: TARGET_FRAME_P95, layerizeMotionMaxMs: TARGET_LAYERIZE_MAX }
        };
      runs.push(run);
      console.log(
        JSON.stringify({
          world,
          gesture,
          k,
          press: press.target,
          frameP95: frame.p95,
          motionFrameP95: motionFrame.p95,
          eventToNextRafP95: summarize(data.events).p95,
          gpuPresentedFraction: run.gpuPresentedFraction,
          layerizeMotion: trace.layerizeMotion,
          layerizeMotionWorst: trace.layerizeMotionWorst,
          layerizeSettle: trace.layerizeSettle,
          panCache: run.panCache,
          cameraChanged: run.cameraChanged
        })
      );
    }
  }
  report.runs = runs;
  report.requestedRenderer = arm;
  report.limitations = "Pilot only; injected CDP browser input, event timestamp to next requestAnimationFrame (not physical input-to-photon), not 10 interleaved pairs. Frame timings are taken under a Chrome timeline trace (W4a).";
  await session.detach();
} catch (e) {
  report.failure = String(e instanceof Error ? e.stack || e.message : e);
} finally {
  if (report.warnings.some(w => /GL_INVALID_|Feedback loop/i.test(w))) report.failure ??= "WebGL validation warning; reject render/timing result";
  if (!report.failure && Array.isArray(report.runs) && (report.runs as any[]).some(r => !r.cameraChanged)) report.failure = "a gesture did not move the camera";
  writeFileSync(output + ".json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ failure: report.failure, errors: report.errors.length }));
  await browser.close();
  await new Promise<void>(done => server.close(() => done()));
}
