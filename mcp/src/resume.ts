// Carrying work over a server restart (state.ts holds the files):
// - resumeState: a daemon at start, a stdio server on its first tool call (ensureState), takes
//   over TUPAIA_OUT/state (history, provenance, the active sketch, the screenshot counter and
//   records); the page map it names is loaded on the first browser launch;
// - ensureState: before every call; a server that could not take the state dir over (another
//   live server held it) retries, and takes it over once that server has exited: a server that
//   has done nothing yet resumes it, one with work of its own adopts the other's snapshots and
//   saves the other's page and sketch to maps/takeover-*.map (load_map brings them back);
// - persistState: after every call that may have changed any of that (context.ts);
// - saveOnExit: on stop/idle/transport close, save the page to maps/<daemon|stdio>-exit-*.map
//   with its provenance trailer (file-lineage.ts) and persist the state with that page.
import fs from "node:fs";
import path from "node:path";
import type { ToolContext } from "./context.ts";
import { LAST_FILE, type LastExit } from "./daemon-state.ts";
import { blockOf, withProvenance } from "./file-lineage.ts";
import { withTrailer } from "./map-provenance.ts";
import type { Resumed } from "./state.ts";

/** <prefix>-exit-*.map files kept in TUPAIA_OUT/maps, per prefix. */
const EXIT_SAVES_KEPT = 5;

function stamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "");
}

/**
 * At start. A daemon (`claim`) takes the state dir over now; a stdio server waits for its first
 * tool call (ensureState), so a stdio server nobody uses never holds it. Returns the note for
 * the first result, or null.
 */
export function resumeState(ctx: ToolContext, claim = true): string | null {
  ctx.shots.init(path.join(ctx.config.outDir, "shots"));
  if (!ctx.state.enabled || !claim) return null;
  if (!ctx.state.claim()) return ctx.state.note ? `state: ${ctx.state.note}` : null;
  return takeOver(ctx).note;
}

/**
 * Before every call: take the state dir over if this server does not hold it yet (first call of
 * a stdio server, or the server that held it has exited). Notes go to the call's result.
 */
export async function ensureState(ctx: ToolContext, notes: string[]): Promise<void> {
  const st = ctx.state;
  if (!st.enabled || st.owner) return;
  const first = !st.tried;
  const before = st.note;
  if (!st.claim()) {
    // say it once (first call, or when the holder changed), not on every call
    if (st.note && (first || st.note !== before)) notes.push(`state: ${st.note}`);
    return;
  }
  const late = !first;
  let t: { note: string | null };
  try {
    t = takeOver(ctx);
  } catch (e) {
    t = {
      note: `state: taking ${st.dir} over failed (${(e as Error).message}); this server persists its own work from now on`
    };
  }
  if (t.note) notes.push(late ? `state: the server that held ${st.dir} has exited; ${t.note}` : t.note);
  else if (late) notes.push(`state: this server now persists its history and sketch in ${st.dir}`);
  // the page is already up (a late takeover): put the resumed page in it now
  if (ctx.resumePage && ctx.browser.healthy && ctx.browser.launches > 0) await resumeLaunch(ctx);
}

/** An idle daemon whose sketch is not persisted: try to take the state dir over (and write it). */
export function retryState(ctx: ToolContext): void {
  if (!ctx.state.enabled || ctx.state.owner) return;
  void ctx.browser
    .exclusive(async () => {
      if (ctx.state.owner) return;
      const notes: string[] = [];
      await ensureState(ctx, notes);
      if (!ctx.state.owner) return;
      ctx.browser.pendingNotes.push(...notes);
      persistState(ctx);
    })
    .catch(() => {});
}

/** This server already has work of its own (a takeover must not replace it). */
function hasWork(ctx: ToolContext): boolean {
  const s = ctx.snapshots;
  return (
    !!ctx.sketches.current ||
    s.snapshots.length > 0 ||
    s.undoStack.length > 0 ||
    s.redoStack.length > 0 ||
    s.provenance.opsSince > 0
  );
}

/** Load the state dir (this process owns it) and take it in. */
function takeOver(ctx: ToolContext): { note: string | null } {
  const r = ctx.state.load();
  if (!r) return { note: null };
  if ("error" in r) return { note: `state: ${r.error}` };
  return { note: hasWork(ctx) ? adoptForeign(ctx, r) : importResumed(ctx, r) };
}

/** A page nobody edited is not worth resuming over a fresh boot (live: the current shared map). */
function unedited(ctx: ToolContext, r: Resumed): string | null {
  const rp = r.history.restorePoint;
  if (!rp || r.sketch || rp.provenance.opsSince > 0) return null;
  const p = rp.provenance;
  if (p.kind === "boot") return "the saved page was an unedited random map";
  if (p.kind === "shared" && ctx.mode.mode === "live")
    return `the saved page was the unedited shared map v${p.sharedVersion ?? "?"}, so the page loads the shared map's current version instead`;
  return null;
}

