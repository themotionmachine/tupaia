// Builds tests/fixtures/parity/parity-v1.map and parity-v1.json: a small deterministic map in which every row of the
// REWRITE-PLAN §5 parity matrix has real content, so goldens and replays test something.
//
//   node bench/host/fixtures/build-parity-fixture.ts              # build, write into tests/fixtures/parity/
//   node bench/host/fixtures/build-parity-fixture.ts --out DIR    # write somewhere else (default for experiments)
//   node bench/host/fixtures/build-parity-fixture.ts --verify     # load the committed file and re-check its census
//
// It serves dist/ (build it first: `npm run gate -- build`), drives ONE headless page through the app's own
// functions (the MCP bridge for generate and layers, parity-page.js for each feature), saves with prepareMapData,
// reloads the saved text in a second page and compares. Nothing touches the network: every non-local request is
// aborted, so fonts are the host's fallback fonts and the result does not depend on Google Fonts being reachable.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { checkCensus, FEATURES, rowsCovered, type ExpectationFailure } from "./features.ts";
import {
  PAGE_SCRIPT, PARITY_CONFIG as C, PARITY_DIR, PARITY_LAYERS_ON, REPO_ROOT,
  sha256File, type CameraPreset, type ParityManifest
} from "./index.ts";
import { checkDist, startStaticServer } from "../../../mcp/src/static-server.ts";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const VIEW = { width: C.width, height: C.height };

// ------------------------------------------------------------------ deterministic icon bytes

function png(w: number, h: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** A 24x24 RGBA icon with a transparent corner and a diagonal gradient: exercises alpha and colour. */
const PNG_ICON = png(24, 24, (x, y) => {
  const inside = (x - 11.5) ** 2 + (y - 11.5) ** 2 < 11 ** 2;
  return inside ? [Math.round(40 + x * 8), Math.round(200 - y * 6), Math.round(60 + (x + y) * 4), 255] : [0, 0, 0, 0];
});
const SVG_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#e53935"/><path d="M6 13l4 4 8-9" fill="none" stroke="#fff" stroke-width="3"/></svg>`;
const ICONS = {
  pngDataUri: `data:image/png;base64,${PNG_ICON.toString("base64")}`,
  svgDataUri: `data:image/svg+xml,${encodeURIComponent(SVG_ICON)}`
};

// ------------------------------------------------------------------ browser plumbing

async function openPage(origin: string, browser: Awaited<ReturnType<typeof chromium.launch>>): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, serviceWorkers: "block" });
  await context.addInitScript(() => {
    localStorage.setItem("autosaveInterval", "0");
    localStorage.setItem("azgaarAssistant", "hide");
  });
  const bridge = ["bridge.js", "bridge-mutations.js", ...readdirSync(resolve(REPO_ROOT, "mcp/src/bridge-ext")).filter(n => n.endsWith(".js")).sort().map(n => `bridge-ext/${n}`)];
  await context.addInitScript(bridge.map(n => readFileSync(resolve(REPO_ROOT, "mcp/src", n), "utf8")).join("\n"));
  await context.addInitScript(readFileSync(PAGE_SCRIPT, "utf8"));
  await context.route("**/*", route => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("dialog", d => void d.dismiss());
  await page.goto(`${origin}/?local&seed=${C.seed}&width=${C.width}&height=${C.height}`);
  await page.evaluate(async () => {
    const t = (globalThis as any).__tupaia;
    const ready = await t.call("ready", { timeoutMs: 120000 });
    if (!ready.ok) throw Error(JSON.stringify(ready));
  });
  return { page, errors };
}

/** One bridge call; throws with the envelope on failure. */
async function bridge<T = any>(page: Page, name: string, args: unknown = {}): Promise<T> {
  const env = await page.evaluate(([n, a]) => (globalThis as any).__tupaia.call(n, a), [name, args] as const);
  if (!env.ok) throw new Error(`bridge ${name} failed: ${JSON.stringify(env.error)} ${JSON.stringify(env.alerts ?? "")}`);
  return env.value as T;
}

const settle = (page: Page) =>
  page.evaluate(async () => {
    await (globalThis as any).__tupaia.settle?.();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  });

async function loadText(page: Page, text: string): Promise<void> {
  await page.evaluate(async t => {
    const w = globalThis as any;
    await w.__tupaia.fns.loadMap({ text: t, timeoutMs: 120000 });
    await w.__tupaia.settle?.();
  }, text);
}

const step = async <T>(log: string[], name: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = Date.now();
  try {
    const out = await fn();
    log.push(`${name} ok ${Date.now() - t0}ms`);
    console.error(`  ${name}: ${JSON.stringify(out)?.slice(0, 160)}`);
    return out;
  } catch (err) {
    log.push(`${name} FAILED`);
    throw new Error(`step ${name}: ${err instanceof Error ? err.message : err}`);
  }
};

