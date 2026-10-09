// Provisional sketches, part 1: the operation log.
//
// While a sketch is recording, every mutating tool call appends one OpRecord. The record keeps
// the call as given (`args`) and the concrete form the bridge actually applied (`resolved`:
// ids instead of names, literal generated names, literal cell lists, the created entities'
// ids), so the ops can be replayed onto a newer copy of the base map (src/replay.ts).
//
// Calls that cannot be replayed (regenerate, generate_map, load_map, snapshot restore, a call
// that failed part-way) are still logged, with replayable:false and a reason; the sketch is
// blobOnly while one of them is in the log. Undo pops the op it undid (redo re-appends it), so
// undoing a non-replayable op makes the sketch replayable again. Stepping outside the sketch's
// own history (undo past its start, a redo of something else, a crash restore that lost ops)
// is sticky: it adds a `blocker` and the sketch stays blobOnly.
import type { HistoryEntry } from "./snapshots.ts";

/** Tools whose resolved form replay understands. */
export const REPLAYABLE_TOOLS = ["edit", "add", "paint_cells", "display", "eval"] as const;
export type ReplayableTool = (typeof REPLAYABLE_TOOLS)[number];

/**
 * Replay support for tools added after the core five. A tool module registers its spec at
 * import time (registerReplayable) instead of editing the switches here and in replay.ts.
 * The bridge function must follow the phased protocol (phase 'validate' mutates nothing and
 * returns {phase:'validate', errors?}; phase 'apply' applies and returns {resolved, ...}),
 * unless `phased` is false (then it is called once, like display).
 */
export interface ReplaySpec {
  /** Bridge FNS name replay calls. */
  bridgeFn: string;
  /** Bridge arguments for a (rewritten) resolved form; default: the resolved form as-is. */
  bridgeArgs?: (r: Resolved) => Record<string, unknown>;
  /** Map sketch-created ids through the rewriter; default: nothing to rewrite. Throws Unmapped. */
  rewrite?: (r: Resolved, rw: Rewriter) => Resolved;
  /** One plain sentence for the log. */
  summarize?: (r: Resolved | null, out: Record<string, unknown> | null, args?: unknown) => string;
  /** Why this particular resolved form cannot be replayed, or null. */
  unreplayable?: (r: Resolved | null) => string | null;
  /** Entities the op created, per op, for the replay id map (like AddResolved.created). */
  created?: (r: Resolved) => CreatedRef[][];
  /** Default true: validate then apply with phase 'apply'. */
  phased?: boolean;
  /** Timeout class for replay (default 'edit'). */
  timeout?: "edit" | "heavy";
}

export const REPLAY_EXT: Record<string, ReplaySpec> = {};

export function registerReplayable(tool: string, spec: ReplaySpec): void {
  REPLAY_EXT[tool] = spec;
}

/** Why a logged call cannot be replayed, by tool. */
export const NOT_REPLAYABLE: Record<string, string> = {
  regenerate: "regenerate re-runs random generators (states reseeds Math.random), so it cannot be replayed",
  generate_map: "generate_map replaced the whole map",
  load_map: "load_map replaced the whole map",
  snapshot: "snapshot restore jumped to a stored map",
  shared_restore: "shared_restore reloaded the shared map",
  screenshot: "screenshot keepLayers could not be recorded",
  "paint_cells:risk":
    "paint_cells height rebuild:'risk' renumbers every cell and recomputes the coastline, lakes and rivers (erosion regenerates rivers at random, burgs that end in water are dropped), so it and later literal cell lists cannot be replayed",
  "paint_cells:erase":
    "paint_cells height rebuild:'erase' regenerates every state, burg, culture, religion and province at random"
};

/**
 * Why an op with this tool and resolved form cannot be replayed, or null when it can. Used when
 * recording, when opening a saved log, and again by replay.
 */
export function unreplayableReason(tool: string, resolved: Resolved | null): string | null {
  const ext = REPLAY_EXT[tool];
  if (ext) return ext.unreplayable ? ext.unreplayable(resolved) : null;
  if (!(REPLAYABLE_TOOLS as readonly string[]).includes(tool))
    return NOT_REPLAYABLE[tool] ?? `${tool} is not replayable`;
  if (tool === "paint_cells" && resolved) {
    const h = (resolved as PaintResolved).set?.height as { rebuild?: unknown } | undefined;
    if (h && typeof h === "object") {
      const rebuild = h.rebuild ?? "keep";
      if (rebuild !== "keep")
        return (
          NOT_REPLAYABLE[`paint_cells:${String(rebuild)}`] ??
          `paint_cells height rebuild:'${String(rebuild)}' cannot be replayed`
        );
    }
  }
  return null;
}

