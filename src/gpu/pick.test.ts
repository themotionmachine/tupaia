import { describe, expect, it } from "vitest";
import { PICK_TOLERANCE } from "./compat-pick";
import { dashPieces, measureContour } from "./dash-measure";
import {
  END_SLACK,
  insideRings,
  PickIndex,
  polylineCovers,
  polylineDistance,
  type StrokeCap,
  segmentDistance,
  squareMeetsConvex,
  strokeCovers,
  windingNumber
} from "./pick";
import { flattenPath } from "./svg-path";

const CCW_SQUARE = [0, 0, 1, 0, 1, 1, 0, 1];
const CW_SQUARE = [0, 0, 0, 1, 1, 1, 1, 0];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("windingNumber", () => {
  it("returns +1 for CCW and -1 for CW square", () => {
    expect(windingNumber(0.5, 0.5, CCW_SQUARE)).toBe(1);
    expect(windingNumber(0.5, 0.5, CW_SQUARE)).toBe(-1);
    expect(windingNumber(2, 2, CCW_SQUARE)).toBe(0);
  });

  it("counts a self-overlapping ring traversed twice as 2", () => {
    const twice = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1];
    expect(windingNumber(0.5, 0.5, twice)).toBe(2);
  });
});

describe("insideRings", () => {
  const outer = [0, 0, 10, 0, 10, 10, 0, 10];
  const hole = [3, 3, 7, 3, 7, 7, 3, 7];

  it("nonzero fills a same-orientation hole", () => {
    expect(insideRings(5, 5, [outer, hole], false)).toBe(true);
    expect(insideRings(1, 1, [outer, hole], false)).toBe(true);
  });

  it("evenodd leaves a same-orientation hole empty", () => {
    expect(insideRings(5, 5, [outer, hole], true)).toBe(false);
    expect(insideRings(1, 1, [outer, hole], true)).toBe(true);
  });

  it("handles a concave U shape", () => {
    const u = [0, 0, 3, 0, 3, 3, 2, 3, 2, 1, 1, 1, 1, 3, 0, 3];
    expect(insideRings(0.5, 2, [u], false)).toBe(true);
    expect(insideRings(2.5, 2, [u], false)).toBe(true);
    expect(insideRings(1.5, 0.5, [u], false)).toBe(true);
    expect(insideRings(1.5, 2, [u], false)).toBe(false);
  });
});

describe("distances", () => {
  it("segmentDistance clamps to endpoints and handles degenerate segments", () => {
    expect(segmentDistance(5, 3, 0, 0, 10, 0)).toBeCloseTo(3);
    expect(segmentDistance(-3, 4, 0, 0, 10, 0)).toBeCloseTo(5);
    expect(segmentDistance(3, 4, 0, 0, 0, 0)).toBeCloseTo(5);
  });

  it("polylineDistance honours the closed flag", () => {
    const square = [0, 0, 10, 0, 10, 10, 0, 10];
    expect(polylineDistance(0, 5, square, true)).toBeCloseTo(0);
    expect(polylineDistance(0, 5, square, false)).toBeCloseTo(5);
  });
});

