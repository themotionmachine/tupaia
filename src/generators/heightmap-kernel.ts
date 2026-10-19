// DOM-free terrain operations shared by editor calls and worker generation.
import Alea from "alea";
import { range as d3Range, leastIndex, mean } from "d3";
import { createTypedArray } from "../utils/arrayUtils";
import { lim } from "../utils/numberUtils";

type Tool = "Hill" | "Pit" | "Range" | "Trough" | "Strait" | "Mask" | "Invert" | "Add" | "Multiply" | "Smooth";
function findGridCell(x: number, y: number, graph: { spacing: number; cellsX: number; cellsY: number }): number {
  return (
    Math.floor(Math.min(y / graph.spacing, graph.cellsY - 1)) * graph.cellsX +
    Math.floor(Math.min(x / graph.spacing, graph.cellsX - 1))
  );
}

export class HeightmapKernel {
  width = 0;
  height = 0;
  random: () => number = () => Math.random();

  grid: HeightmapGraph | null = null;
  heights: Uint8Array | null = null;
  blobPower: number = 0;
  linePower: number = 0;

  private probability(value: number): boolean {
    if (value >= 1) return true;
    if (value <= 0) return false;
    return this.random() < value;
  }
  private rand(min: number, max: number): number {
    return Math.floor(this.random() * (max - min + 1)) + min;
  }
  private numberInRange(value: string): number {
    if (typeof value !== "string") return 0;
    if (!Number.isNaN(+value)) return ~~value + +this.probability(+value - ~~value);
    const sign = value[0] === "-" ? -1 : 1;
    if (Number.isNaN(+value[0])) value = value.slice(1);
    const range = value.includes("-") ? value.split("-") : null;
    if (!range) return 0;
    const count = this.rand(parseFloat(range[0]) * sign, parseFloat(range[1]));
    return Number.isNaN(count) || count < 0 ? 0 : count;
  }

  protected clearData() {
    this.heights = null;
    this.grid = null;
  }

  private getBlobPower(cells: number): number {
    const blobPowerMap: Record<number, number> = {
      1000: 0.93,
      2000: 0.95,
      5000: 0.97,
      10000: 0.98,
      20000: 0.99,
      30000: 0.991,
      40000: 0.993,
      50000: 0.994,
      60000: 0.995,
      70000: 0.9955,
      80000: 0.996,
      90000: 0.9964,
      100000: 0.9973
    };
    return blobPowerMap[cells] || 0.98;
  }

  private getLinePower(cells: number): number {
    const linePowerMap: Record<number, number> = {
      1000: 0.75,
      2000: 0.77,
      5000: 0.79,
      10000: 0.81,
      20000: 0.82,
      30000: 0.83,
      40000: 0.84,
      50000: 0.86,
      60000: 0.87,
      70000: 0.88,
      80000: 0.91,
      90000: 0.92,
      100000: 0.93
    };

    return linePowerMap[cells] || 0.81;
  }

  private getPointInRange(range: string, length: number): number | undefined {
    if (typeof range !== "string") {
      console.error("Range should be a string");
      return;
    }

    const min = parseInt(range.split("-")[0], 10) / 100 || 0;
    const max = parseInt(range.split("-")[1], 10) / 100 || min;
    return this.rand(min * length, max * length);
  }

  setGraph(graph: HeightmapGraph) {
    const { cellsDesired, cells, points } = graph;
    this.heights = cells.h
      ? Uint8Array.from(cells.h)
      : (createTypedArray({
          maxValue: 100,
          length: points.length
        }) as Uint8Array);
    this.blobPower = this.getBlobPower(cellsDesired);
    this.linePower = this.getLinePower(cellsDesired);
    this.grid = graph;
  }

  addHill(count: string, height: string, rangeX: string, rangeY: string): void {
    const addOneHill = () => {
      if (!this.heights || !this.grid) return;
      const change = new Uint8Array(this.heights.length);
      let limit = 0;
      let start: number;
      const h = lim(this.numberInRange(height));

      do {
        const x = this.getPointInRange(rangeX, this.width);
        const y = this.getPointInRange(rangeY, this.height);
        if (x === undefined || y === undefined) return;
        start = findGridCell(x, y, this.grid!);
        limit++;
      } while (this.heights[start] + h > 90 && limit < 50);
      change[start] = h;
      const queue = [start];
      while (queue.length) {
        const q = queue.shift() as number;

        for (const c of this.grid!.cells.c[q]) {
          if (change[c]) continue;
          change[c] = change[q] ** this.blobPower * (this.random() * 0.2 + 0.9);
          if (change[c] > 1) queue.push(c);
        }
      }

      this.heights = this.heights.map((h, i) => lim(h + change[i]));
    };

    const desiredHillCount = this.numberInRange(count);
    for (let i = 0; i < desiredHillCount; i++) {
      addOneHill();
    }
  }

