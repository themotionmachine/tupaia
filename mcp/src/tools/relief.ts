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

const ExcludeSel = z.union([SelectSchema, z.array(SelectSchema).min(1).max(50)]);

export const ReliefParams = z
  .object({
    density: z
      .number()
      .min(0)
      .max(2)
      .nullable()
      .optional()
      .describe(
        "Multiplier on the style density. The icon count goes with its square, all the way down: 0.7 about halves the icons, 0.5 leaves about a quarter, 0.1 about 1%, 0 none. 1 is the style default, not the icons the map has now (see matchIcons). null = 1"
      ),
    matchIcons: z
      .union([z.literal(true), z.number().int().min(0)])
      .optional()
      .describe(
        "Instead of density: pick the density whose draw has about this many icons (true = as many as the page shows now), within about 1%, in a few test draws. The chosen density is stored and logged"
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
    exclude: ExcludeSel.nullable()
      .optional()
      .describe(
        "Cells without icons: a selection like paint_cells select, or a list of them (united), e.g. [{polygon:[...]}, {entity:{type:'zone', ref:'Valley'}}]. Resolved now and stored by grid cell (coastal cells, where one grid cell holds several, are stored one by one), so it survives a heightmap rebuild. Replaces the stored exclusion; null clears it"
      ),
    excludeAdd: ExcludeSel.optional().describe("Cells to add to the stored exclusion (same forms as exclude)"),
    excludeRemove: ExcludeSel.optional().describe("Cells to take out of the stored exclusion (same forms as exclude)"),
    nearBurgs: z
      .union([
        z.number().min(0).max(1000),
        z.object({ radius: z.number().min(0), unit: z.enum(["px", "km", "mi"]).optional() })
      ])
      .nullable()
      .optional()
      .describe(
        "No icons within this distance of any burg: px, or {radius, unit} where unit defaults to px (give 'km' or 'mi' for map distance). Checked on every draw, so later burgs count too. null or 0 = off"
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
  /** Stored values of those keys before the call: replay calls a key someone else changed since a conflict. */
  base?: Record<string, unknown>;
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
      const body = typeof v === "string" ? v.slice(v.indexOf(":") + 1) : "";
      const [ranges = "", coast = ""] = body.split(";");
      const n = ranges.split(",").filter(Boolean).length;
      const c = coast.split(",").filter(Boolean).length;
      parts.push(
        v === null ? "exclusion cleared" : `exclusion (${n} grid cell ranges${c ? `, ${c} coastal cells` : ""})`
      );
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
  bridgeArgs: r => {
    const x = r as unknown as ReliefResolved;
    return { parts: ["relief"], relief: x.relief, ...(x.base ? { base: x.base } : {}) };
  },
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

// The sketch log's reason for a regenerate that is not relief-only (ops.ts NOT_REPLAYABLE is
// meant to be extended by tool modules).
NOT_REPLAYABLE.regenerate =
  "regenerate re-runs random generators (e.g. states reseeds Math.random), so it cannot be replayed; only a call whose parts are all biomes, provinces, emblems or relief replays (logged as its literal outcome or seed)";

const TERRAIN_TAG = /<g\b[^>]*\bid="terrain"[^>]*>/;

/** Does this .map text draw its relief icons on load (#terrain[data-regenerate])? */
export function drawsReliefOnLoad(text: string): boolean {
  const tag = TERRAIN_TAG.exec(text)?.[0];
  return !!tag && /\sdata-regenerate=/.test(tag);
}

/** Per deployed entry chunk: does it hold the relief load hook? */
const hookByEntry = new Map<string, boolean>();

/**
 * shared_save / sketch_promote gate: a map that draws its relief icons on load needs the load hook
 * in the deployed app, or live users get no relief (and their next save stores unseeded icons).
 * The local build has the hook, so an identical deployed build ('ok') passes; otherwise the
 * deployed entry chunk is fetched once (a read-only GET) and searched for the hook's marker.
 */
export async function reliefOnLoadRefusal(
  ctx: ToolContext,
  text: string,
  build: { verdict: string; liveEntry: string | null },
  skipBuildCheck: boolean
): Promise<{ code: string; message: string } | null> {
  if (!drawsReliefOnLoad(text) || build.verdict === "ok") return null;
  const entry = build.liveEntry;
  let has = entry ? (hookByEntry.get(entry) ?? null) : null;
  let why = entry ? "" : "the deployed entry chunk is unknown";
  if (entry && has === null) {
    try {
      const res = await ctx.shared.get(`/${entry}`);
      if (res.ok) {
        has = (await res.text()).includes("data-regenerate");
        hookByEntry.set(entry, has);
      } else why = `GET /${entry} returned ${res.status}`;
    } catch (e) {
      why = (e as Error).message;
    }
  }
  if (has) return null;
  const fix =
    "Deploy the app first, or store the icons with edit map {set:{reliefOnLoad:false}} (a bigger file that every build shows)";
  if (has === false)
    return {
      code: "BUILD",
      message: `the page map draws its relief icons on load (reliefOnLoad), but the deployed app (${entry}) has no relief load hook: live users would see no relief until they toggle it, and their next save would store unseeded icons. ${fix}.`
    };
  if (skipBuildCheck) return null;
  return {
    code: "BUILD",
    message: `the page map draws its relief icons on load (reliefOnLoad) and the deployed app could not be checked for the relief load hook (${why}). ${fix}; skipBuildCheck:true saves anyway only if the human agrees.`
  };
}
