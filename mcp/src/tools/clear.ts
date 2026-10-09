// clear: bulk removal by type (wiping a random base before building on it). The page side is
// FNS.clear in src/bridge-ext/clear.js; it runs through edit's phased runner (validate ->
// auto-undo -> apply -> diff -> sketch log). The sketch log records the literal ids removed per
// type, so a replay removes exactly those entities (a missing one is a conflict).
import { z } from "zod";
import type { ToolContext } from "../context.ts";
import { type Resolved, type Rewriter, registerReplayable } from "../ops.ts";
import { META_TEXT_HEAVY } from "../result.ts";
import { EntityTarget, TIMEOUTS, TimeoutMs } from "../schemas.ts";
import { Redraw, runPhased } from "./edit.ts";
import { defineTools } from "./registry.ts";

export const CLEAR_TYPES = [
  "notes",
  "labels",
  "markers",
  "zones",
  "routes",
  "rivers",
  "burgs",
  "provinces",
  "states",
  "religions",
  "cultures",
  "emblems"
] as const;

/** The sketch-log form of a clear: literal ids per (singular) type, fingerprints of reused-id types. */
export interface ClearResolved {
  removed: Record<string, Array<number | string>>;
  /** type -> id -> fingerprint (notes, labels, markers, routes, zones, rivers: ids get reused). */
  idents?: Record<string, Record<string, string>>;
  /** How many of removed.route were orphans of the removed burgs (summary only). */
  orphanRoutes?: number;
  redraw?: unknown;
}

const PLURAL: Record<string, string> = {
  note: "notes",
  label: "labels",
  marker: "markers",
  zone: "zones",
  route: "routes",
  river: "rivers",
  burg: "burgs",
  province: "provinces",
  state: "states",
  religion: "religions",
  culture: "cultures",
  emblem: "emblems"
};

const EMBLEM_OWNERS = ["burg", "state", "province"];

function asClear(r: Resolved | null): ClearResolved | null {
  const c = r as unknown as ClearResolved | null;
  return c && typeof c === "object" && c.removed && typeof c.removed === "object" ? c : null;
}

/** Map sketch-created ids through the replay id map; fingerprints of created ids are dropped. */
export function rewriteClear(r: Resolved, rw: Rewriter): Resolved {
  const c = asClear(r);
  if (!c) return r;
  const removed: ClearResolved["removed"] = {};
  const idents: Record<string, Record<string, string>> = {};
  for (const [type, ids] of Object.entries(c.removed)) {
    removed[type] = (Array.isArray(ids) ? ids : []).map(id => {
      if (type === "emblem") {
        const [owner, n] = String(id).split(":");
        if (!EMBLEM_OWNERS.includes(owner)) return id;
        return `${owner}:${rw.id(owner, Number(n)) as number}`;
      }
      const mapped = rw.id(type, id) as number | string;
      const fp = c.idents?.[type]?.[String(id)];
      if (fp !== undefined && !rw.created.has(`${type}:${id}`)) {
        idents[type] ??= {};
        idents[type][String(mapped)] = fp;
      }
      return mapped;
    });
  }
  const out: ClearResolved = { removed };
  if (Object.keys(idents).length) out.idents = idents;
  if (c.orphanRoutes) out.orphanRoutes = c.orphanRoutes;
  if (c.redraw !== undefined) out.redraw = c.redraw;
  return out as unknown as Resolved;
}

const many = (n: number, type: string) => `${n} ${n === 1 ? type : (PLURAL[type] ?? `${type}s`)}`;

export function summarizeClear(r: Resolved | null): string {
  const c = asClear(r);
  if (!c) return "Cleared entities.";
  const orphans = typeof c.orphanRoutes === "number" ? c.orphanRoutes : 0;
  const order = Object.keys(PLURAL).reverse(); // dependants last: burgs before routes
  const parts: string[] = [];
  for (const type of order) {
    const ids = c.removed[type];
    const n = (Array.isArray(ids) ? ids.length : 0) - (type === "route" ? orphans : 0);
    if (n > 0) parts.push(many(n, type));
  }
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return `Cleared ${text ?? "nothing"}${orphans ? ` (with ${many(orphans, "orphan route")})` : ""}.`;
}

