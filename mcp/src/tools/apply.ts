// apply: bring the map in line with a spec in one call (or, mode 'check', only report where it
// differs). The page side is src/bridge-ext/apply.js; spec reading/normalizing is
// src/apply-spec.ts.
//
// Undo and the sketch log: one auto-undo entry covers the whole call. The page changes the map
// through FNS.edit / FNS.add / FNS.paint, one call per list and kind ("steps"), and each step's
// resolved form is logged as its own edit / add / paint_cells record under that one undo entry
// (SketchStore takes them out and puts them back together). Separate records instead of one
// 'apply' record keep replay exact: replay validates each record against the map as the
// earlier records left it (a route through a burg the same apply created), its edit conflict
// checks (identity, both-changed) apply per record, and its id map pairs every add's created
// entities before the next record is rewritten. A single record could do none of that without
// a second replay engine.
import fs from "node:fs";
import { z } from "zod";
import { type Ignore, type Mapping, normalizeSpec, type SpecInput } from "../apply-spec.ts";
import type { CallScope, ToolContext } from "../context.ts";
import { type Resolved, summarizeOp, unreplayableReason } from "../ops.ts";
import { READ_RULE, resolveReadPath } from "../paths.ts";
import { META_TEXT_HEAVY, ToolError } from "../result.ts";
import { TimeoutMs } from "../schemas.ts";
import { defineTools } from "./registry.ts";

type Row = {
  at: string;
  key?: unknown;
  i?: unknown;
  name?: string;
  status: string;
  diffs?: unknown[];
  error?: unknown;
  note?: string;
};

interface PageResult {
  rows: Row[];
  ignored: Record<string, string[]>;
  unsupported: string[];
  steps: Array<{ tool: string; resolved: Resolved; out?: Record<string, unknown> }>;
  also: Record<string, number>;
  notes: string[];
  wouldChange: number;
  redrawn?: unknown[];
  skippedHidden?: unknown[];
}

const STATUS_ORDER = ["created", "updated", "unchanged", "differs", "missing", "error"];
/** Rows are listed most actionable first. */
const LIST_ORDER = ["error", "differs", "missing", "updated", "created", "unchanged"];

const Entries = z.array(z.record(z.string(), z.unknown())).max(5000).optional();

