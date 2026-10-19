// Tessellate each simple ring independently, preserving its orientation. The existing stencil pass combines rings:
// opposite winding still cuts nonzero holes, and even-odd parity still handles overlapping/touching contours.
// Uncertain rings keep their original fans; neither topology nor the pick geometry is approximated.
import { appendFan, type F32 } from "./geometry";
import type { Subpath } from "./svg-path";
import { DEFAULT_TESSELLATION_LIMITS, tessellateFill } from "./tessellate";

export interface MeshStats {
  meshRings: number;
  fanRings: number;
  work: number;
  meshVertices: number;
  fanVertices: number;
  oldFanArea: number;
  meshArea: number;
  refusals: Record<string, number>;
}
export function newMeshStats(): MeshStats {
  return {
    meshRings: 0,
    fanRings: 0,
    work: 0,
    meshVertices: 0,
    fanVertices: 0,
    oldFanArea: 0,
    meshArea: 0,
    refusals: {}
  };
}
const FRAME_WORK = 2000000;

// A closed SVG walk may visit a vertex repeatedly where regions touch. Split only at exactly equal vertices.
// Its directed edges become cycles with the same total winding. Two-edge out-and-back spikes have zero fill area;
// real crossings away from a shared vertex still reach the conservative validator and retain the original fans.
export function splitTouchingWalk(path: Subpath): Subpath[] {
  const p = path.points,
    n = p.length >> 1;
  if (p.some(v => !Number.isFinite(v))) return [path];
  const stack: { x: number; y: number; key: string }[] = [],
    seen = new Map<string, number>(),
    cycles: Subpath[] = [];
  for (let i = 0; i <= n && n; i++) {
    const j = (i % n) * 2,
      x = p[j],
      y = p[j + 1],
      key = `${x},${y}`;
    const at = seen.get(key);
    if (at === undefined) {
      seen.set(key, stack.length);
      stack.push({ x, y, key });
      continue;
    }
    if (stack.length - at >= 3) {
      const points: number[] = [];
      for (let k = at; k < stack.length; k++) points.push(stack[k].x, stack[k].y);
      cycles.push({ points, closed: true });
    }
    for (let k = stack.length - 1; k > at; k--) seen.delete(stack[k].key);
    stack.length = at + 1;
  }
  return cycles;
}

export function appendStencilMeshes(subpaths: Subpath[], out: F32, stats: MeshStats): number {
  const first = out.length;
  for (const source of subpaths)
    for (const path of splitTouchingWalk(source)) {
      const remaining = FRAME_WORK - stats.work;
      const result =
        remaining > 0 ? tessellateFill([path], false, { ...DEFAULT_TESSELLATION_LIMITS, maxWork: remaining }) : null;
      if (!result?.ok) {
        const reason = result ? result.reason : "frame-work-budget";
        stats.refusals[reason] = (stats.refusals[reason] || 0) + 1;
        stats.work += result?.work || 0;
        stats.fanRings++;
        stats.fanVertices += appendFan([path], out);
        continue;
      }
      stats.work += result.diagnostics.work;
      stats.meshRings++;
      stats.meshVertices += result.vertexCount;
      stats.meshArea += result.diagnostics.area;
      const p = path.points;
      let area = 0;
      for (let i = 0, j = p.length - 2; i + 1 < p.length; j = i, i += 2) area += p[j] * p[i + 1] - p[i] * p[j + 1];
      for (let i = 2; i + 3 < p.length; i += 2)
        stats.oldFanArea += Math.abs((p[i] - p[0]) * (p[i + 3] - p[1]) - (p[i + 2] - p[0]) * (p[i + 1] - p[1])) / 2;
      const triangles = result.triangles;
      for (let i = 0; i < triangles.length; i += 6) {
        const cross =
          (triangles[i + 2] - triangles[i]) * (triangles[i + 5] - triangles[i + 1]) -
          (triangles[i + 4] - triangles[i]) * (triangles[i + 3] - triangles[i + 1]);
        out.push2(triangles[i], triangles[i + 1]);
        const swap = cross * area < 0;
        out.push2(triangles[i + (swap ? 4 : 2)], triangles[i + (swap ? 5 : 3)]);
        out.push2(triangles[i + (swap ? 2 : 4)], triangles[i + (swap ? 3 : 5)]);
      }
    }
  return (out.length - first) / 2;
}
