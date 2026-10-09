// Reliability of sessions, history and results (core-1):
// - a cancelled sketch summary puts the sketch map back (cleanups never run under the signal);
// - a relaunch restores the state the newest finished call left (the restore point), and a
//   read-only call that stalls does not cost the map when the page answers again;
// - a failed undo/redo/restore load puts the page back and says so;
// - consoleErrors are folded and capped in every result;
// - map_info against a baseline from a different map is a short summary; big diffs are compact;
// - an unsaved local sketch can be discarded without live mode;
// - compact one-line status for session, shared_status and sketch.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { compactChanges, compactSession, compactSharedStatus, compactSketchStatus } from "../src/compact.ts";
import { CallScope, type ToolContext } from "../src/context.ts";
import { summarizeConsole } from "../src/result.ts";
import { SnapshotStore } from "../src/snapshots.ts";
import { FakeWorker } from "./fake-worker.ts";
import { alive, DEMO_MAP, errorBody, type Harness, startServer, textOf, waitFor } from "./helpers.ts";

const marks = { writes: 0, launches: 1, callSeq: 1 };

describe("pure: console summary, restore points, epochs, compact status", () => {
  test("summarizeConsole folds repeats, ranks them, caps distinct messages and long texts", () => {
    const list = [
      ...Array.from({ length: 100 }, (_, k) => `distinct error ${k}`),
      ...Array.from({ length: 50 }, () => "same error"),
      "x".repeat(5000)
    ];
    const out = summarizeConsole(list);
    assert.equal(out.length, 9, JSON.stringify(out));
    assert.equal(out[0], "same error (x50)");
    assert.match(
      out[8],
      /^\+94 more distinct message\(s\) \(94 of 151 errors not shown\); session \{action:'status'\}/
    );
    assert.ok(JSON.stringify(out).length < 1200, `${JSON.stringify(out).length} chars`);
    assert.deepEqual(summarizeConsole([]), []);
    assert.deepEqual(summarizeConsole(["a", "b", "a"]), ["a (x2)", "b"]);
    const long = summarizeConsole(["y".repeat(1000)]);
    assert.ok(long[0].length < 320 && long[0].endsWith("…(+701)"), long[0].slice(-20));
  });

  test("the restore point is restored when it is the newest state, and loses nothing", () => {
    const s = new SnapshotStore(5, 10);
    assert.equal(s.newestRestorable(), undefined);
    s.pushUndo("edit", "{}", "MAP-0");
    s.setRestorePoint("MAP-1", "after edit", marks);
    const r = s.newestRestorable();
    assert.equal(r?.kind, "point");
    assert.equal(r?.text, "MAP-1");
    assert.deepEqual(r?.lostOps, []);
    assert.ok(s.restorePointIsNewest);
    // a newer undo entry (a call that then timed out) wins: that call's effects are lost, no more
    s.pushUndo("eval", "{}", "MAP-1");
    const u = s.newestRestorable();
    assert.equal(u?.kind, "undo");
    assert.deepEqual(u?.lostOps, ["eval {}"]);
    // a newer snapshot wins over an older point
    s.setRestorePoint("MAP-2", "after eval", marks);
    s.add("MAP-2b", "snap");
    assert.equal(s.newestRestorable()?.kind, "snapshot");
    // undo commits a different page state: the old point is dropped
    s.setRestorePoint("MAP-3", "later", marks);
    const plan = s.planUndo(1, "MAP-3");
    assert.ok(plan);
    s.commitUndo(plan);
    assert.equal(s.restorePoint, null);
    assert.notEqual(s.newestRestorable()?.kind, "point");
    // restoring the point keeps the redo stack (it was taken against that same state)
    s.setRestorePoint("MAP-4", "after undo", marks);
    assert.equal(s.redoStack.length, 1);
    assert.deepEqual(s.afterRestore("point"), []);
    assert.equal(s.redoStack.length, 1);
    // popUndo only drops the given top entry
    const { entry } = s.pushUndo("restore", "{}", "MAP-4");
    assert.equal(s.popUndo(entry.id + 1), null);
    assert.equal(s.popUndo(entry.id), entry.baselineKey);
  });

  test("epochs: a new map gets a new one, relabelling keeps it; baselines carry theirs", () => {
    const s = new SnapshotStore(5, 10);
    const e0 = s.provenance.epoch;
    s.pushUndo("edit", "{}", "A");
    const k0 = s.undoStack[0].baselineKey;
    s.setProvenance({ kind: "file", path: "/x.map" });
    const e1 = s.provenance.epoch;
    assert.notEqual(e1, e0);
    s.setProvenance({ kind: "unknown", mapId: 3 }, { sameMap: true });
    assert.equal(s.provenance.epoch, e1);
    assert.equal(s.epochOf(k0), e0);
    const { snap } = s.add("B", "b");
    assert.equal(s.epochOf(snap.baselineKey), e1);
    s.checkpointEpoch = e1;
    assert.equal(s.epochOf("checkpoint"), e1);
    assert.equal(s.epochOf("undo:999"), undefined);
    // undo back across the load: the provenance (and epoch) of the loaded state comes back
    s.pushUndo("edit", "{}", "B");
    const plan = s.planUndo(2, "C");
    assert.ok(plan);
    s.commitUndo(plan);
    assert.equal(s.provenance.epoch, e0);
    assert.equal(s.epochOf(s.redoStack[0].baselineKey), e1, "redo entries hold the later state's epoch");
  });

  test("cleanup calls drop the caller's signal, get a fresh budget, and skip a page marked for relaunch", async () => {
    const seen: Array<{ name: string; timeoutMs: number; signal?: AbortSignal }> = [];
    const browser = {
      consoleSeq: 0,
      dirty: null as string | null,
      dirtyReadOnly: false,
      probeAnswers: false,
      async probe() {
        return this.probeAnswers;
      },
      async callBridge(name: string, _args: unknown, o: { timeoutMs: number; signal?: AbortSignal }) {
        seen.push({ name, timeoutMs: o.timeoutMs, signal: o.signal });
        return { ok: true, value: {}, ms: 0, op: null };
      }
    };
    const ac = new AbortController();
    ac.abort();
    const scope = new CallScope({ browser } as unknown as ToolContext, ac.signal, "read", 2000, "t");
    await scope.call("plain");
    await scope.cleanup(() => scope.call("tidy"));
    assert.equal(seen[0].signal, ac.signal);
    assert.ok(seen[0].timeoutMs <= 2000);
    assert.equal(seen[1].signal, undefined, "no cancellation in cleanup");
    assert.ok(seen[1].timeoutMs >= 60_000, "cleanup budget");
    // a page a mutating stall marked: cleanup steps are skipped at once
    browser.dirty = "edit timed out";
    await assert.rejects(
      scope.cleanup(() => scope.call("tidy")),
      /tidy skipped: the page is marked for a relaunch/
    );
    // a read-only stall mark: skipped unless the page answers a probe, which clears the mark
    browser.dirtyReadOnly = true;
    await assert.rejects(
      scope.cleanup(() => scope.call("tidy")),
      /skipped/
    );
    browser.probeAnswers = true;
    await scope.cleanup(() => scope.call("tidy"));
    assert.equal(browser.dirty, null);
    assert.equal(seen.length, 3);
  });

  test("compactChanges takes its own threshold and sample", () => {
    const changes = {
      burg: {
        counts: { added: 0, removed: 0, modified: 30 },
        modified: Array.from({ length: 30 }, (_, i) => ({ i }))
      }
    };
    const whole = compactChanges(changes, { fullMax: 30 }) as { burg: { modified: unknown[] } };
    assert.equal(whole.burg.modified.length, 30);
    const cut = compactChanges(changes, { fullMax: 25, sample: 2 }) as {
      burg: { modified: unknown[]; more: { modified: number } };
    };
    assert.equal(cut.burg.modified.length, 2);
    assert.deepEqual(cut.burg.more, { modified: 28 });
  });

  test("compact status lines", () => {
    const sess = compactSession({
      mode: "local",
      browser: "ready",
      launches: 2,
      appVersion: "1.108.9",
      lastRelaunch: { reason: "eval timed out", at: "t" },
      map: {
        name: "Chanland",
        seed: "123",
        cells: 9000,
        origin: { kind: "file", path: "/a/b/demo.map" },
        opsSince: 2,
        customization: 0
      },
      snapshots: 1,
      undoDepth: 3,
      redoDepth: 0,
      shots: 0,
      consoleErrors: [{}, {}],
      outwardRequests: [],
      blockedRequests: { count: 4, recent: [] }
    });
    assert.equal(
      sess,
      'session mode=local browser=ready launches=2 app=1.108.9 map=Chanland seed=123 cells=9000 origin="file demo.map" opsSince=2 snapshots=1 undo=3 redo=0 shots=0 consoleErrors=2 outward=0 blocked=4 lastRelaunch="eval timed out"'
    );
    const shared = compactSharedStatus({
      mode: "local",
      writesEnabled: false,
      meta: { version: 42, name: "World", updated_by: "ryan", updated_at: "2026-10-01", editing_by: null },
      local: {
        browser: "ready",
        originKind: "shared",
        origin: { kind: "shared", sharedVersion: 41 },
        lineage: "shared",
        sharedVersion: 41,
        stale: true,
        opsSince: 3
      },
      build: { verdict: "skipped" },
      versions: { current: 42, snapshots: [{ version: 41, size: 1, saved_at: "2026-09-30" }] }
    });
    assert.equal(
      shared,
      'shared v42 name=World by=ryan at=2026-10-01 lock=none | page lineage=shared base=v41 origin="shared v41" stale opsSince=3 browser=ready | mode=local writes=off build=skipped\nversions: v41 2026-09-30'
    );
    assert.match(compactSharedStatus({ meta: null, local: {}, mode: "local" }), /^shared none \(404\) \| page/);
    const view = {
      active: true,
      slug: "rivers-north",
      recording: true,
      base: { kind: "shared", version: 42 },
      ops: 2,
      blobOnly: false,
      redoAvailable: 0,
      lastSaved: null,
      dirty: true,
      log: [
        { seq: 1, tool: "edit", summary: "Renamed burg 3 to X." },
        { seq: 2, tool: "add", summary: "Added marker 7." }
      ]
    };
    assert.equal(
      compactSketchStatus(view),
      'sketch rivers-north recording base="shared v42" ops=2 dirty saved=never last="2. Added marker 7."'
    );
    assert.equal(compactSketchStatus(view, true).split("\n").length, 3);
    assert.equal(compactSketchStatus({ active: false }), "sketch none active");
  });
});

