// Biomes (track 'biomes'). No tools of its own: edit/add take type 'biome' (bridge-ext/biomes.js
// FIELDS.biome / ADD.biome), paint_cells takes feather, and regenerate takes parts:['biomes']
// with the options below. This module holds the regenerate-biomes options schema, the sketch
// recording of that regenerate, and its replay spec.
//
// A regenerate of biomes alone is logged as op tool 'regenerate:biomes' with a literal resolved
// form {cells: {<biome id>: [cell ids]}, graph}: exactly the cells it changed, so replay sets
// the same cells (through bridge setBiomeCells) whatever the target's climate is. Combined with
// other parts it stays a plain, non-replayable regenerate.
import { z } from "zod";
import type { CallScope } from "../context.ts";
import { type Resolved, type Rewriter, registerReplayable } from "../ops.ts";
import { ToolError } from "../result.ts";
import { EntityRef } from "../schemas.ts";
import { SelectSchema } from "./edit.ts";

export const BIOMES_OP = "regenerate:biomes";

export const BiomesRegenOptions = z
  .strictObject({
    from: z
      .enum(["climate", "current"])
      .optional()
      .describe(
        "'climate' (default): re-derive from temperature and moisture like the generator; 'current': only smooth / merge the biomes as they are"
      ),
    noise: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Edge noise 0..1 (0 = exactly the generator's biomes); breaks the straight 1° bands"),
    mode: z
      .enum(["warp", "jitter"])
      .optional()
      .describe(
        "'warp' (default): read the climate at a noise-displaced point, so edges wiggle and biome totals stay close; 'jitter': add noise to temperature (±4 °C) and moisture (±6), which grows dry biomes"
      ),
    scale: z.number().min(10).max(20000).optional().describe("Noise feature size in map px (default map size / 12)"),
    smooth: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe("Majority-filter passes over land boundaries (water, river cells and kept cells are left alone)"),
    minRegion: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .optional()
      .describe("Merge connected regions of one biome under this many cells into their most common neighbour"),
    seed: z
      .union([z.number().int(), z.string().min(1)])
      .optional()
      .describe("Noise seed (default: derived from the map seed; returned)"),
    keepPainted: z
      .union([z.boolean(), z.literal("custom")])
      .optional()
      .describe(
        "true (default): keep custom biomes and every land cell whose biome differs from its noise-free climate biome (painted, edited, or changed by an earlier noisy regenerate: undo that one to re-roll); 'custom': keep custom biomes only; false: re-derive everything"
      ),
    keepRivers: z.boolean().optional().describe("Default true: smoothing and minRegion leave river cells alone"),
    keep: z.array(EntityRef).optional().describe("Biomes whose cells keep them everywhere, e.g. ['Wetland']"),
    exclude: SelectSchema.optional().describe("Cells that keep their biome (a 'locked' area)"),
    select: SelectSchema.optional().describe("Only these cells change (neighbours outside still count for smoothing)"),
    redraw: z.literal(false).optional().describe("false = do not redraw the biomes layer")
  })
  .describe(
    "Options for parts:['biomes']. Kept cells neither change nor spread; the result's keptBy counts them by reason."
  );

export type BiomesRegenArgs = z.infer<typeof BiomesRegenOptions>;

interface BiomesResolved {
  cells: Record<string, number[]>;
  graph?: string | null;
  /** for the op summary only (also after a rebase) */
  seed?: number;
  net?: Record<string, number>;
}

const isBiomesResolved = (r: unknown): r is BiomesResolved =>
  !!r && typeof r === "object" && !!(r as BiomesResolved).cells && typeof (r as BiomesResolved).cells === "object";

/** Before the undo point: check the biomes options in the page (nothing changes). */
export async function validateBiomesRegen(
  scope: CallScope,
  parts: readonly string[],
  opts: BiomesRegenArgs | undefined
): Promise<Record<string, unknown> | null> {
  if (opts !== undefined && !parts.includes("biomes"))
    throw new ToolError("BAD_ARGS", "biomes options need 'biomes' in parts");
  if (!parts.includes("biomes")) return null;
  const { phase: _phase, ...plan } = await scope.call<Record<string, unknown>>("defineBiomes", {
    ...(opts ?? {}),
    phase: "validate"
  });
  return plan;
}

/**
 * After the regenerate: strip the literal form from details.biomes (it goes to the sketch log,
 * not to the client) and, when biomes was the only part, log the call as a replayable op.
 */
export async function recordBiomesRegen(
  scope: CallScope,
  args: Record<string, unknown>,
  parts: readonly string[],
  out: Record<string, unknown>
): Promise<void> {
  const details = out.details as Record<string, Record<string, unknown>> | undefined;
  const b = details?.biomes;
  if (!b) return;
  const resolved = b.resolved;
  delete b.resolved;
  if (parts.length !== 1 || !isBiomesResolved(resolved)) return;
  if (!Object.keys(resolved.cells).length)
    await scope.record(BIOMES_OP, args, null, {
      replayable: true,
      noop: true,
      summary: "regenerate biomes changed no cells (no-op)."
    });
  else await scope.record(BIOMES_OP, args, resolved as unknown as Resolved, { out: b });
}

registerReplayable(BIOMES_OP, {
  bridgeFn: "setBiomeCells",
  bridgeArgs: r => {
    const b = r as unknown as BiomesResolved;
    return { cells: b.cells, ...(b.seed !== undefined ? { seed: b.seed } : {}) };
  },
  rewrite: (r: Resolved, rw: Rewriter) => {
    const b = r as unknown as BiomesResolved;
    const cells: Record<string, number[]> = {};
    for (const [k, list] of Object.entries(b.cells)) cells[String(rw.id("biome", Number(k)))] = list;
    return { ...b, cells } as unknown as Resolved;
  },
  summarize: (r, out, args) => {
    const b = r as unknown as BiomesResolved | null;
    const n = b ? Object.values(b.cells).reduce((s, l) => s + l.length, 0) : Number(out?.changed ?? 0);
    const o = ((args as { biomes?: BiomesRegenArgs } | undefined)?.biomes ?? {}) as BiomesRegenArgs;
    const seed = b?.seed ?? (o.noise ? out?.seed : undefined);
    const how = [
      o.from === "current" ? "cleaned up current biomes" : "re-derived biomes from the climate",
      o.noise ? `${o.mode ?? "warp"} noise ${o.noise}` : "",
      o.smooth ? `${o.smooth} smoothing passes` : "",
      o.minRegion ? `regions under ${o.minRegion} cells merged` : "",
      seed !== undefined ? `seed ${seed}` : ""
    ].filter(Boolean);
    const net = Object.entries(b?.net ?? (out?.net as Record<string, number> | undefined) ?? {})
      .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))
      .slice(0, 4)
      .map(([k, d]) => `${k} ${d > 0 ? "+" : ""}${d}`);
    return `Regenerated biomes (${how.join(", ")}): ${n} cells changed${net.length ? ` (${net.join(", ")})` : ""} (replayed as a literal cell list).`;
  },
  unreplayable: r =>
    isBiomesResolved(r) ? null : "this biomes regenerate has no literal cell list, so it cannot be replayed",
  timeout: "heavy"
});
