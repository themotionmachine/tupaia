import { describe, expect, it } from "vitest";
import { layoutOnPath } from "./geometry";
import {
  centralBaselineShift,
  letterSpacingPx,
  parseLength,
  prefixAdvances,
  presentAttribute,
  quad,
  spacedAdvances,
  startOffsetLength,
  strokeBeforeFill,
  textPathTargetId,
  unsupportedContent,
  unsupportedStroke,
  unsupportedStyle
} from "./text";

const XLINK = "http://www.w3.org/1999/xlink";

function attributes(map: Record<string, string>, namespaced: Record<string, string> = {}) {
  return {
    getAttribute: (name: string) => map[name] ?? null,
    getAttributeNS: (ns: string, name: string) => (ns === XLINK ? (namespaced[name] ?? null) : null)
  };
}

describe("prefixAdvances", () => {
  it("derives per-character advances from prefix widths so kerning is kept", () => {
    expect(prefixAdvances("ab", s => s.length * 10)).toEqual([10, 10]);
    expect(prefixAdvances("AV", s => (s === "AV" ? 18 : s.length * 10))).toEqual([10, 8]);
  });

  it("iterates code points, not UTF-16 units", () => {
    expect(prefixAdvances("😀a", s => [...s].length * 7)).toEqual([7, 7]);
    expect(prefixAdvances("", () => 1)).toEqual([]);
  });
});

describe("textPathTargetId", () => {
  it("reads SVG 2 href and legacy xlink:href, namespaced or by qualified name", () => {
    expect(textPathTargetId(attributes({ href: "#textPath_stateLabel1" }))).toBe("textPath_stateLabel1");
    expect(textPathTargetId(attributes({}, { href: "#legacy" }))).toBe("legacy");
    expect(textPathTargetId({ getAttribute: name => (name === "xlink:href" ? "#qualified" : null) })).toBe("qualified");
  });

  it("prefers href over xlink:href, even when href is unusable", () => {
    expect(textPathTargetId(attributes({ href: "#new" }, { href: "#old" }))).toBe("new");
    expect(textPathTargetId(attributes({ href: "" }, { href: "#old" }))).toBeNull();
  });

  it("rejects missing, external and malformed references", () => {
    expect(textPathTargetId(attributes({}))).toBeNull();
    expect(textPathTargetId(attributes({ href: "other.svg#p" }))).toBeNull();
    expect(textPathTargetId(attributes({ href: "#" }))).toBeNull();
    expect(textPathTargetId(attributes({ href: "p" }))).toBeNull();
  });
});

describe("presentAttribute", () => {
  it("names the first present attribute, including empty ones", () => {
    expect(presentAttribute(attributes({ dx: "", rotate: "5" }), ["x", "dx", "rotate"])).toBe("dx");
    expect(presentAttribute(attributes({}), ["x"])).toBe("");
  });
});

describe("parseLength", () => {
  it("accepts one user-unit, px or em length", () => {
    expect(parseLength("0", 10)).toBe(0);
    expect(parseLength("-1em", 12)).toBe(-12);
    expect(parseLength("0.5em", 20)).toBe(10);
    expect(parseLength("1.5", 10)).toBe(1.5);
    expect(parseLength(" 3px ", 10)).toBe(3);
    expect(parseLength("1e1", 10)).toBe(10);
  });

  it("rejects lists, other units and junk instead of reading the first number", () => {
    for (const value of ["1 2", "1,2", "2pt", "10%", "", "em", "1em2"]) expect(parseLength(value, 10)).toBeNull();
  });
});

