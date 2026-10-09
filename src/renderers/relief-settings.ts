// tupaia-mcp: map-level relief icon settings. They are attributes of #terrain, so every save
// carries them; the Tupaia MCP server writes them (mcp/src/bridge-ext/relief.js) and the relief
// renderer reads them on every draw. With none of them set the renderer behaves as upstream.
//   data-seed        seed of a deterministic draw (each cell gets its own stream, keyed by its position)
//   data-scale       multiplier on the style density (icon spacing); 0 draws nothing
//   data-biomes      per-biome multipliers "biomeId:k,...", on top of data-scale
//   data-min-height  no icons on cells lower than this
//   data-exclude     "<grid cell count>:<ranges>": grid cells without icons, e.g. "9916:3-7,12"
//   data-near-burgs  no icons within this many px of a burg
//   data-regenerate  saves drop the icons (save.ts) and a load draws them again (load.ts)

export interface ReliefSettings {
  seed: string | null;
  scale: number;
  biomes: Map<number, number>;
  minHeight: number;
  /** Excluded grid cells; null when unset or recorded on another grid. */
  exclude: Set<number> | null;
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

export function readReliefSettings(
  el: { getAttribute(name: string): string | null } | null,
  gridCells: number
): ReliefSettings {
  const attr = (name: string) => el?.getAttribute(name) ?? null;
  const biomes = new Map<number, number>();
  for (const pair of (attr("data-biomes") || "").split(",")) {
    const [id, k] = pair.split(":").map(Number);
    if (Number.isInteger(id) && Number.isFinite(k)) biomes.set(id, Math.max(0, k));
  }
  let exclude: Set<number> | null = null;
  const excluded = attr("data-exclude");
  const colon = excluded ? excluded.indexOf(":") : -1;
  if (excluded && colon > 0 && Number(excluded.slice(0, colon)) === gridCells)
    exclude = new Set(parseRanges(excluded.slice(colon + 1)));
  return {
    seed: attr("data-seed"),
    scale: Math.max(0, toNumber(attr("data-scale"), 1)),
    biomes,
    minHeight: toNumber(attr("data-min-height"), 0),
    exclude,
    nearBurgs: Math.max(0, toNumber(attr("data-near-burgs"), 0))
  };
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
