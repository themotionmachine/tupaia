// Lineage through .map files (map-provenance.ts holds the trailer format): what save_map and the
// exit save embed, and what load_map makes of a file it reads.
//
// load_map binds the page back to the shared map only when all of these hold:
// - the file has a trailer whose content hash matches (unmodified) and whose HMAC is this
//   TUPAIA_OUT's (written by this output directory's server, not copied or hand-made);
// - it records shared lineage (a base version), against this server's live origin;
// - the shared map server agrees about that base where it can tell: the current version's
//   updated_at, or the retained version's size; a contradiction keeps the file unrelated, a check
//   that cannot be made (no live origin, network, not retained) binds with a warning.
// A file that names a sketch reactivates it (slug, base, ops log) when no other sketch records.
import type { CallScope, ToolContext } from "./context.ts";
import { baseOf, checkTrailer, type ProvBase, type ProvBlock, type ProvSketch, withTrailer } from "./map-provenance.ts";
import { type OpRecord, type SketchBase, sanitizeRecord } from "./ops.ts";

/** The sketch log rides along up to the size the Worker takes for ops.json. */
const LOG_MAX_BYTES = 2 * 1024 * 1024;

/** The block for the map in the page (call ctx.verifyProvenance() first). */
export function blockFor(ctx: ToolContext, by: string): Omit<ProvBlock, "sha256" | "sig" | "v"> {
  const p = ctx.snapshots.provenance;
  let base: ProvBase | null = baseOf(p);
  let sketch: ProvSketch | null = null;
  const sk = ctx.sketches.current;
  // the sketch rides along only when the page is its map (not a stopped rebase) on the same base
  if (base && sk && !sk.suspended && sk.base.kind === "shared" && sk.base.version === base.version) {
    const log = sk.ops.map(({ undoId: _u, ...o }) => o);
    const fits = JSON.stringify(log).length <= LOG_MAX_BYTES;
    base = {
      version: base.version,
      updatedAt: sk.base.updatedAt ?? base.updatedAt,
      updatedBy: sk.base.updatedBy ?? base.updatedBy,
      ...(typeof (sk.base.bytes ?? base.bytes) === "number" ? { bytes: sk.base.bytes ?? base.bytes } : {})
    };
    sketch = {
      slug: sk.slug,
      note: sk.note,
      created: sk.created,
      baseCounts: sk.baseCounts,
      recording: sk.recording,
      ops: sk.ops.length,
      log: fits ? log : null,
      blockers: [
        ...sk.blockers,
        ...(sk.diverged ? [`the page had changes the log does not hold (${sk.diverged})`] : [])
      ],
      saved: sk.saved ? { version: sk.saved.version, at: sk.saved.at, dirty: sk.saved.rev !== sk.rev } : null
    };
  }
  return {
    savedAt: new Date().toISOString(),
    by,
    origin: ctx.config.liveOrigin,
    lineage: base ? "shared" : "none",
    kind: p.kind,
    seed: p.seed ?? null,
    base,
    opsSince: p.opsSince,
    sketch
  };
}

/** `text` (prepareMapData of the page) with the signed provenance line appended. */
export function withProvenance(ctx: ToolContext, text: string, by: string): string {
  return withTrailer(text, blockFor(ctx, by), ctx.provKey);
}

/** One line for a result: "shared v8, sketch 'x' (12 ops)" or "unrelated". */
export function lineageWord(b: Omit<ProvBlock, "sha256" | "sig" | "v">): string {
  if (b.lineage !== "shared" || !b.base) return `none (${b.kind})`;
  return `shared v${b.base.version}${b.sketch ? `, sketch '${b.sketch.slug}' (${b.sketch.ops} ops)` : ""}, ${b.opsSince} op(s) since`;
}

export interface FileLineage {
  /** What the trailer said: none, valid, modified, foreign, bad. */
  file: string;
  lineage: "shared" | "unrelated";
  block?: ProvBlock;
  /** verified | unverifiable | mismatch (shared lineage claims only). */
  baseCheck?: string;
  note: string;
}

type BaseVerdict = { verdict: "verified" | "unverifiable" | "mismatch"; note: string };

