// Stroke width and dash probe (PROOF-PLAN §4 "Strokes. Width within 1 device px. Dash phase continuous."; REWRITE-PLAN
// §5 strokes row). Run it through bench/gate/gate.ts (`gate stroke-probe`), which takes a shared host-lock slot and
// sets GATE_OUT_DIR.
//
// It appends one synthetic layer (#strokeProbe) to #viewbox of a generated map, isolates it (golden-isolation.ts, the
// golden's isolation) and draws a set of horizontal probe lines: solid widths from a quarter pixel up, and the dash
// styles the app's default style uses (state borders "2" butt, province borders "0 2" round dots, trails ".8 1.6",
// sea routes "1 2" round, coordinates "5", a square-capped "2"). For each zoom and device pixel ratio it captures the
// GPU arm (canvas shown) and the SVG arm (canvas hidden) from the same DOM state, SVG being the reference, and
// measures per line, in device pixels:
//   - width: the mean column coverage across the line (a stroke's ink mass per unit length, so a 0.5 px line reads 0.5);
//   - duty: mean coverage along the line over the full-width coverage (dashes only);
//   - pitch: the dash period from the autocorrelation of the along-line profile;
//   - phase: the lag that best aligns the GPU profile with the SVG one;
//   - dot aspect: along/across spread of a dot (round "0 2" dots: 1 when round).
// Verdict per line: |width GPU - SVG| <= 1 device px, |pitch GPU - SVG| <= 1, |phase| <= 1, and a dot aspect within
// 0.25 of SVG's; an empty arm fails. A check never compares GPU with GPU.
//
// Environment: GATE_OUT_DIR (evidence), PROBE_DPR (comma list, default 1,2), PROBE_K (comma list, default 1,4).
// Output: stroke-probe.json (report; `failure` null on a pass) and probe-<dpr>-k<k>-{svg,gpu}.png.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { decodePng, type DecodedPng } from "../png.ts";
import { isolateLayer } from "./golden-isolation.ts";

const env = process.env;
const REPO = resolve(import.meta.dirname, "../..");
const dist = join(REPO, "dist");
const outDir = env.GATE_OUT_DIR || join(REPO, ".stroke-probe");
const dprs = (env.PROBE_DPR || "1,2").split(",").map(Number);
const zooms = (env.PROBE_K || "1,4").split(",").map(Number);
if (dprs.some(d => d !== 1 && d !== 2)) throw Error("PROBE_DPR must be 1 and/or 2");
if (zooms.some(k => !(k > 0))) throw Error("PROBE_K must be positive zooms");

interface Probe {
  name: string;
  width: number; // world units (CSS px at k 1)
  dash?: string;
  cap?: "butt" | "round" | "square";
  period?: number; // world units, dashed only
  dots?: boolean;
}
const PROBES: Probe[] = [
  { name: "solid 0.25", width: 0.25 },
  { name: "solid 0.5", width: 0.5 },
  { name: "solid 1", width: 1 },
  { name: "solid 2.5", width: 2.5 },
  { name: "stateBorders 2 butt w1", width: 1, dash: "2", cap: "butt", period: 4 },
  { name: "provinceBorders 0 2 round w0.5", width: 0.5, dash: "0 2", cap: "round", period: 2, dots: true },
  { name: "trails .8 1.6 butt w0.25", width: 0.25, dash: ".8 1.6", cap: "butt", period: 2.4 },
  { name: "searoutes 1 2 round w0.35", width: 0.35, dash: "1 2", cap: "round", period: 3 },
  { name: "coordinates 5 butt w1", width: 1, dash: "5", cap: "butt", period: 10 },
  { name: "square 2 w0.7", width: 0.7, dash: "2", cap: "square", period: 4 }
];
const SPACING = 12; // world units between probe lines
// clear of the page chrome (top-left menu button) at k 1, and inside the 1280x720 viewport at k 4
const X0 = 60;
const X1 = 300;
const Y0 = 60;

