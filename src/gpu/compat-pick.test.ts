import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Affine,
  boxCorners,
  compatShapes,
  compatShapesBatch,
  dashHitRings,
  layoutSnap,
  pickDepth,
  pickId,
  rasterHits,
  relative,
  resScale,
  shapePath,
  strokeHitRings,
  textCells
} from "./compat-pick";
import { PickIndex } from "./pick";

describe("pickDepth", () => {
  it("counts the steps from an anonymous leaf to its [id] ancestor", () => {
    const map = { id: "map", parentElement: null };
    const ice = { id: "ice", parentElement: map };
    expect(pickDepth({ id: "", parentElement: ice })).toBe(1);
    expect(pickDepth({ id: "", parentElement: { id: "", parentElement: ice } })).toBe(2);
    expect(pickDepth(ice)).toBe(0);
    expect(pickDepth({ id: "", parentElement: null })).toBe(0);
  });
});

describe("strokeHitRings", () => {
  it("takes the dash rings for a dashed stroke and the fine rings otherwise", () => {
    let flattened = 0;
    let dashed = 0;
    const fine = () => {
      flattened++;
      return [[0, 0, 5, 0.1, 10, 0]];
    };
    const dash = () => {
      dashed++;
      return [[0, 0, 3, 0, 4, 0]];
    };
    expect(strokeHitRings(dash, fine)).toEqual([[0, 0, 3, 0, 4, 0]]);
    expect(dashed).toBe(1);
    expect(flattened).toBe(0);
    expect(strokeHitRings(null, fine)).toEqual([[0, 0, 5, 0.1, 10, 0]]);
    expect(flattened).toBe(1);
    expect(dashed).toBe(1);
  });
});

describe("resScale", () => {
  it("is the square root of the viewbox CTM's area scale, 1 without a transform", () => {
    expect(resScale({ getScreenCTM: () => ({ a: 2, b: 0, c: 0, d: 2, e: 5, f: 5 }) })).toBe(2);
    expect(resScale({ getScreenCTM: () => ({ a: 0, b: 3, c: -3, d: 0, e: 0, f: 0 }) })).toBeCloseTo(3, 12);
    expect(resScale({ getScreenCTM: () => null })).toBe(1);
    expect(resScale({})).toBe(1);
  });
});

describe("dashHitRings", () => {
  it("returns the on-dashes as open polylines on the path", () => {
    // on [0,2], off [2,5], on [5,7], off [7,10]
    const rings = dashHitRings("M0 0 L10 0", [2, 3], 0, 1);
    expect(rings.map(r => r.closed)).toEqual([false, false]);
    const ends = rings.map(r => [...r.points.slice(0, 2), ...r.points.slice(-2)].map(v => Math.round(v * 1e6) / 1e6));
    expect(ends).toEqual([
      [0, 0, 2, 0],
      [5, 0, 7, 0]
    ]);
  });

  it("returns nothing without a usable pattern", () => {
    expect(dashHitRings("M0 0 L10 0", [], 0, 1)).toEqual([]);
    expect(dashHitRings("M0 0 L10 0", [-1, 2], 0, 1)).toEqual([]);
  });
});

describe("rasterHits", () => {
  const image = (pointerEvents: string | null) =>
    ({
      ownerDocument: { defaultView: pointerEvents === null ? null : { getComputedStyle: () => ({ pointerEvents }) } }
    }) as unknown as Element;
  it("treats a pointer-events none raster (compact relief) as click-through", () => {
    expect(rasterHits(image("none"))).toBe(false);
    expect(rasterHits(image("auto"))).toBe(true);
    expect(rasterHits(image(null))).toBe(false);
  });
});

const I: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

interface Fake {
  tagName: string;
  id: string;
  parentElement: Fake | null;
  children: Fake[];
  attrs: Record<string, string>;
  bbox?: { x: number; y: number; width: number; height: number };
  ctm?: Affine;
  chars?: { x: number; y: number; width: number; height: number; start: number[]; end: number[] }[];
  lengths?: Record<string, number>; // resolved SVGAnimatedLength values (r="1em" -> 4)
}

