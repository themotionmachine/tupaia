// The shared tool context: config, mode, browser, snapshots, shots, and the tool runner that
// every tool goes through (mutex, health check, per-call console errors, result formatting).
//
// Adding a tool (next builders): create src/tools/<name>.ts exporting
//   export function register(ctx: ToolContext): void { ctx.tool("name", {...}, impl) }
// and add one `import "./tools/<name>.ts"`-style line to the TOOL_MODULES list in server.ts.
import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { BrowserManager, type CallOptions } from "./browser.ts";
import { type Config, ModeState } from "./config.ts";
import { NOT_REPLAYABLE, type OpRecord, type Resolved, SketchStore, summarizeOp } from "./ops.ts";
import {
  type Alert,
  type Envelope,
  errorResult,
  okResult,
  ToolError,
  type ToolOutput,
  unwrap,
  WithImages,
  WithText
} from "./result.ts";
import { TIMEOUTS } from "./schemas.ts";
import { SharedApi } from "./shared-api.ts";
import { type Provenance, SnapshotStore, summarizeArgs } from "./snapshots.ts";

export type ToolKind = keyof typeof TIMEOUTS;

/** Timeout for snapshot/baseline housekeeping calls, independent of a tool's own timeoutMs. */
const HOUSEKEEPING_MS = 60_000;

export interface ToolSpec<S extends z.ZodType> {
  title?: string;
  description: string;
  inputSchema: S;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  _meta?: Record<string, unknown>;
  /** Timeout class (default 'read'). */
  kind?: ToolKind;
  /** Launch/heal the browser before the handler runs (default true). */
  launch?: boolean;
}

/** A stored screenshot: what inspect {at:{screen, shot}} and screenshot {view, compare} reuse. */
export interface ShotRecord {
  id: string;
  at: string;
  file: string;
  full: boolean;
  /** View transform at capture time (map px -> css px). */
  view: { x: number; y: number; scale: number };
  graphWidth: number;
  graphHeight: number;
  /** Size of the saved PNG. */
  pngW: number;
  pngH: number;
  /** CSS size of the captured area (svg viewport, or graph for full). */
  cssW: number;
  cssH: number;
  /** Size of the image returned to the client. */
  imgW: number;
  imgH: number;
  layersOn: string[];
}

export class ShotStore {
  #shots: ShotRecord[] = [];
  #seq = 0;
  nextId(): string {
    return `s${++this.#seq}`;
  }
  add(rec: ShotRecord): void {
    this.#shots.push(rec);
    if (this.#shots.length > 100) this.#shots.shift();
  }
  get(ref: string): ShotRecord {
    const rec = ref === "last" ? this.#shots[this.#shots.length - 1] : this.#shots.find(s => s.id === ref);
    if (!rec) {
      throw new ToolError("NOT_FOUND", ref === "last" ? "no screenshot taken yet" : `no screenshot '${ref}'`, {
        candidates: this.#shots.slice(-8).map(s => ({ i: s.id, name: s.file }))
      });
    }
    return rec;
  }
  get count(): number {
    return this.#shots.length;
  }
}

/** Per-call helper handed to tool implementations. */
export class CallScope {
  readonly ctx: ToolContext;
  readonly signal: AbortSignal | undefined;
  readonly kind: ToolKind;
  readonly timeoutMs: number;
  readonly notes: string[] = [];
  readonly alerts: Alert[] = [];
  readonly consoleSeq: number;
  readonly started = Date.now();
  /** Name of the tool this call runs (sketch bookkeeping). */
  readonly tool: string;
  /** Ids of the auto-undo entries this call pushed. */
  readonly undoPushed: number[] = [];
  /** Page digest before the first undo push (only while a sketch records). */
  digestBefore: string | null | undefined;
  /** The call logged its own op (record()); the runner's fallback then stays out. */
  opRecorded = false;

  constructor(ctx: ToolContext, signal: AbortSignal | undefined, kind: ToolKind, timeoutMs?: number, tool = "") {
    this.ctx = ctx;
    this.signal = signal;
    this.kind = kind;
    this.timeoutMs = timeoutMs ?? TIMEOUTS[kind];
    this.consoleSeq = ctx.browser.consoleSeq;
    this.tool = tool;
  }

