// Label fidelity harness (REWRITE-PLAN §5 rows 15, 16 and 41; PROOF-PLAN §4 "Labels" and "Fonts"; Phase 0 gate gap
// 8). Run it through bench/gate/gate.ts (`gate labels ...`, `gate labels-selftest`), which takes a shared host-lock
// slot and sets GATE_OUT_DIR. SVG is the reference and the GPU the candidate, always from one page and one DOM state:
// a check never compares GPU with GPU.
//
// Steps (LABELS_STEPS, default all four), per world (LABELS_MAPS):
//   thresholds  Visible label set at ±0.01 k around every visibility threshold of every label group (the app's
//               hideLabels rule, public/main.js updateZoomStyling, MCP overrides included; labels-core.ts thresholds).
//               The group is shown alone (other label groups and every other layer hidden), the camera is zoomed
//               through d3 to k, and from the settled GPU frame and the SVG under it: every label the SVG shows must
//               carry at least half its SVG ink in its box on the GPU, and the GPU may not paint ink outside every
//               visible label's box where the SVG paints none. The SVG side is checked against the rule too.
//   glyphs      Glyph positions on a sample of LABELS_SAMPLE (200) labels per variant, collected over cameras at
//               LABELS_GLYPH_K. Every character's SVG geometry comes from getStartPositionOfChar /
//               getEndPositionOfChar / getRotationOfChar / getExtentOfChar.
//               - analytic (native, curved; INFO since W3b GLYPH2): the GPU glyph instances are read back (renderer
//                 payload + atlas keys, labels-core.ts glyphBaseline) and each SVG character's baseline midpoint
//                 ((start+end)/2, dy included) is paired with the nearest GPU glyph of the same character, distance in
//                 device px. text.ts anchors laid-out glyphs on the same SVG APIs, so this is reported, not gated;
//               - pixel (every label, native and compat, curved and straight): the shift that best aligns the GPU
//                 arm's ink with the SVG arm's inside each character's extent box (labels-core.ts register);
//                 TOL.registerShare of the characters must be within TOL.registerPx, where a window the GPU leaves
//                 (nearly) empty is a missing character (labels-core.ts classifyRegistration), never a 0 px shift;
//               - presence: a label whose whole box the GPU leaves (nearly) empty fails the variant.
//               Pixel registration is the position gate. The `native` variant fails when it samples no native curved
//               label (what it exists to exercise).
//               Variant `map` is the fixture as saved. Every built-in preset gives state labels a text-shadow, and
//               multi-line state labels end their first line with a space, so text.ts sends both to the compat lane;
//               variant `native` removes the text-shadow and trims edge spaces in curved labels' tspans (both arms
//               see the same DOM) so that the curved labels go native and the analytic check has a sample.
//   advance     Character start positions from measureText, the way text.ts measures a label (kerned starts at the
//               power-of-two raster bucket, always kerned, no-break spaces so pairs across a space count), against SVG
//               getStartPositionOfChar(i) at the same CTM scale. Chromium reports a start half its leading kern before
//               the painted origin when HarfBuzz split the kern (legacy 'kern' table; text.ts kernOffsets, W3 GLYPH
//               ink-centroid probes), so the model's prediction of the reported start is origin - kern/2 there and
//               origin under GPOS kerning: one check of both the measured starts the fallback layout draws at and
//               the kerns the SVG-positioned layout corrects with. Per pinned font:
//               every family of window.fonts plus the fixture's label fonts, sizes 6/14/22 px, k 1/1.5/3 (raster
//               scale 2/3/6 at dpr 2: one in-bucket, two rounded up), text-rendering auto and optimizeSpeed, on
//               kerning-heavy probe strings and the fixture's own label strings (reported apart). Every available
//               font must stay within TOL.advancePx device px.
//   fonts       Font switches through the Style panel (labels > group > font select, and the "+" add-font dialog):
//               built-in system font, built-in web font, Google font, font URL, local font, and a broken font URL.
//               After each switch the state labels (native in the `native` variant) and the capital labels (compat)
//               must show the new face in the SVG, the GPU must stay active, native labels must be re-atlased with
//               the new face, and a labels-layer golden (SSIM, over16, over44 per D11, ink ratio ≥ 0.9) must pass.
//               The broken font must send only its own labels to compat, with a reason naming the family (the LIFE
//               font guard), while the labels of other groups keep their lane.
//               Fonts are served locally: fonts.googleapis.com and the font-URL host are answered from system font
//               files (LABELS_FONT_GOOGLE / LABELS_FONT_WEB, macOS defaults); fonts.gstatic.com GETs go to the
//               network, as in the golden runner. Everything else off-origin is aborted.
//
// Environment (gate.ts maps its arguments onto these):
//   LABELS_MAPS          comma list of name=path worlds (default parity=<parity fixture>)
//   LABELS_STEPS         comma list of thresholds,glyphs,advance,fonts           default all
//   LABELS_DPR           device pixel ratio                                       default 2
//   LABELS_SAMPLE        labels per glyph variant                                 default 200
//   LABELS_GLYPH_K       zooms the glyph sample is collected at                   default 1,2,4,8
//   LABELS_GLYPH_CAMERAS cameras per zoom at most                                default 40
//   LABELS_VARIANTS      glyph variants: map,native                               default map,native
//   LABELS_GROUPS        threshold step: only these label groups                  default all
//   LABELS_FONTS         font-switch step: comma list of switch ids               default all
//   LABELS_ADVANCE_FONTS advance step: at most this many families (0 = all)      default 0
//   LABELS_ADVANCE_FAMILIES advance step: exactly these families (comma list)    default every pinned family
//   LABELS_ZOOM_PARTS    zoom step: shadows and/or carry (comma list)                default shadows,carry
//   LABELS_KEEP          all | fail: PNGs for every capture or failing ones only  default fail
//   LABELS_BREAK         none | freeze | measure | shift | drop (self-test only):
//                        freeze  stops the GPU from seeing DOM changes for the second probe of each threshold and for
//                                each font switch (a missed invalidation: the frame keeps the old visibility or face);
//                        measure scales Canvas2D measureText widths by 1.04 from page start (GPU advances off) and
//                                moves the page's getStart/EndPositionOfChar 1.5 user units right (GPU anchors off;
//                                the harness's own reference reads are exempt);
//                        shift   moves the GPU canvas 1 CSS px right (every GPU glyph displaced by dpr device px);
//                        drop    covers the right half of the viewport with the background in the GPU arm's captures
//                                only (the GPU draws nothing there: dropped labels, for native and compat alike).
// Output in GATE_OUT_DIR: labels.json (`failure` is null on a pass), PNGs under <world>/.
// Exit 0 when a report was written (verdicts are in it), 1 on a harness error.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, relative, resolve } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright";
import { type CellMetrics, coverageOf, D1, heatmap, measureCell } from "../golden-metrics.ts";
import { decodePng, encodePng } from "../png.ts";
import { isolateLayer } from "./golden-isolation.ts";
import { resolveFixture } from "./fixtures/index.ts";
import {
  alongNormal,
  type Box,
  classifyRegistration,
  clipBox,
  type GroupRule,
  gpuGlyphs,
  inkCount,
  inkOf,
  labelHidden,
  matchGlyphs,
  probes,
  register,
  scaleBucket,
  stats,
  strayInk,
  thresholds,
  TOL,
  zones
} from "./labels-core.ts";

const env = process.env;
const root = resolve(import.meta.dirname, "../..");
const dist = resolve(root, "dist");
const outDir = resolve(env.GATE_OUT_DIR || process.cwd());
const STEPS = ["thresholds", "glyphs", "advance", "fonts", "zoom"] as const;
type Step = (typeof STEPS)[number];
const steps = (env.LABELS_STEPS || STEPS.join(",")).split(",").map(s => s.trim()).filter(Boolean) as Step[];
for (const s of steps) if (!STEPS.includes(s)) throw Error(`LABELS_STEPS: unknown step ${s} (${STEPS.join(", ")})`);
const dpr = Number(env.LABELS_DPR || 2);
if (dpr !== 1 && dpr !== 2) throw Error("LABELS_DPR must be 1 or 2");
const sampleTarget = Number(env.LABELS_SAMPLE || 200);
const glyphKs = (env.LABELS_GLYPH_K || "1,2,4,8").split(",").map(Number);
if (glyphKs.some(k => !(k >= 1))) throw Error("LABELS_GLYPH_K must be zooms >= 1");
const cameraBudget = Number(env.LABELS_GLYPH_CAMERAS || 40);
const variants = (env.LABELS_VARIANTS || "map,native").split(",").map(s => s.trim()) as ("map" | "native")[];
for (const v of variants) if (v !== "map" && v !== "native") throw Error("LABELS_VARIANTS: map and/or native");
const groupFilter = env.LABELS_GROUPS ? new Set(env.LABELS_GROUPS.split(",")) : null;
const fontFilter = env.LABELS_FONTS ? new Set(env.LABELS_FONTS.split(",")) : null;
const advanceFontLimit = Number(env.LABELS_ADVANCE_FONTS || 0);
const advanceFamilies = env.LABELS_ADVANCE_FAMILIES ? env.LABELS_ADVANCE_FAMILIES.split(",").map(s => s.trim()) : null;
const keep = env.LABELS_KEEP || "fail";
if (keep !== "all" && keep !== "fail") throw Error("LABELS_KEEP must be all|fail");
const breakMode = env.LABELS_BREAK || "none";
if (!["none", "freeze", "measure", "shift", "drop"].includes(breakMode)) throw Error("LABELS_BREAK must be none|freeze|measure|shift|drop");
const GOOGLE_FONT_FILE = env.LABELS_FONT_GOOGLE || "/System/Library/Fonts/Supplemental/Apple Chancery.ttf";
const WEB_FONT_FILE = env.LABELS_FONT_WEB || "/System/Library/Fonts/Supplemental/Chalkduster.ttf";
const LOCAL_FONT = env.LABELS_FONT_LOCAL || "Baskerville";
const VIEW = { width: 1280, height: 720 };
const BG = "#ffffff";

const worlds = (() => {
  const spec = env.LABELS_MAPS || `parity=${resolveFixture("parity").path}`;
  return spec.split(",").map(item => {
    const at = item.indexOf("=");
    const [name, path] = at > 0 ? [item.slice(0, at), item.slice(at + 1)] : [item.replace(/\W+/g, "-"), item];
    if (!existsSync(path)) throw Error(`LABELS_MAPS: ${path} not found`);
    return { name, path: resolve(path) };
  });
})();
const paritySha = (() => {
  try {
    return resolveFixture("parity").sha256;
  } catch {
    return null;
  }
})();

// ------------------------------------------------------------------ report

type Json = Record<string, any>;
const report = {
  schema: 1,
  runStartedUtc: new Date().toISOString(),
  args: { steps, dpr, sample: sampleTarget, glyphK: glyphKs, variants, groups: groupFilter ? [...groupFilter] : "all", fonts: fontFilter ? [...fontFilter] : "all", keep, break: breakMode },
  tolerances: TOL,
  diagnosticBreak: breakMode !== "none" ? `${breakMode}: the GPU arm is deliberately broken; this run is expected to FAIL` : null,
  worlds: {} as Record<string, Json>,
  errors: [] as string[],
  warnings: [] as string[],
  failure: null as string | null,
  summary: {} as Json
};
const log = (m: string) => console.log(`[labels] ${m}`);
const write = () => writeFileSync(join(outDir, "labels.json"), `${JSON.stringify(report, null, 2)}\n`);

// ------------------------------------------------------------------ static server for dist/ and local fonts

const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json" };
const server = createServer((request, response) => {
  const path = resolve(dist, `.${new URL(request.url || "/", "http://localhost").pathname}`);
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

// The probe fonts. Family names are the harness's own, so nothing on the host or in window.fonts can satisfy them by
// accident; the files are system fonts with visibly different faces.
const PROBE_HOST = "fonts.tupaia-probe.test";
const FONT_SWITCHES = [
  { id: "builtin", kind: "select", family: "Georgia", note: "built-in list, system face (no src)" },
  { id: "builtin-web", kind: "select", family: "Amatic SC", note: "built-in list, fonts.gstatic.com face (network)" },
  { id: "google", kind: "googleFont", family: "Tupaia Probe Google", note: `Google font dialog; css2 and the face served locally (${GOOGLE_FONT_FILE})` },
  { id: "web", kind: "fontURL", family: "Tupaia Probe Web", url: `https://${PROBE_HOST}/web.ttf`, note: `font URL dialog (${WEB_FONT_FILE})` },
  { id: "local", kind: "localFont", family: LOCAL_FONT, note: "local font dialog: local() of a face installed on the host" },
  { id: "broken", kind: "fontURL", family: "Tupaia Probe Broken", url: `https://${PROBE_HOST}/missing.ttf`, note: "font URL that 404s: must cost only its own labels (LIFE font guard)" }
] as const;
type FontSwitch = (typeof FONT_SWITCHES)[number];

// ------------------------------------------------------------------ page setup

const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--use-angle=metal", "--enable-gpu"] });

async function openContext(world: { name: string; path: string }, parity: Json | null): Promise<{ context: BrowserContext; page: Page; errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: dpr, serviceWorkers: "block" });
  await context.addInitScript(() => {
    localStorage.setItem("autosaveInterval", "0");
    localStorage.setItem("azgaarAssistant", "hide");
  });
  if (breakMode === "measure")
    await context.addInitScript(() => {
      const original = CanvasRenderingContext2D.prototype.measureText;
      CanvasRenderingContext2D.prototype.measureText = function (text: string) {
        const metrics = original.call(this, text);
        return new Proxy(metrics, {
          get(target, key) {
            const value = Reflect.get(target, key);
            return key === "width" ? (value as number) * 1.04 : typeof value === "function" ? value.bind(target) : value;
          }
        });
      };
      // text.ts anchors laid-out glyphs on the SVG's own character positions, which measureText does not reach: move
      // what the page reads 1.5 user units right, except while the harness reads its own reference (__labelsReading)
      const proto = SVGTextContentElement.prototype;
      for (const name of ["getStartPositionOfChar", "getEndPositionOfChar"] as const) {
        const read = proto[name];
        proto[name] = function (this: SVGTextContentElement, index: number) {
          const point = read.call(this, index);
          return (globalThis as any).__labelsReading ? point : new DOMPoint(point.x + 1.5, point.y);
        };
      }
    });
  const scripts = ["bridge.js", "bridge-mutations.js", ...readdirSync(resolve(root, "mcp/src/bridge-ext")).filter(n => n.endsWith(".js")).sort().map(n => `bridge-ext/${n}`)];
  await context.addInitScript(scripts.map(n => readFileSync(resolve(root, "mcp/src", n), "utf8")).join("\n"));
  if (parity?.pageScript) await context.addInitScript(parity.pageScript);
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    if (request.method() !== "GET") return route.abort();
    if (url.hostname === "fonts.googleapis.com" && url.pathname === "/css2") {
      const family = (url.searchParams.get("family") || "").replace(/\+/g, " ");
      const css = `@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-weight: 400;\n  font-display: block;\n  src: url(https://fonts.gstatic.com/s/tupaiaprobe/google.ttf) format('truetype');\n  unicode-range: U+0000-00FF, U+0131, U+0152-0153;\n}\n`;
      return route.fulfill({ status: 200, contentType: "text/css", body: css, headers: { "access-control-allow-origin": "*" } });
    }
    if (url.hostname === "fonts.gstatic.com" && url.pathname === "/s/tupaiaprobe/google.ttf")
      return route.fulfill({ status: 200, contentType: "font/ttf", body: readFileSync(GOOGLE_FONT_FILE), headers: { "access-control-allow-origin": "*" } });
    if (url.hostname === PROBE_HOST) {
      if (url.pathname === "/web.ttf") return route.fulfill({ status: 200, contentType: "font/ttf", body: readFileSync(WEB_FONT_FILE), headers: { "access-control-allow-origin": "*" } });
      return route.fulfill({ status: 404, body: "not found", headers: { "access-control-allow-origin": "*" } });
    }
    if (url.hostname === "fonts.gstatic.com") return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => {
    if (["warning", "error"].includes(m.type()) && warnings.length < 80) warnings.push(m.text().slice(0, 600));
  });
  page.on("dialog", d => d.dismiss());
  await page.goto(`${origin}/?local&seed=7319&width=${VIEW.width}&height=${VIEW.height}&renderer=gpu`);
  await page.evaluate(async () => {
    const ready = await (globalThis as any).__tupaia.call("ready", { timeoutMs: 120000 });
    if (!ready.ok) throw Error(JSON.stringify(ready));
  });
  await page.evaluate(async text => {
    const w = globalThis as any;
    await w.__tupaia.fns.loadMap({ text, timeoutMs: 120000 });
    await w.__tupaia.settle();
    if (w.__parity) await w.__parity.preamble();
    // page chrome that changes between captures (tips; the Navigate/Edit indicator's label and width) would count as
    // ink in one capture and not the next. A sheet in <head> is outside #map, so the renderer does not see it.
    const sheet = document.createElement("style");
    sheet.id = "labels-harness-chrome";
    sheet.textContent = "#tooltip, #renderModeIndicator { visibility: hidden !important; }";
    document.head.append(sheet);
  }, readFileSync(world.path, "utf8"));
  if (breakMode === "shift") await page.addStyleTag({ content: "canvas[data-gpu-renderer] { transform: translate(1px, 0) !important; }" });
  if (breakMode === "drop")
    await page.evaluate(bg => {
      const cover = document.createElement("div");
      cover.id = "labels-harness-drop";
      cover.style.cssText = `position:fixed;left:50%;top:0;right:0;bottom:0;background:${bg};z-index:2147483647;pointer-events:none;display:none`;
      document.body.append(cover);
    }, BG);
  return { context, page, errors, warnings };
}

