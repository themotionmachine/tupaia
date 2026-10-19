import { describe, expect, it } from "vitest";
import { leafPath, type PickHit, resolveLeaf } from "./pick";
import { classifyElement, type SelectionSources, selectAt } from "./selection";

interface Fake {
  tagName: string;
  id: string;
  attrs: Record<string, string>;
  parent: Fake | null;
}

// Minimal element: the ancestry, attribute and closest() surface classifyElement reads.
function chain(...nodes: [tag: string, id: string, attrs?: Record<string, string>][]): Element {
  let parent: Fake | null = null;
  for (const [tagName, id, attrs = {}] of nodes) parent = { tagName, id, attrs, parent };
  return wrap(parent!);
}
function wrap(node: Fake): Element {
  return {
    tagName: node.tagName,
    id: node.id,
    get parentElement() {
      return node.parent && wrap(node.parent);
    },
    getAttribute: (name: string) => node.attrs[name] ?? null,
    closest(tag: string) {
      for (let n: Fake | null = node; n; n = n.parent) if (n.tagName === tag) return wrap(n);
      return null;
    }
  } as unknown as Element;
}

// Stable-identity element tree with children (leafPath/resolveLeaf and the ancestor identity check need it).
interface Node {
  tagName: string;
  id: string;
  parentElement: Node | null;
  children: Node[];
  getAttribute(name: string): string | null;
  closest(tag: string): Node | null;
}
function node(tagName: string, id: string, kids: Element[] = []): Element {
  const self: Node = {
    tagName,
    id,
    parentElement: null,
    children: kids as unknown as Node[],
    getAttribute: () => null,
    closest(tag: string) {
      for (let n: Node | null = self; n; n = n.parentElement) if (n.tagName === tag) return n;
      return null;
    }
  };
  for (const kid of self.children) kid.parentElement = self;
  return self as unknown as Element;
}

const hit = (id: string, layer = "layer"): PickHit => ({ layer, id, index: 0, order: 0 });
const sources = (over: Partial<SelectionSources>): SelectionSources => ({
  pick: () => null,
  world: (x, y) => [x / 2, y / 2],
  element: () => null,
  fallbacks: false,
  ...over
});

describe("classifyElement", () => {
  it("maps index elements to clicked() selections", () => {
    const burgLabel = chain(
      ["svg", "map"],
      ["g", "burgLabels"],
      ["g", "towns"],
      ["text", "burgLabel5", { "data-id": "5" }]
    );
    expect(classifyElement(burgLabel)).toEqual({ kind: "burg", id: "5", branch: "burgLabels" });
    const icon = chain(["g", "burgIcons"], ["g", "cities"], ["use", "burg9", { "data-id": "9" }]);
    expect(classifyElement(icon)).toEqual({ kind: "burg", id: "9", branch: "burgIcons" });
    const label = chain(["g", "labels"], ["g", "states"], ["text", "stateLabel3"]);
    expect(classifyElement(label)).toEqual({ kind: "label", id: "stateLabel3", branch: "labels" });
    const marker = chain(["g", "markers"], ["svg", "marker4"], ["circle", ""]);
    expect(classifyElement(marker)).toEqual({ kind: "marker", id: "marker4", branch: "markers" });
    expect(classifyElement(chain(["g", "rivers"], ["path", "river2"]))?.kind).toBe("river");
    expect(classifyElement(chain(["g", "routes"], ["g", "roads"], ["path", "route1"]))?.id).toBe("route1");
  });

  it("classifies an anonymous leaf by its own id and parent (PickHit.depth)", () => {
    // an id-less #ice polygon is indexed under #ice; clicked() sees ids ["", "ice", ...] and opens the ice editor
    const ice = chain(["svg", "map"], ["g", "ice"]);
    expect(classifyElement(ice)).toBeNull();
    expect(classifyElement(ice, 1)).toEqual({ kind: "ice", id: "", branch: "ice" });
    // an id-less coastline path under #sea_island: the selection id is the leaf's (""), not the group's
    const sea = chain(["g", "coastline"], ["g", "sea_island"]);
    expect(classifyElement(sea)).toEqual({ kind: "coastline", id: "sea_island", branch: "coastline" });
    expect(classifyElement(sea, 1)).toEqual({ kind: "coastline", id: "", branch: "coastline" });
  });

  it("returns null for layers clicked() has no branch for", () => {
    expect(classifyElement(chain(["g", "regions"], ["g", "statesBody"], ["path", "state1"]))).toBeNull();
  });
});

