// Lineage through .map files (map-provenance.ts holds the trailer format): what save_map and the
// exit save embed, and what load_map makes of a file it reads.
//
// load_map binds the page back to the shared map only when all of these hold:
// - the file has a trailer whose content hash matches (unmodified);
// - it records shared lineage (a base version), against this server's live origin;
// - the shared map server agrees about that base where it can tell: the current version's
//   updated_at and blob sha256, or the retained version's size; a contradiction keeps the file
//   unrelated, a check that cannot be made (no live origin, network, not retained) binds with a
//   warning when the HMAC is this TUPAIA_OUT's;
// - a block signed with another key ('foreign': a save by the server of another TUPAIA_OUT, such
//   as the stdio server's default out dir vs a daemon's --out) binds only when that check
//   verified the base. Its sketch log is not trusted: the sketch comes back blob-only.
// A file that names a sketch reactivates it (slug, base, ops log) when no other sketch records.
import type { CallScope, ToolContext } from "./context.ts";
import { baseOf, checkTrailer, type ProvBase, type ProvBlock, type ProvSketch, withTrailer } from "./map-provenance.ts";
import { blobOnlyReasons, type OpRecord, type Sketch, type SketchBase, sanitizeRecord } from "./ops.ts";
import { sha256 } from "./shared-api.ts";
import type { Provenance } from "./snapshots.ts";

/** The sketch log rides along up to the size the Worker takes for ops.json. */
const LOG_MAX_BYTES = 2 * 1024 * 1024;

type Block = Omit<ProvBlock, "sha256" | "sig" | "v">;

/** The block for the map in the page (call ctx.verifyProvenance() first). */
export function blockFor(ctx: ToolContext, by: string, opts: { compacted?: boolean } = {}): Block {
  return blockOf(ctx.snapshots.provenance, ctx.sketches.current, ctx.config.liveOrigin, by, opts);
}

/**
 * The block for a map with provenance `p` while `sk` is the active sketch. A compacted copy
 * (save_map compact:true) is not the page: one more op since its base, and no sketch log.
 */
