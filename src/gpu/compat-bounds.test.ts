// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

const { prepareMapClone } = vi.hoisted(() => ({ prepareMapClone: vi.fn() }));
vi.mock("../io/export", () => ({ prepareMapClone }));

import { cropRegion } from "./budget";
import {
  gridWindow,
  liveBounds,
  measureBounds,
  reachesFilter,
  touchesOpenEdge,
  transformBox,
  union,
  WINDOW_PAD_UNITS
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
    document.body.innerHTML = `<svg id="map" xmlns="${svgNs}"><g id="viewbox"><text id="t">x</text></g><style id="map-label-culling-style">.viewport-culled{display:none!important;pointer-events:none!important}</style></svg>`;
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
    expect(screen.bounds).toBeUndefined(); // screen runs are never windowed
    // measured once per frame: a second call leaves it
    item.bounds = "kept";
    measureBounds([item] as never, viewbox);
    expect(item.bounds).toBe("kept");
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
