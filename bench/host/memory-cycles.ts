// Memory: no growth over world-replace cycles, and over resizes (PROOF-PLAN §4 "No growth over 20 world-replace cycles",
// gate gap 16). Run it through bench/gate/gate.ts (`gate memory-cycles`), which takes a shared host-lock slot and sets
// GATE_OUT_DIR.
//
// The renderer holds a lot (GL textures, the glyph atlas, compat rasters, a CPU payload kept for context restore, trade
// marker textures, observers on the document). A load replaces #map; everything of the old world must go. This check
// loads the parity fixture CYCLES times in one page (the app's own load path), and after each cycle's GPU frame is
// current and refined it forces two GCs and records:
//   - the JS heap (CDP Runtime.getHeapUsage after HeapProfiler.collectGarbage),
//   - DOM counters (CDP Memory.getDOMCounters: documents, nodes, jsEventListeners),
//   - the renderer's own tracked allocations and CPU payload (rendererStatus().gpu.memory),
//   - the GPU canvases in the document, and whether the same GpuRenderer object is still the one (a load must not
//     build a second renderer or a second WebGL context).
// then RESIZES window resizes (alternating three sizes, back to the start size at the end) with the same measures.
// Growth is judged between the warm-up cycle and the last (census-core.ts judgeMemory + MEMORY_LIMITS). Tracked GPU
// bytes are deterministic for one world at one size, so they must not drift at all (2 %); the JS heap is allowed
// 6 MB / 5 % for JIT and cache settling. Both limits are a first calibration: they go in the report and in GATE.md.
//
// Environment (gate.ts maps its arguments onto these):
//   MEMORY_MAP        parity .map (default tests/fixtures/parity/parity-v1.map)
//   MEMORY_DPR        1 | 2                                                              default 2
//   MEMORY_LAUNCHER   metal | swiftshader                                                default metal
//   MEMORY_CYCLES     world-replace cycles after the first load                          default 12
//   MEMORY_RESIZES    resizes                                                            default 12
//   MEMORY_WARMUP     cycles discarded as warm-up before the baseline                    default 3
//   MEMORY_STEPS     world,resize                                                        default world,resize
//   MEMORY_BREAK      none | leak: self-test, every cycle retains 8 MB and 800 DOM nodes; the run must FAIL
// Output in GATE_OUT_DIR: memory.json (report; `failure` null on a pass).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gpuProbe, launch, loadParity, openPage, parityFixture, serveDist, settleApp, waitCurrent, type Sink } from "./census-lib.ts";
import { type Check, failureSummary, fail, info, judgeGrowth, judgeMemory, judged, MEMORY_LIMITS, type MemorySnapshot, pass } from "./census-core.ts";

const env = process.env;
const outDir = join(env.GATE_OUT_DIR || process.cwd());
const dpr = Number(env.MEMORY_DPR || 2);
if (dpr !== 1 && dpr !== 2) throw Error("MEMORY_DPR must be 1 or 2");
const cycles = Number(env.MEMORY_CYCLES || 20);
const resizes = Number(env.MEMORY_RESIZES || 12);
const warmup = Number(env.MEMORY_WARMUP || 3);
const steps = (env.MEMORY_STEPS || "world,resize").split(",").map(x => x.trim());
for (const step of steps) if (!["world", "resize"].includes(step)) throw Error(`MEMORY_STEPS: unknown step ${step}`);
const breakMode = env.MEMORY_BREAK || "none";
if (!["none", "leak"].includes(breakMode)) throw Error("MEMORY_BREAK must be none|leak");
if (steps.includes("world") && (!Number.isInteger(cycles) || cycles < warmup + 3)) throw Error(`MEMORY_CYCLES must be an integer >= ${warmup + 3}`);
if (steps.includes("resize") && (!Number.isInteger(resizes) || resizes < warmup + 3)) throw Error(`MEMORY_RESIZES must be an integer >= ${warmup + 3}`);

