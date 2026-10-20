// [RES] prepare-time first-frame details: refineCompat's `only`, `room` and `minGain` options, and releaseDetail's keep.
import { describe, expect, it, vi } from "vitest";

// A run's element carries the detail raster it produces: `size` px square, or none (fully transparent) when 0.
interface FakeElement {
  id: string;
  tagName: string;
  parentElement: null;
  size: number;
}
interface FakeCanvas {
  width: number;
  height: number;
}

const { cuts, clones } = vi.hoisted(() => ({ cuts: [] as string[], clones: { count: 0 } }));
vi.mock("./compat", () => ({
  compatClone: async () => {
    clones.count++;
    return {};
  },
  stampedClone: async () => ({ clone: {}, stamp: 0 }),
  compatResolution: () => 1,
  scaleRaster: (canvas: FakeCanvas) => canvas,
  resolveInClone: (element: unknown) => element,
  rasterizeRun: async (_clone: unknown, elements: FakeElement[]) => {
    cuts.push(elements[0].id);
    return { width: elements[0].size, height: elements[0].size };
  },
  cropRaster: (canvas: FakeCanvas) =>
    canvas.width ? { canvas, rect: { x: 0, y: 0, width: canvas.width, height: canvas.height } } : null
}));
vi.mock("./clone-map", () => ({ resolveManyInClone: (elements: unknown[]) => elements }));

import { detailShare, type Prepared, refineCompat, refineRequest, refineView, releaseDetail } from "./prepare";

interface FakeTexture {
  width: number;
  height: number;
  bytes: number;
}

function device(base: number) {
  const live = new Set<FakeTexture>();
  return {
    live,
    memory: () => ({ total: base + [...live].reduce((n, texture) => n + texture.bytes, 0) }),
    texture: (_label: string, canvas: FakeCanvas) => {
      const texture = { width: canvas.width, height: canvas.height, bytes: canvas.width * canvas.height * 4 };
      live.add(texture);
      return texture;
    },
    release: (texture: FakeTexture | null | undefined) => {
      if (texture) live.delete(texture);
    }
  };
}

const visible = { x: 0, y: 0, width: 100, height: 100 };
const pixels = { width: 200, height: 200 };

function frame(sizes: number[]) {
  const runs = sizes.map((size, i) => ({
    slot: {
      kind: "image",
      texture: { width: 1, height: 1, bytes: 4 },
      rect: [i * 10, 0, 10, 10] as [number, number, number, number],
      screen: false,
      detail: null as null | { texture: FakeTexture | null; rect: number[]; covers: number[] }
    },
    elements: [{ id: `run${i}`, tagName: "g", parentElement: null, size }],
    screen: false,
    sharp: false,
    stamp: 0,
    key: "",
    detailMeta: undefined as { request: string; size: [number, number] | null; fit: number } | undefined
  }));
  // resolution far above any detail density: an over-budget detail is never downscaled, it keeps the base
  const prepared = { runs, compat: { resolution: 1e9 } } as unknown as Prepared;
  return { prepared, runs };
}

const ctx = (gpu: ReturnType<typeof device>) =>
  ({ device: gpu, revision: 1, stale: () => false }) as unknown as Parameters<typeof refineCompat>[1];

// scaleCanvas draws into a new canvas: a stand-in that only keeps the size
const fakeCanvas = () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) });
(globalThis.document as unknown as { createElement: unknown }).createElement = fakeCanvas;

