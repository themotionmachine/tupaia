// Skia-style contour measure for dashed stroke hit geometry (SkContourMeasure, as SkDashPath uses it).
// Chrome hit-tests an SVG stroke by dashing the path, then testing the dash outlines. The dash phase follows a chordal
// length: curves are measured by chords subdivided until flat at tolerance 0.5 / resScale (resScale = device px per
// world unit). Each dash is then cut from the true curve, so a route's exact curve is kept for the point test.
//
// A segment is its flat point list: [x0, y0, x1, y1] line, [.., x2, y2] quad, [.., x3, y3] cubic (start included).

import { flattenPath } from "./svg-path";

export type Segment = number[];
export interface Contour {
  segs: Segment[];
  closed: boolean;
}

const CHEAP_DIST_LIMIT = 0.5;
// Subdivision stops once a span is this small (Skia: tspan >> 10 with t in 2^30 units)
const MIN_SPAN = 2 ** -20;

interface Leaf {
  seg: number;
  t0: number;
  t1: number;
  d0: number; // distance from the contour start to the leaf start (chordal)
  len: number; // chord length
}

export interface Measure {
  contour: Contour;
  leaves: Leaf[];
  length: number;
  tolerance: number; // flatness each leaf was subdivided to (world units)
}

function pointAt(s: Segment, t: number): [number, number] {
  const u = 1 - t;
  if (s.length === 4) return [u * s[0] + t * s[2], u * s[1] + t * s[3]];
  if (s.length === 6) {
    const a = u * u,
      b = 2 * u * t,
      c = t * t;
    return [a * s[0] + b * s[2] + c * s[4], a * s[1] + b * s[3] + c * s[5]];
  }
  const a = u * u * u,
    b = 3 * u * u * t,
    c = 3 * u * t * t,
    d = t * t * t;
  return [
    a * s[0] + b * s[2] + c * s[4] + d * s[6],
    a * s[1] + b * s[3] + c * s[5] + d * s[7]
  ];
}

// Skia's cheap distance: Chebyshev, not Euclidean
const cheap = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

// Whether the curve (as a sub-curve of the segment) still deviates from its chord by more than tol.
function tooCurvy(s: Segment, tol: number): boolean {
  if (s.length === 4) return false;
  if (s.length === 6) {
    const dx = s[2] / 2 - (s[0] + s[4]) / 4;
    const dy = s[3] / 2 - (s[1] + s[5]) / 4;
    return Math.max(Math.abs(dx), Math.abs(dy)) > tol;
  }
  const [x0, y0, x1, y1, x2, y2, x3, y3] = s as [number, number, number, number, number, number, number, number];
  return (
    cheap(x1, y1, x0 + (x3 - x0) / 3, y0 + (y3 - y0) / 3) > tol ||
    cheap(x2, y2, x0 + (2 * (x3 - x0)) / 3, y0 + (2 * (y3 - y0)) / 3) > tol
  );
}

// de Casteljau split at t: [left, right] sub-curves of the same degree
function split(s: Segment, t: number): [Segment, Segment] {
  const lerp = (a: number, b: number) => a + (b - a) * t;
  if (s.length === 4) {
    const m = [lerp(s[0], s[2]), lerp(s[1], s[3])];
    return [[s[0], s[1], ...m], [...m, s[2], s[3]]];
  }
  if (s.length === 6) {
    const a = [lerp(s[0], s[2]), lerp(s[1], s[3])];
    const b = [lerp(s[2], s[4]), lerp(s[3], s[5])];
    const m = [lerp(a[0], b[0]), lerp(a[1], b[1])];
    return [
      [s[0], s[1], ...a, ...m],
      [...m, ...b, s[4], s[5]]
    ];
  }
  const a = [lerp(s[0], s[2]), lerp(s[1], s[3])];
  const b = [lerp(s[2], s[4]), lerp(s[3], s[5])];
  const c = [lerp(s[4], s[6]), lerp(s[5], s[7])];
  const d = [lerp(a[0], b[0]), lerp(a[1], b[1])];
  const e = [lerp(b[0], c[0]), lerp(b[1], c[1])];
  const m = [lerp(d[0], e[0]), lerp(d[1], e[1])];
  return [
    [s[0], s[1], ...a, ...d, ...m],
    [...m, ...e, ...c, s[6], s[7]]
  ];
}

