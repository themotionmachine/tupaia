import { describe, expect, it } from "vitest";
import {
  cellRandom,
  clearReliefSettings,
  encodeRanges,
  gridKey,
  hashString,
  keepOdds,
  packCellKey,
  parseExclusion,
  parseRanges,
  RELIEF_ATTRS,
  readReliefSettings
} from "./relief-settings";

const attrs = (values: Record<string, string>) => ({ getAttribute: (name: string) => values[name] ?? null });

describe("relief settings", () => {
  it("encodes and parses id ranges", () => {
    expect(encodeRanges([12, 3, 4, 5, 7, 6, 3])).toBe("3-7,12");
    expect(encodeRanges([])).toBe("");
    expect(parseRanges("3-7,12")).toEqual([3, 4, 5, 6, 7, 12]);
    expect(parseRanges("")).toEqual([]);
  });

  it("reads nothing from a plain #terrain (upstream behaviour)", () => {
    const s = readReliefSettings(attrs({ density: "0.4", set: "simple" }), () => "100-x");
    expect(s).toMatchObject({ seed: null, scale: 1, minHeight: 0, exclude: null, nearBurgs: 0 });
    expect(s.biomes.size).toBe(0);
    expect(readReliefSettings(null, () => "100-x").scale).toBe(1);
  });

  it("clamps stored values to the limits the MCP writes (a load draws them without a click)", () => {
    const s = readReliefSettings(
      attrs({
        "data-scale": "100",
        "data-biomes": "6:50,8:-1",
        "data-min-height": "500",
        "data-near-burgs": "1e9"
      }),
      () => "100-x"
    );
    expect(s.scale).toBe(2);
    expect([...s.biomes]).toEqual([
      [6, 2],
      [8, 0]
    ]);
    expect(s.minHeight).toBe(100);
    expect(s.nearBurgs).toBe(10000);
  });

  it("reads the stored settings", () => {
    const s = readReliefSettings(
      attrs({
        "data-seed": "abc",
        "data-scale": "0.5",
        "data-biomes": "6:0,8:1.5,bad",
        "data-min-height": "35",
        "data-exclude": "100-x:3-5,9;12.12,12.40,bad",
        "data-near-burgs": "12"
      }),
      () => "100-x"
    );
    expect(s.seed).toBe("abc");
    expect(s.scale).toBe(0.5);
    expect([...s.biomes]).toEqual([
      [6, 0],
      [8, 1.5]
    ]);
    expect(s.minHeight).toBe(35);
    expect([...(s.exclude?.cells ?? [])]).toEqual([3, 4, 5, 9]);
    expect([...(s.exclude?.parts ?? [])]).toEqual(["12.12", "12.40"]);
    expect([...(s.exclude?.partGrids ?? [])]).toEqual([12]);
    expect(s.nearBurgs).toBe(12);
  });

  it("ignores an exclusion recorded on another grid", () => {
    expect(readReliefSettings(attrs({ "data-exclude": "100-y:3-5" }), () => "100-x").exclude).toBeNull();
    const a: [number, number][] = [
      [1.5, 2.25],
      [10, 20]
    ];
    expect(gridKey(a)).toBe(gridKey(a.map(p => [p[0], p[1]] as [number, number])));
    expect(gridKey(a)).toMatch(/^2-[0-9a-z]+$/);
    expect(gridKey([a[0], [10, 20.01]])).not.toBe(gridKey(a));
  });

  it("gives each cell position its own repeatable stream", () => {
    const seed = hashString("683028576");
    const take = (rng: () => number) => Array.from({ length: 5 }, rng);
    const a = take(cellRandom(seed, 10.25, 40.5));
    expect(take(cellRandom(seed, 10.25, 40.5))).toEqual(a);
    expect(take(cellRandom(seed, 10.26, 40.5))).not.toEqual(a);
    expect(take(cellRandom(hashString("other"), 10.25, 40.5))).not.toEqual(a);
    for (const v of a) expect(v >= 0 && v < 1).toBe(true);
  });

  it("names a pack cell by its grid cell and, on the coast, the neighbour it sits towards", () => {
    const points: [number, number][] = [
      [10, 10],
      [20, 10],
      [10, 20]
    ];
    const neighbours = [[1, 2], [0], [0]];
    expect(packCellKey(0, 10, 10, points, neighbours)).toBe("0.0");
    expect(packCellKey(0, 15, 10, points, neighbours)).toBe("0.1"); // reGraph midpoint, rounded to 0.1
    expect(packCellKey(0, 10, 15.04, points, neighbours)).toBe("0.2");
    expect(packCellKey(0, 13, 13, points, neighbours)).toBe("0.?");
    expect(parseExclusion("1-2").cells.size).toBe(2);
    expect(parseExclusion("").parts.size).toBe(0);
  });

  it("thins below a multiplier of 1 with no floor of one icon per cell", () => {
    expect(keepOdds(1, 10, 5)).toBe(1);
    expect(keepOdds(1.5, 1, 50)).toBe(1);
    expect(keepOdds(0.5, 1000, 2)).toBe(1); // room for many icons: the sampler thins
    expect(keepOdds(0.5, 10, 50)).toBe(0.25); // one icon at most: keep it with odds k^2
    expect(keepOdds(0.1, 10, 50)).toBeCloseTo(0.01);
    expect(keepOdds(0.5, 2000, 50)).toBeCloseTo(0.392); // between: the expected count at this spacing
    expect(keepOdds(0.2, 10, 50)).toBeCloseTo(0.04);
  });

  it("clears every relief attribute", () => {
    const removed: string[] = [];
    clearReliefSettings({ removeAttribute: (name: string) => removed.push(name) } as unknown as Element);
    expect(removed).toEqual([...RELIEF_ATTRS]);
    expect(globalThis.ReliefSettings.attrs).toBe(RELIEF_ATTRS);
  });
});
