// @vitest-environment happy-dom
// Straight <text> layout geometry (text.ts layoutStraight via layoutLabels): anchor offset, central baseline shift,
// text-shadow offset in world units (shadow px * dpr / raster scale), and paint order (shadows under, then fill and
// stroke in paint-order). A stubbed Canvas2D with fixed metrics stands in for fonts; happy-dom has no 2D context.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GLYPH_FLOATS, GlyphAtlas, layoutLabels, offCanvasShadowPaints } from "./text";

const SVG_NS = "http://www.w3.org/2000/svg";

// Every character advances 0.6 em; ink box 0.8 em up, 0.2 em down; font box 0.9 / 0.3 em.
function fakeContext(ink = 255) {
  let font = "";
  const em = () => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10);
  return {
    get font() {
      return font;
    },
    set font(value: string) {
      font = value;
    },
    fontKerning: "auto",
    fillStyle: "",
    strokeStyle: "",
    textBaseline: "alphabetic",
    lineJoin: "round",
    miterLimit: 4,
    lineWidth: 1,
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetX: 0,
    measureText: (text: string) => {
      const px = em();
      const width = [...text].length * px * 0.6;
      return {
        width,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: width,
        actualBoundingBoxAscent: px * 0.8,
        actualBoundingBoxDescent: px * 0.2,
        fontBoundingBoxAscent: px * 0.9,
        fontBoundingBoxDescent: px * 0.3
      };
    },
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4).fill(ink)
    }),
    clearRect() {},
    save() {},
    restore() {},
    translate() {},
    beginPath() {},
    rect() {},
    clip() {},
    fillText() {},
    strokeText() {}
  };
}

// Computed style as Chromium reports it for #temperature text, overridable per test.
const BASE: Record<string, string> = {
  fill: "rgb(0, 0, 0)",
  fillOpacity: "1",
  stroke: "none",
  strokeWidth: "1px",
  strokeOpacity: "1",
  strokeLinejoin: "miter",
  strokeMiterlimit: "4",
  opacity: "1",
  fontStyle: "normal",
  fontWeight: "700",
  fontSize: "8px",
  fontFamily: "Helvetica",
  textAnchor: "middle",
  dominantBaseline: "central",
  textShadow: "none",
  letterSpacing: "normal",
  textRendering: "auto",
  visibility: "visible",
  paintOrder: "normal"
};
let style: Record<string, string> = BASE;

function text(content: string, x = 100, y = 50): SVGTextElement {
  const element = document.createElementNS(SVG_NS, "text") as SVGTextElement;
  element.id = "t";
  element.setAttribute("x", String(x));
  element.setAttribute("y", String(y));
  element.textContent = content;
  document.querySelector("svg")!.append(element);
  return element;
}

// instance fields: cx cy angle lx ly w h u0 v0 u1 v1 r g b a
function instances(batch: { instances: Float32Array; count: number }) {
  return Array.from({ length: batch.count }, (_, i) => {
    const f = [...batch.instances.slice(i * GLYPH_FLOATS, (i + 1) * GLYPH_FLOATS)];
    return { cx: f[0], cy: f[1], lx: f[3], ly: f[4], w: f[5], h: f[6], color: f.slice(11) };
  });
}

async function layout(content: string, overrides: Record<string, string>, scale = 4) {
  style = { ...BASE, ...overrides };
  const batch = await layoutLabels([text(content)], scale, new GlyphAtlas());
  expect(batch.failed.map(f => f.reason)).toEqual([]);
  return { batch, glyphs: instances(batch) };
}

