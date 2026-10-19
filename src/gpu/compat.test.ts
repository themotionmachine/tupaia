import { describe, expect, it, vi } from "vitest";

const { prepareMapClone } = vi.hoisted(() => ({
  prepareMapClone: vi.fn((_type: string, _options?: unknown) => Promise.resolve({} as SVGSVGElement))
}));
vi.mock("../io/export", () => ({ prepareMapClone }));

import { compatClone, forgetCompatClone, LADDER_HEADROOM, LADDER_STEPS, ladderFit, ladderScale } from "./compat";

describe("compat clone", () => {
  // the scene walks the live #viewbox including #debug (editor overlays such as the route editor's #controlPoints);
  // a clone without #debug made every compat element there unresolvable and the renderer fell back to SVG
  it("keeps #debug so editor overlays resolve in the clone", async () => {
    forgetCompatClone();
    await compatClone(1);
    expect(prepareMapClone).toHaveBeenCalledWith("gpu", { debug: true });
  });

  it("reuses the clone within a revision and rebuilds it on the next", async () => {
    forgetCompatClone();
    prepareMapClone.mockClear();
    await compatClone(7);
    await compatClone(7);
    expect(prepareMapClone).toHaveBeenCalledTimes(1);
    await compatClone(8);
    expect(prepareMapClone).toHaveBeenCalledTimes(2);
  });
});

describe("world raster ladder", () => {
  it("halves the linear density every LADDER_STEPS levels", () => {
    expect(ladderScale(0)).toBe(1);
    expect(ladderScale(LADDER_STEPS)).toBe(0.5);
    expect(ladderScale(2 * LADDER_STEPS)).toBe(0.25);
  });

  it("finds the lowest level from the current one at which the bytes fit", () => {
    expect(ladderFit(100, 100, 0)).toBe(0);
    expect(ladderFit(100, 99, 0)).toBe(1);
    expect(ladderFit(100, 25, 0)).toBe(LADDER_STEPS); // a quarter of the bytes: half the density
    // measured at level 3: the levels are relative to it, never above it
    expect(ladderFit(100, 100, 3)).toBe(3);
    expect(ladderFit(100, 50, 3)).toBe(3 + LADDER_STEPS / 2);
  });

  // The point of the ladder: budgets that differ a little give the same level, so a reused raster stays valid. The
  // exact fit (sqrt(room / bytes)) of the old world loop changed with every byte of budget.
  it("lands budgets within the headroom on one level, and a level that fits stays put", () => {
    const bytes = 300 << 20;
    const rooms = [70, 72, 75, 78].map(mib => (mib << 20) * LADDER_HEADROOM);
    const levels = rooms.map(room => ladderFit(bytes, room, 0));
    expect(new Set(levels).size).toBeLessThanOrEqual(2);
    const level = ladderFit(bytes, (75 << 20) * LADDER_HEADROOM, 0);
    const atLevel = bytes * ladderScale(level) ** 2;
    // the next prepare starts at `level` with the same rasters: any room down to the bytes it holds keeps it
    for (const mib of [75, 70, 66]) if (mib << 20 >= atLevel) expect(ladderFit(atLevel, mib << 20, level)).toBe(level);
  });

  it("gives up after 64 levels (the budget check fails the prepare first)", () => {
    expect(ladderFit(1, 0, 0)).toBe(64);
  });
});
