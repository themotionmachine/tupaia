import { describe, expect, it } from "vitest";
import { flattenPath, pathBounds } from "./svg-path";

const pts = (d: string) => flattenPath(d)[0].points;

// distance from point to polyline (flat x,y array)
function distToPolyline(px: number, py: number, p: number[]) {
  let best = Infinity;
  for (let i = 0; i < p.length - 2; i += 2) {
    const ax = p[i];
    const ay = p[i + 1];
    const dx = p[i + 2] - ax;
    const dy = p[i + 3] - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx - px, ay + t * dy - py));
  }
  return best;
}

describe("flattenPath", () => {
  it("handles absolute and relative lines", () => {
    expect(pts("M0 0 L10 0 l0 10 L0 10")).toEqual([0, 0, 10, 0, 10, 10, 0, 10]);
  });

  it("handles H and V", () => {
    expect(pts("M0 0H10V10h-10v-10")).toEqual([0, 0, 10, 0, 10, 10, 0, 10, 0, 0]);
  });

  it("closes a square with Z without repeating the start point", () => {
    const [sp] = flattenPath("M0 0H10V10H0Z");
    expect(sp.closed).toBe(true);
    expect(sp.points).toEqual([0, 0, 10, 0, 10, 10, 0, 10]);
    const [sp2] = flattenPath("M0 0H10V10H0V0Z");
    expect(sp2.points).toEqual([0, 0, 10, 0, 10, 10, 0, 10]);
  });

  it("treats extra coordinate pairs after M as implicit lineto", () => {
    expect(pts("M0 0 10 0 10 10")).toEqual([0, 0, 10, 0, 10, 10]);
    expect(pts("m1 1 2 2")).toEqual([1, 1, 3, 3]);
  });

  it("parses packed and signed numbers", () => {
    expect(pts("M-.5.5L1 1")).toEqual([-0.5, 0.5, 1, 1]);
    expect(pts("M10-5L1-1")).toEqual([10, -5, 1, -1]);
    expect(pts("M0,0L10e-1,2")).toEqual([0, 0, 1, 2]);
    expect(pts("M0 0L1e-3 2")).toEqual([0, 0, 0.001, 2]);
  });

  it("parses packed arc flags", () => {
    const p = pts("M0 0a1 1 0 011 1");
    expect(p.slice(-2)).toEqual([1, 1]);
    expect(p.length).toBeGreaterThan(4);
  });

  it("flattens a semicircle onto its circle", () => {
    const p = pts("M0 0A5 5 0 0 1 10 0");
    expect(p.slice(0, 2)).toEqual([0, 0]);
    expect(p.slice(-2)).toEqual([10, 0]);
    expect(p.length / 2).toBeGreaterThan(3);
    for (let i = 0; i < p.length; i += 2) {
      expect(Math.abs(Math.hypot(p[i] - 5, p[i + 1]) - 5)).toBeLessThanOrEqual(0.2);
    }
  });

  it("treats an arc with zero radius as a line", () => {
    expect(pts("M0 0A0 5 0 0 1 10 0")).toEqual([0, 0, 10, 0]);
  });

  it("keeps cubic endpoints exact and stays within tolerance of the true curve", () => {
    const tol = 0.2;
    const p = flattenPath("M0 0C0 10 10 10 10 0", tol)[0].points;
    expect(p.slice(-2)).toEqual([10, 0]);
    for (let i = 0; i <= 200; i++) {
      const t = i / 200;
      const u = 1 - t;
      const x = 3 * u * t * t * 10 + t * t * t * 10;
      const y = 3 * u * u * t * 10 + 3 * u * t * t * 10;
      expect(distToPolyline(x, y, p)).toBeLessThanOrEqual(tol * 1.5);
    }
  });

  it("reflects the previous cubic control point for S", () => {
    const p = pts("M0 0C0 10 10 10 10 0S20 -10 20 0");
    expect(p.slice(-2)).toEqual([20, 0]);
    let minY = Infinity;
    for (let i = 1; i < p.length; i += 2) minY = Math.min(minY, p[i]);
    // reflected control (10,-10) gives a dip to y = -7.5; without reflection the dip is about -4.4
    expect(minY).toBeLessThan(-6);
  });

  it("handles Q and T, reflecting the quad control point for T", () => {
    const p = pts("M0 0Q5 10 10 0T20 0");
    expect(p.slice(-2)).toEqual([20, 0]);
    let minY = Infinity;
    for (let i = 1; i < p.length; i += 2) minY = Math.min(minY, p[i]);
    expect(minY).toBeLessThan(-4);
  });

  it("uses the current point as control for T after a non-quad command", () => {
    const p = pts("M0 0L10 0T20 0");
    expect(p.slice(-2)).toEqual([20, 0]);
    for (let i = 1; i < p.length; i += 2) expect(Math.abs(p[i])).toBeLessThan(1e-9);
  });

  it("drops consecutive duplicate points", () => {
    expect(pts("M0 0L0 0L5 5")).toEqual([0, 0, 5, 5]);
  });

  it("returns multiple subpaths, starting a new one after Z for a command without M", () => {
    const sps = flattenPath("M0 0L10 0L10 10Z L20 20 L30 20M5 5L6 6");
    expect(sps.length).toBe(3);
    expect(sps[0]).toEqual({ points: [0, 0, 10, 0, 10, 10], closed: true });
    expect(sps[1]).toEqual({ points: [0, 0, 20, 20, 30, 20], closed: false });
    expect(sps[2]).toEqual({ points: [5, 5, 6, 6], closed: false });
  });

  it("stops gracefully on malformed input", () => {
    expect(pts("M0 0 L10 10 L 5 x 99")).toEqual([0, 0, 10, 10]);
    expect(pts("M0 0 L10 10 Q")).toEqual([0, 0, 10, 10]);
    expect(flattenPath("L5 5")).toEqual([]);
    expect(flattenPath("")).toEqual([]);
    expect(flattenPath("hello")).toEqual([]);
    expect(() => flattenPath("M0 0 C 1 2 @ ~")).not.toThrow();
  });

  it("parses a d3 curveBasisClosed-like path", () => {
    const [sp] = flattenPath("M10,0C20,0,20,10,10,10C0,10,0,0,10,0Z");
    expect(sp.closed).toBe(true);
    expect(sp.points.slice(0, 2)).toEqual([10, 0]);
    const n = sp.points.length;
    expect(sp.points[n - 2] === 10 && sp.points[n - 1] === 0).toBe(false);
    const [minX, minY, maxX, maxY] = pathBounds([sp]);
    expect(minX).toBeGreaterThanOrEqual(0);
    expect(maxX).toBeLessThanOrEqual(20);
    expect(minY).toBeGreaterThanOrEqual(0);
    expect(maxY).toBeLessThanOrEqual(10 + 1e-9);
  });
});

