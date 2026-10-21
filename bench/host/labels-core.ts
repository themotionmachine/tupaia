// Pure math for the label fidelity harness (bench/host/labels.ts; REWRITE-PLAN §5 rows 15, 16, 41, PROOF-PLAN §4
// "Labels" and "Fonts"). No I/O, no DOM: node --test covers it (labels-core.test.ts, part of `gate bench`).
//
// - labelHidden / thresholds: the app's zoom visibility rule for a label group (public/main.js updateZoomStyling,
//   including the MCP data-min-size / data-max-size / data-always-show overrides), and the zooms where it flips.
// - inkOf / register: per-pixel ink against a blank capture, and the integer + sub-pixel shift that best aligns the
//   GPU arm's ink with the SVG arm's inside a window (glyph position from pixels, for native and compat labels alike).
// - decodeGlyphKey / glyphBaseline: read a GPU glyph instance back to its character and the point on its (dy-shifted)
//   baseline, from the renderer's atlas key and instance floats (src/gpu/text.ts layoutLabel).
// - matchGlyphs: pair each SVG character with the nearest GPU glyph of the same character.
import type { Rgba } from "../fidelity-metrics.ts";

// src/utils/numberUtils.ts rn
export const rn = (v: number, d = 0): number => {
  const m = 10 ** d;
  return Math.round(v * m) / m;
};

// Tolerances, in device pixels (PROOF-PLAN §4 "within 1 px"; the packet asks for device px).
export const TOL = {
  glyphPx: 1, // analytic glyph midpoint, native labels
  registerPx: 1, // pixel registration shift per glyph, every label
  registerShare: 0.99, // share of registered glyphs that must be within registerPx (a missing glyph counts as outside)
  // a glyph (or label) window is drawn by the GPU only when the GPU ink inside it, read at the best shift, is at least
  // this share of the SVG ink there. Below it, the window is "missing": every candidate shift scores alike on an empty
  // GPU window, so the shift (0) means nothing and must not count as registered.
  registerInkShare: 0.5,
  advancePx: 1, // cumulative measureText-vs-SVG advance over a whole string
  // visible set: a label counts as drawn by the GPU when its box holds at least this share of the SVG arm's ink
  presentInkShare: 0.5,
  // stray GPU ink outside every visible label's box: at most max(extraMinPx, extraShare × the SVG arm's ink)
  extraMinPx: 24,
  extraShare: 0.01,
  // a pixel is ink when some channel differs from the blank by more than this
  inkDelta: 24,
  // a glyph window needs this many ink pixels in the SVG arm to be registered
  registerMinInk: 8,
  // golden for the font switch: golden-metrics.ts inkRatio is min/max of the two arms' ink pixel counts, so this floor
  // holds the arms within ~10% of each other in either direction (it does not say which arm paints more)
  inkRatioMin: 0.9
} as const;

export interface GroupRule {
  desired: number; // data-size
  min?: number; // data-min-size (default 6)
  max?: number; // data-max-size (default 60)
  always?: boolean; // data-always-show
  hideLabels: boolean; // Options > "Toggle visibility automatically"
}

// public/main.js updateZoomStyling: relative = max(rn((d + d/k)/2, 2), 1); hidden when relative*k leaves [min, max]
export function labelHidden(rule: GroupRule, k: number): boolean {
  const relative = Math.max(rn((rule.desired + rule.desired / k) / 2, 2), 1);
  const min = Number.isFinite(rule.min) ? (rule.min as number) : 6;
  const max = Number.isFinite(rule.max) ? (rule.max as number) : 60;
  return rule.hideLabels && !rule.always && (relative * k < min || relative * k > max);
}

export interface Threshold {
  k: number; // the flip zoom (to ~1e-7)
  below: boolean; // hidden just below k
  above: boolean; // hidden just above k
}

