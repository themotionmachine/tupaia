import Alea from "alea";
import { describe, expect, it } from "vitest";
import { computeHeightmap, type HeightmapGraph, HeightmapKernel, heightmapInput } from "./heightmap-kernel";

function graph(): HeightmapGraph {
  const cellsX = 30,
    cellsY = 20;
  const points: Array<[number, number]> = [];
  const c: number[][] = [];
  for (let y = 0; y < cellsY; y++)
    for (let x = 0; x < cellsX; x++) {
      const i = y * cellsX + x;
      points.push([x * 10 + 5, y * 10 + 5]);
      c.push(
        [i - 1, i + 1, i - cellsX, i + cellsX].filter(
          j => j >= 0 && j < cellsX * cellsY && Math.abs((j % cellsX) - x) <= 1
        )
      );
    }
  return { cellsDesired: 1000, cellsX, cellsY, spacing: 10, points, cells: { c, h: new Uint8Array(points.length) } };
}
const template =
  "Hill 3 45-70 10-90 10-90\nRange 2 20-30 10-90 10-90\nPit 1 10-15 20-80 20-80\nTrough 1 15-20 10-90 10-90\nStrait 1 vertical\nSmooth 2\nMask 1\nInvert 0.3 xy";

describe("transferable heightmap kernel", () => {
  it("preserves every height and the downstream Alea stream through CSR transport", () => {
    const world = graph();
    const random = Alea("terrain-worker-parity");
    const kernel = new HeightmapKernel();
    kernel.width = 300;
    kernel.height = 200;
    kernel.random = random;
    const expected = kernel.fromTemplateText(world, template);
    const owned = heightmapInput(world, template, 300, 200, "terrain-worker-parity");
    const transferred = structuredClone(owned, {
      transfer: [owned.points.buffer, owned.offsets.buffer, owned.neighbors.buffer, owned.heights!.buffer]
    });
    const result = computeHeightmap(transferred);
    expect(result.heights).toEqual(expected);
    // Golden output captured from the pre-extraction generator, including its remaining Alea stream.
    const checksum = result.heights.reduce((hash, height) => Math.imul(hash ^ height, 16777619), 2166136261) >>> 0;
    expect(checksum.toString(16)).toBe("631654b8");
    expect(result.randomState).toEqual([0.5973521387204528, 0.2752703661099076, 0.9157215168233961, 238114]);
    expect(result.randomState).toEqual(random.exportState());
    const resumed = Alea("terrain-worker-parity");
    resumed.importState(result.randomState);
    expect(resumed()).toBe(random());
    expect(world.cells.h!.byteLength).toBe(600);
    expect(world.cells.h!.every(h => h === 0)).toBe(true);
  });
});
