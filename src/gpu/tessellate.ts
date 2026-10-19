import { Earcut } from "three/src/extras/Earcut.js";
import type { Subpath } from "./svg-path";

// Conservative non-overlapping fill tessellation for simple SVG rings. Any uncertain topology is refused by name so
// the caller keeps the stencil-then-cover fan path, which remains the reference for every SVG fill.

export type TessellationRefusal =
  | "nonfinite"
  | "too-many-vertices"
  | "too-many-rings"
  | "degenerate-edge"
  | "degenerate-ring"
  | "self-intersection"
  | "ring-contact"
  | "budget-exceeded"
  | "triangulation-mismatch";

export interface TessellationLimits {
  maxVertices: number;
  maxRings: number;
  // upper bound on edge-pair candidates + point-in-ring edge tests
  maxWork: number;
}

export const DEFAULT_TESSELLATION_LIMITS: TessellationLimits = { maxVertices: 20000, maxRings: 1024, maxWork: 2000000 };

export interface TessellationDiagnostics {
  rings: number;
  filledFaces: number;
  inputVertices: number;
  triangles: number;
  work: number;
  // filled area (sum of absolute triangle areas)
  area: number;
}

export type TessellationResult =
  | { ok: true; triangles: Float32Array; vertexCount: number; diagnostics: TessellationDiagnostics }
  | { ok: false; reason: TessellationRefusal; detail: string; work: number };

interface Ring {
  points: number[];
  area: number;
  box: [number, number, number, number];
}

const refuse = (reason: TessellationRefusal, detail: string, work: number): TessellationResult => ({
  ok: false,
  reason,
  detail,
  work
});

function signedArea(p: number[]): number {
  let a = 0;
  for (let i = 0, n = p.length, j = n - 2; i < n; j = i, i += 2) a += p[j] * p[i + 1] - p[i] * p[j + 1];
  return a / 2;
}

function triangleArea(d: number[], a: number, b: number, c: number): number {
  return (
    ((d[b * 2] - d[a * 2]) * (d[c * 2 + 1] - d[a * 2 + 1]) - (d[c * 2] - d[a * 2]) * (d[b * 2 + 1] - d[a * 2 + 1])) / 2
  );
}

function insideRing(x: number, y: number, p: number[]): boolean {
  let inside = false;
  for (let i = 0, n = p.length, j = n - 2; i < n; j = i, i += 2) {
    const yi = p[i + 1];
    const yj = p[j + 1];
    if (yi > y !== yj > y && x < ((p[j] - p[i]) * (y - yi)) / (yj - yi) + p[i]) inside = !inside;
  }
  return inside;
}

/**
 * Triangulates a fill into non-overlapping triangles when every ring is simple, rings neither cross nor touch, and the
 * fill of each nesting face follows from the SVG rule. Open subpaths are implicitly closed like SVG fill; subpaths with
 * fewer than 3 distinct points contribute nothing (as with the fan path). Returns a refusal otherwise.
 */