const started = Date.now();
const log = (message: string) => process.stderr.write(`[memory ${Math.round((Date.now() - started) / 1000)}s] ${message}\n`);
const sink: Sink = { errors: [], warnings: [] };
const checks: Check[] = [];
const report: any = {
  schema: 1,
  check: "memory-cycles",
  config: { dpr, cycles, resizes, warmup, steps, break: breakMode, limits: MEMORY_LIMITS },
  worldReplace: [] as MemorySnapshot[],
  resize: [] as MemorySnapshot[],
  growth: {} as Record<string, unknown>,
  checks,
  errors: sink.errors,
  warnings: sink.warnings,
  failure: null as string | null
};
const write = () => writeFileSync(join(outDir, "memory.json"), `${JSON.stringify(report, null, 2)}\n`);
const add = (c: Check) => {
  checks.push(c);
  log(`${c.status} ${c.id}${c.status === "PASS" ? "" : ` :: ${c.detail.slice(0, 240)}`}`);
};

const served = await serveDist();
const { browser, launcher } = await launch(env.MEMORY_LAUNCHER);
report.config.launcher = launcher;
try {
  mkdirSync(outDir, { recursive: true });
  const fixture = parityFixture(env.MEMORY_MAP);
  report.config.fixture = { path: fixture.path, sha256: fixture.sha256 };
  const opened = await openPage(browser, served.origin, { dpr, renderer: "gpu", launcher, sink, label: "gpu" });
  const { page, context } = opened;
  report.adapter = opened.adapter;
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.evaluate(() => {
    const w = globalThis as any;
    w.__memToken = w.gpuRenderer; // the renderer instance a load must not replace
  });

  const snapshot = async (cycle: number): Promise<MemorySnapshot & { sameRenderer: boolean; wait: unknown }> => {
    const wait = await waitCurrent(page); // current and refined: the allocations are at rest
    await settleApp(page);
    await cdp.send("HeapProfiler.collectGarbage");
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await cdp.send("Runtime.getHeapUsage");
    const counters = await cdp.send("Memory.getDOMCounters");
    const probe = await page.evaluate(gpuProbe);
    const extra = await page.evaluate(() => {
      const w = globalThis as any;
      return { canvases: document.querySelectorAll("canvas[data-gpu-renderer]").length, same: w.gpuRenderer === w.__memToken, gl: document.querySelectorAll("canvas").length };
    });
    return {
      cycle,
      heap: heap.usedSize,
      nodes: counters.nodes,
      listeners: counters.jsEventListeners,
      documents: counters.documents,
      gpuTracked: probe.memory?.gpu?.total ?? probe.memory?.gpu ?? null,
      gpuCpu: probe.memory?.cpu ?? null,
      canvases: extra.canvases,
      contexts: extra.gl,
      sameRenderer: extra.same,
      wait
    };
  };
  const leak = () =>
    breakMode === "leak"
      ? page.evaluate(() => {
          const w = globalThis as any;
          (w.__leak ??= []).push(new Uint8Array(8 * 1024 * 1024).fill(7));
          const holder = document.createElement("div");
          for (let i = 0; i < 800; i++) holder.appendChild(document.createElement("span"));
          (w.__leakDom ??= []).push(holder);
        })
      : Promise.resolve();

  // ---- world-replace cycles: the first load is cycle 0
  for (let cycle = 0; cycle <= (steps.includes("world") ? cycles : 0); cycle++) {
    const problems = await loadParity(page, fixture, []); // the file carries its layers; no per-toggle churn between cycles
    for (const p of problems) sink.warnings.push(p);
    await leak();
    const snap = await snapshot(cycle);
    report.worldReplace.push(snap);
    log(`cycle ${cycle}: heap ${(snap.heap / 1048576).toFixed(1)} MB, nodes ${snap.nodes}, listeners ${snap.listeners}, gpu tracked ${snap.gpuTracked}, cpu ${snap.gpuCpu}`);
    write();
  }
  if (steps.includes("world")) {
    const snaps = report.worldReplace as Array<MemorySnapshot & { sameRenderer: boolean; wait: any }>;
    const verdict = judgeMemory(snaps, warmup);
    const problems = [...verdict.problems];
    const replaced = snaps.filter(s => !s.sameRenderer).map(s => s.cycle);
    if (replaced.length) problems.push(`a new GpuRenderer replaced the first one at cycle(s) ${replaced.slice(0, 5).join(", ")}`);
    const notCurrent = snaps.filter(s => s.wait.active !== "gpu" || s.wait.timedOut).map(s => s.cycle);
    if (notCurrent.length) problems.push(`GPU not current/active at cycle(s) ${notCurrent.slice(0, 5).join(", ")}`);
    report.growth.worldReplace = verdict.growth;
    add(
      judged(
        "memory.world-replace",
        "gap16",
        problems,
        `${cycles} world replaces: heap ${(verdict.growth.heap / 1048576).toFixed(1)} MB, nodes ${verdict.growth.nodes}, listeners ${verdict.growth.listeners}, gpu tracked ${verdict.growth.gpuTracked} B, cpu payload ${verdict.growth.gpuCpu} B since cycle ${warmup}`
      )
    );
  }

  // ---- resizes: alternate three sizes and finish at the start size, so tracked bytes are comparable
  const sizes: Array<[number, number]> = [
    [1000, 640],
    [1500, 800],
    [1280, 720]
  ];
  for (let i = 0; steps.includes("resize") && i <= resizes; i++) {
    const [width, height] = i === resizes ? [1280, 720] : sizes[i % sizes.length];
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
    await leak();
    const snap = await snapshot(i);
    report.resize.push(snap);
    if (i % 5 === 0 || i === resizes) log(`resize ${i} (${width}x${height}): heap ${(snap.heap / 1048576).toFixed(1)} MB, nodes ${snap.nodes}, gpu tracked ${snap.gpuTracked}`);
    write();
  }
  if (steps.includes("resize")) {
    // the 1280x720 snapshot nearest after the warm-up against the last (also 1280x720): same world, same size
    const all = report.resize as Array<MemorySnapshot & { sameRenderer: boolean; wait: any }>;
    const atStart = all.find((s, i) => s.cycle >= warmup && i % sizes.length === 2) ?? all[all.length - 2];
    const last = all.at(-1)!;
    const verdict = judgeGrowth(atStart, last);
    const problems = [...verdict.problems];
    if (all.some(s => !s.sameRenderer)) problems.push("the GpuRenderer was replaced during a resize");
    const notCurrent = all.filter(s => s.wait.active !== "gpu" || s.wait.timedOut).map(s => s.cycle);
    if (notCurrent.length) problems.push(`GPU not current/active at resize(s) ${notCurrent.slice(0, 5).join(", ")}`);
    report.growth.resize = verdict.growth;
    add(judged("memory.resize", "gap16", problems, `${resizes} resizes: heap ${(verdict.growth.heap / 1048576).toFixed(1)} MB, nodes ${verdict.growth.nodes}, listeners ${verdict.growth.listeners}, gpu tracked ${verdict.growth.gpuTracked} B (1280x720 compared with 1280x720)`));
  }
  if (report.worldReplace.length) add(info("memory.summary", "gap16", `heap ${(report.worldReplace[0].heap / 1048576).toFixed(1)} MB at cycle 0, ${(report.worldReplace.at(-1).heap / 1048576).toFixed(1)} MB at cycle ${cycles}; tracked GPU ${report.worldReplace.at(-1).gpuTracked} B`));

  const validation = sink.warnings.some(w => /GL_INVALID_|Feedback loop/i.test(w));
  if (sink.errors.length) add(fail("run.page-errors", "gap16", `${sink.errors.length} page error(s): ${sink.errors[0].slice(0, 200)}`));
  else add(pass("run.page-errors", "gap16", "no page errors"));
  if (validation) add(fail("run.webgl-validation", "gap16", "WebGL validation warning; reject the render result"));
} catch (error) {
  report.failure = `harness: ${error instanceof Error ? error.stack : String(error)}`;
  sink.errors.push(String(error));
} finally {
  report.summary = {
    checks: checks.length,
    pass: checks.filter(c => c.status === "PASS").length,
    fail: checks.filter(c => c.status === "FAIL").length,
    seconds: Math.round((Date.now() - started) / 1000)
  };
  report.failure ??= failureSummary(checks);
  write();
  log(report.failure ? `FAIL ${report.failure.slice(0, 400)}` : `PASS ${checks.length} checks`);
  await browser.close();
  await served.close();
}
