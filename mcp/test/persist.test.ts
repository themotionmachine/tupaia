// dx/persist: idle shutdown never loses a sketch, its history or the lineage (item 1); lineage
// survives save_map -> load_map (item 2); screenshot files are never reused across servers
// (item 3). Unit tests for the trailer and the state store, then stdio servers and an --http
// daemon against the in-process fake Worker (test/fake-worker.ts). Never the live site.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import zlib from "node:zlib";
import { loadConfig } from "../src/config.ts";
import { ShotStore } from "../src/context.ts";
import { type DaemonState, readState } from "../src/daemon-state.ts";
import { checkTrailer, hmac, PROV_MARK, type ProvBlock, withTrailer } from "../src/map-provenance.ts";
import { SketchStore } from "../src/ops.ts";
import { writeNew } from "../src/paths.ts";
import { SnapshotStore } from "../src/snapshots.ts";
import { provenanceKey, StateStore } from "../src/state.ts";
import { FakeWorker } from "./fake-worker.ts";
import {
  alive,
  chromeDescendants,
  DEMO_MAP,
  errorBody,
  type Harness,
  MCP_ROOT,
  SERVER,
  safeEnv,
  startServer,
  textOf,
  waitFor
} from "./helpers.ts";

type Obj = Record<string, any>;

const tmp = (tag: string) => fs.mkdtempSync(path.join(os.tmpdir(), `tupaia-persist-${tag}-`));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const BLOCK: Omit<ProvBlock, "sha256" | "sig" | "v"> = {
  savedAt: "2026-10-10T00:00:00.000Z",
  by: "test",
  origin: "http://127.0.0.1:1",
  lineage: "shared",
  kind: "shared",
  seed: "1",
  base: { version: 3, updatedAt: "2026-10-09T00:00:00.000Z", updatedBy: "a@example.test", bytes: 10 },
  opsSince: 2,
  sketch: null
};

describe("persist: the .map provenance trailer", () => {
  const demo = fs.readFileSync(DEMO_MAP, "utf8");
  const key = crypto.randomBytes(32);

  test("valid: one extra last line after the app's lines, plain or gzip", () => {
    const file = withTrailer(demo, BLOCK, key);
    assert.ok(file.startsWith(demo));
    const lines = file.split("\r\n");
    assert.equal(lines.length, demo.split("\r\n").length + 1, "exactly one line added");
    assert.ok(lines[lines.length - 1].startsWith(PROV_MARK));
    assert.ok(!lines[lines.length - 1].includes("<"), "no '<' for the app's SVG regex");
    const c = checkTrailer(Buffer.from(file), key);
    assert.equal(c.status, "valid");
    assert.equal(c.status === "valid" && c.block.base?.version, 3);
    assert.equal(checkTrailer(zlib.gzipSync(file), key).status, "valid");
    assert.equal(checkTrailer(Buffer.from(demo), key).status, "none");
  });

  test("a modified map, a block copied onto another map, a forged or foreign block are not valid", () => {
    const file = withTrailer(demo, BLOCK, key);
    const modified = file.replace("Chanland", "Chanlanx");
    assert.equal(checkTrailer(Buffer.from(modified), key).status, "modified");
    const other = demo.replace("Chanland", "Otherland");
    const copied = other + file.slice(demo.length);
    assert.equal(checkTrailer(Buffer.from(copied), key).status, "modified");
    // the content hash recomputed for the other map, signed without this key
    const foreign = withTrailer(other, BLOCK, crypto.randomBytes(32));
    assert.equal(checkTrailer(Buffer.from(foreign), key).status, "foreign");
    // a hand-edited block (another base) with a matching content hash but the old signature
    const json = JSON.parse(file.slice(file.lastIndexOf(PROV_MARK) + PROV_MARK.length)) as ProvBlock;
    const forged = { ...json, base: { ...json.base, version: 9 } };
    const forgedFile = `${demo}\r\n${PROV_MARK}${JSON.stringify(forged)}`;
    assert.equal(checkTrailer(Buffer.from(forgedFile), key).status, "foreign");
    // only the key makes it valid again
    const { sig: _s, ...unsigned } = forged;
    const resigned = `${demo}\r\n${PROV_MARK}${JSON.stringify({ ...unsigned, sig: hmac(key, JSON.stringify(unsigned)) })}`;
    assert.equal(checkTrailer(Buffer.from(resigned), key).status, "valid");
  });
});