// [RES] The first GPU frame of a zoom drew sharp compat runs (labels, markers, burg icons) from the whole-world raster
// (at most 2 px per unit, 1.1 on the dense parity world) until the settle refinement. prepareFrame now cuts those
// runs' details before the frame commits (firstDetails): refineCompat restricted to sharp runs, within its own room,
// skipping runs whose base is already as dense; the settle refinement then keeps them (same request).
describe("first-frame details (refineCompat options)", () => {
  it("cuts only the runs `only` selects and leaves the others untouched", async () => {
    const gpu = device(0);
    const { prepared, runs } = frame([10, 10, 10]);
    (prepared.compat as { resolution: number }).resolution = 1;
    cuts.length = 0;
    runs[2].slot.detail = { texture: null, rect: [], covers: [] }; // someone else's detail: not dropped
    await refineCompat(prepared, ctx(gpu), visible, pixels, 1 << 30, { only: run => run === (runs[0] as never) });
    expect(cuts).toEqual(["run0"]);
    expect(runs[0].slot.detail?.texture).toMatchObject({ width: 10, height: 10 });
    expect(runs[1].slot.detail).toBeNull();
    expect(runs[2].slot.detail).not.toBeNull();
  });

  it("stays within the room the caller measures, downscaling while that still beats the base", async () => {
    const gpu = device(0);
    const { prepared, runs } = frame([10, 10]);
    (prepared.compat as { resolution: number }).resolution = 1; // detail density is 2 px per unit
    let spent = 0;
    const room = () => 500 - spent;
    const texture = gpu.texture;
    gpu.texture = (label, canvas) => {
      spent += canvas.width * canvas.height * 4;
      return texture(label, canvas);
    };
    await refineCompat(prepared, ctx(gpu), visible, pixels, 1 << 30, { room });
    // run0 (400 B) fits; run1 gets the 100 B left: 5x5 px, density 1 px per unit = the base, so it keeps the base
    expect(runs[0].slot.detail?.texture).toMatchObject({ width: 10, height: 10 });
    expect(runs[1].slot.detail).toBeNull();
    expect(spent).toBeLessThanOrEqual(500);
  });

  it("shares the room among sharp runs at one density instead of first come, first served", async () => {
    // three sharp runs, each a 22 px detail (its footprint: 10 units of view at 2 px per unit, plus the gutter)
    const run = async (sharp: boolean) => {
      const gpu = device(0);
      const { prepared, runs } = frame([22, 22, 22]);
      (prepared.compat as { resolution: number }).resolution = 1;
      for (const item of runs) item.sharp = sharp;
      const room = 3 * 22 * 22 * 2; // half of what full density needs
      await refineCompat(prepared, ctx(gpu), visible, pixels, room);
      return runs.map(item => item.slot.detail?.texture?.width ?? 0);
    };
    // smooth runs: greedy, the first at full density, the second downscaled into what is left, the third keeps the base
    expect(await run(false)).toEqual([22, 15, 0]);
    // sharp runs: all three at sqrt(1/2) of the density (15 px), within the room
    expect(await run(true)).toEqual([15, 15, 15]);
  });

  it("skips runs whose base raster is already about as dense as the detail (minGain)", async () => {
    const gpu = device(0);
    const { prepared } = frame([10]);
    (prepared.compat as { resolution: number }).resolution = 2; // == pixels.width / visible.width
    cuts.length = 0;
    expect(await refineCompat(prepared, ctx(gpu), visible, pixels, 1 << 30, { minGain: 1.01 })).toBe(false);
    expect(cuts).toEqual([]);
    (prepared.compat as { resolution: number }).resolution = 1.5;
    await refineCompat(prepared, ctx(gpu), visible, pixels, 1 << 30, { minGain: 1.01 });
    expect(cuts).toEqual(["run0"]);
  });

  it("releaseDetail keeps the details cut for the settle's own request, which the settle refinement then keeps", async () => {
    const gpu = device(0);
    const { prepared, runs } = frame([10, 10]);
    (prepared.compat as { resolution: number }).resolution = 1;
    await refineCompat(prepared, ctx(gpu), visible, pixels, 1 << 30, { only: run => run === (runs[0] as never) });
    const first = runs[0].slot.detail?.texture;
    releaseDetail(prepared, gpu as never, refineRequest(visible, pixels));
    expect(runs[0].slot.detail?.texture).toBe(first);
    cuts.length = 0;
    await refineCompat(prepared, ctx(gpu), visible, pixels, 1 << 30);
    expect(cuts).toEqual(["run1"]); // run0's first-frame detail kept, not cut again
    expect(runs[0].slot.detail?.texture).toBe(first);
    releaseDetail(prepared, gpu as never, "another view");
    expect(runs.every(run => run.slot.detail === null)).toBe(true);
    expect(gpu.live.size).toBe(0);
  });

  it("refineView asks for the visible world plus 64 CSS px at backing density plus 128 CSS px", () => {
    const { visible: view, pixels: size } = refineView(
      { k: 4, x: -400, y: -200 },
      { width: 1280, height: 720, dpr: 2 }
    );
    expect(view).toEqual({ x: 84, y: 34, width: 352, height: 212 });
    expect(size).toEqual({ width: 2816, height: 1696 });
    expect(refineRequest(view, size)).toBe("84,34,352,212@2816x1696");
  });

  // [RES] Sizing the group target reserve to the real target (targetReserve) gave world rasters ~50 MiB more; they took
  // it all, and a zoomed view's settle detail had no room (dense parity world, k8 DPR 2: no detail at all).
  it("detailShare leaves zoomed views room for sharp detail, none at the overview, never past half the world room", () => {
    const MiB = 1 << 20;
    const run = (sharp: boolean) => ({ sharp }) as never;
    const screen = { width: 1280, height: 720, dpr: 2 };
    const sharp = [run(true), run(true), run(true), run(false)];
    // overview: 2 device px per unit is the base resolution, the world raster already is the view at device density
    expect(detailShare(sharp, 2, { k: 1, x: 0, y: 0 }, screen, 120 * MiB)).toBe(0);
    // zoomed: three views of 2816x1696 px want 57 MB, capped at DETAIL_SHARE
    expect(detailShare(sharp, 2, { k: 4, x: -400, y: -200 }, screen, 120 * MiB)).toBe(48 * MiB);
    expect(detailShare([run(true)], 2, { k: 4, x: -400, y: -200 }, screen, 120 * MiB)).toBe(2816 * 1696 * 4);
    expect(detailShare(sharp, 2, { k: 4, x: -400, y: -200 }, screen, 40 * MiB)).toBe(20 * MiB);
    expect(detailShare(sharp, 2, { k: 4, x: -400, y: -200 }, screen, 24 * MiB)).toBe(8 * MiB);
    expect(detailShare(sharp, 2, { k: 4, x: -400, y: -200 }, screen, 10 * MiB)).toBe(0);
    expect(detailShare([run(false)], 2, { k: 4, x: -400, y: -200 }, screen, 120 * MiB)).toBe(0);
  });
});