describe("startOffsetLength", () => {
  it("resolves percentages against the path length and lengths as distances", () => {
    expect(startOffsetLength("50%", 200)).toBe(100);
    expect(startOffsetLength("-10%", 200)).toBe(-20);
    expect(startOffsetLength("30", 200)).toBe(30);
    expect(startOffsetLength("30px", 200)).toBe(30);
    expect(startOffsetLength(null, 200)).toBe(0);
  });

  it("rejects em (needs the textPath font size) and malformed values", () => {
    expect(startOffsetLength("1em", 200)).toBeNull();
    expect(startOffsetLength("50 %", 200)).toBeNull();
    expect(startOffsetLength("abc", 200)).toBeNull();
  });
});

describe("letterSpacingPx", () => {
  it("reads computed px values and normal", () => {
    expect(letterSpacingPx("normal")).toBe(0);
    expect(letterSpacingPx(undefined)).toBe(0);
    expect(letterSpacingPx("0")).toBe(0);
    expect(letterSpacingPx("3px")).toBe(3);
    expect(letterSpacingPx("-0.5px")).toBe(-0.5);
  });

  it("rejects values the engine did not resolve to px", () => {
    expect(letterSpacingPx("0.1em")).toBeNull();
    expect(letterSpacingPx("3")).toBeNull();
    expect(letterSpacingPx("calc(1px + 1em)")).toBeNull();
  });
});

describe("spacedAdvances", () => {
  it("adds spacing after every character, the last included", () => {
    expect(spacedAdvances([10, 8, 6], 2)).toEqual([12, 10, 8]);
    expect(spacedAdvances([10, 8], 0)).toEqual([10, 8]);
    expect(spacedAdvances([10, 8], -3)).toEqual([7, 5]);
  });

  it("refuses spacing that would run an advance backwards", () => {
    expect(spacedAdvances([10, 2], -3)).toBeNull();
  });

  it("feeds the trailing spacing into the middle-anchor extent", () => {
    // straight path 0..100, two 10px glyphs with 4px spacing centred at 50: extent 28, pen starts at 36 and the
    // samples sit at the spaced-advance midpoints 43 and 57 (pen origin = sample - spaced advance / 2)
    const placed = layoutOnPath([0, 0, 100, 0], spacedAdvances([10, 10], 4)!, 0.5, "middle");
    expect(placed[0].x).toBeCloseTo(43, 9);
    expect(placed[1].x).toBeCloseTo(57, 9);
  });
});

describe("unsupportedContent", () => {
  it("accepts plain and precomposed text", () => {
    expect(unsupportedContent("Kingdom of Ærvø")).toBe("");
    expect(unsupportedContent("Café")).toBe("");
    expect(unsupportedContent("")).toBe("");
  });

  it("names shaping-dependent text", () => {
    expect(unsupportedContent("Café")).toBe("complex text");
    expect(unsupportedContent("مدينة")).toBe("complex text");
    expect(unsupportedContent("👨‍👩")).toBe("complex text");
    expect(unsupportedContent("\u{1F1EB}\u{1F1F7}")).toBe("complex text"); // flag pair
    expect(unsupportedContent("❤️")).toBe("complex text"); // variation selector is a mark
  });

  it("names text that SVG white-space collapsing would change", () => {
    for (const value of [" A", "A ", "A  B", "A\nB", "A\tB"]) expect(unsupportedContent(value)).toBe("whitespace");
    expect(unsupportedContent("A B")).toBe("");
  });
});

describe("strokeBeforeFill", () => {
  it("orders fill and stroke as paint-order does, unlisted layers in default order", () => {
    expect(strokeBeforeFill("normal")).toBe(false);
    expect(strokeBeforeFill(undefined)).toBe(false);
    expect(strokeBeforeFill("stroke")).toBe(true);
    expect(strokeBeforeFill("fill")).toBe(false);
    expect(strokeBeforeFill("markers")).toBe(false);
    expect(strokeBeforeFill("markers stroke")).toBe(true);
    expect(strokeBeforeFill("stroke fill markers")).toBe(true);
  });
});