describe("persist: the state store (TUPAIA_OUT/state)", () => {
  test("round trip, caps (TUPAIA_SNAPSHOTS_MAX), unchanged = no write, tampering rejected, one owner", () => {
    const out = tmp("store");
    const cfg = loadConfig({ ...process.env, TUPAIA_OUT: out, TUPAIA_SNAPSHOTS_MAX: "3", TUPAIA_STATE: "" });
    const key = provenanceKey(out);
    assert.equal(fs.statSync(path.join(out, "state", "provenance.key")).mode & 0o777, 0o600);
    const store = new StateStore(cfg, key);
    assert.ok(store.claim());
    const snaps = new SnapshotStore(10, 10);
    snaps.setProvenance({ kind: "shared", sharedVersion: 5, mapId: 1 });
    for (let k = 1; k <= 4; k++) snaps.pushUndo("edit", "{}", `map text ${k}`);
    snaps.add("snapshot text", "lbl");
    snaps.setRestorePoint("page text", "the page", { writes: 0, launches: 0, callSeq: 1 });
    const sk = new SketchStore().begin({
      slug: "a",
      note: null,
      base: { kind: "shared", version: 5, at: "x" },
      baseText: "base text",
      baseCounts: { burgs: 1 }
    });
    assert.equal(store.save(snaps.exportState(), sk, 7, { transport: "stdio" }), true);
    assert.equal(store.save(snaps.exportState(), sk, 7, { transport: "stdio" }), false, "nothing changed");
    assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
    store.release();

    const again = new StateStore(cfg, key);
    assert.ok(again.claim());
    const r = again.load() as Obj;
    assert.ok(r && !r.error, JSON.stringify(r));
    assert.equal(r.pruned, 2, "4 undo + 1 snapshot over a cap of 3: the 2 oldest undo entries go");
    assert.deepEqual(
      r.history.undo.map((e: Obj) => e.text),
      ["map text 3", "map text 4"]
    );
    assert.equal(r.history.ring[0].text, "snapshot text");
    assert.equal(r.history.restorePoint.text, "page text");
    assert.equal(r.history.provenance.sharedVersion, 5);
    assert.equal(r.sketch.slug, "a");
    assert.equal(r.sketch.baseText, "base text");
    assert.equal(r.shotSeq, 7);
    // unreferenced blobs are pruned: page, snapshot, base and 2 undo texts remain
    assert.equal(fs.readdirSync(path.join(out, "state", "blobs")).length, 5);

    // an edited state.json is not resumed (and is kept aside)
    const raw = JSON.parse(fs.readFileSync(again.file, "utf8"));
    raw.history.provenance.sharedVersion = 99;
    fs.writeFileSync(again.file, JSON.stringify(raw));
    const bad = again.load() as Obj;
    assert.match(bad.error, /signature does not match/);
    assert.equal(fs.existsSync(again.file), false);
    again.release();

    // a live other process owns the dir: this one neither resumes nor persists
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    try {
      fs.writeFileSync(path.join(out, "state", "owner.json"), JSON.stringify({ pid: other.pid }));
      const third = new StateStore(cfg, key);
      assert.equal(third.claim(), false);
      assert.match(String(third.note), new RegExp(`another server \\(pid ${other.pid}\\)`));
    } finally {
      other.kill();
    }
  });

  test("screenshot ids continue after the highest file there; writeNew never replaces a file", () => {
    const dir = tmp("shots");
    for (const f of ["s1.png", "s3.png", "s7-vs-s2.jpg", "call-20261009T202120-1.jpg"])
      fs.writeFileSync(path.join(dir, f), "x");
    const shots = new ShotStore();
    shots.init(dir);
    assert.equal(shots.nextId(), "s8");
    shots.init(dir, 20);
    assert.equal(shots.nextId(), "s21");
    const a = path.join(dir, "call-20261009T202120-1.jpg");
    const b = writeNew(a, Buffer.from("new"));
    assert.equal(b, path.join(dir, "call-20261009T202120-1-2.jpg"));
    assert.equal(fs.readFileSync(a, "utf8"), "x");
  });
});