/** Read a spec file (same read rule as load_map: paths.ts READ_RULE, must exist). */
export function readSpecFile(repoPathResolver: (p: string) => string, p: string): SpecInput {
  const abs = repoPathResolver(p);
  let v: unknown;
  try {
    v = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    throw new ToolError("BAD_ARGS", `${abs} is not JSON: ${(e as Error).message}`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new ToolError("BAD_ARGS", `${abs} must hold a JSON object of lists ({burgs:[...], ...})`);
  return v as SpecInput;
}

type ErrorBody = { code?: string; message?: string; candidates?: unknown };

/**
 * Compact result: counts first; then rows, most actionable first (errors, differs, missing,
 * updated), with identical errors grouped into one row; plain creates only as `created`
 * {list: {key: id}}. verbose: every row, one per entry, unchanged too.
 */
export function shapeResult(
  res: PageResult,
  opts: { mode: string; verbose?: boolean; limit?: number; skipped?: string[]; notes?: string[] }
): Record<string, unknown> {
  const counts: Record<string, number> = {};
  const byList: Record<string, Record<string, number>> = {};
  const listOf = (r: Row) => r.at.replace(/\[\d+\]/, ""); // "burgs[3].note" counts under "burgs.note"
  for (const r of res.rows) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    const list = listOf(r);
    byList[list] ??= {};
    byList[list][r.status] = (byList[list][r.status] ?? 0) + 1;
  }
  const order = (o: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(o).sort(
        (a, b) =>
          ((STATUS_ORDER.indexOf(a[0]) + 99) % 99) - ((STATUS_ORDER.indexOf(b[0]) + 99) % 99) ||
          a[0].localeCompare(b[0])
      )
    );
  const out: Record<string, unknown> = { mode: opts.mode, counts: order(counts) };
  if (Object.keys(byList).length > 1)
    out.lists = Object.fromEntries(Object.entries(byList).map(([k, v]) => [k, order(v)]));

  let shown: Array<Record<string, unknown>>;
  if (opts.verbose) shown = res.rows;
  else {
    // plain creates: {list: {key: id}}
    const created: Record<string, Record<string, unknown>> = {};
    const rest: Row[] = [];
    for (const r of res.rows) {
      if (r.status === "unchanged") continue;
      if (r.status === "created") {
        // every created entity is listed here; one with diffs (a read-only field another tool
        // sets, e.g. a burg's state), an error or a note also keeps its row
        created[listOf(r)] ??= {};
        const list = created[listOf(r)];
        // a row keyed by its id (a note, a route group) is listed by its name
        const byId = r.i === undefined || r.i === r.key;
        let k = byId && r.name ? r.name : String(r.key ?? r.name ?? r.at);
        let n = 2;
        const base = k;
        while (k in list) k = `${base} #${n++}`;
        list[k] = r.i ?? r.key ?? null;
        if (!r.diffs?.length && !r.error && !r.note) continue;
      }
      rest.push(r);
    }
    if (Object.keys(created).length) out.created = created;
    rest.sort(
      (a, b) => LIST_ORDER.indexOf(a.status) - LIST_ORDER.indexOf(b.status) // stable: entry order within a status
    );
    // identical errors (same code and message), and identical differs rows (same list and the
    // same field changes, e.g. 33 markers whose size is 22 and should be 30): one row with a
    // count and the first entries
    const groupKey = (r: Row): string | null => {
      if (r.status === "error") {
        const e = (r.error ?? {}) as ErrorBody;
        return `error|${e.code}|${e.message}`;
      }
      if (r.status === "differs" && r.diffs?.length && !r.note)
        return `differs|${listOf(r)}|${JSON.stringify(r.diffs)}`;
      return null;
    };
    const groups = new Map<string, Row[]>();
    for (const r of rest) {
      const k = groupKey(r);
      if (k === null) continue;
      const g = groups.get(k);
      if (g) g.push(r);
      else groups.set(k, [r]);
    }
    shown = [];
    const emitted = new Set<string>();
    for (const r of rest) {
      const k = groupKey(r);
      const g = k === null ? [r] : (groups.get(k) ?? [r]);
      if (k === null || g.length < 3) {
        shown.push(r);
        continue;
      }
      if (emitted.has(k)) continue;
      emitted.add(k);
      shown.push({
        status: r.status,
        count: g.length,
        at: g.slice(0, 3).map(x => x.at),
        keys: g.slice(0, 3).map(x => x.key ?? null),
        ...(g.length > 3 ? { more: g.length - 3 } : {}),
        ...(r.status === "error" ? { error: r.error } : { diffs: r.diffs })
      });
    }
  }
  const limit = opts.limit ?? 100;
  out.rows = shown.slice(0, limit);
  if (shown.length > limit)
    out.moreRows = `${shown.length - limit} more rows; raise limit (max 2000) or narrow with only`;
  if (Object.keys(res.ignored ?? {}).length) {
    out.ignored = res.ignored;
    const keys = Object.entries(res.ignored).map(([list, ks]) => `${list}: ${ks.join(", ")}`);
    out.ignoredNote = `keys apply does not apply, so they were left out (not checked, not set): ${keys.join("; ")}`;
  }
  if (res.unsupported?.length) out.unsupported = res.unsupported;
  if (opts.skipped?.length) out.skipped = opts.skipped;
  if (Object.keys(res.also ?? {}).length) out.alsoCreated = res.also;
  if (res.skippedHidden?.length) out.skippedHidden = res.skippedHidden;
  const notes = [...(opts.notes ?? []), ...(res.notes ?? [])];
  if (res.skippedHidden?.length)
    notes.push(`hidden layers not redrawn: ${res.skippedHidden.join(", ")} (display {on:[...]} shows them)`);
  if (notes.length) out.notes = notes;
  return out;
}

export function register(ctx: ToolContext): void {
  ctx.tool(
    "apply",
    {
      title: "Apply or check a spec",
      description:
        "Bring the map in line with a spec in one call, or check it. Lists burgs, markers, labels, zones, routes, notes, states, provinces, cultures, religions, rivers, features, biomes, routeGroups (any list whose singular is an edit/add type), map {name, year, ...} and paint; inline or specPath (JSON file). Entries are keyed by name (labels: text; notes: id | entity:{type,name} | entity:'Name' | name), by id (route groups) or by ref. Found (exact, then folded name; several: the one at the entry's x,y, else AMBIGUOUS) -> only differing fields are edited; missing -> created. mode 'upsert' (default) | 'update' (no creates) | 'check' (read-only: reports what upsert would do). Rows: unchanged | updated | created | differs | missing | error, diffs [{field, have, want}] (readOnly + fix: another tool sets it; pending: created by this spec). Two entries for one entity or note: CONFLICT. Places match within 1 px, numbers exactly, colours case-insensitive, legends HTML-decoded (see tolerance). Shapes: x,y or at:[x,y]; routes through:[burg names or [x,y]] or draw:'points' (freehand); zones shape/select {polygon:[[x,y]], circle:[x,y,r], where}; an entry's note becomes its note (zones too; markers[].places join the legend); states[].provinces are checked as provinces. paint [{select, set:{state|province|culture|religion|biome|height}}] paints cells in order, later entries winning; check counts each entry's differing cells; select adds any:[...], feature_polygon(s)+buffer_px, from:'spec.path'. A burgs entry's state paints its own cell. mapping {lists, keys, values} renames first; ignore {list:[keys]} leaves keys out. One auto-undo entry, none when nothing changes; replayable in sketches. Result: counts; rows most actionable first, 3+ identical rows grouped (verbose: every row); created {list: {key: id}}.",
      inputSchema: z
        .object({
          specPath: z
            .string()
            .min(1)
            .optional()
            .describe(`JSON file with the lists: ${READ_RULE}. The result names the file read (specPath)`),
          burgs: Entries,
          markers: Entries,
          labels: Entries,
          zones: Entries,
          routes: Entries,
          notes: Entries,
          states: Entries,
          provinces: Entries,
          cultures: Entries,
          religions: Entries,
          rivers: Entries,
          features: Entries,
          biomes: Entries,
          routeGroups: Entries,
          paint: Entries.describe(
            "Cell paints, in order (a later entry wins its cells): {select, set} or flat {shape|select|from, where?, except?, culture|state|religion|province|biome|height: value}. select: paint_cells keys (cells, circle {at, radius} or [x,y,r], polygon [[x,y]], entity, buffer px, where, except) plus any:[selects] (union), selects:[...] (union), feature_polygon / feature_polygons: names in the spec's terrain.features or shapes, grown by buffer_px. from:'terrain_paint.Somnean' or 'cultures.Wainfolk.territory' reads the entry from the spec; from a list ('biomes_paint') makes one entry per item. height is {value} (land 20..100, rebuild keep: the changed cells' biomes follow their new climate unless a biome entry paints them). A paint entry with custom:true defines its biome (base, color, habitability). Each entry paints only the cells it wins whose value differs (water, state/province centres and capitals are left), so applying again changes nothing; the row's diffs give per key {want, cells, differ, have: previous values, overridden, skipped}"
          ),
          map: z.record(z.string(), z.unknown()).optional().describe("Map fields (edit type 'map')"),
          mode: z.enum(["upsert", "check", "update"]).optional(),
          only: z
            .array(z.string())
            .optional()
            .describe("Apply just these lists (their names before or after mapping.lists renames)"),
          ignore: z
            .record(z.string(), z.array(z.string()))
            .optional()
            .describe("Keys left out per list ('*': every list), e.g. {burgs: ['note'], states: ['form']}"),
          tolerance: z
            .object({
              px: z.number().min(0).optional().describe("Places (default 1)"),
              number: z.number().min(0).optional().describe("Numbers (default 0: exact)"),
              fields: z.record(z.string(), z.number().min(0)).optional().describe("Per field, e.g. {population: 100}"),
              legend: z
                .enum(["exact", "contains"])
                .optional()
                .describe("contains: a legend that contains the spec's text matches (composed legends)")
            })
            .optional(),
          mapping: z
            .object({
              lists: z.record(z.string(), z.string()).optional(),
              keys: z.record(z.string(), z.record(z.string(), z.string().nullable())).optional(),
              values: z
                .record(z.string(), z.record(z.string(), z.union([z.string(), z.record(z.string(), z.unknown())])))
                .optional()
            })
            .optional()
            .describe(
              "Light key mapping applied first: list renames, per-list key renames (null drops), value tables (a '*' entry is the default; null drops the key) or 'pre{}post' templates"
            ),
          clamp: z.boolean().optional().describe("Clamp at/move places into the map (1 px margin)"),
          verbose: z.boolean().optional().describe("List unchanged rows too"),
          limit: z.number().int().min(1).max(2000).optional().describe("Max rows listed (default 100)"),
          timeoutMs: TimeoutMs
        })
        .catchall(z.array(z.record(z.string(), z.unknown())).max(5000)),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: META_TEXT_HEAVY,
      kind: "heavy"
    },
    async (args, scope) => runApply(ctx, scope, args as Record<string, unknown>)
  );
}

async function runApply(ctx: ToolContext, scope: CallScope, args: Record<string, unknown>) {
  const {
    specPath,
    mode: modeArg,
    only,
    ignore,
    tolerance,
    mapping,
    clamp,
    verbose,
    limit,
    timeoutMs: _t,
    ...inline
  } = args as {
    specPath?: string;
    mode?: "upsert" | "check" | "update";
    only?: string[];
    ignore?: Ignore;
    tolerance?: Record<string, unknown>;
    mapping?: Mapping;
    clamp?: boolean;
    verbose?: boolean;
    limit?: number;
    timeoutMs?: number;
    [k: string]: unknown;
  };
  const mode = modeArg ?? "upsert";
  const specAbs = specPath ? resolveReadPath(ctx.config, specPath) : null;
  const fileSpec = specAbs ? readSpecFile(p => p, specAbs) : null;
  const named = (r: Record<string, unknown>) => (specAbs ? { specPath: specAbs, ...r } : r);
  const spec = normalizeSpec(fileSpec, inline as SpecInput, mapping ?? {}, only, ignore);
  if (!spec.lists.length && !spec.map) {
    if (only && spec.present.length)
      throw new ToolError(
        "BAD_ARGS",
        `only [${only.join(", ")}] matched no list; lists present: ${spec.present.join(", ")}`
      );
    throw new ToolError(
      "BAD_ARGS",
      `nothing to apply: pass lists (burgs, markers, labels, zones, routes, notes, states, ...) inline or in specPath${spec.skipped.length ? ` (not lists: ${spec.skipped.join(", ")})` : ""}`
    );
  }
  const bridgeArgs = { mode, lists: spec.lists, map: spec.map, tolerance: tolerance ?? {}, clamp: !!clamp };
  const callOpts = { timeoutMs: scope.remainingMs, json: { maxDepth: 30 } };
  const shapeOpts = { mode, verbose, limit, skipped: spec.skipped, notes: spec.notes };

  const plan = await scope.call<PageResult>("applySpec", { ...bridgeArgs, phase: "validate" }, callOpts);
  if (mode === "check") return named({ ...shapeResult(plan, shapeOpts), changed: false });
  if (!plan.wouldChange) return named({ ...shapeResult(plan, shapeOpts), changed: false, note: "nothing to change" });

  const listSummary = spec.lists.map(l => `${l.key} ${l.entries.length}`).join(", ");
  await scope.pushUndo("apply", { mode, ...(specPath ? { specPath } : {}), lists: listSummary });
  let res: PageResult;
  try {
    res = await scope.call<PageResult>(
      "applySpec",
      { ...bridgeArgs, phase: "apply" },
      { ...callOpts, timeoutMs: scope.remainingMs, mutating: true }
    );
  } catch (e) {
    ctx.snapshots.noteMutation();
    if (e instanceof ToolError)
      e.message += " Part of the spec may have been applied; snapshot {action:'undo'} reverts the whole call.";
    throw e;
  }
  ctx.snapshots.noteMutation();
  await logSteps(scope, res, { mode, lists: listSummary });
  return named({
    ...shapeResult(res, shapeOpts),
    changed: res.steps.length > 0,
    undo: "snapshot {action:'undo'} reverts this whole call"
  });
}

/** One sketch record per step, all under this call's undo entry (no-op record when none). */
async function logSteps(scope: CallScope, res: PageResult, args: Record<string, unknown>): Promise<void> {
  if (!scope.logsToSketch) return;
  const steps = res.steps ?? [];
  if (!steps.length) {
    await scope.record("apply", args, null, {
      replayable: true,
      noop: true,
      summary: "apply changed nothing (no-op)."
    });
    return;
  }
  for (const [k, st] of steps.entries()) {
    const recArgs = { via: "apply", step: k + 1, of: steps.length, ...args };
    const last = k === steps.length - 1;
    const why = unreplayableReason(st.tool, st.resolved);
    const summary = `apply ${k + 1}/${steps.length}: ${summarizeOp(st.tool, st.resolved, st.out ?? null, recArgs)}`;
    if (why) await scope.record(st.tool, recArgs, null, { replayable: false, reason: why, summary, skipDigest: !last });
    else await scope.record(st.tool, recArgs, st.resolved, { out: st.out ?? null, summary, skipDigest: !last });
  }
}

defineTools("apply", register);
