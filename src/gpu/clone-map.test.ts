import { describe, expect, it } from "vitest";
import { resolveInClone, resolveManyInClone } from "./clone-map";

function element(tagName: string, id = "", children: Element[] = [], attributes: string[] = []): Element {
  const node = {
    tagName,
    id,
    children,
    parentElement: null as Element | null,
    hasAttribute: (name: string) => attributes.includes(name)
  } as unknown as Element;
  for (const child of children) Object.assign(child, { parentElement: node });
  return node;
}

describe("canonical clone matching", () => {
  it("maps anonymous children beneath the renamed export root", () => {
    const source = element("rect");
    element("svg", "map", [source]);
    const counterpart = element("rect");
    const clone = element("svg", "fantasyMap", [counterpart]);
    expect(resolveInClone(source, clone)).toBe(counterpart);
  });

  it("distinguishes duplicate burg group IDs by their ancestry", () => {
    const source = element("g", "village");
    element("svg", "map", [element("g", "labels", [element("g", "village")]), element("g", "icons", [source])]);
    const wrong = element("g", "village");
    const correct = element("g", "village");
    const clone = element("svg", "fantasyMap", [element("g", "labels", [wrong]), element("g", "icons", [correct])]);
    expect(resolveInClone(source, clone)).toBe(correct);
  });

  it("uses same-tag order for anonymous siblings", () => {
    const source = element("use");
    element("svg", "map", [element("g", "freshwater", [element("path"), element("use"), source])]);
    const correct = element("use");
    const clone = element("svg", "fantasyMap", [
      element("g", "freshwater", [element("path"), element("use"), correct])
    ]);
    expect(resolveInClone(source, clone)).toBe(correct);
  });

  it("refuses to guess after a transient sibling was removed", () => {
    const source = element("image");
    element("svg", "map", [element("g", "terrain", [element("image", "", [], ["data-dense-zoom"]), source])]);
    const clone = element("svg", "fantasyMap", [element("g", "terrain", [element("image")])]);
    expect(resolveInClone(source, clone)).toBe("restructured parent");
  });

  it("refuses detached vector fragments without a map root", () => {
    const source = element("use");
    element("g", "freshwater", [source]);
    expect(resolveInClone(source, element("svg", "fantasyMap"))).toBe("detached element");
  });
});

describe("batched canonical clone matching", () => {
  it("preserves scalar identity and error behavior across duplicate IDs and anonymous siblings", () => {
    const cases = [
      [],
      [element("use", "same"), element("path", "same"), element("use", "same"), element("use")],
      [element("image", "", [], ["data-path-vectors"]), element("path"), element("path", "named")],
      [element("path"), element("image", "", [], ["data-dense-zoom"]), element("path", "named")],
      [element("path"), element("image", "", [], ["data-path-vectors"])],
      [element("path", "named"), element("path"), element("image", "", [], ["data-dense-zoom"])]
    ];
    for (const siblings of cases) {
      const sourceGroup = element("g", "group", siblings);
      const root = element("svg", "map", [element("g", "other", [element("use", "same")]), sourceGroup]);
      for (const missing of [false, true]) {
        const copies = siblings.map(child => element(child.tagName, child.id));
        if (missing) copies.pop();
        const clone = element("svg", "fantasyMap", [
          element("g", "other", [element("use", "same")]),
          element("g", "group", copies)
        ]);
        const lives = [root, root.children[0].children[0], sourceGroup, ...siblings, element("path", "detached")];
        const expected = lives.map(live => resolveInClone(live, clone));
        const actual = resolveManyInClone(lives, clone);
        actual.forEach((result, i) => {
          expect(result).toBe(expected[i]);
        });
      }
    }
  });

  it("rebuilds indexes after replacement of clone children in the same revision", () => {
    const live = element("use", "emblem");
    element("svg", "map", [element("g", "emblems", [live])]);
    const old = element("use", "emblem");
    const group = element("g", "emblems", [old]);
    const clone = element("svg", "fantasyMap", [group]);
    expect(resolveManyInClone([live], clone)[0]).toBe(old);
    const replacement = element("use", "emblem");
    Object.assign(group, { children: [replacement] });
    Object.assign(replacement, { parentElement: group });
    expect(resolveManyInClone([live], clone)[0]).toBe(replacement);
    Object.assign(group, { children: [] });
    expect(resolveManyInClone([live], clone)[0]).toBe("missing #emblem");
  });

  it("scans sibling collections once per parent instead of once per requested child", () => {
    const lives = Array.from({ length: 2000 }, (_, i) => element("use", i % 2 ? "duplicate" : ""));
    const copies = lives.map(child => element(child.tagName, child.id));
    const liveGroup = element("g", "emblems", lives);
    element("svg", "map", [liveGroup]);
    const cloneGroup = element("g", "emblems", copies);
    const clone = element("svg", "fantasyMap", [cloneGroup]);
    let reads = 0;
    Object.defineProperty(liveGroup, "children", {
      get: () => {
        reads++;
        return lives;
      }
    });
    Object.defineProperty(cloneGroup, "children", {
      get: () => {
        reads++;
        return copies;
      }
    });
    const actual = resolveManyInClone(lives, clone);
    actual.forEach((result, i) => {
      expect(result).toBe(copies[i]);
    });
    expect(reads).toBe(2);
  });
});