  addPit(count: string, height: string, rangeX: string, rangeY: string): void {
    const addOnePit = () => {
      if (!this.heights || !this.grid) return;
      const used = new Uint8Array(this.heights.length);
      let limit = 0;
      let start: number;
      let h = lim(this.numberInRange(height));

      do {
        const x = this.getPointInRange(rangeX, this.width);
        const y = this.getPointInRange(rangeY, this.height);
        if (x === undefined || y === undefined) return;
        start = findGridCell(x, y, this.grid!);
        limit++;
      } while (this.heights[start] < 20 && limit < 50);

      const queue = [start];
      while (queue.length) {
        const q = queue.shift() as number;
        h = h ** this.blobPower * (this.random() * 0.2 + 0.9);
        if (h < 1) return;

        this.grid!.cells.c[q].forEach((c: number) => {
          if (used[c] || this.heights === null) return;
          this.heights[c] = lim(this.heights[c] - h * (this.random() * 0.2 + 0.9));
          used[c] = 1;
          queue.push(c);
        });
      }
    };

    const desiredPitCount = this.numberInRange(count);
    for (let i = 0; i < desiredPitCount; i++) {
      addOnePit();
    }
  }

  addRange(
    count: string,
    height: string,
    rangeX: string,
    rangeY: string,
    startCellId?: number,
    endCellId?: number
  ): void {
    if (!this.heights || !this.grid) return;

    const addOneRange = () => {
      if (!this.heights || !this.grid) return;

      // get main ridge
      const getRange = (cur: number, end: number) => {
        const range = [cur];
        const p = this.grid!.points;
        used[cur] = 1;

        while (cur !== end) {
          let min = Infinity;
          this.grid!.cells.c[cur].forEach((e: number) => {
            if (used[e]) return;
            let diff = (p[end][0] - p[e][0]) ** 2 + (p[end][1] - p[e][1]) ** 2;
            if (this.random() > 0.85) diff = diff / 2;
            if (diff < min) {
              min = diff;
              cur = e;
            }
          });
          if (min === Infinity) return range;
          range.push(cur);
          used[cur] = 1;
        }

        return range;
      };

      const used = new Uint8Array(this.heights.length);
      let h = lim(this.numberInRange(height));

      if (rangeX && rangeY) {
        // find start and end points
        const startX = this.getPointInRange(rangeX, this.width) as number;
        const startY = this.getPointInRange(rangeY, this.height) as number;

        let dist = 0;
        let limit = 0;
        let endY: number;
        let endX: number;

        do {
          endX = this.random() * this.width * 0.8 + this.width * 0.1;
          endY = this.random() * this.height * 0.7 + this.height * 0.15;
          dist = Math.abs(endY - startY) + Math.abs(endX - startX);
          limit++;
        } while ((dist < this.width / 8 || dist > this.width / 3) && limit < 50);

        startCellId = findGridCell(startX, startY, this.grid!);
        endCellId = findGridCell(endX, endY, this.grid!);
      }

      const range = getRange(startCellId as number, endCellId as number);

      // add height to ridge and cells around
      let queue = range.slice();
      let i = 0;
      while (queue.length) {
        const frontier = queue.slice();
        queue = [];
        i++;
        frontier.forEach((i: number) => {
          if (!this.heights) return;
          this.heights[i] = lim(this.heights[i] + h * (this.random() * 0.3 + 0.85));
        });
        h = h ** this.linePower - 1;
        if (h < 2) break;
        frontier.forEach((f: number) => {
          this.grid!.cells.c[f].forEach((i: number) => {
            if (!used[i]) {
              queue.push(i);
              used[i] = 1;
            }
          });
        });
      }

      // generate prominences
      range.forEach((cur: number, d: number) => {
        if (d % 6 !== 0) return;
        for (const _l of d3Range(i)) {
          const index = leastIndex(
            this.grid!.cells.c[cur],
            (a: number, b: number) => this.heights![a] - this.heights![b]
          );
          if (index === undefined) continue;
          const min = this.grid!.cells.c[cur][index]; // downhill cell
          this.heights![min] = (this.heights![cur] * 2 + this.heights![min]) / 3;
          cur = min;
        }
      });
    };

    const desiredRangeCount = this.numberInRange(count);
    for (let i = 0; i < desiredRangeCount; i++) {
      addOneRange();
    }
  }