const report = {
  schema: 1,
  runStartedUtc: new Date().toISOString(),
  args: { dpr: dprs, k: zooms },
  errors: [] as string[],
  failure: null as string | null,
  cells: [] as { dpr: number; k: number; images: { svg: string; gpu: string }; renderer: string; lines: Json[] }[]
};
type Json = Record<string, unknown>;
const log = (message: string) => console.log(`[stroke-probe] ${message}`);
const write = () => writeFileSync(join(outDir, "stroke-probe.json"), `${JSON.stringify(report, null, 2)}\n`);

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

// ------------------------------------------------------------------ page

async function setup(page: Page): Promise<void> {
  await page.evaluate(
    ({ probes, spacing, x0, x1, y0 }) => {
      const ns = "http://www.w3.org/2000/svg";
      const view = document.querySelector("svg#map > #viewbox")!;
      document.getElementById("strokeProbe")?.remove();
      const group = document.createElementNS(ns, "g");
      group.id = "strokeProbe";
      probes.forEach((probe, i) => {
        const path = document.createElementNS(ns, "path");
        const y = y0 + i * spacing;
        path.setAttribute("d", `M${x0},${y}L${x1},${y}`);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "#000000");
        path.setAttribute("stroke-width", String(probe.width));
        if (probe.dash) path.setAttribute("stroke-dasharray", probe.dash);
        if (probe.cap) path.setAttribute("stroke-linecap", probe.cap);
        group.appendChild(path);
      });
      view.appendChild(group);
    },
    { probes: PROBES, spacing: SPACING, x0: X0, x1: X1, y0: Y0 }
  );
  await page.evaluate(isolateLayer, { id: "strokeProbe", bg: "#ffffff" });
}

const camera = (k: number) => ({ k, x: 0, y: 0 });

async function zoomTo(page: Page, k: number): Promise<void> {
  await page.evaluate(async ({ k, x, y }) => {
    const w = globalThis as any;
    w.d3.select("#map").call((0, eval)("zoom").transform, w.d3.zoomIdentity.translate(x, y).scale(k));
    await w.__tupaia.settle();
  }, camera(k));
}

async function waitGpu(page: Page): Promise<string> {
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
      { timeout: 60000, polling: 50 }
    );
  } catch {
    return "timeout";
  }
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  return page.evaluate(() => {
    const s = (globalThis as any).rendererStatus?.();
    return s?.active === "gpu" ? "gpu" : `svg (${s?.fallbackReason || "no reason"})`;
  });
}

async function captureArms(page: Page): Promise<{ gpu: Buffer; svg: Buffer }> {
  const gpu = await page.screenshot({ animations: "disabled" });
  await page.evaluate(() => {
    const c = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
    if (c) c.style.visibility = "hidden";
  });
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const svg = await page.screenshot({ animations: "disabled" });
  await page.evaluate(() => {
    const c = document.querySelector("canvas[data-gpu-renderer]") as HTMLCanvasElement | null;
    if (c) c.style.visibility = "";
  });
  return { gpu, svg };
}

// ------------------------------------------------------------------ measurement

// Coverage of black ink on the white backdrop at (x, y), 0..1.
const coverage = (image: DecodedPng, x: number, y: number) => {
  const i = (y * image.width + x) * 4;
  return Math.max(0, 1 - (image.data[i] + image.data[i + 1] + image.data[i + 2]) / 765);
};

interface Profile {
  along: number[]; // column mass across the line, per device column
  across: number[]; // row mass along the line, per device row offset from -radius
  radius: number;
}

function profile(image: DecodedPng, yCentre: number, xa: number, xb: number, radius: number): Profile {
  const along: number[] = [];
  const across = new Array(radius * 2 + 1).fill(0);
  const yc = Math.round(yCentre);
  for (let x = xa; x < xb; x++) {
    let mass = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const y = yc + dy;
      if (y < 0 || y >= image.height) continue;
      const c = coverage(image, x, y);
      mass += c;
      across[dy + radius] += c;
    }
    along.push(mass);
  }
  return { along, across, radius };
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

