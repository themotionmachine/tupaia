import { describe, expect, it } from "vitest";
import { resolveInClone } from "./clone-map";

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
