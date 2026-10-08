// Provisional sketches, part 2: the replay engine.
//
// replayOps applies a sketch's ops log, in order, to whatever map is in the page, through the
// same bridge functions the tools use (edit, add, paint, display, evalUser), using each op's
// resolved form. Entities the sketch created get new ids in the target map; the id map
// {type -> {sketchId -> replayId}} collects them and every later op is rewritten through it.
//
// Per op: rewrite ids -> validate in the page (a missing or removed target, an occupied cell, a
// NO_PATH ... is a conflict) -> for edits, the both-changed check (base value recorded at sketch
// time vs the value now; if the sketch and someone else both changed a field, that is a
// conflict 'both changed <field>') -> push an auto-undo entry -> apply. onConflict 'stop'
// (default) stops at the first conflict and leaves the page there; 'skip' records it and goes
// on. A failure while APPLYING (after validation passed) always stops: the page may hold half
// of that op, and its undo entry reverts it.
import type { CallScope, ToolContext } from "./context.ts";
import {
  type AddResolved,
  createdSet,
  type DisplayResolved,
  type EditResolved,
  type EvalResolved,
  type IdMap,
  type OpRecord,
  type PaintResolved,
  pairCreated,
  type Resolved,
  Rewriter,
  rewriteResolved,
  summarizeOp,
  takeResolved,
  Unmapped
} from "./ops.ts";
import { TIMEOUTS } from "./schemas.ts";

export interface ReplayConflict {
  seq: number;
  reason: string;
  op: OpRecord;
}

export interface ReplayResult {
  /** seqs applied, in order. */
  applied: number[];
  /** seqs skipped because of a conflict (onConflict 'skip'). */
  skipped: number[];
  /** seqs dropped because they were logged no-ops. */
  noops: number[];
  conflicts: ReplayConflict[];
  idMap: IdMap;
  /** The applied ops as new records (resolved as applied to the target, undoId set). */
  records: OpRecord[];
  /** true when a conflict (stop) or an apply failure ended the replay early. */
  stopped: boolean;
  /** Auto-undo entry ids pushed, oldest first (one per applied op). */
  undoEntries: number[];
  notes: string[];
}

const BRIDGE_FN: Record<string, string> = {
  edit: "edit",
  add: "add",
  paint_cells: "paint",
  display: "display",
  eval: "evalUser"
};

interface ErrRow {
  index?: number;
  code: string;
  message: string;
}

function errText(e: ErrRow): string {
  return `${e.index !== undefined ? `item ${e.index}: ` : ""}${e.code}: ${e.message}`;
}

