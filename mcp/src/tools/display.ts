// display: persistent layer visibility, layer presets, style presets and style rules.
// (screenshot {layers} changes layers for one shot only; display changes them for good.)
import { z } from "zod";
import type { ToolContext } from "../context.ts";
import { takeResolved } from "../ops.ts";
import { ToolError } from "../result.ts";
import { LayerName, TIMEOUTS, TimeoutMs } from "../schemas.ts";
import { defineTools } from "./registry.ts";

/** Per-group label visibility override, stored on the SVG group (data-min-size / data-always-show). */
const LabelOverride = z.strictObject({
  minSize: z
    .number()
    .min(0)
    .max(1000)
    .nullable()
    .optional()
    .describe("hide the group while its on-screen size is under this many px; 0 = never; null = app default (6)"),
  alwaysShow: z
    .boolean()
    .nullable()
    .optional()
    .describe("true: never auto-hide (any zoom); false/null: back to the automatic rule")
});

export function register(ctx: ToolContext): void {
  ctx.tool(
    "display",
    {
      title: "Layers and style",
      description:
        "Change what the map shows, persistently (undoable). on/off: layers to turn on/off (idempotent); only: exactly these layers on, all others off; layersPreset: an app preset (political, cultural, religions, provinces, biomes, heightmap, physical, poi, goods, trade, military, emblems, landmass); stylePreset: an app style (default, ancient, gloom, pale, light, watercolor, clean, atlas, darkSeas, cyberpunk, night, monochrome) or a saved custom style; styleRules: {'#selector': {attribute: value}} applied like a style preset fragment (e.g. {'#states': {opacity: 0.6}}). labels: {'<group>': {minSize?, alwaysShow?} | null} overrides the zoom rule that hides small labels (an on-screen size under 6 px, i.e. most labels at full-map zoom); groups are the burg label groups (capital, city, town, village, ...), states, addedLabels, custom label groups, or burgEmblems/provinceEmblems/stateEmblems (default 25); '*' = every label group; null clears. It is saved with the map. Returns labels {visible:{before,after,of}, groups}. Precedence: layersPreset, then only, then on/off. Returns layersOn and what changed. Take a screenshot afterwards.",
      inputSchema: z.object({
        on: z.array(LayerName).optional(),
        off: z.array(LayerName).optional(),
        only: z.array(LayerName).optional(),
        layersPreset: z.string().optional(),
        stylePreset: z.string().optional(),
        styleRules: z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).optional(),
        labels: z.record(z.string(), LabelOverride.nullable()).optional(),
        timeoutMs: TimeoutMs
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      kind: "view"
    },
    async (args, scope) => {
      const { timeoutMs, ...rest } = args;
      if (!Object.values(rest).some(v => v !== undefined))
        throw new ToolError(
          "BAD_ARGS",
          "nothing to do: pass on, off, only, layersPreset, stylePreset, styleRules or labels"
        );
      await scope.call("display", { ...rest, phase: "validate" });
      await scope.pushUndo("display", rest);
      let out: Record<string, unknown>;
      try {
        out = await scope.call<Record<string, unknown>>("display", rest, {
          mutating: true,
          timeoutMs: timeoutMs ?? TIMEOUTS.view
        });
      } finally {
        ctx.snapshots.noteMutation();
      }
      const resolved = takeResolved(out);
      await scope.record("display", args, resolved, { out });
      return { ...out, undo: "snapshot {action:'undo'} reverts this call" };
    }
  );
}

defineTools("display", register);
