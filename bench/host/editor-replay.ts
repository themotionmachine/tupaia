// G-E editor replay (PROOF-PLAN §5, REWRITE-PLAN §5 rows 29/30; decision D4 in PHASE1-PLAN.md). Run it through the gate:
// `node bench/gate/gate.ts replay [editors=burg,label] [arms=svg,gpu,gpu-select]` (shared slot) or `replay-resume`
// (exclusive lock: the resume latency as a timing).
//
// Each script in editor-scripts/ is a list of editor interactions (camera, click, input, button, drag/brush, close).
// The SVG arm (stock renderer) RECORDS it: targets resolve to frozen client points and camera transforms, and every
// step's outcome is observed. The GPU arms (?renderer=gpu rendering-only, ?renderer=gpu&gpu-select) REPLAY the frozen
// actions with real Playwright input and must observe the same thing, step by step:
//   - pack/grid/notes section hashes after the step, and which sections the step changed;
//   - model-DOM layer hashes (svg#map children, #viewbox children) and the step's net model-DOM delta (attribute values,
//     child lists, text, by element path) from a MutationObserver;
//   - the canonical SVG element under the pointer before each pointer action;
//   - dispatchClick and editor-global call counts (more than recorded = double dispatch);
//   - open editor dialogs; no camera move during any pointer action (drag, brush stroke), d3 zoom or GPU camera;
//   - GPU arms: suspended with the canvas hidden while the editor is open, and resumed after the close. The resume is
//     timed from the trusted close click to the first current GPU frame and to the first refined frame (D4). After a
//     session that changed the model, no GPU frame older than the latest DOM revision may be on screen (D13).
// Math.random is seeded per step in every arm (the relief brush scatters icons randomly). Each script starts from a
// fresh load of the fixture, so scripts are independent.
//
// Environment (gate.ts maps its arguments onto these):
//   REPLAY_MAP        .map fixture (default: the parity fixture, tests/fixtures/parity/parity-v1.map)
//   REPLAY_EDITORS    comma list of editor-scripts/<name>.ts, or "all"                     default all
//   REPLAY_ARMS       comma list of svg, gpu, gpu-select (svg is required: it records)      default all three
//   REPLAY_DPR        1 | 2                                                                default 2
//   REPLAY_LAUNCHER   metal | swiftshader (bench/host/launcher.ts)                         default metal
//   REPLAY_RESUME_MS  limit for a resume / GPU settle                                       default 60000
//   REPLAY_TRACE      1: log every step as it starts (a hung step shows as the last line)
//   REPLAY_PARALLEL   1 (default): the replay arms run side by side after the recording; 0: one after another (the
//                     resume latency as a timing: `gate replay-resume`, exclusive lock)
//   REPLAY_BREAK      none, or a comma list of model, dom, dispatch: self-test. At the first input step of every
//                     replay arm it corrupts pack (a burg name), the model DOM (an attribute on #labels) and/or the
//                     dispatch count (one extra dispatchClick); `stale` reveals the GPU canvas right after the close
//                     input (as if the renderer showed its pre-edit frame, D13); the run passes only if every replay
//                     arm of every script is caught by each corresponding check
// Output in GATE_OUT_DIR: replay.json (report; `failure` null on a pass) and recording.json (the frozen svg actions).
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import {
  type Arm,
  armQuery,
  type EditorScript,
  judgeArm,
  parseArms,
  type Resume,
  type Step,
  type StepObservation,
  validateScript
} from "./editor-replay-core.ts";
import { beginStep, endStep, installReplay } from "./editor-replay-page.ts";
import { decodePng } from "../png.ts";
import { resolveFixture } from "./fixtures/index.ts";
import { adapterMatches, launcherFrom, launchOptions, probeAdapter } from "./launcher.ts";