const settleApp = (page: Page) =>
  page.evaluate(async () => {
    const w = globalThis as any;
    await w.__tupaia.settle();
    await Promise.all([w.reliefRenderReady, w.burgRenderReady]);
    w.d3.select("#tradeAnimation").selectAll("*").interrupt();
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
  });

interface Camera {
  k: number;
  x: number;
  y: number;
}
const centerOn = (k: number, wx: number, wy: number): Camera => ({ k, x: VIEW.width / 2 - wx * k, y: VIEW.height / 2 - wy * k });

const zoomTo = (page: Page, camera: Camera) =>
  page.evaluate(async ({ k, x, y }) => {
    const w = globalThis as any;
    w.d3.select("#map").call((0, eval)("zoom").transform, w.d3.zoomIdentity.translate(x, y).scale(k));
    await w.__tupaia.settle();
    await Promise.all([w.reliefRenderReady, w.burgRenderReady]);
    const t = (0, eval)("d3.zoomTransform(document.querySelector('#map'))");
    return { k: t.k, x: t.x, y: t.y };
  }, camera);

// A GPU frame of the current DOM revision, drawn and refined, or a fallback.
async function waitGpu(page: Page): Promise<{ active: string; fallbackReason?: string; timedOut?: boolean }> {
  let timedOut = false;
  try {
    await page.waitForFunction(
      () => {
        const s = (globalThis as any).rendererStatus?.();
        const c = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
        if (s?.active === "svg" && s?.fallbackReason) return true;
        const g = s?.gpu;
        return g?.state === "active" && !g.pending && !g.refinementPending && g.canvasVisible && !!c && getComputedStyle(c).display !== "none";
      },
      {},
      { timeout: 90000, polling: 50 }
    );
  } catch {
    timedOut = true;
  }
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const status = await page.evaluate(() => {
    const s = (globalThis as any).rendererStatus?.();
    return { active: s?.active, fallbackReason: s?.fallbackReason || undefined };
  });
  return timedOut ? { ...status, timedOut } : status;
}

// LABELS_BREAK=drop: the cover is shown for the GPU arm's capture only
const dropCover = (page: Page, on: boolean) =>
  breakMode === "drop" ? page.evaluate(show => void ((document.getElementById("labels-harness-drop") as HTMLElement).style.display = show ? "block" : "none"), on) : Promise.resolve();

async function captureArms(page: Page): Promise<{ gpu: Buffer; svg: Buffer }> {
  await dropCover(page, true);
  const gpu = await page.screenshot({ animations: "disabled" });
  await dropCover(page, false);
  const old = await page.evaluate(() => {
    const c = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
    if (!c) return null;
    const value = c.style.visibility;
    c.style.visibility = "hidden";
    return value;
  });
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const svg = await page.screenshot({ animations: "disabled" });
  await page.evaluate(value => {
    const c = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
    if (c) c.style.visibility = value || "";
  }, old);
  return { gpu, svg };
}

// Shows one label group alone inside #labels (its ancestors and descendants stay; every other group gets an inline
// display:none, restored by `null`). Idempotent: an element already in the wanted state is not written again (a write
// is a mutation, and so a GPU re-prepare). Self-contained: it is serialised into the page.
function isolateGroup(id: string | null): number {
  const g = globalThis as any;
  const saved: Map<Element, string> = (g.__labelsGroupIso ??= new Map());
  const target = id === null ? null : document.querySelector(`#labels #${CSS.escape(id)}`);
  if (id !== null && !target) throw Error(`isolateGroup: no #labels #${id}`);
  const wanted = new Set<Element>();
  if (target)
    for (const group of document.querySelectorAll("#labels g"))
      if (group !== target && !group.contains(target) && !target.contains(group)) wanted.add(group);
  for (const [element, value] of [...saved]) {
    if (wanted.has(element)) continue;
    (element as SVGElement).style.display = value;
    saved.delete(element);
  }
  for (const element of wanted) {
    if (saved.has(element)) continue;
    saved.set(element, (element as SVGElement).style.display);
    if ((element as SVGElement).style.display !== "none") (element as SVGElement).style.display = "none";
  }
  return saved.size;
}

// LABELS_BREAK=freeze: the renderer stops seeing DOM mutations and settles (its frame and its compat refinement keep
// the old DOM state; the camera still moves). Off: the overrides go and a forced re-prepare catches up.
function freezeGpu(on: boolean): boolean {
  const r = (globalThis as any).gpuRenderer;
  if (!r) return false;
  if (on) {
    // a prepare already scheduled would read the DOM after the freeze
    clearTimeout(r.prepareTimer);
    r.prepareTimer = 0;
    r.mutated = () => {};
    r.schedulePrepare = () => {};
    r.settle = async () => {};
    return true;
  }
  delete r.mutated;
  delete r.schedulePrepare;
  delete r.settle;
  r.invalidate?.();
  return true;
}

// Which frame the GPU shows: the prepared frame's identity and revision (self-test evidence that a freeze held).
function frameState(): Json {
  const r = (globalThis as any).gpuRenderer;
  const p = r?.prepared;
  const g = (globalThis as any).__labelsFrameIds ?? new WeakMap();
  (globalThis as any).__labelsFrameIds = g;
  if (p && !g.has(p)) g.set(p, ((globalThis as any).__labelsFrameSeq = ((globalThis as any).__labelsFrameSeq ?? 0) + 1));
  return { frame: p ? g.get(p) : null, revision: p?.revision ?? null, rendererRevision: r?.revision ?? null, canvasVisible: (globalThis as any).rendererStatus?.()?.gpu?.canvasVisible ?? null };
}

// variant `native`: no text-shadow on any label group and no edge spaces in curved labels' tspans (both arms).
// `map` restores what `native` changed.
function setVariant(variant: "map" | "native"): { groups: number; tspans: number } {
  const g = globalThis as any;
  const saved: { groups: [SVGElement, string][]; tspans: [Element, string][] } = (g.__labelsVariant ??= { groups: [], tspans: [] });
  for (const [element, value] of saved.groups) element.style.textShadow = value;
  for (const [element, value] of saved.tspans) element.textContent = value;
  saved.groups.length = 0;
  saved.tspans.length = 0;
  if (variant === "map") return { groups: 0, tspans: 0 };
  for (const group of document.querySelectorAll<SVGElement>("#labels g")) {
    if (getComputedStyle(group).textShadow === "none" && !group.style.textShadow) continue;
    saved.groups.push([group, group.style.textShadow]);
    group.style.textShadow = "none";
  }
  for (const tspan of document.querySelectorAll("#labels text > textPath > tspan")) {
    const text = tspan.textContent || "";
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (trimmed === text) continue;
    saved.tspans.push([tspan, text]);
    tspan.textContent = trimmed;
  }
  return { groups: saved.groups.length, tspans: saved.tspans.length };
}

// Every label group the zoom rule touches: #labels g with data-size (the #burgLabels container has none), with its
// rule and the world anchor of each label (textPath: the path's midpoint; plain text: x/y).
function labelGroups(): Json {
  const w = globalThis as any;
  const anchor = (text: SVGTextElement): [number, number] | null => {
    const textPath = text.querySelector("textPath");
    if (textPath) {
      const href = textPath.getAttribute("href") || textPath.getAttribute("xlink:href") || "";
      const path = href.startsWith("#") ? (document.getElementById(href.slice(1)) as unknown as SVGPathElement | null) : null;
      if (!path?.getTotalLength) return null;
      const p = path.getPointAtLength(path.getTotalLength() / 2);
      return [p.x, p.y];
    }
    const x = Number.parseFloat(text.getAttribute("x") ?? "");
    const y = Number.parseFloat(text.getAttribute("y") ?? "");
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  };
  const groups = [...document.querySelectorAll<SVGGElement>("#labels g")]
    .filter(g => g.id !== "burgLabels" && g.dataset.size !== undefined)
    .map(g => {
      const texts = [...g.querySelectorAll<SVGTextElement>(":scope > text")];
      return {
        id: g.id,
        desired: Number(g.dataset.size),
        min: Number.parseFloat(g.dataset.minSize ?? ""),
        max: Number.parseFloat(g.dataset.maxSize ?? ""),
        always: g.dataset.alwaysShow === "1" || g.dataset.alwaysShow === "true",
        display: g.style.display,
        texts: texts.length,
        anchors: texts.map(t => ({ id: t.id, at: anchor(t) })).filter(a => a.at)
      };
    });
  const extent = (0, eval)("zoom").scaleExtent();
  return { hideLabels: !!w.hideLabels?.checked, rescale: !!w.rescaleLabels?.checked, extent, graph: [w.graphWidth, w.graphHeight], groups };
}

// What the SVG shows: per label text in #labels (optionally one group): visibility, the device-px box clipped to the
// viewport, its group and whether the GPU drew it natively (no compat run covers it). With `chars`, per character:
// SVG baseline midpoint and rotation, and the extent box, in device px.
function svgLabels(args: { group: string | null; chars: boolean; dpr: number; ids: string[] | null }): Json {
  const w = globalThis as any;
  const vw = innerWidth;
  const vh = innerHeight;
  const runs = w.gpuRenderer?.prepared?.runs;
  const compat = new Set<Element>();
  for (const run of Array.isArray(runs) ? runs : []) for (const e of run.elements ?? []) compat.add(e);
  const scope = args.group ? document.querySelector(`#labels #${CSS.escape(args.group)}`) : document.querySelector("#labels");
  const groupHidden = args.group ? !!scope?.classList.contains("hidden") : null;
  const wanted = args.ids ? new Set(args.ids) : null;
  const out: Json[] = [];
  const texts = [...(scope?.querySelectorAll<SVGTextElement>("text") ?? [])];
  texts.forEach((text, index) => {
    const group = text.closest("#labels g[data-size]") as SVGGElement | null;
    const id = text.id || `${group?.id ?? "labels"}#${index}`;
    if (wanted && !wanted.has(id)) return;
    let native = !!w.gpuRenderer?.prepared;
    for (let e: Element | null = text; e && e.id !== "viewbox"; e = e.parentElement) if (compat.has(e)) native = false;
    const visible = text.checkVisibility({ visibilityProperty: true } as any);
    const r = text.getBoundingClientRect();
    const box = { x0: r.left * args.dpr, y0: r.top * args.dpr, x1: r.right * args.dpr, y1: r.bottom * args.dpr };
    const onScreen = visible && r.width > 0 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
    const inside = onScreen && r.left >= 6 && r.top >= 6 && r.right <= vw - 6 && r.bottom <= vh - 6;
    const row: Json = { id, group: group?.id ?? null, curved: !!text.querySelector("textPath"), native: native && !!text.querySelector("textPath"), visible, onScreen, inside, box };
    if (args.chars && inside) {
      const m = text.getScreenCTM();
      const n = text.getNumberOfChars();
      // the addressable characters after SVG white-space processing: the collapsed and trimmed text fits most labels;
      // multi-line labels (a tspan per line, an edge space on a line) may keep a space the trim drops
      const raw = text.textContent || "";
      const readings = [raw.replace(/\s+/g, " ").trim(), raw.replace(/\s+/g, " "), raw.replace(/\s+/g, " ").trimStart(), raw.replace(/\s+/g, " ").trimEnd(), raw];
      const reading = readings.findIndex(r => r.length === n);
      const content = reading >= 0 ? readings[reading] : readings[0];
      row.content = content;
      row.numberOfChars = n;
      if (reading > 0) row.reading = reading;
      const style = getComputedStyle(text.querySelector("tspan") ?? text);
      row.fontPx = Number.parseFloat(style.fontSize) || 0;
      // Chromium's start/end-position API stays on the nominal (dy-shifted) path for a dominant-baseline:central label;
      // the glyphs it paints sit lower by the central shift, which Chromium computes on its screen-scaled font with
      // rounded ascent/descent. The harness measures that shift itself, from the SVG: a hidden probe <svg> (its own,
      // outside svg#map) at the label's CTM scale, extent of "H" under central minus under auto, in user units.
      row.baseline = style.dominantBaseline;
      if (style.dominantBaseline === "central" && m) {
        const ns = "http://www.w3.org/2000/svg";
        const w2 = globalThis as any;
        if (!w2.__labelsProbe) {
          const probe = document.createElementNS(ns, "svg");
          probe.setAttribute("width", "1");
          probe.setAttribute("height", "1");
          probe.setAttribute("style", "position:fixed;left:-200px;top:-200px;overflow:hidden;visibility:hidden;pointer-events:none");
          const g = document.createElementNS(ns, "g");
          const auto = document.createElementNS(ns, "text");
          const central = document.createElementNS(ns, "text");
          central.setAttribute("dominant-baseline", "central");
          auto.textContent = central.textContent = "H";
          g.append(auto, central);
          probe.append(g);
          document.body.append(probe);
          w2.__labelsProbe = { g, auto, central };
        }
        const { g, auto, central } = w2.__labelsProbe;
        const ctmScale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
        g.setAttribute("transform", `scale(${ctmScale})`);
        for (const t of [auto, central]) {
          t.setAttribute("font-family", style.fontFamily);
          t.setAttribute("font-size", String(row.fontPx));
          t.setAttribute("font-style", style.fontStyle);
          t.setAttribute("font-weight", style.fontWeight);
          t.setAttribute("text-rendering", style.textRendering);
        }
        const extentShift = central.getExtentOfChar(0).y - auto.getExtentOfChar(0).y;
        // Painted, not reported: when the characters sit in a child inline box (textPath/tspan) of a <text> whose own
        // baseline is central too (#labels sets it on the group), Chromium paints the child's central baseline rounded
        // up to a whole CSS px; getExtentOfChar keeps the half px. Measured on painted pixels (W3 GLYPH probes,
        // Almendra SC 14-27.7 px, k 1-2, dpr 2: painted minus extent 0 or exactly 1 device px, always this rule).
        const nested = getComputedStyle(text).dominantBaseline === "central" && text.children.length > 0;
        row.centralShiftSvg = nested ? Math.ceil(extentShift * ctmScale - 1e-3) / ctmScale : extentShift;
        row.centralNested = nested;
      }
      const chars: Json[] = [];
      if (m && reading >= 0) {
        const map = (x: number, y: number) => [(m.a * x + m.c * y + m.e) * args.dpr, (m.b * x + m.d * y + m.f) * args.dpr];
        for (let i = 0; i < n; i++) {
          const char = content[i];
          if (!char.trim()) continue;
          try {
            w.__labelsReading = true; // break=measure moves these for the page, not for the reference
            const s = text.getStartPositionOfChar(i);
            const e = text.getEndPositionOfChar(i);
            w.__labelsReading = false;
            const x = text.getExtentOfChar(i);
            const [mx, my] = map((s.x + e.x) / 2, (s.y + e.y) / 2);
            const corners = [map(x.x, x.y), map(x.x + x.width, x.y), map(x.x + x.width, x.y + x.height), map(x.x, x.y + x.height)];
            chars.push({
              i,
              char,
              x: mx,
              y: my,
              rotation: text.getRotationOfChar(i),
              extent: { x0: Math.min(...corners.map(c => c[0])), y0: Math.min(...corners.map(c => c[1])), x1: Math.max(...corners.map(c => c[0])), y1: Math.max(...corners.map(c => c[1])) },
              empty: !(x.width > 0 && x.height > 0)
            });
          } catch {
            w.__labelsReading = false;
            // a character the layout does not place (past the end of its path)
          }
        }
      } else row.charsSkipped = m ? `getNumberOfChars ${n} matches no white-space reading of the content (${readings.map(r => r.length).join("/")})` : "no CTM";
      row.chars = chars;
    }
    out.push(row);
  });
  return { groupHidden, labels: out, camera: (0, eval)("(() => { const t = d3.zoomTransform(document.querySelector('#map')); return { k: t.k, x: t.x, y: t.y }; })()") };
}

