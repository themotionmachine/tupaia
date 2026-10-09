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
//   - states[].provinces (objects) are flattened into the provinces list;
//   - markers[].places [{name, x, y, note}] are folded into the marker's note legend (an HTML
//     list after the note, as the builder's translator wrote it);
//   - paint entries (the `paint` list, see normalizePaint) take the builder's selects:
//     feature_polygon(s) + buffer_px name shapes in terrain.features (or a top-level `shapes`),
//     selects:[...] is a union, and `from:'terrain_paint.Somnean'` / `from:'biomes_paint'` pulls
//     an entry (or a list of entries) out of the spec itself; custom biomes they paint
//     (custom:true, base, color, habitability) are checked as the biomes list;
//   - an entity's `territory` (cultures, religions, states, provinces) is never set directly:
//     the paint list paints it, and a territory no paint entry covers is listed in the notes.
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
  routeGroups: "routeGroup",
  paint: "paint"
};

/**
 * Order the page works through, so references resolve: definitions (biomes, route groups),
 * peoples, burgs, states (capitals are burgs), provinces, rivers and features, routes (through
 * burgs), markers/zones/labels, any other runtime type, the paint list (its targets exist by
 * then), notes last (they attach to anything).
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
  ["paint"],
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
  if (type === "marker" && Array.isArray(e.places) && e.places.length && e.places.every(isObj)) {
    const list = placesHtml(e.places as Entry[]);
    if (isObj(e.note)) e.note = { ...e.note, legend: `${escHtml(String(e.note.legend ?? ""))}${list}` };
    else e.note = `${escHtml(typeof e.note === "string" ? e.note : "")}${list}`;
    delete e.places;
  }
  return e;
}

/** HTML-escape text for a note legend (as Python's html.escape: & < > " '). */
export function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * A composite marker's places as the legend tail the builder's translator writes: the note,
 * then one line per place '<name> (x,y): <note>' (an HTML list under a bold 'Places:').
 */
export function placesHtml(places: Entry[]): string {
  const li = places.map(p => {
    const at = isNum(p.x) && isNum(p.y) ? ` (${p.x},${p.y})` : isPair(p.at) ? ` (${p.at[0]},${p.at[1]})` : "";
    const note = p.note !== undefined ? `: ${escHtml(String(p.note))}` : "";
    return `<li><b>${escHtml(String(p.name ?? ""))}</b>${at}${note}</li>`;
  });
  return `<br><b>Places:</b><ul>${li.join("")}</ul>`;
}

// ---------------------------------------------------------------- paint list

/** What a paint entry may set (paint_cells set keys apply can keep idempotent). */
export const PAINT_SET_KEYS = ["state", "province", "culture", "religion", "biome", "height"];
/** Select keys a paint entry may give at its top level (flattened form). */
const SELECT_TOP = [
  "cells",
  "circle",
  "polygon",
  "entity",
  "feature_polygon",
  "feature_polygons",
  "selects",
  "any",
  "buffer",
  "buffer_px",
  "where",
  "except"
];
/** Comments on a paint entry (never applied, never reported). */
const PAINT_DOC_KEYS = ["note", "rule", "kind"];
/** Keys of a custom biome a biome paint entry may define (custom:true). */
const BIOME_DEF_KEYS = ["base", "color", "habitability", "iconsDensity", "icons", "cost"];
/** Entity lists whose entries may carry a `territory` (painted by the paint list). */
export const TERRITORY_TYPES: Record<string, string> = {
  cultures: "culture",
  religions: "religion",
  states: "state",
  provinces: "province"
};

/** A spec shape {polygon|circle} named by a paint select (terrain.features[].id or shapes). */
export type ShapeIndex = Map<string, Entry>;

/** Named shapes: the builder's terrain.features [{id, shape}] and a top-level shapes {name: shape} or [{id|name, shape}]. */
export function shapeIndex(root: Record<string, unknown>): ShapeIndex {
  const ix: ShapeIndex = new Map();
  const put = (list: unknown) => {
    if (Array.isArray(list))
      for (const f of list)
        if (isObj(f) && isObj(f.shape) && typeof (f.id ?? f.name) === "string") ix.set(String(f.id ?? f.name), f.shape);
  };
  const t = root.terrain;
  if (isObj(t)) put(t.features);
  const sh = root.shapes;
  if (Array.isArray(sh)) put(sh);
  else if (isObj(sh)) for (const [k, v] of Object.entries(sh)) if (isObj(v)) ix.set(k, v);
  return ix;
}

