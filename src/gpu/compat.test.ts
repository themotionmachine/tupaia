import { describe, expect, it, vi } from "vitest";

const { prepareMapClone } = vi.hoisted(() => ({
  prepareMapClone: vi.fn((_type: string, _options?: unknown) => Promise.resolve({} as SVGSVGElement))
}));
vi.mock("../io/export", () => ({ prepareMapClone }));

import {
  compatClone,
  forgetCompatClone,
  LADDER_HEADROOM,
  LADDER_STEPS,
  ladderEstimate,
  ladderFit,
  ladderHint,
  ladderScale,
  ladderStart
} from "./compat";

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

  // A frame that keeps world rasters starts at the previous level unless the room now fits a sharper one, as a full
  // re-prepare (which starts at the base) would find: a tight frame (an open editor) does not pin later frames low.
  it("starts a reusing prepare at the previous level, or higher when the room fits it", () => {
    const bytes = 60 << 20; // previous world rasters, measured at level 4 (half density): 240 MiB at the base
    // the same room that put it there: stays at 4 (no re-cut of the clean runs)
    expect(ladderStart(4, bytes, (64 << 20) / LADDER_HEADROOM)).toBe(4);
    // a room that shrank: the world loop steps down from 4 as before
    expect(ladderStart(4, bytes, 50 << 20)).toBe(4);
    // the editor closed and the room grew back: the base fits, start there
    expect(ladderStart(4, bytes, 240 << 20)).toBe(0);
    // more room but not the base: the ladder fit a full re-prepare would land on
    const room = 150 << 20;
    expect(ladderStart(4, bytes, room)).toBe(ladderFit(240 << 20, room * LADDER_HEADROOM, 0));
    expect(ladderStart(4, bytes, room)).toBeLessThan(4);
    // never below 0, and level 0 stays at 0
    expect(ladderStart(0, bytes, 1 << 30)).toBe(0);
    expect(ladderStart(0, bytes, 1 << 20)).toBe(0);
  });

  // W4b HEIGHT: the hint lands where the loop itself would step down to from level 0, under LADDER_HEADROOM, so the next
  // prepare that keeps those rasters does not step down (and re-cut them all) at the first byte of lost room.
  it("starts a fresh world loop from an earlier frame's bytes where a loop from level 0 would land", () => {
    const bytes = 60 << 20; // measured at level 4: 240 MiB at the base
    // the base fits the room: level 0, as the loop would never step down
    expect(ladderHint(4, bytes, 240 << 20)).toBe(0);
    for (const mib of [50, 100, 150, 200, 239]) {
      const room = mib << 20;
      const level = ladderHint(4, bytes, room);
      // the loop from 0 steps down once, to the ladder fit under the headroom
      expect(level).toBe(ladderFit(240 << 20, room * LADDER_HEADROOM, 0));
      const atLevel = (240 << 20) * ladderScale(level) ** 2;
      expect(atLevel).toBeLessThanOrEqual(room * LADDER_HEADROOM);
      // a reusing prepare whose room shrank by up to the headroom stays at that level
      expect(ladderStart(level, atLevel, room * 0.9)).toBe(level);
      expect(ladderFit(atLevel, room * 0.9, level)).toBe(level);
    }
    // where the hint without headroom sat in the slack: 240·2^(-1/2) ≈ 170 MiB at level 1 fits a 190 MiB room but not
    // 0.85 of it (161.5), so the hint is one rung coarser than the bare estimate
    expect(ladderEstimate(4, bytes, 190 << 20)).toBe(1);
    expect(ladderHint(4, bytes, 190 << 20)).toBe(2);
  });

  it("estimates a fresh world loop's level from an earlier frame's bytes, without headroom (W4 RESUME)", () => {
    const bytes = 60 << 20; // measured at level 4: 240 MiB at the base
    expect(ladderEstimate(4, bytes, 240 << 20)).toBe(0);
    // coarser than the earlier frame when the room shrank, sharper when it grew
    expect(ladderEstimate(4, bytes, 50 << 20)).toBe(ladderFit(240 << 20, 50 << 20, 0));
    expect(ladderEstimate(4, bytes, 50 << 20)).toBeGreaterThan(4);
    expect(ladderEstimate(4, bytes, 150 << 20)).toBeLessThan(4);
    // at most the room, at the sharpest such level
    const level = ladderEstimate(4, bytes, 150 << 20);
    expect((240 << 20) * ladderScale(level) ** 2).toBeLessThanOrEqual(150 << 20);
    expect((240 << 20) * ladderScale(level - 1) ** 2).toBeGreaterThan(150 << 20);
  });
});
