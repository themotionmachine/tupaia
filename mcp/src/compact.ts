// Token savers: plain-text formats for find and inspect, entity-type counts and compact lists for
// map diffs, and the pixel-to-map conversion for changed-region screenshots. Everything here is a
// pure function over the bridge's JSON results, so it is unit-tested without a browser.
//
// Compact text conventions (find rows and inspect lines):
//   - one `key=value` pair per field; a key whose value is false, null or empty is left out
//     (absent = false/null/empty), a true boolean is written as a bare flag (`capital`)
//   - strings with spaces, `=`, `,` or quotes are JSON-quoted; long strings are cut with an ellipsis
//   - `population` is written `pop`; x, y are written `at=(x,y)` rounded to whole map px

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

const MAX_STR = 80;
/** Char budget for an inline array in a compact line before it is cut with `…(+N)`. */
const MAX_ARRAY_CHARS = 240;
/** inspect: arrays longer than this are shown as `[N items]` (the JSON format has them whole). */
const MAX_INLINE_ITEMS = 12;
/** inspect: a flat object with more keys than this is shown as its key list, not as dotted lines. */
const MAX_FLAT_KEYS = 8;

const KEY_ALIAS: Record<string, string> = { population: "pop" };
const aliasKey = (k: string): string => KEY_ALIAS[k] ?? k;

