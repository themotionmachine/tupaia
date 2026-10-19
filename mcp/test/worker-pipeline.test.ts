import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserManager } from "../src/browser.ts";
import { loadConfig, ModeState } from "../src/config.ts";
import { safeEnv } from "./helpers.ts";

test("50k generation uses transferable workers and matches synchronous seeded world", {
  timeout: 120_000
}, async () => {
  const browser = new BrowserManager(loadConfig(safeEnv()), new ModeState("local"));
  try {
    const page = await browser.getPage();
    await page.evaluate(`
      globalThis.__workerUrls = [];
      globalThis.__workerMessages = [];
      globalThis.__NativeWorker = Worker;
      globalThis.Worker = class extends Worker {
        constructor(url, options) { super(url, options); this.__workerUrl = String(url); globalThis.__workerUrls.push(this.__workerUrl); }
        postMessage(...args) { globalThis.__workerMessages.push({ url: this.__workerUrl, operation: args[0]?.operation || null }); return super.postMessage(...args); }
      };
      globalThis.__stageMetrics = {};
      for (const [owner, method, label] of [[HeightmapGenerator, "generate", "heightmap"], [Rivers, "generateAsync", "rivers"], [Biomes, "defineAsync", "biomes"], [Cultures, "expandAsync", "cultures"], [States, "expandStatesAsync", "states"]]) {
        const original = owner[method].bind(owner);
        owner[method] = async (...args) => {
          let ticks = 0;
          const started = performance.now();
          let lastTick = started, maxGapMs = 0;
          const timer = setInterval(() => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - lastTick); lastTick = now; ticks++; }, 1);
          try { return await original(...args); }
          finally { clearInterval(timer); globalThis.__stageMetrics[label] = { ticks, elapsedMs: performance.now() - started, maxGapMs: Math.max(maxGapMs, performance.now() - lastTick) }; }
        };
      }
    `);
    const generate = async () => {
      const result = await browser.callBridge(
        "generateMap",
        { seed: "worker-pipeline-parity", cells: 50000, template: "continents", timeoutMs: 110000 },
        { timeoutMs: 120000, mutating: true }
      );
      assert.equal(result.ok, true, JSON.stringify(result.error));
      return page.evaluate(`(() => {
        const hash = value => {
          const text = JSON.stringify(value);
          let code = 2166136261;
          for (let i = 0; i < text.length; i++) code = Math.imul(code ^ text.charCodeAt(i), 16777619);
          return (code >>> 0).toString(16);
        };
        return {
          gridHeights: hash(Array.from(grid.cells.h)),
          heights: hash(Array.from(pack.cells.h)), flux: hash(Array.from(pack.cells.fl)),
          riversByCell: hash(Array.from(pack.cells.r)), confluence: hash(Array.from(pack.cells.conf)),
          riverRecords: hash(pack.rivers), biomes: hash(Array.from(pack.cells.biome)),
          cultures: hash(Array.from(pack.cells.culture)), states: hash(Array.from(pack.cells.state)),
          cultureRecords: hash(pack.cultures), stateRecords: hash(pack.states)
        };
      })()`);
    };
    const worker = await generate();
    const urls = (await page.evaluate("globalThis.__workerUrls")) as string[];
    const metrics = (await page.evaluate("globalThis.__stageMetrics")) as Record<
      string,
      { ticks: number; elapsedMs: number; maxGapMs: number }
    >;
    assert.ok(
      urls.some(url => url.includes("heightmap.worker")),
      "heightmap worker must run"
    );
    assert.ok(
      urls.some(url => url.includes("river.worker")),
      "river worker must run"
    );
    assert.ok(
      urls.some(url => url.includes("biome.worker")),
      "biome worker must run"
    );
    assert.ok(
      urls.filter(url => url.includes("expansion.worker")).length >= 2,
      "both culture and state expansion workers must run"
    );
    const messages = (await page.evaluate("globalThis.__workerMessages")) as Array<{
      url: string;
      operation: string | null;
    }>;
    assert.ok(messages.some(message => message.operation === "expandCultures"));
    assert.ok(messages.some(message => message.operation === "expandStates"));
    for (const stage of ["heightmap", "rivers", "biomes", "cultures", "states"])
      assert.ok(metrics[stage].ticks > 0, `${stage} must leave the page event loop responsive`);
    assert.ok(metrics.heightmap.ticks > 0, "terrain generation must leave the page event loop responsive");
    assert.ok(metrics.rivers.ticks > 0, "river generation must leave the page event loop responsive");
    await page.evaluate("globalThis.Worker = undefined");
    const synchronous = await generate();
    assert.deepEqual(worker, synchronous);
    await page.evaluate("globalThis.Worker = globalThis.__NativeWorker");
    const cancellation = await page.evaluate(`(async () => {
      const outcome = promise => promise.then(() => "fulfilled", error => error.name);
      const originalGrid = grid;
      const staleTerrain = outcome(HeightmapGenerator.generate(grid));
      grid = {...grid};
      const terrainLoad = await staleTerrain;
      grid = originalGrid;
      const firstTerrain = outcome(HeightmapGenerator.generate(grid));
      const secondTerrain = outcome(HeightmapGenerator.generate(grid));
      const terrainSuperseded = await firstTerrain;
      const terrainLatest = await secondTerrain;
      const originalPack = pack;
      const originalHeights = pack.cells.h;
      const originalFlux = pack.cells.fl;
      const staleRivers = outcome(Rivers.generateAsync(false));
      pack = {...pack, cells: {...pack.cells}};
      const riversLoad = await staleRivers;
      const untouched = originalPack.cells.h === originalHeights && originalPack.cells.fl === originalFlux;
      pack = originalPack;
      const firstRivers = outcome(Rivers.generateAsync(false));
      const secondRivers = outcome(Rivers.generateAsync(false));
      const riversSuperseded = await firstRivers;
      const riversLatest = await secondRivers;
      return {terrainLoad, terrainSuperseded, terrainLatest, riversLoad, riversSuperseded, riversLatest, untouched};
    })()`);
    assert.deepEqual(cancellation, {
      terrainLoad: "AbortError",
      terrainSuperseded: "AbortError",
      terrainLatest: "fulfilled",
      riversLoad: "AbortError",
      riversSuperseded: "AbortError",
      riversLatest: "fulfilled",
      untouched: true
    });
    console.log(
      JSON.stringify({
        workerPipelineMetrics: metrics,
        workerCount: urls.length,
        workerMessages: messages,
        matchedWorld: worker
      })
    );
  } finally {
    await browser.close();
  }
});
