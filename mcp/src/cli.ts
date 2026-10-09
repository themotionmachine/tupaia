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
  LAST_FILE,
  type LastExit,
  LOG_FILE,
  pidAlive,
  publicState,
  readPortPref,
  readStartLock,
  readState,
  removeStateIfOwned,
  START_LOCK,
  writePortPref
} from "./daemon-state.ts";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.ts");
/** How long a start may take (Node start-up and module loading; slow on a loaded machine). */
const START_WAIT_MS = positiveInt(process.env.TUPAIA_START_TIMEOUT_MS) ?? 90_000;
/** First progress line on stderr for a slow call or start, then every 2x this. */
const HEARTBEAT_MS = positiveInt(process.env.TUPAIA_CLI_HEARTBEAT_MS) ?? 15_000;
/** How long to wait for a daemon that is shutting down (it drains its call and saves its page). */
const EXIT_WAIT_MS = 45_000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

/** Input-file arguments: a relative path that exists from the caller's cwd is made absolute. */
const INPUT_PATHS: Record<string, string[][]> = {
  load_map: [["path"]],
  sketch: [["onto", "path"]]
};

const USAGE = `tupaia: drive the shared tupaia-mcp daemon (one browser and page for every caller)

  tupaia call <tool> [<json>|-]   run a tool; args as JSON (or - for stdin; default {}).
                                  Prints the result text, then 'IMAGE: <path>' per image
                                  (saved under $TUPAIA_OUT/shots). A failed tool prints
                                  'ERROR CODE: message' and exits 1. Starts a daemon if none runs.
  tupaia tools [<tool>] [--names] list the tools; with a name: its description and arguments
  tupaia help <tool>              same as tupaia tools <tool>
  tupaia status                   is a daemon running for this TUPAIA_OUT? (exit 1 if not)
  tupaia start                    start a daemon (detached; log: $TUPAIA_OUT/daemon.log)
  tupaia stop                     stop it (it finishes a running call, saves a changed page to
                                  $TUPAIA_OUT/maps/daemon-exit-*.map, then exits)
  tupaia headers                  print {"Authorization":"Bearer ..."} (Claude Code headersHelper);
                                  makes the daemon serve the registered port; starts one if needed

Options:
  --json          machine-readable output (call: the raw {isError,text[],images[]})
  --timeout <ms>  call budget once the call starts (500..300000; default per tool)
  --port <n>      port for a daemon this command starts (default TUPAIA_HTTP_PORT, else the port
                  this TUPAIA_OUT's daemon used last, else any free port)
  --out <dir>     same as TUPAIA_OUT=<dir>: which daemon (one per output directory)

Environment: TUPAIA_OUT picks the daemon and where files go; TUPAIA_MODE and the other TUPAIA_*
variables apply when this command starts the daemon (the mode never changes afterwards);
TUPAIA_HTTP_IDLE_MIN (default 120, 0 = never) stops an idle daemon; TUPAIA_START_TIMEOUT_MS
(default 90000) bounds a start; TUPAIA_CALLER names you in daemon.log.
Relative paths: load_map {path} is taken from your cwd when the file is there (else the repo
root); save_map and export write relative paths under TUPAIA_OUT.
Exit codes: 0 ok, 1 the tool returned an error (or status: not running), 2 usage or daemon error.`;

class CliError extends Error {}

function positiveInt(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

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
    } else if (flag === "--port") {
      const p = take();
      const n = Number(p);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new CliError(`--port '${p}' is not 1..65535`);
      o.port = String(n);
    } else if (flag === "--out") o.out = take();
    else if (a.startsWith("--") && a.length > 2) throw new CliError(`unknown option ${a}`);
    else o.positional.push(a);
  }
  return o;
}