function round(n: number, digits = 3): number {
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

function cut(s: string, max = MAX_STR): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A string value: bare when it has no separators, JSON-quoted otherwise. */
function fmtString(s: string): string {
  const t = cut(s.replace(/\s+/g, " "));
  return t === "" || /[\s=,"]/.test(t) ? JSON.stringify(t) : t;
}

function fmtScalar(v: unknown): string {
  if (typeof v === "number") return Number.isFinite(v) ? String(round(v)) : "null";
  if (typeof v === "string") return fmtString(v);
  if (typeof v === "boolean") return String(v);
  return String(v);
}

/** Inline array of items already rendered to strings, cut to a char budget. */
function joinCapped(items: string[], sep = ","): string {
  let used = 0;
  const kept: string[] = [];
  for (const it of items) {
    if (kept.length && used + it.length + 1 > MAX_ARRAY_CHARS) break;
    kept.push(it);
    used += it.length + 1;
  }
  const rest = items.length - kept.length;
  return `[${kept.join(sep)}${rest > 0 ? `${sep}…(+${rest})` : ""}]`;
}

/** Whether a value counts as present in compact output. */
function present(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

// ---------------------------------------------------------------------------------- find

interface FindResult {
  type?: string;
  total?: number;
  offset?: number;
  returned?: number;
  matchedBy?: string | null;
  near?: { x: number; y: number; cell?: number };
  rows?: Obj[];
}

const POSITION_KEYS = new Set(["x", "y", "lat", "lon"]);
const ROW_SKIP = new Set(["i", "name", "distance", ...POSITION_KEYS]);

/** A `<base>Name` key paired with a numeric `<base>` is the ref's display name, not a field. */
function refNameOf(row: Obj, key: string): string | null {
  if (!key.endsWith("Name") || key.length <= 4) return null;
  const base = key.slice(0, -4);
  return typeof row[base] === "number" && typeof row[key] === "string" ? base : null;
}

function fmtValue(v: unknown): string {
  if (Array.isArray(v)) return joinCapped(v.map(x => (isObj(x) ? cut(JSON.stringify(x)) : fmtScalar(x))));
  if (isObj(v)) return cut(JSON.stringify(v));
  return fmtScalar(v);
}

/** One find row: `burg 12 Agamathel pop=61419 state=3 capital at=(812,440)`. */
function findLine(type: string, row: Obj): string {
  const name = row.name === null || row.name === undefined || row.name === "" ? "" : String(row.name);
  const parts: string[] = [type, String(row.i)];
  if (name) parts.push(/[="]/.test(name) ? JSON.stringify(name) : name.replace(/\s+/g, " "));
  for (const [k, v] of Object.entries(row)) {
    if (ROW_SKIP.has(k) || refNameOf(row, k)) continue;
    // a burg's port is a feature id; 0 means no port
    if (k === "port" && v === 0) continue;
    if (!present(v)) continue;
    parts.push(v === true ? aliasKey(k) : `${aliasKey(k)}=${fmtValue(v)}`);
  }
  if (typeof row.distance === "number") parts.push(`dist=${round(row.distance, 1)}`);
  if (typeof row.x === "number" && typeof row.y === "number")
    parts.push(`at=(${Math.round(row.x)},${Math.round(row.y)})`);
  return parts.join(" ");
}

/**
 * Plain-text form of a find result: a header line, one line per row, a legend of the entity
 * names behind the id-valued fields (each id once), and a paging line when more rows exist.
 */
export function compactFind(r: FindResult): string {
  const type = r.type ?? "?";
  const rows = r.rows ?? [];
  const total = r.total ?? rows.length;
  const offset = r.offset ?? 0;
  const head = [`${type}: ${rows.length} of ${total}`];
  if (offset) head.push(`offset=${offset}`);
  if (r.matchedBy) head.push(`matched=${r.matchedBy}`);
  if (r.near) head.push(`near=(${Math.round(r.near.x)},${Math.round(r.near.y)})`);
  const lines = [head.join(" ")];
  const legend = new Map<string, Map<number, string>>();
  for (const row of rows) {
    lines.push(findLine(type, row));
    for (const k of Object.keys(row)) {
      const base = refNameOf(row, k);
      // a port's name is just its water body's kind ("ocean"): not worth a legend entry
      if (!base || base === "port") continue;
      const m = legend.get(base) ?? new Map<number, string>();
      m.set(row[base] as number, cut(String(row[k]), 40));
      legend.set(base, m);
    }
  }
  if (legend.size) {
    const groups = [...legend].map(
      ([base, m]) =>
        `${aliasKey(base)} ${[...m].map(([id, nm]) => `${id}=${/[;,]/.test(nm) ? JSON.stringify(nm) : nm}`).join(", ")}`
    );
    lines.push(`names: ${groups.join("; ")}`);
  }
  const shown = offset + rows.length;
  if (total > shown) lines.push(`+${total - shown} more (offset=${shown})`);
  return lines.join("\n");
}

// -------------------------------------------------------------------------------- inspect

/** An `{i, name?, ...scalars}` object (a ref, a feature stub): `3 (Ilmar)` or `23 type=island`. */
function isRefLike(v: unknown): v is Obj {
  if (!isObj(v) || !("i" in v) || (typeof v.i !== "number" && typeof v.i !== "string")) return false;
  return Object.values(v).every(x => x === null || ["string", "number", "boolean"].includes(typeof x));
}

function refText(o: Obj): string {
  let s = String(o.i);
  const nm = o.name;
  if (typeof nm === "string" && nm !== "") s += ` (${cut(nm.replace(/\s+/g, " "), 40)})`;
  for (const [k, v] of Object.entries(o)) {
    if (k === "i" || k === "name" || !present(v)) continue;
    s += v === true ? ` ${k}` : ` ${k}=${fmtScalar(v)}`;
  }
  return s;
}

/** Text value for a nested structure: refs and primitive arrays inline, anything deeper as a shape. */
function shapeText(v: unknown): string {
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    if (v.length > MAX_INLINE_ITEMS * (v.every(isRefLike) ? 2 : 1)) return `[${v.length} items]`;
    if (v.every(isRefLike))
      return joinCapped(
        v.map(x => refText(x as Obj)),
        ", "
      );
    if (v.every(x => x === null || typeof x !== "object")) return joinCapped(v.map(fmtScalar));
    return `[${v.length} items]`;
  }
  if (isObj(v)) {
    const keys = Object.keys(v);
    return `{${keys.slice(0, 6).join(",")}${keys.length > 6 ? `,…(+${keys.length - 6})` : ""}}`;
  }
  return fmtScalar(v);
}

/** key=value lines of an object: scalars as is, refs as `3 (Name)`, flat objects dotted, the rest as a shape. */
function kvLines(o: Obj, skip: Set<string>, only: Set<string> | null, prefix = "", depth = 0): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (skip.has(k) || (only && !only.has(k)) || !present(v)) continue;
    const key = `${prefix}${k}`;
    if (isRefLike(v)) out.push(`${key}=${refText(v)}`);
    else if (
      isObj(v) &&
      depth === 0 &&
      Object.keys(v).length <= MAX_FLAT_KEYS &&
      Object.values(v).every(x => x === null || typeof x !== "object")
    ) {
      // one level of flat object: dotted keys (population.rural=..)
      out.push(...kvLines(v, new Set(), null, `${key}.`, 1));
    } else if (v === true) out.push(key);
    else if (Array.isArray(v) || isObj(v)) out.push(`${key}=${shapeText(v)}`);
    else out.push(`${key}=${fmtScalar(v)}`);
  }
  return out;
}

interface InspectResult extends Obj {
  kind?: string;
  type?: string;
  i?: unknown;
  name?: unknown;
  x?: number;
  y?: number;
  lat?: number;
  lon?: number;
  cell?: number;
  entity?: Obj;
  relations?: Obj;
}

/**
 * key=value lines for an inspect result. An entity: a header, then `[entity]` and `[relations]`
 * sections. A place: a header, then one line per cell attribute. `only` limits the entity and
 * relation keys (and the place's attributes) to the named fields.
 */
export function compactInspect(r: InspectResult, only?: string[]): string {
  const want = only?.length ? new Set(only) : null;
  if (r.kind === "place" || (!r.entity && !r.type)) {
    const head = ["place"];
    if (typeof r.x === "number" && typeof r.y === "number") head.push(`at=(${round(r.x, 1)},${round(r.y, 1)})`);
    if (r.cell !== undefined) head.push(`cell=${r.cell}`);
    if (typeof r.lat === "number") head.push(`lat=${r.lat}`, `lon=${r.lon}`);
    const skip = new Set(["kind", "x", "y", "cell", "lat", "lon", "via"]);
    return [head.join(" "), ...kvLines(r, skip, want)].join("\n");
  }
  const head = [String(r.type ?? "entity"), String(r.i)];
  if (typeof r.name === "string" && r.name) {
    const nm = r.name.replace(/\s+/g, " ");
    head.push(/[="]/.test(nm) ? JSON.stringify(nm) : nm);
  }
  if (typeof r.x === "number" && typeof r.y === "number") head.push(`at=(${r.x},${r.y})`);
  if (typeof r.lat === "number") head.push(`lat=${r.lat}`, `lon=${r.lon}`);
  if (r.cell !== undefined) head.push(`cell=${r.cell}`);
  const lines = [head.join(" ")];
  // the header already carries these
  const dup = new Set(["i", "name", "x", "y", "cell"]);
  const ent = r.entity ? kvLines(r.entity, dup, want) : [];
  if (ent.length) lines.push("[entity]", ...ent);
  const rel = r.relations ? kvLines(r.relations, new Set(), want) : [];
  if (rel.length) lines.push("[relations]", ...rel);
  return lines.join("\n");
}

// --------------------------------------------------------------------------- diff changes

interface TypeChanges {
  counts?: { added?: number; removed?: number; modified?: number };
  added?: unknown[];
  removed?: unknown[];
  modified?: unknown[];
}

export interface CountRow {
  added: number;
  removed: number;
  changed: number;
}

/**
 * map_info {diff:'counts'}: `{burg:{added, removed, changed}, ...}` per entity type, plus
 * `cells:{<array>: differing cells}` for the cell arrays. The input is the bridge diff's
 * `changes`; its counts are exact even when its lists are capped.
 */
export function countChanges(changes: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [type, v] of Object.entries(changes ?? {})) {
    if (type === "cells") {
      out.cells = v;
      continue;
    }
    const c = (v as TypeChanges).counts ?? {};
    out[type] = { added: c.added ?? 0, removed: c.removed ?? 0, changed: c.modified ?? 0 } satisfies CountRow;
  }
  return out;
}

/** Up to this many listed changes across all types a mutating tool returns them in full. */
export const CHANGES_FULL_MAX = 8;
/** Larger diffs keep this many entries per list (counts stay exact). */
export const CHANGES_SAMPLE = 3;

const LISTS = ["added", "removed", "modified"] as const;

/**
 * The `changes` a mutating tool returns: as the bridge diff when small, else per type the exact
 * `counts`, the first CHANGES_SAMPLE entries of each list and `more:{list: n}` for the rest.
 * `cells` (already counts) passes through. map_info lists everything.
 */
export function compactChanges(changes: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!changes) return changes;
  let total = 0;
  for (const [type, v] of Object.entries(changes)) {
    if (type === "cells") continue;
    const c = (v as TypeChanges).counts;
    total += (c?.added ?? 0) + (c?.removed ?? 0) + (c?.modified ?? 0);
  }
  if (total <= CHANGES_FULL_MAX) return changes;
  const out: Record<string, unknown> = {};
  for (const [type, v] of Object.entries(changes)) {
    if (type === "cells") {
      out.cells = v;
      continue;
    }
    const t = v as TypeChanges;
    const o: Record<string, unknown> = { counts: t.counts };
    const more: Record<string, number> = {};
    for (const list of LISTS) {
      const items = t[list] ?? [];
      if (items.length) o[list] = items.slice(0, CHANGES_SAMPLE);
      const rest = (t.counts?.[list] ?? items.length) - Math.min(items.length, CHANGES_SAMPLE);
      if (rest > 0) more[list] = rest;
    }
    if (Object.keys(more).length) o.more = more;
    out[type] = o;
  }
  return out;
}

// ------------------------------------------------------------------------------- crop maths

export interface CropView {
  full: boolean;
  /** Size of the captured PNG in pixels. */
  pngW: number;
  pngH: number;
  /** CSS size of the captured area (svg viewport; graph size for full shots). */
  cssW: number;
  cssH: number;
  graphWidth: number;
  graphHeight: number;
  /** View transform (map px -> css px). */
  x: number;
  y: number;
  scale: number;
}

/** Map px of a pixel position in the saved PNG (the inverse of the bridge's screenToMap, on the PNG). */
export function pngToMap(px: number, py: number, v: CropView): [number, number] {
  if (v.full) return [(px * v.graphWidth) / v.pngW, (py * v.graphHeight) / v.pngH];
  const cx = (px * v.cssW) / v.pngW;
  const cy = (py * v.cssH) / v.pngH;
  return [(cx - v.x) / v.scale, (cy - v.y) / v.scale];
}

/** PNG pixels per map px (for turning a pad in map px into PNG px). */
export function pngPerMap(v: CropView): number {
  return v.full ? v.pngW / v.graphWidth : (v.scale * v.pngW) / v.cssW;
}

/** [x0,y0,x1,y1] in PNG px -> map px, one decimal. */
export function boxToMap(box: [number, number, number, number], v: CropView): [number, number, number, number] {
  const [ax, ay] = pngToMap(box[0], box[1], v);
  const [bx, by] = pngToMap(box[2], box[3], v);
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return [r1(Math.min(ax, bx)), r1(Math.min(ay, by)), r1(Math.max(ax, bx)), r1(Math.max(ay, by))];
}
