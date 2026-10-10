// territory regrow (bridge-ext territory.js): borders redrawn along the terrain by a cost-based
// spread from each entity's cores, each to about its current area.
//   - regenerate provinces {regrow:true}: every province keeps its id, name, capital, centre and
//     emblem and about its size (within 15%), only inside its state; dryRun, refusals, locks,
//     undo; a province layout drawn by a script (straight stripes) settles along the terrain;
//   - the sketch log holds the literal cells and a rebase replays them; someone else's repaint or
//     lock since is a conflict; state borders moved since leave no province cell outside its state;
//   - regrid {territories:'regrow'} versus 'copy' on demo.map (density 20000: 13K cells): borders
//     no longer follow the old cells' steps, along dear edges, no longer and in no more pieces or
//     slivers than the copy; every burg keeps its state and culture, every capital stays inside;
//     a locked state keeps its copied cells, provinces, cultures and religions; where state,
//     culture and religion borders coincide (the fork's maps) they stay together.
// Local runs on tests/fixtures/demo.map only (no live origin).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { NOT_REPLAYABLE, Rewriter, sanitizeRecord, unreplayableReason } from "../src/ops.ts";
import { REGEN_OP, RegenProvinces, regenCreated, regenRewrite, regenSummary, regenUnreplayable } from "../src/regen.ts";
import { alive, errorBody, type Harness, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

describe("territory regrow: literal replay spec (no browser)", () => {
  const literal = {
    parts: ["provinces"],
    graph: "7462:abc",
    provinces: {
      mode: "regrow",
      band: 4,
      states: [2],
      names: ["Gazd"],
      keepLocked: true,
      kept: [],
      replaced: [],
      created: [],
      regrown: [
        { i: 4, state: 2, name: "Old", center: 10, was: "h1", n: 3, runs: [10, 3] },
        { i: 210, state: 2, name: "Sketch", center: 40, was: "h2", n: 2, runs: [40, 2] },
        { i: 300, state: 30, name: "Painted", center: 50, was: "h3", n: 1, runs: [50, 1] }
      ]
    }
  };

  test("the regrow literal is replayable, with a plain summary; without its rows it is incomplete", () => {
    assert.equal(regenUnreplayable(literal as never), null);
    assert.equal(unreplayableReason(REGEN_OP, literal as never), null);
    assert.equal(unreplayableReason("regenerate", literal as never), NOT_REPLAYABLE.regenerate);
    const torn = structuredClone(literal) as Obj;
    delete torn.provinces.regrown;
    assert.match(String(regenUnreplayable(torn as never)), /incomplete/);
    const one = structuredClone(literal) as Obj;
    one.provinces.regrown = one.provinces.regrown.slice(0, 2);
    assert.equal(
      regenSummary(one as never, null),
      "Regrew 2 provinces of Gazd (2) along the terrain (ids, capitals and about their sizes kept)."
    );
    const rec = sanitizeRecord({ seq: 1, tool: REGEN_OP, args: { parts: ["provinces"] }, resolved: one }, 0);
    assert.equal(rec.replayable, true);
    assert.match(rec.summary, /^Regrew 2 provinces of Gazd \(2\)/);
    assert.deepEqual(regenCreated(literal as never), [[]], "a regrow creates no ids");
  });

  test("rewrite: ids mapped; a province the sketch made is fresh, one of a state it made is located", () => {
    const rw = new Rewriter({ state: { "30": 31 }, province: { "210": 212 } }, new Set(["province:210", "state:30"]));
    const r = regenRewrite(structuredClone(literal) as never, rw) as unknown as Obj;
    assert.deepEqual(
      r.provinces.regrown.map((x: Obj) => [x.i, x.state, x.fresh ?? false, x.locate ?? false]),
      [
        [4, 2, false, false],
        [212, 2, true, false],
        [300, 31, false, true]
      ]
    );
  });

  test("schema: regrow is a boolean; band 1..50", () => {
    assert.equal(RegenProvinces.safeParse({ regrow: true, band: 6 }).success, true);
    assert.equal(RegenProvinces.safeParse({ regrow: true, band: 0 }).success, false);
    assert.equal(RegenProvinces.safeParse({ regrow: true, band: 51 }).success, false);
    assert.equal(RegenProvinces.safeParse({ regrow: "yes" }).success, false);
  });
});

/** Every live province with its cells (land), and whether its centre and capital are inside. */
const PROVS = `const C = pack.cells, live = x => x && x.i && !x.removed;
const n = new Map(); let outside = 0;
for (const c of C.i) {
  const p = C.province[c];
  if (!p || C.h[c] < 20) continue;
  n.set(p, (n.get(p) || 0) + 1);
  if (pack.provinces[p] && C.state[c] !== pack.provinces[p].state) outside++;
}
const burgs = pack.burgs.filter(live).map(b => b.i + ":" + C.province[b.cell]).join(",");
return { outside, burgs, provs: pack.provinces.filter(live).map(p => ({ i: p.i, name: p.name, state: p.state,
  center: p.center, burg: p.burg || 0, coa: JSON.stringify(p.coa ?? null), n: n.get(p.i) || 0,
  centreIn: C.province[p.center] === p.i, capitalIn: !p.burg || C.province[pack.burgs[p.burg].cell] === p.i })) };`;

/** The province cells of one state, as one string (cell:province). */
const CELLS_OF = `const C = pack.cells; const out = [];
for (const c of C.i) if (C.state[c] === args.sid && C.h[c] >= 20) out.push(c + ":" + C.province[c]);
return out.join(",");`;

/** Province borders inside one state: edges, and the mean cost of the edges they cut. */
const PROV_BORDERS = `const C = pack.cells, k = __tupaia.territory.makeCost("province");
let e = 0, cost = 0;
for (const c of C.i) {
  if (C.h[c] < 20 || C.state[c] !== args.sid) continue;
  for (const j of C.c[c]) {
    if (j < c || C.h[j] < 20 || C.state[j] !== args.sid || C.province[j] === C.province[c]) continue;
    e++; cost += (k(c, j, -1) + k(j, c, -1)) / 2;
  }
}
return { edges: e, cost: cost / e };`;

/** Repaint the provinces of one state as vertical stripes (as a script might), centres and capitals kept. */
const STRIPES = `const C = pack.cells, live = x => x && x.i && !x.removed;
const provs = pack.provinces.filter(p => live(p) && p.state === args.sid).sort((a, b) => C.p[a.center][0] - C.p[b.center][0]);
const xs = provs.map(p => C.p[p.center][0]);
const cut = xs.slice(1).map((x, k) => (x + xs[k]) / 2);
for (const c of C.i) {
  if (C.state[c] !== args.sid || C.h[c] < 20) continue;
  let k = 0; while (k < cut.length && C.p[c][0] > cut[k]) k++;
  C.province[c] = provs[k].i;
}
for (const p of provs) { C.province[p.center] = p.i; if (p.burg) C.province[pack.burgs[p.burg].cell] = p.i; }
return provs.length;`;

const within = (before: number, after: number, pct: number) => Math.abs(after - before) <= (pct / 100) * before;

describe("regenerate provinces {regrow:true} on demo.map", () => {
  let h: Harness;
  let base: Obj;
  let S = 0;
  const read = async (code: string, args: Obj = {}): Promise<any> =>
    (await h.ok("eval", { code, args, readOnly: true })).value;
  const undoDepth = async () => ((await h.ok("snapshot", { action: "list" })).undo as unknown[]).length;
  const digest = () => read("return __tupaia.fns.digest().hash");
  const refused = async (args: Obj) => {
    const r = await h.call("regenerate", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    return errorBody(r).error as Obj;
  };

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "20" });
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    base = await read(PROVS);
    // the state with the most provinces
    S = await read(`const live = x => x && x.i && !x.removed, k = new Map();
      for (const p of pack.provinces) if (live(p)) k.set(p.state, (k.get(p.state) || 0) + 1);
      return [...k].sort((a, b) => b[1] - a[1])[0][0];`);
    assert.equal(base.outside, 0, "fixture: province cells inside their states");
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("dryRun previews the sizes in the real result's shape and changes nothing", async () => {
    const depth = await undoDepth();
    const d0 = await digest();
    const r = await h.ok("regenerate", { parts: ["provinces"], provinces: { regrow: true }, dryRun: true });
    const p = r.provinces as Obj;
    assert.equal(p.mode, "regrow");
    assert.equal(p.band, 4);
    assert.equal(p.regrown, base.provs.length, "every province of the default states");
    assert.ok(p.changedCells > 0);
    const [ok, all] = String(p.within15pct).split("/").map(Number);
    assert.ok(all > 100 && ok / all >= 0.97, `within 15%: ${p.within15pct}`);
    assert.ok(Array.isArray(p.sizes) && p.sizes.every((x: unknown) => Array.isArray(x) && x.length === 3));
    assert.equal(await undoDepth(), depth);
    assert.equal(await digest(), d0, "nothing changed");
  });

  test("apply: ids, names, centres, capitals and emblems kept; sizes within 15%; inside their states; one undo", async () => {
    const d0 = await digest();
    const r = await h.ok("regenerate", { parts: ["provinces"], provinces: { regrow: true } });
    const p = r.provinces as Obj;
    const now = await read(PROVS);
    assert.equal(now.outside, 0, "every province cell is inside its province's state");
    assert.equal(now.burgs, base.burgs, "every burg keeps its province");
    const was = new Map((base.provs as Obj[]).map(x => [x.i, x]));
    let big = 0;
    let off = 0;
    for (const x of now.provs as Obj[]) {
      const b = was.get(x.i);
      assert.ok(b, `province ${x.i} is not new`);
      assert.deepEqual(
        [x.name, x.state, x.center, x.burg, x.coa],
        [b.name, b.state, b.center, b.burg, b.coa],
        `province ${x.i} kept`
      );
      if (b.centreIn) assert.ok(x.centreIn, `province ${x.i}: centre inside`);
      if (b.capitalIn) assert.ok(x.capitalIn, `province ${x.i}: capital inside`);
      if (b.n >= 20) {
        big++;
        if (!within(b.n, x.n, 15)) off++;
      }
    }
    assert.equal(now.provs.length, base.provs.length);
    assert.ok(big > 20, `provinces of 20+ cells: ${big}`);
    assert.equal(off, 0, "every province of 20+ cells within 15%");
    const changed = (now.provs as Obj[]).filter(x => x.n !== was.get(x.i)?.n).length;
    assert.ok(p.changedCells > 0 && changed > 0);
    await h.ok("snapshot", { action: "undo" });
    assert.equal(await digest(), d0, "one undo restores the map");
  });

  test("a scripted layout (straight stripes) settles along the terrain: fewer, dearer borders; same sizes", async () => {
    await h.ok("eval", { code: STRIPES, args: { sid: S } });
    const striped = await read(PROVS);
    const b0 = await read(PROV_BORDERS, { sid: S });
    const r = await h.ok("regenerate", { parts: ["provinces"], provinces: { regrow: true, states: [S] } });
    const p = r.provinces as Obj;
    assert.equal(p.states.length, 1);
    assert.equal(p.states[0].i, S);
    const b1 = await read(PROV_BORDERS, { sid: S });
    assert.ok(b1.edges < 0.95 * b0.edges, `border edges ${b0.edges} -> ${b1.edges}`);
    assert.ok(b1.cost >= 0.98 * b0.cost, `mean cost of the cut edges ${b0.cost} -> ${b1.cost}`);
    const now = await read(PROVS);
    const was = new Map((striped.provs as Obj[]).map(x => [x.i, x]));
    for (const x of now.provs as Obj[]) {
      const n0 = was.get(x.i)?.n ?? 0;
      if (x.state === S && n0 >= 8) assert.ok(within(n0, x.n, 15), `province ${x.i}: ${n0} -> ${x.n}`);
    }
    assert.equal(now.burgs, striped.burgs, "burgs keep their provinces");
    assert.equal(now.outside, 0);
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
  });

  test("bad options are refused before any change", async () => {
    const depth = await undoDepth();
    const cases: Array<[Obj, RegExp]> = [
      [{ regrow: true, count: 3 }, /regrow keeps the existing provinces; count is for new ones/],
      [{ regrow: true, centres: [] }, /centres/],
      [{ regrow: true, crossForeign: true }, /crossForeign/],
      [{ band: 4 }, /needs regrow:true/]
    ];
    for (const [provinces, re] of cases) {
      const e = await refused({ parts: ["provinces"], provinces });
      assert.equal(e.code, "BAD_ARGS", JSON.stringify(provinces));
      assert.match(e.message, re);
    }
    const zod = await h.call("regenerate", { parts: ["provinces"], provinces: { regrow: true, band: 0 } });
    assert.equal(zod.isError, true);
    assert.equal(await undoDepth(), depth, "refusals take no undo entry");
  });

  test("locks: a locked province keeps its cells; a locked state is skipped by default, refused when named", async () => {
    const live = (base.provs as Obj[]).filter(x => x.state === S && x.n >= 10);
    const locked = live[0].i;
    await h.ok("edit", { type: "province", ops: [{ ref: locked, set: { lock: true } }] });
    const cellsOf = `[...pack.cells.i].filter(c => pack.cells.province[c] === ${locked}).join(",")`;
    const before0 = await read(`return ${cellsOf}`);
    const r = await h.ok("regenerate", { parts: ["provinces"], provinces: { regrow: true, states: [S] } });
    assert.equal((r.provinces as Obj).keptLocked, 1);
    assert.equal(await read(`return ${cellsOf}`), before0, "the locked province keeps its cells");
    await h.ok("snapshot", { action: "undo" });

    await h.ok("edit", { type: "state", ops: [{ ref: S, set: { lock: true } }] });
    const cells = await read(CELLS_OF, { sid: S });
    const e = await refused({ parts: ["provinces"], provinces: { regrow: true, states: [S] } });
    assert.equal(e.code, "REFUSED");
    assert.match(e.message, /is locked: pass lockedStates:true/);
    const dry = await h.ok("regenerate", { parts: ["provinces"], provinces: { regrow: true }, dryRun: true });
    assert.ok(!((dry.provinces as Obj).states as Obj[]).some(s => s.i === S), "the default skips it");
    await h.ok("regenerate", { parts: ["provinces"], provinces: { regrow: true } });
    assert.equal(await read(CELLS_OF, { sid: S }), cells, "the locked state's provinces did not move");
    // every state locked: the regrow default has nothing to do, and says why
    await h.ok("eval", { code: "for (const s of pack.states) if (s && s.i && !s.removed) s.lock = true; return 1" });
    const none = await refused({ parts: ["provinces"], provinces: { regrow: true } });
    assert.match(
      none.message,
      /no unlocked state has provinces to regrow \(lockedStates:true includes the locked ones\)/
    );
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
  });
});

