// compact: replace removed entities with minimal stubs (ids stay), drop the notes and orphaned
// SVG of removed or deleted entities. Undoable, logged to the sketch (replayable: the resolved
// form lists the ids compacted, note ids dropped and SVG owners per type). The page side and
// the per-type stub audit are in src/bridge-ext/compact.js.
//
// save_map / shared_save / sketch save / sketch_promote take compact:true: they write a
// compacted copy (readMapData below) and leave the page as it is.
import { z } from "zod";
import type { CallScope, ToolContext } from "../context.ts";
import { type Resolved, type Rewriter, registerReplayable, takeResolved, Unmapped } from "../ops.ts";
import { ToolError } from "../result.ts";
import { TIMEOUTS, TimeoutMs } from "../schemas.ts";
import { changesSinceUndo } from "./edit.ts";
import { defineTools } from "./registry.ts";

export const COMPACT_TYPES = [
  "burg",
  "state",
  "province",
  "culture",
  "religion",
  "marker",
  "route",
  "river",
  "zone",
  "label",
  "regiment"
] as const;

/** Resolved form logged for compact: what was compacted / dropped, per type. */
export interface CompactResolved {
  ids: Record<string, number[]>;
  notes: string[];
  svg: Record<string, number[]>;
  /** repointProvinces: [province, old capital, new capital (0 = none)]. */
  repoint?: Array<[number, number, number]>;
  /** For the log summary only (replay ignores them): bytes saved, records kept whole. */
  bytes?: number;
  kept?: number;
}

export interface MapData {
  text: string;
  customization: number;
  fileName: string | null;
  /** compact:true only: counts and the exact bytes the compaction saved. */
  compacted?: Record<string, unknown>;
}

/** The .map text for a save: as is, or compacted (the page is not changed either way). */
export async function readMapData(scope: CallScope, compact?: boolean): Promise<MapData> {
  const data = await scope.call<MapData>(compact ? "compactMapData" : "mapData", {}, { noAlerts: true });
  if (!compact) delete data.compacted;
  return data;
}

export const CompactFlag = z
  .boolean()
  .optional()
  .describe(
    "Write a compacted copy: removed entities as stubs, notes and SVG of removed entities dropped (see compact); the page is not changed"
  );

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function kb(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
}

/** One plain sentence: records shrunk (they were removed before; no live entity changes). */
export function summarize(r: CompactResolved | null): string {
  if (!r) return "Compacted removed entities.";
  const parts = Object.entries(r.ids ?? {})
    .filter(([, ids]) => ids.length)
    .map(([t, ids]) => plural(ids.length, `removed ${t} record`));
  const svg = Object.values(r.svg ?? {}).reduce((s, ids) => s + ids.length, 0);
  const extra: string[] = [];
  if (r.notes?.length) extra.push(plural(r.notes.length, "note"));
  if (svg) extra.push(`the SVG of ${plural(svg, "entity")}`);
  const head = parts.length
    ? `Shrank ${parts.join(", ")} to id-keeping stubs (no live entity changed)`
    : "Compacted no records";
  const tail: string[] = [];
  if (extra.length) tail.push(`dropped ${extra.join(" and ")}`);
  if (r.repoint?.length) tail.push(`moved ${plural(r.repoint.length, "province capital")} off removed burgs`);
  if (typeof r.bytes === "number" && r.bytes > 0) tail.push(`about ${kb(r.bytes)} smaller`);
  if (r.kept) tail.push(`${r.kept} still referenced and kept whole`);
  return `${head}${tail.length ? `; ${tail.join("; ")}` : ""}.`;
}

registerReplayable("compact", {
  bridgeFn: "compact",
  bridgeArgs: r => {
    const c = r as unknown as CompactResolved;
    return { ids: c.ids ?? {}, noteIds: c.notes ?? [], svgIds: c.svg ?? {}, repoint: c.repoint ?? [] };
  },
  // An entity the sketch created in an op that was not applied has nothing to compact on the
  // new base: drop it from the list instead of failing the op (compact is cleanup).
  rewrite: (r, rw: Rewriter) => {
    const c = r as unknown as CompactResolved;
    const keep = <T>(f: () => T): T | null => {
      try {
        return f();
      } catch (e) {
        if (e instanceof Unmapped) return null;
        throw e;
      }
    };
    const map = (o: Record<string, number[]> | undefined) =>
      Object.fromEntries(
        Object.entries(o ?? {}).map(([t, ids]) => [
          t,
          ids.map(i => keep(() => rw.id(t, i) as number)).filter((i): i is number => i !== null)
        ])
      );
    const notes = (c.notes ?? []).map(n => keep(() => rw.noteId(n))).filter((n): n is string => n !== null);
    const repoint = (c.repoint ?? [])
      .map(([p, from, to]) =>
        keep(() => [rw.id("province", p), rw.id("burg", from), to ? rw.id("burg", to) : 0] as [number, number, number])
      )
      .filter((x): x is [number, number, number] => x !== null);
    const out: CompactResolved = { ids: map(c.ids), notes, svg: map(c.svg) };
    if (repoint.length) out.repoint = repoint;
    if (c.bytes !== undefined) out.bytes = c.bytes;
    if (c.kept !== undefined) out.kept = c.kept;
    return out as unknown as Resolved;
  },
  summarize: r => summarize(r as unknown as CompactResolved | null),
  timeout: "heavy"
});