describe("pathBounds", () => {
  it("returns min and max over all subpaths", () => {
    expect(
      pathBounds([
        { points: [0, 0, 10, -5, 3, 20], closed: false },
        { points: [-2, 4], closed: true }
      ])
    ).toEqual([-2, -5, 10, 20]);
  });

  it("returns zeros when empty", () => {
    expect(pathBounds([])).toEqual([0, 0, 0, 0]);
  });
});

it("screen-scaled tolerance keeps local cubic boundaries accurate across raster buckets", () => {
  for (const bucket of [1, 2, 4, 8, 16]) {
    const points = flattenPath("M0 0C0 4 4 4 4 0", 0.1 / bucket)[0].points;
    let worst = 0;
    for (let j = 0; j <= 1000; j++) {
      const t = j / 1000,
        u = 1 - t,
        x = 12 * u * t * t + 4 * t * t * t,
        y = 12 * u * u * t + 12 * u * t * t;
      let nearest = Infinity;
      for (let i = 0; i + 3 < points.length; i += 2) {
        const ax = points[i],
          ay = points[i + 1],
          dx = points[i + 2] - ax,
          dy = points[i + 3] - ay;
        const f = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
        nearest = Math.min(nearest, Math.hypot(x - ax - dx * f, y - ay - dy * f));
      }
      worst = Math.max(worst, nearest * bucket);
    }
    expect(worst).toBeLessThanOrEqual(0.101);
  }
});

describe("flattenPath with Skia's chord counts", () => {
  const count = (d: string, scale: number, fill: boolean) =>
    flattenPath(d, 0.2, { scale, fill })[0].points.length / 2 - 1;
  // Wang's formula at precision 4: n = ceil(sqrt(3/4 * 4 * M)) for a cubic with M the larger second difference in px
  it("splits a cubic into ceil(sqrt(3M)) chords for a stroke", () => {
    // second differences (0,30) and (0,-30): M = 30
    expect(count("M0 0C10 30 20 30 30 0", 1, false)).toBe(Math.ceil(Math.sqrt(3 * 30)));
    expect(count("M0 0C10 30 20 30 30 0", 4, false)).toBe(Math.ceil(Math.sqrt(3 * 120)));
  });

  it("rounds a fill's count up to a power of two", () => {
    expect(count("M0 0C10 30 20 30 30 0", 1, true)).toBe(16); // ceil(sqrt(90)) = 10
    expect(count("M0 0C10 30 20 30 30 0", 4, true)).toBe(32); // ceil(sqrt(360)) = 19
  });

  it("splits a quadratic into ceil(sqrt(M)) chords and keeps a straight curve in one", () => {
    // second difference (0,-40): n = ceil(sqrt(1/4 * 4 * 40))
    expect(count("M0 0Q10 20 20 0", 1, false)).toBe(Math.ceil(Math.sqrt(40)));
    expect(count("M0 0C10 0 20 0 30 0", 8, false)).toBe(1);
  });

  it("caps the count and keeps the end points", () => {
    expect(count("M0 0C0 1e6 1 1e6 1 0", 16, false)).toBe(256);
    const points = flattenPath("M0 0C10 30 20 30 30 0", 0.2, { scale: 2, fill: false })[0].points;
    expect([points[0], points[1], points[points.length - 2], points[points.length - 1]]).toEqual([0, 0, 30, 0]);
  });
});
