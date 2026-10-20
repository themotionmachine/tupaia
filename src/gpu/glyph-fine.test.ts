// @vitest-environment happy-dom
// GLYPHZ (W4a) glyph-fine.ts: the settle-time re-cut of a frame's native labels at the exact device scale. The layout
// runs for real (text.ts layoutLabels on straight <text>) over a stubbed Canvas2D with fixed metrics, as
// text-layout-straight.test.ts does; the device is a fake that records uploads and releases.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GpuDevice } from "./device";
import { fineGlyphsAt, refineGlyphs, wantsFineGlyphs } from "./glyph-fine";
import type { Prepared } from "./prepare";
import { GLYPH_FLOATS, GlyphAtlas, layoutLabels } from "./text";

const SVG_NS = "http://www.w3.org/2000/svg";

function fakeContext() {
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
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }),
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

const STYLE: Record<string, string> = {
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
  textAnchor: "start",
  dominantBaseline: "auto",
  textShadow: "none",
  letterSpacing: "normal",
  textRendering: "auto",
  visibility: "visible",
  paintOrder: "normal"
};

function text(id: string, content: string, x = 100, y = 50): SVGTextElement {
  const element = document.createElementNS(SVG_NS, "text") as SVGTextElement;
  element.id = id;
  element.setAttribute("x", String(x));
  element.setAttribute("y", String(y));
  element.textContent = content;
  document.querySelector("svg")!.append(element);
  return element;
}

function fakeDevice(total = 0) {
  const released: unknown[] = [];
  const device = {
    lost: false,
    texture: (label: string, source: HTMLCanvasElement, options: { rows?: number } = {}) => ({
      kind: "texture",
      label,
      width: source.width,
      height: options.rows ?? source.height,
      bytes: source.width * (options.rows ?? source.height) * 4
    }),
    buffer: (label: string, data: Float32Array) => ({ kind: "buffer", label, data: data.slice(), bytes: data.byteLength }),
    release: (resource: unknown) => {
      if (resource) released.push(resource);
    },
    memory: () => ({ total })
  };
  return { device: device as unknown as GpuDevice, released };
}

// A frame as prepare.ts leaves it: the labels laid out at the bucket into the renderer's atlas, their ranges recorded.
async function frame(bucket: number, elements: SVGTextElement[]): Promise<Prepared> {
  const glyphLabels: NonNullable<Prepared["glyphLabels"]> = [];
  const chunks: Float32Array[] = [];
  let count = 0;
  const atlas = new GlyphAtlas();
  for (const element of elements) {
    const batch = await layoutLabels([element], bucket, atlas);
    expect(batch.failed).toEqual([]);
    glyphLabels.push({ element, first: count, count: batch.count });
    chunks.push(batch.instances);
    count += batch.count;
  }
  const glyphs = new Float32Array(count * GLYPH_FLOATS);
  chunks.reduce((at, chunk) => (glyphs.set(chunk, at), at + chunk.length), 0);
  const release = vi.fn();
  return {
    bucket,
    frame: { batches: [], glyphs: { kind: "buffer" }, atlas: { kind: "texture", height: 64 } },
    glyphLabels,
    payload: { glyphs, glyphCount: count },
    release
  } as unknown as Prepared;
}

const field = (data: Float32Array, i: number, f: number) => data[i * GLYPH_FLOATS + f];

