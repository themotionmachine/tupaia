// Removal and bulk clear (track 'clear') against tests/fixtures/demo.map: province, culture and
// religion removal through edit, forced removal of capitals and market centres, route-link
// integrity, the clear tool (plan, where, keep, locks, full wipe, save/load, undo), and the
// sketch log: literal ids replayed onto other copies (rebase {onto:{path}} test hook).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { alive, errorBody, type Harness, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

const PICK_CODE = `
const C = pack.cells;
const live = b => b && b.i && !b.removed;
const burgs = pack.burgs.filter(live);
const isMarket = b => (pack.markets || []).some(m => m.centerBurgId === b.i);
const heads = b => pack.provinces.some(p => p && p.i && !p.removed && p.burg === b.i);
const byState = new Map();
for (const b of burgs) { if (!byState.has(b.state)) byState.set(b.state, []); byState.get(b.state).push(b); }
const states = pack.states.filter(s => s.i && !s.removed);
const S = states.find(s => (byState.get(s.i) || []).length >= 6 && !isMarket(pack.burgs[s.capital]));
const capital = pack.burgs[S.capital];
const others = byState.get(S.i).filter(b => b.i !== capital.i);
const successor = others.slice().sort((a, b) => b.population - a.population || a.i - b.i)[0];
const alt = others.find(b => b.i !== successor.i);
const foreign = burgs.find(b => b.state && b.state !== S.i);
const mk = burgs.find(b => isMarket(b) && !b.capital && !heads(b));
const market = pack.markets.find(m => m.centerBurgId === mk.i);
const served = burgs.filter(b => b.market === market.i && b.i !== mk.i).length;
const marketDeals = pack.deals.filter(d => (d.sellerType === "market" && d.seller === market.i) || (d.buyerType === "market" && d.buyer === market.i)).length;
// a burg heading a province with other burgs; the editor's successor is the first burg in cell order
let PB = null, PBnext = null;
for (const p of pack.provinces) {
  if (!p || !p.i || p.removed || !p.burg) continue;
  const b = pack.burgs[p.burg];
  if (!live(b) || b.capital || isMarket(b)) continue;
  let first = null;
  for (let c = 0; c < C.province.length; c++) if (C.province[c] === p.i && C.burg[c] && C.burg[c] !== b.i) { first = C.burg[c]; break; }
  if (first) { PB = { i: b.i, province: p.i }; PBnext = first; break; }
}
// a burg whose routes serve only it (orphans once it goes)
let T = null, Troutes = [];
for (const b of burgs) {
  if (b.capital || isMarket(b) || heads(b) || b.state === S.i) continue;
  const rs = pack.routes.filter(r => r.points.some(p => p[2] === b.cell) && !r.points.some(p => C.burg[p[2]] && C.burg[p[2]] !== b.i));
  if (rs.length) { T = b.i; Troutes = rs.map(r => r.i); break; }
}
const province = pack.provinces.find(p => p && p.i && !p.removed && p.state && C.province.some(x => x === p.i));
const cultureCount = id => burgs.filter(b => b.culture === id).length;
const culture = pack.cultures.filter(c => c.i && !c.removed && states.some(s => s.culture === c.i)).sort((a, b) => cultureCount(b.i) - cultureCount(a.i))[0];
const relCells = id => C.religion.filter(x => x === id).length;
const religion = pack.religions.filter(r => r.i && !r.removed).sort((a, b) => relCells(b.i) - relCells(a.i))[0];
const S2 = states.find(s => s.i !== S.i && s.i !== foreign.state && (byState.get(s.i) || []).length >= 3);
const freeIn = s => [...C.i].find(c => C.state[c] === s && C.h[c] >= 20 && !C.burg[c] && C.c[c].every(k => !C.burg[k]));
const lastMarker = pack.markers[pack.markers.length - 1];
return {
  S: { i: S.i, name: S.name, burgs: byState.get(S.i).length },
  capital: { i: capital.i, name: capital.name }, successor: { i: successor.i, name: successor.name },
  alt: { i: alt.i, name: alt.name }, foreign: { i: foreign.i, state: foreign.state },
  mk: { i: mk.i, market: market.i, served, marketDeals },
  PB, PBnext, T, Troutes,
  province: { i: province.i, state: province.state, name: province.name },
  culture: { i: culture.i, name: culture.name }, religion: { i: religion.i, name: religion.name },
  S2: { i: S2.i, name: S2.name, burgs: byState.get(S2.i).length, free: freeIn(S2.i) },
  lastMarker: { i: lastMarker.i, cell: lastMarker.cell },
  farCell: [...C.i].reverse().find(c => C.h[c] >= 20 && !C.burg[c] && C.state[c] !== S2.i && C.c[c].every(k => !C.burg[k]))
};`;

