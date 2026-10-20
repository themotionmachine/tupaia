// Resize, DPR change, mid-gesture resize, print and layers-preset smoke (REWRITE-PLAN §5 row 39, "UNVERIFIED" until
// this existed; PROOF-PLAN §4 "DPR change and window resize"). Run it through bench/gate/gate.ts (`gate resize-print`),
// which takes a shared host-lock slot and sets GATE_OUT_DIR.
//
// Fullscreen is a window resize (no requestFullscreen anywhere in the app), print is the canonical SVG (index.css hides
// canvases), and the layers presets drive the same toggles as the census; so this is one page driven through viewport
// changes, a DPR change, a gesture in flight, the print events and the 12 layers presets, judged against the SVG arm of
// the same page and against the DOM:
//
//   resize.*         shrink, grow, tiny, back: the canvas covers the svg exactly, its backing store is css x min(dpr, 2),
//                    the GPU frame becomes current again and stays within D1 of the SVG on a light scene (layers whose
//                    goldens pass), and not worse than at the start.
//   dpr.*            Emulation.setDeviceMetricsOverride to dpr 1 and back to 2 (a window dragged between displays): the
//                    backing store must follow devicePixelRatio. A renderer that never re-reads the ratio keeps a stale
//                    backing store: reported as the KNOWN GAP below, a hard failure with RESIZE_STRICT=1.
//   gesture.*        a drag-pan and a wheel zoom in flight when the window is resized: no page error, the gesture ends, the
//                    camera ends where d3 says it is (the svg transform), and the frame is current and within D1.
//   print.*          beforeprint with the GPU camera ahead of the SVG (a wheel zoom just ended): the svg transform is synced to
//                    the camera and the canvas is hidden (hiddenReason "printing"); afterprint brings the frame back. The
//                    print media rule hides the canvas. A real page.pdf() is taken and must have run beforeprint/afterprint.
//   preset.*         row 39 "presets": every built-in layers preset applied through #layersPreset (handleLayersPresetChange):
//                    the buttons match the preset, every layer's five views agree (class, display, GPU layer report, GPU state),
//                    the GPU is current, and for a few presets the refined frame is within the smoke floor of the SVG.
//
// KNOWN GAPS (reported as INFO unless RESIZE_STRICT=1; each names the code that owns the fix):
//   dpr-change-backing  src/gpu/renderer.ts resize() runs only on a svg size change or a window "resize" event, so a pure
//                       devicePixelRatio change leaves the backing store at the old ratio.
//
// Environment (gate.ts maps its arguments onto these):
//   RESIZE_MAP        parity .map (default tests/fixtures/parity/parity-v1.map)
//   RESIZE_DPR        1 | 2: the starting ratio                                                   default 2
//   RESIZE_LAUNCHER   metal | swiftshader                                                         default metal
//   RESIZE_STEPS      comma list of resize, dpr, gesture, print, preset                          default all
//   RESIZE_PRESETS    comma list of layers presets for the preset step                            default all 12
//   RESIZE_FRAME_PRESETS  presets whose refined frame is compared with the SVG                    default political,biomes,heightmap
//   RESIZE_PRESET_SSIM    smoke floor for a preset's whole frame (labels, markers and burgs have open golden gaps)   default 0.80
//   RESIZE_STRICT     1: known gaps fail the check
//   RESIZE_BREAK      none | no-resize | no-print | all: self-test. no-resize stops the renderer's resize handling, no-print
//                     stops its print hooks; the run must FAIL on the resize.* / dpr.* / print.* checks
// Output in GATE_OUT_DIR: resize-print.json (report; `failure` null on a pass) and PNGs of failing frames.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rgbDiff, ssim } from "../fidelity-metrics.ts";
import { encodePng } from "../png.ts";
import { heatmap } from "../golden-metrics.ts";
import { FAMILIES } from "./golden-families.ts";
import { captureArms, decode, gpuProbe, launch, layerFacts, loadParity, openPage, parityFixture, serveDist, settleApp, settleFades, waitCurrent, zoomTo, type Sink } from "./census-lib.ts";
import {
  type Check,
  failureSummary,
  fail,
  info,
  judgeFrameAfter,
  judgeGeometry,
  judged,
  pass,
  type FrameMetrics,
  gpuCount
} from "./census-core.ts";

