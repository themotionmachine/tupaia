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
  "regrid rebuilt the cell grid at a new density (every cell id changed; entities were moved by coordinates), so it and later literal cell lists cannot be replayed; the sketch is promoted as the page map";
NOT_REPLAYABLE.regrid = REGRID_REASON;

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
        "Rebuild the map at another cell density (points, as in Options > cells density) and keep it the same map: shared-map lineage, ids, names, notes and labels stay; burgs, markers, states, provinces, cultures, religions, routes, rivers and zones are moved by coordinates. density: slider position 1-13 (4 = 10K, 6 = 30K, 8 = 50K) or a points count 1000-100000. Uses the app's Transform resampler (full extent, scale 1) with fixes: heights 'interpolate' (default; a smooth coastline from the old surface) or 'nearest' (the app's own, keeps the old cells' staircase); burgs that share a new cell move to a free neighbour; ice 'keep' (default) or 'regenerate'. Regenerated: temperature, lakes/coast features (names carried over), relief icons, ocean layers, economy deals; every layer is redrawn from the data. Returns cells before/after, per type kept/moved/lost with the names of anything lost, warnings and the new file size; details:true lists moved burgs and markers. dryRun:true estimates cells and file size without changing anything. One auto-undo entry. In a sketch it is logged as not replayable (blob-only; sketch_promote still works). Screenshot afterwards to check the coastline.",
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
      const timeoutMs = given ?? (args.density > 50000 ? TIMEOUT_CAP_MS : TIMEOUTS.heavy);
      const plan = await scope.call<Plan>("regrid", { ...bridgeArgs, phase: "validate" }, { timeoutMs });
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
