import { describe, expect, it } from "vitest";
import type { Feature } from "./features";
import { RiverHydrology, type RiverInput } from "./river-kernel";
import { computeRiverWorker, riverWorkerInput } from "./river-worker-input";

function input(): RiverInput {
  const feature = (i: number, type: Feature["type"]): Feature => ({
    i,
    type,
    land: type === "island",
    border: false,
    cells: 4,
    firstCell: 0,
    vertices: [],
    area: 100,
    shoreline: [],
    height: 0,
    group: "",
    temp: 10,
    flux: 0,
    evaporation: 0,
    name: ""
  });
  return {
    world: {
      cells: {
        i: [0, 1, 2, 3],
        c: [[1], [0, 2], [1, 3], [2]],
        p: [
          [0, 0],
          [10, 0],
          [20, 0],
          [30, 0]
        ],
        b: [false, false, false, true],
        h: new Uint8Array([80, 60, 40, 10]),
        t: new Int8Array([1, 1, 1, -1]),
        f: new Uint16Array([1, 1, 1, 0]),
        g: [0, 1, 2, 3],
        haven: new Uint16Array([0, 0, 3, 0]),
        fl: new Uint16Array(4),
        r: new Uint16Array(4),
        conf: new Uint16Array(4)
      },
      features: [feature(0, "ocean"), feature(1, "island")],
      rivers: []
    },
    climate: { prec: new Uint8Array([100, 100, 100, 0]), temp: new Int8Array([10, 10, 10, 10]) },
    cellsDesired: 10000,
    width: 40,
    height: 20,
    maxIterations: 100,
    lakeElevationLimit: 20,
    heightExponent: 1.8
  };
}
describe("river hydrology kernel", () => {
  it("drains precipitation downhill and preserves deterministic river geometry through transport", () => {
    const live = input();
    const sync = structuredClone(live);
    new RiverHydrology(sync).generate(true);
    const payload = riverWorkerInput(live, true);
    const result = computeRiverWorker(payload);
    expect(Array.from(result.flux)).toEqual([100, 200, 300, 0]);
    expect(result.flux).toEqual(sync.world.cells.fl);
    expect(result.rivers).toEqual(sync.world.cells.r);
    expect(result.confluence).toEqual(sync.world.cells.conf);
    expect(result.heights).toEqual(sync.world.cells.h);
    expect(result.records).toEqual(sync.world.rivers);
    expect(Array.from(live.world.cells.h)).toEqual([80, 60, 40, 10]);
    expect(live.world.rivers).toEqual([]);
  });
  it("retains cell and feature indices above 65535 in worker transport", () => {
    const live = input();
    live.world.cells.haven = new Uint32Array([70000, 0, 0, 0]);
    live.world.cells.f = new Uint32Array([70001, 1, 1, 0]);
    const payload = riverWorkerInput(live, false);
    expect(payload.haven[0]).toBe(70000);
    expect(payload.featuresByCell[0]).toBe(70001);
  });
  it("keeps live heights untouched when erosion is disabled", () => {
    const live = input();
    const result = computeRiverWorker(riverWorkerInput(live, false));
    expect(result.heights).toEqual(live.world.cells.h);
    expect(result.records).toHaveLength(1);
  });
});