export function register(ctx: ToolContext): void {
  ctx.tool(
    "compact",
    {
      title: "Compact removed entities",
      description:
        "Shrink the map: removed burgs, states, provinces, cultures and religions keep their whole old record (name, coordinates, production...) in their array slot; compact replaces each with a stub {i, removed:true} (cultures also keep base and center) in the same slot, so no id changes (the next id is still the array length; notes, routes, labels and sketches use ids). No live entity changes, so map_info's diff does not show the stubs (only dropped notes). After compact a removed id still answers REMOVED, but without its name, and a NAME ref to a compacted record is NOT_FOUND. A removed record that live data still points at (a capital, a province's capital, a market centre, a trade deal, a live burg's or religion's culture, origins, a cell) stays whole: kept counts them, keptBy splits them by kind and keptWhy says what releases each kind (deal: regenerate {parts:['production']}, which re-rolls every live burg's economy; provinceBurg: repointProvinces:true). repointProvinces:true moves a live province's capital off a removed burg to the first live burg in the province (or none), as the app's provinces editor does when it opens. Also drops notes of removed or deleted entities (burg, stateLabel, province, culture, religion, marker, route, river, zone, label, regiment ids) and their orphaned SVG (icons, labels, emblems, COA symbols, region paths). types limits it (default all); marker, route, river, zone, label and regiment have no records to stub (the app deletes them), so for them compact only drops leftover notes and SVG. bytesSaved is exact for records and notes and close for SVG. details:true lists ids as ranges, kept records (with every kind that holds them) and dropped note ids, up to limit rows (default 50). dryRun:true only counts. One auto-undo entry; refused while an app editor is active (customization != 0). To compact only the saved file, pass compact:true to save_map, shared_save, sketch save or sketch_promote instead.",
      inputSchema: z.object({
        types: z.array(z.enum(COMPACT_TYPES)).min(1).optional().describe("Entity types to compact (default all)"),
        notes: z.boolean().optional().describe("Drop notes of removed or deleted entities (default true)"),
        svg: z.boolean().optional().describe("Drop their orphaned SVG elements (default true)"),
        repointProvinces: z
          .boolean()
          .optional()
          .describe(
            "Move live provinces' capitals off removed burgs (first live burg in the province, or none) so those burgs can be compacted"
          ),
        dryRun: z.boolean().optional().describe("Count what would change; change nothing"),
        details: z
          .boolean()
          .optional()
          .describe("List ids (as ranges), kept records with what holds them, and dropped note ids"),
        limit: z.number().int().min(1).max(5000).optional().describe("details: rows per list (default 50)"),
        timeoutMs: TimeoutMs
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      kind: "heavy"
    },
    async (args, scope) => {
      const { dryRun, timeoutMs, ...rest } = args;
      const t = timeoutMs ?? TIMEOUTS.heavy;
      const plan = await scope.call<Record<string, unknown>>(
        "compact",
        { ...rest, phase: "validate" },
        { timeoutMs: t }
      );
      const { phase: _phase, empty, customization, ...body } = plan;
      if (dryRun) return { dryRun: true, ...body, note: "dry run: nothing was changed" };
      if (empty) return { ...body, note: "nothing to compact; nothing was changed" };
      if (customization)
        throw new ToolError(
          "REFUSED",
          `an app editor is active (customization=${customization}); close it first (eval: closeDialogs(); customization = 0)`
        );
      await scope.pushUndo("compact", args);
      let out: Record<string, unknown>;
      try {
        out = await scope.call<Record<string, unknown>>(
          "compact",
          { ...rest, phase: "apply" },
          { mutating: true, timeoutMs: t }
        );
      } finally {
        ctx.snapshots.noteMutation();
      }
      const resolved = takeResolved(out);
      await scope.record("compact", args, resolved, { out });
      const { empty: _e, ...result } = out;
      // live-data changes only: dropped notes, repointed province capitals (stubs are not live)
      const changes = await changesSinceUndo(ctx, scope);
      return {
        ...result,
        ...(changes !== undefined ? { changes } : {}),
        undo: "snapshot {action:'undo'} reverts this call"
      };
    }
  );
}

defineTools("compact", register);
