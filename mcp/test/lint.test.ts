// lint: the read-only map quality check. Browser tests on tests/fixtures/demo.map: a clean-ish
// baseline, then one synthetic problem per check (made with edit/add/eval, found by lint, and
// repaired with the fix call lint suggests), filters and options, and the read-only guarantees.
// Pure geometry (bucket-grid overlap and stacking, river profile) runs in node:vm.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { LINT_CHECKS, LINT_OPT_IN } from "../src/tools/lint.ts";
import { alive, errorBody, type Harness, MCP_ROOT, startServer, textOf } from "./helpers.ts";

type Obj = Record<string, any>;

interface Row {
  sev: string;
  e: Array<[string, number | string, string | null]>;
  at?: [number, number];
  msg: string;
  fix?: { tool: string; args: Obj };
  fixNote?: string;
  hint?: string;
}

interface LintOut {
  ms: number;
  map: { w: number; h: number; cells: number };
  totals: { error: number; warn: number; info: number };
  counts: Record<string, number>;
  kinds?: Record<string, Record<string, number>>;
  rows: Record<string, Row[]>;
  more?: Record<string, number>;
  fixAll?: Record<string, { tool: string; args: Obj }>;
  clean: string[];
  skipped?: Array<{ check: string; reason: string }>;
  notes?: string[];
  scanned: Record<string, number>;
  unlocated?: Record<string, number>;
  ignored?: number;
}

