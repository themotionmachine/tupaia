// Test harness: spawn the server over stdio with a SAFE environment and drive it with the
// official v2 client. Never points at the live shared map.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export const MCP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(MCP_ROOT, "..");
export const SERVER = path.join(MCP_ROOT, "src", "server.ts");
export const DEMO_MAP = path.join(REPO_ROOT, "tests", "fixtures", "demo.map");

const FORBIDDEN_ORIGIN = /activationlayer\.org/i;

/** Environment for a test server: no live origin, offline fonts, tmp output, test hooks on. */
export function safeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "tupaia-mcp-test-"));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? os.homedir(),
    TUPAIA_MODE: "local",
    TUPAIA_LIVE_ORIGIN: "none",
    TUPAIA_OUT: out,
    TUPAIA_OFFLINE: "1",
    TUPAIA_TEST_HOOKS: "1",
    ...extra
  };
  for (const k of ["PLAYWRIGHT_BROWSERS_PATH", "TUPAIA_DEBUG"]) if (process.env[k]) env[k] = process.env[k] as string;
  if (FORBIDDEN_ORIGIN.test(env.TUPAIA_LIVE_ORIGIN) || FORBIDDEN_ORIGIN.test(env.TUPAIA_DIST ?? "")) {
    throw new Error(`refusing to run tests against ${env.TUPAIA_LIVE_ORIGIN}: tests never touch the live shared map`);
  }
  if (env.TUPAIA_MODE === "live" && FORBIDDEN_ORIGIN.test(env.TUPAIA_LIVE_ORIGIN))
    throw new Error("live tests are forbidden");
  return env;
}

export interface ToolCallResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: Record<string, unknown>;
}

export interface Harness {
  client: Client;
  transport: StdioClientTransport;
  pid: number;
  env: Record<string, string>;
  stderr: string[];
  protocolErrors: unknown[];
  call(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<ToolCallResult>;
  /** JSON body of a successful call (throws with the error text otherwise). */
  ok(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function startServer(extraEnv: Record<string, string> = {}): Promise<Harness> {
  const env = safeEnv(extraEnv);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env,
    cwd: MCP_ROOT,
    stderr: "pipe"
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (d: Buffer) => {
    const s = d.toString();
    stderr.push(s);
    if (process.env.TUPAIA_TEST_VERBOSE) process.stderr.write(s);
  });
  const client = new Client({ name: "tupaia-mcp-test", version: "0.0.0" });
  const protocolErrors: unknown[] = [];
  client.onerror = e => protocolErrors.push(e);
  await client.connect(transport);
  const pid = transport.pid ?? -1;
  const call = async (name: string, args: Record<string, unknown> = {}, timeoutMs = 180_000) =>
    (await client.callTool({ name, arguments: args }, { timeout: timeoutMs })) as ToolCallResult;
  const ok = async (name: string, args: Record<string, unknown> = {}, timeoutMs = 180_000) => {
    const r = await call(name, args, timeoutMs);
    const text = textOf(r);
    if (r.isError) throw new Error(`${name} failed: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
  };
  return {
    client,
    transport,
    pid,
    env,
    stderr,
    protocolErrors,
    call,
    ok,
    close: async () => {
      await client.close().catch(() => {});
    }
  };
}

export function textOf(r: ToolCallResult): string {
  return r.content
    .filter(c => c.type === "text")
    .map(c => c.text ?? "")
    .join("\n");
}

/** The JSON line of an error result (second line onwards). */
export function errorBody(
  r: ToolCallResult
): { error: { code: string; message: string; candidates?: Array<{ i: unknown; name: string }> } } & Record<
  string,
  unknown
> {
  const text = textOf(r);
  const nl = text.lastIndexOf("\n{");
  return JSON.parse(nl >= 0 ? text.slice(nl + 1) : text);
}

/** PIDs of chrome/headless-shell processes descended from `rootPid`. */
export function chromeDescendants(rootPid: number): number[] {
  let out: string;
  try {
    out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const rows = out
    .split("\n")
    .map(l => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
  const kids = new Map<number, number[]>();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid]);
  const seen = new Set<number>();
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop() as number;
    for (const k of kids.get(p) ?? [])
      if (!seen.has(k)) {
        seen.add(k);
        stack.push(k);
      }
  }
  return rows.filter(r => seen.has(r.pid) && /chrom|headless/i.test(r.cmd)).map(r => r.pid);
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(cond: () => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise(r => setTimeout(r, stepMs));
  }
  return cond();
}

/** Width/height of a JPEG or PNG from its bytes. */
export function imageSize(buf: Buffer): { width: number; height: number; type: "png" | "jpeg" } {
  if (buf.readUInt32BE(0) === 0x89504e47)
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: "png" };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o < buf.length) {
      if (buf[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = buf[o + 1];
      const len = buf.readUInt16BE(o + 2);
      if (marker >= 0xc0 && marker <= 0xc3)
        return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7), type: "jpeg" };
      o += 2 + len;
    }
  }
  throw new Error("unknown image format");
}

/**
 * Spawn the server raw (no SDK client) and check that EVERY stdout line is a JSON-RPC
 * message, across initialize, tools/list and the given tool calls.
 */
export async function rawStdoutCheck(
  calls: Array<{ name: string; arguments: Record<string, unknown> }>,
  extraEnv: Record<string, string> = {}
): Promise<{ lines: string[]; bad: string[]; responses: Array<Record<string, unknown>> }> {
  const env = safeEnv(extraEnv);
  const child = spawn(process.execPath, [SERVER], { env, cwd: MCP_ROOT, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", () => {});
  const lines: string[] = [];
  const bad: string[] = [];
  const responses: Array<Record<string, unknown>> = [];
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
      if (!line.trim()) continue;
      lines.push(line);
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.jsonrpc !== "2.0") bad.push(line.slice(0, 200));
        if (typeof msg.id === "number" && pending.has(msg.id)) {
          responses.push(msg);
          pending.get(msg.id)?.(msg);
          pending.delete(msg.id);
        }
      } catch {
        bad.push(line.slice(0, 200));
      }
    }
  });
  let id = 0;
  const rpc = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>(resolve => {
      const myId = ++id;
      pending.set(myId, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: myId, method, params })}\n`);
    });
  await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "raw", version: "0" }
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  await rpc("tools/list", {});
  for (const c of calls) await rpc("tools/call", c);
  const exited = new Promise<void>(r => child.on("exit", () => r()));
  child.stdin.end();
  await Promise.race([exited, new Promise(r => setTimeout(r, 8000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
  if (buf.trim()) bad.push(`(unterminated) ${buf.slice(0, 200)}`);
  return { lines, bad, responses };
}
