// regrid: change the map's cell density and keep it the same map (lineage, ids, names), moving
// entities by coordinates. The page side is src/bridge-ext/regrid.js (the app's Resample.process
// at full extent and scale 1, plus the fixes listed there). validate -> (dryRun? estimate) ->
// one auto-undo entry -> apply. Logged in a sketch as not replayable (every cell id changes).
import { z } from "zod";
import type { ToolContext } from "../context.ts";
import { NOT_REPLAYABLE } from "../ops.ts";
import { META_TEXT_HEAVY, ToolError } from "../result.ts";
import { TIMEOUT_CAP_MS, TIMEOUTS, TimeoutMs } from "../schemas.ts";
import { defineTools } from "./registry.ts";

export const REGRID_REASON =
  "regrid rebuilt the cell grid (every cell id changed), so the log cannot be replayed; the page map is promoted as is";
NOT_REPLAYABLE.regrid = REGRID_REASON;

/** The Options "cells density" slider: position -> points (same table as the bridge). */
const SLIDER_POINTS: Record<number, number> = {
  1: 1000,
  2: 2000,
  3: 5000,
  4: 10000,
  5: 20000,
  6: 30000,
  7: 40000,
  8: 50000,
  9: 60000,
  10: 70000,
  11: 80000,
  12: 90000,
  13: 100000
};

interface Plan {
  cells: { now: number; est: number };
  gridCells: { now: number; after: number };
  bytes?: { now: number; est: number };
  warnings?: string[];
  [k: string]: unknown;
}

interface Applied {
  cells: { before: number; after: number };
  mapId: number | null;
  [k: string]: unknown;
}

export function register(ctx: ToolContext): void {
  ctx.tool(
    "regrid",
    {
      title: "Change the cell density, keep the map",
      description:
        "Rebuild the map at another cell density (points, as in Options > cells density) and keep it the same map: shared-map lineage (map id), names, notes and labels stay; burgs, markers, states, provinces, cultures, religions, routes, rivers and zones are moved by coordinates. density: slider position 1-13 (4 = 10K, 6 = 30K, 8 = 50K) or a points count 1000-100000. Uses the app's Transform resampler (full extent, scale 1) with fixes: heights 'interpolate' (default; a smooth coastline from the old surface, old lakes/islands kept) or 'nearest' (the app's own, keeps the old cells' staircase); burgs that share a new cell move to a free neighbour, a burg's cell joins its state, every area keeps a center inside it, small areas and zones keep a cell; ice and relief icons 'keep' (default: as drawn) or 'regenerate'/'redraw'. Recomputed: temperature, lakes/coast features (names carried over), economy flows (burg treasuries kept), territory statistics; rivers traced again as contiguous cell paths along their old lines (ids, names, confluences kept; result rivers); biomes re-derived from the climate, custom and painted ones carried where they were (result biomes; biomes:'climate'|'keep'); the other layers are redrawn from the data, but a layer that was on and undrawn stays undrawn (layers.keptEmpty) and big count changes are listed (layers.redrawn). Returns cells before/after, entities per type kept/moved/lost (lostNames; maxAreaChangeOf), feature lakes/islands/oceans, fixed (counts), warnings, the new file size and lineage; details:true lists moved burgs/markers, the largest area changes and a legend of the heights counters. dryRun:true (allowed with an editor open) estimates cells, file size and, when lowering, atRisk (burgs that will share a cell, lakes/islands smaller than a cell); it changes nothing. One auto-undo entry. In a sketch it is logged as not replayable (blob-only: no rebase; sketch_promote directly while the shared map is still at the sketch's base). Screenshot afterwards to check the coastline.",
      inputSchema: z.object({
        density: z
          .number()
          .int()
          .min(1)
          .max(100000)
          .describe("Slider position 1-13 or a points count 1000-100000 (e.g. 30000)"),
        heights: z
          .enum(["interpolate", "nearest"])
          .optional()
          .describe("interpolate (default): smooth coastline; nearest: copy the nearest old cell (blocky)"),
        ice: z.enum(["keep", "regenerate"]).optional().describe("keep (default) the ice as drawn, or regenerate it"),
        relief: z
          .enum(["keep", "redraw"])
          .optional()
          .describe("keep (default) the relief icons as drawn, or redraw them for the new cells (denser)"),
        biomes: z
          .enum(["redefine", "climate", "keep"])
          .optional()
          .describe(
            "redefine (default): re-derive biomes from the new heights, temperature, precipitation and rivers (as recalculate:'biomes'), but a cell whose nearest old cell had a custom biome or a painted one (differs from its climate biome: regenerate biomes' keepPainted) carries it; result biomes {redefined, carriedCustom, carriedPainted, changed (vs a carry-over)}. climate: carry custom biomes only. keep: every new cell takes its old cell's biome (old cell edges show on a finer grid; a warning counts the cells off their climate)"
          ),
        details: z.boolean().optional().describe("Also list moved burgs and markers"),
        dryRun: z.boolean().optional().describe("Estimate cells and file size; change nothing"),
        timeoutMs: TimeoutMs
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      _meta: META_TEXT_HEAVY,
      kind: "heavy"
    },
    async (args, scope) => {
      const { dryRun, timeoutMs: given, ...bridgeArgs } = args;
      // big grids take longer: rebuild, redraw and the before/after inventory
      const points = args.density <= 13 ? (SLIDER_POINTS[args.density] ?? 0) : args.density;
      const timeoutMs = given ?? (points > 50000 ? TIMEOUT_CAP_MS : TIMEOUTS.heavy);
      const plan = await scope.call<Plan>(
        "regrid",
        { ...bridgeArgs, dryRun: !!dryRun, phase: "validate" },
        { timeoutMs }
      );
      const { phase: _phase, ...planBody } = plan;
      if (dryRun) return { dryRun: true, ...planBody, note: "dry run: nothing was changed" };

      await ctx.verifyProvenance();
      const prov = ctx.snapshots.provenance;
      await scope.pushUndo("regrid", args);
      let out: Applied;
      try {
        out = await scope.call<Applied>("regrid", { ...bridgeArgs, phase: "apply" }, { mutating: true, timeoutMs });
      } catch (e) {
        if (e instanceof ToolError)
          e.message += " The map may be partly rebuilt; snapshot {action:'undo'} returns to the previous grid.";
        throw e;
      } finally {
        ctx.snapshots.noteMutation();
      }
      await scope.record("regrid", args, null, {
        replayable: false,
        reason: REGRID_REASON,
        summary: `Regridded the map from ${out.cells.before} to ${out.cells.after} cells (density ${args.density}).`
      });
      const pageId = await ctx.pageMapId();
      const claimsShared = (prov.kind === "shared" || prov.kind === "sketch") && typeof prov.sharedVersion === "number";
      let lineage: string;
      if (claimsShared && pageId !== null && pageId === prov.mapId)
        lineage = `kept: still derived from the shared map v${prov.sharedVersion} (same map id); shared_save needs no replaceWithUnrelated`;
      else if (claimsShared)
        lineage = `LOST: the page map id changed (${prov.mapId} -> ${pageId}); shared_save will call it unrelated`;
      else lineage = `unchanged: origin '${prov.kind}' (not the shared map)`;
      return { ...out, lineage, undo: "snapshot {action:'undo'} returns to the previous grid" };
    }
  );
}

defineTools("regrid", register);