export interface EditResolved {
  type: string;
  ops: Array<{
    ref?: number | string;
    name?: string | null;
    set?: Record<string, unknown>;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    remove?: boolean;
    /** routeGroup removal: its routes moved to `moveTo` (force). */
    force?: boolean;
    moveTo?: number | string;
    /**
     * The entity's identifying and main fields before the op (bridge identOf): replay checks
     * that the target is still the same entity (marker, route and zone ids are reused) and,
     * for a removal, that nobody changed it since.
     */
    ident?: Record<string, unknown> | null;
  }>;
  redraw?: unknown;
}

export interface CreatedRef {
  type: string;
  i: number | string;
}

export interface AddResolved {
  type: string;
  items: Array<Record<string, unknown>>;
  /** Per item: every entity the item created (the item's own type first). */
  created: CreatedRef[][];
  /** zone adds: fingerprint of the cell graph the items' literal cell lists refer to. */
  graph?: string;
  redraw?: unknown;
}

export interface PaintResolved {
  select: { cells: number[] };
  set: Record<string, unknown>;
  /** Fingerprint of the cell graph `select.cells` refers to (bridge cellGraph). */
  graph?: string;
  redraw?: unknown;
}

export interface DisplayResolved {
  on: string[];
  off: string[];
  layersPreset?: string;
  stylePreset?: string;
  styleRules?: Record<string, unknown>;
}

export interface EvalResolved {
  code: string;
  args?: unknown;
  redraw?: unknown;
}

export type Resolved = EditResolved | AddResolved | PaintResolved | DisplayResolved | EvalResolved;

export interface OpRecord {
  /** 1-based; the next op gets last.seq + 1 (an undone op's number is reused). */
  seq: number;
  tool: string;
  /** The tool arguments as given. */
  args: unknown;
  /** The concrete form applied, or null for a non-replayable op. */
  resolved: Resolved | null;
  /** One plain sentence. */
  summary: string;
  /** ISO time (Node clock). */
  at: string;
  /** Bridge digest hash of the page map before / after the call (null if unavailable). */
  digestBefore: string | null;
  digestAfter: string | null;
  replayable: boolean;
  /** Why it is not replayable. */
  reason?: string;
  /** eval: replayed verbatim; ids inside the code are not rewritten. */
  unsafe?: boolean;
  /** The call changed nothing (e.g. an eval that threw); replay drops it. */
  noop?: boolean;
  /** Node-internal: id of the auto-undo entry pushed for this call. Not meaningful once saved. */
  undoId?: number;
}

export interface SketchBase {
  kind: "shared" | "file";
  /** shared: the map id ('shared'); file: absent. */
  id?: string;
  version?: number;
  updatedBy?: string | null;
  updatedAt?: string | null;
  path?: string;
  /** When the base was taken (sketch start or the last rebase). */
  at: string;
}

export interface Sketch {
  slug: string;
  note: string | null;
  created: string;
  base: SketchBase;
  /** .map text of the base (summary screenshots of the base, counts). */
  baseText: string;
  baseCounts: Record<string, number>;
  ops: OpRecord[];
  /** Ops popped by undo, newest last; redo re-appends them. Cleared by any new undo entry. */
  redo: OpRecord[];
  recording: boolean;
  /** Sticky reasons the ops no longer describe the page from the base. */
  blockers: string[];
  /** A rebase stopped at a conflict: the page holds a partial replay. Undoing `entries` ends it. */
  suspended: { reason: string; entries: number[] } | null;
  /** The page changed after `stop` without being logged. */
  diverged: string | null;
  /** Bumped on every change to ops/base (save bookkeeping compares it). */
  rev: number;
  /** Set by sketch summary; kept for save. */
  summaryMarkdown: string | null;
  /** The rev summaryMarkdown was made at (save refreshes a stale one). */
  summaryRev?: number;
  /** Builder-2 bookkeeping (save): the rev and blob version last saved. */
  saved: { rev: number; version: number | null; at: string } | null;
  lastRebase: Record<string, unknown> | null;
}