describe("persist item 3: screenshot files across servers (stdio)", () => {
  test("a restarted server continues at s2 and never overwrites s1; saveTo needs overwrite:true", async () => {
    const out = tmp("shots-e2e");
    let h: Harness = await startServer({ TUPAIA_OUT: out });
    try {
      const s1 = await h.ok("screenshot", { maxSide: 256 });
      assert.equal(s1.shotId, "s1");
      assert.equal(s1.file, path.join(out, "shots", "s1.png"));
      const before = fs.readFileSync(s1.file as string);
      // an explicit target that exists: refused without overwrite, replaced with it
      const refused = await h.call("screenshot", { maxSide: 256, saveTo: s1.file as string });
      assert.equal(errorBody(refused).error.code, "REFUSED");
      assert.ok(fs.readFileSync(s1.file as string).equals(before));
      await h.close();
      assert.ok(await waitFor(() => !alive(h.pid), 30_000), "the first server exits");
      h = await startServer({ TUPAIA_OUT: out });
      const s2 = await h.ok("screenshot", { maxSide: 256 });
      assert.equal(s2.shotId, "s2", "numbering continues across servers");
      assert.ok(fs.readFileSync(s1.file as string).equals(before), "s1.png is untouched");
      // a file someone else left at the next id is skipped, not replaced
      fs.writeFileSync(path.join(out, "shots", "s3.png"), "theirs");
      const s4 = await h.ok("screenshot", { maxSide: 256 });
      assert.equal(s4.shotId, "s4");
      assert.equal(fs.readFileSync(path.join(out, "shots", "s3.png"), "utf8"), "theirs");
      const own = await h.ok("screenshot", { maxSide: 256, saveTo: s1.file as string, overwrite: true });
      assert.equal(fs.realpathSync(own.file as string), fs.realpathSync(s1.file as string));
    } finally {
      await h.close();
    }
  });
});

