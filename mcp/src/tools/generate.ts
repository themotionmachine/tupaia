// generate_map (new map from a seed and options) and regenerate (re-run generator parts on
// the current map). Both take an auto-undo entry first.
import { z } from "zod";
import type { ToolContext } from "../context.ts";
import { registerReplayable } from "../ops.ts";
import { META_TEXT_HEAVY, ToolError } from "../result.ts";
import { TIMEOUTS, TimeoutMs } from "../schemas.ts";
import { changesSinceUndo } from "./edit.ts";
import { defineTools } from "./registry.ts";
import { RELIEF_REPLAY, ReliefParams, regenerateRelief } from "./relief.ts";

export const REGEN_PARTS = [
  "rivers",
  "population",
  "cultures",
  "burgs",
  "states",
  "provinces",
  "routes",
  "religions",
  "emblems",
  "military",
  "markers",
  "zones",
  "ice",
  "goods",
  "markets",
  "economy",
  "production",
  "relief"
] as const;

// relief-only regenerate calls are seeded and replay in sketches (tools/relief.ts); other parts do not
registerReplayable("regenerate", RELIEF_REPLAY);

export function register(ctx: ToolContext): void {
  ctx.tool(
    "generate_map",
    {
      title: "Generate a new map",
      description:
        "Replace the page's map with a newly generated one (undoable). The same seed and options give the same map (compare the returned digest). Options given here are set in the app's options panel and locked so the generator does not randomise them; options locked by an earlier generate_map call but not given now are unlocked again. cells is a density 1-13 (4 = 10K cells) or a cell count; cultures is limited by the culture set (e.g. european 15). width/height set the map size in px and resize the browser viewport to match. options sets any other option input by element id (e.g. {temperatureEquatorInput: 25}). Returns the seed, counts and digest; take a screenshot to see it.",
      inputSchema: z.object({
        seed: z
          .union([z.string().min(1), z.number().int()])
          .optional()
          .describe("Seed (random when omitted)"),
        template: z
          .string()
          .optional()
          .describe("Heightmap template id, e.g. continents, archipelago, pangea, volcano"),
        cells: z.number().int().min(1).max(100000).optional().describe("Density 1-13 or a cell count (1000-100000)"),
        states: z.number().int().min(0).max(100).optional(),
        provincesRatio: z.number().int().min(0).max(100).optional(),
        religions: z.number().int().min(0).max(50).optional(),
        sizeVariety: z.number().min(0).max(10).optional(),
        growthRate: z.number().min(0.1).max(2).optional(),
        burgs: z.number().int().min(0).max(999).optional().describe("Number of burgs (manors); 1000 = auto"),
        cultures: z.number().int().min(1).max(100).optional(),
        culturesSet: z
          .string()
          .optional()
          .describe("world, european, oriental, english, antique, highFantasy, darkFantasy, random"),
        width: z.number().int().min(240).max(8192).optional(),
        height: z.number().int().min(135).max(8192).optional(),
        options: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Other option inputs by element id"),
        timeoutMs: TimeoutMs
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      _meta: META_TEXT_HEAVY,
      kind: "heavy"
    },
    async (args, scope) => {
      const timeoutMs = args.timeoutMs ?? TIMEOUTS.heavy;
      await scope.call("generateMap", { ...args, phase: "validate" });
      await scope.pushUndo("generate_map", args);
      if (args.width !== undefined || args.height !== undefined) {
        const vp = ctx.browser.viewport;
        await ctx.browser.setViewport(args.width ?? vp.width, args.height ?? vp.height);
      }
      let out: Record<string, unknown>;
      try {
        out = await scope.call<Record<string, unknown>>(
          "generateMap",
          { ...args, timeoutMs: Math.max(5000, timeoutMs - 5000) },
          { mutating: true, timeoutMs }
        );
      } catch (e) {
        // The app may have undrawn and regenerated before failing (APP_ALERT 'Generation error'):
        // keep the provenance only if the page still holds the same map.
        const id = await ctx.pageMapId();
        const recorded = ctx.snapshots.provenance.mapId;
        if (id === null || recorded === undefined || recorded === null || id !== recorded)
          ctx.snapshots.setProvenance({ kind: "unknown", mapId: id });
        else ctx.snapshots.noteMutation();
        throw e;
      }
      ctx.snapshots.setProvenance({
        kind: "generated",
        seed: String(out.seed ?? args.seed ?? ""),
        mapId: await ctx.pageMapId()
      });
      return { ...out, origin: ctx.provenanceView(), undo: "snapshot {action:'undo'} returns to the previous map" };
    }
  );

  ctx.tool(
    "regenerate",
    {
      title: "Regenerate parts of the map",
      description:
        "Re-run generator parts on the current map (heightmap and cells stay). parts run in dependency order regardless of the order given: rivers, population, cultures, burgs, states, provinces, routes, religions, emblems, military, markers, zones, ice, goods, markets, economy, production, relief. Locked entities are kept where the app supports locks. Several parts turn their layer on (reported in layerChanges); restoreLayers:true turns them back. states reseeds the random stream, so it is not reproducible. relief redraws the relief icons seeded (same settings, same icons) with relief:{density, perBiome, minHeight, exclude, nearBurgs, seed, onLoad}; the settings are stored with the map and every later draw uses them. parts:['relief'] alone is replayable in sketches and takes dryRun (returns the stored settings before/after; with no relief keys it just reads them). One auto-undo entry.",
      inputSchema: z.object({
        parts: z.array(z.enum(REGEN_PARTS)).min(1),
        restoreLayers: z.boolean().optional().describe("Undo layer visibility changes made by the regenerators"),
        relief: ReliefParams.optional(),
        dryRun: z
          .boolean()
          .optional()
          .describe("parts:['relief'] only: return the relief settings before/after, draw nothing"),
        timeoutMs: TimeoutMs
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: META_TEXT_HEAVY,
      kind: "heavy"
    },
    async (args, scope) => {
      const reliefOnly = args.parts.every(p => p === "relief");
      if (args.relief !== undefined && !args.parts.includes("relief"))
        throw new ToolError("BAD_ARGS", "relief settings need 'relief' in parts. Nothing was changed.");
      if (args.dryRun && !reliefOnly) throw new ToolError("BAD_ARGS", "dryRun works with parts:['relief'] only");
      if (reliefOnly) return regenerateRelief(ctx, scope, args);
      await scope.pushUndo("regenerate", args);
      let out: Record<string, unknown>;
      try {
        out = await scope.call<Record<string, unknown>>("regenerate", args, {
          mutating: true,
          timeoutMs: args.timeoutMs ?? TIMEOUTS.heavy
        });
      } finally {
        ctx.snapshots.noteMutation();
      }
      const changes = await changesSinceUndo(ctx, scope);
      return {
        ...out,
        ...(changes !== undefined ? { changes } : {}),
        undo: "snapshot {action:'undo'} reverts this call"
      };
    }
  );
}

defineTools("generate", register);