// Every zoom in (kMin, kMax) where the rule flips, found by a fine scan and refined by bisection. rn() makes the rule a
// step function in k, so a flip can sit between two scan points that are both on one side; the scan step is far
// below the ±0.01 the harness probes at, and the probes themselves are checked against the rule.
export function thresholds(rule: GroupRule, kMin: number, kMax: number, step = 0.0005): Threshold[] {
  const out: Threshold[] = [];
  if (!(kMax > kMin) || !(step > 0)) return out;
  let previousK = kMin;
  let previous = labelHidden(rule, kMin);
  const n = Math.ceil((kMax - kMin) / step);
  for (let i = 1; i <= n; i++) {
    const k = Math.min(kMax, kMin + i * step);
    const now = labelHidden(rule, k);
    if (now !== previous) {
      let [lo, hi] = [previousK, k];
      for (let j = 0; j < 60 && hi - lo > 1e-9; j++) {
        const mid = (lo + hi) / 2;
        if (labelHidden(rule, mid) === previous) lo = mid;
        else hi = mid;
      }
      out.push({ k: (lo + hi) / 2, below: previous, above: now });
    }
    previousK = k;
    previous = now;
  }
  return out;
}

export interface Zone {
  k0: number; // first flip
  k1: number; // last flip
  flips: number; // flips inside the zone: rn() in the rule makes the visibility flicker near a bound
}

// Flips closer than 2·delta together form one zone: a ±delta probe around one of them would land across another.
export function zones(found: Threshold[], delta = 0.01): Zone[] {
  const out: Zone[] = [];
  for (const t of found) {
    const last = out[out.length - 1];
    if (last && t.k - last.k1 < 2 * delta) {
      last.k1 = t.k;
      last.flips++;
    } else out.push({ k0: t.k, k1: t.k, flips: 1 });
  }
  return out;
}

// The two probe zooms of a zone that the zoom extent allows (delta outside its first and last flip, default the
// plan's ±0.01), with what the rule says there.
export function probes(zone: Zone, rule: GroupRule, kMin: number, kMax: number, delta = 0.01): { side: "below" | "above"; k: number; hidden: boolean }[] {
  const out: { side: "below" | "above"; k: number; hidden: boolean }[] = [];
  const below = rn(zone.k0 - delta, 6);
  const above = rn(zone.k1 + delta, 6);
  if (below >= kMin) out.push({ side: "below", k: below, hidden: labelHidden(rule, below) });
  if (above <= kMax) out.push({ side: "above", k: above, hidden: labelHidden(rule, above) });
  return out;
}

