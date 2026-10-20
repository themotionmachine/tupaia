// @vitest-environment happy-dom
// Font embedding of the export clone (also the GPU compat clone): which declared fonts it embeds and the rule it emits.
import { afterEach, describe, expect, it } from "vitest";

import { cloneFonts, fontFace, fontFamilies } from "./export-fonts";

const page = globalThis as unknown as { fonts: unknown; getUsedFonts: unknown };
const declared = [
  { family: "Georgia" },
  { family: "Almendra SC", src: "url(a.woff2)", unicodeRange: "U+0000-00FF" },
  { family: "Amatic SC", src: "url(b.woff2)" },
  { family: "Great Vibes", src: "url(c.woff2)", variant: "italic" },
  { family: "Unused", src: "url(d.woff2)" }
];
afterEach(() => {
  delete (globalThis as Record<string, unknown>).fonts;
  delete (globalThis as Record<string, unknown>).getUsedFonts;
});

describe("fontFamilies", () => {
  it("unquotes and splits a CSS family list", () => {
    expect(fontFamilies(`"Almendra SC", 'Amatic SC',serif`)).toEqual(["Almendra SC", "Amatic SC", "serif"]);
  });
});

describe("cloneFonts", () => {
  it("embeds every declared family the clone names, not only label groups", () => {
    page.fonts = declared;
    page.getUsedFonts = () => [declared[0]];
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg"><style>#armies text {font-family: "Great Vibes"}</style>' +
      '<g id="labels"><g font-family="Georgia"/></g>' +
      '<g id="markers" style="font-size: 4px; font-family: &quot;Almendra SC&quot;, serif;"/>' +
      '<g id="burgLabels"><text font-family="Amatic SC">x</text></g></svg>';
    const svg = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
    expect(cloneFonts(svg as unknown as SVGSVGElement).map(font => font.family)).toEqual([
      "Georgia",
      "Almendra SC",
      "Amatic SC",
      "Great Vibes"
    ]);
  });
});

describe("fontFace", () => {
  it("emits only valid descriptors: font-style for the Google variant, no empty unicode-range, no font-variant", () => {
    expect(fontFace(declared[1])).toBe(
      '@font-face {font-family: "Almendra SC"; src: url(a.woff2); unicode-range: U+0000-00FF;}'
    );
    expect(fontFace(declared[3])).toBe(
      '@font-face {font-family: "Great Vibes"; src: url(c.woff2); font-style: italic;}'
    );
    expect(fontFace(declared[2])).not.toMatch(/font-variant|unicode-range/);
  });
});
