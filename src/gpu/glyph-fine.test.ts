// @vitest-environment happy-dom
// GLYPHZ (W4a) glyph-fine.ts: the settle-time re-cut of a frame's native labels at the exact device scale. The layout
// runs for real (text.ts layoutLabels on straight <text>) over a stubbed Canvas2D with fixed metrics, as
// text-layout-straight.test.ts does; the device is a fake that records uploads and releases.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GpuDevice } from "./device";
import {
  fineGlyphsAt,
  type GlyphCamera,
  glyphRefineWanted,
  placedGlyphsAt,
  refineGlyphs,
  wantsFineGlyphs
} from "./glyph-fine";
import type { Prepared } from "./prepare";
import { GLYPH_FLOATS, GlyphAtlas, layoutLabels, PLACED_MODE, PlacedGlyphAtlas, placePen } from "./text";

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
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4).fill(255)
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
    buffer: (label: string, data: Float32Array) => ({
      kind: "buffer",
      label,
      data: data.slice(),
      bytes: data.byteLength
    }),
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
  let at = 0;
  for (const chunk of chunks) {
    glyphs.set(chunk, at);
    at += chunk.length;
  }
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

// A camera at device scale `scale` (dpr 2) whose view holds no glyph: the scale step alone (the placed cut finds none).
const at = (scale: number, view: Partial<GlyphCamera> = {}): GlyphCamera => ({
  x: 0,
  y: 0,
  k: scale / 2,
  dpr: 2,
  width: 0,
  height: 0,
  ...view
});
// the scale step's outcome
const fineStep = async (outcome: Promise<string>) => (await outcome).split(" placed ")[0];

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
    expect(await fineStep(refineGlyphs(prepared, device, at(2.2), () => false))).toBe("cut");
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
    await refineGlyphs(prepared, device, at(2.2), () => false);
    const first = [prepared.frame.fineGlyphs, prepared.frame.fineAtlas];
    expect(await fineStep(refineGlyphs(prepared, device, at(2.2), () => false))).toBe("current");
    await refineGlyphs(prepared, device, at(3), () => false);
    expect(released).toEqual(first);
    expect(await fineStep(refineGlyphs(prepared, device, at(4), () => false))).toBe("none");
    expect(prepared.frame.fineGlyphs).toBeNull();
    expect(released).toHaveLength(4);
    await refineGlyphs(prepared, device, at(2.5), () => false);
    prepared.release();
    expect(base).toHaveBeenCalledOnce();
    expect(released).toHaveLength(6);
  });

  it("keeps the bucket set when the re-cut is stale, over budget, or lays a label out differently", async () => {
    const prepared = await frame(4, [text("a", "Ardvale")]);
    expect(await fineStep(refineGlyphs(prepared, fakeDevice().device, at(2.2), () => true))).toBe("stale");
    expect(prepared.frame.fineGlyphs ?? null).toBeNull();
    expect(await fineStep(refineGlyphs(prepared, fakeDevice(1 << 30).device, at(2.2), () => false))).toBe("budget");
    expect(prepared.frame.fineGlyphs ?? null).toBeNull();
    prepared.glyphLabels![0].count += 1; // a frame whose label had one more instance at the bucket
    expect(await fineStep(refineGlyphs(prepared, fakeDevice().device, at(2.2), () => false))).toMatch(/^mismatch a: /);
    expect(prepared.frame.fineGlyphs ?? null).toBeNull();
  });
  it("is wanted for a camera whose placed cut is missing, and not again at the same camera", async () => {
    const prepared = await frame(4, [text("a", "Ardvale")]);
    const { device } = fakeDevice();
    const camera = at(4, { x: 10.3, y: 7.6, width: 400, height: 300 });
    expect(glyphRefineWanted(prepared, camera)).toBe(true); // at the bucket: no fine set, but no placed cut either
    expect(await refineGlyphs(prepared, device, camera, () => false)).toMatch(/^none placed cut \d+$/);
    expect(glyphRefineWanted(prepared, camera)).toBe(false);
    expect(glyphRefineWanted(prepared, { ...camera, x: 10.4 })).toBe(true); // a pan moves every pen's phase
    expect(glyphRefineWanted(prepared, { ...camera, width: 500 })).toBe(true); // a resize moves the view
    expect(glyphRefineWanted(prepared, at(4.4, { width: 400, height: 300 }))).toBe(true);
  });

  it("swaps the glyphs in view for device-aligned cells cut at their pen, keeping the rest of the set", async () => {
    const prepared = await frame(4, [text("a", "Ardvale"), text("b", "Varn", 40, 300)]);
    const { device } = fakeDevice();
    const camera = at(2.2, { x: 10.3, y: 7.6, width: 400, height: 200 });
    const outcome = await refineGlyphs(prepared, device, camera, () => false);
    expect(outcome).toMatch(/^cut placed cut 7$/); // "Ardvale" is in view, "Varn" (y 300 * 1.1 + 7.6) is not
    const placed = prepared.frame.placedGlyphs as unknown as { data: Float32Array };
    const fine = prepared.frame.fineGlyphs as unknown as { data: Float32Array };
    expect(placedGlyphsAt(prepared.frame, 2.2)?.glyphs).toBe(prepared.frame.placedGlyphs);
    expect(placedGlyphsAt(prepared.frame, 4)).toBeNull();
    for (let i = 0; i < prepared.payload.glyphCount; i++) {
      const swapped = i < 7;
      expect(field(placed.data, i, 17)).toBe(swapped ? PLACED_MODE : field(fine.data, i, 17));
      for (const f of [11, 12, 13, 14]) expect(field(placed.data, i, f)).toBe(field(fine.data, i, f));
      if (!swapped) {
        for (let f = 0; f < GLYPH_FLOATS; f++) expect(field(placed.data, i, f)).toBe(field(fine.data, i, f));
        continue;
      }
      // an unrotated quad whose corners are whole device px at the camera, a cell of one texel per device px
      const device = (world: number, offset: number) => (world * camera.k + offset) * camera.dpr;
      expect(field(placed.data, i, 2)).toBe(0);
      const x0 = device(field(placed.data, i, 0), camera.x);
      const y0 = device(field(placed.data, i, 1), camera.y);
      expect(Math.abs(x0 - Math.round(x0))).toBeLessThan(1e-3);
      expect(Math.abs(y0 - Math.round(y0))).toBeLessThan(1e-3);
      const texels = (field(placed.data, i, 9) - field(placed.data, i, 7)) * 2048;
      expect(field(placed.data, i, 5) * 2.2).toBeCloseTo(texels, 3);
    }
    // a pan at the same scale cuts again, from the places the fine cut recorded (no label is laid out again);
    // another scale drops the placed copy with the fine set it sits on
    const styles = vi.mocked(window.getComputedStyle).mock.calls.length;
    expect(await refineGlyphs(prepared, device, { ...camera, x: 11 }, () => false)).toBe("current placed cut 7");
    expect(vi.mocked(window.getComputedStyle).mock.calls.length).toBe(styles);
    expect(prepared.frame.placedKey).toContain(" 11 ");
    await refineGlyphs(prepared, device, at(3, { width: 400, height: 200 }), () => false);
    expect(prepared.frame.placedScale).toBe(3);
    expect(await fineStep(refineGlyphs(prepared, device, at(4), () => false))).toBe("none");
    expect(prepared.frame.placedGlyphs ?? null).toBeNull();
  });

  it("cuts a rotated glyph into a cell around its rotated box, and only when the cell reaches the view", () => {
    const measurer = document.createElement("canvas").getContext("2d")!;
    const atlas = new PlacedGlyphAtlas(measurer);
    const place = {
      font: "normal 700 20px Helvetica", // 12 px wide, ascent 16, descent 4 (fakeContext)
      char: "W",
      halo: 0,
      join: "miter" as CanvasLineJoin,
      miter: 4,
      ink: "rgb(0,0,0)",
      x: 0,
      y: 0,
      angle: Math.PI / 2,
      ox: 0,
      oy: 0,
      dynamic: [0, 0, 0] as [number, number, number]
    };
    const cell = atlas.add(place, [50.25, 40.5], { width: 100, height: 100 })!;
    // the box around the pen is x -3..15, y -19..7 (ink plus the 3 px margin); a quarter turn maps (x, y) to (-y, x):
    // device x 43.25..69.25, y 37.5..55.5, so the cell is the whole px 43..70 x 37..56
    expect([cell.x0, cell.y0, cell.width, cell.height]).toEqual([43, 37, 27, 19]);
    expect(atlas.add(place, [-40, 40], { width: 100, height: 100 })).toBeNull();
    expect(atlas.add(place, [50, 140], { width: 100, height: 100 })).toBeNull();
  });
  it("puts a pen on a device-row tie where Chromium's float32 user-space position puts it", () => {
    // shared k1.1, 'The Badlands' (Almendra SC 19.09px, nested central baseline: a shift of 8 CSS px): in doubles the
    // pen is at device y 686.5 exactly and rounds down the screen; the SVG paints from 683.27270508 (float32), a row up
    const place = {
      font: "normal 400 42px serif",
      char: "T",
      halo: 0,
      join: "miter" as CanvasLineJoin,
      miter: 4,
      ink: "rgb(0,0,0)",
      x: 1715.284,
      y: 676,
      angle: 0,
      ox: 0,
      oy: 0,
      dynamic: [17.92551, 4.79159, 2] as [number, number, number]
    };
    const [, y] = placePen(place, { x: -1046.3, y: -408.35, k: 1.1, dpr: 2 });
    expect(y).toBeLessThan(686.5);
    expect(y).toBeGreaterThan(686.49);
    expect(Math.floor(y + 0.5)).toBe(686);
  });
});