export function blobOnlyReasons(sk: Sketch): string[] {
  const out = [...sk.blockers];
  for (const o of sk.ops) if (!o.replayable) out.push(`op ${o.seq} (${o.tool}): ${o.reason ?? "not replayable"}`);
  return out;
}

export function isBlobOnly(sk: Sketch): boolean {
  return blobOnlyReasons(sk).length > 0;
}

export class SketchStore {
  current: Sketch | null = null;

  get recording(): boolean {
    return !!this.current?.recording;
  }

  begin(init: {
    slug: string;
    note: string | null;
    base: SketchBase;
    baseText: string;
    baseCounts: Record<string, number>;
  }): Sketch {
    const sk: Sketch = {
      slug: init.slug,
      note: init.note,
      created: new Date().toISOString(),
      base: init.base,
      baseText: init.baseText,
      baseCounts: init.baseCounts,
      ops: [],
      redo: [],
      recording: true,
      blockers: [],
      suspended: null,
      diverged: null,
      rev: 0,
      summaryMarkdown: null,
      saved: null,
      lastRebase: null
    };
    this.current = sk;
    return sk;
  }

  nextSeq(): number {
    const ops = this.current?.ops ?? [];
    return ops.length ? ops[ops.length - 1].seq + 1 : 1;
  }

  /** Append a record (recording sketches only). Clears the redo list. */
  append(rec: Omit<OpRecord, "seq">): OpRecord | null {
    const sk = this.current;
    if (!sk?.recording) return null;
    const full: OpRecord = { seq: this.nextSeq(), ...rec };
    if (sk.suspended) {
      sk.blockers.push(
        `op ${full.seq} (${full.tool}) was made while the page held a stopped rebase (a partial replay), not the sketch`
      );
    }
    sk.ops.push(full);
    sk.redo = [];
    sk.rev++;
    return full;
  }

  /** Any new auto-undo entry drops the redo stack in SnapshotStore, so drop ours too. */
  onUndoPushed(): void {
    if (this.current) this.current.redo = [];
  }

  /** A mutating call that was not logged (sketch stopped). */
  noteUnlogged(tool: string): void {
    const sk = this.current;
    if (sk && !sk.recording && !sk.diverged)
      sk.diverged = `${tool} changed the page after the sketch stopped recording`;
  }

  /** After snapshot undo committed: `undone` newest first. */
  onUndo(undone: readonly HistoryEntry[]): string[] {
    const sk = this.current;
    const notes: string[] = [];
    if (!sk) return notes;
    for (const e of undone) {
      if (sk.suspended?.entries.includes(e.id)) {
        sk.suspended.entries = sk.suspended.entries.filter(x => x !== e.id);
        if (!sk.suspended.entries.length) {
          sk.suspended = null;
          notes.push(`sketch '${sk.slug}': the stopped rebase was undone; the page holds the sketch again`);
        }
        continue;
      }
      const last = sk.ops[sk.ops.length - 1];
      if (last && last.undoId === e.id) {
        sk.ops.pop();
        sk.redo.push(last);
        sk.rev++;
        notes.push(`sketch '${sk.slug}': op ${last.seq} (${last.tool}) removed from the log (redo restores it)`);
        continue;
      }
      if (!sk.recording) {
        sk.diverged ??= `undo of '${e.op}' after the sketch stopped recording`;
        continue;
      }
      const why = `undo stepped back past the start of the sketch or a rebase (undid '${e.op}' from ${e.at})`;
      sk.blockers.push(why);
      notes.push(`sketch '${sk.slug}' is now blob-only: ${why}`);
    }
    return notes;
  }

  /** After snapshot redo committed: pairs oldest first {from: redo entry id, to: new undo id}. */
  onRedo(pairs: ReadonlyArray<{ from: number; to: number }>, ops: readonly string[]): string[] {
    const sk = this.current;
    const notes: string[] = [];
    if (!sk) return notes;
    pairs.forEach(({ from, to }, k) => {
      const top = sk.redo[sk.redo.length - 1];
      if (top && top.undoId === from) {
        sk.redo.pop();
        top.undoId = to;
        sk.ops.push(top);
        sk.rev++;
        notes.push(`sketch '${sk.slug}': op ${top.seq} (${top.tool}) is back in the log`);
        return;
      }
      if (!sk.recording) {
        sk.diverged ??= `redo of '${ops[k] ?? "?"}' after the sketch stopped recording`;
        return;
      }
      const why = `redo replayed '${ops[k] ?? "?"}', which is not part of this sketch's log`;
      sk.blockers.push(why);
      notes.push(`sketch '${sk.slug}' is now blob-only: ${why}`);
    });
    return notes;
  }

