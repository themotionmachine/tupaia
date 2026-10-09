// Cross-track tests for the entity family merged on dx/fam-b: dx/routes (freehand routes, route
// groups), dx/rivers (structural river edits), dx/clear (bulk and forced removal), dx/compact
// (id-keeping stubs) and dx/apply (declarative specs). Each test covers a place where two of
// them meet. Runs against tests/fixtures/demo.map; no live origin (helpers refuse it).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { alive, DEMO_MAP, errorBody, type Harness, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

const PICK = `
const C = pack.cells;
const market = new Set((pack.markets || []).map(m => m.centerBurgId));
const centres = new Set(pack.provinces.filter(p => p && p.i && !p.removed).map(p => p.burg));
const live = pack.burgs.filter(b => b && b.i && !b.removed && C.h[b.cell] >= 20);
const count = new Map();
for (const b of live) count.set(b.name, (count.get(b.name) || 0) + 1);
const plain = live.filter(b => !b.capital && !market.has(b.i) && !centres.has(b.i) && count.get(b.name) === 1);
const A = plain[10];
const far = plain.find(b => b.feature === A.feature && b.i !== A.i && Math.hypot(A.x - b.x, A.y - b.y) > 100);
const E = plain.find(b => b.i !== A.i && b.i !== far.i && b.feature === A.feature);
const cap = live.find(b => b.capital && !market.has(b.i));
const road = pack.routes.find(r => r.group === "roads" && r.points.length > 3 && r.points[0][2] !== r.points[1][2]);
const river = pack.rivers.find(r => r && r.name && r.cells && r.cells.length > 6 && count.get(r.name) === undefined);
const row = b => ({ i: b.i, name: b.name, x: b.x, y: b.y, cell: b.cell });
return {
  A: row(A), far: row(far), E: row(E), cap: { i: cap.i, state: cap.state },
  road: { i: road.i, p0: road.points[0], p1: road.points[1] },
  river: { i: river.i, name: river.name, cells: river.cells.length }
};`;

/** Pairs whose owner differs from what Routes.buildLinks gives for pack.routes. */
const REBUILD_DIFF = `const want = Routes.buildLinks(pack.routes); const have = pack.cells.routes; let n = 0;
const keys = new Set([...Object.keys(want), ...Object.keys(have)]);
for (const a of keys) {
  const w = want[a] || {}, h = have[a] || {};
  for (const b of new Set([...Object.keys(w), ...Object.keys(h)])) if (w[b] !== h[b]) n++;
}
return n;`;

