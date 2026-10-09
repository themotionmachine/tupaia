// --http daemon + bin/tupaia CLI: one shared context over MCP Streamable HTTP and the JSON API,
// the security checks (token, Host, Origin), discovery through the state file, serialization of
// concurrent callers, stop/idle shutdown, and the stdio path left as it was. Safe env only.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mismatchWarnings } from "../src/cli.ts";
import { type DaemonState, readState, statePath } from "../src/daemon-state.ts";
import {
  alive,
  chromeDescendants,
  type Harness,
  imageSize,
  MCP_ROOT,
  rawStdoutCheck,
  SERVER,
  safeEnv,
  startServer,
  waitFor
} from "./helpers.ts";

const CLI = path.join(MCP_ROOT, "bin", "tupaia");

interface Daemon {
  child: ChildProcess;
  env: Record<string, string>;
  st: DaemonState;
  log: string[];
  stop(): Promise<void>;
}

async function spawnDaemon(extra: Record<string, string> = {}, args: string[] = []): Promise<Daemon> {
  const env = safeEnv(extra);
  const child = spawn(process.execPath, [SERVER, "--http", ...args], {
    env,
    cwd: MCP_ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const log: string[] = [];
  child.stdout?.on("data", d => log.push(String(d)));
  child.stderr?.on("data", d => {
    log.push(String(d));
    if (process.env.TUPAIA_TEST_VERBOSE) process.stderr.write(String(d));
  });
  await waitFor(() => readState(env.TUPAIA_OUT)?.pid === child.pid || child.exitCode !== null, 30_000);
  const st = readState(env.TUPAIA_OUT);
  if (!st || st.pid !== child.pid) throw new Error(`the daemon did not start: ${log.join("")}`);
  return {
    child,
    env,
    st,
    log,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, 30_000);
      }
    }
  };
}

interface Reply {
  status: number;
  text: string;
  json: any;
}

/** A raw request with full control over the headers (Host, Origin, Authorization). */
function raw(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: unknown; destroyAfterMs?: number }
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path ?? "/health",
        headers: { ...(data ? { "content-type": "application/json" } : {}), ...opts.headers }
      },
      res => {
        const chunks: Buffer[] = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, text, json });
        });
      }
    );
    r.on("error", reject);
    if (opts.destroyAfterMs !== undefined) setTimeout(() => r.destroy(new Error("client left")), opts.destroyAfterMs);
    r.end(data);
  });
}

const auth = (st: DaemonState) => ({ authorization: `Bearer ${st.token}` });

async function callJson(st: DaemonState, name: string, args: Record<string, unknown> = {}, timeoutMs?: number) {
  const r = await raw(st.port, { method: "POST", path: "/call", headers: auth(st), body: { name, args, timeoutMs } });
  assert.equal(r.status, 200, r.text);
  return r.json as { isError: boolean; text: string[]; images: string[] };
}

function cli(
  args: string[],
  env: Record<string, string>,
  stdin?: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(CLI, args, { env, cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => {
      stdout += d;
    });
    child.stderr.on("data", d => {
      stderr += d;
    });
    child.on("exit", code => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });
}

