// generate_map (new map from a seed and options) and regenerate (re-run generator parts on
// the current map). Both take an auto-undo entry first.
import { z } from "zod";
import type { ToolContext } from "../context.ts";
import { planRegen, RegenEmblems, RegenProvinces, recordRegen } from "../regen.ts";
import { META_TEXT_HEAVY, ToolError } from "../result.ts";
import { TIMEOUTS, TimeoutMs } from "../schemas.ts";
import { BiomesRegenOptions, recordBiomesRegen, validateBiomesRegen } from "./biomes.ts";
import { changesSinceUndo } from "./edit.ts";
import { defineTools } from "./registry.ts";

export const REGEN_PARTS = [
  "rivers",
  "biomes",
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
  "production"
] as const;

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
        "Re-run generator parts on the current map (heightmap and cells stay). parts run in dependency order regardless of the order given: rivers, biomes, population, cultures, burgs, states, provinces, routes, religions, emblems, military, markers, zones, ice, goods, markets, economy, production. Locked entities are kept where the app supports locks. Several parts turn their layer on (reported in layerChanges); restoreLayers:true turns them back. states reseeds the random stream, so it is not reproducible. One auto-undo entry. " +
        "Parts with options (see each option object): biomes re-derives biomes from the climate with deterministic edge noise, smoothing and small-region merging, keeping painted and custom biomes (result in details.biomes); " +
        "provinces {states?, centres?:[{state, burg|at, name?, formName?, fullName?}], count?, ratio?, keepLocked?, lockedStates?, crossForeign?}: new provinces for those states only (default every unlocked state, by the generator's rules; centres: exactly those; count: N per state, of balanced area), also for hand-made states with few or no burgs; " +
        "emblems {states?, provinces?, burgs?, shieldOnly?, keepLocked?, lockedStates?, stateCulture?}: new coats of arms with each culture's shield. " +
        "dryRun:true previews (changes nothing) for biomes alone or provinces and/or emblems. These turn no layer on, and replay in a sketch when they are the only parts (logged as literal outcomes).",
      inputSchema: z.object({
        parts: z.array(z.enum(REGEN_PARTS)).min(1),
        restoreLayers: z.boolean().optional().describe("Undo layer visibility changes made by the regenerators"),
        biomes: BiomesRegenOptions.optional().describe(
          "Options for part biomes (re-derived from temperature and moisture): noise/mode/scale/seed add deterministic edge noise (no straight 1° bands; mode 'warp' keeps biome totals close), smooth is a boundary majority filter, minRegion merges small regions; custom biomes and cells painted away from their climate biome are kept (keepPainted), as are keep:[biomes] and exclude:select, and smoothing leaves river cells alone (keepRivers); select limits the cells; from:'current' only smooths/merges. The result is in details.biomes (changed, keptBy, net per biome, seed); try seeds with dryRun, then apply once"
        ),
        provinces: RegenProvinces.optional().describe(
          "Options for part provinces: only these states' provinces are replaced (other states keep theirs; one of theirs left with no cells is removed); locked provinces keep their cells"
        ),
        emblems: RegenEmblems.optional().describe(
          "Options for part emblems: locked and custom emblems are kept (the notes name locked states skipped); a Wildlands burg or province takes its state's culture shield"
        ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            "Preview, change nothing: parts:['biomes'] alone (counts what would change), or provinces and/or emblems (the outcome in the real result's shape)"
          ),
        timeoutMs: TimeoutMs
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: META_TEXT_HEAVY,
      kind: "heavy"
    },
    async (args, scope) => {
      // options are checked in the page first (biomes.ts, regen.ts): a bad one changes nothing
      const { dryRun, ...rest } = args;
      const biomesPlan = await validateBiomesRegen(scope, args.parts, args.biomes);
      const plan = await planRegen(scope, rest, dryRun === true);
      if (dryRun) {
        if (biomesPlan && args.parts.length === 1)
          return { dryRun: true, details: { biomes: biomesPlan }, note: "dry run: nothing was changed" };
        if (plan && args.parts.every(p => p === "provinces" || p === "emblems"))
          return { dryRun: true, ...plan, note: "dry run: nothing was changed" };
        throw new ToolError(
          "BAD_ARGS",
          "dryRun works with parts provinces and/or emblems only, or parts:['biomes'] alone. Nothing was changed."
        );
      }
      await scope.pushUndo("regenerate", args);
      let out: Record<string, unknown>;
      try {
        out = await scope.call<Record<string, unknown>>("regenerate", rest, {
          mutating: true,
          timeoutMs: args.timeoutMs ?? TIMEOUTS.heavy
        });
      } finally {
        ctx.snapshots.noteMutation();
      }
      await recordRegen(scope, rest, out);
      await recordBiomesRegen(scope, args, args.parts, out);
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
