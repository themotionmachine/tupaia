import { afterEach, describe, expect, it, vi } from "vitest";
import { intersects } from "./heightmap-canvas";

afterEach(() => vi.unstubAllGlobals());
describe("heightmap canvas dirty painting", () => {
  it("includes touching bounds and excludes distant cells", () => {
    expect(intersects([0, 0, 2, 2], [2, 1, 4, 3])).toBe(true);
    expect(intersects([0, 0, 2, 2], [3, 1, 4, 3])).toBe(false);
  });
  it("redraws a local changed cell without repainting distant cells or replacing layers", () => {
    const context = {
      scale: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      clearRect: vi.fn(),
      fillStyle: ""
    };
    const canvas = { isConnected: true, style: {}, width: 0, height: 0, getContext: () => context };
    const group = { replaceChildren: vi.fn() };
    const host = { setAttribute: vi.fn(), appendChild: vi.fn() };
    vi.stubGlobal("document", {
      getElementById: () => group,
      createElementNS: () => host,
      createElement: () => canvas
    });
    vi.stubGlobal("graphWidth", 1000);
    vi.stubGlobal("graphHeight", 1000);
    vi.stubGlobal("grid", {
      points: [
        [1, 1],
        [101, 101],
        [901, 901]
      ],
      cells: { i: [0, 1, 2], h: new Uint8Array([30, 30, 30]) }
    });
    vi.stubGlobal("getGridPolygon", (i: number) => [
      [i * 100, i * 100],
      [i * 100 + 2, i * 100],
      [i * 100 + 2, i * 100 + 2]
    ]);
    let pending: (() => void) | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      pending = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    window.renderHeightmapCanvas(true, () => "red");
    expect(context.fill).toHaveBeenCalledTimes(3);
    context.fill.mockClear();
    window.redrawHeightmapCells([0]);
    window.redrawHeightmapCells([0]);
    pending!();
    expect(context.fill).toHaveBeenCalledTimes(1);
    expect(context.clearRect).toHaveBeenCalledTimes(1);
    expect(group.replaceChildren).toHaveBeenCalledTimes(1);
  });
});
