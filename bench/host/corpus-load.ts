// Legacy corpus load test (REWRITE-PLAN §5 row 33: load + auto-update.ts migrations; PHASE1-PLAN D1, D11). Run it through
// bench/gate/gate.ts (`gate corpus`), which takes a shared host-lock slot and sets GATE_OUT_DIR.
//
// tests/fixtures/corpus/manifest.json lists real maps written by OLD versions of this app (CORPUS.md says how they were
// made and which auto-update.ts gates each one triggers). For every map, under ?renderer=svg and ?renderer=gpu in two
// fresh pages of one build, through the same uploadMap path as File > Open (version check, auto-update, parse):
//   load      the map loads (or, for a map the loader must refuse, it is refused with the right message), no page error;
//   migrate   the migrated world is sane (cells, burgs, one #tradeAnimation) and the arms agree on pack/grid hashes;
//   gpu       the gpu arm stays on the gpu path (no fallbackReason) after the load and after every reload;
//   census    the document census (elements and drawables per layer, one #tradeAnimation) is equal between the arms,
//             and the gpu scene census routes every visible layer that has drawables;
//   save      the text save of the migrated map is equal between the arms (header masked), saving and reloading it twice
//             is a fixed point (save 2 == save 3) on both arms, and the save carries the current VERSION;
//   golden    a per-map layer golden at k 1, SVG arm vs GPU arm, run in a child (bench/host/layer-golden.ts) with the
//             map's own style, and judged per cell. A layer with nothing to paint in both arms is reported as empty (INFO).
// No verdict compares GPU with GPU. `control=1` runs a second svg page as the "candidate" to separate renderer effects
// from nondeterminism in the migrations themselves (some pre-1.0 migrations generate content).
//
// Environment (gate.ts maps its arguments onto these):
//   CORPUS_MAPS     comma list of manifest ids, or all                       default all
//   CORPUS_ARMS     svg,gpu                                                  default svg,gpu (gpu alone cannot be judged)
//   CORPUS_DPR      1 or 2 (golden and pages)                                default 2
//   CORPUS_GOLDEN   1|0: run the per-map golden child                        default 1
//   CORPUS_CONTROL  1: second svg page instead of the gpu arm                default 0
//   CORPUS_STRICT   1: gate the manifest's known golden gaps too             default 0
//   CORPUS_BREAK    none | tamper: perturbs the gpu arm's save and census (self-test hook; the run must FAIL)
// Output in GATE_OUT_DIR: corpus.json (report; `failure` is null on a pass), <map>/{svg,gpu}/ saves, <map>/golden/.
// Exit 0 when a report was written, 1 on a harness error.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { gateCoverage, gatesOf, gatesTriggered, isEmptyGoldenCell, splitKnownGaps, type Manifest, type ManifestEntry as Entry, parseMapVersion } from "./corpus-lib.ts";
import { type Check, compareSaves, describeSaveDiff, fail, info, maskHeader, pass, SECTION_COUNT, skip, splitSections, verdict } from "./consumers-lib.ts";

const env = process.env;
const root = resolve(import.meta.dirname, "../..");
const dist = resolve(root, "dist");
const corpusDir = resolve(root, "tests/fixtures/corpus");
const outDir = resolve(env.GATE_OUT_DIR || process.cwd());
const dpr = Number(env.CORPUS_DPR || 2);
const arms = (env.CORPUS_ARMS || "svg,gpu").split(",").filter(Boolean) as Array<"svg" | "gpu">;
const wantGolden = (env.CORPUS_GOLDEN ?? "1") !== "0";
const control = env.CORPUS_CONTROL === "1";
const breakMode = env.CORPUS_BREAK || "none";
const strict = env.CORPUS_STRICT === "1"; // gate the manifest's known golden gaps too
if (![1, 2].includes(dpr)) throw Error("CORPUS_DPR must be 1 or 2");
if (!["none", "tamper"].includes(breakMode)) throw Error("CORPUS_BREAK must be none|tamper");

// ------------------------------------------------------------------ manifest

const manifest: Manifest = JSON.parse(readFileSync(join(corpusDir, "manifest.json"), "utf8"));
const wanted = (env.CORPUS_MAPS || "all").split(",").filter(Boolean);
const entries = wanted.includes("all") ? manifest.entries : manifest.entries.filter(e => wanted.includes(e.id));
if (!entries.length) throw Error(`no manifest entry matches CORPUS_MAPS=${env.CORPUS_MAPS}`);

