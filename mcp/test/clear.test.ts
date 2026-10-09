// Removal and bulk clear (track 'clear') against tests/fixtures/demo.map: province, culture and
// religion removal through edit, forced removal of capitals and market centres, route-link
// integrity, the clear tool (plan, where, keep, locks, full wipe, save/load, undo), and the
// sketch log: literal ids replayed onto other copies (rebase {onto:{path}} test hook).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type EditResolved, type Resolved, Rewriter, rewriteResolved, summarizeOp } from "../src/ops.ts";
import { bridgeArgs } from "../src/replay.ts";
import { rewriteClear, summarizeClear } from "../src/tools/clear.ts";
import { alive, errorBody, type Harness, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

describe("clear and removal: log forms (pure)", () => {
  test("rewriteClear maps created ids, drops their fingerprints (emblems by owner) and maps successors", () => {
    const rw = new Rewriter({ burg: { "900": 950 } }, new Set(["burg:900"]));
    const r = rewriteClear(
      {
        removed: { burg: [5, 900], emblem: ["burg:900", "state:2"] },
        idents: { burg: { "5": "a", "900": "b" }, emblem: { "burg:900": "c", "state:2": "d" } },
        capitals: [{ state: 2, burg: 900 }],
        provinceHeads: [{ province: 4, burg: 900 }],
        force: true
      } as unknown as Resolved,
      rw
    ) as unknown as Obj;
    assert.deepEqual(r.removed, { burg: [5, 950], emblem: ["burg:950", "state:2"] });
    assert.deepEqual(r.idents, { burg: { "5": "a" }, emblem: { "state:2": "d" } });
    assert.deepEqual(r.capitals, [{ state: 2, burg: 950 }]);
    assert.deepEqual(r.provinceHeads, [{ province: 4, burg: 950 }]);
    assert.equal(r.force, true);
  });

  test("summaries name what was removed, the filter and the capitals that moved", () => {
    const text = summarizeClear(
      { removed: { burg: [1, 2, 3, 4], route: [7, 8] }, orphanRoutes: 2 } as unknown as Resolved,
      {
        names: { burgs: ["Hessigrove", "Obnoch", "Farcrest"] },
        cascade: { capitalsMoved: [{ state: 3, stateName: "Oom", to: 0, name: null }] }
      },
      { where: { state: "Oom" }, force: true }
    );
    assert.equal(
      text,
      'Cleared 4 burgs (Hessigrove, Obnoch, Farcrest, ...) where {"state":"Oom"} (forced), with 2 orphan routes; capital of Oom -> none.'
    );
    const edit: EditResolved = {
      type: "burg",
      ops: [{ ref: 688, name: "Intersect", remove: true, force: true, newCapital: 46 }]
    };
    const out = {
      applied: [{ capital: { state: 9, stateName: "Oom", to: 46, name: "Kerfhold" }, routesRemoved: [3] }]
    };
    assert.equal(
      summarizeOp("edit", edit as unknown as Resolved, out),
      'Removed burg "Intersect" (688) (forced; capital of Oom -> Kerfhold; 1 orphan route removed).'
    );
    const prov: EditResolved = { type: "province", ops: [{ ref: 175, name: "The Southerners", remove: true }] };
    assert.equal(summarizeOp("edit", prov as unknown as Resolved, null), 'Removed province "The Southerners" (175).');
  });

  test("a replayed burg removal carries force, newCapital and the province heads, remapped", () => {
    const rw = new Rewriter({ burg: { "900": 950 } }, new Set(["burg:900"]));
    const edit = {
      type: "burg",
      ops: [{ ref: 3, remove: true, force: true, newCapital: 900, provinceHeads: [{ province: 4, burg: 900 }] }]
    } as unknown as Resolved;
    const args = bridgeArgs("edit", rewriteResolved("edit", edit, rw)) as Obj;
    assert.deepEqual(args.ops, [
      { ref: 3, remove: true, force: true, newCapital: 950, provinceHeads: [{ province: 4, burg: 950 }] }
    ]);
  });
});

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
// a third state: a clear of its capital moves the capital to its most populous other burg
const S3 = states.find(s => s.i !== S.i && s.i !== S2.i && s.i !== foreign.state && pack.burgs[s.capital] && !pack.burgs[s.capital].lock && (byState.get(s.i) || []).length >= 4);
const S3rest = byState.get(S3.i).filter(b => b.i !== S3.capital).sort((a, b) => b.population - a.population || a.i - b.i);
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
  S3: { i: S3.i, capital: S3.capital, next: S3rest[0].i, rival: S3rest[1].i, rivalPop: S3rest[0].population + 1 },
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
          origins: pack.cultures.filter(c => c.i && !c.removed && (c.origins || []).includes(args.i)).length,
          religions: pack.religions.filter(r => r.i && !r.removed && r.culture === args.i).length })`,
      pick.culture
    );
    assert.deepEqual(cv, { removed: true, burgs: 0, states: 0, cells: 0, origins: 0, religions: 0 });

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
    const capital = { state: pick.S.i, stateName: pick.S.name, to: pick.successor.i, name: pick.successor.name };
    assert.deepEqual((dry.plan as Obj[])[0].capital, capital);
    const done = await h.ok("edit", { type: "burg", ops: [{ ref: pick.capital.i, remove: true, force: true }] });
    assert.deepEqual((done.applied as Obj[])[0].capital, capital);
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
    const dry = await h.ok("edit", {
      type: "burg",
      ops: [{ ref: pick.mk.i, remove: true, force: true }],
      dryRun: true
    });
    const planned = (dry.plan as Obj[])[0];
    const done = await h.ok("edit", { type: "burg", ops: [{ ref: pick.mk.i, remove: true, force: true }] });
    const row = (done.applied as Obj[])[0];
    assert.deepEqual(row.marketsRemoved, [pick.mk.market]);
    assert.deepEqual(planned.marketsRemoved, row.marketsRemoved);
    assert.ok((row.dealsDropped ?? 0) >= pick.mk.marketDeals, JSON.stringify(row));
    assert.equal(planned.dealsDropped, row.dealsDropped);
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
    assert.ok((rm.routeLinksFixed as Obj).removed >= broken.bad, JSON.stringify(rm));
    assert.equal((rm.applied as Obj[])[0].routeLinksFixed, undefined, "the repair is the call's, not the row's");
    assert.deepEqual(await ev(LINK_CHECK), { bad: 0, missing: 0, empty: 0 });
    assert.equal(
      await ev(`Object.values(pack.cells.routes).some(m => Object.values(m).includes(${victim.value}))`),
      false
    );
    for (let k = 0; k < 3; k++) await h.ok("snapshot", { action: "undo" });
  });

  test("orphanRoutes keeps locked routes unless forced; edit {force:true} applies to every op", async () => {
    const locked = pick.Troutes[0];
    await h.ok("edit", { type: "route", ops: [{ ref: locked, set: { lock: true } }] });
    const dry = await h.ok("edit", {
      type: "burg",
      ops: [{ ref: pick.T, remove: true, orphanRoutes: true }],
      dryRun: true
    });
    assert.deepEqual((dry.plan as Obj[])[0].routesKeptLocked, [locked]);
    const done = await h.ok("edit", { type: "burg", ops: [{ ref: pick.T, remove: true, orphanRoutes: true }] });
    const row = (done.applied as Obj[])[0];
    assert.deepEqual(row.routesKeptLocked, [locked]);
    assert.ok(!(row.routesRemoved ?? []).includes(locked));
    assert.equal(await ev(`pack.routes.some(r => r.i === ${locked})`), true);
    assert.match(JSON.stringify(done.notes), /force:true removes them/);
    await h.ok("snapshot", { action: "undo" });
    const forced = await h.ok("edit", {
      type: "burg",
      ops: [{ ref: pick.T, remove: true, orphanRoutes: true, force: true }]
    });
    assert.ok((forced.applied as Obj[])[0].routesRemoved.includes(locked));
    await h.ok("snapshot", { action: "undo" });
    await h.ok("snapshot", { action: "undo" }); // the lock

    // one force for the whole call: a capital and a market centre together
    const both = await h.ok("edit", {
      type: "burg",
      force: true,
      ops: [
        { ref: pick.capital.i, remove: true },
        { ref: pick.mk.i, remove: true }
      ]
    });
    assert.equal((both.applied as Obj[]).length, 2);
    await h.ok("snapshot", { action: "undo" });
    const notBurg = await h.call("edit", { type: "state", force: true, ops: [{ ref: pick.S.i, remove: true }] });
    assert.equal(errorBody(notBurg).error.code, "BAD_ARGS");
  });

  test("removing a state drops its provinces with their notes and its label note (edit and clear)", async () => {
    const provs = await ev(
      `pack.provinces.filter(p => p && p.i && !p.removed && p.state === ${pick.S2.i}).map(p => p.i)`
    );
    assert.ok(provs.length > 0);
    const ids = [`province${provs[0]}`, `stateLabel${pick.S2.i}`];
    await h.ok("eval", {
      code: "for (const id of args) notes.push({ id, name: 'Note ' + id, legend: '' }); return notes.length;",
      args: ids
    });
    const left = `({ notes: notes.filter(n => args.ids.includes(n.id)).length,
      provinces: pack.provinces.filter(p => p && p.i && !p.removed && args.provs.includes(p.i)).length,
      cells: pack.cells.province.filter(x => args.provs.includes(x)).length })`;
    const before = await ev(left, { ids, provs });
    assert.equal(before.notes, 2);
    const st = await h.ok("edit", { type: "state", ops: [{ ref: pick.S2.i, remove: true }] });
    assert.equal((st.applied as Obj[])[0].provincesRemoved, provs.length);
    assert.deepEqual(await ev(left, { ids, provs }), { notes: 0, provinces: 0, cells: 0 });
    await h.ok("snapshot", { action: "undo" });
    assert.deepEqual(await ev(left, { ids, provs }), before);
    const cl = await h.ok("clear", { types: ["states"], where: { i: [pick.S2.i] } });
    assert.equal((cl.cascade as Obj).provincesWithStates, provs.length);
    assert.ok((cl.cascade as Obj).notesDropped >= 2, JSON.stringify(cl.cascade));
    assert.deepEqual(await ev(left, { ids, provs }), { notes: 0, provinces: 0, cells: 0 });
    // no state emblem renders keep running after the call (the app's editor refresh is not used)
    const coas = await ev(`document.querySelectorAll("#coas [id^=stateCOA]").length`);
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(await ev(`document.querySelectorAll("#coas [id^=stateCOA]").length`), coas);
    await h.ok("snapshot", { action: "undo" });
    await h.ok("snapshot", { action: "undo" }); // the notes
  });

  test("clear refuses filters and keeps that would do nothing, and says when everything matched was kept", async () => {
    const bogus = await h.call("clear", { types: ["burgs"], where: { bogus: 1 } });
    assert.equal(errorBody(bogus).error.code, "BAD_ARGS");
    assert.match(errorBody(bogus).error.message, /no burg has a field 'bogus'/);
    const nan = await h.call("clear", { types: ["burgs"], where: { populationMax: "abc" } });
    assert.match(errorBody(nan).error.message, /takes a number/);
    const keep = await h.call("clear", { types: ["burgs"], keep: [{ type: "state", ref: pick.S.i }] });
    assert.equal(errorBody(keep).error.code, "BAD_ARGS");
    assert.match(errorBody(keep).error.message, /keep\[0\]: 'state' is not one of the types being cleared/);

    await h.ok("edit", { type: "burg", ops: [{ ref: pick.alt.i, set: { lock: true } }] });
    const depth = await undoDepth();
    const dry = await h.ok("clear", { types: ["burgs"], where: { i: [pick.alt.i] }, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal((dry.plan as Obj).kept.burgs.count, 1);
    assert.match(String(dry.note), /1 matched, all kept \(locked: 1\); force:true/);
    const real = await h.ok("clear", { types: ["burgs"], where: { i: [pick.alt.i] } });
    assert.deepEqual(real.removed, {});
    assert.match(String(real.note), /all kept/);
    assert.equal(await undoDepth(), depth);
    await h.ok("snapshot", { action: "undo" }); // the lock

    const notes = await h.ok("clear", {
      types: ["zones", "labels"],
      where: { zones: { name: "No such zone" } },
      orphanRoutes: true,
      dryRun: true
    });
    const text = JSON.stringify(notes);
    assert.match(text, /labels: no where filter/);
    assert.match(text, /orphanRoutes applies only when burgs are cleared/);
  });

  test("hidden emblems keep their coat of arms: regenerating states after a clear works", async () => {
    await h.ok("clear", { types: ["emblems"], where: { type: "burg" } });
    const regen = await h.ok("regenerate", { parts: ["states"] }, 120_000);
    assert.ok(regen, "regenerate states after clear emblems");
    await h.ok("snapshot", { action: "undo" });
    await h.ok("snapshot", { action: "undo" });
    assert.equal(await ev(`pack.burgs.filter(b => b && b.i && !b.removed && b.coa && b.coa.size === 0).length`), 0);
  });

  test("clear: plan, where per type, keep, locks, a kept province keeps its state, refusals", async () => {
    const dry = await h.ok("clear", { types: ["burgs"], where: { state: pick.S.name }, dryRun: true });
    assert.equal((dry.plan as Obj).remove.burgs, pick.S.burgs);
    assert.deepEqual((dry.plan as Obj).cascade.capitalsMoved, [
      { state: pick.S.i, stateName: pick.S.name, to: 0, name: null }
    ]);

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
      { state: pick.S.i, stateName: pick.S.name, to: pick.successor.i, name: pick.successor.name }
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

  test("clear labels, notes, rivers and emblems by filter; a kept burg keeps its emblem", async () => {
    await h.ok("add", {
      type: "label",
      items: [
        { at: { x: 300, y: 300 }, text: "Wipe Me" },
        { at: { x: 400, y: 400 }, text: "Keep Me" }
      ]
    });
    const lab = await h.ok("clear", { types: ["labels"], where: { text: "Wipe Me" } });
    assert.deepEqual(lab.removed, { labels: 1 });
    const texts = (await h.ok("find", { type: "label", limit: 50 })).rows as Obj[];
    assert.deepEqual(
      texts.map(t => t.name),
      ["Keep Me"]
    );

    const noteName = await ev(`notes.find(n => n.id.startsWith("marker")).name`);
    const nNotes = await ev(`notes.filter(n => n.name === ${JSON.stringify(noteName)}).length`);
    const nr = await h.ok("clear", { types: ["notes"], where: { name: noteName } });
    assert.deepEqual(nr.removed, { notes: nNotes });

    const river = await ev(
      `const n = {}; for (const r of pack.rivers) n[r.type] = (n[r.type] || 0) + 1; const t = Object.keys(n).sort((a, b) => n[b] - n[a])[0];
       return { type: t, count: n[t], total: pack.rivers.length, ids: pack.rivers.filter(r => r.type === t).map(r => r.i) };`
    );
    const rr = await h.ok("clear", { types: ["rivers"], where: { rivers: { type: river.type } } });
    assert.deepEqual(rr.removed, { rivers: river.count });
    const rv = await ev(
      `({ left: pack.rivers.length, cells: pack.cells.r.filter(x => args.includes(x)).length, svg: args.filter(i => document.getElementById("river" + i)).length })`,
      river.ids
    );
    assert.deepEqual(rv, { left: river.total - river.count, cells: 0, svg: 0 });

    const keepBurg = await ev(`pack.burgs.find(b => b && b.i && !b.removed && b.coa).i`);
    const em = await h.ok("clear", {
      types: ["emblems"],
      where: { type: "burg" },
      keep: [{ type: "burg", ref: keepBurg }]
    });
    const ev2 = await ev(
      `({ shown: pack.burgs.filter(b => b && b.i && !b.removed && b.coa && b.coa.size !== 0).map(b => b.i),
          noCoa: pack.burgs.filter(b => b && b.i && !b.removed && !b.coa).length,
          states: pack.states.filter(s => s.i && !s.removed && s.coa && s.coa.size !== 0).length })`
    );
    assert.deepEqual(ev2.shown, [keepBurg]);
    assert.equal(ev2.noCoa, 0, "hidden the emblem editor's way: the coat of arms stays");
    assert.ok(ev2.states > 0, "state emblems stay");
    assert.equal((em.kept as Obj).emblems.items[0].i, `burg:${keepBurg}`);
    for (let k = 0; k < 5; k++) await h.ok("snapshot", { action: "undo" });
    assert.equal(await ev(`pack.rivers.length`), river.total);
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
    const files = { ok: "", burgGone: "", markerReused: "", burgChanged: "", capitalRival: "" };
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
      // someone renames a burg the sketch's clear removes
      files.burgChanged = await otherCopy(
        "clear-other-renamed",
        `const b = pack.burgs[${victim}]; b.name = "SomeoneElsesTown"; b.population = 99; return b.i;`
      );
      // someone makes another burg of S3 the most populous one: the replay keeps the sketch's successor
      files.capitalRival = await otherCopy(
        "clear-other-rival",
        `pack.burgs[args.S3.rival].population = args.S3.rivalPop; return args.S3.rival;`
      );
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
      await h.ok("edit", { type: "religion", ops: [{ ref: pick.religion.i, remove: true }] });
      const add = await h.ok("add", { type: "burg", items: [{ at: { cell: pick.S2.free } }] });
      sketchBurg = (add.created as Obj[])[0].i;
      await h.ok("clear", { types: ["markers", "zones"] });
      const cl = await h.ok("clear", { types: ["burgs"], where: { state: pick.S2.i }, orphanRoutes: true });
      assert.equal((cl.removed as Obj).burgs, pick.S2.burgs + 1);
      assert.equal(cl.names, undefined, "the sample names are for the log only");
      const c3 = await h.ok("clear", { types: ["burgs"], where: { i: [pick.S3.capital] } });
      assert.equal((c3.cascade as Obj).capitalsMoved[0].to, pick.S3.next);

      const full = await h.ok("sketch", { action: "status", full: true });
      const recs = full.records as Obj[];
      assert.deepEqual(
        recs.map(o => o.tool),
        ["edit", "edit", "add", "clear", "clear", "clear"]
      );
      assert.deepEqual(recs[5].resolved.capitals, [{ state: pick.S3.i, burg: pick.S3.next }]);
      assert.equal(
        Object.keys(recs[4].resolved.idents.burg).length,
        pick.S2.burgs + 1,
        "every removed burg has a fingerprint"
      );
      assert.equal(full.blobOnly, false);
      const op1 = recs[0].resolved.ops[0];
      assert.equal(op1.force, true);
      assert.equal(op1.newCapital, pick.alt.i);
      assert.match(recs[0].summary, /^Removed burg ".*" \(\d+\) \(forced; capital of .* -> .*\)\.$/, recs[0].summary);
      assert.equal(recs[1].summary, `Removed religion "${pick.religion.name}" (${pick.religion.i}).`);
      assert.equal(recs[1].resolved.ops[0].remove, true);
      assert.ok(recs[3].resolved.removed.marker.includes(pick.lastMarker.i));
      assert.ok(recs[3].resolved.idents.marker[String(pick.lastMarker.i)]);
      assert.ok(recs[4].resolved.removed.burg.includes(sketchBurg));
      assert.match(recs[4].summary, /^Cleared \d+ burgs \([^)]+, \.\.\.\) where /, recs[4].summary);
      assert.match(recs[5].summary, /; capital of .* -> /, recs[5].summary);

      const r = await h.ok("sketch", { action: "rebase", onto: { path: files.ok } }, 240_000);
      assert.equal(r.completed, true, JSON.stringify(r.conflicts));
      assert.deepEqual(r.applied, [1, 2, 3, 4, 5, 6]);
      const mapped = (r.idMap as Obj).burg[String(sketchBurg)];
      assert.ok(mapped !== undefined && mapped !== sketchBurg, JSON.stringify(r.idMap));
      const v = await ev(
        `({ capital: pack.states[args.pick.S.i].capital, theirs: pack.burgs.find(b => b && b.name === "Theirford" && !b.removed)?.i ?? null,
            mine: pack.burgs[args.mapped].removed ?? false, s2: pack.burgs.filter(b => b && b.i && !b.removed && b.state === args.pick.S2.i).length,
            markers: pack.markers.length, zones: pack.zones.length,
            religion: pack.cells.religion.filter(x => x === args.pick.religion.i).length + (pack.religions[args.pick.religion.i].removed ? 0 : 1) })`,
        { pick, mapped }
      );
      assert.deepEqual(v, {
        capital: pick.alt.i,
        theirs: sketchBurg,
        mine: true,
        s2: 0,
        markers: 0,
        zones: 0,
        religion: 0
      });
      assert.deepEqual(await ev(LINK_CHECK), { bad: 0, missing: 0, empty: 0 });
      assert.equal(await ev(`pack.states[${pick.S3.i}].capital`), pick.S3.next);
    });

    test("replay keeps the capital successor the sketch chose", async () => {
      const r = await h.ok("sketch", { action: "rebase", onto: { path: files.capitalRival } }, 240_000);
      assert.equal(r.completed, true, JSON.stringify(r.conflicts));
      const v = await ev(
        `({ capital: pack.states[args.i].capital, rivalPop: pack.burgs[args.rival].population, nextPop: pack.burgs[args.next].population })`,
        pick.S3
      );
      assert.ok(v.rivalPop > v.nextPop, "the rival is now the most populous");
      assert.equal(v.capital, pick.S3.next);
    });

    test("a cleared entity someone else removed is a conflict; a reused marker id is a conflict", async () => {
      const gone = await h.ok("sketch", { action: "rebase", onto: { path: files.burgGone } }, 240_000);
      assert.equal(gone.completed, false);
      const c = (gone.conflicts as Obj[])[0];
      assert.equal(c.seq, 5, JSON.stringify(gone.conflicts).slice(0, 1500));
      assert.match(c.reason, /REMOVED/);

      const reused = await h.ok("sketch", { action: "rebase", onto: { path: files.markerReused } }, 240_000);
      assert.equal(reused.completed, false);
      const c2 = (reused.conflicts as Obj[])[0];
      assert.equal(c2.seq, 4);
      assert.match(c2.reason, /CHANGED/);
      assert.match(c2.reason, /id was reused/);

      // a burg someone renamed since: a conflict, as edit's removal reports it
      const ren = await h.ok("sketch", { action: "rebase", onto: { path: files.burgChanged } }, 240_000);
      assert.equal(ren.completed, false);
      const c3 = (ren.conflicts as Obj[])[0];
      assert.equal(c3.seq, 5);
      assert.match(c3.reason, /CHANGED: .*'SomeoneElsesTown'.*someone changed it since/);
    });
  });
});
