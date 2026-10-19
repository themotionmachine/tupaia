// refineCompat keeps a detail cut for the same request only where a full re-refine would allocate the same bytes, so
// the details a frame ends with are the ones a full re-refine gives it, budget pressure included.
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

import { type Prepared, refineCompat } from "./prepare";

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
const request = "0,0,100,100@200x200";

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

// what a frame ends with: per run, the detail's pixel size and drawn density (null: no detail, the base draws)
const outcome = (prepared: Prepared, runs: ReturnType<typeof frame>["runs"]) =>
  runs.map((run, i) =>
    run.slot.detail
      ? {
          size: run.slot.detail.texture && [run.slot.detail.texture.width, run.slot.detail.texture.height],
          density: prepared.compat.detail?.find(entry => entry.id === `run${i}`)?.density
        }
      : null
  );

// scaleCanvas draws into a new canvas: a stand-in that only keeps the size
const fakeCanvas = () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) });
(globalThis.document as unknown as { createElement: unknown }).createElement = fakeCanvas;

async function refine(sizes: number[], budget: number, resolution: number) {
  const gpu = device(0);
  const { prepared, runs } = frame(sizes);
  (prepared.compat as { resolution: number }).resolution = resolution;
  cuts.length = 0;
  clones.count = 0;
  await refineCompat(prepared, ctx(gpu), visible, pixels, budget);
  return { gpu, prepared, runs };
}

describe("refineCompat detail reuse", () => {
  const sizes = [10, 20, 0, 30, 15];
  const total = sizes.reduce((n, size) => n + size * size * 4, 0);

  it("keeps every detail cut for the same request and cuts no clone", async () => {
    const { gpu, prepared, runs } = await refine(sizes, 1 << 30, 1e9);
    const before = outcome(prepared, runs);
    cuts.length = 0;
    clones.count = 0;
    await refineCompat(prepared, ctx(gpu), visible, pixels, 1 << 30);
    expect(outcome(prepared, runs)).toEqual(before);
    expect(cuts).toEqual([]);
    expect(clones.count).toBe(0);
    expect(prepared.compat.refine).toEqual({ kept: 5, rasterized: 0, cloned: false });
  });

  it("drops a detail cut for another request", async () => {
    const gpu = device(0);
    const { prepared, runs } = frame([10]);
    const stale = gpu.texture("detail", { width: 10, height: 10 });
    runs[0].slot.detail = { texture: stale, rect: [0, 0, 1, 1], covers: [0, 0, 50, 50] };
    runs[0].detailMeta = { request: "0,0,50,50@200x200", size: [10, 10], fit: 1 };
    cuts.length = 0;
    await refineCompat(prepared, ctx(gpu), visible, pixels, 1 << 30);
    expect(cuts).toEqual(["run0"]);
    expect(gpu.live.has(stale)).toBe(false);
    expect(runs[0].detailMeta?.request).toBe(request);
  });

  // A first settle under one budget, the details of some runs dropped (dirty runs of a re-prepare), a second settle
  // under another budget: the frame ends exactly as one full refine under the second budget leaves it, holding the
  // same bytes, whether details were full, downscaled (resolution 0) or kept back to the base (resolution 1e9).
  it("ends as a full re-refine does under any budgets", async () => {
    const budgets = [0, 500, 1000, 1700, 2500, 3500, 4600, total, total + 8];
    for (const resolution of [1e9, 0, 0.5])
      for (const first of budgets)
        for (const second of budgets)
          for (let mask = 0; mask < 1 << sizes.length; mask += 3) {
            const fresh = await refine(sizes, second, resolution);
            const twice = await refine(sizes, first, resolution);
            twice.runs.forEach((run, i) => {
              if (mask & (1 << i)) {
                twice.gpu.release(run.slot.detail?.texture);
                run.slot.detail = null;
                run.detailMeta = undefined;
              }
            });
            await refineCompat(twice.prepared, ctx(twice.gpu), visible, pixels, second);
            const label = { resolution, first, second, mask };
            expect({ ...label, details: outcome(twice.prepared, twice.runs) }).toEqual({
              ...label,
              details: outcome(fresh.prepared, fresh.runs)
            });
            expect(twice.gpu.memory().total).toBe(fresh.gpu.memory().total);
          }
  });
});
