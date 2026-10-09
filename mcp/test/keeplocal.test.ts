// rebuild:'keep' is local (set_heights and paint_cells height): a sparse change recomputes only
// what the changed cells feed (their heights, temperature, biome, lake levels) and leaves burg
// economies, state treasuries, markets, deals, rivers, precipitation and far biomes byte-identical;
// rivers:'regenerate' is the opt-in global river pass (still no economy re-roll).
// River control: edit river {end}, {joinAt}, a reroute that changes nothing is a no-op success,
// and the builder's rivfix pattern (end a tributary loose, run its parent through that cell).
// tests/fixtures/demo.map (rivers as in rivers.test.ts: 7 Olsneske joins 6 Maracenda at 6188).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { alive, DEMO_MAP, errorBody, type Harness, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

// fingerprints of everything a local keep change must not touch (except the changed cells)
const FINGERPRINT = `
const hash = s => { let h = 0x811c9dc5; for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); };
const J = v => hash(JSON.stringify(v));
const C = pack.cells, skipP = new Set(args.cells || []), skipG = new Set((args.cells || []).map(i => C.g[i]));
const far = (arr, skip) => Array.from(arr).filter((_, i) => !skip.has(i));
return {
  burgs: J(pack.burgs), states: J(pack.states), markets: J(pack.markets), deals: J(pack.deals), goods: J(pack.goods),
  provinces: J(pack.provinces), rivers: J(pack.rivers), r: J(Array.from(C.r)), fl: J(Array.from(C.fl)), conf: J(Array.from(C.conf)),
  prec: J(Array.from(grid.cells.prec)), pop: J(Array.from(C.pop)), ice: J(pack.ice ?? null),
  biomesFar: J(far(C.biome, skipP)), tempFar: J(far(grid.cells.temp, skipG)), hFar: J(far(C.h, skipP))
};`;

// the biome Biomes.define gives a cell on the current climate
const CLIMATE_BIOME = `
const C = pack.cells, prec = grid.cells.prec;
return args.cells.map(i => {
  let m = prec[C.g[i]]; if (C.r[i]) m += Math.max(C.fl[i] / 10, 2);
  let s = 0, k = 0; for (const n of C.c[i]) if (C.h[n] >= 20) { s += prec[C.g[n]]; k++; }
  s += m; k++;
  return [C.biome[i], Biomes.getId(Math.round(4 + s / k), grid.cells.temp[C.g[i]], C.h[i], Boolean(C.r[i]))];
});`;

const INVARIANTS = `
const C = pack.cells, out = [];
const byId = new Map(pack.rivers.map(r => [r.i, r]));
const own = new Map();
for (const r of pack.rivers) {
  const n = r.cells.length;
  if (r.source !== r.cells[0]) out.push(r.i + " source");
  if (r.mouth !== r.cells[n - 2]) out.push(r.i + " mouth");
  if (r.discharge !== C.fl[r.mouth]) out.push(r.i + " discharge " + r.discharge + " vs " + C.fl[r.mouth]);
  const isTrib = r.parent && r.parent !== r.i;
  if (isTrib && byId.has(r.parent)) {
    const j = r.cells[n - 1];
    if (!byId.get(r.parent).cells.includes(j) && !(j >= 0 && C.h[j] < 20)) out.push(r.i + " does not end on " + r.parent);
  }
  for (const c of r.cells) if (c >= 0 && C.h[c] >= 20) own.set(c, Math.min(own.get(c) ?? Infinity, r.i));
}
for (const [c, m] of own) if (C.r[c] !== m) out.push("cell " + c + " r " + C.r[c] + " vs " + m);
for (const c of C.i) if (C.r[c] && !own.has(c)) out.push("cell " + c + " stray r " + C.r[c]);
return out.slice(0, 20);`;

const RIVERS = `
const pick = r => r && { i: r.i, parent: r.parent, discharge: r.discharge, cells: r.cells };
return Object.fromEntries(args.ids.map(i => [i, pick(pack.rivers.find(r => r.i === i)) ?? null]));`;

