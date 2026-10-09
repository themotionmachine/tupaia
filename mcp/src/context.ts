// The shared tool context: config, mode, browser, snapshots, shots, and the tool runner that
// every tool goes through (mutex, health check, per-call console errors, result formatting).
//
// Adding a tool (next builders): create src/tools/<name>.ts that calls
//   defineTools("<name>", ctx => ctx.tool("name", {...}, impl))
// server.ts imports every tools/*.ts. ctx.tool() only records the definition; attach(server)
// registers the definitions on an McpServer (once for stdio, once per request under --http) and
// callTool() runs one by name without MCP (the --http JSON API). Both go through the same runner.
import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { BrowserManager, type CallOptions, READ_STALL_PROBE_MS } from "./browser.ts";
import { type Config, ModeState } from "./config.ts";
import { NOT_REPLAYABLE, type OpRecord, type Resolved, SketchStore, summarizeOp } from "./ops.ts";
import {
  type Alert,
  type Envelope,
  errorResult,
  okResult,
  summarizeConsole,
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
  /**
   * Set when the returned image is the changed-region crop of the PNG (screenshot crop:'changed'):
   * the crop's box in PNG px, and for sideBySide the width of one half and where the right
   * ("after") half starts, both in returned-image px. imgW/imgH are then the crop image's size.
   */
  crop?: { box: [number, number, number, number]; half?: { width: number; right: number } };
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
  /** When the call's budget started (reset after the launch/relaunch step, which has its own). */
  started = Date.now();
  /** ToolContext.callSeq of this call, and of the newest earlier call not annotated read-only. */
  seq = 0;
  prevMutableSeq = 0;
  #cleanupDepth = 0;
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

  /** Inside cleanup(): restores and undo-of-setup steps. */
  get inCleanup(): boolean {
    return this.#cleanupDepth > 0;
  }

  /** Default budget of a bridge call: the remaining budget, or at least HOUSEKEEPING_MS in cleanup(). */
  get budgetMs(): number {
    return this.inCleanup ? Math.max(this.remainingMs, HOUSEKEEPING_MS) : this.remainingMs;
  }

  /**
   * Run restores and other put-it-back steps (a finally block): bridge calls inside never carry
   * the caller's cancellation signal and get at least HOUSEKEEPING_MS, so a cancelled or
   * out-of-budget call still leaves the page as it found it.
   */
  async cleanup<T>(fn: () => Promise<T>): Promise<T> {
    this.#cleanupDepth++;
    try {
      return await fn();
    } finally {
      this.#cleanupDepth--;
    }
  }

  /** Raw envelope call (no throw on !ok). */
  async envelope<T>(name: string, args: unknown, opts: Partial<CallOptions> = {}): Promise<Envelope<T>> {
    const b = this.ctx.browser;
    if (this.inCleanup && b.dirty) {
      // a put-it-back step on a page a stall marked: skip it at once unless the page answers
      // again (a hung page would hold every cleanup call for its whole budget)
      if (!b.dirtyReadOnly || !(await b.probe(2000)))
        throw new ToolError("BROWSER", `${name} skipped: the page is marked for a relaunch (${b.dirty})`);
      b.dirty = null;
      b.dirtyReadOnly = false;
    }
    const env = await b.callBridge<T>(name, args, {
      timeoutMs: opts.timeoutMs ?? this.budgetMs,
      signal: this.inCleanup ? undefined : this.signal,
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
    // a stopped rebase holds the page: a change now would land on the partial replay, make the
    // sketch blob-only and shift the undo count the rebase gave (several agents share a daemon).
    // A stopped sketch (sketch {action:'stop'}) logs nothing, so it no longer holds calls back.
    const sk = this.ctx.sketches.current;
    if (sk?.suspended && sk.recording && this.tool !== "sketch" && this.tool !== "snapshot")
      throw new ToolError(
        "SKETCH",
        `${this.tool || op} refused: the page holds a stopped rebase of sketch '${sk.slug}' (${sk.suspended.reason}), not the sketch. Nothing was changed. Undo the rebase (snapshot {action:'undo', n:${sk.suspended.entries.length}}) to return to the sketch, finish it (sketch {action:'rebase', onConflict:'skip'}), or end recording (sketch {action:'stop'}).`
      );
    await this.ctx.verifyProvenance();
    if (this.logsToSketch && this.digestBefore === undefined) this.digestBefore = await this.digest();
    const text = this.#reusablePoint() ?? (await this.mapText());
    const { entry, evicted } = this.ctx.snapshots.pushUndo(op, summarizeArgs(args), text);
    this.undoPushed.push(entry.id);
    this.ctx.sketches.onUndoPushed();
    await this.call("setBaseline", { key: entry.baselineKey }, { noAlerts: true, timeoutMs: HOUSEKEEPING_MS });
    if (evicted.length)
      await this.call("dropBaseline", { keys: evicted }, { noAlerts: true, timeoutMs: HOUSEKEEPING_MS });
    return entry.id;
  }

  /**
   * The restore point's text when it still is the page map: captured at the end of an earlier
   * call, with only read-only tools since, no mutating bridge call or relaunch, and nothing newer
   * in the history. Saves the second map serialisation of back-to-back mutating calls.
   */
  #reusablePoint(): string | null {
    const snaps = this.ctx.snapshots;
    const rp = snaps.restorePoint;
    const b = this.ctx.browser;
    if (!rp || this.undoPushed.length || !snaps.restorePointIsNewest) return null;
    if (rp.callSeq < this.prevMutableSeq || rp.writes !== b.writes || rp.launches !== b.launches) return null;
    if (rp.provenance.epoch !== snaps.provenance.epoch) return null;
    return rp.text;
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
    const budget = Math.max(this.inCleanup ? 110_000 : 6000, this.budgetMs);
    return this.call<Record<string, unknown>>(
      "loadMap",
      { ...src, keepView, timeoutMs: budget - 1000 },
      { mutating: true, timeoutMs: budget }
    );
  }

  /**
   * Put `text` (with `prov`) back into the page after a step that replaced the map failed or was
   * cancelled. Runs in cleanup() (no cancellation, its own budget). When the page cannot be
   * trusted (a stalled call marked it) or the load fails twice, the text becomes the restore
   * point and the page is marked for a relaunch, which loads it before the next call.
   */
  async putBack(
    text: string,
    prov: Provenance,
    label: string
  ): Promise<{ reloaded: boolean; note: string; summary?: Record<string, unknown> }> {
    return this.cleanup(async () => {
      const b = this.ctx.browser;
      if (b.dirty && b.dirtyReadOnly && (await b.probe(READ_STALL_PROBE_MS))) {
        b.dirty = null;
        b.dirtyReadOnly = false;
      }
      let why = b.dirty ?? "";
      for (let attempt = 0; attempt < 2 && !b.dirty; attempt++) {
        try {
          const summary = await this.loadMap({ text });
          this.ctx.snapshots.provenance = {
            ...prov,
            mapId: typeof summary.mapId === "number" ? summary.mapId : null
          };
          return { reloaded: true, note: `${label} was loaded back into the page`, summary };
        } catch (e) {
          why = (e as Error).message;
        }
      }
      // the next call relaunches the page and loads the text back
      this.ctx.snapshots.setRestorePoint(text, label, this.ctx.restoreMarks(this), prov);
      b.markDirty(`putting ${label} back failed: ${why}`);
      return {
        reloaded: false,
        note: `${label} could not be loaded back now (${why}); the page is relaunched before the next call and ${label} restored then`
      };
    });
  }
}

type Issue = { path: PropertyKey[]; message: string; code?: string; errors?: Issue[][] };

/** What one union branch wanted: "needs <key>" when the key is missing, else its first issue. */
function branchSummary(b: readonly Issue[]): string {
  const i = b[0];
  if (!i) return "?";
  const p = i.path.map(String).join(".");
  const missing = (x: Issue): boolean =>
    /received undefined/.test(x.message) ||
    (x.code === "invalid_union" && !!x.errors?.length && x.errors.every(b => !!b[0] && missing(b[0])));
  if (p && missing(i)) return `needs ${p}`;
  if (i.code === "invalid_union") return `${p || "value"}: matches none of ${i.errors?.length ?? 0} shapes`;
  return `${p || "value"}: ${i.message.replace(/^Invalid input: /, "")}`;
}

/** zod issues as one line; a failed union lists what each accepted shape wanted. */
export function describeIssues(issues: readonly Issue[], prefix: PropertyKey[] = []): string {
  const at = (i: Issue) => {
    const p = [...prefix, ...i.path].map(String).join(".");
    return p || "(args)";
  };
  const msg = (i: Issue) => i.message.replace(/^Invalid input: /, "");
  return issues
    .slice(0, 8)
    .map(i => {
      // a union with its own error message (z.union([...], {error})) says it best
      if (i.code !== "invalid_union" || !i.errors?.length || i.message !== "Invalid input")
        return `${at(i)}: ${msg(i)}`;
      const branches = i.errors
        .slice(0, 6)
        .map((b, n) => `(${n + 1}) ${branchSummary(b)}`)
        .join(" ");
      return `${at(i)}: matches none of the accepted shapes: ${branches}`;
    })
    .join("; ");
}

type JsonSchema = {
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  [k: string]: unknown;
};

/** The JSON Schema (input side) a zod schema advertises in tools/list. */
function inputJsonSchema(schema: z.ZodType): JsonSchema | null {
  try {
    const std = (schema as unknown as { "~standard": { jsonSchema?: { input(o: object): JsonSchema } } })["~standard"];
    return std.jsonSchema?.input({ target: "draft-2020-12" }) ?? null;
  } catch {
    return null;
  }
}

/**
 * Top-level argument names a tool's input schema accepts (every branch of a root union), or null
 * when it takes any key (a record or loose root, or a shape we cannot read).
 */
export function allowedArgKeys(schema: z.ZodType): string[] | null {
  const root = inputJsonSchema(schema);
  if (!root) return null;
  const keys = new Set<string>();
  let seen = false;
  const visit = (s: JsonSchema): boolean => {
    if (!s || typeof s !== "object") return true;
    if (s.additionalProperties !== undefined && s.additionalProperties !== false) return false;
    if (s.properties) {
      seen = true;
      for (const k of Object.keys(s.properties)) keys.add(k);
    }
    return [...(s.anyOf ?? []), ...(s.oneOf ?? []), ...(s.allOf ?? [])].every(visit);
  };
  if (!visit(root) || !seen) return null;
  return [...keys];
}

/**
 * What the SDK sees as a tool's input schema: the same JSON Schema in tools/list (a plain object
 * root also says additionalProperties:false), but validation passes everything through, so the
 * runner's own check (validateArgs) reports bad arguments as BAD_ARGS for MCP and --http alike.
 */
function sdkInputSchema(schema: z.ZodType): unknown {
  const listed = (o: object, io: "input" | "output") => {
    const std = (
      schema as unknown as {
        "~standard": { jsonSchema: Record<"input" | "output", (o: object) => JsonSchema> };
      }
    )["~standard"];
    const js = std.jsonSchema[io](o);
    if (io === "input" && js.properties && js.additionalProperties === undefined && !js.anyOf && !js.oneOf)
      return { ...js, additionalProperties: false };
    return js;
  };
  return {
    "~standard": {
      version: 1,
      vendor: "tupaia",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: (o: object) => listed(o, "input"), output: (o: object) => listed(o, "output") }
    }
  };
}

