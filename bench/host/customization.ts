// Customization smoke (REWRITE-PLAN §5 row 25; PROOF-PLAN §6 G-S "Save stays blocked during customization. Trade
// data-layer-off is preserved. #ruler/#tradeAnimation are cleared."). Run it through bench/gate/gate.ts
// (`gate customization`), which takes a shared host-lock slot and sets GATE_OUT_DIR.
//
// Row 25 plans the heightmap image-converter overlay (`#canvas`, redrawn from the d3 camera callback in main.js) as a
// native GPU texture. What was built is a bridge: a customization mode (the global `customization` != 0) suspends the GPU
// (renderer.editorReason / lifecycle.ts), the canonical SVG shows, and main.js's camera() redraws the 2D overlay because
// gpuRenderer.camera() returns false. This smoke drives the real editors through that:
//
//   states manual assignment (customization 2)   editStates() then #statesManually, cancelled
//   heightmap, keep mode (customization 1)       editHeightmap({mode:"keep"}), finalised through #finalizeHeightmap
//   heightmap, erase mode + image converter      editHeightmap({mode:"erase", tool:"imageConverter"}), a PNG loaded through
//                                                #imageToLoad: the `#canvas` overlay is redrawn on every camera update,
//                                                with the same final transform under ?renderer=svg and ?renderer=gpu
//
// and checks, per mode:
//   <mode>.enter       the GPU canvas hides within HIDE_MS of entering and hiddenReason names the mode (the renderer stays
//                      "gpu": a suspension, not a fallback). Entering is announced by no DOM event, so this proves the
//                      250 ms watchdog (lifecycle.ts IDLE_WATCH_MS).
//   <mode>.camera      wheel zoom and drag in the mode: the svg transform follows the d3 camera, the canvas stays hidden.
//   <mode>.save        saveMap() is refused ("cannot be saved in EDIT mode") and starts no download.
//   <mode>.exit        customization returns to 0, the canvas comes back within the budget, the GPU frame is current and
//                      within D1 of the SVG on the light scene.
//   overlay.*          the converter overlay redraws, with the same final transform in both arms.
//   save.cleared       a save outside customization carries an empty #ruler and #tradeAnimation (row 25's G-S line; this
//                      is app behaviour and renderer-independent, asserted here so the GPU never changes it).
//
// Environment (gate.ts maps its arguments onto these):
//   CUSTOM_MAP        parity .map (default tests/fixtures/parity/parity-v1.map)
//   CUSTOM_DPR        1 | 2                                                                  default 2
//   CUSTOM_LAUNCHER   metal | swiftshader                                                    default metal
//   CUSTOM_MODES      comma list of states, heightmap-keep, heightmap-image                 default all
//   CUSTOM_BREAK      none | no-watch: self-test, the renderer stops reading `customization`; the run must FAIL on *.enter
// Output in GATE_OUT_DIR: customization.json (report; `failure` null on a pass) and PNGs of failing frames.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rgbDiff, ssim } from "../fidelity-metrics.ts";
import { heatmap } from "../golden-metrics.ts";
import { encodePng } from "../png.ts";
import { captureArms, decode, gpuProbe, launch, loadParity, openPage, parityFixture, serveDist, settleApp, waitCurrent, zoomTo, type Sink } from "./census-lib.ts";
import { type Check, failureSummary, fail, info, judgeFrameAfter, judged, pass, type FrameMetrics } from "./census-core.ts";

const env = process.env;
const outDir = join(env.GATE_OUT_DIR || process.cwd());
const dpr = Number(env.CUSTOM_DPR || 2);
if (dpr !== 1 && dpr !== 2) throw Error("CUSTOM_DPR must be 1 or 2");
const ALL_MODES = ["states", "heightmap-keep", "heightmap-image"];
const modes = (env.CUSTOM_MODES || ALL_MODES.join(",")).split(",").map(s => s.trim()).filter(Boolean);
for (const m of modes) if (!ALL_MODES.includes(m)) throw Error(`CUSTOM_MODES: unknown mode ${m}; one of ${ALL_MODES.join(", ")}`);
const breakMode = env.CUSTOM_BREAK || "none";
if (!["none", "no-watch"].includes(breakMode)) throw Error("CUSTOM_BREAK must be none|no-watch");
const HIDE_MS = 1500; // the watchdog polls every 250 ms; a frame and a loaded host on top
const EXIT_MS = 4000;
const LIGHT = ["biomes", "rivers", "routes", "borders", "lakes", "relief"];

