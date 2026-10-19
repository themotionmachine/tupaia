import { describe, expect, it } from "vitest";
import type { Subpath } from "./svg-path";
import { tessellateFill } from "./tessellate";

const ring = (points: number[], closed = true): Subpath => ({ points, closed });
const square = (x: number, y: number, s: number, ccw = true): Subpath =>
  ring(ccw ? [x, y, x + s, y, x + s, y + s, x, y + s] : [x, y, x, y + s, x + s, y + s, x + s, y]);

// reference SVG fill: winding number over all subpaths (implicitly closed)
function referenceFilled(subpaths: Subpath[], evenOdd: boolean, x: number, y: number): boolean {
  let winding = 0;
  let crossings = 0;
  for (const { points: p } of subpaths)
    for (let i = 0, n = p.length, j = n - 2; i < n; j = i, i += 2) {
      const [x0, y0, x1, y1] = [p[j], p[j + 1], p[i], p[i + 1]];
      const side = (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0);
      if (y0 <= y !== y1 <= y) crossings += side !== 0 && x < x0 + ((y - y0) * (x1 - x0)) / (y1 - y0) ? 1 : 0;
      if (y0 <= y && y1 > y && side > 0) winding++;
      else if (y1 <= y && y0 > y && side < 0) winding--;
    }
  return evenOdd ? crossings % 2 === 1 : winding !== 0;
}