export function tessellateFill(
  subpaths: Subpath[],
  evenOdd: boolean,
  limits: TessellationLimits = DEFAULT_TESSELLATION_LIMITS
): TessellationResult {
  const rings: Ring[] = [];
  let total = 0;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const sp of subpaths) {
    const src = sp.points;
    const p: number[] = [];
    for (let i = 0; i + 1 < src.length; i += 2) {
      const x = src[i];
      const y = src[i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return refuse("nonfinite", `subpath ${rings.length}`, 0);
      const n = p.length;
      if (n === 0 || p[n - 2] !== x || p[n - 1] !== y) p.push(x, y);
    }
    while (p.length >= 4 && p[0] === p[p.length - 2] && p[1] === p[p.length - 1]) p.length -= 2;
    if (p.length < 6) continue;
    total += p.length >> 1;
    if (total > limits.maxVertices) return refuse("too-many-vertices", `> ${limits.maxVertices}`, 0);
    if (rings.length >= limits.maxRings) return refuse("too-many-rings", `> ${limits.maxRings}`, 0);
    const box: Ring["box"] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 2) {
      box[0] = Math.min(box[0], p[i]);
      box[1] = Math.min(box[1], p[i + 1]);
      box[2] = Math.max(box[2], p[i]);
      box[3] = Math.max(box[3], p[i + 1]);
    }
    minX = Math.min(minX, box[0]);
    minY = Math.min(minY, box[1]);
    maxX = Math.max(maxX, box[2]);
    maxY = Math.max(maxY, box[3]);
    rings.push({ points: p, area: signedArea(p), box });
  }
  const empty = (): TessellationResult => ({
    ok: true,
    triangles: new Float32Array(0),
    vertexCount: 0,
    diagnostics: { rings: 0, filledFaces: 0, inputVertices: 0, triangles: 0, work: 0, area: 0 }
  });
  if (rings.length === 0) return empty();

  // scale-relative tolerances: near-degenerate configurations count as contact (refused), never as clearance
  const extent = Math.max(maxX - minX, maxY - minY, Math.abs(minX), Math.abs(minY), Math.abs(maxX), Math.abs(maxY));
  const posTol = extent * 1e-9;
  const areaTol = extent * extent * 1e-12;

  // edges as flat arrays: ring, index within ring
  const edgeRing = new Int32Array(total);
  const edgeIndex = new Int32Array(total);
  const ex0 = new Float64Array(total),
    ey0 = new Float64Array(total),
    ex1 = new Float64Array(total),
    ey1 = new Float64Array(total);
  let e = 0;
  for (let r = 0; r < rings.length; r++) {
    const p = rings[r].points;
    const n = p.length >> 1;
    if (Math.abs(rings[r].area) <= areaTol) return refuse("degenerate-ring", `ring ${r}`, 0);
    for (let i = 0; i < n; i++, e++) {
      const j = (i + 1) % n;
      const k = (i + 2) % n;
      const ax = p[i * 2],
        ay = p[i * 2 + 1],
        bx = p[j * 2],
        by = p[j * 2 + 1];
      if (Math.hypot(bx - ax, by - ay) <= posTol) return refuse("degenerate-edge", `ring ${r} edge ${i}`, 0);
      // adjacent edges only overlap when collinear and folding back (a spike)
      const cx = p[k * 2],
        cy = p[k * 2 + 1];
      const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(cross) <= areaTol && (bx - ax) * (cx - bx) + (by - ay) * (cy - by) < 0)
        return refuse("self-intersection", `ring ${r} spike at ${j}`, 0);
      edgeRing[e] = r;
      edgeIndex[e] = i;
      ex0[e] = ax;
      ey0[e] = ay;
      ex1[e] = bx;
      ey1[e] = by;
    }
  }

  // sweep by min x; every candidate pair with overlapping x-range counts toward the work budget
  const order = Array.from({ length: total }, (_, i) => i);
  const lo = (i: number) => Math.min(ex0[i], ex1[i]);
  order.sort((a, b) => lo(a) - lo(b));
  const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => {
    const o = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    return o > areaTol ? 1 : o < -areaTol ? -1 : 0;
  };
  const onSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number) =>
    px >= Math.min(ax, bx) - posTol &&
    px <= Math.max(ax, bx) + posTol &&
    py >= Math.min(ay, by) - posTol &&
    py <= Math.max(ay, by) + posTol;
  let work = 0;
  for (let oi = 0; oi < total; oi++) {
    const a = order[oi];
    const aHi = Math.max(ex0[a], ex1[a]) + posTol;
    const aYlo = Math.min(ey0[a], ey1[a]) - posTol;
    const aYhi = Math.max(ey0[a], ey1[a]) + posTol;
    for (let oj = oi + 1; oj < total; oj++) {
      const b = order[oj];
      if (lo(b) > aHi) break;
      if (++work > limits.maxWork) return refuse("budget-exceeded", `edge sweep > ${limits.maxWork}`, work);
      if (Math.max(ey0[b], ey1[b]) < aYlo || Math.min(ey0[b], ey1[b]) > aYhi) continue;
      const sameRing = edgeRing[a] === edgeRing[b];
      if (sameRing) {
        const n = rings[edgeRing[a]].points.length >> 1;
        const d = Math.abs(edgeIndex[a] - edgeIndex[b]);
        if (d === 1 || d === n - 1) continue;
      }
      const d1 = orient(ex0[b], ey0[b], ex1[b], ey1[b], ex0[a], ey0[a]);
      const d2 = orient(ex0[b], ey0[b], ex1[b], ey1[b], ex1[a], ey1[a]);
      const d3 = orient(ex0[a], ey0[a], ex1[a], ey1[a], ex0[b], ey0[b]);
      const d4 = orient(ex0[a], ey0[a], ex1[a], ey1[a], ex1[b], ey1[b]);
      const hit =
        (d1 === 0 && onSegment(ex0[a], ey0[a], ex0[b], ey0[b], ex1[b], ey1[b])) ||
        (d2 === 0 && onSegment(ex1[a], ey1[a], ex0[b], ey0[b], ex1[b], ey1[b])) ||
        (d3 === 0 && onSegment(ex0[b], ey0[b], ex0[a], ey0[a], ex1[a], ey1[a])) ||
        (d4 === 0 && onSegment(ex1[b], ey1[b], ex0[a], ey0[a], ex1[a], ey1[a])) ||
        (d1 * d2 < 0 && d3 * d4 < 0);
      if (hit)
        return refuse(
          sameRing ? "self-intersection" : "ring-contact",
          `ring ${edgeRing[a]} edge ${edgeIndex[a]} / ring ${edgeRing[b]} edge ${edgeIndex[b]}`,
          work
        );
    }
  }

  // boundaries are disjoint, so nesting is a forest: a ring's first vertex decides containment
  const byArea = rings.map((_, i) => i).sort((a, b) => Math.abs(rings[b].area) - Math.abs(rings[a].area));
  const parent = new Int32Array(rings.length).fill(-1);
  const winding = new Int32Array(rings.length);
  const depth = new Int32Array(rings.length);
  for (let k = 0; k < byArea.length; k++) {
    const r = byArea[k];
    const { box, points } = rings[r];
    // the smallest container is the last containing ring in descending-area order
    for (let m = k - 1; m >= 0; m--) {
      const c = byArea[m];
      const cb = rings[c].box;
      if (box[0] < cb[0] || box[1] < cb[1] || box[2] > cb[2] || box[3] > cb[3]) continue;
      work += rings[c].points.length >> 1;
      if (work > limits.maxWork) return refuse("budget-exceeded", `nesting > ${limits.maxWork}`, work);
      if (insideRing(points[0], points[1], rings[c].points)) {
        parent[r] = c;
        break;
      }
    }
    const pr = parent[r];
    winding[r] = (pr < 0 ? 0 : winding[pr]) + Math.sign(rings[r].area);
    depth[r] = (pr < 0 ? 0 : depth[pr]) + 1;
  }

  const children: number[][] = rings.map(() => []);
  for (let r = 0; r < rings.length; r++) if (parent[r] >= 0) children[parent[r]].push(r);
  const out: number[] = [];
  let filledFaces = 0;
  let filledArea = 0;
  for (let r = 0; r < rings.length; r++) {
    // face = inside r, outside its direct children; its winding is constant
    const filled = evenOdd ? depth[r] % 2 === 1 : winding[r] !== 0;
    if (!filled) continue;
    filledFaces++;
    const data = rings[r].points.slice();
    const holes: number[] = [];
    let expected = Math.abs(rings[r].area);
    for (const c of children[r]) {
      holes.push(data.length >> 1);
      for (const v of rings[c].points) data.push(v);
      expected -= Math.abs(rings[c].area);
    }
    const idx = Earcut.triangulate(data, holes, 2);
    let got = 0;
    for (let t = 0; t < idx.length; t += 3) {
      got += Math.abs(triangleArea(data, idx[t], idx[t + 1], idx[t + 2]));
      for (let v = 0; v < 3; v++) out.push(data[idx[t + v] * 2], data[idx[t + v] * 2 + 1]);
    }
    if (Math.abs(got - expected) > Math.max(areaTol, Math.abs(rings[r].area) * 1e-9))
      return refuse("triangulation-mismatch", `ring ${r}: area ${got} vs ${expected}`, work);
    filledArea += got;
  }
  return {
    ok: true,
    triangles: new Float32Array(out),
    vertexCount: out.length >> 1,
    diagnostics: {
      rings: rings.length,
      filledFaces,
      inputVertices: total,
      triangles: out.length / 6,
      work,
      area: filledArea
    }
  };
}