const started = Date.now();
const log = (message: string) => process.stderr.write(`[customization ${Math.round((Date.now() - started) / 1000)}s] ${message}\n`);
const sink: Sink = { errors: [], warnings: [] };
const checks: Check[] = [];
const report: any = {
  schema: 1,
  check: "customization",
  config: { dpr, modes, break: breakMode, hideMs: HIDE_MS, exitMs: EXIT_MS, lightScene: LIGHT },
  modes: {} as Record<string, any>,
  checks,
  errors: sink.errors,
  warnings: sink.warnings,
  failure: null as string | null
};
const write = () => writeFileSync(join(outDir, "customization.json"), `${JSON.stringify(report, null, 2)}\n`);
const add = (c: Check) => {
  checks.push(c);
  log(`${c.status} ${c.id}${c.status === "PASS" ? "" : ` :: ${c.detail.slice(0, 240)}`}`);
};
const frameMetrics = (svg: Buffer, gpu: Buffer): FrameMetrics => {
  const a = decode(svg);
  const b = decode(gpu);
  return { ssim: ssim(a, b).ssim, over16Fraction: rgbDiff(a, b).over16Fraction };
};

// a 64x64 test image for the converter: four horizontal colour bands with a diagonal
function testPng(): Buffer {
  const width = 64;
  const height = 64;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const band = Math.floor((y / height) * 4);
      data[i] = [30, 120, 200, 250][band];
      data[i + 1] = x === y ? 255 : [60, 140, 90, 20][band];
      data[i + 2] = [200, 40, 120, 80][band];
      data[i + 3] = 255;
    }
  return encodePng({ width, height, data });
}