class SpecError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function namedShape(shapes: ShapeIndex, name: unknown, buf: number): Entry {
  const s = typeof name === "string" ? shapes.get(name) : undefined;
  if (!s) {
    const f = typeof name === "string" ? name.toLowerCase() : "";
    const near = [...shapes.keys()]
      .filter(k => {
        const l = k.toLowerCase();
        return f.length > 0 && (l.includes(f) || f.includes(l) || l.slice(0, 3) === f.slice(0, 3));
      })
      .slice(0, 5);
    throw new SpecError(
      "NOT_FOUND",
      `no shape named '${String(name)}' in terrain.features or shapes${near.length ? ` (near: ${near.join(", ")})` : ""}`
    );
  }
  if (Array.isArray(s.circle) && s.circle.length >= 3 && s.circle.every(isNum)) {
    const [x, y, r] = s.circle as number[];
    // a circle grown by buffer px is the circle of radius r + buffer
    return { circle: { at: { x, y }, radius: r + Math.max(0, buf), unit: "px" } };
  }
  if (Array.isArray(s.polygon)) {
    const out: Entry = { polygon: (s.polygon as unknown[]).map(p => toPlace(p)) };
    if (buf) out.buffer = buf;
    return out;
  }
  throw new SpecError(
    "BAD_ARGS",
    `shape '${String(name)}' is a ${Object.keys(s).join("/")}; a paint select takes a polygon or circle shape`
  );
}

/**
 * A spec select -> a paint select (paint_cells keys plus `any:[selects]`, a union). Accepts
 * polygon [[x,y]], circle [x,y,r], feature_polygon / feature_polygons (named shapes, grown by
 * buffer_px: the builder's 'offset outward'), selects:[...] (a union), where, except (a select
 * of its own), buffer. Unknown keys pass through, so the page refuses them by name.
 */
export function toPaintSelect(s: unknown, shapes: ShapeIndex): Entry {
  if (Array.isArray(s)) return { any: s.map(x => toPaintSelect(x, shapes)) };
  if (!isObj(s)) throw new SpecError("BAD_ARGS", "a paint select is an object ({polygon|circle|cells|entity|...})");
  const base = toSelect(s) as Entry;
  const featNames = [
    ...(s.feature_polygon !== undefined ? [s.feature_polygon] : []),
    ...(Array.isArray(s.feature_polygons) ? s.feature_polygons : [])
  ];
  const bufPx = isNum(s.buffer_px) ? s.buffer_px : 0;
  const plain: Entry = {};
  for (const k of Object.keys(base))
    if (!["feature_polygon", "feature_polygons", "buffer_px", "selects", "any", "where", "except"].includes(k))
      plain[k] = base[k];
  // buffer_px grows the named shapes; without any it is the select's buffer
  if (!featNames.length && bufPx && plain.buffer === undefined) plain.buffer = bufPx;
  const parts: Entry[] = [];
  const hasShape = ["cells", "circle", "polygon", "entity"].some(k => plain[k] !== undefined);
  if (hasShape) parts.push(plain);
  else if (Object.keys(plain).some(k => k !== "buffer")) parts.push(plain); // unknown keys: the page names them
  for (const n of featNames) parts.push(namedShape(shapes, n, bufPx));
  for (const k of ["selects", "any"] as const)
    if (s[k] !== undefined) {
      if (!Array.isArray(s[k])) throw new SpecError("BAD_ARGS", `${k} is a list of selects`);
      for (const x of s[k] as unknown[]) parts.push(toPaintSelect(x, shapes));
    }
  let out: Entry;
  if (!parts.length)
    out = plain.buffer !== undefined ? { buffer: plain.buffer } : {}; // the page refuses a bare buffer
  else if (parts.length === 1 && parts[0].where === undefined && parts[0].except === undefined && !parts[0].any)
    out = { ...parts[0] };
  else out = { any: parts };
  if (s.where !== undefined) out.where = s.where;
  if (s.except !== undefined && s.except !== null) out.except = toPaintSelect(s.except, shapes);
  return out;
}