// ------------------------------------------------------------------ the migration gates, read from the source

const gateSource = readFileSync(join(root, "src/io/auto-update.ts"), "utf8");
const allGates = gatesOf(gateSource);
const currentVersion = /const VERSION = "([^"]+)"/.exec(readFileSync(join(root, "public/versioning.js"), "utf8"))?.[1] ?? "";

// ------------------------------------------------------------------ types and log

type Arm = "svg" | "gpu";
interface Census {
  layers: Record<string, { elements: number; drawables: number; visible: boolean; style: string | null }>;
  tradeContainers: number;
  root: Record<string, { elements: number; drawables: number }>;
}
interface ArmRun {
  entry: Entry;
  arm: Arm;
  label: string;
  dir: string;
  loaded: boolean;
  loadMs: number | null;
  alert: string | null;
  loadError: string | null;
  errors: string[];
  warnings: string[];
  status: Record<string, any> | null;
  statuses: Array<{ label: string; active: string | null; fallbackReason: string; state: string | null; waitError?: string }>;
  census: Census | null;
  gpuLayers: Record<string, any> | null;
  hash: { total: string; hash: Record<string, string> } | null;
  world: Record<string, any> | null;
  saves: string[]; // save 1 (after the first load), save 2 (after reloading save 1), save 3 (after reloading save 2)
  failure: string | null;
}
const log = (message: string) => console.log(`[corpus] ${message}`);
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

// ------------------------------------------------------------------ static server and browser

const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json" };
const server = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  const path = resolve(dist, `.${url.pathname}`);
  if (!path.startsWith(`${dist}/`) && path !== dist) return void response.writeHead(403).end();
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
const CONSUMERS_PAGE = resolve(import.meta.dirname, "consumers-page.js");
const browser: Browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--use-angle=metal", "--enable-gpu"] });

async function openPage(armName: Arm, run: ArmRun): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: dpr, serviceWorkers: "block", acceptDownloads: true });
  await context.addInitScript(() => {
    localStorage.setItem("autosaveInterval", "0");
    localStorage.setItem("azgaarAssistant", "hide");
  });
  const scripts = ["bridge.js", "bridge-mutations.js", ...readdirSync(resolve(root, "mcp/src/bridge-ext")).filter(n => n.endsWith(".js")).sort().map(n => `bridge-ext/${n}`)];
  await context.addInitScript(scripts.map(n => readFileSync(resolve(root, "mcp/src", n), "utf8")).join("\n"));
  await context.addInitScript({ path: CONSUMERS_PAGE });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.origin === origin || (route.request().method() === "GET" && url.hostname === "fonts.gstatic.com") ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  page.on("pageerror", e => run.errors.push(e.message));
  page.on("console", m => {
    if (["warning", "error"].includes(m.type()) && run.warnings.length < 60) run.warnings.push(m.text().slice(0, 600));
  });
  // an alert dialog (the loader's "ancient"/"invalid" message) is a jQuery UI dialog, not a window.alert; this is for the rest
  page.on("dialog", d => d.dismiss());
  await page.goto(`${origin}/?local&seed=7319&width=1280&height=720&renderer=${armNames(armName)}`);
  await page.evaluate(async () => {
    const ready = await (globalThis as any).__tupaia.call("ready", { timeoutMs: 120000 });
    if (!ready.ok) throw Error(JSON.stringify(ready));
  });
  return page;
}
const armNames = (arm: Arm) => (arm === "gpu" ? "gpu" : "svg");

// ------------------------------------------------------------------ page probes

const statusOf = (page: Page) => page.evaluate(() => (globalThis as any).__cons.status()).catch(() => null);

async function settle(page: Page, run: ArmRun, label: string): Promise<void> {
  const status = await page.evaluate(gpu => (globalThis as any).__cons.idle({ gpu, timeoutMs: 240000 }), run.arm === "gpu" && !control);
  // jQuery fades started by a migration or a layer toggle (an old map's #emblems is faded out on load) end after the
  // renderer is idle; a save taken mid-fade holds the transient opacity, so wait them out before anything is read
  await page.waitForFunction(() => !((globalThis as any).jQuery?.timers?.length) && !(globalThis as any).jQuery?.(":animated")?.length, null, { timeout: 30000, polling: 100 }).catch(() => {});
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  run.statuses.push({ label, active: status.active, fallbackReason: status.fallbackReason, state: status.state, waitError: status.waitError });
}