// ------------------------------------------------------------------ evidence

const decode = (b: Buffer) => decodePng(b);
function saveShots(dir: string, base: string, shots: { gpu: Buffer; svg: Buffer }, svg: ReturnType<typeof decode>, gpu: ReturnType<typeof decode>): Record<string, string> {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, base);
  writeFileSync(`${p}-svg.png`, shots.svg);
  writeFileSync(`${p}-gpu.png`, shots.gpu);
  writeFileSync(`${p}-diff.png`, encodePng(heatmap(svg, gpu)));
  return { svg: relative(outDir, `${p}-svg.png`), gpu: relative(outDir, `${p}-gpu.png`), diff: relative(outDir, `${p}-diff.png`) };
}
// SVG | GPU | heatmap of one box, side by side and enlarged `scale`×, for a label the reader should look at.
function saveCrop(path: string, svg: ReturnType<typeof decode>, gpu: ReturnType<typeof decode>, box: Box, scale = 3) {
  const b = clipBox(box, svg.width, svg.height);
  if (!b) return null;
  const heat = heatmap(svg, gpu);
  const [cw, ch] = [b.x1 - b.x0, b.y1 - b.y0];
  const width = cw * 3 * scale + 2 * scale;
  const height = ch * scale;
  const data = new Uint8Array(width * height * 4).fill(255);
  [svg, gpu, heat].forEach((img, panel) => {
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) {
        const from = ((b.y0 + y) * img.width + b.x0 + x) * 4;
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const to = ((y * scale + dy) * width + panel * (cw * scale + scale) + x * scale + dx) * 4;
            for (let c = 0; c < 4; c++) data[to + c] = c === 3 ? 255 : img.data[from + c];
          }
      }
  });
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, encodePng({ width, height, data }));
  return relative(outDir, path);
}
const roundMetrics = (m: CellMetrics): Json => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === "number" ? Number(v.toFixed(5)) : v]));
const pad = (box: Box, px: number): Box => ({ x0: box.x0 - px, y0: box.y0 - px, x1: box.x1 + px, y1: box.y1 + px });
const fmtK = (k: number) => String(Number(k.toFixed(4))).replace(".", "p");

interface Blanks {
  svg: ReturnType<typeof decode>;
  gpu: ReturnType<typeof decode>;
}
async function captureBlanks(page: Page, camera: Camera): Promise<Blanks> {
  await page.evaluate(isolateLayer, { id: null, bg: BG });
  await zoomTo(page, camera);
  await settleApp(page);
  await page.evaluate(isolateLayer, { id: null, bg: BG });
  const status = await waitGpu(page);
  const shots = await captureArms(page);
  const svg = decode(shots.svg);
  const gpu = status.active === "gpu" && !status.timedOut ? decode(shots.gpu) : svg;
  return { svg, gpu };
}

async function isolateLabels(page: Page, group: string | null) {
  await page.evaluate(isolateLayer, { id: "labels", bg: BG });
  await page.evaluate(isolateGroup, group);
}

// ------------------------------------------------------------------ step: thresholds

async function stepThresholds(page: Page, blanks: Blanks, dir: string): Promise<Json> {
  const info = await page.evaluate(labelGroups);
  const result: Json = { hideLabels: info.hideLabels, extent: info.extent, cells: [] as Json[], groups: [] as Json[] };
  try {
    return await probeThresholds(page, blanks, dir, info, result);
  } finally {
    // the later steps run on the map as saved
    if (result.hideLabelsSwitchedOn)
      await page.evaluate(() => {
        const w = globalThis as any;
        w.hideLabels.checked = false;
        w.invokeActiveZooming();
      });
    result.hideLabelsRestored = !!result.hideLabelsSwitchedOn;
  }
}

