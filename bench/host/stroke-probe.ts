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
// Verdict per line (`status`): pass when |width GPU - SVG| <= 1 device px, |pitch GPU - SVG| <= 1, |phase| <= 1, and a
// dot aspect within 0.25 of SVG's; an empty arm fails. Two cases are `not comparable` (neither a pass nor a failure,
// counted apart): sub-pixel round dots that SVG drops while GPU keeps below 0.1 px of mass (any visible GPU ink still
// fails), and the dot aspect of dots under 2 device px across (pixel phase, not shape) or of an arm with no dot mass.
// Width, pitch and phase of those lines are still judged: a measured failure makes the line fail.
//
// Join probes (JOINS) check what straight lines cannot: polylines with 60-135 degree turns under miter, round and
// bevel joins, dashed borders-style polylines, crossing subpaths in one path, a grid of cells whose subpaths share
// edges, and a translucent self-crossing path.
// Per probe, over its box (device px, ink relative to the backdrop at the box's border), the verdict counts
//   - notches: pixels SVG covers (>= 0.9 of the stroke's alpha) that GPU leaves at least 0.35 lighter (cracks at
//     joins and crossings), and
//   - spurs: the reverse, pixels GPU covers that SVG leaves at least 0.35 lighter (double blending, wrong miters),
// and fails on any notch or spur, or on an ink mass more than 10% away from SVG's.
// A check never compares GPU with GPU.
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
interface JoinProbe {
  name: string;
  d: string;
  width: number;
  join?: "miter" | "round" | "bevel";
  dash?: string;
  opacity?: number;
  box: [number, number, number, number]; // world x0 y0 x1 y1 of the path's vertices
}
// A zigzag of `n` segments of length `len` going down from (x, y), each turn `turn` degrees (60: shallow, 135: sharp).
function zigzag(x: number, y: number, turn: number, len: number, n: number): { d: string; box: JoinProbe["box"] } {
  const a = (turn / 2) * (Math.PI / 180);
  const points = [[x, y]];
  for (let i = 0; i < n; i++) {
    const [px, py] = points[points.length - 1];
    points.push([px + (i % 2 ? -1 : 1) * len * Math.sin(a), py + len * Math.cos(a)]);
  }
  const xs = points.map(p => p[0]),
    ys = points.map(p => p[1]);
  return {
    d: `M${points.map(p => p.map(v => v.toFixed(3)).join(",")).join("L")}`,
    box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
  };
}
// Probes sit in world y 8..52 above the probe lines, x 80..300 (clear of the page chrome at k 1, inside the view at
// k 4); off-grid starts keep edges off pixel boundaries.
const JOIN_Y = 8.3;
const JOINS: JoinProbe[] = [
  { name: "zigzag 90 miter w2.5", ...zigzag(82.3, JOIN_Y, 90, 11, 4), width: 2.5, join: "miter" },
  { name: "zigzag 60 miter w1.3", ...zigzag(112.3, JOIN_Y, 60, 9.5, 4), width: 1.3, join: "miter" },
  { name: "zigzag 120 round w1.7", ...zigzag(134.3, JOIN_Y, 120, 16, 4), width: 1.7, join: "round" },
  { name: "zigzag 135 bevel w1.7", ...zigzag(164.3, JOIN_Y, 135, 21, 4), width: 1.7, join: "bevel" },
  { name: "borders zigzag 70 dash 2 w1", ...zigzag(194.3, JOIN_Y, 70, 10.3, 4), width: 1, dash: "2" },
  {
    name: "crossing subpaths w1.5",
    d: "M222.3,10.3L246.3,46.3M246.3,10.3L222.3,46.3M222.3,28.1L246.3,28.6",
    box: [222.3, 10.3, 246.3, 46.3],
    width: 1.5
  },
  {
    // 3x3 cells as nine closed subpaths: interior edges are shared by two cells, as in the cell grid
    name: "shared-edge cells w0.7",
    d: Array.from({ length: 9 }, (_, i) => {
      const [x, y] = [291.3 + (i % 3) * 7, 14.3 + Math.floor(i / 3) * 7];
      return `M${x},${y}h7v7h-7Z`;
    }).join(""),
    box: [291.3, 14.3, 312.3, 35.3],
    width: 0.7
  },
  {
    name: "translucent self-crossing 0.5 w2.5",
    d: "M258.3,12.3L284.3,44.3L284.3,12.3L258.3,44.3Z",
    box: [258.3, 12.3, 284.3, 44.3],
    width: 2.5,
    join: "miter",
    opacity: 0.5
  }
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
  cells: [] as {
    dpr: number;
    k: number;
    images: { svg: string; gpu: string };
    renderer: string;
    lines: Json[];
    joins: Json[];
  }[]
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
    ({ probes, joins, spacing, x0, x1, y0 }) => {
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
      for (const probe of joins) {
        const path = document.createElementNS(ns, "path");
        path.setAttribute("d", probe.d);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "#000000");
        path.setAttribute("stroke-width", String(probe.width));
        if (probe.join) path.setAttribute("stroke-linejoin", probe.join);
        if (probe.dash) path.setAttribute("stroke-dasharray", probe.dash);
        if (probe.opacity !== undefined) path.setAttribute("stroke-opacity", String(probe.opacity));
        group.appendChild(path);
      }
      view.appendChild(group);
    },
    { probes: PROBES, joins: JOINS, spacing: SPACING, x0: X0, x1: X1, y0: Y0 }
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
  const at = (x: number, y: number) => (y < 0 || y >= image.height ? 0 : coverage(image, x, y));
  for (let x = xa; x < xb; x++) {
    // the page background is not pure white (and differs per arm), so each column's ink is measured against the
    // rows just outside its window
    const background = (at(x, yc - radius - 1) + at(x, yc + radius + 1)) / 2;
    let mass = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const y = yc + dy;
      if (y < 0 || y >= image.height) continue;
      const c = coverage(image, x, y) - background;
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

// Spread (standard deviation) of a profile around its centroid. Background subtraction leaves small negative masses,
// which are ink-free and count as zero (a negative weight could make the variance negative). NaN when there is no mass.
function spread(profile: number[]): number {
  const values = profile.map(v => Math.max(0, v));
  const total = values.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return Number.NaN;
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
  const notComparable: string[] = [];
  // Sub-pixel round dots (a 0.25 device-px radius) are dropped by Skia entirely; a GPU arm that is also below
  // visibility is then not comparable rather than a failure (or a pass). Any visible GPU ink still fails.
  const subPixelDots = !!probe.dots && probe.width * scale <= 0.5 && !(widthSvg > 0.01) && widthGpu < 0.1;
  if (subPixelDots) notComparable.push("SVG drops sub-pixel dots, GPU mass < 0.1 px");
  else {
    if (!(widthSvg > 0.01)) failures.push("SVG arm empty");
    if (!(widthGpu > 0.01)) failures.push("GPU arm empty");
  }
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
      // a dot under 2 device px across is one or two pixels whose split is the dot's pixel phase, not its shape
      if (probe.dots && !subPixelDots && probe.width * scale < 2) notComparable.push("dot under 2 device px: no aspect");
      else if (probe.dots && !subPixelDots) {
        const aspect = (p: Profile) => spread(folded(p.along, period)) / Math.max(1e-6, spread(p.across));
        const [svgAspect, gpuAspect] = [aspect(s), aspect(g)];
        line.dotAspectSvg = Number.isFinite(svgAspect) ? round(svgAspect) : null;
        line.dotAspectGpu = Number.isFinite(gpuAspect) ? round(gpuAspect) : null;
        if (!Number.isFinite(svgAspect) || !Number.isFinite(gpuAspect))
          notComparable.push(`dot aspect not measurable (svg ${line.dotAspectSvg}, gpu ${line.dotAspectGpu})`);
        else if (Math.abs(gpuAspect - svgAspect) > 0.25)
          failures.push(`dot aspect ${line.dotAspectGpu} vs ${line.dotAspectSvg}`);
      }
    } else line.periodPx = round(period); // sub-3 px period: only the mean coverage is comparable
  }
  if (Math.abs(widthGpu - widthSvg) > 1) failures.push(`width off by ${round(widthGpu - widthSvg)} px`);
  return verdict(line, failures, notComparable);
}