const env = process.env;
const outDir = join(env.GATE_OUT_DIR || process.cwd());
const dpr0 = Number(env.RESIZE_DPR || 2);
if (dpr0 !== 1 && dpr0 !== 2) throw Error("RESIZE_DPR must be 1 or 2");
const steps = (env.RESIZE_STEPS || "resize,dpr,gesture,print,preset").split(",").map(s => s.trim()).filter(Boolean);
for (const s of steps) if (!["resize", "dpr", "gesture", "print", "preset"].includes(s)) throw Error(`RESIZE_STEPS: unknown step ${s}`);
const strict = env.RESIZE_STRICT === "1";
const breakMode = env.RESIZE_BREAK || "none";
if (!["none", "no-resize", "no-print", "all"].includes(breakMode)) throw Error("RESIZE_BREAK must be none|no-resize|no-print|all");
const PRESETS = ["political", "cultural", "religions", "provinces", "biomes", "heightmap", "physical", "poi", "goods", "trade", "military", "emblems", "landmass"];
const presetList = (env.RESIZE_PRESETS || PRESETS.join(",")).split(",").map(s => s.trim()).filter(Boolean);
const framePresets = (env.RESIZE_FRAME_PRESETS || "political,biomes,heightmap").split(",").map(s => s.trim()).filter(Boolean);
const presetSsimFloor = Number(env.RESIZE_PRESET_SSIM || 0.8);
// The light scene: layers whose per-layer goldens pass D1 (rivers, routes, borders, lakes, relief, biomes ...), so a
// whole-frame D1 check measures the resize and not an open fidelity gap of labels, burgs or markers.
const LIGHT = ["biomes", "rivers", "routes", "borders", "lakes", "relief"];

const started = Date.now();
const log = (message: string) => process.stderr.write(`[resize-print ${Math.round((Date.now() - started) / 1000)}s] ${message}\n`);
const sink: Sink = { errors: [], warnings: [] };
const checks: Check[] = [];
const report: any = {
  schema: 1,
  check: "resize-print",
  config: { dpr: dpr0, steps, strict, break: breakMode, presets: presetList, framePresets, presetSsimFloor, lightScene: LIGHT },
  frames: [] as any[],
  presets: [] as any[],
  print: null as any,
  knownGaps: [] as string[],
  checks,
  errors: sink.errors,
  warnings: sink.warnings,
  failure: null as string | null
};
const write = () => writeFileSync(join(outDir, "resize-print.json"), `${JSON.stringify(report, null, 2)}\n`);
const add = (c: Check) => {
  checks.push(c);
  log(`${c.status} ${c.id}${c.status === "PASS" ? "" : ` :: ${c.detail.slice(0, 240)}`}`);
};
// A known gap is INFO (with its name in report.knownGaps) unless RESIZE_STRICT=1, when it is the failure it describes.
const gap = (name: string, id: string, row: string, problems: string[], okDetail: string) => {
  if (!problems.length) return add(pass(id, row, okDetail));
  report.knownGaps.push(name);
  add(strict ? fail(id, row, problems.join("; ")) : info(id, row, `KNOWN GAP ${name}: ${problems.join("; ")}`));
};

const frameMetrics = (svg: Buffer, gpu: Buffer): FrameMetrics => {
  const a = decode(svg);
  const b = decode(gpu);
  const d = rgbDiff(a, b);
  return { ssim: ssim(a, b).ssim, over16Fraction: d.over16Fraction, changedFraction: d.changedFraction };
};

