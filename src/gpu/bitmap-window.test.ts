import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BitmapWindows, cropPlan } from "./bitmap-window";
import type { GpuDevice, TrackedTexture } from "./device";

const draws: { smoothing: boolean; args: unknown[] }[] = [];

beforeEach(() => {
  draws.length = 0;
  vi.stubGlobal("document", {
    createElement: () => {
      const context = {
        imageSmoothingEnabled: true,
        drawImage(...args: unknown[]) {
          draws.push({ smoothing: context.imageSmoothingEnabled, args });
        }
      };
      return { width: 0, height: 0, getContext: () => context };
    }
  });
});
afterEach(() => vi.unstubAllGlobals());

function fakeDevice(failAt = -1) {
  const live = new Set<TrackedTexture>();
  let calls = 0;
  const device = {
    maxTextureSize: 4096,
    texture: vi.fn((label: string, canvas: { width: number; height: number }) => {
      if (calls++ === failAt) throw new Error("upload failed");
      const { width, height } = canvas;
      const texture = { kind: "texture", label, handle: {}, bytes: width * height * 4, width, height } as TrackedTexture;
      live.add(texture);
      return texture;
    }),
    release: vi.fn((texture: TrackedTexture | null | undefined) => texture && live.delete(texture))
  };
  return { device: device as unknown as GpuDevice, live, raw: device };
}

const image = (w: number, h: number) => ({ naturalWidth: w, naturalHeight: h }) as HTMLImageElement;
const view = { width: 100, height: 100, dpr: 1 };
const at = (x: number, y = 0) => ({ k: 1, x, y });

describe("cropPlan", () => {
  it("floors/ceils to integer source pixels with a one-pixel gutter and remaps the exact world rect", () => {
    // 100x50 px over 200x100 world: 2 world units per pixel
    expect(cropPlan([0, 0, 200, 100], 100, 50, [20, 10, 60, 30])).toEqual({
      sx: 9,
      sy: 4,
      sw: 22,
      sh: 12,
      rect: [18, 8, 44, 24]
    });
  });

  it("clamps to the image edges and returns null when nothing intersects", () => {
    expect(cropPlan([0, 0, 200, 100], 100, 50, [-50, -50, 10, 10])).toEqual({
      sx: 0,
      sy: 0,
      sw: 6,
      sh: 6,
      rect: [0, 0, 12, 12]
    });
    expect(cropPlan([0, 0, 200, 100], 100, 50, [300, 300, 400, 400])).toBeNull();
    expect(cropPlan([0, 0, 0, 100], 100, 50, [0, 0, 10, 10])).toBeNull();
  });
});