const censusProbe = (): Census => {
  const DRAW = "path,polygon,polyline,rect,circle,ellipse,line,text,use,image";
  const count = (el: Element, skipSelf = false) => ({ elements: el.querySelectorAll("*").length + (skipSelf ? 0 : 1), drawables: el.querySelectorAll(DRAW).length });
  const svg = document.querySelector("svg#map")!;
  const layers: Census["layers"] = {};
  for (const child of Array.from(svg.querySelector("#viewbox")!.children)) {
    const id = child.id || `<${child.tagName}>`;
    if (id === "tradeAnimation" || id === "debug") continue; // animation state and the harness's own overlay
    // display:none on the layer itself or an ancestor (checkVisibility() reports a display:none svg group as visible)
    let visible = true;
    for (let el: Element | null = child; el && el !== svg; el = el.parentElement) if (getComputedStyle(el).display === "none") visible = false;
    layers[id] = { ...count(child), visible, style: child.getAttribute("style") };
  }
  const rootLayers: Census["root"] = {};
  for (const child of Array.from(svg.children)) if (child.id && child.id !== "viewbox" && child.id !== "defs") rootLayers[child.id] = count(child);
  return { layers, root: rootLayers, tradeContainers: document.querySelectorAll("#tradeAnimation").length };
};

// ------------------------------------------------------------------ one arm of one map

async function runArm(entry: Entry, arm: Arm, label: string): Promise<ArmRun> {
  const dir = join(outDir, entry.id, label);
  mkdirSync(dir, { recursive: true });
  const run: ArmRun = { entry, arm, label, dir, loaded: false, loadMs: null, alert: null, loadError: null, errors: [], warnings: [], status: null, statuses: [], census: null, gpuLayers: null, hash: null, world: null, saves: [], failure: null };
  const bytes = readFileSync(join(corpusDir, entry.file));
  const b64 = bytes.toString("base64");
  const page = await openPage(arm, run);
  const loadBytes = (data: string, timeoutMs: number) =>
    page.evaluate(
      async ([payload, ms]) => {
        const w = globalThis as any;
        const raw = Uint8Array.from(atob(payload as string), c => c.charCodeAt(0));
        const load = await w.lazy.load();
        await Promise.race([w.__tupaia.awaitMap(() => load.uploadMap(new Blob([raw], { type: "application/octet-stream" })), ms as number), new Promise((_, no) => setTimeout(() => no(new Error(`map did not load within ${ms} ms`)), (ms as number) + 5000))]);
      },
      [data, timeoutMs] as const
    );
  try {
    const started = Date.now();
    try {
      await loadBytes(b64, entry.expect === "ancient" ? 8000 : 180000);
      run.loaded = true;
    } catch (error) {
      run.loadError = error instanceof Error ? error.message.split("\n")[0].slice(0, 300) : String(error);
    }
    run.loadMs = Date.now() - started;
    run.alert = await page.evaluate(() => {
      const box = document.getElementById("alertMessage");
      const open = !!document.querySelector(".ui-dialog #alert, #alert")?.closest(".ui-dialog")?.checkVisibility?.();
      return open && box ? (box.textContent ?? "").slice(0, 300) : null;
    });
    if (entry.expect === "ancient" || !run.loaded) return run;
    await page.evaluate(() => (globalThis as any).__cons.freezeTrade());
    await settle(page, run, "load");
    run.status = await statusOf(page);
    run.world = await page.evaluate(() => {
      const r = (name: string) => (0, eval)(name);
      const pack = r("pack");
      return { seed: r("seed"), graph: [r("graphWidth"), r("graphHeight")], cells: pack.cells.i.length, burgs: pack.burgs.length, states: pack.states.length, rivers: pack.rivers.length, religions: pack.religions.length, provinces: pack.provinces.length, markers: pack.markers?.length ?? 0, zones: pack.zones?.length ?? 0, goods: pack.goods?.length ?? 0 };
    });
    run.hash = await page.evaluate(() => (globalThis as any).__cons.hashWorld());
    run.census = await page.evaluate(censusProbe);
    run.gpuLayers = await page.evaluate(() => (globalThis as any).rendererStatus?.()?.gpu?.layers ?? null);
    // save 1 -> reload -> save 2 -> reload -> save 3
    for (let n = 1; n <= 3; n++) {
      const saved = await page.evaluate(() => (globalThis as any).__cons.save());
      let text: string = saved.text;
      if (breakMode === "tamper" && arm === "gpu" && n === 1) text = text.replace('<g id="ocean"', '<g id="ocean" data-corpus-tamper="1"');
      run.saves.push(text);
      writeFileSync(join(dir, `save-${n}.map`), text);
      if (n === 3) break;
      await loadBytes(Buffer.from(saved.text, "utf8").toString("base64"), 180000);
      await page.evaluate(() => (globalThis as any).__cons.freezeTrade());
      await settle(page, run, `reload ${n}`);
    }
  } catch (error) {
    run.failure = error instanceof Error ? error.message.split("\n")[0].slice(0, 400) : String(error);
  } finally {
    await page.context().close();
  }
  return run;
}

