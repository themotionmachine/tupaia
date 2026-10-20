export interface Subpath {
  points: number[];
  closed: boolean;
}

const EPS = 1e-9;
const MAX_CURVE_SEGMENTS = 64;
const MAX_ARC_SEGMENTS = 128;
const MAX_SKIA_SEGMENTS = 256;

// Chrome's own curve flattening (flattenPath `skia`), for native geometry that must land on SVG's samples. Skia's GPU
// tessellation cuts a cubic into n chords uniform in t, n from Wang's formula at its precision 4 (1/4 device px):
// n = ceil(sqrt(3 M)), M the larger second difference of the control points in device px (a quadratic: sqrt(M)).
// A fill's curve patch rounds n up to a power of two (fixed-count tessellation). Fitted on Chrome's 4x MSAA samples
// (~/.tupaia-gates/w3b-stroke3/exp/wang.mjs, wangstroke.mjs): curved fill edges 99.6 % of pixels exact with the power
// of two, 86 % at a 0.3 px tolerance, 85-88 % for the true curve; curved strokes 88-92 % with ceil(sqrt(3 M)), 86-87 %
// at 0.3 px, 72-74 % for the true curve (the rest is the stroke tessellator's radial edges and true-normal offsets).
export interface SkiaFlattening {
  scale: number; // device px per world unit
  fill: boolean; // power-of-two segment counts (a fill), else plain (a stroke)
}
function skiaSegments(secondDifference: number, degreeTerm: number, rule: SkiaFlattening): number {
  let n = Math.max(1, Math.ceil(Math.sqrt(degreeTerm * 4 * secondDifference * rule.scale) - 1e-9));
  if (rule.fill) n = 2 ** Math.ceil(Math.log2(n));
  return Math.min(n, MAX_SKIA_SEGMENTS);
}

class Scanner {
  i = 0;
  constructor(readonly s: string) {}

  skipWsp() {
    const s = this.s;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12) this.i++;
      else break;
    }
  }

  skipCommaWsp() {
    this.skipWsp();
    if (this.s.charCodeAt(this.i) === 44) {
      this.i++;
      this.skipWsp();
    }
  }

  // parses a number at current position; returns NaN if none (position unchanged)
  number(): number {
    const s = this.s;
    const start = this.i;
    let j = start;
    let c = s.charCodeAt(j);
    if (c === 43 || c === 45) {
      j++;
      c = s.charCodeAt(j);
    }
    let digits = 0;
    while (c >= 48 && c <= 57) {
      j++;
      digits++;
      c = s.charCodeAt(j);
    }
    if (c === 46) {
      j++;
      c = s.charCodeAt(j);
      while (c >= 48 && c <= 57) {
        j++;
        digits++;
        c = s.charCodeAt(j);
      }
    }
    if (digits === 0) return NaN;
    if (c === 101 || c === 69) {
      let k = j + 1;
      let ec = s.charCodeAt(k);
      if (ec === 43 || ec === 45) {
        k++;
        ec = s.charCodeAt(k);
      }
      if (ec >= 48 && ec <= 57) {
        while (ec >= 48 && ec <= 57) {
          k++;
          ec = s.charCodeAt(k);
        }
        j = k;
      }
    }
    this.i = j;
    return Number(s.slice(start, j));
  }

  // arc flag: single '0' or '1' char
  flag(): number {
    const c = this.s.charCodeAt(this.i);
    if (c === 48 || c === 49) {
      this.i++;
      return c - 48;
    }
    return NaN;
  }

  // reads a number, optionally preceded by separators; NaN if invalid
  arg(): number {
    this.skipCommaWsp();
    return this.number();
  }
}

const COMMANDS = "MmLlHhVvCcSsQqTtAaZz";
const NUMBER_START = "+-.,0123456789";

const ARG_COUNT: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0
};

class Builder {
  out: Subpath[] = [];
  cur: number[] | null = null;
  closed = false;
  // current point and subpath start
  x = 0;
  y = 0;
  sx = 0;
  sy = 0;

  ensure() {
    if (!this.cur) {
      this.cur = [this.x, this.y];
      this.closed = false;
    }
  }

  push(x: number, y: number) {
    const p = this.cur as number[];
    const n = p.length;
    if (n >= 2 && Math.abs(p[n - 2] - x) < EPS && Math.abs(p[n - 1] - y) < EPS) {
      // duplicate consecutive point: skip
    } else {
      p.push(x, y);
    }
    this.x = x;
    this.y = y;
  }

