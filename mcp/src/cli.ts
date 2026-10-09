// tupaia: command-line client for the shared tupaia-mcp daemon (`server.ts --http`). Run it as
// mcp/bin/tupaia. One daemon serves one TUPAIA_OUT; it is found through $TUPAIA_OUT/daemon.json.
// Node built-ins only (no new dependencies), and nothing heavy is imported: this runs per call.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Config, loadConfig } from "./config.ts";
import {
  type DaemonState,
  daemonRequest,
  LOG_FILE,
  pidAlive,
  publicState,
  readState,
  removeStateIfOwned,
  START_LOCK
} from "./daemon-state.ts";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.ts");
const START_WAIT_MS = 30_000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

const USAGE = `tupaia: drive the shared tupaia-mcp daemon (one browser and page for every caller)

  tupaia call <tool> [<json>|-]   run a tool; args as JSON (or - for stdin; default {}).
                                  Prints the result text, then 'IMAGE: <path>' per image
                                  (saved under $TUPAIA_OUT/shots). Exit 1 when the tool fails.
                                  Starts a daemon if none runs.
  tupaia tools [--names]          list the tools (name + summary, or names only)
  tupaia status                   is a daemon running for this TUPAIA_OUT? (exit 1 if not)
  tupaia start                    start a daemon (detached; log: $TUPAIA_OUT/daemon.log)
  tupaia stop                     stop it (waits for a running call, up to 15 s)
  tupaia headers                  print {"Authorization":"Bearer ..."} (Claude Code headersHelper);
                                  starts a daemon if none runs

Options:
  --json          machine-readable output (call: the raw {isError,text[],images[]})
  --timeout <ms>  call budget once the call starts (500..300000; default per tool)
  --port <n>      port for a daemon this command starts (default TUPAIA_HTTP_PORT, else any free port)
  --out <dir>     same as TUPAIA_OUT=<dir>: which daemon (one per output directory)

Environment: TUPAIA_OUT picks the daemon and where files go; TUPAIA_MODE and the other TUPAIA_*
variables apply when this command starts the daemon (the mode never changes afterwards);
TUPAIA_HTTP_IDLE_MIN (default 120, 0 = never) stops an idle daemon.
Exit codes: 0 ok, 1 the tool returned an error (or status: not running), 2 usage or daemon error.`;

class CliError extends Error {}

interface Opts {
  json: boolean;
  names: boolean;
  help: boolean;
  timeout?: number;
  port?: string;
  out?: string;
  positional: string[];
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = { json: false, names: false, help: false, positional: [] };
  const value = (i: number, name: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new CliError(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const take = (): string => {
      if (inline !== undefined) return inline;
      i++;
      return value(i - 1, flag);
    };
    if (flag === "--json") o.json = true;
    else if (flag === "--names") o.names = true;
    else if (flag === "-h" || flag === "--help") o.help = true;
    else if (flag === "--timeout") {
      const n = Number(take());
      if (!Number.isFinite(n) || n <= 0) throw new CliError("--timeout needs a number of ms");
      o.timeout = Math.round(n);
    } else if (flag === "--port") o.port = take();
    else if (flag === "--out") o.out = take();
    else if (a.startsWith("--") && a.length > 2) throw new CliError(`unknown option ${a}`);
    else o.positional.push(a);
  }
  return o;
}

const out = (s: string) => process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
const note = (s: string) => process.stderr.write(`tupaia: ${s}\n`);

type Health = Record<string, unknown> & { mode?: string; repoRoot?: string; pid?: number };
type Probe = { health: Health } | { err: "refused" | "unauthorized" | "timeout" | "other"; detail: string };

async function probe(st: DaemonState, timeoutMs = 3000): Promise<Probe> {
  try {
    const r = await daemonRequest(st.port, st.token, "GET", "/health", undefined, timeoutMs);
    if (r.status === 200) return { health: JSON.parse(r.body) as Health };
    return { err: r.status === 401 ? "unauthorized" : "other", detail: `HTTP ${r.status} ${r.body.slice(0, 200)}` };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED") return { err: "refused", detail: "nothing listens on its port" };
    if (code === "ETIMEDOUT") return { err: "timeout", detail: (e as Error).message };
    return { err: "other", detail: (e as Error).message };
  }
}

interface Found {
  st: DaemonState;
  health: Health;
}

/** The daemon serving cfg.outDir, or null. A stale state file (dead pid, nothing listening) is removed. */
async function findDaemon(cfg: Config, quiet = false): Promise<Found | null> {
  const st = readState(cfg.outDir);
  if (!st) return null;
  if (!pidAlive(st.pid)) {
    removeStateIfOwned(cfg.outDir, st.pid);
    if (!quiet) note(`removed a stale state file (daemon pid ${st.pid} is gone)`);
    return null;
  }
  const p = await probe(st);
  if ("health" in p && p.health.pid === st.pid) return { st, health: p.health };
  if ("health" in p || p.err === "refused" || p.err === "unauthorized") {
    // nothing listens there, or another daemon (with another token) took the port over
    removeStateIfOwned(cfg.outDir, st.pid);
    if (!quiet) note(`removed a stale state file (pid ${st.pid} is alive but is not a daemon on port ${st.port})`);
    return null;
  }
  throw new CliError(`daemon pid ${st.pid} (${st.url}) does not answer: ${p.detail}. Try 'tupaia stop'.`);
}

function rotateLog(file: string): void {
  try {
    if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // no log yet
  }
}

/** Take the start lock (exclusive create); null when another caller holds it (then wait for theirs). */
function tryLock(file: string): number | null {
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    return fd;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    try {
      const held = JSON.parse(fs.readFileSync(file, "utf8")) as { pid: number; at: number };
      if (!pidAlive(held.pid) || Date.now() - held.at > START_WAIT_MS + 10_000) fs.unlinkSync(file);
    } catch {
      // unreadable or just removed: retry
    }
    return null;
  }
}