  addTrough(
    count: string,
    height: string,
    rangeX: string,
    rangeY: string,
    startCellId?: number,
    endCellId?: number
  ): void {
    const addOneTrough = () => {
      if (!this.heights || !this.grid) return;

      // get main ridge
      const getRange = (cur: number, end: number) => {
        const range = [cur];
        const p = this.grid!.points;
        used[cur] = 1;

        while (cur !== end) {
          let min = Infinity;
          this.grid!.cells.c[cur].forEach((e: number) => {
            if (used[e]) return;
            let diff = (p[end][0] - p[e][0]) ** 2 + (p[end][1] - p[e][1]) ** 2;
            if (this.random() > 0.8) diff = diff / 2;
            if (diff < min) {
              min = diff;
              cur = e;
            }
          });
          if (min === Infinity) return range;
          range.push(cur);
          used[cur] = 1;
        }

        return range;
      };

      const used = new Uint8Array(this.heights.length);
      let h = lim(this.numberInRange(height));

      if (rangeX && rangeY) {
        // find start and end points
        let limit = 0;
        let startX: number;
        let startY: number;
        let dist = 0;
        let endX: number;
        let endY: number;
        do {
          startX = this.getPointInRange(rangeX, this.width) as number;
          startY = this.getPointInRange(rangeY, this.height) as number;
          startCellId = findGridCell(startX, startY, this.grid!);
          limit++;
        } while (this.heights[startCellId] < 20 && limit < 50);

        limit = 0;
        do {
          endX = this.random() * this.width * 0.8 + this.width * 0.1;
          endY = this.random() * this.height * 0.7 + this.height * 0.15;
          dist = Math.abs(endY - startY) + Math.abs(endX - startX);
          limit++;
        } while ((dist < this.width / 8 || dist > this.width / 2) && limit < 50);

        endCellId = findGridCell(endX, endY, this.grid!);
      }

      const range = getRange(startCellId as number, endCellId as number);

      // add height to ridge and cells around
      let queue = range.slice(),
        i = 0;
      while (queue.length) {
        const frontier = queue.slice();
        queue = [];
        i++;
        frontier.forEach((i: number) => {
          this.heights![i] = lim(this.heights![i] - h * (this.random() * 0.3 + 0.85));
        });
        h = h ** this.linePower - 1;
        if (h < 2) break;
        frontier.forEach((f: number) => {
          this.grid!.cells.c[f].forEach((i: number) => {
            if (!used[i]) {
              queue.push(i);
              used[i] = 1;
            }
          });
        });
      }

      // generate prominences
      range.forEach((cur: number, d: number) => {
        if (d % 6 !== 0) return;
        for (const _l of d3Range(i)) {
          const index = leastIndex(
            this.grid!.cells.c[cur],
            (a: number, b: number) => this.heights![a] - this.heights![b]
          );
          if (index === undefined) continue;
          const min = this.grid!.cells.c[cur][index]; // downhill cell
          //debug.append("circle").attr("cx", p[min][0]).attr("cy", p[min][1]).attr("r", 1);
          this.heights![min] = (this.heights![cur] * 2 + this.heights![min]) / 3;
          cur = min;
        }
      });
    };

    const desiredTroughCount = this.numberInRange(count);
    for (let i = 0; i < desiredTroughCount; i++) {
      addOneTrough();
    }
  }