/** Bridge arguments for an op's (rewritten) resolved form. */
export function bridgeArgs(tool: string, r: Resolved): Record<string, unknown> {
  const withRedraw = (o: Record<string, unknown>, redraw: unknown) => (redraw !== undefined ? { ...o, redraw } : o);
  switch (tool) {
    case "edit": {
      const e = r as EditResolved;
      const ops = e.ops.map(o => {
        if (o.remove) return { ref: o.ref, remove: true };
        return o.ref === undefined ? { set: o.set } : { ref: o.ref, set: o.set };
      });
      return withRedraw({ type: e.type, ops }, e.redraw);
    }
    case "add": {
      const a = r as AddResolved;
      return withRedraw({ type: a.type, items: a.items }, a.redraw);
    }
    case "paint_cells": {
      const p = r as PaintResolved;
      return withRedraw({ select: p.select, set: p.set }, p.redraw);
    }
    case "display": {
      const d = r as DisplayResolved;
      const out: Record<string, unknown> = { on: d.on, off: d.off };
      if (d.layersPreset !== undefined) out.layersPreset = d.layersPreset;
      if (d.stylePreset !== undefined) out.stylePreset = d.stylePreset;
      if (d.styleRules !== undefined) out.styleRules = d.styleRules;
      return out;
    }
    case "eval": {
      const v = r as EvalResolved;
      return { code: v.code, args: v.args, redraw: v.redraw };
    }
    default:
      throw new Error(`no replay for tool '${tool}'`);
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const show = (v: unknown): string => {
  const s = JSON.stringify(v ?? null);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

/**
 * Fields of an edit op that both the sketch (before != after) and someone else (base value !=
 * current value) changed, to different values. `plan` is the bridge's validate plan.
 */
export function bothChanged(r: EditResolved, plan: Array<Record<string, unknown>>): string[] {
  const out: string[] = [];
  r.ops.forEach((o, k) => {
    if (o.remove || !o.set || !o.before || !o.after) return;
    const row = plan.find(p => p.index === k) ?? plan[k];
    const now = (row?.before ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(o.set)) {
      if (!(key in o.before) || !(key in now)) continue;
      const base = o.before[key];
      const mine = o.after[key];
      const cur = now[key];
      if (same(base, mine) || same(cur, base) || same(cur, mine)) continue;
      const who = r.type === "map" ? "the map" : `${r.type} ${o.name ? `'${o.name}' ` : ""}(${o.ref})`;
      out.push(`both changed ${key} of ${who}: base ${show(base)}, now ${show(cur)}, sketch ${show(mine)}`);
    }
  });
  return out;
}

export async function replayOps(
  ctx: ToolContext,
  scope: CallScope,
  ops: readonly OpRecord[],
  opts: { onConflict?: "stop" | "skip"; label?: string } = {}
): Promise<ReplayResult> {
  const onConflict = opts.onConflict ?? "stop";
  const res: ReplayResult = {
    applied: [],
    skipped: [],
    noops: [],
    conflicts: [],
    idMap: {},
    records: [],
    stopped: false,
    undoEntries: [],
    notes: []
  };
  const rw = new Rewriter(res.idMap, createdSet(ops));
  const conflict = (op: OpRecord, reason: string, hard = false): boolean => {
    res.conflicts.push({ seq: op.seq, reason, op });
    if (hard || onConflict === "stop") {
      res.stopped = true;
      return true;
    }
    res.skipped.push(op.seq);
    return false;
  };

  for (const op of ops) {
    if (op.noop) {
      res.noops.push(op.seq);
      continue;
    }
    if (!op.replayable || !op.resolved) {
      if (conflict(op, `not replayable: ${op.reason ?? `${op.tool} has no resolved form`}`)) break;
      continue;
    }
    const fn = BRIDGE_FN[op.tool];
    if (!fn) {
      if (conflict(op, `no replay for tool '${op.tool}'`)) break;
      continue;
    }
    let r: Resolved;
    try {
      r = rewriteResolved(op.tool, op.resolved, rw);
    } catch (e) {
      if (!(e instanceof Unmapped)) throw e;
      if (conflict(op, e.message)) break;
      continue;
    }
    const args = bridgeArgs(op.tool, r);
    const timeoutMs = op.tool === "paint_cells" ? TIMEOUTS.heavy : TIMEOUTS.edit;

    // validate (eval has no validation; it is replayed verbatim)
    if (op.tool !== "eval") {
      const v = await scope.envelope<Record<string, unknown>>(fn, { ...args, phase: "validate" }, { timeoutMs });
      if (!v.ok) {
        if (conflict(op, `${v.error?.code ?? "ERROR"}: ${v.error?.message ?? "validation failed"}`)) break;
        continue;
      }
      const errs = ((v.value?.errors as ErrRow[] | undefined) ?? []).map(errText);
      if (errs.length) {
        if (conflict(op, errs.join("; "))) break;
        continue;
      }
      if (op.tool === "edit") {
        const both = bothChanged(r as EditResolved, (v.value?.plan as Array<Record<string, unknown>>) ?? []);
        if (both.length) {
          if (conflict(op, both.join("; "))) break;
          continue;
        }
      }
    }

    // apply, with an auto-undo entry per op
    const digestBefore = await scope.digest();
    const undoId = await scope.pushUndo(`${opts.label ?? "sketch replay"} op ${op.seq} (${op.tool})`, {
      seq: op.seq,
      tool: op.tool
    });
    res.undoEntries.push(undoId);
    // edit/add/paint apply only with phase 'apply' (without it they validate); display and
    // evalUser apply without a phase
    const applyArgs = op.tool === "display" || op.tool === "eval" ? args : { ...args, phase: "apply" };
    const env = await scope.envelope<Record<string, unknown>>(fn, applyArgs, { mutating: true, timeoutMs });
    ctx.snapshots.noteMutation();
    if (!env.ok) {
      conflict(
        op,
        `apply failed after validation (${env.error?.code ?? "ERROR"}: ${env.error?.message ?? "?"}); its undo entry reverts it`,
        true
      );
      break;
    }
    const out = (env.value ?? {}) as Record<string, unknown>;
    if (out.phase === "validate") throw new Error(`replay of op ${op.seq}: the bridge only validated (no apply phase)`);
    if (out.aborted) {
      conflict(op, `apply aborted: ${errText(out.aborted as ErrRow)}; its undo entry reverts it`, true);
      break;
    }
    const applied = op.tool === "eval" ? r : (takeResolved(out) ?? r);
    if (op.tool === "add") {
      const unpaired = pairCreated(res.idMap, (r as AddResolved).created ?? [], (applied as AddResolved).created ?? []);
      if (unpaired.length)
        res.notes.push(
          `op ${op.seq}: the replay did not create a counterpart for ${unpaired.map(c => `${c.type} ${c.i}`).join(", ")}; ops that use them will conflict`
        );
    }
    res.applied.push(op.seq);
    res.records.push({
      ...op,
      resolved: applied,
      summary: op.tool === "eval" ? op.summary : summarizeOp(op.tool, applied, out, op.args),
      at: new Date().toISOString(),
      digestBefore,
      digestAfter: await scope.digest(),
      undoId
    });
  }
  return res;
}