/** A path into the spec: 'terrain_paint.Somnean' or ['religions', 'Soul in Stone', 'territory']. */
function resolveFrom(root: Record<string, unknown>, from: unknown): { value: unknown; top: string } {
  const segs = Array.isArray(from) ? from.map(String) : typeof from === "string" ? from.split(".") : null;
  if (!segs?.length || !segs[0])
    throw new SpecError("BAD_ARGS", "from is a path into the spec: 'list.name.key' or [...]");
  let v: unknown = root;
  const walked: string[] = [];
  for (const seg of segs) {
    let next: unknown;
    if (Array.isArray(v)) {
      if (/^\d+$/.test(seg)) next = v[Number(seg)];
      else {
        const named = (x: unknown) =>
          isObj(x) ? [x.name, x.id, x.text, x.biome].find(n => typeof n === "string" && n === seg) : undefined;
        next =
          v.find(named) ??
          v.find(
            x =>
              isObj(x) &&
              [x.name, x.id, x.text, x.biome].some(n => typeof n === "string" && n.toLowerCase() === seg.toLowerCase())
          );
      }
    } else if (isObj(v)) next = v[seg];
    if (next === undefined)
      throw new SpecError(
        "NOT_FOUND",
        `from '${segs.join(".")}': nothing at '${[...walked, seg].join(".")}'${isObj(v) ? ` (keys: ${Object.keys(v).slice(0, 12).join(", ")})` : ""}`
      );
    walked.push(seg);
    v = next;
  }
  return { value: v, top: segs[0] };
}

export interface PaintEntry {
  /** The paint select (paint_cells keys plus any). */
  select?: Entry;
  /** state/province/culture/religion/biome (names or ids) and height {value} or a number. */
  set?: Entry;
  /** The row key: the entry's from path, else 'culture=Somnean, state=Somnean Realm'. */
  label: string;
  /** Keys this entry gives that apply does not use. */
  ignored?: string[];
  /** The entry could not be read (a bad from path, an unknown shape): an error row. */
  error?: { code: string; message: string };
}

export interface PaintNormalized {
  entries: PaintEntry[];
  /** Top-level spec keys a `from` used (they are not lists of their own then). */
  used: Set<string>;
  /** Custom biomes the entries define (custom:true), as biomes list entries. */
  biomes: Entry[];
}