describe("regenerate provinces {regrow:true} in a sketch (literal replay)", () => {
  let h: Harness;
  let S = 0;
  let pick: Obj;
  let sketched = "";
  const files = { shifted: "", repainted: "", locked: "", moved: "" };
  const read = async (code: string, args: Obj = {}): Promise<any> =>
    (await h.ok("eval", { code, args, readOnly: true })).value;

  async function otherCopy(name: string, code: string): Promise<string> {
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("eval", { code, args: { S, ...pick } });
    return (await h.ok("save_map", { path: `${name}.map`, overwrite: true })).path as string;
  }

  before(async () => {
    h = await startServer();
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    S = await read(`const live = x => x && x.i && !x.removed, k = new Map();
      for (const p of pack.provinces) if (live(p)) k.set(p.state, (k.get(p.state) || 0) + 1);
      return [...k].sort((a, b) => b[1] - a[1])[0][0];`);
    pick = await read(
      `const C = pack.cells, ps = pack.provinces.filter(p => p && p.i && !p.removed && p.state === args.S);
       for (const c of C.i) {
         const p = C.province[c];
         if (C.state[c] !== args.S || C.burg[c] || ps.some(x => x.center === c)) continue;
         const j = C.c[c].find(j => C.state[j] === args.S && C.province[j] && C.province[j] !== p);
         if (j !== undefined) return { cell: c, to: C.province[j] };
       }
       return null;`,
      { S }
    );
    assert.ok(pick, "a province border cell inside the state");
    files.shifted = await otherCopy(
      "terr-shifted",
      `pack.provinces.push({ i: pack.provinces.length, removed: true });
       pack.states.push({ i: pack.states.length, removed: true });
       const b = pack.burgs.find(x => x && x.i && !x.removed && x.state !== args.S);
       b.name = "Otherton"; return 1;`
    );
    files.repainted = await otherCopy("terr-repainted", `pack.cells.province[args.cell] = args.to; return 1;`);
    files.locked = await otherCopy("terr-locked", `pack.states[args.S].lock = true; return 1;`);
    // state borders moved since (cells.state only; their province ids left as they were)
    files.moved = await otherCopy(
      "terr-moved",
      `const C = pack.cells, centre = c => pack.provinces.some(p => p && p.center === c);
       let out = 0, into = 0;
       for (const c of C.i) {
         if (C.h[c] < 20 || C.burg[c] || centre(c)) continue;
         const j = C.c[c].find(j => C.h[j] >= 20 && C.state[j] && C.state[j] !== C.state[c] && (C.state[c] === args.S || C.state[j] === args.S));
         if (j === undefined) continue;
         if (C.state[c] === args.S && out < 6) { C.state[c] = C.state[j]; out++; }
         else if (C.state[j] === args.S && C.state[c] && into < 6) { C.state[c] = args.S; into++; }
       }
       return out + into;`
    );
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("logged replayable as literal cells, with the summary", async () => {
    await h.ok("sketch", { action: "start", slug: "t-territory" });
    const r = await h.ok("regenerate", { parts: ["provinces"], provinces: { regrow: true, states: [S] } });
    assert.ok((r.provinces as Obj).changedCells > 0);
    sketched = await read(CELLS_OF, { sid: S });
    const st = await h.ok("sketch", { action: "status" });
    assert.equal(st.blobOnly, false, JSON.stringify(st.blobOnlyReasons));
    const log = st.log as Obj[];
    assert.deepEqual(
      log.map(o => o.tool),
      [REGEN_OP]
    );
    assert.match(log[0].summary, /^Regrew \d+ provinces of .* \(\d+\) along the terrain \(ids, capitals and about/);
    const full = await h.ok("sketch", { action: "status", full: true });
    const p = (full.records as Obj[])[0].resolved.provinces;
    assert.equal(p.mode, "regrow");
    assert.deepEqual(p.states, [S]);
    assert.ok(p.regrown.length > 3);
    for (const row of p.regrown) assert.ok(Array.isArray(row.runs) && typeof row.was === "string");
  });

  test("rebase onto a copy with shifted ids replays the same cells; their edit survives", async () => {
    const r = await h.ok("sketch", { action: "rebase", onto: { path: files.shifted } }, 240_000);
    assert.equal(r.completed, true, JSON.stringify(r.conflicts));
    assert.equal(await read(CELLS_OF, { sid: S }), sketched);
    assert.equal(await read(`return pack.burgs.filter(b => b && b.name === "Otherton").length`), 1);
  });

  test("conflicts: a province cell someone else repainted, the state locked since", async () => {
    const conflictOf = async (file: string) => {
      const r = await h.ok("sketch", { action: "rebase", onto: { path: file } }, 240_000);
      assert.equal(r.completed, false, JSON.stringify(r).slice(0, 500));
      return (r.conflicts as Obj[])[0];
    };
    const repainted = await conflictOf(files.repainted);
    assert.equal(repainted.seq, 1);
    assert.match(repainted.reason, /had its cells changed since by someone else; the sketch regrew it/);
    const locked = await conflictOf(files.locked);
    assert.match(locked.reason, /was locked since; the sketch regrew its provinces/);
  });

  test("rebase onto a copy whose state borders moved since: no province cell left outside its state", async () => {
    const r = await h.ok("sketch", { action: "rebase", onto: { path: files.moved } }, 240_000);
    assert.equal(r.completed, true, JSON.stringify(r.conflicts));
    const off = await read(
      `const C = pack.cells, live = x => x && x.i && !x.removed;
       let outside = 0, none = 0;
       for (const c of C.i) {
         if (C.h[c] < 20) continue;
         const p = pack.provinces[C.province[c]];
         if (live(p) && p.state === args.S && C.state[c] !== args.S) outside++;
         if (C.state[c] === args.S && !(live(p) && p.state === args.S)) none++;
       }
       return { outside, none };`,
      { S }
    );
    assert.deepEqual(off, { outside: 0, none: 0 }, "the state's provinces cover its land, and only it");
    await h.ok("sketch", { action: "discard", confirm: true }).catch(() => h.ok("sketch", { action: "stop" }));
  });
});

/** Before a regrid: the old cell points (the steps of a copied border follow them). */
const STASH = `globalThis.__terrOld = Array.from(pack.cells.p, p => [p[0], p[1]]); return __terrOld.length;`;

/**
 * After a regrid: per field, the border edges, the share of them between two new cells of one old
 * cell (a copied border has none: it follows the old cells' steps), and the mean cost of the cut
 * edges against all land edges; then the invariants.
 */
const AFTER = `const C = pack.cells, live = x => x && x.i && !x.removed;
const old = globalThis.__terrOld;
const qt = d3.quadtree(old.map((p, i) => [p[0], p[1], i]), p => p[0], p => p[1]);
const own = new Int32Array(C.i.length);
for (const c of C.i) own[c] = qt.find(C.p[c][0], C.p[c][1])[2];
const out = {};
for (const f of ["state", "culture", "religion", "province"]) {
  const k = __tupaia.territory.makeCost(f);
  let e = 0, inside = 0, cost = 0, all = 0, allCost = 0;
  for (const c of C.i) {
    if (C.h[c] < 20) continue;
    for (const j of C.c[c]) {
      if (j < c || C.h[j] < 20) continue;
      const w = (k(c, j, -1) + k(j, c, -1)) / 2;
      all++; allCost += w;
      if (C[f][j] === C[f][c]) continue;
      e++; cost += w;
      if (own[j] === own[c]) inside++;
    }
  }
  // connected pieces of the field over the land, and those of one or two cells
  const comp = new Int32Array(C.i.length).fill(-1);
  let pieces = 0, small = 0;
  for (const c0 of C.i) {
    if (C.h[c0] < 20 || comp[c0] >= 0) continue;
    const cells = [c0];
    comp[c0] = c0;
    for (let x = 0; x < cells.length; x++)
      for (const j of C.c[cells[x]])
        if (C.h[j] >= 20 && comp[j] < 0 && C[f][j] === C[f][c0]) { comp[j] = c0; cells.push(j); }
    pieces++;
    if (cells.length <= 2) small++;
  }
  out[f] = { edges: e, insidePct: (100 * inside) / e, cost: cost / e / (allCost / all), pieces, small };
}
// state, culture and religion together: distinct triples, and land cells off the state's own
// (culture, religion) when args.joint maps each state to them
const triples = new Set();
let offJoint = 0;
for (const c of C.i) {
  if (C.h[c] < 20) continue;
  triples.add(C.state[c] + "|" + C.culture[c] + "|" + C.religion[c]);
  const want = args.joint?.[C.state[c]];
  if (want && (C.culture[c] !== want[0] || C.religion[c] !== want[1])) offJoint++;
}
let burgState = 0, burgCulture = 0, capitals = 0, provOutside = 0;
const provCapitals = [];
for (const b of pack.burgs) {
  if (!live(b)) continue;
  if (C.state[b.cell] !== (b.state || 0)) burgState++;
  if (C.culture[b.cell] !== (b.culture || 0)) burgCulture++;
}
for (const s of pack.states) if (live(s) && live(pack.burgs[s.capital]) && C.state[pack.burgs[s.capital].cell] !== s.i) capitals++;
for (const p of pack.provinces) if (live(p) && live(pack.burgs[p.burg]) && C.province[pack.burgs[p.burg].cell] !== p.i) provCapitals.push(p.state);
for (const c of C.i) {
  const p = pack.provinces[C.province[c]];
  if (C.h[c] >= 20 && C.province[c] && live(p) && p.state !== C.state[c]) provOutside++;
}
const L = args.locked;
const lockedCells = [];
const burgCells = new Set(pack.burgs.filter(live).map(b => b.cell));
for (const c of C.i)
  if (C.state[c] === L)
    lockedCells.push(c + ":" + C.province[c] + (burgCells.has(c) ? "" : ":" + C.culture[c] + ":" + C.religion[c]));
return { cells: C.i.length, out, triples: triples.size, offJoint, burgState, burgCulture, capitals, provCapitals: provCapitals.length,
  provCapitalsOf: provCapitals, provOutside, locked: lockedCells.join(",") };`;

describe("regrid {territories:'regrow'} versus 'copy' (demo.map to 20K)", () => {
  let h: Harness;
  let L = 0;
  let copy: Obj;
  let regrow: Obj;
  let result: Obj;
  const read = async (code: string, args: Obj = {}): Promise<any> =>
    (await h.ok("eval", { code, args, readOnly: true })).value;

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "10" });
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    // a locked state with provinces, next to others
    L = await read(`const live = x => x && x.i && !x.removed;
      return pack.states.filter(s => live(s) && s.provinces?.length >= 3)[1].i;`);
    await h.ok("edit", { type: "state", ops: [{ ref: L, set: { lock: true } }] });
    await read(STASH);
    await h.ok("regrid", { density: 20000 }, 300_000);
    copy = await read(AFTER, { locked: L });
    await h.ok("snapshot", { action: "undo" });
    assert.equal(await read("return pack.cells.i.length"), 7462, "undo returns to the old grid");
    await read(STASH);
    result = await h.ok("regrid", { density: 20000, territories: "regrow" }, 300_000);
    regrow = await read(AFTER, { locked: L });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("regrow reports each field; the same new grid as copy", () => {
    assert.equal(regrow.cells, copy.cells);
    const t = result.territories as Obj;
    assert.equal(t.mode, "regrow");
    assert.equal(t.band, 3, "about 1.5 old cells");
    for (const f of ["culture", "religion", "state"]) {
      assert.ok(t[f].changed > 0, f);
      assert.ok(Math.abs(t[f].maxAreaChangePct) <= 15, `${f}: ${JSON.stringify(t[f])}`);
    }
    assert.ok(t.province.changed > 0);
    const [ok, all] = String(t.province.within15pct).split("/").map(Number);
    assert.ok(ok / all >= 0.95, t.province.within15pct);
  });

  test("borders leave the old cells' steps along the terrain, no longer and in no more pieces than copied", () => {
    for (const f of ["state", "culture", "religion", "province"]) {
      assert.ok(copy.out[f].insidePct < 1, `copy ${f}: ${copy.out[f].insidePct}`);
      assert.ok(regrow.out[f].insidePct > 5, `regrow ${f}: ${regrow.out[f].insidePct}`);
      // no longer (more jagged) borders, no more pieces or slivers than the copy
      assert.ok(
        regrow.out[f].edges <= 1.05 * copy.out[f].edges,
        `${f} edges ${copy.out[f].edges} -> ${regrow.out[f].edges}`
      );
      assert.ok(
        regrow.out[f].pieces <= copy.out[f].pieces,
        `${f} pieces ${copy.out[f].pieces} -> ${regrow.out[f].pieces}`
      );
      assert.ok(
        regrow.out[f].small <= copy.out[f].small,
        `${f} 1-2 cell pieces ${copy.out[f].small} -> ${regrow.out[f].small}`
      );
    }
    // the cut edges: dear ones (well above the mean edge); state borders dearer than copied ones.
    // demo's cultures and religions were drawn by the app's own expand along the terrain, so
    // theirs stay about as dear (within 5%) on borders that are shorter
    assert.ok(regrow.out.state.cost > copy.out.state.cost, `state: ${copy.out.state.cost} -> ${regrow.out.state.cost}`);
    for (const f of ["state", "culture", "religion"])
      assert.ok(
        regrow.out[f].cost >= 0.95 * copy.out[f].cost && regrow.out[f].cost > 1.2,
        `${f}: cut-edge cost / mean edge cost ${copy.out[f].cost} -> ${regrow.out[f].cost}`
      );
    assert.ok(regrow.triples <= copy.triples, `state|culture|religion triples ${copy.triples} -> ${regrow.triples}`);
  });

  test("every burg keeps its state and culture; capitals inside; provinces inside their states", () => {
    assert.deepEqual([regrow.burgState, regrow.burgCulture, regrow.capitals, regrow.provOutside], [0, 0, 0, 0]);
    // a regrown province's capital is inside it; the locked state's provinces stay as copied
    assert.deepEqual(
      regrow.provCapitalsOf.filter((s: number) => s !== L),
      []
    );
    assert.ok(copy.burgCulture > 0 && copy.provCapitals > regrow.provCapitals, "copy leaves some outside");
  });

  test("a locked state keeps its copied cells and provinces, and the cultures and religions on them", () => {
    assert.ok(copy.locked.length > 100);
    assert.ok(regrow.locked === copy.locked, "same cells, provinces, cultures and religions (but burg cells)");
    const t = result.territories as Obj;
    assert.equal(t.state.lockedKept, 1);
    assert.match(String(t.note), /1 locked state kept its cells and provinces.*territoryLocked:true regrows them too/);
  });

  test("territoryLocked:true regrows the locked state too; refusals", async () => {
    await h.ok("snapshot", { action: "undo" });
    await read(STASH);
    const r = await h.ok(
      "regrid",
      { density: 20000, territories: "regrow", territoryLocked: true, territoryBand: 4 },
      300_000
    );
    assert.equal((r.territories as Obj).band, 4);
    const all = await read(AFTER, { locked: L });
    assert.ok(all.locked !== copy.locked, "the locked state moved");
    assert.deepEqual(
      [all.burgState, all.burgCulture, all.capitals, all.provCapitals, all.provOutside],
      [0, 0, 0, 0, 0]
    );
    assert.equal(await read(`return !!pack.states[${L}].lock`), true, "its lock stays");
    await h.ok("snapshot", { action: "undo" });
    const cases: Array<[Obj, RegExp]> = [
      [{ density: 20000, territoryBand: 4 }, /territoryBand is the regrow band/],
      [{ density: 20000, territoryLocked: true }, /territoryLocked is true or false, with territories:'regrow'/]
    ];
    for (const [args, re] of cases) {
      const x = await h.call("regrid", args);
      assert.equal(x.isError, true);
      assert.match((errorBody(x).error as Obj).message, re);
    }
    const bad = await h.call("regrid", { density: 20000, territories: "redraw" });
    assert.equal(bad.isError, true);
    assert.equal(await read("return pack.cells.i.length"), 7462, "nothing changed");
  });

  test("where state, culture and religion borders coincide (the fork's maps) they move as one line", async () => {
    // every state's land (and burgs) takes one culture and one religion, as on the fork's maps
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    const joint = (await h.ok("eval", { code: COINCIDE })).value as Obj;
    await read(STASH);
    await h.ok("regrid", { density: 20000 }, 300_000);
    const c = await read(AFTER, { locked: L, joint });
    await h.ok("snapshot", { action: "undo" });
    await read(STASH);
    await h.ok("regrid", { density: 20000, territories: "regrow", territoryLocked: true }, 300_000);
    const r = await read(AFTER, { locked: L, joint });
    assert.equal(r.offJoint, 0, `cells of a state's land off its culture or religion (copy: ${c.offJoint})`);
    assert.ok(r.triples <= c.triples, `triples ${c.triples} -> ${r.triples}`);
    for (const f of ["state", "culture", "religion"]) {
      assert.ok(r.out[f].pieces <= c.out[f].pieces, `${f} pieces ${c.out[f].pieces} -> ${r.out[f].pieces}`);
      assert.ok(r.out[f].small <= c.out[f].small, `${f} 1-2 cell pieces ${c.out[f].small} -> ${r.out[f].small}`);
      assert.ok(r.out[f].edges <= 1.05 * c.out[f].edges, `${f} edges ${c.out[f].edges} -> ${r.out[f].edges}`);
      assert.ok(r.out[f].insidePct > 5, `${f} off the old steps: ${r.out[f].insidePct}`);
    }
    assert.deepEqual([r.burgState, r.burgCulture, r.capitals, r.provCapitals, r.provOutside], [0, 0, 0, 0, 0]);
  });
});

/** Every state's land and burgs take one culture (its own) and one religion; returns state -> [culture, religion]. */
const COINCIDE = `const C = pack.cells, live = x => x && x.i && !x.removed;
const rel = pack.religions.filter(live).map(r => r.i);
const map = { 0: [0, 0] };
for (const s of pack.states) if (live(s)) map[s.i] = [live(pack.cultures[s.culture]) ? s.culture : 0, rel[s.i % rel.length]];
for (const c of C.i) {
  const m = map[C.state[c]];
  if (C.h[c] >= 20 && m) { C.culture[c] = m[0]; C.religion[c] = m[1]; }
}
for (const b of pack.burgs) if (live(b) && map[b.state]) b.culture = map[b.state][0];
return map;`;