  /** After a crash/relaunch restored the newest snapshot or undo point. */
  onCrashRestore(kind: "snapshot" | "undo", poppedUndoId: number | undefined, label: string): void {
    const sk = this.current;
    if (!sk) return;
    sk.redo = [];
    const last = sk.ops[sk.ops.length - 1];
    if (kind === "undo" && poppedUndoId !== undefined) {
      if (last && last.undoId === poppedUndoId) {
        sk.ops.pop();
        sk.rev++;
        return;
      }
      if (sk.suspended?.entries.includes(poppedUndoId)) {
        sk.suspended.entries = sk.suspended.entries.filter(x => x !== poppedUndoId);
        if (!sk.suspended.entries.length) sk.suspended = null;
        return;
      }
    }
    if (!sk.recording) {
      sk.diverged ??= `a browser relaunch restored ${label}`;
      return;
    }
    sk.blockers.push(`a browser relaunch restored ${label}; calls after it were lost from the page`);
  }

  /** Status object for tools. */
  view(sk: Sketch | null = this.current): Record<string, unknown> {
    if (!sk) return { active: false };
    const reasons = blobOnlyReasons(sk);
    return {
      active: true,
      slug: sk.slug,
      note: sk.note,
      recording: sk.recording,
      created: sk.created,
      base: sk.base,
      ops: sk.ops.length,
      blobOnly: reasons.length > 0,
      ...(reasons.length ? { blobOnlyReasons: reasons } : {}),
      ...(sk.suspended ? { suspended: sk.suspended.reason, suspendedUndoEntries: sk.suspended.entries.length } : {}),
      ...(sk.diverged ? { diverged: sk.diverged } : {}),
      redoAvailable: sk.redo.length,
      lastSaved: sk.saved ? { version: sk.saved.version, at: sk.saved.at } : null,
      dirty: sk.saved ? sk.saved.rev !== sk.rev : sk.ops.length > 0,
      log: sk.ops.map(o => ({
        seq: o.seq,
        tool: o.tool,
        summary: o.summary,
        ...(o.replayable ? {} : { replayable: false }),
        ...(o.unsafe ? { unsafe: true } : {})
      }))
    };
  }
}

// ---------------------------------------------------------------- saved logs

const cap = (v: unknown, n: number): string | undefined =>
  typeof v === "string" ? (v.length > n ? `${v.slice(0, n - 3)}...` : v) : undefined;

/**
 * A record read back from a saved ops.json (which any Worker caller can replace), rebuilt from
 * what replay actually uses: the tool and the resolved form. replayable, unsafe and summary are
 * recomputed, never taken from the file, so a stored record cannot hide eval code behind a
 * harmless sentence or mark a non-replayable op replayable.
 */
export function sanitizeRecord(raw: unknown, k: number): OpRecord {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const tool = typeof o.tool === "string" ? o.tool : "unknown";
  const seq = Number.isInteger(o.seq) && (o.seq as number) > 0 ? (o.seq as number) : k + 1;
  const resolved = o.resolved && typeof o.resolved === "object" ? (o.resolved as Resolved) : null;
  const noop = o.noop === true && resolved === null;
  const why = unreplayableReason(tool, resolved);
  const storedNot = o.replayable === false ? (cap(o.reason, 200) ?? "not replayable (as saved)") : null;
  const reason = noop
    ? undefined
    : (why ?? (resolved === null ? (storedNot ?? `${tool} has no resolved form`) : storedNot) ?? undefined);
  const replayable = noop || !reason;
  let summary: string;
  if (noop) summary = `${tool} changed nothing (no-op).`;
  else {
    summary = summarizeOp(tool, replayable ? resolved : null, null, o.args);
    if (!replayable) summary = `${summary} (not replayable: ${reason})`;
  }
  return {
    seq,
    tool,
    args: o.args ?? null,
    resolved: replayable ? resolved : null,
    summary,
    at: cap(o.at, 40) ?? "",
    digestBefore: cap(o.digestBefore, 64) ?? null,
    digestAfter: cap(o.digestAfter, 64) ?? null,
    replayable,
    ...(reason ? { reason } : {}),
    ...(tool === "eval" ? { unsafe: true } : {}),
    ...(noop ? { noop: true } : {})
  };
}

