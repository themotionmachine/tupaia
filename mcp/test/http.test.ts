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
import { absolutizeInputs, formatResult, mismatchWarnings, schemaType } from "../src/cli.ts";
import { type DaemonState, readPortPref, readState, START_LOCK, statePath } from "../src/daemon-state.ts";
import {
  alive,
  chromeDescendants,
  DEMO_MAP,
  type Harness,
  imageSize,
  MCP_ROOT,
  REPO_ROOT,
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
  // generous: module loading alone can take tens of seconds on a loaded machine
  await waitFor(() => readState(env.TUPAIA_OUT)?.pid === child.pid || child.exitCode !== null, 90_000);
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
  stdin?: string,
  cwd = os.tmpdir()
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(CLI, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
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
    assert.equal(st.mcpUrl, `http://127.0.0.1:${st.port}/mcp`);
    assert.deepEqual(st.ports, [st.port]);
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
    const nope = await raw(port, { headers: auth(d.st), path: "/nope" });
    assert.equal(nope.status, 404);
    assert.match(nope.json.error, /routes: POST \/mcp/, "a 404 names the routes");
    assert.doesNotMatch((await raw(port, {})).text, /daemon\.json"|\//, "a 401 does not name file paths");
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

    // nothing over HTTP reaches live mode: set_mode only drops to local, on both paths
    const viaMcp = await legacy.callTool({ name: "session", arguments: { action: "set_mode", mode: "live" } });
    assert.equal(viaMcp.isError, true);
    const viaCall = await callJson(d.st, "session", { action: "set_mode", mode: "live" });
    assert.equal(viaCall.isError, true);
    assert.match(viaCall.text[0], /^BAD_ARGS/);
    const dropped = await callJson(d.st, "session", { action: "set_mode", mode: "local" });
    assert.equal(dropped.isError, false, dropped.text.join("\n"));
    assert.equal((await raw(d.st.port, { headers: auth(d.st) })).json.mode, "local");

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
    await waitFor(() => d.log.join("").includes("(caller gone; finished anyway)"), 10_000);
    assert.match(d.log.join(""), /call eval skipped after \d+ ms: the caller went away before it started/);

    // the same over MCP, in both eras: a 2025-era client cancels with notifications/cancelled
    // (a separate POST the daemon routes), a 2026-era client closes the request's stream
    const legacy = await httpClient(d.st, "legacy");
    const modern = await httpClient(d.st, "auto");
    try {
      const hold2 = callJson(d.st, "eval", {
        code: "await new Promise(r => setTimeout(r, 2500)); return 1",
        readOnly: true
      });
      await new Promise(r => setTimeout(r, 200));
      const abortQueued = (c: Client, flag: string) =>
        c
          .callTool(
            { name: "eval", arguments: { code: `globalThis.${flag} = 'ran'; return 1`, readOnly: true } },
            { signal: AbortSignal.timeout(400) }
          )
          .then(
            () => "returned",
            () => "aborted"
          );
      const results = await Promise.all([abortQueued(legacy, "__mcpLegacy"), abortQueued(modern, "__mcpModern")]);
      assert.deepEqual(results, ["aborted", "aborted"]);
      assert.equal((await hold2).isError, false);
    } finally {
      await legacy.close().catch(() => {});
      await modern.close().catch(() => {});
    }
    const r = await callJson(d.st, "eval", {
      code: "return [globalThis.__skipped, globalThis.__finished, globalThis.__mcpLegacy, globalThis.__mcpModern].map(v => v ?? null)",
      readOnly: true
    });
    assert.deepEqual(JSON.parse(r.text[0]).value, [null, "yes", null, null]);
    assert.match(d.log.join(""), /mcp cancel of request \S+: skipped unless it had started/);
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
    assert.match(bad.stdout, /^ERROR BAD_ARGS: invalid arguments for find/);
    assert.equal(bad.stdout.match(/invalid arguments/g)?.length, 1, "the message is printed once");
    const union = await cli(["call", "screenshot", '{"target":{"entity":"x"}}'], env);
    assert.equal(union.code, 1);
    assert.match(
      union.stdout,
      /target: matches none of the accepted shapes: \(1\) entity: .*\(2\) needs bbox \(3\) needs at/
    );
    const asJson = await cli(["call", "find", '{"type":"nope"}', "--json"], env);
    assert.equal(asJson.code, 1);
    assert.equal(JSON.parse(asJson.stdout).isError, true);
    const notJson = await cli(["call", "find", "{type:"], env);
    assert.equal(notJson.code, 2);
    assert.match(notJson.stderr, /not JSON/);

    const names = await cli(["tools", "--names"], env);
    assert.equal(names.code, 0);
    assert.equal(names.stdout.trim().split("\n").length, 21);
    const namesJson = await cli(["tools", "--names", "--json"], env);
    assert.equal(JSON.parse(namesJson.stdout).length, 21);
    const one = await cli(["tools", "screenshot"], env);
    assert.equal(one.code, 0, one.stderr);
    assert.match(one.stdout, /^screenshot \(/);
    assert.match(one.stdout, /\n {2}target\?: \{entity: \{type: "burg"\|/);
    assert.match(one.stdout, /\n {2}maxSide\?: integer {2}# /);
    assert.equal((await cli(["help", "screenshot"], env)).stdout, one.stdout);
    assert.equal((await cli(["tools", "nope"], env)).code, 2);

    // a relative input path is taken from the caller's cwd when the file is there
    const rel = await cli(["call", "load_map", '{"path":"demo.map"}'], env, undefined, path.dirname(DEMO_MAP));
    assert.equal(rel.code, 0, rel.stdout + rel.stderr);
    assert.equal(JSON.parse(rel.stdout).name, "Chanland");
    const bogus = await cli(["status", "--out", "/nonexistent-root/tupaia"], env);
    assert.equal(bogus.code, 2, "an unusable --out never falls back to another directory");
    assert.match(bogus.stderr, /cannot use TUPAIA_OUT \/nonexistent-root\/tupaia/);
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
    // the page held a loaded map, so it was saved on the way out
    const saved = /^saved its page: (.+daemon-exit-.+\.map)$/m.exec(r.stdout);
    assert.ok(saved && fs.existsSync(saved[1]), r.stdout);
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
  test("call auto-starts a daemon (caller env, relative TUPAIA_DIST), on a fixed port when asked", async () => {
    const env = safeEnv({ TUPAIA_HTTP_IDLE_MIN: "0" });
    const port = await freePort();
    const other = await freePort();
    // TUPAIA_DIST relative to the caller's cwd (the daemon itself runs from mcp/)
    const r = await cli(
      ["call", "session", '{"action":"status"}', "--port", String(port)],
      { ...env, TUPAIA_DIST: "dist" },
      undefined,
      REPO_ROOT
    );
    try {
      assert.equal(r.code, 0, r.stderr + r.stdout);
      assert.match(r.stderr, /no daemon serves .*; starting one/);
      assert.match(r.stderr, /started a daemon: pid \d+.*fresh random map/);
      const st = readState(env.TUPAIA_OUT);
      assert.ok(st);
      assert.equal(st.port, port);
      assert.equal(st.idleMin, 0);
      assert.equal(JSON.parse(r.stdout).mode, "local");
      assert.equal(JSON.parse(r.stdout).distDir, path.join(REPO_ROOT, "dist"));
      assert.ok(fs.readFileSync(path.join(env.TUPAIA_OUT, "daemon.log"), "utf8").includes("ready: http"));
      const again = await cli(["call", "session"], env);
      assert.doesNotMatch(again.stderr, /starting one/);
      // Claude Code's headersHelper gets the registered URL
      const helper = await cli(["headers"], { ...env, CLAUDE_CODE_MCP_SERVER_URL: `http://127.0.0.1:${port}/mcp` });
      assert.equal(helper.code, 0, helper.stderr);
      assert.deepEqual(JSON.parse(helper.stdout), { Authorization: `Bearer ${st.token}` });
      // a registration on another port: the running daemon (and its page) serves that port too
      const added = await cli(["headers"], { ...env, CLAUDE_CODE_MCP_SERVER_URL: `http://127.0.0.1:${other}/mcp` });
      assert.equal(added.code, 0, added.stderr);
      assert.deepEqual(JSON.parse(added.stdout), { Authorization: `Bearer ${st.token}` });
      assert.deepEqual(readState(env.TUPAIA_OUT)?.ports, [port, other]);
      const viaOther = await raw(other, { headers: auth(st) });
      assert.equal(viaOther.status, 200);
      assert.equal(viaOther.json.pid, st.pid);
      const crossHost = await raw(other, { headers: { ...auth(st), host: `127.0.0.1:${port}` } });
      assert.equal(crossHost.status, 403, "Host must name the port the request arrived on");
      assert.deepEqual(readPortPref(env.TUPAIA_OUT), { port: other, registered: true });
    } finally {
      const s = await cli(["stop"], env);
      assert.equal(s.code, 0, s.stderr);
    }
    assert.equal(fs.existsSync(statePath(env.TUPAIA_OUT)), false);
    assert.equal(fs.existsSync(path.join(env.TUPAIA_OUT, "daemon.last.json")), false, "an untouched page is not saved");
    // the next auto-start uses the registered port, not the one the first daemon had
    const next = await cli(["tools", "--names"], env);
    try {
      assert.equal(next.code, 0, next.stderr);
      assert.equal(readState(env.TUPAIA_OUT)?.port, other);
    } finally {
      await cli(["stop"], env);
    }
  });

  test("an auto-started daemon keeps its port across restarts", async () => {
    const env = safeEnv({ TUPAIA_HTTP_IDLE_MIN: "0" });
    const first = await cli(["tools", "--names"], env);
    assert.equal(first.code, 0, first.stderr);
    const p1 = readState(env.TUPAIA_OUT)?.port;
    assert.equal((await cli(["stop"], env)).code, 0);
    const second = await cli(["tools", "--names"], env);
    try {
      assert.equal(second.code, 0, second.stderr);
      assert.equal(readState(env.TUPAIA_OUT)?.port, p1);
      assert.deepEqual(readPortPref(env.TUPAIA_OUT), { port: p1, registered: false });
    } finally {
      await cli(["stop"], env);
    }
  });

  test("shutting down: queued calls are refused at once, the running call finishes, the page is saved", async () => {
    const d = await spawnDaemon({ TUPAIA_HTTP_IDLE_MIN: "0" });
    try {
      const loaded = await callJson(d.st, "load_map", { path: DEMO_MAP }, 120_000);
      assert.equal(loaded.isError, false, loaded.text.join("\n"));
      const running = callJson(d.st, "eval", {
        code: "await new Promise(r => setTimeout(r, 3000)); return 'done'",
        readOnly: true
      });
      await new Promise(r => setTimeout(r, 300));
      const queued = raw(d.st.port, {
        method: "POST",
        path: "/call",
        headers: auth(d.st),
        body: { name: "eval", args: { code: "return globalThis.__queuedRan = 1", readOnly: true } }
      });
      const end = Date.now() + 30_000;
      while (Date.now() < end && (await raw(d.st.port, { headers: auth(d.st) })).json.active < 2)
        await new Promise(r => setTimeout(r, 50));
      const stop = await raw(d.st.port, { method: "POST", path: "/shutdown", headers: auth(d.st), body: {} });
      assert.equal(stop.status, 200);
      // the queued call is answered at once: nothing ran, so a caller may start a fresh daemon for it
      const q = await queued;
      assert.equal(q.status, 503, q.text);
      assert.equal(q.json.closing, true);
      assert.equal(q.json.ran, false);
      // while it drains, the state file stays and says so: callers wait instead of starting a second browser
      assert.ok(readState(d.env.TUPAIA_OUT)?.closing, "state marked closing");
      const done = await running;
      assert.equal(done.isError, false, "the call in progress finishes");
      assert.equal(JSON.parse(done.text[0]).value, "done");
      assert.ok(await waitFor(() => d.child.exitCode !== null, 30_000));
      assert.match(d.log.join(""), /call eval skipped after \d+ ms: shutting down/);
      assert.equal(fs.existsSync(statePath(d.env.TUPAIA_OUT)), false);
      const last = JSON.parse(fs.readFileSync(path.join(d.env.TUPAIA_OUT, "daemon.last.json"), "utf8"));
      assert.equal(last.pid, d.child.pid);
      assert.match(last.savedMap, /maps\/daemon-exit-\d+T\d+\.map$/);
      assert.ok(fs.statSync(last.savedMap).size > 1_000_000, "the loaded map was saved");
      // the next start reports it
      const next = await cli(["tools", "--names"], d.env);
      assert.equal(next.code, 0, next.stderr);
      assert.match(next.stderr, /previous daemon \(pid \d+\) stopped .* saved its page to .*daemon-exit-/);
    } finally {
      await cli(["stop"], d.env);
      await d.stop();
    }
  });

  test("CLI: a call refused by a daemon that is shutting down runs on a fresh daemon", async () => {
    // a stand-in daemon that answers like one in its drain: healthy, but /call -> 503 closing
    const env = safeEnv({ TUPAIA_HTTP_IDLE_MIN: "0" });
    const dummy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    const fake = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") return res.end(JSON.stringify({ ok: true, pid: dummy.pid, mode: "local" }));
      res.statusCode = 503;
      res.end(JSON.stringify({ error: "the daemon is shutting down (test)", closing: true, ran: false }));
      setTimeout(() => dummy.kill(), 300);
    });
    const port = await new Promise<number>(r =>
      fake.listen(0, "127.0.0.1", () => r((fake.address() as net.AddressInfo).port))
    );
    try {
      const st: DaemonState = {
        pid: dummy.pid as number,
        port,
        url: `http://127.0.0.1:${port}`,
        mcpUrl: `http://127.0.0.1:${port}/mcp`,
        ports: [port],
        mode: "local",
        startedAt: new Date().toISOString(),
        version: "0.0.0",
        appVersion: null,
        repoRoot: REPO_ROOT,
        outDir: env.TUPAIA_OUT,
        idleMin: 0,
        token: "t"
      };
      // a state file marked closing: status says so at once
      fs.writeFileSync(statePath(env.TUPAIA_OUT), JSON.stringify({ ...st, closing: "test" }), { mode: 0o600 });
      const status = await cli(["status"], env);
      assert.equal(status.code, 1);
      assert.match(status.stdout, new RegExp(`^stopping: pid ${dummy.pid} \\(test\\)`));
      fs.writeFileSync(statePath(env.TUPAIA_OUT), JSON.stringify(st), { mode: 0o600 });
      const c = await cli(["call", "eval", '{"code":"return 7","readOnly":true}'], env);
      assert.equal(c.code, 0, c.stderr + c.stdout);
      assert.match(c.stderr, /the daemon shut down before eval started \(nothing ran\); a fresh daemon runs it/);
      assert.match(c.stderr, /started a daemon: pid \d+/);
      assert.equal(JSON.parse(c.stdout).value, 7);
      assert.notEqual(readState(env.TUPAIA_OUT)?.pid, dummy.pid);
    } finally {
      dummy.kill();
      fake.close();
      await cli(["stop"], env);
    }
  });

  test("a daemon whose state file another daemon took over stops itself", async () => {
    const d = await spawnDaemon({ TUPAIA_HTTP_IDLE_MIN: "0.1" });
    try {
      const other: DaemonState = { ...d.st, pid: process.pid, port: await freePort(), token: "other" };
      fs.writeFileSync(statePath(d.env.TUPAIA_OUT), JSON.stringify(other), { mode: 0o600 });
      assert.ok(await waitFor(() => d.child.exitCode !== null, 20_000), "stops itself");
      assert.match(d.log.join(""), new RegExp(`superseded: daemon pid ${process.pid} now serves`));
      assert.equal(readState(d.env.TUPAIA_OUT)?.pid, process.pid, "the newer state file is left alone");
    } finally {
      fs.rmSync(statePath(d.env.TUPAIA_OUT), { force: true });
      await d.stop();
    }
  });

  test("a daemon still starting: status says so; a start that takes too long is stopped", async () => {
    const env = safeEnv();
    const dummy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    try {
      fs.writeFileSync(
        path.join(env.TUPAIA_OUT, START_LOCK),
        JSON.stringify({ pid: process.pid, daemonPid: dummy.pid, at: Date.now() })
      );
      const st = await cli(["status"], env);
      assert.equal(st.code, 1);
      assert.match(st.stdout, new RegExp(`^starting: daemon pid ${dummy.pid} \\(started by pid ${process.pid}`));
    } finally {
      dummy.kill();
      fs.rmSync(path.join(env.TUPAIA_OUT, START_LOCK), { force: true });
    }
    const slow = await cli(["tools", "--names"], { ...env, TUPAIA_START_TIMEOUT_MS: "50" });
    assert.equal(slow.code, 2);
    assert.match(slow.stderr, /did not come up within 0\.05 s, so it was stopped/);
    assert.ok(await waitFor(() => !fs.existsSync(statePath(env.TUPAIA_OUT)), 30_000), "no daemon is left behind");
    assert.equal(fs.existsSync(path.join(env.TUPAIA_OUT, START_LOCK)), false);
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
      mcpUrl: "http://127.0.0.1:9/mcp",
      ports: [9],
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

  test("CLI helpers: input paths, error output, schema rendering", () => {
    const cwd = path.dirname(DEMO_MAP);
    assert.deepEqual(absolutizeInputs("load_map", { path: "demo.map" }, cwd), { path: DEMO_MAP });
    assert.deepEqual(absolutizeInputs("load_map", { path: "missing.map" }, cwd), { path: "missing.map" });
    assert.deepEqual(absolutizeInputs("save_map", { path: "demo.map" }, cwd), { path: "demo.map" });
    assert.deepEqual(absolutizeInputs("sketch", { action: "rebase", onto: { path: "demo.map" } }, cwd), {
      action: "rebase",
      onto: { path: DEMO_MAP }
    });
    const err = formatResult({
      isError: true,
      text: [
        'NOT_FOUND: no burg "x"\ncandidates: Oz (1)\n{"error":{"code":"NOT_FOUND","message":"no burg \\"x\\"","candidates":[{"i":1,"name":"Oz"}]},"notes":["n"]}'
      ],
      images: []
    });
    assert.deepEqual(err, ['ERROR NOT_FOUND: no burg "x"\ncandidates: Oz (1)', '{"notes":["n"]}']);
    assert.deepEqual(formatResult({ isError: false, text: ["{}"], images: ["/a.jpg"] }), ["{}", "IMAGE: /a.jpg"]);
    const root = { $defs: { P: { type: "object", properties: { x: { type: "number" } }, required: ["x"] } } };
    assert.equal(
      schemaType(
        {
          type: "object",
          properties: {
            a: { $ref: "#/$defs/P" },
            b: { type: "array", items: { anyOf: [{ type: "string" }, { const: 1 }] } }
          },
          required: ["a"]
        },
        root
      ),
      "{a: {x: number}, b?: (string | 1)[]}"
    );
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
    assert.deepEqual(
      mismatchWarnings(
        { envMode: "local", repoRoot: "/a", port: "5" },
        { pid: 1, port: 2, ports: [2, 5], mode: "local" }
      ),
      [],
      "an added port counts"
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
