// regenerate provinces / emblems: the option schemas, validation and dryRun, sketch recording and
// the replay spec.
//
// The page side is src/bridge-ext/regen.js. A regenerate call whose parts are only 'provinces'
// and/or 'emblems' is logged as op tool 'regenerate:provinces-emblems' (REGEN_OP) with its
// literal outcome ({parts, graph?, provinces?, emblems?}): the new provinces with their cells
// (run-length encoded) and coats of arms, and every regenerated coat of arms. Replay re-applies
// that outcome through the bridge's regenerateLiteral. A call that mixes them with biomes and/or
// relief only is logged as one 'regenerate' op whose outcome holds each part's literal form
// (regen-replay.ts); a call with any other part is a plain 'regenerate', not replayable.
import { z } from "zod";
import type { CallScope } from "./context.ts";
import { type CreatedRef, type ReplaySpec, type Resolved, type Rewriter, registerReplayable } from "./ops.ts";
import { ToolError } from "./result.ts";
import { EntityRef, Place, TIMEOUTS } from "./schemas.ts";

export const REGEN_OP = "regenerate:provinces-emblems";
export const LITERAL_REGEN_PARTS = ["provinces", "emblems"] as const;
const isLiteralPart = (p: string) => (LITERAL_REGEN_PARTS as readonly string[]).includes(p);
/** Parts whose outcome is recorded literally (or seeded), so a regenerate of only these replays. */
export const REPLAYABLE_REGEN_PARTS = ["biomes", "provinces", "emblems", "relief"] as const;
const isReplayablePart = (p: string) => (REPLAYABLE_REGEN_PARTS as readonly string[]).includes(p);

export const RegenProvinces = z
  .object({
    states: z
      .array(EntityRef)
      .min(1)
      .max(500)
      .optional()
      .describe("States whose provinces are replaced (default: the states in centres, else every unlocked state)"),
    centres: z
      .array(
        z
          .object({
            state: EntityRef,
            burg: EntityRef.optional().describe("The province's capital (a burg inside the state)"),
            at: Place.optional().describe("Or a place: a land cell of the state (a burg there becomes the capital)"),
            name: z.string().min(1).optional(),
            formName: z.string().min(1).optional().describe("e.g. County, March, Province"),
            fullName: z.string().min(1).optional()
          })
          .strict()
      )
      .min(1)
      .max(500)
      .optional()
      .describe("Explicit centres, one province each; a state's land goes to the nearest centre by travel cost"),
    count: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "New provinces per state without centres (kept locked ones are extra), of balanced area, each centred on its biggest burg (the capital's on the capital; a place where there is none); names are generated"
      ),
    ratio: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Auto mode (no centres/count): the generator's provinces ratio 1-100, higher = more and bigger burg provinces (default: the options panel's)"
      ),
    keepLocked: z
      .boolean()
      .optional()
      .describe("Default true: locked provinces (of any state) keep their id and cells"),
    lockedStates: z
      .boolean()
      .optional()
      .describe("Also regenerate locked states (default false: skipped, and naming one is refused)"),
    crossForeign: z
      .boolean()
      .optional()
      .describe(
        "centres/count: the spread may travel through other states' land, so parts of the state behind it go to the nearest centre over land (default false: inside the state and along its coast only; cells it cannot reach go to the nearest province, reported as fallback)"
      )
  })
  .strict();

export const RegenEmblems = z
  .object({
    states: z
      .array(EntityRef)
      .min(1)
      .max(500)
      .optional()
      .describe("Only these states and their provinces/burgs (0 = burgs outside any state); default all"),
    provinces: z.boolean().optional().describe("Also their provinces (default true)"),
    burgs: z.boolean().optional().describe("Also their burgs (default true)"),
    shieldOnly: z.boolean().optional().describe("Keep the designs; only reset each shield shape to its culture's"),
    keepLocked: z.boolean().optional().describe("Default true: locked states, provinces and burgs keep their emblem"),
    lockedStates: z.boolean().optional().describe("Regenerate locked states' own emblems too (default false)"),
    stateCulture: z
      .boolean()
      .optional()
      .describe(
        "Shields of provinces and burgs follow their state's culture (default: their own; a Wildlands one takes the state's)"
      )
  })
  .strict();