// ---------------------------------------------------------------- summaries (one sentence)

const q = (v: unknown): string => {
  if (typeof v === "string") return `"${v.length > 40 ? `${v.slice(0, 37)}...` : v}"`;
  const s = JSON.stringify(v) ?? "null";
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
};

function listOut(parts: string[], max = 3): string {
  if (parts.length <= max) return parts.join("; ");
  return `${parts.slice(0, max).join("; ")}; and ${parts.length - max} more`;
}

type Row = Record<string, unknown>;

/** A route's points as the bridge reports them ({n, px, ...}), or a literal list of places. */
function pointsInfo(v: unknown): { n: number; px?: number } | null {
  if (Array.isArray(v)) return { n: v.length };
  const o = v as { n?: unknown; px?: unknown } | null;
  if (o && typeof o === "object" && typeof o.n === "number")
    return { n: o.n, ...(typeof o.px === "number" ? { px: o.px } : {}) };
  return null;
}

/** "before -> after" for one edited field; a route's points read as counts and lengths ("3 -> 2 (123.4 -> 80 px)"). */
function changeText(before: unknown, after: unknown): string {
  const b = pointsInfo(before);
  const a = pointsInfo(after);
  if (b && a) return `${b.n} -> ${a.n}${b.px !== undefined && a.px !== undefined ? ` (${b.px} -> ${a.px} px)` : ""}`;
  return `${q(before)} -> ${q(after)}`;
}

/** The value an edit set when the op recorded no before/after: a points list reads "N places". */
const setText = (v: unknown): string => {
  const p = pointsInfo(v);
  return p ? `${p.n} places` : q(v);
};

/** One sentence for a recorded call, from the resolved form and the bridge's result rows. */
export function summarizeOp(tool: string, resolved: Resolved | null, out: Row | null, args?: unknown): string {
  try {
    switch (tool) {
      case "edit": {
        const r = resolved as EditResolved;
        const parts = r.ops.map(o => {
          const who = r.type === "map" ? "the map" : `${r.type} ${o.name ? `${q(o.name)} ` : ""}(${o.ref})`;
          if (o.remove) {
            // a route group removed with force: its routes moved to moveTo
            const held = Number((o.ident as { routes?: unknown } | null | undefined)?.routes ?? 0);
            return o.force && o.moveTo !== undefined
              ? `removed ${who} (${held ? `${held} route${held === 1 ? "" : "s"} ` : ""}moved to ${o.moveTo})`
              : `removed ${who}`;
          }
          const fields = Object.keys(o.set ?? {}).map(k =>
            o.before && o.after && k in o.before
              ? `${k} ${changeText(o.before[k], o.after[k])}`
              : `${k} ${setText(o.set?.[k])}`
          );
          return `${who}: ${fields.join(", ")}`;
        });
        return `Edited ${listOut(parts)}.`;
      }
      case "add": {
        const r = resolved as AddResolved;
        const rows = (out?.created as Row[] | undefined) ?? [];
        const parts = r.items.map((it, k) => {
          const row = rows[k] ?? {};
          const name = (row.name as string | undefined) ?? (it.name as string | undefined);
          const pts = (it.points ?? it.through) as unknown[] | undefined;
          const extra = r.type === "route" && pts ? ` ${it.noPathfind ? "along" : "through"} ${pts.length} places` : "";
          return `${r.type} ${name ? `${q(name)} ` : ""}(${row.i ?? r.created[k]?.[0]?.i ?? "?"})${extra}`;
        });
        return `Added ${listOut(parts)}.`;
      }
      case "paint_cells": {
        const r = resolved as PaintResolved;
        const set = (out?.set as Row | undefined) ?? {};
        const parts = Object.keys(r.set).map(k => {
          const res = set[k] as Row | undefined;
          const changed = res && typeof res.changed === "number" ? ` (${res.changed} changed)` : "";
          return `${k} -> ${q(r.set[k])}${changed}`;
        });
        return `Painted ${r.select.cells.length} selected cells: ${parts.join(", ")}.`;
      }
      case "display": {
        const r = resolved as DisplayResolved;
        const parts: string[] = [];
        if (r.layersPreset) parts.push(`layers preset ${q(r.layersPreset)}`);
        else {
          if (r.on.length) parts.push(`on ${r.on.join(", ")}`);
          if (r.off.length) parts.push(`off ${r.off.join(", ")}`);
        }
        if (r.stylePreset) parts.push(`style ${q(r.stylePreset)}`);
        if (r.styleRules) parts.push(`style rules for ${Object.keys(r.styleRules).join(", ")}`);
        return `Display: ${parts.join("; ") || "no change"}.`;
      }
      case "eval": {
        const r = resolved as EvalResolved;
        const code = r.code.replace(/\s+/g, " ").trim();
        return `Ran eval (unsafe, replayed verbatim): ${code.length > 80 ? `${code.slice(0, 77)}...` : code}`;
      }
      default: {
        const ext = REPLAY_EXT[tool];
        if (ext?.summarize) return ext.summarize(resolved, out, args);
        let a = "";
        try {
          a = JSON.stringify(args) ?? "";
        } catch {
          a = "";
        }
        return `${tool} ${a.length > 80 ? `${a.slice(0, 77)}...` : a}`.trim();
      }
    }
  } catch {
    return `${tool} (no summary)`;
  }
}

