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

  test("conditions work in every select: regenerate biomes select, add zone select", async () => {
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
    const winds = (
      await h.ok("eval", {
        readOnly: true,
        code: `const tiers = new Set(); for (const p of pack.cells.p) { const lat = mapCoordinates.latN - (p[1] / graphHeight) * mapCoordinates.latT; tiers.add(options.winds[Math.min(5, (Math.abs(lat - 89) / 30) | 0)]); } return [...tiers].sort((a, b) => a - b);`
      })
    ).value as number[];

    const plain = await h.ok("regenerate", { parts: ["biomes"], biomes: { keepPainted: false } });
    const plainArr = await biomes();
    await h.ok("snapshot", { action: "undo" });

    const opts = { keepPainted: false, rainShadow: { strength: 2, maxDistance: 20, ridge: 50 } };
    const r = await h.ok("regenerate", { parts: ["biomes"], biomes: opts });
    const b = (r.details as Obj).biomes as Obj;
    assert.deepEqual(b.rainShadow.wind, winds, "the winds of the map's latitude tiers");
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
  const [x0, y0] = C.p[c]; const lat = mapCoordinates.latN - (y0 / graphHeight) * mapCoordinates.latT;
  const ang = options.winds[Math.min(5, (Math.abs(lat - 89) / 30) | 0)] * Math.PI / 180;
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
    assert.equal(((w.details as Obj).biomes as Obj).rainShadow.wind, 0);
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