  /** The sketch tool manages the log itself; every other mutating call is logged while recording. */
  get logsToSketch(): boolean {
    return this.ctx.sketches.recording && this.tool !== "sketch";
  }

  /** Bridge digest hash of the page map, or null. */
  async digest(): Promise<string | null> {
    try {
      const d = await this.call<{ hash: string }>("digest", {}, { noAlerts: true, timeoutMs: HOUSEKEEPING_MS });
      return d.hash;
    } catch {
      return null;
    }
  }

  /**
   * Log this call in the active sketch (no-op unless a sketch records). `out` is the bridge
   * result the summary is built from.
   */
  async record(
    tool: string,
    args: unknown,
    resolved: Resolved | null,
    opts: {
      out?: Record<string, unknown> | null;
      replayable?: boolean;
      reason?: string;
      unsafe?: boolean;
      noop?: boolean;
      summary?: string;
      skipDigest?: boolean;
    } = {}
  ): Promise<OpRecord | null> {
    if (!this.logsToSketch) return null;
    const replayable = opts.replayable ?? resolved !== null;
    const digestAfter = opts.skipDigest ? null : await this.digest();
    let summary = opts.summary ?? summarizeOp(tool, resolved, opts.out ?? null, args);
    if (!replayable && opts.reason) summary = `${summary} (not replayable: ${opts.reason})`;
    const rec = this.ctx.sketches.append({
      tool,
      args,
      resolved,
      summary,
      at: new Date().toISOString(),
      digestBefore: this.digestBefore ?? null,
      digestAfter,
      replayable,
      ...(opts.reason && !replayable ? { reason: opts.reason } : {}),
      ...(opts.unsafe ? { unsafe: true } : {}),
      ...(opts.noop ? { noop: true } : {}),
      undoId: this.undoPushed[this.undoPushed.length - 1]
    });
    this.opRecorded = true;
    return rec;
  }

  /** Remaining budget for this call, at least 1 s. */
  get remainingMs(): number {
    return Math.max(1000, this.timeoutMs - (Date.now() - this.started));
  }

  /** Raw envelope call (no throw on !ok). */
  async envelope<T>(name: string, args: unknown, opts: Partial<CallOptions> = {}): Promise<Envelope<T>> {
    const env = await this.ctx.browser.callBridge<T>(name, args, {
      timeoutMs: opts.timeoutMs ?? this.remainingMs,
      signal: this.signal,
      mutating: opts.mutating,
      json: opts.json,
      noAlerts: opts.noAlerts
    });
    if (env.alerts?.length) this.alerts.push(...env.alerts);
    return env;
  }

  /** Bridge call that throws ToolError on failure. */
  async call<T>(name: string, args: unknown = {}, opts: Partial<CallOptions> = {}): Promise<T> {
    return unwrap(await this.envelope<T>(name, args, opts));
  }

  /** Current .map text (prepareMapData). */
  async mapText(): Promise<string> {
    const v = await this.call<{ text: string }>("mapData", {}, { noAlerts: true, timeoutMs: HOUSEKEEPING_MS });
    return v.text;
  }

  /** Take an auto-undo entry for a mutating op. Call before mutating the page. */
  async pushUndo(op: string, args: unknown): Promise<number> {
    await this.ctx.verifyProvenance();
    if (this.logsToSketch && this.digestBefore === undefined) this.digestBefore = await this.digest();
    const text = await this.mapText();
    const { entry, evicted } = this.ctx.snapshots.pushUndo(op, summarizeArgs(args), text);
    this.undoPushed.push(entry.id);
    this.ctx.sketches.onUndoPushed();
    await this.call("setBaseline", { key: entry.baselineKey }, { noAlerts: true, timeoutMs: HOUSEKEEPING_MS });
    if (evicted.length)
      await this.call("dropBaseline", { keys: evicted }, { noAlerts: true, timeoutMs: HOUSEKEEPING_MS });
    return entry.id;
  }

