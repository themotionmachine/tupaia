// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

const { prepareMapClone } = vi.hoisted(() => ({ prepareMapClone: vi.fn() }));
vi.mock("../io/export", () => ({ prepareMapClone }));

import { cropRegion } from "./budget";
import {
  type BatchMember,
  boundsWithin,
  gridWindow,
  liveBounds,
  measureBounds,
  newWindowStats,
  planBatches,
  rasterizeWindowed,
  reachesFilter,
  touchesOpenEdge,
  transformBox,
  union,
  WINDOW_PAD_PX,
  WINDOW_PAD_UNITS,
  WindowBatches
} from "./compat-bounds";

const svgNs = "http://www.w3.org/2000/svg";

describe("raster window on the full raster's grid", () => {
  const full = { x: 0, y: 0, width: 1280, height: 720 };

  it("is a pixel sub-rectangle of the full raster: the same world rect cropRegion gives for those pixels", () => {
    const [w, h] = [2560, 1440];
    const window = gridWindow(full, w, h, { x0: 100.3, y0: 50.7, x1: 140.1, y1: 60.2 }, 4)!;
    expect(window.px).toEqual({ x: 196, y: 97, width: 89, height: 28 });
    expect(window.region).toEqual(cropRegion(full, w, h, window.px));
    // density unchanged: pixels per world unit as in the full raster
    expect(window.px.width / window.region.width).toBeCloseTo(w / full.width, 12);
    expect(window.open).toEqual({ left: true, top: true, right: true, bottom: true });
  });

  it("keeps the full raster's non-integer pitch (rounded sizes, preserveAspectRatio none)", () => {
    const odd = { x: -10, y: 5, width: 1000.5, height: 333.3 };
    const [w, h] = [2001, 667];
    const window = gridWindow(odd, w, h, { x0: 0, y0: 100, x1: 10, y1: 110 }, 0)!;
    expect(window.region.x).toBeCloseTo(odd.x + (window.px.x * odd.width) / w, 9);
    expect(window.region.width / window.px.width).toBeCloseTo(odd.width / w, 12);
    expect(window.region.height / window.px.height).toBeCloseTo(odd.height / h, 12);
  });

  it("clamps to the full raster and closes the edges it shares with it", () => {
    const window = gridWindow(full, 1280, 720, { x0: -50, y0: 700, x1: 20, y1: 800 }, 2)!;
    expect(window.px).toEqual({ x: 0, y: 698, width: 22, height: 22 });
    expect(window.open).toEqual({ left: false, top: true, right: true, bottom: false });
  });

  it("is null when the box misses the region", () => {
    expect(gridWindow(full, 1280, 720, { x0: 2000, y0: 0, x1: 2100, y1: 10 }, 2)).toBeNull();
  });

  it("flags ink on an open edge only", () => {
    const open = { left: true, top: false, right: true, bottom: true };
    expect(touchesOpenEdge({ x: 0, y: 5, width: 3, height: 3 }, 20, 20, open)).toBe(true);
    expect(touchesOpenEdge({ x: 1, y: 0, width: 3, height: 3 }, 20, 20, open)).toBe(false); // top is closed
    expect(touchesOpenEdge({ x: 1, y: 1, width: 19, height: 3 }, 20, 20, open)).toBe(true);
    expect(touchesOpenEdge({ x: 1, y: 1, width: 18, height: 18 }, 20, 20, open)).toBe(false);
    expect(touchesOpenEdge({ x: 1, y: 1, width: 18, height: 19 }, 20, 20, open)).toBe(true);
  });
});

