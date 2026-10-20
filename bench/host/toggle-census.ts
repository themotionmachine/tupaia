// Toggle census, layer-reorder golden and trade round trip (REWRITE-PLAN §5 rows 26 and 27; gate gap 11). Run it through
// bench/gate/gate.ts (`gate toggles`), which takes a shared host-lock slot and sets GATE_OUT_DIR.
//
// Row 26 says layer toggles are native visibility flags with ~40 side effects untouched. What was built is an observer:
// the SVG stays authoritative and a toggle is a DOM mutation, so the GPU frame must follow the DOM. This census proves it
// for every `#mapLayers > li` button (the 31 family layers and Trade), by clicking the real button:
//
//   isolated pass  one family visible alone (golden isolation), off then on: the five views plus the pixels, and the
//                  committed prepares and invalidations the click caused (a budget, TOGGLE_BUDGET). After each
//                  click the GPU arm and the SVG arm are captured from the same DOM state. Off: neither paints the layer.
//                  On: both paint it, the GPU with at least TOGGLE_BUDGET.onInkRatioMin of the SVG's ink (a coherence
//                  floor), and the full golden verdict of that cell is reported alongside (TOGGLE_STRICT=1 gates on it
//                  too). The on-state is also gated on fidelity (toggle.<layer>.on-fidelity): the GPU against the SVG
//                  for the isolated layer is captured BEFORE the off click, and after the round trip it must look the
//                  same (judgeOnStateFidelity: D1 when the baseline is inside it, otherwise no worse, plus a tight
//                  layer-scoped margin). Both comparisons are GPU against SVG, never GPU against GPU.
//   cost pass      opt-in (TOGGLE_PASSES=cost): the whole scene, every layer on, off then on per toggle: prepares and the
//                  click-to-current-frame time in the real scene (a timing, so run it under the exclusive lock).
//   trade          Trade off -> save -> `data-layer-off` in the saved SVG -> load -> still off, no markers, no animation;
//                  then on -> markers come back and the GPU mirrors the DOM markers.
//   reorder        row 27: moveLayer on overlapping pairs; the SVG frame must visibly change, the GPU frame must follow it,
//                  and GPU against SVG after the move must still be within D1 (SSIM >= 0.95, over16 <= 1%).
//
// Environment (gate.ts maps its arguments onto these):
//   TOGGLE_MAP        parity .map (default tests/fixtures/parity/parity-v1.map)
//   TOGGLE_DPR        1 | 2                                                    default 2
//   TOGGLE_LAUNCHER   metal | swiftshader                                      default metal
//   TOGGLE_ONLY       comma list of bridge layer names (default all)
//   TOGGLE_PASSES     comma list of isolated, trade, reorder, cost              default isolated,trade,reorder
//                     (cost: the whole scene, every layer on; the click-to-frame times are timings, so it is opt-in and
//                     belongs under the exclusive lock; the prepares per toggle are also recorded by the isolated pass)
//   TOGGLE_READING    conservative | over44: the golden reading reported / gated with TOGGLE_STRICT
//   TOGGLE_STRICT     1: a failing golden verdict of an on-state cell fails the check (default: reported only)
//   TOGGLE_BREAK      none | freeze-gpu | perturb-on: self-test, the run must FAIL.
//                     freeze-gpu: the GPU stops following DOM mutations (the off/on state checks fail).
//                     perturb-on: after the layer is turned back on, the GPU canvas alone is drawn hue-rotated (a layer
//                     redrawn with wrong fills; white and grey are untouched, so the backdrop and every stroke stay in place): the footprint is right, the pixels are wrong, only toggle.<layer>.on-fidelity
//                     can see it. (Not an opacity change: the SVG shows through a translucent canvas, which would improve the match.)
// Output in GATE_OUT_DIR: toggles.json (report; `failure` null on a pass) and PNGs of failing cells.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { measureCell, judgeCell, heatmap, type Reading } from "../golden-metrics.ts";
import { encodePng } from "../png.ts";
import { FAMILIES } from "./golden-families.ts";
import { captureArms, decode, gpuProbe, isolateLayers, launch, layerFacts, loadParity, openPage, parityFixture, serveDist, settleApp, settleFades, waitCurrent, zoomTo, type Sink } from "./census-lib.ts";
import {
  type Check,
  type ToggleObservation,
  failureSummary,
  fail,
  info,
  gpuCount,
  judgePrepares,
  judgeOnStateFidelity,
  judgeReorder,
  judgeToggleOff,
  judgeToggleOn,
  judged,
  pass,
  TOGGLE_BUDGET
} from "./census-core.ts";

