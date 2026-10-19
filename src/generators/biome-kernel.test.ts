import { describe, expect, it } from "vitest";
import { biomeId, defineBiomes } from "./biome-kernel";

describe("biome kernel", () => {
  const matrix = Array.from({ length: 5 }, () => new Uint8Array(26).fill(6));
  it("preserves marine, glacier, desert and wetland precedence", () => {
    expect(biomeId(60, -10, 19, false, matrix)).toBe(0);
    expect(biomeId(60, -10, 40, false, matrix)).toBe(11);
    expect(biomeId(7, 25, 30, false, matrix)).toBe(1);
    expect(biomeId(7, 25, 30, true, matrix)).toBe(6);
    expect(biomeId(41, 10, 24, false, matrix)).toBe(12);
  });
  it("averages land neighbor precipitation and adds river flux only to the source cell", () => {
    const result = defineBiomes({
      heights: new Uint8Array([19, 30, 30]),
      rivers: new Uint16Array([0, 1, 0]),
      flux: new Uint16Array([0, 400, 0]),
      neighbors: [[1], [0, 2], [1]],
      reference: [0, 1, 2],
      temperature: [10, 10, 10],
      precipitation: [100, 10, 10],
      matrix
    });
    expect([...result]).toEqual([0, 12, 6]);
  });
});
