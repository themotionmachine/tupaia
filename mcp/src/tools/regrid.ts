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
/** territories:'regrow' at the map's own density (regrow-only: the cells stay, the borders move). */
export const REGROW_REASON =
  "regrid territories:'regrow' redrew every state, culture, religion and province border from the terrain, so the log cannot be replayed onto another base; the page map is promoted as is";

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
        "Rebuild the map at another cell density (points, as in Options > cells density) and keep it the same map: shared-map lineage (map id), names, notes and labels stay; burgs, markers, states, provinces, cultures, religions, routes, rivers and zones are moved by coordinates. density: slider position 1-13 (4 = 10K, 6 = 30K, 8 = 50K) or a points count 1000-100000. Uses the app's Transform resampler (full extent, scale 1) with fixes: heights 'interpolate' (default, smooth coast) or 'nearest' (blocky); burgs that share a new cell move to a free neighbour, a burg's cell joins its state, every area keeps a center inside it, small areas and zones keep a cell; ice and relief icons 'keep' (default: as drawn) or 'regenerate'/'redraw'. Recomputed: temperature, lakes/coast features (names carried over), economy flows (burg treasuries kept), territory statistics; rivers traced again as contiguous cell paths along their old lines (ids, names, confluences kept) and carved where they would climb (carve; result rivers.carved); biomes re-derived from the climate, custom and painted ones carried, speckles merged (minRegion; result biomes); territories:'regrow' redraws borders along the terrain; the other layers are redrawn from the data, but a layer that was on and undrawn stays undrawn (layers.keptEmpty) and big count changes are listed (layers.redrawn). Returns cells before/after, entities per type kept/moved/lost (lostNames; maxAreaChangeOf), feature lakes/islands/oceans, fixed (counts), warnings, the new file size and lineage; details:true lists moved burgs/markers, the largest area changes and a legend of the heights counters. dryRun:true (allowed with an editor open) estimates cells, file size and, when lowering, atRisk (burgs that will share a cell, lakes/islands smaller than a cell); it changes nothing. One auto-undo entry. In a sketch it is logged as not replayable (blob-only: no rebase; sketch_promote directly while the shared map is still at the sketch's base). Screenshot afterwards to check the coastline.",
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
          .describe(
            "interpolate (default): a smooth coastline sampled from the old surface, old lakes and islands kept; nearest: the app's own, copy the nearest old cell (keeps the old cells' staircase)"
          ),
        ice: z.enum(["keep", "regenerate"]).optional().describe("keep (default) the ice as drawn, or regenerate it"),
        relief: z
          .enum(["keep", "redraw"])
          .optional()
          .describe("keep (default) the relief icons as drawn, or redraw them for the new cells (denser)"),
        biomes: z
          .enum(["redefine", "climate", "keep"])
          .optional()
          .describe(
            "redefine (default): re-derive biomes from the new heights, temperature, precipitation and rivers (as recalculate:'biomes'), but a cell whose nearest old cell had a custom biome or a painted one (differs from its climate biome: regenerate biomes' keepPainted) carries it; result biomes {redefined, carriedCustom, carriedPainted, cleanup, changed (vs a carry-over)}. climate: carry custom biomes only. keep: every new cell takes its old cell's biome (old cell edges show on a finer grid; a warning counts the cells off their climate)"
          ),
        minRegion: z
          .number()
          .int()
          .min(0)
          .max(1000)
          .optional()
          .describe(
            "After the biomes are re-derived ('redefine'/'climate'): one-biome land regions under this many cells join their most common neighbouring biome (regenerate biomes' minRegion: single-cell speckles near climate thresholds); a region holding a carried custom/painted cell or a river cell stays, water is never touched. Default 3; 0 = off. Result biomes.cleanup {minRegion, regions, cells}"
          ),
        carve: z
          .boolean()
          .optional()
          .describe(
            "true (default): where a retraced river would climb (the new heights cross a ridge, mostly when lowering the density), lower its land cells to the lowest land height upstream of it on that river, so heights never rise downstream (water skipped, never below 20; a carved lake shore lowers its lake level). Only climbing cells change. Result rivers.carved {rivers, cells, maxDrop, lakesLowered?}. false: heights as interpolated; rivers.climbing counts the rivers that climb"
          ),
        territories: z
          .enum(["copy", "regrow"])
          .optional()
          .describe(
            "copy (default): every new cell takes its nearest old cell's state, culture, religion and province (the old stepped outlines survive on a finer grid). regrow: then states, cultures and religions regrow together (one label per state|culture|religion, so coinciding borders move as one line) along the terrain (cost-based spread like the app's expand: slopes, hills, mountains, costly biomes, rivers) from their cores (interior, burgs, capitals, centres) over a band of territoryBand rings along their borders, each connected piece to about its copied area; every burg keeps its state and culture, every capital and centre stays inside; a locked state keeps its cells, provinces and the cultures and religions on them (unless territoryLocked); then each state's provinces the same way inside it. Result territories {state, culture, religion: changed, maxAreaChangePct (of those with 20+ cells), lockedKept?; note?; province: changed, within15pct}. At the map's own density regrow is the whole call (mode 'regrow-only': no rebuild, heights/rivers/biomes/cell ids stay; heights, ice, relief, biomes, minRegion, carve are refused; band default 3)"
          ),
        territoryBand: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(
            "territories:'regrow': rings of new cells along the borders that move (default about 1.5 old cells, at least 3)"
          ),
        territoryLocked: z
          .boolean()
          .optional()
          .describe(
            "territories:'regrow': also regrow locked states, cultures, religions and provinces (default false: they keep their copied cells; their locks stay either way)"
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
      if (dryRun)
        return {
          dryRun: true,
          ...planBody,
          note: `dry run: nothing was changed${planBody.note ? `; ${planBody.note}` : ""}`
        };

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
      const regrowOnly = out.mode === "regrow-only";
      await scope.record("regrid", args, null, {
        replayable: false,
        reason: regrowOnly ? REGROW_REASON : REGRID_REASON,
        summary: regrowOnly
          ? `Regrew the state, culture, religion and province borders along the terrain (density unchanged, ${out.cells.after} cells).`
          : `Regridded the map from ${out.cells.before} to ${out.cells.after} cells (density ${args.density}).`
      });
      const pageId = await ctx.pageMapId();
      const claimsShared = (prov.kind === "shared" || prov.kind === "sketch") && typeof prov.sharedVersion === "number";
      let lineage: string;
      if (claimsShared && pageId !== null && pageId === prov.mapId)
        lineage = `kept: still derived from the shared map v${prov.sharedVersion} (same map id); shared_save needs no replaceWithUnrelated`;
      else if (claimsShared)
        lineage = `LOST: the page map id changed (${prov.mapId} -> ${pageId}); shared_save will call it unrelated`;
      else lineage = `unchanged: origin '${prov.kind}' (not the shared map)`;
      return {
        ...out,
        lineage,
        undo: `snapshot {action:'undo'} returns to the previous ${regrowOnly ? "borders" : "grid"}`
      };
    }
  );
}

defineTools("regrid", register);