describe("selectAt", () => {
  const regions = chain(["g", "regions"], ["path", "state1"]);

  const glyph = { index: 2, key: "|#relief-hill-1@10,20" };

  it("fails closed on an unavailable index: no pick, no fallback", () => {
    const calls: string[] = [];
    const result = selectAt(
      sources({
        unavailable: () => "stale revision 3 < 4",
        pick: () => {
          calls.push("pick");
          return null;
        },
        fallbacks: true,
        pickBurg: () => {
          calls.push("burg");
          return 7;
        },
        peekRelief: () => {
          calls.push("relief");
          return glyph;
        }
      }),
      10,
      10
    );
    expect(result).toMatchObject({ kind: "none", branch: "unavailable", unavailable: "stale revision 3 < 4" });
    expect(result.world).toBeNull();
    expect(calls).toEqual([]);
  });

  it("an available index's empty hit still reaches the fallbacks", () => {
    const result = selectAt(sources({ unavailable: () => null, fallbacks: true, pickBurg: () => 7 }), 10, 10);
    expect(result).toMatchObject({ kind: "burg", id: "7", via: "pickBurg" });
  });

  it("an anonymous ice leaf selects ice via the index with no element target", () => {
    const ice = chain(["svg", "map"], ["g", "ice"]);
    const result = selectAt(
      sources({ pick: () => ({ ...hit("ice"), depth: 1 }), element: () => ice, fallbacks: true, pickBurg: () => 7 }),
      10,
      10
    );
    expect(result).toMatchObject({ kind: "ice", id: "", branch: "ice", via: "index", target: null });
  });

  it("targets the live anonymous leaf found by the hit path, re-checked against its ancestor", () => {
    const map = node("svg", "map", [node("g", "ice", [node("polygon", ""), node("polygon", "")])]);
    const ice = map.children[0];
    const leaf = ice.children[1];
    const path = leafPath(leaf, 1)!;
    expect(path).toEqual([1]);
    const pick = () => ({ ...hit("ice"), depth: 1, path });
    const leafOf = (h: PickHit, ancestor: Element) => resolveLeaf(ancestor, h.path!);
    const result = selectAt(sources({ pick, element: () => ice, leaf: leafOf }), 1, 1);
    expect(result).toMatchObject({ kind: "ice", id: "", branch: "ice", via: "index" });
    expect(result.target).toBe(leaf);
    // a leaf that is not `depth` below the ancestor (DOM moved) or classifies differently is no target
    const stray = node("polygon", "");
    expect(selectAt(sources({ pick, element: () => ice, leaf: () => stray }), 1, 1).target).toBeNull();
    const named = node("g", "ice", [node("polygon", "ice7")]);
    expect(selectAt(sources({ pick, element: () => ice, leaf: () => named.children[0] }), 1, 1).target).toBeNull();
    // no path resolver: null, never the ancestor
    expect(selectAt(sources({ pick, element: () => ice }), 1, 1).target).toBeNull();
    // resolveLeaf refuses a path through an [id] element or past the end
    expect(resolveLeaf(ice, [5])).toBeNull();
    expect(resolveLeaf(map, [0])).toBeNull();
  });

  it("prefers a selectable index hit and keeps the raw hit, consulting no fallback", () => {
    const label = chain(["g", "labels"], ["g", "states"], ["text", "stateLabel1"]);
    const calls: string[] = [];
    const result = selectAt(
      sources({
        pick: () => hit("stateLabel1"),
        element: () => label,
        fallbacks: true,
        pickBurg: () => {
          calls.push("burg");
          return 7;
        },
        peekRelief: () => {
          calls.push("relief");
          return glyph;
        }
      }),
      10,
      10
    );
    expect(result).toMatchObject({ kind: "label", id: "stateLabel1", via: "index", hit: hit("stateLabel1") });
    expect(result.target).toBe(label);
    expect(calls).toEqual([]);
  });

  it("routes a screen overlay hit (scale bar above a label) to the fallbacks, never to the label beneath", () => {
    const bar = chain(["svg", "map"], ["g", "scaleBar"], ["rect", "scaleBarBack"]);
    const result = selectAt(
      sources({
        pick: () => hit("scaleBarBack", "screen"),
        element: id => (id === "scaleBarBack" ? bar : null),
        fallbacks: true,
        pickBurg: () => null,
        peekRelief: () => glyph
      }),
      10,
      10
    );
    expect(result).toMatchObject({ kind: "relief", via: "pickRelief", hit: hit("scaleBarBack", "screen") });
  });

  it("falls back to pickBurg at the GPU world point under a non-selectable hit, before the relief", () => {
    const at: number[][] = [];
    const calls: string[] = [];
    const result = selectAt(
      sources({
        pick: () => hit("state1"),
        element: () => regions,
        fallbacks: true,
        pickBurg: (x, y) => {
          at.push([x, y]);
          calls.push("burg");
          return 12;
        },
        peekRelief: () => {
          calls.push("relief");
          return glyph;
        }
      }),
      40,
      20
    );
    expect(result).toMatchObject({ kind: "burg", id: "12", branch: "pickBurg", via: "pickBurg", relief: null });
    expect(at).toEqual([[20, 10]]);
    expect(calls).toEqual(["burg"]);
  });

  it("returns the peeked relief descriptor with a null target when no burg is there", () => {
    const result = selectAt(sources({ fallbacks: true, pickBurg: () => undefined, peekRelief: () => glyph }), 1, 1);
    expect(result).toMatchObject({ kind: "relief", id: glyph.key, branch: "pickRelief", via: "pickRelief" });
    expect(result.target).toBeNull();
    expect(result.relief).toBe(glyph);
  });

  it("reports an element-less terrain hit (materialized glyph) as unsupported, ahead of the fallbacks", () => {
    const calls: string[] = [];
    const result = selectAt(
      sources({
        pick: () => hit("#relief-hill-1", "terrain"),
        fallbacks: true,
        pickBurg: () => {
          calls.push("burg");
          return 5;
        },
        peekRelief: () => {
          calls.push("relief");
          return glyph;
        }
      }),
      1,
      1
    );
    expect(result).toMatchObject({ kind: "relief", id: "", branch: "terrain-unsupported", target: null, relief: null });
    expect(calls).toEqual([]);
    const group = chain(["svg", "map"], ["g", "terrain"]);
    const grouped = selectAt(sources({ pick: () => hit("terrain"), element: () => group, fallbacks: true }), 1, 1);
    expect(grouped).toMatchObject({ kind: "relief", branch: "terrain-unsupported", target: null });
  });

  it("targets the resolved <use> of a terrain pick instance, keyed like editReliefIcon", () => {
    const group = chain(["svg", "map"], ["g", "terrain"]);
    const use = chain(["g", "terrain"], ["use", "", { href: "#relief-hill-1", x: "10.5", y: "20" }]);
    const instance = { ...hit("terrain", "terrain"), instance: 3 };
    const asked: PickHit[] = [];
    const glyph = (h: PickHit) => {
      asked.push(h);
      return use;
    };
    const result = selectAt(sources({ pick: () => instance, element: () => group, glyph, fallbacks: true }), 1, 1);
    expect(result).toMatchObject({ kind: "relief", id: "|#relief-hill-1@10.5,20", branch: "terrain" });
    expect(result.target).toBe(use);
    expect(asked).toEqual([instance]);
    // a stale or unresolved instance, or a box hit with no instance, stays unsupported
    const stale = selectAt(sources({ pick: () => instance, element: () => group, glyph: () => null }), 1, 1);
    expect(stale).toMatchObject({ branch: "terrain-unsupported", target: null });
    const boxed = selectAt(sources({ pick: () => hit("terrain", "terrain"), element: () => group, glyph }), 1, 1);
    expect(boxed).toMatchObject({ branch: "terrain-unsupported", target: null });
    expect(asked).toHaveLength(1);
  });

  it("attaches the instance's href/index/reason as diagnostics without changing the outcome", () => {
    const group = chain(["svg", "map"], ["g", "terrain"]);
    const instance = { ...hit("terrain", "terrain"), instance: 7 };
    const info = { index: 7, href: "#relief-swamp-9", reason: "mask on <g>" };
    const result = selectAt(
      sources({
        pick: () => instance,
        element: () => group,
        glyph: () => null,
        glyphInfo: () => info,
        fallbacks: true
      }),
      1,
      1
    );
    expect(result).toMatchObject({ kind: "relief", id: "", branch: "terrain-unsupported", target: null, glyph: info });
  });

  it("skips the fallbacks when clicked() would (no window.pickRelief)", () => {
    const result = selectAt(sources({ pick: () => hit("state1"), element: () => regions, pickBurg: () => 3 }), 1, 1);
    expect(result).toMatchObject({ kind: "none", branch: "non-selectable", via: "none" });
    expect(selectAt(sources({ pick: () => hit("gone") }), 1, 1).branch).toBe("unresolved-id");
    expect(selectAt(sources({}), 1, 1).branch).toBe("none");
  });
});
