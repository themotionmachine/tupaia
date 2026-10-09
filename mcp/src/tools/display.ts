// display: persistent layer visibility, layer presets, style presets and style rules.
// (screenshot {layers} changes layers for one shot only; display changes them for good.)
import { z } from "zod";
import type { ToolContext } from "../context.ts";
import { takeResolved } from "../ops.ts";
import { ToolError } from "../result.ts";
import { LayerName, TIMEOUTS, TimeoutMs } from "../schemas.ts";
import { defineTools } from "./registry.ts";

/** Per-group label visibility override, stored on the SVG group (data-min-size / data-max-size / data-always-show). */
const LabelOverride = z.strictObject({
  minSize: z
    .number()
    .min(0)
    .max(1000)
    .nullable()
    .optional()
    .describe(
      "hide the group while its on-screen size (px) is under this; 0 = no lower bound (the upper bound still applies); null = app default (6, emblems 25)"
    ),
  maxSize: z
    .number()
    .min(0)
    .max(5000)
    .nullable()
    .optional()
    .describe("hide the group while its on-screen size (px) is over this; null = app default (60, emblems 300)"),
  alwaysShow: z
    .boolean()
    .nullable()
    .optional()
    .describe("true: never auto-hide (skips both bounds, so minSize/maxSize do nothing); false/null: automatic rule")
});

export function register(ctx: ToolContext): void {
  ctx.tool(
    "display",
    {
      title: "Layers and style",
      description:
        "Change what the map shows, persistently (undoable). on/off: layers to turn on/off (idempotent); only: exactly these layers on, all others off; layersPreset: an app preset (political, cultural, religions, provinces, biomes, heightmap, physical, poi, goods, trade, military, emblems, landmass); stylePreset: an app style (default, ancient, gloom, pale, light, watercolor, clean, atlas, darkSeas, cyberpunk, night, monochrome) or a saved custom style; styleRules: {'#selector': {attribute: value}} applied like a style preset fragment (e.g. {'#states': {opacity: 0.6}}). labels: {'<group>': {minSize?, maxSize?, alwaysShow?} | null} overrides the zoom rule that hides a label group while its on-screen size is under 6 px (most labels at full-map zoom) or over 60 px. Groups: burg label groups (capital, city, town, village, ...), states, addedLabels, custom label groups, burgEmblems/provinceEmblems/stateEmblems (bounds 25 and 300); '*' = every label group that exists now (not ones made later), 'emblems' = the three emblem groups; null clears. Saved with the map. Returns labels {zoom, visible:{before,after,of,inView}, groups:{g:{zoom: range it shows at, autoZoom, visible, of}}} and a note when nothing changed at this zoom; labels:'list' reads the overrides without changing anything. Precedence: layersPreset, then only, then on/off. Returns layersOn and what changed. Take a screenshot afterwards.",
      inputSchema: z.object({
        on: z.array(LayerName).optional(),
        off: z.array(LayerName).optional(),
        only: z.array(LayerName).optional(),
        layersPreset: z.string().optional(),
        stylePreset: z.string().optional(),
        styleRules: z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).optional(),
        labels: z
          .union([z.literal("list"), z.record(z.string(), LabelOverride.nullable())])
          .optional()
          .describe("per-group label visibility overrides, or 'list' to read them"),
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
      if (rest.labels === "list") {
        // a read: no undo entry, no sketch record
        if (Object.entries(rest).some(([k, v]) => k !== "labels" && v !== undefined))
          throw new ToolError("BAD_ARGS", "labels:'list' only reads; pass it alone");
        return scope.call<Record<string, unknown>>(
          "display",
          { labels: "list" },
          { timeoutMs: timeoutMs ?? TIMEOUTS.view }
        );
      }
      const check = await scope.call<{ labelsNoop?: Record<string, unknown> }>("display", {
        ...rest,
        phase: "validate"
      });
      if (check.labelsNoop)
        // already exactly so: nothing to undo or to log
        return {
          labels: check.labelsNoop,
          note: "unchanged: the groups already carry this override (no undo entry, nothing recorded)"
        };
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
