// clear: bulk removal by type (wiping a random base before building on it). The page side is
// FNS.clear in src/bridge-ext/clear.js; it runs through edit's phased runner (validate ->
// auto-undo -> apply -> diff -> sketch log). The sketch log records the literal ids removed per
// type with a fingerprint of each entity, and the capital and province-head successors chosen,
// so a replay removes exactly those entities the same way (a missing or changed one is a
// conflict).
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

/** The sketch-log form of a clear: literal ids per (singular) type, with fingerprints. */
export interface ClearResolved {
  removed: Record<string, Array<number | string>>;
  /** type -> id -> fingerprint of the entity's main fields when it was removed. */
  idents?: Record<string, Record<string, string>>;
  /** Capitals the clear moved: the burg that became the capital of each state that stayed. */
  capitals?: Array<{ state: number; burg: number }>;
  /** Provinces whose head burg went: the burg that took over. */
  provinceHeads?: Array<{ province: number; burg: number }>;
  /** How many of removed.route were orphans of the removed burgs (summary only). */
  orphanRoutes?: number;
  /** The clear removed locked entities too (a replay then ignores locks). */
  force?: boolean;
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

/**
 * Map sketch-created ids through the replay id map. Fingerprints of entities the sketch created
 * are dropped (the replay creates them anew; generated fields such as an emblem can differ).
 */
export function rewriteClear(r: Resolved, rw: Rewriter): Resolved {
  const c = asClear(r);
  if (!c) return r;
  const removed: ClearResolved["removed"] = {};
  const idents: Record<string, Record<string, string>> = {};
  for (const [type, ids] of Object.entries(c.removed)) {
    removed[type] = (Array.isArray(ids) ? ids : []).map(id => {
      let mapped: number | string;
      let created: boolean;
      if (type === "emblem") {
        const [owner, n] = String(id).split(":");
        if (!EMBLEM_OWNERS.includes(owner)) return id;
        mapped = `${owner}:${rw.id(owner, Number(n)) as number}`;
        created = rw.created.has(`${owner}:${n}`);
      } else {
        mapped = rw.id(type, id) as number | string;
        created = rw.created.has(`${type}:${id}`);
      }
      const fp = c.idents?.[type]?.[String(id)];
      if (fp !== undefined && !created) {
        idents[type] ??= {};
        idents[type][String(mapped)] = fp;
      }
      return mapped;
    });
  }
  const out: ClearResolved = { removed };
  if (Object.keys(idents).length) out.idents = idents;
  if (c.capitals?.length)
    out.capitals = c.capitals.map(x => ({
      state: rw.id("state", x.state) as number,
      burg: rw.id("burg", x.burg) as number
    }));
  if (c.provinceHeads?.length)
    out.provinceHeads = c.provinceHeads.map(x => ({
      province: rw.id("province", x.province) as number,
      burg: rw.id("burg", x.burg) as number
    }));
  if (c.orphanRoutes) out.orphanRoutes = c.orphanRoutes;
  if (c.force) out.force = true;
  if (c.redraw !== undefined) out.redraw = c.redraw;
  return out as unknown as Resolved;
}

const many = (n: number, type: string) => `${n} ${n === 1 ? type : (PLURAL[type] ?? `${type}s`)}`;

const short = (v: unknown, max = 60): string => {
  const s = typeof v === "string" ? v : (JSON.stringify(v) ?? "");
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
};

interface CapitalRow {
  state: number;
  stateName?: string | null;
  to: number;
  name?: string | null;
}

/**
 * One sentence: what was cleared (with a few names), the filter, and the capitals that moved,
 * e.g. 'Cleared 3 burgs (Hessigrove, Obnoch, Farcrest) where {"state":"Oom"}; capital of Oom
 * -> none.'
 */
export function summarizeClear(r: Resolved | null, out?: Record<string, unknown> | null, args?: unknown): string {
  const c = asClear(r);
  if (!c) return "Cleared entities.";
  const names = (out?.names ?? {}) as Record<string, string[]>;
  const orphans = typeof c.orphanRoutes === "number" ? c.orphanRoutes : 0;
  const order = Object.keys(PLURAL).reverse(); // dependants last: burgs before routes
  const parts: string[] = [];
  for (const type of order) {
    const ids = c.removed[type];
    const n = (Array.isArray(ids) ? ids.length : 0) - (type === "route" ? orphans : 0);
    if (n <= 0) continue;
    const sample = (names[PLURAL[type]] ?? []).filter(x => typeof x === "string" && x);
    const listed =
      sample.length && type !== "route" ? ` (${sample.join(", ")}${n > sample.length ? ", ..." : ""})` : "";
    parts.push(`${many(n, type)}${listed}`);
  }
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  const a = (args ?? {}) as { where?: unknown; keep?: unknown[]; force?: boolean };
  const where = a.where && typeof a.where === "object" ? ` where ${short(a.where)}` : "";
  const keep = Array.isArray(a.keep) && a.keep.length ? `, keeping ${a.keep.length} listed` : "";
  const forced = a.force ? " (forced)" : "";
  const orph = orphans ? `, with ${many(orphans, "orphan route")}` : "";
  const cascade = (out?.cascade ?? {}) as { capitalsMoved?: CapitalRow[]; capitalsMovedTotal?: number };
  const moved = Array.isArray(cascade.capitalsMoved) ? cascade.capitalsMoved : [];
  const caps = moved
    .slice(0, 3)
    .map(x => `capital of ${x.stateName ?? `state ${x.state}`} -> ${x.to ? (x.name ?? `burg ${x.to}`) : "none"}`);
  const totalMoved = cascade.capitalsMovedTotal ?? moved.length;
  if (totalMoved > caps.length) caps.push(`${totalMoved - caps.length} more capitals moved`);
  return `Cleared ${text ?? "nothing"}${where}${keep}${forced}${orph}${caps.length ? `; ${caps.join("; ")}` : ""}.`;
}

registerReplayable("clear", {
  bridgeFn: "clear",
  bridgeArgs: r => {
    const c = asClear(r) as ClearResolved;
    const a: Record<string, unknown> = { ids: c.removed, idents: c.idents ?? {} };
    if (c.capitals?.length) a.capitals = c.capitals;
    if (c.provinceHeads?.length) a.provinceHeads = c.provinceHeads;
    if (c.orphanRoutes) a.orphanCount = c.orphanRoutes;
    if (c.force) a.force = true;
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
  plan: Record<string, unknown> & { notes?: string[] };
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
        "Remove every entity of the given types (e.g. to wipe a random base before building): types among burgs, states, provinces, cultures, religions, routes, markers, zones, labels, notes, rivers, emblems. Runs in dependency order (notes, labels, markers, zones, routes, rivers -> burgs -> provinces -> states -> religions -> cultures -> emblems) with each editor's own cascade: capitals move to the state's most populous remaining burg (none if no burg is left), market centres lose their market, a state's provinces go with it, cultures fall back to 0 on cells, burgs, states and religions, religions on cells, emblems are hidden (size 0), route links are repaired. Never removes id 0 (Neutrals, Wildlands, No religion). where filters like find: {burgs:{populationMax:500}, routes:{group:'trails'}} (a bare filter when one type; {i:[ids]} picks ids; an unknown field is BAD_ARGS; emblems filter by {type:'burg'|'state'|'province'}). keep [{type, ref}] (a cleared type; a province keeps its state; a burg/state/province keeps its emblem) and lock:true entities are kept (force:true removes locked ones). orphanRoutes:true also removes routes that served only removed burgs. Returns counts per type, the cascade, what was kept and why (detail:true lists ids). dryRun:true returns the plan in the same shape. One auto-undo entry; ids are never renumbered.",
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
        const { notes, ...body } = plan.plan;
        const all = notes ?? [];
        const allKept = all.find(n => / all kept /.test(n));
        const note = allKept ?? "nothing matched; nothing was changed";
        const others = all.filter(n => n !== allKept);
        const extra = others.length ? { notes: others } : {};
        if (dryRun) return { dryRun: true, total: 0, plan: body, ...extra, note };
        const { remove: _none, ...kept } = body;
        return { removed: {}, ...kept, ...extra, note };
      }
      const out = await runPhased(ctx, scope, `clear ${args.types.join(",")}`, args, "clear", rest, {
        dryRun,
        timeoutMs: t
      });
      // the sample names are for the sketch log's summary
      delete out.names;
      if (out.changes !== undefined && !args.detail) out.changes = compactChanges(out.changes);
      return out;
    }
  );
}

defineTools("clear", register);