// A failure wins over not comparable; `pass` is true only for a measured pass.
function verdict(line: Json, failures: string[], notComparable: string[]): Json {
  line.status = failures.length ? "fail" : notComparable.length ? "not comparable" : "pass";
  line.pass = line.status === "pass";
  line.failures = failures;
  if (notComparable.length) line.notComparable = notComparable;
  return line;
}

// Ink coverage (stroke alpha times coverage) over a probe's device box. The backdrop is not uniform white on every
// arm (the isolated page can keep a tinted, textured background), so a black stroke's coverage is read relative to
// the backdrop's luminance, taken as the median of the box's border pixels: 1 - luminance / backdrop.
function inkBox(image: DecodedPng, box: [number, number, number, number]): { w: number; h: number; ink: Float32Array } {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0,
    h = y1 - y0;
  const luminance = (x: number, y: number) => {
    const i = (y * image.width + x) * 4;
    return (image.data[i] + image.data[i + 1] + image.data[i + 2]) / 765;
  };
  const border: number[] = [];
  for (let x = x0; x < x1; x++) border.push(luminance(x, y0), luminance(x, y1 - 1));
  for (let y = y0; y < y1; y++) border.push(luminance(x0, y), luminance(x1 - 1, y));
  border.sort((a, b) => a - b);
  const backdrop = Math.max(1e-3, border[border.length >> 1] ?? 1);
  const ink = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ink[y * w + x] = 1 - luminance(x0 + x, y0 + y) / backdrop;
  return { w, h, ink };
}

