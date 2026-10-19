import { describe, expect, it } from "vitest";
import {
  type GlyphHits,
  glyphCovers,
  glyphKey,
  glyphTarget,
  multiplyAffine,
  parseTransform,
  readGlyphReport
} from "./relief-pick";

// A 100x100 symbol: a filled square [10,40]^2 and a 4-wide horizontal stroke at y=80 from x=10 to 90.
const glyph: GlyphHits = {
  viewBox: [0, 0, 100, 100],
  primitives: [
    { rings: [[10, 10, 40, 10, 40, 40, 10, 40]], closed: [true], fill: { evenOdd: false }, stroke: null },
    { rings: [[10, 80, 90, 80]], closed: [false], fill: null, stroke: { halfWidth: 2, dashes: [], offset: 0, cap: 0 } }
  ]
};

describe("glyphCovers", () => {
  const icon = { x: 100, y: 200, s: 10 }; // scale 0.1
  it("hits painted fill and stroke, misses the rest of the sprite box", () => {
    expect(glyphCovers(glyph, icon, 102.5, 202.5, 0)).toBe(true);
    expect(glyphCovers(glyph, icon, 105, 208, 0)).toBe(true);
    expect(glyphCovers(glyph, icon, 107, 202, 0)).toBe(false); // in the box, off the paint
    expect(glyphCovers(glyph, icon, 105, 208.3, 0)).toBe(false); // beyond the stroke half width
    expect(glyphCovers(glyph, icon, 105, 208.3, 0.15)).toBe(true); // tolerance in world units
  });

  it("clips exactly at the <use> viewport, with no tolerance band outside", () => {
    const edge: GlyphHits = { ...glyph, primitives: [{ ...glyph.primitives[0], rings: [[0, 0, 100, 0, 100, 100, 0, 100]] }] };
    expect(glyphCovers(edge, icon, 110, 205, 0)).toBe(true);
    expect(glyphCovers(edge, icon, 110.01, 205, 5)).toBe(false);
  });

  it("centres a non-square viewBox (xMidYMid meet)", () => {
    // 200x100 viewBox in a 10 box: scale 0.05, content spans y 2.5..7.5
    const wide: GlyphHits = {
      viewBox: [0, 0, 200, 100],
      primitives: [{ rings: [[0, 0, 200, 0, 200, 100, 0, 100]], closed: [true], fill: { evenOdd: false }, stroke: null }]
    };
    expect(glyphCovers(wide, { x: 0, y: 0, s: 10 }, 5, 3, 0)).toBe(true);
    expect(glyphCovers(wide, { x: 0, y: 0, s: 10 }, 5, 2, 0)).toBe(false);
  });
});

function fakeUse(attrs: Record<string, string>, classes: string[] = []) {
  return {
    tagName: "use",
    id: attrs.id ?? "",
    getAttribute: (name: string) => attrs[name] ?? null,
    classList: { contains: (name: string) => classes.includes(name) }
  } as unknown as Element;
}
const fakeGroup = (children: Element[], isConnected = true) => ({ isConnected, children }) as unknown as Element;

describe("glyphTarget", () => {
  const icons = [
    { i: "#relief-hill-1", x: 1, y: 2, s: 3 },
    { i: "#relief-mount-1", x: 4.5, y: 5, s: 6 }
  ] as never;
  const uses = () => [
    fakeUse({ href: "#relief-hill-1", x: "1", y: "2", width: "3", height: "3" }),
    fakeUse({ "xlink:href": "#relief-mount-1", x: "4.5", y: "5", width: "6", height: "6" })
  ];

  it("returns the live <use> matching the indexed instance", () => {
    const children = uses();
    expect(glyphTarget(fakeGroup(children), icons, 1)).toBe(children[1]);
    expect(glyphKey(children[1])).toBe("|#relief-mount-1@4.5,5");
  });

  it("rejects detached groups, changed child counts, moved or culled uses", () => {
    expect(glyphTarget(fakeGroup(uses(), false), icons, 0)).toBeNull();
    expect(glyphTarget(fakeGroup(uses().slice(0, 1)), icons, 0)).toBeNull();
    const moved = uses();
    moved[0] = fakeUse({ href: "#relief-hill-1", x: "1.5", y: "2", width: "3", height: "3" });
    expect(glyphTarget(fakeGroup(moved), icons, 0)).toBeNull();
    const culled = uses();
    culled[0] = fakeUse({ href: "#relief-hill-1", x: "1", y: "2", width: "3", height: "3" }, ["viewport-culled"]);
    expect(glyphTarget(fakeGroup(culled), icons, 0)).toBeNull();
    expect(glyphTarget(fakeGroup(uses()), icons, 2)).toBeNull();
  });
});

describe("parseTransform", () => {
  const close = (actual: number[] | null, expected: number[]) =>
    expected.forEach((v, i) => expect(actual![i]).toBeCloseTo(v, 9));

  it("composes a transform list left to right, like nested groups", () => {
    expect(parseTransform(null)).toEqual([1, 0, 0, 1, 0, 0]);
    close(parseTransform("translate(10 20) scale(2)"), [2, 0, 0, 2, 10, 20]);
    close(parseTransform("rotate(90 5 5)"), [0, 1, -1, 0, 10, 0]);
    close(parseTransform("matrix(1,2,3,4,5,6)"), [1, 2, 3, 4, 5, 6]);
    close(parseTransform("skewX(45)"), [1, 0, 1, 1, 0, 0]);
    close(multiplyAffine([2, 0, 0, 2, 10, 20], [1, 0, 0, 1, 3, 4]), [2, 0, 0, 2, 16, 28]);
  });

  it("rejects what it cannot parse instead of ignoring it", () => {
    expect(parseTransform("translate(1 2) bogus(3)")).toBeNull();
    expect(parseTransform("scale(1 2 3)")).toBeNull();
    expect(parseTransform("translate(a)")).toBeNull();
  });
});

