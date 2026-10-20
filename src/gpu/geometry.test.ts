import { describe, expect, it } from "vitest";
import {
  appendFan,
  appendFillEdges,
  appendSegments,
  appendStrokeCaps,
  capCode,
  cumulativeLengths,
  dashAlongCoverage,
  dashCovered,
  dashGap,
  dashOn,
  dashOnLength,
  discCoverage,
  F32,
  JOIN,
  joinCode,
  layoutOnPath,
  mayWindDeep,
  normalizeDashes,
  outsideView,
  packEnd,
  pathBounds,
  polylineLength,
  sampleAt,
  spanCoverage,
  squareCapDashes,
  stripCoverage,
  strokeEdgeCoverage,
  unpackEnd,
  windingNumber
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
  const codes = (view: Float32Array) => [...view].map(v => unpackEnd(v).code);
  expect(codes(caps.view())).toEqual([1, JOIN.round, JOIN.round, 1]);
  // each join carries the neighbouring segment's direction: the second segment heads +y, the first +x
  expect(unpackEnd(caps.view()[1]).angle).toBeCloseTo(Math.PI / 2, 5);
  expect(unpackEnd(caps.view()[2]).angle).toBeCloseTo(0, 5);
  const closed = new F32();
  appendStrokeCaps([{ points: [0, 0, 3, 0, 3, 4], closed: true }], closed, "round", "butt");
  expect(codes(closed.view())).toEqual([3, 3, 3, 3, 3, 3]);
  const miter = new F32();
  appendStrokeCaps([{ points: [0, 0, 3, 0, 3, 4], closed: false }], miter, "miter", "square");
  expect(codes(miter.view())).toEqual([0, JOIN.miter, JOIN.miter, 0]);
  const bevel = new F32();
  appendStrokeCaps([{ points: [0, 0, 3, 0, 3, 4], closed: false }], bevel, "bevel", "round");
  expect(codes(bevel.view())).toEqual([2, JOIN.bevel, JOIN.bevel, 2]);
});

