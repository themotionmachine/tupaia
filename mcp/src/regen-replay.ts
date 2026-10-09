// The one replay spec for op tool 'regenerate' (ops.ts has one slot per tool name). It
// dispatches by the shape of the resolved form:
//   - relief alone {parts:['relief'], relief, base?}: tools/relief.ts RELIEF_REPLAY, unchanged;
//   - a mix of replayable parts {parts, combined:true, graph?, biomes?, literal?, relief?}: each
//     part's own literal form, replayed with its own spec (biomes: tools/biomes.ts setBiomeCells;
//     provinces/emblems: regen.ts regenerateLiteral; relief: RELIEF_REPLAY) in dependency order;
//   - anything else: not replayable (NOT_REPLAYABLE.regenerate).
// A call of one family alone keeps its own op name (regenerate:biomes, regenerate:provinces-
// emblems, or 'regenerate' for relief); only a call mixing two or more families of replayable
// parts (biomes, provinces/emblems, relief) and nothing else is logged in the combined form.
// The bridge side is src/bridge-ext/regen-replay.js (FNS.regenerateReplay).
import type { CallScope } from "./context.ts";
import { type CreatedRef, NOT_REPLAYABLE, type ReplaySpec, type Resolved, type Rewriter } from "./ops.ts";
import { REGEN_REPLAY, REPLAYABLE_REGEN_PARTS } from "./regen.ts";
import { BIOMES_REPLAY } from "./tools/biomes.ts";
import { RELIEF_REPLAY } from "./tools/relief.ts";

/** Sub-forms of a combined regenerate, in the order they ran (and replay). */
const FAMILIES = [
  { key: "biomes", parts: ["biomes"], spec: BIOMES_REPLAY },
  { key: "literal", parts: ["provinces", "emblems"], spec: REGEN_REPLAY },
  { key: "relief", parts: ["relief"], spec: RELIEF_REPLAY }
] as const;
type FamilyKey = (typeof FAMILIES)[number]["key"];