// every link names a live route on which the two cells are consecutive, and every consecutive
// pair has a link
const LINK_CHECK = `
const L = pack.cells.routes; const pairs = new Map();
for (const r of pack.routes) { const s = new Set(); const p = r.points; for (let k = 0; k < p.length - 1; k++) if (p[k][2] !== p[k + 1][2]) { s.add(p[k][2] + "," + p[k + 1][2]); s.add(p[k + 1][2] + "," + p[k][2]); } pairs.set(r.i, s); }
let bad = 0, missing = 0, empty = 0;
for (const f of Object.keys(L)) { const m = L[f]; if (!Object.keys(m).length) empty++; for (const t of Object.keys(m)) if (!pairs.get(m[t])?.has(f + "," + t)) bad++; }
for (const r of pack.routes) { const p = r.points; for (let k = 0; k < p.length - 1; k++) { const a = p[k][2], b = p[k + 1][2]; if (a !== b && L[a]?.[b] === undefined) missing++; } }
return { bad, missing, empty };`;

const COUNTS = `({
  burgs: pack.burgs.filter(b => b && b.i && !b.removed).length,
  states: pack.states.filter(s => s.i && !s.removed).length,
  provinces: pack.provinces.filter(p => p && p.i && !p.removed).length,
  cultures: pack.cultures.filter(c => c.i && !c.removed).length,
  religions: pack.religions.filter(c => c.i && !c.removed).length,
  routes: pack.routes.length, markers: pack.markers.length, zones: pack.zones.length,
  rivers: pack.rivers.length, notes: notes.length, markets: pack.markets.length
})`;