const env = process.env;
const outDir = join(env.GATE_OUT_DIR || process.cwd());
const dpr = Number(env.TOGGLE_DPR || 2);
if (dpr !== 1 && dpr !== 2) throw Error("TOGGLE_DPR must be 1 or 2");
const reading = (env.TOGGLE_READING || "conservative") as Reading;
const strict = env.TOGGLE_STRICT === "1";
const breakMode = env.TOGGLE_BREAK || "none";
if (!["none", "freeze-gpu", "perturb-on"].includes(breakMode)) throw Error("TOGGLE_BREAK must be none|freeze-gpu|perturb-on");
const passes = (env.TOGGLE_PASSES || "isolated,trade,reorder").split(",").map(s => s.trim()).filter(Boolean);
for (const p of passes) if (!["cost", "isolated", "trade", "reorder"].includes(p)) throw Error(`TOGGLE_PASSES: unknown pass ${p}`);

// bridge layer name -> the #mapLayers button (mcp/src/bridge.js LAYERS)
const BUTTON: Record<string, string> = {
  texture: "toggleTexture", heightmap: "toggleHeight", lakes: "toggleLakes", biomes: "toggleBiomes", cells: "toggleCells",
  grid: "toggleGrid", coordinates: "toggleCoordinates", compass: "toggleCompass", rivers: "toggleRivers", relief: "toggleRelief",
  religions: "toggleReligions", cultures: "toggleCultures", states: "toggleStates", provinces: "toggleProvinces", zones: "toggleZones",
  borders: "toggleBorders", routes: "toggleRoutes", temperature: "toggleTemperature", ice: "toggleIce", goods: "toggleGoods",
  markets: "toggleMarketsLayer", trade: "toggleTrade", precipitation: "togglePrecipitation", population: "togglePopulation",
  emblems: "toggleEmblems", burgs: "toggleBurgIcons", labels: "toggleLabels", military: "toggleMilitary", markers: "toggleMarkers",
  rulers: "toggleRulers", scaleBar: "toggleScaleBar", vignette: "toggleVignette"
};
// d3 transitions the page cannot report (precipitation removes its circles after a 1 s transition)
const EXTRA_MS: Record<string, number> = { precipitation: 1300 };

interface Toggle {
  name: string;
  button: string;
  layerId: string | null; // null: not a golden family (trade)
  root: boolean;
}
const TOGGLES: Toggle[] = Object.entries(BUTTON).map(([name, button]) => {
  const family = FAMILIES.find(f => f.toggle === name);
  return { name, button, layerId: family?.id ?? null, root: !!family?.root };
});
const only = (env.TOGGLE_ONLY || "").split(",").map(s => s.trim()).filter(Boolean);
for (const name of only) if (!BUTTON[name]) throw Error(`TOGGLE_ONLY: unknown layer ${name}; one of ${Object.keys(BUTTON).join(", ")}`);
const selected = TOGGLES.filter(t => !only.length || only.includes(t.name));

const started = Date.now();
const log = (message: string) => process.stderr.write(`[toggles ${Math.round((Date.now() - started) / 1000)}s] ${message}\n`);
const sink: Sink = { errors: [], warnings: [] };
const checks: Check[] = [];
const report: any = {
  schema: 1,
  check: "toggles",
  config: { dpr, reading, strict, break: breakMode, passes, toggles: selected.map(t => t.name), budget: TOGGLE_BUDGET },
  rows: { cost: [] as any[], isolated: [] as any[], trade: null as any, reorder: [] as any[] },
  checks,
  errors: sink.errors,
  warnings: sink.warnings,
  failure: null as string | null
};
const write = () => writeFileSync(join(outDir, "toggles.json"), `${JSON.stringify(report, null, 2)}\n`);
const add = (c: Check) => {
  checks.push(c);
  log(`${c.status} ${c.id}${c.status === "PASS" ? "" : ` :: ${c.detail.slice(0, 220)}`}`);
};

