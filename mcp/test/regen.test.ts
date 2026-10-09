// regenerate provinces / emblems for hand-made states (track 'regen'): scoped, lock-aware
// provinces (auto, count and explicit centres, including states with few or no burgs and
// builder-style states carved by repainting cells.state), emblems with the culture's shield,
// dryRun previews, undo, and the literal outcome replaying in a sketch rebase (also for a state
// the sketch itself made). Runs against tests/fixtures/demo.map with the safe test env.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { blobOnlyReasons, NOT_REPLAYABLE, Rewriter, sanitizeRecord, unreplayableReason } from "../src/ops.ts";
import { REGEN_OP, regenCreated, regenFocus, regenRewrite, regenSummary, regenUnreplayable } from "../src/regen.ts";
import { changeRanking } from "../src/tools/sketch.ts";
import { alive, errorBody, type Harness, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

// ---------------------------------------------------------------- pure (no browser)

describe("regen replay spec (pure)", () => {
  const literal = {
    parts: ["provinces", "emblems"],
    graph: "7462:abc",
    provinces: {
      states: [2, 30],
      names: ["Gazd", "Handmark"],
      keepLocked: true,
      kept: [5],
      replaced: [
        { i: 4, state: 2, name: "Old", burg: 9, cells: "c1", coa: "k1" },
        { i: 200, state: 30, name: "Painted", burg: 0 }
      ],
      created: [
        { i: 210, state: 2, center: 11, burg: 9, name: "A", coa: { t1: "or" }, runs: [11, 3] },
        { i: 211, state: 30, center: 40, burg: 800, name: "B", coa: { t1: "azure" }, runs: [40, 2] }
      ]
    },
    emblems: {
      keepLocked: true,
      n: { states: 1, provinces: 3, burgs: 0 },
      states: [{ i: 30, was: "h", coa: {} }],
      provinces: [
        { i: 7, was: "h", coa: {}, state: 2, center: 70 },
        { i: 201, was: "h", coa: {}, state: 30, center: 41 }
      ],
      burgs: []
    }
  };

  test("the literal form is logged as its own op; plain regenerate stays blob-only (slot left free)", () => {
    assert.equal(regenUnreplayable(literal as never), null);
    assert.equal(unreplayableReason(REGEN_OP, literal as never), null, "registered through REPLAY_EXT");
    assert.equal(unreplayableReason("regenerate", literal as never), NOT_REPLAYABLE.regenerate);
    assert.match(String(regenUnreplayable(null)), /no recorded outcome/);
    assert.match(String(regenUnreplayable({ parts: ["provinces", "routes"] } as never)), /regenerate routes re-runs/);
    assert.match(String(regenUnreplayable({ parts: ["provinces"] } as never)), /incomplete/);
    assert.match(String(regenUnreplayable({ type: "burg", ops: [] } as never)), /no parts/);
  });

  test("saved records: the literal op stays replayable with a plain sentence", () => {
    const ok = sanitizeRecord({ seq: 2, tool: REGEN_OP, args: { parts: ["provinces"] }, resolved: literal }, 0);
    assert.equal(ok.replayable, true);
    assert.equal(
      ok.summary,
      "Replaced 2 provinces of 2 states with 2 new (A, B); 1 locked kept; new emblems for 1 state, 3 provinces and 0 burgs."
    );
    const one = structuredClone(literal) as Obj;
    one.parts = ["provinces"];
    one.provinces.states = [30];
    one.provinces.replaced = [];
    one.provinces.kept = [];
    one.provinces.created = one.provinces.created.slice(1);
    one.provinces.names = ["Handmark"];
    delete one.emblems;
    assert.equal(regenSummary(one as never, null), "Gave Handmark (30) 1 new province (B).");
    const zones = sanitizeRecord({ tool: "regenerate", args: { parts: ["zones"] }, resolved: null }, 0);
    assert.equal(zones.replayable, false);
    assert.match(blobOnlyReasons({ blockers: [], ops: [zones] } as never)[0], /op 1 \(regenerate\)/);
    assert.equal(regenSummary(null, null, { parts: ["zones", "routes"] }), "Regenerated zones, routes.");
  });

  test("rewrite: sketch-made ids mapped; a state the sketch made is fresh and its unreported provinces located", () => {
    const rw = new Rewriter(
      { state: { "30": 31 }, burg: { "800": 805 }, province: { "210": 212 } },
      new Set(["state:30", "burg:800"])
    );
    const r = regenRewrite(structuredClone(literal) as never, rw) as unknown as Obj;
    assert.deepEqual(r.provinces.states, [2, 31]);
    assert.deepEqual(r.provinces.fresh, [31]);
    assert.deepEqual(
      r.provinces.replaced.map((x: Obj) => [x.i, x.state, x.fresh ?? false]),
      [
        [4, 2, false],
        [200, 31, true]
      ],
      "an unreported province of a fresh state keeps its id: replay does not look it up"
    );
    assert.deepEqual(
      r.provinces.created.map((d: Obj) => [d.i, d.state, d.burg]),
      [
        [210, 2, 9],
        [211, 31, 805]
      ]
    );
    assert.deepEqual([r.emblems.states[0].i, r.emblems.states[0].fresh], [31, true]);
    assert.equal(r.emblems.provinces[0].locate, undefined);
    assert.deepEqual(
      [r.emblems.provinces[1].locate, r.emblems.provinces[1].fresh, r.emblems.provinces[1].state],
      [true, true, 31]
    );
    assert.deepEqual(regenCreated(literal as never), [
      [
        { type: "province", i: 210 },
        { type: "province", i: 211 }
      ]
    ]);
    assert.deepEqual(regenCreated({ parts: ["emblems"], emblems: {} } as never), []);
  });

  test("the sketch summary frames a regen-only sketch on the state, with the provinces layer", () => {
    const focus = regenFocus(literal as never);
    assert.deepEqual(
      focus.map(f => [f.i, f.layers]),
      [
        [2, ["provinces", "borders"]],
        [30, ["provinces", "borders"]]
      ]
    );
    const op = { seq: 1, tool: REGEN_OP, resolved: literal, replayable: true };
    const top = changeRanking({ ops: [op] } as never)[0];
    assert.deepEqual([top.type, top.i, top.layers], ["state", 30, ["provinces", "borders"]]);
  });
});

// ---------------------------------------------------------------- page

interface Pick {
  /** A state with a few burgs: count / centres tests. */
  S1: { i: number; name: string; capital: number; burgs: number; culture: number };
  /** Land cell of S1 far from its capital, without a burg. */
  farAt: { x: number; y: number; cell: number };
  /** Another state (emblems), with a culture of a different shield available. */
  S2: { i: number; name: string; culture: number };
  otherCulture: number;
  /** The biggest state: hand-made states are carved out of it. */
  B: { i: number; name: string };
  /** A burg-free patch of B: centre and cells (ring 2). */
  patch: { at: { x: number; y: number }; cells: number[] };
  patch2: { center: number; cells: number[]; state: number };
  /** Two inland ring-2 patches of one state on one landmass, apart (crossForeign). */
  twin: { a: number[]; b: number[]; aCenter: number; aNext: number } | null;
}

const PICK_CODE = `
const C = pack.cells;
const live = x => x && x.i && !x.removed;
const states = pack.states.filter(live);
const burgsOf = s => pack.burgs.filter(b => live(b) && C.state[b.cell] === s.i);
const S1 = states.filter(s => burgsOf(s).length >= 4).sort((a, b) => burgsOf(a).length - burgsOf(b).length)[0];
const cap = pack.burgs[S1.capital];
let far = -1, fd = -1;
for (const c of C.i) if (C.state[c] === S1.i && C.h[c] >= 20 && !C.burg[c]) {
  const d = (C.p[c][0] - cap.x) ** 2 + (C.p[c][1] - cap.y) ** 2;
  if (d > fd) { fd = d; far = c; }
}
const shieldOf = c => pack.cultures[c].shield;
const S2 = states.find(s => s.i !== S1.i && pack.cultures.some(c => c && c.i && !c.removed && c.shield !== shieldOf(s.culture)));
const otherCulture = pack.cultures.find(c => c && c.i && !c.removed && c.shield !== shieldOf(S2.culture) && c.shield !== S2.coa.shield).i;
const B = states.filter(s => s.i !== S1.i && s.i !== S2.i).sort((a, b) => burgsOf(b).length - burgsOf(a).length)[0];
const ring = (c0, r) => { let set = new Set([c0]); for (let k = 0; k < r; k++) for (const c of [...set]) for (const n of C.c[c]) set.add(n); return [...set]; };
const usable = (c0, sid, taken) => { const cs = ring(c0, 2); return cs.every(c => C.state[c] === sid && C.h[c] >= 20 && !C.burg[c] && !taken.has(c)) ? cs : null; };
let p1 = null, p2 = null;
const taken = new Set();
for (const c of C.i) {
  const sid = C.state[c];
  if (!sid || sid === S1.i || sid === S2.i || C.burg[c] || (!p1 && sid !== B.i)) continue;
  const cs = usable(c, sid, taken);
  if (!cs) continue;
  if (!p1) { p1 = { center: c, cells: cs }; for (const x of ring(c, 4)) taken.add(x); }
  else { p2 = { center: c, cells: cs, state: sid }; break; }
}
// twin: two ring-2 patches of one state, inland (ring 3 all land of that state, so the spread
// from one cannot leave it without crossing foreign land), no capital, 7+ rings apart, one landmass
const capitals = new Set(states.map(s => pack.burgs[s.capital]?.cell));
const inland = c => !C.burg[c] && ring(c, 3).every(x => C.state[x] === C.state[c] && C.h[x] >= 20) && ring(c, 2).every(x => !capitals.has(x));
let twin = null;
for (const st of states) {
  if (st.i === S1.i || st.i === S2.i) continue;
  const cand = [...C.i].filter(c => C.state[c] === st.i && !taken.has(c) && inland(c));
  for (const a of cand) {
    const near = new Set(ring(a, 7));
    const b = cand.find(x => !near.has(x) && C.f[x] === C.f[a]);
    const aNext = C.c[a].find(x => !C.burg[x]);
    if (b !== undefined && aNext !== undefined) { twin = { a: ring(a, 2), b: ring(b, 2), aCenter: a, aNext }; break; }
  }
  if (twin) break;
}
return {
  S1: { i: S1.i, name: S1.name, capital: S1.capital, burgs: burgsOf(S1).length, culture: S1.culture },
  farAt: { x: C.p[far][0], y: C.p[far][1], cell: far },
  S2: { i: S2.i, name: S2.name, culture: S2.culture },
  otherCulture,
  B: { i: B.i, name: B.name },
  patch: { at: { x: C.p[p1.center][0], y: C.p[p1.center][1] }, cells: p1.cells },
  patch2: p2,
  twin
};`;

/** Page-side checks of a state's provinces: coverage, ownership, shields (Wildlands -> state's culture). */
const STATE_CHECK = `
const C = pack.cells;
const sid = args.sid;
const live = x => x && x.i && !x.removed;
const s = pack.states[sid];
const provs = pack.provinces.filter(p => live(p) && p.state === sid);
const land = [...C.i].filter(c => C.state[c] === sid && C.h[c] >= 20);
const uncovered = land.filter(c => !C.province[c]).length;
const foreign = land.filter(c => C.province[c] && pack.provinces[C.province[c]].state !== sid).length;
const cult = p => (p.burg && live(pack.burgs[p.burg]) ? pack.burgs[p.burg].culture : C.culture[p.center]) || s.culture;
const badShield = provs.filter(p => p.coa.shield !== COA.getShield(cult(p), sid)).map(p => p.i);
const cellsOf = id => [...C.i].filter(c => C.province[c] === id);
return {
  provinces: provs.map(p => ({ i: p.i, name: p.name, fullName: p.fullName, formName: p.formName, burg: p.burg, center: p.center, cells: cellsOf(p.i).length, pole: !!p.pole, shield: p.coa.shield })),
  listed: [...(s.provinces || [])].sort((a, b) => a - b),
  uncovered, foreign, badShield, land: land.length
};`;

/** Hash of everything province-related outside the given states. */
const OUTSIDE_HASH = `
const C = pack.cells;
const skip = new Set(args.sids);
const provs = pack.provinces.filter(p => p && p.i && !p.removed && !skip.has(p.state));
const cells = [...C.i].filter(c => !skip.has(C.state[c])).map(c => C.province[c]);
const other = pack.states.filter(s => s && s.i && !skip.has(s.i)).map(s => s.provinces);
return __tupaia.pure.hashStr(JSON.stringify([provs, cells, other]));`;

/** A builder-style state made by eval: no capital burg, cells.state repainted directly (cells.province untouched). */
const CARVE_CODE = `
const C = pack.cells;
const i = pack.states.length;
const culture = C.culture[args.center] || 1;
pack.states.push({ i, name: args.name, color: "#335577", capital: 0, center: args.center, culture,
  type: "Generic", form: "Monarchy", formName: "Kingdom", fullName: "Kingdom of " + args.name, expansionism: 1,
  provinces: [], diplomacy: [], neighbors: [], military: [], alert: 1,
  coa: COA.generate(null, null, null, pack.cultures[culture].type) });
for (const c of args.cells) C.state[c] = i;
return i;`;

describe("regenerate provinces and emblems (page)", () => {
  let h: Harness;
  let pick: Pick;
  const evalRO = async (code: string, args?: unknown) =>
    (await h.ok("eval", { code, args, readOnly: true })).value as any;
  const undoDepth = async () => ((await h.ok("snapshot", { action: "list" })).undo as unknown[]).length;
  let handmade = 0;

  before(async () => {
    h = await startServer();
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    pick = (await evalRO(PICK_CODE)) as Pick;
    assert.ok(pick.patch && pick.patch2, JSON.stringify(pick));
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("dryRun previews sizes in the real result's shape; emblems count the provinces it would make", async () => {
    const depth = await undoDepth();
    const hash = await evalRO(OUTSIDE_HASH, { sids: [] });
    const r = await h.ok("regenerate", {
      parts: ["emblems", "provinces"],
      provinces: { states: [pick.S1.name], count: 3 },
      emblems: { states: [pick.S1.i], burgs: false },
      dryRun: true
    });
    assert.equal(r.dryRun, true);
    assert.deepEqual(r.parts, ["provinces", "emblems"], "dependency order");
    const p = r.provinces as Obj;
    assert.equal(p.created, 3);
    const row = p.states[0];
    assert.deepEqual([row.i, row.mode, row.created], [pick.S1.i, "count", 3]);
    const land = (await evalRO(STATE_CHECK, { sid: pick.S1.i })).land;
    assert.equal(
      row.sizes.reduce((a: number, b: number) => a + b, 0),
      land,
      "the sizes cover the state"
    );
    assert.ok(Math.max(...row.sizes) <= 3 * Math.min(...row.sizes), `count balances the areas: ${row.sizes}`);
    assert.equal(p.list.length, 3);
    assert.deepEqual(r.emblems, { states: 1, provinces: 3, burgs: 0 }, "the new provinces, not the current ones");
    assert.equal(await undoDepth(), depth);
    assert.equal(await evalRO(OUTSIDE_HASH, { sids: [] }), hash, "nothing changed");
    const mixed = await h.call("regenerate", { parts: ["provinces", "zones"], dryRun: true });
    assert.equal(mixed.isError, true);
    assert.match(errorBody(mixed).error.message, /dryRun works with parts provinces and\/or emblems only/);
  });

  test("a hand-made state with one burg gets provinces (auto); every other province is untouched", async () => {
    const add = await h.ok("add", { type: "state", items: [{ capital: pick.patch.at, name: "Handmark" }] });
    handmade = (add.created as Obj[])[0].i;
    await h.ok("paint_cells", { select: { cells: pick.patch.cells }, set: { state: handmade } });
    const outside = await evalRO(OUTSIDE_HASH, { sids: [handmade, pick.B.i] });
    const r = await h.ok("regenerate", { parts: ["provinces"], provinces: { states: ["Handmark"] } });
    const p = r.provinces as Obj;
    assert.ok(p.created >= 1, JSON.stringify(p));
    assert.equal(p.states[0].mode, "auto");
    const chk = await evalRO(STATE_CHECK, { sid: handmade });
    assert.equal(chk.uncovered, 0, JSON.stringify(chk));
    assert.equal(chk.foreign, 0);
    assert.deepEqual(chk.badShield, [], "province emblems use the culture's shield");
    assert.deepEqual(
      chk.listed,
      chk.provinces.map((x: Obj) => x.i)
    );
    assert.ok(chk.provinces.every((x: Obj) => x.pole && x.cells > 0));
    const minCells = Math.max(3, Math.ceil(chk.land * 0.03));
    assert.ok(
      chk.provinces.every((x: Obj) => x.burg || x.cells >= minCells || /^Islands?$/.test(x.formName)),
      "no tiny wild province"
    );
    assert.equal(await evalRO(OUTSIDE_HASH, { sids: [handmade, pick.B.i] }), outside, "other provinces untouched");
    // the new provinces are drawn when the layer is shown later; nothing was turned on
    assert.deepEqual((r.layerChanges as Obj).turnedOn, []);
  });

  test("Wildlands land takes the state's culture shield; emblems stateCulture", async () => {
    // the hand-made state's culture is set, its land and burg stay Wildlands (culture 0)
    await h.ok("edit", { type: "state", ops: [{ ref: handmade, set: { culture: pick.otherCulture } }] });
    await h.ok("eval", {
      args: { sid: handmade },
      code: `const C = pack.cells;
        for (const c of C.i) if (C.state[c] === args.sid) C.culture[c] = 0;
        for (const b of pack.burgs) if (b && b.i && !b.removed && b.state === args.sid) b.culture = 0;
        return 1;`
    });
    const r = await h.ok("regenerate", { parts: ["provinces", "emblems"], provinces: { states: [handmade] } });
    const want = await evalRO(`COA.getShield(${pick.otherCulture}, ${handmade})`);
    const got = await evalRO(
      `[...pack.provinces.filter(p => p && p.i && !p.removed && p.state === ${handmade}).map(p => p.coa.shield),
        ...pack.burgs.filter(b => b && b.i && !b.removed && b.state === ${handmade}).map(b => b.coa.shield)]`
    );
    assert.ok(got.length >= 2 && got.every((s: string) => s === want), `${got} vs ${want}`);
    assert.match(JSON.stringify(r.notes), /took the state's culture/);
    // stateCulture: every province and burg of the state follows the state's culture
    const e = await h.ok("regenerate", {
      parts: ["emblems"],
      emblems: { states: [handmade], shieldOnly: true, stateCulture: true }
    });
    assert.equal((e.emblems as Obj).stateCulture, true);
    assert.ok(!JSON.stringify(e.notes ?? []).includes("took the state's culture"));
  });

  test("a state with no burgs at all gets wild provinces (auto)", async () => {
    const sid = await h.ok("eval", {
      args: { cells: pick.patch2.cells, center: pick.patch2.center, name: "Burgless" },
      code: CARVE_CODE
    });
    const burgless = sid.value as number;
    const outside = await evalRO(OUTSIDE_HASH, { sids: [burgless, pick.patch2.state] });
    const r = await h.ok("regenerate", { parts: ["provinces"], provinces: { states: [burgless] } });
    assert.ok((r.provinces as Obj).created >= 1);
    const chk = await evalRO(STATE_CHECK, { sid: burgless });
    assert.equal(chk.uncovered, 0);
    assert.ok(chk.provinces.every((x: Obj) => x.burg === 0));
    assert.deepEqual(chk.badShield, []);
    assert.equal(await evalRO(OUTSIDE_HASH, { sids: [burgless, pick.patch2.state] }), outside);
    // back to before the eval
    await h.ok("snapshot", { action: "undo", n: 2 });
    assert.equal(await evalRO("pack.states.length"), burgless);
  });

  test("a state carved from whole and half provinces of another: the emptied one is removed, the shrunk one refitted", async () => {
    // B's two biggest non-capital provinces: all of P, and the half of Q around its centre
    const pq = await evalRO(
      `const C = pack.cells; const live = x => x && x.i && !x.removed;
       const st = pack.states[${pick.B.i}];
       const capCell = pack.burgs[st.capital].cell;
       const cellsOf = id => [...C.i].filter(c => C.province[c] === id);
       const provs = pack.provinces.filter(p => live(p) && p.state === st.i && C.province[capCell] !== p.i && C.state[p.center] === st.i)
         .map(p => ({ i: p.i, cells: cellsOf(p.i) })).filter(p => p.cells.length >= 8).sort((a, b) => b.cells.length - a.cells.length);
       const [P, Q] = provs;
       const qp = pack.provinces[Q.i];
       const [x0, y0] = C.p[qp.center];
       const half = Q.cells.map(c => [c, (C.p[c][0] - x0) ** 2 + (C.p[c][1] - y0) ** 2]).sort((a, b) => a[1] - b[1])
         .slice(0, Math.floor(Q.cells.length / 2)).map(x => x[0]);
       return { P: P.i, Pcells: P.cells, Q: Q.i, Qhalf: half, Qcenter: qp.center };`
    );
    const sid = (
      await h.ok("eval", {
        args: { cells: [...pq.Pcells, ...pq.Qhalf], center: pq.Pcells[0], name: "Carved" },
        code: CARVE_CODE
      })
    ).value as number;
    const outside = await evalRO(OUTSIDE_HASH, { sids: [sid, pick.B.i] });
    const B_REST = `const C = pack.cells; const skip = new Set([${pq.P}, ${pq.Q}]);
      const provs = pack.provinces.filter(p => p && p.i && !p.removed && p.state === ${pick.B.i} && !skip.has(p.i));
      return __tupaia.pure.hashStr(JSON.stringify([provs, provs.map(p => [...C.i].filter(c => C.province[c] === p.i))]));`;
    const bRest = await evalRO(B_REST);
    const r = await h.ok("regenerate", { parts: ["provinces"], provinces: { states: ["Carved"] } });
    assert.match(JSON.stringify(r.notes), /provinces of other states lost .* left empty and removed/);
    const now = await evalRO(
      `const C = pack.cells; const live = x => x && x.i && !x.removed;
       const P = pack.provinces[${pq.P}], Q = pack.provinces[${pq.Q}];
       const count = id => [...C.i].filter(c => C.province[c] === id).length;
       return {
         Plive: live(P), Plisted: pack.states[${pick.B.i}].provinces.includes(${pq.P}),
         Qlive: live(Q), QcenterOwn: C.province[Q.center] === Q.i, Qcenter: Q.center, Qcells: count(Q.i),
         QburgOk: !Q.burg || C.province[pack.burgs[Q.burg].cell] === Q.i,
         empty: pack.provinces.filter(p => live(p) && !count(p.i)).map(p => p.i)
       };`
    );
    assert.equal(now.Plive, false, "the emptied province is a removed placeholder");
    assert.equal(now.Plisted, false, "and no longer listed by its state");
    assert.equal(now.Qlive, true);
    assert.equal(now.QcenterOwn, true, "the shrunk province's centre is one of its own cells");
    assert.notEqual(now.Qcenter, pq.Qcenter);
    assert.ok(now.Qcells > 0 && now.QburgOk);
    assert.deepEqual(now.empty, [], "no live province without cells");
    const chk = await evalRO(STATE_CHECK, { sid });
    assert.equal(chk.uncovered + chk.foreign, 0);
    assert.equal(await evalRO(OUTSIDE_HASH, { sids: [sid, pick.B.i] }), outside, "other states untouched");
    assert.equal(await evalRO(B_REST), bRest, "B's other provinces untouched");
    await h.ok("snapshot", { action: "undo", n: 2 });
    assert.equal(await evalRO("pack.states.length"), sid);
  });

  test("centres: land the centres cannot reach inside the state is reported as fallback; crossForeign reaches it", async () => {
    assert.ok(pick.twin, "demo.map has two inland patches of one state");
    const t = pick.twin;
    const sid = (
      await h.ok("eval", { args: { cells: [...t.a, ...t.b], center: t.aCenter, name: "Twofold" }, code: CARVE_CODE })
    ).value as number;
    const centres = [
      { state: sid, at: { cell: t.aCenter }, name: "Hither" },
      { state: sid, at: { cell: t.aNext }, name: "Yon" }
    ];
    const near = await h.ok("regenerate", { parts: ["provinces"], provinces: { centres }, dryRun: true });
    const row = (near.provinces as Obj).states[0];
    assert.equal(row.fallback, t.b.length, JSON.stringify(near));
    assert.match(JSON.stringify(near.notes), /crossForeign:true/);
    const far = await h.ok("regenerate", {
      parts: ["provinces"],
      provinces: { centres, crossForeign: true },
      dryRun: true
    });
    assert.equal((far.provinces as Obj).states[0].fallback, undefined, JSON.stringify(far));
    await h.ok("snapshot", { action: "undo" });
  });

  test("explicit centres: a burg and a place, names kept, the whole state covered", async () => {
    const outside = await evalRO(OUTSIDE_HASH, { sids: [pick.S1.i] });
    const r = await h.ok("regenerate", {
      parts: ["provinces"],
      provinces: {
        centres: [
          { state: pick.S1.i, burg: pick.S1.capital, name: "Northmarch", formName: "March" },
          {
            state: pick.S1.name,
            at: { x: pick.farAt.x, y: pick.farAt.y },
            name: "Southmarch",
            fullName: "Duchy of Southmarch"
          }
        ]
      }
    });
    const p = r.provinces as Obj;
    assert.equal(p.created, 2);
    assert.equal(p.states[0].mode, "centres");
    const chk = await evalRO(STATE_CHECK, { sid: pick.S1.i });
    assert.equal(chk.provinces.length, 2);
    const [north, south] = chk.provinces;
    assert.equal(north.fullName, "Northmarch March");
    assert.equal(north.burg, pick.S1.capital);
    assert.equal(south.name, "Southmarch");
    assert.equal(south.fullName, "Duchy of Southmarch");
    assert.equal(south.burg, 0);
    assert.equal(south.center, pick.farAt.cell);
    assert.equal(chk.uncovered, 0);
    assert.equal(north.cells + south.cells, chk.land);
    assert.deepEqual(p.states[0].sizes, [north.cells, south.cells]);
    assert.deepEqual(chk.badShield, []);
    assert.equal(await evalRO(OUTSIDE_HASH, { sids: [pick.S1.i] }), outside);
  });

  test("count: that many provinces per state, on burgs where there are some, places elsewhere", async () => {
    const want = pick.S1.burgs + 2;
    const r = await h.ok("regenerate", {
      parts: ["provinces"],
      provinces: { states: [pick.S1.i], count: want }
    });
    assert.equal((r.provinces as Obj).created, want);
    const chk = await evalRO(STATE_CHECK, { sid: pick.S1.i });
    assert.equal(chk.provinces.length, want);
    const onBurgs = chk.provinces.filter((x: Obj) => x.burg);
    assert.ok(onBurgs.length <= pick.S1.burgs && want - onBurgs.length >= 2, JSON.stringify(chk.provinces));
    assert.ok(
      onBurgs.some((x: Obj) => x.burg === pick.S1.capital),
      "the capital centres a province"
    );
    assert.equal(chk.uncovered, 0);
    assert.ok(chk.provinces.every((x: Obj) => x.cells > 0));
  });

  test("locks: a locked province keeps its id and cells; a locked state needs lockedStates; keepLocked:false takes all", async () => {
    const before = await evalRO(STATE_CHECK, { sid: pick.S1.i });
    const locked = before.provinces[0];
    await h.ok("edit", { type: "province", ops: [{ ref: locked.i, set: { lock: true } }] });
    const cellsBefore = await evalRO(`[...pack.cells.i].filter(c => pack.cells.province[c] === ${locked.i})`);
    await h.ok("regenerate", { parts: ["provinces"], provinces: { states: [pick.S1.i], count: 3 } });
    const after = await evalRO(STATE_CHECK, { sid: pick.S1.i });
    assert.ok(after.provinces.some((x: Obj) => x.i === locked.i && x.name === locked.name));
    assert.equal(after.provinces.length, 4, "3 new + the locked one");
    assert.deepEqual(
      await evalRO(`[...pack.cells.i].filter(c => pack.cells.province[c] === ${locked.i})`),
      cellsBefore
    );
    assert.equal(after.uncovered, 0);
    assert.ok(after.listed.includes(locked.i));

    await h.ok("edit", { type: "state", ops: [{ ref: pick.S1.i, set: { lock: true } }] });
    const depth = await undoDepth();
    const refused = await h.call("regenerate", { parts: ["provinces"], provinces: { states: [pick.S1.i] } });
    assert.equal(refused.isError, true);
    assert.equal(errorBody(refused).error.code, "REFUSED");
    assert.match(errorBody(refused).error.message, /is locked: pass lockedStates:true/);
    assert.equal(await undoDepth(), depth, "a refused call takes no undo entry");
    // the default set skips the locked state
    const dry = await h.ok("regenerate", { parts: ["provinces"], dryRun: true });
    assert.ok(!((dry.provinces as Obj).states as Obj[]).some(s => s.i === pick.S1.i));
    // lockedStates: the locked state's provinces are regenerated, its locked province kept
    const both = await h.ok("regenerate", {
      parts: ["provinces"],
      provinces: { states: [pick.S1.i], count: 2, lockedStates: true }
    });
    assert.deepEqual([(both.provinces as Obj).replaced, (both.provinces as Obj).keptLocked], [3, 1]);
    const forced = await h.ok("regenerate", {
      parts: ["provinces"],
      provinces: { states: [pick.S1.i], count: 2, lockedStates: true, keepLocked: false }
    });
    assert.equal((forced.provinces as Obj).replaced, 3, "the locked province is replaced too");
  });

  test("emblems: a locked state is kept and named in a note unless lockedStates", async () => {
    // S1 is still locked from the previous test
    const r = await h.ok("regenerate", { parts: ["emblems"], emblems: { states: [pick.S1.i], burgs: false } });
    assert.equal((r.emblems as Obj).states, 0);
    assert.deepEqual((r.emblems as Obj).kept, { locked: 1, custom: 0 });
    assert.match(
      JSON.stringify(r.notes),
      new RegExp(`locked state ${pick.S1.name} \\(${pick.S1.i}\\) were kept: pass lockedStates:true`)
    );
    const dry = await h.ok("regenerate", {
      parts: ["emblems"],
      emblems: { states: [pick.S1.i], burgs: false, lockedStates: true },
      dryRun: true
    });
    assert.equal((dry.emblems as Obj).states, 1);
    const yes = await h.ok("regenerate", {
      parts: ["emblems"],
      emblems: { states: [pick.S1.i], burgs: false, lockedStates: true }
    });
    assert.equal((yes.emblems as Obj).states, 1);
    assert.deepEqual(Object.keys(yes.emblems as Obj).sort(), Object.keys(dry.emblems as Obj).sort(), "same shape");
    await h.ok("edit", { type: "state", ops: [{ ref: pick.S1.i, set: { lock: false } }] });
  });

  test("bad options are refused before any change", async () => {
    const depth = await undoDepth();
    const cases: Array<[Obj, RegExp]> = [
      [
        {
          centres: [
            { state: pick.S1.i, burg: pick.S1.capital },
            { state: pick.S1.i, burg: pick.S1.capital }
          ]
        },
        /same cell/
      ],
      [{ centres: [{ state: pick.S2.i, burg: pick.S1.capital }] }, /is in .*, not /],
      [{ centres: [{ state: pick.S1.i }] }, /burg or at/],
      [{ states: [pick.S2.i], centres: [{ state: pick.S1.i, burg: pick.S1.capital }] }, /not in states/],
      [{ states: [0] }, /Neutrals/]
    ];
    for (const [provinces, re] of cases) {
      const r = await h.call("regenerate", { parts: ["provinces"], provinces });
      assert.equal(r.isError, true, JSON.stringify(provinces));
      assert.match(errorBody(r).error.message, re);
    }
    // a misspelt option is rejected by the schema instead of silently regenerating everything
    const typo = await h.call("regenerate", { parts: ["provinces"], provinces: { centers: [] } });
    assert.equal(typo.isError, true);
    const orphan = await h.call("regenerate", { parts: ["zones"], provinces: { count: 2 } });
    assert.equal(orphan.isError, true);
    assert.match(errorBody(orphan).error.message, /'provinces' in parts/);
    // ratio 0 (no growth) would make every free cell a one-cell province
    assert.equal((await h.call("regenerate", { parts: ["provinces"], provinces: { ratio: 0 } })).isError, true);
    const was = await evalRO(
      `const el = document.getElementById("provincesRatio"); const v = el.value; el.value = 0; return v`
    );
    try {
      const zero = await h.call("regenerate", { parts: ["provinces"], provinces: { states: [pick.S1.i] } });
      assert.equal(zero.isError, true);
      assert.match(errorBody(zero).error.message, /provinces ratio is 0/);
      await h.ok("regenerate", { parts: ["provinces"], provinces: { states: [pick.S1.i], count: 2 }, dryRun: true });
    } finally {
      await evalRO(`document.getElementById("provincesRatio").value = ${JSON.stringify(was)}; return 1`);
    }
    // count next to centres for every state is noted as unused
    const unused = await h.ok("regenerate", {
      parts: ["provinces"],
      provinces: { centres: [{ state: pick.S1.i, burg: pick.S1.capital }], count: 4 },
      dryRun: true
    });
    assert.match(JSON.stringify(unused.notes), /count was not used/);
    assert.equal(await undoDepth(), depth);
  });

  test("emblems: the state's culture shield, provinces and burgs follow; locked and other states kept; undo", async () => {
    const S = pick.S2.i;
    await h.ok("edit", { type: "state", ops: [{ ref: S, set: { culture: pick.otherCulture } }] });
    const lockedBurg = await evalRO(`pack.burgs.find(b => b && b.i && !b.removed && b.state === ${S} && !b.capital).i`);
    await h.ok("edit", { type: "burg", ops: [{ ref: lockedBurg, set: { lock: true } }] });
    const snap = `
      const live = x => x && x.i && !x.removed;
      const h = x => __tupaia.pure.hashStr(JSON.stringify(x.coa));
      const st = pack.states[${S}];
      const cul = c => c || st.culture;
      return {
        state: st.coa,
        others: __tupaia.pure.hashStr(JSON.stringify(pack.states.filter(s => live(s) && s.i !== ${S}).map(h).concat(pack.burgs.filter(b => live(b) && b.state !== ${S}).map(h)))),
        locked: h(pack.burgs[${lockedBurg}]),
        burgs: pack.burgs.filter(b => live(b) && b.state === ${S} && b.i !== ${lockedBurg}).map(b => [b.i, h(b), b.coa.shield === COA.getShield(cul(b.culture), ${S})]),
        provs: pack.provinces.filter(p => live(p) && p.state === ${S}).map(p => {
          const pc = p.burg && live(pack.burgs[p.burg]) ? pack.burgs[p.burg].culture : pack.cells.culture[p.center];
          return [p.i, h(p), p.coa.shield === COA.getShield(cul(pc), ${S})];
        })
      };`;
    const before = await evalRO(snap);
    const r = await h.ok("regenerate", { parts: ["emblems"], emblems: { states: [pick.S2.name] } });
    const e = r.emblems as Obj;
    assert.equal(e.states, 1);
    assert.equal(e.burgs, before.burgs.length);
    assert.equal(e.provinces, before.provs.length);
    assert.deepEqual(e.kept, { locked: 1, custom: 0 });
    const after = await evalRO(snap);
    const cultureShield = await evalRO(`pack.cultures[${pick.otherCulture}].shield`);
    assert.equal(after.state.shield, cultureShield, "the state emblem picked up its culture's shield");
    assert.notEqual(before.state.shield, cultureShield);
    assert.equal(after.others, before.others, "other states and their burgs untouched");
    assert.equal(after.locked, before.locked, "the locked burg kept its emblem");
    assert.ok(
      after.burgs.every((b: unknown[]) => b[2] === true),
      "burg shields follow their culture"
    );
    assert.ok(
      after.provs.every((p: unknown[]) => p[2] === true),
      "province shields follow their culture"
    );
    assert.ok(
      after.provs.some((p: unknown[], k: number) => p[1] !== before.provs[k][1]),
      "province emblems regenerated"
    );

    // shieldOnly keeps the design
    await h.ok("edit", { type: "state", ops: [{ ref: S, set: { culture: pick.S2.culture } }] });
    const design = await evalRO(`JSON.stringify({ ...pack.states[${S}].coa, shield: null })`);
    await h.ok("regenerate", {
      parts: ["emblems"],
      emblems: { states: [S], provinces: false, burgs: false, shieldOnly: true }
    });
    const now = await evalRO(
      `[JSON.stringify({ ...pack.states[${S}].coa, shield: null }), pack.states[${S}].coa.shield, pack.cultures[${pick.S2.culture}].shield]`
    );
    assert.equal(now[0], design);
    assert.equal(now[1], now[2]);

    // undo the shieldOnly call: the regenerated design and its culture shield come back
    await h.ok("snapshot", { action: "undo" });
    assert.equal(await evalRO(`pack.states[${S}].coa.shield`), cultureShield);
  });
});

// ---------------------------------------------------------------- sketch replay

interface SketchPick {
  S1: { i: number; name: string; capital: number };
  farAt: { x: number; y: number };
  S2: { i: number; name: string };
  firstProvince: number;
  /** Cells of S1's first province next to its second (someone else repaints one). */
  border: { cell: number; to: number } | null;
  /** A ring-3 land patch of one state without a capital (the sketch's hand-made state). */
  patch: { at: { x: number; y: number }; cells: number[] };
}

describe("regenerate provinces/emblems in a sketch (literal replay)", () => {
  let h: Harness;
  let pick: SketchPick;
  const files = { shifted: "", renamed: "", recoa: "", repainted: "", relocked: "", stateLocked: "" };
  const evalRO = async (code: string, args?: unknown) =>
    (await h.ok("eval", { code, args, readOnly: true })).value as any;
  let sketchProvince = 0;
  let handmade = 0;
  let sketched: Obj = {};
  const SNAP = `const C = pack.cells; const live = x => x && x.i && !x.removed;
    const provsOf = sid => pack.provinces.filter(p => live(p) && p.state === sid)
      .map(p => ({ name: p.name, coa: JSON.stringify(p.coa), cells: [...C.i].filter(c => C.province[c] === p.i).join(",") }));
    const hm = pack.states.find(s => live(s) && s.name === "Wainfolk");
    return {
      provs: provsOf(args.S1),
      s2: JSON.stringify(pack.states[args.S2].coa),
      s2provs: pack.provinces.filter(p => live(p) && p.state === args.S2).map(p => JSON.stringify(p.coa)),
      hm: hm ? { coa: JSON.stringify(hm.coa), provs: provsOf(hm.i),
        burgs: pack.burgs.filter(b => live(b) && b.state === hm.i).map(b => JSON.stringify(b.coa)) } : null
    };`;

  async function otherCopy(name: string, code: string): Promise<string> {
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("eval", { code, args: pick });
    return (await h.ok("save_map", { path: `${name}.map`, overwrite: true })).path as string;
  }

  before(async () => {
    h = await startServer();
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    pick = await evalRO(`
      const C = pack.cells;
      const live = x => x && x.i && !x.removed;
      const states = pack.states.filter(live);
      const burgsOf = s => pack.burgs.filter(b => live(b) && C.state[b.cell] === s.i).length;
      const S1 = states.filter(s => burgsOf(s) >= 4).sort((a, b) => burgsOf(a) - burgsOf(b))[0];
      const cap = pack.burgs[S1.capital];
      let far = -1, fd = -1;
      for (const c of C.i) if (C.state[c] === S1.i && C.h[c] >= 20 && !C.burg[c]) {
        const d = (C.p[c][0] - cap.x) ** 2 + (C.p[c][1] - cap.y) ** 2;
        if (d > fd) { fd = d; far = c; }
      }
      const S2 = states.find(s => s.i !== S1.i);
      const [p0, p1] = S1.provinces;
      let border = null;
      for (const c of C.i) if (C.province[c] === p0 && c !== pack.provinces[p0].center && !C.burg[c] && C.c[c].some(x => C.province[x] === p1)) { border = { cell: c, to: p1 }; break; }
      const ring = (c0, r) => { let set = new Set([c0]); for (let k = 0; k < r; k++) for (const c of [...set]) for (const n of C.c[c]) set.add(n); return [...set]; };
      const capitals = new Set(states.map(s => pack.burgs[s.capital]?.cell));
      let patch = null;
      for (const c of C.i) {
        const sid = C.state[c];
        if (!sid || sid === S1.i || sid === S2.i || C.burg[c]) continue;
        const cs = ring(c, 3);
        if (cs.every(x => C.state[x] === sid && C.h[x] >= 20 && !capitals.has(x))) { patch = { at: { x: C.p[c][0], y: C.p[c][1] }, cells: cs }; break; }
      }
      return { S1: { i: S1.i, name: S1.name, capital: S1.capital }, farAt: { x: C.p[far][0], y: C.p[far][1] },
        S2: { i: S2.i, name: S2.name }, firstProvince: p0, border, patch };`);
    assert.ok(pick.border && pick.patch, JSON.stringify(pick));
    // someone else's copies: an extra (removed) state, burg and province shift every new id; a
    // renamed province of S1; S2's emblem changed; S1's provinces repainted and S2 locked
    files.shifted = await otherCopy(
      "other-shifted",
      `pack.provinces.push({ i: pack.provinces.length, removed: true });
       pack.states.push({ i: pack.states.length, removed: true });
       pack.burgs.push({ ...pack.burgs[1], i: pack.burgs.length, name: "Gone", removed: true });
       const b = pack.burgs.find(x => x && x.i && !x.removed && x.state !== args.S1.i);
       b.name = "Otherton";
       return pack.provinces.length;`
    );
    files.renamed = await otherCopy(
      "other-renamed",
      `pack.provinces[args.firstProvince].name = "Theirshire"; return 1;`
    );
    files.recoa = await otherCopy(
      "other-recoa",
      `pack.states[args.S2.i].coa = { t1: "purpure", shield: "round" }; return 1;`
    );
    files.repainted = await otherCopy(
      "other-repainted",
      `pack.cells.province[args.border.cell] = args.border.to; return 1;`
    );
    files.relocked = await otherCopy("other-relocked", `pack.states[args.S2.i].lock = true; return 1;`);
    files.stateLocked = await otherCopy("other-state-locked", `pack.states[args.S1.i].lock = true; return 1;`);
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("provinces (centres), emblems and a hand-made state's provinces are logged replayable; zones stays blob-only", async () => {
    await h.ok("sketch", { action: "start", slug: "t-regen" });
    const r = await h.ok("regenerate", {
      parts: ["provinces"],
      provinces: {
        centres: [
          { state: pick.S1.i, burg: pick.S1.capital, name: "Northmarch" },
          { state: pick.S1.i, at: pick.farAt, name: "Southmarch" }
        ]
      }
    });
    sketchProvince = ((r.provinces as Obj).list as Obj[]).find(x => x.name === "Southmarch")?.i;
    assert.ok(sketchProvince > 0);
    await h.ok("edit", { type: "province", ops: [{ ref: sketchProvince, set: { name: "Sketchshire" } }] });
    await h.ok("regenerate", { parts: ["emblems"], emblems: { states: [pick.S2.i], burgs: false } });
    // a hand-made state: add + paint (paint_cells makes provinces on the way without reporting
    // them), its emblems, then its own provinces and emblems
    const add = await h.ok("add", { type: "state", items: [{ capital: pick.patch.at, name: "Wainfolk" }] });
    handmade = (add.created as Obj[])[0].i;
    await h.ok("paint_cells", { select: { cells: pick.patch.cells }, set: { state: handmade } });
    await h.ok("regenerate", { parts: ["emblems"], emblems: { states: [handmade] } });
    await h.ok("regenerate", {
      parts: ["provinces", "emblems"],
      provinces: { states: [handmade], count: 2 },
      emblems: { states: [handmade] }
    });
    const st = await h.ok("sketch", { action: "status" });
    assert.equal(st.blobOnly, false, JSON.stringify(st.blobOnlyReasons));
    const log = st.log as Obj[];
    assert.deepEqual(
      log.map(o => o.tool),
      [REGEN_OP, "edit", REGEN_OP, "add", "paint_cells", REGEN_OP, REGEN_OP]
    );
    assert.match(
      log[0].summary,
      new RegExp(
        `^Replaced \\d+ provinces? of ${pick.S1.name} \\(${pick.S1.i}\\) with 2 new \\(Northmarch, Southmarch\\)\\.$`
      )
    );
    assert.match(log[2].summary, /^New emblems for 1 state, \d+ provinces? and 0 burgs\.$/);
    assert.match(
      log[6].summary,
      /^Replaced \d+ provinces? of Wainfolk \(\d+\) with 2 new .*; new emblems for 1 state, 2 provinces and 1 burg\.$/
    );
    const full = await h.ok("sketch", { action: "status", full: true });
    const rec = (full.records as Obj[])[0].resolved;
    assert.match(String(rec.graph), /^\d+:\w+$/);
    assert.equal(rec.provinces.created.length, 2);
    assert.ok(Array.isArray(rec.provinces.created[0].runs));
    assert.equal(typeof rec.provinces.replaced[0].cells, "string", "replaced rows carry a cell hash");
    sketched = await evalRO(SNAP, { S1: pick.S1.i, S2: pick.S2.i });
    assert.equal(sketched.hm.provs.length, 2);

    // the summary frames a regen sketch (no screenshots here)
    const sum = await h.ok("sketch", { action: "summary", shots: false });
    assert.equal((sum.framedOn as Obj)?.type, "state");

    // a non-literal part makes the sketch blob-only; undo takes it out again
    await h.ok("regenerate", { parts: ["zones"] }, 240_000);
    const blob = await h.ok("sketch", { action: "status" });
    assert.equal(blob.blobOnly, true);
    assert.match(JSON.stringify(blob.blobOnlyReasons), /regenerate/);
    await h.ok("snapshot", { action: "undo" });
    // provinces mixed with another part: a plain regenerate, not replayable, with the reason
    await h.ok("regenerate", { parts: ["provinces", "zones"], provinces: { states: [handmade] } }, 240_000);
    const mixed = await h.ok("sketch", { action: "status" });
    assert.match(
      JSON.stringify(mixed.blobOnlyReasons),
      /regenerate zones re-runs random generators.*only parts provinces/
    );
    await h.ok("snapshot", { action: "undo" });
    assert.equal((await h.ok("sketch", { action: "status" })).blobOnly, false);
  });

  test("rebase onto a copy with shifted state/burg/province ids: same provinces, cells and emblems; the hand-made state too", async () => {
    const r = await h.ok("sketch", { action: "rebase", onto: { path: files.shifted } }, 240_000);
    assert.equal(r.completed, true, JSON.stringify(r.conflicts));
    assert.deepEqual(r.applied, [1, 2, 3, 4, 5, 6, 7]);
    const idMap = r.idMap as Record<string, Record<string, number>>;
    const mapped = idMap.province[String(sketchProvince)];
    assert.equal(mapped, sketchProvince + 1, JSON.stringify(idMap));
    assert.equal(idMap.state[String(handmade)], handmade + 1);
    const now = await evalRO(SNAP, { S1: pick.S1.i, S2: pick.S2.i });
    assert.deepEqual(now.provs, sketched.provs);
    assert.equal(now.s2, sketched.s2);
    assert.deepEqual(now.s2provs, sketched.s2provs);
    assert.deepEqual(now.hm, sketched.hm, "the hand-made state's provinces and emblems replay");
    const extra = await evalRO(
      `[pack.burgs.filter(b => b && b.name === "Otherton").length, pack.provinces[${mapped}].name]`
    );
    assert.deepEqual(extra, [1, "Sketchshire"], "their edit survives; the edit follows the new id");
  });

  test("conflicts: a province someone else renamed or repainted, a state locked since, an emblem both changed", async () => {
    // onConflict 'stop' leaves the sketch as it was; 'skip' (last) drops the conflicting ops
    const conflictOf = async (file: string) => {
      const r = await h.ok("sketch", { action: "rebase", onto: { path: file } }, 240_000);
      assert.equal(r.completed, false, JSON.stringify(r).slice(0, 500));
      return (r.conflicts as Obj[])[0];
    };
    const renamed = await conflictOf(files.renamed);
    assert.equal(renamed.seq, 1);
    assert.match(renamed.reason, /was changed since by someone else \(name .*Theirshire/);
    const repainted = await conflictOf(files.repainted);
    assert.equal(repainted.seq, 1);
    assert.match(repainted.reason, /changed since by someone else \(its cells\)/);
    const relocked = await conflictOf(files.relocked);
    assert.equal(relocked.seq, 3);
    assert.match(relocked.reason, /state '.*' \(\d+\) was locked since; the sketch regenerated its emblem/);
    const stateLocked = await conflictOf(files.stateLocked);
    assert.equal(stateLocked.seq, 1);
    assert.match(
      stateLocked.reason,
      new RegExp(`${pick.S1.name} \\(${pick.S1.i}\\) was locked since; the sketch regenerated its provinces`)
    );
    const r2 = await h.ok("sketch", { action: "rebase", onto: { path: files.recoa }, onConflict: "skip" }, 240_000);
    assert.deepEqual(r2.applied, [1, 2, 4, 5, 6, 7]);
    assert.equal((r2.conflicts as Obj[])[0].seq, 3);
    assert.match((r2.conflicts as Obj[])[0].reason, /both changed the emblem of state/);
  });
});