const out = (s: string) => process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
const note = (s: string) => process.stderr.write(`tupaia: ${s}\n`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const mcpUrlOf = (st: DaemonState) => st.mcpUrl ?? `${st.url}/mcp`;

type Health = Record<string, unknown> & { mode?: string; repoRoot?: string; pid?: number; active?: number };
type Probe = { health: Health } | { err: "refused" | "unauthorized" | "timeout" | "other"; detail: string };

async function probe(st: DaemonState, timeoutMs = 5000): Promise<Probe> {
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

/** Wait for a daemon that is shutting down to exit (it finishes its call and saves its page). */
async function waitExit(cfg: Config, st: DaemonState, quiet: boolean): Promise<void> {
  if (!quiet) note(`daemon pid ${st.pid} is shutting down (${st.closing ?? "stopping"}); waiting for it to exit`);
  const end = Date.now() + EXIT_WAIT_MS;
  while (pidAlive(st.pid) && Date.now() < end) await sleep(150);
  if (pidAlive(st.pid))
    throw new CliError(`daemon pid ${st.pid} is still shutting down after ${EXIT_WAIT_MS / 1000} s`);
  removeStateIfOwned(cfg.outDir, st.pid);
}

/**
 * The daemon serving cfg.outDir, or null. A stale state file (dead pid, nothing listening, a
 * port that rejects the token) is removed; a daemon that is shutting down is waited for.
 */
async function findDaemon(cfg: Config, quiet = false): Promise<Found | null> {
  const st = readState(cfg.outDir);
  if (!st) return null;
  if (!pidAlive(st.pid)) {
    removeStateIfOwned(cfg.outDir, st.pid);
    if (!quiet) note(`removed a stale state file (daemon pid ${st.pid} is gone)`);
    return null;
  }
  if (st.closing) {
    await waitExit(cfg, st, quiet);
    return null;
  }
  const p = await probe(st);
  if ("health" in p && p.health.pid === st.pid) return { st, health: p.health };
  // a stop that began after the read above: the file now says so
  const now = readState(cfg.outDir);
  if (now?.pid === st.pid && now.closing) {
    await waitExit(cfg, now, quiet);
    return null;
  }
  if ("health" in p || p.err === "refused" || p.err === "unauthorized") {
    // nothing listens there, or another daemon (with another token) took the port over
    removeStateIfOwned(cfg.outDir, st.pid);
    if (!quiet) note(`removed a stale state file (pid ${st.pid} is alive but is not a daemon on port ${st.port})`);
    return null;
  }
  throw new CliError(`daemon pid ${st.pid} (${mcpUrlOf(st)}) does not answer: ${p.detail}. Try 'tupaia stop'.`);
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
      if (!pidAlive(held.pid) || Date.now() - held.at > START_WAIT_MS + 20_000) fs.unlinkSync(file);
    } catch {
      // unreadable or just removed: retry
    }
    return null;
  }
}

/** Where a daemon this command starts listens: an asked port is strict, a remembered one is a preference. */
function startPort(cfg: Config, opts: Opts): { port?: number; strict: boolean } {
  const asked = opts.port ?? process.env.TUPAIA_HTTP_PORT;
  if (asked && Number(asked)) return { port: Number(asked), strict: true };
  const pref = readPortPref(cfg.outDir);
  return pref ? { port: pref.port, strict: false } : { strict: false };
}

/** Elapsed-time lines on stderr while something slow runs (first after HEARTBEAT_MS, then every 2x). */
function heartbeat(what: () => Promise<string> | string): () => void {
  const t0 = Date.now();
  let timer: NodeJS.Timeout;
  const tick = async () => {
    const s = Math.round((Date.now() - t0) / 1000);
    note(`${await Promise.resolve(what()).catch(() => "still waiting")} (${s} s)`);
    timer = setTimeout(tick, HEARTBEAT_MS * 2);
    timer.unref();
  };
  timer = setTimeout(tick, HEARTBEAT_MS);
  timer.unref();
  return () => clearTimeout(timer);
}

