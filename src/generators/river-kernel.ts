// Numeric river and lake hydrology. No DOM, renderer or application globals.
import { mean, min, sum } from "d3";
import { rn } from "../utils/numberUtils";
import { meander } from "../utils/pathUtils";
import type { Feature } from "./features";
import type { River } from "./river-generator";
import { LakeHydrology } from "./river-lake-kernel";
import type { Point } from "./voronoi";

export interface RiverWorld {
  cells: {
    i: number[];
    c: number[][];
    p: Point[];
    b: boolean[];
    h: Uint8Array;
    t: Int8Array;
    f: Uint16Array | Uint32Array;
    g: number[];
    haven: Uint16Array | Uint32Array;
    fl: Uint16Array;
    r: Uint16Array;
    conf: Uint8Array | Uint16Array;
  };
  features: Feature[];
  rivers: River[];
}
export interface RiverInput {
  world: RiverWorld;
  climate: { prec: Uint8Array; temp: Int8Array };
  cellsDesired: number;
  width: number;
  height: number;
  maxIterations: number;
  lakeElevationLimit: number;
  heightExponent: number;
}
export class RiverHydrology {
  readonly input: RiverInput;
  readonly lakes: LakeHydrology;
  readonly warnings: string[] = [];
  private FLUX_FACTOR = 500;
  private MAX_FLUX_WIDTH = 1;
  private LENGTH_FACTOR = 200;
  private LENGTH_STEP_WIDTH = 1 / this.LENGTH_FACTOR;
  private LENGTH_PROGRESSION = [1, 1, 2, 3, 5, 8, 13, 21, 34].map(n => n / this.LENGTH_FACTOR);
  constructor(input: RiverInput) {
    this.input = input;
    this.lakes = new LakeHydrology(input);
  }
  generate(allowErosion = true) {
    const { cells, features } = this.input.world;

    const riversData: { [riverId: number]: number[] } = {};
    const riverParents: { [key: number]: number } = {};

    const addCellToRiver = (cellId: number, riverId: number) => {
      if (!riversData[riverId]) riversData[riverId] = [cellId];
      else riversData[riverId].push(cellId);
    };

    const drainWater = () => {
      const MIN_FLUX_TO_FORM_RIVER = 30;
      const cellsNumberModifier = (this.input.cellsDesired / 10000) ** 0.25;

      const prec = this.input.climate.prec;
      const land = cells.i.filter((i: number) => h[i] >= 20).sort((a: number, b: number) => h[b] - h[a]);
      const lakeOutCells = this.lakes.defineClimateData(h);

      for (const i of land) {
        cells.fl[i] += prec[cells.g[i]] / cellsNumberModifier; // add flux from precipitation

        // create lake outlet if lake is not in deep depression and flux > evaporation
        const lakes = lakeOutCells[i]
          ? features.filter((feature: any) => i === feature.outCell && feature.flux > feature.evaporation)
          : [];
        for (const lake of lakes) {
          const lakeCell = cells.c[i].find((c: number) => h[c] < 20 && cells.f[c] === lake.i)!;
          cells.fl[lakeCell] += Math.max(lake.flux - lake.evaporation, 0); // not evaporated lake water drains to outlet

          // allow chain lakes to retain identity
          if (cells.r[lakeCell] !== lake.river) {
            const sameRiver = cells.c[lakeCell].some((c: number) => cells.r[c] === lake.river);

            if (sameRiver) {
              cells.r[lakeCell] = lake.river as number;
              addCellToRiver(lakeCell, lake.river as number);
            } else {
              cells.r[lakeCell] = riverNext;
              addCellToRiver(lakeCell, riverNext);
              riverNext++;
            }
          }

          lake.outlet = cells.r[lakeCell];
          flowDown(i, cells.fl[lakeCell], lake.outlet);
        }

        // assign all tributary rivers to outlet basin
        const outlet = lakes[0]?.outlet;
        for (const lake of lakes) {
          if (!Array.isArray(lake.inlets)) continue;
          for (const inlet of lake.inlets) {
            riverParents[inlet] = outlet as number;
          }
        }

        // near-border cell: pour water out of the screen
        if (cells.b[i] && cells.r[i]) {
          addCellToRiver(-1, cells.r[i]);
          continue;
        }

        // downhill cell (make sure it's not in the source lake)
        let min = null;
        if (lakeOutCells[i]) {
          const filtered = cells.c[i].filter((c: number) => !lakes.map((lake: any) => lake.i).includes(cells.f[c]));
          min = filtered.sort((a: number, b: number) => h[a] - h[b])[0];
        } else if (cells.haven[i]) {
          min = cells.haven[i];
        } else {
          min = cells.c[i].reduce((minCell, c) => (h[c] < h[minCell] ? c : minCell));
        }

        // cells is depressed
        if (h[i] <= h[min]) continue;

        // debug
        //   .append("line")
        //   .attr("x1", this.input.world.cells.p[i][0])
        //   .attr("y1", this.input.world.cells.p[i][1])
        //   .attr("x2", this.input.world.cells.p[min][0])
        //   .attr("y2", this.input.world.cells.p[min][1])
        //   .attr("stroke", "#333")
        //   .attr("stroke-width", 0.2);

        if (cells.fl[i] < MIN_FLUX_TO_FORM_RIVER) {
          // flux is too small to operate as a river
          if (h[min] >= 20) cells.fl[min] += cells.fl[i];
          continue;
        }

        // proclaim a new river
        if (!cells.r[i]) {
          cells.r[i] = riverNext;
          addCellToRiver(i, riverNext);
          riverNext++;
        }

        flowDown(min, cells.fl[i], cells.r[i]);
      }
    };

    const flowDown = (toCell: number, fromFlux: number, river: number) => {
      const toFlux = cells.fl[toCell] - cells.conf[toCell];
      const toRiver = cells.r[toCell];

      if (toRiver) {
        // downhill cell already has river assigned
        if (fromFlux > toFlux) {
          cells.conf[toCell] += cells.fl[toCell]; // mark confluence
          if (h[toCell] >= 20) riverParents[toRiver] = river; // min river is a tributary of current river
          cells.r[toCell] = river; // re-assign river if downhill part has less flux
        } else {
          cells.conf[toCell] += fromFlux; // mark confluence
          if (h[toCell] >= 20) riverParents[river] = toRiver; // current river is a tributary of min river
        }
      } else cells.r[toCell] = river; // assign the river to the downhill cell

      if (h[toCell] < 20) {
        // pour water to the water body
        const waterBody = features[cells.f[toCell]];
        if (waterBody.type === "lake") {
          if (!waterBody.river || fromFlux > (waterBody.enteringFlux as number)) {
            waterBody.river = river;
            waterBody.enteringFlux = fromFlux;
          }
          waterBody.flux = waterBody.flux + fromFlux;
          if (!waterBody.inlets) waterBody.inlets = [river];
          else waterBody.inlets.push(river);
        }
      } else {
        // propagate flux and add next river segment
        cells.fl[toCell] += fromFlux;
      }

      addCellToRiver(toCell, river);
    };

    const defineRivers = () => {
      // re-initialize rivers and confluence arrays
      cells.r = new Uint16Array(cells.i.length);
      cells.conf = new Uint16Array(cells.i.length);
      this.input.world.rivers = [];

      const defaultWidthFactor = rn(1 / (this.input.cellsDesired / 10000) ** 0.25, 2);
      const mainStemWidthFactor = defaultWidthFactor * 1.2;

      for (const key in riversData) {
        const riverCells = riversData[key];
        if (riverCells.length < 3) continue; // exclude tiny rivers

        const riverId = +key;
        for (const cell of riverCells) {
          if (cell < 0 || cells.h[cell] < 20) continue;

          // mark real confluences and assign river to cells
          if (cells.r[cell]) cells.conf[cell] = 1;
          else cells.r[cell] = riverId;
        }

        const source = riverCells[0];
        const mouth = riverCells[riverCells.length - 2];
        const parent = riverParents[key] || 0;

        const widthFactor = !parent || parent === riverId ? mainStemWidthFactor : defaultWidthFactor;
        const meanderedPoints = this.addMeandering(riverCells);
        const discharge = cells.fl[mouth]; // m3 in second
        const length = this.getApproximateLength(meanderedPoints.map(([x, y]) => [x, y]));
        const sourceWidth = this.getSourceWidth(cells.fl[source]);
        const width = this.getWidth(
          this.getOffset({
            flux: discharge,
            pointIndex: meanderedPoints.length,
            widthFactor,
            startingWidth: sourceWidth
          })
        );

        this.input.world.rivers.push({
          i: riverId,
          source,
          mouth,
          discharge,
          length,
          width,
          widthFactor,
          sourceWidth,
          parent,
          cells: riverCells
        } as River);
      }
    };

    const downcutRivers = () => {
      const MAX_DOWNCUT = 5;

      for (const i of this.input.world.cells.i) {
        if (cells.h[i] < 35) continue; // don't donwcut lowlands
        if (!cells.fl[i]) continue;

        const higherCells = cells.c[i].filter((c: number) => cells.h[c] > cells.h[i]);
        const higherFlux = higherCells.reduce((acc: number, c: number) => acc + cells.fl[c], 0) / higherCells.length;
        if (!higherFlux) continue;

        const downcut = Math.floor(cells.fl[i] / higherFlux);
        if (downcut) cells.h[i] -= Math.min(downcut, MAX_DOWNCUT);
      }
    };

    const calculateConfluenceFlux = () => {
      for (const i of cells.i) {
        if (!cells.conf[i]) continue;

        const sortedInflux = cells.c[i]
          .filter((c: number) => cells.r[c] && h[c] > h[i])
          .map((c: number) => cells.fl[c])
          .sort((a: number, b: number) => b - a);
        cells.conf[i] = sortedInflux.reduce(
          (acc: number, flux: number, index: number) => (index ? acc + flux : acc),
          0
        );
      }
    };

    cells.fl = new Uint16Array(cells.i.length); // water flux array
    cells.r = new Uint16Array(cells.i.length); // rivers array
    cells.conf = new Uint8Array(cells.i.length); // confluences array
    let riverNext = 1; // first river id is 1

    const h = this.alterHeights();
    this.lakes.detectCloseLakes(h);
    this.resolveDepressions(h);
    drainWater();
    defineRivers();

    calculateConfluenceFlux();
    this.lakes.cleanupLakeData();

    if (allowErosion) {
      cells.h = Uint8Array.from(h); // apply gradient
      downcutRivers(); // downcut river beds
    }
  }

