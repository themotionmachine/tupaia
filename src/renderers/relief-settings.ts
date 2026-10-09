// tupaia-mcp: map-level relief icon settings. They are attributes of #terrain, so every save
// carries them; the Tupaia MCP server writes them (mcp/src/bridge-ext/relief.js) and the relief
// renderer reads them on every draw. With none of them set the renderer behaves as upstream.
//   data-seed        seed of a deterministic draw (each cell gets its own stream, keyed by its position)
//   data-scale       multiplier on the style density; the icon count goes with its square, down to 0
//   data-biomes      per-biome multipliers "biomeId:k,...", on top of data-scale
//   data-min-height  no icons on cells lower than this
//   data-exclude     "<grid key>:<ranges>[;<g.e>,...]": cells without icons. The ranges are grid cells
//                    whose pack cells are all excluded; a "g.e" item is one pack cell of a coastal grid
//                    cell g (reGraph adds extra cells there): e = g for the cell at the grid point, else
//                    the neighbour e whose midpoint it is. Ignored on another grid (the key is gridKey:
//                    cell count and a hash of the grid points)
//   data-near-burgs  no icons within this many px of a burg
//   data-regenerate  saves drop the icons (save.ts) and a load draws them again (load.ts)
// A new map (generate) clears them all (main.js).

/** Every #terrain attribute this file defines. */
export const RELIEF_ATTRS = [
  "data-seed",
  "data-scale",
  "data-biomes",
  "data-min-height",
  "data-exclude",
  "data-near-burgs",
  "data-regenerate"
] as const;

export interface ReliefExclusion {
  /** Grid cells whose pack cells are all excluded. */
  cells: Set<number>;
  /** Single pack cells of other grid cells, by packCellKey ("g.e"). */
  parts: Set<string>;
  /** Grid cells that have an item in `parts`. */
  partGrids: Set<number>;
}

export interface ReliefSettings {
  seed: string | null;
  scale: number;
  biomes: Map<number, number>;
  minHeight: number;
  /** Excluded cells; null when unset or recorded on another grid. */
  exclude: ReliefExclusion | null;
  nearBurgs: number;
}

const toNumber = (value: string | null, fallback: number): number => {
  if (value === null || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** Ids from a ranges string such as "3-7,12". */
export function parseRanges(text: string): number[] {
  const ids: number[] = [];
  for (const part of text.split(",")) {
    if (!part) continue;
    const [from, to] = part.split("-").map(Number);
    if (!Number.isInteger(from)) continue;
    const last = Number.isInteger(to) ? to : from;
    for (let id = from; id <= last; id++) ids.push(id);
  }
  return ids;
}

/**
 * Key of a grid: its cell count and a hash of its points. A new map (or a regrid) has other
 * points, so an exclusion recorded on one grid is not applied to another one of the same size.
 */
export function gridKey(points: ArrayLike<readonly [number, number]>): string {
  let h = 0x811c9dc5;
  for (let k = 0; k < points.length; k++) {
    h = Math.imul(h ^ Math.round(points[k][0] * 100), 0x01000193);
    h = Math.imul(h ^ Math.round(points[k][1] * 100), 0x01000193);
  }
  return `${points.length}-${(h >>> 0).toString(36)}`;
}

/** Ranges string of integer ids (any order, duplicates allowed). */
export function encodeRanges(ids: Iterable<number>): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let k = 0; k < sorted.length; k++) {
    const from = sorted[k];
    while (sorted[k + 1] === sorted[k] + 1) k++;
    parts.push(sorted[k] === from ? String(from) : `${from}-${sorted[k]}`);
  }
  return parts.join(",");
}

/** The cells of a stored exclusion "<grid key>:<ranges>[;<g.e>,...]" (key check left to the caller). */
export function parseExclusion(body: string): ReliefExclusion {
  const semi = body.indexOf(";");
  const cells = new Set(parseRanges(semi < 0 ? body : body.slice(0, semi)));
  const parts = new Set<string>();
  const partGrids = new Set<number>();
  if (semi >= 0)
    for (const item of body.slice(semi + 1).split(",")) {
      const m = /^(\d+)\.(\d+)$/.exec(item);
      if (!m) continue;
      parts.add(item);
      partGrids.add(Number(m[1]));
    }
  return { cells, parts, partGrids };
}

/**
 * Identity of a pack cell that does not depend on pack cell numbering: "g.g" for the cell at grid
 * point g, "g.e" for an extra coastal cell reGraph put at the midpoint of g and its neighbour e.
 */