async function probeThresholds(page: Page, blanks: Blanks, dir: string, info: Json, result: Json): Promise<Json> {
  const [kMin, kMax] = info.extent as [number, number];
  if (!info.hideLabels) {
    // the rule under test is the automatic visibility toggle; a fixture saved with it off is switched on the way the
    // Options checkbox does it (its onchange is invokeActiveZooming)
    await page.evaluate(() => {
      const w = globalThis as any;
      w.hideLabels.checked = true;
      w.invokeActiveZooming();
    });
    result.hideLabelsSwitchedOn = true;
  }
  const centre = [info.graph[0] / 2, info.graph[1] / 2];
  for (const group of info.groups as Json[]) {
    if (groupFilter && !groupFilter.has(group.id)) continue;
    const rule: GroupRule = { desired: group.desired, min: group.min, max: group.max, always: group.always, hideLabels: true };
    const found = thresholds(rule, kMin, kMax);
    const anchors = (group.anchors as Json[]).map(a => a.at as [number, number]);
    result.groups.push({ id: group.id, rule, texts: group.texts, thresholds: found.map(t => ({ ...t, k: Number(t.k.toFixed(5)) })), zones: zones(found).length });
    if (!found.length || !anchors.length) continue;
    // frame the label nearest the map centre (the least likely to be clamped by the zoom's translate extent)
    anchors.sort((a, b) => Math.hypot(a[0] - centre[0], a[1] - centre[1]) - Math.hypot(b[0] - centre[0], b[1] - centre[1]));
    const [wx, wy] = anchors[0];
    for (const zone of zones(found)) {
      for (const [index, probe] of probes(zone, rule, kMin, kMax).entries()) {
        const key = `${group.id}/t${fmtK(zone.k0)}/${probe.side}`;
        const cell: Json = { key, group: group.id, threshold: Number(zone.k0.toFixed(5)), zone: zone.flips > 1 ? { k1: Number(zone.k1.toFixed(5)), flips: zone.flips } : undefined, side: probe.side, k: probe.k, expectHidden: probe.hidden, pass: false, failures: [] as string[] };
        result.cells.push(cell);
        const started = Date.now();
        const frozen = breakMode === "freeze" && index === 1;
        try {
          await isolateLabels(page, group.id);
          if (frozen) cell.freeze = { held: await page.evaluate(freezeGpu, true), before: await page.evaluate(frameState) };
          cell.camera = await zoomTo(page, centerOn(probe.k, wx, wy));
          await settleApp(page);
          await isolateLabels(page, group.id);
          const status = await waitGpu(page);
          cell.renderer = status;
          if (status.active !== "gpu") cell.failures.push(`GPU not active: ${status.fallbackReason ?? "no frame"}`);
          else if (status.timedOut) cell.failures.push("GPU frame did not settle within 90 s");
          const svgState = await page.evaluate(svgLabels, { group: group.id, chars: false, dpr, ids: null });
          const shots = await captureArms(page);
          if (frozen) {
            cell.freeze.after = await page.evaluate(frameState);
            await page.evaluate(freezeGpu, false);
          }
          const svg = decode(shots.svg);
          const gpu = decode(shots.gpu);
          const svgInk = inkOf(svg, blanks.svg);
          const gpuInk = inkOf(gpu, blanks.gpu);
          const { width, height } = svg;
          cell.svgHidden = svgState.groupHidden;
          if (svgState.groupHidden !== probe.hidden) cell.failures.push(`svg rule: group ${svgState.groupHidden ? "hidden" : "shown"} at k ${probe.k}, the rule says ${probe.hidden ? "hidden" : "shown"}`);
          const visible = (svgState.labels as Json[]).filter(l => l.onScreen);
          const boxes: Box[] = [];
          const missing: Json[] = [];
          let faint = 0;
          for (const label of visible) {
            const box = clipBox(pad(label.box, 2), width, height);
            if (!box) continue;
            boxes.push(clipBox(pad(label.box, 4), width, height) as Box);
            const s = inkCount(svgInk, width, box);
            const g = inkCount(gpuInk, width, box);
            if (s < 4) {
              faint++;
              continue;
            }
            if (g < TOL.presentInkShare * s) missing.push({ id: label.id, svgInk: s, gpuInk: g, native: label.native });
          }
          const svgTotal = inkCount(svgInk, width, { x0: 0, y0: 0, x1: width, y1: height });
          const gpuTotal = inkCount(gpuInk, width, { x0: 0, y0: 0, x1: width, y1: height });
          const stray = strayInk(gpuInk, svgInk, width, height, boxes);
          const allowed = Math.max(TOL.extraMinPx, TOL.extraShare * svgTotal);
          Object.assign(cell, { visibleSvg: visible.length, faint, missing: missing.length, missingLabels: missing.slice(0, 12), svgInk: svgTotal, gpuInk: gpuTotal, strayGpuInk: stray, strayAllowed: Math.round(allowed) });
          if (missing.length) cell.failures.push(`${missing.length}/${visible.length} labels the SVG shows are missing on the GPU (${missing.slice(0, 4).map(m => m.id).join(", ")})`);
          if (stray > allowed) cell.failures.push(`GPU paints ${stray} ink px outside every visible label (allowed ${Math.round(allowed)}; SVG ${svgTotal} px, GPU ${gpuTotal} px)`);
          if (frozen) cell.break = "freeze";
          cell.pass = cell.failures.length === 0;
          if (keep === "all" || !cell.pass) cell.images = saveShots(join(dir, "thresholds"), key.replace(/\//g, "_"), shots, svg, gpu);
        } catch (error) {
          cell.failures.push(`harness: ${String(error).slice(0, 400)}`);
          if (frozen) await page.evaluate(freezeGpu, false).catch(() => {});
        }
        cell.seconds = Number(((Date.now() - started) / 1000).toFixed(1));
        log(`${cell.pass ? "PASS" : "FAIL"} thresholds ${key} k ${probe.k} svg ${cell.svgHidden ? "hidden" : "shown"} visible ${cell.visibleSvg ?? "?"} missing ${cell.missing ?? "?"} stray ${cell.strayGpuInk ?? "?"}${cell.pass ? "" : ` :: ${cell.failures.join("; ")}`}`);
        write();
      }
    }
  }
  await page.evaluate(isolateGroup, null);
  const failing = (result.cells as Json[]).filter(c => !c.pass);
  result.summary = { groups: result.groups.length, thresholds: (result.groups as Json[]).reduce((n, g) => n + g.thresholds.length, 0), cells: result.cells.length, pass: result.cells.length - failing.length, fail: failing.length };
  result.failure = failing.length ? `${failing.length}/${result.cells.length} threshold probes differ: ${failing.slice(0, 6).map(c => `${c.key} (${c.failures[0]})`).join("; ")}` : result.cells.length ? null : "no threshold probes (no label group flips inside the zoom extent)";
  return result;
}

// ------------------------------------------------------------------ step: glyphs

async function stepGlyphs(page: Page, blanks: Blanks, dir: string): Promise<Json> {
  const info = await page.evaluate(labelGroups);
  const rules = new Map<string, GroupRule>((info.groups as Json[]).map(g => [g.id, { desired: g.desired, min: g.min, max: g.max, always: g.always, hideLabels: info.hideLabels }]));
  const result: Json = { hideLabels: info.hideLabels, variants: {} as Json };
  for (const variant of variants) {
    const changed = await page.evaluate(setVariant, variant);
    const v: Json = { changed, cameras: [] as Json[], labels: [] as Json[], skipped: [] as Json[] };
    result.variants[variant] = v;
    let total = 0;
    const analytic: number[] = [];
    const along: number[] = [];
    const normal: number[] = [];
    const angles: number[] = [];
    const centralDelta: number[] = [];
    const shifts: number[] = [];
    const labelShifts: number[] = [];
    let unmatched = 0;
    let missingGlyphs = 0;
    const missingLabels: Json[] = [];
    let crops = 0;
    const shortfall: Json[] = [];
    const worst: Json[] = [];
    const sampledIds = new Set<string>();
    // camera budget a zoom leaves unused carries over to the later zooms
    let spare = 0;
    for (const [kIndex, k] of glyphKs.entries()) {
      // what an earlier zoom could not fill carries over to the later ones
      const perK = Math.ceil((sampleTarget - total) / (glyphKs.length - kIndex));
      const limit = cameraBudget + spare;
      const candidates = (info.groups as Json[])
        .filter(g => g.display !== "none" && !labelHidden(rules.get(g.id)!, k))
        .flatMap(g => (g.anchors as Json[]).map(a => ({ id: a.id as string, at: a.at as [number, number] })))
        .sort((a, b) => a.at[1] - b.at[1] || a.at[0] - b.at[0]);
      const done = new Set<string>();
      const sampledAtK = new Set<string>();
      let sampled = 0;
      let exhausted = false;
      let used = 0;
      for (let cameraIndex = 0; cameraIndex < limit && sampled < perK; cameraIndex++) {
        const next = candidates.find(c => !done.has(c.id));
        if (!next) {
          exhausted = true;
          break;
        }
        used++;
        done.add(next.id);
        const cam: Json = { k, centre: next.at, sampled: 0 };
        v.cameras.push(cam);
        try {
          await isolateLabels(page, null);
          cam.camera = await zoomTo(page, centerOn(k, next.at[0], next.at[1]));
          await settleApp(page);
          await isolateLabels(page, null);
          const status = await waitGpu(page);
          cam.renderer = status;
          if (status.active !== "gpu" || status.timedOut) {
            cam.error = `GPU not active/settled: ${JSON.stringify(status)}`;
            continue;
          }
          const state = await page.evaluate(svgLabels, { group: null, chars: true, dpr, ids: null });
          const gpuSide = await page.evaluate(gpuGlyphs, dpr);
          if (gpuSide.error) report.errors.push(`harness: ${gpuSide.error}`);
          const shots = await captureArms(page);
          const svg = decode(shots.svg);
          const gpu = decode(shots.gpu);
          const svgInk = inkOf(svg, blanks.svg);
          const gpuInk = inkOf(gpu, blanks.gpu);
          const { width, height } = svg;
          let failedHere = false;
          // whole-label registration: is the label on the GPU at all (and where, as a diagnostic)
          const presence = (label: Json) => {
            const whole = register(svgInk, gpuInk, width, height, clipBox(pad(label.box, 2), width, height) ?? label.box, 4);
            const status = classifyRegistration(whole);
            if (status === "missing" && whole) missingLabels.push({ id: label.id, k, group: label.group, native: label.native, svgInk: whole.svgInk, gpuInkAtShift: whole.gpuInkAtShift, flat: whole.flat });
            return { whole, status };
          };
          for (const label of state.labels as Json[]) {
            if (label.inside) done.add(label.id);
            if (!label.inside || sampled >= perK || sampledAtK.has(label.id)) continue;
            if (label.charsSkipped) {
              // not in the glyph sample (no character mapping), but still checked for presence and reported
              sampledAtK.add(label.id);
              const { whole, status } = presence(label);
              if (status === "missing") failedHere = true;
              v.skipped.push({ id: label.id, k, group: label.group, native: label.native, reason: label.charsSkipped, content: label.content, numberOfChars: label.numberOfChars, presence: status, labelShift: whole && status === "registered" ? Number(whole.shift.toFixed(3)) : null });
              continue;
            }
            if (!label.chars?.length) continue;
            sampledAtK.add(label.id);
            sampled++;
            total++;
            cam.sampled++;
            sampledIds.add(label.id);
            const row: Json = { id: label.id, k, camera: cameraIndex, group: label.group, curved: label.curved, native: label.native, chars: label.chars.length, content: label.content, box: Object.fromEntries(Object.entries(label.box as Box).map(([key, n]) => [key, Math.round(n as number)])) };
            if (label.reading) row.reading = label.reading;
            const { whole, status: presenceStatus } = presence(label);
            row.presence = presenceStatus;
            if (whole && presenceStatus === "registered") {
              row.labelShift = Number(whole.shift.toFixed(3));
              labelShifts.push(whole.shift);
            }
            const charShifts: number[] = [];
            let charsMissing = 0;
            for (const c of label.chars as Json[]) {
              if (c.empty) continue;
              const box = clipBox(pad(c.extent, 1), width, height);
              if (!box) continue;
              const reg = register(svgInk, gpuInk, width, height, box, 3);
              const status = classifyRegistration(reg);
              if (status === "faint" || !reg) continue;
              if (status === "missing") {
                charsMissing++;
                missingGlyphs++;
                if (worst.length < 400) worst.push({ kind: "missing", label: label.id, k, char: c.char, i: c.i, svgInk: reg.svgInk, gpuInkAtShift: reg.gpuInkAtShift, native: label.native });
                continue;
              }
              charShifts.push(reg.shift);
              shifts.push(reg.shift);
              if (reg.shift > TOL.registerPx && worst.length < 400) worst.push({ kind: "pixel", label: label.id, k, char: c.char, i: c.i, dx: Number(reg.dx.toFixed(2)), dy: Number(reg.dy.toFixed(2)), edge: reg.edge, native: label.native });
            }
            row.pixel = { ...stats(charShifts), missing: charsMissing };
            if (label.native && Array.isArray(gpuSide.glyphs)) {
              const near = (gpuSide.glyphs as Json[]).filter(g => g.x >= label.box.x0 - 40 && g.x <= label.box.x1 + 40 && g.y >= label.box.y0 - 40 && g.y <= label.box.y1 + 40);
              const radius = Math.max(4, 0.6 * label.fontPx * k * dpr);
              // both sides on the baseline the glyphs are painted on: the GPU's (its instance, shift applied) and the
              // SVG's (its nominal position moved along the character's normal by the SVG's own central shift)
              const central = label.baseline === "central";
              const svgShift = central ? (label.centralShiftSvg ?? 0) * k * dpr : 0;
              const svgPoints = (label.chars as Json[])
                .filter(c => !c.empty)
                .map(c => {
                  const a = (c.rotation * Math.PI) / 180;
                  return { ...c, x: c.x - Math.sin(a) * svgShift, y: c.y + Math.cos(a) * svgShift };
                });
              const nominal = near as Json[];
              const pairs = matchGlyphs(svgPoints, nominal as any, radius);
              const errors = pairs.map(p => p.distance);
              analytic.push(...errors);
              const components = pairs.map(p => alongNormal(nominal[p.j].x - svgPoints[p.i].x, nominal[p.j].y - svgPoints[p.i].y, nominal[p.j].angle));
              along.push(...components.map(c => Math.abs(c.along)));
              normal.push(...components.map(c => Math.abs(c.normal)));
              if (central && pairs.length && label.centralShiftSvg !== undefined) {
                // the shift the GPU instance applies (central shift, plus dy on text.ts's measured path) next to the
                // SVG's central shift, device px: a diagnostic, the analytic error above already includes it
                const gpuShift = nominal[pairs[0].j].shift;
                centralDelta.push(Math.abs(gpuShift - svgShift));
                row.centralShift = { gpu: Number(gpuShift.toFixed(3)), svg: Number(svgShift.toFixed(3)) };
              }
              for (const [index, p] of pairs.entries()) {
                const delta = Math.abs((((svgPoints[p.i].rotation - nominal[p.j].angle) % 360) + 540) % 360 - 180);
                angles.push(delta);
                if (p.distance > TOL.glyphPx && worst.length < 400) worst.push({ kind: "analytic", label: label.id, k, char: svgPoints[p.i].char, i: svgPoints[p.i].i, error: Number(p.distance.toFixed(3)), along: Number(components[index].along.toFixed(3)), normal: Number(components[index].normal.toFixed(3)), svg: [svgPoints[p.i].x, svgPoints[p.i].y].map(n => Number(n.toFixed(2))), gpu: [nominal[p.j].x, nominal[p.j].y].map((n: number) => Number(n.toFixed(2))), baseline: label.baseline });
              }
              const missed = svgPoints.length - pairs.length;
              unmatched += missed;
              const mean = (values: number[]) => (values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(3)) : null);
              row.analytic = { ...stats(errors), unmatched: missed, baseline: label.baseline, meanAlong: mean(components.map(c => c.along)), meanNormal: mean(components.map(c => c.normal)) };
              if (missed) worst.push({ kind: "unmatched", label: label.id, k, count: missed, of: svgPoints.length });
            }
            // the analytic error is info (see the step's notes), so it does not mark a label failing
            if ((row.pixel.n && row.pixel.max > TOL.registerPx) || charsMissing || presenceStatus === "missing") {
              failedHere = true;
              if (crops < 24) {
                crops++;
                row.crop = saveCrop(join(dir, "glyphs", variant, "crops", `${label.id}-k${fmtK(k)}.png`), svg, gpu, pad(label.box, 6));
              }
            }
            v.labels.push(row);
          }
          if (keep === "all" || failedHere) cam.images = saveShots(join(dir, "glyphs", variant), `k${fmtK(k)}-c${cameraIndex}`, shots, svg, gpu);
        } catch (error) {
          cam.error = `harness: ${String(error).slice(0, 400)}`;
        }
        log(`glyphs ${variant} k ${k} camera ${cameraIndex}: sampled ${cam.sampled}${cam.error ? ` (${cam.error})` : ""}`);
        write();
      }
      spare = limit - used;
      if (sampled < perK) shortfall.push({ k, sampled, wanted: perK, exhausted, cameras: used, cameraLimit: limit });
    }
    const pixelWithin = shifts.filter(s => s <= TOL.registerPx).length;
    // a missing glyph is a glyph outside tolerance, never a 0 px shift
    const pixelCounted = shifts.length + missingGlyphs;
    const nativeLabels = (v.labels as Json[]).filter(l => l.native).length;
    const skippedByGroup: Record<string, number> = {};
    for (const s of v.skipped as Json[]) skippedByGroup[s.group ?? "labels"] = (skippedByGroup[s.group ?? "labels"] ?? 0) + 1;
    v.summary = {
      labels: v.labels.length,
      distinctLabels: sampledIds.size,
      nativeLabels,
      compatLabels: v.labels.length - nativeLabels,
      straight: (v.labels as Json[]).filter(l => !l.curved).length,
      skippedLabels: v.skipped.length,
      skippedByGroup,
      missingLabels: missingLabels.length,
      analytic: { ...stats(analytic), unmatched, along: stats(along), normal: stats(normal), angleDeg: stats(angles), centralShiftVsSvg: stats(centralDelta) },
      pixel: { ...stats(shifts), missing: missingGlyphs, withinTol: pixelCounted ? Number((pixelWithin / pixelCounted).toFixed(4)) : null },
      labelShift: stats(labelShifts)
    };
    v.missingLabels = missingLabels.slice(0, 40);
    v.worst = worst.sort((a, b) => (b.error ?? b.count ?? b.svgInk ?? Math.hypot(b.dx ?? 0, b.dy ?? 0)) - (a.error ?? a.count ?? a.svgInk ?? Math.hypot(a.dx ?? 0, a.dy ?? 0))).slice(0, 40);
    const failures: string[] = [];
    // a world with fewer (label, zoom) pairs on screen than the target is a fixture limit (noted); running out of
    // camera budget with labels left is a harness limit (fails)
    v.shortfall = shortfall;
    if (v.labels.length < sampleTarget) {
      const budget = shortfall.filter(s => !s.exhausted);
      if (budget.length) failures.push(`sample ${v.labels.length} < ${sampleTarget} labels with candidates left at k ${budget.map(s => s.k).join(", ")} (camera budget)`);
      else v.note = `every on-screen label at k ${glyphKs.join("/")} sampled: ${v.labels.length} < ${sampleTarget} (${sampledIds.size} distinct labels)`;
    }
    if (missingLabels.length) failures.push(`presence: ${missingLabels.length} on-screen labels have (almost) no GPU ink where the SVG draws them (${missingLabels.slice(0, 4).map(m => `${m.id}@k${m.k}`).join(", ")})`);
    // W3b GLYPH2: the analytic check is info, not a gate. Since W3 GLYPH, text.ts anchors a laid-out glyph at the SVG's
    // own getStart/EndPositionOfChar midpoint and the central shift with the same probe and ceil rule this harness
    // reads, so the analytic error compares the SVG position API with itself (it reads 0 by construction) and cannot
    // see a fidelity regression. Pixel registration (SVG ink against GPU ink, every label) is the position gate.
    const notes: string[] = [];
    if (analytic.length && v.summary.analytic.max > TOL.glyphPx) notes.push(`analytic: ${analytic.filter(e => e > TOL.glyphPx).length}/${analytic.length} native glyphs off by > ${TOL.glyphPx} device px (max ${v.summary.analytic.max}; along the baseline p95 ${v.summary.analytic.along.p95}, normal p95 ${v.summary.analytic.normal.p95})`);
    if (unmatched) notes.push(`analytic: ${unmatched} native characters have no GPU glyph of the same character within reach`);
    v.info = notes;
    const nativeCurved = (v.labels as Json[]).filter(l => l.native && l.curved).length;
    if (variant === "native" && !nativeCurved) failures.push("native: no native curved label was sampled (the variant exists to exercise them)");
    if (pixelCounted && pixelWithin / pixelCounted < TOL.registerShare) failures.push(`pixel: ${pixelCounted - pixelWithin}/${pixelCounted} glyphs shifted > ${TOL.registerPx} device px or missing (${missingGlyphs} missing; ${((pixelWithin / pixelCounted) * 100).toFixed(2)}% within, need ${TOL.registerShare * 100}%; p95 ${v.summary.pixel.p95}, max ${v.summary.pixel.max})`);
    if (!pixelCounted) failures.push("pixel: no glyph had enough ink to register");
    v.failures = failures;
    v.pass = failures.length === 0;
    log(`${v.pass ? "PASS" : "FAIL"} glyphs ${variant}: ${JSON.stringify(v.summary)}${v.pass ? "" : ` :: ${failures.join("; ")}`}`);
  }
  await page.evaluate(setVariant, "map");
  const failing = Object.entries(result.variants as Json).filter(([, v]) => !v.pass);
  result.failure = failing.length ? failing.map(([name, v]) => `${name}: ${v.failures.join("; ")}`).join(" | ") : null;
  return result;
}

// ------------------------------------------------------------------ step: advance

async function stepAdvance(page: Page): Promise<Json> {
  const out = await page.evaluate(
    async ({ dpr, limit, only, tolPx }) => {
      const w = globalThis as any;
      const families: string[] = [...new Set<string>([...(w.fonts as { family: string }[]).map(f => f.family), ...[...document.querySelectorAll("#labels g")].map(g => g.getAttribute("font-family") || "").filter(Boolean)])];
      const chosen = only ? families.filter(f => only.includes(f)) : limit > 0 ? families.slice(0, limit) : families;
      const mapStrings = [...new Set([...document.querySelectorAll("#labels text")].map(t => (t.textContent || "").replace(/\s+/g, " ").trim()).filter(s => s.length >= 3))].slice(0, 10);
      // W3b: "Saffron Thistlefield" carries ligature triggers (ff, Th, fi), which no other probe string has
      const strings = ["Bothersian Empire", "Kingdom of Ardvale", "AVAWATo Ty. Wavy", "Hamlet Quaywick", "Ëlvenmoor Ærø", "Saffron Thistlefield", ...mapStrings];
      const sizes = [6, 14, 22];
      const ks = [1, 1.5, 3];
      const renderings = ["auto", "optimizeSpeed"];
      const bucketOf = (s: number) => Math.min(16, 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(1, s)))));
      const ns = "http://www.w3.org/2000/svg";
      const host = document.createElementNS(ns, "svg");
      host.setAttribute("width", "10");
      host.setAttribute("height", "10");
      host.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;pointer-events:none";
      const group = document.createElementNS(ns, "g");
      const text = document.createElementNS(ns, "text") as SVGTextElement;
      group.append(text);
      host.append(group);
      document.body.append(host);
      const context = document.createElement("canvas").getContext("2d")!;
      // text.ts's own compat routing (shapingReason through the GPU renderer's atlas): a string it sends to compat is
      // drawn from the SVG raster, so only the strings the GPU draws natively are held to the measured model
      const atlas = w.gpuRenderer?.atlas;
      if (typeof atlas?.shaping !== "function") throw new Error("gpuRenderer.atlas.shaping is not readable (text.ts shapingReason)");
      const rows: any[] = [];
      try {
        for (const family of families.filter(f => chosen.includes(f))) {
          const sample = strings.join(" ");
          let loadState = "ok";
          try {
            const late = new Promise<string>(done => setTimeout(() => done("timeout"), 5000));
            const loaded = await Promise.race([document.fonts.load(`16px "${family}"`, sample).then(faces => (faces.length ? "loaded" : "no face")), late]);
            loadState = loaded;
          } catch (error) {
            loadState = `failed: ${String(error).slice(0, 80)}`;
          }
          // a family without a FontFace that the host does not have either falls back: both fallbacks then match
          const width = (font: string) => {
            context.font = font;
            return context.measureText(sample).width;
          };
          const available = width(`40px "${family}", monospace`) !== width("40px monospace") || width(`40px "${family}", serif`) !== width("40px serif");
          // maxCumPx: the measured model over every case (what the GPU would draw if it drew them all natively);
          // maxNativePx: over the cases text.ts keeps native (gated); compat: cases text.ts routes to compat, and
          // compatWithin those the model would have drawn within tolerance anyway (over-routing, reported)
          const row: any = { family, loadState, available, worst: null, worstNative: null, maxCumPx: 0, maxNativePx: 0, maxAdvancePx: 0, cases: 0, compat: 0, compatWithin: 0, compatStrings: [] as string[], byRendering: {} as Record<string, number>, worstBy: {} as Record<string, unknown>, byStrings: {} as Record<string, number>, grid: {} as Record<string, number> };
          text.setAttribute("font-family", family);
          for (const rendering of renderings) {
            text.setAttribute("text-rendering", rendering);
            for (const size of sizes) {
              text.setAttribute("font-size", String(size));
              for (const k of ks) {
                group.setAttribute("transform", `scale(${k})`);
                const bucket = bucketOf(k * dpr);
                const cs = getComputedStyle(text);
                const font = `${cs.fontStyle} ${cs.fontWeight} ${size * bucket}px ${cs.fontFamily}`;
                context.font = font;
                // text.ts's measured layout (the path for a label the SVG has not laid out): always kerned, as SVG is;
                // ligatures and contextual alternates off under optimizeSpeed, as SVG has them (text.ts shapingFeatures)
                context.fontKerning = "auto";
                context.textRendering = rendering === "optimizeSpeed" ? "optimizeSpeed" : "auto";
                for (const s of strings) {
                  text.textContent = s;
                  const n = text.getNumberOfChars();
                  if (n !== s.length) continue;
                  const routed = !!atlas.shaping(font, s, rendering, 0);
                  // the routing call reuses canvases: restore this one's state
                  context.font = font;
                  context.fontKerning = "auto";
                  context.textRendering = rendering === "optimizeSpeed" ? "optimizeSpeed" : "auto";
                  let caseMax = 0;
                  let previousSvg = 0;
                  let previousGpu = 0;
                  const origin = text.getStartPositionOfChar(0).x;
                  // text.ts wholeRun: no-break spaces keep Canvas2D from shaping word by word (kerns across spaces)
                  const nbsp = Math.abs(context.measureText(" ").width - context.measureText("\u00a0").width) <= 1e-6;
                  const W = (x: string) => context.measureText(nbsp ? x.replaceAll(" ", "\u00a0") : x).width;
                  // text.ts kernsBefore / kernOffsets: a legacy 'kern' table pair is split by HarfBuzz and Chromium
                  // reports the second character half the kern before its painted origin; a GPOS pair is not. Which
                  // one is read off the SVG's own character advances, as text.ts does.
                  const kerns = [...s].map((c, i) => (i ? W(s.slice(0, i + 1)) - W(s.slice(0, i)) - W(c) : 0));
                  let splitFit = 0;
                  let gposFit = 0;
                  for (let i = 0; i < n; i++) {
                    const reported = text.getEndPositionOfChar(i).x - text.getStartPositionOfChar(i).x;
                    const next = kerns[i + 1] ?? 0;
                    splitFit += Math.abs(reported - (W(s[i]) + (kerns[i] + next) / 2) / bucket);
                    gposFit += Math.abs(reported - (W(s[i]) + next) / bucket);
                  }
                  const split = splitFit < gposFit;
                  for (let i = 1; i <= n; i++) {
                    // where the SVG reports character i (the end of the last one for i = n), in user units
                    const svg = (i < n ? text.getStartPositionOfChar(i).x : text.getEndPositionOfChar(n - 1).x) - origin;
                    // text.ts kernedAdvances puts character i's painted origin at width(prefix(i+1)) - width(char i);
                    // the reported start the model predicts is that, less half the kern when the font's kerns split
                    const offset = i < n && split ? kerns[i] / 2 : 0;
                    const gpu = (i < n ? W(s.slice(0, i + 1)) - W(s[i]) - offset : W(s)) / bucket;
                    const cum = Math.abs(gpu - svg) * k * dpr;
                    const advance = Math.abs(gpu - previousGpu - (svg - previousSvg)) * k * dpr;
                    previousSvg = svg;
                    previousGpu = gpu;
                    caseMax = Math.max(caseMax, cum);
                    if (!routed && cum > row.maxNativePx) {
                      row.maxNativePx = cum;
                      row.worstNative = { rendering, size, k, bucket, string: s, prefix: i, svg: Number(svg.toFixed(4)), gpu: Number(gpu.toFixed(4)) };
                    }
                    if (cum > (row.byRendering[rendering] ?? 0)) row.worstBy[rendering] = { size, k, string: s, prefix: i, svg: Number(svg.toFixed(3)), gpu: Number(gpu.toFixed(3)) };
                    row.byRendering[rendering] = Math.max(row.byRendering[rendering] ?? 0, cum);
                    const set = mapStrings.includes(s) ? "mapStrings" : "probeStrings";
                    row.byStrings[set] = Math.max(row.byStrings[set] ?? 0, cum);
                    const cellKey = `${rendering}/${size}px/k${k}`;
                    row.grid[cellKey] = Math.max(row.grid[cellKey] ?? 0, cum);
                    if (cum > row.maxCumPx) {
                      row.maxCumPx = cum;
                      row.worst = { rendering, size, k, bucket, string: s, prefix: i, svg: Number(svg.toFixed(4)), gpu: Number(gpu.toFixed(4)) };
                    }
                    row.maxAdvancePx = Math.max(row.maxAdvancePx, advance);
                  }
                  row.cases++;
                  if (routed) {
                    row.compat++;
                    if (caseMax <= tolPx) row.compatWithin++;
                    if (!row.compatStrings.includes(s) && row.compatStrings.length < 12) row.compatStrings.push(s);
                  }
                }
              }
            }
          }
          row.maxCumPx = Number(row.maxCumPx.toFixed(3));
          row.maxNativePx = Number(row.maxNativePx.toFixed(3));
          row.maxAdvancePx = Number(row.maxAdvancePx.toFixed(3));
          for (const key of Object.keys(row.byRendering)) row.byRendering[key] = Number(row.byRendering[key].toFixed(3));
          for (const key of Object.keys(row.grid)) row.grid[key] = Number(row.grid[key].toFixed(3));
          for (const key of Object.keys(row.byStrings)) row.byStrings[key] = Number(row.byStrings[key].toFixed(3));
          rows.push(row);
        }
      } finally {
        host.remove();
      }
      return { families: families.length, measured: rows.length, strings, sizes, ks, renderings, rows };
    },
    { dpr, limit: advanceFontLimit, only: advanceFamilies, tolPx: TOL.advancePx }
  );
  const rows = out.rows as Json[];
  const failing = rows.filter(r => r.available && r.maxNativePx > TOL.advancePx);
  const unavailable = rows.filter(r => !r.available);
  const available = rows.filter(r => r.available);
  for (const r of rows) log(`${r.available && r.maxNativePx > TOL.advancePx ? "FAIL" : r.available ? "PASS" : "SKIP"} advance ${r.family}: native max ${r.maxNativePx} px over ${r.cases - r.compat}/${r.cases} cases (compat ${r.compat}, ${r.compatWithin} of them within tolerance); model over all cases ${r.maxCumPx} px (${Object.entries(r.byRendering).map(([k, v]) => `${k} ${v}`).join(", ")}), max advance ${r.maxAdvancePx} px (${r.loadState}${r.available ? "" : ", not available on this host"})`);
  const byRendering = (key: string) => rows.filter(r => r.available && (r.byRendering[key] ?? 0) > TOL.advancePx).length;
  const byStrings = (key: string) => rows.filter(r => r.available && (r.byStrings[key] ?? 0) > TOL.advancePx).length;
  return {
    ...out,
    summary: {
      measured: rows.length,
      available: rows.length - unavailable.length,
      pass: rows.length - unavailable.length - failing.length,
      fail: failing.length,
      // the measured model over every case, as before W3b (what the GPU would draw if it kept them all native)
      modelFail: rows.filter(r => r.available && r.maxCumPx > TOL.advancePx).length,
      modelFailAuto: byRendering("auto"),
      modelFailOptimizeSpeed: byRendering("optimizeSpeed"),
      modelFailMapStrings: byStrings("mapStrings"),
      modelFailProbeStrings: byStrings("probeStrings"),
      cases: available.reduce((n, r) => n + r.cases, 0),
      compatCases: available.reduce((n, r) => n + r.compat, 0),
      compatWithin: available.reduce((n, r) => n + r.compatWithin, 0),
      compatFonts: available.filter(r => r.compat).map(r => `${r.family} ${r.compat}/${r.cases}`),
      allCompat: available.filter(r => r.cases && r.compat === r.cases).map(r => r.family),
      unavailable: unavailable.map(r => `${r.family} (${r.loadState})`)
    },
    failure: failing.length
      ? `${failing.length}/${rows.length - unavailable.length} available fonts draw natively > ${TOL.advancePx} device px off the SVG: ${failing.slice(0, 8).map(r => `${r.family} ${r.maxNativePx} px`).join(", ")}`
      : rows.length - unavailable.length
        ? null
        : "no available font measured"
  };
}