registerReplayable("clear", {
  bridgeFn: "clear",
  bridgeArgs: r => {
    const c = asClear(r) as ClearResolved;
    const a: Record<string, unknown> = { ids: c.removed, idents: c.idents ?? {} };
    if (c.redraw !== undefined) a.redraw = c.redraw;
    return a;
  },
  rewrite: rewriteClear,
  summarize: summarizeClear,
  unreplayable: r => (asClear(r) ? null : "clear has no literal list of removed ids"),
  timeout: "heavy"
});

interface ClearPlan {
  phase: "validate";
  total: number;
  errors?: Array<{ code: string; message: string }>;
  plan: Record<string, unknown>;
}

/** Counts only: the per-entity diff of a bulk removal is long and says nothing new. */
function compactChanges(changes: unknown): unknown {
  if (!changes || typeof changes !== "object") return changes;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(changes as Record<string, unknown>)) {
    const counts = (v as { counts?: unknown } | null)?.counts;
    out[k] = counts ?? v;
  }
  return out;
}

export function register(ctx: ToolContext): void {
  ctx.tool(
    "clear",
    {
      title: "Clear entities in bulk",
      description:
        "Remove every entity of the given types (e.g. to wipe a random base before building): types among burgs, states, provinces, cultures, religions, routes, markers, zones, labels, notes, rivers, emblems. Runs in dependency order (notes, labels, markers, zones, routes, rivers -> burgs -> provinces -> states -> religions -> cultures -> emblems) with each editor's own cascade: capitals move to the state's most populous remaining burg (none if no burg is left), market centres lose their market, a state's provinces go with it, cultures/religions fall back to 0 on cells, burgs and states, route links are repaired. Never removes id 0 (Neutrals, Wildlands, No religion). where filters like find: {burgs:{populationMax:500}, routes:{group:'trails'}} (a bare filter when one type; {i:[ids]} picks ids; emblems filter by {type:'burg'|'state'|'province'}). keep [{type, ref}] and lock:true entities are kept (force:true removes locked ones); a kept or locked province keeps its state. orphanRoutes:true also removes routes that served only removed burgs. Returns counts per type, what was kept and why (detail:true lists ids). dryRun:true returns the plan. One auto-undo entry; ids are never renumbered.",
      inputSchema: z.object({
        types: z.array(z.enum(CLEAR_TYPES)).min(1),
        where: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Per-type field filters keyed by type, or one bare filter when one type is cleared"),
        keep: z.array(EntityTarget).max(5000).optional().describe("Entities to keep (their emblems too)"),
        force: z.boolean().optional().describe("Also remove entities with lock:true"),
        orphanRoutes: z.boolean().optional().describe("Also remove routes that served only removed burgs"),
        detail: z.boolean().optional().describe("List the removed ids per type and every kept entity"),
        dryRun: z.boolean().optional().describe("Return the plan without changing anything"),
        redraw: Redraw,
        timeoutMs: TimeoutMs
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: META_TEXT_HEAVY,
      kind: "heavy"
    },
    async (args, scope) => {
      const { dryRun, timeoutMs, ...rest } = args;
      const t = timeoutMs ?? TIMEOUTS.heavy;
      // nothing selected: answer without an undo entry or a log record
      const plan = await scope.call<ClearPlan>("clear", { ...rest, phase: "validate" }, { timeoutMs: t });
      if (!plan.errors?.length && !plan.total) {
        const { remove: _none, ...kept } = plan.plan;
        return { removed: {}, ...kept, note: "nothing matched; nothing was changed" };
      }
      const out = await runPhased(ctx, scope, `clear ${args.types.join(",")}`, args, "clear", rest, {
        dryRun,
        timeoutMs: t
      });
      if (out.changes !== undefined && !args.detail) out.changes = compactChanges(out.changes);
      return out;
    }
  );
}

defineTools("clear", register);