const served = await serveDist();
const { browser, launcher } = await launch(env.CUSTOM_LAUNCHER);
report.config.launcher = launcher;
try {
  mkdirSync(outDir, { recursive: true });
  const fixture = parityFixture(env.CUSTOM_MAP);
  report.config.fixture = { path: fixture.path, sha256: fixture.sha256 };

  const prepareWorld = async (page: import("playwright").Page) => {
    const problems = await loadParity(page, fixture);
    for (const p of problems) sink.warnings.push(p);
    const r = await page.evaluate(a => (globalThis as any).__tupaia.call("display", a), { only: LIGHT });
    if (!r.ok) throw Error(`display only ${LIGHT}: ${JSON.stringify(r).slice(0, 300)}`);
    await settleApp(page);
    await page.evaluate(zoomTo, { k: 1 });
  };

  const camera = (page: import("playwright").Page) =>
    page.evaluate(() => {
      const w = globalThis as any;
      const t = w.d3.zoomTransform(document.getElementById("map"));
      const attr = document.querySelector("#viewbox")!.getAttribute("transform") || "";
      const m = /translate\(([-\d.e]+)[ ,]+([-\d.e]+)\)\s*scale\(([-\d.e]+)\)/.exec(attr);
      return { d3: { k: t.k, x: t.x, y: t.y }, attr: m ? { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) } : null };
    });
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01 * Math.max(1, Math.abs(b));
  const hidden = (page: import("playwright").Page) =>
    page.evaluate(() => {
      const w = globalThis as any;
      const canvas = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
      const s = w.rendererStatus?.();
      return { display: canvas ? getComputedStyle(canvas).display : null, hiddenReason: s?.gpu?.hiddenReason ?? null, active: s?.active ?? null, customization: (0, eval)("typeof customization === 'undefined' ? null : customization") };
    });
  // poll until `done(state)` or the budget runs out; returns the ms it took and the last state
  const until = async (page: import("playwright").Page, done: (s: Awaited<ReturnType<typeof hidden>>) => boolean, budget: number) => {
    const t0 = Date.now();
    let state = await hidden(page);
    while (!done(state) && Date.now() - t0 < budget) {
      await page.waitForTimeout(40);
      state = await hidden(page);
    }
    return { ms: Date.now() - t0, state, ok: done(state) };
  };
  const evidence = (label: string, shots: { svg: Buffer; gpu: Buffer }) => {
    writeFileSync(join(outDir, `${label}-svg.png`), shots.svg);
    writeFileSync(join(outDir, `${label}-gpu.png`), shots.gpu);
    writeFileSync(join(outDir, `${label}-diff.png`), encodePng(heatmap(decode(shots.svg), decode(shots.gpu))));
    return `${label}-diff.png`;
  };

  const gpuOpened = await openPage(browser, served.origin, { dpr, renderer: "gpu", launcher, sink, label: "gpu" });
  const page = gpuOpened.page;
  report.adapter = gpuOpened.adapter;
  let downloads = 0;
  page.on("download", () => downloads++);

  // ---- a save outside customization: #ruler and #tradeAnimation cleared (renderer independent; asserted so the GPU never changes it)
  await prepareWorld(page);
  {
    const saved = await page.evaluate(async () => {
      const w = globalThis as any;
      // a fixture that never measured anything has no ruler; add one measurer and one animated trade dot as the app would
      const ns = "http://www.w3.org/2000/svg";
      const ruler = document.getElementById("ruler");
      if (ruler && !ruler.childElementCount) {
        const g = document.createElementNS(ns, "g");
        g.appendChild(document.createElementNS(ns, "line"));
        ruler.appendChild(g);
      }
      const trade = document.getElementById("tradeAnimation");
      if (trade && !trade.childElementCount) trade.appendChild(document.createElementNS(ns, "circle"));
      const before = { ruler: document.querySelectorAll("#ruler *").length, trade: document.querySelectorAll("#tradeAnimation > *").length };
      const { prepareMapData } = await w.lazy.save();
      const text = prepareMapData() as string;
      const doc = new DOMParser().parseFromString(text.split("\r\n")[5], "image/svg+xml");
      return { before, ruler: doc.querySelectorAll("#ruler *").length, trade: doc.querySelectorAll("#tradeAnimation > *").length };
    });
    const problems = [
      ...(saved.before.ruler === 0 ? ["the fixture has no measurer in #ruler (the check would be vacuous)"] : []),
      ...(saved.before.trade === 0 ? ["no trade marker is animating (the check would be vacuous)"] : []),
      ...(saved.ruler ? [`the saved #ruler holds ${saved.ruler} element(s)`] : []),
      ...(saved.trade ? [`the saved #tradeAnimation holds ${saved.trade} element(s)`] : [])
    ];
    add(judged("save.cleared", "25", problems, `live: ${saved.before.ruler} ruler / ${saved.before.trade} trade element(s); saved: 0 / 0`));
  }

  if (breakMode === "no-watch") await page.evaluate(() => ((globalThis as any).gpuRenderer.editorReason = () => ""));

  interface Mode {
    name: string;
    mode: number;
    enter(): Promise<void>;
    exit(): Promise<void>;
  }
  const definitions: Mode[] = [
    {
      name: "states",
      mode: 2,
      enter: async () => {
        await page.evaluate(() => (globalThis as any).editStates());
        await page.waitForSelector("#statesManually", { state: "visible" });
        await page.click("#statesManually");
      },
      exit: async () => {
        await page.click("#statesManuallyCancel");
        // cancelling leaves the States editor dialog open, and an open dialog keeps the canvas hidden ("editor dialog open")
        await page.evaluate(() => (globalThis as any).$("#statesEditor").dialog("close"));
      }
    },
    {
      name: "heightmap-keep",
      mode: 1,
      enter: async () => {
        await page.evaluate(() => (globalThis as any).editHeightmap({ mode: "keep" }));
      },
      exit: async () => {
        await page.evaluate(() => (document.getElementById("finalizeHeightmap") as HTMLElement).click());
      }
    }
  ];

  const camPoke = async (label: string) => {
    // wheel zoom in, drag pan, wheel zoom out: three camera updates ending in exact frames
    await page.mouse.move(640, 360);
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -120);
    await page.waitForTimeout(450);
    await page.mouse.move(640, 360);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(640 + i * 12, 360 + i * 5);
    await page.mouse.up();
    await page.waitForTimeout(450);
    for (let i = 0; i < 2; i++) await page.mouse.wheel(0, 120);
    await page.waitForTimeout(450);
    const cam = await camera(page);
    const state = await hidden(page);
    const problems: string[] = [];
    if (!cam.attr) problems.push("the svg transform is unreadable");
    else if (!(near(cam.attr.k, cam.d3.k) && near(cam.attr.x, cam.d3.x) && near(cam.attr.y, cam.d3.y))) problems.push(`svg transform ${JSON.stringify(cam.attr)} lags the d3 camera ${JSON.stringify(cam.d3)}`);
    if (state.display !== "none") problems.push(`the GPU canvas is display:${state.display} during the mode`);
    return { problems, cam, label };
  };

  for (const def of definitions) {
    if (!modes.includes(def.name)) continue;
    log(`mode ${def.name}`);
    await prepareWorld(page);
    const ready = await waitCurrent(page);
    if (ready.active !== "gpu" || ready.timedOut) throw Error(`${def.name}: no GPU frame before entering (${JSON.stringify(ready)})`);
    const rec: any = (report.modes[def.name] = { mode: def.mode });
    const before = await hidden(page);
    if (before.display === "none") throw Error(`${def.name}: the GPU canvas is hidden before entering`);
    // baseline frame (GPU vs SVG, same scene and camera) before the mode: the exit frame must not be worse than this
    await settleApp(page);
    const baseline = frameMetrics(...(await (async () => { const s = await captureArms(page); return [s.svg, s.gpu] as const; })()));
    rec.baselineFrame = baseline;

    // ---- enter
    await def.enter();
    const entered = await until(page, s => s.display === "none" && /^editor customization/.test(s.hiddenReason ?? "") && s.customization === def.mode, HIDE_MS);
    rec.enter = { ms: entered.ms, state: entered.state };
    const enterProblems: string[] = [];
    if (entered.state.customization !== def.mode) enterProblems.push(`customization is ${entered.state.customization}, expected ${def.mode} (the editor did not enter the mode)`);
    if (entered.state.display !== "none") enterProblems.push(`the GPU canvas is still display:${entered.state.display} ${entered.ms} ms after entering`);
    if (!/^editor customization/.test(entered.state.hiddenReason ?? "")) enterProblems.push(`hiddenReason is "${entered.state.hiddenReason}", not "editor customization ${def.mode}"`);
    if (entered.state.active !== "gpu") enterProblems.push(`the renderer left the gpu path (${entered.state.active})`);
    add(judged(`${def.name}.enter`, "25", enterProblems, `canvas hidden ${entered.ms} ms after entering (budget ${HIDE_MS}): ${entered.state.hiddenReason}`));
    if (enterProblems.length) {
      // nothing after this means anything with the GPU frame on top of the editor
      try {
        await def.exit();
      } catch {}
      continue;
    }

    // ---- camera moves in the mode
    const poked = await camPoke(def.name);
    rec.camera = poked.cam;
    add(judged(`${def.name}.camera`, "25", poked.problems, `wheel + drag + wheel: svg transform tracks the d3 camera (k ${poked.cam.d3.k.toFixed(2)}), canvas stays hidden`));

    // ---- save is refused
    const downloadsBefore = downloads;
    const tipText = await page.evaluate(async () => {
      const w = globalThis as any;
      const { saveMap } = await w.lazy.save();
      await saveMap("machine");
      return document.getElementById("tooltip")?.textContent ?? "";
    });
    await page.waitForTimeout(300);
    const saveProblems: string[] = [];
    if (!/cannot be saved/i.test(tipText)) saveProblems.push(`saveMap() was not refused (tip: "${tipText.slice(0, 80)}")`);
    if (downloads !== downloadsBefore) saveProblems.push("a download started during customization");
    add(judged(`${def.name}.save`, "25", saveProblems, `saveMap() refused: "${tipText.replace(/<[^>]+>/g, "").slice(0, 70)}"`));

    // ---- exit
    await def.exit();
    const left = await until(page, s => s.customization === 0 && s.display !== "none" && !s.hiddenReason, EXIT_MS * (def.name === "heightmap-keep" ? 8 : 1));
    rec.exit = { ms: left.ms, state: left.state };
    const exitProblems: string[] = [];
    if (left.state.customization !== 0) exitProblems.push(`customization is still ${left.state.customization}`);
    else {
      if (left.state.display === "none") exitProblems.push(`the GPU canvas did not come back (${left.ms} ms; hiddenReason "${left.state.hiddenReason}")`);
      const wait = await waitCurrent(page, 120000, false);
      await settleApp(page);
      rec.exitCamera = { d3: (await camera(page)).d3, svg: (await camera(page)).attr, gpu: await page.evaluate(() => ({ ...(globalThis as any).gpuRenderer?.view })) };
      if (def.name === "states") {
        // the States editor switches the states, borders and labels layers on for itself and leaves them on: that is a
        // different scene from the baseline (and the states halo is a known, separately tracked fidelity gap). Put the
        // light scene back, which is also the proof that the renderer resumed following DOM changes after the exit.
        const r = await page.evaluate(a => (globalThis as any).__tupaia.call("display", a), { only: LIGHT });
        if (!r.ok) exitProblems.push(`display only after exit failed: ${JSON.stringify(r).slice(0, 160)}`);
        await settleApp(page);
      }
      const wait2 = await waitCurrent(page);
      const shots = await captureArms(page);
      const m = frameMetrics(shots.svg, shots.gpu);
      rec.exitFrame = m;
      const frameProblems = judgeFrameAfter({ label: "after exit", before: baseline, after: m, gpu: wait2.active ? wait2 : wait });
      exitProblems.push(...frameProblems);
      let ev: string | undefined;
      if (exitProblems.length) ev = evidence(`${def.name}-exit`, shots);
      add(judged(`${def.name}.exit`, "25", exitProblems, `customization 0, canvas back after ${left.ms} ms, SSIM ${m.ssim.toFixed(4)}, over16 ${(m.over16Fraction * 100).toFixed(3)}%`, ev));
      write();
      continue;
    }
    add(judged(`${def.name}.exit`, "25", exitProblems, ""));
    write();
  }

  // ================================================================= heightmap image converter overlay (both arms)
  if (modes.includes("heightmap-image")) {
    log("mode heightmap-image");
    const png = testPng();
    const arms: Record<string, any> = {};
    for (const arm of ["svg", "gpu"] as const) {
      const opened = arm === "gpu" ? { page, context: gpuOpened.context } : await openPage(browser, served.origin, { dpr, renderer: "svg", launcher, sink, label: "svg" });
      const p = opened.page;
      await prepareWorld(p);
      if (arm === "gpu") {
        const ready = await waitCurrent(p, 120000, false);
        if (ready.active !== "gpu" || ready.timedOut) throw Error(`heightmap-image: no GPU frame (${JSON.stringify(ready)})`);
        if (breakMode === "no-watch") await p.evaluate(() => ((globalThis as any).gpuRenderer.editorReason = () => ""));
      }
      await p.evaluate(() => {
        const w = globalThis as any;
        w.__ov = { n: 0, last: null as number[] | null, draws: 0 };
        const setTransform = CanvasRenderingContext2D.prototype.setTransform;
        (CanvasRenderingContext2D.prototype as any).setTransform = function (...a: number[]) {
          if (this.canvas?.id === "canvas") {
            w.__ov.n++;
            w.__ov.last = a;
          }
          return (setTransform as any).apply(this, a);
        };
        const drawImage = CanvasRenderingContext2D.prototype.drawImage;
        (CanvasRenderingContext2D.prototype as any).drawImage = function (...a: unknown[]) {
          if (this.canvas?.id === "canvas") w.__ov.draws++;
          return (drawImage as any).apply(this, a);
        };
        w.editHeightmap({ mode: "erase", tool: "imageConverter" });
      });
      await p.waitForSelector("#imageToLoad", { state: "attached" });
      await p.setInputFiles("#imageToLoad", { name: "bands.png", mimeType: "image/png", buffer: png });
      await p.waitForFunction(() => !!document.getElementById("imageToConvert"), {}, { timeout: 20000 });
      await p.waitForTimeout(2500); // the image's onload calls resetZoom(), a 1 s transition that would fight the wheel
      // the overlay is only drawn when its opacity is not 0 (main.js camera()); the converter opens with 0
      await p.evaluate(() => {
        const input = document.getElementById("convertOverlay") as HTMLInputElement;
        input.value = "0.5";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const hasCanvas = await p.evaluate(() => !!document.getElementById("canvas"));
      // camera updates with the overlay present
      await p.evaluate(() => {
        const w = globalThis as any;
        w.__ov.n = 0;
        w.__ov.draws = 0;
        w.__ov.last = null;
      });
      await p.mouse.move(640, 360);
      for (let i = 0; i < 3; i++) await p.mouse.wheel(0, -120);
      await p.waitForTimeout(450);
      await p.mouse.move(640, 360);
      await p.mouse.down();
      for (let i = 1; i <= 8; i++) await p.mouse.move(640 + i * 12, 360 + i * 5);
      await p.mouse.up();
      await p.waitForTimeout(600);
      const result = await p.evaluate(() => {
        const w = globalThis as any;
        const g = (0, eval)("[scale, viewX, viewY]") as number[];
        const canvas = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
        return { ov: { ...w.__ov }, camera: g, canvasDisplay: canvas ? getComputedStyle(canvas).display : null, customization: (0, eval)("customization"), tipOverlay: !!document.getElementById("canvas") };
      });
      arms[arm] = { hasCanvas, ...result };
    }
    report.modes["heightmap-image"] = arms;
    const problems: string[] = [];
    for (const arm of ["svg", "gpu"]) {
      const a = arms[arm];
      if (!a.hasCanvas) problems.push(`${arm}: no #canvas overlay (the converter did not open)`);
      else if (!a.ov.last || a.ov.draws === 0) problems.push(`${arm}: the overlay was not redrawn on camera updates (${a.ov.n} setTransform, ${a.ov.draws} drawImage)`);
      else {
        const [k, x, y] = a.camera;
        const [sa, , , sd, e, f] = a.ov.last;
        if (!(near(sa, k) && near(sd, k) && near(e, x) && near(f, y))) problems.push(`${arm}: overlay transform [${a.ov.last.map((v: number) => v.toFixed(2))}] != camera [${k.toFixed(2)}, ${x.toFixed(1)}, ${y.toFixed(1)}]`);
      }
    }
    if (arms.gpu && arms.gpu.canvasDisplay !== "none") problems.push(`gpu: the canvas is display:${arms.gpu.canvasDisplay} while the converter is open`);
    if (arms.svg?.ov && arms.gpu?.ov && Math.abs(arms.svg.ov.draws - arms.gpu.ov.draws) > Math.max(6, arms.svg.ov.draws)) {
      // the arms are driven by the same input but different frame timing: counts differ, final transforms must not
      report.warnings.push(`overlay drawImage counts: svg ${arms.svg.ov.draws}, gpu ${arms.gpu.ov.draws}`);
    }
    if (arms.svg?.camera && arms.gpu?.camera && !arms.svg.camera.every((v: number, i: number) => near(v, arms.gpu.camera[i]))) problems.push(`the arms ended at different cameras: svg ${arms.svg.camera.map((v: number) => v.toFixed(2))} gpu ${arms.gpu.camera.map((v: number) => v.toFixed(2))}`);
    add(judged("overlay.image-converter", "25", problems, `#canvas overlay redrawn on camera updates in both arms (svg ${arms.svg?.ov.draws} draws, gpu ${arms.gpu?.ov.draws}), final transform = camera, GPU canvas hidden`));
    write();
  }

  const validation = sink.warnings.some(w => /GL_INVALID_|Feedback loop/i.test(w));
  if (sink.errors.length) add(fail("run.page-errors", "25", `${sink.errors.length} page error(s): ${sink.errors[0].slice(0, 200)}`));
  else add(pass("run.page-errors", "25", "no page errors"));
  if (validation) add(fail("run.webgl-validation", "25", "WebGL validation warning; reject the render result"));
  if (!checks.some(c => c.id.endsWith(".enter") || c.id === "overlay.image-converter")) add(info("run.modes", "25", "no mode ran"));
} catch (error) {
  report.failure = `harness: ${error instanceof Error ? error.stack : String(error)}`;
  sink.errors.push(String(error));
} finally {
  report.summary = {
    checks: checks.length,
    pass: checks.filter(c => c.status === "PASS").length,
    fail: checks.filter(c => c.status === "FAIL").length,
    info: checks.filter(c => c.status === "INFO").length,
    seconds: Math.round((Date.now() - started) / 1000)
  };
  report.failure ??= failureSummary(checks);
  write();
  log(report.failure ? `FAIL ${report.failure.slice(0, 400)}` : `PASS ${checks.length} checks`);
  await browser.close();
  await served.close();
}