function measureJoin(probe: JoinProbe, svg: DecodedPng, gpu: DecodedPng, k: number, dpr: number): Json {
  const scale = k * dpr;
  const pad = probe.width / 2 + 2.5;
  const box: [number, number, number, number] = [
    Math.max(0, Math.floor((probe.box[0] - pad) * scale)),
    Math.max(0, Math.floor((probe.box[1] - pad) * scale)),
    Math.min(svg.width, Math.ceil((probe.box[2] + pad) * scale)),
    Math.min(svg.height, Math.ceil((probe.box[3] + pad) * scale))
  ];
  const s = inkBox(svg, box),
    g = inkBox(gpu, box);
  const alpha = probe.opacity ?? 1;
  let massSvg = 0,
    massGpu = 0,
    notches = 0,
    spurs = 0,
    worstNotch: number[] | null = null,
    worstSpur: number[] | null = null,
    worstNotchDelta = 0,
    worstSpurDelta = 0;
  for (let i = 0; i < s.ink.length; i++) {
    const a = Math.max(0, s.ink[i]) / alpha,
      b = Math.max(0, g.ink[i]) / alpha;
    massSvg += a;
    massGpu += b;
    const at = [box[0] + (i % s.w), box[1] + Math.floor(i / s.w)];
    if (a >= 0.9 && a - b >= 0.35) {
      notches++;
      if (a - b > worstNotchDelta) [worstNotchDelta, worstNotch] = [a - b, at];
    }
    if (b >= 0.9 && b - a >= 0.35) {
      spurs++;
      if (b - a > worstSpurDelta) [worstSpurDelta, worstSpur] = [b - a, at];
    }
  }
  const massRatio = massGpu / Math.max(1e-6, massSvg);
  const line: Json = {
    probe: probe.name,
    strokePx: round(probe.width * scale),
    box,
    massSvg: round(massSvg, 1),
    massGpu: round(massGpu, 1),
    massRatio: round(massRatio),
    notches,
    worstNotch: worstNotch && { at: worstNotch, delta: round(worstNotchDelta) },
    spurs,
    worstSpur: worstSpur && { at: worstSpur, delta: round(worstSpurDelta) }
  };
  const failures: string[] = [];
  if (!(massSvg > 1)) failures.push("SVG arm empty");
  if (!(massGpu > 1)) failures.push("GPU arm empty");
  if (notches) failures.push(`${notches} notch px (worst ${round(worstNotchDelta)} at ${worstNotch})`);
  if (spurs) failures.push(`${spurs} spur px (worst ${round(worstSpurDelta)} at ${worstSpur})`);
  if (Math.abs(massRatio - 1) > 0.1) failures.push(`ink mass ratio ${round(massRatio)}`);
  return verdict(line, failures, []);
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
      const joins = JOINS.map(probe => measureJoin(probe, svg, gpu, k, dpr));
      if (renderer !== "gpu")
        for (const line of [...lines, ...joins]) Object.assign(line, { status: "fail", pass: false, failures: [`renderer ${renderer}`] });
      report.cells.push({ dpr, k, images, renderer, lines, joins });
      const count = (list: Json[], status: string) => list.filter(l => l.status === status).length;
      log(
        `d${dpr} k${k}: lines ${count(lines, "pass")} pass, ${count(lines, "fail")} fail, ${count(lines, "not comparable")} not comparable; ` +
          `joins ${count(joins, "pass")}/${joins.length} pass (${renderer})`
      );
      write();
    }
    await context.close();
  }
  const failing = report.cells.flatMap(c =>
    [...c.lines, ...c.joins].filter(l => l.status === "fail").map(l => `d${c.dpr} k${c.k} ${l.probe}: ${(l.failures as string[]).join(", ")}`)
  );
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