const env = process.env;
const root = resolve(import.meta.dirname, "../..");
const dist = resolve(root, "dist");
const outDir = resolve(env.GATE_OUT_DIR || process.cwd());
const scriptDir = resolve(import.meta.dirname, "editor-scripts");
const ALL_SCRIPTS = readdirSync(scriptDir).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "common.ts").map(f => f.slice(0, -3)).sort();
const names = !env.REPLAY_EDITORS || env.REPLAY_EDITORS === "all" ? ALL_SCRIPTS : env.REPLAY_EDITORS.split(",").map(s => s.trim());
for (const name of names) if (!ALL_SCRIPTS.includes(name)) throw Error(`unknown editor script ${name}; have ${ALL_SCRIPTS.join(", ")}`);
const arms = parseArms(env.REPLAY_ARMS);
const dpr = Number(env.REPLAY_DPR || 2);
if (dpr !== 1 && dpr !== 2) throw Error("REPLAY_DPR must be 1 or 2");
const launcher = launcherFrom(env.REPLAY_LAUNCHER);
const resumeLimit = Number(env.REPLAY_RESUME_MS || 60000);
const breakMode = env.REPLAY_BREAK || "none";
const parallel = (env.REPLAY_PARALLEL ?? "1") !== "0";
const breaks = breakMode === "none" ? [] : breakMode.split(",").map(b => b.trim());
if (breaks.some(b => !["model", "dom", "dispatch", "stale"].includes(b))) throw Error("REPLAY_BREAK must be none or a list of model, dom, dispatch, stale");
const mapPath = env.REPLAY_MAP ? resolve(env.REPLAY_MAP) : resolveFixture("parity").path;
const mapText = readFileSync(mapPath, "utf8");
const mapSha = createHash("sha256").update(readFileSync(mapPath)).digest("hex");

const scripts: EditorScript[] = [];
for (const name of names) {
  const script = (await import(join(scriptDir, `${name}.ts`))).default as EditorScript;
  const errors = validateScript(script);
  if (errors.length) throw Error(`invalid script ${name}: ${errors.join("; ")}`);
  scripts.push(script);
}
const EDITOR_GLOBALS = [
  ...new Set([
    ...scripts.map(s => s.editor),
    "editBurg", "editLabel", "editRoute", "editMarker", "editReliefIcon", "editRiver", "editIce", "editLake", "editCoastline", "editRegiment", "editEmblem",
    "editHeightmap", "editBiomes", "editStates", "editProvinces", "editCultures", "editReligions", "editZones", "editDiplomacy"
  ])
];

const started = Date.now();
const log = (message: string) => process.stderr.write(`[replay ${Math.round((Date.now() - started) / 1000)}s] ${message}\n`);
const report: any = {
  schema: 1,
  check: "replay",
  config: { map: mapPath, mapSha256: mapSha, editors: names, arms, dpr, launcher, resumeLimitMs: resumeLimit, parallel, break: breakMode, viewport: [1280, 720] },
  adapters: {} as Record<string, unknown>,
  scripts: [] as any[],
  resume: [] as any[],
  errors: [] as string[],
  failure: null as string | null
};

// ------------------------------------------------------------------ static server (dist/)
const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const server = createServer((request, response) => {
  if (request.method !== "GET") return void response.writeHead(405).end();
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
if (!address || typeof address === "string") throw Error("no server address");
const origin = `http://127.0.0.1:${address.port}`;

// ------------------------------------------------------------------ page
const browser = await chromium.launch(launchOptions(launcher));

async function openArm(arm: Arm): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: dpr, serviceWorkers: "block", acceptDownloads: false });
  // app origin only: init scripts also run in opaque-origin frames, where localStorage throws
  await context.addInitScript((localOrigin: string) => {
    if (location.origin !== localOrigin) return;
    localStorage.setItem("autosaveInterval", "0");
    localStorage.setItem("azgaarAssistant", "hide");
    (globalThis as any).__name ??= (fn: unknown) => fn;
  }, origin);
  const bridge = ["bridge.js", "bridge-mutations.js", ...readdirSync(resolve(root, "mcp/src/bridge-ext")).filter(n => n.endsWith(".js")).sort().map(n => `bridge-ext/${n}`)];
  await context.addInitScript(bridge.map(n => readFileSync(resolve(root, "mcp/src", n), "utf8")).join("\n"));
  // local GET plus fonts.gstatic GET (the GPU prepare fetches fonts; without it it falls back)
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.origin === origin || (route.request().method() === "GET" && url.hostname === "fonts.gstatic.com") ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  page.on("pageerror", error => report.errors.push(`${arm}: ${error.message}`));
  page.on("dialog", dialog => dialog.dismiss());
  await page.goto(`${origin}/?local&seed=7319&width=1280&height=720${armQuery(arm)}`);
  await page.evaluate(async () => {
    const ready = await (globalThis as any).__tupaia.call("ready", { timeoutMs: 120000 });
    if (!ready.ok) throw Error(JSON.stringify(ready));
  });
  report.adapters[arm] = await page.evaluate(probeAdapter);
  if (arm !== "svg" && !adapterMatches(launcher, report.adapters[arm].renderer))
    throw Error(`launcher ${launcher} got WebGL adapter ${report.adapters[arm].renderer}`);
  return { page, close: () => context.close() };
}