// ------------------------------------------------------------------ step: fonts (Style panel switches)

async function openStyleFor(page: Page, group: string) {
  if (!(await page.locator("#options").isVisible())) await page.click("#optionsTrigger");
  await page.click("#styleTab");
  await page.selectOption("#styleElementSelect", "labels");
  await page.selectOption("#styleGroupSelect", group);
}
async function closeOptions(page: Page) {
  if (await page.locator("#options").isVisible()) await page.click("#optionsHide");
}
async function addFontViaDialog(page: Page, sw: FontSwitch) {
  await page.click("#styleFontAdd");
  await page.locator("#addFontDialog").waitFor({ state: "visible" });
  await page.selectOption("#addFontMethod", sw.kind);
  await page.fill("#addFontNameInput", sw.family);
  if ("url" in sw) await page.fill("#addFontURLInput", sw.url);
  await page.locator(".ui-dialog").filter({ has: page.locator("#addFontDialog") }).getByRole("button", { name: "Add" }).click();
  await page.locator("#addFontDialog").waitFor({ state: "hidden" });
}
const groupFont = (page: Page, group: string) => page.evaluate(id => document.querySelector(`#labels #${CSS.escape(id)}`)?.getAttribute("font-family") ?? null, group);

// Puts the switched groups' font-family attributes back as they were (null: removed) and waits for a GPU frame of it.
async function restoreFonts(page: Page, targets: string[], original: (string | null)[]): Promise<{ ok: boolean; now: (string | null)[] }> {
  await page.evaluate(
    ({ targets, original }) =>
      targets.forEach((id, i) => {
        const group = document.querySelector(`#labels #${CSS.escape(id)}`);
        if (!group) return;
        if (original[i] === null) group.removeAttribute("font-family");
        else group.setAttribute("font-family", original[i] as string);
      }),
    { targets, original }
  );
  await settleApp(page);
  await waitGpu(page);
  const now = await Promise.all(targets.map(id => groupFont(page, id)));
  return { ok: now.every((family, i) => family === original[i]), now };
}

// Which labels of each group the GPU drew natively, and the labels layer's routing reasons. Per group: visible labels
// by lane, hidden ones (not visible in the SVG) and the DOM total; for the `watch` groups, the visible label ids.
function routing(watch: string[] = []): Json {
  const w = globalThis as any;
  const runs = w.gpuRenderer?.prepared?.runs;
  const compat = new Set<Element>();
  for (const run of Array.isArray(runs) ? runs : []) for (const e of run.elements ?? []) compat.add(e);
  const groups: Record<string, { native: number; compat: number; hidden: number; total: number; ids?: string[] }> = {};
  for (const text of document.querySelectorAll("#labels text")) {
    const group = (text.closest("#labels g[data-size]") as Element | null)?.id ?? "labels";
    groups[group] ??= { native: 0, compat: 0, hidden: 0, total: 0 };
    groups[group].total++;
    if (!(text as any).checkVisibility({ visibilityProperty: true })) {
      groups[group].hidden++;
      continue;
    }
    let native = !!text.querySelector("textPath");
    for (let e: Element | null = text; e && e.id !== "viewbox"; e = e.parentElement) if (compat.has(e)) native = false;
    groups[group][native ? "native" : "compat"]++;
    if (watch.includes(group)) (groups[group].ids ??= []).push(text.id);
  }
  const status = w.rendererStatus?.();
  const atlasFonts = w.gpuRenderer?.atlas?.glyphs instanceof Map ? [...new Set([...w.gpuRenderer.atlas.glyphs.keys()].map((k: string) => k.split("|")[0]))] : null;
  return { groups, layer: status?.gpu?.layers?.labels ?? null, atlasFonts, active: status?.active, fallbackReason: status?.fallbackReason ?? null };
}