// ---------------------------------------------------------------- id map and rewriting

/** {type -> {sketchId -> replayId}} for entities created during the sketch. Keys are strings. */
export type IdMap = Record<string, Record<string, number | string>>;

export class Unmapped extends Error {
  readonly type: string;
  readonly id: number | string;
  constructor(type: string, id: number | string) {
    super(`depends on ${type} ${id}, which the sketch created in an op that was not applied`);
    this.type = type;
    this.id = id;
  }
}

/** The entities one op created (as "type:id"). */
export function createdBy(o: OpRecord): string[] {
  if (!o.resolved) return [];
  const ext = REPLAY_EXT[o.tool];
  const lists =
    o.tool === "add" ? ((o.resolved as AddResolved).created ?? []) : ext?.created ? ext.created(o.resolved) : [];
  const out: string[] = [];
  for (const list of lists) for (const c of list) out.push(`${c.type}:${c.i}`);
  return out;
}

/** Every entity created by the ops (as "type:id"). */
export function createdSet(ops: readonly OpRecord[]): Set<string> {
  const s = new Set<string>();
  for (const o of ops) for (const k of createdBy(o)) s.add(k);
  return s;
}

/** Note ids embed their owner's id; prefix -> entity type. */
const NOTE_PREFIX: Array<[string, string]> = [
  ["stateLabel", "state"],
  ["province", "province"],
  ["marker", "marker"],
  ["burg", "burg"],
  ["route", "route"],
  ["river", "river"]
];

export class Rewriter {
  readonly idMap: IdMap;
  readonly created: Set<string>;
  constructor(idMap: IdMap, created: Set<string>) {
    this.idMap = idMap;
    this.created = created;
  }

  id(type: string, ref: unknown): unknown {
    if (type === "note" && typeof ref === "string") return this.noteId(ref);
    if (typeof ref !== "number" && typeof ref !== "string") return ref;
    const key = `${type}:${ref}`;
    if (!this.created.has(key)) return ref;
    const m = this.idMap[type]?.[String(ref)];
    if (m === undefined) throw new Unmapped(type, ref);
    return m;
  }

  noteId(id: string): string {
    for (const [prefix, type] of NOTE_PREFIX) {
      const m = new RegExp(`^${prefix}(\\d+)$`).exec(id);
      if (m) return `${prefix}${this.id(type, Number(m[1]))}`;
    }
    return id;
  }

  place(p: unknown): unknown {
    if (!p || typeof p !== "object") return p;
    const o = p as { entity?: { type: string; ref: unknown } };
    if (!o.entity) return p;
    return { ...o, entity: { type: o.entity.type, ref: this.id(o.entity.type, o.entity.ref) } };
  }
}

/** Which edit fields hold refs (type) or places, per entity type. */
export const EDIT_REF_FIELDS: Record<string, Record<string, string>> = {
  burg: { culture: "culture", move: "@place" },
  state: { capital: "burg", culture: "culture" },
  province: { capital: "burg" },
  marker: { move: "@place" },
  label: { move: "@place" },
  route: { points: "@places", group: "routeGroup" },
  routeGroup: { after: "routeGroup", before: "routeGroup" }
};

