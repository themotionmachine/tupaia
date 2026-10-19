import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { playwrightGpuCapture } from "./gpu-capture.ts";
import { captureProblems, parseRendererEnv, rendererQuery } from "./renderer-ab.ts";

const dist = resolve(process.env.BENCH_DIST || "dist");
const deviceScaleFactor = Number(process.env.BENCH_DPR || 1);
if (![1, 2].includes(deviceScaleFactor)) throw new Error("BENCH_DPR must be 1 or 2");
const fontCDN = process.env.BENCH_FONT_CDN === "1";
const assetPolicy = fontCDN ? "local-and-font-cdn-get" : "local-only";
const text = readFileSync(process.env.BENCH_MAP || "/tmp/tupaia-navigation-shared-v8.map", "utf8");
const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2"
};
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
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing local benchmark server");
const origin = "http://127.0.0.1:" + address.port;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BENCH_CHANNEL ? { channel: process.env.BENCH_CHANNEL } : {}),
  args: [
    ...(process.env.BENCH_ANGLE ? ["--use-angle=" + process.env.BENCH_ANGLE] : []),
    ...(process.env.BENCH_GPU === "1" ? ["--enable-gpu"] : [])
  ]
});
try {
  const disableWorker = process.env.BENCH_DISABLE_WORKER === "1";
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor, serviceWorkers: "block" });
  await context.addInitScript(() => {
    localStorage.setItem("autosaveInterval", "0");
    localStorage.setItem("azgaarAssistant", "hide");
  });
  await context.addInitScript(disabled => {
    if (!disabled) return;
    Object.defineProperty(window, "Worker", { configurable: true, value: undefined });
    Object.defineProperty(window, "createImageBitmap", { configurable: true, value: undefined });
  }, disableWorker);
  const scripts = [
    "bridge.js",
    "bridge-mutations.js",
    ...readdirSync("mcp/src/bridge-ext")
      .filter(name => name.endsWith(".js"))
      .sort()
      .map(name => "bridge-ext/" + name)
  ];
  await context.addInitScript(scripts.map(name => readFileSync("mcp/src/" + name, "utf8")).join("\n"));
  await context.route("**/*", route =>
    new URL(route.request().url()).origin === origin || (fontCDN && route.request().method() === "GET" && new URL(route.request().url()).origin === "https://fonts.gstatic.com") ? route.continue() : route.abort()
  );
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.dismiss());
  const workerQuery = process.env.BENCH_RELIEF_WORKER === "1" ? "&reliefWorker=1" : "";
  const renderer = parseRendererEnv(process.env.BENCH_RENDERER);
  await page.goto(origin + "/?local&seed=7319&width=1280&height=720" + workerQuery + rendererQuery(renderer));
  await page.evaluate(async text => {
    const w = globalThis as any;
    const ready = await w.__tupaia.call("ready", { timeoutMs: 120000 });
    if (!ready.ok) throw new Error(JSON.stringify(ready));
    await w.__tupaia.fns.loadMap({ text, timeoutMs: 120000 });
    const displayed = await w.__tupaia.call("display", { on: ["heightmap", "relief"] });
    if (!displayed.ok) throw new Error(JSON.stringify(displayed));
    await w.__tupaia.settle();
    await Promise.all([w.reliefRenderReady, w.burgRenderReady]);
    w.__qualityCamera = () => ({ k: (0, eval)("scale"), x: (0, eval)("viewX"), y: (0, eval)("viewY") });
    w.__qualityMove = (camera: any) =>
      w.d3
        .select("#map")
        .call((0, eval)("zoom").transform, w.d3.zoomIdentity.translate(camera.x, camera.y).scale(camera.k));
    w.__qualitySettle = async () => {
      await new Promise(resolve => setTimeout(resolve, 350));
      if (w.waitDenseZoomReady) await w.waitDenseZoomReady(15000);
      if (w.denseZoomPending) throw new Error("Dense tiles remained pending");
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    };
    const burg = w.pack.burgs.find((burg: any) => burg?.i && !burg.removed);
    w.__qualityMove({ k: 8, x: 640 - burg.x * 8, y: 360 - burg.y * 8 });
    await w.__qualitySettle();
  }, text);
  const initialSpriteDelay = await page.evaluate(async () => {
    const w = globalThis as any;
    if (!w.waitDenseZoomReady) return { applicable: false };
    const base = document.querySelector("#terrain > image[data-relief]")!;
    const originalData = base.getAttribute("data-relief")!;
    const icons = JSON.parse(originalData);
    if (!icons.length) throw new Error("No relief sprite for initial decode test");
    const camera = w.__qualityCamera();
    const chosen = icons.find(
      (icon: any) =>
        (icon.x + icon.s / 2) * camera.k + camera.x > 0 &&
        (icon.x + icon.s / 2) * camera.k + camera.x < 1280 &&
        (icon.y + icon.s / 2) * camera.k + camera.y > 0 &&
        (icon.y + icon.s / 2) * camera.k + camera.y < 720
    );
    if (!chosen) throw new Error("No visible sprite for first decode check");
    const originalSymbol = document.querySelector(chosen.i)!;
    const alias = originalSymbol.cloneNode(true) as Element;
    alias.id = "relief-bench-first-decode";
    originalSymbol.parentElement!.append(alias);
    const create = URL.createObjectURL;
    const svgURLs = new Set<string>();
    URL.createObjectURL = function (blob) {
      const url = create.call(URL, blob);
      if (blob instanceof Blob && blob.type === "image/svg+xml") svgURLs.add(url);
      return url;
    };
    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
    const held: (() => void)[] = [];
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      ...descriptor,
      set(value: string) {
        if (svgURLs.has(value)) held.push(() => descriptor.set!.call(this, value));
        else descriptor.set!.call(this, value);
      }
    });
    try {
      // A fresh alias forces the first decode in this viewport renderer while preserving the overview PNG.
      base.setAttribute(
        "data-relief",
        JSON.stringify(icons.map((icon: any) => (icon.i === chosen.i ? { ...icon, i: "#" + alias.id } : icon)))
      );
      w.__qualityMove(w.__qualityCamera());
      const deadline = performance.now() + 15000;
      while (!held.length && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      if (!held.length) throw new Error("Initial SVG sprite decode was not intercepted");
      await new Promise(resolve => setTimeout(resolve, 120));
      if (!w.denseZoomPending) throw new Error("Delayed first sprite was not tracked as pending");
      if (base.hasAttribute("data-zoom-hidden")) throw new Error("Overview hidden during first sprite decode");
      Object.defineProperty(HTMLImageElement.prototype, "src", descriptor);
      URL.createObjectURL = create;
      held.forEach(release => release());
      await w.waitDenseZoomReady(15000);
      if (!document.querySelector("#terrain image[data-relief-viewport]"))
        throw new Error("Tile not published after initial sprite decode");
      if (!base.hasAttribute("data-zoom-hidden")) throw new Error("Ready tile did not hand off overview visibility");
      return {
        applicable: true,
        uncachedSpriteAlias: true,
        delayedJobs: held.length,
        overviewVisibleWhilePending: true,
        readyTilePublished: true
      };
    } finally {
      Object.defineProperty(HTMLImageElement.prototype, "src", descriptor);
      URL.createObjectURL = create;
      base.setAttribute("data-relief", originalData);
      alias.remove();
      w.__qualityMove(w.__qualityCamera());
      await w.__qualitySettle();
    }
  });
  const output = process.env.BENCH_OUTPUT || "/tmp/tupaia-navigation-quality.json";
  const imagePath = output.replace(/\.json$/, "") + ".png";
  await page.screenshot({ path: imagePath });
  const result = await page.evaluate(async () => {
    const w = globalThis as any;
    const save = await w.lazy.save();
    const camera = w.__qualityCamera();
    const before = save.prepareMapData();
    const zones = JSON.stringify(w.pack.zones);
    const tileCount = document.querySelectorAll("image[data-relief-viewport]").length;
    const hit = () =>
      [...document.querySelectorAll("#labels text")].flatMap(node => {
        const rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height || rect.x < 0 || rect.y < 0 || rect.right > 1280 || rect.bottom > 720)
          return [];
        const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return target && node.contains(target) ? [[node.id, node.textContent]] : [];
      });
    if (w.waitDenseZoomReady && !tileCount) throw new Error("No relief viewport tile published at shared k8");
    const hitsBefore = JSON.stringify(hit());
    if (!JSON.parse(hitsBefore).length) throw new Error("No visible label hit target sampled");
    w.__qualityMove({ ...camera, x: camera.x + 480, y: camera.y - 240 });
    await w.__qualitySettle();
    w.__qualityMove(camera);
    await w.__qualitySettle();
    const after = save.prepareMapData();
    if (before !== after) throw new Error("Pan roundtrip changed canonical map serialization");
    if (zones !== JSON.stringify(w.pack.zones)) throw new Error("Pan changed zones");
    if (hitsBefore !== JSON.stringify(hit())) throw new Error("Pan roundtrip changed label hit targets");
    const svg = after.match(/<svg[\s\S]*<\/svg>/)?.[0];
    if (!svg) throw new Error("Saved map has no SVG");
    const saved = new DOMParser().parseFromString(svg, "image/svg+xml");
    if (saved.querySelector("[data-dense-zoom],[data-relief-viewport],[data-zoom-hidden],.viewport-culled"))
      throw new Error("Transient rendering state leaked into canonical save");
    if (
      [...saved.querySelectorAll("*")].some(node => [...node.attributes].some(attr => attr.value.startsWith("blob:")))
    )
      throw new Error("Blob URL leaked into canonical save");
    const icons = w.getReliefIcons?.() || [];
    const icon = icons.find((icon: any) => {
      const x = (icon.x + icon.s / 2) * camera.k + camera.x;
      const y = (icon.y + icon.s / 2) * camera.k + camera.y;
      return x > 0 && x < 1280 && y > 0 && y < 720;
    });
    let reliefPick = null;
    if (icon) {
      const x = icon.x + icon.s / 2,
        y = icon.y + icon.s / 2;
      const expected = icons
        .filter((item: any) => x >= item.x && x <= item.x + item.s && y >= item.y && y <= item.y + item.s)
        .sort((a: any, b: any) => b.y + b.s - (a.y + a.s))[0];
      const selected = w.pickRelief(x, y);
      if (!selected) throw new Error("Visible relief glyph could not be picked");
      reliefPick = {
        href: selected.getAttribute("href"),
        x: Number(selected.getAttribute("x")),
        y: Number(selected.getAttribute("y")),
        size: Number(selected.getAttribute("width"))
      };
      if (
        reliefPick.href !== expected.i ||
        reliefPick.x !== expected.x ||
        reliefPick.y !== expected.y ||
        reliefPick.size !== expected.s
      )
        throw new Error("Relief picker geometry changed");
      w.compactRelief();
      await w.reliefRenderReady;
      await w.__qualitySettle();
    }
    return {
      cells: w.pack.cells.i.length,
      camera,
      tileCount,
      denseReadyAPI: Boolean(w.waitDenseZoomReady),
      backend: w.reliefWorkerStatus ? w.reliefWorkerStatus() : null,
      saveExact: true,
      zonesUnchanged: true,
      labelHitsExact: true,
      visibleLabelHits: JSON.parse(hitsBefore).length,
      transientSaveClean: true,
      reliefPick,
      serializedBytes: after.length
    };
  });
  await page.evaluate(async () => {
    const w = globalThis as any;
    const camera = w.__qualityCamera();
    const worldX = (640 - camera.x) / camera.k,
      worldY = (360 - camera.y) / camera.k;
    w.__qualityMove({ k: 3.9, x: 640 - worldX * 3.9, y: 360 - worldY * 3.9 });
    await w.__qualitySettle();
    w.__qualityColdStart = performance.now();
    w.__qualityCold = new Promise(resolve => {
      const intervals: number[] = [];
      let last = performance.now(),
        frame = 0,
        gap = false,
        crispAt = 0;
      const tick = (now: number) => {
        intervals.push(now - last);
        last = now;
        frame++;
        const base = document.querySelector("#terrain image[data-relief]");
        const tile = document.querySelector("#terrain image[data-relief-viewport]");
        if (w.waitDenseZoomReady && base?.hasAttribute("data-zoom-hidden") && !tile) gap = true;
        if (tile && !w.denseZoomPending && !crispAt) crispAt = now;
        if (frame < 30) requestAnimationFrame(tick);
        else resolve({ intervals, gap, crispAt });
      };
      requestAnimationFrame(tick);
    });
  });
  await page.mouse.move(640, 360);
  await page.mouse.wheel(0, -80);
  const coldCrossing = await page.evaluate(async () => {
    const w = globalThis as any;
    const timing = await w.__qualityCold;
    if (w.waitDenseZoomReady) await w.waitDenseZoomReady(15000);
    const timeToCrispMs = (timing.crispAt || performance.now()) - w.__qualityColdStart;
    if (timing.gap) throw new Error("Threshold crossing hid base before tile publication");
    return {
      nativeWheel: true,
      startScale: 3.9,
      endScale: (0, eval)("scale"),
      timeToCrispMs: w.waitDenseZoomReady ? timeToCrispMs : null,
      first10IntervalsMs: timing.intervals.slice(0, 10),
      maxIntervalMs: Math.max(...timing.intervals),
      baseFallbackSafe: !timing.gap,
      tileCount: document.querySelectorAll("image[data-relief-viewport]").length
    };
  });
  const hatching = await page.evaluate(async () => {
    const w = globalThis as any;
    const camera = w.__qualityCamera();
    const snapshot = () =>
      [...document.querySelectorAll("pattern[data-zone-hatch-clone]")].map(node => {
        const pattern = node as SVGPatternElement;
        const matrix = pattern.patternTransform.baseVal.consolidate()?.matrix;
        return {
          id: node.id,
          pitch: Number(node.getAttribute("width")) * (0, eval)("scale") * (matrix ? Math.hypot(matrix.a, matrix.b) : 1)
        };
      });
    w.updateZoneHatching?.((0, eval)("scale"));
    const before = snapshot();
    w.__qualityMove({ ...camera, k: camera.k * 1.25 });
    await w.__qualitySettle();
    const after = snapshot();
    w.__qualityMove(camera);
    await w.__qualitySettle();
    if (
      before.length &&
      (before.length !== after.length ||
        before.some((item, index) => Math.abs(item.pitch - after[index].pitch) > 0.00001))
    )
      throw new Error("Zone hatch screen pitch changed");
    return { testedPatterns: before.length, screenPitchStable: before.length ? true : null };
  });
  const asynchronous = await page.evaluate(async text => {
    const w = globalThis as any;
    if (!w.waitDenseZoomReady) return { applicable: false };
    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
    const create = URL.createObjectURL;
    const pngURLs = new Set<string>();
    URL.createObjectURL = function (blob) {
      const url = create.call(URL, blob);
      if (blob instanceof Blob && blob.type === "image/png") pngURLs.add(url);
      return url;
    };
    const held: (() => void)[] = [];
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      ...descriptor,
      set(value: string) {
        if (pngURLs.has(value)) held.push(() => descriptor.set!.call(this, value));
        else descriptor.set!.call(this, value);
      }
    });
    const camera = w.__qualityCamera();
    w.__qualityMove({ ...camera, x: camera.x + 1600 });
    const deadline = performance.now() + 15000;
    while (!held.length && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    Object.defineProperty(HTMLImageElement.prototype, "src", descriptor);
    URL.createObjectURL = create;
    if (!held.length) throw new Error("Viewport PNG decode delay did not intercept a render job");
    const base = document.querySelector("#terrain image[data-relief]");
    const initialTile = document.querySelector("#terrain image[data-relief-viewport]");
    if (!initialTile && base?.hasAttribute("data-zoom-hidden"))
      throw new Error("Base relief hidden before initial tile publication");
    const oldOverlay = document.querySelector("#terrain [data-dense-zoom]");
    await w.__tupaia.fns.loadMap({ text, timeoutMs: 120000 });
    const displayed = await w.__tupaia.call("display", { on: ["heightmap", "relief"] });
    if (!displayed.ok) throw new Error(JSON.stringify(displayed));
    await w.__tupaia.settle();
    await Promise.all([w.reliefRenderReady, w.burgRenderReady]);
    w.__qualityMove(camera);
    await w.__qualitySettle();
    const terrain = document.getElementById("terrain")!;
    const before = terrain.innerHTML;
    held.forEach(release => release());
    await new Promise(resolve => setTimeout(resolve, 250));
    await w.waitDenseZoomReady(15000);
    if (oldOverlay?.isConnected) throw new Error("Old world overlay remained connected");
    if (before !== terrain.innerHTML) throw new Error("Stale encoded tile changed replacement world");
    return {
      applicable: true,
      delayedDecodeJobs: held.length,
      staleWorldDecodeRejected: true,
      pendingBaseHandoffSafe: true
    };
  }, text);
  const workerCheck = await page.evaluate(disabled => {
    const w = globalThis as any;
    const status = w.reliefWorkerStatus?.();
    if (!status) return { applicable: false };
    if (status.pending) throw new Error("Worker still pending after settled quality checks");
    const expected = disabled || new URLSearchParams(location.search).get("reliefWorker") !== "1" ? "main" : "worker";
    if (status.backend !== expected) throw new Error("Unexpected relief backend: " + JSON.stringify(status));
    if (expected === "worker" && !status.completed) throw new Error("No relief worker jobs completed");
    return { applicable: true, expected, ...status };
  }, disableWorker);
  // Renderer parity (BENCH_RENDERER=svg|gpu): final camera, hit testing and a provenance-checked capture. Run once per
  // arm and compare the two captures with compareRgba; a gpu arm that is not presenting is reported, not relabeled.
  const rendererCheck = renderer
    ? await (async () => {
        await page.waitForFunction(() => {
          const status = (globalThis as any).rendererStatus?.();
          return status?.active !== "gpu" || ["active", "suspended"].includes(status.gpu?.state);
        });
        const state = await page.evaluate(() => {
          const w = globalThis as any;
          const camera = w.__qualityCamera();
          const svg = document.getElementById("map")!;
          const rect = svg.getBoundingClientRect();
          const hits = { samples: 0, compared: 0, agree: 0, mismatches: [] as unknown[] };
          for (let y = 40; y < rect.height; y += 80)
            for (let x = 40; x < rect.width; x += 80) {
              hits.samples++;
              const gpu = w.gpuPick?.(x, y, 0);
              if (!gpu) continue;
              const target = document.elementFromPoint(rect.left + x, rect.top + y)?.closest("[id]")?.id ?? null;
              hits.compared++;
              if (target === gpu.id) hits.agree++;
              else if (hits.mismatches.length < 20) hits.mismatches.push({ x, y, gpu: gpu.id, svg: target });
            }
          return {
            status: w.rendererStatus?.(),
            camera,
            viewboxTransform: document.getElementById("viewbox")?.getAttribute("transform") ?? null,
            expectedTransform: `translate(${camera.x} ${camera.y}) scale(${camera.k})`,
            hits
          };
        });
        const request = { renderer, world: "seed-7319", viewport: [1280, 720] as [number, number], deviceScaleFactor };
        const capture = await playwrightGpuCapture(page).capture(request);
        let capturePath = null;
        if (capture.supported) {
          capturePath = output.replace(/\.json$/, "") + `-${renderer}.rgba`;
          writeFileSync(capturePath, capture.image.data);
        }
        return {
          ...state,
          finalCameraExact: state.viewboxTransform === state.expectedTransform,
          capture: capture.supported
            ? { adapter: capture.adapter, gpu: capture.gpu, activeRenderer: capture.activeRenderer, path: capturePath }
            : capture,
          captureProblems: captureProblems(request, capture)
        };
      })()
    : null;
  let pixelDiff = null;
  if (process.env.BENCH_BASE_IMAGE) {
    const baseline = readFileSync(process.env.BENCH_BASE_IMAGE).toString("base64");
    const current = readFileSync(imagePath).toString("base64");
    const diff = await page.evaluate(
      async ({ baseline, current }) => {
        const decode = (data: string) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = reject;
            image.src = "data:image/png;base64," + data;
          });
        const images = await Promise.all([decode(baseline), decode(current)]);
        if (images[0].width !== images[1].width || images[0].height !== images[1].height)
          throw new Error("Screenshot dimensions differ");
        const canvases = images.map(image => {
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          canvas.getContext("2d")!.drawImage(image, 0, 0);
          return canvas;
        });
        const arrays = canvases.map(canvas => canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height));
        let changed = 0,
          total = 0,
          maximum = 0;
        for (let i = 0; i < arrays[0].data.length; i += 4) {
          let delta = 0;
          for (let channel = 0; channel < 3; channel++) {
            const value = Math.abs(arrays[0].data[i + channel] - arrays[1].data[i + channel]);
            delta = Math.max(delta, value);
            total += value;
            maximum = Math.max(maximum, value);
          }
          if (delta > 16) changed++;
          arrays[1].data[i] = delta;
          arrays[1].data[i + 1] = 0;
          arrays[1].data[i + 2] = 0;
        }
        canvases[1].getContext("2d")!.putImageData(arrays[1], 0, 0);
        return {
          changedPixelsOver16: changed,
          fraction: changed / (images[0].width * images[0].height),
          meanAbsoluteChannelDelta: total / (images[0].width * images[0].height * 3),
          maximum,
          heatmap: canvases[1].toDataURL("image/png")
        };
      },
      { baseline, current }
    );
    writeFileSync(output.replace(/\.json$/, "") + "-diff.png", Buffer.from(diff.heatmap.split(",")[1], "base64"));
    const { heatmap, ...stats } = diff;
    pixelDiff = stats;
  }
  if (errors.length) throw new Error(errors.join("\n"));
  const report = {
    ...result,
    assetPolicy,
    deviceScaleFactor,
    workerDisabled: disableWorker,
    workerOptIn: process.env.BENCH_RELIEF_WORKER === "1",
    workerCheck,
    renderer: renderer ?? null,
    rendererCheck,
    initialSpriteDelay,
    imagePath,
    pixelDiff,
    coldCrossing,
    hatching,
    asynchronous,
    errors,
    pendingChecks: []
  };
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