  alterHeights(): number[] {
    const { h, c, t } = this.input.world.cells as {
      h: Uint8Array;
      c: number[][];
      t: Int8Array;
    };
    return Array.from(h).map((h, i) => {
      if (h < 20 || t[i] < 1) return h;
      return h + t[i] / 100 + (mean(c[i].map(c => t[c])) as number) / 10000;
    });
  }

  // depression filling algorithm (for a correct water flux modeling)
  resolveDepressions(h: number[]) {
    const { cells, features } = this.input.world;
    const maxIterations = this.input.maxIterations;
    const checkLakeMaxIteration = maxIterations * 0.85;
    const elevateLakeMaxIteration = maxIterations * 0.75;

    const height = (i: number) => features[cells.f[i]].height || h[i]; // height of lake or specific cell

    const lakes = features.filter(feature => feature.type === "lake");
    const land = cells.i.filter((i: number) => h[i] >= 20 && !cells.b[i]); // exclude near-border cells
    land.sort((a: number, b: number) => h[a] - h[b]); // lowest cells go first

    const progress = [];
    let depressions = Infinity;
    let prevDepressions = null;
    for (let iteration = 0; depressions && iteration < maxIterations; iteration++) {
      if (progress.length > 5 && sum(progress) > 0) {
        // bad progress, abort and set heights back
        h = this.alterHeights();
        depressions = progress[0];
        break;
      }

      depressions = 0;

      if (iteration < checkLakeMaxIteration) {
        for (const l of lakes) {
          if (l.closed) continue;
          const minHeight = min(l.shoreline.map((s: number) => h[s])) as number;
          if (minHeight >= 100 || l.height > minHeight) continue;

          if (iteration > elevateLakeMaxIteration) {
            l.shoreline.forEach((i: number) => {
              h[i] = cells.h[i];
            });
            l.height = (min(l.shoreline.map((s: number) => h[s])) as number) - 1;
            l.closed = true;
            continue;
          }

          depressions++;
          l.height = (minHeight as number) + 0.2;
        }
      }

      for (const i of land) {
        const minHeight = min(cells.c[i].map((c: number) => height(c))) as number;
        if (minHeight >= 100 || h[i] > minHeight) continue;

        depressions++;
        h[i] = minHeight + 0.1;
      }

      prevDepressions !== null && progress.push(depressions - prevDepressions);
      prevDepressions = depressions;
    }

    if (depressions) this.warnings.push(`Unresolved depressions: ${depressions}. Edit heightmap to fix`);
  }

