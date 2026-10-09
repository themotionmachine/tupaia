// generate_map (new map from a seed and options) and regenerate (re-run generator parts on
// the current map). Both take an auto-undo entry first.
import { z } from "zod";
import type { ToolContext } from "../context.ts";
import { RegenEmblems, RegenProvinces } from "../regen.ts";
import { META_TEXT_HEAVY } from "../result.ts";
import { TIMEOUTS, TimeoutMs } from "../schemas.ts";
import { runPhased } from "./edit.ts";
import { defineTools } from "./registry.ts";

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
        "Re-run generator parts on the current map (heightmap and cells stay). parts run in dependency order regardless of the order given: rivers, population, cultures, burgs, states, provinces, routes, religions, emblems, military, markers, zones, ice, goods, markets, economy, production. Locked entities are kept where the app supports locks. Several parts turn their layer on (reported in layerChanges); restoreLayers:true turns them back. states reseeds the random stream, so it is not reproducible. One auto-undo entry; dryRun:true validates and returns the plan. " +
        "provinces replaces only the unlocked provinces of its states (other provinces keep their ids and cells) and works for hand-made states with few or no burgs: provinces {states?, centres?:[{state, burg | at:Place, name?, formName?, fullName?}], count?, ratio?, keepLocked?}. Default: every unlocked state, by the generator's rules (burg provinces, then wild ones); centres: exactly those provinces, each state's land going to the nearest centre by travel cost; count: that many per state, of about equal area, each centred on its biggest burg (or a place). Province emblems use the culture's shield. " +
        "emblems {states?, provinces?, burgs?, shieldOnly?, keepLocked?} regenerates the coats of arms of those states (and by default their provinces and burgs) with each culture's shield; shieldOnly keeps the designs and only resets the shield shapes; locked and custom emblems are kept. " +
        "provinces and emblems never turn a layer on (hidden layers are noted) and record their literal outcome, so a call with only those parts replays in a sketch; any other part makes a sketch blob-only.",
      inputSchema: z.object({
        parts: z.array(z.enum(REGEN_PARTS)).min(1),
        provinces: RegenProvinces.optional().describe("Options for part provinces"),
        emblems: RegenEmblems.optional().describe("Options for part emblems"),
        restoreLayers: z.boolean().optional().describe("Undo layer visibility changes made by the regenerators"),
        dryRun: z.boolean().optional().describe("Validate and return the plan without changing anything"),
        timeoutMs: TimeoutMs
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: META_TEXT_HEAVY,
      kind: "heavy"
    },
    async (args, scope) => {
      const { dryRun, timeoutMs, ...rest } = args;
      // dependency order: the page runs the parts in the order given
      const parts = REGEN_PARTS.filter(p => args.parts.includes(p));
      // validate -> auto-undo -> apply -> sketch log: the literal provinces/emblems outcome is
      // replayable, any other part is logged as not replayable (regen.ts)
      return runPhased(
        ctx,
        scope,
        "regenerate",
        args,
        "regenerate",
        { ...rest, parts },
        { dryRun, timeoutMs: timeoutMs ?? TIMEOUTS.heavy }
      );
    }
  );
}

defineTools("generate", register);
