import { afterEach, expect, it, vi } from "vitest";
import { getReliefIcons, prepareReliefSerialization } from "./relief-canvas";

afterEach(() => vi.unstubAllGlobals());
function use(extra: Record<string, string> = {}) {
  const attrs = { "xlink:href": "#relief-hill-1", x: "12", y: "34", width: "8", height: "8", ...extra };
  return {
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    getAttribute: (name: string) => attrs[name as keyof typeof attrs] ?? null
  };
}
it("reads legacy xlink glyph placements without changing their SVG", () => {
  const element = use();
  vi.stubGlobal("document", { querySelector: () => null, querySelectorAll: () => [element] });
  expect(getReliefIcons()).toEqual([{ i: "#relief-hill-1", x: 12, y: 34, s: 8 }]);
});
it("retains custom per-glyph styling and transforms as exact vectors", () => {
  for (const extra of [{ style: "fill:red" }, { transform: "rotate(20)" }, { id: "custom-relief" }] as Record<
    string,
    string
  >[]) {
    const element = use(extra);
    const createElement = vi.fn();
    vi.stubGlobal("document", {
      getElementById: () => ({ children: [element] }),
      querySelectorAll: () => [element],
      createElement
    });
    window.compactRelief();
    expect(createElement).not.toHaveBeenCalled();
  }
});

it("serializes canonical relief strings without constructing glyph DOM or retaining raster payload", () => {
  const data = [{ i: '#custom&"<$&', x: 12, y: 34, s: 8 }];
  const replaced = vi.fn();
  const image = {
    parentElement: { lookupNamespaceURI: () => "http://www.w3.org/2000/svg" },
    attributes: [
      { name: "data-relief", value: JSON.stringify(data) },
      { name: "href", value: "data:image/png;base64,large" }
    ],
    getAttribute: () => JSON.stringify(data),
    replaceWith: replaced
  };
  const comment = {};
  const createElementNS = vi.fn();
  vi.stubGlobal("document", { createComment: () => comment, createElementNS });
  const replacements = prepareReliefSerialization({ querySelectorAll: () => [image] } as unknown as ParentNode);
  expect(replaced).toHaveBeenCalledWith(comment);
  expect(createElementNS).not.toHaveBeenCalled();
  expect(replacements[0].markup).toBe('<use href="#custom&amp;&quot;&lt;$&amp;" x="12" y="34" width="8" height="8"/>');
  expect(replacements[0].marker.replace(replacements[0].marker, () => replacements[0].markup)).toBe(
    replacements[0].markup
  );
});

it("retains malformed relief metadata and supplies a namespace for prefixed SVG parents", () => {
  for (const value of ["bad JSON", JSON.stringify([{ i: "#hill", x: '" injected="yes', y: 1, s: 2 }])]) {
    const replaceWith = vi.fn();
    const image = { attributes: [], getAttribute: () => value, replaceWith };
    expect(prepareReliefSerialization({ querySelectorAll: () => [image] } as unknown as ParentNode)).toEqual([]);
    expect(replaceWith).not.toHaveBeenCalled();
  }
  vi.stubGlobal("document", { createComment: () => ({}) });
  const image = {
    parentElement: { lookupNamespaceURI: () => null },
    attributes: [],
    getAttribute: () => JSON.stringify([{ i: "#hill", x: 1, y: 2, s: 3 }]),
    replaceWith: vi.fn()
  };
  const output = prepareReliefSerialization({ querySelectorAll: () => [image] } as unknown as ParentNode);
  expect(output[0].markup.includes('<use xmlns="http://www.w3.org/2000/svg"')).toBe(true);
});