async function loadFixture(page: Page, arm: Arm): Promise<void> {
  await page.evaluate(async text => {
    const w = globalThis as any;
    const result = await w.__tupaia.fns.loadMap({ text, timeoutMs: 120000 });
    if (result?.ok === false) throw Error(JSON.stringify(result));
    await w.__tupaia.settle();
  }, mapText);
  await page.evaluate(installReplay, { arm, editors: EDITOR_GLOBALS });
  // no GPU wait here: every script's first steps (display, camera) re-prepare anyway, and the camera step waits
  await page.evaluate(async () => {
    const rp = (globalThis as any).__rp;
    rp.stopTrade();
    // loadMap's "Map is successfully loaded" main tip clears on a timer. While it shows, FMG's hover handler skips
    // showMapTooltip (so an emblem under the pointer is not raised); whether the timer already fired depends on the
    // arm's load time. Clear it so hover side effects are the same in every arm.
    (globalThis as any).clearMainTip?.();
    rp.lastModel = null;
    await rp.settle(0);
  });
  const status = await page.evaluate(() => (globalThis as any).rendererStatus?.());
  if (arm !== "svg" && status?.active !== "gpu") throw Error(`${arm}: GPU not active after load: ${status?.fallbackReason}`);
}

// ------------------------------------------------------------------ steps
interface Frozen {
  point?: { x: number; y: number };
  camera?: { k: number; x: number; y: number };
}

const setCamera = (page: Page, camera: { k: number; x: number; y: number }) =>
  page.evaluate(async ({ k, x, y }) => {
    const w = globalThis as any;
    w.d3.select("#map").call((0, eval)("zoom").transform, w.d3.zoomIdentity.translate(x, y).scale(k));
    await new Promise(done => setTimeout(done, 50));
    if (w.waitDenseZoomReady) await w.waitDenseZoomReady(15000);
    await Promise.all([w.reliefRenderReady, w.burgRenderReady]);
    const t = w.d3.zoomTransform(document.getElementById("map"));
    return { k: t.k, x: t.x, y: t.y };
  }, camera);