  /**
   * Run a mutation: auto-undo entry first, then fn, then provenance.opsSince++.
   * Use `undoable:false` only for ops that cannot change the map.
   */
  async mutate<T>(op: string, args: unknown, fn: () => Promise<T>, undoable = true): Promise<T> {
    if (undoable) await this.pushUndo(op, args);
    const out = await fn();
    this.ctx.snapshots.noteMutation();
    return out;
  }

  /** Load .map text (or base64 bytes) into the page; returns the bridge summary. */
  async loadMap(src: { text?: string; b64?: string }, keepView = false): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>(
      "loadMap",
      { ...src, keepView, timeoutMs: Math.max(5000, this.remainingMs - 1000) },
      { mutating: true }
    );
  }
}

export class ToolContext {
  readonly config: Config;
  readonly mode: ModeState;
  readonly browser: BrowserManager;
  readonly snapshots: SnapshotStore;
  readonly shots = new ShotStore();
  readonly shared: SharedApi;
  /** The provisional sketch (ops log) being recorded, if any. */
  readonly sketches = new SketchStore();
  server!: McpServer;
  readonly toolNames: string[] = [];

  constructor(config: Config) {
    this.config = config;
    this.mode = new ModeState(config.envMode);
    this.browser = new BrowserManager(config, this.mode);
    this.snapshots = new SnapshotStore(config.snapshotsMax, config.undoDepth);
    this.shared = new SharedApi(config, this.browser);
    this.browser.setRestorer(reason => this.#restoreNewest(reason));
    this.browser.onLaunch(() => this.#afterLaunch());
  }

  #sharedBootDone = false;

  async #afterLaunch(): Promise<void> {
    // A fresh page holds a random boot map until something is restored or loaded. Set that
    // before anything that can throw, so a failed hook never leaves an older 'shared' provenance.
    this.snapshots.setProvenance({ kind: "boot", seed: null, mapId: null });
    const env = await this.browser
      .callBridge<{ seed?: string; mapId?: number }>("summary", {}, { timeoutMs: 15_000, noAlerts: true })
      .catch(() => null);
    if (env?.ok)
      this.snapshots.setProvenance({ kind: "boot", seed: env.value?.seed ?? null, mapId: env.value?.mapId ?? null });
    // Live mode: the first launch loads the shared map, so its version is known before any write.
    if (this.mode.mode === "live" && !this.#sharedBootDone) {
      this.#sharedBootDone = true;
      try {
        const blob = await this.shared.getMap();
        const r = await this.browser.callBridge<{ seed?: string; mapId?: number }>(
          "loadMap",
          { b64: blob.bytes.toString("base64"), keepView: false, timeoutMs: 110_000 },
          { timeoutMs: 120_000, mutating: true }
        );
        if (!r.ok) throw new Error(r.error?.message ?? "load failed");
        this.snapshots.setProvenance({
          kind: "shared",
          seed: r.value?.seed ?? null,
          mapId: r.value?.mapId ?? null,
          sharedVersion: blob.version ?? undefined,
          sharedUpdatedBy: blob.updatedBy,
          sharedUpdatedAt: blob.updatedAt,
          fetchedAt: new Date().toISOString()
        });
        this.browser.pendingNotes.push(`live mode: loaded the shared map v${blob.version ?? "?"} into the page`);
      } catch (e) {
        this.browser.pendingNotes.push(
          `live mode: loading the shared map on launch failed (${(e as Error).message}); the page holds a random map`
        );
      }
    }
  }

  async #restoreNewest(reason: string): Promise<string> {
    const src = this.snapshots.newestRestorable();
    if (!src) return "No snapshot to restore; the page holds a fresh random map.";
    const env = await this.browser.callBridge<{ mapId?: number }>(
      "loadMap",
      { text: src.text, keepView: false, timeoutMs: 110_000 },
      { timeoutMs: 120_000, mutating: true }
    );
    if (!env.ok) return `Restoring ${src.label} failed: ${env.error?.message}`;
    // the app stamps a new map id on every load, so lineage is re-bound to the loaded map
    this.snapshots.provenance = { ...src.provenance, restoredFrom: src.label, mapId: env.value?.mapId ?? null };
    const topUndo = this.snapshots.undoStack[this.snapshots.undoStack.length - 1]?.id;
    this.snapshots.afterRestore(src.kind);
    this.sketches.onCrashRestore(src.kind, src.kind === "undo" ? topUndo : undefined, src.label);
    void reason;
    const lost = src.lostOps.length
      ? ` The map in the page before the relaunch could not be kept; the effects of these calls were LOST and need redoing: ${src.lostOps.join("; ")}.`
      : "";
    return `Restored ${src.label}.${lost}`;
  }