// Ink intensity per pixel: the largest channel difference from the blank (0..255).
export function inkOf(img: Rgba, blank: Rgba): Uint8Array {
  if (img.width !== blank.width || img.height !== blank.height) throw new Error("inkOf: blank size differs");
  const out = new Uint8Array(img.width * img.height);
  const a = img.data;
  const b = blank.data;
  for (let p = 0, i = 0; p < out.length; p++, i += 4)
    out[p] = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
  return out;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// integer pixel box clipped to the image, or null when nothing is left
export function clipBox(box: Box, width: number, height: number, pad = 0): Box | null {
  const x0 = Math.max(0, Math.floor(box.x0 - pad));
  const y0 = Math.max(0, Math.floor(box.y0 - pad));
  const x1 = Math.min(width, Math.ceil(box.x1 + pad));
  const y1 = Math.min(height, Math.ceil(box.y1 + pad));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

// Ink pixels (above `delta`) in a box.
export function inkCount(ink: Uint8Array, width: number, box: Box, delta: number = TOL.inkDelta): number {
  let n = 0;
  for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) if (ink[y * width + x] > delta) n++;
  return n;
}

// Pixels outside every box where `candidate` has ink and `reference` has none (above `delta`): ink the candidate arm
// paints where the reference paints nothing at all.
export function strayInk(candidate: Uint8Array, reference: Uint8Array, width: number, height: number, boxes: Box[], delta: number = TOL.inkDelta): number {
  const covered = new Uint8Array(width * height);
  for (const b of boxes) for (let y = b.y0; y < b.y1; y++) covered.fill(1, y * width + b.x0, y * width + b.x1);
  let n = 0;
  for (let p = 0; p < covered.length; p++) if (!covered[p] && candidate[p] > delta && reference[p] <= delta) n++;
  return n;
}

export interface Registration {
  dx: number; // GPU content sits at +dx device px relative to the SVG
  dy: number;
  shift: number; // |(dx, dy)|
  svgInk: number;
  gpuInk: number;
  gpuInkAtShift: number; // GPU ink pixels in the window moved by the best integer shift
  residual: number; // mean |Δ ink| per window pixel at the best integer shift
  edge: boolean; // the best integer shift is on the search border (the true shift may be larger)
  flat: boolean; // every candidate shift scored the same (no GPU ink within reach): the shift carries no information
}

// Shift (dx, dy) in [-radius, radius]² minimising Σ (svg(x, y) − gpu(x + dx, y + dy))² over the window, refined to
// sub-pixel by a parabola through the neighbouring scores on each axis. Pixels the shifted window reads from outside
// the image count as no ink.
export function register(svg: Uint8Array, gpu: Uint8Array, width: number, height: number, box: Box, radius = 3): Registration | null {
  const w = clipBox(box, width, height);
  if (!w) return null;
  const size = (w.x1 - w.x0) * (w.y1 - w.y0);
  const score = (dx: number, dy: number) => {
    let s = 0;
    for (let y = w.y0; y < w.y1; y++) {
      const gy = y + dy;
      for (let x = w.x0; x < w.x1; x++) {
        const gx = x + dx;
        const g = gx >= 0 && gx < width && gy >= 0 && gy < height ? gpu[gy * width + gx] : 0;
        const d = svg[y * width + x] - g;
        s += d * d;
      }
    }
    return s;
  };
  const grid = new Map<string, number>();
  let best = { dx: 0, dy: 0, s: Number.POSITIVE_INFINITY };
  let [lowest, highest] = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      const s = score(dx, dy);
      grid.set(`${dx},${dy}`, s);
      lowest = Math.min(lowest, s);
      highest = Math.max(highest, s);
      // ties keep the smaller shift (scan order is not symmetric, so compare magnitudes)
      if (s < best.s || (s === best.s && Math.hypot(dx, dy) < Math.hypot(best.dx, best.dy))) best = { dx, dy, s };
    }
  const at = (dx: number, dy: number) => grid.get(`${dx},${dy}`);
  const parabola = (m: number | undefined, c: number, p: number | undefined) => {
    if (m === undefined || p === undefined) return 0;
    const denominator = m - 2 * c + p;
    return denominator > 0 ? Math.max(-0.5, Math.min(0.5, (m - p) / (2 * denominator))) : 0;
  };
  const dx = best.dx + parabola(at(best.dx - 1, best.dy), best.s, at(best.dx + 1, best.dy));
  const dy = best.dy + parabola(at(best.dx, best.dy - 1), best.s, at(best.dx, best.dy + 1));
  let residual = 0;
  let gpuInkAtShift = 0;
  for (let y = w.y0; y < w.y1; y++)
    for (let x = w.x0; x < w.x1; x++) {
      const gx = x + best.dx;
      const gy = y + best.dy;
      const g = gx >= 0 && gx < width && gy >= 0 && gy < height ? gpu[gy * width + gx] : 0;
      residual += Math.abs(svg[y * width + x] - g);
      if (g > TOL.inkDelta) gpuInkAtShift++;
    }
  return {
    dx,
    dy,
    shift: Math.hypot(dx, dy),
    svgInk: inkCount(svg, width, w),
    gpuInk: inkCount(gpu, width, w),
    gpuInkAtShift,
    residual: residual / size,
    edge: Math.abs(best.dx) === radius || Math.abs(best.dy) === radius,
    flat: highest === lowest
  };
}

