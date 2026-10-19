import { describe, expect, it } from "vitest";
import {
  backingSize,
  type Camera,
  cameraEquals,
  float32PixelError,
  intersects,
  invertAffine,
  parseViewboxTransform,
  screenToClip,
  screenToWorld,
  visibleWorld,
  worldScissor,
  worldToClip,
  worldToScreen
} from "./camera";

// column-major 3x3 applied to a point (x, y, 1)
const applyClip = (m: ArrayLike<number>, x: number, y: number) => [
  m[0] * x + m[3] * y + m[6],
  m[1] * x + m[4] * y + m[7]
];

const applyAffine = (m: ArrayLike<number>, x: number, y: number) => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5]
];

const viewport = { width: 800, height: 600, dpr: 2 };

describe("worldToScreen / screenToWorld", () => {
  it.each([1, 7.3, 20])("roundtrips at k=%s with offsets", k => {
    const c: Camera = { k, x: 13.5, y: -42 };
    for (const [wx, wy] of [
      [0, 0],
      [100.25, -7],
      [8192, 8192]
    ]) {
      const [sx, sy] = worldToScreen(c, wx, wy);
      const [bx, by] = screenToWorld(c, sx, sy);
      expect(bx).toBeCloseTo(wx, 8);
      expect(by).toBeCloseTo(wy, 8);
    }
  });

  it("maps the origin to the offset", () => {
    expect(worldToScreen({ k: 2, x: 10, y: 20 }, 0, 0)).toEqual([10, 20]);
  });
});

describe("worldToClip", () => {
  const c: Camera = { k: 7.3, x: 40, y: -20 };

  it("maps viewport corners to clip corners", () => {
    const m = worldToClip(c, viewport);
    const [tlx, tly] = screenToWorld(c, 0, 0);
    const [brx, bry] = screenToWorld(c, viewport.width, viewport.height);
    const tl = applyClip(m, tlx, tly);
    const br = applyClip(m, brx, bry);
    expect(tl[0]).toBeCloseTo(-1, 4);
    expect(tl[1]).toBeCloseTo(1, 4);
    expect(br[0]).toBeCloseTo(1, 4);
    expect(br[1]).toBeCloseTo(-1, 4);
  });

  it("maps a known world point", () => {
    const m = worldToClip({ k: 2, x: 100, y: 50 }, viewport);
    const [cx, cy] = applyClip(m, 0, 0);
    expect(cx).toBeCloseTo(-0.75, 5);
    expect(cy).toBeCloseTo(1 - 100 / 600, 5);
  });

  it("writes into the provided buffer", () => {
    const out = new Float32Array(9);
    expect(worldToClip(c, viewport, out)).toBe(out);
  });
});

describe("screenToClip", () => {
  it("maps viewport corners and center to clip space", () => {
    const m = screenToClip(viewport);
    const tl = applyClip(m, 0, 0);
    const br = applyClip(m, 800, 600);
    const mid = applyClip(m, 400, 300);
    expect(tl[0]).toBeCloseTo(-1, 5);
    expect(tl[1]).toBeCloseTo(1, 5);
    expect(br[0]).toBeCloseTo(1, 5);
    expect(br[1]).toBeCloseTo(-1, 5);
    expect(mid[0]).toBeCloseTo(0, 5);
    expect(mid[1]).toBeCloseTo(0, 5);
  });

  it("agrees with worldToClip under identity camera", () => {
    const a = worldToClip({ k: 1, x: 0, y: 0 }, viewport);
    const b = screenToClip(viewport);
    for (let i = 0; i < 9; i++) expect(a[i]).toBeCloseTo(b[i], 6);
  });
});

describe("backingSize", () => {
  it("caps dpr at maxDpr", () => {
    expect(backingSize(400, 300, 3, 8192)).toEqual({ width: 800, height: 600, dpr: 2 });
  });

  it("keeps dpr below the cap unchanged", () => {
    expect(backingSize(400, 300, 1.5, 8192)).toEqual({ width: 600, height: 450, dpr: 1.5 });
  });

  it("respects a custom maxDpr", () => {
    expect(backingSize(400, 300, 3, 8192, 1)).toEqual({ width: 400, height: 300, dpr: 1 });
  });

  it("caps each side at maxTextureSize with integer sizes", () => {
    const r = backingSize(1000, 500, 2, 1024);
    expect(r.width).toBe(1024);
    expect(r.height).toBe(512);
    expect(r.dpr).toBeCloseTo(1.024, 9);
  });

  it("caps the height axis and uses the smaller dpr", () => {
    expect(backingSize(100, 2000, 1, 1000)).toEqual({ width: 50, height: 1000, dpr: 0.5 });
  });

  it("returns at least 1 for zero size", () => {
    const r = backingSize(0, 0, 2, 4096);
    expect(r.width).toBe(1);
    expect(r.height).toBe(1);
  });
});

describe("visibleWorld", () => {
  const c: Camera = { k: 2, x: 10, y: -20 };
  const v = { width: 800, height: 600, dpr: 1 };

  it("returns the visible rect without margin", () => {
    expect(visibleWorld(c, v)).toEqual([-5, 10, 395, 310]);
  });

  it("expands the rect by margin CSS px", () => {
    const [x0, y0, x1, y1] = visibleWorld(c, v, 50);
    expect(x0).toBeCloseTo(-30, 9);
    expect(y0).toBeCloseTo(-15, 9);
    expect(x1).toBeCloseTo(420, 9);
    expect(y1).toBeCloseTo(335, 9);
  });
});

