// The --http daemon's state file, shared by the daemon (http.ts) and the CLI (cli.ts).
// $TUPAIA_OUT/daemon.json (mode 0600) says which daemon serves that output directory: its pid,
// port, mode and bearer token. One daemon per TUPAIA_OUT. Keep this module free of heavy imports:
// the CLI loads it on every call.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Mode } from "./config.ts";

export const STATE_FILE = "daemon.json";
export const LOG_FILE = "daemon.log";
/** Held by a CLI while it starts a daemon, so concurrent callers never start two. */
export const START_LOCK = "daemon.start.lock";

export interface DaemonState {
  pid: number;
  port: number;
  /** http://127.0.0.1:<port> (MCP at <url>/mcp). */
  url: string;
  /** Mode from the daemon's spawn environment (TUPAIA_MODE); /health reports the current one. */
  mode: Mode;
  startedAt: string;
  /** tupaia-mcp package version. */
  version: string;
  /** VERSION of the built app (dist/versioning.js), or null. */
  appVersion: string | null;
  /** Repo (or worktree) root whose mcp/src/server.ts runs the daemon. */
  repoRoot: string;
  outDir: string;
  /** Idle shutdown after this many minutes without a call (0 = never). */
  idleMin: number;
  /** Bearer token for every request. Random per daemon start. */
  token: string;
}

export function statePath(outDir: string): string {
  return path.join(outDir, STATE_FILE);
}

export function readState(outDir: string): DaemonState | null {
  try {
    const v = JSON.parse(fs.readFileSync(statePath(outDir), "utf8")) as DaemonState;
    if (!v || typeof v.pid !== "number" || typeof v.port !== "number" || typeof v.token !== "string") return null;
    return v;
  } catch {
    return null;
  }
}

/** Atomic write (temp file + rename), owner read/write only. */
export function writeState(outDir: string, st: DaemonState): void {
  const file = statePath(outDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(st, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** Remove the state file if it still names `pid` (a newer daemon's file is left alone). */
export function removeStateIfOwned(outDir: string, pid: number): void {
  const st = readState(outDir);
  if (st && st.pid !== pid) return;
  try {
    fs.unlinkSync(statePath(outDir));
  } catch {
    // already gone
  }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: gone. EPERM: the pid was reused by another user's process, so not our daemon.
    return false;
  }
}

export interface DaemonReply {
  status: number;
  body: string;
}

/**
 * One request to a daemon on 127.0.0.1:<port> with its bearer token. `timeoutMs` 0 waits as long
 * as the daemon takes (tool calls queue behind each other). Rejects on connection errors
 * (err.code ECONNREFUSED when nothing listens) and on timeout (err.code ETIMEDOUT).
 */
export function daemonRequest(
  port: number,
  token: string,
  method: string,
  pathname: string,
  body?: unknown,
  timeoutMs = 0
): Promise<DaemonReply> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: pathname,
        headers: {
          authorization: `Bearer ${token}`,
          ...(data ? { "content-type": "application/json", "content-length": data.length } : {})
        }
      },
      res => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        const e = new Error(`no answer from 127.0.0.1:${port} within ${timeoutMs} ms`) as NodeJS.ErrnoException;
        e.code = "ETIMEDOUT";
        req.destroy(e);
      });
    }
    req.end(data);
  });
}

/** GET /health of a daemon, or null when it does not answer as one. */
export async function probeHealth(
  st: Pick<DaemonState, "port" | "token">,
  timeoutMs = 2000
): Promise<Record<string, unknown> | null> {
  try {
    const r = await daemonRequest(st.port, st.token, "GET", "/health", undefined, timeoutMs);
    if (r.status !== 200) return null;
    const v = JSON.parse(r.body) as Record<string, unknown>;
    return v && v.ok === true ? v : null;
  } catch {
    return null;
  }
}

/** The state without its token (for printing). */
export function publicState(st: DaemonState): Omit<DaemonState, "token"> {
  const { token: _token, ...rest } = st;
  return rest;
}
