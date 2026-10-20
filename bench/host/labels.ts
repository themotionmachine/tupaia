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
//               - analytic (native, curved): the GPU glyph instances are read back (renderer payload + atlas keys,
//                 labels-core.ts glyphBaseline) and each SVG character's baseline midpoint ((start+end)/2, dy
//                 included) is paired with the nearest GPU glyph of the same character; the distance in device px
//                 must be ≤ TOL.glyphPx for every character, and no native character may go unmatched;
//               - pixel (every label, native and compat, curved and straight): the shift that best aligns the GPU
//                 arm's ink with the SVG arm's inside each character's extent box (labels-core.ts register);
//                 TOL.registerShare of the registered characters must be within TOL.registerPx.
//               Variant `map` is the fixture as saved. Every built-in preset gives state labels a text-shadow, and
//               multi-line state labels end their first line with a space, so text.ts sends both to the compat lane;
//               variant `native` removes the text-shadow and trims edge spaces in curved labels' tspans (both arms
//               see the same DOM) so that the curved labels go native and the analytic check has a sample.
//   advance     Character start positions from measureText, the way text.ts lays a label out (prefix widths at the
//               power-of-two raster bucket, kerning off under text-rendering:optimizeSpeed), against SVG
//               getStartPositionOfChar(i) (where the SVG puts character i, at the same CTM scale), per pinned font:
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
//   LABELS_KEEP          all | fail: PNGs for every capture or failing ones only  default fail
//   LABELS_BREAK         none | freeze | measure (self-test only):
//                        freeze  stops the GPU from seeing DOM changes for the second probe of each threshold and for
//                                each font switch (a missed invalidation: the frame keeps the old visibility or face);
//                        measure scales Canvas2D measureText widths by 1.04 from page start (GPU advances off).
// Output in GATE_OUT_DIR: labels.json (`failure` is null on a pass), PNGs under <world>/.
// Exit 0 when a report was written (verdicts are in it), 1 on a harness error.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, relative, resolve } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright";
import { type CellMetrics, D1, heatmap, measureCell } from "../golden-metrics.ts";
import { decodePng, encodePng } from "../png.ts";
import { isolateLayer } from "./golden-isolation.ts";
import { resolveFixture } from "./fixtures/index.ts";
import {
  type Box,
  clipBox,
  type GroupRule,
  inkCount,
  inkOf,
  labelHidden,
  matchGlyphs,
  probes,
  register,
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
const STEPS = ["thresholds", "glyphs", "advance", "fonts"] as const;
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
if (!["none", "freeze", "measure"].includes(breakMode)) throw Error("LABELS_BREAK must be none|freeze|measure");
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

async function captureArms(page: Page): Promise<{ gpu: Buffer; svg: Buffer }> {
  const gpu = await page.screenshot({ animations: "disabled" });
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
      const content = (text.textContent || "").replace(/\s+/g, " ").trim();
      row.content = content;
      row.numberOfChars = n;
      const style = getComputedStyle(text.querySelector("tspan") ?? text);
      row.fontPx = Number.parseFloat(style.fontSize) || 0;
      // text.ts draws a dominant-baseline:central label shifted by half the font box (centralBaselineShift), while
      // Chromium's start/end-position API stays on the nominal path; the analytic check compares nominal positions
      row.baseline = style.dominantBaseline;
      if (style.dominantBaseline === "central") {
        const context = ((globalThis as any).__labelsMeasure ??= document.createElement("canvas").getContext("2d")) as CanvasRenderingContext2D;
        context.font = `${style.fontStyle} ${style.fontWeight} ${row.fontPx}px ${style.fontFamily}`;
        const metrics = context.measureText(text.textContent || "");
        row.centralShift = (metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2;
      }
      const chars: Json[] = [];
      if (m && n === content.length) {
        const map = (x: number, y: number) => [(m.a * x + m.c * y + m.e) * args.dpr, (m.b * x + m.d * y + m.f) * args.dpr];
        for (let i = 0; i < n; i++) {
          const char = content[i];
          if (!char.trim()) continue;
          try {
            const s = text.getStartPositionOfChar(i);
            const e = text.getEndPositionOfChar(i);
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
            // a character the layout does not place (past the end of its path)
          }
        }
      } else row.charsSkipped = m ? `getNumberOfChars ${n} != collapsed content ${content.length}` : "no CTM";
      row.chars = chars;
    }
    out.push(row);
  });
  return { groupHidden, labels: out, camera: (0, eval)("(() => { const t = d3.zoomTransform(document.querySelector('#map')); return { k: t.k, x: t.x, y: t.y }; })()") };
}

