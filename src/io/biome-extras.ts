// tupaia-mcp: per-biome relief icon density, relief icons and movement cost in the .map file.
// Upstream FMG saves only `color|habitability|name` on the biome line, so on every reload all
// biomes got the defaults back (custom biomes: icon density 0, no icons, cost 50). Newer files
// carry a 4th `|` field with this JSON; older clients split the line and read only the first
// three fields, so they ignore it (and drop it if they re-save the file).

export interface BiomeExtras {
  iconsDensity: number[];
  icons: string[][];
  cost: number[];
}

/** The 4th field of the biome line. */
export function serializeBiomeExtras(b: BiomeExtras): string {
  return JSON.stringify({ iconsDensity: b.iconsDensity, icons: b.icons, cost: b.cost });
}

/**
 * Apply the 4th field (and anything after it: `fields` is the whole biome line split by `|`)
 * to `target`, for indexes below `count`. Missing or malformed entries keep the target's
 * values. Returns how many biomes got values from the file.
 */
export function applyBiomeExtras(target: BiomeExtras, fields: string[], count: number): number {
  const raw = fields.slice(3).join("|");
  if (!raw) return 0;
  let x: Partial<Record<keyof BiomeExtras, unknown>>;
  try {
    x = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!x || typeof x !== "object") return 0;
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const density = list(x.iconsDensity);
  const cost = list(x.cost);
  const icons = list(x.icons);
  let applied = 0;
  for (let i = 0; i < count; i++) {
    let hit = false;
    const d = density[i];
    if (typeof d === "number" && Number.isFinite(d)) {
      target.iconsDensity[i] = d;
      hit = true;
    }
    const c = cost[i];
    if (typeof c === "number" && Number.isFinite(c)) {
      target.cost[i] = c;
      hit = true;
    }
    const ic = icons[i];
    if (Array.isArray(ic) && ic.every(s => typeof s === "string")) {
      target.icons[i] = ic.slice();
      hit = true;
    }
    if (hit) applied++;
  }
  return applied;
}
