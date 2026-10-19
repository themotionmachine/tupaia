import { expect, it, vi } from "vitest";
import { drawReliefCommands } from "./relief-raster-kernel";

it("preserves canonical glyph order and Float64 placement", () => {
  const first = {} as ImageBitmap,
    second = {} as ImageBitmap;
  const context = { setTransform: vi.fn(), drawImage: vi.fn() };
  const x = 1.123456789012345,
    y = 9.87654321098765;
  drawReliefCommands(
    context,
    new Map([
      [2, first],
      [7, second]
    ]),
    new Float64Array([7, x, y, 4, 2, 20, 30, 10]),
    8,
    -10,
    5
  );
  expect(context.setTransform).toHaveBeenCalledWith(8, 0, 0, 8, 80, -40);
  expect(context.drawImage.mock.calls).toEqual([
    [second, x - 2, y - 2, 4, 4],
    [first, 15, 25, 10, 10]
  ]);
});
it("rejects malformed buffers, missing sprites and nonfinite geometry", () => {
  const context = { setTransform: vi.fn(), drawImage: vi.fn() },
    atlas = new Map([[1, {} as ImageBitmap]]);
  for (const commands of [
    new Float64Array([1, 0]),
    new Float64Array([2, 0, 0, 4]),
    new Float64Array([1, Infinity, 0, 4]),
    new Float64Array([1, 0, 0, -1])
  ])
    expect(() => drawReliefCommands(context, atlas, commands, 1, 0, 0)).toThrow();
  expect(context.drawImage).not.toHaveBeenCalled();
});