async function runStep(page: Page, arm: Arm, step: Step, index: number, frozen: Frozen): Promise<StepObservation> {
  const t0 = Date.now();
  if (env.REPLAY_TRACE) log(`${arm} step ${index} ${step.op}${step.note ? " (" + step.note + ")" : ""}`);
  await page.evaluate(beginStep, { index, seed: 7919 * (index + 1) });
  let point: { x: number; y: number } | undefined;
  let hitKey: string | null | undefined;
  const aim = async (target: unknown) => {
    if (arm === "svg") {
      const resolved = await page.evaluate(t => (globalThis as any).__rp.resolve(t), target);
      frozen.point = { x: resolved.x, y: resolved.y };
      return resolved.hitKey as string | null;
    }
    if (!frozen.point) throw Error(`step ${index}: no frozen point from the svg recording`);
    return page.evaluate(({ x, y }) => (globalThis as any).__rp.hitKey(x, y), frozen.point);
  };
  switch (step.op) {
    case "display": {
      const result = await page.evaluate(a => (globalThis as any).__tupaia.call("display", a), { on: step.on ?? [], off: step.off ?? [] });
      if (!result?.ok) throw Error(`display ${JSON.stringify(step)}: ${JSON.stringify(result).slice(0, 300)}`);
      break;
    }
    case "camera": {
      if (arm === "svg") {
        const [wx, wy] = await page.evaluate(f => (globalThis as any).__rp.focusWorld(f), step.focus);
        frozen.camera = await setCamera(page, { k: step.k, x: 640 - wx * step.k, y: 360 - wy * step.k });
      } else {
        if (!frozen.camera) throw Error(`step ${index}: no frozen camera`);
        await setCamera(page, frozen.camera);
      }
      break;
    }
    case "click": {
      hitKey = await aim(step.target);
      point = frozen.point;
      await page.mouse.click(point!.x, point!.y);
      break;
    }
    case "open": {
      // the Tools panel's own listener (tools.js) dispatches on the button's id; a script click, not a pointer action
      await page.evaluate(id => {
        const el = document.getElementById(id);
        if (!el) throw Error(`no Tools button #${id}`);
        el.click();
      }, step.button);
      break;
    }
    case "input": {
      await page.evaluate(({ selector, value, checked, event }) => {
        const el = document.querySelector(selector) as HTMLInputElement | null;
        if (!el) throw Error(`no input ${selector}`);
        if (checked !== undefined) el.checked = checked;
        if (value !== undefined) el.value = String(value);
        el.dispatchEvent(new Event(event ?? (checked !== undefined ? "change" : "input"), { bubbles: true }));
      }, { selector: step.css ?? `#${step.id}`, value: step.value, checked: step.checked, event: step.event });
      break;
    }
    case "button":
      if (step.dom)
        // resolved by Playwright, so Playwright-only selectors (:has-text) work here too; clicked through the DOM
        await page
          .locator(step.css ?? `#${step.id}`)
          .first()
          .evaluate(el => {
            if (el instanceof HTMLElement) el.click();
            else el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); // SVG elements have no click()
          }, undefined, { timeout: 5000 });
      else await page.click(step.css ?? `#${step.id}`);
      break;
    case "drag": {
      hitKey = await aim(step.target);
      point = frozen.point;
      const { x, y } = point!;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (const [dx, dy] of step.path) await page.mouse.move(x + dx, y + dy, { steps: 4 });
      await page.mouse.up();
      break;
    }
    case "close":
      await (step.via ? page.locator(step.via) : page.locator(`.ui-dialog:has(> ${step.dialog}) .ui-dialog-titlebar-close`)).click();
      if (breaks.includes("stale") && arm !== "svg")
        await page.evaluate(() => {
          const canvas = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
          if (canvas) canvas.style.display = "block"; // self-test: the pre-edit frame on screen (the renderer re-hides it)
        });
      break;
    case "key":
      await page.keyboard.press(step.key);
      break;
  }
  // an editor that loads lazily (states, cultures, religions) opens a moment after its Tools button: wait for the dialog
  // the script says opens, in every arm
  if ((step.op === "click" || step.op === "open" || step.op === "button") && step.expect?.dialog)
    await page.waitForFunction(id => (globalThis as any).__rp.dialogs().includes(id), step.expect.dialog, { timeout: 30000 });
  let resume: Resume | undefined;
  // a close that leaves another editor open (a script with two dialogs) has nothing to resume to: only the last one is timed
  if (step.op === "close" && arm !== "svg" && !(await page.evaluate(() => (globalThis as any).__rp.dialogs().length)))
    resume = await page.evaluate(limit => (globalThis as any).__rp.resume(limit), resumeLimit);
  // a display change is always followed by a camera step, which waits for the GPU frame itself
  await page.evaluate(limit => (globalThis as any).__rp.settle(limit), step.op === "display" ? 0 : resumeLimit);
  if (breaks.length && arm !== "svg" && step.op === "input" && !(page as any).__broken) {
    (page as any).__broken = true;
    await page.evaluate(modes => {
      const w = globalThis as any;
      if (modes.includes("model")) w.pack.burgs[1].name += " (replay self-test)";
      if (modes.includes("dom")) document.getElementById("labels")?.setAttribute("data-replay-self-test", "1");
      if (modes.includes("dispatch")) w.__rp.calls.dispatchClick = (w.__rp.calls.dispatchClick ?? 0) + 1;
    }, breaks);
  }
  const observed = await page.evaluate(endStep);
  const result = { index, op: step.op, note: step.note, point, hitKey, ...observed, resume, ms: Date.now() - t0 } as StepObservation;
  // Evidence for "editor open but the GPU canvas is still on screen": what the user sees against the edited SVG
  // under it (canvas hidden for the second shot), and how many device pixels differ.
  if (arm !== "svg" && result.dialogs.length && result.gpu?.canvasVisible) (result as any).staleCanvas = await staleCanvasEvidence(page, `${arm}-${(page as any).__script}-step${index}`);
  return result;
}

