import { describe, expect, it } from "vitest";
import { assignMapRecords } from "./lazy-map-records";

describe("lazy map records", () => {
  it("hidden records stay deferred, then parse once and remain mutable", () => {
    const world = { zones: [] as Array<{ i: number; cells: number[] }> };
    assignMapRecords(world, "zones", '[{"i":1,"cells":[3,4]}]', [], true);
    expect(typeof Object.getOwnPropertyDescriptor(world, "zones")?.get).toBe("function");
    const records = world.zones;
    expect(records).toEqual([{ i: 1, cells: [3, 4] }]);
    expect(Object.getOwnPropertyDescriptor(world, "zones")?.get).toBeUndefined();
    expect(world.zones).toBe(records);
    records[0].cells.push(5);
    expect(JSON.parse(JSON.stringify(world))).toEqual({ zones: [{ i: 1, cells: [3, 4, 5] }] });
  });
  it("visible records parse immediately, saving hidden records materializes exact data", () => {
    const world = { ice: [] as Array<{ points: number[][] }> };
    assignMapRecords(world, "ice", '[{"points":[[1.5,2],[3,4]]}]', [], false);
    expect(Object.getOwnPropertyDescriptor(world, "ice")?.get).toBeUndefined();
    assignMapRecords(world, "ice", '[{"points":[[1.5,2],[3,4]]}]', [], true);
    expect(JSON.stringify(world)).toBe('{"ice":[{"points":[[1.5,2],[3,4]]}]}');
  });
  it("regeneration replaces hidden data without parsing obsolete records; missing fields use fallback", () => {
    const world = { zones: [] as number[] };
    assignMapRecords(world, "zones", "invalid old records", [], true);
    world.zones = [1, 2];
    expect(world.zones).toEqual([1, 2]);
    assignMapRecords(world, "zones", "", [], true);
    expect(world.zones).toEqual([]);
  });
});
