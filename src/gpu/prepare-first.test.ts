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

import { DETAIL_RESERVE, FIRST_DETAIL_MS, GPU_BUDGET } from "./budget";
import {
  detailFootprint,
  detailShare,
  firstDetails,
  frameBytes,
  type Prepared,
  refineCompat,
  refineRequest,
  refineView,
  releaseDetail,
  residentBytes,
  revisionOnly
} from "./prepare";

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

  // [LABFIX] The share was sized from each sharp run's base raster rect clipped to the view. A run of labels spread over
  // the world has a world-wide base rect, so in a zoomed view every label run looked view-sized: six of them (115 MB)
  // against ~106 MB of room shared out a 0.96 density and every label detail was resampled (shared fixture labels k4,
  // ink 31585 GPU vs 22364 SVG px). What the run's elements reach in the view (their boxes) sizes it instead.
  it("sizes the sharp share from what the runs' elements reach in the view, not their world-wide base rects", async () => {
    const gpu = device(0);
    const { prepared, runs } = frame([22, 22, 22]);
    (prepared.compat as { resolution: number }).resolution = 1;
    for (const [i, run] of runs.entries()) {
      run.sharp = true;
      run.slot.rect = [-1000, -1000, 3000, 3000]; // labels all over the world
      // one 10-unit label in the view (the others outside it)
      (run as { boxes?: unknown }).boxes = [
        { x0: i * 30, y0: 0, x1: i * 30 + 10, y1: 10 },
        { x0: 500, y0: 500, x1: 520, y1: 510 }
      ];
    }
    // three 22 px details fit at full density; three view-sized ones (202 px square) would not
    await refineCompat(prepared, ctx(gpu), visible, pixels, 64 << 10);
    expect(runs.map(run => run.slot.detail?.texture?.width ?? 0)).toEqual([22, 22, 22]);
    expect(runs.map(run => run.detailMeta?.fit)).toEqual([1, 1, 1]);
  });

  it("detailFootprint: a kept detail's own size, else the smaller of the base rect and the element boxes in view", () => {
    const { runs } = frame([10]);
    const run = runs[0] as unknown as Parameters<typeof detailFootprint>[0];
    const density = 2;
    run.slot.rect = [0, 0, 100, 100];
    expect(detailFootprint(run, visible, density)).toBe(202 * 202 * 4); // no boxes: the base rect in view
    run.boxes = [{ x0: 10, y0: 10, x1: 20, y1: 15 }];
    // the box padded by 2 units each side (14 x 9 units = 28 x 18 px), plus 12 px window padding and the 1 px crop
    expect(detailFootprint(run, visible, density)).toBe((28 + 26) * (18 + 26) * 4);
    run.boxes = [{ x0: 300, y0: 300, x1: 310, y1: 310 }]; // nothing in view
    expect(detailFootprint(run, visible, density)).toBe(0);
    run.boxes = null; // unmeasurable: the base rect
    expect(detailFootprint(run, visible, density)).toBe(202 * 202 * 4);
    run.detailMeta = { request: "r", size: [30, 40], fit: 0.5 };
    expect(detailFootprint(run, visible, density, true)).toBe(30 * 40 * 4);
    run.detailMeta = { request: "r", size: null, fit: 1 };
    expect(detailFootprint(run, visible, density, true)).toBe(0);
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

// [RES2] prepareFrame's own first-frame pass (firstDetails) and the steady-budget accounting around it.
describe("first-frame details (prepareFrame level)", () => {
  const camera = { k: 4, x: -400, y: -200 };
  const screen = { width: 1280, height: 720, dpr: 2 };
  const buffer = (bytes: number) => ({ kind: "buffer", bytes });
  const texture = (bytes: number) => ({ kind: "texture", bytes, width: 1, height: 1 });

  // a frame with sharp runs, its own bytes known: runs' base textures, a pattern recipe, windows, buffers, atlas
  function sharpFrame(sizes: number[], elements: number[] = sizes.map(() => 1)) {
    const built = frame(sizes);
    built.runs.forEach((run, i) => {
      run.sharp = true;
      run.elements = Array.from({ length: elements[i] }, (_, j) => ({
        id: j ? `run${i}.${j}` : `run${i}`,
        tagName: "g",
        parentElement: null,
        size: sizes[i]
      }));
    });
    const pattern = texture(1000);
    Object.assign(built.prepared, {
      windows: { bytes: 2000 },
      payload: { recipes: new Map([[pattern, {}]]), key: {} },
      frame: { batches: [], fans: buffer(300), segments: null, atlas: texture(700) },
      compat: { resolution: 1 }
    });
    return built;
  }
  const firstCtx = (gpu: ReturnType<typeof device>, stale = () => false) =>
    ({ device: gpu, revision: 1, stale, camera, screen }) as unknown as Parameters<typeof firstDetails>[1];

  it("frameBytes counts every resource of the frame once, carried settle details included", () => {
    const { prepared, runs } = sharpFrame([10, 10]);
    const shared = runs[0].slot.texture as unknown as object;
    (prepared.payload.recipes as Map<object, unknown>).set(shared, {}); // also a recipe: counted once
    runs[1].slot.detail = { texture: { width: 5, height: 5, bytes: 100 }, rect: [], covers: [] };
    // 2 run textures (4 B each) + detail 100 + pattern 1000 + windows 2000 + fans 300 + atlas 700
    expect(frameBytes(prepared)).toBe(4 + 4 + 100 + 1000 + 2000 + 300 + 700);
  });

  it("residentBytes is what the device tracks beyond the group target and the frame on screen", () => {
    const { prepared } = sharpFrame([10]);
    const own = frameBytes(prepared);
    // the trade-marker sprite textures (0.6 MiB at DPR 2) were the 0.64 MiB the dense parity world went over budget
    const sprites = 629_000;
    expect(residentBytes({ total: own + 30_000_000 + sprites, targets: 30_000_000 }, prepared)).toBe(sprites);
    expect(residentBytes({ total: sprites + 5, targets: 5 }, null)).toBe(sprites);
    expect(residentBytes({ total: 10, targets: 0 }, prepared)).toBe(0); // never negative
  });

  it("revisionOnly is an edit on the same world, bucket, viewport, picking mode and device, whatever the revision", () => {
    const key = {
      revision: 3,
      worldEpoch: 1,
      bucket: 8,
      picking: true,
      world: "0,0,1280,720",
      screen: "1280x720@2",
      scale: 4,
      maxTexture: 16384
    };
    expect(revisionOnly(key, { ...key, revision: 4, scale: 4.5 })).toBe(true);
    expect(revisionOnly(key, { ...key, revision: 4, bucket: 16 })).toBe(false); // a zoom into another bucket
    expect(revisionOnly(key, { ...key, worldEpoch: 2 })).toBe(false); // a load
    expect(revisionOnly(key, { ...key, screen: "1512x982@2" })).toBe(false); // a resize
    expect(revisionOnly(null, key)).toBe(false); // no frame on screen: a load, restore or a dropped frame
  });

  it("skips a revision-only prepare, and cuts nothing then", async () => {
    const gpu = device(0);
    const { prepared } = sharpFrame([10]);
    cuts.length = 0;
    expect(await firstDetails(prepared, firstCtx(gpu), 0, true)).toBe("revision only");
    expect(cuts).toEqual([]);
    expect(await firstDetails(prepared, firstCtx(gpu), 0, false)).toBe("cut");
    expect(cuts).toEqual(["run0"]);
  });

  it("skips a prepare behind the SVG (a restore, a resume hold): the settle refinement sharpens it", async () => {
    const gpu = device(0);
    const { prepared } = sharpFrame([10]);
    cuts.length = 0;
    expect(await firstDetails(prepared, { ...firstCtx(gpu), behind: "restore" }, 0, false)).toBe("restore");
    expect(await firstDetails(prepared, { ...firstCtx(gpu), behind: "resume hold" }, 0, false)).toBe("resume hold");
    expect(cuts).toEqual([]);
  });

  it("stays within the steady room left once the frame (carried details included) and the reserve are counted", async () => {
    const run = async (carried: number) => {
      const gpu = device(5_000_000); // the previous frame, still tracked: only what this pass allocates is spent
      const { prepared, runs } = sharpFrame([10, 10, 10]);
      if (carried) runs[2].slot.detail = { texture: { width: 1, height: 1, bytes: carried }, rect: [], covers: [] };
      runs[2].sharp = false; // not this pass's: its carried detail stays
      // a reserve that leaves this frame 500 B of steady room beside its own bytes (frameBytes without the detail)
      const reserve = GPU_BUDGET - DETAIL_RESERVE - (frameBytes(prepared) - carried) - 500;
      const before = gpu.memory().total;
      const outcome = await firstDetails(prepared, firstCtx(gpu), reserve);
      return {
        outcome,
        spent: gpu.memory().total - before,
        cut: runs.map(item => item.slot.detail?.texture?.width ?? 0)
      };
    };
    // 500 B: run0's 10x10 (400 B) at full density, run1 downscaled into the 100 B left (5x5)
    expect(await run(0)).toEqual({ outcome: "cut", spent: 500, cut: [10, 5, 0] });
    // a carried 300 B detail counts against the same room: 200 B left for the pass
    const carried = await run(300);
    expect(carried.spent).toBeLessThanOrEqual(200);
    expect(carried.cut[0]).toBe(7); // floor(10 * sqrt(200 / 400))
    // a carried detail at least as large as the room: nothing to spend
    expect((await run(500)).outcome).toBe("no room");
  });

  it("stops cutting at the FIRST_DETAIL_MS deadline: later runs wait for the settle refinement", async () => {
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const gpu = device(0);
      const cut = gpu.texture;
      gpu.texture = (label, canvas) => {
        clock += FIRST_DETAIL_MS + 1; // the first cut takes the whole budget of wall time
        return cut(label, canvas);
      };
      const { prepared, runs } = sharpFrame([10, 10]);
      cuts.length = 0;
      expect(await firstDetails(prepared, firstCtx(gpu), 0)).toBe("cut");
      expect(cuts).toEqual(["run0"]);
      expect(runs[1].slot.detail).toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  it("returns stale (prepareFrame then releases the frame) when the job goes stale during the pass", async () => {
    const gpu = device(0);
    let stale = false;
    const cut = gpu.texture;
    gpu.texture = (label, canvas) => {
      stale = true;
      return cut(label, canvas);
    };
    const { prepared } = sharpFrame([10, 10]);
    expect(
      await firstDetails(
        prepared,
        firstCtx(gpu, () => stale),
        0
      )
    ).toBe("stale");
  });

  it("refineCompat's first pass cuts the runs with the most elements first and skips once out of room", async () => {
    const gpu = device(0);
    const { prepared, runs } = sharpFrame([10, 10, 10], [1, 3, 2]);
    cuts.length = 0;
    let room = 1000; // two 400 B details
    const texture = gpu.texture;
    gpu.texture = (label, canvas) => {
      room -= canvas.width * canvas.height * 4;
      return texture(label, canvas);
    };
    await refineCompat(prepared, firstCtx(gpu), visible, pixels, 1 << 30, {
      only: run => run.sharp,
      room: () => room,
      first: true
    });
    // run1 (3 elements), run2 (2), then run0 is skipped (room 200 B is still > 0: downscaled; at 0 it is skipped)
    expect(cuts.slice(0, 2)).toEqual(["run1", "run2"]);
    cuts.length = 0;
    room = 0;
    for (const run of runs) run.slot.detail = null;
    await refineCompat(prepared, firstCtx(gpu), visible, pixels, 1 << 30, { room: () => room, first: true });
    expect(cuts).toEqual([]); // the settle refinement cuts them, not a first pass without room
  });
});