const served = await serveDist();
const { browser, launcher } = await launch(env.RESIZE_LAUNCHER);
report.config.launcher = launcher;
try {
  mkdirSync(outDir, { recursive: true });
  const fixture = parityFixture(env.RESIZE_MAP);
  report.config.fixture = { path: fixture.path, sha256: fixture.sha256 };
  const opened = await openPage(browser, served.origin, { dpr: dpr0, renderer: "gpu", launcher, sink, label: "gpu" });
  const { page, context } = opened;
  report.adapter = opened.adapter;
  const cdp = await context.newCDPSession(page);

  const problems0 = await loadParity(page, fixture);
  for (const p of problems0) sink.warnings.push(p);
  const lightScene = async () => {
    const r = await page.evaluate(a => (globalThis as any).__tupaia.call("display", a), { only: LIGHT });
    if (!r.ok) throw Error(`display only ${LIGHT}: ${JSON.stringify(r).slice(0, 300)}`);
    await settleApp(page);
  };
  await lightScene();
  await page.evaluate(zoomTo, { k: 1 });
  const first = await waitCurrent(page);
  if (first.active !== "gpu" || first.timedOut) throw Error(`no GPU frame to start from: ${JSON.stringify(first)}`);

  if (breakMode === "no-resize" || breakMode === "all") await page.evaluate(() => ((globalThis as any).gpuRenderer.resize = () => {}));
  if (breakMode === "no-print" || breakMode === "all")
    await page.evaluate(() => {
      const r = (globalThis as any).gpuRenderer;
      r.syncSvgCamera = () => {};
      r.hide = () => {};
    });

  // geometry + frame at the current window, judged against the SVG arm of the same page
  const measure = async (label: string, dpr: number) => {
    const wait = await waitCurrent(page);
    const probe = await page.evaluate(gpuProbe);
    const shots = await captureArms(page);
    const m = frameMetrics(shots.svg, shots.gpu);
    const geometry = judgeGeometry(
      probe.canvas && { cssW: parseFloat(probe.canvas.cssW), cssH: parseFloat(probe.canvas.cssH), w: probe.canvas.w, h: probe.canvas.h, left: probe.canvas.left, top: probe.canvas.top },
      probe.svg,
      dpr
    );
    report.frames.push({ label, dpr, inner: probe.inner, svg: probe.svg, canvas: probe.canvas, ...m, prepares: probe.prepares, wait });
    return { wait, probe, shots, metrics: m, geometry };
  };
  const evidence = (label: string, shots: { svg: Buffer; gpu: Buffer }) => {
    const base = join(outDir, label.replace(/[^\w-]+/g, "_"));
    writeFileSync(`${base}-svg.png`, shots.svg);
    writeFileSync(`${base}-gpu.png`, shots.gpu);
    writeFileSync(`${base}-diff.png`, encodePng(heatmap(decode(shots.svg), decode(shots.gpu))));
    return `${label.replace(/[^\w-]+/g, "_")}-diff.png`;
  };

  const base = await measure("start", dpr0);
  const baseProblems = judgeFrameAfter({ label: "start", before: base.metrics, after: base.metrics, gpu: base.wait });
  if (baseProblems.length || base.geometry.length) throw Error(`the starting frame is not a valid probe: ${[...baseProblems, ...base.geometry].join("; ")}`);
  add(pass("resize.start", "39", `light scene: SSIM ${base.metrics.ssim.toFixed(4)}, over16 ${(base.metrics.over16Fraction * 100).toFixed(3)}%, canvas ${base.probe.canvas?.w}x${base.probe.canvas?.h} at dpr ${dpr0}`));

  // ================================================================= window resizes
  if (steps.includes("resize")) {
    const sizes: Array<[string, number, number]> = [
      ["shrink", 900, 560],
      ["grow", 1600, 900],
      ["tiny", 480, 320],
      ["restore", 1280, 720]
    ];
    for (const [name, width, height] of sizes) {
      const before = await page.evaluate(gpuProbe);
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(150);
      await settleApp(page);
      const m = await measure(`resize-${name}`, dpr0);
      const problems = [...m.geometry, ...judgeFrameAfter({ label: name, before: base.metrics, after: m.metrics, gpu: m.wait })];
      const ev = problems.length ? evidence(`resize-${name}`, m.shots) : undefined;
      add(judged(`resize.${name}`, "39", problems, `${width}x${height}: canvas ${m.probe.canvas?.w}x${m.probe.canvas?.h}, SSIM ${m.metrics.ssim.toFixed(4)}, over16 ${(m.metrics.over16Fraction * 100).toFixed(3)}%, ${m.probe.prepares - before.prepares} prepare(s)`, ev));
    }
    write();
  }

  // ================================================================= DPR change
  if (steps.includes("dpr")) {
    const targets = dpr0 === 2 ? [1, 2] : [2, 1];
    for (const target of targets) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: target, mobile: false });
      await page.waitForTimeout(400);
      await settleApp(page);
      const m = await measure(`dpr-${target}`, target);
      // the page screenshots are taken at the new ratio; the GPU frame must be current and match the SVG at it
      const frameProblems = judgeFrameAfter({ label: `dpr ${target}`, before: base.metrics, after: m.metrics, gpu: m.wait });
      const ev = m.geometry.length || frameProblems.length ? evidence(`dpr-${target}`, m.shots) : undefined;
      gap("dpr-change-backing", `dpr.${target}.geometry`, "39", m.geometry, `backing store follows devicePixelRatio ${target}: ${m.probe.canvas?.w}x${m.probe.canvas?.h}`);
      add(judged(`dpr.${target}.frame`, "39", frameProblems, `dpr ${target}: SSIM ${m.metrics.ssim.toFixed(4)}, over16 ${(m.metrics.over16Fraction * 100).toFixed(3)}%`, ev));
    }
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(300);
    await settleApp(page);
    write();
  }

  // ================================================================= resize mid-gesture
  if (steps.includes("gesture")) {
    const readCamera = () =>
      page.evaluate(() => {
        const w = globalThis as any;
        const t = w.d3.zoomTransform(document.getElementById("map"));
        const attr = document.querySelector("#viewbox")!.getAttribute("transform") || "";
        const m = /translate\(([-\d.e]+)[ ,]+([-\d.e]+)\)\s*scale\(([-\d.e]+)\)/.exec(attr);
        return { d3: { k: t.k, x: t.x, y: t.y }, attr: m ? { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) } : null };
      });
    const near = (a: number, b: number) => Math.abs(a - b) < 0.01 * Math.max(1, Math.abs(b));
    // a zoomed view first, so a pan has somewhere to go
    await page.evaluate(zoomTo, { k: 2.4 });
    await waitCurrent(page);
    // --- drag-pan in flight
    {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.mouse.move(640, 360);
      await page.mouse.down();
      for (let i = 1; i <= 6; i++) await page.mouse.move(640 + i * 14, 360 + i * 6);
      await page.setViewportSize({ width: 1000, height: 620 });
      for (let i = 7; i <= 12; i++) await page.mouse.move(640 + i * 14, 360 + i * 6);
      await page.mouse.up();
      await page.waitForTimeout(300);
      await settleApp(page);
      const cam = await readCamera();
      const m = await measure("gesture-pan", dpr0);
      const problems = [
        ...(cam.attr ? [] : ["the svg transform is unreadable"]),
        ...(cam.attr && !(near(cam.attr.k, cam.d3.k) && near(cam.attr.x, cam.d3.x) && near(cam.attr.y, cam.d3.y)) ? [`svg transform ${JSON.stringify(cam.attr)} != d3 camera ${JSON.stringify(cam.d3)}`] : []),
        ...(m.probe.moving ? ["the gesture never ended"] : []),
        ...m.geometry,
        ...judgeFrameAfter({ label: "after pan", before: base.metrics, after: m.metrics, gpu: m.wait })
      ];
      add(judged("gesture.pan-resize", "39", problems, `drag-pan with a resize in flight: camera ${cam.d3.k.toFixed(2)} at ${cam.d3.x.toFixed(0)},${cam.d3.y.toFixed(0)} in both, SSIM ${m.metrics.ssim.toFixed(4)}`, problems.length ? evidence("gesture-pan", m.shots) : undefined));
    }
    // --- wheel zoom in flight
    {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.waitForTimeout(200);
      await page.mouse.move(640, 360);
      for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120);
      await page.setViewportSize({ width: 1100, height: 700 });
      for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -120);
      await page.waitForTimeout(500);
      await settleApp(page);
      const cam = await readCamera();
      const m = await measure("gesture-wheel", dpr0);
      const problems = [
        ...(cam.attr && !(near(cam.attr.k, cam.d3.k) && near(cam.attr.x, cam.d3.x) && near(cam.attr.y, cam.d3.y)) ? [`svg transform ${JSON.stringify(cam.attr)} != d3 camera ${JSON.stringify(cam.d3)}`] : []),
        ...m.geometry,
        ...judgeFrameAfter({ label: "after wheel", before: base.metrics, after: m.metrics, gpu: m.wait })
      ];
      add(judged("gesture.wheel-resize", "39", problems, `wheel zoom with a resize in flight: camera ${cam.d3.k.toFixed(2)} in both, SSIM ${m.metrics.ssim.toFixed(4)}`, problems.length ? evidence("gesture-wheel", m.shots) : undefined));
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(300);
    await page.evaluate(zoomTo, { k: 1 });
    await waitCurrent(page);
    write();
  }

  // ================================================================= print
  if (steps.includes("print")) {
    await page.evaluate(() => {
      const w = globalThis as any;
      w.__printEvents = [];
      for (const type of ["beforeprint", "afterprint"]) window.addEventListener(type, () => w.__printEvents.push({ type, t: performance.now() }));
    });
    const cameraState = () =>
      page.evaluate(() => {
        const w = globalThis as any;
        const t = w.d3.zoomTransform(document.getElementById("map"));
        const attr = document.querySelector("#viewbox")!.getAttribute("transform") || "";
        const m = /translate\(([-\d.e]+)[ ,]+([-\d.e]+)\)\s*scale\(([-\d.e]+)\)/.exec(attr);
        const canvas = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
        return {
          d3: { k: t.k, x: t.x, y: t.y },
          attr: m ? { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) } : null,
          canvasDisplay: canvas ? getComputedStyle(canvas).display : null,
          hiddenReason: w.rendererStatus?.()?.gpu?.hiddenReason ?? null
        };
      });
    const near = (a: number, b: number) => Math.abs(a - b) < 0.01 * Math.max(1, Math.abs(b));
    // GPU camera ahead of the SVG: a wheel zoom, then print before the exact settle frame writes the svg transform
    await page.mouse.move(640, 360);
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -120);
    await page.waitForTimeout(40);
    const ahead = await cameraState();
    await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
    const during = await cameraState();
    await page.waitForTimeout(150);
    const duringLater = await cameraState();
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    const afterWait = await waitCurrent(page, 120000, false);
    const after = await cameraState();
    const problems: string[] = [];
    if (!during.attr) problems.push("beforeprint: the svg transform is unreadable");
    else if (!(near(during.attr.k, during.d3.k) && near(during.attr.x, during.d3.x) && near(during.attr.y, during.d3.y))) problems.push(`beforeprint: svg transform ${JSON.stringify(during.attr)} was not synced to the camera ${JSON.stringify(during.d3)}`);
    if (during.canvasDisplay !== "none") problems.push(`beforeprint: the GPU canvas is ${during.canvasDisplay}, not hidden`);
    if (duringLater.canvasDisplay !== "none") problems.push(`while printing: the GPU canvas came back (${duringLater.canvasDisplay}) before afterprint`);
    if (during.hiddenReason !== "printing") problems.push(`beforeprint: hiddenReason is "${during.hiddenReason}", not "printing"`);
    if (afterWait.active !== "gpu" || afterWait.timedOut) problems.push("afterprint: the GPU did not come back");
    if (after.canvasDisplay === "none") problems.push("afterprint: the GPU canvas is still hidden");
    if (after.hiddenReason) problems.push(`afterprint: hiddenReason is still "${after.hiddenReason}"`);
    add(judged("print.events", "39", problems, `beforeprint synced the svg camera (k ${during.d3.k.toFixed(2)}) and hid the canvas; afterprint restored the frame`));
    report.print = { ahead, during, duringLater, after };

    // the print media rule: index.css hides every canvas
    await page.emulateMedia({ media: "print" });
    const printCss = await page.evaluate(() => {
      const canvas = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
      const svg = document.querySelector("svg#map") as SVGSVGElement;
      return { canvas: canvas ? getComputedStyle(canvas).display : null, svg: getComputedStyle(svg).display };
    });
    await page.emulateMedia({ media: null });
    // The inline display style the renderer sets beats index.css's `@media print { canvas { display: none } }`, so the media
    // rule alone does not hide the canvas: printing relies on the beforeprint hook (print.events, print.pdf), which hides it.
    // Reported as information; svg#map must stay visible either way.
    if (printCss.svg === "none") add(fail("print.media", "39", "@media print: svg#map is hidden"));
    else add(info("print.media", "39", `NOTE the @media print rule does not hide the GPU canvas by itself (display:${printCss.canvas}: inline style wins); print is protected by the beforeprint hook, asserted by print.events and print.pdf`));

    // a real print job: Chromium's PDF printer runs beforeprint / afterprint around the layout
    await page.evaluate(() => ((globalThis as any).__printEvents.length = 0));
    let pdf: Buffer | null = null;
    let pdfError = "";
    try {
      pdf = await page.pdf({ printBackground: true, preferCSSPageSize: false });
    } catch (error) {
      pdfError = String(error).slice(0, 200);
    }
    const events: Array<{ type: string }> = await page.evaluate(() => (globalThis as any).__printEvents);
    const pdfProblems: string[] = [];
    if (!pdf) pdfProblems.push(`page.pdf failed: ${pdfError}`);
    else {
      if (pdf.length < 5000) pdfProblems.push(`the PDF is only ${pdf.length} bytes`);
      writeFileSync(join(outDir, "print.pdf"), pdf);
    }
    const order = events.map(e => e.type).join(",");
    if (pdf && order !== "beforeprint,afterprint") pdfProblems.push(`print job fired [${order || "no events"}], expected beforeprint,afterprint`);
    const afterPdf = await waitCurrent(page, 120000, false);
    if (afterPdf.active !== "gpu" || afterPdf.timedOut) pdfProblems.push("after the print job the GPU is not current");
    const canvasAfter = await cameraState();
    if (canvasAfter.canvasDisplay === "none") pdfProblems.push("after the print job the GPU canvas is still hidden");
    add(judged("print.pdf", "39", pdfProblems, `page.pdf produced ${pdf?.length ?? 0} bytes with beforeprint,afterprint around it; the GPU is back`));
    report.print.pdf = { bytes: pdf?.length ?? 0, events: order };
    write();
  }

  // ================================================================= layers presets
  if (steps.includes("preset")) {
    // all layers on first, so every preset really changes the toggles and the layer report has the full set to compare
    await page.evaluate(isolateRestore);
    const presetIds: Record<string, string[]> = await page.evaluate(() => JSON.parse(JSON.stringify((0, eval)("presets"))));
    const unknown = presetList.filter(p => !presetIds[p]);
    if (unknown.length) throw Error(`unknown layers presets ${unknown.join(", ")}; the app has ${Object.keys(presetIds).join(", ")}`);
    // button id -> family (layer id, root?) for the views of every layer
    const BUTTON_LAYER: Record<string, { id: string; root: boolean }> = {};
    const BRIDGE: Record<string, string> = { texture: "toggleTexture", heightmap: "toggleHeight", lakes: "toggleLakes", biomes: "toggleBiomes", cells: "toggleCells", grid: "toggleGrid", coordinates: "toggleCoordinates", compass: "toggleCompass", rivers: "toggleRivers", relief: "toggleRelief", religions: "toggleReligions", cultures: "toggleCultures", states: "toggleStates", provinces: "toggleProvinces", zones: "toggleZones", borders: "toggleBorders", routes: "toggleRoutes", temperature: "toggleTemperature", ice: "toggleIce", goods: "toggleGoods", markets: "toggleMarketsLayer", precipitation: "togglePrecipitation", population: "togglePopulation", emblems: "toggleEmblems", burgs: "toggleBurgIcons", labels: "toggleLabels", military: "toggleMilitary", markers: "toggleMarkers", rulers: "toggleRulers", scaleBar: "toggleScaleBar", vignette: "toggleVignette" };
    for (const f of FAMILIES) if (f.toggle && BRIDGE[f.toggle]) BUTTON_LAYER[BRIDGE[f.toggle]] = { id: f.id, root: !!f.root };
    // what the layer report holds with everything on: a masked layer keeps its mask shapes after it is emptied, so an
    // off layer must report fewer elements than this (a root overlay: none), not necessarily zero
    await settleApp(page);
    await waitCurrent(page, 120000, false);
    const allOn: Record<string, number> = {};
    for (const [button, layer] of Object.entries(BUTTON_LAYER)) allOn[button] = gpuCount(await page.evaluate(layerFacts, { id: layer.id, root: layer.root }), layer.root);
    report.presetBaseline = allOn;
    for (const preset of presetList) {
      const wantOn = new Set(presetIds[preset]);
      const t0 = Date.now();
      await page.evaluate(p => {
        const select = document.getElementById("layersPreset") as HTMLSelectElement;
        select.value = p;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }, preset);
      await settleFades(page, 1300);
      await settleApp(page);
      const wait = await waitCurrent(page, 120000, framePresets.includes(preset));
      const probe = await page.evaluate(gpuProbe);
      const buttons: Record<string, boolean> = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#mapLayers > li")].map(li => [li.id, !li.classList.contains("buttonoff")])));
      const problems: string[] = [];
      const wrong = Object.entries(buttons).filter(([id, on]) => on !== wantOn.has(id));
      if (wrong.length) problems.push(`class: ${wrong.map(([id, on]) => `${id} is ${on ? "on" : "off"}`).slice(0, 6).join(", ")} against the preset`);
      const select = await page.evaluate(() => (document.getElementById("layersPreset") as HTMLSelectElement).value);
      if (select !== preset) problems.push(`the select reads "${select}"`);
      for (const [button, layer] of Object.entries(BUTTON_LAYER)) {
        const facts = await page.evaluate(layerFacts, { id: layer.id, root: layer.root });
        const on = buttons[button];
        if (on === undefined) continue;
        if (on) {
          if (facts.present && facts.display !== "none" && (facts.drawables ?? 0) > 0 && gpuCount(facts, layer.root) === 0) problems.push(`${button}: on and drawn in the SVG, but the GPU reports no element`);
        } else {
          if (facts.present && (facts.drawables ?? 0) > 0 && facts.display !== "none" && facts.visibility !== "hidden") problems.push(`${button}: off but ${facts.drawables} drawable(s) visible in the SVG`);
          const n = gpuCount(facts, layer.root);
          if (layer.root ? n > 0 : n > 0 && n >= (allOn[button] ?? 0)) problems.push(`${button}: off but the GPU still reports ${n} element(s)${layer.root ? "" : ` (${allOn[button]} with everything on)`}`);
        }
      }
      if (wait.active !== "gpu") problems.push(`GPU not active (${wait.fallbackReason ?? "no frame"})`);
      else if (wait.timedOut) problems.push("GPU frame did not become current within 120 s");
      let metrics: FrameMetrics | null = null;
      let ev: string | undefined;
      if (framePresets.includes(preset) && wait.active === "gpu") {
        const shots = await captureArms(page);
        metrics = frameMetrics(shots.svg, shots.gpu);
        if (metrics.ssim < presetSsimFloor) {
          problems.push(`whole-frame SSIM ${metrics.ssim.toFixed(4)} < smoke floor ${presetSsimFloor}`);
          ev = evidence(`preset-${preset}`, shots);
        }
      }
      report.presets.push({ preset, on: [...wantOn].length, ms: Date.now() - t0, metrics, hiddenReason: probe.hiddenReason, prepares: probe.prepares });
      add(judged(`preset.${preset}`, "39", problems, `${[...wantOn].length} layers on, views agree${metrics ? `, SSIM ${metrics.ssim.toFixed(3)}, over16 ${(metrics.over16Fraction * 100).toFixed(2)}% (smoke floor ${presetSsimFloor}, not D1)` : ""}`, ev));
      write();
    }
  }

  const validation = sink.warnings.some(w => /GL_INVALID_|Feedback loop/i.test(w));
  if (sink.errors.length) add(fail("run.page-errors", "39", `${sink.errors.length} page error(s): ${sink.errors[0].slice(0, 200)}`));
  else add(pass("run.page-errors", "39", "no page errors"));
  if (validation) add(fail("run.webgl-validation", "39", "WebGL validation warning; reject the render result"));
} catch (error) {
  report.failure = `harness: ${error instanceof Error ? error.stack : String(error)}`;
  sink.errors.push(String(error));
} finally {
  report.summary = {
    checks: checks.length,
    pass: checks.filter(c => c.status === "PASS").length,
    fail: checks.filter(c => c.status === "FAIL").length,
    info: checks.filter(c => c.status === "INFO").length,
    knownGaps: report.knownGaps,
    seconds: Math.round((Date.now() - started) / 1000)
  };
  report.failure ??= failureSummary(checks);
  write();
  log(report.failure ? `FAIL ${report.failure.slice(0, 400)}` : `PASS ${checks.length} checks`);
  await browser.close();
  await served.close();
}

// page function: put every layer back on (the light scene hid most of them) before the preset step
function isolateRestore(): Promise<unknown> {
  const w = globalThis as any;
  return w.__tupaia.call("display", { on: ["texture", "heightmap", "biomes", "cells", "grid", "coordinates", "compass", "rivers", "relief", "religions", "cultures", "states", "provinces", "zones", "borders", "routes", "temperature", "ice", "goods", "markets", "precipitation", "population", "emblems", "burgs", "labels", "military", "markers", "rulers", "scaleBar", "vignette", "lakes"] });
}