describe("persist item 2: lineage through save_map -> load_map (local mode, fake Worker reads)", () => {
  let fake: FakeWorker;
  let h: Harness;
  let base = "";
  let edited = "";
  let out = "";

  before(async () => {
    fake = new FakeWorker({ seedFile: DEMO_MAP, version: 3 });
    const origin = await fake.start();
    h = await startServer({ TUPAIA_LIVE_ORIGIN: origin, TUPAIA_BUILD_CACHE_MS: "0" });
    out = h.env.TUPAIA_OUT;
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
    await fake?.stop();
  });

  const status = async () => (await h.ok("shared_status", {})).local as Obj;

  test("save_map embeds origin, base version, ops count and a content hash; the app loads the file", async () => {
    await h.ok("load_map", { source: "shared" });
    const b = await h.ok("save_map", { path: "lineage-base.map" });
    assert.match(String(b.lineage), /^shared v3, 0 op\(s\) since$/);
    base = b.path as string;
    await h.ok("edit", { type: "burg", ops: [{ ref: 1, set: { name: "Lineagetown" } }] });
    const e = await h.ok("save_map", { path: "lineage-edited.map" });
    assert.match(String(e.lineage), /^shared v3, 1 op\(s\) since$/);
    edited = e.path as string;
    const text = fs.readFileSync(edited, "utf8");
    const block = JSON.parse(text.slice(text.lastIndexOf(PROV_MARK) + PROV_MARK.length)) as ProvBlock;
    assert.equal(block.origin, fake.origin);
    assert.equal(block.base?.version, 3);
    assert.equal(block.opsSince, 1);
    assert.equal(block.base?.bytes, fs.statSync(DEMO_MAP).size);
    assert.equal(
      block.sha256,
      crypto
        .createHash("sha256")
        .update(text.slice(0, text.lastIndexOf(`\r\n${PROV_MARK}`)))
        .digest("hex")
    );
    assert.equal(e.sha256, block.sha256, "save_map's sha256 is the map text's (the provenance line excluded)");
    // unrelated in between
    await h.ok("load_map", { path: DEMO_MAP });
    assert.equal((await status()).lineage, "unrelated");
    const l = await h.ok("load_map", { path: edited });
    // the app read the file (trailer line and all): the edit is there
    const burg = await h.ok("eval", { code: "return pack.burgs[1].name", readOnly: true });
    assert.equal(burg.value, "Lineagetown");
    assert.equal((l.lineage as Obj).lineage, "shared");
    assert.equal((l.lineage as Obj).baseCheck, "verified");
    const s = await status();
    assert.equal(s.lineage, "shared");
    assert.equal(s.sharedVersion, 3);
    assert.equal(s.stale, false);
    assert.equal(s.opsSince, 1);
  });

  test("stale is computed against the file's base once the shared map moved on", async () => {
    fake.externalSave("other@example.test");
    const l = await h.ok("load_map", { path: edited });
    assert.equal((l.lineage as Obj).lineage, "shared");
    assert.equal((l.lineage as Obj).baseCheck, "verified", "retained v3 has the recorded size");
    const s = await status();
    assert.equal(s.lineage, "shared");
    assert.equal(s.sharedVersion, 3);
    assert.equal(s.stale, true);
  });

  test("a modified file, a copied block and a foreign signature stay unrelated", async () => {
    const text = fs.readFileSync(edited, "utf8");
    const modified = path.join(out, "lineage-modified.map");
    fs.writeFileSync(modified, text.replace("Lineagetown", "Lineagetowm"));
    const m = await h.ok("load_map", { path: modified });
    assert.equal((m.lineage as Obj).file, "modified");
    assert.equal((m.lineage as Obj).lineage, "unrelated");
    assert.equal((await status()).lineage, "unrelated");
    const demo = fs.readFileSync(DEMO_MAP, "utf8");
    const copied = path.join(out, "lineage-copied.map");
    fs.writeFileSync(copied, demo + text.slice(text.lastIndexOf(`\r\n${PROV_MARK}`)));
    assert.equal(((await h.ok("load_map", { path: copied })).lineage as Obj).file, "modified");
    assert.equal((await status()).lineage, "unrelated");
    const block = JSON.parse(text.slice(text.lastIndexOf(PROV_MARK) + PROV_MARK.length)) as ProvBlock;
    const { sig: _s, sha256: _h, v: _v, ...rest } = block;
    const foreign = path.join(out, "lineage-foreign.map");
    fs.writeFileSync(foreign, withTrailer(demo, rest, crypto.randomBytes(32)));
    const f = await h.ok("load_map", { path: foreign });
    assert.equal((f.lineage as Obj).file, "foreign");
    assert.equal((await status()).lineage, "unrelated");
    // a file without provenance (the app's own save) has no lineage field at all
    assert.equal((await h.ok("load_map", { path: DEMO_MAP })).lineage, undefined);
  });

  test("a base the server contradicts stays unrelated", async () => {
    fake.retained.set(3, { bytes: Buffer.from("not the v3 that was loaded"), saved_at: new Date().toISOString() });
    const l = await h.ok("load_map", { path: base });
    assert.equal((l.lineage as Obj).lineage, "unrelated");
    assert.equal((l.lineage as Obj).baseCheck, "mismatch");
    assert.match(String((l.lineage as Obj).note), /retained v3 is \d+ bytes/);
    assert.equal((await status()).lineage, "unrelated");
  });
});

