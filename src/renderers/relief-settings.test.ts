import { describe, expect, it } from "vitest";
import { cellRandom, encodeRanges, gridKey, hashString, parseRanges, readReliefSettings } from "./relief-settings";

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

  it("reads the stored settings", () => {
    const s = readReliefSettings(
      attrs({
        "data-seed": "abc",
        "data-scale": "0.5",
        "data-biomes": "6:0,8:1.5,bad",
        "data-min-height": "35",
        "data-exclude": "100-x:3-5,9",
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
    expect([...(s.exclude ?? [])]).toEqual([3, 4, 5, 9]);
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
});