/**
 * Validate a tool's raw arguments: unknown top-level keys are refused (they used to be dropped
 * silently, so a typo or a wrong option did nothing), then the zod schema runs. Throws BAD_ARGS.
 */
export async function validateArgs(name: string, schema: z.ZodType, allowed: string[] | null, raw: unknown) {
  if (raw === undefined || raw === null) raw = {};
  if (allowed && typeof raw === "object" && !Array.isArray(raw)) {
    const unknown = Object.keys(raw as object).filter(k => !allowed.includes(k));
    if (unknown.length) {
      const list = unknown.map(k => `'${k}'`).join(", ");
      throw new ToolError(
        "BAD_ARGS",
        `${name} does not take ${list}; allowed arguments: ${allowed.length ? allowed.join(", ") : "(none)"}`,
        { details: { unknown, allowed } }
      );
    }
  }
  const parsed = await schema.safeParseAsync(raw);
  if (!parsed.success)
    throw new ToolError("BAD_ARGS", `invalid arguments for ${name}: ${describeIssues(parsed.error.issues)}`);
  return parsed.data;
}

/** A tool definition recorded by ctx.tool(). */
export interface ToolDef {
  name: string;
  /** One map holds definitions of every input type; args are validated against inputSchema first. */
  spec: ToolSpec<any>;
  impl: (args: any, scope: CallScope) => Promise<WithImages | WithText | Record<string, unknown>>;
  /** Top-level argument names the schema accepts (null: any). */
  allowed: string[] | null;
}