// ---------------------------------------------------------------- item 1: the --http daemon

interface Daemon {
  child: ChildProcess;
  st: DaemonState;
  log: string[];
}

async function spawnDaemon(env: Record<string, string>): Promise<Daemon> {
  const child = spawn(process.execPath, [SERVER, "--http"], { env, cwd: MCP_ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const log: string[] = [];
  child.stdout?.on("data", d => log.push(String(d)));
  child.stderr?.on("data", d => {
    log.push(String(d));
    if (process.env.TUPAIA_TEST_VERBOSE) process.stderr.write(String(d));
  });
  await waitFor(() => readState(env.TUPAIA_OUT)?.pid === child.pid || child.exitCode !== null, 90_000);
  const st = readState(env.TUPAIA_OUT);
  if (!st || st.pid !== child.pid) throw new Error(`the daemon did not start: ${log.join("")}`);
  return { child, st, log };
}

function request(st: DaemonState, method: string, p: string, body?: unknown): Promise<{ status: number; json: Obj }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const r = http.request(
      {
        host: "127.0.0.1",
        port: st.port,
        method,
        path: p,
        headers: {
          authorization: `Bearer ${st.token}`,
          ...(data ? { "content-type": "application/json", "content-length": data.length } : {})
        }
      },
      res => {
        const chunks: Buffer[] = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString()) })
        );
      }
    );
    r.on("error", reject);
    r.end(data);
  });
}

/** A tool call over /call: the result JSON (and its notes), or throw with the error text. */
async function call(d: Daemon, name: string, args: Obj = {}): Promise<Obj> {
  const r = await request(d.st, "POST", "/call", { name, args });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  if (r.json.isError) throw new Error(`${name} failed: ${r.json.text.join("\n")}`);
  const value = JSON.parse(r.json.text[0]) as Obj;
  const notes = (r.json.text.slice(1) as string[]).map(t => JSON.parse(t) as Obj).flatMap(x => x.notes ?? []);
  return { ...value, _notes: [...(value.notes ?? []), ...notes] };
}

const health = async (d: Daemon) => (await request(d.st, "GET", "/health")).json;

async function ended(d: Daemon, ms: number): Promise<boolean> {
  return waitFor(() => d.child.exitCode !== null || d.child.signalCode !== null, ms);
}

