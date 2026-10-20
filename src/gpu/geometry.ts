import type { Subpath } from "./svg-path";

export class F32 {
  data: Float32Array;
  length = 0;

  constructor(capacity = 1024) {
    if (!Number.isInteger(capacity) || capacity < 0) throw new RangeError(`F32 capacity ${capacity}`);
    this.data = new Float32Array(capacity);
  }

  private ensure(extra: number): void {
    const need = this.length + extra;
    if (need <= this.data.length) return;
    // a zero capacity would never double
    let cap = Math.max(this.data.length * 2, 16);
    while (cap < need) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }

  push2(a: number, b: number): void {
    this.ensure(2);
    const d = this.data;
    const i = this.length;
    d[i] = a;
    d[i + 1] = b;
    this.length = i + 2;
  }

  push3(a: number, b: number, c: number): void {
    this.ensure(3);
    const d = this.data;
    const i = this.length;
    d[i] = a;
    d[i + 1] = b;
    d[i + 2] = c;
    this.length = i + 3;
  }

  push4(a: number, b: number, c: number, e: number): void {
    this.ensure(4);
    const d = this.data;
    const i = this.length;
    d[i] = a;
    d[i + 1] = b;
    d[i + 2] = c;
    d[i + 3] = e;
    this.length = i + 4;
  }

  push5(a: number, b: number, c: number, e: number, f: number): void {
    this.ensure(5);
    const d = this.data;
    const i = this.length;
    d[i] = a;
    d[i + 1] = b;
    d[i + 2] = c;
    d[i + 3] = e;
    d[i + 4] = f;
    this.length = i + 5;
  }

  view(): Float32Array {
    return this.data.subarray(0, this.length);
  }
}

export function appendFan(subpaths: Subpath[], out: F32): number {
  let vertices = 0;
  for (const { points } of subpaths) {
    const n = points.length >> 1;
    if (n < 3) continue;
    const x0 = points[0];
    const y0 = points[1];
    for (let i = 1; i < n - 1; i++) {
      out.push2(x0, y0);
      out.push2(points[i * 2], points[i * 2 + 1]);
      out.push2(points[i * 2 + 2], points[i * 2 + 3]);
      vertices += 3;
    }
  }
  return vertices;
}

export function appendSegments(subpaths: Subpath[], out: F32): number {
  let instances = 0;
  for (const { points, closed } of subpaths) {
    const n = points.length >> 1;
    if (n < 2) continue;
    const segCount = closed ? n : n - 1;
    let d = 0;
    for (let i = 0; i < segCount; i++) {
      const j = (i + 1) % n;
      const x0 = points[i * 2];
      const y0 = points[i * 2 + 1];
      const x1 = points[j * 2];
      const y1 = points[j * 2 + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len === 0) continue;
      out.push5(x0, y0, x1, y1, d);
      d += len;
      instances++;
    }
  }
  return instances;
}

export function polylineLength(points: ArrayLike<number>): number {
  const n = points.length >> 1;
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += Math.hypot(points[i * 2] - points[i * 2 - 2], points[i * 2 + 1] - points[i * 2 - 1]);
  }
  return total;
}

export function cumulativeLengths(points: ArrayLike<number>): Float64Array {
  const n = points.length >> 1;
  const out = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    out[i] = out[i - 1] + Math.hypot(points[i * 2] - points[i * 2 - 2], points[i * 2 + 1] - points[i * 2 - 1]);
  }
  return out;
}

export interface PathSample {
  x: number;
  y: number;
  angle: number;
}