describe("geometry bounds", () => {
  it("maps a local box through an affine matrix (rotation included) to its world box", () => {
    const box = transformBox({ x: 0, y: 0, width: 10, height: 4 }, { a: 0, b: 1, c: -1, d: 0, e: 100, f: 50 });
    expect(box).toEqual({ x0: 96, y0: 50, x1: 100, y1: 60 });
    expect(union(null, box)).toBe(box);
    expect(union(box, { x0: 0, y0: 70, x1: 1, y1: 71 })).toEqual({ x0: 0, y0: 50, x1: 100, y1: 71 });
  });

  // happy-dom has no SVG geometry: getBBox / getScreenCTM are stubbed per element
  const matrix = (e: number, f: number, k = 1) => {
    const m = {
      a: k,
      b: 0,
      c: 0,
      d: k,
      e,
      f,
      inverse: () => matrix(-e / k, -f / k, 1 / k),
      multiply: (n: { a: number; b: number; c: number; d: number; e: number; f: number }) =>
        ({
          a: m.a * n.a + m.c * n.b,
          b: m.b * n.a + m.d * n.b,
          c: m.a * n.c + m.c * n.d,
          d: m.b * n.c + m.d * n.d,
          e: m.a * n.e + m.c * n.f + m.e,
          f: m.b * n.e + m.d * n.f + m.f
        }) as unknown
    };
    return m;
  };
  const shape = (bbox: { x: number; y: number; width: number; height: number }, ctm: unknown) => {
    const element = document.createElementNS(svgNs, "rect") as unknown as SVGGraphicsElement;
    Object.assign(element, { getBBox: () => bbox, getScreenCTM: () => ctm });
    return element as unknown as Element;
  };

  it("unions the elements' boxes in world units through the camera, padded", () => {
    // camera: translate(30 20) scale(2); element CTMs include it
    const viewbox = shape({ x: 0, y: 0, width: 0, height: 0 }, matrix(30, 20, 2));
    const a = shape({ x: 10, y: 10, width: 5, height: 5 }, matrix(30, 20, 2));
    const b = shape({ x: 0, y: 0, width: 4, height: 2 }, matrix(30 + 2 * 100, 20 + 2 * 50, 2)); // translate(100 50)
    const empty = shape({ x: 0, y: 0, width: 0, height: 0 }, matrix(30, 20, 2));
    const p = WINDOW_PAD_UNITS;
    expect(liveBounds([a, b, empty], viewbox)).toEqual({ x0: 10 - p, y0: 10 - p, x1: 104 + p, y1: 52 + p });
    // nothing rendered: an empty box, not a guess
    expect(liveBounds([empty], viewbox)).toEqual({ x0: 0, y0: 0, x1: 0, y1: 0 });
  });

  // COST2 item 4: a round-capped dot (a zero-length subpath) measures 0x0 but paints its cap; left out, a dot apart from
  // the rest of its run fell outside the window and was lost
  it("keeps a zero-size box of an element that can paint a point, not of one that paints nothing", () => {
    const viewbox = shape({ x: 0, y: 0, width: 0, height: 0 }, matrix(0, 0));
    const at = (tag: string, attrs: Record<string, string>, bbox: { x: number; y: number }) => {
      const element = document.createElementNS(svgNs, tag);
      for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
      Object.assign(element, { getBBox: () => ({ ...bbox, width: 0, height: 0 }), getScreenCTM: () => matrix(0, 0) });
      return element;
    };
    const body = shape({ x: 10, y: 10, width: 5, height: 5 }, matrix(0, 0));
    const dot = at("path", { d: "M300 200z", "stroke-linecap": "round" }, { x: 300, y: 200 });
    const p = WINDOW_PAD_UNITS;
    expect(liveBounds([body, dot], viewbox)).toEqual({ x0: 10 - p, y0: 10 - p, x1: 300 + p, y1: 200 + p });
    // a group holding only a dot measures 0x0 too
    const group = at("g", {}, { x: 40, y: 50 });
    group.append(document.createElementNS(svgNs, "line"));
    expect(liveBounds([group], viewbox)).toEqual({ x0: 40 - p, y0: 50 - p, x1: 40 + p, y1: 50 + p });
    // an empty path, an empty group, a zero-size rect or circle paint nothing: no box
    const nothing = [
      at("path", {}, { x: 0, y: 0 }),
      at("path", { d: "" }, { x: 0, y: 0 }),
      at("g", {}, { x: 0, y: 0 }),
      at("circle", { r: "0" }, { x: 5, y: 5 })
    ];
    expect(liveBounds([body, ...nothing], viewbox)).toEqual({ x0: 10 - p, y0: 10 - p, x1: 15 + p, y1: 15 + p });
  });

  it("is unknown (null) when a measurement fails", () => {
    const viewbox = shape({ x: 0, y: 0, width: 0, height: 0 }, matrix(0, 0));
    const broken = shape({ x: 0, y: 0, width: 1, height: 1 }, null);
    expect(liveBounds([broken], viewbox)).toBeNull();
    const throwing = shape({ x: 0, y: 0, width: 1, height: 1 }, matrix(0, 0));
    (throwing as unknown as SVGGraphicsElement).getBBox = () => {
      throw new Error("not rendered");
    };
    expect(liveBounds([throwing], viewbox)).toBeNull();
  });

  // label culling hides off-screen labels with display:none, which getBBox cannot measure, while the export clone draws
  // them: the culling sheet is off during the measurement and back on after it
  it("measures with the label-culling sheet off and restores it", () => {
    document.body.innerHTML = `<svg id="map" xmlns="${svgNs}"><g id="viewbox"><text id="t" class="viewport-culled">x</text><text id="u">y</text></g><style id="map-label-culling-style">.viewport-culled{display:none!important;pointer-events:none!important}</style></svg>`;
    const viewbox = document.getElementById("viewbox")!;
    const style = document.getElementById("map-label-culling-style") as unknown as HTMLStyleElement;
    // happy-dom drops the text of an svg <style> parsed through innerHTML
    style.textContent = ".viewport-culled{display:none!important;pointer-events:none!important}";
    const sheet = { disabled: false } as CSSStyleSheet;
    Object.defineProperty(style, "sheet", { value: sheet });
    const seen: boolean[] = [];
    Object.assign(viewbox, { getScreenCTM: () => matrix(0, 0) });
    Object.assign(document.getElementById("t")!, {
      getBBox: () => {
        seen.push(sheet.disabled);
        return { x: 1, y: 2, width: 3, height: 4 };
      },
      getScreenCTM: () => matrix(0, 0)
    });
    const item: { elements: Element[]; screen: boolean; bounds?: unknown } = {
      elements: [document.getElementById("t")!],
      screen: false
    };
    const screen: { elements: Element[]; screen: boolean; bounds?: unknown } = { elements: [], screen: true };
    measureBounds([item, screen] as never, viewbox);
    expect(seen).toEqual([true]);
    expect(sheet.disabled).toBe(false);
    expect(item.bounds).toEqual({ x0: 1 - 2, y0: 2 - 2, x1: 4 + 2, y1: 6 + 2 });
    expect((item as { boxes?: unknown }).boxes).toEqual([{ x0: 1, y0: 2, x1: 4, y1: 6 }]); // each element's own, unpadded
    expect(screen.bounds).toBeUndefined(); // screen runs are never windowed
    // measured once per frame: a second call leaves it
    item.bounds = "kept";
    measureBounds([item] as never, viewbox);
    expect(item.bounds).toBe("kept");
    // nothing culled among the measured elements: the sheet stays on (switching it restyles and repaints the map)
    Object.assign(document.getElementById("u")!, {
      getBBox: () => {
        seen.push(sheet.disabled);
        return { x: 0, y: 0, width: 1, height: 1 };
      },
      getScreenCTM: () => matrix(0, 0)
    });
    measureBounds([{ elements: [document.getElementById("u")!], screen: false }] as never, viewbox);
    expect(seen).toEqual([true, false]);
  });
});

