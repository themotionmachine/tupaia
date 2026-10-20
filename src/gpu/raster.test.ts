import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Affine,
  cachedReliefImage,
  hatchUvAtZoom,
  INHERITED_PATTERN_ATTRIBUTES,
  inheritedAttributes,
  MAX_TILE_PIXELS,
  MAX_TILE_SIDE,
  meetImageRect,
  multiply,
  parseTransform,
  planPattern,
  scaleBucket,
  tileSize
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

// Minimal Element stand-in built from a <pattern> markup string (vitest runs in node, no DOM).
function fakePattern(markup: string) {
  const open = /<pattern\b([^>]*)>/.exec(markup)!;
  const attrs = new Map<string, string>();
  for (const m of open[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs.set(m[1], m[2]);
  const body = markup.slice(open[0].length);
  const tags = new Set([...body.matchAll(/<(\w+)/g)].map(m => m[1]));
  return {
    getAttribute: (n: string) => attrs.get(n) ?? null,
    hasAttribute: (n: string) => attrs.has(n),
    querySelector: (sel: string) => (sel.split(",").some(t => tags.has(t.trim())) ? ({} as Element) : null)
  };
}

describe("pattern tile inheritance", () => {
  it("passes dash, cap, join, offset and miter attributes to the tile wrapper", () => {
    for (const name of [
      "stroke-dasharray",
      "stroke-dashoffset",
      "stroke-linecap",
      "stroke-linejoin",
      "stroke-miterlimit",
      "stroke-opacity",
      "fill-opacity",
      "opacity"
    ])
      expect(INHERITED_PATTERN_ATTRIBUTES).toContain(name);
    const pattern = fakePattern(
      '<pattern id="g" width="25" height="25" stroke="#000" stroke-dasharray="2 3" stroke-dashoffset="1" stroke-linecap="round" stroke-linejoin="bevel" stroke-miterlimit="2" bogus="x"><path d="M0 0"/></pattern>'
    );
    expect(Object.fromEntries(inheritedAttributes(pattern))).toEqual({
      stroke: "#000",
      "stroke-dasharray": "2 3",
      "stroke-dashoffset": "1",
      "stroke-linecap": "round",
      "stroke-linejoin": "bevel",
      "stroke-miterlimit": "2"
    });
  });
});

describe("tileSize", () => {
  it("keeps pitch within one device px at every zoom bucket, with no 512 px clamp", () => {
    for (const [w, h] of [
      [4, 4],
      [25, 43.4],
      [100, 100],
      [82.5, 50]
    ])
      for (const bucket of [1, 2, 4, 8, 16]) {
        const { tw, th, capped } = tileSize(w, h, bucket);
        if (capped) continue;
        expect(tw).toBeGreaterThanOrEqual(w * bucket - 1e-6);
        expect(tw - w * bucket).toBeLessThan(1);
        expect(th - h * bucket).toBeLessThan(1);
      }
    expect(tileSize(100, 100, 8).tw).toBe(800);
  });

  it("bounds memory by side and area", () => {
    const huge = tileSize(5000, 40, 16);
    expect(huge.capped).toBe(true);
    expect(Math.max(huge.tw, huge.th)).toBeLessThanOrEqual(MAX_TILE_SIDE);
    const big = tileSize(1000, 1000, 16);
    expect(big.capped).toBe(true);
    expect(big.tw * big.th).toBeLessThanOrEqual(MAX_TILE_PIXELS);
    expect(tileSize(4, 4, 1)).toEqual({ tw: 4, th: 4, capped: false });
  });
});

describe("planPattern", () => {
  const plan = (markup: string, scale = 4) => planPattern(fakePattern(markup), scale);
  it("selects the raster size from the bucket and the patternTransform scale", () => {
    const p = plan('<pattern width="10" height="10" patternUnits="userSpaceOnUse"><line/></pattern>', 8);
    expect(typeof p).toBe("object");
    if (typeof p === "string") return;
    expect(p.size.tw).toBe(80);
    const scaled = plan(
      '<pattern width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="scale(2)"><line/></pattern>',
      8
    );
    if (typeof scaled === "string") throw new Error(scaled);
    expect(scaled.size.tw).toBe(160);
    const rotated = plan(
      '<pattern width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45 0 0)"><line/></pattern>',
      8
    );
    if (typeof rotated === "string") throw new Error(rotated);
    expect(rotated.size.tw).toBe(32);
  });

  it("routes non-native patterns to compat with a reason (oceanic image pattern)", () => {
    expect(
      plan('<pattern id="oceanic" width="100" height="100" patternUnits="userSpaceOnUse"><image href="x"/></pattern>')
    ).toBe("pattern content");
    expect(plan('<pattern width="4" height="4"><line/></pattern>')).toBe("pattern units");
  });
});

describe("stock hatch patterns", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const hatches = [...html.matchAll(/<pattern id="(hatch\d+)"[^>]*>[\s\S]*?<\/pattern>/g)];
  it("defines hatch0..hatch41", () => {
    expect(hatches.map(m => m[1])).toEqual(Array.from({ length: 42 }, (_, i) => `hatch${i}`));
  });
  it("classifies every one for native rasterization with a computed pitch at k 1/2/4/8", () => {
    for (const m of hatches)
      for (const k of [1, 2, 4, 8]) {
        const p = planPattern(fakePattern(m[0]), k);
        expect(typeof p, `${m[1]} -> ${p}`).toBe("object");
        if (typeof p === "string") continue;
        expect(p.pitch).toEqual([p.width * k, p.height * k]);
        expect(p.size.capped).toBe(false);
        expect(p.size.tw).toBe(Math.ceil(p.width * k));
      }
  });
});

describe("zone-hatch clone tiles", () => {
  // [COMPAT] the clone's S(1/k) sets its device size: one tile unit is dpr device px at the zoom it was written for
  it("rasterize at the on-screen pitch, not k times over", () => {
    for (const k of [1, 2, 4, 8]) {
      const p = planPattern(
        fakePattern(
          `<pattern width="4" height="4" patternUnits="userSpaceOnUse" data-zone-hatch-clone="" patternTransform="scale(${1 / k}) rotate(30 0 0)"><line/></pattern>`
        ),
        k * 2
      );
      if (typeof p === "string") throw new Error(p);
      expect(p.referenceZoom).toBeCloseTo(k, 9);
      expect(p.size.tw).toBe(8);
      expect(p.pitch[0]).toBeCloseTo(8, 9);
    }
  });
});