  moveTo(x: number, y: number) {
    this.flush();
    this.cur = [x, y];
    this.closed = false;
    this.x = this.sx = x;
    this.y = this.sy = y;
  }

  flush() {
    const p = this.cur;
    if (p) {
      const n = p.length;
      if (this.closed && n >= 4 && Math.abs(p[0] - p[n - 2]) < EPS && Math.abs(p[1] - p[n - 1]) < EPS) {
        p.length -= 2;
      }
      if (p.length >= 4) this.out.push({ points: p, closed: this.closed });
    }
    this.cur = null;
    this.closed = false;
  }

  close() {
    if (this.cur) {
      this.closed = true;
      this.flush();
    }
    this.x = this.sx;
    this.y = this.sy;
  }
}

// adaptive cubic subdivision count from control polygon deviation
function cubicSegments(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  tol: number,
  skia?: SkiaFlattening
) {
  if (skia)
    return skiaSegments(
      Math.max(Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2), Math.hypot(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3)),
      0.75,
      skia
    );
  const ddx = Math.max(Math.abs(x0 - 2 * x1 + x2), Math.abs(x1 - 2 * x2 + x3));
  const ddy = Math.max(Math.abs(y0 - 2 * y1 + y2), Math.abs(y1 - 2 * y2 + y3));
  const dev = Math.sqrt(ddx * ddx + ddy * ddy);
  return clampInt(Math.ceil(Math.sqrt((dev * 0.75) / tol)), 1, MAX_CURVE_SEGMENTS);
}

function quadSegments(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  tol: number,
  skia?: SkiaFlattening
) {
  const dev = Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2);
  if (skia) return skiaSegments(dev, 0.25, skia);
  return clampInt(Math.ceil(Math.sqrt((dev * 0.25) / tol)), 1, MAX_CURVE_SEGMENTS);
}

function clampInt(v: number, lo: number, hi: number) {
  if (!(v >= lo)) return lo;
  return v > hi ? hi : v;
}

function cubicTo(
  b: Builder,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  tol: number,
  skia?: SkiaFlattening
) {
  const x0 = b.x;
  const y0 = b.y;
  const n = cubicSegments(x0, y0, x1, y1, x2, y2, x3, y3, tol, skia);
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const u = 1 - t;
    const a = u * u * u;
    const bb = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    b.push(a * x0 + bb * x1 + c * x2 + d * x3, a * y0 + bb * y1 + c * y2 + d * y3);
  }
}

function quadTo(b: Builder, x1: number, y1: number, x2: number, y2: number, tol: number, skia?: SkiaFlattening) {
  const x0 = b.x;
  const y0 = b.y;
  const n = quadSegments(x0, y0, x1, y1, x2, y2, tol, skia);
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const u = 1 - t;
    const a = u * u;
    const c = 2 * u * t;
    const d = t * t;
    b.push(a * x0 + c * x1 + d * x2, a * y0 + c * y1 + d * y2);
  }
}

function arcTo(
  b: Builder,
  rx: number,
  ry: number,
  angle: number,
  large: number,
  sweep: number,
  x2: number,
  y2: number,
  tol: number
) {
  const x1 = b.x;
  const y1 = b.y;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (x1 === x2 && y1 === y2) return;
  if (rx === 0 || ry === 0) {
    b.push(x2, y2);
    return;
  }
  const phi = (angle * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  // F.6.5.1
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cos * dx2 + sin * dy2;
  const y1p = -sin * dx2 + cos * dy2;
  // F.6.6.2 radii correction
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  let coef = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den));
  if (large === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  // F.6.5.5 / F.6.5.6
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = Math.atan2(uy, ux);
  let dtheta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  else if (sweep && dtheta < 0) dtheta += 2 * Math.PI;
  const rMax = Math.max(rx, ry);
  const n = clampInt(Math.ceil((Math.abs(dtheta) * Math.sqrt(rMax / tol)) / 2), 1, MAX_ARC_SEGMENTS);
  for (let k = 1; k <= n; k++) {
    const th = theta1 + (dtheta * k) / n;
    const ex = rx * Math.cos(th);
    const ey = ry * Math.sin(th);
    if (k === n) b.push(x2, y2);
    else b.push(cx + cos * ex - sin * ey, cy + sin * ex + cos * ey);
  }
}

