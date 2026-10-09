import { describe, expect, it } from "vitest";
import { repairInvalidCultures, repairStateCapital } from "./load-repairs";

describe("load repairs (tupaia-mcp)", () => {
  it("resets the cells of an invalid or removed culture to culture 0 and leaves provinces alone", () => {
    const cells = {
      i: Uint16Array.from([0, 1, 2, 3, 4]),
      culture: Uint16Array.from([1, 2, 9, 3, 9]),
      province: Uint16Array.from([5, 5, 6, 6, 7])
    };
    const cultures = [{}, {}, { removed: true }, {}];
    expect(repairInvalidCultures(cells, cultures).sort()).toEqual([2, 9]);
    expect(Array.from(cells.culture)).toEqual([1, 0, 0, 3, 0]);
    expect(Array.from(cells.province)).toEqual([5, 5, 6, 6, 7]);
    expect(repairInvalidCultures(cells, cultures)).toEqual([]);
  });

  it("promotes the first burg of a capital-less state and points state.capital at it", () => {
    const state = { i: 1, capital: 0 };
    const burgs = [{}, { i: 1, state: 2, capital: 1 }, { i: 2, state: 1, capital: 0 }, { i: 3, state: 1, capital: 0 }];
    const regrouped: number[] = [];
    const fix = repairStateCapital(state, burgs, b => regrouped.push(b.i as number));
    expect(fix).toEqual({ state: 1, kind: "none", promoted: 2 });
    expect(burgs[2].capital).toBe(1);
    expect(state.capital).toBe(2);
    expect(regrouped).toEqual([2]);
  });

  it("of several capitals keeps the one state.capital names and demotes the rest", () => {
    const state = { i: 1, capital: 3 };
    const burgs = [{}, { i: 1, state: 1, capital: 1 }, { i: 2, state: 1, capital: 0 }, { i: 3, state: 1, capital: 1 }];
    const fix = repairStateCapital(state, burgs, () => {});
    expect(fix).toEqual({ state: 1, kind: "multiple", kept: 3, demoted: [1] });
    expect(burgs.map(b => (b as { capital?: number }).capital)).toEqual([undefined, 0, 0, 1]);
    expect(state.capital).toBe(3);
    // state.capital naming none of them: the first is kept and state.capital follows
    const s2 = { i: 2, capital: 99 };
    const b2 = [{}, { i: 1, state: 2, capital: 1 }, { i: 2, state: 2, capital: 1 }];
    expect(repairStateCapital(s2, b2, () => {})).toMatchObject({ kept: 1, demoted: [2] });
    expect(s2.capital).toBe(1);
  });

  it("demotes Neutrals' capitals and leaves a consistent state untouched", () => {
    const burgs = [{}, { i: 1, state: 0, capital: 1 }, { i: 2, state: 1, capital: 1 }];
    expect(repairStateCapital({ i: 0 }, burgs, () => {})).toEqual({ state: 0, kind: "neutral", demoted: [1] });
    expect(burgs[1]).toMatchObject({ capital: 0 });
    const ok = { i: 1, capital: 2 };
    expect(repairStateCapital(ok, burgs, () => {})).toBeNull();
    expect(ok.capital).toBe(2);
    expect(repairStateCapital({ i: 3, removed: true }, burgs, () => {})).toBeNull();
  });
});
