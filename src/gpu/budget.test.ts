import { describe, expect, it } from "vitest";
import {
  alphaBounds,
  canvasAntialias,
  compatAllowance,
  cropRegion,
  DETAIL_RESERVE,
  fitScale,
  GPU_BUDGET,
  MIN_COMPAT_BUDGET,
  PEAK_LIMIT,
  padBounds,
  refineOrder,
  reliefCell,
  TARGET_BUDGET,
  targetBytes,
  targetSamples,
  windowAllowance
} from "./budget";
import type { TrackedTexture } from "./device";
import { type ImageBatch, imageSource } from "./framegraph";

// RGBA raster with the given opaque pixels
function raster(width: number, height: number, opaque: [number, number][]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (const [x, y] of opaque) data[(y * width + x) * 4 + 3] = 1;
  return data;
}

describe("alphaBounds", () => {
  it("finds the tight box of any non-zero alpha", () => {
    expect(
      alphaBounds(
        raster(4, 3, [
          [1, 0],
          [2, 2]
        ]),
        4,
        3
      )
    ).toEqual({ x: 1, y: 0, width: 2, height: 3 });
    expect(alphaBounds(raster(5, 5, [[4, 4]]), 5, 5)).toEqual({ x: 4, y: 4, width: 1, height: 1 });
    expect(
      alphaBounds(
        raster(6, 4, [
          [3, 1],
          [0, 2],
          [5, 2]
        ]),
        6,
        4
      )
    ).toEqual({ x: 0, y: 1, width: 6, height: 2 });
  });

  it("ignores colour in fully transparent pixels and returns null for empty rasters", () => {
    const data = raster(3, 3, []);
    data.fill(255);
    for (let i = 3; i < data.length; i += 4) data[i] = 0;
    expect(alphaBounds(data, 3, 3)).toBeNull();
  });
});

describe("padBounds / cropRegion", () => {
  it("pads with transparent pixels, clamped to the raster", () => {
    expect(padBounds({ x: 5, y: 5, width: 2, height: 2 }, 1, 20, 20)).toEqual({ x: 4, y: 4, width: 4, height: 4 });
    expect(padBounds({ x: 1, y: 0, width: 2, height: 3 }, 1, 4, 3)).toEqual({ x: 0, y: 0, width: 4, height: 3 });
  });

  it("maps kept pixels to world space at the same density", () => {
    const region = { x: 100, y: 50, width: 200, height: 100 };
    const rect = cropRegion(region, 400, 200, { x: 40, y: 20, width: 80, height: 40 });
    expect(rect).toEqual({ x: 120, y: 60, width: 40, height: 20 });
    // pixels per world unit unchanged: 80 px over 40 units == 400 px over 200 units
    expect(80 / rect.width).toBe(400 / region.width);
    expect(cropRegion(region, 400, 200, { x: 0, y: 0, width: 400, height: 200 })).toEqual(region);
  });
});

describe("memory allowances", () => {
  const MiB = 1 << 20;

  it("keeps window refreshes within steady once the old set is released, and within peak meanwhile", () => {
    // 120 MiB tracked, 10 of it windows: the new set may take the 50 MiB left after the old set goes
    expect(windowAllowance(120 * MiB, 10 * MiB)).toBe(50 * MiB);
    // near the peak the coexisting old+new set is the bound
    expect(windowAllowance(250 * MiB, 200 * MiB)).toBe(6 * MiB);
    for (const [total, windows] of [
      [120, 10],
      [158, 0],
      [250, 200],
      [300, 20]
    ]) {
      const allowed = windowAllowance(total * MiB, windows * MiB);
      expect(total * MiB - windows * MiB + allowed).toBeLessThanOrEqual(
        Math.max(GPU_BUDGET, total * MiB - windows * MiB)
      );
      expect(total * MiB + allowed).toBeLessThanOrEqual(Math.max(PEAK_LIMIT, total * MiB));
    }
  });

  it("charges base growth from refinement to windows instead of overshooting steady", () => {
    // refinement filled up to the reserve: detail grew the base, so a window refresh only gets the reserve back
    const base = GPU_BUDGET - DETAIL_RESERVE;
    expect(windowAllowance(base, 0)).toBe(DETAIL_RESERVE);
    // detail that filled the whole budget (pre-reserve behaviour) leaves windows nothing: they must free detail first
    expect(windowAllowance(GPU_BUDGET + 4 * MiB, 0)).toBe(0);
    expect(windowAllowance(GPU_BUDGET - 4 * MiB, 0) + GPU_BUDGET - 4 * MiB).toBe(GPU_BUDGET);
  });

  it("bounds compat rasters by the frame's steady share and the swap peak", () => {
    // first frame: nothing coexists, so the steady share (budget - target reserve - owned - pending) binds
    expect(compatAllowance(40 * MiB, 10 * MiB, 5 * MiB)).toBe(GPU_BUDGET - TARGET_BUDGET - 15 * MiB);
    // re-prepare beside a 150 MiB frame: peak room binds
    expect(compatAllowance(210 * MiB, 10 * MiB, 5 * MiB)).toBe(PEAK_LIMIT - 215 * MiB);
    expect(compatAllowance(300 * MiB, 0, 0)).toBe(0);
  });

  it("no longer lifts compat to the 16 MiB floor when the room is smaller", () => {
    // the floor used to be a minimum grant (overshoot); now it only decides between downscaling and failing to SVG
    const room = compatAllowance(250 * MiB, 0, 0);
    expect(room).toBe(6 * MiB);
    expect(room).toBeLessThan(MIN_COMPAT_BUDGET);
    expect(fitScale(40 * MiB, room)).toBeLessThan(1);
  });
});