interface CoaRow {
  i: number;
  /** Hash of the coat of arms before the op (replay: someone else changed it since -> conflict). */
  was?: string;
  coa: unknown;
  /** The entity was locked at record time (replay: locked since -> conflict). */
  locked?: boolean;
  /** Provinces: state and centre cell (to find an unreported province of a state the sketch created). */
  state?: number;
  center?: number;
  /** Set by rewrite: the entity was created by an earlier op of the sketch (no both-changed check). */
  fresh?: boolean;
  /** Set by rewrite: find the province by state and centre (its id was not reported when it was made). */
  locate?: boolean;
}

interface ProvinceDef {
  i: number;
  state: number;
  center: number;
  burg: number;
  name: string;
  formName?: string;
  fullName?: string;
  color?: string;
  coa: unknown;
  /** Cell count. */
  n?: number;
  /** Cells as [start, count, start, count, ...]. */
  runs: number[];
}

interface ReplacedRow {
  i: number;
  state: number;
  name: string;
  burg?: number | null;
  /** Hashes of its cells and coat of arms at record time. */
  cells?: string;
  coa?: string;
  fresh?: boolean;
  [k: string]: unknown;
}

export interface RegenResolved {
  parts: string[];
  /** Cell graph fingerprint the province cells refer to (replay checks it). */
  graph?: string;
  provinces?: {
    states: number[];
    /** State names at record time (summary only). */
    names?: Array<string | null>;
    keepLocked?: boolean;
    lockedStates?: boolean;
    /** Target states that were locked at record time. */
    locked?: number[];
    kept?: number[];
    replaced: ReplacedRow[];
    created: ProvinceDef[];
    /** Set by rewrite: target states the sketch created (nobody else has provinces there). */
    fresh?: number[];
  };
  emblems?: {
    states?: CoaRow[];
    provinces?: CoaRow[];
    burgs?: CoaRow[];
    keepLocked?: boolean;
    lockedStates?: boolean;
    /** Counts regenerated (provinces include the ones created by the same call). */
    n?: { states?: number; provinces?: number; burgs?: number };
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function literalShapeOk(x: RegenResolved): boolean {
  if (x.parts.includes("provinces")) {
    const p = x.provinces;
    if (!isObj(p) || !Array.isArray(p.states) || !Array.isArray(p.replaced) || !Array.isArray(p.created)) return false;
  }
  if (x.parts.includes("emblems")) {
    const e = x.emblems;
    if (!isObj(e)) return false;
    for (const k of ["states", "provinces", "burgs"] as const)
      if (e[k] !== undefined && !Array.isArray(e[k])) return false;
  }
  return true;
}

const ONLY =
  "a regenerate of only parts provinces, emblems, biomes and/or relief records its outcome and can be replayed";

/** Why a logged REGEN_OP cannot be replayed, or null. */
export function regenUnreplayable(r: Resolved | null): string | null {
  if (!isObj(r)) return `this regenerate has no recorded outcome; ${ONLY}`;
  const x = r as unknown as RegenResolved;
  if (!Array.isArray(x.parts) || !x.parts.length) return `this regenerate has no parts; ${ONLY}`;
  const other = x.parts.filter(p => !isLiteralPart(p));
  if (other.length) return mixedReason(other);
  if (!literalShapeOk(x)) return "this regenerate's recorded outcome is incomplete, so it cannot be replayed";
  return null;
}

function mixedReason(other: string[]): string {
  return `regenerate ${other.join(", ")} re-runs random generators without recording the outcome (states reseeds Math.random), so it cannot be replayed; ${ONLY}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One sentence for the log. */
export function regenSummary(r: Resolved | null, _out: Record<string, unknown> | null, args?: unknown): string {
  const x = isObj(r) ? (r as unknown as RegenResolved) : null;
  const parts = x?.parts ?? ((args as { parts?: string[] } | undefined)?.parts || []);
  const bits: string[] = [];
  const p = x?.provinces;
  if (p && Array.isArray(p.created) && Array.isArray(p.states)) {
    const who =
      p.states.length === 1
        ? `${p.names?.[0] ? `${p.names[0]} ` : "state "}(${p.states[0]})`
        : plural(p.states.length, "state");
    const names = p.created.slice(0, 3).map(d => d.name);
    const list = names.length ? ` (${names.join(", ")}${p.created.length > 3 ? ", ..." : ""})` : "";
    const kept = p.kept?.length ? `; ${p.kept.length} locked kept` : "";
    bits.push(
      p.replaced.length
        ? `replaced ${plural(p.replaced.length, "province")} of ${who} with ${p.created.length} new${list}${kept}`
        : `gave ${who} ${p.created.length} new ${p.created.length === 1 ? "province" : "provinces"}${list}${kept}`
    );
  }
  const e = x?.emblems;
  if (e) {
    const n = (k: "states" | "provinces" | "burgs") => e.n?.[k] ?? e[k]?.length ?? 0;
    const what = [plural(n("states"), "state"), plural(n("provinces"), "province"), plural(n("burgs"), "burg")];
    bits.push(`new emblems for ${what.slice(0, 2).join(", ")} and ${what[2]}`);
  }
  if (!bits.length) return `Regenerated ${parts.join(", ") || "(nothing)"}.`;
  const s = bits.join("; ");
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
}

/** Map sketch-created ids (states, burgs, provinces of earlier ops) to their replay ids. */
export function regenRewrite(r: Resolved, rw: Rewriter): Resolved {
  const x = r as unknown as RegenResolved; // already a copy (rewriteResolved clones)
  const madeState = (s: number) => rw.created.has(`state:${s}`);
  const p = x.provinces;
  if (p) {
    // a state the sketch created holds nobody else's provinces: replay replaces whatever it has
    // then (provinces made on the way, e.g. by paint_cells, are not reported, so their ids shift)
    p.fresh = p.states.filter(madeState).map(s => rw.id("state", s) as number);
    p.states = p.states.map(s => rw.id("state", s) as number);
    if (Array.isArray(p.locked)) p.locked = p.locked.map(s => rw.id("state", s) as number);
    if (Array.isArray(p.kept)) p.kept = p.kept.map(i => rw.id("province", i) as number);
    for (const row of p.replaced) {
      if (madeState(row.state)) {
        row.fresh = true;
        if (rw.created.has(`province:${row.i}`)) row.i = rw.id("province", row.i) as number;
      } else {
        if (rw.created.has(`province:${row.i}`)) row.fresh = true;
        row.i = rw.id("province", row.i) as number;
      }
      row.state = rw.id("state", row.state) as number;
      if (row.burg) row.burg = rw.id("burg", row.burg) as number;
    }
    for (const d of p.created) {
      d.state = rw.id("state", d.state) as number;
      if (d.burg) d.burg = rw.id("burg", d.burg) as number;
    }
  }
  const e = x.emblems;
  if (e) {
    for (const [key, type] of [
      ["states", "state"],
      ["provinces", "province"],
      ["burgs", "burg"]
    ] as const)
      for (const row of e[key] ?? []) {
        if (rw.created.has(`${type}:${row.i}`)) {
          row.fresh = true;
          row.i = rw.id(type, row.i) as number;
        } else if (type === "province" && typeof row.state === "number" && madeState(row.state)) {
          // a province of a state the sketch created, not reported when it was made
          row.fresh = true;
          row.locate = true;
        }
        if (type === "province" && typeof row.state === "number") row.state = rw.id("state", row.state) as number;
      }
  }
  return x as unknown as Resolved;
}

/** The provinces the op created (one item), for the replay id map. */
export function regenCreated(r: Resolved): CreatedRef[][] {
  const p = (r as unknown as RegenResolved).provinces;
  if (!p || !Array.isArray(p.created)) return [];
  return [p.created.map(d => ({ type: "province", i: d.i }))];
}

/** Where the sketch summary frames its shots: the states whose provinces or emblems changed. */
export function regenFocus(r: Resolved): Array<{ type: string; i: number; score: number; layers: string[] }> {
  const x = r as unknown as RegenResolved;
  const layers = x.provinces ? ["provinces", "borders"] : ["emblems", "borders"];
  const out = new Map<number, number>();
  for (const s of x.provinces?.states ?? [])
    out.set(s, (out.get(s) ?? 0) + 2 + (x.provinces?.created ?? []).filter(d => d.state === s).length);
  for (const row of x.emblems?.states ?? []) out.set(row.i, (out.get(row.i) ?? 0) + 2);
  return [...out].map(([i, score]) => ({ type: "state", i, score, layers }));
}

// ---------------------------------------------------------------- the regenerate tool's hooks

interface RegenArgs {
  parts: readonly string[];
  provinces?: unknown;
  emblems?: unknown;
  timeoutMs?: number;
}

/**
 * Before the undo point: check the provinces/emblems options in the page (nothing changes). With
 * preview (a dryRun) the page also generates the provinces on a copy and reports their sizes.
 * Returns null when the call has neither part.
 */
export async function planRegen(
  scope: CallScope,
  args: RegenArgs,
  preview: boolean
): Promise<Record<string, unknown> | null> {
  if (args.provinces !== undefined && !args.parts.includes("provinces"))
    throw new ToolError("BAD_ARGS", "provinces options need 'provinces' in parts. Nothing was changed.");
  if (args.emblems !== undefined && !args.parts.includes("emblems"))
    throw new ToolError("BAD_ARGS", "emblems options need 'emblems' in parts. Nothing was changed.");
  if (!args.parts.some(isLiteralPart)) return null;
  return scope.call<Record<string, unknown>>(
    "regenPlan",
    { parts: args.parts, provinces: args.provinces, emblems: args.emblems, preview },
    { timeoutMs: args.timeoutMs ?? TIMEOUTS.heavy }
  );
}

/**
 * After the regenerate: take the literal outcome out of the result (it goes to the sketch log,
 * not to the client) and, when every part was provinces/emblems, log the call as REGEN_OP. A
 * call mixing them with other parts is logged as a plain, non-replayable regenerate; one with
 * neither is left to the runner's fallback (unchanged behaviour).
 */
export async function recordRegen(scope: CallScope, args: RegenArgs, out: Record<string, unknown>): Promise<void> {
  const resolved = out.resolved;
  delete out.resolved;
  if (!args.parts.some(isLiteralPart)) return;
  const other = args.parts.filter(p => !isLiteralPart(p));
  if (other.length) {
    // (a mix of only replayable parts is recorded by regen-replay.ts before this runs)
    const random = args.parts.filter(p => !isReplayablePart(p));
    await scope.record("regenerate", args, null, {
      replayable: false,
      reason: mixedReason(random.length ? random : other)
    });
    return;
  }
  const why = regenUnreplayable((resolved ?? null) as Resolved | null);
  if (why) await scope.record(REGEN_OP, args, null, { replayable: false, reason: why });
  else await scope.record(REGEN_OP, args, resolved as Resolved, { out });
}

export const REGEN_REPLAY: ReplaySpec = {
  bridgeFn: "regenerateLiteral",
  rewrite: regenRewrite,
  summarize: regenSummary,
  unreplayable: regenUnreplayable,
  created: regenCreated,
  focus: regenFocus,
  timeout: "heavy"
};

registerReplayable(REGEN_OP, REGEN_REPLAY);