// [LABFIX] what a run reaches in a zoomed view: its element boxes clipped to it, not its world-wide union
describe("boundsWithin", () => {
  const view = { x: 100, y: 100, width: 50, height: 50 };
  const p = WINDOW_PAD_UNITS;
  it("unions the padded element boxes clipped to the region, ignoring those outside it", () => {
    const boxes = [
      { x0: 0, y0: 0, x1: 10, y1: 10 }, // far outside
      { x0: 110, y0: 110, x1: 120, y1: 115 },
      { x0: 140, y0: 120, x1: 160, y1: 125 }, // crosses the right edge
      { x0: 900, y0: 900, x1: 1000, y1: 950 }
    ];
    expect(boundsWithin(boxes, view)).toEqual({ x0: 110 - p, y0: 110 - p, x1: 150, y1: 125 + p });
  });
  it("is null when nothing reaches the region", () => {
    expect(boundsWithin([{ x0: 0, y0: 0, x1: 10, y1: 10 }], view)).toBeNull();
    expect(boundsWithin([], view)).toBeNull();
  });
});

describe("filters make a run unbounded", () => {
  const tree = (markup: string) => {
    document.body.innerHTML = `<svg xmlns="${svgNs}"><g id="viewbox">${markup}</g></svg>`;
    return (id: string) => document.getElementById(id)!;
  };

  it("on the element, inside it, or on an ancestor below #viewbox (attribute or inlined style)", () => {
    const get = tree(
      `<g id="layer" filter="url(#f)"><circle id="a"/></g><g id="plain"><circle id="b"/><g id="inner"><path id="c" style="fill:red;filter:url(#blur)"/></g></g><circle id="d" filter="none"/><circle id="e" style="filter: none"/>`
    );
    expect(reachesFilter([get("a")])).toBe(true); // ancestor
    expect(reachesFilter([get("plain")])).toBe(true); // descendant with an inlined style filter
    expect(reachesFilter([get("c")])).toBe(true); // the element's own style
    expect(reachesFilter([get("b")])).toBe(false);
    expect(reachesFilter([get("d"), get("e")])).toBe(false);
  });
});