describe("[GLYPHZ] fine glyph set", () => {
  beforeAll(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => fakeContext() as unknown as CanvasRenderingContext2D
    );
    vi.spyOn(window, "getComputedStyle").mockImplementation(() => STYLE as unknown as CSSStyleDeclaration);
    vi.stubGlobal("devicePixelRatio", 2);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    document.body.innerHTML = `<svg xmlns="${SVG_NS}"></svg>`;
  });

  it("is wanted only strictly between powers of two below the bucket, and not again at the same scale", async () => {
    const prepared = await frame(4, [text("a", "Ardvale")]);
    expect(wantsFineGlyphs(prepared, 2.2)).toBe(true);
    expect(wantsFineGlyphs(prepared, 3.8)).toBe(true);
    expect(wantsFineGlyphs(prepared, 4)).toBe(false); // the bucket set is exact
    expect(wantsFineGlyphs(prepared, 4 * (1 + 1e-6))).toBe(false);
    expect(wantsFineGlyphs(prepared, 40)).toBe(false); // above the bucket cap: glyphs would outgrow the atlas
    expect(wantsFineGlyphs({ ...prepared, glyphLabels: [] } as Prepared, 2.2)).toBe(false);
    prepared.frame.fineGlyphs = { kind: "buffer" } as never;
    prepared.frame.fineScale = 2.2;
    expect(wantsFineGlyphs(prepared, 2.2)).toBe(false);
    expect(wantsFineGlyphs(prepared, 2.4)).toBe(true);
  });

  it("re-cuts every label at the exact scale with the bucket set's instance ranges", async () => {
    const prepared = await frame(4, [text("a", "Ardvale"), text("b", "Varn", 40, 90)]);
    const { device } = fakeDevice();
    expect(await refineGlyphs(prepared, device, 2.2, () => false)).toBe("cut");
    const fine = prepared.frame.fineGlyphs as unknown as { data: Float32Array };
    const bucket = prepared.payload.glyphs;
    expect(fine.data.length).toBe(bucket.length);
    expect(prepared.frame.fineScale).toBe(2.2);
    for (let i = 0; i < prepared.payload.glyphCount; i++) {
      // same anchor (world units), a cell of its own raster: cut at 2.2 device px per unit, not 4
      expect(field(fine.data, i, 0)).toBeCloseTo(field(bucket, i, 0), 5);
      expect(field(fine.data, i, 1)).toBeCloseTo(field(bucket, i, 1), 5);
      const texels = (field(fine.data, i, 10) - field(fine.data, i, 8)) * 2048;
      expect(texels / field(fine.data, i, 6)).toBeCloseTo(2.2, 4);
    }
    // the framegraph draws it at that scale only
    expect(fineGlyphsAt(prepared.frame, 2.2)?.glyphs).toBe(prepared.frame.fineGlyphs);
    expect(fineGlyphsAt(prepared.frame, 2.3)).toBeNull();
    expect(fineGlyphsAt(prepared.frame, 4)).toBeNull();
  });

  it("replaces the previous fine set, frees it at the bucket, and with the frame", async () => {
    const prepared = await frame(4, [text("a", "Ardvale")]);
    const base = prepared.release;
    const { device, released } = fakeDevice();
    await refineGlyphs(prepared, device, 2.2, () => false);
    const first = [prepared.frame.fineGlyphs, prepared.frame.fineAtlas];
    expect(await refineGlyphs(prepared, device, 2.2, () => false)).toBe("current");
    await refineGlyphs(prepared, device, 3, () => false);
    expect(released).toEqual(first);
    expect(await refineGlyphs(prepared, device, 4, () => false)).toBe("none");
    expect(prepared.frame.fineGlyphs).toBeNull();
    expect(released).toHaveLength(4);
    await refineGlyphs(prepared, device, 2.5, () => false);
    prepared.release();
    expect(base).toHaveBeenCalledOnce();
    expect(released).toHaveLength(6);
  });

  it("keeps the bucket set when the re-cut is stale, over budget, or lays a label out differently", async () => {
    const prepared = await frame(4, [text("a", "Ardvale")]);
    expect(await refineGlyphs(prepared, fakeDevice().device, 2.2, () => true)).toBe("stale");
    expect(prepared.frame.fineGlyphs ?? null).toBeNull();
    expect(await refineGlyphs(prepared, fakeDevice(1 << 30).device, 2.2, () => false)).toBe("budget");
    expect(prepared.frame.fineGlyphs ?? null).toBeNull();
    prepared.glyphLabels![0].count += 1; // a frame whose label had one more instance at the bucket
    expect(await refineGlyphs(prepared, fakeDevice().device, 2.2, () => false)).toMatch(/^mismatch a: /);
    expect(prepared.frame.fineGlyphs ?? null).toBeNull();
  });
});
