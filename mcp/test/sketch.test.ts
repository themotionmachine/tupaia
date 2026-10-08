// Provisional sketches. Local layer: the ops log, undo/redo inside a sketch, summary, and the
// replay engine (sketch rebase {onto:{path}}, a test hook) against copies of
// tests/fixtures/demo.map that "someone else" edited (no network: TUPAIA_LIVE_ORIGIN=none).
// Network layer: save/list/open/rebase/discard and sketch_promote against the in-process fake
// Worker (test/fake-worker.ts on 127.0.0.1, serving dist like the real Worker), and the view
// link opened in a test-owned headless page. Never the live site.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { FakeWorker } from "./fake-worker.ts";
import {
  alive,
  DEMO_MAP,
  errorBody,
  type Harness,
  openViewer,
  REPO_ROOT,
  startServer,
  viewerDialog,
  viewerLoads
} from "./helpers.ts";

type Obj = Record<string, any>;

interface Pick {
  A: Obj; // renamed by the sketch (literal)
  B: Obj; // renamed by the sketch (generated name)
  C: Obj; // renamed by the sketch (literal)
  D: Obj; // route start; the new burg goes next to it
  U: Obj; // renamed by the other person
  newAt: { x: number; y: number };
  otherAt: { x: number; y: number };
  S1: Obj; // recoloured by the sketch, and the paint target
  S2: Obj; // recoloured by the other person
  paintAt: { x: number; y: number };
  base: string;
  layerOn: string[];
}

const PICK_CODE = `
const C = pack.cells;
const market = b => (pack.markets || []).some(m => m.centerBurgId === b.i);
const bs = pack.burgs.filter(b => b && b.i && !b.removed && !b.capital && !market(b) && b.state > 0);
const free = c => C.h[c] >= 20 && !C.burg[c];
let D = null, newCell = null;
for (const b of bs.slice(10)) {
  const n = C.c[b.cell].find(c => free(c) && C.f[c] === C.f[b.cell] && C.c[c].every(k => !C.burg[k] || k === b.cell));
  if (n !== undefined) { D = b; newCell = n; break; }
}
const used = new Set([D.i]);
const take = () => { const b = bs.find(x => !used.has(x.i) && x.state !== D.state); used.add(b.i); return b; };
const A = take(), B = take(), Cc = take(), U = take();
const far = [...C.i].reverse().find(c => free(c) && Math.hypot(C.p[c][0] - C.p[newCell][0], C.p[c][1] - C.p[newCell][1]) > 300 && C.c[c].every(k => !C.burg[k]));
const states = pack.states.filter(s => s.i && !s.removed);
const S1 = states[0], S2 = states[1];
const P = bs.find(b => b.state !== S1.i && !used.has(b.i) && b.i !== D.i);
const row = b => ({ i: b.i, name: b.name, cell: b.cell, x: b.x, y: b.y, state: b.state });
return {
  A: row(A), B: row(B), C: row(Cc), D: row(D), U: row(U),
  newAt: { x: C.p[newCell][0], y: C.p[newCell][1] },
  otherAt: { x: C.p[far][0], y: C.p[far][1] },
  S1: { i: S1.i, name: S1.name, color: S1.color }, S2: { i: S2.i, name: S2.name, color: S2.color },
  paintAt: { x: P.x, y: P.y },
  base: nameBases[1].name,
  layerOn: __tupaia.fns.layersOn()
};`;

