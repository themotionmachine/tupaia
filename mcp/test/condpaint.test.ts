// Track 'condpaint': paint by condition and rain shadow in biome regeneration. Local mode,
// demo.map, no network.
// - select.where conditions (bridge-ext/where.js): height, flux, precipitation, temperature, x, y,
//   slope, riverDist, aboveRiver, noise ranges and all/any/not, each checked against the page's
//   own data; unknown keys and non-numeric bounds are refused (no string is evaluated).
// - paint_cells {select:{where:{...}}, feather} is one replayable sketch op (literal cells).
// - regenerate {parts:['biomes'], biomes:{rainShadow, smoothClimate}}: winds from the map's
//   settings, deterministic, only lee cells dry out, the grid's climate is untouched, one
//   replayable sketch op (literal biome cells).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { BIOMES_OP } from "../src/tools/biomes.ts";
import { alive, errorBody, type Harness, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

const DEMO = "tests/fixtures/demo.map";
const BIOME_ARRAY = "Array.from(pack.cells.biome)";

describe("tupaia-mcp condpaint (local)", () => {
  let h: Harness;

  /** Cells a select resolves to (read in the page through the bridge's own selectCells). */
  async function cells(select: Obj): Promise<number[]> {
    const r = await h.ok("eval", {
      readOnly: true,
      args: { select },
      code: "return __tupaia.fns.selectCells({select: args.select, limit: 1e6}).cells"
    });
    return r.value as number[];
  }

  /** Cells for which `test` (a JS expression of c, with C = pack.cells) holds, computed independently. */
  async function expected(test: string, prelude = ""): Promise<number[]> {
    const r = await h.ok("eval", {
      readOnly: true,
      code: `const C = pack.cells; const G = grid.cells; ${prelude}; const out = []; for (let c = 0; c < C.i.length; c++) if (${test}) out.push(c); return out;`
    });
    return r.value as number[];
  }

  async function code(name: string, args: Obj): Promise<string> {
    const r = await h.call(name, args);
    assert.equal(r.isError, true, `${name} should fail: ${JSON.stringify(args)}`);
    return errorBody(r).error.code;
  }

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    await h.ok("load_map", { path: DEMO });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("value ranges: height, flux, precipitation, temperature, x, y match the page's data", async () => {
    const cases: Array<[Obj, string]> = [
      [{ height: { gte: 20, lte: 35 } }, "C.h[c] >= 20 && C.h[c] <= 35"],
      [{ flux: { gte: 300 } }, "C.fl[c] >= 300"],
      [{ precipitation: { gt: 5, lt: 20 } }, "G.prec[C.g[c]] > 5 && G.prec[C.g[c]] < 20"],
      [{ temperature: { lte: 0 } }, "G.temp[C.g[c]] <= 0"],
      [{ x: { lt: 400 }, y: { gte: 300 } }, "C.p[c][0] < 400 && C.p[c][1] >= 300"]
    ];
    for (const [where, test] of cases) {
      const got = await cells({ where });
      assert.ok(got.length > 0, `${JSON.stringify(where)} selects something`);
      assert.deepEqual(got, await expected(test), JSON.stringify(where));
    }
  });

  test("slope: max (default) and mean height difference to the neighbours, water as 20", async () => {
    const pre = `const e = v => (v < 20 ? 20 : v); const d = c => C.c[c].map(j => Math.abs(e(C.h[c]) - e(C.h[j])));`;
    assert.deepEqual(
      await cells({ where: { land: true, slope: { lte: 2 } } }),
      await expected("C.h[c] >= 20 && Math.max(0, ...d(c)) <= 2", pre)
    );
    const mean = await cells({ where: { slope: { gte: 6, mode: "mean" } } });
    assert.ok(mean.length > 0);
    assert.deepEqual(mean, await expected("d(c).reduce((s, x) => s + x, 0) / d(c).length >= 6", pre));
  });

  test("riverDist / aboveRiver: graph steps over land from river cells, and the height above that river cell", async () => {
    const riverCells = await expected("C.r[c] && C.h[c] >= 20");
    assert.deepEqual(await cells({ where: { riverDist: { lte: 0 } } }), riverCells);
    // distance 1: a neighbour of a river cell that is not one itself
    assert.deepEqual(
      await cells({ where: { riverDist: { gte: 1, lte: 1 } } }),
      await expected("!(C.r[c] && C.h[c] >= 20) && C.c[c].some(j => C.r[j] && C.h[j] >= 20)")
    );
    // minFlux narrows the sources; rivers picks one river (and with tributaries its tributaries)
    const big = await cells({ where: { riverDist: { lte: 0, minFlux: 1000 } } });
    assert.deepEqual(big, await expected("C.r[c] && C.h[c] >= 20 && C.fl[c] >= 1000"));
    const top = (
      await h.ok("eval", {
        readOnly: true,
        code: "return pack.rivers.slice().sort((a, b) => b.discharge - a.discharge)[0].i"
      })
    ).value as number;
    const own = await cells({ where: { riverDist: { lte: 0, rivers: [top] } } });
    assert.deepEqual(own, await expected(`C.r[c] === ${top} && C.h[c] >= 20`));
    const withTribs = await cells({ where: { riverDist: { lte: 0, rivers: [top], tributaries: true } } });
    assert.ok(withTribs.length > own.length, "the largest river has tributaries");
    // aboveRiver: a river cell is 0 above itself; a valley floor near rivers is a subset of riverDist
    const floor = await cells({ where: { land: true, riverDist: { lte: 3 }, aboveRiver: { lte: 2 } } });
    const near = new Set(await cells({ where: { land: true, riverDist: { lte: 3 } } }));
    assert.ok(floor.length > riverCells.length && floor.every(c => near.has(c)));
    assert.deepEqual(await cells({ where: { riverDist: { lte: 0 }, aboveRiver: { lte: 0, gte: 0 } } }), riverCells);
  });

  test("riverDist == k for k = 2..4 matches an independent breadth-first search over land", async () => {
    const bfs = `const dist = new Array(C.i.length).fill(Infinity); const q = [];
for (let c = 0; c < C.i.length; c++) if (C.r[c] && C.h[c] >= 20) { dist[c] = 0; q.push(c); }
for (let k = 0; k < q.length; k++) { const c = q[k]; if (C.h[c] < 20) continue; for (const j of C.c[c]) if (dist[j] === Infinity) { dist[j] = dist[c] + 1; q.push(j); } }`;
    for (const k of [2, 3, 4]) {
      const got = await cells({ where: { riverDist: { gte: k, lte: k } } });
      assert.ok(got.length > 0, `cells at distance ${k}`);
      assert.deepEqual(got, await expected(`dist[c] === ${k}`, bfs), `riverDist == ${k}`);
    }
  });

  test("feather frays the condition's edge: painted cells outside lie within width/2 of it, unpainted ones inside within width/2 of its outside", async () => {
    const where = { land: true, height: { gte: 20, lte: 30 }, not: { biome: "Wetland" } };
    const inside = await cells({ where });
    const before = (await h.ok("eval", { readOnly: true, code: "return Array.from(pack.cells.biome)" }))
      .value as number[];
    const width = 4; // cells
    const r = await h.ok("paint_cells", {
      select: { where },
      set: { biome: "Wetland" },
      feather: { width, unit: "cells", seed: 5 }
    });
    const f = r.feather as Obj;
    assert.ok(f.addedOutside > 0 && f.droppedInside > 0, JSON.stringify(f));
    const check = (
      await h.ok("eval", {
        readOnly: true,
        args: { inside, before, width },
        code: `const C = pack.cells, P = C.p, inS = new Set(args.inside);
// the feather measures to the inside/outside boundary (midpoints); allow one cell spacing on top of width/2
const reach = (args.width / 2 + 1) * grid.spacing;
const inB = [], outB = [];
for (let c = 0; c < C.i.length; c++) { if (C.h[c] < 20) continue;
  if (inS.has(c) && C.c[c].some(j => !inS.has(j) && C.h[j] >= 20)) inB.push(c);
  if (!inS.has(c) && C.c[c].some(j => inS.has(j))) outB.push(c); }
const near = (c, B) => B.some(b => Math.hypot(P[b][0] - P[c][0], P[b][1] - P[c][1]) <= reach);
let added = 0, dropped = 0, addedFar = 0, droppedFar = 0;
for (let c = 0; c < C.i.length; c++) { if (C.h[c] < 20) continue;
  const painted = C.biome[c] === 12 && args.before[c] !== 12;
  if (painted && !inS.has(c)) { added++; if (!near(c, inB)) addedFar++; }
  if (!painted && inS.has(c)) { dropped++; if (!near(c, outB)) droppedFar++; } }
return { added, dropped, addedFar, droppedFar };`
      })
    ).value as Obj;
    // addedOutside also counts band cells outside that were Wetland already (or water, never painted)
    assert.ok(check.added > 0 && check.added <= f.addedOutside, JSON.stringify({ check, f }));
    assert.equal(check.dropped, f.droppedInside, JSON.stringify({ check, f }));
    assert.equal(check.addedFar, 0, "every cell painted outside the condition is near its edge");
    assert.equal(check.droppedFar, 0, "every cell left unpainted inside the condition is near its edge");
    await h.ok("snapshot", { action: "undo" });
  });

  test("nesting all/any/not deeper than 32 is BAD_ARGS (not a stack overflow); 32 deep works", async () => {
    let deep: Obj = { height: { gte: 20 } };
    for (let k = 0; k < 5000; k++) deep = { not: deep };
    const r = await h.call("paint_cells", { select: { where: deep }, set: { biome: "Wetland" }, dryRun: true });
    assert.equal(r.isError, true);
    assert.equal(errorBody(r).error.code, "BAD_ARGS");
    assert.match(errorBody(r).error.message, /32 deep/);
    let ok: Obj = { height: { gte: 20 } };
    for (let k = 0; k < 32; k++) ok = { not: ok };
    // an even number of nots is the condition itself
    assert.deepEqual(await cells({ where: ok }), await cells({ where: { height: { gte: 20 } } }));
    // and the counter is reset after a refusal
    assert.ok((await cells({ where: { all: [{ any: [{ height: { gte: 20 } }] }] } })).length > 0);
  });

  test("climate conditions: precipitation/temperature smooth, precipitation rainShadow and the rainShadow cut", async () => {
    // an independent land-neighbour mean (as regenerate's smoothClimate) of the grid values per pack cell
    const smoothed = (key: string, passes: number) =>
      `const v = Float64Array.from(C.i, c => G.${key}[C.g[c]]);
for (let p = 0; p < ${passes}; p++) { const prev = Float64Array.from(v); for (let c = 0; c < C.i.length; c++) { if (C.h[c] < 20) continue; let s = prev[c], k = 1; for (const j of C.c[c]) if (C.h[j] >= 20) { s += prev[j]; k++; } v[c] = s / k; } }`;
    const sp = await cells({ where: { land: true, precipitation: { lt: 6, smooth: 5 } } });
    assert.ok(sp.length > 0);
    assert.deepEqual(sp, await expected("C.h[c] >= 20 && v[c] < 6", smoothed("prec", 5)));
    const st = await cells({ where: { land: true, temperature: { gte: 10, smooth: 3 } } });
    assert.ok(st.length > 0);
    assert.deepEqual(st, await expected("C.h[c] >= 20 && v[c] >= 10", smoothed("temp", 3)));

    // the rainShadow cut agrees with regenerate's report (shadowed: cut > 0, halved: cut >= 0.5)
    const rs = { strength: 2, maxDistance: 20, ridge: 50, spread: 20 };
    const dry = await h.ok("regenerate", {
      parts: ["biomes"],
      biomes: { keepPainted: false, rainShadow: rs },
      dryRun: true
    });
    const rep = ((dry.details as Obj).biomes as Obj).rainShadow as Obj;
    assert.equal(rep.spread, 20);
    assert.equal((await cells({ where: { rainShadow: { gt: 0, ...rs } } })).length, rep.shadowed);
    assert.equal((await cells({ where: { rainShadow: { gte: 0.5, ...rs } } })).length, rep.halved);
    // a fan of rays shadows at least as much as one ray
    const narrow = await cells({ where: { rainShadow: { gt: 0, ...rs, spread: 0 } } });
    assert.ok(narrow.length < rep.shadowed, `${narrow.length} < ${rep.shadowed}`);
    // precipitation with rainShadow is the grid's precipitation times (1 - cut)
    const cutCells = (
      await h.ok("eval", {
        readOnly: true,
        args: { rs },
        code: `const B = __tupaia.biomes; const cuts = B.shadowCuts(B.shadowOptions(args.rs)).cuts; const C = pack.cells, G = grid.cells; const out = []; for (let c = 0; c < C.i.length; c++) if (C.h[c] >= 20 && G.prec[C.g[c]] * (1 - cuts[c]) < 3) out.push(c); return out;`
      })
    ).value as number[];
    assert.deepEqual(await cells({ where: { land: true, precipitation: { lt: 3, rainShadow: rs } } }), cutCells);
    assert.ok(cutCells.length > (await cells({ where: { land: true, precipitation: { lt: 3 } } })).length);
    // bad options
    const sel = (where: Obj) => ({ select: { where }, set: { biome: "Wetland" }, dryRun: true });
    assert.equal(await code("paint_cells", sel({ precipitation: { lt: 3, smooth: 1.5 } })), "BAD_ARGS");
    assert.equal(await code("paint_cells", sel({ precipitation: { lt: 3, rainShadow: { strenght: 1 } } })), "BAD_ARGS");
    assert.equal(await code("paint_cells", sel({ temperature: { lt: 3, rainShadow: true } })), "BAD_FIELD");
    assert.equal(await code("paint_cells", sel({ rainShadow: { gt: 0, spread: 90 } })), "BAD_ARGS");
  });

  test("noise: seeded, deterministic, scale-sized blobs, value in 0..1", async () => {
    const a = await cells({ where: { noise: { scale: 150, seed: 7, gte: 0.5 } } });
    const b = await cells({ where: { noise: { scale: 150, seed: 7, gte: 0.5 } } });
    const c = await cells({ where: { noise: { scale: 150, seed: 8, gte: 0.5 } } });
    const all = await cells({ where: { noise: { scale: 150, seed: 7, gte: 0, lte: 1 } } });
    const n = (await expected("true")).length;
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
    assert.equal(all.length, n, "every cell's noise lies in 0..1");
    assert.ok(a.length > n * 0.2 && a.length < n * 0.8, `about half the cells (${a.length}/${n})`);
  });

  test("all / any / not combine where objects (nestable) like intersection / union / complement", async () => {
    const A = { height: { gte: 30 } };
    const B = { flux: { gte: 100 } };
    const setA = new Set(await cells({ where: A }));
    const setB = new Set(await cells({ where: B }));
    const n = (await expected("true")).length;
    const all = await cells({ where: { all: [A, B] } });
    const any = await cells({ where: { any: [A, B] } });
    const not = await cells({ where: { not: A } });
    assert.deepEqual(
      all,
      [...setA].filter(c => setB.has(c)).sort((x, y) => x - y)
    );
    assert.deepEqual(
      any,
      [...new Set([...setA, ...setB])].sort((x, y) => x - y)
    );
    assert.equal(not.length, n - setA.size);
    assert.ok(not.every(c => !setA.has(c)));
    // nested, mixed with the classic keys
    const nested = await cells({
      where: { land: true, any: [{ all: [A, { not: B }] }, { biome: "Wetland" }] }
    });
    const wet = new Set(await cells({ where: { biome: "Wetland" } }));
    const land = new Set(await cells({ where: { land: true } }));
    const want = [...land].filter(c => (setA.has(c) && !setB.has(c)) || wet.has(c)).sort((x, y) => x - y);
    assert.deepEqual(nested, want);
  });

  test("safe predicates: unknown keys are BAD_FIELD (nested too), bad bounds and strings are refused", async () => {
    const sel = (where: Obj) => ({ select: { where }, set: { biome: "Wetland" }, dryRun: true });
    assert.equal(await code("paint_cells", sel({ hieght: { lte: 3 } })), "BAD_FIELD");
    assert.equal(await code("paint_cells", sel({ all: [{ flux: { gte: 1 } }, { slopee: { lte: 1 } }] })), "BAD_FIELD");
    assert.equal(await code("paint_cells", sel({ height: { lte: 30, approx: 2 } })), "BAD_FIELD");
    assert.equal(await code("paint_cells", sel({ height: {} })), "BAD_ARGS");
    assert.equal(await code("paint_cells", sel({ height: { lte: "C.h[c] > 20 || true" } })), "BAD_ARGS");
    assert.equal(await code("paint_cells", sel({ height: "h > 20" })), "BAD_ARGS");
    assert.equal(await code("paint_cells", sel({ any: [] })), "BAD_ARGS");
    assert.equal(await code("paint_cells", sel({ noise: { gte: 0.5 } })), "BAD_ARGS");
    assert.equal(await code("paint_cells", sel({ riverDist: { lte: 2, rivers: ["No Such River Xyz"] } })), "NOT_FOUND");
    assert.equal(await code("paint_cells", sel({ riverDist: { lte: 2, tributaries: true } })), "BAD_ARGS");
  });

  test("conditions work in every select: regenerate biomes select/exclude, relief exclude, add zone select", async () => {
    const biomeArr = async () =>
      (await h.ok("eval", { readOnly: true, code: "return Array.from(pack.cells.biome)" })).value as number[];
    const before = await biomeArr();
    const near = { land: true, riverDist: { lte: 3 } };
    const nearSet = new Set(await cells({ where: near }));
    // select: only cells of the condition change
    const r1 = await h.ok("regenerate", {
      parts: ["biomes"],
      biomes: { keepPainted: false, noise: 0.6, select: { where: near } }
    });
    assert.ok(((r1.details as Obj).biomes as Obj).changed > 0, JSON.stringify((r1.details as Obj).biomes));
    const a1 = await biomeArr();
    const changed1 = a1.map((v, i) => (v !== before[i] ? i : -1)).filter(i => i >= 0);
    assert.ok(
      changed1.length > 0 && changed1.every(c => nearSet.has(c)),
      "regenerate select: changes stay inside the condition"
    );
    await h.ok("snapshot", { action: "undo" });
    // exclude: the condition's cells keep their biome
    await h.ok("regenerate", {
      parts: ["biomes"],
      biomes: { keepPainted: false, noise: 0.6, exclude: { where: near } }
    });
    const a2 = await biomeArr();
    const changed2 = a2.map((v, i) => (v !== before[i] ? i : -1)).filter(i => i >= 0);
    assert.ok(
      changed2.length > 0 && changed2.every(c => !nearSet.has(c)),
      "regenerate exclude: the condition's cells keep their biome"
    );
    await h.ok("snapshot", { action: "undo" });
    // relief exclude: no icon centre on a steep cell
    const steep = { land: true, slope: { gte: 4 } };
    const steepCells = await cells({ where: steep });
    assert.ok(steepCells.length > 20);
    await h.ok("display", { on: ["relief"] });
    // relief icons are drawn on canvas; window.getReliefIcons() is their vector record ({i,x,y,s})
    const ICONS = `return window.getReliefIcons().map(({x: x0, y: y0, s}) => { const x = x0 + s / 2, y = y0 + s / 2;
const c = findCell(x, y); if (d3.polygonContains(getPackPolygon(c), [x, y])) return c; return pack.cells.c[c].find(n => d3.polygonContains(getPackPolygon(n), [x, y])) ?? c; });`;
    const steepSet = new Set(steepCells);
    const onSteep = async () => {
      const ic = (await h.ok("eval", { readOnly: true, code: ICONS })).value as number[];
      return { all: ic.length, steep: ic.filter(c => steepSet.has(c)).length };
    };
    await h.ok("regenerate", { parts: ["relief"], relief: { seed: "cp" } });
    const open = await onSteep();
    await h.ok("snapshot", { action: "undo" });
    await h.ok("regenerate", { parts: ["relief"], relief: { seed: "cp", exclude: { where: steep } } });
    const shut = await onSteep();
    await h.ok("snapshot", { action: "undo" });
    // an icon is placed by cell but its drawn centre can fall just over a cell edge: allow 2%
    assert.ok(open.steep > 20, JSON.stringify(open));
    assert.ok(
      shut.all > 0 && shut.steep <= Math.max(1, open.steep * 0.02),
      `relief exclude: ${JSON.stringify({ open, shut })}`
    );

    const z = await h.ok("add", {
      type: "zone",
      items: [
        {
          name: "Floodplain",
          select: { where: { land: true, riverDist: { lte: 1, minFlux: 500 }, slope: { lte: 3 } } }
        }
      ]
    });
    const zid = (z.created as Obj[])[0].i;
    const zc = (
      await h.ok("eval", { readOnly: true, code: `return pack.zones.find(z => z.i === ${zid}).cells.length` })
    ).value as number;
    assert.equal(
      zc,
      (await cells({ where: { land: true, riverDist: { lte: 1, minFlux: 500 }, slope: { lte: 3 } } })).length
    );
    await h.ok("snapshot", { action: "undo" });
  });

  test("apply paint: an entry's where intersects select.where (same keys, ranges and combinators never widen it)", async () => {
    const want = await cells({ where: { height: { gte: 30, lte: 35 } } });
    const wantAll = await cells({ where: { all: [{ height: { gte: 30 } }, { height: { lte: 35 } }] } });
    assert.deepEqual(wantAll, want);
    const painted = async (entry: Obj) => {
      await h.ok("apply", { paint: [{ ...entry, set: { biome: "Wetland" } }] });
      const v = (
        await h.ok("eval", {
          readOnly: true,
          code: "const C = pack.cells; const o = []; for (let c = 0; c < C.i.length; c++) if (C.biome[c] === 12 && C.h[c] >= 30 && C.h[c] <= 35) o.push(c); const out = []; for (let c = 0; c < C.i.length; c++) if (C.biome[c] === 12 && (C.h[c] < 30 || C.h[c] > 35)) out.push(c); return {inRange: o.length, outside: out.length};"
        })
      ).value as Obj;
      await h.ok("snapshot", { action: "undo" });
      return v;
    };
    const wetBefore = (
      await h.ok("eval", {
        readOnly: true,
        code: "const C = pack.cells; let n = 0; for (let c = 0; c < C.i.length; c++) if (C.biome[c] === 12 && (C.h[c] < 30 || C.h[c] > 35)) n++; return n;"
      })
    ).value as number;
    for (const entry of [
      { select: { where: { height: { gte: 30 } } }, where: { height: { lte: 35 } } },
      { select: { where: { all: [{ height: { gte: 30 } }] } }, where: { all: [{ height: { lte: 35 } }] } }
    ]) {
      const v = await painted(entry);
      assert.equal(v.outside, wetBefore, `nothing outside height 30..35 was painted: ${JSON.stringify(entry)}`);
      assert.ok(v.inRange > 0);
    }
    // distinct keys still merge flat (the classic hMin + hMax)
    const flat = await painted({ select: { where: { hMin: 30 } }, where: { hMax: 35 } });
    assert.equal(flat.outside, wetBefore);
  });

  test("apply paint list: a nested condition that reads a painted key sees the earlier entry's paint", async () => {
    const u = await h.ok("apply", {
      paint: [
        { select: { where: { land: true, riverDist: { lte: 1, minFlux: 200 } } }, set: { biome: "Wetland" } },
        {
          select: { where: { all: [{ biome: "Wetland" }, { x: { lt: 840 } }] } },
          set: { biome: "Wetland", culture: 1 }
        }
      ]
    });
    assert.equal(u.changed, true, JSON.stringify(u));
    const v = (
      await h.ok("eval", {
        readOnly: true,
        code: `const C = pack.cells; let wet = 0, other = 0; for (let c = 0; c < C.i.length; c++) if (C.h[c] >= 20 && C.biome[c] === 12 && C.p[c][0] < 840) { wet++; if (C.culture[c] !== 1) other++; } return {wet, other};`
      })
    ).value as Obj;
    assert.ok(v.wet > 50, JSON.stringify(v));
    assert.equal(v.other, 0, "every Wetland cell west of x 840, the new ones included, took culture 1");
    await h.ok("snapshot", { action: "undo" });
  });
});

describe("tupaia-mcp condpaint: rain shadow and climate smoothing (local)", () => {
  let h: Harness;

  async function biomes(): Promise<number[]> {
    return (await h.ok("eval", { readOnly: true, code: BIOME_ARRAY })).value as number[];
  }

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    await h.ok("load_map", { path: DEMO });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("rainShadow: winds from the map settings, deterministic, only lee cells dry, the grid's climate untouched", async () => {
    const climate = `{ let a = 0x811c9dc5; for (const v of grid.cells.prec) { a ^= v; a = Math.imul(a, 0x01000193); } for (const v of grid.cells.temp) { a ^= v & 255; a = Math.imul(a, 0x01000193); } return (a >>> 0).toString(36); }`;
    const climateBefore = (await h.ok("eval", { readOnly: true, code: climate })).value;
    // the app's own tier formula (public/main.js generatePrecipitation): by grid row i of cellsY
    const APP_TIER = `const tierOfRow = i => { const lat = mapCoordinates.latN - (i / grid.cellsY) * mapCoordinates.latT; return (Math.abs(lat - 89) / 30) | 0; };`;
    const winds = (
      await h.ok("eval", {
        readOnly: true,
        code: `${APP_TIER} const tiers = new Set(); const C = pack.cells; for (let c = 0; c < C.i.length; c++) if (C.h[c] >= 20) tiers.add(options.winds[tierOfRow(Math.floor(C.g[c] / grid.cellsX))]); return [...tiers].sort((a, b) => a - b);`
      })
    ).value as number[];
    // and per cell, the walk uses exactly the app's tier wind
    const mismatch = (
      await h.ok("eval", {
        readOnly: true,
        code: `${APP_TIER} const C = pack.cells; let bad = 0; for (let c = 0; c < C.i.length; c++) if (__tupaia.biomes.windAt(c) !== options.winds[tierOfRow(Math.floor(C.g[c] / grid.cellsX))]) bad++; return bad;`
      })
    ).value as number;
    assert.equal(mismatch, 0, "windAt follows generatePrecipitation's tier per grid row");

    const plain = await h.ok("regenerate", { parts: ["biomes"], biomes: { keepPainted: false } });
    const plainArr = await biomes();
    await h.ok("snapshot", { action: "undo" });

    const opts = { keepPainted: false, rainShadow: { strength: 2, maxDistance: 20, ridge: 50 } };
    const r = await h.ok("regenerate", { parts: ["biomes"], biomes: opts });
    const b = (r.details as Obj).biomes as Obj;
    assert.deepEqual(b.rainShadow.wind, winds, "the winds of the map's latitude tiers");
    assert.equal(b.rainShadow.windFrom, "map");
    assert.ok(b.rainShadow.shadowed > 0 && b.rainShadow.halved > 0, JSON.stringify(b.rainShadow));
    const shadowArr = await biomes();
    await h.ok("snapshot", { action: "undo" });
    assert.ok((plain.details as Obj).biomes.changed >= 0);

    // deterministic: the same call gives the same biomes
    await h.ok("regenerate", { parts: ["biomes"], biomes: opts });
    assert.deepEqual(await biomes(), shadowArr);
    await h.ok("snapshot", { action: "undo" });

    // every cell the shadow changed has a ridge (>= 50, above it) upwind within 20 grid cells, and is drier:
    // its moisture band (biome matrix row) is no wetter than without the shadow
    const changed = plainArr.map((v, i) => (v !== shadowArr[i] ? i : -1)).filter(i => i >= 0);
    assert.ok(changed.length > 10, `the shadow changed biomes (${changed.length})`);
    const check = (
      await h.ok("eval", {
        readOnly: true,
        args: { changed, plain: plainArr, shadow: shadowArr },
        code: `const C = pack.cells; const max = 20 * grid.spacing; let noRidge = 0, wetter = 0;
// the moisture rows (biome matrix rows) a biome takes at the cell's temperature column; hot desert
// is the driest and wetland the wettest outcome of Biomes.getId
const rows = (b, c) => { if (b === 1) return [0, 0]; if (b === 12) return [9, 9];
  const M = biomesData.biomesMatrix; const t = Math.min(Math.max(20 - grid.cells.temp[C.g[c]], 0), 25);
  const r = []; for (let k = 0; k < M.length; k++) if (M[k][t] === b) r.push(k); return r.length ? [Math.min(...r), Math.max(...r)] : null; };
for (const c of args.changed) {
  const [x0, y0] = C.p[c]; const ang = __tupaia.biomes.windAt(c) * Math.PI / 180;
  let ok = false;
  for (let d = grid.spacing * 0.5; d <= max && !ok; d += grid.spacing * 0.5) {
    const k = findCell(x0 - Math.sin(ang) * d, y0 + Math.cos(ang) * d);
    if (k !== undefined && C.h[k] >= 50 && C.h[k] > C.h[c]) ok = true;
  }
  if (!ok) noRidge++;
  const rp = rows(args.plain[c], c), rs = rows(args.shadow[c], c);
  if (rp && rs && rs[0] > rp[1]) wetter++;
}
return {noRidge, wetter, n: args.changed.length};`
      })
    ).value as Obj;
    // the walk samples the grid, this check samples pack cells: allow a few edge cases
    assert.ok(check.noRidge <= Math.max(2, check.n * 0.05), JSON.stringify(check));
    assert.equal(check.wetter, 0, JSON.stringify(check));

    // no room to look upwind, or strength 0: no shadow, the plain result
    for (const rs of [{ maxDistance: 0.1, unit: "px" }, { strength: 0 }]) {
      const z = await h.ok("regenerate", { parts: ["biomes"], biomes: { keepPainted: false, rainShadow: rs } });
      assert.equal(((z.details as Obj).biomes as Obj).rainShadow.shadowed, 0);
      assert.deepEqual(await biomes(), plainArr);
      await h.ok("snapshot", { action: "undo" });
    }

    // a fixed wind overrides the settings and moves the shadow
    const w = await h.ok("regenerate", {
      parts: ["biomes"],
      biomes: { ...opts, rainShadow: { ...opts.rainShadow, wind: 0 } }
    });
    assert.deepEqual(((w.details as Obj).biomes as Obj).rainShadow.wind, [0], "the wind is always a list");
    assert.equal(((w.details as Obj).biomes as Obj).rainShadow.windFrom, "fixed");
    assert.notDeepEqual(await biomes(), shadowArr);
    await h.ok("snapshot", { action: "undo" });

    assert.equal(
      (await h.ok("eval", { readOnly: true, code: climate })).value,
      climateBefore,
      "grid prec/temp unchanged"
    );
  });

  test("smoothClimate smooths the inputs (fewer biome patches); options are validated", async () => {
    const patches = `{ const C = pack.cells, B = C.biome, seen = new Uint8Array(C.i.length); let n = 0;
for (let s = 0; s < C.i.length; s++) { if (C.h[s] < 20 || seen[s]) continue; n++; const q = [s]; seen[s] = 1;
  for (let k = 0; k < q.length; k++) for (const j of C.c[q[k]]) if (!seen[j] && C.h[j] >= 20 && B[j] === B[s]) { seen[j] = 1; q.push(j); } }
return n; }`;
    await h.ok("regenerate", { parts: ["biomes"], biomes: { keepPainted: false } });
    const plain = (await h.ok("eval", { readOnly: true, code: patches })).value as number;
    await h.ok("snapshot", { action: "undo" });
    const r = await h.ok("regenerate", {
      parts: ["biomes"],
      biomes: { keepPainted: false, smoothClimate: { precipitation: 4, temperature: 4 } }
    });
    assert.deepEqual(((r.details as Obj).biomes as Obj).smoothClimate, { precipitation: 4, temperature: 4 });
    const smooth = (await h.ok("eval", { readOnly: true, code: patches })).value as number;
    await h.ok("snapshot", { action: "undo" });
    assert.ok(smooth < plain, `smoothed climate gives fewer biome patches (${smooth} < ${plain})`);

    const bad = async (biomesOpts: Obj) => {
      const x = await h.call("regenerate", { parts: ["biomes"], biomes: biomesOpts });
      assert.equal(x.isError, true, JSON.stringify(biomesOpts));
      return errorBody(x).error.code;
    };
    assert.equal(await bad({ rainShadow: { strenght: 1 } }), "BAD_ARGS"); // zod strictObject
    assert.equal(await bad({ from: "current", smooth: 1, rainShadow: true }), "BAD_ARGS");
    assert.equal(await bad({ smoothClimate: { precipitation: 1.5 } }), "BAD_ARGS");
  });
});

describe("tupaia-mcp condpaint in a sketch (one replayable op each)", () => {
  let h: Harness;
  let copy = "";

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    await h.ok("load_map", { path: DEMO });
    copy = (await h.ok("save_map", { path: "condpaint-base.map", overwrite: true })).path as string;
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("floodplain paint (where + feather) and rain-shadow regenerate log one replayable op each and replay exactly", async () => {
    await h.ok("sketch", { action: "start", slug: "t-condpaint" });
    const flood = await h.ok("paint_cells", {
      select: {
        where: {
          land: true,
          all: [{ riverDist: { lte: 2, minFlux: 300 } }, { aboveRiver: { lte: 4 } }, { slope: { lte: 4 } }],
          not: { noise: { scale: 120, seed: 3, lt: 0.25 } }
        }
      },
      set: { biome: "Wetland" },
      feather: { width: 3, unit: "cells", seed: 11 }
    });
    assert.ok(((flood.set as Obj).biome as Obj).changed > 20, JSON.stringify(flood.set));
    const regen = await h.ok("regenerate", {
      parts: ["biomes"],
      biomes: {
        rainShadow: { strength: 2, maxDistance: 20 },
        smoothClimate: { precipitation: 2 },
        select: { where: { height: { lte: 60 }, not: { biome: "Wetland" } } }
      }
    });
    assert.ok(((regen.details as Obj).biomes as Obj).changed > 0);
    const st = await h.ok("sketch", { action: "status" });
    const log = st.log as Obj[];
    assert.deepEqual(
      log.map(o => o.tool),
      ["paint_cells", BIOMES_OP]
    );
    assert.equal(st.blobOnly, false, JSON.stringify(st));
    assert.match(log[1].summary, /rain shadow strength 2.*climate smoothed/);
    const want = (await h.ok("eval", { readOnly: true, code: BIOME_ARRAY })).value as number[];

    const r = await h.ok("sketch", { action: "rebase", onto: { path: copy } }, 240_000);
    assert.equal(r.completed, true, JSON.stringify(r.conflicts));
    assert.deepEqual(r.applied, [1, 2]);
    const got = (await h.ok("eval", { readOnly: true, code: BIOME_ARRAY })).value as number[];
    let diff = 0;
    for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) diff++;
    assert.equal(diff, 0, "the replayed map has the sketch's biomes");
  });
});