  addStrait(width: string, direction = "vertical"): void {
    if (!this.heights || !this.grid) return;
    const desiredWidth = Math.min(this.numberInRange(width), this.grid!.cellsX / 3);
    if (desiredWidth < 1 && this.probability(desiredWidth)) return;
    const used = new Uint8Array(this.heights.length);
    const vert = direction === "vertical";
    const startX = vert ? Math.floor(this.random() * this.width * 0.4 + this.width * 0.3) : 5;
    const startY = vert ? 5 : Math.floor(this.random() * this.height * 0.4 + this.height * 0.3);
    const endX = vert
      ? Math.floor(this.width - startX - this.width * 0.1 + this.random() * this.width * 0.2)
      : this.width - 5;
    const endY = vert
      ? this.height - 5
      : Math.floor(this.height - startY - this.height * 0.1 + this.random() * this.height * 0.2);

    const start = findGridCell(startX, startY, this.grid!);
    const end = findGridCell(endX, endY, this.grid!);

    const getRange = (cur: number, end: number) => {
      const range = [];
      const p = this.grid!.points;

      while (cur !== end) {
        let min = Infinity;
        this.grid!.cells.c[cur].forEach((e: number) => {
          let diff = (p[end][0] - p[e][0]) ** 2 + (p[end][1] - p[e][1]) ** 2;
          if (this.random() > 0.8) diff = diff / 2;
          if (diff < min) {
            min = diff;
            cur = e;
          }
        });
        range.push(cur);
      }

      return range;
    };
    let range = getRange(start, end);
    const query: number[] = [];

    const step = 0.1 / desiredWidth;

    for (let i = 0; i < desiredWidth; i++) {
      const remainingWidth = desiredWidth - i;
      const exp = 0.9 - step * remainingWidth;
      range.forEach((r: number) => {
        this.grid!.cells.c[r].forEach((e: number) => {
          if (used[e]) return;
          used[e] = 1;
          query.push(e);
          this.heights![e] **= exp;
          if (this.heights![e] > 100) this.heights![e] = 5;
        });
      });
      range = query.slice();
    }
  }

  modify(range: string, add: number, mult: number, power?: number): void {
    if (!this.heights) return;
    const min = range === "land" ? 20 : range === "all" ? 0 : +range.split("-")[0];
    const max = range === "land" || range === "all" ? 100 : +range.split("-")[1];
    const isLand = min === 20;

    this.heights = this.heights.map(h => {
      if (h < min || h > max) return h;

      if (add) h = isLand ? Math.max(h + add, 20) : h + add;
      if (mult !== 1) h = isLand ? (h - 20) * mult + 20 : h * mult;
      if (power) h = isLand ? (h - 20) ** power + 20 : h ** power;
      return lim(h);
    });
  }

  smooth(fr = 2, add = 0): void {
    if (!this.heights || !this.grid) return;
    this.heights = this.heights.map((h, i) => {
      const a = [h];
      this.grid!.cells.c[i].forEach((c: number) => {
        a.push(this.heights![c]);
      });
      if (fr === 1) return (mean(a) as number) + add;
      return lim((h * (fr - 1) + (mean(a) as number) + add) / fr);
    });
  }

  mask(power = 1): void {
    if (!this.heights || !this.grid) return;
    const fr = power ? Math.abs(power) : 1;

    this.heights = this.heights.map((h, i) => {
      const [x, y] = this.grid!.points[i];
      const nx = (2 * x) / this.width - 1; // [-1, 1], 0 is center
      const ny = (2 * y) / this.height - 1; // [-1, 1], 0 is center
      let distance = (1 - nx ** 2) * (1 - ny ** 2); // 1 is center, 0 is edge
      if (power < 0) distance = 1 - distance; // inverted, 0 is center, 1 is edge
      const masked = h * distance;
      return lim((h * (fr - 1) + masked) / fr);
    });
  }

  invert(count: number, axes: string): void {
    if (!this.probability(count) || !this.heights || !this.grid) return;

    const invertX = axes !== "y";
    const invertY = axes !== "x";
    const { cellsX, cellsY } = this.grid;

    const inverted = this.heights.map((_h: number, i: number) => {
      if (!this.heights) return 0;
      const x = i % cellsX;
      const y = Math.floor(i / cellsX);

      const nx = invertX ? cellsX - x - 1 : x;
      const ny = invertY ? cellsY - y - 1 : y;
      const invertedI = nx + ny * cellsX;
      return this.heights[invertedI];
    });

    this.heights = inverted;
  }