export function sampleAt(
  points: ArrayLike<number>,
  cumulative: Float64Array,
  distance: number,
  out?: PathSample
): PathSample | null {
  const n = cumulative.length;
  const total = n > 0 ? cumulative[n - 1] : 0;
  if (n < 2 || distance < 0 || distance > total || Number.isNaN(distance)) return null;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] <= distance) lo = mid;
    else hi = mid;
  }
  const segLen = cumulative[lo + 1] - cumulative[lo];
  const t = segLen > 0 ? (distance - cumulative[lo]) / segLen : 0;
  const ax = points[lo * 2];
  const ay = points[lo * 2 + 1];
  const bx = points[lo * 2 + 2];
  const by = points[lo * 2 + 3];
  const result = out ?? { x: 0, y: 0, angle: 0 };
  result.x = ax + (bx - ax) * t;
  result.y = ay + (by - ay) * t;
  result.angle = Math.atan2(by - ay, bx - ax);
  return result;
}

export function layoutOnPath(
  points: ArrayLike<number>,
  advances: ArrayLike<number>,
  offsetFraction: number,
  anchor: "start" | "middle" | "end"
): { x: number; y: number; angle: number; visible: boolean }[] {
  const cumulative = cumulativeLengths(points);
  const total = cumulative.length > 0 ? cumulative[cumulative.length - 1] : 0;
  let totalAdvance = 0;
  for (let i = 0; i < advances.length; i++) totalAdvance += advances[i];
  const anchorShift = totalAdvance * (anchor === "middle" ? 0.5 : anchor === "end" ? 1 : 0);
  const start = offsetFraction * total - anchorShift;
  const result: { x: number; y: number; angle: number; visible: boolean }[] = [];
  let pen = start;
  for (let i = 0; i < advances.length; i++) {
    const mid = pen + advances[i] / 2;
    pen += advances[i];
    const visible = mid >= 0 && mid <= total;
    const s = visible ? sampleAt(points, cumulative, mid) : null;
    result.push({ x: s?.x ?? 0, y: s?.y ?? 0, angle: s?.angle ?? 0, visible: s !== null });
  }
  return result;
}

export function normalizeDashes(list: number[]): number[] {
  if (list.length === 0) return [];
  let allZero = true;
  for (const v of list) {
    if (v < 0) return [];
    if (v !== 0) allZero = false;
  }
  if (allZero) return [];
  return list.length % 2 === 1 ? [...list, ...list] : [...list];
}

export function dashOn(s: number, dashes: number[], offset = 0): boolean {
  const pattern = normalizeDashes(dashes);
  if (pattern.length === 0) return true;
  let period = 0;
  for (const v of pattern) period += v;
  let p = (((s + offset) % period) + period) % period;
  for (let i = 0; i < pattern.length; i++) {
    if (p < pattern[i]) return i % 2 === 0;
    p -= pattern[i];
  }
  return true;
}

// Stroke cap codes shared with the stroke shader: 0 square, 1 butt, 2 round.
export function capCode(lineCap = "butt"): number {
  return lineCap === "round" ? 2 : lineCap === "square" ? 0 : 1;
}

// CPU mirror of the stroke shader's dash test. SVG applies stroke-linecap to every dash, so a gap fragment within
// `reach` of the nearest dash end stays covered (square), or within the cap disc at offset `across` (round).
export function dashCovered(s: number, across: number, dashes: number[], offset: number, cap: number, reach: number) {
  const pattern = normalizeDashes(dashes);
  if (pattern.length === 0) return true;
  const period = pattern.reduce((sum, value) => sum + value, 0);
  let p = (((s + offset) % period) + period) % period;
  let on = true,
    run = period;
  for (const value of pattern) {
    run = value;
    if (p < run) break;
    p -= run;
    on = !on;
  }
  if (on) return true;
  const gap = Math.min(p, run - p);
  if (cap === 1 || gap > reach) return false;
  return cap !== 2 || gap * gap + across * across <= reach * reach;
}

