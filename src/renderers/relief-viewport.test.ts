import { afterEach, expect, it, vi } from "vitest";
import { createReliefViewport } from "./relief-viewport";

const atlas = vi.hoisted(() => new Map<string, unknown>());
const loading = vi.hoisted(() => ({ decoded: true, load: () => Promise.resolve({}) }));
vi.mock("./relief-canvas", () => ({
  peekReliefRasterSprite: (id: string) => atlas.get(id),
  peekReliefSprite: () => (loading.decoded ? {} : undefined),
  loadReliefSprite: () => loading.load()
}));
afterEach(() => {
  atlas.clear();
  loading.decoded = true;
  loading.load = () => Promise.resolve({});
  vi.unstubAllGlobals();
});
function setup(onChange: () => void = () => {}) {
  const context = { setTransform: vi.fn(), drawImage: vi.fn() };
  const callbacks: ((blob: Blob | null) => void)[] = [];
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    getContext: () => context,
    toBlob: (callback: (blob: Blob | null) => void) => callbacks.push(callback)
  };
  const attrs = new Map<string, string>();
  const frame = { remove: vi.fn(), setAttribute: (key: string, value: string) => attrs.set(key, value) };
  const overlay = { replaceChildren: vi.fn() };
  const decoded: { onload: (() => void) | null; onerror: (() => void) | null; src: string }[] = [];
  vi.stubGlobal("document", { createElement: () => canvas, createElementNS: () => frame });
  vi.stubGlobal("window", { devicePixelRatio: 2 });
  vi.stubGlobal(
    "Image",
    class {
      onload = null;
      onerror = null;
      src = "";
      constructor() {
        decoded.push(this);
      }
    }
  );
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:sprite"), revokeObjectURL: vi.fn() });
  return {
    context,
    canvas,
    attrs,
    frame,
    overlay,
    callbacks,
    decoded,
    raster: createReliefViewport(overlay as unknown as SVGGElement, onChange)!
  };
}
it("paints in canonical order at exact positions and installs only after async decode", () => {
  const one = {},
    two = {};
  atlas.set("#one", one);
  atlas.set("#two", two);
  const { raster, canvas, context, attrs, callbacks, decoded, overlay } = setup();
  expect(
    raster.paint(
      [
        { x: 12, y: 25, radius: 4, sourceId: "#one" },
        { x: 30, y: 40, radius: 10, sourceId: "#two" }
      ],
      [10, 20, 810, 420],
      8
    )
  ).toBe(false);
  expect(raster.pending).toBe(true);
  expect(overlay.replaceChildren).not.toHaveBeenCalled();
  expect(canvas.width).toBeLessThanOrEqual(4096);
  expect(canvas.height).toBeLessThanOrEqual(4096);
  expect(context.drawImage.mock.calls).toEqual([
    [one, 10, 23, 4, 4],
    [two, 25, 35, 10, 10]
  ]);
  callbacks[0](new Blob());
  decoded[0].onload!();
  expect(raster.ready).toBe(true);
  expect(raster.pending).toBe(false);
  expect(attrs.get("x")).toBe("10");
  expect(attrs.get("y")).toBe("20");
  raster.dispose();
  expect(canvas.width).toBe(0);
  expect(canvas.height).toBe(0);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:sprite");
});
it("retains vector fallback until all required sprites are decoded", () => {
  atlas.set("#one", {});
  const { raster, context, callbacks } = setup();
  expect(
    raster.paint(
      [
        { x: 0, y: 0, radius: 4, sourceId: "#one" },
        { x: 8, y: 8, radius: 4, sourceId: "#missing" }
      ],
      [0, 0, 20, 20],
      8
    )
  ).toBe(false);
  expect(context.drawImage).not.toHaveBeenCalled();
  expect(callbacks).toHaveLength(0);
});
it("discards detached renders and coalesces pending changes into the latest viewport", () => {
  atlas.set("#one", {});
  const { raster, callbacks, decoded, overlay, attrs } = setup();
  const glyphs = [{ x: 8, y: 8, radius: 4, sourceId: "#one" }];
  raster.paint(glyphs, [0, 0, 20, 20], 8);
  raster.paint(glyphs, [1, 1, 21, 21], 8);
  raster.paint(glyphs, [2, 2, 22, 22], 8);
  expect(callbacks).toHaveLength(1);
  callbacks[0](new Blob());
  decoded[0].onload!();
  expect(callbacks).toHaveLength(2);
  callbacks[1](new Blob());
  decoded[1].onload!();
  expect(attrs.get("x")).toBe("2");
  expect(attrs.get("y")).toBe("2");
  raster.paint(glyphs, [3, 3, 23, 23], 8);
  raster.dispose();
  callbacks[2](new Blob());
  expect(overlay.replaceChildren).toHaveBeenCalledTimes(2);
  expect(raster.ready).toBe(false);
});

it("requests a same-camera repaint after initially undecoded sprites become ready", async () => {
  loading.decoded = false;
  let complete!: (value: object) => void;
  loading.load = () =>
    new Promise(resolve => {
      complete = resolve;
    });
  const changed = vi.fn();
  const { raster, callbacks, decoded, overlay } = setup(changed);
  const glyphs = [{ x: 8, y: 8, radius: 4, sourceId: "#late" }];
  const bounds: [number, number, number, number] = [0, 0, 20, 20];
  expect(raster.paint(glyphs, bounds, 8)).toBe(false);
  expect(raster.pending).toBe(true);
  expect(callbacks).toHaveLength(0);
  loading.decoded = true;
  atlas.set("#late", {});
  complete({});
  await Promise.resolve();
  await Promise.resolve();
  expect(changed).toHaveBeenCalledTimes(1);
  expect(raster.pending).toBe(false);
  expect(raster.paint(glyphs, bounds, 8)).toBe(false);
  callbacks[0](new Blob());
  decoded[0].onload!();
  expect(raster.ready).toBe(true);
  expect(overlay.replaceChildren).toHaveBeenCalledTimes(1);
});

it("revokes pending decoded-image URLs immediately when its world is disposed", () => {
  atlas.set("#one", {});
  const { raster, callbacks, decoded, overlay } = setup();
  raster.paint([{ x: 8, y: 8, radius: 4, sourceId: "#one" }], [0, 0, 20, 20], 8);
  callbacks[0](new Blob());
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  raster.dispose();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:sprite");
  decoded[0].onload!();
  expect(overlay.replaceChildren).not.toHaveBeenCalled();
  expect(raster.ready).toBe(false);
});