async function httpClient(st: DaemonState, mode: "legacy" | "auto" = "legacy"): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${st.url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${st.token}` } }
  });
  const client = new Client({ name: "tupaia-http-test", version: "0.0.0" }, { versionNegotiation: { mode } });
  await client.connect(transport);
  return client;
}

function listing(tools: Array<Record<string, unknown>>) {
  return tools.map(t => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations
  }));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

describe("tupaia-mcp --http daemon", () => {
  let d: Daemon;
  let stdio: Harness;
  const clients: Client[] = [];

  before(async () => {
    d = await spawnDaemon();
  });

  after(async () => {
    for (const c of clients) await c.close().catch(() => {});
    if (stdio && alive(stdio.pid)) await stdio.close();
    if (d) await d.stop();
  });

  test("state file: 0600, loopback url, local mode, token, no browser yet", () => {
    const file = statePath(d.env.TUPAIA_OUT);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const st = d.st;
    assert.equal(st.pid, d.child.pid);
    assert.ok(st.port > 0);
    assert.equal(st.url, `http://127.0.0.1:${st.port}`);
    assert.equal(st.mode, "local");
    assert.ok(st.token.length >= 40, "token is long and random");
    assert.ok(Date.parse(st.startedAt) > 0);
    assert.match(st.version, /^\d+\.\d+\.\d+/);
    assert.equal(chromeDescendants(d.child.pid as number).length, 0, "the browser launches on the first call only");
  });

  test("security: bearer token, Host, Origin; loopback only", async () => {
    const { port } = d.st;
    assert.equal((await raw(port, {})).status, 401, "no token");
    assert.equal((await raw(port, { headers: { authorization: "Bearer nope" } })).status, 401, "bad token");
    assert.equal((await raw(port, { headers: { authorization: d.st.token } })).status, 401, "token without Bearer");
    const mcpNoToken = await raw(port, {
      method: "POST",
      path: "/mcp",
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" }
    });
    assert.equal(mcpNoToken.status, 401, "/mcp needs the token too");
    const callNoToken = await raw(port, { method: "POST", path: "/call", body: { name: "session" } });
    assert.equal(callNoToken.status, 401, "/call needs the token too");

    const ok = await raw(port, { headers: auth(d.st) });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.mode, "local");
    const viaLocalhost = await raw(port, { headers: { ...auth(d.st), host: `localhost:${port}` } });
    assert.equal(viaLocalhost.status, 200, "localhost:<port> is allowed");

    for (const host of [
      `evil.example:${port}`,
      "127.0.0.1",
      `127.0.0.1:${port + 1}`,
      `localhost.evil.example:${port}`
    ]) {
      const r = await raw(port, { headers: { ...auth(d.st), host } });
      assert.equal(r.status, 403, `Host ${host}`);
    }
    for (const origin of [`http://127.0.0.1:${port}`, "https://evil.example", "null"]) {
      const r = await raw(port, { headers: { ...auth(d.st), origin } });
      assert.equal(r.status, 403, `Origin ${origin}`);
      const m = await raw(port, {
        method: "POST",
        path: "/call",
        headers: { ...auth(d.st), origin },
        body: { name: "session" }
      });
      assert.equal(m.status, 403, `Origin ${origin} on /call`);
    }
    // bound to 127.0.0.1 only: a non-loopback address of this machine refuses the connection
    const ext = Object.values(os.networkInterfaces())
      .flat()
      .find(a => a && a.family === "IPv4" && !a.internal);
    if (ext) {
      const err = await new Promise<string>(resolve => {
        const s = net.connect({ host: ext.address, port }, () => {
          s.destroy();
          resolve("connected");
        });
        s.on("error", e => resolve((e as NodeJS.ErrnoException).code ?? "error"));
        s.setTimeout(3000, () => {
          s.destroy();
          resolve("timeout");
        });
      });
      assert.notEqual(err, "connected", `reachable on ${ext.address}`);
    }
    assert.equal((await raw(port, { headers: auth(d.st), path: "/nope" })).status, 404);
  });

  test("MCP over Streamable HTTP: same tools, resources and instructions as stdio; calls work", async () => {
    stdio = await startServer();
    const viaStdio = await stdio.client.listTools();
    const legacy = await httpClient(d.st, "legacy");
    clients.push(legacy);
    const viaHttp = await legacy.listTools();
    assert.equal(viaHttp.tools.length, viaStdio.tools.length);
    assert.deepEqual(listing(viaHttp.tools), listing(viaStdio.tools));
    assert.equal(legacy.getInstructions(), stdio.client.getInstructions());
    const res = await legacy.listResources();
    assert.deepEqual(
      res.resources.map(r => r.uri).sort(),
      (await stdio.client.listResources()).resources.map(r => r.uri).sort()
    );
    const doc = await legacy.readResource({ uri: "tupaia://docs/cheatsheet.md" });
    assert.ok(((doc.contents[0] as { text?: string }).text ?? "").length > 500);
    await stdio.close();

    const s = await legacy.callTool({ name: "session", arguments: { action: "status" } });
    assert.ok(!s.isError, JSON.stringify(s.content).slice(0, 300));
    const status = JSON.parse((s.content as Array<{ text: string }>).at(-1)?.text ?? "{}");
    assert.equal(status.mode, "local");
    assert.match(status.serving, /http daemon http:\/\/127\.0\.0\.1:\d+\/mcp/);

    const loaded = await legacy.callTool(
      { name: "load_map", arguments: { path: "tests/fixtures/demo.map" } },
      { timeout: 180_000 }
    );
    assert.ok(!loaded.isError, JSON.stringify(loaded.content).slice(0, 300));
    assert.equal(JSON.parse((loaded.content as Array<{ text: string }>)[0].text).name, "Chanland");

    // a second session (2026-07-28 era when the client negotiates it) sees the same page
    const modern = await httpClient(d.st, "auto");
    clients.push(modern);
    assert.equal(legacy.getProtocolEra(), "legacy");
    assert.equal(modern.getProtocolEra(), "modern");
    assert.deepEqual(
      (await modern.listTools()).tools.map(t => t.name),
      viaHttp.tools.map(t => t.name)
    );
    const f = await modern.callTool({ name: "find", arguments: { type: "state", limit: 3 } });
    assert.ok(!f.isError, JSON.stringify(f.content).slice(0, 300));
    // the JSON API shares it too
    const info = await callJson(d.st, "session", { action: "status" });
    assert.equal(info.isError, false);
    assert.equal(JSON.parse(info.text[0]).map.name, "Chanland");
    // GET is not a session stream in stateless serving: 405, never a hang
    assert.equal(
      (await raw(d.st.port, { path: "/mcp", headers: { ...auth(d.st), accept: "text/event-stream" } })).status,
      405
    );
  });

  test("/call: text, saved images, argument errors, unknown tools; /tools; /health", async () => {
    const shot = await callJson(d.st, "screenshot", { maxSide: 300 });
    assert.equal(shot.isError, false, shot.text.join("\n"));
    assert.equal(shot.images.length, 1);
    const img = shot.images[0];
    assert.ok(img.startsWith(path.join(d.env.TUPAIA_OUT, "shots")), img);
    const size = imageSize(fs.readFileSync(img));
    assert.equal(size.type, "jpeg");
    assert.equal(Math.max(size.width, size.height), 300);
    assert.match(JSON.parse(shot.text[0]).shotId, /^s\d+$/);

    const bad = await callJson(d.st, "find", { type: "nope" });
    assert.equal(bad.isError, true);
    assert.match(bad.text[0], /^BAD_ARGS: invalid arguments for find/);
    const none = await callJson(d.st, "no_such_tool");
    assert.equal(none.isError, true);
    assert.match(none.text[0], /^NOT_FOUND: no tool 'no_such_tool' \(tools: /);
    const notJson = await raw(d.st.port, { method: "POST", path: "/call", headers: auth(d.st) });
    assert.equal(notJson.status, 400);

    const tools = await raw(d.st.port, { path: "/tools", headers: auth(d.st) });
    assert.equal(tools.status, 200);
    assert.equal(tools.json.tools.length, 21);
    const find = tools.json.tools.find((t: { name: string }) => t.name === "find");
    assert.equal(find.inputSchema.type, "object");
    assert.ok(find.inputSchema.properties.type, "input schema has properties");

    const h = (await raw(d.st.port, { headers: auth(d.st) })).json;
    assert.equal(h.pid, d.child.pid);
    assert.equal(h.browser, "ready");
    assert.equal(h.tools, 21);
    assert.equal(h.idleMin, 120);
  });

  test("a caller that leaves before its call starts is skipped; a started call finishes", async () => {
    const hold = callJson(d.st, "eval", {
      code: "globalThis.__held = 1; await new Promise(r => setTimeout(r, 1500)); return 'held'",
      readOnly: true
    });
    await new Promise(r => setTimeout(r, 200));
    // queued behind `hold`, then the client goes away
    const left = await raw(d.st.port, {
      method: "POST",
      path: "/call",
      headers: auth(d.st),
      body: { name: "eval", args: { code: "globalThis.__skipped = 'ran'; return 1", readOnly: true } },
      destroyAfterMs: 300
    }).catch(e => (e as Error).message);
    assert.equal(left, "client left");
    // a started call whose client leaves still runs to completion
    const started = await raw(d.st.port, {
      method: "POST",
      path: "/call",
      headers: auth(d.st),
      body: {
        name: "eval",
        args: {
          code: "await new Promise(r => setTimeout(r, 2500)); globalThis.__finished = 'yes'; return 1",
          readOnly: true
        }
      },
      destroyAfterMs: 2000
    }).catch(e => (e as Error).message);
    assert.equal(left, "client left");
    assert.equal(started, "client left");
    assert.equal((await hold).isError, false);
    await waitFor(() => d.log.join("").includes("(caller gone)"), 10_000);
    const r = await callJson(d.st, "eval", {
      code: "return [globalThis.__skipped ?? null, globalThis.__finished ?? null]",
      readOnly: true
    });
    assert.deepEqual(JSON.parse(r.text[0]).value, [null, "yes"]);
  });

  test("CLI: two concurrent calls serialize; text, images and exit codes", async () => {
    const env = d.env;
    const code =
      "const s = Date.now(); await new Promise(r => setTimeout(r, 700)); return { s, e: Date.now(), who: args }";
    const [a, b] = await Promise.all([
      cli(["call", "eval", JSON.stringify({ code, args: "a", readOnly: true })], env),
      cli(["call", "eval", "-"], env, JSON.stringify({ code, args: "b", readOnly: true }))
    ]);
    assert.equal(a.code, 0, a.stderr + a.stdout);
    assert.equal(b.code, 0, b.stderr + b.stdout);
    const va = JSON.parse(a.stdout).value;
    const vb = JSON.parse(b.stdout).value;
    assert.deepEqual([va.who, vb.who], ["a", "b"]);
    const [first, second] = va.s < vb.s ? [va, vb] : [vb, va];
    assert.ok(second.s >= first.e, `overlap: ${JSON.stringify([first, second])}`);
    assert.doesNotMatch(a.stderr, /starting one/, "found the running daemon");

    const shot = await cli(["call", "screenshot", '{"maxSide":256}'], env);
    assert.equal(shot.code, 0, shot.stderr + shot.stdout);
    const m = /^IMAGE: (.+)$/m.exec(shot.stdout);
    assert.ok(m && fs.existsSync(m[1]), shot.stdout);

    const bad = await cli(["call", "find", '{"type":"nope"}'], env);
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /^BAD_ARGS/);
    const asJson = await cli(["call", "find", '{"type":"nope"}', "--json"], env);
    assert.equal(asJson.code, 1);
    assert.equal(JSON.parse(asJson.stdout).isError, true);
    const notJson = await cli(["call", "find", "{type:"], env);
    assert.equal(notJson.code, 2);
    assert.match(notJson.stderr, /not JSON/);

    const names = await cli(["tools", "--names"], env);
    assert.equal(names.code, 0);
    assert.equal(names.stdout.trim().split("\n").length, 21);
    const st = await cli(["status"], env);
    assert.equal(st.code, 0);
    assert.match(
      st.stdout,
      new RegExp(`running: pid ${d.child.pid}, http://127\\.0\\.0\\.1:${d.st.port}/mcp, mode local`)
    );
    assert.doesNotMatch(st.stdout + (await cli(["status", "--json"], env)).stdout, new RegExp(d.st.token));
    const headers = await cli(["headers"], env);
    assert.deepEqual(JSON.parse(headers.stdout), { Authorization: `Bearer ${d.st.token}` });
  });

  test("a second daemon for the same TUPAIA_OUT refuses to start", async () => {
    const child = spawn(process.execPath, [SERVER, "--http"], { env: d.env, cwd: MCP_ROOT, stdio: "pipe" });
    let err = "";
    child.stderr.on("data", c => {
      err += c;
    });
    const code = await new Promise<number>(r => child.on("exit", c => r(c ?? -1)));
    assert.equal(code, 1);
    assert.match(err, /already serves/);
    assert.equal(readState(d.env.TUPAIA_OUT)?.pid, d.child.pid, "the running daemon keeps its state file");
  });

  test("stop: the daemon exits, closes its browser and removes the state file", async () => {
    const pid = d.child.pid as number;
    assert.ok(chromeDescendants(pid).length > 0, "browser running before stop");
    const r = await cli(["stop"], d.env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`stopped: pid ${pid}`));
    assert.ok(await waitFor(() => d.child.exitCode !== null, 10_000));
    assert.equal(d.child.exitCode, 0);
    assert.equal(fs.existsSync(statePath(d.env.TUPAIA_OUT)), false);
    assert.ok(await waitFor(() => chromeDescendants(pid).length === 0, 10_000));
    const st = await cli(["status"], d.env);
    assert.equal(st.code, 1);
    assert.match(st.stdout, /^not running/);
    assert.equal((await cli(["stop"], d.env)).code, 0, "stop when not running is fine");
  });
});

