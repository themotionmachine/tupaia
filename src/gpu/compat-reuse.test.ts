import { describe, expect, it } from "vitest";
import {
  CompatDirt,
  externalReference,
  neutralAttribute,
  type ReuseNode,
  type ReuseRecord,
  releaseShared,
  retain,
  type SheetLike,
  styleState,
  subject
} from "./compat-reuse";
import { classify, type MutationLike, pixelRecords } from "./markers";

// A minimal element tree: tag, id, attributes, children; querySelector understands comma lists of tags and #ids.
interface Fake extends ReuseNode {
  tagName: string;
  id: string;
  parentElement: Fake | null;
  children: Fake[];
  attrs: Map<string, string>;
  isConnected: boolean;
  getAttribute(name: string): string | null;
  getAttributeNames(): string[];
  querySelector(selectors: string): Fake | null;
  querySelectorAll(selectors: string): Fake[];
}

function el(tagName: string, id = "", parent: Fake | null = null, attrs: Record<string, string> = {}): Fake {
  const node: Fake = {
    tagName,
    id,
    parentElement: parent,
    children: [],
    attrs: new Map(Object.entries(attrs)),
    isConnected: true,
    getAttribute: name => node.attrs.get(name) ?? null,
    getAttributeNames: () => [...node.attrs.keys()],
    querySelector: selectors => node.querySelectorAll(selectors)[0] ?? null,
    querySelectorAll: selectors => {
      const parts = selectors.split(",").map(part => part.trim());
      const out: Fake[] = [];
      const visit = (item: Fake) => {
        for (const child of item.children) {
          if (
            parts.some(part =>
              part === "*" ? true : part.startsWith("#") ? child.id === part.slice(1) : child.tagName === part
            )
          )
            out.push(child);
          visit(child);
        }
      };
      visit(node);
      return out;
    }
  };
  parent?.children.push(node);
  return node;
}

const attr = (target: Fake, name: string, oldValue: string | null = "old"): ReuseRecord => ({
  type: "attributes",
  target,
  attributeName: name,
  oldValue,
  addedNodes: [],
  removedNodes: []
});
const children = (target: Fake, added: Fake[] = [], removed: Fake[] = []): ReuseRecord => ({
  type: "childList",
  target,
  addedNodes: added,
  removedNodes: removed
});
const text = (parent: Fake): ReuseRecord => ({
  type: "characterData",
  target: { nodeName: "#text", parentElement: parent },
  addedNodes: [],
  removedNodes: []
});

// svg#map > defs > pattern#hatch; #viewbox > #labels > text#a, text#b; #viewbox > #routes > path#r; #emblems > use#e
function world() {
  const svg = el("svg", "map");
  const defs = el("defs", "", svg);
  const hatch = el("pattern", "hatch", defs);
  const viewbox = el("g", "viewbox", svg);
  const labels = el("g", "labels", viewbox);
  const a = el("text", "a", labels);
  const tspan = el("tspan", "", a);
  const b = el("text", "b", labels);
  const routes = el("g", "routes", viewbox);
  const route = el("path", "r", routes);
  const emblems = el("g", "emblems", viewbox);
  const use = el("use", "e", emblems);
  return { svg, defs, hatch, viewbox, labels, a, tspan, b, routes, route, emblems, use };
}

// one tracker per test; runs stamped at the epoch they were "cut"
function setup() {
  const dirt = new CompatDirt();
  const w = world();
  const stamp = dirt.now();
  const runs = [
    { elements: [w.a, w.b], stamp },
    { elements: [w.use], stamp }
  ];
  return { dirt, w, runs };
}

