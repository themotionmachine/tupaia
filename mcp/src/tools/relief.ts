// Relief icons (track 'relief'): regenerate {parts:['relief'], relief:{...}} draws them seeded with
// a density multiplier, per-biome multipliers, a minimum height and exclusions; relief.onLoad (or
// edit map {set:{reliefOnLoad:true}}) makes every save drop them and every load draw them again.
// The settings live on #terrain (mcp/src/bridge-ext/relief.js writes them, the app's renderer
// reads them: src/renderers/relief-settings.ts). No tools of its own: generate.ts's regenerate
// calls regenerateRelief and registers RELIEF_REPLAY.
import { z } from "zod";
import type { CallScope, ToolContext } from "../context.ts";
import { NOT_REPLAYABLE, type ReplaySpec, type Resolved } from "../ops.ts";
import { TIMEOUTS } from "../schemas.ts";
import { runPhased, SelectSchema } from "./edit.ts";

export const ReliefParams = z
  .object({
    density: z
      .number()
      .min(0)
      .max(2)
      .nullable()
      .optional()
      .describe(
        "Multiplier on the style density (icon spacing). Icon count goes with its square: 0.7 about halves the icons, 0.5 leaves about a quarter, 0 draws none. null = 1"
      ),
    perBiome: z
      .record(z.string(), z.number().min(0).max(2))
      .nullable()
      .optional()
      .describe(
        "{<biome name or id>: multiplier} for the cells of that biome, on top of density (0 = no icons there). Replaces the stored table; null clears it"
      ),
    minHeight: z
      .number()
      .min(0)
      .max(100)
      .nullable()
      .optional()
      .describe("No icons on cells lower than this (land starts at 20, hill icons at 50). null = no limit"),
    exclude: z
      .union([SelectSchema, z.array(SelectSchema).min(1).max(50)])
      .nullable()
      .optional()
      .describe(
        "Cells without icons: a selection like paint_cells select, or a list of them (united), e.g. [{polygon:[...]}, {entity:{type:'zone', ref:'Valley'}}]. Resolved now and stored as grid cells (survives a heightmap rebuild). Replaces the stored exclusion; null clears it"
      ),
    nearBurgs: z
      .union([
        z.number().min(0).max(1000),
        z.object({ radius: z.number().min(0), unit: z.enum(["px", "km", "mi"]).optional() })
      ])
      .nullable()
      .optional()
      .describe(
        "No icons within this distance of any burg: px, or {radius, unit}. Checked on every draw, so later burgs count too. null or 0 = off"
      ),
    seed: z
      .union([z.string().min(1).max(64), z.number().int()])
      .nullable()
      .optional()
      .describe("Seed of the draw (default: the stored seed, else the map seed; null = the map seed)"),
    onLoad: z
      .boolean()
      .optional()
      .describe(
        "true: saves drop the icons and loads draw them again (same as edit map {set:{reliefOnLoad:true}}); false: saves store them"
      )
  })
  .describe(
    "Relief icon settings, stored with the map and used by every later draw. Keys left out keep their stored value."
  );

export type ReliefInput = z.infer<typeof ReliefParams>;

interface ReliefResolved {
  parts: ["relief"];
  relief: Record<string, unknown>;
}

function isReliefResolved(r: Resolved | null): r is Resolved & ReliefResolved {
  const o = r as unknown as Partial<ReliefResolved> | null;
  return (
    !!o &&
    Array.isArray(o.parts) &&
    o.parts.length === 1 &&
    o.parts[0] === "relief" &&
    !!o.relief &&
    typeof o.relief === "object" &&
    !Array.isArray(o.relief)
  );
}

const show = (v: unknown): string => {
  const s = JSON.stringify(v) ?? "null";
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
};

function reliefSentence(r: ReliefResolved, out: Record<string, unknown> | null): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(r.relief)) {
    if (k === "excludeGrid") {
      const n = typeof v === "string" ? v.split(":")[1]?.split(",").filter(Boolean).length : 0;
      parts.push(v === null ? "exclusion cleared" : `exclusion (${n} grid cell ranges)`);
    } else parts.push(`${k} ${show(v)}`);
  }
  const icons = (out?.relief as { icons?: number } | undefined)?.icons;
  return `Regenerated relief icons${parts.length ? `: ${parts.join(", ")}` : " with the stored settings"}${typeof icons === "number" ? ` (${icons} icons)` : ""}.`;
}

/**
 * Replay of regenerate: a relief-only call is seeded and deterministic, so it replays (its
 * resolved form is {parts:['relief'], relief:{the keys the call gave, literal}}); every other
 * regenerate stays NOT_REPLAYABLE.
 */
export const RELIEF_REPLAY: ReplaySpec = {
  bridgeFn: "regenerate",
  bridgeArgs: r => ({ parts: ["relief"], relief: (r as unknown as ReliefResolved).relief }),
  unreplayable: r => (isReliefResolved(r) ? null : NOT_REPLAYABLE.regenerate),
  summarize: (r, out, args) => {
    if (isReliefResolved(r)) return reliefSentence(r, out);
    const a = JSON.stringify(args) ?? "";
    return `regenerate ${a.length > 80 ? `${a.slice(0, 77)}...` : a}`.trim();
  },
  timeout: "heavy"
};

/** regenerate {parts:['relief']}: phased (dryRun returns the settings before/after), replayable. */
export async function regenerateRelief(
  ctx: ToolContext,
  scope: CallScope,
  args: { parts: string[]; relief?: ReliefInput; dryRun?: boolean; timeoutMs?: number }
): Promise<Record<string, unknown>> {
  return runPhased(
    ctx,
    scope,
    "regenerate relief",
    args,
    "regenerate",
    { parts: ["relief"], relief: args.relief ?? {} },
    { dryRun: args.dryRun, timeoutMs: args.timeoutMs ?? TIMEOUTS.heavy }
  );
}