describe("fam-b: routes x rivers x clear x compact x apply on one map", () => {
  let h: Harness;
  let pick: Obj;

  const ev = async (code: string, args?: unknown): Promise<any> =>
    (await h.ok("eval", { code, args, readOnly: true })).value;
  const rebuildDiff = (): Promise<number> => ev(REBUILD_DIFF);
  const fail = async (name: string, args: Record<string, unknown>) => {
    const r = await h.call(name, args);
    assert.equal(r.isError, true, `${name} should fail: ${JSON.stringify(args).slice(0, 200)}`);
    return errorBody(r).error;
  };
  const routeIdsIn = (group: string): Promise<number[]> =>
    ev("return pack.routes.filter(r => r.group === args.g).map(r => r.i)", { g: group });

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "40" });
    await h.ok("load_map", { path: DEMO_MAP });
    await h.ok("display", { on: ["routes"] });
    pick = (await h.ok("eval", { code: PICK, readOnly: true })).value as Obj;
    assert.equal(await rebuildDiff(), 0, "the demo's links equal a rebuild");
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("apply: one spec creates a routeGroup and a freehand route in it, renames a river, edits a burg; check then reports all unchanged", async () => {
    const { A, far, river } = pick;
    const spec = {
      routeGroups: [{ id: "route-famb", name: "Fam B Lanes", stroke: "#884422", width: 0.8, dash: "2 1" }],
      routes: [
        {
          name: "Fam B Lane",
          draw: "points",
          through: [
            [A.x, A.y],
            [A.x + 40, A.y + 10],
            [far.x, far.y]
          ],
          group: "route-famb"
        }
      ],
      rivers: [{ ref: river.i, name: "Famby Water" }],
      burgs: [{ name: A.name, population: 4321 }]
    };
    const pre = await h.ok("apply", { ...spec, mode: "check" });
    assert.equal((pre.counts as Obj).error, undefined, JSON.stringify(pre.rows));
    const up = await h.ok("apply", spec);
    const counts = up.counts as Obj;
    assert.equal(counts.error, undefined, JSON.stringify(up.rows));
    assert.equal(counts.created, 2, JSON.stringify(up));
    assert.equal(counts.updated, 2, JSON.stringify(up));
    const lane = (await ev("return pack.routes.find(r => r.name === 'Fam B Lane') ?? null")) as Obj;
    assert.equal(lane.group, "route-famb");
    assert.equal(lane.lock, true, "a freehand route is locked by default");
    assert.equal(lane.points.length, 3);
    assert.equal(await ev("return pack.rivers.find(r => r.i === args.i).name", { i: river.i }), "Famby Water");
    assert.equal(await rebuildDiff(), 0, "the freehand route took its pairs as a rebuild would");

    const chk = await h.ok("apply", { ...spec, mode: "check" });
    assert.deepEqual(chk.counts, { unchanged: 4 }, JSON.stringify(chk.rows));
    const again = await h.ok("apply", spec);
    assert.deepEqual(again.counts, { unchanged: 4 }, JSON.stringify(again));
  });

  test("apply skips structural river fields (write-only actions) and says to use edit river", async () => {
    const { river } = pick;
    const before0 = await ev("return pack.rivers.find(r => r.i === args.i).cells.join(',')", { i: river.i });
    const r = await h.ok("apply", { rivers: [{ ref: river.i, name: "Famby Water", merge: true, split: { at: 0 } }] });
    assert.deepEqual(r.counts, { unchanged: 1 }, JSON.stringify(r));
    assert.match(JSON.stringify(r.notes), /river (merge, split|split, merge): write-only \(structural actions/);
    assert.equal(await ev("return pack.rivers.find(r => r.i === args.i).cells.join(',')", { i: river.i }), before0);
  });

  test("clear routes by a custom group's display name: links fall back to the last route through each pair; the group stays", async () => {
    const { road, A } = pick;
    // a freehand route over the road's first pair takes that pair (it is now the last route through it);
    // Keeper (trails) is the route after the road through the same pair, and the cleared one comes later
    await h.ok("add", { type: "routeGroup", items: [{ id: "route-famc", name: "Clear Lanes", stroke: "#225588" }] });
    const keeper = (
      (
        await h.ok("add", {
          type: "route",
          items: [{ points: [road.p0, road.p1], noPathfind: true, group: "trails", name: "Keeper" }]
        })
      ).created as Obj[]
    )[0].i;
    const add = await h.ok("add", {
      type: "route",
      items: [
        {
          points: [road.p0, road.p1, { x: A.x, y: A.y }],
          noPathfind: true,
          group: "Clear Lanes",
          name: "Over The Road"
        },
        {
          points: [
            { x: A.x, y: A.y },
            { x: A.x + 25, y: A.y - 20 }
          ],
          noPathfind: true,
          group: "route-famc",
          name: "Short Lane"
        }
      ]
    });
    const made = (add.created as Obj[]).map(c => c.i);
    const owner = () =>
      ev("return (pack.cells.routes[args.a] || {})[args.b] ?? null", { a: road.p0[2], b: road.p1[2] });
    assert.equal(await owner(), made[0], "the freehand route owns the road's pair");
    assert.equal(await rebuildDiff(), 0);
    await h.ok("add", { type: "note", items: [{ entity: { type: "route", ref: made[1] }, name: "Lane note" }] });

    const bad = await fail("clear", { types: ["routes"], where: { group: "No Such Lanes" } });
    assert.equal(bad.code, "NOT_FOUND");
    const dry = await h.ok("clear", { types: ["routes"], where: { group: "Clear Lanes" }, force: true, dryRun: true });
    assert.deepEqual((dry.plan as Obj).remove, { routes: 2 }, JSON.stringify(dry));
    assert.match(JSON.stringify((dry.plan as Obj).notes), /route groups are kept.*route-famc/);
    const c = await h.ok("clear", { types: ["routes"], where: { group: "Clear Lanes" }, force: true });
    assert.deepEqual(c.removed, { routes: 2 }, JSON.stringify(c));
    assert.deepEqual(await routeIdsIn("route-famc"), []);
    // clear's sweep re-adds the freed pair: the LAST remaining route through it (Keeper), not the first (the road)
    assert.equal(await owner(), keeper, "the last remaining route through the pair owns it");
    assert.equal(await rebuildDiff(), 0, "after clear the links equal a rebuild");
    assert.equal(await ev("return notes.some(n => n.id === args.id)", { id: `route${made[1]}` }), false);
    assert.ok(await ev("return !!document.getElementById('route-famc')"), "clear keeps the (now empty) route group");
    const f = await h.ok("find", { type: "routeGroup", where: { name: "Clear Lanes" } });
    assert.equal(f.total ?? (f.rows as Obj[]).length, 1, JSON.stringify(f));
  });

  test("clear burgs with orphanRoutes removes a locked freehand route in a custom group only with force; links stay a rebuild", async () => {
    const { far, E } = pick;
    const add = await h.ok("add", {
      type: "route",
      items: [
        {
          points: [
            { entity: { type: "burg", ref: E.i } },
            { x: E.x + 30, y: E.y + 15 },
            { entity: { type: "burg", ref: far.i } }
          ],
          noPathfind: true,
          group: "route-famb",
          name: "Orphan Lane"
        }
      ]
    });
    const lane = (add.created as Obj[])[0].i;
    const ends = { burgs: { i: [E.i, far.i] } };
    const soft = await h.ok("clear", {
      types: ["burgs"],
      where: ends.burgs,
      orphanRoutes: true,
      dryRun: true,
      detail: true
    });
    // the freehand lane is locked (by default), so without force it is kept, not an orphan to remove
    const keptRoutes = ((soft.plan as Obj).kept?.routes ?? []) as Obj[];
    assert.deepEqual(
      keptRoutes.filter(r => r.i === lane).map(r => r.why),
      ["locked"],
      JSON.stringify(soft.plan).slice(0, 600)
    );
    const c = await h.ok("clear", { types: ["burgs"], where: ends.burgs, orphanRoutes: true, force: true });
    const removed = c.removed as Obj;
    assert.equal(removed.burgs, 2, JSON.stringify(c));
    assert.ok((c.cascade as Obj)?.orphanRoutes >= 1, JSON.stringify(c.cascade));
    assert.equal(removed.routes, (c.cascade as Obj).orphanRoutes, "the orphan routes are the routes removed");
    assert.equal(
      await ev("return pack.routes.some(r => r.i === args.i)", { i: lane }),
      false,
      "the lane served only removed burgs"
    );
    assert.equal(await rebuildDiff(), 0);
    assert.ok(await ev("return !!document.getElementById('route-famb')"), "its group stays");
  });

  test("removal options: burg force (clear) and routeGroup force/moveTo (routes) pass the one op guard; edit-level force covers both", async () => {
    const { cap } = pick;
    const mv = await fail("edit", { type: "burg", ops: [{ ref: cap.i, remove: true, moveTo: "roads" }] });
    assert.equal(mv.code, "BAD_ARGS");
    assert.match(mv.message, /moveTo applies only to removing a routeGroup/);
    const st = await fail("edit", { type: "state", ops: [{ ref: cap.state, remove: true, force: true }] });
    assert.match(st.message, /force applies only to removing a burg or a routeGroup/);
    const refused = await fail("edit", { type: "burg", ops: [{ ref: cap.i, remove: true }] });
    assert.equal(refused.code, "REFUSED");
    const rm = await h.ok("edit", { type: "burg", force: true, ops: [{ ref: cap.i, remove: true }] });
    const row = (rm.applied as Obj[])[0];
    assert.equal(row.removed, true);
    assert.equal(row.capital?.state, cap.state, JSON.stringify(row));

    // a group with a route: refused without force; edit-level force moves its routes
    await h.ok("add", {
      type: "route",
      items: [
        {
          points: [
            { x: pick.A.x, y: pick.A.y },
            { x: pick.A.x + 20, y: pick.A.y + 30 }
          ],
          noPathfind: true,
          group: "route-famc",
          name: "Mover"
        }
      ]
    });
    const no = await fail("edit", { type: "routeGroup", ops: [{ ref: "route-famc", remove: true }] });
    assert.equal(no.code, "REFUSED");
    const g = await h.ok("edit", {
      type: "routeGroup",
      force: true,
      ops: [{ ref: "route-famc", remove: true, moveTo: "trails" }]
    });
    assert.equal((g.applied as Obj[])[0].moveTo, "trails", JSON.stringify(g));
    assert.equal(await ev("return pack.routes.find(r => r.name === 'Mover').group"), "trails");
    assert.equal(await ev("return !!document.getElementById('route-famc')"), false);
    assert.equal(await rebuildDiff(), 0);
  });

  test("compact after clear: removed burgs become stubs, custom route groups and their <g> stay, nothing live changes", async () => {
    const groupsBefore = await ev("return [...document.querySelectorAll('#routes > g')].map(g => g.id)");
    assert.ok(groupsBefore.includes("route-famb"));
    const r = await h.ok("compact", { types: ["burg"] });
    assert.ok(((r.compacted as Obj)?.burg ?? 0) >= 3, JSON.stringify(r));
    const stubs = await ev("return [args.E, args.far, args.cap].map(i => pack.burgs[i])", {
      E: pick.E.i,
      far: pick.far.i,
      cap: pick.cap.i
    });
    for (const s of stubs) assert.equal(s.removed, true, JSON.stringify(s));
    assert.ok(
      stubs.some((s: Obj) => s.name === undefined),
      JSON.stringify(stubs)
    );
    assert.deepEqual(await ev("return [...document.querySelectorAll('#routes > g')].map(g => g.id)"), groupsBefore);
    assert.deepEqual(await routeIdsIn("route-famb"), [
      (await ev("return pack.routes.find(r => r.name === 'Fam B Lane').i")) as number
    ]);
    // a compacted burg answers REMOVED, and apply's spec still converges
    const gone = await fail("inspect", { entity: { type: "burg", ref: pick.E.i } });
    assert.equal(gone.code, "REMOVED");
    assert.equal(await rebuildDiff(), 0);
  });
});