describe("compat reuse tracker: what a change dirties", () => {
  it("keeps every run clean when nothing changed", () => {
    const { dirt, runs } = setup();
    expect(dirt.evaluate(runs, false)).toEqual(["", ""]);
  });

  it("dirties only the run whose subtree changed", () => {
    const { dirt, w, runs } = setup();
    dirt.note([attr(w.tspan, "dx")]);
    const why = dirt.evaluate(runs, false);
    expect(why[0]).toMatch(/changed <tspan>/);
    expect(why[1]).toBe("");
  });

  it("dirties a run whose own element changed, or whose text changed", () => {
    const { dirt, w, runs } = setup();
    dirt.note([attr(w.use, "href")]);
    expect(dirt.evaluate(runs, false)).toEqual(["", "changed <use#e>"]);
    const second = setup();
    second.dirt.note([text(second.w.tspan)]);
    expect(second.dirt.evaluate(second.runs, false)[0]).not.toBe("");
  });

  it("leaves runs clean when only native geometry elsewhere changed (route close)", () => {
    const { dirt, w, runs } = setup();
    const added = el("path", "r2", w.routes);
    dirt.note([
      attr(w.route, "d"),
      attr(w.route, "class"),
      children(w.routes, [added]),
      children(w.viewbox, [], [el("g", "debug")])
    ]);
    expect(dirt.evaluate(runs, false)).toEqual(["", ""]);
  });

  it("with sibling-dependent stylesheet rules, any change outside the runs dirties every run", () => {
    const { dirt, w, runs } = setup();
    dirt.note([attr(w.route, "d")]);
    expect(dirt.evaluate(runs, true).every(Boolean)).toBe(true);
    const second = setup();
    second.dirt.note([children(second.w.labels, [el("text", "c")])]);
    expect(second.dirt.evaluate(second.runs, false)).toEqual(["", ""]); // siblings alone cannot restyle a run
    expect(second.dirt.evaluate(second.runs, true).every(Boolean)).toBe(true);
  });

  it("dirties the runs under an ancestor whose attribute changed, not the runs outside it (zoom-end font-size)", () => {
    const { dirt, w, runs } = setup();
    dirt.note([attr(w.labels, "font-size")]);
    expect(dirt.evaluate(runs, false)).toEqual(["ancestor <g#labels>", ""]);
    // an ancestor of both runs dirties both
    const second = setup();
    second.dirt.note([attr(second.w.viewbox, "filter")]);
    expect(second.dirt.evaluate(second.runs, false)).toEqual(["ancestor <g#viewbox>", "ancestor <g#viewbox>"]);
  });

  it("with sibling-dependent stylesheet rules, an ancestor attribute dirties every run", () => {
    const { dirt, w, runs } = setup();
    dirt.note([attr(w.labels, "class")]);
    expect(dirt.evaluate(runs, true)).toEqual([
      "ancestor <g#labels> (structural CSS)",
      "ancestor <g#labels> (structural CSS)"
    ]);
  });

  it("ignores attribute writes that cannot reach a raster", () => {
    const { dirt, w, runs } = setup();
    w.viewbox.attrs.set("style", "cursor: crosshair");
    dirt.note([attr(w.viewbox, "style", "cursor: default"), attr(w.labels, "pointer-events")]);
    expect(dirt.evaluate(runs, false)).toEqual(["", ""]);
    w.viewbox.attrs.set("style", "cursor: crosshair; opacity: 0.5");
    dirt.note([attr(w.viewbox, "style", "cursor: default")]);
    expect(dirt.evaluate(runs, false).every(Boolean)).toBe(true);
  });

  it("dirties every run on any definition change", () => {
    const cases: ((w: ReturnType<typeof world>) => ReuseRecord)[] = [
      w => attr(w.hatch, "patternTransform"),
      w => children(w.defs, [el("filter", "glow")]),
      w => text(el("style", "", w.svg)),
      w => children(w.routes, [el("mask", "fog")]),
      w => {
        const group = el("g", "ruler");
        el("clipPath", "c", group);
        return children(w.viewbox, [], [group]);
      },
      () => attr(el("svg", "burgCOA1", el("g", "coas")), "viewBox")
    ];
    for (const make of cases) {
      const { dirt, w, runs } = setup();
      dirt.note([make(w)]);
      expect(dirt.evaluate(runs, false).every(why => why.startsWith("global: definition"))).toBe(true);
    }
  });

  it("dirties a run that moved under a new parent (inherits differently)", () => {
    const { dirt, w, runs } = setup();
    const moved = el("g", "group", w.viewbox);
    w.emblems.children.splice(w.emblems.children.indexOf(w.use), 1);
    w.use.parentElement = moved;
    moved.children.push(w.use);
    dirt.note([children(w.emblems, [], [w.use]), children(moved, [w.use])]);
    expect(dirt.evaluate(runs, false)).toEqual(["", "changed <use#e>"]);
    // a whole subtree re-inserted elsewhere: its runs' ancestry changed
    const second = setup();
    second.dirt.note([children(second.w.viewbox, [second.w.labels])]);
    expect(second.dirt.evaluate(second.runs, false)).toEqual(["moved with <g#labels>", ""]);
  });

  it("only counts changes after a run's stamp", () => {
    const dirt = new CompatDirt();
    const w = world();
    dirt.note([attr(w.tspan, "dx")]);
    dirt.all("font load");
    const stamp = dirt.now();
    expect(dirt.evaluate([{ elements: [w.a], stamp }], false)).toEqual([""]);
    expect(dirt.evaluate([{ elements: [w.a], stamp: stamp - 1 }], false)).toEqual(["global: font load"]);
    dirt.note([attr(w.tspan, "dy")]);
    expect(dirt.evaluate([{ elements: [w.a], stamp }], false)[0]).toMatch(/changed/);
  });

  it("prunes only entries no live stamp can need", () => {
    const dirt = new CompatDirt();
    const w = world();
    const stamp = dirt.now();
    dirt.note([attr(w.tspan, "dx")]);
    dirt.prune(stamp);
    expect(dirt.size).toBe(1);
    expect(dirt.evaluate([{ elements: [w.a], stamp }], false)[0]).not.toBe("");
    dirt.prune(dirt.now());
    expect(dirt.size).toBe(0);
  });

  it("fails closed when the tracker overflows", () => {
    const dirt = new CompatDirt(3);
    const w = world();
    const stamp = dirt.now();
    dirt.note([1, 2, 3, 4].map(i => attr(el("path", `p${i}`, w.routes), "d")));
    expect(dirt.evaluate([{ elements: [w.a], stamp }], false)).toEqual(["global: tracker overflow"]);
  });

  it("neutralAttribute compares the style declarations it changed", () => {
    const node = el("g", "viewbox");
    node.attrs.set("style", "cursor: default; fill: red");
    expect(neutralAttribute(attr(node, "style", "fill: red; cursor: crosshair"))).toBe(true);
    expect(neutralAttribute(attr(node, "style", "fill: blue; cursor: default"))).toBe(false);
    expect(neutralAttribute(attr(node, "cursor"))).toBe(true);
    expect(neutralAttribute(attr(node, "class"))).toBe(false);
  });
});