describe("tupaia-mcp sketch (local ops log and replay)", () => {
  let h: Harness;
  let pick: Pick;
  let out = "";
  const files = { ok: "", removed: "", renamed: "" };
  let generatedName = "";
  let sketchNewBurg = 0;
  let sketchRoute = 0;
  let recordedOps = 0;

  /** Load demo.map, apply `code` as "someone else", save the copy under TUPAIA_OUT. */
  async function otherCopy(name: string, code: string): Promise<string> {
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("eval", { code, args: pick });
    const r = await h.ok("save_map", { path: `${name}.map`, overwrite: true });
    return r.path as string;
  }

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    out = fs.realpathSync(h.env.TUPAIA_OUT);
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    const p = await h.ok("eval", { code: PICK_CODE, readOnly: true });
    pick = p.value as Pick;
    files.ok = await otherCopy(
      "other-ok",
      `pack.burgs[args.U.i].name = "Otherton";
       pack.states[args.S2.i].color = "#123456";
       const id = Burgs.add([args.otherAt.x, args.otherAt.y]);
       pack.burgs[id].name = "Theirford";
       return id;`
    );
    files.removed = await otherCopy("other-removed", "Burgs.remove(args.A.i); return pack.burgs[args.A.i].removed;");
    files.renamed = await otherCopy("other-renamed", `pack.burgs[args.A.i].name = "Elsewhere"; return 1;`);
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("start needs a shared (or, with test hooks, file) base and refuses a second recording", async () => {
    const st = await h.ok("sketch", { action: "start", slug: "t-sketch", note: "Test proposal" });
    assert.equal(st.started, true);
    assert.equal((st.base as Obj).kind, "file");
    assert.match(JSON.stringify(st.notes ?? []), /test hook/);
    const again = await h.call("sketch", { action: "start" });
    assert.equal(again.isError, true);
    assert.equal(errorBody(again).error.code, "REFUSED");
  });

  test("records 9 ops with resolved forms (renames, recolour, add burg, route via the new burg, marker, paint, layer)", async () => {
    await h.ok("edit", { type: "burg", ops: [{ ref: pick.A.name, set: { name: "Sketchford" } }] });
    const gen = await h.ok("edit", {
      type: "burg",
      ops: [{ ref: pick.B.i, set: { name: { generate: { base: pick.base } } } }]
    });
    generatedName = ((gen.applied as Obj[])[0].after as Obj).name;
    assert.ok(generatedName && generatedName !== pick.B.name);
    await h.ok("edit", { type: "burg", ops: [{ ref: pick.C.i, set: { name: "Thirdwick" } }] });
    await h.ok("edit", { type: "state", ops: [{ ref: pick.S1.name, set: { color: "#aa2200" } }] });
    const add = await h.ok("add", { type: "burg", items: [{ at: pick.newAt }] });
    sketchNewBurg = (add.created as Obj[])[0].i;
    const route = await h.ok("add", {
      type: "route",
      items: [
        {
          through: [{ entity: { type: "burg", ref: pick.D.i } }, { entity: { type: "burg", ref: sketchNewBurg } }],
          group: "roads",
          name: "Sketch Road"
        }
      ]
    });
    sketchRoute = (route.created as Obj[])[0].i;
    await h.ok("add", {
      type: "marker",
      items: [
        { at: { entity: { type: "burg", ref: pick.C.i } }, icon: "⚑", note: { name: "Watchtower", legend: "Proposed" } }
      ]
    });
    const paint = await h.ok("paint_cells", {
      select: { circle: { at: pick.paintAt, radius: 30 } },
      set: { state: pick.S1.i }
    });
    assert.ok(((paint.set as Obj).state as Obj).changed > 0, "the paint changed some cells");
    const layer = pick.layerOn.includes("zones") ? { off: ["zones"] } : { on: ["zones"] };
    await h.ok("display", layer);
    // pure reads and dry runs are not logged
    await h.ok("find", { type: "burg", name: "Sketchford" });
    await h.ok("edit", { type: "burg", ops: [{ ref: pick.D.i, set: { name: "Nope" } }], dryRun: true });

    const st = await h.ok("sketch", { action: "status" });
    const log = st.log as Obj[];
    recordedOps = log.length;
    assert.equal(recordedOps, 9, JSON.stringify(log));
    assert.deepEqual(
      log.map(o => o.tool),
      ["edit", "edit", "edit", "edit", "add", "add", "add", "paint_cells", "display"]
    );
    assert.deepEqual(
      log.map(o => o.seq),
      [1, 2, 3, 4, 5, 6, 7, 8, 9]
    );
    assert.equal(st.blobOnly, false);
    assert.match(log[1].summary, new RegExp(generatedName));
    assert.match(log[0].summary, /Sketchford/);
    assert.match(log[7].summary, /Painted \d+ selected cells/);
  });

  test("5. undo inside a sketch removes the op from the log; redo restores it", async () => {
    const u = await h.ok("snapshot", { action: "undo" });
    assert.match(JSON.stringify(u.notes), /op 9 \(display\) removed/);
    let st = await h.ok("sketch", { action: "status" });
    assert.equal((st.log as Obj[]).length, recordedOps - 1);
    assert.equal(st.redoAvailable, 1);
    const r = await h.ok("snapshot", { action: "redo" });
    assert.match(JSON.stringify(r.notes), /op 9 \(display\) is back/);
    st = await h.ok("sketch", { action: "status" });
    assert.equal((st.log as Obj[]).length, recordedOps);
    assert.equal(st.blobOnly, false);
  });

  test("6. summary returns markdown listing every op, and screenshot files", async () => {
    const s = await h.ok("sketch", { action: "summary" }, 240_000);
    const md = s.markdown as string;
    assert.match(md, /^# Sketch t-sketch/);
    assert.match(md, /Test proposal/);
    for (let k = 1; k <= recordedOps; k++) assert.match(md, new RegExp(`^${k}\\. `, "m"), `op ${k} listed`);
    assert.match(md, /\| burgs \| 753 \| 754 \| \+1 \|/);
    const shots = Object.values(s.shots as Obj).filter(Boolean) as string[];
    assert.ok(shots.length >= 2, JSON.stringify(s.shots));
    for (const f of shots) {
      assert.ok(fs.existsSync(f), `${f} exists`);
      assert.ok(f.startsWith(out), `${f} under TUPAIA_OUT`);
    }
    assert.ok((s.shots as Obj).beforeFull && (s.shots as Obj).afterFull);
    assert.ok(fs.existsSync(s.file as string));
    // the page holds the sketch again, and the log is untouched
    const ev = await h.ok("eval", { code: `pack.burgs[${pick.A.i}].name`, readOnly: true });
    assert.equal(ev.value, "Sketchford");
    const st = await h.ok("sketch", { action: "status" });
    assert.equal((st.log as Obj[]).length, recordedOps);
  });

  test("3. both changed: the other copy renamed the same burg -> conflict 'both changed name'", async () => {
    const r = await h.ok("sketch", { action: "rebase", onto: { path: files.renamed } }, 240_000);
    assert.equal(r.completed, false);
    assert.deepEqual(r.applied, []);
    const c = (r.conflicts as Obj[])[0];
    assert.equal(c.seq, 1);
    assert.match(c.reason, /^both changed name/);
    assert.match(c.reason, /Elsewhere/);
    const st = r.sketch as Obj;
    assert.equal(st.ops, recordedOps, "a stopped rebase leaves the sketch's log alone");
    assert.ok(st.suspended);
  });

  test("2a. conflict: the other copy removed a burg the sketch renamed -> stop at that op", async () => {
    const r = await h.ok("sketch", { action: "rebase", onto: { path: files.removed }, onConflict: "stop" }, 240_000);
    assert.equal(r.completed, false);
    const c = (r.conflicts as Obj[])[0];
    assert.equal(c.seq, 1);
    assert.match(c.reason, /REMOVED/);
    assert.ok(c.reason.includes(pick.A.name) || c.reason.includes(String(pick.A.i)), c.reason);
    assert.equal((r.conflicts as Obj[]).length, 1);
  });

  test("1. replay onto a copy with someone else's edits: all ops apply, ids shift, their edits survive", async () => {
    const r = await h.ok("sketch", { action: "rebase", onto: { path: files.ok } }, 240_000);
    assert.equal(r.completed, true, JSON.stringify(r.conflicts));
    assert.deepEqual(r.conflicts, []);
    assert.deepEqual(r.applied, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const idMap = r.idMap as Record<string, Record<string, number>>;
    const newBurg = idMap.burg[String(sketchNewBurg)];
    assert.ok(newBurg !== undefined && newBurg !== sketchNewBurg, `new burg id shifted: ${JSON.stringify(idMap)}`);
    const newRoute = idMap.route[String(sketchRoute)];
    assert.ok(newRoute !== undefined, "the route is in the id map");
    const ev = await h.ok("eval", {
      readOnly: true,
      args: { pick, newBurg, newRoute },
      code: `
        const C = pack.cells;
        const route = pack.routes.find(x => x.i === args.newRoute);
        const ends = [route.points[0][2], route.points[route.points.length - 1][2]];
        return {
          A: pack.burgs[args.pick.A.i].name,
          B: pack.burgs[args.pick.B.i].name,
          C: pack.burgs[args.pick.C.i].name,
          U: pack.burgs[args.pick.U.i].name,
          S1: pack.states[args.pick.S1.i].color,
          S2: pack.states[args.pick.S2.i].color,
          theirs: pack.burgs.find(b => b && b.name === "Theirford" && !b.removed)?.i ?? null,
          endBurgs: ends.map(c => C.burg[c]),
          routeName: route.name,
          newBurgCell: pack.burgs[args.newBurg].cell,
          marker: notes.filter(n => n.name === "Watchtower").length
        };`
    });
    const v = ev.value as Obj;
    assert.equal(v.A, "Sketchford");
    assert.equal(v.B, generatedName, "the generated name replays to the same name");
    assert.equal(v.C, "Thirdwick");
    assert.equal(v.S1, "#aa2200");
    assert.equal(v.U, "Otherton", "their rename survives");
    assert.equal(v.S2, "#123456", "their recolour survives");
    assert.equal(v.theirs, sketchNewBurg, "their burg took the id the sketch's burg had");
    assert.ok(v.endBurgs.includes(newBurg), `the route ends at the replayed burg ${newBurg}: ${JSON.stringify(v)}`);
    assert.equal(v.routeName, "Sketch Road");
    assert.equal(v.marker, 1);
    const st = r.sketch as Obj;
    assert.equal((st.base as Obj).kind, "file");
    assert.equal((st.base as Obj).path, files.ok);
    assert.equal(st.ops, recordedOps);
    assert.equal(st.suspended, undefined);
    const hist = await h.ok("snapshot", { action: "list" });
    const undo = (hist.undo as Obj[]).map(e => e.op);
    assert.equal(undo.filter(op => /^sketch replay op/.test(op)).length, recordedOps, "one undo entry per applied op");
  });

  test("2b. conflict with onConflict 'skip': the rest applies and the conflict is listed", async () => {
    const r = await h.ok("sketch", { action: "rebase", onto: { path: files.removed }, onConflict: "skip" }, 240_000);
    assert.equal(r.completed, true);
    assert.deepEqual(
      (r.conflicts as Obj[]).map(c => c.seq),
      [1]
    );
    assert.deepEqual(r.skipped, [1]);
    assert.deepEqual(r.applied, [2, 3, 4, 5, 6, 7, 8, 9]);
    const idMap = r.idMap as Record<string, Record<string, number>>;
    assert.equal(Object.keys(idMap.burg).length, 1);
    const ev = await h.ok("eval", {
      readOnly: true,
      code: `[pack.burgs[${pick.A.i}].removed, pack.burgs[${pick.B.i}].name]`
    });
    assert.deepEqual(ev.value, [true, generatedName]);
    assert.equal((r.sketch as Obj).ops, recordedOps - 1, "the skipped op leaves the log");
    recordedOps -= 1;
  });

  test("4. a regenerate during a sketch makes it blob-only and rebase refuses; undo clears it", async () => {
    await h.ok("regenerate", { parts: ["zones"] }, 240_000);
    const st = await h.ok("sketch", { action: "status" });
    assert.equal(st.blobOnly, true);
    assert.match(JSON.stringify(st.blobOnlyReasons), /regenerate/);
    const r = await h.call("sketch", { action: "rebase", onto: { path: files.ok } });
    assert.equal(r.isError, true);
    const err = errorBody(r).error;
    assert.equal(err.code, "REFUSED");
    assert.match(err.message, /blob-only/);
    assert.match(err.message, /regenerate/);
    await h.ok("snapshot", { action: "undo" });
    const st2 = await h.ok("sketch", { action: "status" });
    assert.equal(st2.blobOnly, false);
    assert.equal(st2.ops, recordedOps);
  });

  test("eval is logged as unsafe; a failed eval is a no-op; stop ends recording", async () => {
    await h.ok("eval", { code: `pack.burgs[${pick.C.i}].population = 7; return 1;` });
    const bad = await h.call("eval", { code: "throw new Error('nope')" });
    assert.equal(bad.isError, true);
    const st = await h.ok("sketch", { action: "status" });
    const log = st.log as Obj[];
    assert.equal(log[log.length - 2].tool, "eval");
    assert.equal(log[log.length - 2].unsafe, true);
    assert.match(log[log.length - 1].summary, /no-op/);
    assert.equal(st.blobOnly, false);
    const stop = await h.ok("sketch", { action: "stop" });
    assert.equal(stop.recording, false);
    await h.ok("edit", { type: "burg", ops: [{ ref: pick.D.i, set: { name: "Afterstop" } }] });
    const st2 = await h.ok("sketch", { action: "status" });
    assert.equal(st2.ops, log.length, "not logged after stop");
    assert.match(String(st2.diverged), /after the sketch stopped/);
  });

  test("start is refused when the page map is not from the shared map", async () => {
    await h.ok("eval", { code: "mapId = 424242; return mapId;" });
    const r = await h.call("sketch", { action: "start", slug: "t-two" });
    assert.equal(r.isError, true);
    const err = errorBody(r).error;
    assert.equal(err.code, "REFUSED");
    assert.match(err.message, /load_map \{source:'shared'\}/);
    assert.ok(fs.existsSync(path.join(out, "sketches", "t-sketch", "summary.md")));
  });
});

const NET_PICK = `
const C = pack.cells;
const market = b => (pack.markets || []).some(m => m.centerBurgId === b.i);
const bs = pack.burgs.filter(b => b && b.i && !b.removed && !b.capital && !market(b) && b.state > 0);
const free = c => C.h[c] >= 20 && !C.burg[c];
let D = null, newCell = null;
for (const b of bs.slice(10)) {
  const n = C.c[b.cell].find(c => free(c) && C.f[c] === C.f[b.cell] && C.c[c].every(k => !C.burg[k] || k === b.cell));
  if (n !== undefined) { D = b; newCell = n; break; }
}
const A = bs.find(b => b.i !== D.i && b.state !== D.state);
const U = bs.find(b => b.i !== D.i && b.i !== A.i && b.state !== A.state);
const states = pack.states.filter(s => s.i && !s.removed);
return {
  A: { i: A.i, name: A.name }, U: { i: U.i, name: U.name }, D: { i: D.i },
  S1: { i: states[0].i }, S2: { i: states[1].i },
  newAt: { x: C.p[newCell][0], y: C.p[newCell][1] }
};`;

describe("tupaia-mcp sketch network actions (live mode, fake Worker)", () => {
  let fake: FakeWorker;
  let h: Harness;
  let origin = "";
  let pick: Obj;
  let theirs: Buffer;
  let viewUrl = "";
  const writes = () => fake.writes().map(r => `${r.method} ${r.path}`);

  before(async () => {
    fake = new FakeWorker({ seedFile: DEMO_MAP, version: 6, assetsDir: path.join(REPO_ROOT, "dist") });
    origin = await fake.start();
    h = await startServer({
      TUPAIA_MODE: "live",
      TUPAIA_LIVE_ORIGIN: origin,
      TUPAIA_BUILD_CACHE_MS: "0",
      TUPAIA_UNDO_DEPTH: "30"
    });
    // a live server loads shared v6 on its first launch
    pick = (await h.ok("eval", { code: NET_PICK, readOnly: true })).value as Obj;
    // "someone else's" v7: a different but compatible map (their rename and recolour)
    await h.ok("eval", {
      args: pick,
      code: `pack.burgs[args.U.i].name = "Otherton"; pack.states[args.S2.i].color = "#123456"; return 1;`
    });
    const saved = await h.ok("save_map", { path: "theirs-v7.map", overwrite: true });
    theirs = fs.readFileSync(saved.path as string);
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
    await fake?.stop();
  });

  test("save: preview writes nothing; confirm PUTs sketch-harbour and its ops.json; list shows the header", async () => {
    await h.ok("load_map", { source: "shared" });
    const st = await h.ok("sketch", { action: "start", slug: "harbour", note: "A new harbour town" });
    assert.equal((st.base as Obj).version, 6);
    await h.ok("edit", { type: "burg", ops: [{ ref: pick.A.i, set: { name: "Sketchford" } }] });
    await h.ok("add", { type: "burg", items: [{ at: pick.newAt, name: "Newhaven" }] });
    await h.ok("edit", { type: "state", ops: [{ ref: pick.S1.i, set: { color: "#aa2200" } }] });
    fake.clearLog();
    const p = await h.ok("sketch", { action: "save" });
    assert.equal(p.preview, true);
    assert.deepEqual(writes(), []);
    const r = await h.ok("sketch", { action: "save", confirm: true });
    assert.deepEqual(writes(), ["PUT /api/map/sketch-harbour", "PUT /api/map/sketch-harbour/ops"]);
    const put = fake.writes()[0];
    assert.equal(put.headers["x-map-version"], undefined, "first save: no version header");
    assert.equal(put.headers["x-map-overwrite"], undefined);
    viewUrl = r.viewUrl as string;
    assert.equal(viewUrl, `${origin}/?maplink=${encodeURIComponent(`${origin}/api/map/sketch-harbour`)}`);
    assert.equal((r.saved as Obj).version, 1);
    const ops = JSON.parse(String(fake.maps.get("sketch-harbour")?.ops)) as Obj;
    assert.equal(ops.schema, 1);
    assert.equal(ops.slug, "harbour");
    assert.equal(ops.author, "tupaia-mcp");
    assert.equal(ops.blobOnly, false);
    assert.equal(ops.base.version, 6);
    assert.equal(ops.note, "A new harbour town");
    assert.equal(ops.ops.length, 3);
    assert.ok(ops.ops.every((o: Obj) => !("undoId" in o)));
    assert.match(ops.summaryMarkdown, /Sketchford/);
    for (const k of ["created", "updated", "blob"]) assert.ok(ops[k], k);
    const status = await h.ok("sketch", { action: "status" });
    assert.equal(status.dirty, false);
    assert.equal(status.viewUrl, viewUrl);

    const l = await h.ok("sketch", { action: "list" });
    const items = l.sketches as Obj[];
    assert.deepEqual(
      items.map(i => i.id),
      ["sketch-harbour"]
    );
    const hd = items[0].header as Obj;
    assert.equal(hd.base.version, 6);
    assert.equal(hd.ops, 3);
    assert.equal(hd.author, "tupaia-mcp");
    assert.equal(hd.blobOnly, false);
    assert.match(hd.log[0], /Sketchford/);
    assert.equal(items[0].viewUrl, viewUrl);
  });

  test("the view link opens the sketch (not the shared map) in a browser; Save to shared asks first", async () => {
    fake.clearLog();
    const v = await openViewer(viewUrl);
    try {
      await viewerLoads(v.page, 1);
      const names = await v.page.evaluate(
        a => [(globalThis as any).pack.burgs[a].name, (globalThis as any).pack.burgs.length],
        pick.A.i as number
      );
      assert.equal(names[0], "Sketchford");
      const api = fake.requests.filter(q => q.path.startsWith("/api/")).map(q => `${q.method} ${q.path}`);
      assert.deepEqual(api, ["GET /api/map/sketch-harbour"], "the sketch was loaded, the shared map was not");
      // the in-page Save -> shared map: the guard asks instead of sending anything
      await v.page.evaluate(() => (globalThis as any).lazy.sharedMap().then((m: any) => m.saveSharedMap()));
      await v.page.waitForSelector(".ui-dialog:visible");
      const d = await viewerDialog(v.page);
      assert.equal(d?.title, "Replace the shared map?");
      assert.match(d?.text ?? "", /not loaded from the shared map/);
      assert.deepEqual(d?.buttons, ["Replace v6", "Cancel"]);
      await v.page.locator(".ui-dialog-buttonset button", { hasText: "Cancel" }).click();
      await v.page.waitForTimeout(300);
      assert.deepEqual(writes(), []);
    } finally {
      await v.close();
    }
  });

  test("open in a fresh (local-mode) server restores the map and the ops; save and discard are refused there", async () => {
    const h2 = await startServer({ TUPAIA_LIVE_ORIGIN: origin, TUPAIA_UNDO_DEPTH: "30" });
    try {
      const before = writes().length;
      const l = await h2.ok("sketch", { action: "list" });
      assert.equal((l.sketches as Obj[]).length, 1, "list works in local mode");
      const o = await h2.ok("sketch", { action: "open", slug: "harbour" });
      assert.equal(o.opened, true);
      assert.equal(o.ops, 3);
      assert.equal((o.base as Obj).version, 6);
      assert.equal((o.origin as Obj).kind, "sketch");
      assert.equal((o.origin as Obj).sketchSlug, "harbour");
      assert.equal(o.dirty, false);
      const ev = await h2.ok("eval", {
        readOnly: true,
        code: `[pack.burgs[${pick.A.i}].name, pack.burgs.filter(b => b && b.name === "Newhaven" && !b.removed).length, pack.states[${pick.S1.i}].color]`
      });
      assert.deepEqual(ev.value, ["Sketchford", 1, "#aa2200"]);
      const st = await h2.ok("sketch", { action: "status", full: true });
      assert.deepEqual(
        (st.records as Obj[]).map(r => r.tool),
        ["edit", "add", "edit"]
      );
      for (const [args, what] of [
        [{ action: "save", confirm: true }, "save"],
        [{ action: "discard", slug: "harbour", confirm: true }, "discard"]
      ] as const) {
        const r = await h2.call("sketch", args);
        assert.equal(r.isError, true, what);
        assert.equal(errorBody(r).error.code, "MODE", what);
      }
      const pr = await h2.call("sketch_promote", {});
      assert.equal(errorBody(pr).error.code, "MODE");
      assert.equal(writes().length, before, "the local server wrote nothing");
    } finally {
      await h2.close();
    }
  });

  test("someone else saves v7: sketch_promote refuses with 'rebase first' and writes nothing", async () => {
    assert.equal(fake.externalSave("alice@example.test", theirs), 7);
    fake.clearLog();
    const r = await h.call("sketch_promote", {});
    assert.equal(r.isError, true);
    const err = errorBody(r).error;
    assert.equal(err.code, "REFUSED");
    assert.match(err.message, /^rebase first/);
    assert.match(err.message, /v6/);
    assert.match(err.message, /v7/);
    assert.deepEqual(writes(), []);
  });

  test("rebase onto the current shared map v7 applies cleanly and keeps their edits; nothing is saved", async () => {
    fake.clearLog();
    const r = await h.ok("sketch", { action: "rebase" }, 240_000);
    assert.equal(r.completed, true, JSON.stringify(r.conflicts));
    assert.deepEqual(r.applied, [1, 2, 3]);
    assert.equal(((r.sketch as Obj).base as Obj).version, 7);
    assert.equal((r.sketch as Obj).dirty, true);
    assert.deepEqual(writes(), [], "rebase does not save");
    const ev = await h.ok("eval", {
      readOnly: true,
      code: `[pack.burgs[${pick.A.i}].name, pack.burgs[${pick.U.i}].name, pack.states[${pick.S2.i}].color, pack.states[${pick.S1.i}].color]`
    });
    assert.deepEqual(ev.value, ["Sketchford", "Otherton", "#123456", "#aa2200"]);
    const s = await h.ok("shared_status", {});
    assert.equal((s.local as Obj).lineage, "shared");
    assert.equal((s.local as Obj).stale, false);
  });

  test("sketch_promote: preview -> token -> confirm sends one PUT (X-Map-Version 7, no overwrite), then DELETE", async () => {
    fake.clearLog();
    // biome-ignore lint/suspicious/noThenProperty: sketch_promote's parameter is named 'then'
    const thenDiscard = { then: "discard" };
    const p = await h.ok("sketch_promote", thenDiscard);
    assert.equal(p.preview, true);
    assert.equal((p.wouldOverwrite as Obj).version, 7);
    assert.equal((p.sketch as Obj).slug, "harbour");
    assert.equal(typeof p.token, "string");
    assert.match(String(p.next), /sketch_promote \{confirm:true, token:'[0-9a-f]+', then:'discard'\}/);
    assert.deepEqual(writes(), []);
    const r = await h.ok("sketch_promote", { confirm: true, token: p.token as string, ...thenDiscard });
    assert.deepEqual(writes(), ["PUT /api/map/shared", "DELETE /api/map/sketch-harbour"]);
    const put = fake.writes()[0];
    assert.equal(put.headers["x-map-version"], "7");
    assert.equal(put.headers["x-map-overwrite"], undefined);
    assert.equal((r.saved as Obj).version, 8);
    assert.equal((r.promoted as Obj).to, 8);
    assert.equal((r.origin as Obj).kind, "shared");
    assert.equal((r.origin as Obj).sharedVersion, 8);
    assert.equal((r.discarded as Obj).deleted, true);
    assert.equal(fake.maps.has("sketch-harbour"), false);
    assert.equal(fake.row.version, 8);
    const st = await h.ok("sketch", { action: "status" });
    assert.equal(st.active, false);
    // the token was used up
    const again = await h.call("sketch_promote", { confirm: true, token: p.token as string });
    assert.equal(again.isError, true);
  });

  test("a blob-only sketch refuses rebase but can still be saved, and discard deletes it", async () => {
    await h.ok("load_map", { source: "shared" });
    await h.ok("sketch", { action: "start", slug: "blobby" });
    await h.ok("regenerate", { parts: ["zones"] }, 240_000);
    const r = await h.call("sketch", { action: "rebase" });
    assert.equal(errorBody(r).error.code, "REFUSED");
    assert.match(errorBody(r).error.message, /blob-only/);
    fake.clearLog();
    const s = await h.ok("sketch", { action: "save", confirm: true });
    assert.deepEqual(writes(), ["PUT /api/map/sketch-blobby", "PUT /api/map/sketch-blobby/ops"]);
    assert.equal((s.sketch as Obj).blobOnly, true);
    const ops = JSON.parse(String(fake.maps.get("sketch-blobby")?.ops)) as Obj;
    assert.equal(ops.blobOnly, true);
    assert.match(JSON.stringify(ops.blobOnlyReasons), /regenerate/);
    const pv = await h.ok("sketch", { action: "discard", slug: "blobby" });
    assert.equal(pv.preview, true);
    assert.equal(fake.maps.has("sketch-blobby"), true);
    const d = await h.ok("sketch", { action: "discard", slug: "blobby", confirm: true });
    assert.equal((d.deleted as Obj).deleted, true);
    assert.equal(fake.maps.has("sketch-blobby"), false);
    const st = await h.ok("sketch", { action: "status" });
    assert.equal(st.lastSaved, null);
  });

  test("never a DELETE of shared, never an overwrite header; outward requests are loopback only", async () => {
    const all = fake.requests;
    assert.ok(!all.some(q => q.method === "DELETE" && q.path === "/api/map/shared"));
    for (const q of all) assert.equal(q.headers["x-map-overwrite"], undefined, `${q.method} ${q.path}`);
    const s = await h.ok("session", { action: "status" });
    for (const q of s.outwardRequests as Obj[]) assert.match(q.url, /^http:\/\/127\.0\.0\.1:\d+\//);
  });
});
