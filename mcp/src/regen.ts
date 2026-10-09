// regenerate provinces / emblems: the option schemas and the sketch replay spec.
//
// The page side is src/bridge-ext/regen.js. A regenerate call whose parts are only 'provinces'
// and/or 'emblems' records its literal outcome ({parts, graph?, provinces?, emblems?}): the new
// provinces with their cells (run-length encoded) and coats of arms, and every regenerated coat
// of arms. Replay re-applies that outcome through the bridge's regenerateLiteral, so those ops
// stay replayable; any other part re-runs a random generator without a literal record and makes
// the sketch blob-only, as before.
import { z } from "zod";
import { type CreatedRef, NOT_REPLAYABLE, type Resolved, type Rewriter, registerReplayable } from "./ops.ts";
import { EntityRef, Place } from "./schemas.ts";

export const LITERAL_REGEN_PARTS = ["provinces", "emblems"] as const;

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
        "Provinces per state without centres, of about equal area, each centred on its biggest burg (the capital's on the capital; a place where there is none)"
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
      .describe(
        "Default true: locked provinces keep their id and cells; locked states are skipped (naming one is refused)"
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
    keepLocked: z.boolean().optional().describe("Default true: locked states, provinces and burgs keep their emblem")
  })
  .strict();

interface CoaRow {
  i: number;
  /** Hash of the coat of arms before the op (replay: someone else changed it since -> conflict). */
  was?: string;
  coa: unknown;
  /** Set by rewrite: the entity was created by an earlier op of the sketch (no both-changed check). */
  fresh?: boolean;
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
  fresh?: boolean;
  [k: string]: unknown;
}

export interface RegenResolved {
  parts: string[];
  /** Cell graph fingerprint the province cells refer to (replay checks it). */
  graph?: string;
  provinces?: {
    states: number[];
    keepLocked?: boolean;
    kept?: number[];
    replaced: ReplacedRow[];
    created: ProvinceDef[];
  };
  emblems?: { states?: CoaRow[]; provinces?: CoaRow[]; burgs?: CoaRow[] };
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

/** Why a logged regenerate cannot be replayed, or null (only the literal provinces/emblems forms). */
export function regenUnreplayable(r: Resolved | null): string | null {
  const only = "; only a regenerate of parts provinces and/or emblems records a replayable outcome";
  if (!isObj(r)) return `${NOT_REPLAYABLE.regenerate}${only}`;
  const x = r as unknown as RegenResolved;
  if (!Array.isArray(x.parts) || !x.parts.length) return `${NOT_REPLAYABLE.regenerate}${only}`;
  const other = x.parts.filter(p => !(LITERAL_REGEN_PARTS as readonly string[]).includes(p));
  if (other.length)
    return `regenerate ${other.join(", ")} re-runs random generators without recording the outcome (states reseeds Math.random), so it cannot be replayed (a regenerate of only parts provinces and/or emblems can be)`;
  if (!literalShapeOk(x)) return `${NOT_REPLAYABLE.regenerate}; this op's recorded outcome is incomplete`;
  return null;
}

/** One sentence for the log. */
export function regenSummary(r: Resolved | null, _out: Record<string, unknown> | null, args?: unknown): string {
  const x = isObj(r) ? (r as unknown as RegenResolved) : null;
  const parts = x?.parts ?? ((args as { parts?: string[] } | undefined)?.parts || []);
  const bits: string[] = [];
  const p = x?.provinces;
  if (p && Array.isArray(p.created)) {
    const kept = p.kept?.length ? `, ${p.kept.length} locked kept` : "";
    bits.push(
      `provinces of ${p.states.length} state${p.states.length === 1 ? "" : "s"}: ${p.created.length} new replace ${p.replaced.length}${kept}`
    );
  }
  const e = x?.emblems;
  if (e) {
    const n = (k: "states" | "provinces" | "burgs") => e[k]?.length ?? 0;
    bits.push(`emblems of ${n("states")} states, ${n("provinces")} provinces, ${n("burgs")} burgs`);
  }
  if (!bits.length) return `Regenerated ${parts.join(", ") || "(nothing)"}.`;
  return `Regenerated ${bits.join("; ")}.`;
}

/** Map sketch-created ids (states, burgs, provinces of earlier ops) to their replay ids. */
export function regenRewrite(r: Resolved, rw: Rewriter): Resolved {
  const x = r as unknown as RegenResolved; // already a copy (rewriteResolved clones)
  const p = x.provinces;
  if (p) {
    p.states = p.states.map(s => rw.id("state", s) as number);
    if (Array.isArray(p.kept)) p.kept = p.kept.map(i => rw.id("province", i) as number);
    for (const row of p.replaced) {
      if (rw.created.has(`province:${row.i}`)) row.fresh = true;
      row.i = rw.id("province", row.i) as number;
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
        if (rw.created.has(`${type}:${row.i}`)) row.fresh = true;
        row.i = rw.id(type, row.i) as number;
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

registerReplayable("regenerate", {
  bridgeFn: "regenerateLiteral",
  rewrite: regenRewrite,
  summarize: regenSummary,
  unreplayable: regenUnreplayable,
  created: regenCreated,
  timeout: "heavy"
});