// CPU mirrors of the stroke shader's analytic coverage (shaders.ts `stroke`). Every length is in device pixels and the
// pixel is a unit box filter around its centre, as Skia's analytic AA approximates for SVG.
// Coverage of a pixel whose centre lies `d` from the centreline of a band of half width `h` (exact for a straight band,
// so a band thinner than a pixel peaks at 2h instead of being widened to a pixel).
export function stripCoverage(d: number, h: number): number {
  return Math.min(1, Math.max(0, Math.min(d + 0.5, h) - Math.max(d - 0.5, -h)));
}
// Fraction of the pixel interval [x - 0.5, x + 0.5] inside [lo, hi].
export function spanCoverage(x: number, lo: number, hi: number): number {
  return Math.min(1, Math.max(0, Math.min(x + 0.5, hi) - Math.max(x - 0.5, lo)));
}
// Round caps, round joins and round dash caps are discs of radius h (device px). The band profile around a disc
// overstates its area by up to a third near h = 0.5 (pi/12 px^2 of ramp, plus the 2h peak for small discs), so the
// shader draws the band profile of an effective radius, scaled like a thin band, that holds exactly pi h^2.
export function discProfile(h: number): { radius: number; scale: number } {
  if (!(h > 0)) return { radius: 0, scale: 0 };
  const target = Math.PI * h * h;
  let lo = 0,
    hi = h;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (discArea(mid) < target) lo = mid;
    else hi = mid;
  }
  const radius = (lo + hi) / 2;
  return { radius, scale: Math.min(1, 2 * radius) };
}
// Integral of stripCoverage(r, a) * min(1, 2a) over the plane.
function discArea(a: number): number {
  const lo = Math.max(0, a - 0.5),
    hi = a + 0.5,
    peak = Math.min(1, 2 * a);
  // plateau (r < lo at full band value) plus the linear ramp from lo to hi, when a >= 0.5; for a < 0.5 the
  // plateau value is 2a out to 0.5 - a and the ramp runs from 0.5 - a to 0.5 + a
  const p0 = a >= 0.5 ? lo : 0.5 - a;
  const v0 = a >= 0.5 ? 1 : 2 * a;
  // integral of v(r) 2 pi r dr with v = v0 on [0, p0] and linear v0 -> 0 on [p0, hi]
  const plateau = v0 * Math.PI * p0 * p0;
  const w = hi - p0;
  const ramp = w > 0 ? (2 * Math.PI * v0 * ((hi * (hi * hi - p0 * p0)) / 2 - (hi ** 3 - p0 ** 3) / 3)) / w : 0;
  return (plateau + ramp) * peak;
}
export function discCoverage(r: number, h: number): number {
  const { radius, scale } = discProfile(h);
  return stripCoverage(r, radius) * scale;
}
// Old name kept for callers of the opaque-edge mirror: distance and half width in world units.
export function strokeEdgeCoverage(distWorld: number, halfWidthWorld: number, pxPerWorld: number): number {
  return stripCoverage(distWorld * pxPerWorld, halfWidthWorld * pxPerWorld);
}

// On-length of a normalized dash pattern (even length, starting with a dash) over [0, t), for any real t.
export function dashOnLength(t: number, dashes: ArrayLike<number>, count = dashes.length): number {
  let period = 0,
    on = 0;
  for (let i = 0; i < count; i++) {
    period += dashes[i];
    if (!(i & 1)) on += dashes[i];
  }
  if (!(period > 0)) return 0;
  const k = Math.floor(t / period);
  const r = t - k * period;
  let acc = 0,
    pos = 0;
  for (let i = 0; i < count; i++) {
    if (!(i & 1)) acc += Math.min(Math.max(r - pos, 0), dashes[i]);
    pos += dashes[i];
  }
  return k * on + acc;
}

// Box-filtered dash coverage along the path for butt dashes: the on-fraction of the pixel's footprint
// [t - 0.5 / px, t + 0.5 / px] (t and the pattern in world units, px device pixels per world unit).
export function dashAlongCoverage(t: number, dashes: ArrayLike<number>, px: number, count = dashes.length): number {
  const half = 0.5 / px;
  return Math.min(1, Math.max(0, (dashOnLength(t + half, dashes, count) - dashOnLength(t - half, dashes, count)) * px));
}

