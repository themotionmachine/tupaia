// Shared-map tools against the in-process fake Worker (verification plan section 3, adapted to
// the token gate). Never talks to the live site: every server here points TUPAIA_LIVE_ORIGIN
// at the fake on 127.0.0.1, and safeEnv refuses activationlayer.org.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { FakeWorker } from "./fake-worker.ts";
import { alive, DEMO_MAP, errorBody, type Harness, REPO_ROOT, safeEnv, startServer } from "./helpers.ts";

const LOCAL_ENTRY = /src="\/(index-[^"]+\.js)"/.exec(
  fs.readFileSync(path.join(REPO_ROOT, "dist", "index.html"), "utf8")
)?.[1];

function onlyLoopback(s: Record<string, unknown>): void {
  const reqs = s.outwardRequests as Array<{ url: string }>;
  for (const r of reqs) assert.match(r.url, /^http:\/\/127\.0\.0\.1:\d+\//, `outward request to ${r.url}`);
}

describe("helpers guard", () => {
  test("safeEnv refuses the live origin", () => {
    assert.throws(() => safeEnv({ TUPAIA_LIVE_ORIGIN: "https://map.activationlayer.org" }), /never touch the live/);
    assert.throws(
      () => safeEnv({ TUPAIA_MODE: "live", TUPAIA_LIVE_ORIGIN: "https://MAP.ActivationLayer.org/" }),
      /live/
    );
  });
});

describe("shared tools in local mode", () => {
  let fake: FakeWorker;
  let h: Harness;

  before(async () => {
    fake = new FakeWorker({ seedFile: DEMO_MAP, version: 3, entry: LOCAL_ENTRY });
    const origin = await fake.start();
    h = await startServer({ TUPAIA_LIVE_ORIGIN: origin });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
    await fake?.stop();
  });

  test("shared_status reads version 3 with one GET and without launching the browser", async () => {
    fake.clearLog();
    const s = await h.ok("shared_status", {});
    assert.equal((s.meta as { version: number }).version, 3);
    assert.equal(s.mode, "local");
    assert.equal(s.writesEnabled, false);
    // local mode default: the meta GET only, no build check
    assert.deepEqual(
      fake.requests.map(r => `${r.method} ${r.path}`),
      ["GET /api/map/shared/meta"]
    );
    assert.equal(s.buildMatch, null);
    assert.equal((s.build as { verdict: string }).verdict, "skipped");
    const b = await h.ok("shared_status", { build: true });
    assert.equal(b.buildMatch, true);
    assert.ok(fake.requests.some(r => r.path === "/versioning.js"));
    assert.equal((s.local as { browser: string }).browser, "not-launched");
    const withVersions = await h.ok("shared_status", { versions: true });
    const v = withVersions.versions as { current: number; snapshots: Array<{ version: number }> };
    assert.equal(v.current, 3);
    assert.deepEqual(
      v.snapshots.map(x => x.version),
      [2, 1]
    );
  });

  test("load_map {source:'shared'} records sharedVersion 3", async () => {
    const r = await h.ok("load_map", { source: "shared" });
    assert.equal(r.name, "Chanland");
    const origin = r.origin as { kind: string; sharedVersion: number };
    assert.equal(origin.kind, "shared");
    assert.equal(origin.sharedVersion, 3);
    const s = await h.ok("shared_status", {});
    const local = s.local as { lineage: string; stale: boolean };
    assert.equal(local.lineage, "shared");
    assert.equal(local.stale, false);
  });

  test("shared_save and shared_restore are refused with MODE (preview and confirm)", async () => {
    for (const [name, args] of [
      ["shared_save", {}],
      ["shared_save", { confirm: true, token: "deadbeefdeadbeef" }],
      ["shared_restore", { version: 2 }],
      ["shared_restore", { version: 2, confirm: true, token: "x", expectCurrent: 3 }]
    ] as const) {
      const r = await h.call(name, args);
      assert.equal(r.isError, true, name);
      assert.equal(errorBody(r).error.code, "MODE", `${name} ${JSON.stringify(args)}`);
      assert.match(errorBody(r).error.message, /local mode/);
    }
  });

  test("the fake saw only GETs; outward log is loopback only", async () => {
    assert.deepEqual(fake.writes(), []);
    assert.ok(fake.requests.length > 0);
    const s = await h.ok("session", { action: "status" });
    onlyLoopback(s);
    assert.ok((s.outwardRequests as unknown[]).length > 0);
  });
});

describe("shared tools in live mode (fake Worker)", () => {
  let fake: FakeWorker;
  let h: Harness;
  const puts = () => fake.requests.filter(r => r.method === "PUT");

  before(async () => {
    fake = new FakeWorker({ seedFile: DEMO_MAP, version: 3, entry: LOCAL_ENTRY });
    const origin = await fake.start();
    h = await startServer({ TUPAIA_MODE: "live", TUPAIA_LIVE_ORIGIN: origin, TUPAIA_BUILD_CACHE_MS: "0" });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
    await fake?.stop();
  });

  test("the first launch in live mode loads the shared map v3", async () => {
    const s = await h.ok("session", { action: "status" });
    assert.equal(s.mode, "live");
    assert.ok(
      (s.notes as string[]).some(n => /loaded the shared map v3/.test(n)),
      JSON.stringify(s.notes)
    );
    const origin = (s.map as { origin: { kind: string; sharedVersion: number } }).origin;
    assert.equal(origin.kind, "shared");
    assert.equal(origin.sharedVersion, 3);
  });

  test("preview: wouldOverwrite v3, a token, no PUT; confirm without token is refused", async () => {
    const p = await h.ok("shared_save", {});
    assert.equal(p.preview, true);
    assert.equal((p.wouldOverwrite as { version: number }).version, 3);
    assert.equal(typeof p.token, "string");
    assert.equal(p.refusalReason, undefined);
    assert.equal((p.lineage as { related: boolean }).related, true);
    assert.equal(p.stale, false);
    assert.equal((p.buildCheck as { verdict: string }).verdict, "ok");
    assert.equal(puts().length, 0);
    const noToken = await h.call("shared_save", { confirm: true });
    assert.equal(errorBody(noToken).error.code, "REFUSED");
    assert.match(errorBody(noToken).error.message, /token/);
    const badToken = await h.call("shared_save", { confirm: true, token: "0000000000000000" });
    assert.equal(errorBody(badToken).error.code, "REFUSED");
    assert.equal(puts().length, 0);
  });

  let usedToken = "";
  test("confirm with the token: exactly one PUT with X-Map-Version 3 and no overwrite header", async () => {
    const p = await h.ok("shared_save", {});
    usedToken = p.token as string;
    fake.clearLog();
    const r = await h.ok("shared_save", { confirm: true, token: usedToken });
    assert.equal((r.saved as { version: number }).version, 4);
    assert.equal(puts().length, 1);
    const put = puts()[0];
    assert.equal(put.headers["x-map-version"], "3");
    assert.equal(put.headers["x-map-overwrite"], undefined);
    assert.ok(put.bytes > 1_000_000);
    // the backup GET of the live blob happened before the PUT
    const order = fake.requests.map(q => `${q.method} ${q.path}`);
    assert.ok(order.indexOf("GET /api/map/shared") < order.indexOf("PUT /api/map/shared"), order.join(", "));
    const backup = r.backup as { live: string; outgoing: string };
    assert.ok(fs.statSync(backup.live).size > 1_000_000);
    assert.ok(fs.statSync(backup.outgoing).size > 1_000_000);
    assert.match(backup.live, /shared-saves\/v3-live-/);
    assert.equal(fs.readFileSync(backup.outgoing).equals(fake.current), true, "outgoing backup equals what was PUT");
    assert.equal((r.origin as { sharedVersion: number }).sharedVersion, 4);
    assert.equal(fake.row.version, 4);
  });

  test("a used token is refused", async () => {
    const r = await h.call("shared_save", { confirm: true, token: usedToken });
    assert.equal(errorBody(r).error.code, "REFUSED");
    assert.match(errorBody(r).error.message, /already used/);
    assert.equal(puts().length, 1);
  });

  test("a token is void when the page map changes after the preview", async () => {
    const p = await h.ok("shared_save", {});
    await h.ok("eval", { code: "pack.burgs[1].name = 'Changedburg'; return 1" });
    const r = await h.call("shared_save", { confirm: true, token: p.token as string });
    assert.equal(errorBody(r).error.code, "REFUSED");
    assert.match(errorBody(r).error.message, /map in the page changed/);
    assert.equal(puts().length, 1);
  });

  test("stale: someone saved v5, preview refuses and confirm is STALE with no PUT", async () => {
    const tokenBefore = (await h.ok("shared_save", {})).token as string;
    fake.externalSave("alice@example.test");
    assert.equal(fake.row.version, 5);
    const st = await h.ok("shared_status", {});
    assert.equal((st.local as { stale: boolean }).stale, true);
    const p = await h.ok("shared_save", {});
    assert.equal(p.token, null);
    assert.match(String(p.refusalReason), /STALE/);
    assert.match(String(p.refusalReason), /alice@example\.test/);
    const r = await h.call("shared_save", { confirm: true, token: tokenBefore });
    assert.equal(errorBody(r).error.code, "STALE");
    assert.match(errorBody(r).error.message, /v5/);
    assert.match(errorBody(r).error.message, /alice@example\.test/);
    assert.equal(puts().length, 1);
  });

  test("force (previewed with force) sends X-Map-Version 5 and still no overwrite header", async () => {
    const p = await h.ok("shared_save", { force: true });
    assert.equal(typeof p.token, "string");
    assert.ok((p.overrides as string[]).some(o => /force/.test(o)));
    const mismatch = await h.call("shared_save", { confirm: true, token: p.token as string });
    assert.equal(errorBody(mismatch).error.code, "STALE", "confirm without the same flags is still stale");
    const r = await h.ok("shared_save", { confirm: true, token: p.token as string, force: true });
    assert.equal((r.saved as { version: number }).version, 6);
    const last = puts()[puts().length - 1];
    assert.equal(last.headers["x-map-version"], "5");
    assert.equal(last.headers["x-map-overwrite"], undefined);
  });

  test("a 409 from the Worker becomes CONFLICT with its body", async () => {
    const p = await h.ok("shared_save", {});
    fake.fail409Once();
    const r = await h.call("shared_save", { confirm: true, token: p.token as string });
    assert.equal(r.isError, true);
    const body = errorBody(r) as unknown as {
      error: { code: string; details: { body: { error: string; version: number }; backup: { live: string } } };
    };
    assert.equal(body.error.code, "CONFLICT");
    assert.equal(body.error.details.body.error, "conflict");
    assert.equal(body.error.details.body.version, 6);
    assert.ok(fs.existsSync(body.error.details.backup.live));
    assert.equal(fake.row.version, 6);
  });

  test("someone's lock refuses unless forced", async () => {
    fake.setLock("bob@example.test");
    const p = await h.ok("shared_save", {});
    assert.match(String(p.refusalReason), /LOCKED/);
    assert.match(String(p.refusalReason), /bob@example\.test/);
    fake.setLock(null);
  });

  test("build: a local VERSION newer than live is blocked, even with force; an entry mismatch warns", async () => {
    fake.appVersion = "1.129.9";
    const p = await h.ok("shared_save", { force: true });
    assert.equal(p.token, null);
    assert.match(String(p.refusalReason), /BUILD/);
    assert.match(String(p.refusalReason), /unloadable/);
    const r = await h.call("shared_save", { confirm: true, force: true, token: "0000000000000000" });
    assert.equal(errorBody(r).error.code, "BUILD");
    fake.appVersion = "1.130.1";
    fake.entry = "index-OTHER.js";
    const w = await h.ok("shared_save", {});
    assert.equal((w.buildCheck as { verdict: string }).verdict, "warn");
    assert.equal(typeof w.token, "string");
    fake.entry = LOCAL_ENTRY ?? "index-FAKE.js";
  });

  test("an unverifiable build is refused even with force; only skipBuildCheck lets the preview through", async () => {
    fake.versioningStatus = 503;
    try {
      const f = await h.ok("shared_save", { force: true });
      assert.equal(f.token, null);
      assert.equal((f.buildCheck as { verdict: string }).verdict, "unknown");
      assert.match(String(f.refusalReason), /BUILD/);
      assert.match(String(f.refusalReason), /skipBuildCheck/);
      const s = await h.ok("shared_save", { skipBuildCheck: true });
      assert.equal(typeof s.token, "string");
      assert.ok((s.overrides as string[]).some(o => /skipBuildCheck/.test(o)));
      // confirming without the flag is refused (BUILD), and nothing is written
      const c = await h.call("shared_save", { confirm: true, token: s.token as string });
      assert.equal(errorBody(c).error.code, "BUILD");
      const cf = await h.call("shared_save", { confirm: true, token: s.token as string, force: true });
      assert.equal(errorBody(cf).error.code, "BUILD");
      assert.equal(puts().length, 3);
    } finally {
      fake.versioningStatus = null;
    }
  });

  test("an eval that replaces the map drops lineage (map id), and undo brings it back", async () => {
    const before = await h.ok("shared_status", {});
    assert.equal((before.local as { lineage: string }).lineage, "shared");
    const ev = await h.ok("eval", {
      code: "await generate({ seed: 'lineage-eval' }); return mapId",
      timeoutMs: 60_000
    });
    assert.ok(
      (ev.notes as string[]).some(n => /replaced the map/.test(n)),
      JSON.stringify(ev.notes)
    );
    const after = await h.ok("shared_status", {});
    const local = after.local as { lineage: string; originKind: string };
    assert.equal(local.lineage, "unrelated");
    assert.equal(local.originKind, "unknown");
    const p = await h.ok("shared_save", {});
    assert.equal(p.token, null);
    assert.match(String(p.refusalReason), /LINEAGE/);
    await h.ok("snapshot", { action: "undo" });
    const back = await h.ok("shared_status", {});
    assert.equal((back.local as { lineage: string }).lineage, "shared");
    assert.equal(puts().length, 3);
  });

  test("an unrelated (generated) map is refused without replaceWithUnrelated; force does not help", async () => {
    await h.ok("generate_map", { seed: "shared-unrelated", template: "continents", cells: 2, states: 5, cultures: 4 });
    const p = await h.ok("shared_save", {});
    assert.equal(p.token, null);
    assert.match(String(p.refusalReason), /LINEAGE/);
    assert.match(String(p.refusalReason), /generated/);
    const f = await h.ok("shared_save", { force: true });
    assert.match(String(f.refusalReason), /LINEAGE/);
    const c = await h.call("shared_save", { confirm: true, force: true, token: "0000000000000000" });
    assert.equal(errorBody(c).error.code, "LINEAGE");
    const ok = await h.ok("shared_save", { replaceWithUnrelated: true });
    assert.equal(typeof ok.token, "string");
    assert.ok((ok.overrides as string[]).some(o => /unrelated/.test(o)));
    const saved = await h.ok("shared_save", { confirm: true, token: ok.token as string, replaceWithUnrelated: true });
    assert.equal((saved.saved as { version: number }).version, 7);
    assert.equal(puts()[puts().length - 1].headers["x-map-version"], "6");
  });

  test("shared_restore: preview, expectCurrent mismatch refused, confirm restores and reloads", async () => {
    const st = await h.ok("shared_status", { versions: true });
    const vs = (st.versions as { snapshots: Array<{ version: number }> }).snapshots.map(s => s.version);
    assert.ok(vs.includes(2) && vs.includes(6), vs.join(","));
    const missing = await h.call("shared_restore", { version: 999 });
    assert.equal(errorBody(missing).error.code, "NOT_FOUND");

    const p = await h.ok("shared_restore", { version: 2 });
    assert.equal((p.current as { version: number }).version, 7);
    assert.equal((p.target as { version: number }).version, 2);
    const token = p.token as string;
    assert.equal(typeof token, "string");
    const noExpect = await h.call("shared_restore", { version: 2, confirm: true, token });
    assert.equal(errorBody(noExpect).error.code, "BAD_ARGS");
    const wrong = await h.call("shared_restore", { version: 2, confirm: true, token, expectCurrent: 6 });
    assert.equal(errorBody(wrong).error.code, "STALE");
    assert.equal(fake.requests.filter(r => r.method === "POST").length, 0);
    const otherTarget = await h.call("shared_restore", { version: 3, confirm: true, token, expectCurrent: 7 });
    assert.equal(errorBody(otherTarget).error.code, "REFUSED");

    const r = await h.ok("shared_restore", { version: 2, confirm: true, token, expectCurrent: 7 });
    assert.equal((r.restored as { version: number; restored_from: number }).version, 8);
    assert.equal((r.restored as { restored_from: number }).restored_from, 2);
    const posts = fake.requests.filter(q => q.method === "POST");
    assert.deepEqual(
      posts.map(q => q.path),
      ["/api/map/shared/restore?v=2"]
    );
    const reloaded = r.reloaded as { name: string; sharedVersion: number };
    assert.equal(reloaded.name, "Chanland");
    assert.equal(reloaded.sharedVersion, 8);
    assert.equal((r.origin as { sharedVersion: number }).sharedVersion, 8);
    const again = await h.call("shared_restore", { version: 2, confirm: true, token, expectCurrent: 8 });
    assert.equal(errorBody(again).error.code, "REFUSED");
  });

  test("the fake saw exactly the expected writes; never an overwrite header", async () => {
    const writes = fake.writes().map(r => `${r.method} ${r.path} v=${r.headers["x-map-version"] ?? "-"}`);
    assert.deepEqual(writes, [
      "PUT /api/map/shared v=3",
      "PUT /api/map/shared v=5",
      "PUT /api/map/shared v=6",
      "PUT /api/map/shared v=6",
      "POST /api/map/shared/restore?v=2 v=-"
    ]);
    for (const r of fake.requests) assert.equal(r.headers["x-map-overwrite"], undefined);
    const s = await h.ok("session", { action: "status" });
    onlyLoopback(s);
  });

  test("dropping to local mode turns shared writes off for good", async () => {
    await h.ok("session", { action: "set_mode", mode: "local" });
    const r = await h.call("shared_save", {});
    assert.equal(errorBody(r).error.code, "MODE");
    const live = await h.call("session", { action: "set_mode", mode: "live" });
    assert.equal(live.isError, true);
  });
});