const LEAF = new Set(["path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "text", "use", "image"]);
const UNPAINTED = new Set(["defs", "clipPath", "mask", "pattern", "symbol", "marker"]);

// Minimal element: just the selectors and SVG APIs compatShapes uses (no style engine: every fill area counts).
function el(tagName: string, id = "", children: Fake[] = [], extra: Partial<Fake> = {}) {
  const node: Fake = { tagName, id, parentElement: null, children, attrs: {}, ...extra };
  for (const child of children) child.parentElement = node;
  if (id) byId.set(id, node);
  return node;
}
const byId = new Map<string, Fake>();
const ownerDocument = { getElementById: (id: string) => (byId.has(id) ? wrap(byId.get(id)!) : null) };
const cache = new Map<Fake, any>();
function wrap(node: Fake): any {
  const known = cache.get(node);
  if (known) return known;
  const matches = (n: Fake, selector: string) =>
    selector === "[id]"
      ? !!n.id
      : selector === "svg"
        ? n.tagName === "svg"
        : selector.includes("defs")
          ? UNPAINTED.has(n.tagName)
          : LEAF.has(n.tagName);
  const api: any = {
    tagName: node.tagName,
    id: node.id,
    get parentElement() {
      return node.parentElement && wrap(node.parentElement);
    },
    get ownerSVGElement() {
      for (let n = node.parentElement; n; n = n.parentElement) if (n.tagName === "svg") return wrap(n);
      return null;
    },
    getAttribute: (name: string) => node.attrs[name] ?? null,
    ownerDocument,
    get children() {
      return node.children.map(wrap);
    },
    ...Object.fromEntries(Object.entries(node.lengths ?? {}).map(([name, value]) => [name, { baseVal: { value } }])),
    closest(selector: string) {
      for (let n: Fake | null = node; n; n = n.parentElement) if (matches(n, selector)) return wrap(n);
      return null;
    },
    querySelectorAll(selector: string) {
      const out: any[] = [];
      const walk = (n: Fake) => {
        for (const child of n.children) {
          if (matches(child, selector)) out.push(wrap(child));
          walk(child);
        }
      };
      walk(node);
      return out;
    },
    getBBox: () => node.bbox ?? { x: 0, y: 0, width: 0, height: 0 },
    getScreenCTM: () => node.ctm ?? null,
    getNumberOfChars: () => node.chars?.length ?? 0,
    getExtentOfChar: (i: number) => node.chars![i],
    getStartPositionOfChar: (i: number) => ({ x: node.chars![i].start[0], y: node.chars![i].start[1] }),
    getEndPositionOfChar: (i: number) => ({ x: node.chars![i].end[0], y: node.chars![i].end[1] })
  };
  cache.set(node, api);
  return api;
}

const viewbox = { getScreenCTM: () => ({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }) };
const at = (e: number, f: number): Affine => ({ a: 2, b: 0, c: 0, d: 2, e, f });
const index = (root: Fake) => {
  const pick = new PickIndex(200, 200);
  for (const shape of compatShapes(wrap(root), viewbox)) pick.addShape("layer", shape);
  return pick;
};

describe("relative", () => {
  it("cancels the viewbox camera and keeps the element transform", () => {
    const camera: Affine = { a: 2, b: 0, c: 0, d: 2, e: -100, f: 40 };
    // leaf CTM = camera · translate(10, 5) · scale(3)
    const leaf: Affine = { a: 6, b: 0, c: 0, d: 6, e: -100 + 20, f: 40 + 10 };
    const m = relative(camera, leaf);
    for (const [key, value] of Object.entries({ a: 3, b: 0, c: 0, d: 3, e: 10, f: 5 }))
      expect(m[key as keyof Affine]).toBeCloseTo(value, 12);
  });

  it("inverts a rotated camera", () => {
    const camera: Affine = { a: 0, b: 1, c: -1, d: 0, e: 7, f: 3 };
    const m = relative(camera, camera);
    for (const [key, value] of Object.entries(I)) expect(m[key as keyof Affine]).toBeCloseTo(value, 12);
  });
});

describe("boxCorners", () => {
  it("returns the four transformed corners in ring order", () => {
    expect(boxCorners({ a: 2, b: 0, c: 0, d: 2, e: 1, f: 1 }, 0, 0, 1, 2)).toEqual([1, 1, 3, 1, 3, 5, 1, 5]);
  });
});

describe("shapePath", () => {
  it("converts basic shapes and skips empty ones", () => {
    expect(shapePath(wrap(el("rect", "", [], { attrs: { x: "1", y: "2", width: "3", height: "4" } })))).toBe(
      "M1,2H4V6H1Z"
    );
    expect(shapePath(wrap(el("circle", "", [], { attrs: { cx: "5", cy: "5", r: "0" } })))).toBeNull();
    expect(shapePath(wrap(el("line", "", [], { attrs: { x1: "0", y1: "0", x2: "3", y2: "4" } })))).toBe("M0,0L3,4");
    expect(shapePath(wrap(el("polygon", "", [], { attrs: { points: "0,0 4,0 4,4" } })))).toMatch(/Z$/);
  });
});

describe("textCells", () => {
  it("uses the extent rect for horizontal characters", () => {
    const text = wrap(
      el("text", "t", [], { chars: [{ x: 0, y: -8, width: 6, height: 10, start: [0, 0], end: [6, 0] }] })
    );
    expect(textCells(text)).toEqual([[0, -8, 6, -8, 6, 2, 0, 2]]);
  });

  it("recovers a rotated cell from its axis-aligned extent", () => {
    // 45° advance of length √2·4 from (10, 10); ascent 3, descent 1 across it
    const s = Math.SQRT1_2;
    const t = [s, s];
    const n = [-s, s];
    const corners = [
      [0, -3],
      [4, -3],
      [4, 1],
      [0, 1]
    ].map(([u, v]) => [10 + u * t[0] + v * n[0], 10 + u * t[1] + v * n[1]]);
    const xs = corners.map(c => c[0]);
    const ys = corners.map(c => c[1]);
    const box = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys)
    };
    const text = wrap(el("text", "t", [], { chars: [{ ...box, start: [10, 10], end: [10 + 4 * s, 10 + 4 * s] }] }));
    const [cell] = textCells(text);
    corners.forEach(([x, y], k) => {
      expect(cell[2 * k]).toBeCloseTo(x, 9);
      expect(cell[2 * k + 1]).toBeCloseTo(y, 9);
    });
  });

  it("skips zero-area (unrendered) characters", () => {
    const text = wrap(
      el("text", "t", [], { chars: [{ x: 0, y: 0, width: 0, height: 0, start: [0, 0], end: [0, 0] }] })
    );
    expect(textCells(text)).toEqual([]);
  });
});