  /**
   * window.mapId of the map in the page, or null when the browser is not running or the call
   * fails. Never launches the browser.
   */
  async pageMapId(timeoutMs = 10_000): Promise<number | null> {
    if (!this.browser.healthy) return null;
    try {
      const env = await this.browser.callBridge<number | null>("mapId", {}, { timeoutMs, noAlerts: true });
      return env.ok ? (env.value ?? null) : null;
    } catch {
      return null;
    }
  }

  /**
   * A 'shared' provenance whose recorded map id no longer matches the page is downgraded to
   * 'unknown' before it gets copied into an undo entry or snapshot (which a later restore would
   * otherwise re-bind to the page, laundering the lineage).
   */
  async verifyProvenance(): Promise<void> {
    const p = this.snapshots.provenance;
    if (p.kind !== "shared" && p.kind !== "sketch") return;
    const id = await this.pageMapId();
    if (id === null || p.mapId === undefined || p.mapId === null || id !== p.mapId)
      this.snapshots.setProvenance({ kind: "unknown", mapId: id, opsSince: p.opsSince });
  }

  /**
   * session restart: relaunch the browser. With restore 'latest', the map in the page is read
   * first (while the page still answers) and loaded back after the relaunch; only an
   * unresponsive page falls back to the newest snapshot/undo point.
   */
  async restart(restore: "latest" | "none"): Promise<string> {
    let text: string | null = null;
    const prov = { ...this.snapshots.provenance };
    const idBefore = await this.pageMapId();
    // a fresh boot map nobody touched (e.g. right after a crash relaunch) is not worth keeping
    // over the newest snapshot; anything else in the page is the user's current work
    const freshBoot = prov.kind === "boot" && prov.opsSince === 0 && !!this.snapshots.newestRestorable();
    if (restore === "latest" && this.browser.healthy && !freshBoot) {
      try {
        const env = await this.browser.callBridge<{ text: string }>(
          "mapData",
          {},
          { timeoutMs: 30_000, noAlerts: true }
        );
        if (env.ok && env.value?.text) text = env.value.text;
      } catch {
        text = null;
      }
    }
    await this.browser.relaunch("session restart");
    if (restore === "none") return "not restored (restore:'none'); the page holds a fresh random map";
    if (text) {
      const env = await this.browser.callBridge<{ mapId?: number }>(
        "loadMap",
        { text, keepView: false, timeoutMs: 110_000 },
        { timeoutMs: 120_000, mutating: true }
      );
      if (env.ok) {
        // keep the lineage only if it held before the restart (the reload stamps a new map id)
        const held = prov.mapId !== undefined && prov.mapId !== null && prov.mapId === idBefore;
        this.snapshots.provenance = held
          ? { ...prov, mapId: env.value?.mapId ?? null }
          : {
              ...prov,
              kind: prov.kind === "shared" || prov.kind === "sketch" ? "unknown" : prov.kind,
              mapId: env.value?.mapId ?? null
            };
        return "Reloaded the map that was in the page before the restart (nothing lost).";
      }
    }
    return this.#restoreNewest("restart");
  }