describe("reliability over the server (demo.map)", () => {
  let h: Harness;
  /** Burg 1's name in the page. */
  const burgName = async (i: number) =>
    (await h.ok("eval", { code: `pack.burgs[${i}].name`, readOnly: true })).value as string;
  const launches = async () => (await h.ok("session", {})).launches as number;

  before(async () => {
    h = await startServer();
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
  });
  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("consoleErrors in a result are folded and capped", async () => {
    const r = await h.call("eval", {
      code: "for (let k = 0; k < 30; k++) console.error('distinct ' + k); for (let k = 0; k < 40; k++) console.error('flood error'); await new Promise(r => setTimeout(r, 300)); return 1",
      readOnly: true
    });
    const body = JSON.parse(textOf(r)) as { consoleErrors: string[] };
    assert.ok(body.consoleErrors.length <= 9, JSON.stringify(body.consoleErrors));
    assert.match(body.consoleErrors[0], /^flood error \(x\d+\)$/);
    assert.match(body.consoleErrors[body.consoleErrors.length - 1], /more distinct message/);
    assert.ok(JSON.stringify(body.consoleErrors).length < 1500);
    // session status lists the newest 20 distinct messages, repeats as one row with a count
    const s = await h.ok("session", { clear: true });
    const rows = s.consoleErrors as Array<{ text: string; count?: number }>;
    const flood = rows.find(x => x.text === "flood error");
    assert.ok(flood && (flood.count ?? 0) >= 2, JSON.stringify(rows.slice(0, 3)));
    assert.ok(rows.length <= 20);
  });

  test("a read-only call that stalls keeps the page (and its map) when the page answers again", async () => {
    await h.ok("edit", { type: "burg", ops: [{ ref: 2, set: { name: "Keepme" } }] });
    const n0 = await launches();
    const r = await h.call("eval", {
      code: "const t = Date.now(); while (Date.now() - t < 5000) {} return 1",
      readOnly: true,
      timeoutMs: 1000
    });
    assert.equal(errorBody(r).error.code, "TIMEOUT");
    const info = await h.ok("map_info", { since: "none", overview: false });
    const notes = (info.notes as string[] | undefined) ?? [];
    assert.ok(!notes.some(n => /browser relaunched/.test(n)), JSON.stringify(notes));
    assert.ok(
      notes.some(n => /answers again .*not relaunched/.test(n)),
      JSON.stringify(notes)
    );
    assert.equal(await burgName(2), "Keepme");
    assert.equal(await launches(), n0, "no relaunch");
  });

  test("a hung read-only call relaunches the page and restores the state the last edit left", async () => {
    // the edit above is the newest finished change; nothing after it pushed an undo entry
    const r = await h.call("eval", { code: "while (true) {}", readOnly: true, timeoutMs: 1000 });
    assert.equal(errorBody(r).error.code, "TIMEOUT");
    const info = await h.ok("map_info", { since: "none", overview: false });
    const notes = (info.notes as string[]).join(" ");
    assert.match(notes, /browser relaunched/);
    assert.match(notes, /Restored the map as 'edit' left it .*\(nothing lost\)/);
    assert.doesNotMatch(notes, /LOST/);
    assert.equal(await burgName(2), "Keepme", "the finished edit survived the relaunch");
    // undo still steps back over the edit
    await h.ok("snapshot", { action: "undo" });
    assert.notEqual(await burgName(2), "Keepme");
  });

  test("a failed undo puts the page back, keeps the history, and says so", async () => {
    const orig = await burgName(3);
    await h.ok("edit", { type: "burg", ops: [{ ref: 3, set: { name: "Undoable" } }] });
    const depth = ((await h.ok("snapshot", { action: "list" })).undo as unknown[]).length;
    await h.ok("eval", { code: "__tupaia.testFaults.loadMap = 1; return 1", readOnly: true });
    const r = await h.call("snapshot", { action: "undo" });
    assert.equal(r.isError, true);
    const e = errorBody(r).error as { code: string; message: string; details?: { pageRestored?: string } };
    assert.match(
      e.message,
      /^undo failed: test fault: the load failed part-way\. Nothing changed: the map from before the undo was loaded back/
    );
    assert.equal(e.details?.pageRestored, "now");
    assert.equal(await burgName(3), "Undoable", "the pre-undo map");
    assert.notEqual(await burgName(1), "Half-loaded", "not the half-loaded one");
    assert.equal(((await h.ok("snapshot", { action: "list" })).undo as unknown[]).length, depth);
    // the same undo works once the fault is gone
    await h.ok("snapshot", { action: "undo" });
    assert.equal(await burgName(3), orig);
  });

  test("a failed redo and a failed restore put the page back too", async () => {
    await h.ok("edit", { type: "burg", ops: [{ ref: 4, set: { name: "Redoable" } }] });
    await h.ok("snapshot", { action: "undo" });
    const before = await burgName(4);
    await h.ok("eval", { code: "__tupaia.testFaults.loadMap = 1; return 1", readOnly: true });
    const r = await h.call("snapshot", { action: "redo" });
    assert.match(errorBody(r).error.message, /^redo failed: .*Nothing changed/);
    assert.equal(await burgName(4), before);
    await h.ok("snapshot", { action: "redo" });
    assert.equal(await burgName(4), "Redoable");
    // restore: the undo entry it pushed goes again
    await h.ok("snapshot", { action: "take", label: "rel-a" });
    await h.ok("edit", { type: "burg", ops: [{ ref: 4, set: { name: "AfterSnap" } }] });
    const list0 = (await h.ok("snapshot", { action: "list" })).undo as Array<{ op: string }>;
    await h.ok("eval", { code: "__tupaia.testFaults.loadMap = 1; return 1", readOnly: true });
    const rr = await h.call("snapshot", { action: "restore", label: "rel-a" });
    assert.match(errorBody(rr).error.message, /^restore failed: .*Nothing changed/);
    assert.equal(await burgName(4), "AfterSnap");
    const list1 = (await h.ok("snapshot", { action: "list" })).undo as Array<{ op: string }>;
    assert.deepEqual(list1, list0, "no 'snapshot restore' entry left behind");
    await h.ok("snapshot", { action: "undo" });
  });

  test("map_info: a baseline from a different map is a short summary; big diffs are compact", async () => {
    await h.ok("map_info", { since: "none", overview: false }); // checkpoint on the demo map
    await h.ok("snapshot", { action: "take", label: "demo-base" });
    await h.ok("generate_map", { seed: "424242" });
    for (const since of ["checkpoint", "demo-base"]) {
      const r = await h.call("map_info", { since });
      const text = textOf(r);
      const body = JSON.parse(text) as { changed: boolean; changes: Record<string, unknown>; mapReplaced: string };
      assert.equal(body.changed, true);
      assert.equal(body.changes.mapReplaced, true);
      assert.match(body.mapReplaced, /a different map replaced the page/);
      assert.ok(text.length < 6000, `${since}: ${text.length} chars`);
    }
    // the default right after the generate: nothing edited since
    const d = await h.ok("map_info", { overview: false });
    assert.equal(d.changed, false);
    // the full diff is still there on request, and it is the big one the summary avoided
    const listed = textOf(await h.call("map_info", { since: "demo-base", detail: "list", overview: false }));
    assert.ok(listed.length > 20_000, `${listed.length} chars`);
    assert.match(listed, /two unrelated maps/);
    // a large diff on the same map: counts plus the first few, detail:'list' for more
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    const rows = (await h.ok("find", { type: "burg", limit: 40, fields: ["population"] })).rows as Array<{
      i: number;
      population: number;
    }>;
    await h.ok("edit", { type: "burg", ops: rows.map(r => ({ ref: r.i, set: { population: r.population + 1 } })) });
    const small = await h.call("map_info", { overview: false });
    const sb = JSON.parse(textOf(small)) as {
      changes: { burg: { counts: { modified: number }; modified: unknown[]; more: { modified: number } } };
      changesTruncated: string;
    };
    assert.equal(sb.changes.burg.counts.modified, 40);
    assert.equal(sb.changes.burg.modified.length, 3);
    assert.equal(sb.changes.burg.more.modified, 37);
    assert.match(sb.changesTruncated, /^40 changed entities/);
    const big = await h.ok("map_info", { overview: false, detail: "list" });
    assert.equal((big.changes as { burg: { modified: unknown[] } }).burg.modified.length, 40);
    assert.ok(textOf(small).length * 3 < JSON.stringify(big).length);
  });

  test("session and sketch status in compact form; an unsaved sketch is discarded locally", async () => {
    const s = await h.call("session", { format: "compact" });
    assert.equal(s.structuredContent, undefined);
    assert.match(textOf(s), /^session mode=local browser=ready launches=\d+ /);
    assert.equal(textOf(s).split("\n").length, 1);
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("sketch", { action: "start", slug: "rel-local" });
    await h.ok("edit", { type: "burg", ops: [{ ref: 5, set: { name: "Sketchy" } }] });
    const st = textOf(await h.call("sketch", { action: "status", format: "compact" }));
    assert.match(st, /^sketch rel-local recording base="file .*" ops=1 dirty saved=never last="1\. /);
    // a saved sketch on the Worker still needs live mode
    const other = await h.call("sketch", { action: "discard", slug: "someone-else", confirm: true });
    assert.equal(errorBody(other).error.code, "MODE");
    const preview = await h.ok("sketch", { action: "discard" });
    assert.equal(preview.preview, true);
    assert.equal(preview.local, true);
    assert.equal((await h.ok("sketch", { action: "status" })).active, true, "the preview changed nothing");
    const d = await h.ok("sketch", { action: "discard", confirm: true });
    assert.deepEqual(d.discarded, { slug: "rel-local", ops: 1, local: true });
    assert.equal((await h.ok("sketch", { action: "status" })).active, false);
    assert.equal(await burgName(5), "Sketchy", "the page keeps its map");
    await h.ok("snapshot", { action: "undo" });
  });

  test("a cancelled sketch summary puts the sketch map back without a relaunch", async () => {
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("sketch", { action: "start", slug: "rel-cancel" });
    await h.ok("edit", { type: "burg", ops: [{ ref: 1, set: { name: "Sketchburg" } }] });
    const n0 = await launches();
    // hold the 'before' pair's resetView (the base map is in the page then), and cancel there
    await h.ok("eval", {
      code: "__tupaia.testFaults.stall = { fn: 'resetView', ms: 8000 }; return 1",
      readOnly: true
    });
    const mark = h.stderr.length;
    const ac = new AbortController();
    const p = h.client.callTool(
      { name: "sketch", arguments: { action: "summary" } },
      { signal: ac.signal, timeout: 120_000 }
    );
    p.catch(() => {});
    assert.ok(
      await waitFor(() => h.stderr.slice(mark).join("").includes("tupaia-test: stalling resetView"), 90_000),
      "the summary reached the base shots"
    );
    ac.abort();
    await assert.rejects(p);
    const info = await h.ok("map_info", { since: "none", overview: false });
    const notes = ((info.notes as string[] | undefined) ?? []).join(" ");
    assert.doesNotMatch(notes, /browser relaunched/);
    assert.equal(await burgName(1), "Sketchburg", "the sketch map, not the base");
    assert.equal(await launches(), n0);
    const sk = await h.ok("sketch", { action: "status" });
    assert.equal(sk.ops, 1);
  });

  test("a summary cancelled during the base load restores the sketch map on the next call", async () => {
    await h.ok("eval", { code: "__tupaia.testFaults.stall = { fn: 'loadMap', ms: 8000 }; return 1", readOnly: true });
    const mark = h.stderr.length;
    const ac = new AbortController();
    const p = h.client.callTool(
      { name: "sketch", arguments: { action: "summary" } },
      { signal: ac.signal, timeout: 120_000 }
    );
    p.catch(() => {});
    assert.ok(
      await waitFor(() => h.stderr.slice(mark).join("").includes("tupaia-test: stalling loadMap"), 90_000),
      "the summary started loading the base"
    );
    ac.abort();
    await assert.rejects(p);
    const info = await h.ok("map_info", { since: "none", overview: false });
    const notes = (info.notes as string[]).join(" ");
    assert.match(notes, /relaunched/);
    assert.match(notes, /Restored the sketch map 'rel-cancel' \(nothing lost\)/);
    assert.equal(await burgName(1), "Sketchburg");
    const sk = await h.ok("sketch", { action: "status" });
    assert.equal(sk.ops, 1, "the sketch log is untouched by the restore");
    assert.equal(sk.blobOnly, false);
    await h.ok("sketch", { action: "stop" });
  });
});

describe("shared_status compact (fake Worker)", () => {
  let fake: FakeWorker;
  let h: Harness;
  before(async () => {
    fake = new FakeWorker({ seedFile: DEMO_MAP, version: 3 });
    h = await startServer({ TUPAIA_LIVE_ORIGIN: await fake.start() });
  });
  after(async () => {
    if (h && alive(h.pid)) await h.close();
    await fake?.stop();
  });

  test("one line, plus versions on request", async () => {
    const r = await h.call("shared_status", { format: "compact" });
    assert.equal(r.structuredContent, undefined);
    assert.match(
      textOf(r),
      /^shared v3 name=\S+ by=\S+ at=\S+ lock=none \| page lineage=unrelated .*\| mode=local writes=off build=skipped$/
    );
    const v = textOf(await h.call("shared_status", { format: "compact", versions: true })).split("\n");
    assert.equal(v.length, 2);
    assert.match(v[1], /^versions: v\d/);
  });
});