describe("fam-b: a sketch with a river split, a literal clear of the created river and a compact replays onto a shifted base", () => {
  let h: Harness;

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("clear's literal ids follow the id map of the river the sketch created; compact replays", async () => {
    await h.ok("load_map", { path: DEMO_MAP });
    const maxId = (await h.ok("eval", { readOnly: true, code: "return Math.max(...pack.rivers.map(r => r.i))" }))
      .value as number;
    // someone else's copy: a split first takes the next river id
    await h.ok("edit", { type: "river", ops: [{ ref: 846, set: { split: { at: 6025, name: "Theirs" } } }] });
    const shifted = (await h.ok("save_map", { path: "famb-rivers-shifted.map", overwrite: true })).path as string;
    await h.ok("load_map", { path: DEMO_MAP });
    const burg = (
      await h.ok("eval", {
        readOnly: true,
        code: `const market = new Set((pack.markets || []).map(m => m.centerBurgId));
const centres = new Set(pack.provinces.filter(p => p && p.i && !p.removed).map(p => p.burg));
return pack.burgs.find(b => b && b.i > 20 && !b.removed && !b.capital && !market.has(b.i) && !centres.has(b.i)).i;`
      })
    ).value as number;

    await h.ok("sketch", { action: "start", slug: "t-famb" });
    const s = await h.ok("edit", {
      type: "river",
      ops: [{ ref: 4, set: { split: { at: 5935, name: "Famb Upper" } } }]
    });
    const made = ((s.applied as Obj[])[0].created as Obj[])[0].i as number;
    assert.equal(made, maxId + 1);
    const c = await h.ok("clear", {
      types: ["rivers", "burgs"],
      where: { rivers: { i: [made] }, burgs: { i: [burg] } }
    });
    assert.deepEqual(c.removed, { rivers: 1, burgs: 1 }, JSON.stringify(c));
    const k = await h.ok("compact", { types: ["burg"] });
    assert.equal((k.compacted as Obj)?.burg, 1, JSON.stringify(k));
    const full = await h.ok("sketch", { action: "status", full: true });
    const recs = full.records as Obj[];
    assert.deepEqual(
      recs.map(r => r.tool),
      ["edit", "clear", "compact"]
    );
    assert.deepEqual(recs[1].resolved.removed.river, [made]);

    const rb = await h.ok("sketch", { action: "rebase", onto: { path: shifted } }, 240_000);
    assert.equal(rb.completed, true, JSON.stringify(rb.conflicts));
    assert.deepEqual(rb.applied, [1, 2, 3]);
    assert.equal((rb.idMap as Obj).river[String(made)], maxId + 2, JSON.stringify(rb.idMap));
    const v = (
      await h.ok("eval", {
        readOnly: true,
        args: { theirs: maxId + 1, mine: maxId + 2, burg },
        code: `const R = i => pack.rivers.find(r => r.i === i);
return { theirs: R(args.theirs)?.name ?? null, mine: !!R(args.mine), burg: pack.burgs[args.burg] };`
      })
    ).value as Obj;
    assert.equal(v.theirs, "Theirs", "their river (which holds the sketch's recorded id) is untouched");
    assert.equal(v.mine, false, "the clear removed the replayed split's river, by the mapped id");
    assert.deepEqual(v.burg, { i: burg, removed: true }, "compact replayed: the cleared burg is a stub");
  });
});
