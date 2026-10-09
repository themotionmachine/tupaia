// sketch and sketch_promote: provisional sketches of the shared map.
//
// A sketch is "base version N of the shared map plus the ops that produced it". start begins
// recording every mutating call into an ops log (src/ops.ts); summary describes it for humans
// with before/after screenshots; stop ends recording; rebase replays the log onto the current
// shared map (src/replay.ts). save/discard write the Worker id `sketch-<slug>` (blob + ops.json;
// live mode only, never `shared`); list/open read them. sketch_promote is shared_save's gate
// (preview -> one-time token -> confirm) for a sketch whose base is the current shared version.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CallScope, ToolContext } from "../context.ts";
import {
  type AddResolved,
  blobOnlyReasons,
  type EditResolved,
  type PaintResolved,
  REPLAY_EXT,
  type Sketch,
  type SketchBase,
  sanitizeRecord
} from "../ops.ts";
import { resolveReadPath } from "../paths.ts";
import { replayOps } from "../replay.ts";
import { META_TEXT_HEAVY, ToolError } from "../result.ts";
import { type LAYER_NAMES, TimeoutMs } from "../schemas.ts";
import { sha256 } from "../shared-api.ts";
import { defineTools } from "./registry.ts";
import { requireLive, sharedSave } from "./shared.ts";
import { takeScreenshot } from "./view.ts";

type LayerNameT = (typeof LAYER_NAMES)[number];

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const SKETCH_ACTIONS = [
  "start",
  "status",
  "summary",
  "stop",
  "rebase",
  "save",
  "list",
  "open",
  "discard"
] as const;

/** ops.json schema version written by save and understood by open. */
export const OPS_SCHEMA = 1;

/** The link that opens a saved sketch in the app (the ?maplink boot path). */
export function viewUrl(origin: string, slug: string): string {
  return `${origin}/?maplink=${encodeURIComponent(`${origin}/api/map/sketch-${slug}`)}`;
}

const sketchId = (slug: string) => `sketch-${slug}`;

export function needSketch(ctx: ToolContext): Sketch {
  const sk = ctx.sketches.current;
  if (!sk) throw new ToolError("REFUSED", "no sketch: start one with sketch {action:'start'} on the shared map");
  return sk;
}

/** Base of a new sketch from the page's provenance, or a REFUSED error with the fix. */
function baseFromProvenance(ctx: ToolContext, notes: string[]): SketchBase {
  const p = ctx.snapshots.provenance;
  const at = new Date().toISOString();
  if (p.opsSince > 0) {
    throw new ToolError(
      "REFUSED",
      `the page map has ${p.opsSince} change(s) since it was loaded that a sketch would not know about. Fix: load_map {source:'shared'} again (or undo them), then sketch {action:'start'}.`
    );
  }
  if (p.kind === "shared" && typeof p.sharedVersion === "number") {
    return {
      kind: "shared",
      id: "shared",
      version: p.sharedVersion,
      updatedBy: p.sharedUpdatedBy ?? null,
      updatedAt: p.sharedUpdatedAt ?? null,
      at
    };
  }
  if (ctx.config.testHooks && p.kind === "file" && p.path) {
    notes.push(
      "test hook (TUPAIA_TEST_HOOKS=1): this sketch's base is a map FILE, not the shared map; it can be summarised and rebased onto files, not saved or promoted"
    );
    return { kind: "file", path: p.path, at };
  }
  throw new ToolError(
    "REFUSED",
    `a sketch records changes to the shared map, but the page map's origin is '${p.kind}'${p.kind === "shared" ? " without a known version" : ""}. Fix: load_map {source:'shared'} (a read-only GET), then sketch {action:'start'}.`
  );
}

function defaultSlug(): string {
  return new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-").toLowerCase();
}

async function start(ctx: ToolContext, scope: CallScope, args: { slug?: string; note?: string }) {
  const old = ctx.sketches.current;
  if (old?.recording)
    throw new ToolError(
      "REFUSED",
      `sketch '${old.slug}' is recording; stop it first (sketch {action:'stop'}) or keep working in it`
    );
  await ctx.verifyProvenance();
  const notes: string[] = [];
  const base = baseFromProvenance(ctx, notes);
  const slug = args.slug ?? defaultSlug();
  const baseText = await scope.mapText();
  const summary = await scope.call<{ counts: Record<string, number> }>("summary", {}, { noAlerts: true });
  if (old) notes.push(`replaced the stopped sketch '${old.slug}' (${old.ops.length} ops)`);
  const sk = ctx.sketches.begin({ slug, note: args.note ?? null, base, baseText, baseCounts: summary.counts });
  scope.notes.push(...notes);
  return {
    started: true,
    ...ctx.sketches.view(sk),
    next: "Every mutating call (edit, add, paint_cells, display, eval, ...) is now logged. sketch {action:'summary'} describes it; snapshot undo takes an op back out."
  };
}

function baseLine(b: SketchBase): string {
  if (b.kind === "shared")
    return `shared map v${b.version}${b.updatedBy ? `, saved by ${b.updatedBy}` : ""}${b.updatedAt ? ` at ${b.updatedAt}` : ""}`;
  return `map file ${b.path} (test base)`;
}