// Subdivides one segment's parameter range into flat leaves, recording chord lengths in measure order.
function subdivide(seg: number, s: Segment, t0: number, t1: number, tol: number, leaves: Leaf[]): void {
  const flat = (cur: Segment, a: number, b: number) => {
    if (b - a < MIN_SPAN || !tooCurvy(cur, tol)) {
      const p0 = pointAt(s, a);
      const p1 = pointAt(s, b);
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      if (len > 0) leaves.push({ seg, t0: a, t1: b, d0: 0, len });
      return;
    }
    const mid = (a + b) / 2;
    const [left, right] = split(cur, 0.5);
    flat(left, a, mid);
    flat(right, mid, b);
  };
  flat(s, t0, t1);
}

// Chordal measure of a contour at tolerance 0.5 / resScale (device px per world unit).
export function measureContour(contour: Contour, resScale: number): Measure {
  const tol = CHEAP_DIST_LIMIT / (resScale > 0 ? resScale : 1);
  const leaves: Leaf[] = [];
  contour.segs.forEach((s, i) => subdivide(i, s, 0, 1, tol, leaves));
  let d = 0;
  for (const leaf of leaves) {
    leaf.d0 = d;
    d += leaf.len;
  }
  return { contour, leaves, length: d, tolerance: tol };
}

// Curve point at contour distance `dist`: the leaf's chord is interpolated linearly in t, as Skia's distanceToSegment.
export function pointAtDistance(m: Measure, dist: number): [number, number] {
  const leaf = m.leaves[leafIndex(m, dist)];
  return pointAt(m.contour.segs[leaf.seg], leafT(leaf, dist));
}

