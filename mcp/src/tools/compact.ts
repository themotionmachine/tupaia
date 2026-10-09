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
import { TIMEOUTS, TimeoutMs } from "../schemas.ts";
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

function summarize(r: CompactResolved | null): string {
  if (!r) return "Compacted removed entities.";
  const parts = Object.entries(r.ids ?? {})
    .filter(([, ids]) => ids.length)
    .map(([t, ids]) => plural(ids.length, `removed ${t}`));
  const svg = Object.values(r.svg ?? {}).reduce((s, ids) => s + ids.length, 0);
  const extra: string[] = [];
  if (r.notes?.length) extra.push(plural(r.notes.length, "note"));
  if (svg) extra.push(`the SVG of ${plural(svg, "entity")}`);
  const head = parts.length ? `Compacted ${parts.join(", ")}` : "Compacted nothing";
  return `${head}${extra.length ? `; dropped ${extra.join(" and ")}` : ""}.`;
}

registerReplayable("compact", {
  bridgeFn: "compact",
  bridgeArgs: r => {
    const c = r as unknown as CompactResolved;
    return { ids: c.ids ?? {}, noteIds: c.notes ?? [], svgIds: c.svg ?? {} };
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
    return { ids: map(c.ids), notes, svg: map(c.svg) } as unknown as Resolved;
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
        "Shrink the map: removed burgs, states, provinces, cultures and religions keep their whole old record (name, coordinates, production...) in their array slot; compact replaces each with a stub {i, removed:true} (cultures also keep base and center) in the same slot, so no id changes (the next id is the array length; notes, routes, labels and sketches use ids). A removed record that live data still points at (a capital, a province's burg, a market centre, a trade deal, a live burg's or religion's culture, origins, a cell) stays whole and is counted in kept (keptWhy says why; deals of removed burgs go when regenerate {parts:['production']} rebuilds them). Also drops notes of removed or deleted entities (burg, stateLabel, province, culture, religion, marker, route, river, zone, label, regiment ids) and their orphaned SVG (icons, labels, emblems, COA symbols, region paths). types limits it (default all). Returns counts and bytesSaved (estimate); details:true lists ids as ranges. dryRun:true only counts. One auto-undo entry. To compact only the saved file, pass compact:true to save_map, shared_save, sketch save or sketch_promote instead.",
      inputSchema: z.object({
        types: z.array(z.enum(COMPACT_TYPES)).min(1).optional().describe("Entity types to compact (default all)"),
        notes: z.boolean().optional().describe("Drop notes of removed or deleted entities (default true)"),
        svg: z.boolean().optional().describe("Drop their orphaned SVG elements (default true)"),
        dryRun: z.boolean().optional().describe("Count what would change; change nothing"),
        details: z.boolean().optional().describe("List ids (as ranges), kept records and dropped note ids"),
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
      const { phase: _phase, empty, ...body } = plan;
      if (dryRun) return { dryRun: true, ...body, note: "dry run: nothing was changed" };
      if (empty) return { ...body, note: "nothing to compact; nothing was changed" };
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
      return { ...result, undo: "snapshot {action:'undo'} reverts this call" };
    }
  );
}

defineTools("compact", register);