// The GPU's own glyphs, read back from the prepared frame: each fill-pass instance's character (atlas key) and its
// dy-shifted baseline midpoint (labels-core glyphBaseline, inlined: this is serialised), in device px through the
// renderer's camera. A shape change in the renderer internals is a harness error, never a silent empty list.
function gpuGlyphs(dpr: number): Json {
  const r = (globalThis as any).gpuRenderer;
  const payload = r?.prepared?.payload;
  const atlas = r?.atlas;
  if (!payload || !(payload.glyphs instanceof Float32Array)) return { error: "gpuRenderer.prepared.payload.glyphs is not readable" };
  if (!(atlas?.glyphs instanceof Map)) return { error: "gpuRenderer.atlas.glyphs is not readable" };
  if (payload.atlasGeneration !== atlas.generation) return { error: `atlas generation ${atlas.generation} != frame ${payload.atlasGeneration}` };
  const view = r.view;
  if (!view || !Number.isFinite(view.k)) return { error: "gpuRenderer.view is not readable" };
  const byUv = new Map<string, [string, any]>();
  for (const [key, glyph] of atlas.glyphs) byUv.set(`${glyph.u0},${glyph.v0}`, [key, glyph]);
  const FLOATS = 15;
  const data: Float32Array = payload.glyphs;
  const out: Json[] = [];
  let unknown = 0;
  for (let i = 0; i + FLOATS <= data.length; i += FLOATS) {
    const hit = byUv.get(`${data[i + 7]},${data[i + 8]}`);
    if (!hit) {
      unknown++;
      continue;
    }
    const [key, glyph] = hit;
    const parts = key.split("|");
    const halo = Number(parts[1]);
    if (halo !== 0) continue;
    const char = parts.slice(2).join("|");
    const h = data[i + 6];
    if (!(h > 0)) continue;
    const scale = glyph.height / h;
    const shift = data[i + 4] - glyph.top / scale;
    const angle = data[i + 2];
    const wx = data[i] - Math.sin(angle) * shift;
    const wy = data[i + 1] + Math.cos(angle) * shift;
    out.push({ char, font: parts[0], x: (wx * view.k + view.x) * dpr, y: (wy * view.k + view.y) * dpr, angle: (angle * 180) / Math.PI });
  }
  return { glyphs: out, unknown, instances: data.length / FLOATS, view: { k: view.k, x: view.x, y: view.y } };
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
  const [kMin, kMax] = info.extent as [number, number];
  const result: Json = { hideLabels: info.hideLabels, extent: info.extent, cells: [] as Json[], groups: [] as Json[] };
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
  const result: Json = { variants: {} as Json };
  for (const variant of variants) {
    const changed = await page.evaluate(setVariant, variant);
    const v: Json = { changed, cameras: [] as Json[], labels: [] as Json[] };
    result.variants[variant] = v;
    let total = 0;
    const analytic: number[] = [];
    const angles: number[] = [];
    const shifts: number[] = [];
    const labelShifts: number[] = [];
    let unmatched = 0;
    let crops = 0;
    const shortfall: Json[] = [];
    const worst: Json[] = [];
    const sampledIds = new Set<string>();
    for (const [kIndex, k] of glyphKs.entries()) {
      // what an earlier zoom could not fill carries over to the later ones
      const perK = Math.ceil((sampleTarget - total) / (glyphKs.length - kIndex));
      const candidates = (info.groups as Json[])
        .filter(g => g.display !== "none" && !labelHidden(rules.get(g.id)!, k))
        .flatMap(g => (g.anchors as Json[]).map(a => ({ id: a.id as string, at: a.at as [number, number] })))
        .sort((a, b) => a.at[1] - b.at[1] || a.at[0] - b.at[0]);
      const done = new Set<string>();
      const sampledAtK = new Set<string>();
      let sampled = 0;
      let exhausted = false;
      for (let cameraIndex = 0; cameraIndex < cameraBudget && sampled < perK; cameraIndex++) {
        const next = candidates.find(c => !done.has(c.id));
        if (!next) {
          exhausted = true;
          break;
        }
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
          for (const label of state.labels as Json[]) {
            if (label.inside) done.add(label.id);
            if (!label.inside || !label.chars?.length || sampled >= perK || sampledAtK.has(label.id)) continue;
            sampledAtK.add(label.id);
            sampled++;
            total++;
            cam.sampled++;
            sampledIds.add(label.id);
            const row: Json = { id: label.id, k, camera: cameraIndex, group: label.group, curved: label.curved, native: label.native, chars: label.chars.length, content: label.content, box: Object.fromEntries(Object.entries(label.box as Box).map(([key, n]) => [key, Math.round(n as number)])) };
            if (label.charsSkipped) row.charsSkipped = label.charsSkipped;
            // whole-label registration (diagnostic) and per character
            const whole = register(svgInk, gpuInk, width, height, clipBox(pad(label.box, 2), width, height) ?? label.box, 4);
            if (whole && whole.svgInk >= TOL.registerMinInk) {
              row.labelShift = Number(whole.shift.toFixed(3));
              labelShifts.push(whole.shift);
            }
            const charShifts: number[] = [];
            for (const c of label.chars as Json[]) {
              if (c.empty) continue;
              const box = clipBox(pad(c.extent, 1), width, height);
              if (!box) continue;
              const reg = register(svgInk, gpuInk, width, height, box, 3);
              if (!reg || reg.svgInk < TOL.registerMinInk) continue;
              charShifts.push(reg.shift);
              shifts.push(reg.shift);
              if (reg.shift > TOL.registerPx && worst.length < 400) worst.push({ kind: "pixel", label: label.id, k, char: c.char, i: c.i, dx: Number(reg.dx.toFixed(2)), dy: Number(reg.dy.toFixed(2)), edge: reg.edge, native: label.native });
            }
            row.pixel = stats(charShifts);
            if (label.native && Array.isArray(gpuSide.glyphs)) {
              const near = (gpuSide.glyphs as Json[]).filter(g => g.x >= label.box.x0 - 40 && g.x <= label.box.x1 + 40 && g.y >= label.box.y0 - 40 && g.y <= label.box.y1 + 40);
              const svgPoints = (label.chars as Json[]).filter(c => !c.empty);
              const radius = Math.max(4, 0.6 * label.fontPx * k * dpr);
              // back to the nominal baseline: undo text.ts's central-baseline shift along each glyph's own normal
              const shift = (label.centralShift ?? 0) * k * dpr;
              const nominal = (near as Json[]).map(g => {
                const a = (g.angle * Math.PI) / 180;
                return { ...g, x: g.x + Math.sin(a) * shift, y: g.y - Math.cos(a) * shift };
              });
              const pairs = matchGlyphs(svgPoints, nominal as any, radius);
              const errors = pairs.map(p => p.distance);
              analytic.push(...errors);
              for (const p of pairs) {
                const delta = Math.abs((((svgPoints[p.i].rotation - nominal[p.j].angle) % 360) + 540) % 360 - 180);
                angles.push(delta);
                if (p.distance > TOL.glyphPx && worst.length < 400) worst.push({ kind: "analytic", label: label.id, k, char: svgPoints[p.i].char, i: svgPoints[p.i].i, error: Number(p.distance.toFixed(3)), svg: [svgPoints[p.i].x, svgPoints[p.i].y].map(n => Number(n.toFixed(2))), gpu: [nominal[p.j].x, nominal[p.j].y].map((n: number) => Number(n.toFixed(2))), baseline: label.baseline });
              }
              const missed = svgPoints.length - pairs.length;
              unmatched += missed;
              row.analytic = { ...stats(errors), unmatched: missed, baseline: label.baseline };
              if (missed) worst.push({ kind: "unmatched", label: label.id, k, count: missed, of: svgPoints.length });
            }
            if ((row.analytic && (row.analytic.max > TOL.glyphPx || row.analytic.unmatched)) || (row.pixel.n && row.pixel.max > TOL.registerPx)) {
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
      if (sampled < perK) shortfall.push({ k, sampled, wanted: perK, exhausted });
    }
    const pixelWithin = shifts.filter(s => s <= TOL.registerPx).length;
    const nativeLabels = (v.labels as Json[]).filter(l => l.native).length;
    v.summary = {
      labels: v.labels.length,
      distinctLabels: sampledIds.size,
      nativeLabels,
      compatLabels: v.labels.length - nativeLabels,
      straight: (v.labels as Json[]).filter(l => !l.curved).length,
      analytic: { ...stats(analytic), unmatched, angleDeg: stats(angles) },
      pixel: { ...stats(shifts), withinTol: shifts.length ? Number((pixelWithin / shifts.length).toFixed(4)) : null },
      labelShift: stats(labelShifts)
    };
    v.worst = worst.sort((a, b) => (b.error ?? b.count ?? Math.hypot(b.dx ?? 0, b.dy ?? 0)) - (a.error ?? a.count ?? Math.hypot(a.dx ?? 0, a.dy ?? 0))).slice(0, 40);
    const failures: string[] = [];
    // a world with fewer (label, zoom) pairs on screen than the target is a fixture limit (noted); running out of
    // camera budget with labels left is a harness limit (fails)
    v.shortfall = shortfall;
    if (v.labels.length < sampleTarget) {
      const budget = shortfall.filter(s => !s.exhausted);
      if (budget.length) failures.push(`sample ${v.labels.length} < ${sampleTarget} labels with candidates left at k ${budget.map(s => s.k).join(", ")} (camera budget)`);
      else v.note = `every on-screen label at k ${glyphKs.join("/")} sampled: ${v.labels.length} < ${sampleTarget} (${sampledIds.size} distinct labels)`;
    }
    if (analytic.length && v.summary.analytic.max > TOL.glyphPx) failures.push(`analytic: ${analytic.filter(e => e > TOL.glyphPx).length}/${analytic.length} native glyphs off by > ${TOL.glyphPx} device px (max ${v.summary.analytic.max})`);
    if (unmatched) failures.push(`analytic: ${unmatched} native characters have no GPU glyph of the same character within reach`);
    if (variant === "native" && !analytic.length) failures.push("analytic: no native curved glyph was sampled");
    if (shifts.length && pixelWithin / shifts.length < TOL.registerShare) failures.push(`pixel: ${shifts.length - pixelWithin}/${shifts.length} glyphs shifted > ${TOL.registerPx} device px (${((pixelWithin / shifts.length) * 100).toFixed(2)}% within, need ${TOL.registerShare * 100}%; p95 ${v.summary.pixel.p95}, max ${v.summary.pixel.max})`);
    if (!shifts.length) failures.push("pixel: no glyph had enough ink to register");
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
    async ({ dpr, limit, only }) => {
      const w = globalThis as any;
      const families: string[] = [...new Set<string>([...(w.fonts as { family: string }[]).map(f => f.family), ...[...document.querySelectorAll("#labels g")].map(g => g.getAttribute("font-family") || "").filter(Boolean)])];
      const chosen = only ? families.filter(f => only.includes(f)) : limit > 0 ? families.slice(0, limit) : families;
      const mapStrings = [...new Set([...document.querySelectorAll("#labels text")].map(t => (t.textContent || "").replace(/\s+/g, " ").trim()).filter(s => s.length >= 3))].slice(0, 10);
      const strings = ["Bothersian Empire", "Kingdom of Ardvale", "AVAWATo Ty. Wavy", "Hamlet Quaywick", "Ëlvenmoor Ærø", ...mapStrings];
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
          const row: any = { family, loadState, available, worst: null, maxCumPx: 0, maxAdvancePx: 0, cases: 0, byRendering: {} as Record<string, number>, worstBy: {} as Record<string, unknown>, byStrings: {} as Record<string, number>, grid: {} as Record<string, number> };
          text.setAttribute("font-family", family);
          for (const rendering of renderings) {
            text.setAttribute("text-rendering", rendering);
            for (const size of sizes) {
              text.setAttribute("font-size", String(size));
              for (const k of ks) {
                group.setAttribute("transform", `scale(${k})`);
                const bucket = bucketOf(k * dpr);
                const cs = getComputedStyle(text);
                context.font = `${cs.fontStyle} ${cs.fontWeight} ${size * bucket}px ${cs.fontFamily}`;
                context.fontKerning = rendering === "optimizeSpeed" ? "none" : "auto";
                for (const s of strings) {
                  text.textContent = s;
                  const n = text.getNumberOfChars();
                  if (n !== s.length) continue;
                  let previousSvg = 0;
                  let previousGpu = 0;
                  const origin = text.getStartPositionOfChar(0).x;
                  for (let i = 1; i <= n; i++) {
                    // where the SVG puts character i (the end of the last one for i = n), in user units
                    const svg = (i < n ? text.getStartPositionOfChar(i).x : text.getEndPositionOfChar(n - 1).x) - origin;
                    const gpu = context.measureText(s.slice(0, i)).width / bucket;
                    const cum = Math.abs(gpu - svg) * k * dpr;
                    const advance = Math.abs(gpu - previousGpu - (svg - previousSvg)) * k * dpr;
                    previousSvg = svg;
                    previousGpu = gpu;
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
                }
              }
            }
          }
          row.maxCumPx = Number(row.maxCumPx.toFixed(3));
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
    { dpr, limit: advanceFontLimit, only: advanceFamilies }
  );
  const rows = out.rows as Json[];
  const failing = rows.filter(r => r.available && r.maxCumPx > TOL.advancePx);
  const unavailable = rows.filter(r => !r.available);
  for (const r of rows) log(`${r.available && r.maxCumPx > TOL.advancePx ? "FAIL" : r.available ? "PASS" : "SKIP"} advance ${r.family}: max cumulative ${r.maxCumPx} px (${Object.entries(r.byRendering).map(([k, v]) => `${k} ${v}`).join(", ")}), max advance ${r.maxAdvancePx} px (${r.loadState}${r.available ? "" : ", not available on this host"})`);
  const byRendering = (key: string) => rows.filter(r => r.available && (r.byRendering[key] ?? 0) > TOL.advancePx).length;
  const byStrings = (key: string) => rows.filter(r => r.available && (r.byStrings[key] ?? 0) > TOL.advancePx).length;
  return {
    ...out,
    summary: { measured: rows.length, available: rows.length - unavailable.length, pass: rows.length - unavailable.length - failing.length, fail: failing.length, failAuto: byRendering("auto"), failOptimizeSpeed: byRendering("optimizeSpeed"), failMapStrings: byStrings("mapStrings"), failProbeStrings: byStrings("probeStrings"), unavailable: unavailable.map(r => `${r.family} (${r.loadState})`) },
    failure: failing.length
      ? `${failing.length}/${rows.length - unavailable.length} available fonts differ by > ${TOL.advancePx} device px (text-rendering auto: ${byRendering("auto")}, optimizeSpeed: ${byRendering("optimizeSpeed")}): ${failing.slice(0, 8).map(r => `${r.family} ${r.maxCumPx} px`).join(", ")}`
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

// Which labels of each group the GPU drew natively, and the labels layer's routing reasons.
function routing(): Json {
  const w = globalThis as any;
  const runs = w.gpuRenderer?.prepared?.runs;
  const compat = new Set<Element>();
  for (const run of Array.isArray(runs) ? runs : []) for (const e of run.elements ?? []) compat.add(e);
  const groups: Record<string, { native: number; compat: number }> = {};
  for (const text of document.querySelectorAll("#labels text")) {
    const group = (text.closest("#labels g[data-size]") as Element | null)?.id ?? "labels";
    if (!(text as any).checkVisibility({ visibilityProperty: true })) continue;
    let native = !!text.querySelector("textPath");
    for (let e: Element | null = text; e && e.id !== "viewbox"; e = e.parentElement) if (compat.has(e)) native = false;
    groups[group] ??= { native: 0, compat: 0 };
    groups[group][native ? "native" : "compat"]++;
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
  // native variant: state labels go native, so the switch exercises the glyph atlas as well as the compat lane
  result.variant = await page.evaluate(setVariant, "native");
  const camera = centerOn(1, ...((await page.evaluate(() => [(globalThis as any).graphWidth / 2, (globalThis as any).graphHeight / 2])) as [number, number]));
  await isolateLabels(page, null);
  result.camera = await zoomTo(page, camera);
  await settleApp(page);
  await isolateLabels(page, null);
  await waitGpu(page);
  const before = await page.evaluate(routing);
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
      const prior = await page.evaluate(routing);
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
      const after = await page.evaluate(routing);
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
  const failing = (result.switches as Json[]).filter(c => !c.pass);
  result.summary = { switches: result.switches.length, pass: result.switches.length - failing.length, fail: failing.length };
  result.failure = failing.length ? `${failing.length}/${result.switches.length} font switches failed: ${failing.map(c => `${c.id} (${c.failures[0]})`).join("; ")}` : result.switches.length ? null : "no font switch ran";
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
