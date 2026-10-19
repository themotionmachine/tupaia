import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, extname, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { frameBudgets, budgetToleranceFraction } from "./frame-budget.ts";
import { attributeTrace } from "./trace.ts";
import { platform, arch, cpus, loadavg } from "node:os";

const dist = resolve(process.env.BENCH_DIST || "dist");
const output = process.env.BENCH_OUTPUT || "bench/results/navigation-current.json";
const samples = Number(process.env.BENCH_SAMPLES || 3);
const tracing = process.env.BENCH_TRACE === "1";
const frames = Number(process.env.BENCH_FRAMES || 120);
if (!Number.isInteger(samples) || samples < 1 || !Number.isInteger(frames) || frames < 30)
  throw new Error("Invalid navigation benchmark settings");
const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2"
};
const headless = process.env.BENCH_HEADLESS !== "0";
if (process.env.BENCH_HEADLESS && !["0", "1"].includes(process.env.BENCH_HEADLESS))
  throw new Error("Invalid BENCH_HEADLESS");
const channel = process.env.BENCH_CHANNEL;
if (channel && channel !== "chromium") throw new Error("BENCH_CHANNEL only supports installed Chromium");
const angle = process.env.BENCH_ANGLE;
if (angle && !["metal", "swiftshader"].includes(angle)) throw new Error("Invalid BENCH_ANGLE");
if (process.env.BENCH_GPU && !["0", "1"].includes(process.env.BENCH_GPU)) throw new Error("Invalid BENCH_GPU");
const enableGpu = process.env.BENCH_GPU === "1";
const launchConfig = { headless, channel, angle, enableGpu };
const launchArgs = [
  ...(angle ? ["--use-angle=" + angle] : []),
  ...(enableGpu ? ["--enable-gpu"] : []),
  ...(!headless ? ["--window-position=-10000,-10000"] : [])
];
const server = createServer((request, response) => {
  const path = resolve(dist, "." + new URL(request.url || "/", "http://localhost").pathname);
  if (!path.startsWith(dist + "/") && path !== dist) {
    response.writeHead(403).end();
    return;
  }
  try {
    const file = path === dist ? resolve(dist, "index.html") : path;
    response.setHeader("content-type", mime[extname(file)] || "application/octet-stream");
    response.end(readFileSync(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("No benchmark port");
const origin = "http://127.0.0.1:" + address.port;
const browser = await chromium.launch({ headless, channel, args: launchArgs }).catch(async error => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  throw error;
});
const runs: unknown[] = [];
const coldStarts: unknown[] = [];
const loadAverageStart = loadavg();
try {
  const systemSession = await browser.newBrowserCDPSession();
  const { gpu: runtimeGpu } = await systemSession.send("SystemInfo.getInfo");
  const gpu = {
    devices: runtimeGpu.devices.map(device => ({
      vendorString: device.vendorString,
      deviceString: device.deviceString,
      driverVendor: device.driverVendor,
      driverVersion: device.driverVersion
    })),
    featureStatus: runtimeGpu.featureStatus
  };
  await systemSession.detach();
  console.log(JSON.stringify({ launchConfig, gpu, loadAverageStart }));
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    serviceWorkers: "block"
  });
  await context.addInitScript(() => {
    localStorage.setItem("autosaveInterval", "0");
    localStorage.setItem("azgaarAssistant", "hide");
    (globalThis as any).__mcpBoot = new Promise(resolve => addEventListener("map:generated", resolve, { once: true }));
  });
  const scripts = [
    "bridge.js",
    "bridge-mutations.js",
    ...readdirSync("mcp/src/bridge-ext")
      .filter(n => n.endsWith(".js"))
      .sort()
      .map(n => "bridge-ext/" + n)
  ];
  await context.addInitScript(scripts.map(n => readFileSync("mcp/src/" + n, "utf8")).join("\n"));
  await context.route("**/*", route =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
  );
  const page = await context.newPage();
  page.setDefaultTimeout(300000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.dismiss());
  const workerQuery = process.env.BENCH_RELIEF_WORKER === "1" ? "&reliefWorker=1" : "";
  await page.goto(origin + "/?local&seed=7319&width=1280&height=720" + workerQuery);
  await page.evaluate(async () => {
    const runtime = (globalThis as any).__tupaia;
    const result = await runtime.call("ready", { timeoutMs: 120000 });
    if (!result.ok) throw new Error(JSON.stringify(result));
  });
  const sharedText = process.env.BENCH_MAP ? readFileSync(process.env.BENCH_MAP, "utf8") : undefined;
  const fixtureHash = sharedText ? createHash("sha256").update(sharedText).digest("hex") : undefined;
  const sharedWorld = process.env.BENCH_MAP_LABEL || "shared";
  if (!/^[a-zA-Z0-9_-]+$/.test(sharedWorld)) throw new Error("Invalid BENCH_MAP_LABEL");
  const metaPath = process.env.BENCH_MAP_META || process.env.BENCH_MAP?.replace(/\.map$/, ".meta");
  const meta = metaPath && existsSync(metaPath) ? readFileSync(metaPath, "utf8") : "";
  const header = (name: string) =>
    meta
      .split(/\r?\n/)
      .find(line => line.toLowerCase().startsWith(name + ":"))
      ?.slice(name.length + 1)
      .trim();
  const fixtureMetadata = sharedText
    ? { label: sharedWorld, version: header("x-map-version"), updatedAt: header("x-map-updated-at") }
    : undefined;
  const worlds = process.env.BENCH_WORLDS?.split(",") || (sharedText ? [sharedWorld, "100k"] : ["demo", "100k"]);
  if (
    worlds.some(world => !["demo", sharedWorld, "100k"].includes(world)) ||
    (worlds.includes(sharedWorld) && !sharedText)
  )
    throw new Error("Invalid BENCH_WORLDS or missing BENCH_MAP");
  for (const world of worlds) {
    await page.evaluate(
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
            : await runtime.fns.loadMap({ text: text || "", timeoutMs: 300000 });
        if (result?.ok === false) throw new Error(JSON.stringify(result));
        const displayed = await runtime.call("display", { on: ["heightmap", "relief"] });
        if (!displayed.ok) throw new Error(JSON.stringify(displayed));
        await Promise.all([(globalThis as any).reliefRenderReady, (globalThis as any).burgRenderReady]);
        await runtime.settle();
      },
      { world, text: sharedText || readFileSync("tests/fixtures/demo.map", "utf8") }
    );
    for (const gesture of ["pan-near", "pan-wide", "wheel-zoom"]) {
      for (let iteration = 0; iteration <= samples; iteration++) {
        const traceSession = tracing && iteration === samples ? await context.newCDPSession(page) : undefined;
        if (traceSession)
          await traceSession.send("Tracing.start", {
            categories:
              "devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing,cc",
            transferMode: "ReturnAsStream"
          });
        const result = await page.evaluate(
          async ({ gesture, frames, markInput }) => {
            const w = globalThis as any;
            const raf = w.requestAnimationFrame.bind(w);
            const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
            const root = document.getElementById("viewbox")!;
            const map = document.getElementById("map")!;
            const initialScale = gesture === "wheel-zoom" ? 3.5 : 8;
            w.d3
              .select(map)
              .call(
                (0, eval)("zoom").transform,
                w.d3.zoomIdentity
                  .translate(640 - (w.graphWidth * initialScale) / 2, 360 - (w.graphHeight * initialScale) / 2)
                  .scale(initialScale)
              );
            await sleep(350);
            function digest() {
              let hash = 2166136261;
              for (const field of ["h", "biome", "state", "culture", "burg", "r"])
                for (const value of w.pack.cells[field] || []) hash = Math.imul(hash ^ value, 16777619);
              return hash >>> 0;
            }
            const before = digest();
            const idleIntervals: number[] = [];
            performance.mark("navigation:idle:start");
            await new Promise<void>(resolve => {
              let count = 0,
                last = 0;
              const tick = (time: number) => {
                if (last) idleIntervals.push(time - last);
                last = time;
                if (++count < frames) raf(tick);
                else resolve();
              };
              raf(tick);
            });
            performance.mark("navigation:idle:end");
            const functionSamples: Record<string, number[]> = {};
            const originals: Record<string, Function> = {};
            for (const name of [
              "invokeActiveZooming",
              "updateZoomStyling",
              "refreshDenseZoom",
              "cullMapLabels",
              "updateMinimap",
              "drawCoordinates"
            ]) {
              if (typeof w[name] !== "function") continue;
              originals[name] = w[name];
              functionSamples[name] = [];
              w[name] = function (...args: unknown[]) {
                const start = performance.now();
                try {
                  return originals[name].apply(this, args);
                } finally {
                  functionSamples[name].push(performance.now() - start);
                }
              };
            }
            const callbackMs: number[] = [],
              intervals: number[] = [];
            const inputDispatchMs: number[] = [];
            const motionSurfaceActiveFrames: boolean[] = [];
            let denseSettleMs = 0;
            const densePendingAtStart = Boolean(w.denseZoomPending);
            const denseBackendAtStart = w.reliefWorkerStatus ? w.reliefWorkerStatus() : null;
            const densePendingFrames: boolean[] = [];
            const motionSurfaceReadyAtStart = Boolean(w.MotionSurface?.ready);
            const dispatch = (target: EventTarget, event: Event) => {
              if (markInput) performance.mark("navigation:input:start");
              const start = performance.now();
              try {
                return target.dispatchEvent(event);
              } finally {
                inputDispatchMs.push(performance.now() - start);
                if (markInput) performance.mark("navigation:input:end");
              }
            };
            const oldRaf = w.requestAnimationFrame;
            w.requestAnimationFrame = (callback: FrameRequestCallback) =>
              raf((time: number) => {
                const start = performance.now();
                try {
                  callback(time);
                } finally {
                  callbackMs.push(performance.now() - start);
                }
              });
            let mutations = 0,
              overlayAdds = 0,
              overlayRemoves = 0,
              glyphAdds = 0,
              glyphRemoves = 0;
            const observer = new MutationObserver(records => {
              mutations += records.length;
              for (const record of records)
                if (record.type === "childList")
                  for (const [nodes, add] of [
                    [record.addedNodes, true],
                    [record.removedNodes, false]
                  ] as const)
                    for (const node of nodes) {
                      if (!(node instanceof Element)) continue;
                      const overlay = node.hasAttribute("data-dense-zoom");
                      if (overlay) {
                        if (add) overlayAdds++;
                        else overlayRemoves++;
                      }
                      const count = overlay
                        ? node.querySelectorAll("use").length
                        : node.tagName.toLowerCase() === "use" &&
                            (record.target as Element).closest?.("[data-dense-zoom]")
                          ? 1
                          : 0;
                      if (add) glyphAdds += count;
                      else glyphRemoves += count;
                    }
            });
            observer.observe(root, { subtree: true, childList: true, attributes: true });
            const startX = 640,
              startY = 360;
            const mouse = (type: string, x: number, y: number, buttons: number) =>
              new MouseEvent(type, {
                view: window,
                bubbles: true,
                cancelable: true,
                clientX: x,
                clientY: y,
                button: 0,
                buttons
              });
            let lastTime = 0;
            let gestureStart = 0,
              firstFrameWaitMs = 0;
            try {
              gestureStart = performance.now();
              performance.mark("navigation:gesture:start");
              if (gesture !== "wheel-zoom") dispatch(map, mouse("mousedown", startX, startY, 1));
              await new Promise<void>(resolve => {
                let frame = 0;
                function tick(time: number) {
                  if (lastTime) intervals.push(time - lastTime);
                  else firstFrameWaitMs = performance.now() - gestureStart;
                  lastTime = time;
                  if (gesture === "wheel-zoom")
                    dispatch(
                      map,
                      new WheelEvent("wheel", {
                        view: window,
                        bubbles: true,
                        cancelable: true,
                        clientX: 640,
                        clientY: 360,
                        deltaY: frame < frames / 2 ? -8 : 8
                      })
                    );
                  else {
                    const amount = gesture === "pan-near" ? 60 : 600;
                    dispatch(
                      window,
                      mouse(
                        "mousemove",
                        startX + amount * Math.sin((frame / frames) * Math.PI * 4),
                        startY + 60 * Math.sin((frame / frames) * Math.PI * 2),
                        1
                      )
                    );
                  }
                  motionSurfaceActiveFrames.push(Boolean(w.MotionSurface?.active));
                  densePendingFrames.push(Boolean(w.denseZoomPending));
                  frame++;
                  if (frame < frames) raf(tick);
                  else resolve();
                }
                raf(tick);
              });
              if (gesture !== "wheel-zoom") dispatch(window, mouse("mouseup", startX, startY, 0));
              await sleep(350);
              performance.mark("navigation:gesture:end");
              const denseStart = performance.now();
              if (w.waitDenseZoomReady) await w.waitDenseZoomReady(15000);
              denseSettleMs = performance.now() - denseStart;
              if (w.denseZoomPending) throw new Error("Dense renderer remained pending after settlement");
            } finally {
              observer.disconnect();
              w.requestAnimationFrame = oldRaf;
              for (const [name, fn] of Object.entries(originals)) w[name] = fn;
            }
            const settledStyles = () =>
              JSON.stringify({
                scaleBar: document.getElementById("scaleBar")?.outerHTML,
                nodes: [...document.querySelectorAll("#labels g,#emblems g,#markers > *,#statesHalo,#ruler text")].map(
                  node => [
                    node.id,
                    node.textContent,
                    ...[
                      "font-size",
                      "class",
                      "stroke-width",
                      "x",
                      "y",
                      "width",
                      "height",
                      "style",
                      "transform",
                      "d"
                    ].map(name => node.getAttribute(name))
                  ]
                )
              });
            const settledBefore = settledStyles();
            w.invokeActiveZooming();
            w.drawScaleBar((0, eval)("scaleBar"), (0, eval)("scale"));
            w.fitScaleBar((0, eval)("scaleBar"), (0, eval)("svgWidth"), (0, eval)("svgHeight"));
            await new Promise<void>(resolve => raf(() => raf(() => resolve())));
            const settledExact = settledBefore === settledStyles();
            if (!settledExact) throw new Error("Gesture did not settle to exact visual styles");
            const motionSurfaceActiveAfterSettle = Boolean(w.MotionSurface?.active);
            if (motionSurfaceActiveAfterSettle)
              throw new Error("Transient motion surface remained active after settle");
            const after = digest();
            if (before !== after) throw new Error("Navigation changed world data");
            const summary = (values: number[]) => {
              const sorted = [...values].sort((a, b) => a - b);
              const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0;
              return {
                count: values.length,
                p50: percentile(0.5),
                p95: percentile(0.95),
                max: sorted.at(-1) || 0,
                total: values.reduce((a, b) => a + b, 0)
              };
            };
            return {
              cells: w.pack.cells.i.length,
              gesture,
              frames,
              intervalsMs: intervals,
              firstFrameWaitMs,
              denseSettleMs,
              densePendingAtStart,
              densePendingFrames,
              densePendingAfterSettle: Boolean(w.denseZoomPending),
              denseBackendAtStart,
              denseBackendAfterSettle: w.reliefWorkerStatus ? w.reliefWorkerStatus() : null,
              reliefViewportTiles: document.querySelectorAll("image[data-relief-viewport]").length,
              motionSurfaceReadyAtStart,
              motionSurfaceActiveFrames,
              motionSurfaceActiveCount: motionSurfaceActiveFrames.filter(Boolean).length,
              motionSurfaceActiveAfterSettle,
              first10IntervalsMs: intervals.slice(0, 10),
              first10MaxMs: Math.max(0, ...intervals.slice(0, 10)),
              callbacksMs: callbackMs,
              frame: summary(intervals),
              callback: summary(callbackMs),
              idleIntervalsMs: idleIntervals,
              idleFrame: summary(idleIntervals),
              inputDispatchMs,
              inputDispatch: summary(inputDispatchMs),
              functions: Object.fromEntries(
                Object.entries(functionSamples).map(([name, values]) => [name, summary(values)])
              ),
              framesOver25ms: intervals.filter(n => n > 25).length,
              mutations,
              overlayAdds,
              overlayRemoves,
              glyphAdds,
              glyphRemoves,
              modelUnchanged: before === after,
              settledExact
            };
          },
          { gesture, frames, markInput: Boolean(traceSession) }
        );
        let traceAttribution: ReturnType<typeof attributeTrace> | undefined;
        let tracePath: string | undefined;
        if (traceSession) {
          const completed = new Promise<{ stream?: string }>(resolve =>
            traceSession.once("Tracing.tracingComplete", resolve)
          );
          await traceSession.send("Tracing.end");
          const { stream } = await completed;
          if (!stream) throw new Error("Trace stream unavailable");
          let raw = "";
          for (;;) {
            const chunk = await traceSession.send("IO.read", { handle: stream });
            raw += chunk.base64Encoded ? Buffer.from(chunk.data, "base64").toString("utf8") : chunk.data;
            if (chunk.eof) break;
          }
          await traceSession.send("IO.close", { handle: stream });
          await traceSession.detach();
          tracePath = resolve(
            process.env.BENCH_TRACE_DIR || "/tmp/tupaia-butter-traces",
            basename(output, ".json"),
            world + "-" + gesture + ".json"
          );
          mkdirSync(dirname(tracePath), { recursive: true });
          writeFileSync(tracePath, raw);
          traceAttribution = attributeTrace(JSON.parse(raw));
        }
        if (errors.length) throw new Error(errors.join("\n"));
        (iteration ? runs : coldStarts).push({
          world,
          iteration,
          ...result,
          frameBudgets: frameBudgets(result.intervalsMs),
          idleFrameBudgets: frameBudgets(result.idleIntervalsMs),
          tracePath,
          traceAttribution
        });
        console.log(
          JSON.stringify({
            world,
            iteration,
            gesture,
            frameP95: result.frame.p95,
            firstFrameWaitMs: result.firstFrameWaitMs,
            first10MaxMs: result.first10MaxMs,
            motionSurfaceActiveCount: result.motionSurfaceActiveCount,
            idleFrameP95: result.idleFrame.p95,
            inputDispatchP95: result.inputDispatch.p95,
            callbackP95: result.callback.p95,
            overlayAdds: result.overlayAdds,
            glyphAdds: result.glyphAdds,
            framesOver25ms: result.framesOver25ms
          })
        );
      }
    }
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(
    output,
    JSON.stringify(
      {
        schema: 2,
        tracing,
        gpu,
        launchConfig,
        fixtureHash,
        fixtureMetadata,
        budgetToleranceFraction,
        loadAverageStart,
        loadAverageEnd: loadavg(),
        node: process.version,
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        chromium: browser.version(),
        viewport: [1280, 720],
        deviceScaleFactor: 1,
        samples,
        frames,
        seed: "7319",
        layers: ["default", "heightmap", "relief"],
        limitations:
          "Headless Chromium synthetic DOM mouse/wheel gestures; window-dispatched drag moves exercise captured D3 pan but bypass native hovered-SVG hit testing and tooltip behavior; rAF intervals and input dispatch measures synchronous handler work, not hardware latency; budget counts use measured rAF intervals and the matched idle control distinguishes display cadence from app delay. Trace event durations can overlap and are not additive. Instrumented JS callbacks are not a physical-display FPS or input-to-photon measurement.",
        coldStarts,
        runs
      },
      null,
      2
    ) + "\n"
  );
} finally {
  await browser.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
