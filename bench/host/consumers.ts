// Consumers harness (PROOF-PLAN G-S; REWRITE-PLAN §5 rows 31-38 and 40; PHASE1-PLAN D1, D4). Run it through
// bench/gate/gate.ts (`gate consumers`), which takes a shared host-lock slot and sets GATE_OUT_DIR and GATE_MAP.
//
// For each world (the parity fixture and shared-v8) it runs the SAME script twice in two fresh pages of one build,
// once under ?renderer=svg and once under ?renderer=gpu, at a non-identity camera, and compares what the consumers
// of the map receive: the saved .map (46 sections, SVG at index 5, I8/I9/I11/I12/I15), the binary save and the ldb
// lastMap round trip, a cloud save/load against a mocked Worker, the SVG/PNG/JPEG/tiles exports, the 3D mesh
// texture and 3D view, the transform tool's 4x preview, the minimap, and the row-38 dialogs. It also hashes
// window.pack and window.grid before and after pure navigation (row 40). No check compares GPU with GPU: every
// verdict is the gpu arm against the svg arm of the same world, or an absolute property asserted on both arms.
//
// Environment (all optional; gate.ts maps its arguments onto these):
//   CONSUMERS_MAP         shared-v8 .map (default GATE_MAP)
//   CONSUMERS_PARITY_MAP  parity fixture (default tests/fixtures/parity/parity-v1.map)
//   CONSUMERS_WORLDS      comma list of parity|shared                     default parity,shared
//   CONSUMERS_ARMS        comma list of svg|gpu                           default svg,gpu (gpu alone cannot be judged)
//   CONSUMERS_DPR         1 or 2                                          default 2
//   CONSUMERS_STEPS       comma list of step names to run (debugging)     default all
//   CONSUMERS_BREAK       none | save-tamper | export-tamper | tamper (both): self-test hooks that perturb the gpu arm's data
// Output in GATE_OUT_DIR: consumers.json (report; `failure` is null on a pass), <world>/<arm>/ artifacts.
// Exit 0 when a report was written (verdicts are in it), 1 on a harness error.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { decodePng, encodePng } from "../png.ts";
import { BinaryMapArchive, isBinaryMap } from "../../src/io/binary-map.ts";
import {
  type Check,
  type PixelComparison,
  type SvgFacts,
  SECTION_COUNT,
  SVG_SECTION,
  comparePixels,
  compareSaves,
  describePixels,
  describeSaveDiff,
  fail,
  firstDifference,
  info,
  judgeSvgFacts,
  pass,
  rowStatus,
  sha256,
  skip,
  splitSections,
  unzipTiles,
  verdict,
  withinD1
} from "./consumers-lib.ts";

const env = process.env;
const root = resolve(import.meta.dirname, "../..");
const dist = resolve(root, "dist");
const outDir = resolve(env.GATE_OUT_DIR || process.cwd());
const dpr = Number(env.CONSUMERS_DPR || 2);
const worldNames = (env.CONSUMERS_WORLDS || "parity,shared").split(",").filter(Boolean);
const armNames = (env.CONSUMERS_ARMS || "svg,gpu").split(",").filter(Boolean) as Array<"svg" | "gpu">;
const onlySteps = (env.CONSUMERS_STEPS || "").split(",").filter(Boolean);
const breakMode = env.CONSUMERS_BREAK || "none";
const wants = (step: string) => !onlySteps.length || onlySteps.includes(step);
// Control run: the "candidate" arm is a second, independent svg page. Every verdict should then PASS; whatever does not
// is noise of the harness or of the browser (for example SVG-to-bitmap rasterization), not a renderer effect.
const control = env.CONSUMERS_CONTROL === "1";
if (![1, 2].includes(dpr)) throw Error("CONSUMERS_DPR must be 1 or 2");
if (!["none", "save-tamper", "export-tamper", "tamper"].includes(breakMode)) throw Error("CONSUMERS_BREAK must be none|save-tamper|export-tamper|tamper");

const WORLDS: Record<string, string> = {
  shared: resolve(env.CONSUMERS_MAP || env.GATE_MAP || "/tmp/tupaia-navigation-shared-v8.map"),
  parity: resolve(env.CONSUMERS_PARITY_MAP || join(root, "tests/fixtures/parity/parity-v1.map"))
};
const PARITY_PAGE = resolve(import.meta.dirname, "fixtures/parity-page.js");
const CONSUMERS_PAGE = resolve(import.meta.dirname, "consumers-page.js");
// A non-identity camera: zoom 2.2 (clear of the coastline switch points 1.5 and 2.6), centred off the middle of the map.
const CAMERA = { k: 2.2, fx: 0.42, fy: 0.55 };

// ------------------------------------------------------------------ types

type Arm = "svg" | "gpu";
interface Status {
  active: string | null;
  fallbackReason: string;
  state: string | null;
  canvasVisible: boolean;
  suspendedReason: string;
  waitError?: string;
  [key: string]: unknown;
}
interface StepRecord {
  step: string;
  ms: number;
  before: Status | null;
  after: Status | null;
  errors: string[];
  error: string | null;
}
interface ArmRun {
  world: string;
  arm: Arm;
  label: string; // directory and report name: "svg", "gpu", or "svg-control" (CONSUMERS_CONTROL)
  dir: string;
  facts: Record<string, any>;
  texts: Record<string, string>;
  bytes: Record<string, Buffer>;
  steps: StepRecord[];
  errors: string[];
  warnings: string[];
  failure: string | null;
}

const log = (message: string) => console.log(`[consumers] ${message}`);

// ------------------------------------------------------------------ static server for dist/ with a mocked shared-map Worker

const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json" };

// The fmg-map Worker's /api/map/:id control plane (cloudflare/README.md), in memory. Reset for every arm.
interface CloudState {
  version: number;
  body: string | null;
  updatedAt: string;
  snapshots: Array<{ version: number; body: string; savedAt: string }>;
  conflictNext: boolean;
  log: Array<{ method: string; path: string; version: string | null; overwrite: string | null; bytes: number; sha: string | null; status: number }>;
}
const freshCloud = (): CloudState => ({ version: 0, body: null, updatedAt: "2026-10-19T00:00:00.000Z", snapshots: [], conflictNext: false, log: [] });
let cloud = freshCloud();

async function readBody(request: import("node:http").IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    const body = request.method === "PUT" || request.method === "POST" ? await readBody(request) : Buffer.alloc(0);
    const entry = { method: request.method || "GET", path: url.pathname + url.search, version: (request.headers["x-map-version"] as string) ?? null, overwrite: (request.headers["x-map-overwrite"] as string) ?? null, bytes: body.length, sha: body.length ? sha256(body) : null, status: 200 };
    const reply = (status: number, payload: string | object, headers: Record<string, string> = {}) => {
      entry.status = status;
      cloud.log.push(entry);
      const text = typeof payload === "string" ? payload : JSON.stringify(payload);
      response.writeHead(status, { "content-type": typeof payload === "string" ? "text/plain; charset=utf-8" : "application/json", ...headers });
      response.end(text);
    };
    const meta = () => ({ id: "shared", name: "consumers", version: cloud.version, updated_at: cloud.updatedAt, updated_by: "consumers-mock", editing_by: null, lock_expires: null });
    if (url.pathname === "/api/map/shared" && request.method === "GET") {
      if (cloud.body === null) return reply(404, { error: "not found" });
      return reply(200, cloud.body, { "X-Map-Version": String(cloud.version), "X-Map-Updated-By": "consumers-mock", "X-Map-Updated-At": cloud.updatedAt });
    }
    if (url.pathname === "/api/map/shared/meta" && request.method === "GET") return cloud.body === null ? reply(404, { error: "not found" }) : reply(200, meta());
    if (url.pathname === "/api/map/shared/versions" && request.method === "GET")
      return cloud.body === null ? reply(404, { error: "not found" }) : reply(200, { current: cloud.version, snapshots: cloud.snapshots.map(s => ({ version: s.version, size: s.body.length, saved_at: s.savedAt })) });
    if (url.pathname === "/api/map/shared" && request.method === "PUT") {
      const sent = entry.version === null ? null : Number(entry.version);
      const stale = cloud.body !== null && entry.overwrite !== "true" && sent !== null && sent !== cloud.version;
      if (cloud.conflictNext || stale) {
        cloud.conflictNext = false;
        return reply(409, { version: cloud.version, updated_by: "someone-else", updated_at: cloud.updatedAt });
      }
      if (cloud.body !== null) cloud.snapshots.unshift({ version: cloud.version, body: cloud.body, savedAt: cloud.updatedAt });
      cloud.body = body.toString("utf8");
      cloud.version += 1;
      cloud.updatedAt = new Date().toISOString();
      return reply(200, { version: cloud.version });
    }
    if (url.pathname === "/api/map/shared/restore" && request.method === "POST") {
      const wanted = Number(url.searchParams.get("v"));
      const snapshot = cloud.snapshots.find(s => s.version === wanted);
      if (!snapshot) return reply(404, { error: "no such version" });
      cloud.snapshots.unshift({ version: cloud.version, body: cloud.body ?? "", savedAt: cloud.updatedAt });
      cloud.body = snapshot.body;
      cloud.version += 1;
      return reply(200, { version: cloud.version });
    }
    return reply(404, { error: "unmocked" });
  }
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

// ------------------------------------------------------------------ browser session for one arm

const browser: Browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--use-angle=metal", "--enable-gpu"] });

async function openArm(world: string, arm: Arm, label = arm as string): Promise<{ context: BrowserContext; page: Page; run: ArmRun; downloads: { count: number; files: string[] } }> {
  const dir = join(outDir, world, label);
  mkdirSync(dir, { recursive: true });
  const run: ArmRun = { world, arm, label, dir, facts: {}, texts: {}, bytes: {}, steps: [], errors: [], warnings: [], failure: null };
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: dpr, serviceWorkers: "block", acceptDownloads: true });
  await context.addInitScript(() => {
    localStorage.setItem("autosaveInterval", "0");
    localStorage.setItem("azgaarAssistant", "hide");
  });
  const scripts = ["bridge.js", "bridge-mutations.js", ...readdirSync(resolve(root, "mcp/src/bridge-ext")).filter(n => n.endsWith(".js")).sort().map(n => `bridge-ext/${n}`)];
  await context.addInitScript(scripts.map(n => readFileSync(resolve(root, "mcp/src", n), "utf8")).join("\n"));
  await context.addInitScript({ path: PARITY_PAGE });
  await context.addInitScript({ path: CONSUMERS_PAGE });
  // loopback plus the font host only, as every other host harness does: nothing leaves the machine
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.origin === origin || (route.request().method() === "GET" && url.hostname === "fonts.gstatic.com") ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  const downloads = { count: 0, files: [] as string[] };
  page.on("pageerror", e => run.errors.push(e.message));
  page.on("console", m => {
    if (["warning", "error"].includes(m.type()) && run.warnings.length < 80) run.warnings.push(m.text().slice(0, 1000));
  });
  page.on("dialog", d => d.dismiss());
  page.on("download", () => {
    downloads.count++;
  });
  await page.goto(`${origin}/?local&seed=7319&width=1280&height=720&renderer=${arm}`);
  await page.evaluate(async () => {
    const ready = await (globalThis as any).__tupaia.call("ready", { timeoutMs: 120000 });
    if (!ready.ok) throw Error(JSON.stringify(ready));
  });
  return { context, page, run, downloads };
}

