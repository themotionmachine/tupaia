// --http: one long-lived daemon that many callers share (a running Claude session, its workflow
// subagents, shells), so tools work without restarting Claude. ONE ToolContext serves everything:
// one browser, one page, one undo history, one sketch, one call mutex.
//
//   /mcp       MCP Streamable HTTP (the SDK's createMcpHandler: 2026-07-28 requests and stateless
//              2025-era requests, a fresh McpServer per request over the shared context)
//   POST /call {name, args?, timeoutMs?} -> {isError, text[], images[]} (images saved to files)
//   GET /tools, GET /health, POST /shutdown
//
// Security: listens on 127.0.0.1 only; refuses a Host other than 127.0.0.1:<port> or
// localhost:<port> (DNS rebinding) and any request carrying an Origin header (browsers) with 403;
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
  pidAlive,
  probeHealth,
  readState,
  removeStateIfOwned,
  statePath,
  writeState
} from "./daemon-state.ts";
import { TIMEOUT_CAP_MS } from "./schemas.ts";

/** Request body limit for /mcp and /call. */
const BODY_MAX = 32 * 1024 * 1024;
/** How long a stop waits for running calls before closing their connections. */
const DRAIN_MS = 15_000;
export const DEFAULT_IDLE_MIN = 120;

export interface HttpOptions {
  ctx: ToolContext;
  config: Config;
  /** A fresh McpServer with the full surface (called per MCP request). */
  makeServer: () => McpServer;
  /** 0 = any free port. */
  port: number;
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

/** A 2026-07-28 `subscriptions/listen` request (a long-lived SSE stream of change notifications). */
function isListenRequest(body: Buffer | undefined): boolean {
  if (!body?.length || body.length > 65_536) return false;
  try {
    const m = JSON.parse(body.toString("utf8")) as { method?: unknown };
    return !!m && typeof m === "object" && m.method === "subscriptions/listen";
  } catch {
    return false;
  }
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

  const prev = readState(outDir);
  if (prev && prev.pid !== process.pid && pidAlive(prev.pid) && (await probeHealth(prev))) {
    throw new Error(
      `a tupaia daemon already serves ${outDir} (pid ${prev.pid}, ${prev.url}); stop it first (tupaia stop) or use another TUPAIA_OUT`
    );
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  const authOk = (h: string | undefined): boolean => {
    if (!h) return false;
    const got = Buffer.from(h);
    return got.length === expectedAuth.length && crypto.timingSafeEqual(got, expectedAuth);
  };

  ctx.callPolicy.finishStartedCalls = true;
  const mcp = createMcpHandler(() => o.makeServer(), {
    maxRequestBodySize: BODY_MAX,
    onerror: e => log(`mcp: ${e.message}`)
  });

  let port = 0;
  let closing: Promise<void> | null = null;
  let active = 0;
  let lastActivity = Date.now();
  let requests = 0;
  let shotSeq = 0;
  const startedAt = new Date().toISOString();
  let toolsCache: unknown[] | null = null;

  /** Count a request; `busy` ones (calls, not long-lived notification streams) hold off idle shutdown. */
  const begin = (res: http.ServerResponse, busy = true) => {
    requests++;
    lastActivity = Date.now();
    if (!busy) return;
    active++;
    res.once("close", () => {
      active--;
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
    let body: { name?: unknown; args?: unknown; timeoutMs?: unknown };
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
    const t0 = Date.now();
    const r = await ctx.callTool(body.name, body.args ?? {}, { timeoutMs, signal });
    const out = saveImages(r);
    log(
      `call ${body.name} ${Date.now() - t0} ms ${out.isError ? "error" : "ok"}${signal.aborted ? " (caller gone)" : ""}`
    );
    sendJson(res, 200, out);
  };

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
    // A connected client may hold a notification stream open for hours; that is not activity
    // (idle shutdown still applies, and a stop does not wait for it).
    begin(res, method !== "GET" && !isListenRequest(body));
    const headers = new Headers();
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
    const request = new Request(`http://127.0.0.1:${port}${req.url ?? "/mcp"}`, {
      method,
      headers,
      body: body?.length ? new Uint8Array(body) : undefined,
      signal: goneSignal(res)
    });
    await writeWeb(res, await mcp.fetch(request));
  };

  const health = () => ({
    ok: true,
    pid: process.pid,
    url: `http://127.0.0.1:${port}`,
    mode: ctx.mode.mode,
    envMode: config.envMode,
    version: o.version,
    appVersion: readDistVersion(config.distDir),
    startedAt,
    uptimeS: Math.round(process.uptime()),
    idleMin: o.idleMin,
    idleS: active ? 0 : Math.round((Date.now() - lastActivity) / 1000),
    active,
    requests,
    browser: ctx.browser.state,
    tools: ctx.toolDefs.size,
    outDir,
    repoRoot: config.repoRoot
  });

  const server = http.createServer((req, res) => {
    res.on("error", () => {});
    void (async () => {
      try {
        const host = (req.headers.host ?? "").toLowerCase();
        if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
          return sendJson(res, 403, { error: `Host '${req.headers.host ?? ""}' refused (only 127.0.0.1:${port})` });
        if (req.headers.origin !== undefined)
          return sendJson(res, 403, { error: "requests with an Origin header are refused (no browser access)" });
        if (!authOk(req.headers.authorization))
          return sendJson(res, 401, { error: `missing or wrong bearer token (see ${statePath(outDir)})` });
        if (closing) return sendJson(res, 503, { error: "the daemon is shutting down" });
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
        return sendJson(res, 404, { error: `no route ${method} ${url.pathname}` });
      } catch (e) {
        log(`request error: ${(e as Error).stack ?? e}`);
        if (!res.headersSent) sendJson(res, 500, { error: (e as Error).message });
        else res.destroy();
      }
    })();
  });
  server.keepAliveTimeout = 5000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as { port: number }).port;
  server.on("error", e => log(`server error: ${e.message}`));
  const url = `http://127.0.0.1:${port}`;
  ctx.serving = { transport: "http", url: `${url}/mcp`, pid: process.pid };

  const state: DaemonState = {
    pid: process.pid,
    port,
    url,
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
        log(`cannot rewrite ${statePath(outDir)}: ${(e as Error).message}`);
      }
    }
    if (idleMs > 0 && active === 0 && Date.now() - lastActivity >= idleMs)
      o.onStop(`idle for ${o.idleMin} min (TUPAIA_HTTP_IDLE_MIN)`);
  }, period);
  timer.unref();

  const close = (reason: string): Promise<void> => {
    closing ??= (async () => {
      clearInterval(timer);
      removeStateIfOwned(outDir, process.pid);
      server.close();
      const end = Date.now() + DRAIN_MS;
      while (active > 0 && Date.now() < end) await new Promise(r => setTimeout(r, 100));
      await mcp.close().catch(() => {});
      server.closeAllConnections();
      log(`http daemon closed (${reason})`);
    })();
    return closing;
  };

  return { port, url, state, close };
}
