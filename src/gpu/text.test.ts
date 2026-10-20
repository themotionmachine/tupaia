import { describe, expect, it } from "vitest";
import { layoutOnPath } from "./geometry";
import { GLYPH_ATLAS_EDGE, glyph } from "./shaders";
import {
  centralBaselineShift,
  centralNestedShift,
  centralShiftAt,
  GLYPH_ATLAS,
  GLYPH_FLOATS,
  glyphAtlasRows,
  glyphRowSnap,
  inkColor,
  inkMismatch,
  kernedAdvances,
  kernOffsets,
  kernsBefore,
  letterSpacingPx,
  parseLength,
  presentAttribute,
  quad,
  shapingAdvanceError,
  shapingFeatures,
  shapingReason,
  spacedAdvances,
  startOffsetLength,
  strokeBeforeFill,
  svgCharPositions,
  textPathTargetId,
  unsupportedContent,
  unsupportedStroke,
  unsupportedStyle,
  wholeRun,
  wholeRunWidth
} from "./text";

const XLINK = "http://www.w3.org/1999/xlink";

function attributes(map: Record<string, string>, namespaced: Record<string, string> = {}) {
  return {
    getAttribute: (name: string) => map[name] ?? null,
    getAttributeNS: (ns: string, name: string) => (ns === XLINK ? (namespaced[name] ?? null) : null)
  };
}

describe("kernedAdvances", () => {
  it("is each character's own width without kerning", () => {
    expect(kernedAdvances("ab", s => [...s].length * 10)).toEqual([10, 10]);
  });

  it("moves the second character of a kern pair, as SVG does, and keeps the total width", () => {
    // "AV" kerns by -2: SVG starts V at 8 (A's advance becomes 8), and V keeps its own 10
    const width = (s: string) => [...s].length * 10 - (s.includes("AV") ? 2 : 0);
    expect(kernedAdvances("AV", width)).toEqual([8, 10]);
    expect(kernedAdvances("xAVx", width)).toEqual([10, 8, 10, 10]);
    expect(kernedAdvances("xAVx", width).reduce((a, b) => a + b)).toBe(width("xAVx"));
  });

  it("iterates code points, not UTF-16 units", () => {
    expect(kernedAdvances("😀a", s => [...s].length * 7)).toEqual([7, 7]);
    expect(kernedAdvances("", () => 1)).toEqual([]);
  });
});

describe("kernsBefore", () => {
  it("is the kern between each code point and the one before it", () => {
    const width = (s: string) => [...s].length * 10 - (s.includes("AV") ? 2 : 0) - (s.includes("VA") ? 3 : 0);
    expect(kernsBefore("AVA", width)).toEqual([0, -2, -3]);
    expect(kernsBefore("ab", s => [...s].length * 10)).toEqual([0, 0]);
    expect(kernsBefore("😀A", s => [...s].length * 7)).toEqual([0, 0]);
  });
});

