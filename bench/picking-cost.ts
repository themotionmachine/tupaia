// Pick-index cost on a dense world (PICK2): what the CPU hit geometry costs the prepare, per zoom.
// - End to end, per zoom k: the committed frame's PickIndex bytes and item count, its cpuBytes, and the prepare's
//   scene-phase time (the draw conversion, which builds the pick index inline), median of PICK_COST_REPS prepares, each
//   forced by a bucket change (zoom out and back). Run it once per dist (PICK_COST_DIST) for before/after.
// - In isolation (PICK_COST_MICRO=1, needs a tree whose compat-pick takes a tolerance): flattenPath over every
//   #viewbox path at the old fixed 0.01-unit tolerance and at pickTolerance(bucket, dpr, k), and compatShapes over
//   #emblems (custom/COA <use> hit shapes) at both, with time (min of 3) and coordinate counts.
// The world is the picking gate's generated 100k (seed 7319, continents, 1280x720); PICK_COST_EMBLEMS=1 also shows the
// emblems layer (an emblem-dense world). Local browser only (metal launcher by default), nothing is saved.
import { chromium } from "playwright";
import { build } from "vite";
import { createServer } from "node:http";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { adapterMatches, launcherFrom, launchOptions, probeAdapter } from "./host/launcher.ts";

const dist = resolve(process.env.PICK_COST_DIST || "dist");
const output = process.env.PICK_COST_OUTPUT || "/tmp/tupaia-picking-cost.json";
const zooms = (process.env.PICK_COST_ZOOMS || "1,2,4").split(",").map(Number);
const reps = Number(process.env.PICK_COST_REPS || 3);
const micro = process.env.PICK_COST_MICRO === "1";
const emblems = process.env.PICK_COST_EMBLEMS === "1";
const launcher = launcherFrom(process.env.PICK_COST_LAUNCHER);
const dpr = 2;
const VIEW = { width: 1280, height: 720 };

const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json"
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
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing local server");
const origin = "http://127.0.0.1:" + address.port;

let microCode = "";
if (micro) {
  const bundled = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      lib: { entry: resolve("bench/picking-cost-entry.ts"), formats: ["iife"], name: "__pickCostModule" }
    }
  });
  const bundle = Array.isArray(bundled) ? bundled[0] : bundled;
  microCode = (bundle as any).output.find((entry: any) => entry.type === "chunk").code;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

