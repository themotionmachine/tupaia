// --http: one long-lived daemon that many callers share (a running Claude session, its workflow
// subagents, shells), so tools work without restarting Claude. ONE ToolContext serves everything:
// one browser, one page, one undo history, one sketch, one call mutex.
//
//   /mcp       MCP Streamable HTTP (the SDK's createMcpHandler: 2026-07-28 requests and stateless
//              2025-era requests, a fresh McpServer per request over the shared context)
//   POST /call {name, args?, timeoutMs?, caller?} -> {isError, text[], images[]} (images saved)
//   GET /tools, GET /health, POST /shutdown, POST /listen {port} (also listen on that port, for a
//   Claude Code registration that names it; see `tupaia headers`)
//
// Security: listens on 127.0.0.1 only; refuses a Host other than 127.0.0.1:<p> or localhost:<p>
// (p = the port the connection arrived on; DNS rebinding) and any request carrying an Origin
// header (browsers) with 403;
// every request needs `Authorization: Bearer <token>` (random per start, in the 0600 state file)
// or gets 401. The mode comes from the daemon's spawn environment only, exactly as for stdio.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { type CallToolResult, createMcpHandler, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Config, readDistVersion } from "./config.ts";
import type { ToolContext } from "./context.ts";
import {
  type DaemonState,
  LAST_FILE,
  type LastExit,
  pidAlive,
  probeHealth,
  readStartLock,
  readState,
  removeStateIfOwned,
  START_LOCK,
  writeState
} from "./daemon-state.ts";
import { TIMEOUT_CAP_MS } from "./schemas.ts";

/** Request body limit for /mcp and /call. */
const BODY_MAX = 32 * 1024 * 1024;
/** How long a stop waits for running calls before closing their connections. */
const DRAIN_MS = 15_000;
/** How long a stop spends saving the page map (see saveOnExit). */
const EXIT_SAVE_MS = 15_000;
/** daemon-exit-*.map files kept in TUPAIA_OUT/maps. */
const EXIT_SAVES_KEPT = 5;
export const DEFAULT_IDLE_MIN = 120;

export interface HttpOptions {
  ctx: ToolContext;
  config: Config;
  /** A fresh McpServer with the full surface (called per MCP request; `gone` = the client left). */
  makeServer: (gone?: AbortSignal) => McpServer;
  /** 0 = any free port. */
  port: number;
  /** When `port` is taken, listen on any free port instead of failing (the CLI's remembered port). */
  preferPort?: boolean;
  /** Idle shutdown after this many minutes without a call; 0 = never. */
  idleMin: number;
  version: string;
  log: (msg: string) => void;
  /** Ends the process (idle, /shutdown, superseded). */
  onStop: (reason: string) => void;
}

export interface HttpDaemon {
  port: number;
  url: string;
  state: DaemonState;
  close(reason: string): Promise<void>;
}

/** Port from --port or TUPAIA_HTTP_PORT; empty means 0 (any free port). */
export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`port '${raw}' is not 0..65535`);
  return n;
}

/** TUPAIA_HTTP_IDLE_MIN: minutes (fractions allowed), 0 = never; default 120. */
export function parseIdleMin(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_IDLE_MIN;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) throw new Error(`TUPAIA_HTTP_IDLE_MIN '${raw}' is not a number of minutes >= 0`);
  return n;
}

/** --port N / --port=N from argv. */
export function argValue(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1];
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return undefined;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.destroyed) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store"
  });
  res.end(text);
}

/** The request body, or null when it exceeds `max`. */
function readBody(req: http.IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > max) {
        over = true;
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

/** Stream a web Response into a Node response (SSE frames go out as they come). */
async function writeWeb(res: http.ServerResponse, r: Response): Promise<void> {
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    headers[k] = v;
  });
  res.writeHead(r.status, headers);
  if (!r.body) {
    res.end();
    return;
  }
  res.flushHeaders();
  const reader = r.body.getReader();
  res.on("close", () => {
    if (!res.writableFinished) void reader.cancel().catch(() => {});
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || res.destroyed) break;
      if (!res.write(value))
        await new Promise<void>(ok => {
          res.once("drain", ok);
          res.once("close", ok);
        });
    }
  } catch {
    // the client went away mid-stream
  } finally {
    if (!res.destroyed) res.end();
  }
}

