// apply, Node side: read and normalize a spec before the page (bridge-ext/apply.js) matches its
// entries to the map. Pure functions, so test/apply.test.ts checks them without a browser.
//
// A spec is a set of lists keyed by plural type (burgs, markers, labels, ...), each a list of
// entries keyed by name (labels: text; notes: id | entity | name) or by an explicit ref. The
// shapes the primordial-soup builder wrote (design/build-spec.json) are accepted directly:
//   - x, y on an entry become at:{x,y}; at:[x,y] becomes {x,y};
//   - routes: through/points entries that are strings are burg names, [x,y] pairs are places;
//     draw:'points' turns `through` into freehand `points` (with noPathfind:true, as add route
//     takes them), draw:'pathfind' keeps `through`;
//   - zones: shape {polygon:[[x,y]...], circle:[x,y,r], where} is the select (circle radius px);
//   - cultures: namesbase is an alias of base;
//   - states[].provinces (objects) are flattened into the provinces list.
// Anything else maps through `mapping` (lists renames, keys renames/drops, values tables or
// "prefix{}suffix" templates; a table's '*' entry is the default for values it does not list),
// applied first, and `ignore` ({list: [keys]}, '*' for every list) drops keys from the check.

/** Plural list key -> edit/add type. Other keys: a trailing 's' is dropped (sibling types). */
export const LIST_TYPES: Record<string, string> = {
  burgs: "burg",
  markers: "marker",
  labels: "label",
  zones: "zone",
  routes: "route",
  notes: "note",
  states: "state",
  provinces: "province",
  cultures: "culture",
  religions: "religion",
  rivers: "river",
  features: "feature",
  biomes: "biome",
  routeGroups: "routeGroup"
};

/**
 * Order the page works through, so references resolve: definitions (biomes, route groups),
 * peoples, burgs, states (capitals are burgs), provinces, rivers and features, routes (through
 * burgs), markers/zones/labels, any other runtime type, notes last (they attach to anything).
 */
export const STAGES: string[][] = [
  ["map"],
  ["biome", "routeGroup"],
  ["culture", "religion"],
  ["burg"],
  ["state"],
  ["province"],
  ["river", "feature"],
  ["route"],
  ["marker", "zone", "label"],
  ["*"],
  ["note"]
];

export function typeOfList(key: string): string {
  if (LIST_TYPES[key]) return LIST_TYPES[key];
  return key.length > 1 && key.endsWith("s") ? key.slice(0, -1) : key;
}

export function stageOf(type: string): number {
  const k = STAGES.findIndex(s => s.includes(type));
  return k >= 0 ? k : STAGES.findIndex(s => s.includes("*"));
}

export interface Mapping {
  /** Rename top-level lists, e.g. {rivers_intended: 'rivers', frame: 'map'}. */
  lists?: Record<string, string>;
  /** Per list: rename entry keys ({type: 'group'}) or drop them (null). */
  keys?: Record<string, Record<string, string | null>>;
  /**
   * Per list and field (after key renames): a lookup table (unlisted values pass through, or go
   * through its '*' entry, itself a value or a "prefix{}suffix" template; a null value drops the
   * field from that entry) or a "prefix{}suffix" template for strings.
   */
  values?: Record<string, Record<string, Record<string, unknown> | string>>;
}

export type Entry = Record<string, unknown>;

export interface NormalizedList {
  key: string;
  type: string;
  entries: Entry[];
}

export interface NormalizedSpec {
  lists: NormalizedList[];
  map: Entry | null;
  /** Top-level keys that are not entity lists (prose, settings the page has no field for). */
  skipped: string[];
  notes: string[];
  /** Every list (and map) the spec holds, after renames and before `only`. */
  present: string[];
}

/** Keys to leave out of the check, per list (after renames); '*' applies to every list. */
export type Ignore = Record<string, string[]>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length >= 2 && isNum(v[0]) && isNum(v[1]);

/** [x,y] -> {x,y}; a string -> a burg place (route through/points); objects pass through. */
export function toPlace(v: unknown, strings: "burg" | "keep" = "keep"): unknown {
  if (isPair(v)) return { x: v[0], y: v[1] };
  if (typeof v === "string" && strings === "burg") return { entity: { type: "burg", ref: v } };
  return v;
}

/** Spec select/shape -> a paint_cells-style select. */
export function toSelect(s: unknown): unknown {
  if (!isObj(s)) return s;
  const out: Record<string, unknown> = { ...s };
  if (Array.isArray(s.polygon)) out.polygon = s.polygon.map(p => toPlace(p));
  const c = s.circle;
  if (Array.isArray(c) && c.length >= 3 && c.every(isNum))
    out.circle = { at: { x: c[0], y: c[1] }, radius: c[2], unit: "px" };
  else if (isObj(c) && c.at !== undefined) out.circle = { ...c, at: toPlace(c.at) };
  return out;
}

const template = (m: string, v: unknown) => (typeof v === "string" ? m.split("{}").join(v) : v);

function applyValueMap(v: unknown, m: Record<string, unknown> | string): { drop: boolean; v: unknown } {
  if (typeof m === "string") return { drop: false, v: template(m, v) };
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    const k = String(v);
    const hit = Object.hasOwn(m, k) ? m[k] : Object.hasOwn(m, "*") ? m["*"] : undefined;
    if (hit === null) return { drop: true, v: undefined };
    if (hit !== undefined)
      return { drop: false, v: !Object.hasOwn(m, k) && typeof hit === "string" ? template(hit, v) : hit };
  }
  return { drop: false, v };
}