/** How a call reacts to its caller going away. */
export interface CallPolicy {
  /**
   * false (stdio, the default): a cancellation aborts the call wherever it is, as before.
   * true (--http: one page shared by many callers): a call whose caller left before it started
   * is skipped, and a started call runs to completion (bounded by its timeout), so one caller's
   * disconnect never interrupts a page mutation the others would then have to recover from.
   */
  finishStartedCalls: boolean;
  /**
   * Set (to the reason) while an --http daemon shuts down: calls still queued for the mutex are
   * refused when their turn comes (nothing runs), so a stop only waits for the call in progress.
   */
  closing: string | null;
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
  /**
   * What the newest edit/add/paint_cells call redrew (screenshot compares use it to explain a
   * 'no change' result). `suppressed`: the caller passed redraw:false or []. `ops`: the
   * provenance op count right after it, so a later mutation, undo or load makes it stale.
   */
  lastRedraw: {
    tool: string;
    at: number;
    ops: number;
    redrawn: string[];
    skippedHidden: string[];
    suppressed: boolean;
  } | null = null;
  /** Tool definitions in registration order (ctx.tool()). */
  readonly toolDefs = new Map<string, ToolDef>();
  readonly callPolicy: CallPolicy = { finishStartedCalls: false, closing: null };
  /** Tool calls started so far, and the newest one not annotated read-only (restore point reuse). */
  callSeq = 0;
  #lastMutableSeq = 0;
  /** How this process is served (session status reports it). */
  serving: { transport: "stdio" } | { transport: "http"; url: string; pid: number } = { transport: "stdio" };

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
    this.snapshots.provenance = {
      ...src.provenance,
      ...(src.kind === "point" ? {} : { restoredFrom: src.label }),
      mapId: env.value?.mapId ?? null
    };
    const topUndo = this.snapshots.undoStack[this.snapshots.undoStack.length - 1]?.id;
    this.snapshots.afterRestore(src.kind);
    void reason;
    // the restore point is the page as the newest finished call left it: the sketch log still holds
    if (src.kind === "point") return `Restored ${src.label} (nothing lost).`;
    this.sketches.onCrashRestore(src.kind, src.kind === "undo" ? topUndo : undefined, src.label);
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
      this.snapshots.setProvenance({ kind: "unknown", mapId: id, opsSince: p.opsSince }, { sameMap: true });
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