async function startDaemon(cfg: Config, opts: Opts): Promise<Found> {
  const lockFile = path.join(cfg.outDir, START_LOCK);
  const deadline = Date.now() + START_WAIT_MS + 15_000;
  let fd = tryLock(lockFile);
  while (fd === null) {
    if (Date.now() > deadline) throw new CliError(`timed out waiting for ${lockFile} (another start in progress)`);
    await new Promise(r => setTimeout(r, 200));
    if (!fs.existsSync(lockFile)) {
      // the other caller finished starting one
      const found = await findDaemon(cfg, true);
      if (found) return found;
    }
    fd = tryLock(lockFile);
  }
  try {
    const again = await findDaemon(cfg, true);
    if (again) return again;
    const logFile = path.join(cfg.outDir, LOG_FILE);
    rotateLog(logFile);
    const log = fs.openSync(logFile, "a");
    const port = opts.port ?? process.env.TUPAIA_HTTP_PORT;
    const args = [SERVER, "--http", ...(port ? ["--port", port] : [])];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, TUPAIA_OUT: cfg.outDir },
      cwd: cfg.mcpRoot
    });
    fs.closeSync(log);
    let exited: number | null = null;
    child.on("exit", code => {
      exited = code ?? -1;
    });
    child.unref();
    const end = Date.now() + START_WAIT_MS;
    while (Date.now() < end) {
      await new Promise(r => setTimeout(r, 100));
      if (exited !== null) {
        const tail = fs.readFileSync(logFile, "utf8").trim().split("\n").slice(-5).join("\n");
        throw new CliError(`the daemon exited during start (code ${exited}). ${logFile}:\n${tail}`);
      }
      const st = readState(cfg.outDir);
      if (st && st.pid === child.pid) {
        const p = await probe(st);
        if ("health" in p) {
          note(
            `started a daemon: pid ${st.pid}, ${st.url}/mcp, mode ${st.mode}, TUPAIA_OUT ${cfg.outDir} (log ${logFile})`
          );
          return { st, health: p.health };
        }
      }
    }
    throw new CliError(`the daemon did not come up within ${START_WAIT_MS / 1000} s; see ${logFile}`);
  } finally {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // already gone
    }
  }
}