describe("compatShapes", () => {
  it("hits the circle, not its bbox corner, and keeps the nearest [id]", () => {
    const marker = el("svg", "marker7", [el("circle", "", [], { attrs: { cx: "5", cy: "5", r: "5" }, ctm: at(0, 0) })]);
    const pick = index(el("g", "markers", [marker]));
    expect(pick.pick(2.5, 2.5, 0)?.id).toBe("marker7");
    // bbox corner of the circle: outside the circle
    expect(pick.pick(0.3, 0.3, 0)).toBeNull();
  });

  it("clips nested <svg> content to its viewport", () => {
    const marker = el(
      "svg",
      "marker1",
      [el("rect", "", [], { attrs: { x: "0", y: "0", width: "20", height: "20" }, ctm: at(0, 0) })],
      { attrs: { x: "0", y: "0", width: "5", height: "5" } }
    );
    const g = el("g", "markers", [marker], { ctm: at(0, 0) });
    el("svg", "map", [g]);
    const pick = index(g);
    expect(pick.pick(4, 4, 0)?.id).toBe("marker1");
    expect(pick.pick(10, 10, 0)).toBeNull();
  });

  it("uses character cells for text and skips unpainted content", () => {
    const text = el("text", "burgLabel5", [el("tspan")], {
      ctm: at(0, 0),
      chars: [
        { x: 0, y: 0, width: 3, height: 2, start: [0, 1.5], end: [3, 1.5] },
        { x: 6, y: 0, width: 3, height: 2, start: [6, 1.5], end: [9, 1.5] }
      ]
    });
    const group = el("g", "g1", [
      el("defs", "", [el("rect", "p", [], { attrs: { x: "0", y: "0", width: "50", height: "50" }, ctm: at(0, 0) })]),
      text
    ]);
    const pick = index(group);
    expect(pick.pick(1, 1, 0)?.id).toBe("burgLabel5");
    // the gap between the two cells is not part of the text's hit area
    expect(pick.pick(4.5, 1, 0)).toBeNull();
    expect(pick.pick(30, 30, 0)).toBeNull();
    // text cells take Chrome's pointer square: one CSS px (here 0.5) left of the first cell still hits
    expect(pick.pick(-0.4, 1, 0, undefined, 0.5)?.id).toBe("burgLabel5");
    expect(pick.pick(-0.4, 1, 0)).toBeNull();
  });

  it("grows horizontal glyph cells outward to Chrome's 1/64 LayoutUnit grid", () => {
    expect(layoutSnap([0.01, 0.02, 1.01, 0.02, 1.01, 2, 0.01, 2])).toEqual([
      0,
      1 / 64,
      65 / 64,
      1 / 64,
      65 / 64,
      2,
      0,
      2
    ]);
    // burgLabel572 'W' (pilot 1792176064208006000 row 326): bottom 362.66 snaps to 362.671875; Chrome hit 362.67175
    const text = el("text", "burgLabel572", [], {
      ctm: at(0, 0),
      chars: [{ x: 525.462, y: 353.16, width: 7.477, height: 9.5, start: [525.462, 360.66], end: [532.939, 360.66] }]
    });
    const pick = new PickIndex(1000, 1000);
    for (const shape of compatShapes(wrap(el("g", "burgLabels", [text])), viewbox)) pick.addShape("labels", shape);
    expect(pick.pick(525.6, 362.67175, 0)?.id).toBe("burgLabel572");
    expect(pick.pick(525.315, 362.67175, 0, undefined, 0.5)?.id).toBe("burgLabel572");
    expect(pick.pick(525.6, 362.68, 0)).toBeNull();
  });

  it("keeps point hits for rotated (textPath) glyph cells", () => {
    // stateLabel4: a 0.2-unit gap between rotated cells missed by Chrome must not be bridged by the pointer square
    const s = Math.SQRT1_2;
    // 45° advance of length 2 from (10, 10); ascent 2, descent 1 across it
    const at45 = (u: number, v: number) => [10 + (u - v) * s, 10 + (u + v) * s];
    const corners = [at45(0, -2), at45(2, -2), at45(2, 1), at45(0, 1)];
    const xs = corners.map(c => c[0]);
    const ys = corners.map(c => c[1]);
    const extent = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys)
    };
    const text = el("text", "stateLabel4", [el("textPath")], {
      ctm: at(0, 0),
      chars: [{ ...extent, start: at45(0, 0), end: at45(2, 0) }]
    });
    const pick = index(el("g", "states", [text]));
    expect(pick.pick(...(at45(1, -0.5) as [number, number]), 0)?.id).toBe("stateLabel4");
    // just before the cell's start edge: a 0.5 square toward +x/+y would reach 0.5 into the cell
    const [x, y] = at45(-0.2, -0.5);
    expect(pick.pick(x, y, 0)).toBeNull();
    expect(pick.pick(x, y, 0, undefined, 0.5)).toBeNull();
  });

  it("keeps the last compat leaf topmost in the pick index", () => {
    const rect = (id: string, x: number) =>
      el("rect", id, [], { attrs: { x: String(x), y: String(x), width: "4", height: "4" }, ctm: at(0, 0) });
    const pick = index(el("g", "burgLabels", [rect("a", 0), rect("b", 1)]));
    expect(pick.pick(2, 2, 0)?.id).toBe("b");
    expect(pick.pick(0.5, 0.5, 0)?.id).toBe("a");
  });

  it("returns nothing without a viewbox transform", () => {
    const rect = el("rect", "r", [], { attrs: { width: "1", height: "1" }, ctm: I });
    expect(compatShapes(wrap(rect), {})).toEqual([]);
  });

  it("falls back to the parent id like prepare.ts", () => {
    expect(pickId({ id: "", parentElement: { closest: () => ({ id: "parent" }) } })).toBe("parent");
  });
});