/** Resume the state into a server with nothing of its own yet. */
function importResumed(ctx: ToolContext, r: Resumed): string | null {
  const launched = ctx.browser.launches > 0;
  const prov = { ...ctx.snapshots.provenance };
  const skipPage = unedited(ctx, r);
  ctx.snapshots.importState(r.history);
  if (r.sketch) ctx.sketches.current = r.sketch;
  ctx.shots.init(path.join(ctx.config.outDir, "shots"), r.shotSeq);
  ctx.shots.adopt(r.shots);
  let rp = r.history.restorePoint;
  if (skipPage) {
    ctx.snapshots.restorePoint = null;
    rp = null;
  }
  if (rp) ctx.resumePage = { text: rp.text, provenance: { ...rp.provenance }, label: rp.label };
  else if (launched || skipPage) {
    // the page keeps what it holds (and its lineage), on an epoch of its own
    ctx.snapshots.provenance = prov;
    ctx.snapshots.newEpoch();
  }
  // only the screenshot counter (no page, history or sketch): nothing worth a note
  if (!rp && !skipPage && !r.sketch && !r.history.ring.length && !r.history.undo.length && !r.history.redo.length)
    return null;
  const sk = r.sketch;
  const parts = [
    rp
      ? `the page map (${rp.label}; origin ${rp.provenance.kind}${typeof rp.provenance.sharedVersion === "number" ? ` v${rp.provenance.sharedVersion}` : ""}, ${rp.provenance.opsSince} op(s) since) is loaded ${launched ? "into the page now" : "on the first browser launch"}`
      : (skipPage ?? "no page map was saved (the page boots fresh)"),
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
    from: ctx.state.file,
    savedAt: r.savedAt,
    pid: r.pid,
    transport: r.transport,
    ...(r.reason ? { reason: r.reason } : {}),
    sketch: sk ? sk.slug : null,
    snapshots: r.history.ring.length,
    undo: r.history.undo.length,
    ...(skipPage ? { pageSkipped: skipPage } : {})
  };
  return `resumed ${ctx.state.file} (saved ${r.savedAt} by pid ${r.pid}, ${r.transport}${r.reason ? `, ${r.reason}` : ""}): ${parts.join("; ")}.`;
}

/**
 * Take the state over into a server that has work of its own (it ran while another server held
 * the state dir): keep its page, history and sketch; add the other's snapshots; save the other's
 * page with its provenance and sketch to maps/takeover-*.map, so load_map continues it.
 */
function adoptForeign(ctx: ToolContext, r: Resumed): string {
  const from = `pid ${r.pid}`;
  const parts: string[] = [];
  const rp = r.history.restorePoint;
  const sk = r.sketch;
  if (rp && !unedited(ctx, r)) {
    const dir = path.join(ctx.config.outDir, "maps");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `takeover-${r.pid}-${stamp()}.map`);
    const block = blockOf(rp.provenance, sk, ctx.config.liveOrigin, `takeover (${from}, ${r.transport})`);
    fs.writeFileSync(file, withTrailer(rp.text, block, ctx.provKey), { flag: "wx" });
    parts.push(
      `its page${block.sketch ? ` and sketch '${block.sketch.slug}' (${block.sketch.ops} op(s))` : ""} went to ${file}: load_map {"path":"${file}"} continues it with its lineage`
    );
  } else if (sk) parts.push(`its sketch '${sk.slug}' (${sk.ops.length} op(s)) had no saved page and was not kept`);
  if (r.history.ring.length) {
    const { added, evicted } = ctx.snapshots.adopt(r.history.ring, from);
    if (evicted.length && ctx.browser.healthy)
      void ctx.browser
        .callBridge("dropBaseline", { keys: evicted }, { timeoutMs: 10_000, noAlerts: true })
        .catch(() => {});
    parts.push(
      `its snapshot(s) ${added.map(a => `'${a.label}'`).join(", ") || "(none fit TUPAIA_SNAPSHOTS_MAX)"} were added here`
    );
  }
  if (r.history.undo.length || r.history.redo.length)
    parts.push(
      `its ${r.history.undo.length} undo and ${r.history.redo.length} redo step(s) belong to its page and were not kept`
    );
  ctx.shots.init(path.join(ctx.config.outDir, "shots"), r.shotSeq);
  ctx.shots.adopt(r.shots);
  ctx.resumed = { from: ctx.state.file, savedAt: r.savedAt, pid: r.pid, transport: r.transport, adopted: true };
  return `took over ${ctx.state.file} from ${from} (${r.transport}, saved ${r.savedAt}) and kept this server's own page, history and sketch${parts.length ? `; ${parts.join("; ")}` : ""}.`;
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
    st.save(
      ctx.snapshots.exportState(),
      ctx.sketches.current,
      ctx.shots.seq,
      { transport: ctx.serving.transport, ...(reason ? { reason } : {}) },
      [...ctx.shots.records]
    );
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
  // a server that ran calls while another held the state dir: take it over now if it can
  if (!ctx.state.owner && ctx.state.tried && hasWork(ctx)) await ensureState(ctx, []).catch(() => {});
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
    // the state first (what the next start resumes): a client may kill this process soon (the
    // MCP SDK's stdio client sends SIGKILL 4 s after closing stdin)
    ctx.snapshots.setRestorePoint(text, `the page at exit (${reason})`, {
      writes: ctx.browser.writes,
      launches: ctx.browser.launches,
      callSeq: ctx.callSeq
    });
    persistState(ctx, `exit: ${reason}`);
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
