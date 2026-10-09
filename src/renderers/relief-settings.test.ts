import { describe, expect, it } from "vitest";
import { cellRandom, encodeRanges, hashString, parseRanges, readReliefSettings } from "./relief-settings";

const attrs = (values: Record<string, string>) => ({ getAttribute: (name: string) => values[name] ?? null });

describe("relief settings", () => {
  it("encodes and parses id ranges", () => {
    expect(encodeRanges([12, 3, 4, 5, 7, 6, 3])).toBe("3-7,12");
    expect(encodeRanges([])).toBe("");
    expect(parseRanges("3-7,12")).toEqual([3, 4, 5, 6, 7, 12]);
    expect(parseRanges("")).toEqual([]);
  });

  it("reads nothing from a plain #terrain (upstream behaviour)", () => {
    const s = readReliefSettings(attrs({ density: "0.4", set: "simple" }), 100);
    expect(s).toMatchObject({ seed: null, scale: 1, minHeight: 0, exclude: null, nearBurgs: 0 });
    expect(s.biomes.size).toBe(0);
    expect(readReliefSettings(null, 100).scale).toBe(1);
  });

  it("reads the stored settings", () => {
    const s = readReliefSettings(
      attrs({
        "data-seed": "abc",
        "data-scale": "0.5",
        "data-biomes": "6:0,8:1.5,bad",
        "data-min-height": "35",
        "data-exclude": "100:3-5,9",
        "data-near-burgs": "12"
      }),
      100
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
    expect(readReliefSettings(attrs({ "data-exclude": "99:3-5" }), 100).exclude).toBeNull();
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