// The W2 incident (stroke + compat merge): the dense parity world at k 8, 1280x720 DPR 2, every layer on but the data
// overlays, prepared alone after an editor closed. Bytes measured with a trace in prepareFrame's world loop.
describe("dense parity prepare share (W2 budget regression)", () => {
  const MiB = 1 << 20;
  const screen = 14.55 * MiB; // compat screen overlays
  const vertices = 5.47 * MiB; // fans 3.05, fill edges 2.05 (STROKE), segments 0.24, caps 0.09, glyph instances 0.04
  const patterns = 1.06 * MiB;
  const room = (atlas: number, owned: number) => compatAllowance(0, owned, vertices + atlas) - screen;

  it("fell under the floor with the full glyph atlas and the uncropped relief viewport detail", () => {
    // 16 MiB atlas (2048² RGBA) pending, 27.56 MiB relief viewport detail owned: 15.4 MiB, "world rasters need 25.1"
    expect(room(16 * MiB, patterns + 27.56 * MiB)).toBeLessThan(MIN_COMPAT_BUDGET);
    // the 2.05 MiB of fill edges alone was the difference: without them the share cleared the floor
    expect(room(16 * MiB, patterns + 27.56 * MiB) + 2.05 * MiB).toBeGreaterThan(MIN_COMPAT_BUDGET);
  });

  it("clears it with room to spare once the atlas uploads its used rows", () => {
    // 2.77 MiB of atlas rows at k 8; the detail now counts with the bitmap windows (28.7-31.3 MiB measured)
    expect(room(2.77 * MiB, patterns + 31.26 * MiB)).toBeGreaterThan(MIN_COMPAT_BUDGET + 8 * MiB);
  });
});

describe("fitScale", () => {
  it("keeps full resolution when within budget and scales area to the budget otherwise", () => {
    expect(fitScale(100, 200)).toBe(1);
    expect(fitScale(200, 200)).toBe(1);
    expect(fitScale(400, 100)).toBe(0.5);
    const scale = fitScale(300 << 20, 64 << 20);
    expect(300 * scale * scale).toBeCloseTo(64);
    expect(fitScale(100, -5)).toBe(0);
  });
});

describe("refineOrder", () => {
  const visible = { x: 0, y: 0, width: 100, height: 100 };
  it("refines the smallest visible area first so large fills cannot starve sparse runs", () => {
    const ocean: [number, number, number, number] = [-50, -50, 200, 200];
    const ice: [number, number, number, number] = [0, 0, 60, 60];
    const label: [number, number, number, number] = [10, 10, 20, 5];
    expect(refineOrder([ocean, ice, label], visible)).toEqual([2, 1, 0]);
  });
  it("measures only the visible part and keeps painter order on ties", () => {
    const offscreen: [number, number, number, number] = [500, 500, 400, 400];
    const edge: [number, number, number, number] = [90, 0, 1000, 10]; // 10x10 visible
    const inside: [number, number, number, number] = [0, 0, 10, 10];
    expect(refineOrder([inside, edge, offscreen], visible)).toEqual([2, 0, 1]);
    expect(refineOrder([], visible)).toEqual([]);
  });
  it("refines sharp text/marker runs before smooth fills even when their bounds span the view", () => {
    // full-scene DPR2 z1: the ocean pattern (smaller by a fog margin) took the last room before labels+markers
    const pattern: [number, number, number, number] = [0, 0, 100, 90];
    const scattered: [number, number, number, number] = [-10, -10, 120, 120];
    const label: [number, number, number, number] = [10, 10, 20, 5];
    const ice: [number, number, number, number] = [0, 0, 60, 60];
    expect(refineOrder([pattern, scattered, label, ice], visible)).toEqual([2, 3, 0, 1]);
    expect(refineOrder([pattern, scattered, label, ice], visible, [false, true, true, false])).toEqual([2, 1, 3, 0]);
  });
});