describe("missed and batched windows (COST2)", () => {
  const full = { x: 0, y: 0, width: 1000, height: 500 };
  const member = (box: { x0: number; y0: number; x1: number; y1: number } | null, tag = "circle"): BatchMember => ({
    clones: [document.createElementNS(svgNs, tag)],
    bounds: box
  });

  it("a run whose box misses the region is transparent without a decode", async () => {
    const stats = newWindowStats();
    const result = await rasterizeWindowed({
      clone: document.createElementNS(svgNs, "svg") as SVGSVGElement,
      clones: [document.createElementNS(svgNs, "circle")],
      full,
      width: 1000,
      height: 500,
      cssScale: 1,
      stats,
      bounds: { x0: 2000, y0: 0, x1: 2100, y1: 10 }
    });
    expect(result).toBeNull();
    expect(stats.missed).toBe(1);
    expect(stats.pixels).toBe(0);
  });

  it("groups pairwise disjoint windows, keeps only batches of two or more, in order", () => {
    // windows are padded by WINDOW_PAD_PX raster pixels (1 px per unit here)
    const gap = 2 * WINDOW_PAD_PX + 1;
    const runs: [string, BatchMember][] = [
      ["a", member({ x0: 10, y0: 10, x1: 20, y1: 20 })],
      ["b", member({ x0: 20 + gap, y0: 10, x1: 30 + gap, y1: 20 })], // clear of a
      ["c", member({ x0: 15, y0: 15, x1: 25, y1: 25 })], // overlaps a: next batch
      ["d", member({ x0: 400, y0: 300, x1: 410, y1: 310 })], // clear of all: first batch
      ["e", member(null)], // unbounded: never batched
      ["f", member({ x0: 0, y0: 0, x1: 0, y1: 0 })], // empty box: rasterizeWindowed cuts it in full
      ["g", member({ x0: 5000, y0: 0, x1: 5010, y1: 10 })], // missed
      ["h", member({ x0: 0, y0: 0, x1: 900, y1: 450 })] // most of the raster: cut in full
    ];
    const batches = planBatches(runs, full, 1000, 500);
    expect(batches.map(batch => batch.map(item => item.key))).toEqual([["a", "b", "d"]]);
    // c alone in its batch is dropped (no shared decode to gain)
    const more = planBatches([...runs, ["i", member({ x0: 600, y0: 10, x1: 610, y1: 20 })]], full, 1000, 500);
    expect(more.map(batch => batch.map(item => item.key))).toEqual([["a", "b", "d", "i"]]);
    const two = planBatches(
      [...runs, ["j", member({ x0: 16, y0: 16, x1: 18, y1: 18 })], ["k", member({ x0: 700, y0: 20, x1: 705, y1: 25 })]],
      full,
      1000,
      500
    );
    // j overlaps a and c: a third batch; k joins the first one
    expect(two.map(batch => batch.map(item => item.key))).toEqual([["a", "b", "d", "k"]]);
  });

  it("never lets a batch's union outgrow the pixel cap", () => {
    const runs: [string, BatchMember][] = [
      ["a", member({ x0: 10, y0: 10, x1: 20, y1: 20 })],
      ["b", member({ x0: 900, y0: 400, x1: 910, y1: 410 })],
      ["c", member({ x0: 60, y0: 10, x1: 70, y1: 20 })]
    ];
    // a and b span almost the whole raster; with a small cap b cannot join a's batch
    const batches = planBatches(runs, full, 1000, 500, 100 * 100);
    expect(batches.map(batch => batch.map(item => item.key))).toEqual([["a", "c"]]);
  });

  it("does not batch a filtered run (its reach is not bounded by its geometry)", () => {
    const filtered = member({ x0: 300, y0: 10, x1: 310, y1: 20 });
    filtered.clones[0].setAttribute("filter", "url(#blur)");
    const batches = planBatches(
      [
        ["a", member({ x0: 10, y0: 10, x1: 20, y1: 20 })],
        ["f", filtered],
        ["b", member({ x0: 600, y0: 10, x1: 610, y1: 20 })]
      ],
      full,
      1000,
      500
    );
    expect(batches.map(batch => batch.map(item => item.key))).toEqual([["a", "b"]]);
  });

  it("hands a run outside every batch back to the caller", async () => {
    const cuts = new WindowBatches(
      { clone: document.createElementNS(svgNs, "svg") as SVGSVGElement, full, width: 1000, height: 500, cssScale: 1 },
      [["a", member(null)]]
    );
    expect(cuts.size).toBe(0);
    expect(await cuts.take("a")).toBeUndefined();
  });
});