const statusOf = (page: Page): Promise<Status | null> => page.evaluate(() => (globalThis as any).__cons?.status() ?? null).catch(() => null);

/** Run one named step: record the renderer state around it and the page errors it caused; a throw is recorded, not fatal. */
async function step(run: ArmRun, page: Page, name: string, body: () => Promise<void>): Promise<boolean> {
  if (onlySteps.length && !onlySteps.includes(name) && name !== "boot") return false;
  const started = Date.now();
  const errorsBefore = run.errors.length;
  const before = await statusOf(page);
  let error: string | null = null;
  try {
    await body();
  } catch (e) {
    error = e instanceof Error ? e.message.split("\n")[0].slice(0, 400) : String(e);
  }
  const after = await statusOf(page);
  run.steps.push({ step: name, ms: Date.now() - started, before, after, errors: run.errors.slice(errorsBefore), error });
  log(`${run.world}/${run.arm} ${name} ${error ? `ERROR ${error}` : "ok"} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  return !error;
}

const idle = (page: Page, arm: Arm, allowSuspended = false): Promise<Status> => page.evaluate(([gpu, allow]) => (globalThis as any).__cons.idle({ gpu, allowSuspended: allow }), [arm === "gpu", allowSuspended] as const);

// idle plus a record of how long the renderer took to settle (and whether it did): the judge fails a gpu arm that never settled
async function settled(run: ArmRun, page: Page, label: string, allowSuspended = false): Promise<Status> {
  const status = await idle(page, run.arm, allowSuspended);
  ((run.facts.settle ??= []) as unknown[]).push({ label, waitedMs: status.waitedMs ?? null, waitError: status.waitError ?? null, state: status.state, active: status.active, fallbackReason: status.fallbackReason });
  return status;
}
// stop the trade caravans, which keep invalidating the gpu scene (a prepare of the parity world takes tens of seconds)
// and whose transforms would make two exports of one state differ
const freeze = (page: Page): Promise<number> => page.evaluate(() => (globalThis as any).__cons.freezeTrade());

async function capture(page: Page, run: ArmRun, file: string, trigger: () => Promise<unknown>): Promise<Buffer> {
  const wait = page.waitForEvent("download", { timeout: 120000 });
  wait.catch(() => {});
  await trigger();
  const download = await wait;
  const path = join(run.dir, file);
  await download.saveAs(path);
  const bytes = readFileSync(path);
  run.bytes[file] = bytes;
  run.facts[`${file}:suggested`] = download.suggestedFilename().replace(/\d{4}-\d{2}-\d{2}.*?(?=\.)/, "<time>");
  return bytes;
}

const put = (run: ArmRun, key: string, text: string) => {
  run.texts[key] = text;
  writeFileSync(join(run.dir, key), text);
};
const putBytes = (run: ArmRun, key: string, bytes: Buffer) => {
  run.bytes[key] = bytes;
  writeFileSync(join(run.dir, key), bytes);
};

// ------------------------------------------------------------------ one arm: the script both arms run

async function runArm(world: string, arm: Arm, label: string = arm): Promise<ArmRun> {
  const { context, page, run, downloads } = await openArm(world, arm, label);
  const evalp = <T>(fn: (...a: any[]) => T | Promise<T>, arg?: unknown) => page.evaluate(fn as any, arg) as Promise<T>;
  const tamper = arm === "gpu" && breakMode;
  const toB64 = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64");
  try {
    // ---- boot: load the world, hash it (row 40)
    await step(run, page, "boot", async () => {
      const text = readFileSync(WORLDS[world], "utf8");
      await evalp(async (t: string) => {
        const w = globalThis as any;
        await w.__tupaia.fns.loadMap({ text: t, timeoutMs: 120000 });
        await w.__tupaia.settle();
      }, text);
      await freeze(page);
      if (world === "parity") {
        await evalp(() => (globalThis as any).__parity.preamble());
        await freeze(page);
      }
      run.facts.afterBoot = await settled(run, page, "boot");
      run.facts.world = await evalp(() => ({ graph: [(globalThis as any).graphWidth, (globalThis as any).graphHeight], cells: (globalThis as any).pack.cells.i.length, burgs: (globalThis as any).pack.burgs.length, seed: (globalThis as any).seed }));
      run.facts.hash0 = await evalp(() => (globalThis as any).__cons.hashWorld());
    });

    // ---- row 40: a pure-navigation sequence must not change pack or grid
    await step(run, page, "navigation", async () => {
      const moves = [
        { k: 3, fx: 0.3, fy: 0.4 },
        { k: 1.5, fx: 0.6, fy: 0.5 },
        { k: 4, fx: 0.5, fy: 0.3 },
        { k: 1, fx: 0.5, fy: 0.5 }
      ];
      for (const move of moves) {
        await evalp((m: typeof CAMERA) => (globalThis as any).__cons.setCamera(m), move);
        await settled(run, page, `navigation k=${move.k}`);
      }
      run.facts.hash1 = await evalp(() => (globalThis as any).__cons.hashWorld());
      run.facts.sameObjects = await evalp(() => (globalThis as any).__cons.sameWorldObjects());
    });

    // ---- the camera the rest of the script runs at
    await step(run, page, "camera", async () => {
      run.facts.camera = await evalp((m: typeof CAMERA) => (globalThis as any).__cons.setCamera(m), CAMERA);
      run.facts.afterCamera = await settled(run, page, "camera");
      run.facts.cameraSettled = await evalp(() => (globalThis as any).__cons.camera());
    });

    // ---- row 31 (I8, I9, I11, I15): the text save at that camera
    await step(run, page, "save", async () => {
      const plain = await evalp(() => (globalThis as any).__cons.save());
      let text: string = plain.text;
      if (tamper === "save-tamper" || tamper === "tamper") text = text.replace('<g id="ocean"', '<g id="ocean" data-consumers-tamper="1"');
      put(run, "save-trade-on.map", text);
      run.facts.saveOn = { facts: plain.facts, cameraBefore: plain.cameraBefore, cameraAfter: plain.cameraAfter, graph: plain.graph };
      // transient content in the live document: I9 must empty #tradeAnimation and #ruler, and a #temp node shows I15
      const planted = await evalp(() => (globalThis as any).__cons.save({ plant: true }));
      put(run, "save-planted.map", planted.text);
      run.facts.savePlanted = { facts: planted.facts, live: planted.live };
      await settled(run, page, "after planting");
      // I11: the trade layer off writes data-layer-off, and a restored layer clears it again
      await evalp(() => (globalThis as any).__tupaia.call("display", { off: ["trade"] }));
      await settled(run, page, "trade off");
      const off = await evalp(() => (globalThis as any).__cons.save());
      put(run, "save-trade-off.map", off.text);
      run.facts.saveOff = { facts: off.facts };
      await evalp(() => (globalThis as any).__tupaia.call("display", { on: ["trade"] }));
      await freeze(page);
      await settled(run, page, "trade on");
      const again = await evalp(() => (globalThis as any).__cons.save());
      put(run, "save-trade-on-again.map", again.text);
      run.facts.saveOnAgain = { facts: again.facts };
    });

    // ---- row 32: binary save, ldb lastMap, reload round trips, I12
    await step(run, page, "binary", async () => {
      const b64: string = await evalp(() => (globalThis as any).__cons.saveBinary());
      const bytes = Buffer.from(b64, "base64");
      putBytes(run, "save.tupaia", bytes);
      const textNow = await evalp(async () => (await (globalThis as any).lazy.save()).prepareMapData());
      put(run, "save-for-binary.map", textNow);
      run.facts.binary = { size: bytes.length, isBinary: isBinaryMap(new Uint8Array(bytes)), textSize: textNow.length };
      run.texts["binary-decoded.map"] = await new BinaryMapArchive(new Uint8Array(bytes)).text();
      // ldb lastMap: saveMap('storage') stores the binary, and boot loads it back with uploadMap(blob)
      const stored = await evalp(() => (globalThis as any).__cons.saveToStorage());
      run.facts.ldb = { kind: stored.kind, size: stored.size, isBinary: stored.base64 ? isBinaryMap(new Uint8Array(Buffer.from(stored.base64, "base64"))) : false };
      if (stored.base64) run.texts["ldb-decoded.map"] = await new BinaryMapArchive(new Uint8Array(Buffer.from(stored.base64, "base64"))).text();
      // I12: customization blocks every save path
      const before = downloads.count;
      run.facts.blocked = await evalp(() => (globalThis as any).__cons.saveBlockedProbe());
      run.facts.blocked.downloads = downloads.count - before;
      run.facts.afterBlocked = await settled(run, page, "after customization probe");
      // reload the binary, save text again (I2: save, load, save)
      run.facts.reloadStatus = await evalp((b: string) => (globalThis as any).__cons.loadBytes(b), b64);
      await freeze(page);
      run.facts.afterReload = await settled(run, page, "binary reload");
      const reloaded = await evalp(async () => (await (globalThis as any).lazy.save()).prepareMapData());
      put(run, "save-after-binary-reload.map", reloaded);
      // and through ldb: store the pre-reload bytes, then boot-load them
      await evalp(async (b: string) => {
        const bytes = Uint8Array.from(atob(b), c => c.charCodeAt(0));
        await (0, eval)("ldb").set("lastMap", new Blob([bytes], { type: "application/octet-stream" }));
      }, b64);
      await evalp(() => (globalThis as any).__cons.loadFromLdb());
      await freeze(page);
      run.facts.afterLdbReload = await settled(run, page, "ldb reload");
      const viaLdb = await evalp(async () => (await (globalThis as any).lazy.save()).prepareMapData());
      put(run, "save-after-ldb-reload.map", viaLdb);
      run.facts.hash2 = await evalp(() => (globalThis as any).__cons.hashWorld());
      void toB64;
    });

    // ---- the rest runs on the freshly reloaded world, back at the non-identity camera
    await step(run, page, "camera2", async () => {
      await evalp((m: typeof CAMERA) => (globalThis as any).__cons.setCamera(m), CAMERA);
      run.facts.afterCamera2 = await settled(run, page, "camera2");
      run.facts.camera2 = await evalp(() => (globalThis as any).__cons.camera());
      run.facts.frozenCaravans = await freeze(page);
    });

    // ---- row 34: exports through the real functions (downloads), and the clone strings behind them
    await step(run, page, "export", async () => {
      const exportWith = (name: string) => () => evalp((n: string) => (globalThis as any).__cons.runExport(n), name);
      const svg = await capture(page, run, "export.svg", exportWith("exportToSvg"));
      run.facts.exportSvgSize = svg.length;
      const png = await capture(page, run, "export.png", exportWith("exportToPng"));
      await capture(page, run, "export-again.png", exportWith("exportToPng")); // the noise floor of one arm
      const jpeg = await capture(page, run, "export.jpeg", exportWith("exportToJpeg"));
      run.facts.exportSizes = { png: png.length, jpeg: jpeg.length };
      if (tamper === "export-tamper" || tamper === "tamper") {
        // a rendered-looking change: the decoded image must differ, not just the file bytes
        const image = decodePng(new Uint8Array(png));
        for (let i = 0; i < image.data.length; i += 4 * 97) image.data[i] = 255 - image.data[i];
        putBytes(run, "export.png", encodePng(image));
      }
      // the SVG behind the visible-part PNG (type "png", current camera) and a repeat export for stability
      const clone = await evalp(() => (globalThis as any).__cons.mapUrl("png", {}));
      put(run, "clone-png.svg", clone);
      run.facts.cloneFacts = await evalp((t: string) => (globalThis as any).__cons.exportFacts(t), clone);
      const again = await evalp(() => (globalThis as any).__cons.mapUrl("svg", { fullMap: true }));
      put(run, "clone-svg-full.svg", again);
      const repeat = await evalp(() => (globalThis as any).__cons.mapUrl("svg", { fullMap: true }));
      run.facts.exportStable = again === repeat;
      // tiles: the schema and tiles, zipped. 2x2 keeps the run short; the code path is the same as 8x8.
      await evalp(() => {
        for (const [id, v] of [["tileColsOutput", 2], ["tileRowsOutput", 2], ["tileScaleOutput", 1]] as const) (document.getElementById(id) as HTMLInputElement).value = String(v);
      });
      // the SVG clones the schema and the tiles are rasterized from: byte-identical inputs make a raster difference noise
      put(run, "clone-tiles-debug.svg", await evalp(() => (globalThis as any).__cons.mapUrl("tiles", { debug: true, fullMap: true })));
      put(run, "clone-tiles.svg", await evalp(() => (globalThis as any).__cons.mapUrl("tiles", { fullMap: true })));
      const zip = await capture(page, run, "export-tiles.zip", exportWith("exportToPngTiles"));
      run.facts.tiles = unzipTiles(new Uint8Array(zip)).map(([name, data]) => ({ name, bytes: data.length }));
    });

    // ---- row 36: the 3D mesh texture (the SVG the 3D view rasterizes) and the 3D view itself
    await step(run, page, "mesh", async () => {
      const mesh = await evalp(() => (globalThis as any).__cons.mapUrl("mesh", { noLabels: false, noWater: false, noViewbox: true, fullMap: true }));
      put(run, "mesh-texture.svg", mesh);
      run.facts.meshFacts = await evalp((t: string) => (globalThis as any).__cons.exportFacts(t), mesh);
      const meshNoLabels = await evalp(() => (globalThis as any).__cons.mapUrl("mesh", { noLabels: true, noWater: true, noViewbox: true, fullMap: true }));
      put(run, "mesh-texture-nolabels-nowater.svg", meshNoLabels);
      run.facts.afterMesh = await evalp(() => ({ camera: (globalThis as any).__cons.camera(), status: (globalThis as any).__cons.status() }));
    });

    await step(run, page, "view3d", async () => {
      await evalp(async () => {
        const w = globalThis as any;
        document.getElementById("viewMesh")?.classList.add("pressed");
        await w.enter3dView("viewMesh");
      });
      await page.waitForSelector("#canvas3d", { state: "visible", timeout: 60000 });
      await page.waitForTimeout(4000);
      putBytes(run, "view3d-mesh.png", await page.locator("#canvas3d").screenshot());
      run.facts.view3d = await evalp(() => ({ status: (globalThis as any).__cons.status(), canvases: document.querySelectorAll("#canvas3d").length }));
      // satellite: a procedural texture that replaces the SVG render entirely ("satellite mode unchanged"). Its water
      // shimmer follows the rAF timestamp, so the timestamp is fixed for the capture.
      await evalp(async () => {
        (globalThis as any).__cons.freezeRafTime(true);
        await (globalThis as any).ThreeD.toggleSatellite();
      });
      await page.waitForTimeout(5000);
      putBytes(run, "view3d-satellite.png", await page.locator("#canvas3d").screenshot());
      await page.waitForTimeout(500);
      putBytes(run, "view3d-satellite-again.png", await page.locator("#canvas3d").screenshot());
      await evalp(async () => {
        (globalThis as any).__cons.freezeRafTime(false);
        await (globalThis as any).ThreeD.toggleSatellite();
      });
      run.facts.afterView3dClose = await evalp(() => (globalThis as any).__cons.closeAllDialogs());
      run.facts.afterView3d = await settled(run, page, "after 3D view");
    });

    // ---- row 37: the transform tool's 4x preview
    await step(run, page, "transform", async () => {
      put(run, "clone-transform.svg", await evalp(() => (globalThis as any).__cons.mapUrl("png", { noWater: true, fullMap: true, noLabels: true, noScaleBar: true, noVignette: true, noIce: true })));
      const preview = await evalp(() => (globalThis as any).__cons.transformPreview());
      putBytes(run, "transform-preview.png", Buffer.from(preview.png, "base64"));
      delete preview.png;
      run.facts.transform = preview;
      await evalp(() => (globalThis as any).__cons.closeAllDialogs());
      run.facts.afterTransform = await settled(run, page, "after transform tool");
    });

    // ---- row 35: minimap (suspends the gpu renderer today: the bridge), viewport rect, click-to-pan target
    await step(run, page, "minimap", async () => {
      const opened = await evalp(() => (globalThis as any).__cons.openMinimap());
      run.facts.minimapOpen = opened;
      // whole client pixels, as a real click delivers them
      const cx = Math.round(opened.rect.x + opened.rect.width * 0.28);
      const cy = Math.round(opened.rect.y + opened.rect.height * 0.7);
      run.facts.minimapClick = { client: [cx, cy], expected: await evalp(([x, y]: number[]) => (globalThis as any).__cons.minimapTarget(x, y), [cx, cy]) };
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(1200); // zoomTo(…, 450 ms)
      run.facts.minimapClick.centre = await evalp(() => (globalThis as any).__cons.viewCentre());
      run.facts.minimapClick.camera = await evalp(() => (globalThis as any).__cons.camera());
      run.facts.minimapClick.use = await evalp(() => document.getElementById("minimapMapUse")?.getAttribute("transform"));
      run.facts.minimapClose = await evalp(() => (globalThis as any).__cons.closeMinimap());
      run.facts.afterMinimap = await settled(run, page, "after minimap");
      run.facts.cameraAfterMinimap = await evalp(() => (globalThis as any).__cons.camera());
    });

    // ---- row 38: elevation profile, charts overview, emblem export
    await step(run, page, "elevation", async () => {
      const profile = await evalp(() => (globalThis as any).__cons.openElevationProfile());
      run.facts.elevation = { ...profile, graphHtml: undefined, graphSha: profile.graphHtml ? sha256(profile.graphHtml) : null };
      if (profile.graphHtml) put(run, "elevation-graph.svg.html", profile.graphHtml);
      if (!profile.skipped) {
        for (const [button, file] of [["epSave", "elevation.csv"], ["epSaveSVG", "elevation.svg"], ["epSavePNG", "elevation.png"]] as const)
          await capture(page, run, file, () => evalp((id: string) => (globalThis as any).__cons.clickButton(id), button));
      }
      await evalp(() => (globalThis as any).__cons.closeAllDialogs());
      run.facts.afterElevation = await settled(run, page, "after elevation profile");
    });
    await step(run, page, "charts", async () => {
      const charts = await evalp(() => (globalThis as any).__cons.openCharts());
      run.facts.charts = { ...charts, html: undefined, htmlSha: charts.html ? sha256(charts.html) : null };
      if (charts.html) put(run, "charts-figure.html", charts.html);
      for (const [n, file] of [[0, "charts.csv"], [2, "charts.svg"], [1, "charts.png"]] as const)
        await capture(page, run, file, () => evalp((i: number) => (globalThis as any).__cons.clickChartButton(i), n)).catch(e => {
          run.facts[`${file}:error`] = String(e).slice(0, 200);
        });
      await evalp(() => (globalThis as any).__cons.closeAllDialogs());
      run.facts.afterCharts = await settled(run, page, "after charts");
    });
    await step(run, page, "emblem", async () => {
      const emblem = await evalp(() => (globalThis as any).__cons.openEmblem());
      run.facts.emblem = emblem;
      if (!emblem.skipped) {
        for (const [id, file] of [["emblemsDownloadSVG", "emblem.svg"], ["emblemsDownloadPNG", "emblem.png"], ["emblemsDownloadJPG", "emblem.jpeg"]] as const)
          await capture(page, run, file, () => evalp((i: string) => (globalThis as any).__cons.clickButton(i), id)).catch(e => {
            run.facts[`${file}:error`] = String(e).slice(0, 200);
          });
      }
      await evalp(() => (globalThis as any).__cons.closeAllDialogs());
      run.facts.afterEmblem = await settled(run, page, "after emblem editor");
    });

    // ---- row 32: cloud save and load against the mocked Worker
    await step(run, page, "cloud", async () => {
      cloud = freshCloud();
      const save = () => evalp(async () => (await (globalThis as any).lazy.sharedMap()).saveSharedMap());
      const text0 = await evalp(async () => (await (globalThis as any).lazy.save()).prepareMapData());
      await save(); // not loaded from shared: asks, then creates (GET /meta 404, PUT version 0)
      await page.waitForTimeout(300);
      run.facts.cloud1 = { version: cloud.version, hasBody: cloud.body !== null, bodyEqualsPage: cloud.body !== null ? compareSaves(text0, cloud.body).equal : false };
      if (cloud.body !== null) put(run, "cloud-put-1.map", cloud.body);
      // load it back: a world replacement through uploadMap
      await evalp(async () => {
        const w = globalThis as any;
        const m = await w.lazy.sharedMap();
        await w.__tupaia.awaitMap(() => m.loadSharedMap(), 120000);
      });
      await freeze(page);
      run.facts.afterCloudLoad = await settled(run, page, "cloud load");
      const text1 = await evalp(async () => (await (globalThis as any).lazy.save()).prepareMapData());
      put(run, "save-after-cloud-load.map", text1);
      // a second save now carries the loaded version, and a stale write is a visible conflict
      await save();
      await page.waitForTimeout(300);
      run.facts.cloud2 = { version: cloud.version, snapshots: cloud.snapshots.length };
      cloud.conflictNext = true;
      await save();
      await page.waitForTimeout(500);
      run.facts.conflict = await evalp(() => (globalThis as any).__cons.alertState());
      await evalp(() => (globalThis as any).__cons.closeAllDialogs());
      // history and restore
      await evalp(async () => (await (globalThis as any).lazy.sharedMap()).showSharedMapVersions());
      await page.waitForTimeout(400);
      run.facts.versionsDialog = await evalp(() => (globalThis as any).__cons.alertState());
      await evalp(() => (globalThis as any).__cons.closeAllDialogs());
      run.facts.cloudRestoreStatus = await evalp(async () => {
        const w = globalThis as any;
        const m = await w.lazy.sharedMap();
        await w.__tupaia.awaitMap(() => m.restoreSharedMap(1), 120000);
        return true;
      }).catch((e: unknown) => String(e).slice(0, 200));
      await freeze(page);
      run.facts.afterRestore = await settled(run, page, "cloud restore");
      const text2 = await evalp(async () => (await (globalThis as any).lazy.save()).prepareMapData());
      put(run, "save-after-cloud-restore.map", text2);
      run.facts.cloudLog = cloud.log.map(({ method, path, version, overwrite, status }) => ({ method, path, version, overwrite, status }));
    });

    run.facts.hashEnd = await evalp(() => (globalThis as any).__cons.hashWorld());
    run.facts.final = await settled(run, page, "end", true);
  } catch (e) {
    run.failure = e instanceof Error ? e.message.slice(0, 400) : String(e);
  } finally {
    await context.close();
  }

  // heightmap preview needs customization mode, which edits the world: last, in its own page
  if (!onlySteps.length || onlySteps.includes("heightmap")) {
    const second = await openArm(world, arm, `${label}-heightmap`);
    try {
      await step(second.run, second.page, "heightmap", async () => {
        const text = readFileSync(WORLDS[world], "utf8");
        await second.page.evaluate(async (t: string) => {
          const w = globalThis as any;
          await w.__tupaia.fns.loadMap({ text: t, timeoutMs: 120000 });
          await w.__tupaia.settle();
        }, text);
        await freeze(second.page);
        run.facts.heightmapBefore = await settled(second.run, second.page, "heightmap: before", true);
        run.facts.heightmap = await second.page.evaluate(() => (globalThis as any).__cons.heightmapPreview());
        run.facts.heightmapAfter = await settled(second.run, second.page, "heightmap: in edit mode", true);
      });
    } finally {
      run.steps.push(...second.run.steps);
      run.errors.push(...second.run.errors.map(e => `[heightmap page] ${e}`));
      run.warnings.push(...second.run.warnings.map(w => `[heightmap page] ${w}`));
      await second.context.close();
    }
  }
  writeFileSync(join(run.dir, "facts.json"), JSON.stringify({ facts: run.facts, steps: run.steps, errors: run.errors, warnings: run.warnings, failure: run.failure, cloud: cloud.log }, null, 2));
  return run;
}

// ------------------------------------------------------------------ judging

const stepOf = (run: ArmRun, name: string) => run.steps.find(s => s.step === name);
const stepFailed = (run: ArmRun, name: string): string | null => {
  const s = stepOf(run, name);
  if (!s) return onlySteps.length ? null : `step "${name}" did not run`;
  return s.error ? `step "${name}" failed: ${s.error}` : null;
};
// the gpu arm must be on the gpu path (not fallen back to svg) when a probe starts and ends, or the comparison proves
// nothing about the gpu. Whether a canvas is showing at that instant does not matter: dialogs suspend it by design.
const gpuActive = (run: ArmRun, name: string): string | null => {
  if (run.arm !== "gpu") return null;
  const s = stepOf(run, name);
  const ok = (st: Status | null) => !!st && st.active === "gpu" && !st.fallbackReason;
  if (s && ok(s.before) && ok(s.after)) return null;
  return `gpu arm not on the gpu path around "${name}": before ${JSON.stringify(s?.before && { a: s.before.active, f: s.before.fallbackReason })}, after ${JSON.stringify(s?.after && { a: s.after.active, f: s.after.fallbackReason })}`;
};

const decode = (bytes: Buffer) => decodePng(new Uint8Array(bytes));

// Browser rasterization of an SVG into a bitmap is not bit-stable between two pages (the control run measures it):
// when the SVG handed to the rasterizer is byte-identical between the arms, a bitmap that differs by a code value or
// two in a handful of pixels is rasterizer noise, not a renderer effect. Anything larger fails.
export const RASTER_NOISE = { changedMax: 0.0005, maxDelta: 2 } as const;
const withinNoise = (c: PixelComparison): boolean => !!c.sizeEqual && (c.changedFraction ?? 1) <= RASTER_NOISE.changedMax && (c.maxDelta ?? 255) <= RASTER_NOISE.maxDelta;

function judgePixels(row: number, id: string, name: string, a: Buffer | undefined, b: Buffer | undefined, inputsIdentical: boolean | null, evidence: string): Check {
  if (!a || !b) return fail(row, id, name, `missing: svg ${!!a}, gpu ${!!b}`, evidence);
  try {
    const cmp = comparePixels(decode(a), decode(b));
    if (cmp.equal) return pass(row, id, name, describePixels(cmp), evidence);
    if (inputsIdentical && withinNoise(cmp)) return pass(row, id, name, `rasterizer noise only (the SVG handed to the rasterizer is byte-identical): ${describePixels(cmp)}`, evidence);
    return fail(row, id, name, `${describePixels(cmp)}${inputsIdentical === null ? "" : inputsIdentical ? " (SVG input identical, difference exceeds rasterizer noise)" : " (SVG input differs too)"}`, evidence);
  } catch (e) {
    return fail(row, id, name, `decode: ${String(e).slice(0, 200)}`, evidence);
  }
}

function judgeWorld(world: string, svgRun: ArmRun, gpuRun: ArmRun): Check[] {
  const checks: Check[] = [];
  const both = [svgRun, gpuRun];
  const tag = (id: string) => `${world}.${id}`;
  const ev = (file: string) => `${world}/{${svgRun.label},${gpuRun.label}}/${file}`;
  const guard = (row: number, id: string, name: string, stepName: string): boolean => {
    if (!wants(stepName)) return false; // a limited run (CONSUMERS_STEPS) does not exercise this step
    for (const r of both) {
      const failed = stepFailed(r, stepName);
      if (failed) {
        checks.push(fail(row, tag(id), name, `${r.label}: ${failed}`));
        return false;
      }
    }
    const lost = gpuActive(gpuRun, stepName);
    if (lost) {
      checks.push(fail(row, tag(id), name, lost));
      return false;
    }
    return true;
  };
  const errorsIn = (stepName: string) => both.flatMap(r => (stepOf(r, stepName)?.errors ?? []).map(e => `${r.label}: ${e}`));
  const noErrors = (row: number, stepName: string) => {
    const errs = errorsIn(stepName);
    checks.push(verdict(!errs.length, row, tag(`${stepName}.no-page-errors`), `no page errors during the ${stepName} step`, errs.join(" | ").slice(0, 400)));
  };
  const textDiff = (a: string, b: string) => {
    const d = firstDifference(a ?? "", b ?? "");
    return d ? `@${d.offset}: svg ${JSON.stringify(d.a.slice(60, 200))} | gpu ${JSON.stringify(d.b.slice(60, 200))}` : "";
  };
  const sameBytes = (file: string) => !!svgRun.bytes[file] && !!gpuRun.bytes[file] && Buffer.compare(svgRun.bytes[file], gpuRun.bytes[file]) === 0;
  const GPU = gpuRun.label;

  // ---------------- row 31: save .map
  if (guard(31, "save.ran", "save step completed in both arms (gpu arm on the gpu path)", "save")) {
    const s = svgRun.texts["save-trade-on.map"];
    const g = gpuRun.texts["save-trade-on.map"];
    const sSections = splitSections(s);
    const gSections = splitSections(g);
    checks.push(verdict(sSections.length === SECTION_COUNT && gSections.length === SECTION_COUNT, 31, tag("save.sections"), "46 CRLF sections in both arms", `svg ${sSections.length}, gpu ${gSections.length}`, ev("save-trade-on.map")));
    const isSvg = (t: string) => /^<svg[^>]*id="map"/.test(t ?? "");
    checks.push(verdict(isSvg(sSections[SVG_SECTION]) && isSvg(gSections[SVG_SECTION]), 31, tag("save.svg-index"), "the SVG is section 5 (I3, I10) in both arms", "", ev("save-trade-on.map")));
    const cmp = compareSaves(s, g);
    checks.push(verdict(cmp.equal, 31, tag("save.arms-equal"), "gpu save equals svg save at a non-identity camera, every section, header masked (date and map id)", describeSaveDiff(cmp), ev("save-trade-on.map")));
    const sv = cmp.differing.find(d => d.index === SVG_SECTION);
    checks.push(verdict(!sv && sSections[SVG_SECTION] === gSections[SVG_SECTION], 31, tag("save.svg-section-identical"), "SVG section (index 5) identical between arms (I1, I8)", sv ? `first difference @${sv.diff.offset}: svg ${JSON.stringify(sv.diff.a.slice(60, 200))} | gpu ${JSON.stringify(sv.diff.b.slice(60, 200))}` : "", ev("save-trade-on.map")));
    const camera = (r: ArmRun) => r.facts.saveOn?.cameraBefore;
    checks.push(verdict(!!camera(svgRun) && camera(svgRun).scale === CAMERA.k && camera(gpuRun).scale === CAMERA.k, 31, tag("save.camera-non-identity"), `the saves ran at scale ${CAMERA.k}, not the identity`, `svg ${camera(svgRun)?.scale}, gpu ${camera(gpuRun)?.scale}`));
    checks.push(verdict(both.every(r => JSON.stringify(r.facts.saveOn?.cameraBefore) === JSON.stringify(r.facts.saveOn?.cameraAfter)), 31, tag("save.camera-untouched"), "saving does not move the live camera", both.map(r => `${r.label} ${JSON.stringify(r.facts.saveOn?.cameraAfter)}`).join(" | ")));
    for (const r of both) {
      const f: SvgFacts = r.facts.saveOn.facts;
      checks.push(...judgeSvgFacts(31, tag(`save.${r.label}`), r.label, f, { width: String(r.facts.saveOn.graph[0]), height: String(r.facts.saveOn.graph[1]), tradeOn: true }));
      const planted = r.facts.savePlanted;
      checks.push(verdict((planted.live.tradeChildren ?? 0) > 0 && (planted.live.rulerChildren ?? 0) > 0 && planted.facts.tradeChildren === 0 && planted.facts.rulerChildren === 0, 31, tag(`save.${r.label}.overlays-cleared`), "I9: a caravan in #tradeAnimation and a mark in #ruler that were in the live document are gone from the file", `live trade ${planted.live.tradeChildren}, ruler ${planted.live.rulerChildren}; saved trade ${planted.facts.tradeChildren}, ruler ${planted.facts.rulerChildren}`, ev("save-planted.map")));
      const off: SvgFacts = r.facts.saveOff.facts;
      checks.push(verdict(off.tradeLayerOff === "1", 31, tag(`save.${r.label}.trade-off`), "I11: trade layer off writes data-layer-off=1", `got ${JSON.stringify(off.tradeLayerOff)}`, ev("save-trade-off.map")));
      const again: SvgFacts = r.facts.saveOnAgain.facts;
      checks.push(verdict(again.tradeLayerOff === null, 31, tag(`save.${r.label}.trade-on-again`), "I11: trade layer restored clears data-layer-off", `got ${JSON.stringify(again.tradeLayerOff)}`, ev("save-trade-on-again.map")));
    }
    for (const name of ["save-planted.map", "save-trade-off.map", "save-trade-on-again.map"]) {
      const c = compareSaves(svgRun.texts[name], gpuRun.texts[name]);
      checks.push(verdict(c.equal, 31, tag(`save.arms-equal.${name}`), `${name}: gpu equals svg`, describeSaveDiff(c), ev(name)));
    }
    // I15: the planted #temp node. "Preserve current behaviour exactly": the arms must agree; whether it leaks is reported.
    const leak = (r: ArmRun) => r.facts.savePlanted?.facts?.tempLeak;
    checks.push(verdict(leak(svgRun) === leak(gpuRun), 31, tag("save.temp-same-behaviour"), "I15: a node planted in a #temp staging group is treated the same by both arms", `svg leaks=${leak(svgRun)}, gpu leaks=${leak(gpuRun)}`, ev("save-planted.map")));
    checks.push(info(31, tag("save.temp-leak-today"), "I15 today: does a node in a #temp staging group reach the save? (baseline behaviour; fixing it needs owner approval)", `svg ${leak(svgRun) ? "LEAKS" : "does not leak"}, gpu ${leak(gpuRun) ? "LEAKS" : "does not leak"}`));
    noErrors(31, "save");
  }

  // ---------------- row 32: binary, ldb, reload, I12, cloud
  if (guard(32, "binary.ran", "binary step completed in both arms (gpu arm on the gpu path)", "binary")) {
    for (const r of both) {
      const b = r.facts.binary;
      checks.push(verdict(b.isBinary && b.size > 1000, 32, tag(`binary.${r.label}.magic`), "prepareMapFile output is a binary TUPAIA map (isBinaryMap)", `${b.size} bytes`, ev("save.tupaia")));
      const text = r.texts["save-for-binary.map"];
      const decoded = compareSaves(text, r.texts["binary-decoded.map"]);
      checks.push(verdict(decoded.equal, 32, tag(`binary.${r.label}.equals-text`), "I14: the binary save decodes to the text save, header masked", describeSaveDiff(decoded), ev("save.tupaia")));
      const l = r.facts.ldb;
      checks.push(verdict(l.kind === "blob" && l.isBinary, 32, tag(`ldb.${r.label}.binary`), "saveMap('storage') stores a binary Blob in ldb lastMap", JSON.stringify(l)));
      const viaLdb = compareSaves(text, r.texts["ldb-decoded.map"] ?? "");
      checks.push(verdict(viaLdb.equal, 32, tag(`ldb.${r.label}.equals-text`), "ldb lastMap decodes to the text save", describeSaveDiff(viaLdb)));
      checks.push(verdict(r.facts.blocked?.sentinelKept === true && r.facts.blocked?.downloads === 0 && !r.facts.blocked?.error, 31, tag(`save.${r.label}.blocked-in-customization`), "I12: with customization on, saveMap('storage') and saveMap('machine') write and download nothing", JSON.stringify(r.facts.blocked)));
    }
    const arms = compareSaves(svgRun.texts["save-for-binary.map"], gpuRun.texts["save-for-binary.map"]);
    checks.push(verdict(arms.equal, 32, tag("binary.arms-equal"), "the text save behind the binary file is equal between arms", describeSaveDiff(arms), ev("save-for-binary.map")));
    const binArms = compareSaves(svgRun.texts["binary-decoded.map"] ?? "", gpuRun.texts["binary-decoded.map"] ?? "");
    checks.push(verdict(binArms.equal, 32, tag("binary.decoded-arms-equal"), "the decoded binary saves are equal between arms (I14 at the model level)", describeSaveDiff(binArms), ev("save.tupaia")));
    for (const name of ["save-after-binary-reload.map", "save-after-ldb-reload.map"]) {
      const sRound = compareSaves(svgRun.texts["save-for-binary.map"], svgRun.texts[name] ?? "");
      const gRound = compareSaves(gpuRun.texts["save-for-binary.map"], gpuRun.texts[name] ?? "");
      const between = compareSaves(svgRun.texts[name] ?? "", gpuRun.texts[name] ?? "");
      checks.push(verdict(between.equal, 32, tag(`reload.${name}.arms-equal`), `${name}: after the reload, gpu save equals svg save`, describeSaveDiff(between), ev(name)));
      // I2 is a property of the app: the gpu arm must be exactly as stable as the svg arm, whatever that is
      checks.push(verdict(sRound.equal === gRound.equal, 32, tag(`reload.${name}.same-stability`), `${name}: save→load→save is as stable in the gpu arm as in the svg arm`, `svg ${describeSaveDiff(sRound)} | gpu ${describeSaveDiff(gRound)}`));
      checks.push(sRound.equal ? pass(32, tag(`reload.${name}.svg-fixpoint`), "I2: save→load→save is byte-identical in the svg arm (header masked)") : info(32, tag(`reload.${name}.svg-fixpoint`), "I2 baseline: save→load→save differs in the SVG arm itself (not a gpu effect)", describeSaveDiff(sRound), ev(name)));
    }
    noErrors(32, "binary");
  }
  if (guard(32, "cloud.ran", "cloud step completed in both arms (gpu arm on the gpu path)", "cloud")) {
    for (const r of both) {
      const c1 = r.facts.cloud1;
      checks.push(verdict(c1.version === 1 && c1.hasBody && c1.bodyEqualsPage, 32, tag(`cloud.${r.label}.put-body`), "saveSharedMap PUTs the text save of the page (mocked Worker, header masked)", JSON.stringify(c1)));
      checks.push(verdict(r.facts.cloud2.version === 2, 32, tag(`cloud.${r.label}.second-save`), "a save after the load carries the loaded version and bumps it", JSON.stringify(r.facts.cloud2)));
      checks.push(verdict(r.facts.conflict?.visible === true && /changed/i.test(r.facts.conflict?.title ?? ""), 32, tag(`cloud.${r.label}.conflict`), "a 409 shows the 'Shared map changed' prompt", JSON.stringify(r.facts.conflict)));
      checks.push(verdict(r.facts.versionsDialog?.visible === true && r.facts.versionsDialog?.rows >= 1, 32, tag(`cloud.${r.label}.versions`), "showSharedMapVersions lists the retained versions", JSON.stringify(r.facts.versionsDialog)));
      checks.push(verdict(r.facts.cloudRestoreStatus === true && r.facts.cloudLog?.some((e: any) => e.method === "POST" && /restore\?v=1/.test(e.path) && e.status === 200), 32, tag(`cloud.${r.label}.restore`), "restoreSharedMap(1) POSTs the restore and reloads the restored version", String(r.facts.cloudRestoreStatus)));
    }
    const put1 = compareSaves(svgRun.texts["cloud-put-1.map"] ?? "", gpuRun.texts["cloud-put-1.map"] ?? "");
    checks.push(verdict(put1.equal, 32, tag("cloud.put-arms-equal"), "the body PUT to the Worker is equal between arms", describeSaveDiff(put1), ev("cloud-put-1.map")));
    for (const name of ["save-after-cloud-load.map", "save-after-cloud-restore.map"]) {
      const c = compareSaves(svgRun.texts[name] ?? "", gpuRun.texts[name] ?? "");
      checks.push(verdict(c.equal, 32, tag(`cloud.${name}.arms-equal`), `${name}: gpu equals svg`, describeSaveDiff(c), ev(name)));
    }
    noErrors(32, "cloud");
  }

  // ---------------- row 34: exports
  if (guard(34, "export.ran", "export step completed in both arms (gpu arm on the gpu path)", "export")) {
    checks.push(verdict(svgRun.facts.exportStable === true && gpuRun.facts.exportStable === true, 34, tag("export.stable"), "two full-map exports of one state are identical within each arm (the comparison is not noise)", `svg ${svgRun.facts.exportStable}, gpu ${gpuRun.facts.exportStable}`));
    checks.push(verdict(sameBytes("export.svg"), 34, tag("export.svg"), "exportToSvg: gpu file is byte-identical to the svg file", `${svgRun.bytes["export.svg"]?.length} vs ${gpuRun.bytes["export.svg"]?.length}`, ev("export.svg")));
    const full = textDiff(svgRun.texts["clone-svg-full.svg"], gpuRun.texts["clone-svg-full.svg"]);
    checks.push(verdict(!full, 34, tag("export.clone-full"), "getMapURL('svg', fullMap): gpu clone equals svg clone", full, ev("clone-svg-full.svg")));
    const vis = textDiff(svgRun.texts["clone-png.svg"], gpuRun.texts["clone-png.svg"]);
    checks.push(verdict(!vis, 34, tag("export.clone-visible"), "getMapURL('png') (visible part, current camera): gpu clone equals svg clone, so the canonical #viewbox transform equals the camera", vis, ev("clone-png.svg")));
    for (const r of both) {
      const f = r.facts.cloneFacts;
      checks.push(verdict(f?.parsed && f.canvases === 0 && f.gpuMarkers === 0 && f.viewportCulled === 0 && f.debugChildren === 0, 34, tag(`export.${r.label}.clone-clean`), "the export clone holds no canvas, gpu marker, viewport-culled class or debug content", JSON.stringify(f)));
    }
    const inputsPng = !vis;
    checks.push(judgePixels(34, tag("export.png"), "exportToPng: gpu image equals the svg image pixel for pixel", svgRun.bytes["export.png"], gpuRun.bytes["export.png"], inputsPng, ev("export.png")));
    for (const r of both) {
      const a = r.bytes["export.png"];
      const b = r.bytes["export-again.png"];
      if (a && b && !r.label.endsWith("tamper")) {
        const c = comparePixels(decode(a), decode(b));
        checks.push(info(34, tag(`export.${r.label}.png-repeat`), "noise floor: two exportToPng calls in one arm", describePixels(c), ev("export-again.png")));
      }
    }
    const jpegEqual = sameBytes("export.jpeg");
    const sizeClose = Math.abs((svgRun.bytes["export.jpeg"]?.length ?? 0) - (gpuRun.bytes["export.jpeg"]?.length ?? 0)) / Math.max(1, svgRun.bytes["export.jpeg"]?.length ?? 1) < 0.005;
    const pngChecked = checks.find(c => c.id === tag("export.png"));
    checks.push(verdict(jpegEqual || (pngChecked?.status === "PASS" && inputsPng && sizeClose), 34, tag("export.jpeg"), "exportToJpeg: gpu file equals the svg file (byte-identical, or the same encoder input up to rasterizer noise)", `${svgRun.bytes["export.jpeg"]?.length} vs ${gpuRun.bytes["export.jpeg"]?.length}${jpegEqual ? "" : "; bytes differ"}`, ev("export.jpeg")));
    try {
      const tiles = (r: ArmRun) => unzipTiles(new Uint8Array(r.bytes["export-tiles.zip"]));
      const st = tiles(svgRun);
      const gt = tiles(gpuRun);
      checks.push(verdict(JSON.stringify(st.map(([n]) => n)) === JSON.stringify(gt.map(([n]) => n)) && st.length >= 5, 34, tag("export.tiles-names"), "tiles: same entries in both arms (schema.png plus the 2x2 tiles)", `svg ${st.map(([n]) => n).join(",")} | gpu ${gt.map(([n]) => n).join(",")}`, ev("export-tiles.zip")));
      const inputsTiles = !textDiff(svgRun.texts["clone-tiles.svg"], gpuRun.texts["clone-tiles.svg"]) && !textDiff(svgRun.texts["clone-tiles-debug.svg"], gpuRun.texts["clone-tiles-debug.svg"]);
      const bad: string[] = [];
      let noisy = 0;
      for (let i = 0; i < Math.min(st.length, gt.length); i++) {
        if (st[i][0] !== gt[i][0]) continue;
        const c = judgePixels(34, "tile", st[i][0], Buffer.from(st[i][1]), Buffer.from(gt[i][1]), inputsTiles, "");
        if (c.status === "FAIL") bad.push(`${st[i][0]}: ${c.detail}`);
        else if (/noise/.test(c.detail)) noisy++;
      }
      checks.push(verdict(!bad.length, 34, tag("export.tiles-pixels"), "tiles: every tile and the schema equals the svg arm's pixel for pixel", bad.join("; ") || (noisy ? `${noisy} file(s) differ by rasterizer noise only (SVG input identical)` : "all identical"), ev("export-tiles.zip")));
      checks.push(verdict(inputsTiles, 34, tag("export.tiles-input"), "tiles: the SVG clones the tiles are cut from (schema and tiles) are byte-identical between arms", ""));
    } catch (e) {
      checks.push(fail(34, tag("export.tiles"), "tiles: could not read the archives", String(e).slice(0, 200), ev("export-tiles.zip")));
    }
    noErrors(34, "export");
  }

  // ---------------- row 36: 3D mesh texture, 3D view, satellite
  if (guard(36, "mesh.ran", "mesh step completed in both arms (gpu arm on the gpu path)", "mesh")) {
    for (const file of ["mesh-texture.svg", "mesh-texture-nolabels-nowater.svg"]) {
      const d = textDiff(svgRun.texts[file], gpuRun.texts[file]);
      checks.push(verdict(!d, 36, tag(`mesh.${file}`), `getMapURL('mesh') ${file}: gpu texture equals svg texture (I13: no overlay or renderer content added)`, d, ev(file)));
    }
    for (const r of both) {
      const f = r.facts.meshFacts;
      checks.push(verdict(f?.parsed && f.canvases === 0 && f.gpuMarkers === 0 && f.viewportCulled === 0 && f.debugChildren === 0 && f.viewboxTransform === null, 36, tag(`mesh.${r.label}.clean`), "the mesh texture holds no canvas, gpu marker, culling class or debug overlay, and no camera transform (I13)", JSON.stringify(f)));
    }
    const sameCamera = (r: ArmRun) => r.facts.afterMesh.camera.scale === r.facts.camera2.scale && r.facts.afterMesh.camera.viewX === r.facts.camera2.viewX && r.facts.afterMesh.camera.viewY === r.facts.camera2.viewY;
    checks.push(verdict(sameCamera(svgRun) && sameCamera(gpuRun), 36, tag("mesh.camera-restored"), "building the full-map texture leaves the live camera where it was", `svg ${JSON.stringify(svgRun.facts.afterMesh.camera)} | gpu ${JSON.stringify(gpuRun.facts.afterMesh.camera)}`));
  }
  if (guard(36, "view3d.ran", "3D view step completed in both arms (gpu arm on the gpu path)", "view3d")) {
    // The satellite water shimmer is not bit-stable between two screenshots of one page (the floor below), so that
    // view is held to the floor; the mesh view has no such noise and is held to D1.
    const floorOf = (again: string) => {
      const fl = both.filter(r => r.bytes[again] && r.bytes[again.replace("-again", "")]).map(r => comparePixels(decode(r.bytes[again.replace("-again", "")]), decode(r.bytes[again])));
      return fl.length ? { changed: Math.max(...fl.map(c => c.changedFraction ?? 0)), over16: Math.max(...fl.map(c => c.over16Fraction ?? 0)) } : null;
    };
    const view = (file: string, label: string, floor: { changed: number; over16: number } | null = null) => {
      try {
        const cmp = comparePixels(decode(svgRun.bytes[file]), decode(gpuRun.bytes[file]));
        const ok = floor ? cmp.equal || ((cmp.changedFraction ?? 1) <= floor.changed * 1.5 + 0.0005 && (cmp.over16Fraction ?? 1) <= floor.over16 * 1.5 + 0.0005 && (cmp.ssim ?? 0) >= 0.95) : withinD1(cmp);
        checks.push(verdict(ok, 36, tag(`view3d.${file}`), floor ? `3D view, ${label}: gpu screenshot no further from the svg screenshot than two screenshots of one page are from each other (x1.5, ssim >= 0.95)` : `3D view, ${label}: gpu screenshot within D1 of the svg screenshot`, `${describePixels(cmp)}${floor ? `; floor changed ${(floor.changed * 100).toFixed(3)}% over16 ${(floor.over16 * 100).toFixed(3)}%` : ""}`, ev(file)));
        if (!cmp.equal) checks.push(info(36, tag(`view3d.${file}.exact`), "3D view screenshot is not pixel-identical", describePixels(cmp), ev(file)));
      } catch (e) {
        checks.push(fail(36, tag(`view3d.${file}`), "3D view: decode", String(e).slice(0, 200), ev(file)));
      }
    };
    // The mesh view is the 3D scene textured with the rasterized mesh SVG. When that SVG is byte-identical between the
    // arms (checked under "mesh" above) a few edge pixels still move with the rasterizer (a control run measures it), so
    // the view is held to D1's ssim, over16 and changed gates; the max-delta gate is for unexplained differences.
    const meshInputsIdentical = ["mesh-texture.svg", "mesh-texture-nolabels-nowater.svg"].every(f => !textDiff(svgRun.texts[f], gpuRun.texts[f]));
    {
      const file = "view3d-mesh.png";
      try {
        const cmp = comparePixels(decode(svgRun.bytes[file]), decode(gpuRun.bytes[file]));
        const loose = !!cmp.sizeEqual && (cmp.ssim ?? 0) >= 0.95 && (cmp.over16Fraction ?? 1) <= 0.01 && (cmp.changedFraction ?? 1) <= 0.005;
        checks.push(verdict(withinD1(cmp) || (meshInputsIdentical && loose), 36, tag(`view3d.${file}`), "3D view, mesh view textured from the map: gpu screenshot within D1 of the svg screenshot (max delta excused when the mesh texture SVG is byte-identical)", `${describePixels(cmp)}; mesh texture identical ${meshInputsIdentical}`, ev(file)));
        if (!cmp.equal) checks.push(info(36, tag(`view3d.${file}.exact`), "3D view screenshot is not pixel-identical", describePixels(cmp), ev(file)));
      } catch (e) {
        checks.push(fail(36, tag(`view3d.${file}`), "3D view: decode", String(e).slice(0, 200), ev(file)));
      }
    }
    view("view3d-satellite.png", "satellite mode (procedural texture, unchanged)", floorOf("view3d-satellite-again.png"));
    for (const r of both) {
      if (r.bytes["view3d-satellite.png"] && r.bytes["view3d-satellite-again.png"]) {
        const c = comparePixels(decode(r.bytes["view3d-satellite.png"]), decode(r.bytes["view3d-satellite-again.png"]));
        checks.push(info(36, tag(`view3d.${r.label}.satellite-repeat`), "noise floor: two satellite screenshots in one arm", describePixels(c), ev("view3d-satellite-again.png")));
      }
    }
    checks.push(verdict(gpuRun.facts.afterView3d?.active === "gpu" && gpuRun.facts.afterView3d?.canvasVisible === true && !gpuRun.facts.afterView3d?.waitError, 36, tag("view3d.gpu-resumes"), "after leaving the 3D view the gpu canvas is visible again", JSON.stringify(gpuRun.facts.afterView3d && { a: gpuRun.facts.afterView3d.active, v: gpuRun.facts.afterView3d.canvasVisible, s: gpuRun.facts.afterView3d.suspendedReason, w: gpuRun.facts.afterView3d.waitError })));
    noErrors(36, "view3d");
  }

  // ---------------- row 37: transform tool preview
  if (guard(37, "transform.ran", "transform-preview step completed in both arms (gpu arm on the gpu path)", "transform")) {
    for (const r of both) {
      const t = r.facts.transform;
      checks.push(verdict(t.width === t.expected[0] && Math.abs(t.height - t.expected[1]) <= 1 && t.ink > 1000, 37, tag(`transform.${r.label}.size`), "the preview canvas is 4x the dialog size and holds the map", JSON.stringify({ w: t.width, h: t.height, expected: t.expected, ink: t.ink })));
    }
    const inputs = !textDiff(svgRun.texts["clone-transform.svg"], gpuRun.texts["clone-transform.svg"]);
    checks.push(verdict(inputs, 37, tag("transform.input"), "the SVG the preview is rasterized from (noWater, fullMap, no labels/scale bar/vignette/ice) is byte-identical between arms", textDiff(svgRun.texts["clone-transform.svg"], gpuRun.texts["clone-transform.svg"]), ev("clone-transform.svg")));
    checks.push(judgePixels(37, tag("transform.pixels"), "the 4x preview equals the svg arm's pixel for pixel", svgRun.bytes["transform-preview.png"], gpuRun.bytes["transform-preview.png"], inputs, ev("transform-preview.png")));
    const same = (r: ArmRun) => r.facts.transform.camera.scale === r.facts.camera2.scale && r.facts.transform.camera.viewX === r.facts.camera2.viewX && r.facts.transform.camera.viewY === r.facts.camera2.viewY;
    checks.push(verdict(same(svgRun) && same(gpuRun), 37, tag("transform.camera-untouched"), "the full-map preview does not move the camera (scale and view offsets)", JSON.stringify({ svg: svgRun.facts.transform.camera, gpu: gpuRun.facts.transform.camera })));
    checks.push(info(37, tag("transform.viewbox-attribute"), "the live #viewbox transform attribute while the tool is open", `svg ${JSON.stringify(svgRun.facts.transform.camera.viewboxTransform)}, gpu ${JSON.stringify(gpuRun.facts.transform.camera.viewboxTransform)}`));
    checks.push(verdict(gpuRun.facts.afterTransform?.active === "gpu" && !gpuRun.facts.afterTransform?.waitError, 37, tag("transform.gpu-active"), "after closing the dialog the gpu renderer is active and settles", JSON.stringify(gpuRun.facts.afterTransform && { a: gpuRun.facts.afterTransform.active, f: gpuRun.facts.afterTransform.fallbackReason, w: gpuRun.facts.afterTransform.waitError })));
    noErrors(37, "transform");
  }

  // ---------------- row 35: minimap
  if (guard(35, "minimap.ran", "minimap step completed in both arms (gpu arm on the gpu path)", "minimap")) {
    const so = svgRun.facts.minimapOpen;
    const go = gpuRun.facts.minimapOpen;
    checks.push(verdict(JSON.stringify([so.viewport, so.use, so.viewBox]) === JSON.stringify([go.viewport, go.use, go.viewBox]), 35, tag("minimap.rect"), "the minimap viewport rectangle and map transform are identical between arms at the same camera", `svg ${JSON.stringify([so.viewport, so.use])} | gpu ${JSON.stringify([go.viewport, go.use])}`));
    for (const r of both) {
      const c = r.facts.minimapClick;
      const near = Math.abs(c.centre.x - c.expected.x) < 0.5 && Math.abs(c.centre.y - c.expected.y) < 0.5;
      checks.push(verdict(near, 35, tag(`minimap.${r.label}.click-target`), "click-to-pan centres the view on the world point under the click (0.5 world units)", `expected ${JSON.stringify(c.expected)}, view centre ${JSON.stringify(c.centre)}`));
    }
    const sc = svgRun.facts.minimapClick;
    const gc = gpuRun.facts.minimapClick;
    checks.push(verdict(Math.abs(sc.centre.x - gc.centre.x) < 0.01 && Math.abs(sc.centre.y - gc.centre.y) < 0.01 && sc.camera.scale === gc.camera.scale, 35, tag("minimap.click-arms-equal"), "the click-to-pan target and scale equal the svg arm's", `svg ${JSON.stringify(sc.centre)}@${sc.camera.scale} | gpu ${JSON.stringify(gc.centre)}@${gc.camera.scale}`));
    const sa = svgRun.facts.cameraAfterMinimap;
    const ga = gpuRun.facts.cameraAfterMinimap;
    checks.push(verdict(sa.scale === ga.scale && sa.viewX === ga.viewX && sa.viewY === ga.viewY, 35, tag("minimap.camera-after-close"), "after the minimap closes the gpu arm's camera equals the svg arm's", `svg ${JSON.stringify(sa)} | gpu ${JSON.stringify(ga)}`));
    const after = gpuRun.facts.afterMinimap;
    checks.push(verdict(after?.active === "gpu" && after?.canvasVisible === true && !after?.waitError && ga.canonicalStale !== true, 35, tag("minimap.gpu-resumes"), "closing the minimap resumes the gpu canvas on the clicked camera", JSON.stringify(after && { a: after.active, v: after.canvasVisible, s: after.suspendedReason, w: after.waitError, stale: ga.canonicalStale })));
    checks.push(info(35, tag("minimap.suspends"), "renderer state while the minimap is open (bridge today: the gpu canvas is suspended and the SVG draws)", `gpu: ${JSON.stringify(go.status && { visible: go.status.canvasVisible, suspended: go.status.suspendedReason, active: go.status.active })}`));
    noErrors(35, "minimap");
  }

  // ---------------- row 38: dialogs
  if (guard(38, "elevation.ran", "elevation-profile step completed in both arms (gpu arm on the gpu path)", "elevation")) {
    const se = svgRun.facts.elevation;
    const ge = gpuRun.facts.elevation;
    if (se.skipped || ge.skipped) checks.push(skip(38, tag("elevation"), "elevation profile", `not exercised: ${se.skipped ?? ge.skipped}`));
    else {
      checks.push(verdict(se.visible && ge.visible && se.paths > 0 && ge.paths > 0, 38, tag("elevation.content"), "the elevation profile renders a non-empty chart in both arms", `svg ${se.paths} paths, gpu ${ge.paths} paths`));
      checks.push(verdict(se.graphSha === ge.graphSha, 38, tag("elevation.chart"), "the chart markup is identical between arms", `${se.graphSha?.slice(0, 12)} vs ${ge.graphSha?.slice(0, 12)}`, ev("elevation-graph.svg.html")));
      for (const file of ["elevation.csv", "elevation.svg"])
        checks.push(verdict(sameBytes(file), 38, tag(`elevation.${file}`), `${file} download is byte-identical between arms`, `${svgRun.bytes[file]?.length} vs ${gpuRun.bytes[file]?.length}`, ev(file)));
      checks.push(judgePixels(38, tag("elevation.png"), "elevation.png equals the svg arm's pixel for pixel", svgRun.bytes["elevation.png"], gpuRun.bytes["elevation.png"], sameBytes("elevation.svg"), ev("elevation.png")));
    }
    checks.push(verdict(gpuRun.facts.afterElevation?.active === "gpu" && !gpuRun.facts.afterElevation?.waitError, 38, tag("elevation.gpu-active"), "after closing the dialog the gpu renderer is active and settles", JSON.stringify(gpuRun.facts.afterElevation && { a: gpuRun.facts.afterElevation.active, f: gpuRun.facts.afterElevation.fallbackReason, w: gpuRun.facts.afterElevation.waitError })));
    noErrors(38, "elevation");
  }
  if (guard(38, "charts.ran", "charts step completed in both arms (gpu arm on the gpu path)", "charts")) {
    const sc = svgRun.facts.charts;
    const gc = gpuRun.facts.charts;
    checks.push(verdict(sc.visible && gc.visible && sc.figures >= 1 && gc.figures >= 1 && sc.bars > 0 && gc.bars > 0, 38, tag("charts.content"), "the charts overview renders a non-empty chart in both arms", `svg ${sc.figures} figure/${sc.bars} marks, gpu ${gc.figures}/${gc.bars}`));
    checks.push(verdict(sc.htmlSha === gc.htmlSha, 38, tag("charts.chart"), "the chart markup is identical between arms", `${sc.htmlSha?.slice(0, 12)} vs ${gc.htmlSha?.slice(0, 12)}`, ev("charts-figure.html")));
    for (const file of ["charts.csv", "charts.svg"])
      checks.push(verdict(sameBytes(file), 38, tag(`charts.${file}`), `${file} download is byte-identical between arms`, `${svgRun.bytes[file]?.length} vs ${gpuRun.bytes[file]?.length}`, ev(file)));
    checks.push(judgePixels(38, tag("charts.png"), "charts.png equals the svg arm's pixel for pixel", svgRun.bytes["charts.png"], gpuRun.bytes["charts.png"], sameBytes("charts.svg"), ev("charts.png")));
    checks.push(verdict(gpuRun.facts.afterCharts?.active === "gpu" && !gpuRun.facts.afterCharts?.waitError, 38, tag("charts.gpu-active"), "after closing the dialog the gpu renderer is active and settles", JSON.stringify(gpuRun.facts.afterCharts && { a: gpuRun.facts.afterCharts.active, f: gpuRun.facts.afterCharts.fallbackReason, w: gpuRun.facts.afterCharts.waitError })));
    noErrors(38, "charts");
  }
  if (guard(38, "emblem.ran", "emblem step completed in both arms (gpu arm on the gpu path)", "emblem")) {
    const se = svgRun.facts.emblem;
    const ge = gpuRun.facts.emblem;
    if (se.skipped || ge.skipped) checks.push(skip(38, tag("emblem"), "emblem export", `not exercised: ${se.skipped ?? ge.skipped}`));
    else {
      checks.push(verdict(se.visible && ge.visible && se.coaInDoc && ge.coaInDoc && !!se.imageHref && !!ge.imageHref, 38, tag("emblem.content"), "the emblem editor resolves the coat of arms from #coas in both arms", JSON.stringify({ svg: [se.visible, se.coaInDoc, !!se.imageHref], gpu: [ge.visible, ge.coaInDoc, !!ge.imageHref] })));
      checks.push(verdict(sameBytes("emblem.svg"), 38, tag("emblem.svg"), "emblem.svg download is byte-identical between arms", `${svgRun.bytes["emblem.svg"]?.length} vs ${gpuRun.bytes["emblem.svg"]?.length} ${svgRun.facts["emblem.svg:error"] ?? ""} ${gpuRun.facts["emblem.svg:error"] ?? ""}`, ev("emblem.svg")));
      checks.push(judgePixels(38, tag("emblem.png"), "emblem.png equals the svg arm's pixel for pixel", svgRun.bytes["emblem.png"], gpuRun.bytes["emblem.png"], sameBytes("emblem.svg"), ev("emblem.png")));
      const jpegOk = sameBytes("emblem.jpeg") || (sameBytes("emblem.svg") && Math.abs((svgRun.bytes["emblem.jpeg"]?.length ?? 0) - (gpuRun.bytes["emblem.jpeg"]?.length ?? 0)) / Math.max(1, svgRun.bytes["emblem.jpeg"]?.length ?? 1) < 0.005);
      checks.push(verdict(jpegOk && !!svgRun.bytes["emblem.jpeg"] && !!gpuRun.bytes["emblem.jpeg"], 38, tag("emblem.jpeg"), "emblem.jpeg equals the svg arm's (byte-identical, or the same input up to rasterizer noise)", `${svgRun.bytes["emblem.jpeg"]?.length} vs ${gpuRun.bytes["emblem.jpeg"]?.length}`, ev("emblem.jpeg")));
    }
    checks.push(verdict(gpuRun.facts.afterEmblem?.active === "gpu" && !gpuRun.facts.afterEmblem?.waitError, 38, tag("emblem.gpu-active"), "after closing the editor the gpu renderer is active and settles", JSON.stringify(gpuRun.facts.afterEmblem && { a: gpuRun.facts.afterEmblem.active, f: gpuRun.facts.afterEmblem.fallbackReason, w: gpuRun.facts.afterEmblem.waitError })));
    noErrors(38, "emblem");
  }
  {
    // heightmap edit mode is customization: the gpu canvas may be suspended, but the renderer must not die
    const failed = both.map(r => stepFailed(r, "heightmap")).filter(Boolean);
    if (wants("heightmap") && failed.length) checks.push(fail(38, tag("heightmap.ran"), "heightmap-preview step completed in both arms", failed.join(" | ")));
    else if (wants("heightmap")) {
      const sh = svgRun.facts.heightmap;
      const gh = gpuRun.facts.heightmap;
      if (sh.error || gh.error) checks.push(fail(38, tag("heightmap"), "heightmap preview", `svg ${sh.error ?? "ok"} | gpu ${gh.error ?? "ok"}`));
      else {
        checks.push(verdict(sh.width === sh.expected[0] && sh.height === sh.expected[1] && sh.max > sh.min && gh.width === gh.expected[0] && gh.height === gh.expected[1] && gh.max > gh.min, 38, tag("heightmap.content"), "the heightmap preview canvas is cellsX x cellsY and not uniform in both arms", JSON.stringify({ svg: [sh.width, sh.height, sh.min, sh.max], gpu: [gh.width, gh.height, gh.min, gh.max] })));
        checks.push(verdict(sh.hash === gh.hash, 38, tag("heightmap.pixels"), "the heightmap preview pixels are identical between arms", `${sh.hash.slice(0, 12)} vs ${gh.hash.slice(0, 12)}`));
      }
      const after = gpuRun.facts.heightmapAfter;
      checks.push(verdict(!!after && after.active === "gpu" && !after.fallbackReason, 38, tag("heightmap.gpu-survives"), "entering heightmap edit mode (customization) suspends the gpu renderer; it must not fail and fall back for the session", JSON.stringify(after && { active: after.active, suspended: after.suspendedReason, fallback: after.fallbackReason })));
    }
  }

  // ---------------- row 40: window.pack / window.grid are untouched by the renderer
  if (wants("navigation") && wants("binary") && wants("cloud")) {
    const missing = both.map(r => (r.facts.hash0 && r.facts.hash1 && r.facts.hashEnd ? null : `${r.label}: hashes missing (${stepFailed(r, "boot") ?? stepFailed(r, "navigation") ?? "end"})`)).filter(Boolean);
    if (missing.length) checks.push(fail(40, tag("api.ran"), "world hashes recorded in both arms", missing.join("; ")));
    else {
      for (const r of both) {
        const changed = Object.keys(r.facts.hash0.hash).filter(k => r.facts.hash0.hash[k] !== r.facts.hash1.hash[k]);
        checks.push(verdict(!changed.length && r.facts.sameObjects === true, 40, tag(`api.${r.label}.read-only`), "pure navigation (4 zoom/pan moves, settled) leaves pack, grid and their members byte-identical, and window.pack/grid are the same objects", changed.length ? `changed: ${changed.slice(0, 8).join(", ")}` : `${r.facts.hash0.keys} members hashed; same objects ${r.facts.sameObjects}`));
      }
      const differs = (key: string) => Object.keys(svgRun.facts[key].hash).filter(k => svgRun.facts[key].hash[k] !== gpuRun.facts[key].hash[k] && k !== "mapId");
      for (const [key, name] of [["hash0", "after loading the same map"], ["hash1", "after the navigation sequence"], ["hash2", "after the binary and ldb reloads"], ["hashEnd", "after every probe (reloads, cloud load, restore)"]] as const) {
        if (!svgRun.facts[key] || !gpuRun.facts[key]) {
          checks.push(fail(40, tag(`api.${key}`), `${name}: pack and grid hash recorded`, "missing"));
          continue;
        }
        const d = differs(key);
        checks.push(verdict(!d.length, 40, tag(`api.${key}-arms-equal`), `${name}, pack and grid hash equal between arms`, d.length ? `differ: ${d.slice(0, 8).join(", ")}` : `${svgRun.facts[key].keys} members`));
      }
    }
  }

  // ---------------- whole-run hygiene
  for (const r of both) {
    if (r.failure) checks.push(fail("run", tag(`run.${r.label}`), "arm ran to completion", r.failure));
    const stepErrors = r.steps.filter(s => s.error).map(s => `${s.step}: ${s.error}`);
    if (stepErrors.length) checks.push(fail("run", tag(`run.${r.label}.steps`), "every step completed", stepErrors.join(" | ").slice(0, 600)));
    const gl = r.warnings.filter(w => /GL_INVALID_|Feedback loop/i.test(w));
    checks.push(verdict(!gl.length, "run", tag(`run.${r.label}.webgl-warnings`), "no WebGL validation warnings", gl.slice(0, 3).join(" | ")));
    const real = r.errors.filter(e => !/fonts\.gstatic|Failed to load resource/i.test(e));
    checks.push(verdict(!real.length, "run", tag(`run.${r.label}.page-errors`), "no uncaught page errors in the whole run", real.slice(0, 3).join(" | ").slice(0, 400)));
  }
  const settleLog = (gpuRun.facts.settle ?? []) as Array<{ label: string; waitedMs: number | null; waitError: string | null }>;
  const unsettled = settleLog.filter(x => x.waitError);
  checks.push(verdict(!unsettled.length, "run", tag("run.gpu-settles"), "the gpu renderer settled (no prepare, refinement or suspension left pending) after every world change and dialog", unsettled.map(x => `${x.label}: ${x.waitError}`).join(" | ")));
  const slowest = [...settleLog].sort((a, b) => (b.waitedMs ?? 0) - (a.waitedMs ?? 0)).slice(0, 4);
  checks.push(info("run", tag("run.gpu-settle-times"), "slowest times for the gpu renderer to settle", slowest.map(x => `${x.label} ${((x.waitedMs ?? 0) / 1000).toFixed(1)}s`).join(", ")));
  const gpuFinal = gpuRun.facts.final;
  checks.push(verdict(!!gpuFinal && gpuFinal.active === "gpu" && !gpuFinal.fallbackReason, "run", tag("run.gpu-never-fell-back"), "the gpu arm is still on the gpu path at the end of the run", JSON.stringify(gpuFinal && { a: gpuFinal.active, f: gpuFinal.fallbackReason })));
  void GPU;
  return checks;
}

// ------------------------------------------------------------------ main

const report = {
  schema: 1,
  runStartedUtc: new Date().toISOString(),
  args: { worlds: worldNames, arms: armNames, dpr, steps: onlySteps, break: breakMode, control },
  fixtures: {} as Record<string, string>,
  diagnosticBreak: breakMode !== "none" ? `${breakMode}: the gpu arm's data is deliberately perturbed; this run is expected to FAIL` : null,
  failure: null as string | null,
  rows: {} as Record<string, { status: string; checks: number; failed: number }>,
  checks: [] as Check[],
  arms: {} as Record<string, { failure: string | null; errors: number; steps: Array<{ step: string; ms: number; error: string | null }> }>
};

try {
  const judged = armNames.length === 2;
  for (const world of worldNames) {
    if (!WORLDS[world]) throw Error(`unknown world ${world}`);
    report.fixtures[world] = `${WORLDS[world]} sha256 ${sha256(readFileSync(WORLDS[world])).slice(0, 12)}`;
    const runs = {} as Record<Arm, ArmRun>;
    for (const arm of armNames) {
      // control: the "gpu" arm is a second, independent svg page, so the noise of the harness itself shows up
      const candidate = control && arm === "gpu";
      log(`${world}/${candidate ? "svg-control" : arm}`);
      runs[arm] = await runArm(world, candidate ? "svg" : arm, candidate ? "svg-control" : arm);
      report.arms[`${world}/${runs[arm].label}`] = { failure: runs[arm].failure, errors: runs[arm].errors.length, steps: runs[arm].steps.map(s => ({ step: s.step, ms: s.ms, error: s.error })) };
    }
    if (judged) {
      const checks = judgeWorld(world, runs.svg, runs.gpu);
      // a control has no gpu arm: the checks that assert the gpu renderer is active are not applicable to it
      report.checks.push(...(control ? checks.map(c => (/\.(gpu-active|gpu-resumes|gpu-survives|gpu-never-fell-back)$/.test(c.id) ? skip(c.row, c.id, c.name, "control run: no gpu arm") : c)) : checks));
    }
  }
  for (const row of [31, 32, 34, 35, 36, 37, 38, 40, "run"]) {
    const mine = report.checks.filter(c => String(c.row) === String(row));
    report.rows[String(row)] = { status: rowStatus(report.checks, row), checks: mine.length, failed: mine.filter(c => c.status === "FAIL").length };
  }
  const failed = report.checks.filter(c => c.status === "FAIL");
  if (!judged) report.failure = "not judged: a single arm was run (CONSUMERS_ARMS), see facts.json under each arm";
  else report.failure = failed.length ? `${failed.length} check(s) failed: ${failed.slice(0, 6).map(c => `${c.id} (${c.detail.slice(0, 120)})`).join("; ")}` : null;
} catch (e) {
  report.failure = `harness: ${e instanceof Error ? e.stack?.split("\n").slice(0, 3).join(" ") : String(e)}`;
  process.exitCode = 1;
} finally {
  writeFileSync(join(outDir, "consumers.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ failure: report.failure, rows: report.rows }, null, 2));
  await browser.close();
  await new Promise<void>(done => server.close(() => done()));
}