describe("intersects", () => {
  it("detects overlap, containment, and separation", () => {
    expect(intersects([0, 0, 10, 10], [5, 5, 15, 15])).toBe(true);
    expect(intersects([0, 0, 100, 100], [10, 10, 20, 20])).toBe(true);
    expect(intersects([0, 0, 10, 10], [11, 0, 20, 10])).toBe(false);
    expect(intersects([0, 0, 10, 10], [0, 11, 10, 20])).toBe(false);
  });

  it("counts touching edges as intersecting", () => {
    expect(intersects([0, 0, 10, 10], [10, 0, 20, 10])).toBe(true);
  });
});

describe("parseViewboxTransform", () => {
  it("returns identity for null and empty input", () => {
    expect(parseViewboxTransform(null)).toEqual({ k: 1, x: 0, y: 0 });
    expect(parseViewboxTransform("")).toEqual({ k: 1, x: 0, y: 0 });
  });

  it("returns identity for invalid input", () => {
    expect(parseViewboxTransform("garbage")).toEqual({ k: 1, x: 0, y: 0 });
  });

  it("parses space separated values", () => {
    expect(parseViewboxTransform("translate(10 20) scale(2)")).toEqual({ k: 2, x: 10, y: 20 });
  });

  it("parses comma separated values", () => {
    expect(parseViewboxTransform("translate(10,20) scale(2.5)")).toEqual({ k: 2.5, x: 10, y: 20 });
  });

  it("parses negative numbers", () => {
    expect(parseViewboxTransform("translate(-100.5,-3) scale(0.5)")).toEqual({ k: 0.5, x: -100.5, y: -3 });
  });

  it("parses exponent notation", () => {
    const c = parseViewboxTransform("translate(1e2,2E-1) scale(1e1)");
    expect(c.k).toBeCloseTo(10, 9);
    expect(c.x).toBeCloseTo(100, 9);
    expect(c.y).toBeCloseTo(0.2, 9);
  });

  it("parses a sign-separated pair without whitespace", () => {
    expect(parseViewboxTransform("translate(10-20) scale(2)")).toEqual({ k: 2, x: 10, y: -20 });
  });

  it("defaults scale to 1 when omitted", () => {
    expect(parseViewboxTransform("translate(5 6)")).toEqual({ k: 1, x: 5, y: 6 });
  });

  it("defaults translate to 0 when omitted", () => {
    expect(parseViewboxTransform("scale(3)")).toEqual({ k: 3, x: 0, y: 0 });
  });
});

describe("cameraEquals", () => {
  it("compares within epsilon", () => {
    expect(cameraEquals({ k: 1, x: 2, y: 3 }, { k: 1 + 1e-9, x: 2, y: 3 })).toBe(true);
    expect(cameraEquals({ k: 1, x: 2, y: 3 }, { k: 1, x: 2.1, y: 3 })).toBe(false);
    expect(cameraEquals({ k: 1, x: 2, y: 3 }, { k: 1, x: 2.1, y: 3 }, 0.2)).toBe(true);
  });
});

describe("float32PixelError", () => {
  // Camera math runs in float64 on the CPU; only the uniforms are float32.
  // This is an estimate of the worst-case screen-pixel error from float32 world coordinates.
  it("is below 0.02 px at k=20 for an 8192 world", () => {
    expect(float32PixelError(20, 8192)).toBeLessThan(0.02);
  });

  it("scales linearly with k and size", () => {
    expect(float32PixelError(2, 100)).toBeCloseTo(2 * 100 * 2 ** -24, 15);
  });
});

describe("invertAffine", () => {
  it("roundtrips points through a matrix and its inverse", () => {
    const m = [2, 0.5, -1, 3, 10, -4];
    const inv = invertAffine(m);
    for (const [x, y] of [
      [0, 0],
      [7.5, -3],
      [-100, 250]
    ]) {
      const [qx, qy] = applyAffine(m, x, y);
      const [bx, by] = applyAffine(inv, qx, qy);
      expect(bx).toBeCloseTo(x, 9);
      expect(by).toBeCloseTo(y, 9);
    }
  });

  it("inverts a uniform scale", () => {
    const inv = invertAffine([2, 0, 0, 2, 0, 0]);
    expect(inv[0]).toBeCloseTo(0.5, 12);
    expect(inv[3]).toBeCloseTo(0.5, 12);
  });

  it("returns identity for a singular matrix", () => {
    expect(invertAffine([1, 2, 2, 4, 0, 0])).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

it("scissor encloses zoomed/panned strokes at Retina density and clamps all viewport edges", () => {
  const view = { width: 100, height: 100, dpr: 2 };
  expect(worldScissor([10, 20, 30, 40], { k: 2, x: -5, y: 7 }, view, 200, 200)).toEqual([28, 24, 84, 84]);
  expect(worldScissor([-1, -1, 1, 1], { k: 1, x: 0, y: 0 }, view, 200, 200)).toEqual([0, 196, 4, 4]);
  expect(worldScissor([-100, -100, 200, 200], { k: 1, x: 0, y: 0 }, view, 200, 200)).toEqual([0, 0, 200, 200]);
  expect(worldScissor([-100, 0, -90, 10], { k: 1, x: 0, y: 0 }, view, 200, 200)).toBeNull();
});
