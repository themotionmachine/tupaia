import { describe, expect, it } from "vitest";
import { materializedIcons, parseColor, parseDashes, pointsToPath, urlId } from "./scene";

describe("materializedIcons", () => {
  const glyph = (attrs: Record<string, string>, tagName = "use") => ({
    tagName,
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    getAttribute: (name: string) => attrs[name] ?? null
  });
  const group = (...children: ReturnType<typeof glyph>[]) =>
    ({
      children,
      ownerDocument: { getElementById: (id: string) => (id.startsWith("relief-") ? {} : null) }
    }) as unknown as Element;
  const plain = { href: "#relief-hill-1", x: "12", y: "34", width: "8", height: "8" };

  it("reads prepareReliefIcons output back as the compact sprites", () => {
    const icons = materializedIcons(group(glyph(plain), glyph({ ...plain, class: "draggable", style: "touch-action:none" })));
    expect(icons).toEqual([
      { i: "#relief-hill-1", x: 12, y: 34, s: 8 },
      { i: "#relief-hill-1", x: 12, y: 34, s: 8 }
    ]);
  });

  it("keeps the group exact for any glyph compactRelief would keep as SVG", () => {
    const extras: Record<string, string>[] = [{ style: "fill:red" }, { transform: "rotate(20)" }, { id: "custom" }, { height: "9" }];
    for (const extra of extras)
      expect(materializedIcons(group(glyph(plain), glyph({ ...plain, ...extra })))).toBeNull();
    expect(materializedIcons(group(glyph({ ...plain, href: "#missing" })))).toBeNull();
    expect(materializedIcons(group(glyph(plain), glyph({}, "path")))).toBeNull();
    expect(materializedIcons(group())).toBeNull();
  });
});

const close = (actual: number[] | null, expected: number[]) => {
  expect(actual).not.toBeNull();
  expected.forEach((value, i) => {
    expect(actual?.[i]).toBeCloseTo(value, 6);
  });
};

describe("parseColor", () => {
  it("parses short, long and alpha hex with element opacity", () => {
    close(parseColor("#f00"), [1, 0, 0, 1]);
    close(parseColor("#00ff00"), [0, 1, 0, 1]);
    close(parseColor("#ff000080", 0.5), [1, 0, 0, (128 / 255) * 0.5]);
  });

  it("parses rgb and rgba in comma and space syntax", () => {
    close(parseColor("rgb(255, 128, 0)"), [1, 128 / 255, 0, 1]);
    close(parseColor("rgba(0 0 0 / 50%)"), [0, 0, 0, 0.5]);
    close(parseColor("rgba(255,255,255,0.25)", 0.5), [1, 1, 1, 0.125]);
  });

  it("returns null for none, transparent and malformed values", () => {
    for (const value of [null, undefined, "", "none", "transparent", "#12345", "rgb(1,2)", "rgb(a,b,c)"])
      expect(parseColor(value)).toBeNull();
  });
});

describe("parseDashes", () => {
  it("parses lists, treats none as solid and refuses percentages or negatives", () => {
    expect(parseDashes("none")).toEqual([]);
    expect(parseDashes(null)).toEqual([]);
    expect(parseDashes("4, 2 1")).toEqual([4, 2, 1]);
    expect(parseDashes("10%")).toBeNull();
    expect(parseDashes("2 -1")).toBeNull();
  });
});

describe("pointsToPath", () => {
  it("converts polyline points in mixed separators and drops a dangling coordinate", () => {
    expect(pointsToPath("1,2 3,4 5 6")).toBe("M1,2L3,4L5,6");
    expect(pointsToPath(" 1 2 3 ")).toBe("M1,2");
    expect(pointsToPath("")).toBe("");
  });
});

describe("urlId", () => {
  it("extracts local references with optional quotes", () => {
    expect(urlId("url(#hatch3)")).toBe("hatch3");
    expect(urlId(" url( '#mask-1' ) ")).toBe("mask-1");
    expect(urlId('url("#a")')).toBe("a");
    expect(urlId("url(other.svg#a)")).toBeNull();
    expect(urlId("none")).toBeNull();
    expect(urlId(null)).toBeNull();
  });
});