/** Re-check a claimed base against the shared map server (one or two GETs). */
async function checkBase(ctx: ToolContext, b: ProvBlock & { base: ProvBase }): Promise<BaseVerdict> {
  const n = b.base.version;
  const origin = ctx.config.liveOrigin;
  if (b.origin && origin && b.origin !== origin)
    return { verdict: "mismatch", note: `it was saved against ${b.origin}, but this server reads ${origin}` };
  if (!origin)
    return {
      verdict: "unverifiable",
      note: `base v${n} NOT verified: TUPAIA_LIVE_ORIGIN=none, so the shared map cannot be read`
    };
  let meta: Awaited<ReturnType<ToolContext["shared"]["meta"]>>;
  try {
    meta = await ctx.shared.meta();
  } catch (e) {
    return { verdict: "unverifiable", note: `base v${n} NOT verified: ${(e as Error).message}` };
  }
  if (!meta) return { verdict: "mismatch", note: `the shared map does not exist on ${origin}` };
  if (meta.version === n) {
    if (b.base.updatedAt && meta.updated_at !== b.base.updatedAt)
      return {
        verdict: "mismatch",
        note: `the shared map's v${n} was saved at ${meta.updated_at} by ${meta.updated_by}, but the file's base v${n} at ${b.base.updatedAt}`
      };
    return { verdict: "verified", note: `base v${n} is the shared map's current version` };
  }
  if (meta.version < n)
    return { verdict: "mismatch", note: `the shared map is at v${meta.version}, before the file's base v${n}` };
  let retained: { version: number; size: number } | undefined;
  try {
    retained = (await ctx.shared.versions())?.snapshots.find(s => s.version === n);
  } catch (e) {
    return { verdict: "unverifiable", note: `base v${n} NOT verified: ${(e as Error).message}` };
  }
  if (!retained)
    return {
      verdict: "unverifiable",
      note: `base v${n} NOT verified: the server no longer retains it (the shared map is at v${meta.version})`
    };
  if (typeof b.base.bytes === "number" && retained.size !== b.base.bytes)
    return {
      verdict: "mismatch",
      note: `the server's retained v${n} is ${retained.size} bytes, the file's base was ${b.base.bytes}`
    };
  return typeof b.base.bytes === "number"
    ? {
        verdict: "verified",
        note: `base v${n} matches the server's retained copy (the shared map moved on to v${meta.version})`
      }
    : { verdict: "unverifiable", note: `base v${n} is retained but its size was not recorded, so NOT verified` };
}

/** What a file's trailer says about its lineage, checked (see the header). */
export async function fileLineage(ctx: ToolContext, bytes: Buffer): Promise<FileLineage> {
  const c = checkTrailer(bytes, ctx.provKey);
  if (c.status === "none") return { file: "none", lineage: "unrelated", note: "the file carries no provenance" };
  if (c.status !== "valid") return { file: c.status, lineage: "unrelated", note: `provenance ignored: ${c.reason}` };
  const b = c.block;
  if (b.lineage !== "shared" || !b.base || typeof b.base.version !== "number")
    return {
      file: "valid",
      lineage: "unrelated",
      block: b,
      note: `saved from a map not derived from the shared map (${b.kind})`
    };
  const v = await checkBase(ctx, b as ProvBlock & { base: ProvBase });
  if (v.verdict === "mismatch")
    return {
      file: "valid",
      lineage: "unrelated",
      block: b,
      baseCheck: v.verdict,
      note: `its claimed base v${b.base.version} does not hold: ${v.note}`
    };
  return { file: "valid", lineage: "shared", block: b, baseCheck: v.verdict, note: v.note };
}

const sameLog = (ops: readonly OpRecord[], log: readonly unknown[] | null): boolean => {
  if (!log || log.length !== ops.length) return false;
  return ops.every((o, k) => {
    const r = log[k] as Partial<OpRecord> | null;
    return !!r && r.seq === o.seq && r.tool === o.tool && r.at === o.at && r.digestAfter === o.digestAfter;
  });
};