// ------------------------------------------------------------------ the verdicts for one map

function judgeMap(entry: Entry, base: ArmRun, cand: ArmRun, candLabel: string): Check[] {
  const checks: Check[] = [];
  const id = (kind: string, suffix = "") => `${entry.id}.${kind}${suffix ? `.${suffix}` : ""}`;
  const header = readFileSync(join(corpusDir, entry.file), "utf8").split("\r\n", 1)[0];
  const triggers = gatesTriggered(header.split("|")[0], allGates);
  const declared = [...(entry.gates ?? [])].sort().join(",");
  checks.push(verdict(declared === [...triggers].sort().join(","), 33, id("manifest", "gates"), `${entry.id}: the manifest's gate list matches auto-update.ts for version ${parseMapVersion(header.split("|")[0])}`, `manifest [${declared}] vs source [${[...triggers].sort().join(",")}]`));
  for (const run of [base, cand]) {
    const arm = run.label;
    if (entry.expect === "ancient") {
      checks.push(verdict(!run.loaded && /too old|ancient/i.test(run.alert ?? ""), 33, id("load", `${arm}.refused`), `${entry.id}/${arm}: the loader refuses it as ancient`, `loaded ${run.loaded}, alert ${JSON.stringify(run.alert)}`));
      continue;
    }
    checks.push(verdict(run.loaded && !run.failure, 33, id("load", arm), `${entry.id}/${arm}: loads and migrates`, run.loadError ?? run.failure ?? `${((run.loadMs ?? 0) / 1000).toFixed(1)} s`));
    if (!run.loaded) continue;
    checks.push(verdict(!run.errors.length, 33, id("load", `${arm}.no-page-error`), `${entry.id}/${arm}: no page error through the load, the settle and two reloads`, run.errors[0]?.slice(0, 200) ?? "none"));
    const w = run.world;
    checks.push(verdict(!!w && w.cells > 100 && (w.graph[0] > 0 && w.graph[1] > 0), 33, id("migrate", `${arm}.world`), `${entry.id}/${arm}: the migrated world has cells and a graph size`, JSON.stringify(w)));
    checks.push(verdict(run.census?.tradeContainers === 1, 33, id("migrate", `${arm}.one-trade-container`), `${entry.id}/${arm}: exactly one #tradeAnimation after migration`, `${run.census?.tradeContainers}`));
    const header1 = maskHeader(splitSections(run.saves[0] ?? "")[0] ?? "").fields;
    checks.push(verdict(header1?.version === currentVersion, 33, id("save", `${arm}.current-version`), `${entry.id}/${arm}: the migrated save is written as ${currentVersion}`, `header version ${header1?.version}`));
    checks.push(verdict(splitSections(run.saves[0] ?? "").length === SECTION_COUNT, 33, id("save", `${arm}.sections`), `${entry.id}/${arm}: the save has ${SECTION_COUNT} sections`, `${splitSections(run.saves[0] ?? "").length}`));
    // saving and loading the migrated map again must change nothing
    if (run.saves.length === 3) {
      const fixed = compareSaves(run.saves[1], run.saves[2]);
      checks.push(verdict(fixed.equal, 33, id("save", `${arm}.fixed-point`), `${entry.id}/${arm}: save 2 equals save 3 (reloading a migrated save is a fixed point)`, describeSaveDiff(fixed)));
      const first = compareSaves(run.saves[0], run.saves[1]);
      checks.push(info(33, id("save", `${arm}.first-reload`), `${entry.id}/${arm}: save 1 vs save 2 (the first save after migration against the first reload)`, describeSaveDiff(first)));
    } else checks.push(fail(33, id("save", `${arm}.three-saves`), `${entry.id}/${arm}: three saves were taken`, `${run.saves.length}`));
  }
  if (entry.expect === "ancient" || !base.loaded || !cand.loaded) return checks;
  // gpu arm: stays on the gpu path through the load and both reloads
  if (cand.arm === "gpu" && !control) {
    const bad = cand.statuses.filter(s => s.active !== "gpu" || s.fallbackReason || s.waitError || s.state !== "active");
    checks.push(verdict(!bad.length && cand.statuses.length >= 3, 33, id("gpu", "no-fallback"), `${entry.id}/gpu: gpu active with no fallback after the load and each reload`, bad.length ? JSON.stringify(bad[0]) : `${cand.statuses.length} settles active`));
  }
  // arms agree on the migrated world and the document census
  // The map id is not pack data. A file written by 1.0 has no id (6 header fields), so the loader makes one per page;
  // from 1.4 on the file carries it and both arms must read the same raw value.
  const hashDiff = Object.keys(base.hash?.hash ?? {}).filter(k => k !== "mapId" && base.hash?.hash[k] !== cand.hash?.hash[k]);
  checks.push(verdict(!hashDiff.length && !!base.hash, 33, id("migrate", "arms-hash"), `${entry.id}: pack and grid member hashes are equal between ${base.label} and ${candLabel}`, hashDiff.length ? `differing: ${hashDiff.slice(0, 8).join(", ")}` : `${Object.keys(base.hash?.hash ?? {}).length} members`));
  // The loader does not keep the id either way: load.ts reads it from the file but showStatistics() (main.js, called at the
  // end of every load) sets mapId = Date.now(). Reported so the quirk is on record; it is the same in both arms.
  checks.push(info(33, id("migrate", "map-id"), `${entry.id}: the map id after load is a fresh Date.now(), not the file's (showStatistics resets it; upstream behaviour)`, `file ${header.split("|")[6] ?? "(none)"}, ${base.label} ${base.hash?.hash.mapId}, ${candLabel} ${cand.hash?.hash.mapId}`));
  const cb = base.census;
  let cc = cand.census;
  if (breakMode === "tamper" && cand.arm === "gpu" && cc) cc = { ...cc, layers: { ...cc.layers, ocean: { ...cc.layers.ocean, drawables: (cc.layers.ocean?.drawables ?? 0) + 1 } } };
  const layerDiffs = Object.keys({ ...cb?.layers, ...cc?.layers }).filter(k => JSON.stringify(cb?.layers[k]) !== JSON.stringify(cc?.layers[k]));
  const rootDiffs = Object.keys({ ...cb?.root, ...cc?.root }).filter(k => JSON.stringify(cb?.root[k]) !== JSON.stringify(cc?.root[k]));
  checks.push(verdict(!layerDiffs.length && !rootDiffs.length, 33, id("census", "arms-equal"), `${entry.id}: the document census (elements, drawables, visibility, style per layer) is equal between ${base.label} and ${candLabel}`, layerDiffs.length || rootDiffs.length ? `differs in ${[...layerDiffs, ...rootDiffs].slice(0, 8).join(", ")}: ${JSON.stringify(layerDiffs[0] ? [cb?.layers[layerDiffs[0]], cc?.layers[layerDiffs[0]]] : null)}` : `${Object.keys(cb?.layers ?? {}).length} layers`));
  // gpu scene census: every visible layer with drawables is routed (native or compat) by the gpu scene
  if (cand.arm === "gpu" && !control) {
    const routed = cand.gpuLayers ?? {};
    const unrouted = Object.entries(cand.census?.layers ?? {})
      .filter(([layerId, l]) => l.visible && l.drawables > 0 && !["ruler", "fogging-cont", "coordinates"].includes(layerId))
      .filter(([layerId]) => !(Number(routed[layerId]?.native ?? 0) + Number(routed[layerId]?.compat ?? 0) > 0))
      .map(([layerId]) => layerId);
    checks.push(verdict(!unrouted.length, 33, id("census", "gpu-routed"), `${entry.id}/gpu: every visible layer with drawables is routed by the gpu scene`, unrouted.length ? `unrouted: ${unrouted.join(", ")}` : `${Object.keys(routed).length} layers routed`));
    checks.push(info(33, id("census", "gpu-routing"), `${entry.id}/gpu: scene census (native/compat per layer)`, Object.entries(routed).map(([k, v]: [string, any]) => `${k} n${v.native}/c${v.compat}`).join(" ")));
  }
  // saves equal between the arms, header masked
  for (let n = 0; n < 3; n++) {
    const cmp = compareSaves(base.saves[n] ?? "", cand.saves[n] ?? "");
    checks.push(verdict(cmp.equal && base.saves.length === 3 && cand.saves.length === 3, 33, id("save", `arms-equal-${n + 1}`), `${entry.id}: save ${n + 1} is equal between ${base.label} and ${candLabel} (date and map id masked)`, describeSaveDiff(cmp), `${entry.id}/{${base.label},${cand.label}}/save-${n + 1}.map`));
  }
  return checks;
}