const served = await serveDist();
const { browser, launcher } = await launch(env.TOGGLE_LAUNCHER);
report.config.launcher = launcher;
try {
  mkdirSync(outDir, { recursive: true });
  const fixture = parityFixture(env.TOGGLE_MAP);
  report.config.fixture = { path: fixture.path, sha256: fixture.sha256 };
  const opened = await openPage(browser, served.origin, { dpr, renderer: "gpu", launcher, sink, label: "gpu" });
  const page = opened.page;
  report.adapter = opened.adapter;

  // ---- coverage: every #mapLayers button is in the census, every census row has a button and a toggle function
  const dom = await page.evaluate(() => [...document.querySelectorAll("#mapLayers > li")].map(li => ({ id: li.id, onclick: li.getAttribute("onclick") || "", fn: ((li.getAttribute("onclick") || "").match(/^(\w+)\(/) ?? [])[1] ?? "" })));
  const ids = new Set(dom.map(d => d.id));
  const known = new Set(Object.values(BUTTON));
  const missing = dom.filter(d => !known.has(d.id)).map(d => d.id);
  const dangling = Object.values(BUTTON).filter(id => !ids.has(id));
  const fnMissing = await page.evaluate((fns: string[]) => fns.filter(fn => typeof (globalThis as any)[fn] !== "function"), dom.map(d => d.fn).filter(Boolean));
  add(
    judged(
      "toggle.coverage",
      "26",
      [
        ...(missing.length ? [`#mapLayers buttons without a census row: ${missing.join(", ")}`] : []),
        ...(dangling.length ? [`census rows without a button: ${dangling.join(", ")}`] : []),
        ...(fnMissing.length ? [`onclick functions that are not defined: ${fnMissing.join(", ")}`] : [])
      ],
      `${dom.length} toggle buttons, each with a defined toggle function, all in the census`
    )
  );
  report.buttons = dom;

  const freeze = () =>
    page.evaluate(() => {
      const r = (globalThis as any).gpuRenderer;
      if (r) r.mutated = () => {}; // self-test: the GPU stops following DOM mutations
    });

  // wait=false: the caller isolates a few layers next, so the whole-scene prepare (the slow one) is not waited out
  const reload = async (label: string, wait: "none" | "current" | "refined" = "refined") => {
    const problems = await loadParity(page, fixture);
    for (const p of problems) sink.warnings.push(`${label}: ${p}`);
    await zoomTo0();
    if (wait === "none") return;
    const current = await waitCurrent(page, 120000, wait === "refined");
    if (current.active !== "gpu" || current.timedOut) throw Error(`${label}: GPU not current after the fixture load (${JSON.stringify(current)})`);
  };
  const zoomTo0 = () => page.evaluate(zoomTo, { k: 1 });

  // click the real button, wait for the app (fades, relief/burg renders) then for the GPU
  const click = async (t: Toggle) => {
    await page.evaluate(id => (document.getElementById(id) as HTMLElement).click(), t.button);
    await settleFades(page, EXTRA_MS[t.name] ?? 0);
    await settleApp(page);
  };
  const buttonOff = (t: Toggle) => page.evaluate(id => document.getElementById(id)!.classList.contains("buttonoff"), t.button);

  // ================================================================= cost pass: the whole scene
  if (passes.includes("cost")) {
    await reload("cost");
    if (breakMode === "freeze-gpu") await freeze();
    for (const t of selected) {
      const rows: any = { name: t.name };
      for (const step of ["off", "on"] as const) {
        const before = await page.evaluate(gpuProbe);
        const factsBefore = t.layerId ? await page.evaluate(layerFacts, { id: t.layerId, root: t.root }) : { present: true };
        const t0 = Date.now();
        await click(t);
        const clicked = Date.now() - t0;
        const wait = await waitCurrent(page);
        const after = await page.evaluate(gpuProbe);
        const facts = t.layerId ? await page.evaluate(layerFacts, { id: t.layerId, root: t.root }) : { present: true };
        const off = await buttonOff(t);
        const cost = { prepares: after.prepares - before.prepares, invalidations: after.invalidations - before.invalidations, lastPrepareMs: after.lastPrepareMs, currentMs: Date.now() - t0, reason: after.lastInvalidation, lastPrepare: after.lastPrepare };
        rows[step] = { buttonOff: off, facts, gpu: { active: wait.active, timedOut: wait.timedOut, state: after.state, hiddenReason: after.hiddenReason }, ...cost, clickMs: clicked };
        // the five views, without pixels (the whole scene is not isolated, so ink is judged in the isolated pass)
        if (t.layerId) {
          const obs: ToggleObservation = { name: t.name, buttonOff: off, facts, gpu: rows[step].gpu, inkSvg: null, inkGpu: null, inkRatio: null, root: t.root, beforeCount: gpuCount(factsBefore, t.root) };
          const problems = step === "off" ? judgeToggleOff(obs) : judgeToggleOn(obs);
          const prepareProblems = judgePrepares(cost);
          add(judged(`toggle.${t.name}.cost-${step}`, "26", [...problems, ...prepareProblems], `${cost.prepares} prepare(s), ${cost.invalidations} invalidation(s), current frame ${cost.currentMs} ms after the click`));
        } else {
          // trade: no family group; class + state + budget here, markers in the trade pass
          const problems = [...(off === (step === "on") ? [`class: buttonoff is ${off} after turning ${step}`] : []), ...(wait.active !== "gpu" ? [`GPU not active (${wait.active})`] : []), ...judgePrepares(cost)];
          add(judged(`toggle.${t.name}.cost-${step}`, "26", problems, `${cost.prepares} prepare(s), current frame ${cost.currentMs} ms after the click`));
        }
      }
      report.rows.cost.push(rows);
      write();
    }
    const totals = report.rows.cost.reduce((n: number, r: any) => n + (r.off?.prepares ?? 0) + (r.on?.prepares ?? 0), 0);
    const worst = [...report.rows.cost].sort((a: any, b: any) => Math.max(b.off?.currentMs ?? 0, b.on?.currentMs ?? 0) - Math.max(a.off?.currentMs ?? 0, a.on?.currentMs ?? 0))[0];
    add(info("toggle.cost.summary", "26", `${report.rows.cost.length} toggles, ${totals} committed prepares for ${report.rows.cost.length * 2} clicks; slowest to a current frame: ${worst?.name} ${Math.max(worst?.off?.currentMs ?? 0, worst?.on?.currentMs ?? 0)} ms`));
  }

  // ================================================================= isolated pass: pixels
  if (passes.includes("isolated")) {
    await reload("isolated", "none");
    if (breakMode === "freeze-gpu") await freeze();
    // the blank (every layer hidden) in both arms, at the same camera
    await page.evaluate(isolateLayers, { ids: [], bg: "#ffffff" });
    await settleApp(page);
    await page.evaluate(isolateLayers, { ids: [], bg: "#ffffff" });
    const blankWait = await waitCurrent(page);
    if (blankWait.active !== "gpu") throw Error(`isolated: no GPU blank (${JSON.stringify(blankWait)})`);
    const blanks = await captureArms(page);
    const blankSvg = decode(blanks.svg);
    const blankGpu = decode(blanks.gpu);
    const cellDir = join(outDir, "cells");
    mkdirSync(cellDir, { recursive: true });
    for (const t of selected) {
      if (!t.layerId) continue; // trade is covered by the trade pass
      const rows: any = { name: t.name };
      await page.evaluate(isolateLayers, { ids: [t.layerId], bg: "#ffffff" });
      await settleApp(page);
      await page.evaluate(isolateLayers, { ids: [t.layerId], bg: "#ffffff" });
      await waitCurrent(page);
      // the pre-toggle on-state, GPU against SVG: what the layer must look like again after the round trip
      const preShots = await captureArms(page);
      const preMetrics = measureCell(decode(preShots.svg), decode(preShots.gpu), blankSvg, blankGpu);
      rows.before = { ssim: preMetrics.ssim, over16: preMetrics.over16Fraction, over16OfInk: preMetrics.over16OfInk, inkRatio: preMetrics.inkRatio };
      for (const step of ["off", "on"] as const) {
        const before = await page.evaluate(gpuProbe);
        const factsBefore = await page.evaluate(layerFacts, { id: t.layerId, root: t.root });
        await click(t);
        await page.evaluate(isolateLayers, { ids: [t.layerId], bg: "#ffffff" });
        const wait = await waitCurrent(page);
        const after = await page.evaluate(gpuProbe);
        const facts = await page.evaluate(layerFacts, { id: t.layerId, root: t.root });
        const off = await buttonOff(t);
        if (breakMode === "perturb-on" && step === "on") await page.evaluate(() => ((document.querySelector("canvas[data-gpu-renderer]") as HTMLElement).style.filter = "hue-rotate(150deg)"));
        const shots = await captureArms(page);
        if (breakMode === "perturb-on" && step === "on") await page.evaluate(() => ((document.querySelector("canvas[data-gpu-renderer]") as HTMLElement).style.filter = ""));
        const svg = decode(shots.svg);
        const gpu = decode(shots.gpu);
        const metrics = measureCell(svg, gpu, blankSvg, blankGpu);
        const verdict = judgeCell({ metrics, census: facts.layer ? { native: facts.layer.native, compat: facts.layer.compat, skipped: 0 } : null, domDrawables: facts.drawables ?? 0, expected: null }, reading);
        const obs: ToggleObservation = {
          name: t.name,
          buttonOff: off,
          facts,
          gpu: { active: wait.active, fallbackReason: wait.fallbackReason, timedOut: wait.timedOut, state: after.state, hiddenReason: after.hiddenReason },
          inkSvg: metrics.inkSvg,
          inkGpu: metrics.inkGpu,
          inkRatio: metrics.inkRatio,
          root: t.root,
          beforeCount: gpuCount(factsBefore, t.root)
        };
        const problems = step === "off" ? judgeToggleOff(obs) : judgeToggleOn(obs);
        const goldenOk = step === "on" ? verdict.failures.length === 0 : null;
        const cost = { prepares: after.prepares - before.prepares, invalidations: after.invalidations - before.invalidations };
        problems.push(...judgePrepares({ ...cost, lastPrepareMs: after.lastPrepareMs, currentMs: wait.ms }));
        if (strict && step === "on" && verdict.failures.length) problems.push(`golden (${reading}): ${verdict.failures[0]}`);
        const bad = problems.length > 0;
        let images: Record<string, string> | undefined;
        if (bad) {
          const base = join(cellDir, `${t.name}-${step}`);
          writeFileSync(`${base}-svg.png`, shots.svg);
          writeFileSync(`${base}-gpu.png`, shots.gpu);
          writeFileSync(`${base}-diff.png`, encodePng(heatmap(svg, gpu)));
          images = { svg: `cells/${t.name}-${step}-svg.png`, gpu: `cells/${t.name}-${step}-gpu.png`, diff: `cells/${t.name}-${step}-diff.png` };
        }
        rows[step] = { obs, ssim: metrics.ssim, over16: metrics.over16Fraction, over44: metrics.over44Fraction, inkRatio: metrics.inkRatio, golden: step === "on" ? { pass: goldenOk, reading, failures: verdict.failures.slice(0, 3), gates: verdict.gates } : undefined, ...cost };
        add(judged(`toggle.${t.name}.${step}`, "26", problems, step === "off" ? `class, display, layer report, GPU and both arms agree the layer is gone; ${cost.prepares} prepare(s)` : `class, display, layer report, GPU and both arms agree; ink ratio ${metrics.inkRatio.toFixed(2)}, ssim ${metrics.ssim.toFixed(3)}, golden ${goldenOk ? "pass" : `fail (${verdict.failures[0] ?? "?"})`}; ${cost.prepares} prepare(s)`, images ? images.diff : undefined));
        if (step === "on") {
          // fidelity of the on-state after the round trip: GPU against SVG now vs before the first click (row 26)
          const fidelity = judgeOnStateFidelity({
            label: t.name,
            before: { ssim: preMetrics.ssim, over16Fraction: preMetrics.over16Fraction, over16OfInk: preMetrics.over16OfInk, inkRatio: preMetrics.inkRatio },
            after: { ssim: metrics.ssim, over16Fraction: metrics.over16Fraction, over16OfInk: metrics.over16OfInk, inkRatio: metrics.inkRatio },
            gpu: { active: wait.active, timedOut: wait.timedOut, fallbackReason: wait.fallbackReason }
          });
          rows.on.fidelity = fidelity;
          let evidence: string | undefined;
          if (fidelity.length) {
            const base = join(cellDir, `${t.name}-on-fidelity`);
            writeFileSync(`${base}-before-gpu.png`, preShots.gpu);
            writeFileSync(`${base}-after-gpu.png`, shots.gpu);
            writeFileSync(`${base}-svg.png`, shots.svg);
            writeFileSync(`${base}-diff.png`, encodePng(heatmap(svg, gpu)));
            evidence = `cells/${t.name}-on-fidelity-diff.png`;
          }
          add(judged(`toggle.${t.name}.on-fidelity`, "26", fidelity, `GPU against SVG after the round trip matches before it: ssim ${preMetrics.ssim.toFixed(4)} -> ${metrics.ssim.toFixed(4)}, over16 ${(preMetrics.over16Fraction * 100).toFixed(3)}% -> ${(metrics.over16Fraction * 100).toFixed(3)}%`, evidence));
        }
      }
      report.rows.isolated.push(rows);
      write();
    }
    await page.evaluate(isolateLayers, { ids: [], restore: true });
    const goldenFails = report.rows.isolated.filter((r: any) => r.on?.golden && !r.on.golden.pass).map((r: any) => r.name);
    add(info("toggle.golden.summary", "26", `golden verdict (${reading}) of the on-state cell after a toggle: ${report.rows.isolated.length - goldenFails.length}/${report.rows.isolated.length} pass${goldenFails.length ? `; failing: ${goldenFails.join(", ")} (fidelity gaps are the golden's; TOGGLE_STRICT=1 gates on them)` : ""}`));
  }

  // ================================================================= trade round trip
  if (passes.includes("trade")) {
    await reload("trade", "current");
    if (breakMode === "freeze-gpu") await freeze();
    const trade = TOGGLES.find(t => t.name === "trade")!;
    const probeTrade = () =>
      page.evaluate(() => {
        const w = globalThis as any;
        const layer = document.getElementById("tradeAnimation");
        const gpu = w.rendererStatus?.()?.gpu;
        return {
          buttonOff: document.getElementById("toggleTrade")!.classList.contains("buttonoff"),
          attr: layer?.getAttribute("data-layer-off") ?? null,
          markersDom: layer?.querySelectorAll(":scope > g").length ?? 0,
          markersGpu: gpu?.markers ?? 0,
          display: layer ? getComputedStyle(layer).display : null,
          active: w.rendererStatus?.()?.active ?? null
        };
      });
    // marker groups take a moment to appear after Trade starts
    const waitMarkers = async (want: boolean) => {
      for (let i = 0; i < 60; i++) {
        const t = await probeTrade();
        if (want ? t.markersDom > 0 : t.markersDom === 0) return t;
        await page.waitForTimeout(100);
      }
      return probeTrade();
    };
    const start = await waitMarkers(true);
    const problems: string[] = [];
    if (start.buttonOff) problems.push("the fixture starts with Trade off");
    if (start.markersDom === 0) problems.push("Trade is on but no marker is animating (the round trip would be vacuous)");
    await waitCurrent(page, 120000, false);
    const onGpu = await page.evaluate(gpuProbe);
    if (start.markersDom > 0 && onGpu.markers === 0) problems.push(`Trade on: ${start.markersDom} DOM markers but the GPU mirrors ${onGpu.markers}`);
    // off
    await click(trade);
    const off = await waitMarkers(false);
    await waitCurrent(page, 120000, false);
    const offGpu = await page.evaluate(gpuProbe);
    if (!off.buttonOff) problems.push("Trade off: the button is not buttonoff");
    if (off.markersDom !== 0) problems.push(`Trade off: ${off.markersDom} marker group(s) still in the DOM`);
    if (offGpu.markers !== 0) problems.push(`Trade off: the GPU still mirrors ${offGpu.markers} marker(s)`);
    // save with Trade off, check the attribute, reload it
    const saved: { text: string; hasAttr: boolean } = await page.evaluate(async () => {
      const { prepareMapData } = await (globalThis as any).lazy.save();
      const text = prepareMapData() as string;
      return { text, hasAttr: /<g id="tradeAnimation"[^>]*data-layer-off="1"/.test(text) };
    });
    if (!saved.hasAttr) problems.push('save with Trade off: the saved SVG has no data-layer-off="1" on #tradeAnimation');
    // the same save with Trade on must not carry it
    await click(trade);
    const back = await waitMarkers(true);
    const savedOn: { hasAttr: boolean } = await page.evaluate(async () => {
      const { prepareMapData } = await (globalThis as any).lazy.save();
      return { hasAttr: /<g id="tradeAnimation"[^>]*data-layer-off="1"/.test(prepareMapData()) };
    });
    if (savedOn.hasAttr) problems.push("save with Trade on: the saved SVG still carries data-layer-off");
    if (back.markersDom === 0) problems.push("Trade back on: no marker animates again");
    await waitCurrent(page, 120000, false);
    const backGpu = await page.evaluate(gpuProbe);
    if (back.markersDom > 0 && backGpu.markers === 0) problems.push(`Trade back on: ${back.markersDom} DOM markers but the GPU mirrors ${backGpu.markers}`);
    // load the Trade-off save: it must come back off, empty, with a current GPU frame
    await page.evaluate(async text => {
      const w = globalThis as any;
      await w.__tupaia.fns.loadMap({ text, timeoutMs: 120000 });
      await w.__tupaia.settle();
    }, saved.text);
    await page.waitForTimeout(600);
    const loaded = await probeTrade();
    const loadWait = await waitCurrent(page, 120000, false);
    const loadedGpu = await page.evaluate(gpuProbe);
    if (!loaded.buttonOff) problems.push("load of the Trade-off save: Trade is on (data-layer-off was not honoured)");
    if (loaded.markersDom !== 0) problems.push(`load of the Trade-off save: ${loaded.markersDom} marker group(s) animate`);
    if (loadedGpu.markers !== 0) problems.push(`load of the Trade-off save: the GPU mirrors ${loadedGpu.markers} marker(s)`);
    if (loadWait.active !== "gpu" || loadWait.timedOut) problems.push(`load of the Trade-off save: GPU not current (${loadWait.active}${loadWait.timedOut ? ", timed out" : ""})`);
    report.rows.trade = { start, off, offGpuMarkers: offGpu.markers, back, backGpuMarkers: backGpu.markers, savedOffHasAttr: saved.hasAttr, savedOnHasAttr: savedOn.hasAttr, loaded, loadedGpuMarkers: loadedGpu.markers };
    add(judged("trade.round-trip", "26", problems, `off: 0 DOM and 0 GPU markers, data-layer-off saved and honoured on load; on: ${back.markersDom} DOM / ${backGpu.markers} GPU markers`));
    write();
  }

  // ================================================================= reorder golden (row 27)
  if (passes.includes("reorder")) {
    await reload("reorder", "none");
    if (breakMode === "freeze-gpu") await freeze();
    // overlapping pairs of layers that pass the golden on their own; "up" moves A above B (raise), then back
    const PAIRS: Array<{ id: string; a: string; b: string; what: string }> = [
      { id: "cults-biomes", a: "cults", b: "biomes", what: "cultures raised above biomes, then below them" },
      { id: "terrs-biomes", a: "terrs", b: "biomes", what: "heightmap raised above biomes, then below them" },
      { id: "relig-cults", a: "relig", b: "cults", what: "religions raised above cultures, then below them" }
    ];
    const order = () => page.evaluate(() => [...document.querySelectorAll("#viewbox > *")].map(e => e.id));
    for (const pair of PAIRS) {
      await page.evaluate(isolateLayers, { ids: [pair.a, pair.b], bg: "#ffffff" });
      await settleApp(page);
      await page.evaluate(isolateLayers, { ids: [pair.a, pair.b], bg: "#ffffff" });
      await page.evaluate(zoomTo, { k: 1 });
      await waitCurrent(page);
      // make sure A starts below B, then raise it above B through the layers panel's own handler (moveLayer)
      const move = (where: "above" | "below") =>
        page.evaluate(
          ({ a, b, where }) => {
            const w = globalThis as any;
            const btn = (id: string) => ({ lakes: "toggleLakes", terrs: "toggleHeight", biomes: "toggleBiomes", cults: "toggleCultures", relig: "toggleReligions", regions: "toggleStates" } as Record<string, string>)[id];
            const li = document.getElementById(btn(a))!;
            const ref = document.getElementById(btn(b))!;
            // the panel lists layers top to bottom in z-order reversed: moving the li is what jQuery sortable does, then it
            // calls update -> moveLayer(event, {item}); calling moveLayer directly is the same DOM re-insert
            // later in the DOM paints on top: A above B = after B's button in the (bottom-to-top) list
            if (where === "above") ref.after(li);
            else ref.before(li);
            w.moveLayer(null, { item: w.jQuery(li) });
            const kids = [...document.querySelectorAll("#viewbox > *")].map(e => e.id);
            return { indexA: kids.indexOf(a), indexB: kids.indexOf(b) };
          },
          { a: pair.a, b: pair.b, where }
        );
      // normalise: A below B first
      let pos = await order();
      if (pos.indexOf(pair.a) > pos.indexOf(pair.b)) {
        await move("below");
        await waitCurrent(page);
      }
      pos = await order();
      const beforeShots = await captureArms(page);
      const beforeSvg = decode(beforeShots.svg);
      const beforeGpu = decode(beforeShots.gpu);
      const beforeMetrics = measureCell(beforeSvg, beforeGpu, beforeSvg);
      const p0 = await page.evaluate(gpuProbe);
      const moved = await move("above");
      await settleApp(page);
      const wait = await waitCurrent(page);
      const p1 = await page.evaluate(gpuProbe);
      const afterShots = await captureArms(page);
      const afterSvg = decode(afterShots.svg);
      const afterGpu = decode(afterShots.gpu);
      const diffFraction = (x: ReturnType<typeof decode>, y: ReturnType<typeof decode>) => {
        let n = 0;
        for (let i = 0; i < x.data.length; i += 4) if (Math.max(Math.abs(x.data[i] - y.data[i]), Math.abs(x.data[i + 1] - y.data[i + 1]), Math.abs(x.data[i + 2] - y.data[i + 2])) > 16) n++;
        return n / (x.width * x.height);
      };
      const after = measureCell(afterSvg, afterGpu, afterSvg);
      const problems = judgeReorder({
        moved: moved.indexA > moved.indexB && pos.indexOf(pair.a) < pos.indexOf(pair.b),
        svgChanged: diffFraction(beforeSvg, afterSvg),
        gpuChanged: diffFraction(beforeGpu, afterGpu),
        after: { ssim: after.ssim, over16Fraction: after.over16Fraction },
        gpu: wait
      });
      let evidence: string | undefined;
      if (problems.length) {
        const base = join(outDir, `reorder-${pair.id}`);
        writeFileSync(`${base}-after-svg.png`, afterShots.svg);
        writeFileSync(`${base}-after-gpu.png`, afterShots.gpu);
        writeFileSync(`${base}-after-diff.png`, encodePng(heatmap(afterSvg, afterGpu)));
        writeFileSync(`${base}-before-svg.png`, beforeShots.svg);
        evidence = `reorder-${pair.id}-after-diff.png`;
      }
      report.rows.reorder.push({
        pair: pair.id,
        what: pair.what,
        domOrderBefore: pos.filter(id => id === pair.a || id === pair.b),
        domOrderAfter: moved,
        beforeSsim: beforeMetrics.ssim,
        afterSsim: after.ssim,
        afterOver16: after.over16Fraction,
        svgChanged: diffFraction(beforeSvg, afterSvg),
        gpuChanged: diffFraction(beforeGpu, afterGpu),
        prepares: p1.prepares - p0.prepares
      });
      add(judged(`reorder.${pair.id}`, "27", problems, `${pair.what}: SVG frame changed ${(diffFraction(beforeSvg, afterSvg) * 100).toFixed(2)}%, GPU followed (${(diffFraction(beforeGpu, afterGpu) * 100).toFixed(2)}%), SSIM ${after.ssim.toFixed(4)}, over16 ${(after.over16Fraction * 100).toFixed(3)}%`, evidence));
      // put the layer back
      await move("below");
      await waitCurrent(page);
      write();
    }
    await page.evaluate(isolateLayers, { ids: [], restore: true });
  }

  // ---- the run's own health
  const validation = sink.warnings.some(w => /GL_INVALID_|Feedback loop/i.test(w));
  if (sink.errors.length) add(fail("run.page-errors", "26", `${sink.errors.length} page error(s): ${sink.errors[0].slice(0, 200)}`));
  else add(pass("run.page-errors", "26", "no page errors"));
  if (validation) add(fail("run.webgl-validation", "26", "WebGL validation warning; reject the render result"));
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