// What a registration says about one window:
// - "faint": too little SVG ink to register (not counted);
// - "missing": the GPU has no ink there worth aligning (below registerInkShare of the SVG ink at the best shift, or a
//   flat score): the GPU dropped or far-displaced the glyph, a failure, never a 0 px shift;
// - "registered": `shift` is meaningful (still a failure above registerPx, and when `edge` the true shift may be
//   larger than the search radius).
export function classifyRegistration(reg: Registration | null, minInk: number = TOL.registerMinInk, share: number = TOL.registerInkShare): "faint" | "missing" | "registered" {
  if (!reg || reg.svgInk < minInk) return "faint";
  if (reg.flat || reg.gpuInkAtShift < share * reg.svgInk) return "missing";
  return "registered";
}

// Atlas keys (src/gpu/text.ts GlyphAtlas.glyph): fill `${font}|0|${ink}|${char}`, halo
// `${font}|${halo}|${join}|${miter}|${ink}|${char}` (ink: the opaque paint colour the mask is cut in, "rgb(r,g,b)").
// A CSS font string and a colour carry no "|"; the character may be one.
export function decodeGlyphKey(key: string): { font: string; halo: number; char: string; ink: string } | null {
  const parts = key.split("|");
  if (parts.length < 4) return null;
  const halo = Number(parts[1]);
  if (!Number.isFinite(halo)) return null;
  if (halo === 0) return { font: parts[0], halo, ink: parts[2], char: parts.slice(3).join("|") };
  if (parts.length < 6) return null;
  return { font: parts[0], halo, ink: parts[4], char: parts.slice(5).join("|") };
}

// The central baseline shift (user units) a glyph instance's last three floats ask the shader for at CSS px per user
// unit k (src/gpu/text.ts centralShiftAt, shaders.ts glyph): ascent and descent rounded at the scaled font, the Mac
// ascent hack added for modes 3 and 4 (1 and 2 plus APPLE_ASCENT), halved, a nested box (mode 2) rounded up to a whole
// CSS px; 0 for mode 0 (the shift is in ly).
export function instanceCentralShift(ascent: number, descent: number, mode: number, k: number): number {
  if (!(mode > 0.5) || !(k > 0)) return 0;
  let [a, d] = [Math.floor(ascent * k + 0.5), Math.floor(descent * k + 0.5)];
  if (mode > 2.5) {
    a += Math.floor((a + d) * 0.15 + 0.5);
    mode -= 2;
  }
  const css = (a - d) / 2;
  return (mode > 1.5 ? Math.ceil(css - 1e-3) : css) / k;
}

// The (dy-shifted) baseline point under a glyph's advance midpoint, in world units, from one instance
// (cx cy angle lx ly w h … ascent descent mode, GLYPH_FLOATS = 18) and its atlas cell at camera zoom k: text.ts puts
// the path sample at (cx, cy) and the cell at ly = dy + baked shift + top/scale in the glyph's rotated frame, with
// scale = cell px / world height, and the shader adds the per-zoom central shift.
export function glyphBaseline(instance: ArrayLike<number>, glyph: { top: number; height: number }, k = 1): { x: number; y: number; angle: number } | null {
  const [cx, cy, angle, , ly, , h] = [instance[0], instance[1], instance[2], instance[3], instance[4], instance[5], instance[6]];
  if (!(h > 0) || !(glyph.height > 0)) return null;
  const scale = glyph.height / h;
  const shift = ly - glyph.top / scale + instanceCentralShift(instance[15] ?? 0, instance[16] ?? 0, instance[17] ?? 0, k);
  return { x: cx - Math.sin(angle) * shift, y: cy + Math.cos(angle) * shift, angle };
}