describe("[TEXT] layoutStraight geometry (stubbed metrics)", () => {
  beforeAll(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => fakeContext() as unknown as CanvasRenderingContext2D
    );
    vi.spyOn(window, "getComputedStyle").mockImplementation(() => style as unknown as CSSStyleDeclaration);
    vi.stubGlobal("devicePixelRatio", 2);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    document.body.innerHTML = `<svg xmlns="${SVG_NS}"></svg>`;
  });

  // 8px at raster scale 4: each char advances 8*0.6 = 4.8 world units, "12°F" is 19.2 wide
  it("anchors start/middle/end on the whole string's advance", async () => {
    const first = async (anchor: string) => (await layout("12°F", { textAnchor: anchor })).glyphs[0].cx;
    expect(await first("start")).toBeCloseTo(100);
    expect(await first("middle")).toBeCloseTo(100 - 9.6);
    expect(await first("end")).toBeCloseTo(100 - 19.2);
  });

  it("places each glyph at the pen position and on the baseline y", async () => {
    const { glyphs } = await layout("12°F", { textAnchor: "start" });
    expect(glyphs.map(g => g.cx)).toEqual([100, 104.8, 109.6, 114.4].map(v => expect.closeTo(v, 5)));
    expect(glyphs.every(g => g.cy === 50)).toBe(true);
  });

  it("central baseline shifts by half the font box (ascent - descent) / 2, in world units", async () => {
    // font box at 32 raster px: 28.8 up, 9.6 down -> (28.8 - 9.6) / 2 / 4 = 2.4 world units down
    const auto = (await layout("A", { dominantBaseline: "auto", textAnchor: "start" })).glyphs[0];
    const central = (await layout("A", { dominantBaseline: "central", textAnchor: "start" })).glyphs[0];
    expect(central.ly - auto.ly).toBeCloseTo(2.4);
    expect(central.cy).toBe(auto.cy);
  });

  it("offsets a shadow by its CSS px times dpr over the raster scale, and paints it under the text", async () => {
    const { glyphs } = await layout("A", {
      textAnchor: "start",
      dominantBaseline: "auto",
      textShadow: "rgb(157, 170, 201) 1px 2px 1px"
    });
    expect(glyphs).toHaveLength(2);
    const [shadow, fill] = glyphs;
    // a shadow instance carries its alpha negated: the glyph shader's soft-cell flag (no coverage floor)
    expect(shadow.color).toEqual([157 / 255, 170 / 255, 201 / 255, -1].map(v => expect.closeTo(v, 5)));
    expect(fill.color).toEqual([0, 0, 0, 1]);
    // 1px * dpr 2 / scale 4 = 0.5, 2px -> 1
    expect(shadow.cx - fill.cx).toBeCloseTo(0.5);
    expect(shadow.cy - fill.cy).toBeCloseTo(1);
    // the shadow cell is the whole string blurred: wider than the glyph by the blur margin on each side
    expect(shadow.w).toBeGreaterThan(fill.w);
  });

  it("a shadow list goes down last-first (CSS paints the first shadow on top)", async () => {
    const { glyphs } = await layout("A", {
      textShadow: "rgb(255, 0, 0) 0px 0px 2px, rgb(0, 0, 255) 0px 0px 2px"
    });
    expect(glyphs.map(g => g.color.slice(0, 3))).toEqual([
      [0, 0, 1],
      [1, 0, 0],
      [0, 0, 0]
    ]);
  });

  it("a wide blur is cut at a reduced resolution and scaled back to the same world size", async () => {
    // 10px blur at dpr 2: sigma 10 device px -> cut at 2/10 of the raster scale
    const wide = (await layout("A", { textShadow: "rgb(255, 255, 255) 0px 0px 10px" })).glyphs[0];
    const narrow = (await layout("A", { textShadow: "rgb(255, 255, 255) 0px 0px 1px" })).glyphs[0];
    expect(wide.w).toBeGreaterThan(narrow.w);
    // margin: (ceil(1.5 * blur) + PAD) atlas px at the cut scale, i.e. (6 + 3) / 0.8 = 11.25 world units per side
    // around a 0.6 em = 4.8 world-unit ink box
    expect(wide.w).toBeCloseTo(4.8 + 2 * 11.25, 0);
  });

  it("paint-order stroke puts the halo pass under the fill pass", async () => {
    const halo = { stroke: "rgb(255, 255, 255)", strokeWidth: "1px", textAnchor: "start" };
    const normal = (await layout("Ab", halo)).glyphs.map(g => g.color[0]);
    const strokeFirst = (await layout("Ab", { ...halo, paintOrder: "stroke" })).glyphs.map(g => g.color[0]);
    expect(normal).toEqual([0, 0, 1, 1]);
    expect(strokeFirst).toEqual([1, 1, 0, 0]);
  });

  it("skips whitespace glyphs but keeps their advance", async () => {
    const { glyphs } = await layout("a b", { textAnchor: "start" });
    expect(glyphs.map(g => g.cx)).toEqual([100, 109.6].map(v => expect.closeTo(v, 5)));
  });

  it("records one pick box per text over the font box", async () => {
    const { batch } = await layout("AB", { textAnchor: "start", dominantBaseline: "auto" });
    expect(batch.boxes).toHaveLength(1);
    const [x0, y0, x1, , , y2] = batch.boxes[0].corners;
    expect([x0, x1]).toEqual([100, 109.6].map(v => expect.closeTo(v, 5)));
    // 28.8 / 4 up, 9.6 / 4 down from the baseline
    expect(y0).toBeCloseTo(50 - 7.2);
    expect(y2).toBeCloseTo(50 + 2.4);
  });
});

describe("[TEXT] off-canvas shadow probe", () => {
  it("is true when the shadow lands, false (and sticky) when the draw is culled", async () => {
    vi.resetModules();
    const fresh = await import("./text");
    expect(fresh.offCanvasShadowPaints(fakeContext(0) as unknown as CanvasRenderingContext2D)).toBe(false);
    // cached for the process: a later context does not re-probe
    expect(fresh.offCanvasShadowPaints(fakeContext(255) as unknown as CanvasRenderingContext2D)).toBe(false);
    vi.resetModules();
    const again = await import("./text");
    expect(again.offCanvasShadowPaints(fakeContext(255) as unknown as CanvasRenderingContext2D)).toBe(true);
    expect(offCanvasShadowPaints).toBeTypeOf("function");
  });

  it("a culled probe sends shadowed text to compat under a named reason, plain text stays native", async () => {
    vi.resetModules();
    const fresh = await import("./text");
    fresh.offCanvasShadowPaints(fakeContext(0) as unknown as CanvasRenderingContext2D);
    const get = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(() => fakeContext() as unknown as CanvasRenderingContext2D);
    const computed = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation(() => style as unknown as CSSStyleDeclaration);
    try {
      document.body.innerHTML = `<svg xmlns="${SVG_NS}"></svg>`;
      style = { ...BASE, textShadow: "rgb(255, 255, 255) 0px 0px 10px" };
      const shadowed = await fresh.layoutLabels([text("12°F")], 4, new fresh.GlyphAtlas());
      expect(shadowed.failed.map(f => f.reason)).toEqual(["text-shadow (canvas culls off-canvas shadow)"]);
      expect(shadowed.count).toBe(0);
      style = { ...BASE };
      const plain = await fresh.layoutLabels([text("12°F")], 4, new fresh.GlyphAtlas());
      expect(plain.failed).toEqual([]);
      expect(plain.count).toBe(4);
    } finally {
      get.mockRestore();
      computed.mockRestore();
    }
  });
});
