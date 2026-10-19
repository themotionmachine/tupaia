import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Affine,
  cachedReliefImage,
  hatchUvAtZoom,
  meetImageRect,
  multiply,
  parseTransform,
  scaleBucket
} from "./raster";

const close = (actual: Affine | null, expected: number[]) => {
  expect(actual).not.toBeNull();
  expected.forEach((value, i) => {
    expect(actual?.[i]).toBeCloseTo(value, 9);
  });
};
const apply = (m: Affine, x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

describe("multiply", () => {
  it("composes so the right operand is applied first", () => {
    const translate: Affine = [1, 0, 0, 1, 10, 20];
    const scale: Affine = [2, 0, 0, 3, 0, 0];
    expect(apply(multiply(translate, scale), 1, 1)).toEqual([12, 23]);
    expect(apply(multiply(scale, translate), 1, 1)).toEqual([22, 63]);
  });
});

describe("parseTransform", () => {
  it("parses identity and transform lists in SVG order", () => {
    close(parseTransform(""), [1, 0, 0, 1, 0, 0]);
    close(parseTransform(null), [1, 0, 0, 1, 0, 0]);
    close(parseTransform("translate(10 20) scale(2)"), [2, 0, 0, 2, 10, 20]);
    close(parseTransform("translate(5)"), [1, 0, 0, 1, 5, 0]);
    close(parseTransform("matrix(1,2,3,4,5,6)"), [1, 2, 3, 4, 5, 6]);
  });

  it("rotates about an optional centre", () => {
    close(parseTransform("rotate(90)"), [0, 1, -1, 0, 0, 0]);
    const about = parseTransform("rotate(90 10 0)") as Affine;
    close(about, [0, 1, -1, 0, 10, -10]);
    const [x, y] = apply(about, 10, 0);
    expect(x).toBeCloseTo(10, 9);
    expect(y).toBeCloseTo(0, 9);
  });

  it("parses skews", () => {
    close(parseTransform("skewX(45)"), [1, 0, 1, 1, 0, 0]);
    close(parseTransform("skewY(45)"), [1, 1, 0, 1, 0, 0]);
  });

  it("refuses unknown, malformed or truncated transforms", () => {
    for (const value of ["bogus(1)", "translate(a)", "translate(1", "scale(1 2 3)", "rotate(1 2)", "matrix(1 2)"])
      expect(parseTransform(value)).toBeNull();
  });
});

describe("scaleBucket", () => {
  it("rounds up to powers of two within [1, max]", () => {
    expect([0.5, 1, 1.5, 2, 3, 9, 100].map(scale => scaleBucket(scale))).toEqual([1, 1, 2, 2, 4, 16, 16]);
    expect(scaleBucket(100, 8)).toBe(8);
  });
});

describe("canonical relief bitmap reuse", () => {
  afterEach(() => vi.unstubAllGlobals());
  const element = (href: string) =>
    ({ getAttribute: (name: string) => (name === "href" ? href : null) }) as unknown as Element;
  function images(width = 512, height = 256, rejected = false) {
    let created = 0;
    vi.stubGlobal("location", { href: "https://map.test/", origin: "https://map.test" });
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        naturalWidth = width;
        naturalHeight = height;
        constructor() {
          created++;
        }
        async decode() {
          if (rejected) throw new Error("revoked bitmap");
        }
      }
    );
    return () => created;
  }

  it("reuses a local decoded bitmap at its original pixel dimensions", async () => {
    const created = images();
    const image = await cachedReliefImage(element("blob:https://map.test/cache"), 4096);
    expect(image?.naturalWidth).toBe(512);
    expect(image?.naturalHeight).toBe(256);
    expect(image?.src).toBe("blob:https://map.test/cache");
    expect(created()).toBe(1);
  });

  it("leaves external, foreign-origin and vector assets to the existing renderer path", async () => {
    const created = images();
    for (const href of ["https://images.test/icon.png", "blob:https://other.test/cache", "data:image/svg+xml,<svg/>"])
      expect(await cachedReliefImage(element(href), 4096)).toBeNull();
    expect(created()).toBe(0);
  });

  it("refuses an oversized texture and falls back on a revoked bitmap", async () => {
    images(8192, 512);
    expect(await cachedReliefImage(element("blob:https://map.test/cache"), 4096)).toBeNull();
    images(512, 256, true);
    expect(await cachedReliefImage(element("blob:https://map.test/revoked"), 4096)).toBeNull();
  });
});

describe("cached relief image aspect ratio", () => {
  it("centres a rounded bitmap using the SVG default meet alignment", () => {
    expect(meetImageRect([10, 20, 200, 100], 100, 100)).toEqual([60, 20, 100, 100]);
    expect(meetImageRect([10, 20, 100, 200], 100, 100)).toEqual([10, 70, 100, 100]);
    expect(meetImageRect([0, 0, 3066, 1397], 3066, 1397)).toEqual([0, 0, 3066, 1397]);
    const rect = meetImageRect([0, 0, 3066, 1397], 4096, 1867);
    expect(rect[0]).toBeGreaterThan(0);
    expect(rect[2] / rect[3]).toBeCloseTo(4096 / 1867);
  });
});

it("keeps screen hatch pitch and pattern-origin phase while camera zoom changes", () => {
  const base = new Float32Array([2 / 6, 0, 0, 0, 2 / 6, 0, 0.25, 0.5, 1]),
    scratch = new Float32Array(9);
  for (const zoom of [1, 2, 4, 8]) {
    const matrix = hatchUvAtZoom(base, 2, zoom, scratch);
    // Six screen pixels span one repeat at every zoom.
    expect(matrix[0] * (6 / zoom)).toBeCloseTo(1);
    expect(matrix[4] * (6 / zoom)).toBeCloseTo(1);
    expect(matrix[6]).toBe(0.25);
    expect(matrix[7]).toBe(0.5);
  }
  expect([...hatchUvAtZoom(base, undefined, 8, scratch)]).toEqual([...base]);
});

it("rescales a rotated or custom zone-hatch clone exactly like re-rasterizing its rewritten transform", () => {
  const invert = ([a, b, c, d, e, f]: Affine): Affine => {
    const det = a * d - b * c;
    return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
  };
  // tile-to-world as rasterizePattern builds it: patternTransform · translate(x, y) · size
  const tileToWorld = (value: string) =>
    multiply(multiply(parseTransform(value) as Affine, [1, 0, 0, 1, 3, -2]), [6, 0, 0, 4, 0, 0]);
  const uv3 = ([a, b, c, d, e, f]: Affine) => new Float32Array([a, b, 0, c, d, 0, e, f, 1]);
  for (const tail of ["rotate(45 0 0)", "rotate(-30 7 9)", "scale(3) translate(4 5)"]) {
    const reference = 3.5,
      scratch = new Float32Array(9);
    const prepared = uv3(invert(tileToWorld(`scale(${1 / reference}) ${tail}`)));
    for (const zoom of [1, 2.25, 8, 20]) {
      const live = invert(tileToWorld(`scale(${1 / zoom}) ${tail}`));
      const rescaled = hatchUvAtZoom(prepared, reference, zoom, scratch);
      for (const [x, y] of [
        [0, 0],
        [17, -40],
        [-123.5, 88]
      ]) {
        const [u, v] = apply(live, x, y);
        expect(rescaled[0] * x + rescaled[3] * y + rescaled[6]).toBeCloseTo(u, 3);
        expect(rescaled[1] * x + rescaled[4] * y + rescaled[7]).toBeCloseTo(v, 3);
      }
    }
  }
});