describe("BitmapWindows", () => {
  it("copies source pixels 1:1, binds the crop and reports coverage of the unclipped window", async () => {
    const { device } = fakeDevice();
    const windows = new BitmapWindows(device, 10);
    const slot = windows.add(image(1000, 1000), [0, 0, 1000, 1000], 0.5);
    expect(slot).toEqual({ kind: "image", opacity: 0.5, texture: null, rect: [0, 0, 1000, 1000], screen: false, detail: null });
    expect(windows.covers(at(0), view)).toBe(false);

    expect(await windows.refresh(at(0), view)).toBe(true);
    // window [-10, -10, 110, 110] -> source [0, 111)
    expect(draws).toEqual([{ smoothing: false, args: [expect.anything(), 0, 0, 111, 111, 0, 0, 111, 111] }]);
    expect(slot.texture).toMatchObject({ width: 111, height: 111 });
    expect(slot.rect).toEqual([0, 0, 111, 111]);
    expect(windows.bytes).toBe(111 * 111 * 4);
    expect(windows.covers(at(-5), view)).toBe(true);
    expect(windows.covers(at(5), view)).toBe(true); // outside the image is known transparent
    expect(windows.covers(at(-20), view)).toBe(false);
  });

  it("leaves fully clipped images unbound while still committing coverage", async () => {
    const { device, raw } = fakeDevice();
    const windows = new BitmapWindows(device, 10);
    const slot = windows.add(image(10, 10), [500, 500, 10, 10]);
    expect(await windows.refresh(at(0), view)).toBe(true);
    expect(slot.texture).toBeNull();
    expect(raw.texture).not.toHaveBeenCalled();
    expect(windows.covers(at(0), view)).toBe(true);
  });

  it("halves the margin to fit maxBytes and keeps old bindings when even the visible area does not fit", async () => {
    const { device, raw } = fakeDevice();
    const windows = new BitmapWindows(device, 10, 45000); // margin 10 needs 111² * 4, margin 5 needs 106² * 4
    const slot = windows.add(image(1000, 1000), [0, 0, 1000, 1000]);
    expect(await windows.refresh(at(0), view)).toBe(true);
    expect(slot.texture).toMatchObject({ width: 106, height: 106 });
    expect(windows.covers(at(-4), view)).toBe(true);
    expect(windows.covers(at(-7), view)).toBe(false);

    const old = slot.texture;
    expect(await windows.refresh(at(0), { width: 200, height: 200, dpr: 1 })).toBe(false);
    expect(slot.texture).toBe(old);
    expect(raw.texture).toHaveBeenCalledTimes(1);
    expect(raw.release).not.toHaveBeenCalled();
  });

  it("swaps atomically and releases the previous textures only after a successful refresh", async () => {
    const { device, live } = fakeDevice();
    const windows = new BitmapWindows(device, 10);
    const a = windows.add(image(1000, 1000), [0, 0, 1000, 1000]);
    const b = windows.add(image(1000, 1000), [0, 0, 1000, 1000]);
    await windows.refresh(at(0), view);
    const old = [a.texture, b.texture];
    await windows.refresh(at(-300), view);
    expect(a.rect).toEqual([289, 0, 122, 111]);
    expect(old.some(t => live.has(t!))).toBe(false);
    expect(live).toEqual(new Set([a.texture, b.texture]));
  });

  it("releases every new texture when the job turns stale after upload or an upload throws", async () => {
    const stale = fakeDevice();
    const windows = new BitmapWindows(stale.device, 10);
    const slot = windows.add(image(1000, 1000), [0, 0, 1000, 1000]);
    let checks = 0;
    expect(await windows.refresh(at(0), view, () => ++checks > 1)).toBe(false);
    expect(stale.raw.texture).toHaveBeenCalledTimes(1);
    expect(stale.live.size).toBe(0);
    expect(slot.texture).toBeNull();

    const failing = fakeDevice(1);
    const two = new BitmapWindows(failing.device, 10);
    const first = two.add(image(1000, 1000), [0, 0, 1000, 1000]);
    two.add(image(1000, 1000), [0, 0, 1000, 1000]);
    await expect(two.refresh(at(0), view)).rejects.toThrow("upload failed");
    expect(failing.live.size).toBe(0);
    expect(first.texture).toBeNull();
    expect(two.covers(at(0), view)).toBe(false);
  });

  it("lets release/dispose supersede in-flight refreshes, idempotently", async () => {
    const { device, live, raw } = fakeDevice();
    const windows = new BitmapWindows(device, 10);
    const slot = windows.add(image(1000, 1000), [0, 0, 1000, 1000]);
    await windows.refresh(at(0), view);
    const pending = windows.refresh(at(-300), view);
    windows.release();
    expect(await pending).toBe(false);
    expect(slot.texture).toBeNull();
    expect(live.size).toBe(0);
    expect(windows.covers(at(0), view)).toBe(false);

    const newer = windows.refresh(at(0), view);
    const older = windows.refresh(at(-300), view);
    expect(await newer).toBe(false); // superseded by the later call
    expect(await older).toBe(true);
    const inFlight = windows.refresh(at(0), view);
    windows.dispose();
    windows.dispose();
    expect(await inFlight).toBe(false);
    expect(live.size).toBe(0);
    expect(slot.texture).toBeNull();
    expect(windows.bytes).toBe(0);
    expect(raw.texture).toHaveBeenCalledTimes(2);
    expect(await windows.refresh(at(0), view)).toBe(false);
  });

  it("reports the committed margin and edge coverage used for background refresh", async () => {
    const { device } = fakeDevice();
    const windows = new BitmapWindows(device, 10, 45000);
    windows.add(image(1000, 1000), [0, 0, 1000, 1000]);
    expect(windows.size).toBe(1);
    expect(windows.margin).toBe(0);
    await windows.refresh(at(0), view);
    expect(windows.margin).toBe(5); // halved once to fit
    expect(windows.covers(at(0), view, 5)).toBe(true);
    expect(windows.covers(at(-1), view, 5)).toBe(false); // still covered, but inside the edge band
    expect(windows.covers(at(-1), view)).toBe(true);
    windows.release();
    expect(windows.margin).toBe(0);
  });

  it("caps the new crop set by the caller's peak headroom on top of maxBytes", async () => {
    const { device, raw } = fakeDevice();
    const windows = new BitmapWindows(device, 10);
    const slot = windows.add(image(1000, 1000), [0, 0, 1000, 1000]);
    expect(await windows.refresh(at(0), view, undefined, 45000)).toBe(true);
    expect(slot.texture).toMatchObject({ width: 106, height: 106 });
    expect(await windows.refresh(at(0), view, undefined, 1000)).toBe(false);
    expect(raw.texture).toHaveBeenCalledTimes(1);
    expect(windows.covers(at(0), view)).toBe(true); // a rejected refresh keeps the committed window
  });
});

