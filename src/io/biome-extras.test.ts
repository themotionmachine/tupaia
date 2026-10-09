import { describe, expect, it } from "vitest";
import { applyBiomeExtras, type BiomeExtras, serializeBiomeExtras } from "./biome-extras";

const defaults = (n: number): BiomeExtras => ({
  iconsDensity: Array.from({ length: n }, () => 0),
  icons: Array.from({ length: n }, () => []),
  cost: Array.from({ length: n }, () => 50)
});

describe("biome extras (4th field of the .map biome line)", () => {
  it("round-trips icon density, icons and cost through the biome line", () => {
    const saved: BiomeExtras = {
      iconsDensity: [0, 3, 77],
      icons: [[], ["dune", "dune", "cactus"], ["swamp"]],
      cost: [10, 200, 140]
    };
    const line = ["#a,#b,#c", "0,4,12", "Marine,Hot desert,Glass desert", serializeBiomeExtras(saved)].join("|");
    const fields = line.split("|");
    const target = defaults(3);
    expect(applyBiomeExtras(target, fields, 3)).toBe(3);
    expect(target).toEqual(saved);
    // the first three fields are what an older client reads: unchanged
    expect(fields.slice(0, 3)).toEqual(["#a,#b,#c", "0,4,12", "Marine,Hot desert,Glass desert"]);
  });

  it("keeps today's values for an older file without the field", () => {
    const target = defaults(2);
    expect(applyBiomeExtras(target, ["#a,#b", "0,4", "Marine,Hot desert"], 2)).toBe(0);
    expect(target).toEqual(defaults(2));
  });

  it("ignores malformed JSON and malformed entries, and indexes past count", () => {
    const target = defaults(2);
    expect(applyBiomeExtras(target, ["a", "b", "c", "{not json"], 2)).toBe(0);
    expect(target).toEqual(defaults(2));
    const raw = JSON.stringify({ iconsDensity: ["x", 5, 9], icons: [[1], null, ["a"]], cost: [null, 70, 80] });
    expect(applyBiomeExtras(target, ["a", "b", "c", raw], 2)).toBe(1);
    expect(target).toEqual({ iconsDensity: [0, 5], icons: [[], []], cost: [50, 70] });
  });

  it("survives a '|' inside the JSON, but takes only plain icon names", () => {
    const saved: BiomeExtras = { iconsDensity: [1], icons: [["a|b"]], cost: [2] };
    const fields = ["#a", "0", "Marine", serializeBiomeExtras(saved)].join("|").split("|");
    const target = defaults(1);
    applyBiomeExtras(target, fields, 1);
    // the JSON is read whole; the icon name with '|' is not a plain name, so the icons stay
    expect(target).toEqual({ iconsDensity: [1], icons: [[]], cost: [2] });
  });

  it("refuses icon names that would inject markup", () => {
    const evil = 'x"/><image href="data:," onerror="alert(1)"/><use href="';
    const raw = JSON.stringify({ iconsDensity: [3, 4], icons: [[evil], ["dune", "mountSnow"]], cost: [1, 2] });
    const target = defaults(2);
    expect(applyBiomeExtras(target, ["a", "b", "c", raw], 2)).toBe(2);
    expect(target.icons).toEqual([[], ["dune", "mountSnow"]]);
  });
});