describe("kernOffsets", () => {
  // "AVA": own widths 10, kerns A|V -2 and V|A -4
  const own = [10, 10, 10];
  const kerns = [0, -2, -4];

  it("moves a reported start by half its leading kern when the SVG split the kerns (legacy kern table)", () => {
    const reported = [10 - 1, 10 + (-2 - 4) / 2, 10 - 2];
    expect(kernOffsets(reported, own, kerns)).toEqual([0, -1, -2]);
  });

  it("leaves reported starts alone when the SVG kerned on the first advance (GPOS)", () => {
    expect(kernOffsets([8, 6, 10], own, kerns)).toEqual([0, 0, 0]);
  });

  it("adds letter-spacing to both readings and skips characters the SVG did not place", () => {
    expect(kernOffsets([9 + 3, null, 8 + 3], own, kerns, 3)).toEqual([0, -1, -2]);
    expect(kernOffsets([10, 10, 10], own, [0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe("wholeRun", () => {
  it("swaps spaces for no-break spaces so Canvas2D shapes across them, when the font gives both the same width", () => {
    const same = (s: string) => s.length * 5;
    expect(wholeRun("Ty. Wavy", same)).toBe("Ty.\u00a0Wavy");
    expect(wholeRunWidth(s => (s.length > 1 && s.includes(" ") ? 999 : s.length))("a b")).toBe(3);
  });

  it("keeps spaces when the no-break space is a different glyph", () => {
    const differs = (s: string) => (s === "\u00a0" ? 7 : s.length * 5);
    expect(wholeRun("a b", differs)).toBe("a b");
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

describe("glyphAtlasRows", () => {
  // instances whose cells end at the given bottom rows (v1 is normalized by the full atlas)
  const instances = (...bottoms: number[]) => {
    const data = new Float32Array(bottoms.length * GLYPH_FLOATS);
    bottoms.forEach((bottom, i) => {
      data[i * GLYPH_FLOATS + 10] = bottom / GLYPH_ATLAS;
    });
    return data;
  };

  it("keeps the rows down to the lowest cell bottom plus its transparent gutter row", () => {
    expect(glyphAtlasRows(instances(20, 57, 31))).toBe(58);
    // a few hundred glyphs on the parity fixture used ~90-350 rows: the GPU copy is that, not the 16 MiB full atlas
    expect(GLYPH_ATLAS * glyphAtlasRows(instances(350)) * 4).toBeLessThan(3 << 20);
  });

  it("never exceeds the atlas and is 0 without instances", () => {
    expect(glyphAtlasRows(instances(GLYPH_ATLAS))).toBe(GLYPH_ATLAS);
    expect(glyphAtlasRows(new Float32Array(0))).toBe(0);
    // the count bounds the scan (a payload's array may be longer than its instances)
    expect(glyphAtlasRows(instances(10, 900), 1)).toBe(11);
  });
});

describe("inkColor", () => {
  it("is the paint colour without its alpha, clamped, for the atlas mask's luminance", () => {
    expect(inkColor([62 / 255, 62 / 255, 75 / 255, 0.4])).toBe("rgb(62,62,75)");
    expect(inkColor([1.2, -0.1, 0.5, 1])).toBe("rgb(255,0,128)");
  });
});

describe("centralNestedShift", () => {
  it("rounds a half-CSS-px central shift up to a whole CSS px (Chromium's nested central baseline)", () => {
    // Almendra SC 22 px at k 1: extent says 7.5, painted 8; at k 2: 7.5 user units = 15 CSS px, painted as is
    expect(centralNestedShift(7.5, 1)).toBe(8);
    expect(centralNestedShift(7.5, 2)).toBe(7.5);
    // k 1.5, 14 px: 5 user units = 7.5 CSS px -> 8 CSS px
    expect(centralNestedShift(5, 1.5)).toBeCloseTo(8 / 1.5, 9);
    // whole CSS px (k 1.25: 4.8 user units = 6 CSS px) and float noise stay put
    expect(centralNestedShift(4.8, 1.25)).toBeCloseTo(4.8, 9);
    expect(centralNestedShift(6.0000001, 1)).toBe(6);
  });
});

describe("svgCharPositions", () => {
  const point = (x: number, y: number) => ({ x, y });
  function fakeText(starts: [number, number][], ends: [number, number][], rotations: number[]) {
    return {
      getNumberOfChars: () => starts.length,
      getStartPositionOfChar: (i: number) => point(...starts[i]),
      getEndPositionOfChar: (i: number) => point(...ends[i]),
      getRotationOfChar: (i: number) => rotations[i]
    } as unknown as SVGTextElement;
  }

  it("reads start, end, advance and angle per addressable character", () => {
    const text = fakeText(
      [
        [10, 20],
        [16, 20]
      ],
      [
        [16, 20],
        [16, 26]
      ],
      [0, 90]
    );
    const out = svgCharPositions(text, 2)!;
    expect(out[0]).toEqual({ x: 10, y: 20, ex: 16, ey: 20, advance: 6, angle: 0 });
    expect(out[1]!.advance).toBe(6);
    expect(out[1]!.angle).toBeCloseTo(Math.PI / 2);
  });

  it("marks a character the SVG does not render (reported at the origin with no advance)", () => {
    const text = fakeText(
      [
        [0, 0],
        [16, 20]
      ],
      [
        [0, 0],
        [22, 20]
      ],
      [0, 0]
    );
    expect(svgCharPositions(text, 2)).toEqual([null, { x: 16, y: 20, ex: 22, ey: 20, advance: 6, angle: 0 }]);
  });

  it("is null without SVG layout: no API, another character count, a throwing query, or nothing placed", () => {
    expect(svgCharPositions({} as SVGTextElement, 1)).toBeNull();
    const text = fakeText([[1, 1]], [[2, 1]], [0]);
    expect(svgCharPositions(text, 2)).toBeNull();
    const throwing = {
      ...text,
      getStartPositionOfChar: () => {
        throw new Error("IndexSizeError");
      }
    } as unknown as SVGTextElement;
    expect(svgCharPositions(throwing, 1)).toBeNull();
    expect(svgCharPositions(fakeText([[0, 0]], [[0, 0]], [0]), 1)).toBeNull();
  });
});

describe("shapingFeatures", () => {
  it("turns ligatures and contextual alternates off where Chromium does: optimizeSpeed or any letter-spacing", () => {
    expect(shapingFeatures("auto")).toBe("auto");
    expect(shapingFeatures("geometricPrecision")).toBe("auto");
    expect(shapingFeatures(undefined)).toBe("auto");
    expect(shapingFeatures("optimizeSpeed")).toBe("optimizeSpeed");
    expect(shapingFeatures("auto", 1.5)).toBe("optimizeSpeed");
  });
});

describe("shapingAdvanceError", () => {
  // own widths 10, "AV" kerns -2, "VA" -3 (text.test kernsBefore)
  const width = (s: string) => [...s].length * 10 - (s.includes("AV") ? 2 : 0) - (s.includes("VA") ? 3 : 0);
  const chars = [..."AVA"];

  it("is 0 when the SVG reports the painted pens (GPOS kerning)", () => {
    const reported = [
      { start: 5, advance: 8 },
      { start: 13, advance: 7 },
      { start: 20, advance: 10 }
    ];
    expect(shapingAdvanceError(chars, width, reported, 30)).toBeCloseTo(0);
  });

  it("is 0 when the SVG reports split legacy kerns half a kern early (kernOffsets)", () => {
    // painted 0, 8, 15; reported starts less half the leading kern: 0, 9, 16.5; advances own + (kern + next) / 2
    const reported = [
      { start: 0, advance: 9 },
      { start: 9, advance: 7.5 },
      { start: 16.5, advance: 8.5 }
    ];
    expect(shapingAdvanceError(chars, width, reported, 25)).toBeCloseTo(0);
  });

  it("measures a kern the widths cannot see (a space pair Canvas2D shapes word by word)", () => {
    const plain = (s: string) => [...s].length * 10;
    // SVG kerns ". W" by -3: W starts 3 early, and so does every later character and the end
    const reported = [
      { start: 0, advance: 10 },
      { start: 10, advance: 7 },
      { start: 17, advance: 10 },
      { start: 27, advance: 10 }
    ];
    expect(shapingAdvanceError([..." .WA"].slice(1).concat("x"), plain, reported, 37)).toBeCloseTo(3);
  });

  it("skips characters the SVG does not render", () => {
    const plain = (s: string) => [...s].length * 10;
    expect(
      shapingAdvanceError([..."abc"], plain, [{ start: 0, advance: 10 }, null, { start: 20, advance: 10 }], 30)
    ).toBe(0);
    expect(shapingAdvanceError([..."ab"], plain, [null, null], null)).toBe(0);
  });
});

describe("inkMismatch", () => {
  it("is the differing alpha over the first capture's alpha", () => {
    const a = new Uint8ClampedArray([0, 0, 0, 200, 0, 0, 0, 100, 0, 0, 0, 0]);
    const b = new Uint8ClampedArray([9, 9, 9, 200, 0, 0, 0, 40, 0, 0, 0, 30]);
    expect(inkMismatch(a, a)).toBe(0);
    expect(inkMismatch(a, b)).toBeCloseTo(90 / 300);
    expect(inkMismatch(new Uint8ClampedArray(8), b)).toBe(0);
  });
});

describe("shapingReason", () => {
  it("finds no mismatch without SVG text layout or a readable canvas (a test DOM) and for blank text", () => {
    expect(shapingReason("normal 400 32px Arial", "Office fluff")).toBe("");
    expect(shapingReason("normal 400 32px Arial", " ")).toBe("");
    expect(shapingReason("not a font", "abc")).toBe("");
  });
});

describe("glyphRowSnap (W3c: shaders.ts glyph rowSnap)", () => {
  // the straight "Haloed Straight" textPath of the parity fixture at k 1, dpr 2: 2 device rows per world unit, the
  // halo cell 33 texels high, its top half way between two rows (the GPU drew it 0.5 px above Skia's)
  it("moves an unrotated cell at atlas resolution onto a whole device row", () => {
    const dy = glyphRowSnap(0, 2, 16.5, 33, 1213.5);
    expect(1213.5 + dy * 2).toBe(1214);
    expect(1213.2 + glyphRowSnap(0, 2, 16.5, 33, 1213.2) * 2).toBeCloseTo(1213);
    // a world axis pointing up the screen still lands on a whole row
    const flipped = glyphRowSnap(0, -2, 16.5, 33, 226.25);
    expect(226.25 + flipped * -2).toBeCloseTo(226);
    // a half row goes down the screen, as Skia's floor(y + 0.5) does (shared label31 at k 2 went up a whole px when
    // the shader counted rows up from the bottom)
    expect(glyphRowSnap(0, 4, 8.25, 33, 700.5) * 4).toBe(0.5);
    // float32 noise either side of the half row goes the same way (label31's glyphs split 0.08 / 0.93 px without it)
    expect(700.4999 + glyphRowSnap(0, 4, 8.25, 33, 700.4999) * 4).toBeCloseTo(701);
    expect(700.5001 + glyphRowSnap(0, 4, 8.25, 33, 700.5001) * 4).toBeCloseTo(701);
    expect(700.49 + glyphRowSnap(0, 4, 8.25, 33, 700.49) * 4).toBeCloseTo(700);
    expect(glyphRowSnap(0, 2, 16.5, 33, 1214)).toBe(0);
  });

  it("leaves rotated and resampled cells where they are", () => {
    expect(glyphRowSnap(0.3, 2, 16.5, 33, 1213.5)).toBe(0); // a curved label's glyph: Skia does not snap it
    expect(glyphRowSnap(0, 2.4, 16.5, 33, 1213.5)).toBe(0); // between buckets: the cell is resampled
    expect(glyphRowSnap(0, 0, 16.5, 33, 1213.5)).toBe(0);
  });

  it("is what the glyph shader does", () => {
    expect(glyph.vs).toMatch(/world\.y \+= rowSnap\(/);
    expect(glyph.vs).toMatch(/abs\(a_anchor\.z\) > 1e-4/);
    expect(glyph.vs).toMatch(/floor\(rows \+ 0\.5 \+ 0\.0039\) - rows\) \/ perWorld/);
    expect(glyph.vs).toMatch(/float rows = \(1\.0 - \(u_matrix \* vec3\(top, 1\.0\)\)\.y\)/);
    expect(GLYPH_ATLAS).toBe(GLYPH_ATLAS_EDGE);
  });
});

describe("centralShiftAt", () => {
  it("rounds ascent and descent at the scaled font to whole CSS px and halves the difference", () => {
    // Georgia 12.59 px (box 0.917 / 0.219): k 1.3 -> round(15.01) - round(3.58) = 15 - 4 -> 5.5 CSS px
    expect(centralShiftAt(0.917 * 12.59, 0.219 * 12.59, 1, 1.3) * 1.3).toBeCloseTo(5.5);
    // k 1.5 -> round(17.32) - round(4.14) = 17 - 4 -> 6.5 CSS px
    expect(centralShiftAt(0.917 * 12.59, 0.219 * 12.59, 1, 1.5) * 1.5).toBeCloseTo(6.5);
  });

  it("rounds a nested box's shift up to a whole CSS px, and is 0 for mode 0", () => {
    expect(centralShiftAt(0.917 * 12.59, 0.219 * 12.59, 2, 1.5) * 1.5).toBeCloseTo(7);
    expect(centralShiftAt(0.917 * 12.59, 0.219 * 12.59, 2, 1.3) * 1.3).toBeCloseTo(6);
    expect(centralShiftAt(10, 2, 0, 1.5)).toBe(0);
    expect(centralShiftAt(10, 2, 1, 0)).toBe(0);
  });

  it("rounds half up, as Skia does", () => {
    // ascent 2.5, descent 0.5 CSS px at k 1: round -> 3 and 1
    expect(centralShiftAt(2.5, 0.5, 1, 1)).toBe(1);
  });
});