/** Warn (never restart) when the daemon differs from what this caller's environment asks for. */
export function mismatchWarnings(
  caller: { envMode: string; repoRoot: string; port?: string },
  daemon: { pid: number; port: number; mode: string; repoRoot?: string }
): string[] {
  const w: string[] = [];
  if (daemon.mode !== caller.envMode)
    w.push(
      `warning: the running daemon (pid ${daemon.pid}) is in ${daemon.mode} mode but your environment asks for ${caller.envMode}; it is NOT restarted. The mode is fixed when a daemon starts: 'tupaia stop' first to change it.`
    );
  if (daemon.repoRoot && daemon.repoRoot !== caller.repoRoot)
    w.push(`warning: the daemon runs from ${daemon.repoRoot}, not ${caller.repoRoot}; its tools may differ`);
  if (caller.port && Number(caller.port) && Number(caller.port) !== daemon.port)
    w.push(`note: the running daemon listens on port ${daemon.port}, not ${caller.port}`);
  return w;
}

function warnMismatch(cfg: Config, f: Found, opts: Opts): void {
  const daemon = {
    pid: f.st.pid,
    port: f.st.port,
    mode: String(f.health.mode ?? f.st.mode),
    repoRoot: f.health.repoRoot
  };
  for (const w of mismatchWarnings({ envMode: cfg.envMode, repoRoot: cfg.repoRoot, port: opts.port }, daemon)) note(w);
}