describe("analytic stroke coverage (CPU mirror of the stroke shader)", () => {
  it("integrates a band's profile to its width, including bands thinner than a pixel", () => {
    for (const h of [0.1, 0.25, 0.5, 0.7, 1, 2.5]) {
      let sum = 0;
      // pixel centres at every 1/64 px offset across the band: mean coverage per unit length = band width
      for (let i = -400; i <= 400; i++) sum += stripCoverage(Math.abs(i / 64), h) / 64;
      expect(sum).toBeCloseTo(2 * h, 3);
    }
    expect(stripCoverage(0, 2)).toBe(1);
    expect(stripCoverage(2, 2)).toBeCloseTo(0.5, 12);
    expect(stripCoverage(2.5, 2)).toBe(0);
    expect(stripCoverage(0, 0.25)).toBeCloseTo(0.5, 12);
  });

  it("filters butt ends along the path and keeps a disc's area for small round caps", () => {
    expect(spanCoverage(0, 0, 10)).toBeCloseTo(0.5, 12);
    expect(spanCoverage(0.25, 0, 0.5)).toBeCloseTo(0.5, 12);
    expect(spanCoverage(-1, 0, 10)).toBe(0);
    for (const h of [0.2, 0.35, 0.5, 1.5]) {
      let sum = 0;
      for (let x = -40; x <= 40; x++)
        for (let y = -40; y <= 40; y++) sum += discCoverage(Math.hypot(x / 16, y / 16), h) / 256;
      // every disc keeps its area pi h^2, smaller than a pixel or not
      expect(sum / (Math.PI * h * h)).toBeGreaterThan(0.97);
      expect(sum / (Math.PI * h * h)).toBeLessThan(1.03);
    }
  });

  it("box-filters dashes along the path, sub-pixel patterns averaging to the duty cycle", () => {
    const pattern = [2, 2];
    expect(dashOnLength(0, pattern)).toBe(0);
    expect(dashOnLength(3, pattern)).toBe(2);
    expect(dashOnLength(9, pattern)).toBe(5);
    expect(dashOnLength(-1, pattern)).toBe(0);
    expect(dashOnLength(-3, pattern)).toBe(-1);
    // 4 px per unit: dash 8 px, gap 8 px; the pixel centred on the dash end is half covered
    expect(dashAlongCoverage(1, pattern, 4)).toBe(1);
    expect(dashAlongCoverage(3, pattern, 4)).toBe(0);
    expect(dashAlongCoverage(2, pattern, 4)).toBeCloseTo(0.5, 6);
    // 0.25 px per unit: the 4-unit period spans one pixel, every pixel averages the 50% duty
    for (const t of [0, 0.7, 1.9, 3.3]) expect(dashAlongCoverage(t, pattern, 0.25)).toBeCloseTo(0.5, 6);
  });

  it("measures the distance to the nearest dash, treating zero-length dashes as round-cap dot centres", () => {
    const dots = [0, 2, 0, 2];
    expect(dashGap(0.5, dots)).toBeCloseTo(0.5, 12);
    expect(dashGap(1.5, dots)).toBeCloseTo(0.5, 12);
    expect(dashGap(2, dots)).toBeCloseTo(0, 12);
    expect(dashGap(5, [1, 3])).toBeCloseTo(0, 12);
    expect(dashGap(6, [1, 3])).toBeCloseTo(1, 12);
  });

  it("turns square dash caps into extended butt dashes, merging dashes whose gap closes", () => {
    const sea = squareCapDashes([1, 2], 0.25);
    expect(sea.solid).toBe(false);
    expect(sea.dashes).toEqual([1.5, 1.5]);
    // the extended first dash starts ext before the original one
    expect(sea.shift).toBeCloseTo(0.25, 12);
    expect(squareCapDashes([1, 0.4], 0.25)).toEqual({ dashes: [], shift: 0, solid: true });
    const merged = squareCapDashes([1, 0.4, 1, 3], 0.25);
    expect(merged.dashes).toEqual([2.4 + 0.5, 2.5]);
    // same period, every original on-point is still on
    const period = merged.dashes.reduce((a, b) => a + b, 0);
    expect(period).toBeCloseTo(5.4, 12);
    for (const s of [0, 0.5, 1.5, 2, 2.3]) {
      const t = s + merged.shift;
      const r = ((t % period) + period) % period;
      expect(r < merged.dashes[0]).toBe(true);
    }
  });

  it("maps line joins to their codes and packs them with a direction", () => {
    expect(joinCode("round")).toBe(JOIN.round);
    expect(joinCode("bevel")).toBe(JOIN.bevel);
    expect(joinCode("miter")).toBe(JOIN.miter);
    expect(joinCode("miter-clip")).toBe(JOIN.miter);
    for (const angle of [-Math.PI + 1e-3, -1, 0, 2, Math.PI - 1e-3]) {
      const packed = Math.fround(packEnd(JOIN.bevel, angle));
      expect(unpackEnd(packed).code).toBe(JOIN.bevel);
      expect(unpackEnd(packed).angle).toBeCloseTo(angle, 5);
    }
  });
});

