// snapshot: named whole-map snapshots plus the auto-undo/redo history.
import fs from "node:fs";
import { z } from "zod";
import type { CallScope, ToolContext } from "../context.ts";
import { resolveWritePath } from "../paths.ts";
import { META_TEXT_HEAVY, ToolError } from "../result.ts";
import { defineTools } from "./registry.ts";

function mapIdOf(summary: Record<string, unknown>): number | null {
  return typeof summary.mapId === "number" ? summary.mapId : null;
}

function brief(summary: Record<string, unknown>): Record<string, unknown> {
  return { name: summary.name, seed: summary.seed, graph: summary.graph, counts: summary.counts };
}

async function take(ctx: ToolContext, scope: CallScope, label: string | undefined, saveTo: string | undefined) {
  const t0 = Date.now();
  await ctx.verifyProvenance();
  const text = await scope.mapText();
  const { snap, evicted } = ctx.snapshots.add(text, label ?? null);
  await scope.call("setBaseline", { key: snap.baselineKey }, { noAlerts: true });
  if (evicted.length) await scope.call("dropBaseline", { keys: evicted }, { noAlerts: true });
  if (saveTo) {
    const file = resolveWritePath(ctx.config, saveTo, { exts: [".map"] });
    fs.writeFileSync(file, text);
    snap.savedTo = file;
  }
  return {
    taken: { index: snap.id, label: snap.label, bytes: snap.bytes, at: snap.at, savedTo: snap.savedTo },
    origin: ctx.provenanceView(snap.provenance),
    evicted: evicted.length ? evicted : undefined,
    ms: Date.now() - t0
  };
}

export function register(ctx: ToolContext): void {
  ctx.tool(
    "snapshot",
    {
      title: "Snapshots, undo and redo",
      description:
        "Whole-map history kept in server memory (survives browser relaunches, not server restarts). take {label?, saveTo?} stores the current map (about 1 s; take one before any multi-step or risky change). list shows snapshots {index,label,at,bytes,origin} and the auto-undo stack: every mutating tool (edit, add, paint_cells, generate/regenerate, load_map, eval unless readOnly, display, snapshot restore) pushes the state from before it ran, listed newest first as {n, op, args, at}. restore {index|label} loads a snapshot (itself undoable). undo {n?} rolls back n mutating calls (default 1); redo {n?} replays them. drop {index|label} frees one. map_info since:<index|label> diffs against a snapshot.",
      inputSchema: z.object({
        action: z.enum(["take", "list", "drop", "restore", "undo", "redo"]),
        label: z.string().min(1).max(80).optional(),
        index: z
          .union([z.number().int().min(1), z.string()])
          .optional()
          .describe("Snapshot index (or label)"),
        n: z.number().int().min(1).max(50).optional().describe("undo/redo: number of steps (default 1)"),
        saveTo: z.string().optional().describe("take: also write the .map file (under TUPAIA_OUT if relative)")
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: META_TEXT_HEAVY,
      kind: "heavy"
    },
    async (args, scope) => {
      const snaps = ctx.snapshots;
      switch (args.action) {
        case "take":
          return take(ctx, scope, args.label, args.saveTo);
        case "list":
          return { ...snaps.listing(), current: ctx.provenanceView() };
        case "drop": {
          const ref = args.index ?? args.label;
          if (ref === undefined) throw new ToolError("BAD_ARGS", "drop needs index or label");
          const s = snaps.drop(ref);
          if (!s)
            throw new ToolError("NOT_FOUND", `no snapshot '${ref}'`, {
              candidates: snaps.listing().snapshots.map(x => ({ i: x.index, name: x.label }))
            });
          await scope.call("dropBaseline", { key: s.baselineKey }, { noAlerts: true });
          return { dropped: { index: s.id, label: s.label }, remaining: snaps.snapshots.length };
        }
        case "restore": {
          const ref = args.index ?? args.label;
          if (ref === undefined) throw new ToolError("BAD_ARGS", "restore needs index or label");
          const s = snaps.find(ref);
          if (!s)
            throw new ToolError("NOT_FOUND", `no snapshot '${ref}'`, {
              candidates: snaps.listing().snapshots.map(x => ({ i: x.index, name: x.label }))
            });
          await scope.pushUndo("snapshot restore", { index: s.id, label: s.label });
          const summary = await scope.loadMap({ text: s.text }, true);
          // the app stamps a new map id on every load (showStatistics), so re-record it
          snaps.provenance = {
            ...s.provenance,
            restoredFrom: `snapshot ${s.id}${s.label ? ` '${s.label}'` : ""}`,
            mapId: mapIdOf(summary)
          };
          return {
            restored: { index: s.id, label: s.label, at: s.at },
            map: brief(summary),
            origin: ctx.provenanceView()
          };
        }
        case "undo": {
          const n = args.n ?? 1;
          const current = await scope.mapText();
          const plan = snaps.planUndo(n, current);
          if (!plan) throw new ToolError("REFUSED", `cannot undo ${n}: the undo stack holds ${snaps.undoStack.length}`);
          const summary = await scope.loadMap({ text: plan.load.text }, true);
          const dropped = snaps.commitUndo(plan);
          snaps.provenance.mapId = mapIdOf(summary);
          await scope.call("dropBaseline", { keys: dropped }, { noAlerts: true });
          return {
            undone: plan.undone.map(e => ({ op: e.op, args: e.argsSummary, at: e.at })),
            map: brief(summary),
            origin: ctx.provenanceView(),
            undoLeft: snaps.undoStack.length,
            redoAvailable: snaps.redoStack.length
          };
        }
        case "redo": {
          const n = args.n ?? 1;
          const entries = snaps.planRedo(n);
          if (!entries)
            throw new ToolError("REFUSED", `cannot redo ${n}: the redo stack holds ${snaps.redoStack.length}`);
          const current = await scope.mapText();
          // the first undo entry the redo creates holds the current page state: baseline it now
          const preKey = snaps.nextHistKey;
          await scope.call("setBaseline", { key: preKey }, { noAlerts: true });
          let summary: Record<string, unknown>;
          try {
            summary = await scope.loadMap({ text: entries[entries.length - 1].text }, true);
          } catch (e) {
            await scope.call("dropBaseline", { key: preKey }, { noAlerts: true }).catch(() => {});
            throw e;
          }
          const { dropped } = snaps.commitRedo(entries, current);
          snaps.provenance.mapId = mapIdOf(summary);
          if (dropped.length) await scope.call("dropBaseline", { keys: dropped }, { noAlerts: true });
          return {
            redone: entries.map(e => ({ op: e.op, args: e.argsSummary })),
            map: brief(summary),
            origin: ctx.provenanceView(),
            undoDepth: snaps.undoStack.length,
            redoLeft: snaps.redoStack.length
          };
        }
        default:
          throw new ToolError("BAD_ARGS", "unknown action");
      }
    }
  );
}

defineTools("history", register);