async function startDaemon(cfg: Config, opts: Opts): Promise<Found> {
  const lockFile = path.join(cfg.outDir, START_LOCK);
  const deadline = Date.now() + START_WAIT_MS + 30_000;
  let fd = tryLock(lockFile);
  if (fd === null) note(`another caller is starting the daemon for ${cfg.outDir}; waiting for it`);
  while (fd === null) {
    if (Date.now() > deadline) throw new CliError(`timed out waiting for ${lockFile} (another start in progress)`);
    await sleep(200);
    if (!fs.existsSync(lockFile)) {
      // the other caller finished starting one
      const found = await findDaemon(cfg, true);
      if (found) return found;
    }
    fd = tryLock(lockFile);
  }
  let child: ReturnType<typeof spawn> | null = null;
  let up = false;
  try {
    const again = await findDaemon(cfg, true);
    if (again) return again;
    note(`no daemon serves ${cfg.outDir}; starting one`);
    const logFile = path.join(cfg.outDir, LOG_FILE);
    rotateLog(logFile);
    const log = fs.openSync(logFile, "a");
    const where = startPort(cfg, opts);
    const portArgs = where.port ? [where.strict ? "--port" : "--prefer-port", String(where.port)] : [];
    // the daemon runs from mcp/: path variables are made absolute against the caller's cwd
    const env: NodeJS.ProcessEnv = { ...process.env, TUPAIA_OUT: cfg.outDir };
    if (process.env.TUPAIA_DIST) env.TUPAIA_DIST = cfg.distDir;
    child = spawn(process.execPath, [SERVER, "--http", ...portArgs], {
      detached: true,
      stdio: ["ignore", log, log],
      env,
      cwd: cfg.mcpRoot
    });
    fs.closeSync(log);
    const pid = child.pid as number;
    // `status` and `stop` read the lock to see a daemon that is still starting
    fs.ftruncateSync(fd);
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, daemonPid: pid, at: Date.now() }), 0);
    let exited: number | null = null;
    child.on("exit", code => {
      exited = code ?? -1;
    });
    child.unref();
    const stopBeat = heartbeat(() => `the daemon (pid ${pid}) is still starting`);
    try {
      const end = Date.now() + START_WAIT_MS;
      while (Date.now() < end) {
        await sleep(100);
        if (exited !== null) {
          const tail = fs.readFileSync(logFile, "utf8").trim().split("\n").slice(-5).join("\n");
          throw new CliError(`the daemon exited during start (code ${exited}). ${logFile}:\n${tail}`);
        }
        const st = readState(cfg.outDir);
        if (st && st.pid === pid) {
          const p = await probe(st);
          if ("health" in p) {
            up = true;
            writePortPref(cfg.outDir, { port: st.port, registered: false });
            note(
              `started a daemon: pid ${st.pid}, ${mcpUrlOf(st)}, mode ${st.mode}, TUPAIA_OUT ${cfg.outDir} (log ${logFile}). Its page is a fresh random map with no undo history.`
            );
            reportLastExit(cfg);
            return { st, health: p.health };
          }
        }
      }
    } finally {
      stopBeat();
    }
    throw new CliError(
      `the daemon did not come up within ${START_WAIT_MS / 1000} s, so it was stopped; see ${logFile}. On a busy machine raise TUPAIA_START_TIMEOUT_MS.`
    );
  } finally {
    // never leave a half-started daemon behind (the next caller would race it)
    if (!up && child?.pid && pidAlive(child.pid)) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // gone
      }
    }
    fs.closeSync(fd);
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // already gone
    }
  }
}

/** The previous daemon saved its page when it stopped: say where (once). */
function reportLastExit(cfg: Config): void {
  const file = path.join(cfg.outDir, LAST_FILE);
  try {
    const last = JSON.parse(fs.readFileSync(file, "utf8")) as LastExit;
    fs.unlinkSync(file);
    if (last.savedMap && fs.existsSync(last.savedMap))
      note(
        `the previous daemon (pid ${last.pid}) stopped at ${last.at} (${last.reason}) and saved its page to ${last.savedMap}; load_map {"path":"${last.savedMap}"} continues from it`
      );
  } catch {
    // none
  }
}

/** Warn (never restart) when the daemon differs from what this caller's environment asks for. */
export function mismatchWarnings(
  caller: { envMode: string; repoRoot: string; port?: string },
  daemon: { pid: number; port: number; ports?: number[]; mode: string; repoRoot?: string }
): string[] {
  const w: string[] = [];
  if (daemon.mode !== caller.envMode)
    w.push(
      `warning: the running daemon (pid ${daemon.pid}) is in ${daemon.mode} mode but your environment asks for ${caller.envMode}; it is NOT restarted. The mode is fixed when a daemon starts: 'tupaia stop' first to change it.`
    );
  if (daemon.repoRoot && daemon.repoRoot !== caller.repoRoot)
    w.push(`warning: the daemon runs from ${daemon.repoRoot}, not ${caller.repoRoot}; its tools may differ`);
  const ports = daemon.ports ?? [daemon.port];
  if (caller.port && Number(caller.port) && !ports.includes(Number(caller.port)))
    w.push(`note: the running daemon listens on port ${ports.join(", ")}, not ${caller.port}`);
  return w;
}

