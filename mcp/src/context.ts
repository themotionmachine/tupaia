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
import {
  type Alert,
  type Envelope,
  errorResult,
  okResult,
  ToolError,
  type ToolOutput,
  unwrap,
  WithImages
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

  constructor(ctx: ToolContext, signal: AbortSignal | undefined, kind: ToolKind, timeoutMs?: number) {
    this.ctx = ctx;
    this.signal = signal;
    this.kind = kind;
    this.timeoutMs = timeoutMs ?? TIMEOUTS[kind];
    this.consoleSeq = ctx.browser.consoleSeq;
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
  async pushUndo(op: string, args: unknown): Promise<void> {
    const text = await this.mapText();
    const { entry, evicted } = this.ctx.snapshots.pushUndo(op, summarizeArgs(args), text);
    await this.call("setBaseline", { key: entry.baselineKey }, { noAlerts: true, timeoutMs: HOUSEKEEPING_MS });
    if (evicted.length)
      await this.call("dropBaseline", { keys: evicted }, { noAlerts: true, timeoutMs: HOUSEKEEPING_MS });
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
    // A fresh page holds a random boot map until something is restored or loaded.
    const env = await this.browser.callBridge<{ seed?: string }>("summary", {}, { timeoutMs: 15_000, noAlerts: true });
    this.snapshots.setProvenance({ kind: "boot", seed: env.ok ? (env.value?.seed ?? null) : null });
    // Live mode: the first launch loads the shared map, so its version is known before any write.
    if (this.mode.mode === "live" && !this.#sharedBootDone) {
      this.#sharedBootDone = true;
      try {
        const blob = await this.shared.getMap();
        const r = await this.browser.callBridge<{ seed?: string }>(
          "loadMap",
          { b64: blob.bytes.toString("base64"), keepView: false, timeoutMs: 110_000 },
          { timeoutMs: 120_000, mutating: true }
        );
        if (!r.ok) throw new Error(r.error?.message ?? "load failed");
        this.snapshots.setProvenance({
          kind: "shared",
          seed: r.value?.seed ?? null,
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
    const env = await this.browser.callBridge(
      "loadMap",
      { text: src.text, keepView: false, timeoutMs: 110_000 },
      { timeoutMs: 120_000, mutating: true }
    );
    if (!env.ok) return `Restoring ${src.label} failed: ${env.error?.message}`;
    this.snapshots.provenance = { ...src.provenance, restoredFrom: src.label };
    void reason;
    return `Restored ${src.label}.`;
  }

  /** Restore the newest snapshot now (session restart {restore:'latest'}). */
  restoreNewest(): Promise<string> {
    return this.#restoreNewest("restart");
  }

  /** Register a tool that runs through the shared runner. */
  tool<S extends z.ZodType>(
    name: string,
    spec: ToolSpec<S>,
    impl: (args: z.infer<S>, scope: CallScope) => Promise<WithImages | Record<string, unknown>>
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
      (async (args: any, sctx: ServerContext) => this.run(spec, sctx, args, impl)) as any
    );
  }

  async run<A>(
    spec: { kind?: ToolKind; launch?: boolean },
    sctx: ServerContext | undefined,
    args: A,
    impl: (args: A, scope: CallScope) => Promise<WithImages | Record<string, unknown>>
  ): Promise<CallToolResult> {
    return this.browser.exclusive(async () => {
      const kind = spec.kind ?? "read";
      const rawTimeout = (args as { timeoutMs?: unknown } | undefined)?.timeoutMs;
      const scope = new CallScope(
        this,
        sctx?.mcpReq?.signal,
        kind,
        typeof rawTimeout === "number" ? rawTimeout : undefined
      );
      try {
        if (spec.launch !== false) await this.browser.ensureHealthy(scope.notes);
        else if (this.browser.pendingNotes.length) scope.notes.push(...this.browser.pendingNotes.splice(0));
        const out = await impl(args, scope);
        await new Promise(r => setImmediate(r)); // let late console events land
        const normalized: ToolOutput =
          out instanceof WithImages ? { value: out.value, images: out.images } : { value: out };
        return okResult(normalized, this.#extras(scope));
      } catch (e) {
        await new Promise(r => setImmediate(r));
        return errorResult(e, this.#extras(scope));
      }
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
      "path",
      "sharedVersion",
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