describe("persist item 1: idle shutdown never loses a sketch, history or lineage (--http, fake Worker)", () => {
  let fake: FakeWorker;
  let out = "";
  let env: Record<string, string>;
  const daemons: Daemon[] = [];
  let exitFile = "";

  before(async () => {
    fake = new FakeWorker({ seedFile: DEMO_MAP, version: 7 });
    const origin = await fake.start();
    out = tmp("idle");
    env = safeEnv({
      TUPAIA_OUT: out,
      TUPAIA_MODE: "live",
      TUPAIA_LIVE_ORIGIN: origin,
      TUPAIA_BUILD_CACHE_MS: "0",
      // 1.8 s: short enough to see an idle exit in a test
      TUPAIA_HTTP_IDLE_MIN: "0.03"
    });
  });

  after(async () => {
    for (const d of daemons) {
      const kids = d.child.pid ? chromeDescendants(d.child.pid) : [];
      if (d.child.exitCode === null && d.child.signalCode === null) d.child.kill("SIGTERM");
      await ended(d, 30_000);
      for (const k of kids) if (alive(k)) process.kill(k, "SIGKILL");
    }
    await fake?.stop();
  });

  test("(a) an active, unsaved sketch holds idle shutdown off, and status says so", async () => {
    const d = await spawnDaemon(env);
    daemons.push(d);
    const s = await call(d, "session", { format: "json" });
    assert.match(String(s.idle?.note), /stops after 0\.03 min/);
    await call(d, "load_map", { source: "shared" });
    await call(d, "sketch", { action: "start", slug: "story-polish", note: "polish pass" });
    await call(d, "edit", { type: "burg", ops: [{ ref: 1, set: { name: "Polishtown" } }] });
    await call(d, "snapshot", { action: "take", label: "mid-pass" });
    await sleep(5000);
    assert.equal(d.child.exitCode, null, "still running after 2.7x the idle time");
    const h = await health(d);
    assert.match(String(h.idleHeldBy), /sketch 'story-polish' is recording \(1 op\(s\), unsaved\)/);
    assert.match(d.log.join(""), /idle shutdown held off: sketch 'story-polish'/);
    const sess = await call(d, "session", {});
    assert.match(String(sess.idle.note), /held off while sketch 'story-polish'/);
  });

  test("(b) after a crash, the next daemon resumes the sketch, snapshots and provenance on its own", async () => {
    const d1 = daemons[daemons.length - 1];
    const kids = chromeDescendants(d1.child.pid as number);
    d1.child.kill("SIGKILL");
    assert.ok(await ended(d1, 10_000));
    for (const k of kids) if (alive(k)) process.kill(k, "SIGKILL");
    const d = await spawnDaemon({ ...env, TUPAIA_HTTP_IDLE_MIN: "0" });
    daemons.push(d);
    const s = await call(d, "session", {});
    const notes = (s._notes as string[]).join("\n");
    assert.match(
      notes,
      /resumed .*state\.json .*sketch 'story-polish' \(base v7, 1 op\(s\), recording, unsaved\) is active again/
    );
    assert.equal(s.state.resumed.sketch, "story-polish");
    const sk = await call(d, "sketch", { action: "status" });
    assert.equal(sk.active, true);
    assert.equal(sk.recording, true);
    assert.equal(sk.ops, 1);
    const list = await call(d, "snapshot", { action: "list" });
    assert.deepEqual(
      (list.snapshots as Obj[]).map(x => x.label),
      ["mid-pass"]
    );
    const burg = await call(d, "eval", { code: "return pack.burgs[1].name", readOnly: true });
    assert.equal(burg.value, "Polishtown", "the page holds the sketch map again");
    const ss = await call(d, "shared_status", {});
    assert.equal(ss.local.lineage, "shared");
    assert.equal(ss.local.sharedVersion, 7);
    // sketch_promote previews without replaceWithUnrelated (no LINEAGE refusal)
    const p = await call(d, "sketch_promote", {});
    assert.equal(p.preview, true);
    assert.equal(typeof p.token, "string", JSON.stringify(p.refusalReason));
    assert.equal(p.lineage.related, true);
    // undo still works across the restart: it takes the edit back out of the sketch
    const u = await call(d, "snapshot", { action: "undo" });
    assert.match((u._notes as string[]).join(" "), /op 1 \(edit\) removed from the log/);
    await call(d, "snapshot", { action: "redo" });
    assert.equal((await call(d, "sketch", { action: "status" })).ops, 1);
  });

  test("(b) a saved, stopped sketch lets it idle-exit; the exit file and the state carry everything", async () => {
    const d1 = daemons[daemons.length - 1];
    await call(d1, "sketch", { action: "stop" });
    await call(d1, "sketch", { action: "save", confirm: true });
    assert.equal((await health(d1)).idleHeldBy, undefined);
    await request(d1.st, "POST", "/shutdown", {});
    assert.ok(await ended(d1, 40_000));
    // the same daemon env with idle on: nothing holds it, so it exits by itself
    const d = await spawnDaemon(env);
    daemons.push(d);
    const s = await call(d, "session", {});
    assert.match((s._notes as string[]).join("\n"), /sketch 'story-polish' \(base v7, 1 op\(s\), stopped, saved\)/);
    assert.ok(await ended(d, 30_000), "a clean (saved) sketch does not hold idle shutdown");
    assert.match(d.log.join(""), /idle for 0\.03 min/);
    const last = JSON.parse(fs.readFileSync(path.join(out, "daemon.last.json"), "utf8")) as Obj;
    exitFile = last.savedMap;
    assert.match(exitFile, /maps\/daemon-exit-\d+T\d+(-\d+)?\.map$/);
    const c = checkTrailer(fs.readFileSync(exitFile), provenanceKey(out));
    assert.equal(c.status, "valid");
    assert.equal(c.status === "valid" && c.block.sketch?.slug, "story-polish");
    assert.equal(c.status === "valid" && c.block.base?.version, 7);
  });

  test("(c) loading the daemon's own exit file restores 'sketch <slug>, base vN': sketch_promote works without replaceWithUnrelated", async () => {
    // the 2026-10-09 case: the state is gone, only the exit file is left
    fs.renameSync(path.join(out, "state", "state.json"), path.join(out, "state", "state.json.gone"));
    const d = await spawnDaemon({ ...env, TUPAIA_HTTP_IDLE_MIN: "0" });
    daemons.push(d);
    const l = await call(d, "load_map", { path: exitFile });
    assert.equal(l.lineage.lineage, "shared");
    assert.equal(l.lineage.sketch, "story-polish");
    assert.equal(l.origin.kind, "sketch");
    assert.equal(l.origin.sketchSlug, "story-polish");
    assert.equal(l.origin.sharedVersion, 7);
    assert.match(
      (l._notes as string[]).join(" "),
      /sketch 'story-polish' is active again from the file \(base v7, 1 op\(s\), stopped\)/
    );
    const sk = await call(d, "sketch", { action: "status" });
    assert.equal(sk.active, true);
    assert.equal(sk.ops, 1);
    assert.equal(sk.blobOnly, false, "the log came back with the file: still replayable");
    const ss = await call(d, "shared_status", {});
    assert.equal(ss.local.lineage, "shared");
    assert.match(String(ss.local.lineageNote), /via sketch 'story-polish'/);
    fake.clearLog();
    const p = await call(d, "sketch_promote", {});
    assert.equal(typeof p.token, "string", JSON.stringify(p.refusalReason));
    const r = await call(d, "sketch_promote", { confirm: true, token: p.token });
    assert.equal(r.saved.version, 8);
    assert.equal(fake.row.version, 8);
    assert.deepEqual(
      fake.writes().map(w => `${w.method} ${w.path}`),
      ["PUT /api/map/shared", "PUT /api/map/sketch-story-polish/ops"]
    );
    assert.equal(r.overrides, undefined, "no replaceWithUnrelated, no force");
  });
});

