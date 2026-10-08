// sketch: provisional sketches of the shared map (local actions).
//
// A sketch is "base version N of the shared map plus the ops that produced it". start begins
// recording every mutating call into an ops log (src/ops.ts); summary describes it for humans
// with before/after screenshots; stop ends recording; rebase replays the log onto another map
// (src/replay.ts). This layer has the local actions; save/list/open/discard and the shared-map
// rebase use the Worker and live in the next layer.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CallScope, ToolContext } from "../context.ts";
import {
  type AddResolved,
  blobOnlyReasons,
  type EditResolved,
  type PaintResolved,
  type Sketch,
  type SketchBase
} from "../ops.ts";
import { resolveReadPath } from "../paths.ts";
import { replayOps } from "../replay.ts";
import { META_TEXT_HEAVY, ToolError } from "../result.ts";
import { type LAYER_NAMES, TimeoutMs } from "../schemas.ts";
import { defineTools } from "./registry.ts";
import { takeScreenshot } from "./view.ts";

type LayerNameT = (typeof LAYER_NAMES)[number];

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const SKETCH_ACTIONS = ["start", "status", "summary", "stop", "rebase"] as const;

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
export function changeRanking(sk: Sketch): Array<{ type: string; i: number | string; score: number }> {
  const score = new Map<string, { type: string; i: number | string; score: number }>();
  const bump = (type: string, i: unknown, n: number) => {
    if (typeof i !== "number" && typeof i !== "string") return;
    const k = `${type}:${i}`;
    const cur = score.get(k) ?? { type, i, score: 0 };
    cur.score += n;
    score.set(k, cur);
  };
  for (const o of sk.ops) {
    if (!o.resolved || !o.replayable) continue;
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
      for (const k of ["state", "province", "culture", "religion"]) if (k in p.set && p.set[k]) bump(k, p.set[k], n);
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
): Promise<{ type: string; i: number | string; name: string | null; bbox: [number, number, number, number] } | null> {
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
      bbox: [b.x0 - pad, b.y0 - pad, b.x1 + pad, b.y1 + pad]
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
  label: ["labels"]
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

async function summary(ctx: ToolContext, scope: CallScope, args: { shots?: boolean }) {
  const sk = needSketch(ctx);
  const now = await scope.call<{ counts: Record<string, number> }>("summary", {}, { noAlerts: true });
  const keys = [...new Set([...Object.keys(sk.baseCounts), ...Object.keys(now.counts)])];
  const counts = keys.map(k => ({ k, base: sk.baseCounts[k] ?? 0, now: now.counts[k] ?? 0 }));
  const target = await framedTarget(scope, sk);
  const shots: Record<string, string | null> = {};
  if (args.shots !== false) {
    const dir = path.join("sketches", sk.slug);
    const on = target ? (LAYERS_FOR[target.type] ?? []) : [];
    shots.afterFull = await shoot(ctx, scope, path.join(dir, "after-full.png"), { full: true }, on);
    if (target)
      shots.afterFramed = await shoot(ctx, scope, path.join(dir, "after-framed.png"), { bbox: target.bbox }, on);
    // the base: load it without an undo entry, shoot, and load the sketch back
    await ctx.verifyProvenance();
    const prov = { ...ctx.snapshots.provenance };
    const current = await scope.mapText();
    try {
      await scope.loadMap({ text: sk.baseText });
      shots.beforeFull = await shoot(ctx, scope, path.join(dir, "before-full.png"), { full: true }, on);
      if (target)
        shots.beforeFramed = await shoot(ctx, scope, path.join(dir, "before-framed.png"), { bbox: target.bbox }, on);
    } finally {
      let back: Record<string, unknown>;
      try {
        back = await scope.loadMap({ text: current });
      } catch {
        back = await scope.loadMap({ text: current });
      }
      ctx.snapshots.provenance = { ...prov, mapId: typeof back.mapId === "number" ? back.mapId : null };
    }
  }
  const reasons = blobOnlyReasons(sk);
  const lines: string[] = [];
  lines.push(`# Sketch ${sk.slug}`, "");
  if (sk.note) lines.push(sk.note, "");
  lines.push(`- Base: ${baseLine(sk.base)}`);
  lines.push(`- Operations: ${sk.ops.length}${sk.recording ? " (recording)" : " (stopped)"}`);
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
    if (target)
      lines.push(
        `Framed on the most-changed entity: ${target.type} ${target.name ? `'${target.name}' ` : ""}(${target.i}).`,
        ""
      );
    for (const [k, f] of shotFiles) lines.push(`- ${k}: ${f}`);
  }
  const markdown = `${lines.join("\n")}\n`;
  sk.summaryMarkdown = markdown;
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
  const entries: number[] = [];
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
  if (!args.onto)
    throw new ToolError(
      "REFUSED",
      "rebase onto the shared map is not available in this build; rebase {onto:{path}} (a local map file) is a test hook"
    );
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

export const SketchInput = z.object({
  action: z.enum(SKETCH_ACTIONS),
  slug: z
    .string()
    .regex(SLUG_RE, "lowercase letters, digits and '-', at most 48")
    .optional()
    .describe("start: the sketch's name (default: a timestamp)"),
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
  full: z.boolean().optional().describe("status: include every op record with its resolved form (large)"),
  timeoutMs: TimeoutMs
});

export function register(ctx: ToolContext): void {
  ctx.tool(
    "sketch",
    {
      title: "Provisional sketches",
      description:
        "Propose a change to the shared map without changing it: a sketch is base version N of the shared map plus the ops log that produced it. start {slug?, note?} needs a page map loaded with load_map {source:'shared'} and no edits yet; then every mutating call (edit, add, paint_cells, display, eval, ...) is logged with its concrete resolved form (ids, literal generated names, literal cell lists). regenerate, generate_map, load_map and snapshot restore make the sketch blob-only (not replayable) until undone. snapshot undo takes the last op out of the log; redo puts it back. status: base, ops, blobOnly and why. summary: markdown for humans (each op in one sentence, counts vs base) with before/after screenshots (full map and framed on the most-changed entity) saved under TUPAIA_OUT/sketches/<slug>/. stop: end recording, keep the page. rebase: replay the log onto a newer map, keeping other people's edits; conflicts (a removed target, a field both sides changed) stop it (onConflict 'stop', default) or are skipped ('skip').",
      inputSchema: SketchInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: META_TEXT_HEAVY,
      kind: "heavy"
    },
    async (args, scope) => {
      switch (args.action) {
        case "start":
          return start(ctx, scope, args);
        case "status": {
          const v = ctx.sketches.view();
          // full: every record with its resolved form (big: paint records hold their cell lists)
          if (args.full && ctx.sketches.current) v.records = ctx.sketches.current.ops;
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
        default:
          throw new ToolError("BAD_ARGS", "unknown action");
      }
    }
  );
}

defineTools("sketch", register);