  addMeandering(riverCells: number[], riverPoints: Point[] | null = null): [number, number, number][] {
    const { fl, h, p } = this.input.world.cells;
    const { points, anchorIndices } = meander(riverCells, p, {
      anchors: riverPoints ?? undefined,
      meandering: 0.5,
      startStep: h[riverCells[0]] < 20 ? 1 : 10,
      isWaterCell: riverCells.map(c => c !== -1 && h[c] < 20),
      bounds: { width: this.input.width, height: this.input.height }
    });

    const flux: number[] = new Array(points.length).fill(0);
    anchorIndices.forEach((pointIndex, anchorIndex) => {
      const cellId = riverCells[anchorIndex];
      const fluxCell = cellId === -1 ? riverCells[anchorIndex - 1] : cellId;
      flux[pointIndex] = fl[fluxCell] || 0;
    });

    return points.map(([x, y], idx) => [x, y, flux[idx]]);
  }

  getOffset({
    flux,
    pointIndex,
    widthFactor,
    startingWidth
  }: {
    flux: number;
    pointIndex: number;
    widthFactor: number;
    startingWidth: number;
  }) {
    if (pointIndex === 0) return startingWidth;

    const fluxWidth = Math.min(flux ** 0.7 / this.FLUX_FACTOR, this.MAX_FLUX_WIDTH);
    const lengthWidth =
      pointIndex * this.LENGTH_STEP_WIDTH +
      (this.LENGTH_PROGRESSION[pointIndex] || (this.LENGTH_PROGRESSION.at(-1) as number));
    return widthFactor * (lengthWidth + fluxWidth) + startingWidth;
  }

  getSourceWidth(flux: number) {
    return rn(Math.min(flux ** 0.9 / this.FLUX_FACTOR, this.MAX_FLUX_WIDTH), 2);
  }

  getApproximateLength(points: Point[] = []) {
    const length = points.reduce((s, v, i, p) => s + (i ? Math.hypot(v[0] - p[i - 1][0], v[1] - p[i - 1][1]) : 0), 0);
    return rn(length, 2);
  }

  // Real mouth width examples: Amazon 6000m, Volga 6000m, Dniepr 3000m, Mississippi 1300m, Themes 900m,
  // Danube 800m, Daugava 600m, Neva 500m, Nile 450m, Don 400m, Wisla 300m, Pripyat 150m, Bug 140m, Muchavets 40m
  getWidth(offset: number) {
    return rn((offset / 1.5) ** 1.8, 2); // mouth width in km
  }
}
