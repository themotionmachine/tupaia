// Carrying work over a server restart (state.ts holds the files):
// - resumeState: at start, take over TUPAIA_OUT/state (history, provenance, the active sketch,
//   the screenshot counter); the page map it names is loaded on the first browser launch;
// - persistState: after every call that may have changed any of that (context.ts);
// - saveOnExit: on stop/idle/transport close, save the page to maps/<daemon|stdio>-exit-*.map
//   with its provenance trailer (file-lineage.ts) and persist the state with that page.
import fs from "node:fs";
import path from "node:path";
import type { ToolContext } from "./context.ts";
import { LAST_FILE, type LastExit } from "./daemon-state.ts";
import { withProvenance } from "./file-lineage.ts";

/** <prefix>-exit-*.map files kept in TUPAIA_OUT/maps, per prefix. */
const EXIT_SAVES_KEPT = 5;

function stamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "");
}

/** Take over the state dir and import it. Returns the note for the first result, or null. */
export function resumeState(ctx: ToolContext): string | null {
  const st = ctx.state;
  ctx.shots.init(path.join(ctx.config.outDir, "shots"));
  if (!st.enabled) return null;
  if (!st.claim()) return st.note ? `state: ${st.note}` : null;
  const r = st.load();
  if (!r) return null;
  if ("error" in r) return `state: ${r.error}`;
  ctx.snapshots.importState(r.history);
  if (r.sketch) ctx.sketches.current = r.sketch;
  ctx.shots.init(path.join(ctx.config.outDir, "shots"), r.shotSeq);
  const rp = r.history.restorePoint;
  // only the screenshot counter (no page, history or sketch): nothing worth a note
  if (!rp && !r.sketch && !r.history.ring.length && !r.history.undo.length && !r.history.redo.length) return null;
  if (rp) ctx.resumePage = { text: rp.text, provenance: { ...rp.provenance }, label: rp.label };
  const sk = r.sketch;
  const parts = [
    rp
      ? `the page map (${rp.label}; origin ${rp.provenance.kind}${typeof rp.provenance.sharedVersion === "number" ? ` v${rp.provenance.sharedVersion}` : ""}, ${rp.provenance.opsSince} op(s) since) is loaded on the first browser launch`
      : "no page map was saved (the page boots fresh)",
    sk
      ? `sketch '${sk.slug}' (base ${sk.base.kind === "shared" ? `v${sk.base.version}` : "file"}, ${sk.ops.length} op(s), ${sk.recording ? "recording" : "stopped"}${sk.saved && sk.saved.rev === sk.rev ? ", saved" : ", unsaved"}) is active again`
      : null,
    `${r.history.ring.length} snapshot(s), ${r.history.undo.length} undo and ${r.history.redo.length} redo step(s)`,
    r.pruned
      ? `${r.pruned} older history entr${r.pruned === 1 ? "y was" : "ies were"} over TUPAIA_SNAPSHOTS_MAX(_MB) and not kept`
      : null,
    r.dropped.length ? `missing or damaged and left out: ${r.dropped.join(", ")}` : null
  ].filter(Boolean);
  ctx.resumed = {
    from: st.file,
    savedAt: r.savedAt,
    pid: r.pid,
    transport: r.transport,
    ...(r.reason ? { reason: r.reason } : {}),
    sketch: sk ? sk.slug : null,
    snapshots: r.history.ring.length,
    undo: r.history.undo.length
  };
  return `resumed ${st.file} (saved ${r.savedAt} by pid ${r.pid}, ${r.transport}${r.reason ? `, ${r.reason}` : ""}): ${parts.join("; ")}.`;
}