function warnMismatch(cfg: Config, f: Found, opts: Opts): void {
  const daemon = {
    pid: f.st.pid,
    port: f.st.port,
    ports: f.st.ports,
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
  return startDaemon(cfg, opts);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Make relative input-file arguments absolute when the file exists from the caller's cwd. */
export function absolutizeInputs(tool: string, args: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const specs = INPUT_PATHS[tool];
  if (!specs) return args;
  const copy = structuredClone(args);
  for (const keys of specs) {
    let obj: unknown = copy;
    for (const k of keys.slice(0, -1))
      obj = obj && typeof obj === "object" ? (obj as Record<string, unknown>)[k] : null;
    const last = keys[keys.length - 1];
    if (!obj || typeof obj !== "object") continue;
    const rec = obj as Record<string, unknown>;
    const v = rec[last];
    if (typeof v !== "string" || !v || path.isAbsolute(v)) continue;
    const abs = path.resolve(cwd, v);
    if (fs.existsSync(abs)) rec[last] = abs;
  }
  return copy;
}

type CallReply = { isError: boolean; text: string[]; images: string[] };

/** Human output of a tool result: the text, or for a failure 'ERROR CODE: message' plus what else the error says. */
export function formatResult(res: CallReply): string[] {
  const lines: string[] = [];
  if (!res.isError) {
    lines.push(...res.text);
  } else {
    for (const t of res.text) {
      // errors are "CODE: message[\ncandidates: ...]\n{json}": print the message once
      const nl = t.lastIndexOf("\n{");
      if (nl < 0) {
        lines.push(`ERROR ${t}`);
        continue;
      }
      lines.push(`ERROR ${t.slice(0, nl)}`);
      try {
        const body = JSON.parse(t.slice(nl + 1)) as { error?: Record<string, unknown> } & Record<string, unknown>;
        const { code: _c, message: _m, candidates: _cand, ...restErr } = body.error ?? {};
        const rest: Record<string, unknown> = { ...body };
        delete rest.error;
        if (Object.keys(restErr).length) rest.error = restErr;
        if (Array.isArray(_cand) && _cand.length > 8) rest.candidates = _cand;
        for (const k of Object.keys(rest)) {
          const v = rest[k];
          if (v === undefined || (Array.isArray(v) && v.length === 0)) delete rest[k];
        }
        if (Object.keys(rest).length) lines.push(JSON.stringify(rest));
      } catch {
        lines.push(t.slice(nl + 1));
      }
    }
  }
  for (const i of res.images) lines.push(`IMAGE: ${i}`);
  return lines;
}

async function cmdCall(cfg: Config, opts: Opts): Promise<number> {
  const [, tool, raw] = opts.positional;
  if (!tool) throw new CliError("usage: tupaia call <tool> [<json>|-]");
  if (opts.positional.length > 3) throw new CliError("too many arguments: quote the JSON as one argument");
  const text = raw === "-" ? await readStdin() : (raw ?? "");
  let args: Record<string, unknown> = {};
  if (text.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new CliError(`arguments are not JSON: ${(e as Error).message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new CliError("arguments must be a JSON object");
    args = absolutizeInputs(tool, parsed as Record<string, unknown>, process.cwd());
  }
  const caller =
    process.env.TUPAIA_CALLER || `pid ${process.pid} in …/${process.cwd().split(path.sep).slice(-2).join("/")}`;
  let f = await ensureDaemon(cfg, opts);
  for (let attempt = 0; ; attempt++) {
    const st = f.st;
    const stopBeat = heartbeat(async () => {
      const h = await probe(st, 3000);
      const n = "health" in h ? Number(h.health.active ?? 0) : 0;
      return `${tool} is still queued or running (the daemon has ${n} request(s) in progress)`;
    });
    let r: { status: number; body: string };
    try {
      r = await daemonRequest(
        st.port,
        st.token,
        "POST",
        "/call",
        { name: tool, args, timeoutMs: opts.timeout, caller },
        0
      );
    } catch (e) {
      throw new CliError(`the daemon connection failed during the call: ${(e as Error).message}`);
    } finally {
      stopBeat();
    }
    if (r.status === 503 && attempt === 0) {
      // the daemon began shutting down before this call started: nothing ran
      let closing = false;
      try {
        closing = (JSON.parse(r.body) as { closing?: boolean }).closing === true;
      } catch {
        closing = false;
      }
      if (closing) {
        note(`the daemon shut down before ${tool} started (nothing ran); a fresh daemon runs it`);
        await waitExit(cfg, { ...st, closing: st.closing ?? "stopping" }, true);
        f = await ensureDaemon(cfg, opts);
        continue;
      }
    }
    if (r.status !== 200) throw new CliError(`daemon answered HTTP ${r.status}: ${r.body.slice(0, 500)}`);
    const res = JSON.parse(r.body) as CallReply;
    if (opts.json) out(JSON.stringify(res));
    else for (const line of formatResult(res)) out(line);
    return res.isError ? 1 : 0;
  }
}

type ToolInfo = { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown> };

type JsonSchema = Record<string, unknown>;

/** A JSON schema as a compact TypeScript-like type (depth-limited). */
export function schemaType(s: JsonSchema | undefined, root: JsonSchema, depth = 0, seen: string[] = []): string {
  if (!s || typeof s !== "object" || Object.keys(s).length === 0) return "any";
  if (typeof s.$ref === "string") {
    const name = s.$ref.split("/").pop() ?? "ref";
    if (seen.includes(name)) return name;
    const defs = (root.$defs ?? root.definitions ?? {}) as Record<string, JsonSchema>;
    return schemaType(defs[name], root, depth, [...seen, name]);
  }
  if (Array.isArray(s.enum)) return s.enum.map(v => JSON.stringify(v)).join("|");
  if ("const" in s) return JSON.stringify(s.const);
  const union = (s.anyOf ?? s.oneOf) as JsonSchema[] | undefined;
  if (Array.isArray(union)) {
    const parts = [...new Set(union.map(u => schemaType(u, root, depth, seen)))];
    return parts.join(" | ");
  }
  if (Array.isArray(s.allOf)) return (s.allOf as JsonSchema[]).map(u => schemaType(u, root, depth, seen)).join(" & ");
  const type = Array.isArray(s.type) ? (s.type as string[]).join("|") : (s.type as string | undefined);
  if (type === "array") {
    if (Array.isArray(s.prefixItems))
      return `[${(s.prefixItems as JsonSchema[]).map(u => schemaType(u, root, depth + 1, seen)).join(", ")}]`;
    const item = schemaType(s.items as JsonSchema, root, depth + 1, seen);
    return /[ |&]/.test(item) ? `(${item})[]` : `${item}[]`;
  }
  if (type === "object" || s.properties) {
    const props = (s.properties ?? {}) as Record<string, JsonSchema>;
    const keys = Object.keys(props);
    if (!keys.length) {
      const ap = s.additionalProperties;
      return ap && typeof ap === "object"
        ? `{[key]: ${schemaType(ap as JsonSchema, root, depth + 1, seen)}}`
        : "object";
    }
    if (depth >= 4) return "{...}";
    const req = new Set((s.required ?? []) as string[]);
    return `{${keys.map(k => `${k}${req.has(k) ? "" : "?"}: ${schemaType(props[k], root, depth + 1, seen)}`).join(", ")}}`;
  }
  return type ?? "any";
}

/** One tool's description and arguments, one argument per line. */
export function describeTool(t: ToolInfo): string[] {
  const lines = [`${t.name}${t.title ? ` (${t.title})` : ""}`, "", t.description ?? "", ""];
  const schema = t.inputSchema ?? {};
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const req = new Set((schema.required ?? []) as string[]);
  const keys = Object.keys(props);
  if (!keys.length) lines.push("args: none");
  else {
    lines.push("args:");
    for (const k of keys) {
      const p = props[k];
      const desc = typeof p.description === "string" ? `  # ${p.description}` : "";
      const def = p.default !== undefined ? ` = ${JSON.stringify(p.default)}` : "";
      lines.push(`  ${k}${req.has(k) ? "" : "?"}: ${schemaType(p, schema)}${def}${desc}`);
    }
  }
  return lines;
}

async function cmdTools(cfg: Config, opts: Opts): Promise<number> {
  const want = opts.positional[1];
  if (opts.positional.length > 2) throw new CliError("usage: tupaia tools [<tool>] [--names] [--json]");
  const f = await ensureDaemon(cfg, opts);
  const r = await daemonRequest(f.st.port, f.st.token, "GET", "/tools", undefined, 15_000);
  if (r.status !== 200) throw new CliError(`daemon answered HTTP ${r.status}: ${r.body.slice(0, 500)}`);
  const { tools } = JSON.parse(r.body) as { tools: ToolInfo[] };
  if (want) {
    const t = tools.find(x => x.name === want);
    if (!t) {
      note(`no tool '${want}' (tools: ${tools.map(x => x.name).join(", ")})`);
      return 2;
    }
    if (opts.json) out(JSON.stringify(t));
    else for (const line of describeTool(t)) out(line);
    return 0;
  }
  if (opts.names) out(opts.json ? JSON.stringify(tools.map(t => t.name)) : tools.map(t => t.name).join("\n"));
  else if (opts.json) out(JSON.stringify({ tools }));
  else {
    const w = Math.max(...tools.map(t => t.name.length));
    for (const t of tools) {
      const first = (t.description ?? "").split(/(?<=\.)\s/)[0];
      out(`${t.name.padEnd(w)}  ${first.length > 110 ? `${first.slice(0, 107)}...` : first}`);
    }
    out("(tupaia tools <name> shows one tool's description and arguments)");
  }
  return 0;
}

/** A daemon a CLI is starting right now (from the start lock), or null. */
function starting(cfg: Config): { daemonPid: number; by: number; ageS: number } | null {
  const lock = readStartLock(cfg.outDir);
  if (!lock?.daemonPid || !pidAlive(lock.daemonPid)) return null;
  return { daemonPid: lock.daemonPid, by: lock.pid, ageS: Math.round((Date.now() - lock.at) / 1000) };
}

async function cmdStatus(cfg: Config, opts: Opts): Promise<number> {
  const closing = readState(cfg.outDir);
  if (closing?.closing && pidAlive(closing.pid)) {
    if (opts.json) out(JSON.stringify({ running: false, stopping: closing.pid, reason: closing.closing }));
    else out(`stopping: pid ${closing.pid} (${closing.closing}); it finishes its running call, then exits`);
    return 1;
  }
  const f = await findDaemon(cfg);
  if (!f) {
    const s = starting(cfg);
    if (opts.json) out(JSON.stringify({ running: false, ...(s ? { starting: s } : {}), outDir: cfg.outDir }));
    else if (s)
      out(`starting: daemon pid ${s.daemonPid} (started by pid ${s.by}, ${s.ageS} s ago; TUPAIA_OUT ${cfg.outDir})`);
    else out(`not running (TUPAIA_OUT ${cfg.outDir})`);
    return 1;
  }
  warnMismatch(cfg, f, opts);
  const h = f.health;
  if (opts.json) out(JSON.stringify({ running: true, ...publicState(f.st), health: h }));
  else {
    const idle = Number(h.idleMin) ? `idle shutdown after ${h.idleMin} min (idle ${h.idleS} s)` : "no idle shutdown";
    const extra = (f.st.ports ?? []).filter(p => p !== f.st.port);
    out(
      `running: pid ${f.st.pid}, ${mcpUrlOf(f.st)}${extra.length ? ` (also port ${extra.join(", ")})` : ""}, mode ${h.mode}, browser ${h.browser}, ${h.active} active request(s), up ${h.uptimeS} s, ${idle}`
    );
    out(`version ${f.st.version}, app ${f.st.appVersion ?? "?"}, TUPAIA_OUT ${cfg.outDir}, repo ${h.repoRoot}`);
  }
  return 0;
}

async function cmdStart(cfg: Config, opts: Opts): Promise<number> {
  const found = await findDaemon(cfg);
  if (found) {
    warnMismatch(cfg, found, opts);
    out(`already running: pid ${found.st.pid}, ${mcpUrlOf(found.st)}, mode ${found.health.mode}`);
    return 0;
  }
  const f = await startDaemon(cfg, opts);
  out(`started: pid ${f.st.pid}, ${mcpUrlOf(f.st)}, mode ${f.st.mode}`);
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

async function waitGone(pid: number): Promise<void> {
  const end = Date.now() + EXIT_WAIT_MS;
  while (pidAlive(pid) && Date.now() < end) await sleep(100);
  if (pidAlive(pid)) throw new CliError(`daemon pid ${pid} did not exit within ${EXIT_WAIT_MS / 1000} s`);
}

async function cmdStop(cfg: Config): Promise<number> {
  const st = readState(cfg.outDir);
  if (!st || !pidAlive(st.pid)) {
    if (st) removeStateIfOwned(cfg.outDir, st.pid);
    const s = starting(cfg);
    if (s && looksLikeOurDaemon(s.daemonPid)) {
      process.kill(s.daemonPid, "SIGTERM");
      await waitGone(s.daemonPid);
      out(`stopped: pid ${s.daemonPid} (it was still starting)`);
      return 0;
    }
    out(`not running (TUPAIA_OUT ${cfg.outDir})`);
    return 0;
  }
  let asked = !!st.closing;
  if (!asked) {
    try {
      const r = await daemonRequest(st.port, st.token, "POST", "/shutdown", {}, 5000);
      asked = r.status === 200 || r.status === 503;
    } catch {
      asked = false;
    }
  }
  if (!asked) {
    if (!looksLikeOurDaemon(st.pid)) {
      removeStateIfOwned(cfg.outDir, st.pid);
      out(`not running (pid ${st.pid} is not a tupaia daemon; removed the stale state file)`);
      return 0;
    }
    process.kill(st.pid, "SIGTERM");
  }
  await waitGone(st.pid);
  removeStateIfOwned(cfg.outDir, st.pid);
  out(`stopped: pid ${st.pid}`);
  const last = path.join(cfg.outDir, LAST_FILE);
  try {
    const l = JSON.parse(fs.readFileSync(last, "utf8")) as LastExit;
    if (l.pid === st.pid) out(`saved its page: ${l.savedMap}`);
  } catch {
    // nothing saved (an untouched page)
  }
  return 0;
}

async function cmdHeaders(cfg: Config, opts: Opts): Promise<number> {
  // Claude Code passes the registered URL: the daemon must serve its port
  if (!opts.port && process.env.CLAUDE_CODE_MCP_SERVER_URL) {
    try {
      const u = new URL(process.env.CLAUDE_CODE_MCP_SERVER_URL);
      if (u.port) opts.port = u.port;
    } catch {
      // not a URL: ignore
    }
  }
  const registered = opts.port ? Number(opts.port) : 0;
  // the registered port is where this TUPAIA_OUT's daemon starts from now on
  if (registered) writePortPref(cfg.outDir, { port: registered, registered: true });
  const f = (await findDaemon(cfg)) ?? (await startDaemon(cfg, opts));
  warnMismatch(cfg, f, { ...opts, port: undefined });
  const ports = f.st.ports ?? [f.st.port];
  if (registered && !ports.includes(registered)) {
    // a daemon started elsewhere (another port) holds this TUPAIA_OUT: it serves the registered port too
    let r: { status: number; body: string };
    try {
      r = await daemonRequest(f.st.port, f.st.token, "POST", "/listen", { port: registered }, 10_000);
    } catch (e) {
      throw new CliError(`could not ask daemon pid ${f.st.pid} to listen on ${registered}: ${(e as Error).message}`);
    }
    if (r.status !== 200)
      throw new CliError(
        `the daemon for ${cfg.outDir} (pid ${f.st.pid}, port ${f.st.port}) cannot also listen on the registered port ${registered}: ${r.body.slice(0, 300)}`
      );
  }
  out(JSON.stringify({ Authorization: `Bearer ${f.st.token}` }));
  return 0;
}

/** The output directory the caller asked for must be usable: never fall back to another one. */
function checkOutDir(): void {
  const asked = process.env.TUPAIA_OUT;
  if (!asked) return;
  const dir = path.resolve(asked);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (e) {
    throw new CliError(`cannot use TUPAIA_OUT ${dir}: ${(e as Error).message}`);
  }
}

export async function main(argv: string[]): Promise<number> {
  let opts: Opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    note((e as Error).message);
    return 2;
  }
  let cmd = opts.positional[0];
  if (cmd === "help" && opts.positional[1]) {
    cmd = "tools";
    opts.positional[0] = "tools";
  }
  if (opts.help || !cmd || cmd === "help") {
    out(USAGE);
    return cmd || opts.help ? 0 : 2;
  }
  try {
    if (opts.out) process.env.TUPAIA_OUT = path.resolve(opts.out);
    checkOutDir();
    const cfg = loadConfig(process.env);
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
