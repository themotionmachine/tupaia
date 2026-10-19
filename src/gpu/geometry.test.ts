import { describe, expect, it } from "vitest";
import {
  appendFan,
  appendSegments,
  appendStrokeCaps,
  capCode,
  cumulativeLengths,
  dashCovered,
  dashOn,
  F32,
  layoutOnPath,
  normalizeDashes,
  outsideView,
  pathBounds,
  polylineLength,
  sampleAt,
  strokeEdgeCoverage
} from "./geometry";
import type { Subpath } from "./svg-path";

const signedArea = (v: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < v.length; i += 6) {
    const [ax, ay, bx, by, cx, cy] = [v[i], v[i + 1], v[i + 2], v[i + 3], v[i + 4], v[i + 5]];
    sum += ((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
  }
  return sum;
};

const polygonArea = (p: number[]): number => {
  let sum = 0;
  const n = p.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return sum / 2;
};

describe("F32", () => {
  it("grows beyond capacity and preserves contents", () => {
    const f = new F32(2);
    for (let i = 0; i < 100; i++) f.push2(i, -i - 1);
    expect(f.length).toBe(200);
    expect(f.data.length).toBeGreaterThanOrEqual(200);
    const v = f.view();
    expect(v.length).toBe(200);
    expect(v[0]).toBe(0);
    expect(v[1]).toBe(-1);
    expect(v[198]).toBe(99);
    expect(v[199]).toBe(-100);
  });

  it("grows from zero capacity and rejects invalid capacities", () => {
    const f = new F32(0);
    expect(f.data.length).toBe(0);
    f.push5(1, 2, 3, 4, 5);
    f.push2(6, 7);
    expect(Array.from(f.view())).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(f.data.length).toBeGreaterThanOrEqual(7);
    expect(() => new F32(-1)).toThrow(RangeError);
    expect(() => new F32(1.5)).toThrow(RangeError);
  });

  it("push3/push4/push5 write in order", () => {
    const f = new F32(1);
    f.push3(1, 2, 3);
    f.push4(4, 5, 6, 7);
    f.push5(8, 9, 10, 11, 12);
    expect(Array.from(f.view())).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe("appendFan", () => {
  it("emits n-2 triangles for a convex polygon with area equal to the polygon area", () => {
    const pts = [0, 0, 4, 0, 5, 3, 2, 5, -1, 3];
    const out = new F32();
    const verts = appendFan([{ points: pts, closed: true }], out);
    expect(verts).toBe(3 * 3);
    expect(out.length).toBe(verts * 2);
    expect(signedArea(out.view())).toBeCloseTo(polygonArea(pts), 4);
  });

  it("matches signed polygon area for a concave polygon", () => {
    const pts = [0, 0, 6, 0, 6, 6, 3, 2, 0, 6];
    const out = new F32();
    appendFan([{ points: pts, closed: true }], out);
    expect(signedArea(out.view())).toBeCloseTo(polygonArea(pts), 4);
    expect(polygonArea(pts)).toBeCloseTo(24, 6);
  });

  it("skips subpaths with fewer than 3 points", () => {
    const out = new F32();
    const verts = appendFan(
      [
        { points: [0, 0, 1, 1], closed: false },
        { points: [0, 0, 1, 0, 0, 1], closed: true }
      ],
      out
    );
    expect(verts).toBe(3);
  });
});

describe("appendSegments", () => {
  it("emits open segments with cumulative d0", () => {
    const out = new F32();
    const count = appendSegments([{ points: [0, 0, 3, 0, 3, 4], closed: false }], out);
    expect(count).toBe(2);
    expect(Array.from(out.view())).toEqual([0, 0, 3, 0, 0, 3, 0, 3, 4, 3]);
  });

  it("includes the closing segment for closed subpaths", () => {
    const out = new F32();
    const count = appendSegments([{ points: [0, 0, 3, 0, 3, 4], closed: true }], out);
    expect(count).toBe(3);
    const v = out.view();
    expect(Array.from(v.slice(10, 15))).toEqual([3, 4, 0, 0, 7]);
  });

  it("skips zero-length segments without advancing d0", () => {
    const out = new F32();
    const count = appendSegments([{ points: [1, 1, 1, 1, 4, 5], closed: false }], out);
    expect(count).toBe(1);
    expect(Array.from(out.view())).toEqual([1, 1, 4, 5, 0]);
  });

  it("restarts cumulative distance per subpath", () => {
    const out = new F32();
    const subpaths: Subpath[] = [
      { points: [0, 0, 10, 0, 10, 5], closed: false },
      { points: [0, 5, 0, 7], closed: false }
    ];
    const count = appendSegments(subpaths, out);
    expect(count).toBe(3);
    const v = out.view();
    expect(v[4]).toBe(0);
    expect(v[9]).toBe(10);
    expect(v[14]).toBe(0);
  });
});

describe("polyline helpers", () => {
  const L = [0, 0, 10, 0, 10, 10];

  it("computes total length and cumulative lengths", () => {
    expect(polylineLength(L)).toBeCloseTo(20, 9);
    expect(Array.from(cumulativeLengths(L))).toEqual([0, 10, 20]);
  });

  it("samples with linear interpolation and returns the segment tangent angle", () => {
    const cum = cumulativeLengths(L);
    const a = sampleAt(L, cum, 5);
    expect(a?.x).toBeCloseTo(5, 9);
    expect(a?.y).toBeCloseTo(0, 9);
    expect(a?.angle).toBeCloseTo(0, 9);

    const b = sampleAt(L, cum, 15);
    expect(b?.x).toBeCloseTo(10, 9);
    expect(b?.y).toBeCloseTo(5, 9);
    expect(b?.angle).toBeCloseTo(Math.PI / 2, 9);
  });

  it("returns null outside [0, total]", () => {
    const cum = cumulativeLengths(L);
    expect(sampleAt(L, cum, -0.1)).toBeNull();
    expect(sampleAt(L, cum, 20.1)).toBeNull();
    expect(sampleAt(L, cum, 20)).not.toBeNull();
  });

  it("writes into the provided out object", () => {
    const cum = cumulativeLengths(L);
    const out = { x: 0, y: 0, angle: 0 };
    const r = sampleAt(L, cum, 12, out);
    expect(r).toBe(out);
    expect(out.x).toBeCloseTo(10, 9);
    expect(out.y).toBeCloseTo(2, 9);
  });
});

describe("layoutOnPath", () => {
  it("centres a middle-anchored run symmetrically about the path midpoint", () => {
    const pts = [0, 0, 100, 0];
    const advances = [10, 10, 10, 10];
    const glyphs = layoutOnPath(pts, advances, 0.5, "middle");
    expect(glyphs.every(g => g.visible)).toBe(true);
    const first = glyphs[0].x;
    const last = glyphs[glyphs.length - 1].x;
    expect((first + last) / 2).toBeCloseTo(50, 9);
    expect(first).toBeCloseTo(35, 9);
    expect(last).toBeCloseTo(65, 9);
  });

  it("uses the tangent angle of the segment under each glyph", () => {
    const L = [0, 0, 10, 0, 10, 10];
    const glyphs = layoutOnPath(L, [4, 4], 0, "start");
    expect(glyphs[0].angle).toBeCloseTo(0, 9);
    expect(glyphs[1].angle).toBeCloseTo(0, 9);
    const later = layoutOnPath(L, [4, 4, 4], 0.5, "start");
    expect(later[2].angle).toBeCloseTo(Math.PI / 2, 9);
  });

  it("hides glyphs whose midpoint falls past the end of the path", () => {
    const pts = [0, 0, 20, 0];
    const glyphs = layoutOnPath(pts, [8, 8, 10], 0, "start");
    expect(glyphs.map(g => g.visible)).toEqual([true, true, false]);
    expect(glyphs[2].x).toBe(0);
    expect(glyphs[2].y).toBe(0);
  });

  it("hides glyphs whose midpoint falls before the start of the path", () => {
    const pts = [0, 0, 20, 0];
    const glyphs = layoutOnPath(pts, [10, 10], 0, "end");
    expect(glyphs.map(g => g.visible)).toEqual([false, false]);
  });
});

describe("normalizeDashes", () => {
  it("returns solid for empty, negative, or all-zero lists", () => {
    expect(normalizeDashes([])).toEqual([]);
    expect(normalizeDashes([3, -1])).toEqual([]);
    expect(normalizeDashes([0, 0])).toEqual([]);
    expect(normalizeDashes([0])).toEqual([]);
  });

  it("doubles odd-length lists and keeps even-length lists", () => {
    expect(normalizeDashes([3])).toEqual([3, 3]);
    expect(normalizeDashes([5, 2, 1])).toEqual([5, 2, 1, 5, 2, 1]);
    expect(normalizeDashes([4, 2])).toEqual([4, 2]);
  });
});

describe("dashCovered", () => {
  // searoutes: stroke-dasharray "1 2", stroke-linecap round, width 0.35
  const sea = [1, 2];
  const r = 0.175;
  it("caps every dash end like SVG: round discs, square extensions, butt nothing", () => {
    expect(capCode("round")).toBe(2);
    expect(capCode("square")).toBe(0);
    expect(capCode("butt")).toBe(1);
    expect(capCode()).toBe(1);
    // in the gap just after a dash end, on the centreline
    expect(dashCovered(1.1, 0, sea, 0, capCode("round"), r)).toBe(true);
    expect(dashCovered(1.1, 0, sea, 0, capCode("square"), r)).toBe(true);
    expect(dashCovered(1.1, 0, sea, 0, capCode("butt"), r)).toBe(false);
    // just before the next dash start (period wrap at 3)
    expect(dashCovered(2.9, 0, sea, 0, capCode("round"), r)).toBe(true);
    // round cap corner is outside the disc, square corner is inside the extension
    expect(dashCovered(1.15, 0.15, sea, 0, capCode("round"), r)).toBe(false);
    expect(dashCovered(1.15, 0.15, sea, 0, capCode("square"), r)).toBe(true);
    // mid-gap stays empty for every cap
    for (const cap of [0, 1, 2]) expect(dashCovered(2, 0, sea, 0, cap, r)).toBe(false);
  });
  it("matches dashOn inside dashes and for solid strokes, honouring the offset", () => {
    for (const s of [0, 0.5, 0.99, 3.2, 9.9]) expect(dashCovered(s, 0, sea, 0, 2, r)).toBe(dashOn(s, sea));
    expect(dashCovered(5, 0, [], 0, 1, r)).toBe(true);
    // offset 0.5 shifts the dash end to s = 0.5
    expect(dashCovered(0.6, 0, sea, 0.5, 2, r)).toBe(true);
    expect(dashCovered(0.6, 0, sea, 0.5, 1, r)).toBe(false);
  });
});

describe("strokeEdgeCoverage", () => {
  it("is fully covered inside the stroke and empty one device pixel beyond the edge", () => {
    // half width 2 world units at 2 device px per unit: edge at distance 2 from the centreline
    expect(strokeEdgeCoverage(0, 2, 2)).toBe(1);
    expect(strokeEdgeCoverage(1.75, 2, 2)).toBe(1);
    expect(strokeEdgeCoverage(2.25, 2, 2)).toBe(0);
    expect(strokeEdgeCoverage(2.5, 2, 2)).toBe(0);
  });

  it("is half covered when the pixel centre sits on the edge", () => {
    expect(strokeEdgeCoverage(2, 2, 2)).toBeCloseTo(0.5, 12);
  });

  it("varies linearly across the boundary pixel", () => {
    const quarter = strokeEdgeCoverage(2.125, 2, 2);
    const threeQuarter = strokeEdgeCoverage(1.875, 2, 2);
    expect(quarter).toBeCloseTo(0.25, 12);
    expect(threeQuarter).toBeCloseTo(0.75, 12);
  });
});

describe("dashOn", () => {
  it("alternates dash and gap for an even list", () => {
    const d = [4, 2];
    expect(dashOn(0, d)).toBe(true);
    expect(dashOn(3.9, d)).toBe(true);
    expect(dashOn(4, d)).toBe(false);
    expect(dashOn(5.9, d)).toBe(false);
    expect(dashOn(6, d)).toBe(true);
  });

  it("applies the offset to the phase", () => {
    const d = [4, 2];
    expect(dashOn(0, d, 4)).toBe(false);
    expect(dashOn(2, d, 4)).toBe(true);
    expect(dashOn(0, d, -2)).toBe(false);
  });

  it("treats odd lists as doubled ([3] means 3 on, 3 off)", () => {
    expect(dashOn(1, [3])).toBe(true);
    expect(dashOn(4, [3])).toBe(false);
    expect(dashOn(7, [3])).toBe(true);
  });

  it("is always on for solid strokes", () => {
    expect(dashOn(123, [])).toBe(true);
    expect(dashOn(5, [0, 0])).toBe(true);
  });
});

it("culls only paths wholly outside the viewport, including disconnected pieces and stroke reach", () => {
  const bounds = pathBounds(
    [
      { points: [-20, 5, -10, 5], closed: false },
      { points: [20, 5, 30, 5], closed: false }
    ],
    3
  )!;
  expect(bounds).toEqual([-23, 2, 33, 8]);
  expect(outsideView(bounds, [0, 0, 10, 10])).toBe(false);
  expect(outsideView(bounds, [34, 0, 40, 10], 1)).toBe(false);
  expect(outsideView(bounds, [35, 0, 40, 10], 1)).toBe(true);
  // A ring enclosing the view must stay, even with no vertices inside the view.
  const ring = pathBounds([{ points: [-10, -10, 20, -10, 20, 20, -10, 20], closed: true }])!;
  expect(outsideView(ring, [0, 0, 10, 10])).toBe(false);
  expect(pathBounds([])).toBeNull();
});

it("uses butt ends and round internal joins, with caps aligned past zero-length segments", () => {
  const paths: Subpath[] = [{ points: [0, 0, 0, 0, 3, 0, 3, 4], closed: false }];
  const out = new F32(),
    caps = new F32();
  expect(appendStrokeCaps(paths, caps, "round", "butt")).toBe(appendSegments(paths, out));
  expect([...caps.view()]).toEqual([1, 2, 2, 1]);
  const closed = new F32();
  appendStrokeCaps([{ points: [0, 0, 3, 0, 3, 4], closed: true }], closed, "round", "butt");
  expect([...closed.view()]).toEqual([2, 2, 2, 2, 2, 2]);
});