// ------------------------------------------------------------------ header normalisation

/** The app stamps today's date and Date.now() into line 0 of a saved map. Both are metadata only. */
export function normalizeHeader(text: string): string {
  const lines = text.split("\r\n");
  const f = lines[0].split("|");
  if (f.length < 7) throw new Error(`unexpected map header: ${lines[0].slice(0, 120)}`);
  f[2] = C.normalizedDate;
  f[6] = String(C.normalizedMapId);
  lines[0] = f.join("|");
  return lines.join("\r\n");
}

// ------------------------------------------------------------------ build

async function censusOf(page: Page, withPreamble: boolean): Promise<any> {
  if (withPreamble) {
    await page.evaluate(() => (globalThis as any).__parity.preamble());
    // the trade animation starts a moment after load
    await page.waitForTimeout(2500);
  }
  return page.evaluate(() => (globalThis as any).__parity.census());
}

/** Per layer element counts after reload + preamble; `min` is what a golden's census assertion should require. */
function layerCensus(census: any): ParityManifest["layerCensus"] {
  const runtime: Record<string, number> = { tradeAnimation: 1 }; // the animation's marker count varies from frame to frame
  const out: ParityManifest["layerCensus"] = {};
  for (const [id, l] of Object.entries<any>(census.layers)) out[id] = { elements: l.elements, min: runtime[id] ?? l.elements, tags: l.tags };
  return out;
}

/** Keep the view inside the map: at zoom k a 1280x720 viewport shows (1280/k)x(720/k) world units. */
function clampCentre(k: number, cx: number, cy: number, gw: number, gh: number): [number, number] {
  const halfW = VIEW.width / (2 * k);
  const halfH = VIEW.height / (2 * k);
  return [Math.min(Math.max(cx, halfW), Math.max(gw - halfW, halfW)), Math.min(Math.max(cy, halfH), Math.max(gh - halfH, halfH))];
}

function preset(id: string, k: number, cx0: number, cy0: number, covers: string[], gw: number, gh: number): CameraPreset {
  const [rawX, rawY] = clampCentre(k, cx0, cy0, gw, gh);
  const cx = Math.round(rawX * 10) / 10;
  const cy = Math.round(rawY * 10) / 10;
  return { id, k, cx, cy, x: Math.round((VIEW.width / 2 - cx * k) * 100) / 100, y: Math.round((VIEW.height / 2 - cy * k) * 100) / 100, covers };
}

function cameras(targets: any): { presets: CameraPreset[]; coast: CameraPreset[] } {
  const out: CameraPreset[] = [];
  const [gw, gh] = targets.graph as [number, number];
  const A = targets.anchor;
  const add = (id: string, k: number, cx: number, cy: number, covers: string[]) => out.push(preset(id, k, cx, cy, covers, gw, gh));
  add("k1-world", 1, gw / 2, gh / 2, ["every layer", "halo", "legend", "compass", "scale-bar", "vignette", "fog", "zones-stock-hatch", "ice", "data-layers", "labels", "emblems"]);
  for (const k of [2, 4, 8]) {
    add(`k${k}-showcase`, k, A.x, A.y, ["regiments", "markers", "measurers", "labels", "coastline-filter", "grid-dashed", "coordinates", "halo"]);
    // an ice feature the k 8 window (160 x 90) fits around without the clamp pushing it out of frame: the first dragged
    // iceberg sits above the map edge (y < 0), so framing ice[0] showed empty ocean at k 8
    const berg = targets.ice.find((b: any) => b.cx >= VIEW.width / 16 && b.cx <= gw - VIEW.width / 16 && b.cy >= VIEW.height / 16 && b.cy <= gh - VIEW.height / 16) ?? targets.ice[0];
    if (berg) add(`k${k}-ice`, k, berg.cx, berg.cy, ["ice"]);
    if (targets.compass) add(`k${k}-compass`, k, targets.compass.cx, targets.compass.cy, ["compass"]);
    const emblem = targets.emblems?.[0];
    if (emblem) add(`k${k}-emblem`, k, emblem.cx + 3, emblem.cy + 3, ["emblems"]);
    for (const n of k === 8 ? [0, 17] : k === 4 ? [0, 5, 29] : [0, 41]) {
      const z = targets.zones[n];
      if (z) add(`k${k}-hatch${n}`, k, z.cx, z.cy, ["zones-stock-hatch"]);
    }
  }
  // the coastline filter switches at k 1.5 and 2.6: one frame either side of each, and one in the middle
  const coast = [1.4, 1.6, 2.5, 2.7, 3].map(k => preset(`k${k}-coast`, k, A.x, A.y, ["coastline-filter"], gw, gh));
  return { presets: out, coast };
}

