// Layer families for the per-layer golden (bench/host/layer-golden.ts), shared with bench/gate/gate.ts for argument
// checking. One family = one top-level group the isolation shows alone: a direct child of #viewbox, or a direct
// child of svg#map for the screen overlays (`root`). `toggle` is the bridge `display` layer name (mcp/src/bridge.js
// LAYERS) turned on before the family is captured; families without one are always drawn by the app. `rows` are the
// REWRITE-PLAN §5 matrix rows the family's golden serves. #tradeAnimation (row 22, animated) and #debug are not
// families: the animation smoke covers the first and the second is not user content.

export interface Family {
  name: string;
  id: string;
  root?: boolean;
  toggle?: string;
  rows: number[];
  coast?: boolean; // also captured at the coastline filter switch points (D5 nightly `coastk`)
}

export const FAMILIES: Family[] = [
  { name: "ocean", id: "ocean", rows: [1] },
  { name: "landmass", id: "landmass", rows: [11], coast: true },
  { name: "texture", id: "texture", toggle: "texture", rows: [23] },
  { name: "terrs", id: "terrs", toggle: "heightmap", rows: [2] },
  { name: "lakes", id: "lakes", toggle: "lakes", rows: [11], coast: true },
  { name: "biomes", id: "biomes", toggle: "biomes", rows: [3] },
  { name: "cells", id: "cells", toggle: "cells", rows: [4] },
  { name: "grid", id: "gridOverlay", toggle: "grid", rows: [5] },
  { name: "coordinates", id: "coordinates", toggle: "coordinates", rows: [5] },
  { name: "compass", id: "compass", toggle: "compass", rows: [6] },
  { name: "rivers", id: "rivers", toggle: "rivers", rows: [12] },
  { name: "relief", id: "terrain", toggle: "relief", rows: [14] },
  { name: "religions", id: "relig", toggle: "religions", rows: [9] },
  { name: "cultures", id: "cults", toggle: "cultures", rows: [9] },
  { name: "states", id: "regions", toggle: "states", rows: [7] },
  { name: "provinces", id: "provs", toggle: "provinces", rows: [8] },
  { name: "zones", id: "zones", toggle: "zones", rows: [10] },
  { name: "borders", id: "borders", toggle: "borders", rows: [8] },
  { name: "routes", id: "routes", toggle: "routes", rows: [13] },
  { name: "temperature", id: "temperature", toggle: "temperature", rows: [21] },
  { name: "coastline", id: "coastline", rows: [11], coast: true },
  { name: "ice", id: "ice", toggle: "ice", rows: [19] },
  { name: "goods", id: "goods", toggle: "goods", rows: [21] },
  { name: "markets", id: "markets", toggle: "markets", rows: [21] },
  { name: "precipitation", id: "prec", toggle: "precipitation", rows: [21] },
  { name: "population", id: "population", toggle: "population", rows: [21] },
  { name: "emblems", id: "emblems", toggle: "emblems", rows: [20] },
  { name: "burgs", id: "icons", toggle: "burgs", rows: [15] },
  { name: "labels", id: "labels", toggle: "labels", rows: [16] },
  { name: "military", id: "armies", toggle: "military", rows: [18] },
  { name: "markers", id: "markers", toggle: "markers", rows: [17, 43] },
  { name: "fog", id: "fogging-cont", rows: [42] },
  { name: "rulers", id: "ruler", toggle: "rulers", rows: [6] },
  { name: "scaleBar", id: "scaleBar", root: true, toggle: "scaleBar", rows: [6] },
  { name: "vignette", id: "vignette", root: true, toggle: "vignette", rows: [42] },
  { name: "legend", id: "legend", root: true, rows: [24] }
];

export const FAMILY_NAMES = FAMILIES.map(f => f.name);

// "all" or a comma list of family names; also accepts the element id (e.g. gridOverlay, regions).
export function selectFamilies(spec: string): Family[] {
  if (spec === "all") return FAMILIES;
  const out: Family[] = [];
  for (const raw of spec.split(",").map(s => s.trim()).filter(Boolean)) {
    const family = FAMILIES.find(f => f.name === raw || f.id === raw);
    if (!family) throw new Error(`unknown layer family "${raw}"; one of all, ${FAMILY_NAMES.join(", ")}`);
    if (!out.includes(family)) out.push(family);
  }
  if (!out.length) throw new Error("no layer family selected");
  return out;
}

// A comma list of positive zoom factors (k), e.g. "1,4" or "1.4,1.6".
export function parseZooms(spec: string): number[] {
  if (!spec.trim()) return [];
  const out = spec.split(",").map(s => Number(s.trim()));
  if (out.some(k => !Number.isFinite(k) || k <= 0 || k > 64)) throw new Error(`bad zoom list "${spec}": positive numbers ≤ 64`);
  return [...new Set(out)];
}

export const STYLE_PRESETS = ["default", "ancient", "gloom", "pale", "light", "watercolor", "clean", "atlas", "darkSeas", "cyberpunk", "night", "monochrome"];

// "all" (the 12 built-in presets), "map" (keep the fixture's own style) or a comma list of preset names.
export function parsePresets(spec: string): string[] {
  if (spec === "all") return STYLE_PRESETS;
  const out = spec.split(",").map(s => s.trim()).filter(Boolean);
  for (const p of out) if (p !== "map" && !STYLE_PRESETS.includes(p)) throw new Error(`unknown preset "${p}"; one of map, all, ${STYLE_PRESETS.join(", ")}`);
  if (!out.length) throw new Error("no preset selected");
  return [...new Set(out)];
}