// Minimal SVG DOM for readGlyphReport: presentation attributes are the computed style (with SVG initial values), so a
// leaf's own computed value differs from the <use> shadow-tree inheritance only through the chain the reader walks.
interface FakeElement {
  tagName: string;
  children: FakeElement[];
  attrs: Record<string, string>;
}
const el = (tagName: string, attrs: Record<string, string> = {}, children: FakeElement[] = []): FakeElement => ({
  tagName,
  attrs,
  children
});
const CSS_KEYS: Record<string, string> = {
  fill: "fill",
  fillRule: "fill-rule",
  stroke: "stroke",
  strokeWidth: "stroke-width",
  strokeDasharray: "stroke-dasharray",
  strokeDashoffset: "stroke-dashoffset",
  strokeLinecap: "stroke-linecap",
  pointerEvents: "pointer-events",
  visibility: "visibility",
  display: "display",
  vectorEffect: "vector-effect"
};
const INITIAL: Record<string, string> = {
  fill: "rgb(0, 0, 0)",
  fillRule: "nonzero",
  stroke: "none",
  strokeWidth: "1px",
  strokeDasharray: "none",
  strokeDashoffset: "0px",
  strokeLinecap: "butt",
  pointerEvents: "visiblePainted",
  visibility: "visible",
  display: "inline",
  vectorEffect: "none"
};
function reportFor(symbol: FakeElement) {
  const wrap = (node: FakeElement): Element =>
    ({
      tagName: node.tagName,
      get children() {
        return node.children.map(wrap);
      },
      getAttribute: (name: string) => node.attrs[name] ?? null,
      hasAttribute: (name: string) => name in node.attrs,
      style: { getPropertyValue: () => "" },
      node
    }) as unknown as Element;
  const view = {
    getComputedStyle: (element: { node?: FakeElement }) =>
      Object.fromEntries(Object.entries(CSS_KEYS).map(([key, attr]) => [key, element.node?.attrs[attr] ?? INITIAL[key]]))
  };
  const doc = { defaultView: view, getElementById: (id: string) => (id === "s" ? wrap(symbol) : null) };
  return readGlyphReport({ ownerDocument: doc } as unknown as Element, "#s");
}

describe("readGlyphReport", () => {
  const icon = { x: 0, y: 0, s: 100 }; // symbol units = world units

  it("maps a leaf matrix transform onto the rings (swamp-2 style rect)", () => {
    const read = reportFor(
      el("symbol", { viewBox: "0 0 100 100" }, [
        el("rect", { x: "10", y: "10", width: "20", height: "10", transform: "matrix(-1 0 0 1 100 0)" })
      ])
    );
    expect(read.reason).toBeNull();
    // the rect is mirrored to x 70..90
    expect(glyphCovers(read.glyph!, icon, 80, 15, 0)).toBe(true);
    expect(glyphCovers(read.glyph!, icon, 20, 15, 0)).toBe(false);
  });

  it("flattens nested plain groups with their transforms and inherited fill (deciduous-3 style)", () => {
    const read = reportFor(
      el("symbol", { viewBox: "0 0 100 100", fill: "none" }, [
        el("g", { fill: "#d82e32", transform: "translate(50 0)" }, [
          el("g", { transform: "scale(2)" }, [el("circle", { cx: "5", cy: "5", r: "2" })])
        ]),
        el("circle", { cx: "5", cy: "50", r: "2" })
      ])
    );
    expect(read.reason).toBeNull();
    expect(glyphCovers(read.glyph!, icon, 60, 10, 0)).toBe(true); // (5,5)·2 + (50,0), r 4
    expect(glyphCovers(read.glyph!, icon, 5, 5, 0)).toBe(false); // untransformed position is not hit
    // the second circle inherits fill:none from the symbol, so it has no hit area
    expect(glyphCovers(read.glyph!, icon, 5, 50, 0)).toBe(false);
  });

  it("scales a stroke under a similarity transform", () => {
    const read = reportFor(
      el("symbol", { viewBox: "0 0 100 100" }, [
        el("g", { transform: "scale(2)" }, [el("line", { x1: "5", y1: "10", x2: "45", y2: "10", stroke: "#000", "stroke-width": "2" })])
      ])
    );
    expect(read.reason).toBeNull();
    expect(glyphCovers(read.glyph!, icon, 50, 21.8, 0)).toBe(true); // half width 2 in symbol units
    expect(glyphCovers(read.glyph!, icon, 50, 22.2, 0)).toBe(false);
  });

  it("keeps the href unsupported, with its reason, outside the subset", () => {
    const stroked = (transform: string) =>
      reportFor(
        el("symbol", { viewBox: "0 0 100 100" }, [
          el("path", { d: "M0,0L10,10", stroke: "#000", fill: "none", transform })
        ])
      );
    expect(stroked("scale(2 1)")).toEqual({ glyph: null, reason: "stroke under non-uniform transform on <path>" });
    expect(stroked("perspective(2)").reason).toBe("unparsed transform on <path>");
    const masked = reportFor(el("symbol", { viewBox: "0 0 100 100" }, [el("g", { mask: "url(#m)" }, [el("path", { d: "M0,0H9V9Z" })])]));
    expect(masked).toEqual({ glyph: null, reason: "mask on <g>" });
    const inner = reportFor(el("symbol", { viewBox: "0 0 100 100" }, [el("use", { href: "#x" })]));
    expect(inner.reason).toBe("element <use>");
  });
});
