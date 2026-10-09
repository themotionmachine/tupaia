// regenerate provinces / emblems for hand-made states (track 'regen'): scoped, lock-aware
// provinces (auto, count and explicit centres, including states with few or no burgs), emblems
// with the culture's shield, undo, and the literal outcome replaying in a sketch rebase.
// Runs against tests/fixtures/demo.map with the safe test env (no live origin).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { blobOnlyReasons, Rewriter, sanitizeRecord, unreplayableReason } from "../src/ops.ts";
import { regenCreated, regenRewrite, regenSummary, regenUnreplayable } from "../src/regen.ts";
import { alive, errorBody, type Harness, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

// ---------------------------------------------------------------- pure (no browser)

describe("regen replay spec (pure)", () => {
  const literal = {
    parts: ["provinces", "emblems"],
    graph: "7462:abc",
    provinces: {
      states: [2, 30],
      keepLocked: true,
      kept: [5],
      replaced: [
        { i: 4, state: 2, name: "Old", burg: 9 },
        { i: 200, state: 30, name: "Fresh", burg: 0 }
      ],
      created: [
        { i: 210, state: 2, center: 11, burg: 9, name: "A", coa: { t1: "or" }, runs: [11, 3] },
        { i: 211, state: 30, center: 40, burg: 800, name: "B", coa: { t1: "azure" }, runs: [40, 2] }
      ]
    },
    emblems: { states: [{ i: 30, was: "h", coa: {} }], provinces: [{ i: 7, was: "h", coa: {} }], burgs: [] }
  };

  test("only the literal provinces/emblems forms are replayable", () => {
    assert.equal(regenUnreplayable(literal as never), null);
    assert.equal(unreplayableReason("regenerate", literal as never), null, "registered through REPLAY_EXT");
    assert.match(String(regenUnreplayable(null)), /reseeds Math.random/);
    assert.match(String(unreplayableReason("regenerate", { parts: ["zones"] } as never)), /regenerate zones re-runs/);
    assert.match(String(regenUnreplayable({ parts: ["provinces", "routes"] } as never)), /routes/);
    assert.match(String(regenUnreplayable({ parts: ["provinces"] } as never)), /incomplete/);
    assert.match(String(regenUnreplayable({ type: "burg", ops: [] } as never)), /regenerate/);
  });

  test("saved records: a literal regenerate stays replayable, a zones one does not", () => {
    const ok = sanitizeRecord({ seq: 2, tool: "regenerate", args: { parts: ["provinces"] }, resolved: literal }, 0);
    assert.equal(ok.replayable, true);
    assert.match(ok.summary, /provinces of 2 states: 2 new replace 2, 1 locked kept/);
    assert.match(ok.summary, /emblems of 1 states, 1 provinces, 0 burgs/);
    const zones = sanitizeRecord({ tool: "regenerate", args: { parts: ["zones"] }, resolved: { parts: ["zones"] } }, 0);
    assert.equal(zones.replayable, false);
    assert.equal(zones.resolved, null);
    assert.match(zones.summary, /^Regenerated zones\. \(not replayable: regenerate zones/);
    assert.match(blobOnlyReasons({ blockers: [], ops: [zones] } as never)[0], /op 1 \(regenerate\)/);
  });

  test("rewrite maps sketch-created ids and flags fresh rows; created lists the new provinces", () => {
    const rw = new Rewriter(
      { state: { "30": 31 }, burg: { "800": 805 }, province: { "200": 207 } },
      new Set(["state:30", "burg:800", "province:200"])
    );
    const r = regenRewrite(structuredClone(literal) as never, rw) as unknown as Obj;
    assert.deepEqual(r.provinces.states, [2, 31]);
    assert.deepEqual(
      r.provinces.replaced.map((x: Obj) => [x.i, x.state, x.fresh ?? false]),
      [
        [4, 2, false],
        [207, 31, true]
      ]
    );
    assert.deepEqual(
      r.provinces.created.map((d: Obj) => [d.i, d.state, d.burg]),
      [
        [210, 2, 9],
        [211, 31, 805]
      ]
    );
    assert.equal(r.emblems.states[0].i, 31);
    assert.equal(r.emblems.states[0].fresh, true);
    assert.equal(r.emblems.provinces[0].fresh, undefined);
    assert.deepEqual(regenCreated(literal as never), [
      [
        { type: "province", i: 210 },
        { type: "province", i: 211 }
      ]
    ]);
    assert.deepEqual(regenCreated({ parts: ["emblems"], emblems: {} } as never), []);
    assert.equal(regenSummary(null, null, { parts: ["zones", "routes"] }), "Regenerated zones, routes.");
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
return {
  S1: { i: S1.i, name: S1.name, capital: S1.capital, burgs: burgsOf(S1).length, culture: S1.culture },
  farAt: { x: C.p[far][0], y: C.p[far][1], cell: far },
  S2: { i: S2.i, name: S2.name, culture: S2.culture },
  otherCulture,
  B: { i: B.i, name: B.name },
  patch: { at: { x: C.p[p1.center][0], y: C.p[p1.center][1] }, cells: p1.cells },
  patch2: p2
};`;

/** Page-side checks of a state's provinces: coverage, ownership, shields. */
const STATE_CHECK = `
const C = pack.cells;
const sid = args.sid;
const live = x => x && x.i && !x.removed;
const s = pack.states[sid];
const provs = pack.provinces.filter(p => live(p) && p.state === sid);
const land = [...C.i].filter(c => C.state[c] === sid && C.h[c] >= 20);
const uncovered = land.filter(c => !C.province[c]).length;
const foreign = land.filter(c => C.province[c] && pack.provinces[C.province[c]].state !== sid).length;
const cult = p => (p.burg && live(pack.burgs[p.burg]) ? pack.burgs[p.burg].culture : C.culture[p.center]);
const badShield = provs.filter(p => p.coa.shield !== COA.getShield(cult(p), sid)).map(p => p.i);
const cellsOf = id => [...C.i].filter(c => C.province[c] === id);
return {
  provinces: provs.map(p => ({ i: p.i, name: p.name, fullName: p.fullName, formName: p.formName, burg: p.burg, center: p.center, cells: cellsOf(p.i).length, pole: !!p.pole })),
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

  test("dryRun shows the plan and changes nothing", async () => {
    const depth = await undoDepth();
    const r = await h.ok("regenerate", {
      parts: ["emblems", "provinces"],
      provinces: { states: [pick.S1.name], count: 3 },
      emblems: { states: [pick.S2.i], burgs: false },
      dryRun: true
    });
    assert.equal(r.dryRun, true);
    assert.deepEqual(r.parts, ["provinces", "emblems"], "dependency order");
    const st = (r.provinces as Obj).states as Obj[];
    assert.deepEqual(
      st.map(s => [s.i, s.mode, s.count]),
      [[pick.S1.i, "count", 3]]
    );
    assert.equal((r.emblems as Obj).states.regenerate, 1);
    assert.equal((r.emblems as Obj).burgs.regenerate, 0);
    assert.equal(await undoDepth(), depth);
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
    assert.equal(await evalRO(OUTSIDE_HASH, { sids: [handmade, pick.B.i] }), outside, "other provinces untouched");
    // the new provinces are drawn when the layer is shown later; nothing was turned on
    assert.deepEqual((r.layerChanges as Obj).turnedOn, []);
  });

  test("a state with no burgs at all gets wild provinces (auto)", async () => {
    // a builder-style state made by eval: no capital burg, cells painted directly
    const sid = await h.ok("eval", {
      args: { cells: pick.patch2.cells, center: pick.patch2.center, from: pick.patch2.state },
      code: `
        const C = pack.cells;
        const i = pack.states.length;
        const culture = C.culture[args.center];
        pack.states.push({ i, name: "Burgless", color: "#335577", capital: 0, center: args.center, culture,
          type: "Generic", form: "Monarchy", formName: "Kingdom", fullName: "Kingdom of Burgless", expansionism: 1,
          provinces: [], diplomacy: [], neighbors: [], military: [], alert: 1,
          coa: COA.generate(null, null, null, pack.cultures[culture].type) });
        for (const c of args.cells) C.state[c] = i;
        return i;`
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
    assert.ok(north.cells > 0 && south.cells > 0);
    assert.deepEqual(chk.badShield, []);
    assert.equal(await evalRO(OUTSIDE_HASH, { sids: [pick.S1.i] }), outside);
  });

  test("count: that many provinces per state, on burgs where there are some, places elsewhere", async () => {
    const want = pick.S1.burgs + 2;
    const r = await h.ok("regenerate", { parts: ["provinces"], provinces: { states: [pick.S1.i], count: want } });
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

  test("keepLocked: a locked province keeps its id and cells; a locked state is refused unless keepLocked:false", async () => {
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
    assert.match(errorBody(refused).error.message, /locked/);
    assert.equal(await undoDepth(), depth, "a refused call takes no undo entry");
    // the default set skips the locked state
    const dry = await h.ok("regenerate", { parts: ["provinces"], dryRun: true });
    assert.ok(!((dry.provinces as Obj).states as Obj[]).some(s => s.i === pick.S1.i));
    const forced = await h.ok("regenerate", {
      parts: ["provinces"],
      provinces: { states: [pick.S1.i], count: 2, keepLocked: false }
    });
    assert.equal((forced.provinces as Obj).replaced, 4, "the locked province is replaced too");
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
      return {
        state: pack.states[${S}].coa,
        others: __tupaia.pure.hashStr(JSON.stringify(pack.states.filter(s => live(s) && s.i !== ${S}).map(h).concat(pack.burgs.filter(b => live(b) && b.state !== ${S}).map(h)))),
        locked: h(pack.burgs[${lockedBurg}]),
        burgs: pack.burgs.filter(b => live(b) && b.state === ${S} && b.i !== ${lockedBurg}).map(b => [b.i, h(b), b.coa.shield === COA.getShield(b.culture, ${S})]),
        provs: pack.provinces.filter(p => live(p) && p.state === ${S}).map(p => {
          const pc = p.burg && live(pack.burgs[p.burg]) ? pack.burgs[p.burg].culture : pack.cells.culture[p.center];
          return [p.i, h(p), p.coa.shield === COA.getShield(pc, ${S})];
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
}

describe("regenerate provinces/emblems in a sketch (literal replay)", () => {
  let h: Harness;
  let pick: SketchPick;
  const files = { shifted: "", renamed: "", recoa: "" };
  const evalRO = async (code: string, args?: unknown) =>
    (await h.ok("eval", { code, args, readOnly: true })).value as any;
  let sketchProvince = 0;
  let sketched: Obj = {};

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
      return { S1: { i: S1.i, name: S1.name, capital: S1.capital }, farAt: { x: C.p[far][0], y: C.p[far][1] },
        S2: { i: S2.i, name: S2.name }, firstProvince: S1.provinces[0] };`);
    // someone else's copies: an extra (removed) province shifts every new province id; a
    // renamed province of S1; S2's emblem changed
    files.shifted = await otherCopy(
      "other-shifted",
      `pack.provinces.push({ i: pack.provinces.length, removed: true });
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
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("regenerate provinces (centres) and emblems are logged replayable; zones stays blob-only", async () => {
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
    const st = await h.ok("sketch", { action: "status" });
    assert.equal(st.blobOnly, false, JSON.stringify(st.blobOnlyReasons));
    const log = st.log as Obj[];
    assert.deepEqual(
      log.map(o => o.tool),
      ["regenerate", "edit", "regenerate"]
    );
    assert.match(log[0].summary, /Regenerated provinces of 1 state: 2 new replace \d+/);
    assert.match(log[2].summary, /emblems of 1 states, \d+ provinces, 0 burgs/);
    const full = await h.ok("sketch", { action: "status", full: true });
    const rec = (full.records as Obj[])[0].resolved;
    assert.match(String(rec.graph), /^\d+:\w+$/);
    assert.equal(rec.provinces.created.length, 2);
    assert.ok(Array.isArray(rec.provinces.created[0].runs));
    sketched = await evalRO(
      `const C = pack.cells; const live = x => x && x.i && !x.removed;
       const provs = pack.provinces.filter(p => live(p) && p.state === ${pick.S1.i});
       return {
         provs: provs.map(p => ({ name: p.name, coa: JSON.stringify(p.coa), cells: [...C.i].filter(c => C.province[c] === p.i).join(",") })),
         s2: JSON.stringify(pack.states[${pick.S2.i}].coa),
         s2provs: pack.provinces.filter(p => live(p) && p.state === ${pick.S2.i}).map(p => JSON.stringify(p.coa))
       };`
    );

    // a non-literal part makes the sketch blob-only; undo takes it out again
    await h.ok("regenerate", { parts: ["zones"] }, 240_000);
    const blob = await h.ok("sketch", { action: "status" });
    assert.equal(blob.blobOnly, true);
    assert.match(JSON.stringify(blob.blobOnlyReasons), /regenerate zones re-runs random generators/);
    await h.ok("snapshot", { action: "undo" });
    assert.equal((await h.ok("sketch", { action: "status" })).blobOnly, false);
  });

  test("rebase onto a copy with shifted province ids: same provinces, cells and emblems; the edit follows the new id", async () => {
    const r = await h.ok("sketch", { action: "rebase", onto: { path: files.shifted } }, 240_000);
    assert.equal(r.completed, true, JSON.stringify(r.conflicts));
    assert.deepEqual(r.applied, [1, 2, 3]);
    const idMap = r.idMap as Record<string, Record<string, number>>;
    const mapped = idMap.province[String(sketchProvince)];
    assert.equal(mapped, sketchProvince + 1, JSON.stringify(idMap));
    const now = await evalRO(
      `const C = pack.cells; const live = x => x && x.i && !x.removed;
       const provs = pack.provinces.filter(p => live(p) && p.state === ${pick.S1.i});
       return {
         provs: provs.map(p => ({ name: p.name, coa: JSON.stringify(p.coa), cells: [...C.i].filter(c => C.province[c] === p.i).join(",") })),
         s2: JSON.stringify(pack.states[${pick.S2.i}].coa),
         s2provs: pack.provinces.filter(p => live(p) && p.state === ${pick.S2.i}).map(p => JSON.stringify(p.coa)),
         theirs: pack.burgs.filter(b => b && b.name === "Otherton").length,
         named: pack.provinces[${mapped}].name
       };`
    );
    assert.deepEqual(now.provs, sketched.provs);
    assert.equal(now.s2, sketched.s2);
    assert.deepEqual(now.s2provs, sketched.s2provs);
    assert.equal(now.theirs, 1, "their edit survives");
    assert.equal(now.named, "Sketchshire");
  });

  test("conflicts: a province someone else renamed, an emblem both changed", async () => {
    const r = await h.ok("sketch", { action: "rebase", onto: { path: files.renamed } }, 240_000);
    assert.equal(r.completed, false);
    const c = (r.conflicts as Obj[])[0];
    assert.equal(c.seq, 1);
    assert.match(c.reason, /was changed since by someone else \(name .*Theirshire/);
    const r2 = await h.ok("sketch", { action: "rebase", onto: { path: files.recoa }, onConflict: "skip" }, 240_000);
    assert.deepEqual(r2.applied, [1, 2]);
    assert.equal((r2.conflicts as Obj[])[0].seq, 3);
    assert.match((r2.conflicts as Obj[])[0].reason, /both changed the emblem of state/);
  });
});