function jsonSchemaOf(schema: unknown): Record<string, unknown> {
  try {
    const j = z.toJSONSchema(schema as z.ZodType, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete j.$schema;
    return j;
  } catch {
    return { type: "object" };
  }
}

type RpcId = string | number;
const isId = (v: unknown): v is RpcId => typeof v === "string" || typeof v === "number";

/** Method, id, tool name (tools/call) and cancelled request id of a single JSON-RPC message body. */
function rpcOf(body: Buffer | undefined): { method?: string; id?: RpcId; tool?: string; cancels?: RpcId } {
  if (!body?.length || body.length > 4 * 1024 * 1024) return {};
  try {
    const m = JSON.parse(body.toString("utf8")) as {
      method?: unknown;
      id?: unknown;
      params?: { name?: unknown; requestId?: unknown };
    };
    if (!m || typeof m !== "object" || typeof m.method !== "string") return {};
    return {
      method: m.method,
      id: isId(m.id) ? m.id : undefined,
      tool: typeof m.params?.name === "string" ? m.params.name : undefined,
      cancels: m.method === "notifications/cancelled" && isId(m.params?.requestId) ? m.params.requestId : undefined
    };
  } catch {
    return {};
  }
}

const ROUTES = "POST /mcp (MCP Streamable HTTP), POST /call, GET /tools, GET /health, POST /shutdown, POST /listen";

function listenOn(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as { port: number }).port);
    });
  });
}

function extOf(mime: string): string {
  if (/png/i.test(mime)) return "png";
  if (/webp/i.test(mime)) return "webp";
  if (/gif/i.test(mime)) return "gif";
  return "jpg";
}