describe("compatShapes <use> of a viewBox <svg>", () => {
  // an emblem: <use width=20 href=#coaT> of <svg viewBox="0 10 200 200"> whose field is clipped to a round shield
  // given as r="1em" (resolved to 50 by its SVGAnimatedLength); the shield maps to centre (10, 10), radius 5
  const shield = el("clipPath", "shieldT", [
    el("circle", "", [], { attrs: { cx: "100", cy: "110", r: "1em" }, lengths: { r: 50 } })
  ]);
  const coa = el("svg", "coaT", [
    el("defs", "", [shield]),
    el("g", "", [el("rect", "", [], { attrs: { x: "0", y: "10", width: "200", height: "200" } })], {
      attrs: { "clip-path": "url(#shieldT)" }
    })
  ]);
  coa.attrs.viewBox = "0 10 200 200";
  const use = () =>
    el("use", "useT", [], {
      attrs: { href: "#coaT", x: "0", y: "0", width: "20", height: "20" },
      bbox: { x: 0, y: 0, width: 20, height: 20 },
      ctm: at(0, 0)
    });

  it("hits the clip shape, not the transparent corners of the box", () => {
    const pick = index(el("g", "emblems", [el("g", "burgEmblems", [use()])]));
    expect(pick.pick(10, 10, 0)?.id).toBe("useT");
    expect(pick.pick(14.8, 10, 0)?.id).toBe("useT");
    expect(pick.pick(15.3, 10, 0)).toBeNull(); // just outside r = 5 (the 1em value, not 1)
    expect(pick.pick(1, 1, 0)).toBeNull(); // box corner
  });

  it("keeps the bbox for a <use> whose target is not a viewBox <svg>", () => {
    const leaf = use();
    leaf.attrs.href = "#missingT";
    const pick = index(el("g", "emblems", [el("g", "burgEmblems", [leaf])]));
    expect(pick.pick(1, 1, 0)?.id).toBe("useT");
  });
});