/** One paint entry (possibly a from that expands to several) -> normalized entries. */
export function normalizePaint(raw: unknown[], root: Record<string, unknown>, shapes: ShapeIndex): PaintNormalized {
  const entries: PaintEntry[] = [];
  const used = new Set<string>();
  const biomes = new Map<string, Entry>();
  const one = (e: Entry, label: string | null) => {
    const set: Entry = isObj(e.set) ? { ...e.set } : {};
    for (const k of PAINT_SET_KEYS) if (e[k] !== undefined && set[k] === undefined) set[k] = e[k];
    const ignored: string[] = [];
    const selRaw: Entry = isObj(e.select) ? { ...e.select } : isObj(e.shape) ? { ...e.shape } : {};
    for (const k of SELECT_TOP)
      if (e[k] !== undefined) {
        if (k === "where" && isObj(selRaw.where) && isObj(e.where)) selRaw.where = { ...selRaw.where, ...e.where };
        else if (k === "except" && selRaw.except !== undefined) selRaw.except = { selects: [selRaw.except, e.except] };
        else selRaw[k] = e[k];
      }
    const custom = e.custom === true && typeof set.biome === "string";
    for (const k of Object.keys(e)) {
      if (["select", "shape", "set", "from", "custom", ...PAINT_SET_KEYS, ...SELECT_TOP, ...PAINT_DOC_KEYS].includes(k))
        continue;
      if (custom && BIOME_DEF_KEYS.includes(k)) continue;
      ignored.push(k);
    }
    if (custom && !biomes.has(String(set.biome))) {
      const def: Entry = { name: set.biome };
      for (const k of BIOME_DEF_KEYS) if (e[k] !== undefined) def[k] = e[k];
      biomes.set(String(set.biome), def);
    }
    const keyText = Object.entries(set)
      .map(([k, v]) => `${k}=${isObj(v) ? JSON.stringify(v) : String(v)}`)
      .join(", ");
    const out: PaintEntry = { label: label ?? (keyText || "paint") };
    if (ignored.length) out.ignored = ignored;
    try {
      if (!Object.keys(set).length)
        throw new SpecError(
          "BAD_ARGS",
          `a paint entry sets one or more of ${PAINT_SET_KEYS.join(", ")} (in set or at its top level)`
        );
      if (!Object.keys(selRaw).length) throw new SpecError("BAD_ARGS", "a paint entry needs select (or shape, from)");
      out.select = toPaintSelect(selRaw, shapes);
      out.set = set;
    } catch (err) {
      if (!(err instanceof SpecError)) throw err;
      out.error = { code: err.code, message: err.message };
    }
    entries.push(out);
  };
  for (const r of raw) {
    if (!isObj(r)) {
      entries.push({ label: "paint", error: { code: "BAD_ARGS", message: "a paint entry is an object" } });
      continue;
    }
    if (r.from === undefined) {
      one(r, null);
      continue;
    }
    const { from, ...rest } = r;
    const label = Array.isArray(from) ? from.join(".") : String(from);
    let got: { value: unknown; top: string };
    try {
      got = resolveFrom(root, from);
    } catch (err) {
      if (!(err instanceof SpecError)) throw err;
      entries.push({ label, error: { code: err.code, message: err.message } });
      continue;
    }
    used.add(got.top);
    // a list: one entry per element (the outer keys apply to each)
    if (Array.isArray(got.value))
      got.value.forEach((x, k) => {
        if (isObj(x)) one({ ...x, ...rest }, `${label}[${k}]`);
        else entries.push({ label: `${label}[${k}]`, error: { code: "BAD_ARGS", message: "not an object" } });
      });
    else if (isObj(got.value)) one({ ...got.value, ...rest }, label);
    else entries.push({ label, error: { code: "BAD_ARGS", message: `from '${label}' is not an object or list` } });
  }
  return { entries, used, biomes: [...biomes.values()] };
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

  // the paint list: its `from` paths and named shapes read the spec as written (keys before renames)
  const root: Record<string, unknown> = { ...(fileSpec ?? {}), ...inline };
  let paint: PaintNormalized | null = null;
  if (Array.isArray(merged.paint) && wanted("paint")) {
    const raw = (merged.paint as unknown[]).map(e =>
      isObj(e) ? dropKeys("paint", mapEntry(e, mapping.keys?.paint, mapping.values?.paint)) : e
    );
    paint = normalizePaint(raw, root, shapeIndex(root));
    merged.paint = paint.entries;
    // a top-level key the paint list reads (terrain_paint, biomes_paint) is not a list of its own
    for (const k of paint.used) {
      const to = rename(k);
      if (to !== "paint" && to !== "map" && !Object.values(LIST_TYPES).includes(typeOfList(to))) {
        delete merged[to];
        origin.delete(to);
      }
    }
    // custom biomes the paint entries define (custom:true): checked as the biomes list
    if (paint.biomes.length) {
      const listed = Array.isArray(merged.biomes) ? (merged.biomes as unknown[]) : [];
      const have = new Set(listed.map(b => (isObj(b) ? String(b.name ?? "").toLowerCase() : "")));
      const add = paint.biomes.filter(b => !have.has(String(b.name).toLowerCase()));
      if (add.length) {
        merged.biomes = [...listed, ...add];
        if (!origin.has("biomes")) origin.set("biomes", new Set(["biomes"]));
        origin.get("biomes")?.add("paint");
        notes.push(
          `custom biomes the paint list paints were checked as the biomes list: ${add.map(b => b.name).join(", ")}`
        );
      }
    }
  }
  // what the paint list sets, per type (lower-cased names): the territories it covers
  const painted = new Map<string, Set<string>>();
  for (const e of paint?.entries ?? [])
    for (const [k, v] of Object.entries(e.set ?? {}))
      if (typeof v === "string") {
        if (!painted.has(k)) painted.set(k, new Set());
        painted.get(k)?.add(v.toLowerCase());
      }
  const unpainted: string[] = [];

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
    if (type === "paint") {
      lists.push({ key, type, entries: v as Entry[] });
      continue;
    }
    const tType = TERRITORY_TYPES[key];
    const entries = (v as Entry[]).map(e => {
      const m = dropKeys(key, mapEntry(e, mapping.keys?.[key], mapping.values?.[key]));
      if (!tType || m.territory === undefined) return normalizeEntry(type, m);
      // territory is painted by the paint list, never set on the entity
      const { territory, ...rest } = m;
      const name = typeof rest.name === "string" ? rest.name : null;
      if (name && !painted.get(tType)?.has(name.toLowerCase())) {
        const sel = isObj(territory) && (territory.select !== undefined || territory.selects !== undefined);
        unpainted.push(
          `${key} '${name}' (${sel ? `has a select: paint {from:'${key}.${name}.territory', set:{${tType}:'${name}'}}` : "prose only"})`
        );
      }
      return normalizeEntry(type, rest);
    });
    lists.push({ key, type, entries });
  }
  if (unpainted.length)
    notes.push(
      `territory not painted (no paint entry sets it): ${unpainted.join("; ")}. Paint it with paint entries {select|from, set:{culture|state|religion|province}}`
    );
  for (const k of skipped)
    if (/paint/i.test(k))
      notes.push(
        `${k} is not applied by itself: paint it through the paint list, e.g. paint:[{from:'${k}'}] or {from:'${k}.<key>', set:{...}}`
      );
  lists.sort((a, b) => stageOf(a.type) - stageOf(b.type));
  return { lists, map, skipped, notes, present };
}
