import { afterEach, expect, it, vi } from "vitest";
import { createCellPaintOverlay } from "./cell-paint-overlay";

afterEach(() => vi.unstubAllGlobals());
it("paints only dirty cells and restores the pending overlay without rebuilding labels", () => {
  const context = {
    scale: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    clearRect: vi.fn(),
    fillStyle: "",
    strokeStyle: ""
  };
  const canvas = { style: {}, getContext: () => context };
  const host = { setAttribute: vi.fn(), appendChild: vi.fn() };
  const group = { replaceChildren: vi.fn() };
  vi.stubGlobal("document", { createElementNS: () => host, createElement: () => canvas });
  vi.stubGlobal("graphWidth", 100);
  vi.stubGlobal("graphHeight", 100);
  vi.stubGlobal("pack", {
    cells: {
      v: [
        [0, 1, 2],
        [3, 4, 5]
      ]
    },
    vertices: {
      p: [
        [0, 0],
        [1, 0],
        [1, 1],
        [10, 10],
        [11, 10],
        [11, 11]
      ]
    }
  });
  const overlay = createCellPaintOverlay(group as unknown as Element, id => (id === 1 ? "red" : "blue"));
  const changes = new Map([
    [0, 1],
    [1, 2]
  ]);
  overlay.paint(changes, [1]);
  expect(context.fill).toHaveBeenCalledTimes(1);
  expect(context.fillStyle).toBe("blue");
  overlay.reset(new Map([[0, 1]]));
  expect(context.clearRect).toHaveBeenCalledTimes(1);
  expect(context.fill).toHaveBeenCalledTimes(2);
  expect(context.fillStyle).toBe("red");
  expect(group.replaceChildren).toHaveBeenCalledTimes(1);
});
