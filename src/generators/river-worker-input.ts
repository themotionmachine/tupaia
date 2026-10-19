import type { Feature } from "./features";
import type { River } from "./river-generator";
import { RiverHydrology, type RiverInput } from "./river-kernel";

export interface RiverWorkerInput {
  offsets: Uint32Array;
  neighbors: Uint32Array;
  points: Float64Array;
  indices: Uint32Array;
  borders: Uint8Array;
  heights: Uint8Array;
  terrain: Int8Array;
  featuresByCell: Uint32Array;
  reference: Uint32Array;
  haven: Uint32Array;
  precipitation: Uint8Array;
  temperature: Int8Array;
  features: Feature[];
  cellsDesired: number;
  width: number;
  height: number;
  maxIterations: number;
  lakeElevationLimit: number;
  heightExponent: number;
  allowErosion: boolean;
}
export interface RiverWorkerResult {
  heights: Uint8Array;
  flux: Uint16Array;
  rivers: Uint16Array;
  confluence: Uint16Array;
  records: River[];
  features: Feature[];
  warnings: string[];
}
export function riverWorkerInput(input: RiverInput, allowErosion: boolean): RiverWorkerInput {
  const cells = input.world.cells;
  const offsets = new Uint32Array(cells.c.length + 1);
  const points = new Float64Array(cells.p.length * 2);
  for (let i = 0; i < cells.c.length; i++) {
    offsets[i + 1] = offsets[i] + cells.c[i].length;
    points[i * 2] = cells.p[i][0];
    points[i * 2 + 1] = cells.p[i][1];
  }
  const neighbors = new Uint32Array(offsets[offsets.length - 1]);
  for (let i = 0; i < cells.c.length; i++) neighbors.set(cells.c[i], offsets[i]);
  return {
    offsets,
    neighbors,
    points,
    indices: Uint32Array.from(cells.i),
    borders: Uint8Array.from(cells.b, value => +value),
    heights: Uint8Array.from(cells.h),
    terrain: Int8Array.from(cells.t),
    featuresByCell: Uint32Array.from(cells.f),
    reference: Uint32Array.from(cells.g),
    haven: Uint32Array.from(cells.haven),
    precipitation: Uint8Array.from(input.climate.prec),
    temperature: Int8Array.from(input.climate.temp),
    features: structuredClone(input.world.features),
    cellsDesired: input.cellsDesired,
    width: input.width,
    height: input.height,
    maxIterations: input.maxIterations,
    lakeElevationLimit: input.lakeElevationLimit,
    heightExponent: input.heightExponent,
    allowErosion
  };
}
export function computeRiverWorker(input: RiverWorkerInput): RiverWorkerResult {
  const world: RiverInput["world"] = {
    cells: {
      i: Array.from(input.indices),
      c: Array.from({ length: input.offsets.length - 1 }, (_, i) =>
        Array.from(input.neighbors.subarray(input.offsets[i], input.offsets[i + 1]))
      ),
      p: Array.from({ length: input.points.length / 2 }, (_, i) => [input.points[i * 2], input.points[i * 2 + 1]]),
      b: Array.from(input.borders, value => !!value),
      h: input.heights,
      t: input.terrain,
      f: input.featuresByCell,
      g: Array.from(input.reference),
      haven: input.haven,
      fl: new Uint16Array(0),
      r: new Uint16Array(0),
      conf: new Uint16Array(0)
    },
    features: input.features,
    rivers: []
  };
  const kernel = new RiverHydrology({
    ...input,
    world,
    climate: { prec: input.precipitation, temp: input.temperature }
  });
  kernel.generate(input.allowErosion);
  return {
    heights: world.cells.h,
    flux: world.cells.fl,
    rivers: world.cells.r,
    confluence: world.cells.conf as Uint16Array,
    records: world.rivers,
    features: world.features,
    warnings: kernel.warnings
  };
}