describe("compatShapes stroke dashes", () => {
  afterEach(() => vi.unstubAllGlobals());

  // A stroke-sensitive path (pointer-events auto, stroke red, width 1) with the given dash pattern.
  const strokedIndex = (strokeDasharray: string, overrides: Record<string, string> = {}) => {
    const style = {
      pointerEvents: "auto",
      visibility: "visible",
      display: "inline",
      fill: "none",
      stroke: "red",
      strokeWidth: "1",
      strokeDasharray,
      strokeDashoffset: "0",
      ...overrides
    };
    vi.stubGlobal("getComputedStyle", () => style);
    const path = el("path", "route", [], { attrs: { d: "M0 0 L10 0" }, ctm: at(0, 0) });
    return index(el("g", "routes", [path]));
  };

  it("indexes a dashed stroke only on its on-dashes", () => {
    // on [0,2], off [2,5], on [5,7], off [7,10]
    const pick = strokedIndex("2 3");
    expect(pick.pick(1, 0, 0)?.id).toBe("route");
    expect(pick.pick(3.5, 0, 0)).toBeNull();
  });

  it("indexes an undashed stroke along its whole length", () => {
    expect(strokedIndex("").pick(3.5, 0, 0)?.id).toBe("route");
  });

  it("treats stroke-dasharray none as solid", () => {
    expect(strokedIndex("none").pick(3.5, 0, 0)?.id).toBe("route");
  });

  it("caps each dash by stroke-linecap: butt ends at the dash end, round reaches half a width past it", () => {
    // on-dashes [0,2] and [5,7]; width 2 keeps the round cap's reach at (2.5, 0) clear of rounding
    expect(strokedIndex("2 3", { strokeLinecap: "round", strokeWidth: "2" }).pick(2.5, 0, 0)?.id).toBe("route");
    expect(strokedIndex("2 3", { strokeLinecap: "butt", strokeWidth: "2" }).pick(2.5, 0, 0)).toBeNull();
  });
});