async function staleCanvasEvidence(page: Page, name: string) {
  const shown = await page.screenshot({ animations: "disabled" });
  const old = await page.evaluate(() => {
    const c = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
    const value = c?.style.visibility ?? "";
    if (c) c.style.visibility = "hidden";
    return value;
  });
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const svg = await page.screenshot({ animations: "disabled" });
  await page.evaluate(value => {
    const c = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
    if (c) c.style.visibility = value;
  }, old);
  const dir = join(outDir, "stale-canvas");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}-shown.png`), shown);
  writeFileSync(join(dir, `${name}-svg.png`), svg);
  const a = decodePng(shown);
  const b = decodePng(svg);
  let over16 = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let d = 0;
    for (let j = 0; j < 3; j++) d = Math.max(d, Math.abs(a.data[i + j] - b.data[i + j]));
    if (d > 16) over16++;
  }
  return { over16, fraction: Math.round((over16 / (a.width * a.height)) * 1e5) / 1e5, images: [`stale-canvas/${name}-shown.png`, `stale-canvas/${name}-svg.png`] };
}

// ------------------------------------------------------------------ run
const recording: Record<string, { frozen: Frozen[]; steps: StepObservation[] }> = {};
const observed: Record<string, Record<string, StepObservation[]>> = {};
const harness: string[] = [];
async function runArm(arm: Arm): Promise<void> {
  log(`arm ${arm}: opening`);
  const { page, close } = await openArm(arm);
  try {
    for (const script of scripts) {
      if (arm !== "svg" && !recording[script.name]) continue; // the recording failed: nothing to replay
      const armStart = Date.now();
      (page as any).__broken = false;
      try {
        (page as any).__script = script.name;
        await loadFixture(page, arm);
        const frozen = arm === "svg" ? [] : recording[script.name].frozen;
        const steps: StepObservation[] = [];
        for (let i = 0; i < script.steps.length; i++) {
          if (arm === "svg") frozen.push({});
          steps.push(await runStep(page, arm, script.steps[i], i, frozen[i]));
        }
        if (arm === "svg") recording[script.name] = { frozen, steps };
        (observed[script.name] ??= {})[arm] = steps;
        log(`arm ${arm}: ${script.name} ${steps.length} steps in ${Math.round((Date.now() - armStart) / 100) / 10}s`);
      } catch (error) {
        const message = `${arm} ${script.name}: harness: ${String((error as Error)?.stack || error).slice(0, 800)}`;
        harness.push(message);
        log(message);
        // close any dialog the failed script left so the next script starts clean
        await page.evaluate(() => (globalThis as any).__rp?.dialogs?.().forEach((id: string) => (globalThis as any).$(id).dialog("close"))).catch(() => {});
      }
    }
  } finally {
    await close();
  }
}

try {
  mkdirSync(outDir, { recursive: true });
  // the svg arm records first; the replay arms then run side by side (each its own context) or one after another
  await runArm("svg");
  const replays = arms.filter(arm => arm !== "svg");
  if (parallel) {
    const settled = await Promise.allSettled(replays.map(runArm));
    for (const result of settled) if (result.status === "rejected") harness.push(`harness: ${String(result.reason?.stack || result.reason).slice(0, 800)}`);
  } else for (const arm of replays) await runArm(arm);
} catch (error) {
  harness.push(`harness: ${String((error as Error)?.stack || error).slice(0, 1200)}`);
} finally {
  await browser.close().catch(() => {});
  server.close();
}

// ------------------------------------------------------------------ verdicts
const failures: string[] = [...harness];
const breakCaught: Record<string, Record<string, boolean>> = {};
const expectedCatch: Record<string, RegExp> = { model: /model differs/, dom: /model DOM differs/, dispatch: /double dispatch/, stale: /stale GPU frame visible/ };
for (const script of scripts) {
  const rec = recording[script.name]?.steps;
  const row: any = { name: script.name, editor: script.editor, rows: script.rows, description: script.description, verdicts: {}, steps: {} };
  report.scripts.push(row);
  if (!rec) {
    row.verdicts.svg = { pass: false, failures: ["no recording"] };
    if (!harness.some(h => h.includes(` ${script.name}:`))) failures.push(`${script.name}: no recording`);
    continue;
  }
  for (const arm of arms) {
    const steps = observed[script.name]?.[arm];
    if (!steps) {
      row.verdicts[arm] = { pass: false, failures: ["not replayed"] };
      if (!harness.some(h => h.startsWith(`${arm} ${script.name}:`))) failures.push(`${arm} ${script.name}: not replayed`);
      continue;
    }
    const verdict = judgeArm(script, arm, rec, steps, resumeLimit);
    row.verdicts[arm] = verdict;
    // the report keeps a bounded DOM delta per step; the comparison above used the whole list
    row.steps[arm] = steps.map(s => ({ ...s, domDelta: s.domDelta.slice(0, 60) }));
    if (verdict.resume) report.resume.push({ script: script.name, arm, currentMs: verdict.resume.currentMs, refinedMs: verdict.resume.refinedMs, prepares: verdict.resume.prepares, lastPrepareMs: verdict.resume.lastPrepareMs });
    if (!breaks.length || arm === "svg") failures.push(...verdict.failures.map(f => `${arm} ${script.name}: ${f}`));
    else {
      const caught = (breakCaught[`${script.name}/${arm}`] = Object.fromEntries(breaks.map(b => [b, verdict.failures.some(f => expectedCatch[b].test(f))])));
      for (const b of breaks)
        if (!caught[b]) failures.push(`self-test ${b}: ${arm} ${script.name} was not caught (${verdict.failures.slice(0, 2).join("; ") || "no failure at all"})`);
    }
  }
}
if (breaks.length) report.selftest = { break: breaks, caught: breakCaught };
for (const error of report.errors) if (!failures.some(f => f.includes(error))) failures.push(`page error ${error}`);
const pick = (values: (number | null)[]) => values.filter((v): v is number => v != null).sort((a, b) => a - b);
const resumeSummary = (arm: Arm) => {
  const rows = report.resume.filter((r: any) => r.arm === arm);
  const cur = pick(rows.map((r: any) => r.currentMs));
  const ref = pick(rows.map((r: any) => r.refinedMs));
  return rows.length ? { n: rows.length, currentMs: { min: cur[0], max: cur[cur.length - 1] }, refinedMs: { min: ref[0], max: ref[ref.length - 1] } } : null;
};
report.summary = {
  pass: failures.length === 0,
  scripts: report.scripts.map((s: any) => [s.name, Object.fromEntries(Object.entries(s.verdicts).map(([arm, v]: [string, any]) => [arm, v.pass ? "PASS" : "FAIL"]))]),
  resume: Object.fromEntries(arms.filter(a => a !== "svg").map(arm => [arm, resumeSummary(arm)])),
  seconds: Math.round((Date.now() - started) / 1000)
};
report.verdicts = Object.fromEntries(
  report.scripts.flatMap((s: any) => Object.entries(s.verdicts).map(([arm, v]: [string, any]) => [`${s.name}/${arm}`, v.pass ? "PASS" : "FAIL"]))
);
if (breaks.length) report.verdicts = { selftest: failures.length ? "FAIL" : "PASS" };
report.failure = failures.length ? failures.slice(0, 40).join("; ").slice(0, 4000) : null;
report.failures = failures;
writeFileSync(join(outDir, "replay.json"), JSON.stringify(report, null, 2));
writeFileSync(join(outDir, "recording.json"), JSON.stringify({ map: mapSha, scripts: Object.fromEntries(Object.entries(recording).map(([k, v]) => [k, v.frozen])) }, null, 2));
console.log(JSON.stringify({ pass: report.summary.pass, summary: report.summary, failure: report.failure?.slice(0, 1500) ?? null }));
process.exitCode = harness.length && !report.scripts.length ? 1 : 0;