describe("compat reuse: references", () => {
  it("allows references into definitions and flags references to live map elements", () => {
    const w = world();
    const resolve = (id: string) => {
      const find = (node: Fake): Fake | null => {
        if (node.id === id) return node;
        for (const child of node.children) {
          const hit = find(child);
          if (hit) return hit;
        }
        return null;
      };
      return find(w.svg);
    };
    w.a.attrs.set("fill", "url(#hatch)");
    w.use.attrs.set("href", "#missing");
    expect(externalReference([w.a, w.b, w.use], resolve)).toBeNull();
    w.tspan.attrs.set("href", "#r"); // a route path in the world: its changes are invisible to the tracker
    expect(externalReference([w.a], resolve)).toBe("#r");
    w.tspan.attrs.delete("href");
    w.labels.attrs.set("style", "clip-path: url('#r')"); // through an ancestor
    expect(externalReference([w.a], resolve)).toBe("#r");
  });
});

describe("compat reuse: stylesheets", () => {
  const sheet = (rules: { cssText: string; selectorText?: string }[], extra: Partial<SheetLike> = {}): SheetLike => ({
    disabled: false,
    href: null,
    media: { mediaText: "" },
    cssRules: rules,
    ...extra
  });
  const rule = (selectorText: string, body = "fill: red") => ({
    selectorText,
    cssText: `${selectorText} { ${body}; }`
  });

  it("finds the subject of a selector", () => {
    expect(subject("#optionsContent table td:nth-of-type(1)")).toBe("td");
    expect(subject("body > .skiptranslate + div")).toBe("div");
    expect(subject(".checkbox:checked + .checkbox-label:before")).toBe(".checkbox-label");
    expect(subject(".separator:not(:empty)::before")).toBe(".separator");
    expect(subject("g:has(> .selected)")).toBe("g");
    expect(subject("li:nth-child(2n+1)")).toBe("li");
    expect(subject("[data-x~='a b'] ~ *")).toBe("*");
  });

  it("keys every rule that can style the clone, but not rules scoped to the live #map", () => {
    const applies = () => false;
    const base = styleState([sheet([rule("#labels text")])], applies).key;
    expect(styleState([sheet([rule("#labels text", "fill: blue")])], applies).key).not.toBe(base);
    expect(
      styleState([sheet([rule("#labels text"), rule("svg#map #emblems", "visibility: hidden")])], applies).key
    ).toBe(base);
    expect(styleState([sheet([rule("#labels text")], { disabled: true })], applies).key).not.toBe(base);
  });

  it("keys whether each media query holds, not only its text (resize, color-scheme flip)", () => {
    const applies = () => false;
    const media = {
      cssText: "@media (max-width: 600px) { #labels text { fill: red; } }",
      media: { mediaText: "(max-width: 600px)" },
      cssRules: [rule("#labels text")]
    };
    const narrow = (query: string) => query === "(max-width: 600px)" || query === "print";
    const wide = () => false;
    expect(styleState([sheet([media])], applies, narrow).key).not.toBe(styleState([sheet([media])], applies, wide).key);
    expect(styleState([sheet([media])], applies, wide).key).toBe(styleState([sheet([media])], applies, wide).key);
    const printSheet = sheet([rule("#labels text")], { media: { mediaText: "print" } });
    expect(styleState([printSheet], applies, narrow).key).not.toBe(styleState([printSheet], applies, wide).key);
  });

  it("reports sibling-dependent selectors only when their subject can match a map element", () => {
    const inMap = (selector: string) => selector === "text";
    expect(styleState([sheet([rule("div.header > div:first-child")])], inMap).structural).toBe("");
    expect(styleState([sheet([rule("#labels text + text")])], inMap).structural).toBe("#labels text + text");
    expect(styleState([sheet([rule("svg#map text + text")])], inMap).structural).toBe("");
  });

  it("treats an unreadable sheet as sibling-dependent unless it is a font sheet", () => {
    const unreadable = (href: string): SheetLike => ({
      disabled: false,
      href,
      media: null,
      get cssRules(): never {
        throw new Error("SecurityError");
      }
    });
    expect(styleState([unreadable("https://example.com/a.css")], () => false).structural).toMatch(/unreadable/);
    expect(styleState([unreadable("https://fonts.googleapis.com/css?family=X")], () => false).structural).toBe("");
  });
});