// Dash rings of `d` indexed as a dashed stroke with dashes already applied (the prepare.ts path).
function dashedIndex(d: string, dashes: number[], scale: number, lineCap: string, halfWidth = 0.5) {
  const rings = dashHitRings(d, dashes, 0, scale);
  const pick = new PickIndex(200, 200);
  pick.addStroke(
    "layer",
    "route",
    rings.map(r => r.points),
    rings.map(r => r.closed),
    halfWidth,
    {
      dashes: [],
      dashOffset: 0,
      lineCap
    }
  );
  return pick;
}

describe("dashed stroke picking", () => {
  it("hits a butt dash on its start edge, not beyond it", () => {
    // on-dashes [0,4] and [8,10] of a 10-unit line
    const pick = dashedIndex("M0 0 L10 0", [4, 4], 1, "butt");
    expect(pick.pick(0, 0.3, 0)?.id).toBe("route");
    expect(pick.pick(-0.2, 0, 0)).toBeNull();
    expect(pick.pick(0, 0.6, 0)).toBeNull();
    // gap between the dashes
    expect(pick.pick(6, 0, 0)).toBeNull();
    // end edge of the last dash (at the path end)
    expect(pick.pick(10, 0.2, 0)?.id).toBe("route");
    expect(pick.pick(10.2, 0, 0)).toBeNull();
  });

  it("extends a round dash past its start edge, as the cap does", () => {
    const pick = dashedIndex("M0 0 L10 0", [4, 4], 1, "round");
    expect(pick.pick(-0.2, 0, 0)?.id).toBe("route");
  });

  it("follows a curved route's dashes on the curve (synthetic quarter circle, radius 100)", () => {
    // cubic quarter circle from (100,0) counter-clockwise to (0,100); dashes [50,50] are arcs [0,50] and [100,150]
    const d = "M100 0C100 55.2284749831 55.2284749831 100 0 100";
    const pick = dashedIndex(d, [50, 50], 100, "butt");
    const on = (theta: number) => [100 * Math.cos(theta), 100 * Math.sin(theta)] as [number, number];
    expect(pick.pick(...on(0.25), 0)?.id).toBe("route");
    expect(pick.pick(...on(1.25), 0)?.id).toBe("route");
    // arc 75 lies in the gap [50,100]; the nearest dash end is 25 units away
    expect(pick.pick(...on(0.75), 0)).toBeNull();
  });
});