export function packCellKey(
  g: number,
  x: number,
  y: number,
  points: ArrayLike<readonly [number, number]>,
  neighbours: ArrayLike<ArrayLike<number>> | undefined
): string {
  const near = (ax: number, ay: number) => Math.abs(ax - x) < 0.06 && Math.abs(ay - y) < 0.06;
  const [gx, gy] = points[g];
  if (near(gx, gy)) return `${g}.${g}`;
  const around = neighbours?.[g];
  if (around)
    for (let k = 0; k < around.length; k++) {
      const e = around[k];
      if (near((gx + points[e][0]) / 2, (gy + points[e][1]) / 2)) return `${g}.${e}`;
    }
  return `${g}.?`;
}

export function readReliefSettings(
  el: { getAttribute(name: string): string | null } | null,
  currentGridKey: () => string
): ReliefSettings {
  const attr = (name: string) => el?.getAttribute(name) ?? null;
  const biomes = new Map<number, number>();
  for (const pair of (attr("data-biomes") || "").split(",")) {
    const [id, k] = pair.split(":").map(Number);
    if (Number.isInteger(id) && Number.isFinite(k)) biomes.set(id, Math.max(0, k));
  }
  let exclude: ReliefExclusion | null = null;
  const excluded = attr("data-exclude");
  const colon = excluded ? excluded.indexOf(":") : -1;
  if (excluded && colon > 0 && excluded.slice(0, colon) === currentGridKey())
    exclude = parseExclusion(excluded.slice(colon + 1));
  return {
    seed: attr("data-seed"),
    scale: Math.max(0, toNumber(attr("data-scale"), 1)),
    biomes,
    minHeight: toNumber(attr("data-min-height"), 0),
    exclude,
    nearBurgs: Math.max(0, toNumber(attr("data-near-burgs"), 0))
  };
}

/**
 * Below a multiplier of 1, the odds that a cell keeps its icons at all. The Poisson sampler always
 * yields the centre of the cell's bbox first, so a cell too small for a second icon at the thinned
 * spacing would keep one icon however low the multiplier went (a floor of one icon per cell). This
 * keeps the expected count going with the square of the multiplier: `area` is the cell's area,
 * `radius` the thinned icon spacing; about 0.49 icons fit per radius^2 (sampler with k = 3).
 */
export function keepOdds(k: number, area: number, radius: number): number {
  if (!(k < 1)) return 1;
  return Math.min(1, Math.max(k * k, (0.49 * area) / (radius * radius)));
}

/** Remove every relief setting from #terrain (a new map starts with upstream behaviour). */
export function clearReliefSettings(el: Element | null): void {
  for (const name of RELIEF_ATTRS) el?.removeAttribute(name);
}

/** 32-bit FNV-1a hash of a string. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let k = 0; k < text.length; k++) {
    h ^= text.charCodeAt(k);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** murmur3 finalizer: spreads the bits of a 32-bit integer. */
function mix(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * A Math.random replacement for the cell whose point is (x, y): the same seed and position give
 * the same stream, so editing one cell (or renumbering cells) leaves the icons of the others alone.
 */
export function cellRandom(seedHash: number, x: number, y: number): () => number {
  let state = mix(mix(seedHash ^ Math.round(x * 100)) ^ Math.round(y * 100));
  return () => {
    state = (state + 0x6d2b79f5) | 0; // mulberry32
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Load hook: a map saved with data-regenerate has an empty #terrain. Draw its icons again (the
 * renderer uses the stored seed and settings, so they look as before) and turn the Relief button
 * on when the layer was visible. No-op for maps that stored their icons (old files, older clients).
 */
export function restoreReliefOnLoad(): void {
  const node = terrain.node();
  if (!node?.hasAttribute("data-regenerate") || node.hasChildNodes() || node.style.display === "none") return;
  try {
    drawReliefIcons();
    document.getElementById("toggleRelief")?.classList.remove("buttonoff");
  } catch (error) {
    ERROR && console.error(error);
  }
}

// tupaia-mcp: the MCP bridge (mcp/src/bridge-ext/relief.js) and main.js use these through a global
declare global {
  var ReliefSettings: {
    attrs: typeof RELIEF_ATTRS;
    gridKey: typeof gridKey;
    packCellKey: typeof packCellKey;
    encodeRanges: typeof encodeRanges;
    parseExclusion: typeof parseExclusion;
    clear: () => void;
  };
}
globalThis.ReliefSettings = {
  attrs: RELIEF_ATTRS,
  gridKey,
  packCellKey,
  encodeRanges,
  parseExclusion,
  clear: () => clearReliefSettings(typeof document === "undefined" ? null : document.getElementById("terrain"))
};
