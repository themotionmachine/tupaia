import { describe, expect, it } from "vitest";
import { type Contour, dashPieces, measureContour, parseContours, pointAtDistance } from "./dash-measure";

// Reference evaluation (de Casteljau) of a line, quad or cubic segment; independent of the module under test.
function bezier(s: number[], t: number): [number, number] {
  let p: number[][] = [];
  for (let i = 0; i < s.length; i += 2) p.push([s[i], s[i + 1]]);
  while (p.length > 1) p = p.slice(1).map((q, i) => [(1 - t) * p[i][0] + t * q[0], (1 - t) * p[i][1] + t * q[1]]);
  return [p[0][0], p[0][1]];
}

function refLength(s: number[], n = 20000): number {
  let len = 0;
  let prev = bezier(s, 0);
  for (let k = 1; k <= n; k++) {
    const p = bezier(s, k / n);
    len += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    prev = p;
  }
  return len;
}

// Cubic quarter circle of radius 100, from (100,0) counter-clockwise to (0,100)
const QUARTER: Contour = { segs: [[100, 0, 100, 55.2284749831, 55.2284749831, 100, 0, 100]], closed: false };
const LINE10: Contour = { segs: [[0, 0, 10, 0]], closed: false };

const ends = (points: number[]) => [points[0], points[1], points[points.length - 2], points[points.length - 1]];
const round = (v: number[]) => v.map(x => Math.round(x * 1e6) / 1e6);

describe("measureContour", () => {
  it("measures a line exactly", () => {
    expect(measureContour({ segs: [[0, 0, 3, 4]], closed: false }, 1).length).toBeCloseTo(5, 12);
  });

  it("keeps a straight cubic as one flat leaf", () => {
    const m = measureContour({ segs: [[0, 0, 10, 0, 20, 0, 30, 0]], closed: false }, 1);
    expect(m.leaves).toHaveLength(1);
    expect(m.length).toBeCloseTo(30, 12);
  });

  it("subdivides a curved cubic, and a finer resScale tracks the true arc length more closely", () => {
    const coarse = measureContour(QUARTER, 1);
    const fine = measureContour(QUARTER, 100);
    const ref = refLength(QUARTER.segs[0]);
    expect(fine.leaves.length).toBeGreaterThan(coarse.leaves.length);
    expect(Math.abs(fine.length - ref)).toBeLessThan(Math.abs(coarse.length - ref));
    expect(Math.abs(fine.length - ref)).toBeLessThan(0.01);
  });

  it("chords a quad to the true arc length at resScale 100", () => {
    const quad: Contour = { segs: [[0, 0, 50, 100, 100, 0]], closed: false };
    expect(measureContour(quad, 100).length).toBeCloseTo(refLength(quad.segs[0]), 1);
  });
});

describe("pointAtDistance", () => {
  it("interpolates along a line", () => {
    expect(pointAtDistance(measureContour(LINE10, 1), 2.5)[0]).toBeCloseTo(2.5, 12);
  });

  it("returns points on the curve at their chordal distance", () => {
    const m = measureContour(QUARTER, 100);
    for (const d of [0, 20, 80, 150]) {
      const [x, y] = pointAtDistance(m, d);
      // on the circle to the cubic's own radial error (about 0.03 units), at arc angle d / 100
      expect(Math.hypot(x, y)).toBeCloseTo(100, 1);
      expect(Math.atan2(y, x)).toBeCloseTo(d / 100, 2);
    }
  });
});