/** Rename/drop keys and map values of one entry (mapping.keys / mapping.values for its list). */
export function mapEntry(
  e: Entry,
  keys?: Record<string, string | null>,
  values?: Record<string, Record<string, unknown> | string>
): Entry {
  let out: Entry = e;
  if (keys) {
    out = {};
    for (const [k, v] of Object.entries(e)) if (!Object.hasOwn(keys, k)) out[k] = v;
    // a renamed key wins over a key of the same name already in the entry
    for (const [k, v] of Object.entries(e)) {
      const to = Object.hasOwn(keys, k) ? keys[k] : undefined;
      if (typeof to === "string") out[to] = v;
    }
  }
  if (values) {
    out = { ...out };
    for (const [field, m] of Object.entries(values)) {
      if (!(field in out) || m === undefined || m === null) continue;
      const r = applyValueMap(out[field], m);
      if (r.drop) delete out[field];
      else out[field] = r.v;
    }
  }
  return out;
}

/** Shape normalization of one entry of `type` (see the header). */
export function normalizeEntry(type: string, raw: Entry): Entry {
  const e: Entry = { ...raw };
  if (e.at === undefined && isNum(e.x) && isNum(e.y)) {
    e.at = { x: e.x, y: e.y };
    delete e.x;
    delete e.y;
  } else if (isPair(e.at)) e.at = toPlace(e.at);
  if (isPair(e.move)) e.move = toPlace(e.move);
  if (type === "route") {
    if (e.draw === "points" && e.points === undefined && e.through !== undefined) {
      e.points = e.through;
      delete e.through;
    }
    if (e.points !== undefined && e.noPathfind === undefined) e.noPathfind = true;
    if (e.draw === "points" || e.draw === "pathfind") delete e.draw;
    for (const k of ["through", "points"])
      if (Array.isArray(e[k])) e[k] = (e[k] as unknown[]).map(p => toPlace(p, "burg"));
  }
  if (type === "zone") {
    if (e.select === undefined && e.cells === undefined && e.shape !== undefined) {
      e.select = e.shape;
      delete e.shape;
    }
    if (e.select !== undefined) e.select = toSelect(e.select);
  }
  if (type === "culture" && e.base === undefined && e.namesbase !== undefined) {
    e.base = e.namesbase;
    delete e.namesbase;
  }
  return e;
}

export interface SpecInput {
  [list: string]: unknown;
}

/**
 * Merge, map and normalize. `fileSpec` (from specPath) comes first; inline lists replace the
 * file's list of the same key. `only` keeps just those lists (by their name after or before
 * mapping.lists renames); `ignore` drops keys from entries.
 */
export function normalizeSpec(
  fileSpec: SpecInput | null,
  inline: SpecInput,
  mapping: Mapping = {},
  only?: string[],
  ignore?: Ignore
): NormalizedSpec {
  const notes: string[] = [];
  const skipped: string[] = [];
  const merged: Record<string, unknown> = {};
  const origin = new Map<string, Set<string>>(); // list key after renames -> the keys it came from
  const rename = (k: string) => mapping.lists?.[k] ?? k;
  for (const src of [fileSpec ?? {}, inline])
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined) continue;
      const to = rename(k);
      merged[to] = v;
      if (!origin.has(to)) origin.set(to, new Set([to]));
      origin.get(to)?.add(k);
    }
  const wanted = (key: string) => !only || [...(origin.get(key) ?? [key])].some(k => only.includes(k));

  // states[].provinces (objects) -> the provinces list
  const states = merged.states;
  if (Array.isArray(states)) {
    const flat: Entry[] = [];
    merged.states = states.map(s => {
      if (!isObj(s) || !Array.isArray(s.provinces) || !s.provinces.every(isObj)) return s;
      const { provinces, ...rest } = s;
      for (const p of provinces as Entry[]) flat.push(p);
      return rest;
    });
    if (flat.length) {
      merged.provinces = [...(Array.isArray(merged.provinces) ? merged.provinces : []), ...flat];
      if (!origin.has("provinces")) origin.set("provinces", new Set(["provinces"]));
      if (wanted("provinces"))
        notes.push(`${flat.length} provinces nested in states were checked as the provinces list`);
    }
  }

  const dropKeys = (key: string, e: Entry): Entry => {
    const drop = [...(ignore?.["*"] ?? []), ...(ignore?.[key] ?? [])];
    if (!drop.length) return e;
    const out = { ...e };
    for (const k of drop) delete out[k];
    return out;
  };

  const lists: NormalizedList[] = [];
  const present: string[] = [];
  let map: Entry | null = null;
  for (const [key, v] of Object.entries(merged)) {
    const isList = key === "map" ? isObj(v) : Array.isArray(v) && v.every(isObj);
    if (isList) present.push(key);
    if (!wanted(key)) continue;
    if (key === "map") {
      if (isObj(v)) map = dropKeys("map", mapEntry(v, mapping.keys?.map, mapping.values?.map));
      else skipped.push(key);
      continue;
    }
    if (!isList) {
      skipped.push(key);
      continue;
    }
    const type = typeOfList(key);
    const entries = (v as Entry[]).map(e =>
      normalizeEntry(type, dropKeys(key, mapEntry(e, mapping.keys?.[key], mapping.values?.[key])))
    );
    lists.push({ key, type, entries });
  }
  lists.sort((a, b) => stageOf(a.type) - stageOf(b.type));
  return { lists, map, skipped, notes, present };
}