describe("render target policy", () => {
  it("counts multisampled colour + depth/stencil and the resolve texture", () => {
    expect(targetBytes(100, 100, 4)).toBe(100 * 100 * 4 * 4 * 2 + 100 * 100 * 4);
    expect(targetBytes(100, 100, 0)).toBe(100 * 100 * 8);
  });

  it("keeps 4x MSAA at DPR1 and drops samples when the target would exceed its budget", () => {
    expect(targetSamples(1920, 1080, 4)).toBe(4);
    expect(targetBytes(1920, 1080, 4)).toBeLessThanOrEqual(TARGET_BUDGET);
    expect(targetSamples(2560, 1440, 4)).toBe(2);
    expect(targetSamples(2560, 1440, 4, TARGET_BUDGET, 2)).toBe(0);
    expect(targetSamples(3840, 2160, 4)).toBe(0);
    expect(targetSamples(1920, 1080, 2)).toBe(2);
    expect(targetSamples(1920, 1080, 0)).toBe(0);
    for (const [w, h] of [
      [1920, 1080],
      [2560, 1440],
      [2880, 1800]
    ])
      expect(targetBytes(w, h, targetSamples(w, h, 4))).toBeLessThanOrEqual(TARGET_BUDGET);
    // A direct single-sample target uses 8 B/px, including depth/stencil, and fits even a 4K backing store.
    expect(targetBytes(3840, 2160, 0)).toBeLessThanOrEqual(TARGET_BUDGET);
    expect(TARGET_BUDGET).toBeLessThan(GPU_BUDGET);
  });

  it("multisamples the canvas drawing buffer only below Retina density, like group targets", () => {
    expect(canvasAntialias()).toBe(true);
    expect(canvasAntialias(1.5)).toBe(true);
    expect(canvasAntialias(2)).toBe(false);
    expect(canvasAntialias(3)).toBe(false);
    for (const dpr of [1, 1.5, 2, 3])
      expect(canvasAntialias(dpr)).toBe(targetSamples(2560, 1440, 4, TARGET_BUDGET, dpr) > 0);
  });
});

describe("reliefCell", () => {
  it("sizes atlas cells to the largest on-screen icon (power of two, 16..256)", () => {
    expect(reliefCell(10, 1)).toBe(16);
    expect(reliefCell(14, 1)).toBe(16);
    expect(reliefCell(15, 1)).toBe(32);
    expect(reliefCell(20, 2)).toBe(64);
    expect(reliefCell(200, 4)).toBe(256);
    expect(reliefCell(0, 1)).toBe(16);
    expect(reliefCell(200, 4, 128)).toBe(128);
  });
});

describe("imageSource", () => {
  const base = { id: "base" } as unknown as TrackedTexture;
  const sharp = { id: "detail" } as unknown as TrackedTexture;
  const batch = (screen: boolean, detail: ImageBatch["detail"]): ImageBatch => ({
    kind: "image",
    texture: base,
    rect: [0, 0, 1000, 1000],
    screen,
    detail
  });
  const detail: NonNullable<ImageBatch["detail"]> = {
    texture: sharp,
    rect: [110, 120, 50, 60] as ImageBatch["rect"],
    covers: [100, 100, 200, 200]
  };

  it("draws exactly one raster: detail inside its coverage, base otherwise", () => {
    expect(imageSource(batch(false, detail), [100, 100, 300, 300])).toBe(detail);
    expect(imageSource(batch(false, detail), [150, 150, 250, 250]).texture).toBe(sharp);
    const outside = batch(false, detail);
    expect(imageSource(outside, [90, 100, 300, 300])).toBe(outside);
    expect(imageSource(outside, [100, 100, 301, 300]).texture).toBe(base);
    expect(imageSource(batch(false, null), [150, 150, 250, 250]).texture).toBe(base);
  });

  it("keeps a transparent detail (null texture) instead of falling back to the blurrier base", () => {
    const empty = { ...detail, texture: null };
    expect(imageSource(batch(false, empty), [150, 150, 250, 250]).texture).toBeNull();
  });

  it("never uses detail for screen-space runs", () => {
    expect(imageSource(batch(true, detail), [150, 150, 250, 250]).texture).toBe(base);
  });
});