/** First browser launch after a resume: load the saved page map and its provenance. */
export async function resumeLaunch(ctx: ToolContext): Promise<void> {
  const r = ctx.resumePage;
  ctx.resumePage = null;
  if (!r) return;
  const env = await ctx.browser
    .callBridge<{ mapId?: number }>(
      "loadMap",
      { text: r.text, keepView: false, timeoutMs: 110_000 },
      { timeoutMs: 120_000, mutating: true }
    )
    .catch(e => ({ ok: false as const, error: { message: (e as Error).message }, value: undefined }));
  if (!env.ok) {
    ctx.snapshots.setProvenance({ kind: "boot", seed: null, mapId: null });
    const sk = ctx.sketches.current;
    const why = `the resumed page map could not be loaded (${env.error?.message ?? "?"})`;
    if (sk?.recording) sk.blockers.push(`${why}; the page is a fresh map, not the sketch`);
    else if (sk) sk.diverged ??= why;
    ctx.browser.pendingNotes.push(
      `resume: ${why}; the page holds a fresh random map (snapshot restore/undo still work)`
    );
    return;
  }
  ctx.snapshots.provenance = { ...r.provenance, mapId: env.value?.mapId ?? null };
  ctx.browser.pendingNotes.push(`resume: the page holds ${r.label} again`);
}

/** Write the state dir (no-op unless this process owns it). Failures become a session note. */
export function persistState(ctx: ToolContext, reason?: string): void {
  const st = ctx.state;
  if (!st.owner) return;
  try {
    st.save(ctx.snapshots.exportState(), ctx.sketches.current, ctx.shots.seq, {
      transport: ctx.serving.transport,
      ...(reason ? { reason } : {})
    });
    if (st.note?.startsWith("persisting failed")) st.note = null;
  } catch (e) {
    const msg = `persisting failed: ${(e as Error).message}`;
    if (st.note !== msg) process.stderr.write(`[tupaia-mcp] state: ${msg}\n`);
    st.note = msg;
  }
}

/**
 * Before the page dies with the process: save a changed page to TUPAIA_OUT/maps/<prefix>-exit-
 * <time>.map with its provenance (LAST_FILE names it for the next start) and persist the state
 * with that page as the one to resume. Returns the file, or null when nothing needed saving.
 */
export async function saveOnExit(
  ctx: ToolContext,
  reason: string,
  opts: { prefix: string; timeoutMs: number; log: (msg: string) => void }
): Promise<string | null> {
  const p = ctx.snapshots.provenance;
  if (!ctx.browser.healthy || (p.kind === "boot" && p.opsSince === 0)) {
    persistState(ctx, `exit: ${reason}`);
    return null;
  }
  const save = ctx.browser.exclusive(async () => {
    const env = await ctx.browser.callBridge<{ text: string }>(
      "mapData",
      {},
      { timeoutMs: opts.timeoutMs - 1000, noAlerts: true }
    );
    if (!env.ok || !env.value?.text) throw new Error(env.error?.message ?? "no map text");
    const text = env.value.text;
    await ctx.verifyProvenance();
    const dir = path.join(ctx.config.outDir, "maps");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${opts.prefix}-exit-${stamp()}.map`);
    fs.writeFileSync(file, withProvenance(ctx, text, `exit (${reason})`));
    const re = new RegExp(`^${opts.prefix}-exit-.*\\.map$`);
    const old = fs
      .readdirSync(dir)
      .filter(f => re.test(f))
      .sort()
      .slice(0, -EXIT_SAVES_KEPT);
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
    const last: LastExit = {
      pid: process.pid,
      reason,
      at: new Date().toISOString(),
      savedMap: file,
      transport: ctx.serving.transport
    };
    fs.writeFileSync(path.join(ctx.config.outDir, LAST_FILE), `${JSON.stringify(last)}\n`);
    // the next start resumes exactly this page
    ctx.snapshots.setRestorePoint(text, `the page at exit (${reason})`, {
      writes: ctx.browser.writes,
      launches: ctx.browser.launches,
      callSeq: ctx.callSeq
    });
    persistState(ctx, `exit: ${reason}`);
    opts.log(`saved the page map to ${file}`);
    return file;
  });
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`no map within ${opts.timeoutMs} ms`)), opts.timeoutMs).unref();
  });
  return Promise.race([save, timeout]).catch(e => {
    opts.log(`could not save the page map on exit: ${(e as Error).message}`);
    persistState(ctx, `exit: ${reason}`);
    return null;
  });
}
