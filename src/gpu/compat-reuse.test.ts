import { describe, expect, it } from "vitest";
import {
  CompatDirt,
  externalReference,
  neutralAttribute,
  type ReuseNode,
  type ReuseRecord,
  referenceClosure,
  releaseShared,
  retain,
  type SheetLike,
  sameExternals,
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
              part === "*"
                ? true
                : part === "[id]"
                  ? !!child.id
                  : part.startsWith("#")
                    ? child.id === part.slice(1)
                    : child.tagName === part
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

  it("without reference closures, dirties every run on any definition change", () => {
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
      expect(dirt.evaluate(runs, false).every(why => /definition/.test(why))).toBe(true);
    }
  });

  // run 0 (labels) paints through nothing; run 1 (the emblem) names #hatch, #burgCOA1 and #c
  const named = [new Set<string>(), new Set(["hatch", "burgCOA1", "c"])];

  it("dirties only the runs that paint through a changed definition (emblems generated on zoom)", () => {
    const cases: [string, (w: ReturnType<typeof world>) => ReuseRecord][] = [
      ["pattern attribute", w => attr(w.hatch, "patternTransform")],
      ["inside a referenced definition", w => attr(el("path", "", w.hatch), "d")],
      ["COA added", () => children(el("g", "coas"), [el("svg", "burgCOA1")])],
      [
        "COA with its <style> added",
        () => {
          const coa = el("svg", "burgCOA1");
          el("style", "", el("defs", "", coa));
          return children(el("g", "coas"), [coa]);
        }
      ],
      [
        "clip path removed with a group",
        w => {
          const group = el("g", "ruler");
          el("clipPath", "c", group);
          return children(w.viewbox, [], [group]);
        }
      ],
      ["renamed to a referenced id", w => attr(el("pattern", "hatch2", w.defs), "id", "hatch")]
    ];
    for (const [label, make] of cases) {
      const { dirt, w, runs } = setup();
      dirt.note([make(w)]);
      const why = dirt.evaluate(runs, false, named);
      expect(why[0], label).toBe("");
      expect(why[1], label).toMatch(/definition/);
    }
    // a definition no run names dirties nothing
    const { dirt, w, runs } = setup();
    dirt.note([children(w.defs, [el("filter", "glow")])]);
    expect(dirt.evaluate(runs, false, named)).toEqual(["", ""]);
  });

  it("dirties every run when the change acts on the whole document or a stylesheet names the definition", () => {
    const cases: [string, (w: ReturnType<typeof world>) => ReuseRecord][] = [
      ["style text", w => text(el("style", "", w.defs))],
      ["link added", w => children(w.defs, [el("link")])],
      [
        "font inside an added group",
        w => {
          const group = el("g", "fonts");
          el("font-face", "", group);
          return children(w.defs, [group]);
        }
      ],
      ["id renamed, old value unknown", w => ({ ...attr(el("pattern", "x", w.defs), "id"), oldValue: undefined })]
    ];
    for (const [label, make] of cases) {
      const { dirt, w, runs } = setup();
      dirt.note([make(w)]);
      expect(dirt.evaluate(runs, false, named), label).toEqual(
        expect.arrayContaining([expect.stringMatching(/^global: definition/)])
      );
      expect(dirt.evaluate(runs, false, named).every(Boolean), label).toBe(true);
    }
    const { dirt, w, runs } = setup();
    dirt.note([children(w.defs, [el("filter", "glow")])]);
    expect(dirt.evaluate(runs, false, named, new Set(["glow"])).every(why => /named by a stylesheet/.test(why))).toBe(
      true
    );
    // W4 RESUME: only the runs the naming rules reach, when the caller knows (prepare.ts styleReach); unknown: every run
    const reach = (id: string) => (id === "glow" ? (i: number) => i === 0 : null);
    const scoped = dirt.evaluate(runs, false, named, new Set(["glow"]), undefined, reach);
    expect(scoped[0]).toMatch(/named by a stylesheet/);
    expect(scoped.slice(1).every(why => why === "")).toBe(true);
    const unknown = dirt.evaluate(runs, false, named, new Set(["glow"]), undefined, () => null);
    expect(unknown.every(why => /named by a stylesheet/.test(why))).toBe(true);
  });

  it("notes definitions outside #map in one epoch, and prunes them", () => {
    const dirt = new CompatDirt();
    const stamp = dirt.now();
    const coas = el("g", "coas");
    dirt.noteDefinitions([children(coas, [el("svg", "burgCOA1")]), children(coas, [el("svg", "burgCOA2")])], "outside");
    expect(dirt.now()).toBe(stamp + 1);
    const runs = [{ elements: [el("use", "u")], stamp }];
    expect(dirt.evaluate(runs, false, [new Set(["burgCOA2"])])[0]).toMatch(/outside <g#coas> \(#burgCOA2\)/);
    expect(dirt.evaluate(runs, false, [new Set(["stateCOA1"])])).toEqual([""]);
    dirt.prune(dirt.now());
    expect(dirt.size).toBe(0);
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

  it("[COMPAT] follows a definition to the live element it references (halo clip <use href=#state1>)", () => {
    const w = world();
    const clip = el("clipPath", "clip1", w.defs);
    const use = el("use", "", clip, { href: "#r" });
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
    w.a.attrs.set("clip-path", "url(#clip1)");
    expect(externalReference([w.a], resolve)).toBe("#r");
    use.attrs.set("href", "#missing");
    expect(externalReference([w.a], resolve)).toBeNull();
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
    // the svg-cover's rules sit in `@media screen` (svg-cover.ts): applied or not, they key as nothing
    const cover = {
      cssText:
        "@media screen { svg#map > #viewbox { visibility: hidden; } svg#map > #viewbox text { visibility: visible; } }",
      media: { mediaText: "screen" },
      cssRules: [
        rule("svg#map > #viewbox", "visibility: hidden"),
        rule("svg#map > #viewbox text", "visibility: visible")
      ]
    };
    const covered = [sheet([rule("#labels text")]), sheet([cover])];
    expect(styleState(covered, applies).key).toBe(styleState([sheet([rule("#labels text")]), sheet([])], applies).key);
  });

  it("keys consecutive identical sheets as one (an emblem generated on zoom), and nothing else", () => {
    const applies = () => false;
    const svgStyle = { namespaceURI: "http://www.w3.org/2000/svg", textContent: "g.secondary{fill:var(--secondary)}" };
    const coa = () => sheet([], { disabled: true, ownerNode: svgStyle });
    const shared = sheet([rule("g.secondary", "fill: var(--secondary)")]);
    const app = sheet([rule("#labels text")]);
    const key = (sheets: SheetLike[]) => styleState(sheets, applies).key;
    expect(key([app, coa(), coa(), shared])).toBe(key([app, coa(), shared]));
    expect(key([app, coa(), coa(), coa(), coa(), shared])).toBe(key([app, coa(), shared]));
    // not consecutive: a sheet between the copies can lose to the later one
    expect(key([app, coa(), app, coa(), shared])).not.toBe(key([app, coa(), shared]));
    // a disabled svg <style> still styles the serialized clone: its text is keyed
    const edited = sheet([], { disabled: true, ownerNode: { ...svgStyle, textContent: "g.secondary{fill:red}" } });
    expect(key([app, edited, shared])).not.toBe(key([app, coa(), shared]));
  });

  it("collects the ids the rules name", () => {
    const state = styleState(
      [sheet([rule("#ocean", "fill: url(#oceanPattern)"), rule("path", 'filter: url("#blur")')])],
      () => false
    );
    expect([...state.references].sort()).toEqual(["blur", "oceanPattern"]);
  });

  it("scopes each named id to the selectors of the plain rules naming it (W4 RESUME)", () => {
    const media = {
      cssText: "@media screen { #rivers { mask: url(#land); } }",
      media: { mediaText: "screen" },
      cssRules: [rule("#rivers", "mask: url(#land)")]
    };
    const font = { cssText: '@font-face { font-family: X; src: url("#font"); }' };
    const state = styleState(
      [sheet([rule("#landmass", "mask: url(#land)"), rule("#texture, #statesBody", "mask: url(#land)"), media, font])],
      () => false
    );
    expect(state.scopes.get("land")).toEqual(["#landmass", "#texture, #statesBody", "#rivers"]);
    expect(state.scopes.get("font")).toBeNull();
    // a rule scoped to the live #map styles no clone element: it neither names nor scopes
    expect(styleState([sheet([rule("svg#map #x", "fill: url(#paint)")])], () => false).scopes.has("paint")).toBe(false);
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

// COST2 item 5: the closure narrowing of a6a2c75c (a definition change dirties only the runs that paint through it),
// case by case through the whole path: referenceClosure on the run, the tracker's note() on the change, evaluate().
describe("compat reuse: reference closures (definition narrowing)", () => {
  const finder = (...roots: Fake[]) => {
    const find = (node: Fake, id: string): Fake | null => {
      if (node.id === id) return node;
      for (const child of node.children) {
        const hit = find(child, id);
        if (hit) return hit;
      }
      return null;
    };
    return (id: string) => {
      for (const root of roots) {
        const hit = find(root, id);
        if (hit) return hit;
      }
      return null;
    };
  };
  // the map, plus svg#defElements outside it (#coas, icon symbols, hatching)
  function scene() {
    const w = world();
    const outside = el("svg", "defElements");
    const coas = el("g", "coas", outside);
    const icons = el("defs", "", outside);
    return { ...w, outside, coas, icons, resolve: finder(w.svg, outside) };
  }
  type Scene = ReturnType<typeof scene>;
  // run 0 is the subject; run 1 (route labels) paints through nothing but #other
  const judge = (sc: Scene, subject: Fake[], change: (sc: Scene) => ReuseRecord, outside = false) => {
    const dirt = new CompatDirt();
    const stamp = dirt.now();
    const other = el("text", "o", sc.labels, { fill: "url(#other)" });
    el("pattern", "other", sc.defs);
    const runs = [
      { elements: subject, stamp },
      { elements: [other], stamp }
    ];
    const closures = runs.map(run => referenceClosure(run.elements, sc.resolve));
    const record = change(sc);
    if (outside) dirt.noteDefinitions([record], "outside #map");
    else dirt.note([record]);
    return dirt.evaluate(
      runs,
      false,
      closures.map(c => c.ids),
      new Set(),
      closures.map(c => [...c.externals.values()])
    );
  };

  it("<use> chains: a symbol reached through another <use> definition", () => {
    const sc = scene();
    const sym = el("symbol", "anchor", sc.icons);
    const glyph = el("path", "", sym, { d: "M0 0" });
    const wrapper = el("symbol", "wrap", sc.defs);
    el("use", "", wrapper, { href: "#anchor" });
    const icon = el("use", "i", sc.emblems, { href: "#wrap" });
    expect([...referenceClosure([icon], sc.resolve).ids].sort()).toEqual(["anchor", "wrap"]);
    const why = judge(sc, [icon], () => attr(glyph, "d"), true);
    expect(why[0]).toMatch(/#anchor/);
    expect(why[1]).toBe("");
  });

  it("pattern to pattern: a pattern inheriting another's content by href", () => {
    const sc = scene();
    const base = el("pattern", "hatch1", sc.icons);
    const line = el("line", "", base);
    el("pattern", "hatchZoom", sc.defs, { href: "#hatch1" });
    const zone = el("path", "z", sc.routes, { fill: "url(#hatchZoom)" });
    const why = judge(sc, [zone], () => attr(line, "stroke"), true);
    expect(why[0]).toMatch(/#hatch1/);
    expect(why[1]).toBe("");
    // the inheriting pattern itself
    const again = scene();
    const inherit = el("pattern", "hatchZoom", again.defs, { href: "#hatch1" });
    el("pattern", "hatch1", again.icons);
    const zone2 = el("path", "z", again.routes, { fill: "url(#hatchZoom)" });
    expect(judge(again, [zone2], () => attr(inherit, "patternTransform"))[0]).toMatch(/#hatchZoom/);
  });

  it("clipPath: a change inside the clip path, and a clip path no run uses", () => {
    const sc = scene();
    const clip = el("clipPath", "clip", sc.defs);
    const shape = el("rect", "", clip);
    const fog = el("g", "fog", sc.viewbox, { "clip-path": "url(#clip)" });
    const why = judge(sc, [fog], () => attr(shape, "width"));
    expect(why[0]).toMatch(/#clip/);
    expect(why[1]).toBe("");
    const other = scene();
    const unused = el("clipPath", "unused", other.defs);
    const fog2 = el("g", "fog", other.viewbox, { "clip-path": "url(#clip)" });
    el("clipPath", "clip", other.defs);
    expect(judge(other, [fog2], () => attr(el("rect", "", unused), "width"))).toEqual(["", ""]);
  });

  it("textPath: a curve in the definitions is narrowed; a curve on the map is watched", () => {
    const sc = scene();
    const textPaths = el("g", "textPaths", sc.defs);
    const curve = el("path", "textPath_label1", textPaths, { d: "M0 0" });
    const label = el("text", "label1", sc.labels);
    el("textPath", "", label, { href: "#textPath_label1" });
    const why = judge(sc, [label], () => attr(curve, "d"));
    expect(why[0]).toMatch(/#textPath_label1/);
    expect(why[1]).toBe("");
    // a textPath naming a route path on the map: an external reference, watched by the tracker
    const map = scene();
    const label2 = el("text", "label2", map.labels);
    el("textPath", "", label2, { href: "#r" });
    const closure = referenceClosure([label2], map.resolve);
    expect(closure.external).toBe("#r");
    expect([...closure.externals.values()]).toEqual([map.route]);
    expect(judge(map, [label2], m => attr(m.route, "d"))[0]).toBe("reference <path#r> changed");
    expect(judge(map, [label2], m => attr(el("path", "r9", m.routes), "d"))).toEqual(["", ""]);
  });

  it("COA symbols: an emblem through its COA in #coas to the charge it uses", () => {
    const sc = scene();
    const coa = el("svg", "burgCOA1", sc.coas);
    const charge = el("g", "charge_lion", el("defs", "", coa));
    el("use", "", coa, { href: "#charge_lion" });
    const emblem = el("use", "e1", sc.emblems, { href: "#burgCOA1" });
    expect([...referenceClosure([emblem], sc.resolve).ids].sort()).toEqual(["burgCOA1", "charge_lion"]);
    const why = judge(sc, [emblem], () => attr(el("path", "", charge), "d"), true);
    expect(why[0]).toMatch(/charge_lion|burgCOA1/);
    expect(why[1]).toBe("");
    // another burg's COA arriving leaves this emblem clean
    expect(judge(scene(), [emblem], s => children(s.coas, [el("svg", "burgCOA2")]), true)).toEqual(["", ""]);
  });

  it("filters: a filter and the image a primitive pulls in", () => {
    const sc = scene();
    const filter = el("filter", "dropShadow", sc.defs);
    const offset = el("feOffset", "", filter);
    el("feImage", "", filter, { href: "#shadowTile" });
    const tile = el("image", "shadowTile", sc.defs);
    const coast = el("g", "sea_island", sc.viewbox, { filter: "url(#dropShadow)" });
    expect([...referenceClosure([coast], sc.resolve).ids].sort()).toEqual(["dropShadow", "shadowTile"]);
    expect(judge(sc, [coast], () => attr(offset, "dx"))[0]).toMatch(/#dropShadow/);
    expect(judge(sc, [coast], () => attr(tile, "href"))[0]).toMatch(/#shadowTile/);
  });

  it("references from an ancestor's style count, and a later rename into a named id", () => {
    const sc = scene();
    sc.labels.attrs.set("style", "mask: url('#fogMask')");
    const label = el("text", "l", sc.labels);
    expect(referenceClosure([label], sc.resolve).ids.has("fogMask")).toBe(true);
    // a definition renamed to the id the run names (it was unresolved before)
    const renamed = el("mask", "fogMask", sc.defs);
    expect(judge(sc, [label], () => attr(renamed, "id", "oldMask"))[0]).toMatch(/#fogMask/);
  });

  it("an external target replaced or removed is not the one the raster was cut with", () => {
    const sc = scene();
    const halo = el("path", "h", sc.routes, { "clip-path": "url(#stateClip)" });
    el("use", "", el("clipPath", "stateClip", sc.defs), { href: "#r" });
    const cut = referenceClosure([halo], sc.resolve).externals;
    expect(sameExternals(cut, referenceClosure([halo], sc.resolve).externals)).toBe(true);
    // the states redrawn: #r is a new element
    sc.routes.children.splice(sc.routes.children.indexOf(sc.route), 1);
    const redrawn = el("path", "r", sc.routes);
    expect(referenceClosure([halo], sc.resolve).externals.get("r")).toBe(redrawn);
    expect(sameExternals(cut, referenceClosure([halo], sc.resolve).externals)).toBe(false);
    // removed: the id resolves to nothing now
    sc.routes.children.length = 0;
    expect(sameExternals(cut, referenceClosure([halo], sc.resolve).externals)).toBe(false);
    // nothing external: always the same
    expect(sameExternals(undefined, new Map())).toBe(true);
    expect(sameExternals(undefined, cut)).toBe(false);
  });
});