function leafIndex(m: Measure, dist: number): number {
  const { leaves } = m;
  let lo = 0;
  let hi = leaves.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (leaves[mid].d0 <= dist) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const leafT = (leaf: Leaf, dist: number) =>
  leaf.t0 + (leaf.t1 - leaf.t0) * Math.min(1, Math.max(0, (dist - leaf.d0) / leaf.len));

// Dash on-intervals of the contour as open polylines on the true curve (SkDashPath). The pattern restarts at each
// subpath; `tolerance` is the world-space chord error allowed inside a curve, so the polyline stays that close to it.
export function dashPieces(m: Measure, dashes: number[], offset: number, tolerance = 0.01): number[][] {
  const pattern = dashes.length % 2 === 1 ? [...dashes, ...dashes] : dashes;
  const period = pattern.reduce((sum, v) => sum + v, 0);
  if (!(period > 0) || pattern.some(v => v < 0) || m.length <= 0) return [];
  let i = 0;
  let phase = (((offset % period) + period) % period);
  // Skia's find_first_interval: a gap is passed when phase > gap, or phase == gap and the gap is nonzero, so a zero-length
  // on-dash at the phase start is kept (it is drawn as a dot).
  while (phase > pattern[i] || (phase === pattern[i] && pattern[i] > 0)) {
    phase -= pattern[i];
    i = (i + 1) % pattern.length;
  }
  let remaining = pattern[i] - phase;
  let on = i % 2 === 0;
  // SkDashPath: on a closed contour, a dash running across the start is one piece. The first dash is held back and
  // joined to the dash that reaches the end of the contour (or left as its own piece when none does).
  const seam = m.contour.closed && on;
  let head: number[] | null = null;
  let endsAtSeam = false;
  const pieces: number[][] = [];
  let d = 0;
  // walk the pattern: each interval spans [d, end]; on-intervals become one open dash piece
  while (d < m.length) {
    const end = Math.min(m.length, d + remaining);
    if (on) {
      const piece: number[] = [];
      pieceSamples(m, d, end, tolerance, piece);
      if (seam && d === 0) head = piece;
      else pieces.push(piece);
    }
    endsAtSeam = on && end === m.length;
    d = end;
    i = (i + 1) % pattern.length;
    remaining = pattern[i];
    on = i % 2 === 0;
  }
  if (!head) return pieces;
  if (endsAtSeam && pieces.length > 0) {
    // the head starts at the contour start, which the tail already ends on: drop the duplicate point
    const tail = pieces.pop() as number[];
    pieces.push([...tail, ...head.slice(2)]);
  } else pieces.unshift(head);
  return pieces;
}

// Samples the curve between contour distances a and b into `out` (flat x,y list): the dash ends sit where the measure
// puts them; in between, each leaf's t range is split evenly. A leaf is flat to the measure tolerance (Chebyshev), and
// a chord's error falls with the square of the split count, so sqrt(measure / tolerance) parts keep it within
// `tolerance` (lines need none). Cost is per leaf, not per unit length.
function pieceSamples(m: Measure, a: number, b: number, tolerance: number, out: number[]): void {
  const parts = Math.max(1, Math.ceil(Math.sqrt((2 * m.tolerance) / tolerance)));
  const first = leafIndex(m, a);
  const last = leafIndex(m, b);
  const start = pointAt(m.contour.segs[m.leaves[first].seg], leafT(m.leaves[first], a));
  out.push(start[0], start[1]);
  for (let i = first; i <= last; i++) {
    const leaf = m.leaves[i];
    const seg = m.contour.segs[leaf.seg];
    const t0 = i === first ? leafT(leaf, a) : leaf.t0;
    const t1 = i === last ? leafT(leaf, b) : leaf.t1;
    const n = seg.length === 4 ? 1 : parts;
    for (let k = 1; k <= n; k++) {
      const p = pointAt(seg, t0 + ((t1 - t0) * k) / n);
      out.push(p[0], p[1]);
    }
  }
}

const TOKEN = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

// Path data as curve segments in absolute coordinates (SVG2 §9). Smooth S/T reflect the previous control point. Arcs
// become fine line segments (their chordal dash length is then exact to `arcStep`, not the curve's own measure).
export function parseContours(d: string, arcStep = 0.001): Contour[] {
  const tokens = d.match(TOKEN) ?? [];
  const contours: Contour[] = [];
  let cur: Contour | null = null;
  let x = 0,
    y = 0,
    sx = 0,
    sy = 0,
    ctrlX = 0,
    ctrlY = 0,
    prev = "";
  let i = 0;
  let cmd = "";
  const num = () => Number(tokens[i++]);
  const open = () => {
    if (!cur) contours.push((cur = { segs: [], closed: false }));
  };
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) break;
    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    if (up === "Z") {
      if (cur) {
        cur.closed = true;
        if (x !== sx || y !== sy) cur.segs.push([x, y, sx, sy]);
      }
      cur = null;
      x = sx;
      y = sy;
      prev = "Z";
      cmd = ""; // a bare number after Z is malformed: stop instead of re-reading Z forever
      continue;
    }
    if (ARGS[up] === undefined || i + ARGS[up] > tokens.length) break;
    const args = Array.from({ length: ARGS[up] }, num);
    if (args.some(Number.isNaN)) break;
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    if (up === "M") {
      cur = { segs: [], closed: false };
      contours.push(cur);
      x = sx = args[0] + ox;
      y = sy = args[1] + oy;
      cmd = rel ? "l" : "L"; // subsequent pairs are implicit lineto
      prev = "M";
      continue;
    }
    open();
    let seg: number[] | null = null;
    if (up === "L") seg = [x, y, args[0] + ox, args[1] + oy];
    else if (up === "H") seg = [x, y, args[0] + (rel ? x : 0), y];
    else if (up === "V") seg = [x, y, x, args[0] + (rel ? y : 0)];
    else if (up === "C" || up === "S" || up === "Q" || up === "T") {
      // C: c1 c2 end · S: c2 end · Q: c end · T: end; the implicit first control point reflects the previous one
      const quad = up === "Q" || up === "T";
      const reflects = quad ? /^[QT]$/.test(prev) : /^[CS]$/.test(prev);
      const first = up === "C" || up === "Q" ? [args[0] + ox, args[1] + oy] : reflects ? [2 * x - ctrlX, 2 * y - ctrlY] : [x, y];
      const rest = up === "C" ? 4 : up === "T" ? 0 : 2;
      const end = [args[rest] + ox, args[rest + 1] + oy];
      if (quad) {
        seg = [x, y, first[0], first[1], end[0], end[1]];
        ctrlX = first[0];
        ctrlY = first[1];
      } else {
        const c2 = up === "C" || up === "S" ? [args[up === "C" ? 2 : 0] + ox, args[up === "C" ? 3 : 1] + oy] : first;
        seg = [x, y, first[0], first[1], c2[0], c2[1], end[0], end[1]];
        ctrlX = c2[0];
        ctrlY = c2[1];
      }
    }
    if (up === "A") {
      const [rx, ry, rot, large, sweep, ex, ey] = args;
      const d2 = `M${x} ${y}A${rx} ${ry} ${rot} ${large} ${sweep} ${ex + ox} ${ey + oy}`;
      const pts = flattenPath(d2, arcStep)[0]?.points ?? [];
      for (let k = 2; k + 1 < pts.length; k += 2) cur!.segs.push([pts[k - 2], pts[k - 1], pts[k], pts[k + 1]]);
      x = ex + ox;
      y = ey + oy;
    } else if (seg) {
      cur!.segs.push(seg);
      x = seg[seg.length - 2];
      y = seg[seg.length - 1];
    }
    prev = up;
  }
  return contours.filter(c => c.segs.length > 0);
}