export async function startHttpDaemon(o: HttpOptions): Promise<HttpDaemon> {
  const { ctx, config, log } = o;
  const outDir = config.outDir;

  let prev = readState(outDir);
  if (prev?.closing && prev.pid !== process.pid) {
    // the previous daemon is shutting down: let it close its browser first
    const end = Date.now() + DRAIN_MS + 15_000;
    while (pidAlive(prev.pid) && Date.now() < end) await new Promise(r => setTimeout(r, 200));
    prev = readState(outDir);
  }
  if (prev && prev.pid !== process.pid && pidAlive(prev.pid) && (await probeHealth(prev))) {
    throw new Error(
      `a tupaia daemon already serves ${outDir} (pid ${prev.pid}, ${prev.url}); stop it first (tupaia stop) or use another TUPAIA_OUT`
    );
  }

  // the CLI that starts a daemon makes its token (so `tupaia headers` can print it early)
  const given = process.env.TUPAIA_HTTP_TOKEN;
  delete process.env.TUPAIA_HTTP_TOKEN; // never passed on to the browser
  const token = given && /^[A-Za-z0-9_-]{32,}$/.test(given) ? given : crypto.randomBytes(32).toString("base64url");
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  const authOk = (h: string | undefined): boolean => {
    if (!h) return false;
    const got = Buffer.from(h);
    return got.length === expectedAuth.length && crypto.timingSafeEqual(got, expectedAuth);
  };

  ctx.callPolicy.finishStartedCalls = true;
  /** TUPAIA_HTTP_TRACE=1: log every MCP request's method and protocol version (interop debugging). */
  const trace = /^(1|true|yes|on)$/i.test(process.env.TUPAIA_HTTP_TRACE ?? "");
  const mcp = createMcpHandler(c => o.makeServer(c.requestInfo?.signal), {
    maxRequestBodySize: BODY_MAX,
    onerror: e => log(`mcp: ${e.message}`)
  });

  let port = 0;
  /** Listeners by port: the first one, plus any POST /listen added. */
  const servers = new Map<number, http.Server>();
  let closing: Promise<void> | null = null;
  let active = 0;
  /** Open subscriptions/listen streams (attached MCP clients). */
  let attached = 0;
  let lastActivity = Date.now();
  let requests = 0;
  let shotSeq = 0;
  const startedAt = new Date().toISOString();
  let toolsCache: unknown[] | null = null;

  /**
   * Count a request. A call is `busy` (a stop waits for it); a `stream` is a client's long-lived
   * subscriptions/listen stream: Claude Code holds one for its whole session (verified with
   * 2.1.293) and does not reconnect after the daemon stops, so an open stream holds off idle
   * shutdown (a stop does not wait for it).
   */
  const begin = (res: http.ServerResponse, kind: "busy" | "stream" | "other" = "busy") => {
    requests++;
    lastActivity = Date.now();
    if (kind === "other") return;
    if (kind === "busy") active++;
    else attached++;
    res.once("close", () => {
      if (kind === "busy") active--;
      else attached--;
      lastActivity = Date.now();
    });
  };
  /** Aborted when the client goes away before its response was sent. */
  const goneSignal = (res: http.ServerResponse): AbortSignal => {
    const ac = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) ac.abort();
    });
    return ac.signal;
  };

  const saveImages = (r: CallToolResult) => {
    const out = { isError: !!r.isError, text: [] as string[], images: [] as string[] };
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "");
    for (const c of r.content ?? []) {
      if (c.type === "text") out.text.push(c.text);
      else if (c.type === "image") {
        const file = path.join(outDir, "shots", `call-${stamp}-${++shotSeq}.${extOf(c.mimeType)}`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(c.data, "base64"));
        out.images.push(file);
      } else out.text.push(JSON.stringify(c));
    }
    return out;
  };

  const handleCall = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    begin(res);
    const signal = goneSignal(res);
    const buf = await readBody(req, BODY_MAX);
    if (buf === null) return sendJson(res, 413, { error: `body over ${BODY_MAX} bytes` });
    let body: { name?: unknown; args?: unknown; timeoutMs?: unknown; caller?: unknown };
    try {
      body = buf.length ? JSON.parse(buf.toString("utf8")) : {};
    } catch (e) {
      return sendJson(res, 400, { error: `body is not JSON: ${(e as Error).message}` });
    }
    if (!body || typeof body !== "object" || typeof body.name !== "string" || !body.name)
      return sendJson(res, 400, { error: "body must be {name, args?, timeoutMs?}" });
    const t = body.timeoutMs;
    const timeoutMs =
      typeof t === "number" && Number.isFinite(t) ? Math.round(Math.min(TIMEOUT_CAP_MS, Math.max(500, t))) : undefined;
    const who = typeof body.caller === "string" && body.caller ? ` [${body.caller.slice(0, 120)}]` : "";
    const t0 = Date.now();
    let skipped = false;
    const r = await ctx.callTool(body.name, body.args ?? {}, {
      timeoutMs,
      signal,
      onSkipped: () => {
        skipped = true;
      }
    });
    if (skipped) {
      const why = signal.aborted
        ? "the caller went away before it started"
        : `shutting down (${ctx.callPolicy.closing})`;
      log(`call ${body.name} skipped after ${Date.now() - t0} ms: ${why}${who}`);
      // nothing ran: a caller may start a fresh daemon and call again
      if (!signal.aborted)
        return sendJson(res, 503, {
          error: `the daemon is shutting down (${ctx.callPolicy.closing}); the call did not run`,
          closing: true,
          ran: false
        });
      return sendJson(res, 200, saveImages(r));
    }
    const out = saveImages(r);
    log(
      `call ${body.name} ${Date.now() - t0} ms ${out.isError ? "error" : "ok"}${signal.aborted ? " (caller gone; finished anyway)" : ""}${who}`
    );
    sendJson(res, 200, out);
  };

  /**
   * tools/call requests in flight by JSON-RPC id. A 2025-era client cancels with a separate
   * notifications/cancelled POST, which stateless serving cannot route; this does, for an id only
   * one request in flight holds (ids are per client), so a queued call is skipped. A started call
   * still finishes (finishStartedCalls).
   */
  const inflight = new Map<string, Set<AbortController>>();

  const handleMcp = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const method = (req.method ?? "GET").toUpperCase();
    let body: Buffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const b = await readBody(req, BODY_MAX);
      if (b === null) {
        begin(res);
        return sendJson(res, 413, { error: `body over ${BODY_MAX} bytes` });
      }
      body = b;
    }
    // an attached client's notification stream holds off idle shutdown; a stop does not wait for it
    const rpc = rpcOf(body);
    if (trace)
      log(
        `mcp ${method} ${rpc.method ?? "-"} protocol ${req.headers["mcp-protocol-version"] ?? "-"} session ${req.headers["mcp-session-id"] ?? "-"}`
      );
    begin(res, method === "GET" ? "other" : rpc.method === "subscriptions/listen" ? "stream" : "busy");
    const t0 = Date.now();
    if (rpc.cancels !== undefined) {
      const held = inflight.get(String(rpc.cancels));
      if (held?.size === 1) {
        for (const ac of held) ac.abort();
        log(`mcp cancel of request ${rpc.cancels}: skipped unless it had started`);
      } else if (held?.size) log(`mcp cancel of request ${rpc.cancels} ignored: ${held.size} clients use that id`);
    }
    let cancel: AbortController | undefined;
    if (rpc.method === "tools/call" && rpc.id !== undefined) {
      const key = String(rpc.id);
      cancel = new AbortController();
      const set = inflight.get(key) ?? new Set<AbortController>();
      set.add(cancel);
      inflight.set(key, set);
      const ac = cancel;
      res.once("close", () => {
        set.delete(ac);
        if (!set.size && inflight.get(key) === set) inflight.delete(key);
      });
    }
    const gone = goneSignal(res);
    const headers = new Headers();
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
    const request = new Request(`http://127.0.0.1:${port}${req.url ?? "/mcp"}`, {
      method,
      headers,
      body: body?.length ? new Uint8Array(body) : undefined,
      signal: cancel ? AbortSignal.any([gone, cancel.signal]) : gone
    });
    let reply: Response;
    try {
      reply = await mcp.fetch(request);
    } catch (e) {
      if (!cancel?.signal.aborted) throw e;
      // cancelled: the client expects no answer for that request
      return sendJson(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "request cancelled" } });
    }
    await writeWeb(res, reply);
    if (rpc.method === "tools/call")
      log(`mcp call ${rpc.tool ?? "?"} ${Date.now() - t0} ms${cancel?.signal.aborted ? " (cancelled)" : ""}`);
  };

  /** POST /listen {port}: also serve on that port (a registration names it). */
  const handleListen = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const buf = await readBody(req, 4096);
    let want: unknown;
    try {
      want = buf?.length ? (JSON.parse(buf.toString("utf8")) as { port?: unknown }).port : undefined;
    } catch {
      want = undefined;
    }
    if (typeof want !== "number" || !Number.isInteger(want) || want < 1 || want > 65535)
      return sendJson(res, 400, { error: "body must be {port: 1..65535}" });
    if (!servers.has(want)) {
      const extra = makeListener();
      try {
        await listenOn(extra, want);
      } catch (e) {
        return sendJson(res, 409, { error: `cannot listen on 127.0.0.1:${want}: ${(e as Error).message}` });
      }
      servers.set(want, extra);
      state.ports = [...servers.keys()];
      writeState(outDir, state);
      log(`also listening on http://127.0.0.1:${want}/mcp`);
    }
    sendJson(res, 200, { ok: true, ports: [...servers.keys()] });
  };

  const health = () => ({
    ok: true,
    pid: process.pid,
    url: `http://127.0.0.1:${port}`,
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    ports: [...servers.keys()],
    mode: ctx.mode.mode,
    envMode: config.envMode,
    version: o.version,
    appVersion: readDistVersion(config.distDir),
    startedAt,
    uptimeS: Math.round(process.uptime()),
    idleMin: o.idleMin,
    idleS: active || attached ? 0 : Math.round((Date.now() - lastActivity) / 1000),
    active,
    attached,
    requests,
    browser: ctx.browser.state,
    tools: ctx.toolDefs.size,
    outDir,
    repoRoot: config.repoRoot
  });

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.on("error", () => {});
    void (async () => {
      try {
        const lp = req.socket.localPort;
        const host = (req.headers.host ?? "").toLowerCase();
        if (host !== `127.0.0.1:${lp}` && host !== `localhost:${lp}`)
          return sendJson(res, 403, { error: `Host '${req.headers.host ?? ""}' refused (only 127.0.0.1:${lp})` });
        if (req.headers.origin !== undefined)
          return sendJson(res, 403, { error: "requests with an Origin header are refused (no browser access)" });
        if (!authOk(req.headers.authorization))
          return sendJson(res, 401, {
            error: "missing or wrong bearer token (it is in daemon.json in the daemon's TUPAIA_OUT)"
          });
        if (closing)
          return sendJson(res, 503, {
            error: `the daemon is shutting down (${ctx.callPolicy.closing})`,
            closing: true,
            ran: false
          });
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        const method = (req.method ?? "GET").toUpperCase();
        if (url.pathname === "/mcp") return await handleMcp(req, res);
        if (url.pathname === "/call" && method === "POST") return await handleCall(req, res);
        if (url.pathname === "/health" && method === "GET") return sendJson(res, 200, health());
        if (url.pathname === "/tools" && method === "GET") {
          toolsCache ??= [...ctx.toolDefs.values()].map(d => ({
            name: d.name,
            title: d.spec.title,
            description: d.spec.description,
            inputSchema: jsonSchemaOf(d.spec.inputSchema),
            annotations: d.spec.annotations
          }));
          return sendJson(res, 200, { tools: toolsCache });
        }
        if (url.pathname === "/shutdown" && method === "POST") {
          sendJson(res, 200, { ok: true, stopping: process.pid });
          setImmediate(() => o.onStop("stop requested over http"));
          return;
        }
        if (url.pathname === "/listen" && method === "POST") return await handleListen(req, res);
        return sendJson(res, 404, { error: `no route ${method} ${url.pathname}; routes: ${ROUTES}` });
      } catch (e) {
        log(`request error: ${(e as Error).stack ?? e}`);
        if (!res.headersSent) sendJson(res, 500, { error: (e as Error).message });
        else res.destroy();
      }
    })();
  };
  const makeListener = () => {
    const s = http.createServer(handler);
    s.keepAliveTimeout = 5000;
    s.on("error", e => log(`server error: ${e.message}`));
    return s;
  };

  const first = makeListener();
  try {
    port = await listenOn(first, o.port);
  } catch (e) {
    if (!(o.preferPort && o.port && (e as NodeJS.ErrnoException).code === "EADDRINUSE")) throw e;
    log(`port ${o.port} is taken; listening on another free port`);
    port = await listenOn(first, 0);
  }
  servers.set(port, first);
  const url = `http://127.0.0.1:${port}`;
  ctx.serving = { transport: "http", url: `${url}/mcp`, pid: process.pid };

  const state: DaemonState = {
    pid: process.pid,
    port,
    url,
    mcpUrl: `${url}/mcp`,
    ports: [port],
    mode: config.envMode,
    startedAt,
    version: o.version,
    appVersion: readDistVersion(config.distDir),
    repoRoot: config.repoRoot,
    outDir,
    idleMin: o.idleMin,
    token
  };
  writeState(outDir, state);
  // the CLI that started this daemon may have left its start lock for it to remove
  if (readStartLock(outDir)?.daemonPid === process.pid) fs.rmSync(path.join(outDir, START_LOCK), { force: true });
  // removed last thing on exit (after the browser closed), unless another daemon took it over
  process.once("exit", () => removeStateIfOwned(outDir, process.pid));

  // Idle shutdown, and state-file ownership: if another daemon took this TUPAIA_OUT over, the
  // older one is undiscoverable, so it stops; a deleted file is written again.
  const idleMs = o.idleMin * 60_000;
  const period = idleMs > 0 ? Math.max(1000, Math.min(60_000, idleMs / 4)) : 60_000;
  const timer = setInterval(() => {
    if (closing) return;
    const cur = readState(outDir);
    if (cur && cur.pid !== process.pid && pidAlive(cur.pid)) {
      o.onStop(`superseded: daemon pid ${cur.pid} now serves ${outDir}`);
      return;
    }
    if (!cur || cur.pid !== process.pid) {
      try {
        writeState(outDir, state);
      } catch (e) {
        log(`cannot rewrite the state file in ${outDir}: ${(e as Error).message}`);
      }
    }
    if (idleMs > 0 && active === 0 && attached === 0 && Date.now() - lastActivity >= idleMs)
      o.onStop(`idle for ${o.idleMin} min (TUPAIA_HTTP_IDLE_MIN)`);
  }, period);
  timer.unref();

  /**
   * The page dies with the daemon (stop, idle, superseded), so a page anyone changed is saved
   * first to TUPAIA_OUT/maps/daemon-exit-<time>.map; daemon.last.json names it for the next start.
   */
  const saveOnExit = async (reason: string): Promise<void> => {
    const p = ctx.snapshots.provenance;
    if (!ctx.browser.healthy || (p.kind === "boot" && p.opsSince === 0)) return;
    const save = ctx.browser.exclusive(async () => {
      const env = await ctx.browser.callBridge<{ text: string }>(
        "mapData",
        {},
        { timeoutMs: EXIT_SAVE_MS - 1000, noAlerts: true }
      );
      if (!env.ok || !env.value?.text) throw new Error(env.error?.message ?? "no map text");
      const dir = path.join(outDir, "maps");
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z$/, "");
      const file = path.join(dir, `daemon-exit-${stamp}.map`);
      fs.writeFileSync(file, env.value.text);
      const old = fs
        .readdirSync(dir)
        .filter(f => /^daemon-exit-.*\.map$/.test(f))
        .sort()
        .slice(0, -EXIT_SAVES_KEPT);
      for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
      const last: LastExit = { pid: process.pid, reason, at: new Date().toISOString(), savedMap: file };
      fs.writeFileSync(path.join(outDir, LAST_FILE), `${JSON.stringify(last)}\n`);
      log(`saved the page map to ${file}`);
    });
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`no map within ${EXIT_SAVE_MS} ms`)), EXIT_SAVE_MS).unref();
    });
    await Promise.race([save, timeout]).catch(e => log(`could not save the page map on exit: ${(e as Error).message}`));
  };

  // A stop refuses queued calls at once (nothing runs; the CLI starts a fresh daemon for them)
  // and waits up to DRAIN_MS for the call in progress. The state file stays, marked closing,
  // until the end, so callers wait for this pid to exit instead of starting a second browser.
  const close = (reason: string): Promise<void> => {
    closing ??= (async () => {
      clearInterval(timer);
      ctx.callPolicy.closing = reason;
      const cur = readState(outDir);
      if (!cur || cur.pid === process.pid) {
        try {
          writeState(outDir, { ...state, closing: reason });
        } catch {
          // the CLI still sees the port refuse and the pid alive
        }
      }
      for (const s of servers.values()) s.close();
      const end = Date.now() + DRAIN_MS;
      while (active > 0 && Date.now() < end) await new Promise(r => setTimeout(r, 100));
      await mcp.close().catch(() => {});
      for (const s of servers.values()) s.closeAllConnections();
      await saveOnExit(reason);
      log(`http daemon closed (${reason})`);
    })();
    return closing;
  };

  return { port, url, state, close };
}
