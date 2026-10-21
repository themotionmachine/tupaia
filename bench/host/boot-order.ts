// The `boot-order` gate check (W4c BOOT): ?renderer=gpu boots on a slow network, where the GPU module chunk resolves
// before the deferred classic public/main.js has executed. The renderer must wait for the app's first world
// (map:generated / map:loaded) instead of preparing early: a prepare that clones the map before main.js ran threw
// "customization is not defined" (src/io/export.ts) and fell back to SVG for the whole session (production, ~1 in 3
// loads). Serves the built dist, delays main.js by BOOT_DELAY_MS, and requires every load to reach an active,
// visible GPU frame with no fallback, no "Renderer fallback" warning and no page error.
//
//   BOOT_OUTPUT=<new json path> [BOOT_REPS=3] [BOOT_DELAY_MS=1500] node bench/host/boot-order.ts
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../..");
const require = createRequire(repo + "/package.json");
const { chromium } = require("playwright");
const dist = resolve(process.env.BOOT_DIST || resolve(repo, "dist"));
const output = process.env.BOOT_OUTPUT!;
if (!output || existsSync(output)) throw new Error("Unique BOOT_OUTPUT required");
const reps = Number(process.env.BOOT_REPS || 3);
const delay = Number(process.env.BOOT_DELAY_MS || 1500);
const mime: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff"
};
const server = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url!, "http://localhost").pathname);
  if (req.method !== "GET" || pathname.startsWith("/api/")) return void res.writeHead(404).end();
  const file = resolve(dist, pathname === "/" ? "index.html" : "." + pathname);
  if (!file.startsWith(dist + "/") || !existsSync(file)) return void res.writeHead(404).end();
  const send = () => {
    res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  };
  // the production race: the classic deferred main.js arrives after the module graph and the lazy GPU chunk
  if (pathname === "/main.js") setTimeout(send, delay);
  else send();
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const origin = "http://127.0.0.1:" + (server.address() as { port: number }).port;
const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--use-angle=metal", "--enable-gpu"] });
const runs: unknown[] = [];
const failed = (row: any) =>
  row.timedOut || row.errors.length || row.warnings.length || row.state.active !== "gpu" || row.state.fallbackReason || row.state.gpu !== "active";
let failure: string | null = null;
try {
  for (let rep = 0; rep < reps; rep++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, serviceWorkers: "block" });
    await context.addInitScript((localOrigin: string) => {
      if (location.origin !== localOrigin) return;
      localStorage.setItem("autosaveInterval", "0");
      localStorage.setItem("azgaarAssistant", "hide");
      // when did main.js run relative to the GPU renderer's construction (page.gpuRenderer is set by createGpuRenderer)
      const w = globalThis as any;
      w.__bootOrder = [];
      let renderer: unknown;
      Object.defineProperty(w, "gpuRenderer", {
        configurable: true,
        get: () => renderer,
        set: value => {
          renderer = value;
          if (value) w.__bootOrder.push(`renderer (main.js ${(0, eval)("typeof customization") === "undefined" ? "pending" : "ran"})`);
        }
      });
    }, origin);
    await context.route("**/*", (route: any) => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() === "GET" && (url.origin === origin || url.origin === "https://fonts.gstatic.com")) return route.continue();
      return route.abort();
    });
    const page = await context.newPage(), errors: string[] = [], warnings: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("console", (message: any) => {
      if (/Renderer fallback|GPU prepare failed/.test(message.text())) warnings.push(message.text());
    });
    const url = `/?local&seed=${7319 + rep}&width=1280&height=720&renderer=gpu`;
    await page.goto(origin + url);
    let timedOut = false;
    await page
      .waitForFunction(() => {
        const w = globalThis as any, status = w.rendererStatus?.();
        if (status?.active === "svg" && status.fallbackReason) return true;
        return w.pack?.cells?.i?.length > 0 && status?.gpu?.state === "active" && status.gpu.canvasVisible;
      }, undefined, { timeout: 60000 })
      .catch(() => (timedOut = true));
    const state = await page.evaluate(() => {
      const w = globalThis as any, status = w.rendererStatus();
      return { active: status.active, fallbackReason: status.fallbackReason, gpu: status.gpu?.state ?? null,
        canvasVisible: !!status.gpu?.canvasVisible, prepares: status.gpu?.prepares ?? null, order: w.__bootOrder };
    });
    const row = { rep, url, state, errors, warnings, timedOut };
    runs.push(row);
    console.error(JSON.stringify(row));
    await context.close();
  }
  const bad = runs.filter(failed);
  if (bad.length) failure = `${bad.length}/${reps} slow-main.js boots did not reach an active GPU frame: ` + JSON.stringify(bad[0]);
} catch (error) {
  failure = String((error as Error).stack || error);
} finally {
  await browser.close();
  await new Promise<void>(done => server.close(() => done()));
}
const passed = runs.filter(row => !failed(row)).length;
writeFileSync(output, JSON.stringify({ scope: "GPU boot with main.js delayed", delay, reps, passed, runs, failure, pass: !failure }, null, 2), { flag: "wx" });
console.log(JSON.stringify({ output, pass: !failure, passed, reps, failure }));
if (failure) process.exitCode = 1;