// Lag in [lo, hi] (device px, parabolic sub-pixel refinement) maximizing the correlation of a with b shifted.
function bestLag(a: number[], b: number[], lo: number, hi: number): number {
  const ma = mean(a),
    mb = mean(b);
  const score = (lag: number) => {
    let sum = 0,
      n = 0;
    for (let i = Math.max(0, -lag); i < a.length && i + lag < b.length; i++) {
      if (i + lag < 0) continue;
      sum += (a[i] - ma) * (b[i + lag] - mb);
      n++;
    }
    return n ? sum / n : -Infinity;
  };
  let best = lo,
    bestScore = -Infinity;
  for (let lag = lo; lag <= hi; lag++) {
    const s = score(lag);
    if (s > bestScore) {
      bestScore = s;
      best = lag;
    }
  }
  const [l, c, r] = [score(best - 1), bestScore, score(best + 1)];
  const denominator = l - 2 * c + r;
  return Number.isFinite(denominator) && denominator < 0 ? best + (0.5 * (l - r)) / denominator : best;
}

// Spread (standard deviation) of a non-negative profile around its centroid.
function spread(values: number[]): number {
  const total = values.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return 0;
  const centre = values.reduce((a, v, i) => a + v * i, 0) / total;
  return Math.sqrt(values.reduce((a, v, i) => a + v * (i - centre) ** 2, 0) / total);
}

// The dot profile folded on the dash period, centred on its peak, for the along-spread of round dots.
function folded(along: number[], period: number): number[] {
  const bins = Math.max(3, Math.round(period));
  const sums = new Array(bins).fill(0),
    counts = new Array(bins).fill(0);
  for (let i = 0; i < along.length; i++) {
    const b = Math.floor(((i % period) / period) * bins) % bins;
    sums[b] += along[i];
    counts[b]++;
  }
  const f = sums.map((s, i) => s / Math.max(1, counts[i]));
  const peak = f.indexOf(Math.max(...f));
  return f.map((_, i) => f[(peak - Math.floor(bins / 2) + i + bins) % bins]);
}

function measureLine(probe: Probe, svg: DecodedPng, gpu: DecodedPng, k: number, dpr: number, index: number): Json {
  const scale = k * dpr;
  const yCentre = (Y0 + index * SPACING) * scale - 0.5; // pixel centres sit at half-integers
  const margin = Math.ceil(8 * dpr);
  const xa = Math.ceil(X0 * scale) + margin;
  const xb = Math.min(svg.width, Math.floor(X1 * scale)) - margin;
  const radius = Math.max(3, Math.ceil((probe.width * scale) / 2 + 3));
  const s = profile(svg, yCentre, xa, xb, radius);
  const g = profile(gpu, yCentre, xa, xb, radius);
  const widthSvg = mean(s.along),
    widthGpu = mean(g.along);
  const line: Json = {
    probe: probe.name,
    strokePx: probe.width * scale,
    meanMassSvg: round(widthSvg),
    meanMassGpu: round(widthGpu),
    widthDeltaPx: round(widthGpu - widthSvg),
    crossSvg: round(spread(s.across)),
    crossGpu: round(spread(g.across))
  };
  const failures: string[] = [];
  if (!(widthSvg > 0.01)) failures.push("SVG arm empty");
  if (!(widthGpu > 0.01)) failures.push("GPU arm empty");
  if (probe.period) {
    // dashed: the mass per column of a solid line of this width is the duty denominator
    const solid = probe.width * scale;
    line.dutySvg = round(widthSvg / Math.max(solid, 1e-6));
    line.dutyGpu = round(widthGpu / Math.max(solid, 1e-6));
    const period = probe.period * scale;
    if (period >= 3) {
      const pitchSvg = bestLag(s.along, s.along, Math.max(2, Math.floor(period * 0.6)), Math.ceil(period * 1.4));
      const pitchGpu = bestLag(g.along, g.along, Math.max(2, Math.floor(period * 0.6)), Math.ceil(period * 1.4));
      const phase = bestLag(s.along, g.along, -Math.ceil(period / 2), Math.ceil(period / 2));
      Object.assign(line, { periodPx: round(period), pitchSvg: round(pitchSvg), pitchGpu: round(pitchGpu), phasePx: round(phase) });
      if (Math.abs(pitchGpu - pitchSvg) > 1) failures.push(`pitch ${round(pitchGpu)} vs ${round(pitchSvg)} px`);
      if (Math.abs(phase) > 1) failures.push(`phase off by ${round(phase)} px`);
      if (probe.dots) {
        const aspect = (p: Profile) => spread(folded(p.along, period)) / Math.max(1e-6, spread(p.across));
        line.dotAspectSvg = round(aspect(s));
        line.dotAspectGpu = round(aspect(g));
        if (Math.abs((line.dotAspectGpu as number) - (line.dotAspectSvg as number)) > 0.25)
          failures.push(`dot aspect ${line.dotAspectGpu} vs ${line.dotAspectSvg}`);
      }
    } else line.periodPx = round(period); // sub-3 px period: only the mean coverage is comparable
  }
  if (Math.abs(widthGpu - widthSvg) > 1) failures.push(`width off by ${round(widthGpu - widthSvg)} px`);
  line.pass = failures.length === 0;
  line.failures = failures;
  return line;
}

