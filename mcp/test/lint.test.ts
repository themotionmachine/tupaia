// lint: the read-only map quality check. Browser tests on tests/fixtures/demo.map: a clean-ish
// baseline, then one synthetic problem per check (made with edit/add/eval, found by lint, and
// repaired with the fix call lint suggests), filters and options, and the read-only guarantees.
// Pure geometry (bucket-grid overlap and stacking, river profile) runs in node:vm.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { LINT_CHECKS } from "../src/tools/lint.ts";
import { alive, errorBody, type Harness, MCP_ROOT, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

interface Row {
  sev: string;
  e: Array<[string, number | string, string | null]>;
  at?: [number, number];
  msg: string;
  fix?: { tool: string; args: Obj };
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
  });

  test("baseline: demo.map has no errors, label checks say why they were skipped, and it is fast", async () => {
    const t0 = Date.now();
    const out = await lint();
    const ms = Date.now() - t0;
    assert.ok(ms < 3000, `lint took ${ms} ms`);
    assert.equal(out.totals.error, 0, JSON.stringify(out.rows));
    assert.equal(out.map.cells, 7462);
    // the fixture was saved without label elements: label checks cannot measure and say so
    const skipped = (out.skipped ?? []).map(s => s.check);
    assert.deepEqual(skipped.sort(), ["label-offcanvas", "label-overlap"]);
    assert.match((out.skipped ?? [])[0].reason, /no label elements/);
    // 578 unnamed routes dominate the counts but are info and broken down by type
    assert.equal(out.kinds?.unnamed?.route, 578);
    assert.equal(out.counts.unnamed, 578);
    for (const id of [
      "burg-in-water",
      "burg-shared-cell",
      "capital-outside",
      "river-loop",
      "route-link",
      "note-orphan"
    ])
      assert.ok(out.clean.includes(id), `${id} is clean on the fixture`);
    assert.ok(out.scanned.burgs === 753 && out.scanned.rivers === 370 && out.scanned.routes === 578);
    // compact: counts first, rows capped per check
    for (const rows of Object.values(out.rows)) assert.ok(rows.length <= 20);
    assert.ok(JSON.stringify(out).length < 40_000, "default output stays small");
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
        return { i: b.i, name: b.name, x: b.x, y: b.y };`);
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
      await apply(rows[0].fix);
      await clean("burg-in-water");
      const now = await evalv("return pack.cells.h[pack.burgs[args].cell]", b.i);
      assert.ok(now >= 20);
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
      await apply(rows[0].fix);
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
      const se = await found("state-empty", 1);
      assert.ok(hasEntity(se.rows[0], "state", p.st));
      await apply(pe.rows[0].fix);
      await clean("province-empty");
      const removed = await evalv("return pack.provinces[args].removed === true", p.prov);
      assert.equal(removed, true);
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
      await apply(loop.rows[0].fix);
      await clean("river-loop");
      const left = await evalv("return pack.rivers.some(r => r.i === args)", p.a);
      assert.equal(left, false);
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
      await apply(out.fixAll?.["route-link"]);
      await clean("route-link");
    });

    test("route-point-cell: a point dragged away from its cell; the fix snaps it back", async () => {
      const p = await evalv(`
        const r = pack.routes.find(r => r.points.length > 4 && r.i > 20);
        r.points[2][0] += 90;
        return { r: r.i };`);
      const { rows } = await found("route-point-cell", 1);
      assert.ok(hasEntity(rows[0], "route", p.r));
      assert.match(rows[0].msg, /1 point\(s\)/);
      await apply(rows[0].fix);
      await clean("route-point-cell");
      await clean("route-link");
    });

    test("route-end-burg: a route left ending where its burg was removed; the fix removes the route", async () => {
      const p = await evalv(`
        const C = pack.cells;
        const market = b => (pack.markets || []).some(m => m.centerBurgId === b.i);
        for (const r of pack.routes) {
          const p0 = r.points[0];
          const b = pack.burgs[C.burg[p0[2]]];
          if (b && b.i && !b.capital && !market(b)) return { r: r.i, b: b.i, name: b.name };
        }
        return null;`);
      assert.ok(p, "a route that starts at a plain burg exists");
      await h.ok("edit", { type: "burg", ops: [{ ref: p.b, remove: true }] });
      const out = await lint({ checks: ["route-end-burg"], limit: 50 });
      const rows = rowsOf(out, "route-end-burg");
      const mine = rows.find(r => hasEntity(r, "route", p.r));
      assert.ok(mine && hasEntity(mine, "burg", p.b), JSON.stringify(rows));
      assert.match(mine.msg, new RegExp(p.name));
      assert.equal(mine.fix?.tool, "edit");
      // a burg with several roads leaves several dangling ends; removing them all clears the check
      for (const r of rows) await apply(r.fix);
      await clean("route-end-burg");
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

    test("label-orphan: labels of a removed burg and a removed state; the fixes remove the elements", async () => {
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
      const capped = await lint({ limit: 20, maxRows: 5 });
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
    const t0 = Date.now();
    const pairs = L.overlapPairs(big, 0.15) as Obj[];
    const ms = Date.now() - t0;
    assert.ok(ms < 1000, `20000 boxes took ${ms} ms`);
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
