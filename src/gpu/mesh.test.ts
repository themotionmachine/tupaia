import { expect, it } from "vitest";
import { appendFan, F32, outsideView, pathBounds } from "./geometry";
import { appendStencilMeshes, newMeshStats } from "./mesh";
import type { Subpath } from "./svg-path";

const ring = (points: number[]): Subpath => ({ points, closed: true });
const reverse = (p: number[]): number[] => {
  const out: number[] = [];
  for (let i = p.length - 2; i >= 0; i -= 2) out.push(p[i], p[i + 1]);
  return out;
};
function winding(triangles: Float32Array, x: number, y: number): number {
  let result = 0;
  for (let i = 0; i < triangles.length; i += 6) {
    const a = [triangles[i], triangles[i + 1]],
      b = [triangles[i + 2], triangles[i + 3]],
      c = [triangles[i + 4], triangles[i + 5]];
    const cross = (p: number[], q: number[], r: number[]) =>
      (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const v = [cross(a, b, [x, y]), cross(b, c, [x, y]), cross(c, a, [x, y])];
    if (v.every(n => n > 0) || v.every(n => n < 0)) result += Math.sign(cross(a, b, c));
  }
  return result;
}
it("preserves stencil winding and parity across concavity, holes, islands and crossing contours", () => {
  const square = [0, 0, 10, 0, 10, 10, 0, 10];
  for (const paths of [
    [ring([0, 0, 10, 0, 10, 10, 7, 10, 7, 3, 3, 3, 3, 10, 0, 10])],
    [ring(square), ring(reverse([2, 2, 8, 2, 8, 8, 2, 8])), ring([4, 4, 6, 4, 6, 6, 4, 6])],
    [ring(square), ring([5, -2, 15, -2, 15, 5, 5, 5]), ring([20, 0, 24, 0, 24, 4, 20, 4])],
    [ring(square), ring([2, 2, 8, 2, 8, 8, 2, 8])]
  ]) {
    const old = new F32(),
      mesh = new F32(),
      stats = newMeshStats();
    appendFan(paths, old);
    appendStencilMeshes(paths, mesh, stats);
    expect(stats.fanRings).toBe(0);
    for (let x = -1.637; x < 25; x += 0.931)
      for (let y = -2.419; y < 12; y += 0.793) {
        const a = winding(old.view(), x, y),
          b = winding(mesh.view(), x, y);
        expect(b).toBe(a);
        expect(Math.abs(b) % 2).toBe(Math.abs(a) % 2);
      }
  }
});
it("keeps uncertain self-intersections on the original fan path", () => {
  const paths = [ring([0, 0, 10, 10, 0, 10, 10, 0])],
    old = new F32(),
    mesh = new F32(),
    stats = newMeshStats();
  appendFan(paths, old);
  appendStencilMeshes(paths, mesh, stats);
  expect(stats.fanRings).toBe(1);
  expect([...mesh.view()]).toEqual([...old.view()]);
});

it("decomposes touching loops and zero-area spikes without changing either SVG fill rule", () => {
  for (const path of [
    ring([0, 0, 4, 0, 4, 4, 0, 0, -4, 0, -4, -4]),
    ring([0, 0, 10, 0, 10, 10, 15, 15, 10, 10, 0, 10])
  ]) {
    const old = new F32(),
      mesh = new F32(),
      stats = newMeshStats();
    appendFan([path], old);
    appendStencilMeshes([path], mesh, stats);
    expect(stats.fanRings).toBe(0);
    for (let x = -5.637; x < 16; x += 0.931)
      for (let y = -5.419; y < 16; y += 0.793) expect(winding(mesh.view(), x, y)).toBe(winding(old.view(), x, y));
  }
});

// FrameGraph culls fill batches and group mask items by pathBounds: exact only if every stencil triangle, meshed or
// fan fallback, stays inside those bounds, so an item outside the view covers no on-screen pixel.
it("keeps every stencil vertex inside the path bounds used for view culling", () => {
  for (const paths of [
    [ring([0, 0, 10, 0, 10, 10, 7, 10, 7, 3, 3, 3, 3, 10, 0, 10])],
    [ring([0, 0, 10, 0, 10, 10, 0, 10]), ring([20, 0, 24, 0, 24, 4, 20, 4])],
    [ring([0, 0, 10, 10, 0, 10, 10, 0])],
    [ring([0, 0, 4, 0, 4, 4, 0, 0, -4, 0, -4, -4])]
  ]) {
    const mesh = new F32(),
      stats = newMeshStats();
    appendStencilMeshes(paths, mesh, stats);
    const [minX, minY, maxX, maxY] = pathBounds(paths)!;
    const v = mesh.view();
    expect(v.length).toBeGreaterThan(0);
    for (let i = 0; i < v.length; i += 2) {
      expect(v[i]).toBeGreaterThanOrEqual(minX);
      expect(v[i]).toBeLessThanOrEqual(maxX);
      expect(v[i + 1]).toBeGreaterThanOrEqual(minY);
      expect(v[i + 1]).toBeLessThanOrEqual(maxY);
    }
    expect(outsideView(pathBounds(paths)!, [maxX + 2, minY, maxX + 10, maxY], 1)).toBe(true);
  }
});