/**
 * Flattens an SVG path `d` string into polylines. Never throws; stops at the first malformed token. `skia`: cut cubic
 * and quadratic curves into Chrome's own chords (SkiaFlattening) instead of to `tolerance` (arcs keep the tolerance).
 */
export function flattenPath(d: string, tolerance = 0.2, skia?: SkiaFlattening): Subpath[] {
  const sc = new Scanner(d);
  const b = new Builder();
  const tol = tolerance > 0 ? tolerance : 0.2;
  let cmd = "";
  // reflection control points for S/T
  let lastCtrlX = 0;
  let lastCtrlY = 0;
  let lastCmd = "";
  let first = true;
  for (;;) {
    sc.skipWsp();
    if (sc.i >= d.length) break;
    const ch = d[sc.i];
    if (COMMANDS.includes(ch)) {
      cmd = ch;
      sc.i++;
    } else if (cmd === "" || cmd === "Z" || cmd === "z" || !NUMBER_START.includes(ch)) {
      break;
    } else if (cmd === "M") {
      cmd = "L";
    } else if (cmd === "m") {
      cmd = "l";
    }
    if (first && cmd !== "M" && cmd !== "m") break;
    first = false;
    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;
    const n = ARG_COUNT[upper];
    if (upper === "Z") {
      b.close();
      lastCmd = "Z";
      sc.skipCommaWsp();
      continue;
    }
    const a: number[] = [];
    let ok = true;
    for (let k = 0; k < n; k++) {
      const isFlag = upper === "A" && (k === 3 || k === 4);
      if (isFlag) sc.skipCommaWsp();
      const v = isFlag ? sc.flag() : sc.arg();
      if (Number.isNaN(v)) {
        ok = false;
        break;
      }
      a.push(v);
    }
    if (!ok) break;
    const ox = rel ? b.x : 0;
    const oy = rel ? b.y : 0;
    if (upper === "M") {
      b.moveTo(a[0] + ox, a[1] + oy);
      lastCmd = "M";
    } else {
      b.ensure();
      if (upper === "L") b.push(a[0] + ox, a[1] + oy);
      else if (upper === "H") b.push(a[0] + (rel ? b.x : 0), b.y);
      else if (upper === "V") b.push(b.x, a[0] + (rel ? b.y : 0));
      else if (upper === "C") {
        const x1 = a[0] + ox,
          y1 = a[1] + oy,
          x2 = a[2] + ox,
          y2 = a[3] + oy;
        cubicTo(b, x1, y1, x2, y2, a[4] + ox, a[5] + oy, tol, skia);
        lastCtrlX = x2;
        lastCtrlY = y2;
      } else if (upper === "S") {
        const x1 = lastCmd === "C" || lastCmd === "S" ? 2 * b.x - lastCtrlX : b.x;
        const y1 = lastCmd === "C" || lastCmd === "S" ? 2 * b.y - lastCtrlY : b.y;
        const x2 = a[0] + ox,
          y2 = a[1] + oy;
        cubicTo(b, x1, y1, x2, y2, a[2] + ox, a[3] + oy, tol, skia);
        lastCtrlX = x2;
        lastCtrlY = y2;
      } else if (upper === "Q") {
        const x1 = a[0] + ox,
          y1 = a[1] + oy;
        quadTo(b, x1, y1, a[2] + ox, a[3] + oy, tol, skia);
        lastCtrlX = x1;
        lastCtrlY = y1;
      } else if (upper === "T") {
        const x1 = lastCmd === "Q" || lastCmd === "T" ? 2 * b.x - lastCtrlX : b.x;
        const y1 = lastCmd === "Q" || lastCmd === "T" ? 2 * b.y - lastCtrlY : b.y;
        quadTo(b, x1, y1, a[0] + ox, a[1] + oy, tol, skia);
        lastCtrlX = x1;
        lastCtrlY = y1;
      } else if (upper === "A") {
        arcTo(b, a[0], a[1], a[2], a[3], a[4], a[5] + ox, a[6] + oy, tol);
      }
      lastCmd = upper;
    }
  }
  b.flush();
  return b.out;
}

/** Returns [minX, minY, maxX, maxY] over all subpath points, or [0, 0, 0, 0] when empty. */
export function pathBounds(subpaths: Subpath[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sp of subpaths) {
    const p = sp.points;
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i];
      const y = p[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return minX === Infinity ? [0, 0, 0, 0] : [minX, minY, maxX, maxY];
}