describe("unsupportedStyle", () => {
  const plain = {
    textShadow: "none",
    wordSpacing: "0px",
    textTransform: "none",
    fontVariantCaps: "normal",
    fontStretch: "100%",
    direction: "ltr",
    writingMode: "horizontal-tb",
    dominantBaseline: "auto",
    baselineShift: "0px",
    textDecorationLine: "none",
    visibility: "visible",
    fill: "rgb(0, 0, 0)",
    stroke: "none"
  };

  it("accepts computed defaults and missing properties", () => {
    expect(unsupportedStyle(plain)).toBe("");
    expect(unsupportedStyle({})).toBe("");
  });

  it("names each feature that would otherwise be dropped", () => {
    const cases: [Record<string, string>, string][] = [
      [{ textShadow: "rgb(0, 0, 0) 1px 1px 0px" }, "text-shadow"],
      [{ wordSpacing: "4px" }, "word-spacing"],
      [{ textTransform: "uppercase" }, "text-transform"],
      [{ fontVariantCaps: "small-caps" }, "font-variant"],
      [{ fontStretch: "75%" }, "font-stretch"],
      [{ direction: "rtl" }, "direction"],
      [{ writingMode: "vertical-rl" }, "writing-mode"],
      [{ dominantBaseline: "middle" }, "baseline"],
      [{ baselineShift: "super" }, "baseline"],
      [{ textDecorationLine: "underline" }, "text-decoration"],
      [{ visibility: "hidden" }, "visibility"],
      [{ fill: 'url("#gradient")' }, "paint server text"]
    ];
    for (const [override, reason] of cases) expect(unsupportedStyle({ ...plain, ...override })).toBe(reason);
  });
});

describe("unsupportedStroke", () => {
  it("accepts canvas-equivalent joins and names the rest", () => {
    expect(unsupportedStroke({ strokeDasharray: "none", strokeLinejoin: "round", vectorEffect: "none" })).toBe("");
    expect(unsupportedStroke({ strokeLinejoin: "miter" })).toBe("");
    expect(unsupportedStroke({ strokeLinejoin: "arcs" })).toBe("stroke-linejoin");
    expect(unsupportedStroke({ strokeDasharray: "2px, 1px" })).toBe("stroke-dasharray");
    expect(unsupportedStroke({ vectorEffect: "non-scaling-stroke" })).toBe("vector-effect");
  });
});

describe("quad", () => {
  it("returns the four corners of an axis-aligned glyph box", () => {
    expect(quad(0, 0, 0, 1, 2, 3, 4)).toEqual([1, 2, 4, 2, 4, 6, 1, 6]);
    expect(quad(10, 5, 0, 0, 0, 1, 1)).toEqual([10, 5, 11, 5, 11, 6, 10, 6]);
  });

  it("rotates the box about the glyph anchor", () => {
    const corners = quad(0, 0, Math.PI / 2, 1, 0, 1, 1);
    [0, 1, 0, 2, -1, 2, -1, 1].forEach((value, i) => {
      expect(corners[i]).toBeCloseTo(value, 9);
    });
  });
});

it("central baseline uses scaled font ascent/descent and rejects unavailable metrics", () => {
  expect(centralBaselineShift("central", { fontBoundingBoxAscent: 18, fontBoundingBoxDescent: 5 }, 1)).toBe(6.5);
  expect(centralBaselineShift("central", { fontBoundingBoxAscent: 36, fontBoundingBoxDescent: 10 }, 2)).toBe(6.5);
  expect(centralBaselineShift("auto", { fontBoundingBoxAscent: NaN, fontBoundingBoxDescent: NaN }, 1)).toBe(0);
  expect(centralBaselineShift("central", { fontBoundingBoxAscent: NaN, fontBoundingBoxDescent: 5 }, 1)).toBeNull();
  expect(centralBaselineShift("middle", { fontBoundingBoxAscent: 18, fontBoundingBoxDescent: 5 }, 1)).toBeNull();
  expect(unsupportedStyle({ dominantBaseline: "central" })).toBe("");
});