// ------------------------------------------------------------------ the per-map golden (a child process)

interface GoldenOutcome {
  checks: Check[];
  summary: unknown;
}
function runGolden(entry: Entry): GoldenOutcome {
  const dir = join(outDir, entry.id, "golden");
  mkdirSync(dir, { recursive: true });
  const result = spawnSync(process.execPath, [join(root, "bench/host/layer-golden.ts")], {
    env: {
      ...env,
      GATE_OUT_DIR: dir,
      GOLDEN_MAP: join(corpusDir, entry.file),
      GOLDEN_LAYERS: "all",
      GOLDEN_K: "1",
      GOLDEN_DPR: String(dpr),
      GOLDEN_PRESET: "map", // keep the file's own style: that is what a legacy map looks like
      GOLDEN_CAMERAS: "centered",
      GOLDEN_READING: "over44",
      GOLDEN_KEEP: "fail"
    },
    encoding: "utf8",
    maxBuffer: 1 << 28,
    timeout: 30 * 60 * 1000
  });
  writeFileSync(join(dir, "run.log"), `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  let data: any = null;
  try {
    data = JSON.parse(readFileSync(join(dir, "golden.json"), "utf8"));
  } catch {
    /* reported below */
  }
  const checks: Check[] = [];
  const id = (suffix: string) => `${entry.id}.golden.${suffix}`;
  if (!data) {
    checks.push(fail(33, id("run"), `${entry.id}: the per-map golden produced a report`, `exit ${result.status}, no golden.json`));
    return { checks, summary: null };
  }
  const cells: any[] = data.cells ?? [];
  // A cell that paints nothing in both arms and has no drawables in the document is a layer this old map does not have.
  const isEmpty = isEmptyGoldenCell;
  const empty = cells.filter(isEmpty);
  const judged = cells.filter(c => !isEmpty(c));
  // Families that fail the same way on the parity fixture are known GPU gaps (manifest.goldenKnownGaps): reported, not gated.
  // CORPUS_STRICT=1 gates them too.
  const known = strict ? [] : manifest.goldenKnownGaps.filter(k => !k.maps || k.maps.includes(entry.id)).map(k => k.family);
  const { gating: bad, excused } = splitKnownGaps(judged, known);
  checks.push(verdict(!data.errors?.length, 33, id("harness"), `${entry.id}: the golden ran without a page or harness error`, data.errors?.[0]?.split("\n")[0].slice(0, 240) ?? "none", `${entry.id}/golden/golden.json`));
  checks.push(verdict(judged.length > 0 && !bad.length, 33, id("cells"), `${entry.id}: every populated layer family passes the golden at k 1 (SVG arm vs GPU arm, over44 reading, the file's own style), known parity gaps aside`, `${judged.length - bad.length - excused.length}/${judged.length} pass${bad.length ? `; failing: ${bad.slice(0, 6).map(c => `${c.family} (${c.failures?.[0]?.slice(0, 110)})`).join("; ")}` : ""}${excused.length ? `; ${excused.length} known-gap failures excused` : ""}`, `${entry.id}/golden/golden.json`));
  checks.push(info(33, id("known-gaps"), `${entry.id}: known-gap families that failed (not gated; each also fails on the parity fixture)`, excused.map(c => `${c.family}: ${c.failures?.[0]?.slice(0, 100)}`).join(" | ") || "none"));
  checks.push(info(33, id("empty"), `${entry.id}: families with nothing to paint in this map (not judged)`, empty.map(c => c.family).join(", ") || "none"));
  const notes = judged.filter(c => c.pass && c.notes?.length);
  if (notes.length) checks.push(info(33, id("notes"), `${entry.id}: passing cells with a footprint note`, notes.slice(0, 8).map(c => `${c.family}: ${c.notes.join("; ")}`).join(" | ")));
  return { checks, summary: { cells: cells.length, judged: judged.length, failing: bad.length, knownGaps: excused.map(c => c.family), empty: empty.map(c => c.family) } };
}

// ------------------------------------------------------------------ main

const report: Record<string, any> = {
  schema: 1,
  runStartedUtc: new Date().toISOString(),
  args: { maps: entries.map(e => e.id), arms, dpr, golden: wantGolden, control, break: breakMode },
  currentVersion,
  gates: allGates,
  maps: {} as Record<string, any>,
  checks: [] as Check[],
  coverage: null as unknown,
  failure: null as string | null
};
const flush = () => writeFileSync(join(outDir, "corpus.json"), `${JSON.stringify(report, null, 1)}\n`);
mkdirSync(outDir, { recursive: true });

try {
  const checks: Check[] = report.checks;
  for (const entry of entries) {
    const file = readFileSync(join(corpusDir, entry.file));
    checks.push(verdict(sha(file) === entry.sha256, 33, `${entry.id}.manifest.sha256`, `${entry.id}: the file matches the manifest's sha256`, sha(file).slice(0, 16)));
    log(`${entry.id} (${entry.version}, ${(file.length / 1e6).toFixed(2)} MB, expect ${entry.expect})`);
    const baseRun = await runArm(entry, "svg", "svg");
    const candLabel = control ? "svg-control" : "gpu";
    const candRun = arms.includes("gpu") ? await runArm(entry, control ? "svg" : "gpu", candLabel) : null;
    const slim = (run: ArmRun | null) => run && { loaded: run.loaded, loadMs: run.loadMs, alert: run.alert, loadError: run.loadError, failure: run.failure, world: run.world, statuses: run.statuses, errors: run.errors.slice(0, 5), warnings: run.warnings.slice(0, 12), census: run.census, gpuLayers: run.gpuLayers };
    report.maps[entry.id] = { entry, svg: slim(baseRun), [candLabel]: slim(candRun) };
    if (!candRun) {
      checks.push(skip(33, `${entry.id}.arms`, `${entry.id}: only the svg arm ran, nothing can be judged`, "CORPUS_ARMS=svg"));
      continue;
    }
    checks.push(...judgeMap(entry, baseRun, candRun, candLabel));
    flush();
    if (wantGolden && entry.expect === "load" && baseRun.loaded) {
      log(`${entry.id}: golden`);
      const golden = runGolden(entry);
      checks.push(...golden.checks);
      report.maps[entry.id].golden = golden.summary;
    }
    flush();
  }
  // coverage: every auto-update.ts gate is run by at least one corpus map that must load (judged over the full manifest),
  // except the gates the manifest documents as unreachable
  const { exercised, unreached } = gateCoverage(allGates, manifest.entries);
  const known = manifest.knownUnreachable.map(k => k.gate);
  const surprising = unreached.filter(g => !known.includes(g));
  const stale = known.filter(g => !unreached.includes(g));
  report.coverage = { gates: allGates.length, exercised, unreached, knownUnreachable: manifest.knownUnreachable };
  checks.push(verdict(!surprising.length && !stale.length, 33, "corpus.gate-coverage", `every auto-update.ts gate (${allGates.length}) is triggered by a corpus map that must load, except the documented unreachable ones`, surprising.length ? `never triggered: ${surprising.join(", ")}` : stale.length ? `listed as unreachable but triggered: ${stale.join(", ")}` : `${allGates.length - unreached.length} triggered; unreachable by design: ${known.join(", ") || "none"}`));
  for (const k of manifest.knownUnreachable) checks.push(info(33, `corpus.unreachable.${k.gate}`, `gate ${k.gate} cannot be exercised by any file the loader accepts`, k.reason));
} catch (error) {
  report.failure = `harness: ${error instanceof Error ? error.stack : String(error)}`;
} finally {
  const failing = (report.checks as Check[]).filter(c => c.status === "FAIL");
  if (!report.failure && failing.length) report.failure = `${failing.length} of ${(report.checks as Check[]).length} checks failed: ${failing.slice(0, 6).map(c => c.id).join(", ")}${failing.length > 6 ? ", ..." : ""}`;
  flush();
  log(report.failure ? `FAIL ${report.failure}` : `PASS ${(report.checks as Check[]).length} checks`);
  await browser.close();
  await new Promise<void>(done => server.close(() => done()));
}