/** The entity the sketch touched most (edits per field, adds, paints), best first. */
export function changeRanking(
  sk: Sketch
): Array<{ type: string; i: number | string; score: number; layers?: string[] }> {
  const score = new Map<string, { type: string; i: number | string; score: number; layers?: string[] }>();
  const bump = (type: string, i: unknown, n: number, layers?: string[]) => {
    if (typeof i !== "number" && typeof i !== "string") return;
    const k = `${type}:${i}`;
    const cur = score.get(k) ?? { type, i, score: 0 };
    cur.score += n;
    if (layers) cur.layers = layers; // the latest op's view
    score.set(k, cur);
  };
  for (const o of sk.ops) {
    if (!o.resolved || !o.replayable) continue;
    // tools registered with a focus hook (e.g. regenerate:provinces-emblems) name their own
    for (const f of REPLAY_EXT[o.tool]?.focus?.(o.resolved) ?? []) bump(f.type, f.i, f.score, f.layers);
    if (o.tool === "edit") {
      const e = o.resolved as EditResolved;
      if (e.type === "map") continue;
      for (const x of e.ops) if (!x.remove) bump(e.type, x.ref, Object.keys(x.set ?? {}).length);
    } else if (o.tool === "add") {
      const a = o.resolved as AddResolved;
      for (const list of a.created ?? []) if (list[0]) bump(list[0].type, list[0].i, 3);
    } else if (o.tool === "paint_cells") {
      const p = o.resolved as PaintResolved;
      const n = 2 + Math.min(10, Math.floor(p.select.cells.length / 25));
      for (const k of ["state", "province", "culture", "religion", "biome"])
        if (k in p.set && p.set[k]) bump(k, p.set[k], n);
    }
  }
  return [...score.values()].sort((a, b) => b.score - a.score);
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

async function framedTarget(
  scope: CallScope,
  sk: Sketch
): Promise<{
  type: string;
  i: number | string;
  name: string | null;
  bbox: [number, number, number, number];
  layers?: string[];
  op?: boolean;
} | null> {
  for (const c of changeRanking(sk).slice(0, 6)) {
    const env = await scope.envelope<Box & { name?: string }>(
      "entityBox",
      { type: c.type, ref: c.i },
      { noAlerts: true }
    );
    if (!env.ok || !env.value) continue;
    const b = env.value;
    const pad = Math.max(40, 0.15 * Math.max(b.x1 - b.x0, b.y1 - b.y0));
    return {
      type: c.type,
      i: c.i,
      name: b.name ?? null,
      bbox: [b.x0 - pad, b.y0 - pad, b.x1 + pad, b.y1 + pad],
      ...(c.layers ? { layers: c.layers } : {})
    };
  }
  // no entity to frame: an op that knows the area it changed (set_heights), the latest first
  for (const o of [...sk.ops].reverse()) {
    const f = o.resolved && o.replayable ? REPLAY_EXT[o.tool]?.frame?.(o.resolved) : null;
    if (!f) continue;
    const [x0, y0, x1, y1] = f.bbox;
    const pad = Math.max(40, 0.15 * Math.max(x1 - x0, y1 - y0));
    return {
      type: o.tool,
      i: o.seq,
      name: f.label,
      bbox: [x0 - pad, y0 - pad, x1 + pad, y1 + pad],
      layers: f.layers,
      op: true
    };
  }
  return null;
}

/** Layers that show a change to an entity of this type (turned on for the summary shots only). */
const LAYERS_FOR: Record<string, LayerNameT[]> = {
  state: ["states", "borders"],
  province: ["provinces", "borders"],
  culture: ["cultures"],
  religion: ["religions"],
  burg: ["burgs", "labels"],
  route: ["routes"],
  marker: ["markers"],
  zone: ["zones"],
  label: ["labels"],
  biome: ["biomes"]
};

async function shoot(
  ctx: ToolContext,
  scope: CallScope,
  file: string,
  how: { full: true } | { bbox: [number, number, number, number] },
  layersOn: LayerNameT[]
): Promise<string | null> {
  try {
    const shot = await takeScreenshot(ctx, scope, {
      ...("full" in how ? { full: true } : { target: { bbox: how.bbox } }),
      ...(layersOn.length ? { layers: { on: layersOn } } : {}),
      saveTo: file,
      overwrite: true,
      maxSide: 512
    });
    return (shot.value as { file: string }).file;
  } catch (e) {
    scope.notes.push(`screenshot ${file} failed: ${(e as Error).message}`);
    return null;
  }
}

/** Make the page show exactly `layers` (a load can switch layers on, e.g. 'trade'). */
async function matchLayers(scope: CallScope, layers: readonly string[]): Promise<void> {
  const now = await scope.call<string[]>("layersOn", {}, { noAlerts: true });
  const want = new Set(layers);
  const on = layers.filter(l => !now.includes(l));
  const off = now.filter(l => !want.has(l));
  if (on.length || off.length) await scope.call("setLayers", { on, off }, { noAlerts: true });
}

/**
 * The summary's screenshots, like for like: the same layers and the same views for the base
 * and the sketch, each pair taken right after the same steps (match layers -> fit view ->
 * full shot -> framed shot). The page's layers and view are put back afterwards.
 */
async function summaryShots(
  ctx: ToolContext,
  scope: CallScope,
  sk: Sketch,
  target: Awaited<ReturnType<typeof framedTarget>>
): Promise<Record<string, string | null>> {
  const shots: Record<string, string | null> = {};
  const dir = path.join("sketches", sk.slug);
  const on = target ? ((target.layers as LayerNameT[] | undefined) ?? LAYERS_FOR[target.type] ?? []) : [];
  const layers0 = await scope.call<string[]>("layersOn", {}, { noAlerts: true });
  const view0 = await scope.call<{ x: number; y: number; scale: number }>("getView", {}, { noAlerts: true });
  const pair = async (which: "before" | "after") => {
    await matchLayers(scope, layers0).catch(e =>
      scope.notes.push(`${which} shots: could not match the page's layers (${(e as Error).message})`)
    );
    await scope.call("resetView", {}, { noAlerts: true });
    // a loaded map can lack burg icons and labels until something redraws them (the demo map
    // does); draw them, at the same zoom, for both pairs so neither shows labels the other lacks
    await scope
      .call("redraw", { layers: ["burgIcons", "labels"] }, { noAlerts: true })
      .catch(e => scope.notes.push(`${which} shots: redraw failed (${(e as Error).message})`));
    shots[`${which}Full`] = await shoot(ctx, scope, path.join(dir, `${which}-full.png`), { full: true }, on);
    if (target)
      shots[`${which}Framed`] = await shoot(
        ctx,
        scope,
        path.join(dir, `${which}-framed.png`),
        { bbox: target.bbox },
        on
      );
  };
  if (!sk.baseText) {
    scope.notes.push("no before shots: this sketch was opened from the Worker, which keeps no copy of its base");
    try {
      await pair("after");
    } finally {
      await matchLayers(scope, layers0).catch(() => {});
      await scope.call("setView", { view: view0 }, { noAlerts: true }).catch(() => {});
    }
    return shots;
  }
  // the base: load it without an undo entry and shoot; then load the page map back and shoot
  // it the same way, so both pairs come from a freshly loaded page
  await ctx.verifyProvenance();
  const prov = { ...ctx.snapshots.provenance };
  const current = await scope.mapText();
  try {
    await scope.loadMap({ text: sk.baseText });
    await pair("before");
  } finally {
    let back: Record<string, unknown>;
    try {
      back = await scope.loadMap({ text: current });
    } catch {
      back = await scope.loadMap({ text: current });
    }
    ctx.snapshots.provenance = { ...prov, mapId: typeof back.mapId === "number" ? back.mapId : null };
  }
  try {
    await pair("after");
  } finally {
    await matchLayers(scope, layers0).catch(() => {});
    await scope.call("setView", { view: view0 }, { noAlerts: true }).catch(() => {});
  }
  return shots;
}

async function summary(ctx: ToolContext, scope: CallScope, args: { shots?: boolean }) {
  const sk = needSketch(ctx);
  const now = await scope.call<{ counts: Record<string, number> }>("summary", {}, { noAlerts: true });
  // a count the base never recorded (a sketch started before it was counted) is left out
  const keys = [...new Set([...Object.keys(sk.baseCounts), ...Object.keys(now.counts)])].filter(
    k => sk.baseCounts[k] !== undefined
  );
  const counts = keys.map(k => ({ k, base: sk.baseCounts[k] ?? 0, now: now.counts[k] ?? 0 }));
  const target = await framedTarget(scope, sk);
  const shots: Record<string, string | null> = args.shots !== false ? await summaryShots(ctx, scope, sk, target) : {};
  const reasons = blobOnlyReasons(sk);
  const lines: string[] = [];
  lines.push(`# Sketch ${sk.slug}`, "");
  if (sk.note) lines.push(sk.note, "");
  lines.push(`- Base: ${baseLine(sk.base)}`);
  lines.push(`- Operations: ${sk.ops.length}${sk.recording ? " (recording)" : " (stopped)"}`);
  if (ctx.config.liveOrigin) lines.push(`- View: ${viewUrl(ctx.config.liveOrigin, sk.slug)}`);
  if (reasons.length) lines.push(`- Blob only (cannot be replayed onto a newer shared map): ${reasons.join("; ")}`);
  if (sk.ops.some(o => o.unsafe)) lines.push("- Contains eval code, replayed verbatim (marked unsafe).");
  lines.push("", "## Changes", "");
  if (!sk.ops.length) lines.push("(none yet)");
  for (const o of sk.ops) lines.push(`${o.seq}. ${o.summary}${o.unsafe ? " [unsafe]" : ""}`);
  lines.push("", "## Counts vs base", "", "| | base | now | change |", "| --- | --- | --- | --- |");
  const changed = counts.filter(c => c.base !== c.now);
  for (const c of changed)
    lines.push(`| ${c.k} | ${c.base} | ${c.now} | ${c.now - c.base > 0 ? "+" : ""}${c.now - c.base} |`);
  if (!changed.length) lines.push("| (no count changed) | | | |");
  const same = counts.filter(c => c.base === c.now).map(c => c.k);
  if (same.length) lines.push("", `Unchanged: ${same.join(", ")}.`);
  const shotFiles = Object.entries(shots).filter(([, f]) => !!f);
  if (shotFiles.length) {
    lines.push("", "## Screenshots", "");
    if (target?.op) lines.push(`Framed on the area op ${target.i} changed: ${target.name}.`, "");
    else if (target)
      lines.push(
        `Framed on the most-changed entity: ${target.type} ${target.name ? `'${target.name}' ` : ""}(${target.i}).`,
        ""
      );
    for (const [k, f] of shotFiles) lines.push(`- ${k}: ${f}`);
  }
  const markdown = `${lines.join("\n")}\n`;
  sk.summaryMarkdown = markdown;
  sk.summaryRev = sk.rev;
  const mdFile = path.join(ctx.config.outDir, "sketches", sk.slug, "summary.md");
  fs.mkdirSync(path.dirname(mdFile), { recursive: true });
  fs.writeFileSync(mdFile, markdown);
  return {
    markdown,
    file: mdFile,
    shots,
    framedOn: target ? { type: target.type, i: target.i, name: target.name } : null,
    counts: changed.map(c => ({ field: c.k, base: c.base, now: c.now })),
    blobOnly: reasons.length > 0
  };
}

/** REFUSED with the reasons when the sketch cannot be replayed. */
export function refuseBlobOnly(sk: Sketch): void {
  const reasons = blobOnlyReasons(sk);
  if (reasons.length)
    throw new ToolError(
      "REFUSED",
      `sketch '${sk.slug}' is blob-only, so it cannot be replayed: ${reasons.join("; ")}. It can still be saved and viewed as a blob.`
    );
}

/**
 * Replay the sketch's log onto a map that `load` puts into the page. On completion (no stop)
 * the sketch's base becomes `base` and its ops the applied ones. On a stop the sketch keeps its
 * base and ops, the page keeps the partial replay, and undoing the rebase's undo entries
 * (one per applied op, plus the load) returns to the sketch.
 */
export async function rebaseOnto(
  ctx: ToolContext,
  scope: CallScope,
  sk: Sketch,
  target: {
    describe: string;
    base: SketchBase;
    /** Load the target map into the page and set provenance. */
    load: () => Promise<void>;
  },
  onConflict: "stop" | "skip"
): Promise<Record<string, unknown>> {
  refuseBlobOnly(sk);
  if (sk.diverged)
    scope.notes.push(`the page had changes the log does not hold (${sk.diverged}); the rebase drops them`);
  // a rebase on top of a stopped one: undoing back to the sketch passes through both
  const entries: number[] = [...(sk.suspended?.entries ?? [])];
  entries.push(await scope.pushUndo("sketch rebase", { onto: target.describe }));
  await target.load();
  const baseText = await scope.mapText();
  const baseSummary = await scope.call<{ counts: Record<string, number> }>("summary", {}, { noAlerts: true });
  const res = await replayOps(ctx, scope, sk.ops, { onConflict, label: "sketch replay" });
  entries.push(...res.undoEntries);
  scope.notes.push(...res.notes);
  const completed = !res.stopped;
  const report = {
    onto: target.describe,
    onConflict,
    completed,
    applied: res.applied,
    skipped: res.skipped,
    noops: res.noops.length ? res.noops : undefined,
    conflicts: res.conflicts.map(c => ({
      seq: c.seq,
      reason: c.reason,
      op: { seq: c.op.seq, tool: c.op.tool, summary: c.op.summary, args: c.op.args }
    })),
    idMap: res.idMap,
    at: new Date().toISOString()
  };
  if (completed) {
    sk.base = target.base;
    sk.baseText = baseText;
    sk.baseCounts = baseSummary.counts;
    sk.ops = res.records;
    sk.redo = [];
    sk.blockers = [];
    sk.suspended = null;
    sk.diverged = null;
    sk.summaryMarkdown = null;
    sk.rev++;
  } else {
    const first = res.conflicts[res.conflicts.length - 1];
    sk.suspended = {
      reason: `a rebase onto ${target.describe} stopped at op ${first?.seq}: ${first?.reason}`,
      entries
    };
    if (entries.length > ctx.snapshots.undoDepth)
      scope.notes.push(
        `the undo history keeps ${ctx.snapshots.undoDepth} entries but the rebase pushed ${entries.length}; the sketch page can no longer be reached by undo (raise TUPAIA_UNDO_DEPTH)`
      );
  }
  sk.lastRebase = report;
  return {
    ...report,
    sketch: ctx.sketches.view(sk),
    next: completed
      ? `the page holds the sketch replayed onto ${target.describe}; its base is now that map`
      : `stopped: the page holds the partial replay (the sketch itself is unchanged). snapshot {action:'undo', n:${entries.length}} returns to the sketch; or rebase again with onConflict:'skip'`
  };
}

async function rebase(
  ctx: ToolContext,
  scope: CallScope,
  args: { onto?: { path: string }; onConflict?: "stop" | "skip" }
) {
  const sk = needSketch(ctx);
  if (!args.onto) return rebaseShared(ctx, scope, sk, args.onConflict ?? "stop");
  if (!ctx.config.testHooks)
    throw new ToolError("REFUSED", "rebase {onto:{path}} is a test hook (TUPAIA_TEST_HOOKS=1)");
  refuseBlobOnly(sk);
  const abs = resolveReadPath(ctx.config, args.onto.path);
  const bytes = fs.readFileSync(abs);
  return rebaseOnto(
    ctx,
    scope,
    sk,
    {
      describe: `file ${abs}`,
      base: { kind: "file", path: abs, at: new Date().toISOString() },
      load: async () => {
        const s = await scope.loadMap({ b64: bytes.toString("base64") });
        ctx.snapshots.setProvenance({
          kind: "file",
          path: abs,
          seed: (s.seed as string) ?? null,
          mapId: (s.mapId as number) ?? null
        });
      }
    },
    args.onConflict ?? "stop"
  );
}

/** rebase without `onto`: replay onto the CURRENT shared map (a read-only GET). Does not save. */
async function rebaseShared(ctx: ToolContext, scope: CallScope, sk: Sketch, onConflict: "stop" | "skip") {
  if (sk.base.kind !== "shared")
    throw new ToolError(
      "REFUSED",
      `sketch '${sk.slug}' is based on a map file (test hook), not the shared map; use rebase {onto:{path}}`
    );
  refuseBlobOnly(sk);
  const blob = await ctx.shared.getMap();
  if (blob.version === null) throw new ToolError("NETWORK", "the shared map answered without an X-Map-Version header");
  const version = blob.version;
  const res = await rebaseOnto(
    ctx,
    scope,
    sk,
    {
      describe: `the shared map v${version}`,
      base: {
        kind: "shared",
        id: "shared",
        version,
        updatedBy: blob.updatedBy,
        updatedAt: blob.updatedAt,
        at: new Date().toISOString()
      },
      load: async () => {
        const s = await scope.loadMap({ b64: blob.bytes.toString("base64") });
        ctx.snapshots.setProvenance({
          kind: "shared",
          seed: (s.seed as string) ?? null,
          mapId: (s.mapId as number) ?? null,
          sharedVersion: version,
          sharedUpdatedBy: blob.updatedBy,
          sharedUpdatedAt: blob.updatedAt,
          fetchedAt: new Date().toISOString()
        });
      }
    },
    onConflict
  );
  if (res.completed)
    res.next = `${res.next}. Nothing was saved: sketch {action:'save', confirm:true} updates the sketch on the Worker; sketch_promote (preview, then confirm with the token) puts it on the shared map.`;
  return res;
}

function requireLiveSketch(ctx: ToolContext, action: string): void {
  if (ctx.config.envMode !== "live" || ctx.mode.mode !== "live") {
    throw new ToolError(
      "MODE",
      `local mode: sketch ${action} writes the Worker (sketch-<slug>), which needs a server a human spawned with TUPAIA_MODE=live${ctx.mode.droppedFromLive ? " (this one dropped to local)" : ""}. list, open, rebase, summary and the local actions still work.`
    );
  }
}

/** The Worker's limit for ops.json (cloudflare/worker/src/index.ts MAX_OPS_BYTES). */
export const MAX_OPS_BYTES = 2 * 1024 * 1024;

/** REFUSED (before anything is written) when the ops.json for this header would exceed the limit. */
export function refuseOversizeOps(header: Record<string, unknown>, sk: Sketch): void {
  const bytes = Buffer.byteLength(JSON.stringify(header), "utf8");
  if (bytes <= MAX_OPS_BYTES) return;
  const biggest = sk.ops
    .map(o => ({
      seq: o.seq,
      tool: o.tool,
      bytes: Buffer.byteLength(JSON.stringify({ ...o, undoId: undefined }), "utf8")
    }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5)
    .map(o => `op ${o.seq} (${o.tool}) ${Math.round(o.bytes / 1024)} KB`);
  throw new ToolError(
    "REFUSED",
    `the sketch's ops.json would be ${(bytes / 1024 / 1024).toFixed(2)} MB, over the Worker's 2 MB limit; nothing was written. Largest ops: ${biggest.join(", ")}. Undo the largest ops (large paint_cells selections keep every cell id; eval keeps its args) or split the sketch.`,
    { details: { bytes, limit: MAX_OPS_BYTES } }
  );
}

/** save: PUT the page map to sketch-<slug> and its ops.json. Never touches `shared`. */
async function save(ctx: ToolContext, scope: CallScope, args: { confirm?: boolean }) {
  requireLiveSketch(ctx, "save");
  const sk = needSketch(ctx);
  if (sk.base.kind !== "shared" || typeof sk.base.version !== "number")
    throw new ToolError(
      "REFUSED",
      `sketch '${sk.slug}' is based on a map file (test hook); only sketches of the shared map can be saved`
    );
  if (sk.suspended)
    throw new ToolError(
      "REFUSED",
      `the page holds a stopped rebase, not the sketch (${sk.suspended.reason}). Undo it (snapshot {action:'undo', n:${sk.suspended.entries.length}}) or rebase with onConflict:'skip' first.`
    );
  const origin = ctx.shared.origin();
  const id = sketchId(sk.slug);
  const data = await scope.call<{ text: string; customization: number; fileName: string | null }>(
    "mapData",
    {},
    { noAlerts: true }
  );
  if (data.customization)
    throw new ToolError(
      "REFUSED",
      `an app editor is active (customization=${data.customization}); close it first (eval: closeDialogs(); customization = 0)`
    );
  const body = Buffer.from(data.text, "utf8");
  const blockers = [...sk.blockers];
  if (sk.diverged) blockers.push(`the page changed after the sketch stopped recording (${sk.diverged})`);
  const reasons = [...blobOnlyReasons(sk), ...(sk.diverged ? [blockers[blockers.length - 1]] : [])];
  const version = sk.saved?.version ?? null;
  const url = viewUrl(origin, sk.slug);
  const sends = [
    `PUT ${origin}/api/map/${id} (${body.length} bytes, ${version === null ? "no X-Map-Version: first save" : `X-Map-Version ${version}`})`,
    `PUT ${origin}/api/map/${id}/ops (ops.json: ${sk.ops.length} ops)`
  ];
  if (!args.confirm) {
    return {
      preview: true,
      id,
      sends,
      blobOnly: reasons.length > 0,
      ...(reasons.length ? { blobOnlyReasons: reasons } : {}),
      viewUrl: url,
      next: "Nothing was written. sketch {action:'save', confirm:true} writes the sketch (never the shared map)."
    };
  }
  if (!sk.summaryMarkdown || sk.summaryRev !== sk.rev) await summary(ctx, scope, { shots: false });
  const makeHeader = (blobVersion: number | null, updated: string) => ({
    schema: OPS_SCHEMA,
    slug: sk.slug,
    base: sk.base,
    note: sk.note,
    blobOnly: reasons.length > 0,
    blobOnlyReasons: reasons,
    blockers,
    author: "tupaia-mcp",
    created: sk.created,
    updated,
    summaryMarkdown: sk.summaryMarkdown,
    baseCounts: sk.baseCounts,
    blob: { id, version: blobVersion, bytes: body.length, sha256: sha256(body) },
    viewUrl: url,
    ops: sk.ops.map(({ undoId: _undoId, ...o }) => o)
  });
  // the Worker takes at most 2 MB of ops.json; check before the blob goes up, so a too-large log
  // never leaves a blob on the Worker without its log
  refuseOversizeOps(makeHeader(Number.MAX_SAFE_INTEGER, new Date().toISOString()), sk);
  let put: Awaited<ReturnType<typeof ctx.shared.putSketchBlob>>;
  try {
    put = await ctx.shared.putSketchBlob({
      mode: ctx.mode.mode,
      id,
      body,
      version,
      name: `Sketch ${sk.slug}${data.fileName ? ` (${data.fileName})` : ""}`
    });
  } catch (e) {
    if (e instanceof ToolError && e.code === "CONFLICT")
      e.message = `${id} already exists on the Worker at another version than this sketch knows (${version ?? "none: first save"}); someone (or another session) saved it. Open it (sketch {action:'open', slug:'${sk.slug}'}) or use another slug. ${e.message}`;
    throw e;
  }
  const now = new Date().toISOString();
  const header = makeHeader(put.version, now);
  let opsSaved: Record<string, unknown>;
  try {
    opsSaved = await ctx.shared.putSketchOps({ mode: ctx.mode.mode, id, json: header });
  } catch (e) {
    // the blob is up but its log is not: remember the blob version so a retry does not 409
    sk.saved = { rev: -1, version: put.version, at: now };
    throw e;
  }
  sk.saved = { rev: sk.rev, version: put.version, at: now };
  return {
    saved: { id, version: put.version, bytes: body.length, updated_by: put.updated_by, opsBytes: opsSaved.bytes },
    viewUrl: url,
    sketch: ctx.sketches.view(sk),
    next: "Give the human the viewUrl (it opens the sketch, not the shared map) and the summary markdown. Promote only after they say yes: sketch {action:'rebase'} if the shared map moved, then sketch_promote."
  };
}

function headerOf(ops: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!ops) return null;
  // summaries are rebuilt from the records (the file's own summary text is not trusted)
  const list = Array.isArray(ops.ops) ? (ops.ops as unknown[]).map((o, k) => sanitizeRecord(o, k)) : [];
  return {
    schema: ops.schema,
    slug: ops.slug,
    base: ops.base,
    note: ops.note,
    blobOnly: ops.blobOnly === true || list.some(o => !o.replayable),
    ...(Array.isArray(ops.blobOnlyReasons) && ops.blobOnlyReasons.length
      ? { blobOnlyReasons: ops.blobOnlyReasons }
      : {}),
    author: ops.author,
    created: ops.created,
    updated: ops.updated,
    blob: ops.blob,
    ops: list.length,
    log: list.slice(0, 50).map(o => `${o.seq}. ${o.summary}${o.unsafe ? " [unsafe]" : ""}`)
  };
}

/** list: the Worker's sketch-* maps with each one's ops.json header. Read-only. */
async function list(ctx: ToolContext) {
  const origin = ctx.shared.origin();
  const maps = await ctx.shared.listMaps();
  const sketches: Array<Record<string, unknown>> = [];
  for (const m of maps.filter(x => x.id.startsWith("sketch-"))) {
    const slug = m.id.slice("sketch-".length);
    let header: Record<string, unknown> | null = null;
    let headerError: string | undefined;
    try {
      header = headerOf(await ctx.shared.getOps(m.id));
    } catch (e) {
      headerError = (e as Error).message;
    }
    sketches.push({
      id: m.id,
      slug,
      version: m.version,
      name: m.name,
      updated_at: m.updated_at,
      updated_by: m.updated_by,
      viewUrl: viewUrl(origin, slug),
      header,
      ...(header ? {} : { note: headerError ?? "no ops.json: viewable, but it cannot be opened as a sketch" })
    });
  }
  return { origin, count: sketches.length, sketches, active: ctx.sketches.current?.slug ?? null };
}

/** open: load a saved sketch (blob + ops.json) into the page and make it the active sketch. */
async function open(ctx: ToolContext, scope: CallScope, args: { slug?: string }) {
  if (!args.slug) throw new ToolError("BAD_ARGS", "open needs slug (sketch {action:'list'} lists them)");
  const old = ctx.sketches.current;
  if (old?.recording)
    throw new ToolError(
      "REFUSED",
      `sketch '${old.slug}' is recording; stop it first (sketch {action:'stop'})${old.saved && old.saved.rev === old.rev ? "" : " and save it if it matters"}`
    );
  const origin = ctx.shared.origin();
  const id = sketchId(args.slug);
  const blob = await ctx.shared.getMap(id);
  const header = await ctx.shared.getOps(id);
  if (!header)
    throw new ToolError(
      "NOT_FOUND",
      `${id} has no ops.json, so it cannot be opened as a sketch (its link still shows it: ${viewUrl(origin, args.slug)})`
    );
  if (header.schema !== OPS_SCHEMA)
    throw new ToolError("REFUSED", `${id}: unknown ops.json schema ${String(header.schema)}`);
  const base = header.base as SketchBase | undefined;
  if (!base || base.kind !== "shared" || typeof base.version !== "number")
    throw new ToolError("REFUSED", `${id}: its ops.json has no shared base version`);
  if (!Array.isArray(header.ops)) throw new ToolError("REFUSED", `${id}: its ops.json has no ops list`);
  // ops.json is replaceable by any Worker caller: keep only what replay uses and recompute the rest
  const ops = (header.ops as unknown[]).map((o, k) => sanitizeRecord(o, k));
  const blockers = Array.isArray(header.blockers) ? [...(header.blockers as string[])] : [];
  const meta = header.blob as { version?: number; sha256?: string } | undefined;
  if (meta?.version !== blob.version)
    blockers.push(
      `the blob is v${blob.version ?? "?"} but its ops.json was saved with v${meta?.version ?? "?"}; the log may not describe the blob`
    );
  else if (meta?.sha256 && meta.sha256 !== sha256(blob.bytes))
    blockers.push("the blob does not match the checksum in its ops.json; the log may not describe the blob");

  await scope.pushUndo("sketch open", { slug: args.slug });
  const s = await scope.loadMap({ b64: blob.bytes.toString("base64") });
  ctx.snapshots.setProvenance({
    kind: "sketch",
    seed: (s.seed as string) ?? null,
    mapId: (s.mapId as number) ?? null,
    sharedVersion: base.version,
    sharedUpdatedBy: base.updatedBy ?? null,
    sharedUpdatedAt: base.updatedAt ?? null,
    sketchSlug: args.slug,
    sketchVersion: blob.version ?? undefined,
    fetchedAt: new Date().toISOString()
  });
  const sk = ctx.sketches.begin({
    slug: args.slug,
    note: typeof header.note === "string" ? header.note : null,
    base,
    baseText: "",
    baseCounts: (header.baseCounts as Record<string, number>) ?? {}
  });
  if (typeof header.created === "string") sk.created = header.created;
  sk.ops = ops;
  sk.blockers = blockers;
  // the stored summary markdown is not trusted either: summary/save rebuild it from the records
  sk.summaryMarkdown = null;
  sk.saved = { rev: sk.rev, version: blob.version, at: typeof header.updated === "string" ? header.updated : "" };
  if (old) scope.notes.push(`replaced the stopped sketch '${old.slug}' (${old.ops.length} ops)`);
  return {
    opened: true,
    id,
    blobVersion: blob.version,
    map: { name: s.name, seed: s.seed, counts: s.counts },
    origin: ctx.provenanceView(),
    viewUrl: viewUrl(origin, args.slug),
    ...ctx.sketches.view(sk),
    next: "The page holds the sketch and it records again. Before promoting: sketch_promote tells you whether it needs sketch {action:'rebase'} first."
  };
}

/** discard: DELETE sketch-<slug> on the Worker (blob, versions, ops.json). Never `shared`. */
async function discard(ctx: ToolContext, args: { slug?: string; confirm?: boolean }) {
  requireLiveSketch(ctx, "discard");
  const slug = args.slug ?? ctx.sketches.current?.slug;
  if (!slug) throw new ToolError("BAD_ARGS", "discard needs slug");
  const id = sketchId(slug);
  if (!args.confirm) {
    const meta = await ctx.shared.meta(id);
    if (!meta) throw new ToolError("NOT_FOUND", `${id} does not exist on the Worker`);
    return {
      preview: true,
      wouldDelete: { id, version: meta.version, updated_by: meta.updated_by, updated_at: meta.updated_at },
      sends: `DELETE ${ctx.shared.origin()}/api/map/${id}`,
      next: `Nothing was deleted. sketch {action:'discard', slug:'${slug}', confirm:true} deletes it (blob, versions and ops.json); it cannot be undone.`
    };
  }
  const deleted = await ctx.shared.deleteSketch({ mode: ctx.mode.mode, id });
  const sk = ctx.sketches.current;
  if (sk?.slug === slug) {
    sk.saved = null;
    return { deleted, note: `the active sketch '${slug}' stays in this session (not on the Worker any more)` };
  }
  return { deleted };
}

/** sketch_promote: the shared_save gate for the active sketch, once its base is the current version. */
async function promote(
  ctx: ToolContext,
  scope: CallScope,
  args: { confirm?: boolean; token?: string; then?: "keep" | "discard" }
): Promise<Record<string, unknown>> {
  requireLive(ctx);
  const sk = needSketch(ctx);
  if (sk.base.kind !== "shared" || typeof sk.base.version !== "number")
    throw new ToolError("REFUSED", `sketch '${sk.slug}' is based on a map file (test hook); it cannot be promoted`);
  if (sk.suspended)
    throw new ToolError(
      "REFUSED",
      `the page holds a stopped rebase, not the finished sketch (${sk.suspended.reason}); resolve it first`
    );
  const meta = await ctx.shared.meta();
  if (!meta) throw new ToolError("NOT_FOUND", "the shared map does not exist yet");
  const base = sk.base.version;
  if (meta.version !== base) {
    throw new ToolError(
      "REFUSED",
      `rebase first: sketch '${sk.slug}' is based on shared v${base}, but the shared map is now v${meta.version} (saved by ${meta.updated_by} at ${meta.updated_at}). sketch {action:'rebase'} replays the sketch onto v${meta.version} keeping their edits; check the result, then sketch_promote again.`,
      { details: { sketchBase: base, live: meta.version } }
    );
  }
  const then = args.then ?? "keep";
  const notes: string[] = [];
  if (sk.diverged) notes.push(`the page has changes the sketch log does not (${sk.diverged}); they are promoted too`);
  if (blobOnlyReasons(sk).length) notes.push("blob-only sketch: the page map is promoted as is");
  const res = await sharedSave(ctx, scope, {
    confirm: args.confirm,
    token: args.token,
    expectVersion: base,
    viaSketch: true
  });
  const sketchInfo = { slug: sk.slug, base, ops: sk.ops.length, then, ...(notes.length ? { notes } : {}) };
  if (!args.confirm) {
    if (typeof res.next === "string")
      res.next = res.next.replace(
        /shared_save \{confirm:true, token:'([^']+)'([^}]*)\}/,
        `sketch_promote {confirm:true, token:'$1'${then === "discard" ? ", then:'discard'" : ""}}`
      );
    return { ...res, sketch: sketchInfo };
  }
  const saved = res.saved as { version: number };
  const out: Record<string, unknown> = { promoted: { ...sketchInfo, to: saved.version }, ...res };
  if (then === "discard") {
    try {
      out.discarded = await ctx.shared.deleteSketch({ mode: ctx.mode.mode, id: sketchId(sk.slug) });
    } catch (e) {
      if (!(e instanceof ToolError && e.code === "NOT_FOUND")) {
        out.discardError = (e as Error).message;
      } else out.discarded = { id: sketchId(sk.slug), note: "it was never saved on the Worker; nothing to delete" };
    }
  }
  ctx.sketches.current = null;
  scope.notes.push(
    `sketch '${sk.slug}' is on the shared map as v${saved.version} and no longer active${then === "keep" ? "; its saved copy stays on the Worker (sketch {action:'discard'} removes it)" : ""}`
  );
  return out;
}