// Mirrors renderer/prepare ownership: each prepared frame owns one manager disposed by its release(); a background
// refresh is cancelled by frame replacement or context loss and never leaks or double-releases.
describe("BitmapWindows lifecycle ownership", () => {
  it("releases each texture exactly once across refresh, frame replacement and context loss", async () => {
    const { device, live, raw } = fakeDevice();
    let current = new BitmapWindows(device, 10);
    current.add(image(1000, 1000), [0, 0, 1000, 1000]);
    expect(await current.refresh(at(0), view)).toBe(true);

    // background edge refresh in flight while a re-prepare replaces the frame
    const frame = current;
    const job = frame.refresh(at(-300), view, () => current !== frame);
    const next = new BitmapWindows(device, 10);
    next.add(image(1000, 1000), [0, 0, 1000, 1000]);
    current = next;
    expect(await next.refresh(at(0), view)).toBe(true);
    frame.dispose();
    expect(await job).toBe(false);
    expect(live.size).toBe(1);

    // context loss: the frame is dropped; a refresh started afterwards on the dead manager allocates nothing
    current.dispose();
    expect(await current.refresh(at(0), view)).toBe(false);
    expect(live.size).toBe(0);
    const released = raw.release.mock.calls.map(([texture]) => texture).filter(Boolean);
    expect(new Set(released).size).toBe(released.length);
    expect(released.length).toBe(raw.texture.mock.results.length);
  });

  it("cancels a refresh whose stale check flips between planning and upload", async () => {
    const { device, live, raw } = fakeDevice();
    const windows = new BitmapWindows(device, 10);
    const slot = windows.add(image(1000, 1000), [0, 0, 1000, 1000]);
    let lost = false;
    const job = windows.refresh(at(0), view, () => lost);
    lost = true; // context lost before the microtask boundary
    expect(await job).toBe(false);
    expect(raw.texture).not.toHaveBeenCalled();
    expect(slot.texture).toBeNull();
    expect(windows.covers(at(0), view)).toBe(false);
    expect(live.size).toBe(0);
  });

  it("a source added after a refresh started supersedes it and leaves coverage uncommitted", async () => {
    const { device, live } = fakeDevice();
    const windows = new BitmapWindows(device, 10);
    windows.add(image(1000, 1000), [0, 0, 1000, 1000]);
    const job = windows.refresh(at(0), view);
    windows.add(image(1000, 1000), [0, 0, 1000, 1000]);
    expect(await job).toBe(false);
    expect(live.size).toBe(0);
    expect(windows.covers(at(0), view)).toBe(false);
  });
});