const report: any = { dist, launcher, dpr, zooms, reps, emblems, adapter: null, rows: [], micro: [], errors: [] };
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
    const url = new URL(route.request().url());
    if (url.origin === origin || url.origin === "https://fonts.gstatic.com") return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(600000);
  page.on("pageerror", error => report.errors.push(error.message));
  page.on("dialog", dialog => dialog.dismiss());
  await page.goto(origin + "/?local&seed=7319&width=1280&height=720&renderer=gpu&gpu-select");
  await page.evaluate(async () => {
    const result = await (globalThis as any).__tupaia.call("ready", { timeoutMs: 120000 });
    if (!result.ok) throw new Error(JSON.stringify(result));
  });
  report.adapter = await page.evaluate(probeAdapter);
  if (!adapterMatches(launcher, report.adapter.renderer)) throw new Error("adapter: " + JSON.stringify(report.adapter));
  await page.evaluate(
    async ({ emblems }) => {
      const runtime = (globalThis as any).__tupaia;
      const w = globalThis as any;
      const result = await runtime.fns.generateMap({
        cells: 100000,
        seed: "7319",
        template: "continents",
        width: 1280,
        height: 720,
        timeoutMs: 300000
      });
      if (result?.ok === false) throw new Error(JSON.stringify(result));
      const on = ["heightmap", "relief", ...(emblems ? ["emblems"] : [])];
      const displayed = await runtime.call("display", { on });
      if (!displayed.ok) throw new Error(JSON.stringify(displayed));
      await Promise.all([w.reliefRenderReady, w.burgRenderReady]);
      w.TradeAnimation?.stop?.();
    },
    { emblems }
  );
  if (microCode) await page.addScriptTag({ content: microCode });

  // zoom to k on the map centre and wait for a current, settled GPU frame
  const zoomTo = (k: number) =>
    page.evaluate(async k => {
      const w = globalThis as any;
      const x = 1280 / 2;
      const y = 720 / 2;
      const transform = w.d3.zoomIdentity.translate(640 - k * x, 360 - k * y).scale(k);
      w.d3.select("#map").call((0, eval)("zoom").transform, transform);
      const start = performance.now();
      await new Promise(done => setTimeout(done, 400));
      while (true) {
        const status = w.rendererStatus?.();
        const gpu = status?.gpu;
        if (status?.active !== "gpu") throw new Error("GPU fell back: " + status?.fallbackReason);
        if (gpu?.canvasVisible && gpu.sourceCurrent && !gpu.pending && !gpu.refinementPending && !gpu.moving) break;
        if (performance.now() - start > 120000) throw new Error("GPU did not settle at k " + k);
        await new Promise(done => setTimeout(done, 25));
      }
      const renderer = w.gpuRenderer;
      const prepared = renderer.prepared;
      const last = w.rendererStatus().gpu.lastPrepare;
      return {
        k,
        bucket: prepared.bucket,
        pickBytes: prepared.pick.bytes(),
        pickItems: prepared.pick.size,
        cpuBytes: prepared.cpuBytes,
        prepare: last && { reason: last.reason, outcome: last.outcome, phases: last.phases }
      };
    }, k);

  for (const k of zooms) {
    const samples = [];
    for (let rep = 0; rep < reps; rep++) {
      await zoomTo(k === 1 ? 2 : 1); // a different bucket, so the return to k is a full prepare
      samples.push(await zoomTo(k));
    }
    const fresh = samples.filter(s => s.prepare?.reason === "settle-bucket" || s.prepare?.reason);
    report.rows.push({
      k,
      bucket: samples[0].bucket,
      pickBytes: samples.map(s => s.pickBytes),
      pickItems: samples.map(s => s.pickItems),
      cpuBytes: samples.map(s => s.cpuBytes),
      sceneMs: samples.map(s => s.prepare?.phases?.scene ?? null),
      sceneMsMedian: median(fresh.map(s => s.prepare?.phases?.scene).filter(v => typeof v === "number")),
      reasons: samples.map(s => s.prepare?.reason)
    });
    console.log(JSON.stringify(report.rows.at(-1)));
    if (micro)
      report.micro.push(
        await page.evaluate(
          ({ k, bucket, dpr }) => {
            const api = (globalThis as any).__pickCost;
            const viewbox = document.getElementById("viewbox")!;
            const paths = [...viewbox.querySelectorAll("path[d]")].filter(p => !p.closest("defs,clipPath,mask,pattern"));
            const ds = paths.map(p => p.getAttribute("d")!);
            const fresh = api.pickTolerance(bucket, dpr, k);
            const flatten = (tol: number) => {
              let best = Number.POSITIVE_INFINITY;
              let coords = 0;
              for (let rep = 0; rep < 3; rep++) {
                const start = performance.now();
                coords = 0;
                for (const d of ds) for (const s of api.flattenPath(d, tol)) coords += s.points.length;
                best = Math.min(best, performance.now() - start);
              }
              return { ms: Math.round(best * 10) / 10, coords };
            };
            const emblemRoot = document.getElementById("emblems");
            const shapes = (tol: number) => {
              if (!emblemRoot) return null;
              let best = Number.POSITIVE_INFINITY;
              let out: any[] = [];
              for (let rep = 0; rep < 3; rep++) {
                const start = performance.now();
                out = api.compatShapes(emblemRoot, viewbox, tol);
                best = Math.min(best, performance.now() - start);
              }
              let coords = 0;
              for (const shape of out)
                for (const ring of [...(shape.fill?.rings ?? []), ...(shape.stroke?.rings ?? [])]) coords += ring.length;
              return {
                ms: Math.round(best * 10) / 10,
                shapes: out.length,
                coords,
                uses: emblemRoot.querySelectorAll("use").length,
                visibleUses: [...emblemRoot.querySelectorAll("use")].filter(u => (u as SVGGraphicsElement).getBBox().width > 0)
                  .length
              };
            };
            return {
              k,
              bucket,
              paths: ds.length,
              tolerance: { old: api.PICK_TOLERANCE, fresh },
              flatten: { old: flatten(api.PICK_TOLERANCE), fresh: flatten(fresh) },
              emblems: { old: shapes(api.PICK_TOLERANCE), fresh: shapes(fresh) }
            };
          },
          { k, bucket: samples[0].bucket, dpr }
        )
      );
    if (micro) console.log(JSON.stringify(report.micro.at(-1)));
  }
} catch (error) {
  report.failure = String((error as Error)?.stack || error);
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  writeFileSync(output, JSON.stringify(report, null, 2));
  await browser.close();
  server.close();
}