describe("transient viewport culling preserves world hit geometry", () => {
  afterEach(() => vi.unstubAllGlobals());

  function culledUse(hiddenByAuthor = false, fail = false) {
    const node = el("use", "occluder", [], {
      attrs: { class: "selected viewport-culled extra" },
      ctm: at(0, 0)
    });
    const api = wrap(node);
    api.setAttribute = (name: string, value: string) => {
      node.attrs[name] = value;
    };
    api.getBBox = vi.fn(() => {
      if (fail) throw new Error("native geometry failure");
      return node.attrs.class.includes("viewport-culled")
        ? { x: 0, y: 0, width: 0, height: 0 }
        : { x: 100, y: 50, width: 20, height: 20 };
    });
    vi.stubGlobal("getComputedStyle", () => ({
      pointerEvents: "all",
      visibility: "visible",
      fill: "red",
      stroke: "none",
      strokeWidth: "0",
      display: hiddenByAuthor || node.attrs.class.includes("viewport-culled") ? "none" : "inline"
    }));
    return { node, api };
  }

  it("indexes an offscreen occluder and restores the exact source class", () => {
    const { node, api } = culledUse();
    const original = node.attrs.class;
    const shapes = compatShapes(api, viewbox);
    expect(shapes).toHaveLength(1);
    expect(shapes[0].box).toEqual([100, 50, 120, 50, 120, 70, 100, 70]);
    expect(node.attrs.class).toBe(original);
  });

  it("restores source state when a native geometry read throws", () => {
    const { node, api } = culledUse(false, true);
    const original = node.attrs.class;
    expect(() => compatShapes(api, viewbox)).toThrow("native geometry failure");
    expect(node.attrs.class).toBe(original);
  });

  it("exposes all culled siblings before the first layout read, then restores every class", () => {
    const a = culledUse(),
      b = culledUse();
    b.node.id = "second";
    const root = wrap(el("g", "emblems", [a.node, b.node]));
    const read = a.api.getBBox;
    a.api.getBBox = () => {
      expect(b.node.attrs.class).not.toContain("viewport-culled");
      return read();
    };
    expect(compatShapes(root, viewbox)).toHaveLength(2);
    expect(a.node.attrs.class).toBe("selected viewport-culled extra");
    expect(b.node.attrs.class).toBe("selected viewport-culled extra");
  });

  it("restores all siblings when a later layout read throws", () => {
    const a = culledUse(),
      b = culledUse(false, true);
    b.node.id = "second";
    const root = wrap(el("g", "emblems", [a.node, b.node]));
    expect(() => compatShapes(root, viewbox)).toThrow("native geometry failure");
    expect(a.node.attrs.class).toBe("selected viewport-culled extra");
    expect(b.node.attrs.class).toBe("selected viewport-culled extra");
  });

  it("batches separate roots before the FIRST world CTM and preserves per-root geometry/order", () => {
    const a = culledUse(),
      b = culledUse();
    b.node.id = "second";
    vi.stubGlobal("getComputedStyle", (node: { getAttribute(name: string): string | null }) => ({
      pointerEvents: "all",
      visibility: "visible",
      fill: "red",
      stroke: "none",
      strokeWidth: "0",
      display: node.getAttribute("class")?.includes("viewport-culled") ? "none" : "inline"
    }));
    const expected = [compatShapes(a.api, viewbox), compatShapes(b.api, viewbox)];
    const world = {
      getScreenCTM: () => {
        expect(a.node.attrs.class).not.toContain("viewport-culled");
        expect(b.node.attrs.class).not.toContain("viewport-culled");
        return viewbox.getScreenCTM();
      }
    };
    expect(compatShapesBatch([a.api, b.api], world)).toEqual(expected);
    expect(a.node.attrs.class).toBe("selected viewport-culled extra");
    expect(b.node.attrs.class).toBe("selected viewport-culled extra");
  });

  it("restores every separate root when a later root throws", () => {
    const a = culledUse(),
      b = culledUse(false, true);
    b.node.id = "second";
    expect(() => compatShapesBatch([a.api, b.api], viewbox)).toThrow("native geometry failure");
    expect(a.node.attrs.class).toBe("selected viewport-culled extra");
    expect(b.node.attrs.class).toBe("selected viewport-culled extra");
  });

  it("keeps overlapping roots and author-hidden geometry equivalent to individual extraction", () => {
    const a = culledUse(true);
    expect(compatShapesBatch([a.api, a.api], viewbox)).toEqual([[], []]);
    expect(a.node.attrs.class).toBe("selected viewport-culled extra");
    expect(compatShapesBatch([], viewbox)).toEqual([]);
  });

  it("continues to exclude author-hidden geometry", () => {
    const { node, api } = culledUse(true);
    expect(compatShapes(api, viewbox)).toEqual([]);
    expect(node.attrs.class).toBe("selected viewport-culled extra");
    expect(api.getBBox).not.toHaveBeenCalled();
  });
});