export const ADD_REF_FIELDS: Record<string, Record<string, string>> = {
  burg: { at: "@place", culture: "culture" },
  state: { capital: "@capital", culture: "culture" },
  marker: { at: "@place" },
  route: { through: "@places", points: "@places", group: "routeGroup" },
  routeGroup: { after: "routeGroup", before: "routeGroup" },
  label: { at: "@place" },
  note: { entity: "@entity", id: "@noteId" },
  culture: { at: "@place" },
  religion: { at: "@place" }
};

export function rewriteField(rw: Rewriter, kind: string, v: unknown): unknown {
  switch (kind) {
    case "@place":
      return rw.place(v);
    case "@places":
      return Array.isArray(v) ? v.map(p => rw.place(p)) : v;
    case "@capital": {
      if (v && typeof v === "object" && "burg" in (v as Record<string, unknown>))
        return { burg: rw.id("burg", (v as { burg: unknown }).burg) };
      return rw.place(v);
    }
    case "@entity": {
      const e = v as { type: string; ref: unknown };
      return e && typeof e === "object" ? { type: e.type, ref: rw.id(e.type, e.ref) } : v;
    }
    case "@noteId":
      return typeof v === "string" ? rw.noteId(v) : v;
    default:
      return rw.id(kind, v);
  }
}

/** A copy of `resolved` with every sketch-created id mapped through the id map. Throws Unmapped. */
export function rewriteResolved(tool: string, resolved: Resolved, rw: Rewriter): Resolved {
  const r = structuredClone(resolved) as unknown as Record<string, unknown>;
  switch (tool) {
    case "edit": {
      const e = r as unknown as EditResolved;
      const fields = EDIT_REF_FIELDS[e.type] ?? {};
      for (const o of e.ops) {
        if (o.ref !== undefined) o.ref = rw.id(e.type, o.ref) as number | string;
        if (o.moveTo !== undefined && e.type === "routeGroup") o.moveTo = rw.id("routeGroup", o.moveTo) as string;
        for (const [k, kind] of Object.entries(fields))
          if (o.set && k in o.set) o.set[k] = rewriteField(rw, kind, o.set[k]);
        // before/after hold the same fields as get() returns them (e.g. a capital burg id)
        for (const side of [o.before, o.after])
          if (side)
            for (const [k, kind] of Object.entries(fields))
              if (k in side && !kind.startsWith("@")) side[k] = rw.id(kind, side[k]);
      }
      return e;
    }
    case "add": {
      const a = r as unknown as AddResolved;
      const fields = ADD_REF_FIELDS[a.type] ?? {};
      for (const it of a.items)
        for (const [k, kind] of Object.entries(fields)) if (k in it) it[k] = rewriteField(rw, kind, it[k]);
      return a;
    }
    case "paint_cells": {
      const p = r as unknown as PaintResolved;
      for (const k of ["state", "province", "culture", "religion"]) if (k in p.set) p.set[k] = rw.id(k, p.set[k]);
      const z = p.set.zone as { ref: unknown; op?: string } | undefined;
      if (z) p.set.zone = { ...z, ref: rw.id("zone", z.ref) };
      return p;
    }
    default: {
      const ext = REPLAY_EXT[tool];
      return ext?.rewrite ? ext.rewrite(r as unknown as Resolved, rw) : (r as unknown as Resolved);
    }
  }
}

/**
 * Pair what an add created at record time with what the replayed add created, by type and
 * order, into the id map. Returns entities that could not be paired.
 */
export function pairCreated(idMap: IdMap, sketch: CreatedRef[][], replay: CreatedRef[][]): CreatedRef[] {
  const unpaired: CreatedRef[] = [];
  sketch.forEach((list, k) => {
    const got = replay[k] ?? [];
    const byType = new Map<string, Array<number | string>>();
    for (const c of got) byType.set(c.type, [...(byType.get(c.type) ?? []), c.i]);
    const used = new Map<string, number>();
    for (const c of list) {
      const n = used.get(c.type) ?? 0;
      const ids = byType.get(c.type) ?? [];
      if (n < ids.length) {
        idMap[c.type] ??= {};
        idMap[c.type][String(c.i)] = ids[n];
        used.set(c.type, n + 1);
      } else unpaired.push(c);
    }
  });
  return unpaired;
}

/** Strip `resolved` from a bridge result (it goes to the log, not to the client). */
export function takeResolved(out: Record<string, unknown>): Resolved | null {
  const r = out.resolved as Resolved | undefined;
  delete out.resolved;
  return r ?? null;
}