  addStep(tool: Tool, a2: string, a3: string, a4: string, a5: string): void {
    if (tool === "Hill") {
      this.addHill(a2, a3, a4, a5);
      return;
    }
    if (tool === "Pit") {
      this.addPit(a2, a3, a4, a5);
      return;
    }
    if (tool === "Range") {
      this.addRange(a2, a3, a4, a5);
      return;
    }
    if (tool === "Trough") {
      this.addTrough(a2, a3, a4, a5);
      return;
    }
    if (tool === "Strait") {
      this.addStrait(a2, a3);
      return;
    }
    if (tool === "Mask") {
      this.mask(+a2);
      return;
    }
    if (tool === "Invert") {
      this.invert(+a2, a3);
      return;
    }
    if (tool === "Add") {
      this.modify(a3, +a2, 1);
      return;
    }
    if (tool === "Multiply") {
      this.modify(a3, 0, +a2);
      return;
    }
    if (tool === "Smooth") {
      this.smooth(+a2);
      return;
    }
  }

  fromTemplateText(graph: HeightmapGraph, templateString: string, id = "custom"): Uint8Array | null {
    const steps = templateString.split("\n");

    if (!steps.length) throw new Error(`Heightmap template: no steps. Template: ${id}. Steps: ${steps}`);
    this.setGraph(graph);

    for (const step of steps) {
      const elements = step.trim().split(" ");
      if (elements.length < 2) throw new Error(`Heightmap template: steps < 2. Template: ${id}. Step: ${elements}`);
      this.addStep(...(elements as [Tool, string, string, string, string]));
    }

    return this.heights;
  }

  getHeights() {
    return this.heights;
  }
}

export interface HeightmapGraph {
  cellsDesired: number;
  cellsX: number;
  cellsY: number;
  spacing: number;
  points: Array<[number, number]>;
  cells: { c: number[][]; h?: Uint8Array };
}
export interface HeightmapInput {
  cellsDesired: number;
  cellsX: number;
  cellsY: number;
  spacing: number;
  width: number;
  height: number;
  seed: string;
  template: string;
  points: Float64Array;
  offsets: Uint32Array;
  neighbors: Uint32Array;
  heights?: Uint8Array;
}
export interface HeightmapResult {
  heights: Uint8Array;
  randomState: [number, number, number, number];
}

/** Runs the exact editor kernel with an independent seeded stream. */
export function computeHeightmap(input: HeightmapInput): HeightmapResult {
  const random = Alea(input.seed);
  const kernel = new HeightmapKernel();
  kernel.width = input.width;
  kernel.height = input.height;
  kernel.random = random;
  const graph: HeightmapGraph = {
    cellsDesired: input.cellsDesired,
    cellsX: input.cellsX,
    cellsY: input.cellsY,
    spacing: input.spacing,
    points: Array.from({ length: input.points.length / 2 }, (_, i) => [input.points[i * 2], input.points[i * 2 + 1]]),
    cells: {
      h: input.heights,
      c: Array.from({ length: input.offsets.length - 1 }, (_, i) =>
        Array.from(input.neighbors.subarray(input.offsets[i], input.offsets[i + 1]))
      )
    }
  };
  const heights = kernel.fromTemplateText(graph, input.template);
  if (!heights) throw new Error("Heightmap produced no heights");
  return { heights, randomState: random.exportState() };
}

/** Copies only the numeric graph; transferring it cannot detach live world data. */
export function heightmapInput(
  graph: HeightmapGraph,
  template: string,
  width: number,
  height: number,
  seed: string
): HeightmapInput {
  const points = new Float64Array(graph.points.length * 2);
  const offsets = new Uint32Array(graph.cells.c.length + 1);
  for (let i = 0; i < graph.points.length; i++) {
    points[i * 2] = graph.points[i][0];
    points[i * 2 + 1] = graph.points[i][1];
    offsets[i + 1] = offsets[i] + graph.cells.c[i].length;
  }
  const neighbors = new Uint32Array(offsets[offsets.length - 1]);
  for (let i = 0; i < graph.cells.c.length; i++) neighbors.set(graph.cells.c[i], offsets[i]);
  return {
    cellsDesired: graph.cellsDesired,
    cellsX: graph.cellsX,
    cellsY: graph.cellsY,
    spacing: graph.spacing,
    width,
    height,
    seed,
    template,
    points,
    offsets,
    neighbors,
    heights: graph.cells.h ? Uint8Array.from(graph.cells.h) : undefined
  };
}
