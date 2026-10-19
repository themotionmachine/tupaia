import { mean } from "d3";
import { rn } from "../utils/numberUtils";
import type { Feature } from "./features";
import type { RiverInput } from "./river-kernel";

export class LakeHydrology {
  readonly input: RiverInput;
  constructor(input: RiverInput) {
    this.input = input;
  }
  cleanupLakeData = () => {
    for (const feature of this.input.world.features) {
      if (feature.type !== "lake") continue;
      delete feature.river;
      delete feature.enteringFlux;
      delete feature.outCell;
      delete feature.closed;
      feature.height = rn(feature.height, 3);

      const inlets = feature.inlets?.filter(r => this.input.world.rivers.find(river => river.i === r));
      if (!inlets?.length) delete feature.inlets;
      else feature.inlets = inlets;

      const outlet = feature.outlet && this.input.world.rivers.find(river => river.i === feature.outlet);
      if (!outlet) delete feature.outlet;
    }
  };

  defineClimateData(heights: number[] | Uint8Array) {
    const { cells, features } = this.input.world;
    const lakeOutCells = new Uint16Array(cells.i.length);

    const getFlux = (lake: Feature) => {
      return lake.shoreline.reduce((acc, c) => acc + this.input.climate.prec[cells.g[c]], 0);
    };

    const getLakeTemp = (lake: Feature) => {
      if (lake.cells < 6) return this.input.climate.temp[cells.g[lake.firstCell]];
      return rn(mean(lake.shoreline.map(c => this.input.climate.temp[cells.g[c]])) as number, 1);
    };

    const getLakeEvaporation = (lake: Feature) => {
      const height = (lake.height - 18) ** this.input.heightExponent; // height in meters
      const evaporation = ((700 * (lake.temp + 0.006 * height)) / 50 + 75) / (80 - lake.temp); // based on Penman formula, [1-11]
      return rn(evaporation * lake.cells);
    };

    const getLowestShoreCell = (lake: Feature) => {
      return lake.shoreline.reduce((minCell, c) => (heights[c] < heights[minCell] ? c : minCell));
    };

    features.forEach(feature => {
      if (feature.type !== "lake") return;
      feature.flux = getFlux(feature);
      feature.temp = getLakeTemp(feature);
      feature.evaporation = getLakeEvaporation(feature);
      if (feature.closed) return; // no outlet for lakes in depressed areas

      feature.outCell = getLowestShoreCell(feature);
      lakeOutCells[feature.outCell as number] = feature.i;
    });

    return lakeOutCells;
  }

  // check if lake can be potentially open (not in deep depression)
  detectCloseLakes(h: number[] | Uint8Array) {
    const { cells } = this.input.world;
    const ELEVATION_LIMIT = this.input.lakeElevationLimit;

    this.input.world.features.forEach(feature => {
      if (feature.type !== "lake") return;
      delete feature.closed;

      const MAX_ELEVATION = feature.height + ELEVATION_LIMIT;
      if (MAX_ELEVATION > 99) {
        feature.closed = false;
        return;
      }

      let isDeep = true;
      const lowestShorelineCell = feature.shoreline.reduce((minCell, c) => (h[c] < h[minCell] ? c : minCell));
      const queue = [lowestShorelineCell];
      const checked = [];
      checked[lowestShorelineCell] = true;

      while (queue.length && isDeep) {
        const cellId: number = queue.pop() as number;

        for (const neibCellId of cells.c[cellId]) {
          if (checked[neibCellId]) continue;
          if (h[neibCellId] >= MAX_ELEVATION) continue;

          if (h[neibCellId] < 20) {
            const nFeature = this.input.world.features[cells.f[neibCellId]];
            if (nFeature.type === "ocean" || feature.height > nFeature.height) isDeep = false;
          }

          checked[neibCellId] = true;
          queue.push(neibCellId);
        }
      }

      feature.closed = isDeep;
    });
  }
}
