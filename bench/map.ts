import { chromium } from "playwright";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { platform, arch, cpus } from "node:os";

const samples = Number(process.env.BENCH_SAMPLES || 3);
if (!Number.isInteger(samples) || samples < 1) throw new Error("BENCH_SAMPLES must be positive");
const port = process.env.BENCH_PORT || "4187";
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ headless: true });
const server = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", port, "--strictPort"],
  { stdio: "inherit" }
);
const measurements: { cells: number; operation: string; samplesMs: number[]; medianMs: number }[] = [];
try {
  for (let attempt = 0; ; attempt++) {
    if (server.exitCode !== null) throw new Error("Preview server exited");
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    if (attempt > 120) throw new Error("Preview server did not start");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    serviceWorkers: "block"
  });
  const scripts = [
    "bridge.js",
    "bridge-mutations.js",
    ...readdirSync("mcp/src/bridge-ext")
      .filter(name => name.endsWith(".js"))
      .sort()
      .map(name => `bridge-ext/${name}`)
  ];
  await context.addInitScript(() => {
    localStorage.setItem("autosaveInterval", "0");
    localStorage.setItem("azgaarAssistant", "hide");
    (globalThis as unknown as { __mcpBoot: Promise<unknown> }).__mcpBoot = new Promise(resolve =>
      addEventListener("map:generated", resolve, { once: true })
    );
  });
  await context.addInitScript(scripts.map(name => readFileSync(`mcp/src/${name}`, "utf8")).join("\n"));
  await context.route("**/*", route =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
  );
  const page = await context.newPage();
  page.setDefaultTimeout(300000);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("dialog", dialog => dialog.dismiss());
  await page.goto(`${origin}/?local&seed=7319&width=1280&height=720&renderer=svg`); // the SVG model, as before W5
  await page.evaluate(async () => {
    const runtime = (
      globalThis as unknown as { __tupaia: { call: (name: string, args: object) => Promise<{ ok: boolean }> } }
    ).__tupaia;
    const result = await runtime.call("ready", { timeoutMs: 120000 });
    if (!result.ok) throw new Error(JSON.stringify(result));
    const displayed = await runtime.call("display", { on: ["heightmap", "relief"] });
    if (!displayed.ok) throw new Error(JSON.stringify(displayed));
    await Promise.all([(globalThis as any).reliefRenderReady, (globalThis as any).burgRenderReady]);
  });
  for (const cells of [10000, 50000, 100000]) {
    const collected = new Map<string, number[]>();
    for (let iteration = 0; iteration <= samples; iteration++) {
      const timings = await page.evaluate(
        async ({ cells }) => {
          const runtime = (
            globalThis as unknown as {
              __tupaia: {
                fns: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
                settle: () => Promise<void>;
              };
            }
          ).__tupaia;
          const timings: Record<string, number> = {};
          async function measure(name: string, operation: () => Promise<unknown>) {
            const start = performance.now();
            await operation();
            await Promise.all([(globalThis as any).reliefRenderReady, (globalThis as any).burgRenderReady]);
            timings[name] = performance.now() - start;
          }
          await measure("generate", () =>
            runtime.fns.generateMap({
              cells,
              seed: "7319",
              template: "continents",
              width: 1280,
              height: 720,
              timeoutMs: 300000
            })
          );
          let saved: string | Uint8Array<ArrayBuffer> = "";
          await measure("save", async () => {
            const save = await (globalThis as any).lazy.save();
            saved = typeof save.prepareMapFile === "function" ? await save.prepareMapFile() : save.prepareMapData();
            if (!saved.length) throw new Error("Empty map");
          });
          await measure("load", async () => {
            if (typeof saved === "string") return runtime.fns.loadMap({ text: saved, timeoutMs: 300000 });
            const loader = await (globalThis as any).lazy.load();
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => { removeEventListener("map:loaded", loaded); reject(new Error("Binary load timeout")); }, 300000);
              function loaded() { clearTimeout(timer); resolve(); }
              addEventListener("map:loaded", loaded, {once: true});
              try { loader.uploadMap(new Blob([saved])); }
              catch (error) { clearTimeout(timer); removeEventListener("map:loaded", loaded); reject(error); }
            });
            await runtime.settle();
          });
          await measure("redraw", async () => {
            (globalThis as unknown as { drawLayers: () => void }).drawLayers();
            await runtime.settle();
          });
          await measure("regrid", () =>
            runtime.fns.regrid({ density: Math.round(cells * 0.9), phase: "apply", timeoutMs: 300000 })
          );
          return timings;
        },
        { cells }
      );
      if (pageErrors.length) throw new Error(pageErrors.join("\n"));
      for (const [operation, ms] of Object.entries(timings)) {
        if (!Number.isFinite(ms) || ms <= 0) throw new Error(`Invalid timing ${operation}`);
        if (iteration) collected.set(operation, [...(collected.get(operation) || []), ms]);
      }
      console.log(`${cells} cells ${iteration ? `sample ${iteration}` : "warmup"}: ${JSON.stringify(timings)}`);
    }
    for (const [operation, samplesMs] of collected) {
      const sorted = [...samplesMs].sort((a, b) => a - b);
      measurements.push({ cells, operation, samplesMs, medianMs: sorted[Math.floor(sorted.length / 2)] });
    }
  }
  const output = process.env.BENCH_OUTPUT || "bench/results/current.json";
  mkdirSync(output.substring(0, output.lastIndexOf("/")) || ".", { recursive: true });
  writeFileSync(
    output,
    JSON.stringify(
      {
        schema: 2,
        node: process.version,
        layers: ["default", "heightmap", "relief"],
        samples,
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        chromium: browser.version(),
        viewport: [1280, 720],
        seed: "7319",
        measurements
      },
      null,
      2
    ) + "\n"
  );
} finally {
  await browser.close();
  server.kill("SIGTERM");
}