function coverCount(tris: Float32Array, x: number, y: number): number {
  let count = 0;
  for (let t = 0; t < tris.length; t += 6) {
    const s = (ax: number, ay: number, bx: number, by: number) => (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    const a = s(tris[t], tris[t + 1], tris[t + 2], tris[t + 3]);
    const b = s(tris[t + 2], tris[t + 3], tris[t + 4], tris[t + 5]);
    const c = s(tris[t + 4], tris[t + 5], tris[t], tris[t + 1]);
    if ((a > 0 && b > 0 && c > 0) || (a < 0 && b < 0 && c < 0)) count++;
  }
  return count;
}

// samples an irrational-offset grid (avoids edges) and checks exact single coverage against the reference
function expectMatchesReference(subpaths: Subpath[], evenOdd: boolean, box = [-1, -1, 21, 21]) {
  const result = tessellateFill(subpaths, evenOdd);
  if (!result.ok) throw new Error(`refused: ${result.reason} ${result.detail}`);
  let filled = 0;
  for (let i = 0; i < 40; i++)
    for (let j = 0; j < 40; j++) {
      const x = box[0] + ((i + 0.5 + Math.SQRT2 * 1e-3) * (box[2] - box[0])) / 40;
      const y = box[1] + ((j + 0.5 + Math.PI * 1e-3) * (box[3] - box[1])) / 40;
      const want = referenceFilled(subpaths, evenOdd, x, y) ? 1 : 0;
      expect(coverCount(result.triangles, x, y), `${x},${y}`).toBe(want);
      filled += want;
    }
  expect(filled).toBeGreaterThan(0);
  return result;
}

describe("tessellateFill", () => {
  it("triangulates a concave ring with exact area and single coverage", () => {
    const comb = ring([0, 0, 20, 0, 20, 20, 15, 20, 15, 5, 10, 5, 10, 20, 5, 20, 5, 5, 2, 5, 2, 20, 0, 20]);
    const result = expectMatchesReference([comb], false);
    if (result.ok) {
      expect(result.diagnostics.area).toBeCloseTo(400 - 5 * 15 - 3 * 15, 6);
      expect(result.vertexCount).toBe(result.diagnostics.triangles * 3);
    }
  });

  it("treats open subpaths as implicitly closed", () => {
    expectMatchesReference([ring([0, 0, 20, 0, 20, 20, 0, 20], false)], false);
  });

  it("opposite-winding hole is empty under both rules", () => {
    const paths = [square(0, 0, 20), square(5, 5, 10, false)];
    for (const evenOdd of [false, true]) {
      const r = expectMatchesReference(paths, evenOdd);
      if (r.ok) expect(r.diagnostics.area).toBeCloseTo(300, 6);
    }
  });

  it("same-winding hole is filled under nonzero and empty under evenodd", () => {
    const paths = [square(0, 0, 20), square(5, 5, 10)];
    const nonzero = expectMatchesReference(paths, false);
    const evenOdd = expectMatchesReference(paths, true);
    if (nonzero.ok && evenOdd.ok) {
      expect(nonzero.diagnostics.area).toBeCloseTo(400, 6);
      expect(evenOdd.diagnostics.area).toBeCloseTo(300, 6);
    }
  });

  it("handles nested islands and disjoint rings", () => {
    const paths = [
      square(0, 0, 12),
      square(2, 2, 8, false),
      square(4, 4, 4),
      square(14, 14, 5),
      square(14, 0, 4, false)
    ];
    for (const evenOdd of [false, true]) expectMatchesReference(paths, evenOdd);
    // same-direction nesting: nonzero keeps all depths filled, evenodd alternates
    const same = [square(0, 0, 12), square(2, 2, 8), square(4, 4, 4)];
    for (const evenOdd of [false, true]) expectMatchesReference(same, evenOdd);
  });

  it("returns an empty buffer for no usable rings", () => {
    const r = tessellateFill([ring([0, 0, 1, 1])], false);
    expect(r.ok && r.vertexCount).toBe(0);
  });

  it("refuses a zero-area bowtie before triangulation", () => {
    const r = tessellateFill([ring([0, 0, 10, 10, 10, 0, 0, 10])], false);
    expect(r.ok ? "" : r.reason).toBe("degenerate-ring");
  });
  it("refuses a crossing even when the ring has nonzero signed area", () => {
    const r = tessellateFill([ring([0, 0, 4, 4, 0, 4, 4, 0, 2, 5])], false);
    expect(r.ok ? "" : r.reason).toBe("self-intersection");
  });

  it("refuses a ring touching itself at a vertex", () => {
    const r = tessellateFill([ring([0, 0, 10, 0, 5, 5, 10, 10, 0, 10, 5, 5])], true);
    expect(r.ok ? "" : r.reason).toBe("self-intersection");
  });

  it("refuses spikes, crossing rings, touching rings and shared edges", () => {
    const reason = (paths: Subpath[]) => {
      const r = tessellateFill(paths, false);
      return r.ok ? "" : r.reason;
    };
    expect(reason([ring([0, 0, 10, 0, 10, 10, 10, 15, 10, 10, 0, 10])])).toBe("self-intersection");
    expect(reason([square(0, 0, 10), square(5, 5, 10)])).toBe("ring-contact");
    expect(reason([square(0, 0, 10), ring([10, 5, 15, 0, 15, 10])])).toBe("ring-contact");
    expect(reason([square(0, 0, 10), square(10, 0, 10)])).toBe("ring-contact");
    expect(reason([square(0, 0, 10), square(0, 0, 10)])).toBe("ring-contact");
    expect(reason([square(0, 0, 10), square(2, 0, 4, false)])).toBe("ring-contact");
  });

  it("refuses degenerate and nonfinite input", () => {
    const reason = (paths: Subpath[]) => {
      const r = tessellateFill(paths, false);
      return r.ok ? "" : r.reason;
    };
    expect(reason([ring([0, 0, 5, 0, 10, 0])])).toBe("degenerate-ring");
    expect(reason([ring([0, 0, 10, 0, Number.NaN, 10])])).toBe("nonfinite");
    expect(reason([ring([0, 0, 10, 0, 10, 10, 0, 10, 0, 1e-12])])).toBe("degenerate-edge");
  });

  it("refuses beyond configured limits instead of scanning unbounded", () => {
    const n = 2000;
    const circle: number[] = [];
    for (let i = 0; i < n; i++)
      circle.push(Math.cos((i / n) * 2 * Math.PI) * 100, Math.sin((i / n) * 2 * Math.PI) * 100);
    const ok = tessellateFill([ring(circle)], false);
    expect(ok.ok && ok.diagnostics.triangles).toBe(n - 2);
    const limited = (o: Partial<{ maxVertices: number; maxRings: number; maxWork: number }>) => {
      const r = tessellateFill([ring(circle)], false, { maxVertices: 20000, maxRings: 1024, maxWork: 2000000, ...o });
      return r.ok ? "" : r.reason;
    };
    expect(limited({ maxVertices: 1000 })).toBe("too-many-vertices");
    expect(limited({ maxWork: 100 })).toBe("budget-exceeded");
    expect(limited({ maxRings: 0 })).toBe("too-many-rings");
  });
});