// Distance along the path from t to the nearest dash (0 inside a dash; zero-length dashes count as points). Round dash
// caps are discs of the stroke's half width around each dash end, as SVG draws them.
export function dashGap(t: number, dashes: ArrayLike<number>, count = dashes.length): number {
  let period = 0;
  for (let i = 0; i < count; i++) period += dashes[i];
  if (!(period > 0)) return 0;
  const r = t - Math.floor(t / period) * period;
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const run = dashes[i];
    if (r < pos + run || i === count - 1) {
      if (!(i & 1)) return 0;
      return Math.max(0, Math.min(r - pos, pos + run - r));
    }
    pos += run;
  }
  return 0;
}

// Square dash caps extend every dash by `ext` (half the stroke width) at both ends. Rewrites the pattern as butt dashes
// over the extended intervals, merging dashes whose gap closes, and returns the offset shift that keeps them in place.
// An empty result means the extended dashes cover the whole path (a solid stroke).
export function squareCapDashes(pattern: number[], ext: number): { dashes: number[]; shift: number; solid: boolean } {
  const n = pattern.length >> 1;
  if (!(ext > 0) || n === 0) return { dashes: pattern, shift: 0, solid: false };
  const on = Array.from({ length: n }, (_, i) => pattern[i * 2] + 2 * ext);
  const off = Array.from({ length: n }, (_, i) => pattern[i * 2 + 1] - 2 * ext);
  const start = off.findIndex(value => value > 0);
  if (start < 0) return { dashes: [], shift: 0, solid: true };
  // begin at the dash after the first gap that stays open, so a wrapped merge never splits the first dash
  const first = (start + 1) % n;
  let origin = 0;
  for (let i = 0; i < first; i++) origin += pattern[i * 2] + pattern[i * 2 + 1];
  const out: number[] = [];
  let run = 0;
  for (let k = 0; k < n; k++) {
    const i = (first + k) % n;
    run += on[i];
    if (off[i] > 0) {
      out.push(run, off[i]);
      run = 0;
    } else run += off[i];
  }
  return { dashes: out, shift: ext - origin, solid: false };
}

// Stroke end codes in the caps stream: open-path caps (capCode) 0 square, 1 butt, 2 round, and internal joins 3 round,
// 4 miter, 5 bevel. Each stream value packs the code with the neighbouring segment's direction angle at that end
// (code * 8 + angle + pi), which the shader needs to clip miter and bevel joins (shaders.ts `stroke`).
export const JOIN = { round: 3, miter: 4, bevel: 5 } as const;
export function joinCode(lineJoin = "miter"): number {
  return lineJoin === "round" ? JOIN.round : lineJoin === "bevel" ? JOIN.bevel : JOIN.miter;
}
export function packEnd(code: number, angle = 0): number {
  return code * 8 + angle + Math.PI;
}
export function unpackEnd(value: number): { code: number; angle: number } {
  const code = Math.floor(value / 8);
  return { code, angle: value - code * 8 - Math.PI };
}