describe("dashPieces", () => {
  it("cuts the on-intervals of the pattern", () => {
    // on [0,2], off [2,5], on [5,7], off [7,10]
    const pieces = dashPieces(measureContour(LINE10, 1), [2, 3], 0);
    expect(pieces.map(ends).map(round)).toEqual([
      [0, 0, 2, 0],
      [5, 0, 7, 0]
    ]);
  });

  it("shifts the pattern by the dash offset, wrapping by the period", () => {
    const m = measureContour(LINE10, 1);
    // offset 1: on [0,1], on [4,6], on [9,10]
    const pieces = dashPieces(m, [2, 3], 1).map(ends).map(round);
    expect(pieces).toEqual([
      [0, 0, 1, 0],
      [4, 0, 6, 0],
      [9, 0, 10, 0]
    ]);
    expect(dashPieces(m, [2, 3], -4).map(ends).map(round)).toEqual(pieces);
  });

  it("doubles an odd pattern", () => {
    // [2] reads as [2,2]: on [0,2], [4,6], [8,10]
    const pieces = dashPieces(measureContour(LINE10, 1), [2], 0).map(ends).map(round);
    expect(pieces.map(p => p[0])).toEqual([0, 4, 8]);
  });

  it("restarts dashes by chordal distance along the true curve", () => {
    // dashes [50,50] on the radius-100 quarter circle: arc [0,50] and [100,150]
    const pieces = dashPieces(measureContour(QUARTER, 100), [50, 50], 0);
    expect(pieces).toHaveLength(2);
    // angle at arc length s is s / 100 up to the cubic's own angular error (about 1e-4 rad)
    const theta = (p: number[], k: number) => Math.atan2(p[k + 1], p[k]);
    expect(theta(pieces[0], pieces[0].length - 2)).toBeCloseTo(0.5, 2);
    expect(theta(pieces[1], 0)).toBeCloseTo(1, 2);
    expect(theta(pieces[1], pieces[1].length - 2)).toBeCloseTo(1.5, 2);
    const radial = pieces.flatMap(p =>
      Array.from({ length: p.length / 2 }, (_, k) => Math.abs(Math.hypot(p[2 * k], p[2 * k + 1]) - 100))
    );
    expect(Math.max(...radial)).toBeLessThan(0.05);
  });

  it("keeps a zero-length dash at the phase start as a dot (Skia find_first_interval)", () => {
    // dasharray 0 5 on the 10-unit line: dots at 0 and 5
    const pieces = dashPieces(measureContour(LINE10, 1), [0, 5], 0);
    expect(pieces.map(ends).map(round)).toEqual([
      [0, 0, 0, 0],
      [5, 0, 5, 0]
    ]);
  });

  it("joins an on-dash across a closed contour's start into one piece (SkDashPath skipFirstSegment)", () => {
    // square of perimeter 40, dashes [5,5] at offset 2: on [0,3], [8,13], [18,23], [28,33], [38,40] which runs into the start
    const square = parseContours("M0 0 L10 0 L10 10 L0 10 Z")[0];
    const pieces = dashPieces(measureContour(square, 1), [5, 5], 2).map(round);
    expect(pieces).toHaveLength(4);
    expect(pieces[3]).toEqual([0, 2, 0, 0, 3, 0]);
  });

  it("leaves the seam dash alone when the contour does not end on an on-dash", () => {
    const square = parseContours("M0 0 L10 0 L10 10 L0 10 Z")[0];
    // on [0,5], [10,15], [20,25], [30,35], then off to the end at 40
    const pieces = dashPieces(measureContour(square, 1), [5, 5], 0).map(round);
    expect(pieces).toHaveLength(4);
    expect(pieces[0]).toEqual([0, 0, 5, 0]);
    expect(pieces[3]).toEqual([0, 10, 0, 5]);
  });

  it("returns nothing for an empty, negative or zero pattern", () => {
    const m = measureContour(LINE10, 1);
    expect(dashPieces(m, [], 0)).toEqual([]);
    expect(dashPieces(m, [-1, 2], 0)).toEqual([]);
    expect(dashPieces(m, [0, 0], 0)).toEqual([]);
  });
});

describe("parseContours", () => {
  it("reads absolute and relative line commands alike, closing Z to the start", () => {
    const abs = parseContours("M0 0 L10 0 H20 V5 Z");
    const rel = parseContours("m0 0 l10 0 h10 v5 z");
    expect(abs).toEqual(rel);
    expect(abs).toHaveLength(1);
    expect(abs[0].closed).toBe(true);
    expect(abs[0].segs).toEqual([
      [0, 0, 10, 0],
      [10, 0, 20, 0],
      [20, 0, 20, 5],
      [20, 5, 0, 0]
    ]);
  });

  it("reads relative cubic commands", () => {
    expect(parseContours("M0 0 c0 10 10 10 10 0")[0].segs).toEqual([[0, 0, 0, 10, 10, 10, 10, 0]]);
  });

  it("reflects the previous cubic control point for S, absolute and relative alike", () => {
    const abs = parseContours("M0 0 C0 10 10 10 10 0 S20 -10 30 0")[0].segs;
    expect(abs[1]).toEqual([10, 0, 10, -10, 20, -10, 30, 0]);
    const rel = parseContours("M0 0 c0 10 10 10 10 0 s10 -10 20 0")[0].segs;
    expect(rel).toEqual(abs);
  });

  it("reflects the previous quadratic control point for T", () => {
    const segs = parseContours("M0 0 Q5 10 10 0 T20 0")[0].segs;
    expect(segs[1]).toEqual([10, 0, 15, -10, 20, 0]);
  });

  it("reads implicit lineto pairs and starts a contour at each M", () => {
    const contours = parseContours("M0 0 10 0 10 10 M5 5 L6 5");
    expect(contours.map(c => c.segs.length)).toEqual([2, 1]);
  });

  it("stops at a bare number after Z instead of looping", () => {
    expect(parseContours("M0 0 L10 0 Z 5 5")).toHaveLength(1);
  });

  it("flattens an arc onto its circle, with the true length", () => {
    // semicircle of radius 10 centred at (10,0)
    const segs = parseContours("M0 0 A10 10 0 0 1 20 0")[0].segs;
    const first = segs[0];
    const last = segs[segs.length - 1];
    expect(first[0]).toBeCloseTo(0, 9);
    expect(first[1]).toBeCloseTo(0, 9);
    expect(last[2]).toBeCloseTo(20, 9);
    expect(last[3]).toBeCloseTo(0, 9);
    for (const s of segs) expect(Math.hypot(s[0] - 10, s[1])).toBeCloseTo(10, 1);
    const length = segs.reduce((sum, s) => sum + Math.hypot(s[2] - s[0], s[3] - s[1]), 0);
    expect(length).toBeCloseTo(Math.PI * 10, 1);
  });
});