async function ensureDaemon(cfg: Config, opts: Opts): Promise<Found> {
  const found = await findDaemon(cfg);
  if (found) {
    warnMismatch(cfg, found, opts);
    return found;
  }
  note(`no daemon serves ${cfg.outDir}; starting one`);
  return startDaemon(cfg, opts);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function cmdCall(cfg: Config, opts: Opts): Promise<number> {
  const [, tool, raw] = opts.positional;
  if (!tool) throw new CliError("usage: tupaia call <tool> [<json>|-]");
  if (opts.positional.length > 3) throw new CliError("too many arguments: quote the JSON as one argument");
  const text = raw === "-" ? await readStdin() : (raw ?? "");
  let args: unknown = {};
  if (text.trim()) {
    try {
      args = JSON.parse(text);
    } catch (e) {
      throw new CliError(`arguments are not JSON: ${(e as Error).message}`);
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new CliError("arguments must be a JSON object");
  }
  const f = await ensureDaemon(cfg, opts);
  let r: { status: number; body: string };
  try {
    r = await daemonRequest(f.st.port, f.st.token, "POST", "/call", { name: tool, args, timeoutMs: opts.timeout }, 0);
  } catch (e) {
    throw new CliError(`the daemon connection failed during the call: ${(e as Error).message}`);
  }
  if (r.status !== 200) throw new CliError(`daemon answered HTTP ${r.status}: ${r.body.slice(0, 500)}`);
  const res = JSON.parse(r.body) as { isError: boolean; text: string[]; images: string[] };
  if (opts.json) out(JSON.stringify(res));
  else {
    for (const t of res.text) out(t);
    for (const i of res.images) out(`IMAGE: ${i}`);
  }
  return res.isError ? 1 : 0;
}

async function cmdTools(cfg: Config, opts: Opts): Promise<number> {
  const f = await ensureDaemon(cfg, opts);
  const r = await daemonRequest(f.st.port, f.st.token, "GET", "/tools", undefined, 15_000);
  if (r.status !== 200) throw new CliError(`daemon answered HTTP ${r.status}: ${r.body.slice(0, 500)}`);
  const { tools } = JSON.parse(r.body) as { tools: Array<{ name: string; description?: string }> };
  if (opts.json) out(JSON.stringify({ tools }));
  else if (opts.names) for (const t of tools) out(t.name);
  else {
    const w = Math.max(...tools.map(t => t.name.length));
    for (const t of tools) {
      const first = (t.description ?? "").split(/(?<=\.)\s/)[0];
      out(`${t.name.padEnd(w)}  ${first.length > 110 ? `${first.slice(0, 107)}...` : first}`);
    }
  }
  return 0;
}

async function cmdStatus(cfg: Config, opts: Opts): Promise<number> {
  const f = await findDaemon(cfg);
  if (!f) {
    if (opts.json) out(JSON.stringify({ running: false, outDir: cfg.outDir }));
    else out(`not running (TUPAIA_OUT ${cfg.outDir})`);
    return 1;
  }
  warnMismatch(cfg, f, opts);
  const h = f.health;
  if (opts.json) out(JSON.stringify({ running: true, ...publicState(f.st), health: h }));
  else {
    const idle = Number(h.idleMin) ? `idle shutdown after ${h.idleMin} min (idle ${h.idleS} s)` : "no idle shutdown";
    out(
      `running: pid ${f.st.pid}, ${f.st.url}/mcp, mode ${h.mode}, browser ${h.browser}, ${h.active} active request(s), up ${h.uptimeS} s, ${idle}`
    );
    out(`version ${f.st.version}, app ${f.st.appVersion ?? "?"}, TUPAIA_OUT ${cfg.outDir}, repo ${h.repoRoot}`);
  }
  return 0;
}

async function cmdStart(cfg: Config, opts: Opts): Promise<number> {
  const found = await findDaemon(cfg);
  if (found) {
    warnMismatch(cfg, found, opts);
    out(`already running: pid ${found.st.pid}, ${found.st.url}/mcp, mode ${found.health.mode}`);
    return 0;
  }
  const f = await startDaemon(cfg, opts);
  out(`started: pid ${f.st.pid}, ${f.st.url}/mcp, mode ${f.st.mode}`);
  return 0;
}

function looksLikeOurDaemon(pid: number): boolean {
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return cmd.includes("server.ts") && cmd.includes("--http");
  } catch {
    return false;
  }
}

async function cmdStop(cfg: Config): Promise<number> {
  const st = readState(cfg.outDir);
  if (!st || !pidAlive(st.pid)) {
    if (st) removeStateIfOwned(cfg.outDir, st.pid);
    out(`not running (TUPAIA_OUT ${cfg.outDir})`);
    return 0;
  }
  let asked = false;
  try {
    const r = await daemonRequest(st.port, st.token, "POST", "/shutdown", {}, 5000);
    asked = r.status === 200;
  } catch {
    asked = false;
  }
  if (!asked) {
    if (!looksLikeOurDaemon(st.pid)) {
      removeStateIfOwned(cfg.outDir, st.pid);
      out(`not running (pid ${st.pid} is not a tupaia daemon; removed the stale state file)`);
      return 0;
    }
    process.kill(st.pid, "SIGTERM");
  }
  const end = Date.now() + 30_000;
  while (pidAlive(st.pid) && Date.now() < end) await new Promise(r => setTimeout(r, 100));
  if (pidAlive(st.pid)) throw new CliError(`daemon pid ${st.pid} did not exit within 30 s`);
  removeStateIfOwned(cfg.outDir, st.pid);
  out(`stopped: pid ${st.pid}`);
  return 0;
}

async function cmdHeaders(cfg: Config, opts: Opts): Promise<number> {
  // Claude Code passes the registered URL; a daemon started here must listen on its port.
  if (!opts.port && process.env.CLAUDE_CODE_MCP_SERVER_URL) {
    try {
      const u = new URL(process.env.CLAUDE_CODE_MCP_SERVER_URL);
      if (u.port) opts.port = u.port;
    } catch {
      // not a URL: ignore
    }
  }
  const f = await ensureDaemon(cfg, opts);
  if (opts.port && Number(opts.port) && Number(opts.port) !== f.st.port)
    throw new CliError(
      `the daemon for ${cfg.outDir} listens on port ${f.st.port}, but this server is registered at port ${opts.port}: stop it (tupaia stop) or give the registration its own TUPAIA_OUT`
    );
  out(JSON.stringify({ Authorization: `Bearer ${f.st.token}` }));
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let opts: Opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    note((e as Error).message);
    return 2;
  }
  const cmd = opts.positional[0];
  if (opts.help || !cmd || cmd === "help") {
    out(USAGE);
    return cmd || opts.help ? 0 : 2;
  }
  if (opts.out) process.env.TUPAIA_OUT = path.resolve(opts.out);
  const cfg = loadConfig(process.env);
  try {
    if (cmd === "call") return await cmdCall(cfg, opts);
    if (cmd === "tools") return await cmdTools(cfg, opts);
    if (cmd === "status") return await cmdStatus(cfg, opts);
    if (cmd === "start") return await cmdStart(cfg, opts);
    if (cmd === "stop") return await cmdStop(cfg);
    if (cmd === "headers") return await cmdHeaders(cfg, opts);
    note(`unknown command '${cmd}' (tupaia --help)`);
    return 2;
  } catch (e) {
    note(e instanceof CliError ? e.message : ((e as Error).stack ?? String(e)));
    return 2;
  }
}