  /** Register a tool that runs through the shared runner. */
  tool<S extends z.ZodType>(
    name: string,
    spec: ToolSpec<S>,
    impl: (args: z.infer<S>, scope: CallScope) => Promise<WithImages | WithText | Record<string, unknown>>
  ): void {
    this.toolNames.push(name);
    this.server.registerTool(
      name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations: spec.annotations,
        _meta: spec._meta
      },
      (async (args: any, sctx: ServerContext) => this.run({ ...spec, name }, sctx, args, impl)) as any
    );
  }

  async run<A>(
    spec: { kind?: ToolKind; launch?: boolean; name?: string },
    sctx: ServerContext | undefined,
    args: A,
    impl: (args: A, scope: CallScope) => Promise<WithImages | WithText | Record<string, unknown>>
  ): Promise<CallToolResult> {
    return this.browser.exclusive(async () => {
      const kind = spec.kind ?? "read";
      const rawTimeout = (args as { timeoutMs?: unknown } | undefined)?.timeoutMs;
      const scope = new CallScope(
        this,
        sctx?.mcpReq?.signal,
        kind,
        typeof rawTimeout === "number" ? rawTimeout : undefined,
        spec.name ?? ""
      );
      try {
        if (spec.launch !== false) await this.browser.ensureHealthy(scope.notes);
        else if (this.browser.pendingNotes.length) scope.notes.push(...this.browser.pendingNotes.splice(0));
        const out = await impl(args, scope);
        await this.#sketchFallback(scope, args, null);
        await new Promise(r => setImmediate(r)); // let late console events land
        const normalized: ToolOutput =
          out instanceof WithImages
            ? { value: out.value, images: out.images }
            : out instanceof WithText
              ? { value: {}, text: out.text }
              : { value: out };
        return okResult(normalized, this.#extras(scope));
      } catch (e) {
        await this.#sketchFallback(scope, args, e).catch(() => {});
        await new Promise(r => setImmediate(r));
        return errorResult(e, this.#extras(scope));
      }
    });
  }

  /**
   * A call that pushed an auto-undo entry but did not log itself (regenerate, generate_map,
   * load_map, snapshot restore, or a call that failed after changing the map) is logged as a
   * non-replayable op, so the sketch knows it and undo can take it out again. A failed call
   * that left the page unchanged is logged as a no-op instead.
   */
  async #sketchFallback(scope: CallScope, args: unknown, error: unknown): Promise<void> {
    if (scope.tool === "sketch" || !scope.undoPushed.length || scope.opRecorded) return;
    if (!this.sketches.current) return;
    if (!this.sketches.recording) {
      this.sketches.noteUnlogged(scope.tool);
      return;
    }
    if (this.browser.dirty) {
      await scope.record(scope.tool, args, null, {
        replayable: false,
        reason: `${scope.tool} timed out or was aborted while changing the map`,
        skipDigest: true
      });
      return;
    }
    if (error) {
      const after = await scope.digest();
      if (after !== null && after === scope.digestBefore) {
        await scope.record(scope.tool, args, null, {
          replayable: true,
          noop: true,
          summary: `${scope.tool} failed without changing the map (no-op).`
        });
        return;
      }
      const code = (error as { code?: string }).code ?? "error";
      await scope.record(scope.tool, args, null, {
        replayable: false,
        reason: `${scope.tool} failed part-way (${code}) after changing the map; undo it`
      });
      return;
    }
    await scope.record(scope.tool, args, null, {
      replayable: false,
      reason: NOT_REPLAYABLE[scope.tool] ?? `${scope.tool} is not replayable`
    });
  }

  #extras(scope: CallScope) {
    return {
      alerts: scope.alerts,
      consoleErrors: this.browser.consoleSince(scope.consoleSeq),
      notes: scope.notes
    };
  }

  provenanceView(p: Provenance = this.snapshots.provenance): Record<string, unknown> {
    const out: Record<string, unknown> = { kind: p.kind };
    for (const k of [
      "seed",
      "mapId",
      "path",
      "sharedVersion",
      "sketchSlug",
      "sketchVersion",
      "sharedUpdatedBy",
      "sharedUpdatedAt",
      "fetchedAt",
      "restoredFrom"
    ] as const) {
      if (p[k] !== undefined && p[k] !== null) out[k] = p[k];
    }
    return out;
  }
}