describe("appendFillEdges", () => {
  const square = (x: number, y: number, s: number, ccw = true): Subpath => ({
    points: ccw ? [x, y, x + s, y, x + s, y + s, x, y + s] : [x, y, x, y + s, x + s, y + s, x + s, y],
    closed: true
  });
  // the filled side of every edge must be its left: a point just left of each edge's midpoint is inside the fill
  const leftInside = (edges: Float32Array, inside: (x: number, y: number) => boolean) => {
    for (let i = 0; i < edges.length; i += 4) {
      const [ax, ay, bx, by] = [edges[i], edges[i + 1], edges[i + 2], edges[i + 3]];
      const len = Math.hypot(bx - ax, by - ay);
      const [nx, ny] = [-(by - ay) / len, (bx - ax) / len];
      const [mx, my] = [(ax + bx) / 2, (ay + by) / 2];
      expect(inside(mx + nx * 0.01, my + ny * 0.01)).toBe(true);
      expect(inside(mx - nx * 0.01, my - ny * 0.01)).toBe(false);
    }
  };

  it("orients both windings of a simple ring with the fill on the left", () => {
    for (const ccw of [true, false]) {
      const out = new F32();
      expect(appendFillEdges([square(0, 0, 4, ccw)], out, false)).toBe(4);
      leftInside(out.view(), (x, y) => x > 0 && x < 4 && y > 0 && y < 4);
    }
  });

  it("orients holes (reversed for nonzero, either way for even-odd) toward the filled ring between them", () => {
    const inside = (x: number, y: number) => x > 0 && x < 10 && y > 0 && y < 10 && !(x > 3 && x < 6 && y > 3 && y < 6);
    const nonzero = new F32();
    expect(appendFillEdges([square(0, 0, 10), square(3, 3, 3, false)], nonzero, false)).toBe(8);
    leftInside(nonzero.view(), inside);
    for (const ccw of [true, false]) {
      const evenOdd = new F32();
      expect(appendFillEdges([square(0, 0, 10), square(3, 3, 3, ccw)], evenOdd, true)).toBe(8);
      leftInside(evenOdd.view(), inside);
    }
  });

  it("omits internal edges where nonzero fills both sides, and degenerate or zero-area rings", () => {
    const out = new F32();
    // same-direction nested rings: winding 2 inside the inner one, still filled, so its edges are internal
    expect(appendFillEdges([square(0, 0, 10), square(3, 3, 3)], out, false)).toBe(4);
    expect(appendFillEdges([{ points: [0, 0, 1, 1], closed: true }], out, false)).toBe(0);
    expect(appendFillEdges([{ points: [0, 0, 2, 0, 4, 0], closed: true }], out, false)).toBe(0);
  });

  it("orients a ring that touches another at a vertex from an edge midpoint, not the shared vertex", () => {
    // a reversed (hole) triangle whose first vertex lies on the outer square's boundary
    const hole: Subpath = { points: [10, 4, 7, 2, 7, 6], closed: true };
    const inside = (x: number, y: number) =>
      x > 0 && x < 10 && y > 0 && y < 10 && !(x > 7 && Math.abs(y - 4) < (2 * (10 - x)) / 3);
    const out = new F32();
    expect(appendFillEdges([square(0, 0, 10), hole], out, false)).toBe(7);
    leftInside(out.view(), inside);
  });

  it("counts winding numbers with the shoelace orientation", () => {
    const ring = square(0, 0, 4).points;
    expect(windingNumber(2, 2, ring)).toBe(1);
    expect(windingNumber(5, 2, ring)).toBe(0);
    expect(windingNumber(2, 2, square(0, 0, 4, false).points)).toBe(-1);
  });
});

describe("mayWindDeep", () => {
  const square = (x: number, y: number, s: number, ccw = true): Subpath => ({
    points: ccw ? [x, y, x + s, y, x + s, y + s, x, y + s] : [x, y, x, y + s, x + s, y + s, x + s, y],
    closed: true
  });
  it("flags 8 stacked rings of one orientation, not 7, not 8 apart, not alternating ones", () => {
    const stack = (n: number, step = 0.1) => Array.from({ length: n }, (_, i) => square(i * step, i * step, 10));
    expect(mayWindDeep(stack(8))).toBe(true);
    expect(mayWindDeep(stack(7))).toBe(false);
    expect(mayWindDeep(stack(8, 20))).toBe(false);
    expect(mayWindDeep(Array.from({ length: 14 }, (_, i) => square(i, i, 30 - 2 * i, i % 2 === 0)))).toBe(false);
    expect(mayWindDeep(stack(8), 8, 3)).toBe(true); // out of work: conservative
  });
});
