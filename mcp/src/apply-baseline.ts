// apply baseline: accepted departures from a spec. Pure functions over the page's check rows
// (bridge-ext/apply.js shapeRow), so test/applyalias.test.ts checks them without a browser.
//
// A baseline is a list of items, one per difference a check reported:
//   {list, key, field, have, want, ...the diff's other keys (px, add, remove, cells, ...)}
//   {list, key, status:'missing'} | {list, key, status:'error', error:{code, message, field?}}
// list is the row's list ('burgs', 'rivers.note', 'paint', 'map'); key the entry's key (its
// name, a note id; a paint entry's label + a hash of its select/set, from the caller's keyOf; a
// `<list>[k].note` row without one takes its entry's). Cell-set diffs (zone cells, paint) carry a
// sig, a hash of which cells differ, so a drift that keeps the counts still shows.
// A later check drops every difference whose item is in the baseline (the same key and field and
// the same values: one that changed since is reported again) and counts them as `baselined`.
import fs from "node:fs";
import { ToolError } from "./result.ts";

export interface BaselineItem {
  list: string;
  key: string;
  field?: string;
  status?: string;
  [k: string]: unknown;
}

export interface Baseline {
  kind: "tupaia-apply-baseline";
  version: 1;
  created?: string;
  specPath?: string;
  items: BaselineItem[];
}

/** A page row (apply.js shapeRow). */
export interface CheckRow {
  at: string;
  key?: unknown;
  i?: unknown;
  name?: string;
  status: string;
  diffs?: Array<Record<string, unknown>>;
  error?: unknown;
  [k: string]: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** JSON with object keys sorted (at every depth): equal values give equal text. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v))
    return `{${Object.keys(v)
      .filter(k => v[k] !== undefined)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** "burgs[3].note" -> "burgs.note" (as the result's lists count it). */
export const listOfAt = (at: string): string => at.replace(/\[\d+\]/, "");

/** A row's own baseline key when the caller has one (paint entries: label + entry hash). */
export type KeyOf = (r: CheckRow) => string | undefined;

/**
 * The entity key of each row: keyOf's, else its key, else its entry's (`x[k].note` rows), else
 * its name or list.
 */
function rowKeys(rows: CheckRow[], keyOf?: KeyOf): string[] {
  const byAt = new Map<string, CheckRow>();
  for (const r of rows) byAt.set(r.at, r);
  return rows.map(r => {
    const own = keyOf?.(r);
    if (own !== undefined) return own;
    if (r.key !== undefined && r.key !== null) return String(r.key);
    const parent = /^(.*\[\d+\])\.\w+$/.exec(r.at)?.[1];
    const p = parent ? byAt.get(parent) : undefined;
    const pOwn = p ? keyOf?.(p) : undefined;
    if (pOwn !== undefined) return pOwn;
    if (p?.key !== undefined && p.key !== null) return String(p.key);
    return r.name ?? listOfAt(r.at);
  });
}

/** The accepted-difference items of one row (none for unchanged, created, updated). */
function itemsOf(r: CheckRow, key: string): BaselineItem[] {
  const list = listOfAt(r.at);
  if (r.status === "error") return [{ list, key, status: "error", error: r.error ?? null }];
  if (r.status === "missing") return [{ list, key, status: "missing" }];
  if (r.status === "differs") return (r.diffs ?? []).map(d => ({ list, key, ...d }) as BaselineItem);
  return [];
}

/** The baseline of a check's rows: every difference, missing entry and error it reports. */
export function baselineOf(rows: CheckRow[], meta: { specPath?: string; keyOf?: KeyOf } = {}): Baseline {
  const keys = rowKeys(rows, meta.keyOf);
  const items = rows.flatMap((r, k) => itemsOf(r, keys[k]));
  return {
    kind: "tupaia-apply-baseline",
    version: 1,
    created: new Date().toISOString(),
    ...(meta.specPath ? { specPath: meta.specPath } : {}),
    items
  };
}

export interface Filtered {
  rows: CheckRow[];
  /** Differences (items) the baseline accepted. */
  baselined: number;
  /** Baseline items no longer reported (fixed, or their values changed) in the lists checked. */
  stale: BaselineItem[];
  /** Baseline items of lists this check did not run (opts.checked): neither accepted nor stale. */
  notChecked: number;
}

/**
 * Drop the accepted differences from check rows. A row whose every item is accepted becomes
 * status 'accepted' (no diffs); a differs row keeps only its new diffs. Items match as a multiset
 * (two identical differences need two identical items).
 */
export function filterBaseline(
  rows: CheckRow[],
  baseline: Baseline,
  opts: { keyOf?: KeyOf; checked?: Set<string> } = {}
): Filtered {
  const left = new Map<string, BaselineItem[]>();
  for (const it of baseline.items) {
    const c = canonical(it);
    const l = left.get(c);
    if (l) l.push(it);
    else left.set(c, [it]);
  }
  const take = (it: BaselineItem): boolean => {
    const l = left.get(canonical(it));
    if (!l?.length) return false;
    l.pop();
    return true;
  };
  const keys = rowKeys(rows, opts.keyOf);
  let baselined = 0;
  const out = rows.map((r, k) => {
    const items = itemsOf(r, keys[k]);
    if (!items.length) return r;
    if (r.status === "differs") {
      const diffs = (r.diffs ?? []).filter((_, j) => !take(items[j]));
      baselined += items.length - diffs.length;
      if (diffs.length === items.length) return r;
      if (!diffs.length) {
        const { diffs: _d, ...rest } = r;
        return { ...rest, status: "accepted" };
      }
      return { ...r, diffs };
    }
    if (!take(items[0])) return r;
    baselined++;
    const { diffs: _d, error: _e, note: _n, ...rest } = r;
    return { ...rest, status: "accepted" };
  });
  const rest = [...left.values()].flat();
  const checked = opts.checked;
  const stale = checked ? rest.filter(it => checked.has(it.list)) : rest;
  return { rows: out, baselined, stale, notChecked: rest.length - stale.length };
}

/** Read and check a baseline file (or an inline object). */
export function readBaseline(v: unknown, from: string): Baseline {
  let b: unknown = v;
  if (typeof v === "string") {
    try {
      b = JSON.parse(fs.readFileSync(v, "utf8"));
    } catch (e) {
      throw new ToolError("BAD_ARGS", `baseline ${v} is not JSON: ${(e as Error).message}`);
    }
  }
  if (!isObj(b) || !Array.isArray(b.items) || !b.items.every(it => isObj(it) && typeof it.list === "string"))
    throw new ToolError(
      "BAD_ARGS",
      `baseline ${from} is not an apply baseline ({items:[{list, key, field?, ...}]}; write one with mode:'baseline')`
    );
  return b as unknown as Baseline;
}

/** A short label for a stale item: "markers 'X' size". */
export function itemLabel(it: BaselineItem): string {
  return `${it.list} '${it.key}' ${it.field ?? it.status ?? ""}`.trim();
}