async function build(origin: string, outDir: string): Promise<void> {
  const browser = await chromium.launch({ headless: true, channel: "chromium" });
  const log: string[] = [];
  const t0 = Date.now();
  try {
    const { page, errors } = await openPage(origin, browser);
    console.error("generate");
    const gen = await step(log, "generate", () =>
      bridge(page, "generateMap", { seed: C.seed, template: C.template, cells: C.cells, states: C.states, burgs: C.burgs, width: C.width, height: C.height, timeoutMs: 180000 })
    );
    // the same canonicalisation generate_map does: reload from the map's own text so the page holds what a file holds
    await step(log, "canonicalise", async () => {
      const { text } = await bridge<{ text: string }>(page, "mapData");
      await loadText(page, text);
      return text.length;
    });
    await step(log, "settings", () => page.evaluate(() => (globalThis as any).__parity.settings()));
    await step(log, "layers", async () => {
      const r = await bridge<any>(page, "display", { on: [...PARITY_LAYERS_ON] });
      await settle(page);
      return r.layersOn?.length;
    });
    await step(log, "relief", async () => {
      const r = await bridge<any>(page, "relief", { relief: { density: C.reliefDensity } });
      await settle(page);
      return r.relief;
    });
    const targetsFor = (name: string) => step(log, name, () => page.evaluate(([n, icons]) => (globalThis as any).__parity[n](icons), [name, ICONS] as const));
    await targetsFor("lakes");
    await targetsFor("regiments");
    await targetsFor("markers");
    await targetsFor("zones");
    await targetsFor("ice");
    await targetsFor("grid");
    await targetsFor("measurers");
    await targetsFor("legend");
    await targetsFor("labels");
    await targetsFor("fog");
    await step(log, "zoom-styling", () => page.evaluate(() => { (globalThis as any).invokeActiveZooming(); return true; }));
    await settle(page);

    const censusBuild = await censusOf(page, false);
    const failBuild = checkCensus(censusBuild, { withPreamble: false });
    report("after build", failBuild);
    const targets = await page.evaluate(() => (globalThis as any).__parity.targets());

    // -- save
    const saved = await step(log, "save", async () => bridge<{ text: string }>(page, "mapData"));
    const text = normalizeHeader(saved.text);
    const sha = createHash("sha256").update(text).digest("hex");

    // -- reload in a fresh page and compare
    await page.context().close();
    const second = await openPage(origin, browser);
    await step(log, "reload", async () => {
      await loadText(second.page, text);
      return text.length;
    });
    const reloaded = await censusOf(second.page, false);
    const failReload = checkCensus(reloaded, { withPreamble: false });
    report("after reload (no preamble)", failReload);
    const reloadedPre = await censusOf(second.page, true);
    const failPre = checkCensus(reloadedPre, { withPreamble: true });
    report("after reload + preamble", failPre);
    const pageErrors = [...errors, ...second.errors];
    if (pageErrors.length) console.error("page errors:", [...new Set(pageErrors)].slice(0, 8));

    const cams = cameras(targets);
    const bytes = Buffer.byteLength(text);
    const manifest: ParityManifest = {
      fixture: C.version,
      file: `${C.version}.map`,
      sha256: sha,
      bytes,
      generator: gen,
      config: C,
      build: { builtWith: "bench/host/fixtures/build-parity-fixture.ts", seconds: Math.round((Date.now() - t0) / 100) / 10, steps: log, pageErrors: [...new Set(pageErrors)].slice(0, 20) },
      layersOn: [...PARITY_LAYERS_ON],
      census: { afterBuild: censusBuild, afterReload: reloaded, afterReloadPreamble: reloadedPre },
      layerCensus: layerCensus(reloadedPre),
      features: FEATURES,
      rowsCovered: rowsCovered(),
      cameras: cams.presets,
      coastlineSwitch: cams.coast.map(c => ({ ...c, expect: c.k <= 1.5 ? "url(#dropShadow)" : c.k <= 2.6 ? "none" : "url(#blurFilter)" })),
      preamble: "await __parity.preamble() after loading: draws the cells layer (not stored in the file) and #debug, then wait ~2 s for the trade animation to start",
      notes: [
        "Header date and map id are normalised (see PARITY_CONFIG), so the sha is stable across rebuilds on one host.",
        "Fonts: every non-local request is aborted, so label and legend metrics use the host's fallback fonts. The same file loaded with web fonts keeps its stored geometry.",
        "The cells layer is a 0.8 MB raster the app redraws on toggle; it is left off in the file and drawn by __parity.preamble() to stay under the size budget."
      ]
    };
    const failures = [...failBuild, ...failReload, ...failPre];
    // refuse to write anything (the default --out is the committed fixture) when an expectation failed
    if (failures.length) throw new Error(`${failures.length} census expectation(s) failed; nothing written`);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, `${C.version}.map`), text);
    writeFileSync(resolve(outDir, `${C.version}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
    console.error(`wrote ${resolve(outDir, `${C.version}.map`)} (${(bytes / 1e6).toFixed(2)} MB, sha256 ${sha.slice(0, 12)})`);
    if (bytes > 3_000_000) console.error(`WARNING: ${bytes} bytes exceeds the 3 MB budget`);
  } finally {
    await browser.close();
  }
}

function report(label: string, failures: ExpectationFailure[]): void {
  console.error(`census ${label}: ${failures.length ? `${failures.length} FAILED` : "all expectations met"}`);
  for (const f of failures) console.error(`   ${f.feature}: ${f.path} want ${f.want}, got ${JSON.stringify(f.got)}`);
}

async function verify(origin: string, dir: string, shots?: string): Promise<void> {
  const mapPath = resolve(dir, `${C.version}.map`);
  const manifest = JSON.parse(readFileSync(resolve(dir, `${C.version}.json`), "utf8")) as ParityManifest;
  const sha = sha256File(mapPath);
  if (sha !== manifest.sha256) throw new Error(`file sha256 ${sha} != manifest ${manifest.sha256}`);
  const browser = await chromium.launch({ headless: true, channel: "chromium" });
  try {
    const { page } = await openPage(origin, browser);
    await loadText(page, readFileSync(mapPath, "utf8"));
    const census = await censusOf(page, true);
    const failures = checkCensus(census, { withPreamble: true });
    report("committed fixture", failures);
    if (failures.length) process.exitCode = 1;
    // every camera preset must frame what it says; the coastline presets must land on the expected filter
    const frames = [...manifest.cameras, ...manifest.coastlineSwitch.map(c => ({ ...c }))] as (CameraPreset & { expect?: string })[];
    if (shots) mkdirSync(shots, { recursive: true });
    for (const cam of frames) {
      const seen = await page.evaluate(async c => {
        const w = globalThis as any;
        w.d3.select("#map").call((0, eval)("zoom").transform, w.d3.zoomIdentity.translate(c.x, c.y).scale(c.k));
        await w.__tupaia.settle?.();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return { k: (0, eval)("scale"), filter: w.d3.select("#coastline #sea_island").attr("filter") || "none" };
      }, cam);
      if (Math.abs(seen.k - cam.k) > 1e-6) {
        console.error(`   ${cam.id}: wanted k ${cam.k}, the app clamped it to ${seen.k}`);
        process.exitCode = 1;
      }
      if (cam.expect && seen.filter !== cam.expect) {
        console.error(`   ${cam.id}: coastline filter ${seen.filter}, expected ${cam.expect}`);
        process.exitCode = 1;
      }
      if (shots) await page.screenshot({ path: resolve(shots, `${cam.id}.png`), animations: "disabled" });
    }
    console.error(`${frames.length} camera frames checked${shots ? `, screenshots in ${shots}` : ""}`);
  } finally {
    await browser.close();
  }
}

/** `--seeds a,b,c`: print what each seed generates (lakes, land, size), to choose the fixture seed. */
async function probeSeeds(origin: string, seeds: string[]): Promise<void> {
  const browser = await chromium.launch({ headless: true, channel: "chromium" });
  try {
    const { page } = await openPage(origin, browser);
    for (const seed of seeds) {
      const gen = await bridge<any>(page, "generateMap", { seed, template: C.template, cells: C.cells, states: C.states, burgs: C.burgs, width: C.width, height: C.height, timeoutMs: 180000 });
      const land = await page.evaluate(() => {
        let n = 0;
        for (let i = 1; i < pack.cells.i.length; i++) if (pack.cells.h[i] >= 20) n++;
        return Math.round((100 * n) / pack.cells.i.length);
      });
      console.error(`${seed}: lakes ${gen.features.lakes} land ${land}% cells ${gen.cells} burgs ${gen.counts.burgs} states ${gen.counts.states} rivers ${gen.counts.rivers} islands ${gen.features.islandsTotal}`);
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  checkDist(resolve(REPO_ROOT, "dist"), REPO_ROOT);
  const server = await startStaticServer(resolve(REPO_ROOT, "dist"));
  try {
    if (opt("--seeds")) await probeSeeds(server.origin, (opt("--seeds") as string).split(","));
    else if (flag("--verify")) await verify(server.origin, opt("--dir") ? resolve(opt("--dir") as string) : PARITY_DIR, opt("--shots") ? resolve(opt("--shots") as string) : undefined);
    else await build(server.origin, opt("--out") ? resolve(opt("--out") as string) : PARITY_DIR);
  } finally {
    await server.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

