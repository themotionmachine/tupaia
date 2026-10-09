import { extent, polygonContains, quadtree } from "d3";
import { minmax, rand, rn } from "../utils";
import { cellRandom, gridKey, hashString, readReliefSettings } from "./relief-settings";

interface ReliefIcon {
  i: string;
  x: number;
  y: number;
  s: number;
}

declare global {
  var drawReliefIcons: () => void;
  var terrain: import("d3").Selection<SVGGElement, unknown, null, undefined>;
  var getPackPolygon: (i: number) => [number, number][];
}

const reliefIconsRenderer = (): void => {
  TIME && console.time("drawRelief");
  terrain.selectAll("*").remove();

  const cells = pack.cells;
  const density = Number(terrain.attr("density")) || 0.4;
  const size = 2 * (Number(terrain.attr("size")) || 1);
  const mod = 0.2 * size; // size modifier
  const relief: ReliefIcon[] = [];

  // tupaia-mcp: map-level settings on #terrain (relief-settings.ts); none set = upstream behaviour
  const settings = readReliefSettings(terrain.node(), () => gridKey(grid.points));
  const seedHash = settings.seed === null ? null : hashString(settings.seed);
  const burgs = settings.nearBurgs ? pack.burgs.filter(b => b?.i && !b.removed) : [];
  const burgTree = burgs.length
    ? quadtree(
        burgs,
        b => b.x,
        b => b.y
      )
    : null;
  const nearBurg = (x: number, y: number) => !!burgTree?.find(x, y, settings.nearBurgs);

  for (const i of cells.i) {
    const height = cells.h[i];
    if (height < 20) continue; // no icons on water
    if (cells.r[i]) continue; // no icons on rivers
    const biome = cells.biome[i];
    if (height < 50 && biomesData.iconsDensity[biome] === 0) continue; // no icons for this biome
    if (height < settings.minHeight || settings.exclude?.has(cells.g[i])) continue; // tupaia-mcp
    const cellDensity = density * settings.scale * (settings.biomes.get(biome) ?? 1); // tupaia-mcp
    if (!(cellDensity > 0)) continue;
    // tupaia-mcp: seeded draw, one stream per cell (Math.random is restored by drawReliefIcons)
    if (seedHash !== null) Math.random = cellRandom(seedHash, cells.p[i][0], cells.p[i][1]);

    const polygon = getPackPolygon(i);
    const [minX, maxX] = extent(polygon, p => p[0]) as [number, number];
    const [minY, maxY] = extent(polygon, p => p[1]) as [number, number];

    if (height < 50) placeBiomeIcons();
    else placeReliefIcons();

    function placeBiomeIcons(): void {
      const iconsDensity = biomesData.iconsDensity[biome] / 100;
      const radius = 2 / iconsDensity / cellDensity;
      if (Math.random() > iconsDensity * 10) return;

      for (const [cx, cy] of window.poissonDiscSampler(minX, minY, maxX, maxY, radius)) {
        if (!polygonContains(polygon, [cx, cy]) || nearBurg(cx, cy)) continue;
        let h = (4 + Math.random()) * size;
        const icon = getBiomeIcon(i, biomesData.icons[biome]);
        if (icon === "#relief-grass-1") h *= 1.2;
        relief.push({
          i: icon,
          x: rn(cx - h, 2),
          y: rn(cy - h, 2),
          s: rn(h * 2, 2)
        });
      }
    }

    function placeReliefIcons(): void {
      const radius = 2 / cellDensity;
      const [icon, h] = getReliefIcon(i, height);

      for (const [cx, cy] of window.poissonDiscSampler(minX, minY, maxX, maxY, radius)) {
        if (!polygonContains(polygon, [cx, cy]) || nearBurg(cx, cy)) continue;
        relief.push({
          i: icon,
          x: rn(cx - h, 2),
          y: rn(cy - h, 2),
          s: rn(h * 2, 2)
        });
      }
    }

    function getReliefIcon(cellIndex: number, h: number): [string, number] {
      const temp = grid.cells.temp[pack.cells.g[cellIndex]];
      const type = h > 70 && temp < 0 ? "mountSnow" : h > 70 ? "mount" : "hill";
      const iconSize = h > 70 ? (h - 45) * mod : minmax((h - 40) * mod, 3, 6);
      return [getIcon(type), iconSize];
    }
  }

  // sort relief icons by y+size
  relief.sort((a, b) => a.y + a.s - (b.y + b.s));

  const reliefHTML: string[] = [];
  for (const r of relief) {
    reliefHTML.push(`<use href="${r.i}" x="${r.x}" y="${r.y}" width="${r.s}" height="${r.s}"/>`);
  }
  terrain.html(reliefHTML.join(""));

  TIME && console.timeEnd("drawRelief");

  function getBiomeIcon(cellIndex: number, b: string[]): string {
    let type = b[Math.floor(Math.random() * b.length)];
    const temp = grid.cells.temp[pack.cells.g[cellIndex]];
    if (type === "conifer" && temp < 0) type = "coniferSnow";
    return getIcon(type);
  }

  function getVariant(type: string): number {
    switch (type) {
      case "mount":
        return rand(2, 7);
      case "mountSnow":
        return rand(1, 6);
      case "hill":
        return rand(2, 5);
      case "conifer":
        return 2;
      case "coniferSnow":
        return 1;
      case "swamp":
        return rand(2, 3);
      case "cactus":
        return rand(1, 3);
      case "deadTree":
        return rand(1, 2);
      default:
        return 2;
    }
  }

  function getOldIcon(type: string): string {
    switch (type) {
      case "mountSnow":
        return "mount";
      case "vulcan":
        return "mount";
      case "coniferSnow":
        return "conifer";
      case "cactus":
        return "dune";
      case "deadTree":
        return "dune";
      default:
        return type;
    }
  }

  function getIcon(type: string): string {
    const set = terrain.attr("set") || "simple";
    if (set === "simple") return `#relief-${getOldIcon(type)}-1`;
    if (set === "colored") return `#relief-${type}-${getVariant(type)}`;
    if (set === "gray") return `#relief-${type}-${getVariant(type)}-bw`;
    return `#relief-${getOldIcon(type)}-1`; // simple
  }
};

// tupaia-mcp: a seeded draw swaps Math.random per cell; always put the native one back
window.drawReliefIcons = () => {
  const nativeRandom = Math.random;
  try {
    reliefIconsRenderer();
  } finally {
    Math.random = nativeRandom;
  }
};