describe("tupaia CLI daemon lifecycle", () => {
  test("call auto-starts a daemon (local mode, caller env), on a fixed port when asked", async () => {
    const env = safeEnv({ TUPAIA_HTTP_IDLE_MIN: "0" });
    const port = await freePort();
    const r = await cli(["call", "session", '{"action":"status"}', "--port", String(port)], env);
    try {
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /no daemon serves .*; starting one/);
      assert.match(r.stderr, /started a daemon: pid \d+/);
      const st = readState(env.TUPAIA_OUT);
      assert.ok(st);
      assert.equal(st.port, port);
      assert.equal(st.idleMin, 0);
      assert.equal(JSON.parse(r.stdout).mode, "local");
      assert.ok(fs.readFileSync(path.join(env.TUPAIA_OUT, "daemon.log"), "utf8").includes("ready: http"));
      const again = await cli(["call", "session"], env);
      assert.doesNotMatch(again.stderr, /starting one/);
      // Claude Code's headersHelper gets the registered URL; the port must match the daemon's
      const helper = await cli(["headers"], { ...env, CLAUDE_CODE_MCP_SERVER_URL: `http://127.0.0.1:${port}/mcp` });
      assert.equal(helper.code, 0, helper.stderr);
      assert.deepEqual(JSON.parse(helper.stdout), { Authorization: `Bearer ${st.token}` });
      const wrong = await cli(["headers"], { ...env, CLAUDE_CODE_MCP_SERVER_URL: `http://127.0.0.1:${port + 1}/mcp` });
      assert.equal(wrong.code, 2);
      assert.equal(wrong.stdout, "");
      assert.match(
        wrong.stderr,
        new RegExp(`listens on port ${port}, but this server is registered at port ${port + 1}`)
      );
    } finally {
      const s = await cli(["stop"], env);
      assert.equal(s.code, 0, s.stderr);
    }
    assert.equal(fs.existsSync(statePath(env.TUPAIA_OUT)), false);
  });

  test("concurrent first calls start exactly one daemon", async () => {
    const env = safeEnv();
    const runs = await Promise.all([1, 2, 3].map(() => cli(["tools", "--names"], env)));
    try {
      for (const r of runs) assert.equal(r.code, 0, r.stderr);
      const started = runs.filter(r => /started a daemon/.test(r.stderr)).length;
      assert.equal(started, 1, runs.map(r => r.stderr).join("\n---\n"));
    } finally {
      await cli(["stop"], env);
    }
  });

  test("stale state file: dead pid is detected and removed", async () => {
    const env = safeEnv();
    const dead = spawn(process.execPath, ["-e", ""]);
    await new Promise(r => dead.on("exit", r));
    const fake: DaemonState = {
      pid: dead.pid as number,
      port: 9,
      url: "http://127.0.0.1:9",
      mode: "local",
      startedAt: new Date().toISOString(),
      version: "0.0.0",
      appVersion: null,
      repoRoot: "/nowhere",
      outDir: env.TUPAIA_OUT,
      idleMin: 120,
      token: "x"
    };
    fs.writeFileSync(statePath(env.TUPAIA_OUT), JSON.stringify(fake), { mode: 0o600 });
    const r = await cli(["status"], env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /removed a stale state file \(daemon pid \d+ is gone\)/);
    assert.equal(fs.existsSync(statePath(env.TUPAIA_OUT)), false);
    // a live pid that is not a daemon on the recorded port (pid reuse) is stale too
    const reused = { ...fake, pid: process.pid, port: await freePort() };
    fs.writeFileSync(statePath(env.TUPAIA_OUT), JSON.stringify(reused), { mode: 0o600 });
    const r2 = await cli(["status"], env);
    assert.equal(r2.code, 1);
    assert.match(r2.stderr, /removed a stale state file \(pid \d+ is alive but is not a daemon/);
    assert.equal(fs.existsSync(statePath(env.TUPAIA_OUT)), false);
  });

  test("idle shutdown (TUPAIA_HTTP_IDLE_MIN) and TUPAIA_HTTP_PORT", async () => {
    const port = await freePort();
    const d = await spawnDaemon({ TUPAIA_HTTP_IDLE_MIN: "0.03", TUPAIA_HTTP_PORT: String(port) });
    try {
      assert.equal(d.st.port, port);
      assert.ok(await waitFor(() => d.child.exitCode !== null, 15_000), "exits when idle");
      assert.equal(d.child.exitCode, 0);
      assert.match(d.log.join(""), /idle for 0\.03 min/);
      assert.equal(fs.existsSync(statePath(d.env.TUPAIA_OUT)), false);
    } finally {
      await d.stop();
    }
  });

  test("mode mismatch is a warning, never a restart", () => {
    const w = mismatchWarnings(
      { envMode: "live", repoRoot: "/r", port: undefined },
      { pid: 42, port: 1234, mode: "local", repoRoot: "/r" }
    );
    assert.equal(w.length, 1);
    assert.match(w[0], /in local mode but your environment asks for live; it is NOT restarted/);
    assert.deepEqual(mismatchWarnings({ envMode: "local", repoRoot: "/r" }, { pid: 1, port: 2, mode: "local" }), []);
    assert.match(
      mismatchWarnings(
        { envMode: "local", repoRoot: "/a", port: "5" },
        { pid: 1, port: 2, mode: "local", repoRoot: "/b" }
      ).join("\n"),
      /runs from \/b[\s\S]*listens on port 2, not 5/
    );
  });

  test("bad --port and usage errors exit 2", async () => {
    const env = safeEnv();
    const p = spawn(process.execPath, [SERVER, "--http", "--port", "99999"], { env, cwd: MCP_ROOT, stdio: "pipe" });
    let err = "";
    p.stderr.on("data", c => {
      err += c;
    });
    assert.equal(await new Promise<number>(r => p.on("exit", c => r(c ?? -1))), 1);
    assert.match(err, /port '99999' is not 0\.\.65535/);
    assert.equal((await cli(["frobnicate"], env)).code, 2);
    assert.equal((await cli([], env)).code, 2);
    assert.equal((await cli(["--help"], env)).code, 0);
    assert.equal((await cli(["call"], env)).code, 2);
  });
});

describe("stdio path unchanged", () => {
  test("stdout carries only JSON-RPC; stdio is still the default transport", async () => {
    const { bad, responses } = await rawStdoutCheck([{ name: "session", arguments: { action: "status" } }]);
    assert.deepEqual(bad, []);
    const call = responses.find(r => (r.result as { content?: unknown } | undefined)?.content) as
      | { result: { content: Array<{ text: string }> } }
      | undefined;
    assert.ok(call);
    const status = JSON.parse(call.result.content.at(-1)?.text ?? "{}");
    assert.equal(status.serving, undefined, "stdio servers do not report an http daemon");
    assert.equal(status.mode, "local");
  });
});