describe("tupaia-mcp lint (browser)", () => {
  let h: Harness;

  const lint = async (args: Obj = {}): Promise<LintOut> => (await h.ok("lint", args)) as unknown as LintOut;
  const evalv = async (code: string, args?: unknown): Promise<any> =>
    (await h.ok("eval", { code, args, readOnly: true })).value;
  const reload = () => h.ok("load_map", { path: "tests/fixtures/demo.map" });
  const rowsOf = (out: LintOut, id: string): Row[] => out.rows[id] ?? [];
  const apply = (fix: { tool: string; args: Obj } | undefined) => {
    assert.ok(fix, "the row carries a fix");
    return h.ok(fix.tool, fix.args);
  };
  /** Run one check, assert it found exactly `n` rows, return them. */
  async function found(id: string, n: number, extra: Obj = {}): Promise<{ out: LintOut; rows: Row[] }> {
    const out = await lint({ checks: [id], limit: 50, ...extra });
    assert.equal(out.counts[id] ?? 0, n, `${id}: ${JSON.stringify(out.rows[id] ?? out.skipped ?? out.clean)}`);
    return { out, rows: rowsOf(out, id) };
  }
  async function clean(id: string, extra: Obj = {}): Promise<void> {
    const out = await lint({ checks: [id], limit: 50, ...extra });
    assert.equal(out.counts[id] ?? 0, 0, `${id} should be clean: ${JSON.stringify(out.rows[id])}`);
  }
  const hasEntity = (r: Row, type: string, id: unknown) => r.e.some(t => t[0] === type && t[1] === id);

  before(async () => {
    h = await startServer();
    await reload();
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("tool: listed, read-only, check ids match the page", async () => {
    const { tools } = await h.client.listTools();
    const t = tools.find(x => x.name === "lint");
    assert.ok(t, "lint is registered");
    assert.equal(t.annotations?.readOnlyHint, true);
    assert.ok((t.description ?? "").length <= 2048);
    const ids = await evalv("return __tupaia.lint.CHECK_IDS");
    assert.deepEqual(ids, [...LINT_CHECKS]);
    const opt = await evalv("return __tupaia.lint.CHECK_IDS.filter(id => __tupaia.lint.DEFS[id].optIn)");
    assert.deepEqual(opt, [...LINT_OPT_IN], "opt-in checks match the page");
  });

  test("baseline: demo.map has no errors, label checks say why they were skipped, and it is fast", async () => {
    const t0 = Date.now();
    const out = await lint();
    const wall = Date.now() - t0;
    assert.ok(out.ms < 3000, `lint took ${out.ms} ms in the page (${wall} ms with the round trip)`);
    assert.equal(out.totals.error, 0, JSON.stringify(out.rows));
    assert.equal(out.map.cells, 7462);
    // the fixture was saved without label elements: label checks cannot measure and say so
    const skipped = (out.skipped ?? []).map(s => s.check);
    assert.deepEqual(skipped.sort(), ["label-offcanvas", "label-overlap"]);
    assert.match((out.skipped ?? [])[0].reason, /no label elements/);
    // the generator names no route: 578 unnamed routes are one info row, not 578
    assert.equal(out.kinds?.unnamed?.route, 1);
    assert.equal(out.counts.unnamed, 1);
    // an overview counts info findings but lists only warn and error rows; naming the check lists it
    assert.equal(out.rows.unnamed, undefined);
    assert.equal(out.more?.unnamed, 1);
    const named = await lint({ checks: ["unnamed"] });
    assert.match(named.rows.unnamed[0].msg, /^578 of 578 routes have no name/);
    const explicit = await lint({ minSeverity: "info" });
    assert.match(explicit.rows.unnamed[0].msg, /^578 of 578 routes have no name/);
    for (const id of [
      "burg-in-water",
      "burg-shared-cell",
      "burg-cell-link",
      "capital-outside",
      "river-loop",
      "route-link",
      "route-point-cell",
      "marker-cell-link",
      "note-orphan"
    ])
      assert.ok(out.clean.includes(id), `${id} is clean on the fixture`);
    // opt-in checks are not part of a default run
    for (const id of LINT_OPT_IN) assert.ok(!(id in out.counts) && !out.clean.includes(id), `${id} is opt-in`);
    assert.ok(out.scanned.burgs === 753 && out.scanned.rivers === 370 && out.scanned.routes === 578);
    // compact: counts first, rows capped per check
    for (const rows of Object.values(out.rows)) assert.ok(rows.length <= 20);
    assert.ok(JSON.stringify(out).length < 15_000, "default output stays small");
  });

  test("read-only: no undo entry, no checkpoint, no sketch log entry, map unchanged", async () => {
    const before = await h.ok("snapshot", { action: "list" });
    const mapBefore = await h.ok("save_map", { path: "lint-before.map", overwrite: true });
    await h.ok("sketch", { action: "start", slug: "lint-ro", note: "lint is read-only" });
    await lint();
    await lint({ checks: ["burg-in-water", "unnamed"], near: { x: 800, y: 400 }, radius: 300 });
    const st = await h.ok("sketch", { action: "status" });
    assert.equal((st.log as unknown[]).length, 0, "lint is not logged in the sketch");
    await h.ok("sketch", { action: "stop" });
    const after = await h.ok("snapshot", { action: "list" });
    assert.deepEqual(after.undo, before.undo, "lint pushed no undo entry");
    assert.deepEqual(after.snapshots, before.snapshots);
    const mapAfter = await h.ok("save_map", { path: "lint-after.map", overwrite: true });
    assert.equal(mapAfter.sha256, mapBefore.sha256, "the map text is byte-identical after lint");
  });

  test("argument errors: unknown check id, bbox with near, radius without near", async () => {
    const bad = await h.call("lint", { checks: ["no-such-check"] });
    assert.equal(bad.isError, true);
    const both = await h.call("lint", { bbox: [0, 0, 10, 10], near: { x: 5, y: 5 }, radius: 4 });
    assert.equal(both.isError, true);
    assert.equal(errorBody(both).error.code, "BAD_ARGS");
    const lone = await h.call("lint", { radius: 10 });
    assert.equal(lone.isError, true);
    assert.equal(errorBody(lone).error.code, "BAD_ARGS");
  });

  describe("burgs", () => {
    before(reload);

    test("burg-in-water: a burg moved into the sea; the fix moves it back to land", async () => {
      const b = await evalv(`
        const C = pack.cells;
        const b = pack.burgs.find(b => b && b.i && !b.removed && !b.capital && C.c[b.cell].some(c => C.h[c] < 20));
        const w = C.c[b.cell].find(c => C.h[c] < 20);
        C.burg[b.cell] = 0; b.cell = w; b.x = C.p[w][0]; b.y = C.p[w][1]; C.burg[w] = b.i;
        return { i: b.i, name: b.name, x: b.x, y: b.y, state: b.state };`);
      const { rows } = await found("burg-in-water", 1);
      assert.equal(rows[0].sev, "error");
      assert.ok(hasEntity(rows[0], "burg", b.i));
      assert.match(rows[0].msg, new RegExp(b.name));
      assert.equal(rows[0].fix?.tool, "edit");
      // area filter: the row is inside a circle around the burg and outside a far-away box
      await found("burg-in-water", 1, { near: { x: b.x, y: b.y }, radius: 5 });
      await found("burg-in-water", 0, { bbox: [0, 0, 20, 20] });
      await found("burg-in-water", 1, { types: ["burg"] });
      await found("burg-in-water", 0, { types: ["river"] });
      assert.ok(!rows[0].fixNote, "a cell of its own state was free: no state change to report");
      await apply(rows[0].fix);
      await clean("burg-in-water");
      const now = await evalv("return [pack.cells.h[pack.burgs[args].cell], pack.burgs[args].state]", b.i);
      assert.ok(now[0] >= 20);
      assert.equal(now[1], b.state, "the fix keeps the burg in its own state");
    });

    test("burg fixes: with no free cell in its own state a non-capital moves abroad and says so; a locked burg gets a hint", async () => {
      const p = await evalv(`
        const C = pack.cells;
        const b = pack.burgs.find(b => b && b.i && !b.removed && !b.capital && C.c[b.cell].some(c => C.h[c] < 20));
        const w = C.c[b.cell].find(c => C.h[c] < 20);
        C.burg[b.cell] = 0; b.cell = w; b.x = C.p[w][0]; b.y = C.p[w][1]; C.burg[w] = b.i;
        b.state = 9999; // a state that owns no cell anywhere
        return { i: b.i, name: b.name };`);
      const { rows } = await found("burg-in-water", 1);
      assert.equal(rows[0].fix?.tool, "edit");
      assert.match(rows[0].fixNote ?? "", /no free land cell in its own state nearby.*its state changes/);
      await evalv("pack.burgs[args].lock = true", p.i);
      const locked = await found("burg-in-water", 1);
      assert.ok(!locked.rows[0].fix && /is locked/.test(locked.rows[0].hint ?? ""), JSON.stringify(locked.rows[0]));
      await evalv("pack.burgs[args].lock = false", p.i);
      await apply((await found("burg-in-water", 1)).rows[0].fix);
      await clean("burg-in-water");
    });

    test("burg-cell-link: coordinates that fall in another cell than the recorded one; the fix moves the burg there", async () => {
      const p = await evalv(`
        const C = pack.cells;
        const b = pack.burgs.filter(b => b && b.i && !b.removed && !b.capital)[12];
        const spot = C.i.find(c => C.h[c] >= 20 && !C.burg[c] && Math.hypot(C.p[c][0] - b.x, C.p[c][1] - b.y) > 80);
        b.x = C.p[spot][0]; b.y = C.p[spot][1];
        return { i: b.i, cell: b.cell, spot };`);
      const { rows } = await found("burg-cell-link", 1);
      assert.ok(hasEntity(rows[0], "burg", p.i));
      assert.match(rows[0].msg, new RegExp(`records cell ${p.cell}, but its coordinates fall in cell ${p.spot}`));
      assert.equal(rows[0].fix?.tool, "edit");
      await apply(rows[0].fix);
      await clean("burg-cell-link");
    });

    test("burg-shared-cell + burg-cell-link: two burgs in one cell, then a stale cells.burg entry", async () => {
      const p = await evalv(`
        const C = pack.cells;
        const ok = b => b && b.i && !b.removed && !b.capital;
        const A = pack.burgs.filter(ok)[5], B = pack.burgs.filter(ok).find(b => b.i !== A.i && b.state === A.state);
        C.burg[B.cell] = 0; B.cell = A.cell; B.x = A.x; B.y = A.y;
        return { A: A.i, B: B.i, cell: A.cell, popA: A.population, popB: B.population };`);
      const { rows } = await found("burg-shared-cell", 1);
      assert.ok(hasEntity(rows[0], "burg", p.A) && hasEntity(rows[0], "burg", p.B));
      assert.match(rows[0].msg, new RegExp(`cell ${p.cell}`));
      // the cell link is fine for the owner of cells.burg and is not double-reported for the other
      await found("burg-cell-link", 0);
      // a locked burg is not moved: the fix says so instead
      await evalv("pack.burgs[args].lock = true", p.B);
      const locked = await found("burg-shared-cell", 1);
      assert.ok(!locked.rows[0].fix && /is locked/.test(locked.rows[0].hint ?? ""), JSON.stringify(locked.rows[0]));
      await evalv("pack.burgs[args].lock = false", p.B);
      await apply((await found("burg-shared-cell", 1)).rows[0].fix);
      await clean("burg-shared-cell");
      await clean("burg-cell-link");

      const q = await evalv(`
        const C = pack.cells;
        const b = pack.burgs.filter(b => b && b.i && !b.removed && !b.capital)[9];
        C.burg[b.cell] = 0;
        const stray = C.i.find(c => C.h[c] >= 20 && !C.burg[c]);
        C.burg[stray] = 60000;
        return { i: b.i, cell: b.cell, stray };`);
      const link = await found("burg-cell-link", 2);
      assert.ok(link.rows.some(r => hasEntity(r, "burg", q.i)));
      assert.ok(link.rows.some(r => hasEntity(r, "burg", 60000) && /missing burg 60000/.test(r.msg)));
      for (const r of link.rows) await apply(r.fix);
      await clean("burg-cell-link");
    });

    test("capital-outside: the capital's cell is painted into another state; the fix picks another capital", async () => {
      const p = await evalv(`
        const C = pack.cells;
        const s = pack.states.find(s => s.i && !s.removed && pack.burgs.filter(b => b && !b.removed && b.state === s.i).length > 3);
        const cap = pack.burgs[s.capital];
        const other = pack.states.find(t => t.i && t.i !== s.i && !t.removed);
        C.state[cap.cell] = other.i;
        return { s: s.i, name: s.name, cap: cap.i, other: other.name };`);
      const { rows } = await found("capital-outside", 1);
      assert.equal(rows[0].sev, "error");
      assert.ok(hasEntity(rows[0], "state", p.s) && hasEntity(rows[0], "burg", p.cap));
      assert.match(rows[0].msg, new RegExp(p.other));
      assert.equal(rows[0].fix?.tool, "edit");
      assert.equal(rows[0].fix?.args.type, "state");
      await apply(rows[0].fix);
      await clean("capital-outside");
      const cap = await evalv("return pack.states[args].capital", p.s);
      assert.notEqual(cap, p.cap);
    });

    test("province-empty and state-empty: all cells repainted away; the fixes remove them", async () => {
      const p = await evalv(`
        const C = pack.cells;
        const prov = pack.provinces.find(p => p.i && !p.removed && pack.states[p.state].provinces.length > 1);
        for (let c = 0; c < C.province.length; c++) if (C.province[c] === prov.i) C.province[c] = 0;
        const st = pack.states.filter(s => s.i && !s.removed).pop();
        for (let c = 0; c < C.state.length; c++) if (C.state[c] === st.i) C.state[c] = 0;
        return { prov: prov.i, pname: prov.name, st: st.i, sname: st.name };`);
      const pe = await found("province-empty", 1);
      assert.ok(hasEntity(pe.rows[0], "province", p.prov));
      assert.equal(pe.rows[0].fix?.tool, "eval");
      // the province's coat of arms goes with it, as in the provinces editor
      await evalv(
        `const g = document.createElementNS('http://www.w3.org/2000/svg', 'g'); g.id = 'provinceCOA' + args; defs.node().appendChild(g);
         const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('data-i', args);
         document.querySelector('#emblems #provinceEmblems').appendChild(u)`,
        p.prov
      );
      const se = await found("state-empty", 1);
      assert.ok(hasEntity(se.rows[0], "state", p.st));
      await apply(pe.rows[0].fix);
      await clean("province-empty");
      const removed = await evalv("return pack.provinces[args].removed === true", p.prov);
      assert.equal(removed, true);
      const emblem = await evalv(
        "return [!!document.getElementById('provinceCOA' + args), !!document.querySelector('#provinceEmblems > use[data-i=\"' + args + '\"]')]",
        p.prov
      );
      assert.deepEqual(emblem, [false, false], "the emblem of the removed province is gone");
      await apply(se.rows[0].fix);
      await clean("state-empty");
    });
  });

  describe("names", () => {
    before(reload);

    test("unnamed: river, zone, lake, burg and state; types filter; kinds breakdown; the river fix names it", async () => {
      const p = await evalv(`
        const lake = pack.features.find(f => f && f.type === 'lake');
        const r = pack.rivers[3], z = pack.zones[0], b = pack.burgs.find(b => b && b.i && !b.removed), s = pack.states.find(s => s.i && !s.removed);
        const old = { river: r.name, lake: lake.name, zone: z.name, burg: b.name, state: s.name };
        r.name = ''; lake.name = undefined; z.name = ' '; b.name = ''; s.name = '';
        return { r: r.i, lake: lake.i, z: z.i, b: b.i, s: s.i, old };`);
      const mine = ["river", "feature", "zone", "burg", "state"];
      const { out, rows } = await found("unnamed", 5, { types: mine });
      assert.deepEqual(out.kinds?.unnamed, { river: 1, feature: 1, zone: 1, burg: 1, state: 1 });
      assert.equal(rows[0].sev, "error", "an unnamed state sorts first");
      assert.ok(hasEntity(rows[0], "state", p.s));
      const river = rows.find(r => hasEntity(r, "river", p.r));
      assert.equal(river?.fix?.tool, "edit");
      assert.ok(rows.find(r => hasEntity(r, "zone", p.z))?.hint, "a zone needs a human name: hint, no fix");
      await apply(river?.fix);
      const named = await evalv("return pack.rivers.find(r => r.i === args).name", p.r);
      assert.ok(named && named.length > 1);
      const again = await lint({ checks: ["unnamed"], types: ["river"] });
      assert.equal(again.counts.unnamed ?? 0, 0);
      // minSeverity drops the route rows
      const warn = await lint({ checks: ["unnamed"], minSeverity: "warn" });
      assert.equal(warn.kinds?.unnamed?.route, undefined);
      await evalv(
        `const o = args.old; pack.rivers.find(r => r.i === args.r).name = o.river; pack.features[args.lake].name = o.lake;
         pack.zones.find(z => z.i === args.z).name = o.zone; pack.burgs[args.b].name = o.burg; pack.states[args.s].name = o.state`,
        p
      );
    });

    test("name-duplicate: two states with one name; the fix renames the second", async () => {
      await h.ok("edit", {
        type: "state",
        ops: [
          { ref: 3, set: { name: "Dupland" } },
          { ref: 4, set: { name: "dupland" } }
        ]
      });
      const { rows } = await found("name-duplicate", 1, { types: ["state"] });
      assert.equal(rows[0].sev, "warn");
      assert.ok(hasEntity(rows[0], "state", 3) && hasEntity(rows[0], "state", 4));
      await apply(rows[0].fix);
      await found("name-duplicate", 0, { types: ["state"] });
    });

    test("name-duplicate: a locked state keeps its name, the other is renamed; when all are locked the row says so", async () => {
      await h.ok("edit", {
        type: "state",
        ops: [
          { ref: 3, set: { name: "Lockland" } },
          { ref: 4, set: { name: "Lockland", lock: true } }
        ]
      });
      const first = await found("name-duplicate", 1, { types: ["state"] });
      const ops = first.rows[0].fix?.args.ops as Obj[];
      assert.deepEqual(
        ops.map(o => o.ref),
        [3],
        "state 4 is locked and keeps the name"
      );
      await h.ok("edit", { type: "state", ops: [{ ref: 3, set: { lock: true } }] });
      const all = await found("name-duplicate", 1, { types: ["state"] });
      assert.ok(!all.rows[0].fix && /locked/.test(all.rows[0].hint ?? ""), JSON.stringify(all.rows[0]));
      await h.ok("edit", {
        type: "state",
        ops: [
          { ref: 3, set: { lock: false } },
          { ref: 4, set: { lock: false } }
        ]
      });
      await reload();
    });

    test("unnamed routes are one row; its fix names them all, and under an area filter only those inside", async () => {
      const { rows } = await found("unnamed", 1, { types: ["route"] });
      assert.match(rows[0].msg, /^578 of 578 routes have no name/);
      assert.equal(rows[0].fix?.tool, "eval");
      const m = (await lint({ checks: ["unnamed"], types: ["route"] })).map;
      const half = await found("unnamed", 1, { types: ["route"], bbox: [0, 0, m.w / 2, m.h / 2] });
      const n = Number(/^(\d+) of 578/.exec(half.rows[0].msg)?.[1]);
      assert.ok(n > 20 && n < 578, `routes in the north-west quarter: ${n}`);
      const part = await apply(half.rows[0].fix);
      assert.equal(part.value, n, "the area-limited fix names exactly the routes it counted");
      const left = await lint({ checks: ["unnamed"], types: ["route"] });
      assert.match(left.rows.unnamed[0].msg, new RegExp(`^${578 - n} of 578`));
      const res = await apply(left.rows.unnamed[0].fix);
      assert.equal(res.value, 578 - n);
      await clean("unnamed", { types: ["route"] });
      await reload();
    });

    test("note-orphan: notes of removed or missing entities; fixAll removes them, real notes stay", async () => {
      const ids = ["burg60000", "marker88888", "route77777", "river66666", "regiment99-1", "stateLabel55"];
      await h.ok("add", {
        type: "note",
        items: [
          ...ids.map(id => ({ id, name: `ghost ${id}` })),
          { id: "mapNote", name: "free-form notes are never orphans" }
        ]
      });
      const { out, rows } = await found("note-orphan", ids.length);
      assert.deepEqual(rows.map(r => r.e[0][1]).sort(), [...ids].sort());
      assert.equal(out.fixAll?.["note-orphan"].tool, "edit");
      assert.equal(out.fixAll?.["note-orphan"].args.ops.length, ids.length);
      await apply(out.fixAll?.["note-orphan"]);
      await clean("note-orphan");
      const left = await evalv("return notes.filter(n => n.id === 'mapNote').length");
      assert.equal(left, 1);
      await h.ok("edit", { type: "note", ops: [{ ref: "mapNote", remove: true }] });
    });
  });

  describe("rivers and routes", () => {
    before(reload);

    test("river-uphill: a raised cell; severity scales with the rise; the fix lowers the cell", async () => {
      const p = await evalv(`
        const C = pack.cells;
        const r = pack.rivers.find(r => r.cells.length >= 6 && r.cells.every(c => c >= 0 && C.h[c] >= 25));
        const c = r.cells[3];
        const before = Math.min(...r.cells.slice(0, 3).map(k => C.h[k]));
        C.h[c] = 100;
        return { r: r.i, c, rise: 100 - before, x: C.p[c][0], y: C.p[c][1] };`);
      const here = { near: { cell: p.c }, radius: 3 };
      const { rows } = await found("river-uphill", 1, { ...here, types: ["river"] });
      assert.equal(rows[0].sev, "error", "a rise of 3x the tolerance is an error");
      assert.ok(hasEntity(rows[0], "river", p.r));
      assert.match(rows[0].msg, new RegExp(`climbs ${p.rise} downstream at cell ${p.c}`));
      assert.equal(rows[0].fix?.tool, "paint_cells");
      // riverTol is the threshold
      await found("river-uphill", 1, { ...here, riverTol: p.rise });
      await found("river-uphill", 0, { ...here, riverTol: p.rise + 1 });
      await apply(rows[0].fix);
      await clean("river-uphill", here);
    });

    test("river-loop and river-gap: a revisited cell and a jump; consecutive repeats are not loops", async () => {
      const p = await evalv(`
        const C = pack.cells;
        const ok = pack.rivers.filter(r => r.cells.length >= 6 && r.cells.every(c => c >= 0));
        const a = ok[0], b = ok[1];
        a.cells = [...a.cells, a.cells[1]];
        b.cells[2] = C.i.length - 1;
        const rep = ok[2]; rep.cells = [rep.cells[0], rep.cells[0], ...rep.cells.slice(1)];
        return { a: a.i, b: b.i, rep: rep.i };`);
      const loop = await found("river-loop", 1);
      assert.ok(hasEntity(loop.rows[0], "river", p.a));
      assert.ok(!loop.rows.some(r => hasEntity(r, "river", p.rep)), "a consecutive repeat is harmless");
      const gap = await found("river-gap", 2);
      assert.ok(gap.rows.some(r => hasEntity(r, "river", p.b)));
      // removing a river (with its tributaries) is the bigger change: a loop gets a hint, not a
      // ready fix; a gap gets a reroute through the land cells between when there is one
      assert.ok(!loop.rows[0].fix, "no automatic fix for a loop");
      for (const r of gap.rows) {
        if (r.fix) assert.equal(r.fix.args.type, "river", JSON.stringify(r.fix));
        else assert.match(r.hint ?? "", /recalculate:'rivers\+biomes'/);
      }
      assert.match(loop.rows[0].hint ?? "", new RegExp(`edit river \\{ref:${p.a}, remove:true\\}`));
      await h.ok("edit", { type: "river", ops: [{ ref: p.a, remove: true }] });
      await clean("river-loop");
      const left = await evalv("return pack.rivers.some(r => r.i === args)", p.a);
      assert.equal(left, false);
    });

    test("river-uphill: several rising cells are one row with one fix that clears them", async () => {
      await reload();
      const p = await evalv(`
        const C = pack.cells;
        const r = pack.rivers.find(r => r.cells.length >= 9 && r.cells.every(c => c >= 0 && C.h[c] >= 25));
        const a = r.cells[3], b = r.cells[6];
        C.h[a] = 100; C.h[b] = 100;
        return { r: r.i, a, b };`);
      const out = await lint({ checks: ["river-uphill"], types: ["river"], limit: 100 });
      const rows = rowsOf(out, "river-uphill").filter(r => hasEntity(r, "river", p.r));
      assert.equal(rows.length, 1, "one row per river");
      assert.match(rows[0].msg, /\d+ cells rise in all/);
      const sel = (rows[0].fix?.args.select as Obj).cells as number[];
      assert.ok(sel.includes(p.a) && sel.includes(p.b), `both raised cells are selected: ${JSON.stringify(sel)}`);
      await apply(rows[0].fix);
      const again = await lint({ checks: ["river-uphill"], types: ["river"], limit: 100 });
      assert.ok(!rowsOf(again, "river-uphill").some(r => hasEntity(r, "river", p.r)), "one pass clears the river");
    });

    test("route-link: stale, wrong and missing cells.routes links; fixAll relinks everything", async () => {
      const p = await evalv(`
        const C = pack.cells;
        const gone = pack.routes[4].i;
        pack.routes = pack.routes.filter(r => r.i !== gone);
        const m = pack.routes.find(r => r.points.length > 3);
        const [a, b] = [m.points[0][2], m.points[1][2]];
        delete C.routes[a][b]; delete C.routes[b][a];
        const w = pack.routes.find(r => r.i !== m.i && r.points.length > 3);
        const [c, d] = [w.points[1][2], w.points[2][2]];
        const other = pack.routes.find(r => r.i !== w.i && r.i !== m.i && !r.points.some(p => p[2] === c || p[2] === d));
        C.routes[c][d] = other.i; C.routes[d][c] = other.i;
        return { gone, m: m.i, w: w.i, other: other.i };`);
      const out = await lint({ checks: ["route-link"], limit: 100 });
      const rows = rowsOf(out, "route-link");
      assert.ok(rows.length >= 3, JSON.stringify(rows));
      assert.ok(rows.some(r => hasEntity(r, "route", p.gone) && /no longer exists/.test(r.msg)));
      assert.ok(rows.some(r => hasEntity(r, "route", p.m) && /no cells.routes link/.test(r.msg)));
      assert.ok(rows.some(r => hasEntity(r, "route", p.other) && /does not pass/.test(r.msg)));
      assert.equal(out.fixAll?.["route-link"].tool, "eval");
      const fixed = await apply(out.fixAll?.["route-link"]);
      assert.equal(typeof fixed.value, "number", "the fix snippets return a value");
      await clean("route-link");
    });

    test("route-point-cell: dragged points are found and snapped back; a point in its own nearest cell is never flagged", async () => {
      await reload();
      const p = await evalv(`
        const rs = pack.routes.filter(r => r.points.length > 6 && r.i > 20);
        const [a, b, c, d, e] = rs;
        a.points[2][0] += 90;
        b.points[3][1] += 90; b.points[4][0] -= 90;
        // 40 px from the cell centre, but its recorded cell is the nearest one there: not an error
        const q = c.points[3]; q[0] += 40; q[2] = findCell(q[0], q[1]);
        window.__lintMore = [d.i, e.i];
        return { a: a.i, b: b.i, c: c.i, d: d.i, e: e.i };`);
      const first = await lint({ checks: ["route-point-cell"], limit: 50 });
      const rows = rowsOf(first, "route-point-cell");
      assert.equal(rows.length, 2, JSON.stringify(rows.map(r => r.msg)));
      assert.ok(hasEntity(rows[0], "route", p.a) || hasEntity(rows[1], "route", p.a));
      assert.ok(!rows.some(r => hasEntity(r, "route", p.c)), "recorded cell == nearest cell is fine at any distance");
      assert.match(rows.find(r => hasEntity(r, "route", p.b))?.msg ?? "", /^route \d+: 2 point\(s\)/);
      assert.ok(first.fixAll?.["route-point-cell"], "several routes: one call repairs them all");
      const aRow = rows.find(r => hasEntity(r, "route", p.a));
      assert.ok(aRow && !aRow.fix, "with a fixAll beside them the rows carry no fix of their own");
      // filtered to one route, its own fix is offered, and it clears its own row
      const single = rowsOf(
        await lint({ checks: ["route-point-cell"], near: { x: aRow.at?.[0] ?? 0, y: aRow.at?.[1] ?? 0 }, radius: 4 }),
        "route-point-cell"
      );
      assert.equal(single.length, 1);
      await apply(single[0].fix);
      assert.equal((await lint({ checks: ["route-point-cell"], limit: 50 })).counts["route-point-cell"], 1);
      // two more, then fixAll
      await evalv(
        "for (const i of window.__lintMore) { const r = pack.routes.find(r => r.i === i); r.points[2][0] += 120; }"
      );
      const many = await lint({ checks: ["route-point-cell"], limit: 50 });
      assert.equal(many.counts["route-point-cell"], 3);
      // ignoring one route scopes the fixAll to the others
      const scoped = await lint({ checks: ["route-point-cell"], ignore: [{ type: "route", id: p.d }] });
      assert.equal(scoped.counts["route-point-cell"], 2);
      await apply(scoped.fixAll?.["route-point-cell"]);
      const left = rowsOf(await lint({ checks: ["route-point-cell"], limit: 50 }), "route-point-cell");
      assert.equal(left.length, 1, "only the ignored route is still off");
      assert.ok(hasEntity(left[0], "route", p.d));
      const res = await apply(many.fixAll?.["route-point-cell"]);
      assert.ok((res.value as number) >= 1, "the fix reports how many points it re-derived");
      await clean("route-point-cell");
      await clean("route-link");
    });

    test("route-end-burg: a route left ending where its burg was removed; the fix trims the dangling end", async () => {
      await reload();
      const p = await evalv(`
        const C = pack.cells;
        const market = b => (pack.markets || []).some(m => m.centerBurgId === b.i);
        for (const r of pack.routes) {
          const p0 = r.points[0];
          const b = pack.burgs[C.burg[p0[2]]];
          if (b && b.i && !b.capital && !market(b) && r.points.length >= 8) return { r: r.i, b: b.i, name: b.name, n: r.points.length };
        }
        return null;`);
      assert.ok(p, "a route that starts at a plain burg exists");
      await h.ok("edit", { type: "burg", ops: [{ ref: p.b, remove: true }] });
      const out = await lint({ checks: ["route-end-burg"], limit: 50 });
      const rows = rowsOf(out, "route-end-burg");
      const mine = rows.find(r => hasEntity(r, "route", p.r));
      assert.ok(mine && hasEntity(mine, "burg", p.b), JSON.stringify(rows));
      assert.match(mine.msg, new RegExp(p.name));
      // trimming the end is the suggestion, not removing the route: one fix per row, or one fixAll for several
      assert.equal(out.fixAll?.["route-end-burg"].tool, "eval");
      if (rows.length === 1) assert.equal(mine.fix?.tool, "eval");
      else assert.ok(!mine.fix, "several rows: the fixAll is the fix");
      // a burg with several roads leaves several dangling ends: one call trims them all
      const res = await apply(out.fixAll?.["route-end-burg"]);
      const trim = res.value as { pointsTrimmed: number; routesRemoved: number[]; note: string };
      assert.ok(trim.pointsTrimmed >= rows.length);
      // a short route left with under 2 points is removed, and the result says which
      assert.ok(!trim.routesRemoved.includes(p.r), "the long route is trimmed, not removed");
      assert.match(trim.note, trim.routesRemoved.length ? /removed/ : /no route was removed/);
      await clean("route-end-burg");
      const len = await evalv("return pack.routes.find(r => r.i === args)?.points.length ?? null", p.r);
      assert.ok(len !== null && len < p.n, "the route is trimmed, not removed");
      await clean("route-link");
      await clean("note-orphan");
    });

    test("a check that throws is skipped alone, with its name; the checks beside it still report", async () => {
      await reload();
      // cells.routes throws, but only for the route-link check (the harness reads it too)
      await evalv(`
        const saved = pack.cells.routes;
        Object.defineProperty(pack.cells, 'routes', {
          get() { if (new Error().stack.includes('checkRouteLink')) throw new Error('boom'); return saved; },
          set(v) { Object.defineProperty(pack.cells, 'routes', { value: v, writable: true, enumerable: true, configurable: true }); },
          enumerable: true,
          configurable: true
        });
        return 1;`);
      const out = await lint({ checks: ["route-link", "route-point-cell", "route-end-burg"] });
      assert.deepEqual(
        (out.skipped ?? []).map(s => s.check),
        ["route-link"]
      );
      assert.match((out.skipped ?? [])[0].reason, /check failed: boom/);
      assert.deepEqual(out.clean, ["route-point-cell", "route-end-burg"]);
      await reload();
    });
  });

  describe("stale cell ids after a height rebuild", () => {
    before(reload);

    test("cells.routes full of holes and stale cells on routes, markers and rivers: every check reports, none crashes", async () => {
      await h.ok("paint_cells", {
        select: { circle: { at: { x: 500, y: 300 }, radius: 80 } },
        set: { height: { value: 5, rebuild: "risk" } }
      });
      // after the merge with dx/terrain the risk rebuild carries route points and markers over to the
      // new cells and rebuilds cells.routes with Routes.buildLinks (riskRebuild): no holes, no link
      // the routes do not make; a carried point records the cell under it (dx/core-2)
      const carried = await lint({ checks: ["route-link", "route-point-cell"], limit: 3 });
      assert.equal(carried.counts["route-link"] ?? 0, 0, JSON.stringify(rowsOf(carried, "route-link")));
      assert.equal(carried.counts["route-point-cell"] ?? 0, 0, JSON.stringify(rowsOf(carried, "route-point-cell")));
      // the stale state an older rebuild (or a hand edit) leaves: holes in cells.routes, a route point
      // on a cell that does not exist, markers whose cell is elsewhere
      await h.ok("eval", {
        code: `const C = pack.cells; let n = 0;
          for (const k of Object.keys(C.routes)) if (n++ % 3 === 0) C.routes[k] = undefined;
          for (const r of pack.routes.filter(r => r && r.points && r.points.length > 2).slice(0, 2))
            r.points[1][2] = C.i.length + 7;
          for (const m of pack.markers.filter(m => m && m.cell !== undefined).slice(0, 3))
            m.cell = (m.cell + Math.floor(C.i.length / 2)) % C.i.length;
          return n;`
      });
      const holes = await evalv(
        "const C = pack.cells; return Object.keys(C.routes).filter(k => C.routes[k] === undefined).length"
      );
      assert.ok(holes > 100, `the rebuild leaves undefined rows in cells.routes (${holes})`);
      const out = await lint({ limit: 3 });
      assert.deepEqual(
        (out.skipped ?? []).filter(s => /check failed/.test(s.reason)),
        []
      );
      for (const id of ["route-link", "route-point-cell", "marker-cell-link"])
        assert.ok((out.counts[id] ?? 0) > 0, `${id} names the stale data`);
      assert.match(rowsOf(out, "route-point-cell")[0].msg, /does not exist|px from cell/);
      // the repair calls clear what they name
      for (const id of ["marker-cell-link", "route-point-cell", "route-link"]) {
        const fix = out.fixAll?.[id];
        assert.ok(fix, `${id} has a fixAll`);
        const res = await apply(fix);
        assert.equal(typeof res.value, "number");
      }
      for (const id of ["marker-cell-link", "route-point-cell", "route-link"]) await clean(id);
    });
  });

  describe("markers", () => {
    before(reload);

    test("marker-stacked: two markers on one spot; the fix spreads them; a cluster is one row", async () => {
      const at = await evalv(`
        const C = pack.cells;
        const far = c => pack.markers.every(m => Math.hypot(m.x - C.p[c][0], m.y - C.p[c][1]) > 120) && pack.burgs.every(b => !b || !b.i || b.removed || Math.hypot(b.x - C.p[c][0], b.y - C.p[c][1]) > 40);
        const c = C.i.find(c => C.h[c] >= 30 && C.c[c].every(k => C.h[k] >= 30) && far(c));
        return { x: C.p[c][0], y: C.p[c][1] };`);
      await h.ok("add", {
        type: "marker",
        items: [
          { at, type: "inns" },
          { at, type: "ruins" },
          { at, type: "caves" }
        ]
      });
      const { rows } = await found("marker-stacked", 1, { near: at, radius: 30 });
      assert.equal(rows[0].e.length, 3, "three stacked markers are one cluster row");
      assert.match(rows[0].msg, /^3 markers within 20 px/);
      assert.equal(rows[0].fix?.args.ops.length, 2, "two of the three are moved");
      await apply(rows[0].fix);
      await clean("marker-stacked", { near: at, radius: 30 });
      // markerGap is a parameter
      const wide = await lint({ checks: ["marker-stacked"], markerGap: 60, near: at, radius: 100 });
      assert.ok((wide.counts["marker-stacked"] ?? 0) >= 1, "a 60 px gap finds the spread-out markers again");
    });

    test("marker-in-water: a land-only type in the sea is an error, water types and custom types are not", async () => {
      // four deep-water spots, 60+ px apart, in one 400 px neighbourhood
      const sp = await evalv(`
        const C = pack.cells;
        const deep = c => C.h[c] < 20 && C.c[c].every(k => C.h[k] < 20 && C.c[k].every(j => C.h[j] < 20));
        const c0 = C.i.find(c => deep(c) && C.p[c][0] > 100 && C.p[c][1] > 100);
        const out = [C.p[c0]];
        for (const c of C.i) {
          if (out.length === 4) break;
          if (deep(c) && out.every(q => Math.hypot(q[0] - C.p[c][0], q[1] - C.p[c][1]) > 60) && Math.hypot(C.p[c0][0] - C.p[c][0], C.p[c0][1] - C.p[c][1]) < 300) out.push(C.p[c]);
        }
        return out.map(q => ({ x: q[0], y: q[1] }));`);
      assert.equal(sp.length, 4, "four deep-water spots");
      const p = sp[0];
      await h.ok("add", {
        type: "marker",
        items: [
          { at: sp[0], type: "volcanoes", note: { name: "Drowned volcano" } },
          { at: sp[1], type: "sea-monsters" },
          { at: sp[2], type: "harbor-light" },
          { at: sp[3], type: "oddity" }
        ]
      });
      const { rows } = await found("marker-in-water", 2, { near: p, radius: 400 });
      const volcano = rows.find(r => /volcanoes/.test(r.msg));
      assert.equal(volcano?.sev, "error");
      assert.match(volcano?.msg ?? "", /land-only/);
      assert.equal(rows.find(r => /oddity/.test(r.msg))?.sev, "warn", "a custom type in water is a warning");
      await apply(volcano?.fix);
      const left = await lint({ checks: ["marker-in-water"], near: p, radius: 400, minSeverity: "error" });
      assert.equal(left.counts["marker-in-water"] ?? 0, 0);
    });

    test("marker-cell-link: a stale recorded cell is reported, and does not make a marker on land look 'in water'", async () => {
      await reload();
      const p = await evalv(`
        const C = pack.cells;
        const m = pack.markers.find(m => !['sea-monsters', 'pirates', 'lake-monsters'].includes(m.type) && C.h[findCell(m.x, m.y)] >= 20 && C.h[m.cell] >= 20);
        const water = C.i.find(c => C.h[c] < 20 && Math.hypot(C.p[c][0] - m.x, C.p[c][1] - m.y) > 100);
        m.cell = water;
        return { i: m.i, x: m.x, y: m.y, water, real: findCell(m.x, m.y) };`);
      const here = { near: { x: p.x, y: p.y }, radius: 10 };
      const link = await found("marker-cell-link", 1, here);
      assert.ok(hasEntity(link.rows[0], "marker", p.i));
      assert.match(link.rows[0].msg, new RegExp(`records cell ${p.water}, but its coordinates fall in cell ${p.real}`));
      await clean("marker-in-water", here); // it stands on land: judged by its coordinates, not its stale cell
      await apply(link.rows[0].fix);
      await clean("marker-cell-link", here);
      const cell = await evalv("return pack.markers.find(m => m.i === args).cell", p.i);
      assert.equal(cell, p.real);
    });

    test("marker-near-burg (opt-in): a marker beside a burg is found by name only; the fix moves it away", async () => {
      await reload();
      const b = await evalv(`
        const bs = pack.burgs.filter(b => b && b.i && !b.removed);
        const b = bs.find(b => pack.markers.every(m => Math.hypot(m.x - b.x, m.y - b.y) > 80) && bs.every(o => o === b || Math.hypot(o.x - b.x, o.y - b.y) > 60) && b.x > 80 && b.x < 1200);
        return { i: b.i, x: b.x, y: b.y, name: b.name };`);
      await h.ok("add", { type: "marker", items: [{ at: { x: b.x + 4, y: b.y }, type: "inns" }] });
      const here = { near: { x: b.x, y: b.y }, radius: 12 };
      const plain = await lint({ near: { x: b.x, y: b.y }, radius: 12 });
      assert.ok(
        !("marker-near-burg" in plain.counts) && !plain.clean.includes("marker-near-burg"),
        "not in a default run"
      );
      const { rows } = await found("marker-near-burg", 1, here);
      assert.ok(hasEntity(rows[0], "burg", b.i));
      assert.match(rows[0].msg, new RegExp(`is 4 px from ${b.name}`));
      assert.equal(rows[0].fix?.args.type, "marker");
      await apply(rows[0].fix);
      await clean("marker-near-burg", { near: { x: b.x, y: b.y }, radius: 60 });
    });
  });

  describe("labels", () => {
    before(reload);

    test("label-offcanvas: custom labels at the map corners; the fix moves them inside", async () => {
      const m = (await lint({ checks: ["label-offcanvas"] })).map;
      await h.ok("add", {
        type: "label",
        items: [
          { at: { x: 3, y: 3 }, text: "The Northwest Passage" },
          { at: { x: m.w - 2, y: m.h - 2 }, text: "Southeast Reaches" }
        ]
      });
      const { rows } = await found("label-offcanvas", 2);
      assert.ok(rows.every(r => r.e[0][0] === "label" && r.fix?.tool === "edit"));
      assert.match(rows[0].msg, /custom label/);
      assert.match(rows.map(r => r.msg).join(" "), /left \d+/);
      assert.match(rows.map(r => r.msg).join(" "), /right \d+/);
      for (const r of rows) await apply(r.fix);
      await clean("label-offcanvas");
    });

    test("label-overlap: two custom labels on one spot; the fix separates them", async () => {
      await h.ok("add", {
        type: "label",
        items: [
          { at: { x: 800, y: 400 }, text: "Salt Marshes" },
          { at: { x: 810, y: 402 }, text: "Salt Marshes East" }
        ]
      });
      const { rows } = await found("label-overlap", 1, { near: { x: 800, y: 400 }, radius: 80 });
      assert.equal(rows[0].e.length, 2);
      assert.equal(rows[0].fix?.args.type, "label");
      assert.match(rows[0].msg, /custom label "Salt Marshes"/);
      await apply(rows[0].fix);
      await clean("label-overlap", { near: { x: 800, y: 400 }, radius: 80, overlapMin: 0.05 });
    });

    test("label-overlap with a drawn curved state label: glyph runs, not the bounding box", async () => {
      await h.ok("eval", { code: "1", readOnly: true, redraw: ["labels"] });
      const base = await lint({ checks: ["label-overlap", "label-offcanvas"], limit: 200 });
      assert.deepEqual(base.skipped ?? [], [], "labels are drawn now");
      assert.ok(base.scanned.labels > 15, `measured ${base.scanned.labels} labels`);
      const spot = await evalv(`
        const t = document.getElementById('stateLabel1');
        const n = t.getNumberOfChars();
        const r = t.getExtentOfChar(Math.floor(n / 2));
        const vb = document.getElementById('viewbox').getCTM().inverse().multiply(t.getCTM());
        const x = vb.a * (r.x + r.width / 2) + vb.c * (r.y + r.height / 2) + vb.e;
        const y = vb.b * (r.x + r.width / 2) + vb.d * (r.y + r.height / 2) + vb.f;
        return { x, y, text: t.textContent };`);
      await h.ok("add", { type: "label", items: [{ at: spot, text: "XXXXXXXX" }] });
      const out = await lint({ checks: ["label-overlap"], limit: 200, near: spot, radius: 40 });
      const hit = rowsOf(out, "label-overlap").find(r => hasEntity(r, "state", 1) && r.e.some(t => t[0] === "label"));
      assert.ok(hit, `custom label over the state's glyphs: ${JSON.stringify(rowsOf(out, "label-overlap"))}`);
    });

    test("label groups hidden by the zoom rule are measured at the lowest zoom where they show, and the DOM is left as it was", async () => {
      await h.ok("eval", { code: "1", readOnly: true, redraw: ["labels"] });
      const hid = await evalv(`
        for (const g of document.querySelectorAll('#burgLabels > g')) {
          const t = [...g.querySelectorAll('text')];
          if (t.length >= 2 && g.classList.contains('hidden')) return { g: g.id, a: t[0].id, b: t[1].id, size: +g.dataset.size };
        }
        return null;`);
      assert.ok(hid, "a burg label group is hidden by the hide-labels rule at zoom 1");
      await evalv(
        `const a = document.getElementById(args.a), b = document.getElementById(args.b);
         b.setAttribute('x', a.getAttribute('x')); b.setAttribute('y', a.getAttribute('y'));`,
        hid
      );
      const idA = Number(hid.a.replace("burgLabel", ""));
      const idB = Number(hid.b.replace("burgLabel", ""));
      const dom = () => evalv("return document.getElementById('labels').outerHTML");
      const before = await dom();
      const out = await lint({ checks: ["label-overlap"], limit: 200 });
      assert.equal(await dom(), before, "font sizes and hidden classes are put back exactly");
      const hit = rowsOf(out, "label-overlap").find(r => hasEntity(r, "burg", idA) && hasEntity(r, "burg", idB));
      assert.ok(
        hit,
        `the two stacked labels of a hidden group are found: ${JSON.stringify(rowsOf(out, "label-overlap").slice(0, 3))}`
      );
      assert.match(hit.msg, /at zoom \d/);
      assert.ok(out.notes?.some(n => /lowest zoom where it shows/.test(n)));
      // atScale 1 pins the zoom: the group is hidden there, so the pair is not seen
      const one = await lint({ checks: ["label-overlap"], limit: 200, atScale: 1 });
      assert.ok(!rowsOf(one, "label-overlap").some(r => hasEntity(r, "burg", idA) && hasEntity(r, "burg", idB)));
      assert.ok(
        one.notes?.some(n => /measured at zoom 1 \(\d+ of \d+ labels are hidden/.test(n)),
        JSON.stringify(one.notes)
      );
      const ten = await lint({ checks: ["label-overlap"], limit: 200, atScale: 10 });
      assert.ok(rowsOf(ten, "label-overlap").some(r => hasEntity(r, "burg", idA) && hasEntity(r, "burg", idB)));
      assert.equal(await dom(), before);
      await h.ok("eval", { code: "1", readOnly: true, redraw: ["labels"] });
    });

    test("label-marker-overlap (opt-in): a pin over a burg label is found by name only; the fix nudges the pin", async () => {
      const spot = await evalv(`
        const t = document.querySelector('#burgLabels #capital text');
        const r = t.getBBox();
        const vb = document.getElementById('viewbox').getCTM().inverse().multiply(t.getCTM());
        const x = vb.a * (r.x + r.width / 2) + vb.c * (r.y + r.height / 2) + vb.e;
        const y = vb.b * (r.x + r.width / 2) + vb.d * (r.y + r.height / 2) + vb.f;
        return { x, y, burg: +t.id.replace('burgLabel', '') };`);
      await h.ok("add", { type: "marker", items: [{ at: { x: spot.x, y: spot.y + 3 }, type: "inns" }] });
      const mk = await evalv("return Math.max(...pack.markers.map(m => m.i))");
      const here = { near: { x: spot.x, y: spot.y }, radius: 12 };
      const plain = await lint({ checks: ["label-overlap", "label-offcanvas"], ...here });
      assert.ok(!("label-marker-overlap" in plain.counts));
      const out = await lint({ checks: ["label-marker-overlap"], limit: 50, ...here });
      const hit = rowsOf(out, "label-marker-overlap").find(r => hasEntity(r, "marker", mk));
      assert.ok(hit && hasEntity(hit, "burg", spot.burg), JSON.stringify(out.rows));
      assert.match(hit.msg, new RegExp(`^marker ${mk} \\(inns\\) covers \\d+% of burg label`));
      assert.equal(hit.fix?.args.type, "marker");
      assert.ok(
        out.notes?.some(n => /markers layer is off/.test(n)),
        "pins are measured while the layer is off, and it says so"
      );
      await apply(hit.fix);
      const left = await lint({ checks: ["label-marker-overlap"], limit: 50, ...here });
      assert.ok(
        !rowsOf(left, "label-marker-overlap").some(r => hasEntity(r, "marker", mk) && hasEntity(r, "burg", spot.burg)),
        "the pin no longer covers that label"
      );
    });

    test("label-offcanvas ignores an overhang of 2 px or less", async () => {
      await h.ok("add", { type: "label", items: [{ at: { x: 3, y: 300 }, text: "Edge Reach" }] });
      const near = { near: { x: 3, y: 300 }, radius: 60 };
      const row = rowsOf(await lint({ checks: ["label-offcanvas"], ...near }), "label-offcanvas")[0];
      assert.ok(row, "the label sticks out by a lot");
      const left = Number(/left (\d+)/.exec(row.msg)?.[1]);
      const id = row.e[0][1];
      // shift it right until about 1 px is left outside
      await h.ok("edit", { type: "label", ops: [{ ref: id, set: { move: { x: 3 + left - 1, y: 300 } } }] });
      await clean("label-offcanvas", near);
      await h.ok("edit", { type: "label", ops: [{ ref: id, set: { move: { x: 3 + left - 6, y: 300 } } }] });
      const four = rowsOf(await lint({ checks: ["label-offcanvas"], ...near }), "label-offcanvas");
      assert.equal(four.length, 1, "a 5 px overhang is reported again");
    });

    test("label-orphan: labels of a removed burg and a removed state; the fixes remove the elements", async () => {
      await h.ok("eval", { code: "1", readOnly: true, redraw: ["labels"] });
      const p = await evalv(`
        const st = pack.states.find(s => s.i && !s.removed && document.getElementById('stateLabel' + s.i));
        const bu = pack.burgs.find(b => b && b.i && !b.removed && !b.capital && document.getElementById('burgLabel' + b.i));
        st.removed = true; bu.removed = true;
        return { st: st.i, bu: bu.i };`);
      const { rows } = await found("label-orphan", 2);
      assert.ok(rows.some(r => hasEntity(r, "state", p.st) && /state label/.test(r.msg)));
      assert.ok(rows.some(r => hasEntity(r, "burg", p.bu) && /burg label/.test(r.msg)));
      for (const r of rows) await apply(r.fix);
      await clean("label-orphan");
    });

    test("a map with nothing to label is clean for the label checks, not skipped", async () => {
      await evalv(
        `for (const b of pack.burgs) if (b && b.i) b.removed = true; for (const s of pack.states) if (s && s.i) s.removed = true;
         document.querySelectorAll('#labels text').forEach(t => t.remove());`
      );
      const out = await lint({ checks: ["label-offcanvas", "label-overlap"] });
      assert.deepEqual(out.skipped ?? [], []);
      assert.deepEqual(out.clean, ["label-offcanvas", "label-overlap"]);
      await reload();
    });
  });

  describe("options", () => {
    before(reload);

    test("limit, maxRows, fixes, minSeverity and checks shape the output", async () => {
      const counts = await lint({ limit: 0 });
      assert.deepEqual(counts.rows, {}, "limit 0 is counts only");
      assert.ok(counts.counts.unnamed > 0);
      assert.equal(counts.more?.unnamed, counts.counts.unnamed);
      const few = await lint({ limit: 2 });
      for (const rows of Object.values(few.rows)) assert.ok(rows.length <= 2);
      const capped = await lint({ limit: 20, maxRows: 5, minSeverity: "info" });
      assert.equal(Object.values(capped.rows).flat().length, 5);
      assert.equal(Object.values(capped.rows).flat()[0].sev, "warn", "the cap keeps the most severe rows");
      const bare = await lint({ limit: 3, fixes: false });
      for (const r of Object.values(bare.rows).flat()) assert.ok(!r.fix && !r.hint);
      const warn = await lint({ minSeverity: "warn" });
      assert.equal(warn.totals.info, 0);
      const only = await lint({ checks: ["marker-stacked"] });
      assert.deepEqual(Object.keys(only.counts), ["marker-stacked"]);
      assert.deepEqual(only.skipped ?? [], []);
      assert.equal(only.clean.length, 0);
    });

    test("area filters: bbox and near+radius with an entity place", async () => {
      const all = await lint({ checks: ["marker-stacked"] });
      const row = rowsOf(all, "marker-stacked")[0];
      assert.ok(row?.at);
      const [x, y] = row.at;
      const inside = await lint({ checks: ["marker-stacked"], bbox: [x - 5, y - 5, x + 5, y + 5] });
      assert.ok(inside.counts["marker-stacked"] >= 1);
      const outside = await lint({ checks: ["marker-stacked"], bbox: [x + 100, y + 100, x + 200, y + 200] });
      assert.equal(outside.counts["marker-stacked"] ?? 0, 0);
      const mk = row.e[0][1];
      const near = await lint({
        checks: ["marker-stacked"],
        near: { entity: { type: "marker", ref: mk } },
        radius: 40
      });
      assert.ok(near.counts["marker-stacked"] >= 1);
    });
  });

  describe("area filters, ignore and argument errors", () => {
    before(reload);

    test("area filter: rows without a location are counted as unlocated, never reported as clean", async () => {
      await h.ok("add", { type: "note", items: [{ id: "burg60000", name: "ghost" }] });
      const all = await lint({ checks: ["note-orphan"] });
      assert.equal(all.counts["note-orphan"], 1);
      const area = await lint({ checks: ["note-orphan"], bbox: [0, 0, all.map.w, all.map.h] });
      assert.deepEqual(area.counts, {});
      assert.deepEqual(area.clean, [], "a filtered-away row must not turn the check clean");
      assert.equal(area.unlocated?.["note-orphan"], 1);
      const circle = await lint({ checks: ["note-orphan"], near: { x: 100, y: 100 }, radius: 50 });
      assert.equal(circle.unlocated?.["note-orphan"], 1);
      await h.ok("edit", { type: "note", ops: [{ ref: "burg60000", remove: true }] });
      const gone = await lint({ checks: ["note-orphan"], bbox: [0, 0, all.map.w, all.map.h] });
      assert.deepEqual(gone.clean, ["note-orphan"]);
      assert.equal(gone.unlocated, undefined);
    });

    test("an inverted bbox is the same box", async () => {
      const a = await lint({ checks: ["marker-stacked"], bbox: [0, 0, 1280, 720] });
      const b = await lint({ checks: ["marker-stacked"], bbox: [1280, 720, 0, 0] });
      assert.deepEqual(b.counts, a.counts);
      assert.ok((a.counts["marker-stacked"] ?? 0) > 0, "the box covers the map");
    });

    test("ignore drops known findings by check, by entity or both, and counts them", async () => {
      await h.ok("add", {
        type: "note",
        items: [
          { id: "burg60000", name: "ghost one" },
          { id: "marker88888", name: "ghost two" }
        ]
      });
      const run = (ignore?: Obj[]) => lint({ checks: ["note-orphan"], ...(ignore ? { ignore } : {}) });
      assert.equal((await run()).counts["note-orphan"], 2);
      const one = await run([{ check: "note-orphan", id: "burg60000" }]);
      assert.equal(one.counts["note-orphan"], 1);
      assert.equal(one.ignored, 1);
      assert.equal((await run([{ id: "marker88888" }])).counts["note-orphan"], 1);
      assert.equal((await run([{ id: "no-such-note" }])).counts["note-orphan"], 2);
      assert.equal((await run([{ type: "burg" }])).counts["note-orphan"], 2, "no row involves a burg entity");
      const all = await run([{ check: "note-orphan" }]);
      assert.deepEqual(all.clean, ["note-orphan"]);
      assert.equal(all.ignored, 2);
      const bad = await h.call("lint", { ignore: [{}] });
      assert.equal(bad.isError, true);
      await h.ok("edit", {
        type: "note",
        ops: [
          { ref: "burg60000", remove: true },
          { ref: "marker88888", remove: true }
        ]
      });
    });

    test("bad arguments: the place error lists the accepted forms; atScale and thresholds are range-checked", async () => {
      const place = await h.call("lint", { near: { burg: "Sahawan" }, radius: 5 });
      assert.equal(place.isError, true);
      assert.match(textOf(place), /near is a Place: \{x,y\} \| \{lat,lon\} \| \{cell\}/);
      for (const bad of [{ atScale: 0 }, { atScale: 500 }, { markerGap: 0 }, { limit: -1 }, { minSeverity: "fatal" }]) {
        assert.equal((await h.call("lint", bad)).isError, true, JSON.stringify(bad));
      }
    });
  });

  describe("generated maps (no false alarms on pristine data)", () => {
    const PRISTINE = [
      "route-link",
      "route-point-cell",
      "route-end-burg",
      "marker-in-water",
      "marker-cell-link",
      "burg-in-water",
      "burg-shared-cell",
      "burg-cell-link",
      "capital-outside",
      "province-empty",
      "state-empty",
      "river-uphill",
      "river-loop",
      "river-gap",
      "note-orphan",
      "label-orphan"
    ];
    for (const [seed, template, cells] of [
      ["lintA", undefined, 4],
      ["lintB", "pangea", 3]
    ] as const) {
      test(`seed ${seed}${template ? ` (${template})` : ""}: every data check is clean, label checks measure at several zooms`, async () => {
        await h.ok("generate_map", { seed, ...(template ? { template } : {}), cells });
        const out = await lint({ limit: 5 });
        assert.ok(out.ms < 3000, `lint took ${out.ms} ms in the page`);
        for (const id of PRISTINE) assert.ok(out.clean.includes(id), `${id}: ${JSON.stringify(out.rows[id])}`);
        assert.deepEqual(out.skipped ?? [], []);
        assert.equal(out.counts.unnamed, 1, "the unnamed generated routes are one row");
        assert.ok(out.scanned.labels > 100, `labels measured: ${out.scanned.labels}`);
        assert.ok(
          out.notes?.some(n => /labels measured at zoom 1, /.test(n)),
          JSON.stringify(out.notes)
        );
        assert.ok(JSON.stringify(out).length < 20_000, "the default output is small");
      });
    }
  });

  test("the server is still healthy after all the synthetic problems", async () => {
    const s = await h.ok("session", { action: "status" });
    assert.equal(s.browser, "ready");
  });
});

describe("lint geometry (pure functions)", () => {
  // run the page script against a stub root, outside any vm context (vm global lookups are slow)
  const SRC = fs.readFileSync(path.join(MCP_ROOT, "src", "bridge-ext", "lint.js"), "utf8");
  const root: Obj = {
    __tupaia: {
      fns: {},
      fail: (c: string, m: string) => {
        throw Object.assign(new Error(m), { code: c });
      },
      internals: {},
      pure: { fold: (s: unknown) => String(s) }
    }
  };
  new Function("globalThis", SRC)(root);
  const L = root.__tupaia.lint as Obj;

  const box = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });
  const area = (b: ReturnType<typeof box>) => (b.x1 - b.x0) * (b.y1 - b.y0);

  test("overlapPairs matches an all-pairs scan and handles 20000 boxes quickly", () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const mk = (n: number, w: number, h: number) =>
      Array.from({ length: n }, () => {
        const x = rnd() * w;
        const y = rnd() * h;
        return box(x, y, x + 5 + rnd() * 40, y + 4 + rnd() * 12);
      });
    const small = mk(800, 600, 300);
    const naive = new Set<string>();
    for (let i = 0; i < small.length; i++)
      for (let j = i + 1; j < small.length; j++) {
        const ox = Math.min(small[i].x1, small[j].x1) - Math.max(small[i].x0, small[j].x0);
        const oy = Math.min(small[i].y1, small[j].y1) - Math.max(small[i].y0, small[j].y0);
        if (ox > 0 && oy > 0 && (ox * oy) / Math.min(area(small[i]), area(small[j])) >= 0.15) naive.add(`${i},${j}`);
      }
    const got = new Set<string>((L.overlapPairs(small, 0.15) as Obj[]).map(p => `${p.a},${p.b}`));
    assert.deepEqual([...got].sort(), [...naive].sort());
    assert.ok(naive.size > 20, "the random scene has overlaps to find");

    const big = mk(20000, 6000, 3000);
    // CPU time, not wall time: other processes on the machine must not fail the test
    const c0 = process.cpuUsage();
    const pairs = L.overlapPairs(big, 0.15) as Obj[];
    const cpu = process.cpuUsage(c0);
    const ms = (cpu.user + cpu.system) / 1000;
    assert.ok(ms < 1500, `20000 boxes took ${ms} ms of CPU (an all-pairs scan takes many seconds)`);
    assert.ok(pairs.length > 0);
  });

  test("overlapPairs: glyph-run parts do not claim the empty box around a curved label", () => {
    const arc = { ...box(0, 0, 200, 100), parts: [box(0, 0, 20, 10), box(90, 45, 110, 55), box(180, 90, 200, 100)] };
    const inside = box(40, 60, 70, 75); // inside the arc's bounding box, away from its letters
    assert.equal((L.overlapPairs([arc, inside], 0.01) as Obj[]).length, 0);
    const onLetter = box(95, 48, 105, 58);
    const hit = (L.overlapPairs([arc, onLetter], 0.01) as Obj[])[0];
    assert.ok(hit && hit.frac > 0.2 && hit.a === 0 && hit.b === 1);
  });

  test("overlapPairs reports the intersection and both areas", () => {
    const [pr] = L.overlapPairs([box(0, 0, 10, 10), box(5, 5, 20, 20)], 0.01) as Obj[];
    assert.equal(pr.inter, 25);
    assert.equal(pr.areaA, 100);
    assert.equal(pr.areaB, 225);
    assert.equal(pr.frac, 0.25);
  });

  test("riverRises lists every land cell standing tol above the lowest land cell before it", () => {
    const H = [50, 40, 30, 70, 35, 45, 10, 90];
    const r = L.riverRises([0, 1, 2, 3, 4, 5], H, 12) as Obj;
    assert.deepEqual(
      r.cells.map((c: Obj) => [c.cell, c.rise, c.min]),
      [
        [3, 40, 30],
        [5, 15, 30]
      ]
    );
    assert.equal(r.first, 30, "one value that clears them all: the lowest height before the first rise");
    const w = L.riverRises([0, -1, 6, 1, 7], H, 12) as Obj; // -1 and the water cell 6 are skipped
    assert.deepEqual(
      w.cells.map((c: Obj) => c.cell),
      [7]
    );
    assert.equal((L.riverRises([0, 1, 2], H, 12) as Obj).first, null);
  });

  test("closePairs and clusters", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 9, y: 0 },
      { x: 100, y: 100 },
      { x: 130, y: 100 }
    ];
    const pairs = L.closePairs(pts, 10) as Obj[];
    assert.deepEqual(pairs.map(p => [p.a, p.b]).sort(), [
      [0, 1],
      [0, 2],
      [1, 2]
    ]);
    assert.deepEqual(L.clusters(5, pairs), [[0, 1, 2]]);
    assert.equal((L.closePairs(pts, 31) as Obj[]).length, 4);
  });

  test("riverProfile ignores water and -1, riverLoop ignores consecutive repeats", () => {
    const H = [50, 40, 30, 10, 45, 25, 60];
    const prof = L.riverProfile([0, 1, 2, 3, 4, 5], H) as Obj;
    assert.equal(prof.rise, 15, "45 against the lowest land cell so far (30); 10 is water and skipped");
    assert.equal(prof.at, 4);
    assert.equal(prof.from, 2);
    assert.equal((L.riverProfile([0, 1, 2], H) as Obj).rise, 0);
    assert.equal((L.riverProfile([6, -1, 5], H) as Obj).rise, 0);
    assert.equal(L.riverLoop([1, 2, 2, 3]), null);
    assert.deepEqual(L.riverLoop([1, 2, 3, 2, 4]), { cell: 2, first: 1, again: 3 });
  });
});