  get toolNames(): string[] {
    return [...this.toolDefs.keys()];
  }

  /** Define a tool that runs through the shared runner (attach() registers it on servers). */
  tool<S extends z.ZodType>(
    name: string,
    spec: ToolSpec<S>,
    impl: (args: z.infer<S>, scope: CallScope) => Promise<WithImages | WithText | Record<string, unknown>>
  ): void {
    if (this.toolDefs.has(name)) throw new Error(`tool '${name}' is defined twice`);
    this.toolDefs.set(name, { name, spec, impl, allowed: allowedArgKeys(spec.inputSchema) });
  }

  /**
   * Register every defined tool on `server`. Safe for any number of servers: they all share this
   * context (one browser, page, undo history and sketch) and its call mutex. Tools use the server
   * for nothing else (no logging, no notifications), so a per-request server holds no state.
   * `gone` (--http: the HTTP request's signal) also counts as the caller going away, so a queued
   * call is skipped when its client disconnects whatever the SDK does with the request.
   */
  attach(server: McpServer, gone?: AbortSignal): void {
    for (const d of this.toolDefs.values()) {
      server.registerTool(
        d.name,
        {
          title: d.spec.title,
          description: d.spec.description,
          inputSchema: sdkInputSchema(d.spec.inputSchema),
          annotations: d.spec.annotations,
          _meta: d.spec._meta
        } as any,
        (async (raw: any, sctx: ServerContext) => {
          let args: unknown;
          try {
            args = await validateArgs(d.name, d.spec.inputSchema, d.allowed, raw);
          } catch (e) {
            return errorResult(e);
          }
          const own = sctx?.mcpReq?.signal;
          const signal = gone && own ? AbortSignal.any([own, gone]) : (own ?? gone);
          return this.#runSignal({ ...d.spec, name: d.name }, signal, args, d.impl);
        }) as any
      );
    }
  }