const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

// ------------------------------------------------------------------ run

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--use-angle=metal", "--enable-gpu"] });
try {
  for (const dpr of dprs) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: dpr, serviceWorkers: "block" });
    await context.addInitScript(() => {
      localStorage.setItem("autosaveInterval", "0");
      localStorage.setItem("azgaarAssistant", "hide");
    });
    // the __tupaia bridge (as gpu-smoke.ts and layer-golden.ts install it)
    const bridge = join(REPO, "mcp/src");
    const scripts = ["bridge.js", "bridge-mutations.js", ...readdirSync(join(bridge, "bridge-ext")).filter(n => n.endsWith(".js")).sort().map(n => `bridge-ext/${n}`)];
    await context.addInitScript(scripts.map(n => readFileSync(join(bridge, n), "utf8")).join("\n"));
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      return url.origin === origin || (route.request().method() === "GET" && url.hostname === "fonts.gstatic.com") ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(120000);
    page.on("pageerror", e => report.errors.push(e.message));
    page.on("dialog", d => d.dismiss());
    await page.goto(`${origin}/?local&seed=7319&width=1280&height=720&renderer=gpu`);
    await page.waitForFunction(() => !!(globalThis as any).__tupaia?.call, {}, { timeout: 120000 });
    await page.evaluate(async () => {
      const ready = await (globalThis as any).__tupaia.call("ready", { timeoutMs: 120000 });
      if (!ready.ok) throw Error(JSON.stringify(ready));
    });
    await setup(page);
    for (const k of zooms) {
      await zoomTo(page, k);
      await page.evaluate(isolateLayer, { id: "strokeProbe", bg: "#ffffff" });
      const renderer = await waitGpu(page);
      const shots = await captureArms(page);
      const images = { svg: `probe-d${dpr}-k${k}-svg.png`, gpu: `probe-d${dpr}-k${k}-gpu.png` };
      writeFileSync(join(outDir, images.svg), shots.svg);
      writeFileSync(join(outDir, images.gpu), shots.gpu);
      const svg = decodePng(shots.svg),
        gpu = decodePng(shots.gpu);
      const lines = PROBES.map((probe, i) => measureLine(probe, svg, gpu, k, dpr, i));
      if (renderer !== "gpu") for (const line of lines) Object.assign(line, { pass: false, failures: [`renderer ${renderer}`] });
      report.cells.push({ dpr, k, images, renderer, lines });
      log(`d${dpr} k${k}: ${lines.filter(l => l.pass).length}/${lines.length} lines pass (${renderer})`);
      write();
    }
    await context.close();
  }
  const failing = report.cells.flatMap(c => c.lines.filter(l => !l.pass).map(l => `d${c.dpr} k${c.k} ${l.probe}: ${(l.failures as string[]).join(", ")}`));
  if (report.errors.length) failing.unshift(`page errors: ${report.errors.slice(0, 3).join(" | ")}`);
  report.failure = failing.length ? failing.slice(0, 12).join("; ") : null;
  write();
} catch (error) {
  report.failure = `harness: ${(error as Error).message}`;
  write();
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