describe("PickIndex", () => {
  it("picks strokes within halfWidth and misses outside", () => {
    const index = new PickIndex(100, 100);
    index.addStroke("l", "line", [[0, 0, 10, 0]], [false], 1);
    expect(index.pick(5, 0.9)?.id).toBe("line");
    expect(index.pick(5, 1.1)).toBeNull();
    expect(index.pick(5, 1.1, 0.2)?.id).toBe("line");
  });

  it("thin curved strokes need the fine pick flattening, not the 0.2 paint chords", () => {
    // a cubic route 0.1 wide: points on the true curve lie up to the chord error off a 0.2-flattened polyline
    const d = "M0,0 C30,60 70,-60 100,0";
    const curve = (t: number) => {
      const u = 1 - t;
      return [3 * u * u * t * 30 + 3 * u * t * t * 70 + t ** 3 * 100, 3 * u * u * t * 60 - 3 * u * t * t * 60];
    };
    const misses = (tolerance: number) => {
      const index = new PickIndex(100, 100);
      const paths = flattenPath(d, tolerance);
      index.addStroke(
        "routes",
        "route1",
        paths.map(p => p.points),
        paths.map(p => p.closed),
        0.05
      );
      let missed = 0;
      for (let i = 0; i <= 200; i++) if (index.pick(...(curve(i / 200) as [number, number]))?.id !== "route1") missed++;
      return missed;
    };
    expect(misses(0.2)).toBeGreaterThan(0);
    expect(misses(PICK_TOLERANCE)).toBe(0);
  });

  it("pick returns pickAll's topmost hit, within one bucket and across bucket edges", () => {
    const index = new PickIndex(100, 100, 8);
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed / 2147483647) * 100;
    };
    for (let i = 0; i < 60; i++) {
      const [x, y, w] = [rand(), rand(), rand() / 4];
      if (i % 2) index.addBox("b", `box${i}`, [x, y, x + w, y, x + w, y + w, x, y + w]);
      else index.addStroke("s", `line${i}`, [[x, y, x + w, y + w]], [false], 0.5);
    }
    for (let i = 0; i < 2000; i++) {
      const [x, y] = [rand(), rand()];
      for (const [tolerance, pixel] of [
        [0, 0],
        [0, 1],
        [3, 0]
      ])
        expect(index.pick(x, y, tolerance, undefined, pixel)).toEqual(index.pickAll(x, y, tolerance, pixel)[0] ?? null);
    }
  });

  it("reports an anonymous leaf's depth below its [id] ancestor", () => {
    const index = new PickIndex(100, 100);
    index.addStroke("ice", "ice", [[0, 0, 10, 0]], [false], 1);
    index.setDepth(0, 1);
    index.addStroke("lakes", "lake1", [[0, 20, 10, 20]], [false], 1);
    expect(index.pick(5, 0)).toMatchObject({ id: "ice", depth: 1 });
    expect(index.pick(5, 20)?.depth).toBeUndefined();
    // a leaf path is kept only when its length matches the depth
    index.addStroke("ice", "ice", [[0, 40, 10, 40]], [false], 1);
    index.setDepth(2, 1, [4]);
    index.addStroke("ice", "ice", [[0, 60, 10, 60]], [false], 1);
    index.setDepth(3, 1, [4, 2]);
    expect(index.pick(5, 40)).toMatchObject({ depth: 1, path: [4] });
    expect(index.pick(5, 60)?.path).toBeUndefined();
  });

  it("distinguishes closed and open polylines", () => {
    const pts = [0, 0, 10, 0, 10, 10, 0, 10];
    const open = new PickIndex(100, 100);
    open.addStroke("l", "open", [pts], [false], 1);
    expect(open.pick(0, 5)).toBeNull();
    const closed = new PickIndex(100, 100);
    closed.addStroke("l", "closed", [pts], [true], 1);
    expect(closed.pick(0, 5)?.id).toBe("closed");
  });

  it("stroke outlines follow butt, square and round caps at open ends", () => {
    const at = (lineCap: string) => {
      const index = new PickIndex(100, 100);
      index.addStroke("routes", lineCap, [[10, 10, 20, 10]], [false], 1, { dashes: [], dashOffset: 0, lineCap });
      return (x: number, y: number) => index.pick(x, y)?.id ?? null;
    };
    const butt = at("butt");
    expect(butt(10, 10)).toBe("butt");
    expect(butt(9.5, 10)).toBeNull(); // a burg at the route's end is not under its butt-capped stroke
    expect(butt(20.5, 10)).toBeNull();
    const square = at("square");
    expect(square(9.2, 10.9)).toBe("square");
    expect(square(8.8, 10)).toBeNull();
    const round = at("round");
    expect(round(9.2, 10)).toBe("round");
    expect(round(9.2, 10.9)).toBeNull();
  });

  it("stroke outlines skip dash gaps, restart dashes per subpath and cap every dash", () => {
    const index = new PickIndex(100, 100);
    // roads-like: dasharray 2, butt
    index.addStroke(
      "routes",
      "road",
      [
        [0, 10, 20, 10],
        [0, 30, 20, 30]
      ],
      [false, false],
      0.35,
      {
        dashes: [2],
        dashOffset: 0,
        lineCap: "butt"
      }
    );
    expect(index.pick(1, 10)?.id).toBe("road");
    expect(index.pick(3, 10)).toBeNull(); // in the gap 2..4
    expect(index.pick(5, 10)?.id).toBe("road");
    expect(index.pick(1, 30)?.id).toBe("road"); // the second subpath starts on a dash again
    const offset = new PickIndex(100, 100);
    offset.addStroke("routes", "offset", [[0, 10, 20, 10]], [false], 0.35, {
      dashes: [2],
      dashOffset: 2,
      lineCap: "butt"
    });
    expect(offset.pick(1, 10)).toBeNull();
    expect(offset.pick(3, 10)?.id).toBe("offset");
    // searoutes-like: dasharray 1 2, round caps reach half a width into each gap
    const sea = new PickIndex(100, 100);
    sea.addStroke("routes", "sea", [[0, 10, 30, 10]], [false], 0.5, {
      dashes: [1, 2],
      dashOffset: 0,
      lineCap: "round"
    });
    expect(sea.pick(1.3, 10)?.id).toBe("sea");
    expect(sea.pick(1.3, 10.45)).toBeNull();
    expect(sea.pick(2, 10)).toBeNull();
  });

  it("caps a zero-length dash as a round dot or an upright square, and butt draws nothing", () => {
    const dot = [5, 5, 5, 5];
    expect(strokeCovers(5.4, 5.4, dot, false, 1, [], 0, 2)).toBe(true); // 0.57 from the centre
    expect(strokeCovers(5.9, 5.9, dot, false, 1, [], 0, 2)).toBe(false); // 1.27: outside the disc
    expect(strokeCovers(5.9, 5.9, dot, false, 1, [], 0, 0)).toBe(true); // inside the upright box
    expect(strokeCovers(5.9, 5.9, dot, false, 1, [], 0, 1)).toBe(false);
  });

  // route88 over burg 873 (picking-1792205451012084000): a dash piece ending in a 0.058-long step; the full disc at the
  // vertex before it reached past the butt end, where SVG paints (and hits) nothing.
  it("keeps a round join to its outer wedge, so it never reaches past a butt end", () => {
    const tail = [0, 0, 10, 0, 10.05, 0];
    expect(strokeCovers(10.2, 0.1, tail, false, 0.25, [], 0, 1)).toBe(false);
    expect(polylineCovers(10.2, 0.1, tail, false, 0.25, "butt")).toBe(false);
    expect(strokeCovers(10.2, 0.1, [0, 0, 10, 0, 10, 0, 10.05, 0], false, 0.25, [], 0, 1)).toBe(false);
    expect(strokeCovers(10.2, 0.1, tail, false, 0.25, [], 0, 2)).toBe(true); // the round end cap does cover it
    expect(strokeCovers(10.02, 0.2, tail, false, 0.25, [], 0, 1)).toBe(true); // body of the short last step
    // a float32 click on the endpoint itself (route931 over burg 1035 in picking-1792205878603341000)
    expect(strokeCovers(10.050004, 0.1, tail, false, 0.25, [], 0, 1)).toBe(true);
    expect(polylineCovers(10.050004, 0.1, tail, false, 0.25, "butt")).toBe(true);
    expect(strokeCovers(10.06, 0.1, tail, false, 0.25, [], 0, 1)).toBe(false);
    // a burg centre 3e-4 units past a trail's end (route702 over river1260): Blink misses it, so the index must too
    expect(strokeCovers(10.0503, 0.1, tail, false, 0.25, [], 0, 1)).toBe(false);
    expect(polylineCovers(10.0503, 0.1, tail, false, 0.25, "butt")).toBe(false);
    expect(END_SLACK).toBeLessThan(5e-5); // Blink misses a synthetic butt end 5e-5 units past
    const corner = [0, 0, 10, 0, 10, 10];
    for (const covers of [
      (x: number, y: number) => strokeCovers(x, y, corner, false, 1, [], 0, 1),
      (x: number, y: number) => polylineCovers(x, y, corner, false, 1, "butt")
    ]) {
      expect(covers(10.5, -0.5)).toBe(true); // outer wedge of the turn
      expect(covers(10.8, -0.8)).toBe(false); // round, not miter
      expect(covers(5, 0.9)).toBe(true);
      expect(covers(5, 1.1)).toBe(false);
      expect(covers(9.5, 0.5)).toBe(true); // inner side
    }
    const square = [0, 0, 10, 0, 10, 10, 0, 10];
    expect(strokeCovers(-0.5, -0.5, square, true, 1, [], 0, 1)).toBe(true); // closing join at the first vertex
    expect(strokeCovers(-0.8, -0.8, square, true, 1, [], 0, 1)).toBe(false);
  });

  it("draws every zero-length dash of a dotted route", () => {
    // dasharray 0 5 on a 20-unit line: dots at 0, 5, 10 and 15
    const pieces = dashPieces(measureContour({ segs: [[0, 10, 20, 10]], closed: false }, 1), [0, 5], 0);
    const index = new PickIndex(100, 100);
    index.addStroke(
      "routes",
      "dots",
      pieces,
      pieces.map(() => false),
      1,
      { dashes: [], dashOffset: 0, lineCap: "round" }
    );
    expect(index.pick(5.5, 10)?.id).toBe("dots");
    expect(index.pick(0.5, 10.5)?.id).toBe("dots");
    expect(index.pick(7.5, 10)).toBeNull(); // between the dots at 5 and 10
  });

  it("strokes without an outline keep round, solid hit areas", () => {
    const index = new PickIndex(100, 100);
    index.addStroke("l", "compat", [[10, 10, 20, 10]], [false], 1);
    expect(index.pick(9.5, 10)?.id).toBe("compat");
  });

  it("HitShape stroke ends follow cap: round by default, butt cut at the endpoint, square a half-width box", () => {
    const picks = (cap: StrokeCap | undefined, x: number, y: number, closed = false) => {
      const index = new PickIndex(100, 100);
      index.addShape("l", { id: "line", stroke: { rings: [[0, 0, 10, 0]], closed: [closed], halfWidth: 1, cap } });
      return index.pick(x, y)?.id === "line";
    };
    expect(picks(undefined, 10.5, 0)).toBe(true);
    expect(picks("round", 10.5, 0)).toBe(true);
    expect(picks("butt", 10.5, 0)).toBe(false);
    expect(picks("square", 10.5, 0)).toBe(true);
    expect(picks("square", 11.5, 0)).toBe(false);
    expect(picks("round", -0.5, 0)).toBe(true);
    expect(picks("butt", -0.5, 0)).toBe(false);
    expect(picks("square", -0.5, 0)).toBe(true);
    for (const cap of [undefined, "round", "butt", "square"] as const) expect(picks(cap, 5, 0.9)).toBe(true);
    // a closed ring has no ends, so its cap is ignored
    expect(picks("butt", 10.5, 0, true)).toBe(true);
    expect(picks("square", -0.5, 0, true)).toBe(true);
  });

  it("picks a rotated 45 degree box", () => {
    const index = new PickIndex(100, 100);
    index.addBox("labels", "b", [60, 50, 50, 60, 40, 50, 50, 40]);
    expect(index.pick(50, 50)?.id).toBe("b");
    expect(index.pick(53, 53)?.id).toBe("b");
    expect(index.pick(58, 58)).toBeNull();
    expect(index.pick(58, 58, 10)?.id).toBe("b");
  });

  it("returns overlapping hits topmost first", () => {
    const index = new PickIndex(100, 100);
    index.addFill("a", "fill", [[0, 0, 10, 0, 10, 10, 0, 10]], false);
    index.addStroke("a", "stroke", [[0, 5, 10, 5]], [false], 1);
    const all = index.pickAll(5, 5.2);
    expect(all.map(h => h.id)).toEqual(["stroke", "fill"]);
    expect(all[0]).toEqual({ layer: "a", id: "stroke", index: 1, order: 1 });
    expect(index.pick(5, 5.2)?.id).toBe("stroke");
  });

  it("restricts pick to a layer", () => {
    const index = new PickIndex(100, 100);
    index.addFill("base", "fill", [[0, 0, 10, 0, 10, 10, 0, 10]], false);
    index.addBox("labels", "box", [7, 5, 5, 7, 3, 5, 5, 3]);
    expect(index.pick(5, 5)?.layer).toBe("labels");
    expect(index.pick(5, 5, 0, "base")?.id).toBe("fill");
    expect(index.pick(5, 5, 0, "missing")).toBeNull();
  });

  it("evenodd fill hole is not picked", () => {
    const index = new PickIndex(100, 100);
    index.addFill(
      "l",
      "ring",
      [
        [0, 0, 10, 0, 10, 10, 0, 10],
        [3, 3, 7, 3, 7, 7, 3, 7]
      ],
      true
    );
    expect(index.pick(5, 5)).toBeNull();
    expect(index.pick(1, 1)?.id).toBe("ring");
  });

  it("includes the implicit closing edge of a fill in the tolerance band", () => {
    const index = new PickIndex(100, 100);
    index.addFill("l", "tri", [[0, 0, 10, 0, 0, 10]], false);
    expect(index.pick(-0.3, 5)).toBeNull();
    expect(index.pick(-0.3, 5, 0.5)?.id).toBe("tri");
    expect(index.pick(-0.6, 5, 0.5)).toBeNull();
  });

  it("finds an item spanning many buckets and points on bucket boundaries", () => {
    const index = new PickIndex(1000, 1000, 10);
    index.addFill("l", "big", [[0, 0, 900, 0, 900, 900, 0, 900]], false);
    index.addFill("l", "tiny", [[9.5, 9.5, 10.5, 9.5, 10.5, 10.5, 9.5, 10.5]], false);
    // bucket boundaries (cell 10) away from the tiny square resolve to big
    for (const p of [20, 30, 100, 890, 899.9]) {
      expect(index.pick(p, p)?.id).toBe("big");
    }
    // tiny straddles the corner of four buckets and is added later, so it is topmost there
    expect(index.pickAll(10, 10).map(h => h.id)).toEqual(["tiny", "big"]);
    expect(index.pick(10, 10)?.id).toBe("tiny");
    expect(index.pick(9.999, 9.999)?.id).toBe("tiny");
    expect(index.pick(10.4, 9.6)?.id).toBe("tiny");
    expect(index.pick(10.6, 10.6)?.id).toBe("big");
    expect(index.pick(10.6, 10.6, 0.2)?.id).toBe("tiny");
    expect(index.pick(950, 950)).toBeNull();
  });

  it("picks items partly outside world bounds", () => {
    const index = new PickIndex(100, 100, 10);
    index.addFill("l", "edge", [[-50, -50, 20, -50, 20, 20, -50, 20]], false);
    expect(index.pick(5, 5)?.id).toBe("edge");
    expect(index.pick(-10, -10)?.id).toBe("edge");
    expect(index.pick(-60, -60)).toBeNull();
  });

  it("addInstance narrows a box hit and reports the instance; a narrow miss falls through", () => {
    const index = new PickIndex(100, 100);
    index.addBox("l", "below", [0, 0, 20, 0, 20, 20, 0, 20]);
    const narrow = (x: number, _y: number, t: number) => x <= 5 + t;
    index.addInstance("l", "glyph", [0, 0, 10, 0, 10, 10, 0, 10], 7, narrow);
    expect(index.pick(3, 3)).toMatchObject({ id: "glyph", instance: 7 });
    expect(index.pick(8, 3)?.id).toBe("below");
    expect(index.pick(8, 3)?.instance).toBeUndefined();
    expect(index.pick(6, 3, 1)).toMatchObject({ id: "glyph", instance: 7 });
  });

  it("square text cells hit up to one CSS px left/above, never right/below (Chrome burgLabel729, marker281)", () => {
    const index = new PickIndex(1000, 1000);
    index.addFill("base", "ocean", [[0, 0, 1000, 0, 1000, 1000, 0, 1000]], false);
    // burgLabel729 at CTM scale 2: cell 0 extent, sample 0.385 above it; 1 CSS px = 0.5 world
    const cell = [667.343, 507.97, 670.632, 507.97, 670.632, 519.47, 667.343, 519.47];
    index.addShape("burgLabels", { id: "burgLabel729", fill: { rings: [cell], evenOdd: false }, square: true });
    expect(index.pick(668, 507.585)?.id).toBe("ocean"); // point semantics (pixel 0): the old miss
    expect(index.pick(668, 507.585, 0, undefined, 0.5)?.id).toBe("burgLabel729");
    expect(index.pick(666.9, 510, 0, undefined, 0.5)?.id).toBe("burgLabel729");
    expect(index.pick(666.8, 510, 0, undefined, 0.5)?.id).toBe("ocean"); // > 1 px left
    expect(index.pick(668, 507.4, 0, undefined, 0.5)?.id).toBe("ocean"); // > 1 px above
    expect(index.pick(670.7, 510, 0, undefined, 0.5)?.id).toBe("ocean"); // right edge is not inflated
    expect(index.pick(668, 519.5, 0, undefined, 0.5)?.id).toBe("ocean"); // nor the bottom
    // non-square items keep point semantics under the same pixel
    index.addFill("markers", "rect", [[100, 100, 110, 100, 110, 110, 100, 110]], false);
    expect(index.pick(99.8, 105, 0, undefined, 0.5)?.id).toBe("ocean");
  });

  it("squareMeetsConvex matches a rotated cell exactly", () => {
    const diamond = [5, 0, 10, 5, 5, 10, 0, 5];
    expect(squareMeetsConvex(1, 1, 1, diamond)).toBe(false); // square corner (2,2) sits outside x+y>=5
    expect(squareMeetsConvex(1.6, 1.6, 1, diamond)).toBe(true); // corner (2.6,2.6) is inside
    expect(squareMeetsConvex(10.01, 5, 1, diamond)).toBe(false);
    expect(squareMeetsConvex(4, 4, 1, diamond)).toBe(true);
  });

  it("clear() removes all items", () => {
    const index = new PickIndex(100, 100);
    index.addBox("l", "b", [0, 0, 10, 0, 10, 10, 0, 10]);
    index.clear();
    expect(index.size).toBe(0);
    expect(index.pick(5, 5)).toBeNull();
    expect(index.bytes()).toBe(0);
  });

  it("bytes() is positive and grows with stored geometry", () => {
    const index = new PickIndex(100, 100);
    expect(index.bytes()).toBe(0);
    index.addFill("l", "a", [[0, 0, 10, 0, 10, 10]], false);
    const one = index.bytes();
    expect(one).toBeGreaterThan(0);
    index.addFill("l", "b", [[0, 0, 50, 0, 50, 50, 0, 50]], false);
    expect(index.bytes()).toBeGreaterThan(one);
    expect(index.size).toBe(2);
  });

  it("matches brute force on random triangles", () => {
    const rand = rng(42);
    const index = new PickIndex(100, 100, 8);
    const tris: number[][] = [];
    for (let t = 0; t < 200; t++) {
      const cx = rand() * 120 - 10;
      const cy = rand() * 120 - 10;
      const tri = [0, 1, 2].flatMap(() => [cx + (rand() - 0.5) * 30, cy + (rand() - 0.5) * 30]);
      tris.push(tri);
      index.addFill("r", `t${t}`, [tri], false);
    }
    for (let p = 0; p < 500; p++) {
      const x = rand() * 120 - 10;
      const y = rand() * 120 - 10;
      const tol = p % 2 === 0 ? 0 : 0.5;
      const expected: number[] = [];
      tris.forEach((tri, i) => {
        if (insideRings(x, y, [tri], false) || polylineDistance(x, y, tri, true) <= tol) expected.push(i);
      });
      const actual = index.pickAll(x, y, tol).map(h => h.index);
      expect(actual).toEqual(expected.sort((a, b) => b - a));
    }
  });
});