describe("persist item 1: the stdio server saves and resumes the same way", () => {
  test("transport closed: stdio-exit file with provenance, then the next stdio server resumes", async () => {
    const out = tmp("stdio");
    let h = await startServer({ TUPAIA_OUT: out });
    try {
      await h.ok("load_map", { path: DEMO_MAP });
      await h.ok("edit", { type: "burg", ops: [{ ref: 2, set: { name: "Stdiotown" } }] });
      await h.close();
      assert.ok(await waitFor(() => !alive(h.pid), 30_000));
      const last = JSON.parse(fs.readFileSync(path.join(out, "daemon.last.json"), "utf8")) as Obj;
      assert.equal(last.transport, "stdio");
      assert.match(last.savedMap, /maps\/stdio-exit-\d+T\d+\.map$/);
      assert.equal(checkTrailer(fs.readFileSync(last.savedMap), provenanceKey(out)).status, "valid");
      h = await startServer({ TUPAIA_OUT: out });
      const r = await h.call("session", {});
      assert.match(textOf(r), /resumed .*the page at exit \(transport closed\)/);
      const name = await h.ok("eval", { code: "return pack.burgs[2].name", readOnly: true });
      assert.equal(name.value, "Stdiotown");
      const list = await h.ok("snapshot", { action: "list" });
      assert.equal((list.undo as Obj[]).length, 2, "load_map and edit can still be undone");
    } finally {
      await h.close();
    }
  });
});