export interface CombinedRegenResolved {
  parts: string[];
  combined: true;
  /** Cell graph the literal cell lists refer to (replay compares it, like any op's graph). */
  graph?: string | null;
  biomes?: Resolved;
  literal?: Resolved;
  relief?: Resolved;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function isCombinedRegen(r: unknown): r is CombinedRegenResolved {
  return isObj(r) && r.combined === true && Array.isArray(r.parts);
}

/** The families of replayable parts a call has, when it has two or more and no other part; else null. */
export function combinedFamilies(parts: readonly string[]): FamilyKey[] | null {
  if (!parts.length || !parts.every(p => (REPLAYABLE_REGEN_PARTS as readonly string[]).includes(p))) return null;
  const keys = FAMILIES.filter(f => f.parts.some(p => parts.includes(p))).map(f => f.key);
  return keys.length >= 2 ? keys : null;
}

const present = (r: CombinedRegenResolved) => FAMILIES.filter(f => r[f.key] !== undefined);

function combinedUnreplayable(r: CombinedRegenResolved): string | null {
  const want = combinedFamilies(r.parts);
  if (!want) return NOT_REPLAYABLE.regenerate;
  for (const key of want) {
    const f = FAMILIES.find(x => x.key === key);
    const sub = (r[key] ?? null) as Resolved | null;
    if (!f || !sub) return `this regenerate's recorded outcome has no ${key} part, so it cannot be replayed`;
    const why = f.spec.unreplayable?.(sub) ?? null;
    if (why) return why;
  }
  return null;
}

/** Bridge FNS.regenerateReplay arguments: one sub-call per part family, in order. */
function forms(r: CombinedRegenResolved): Array<{ key: FamilyKey; fn: string; args: Record<string, unknown> }> {
  return present(r).map(f => {
    const sub = r[f.key] as Resolved;
    return { key: f.key, fn: f.spec.bridgeFn, args: f.spec.bridgeArgs ? f.spec.bridgeArgs(sub) : { ...sub } };
  });
}

export const REGENERATE_REPLAY: ReplaySpec = {
  bridgeFn: "regenerateReplay",
  bridgeArgs: r => {
    if (isCombinedRegen(r)) return { parts: r.parts, forms: forms(r) };
    // relief alone: the same call RELIEF_REPLAY makes, through the dispatcher
    const args = RELIEF_REPLAY.bridgeArgs ? RELIEF_REPLAY.bridgeArgs(r) : { ...r };
    return { parts: ["relief"], forms: [{ key: "relief", fn: RELIEF_REPLAY.bridgeFn, args }] };
  },
  rewrite: (r: Resolved, rw: Rewriter) => {
    if (!isCombinedRegen(r)) return RELIEF_REPLAY.rewrite ? RELIEF_REPLAY.rewrite(r, rw) : r;
    const x = r as CombinedRegenResolved; // already a copy (rewriteResolved clones)
    for (const f of present(x)) if (f.spec.rewrite) x[f.key] = f.spec.rewrite(x[f.key] as Resolved, rw);
    return x as unknown as Resolved;
  },
  summarize: (r, out, args) => {
    if (!isCombinedRegen(r)) return RELIEF_REPLAY.summarize ? RELIEF_REPLAY.summarize(r, out, args) : "regenerate";
    const subOut = (key: FamilyKey): Record<string, unknown> | null => {
      if (!out) return null;
      if (key === "biomes") return ((out.details as Record<string, unknown> | undefined)?.biomes ?? null) as never;
      return out;
    };
    const subArgs = (key: FamilyKey) => {
      const a = (isObj(args) ? args : {}) as Record<string, unknown>;
      const f = FAMILIES.find(x => x.key === key);
      return { ...a, parts: (Array.isArray(a.parts) ? a.parts : r.parts).filter(p => f?.parts.includes(p as never)) };
    };
    const bits = present(r).map(f =>
      (f.spec.summarize?.(r[f.key] as Resolved, subOut(f.key), subArgs(f.key)) ?? f.key).replace(/\.$/, "")
    );
    return `${bits.join("; ")}.`;
  },
  unreplayable: r => {
    if (isCombinedRegen(r)) return combinedUnreplayable(r);
    return RELIEF_REPLAY.unreplayable ? RELIEF_REPLAY.unreplayable(r) : NOT_REPLAYABLE.regenerate;
  },
  created: (r: Resolved): CreatedRef[][] =>
    isCombinedRegen(r) && r.literal && REGEN_REPLAY.created ? REGEN_REPLAY.created(r.literal) : [],
  focus: (r: Resolved) => (isCombinedRegen(r) && r.literal && REGEN_REPLAY.focus ? REGEN_REPLAY.focus(r.literal) : []),
  timeout: "heavy"
};

/**
 * After a regenerate whose parts are two or more families of replayable parts and nothing else:
 * take each family's literal form out of the result (they go to the sketch log, not to the
 * client) and log the call as one 'regenerate' op in the combined form. Returns false (and
 * changes nothing) for any other call, which the families' own recorders then handle.
 */
export async function recordCombinedRegen(
  scope: CallScope,
  args: { parts: readonly string[] } & Record<string, unknown>,
  out: Record<string, unknown>
): Promise<boolean> {
  const keys = combinedFamilies(args.parts);
  if (!keys) return false;
  const literal = out.resolved as Resolved | undefined;
  delete out.resolved;
  const details = out.details as Record<string, Record<string, unknown>> | undefined;
  const biomes = details?.biomes?.resolved as Resolved | undefined;
  if (details?.biomes) delete details.biomes.resolved;
  const relief = out.reliefResolved as Resolved | undefined;
  delete out.reliefResolved;
  const subs: Partial<Record<FamilyKey, Resolved | undefined>> = { biomes, literal, relief };
  const r: CombinedRegenResolved = {
    parts: FAMILIES.flatMap(f => f.parts.filter(p => args.parts.includes(p))),
    combined: true
  };
  for (const k of keys) if (subs[k]) r[k] = subs[k];
  const graph =
    (biomes as { graph?: unknown } | undefined)?.graph ?? (literal as { graph?: unknown } | undefined)?.graph;
  if (typeof graph === "string") r.graph = graph;
  const why = combinedUnreplayable(r);
  const resolved = r as unknown as Resolved;
  if (why) await scope.record("regenerate", args, null, { replayable: false, reason: why, out });
  else await scope.record("regenerate", args, resolved, { out });
  return true;
}