describe("tupaia-mcp clear and removal", () => {
  let h: Harness;
  let pick: Obj;
  const ev = async (code: string, args?: unknown) => (await h.ok("eval", { code, readOnly: true, args })).value as any;
  const undoDepth = async () => ((await h.ok("snapshot", { action: "list" })).undo as unknown[]).length;

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "40" });
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    pick = await ev(PICK_CODE);
    assert.ok(pick.PB && pick.T && pick.S2.free !== undefined, JSON.stringify(pick));
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("province, culture and religion removal through edit run the editors' cascades; ids 0 are refused", async () => {
    const plan = await h.ok("edit", { type: "province", ops: [{ ref: pick.province.i, remove: true }], dryRun: true });
    assert.ok((plan.plan as Obj[])[0].cells > 0);
    const p = await h.ok("edit", { type: "province", ops: [{ ref: pick.province.i, remove: true }] });
    assert.equal((p.applied as Obj[])[0].removed, true);
    const pv = await ev(
      `({ tomb: pack.provinces[args.i], cells: pack.cells.province.filter(x => x === args.i).length,
          listed: (pack.states[args.state].provinces || []).includes(args.i) })`,
      pick.province
    );
    assert.deepEqual(pv, { tomb: { i: pick.province.i, removed: true }, cells: 0, listed: false });

    const cu = await h.ok("edit", { type: "culture", ops: [{ ref: pick.culture.name, remove: true }], dryRun: true });
    assert.ok((cu.plan as Obj[])[0].burgs > 0 && (cu.plan as Obj[])[0].states > 0, JSON.stringify(cu.plan));
    await h.ok("edit", { type: "culture", ops: [{ ref: pick.culture.i, remove: true }] });
    const cv = await ev(
      `({ removed: pack.cultures[args.i].removed, burgs: pack.burgs.filter(b => b && b.culture === args.i).length,
          states: pack.states.filter(s => s.culture === args.i).length, cells: pack.cells.culture.filter(x => x === args.i).length,
          origins: pack.cultures.filter(c => c.i && !c.removed && (c.origins || []).includes(args.i)).length })`,
      pick.culture
    );
    assert.deepEqual(cv, { removed: true, burgs: 0, states: 0, cells: 0, origins: 0 });

    await h.ok("edit", { type: "religion", ops: [{ ref: pick.religion.i, remove: true }] });
    const rv = await ev(
      `({ removed: pack.religions[args.i].removed, cells: pack.cells.religion.filter(x => x === args.i).length })`,
      pick.religion
    );
    assert.deepEqual(rv, { removed: true, cells: 0 });

    for (const type of ["culture", "religion"]) {
      const r = await h.call("edit", { type, ops: [{ ref: 0, remove: true }] });
      assert.equal(errorBody(r).error.code, "REFUSED", `${type} 0`);
    }
    const bad = await h.call("edit", { type: "province", ops: [{ ref: 2, remove: true, force: true }] });
    assert.equal(errorBody(bad).error.code, "BAD_ARGS");
    // the three removals undo one by one
    for (let k = 0; k < 3; k++) await h.ok("snapshot", { action: "undo" });
    assert.equal(
      await ev(`!!pack.provinces[${pick.province.i}].removed || !!pack.cultures[${pick.culture.i}].removed`),
      false
    );
  });

  test("a capital is refused without force; force moves the capital to the most populous other burg or newCapital", async () => {
    const r = await h.call("edit", { type: "burg", ops: [{ ref: pick.capital.i, remove: true }] });
    assert.equal(errorBody(r).error.code, "REFUSED");
    assert.match(errorBody(r).error.message, /force:true/);
    const wrong = await h.call("edit", {
      type: "burg",
      ops: [{ ref: pick.capital.i, remove: true, force: true, newCapital: pick.foreign.i }]
    });
    assert.equal(errorBody(wrong).error.code, "REFUSED");
    assert.match(errorBody(wrong).error.message, /is not in/);

    const dry = await h.ok("edit", {
      type: "burg",
      ops: [{ ref: pick.capital.i, remove: true, force: true }],
      dryRun: true
    });
    assert.equal((dry.plan as Obj[])[0].newCapital.i, pick.successor.i);
    const done = await h.ok("edit", { type: "burg", ops: [{ ref: pick.capital.i, remove: true, force: true }] });
    assert.deepEqual((done.applied as Obj[])[0].capital, {
      state: pick.S.i,
      to: pick.successor.i,
      name: pick.successor.name
    });
    const sv = await ev(
      `const s = pack.states[args.S.i]; const n = pack.burgs[args.successor.i];
       return { capital: s.capital, center: s.center === n.cell, flag: n.capital, gone: pack.burgs[args.capital.i].removed,
         capitals: pack.burgs.filter(b => b && b.i && !b.removed && b.state === s.i && b.capital).length };`,
      pick
    );
    assert.deepEqual(sv, { capital: pick.successor.i, center: true, flag: 1, gone: true, capitals: 1 });
    await h.ok("snapshot", { action: "undo" });

    await h.ok("edit", {
      type: "burg",
      ops: [{ ref: pick.capital.i, remove: true, force: true, newCapital: pick.alt.name }]
    });
    assert.equal(await ev(`pack.states[${pick.S.i}].capital`), pick.alt.i);
    await h.ok("snapshot", { action: "undo" });
  });

  test("a forced market-centre removal removes its market, hands its burgs to other markets and drops its deals", async () => {
    const r = await h.call("edit", { type: "burg", ops: [{ ref: pick.mk.i, remove: true }] });
    assert.match(errorBody(r).error.message, /market centre/);
    const done = await h.ok("edit", { type: "burg", ops: [{ ref: pick.mk.i, remove: true, force: true }] });
    const row = (done.applied as Obj[])[0];
    assert.deepEqual(row.marketsRemoved, [pick.mk.market]);
    const v = await ev(
      `({ market: pack.markets.some(m => m.i === args.market), centre: pack.markets.some(m => m.centerBurgId === args.i),
          stale: pack.burgs.filter(b => b && b.i && !b.removed && b.market === args.market).length,
          cells: pack.cells.market.filter(x => x === args.market).length,
          deals: pack.deals.filter(d => (d.sellerType === "market" && d.seller === args.market) || (d.buyerType === "market" && d.buyer === args.market) || (d.sellerType === "burg" && d.seller === args.i) || (d.buyerType === "burg" && d.buyer === args.i)).length })`,
      pick.mk
    );
    assert.deepEqual(v, { market: false, centre: false, stale: 0, cells: 0, deals: 0 });
    if (pick.mk.served) assert.ok(row.burgsToOtherMarkets > 0, JSON.stringify(row));
    await h.ok("snapshot", { action: "undo" });
  });

  test("a province capital passes to the province's first other burg", async () => {
    const done = await h.ok("edit", { type: "burg", ops: [{ ref: pick.PB.i, remove: true }] });
    assert.deepEqual((done.applied as Obj[])[0].provinceCapitals, [{ province: pick.PB.province, to: pick.PBnext }]);
    assert.equal(await ev(`pack.provinces[${pick.PB.province}].burg`), pick.PBnext);
    await h.ok("snapshot", { action: "undo" });
  });

  test("orphanRoutes removes the routes that served only the removed burg; stale route links get repaired", async () => {
    assert.deepEqual(await ev(LINK_CHECK), { bad: 0, missing: 0, empty: 0 });
    const keep = await h.ok("edit", { type: "burg", ops: [{ ref: pick.T, remove: true }] });
    assert.match(JSON.stringify(keep.notes), /orphanRoutes:true/);
    assert.equal(await ev(`args.every(i => pack.routes.some(r => r.i === i))`, pick.Troutes), true);
    await h.ok("snapshot", { action: "undo" });

    const done = await h.ok("edit", { type: "burg", ops: [{ ref: pick.T, remove: true, orphanRoutes: true }] });
    assert.deepEqual([...(done.applied as Obj[])[0].routesRemoved].sort(), [...pick.Troutes].sort());
    assert.equal(await ev(`args.some(i => pack.routes.some(r => r.i === i))`, pick.Troutes), false);
    assert.deepEqual(await ev(LINK_CHECK), { bad: 0, missing: 0, empty: 0 });

    // a route dropped by hand (as an eval script would) leaves stale links; the next route removal repairs them
    const victim = await h.ok("eval", {
      code: "const r = pack.routes[3]; pack.routes = pack.routes.filter(x => x !== r); return r.i;"
    });
    const broken = await ev(LINK_CHECK);
    assert.ok(broken.bad > 0, JSON.stringify(broken));
    const other = await ev(`pack.routes[0].i`);
    const rm = await h.ok("edit", { type: "route", ops: [{ ref: other, remove: true }] });
    assert.ok((rm.applied as Obj[])[0].routeLinksFixed.removed >= broken.bad, JSON.stringify(rm.applied));
    assert.deepEqual(await ev(LINK_CHECK), { bad: 0, missing: 0, empty: 0 });
    assert.equal(
      await ev(`Object.values(pack.cells.routes).some(m => Object.values(m).includes(${victim.value}))`),
      false
    );
    for (let k = 0; k < 3; k++) await h.ok("snapshot", { action: "undo" });
  });

  test("clear: plan, where per type, keep, locks, a kept province keeps its state, refusals", async () => {
    const dry = await h.ok("clear", { types: ["burgs"], where: { state: pick.S.name }, dryRun: true });
    assert.equal((dry.plan as Obj).remove.burgs, pick.S.burgs);
    assert.equal((dry.plan as Obj).cascade.capitalsMoved, 1);

    const mixed = await h.call("clear", { types: ["burgs", "routes"], where: { state: pick.S.i } });
    assert.equal(errorBody(mixed).error.code, "BAD_ARGS");
    const missing = await h.call("clear", { types: ["burgs"], keep: [{ type: "burg", ref: "No Such Burg" }] });
    assert.equal(errorBody(missing).error.code, "NOT_FOUND");

    const depth = await undoDepth();
    const none = await h.ok("clear", { types: ["zones"], where: { name: "No such zone" } });
    assert.deepEqual(none.removed, {});
    assert.match(String(none.note), /nothing was changed/);
    assert.equal(await undoDepth(), depth, "nothing matched: no undo entry");

    const held = await h.ok("clear", {
      types: ["states"],
      keep: [{ type: "province", ref: pick.province.i }],
      dryRun: true
    });
    const keptStates = (held.plan as Obj).kept.states;
    assert.equal(keptStates.count, 1);
    assert.equal(keptStates.items[0].i, pick.province.state);
    assert.match(keptStates.items[0].why, /holds kept province/);

    await h.ok("edit", { type: "burg", ops: [{ ref: pick.alt.i, set: { lock: true } }] });
    const r = await h.ok("clear", {
      types: ["burgs"],
      where: { burgs: { state: pick.S.i } },
      keep: [{ type: "burg", ref: pick.successor.i }]
    });
    assert.equal((r.removed as Obj).burgs, pick.S.burgs - 2);
    const kept = (r.kept as Obj).burgs;
    assert.deepEqual(
      kept.items.map((k: Obj) => [k.i, k.why]).sort(),
      [
        [pick.alt.i, "locked"],
        [pick.successor.i, "keep"]
      ].sort()
    );
    // the capital went; the most populous remaining burg (the kept successor) took over
    assert.equal(await ev(`pack.states[${pick.S.i}].capital`), pick.successor.i);
    assert.deepEqual((r.cascade as Obj).capitalsMoved, [
      { state: pick.S.i, to: pick.successor.i, name: pick.successor.name }
    ]);
    assert.ok(r.changes && typeof (r.changes as Obj).burg.removed === "number", "changes are counts only");
    await h.ok("snapshot", { action: "undo" });

    const forced = await h.ok("clear", { types: ["burgs"], where: { state: pick.S.i }, force: true, detail: true });
    assert.equal((forced.removed as Obj).burgs, pick.S.burgs);
    assert.ok(((forced.ids as Obj).burgs as number[]).includes(pick.alt.i));
    assert.equal(await ev(`pack.states[${pick.S.i}].capital`), 0, "no burg left: no capital");
    await h.ok("snapshot", { action: "undo" });
    await h.ok("snapshot", { action: "undo" }); // the lock
  });

  test("clear everything: one undo entry, no stale references, a clean save/load round trip, undo restores", async () => {
    const before = await ev(COUNTS);
    const depth = await undoDepth();
    const r = await h.ok(
      "clear",
      {
        types: [
          "burgs",
          "states",
          "provinces",
          "cultures",
          "religions",
          "routes",
          "markers",
          "zones",
          "labels",
          "notes",
          "rivers",
          "emblems"
        ]
      },
      300_000
    );
    assert.equal(await undoDepth(), depth + 1);
    const removed = r.removed as Obj;
    for (const k of [
      "burgs",
      "states",
      "provinces",
      "cultures",
      "religions",
      "routes",
      "markers",
      "zones",
      "rivers",
      "notes"
    ])
      assert.equal(removed[k], before[k], `${k}: ${JSON.stringify(removed)}`);
    const after1 = await ev(COUNTS);
    assert.deepEqual(after1, {
      burgs: 0,
      states: 0,
      provinces: 0,
      cultures: 0,
      religions: 0,
      routes: 0,
      markers: 0,
      zones: 0,
      rivers: 0,
      notes: 0,
      markets: 0
    });
    const cells = await ev(
      `({ state: [...new Set(pack.cells.state)], province: [...new Set(pack.cells.province)], culture: [...new Set(pack.cells.culture)],
          religion: [...new Set(pack.cells.religion)], burg: [...new Set(pack.cells.burg)], r: [...new Set(pack.cells.r)],
          links: Object.keys(pack.cells.routes).length, deals: pack.deals.length,
          neutrals: pack.states[0].removed ?? false, wild: pack.cultures[0].removed ?? false })`
    );
    assert.deepEqual(cells, {
      state: [0],
      province: [0],
      culture: [0],
      religion: [0],
      burg: [0],
      r: [0],
      links: 0,
      deals: 0,
      neutrals: false,
      wild: false
    });
    const saved = await h.ok("save_map", { path: "cleared.map", overwrite: true });
    const loaded = await h.ok("load_map", { path: saved.path as string });
    assert.doesNotMatch(JSON.stringify(loaded.consoleErrors ?? []), /Data integrity/);
    assert.equal((loaded.counts as Obj).burgs, 0);
    // a burg added to the wiped map works (its auto trail finds no network, which is fine)
    const add = await h.ok("add", { type: "burg", items: [{ at: { cell: pick.farCell } }] });
    assert.equal((add.created as Obj[]).length, 1);
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
  });

  test("undo of a full clear restores every entity", async () => {
    await h.ok("clear", { types: ["burgs", "states", "routes", "markers"] }, 300_000);
    await h.ok("snapshot", { action: "undo" });
    const now = await ev(COUNTS);
    assert.equal(now.burgs, 753);
    assert.equal(now.states, 20);
    assert.deepEqual(await ev(LINK_CHECK), { bad: 0, missing: 0, empty: 0 });
  });

  describe("sketch log and replay", () => {
    const files = { ok: "", burgGone: "", markerReused: "" };
    let sketchBurg = 0;

    async function otherCopy(name: string, code: string): Promise<string> {
      await h.ok("load_map", { path: "tests/fixtures/demo.map" });
      await h.ok("eval", { code, args: pick });
      return (await h.ok("save_map", { path: `${name}.map`, overwrite: true })).path as string;
    }

    before(async () => {
      // someone else adds a burg far away (it takes the id the sketch's burg gets, and its trail)
      files.ok = await otherCopy(
        "clear-other-ok",
        `const c = args.farCell; const id = Burgs.add([pack.cells.p[c][0], pack.cells.p[c][1]]); pack.burgs[id].name = "Theirford"; return id;`
      );
      const victim = await (async () => {
        await h.ok("load_map", { path: "tests/fixtures/demo.map" });
        return ev(`pack.burgs.find(b => b && b.i && !b.removed && b.state === ${pick.S2.i} && !b.capital).i`);
      })();
      files.burgGone = await otherCopy("clear-other-burg", `Burgs.remove(${victim}); return ${victim};`);
      files.markerReused = await otherCopy(
        "clear-other-marker",
        `const m = pack.markers.find(x => x.i === args.lastMarker.i); Markers.deleteMarker(m.i);
         const c = pack.cells.i.find(x => pack.cells.h[x] >= 20 && x !== m.cell && !pack.markers.some(k => k.cell === x));
         pack.markers.push({ i: m.i, x: pack.cells.p[c][0], y: pack.cells.p[c][1], cell: c, type: "other", icon: "x" });
         return m.i;`
      );
      await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    });

    test("forced removal and clears are logged with literal ids, and replay onto another copy", async () => {
      await h.ok("sketch", { action: "start", slug: "t-clear", note: "Clear test" });
      await h.ok("edit", {
        type: "burg",
        ops: [{ ref: pick.capital.i, remove: true, force: true, newCapital: pick.alt.i }]
      });
      const add = await h.ok("add", { type: "burg", items: [{ at: { cell: pick.S2.free } }] });
      sketchBurg = (add.created as Obj[])[0].i;
      await h.ok("clear", { types: ["markers", "zones"] });
      const cl = await h.ok("clear", { types: ["burgs"], where: { state: pick.S2.i }, orphanRoutes: true });
      assert.equal((cl.removed as Obj).burgs, pick.S2.burgs + 1);

      const full = await h.ok("sketch", { action: "status", full: true });
      const recs = full.records as Obj[];
      assert.deepEqual(
        recs.map(o => o.tool),
        ["edit", "add", "clear", "clear"]
      );
      assert.equal(full.blobOnly, false);
      const op1 = recs[0].resolved.ops[0];
      assert.equal(op1.force, true);
      assert.equal(op1.newCapital, pick.alt.i);
      assert.match(recs[0].summary, /\(forced\)/);
      assert.ok(recs[2].resolved.removed.marker.includes(pick.lastMarker.i));
      assert.ok(recs[2].resolved.idents.marker[String(pick.lastMarker.i)]);
      assert.ok(recs[3].resolved.removed.burg.includes(sketchBurg));
      assert.match(recs[3].summary, /^Cleared \d+ burgs/, recs[3].summary);

      const r = await h.ok("sketch", { action: "rebase", onto: { path: files.ok } }, 240_000);
      assert.equal(r.completed, true, JSON.stringify(r.conflicts));
      assert.deepEqual(r.applied, [1, 2, 3, 4]);
      const mapped = (r.idMap as Obj).burg[String(sketchBurg)];
      assert.ok(mapped !== undefined && mapped !== sketchBurg, JSON.stringify(r.idMap));
      const v = await ev(
        `({ capital: pack.states[args.pick.S.i].capital, theirs: pack.burgs.find(b => b && b.name === "Theirford" && !b.removed)?.i ?? null,
            mine: pack.burgs[args.mapped].removed ?? false, s2: pack.burgs.filter(b => b && b.i && !b.removed && b.state === args.pick.S2.i).length,
            markers: pack.markers.length, zones: pack.zones.length })`,
        { pick, mapped }
      );
      assert.deepEqual(v, { capital: pick.alt.i, theirs: sketchBurg, mine: true, s2: 0, markers: 0, zones: 0 });
      assert.deepEqual(await ev(LINK_CHECK), { bad: 0, missing: 0, empty: 0 });
    });

    test("a cleared entity someone else removed is a conflict; a reused marker id is a conflict", async () => {
      const gone = await h.ok("sketch", { action: "rebase", onto: { path: files.burgGone } }, 240_000);
      assert.equal(gone.completed, false);
      const c = (gone.conflicts as Obj[])[0];
      assert.equal(c.seq, 4, JSON.stringify(gone.conflicts).slice(0, 1500));
      assert.match(c.reason, /REMOVED/);

      const reused = await h.ok("sketch", { action: "rebase", onto: { path: files.markerReused } }, 240_000);
      assert.equal(reused.completed, false);
      const c2 = (reused.conflicts as Obj[])[0];
      assert.equal(c2.seq, 3);
      assert.match(c2.reason, /CHANGED/);
      assert.match(c2.reason, /id was reused or someone changed it/);
    });
  });
});
