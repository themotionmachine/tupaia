import { afterEach, expect, it, vi } from "vitest";
import { commitRelief, getReliefIcons, prepareReliefSerialization } from "./relief-canvas";

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

// A #terrain holding one compact raster; writing innerHTML (the commit) replaces it with parsed <use> fakes.
function terrain(data: { i: string; x: number; y: number; s: number }[]) {
  const writes: string[] = [];
  // a fresh string per read, like a real attribute; the index must compare content, not identity
  const raster = { getAttribute: () => JSON.stringify(data) };
  let uses: { getAttribute(name: string): string | null }[] = [];
  let current: object | null = raster;
  let layer = true;
  const group = {
    set innerHTML(markup: string) {
      writes.push(markup);
      current = null;
      uses = Array.from(markup.matchAll(/<use ([^>]*)\/>/g), ([, body]) => {
        const attrs = Object.fromEntries(Array.from(body.matchAll(/(\w+)="([^"]*)"/g), ([, k, v]) => [k, v]));
        return { getAttribute: (name: string) => attrs[name] ?? null };
      });
    }
  };
  vi.stubGlobal("layerIsOn", () => layer);
  vi.stubGlobal("document", {
    getElementById: () => group,
    querySelector: () => current,
    querySelectorAll: () => uses
  });
  return {
    writes,
    raster,
    uses: () => uses,
    replace(next: object | null) {
      current = next;
    },
    setData(next: typeof data) {
      data = next;
    },
    toggle(on: boolean) {
      layer = on;
    }
  };
}
const glyphs = [
  { i: "#relief-hill-1", x: 10, y: 10, s: 8 },
  { i: "#relief-acacia-2", x: 12, y: 12, s: 8 }
];

it("peeks the topmost relief glyph from compact data without materializing, with a stable descriptor", () => {
  const scene = terrain(glyphs);
  const first = window.peekRelief(15, 15);
  expect(first).toMatchObject({ index: 1, key: "|#relief-acacia-2@12,12", raster: scene.raster });
  expect(window.peekRelief(15, 15)).toEqual(first);
  expect(window.peekRelief(11, 11)?.key).toBe("|#relief-hill-1@10,10");
  expect(window.peekRelief(40, 40)).toBeNull();
  expect(scene.writes).toEqual([]);
});

it("commits through legacy pickRelief to the <use> whose href@x,y is the peek key", () => {
  const scene = terrain(glyphs);
  const key = window.peekRelief(15, 15)!.key;
  const use = window.pickRelief(15, 15)!;
  expect(scene.writes).toHaveLength(1);
  expect(`|${use.getAttribute("href")}@${use.getAttribute("x")},${use.getAttribute("y")}`).toBe(key);
  // materialized: no raster to peek, and the index is dropped
  expect(window.peekRelief(15, 15)).toBeNull();
});

it("reindexes a replaced raster and drops a removed one; a stale peek does not commit", () => {
  const scene = terrain(glyphs);
  const stale = window.peekRelief(15, 15)!;
  const moved = { getAttribute: () => JSON.stringify([{ i: "#relief-dune-1", x: 30, y: 30, s: 4 }]) };
  scene.replace(moved);
  expect(window.peekRelief(15, 15)).toBeNull();
  expect(window.peekRelief(31, 31)).toMatchObject({ index: 0, key: "|#relief-dune-1@30,30", raster: moved });
  expect(commitRelief(stale)).toBeNull();
  expect(scene.writes).toEqual([]);
  scene.replace(null);
  expect(window.peekRelief(31, 31)).toBeNull();
});

it("commits the identical <use> the legacy pickRelief caller gets, keyed like the peek", () => {
  const scene = terrain(glyphs);
  const peek = window.peekRelief(15, 15)!;
  expect(commitRelief(peek)).toBe(scene.uses()[1]);
  const again = terrain(glyphs);
  expect(window.pickRelief(15, 15)).toBe(again.uses()[1]);
});

it("reindexes a same-length data edit on the same raster and rejects the stale peek", () => {
  const scene = terrain(glyphs);
  const stale = window.peekRelief(15, 15)!;
  // same raster, same revision, same serialized length: only the coordinates moved
  scene.setData([
    { i: "#relief-hill-1", x: 30, y: 30, s: 8 },
    { i: "#relief-acacia-2", x: 32, y: 32, s: 8 }
  ]);
  expect(JSON.stringify(glyphs).length).toBe(scene.raster.getAttribute().length);
  expect(commitRelief(stale)).toBeNull();
  expect(window.peekRelief(15, 15)).toBeNull();
  expect(window.peekRelief(35, 35)?.key).toBe("|#relief-acacia-2@32,32");
  expect(scene.writes).toEqual([]);
});

it("rejects a commit after the same raster node receives a different world", () => {
  const scene = terrain(glyphs);
  const stale = window.peekRelief(11, 11)!;
  scene.setData([{ i: "#relief-dune-1", x: 10, y: 10, s: 8 }]);
  // index 0 still covers the point, but the key differs: the stale peek must not open the new glyph
  expect(commitRelief(stale)).toBeNull();
  expect(scene.writes).toEqual([]);
  expect(window.peekRelief(11, 11)).toMatchObject({ index: 0, key: "|#relief-dune-1@10,10", raster: scene.raster });
});

it("does not peek or commit while the relief layer is off", () => {
  const scene = terrain(glyphs);
  const peek = window.peekRelief(15, 15)!;
  scene.toggle(false);
  expect(window.peekRelief(15, 15)).toBeNull();
  expect(commitRelief(peek)).toBeNull();
  expect(window.pickRelief(15, 15)).toBeNull();
  expect(scene.writes).toEqual([]);
  scene.toggle(true);
  expect(commitRelief(peek)).toBe(scene.uses()[1]);
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