// Fill anti-aliasing edges (framegraph fringe pass): every boundary edge of a fill, oriented so the filled side is on
// its left ((-dy, dx) normal), 4 floats each. Which side is filled comes from the winding number on each side of a
// ring (its own orientation plus the winding of the other rings at the midpoint of its first edge), so holes, islands and
// even-odd fills orient correctly as long as rings do not cross. Edges with fill on both sides or neither (nested
// same-direction nonzero rings) are internal and omitted. Past `maxWork` point-in-ring steps the other rings are
// ignored (each ring's own orientation decides), which is still right for nonzero fills with reversed holes.
export function appendFillEdges(subpaths: Subpath[], out: F32, evenOdd: boolean, maxWork = 4_000_000): number {
  const rings: { p: ArrayLike<number>; n: number; area: number; box: [number, number, number, number] }[] = [];
  for (const { points } of subpaths) {
    const n = points.length >> 1;
    if (n < 3) continue;
    let area = 0;
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      area += points[j * 2] * points[i * 2 + 1] - points[i * 2] * points[j * 2 + 1];
      box[0] = Math.min(box[0], points[i * 2]);
      box[1] = Math.min(box[1], points[i * 2 + 1]);
      box[2] = Math.max(box[2], points[i * 2]);
      box[3] = Math.max(box[3], points[i * 2 + 1]);
    }
    if (area !== 0 && Number.isFinite(area)) rings.push({ p: points, n, area, box });
  }
  let work = 0;
  let count = 0;
  const filled = (w: number) => (evenOdd ? (w & 1) !== 0 : w !== 0);
  for (let r = 0; r < rings.length; r++) {
    const { p, n, area } = rings[r];
    // the midpoint of the ring's first edge: a vertex is often shared with a touching ring, where the winding of the
    // other ring is ambiguous; an edge midpoint is ambiguous only on an edge the rings share
    let e = 0;
    while (e < n - 1 && p[e * 2] === p[e * 2 + 2] && p[e * 2 + 1] === p[e * 2 + 3]) e++;
    const f = (e + 1) % n;
    const x = (p[e * 2] + p[f * 2]) / 2,
      y = (p[e * 2 + 1] + p[f * 2 + 1]) / 2;
    let around = 0;
    if (rings.length > 1 && work <= maxWork)
      for (let o = 0; o < rings.length; o++) {
        if (o === r) continue;
        const other = rings[o];
        if (x < other.box[0] || x > other.box[2] || y < other.box[1] || y > other.box[3]) continue;
        work += other.n;
        around += windingNumber(x, y, other.p, other.n);
      }
    if (work > maxWork) around = 0;
    const left = filled(around + (area > 0 ? 1 : 0));
    const right = filled(around + (area > 0 ? 0 : -1));
    if (left === right) continue;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = p[i * 2],
        ay = p[i * 2 + 1],
        bx = p[j * 2],
        by = p[j * 2 + 1];
      if (ax === bx && ay === by) continue;
      if (left) out.push4(ax, ay, bx, by);
      else out.push4(bx, by, ax, ay);
      count++;
    }
  }
  return count;
}

// Whether two subpaths of a stroke share a segment (same endpoints, either direction), as the cell grid's neighbouring
// polygons do: blended, such a shared edge would draw twice as dark as SVG's single coverage mask (framegraph stroke).
export function hasSharedSegments(subpaths: Subpath[]): boolean {
  if (subpaths.length < 2) return false;
  const seen = new Map<string, number>();
  for (let s = 0; s < subpaths.length; s++) {
    const { points: p, closed } = subpaths[s];
    const n = p.length >> 1;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const j = (i + 1) % n;
      const a = `${p[i * 2]},${p[i * 2 + 1]}`,
        b = `${p[j * 2]},${p[j * 2 + 1]}`;
      if (a === b) continue;
      const key = a < b ? `${a} ${b}` : `${b} ${a}`;
      const owner = seen.get(key);
      if (owner !== undefined && owner !== s) return true;
      seen.set(key, s);
    }
  }
  return false;
}