/**
 * After load_map put a file with shared lineage in the page: provenance 'shared' (or 'sketch'
 * <slug>) at its base, and the sketch it names active again. Returns notes for the result.
 */
export async function bindFileLineage(
  ctx: ToolContext,
  scope: CallScope,
  fl: FileLineage,
  abs: string,
  summary: Record<string, unknown>,
  args: unknown
): Promise<string[]> {
  const b = fl.block as ProvBlock & { base: ProvBase };
  const fsk = b.sketch;
  ctx.snapshots.setProvenance({
    kind: fsk ? "sketch" : "shared",
    path: abs,
    seed: (summary.seed as string) ?? b.seed ?? null,
    mapId: (summary.mapId as number) ?? null,
    sharedVersion: b.base.version,
    sharedUpdatedBy: b.base.updatedBy,
    sharedUpdatedAt: b.base.updatedAt,
    ...(typeof b.base.bytes === "number" ? { sharedBytes: b.base.bytes } : {}),
    ...(fsk ? { sketchSlug: fsk.slug } : {}),
    restoredFrom: `file ${abs}`,
    opsSince: b.opsSince
  });
  const notes: string[] = [];
  if (!fsk) return notes;
  const cur = ctx.sketches.current;
  if (cur && cur.slug === fsk.slug && cur.base.kind === "shared" && cur.base.version === b.base.version) {
    if (cur.recording && sameLog(cur.ops, fsk.log)) {
      await scope.record("load_map", args, null, {
        replayable: true,
        noop: true,
        summary: `Loaded ${abs}: the sketch as it was at op ${fsk.ops} (same log); no change to the log.`
      });
      notes.push(`the file holds sketch '${fsk.slug}' at the same op (${fsk.ops}); its log is unchanged`);
    } else
      notes.push(
        `sketch '${fsk.slug}' is active with ${cur.ops.length} op(s); the file holds it at ${fsk.ops}${cur.recording ? ", so the load is logged as a whole-map replacement (blob-only until undone)" : ""}`
      );
    return notes;
  }
  if (cur?.recording) {
    notes.push(
      `sketch '${cur.slug}' is recording, so the file's sketch '${fsk.slug}' was not reactivated (the load is logged in '${cur.slug}'); stop '${cur.slug}' and load the file again to bring '${fsk.slug}' back`
    );
    return notes;
  }
  const base: SketchBase = {
    kind: "shared",
    id: "shared",
    version: b.base.version,
    updatedBy: b.base.updatedBy,
    updatedAt: b.base.updatedAt,
    at: b.savedAt,
    ...(typeof b.base.bytes === "number" ? { bytes: b.base.bytes } : {})
  };
  const sk = ctx.sketches.begin({
    slug: fsk.slug,
    note: fsk.note,
    base,
    baseText: "",
    baseCounts: fsk.baseCounts ?? {}
  });
  sk.created = fsk.created;
  // like ops.json from the Worker: keep what replay uses, recompute the rest
  sk.ops = Array.isArray(fsk.log) ? fsk.log.map((o, k) => sanitizeRecord(o, k)) : [];
  sk.blockers = Array.isArray(fsk.blockers) ? fsk.blockers.filter(x => typeof x === "string") : [];
  if (!Array.isArray(fsk.log) && fsk.ops)
    sk.blockers.push(`the file did not carry the ops log of its ${fsk.ops} op(s)`);
  sk.recording = fsk.recording !== false;
  if (fsk.saved) sk.saved = { rev: fsk.saved.dirty ? -1 : sk.rev, version: fsk.saved.version, at: fsk.saved.at };
  sk.reactivatedBy = scope.undoPushed[scope.undoPushed.length - 1];
  // the load brought the sketch back: it is not an op of it
  scope.opRecorded = true;
  if (cur) notes.push(`replaced the stopped sketch '${cur.slug}' (${cur.ops.length} ops)`);
  notes.push(
    `sketch '${fsk.slug}' is active again from the file (base v${b.base.version}, ${sk.ops.length} op(s), ${sk.recording ? "recording" : "stopped"}); sketch_promote works while v${b.base.version} is the shared map's current version, else rebase first`
  );
  return notes;
}
