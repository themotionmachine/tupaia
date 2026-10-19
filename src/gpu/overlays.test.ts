import { describe, expect, it } from "vitest";
import type { TrackedTexture } from "./device";
import type { ImageBatch } from "./framegraph";
import { indexOverlays, type OwnedRun, releaseRuns, swapOverlays, uploadAll } from "./overlays";

const texture = (name: string) => ({ name, bytes: 16 }) as unknown as TrackedTexture;
// mirrors GpuDevice.release: null/undefined is a no-op, every real call is recorded
const fakeDevice = () => {
  const released: TrackedTexture[] = [];
  return { released, release: (resource?: TrackedTexture | null) => void (resource && released.push(resource)) };
};
const run = (screen: boolean, own: TrackedTexture | null, detail: TrackedTexture | null = null): OwnedRun => ({
  screen,
  slot: {
    kind: "image",
    texture: own,
    rect: [0, 0, 1, 1],
    screen,
    detail: detail && { texture: detail, rect: [0, 0, 1, 1] }
  } as unknown as ImageBatch
});

describe("compat run texture ownership", () => {
  it("frees screen overlay and detail textures exactly once, leaving world textures to the frame list", () => {
    const device = fakeDevice();
    const [world, overlay, detail] = [texture("world"), texture("overlay"), texture("detail")];
    const runs = [run(false, world, detail), run(true, overlay)];
    releaseRuns(runs, device);
    releaseRuns(runs, device);
    expect(device.released).toEqual([detail, overlay]);
    expect(runs[1].slot.texture).toBeNull();
    expect(runs[0].slot.texture).toBe(world);
  });

  it("swaps an overlay texture, releasing only the replaced one, and frees the new one on later release", () => {
    const device = fakeDevice();
    const [before, after] = [texture("before"), texture("after")];
    const runs = [run(true, before)];
    swapOverlays([{ run: runs[0], texture: after, rect: [2, 3, 4, 5] }], device);
    expect(device.released).toEqual([before]);
    expect(runs[0].slot.texture).toBe(after);
    expect(runs[0].slot.rect).toEqual([2, 3, 4, 5]);
    releaseRuns(runs, device);
    releaseRuns(runs, device);
    expect(device.released).toEqual([before, after]);
  });

  it("keeps the rect for a fully transparent replacement", () => {
    const device = fakeDevice();
    const runs = [run(true, texture("before"))];
    swapOverlays([{ run: runs[0], texture: null, rect: null }], device);
    expect(runs[0].slot.texture).toBeNull();
    expect(runs[0].slot.rect).toEqual([0, 0, 1, 1]);
    releaseRuns(runs, device);
    expect(device.released).toHaveLength(1);
  });

  it("frees partial uploads and leaves slots untouched when an upload fails", () => {
    const device = fakeDevice();
    const [made, old] = [texture("made"), texture("old")];
    const runs = [run(true, old)];
    expect(() =>
      uploadAll(
        ["a", null, "b"],
        item => {
          if (item === "b") throw new Error("context lost");
          return item ? made : null;
        },
        device
      )
    ).toThrow("context lost");
    expect(device.released).toEqual([made]);
    expect(runs[0].slot.texture).toBe(old);
    expect(uploadAll(["a", null], item => (item ? made : null), device)).toEqual([made, null]);
  });
});

describe("screen overlay pick index", () => {
  const box = (x: number, y: number, w: number, h: number) => [x, y, x + w, y, x + w, y + h, x, y + h];

  it("indexes only overlays above the world, in DOM order, in screen px", () => {
    const index = indexOverlays(
      [
        {}, // a world run or an overlay below #viewbox
        { hits: [{ id: "scaleBarBack", fill: { rings: [box(10, 400, 120, 30)], evenOdd: false } }] },
        { hits: [{ id: "scaleBarContent", stroke: { rings: [[20, 410, 110, 410]], closed: [false], halfWidth: 1 } }] }
      ],
      { width: 800, height: 450 }
    );
    expect(index.pick(60, 410)).toMatchObject({ layer: "screen", id: "scaleBarContent" });
    expect(index.pick(60, 420)).toMatchObject({ layer: "screen", id: "scaleBarBack" });
    expect(index.pick(200, 420)).toBeNull();
    expect(indexOverlays([{}], { width: 800, height: 450 }).size).toBe(0);
  });
});