describe("compat reuse: shared textures", () => {
  it("frees a shared texture only when its last owner releases it", () => {
    const freed: object[] = [];
    const device = { release: (texture: object | null | undefined) => texture && freed.push(texture) };
    const texture = {};
    retain(texture); // previous frame + new frame
    releaseShared(device, texture);
    expect(freed).toEqual([]);
    releaseShared(device, texture);
    expect(freed).toEqual([texture]);
    const own = {};
    releaseShared(device, own);
    expect(freed).toEqual([texture, own]);
  });
});

describe("pixelRecords: what the tracker sees", () => {
  const node = (
    tagName: string,
    parent: MutationLike["target"] | null,
    id = "",
    attrs: Record<string, string> = {}
  ) => ({
    tagName,
    id,
    parentElement: parent,
    isConnected: true,
    getAttribute: (name: string) => attrs[name] ?? null
  });
  const record = (target: MutationLike["target"], attributeName: string, oldValue: string | null): MutationLike => ({
    type: "attributes",
    target,
    attributeName,
    oldValue,
    addedNodes: [],
    removedNodes: []
  });

  it("keeps the static and overlay records and drops neutral, transient and unchanged ones", () => {
    const svg = node("svg", null, "map");
    const viewbox = node("g", svg, "viewbox", { transform: "scale(2)" });
    const label = node("text", node("g", viewbox, "labels"), "l", { class: "" });
    const trade = node("g", viewbox, "tradeAnimation");
    const caravan = node("g", trade, "", { transform: "translate(1 2)" });
    const scaleBar = node("g", svg, "scaleBar", { width: "3" });
    const route = node("path", viewbox, "r", { d: "M0 0" });
    const records = [
      record(viewbox, "transform", "scale(1)"), // camera
      record(label, "class", "viewport-culled"), // neutral culling toggle
      record(caravan, "transform", "translate(0 0)"), // transient marker tick
      record(route, "d", "M0 0"), // unchanged value
      record(route, "d", "M1 1"), // static
      record(scaleBar, "width", "2") // overlay
    ];
    expect(pixelRecords(records)).toEqual([records[4], records[5]]);
    expect(classify(records)).toBe("static");
  });
});
