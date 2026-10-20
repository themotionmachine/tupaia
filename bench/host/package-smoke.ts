// Ported from the Codex host harness (control/opt-in-package-smoke.ts). Run it through bench/gate/gate.ts, which holds the
// host lock and sets GATE_OUT_DIR (evidence directory) and GATE_MAP (shared-v8 fixture). See docs/performance/webgl-rewrite/GATE.md.
// Verify the packaged current build, not the working dist directory containing historical chunks.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../.."); // repo root: bench/host -> ../..
const require = createRequire(repo + "/package.json");
const { chromium } = require("playwright");
const dist = resolve(process.env.PACKAGE_DIST || resolve(repo, "dist"));
const output = process.env.PACKAGE_OUTPUT!;
if (!output || existsSync(output)) throw new Error("Unique PACKAGE_OUTPUT required");
const missing: string[] = [];
const mime: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff"
};
const server = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url!, "http://localhost").pathname);
  if (req.method !== "GET" || pathname.startsWith("/api/")) { res.writeHead(404).end(); return; }
  const file = resolve(dist, pathname === "/" ? "index.html" : "." + pathname);
  if (!file.startsWith(dist + "/") || !existsSync(file)) {
    missing.push(pathname); res.writeHead(404).end(); return;
  }
  res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const origin = "http://127.0.0.1:" + (server.address() as { port: number }).port;
const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--use-angle=metal", "--enable-gpu"] });
const results: unknown[] = [];
let failure: string | null = null;
try {
  for (const mode of ["svg", "gpu"]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2,
      serviceWorkers: "block", acceptDownloads: false });
    await context.addInitScript((localOrigin: string) => {
      if (location.origin !== localOrigin) return;
      localStorage.setItem("autosaveInterval", "0");
      localStorage.setItem("azgaarAssistant", "hide");
      const w = globalThis as any;
      w.__webglRequests = 0;
      for (const prototype of [HTMLCanvasElement.prototype, globalThis.OffscreenCanvas?.prototype].filter(Boolean) as any[]) {
        const get = prototype.getContext;
        prototype.getContext = function (id: string, ...args: unknown[]) {
          if (/webgl/.test(id)) w.__webglRequests++;
          return get.call(this, id, ...args);
        };
      }
    }, origin);
    await context.route("**/*", (route: any) => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() === "GET" && (url.origin === origin || url.origin === "https://fonts.gstatic.com"))
        return route.continue();
      return route.abort();
    });
    const page = await context.newPage(), errors: string[] = [], modules: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("response", (response: any) => {
      const url = new URL(response.url());
      if (url.origin === origin && url.pathname.endsWith(".js")) modules.push(url.pathname);
    });
    const url = "/?local&seed=7319&width=1280&height=720" + (mode === "gpu" ? "&renderer=gpu" : "");
    await page.goto(origin + url);
    await page.waitForFunction((mode: string) => {
      const w = globalThis as any, status = w.rendererStatus?.();
      return w.pack?.cells?.i?.length > 0 && status?.active === mode &&
        (mode === "svg" || status.gpu?.state === "active" && status.gpu?.canvasVisible);
    }, mode, { timeout: 45000 });
    if (mode === "svg") await page.evaluate(async () => {
      const w = globalThis as any;
      await w.lazy.save();
      await w.lazy.exportMap();
    });
    const state = await page.evaluate(() => {
      const w = globalThis as any, status = w.rendererStatus();
      return { requested: status.requested, active: status.active, webglRequests: w.__webglRequests,
        canvas: document.querySelectorAll("canvas[data-gpu-renderer]").length,
        canonicalClickHook: typeof w.gpuClickRoute === "function", fallbackReason: status.fallbackReason };
    });
    const row = { mode, url, state, errors, modules };
    results.push(row);
    if (errors.length || state.fallbackReason || (mode === "svg" &&
      (state.webglRequests !== 0 || state.canvas !== 0 || state.canonicalClickHook ||
        modules.some(name => /^\/renderer-[^/]+\.js$/.test(name)))) ||
      (mode === "gpu" && (state.webglRequests < 1 || state.canvas !== 1 || !state.canonicalClickHook)))
      throw new Error("Packaged mode invariant failed: " + JSON.stringify(row));
    await context.close();
  }
  if (missing.length) throw new Error("Packaged files missing: " + missing.join(", "));
} catch (error) {
  failure = String((error as Error).stack || error);
} finally {
  await browser.close();
  await new Promise<void>(done => server.close(() => done()));
}
writeFileSync(output, JSON.stringify({ scope: "Packaged clean build boot and default SVG lazy save/export imports only",
  results, missing, failure, pass: !failure }, null, 2), { flag: "wx" });
console.log(JSON.stringify({ output, pass: !failure, failure, results }));
if (failure) process.exitCode = 1;