export function blockOf(
  p: Provenance,
  sk: Sketch | null,
  origin: string | null,
  by: string,
  opts: { compacted?: boolean } = {}
): Block {
  let base: ProvBase | null = baseOf(p);
  let sketch: ProvSketch | null = null;
  // the sketch rides along only when the page is its map (not a stopped rebase) on the same base
  if (base && sk && !opts.compacted && !sk.suspended && sk.base.kind === "shared" && sk.base.version === base.version) {
    const log = sk.ops.map(({ undoId: _u, ...o }) => o);
    const fits = JSON.stringify(log).length <= LOG_MAX_BYTES;
    const bytes = sk.base.bytes ?? base.bytes;
    const hash = sk.base.sha256 ?? base.sha256;
    base = {
      version: base.version,
      updatedAt: sk.base.updatedAt ?? base.updatedAt,
      updatedBy: sk.base.updatedBy ?? base.updatedBy,
      ...(typeof bytes === "number" ? { bytes } : {}),
      ...(hash ? { sha256: hash } : {})
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
    origin,
    lineage: base ? "shared" : "none",
    kind: p.kind,
    seed: p.seed ?? null,
    base,
    opsSince: p.opsSince + (opts.compacted && base ? 1 : 0),
    sketch,
    ...(opts.compacted ? { compacted: true } : {})
  };
}

/** `text` (prepareMapData of the page) with the signed provenance line appended. */
export function withProvenance(ctx: ToolContext, text: string, by: string): string {
  return withTrailer(text, blockFor(ctx, by), ctx.provKey);
}

/** One line for a result: "shared v8, sketch 'x' (12 ops)" or "unrelated". */
export function lineageWord(b: Block): string {
  if (b.lineage !== "shared" || !b.base) return `none (${b.kind})`;
  return `shared v${b.base.version}${b.sketch ? `, sketch '${b.sketch.slug}' (${b.sketch.ops} ops)` : ""}, ${b.opsSince} op(s) since${b.compacted ? " (compacted copy)" : ""}`;
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
    if (!b.base.sha256) return { verdict: "verified", note: `base v${n} is the shared map's current version` };
    // the blob itself (one read-only GET): same bytes as the base the file was derived from?
    let blob: Awaited<ReturnType<ToolContext["shared"]["getMap"]>>;
    try {
      blob = await ctx.shared.getMap();
    } catch (e) {
      return { verdict: "unverifiable", note: `base v${n} NOT verified: ${(e as Error).message}` };
    }
    if (blob.version !== null && blob.version !== n)
      return { verdict: "unverifiable", note: `base v${n} NOT verified: the shared map moved on to v${blob.version}` };
    if (sha256(blob.bytes) !== b.base.sha256)
      return {
        verdict: "mismatch",
        note: `the shared map's v${n} is not the blob the file's base was (sha256 differs)`
      };
    return { verdict: "verified", note: `base v${n} is the shared map's current version (same sha256)` };
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
  // (the Worker serves no retained version's bytes or hash: its size is all that can be compared)
}

/** What a file's trailer says about its lineage, checked (see the header). */
export async function fileLineage(ctx: ToolContext, bytes: Buffer): Promise<FileLineage> {
  const c = checkTrailer(bytes, ctx.provKey);
  if (c.status === "none")
    return {
      file: "none",
      lineage: "unrelated",
      note: "no provenance line (an app save, another tool's file, or a save from before lineage trailers): unrelated to the shared map"
    };
  if (c.status !== "valid" && c.status !== "foreign")
    return { file: c.status, lineage: "unrelated", note: `provenance ignored: ${c.reason}` };
  const b = c.block;
  const file = c.status;
  if (b.lineage !== "shared" || !b.base || typeof b.base.version !== "number")
    return {
      file,
      lineage: "unrelated",
      block: b,
      note: `saved from a map not derived from the shared map (${b.kind})`
    };
  const v = await checkBase(ctx, b as ProvBlock & { base: ProvBase });
  if (v.verdict === "mismatch")
    return {
      file,
      lineage: "unrelated",
      block: b,
      baseCheck: v.verdict,
      note: `its claimed base v${b.base.version} does not hold: ${v.note}`
    };
  if (file === "foreign" && v.verdict !== "verified")
    return {
      file,
      lineage: "unrelated",
      block: b,
      baseCheck: v.verdict,
      note: `${c.reason}; such a file keeps shared lineage only when the shared map server verifies its base, and here: ${v.note}`
    };
  const notes = [v.note];
  if (b.compacted) notes.push("a compacted copy (removed records as stubs, counted as one op)");
  if (file === "foreign")
    notes.push(
      `signed with another TUPAIA_OUT's key (content hash intact, base verified)${b.sketch ? `: the log of sketch '${b.sketch.slug}' is not trusted, so the sketch comes back blob-only (promote while v${b.base.version} is current; no rebase)` : ""}`
    );
  return { file, lineage: "shared", block: b, baseCheck: v.verdict, note: notes.join("; ") };
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
    ...(b.base.sha256 ? { sharedSha256: b.base.sha256 } : {}),
    ...(fsk ? { sketchSlug: fsk.slug } : {}),
    restoredFrom: `file ${abs}`,
    opsSince: b.opsSince
  });
  const notes: string[] = [];
  if (!fsk) return notes;
  const cur = ctx.sketches.current;
  if (cur && cur.slug === fsk.slug && cur.base.kind === "shared" && cur.base.version === b.base.version) {
    if (cur.recording && sameLog(cur.ops, fsk.log)) {
      const after = await scope.digest();
      const undoId = scope.undoPushed[scope.undoPushed.length - 1];
      if (after !== null && after === scope.digestBefore && undoId !== undefined) {
        // the page already held this map: nothing to log, nothing to undo (at the undo cap the
        // push evicted the oldest entry; that one stays gone)
        const key = ctx.snapshots.popUndo(undoId);
        if (key) {
          scope.undoPushed.pop();
          await scope.cleanup(() => scope.call("dropBaseline", { key }, { noAlerts: true })).catch(() => {});
        }
        scope.opRecorded = true;
        notes.push(
          `the file holds sketch '${fsk.slug}' at the same op (${fsk.ops}) and the page already held that map: no op logged${key ? ", no undo entry" : ""}`
        );
        return notes;
      }
      // the page had drifted from the log: the load puts it back (one no-op op, so undo can take it out)
      await scope.record("load_map", args, null, {
        replayable: true,
        noop: true,
        summary: `Loaded ${abs}: the page is the sketch at op ${fsk.ops} again (a no-op for the log; rebase and promote skip it).`
      });
      notes.push(
        `the file holds sketch '${fsk.slug}' at the same op (${fsk.ops}); the page differed from it, so the load is logged as a no-op (rebase skips it; snapshot undo takes it out)`
      );
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
  if (cur?.ops.length && !(cur.saved && cur.saved.rev === cur.rev)) {
    // its log exists nowhere else (never saved to the Worker): never dropped by a load
    notes.push(
      `the stopped sketch '${cur.slug}' has ${cur.ops.length} op(s) not saved to the Worker, so the file's sketch '${fsk.slug}' was not reactivated (the page is still the file's map at base v${b.base.version}); save or discard '${cur.slug}', then load the file again`
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
    ...(typeof b.base.bytes === "number" ? { bytes: b.base.bytes } : {}),
    ...(b.base.sha256 ? { sha256: b.base.sha256 } : {})
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
  else if (fl.file === "foreign" && sk.ops.length)
    sk.blockers.push(
      `its ops log came from a file signed with another TUPAIA_OUT's key, so it is not replayed (${abs})`
    );
  sk.recording = fsk.recording !== false;
  if (fsk.saved) sk.saved = { rev: fsk.saved.dirty ? -1 : sk.rev, version: fsk.saved.version, at: fsk.saved.at };
  sk.reactivatedBy = scope.undoPushed[scope.undoPushed.length - 1];
  // the load brought the sketch back: it is not an op of it
  scope.opRecorded = true;
  if (cur) {
    if (cur.ops.length) sk.replacedSlug = cur.slug;
    notes.push(
      `replaced the stopped sketch '${cur.slug}' (${cur.ops.length} op(s)${cur.ops.length ? ", saved to the Worker: sketch open brings it back" : ""})`
    );
  }
  const blobOnly = blobOnlyReasons(sk).length > 0;
  notes.push(
    `sketch '${fsk.slug}' is active again from the file (base v${b.base.version}, ${sk.ops.length} op(s), ${sk.recording ? "recording" : "stopped"}${blobOnly ? ", blob-only" : ""}); sketch_promote works while v${b.base.version} is the shared map's current version, ${blobOnly ? "else (blob-only: no rebase) start a new sketch from the current shared map" : "else rebase first"}`
  );
  return notes;
}