export const SketchInput = z.object({
  action: z.enum(SKETCH_ACTIONS),
  slug: z
    .string()
    .regex(SLUG_RE, "lowercase letters, digits and '-', at most 48")
    .optional()
    .describe("start: the sketch's name (default: a timestamp); open/discard: which saved sketch"),
  note: z.string().max(2000).optional().describe("start: what the sketch proposes, for humans"),
  onConflict: z
    .enum(["stop", "skip"])
    .optional()
    .describe("rebase: 'stop' (default) stops at the first conflict; 'skip' skips conflicting ops"),
  onto: z
    .object({ path: z.string().min(1) })
    .optional()
    .describe("rebase (test hook, TUPAIA_TEST_HOOKS=1): replay onto this map file instead of the shared map"),
  shots: z.boolean().optional().describe("summary: take before/after screenshots (default true)"),
  confirm: z
    .boolean()
    .optional()
    .describe("save/discard: true performs the write (live mode only); absent returns a preview"),
  full: z.boolean().optional().describe("status: include every op record with its resolved form (large)"),
  timeoutMs: TimeoutMs
});

export function register(ctx: ToolContext): void {
  ctx.tool(
    "sketch",
    {
      title: "Provisional sketches",
      description:
        "Propose a change to the shared map without changing it: a sketch is base version N of the shared map plus the ops log that produced it. start {slug?, note?}: needs a page map from load_map {source:'shared'} with no edits; then every mutating call is logged in its resolved form (ids, literal names and cells). regenerate (except parts:['relief']), generate_map, load_map and snapshot restore make it blob-only (not replayable) until undone; snapshot undo takes the last op out of the log. status: base, ops, blobOnly, lastSaved, dirty, viewUrl. summary: markdown for humans with before/after screenshots under TUPAIA_OUT/sketches/<slug>/. stop: end recording. rebase {onConflict?}: replay the log onto the CURRENT shared map (a GET), keeping other people's edits; a removed target or a field both sides changed is a conflict ('stop' default, or 'skip'); does not save. Network (Worker id sketch-<slug>, never the shared map): save {confirm:true} PUTs the page map and ops.json and returns viewUrl (opens the sketch in the app); list (read-only) shows saved sketches with their headers; open {slug} loads one into the page as the active sketch; discard {slug, confirm:true} deletes it. save and discard need a server spawned with TUPAIA_MODE=live; without confirm they preview. To put a sketch on the shared map use sketch_promote.",
      inputSchema: SketchInput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: META_TEXT_HEAVY,
      kind: "heavy"
    },
    async (args, scope) => {
      switch (args.action) {
        case "start":
          return start(ctx, scope, args);
        case "status": {
          const v = ctx.sketches.view();
          const sk = ctx.sketches.current;
          if (sk && ctx.config.liveOrigin) v.viewUrl = sk.saved ? viewUrl(ctx.config.liveOrigin, sk.slug) : null;
          // full: every record with its resolved form (big: paint records hold their cell lists)
          if (args.full && sk) v.records = sk.ops;
          return v;
        }
        case "summary":
          return summary(ctx, scope, args);
        case "stop": {
          const sk = needSketch(ctx);
          const was = sk.recording;
          sk.recording = false;
          return {
            stopped: true,
            wasRecording: was,
            ...ctx.sketches.view(sk),
            note: "recording ended; the page keeps the changes. Later changes are not logged."
          };
        }
        case "rebase":
          return rebase(ctx, scope, args);
        case "save":
          return save(ctx, scope, args);
        case "list":
          return list(ctx);
        case "open":
          return open(ctx, scope, args);
        case "discard":
          return discard(ctx, args);
        default:
          throw new ToolError("BAD_ARGS", "unknown action");
      }
    }
  );

  ctx.tool(
    "sketch_promote",
    {
      title: "Promote the sketch to the LIVE shared map",
      description:
        "OUTWARD WRITE: puts the active sketch on the live shared map (map.activationlayer.org). Only when the human said yes to this sketch in this conversation, and only in a server spawned with TUPAIA_MODE=live. Refused with 'rebase first' unless the sketch's base version equals the shared map's current version (run sketch {action:'rebase'}, check it, then promote). Otherwise it IS shared_save: without confirm it returns the preview (what it overwrites, lineage, build check) and a one-time token; tell the human, then call again with confirm:true and that token. The PUT carries X-Map-Version (never an overwrite header). On success the page map's origin is the shared map at the new version and the sketch is no longer active; then:'discard' also deletes sketch-<slug> on the Worker ('keep', default, leaves it).",
      inputSchema: z.object({
        confirm: z.boolean().optional().describe("true = perform the write (needs token); absent = preview"),
        token: z.string().optional().describe("The token from the preview"),
        // biome-ignore lint/suspicious/noThenProperty: the parameter is named 'then' by design (DECISIONS-2)
        then: z
          .enum(["keep", "discard"])
          .optional()
          .describe("After a confirmed promote: 'keep' (default) the saved sketch, or 'discard' it")
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      kind: "heavy"
    },
    async (args, scope) => promote(ctx, scope, args)
  );
}

defineTools("sketch", register);