  /**
   * Run a defined tool by name without an MCP server (the --http JSON API): validate `args`
   * against its input schema, then go through the same runner as MCP calls. `timeoutMs` is the
   * call's budget (also passed as args.timeoutMs when the tool takes one and args has none).
   */
  async callTool(
    name: string,
    args: unknown,
    opts: { timeoutMs?: number; signal?: AbortSignal; onSkipped?: () => void } = {}
  ): Promise<CallToolResult> {
    const d = this.toolDefs.get(name);
    if (!d) return errorResult(new ToolError("NOT_FOUND", `no tool '${name}' (tools: ${this.toolNames.join(", ")})`));
    let raw: unknown = args ?? {};
    const takesTimeout = !d.allowed || d.allowed.includes("timeoutMs");
    if (takesTimeout && opts.timeoutMs !== undefined && raw && typeof raw === "object" && !Array.isArray(raw)) {
      const o = raw as Record<string, unknown>;
      if (o.timeoutMs === undefined) raw = { ...o, timeoutMs: opts.timeoutMs };
    }
    let valid: unknown;
    try {
      valid = await validateArgs(name, d.spec.inputSchema, d.allowed, raw);
    } catch (e) {
      return errorResult(e);
    }
    return this.#runSignal({ ...d.spec, name }, opts.signal, valid, d.impl, opts.timeoutMs, opts.onSkipped);
  }

  async run<A>(
    spec: { kind?: ToolKind; launch?: boolean; name?: string },
    sctx: ServerContext | undefined,
    args: A,
    impl: (args: A, scope: CallScope) => Promise<WithImages | WithText | Record<string, unknown>>
  ): Promise<CallToolResult> {
    return this.#runSignal(spec, sctx?.mcpReq?.signal, args, impl);
  }

  async #runSignal<A>(
    spec: { kind?: ToolKind; launch?: boolean; name?: string; annotations?: { readOnlyHint?: boolean } },
    signal: AbortSignal | undefined,
    args: A,
    impl: (args: A, scope: CallScope) => Promise<WithImages | WithText | Record<string, unknown>>,
    timeoutMs?: number,
    /** Called when the call is skipped before it starts (caller gone, or the daemon is closing). */
    onSkipped?: () => void
  ): Promise<CallToolResult> {
    return this.browser.exclusive(async () => {
      const finish = this.callPolicy.finishStartedCalls;
      if (finish && signal?.aborted) {
        onSkipped?.();
        return errorResult(new ToolError("CANCELLED", "the caller went away before the call started; nothing ran"));
      }
      if (this.callPolicy.closing) {
        onSkipped?.();
        return errorResult(
          new ToolError(
            "CANCELLED",
            `the server is shutting down (${this.callPolicy.closing}); this call did not run. The next call starts a fresh server with a fresh page.`
          )
        );
      }
      const kind = spec.kind ?? "read";
      const rawTimeout = (args as { timeoutMs?: unknown } | undefined)?.timeoutMs;
      const scope = new CallScope(
        this,
        finish ? undefined : signal,
        kind,
        typeof rawTimeout === "number" ? rawTimeout : timeoutMs,
        spec.name ?? ""
      );
      scope.seq = ++this.callSeq;
      scope.prevMutableSeq = this.#lastMutableSeq;
      if (spec.annotations?.readOnlyHint !== true) this.#lastMutableSeq = scope.seq;
      const writes0 = this.browser.writes;
      try {
        if (spec.launch !== false) {
          await this.browser.ensureHealthy(scope.notes);
          // a launch or relaunch (and its restore) has its own budget: the call's starts now
          scope.started = Date.now();
        } else if (this.browser.pendingNotes.length) scope.notes.push(...this.browser.pendingNotes.splice(0));
        const out = await impl(args, scope);
        await this.#sketchFallback(scope, args, null);
        await this.#capturePoint(scope, writes0);
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
        await this.#capturePoint(scope, writes0);
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

  /** Marks a restore point records (see SnapshotStore.setRestorePoint). */
  restoreMarks(scope: CallScope): { writes: number; launches: number; callSeq: number } {
    return { writes: this.browser.writes, launches: this.browser.launches, callSeq: scope.seq };
  }

  /**
   * After a call that changed the page (a mutating bridge call, an undo entry, a relaunch), keep
   * the page map as the restore point, so a later relaunch restores the state the finished call
   * left instead of an older undo point. Skipped when the page cannot be trusted.
   */
  async #capturePoint(scope: CallScope, writes0: number): Promise<void> {
    if (this.browser.writes === writes0 && !scope.undoPushed.length) return;
    if (!this.browser.healthy) return;
    try {
      const text = await scope.cleanup(() => scope.mapText());
      const label = `the map as '${scope.tool || "a call"}' left it (${new Date().toISOString()})`;
      this.snapshots.setRestorePoint(text, label, this.restoreMarks(scope));
    } catch {
      // keep the older point; a relaunch then restores the newest snapshot or undo point
    }
  }

  #extras(scope: CallScope) {
    return {
      alerts: scope.alerts,
      consoleErrors: summarizeConsole(this.browser.consoleSince(scope.consoleSeq)),
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
