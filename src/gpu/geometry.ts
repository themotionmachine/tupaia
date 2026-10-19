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

// CPU mirror of the stroke shader's opaque edge coverage. distWorld is |v_local.y| (distance from the centreline in
// world units), halfWidthWorld the stroke half width, pxPerWorld device pixels per world unit. Full inside, zero at
// one device pixel beyond the edge, linear across the boundary pixel.
export function strokeEdgeCoverage(distWorld: number, halfWidthWorld: number, pxPerWorld: number): number {
  return Math.min(1, Math.max(0, (halfWidthWorld - distWorld) * pxPerWorld + 0.5));
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

// Per-segment endpoint geometry: 0 square, 1 butt, 2 round. Internal round ends form SVG round joins; open-path
// endpoints use stroke-linecap. Keep this stream aligned with appendSegments, including skipped zero-length edges.
export function appendStrokeCaps(subpaths: Subpath[], out: F32, lineJoin = "miter", lineCap = "butt"): number {
  let count = 0;
  const join = lineJoin === "round" ? 2 : 0,
    cap = capCode(lineCap);
  for (const path of subpaths) {
    const n = path.points.length >> 1,
      segments: number[] = [];
    for (let i = 0; i < (path.closed ? n : n - 1); i++) {
      const j = (i + 1) % n;
      if (path.points[i * 2] !== path.points[j * 2] || path.points[i * 2 + 1] !== path.points[j * 2 + 1])
        segments.push(i);
    }
    for (let j = 0; j < segments.length; j++) {
      out.push2(!path.closed && j === 0 ? cap : join, !path.closed && j === segments.length - 1 ? cap : join);
      count++;
    }
  }
  return count;
}