// The GPU's own glyphs, read back from the prepared frame: each fill-pass instance's character (atlas key), its raster
// font and scale, and its (dy-shifted) baseline midpoint in device px through the renderer's camera. It runs in the
// page (labels.ts passes it to page.evaluate, which serialises it), so it is self-contained: the baseline math is
// glyphBaseline's, inlined, and labels-core.test.ts runs this very function against glyphBaseline on a mock renderer.
// A shape change in the renderer internals is a harness error, never a silent empty list.
export function gpuGlyphs(dpr: number): Record<string, any> {
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
  const FLOATS = 18; // src/gpu/text.ts GLYPH_FLOATS
  const data: Float32Array = payload.glyphs;
  const out: { char: string; font: string; scale: number; x: number; y: number; angle: number; shift: number }[] = [];
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
    const char = parts.slice(3).join("|"); // decodeGlyphKey: `${font}|0|${ink}|${char}`
    // glyphBaseline (and instanceCentralShift at the view's zoom), inlined
    const h = data[i + 6];
    if (!(h > 0) || !(glyph.height > 0)) continue;
    const scale = glyph.height / h;
    const [ascent, descent, mode] = [data[i + 15], data[i + 16], data[i + 17]];
    let central = 0;
    if (mode > 0.5) {
      const css = (Math.floor(ascent * view.k + 0.5) - Math.floor(descent * view.k + 0.5)) / 2;
      central = (mode > 1.5 ? Math.ceil(css - 1e-3) : css) / view.k;
    }
    const shift = data[i + 4] - glyph.top / scale + central;
    const angle = data[i + 2];
    const wx = data[i] - Math.sin(angle) * shift;
    const wy = data[i + 1] + Math.cos(angle) * shift;
    // shift: the baseline shift (and, on the measured path, dy) the instance applies along the glyph normal, device px
    out.push({ char, font: parts[0], scale, x: (wx * view.k + view.x) * dpr, y: (wy * view.k + view.y) * dpr, angle: (angle * 180) / Math.PI, shift: shift * view.k * dpr });
  }
  return { glyphs: out, unknown, instances: data.length / FLOATS, view: { k: view.k, x: view.x, y: view.y } };
}

// A position error (GPU minus SVG) split along a glyph's baseline direction and along its normal (+ toward the
// glyph's local +y, below the baseline). An advance or path-sampling error is along; a baseline (dy, central shift)
// error is normal.
export function alongNormal(dx: number, dy: number, angleDeg: number): { along: number; normal: number } {
  const a = (angleDeg * Math.PI) / 180;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  return { along: dx * c + dy * s, normal: -dx * s + dy * c };
}

export interface Point {
  char: string;
  x: number;
  y: number;
}

// Greedy nearest same-character pairing within `radius`, closest pairs first; each GPU glyph is used once.
export function matchGlyphs(svg: Point[], gpu: Point[], radius: number): { i: number; j: number; distance: number }[] {
  const candidates: { i: number; j: number; distance: number }[] = [];
  svg.forEach((a, i) =>
    gpu.forEach((b, j) => {
      if (a.char !== b.char) return;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (distance <= radius) candidates.push({ i, j, distance });
    })
  );
  candidates.sort((a, b) => a.distance - b.distance);
  const [usedSvg, usedGpu] = [new Set<number>(), new Set<number>()];
  const out: { i: number; j: number; distance: number }[] = [];
  for (const c of candidates) {
    if (usedSvg.has(c.i) || usedGpu.has(c.j)) continue;
    usedSvg.add(c.i);
    usedGpu.add(c.j);
    out.push(c);
  }
  return out.sort((a, b) => a.i - b.i);
}

export function quantile(values: number[], q: number): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

export function stats(values: number[]): { n: number; p50: number; p95: number; p99: number; max: number } {
  const r = (v: number) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);
  return {
    n: values.length,
    p50: r(quantile(values, 0.5)),
    p95: r(quantile(values, 0.95)),
    p99: r(quantile(values, 0.99)),
    max: r(values.length ? Math.max(...values) : Number.NaN)
  };
}

// power-of-two raster scale of the GPU glyph atlas (src/gpu/raster.ts scaleBucket)
export function scaleBucket(scale: number, max = 16): number {
  return Math.min(max, 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(1, scale)))));
}