// Whether a nonzero fill's winding might reach `depth` (8: past the 3-bit stencil counter, framegraph.ts windingBits).
// Necessary condition for that: `depth` rings of one orientation that all overlap at one point, so each of them has
// bounding boxes overlapping `depth - 1` others of its orientation. Conservative: true when the count runs past
// `maxWork` box tests.
export function mayWindDeep(subpaths: Subpath[], depth = 8, maxWork = 2_000_000): boolean {
  const boxes: [number[], number[]] = [[], []];
  for (const { points } of subpaths) {
    const n = points.length >> 1;
    if (n < 3) continue;
    let area = 0,
      x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      area += points[j * 2] * points[i * 2 + 1] - points[i * 2] * points[j * 2 + 1];
      x0 = Math.min(x0, points[i * 2]);
      y0 = Math.min(y0, points[i * 2 + 1]);
      x1 = Math.max(x1, points[i * 2]);
      y1 = Math.max(y1, points[i * 2 + 1]);
    }
    if (area !== 0) boxes[area > 0 ? 0 : 1].push(x0, y0, x1, y1);
  }
  let work = 0;
  for (const list of boxes) {
    const count = list.length / 4;
    if (count < depth) continue;
    const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => list[a * 4] - list[b * 4]);
    const overlaps = new Uint32Array(count);
    for (let a = 0; a < count; a++) {
      const i = order[a] * 4;
      for (let b = a + 1; b < count; b++) {
        const j = order[b] * 4;
        if (list[j] > list[i + 2]) break;
        if (++work > maxWork) return true;
        if (list[j + 1] <= list[i + 3] && list[i + 1] <= list[j + 3]) {
          if (++overlaps[order[a]] >= depth - 1 || ++overlaps[order[b]] >= depth - 1) return true;
        }
      }
    }
  }
  return false;
}

// Nonzero winding number of a closed ring around (x, y): +1 for each counter-clockwise turn in the shoelace sense.
export function windingNumber(x: number, y: number, p: ArrayLike<number>, n = p.length >> 1): number {
  let w = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = p[j * 2],
      ay = p[j * 2 + 1],
      bx = p[i * 2],
      by = p[i * 2 + 1];
    const side = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
    if (ay <= y) {
      if (by > y && side > 0) w++;
    } else if (by <= y && side < 0) w--;
  }
  return w;
}

// Bounds enclose every submitted path vertex, with conservative stroke padding. A curve's native geometry is the
// flattened polyline, so its vertices bound exactly what the GPU draws (compat effects remain uncullable here).
export function pathBounds(subpaths: Subpath[], pad = 0): [number, number, number, number] | null {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const path of subpaths)
    for (let i = 0; i + 1 < path.points.length; i += 2) {
      x0 = Math.min(x0, path.points[i]);
      y0 = Math.min(y0, path.points[i + 1]);
      x1 = Math.max(x1, path.points[i]);
      y1 = Math.max(y1, path.points[i + 1]);
    }
  return x0 <= x1 && y0 <= y1 ? [x0 - pad, y0 - pad, x1 + pad, y1 + pad] : null;
}

export function outsideView(
  bounds: [number, number, number, number],
  view: [number, number, number, number],
  pad = 0
): boolean {
  return (
    bounds[2] < view[0] - pad || bounds[0] > view[2] + pad || bounds[3] < view[1] - pad || bounds[1] > view[3] + pad
  );
}

// Per-segment end codes, aligned with appendSegments (zero-length edges skipped): open-path ends carry stroke-linecap
// (capCode), internal ends the join (joinCode) packed with the neighbouring segment's direction (packEnd).
export function appendStrokeCaps(subpaths: Subpath[], out: F32, lineJoin = "miter", lineCap = "butt"): number {
  let count = 0;
  const join = joinCode(lineJoin),
    cap = capCode(lineCap);
  for (const path of subpaths) {
    const p = path.points,
      n = p.length >> 1,
      segments: number[] = [];
    for (let i = 0; i < (path.closed ? n : n - 1); i++) {
      const j = (i + 1) % n;
      if (p[i * 2] !== p[j * 2] || p[i * 2 + 1] !== p[j * 2 + 1]) segments.push(i);
    }
    const angle = (i: number) => {
      const j = (i + 1) % n;
      return Math.atan2(p[j * 2 + 1] - p[i * 2 + 1], p[j * 2] - p[i * 2]);
    };
    const m = segments.length;
    for (let j = 0; j < m; j++) {
      const open = !path.closed;
      const start = open && j === 0 ? packEnd(cap) : packEnd(join, angle(segments[(j - 1 + m) % m]));
      const end = open && j === m - 1 ? packEnd(cap) : packEnd(join, angle(segments[(j + 1) % m]));
      out.push2(start, end);
      count++;
    }
  }
  return count;
}