describe("tupaia-mcp rebuild:'keep' is local; river end/joinAt", () => {
  let h: Harness;
  // a land cell inside a river's course (A) and a land cell off every river, far from it (B)
  let A = { cell: 0, h: 0, river: 0 };
  let B = { cell: 0, h: 0 };

  const read = async (code: string, args: Obj = {}): Promise<any> =>
    (await h.ok("eval", { code, args, readOnly: true })).value;
  const fingerprint = (cells: number[] = []) => read(FINGERPRINT, { cells });
  const changedCells = (hBefore: number[]) =>
    read("return Array.from(pack.cells.h).flatMap((v, i) => (v !== args.h[i] ? [i] : []));", { h: hBefore });
  const heights = async (): Promise<number[]> => read("return Array.from(pack.cells.h)");
  const invariants = async (): Promise<string[]> => read(INVARIANTS);
  const rivers = async (...ids: number[]): Promise<Record<string, Obj>> => read(RIVERS, { ids });
  const edit = (ops: Obj[], extra: Obj = {}) => h.ok("edit", { type: "river", ops, ...extra });
  const undo = () => h.ok("snapshot", { action: "undo" }, 240_000);

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    await h.ok("load_map", { path: DEMO_MAP });
    const pick = await read(`
      const C = pack.cells;
      const burgCells = new Set(pack.burgs.filter(b => b.i && !b.removed).map(b => b.cell));
      let A = null;
      for (const r of pack.rivers) {
        if (!r.cells || r.cells.length < 8) continue;
        for (let k = 2; k < r.cells.length - 3 && !A; k++) {
          const c = r.cells[k];
          if (C.h[c] >= 30 && C.h[c] <= 70 && C.h[r.cells[k - 1]] >= 20 && !burgCells.has(c)) A = { cell: c, h: C.h[c], river: r.i };
        }
        if (A) break;
      }
      const far = c => Math.hypot(C.p[c][0] - C.p[A.cell][0], C.p[c][1] - C.p[A.cell][1]) > 200;
      const off = c => !C.r[c] && C.c[c].every(n => !C.r[n] && C.h[n] >= 20);
      const b = [...C.i].find(c => C.h[c] >= 30 && C.h[c] <= 70 && off(c) && far(c) && !burgCells.has(c));
      return { A, B: { cell: b, h: C.h[b] } };`);
    A = pick.A;
    B = pick.B;
    assert.ok(A && Number.isInteger(B.cell), JSON.stringify(pick));
    assert.ok((await read("return pack.goods.length")) > 0, "fixture: the demo map has an economy");
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("set_heights keep, 2 cells: economy, treasuries, rivers and far biomes byte-identical", async () => {
    const f0 = await fingerprint();
    const h0 = await heights();
    const dry = await h.ok("set_heights", {
      pack: { [A.cell]: A.h + 12, [B.cell]: B.h + 6 },
      rebuild: "keep",
      dryRun: true
    });
    assert.equal((dry.rivers as Obj).through >= 1, true, JSON.stringify(dry.rivers));
    assert.match((dry.rivers as Obj).effect, /kept/);
    const r = await h.ok("set_heights", { pack: { [A.cell]: A.h + 12, [B.cell]: B.h + 6 }, rebuild: "keep" }, 240_000);
    const cells = await changedCells(h0);
    assert.ok(cells.includes(A.cell) && cells.includes(B.cell), JSON.stringify(cells));
    assert.ok(cells.length <= 6, `only the cells of 2 grid cells changed: ${cells.length}`);
    const f1 = await fingerprint(cells);
    const f0far = await (async () => {
      // the same cells excluded from the before fingerprint: compare like for like
      await undo();
      const v = await fingerprint(cells);
      await h.ok("snapshot", { action: "redo" }, 240_000);
      return v;
    })();
    assert.deepEqual(f1, f0far, "nothing outside the changed cells changed");
    assert.equal(f1.burgs, f0.burgs, "burgs (treasury, product, production) untouched");
    assert.equal(f1.states, f0.states, "state treasuries untouched");
    assert.equal(f1.deals, f0.deals);
    assert.equal(f1.rivers, f0.rivers, "rivers kept");
    const local = r.local as Obj;
    assert.equal(local.packCells, cells.length);
    assert.ok(local.rivers.through >= 1, JSON.stringify(local));
    assert.equal(r.cellsRenumbered, false);
    assert.equal(r.rivers, undefined, "no river regeneration counts");
    assert.match(JSON.stringify(r.notes), /rebuild:'keep' is local/);
    assert.match(JSON.stringify(r.notes), /rivers were kept: \d+ run through the changed cells/);
    assert.equal((r.options as Obj).rivers, "keep");
    // the changed cells' biome follows their new climate
    for (const [now, want] of await read(CLIMATE_BIOME, { cells })) assert.equal(now, want);
    await undo();
    assert.deepEqual(await fingerprint(), f0, "one undo reverts");
  });

  test("a raised river cell that makes the river climb is reported, not regenerated", async () => {
    const r = await h.ok("set_heights", { pack: { [A.cell]: Math.min(100, A.h + 30) }, rebuild: "keep" }, 240_000);
    const local = r.local as Obj;
    const climbing = local.rivers.climbing as Obj[];
    assert.ok(
      climbing?.some(x => x.i === A.river),
      JSON.stringify(local)
    );
    assert.match(
      JSON.stringify(r.notes),
      /now climb there: .*reroute them with edit river, or pass rivers:'regenerate'/
    );
    await undo();
  });

  test("paint_cells height keep is the same local update", async () => {
    const f0 = await fingerprint([A.cell, B.cell]);
    const h0 = await heights();
    const r = await h.ok("paint_cells", { select: { cells: [A.cell, B.cell] }, set: { height: { delta: 5 } } });
    const cells = await changedCells(h0);
    assert.ok(cells.length >= 2 && cells.length <= 6, JSON.stringify(cells));
    const f1 = await fingerprint([A.cell, B.cell, ...cells]);
    await undo();
    assert.deepEqual(f1, await fingerprint([A.cell, B.cell, ...cells]));
    assert.equal(f0.burgs, f1.burgs);
    assert.match(JSON.stringify(r), /"local":\{"packCells":\d+/);
    assert.match(JSON.stringify(r.notes), /rebuild:'keep' is local/);
    // biomes:'keep' keeps the changed cells' biomes; it only goes with keep
    const b0 = await read("return args.c.map(i => pack.cells.biome[i])", { c: [A.cell, B.cell] });
    await h.ok("paint_cells", {
      select: { cells: [A.cell, B.cell] },
      set: { height: { delta: 25, biomes: "keep" } }
    });
    assert.deepEqual(await read("return args.c.map(i => pack.cells.biome[i])", { c: [A.cell, B.cell] }), b0);
    await undo();
    const bad = await h.call("paint_cells", {
      select: { cells: [A.cell] },
      set: { height: { delta: 2, rebuild: "risk", biomes: "keep" } }
    });
    assert.equal(errorBody(bad).error.code, "BAD_ARGS");
  });

  test("rivers:'regenerate' is the opt-in global river pass; the economy is still not re-rolled", async () => {
    const f0 = await fingerprint();
    const r = await h.ok(
      "set_heights",
      { pack: { [A.cell]: A.h + 4 }, rebuild: "keep", rivers: "regenerate" },
      240_000
    );
    const f1 = await fingerprint();
    for (const k of ["burgs", "states", "markets", "deals", "goods", "prec"]) assert.equal(f1[k], f0[k], k);
    assert.equal((r.local as Obj).rivers.regenerated, true);
    assert.equal(typeof (r.rivers as Obj)?.kept, "number", "the kept/new/gone river counts");
    assert.match(JSON.stringify(r.notes), /opt-in global step/);
    assert.match(JSON.stringify(r.notes), /burg economies and state treasuries were not re-rolled/);
    await undo();
    for (const [args, re] of [
      [{ rebuild: "risk", rivers: "keep" }, /rivers:'keep' goes with rebuild:'keep'/],
      [{ rebuild: "keep", rivers: "keep", erosion: true }, /rivers:'regenerate'/],
      [{ rebuild: "keep", rivers: "all" }, /rivers/]
    ] as const) {
      const bad = await h.call("set_heights", { pack: { [A.cell]: A.h + 1 }, ...args });
      assert.equal(bad.isError, true);
      assert.match(errorBody(bad).error.message, re);
    }
  });

  test("reroute through cells the river already holds is a no-op success with a note", async () => {
    const s0 = await read("return JSON.stringify(pack.rivers.find(r => r.i === 6))");
    const dry = await edit([{ ref: 6, set: { reroute: { cells: [6799, 6800, 6802] } } }], { dryRun: true });
    assert.match((dry.plan as Obj[])[0].after.reroute, /unchanged: .* already runs through these cells/);
    const r = await edit([{ ref: 6, set: { reroute: { cells: [6799, 6800, 6802] } } }]);
    assert.match(
      JSON.stringify(r.notes),
      /unchanged: Maracenda \(6\) already runs through these cells.*use end:\{at\}/
    );
    assert.equal(await read("return JSON.stringify(pack.rivers.find(r => r.i === 6))"), s0);
    await undo();
  });

  test("end: refused while a tributary joins below; a tributary ended mid-course is loose (warned)", async () => {
    const six = (await rivers(6))[6];
    const e = await h.call("edit", { type: "river", ops: [{ ref: 6, set: { end: { at: six.cells[4] } } }] });
    assert.equal(errorBody(e).error.code, "REFUSED");
    assert.match(errorBody(e).error.message, /Olsneske \(7\) joins Maracenda \(6\) at cell 6188/);
    const before = await rivers(6, 7);
    const seven = before[7].cells as number[];
    const at = seven[seven.length - 3];
    const r = await edit([{ ref: 7, set: { end: { at: { cell: at } } } }]);
    const now = await rivers(6, 7);
    assert.deepEqual(now[7].cells, seven.slice(0, -2));
    assert.ok(now[6].discharge < before[6].discharge, "Maracenda lost Olsneske's water");
    assert.match(JSON.stringify(r.notes), /ends loose at cell/);
    // Nevels (28), a tributary of 7 that ended at the same confluence cell, now joins 6 there
    assert.match(
      JSON.stringify(r.notes),
      /Nevels \(28\) ended where Olsneske \(7\) did \(cell 6188\); it now joins Maracenda \(6\)/
    );
    assert.deepEqual(
      (await invariants()).filter(x => x !== "7 does not end on 6"),
      [],
      "only the loose end breaks an invariant"
    );
    // repeating it changes nothing
    const again = await edit([{ ref: 7, set: { end: { at: { cell: at } } } }]);
    assert.match(JSON.stringify(again.notes), /unchanged: Olsneske \(7\) already ends at cell/);
    await undo();
    await undo();
  });

  test("rivfix pattern in one call: end a tributary loose, then run its parent through that cell", async () => {
    // a tributary y of x: y will end at m (its cell above the junction), and x runs from the
    // cell above the junction through m to the cell below it (a short free path)
    const c = await read(`
      const C = pack.cells, land = q => q >= 0 && C.h[q] >= 20;
      const inner = new Set(); for (const r of pack.rivers) for (let k = 0; k < r.cells.length - 1; k++) inner.add(r.cells[k]);
      const bfs = (from, to, ok) => {
        const prev = new Map([[from, -1]]); let front = [from];
        for (let d = 0; d < 5 && front.length; d++) {
          const next = [];
          for (const u of front) for (const v of C.c[u]) {
            if (prev.has(v) || (v !== to && !ok(v))) continue;
            prev.set(v, u); if (v === to) { const p = [v]; for (let w = u; w !== -1; w = prev.get(w)) p.push(w); return p.reverse(); }
            next.push(v);
          }
          front = next;
        }
        return null;
      };
      for (const y of pack.rivers) {
        if (!y.parent || y.parent === y.i || y.cells.length < 4) continue;
        const x = pack.rivers.find(r => r.i === y.parent); if (!x) continue;
        const j = y.cells.at(-1), kj = x.cells.indexOf(j), m = y.cells.at(-2);
        if (kj < 1 || kj > x.cells.length - 3 || !land(m) || !land(j)) continue;
        if (pack.rivers.some(o => o !== y && o.cells.at(-1) === j)) continue;
        const a = x.cells[kj - 1], b = x.cells[kj + 1];
        if (!land(a) || !land(b)) continue;
        const xs = new Set(x.cells), ys = new Set(y.cells);
        const free = v => land(v) && !inner.has(v) && !xs.has(v) && !ys.has(v);
        const p1 = bfs(a, m, free); if (!p1) continue;
        const used = new Set(p1);
        const p2 = bfs(m, b, v => free(v) && !used.has(v)); if (!p2) continue;
        return { x: x.i, y: y.i, m, j, path: p1.concat(p2.slice(1)), yCells: y.cells };
      }
      return null;`);
    assert.ok(c, "the demo map has such a tributary");
    const ops = [
      { ref: c.y, set: { end: { at: c.m } } },
      { ref: c.x, set: { reroute: { cells: c.path } } }
    ];
    const dry = await edit(ops, { dryRun: true });
    assert.match((dry.plan as Obj[])[1].after.reroute, /checked when applied/);
    const r = await edit(ops);
    const now = await rivers(c.x, c.y);
    assert.deepEqual(now[c.y].cells, c.yCells.slice(0, -1), "the tributary ends at its old mouth cell");
    assert.ok(now[c.x].cells.includes(c.m) && !now[c.x].cells.includes(c.j), "the parent runs through it");
    assert.equal(now[c.y].parent, c.x);
    assert.match(JSON.stringify(r.notes), new RegExp(`ended loose at cell ${c.m}; it now joins`));
    assert.deepEqual(await invariants(), []);
    await undo();
  });

  test("joinAt moves a confluence; repeating it is a no-op; end joins a neighbouring river; both replay", async () => {
    // a tributary and a cell of its parent (not its junction) a free land path reaches from
    // its course (Olsneske (7) is boxed in between Nevels (28) and 294, so it cannot move)
    const blocked = await h.call("edit", { type: "river", ops: [{ ref: 7, set: { joinAt: { river: 6, at: 6190 } } }] });
    assert.equal(errorBody(blocked).error.code, "NO_PATH");
    await h.ok("load_map", { path: DEMO_MAP });
    const c0 = await read(`
      const C = pack.cells, land = q => q >= 0 && C.h[q] >= 20;
      const inner = new Set(); for (const r of pack.rivers) for (let k = 0; k < r.cells.length - 1; k++) inner.add(r.cells[k]);
      for (const x of pack.rivers) {
        if (!x.parent || x.parent === x.i || x.cells.length < 5) continue;
        const y = pack.rivers.find(r => r.i === x.parent); if (!y) continue;
        const xs = new Set(x.cells), j = x.cells.at(-1);
        const goals = new Set(y.cells.slice(1, -1).filter(c => land(c) && c !== j && Math.abs(y.cells.indexOf(c) - y.cells.indexOf(j)) >= 2));
        const seen = new Set(x.cells.slice(0, -1)); let front = x.cells.slice(0, -1).filter(land);
        for (let d = 0; d < 4 && front.length; d++) {
          const next = [];
          for (const u of front) for (const v of C.c[u]) {
            if (goals.has(v)) return { x: x.i, y: y.i, cell: v, name: x.name, yName: y.name };
            if (seen.has(v) || !land(v) || inner.has(v) || xs.has(v)) continue;
            seen.add(v); next.push(v);
          }
          front = next;
        }
      }
      return null;`);
    assert.ok(c0, "the demo map has a tributary whose confluence can move");
    await h.ok("sketch", { action: "start", slug: "t-keeplocal" });
    const target = c0.cell as number;
    const X = c0.x as number;
    const Y = c0.y as number;
    await edit([{ ref: X, set: { joinAt: { river: Y, at: target } } }]);
    const now = await rivers(Y, X);
    assert.equal(now[X].cells.at(-1), target);
    assert.equal(now[X].parent, Y);
    assert.deepEqual(await invariants(), []);
    const again = await edit([{ ref: X, set: { joinAt: { at: { cell: target } } } }]);
    assert.match(
      JSON.stringify(again.notes),
      new RegExp(`unchanged: .* \\(${X}\\) already joins .* \\(${Y}\\) at cell ${target}`)
    );
    const full = await h.ok("sketch", { action: "status", full: true });
    const recs = full.records as Obj[];
    const lit = recs[0].resolved.ops[0].set.joinAt;
    assert.deepEqual([lit.ref, lit.at.cell, lit.cells.at(-1)], [Y, target, target]);
    assert.match(recs[0].summary, new RegExp(`now joins river ${Y} at cell ${target}`));
    const want = await read("return JSON.stringify(pack.rivers)");
    const rb = await h.ok("sketch", { action: "rebase", onto: { path: DEMO_MAP } }, 240_000);
    assert.equal(rb.completed, true, JSON.stringify(rb.conflicts));
    assert.equal(await read("return JSON.stringify(pack.rivers)"), want, "the replay gives the same rivers");
    await h.ok("sketch", { action: "discard", confirm: true });
    await h.ok("load_map", { path: DEMO_MAP });

    // end at a cell of another river next to the course: the river joins it there
    const c = await read(`
      const C = pack.cells;
      const inner = new Map(); for (const r of pack.rivers) for (let k = 0; k < r.cells.length - 1; k++) if (!inner.has(r.cells[k])) inner.set(r.cells[k], r.i);
      for (const x of pack.rivers) {
        if (x.cells.length < 6 || pack.rivers.some(o => o.parent === x.i && o.i !== x.i)) continue;
        for (let k = 2; k < x.cells.length - 3; k++) {
          const q = x.cells[k];
          if (C.h[q] < 20) continue;
          const n = C.c[q].find(n => C.h[n] >= 20 && inner.has(n) && inner.get(n) !== x.i && !x.cells.includes(n));
          if (n !== undefined) {
            const host = pack.rivers.find(r => r.i === inner.get(n));
            if (host.parent === x.i) continue;
            return { x: x.i, k, q, n, host: host.i, cells: x.cells };
          }
        }
      }
      return null;`);
    assert.ok(c, "the demo map has a river passing next to another");
    await edit([{ ref: c.x, set: { end: { at: { cell: c.n } } } }]);
    const e = await rivers(c.x);
    assert.equal(e[c.x].cells.at(-1), c.n);
    assert.equal(e[c.x].parent, c.host);
    assert.deepEqual(await invariants(), []);
    await undo();
  });
});