async function stepFonts(page: Page, blanks: Blanks, dir: string, world: string): Promise<Json> {
  const result: Json = { switches: [] as Json[] };
  const groups = await page.evaluate(() => [...document.querySelectorAll<SVGGElement>("#labels g[data-size]")].map(g => ({ id: g.id, texts: g.querySelectorAll(":scope > text").length, hidden: g.classList.contains("hidden") })));
  const curved = groups.find(g => g.id === "states" && g.texts) ?? null;
  const straight = groups.find(g => !g.hidden && g.texts && g.id !== "states" && g.id !== "addedLabels" && g.id !== "parityLabels") ?? null;
  const targets = [curved?.id, straight?.id].filter((id): id is string => !!id);
  result.targets = targets;
  if (!targets.length) return { ...result, failure: "no visible states or burg label group to switch" };
  // the groups' own font-family, put back after the switches: the last switch leaves the broken face on them, and the
  // steps after this one (zoom: its shadow probe takes the map's label face) must see the map as loaded
  const original = await page.evaluate(ids => ids.map(id => document.querySelector(`#labels #${CSS.escape(id)}`)?.getAttribute("font-family") ?? null), targets);
  // native variant: state labels go native, so the switch exercises the glyph atlas as well as the compat lane
  result.variant = await page.evaluate(setVariant, "native");
  const camera = centerOn(1, ...((await page.evaluate(() => [(globalThis as any).graphWidth / 2, (globalThis as any).graphHeight / 2])) as [number, number]));
  await isolateLabels(page, null);
  result.camera = await zoomTo(page, camera);
  await settleApp(page);
  await isolateLabels(page, null);
  await waitGpu(page);
  const before = await page.evaluate(routing, targets);
  result.before = before;
  // the same golden before any switch: what a switch adds or removes is the difference from this
  {
    const shots = await captureArms(page);
    const svg = decode(shots.svg);
    const gpu = decode(shots.gpu);
    const m = measureCell(svg, gpu, blanks.svg, blanks.gpu);
    result.baseline = { fonts: await page.evaluate(ids => ids.map(id => document.querySelector(`#labels #${CSS.escape(id)}`)?.getAttribute("font-family")), targets), metrics: roundMetrics(m), images: saveShots(join(dir, "fonts"), "before", shots, svg, gpu) };
    log(`fonts ${world}/before ssim ${result.baseline.metrics.ssim} over16 ${result.baseline.metrics.over16Fraction} over44 ${result.baseline.metrics.over44Fraction} ink ${result.baseline.metrics.inkRatio}`);
  }
  for (const sw of FONT_SWITCHES) {
    if (fontFilter && !fontFilter.has(sw.id)) continue;
    const cell: Json = { id: sw.id, family: sw.family, kind: sw.kind, note: sw.note, pass: false, failures: [] as string[] };
    result.switches.push(cell);
    const started = Date.now();
    const frozen = breakMode === "freeze";
    try {
      const prior = await page.evaluate(routing, targets);
      if (frozen) await page.evaluate(freezeGpu, true);
      // the first target through the dialog (or the select), the second through the select, as a user would
      for (const [index, group] of targets.entries()) {
        await openStyleFor(page, group);
        if (sw.kind === "select" || index > 0) {
          const listed = await page.evaluate(f => [...(document.getElementById("styleSelectFont") as HTMLSelectElement).options].some(o => o.value === f), sw.family);
          if (!listed) throw Error(`${sw.family} is not in the font select`);
          await page.selectOption("#styleSelectFont", sw.family);
        } else await addFontViaDialog(page, sw);
        // the Google path applies the font once its faces load
        await page.waitForFunction(({ id, family }) => document.querySelector(`#labels #${CSS.escape(id)}`)?.getAttribute("font-family") === family, { id: group, family: sw.family }, { timeout: 20000 }).catch(() => {});
        const applied = await groupFont(page, group);
        if (applied !== sw.family) cell.failures.push(`ui: #${group} font-family is ${applied}, not ${sw.family}`);
      }
      await closeOptions(page);
      await settleApp(page);
      await isolateLabels(page, null);
      const fontState = await page.evaluate(
        async ({ family, targets }) => {
          const faces = [...document.fonts].filter(f => f.family.replace(/^["']|["']$/g, "") === family).map(f => f.status);
          try {
            await Promise.race([document.fonts.ready, new Promise(done => setTimeout(done, 8000))]);
          } catch {}
          const computed = targets.map(id => {
            const t = document.querySelector(`#labels #${CSS.escape(id)} text`);
            return t ? getComputedStyle(t).fontFamily : null;
          });
          let check: boolean | string;
          try {
            check = document.fonts.check(`16px "${family}"`);
          } catch (error) {
            check = String(error);
          }
          return { faces, facesAfter: [...document.fonts].filter(f => f.family.replace(/^["']|["']$/g, "") === family).map(f => f.status), computed, check };
        },
        { family: sw.family, targets }
      );
      cell.font = fontState;
      const status = await waitGpu(page);
      cell.renderer = status;
      const after = await page.evaluate(routing, targets);
      cell.routing = after;
      if (status.active !== "gpu") cell.failures.push(`GPU not active: ${status.fallbackReason ?? "no frame"}`);
      else if (status.timedOut) cell.failures.push("GPU frame did not settle within 90 s");
      for (const [index, family] of fontState.computed.entries()) if (!family?.includes(sw.family)) cell.failures.push(`svg: #${targets[index]} text computes font-family ${family}`);
      const reasons: string[] = after.layer?.reasons ?? [];
      const named = reasons.some(r => r.includes("font") && r.includes(sw.family));
      if (sw.id === "broken") {
        if (!named) cell.failures.push(`broken font: the labels layer reasons do not name it (${JSON.stringify(reasons)})`);
        if (curved && after.groups[curved.id]?.native) cell.failures.push(`broken font: ${after.groups[curved.id].native} #${curved.id} labels still native`);
      } else if (named) cell.failures.push(`font ${sw.family} sent labels to compat: ${reasons.filter(r => r.includes("font")).join("; ")}`);
      // only the switched groups may change lane (one bad font costs only its own labels)
      for (const [group, counts] of Object.entries(prior.groups as Record<string, Json>))
        if (!targets.includes(group) && (after.groups[group]?.native ?? 0) !== counts.native) cell.failures.push(`#${group} (not switched) went from ${counts.native} to ${after.groups[group]?.native ?? 0} native labels`);
      // the switched groups keep every label they showed: a label that leaves the lane count (native + compat) without
      // the SVG hiding it, or a label removed from the DOM, fails; one the app hid in the SVG is a note
      for (const group of targets) {
        const [was, now] = [prior.groups[group], after.groups[group]];
        const [wasShown, nowShown] = [(was?.native ?? 0) + (was?.compat ?? 0), (now?.native ?? 0) + (now?.compat ?? 0)];
        if (wasShown === nowShown) continue;
        const left = (was?.ids ?? []).filter((id: string) => !(now?.ids ?? []).includes(id));
        const detail = await page.evaluate(
          ids =>
            ids.map(id => {
              const t = document.getElementById(id);
              if (!t) return { id, inDom: false };
              const path = t.querySelector("textPath");
              const href = path?.getAttribute("href") || path?.getAttribute("xlink:href") || "";
              const geometry = href.startsWith("#") ? (document.getElementById(href.slice(1)) as unknown as SVGPathElement | null) : null;
              return { id, inDom: true, text: (t.textContent || "").slice(0, 60), visible: (t as any).checkVisibility({ visibilityProperty: true }), display: getComputedStyle(t).display, visibility: getComputedStyle(t).visibility, chars: (t as unknown as SVGTextElement).getNumberOfChars(), pathLength: geometry?.getTotalLength?.() ?? null, textLength: (t as unknown as SVGTextElement).getComputedTextLength() };
            }),
          left
        );
        cell.leftRouting = { ...(cell.leftRouting ?? {}), [group]: detail };
        // the app itself may hide a label after a font switch (label-culling.ts sets display:none on a label whose
        // box leaves the view): the SVG and the GPU then agree, and the golden compares them. A note, not a failure, when
        // every label that left is still in the DOM and hidden in the SVG and none was removed.
        const svgHid = (was?.total ?? 0) === (now?.total ?? 0) && left.length === wasShown - nowShown && detail.every((d: Json) => d.inDom && d.visible === false);
        const shownBack = nowShown > wasShown && (was?.total ?? 0) === (now?.total ?? 0) && (now?.hidden ?? 0) === (was?.hidden ?? 0) - (nowShown - wasShown);
        if (svgHid || shownBack) {
          (cell.notes ??= []).push(`#${group}: ${svgHid ? `the SVG hid ${left.join(", ")} after the switch (display ${detail.map((d: Json) => d.display).join("/")})` : `the SVG shows ${nowShown - wasShown} label(s) again`}; both arms follow it`);
          continue;
        }
        cell.failures.push(`routing: #${group} showed ${wasShown} labels (native + compat) before the switch and ${nowShown} after (${left.slice(0, 4).join(", ") || "ids unchanged"}; hidden ${was?.hidden ?? 0} -> ${now?.hidden ?? 0}, DOM ${was?.total ?? 0} -> ${now?.total ?? 0})`);
      }
      // re-atlas: native labels of the switched group were laid out with the new face
      if (curved && after.groups[curved.id]?.native && !(after.atlasFonts ?? []).some((f: string) => f.includes(sw.family))) cell.failures.push(`re-atlas: ${after.groups[curved.id].native} native #${curved.id} labels but no atlas glyph uses ${sw.family} (atlas fonts ${JSON.stringify(after.atlasFonts)})`);
      const shots = await captureArms(page);
      if (frozen) await page.evaluate(freezeGpu, false);
      const svg = decode(shots.svg);
      const gpu = decode(shots.gpu);
      const m: CellMetrics = measureCell(svg, gpu, blanks.svg, blanks.gpu);
      cell.metrics = roundMetrics(m);
      if (result.baseline) cell.vsBefore = { ssim: Number((m.ssim - result.baseline.metrics.ssim).toFixed(5)), over16Fraction: Number((m.over16Fraction - result.baseline.metrics.over16Fraction).toFixed(5)), over44Fraction: Number((m.over44Fraction - result.baseline.metrics.over44Fraction).toFixed(5)), inkRatio: Number((m.inkRatio - result.baseline.metrics.inkRatio).toFixed(5)) };
      cell.gates = {
        ssim: m.ssim >= D1.ssimMin,
        over16: m.over16Fraction <= D1.over16Max,
        over44: m.over44Fraction <= D1.over44Max,
        inkRatio: m.inkRatio >= TOL.inkRatioMin,
        conservative: m.changedFraction <= D1.conservativeChangedMax && m.maxDelta <= D1.conservativeMaxDelta // reported, not gated (D11)
      };
      for (const gate of ["ssim", "over16", "over44", "inkRatio"] as const) if (!cell.gates[gate]) cell.failures.push(`golden ${gate}: ssim ${m.ssim.toFixed(4)} over16 ${(m.over16Fraction * 100).toFixed(3)}% over44 ${(m.over44Fraction * 100).toFixed(3)}% ink ${m.inkGpu}/${m.inkSvg}`);
      if (frozen) cell.break = "freeze";
      cell.pass = cell.failures.length === 0;
      if (keep === "all" || !cell.pass) cell.images = saveShots(join(dir, "fonts"), sw.id, shots, svg, gpu);
    } catch (error) {
      cell.failures.push(`harness: ${String(error).slice(0, 400)}`);
      if (frozen) await page.evaluate(freezeGpu, false).catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
    }
    cell.seconds = Number(((Date.now() - started) / 1000).toFixed(1));
    log(`${cell.pass ? "PASS" : "FAIL"} fonts ${world}/${sw.id} ${sw.family}${cell.metrics ? ` ssim ${cell.metrics.ssim} over44 ${cell.metrics.over44Fraction} ink ${cell.metrics.inkRatio}` : ""}${cell.pass ? "" : ` :: ${cell.failures.join("; ")}`}`);
    write();
  }
  await page.evaluate(setVariant, "map");
  result.restored = await restoreFonts(page, targets, original);
  const failing = (result.switches as Json[]).filter(c => !c.pass);
  result.summary = { switches: result.switches.length, pass: result.switches.length - failing.length, fail: failing.length };
  result.failure = failing.length ? `${failing.length}/${result.switches.length} font switches failed: ${failing.map(c => `${c.id} (${c.failures[0]})`).join("; ")}` : result.switches.length ? null : "no font switch ran";
  if (!result.restored.ok) result.failure = [result.failure, `fonts not restored: ${JSON.stringify(result.restored.now)} (was ${JSON.stringify(original)})`].filter(Boolean).join("; ");
  return result;
}

// ------------------------------------------------------------------ step: zoom (W3b GLYPH2)
// Cameras between powers of two. Every other step captures where the GPU prepared (and gate cameras are powers of two,
// where the raster bucket is exact), so two things Chromium does per zoom were invisible to the gate:
// - shadows: text-shadow is screen space (CSS px), but glyph masks are cut at the raster bucket. Straight text outside
//   #labels is what the GPU draws natively with its shadow (inside #labels a shadowed label is a compat run, and the
//   map's are restyled by every zoom), so the harness places its own probe layer (shadowProbe: five straight texts,
//   5-24 units, in the map's label face, #labels hidden meanwhile) with a visible shadow on both arms (a glow and an
//   offset one). Each ZOOM_SHADOW_PAIRS camera is prepared at the first zoom and viewed at the second with the
//   renderer blind to mutations (a carried frame, as a gesture shows until it settles), plus one fresh prepare
//   between powers of two; the probe's padded boxes are judged as a golden: D1 (SSIM, over16, over44 per D11) and
//   D11 coverage (ink ratio, over16 of the layer's ink). A cell where the GPU drew no probe text natively with a
//   shadow fails (nothing to judge).
// - carry: Chromium rounds the central baseline per zoom; a baked one drifts in a carried frame (W3b probe: up to
//   3.5 device px). Each ZOOM_CARRY pair is prepared and viewed the same way, rescaleLabels off for the whole step
//   (the label DOM is then the same at both zooms; the frame identity must hold), `native` variant. The GPU's own
//   glyph instances (native curved labels) are pixel-registered as in the glyphs step (TOL.registerShare within
//   TOL.registerPx, missing glyphs count against it; labels the zoom restyled, textSignatures, are left out). The
//   labels golden against a fresh prepare of the same view (CARRY_MARGIN) and the fresh prepare's own D11 verdict
//   are info (summary.freshD11): compat runs carry a raster of the prepared zoom until the settle refines it.
// - fresh (W4a GLYPHZ): a frame prepared and settled at each ZOOM_FRESH camera, `native` variant, judged as the labels
//   golden (D1 and D11 coverage, gated). Between powers of two the prepare cuts glyphs at the raster bucket and the
//   settle re-cuts them at k * dpr (src/gpu/glyph-fine.ts); before that re-cut existed these cameras missed the D11
//   over16-of-ink cap (W3b GLYPH2 freshD11 22-37%). The cell records which glyph set the frame draws (`fine`), and
//   pixel-registers the native glyphs (info).
const ZOOM_PARTS = (env.LABELS_ZOOM_PARTS || "shadows,carry,fresh").split(",");
// fresh-prepare cameras between powers of two (dpr 2: raster buckets 4 and 8)
const ZOOM_FRESH = [1.1, 1.4, 1.9, 2.8, 3.5];
// [prepared, viewed] zoom pairs within one bucket at dpr 2; [1.5, 1.5] is a fresh prepare between powers of two
const ZOOM_SHADOW_PAIRS: [number, number][] = [
  [1.1, 1.9],
  [1.9, 1.1],
  [2.2, 3],
  [1.5, 1.5]
];
const ZOOM_SHADOW_PAD = 12; // CSS px around a text: the offset shadow's 3px + 3 sigma (2px blur -> sigma 1) and the glow's 3 sigma (4px -> 6px)
const ZOOM_SHADOWS = [
  { id: "glow", value: "rgb(200, 30, 30) 0px 0px 4px" },
  { id: "offset", value: "rgb(200, 30, 30) 3px 2px 2px" }
];
// info: how much worse a carried frame's labels golden may read than a fresh prepare of the same view before it is noted
const CARRY_MARGIN = { ssim: 0.001, over16OfInk: 0.01, inkRatio: 0.01 };
const ZOOM_CARRY: [number, number][] = [
  [1.1, 1.9],
  [1.9, 1.1],
  [2.3, 3.7]
];

// The shadows probe: g#labelsHarnessShadow, a layer of its own in #viewbox after #labels (straight text outside
// #labels is what the GPU draws natively with its shadow: scene.ts nativeText; inside #labels it is a compat run), with
// straight texts at `at` (world units) in the face and fill of the map's first label group, sizes 5-24 units, and
// `shadow` as their text-shadow; #labels itself is hidden meanwhile. null removes it and shows #labels again.
function shadowProbe(args: { at: [number, number]; shadow: string } | null): number {
  const w = globalThis as any;
  document.getElementById("labelsHarnessShadow")?.remove();
  const labels = document.getElementById("labels") as unknown as SVGGElement | null;
  if (!labels?.parentElement) throw Error("shadowProbe: no #labels");
  // the map's labels are hidden meanwhile: they are not what this probe judges, and they overlap it
  if (w.__labelsProbeHid !== undefined) {
    labels.style.display = w.__labelsProbeHid;
    w.__labelsProbeHid = undefined;
  }
  if (!args) return 0;
  w.__labelsProbeHid = labels.style.display;
  labels.style.display = "none";
  const ns = "http://www.w3.org/2000/svg";
  const model = labels.querySelector<SVGTextElement>("g[data-size] text");
  const style = model ? getComputedStyle(model) : null;
  const g = document.createElementNS(ns, "g");
  g.id = "labelsHarnessShadow";
  g.setAttribute("font-family", style?.fontFamily ?? "Georgia");
  g.setAttribute("fill", style?.fill ?? "#333");
  g.setAttribute("text-anchor", "middle");
  g.style.textShadow = args.shadow;
  let y = args.at[1] - 40;
  const texts = [
    ["Bothersian Hold", 5],
    ["Kingdom of Ardvale", 8],
    ["Lake Varn Quaywick", 12],
    ["Theodan Marches", 17],
    ["Port Velmar", 24]
  ] as const;
  texts.forEach(([content, size], i) => {
    const t = document.createElementNS(ns, "text");
    t.id = `labelsHarnessShadow${i}`;
    y += size * 1.3;
    t.setAttribute("x", String(args.at[0]));
    t.setAttribute("y", String(y));
    t.setAttribute("font-size", String(size));
    t.textContent = content;
    g.append(t);
  });
  labels.after(g);
  return texts.length;
}

// The probe texts as the page shows them: ids, padded device-px boxes, how many the GPU drew natively (no compat run
// covers them) and the frame's soft (shadow) glyph cells (src/gpu/text.ts: negative alpha, GLYPH_FLOATS 18).
function shadowProbeState(args: { dpr: number; pad: number }): Json {
  const w = globalThis as any;
  const compat = new Set<Element>();
  for (const run of Array.isArray(w.gpuRenderer?.prepared?.runs) ? w.gpuRenderer.prepared.runs : []) for (const e of run.elements ?? []) compat.add(e);
  const texts = [...document.querySelectorAll<SVGTextElement>("#labelsHarnessShadow text")];
  const ids: string[] = [];
  const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  let native = 0;
  for (const text of texts) {
    ids.push(text.id);
    let lane = !!w.gpuRenderer?.prepared;
    for (let e: Element | null = text; e && e.id !== "viewbox"; e = e.parentElement) if (compat.has(e)) lane = false;
    if (lane) native++;
    const r = text.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) boxes.push({ x0: (r.left - args.pad) * args.dpr, y0: (r.top - args.pad) * args.dpr, x1: (r.right + args.pad) * args.dpr, y1: (r.bottom + args.pad) * args.dpr });
  }
  const data = w.gpuRenderer?.prepared?.payload?.glyphs;
  let softCells = 0;
  if (data instanceof Float32Array) for (let i = 0; i + 18 <= data.length; i += 18) if (data[i + 14] < 0) softCells++;
  // the probe's face: one that failed to load sends its texts to compat (text.ts fontReady), so the cell says so
  const style = texts[0] ? getComputedStyle(texts[0]) : null;
  let faceLoaded: boolean | null = null;
  try {
    faceLoaded = style ? document.fonts.check(`${style.fontSize} ${style.fontFamily}`, texts[0].textContent || "") : null;
  } catch {}
  return { ids, boxes, native, softCells, face: style?.fontFamily ?? null, faceLoaded };
}

// Per #labels text (svgLabels' ids): what the app may change on a zoom (shown, font size, position, transform, text).
// A text whose signature differs between two zooms is stale in a carried frame by design: the settle re-prepares it.
function textSignatures(): Record<string, string> {
  const out: Record<string, string> = {};
  [...document.querySelectorAll<SVGTextElement>("#labels text, #labelsHarnessShadow text")].forEach((text, index) => {
    const group = text.closest("#labels g[data-size]") as SVGGElement | null;
    const id = text.id || `${group?.id ?? "labels"}#${index}`;
    const style = getComputedStyle(text);
    const shown = text.checkVisibility({ visibilityProperty: true } as any);
    const attrs = ["x", "y", "dx", "dy", "transform"].map(a => text.getAttribute(a) ?? "").join(",");
    const chain: string[] = [];
    for (let e: Element | null = text.parentElement; e && e.id !== "viewbox"; e = e.parentElement) chain.push(e.getAttribute("transform") ?? "");
    out[id] = `${shown}|${style.fontSize}|${style.fontFamily}|${attrs}|${chain.join(";")}|${text.textContent}`;
  });
  return out;
}

// The image outside `boxes` (device px) replaced by the blank capture: the golden then reads only those regions.
function maskTo(img: ReturnType<typeof decode>, blank: ReturnType<typeof decode>, boxes: Box[]): ReturnType<typeof decode> {
  const inside = new Uint8Array(img.width * img.height);
  for (const box of boxes) {
    const c = clipBox(box, img.width, img.height);
    if (!c) continue;
    for (let y = c.y0; y < c.y1; y++) inside.fill(1, y * img.width + c.x0, y * img.width + c.x1);
  }
  const data = new Uint8Array(img.data);
  for (let i = 0; i < inside.length; i++) if (!inside[i]) for (let ch = 0; ch < 4; ch++) data[i * 4 + ch] = blank.data[i * 4 + ch];
  return { ...img, data };
}

const reprepare = (page: Page) => page.evaluate(() => (globalThis as any).gpuRenderer?.invalidate?.());

function judgeGolden(m: CellMetrics): { gates: Json; failures: string[] } {
  const cover = coverageOf(m);
  const gates = { ssim: m.ssim >= D1.ssimMin, over16: m.over16Fraction <= D1.over16Max, over44: m.over44Fraction <= D1.over44Max, coverageInk: cover.ink, coverageOver16: cover.over16 };
  const failures: string[] = [];
  if (!gates.ssim) failures.push(`ssim ${m.ssim.toFixed(4)} < ${D1.ssimMin}`);
  if (!gates.over16) failures.push(`over16 ${(m.over16Fraction * 100).toFixed(3)}%`);
  if (!gates.over44) failures.push(`over44 ${(m.over44Fraction * 100).toFixed(3)}%`);
  if (!gates.coverageInk) failures.push(`coverage: ink ${m.inkGpu} GPU vs ${m.inkSvg} SVG px (ratio ${m.inkRatio.toFixed(3)})`);
  if (!gates.coverageOver16) failures.push(`coverage: over16 is ${(m.over16OfInk * 100).toFixed(2)}% of the layer's ink`);
  if (m.inkSvg < 4) failures.push(`empty in SVG arm (ink ${m.inkSvg} px)`);
  return { gates, failures };
}

async function stepZoom(page: Page, dir: string): Promise<Json> {
  const result: Json = { shadows: [] as Json[], carry: [] as Json[], fresh: [] as Json[] };
  const [gw, gh] = (await page.evaluate(() => [(globalThis as any).graphWidth, (globalThis as any).graphHeight])) as [number, number];
  try {
    // rescaleLabels off for both parts: the label DOM is then the same at every zoom, so a frame carried between two
    // zooms differs from the SVG only by what the renderer does per zoom
    const rescale = await page.evaluate(() => {
      const box = (globalThis as any).rescaleLabels as HTMLInputElement | undefined;
      const was = !!box?.checked;
      if (box) box.checked = false;
      return was;
    });
    result.rescaleLabelsWas = rescale;
    // prepared at kPrepared, shown at kViewed with the renderer blind to mutations (freezeGpu, as a gesture does until
    // it settles); kPrepared === kViewed is a fresh prepare
    const carriedView = async (cell: Json, kPrepared: number, kViewed: number, at: [number, number]) => {
      await zoomTo(page, centerOn(kPrepared, at[0], at[1]));
      await settleApp(page);
      await reprepare(page);
      let status = await waitGpu(page);
      const before = await page.evaluate(frameState);
      const signed = await page.evaluate(textSignatures);
      if (kPrepared !== kViewed) {
        await page.evaluate(freezeGpu, true);
        cell.camera = await zoomTo(page, centerOn(kViewed, at[0], at[1]));
        await settleApp(page);
        status = await waitGpu(page);
      } else cell.camera = await page.evaluate(() => (0, eval)("(() => { const t = d3.zoomTransform(document.querySelector('#map')); return { k: t.k, x: t.x, y: t.y }; })()"));
      const after = await page.evaluate(frameState);
      cell.frames = { before, after };
      if (status.active !== "gpu" || status.timedOut) cell.failures.push(`GPU not active/settled: ${JSON.stringify(status)}`);
      if (kPrepared !== kViewed) {
        cell.carried = before.frame !== null && before.frame === after.frame;
        if (!cell.carried) cell.failures.push(`the renderer re-prepared between the zooms (frame ${before.frame} -> ${after.frame}): the pair does not test a carried frame`);
      }
      // the texts the app left alone between the zooms (shown at both, same size, place and text)
      const now = await page.evaluate(textSignatures);
      const stable = new Set(Object.keys(now).filter(id => now[id] === signed[id] && now[id].startsWith("true|")));
      cell.stableTexts = stable.size;
      cell.changedTexts = Object.keys(now).filter(id => now[id] !== signed[id]).length;
      return stable;
    };
    const unfreeze = () => page.evaluate(() => {
      const r = (globalThis as any).gpuRenderer;
      return r && Object.hasOwn(r, "schedulePrepare");
    }).then(frozen => (frozen ? page.evaluate(freezeGpu, false) : false));

    // ---- shadows
    // The map's own shadowed labels are compat runs or restyled by every zoom, so the harness places its own: a group
    // of straight texts in #labels (no data-size, so the zoom styling leaves it alone) at the camera centre, in the
    // map's label face, with the variant's text-shadow; judged on their padded boxes only.
    const centre: [number, number] = [gw / 2, gh / 2];
    result.shadowCentre = centre;
    for (const [kPrepared, kViewed] of ZOOM_PARTS.includes("shadows") ? ZOOM_SHADOW_PAIRS : []) {
      const blanks = await captureBlanks(page, centerOn(kViewed, centre[0], centre[1]));
      for (const variant of ZOOM_SHADOWS) {
        const cell: Json = { kPrepared, kViewed, variant: variant.id, control: kPrepared === kViewed, failures: [] as string[] };
        result.shadows.push(cell);
        try {
          if (scaleBucket(kPrepared * dpr) !== scaleBucket(kViewed * dpr)) throw Error(`ZOOM_SHADOW_PAIRS ${kPrepared}/${kViewed} crosses a bucket at dpr ${dpr}`);
          await isolateLabels(page, null);
          cell.probe = await page.evaluate(shadowProbe, { at: centre, shadow: variant.value });
          const stable = await carriedView(cell, kPrepared, kViewed, centre);
          const probe = await page.evaluate(shadowProbeState, { dpr, pad: ZOOM_SHADOW_PAD });
          cell.texts = { shown: probe.boxes.length, stable: probe.ids.filter((id: string) => stable.has(id)).length, native: probe.native, softCells: probe.softCells, face: probe.face, faceLoaded: probe.faceLoaded };
          if (cell.texts.stable !== probe.ids.length) cell.failures.push(`the zoom restyled ${probe.ids.length - cell.texts.stable} probe texts: the pair does not test a carried frame`);
          if (!probe.native || !probe.softCells) cell.failures.push(`the GPU drew no probe text natively with a shadow (native ${probe.native}, soft cells ${probe.softCells}${probe.faceLoaded === false ? `; the probe face ${probe.face} is not loaded` : ""}): nothing to judge`);
          const shots = await captureArms(page);
          const svg = maskTo(decode(shots.svg), blanks.svg, probe.boxes);
          const gpu = maskTo(decode(shots.gpu), blanks.gpu, probe.boxes);
          const m = measureCell(svg, gpu, blanks.svg, blanks.gpu);
          cell.metrics = roundMetrics(m);
          const judged = judgeGolden(m);
          cell.gates = judged.gates;
          cell.failures.push(...judged.failures);
          cell.pass = cell.failures.length === 0;
          if (keep === "all" || !cell.pass) cell.images = saveShots(join(dir, "zoom", "shadows"), `${variant.id}-k${fmtK(kPrepared)}-to-k${fmtK(kViewed)}`, shots, svg, gpu);
        } catch (error) {
          cell.failures.push(`harness: ${String(error).slice(0, 400)}`);
          cell.pass = false;
        } finally {
          await unfreeze();
          await page.evaluate(shadowProbe, null);
        }
        log(`${cell.pass ? "PASS" : "FAIL"} zoom shadows ${variant.id} k ${kPrepared} -> ${kViewed}${cell.control ? " (fresh)" : ""}: ${cell.metrics ? `ssim ${cell.metrics.ssim} over16 ${cell.metrics.over16Fraction} over44 ${cell.metrics.over44Fraction} ink ${cell.metrics.inkRatio} over16OfInk ${cell.metrics.over16OfInk}` : ""} texts ${JSON.stringify(cell.texts ?? null)}${cell.pass ? "" : ` :: ${cell.failures.join("; ")}`}`);
        write();
      }
    }
    // ---- carry
    // Within a bucket the renderer re-prepares only on a DOM change; the app's zoom styling always makes one (label
    // font sizes when rescaleLabels is on, the states halo width), so a carried frame is what a gesture shows until it
    // settles. The step reproduces that: rescaleLabels off (the label DOM is the same at both zooms) and the renderer
    // blind to mutations between the zooms (freezeGpu, as the freeze self-test break does); then a fresh prepare at
    // the viewed zoom is the control.
    await page.evaluate(setVariant, "native");
    const info = await page.evaluate(labelGroups);
    const states = (info.groups as Json[]).find(g => g.id === "states" && g.anchors.length);
    const judgeGlyphs = async (svgInk: Uint8Array, gpuInk: Uint8Array, width: number, height: number, only: Set<string> | null) => {
      const state = await page.evaluate(svgLabels, { group: null, chars: true, dpr, ids: null });
      let changed = 0;
      const shifts: number[] = [];
      const normals: number[] = [];
      const worst: Json[] = [];
      let missing = 0;
      let nativeChars = 0;
      // the GPU's own glyph instances only: native curved labels (straight text in #labels is a compat run)
      for (const label of state.labels as Json[]) {
        if (!label.inside || !label.native || !label.chars?.length) continue;
        // a label the zoom restyled (shown, size, place: textSignatures) is stale in the carried frame by design: the
        // settle after a gesture re-prepares it
        if (only && !only.has(label.id)) {
          changed++;
          continue;
        }
        for (const c of label.chars as Json[]) {
          if (c.empty) continue;
          const box = clipBox(pad(c.extent, 1), width, height);
          if (!box) continue;
          const reg = register(svgInk, gpuInk, width, height, box, 3);
          const kind = classifyRegistration(reg);
          if (kind === "faint" || !reg) continue;
          nativeChars++;
          if (kind === "missing") {
            missing++;
            if (worst.length < 20) worst.push({ kind: "missing", label: label.id, group: label.group, char: c.char, curved: label.curved, fontPx: label.fontPx, svgInk: reg.svgInk, gpuInkAtShift: reg.gpuInkAtShift });
            continue;
          }
          shifts.push(reg.shift);
          normals.push(Math.abs(alongNormal(reg.dx, reg.dy, c.rotation).normal));
          if (reg.shift > TOL.registerPx && worst.length < 20) worst.push({ label: label.id, char: c.char, curved: label.curved, fontPx: label.fontPx, dx: Number(reg.dx.toFixed(2)), dy: Number(reg.dy.toFixed(2)) });
        }
      }
      const counted = shifts.length + missing;
      const within = shifts.filter(v => v <= TOL.registerPx).length;
      return { pixel: { ...stats(shifts), normal: stats(normals), missing, nativeChars, withinTol: counted ? Number((within / counted).toFixed(4)) : null, labelsChangedByZoom: changed }, counted, within, worst };
    };
    for (const [kPrepared, kViewed] of ZOOM_PARTS.includes("carry") ? ZOOM_CARRY : []) {
      const cell: Json = { kPrepared, kViewed, bucket: [scaleBucket(kPrepared * dpr), scaleBucket(kViewed * dpr)], failures: [] as string[] };
      result.carry.push(cell);
      try {
        if (cell.bucket[0] !== cell.bucket[1]) throw Error(`ZOOM_CARRY pair ${kPrepared}/${kViewed} crosses a bucket at dpr ${dpr}`);
        const at: [number, number] = states ? states.anchors[0].at : [gw / 2, gh / 2];
        const blanks = await captureBlanks(page, centerOn(kViewed, at[0], at[1]));
        await isolateLabels(page, null);
        const stable = await carriedView(cell, kPrepared, kViewed, at);
        const shots = await captureArms(page);
        const svg = decode(shots.svg);
        const gpu = decode(shots.gpu);
        const carried = await judgeGlyphs(inkOf(svg, blanks.svg), inkOf(gpu, blanks.gpu), svg.width, svg.height, stable);
        cell.pixel = carried.pixel;
        cell.worst = carried.worst;
        const m = measureCell(svg, gpu, blanks.svg, blanks.gpu);
        cell.metrics = roundMetrics(m);
        // the control: the same view prepared fresh
        await unfreeze();
        await settleApp(page);
        await reprepare(page);
        await waitGpu(page);
        const freshShots = await captureArms(page);
        const freshSvg = decode(freshShots.svg);
        const freshGpu = decode(freshShots.gpu);
        const fresh = await judgeGlyphs(inkOf(freshSvg, blanks.svg), inkOf(freshGpu, blanks.gpu), freshSvg.width, freshSvg.height, stable);
        const fm = measureCell(freshSvg, freshGpu, blanks.svg, blanks.gpu);
        cell.fresh = { pixel: fresh.pixel, metrics: roundMetrics(fm), d11: judgeGolden(fm).failures };
        if (!carried.pixel.nativeChars) cell.failures.push("no native glyph on screen: nothing carried to judge");
        if (carried.counted && carried.within / carried.counted < TOL.registerShare)
          cell.failures.push(`pixel: ${carried.counted - carried.within}/${carried.counted} carried glyphs shifted > ${TOL.registerPx} device px or missing (${carried.pixel.missing} missing; p95 ${carried.pixel.p95}, normal p95 ${carried.pixel.normal.p95}, max ${carried.pixel.max}; fresh max ${fresh.pixel.max})`);
        // INFO: the labels golden of the carried frame against the fresh one (CARRY_MARGIN) and the fresh frame's own
        // D11 verdict. Not gated: compat runs (burg labels here) carry a raster of the prepared zoom, which the settle
        // after a gesture refines; that is the compat lane's carry, not the glyphs'.
        const worse: string[] = [];
        if (m.ssim < fm.ssim - CARRY_MARGIN.ssim) worse.push(`ssim ${m.ssim.toFixed(4)} vs fresh ${fm.ssim.toFixed(4)}`);
        if (m.over16OfInk > fm.over16OfInk + CARRY_MARGIN.over16OfInk) worse.push(`over16 of ink ${(m.over16OfInk * 100).toFixed(2)}% vs fresh ${(fm.over16OfInk * 100).toFixed(2)}%`);
        if (m.inkRatio < fm.inkRatio - CARRY_MARGIN.inkRatio) worse.push(`ink ratio ${m.inkRatio.toFixed(3)} vs fresh ${fm.inkRatio.toFixed(3)}`);
        cell.goldenVsFresh = worse.length ? worse : "within CARRY_MARGIN";
        cell.pass = cell.failures.length === 0;
        if (keep === "all" || !cell.pass) {
          cell.images = saveShots(join(dir, "zoom", "carry"), `k${fmtK(kPrepared)}-to-k${fmtK(kViewed)}`, shots, svg, gpu);
          cell.freshImages = saveShots(join(dir, "zoom", "carry"), `k${fmtK(kPrepared)}-to-k${fmtK(kViewed)}-fresh`, freshShots, freshSvg, freshGpu);
        }
      } catch (error) {
        cell.failures.push(`harness: ${String(error).slice(0, 400)}`);
        cell.pass = false;
      } finally {
        await unfreeze();
      }
      log(`${cell.pass ? "PASS" : "FAIL"} zoom carry k ${kPrepared} -> ${kViewed}: pixel ${JSON.stringify(cell.pixel ?? null)} fresh max ${cell.fresh?.pixel?.max}${cell.metrics ? ` ssim ${cell.metrics.ssim} ink ${cell.metrics.inkRatio} over16OfInk ${cell.metrics.over16OfInk} (fresh ${cell.fresh?.metrics?.over16OfInk}, fresh D11 ${cell.fresh?.d11?.length ? cell.fresh.d11.join("/") : "pass"})` : ""}${cell.pass ? "" : ` :: ${cell.failures.join("; ")}`}`);
      write();
    }
    // ---- fresh
    for (const k of ZOOM_PARTS.includes("fresh") ? ZOOM_FRESH : []) {
      const cell: Json = { k, bucket: scaleBucket(k * dpr), failures: [] as string[] };
      result.fresh.push(cell);
      try {
        const at: [number, number] = states ? states.anchors[0].at : [gw / 2, gh / 2];
        const blanks = await captureBlanks(page, centerOn(k, at[0], at[1]));
        await isolateLabels(page, null);
        cell.camera = await zoomTo(page, centerOn(k, at[0], at[1]));
        await settleApp(page);
        await reprepare(page);
        const status = await waitGpu(page);
        if (status.active !== "gpu" || status.timedOut) cell.failures.push(`GPU not active/settled: ${JSON.stringify(status)}`);
        // which glyph set the frame draws: the bucket's, or the settle's re-cut at k * dpr (glyph-fine.ts)
        cell.fine = await page.evaluate(() => {
          const r = (globalThis as any).gpuRenderer;
          const p = r?.prepared;
          const scale = (r?.view?.k ?? 0) * (r?.viewport?.dpr ?? 0);
          return { scale: Number(scale.toFixed(4)), bucket: p?.bucket ?? null, fineScale: p?.frame?.fineScale ?? null, labels: p?.glyphLabels?.length ?? null, drawn: !!p?.frame?.fineGlyphs && Math.abs((p.frame.fineScale ?? 0) / scale - 1) < 1e-4 };
        });
        const shots = await captureArms(page);
        const svg = decode(shots.svg);
        const gpu = decode(shots.gpu);
        const glyphs = await judgeGlyphs(inkOf(svg, blanks.svg), inkOf(gpu, blanks.gpu), svg.width, svg.height, null);
        cell.pixel = glyphs.pixel; // info
        const m = measureCell(svg, gpu, blanks.svg, blanks.gpu);
        cell.metrics = roundMetrics(m);
        const judged = judgeGolden(m);
        cell.gates = judged.gates;
        cell.failures.push(...judged.failures);
        cell.pass = cell.failures.length === 0;
        if (keep === "all" || !cell.pass) cell.images = saveShots(join(dir, "zoom", "fresh"), `k${fmtK(k)}`, shots, svg, gpu);
      } catch (error) {
        cell.failures.push(`harness: ${String(error).slice(0, 400)}`);
        cell.pass = false;
      }
      log(`${cell.pass ? "PASS" : "FAIL"} zoom fresh k ${k}: fine ${JSON.stringify(cell.fine ?? null)}${cell.metrics ? ` ssim ${cell.metrics.ssim} ink ${cell.metrics.inkRatio} over16OfInk ${cell.metrics.over16OfInk} over16 ${cell.metrics.over16Fraction}` : ""} pixel within ${cell.pixel?.withinTol ?? "n/a"}${cell.pass ? "" : ` :: ${cell.failures.join("; ")}`}`);
      write();
    }
  } finally {
    await page.evaluate(setVariant, "map");
    if (result.rescaleLabelsWas !== undefined)
      await page.evaluate(was => {
        const box = (globalThis as any).rescaleLabels as HTMLInputElement | undefined;
        if (box) box.checked = was;
      }, result.rescaleLabelsWas);
  }
  const failing = [...result.shadows, ...result.carry, ...result.fresh].filter((c: Json) => !c.pass);
  result.summary = {
    shadows: result.shadows.length,
    shadowFail: result.shadows.filter((c: Json) => !c.pass).map((c: Json) => `${c.variant}@k${c.kPrepared}->k${c.kViewed}`),
    carry: result.carry.length,
    carryFail: result.carry.filter((c: Json) => !c.pass).map((c: Json) => `k${c.kPrepared}->k${c.kViewed}`),
    // INFO: a fresh prepare's labels layer at these cameras against the absolute D11 golden (not gated here)
    freshD11: result.carry.map((c: Json) => `k${c.kViewed}: ${c.fresh?.d11?.length ? c.fresh.d11.join("/") : c.fresh ? "pass" : "n/a"}`),
    // GATED (W4a GLYPHZ): fresh frames between powers of two against the labels golden
    fresh: result.fresh.length,
    freshFail: result.fresh.filter((c: Json) => !c.pass).map((c: Json) => `k${c.k}`),
    freshOver16OfInk: result.fresh.map((c: Json) => `k${c.k}: ${c.metrics?.over16OfInk ?? "n/a"}${c.fine?.drawn ? " fine" : ""}`)
  };
  result.failure = failing.length ? `${failing.length} zoom cells failed: ${failing.slice(0, 6).map((c: Json) => `${c.variant ? `shadow ${c.variant}@k${c.kPrepared}->k${c.kViewed}` : c.kViewed !== undefined ? `carry k${c.kPrepared}->k${c.kViewed}` : `fresh k${c.k}`} (${c.failures[0]})`).join("; ")}` : null;
  return result;
}

// ------------------------------------------------------------------ run

try {
  mkdirSync(outDir, { recursive: true });
  for (const world of worlds) {
    const text = readFileSync(world.path);
    const sha = createHash("sha256").update(text).digest("hex");
    const parity = sha === paritySha ? resolveFixture("parity") : null;
    const w: Json = { path: world.path, sha256: sha, parity: !!parity, steps: {} as Json };
    report.worlds[world.name] = w;
    log(`${world.name}: loading ${world.path}`);
    const { context, page, errors, warnings } = await openContext(world, parity);
    w.errors = errors;
    w.warnings = warnings;
    try {
      const dir = join(outDir, world.name);
      const blanks = await captureBlanks(page, centerOn(1, ...((await page.evaluate(() => [(globalThis as any).graphWidth / 2, (globalThis as any).graphHeight / 2])) as [number, number])));
      for (const step of steps) {
        const started = Date.now();
        log(`${world.name}: ${step}`);
        try {
          if (step === "thresholds") w.steps.thresholds = await stepThresholds(page, blanks, dir);
          else if (step === "glyphs") w.steps.glyphs = await stepGlyphs(page, blanks, dir);
          else if (step === "advance") w.steps.advance = await stepAdvance(page);
          else if (step === "fonts") w.steps.fonts = await stepFonts(page, blanks, dir, world.name);
          else if (step === "zoom") w.steps.zoom = await stepZoom(page, dir);
        } catch (error) {
          w.steps[step] = { ...(w.steps[step] ?? {}), failure: `harness: ${error instanceof Error ? error.stack : String(error)}` };
        }
        w.steps[step].seconds = Number(((Date.now() - started) / 1000).toFixed(1));
        log(`${world.name}: ${step} ${w.steps[step].failure ? `FAIL ${w.steps[step].failure}` : "PASS"}`);
        write();
      }
    } finally {
      await context.close();
    }
    for (const e of errors) report.errors.push(`${world.name}: ${e}`);
    for (const m of warnings) if (/GL_INVALID_|Feedback loop/i.test(m)) report.errors.push(`${world.name}: WebGL validation warning: ${m.slice(0, 200)}`);
  }
} catch (error) {
  report.errors.push(`harness: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  const reasons: string[] = [];
  for (const [name, w] of Object.entries(report.worlds)) {
    report.summary[name] = Object.fromEntries(Object.entries(w.steps as Json).map(([step, s]) => [step, { pass: !s.failure, ...(s.summary ?? {}), ...(s.variants ? Object.fromEntries(Object.entries(s.variants as Json).map(([v, x]) => [v, x.summary])) : {}) }]));
    for (const [step, s] of Object.entries(w.steps as Json)) if (s.failure) reasons.push(`${name}/${step}: ${String(s.failure).slice(0, 400)}`);
  }
  if (report.errors.length) reasons.unshift(`${report.errors.length} page/harness error(s): ${report.errors[0].split("\n")[0].slice(0, 200)}`);
  if (!Object.keys(report.worlds).length) reasons.push("no world ran");
  report.failure = reasons.length ? reasons.join(" | ") : null;
  write();
  log(report.failure ? `FAIL ${report.failure}` : "PASS");
  await browser.close();
  await new Promise<void>(done => server.close(() => done()));
}
