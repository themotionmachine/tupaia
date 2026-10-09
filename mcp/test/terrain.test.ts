// set_heights (terrain import) and flow (water-flow preview).
// Pure helpers of src/bridge-ext/terrain.js in node:vm on a tiny synthetic grid, then the tools
// on tests/fixtures/demo.map with synthetic height arrays: sources, dryRun, keep/risk, the
// rebuild without a sentinel, biomes, undo, what a re-pack carries over (routes, markers, burg
// cells, river ids and names, lake names), the sketch log and its replay (same graph on the
// same base; a regridded base is a conflict; a base whose burgs differ is noted; a base whose
// terrain was edited since keeps those edits), the summary's frame, and flow.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import vm from "node:vm";
import { REPLAY_EXT, sanitizeRecord, unreplayableReason } from "../src/ops.ts";
import "../src/tools/terrain.ts";
import { alive, DEMO_MAP, errorBody, type Harness, MCP_ROOT, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

// ---------------------------------------------------------------- pure (node:vm)

function loadPure(): Obj {
  const ctx = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    btoa,
    atob,
    Blob,
    Response,
    CompressionStream,
    DecompressionStream,
    pack: {},
    grid: {}
  });
  for (const f of ["bridge.js", "bridge-mutations.js", "bridge-ext/terrain.js"])
    vm.runInContext(fs.readFileSync(path.join(MCP_ROOT, "src", f), "utf8"), ctx, { filename: f });
  return (ctx.__tupaia as Obj).terrain.pure;
}

/** w x h cells, 8-neighbour, edge cells are border cells; heights row by row. */
function box(rows: number[][]) {
  const H = rows.length;
  const W = rows[0].length;
  const h = Uint8Array.from(rows.flat());
  const c: number[][] = [];
  const p: number[][] = [];
  const b = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      p.push([x * 10 + 5, y * 10 + 5]);
      b[i] = x === 0 || y === 0 || x === W - 1 || y === H - 1 ? 1 : 0;
      const n: number[] = [];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const X = x + dx;
          const Y = y + dy;
          if (X >= 0 && Y >= 0 && X < W && Y < H) n.push(Y * W + X);
        }
      c.push(n);
    }
  return { h, c, p, b, W };
}

const LIMITS = { elevationLimit: 20, maxIterations: 250 };

describe("terrain pure helpers", () => {
  const P = loadPure();

  test("fillDepressions raises an interior pit to its spill level and never touches water", () => {
    const g = box([
      [10, 10, 10, 10, 10],
      [10, 40, 40, 40, 10],
      [10, 40, 25, 40, 10],
      [10, 40, 40, 40, 10],
      [10, 10, 10, 10, 10]
    ]);
    assert.equal(P.countPits(g.h, g.c, g.b), 1);
    const f = P.fillDepressions(g.h, g.c, g.b);
    assert.equal(f.h[12], 40);
    assert.equal(f.raised, 1);
    assert.equal(f.maxRaise, 15);
    assert.equal(P.countPits(f.h, g.c, g.b), 0);
    for (let i = 0; i < g.h.length; i++) if (g.h[i] < 20) assert.equal(f.h[i], g.h[i]);
    assert.equal(P.fillDepressions(f.h, g.c, g.b).raised, 0, "filling is idempotent");
  });

  test("heightStats counts flips, land % and a newly formed lake", () => {
    const g = box([
      [10, 10, 10, 10, 10],
      [10, 40, 40, 40, 10],
      [10, 40, 40, 40, 10],
      [10, 40, 40, 40, 10],
      [10, 10, 10, 10, 10]
    ]);
    const next = Uint8Array.from(g.h);
    next[12] = 12; // a lake in the middle
    next[1] = 30; // a border cell becomes land
    const s = P.heightStats(g.h, next, g.c, g.b);
    assert.equal(s.changed, 2);
    assert.equal(s.toWater, 1);
    assert.equal(s.toLand, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(s.lakes)), { before: 0, after: 1, formed: 1 });
    assert.equal(s.landPct.before, 36);
  });

  test("base64 round trip of height bytes", () => {
    const u = Uint8Array.from({ length: 70000 }, (_, i) => i % 101);
    assert.deepEqual(Array.from(P.b64ToBytes(P.bytesToB64(u))), Array.from(u));
  });

  test("recorded changes: only the changed cells, with their previous heights, deflated", async () => {
    const before = Uint8Array.from({ length: 10000 }, (_, i) => (i * 7) % 90);
    const after = Uint8Array.from(before);
    for (const i of [3, 500, 9999]) after[i] = 100 - after[i];
    const enc = await P.encodeChanges(before, after);
    assert.equal(enc.changed, 3);
    assert.ok(enc.changes.length < 600, `a 3-cell change on 10k cells stays small: ${enc.changes.length} chars`);
    const dec = await P.decodeChanges(enc.changes, 10000);
    assert.equal(dec.changed, 3);
    assert.deepEqual(Array.from(dec.before), [before[3], before[500], before[9999]]);
    assert.equal(dec.after[500], after[500]);
    assert.equal(dec.after[501], 255, "unchanged");
    await assert.rejects(P.decodeChanges(enc.changes, 9000), /do not fit/);
  });

  test("flow: downhill to the sea, through an open lake, into a closed basin, off the map edge", () => {
    // sea on the left edge; land rises to the right; an open lake at (3,2) drains west
    const toSea = box([
      [5, 30, 40, 50, 60, 70, 80],
      [5, 30, 40, 50, 60, 70, 80],
      [5, 30, 40, 15, 60, 70, 80],
      [5, 30, 40, 50, 60, 70, 80],
      [5, 30, 40, 50, 60, 70, 80]
    ]);
    const G = P.graphFromHeights(toSea.h, toSea.c, toSea.p, toSea.b);
    const D = P.drainSurface(G, LIMITS);
    const t = P.traceFlow(G, D, 2 * 7 + 5);
    assert.equal(t.end.type, "sea", JSON.stringify(t));
    assert.equal(t.lakes.length, 1, "it ran through the lake");
    // a deep basin ringed by 90s: the lake is closed, water ends in it
    const basin = box([
      [5, 90, 90, 90, 90, 90, 90],
      [5, 90, 90, 90, 90, 90, 90],
      [5, 90, 90, 15, 60, 90, 90],
      [5, 90, 90, 90, 90, 90, 90],
      [5, 90, 90, 90, 90, 90, 90]
    ]);
    const G2 = P.graphFromHeights(basin.h, basin.c, basin.p, basin.b);
    const D2 = P.drainSurface(G2, LIMITS);
    assert.equal(D2.closed.size, 1, "the lake is in a deep depression");
    const t2 = P.traceFlow(G2, D2, 2 * 7 + 4);
    assert.equal(t2.end.type, "lake");
    assert.equal(t2.end.closed, true);
    // all land, highest in the middle: water pours off the nearest map edge
    const dome = box([
      [30, 30, 30, 30, 30],
      [30, 50, 50, 50, 30],
      [30, 50, 70, 50, 30],
      [30, 50, 50, 50, 30],
      [30, 30, 30, 30, 30]
    ]);
    const G3 = P.graphFromHeights(dome.h, dome.c, dome.p, dome.b);
    const t3 = P.traceFlow(G3, P.drainSurface(G3, LIMITS), 12);
    assert.equal(t3.end.type, "border");
    assert.equal(t3.path.length, 3);
  });

  test("flow: a start on the map border drains to its lowest neighbour like the generator (no river there yet)", () => {
    const g = box([
      [5, 60, 70, 80, 90],
      [5, 30, 40, 50, 80],
      [5, 30, 40, 45, 60],
      [5, 30, 40, 50, 80],
      [5, 60, 70, 80, 90]
    ]);
    const G = P.graphFromHeights(g.h, g.c, g.p, g.b);
    const t = P.traceFlow(G, P.drainSurface(G, LIMITS), 14); // the right edge, h 60
    assert.equal(t.end.type, "sea", JSON.stringify(t));
    assert.ok(t.path.length > 2);
    assert.equal(g.b[t.path[1]], 0, "it went inland, not off the edge");
  });
});

describe("set_heights replay spec", () => {
  test("recorded height changes are replayable; a record without them is not", () => {
    const good = {
      changes: "AAAA",
      changed: 2,
      cells: 3,
      gridDigest: "3:3x1:x",
      baseDigest: "b",
      heightsDigest: "y",
      options: { rebuild: "risk", erosion: false, keepHeights: true, biomes: "redefine" },
      graphAfter: "5:z",
      bbox: [10, 20, 110, 220],
      stats: { changed: 2, toLand: 1, toWater: 0, lakesFormed: 1, landPct: 40 }
    };
    assert.equal(unreplayableReason("set_heights", good as never), null);
    assert.match(String(unreplayableReason("set_heights", { cells: 3 } as never)), /no recorded height changes/);
    const rec = sanitizeRecord({ tool: "set_heights", seq: 1, resolved: good }, 0);
    assert.equal(rec.replayable, true);
    assert.match(
      rec.summary,
      /Set heights \(2 grid cells changed, 1 to land, 0 to water, 1 lake formed; land 40%\) in 10,20,110,220; rebuild risk, erosion off, biomes redefine/
    );
    assert.deepEqual(REPLAY_EXT.set_heights.frame?.(good as never), {
      bbox: [10, 20, 110, 220],
      label: "set_heights, 2 grid cells changed",
      layers: ["heightmap"]
    });
  });
});

// ---------------------------------------------------------------- tools on demo.map

describe("set_heights and flow on demo.map", () => {
  let h: Harness;
  let base: number[] = [];
  let pts: number[][] = [];
  let n = 0;
  const ev = async (code: string, args?: unknown) => (await h.ok("eval", { readOnly: true, code, args })).value as any;
  const digest = () => ev("return __tupaia.fns.digest().hash");
  const graph = () => ev("return __tupaia.cellGraph()");
  /** base heights with land raised inside circles and water/land set inside others. */
  const shaped = (spots: Array<{ x: number; y: number; r: number; set?: number; add?: number }>) =>
    base.map((v, i) => {
      for (const s of spots)
        if (Math.hypot(pts[i][0] - s.x, pts[i][1] - s.y) < s.r)
          return s.set !== undefined ? s.set : v >= 20 ? Math.min(100, v + (s.add ?? 0)) : v;
      return v;
    });
  let spots: { land: number[]; coast: { x: number; y: number }; burg: Obj } = {
    land: [],
    coast: { x: 0, y: 0 },
    burg: {}
  };

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    await h.ok("load_map", { path: DEMO_MAP });
    base = await ev("return Array.from(grid.cells.h)");
    pts = await ev("return grid.points");
    n = base.length;
    spots = await ev(`
      const C = pack.cells;
      const land = [...C.i].filter(c => C.h[c] >= 40 && !C.burg[c] && C.t[c] > 2);
      const coast = [...C.i].find(c => C.t[c] === 1 && C.h[c] >= 20 && !C.burg[c] && C.c[c].every(k => !C.burg[k]));
      const b = pack.burgs.find(b => b && b.i && !b.removed && !b.capital && C.t[b.cell] >= 2);
      return { land: C.p[land[Math.floor(land.length / 2)]], coast: { x: C.p[coast][0], y: C.p[coast][1] },
        burg: { i: b.i, x: b.x, y: b.y, cell: b.cell } };`);
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("source checks: exactly one source; a dense array of the wrong length names the expected length", async () => {
    const none = await h.call("set_heights", {});
    assert.equal(errorBody(none).error.code, "BAD_ARGS");
    const two = await h.call("set_heights", { grid: base, pack: { 1: 30 } });
    assert.match(errorBody(two).error.message, /exactly one height source/);
    const short = await h.call("set_heights", { grid: base.slice(0, 100) });
    const e = errorBody(short).error as Obj;
    assert.equal(e.code, "BAD_ARGS");
    assert.match(e.message, new RegExp(`grid has 100 values; this map's grid has ${n} cells`));
    assert.match(e.message, /grid\.points/, "the message says where the grid geometry is");
    const bad = await h.call("set_heights", { pack: { abc: 30 } });
    assert.equal(errorBody(bad).error.code, "BAD_ARGS");
    assert.match(errorBody(bad).error.message, /'abc' is not a pack cell id/);
    const empty = await h.ok("set_heights", { pack: {}, dryRun: true });
    assert.match(JSON.stringify((empty.source as Obj).warnings), /pack is empty/);
  });

  test("dryRun counts changes, flips, lakes and fill, and changes nothing", async () => {
    const d0 = await digest();
    const next = shaped([
      { x: spots.land[0], y: spots.land[1], r: 25, set: 12 }, // an inland lake
      { x: spots.coast.x, y: spots.coast.y, r: 30, set: 35 } // the coast pushed out to sea
    ]);
    const r = await h.ok("set_heights", { grid: next, fill: true, dryRun: true });
    assert.equal(r.dryRun, true);
    assert.ok((r.changed as number) > 0);
    assert.ok((r.toWater as number) > 0, "the lake cells become water");
    assert.ok((r.toLand as number) > 0, "the coast moves out");
    assert.ok(((r.lakes as Obj).formed as number) >= 1, JSON.stringify(r.lakes));
    assert.equal((r.pits as Obj).after, 0, "fill leaves no pits");
    assert.ok((r.fill as Obj).cellsRaised >= 0);
    assert.deepEqual(r.options, {
      rebuild: "risk",
      erosion: false,
      keepHeights: true,
      biomes: "redefine",
      rivers: "regenerate"
    });
    const g = r.grid as Obj;
    assert.equal(g.cells, n);
    assert.ok(g.cellsX > 0 && g.cellsY > 0 && g.spacing > 0, JSON.stringify(g));
    assert.ok(typeof (r.paintedBiomes as Obj | undefined)?.cells === "number" || r.paintedBiomes === undefined);
    assert.ok(((r.rivers as Obj).now as number) > 0);
    // detail lists the cells: pits without fill, raised cells with it
    const raw = await h.ok("set_heights", { grid: next, dryRun: true, detail: true });
    assert.equal((raw.pitCells as Obj[]).length, Math.min(50, (raw.pits as Obj).after as number));
    const filled = await h.ok("set_heights", { grid: next, fill: true, dryRun: true, detail: true });
    assert.deepEqual(filled.pitCells, []);
    const fc = (filled.filledCells as Obj[]) ?? [];
    assert.equal(fc.length, Math.min(100, (filled.fill as Obj).cellsRaised as number));
    if (fc.length) assert.ok(fc[0].raise >= 1 && Array.isArray(fc[0].at));
    // a burg where the heights put water: named, and what happens to it
    const drown = await h.ok("set_heights", {
      grid: shaped([{ x: spots.burg.x, y: spots.burg.y, r: 12, set: 5 }]),
      dryRun: true
    });
    const bw = drown.burgsOnNewWater as Obj;
    assert.ok(bw.count >= 1, JSON.stringify(drown).slice(0, 400));
    assert.ok((bw.burgs as string[]).some(x => x.includes(`(${spots.burg.i})`)));
    assert.match(bw.effect, /height 20/);
    assert.equal(await digest(), d0, "dry run changed nothing");
  });

  test("rebuild 'keep' refuses a coastline change and keeps cell ids for land-only changes", async () => {
    const coastal = shaped([{ x: spots.coast.x, y: spots.coast.y, r: 30, set: 35 }]);
    const bad = await h.call("set_heights", { grid: coastal, rebuild: "keep" });
    assert.equal(errorBody(bad).error.code, "REFUSED");
    assert.match(errorBody(bad).error.message, /cross height 20/);
    const g0 = await graph();
    const hill = shaped([{ x: spots.land[0], y: spots.land[1], r: 40, add: 20 }]);
    const r = await h.ok("set_heights", { grid: hill, rebuild: "keep" }, 240_000);
    assert.equal(r.cellsRenumbered, false);
    assert.equal(await graph(), g0);
    const check = await ev(
      "const C = pack.cells; let bad = 0; for (const i of C.i) if (C.h[i] !== grid.cells.h[C.g[i]]) bad++; return { bad, same: grid.cells.h.every((v, i) => v === args[i]) };",
      hill
    );
    assert.deepEqual(check, { bad: 0, same: true });
    await h.ok("snapshot", { action: "undo" }, 240_000);
  });

  test("the rebuild runs with unchanged heights (no sentinel), biomes are redefined; biomes:'keep' keeps painted ones; one undo reverts", async () => {
    const d0 = await digest();
    // paint a land patch tundra (an odd biome for it), then import the very same heights
    const paint = await h.ok("paint_cells", {
      select: { circle: { at: { x: spots.burg.x, y: spots.burg.y }, radius: 20 }, where: { land: true } },
      set: { biome: "Tundra" }
    });
    assert.ok(((paint.set as Obj).biome as Obj).changed > 0);
    const tundra = await ev("return biomesData.name.indexOf('Tundra')");
    const at = { x: spots.burg.x, y: spots.burg.y };
    const keep = await h.ok("set_heights", { grid: base, biomes: "keep" }, 240_000);
    assert.equal(keep.changed, 0);
    assert.ok(keep.features, "the rebuild ran");
    assert.equal(await ev(`return pack.cells.biome[findCell(${at.x}, ${at.y})]`), tundra, "biomes:'keep' kept it");
    const r = await h.ok("set_heights", { grid: base }, 240_000);
    assert.equal(r.changed, 0, "no height changed");
    assert.match(JSON.stringify(r.notes), /rebuild:'risk' re-ran features/);
    assert.notEqual(await ev(`return pack.cells.biome[findCell(${at.x}, ${at.y})]`), tundra, "biomes redefined");
    assert.ok(r.changes, "changes are reported");
    assert.ok(!Array.isArray((r.changes as Obj).burg?.modified), "changes are counts only");
    await h.ok("snapshot", { action: "undo", n: 3 }, 240_000);
    assert.equal(await digest(), d0);
  });

  test("erosion:true cuts river beds; keepHeights (default) puts the requested heights back", async () => {
    const d0 = await digest();
    const packVsGrid =
      "const C = pack.cells; let d = 0; for (const i of C.i) if (C.h[i] >= 20 && C.h[i] !== grid.cells.h[C.g[i]]) d++; return d;";
    const kept = await h.ok("set_heights", { grid: base, erosion: true }, 240_000);
    assert.ok((kept.heightsRestored as number) > 0, "erosion changed some land heights");
    assert.equal(await ev(packVsGrid), 0, "every land cell has the requested height");
    await h.ok("snapshot", { action: "undo" }, 240_000);
    await h.ok("set_heights", { grid: base, erosion: true, keepHeights: false }, 240_000);
    assert.ok((await ev(packVsGrid)) > 0, "without keepHeights the eroded heights stay");
    await h.ok("snapshot", { action: "undo" }, 240_000);
    assert.equal(await digest(), d0);
  });

  test("a risk rebuild carries routes, markers, burg cells, river ids and names and lake names to the new cells", async () => {
    const d0 = await digest();
    const consistency = `
      const C = pack.cells;
      let badLinks = 0; for (const [k, v] of Object.entries(C.routes)) for (const nb of Object.keys(v)) if (!C.c[+k]?.includes(+nb)) badLinks++;
      let routeCells = 0; for (const r of pack.routes) for (const p of r.points) if (!(p[2] >= 0 && p[2] < C.i.length) || Math.hypot(C.p[p[2]][0] - p[0], C.p[p[2]][1] - p[1]) > 3 * grid.spacing) routeCells++;
      let markers = 0; for (const m of pack.markers) if (Math.hypot(C.p[m.cell][0] - m.x, C.p[m.cell][1] - m.y) > 3 * grid.spacing) markers++;
      const burgs = pack.burgs.filter(b => b.i && !b.removed);
      return { badLinks, routeCells, markers, burgCellsOff: burgs.filter(b => C.burg[b.cell] !== b.i).length,
        connected: burgs.filter(b => Routes.isConnected(b.cell)).length };`;
    const c0 = await ev(consistency);
    assert.equal(c0.badLinks, 0);
    // an undoable eval (the names and notes are part of what undo restores)
    const named = (
      await h.ok("eval", {
        code: `
      const r = pack.rivers.filter(r => r.cells.length > 8).sort((a, b) => b.cells.length - a.cells.length)[0];
      r.name = 'Spire';
      const l = pack.features.find(f => f && f.type === 'lake' && f.cells > 2);
      l.name = 'Lake Tupaia';
      // a short river inside a patch the import floods: it is gone afterwards
      const C = pack.cells;
      const small = pack.rivers.find(x => x.i !== r.i && x.cells.length >= 3 && x.cells.length <= 6 && x.cells.every(c => c >= 0 && C.h[c] >= 25));
      notes.push({ id: 'river' + r.i, name: 'The Spire', legend: '' }, { id: 'river' + small.i, name: 'Brook note', legend: '' });
      const pts = small.cells.map(c => C.p[c]);
      const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      const rad = Math.max(...pts.map(p => Math.hypot(p[0] - cx, p[1] - cy))) + 2 * grid.spacing;
      return { river: r.i, lake: l.i, small: small.i, at: { x: cx, y: cy, r: rad } };`
      })
    ).value as Obj;
    // an identity import re-packs the cells: everything still lines up, names and ids carry over
    const same = await h.ok("set_heights", { grid: base }, 240_000);
    const rv = same.rivers as Obj;
    assert.ok(rv.kept >= rv.before - 3, JSON.stringify(rv));
    assert.ok(((same.carried as Obj).routes as number) > 0 && ((same.carried as Obj).markers as number) > 0);
    const c1 = await ev(consistency);
    assert.deepEqual(c1, c0, "routes, markers and burgs line up with the new cells as before");
    const kept = await ev(
      "return { spire: pack.rivers.filter(r => r.name === 'Spire').map(r => r.i), lake: pack.features.filter(f => f && f.name === 'Lake Tupaia').length }"
    );
    assert.deepEqual(kept, { spire: [named.river], lake: 1 }, "the river keeps its id and name, the lake its name");
    const rm = await h.call("edit", { type: "route", ops: [{ ref: 0, remove: true }] });
    assert.ok(!rm.isError, `removing a route works after the rebuild: ${JSON.stringify(rm.content[0]).slice(0, 300)}`);
    // flood the short river's patch: it is gone, and its note is reported
    const flooded = await h.ok(
      "set_heights",
      { grid: shaped([{ x: named.at.x, y: named.at.y, r: named.at.r, set: 8 }]) },
      240_000
    );
    const fr = flooded.rivers as Obj;
    assert.ok(fr.gone >= 1, JSON.stringify(fr));
    assert.ok((fr.notesOrphaned as string[]).includes(`river${named.small} Brook note`), JSON.stringify(fr));
    assert.match(JSON.stringify(flooded.notes), /notes belong to rivers that are gone/);
    const c2 = await ev(consistency);
    assert.equal(c2.badLinks, 0);
    assert.equal(c2.burgCellsOff, 0);
    assert.equal(await ev("return pack.rivers.find(r => r.name === 'Spire')?.i"), named.river);
    await h.ok("snapshot", { action: "undo", n: 4 }, 240_000);
    assert.equal(await digest(), d0);
  });

  test("paint_cells height rebuild:'risk' carries routes the same way", async () => {
    const d0 = await digest();
    const p = await h.ok(
      "paint_cells",
      {
        select: { circle: { at: { x: spots.coast.x, y: spots.coast.y }, radius: 40 } },
        set: { height: { delta: 6, rebuild: "risk" } }
      },
      240_000
    );
    assert.ok((((p.set as Obj).height as Obj).carried as Obj).routes > 0, JSON.stringify(p.set));
    const bad = await ev(
      "const C = pack.cells; let n = 0; for (const [k, v] of Object.entries(C.routes)) for (const nb of Object.keys(v)) if (!C.c[+k]?.includes(+nb)) n++; return n;"
    );
    assert.equal(bad, 0);
    const rm = await h.call("edit", { type: "route", ops: [{ ref: 1, remove: true }] });
    assert.ok(!rm.isError, JSON.stringify(rm.content[0]).slice(0, 300));
    await h.ok("snapshot", { action: "undo", n: 2 }, 240_000);
    assert.equal(await digest(), d0);
  });

  test("pack and image sources", async () => {
    const cells = await ev(
      "const C = pack.cells; const out = {}; let k = 0; for (const i of C.i) if (C.h[i] >= 30 && k++ < 40) out[i] = 70; return out;"
    );
    const p = await h.ok("set_heights", { pack: cells, dryRun: true });
    assert.equal((p.source as Obj).from, "pack");
    assert.ok((p.changed as number) > 0 && (p.changed as number) <= 40);
    assert.equal(p.toLand, 0);
    // a left-to-right gradient: black (left) is sea, white (right) the highest land
    const dataUrl = await ev(
      "const c = document.createElement('canvas'); c.width = 64; c.height = 32; const x = c.getContext('2d'); const g = x.createLinearGradient(0, 0, 64, 0); g.addColorStop(0, '#000'); g.addColorStop(1, '#fff'); x.fillStyle = g; x.fillRect(0, 0, 64, 32); return c.toDataURL('image/png');"
    );
    const img = await h.ok("set_heights", { image: { dataUrl, range: [5, 95] }, dryRun: true });
    assert.equal((img.source as Obj).from, "image");
    assert.equal((img.source as Obj).width, 64);
    const pct = (img.landPct as Obj).after as number;
    assert.ok(pct > 70 && pct < 90, `about 83% of the map is above 20: ${pct}`);
    // the same image from a file path, inverted: the land is now on the left
    const file = path.join(h.env.TUPAIA_OUT, "gradient.png");
    fs.writeFileSync(file, Buffer.from(String(dataUrl).split(",")[1], "base64"));
    const inv = await h.ok("set_heights", { image: { path: file, range: [5, 95], invert: true }, dryRun: true });
    assert.ok(Math.abs(((inv.landPct as Obj).after as number) - pct) < 3);
    const bad = await h.call("set_heights", { image: { path: path.join(h.env.TUPAIA_OUT, "nope.png") } });
    assert.equal(errorBody(bad).error.code, "NOT_FOUND");
  });

  test("flow previews where water runs, on current and proposed heights, without changing the map", async () => {
    const d0 = await digest();
    const undoBefore = ((await h.ok("snapshot", { action: "list" })).undo as unknown[] | undefined)?.length;
    const cur = await h.ok("flow", {
      from: [{ entity: { type: "burg", ref: spots.burg.i } }, { x: spots.land[0], y: spots.land[1] }]
    });
    const paths = cur.paths as Obj[];
    assert.equal(paths.length, 2);
    for (const p of paths) {
      assert.ok(["sea", "lake", "river", "border", "pit"].includes(p.end.type), JSON.stringify(p.end));
      assert.ok(p.length.px >= 0);
      assert.equal(p.points, undefined, "points only with detail");
    }
    // proposed: a deep basin around the start (its rim more than the lake elevation limit above
    // the lake) is a closed lake, so the water stays in it
    const at = { x: spots.land[0], y: spots.land[1] };
    const pit = shaped([
      { x: at.x, y: at.y, r: 12, set: 12 },
      { x: at.x, y: at.y, r: 30, set: 40 },
      { x: at.x, y: at.y, r: 70, set: 85 }
    ]);
    const prop = await h.ok("flow", { from: { x: at.x + 18, y: at.y }, heights: { grid: pit }, detail: true });
    assert.match(String(prop.on), /grid cells/);
    const pp = (prop.paths as Obj[])[0];
    assert.equal(pp.end.type, "lake", JSON.stringify(pp));
    assert.equal(pp.end.lake, "a new lake");
    assert.equal(pp.end.closed, true);
    // a lake whose shore is above 79 counts as open in the generator (lake height + the elevation
    // limit tops 99): the water runs through it and leaves by its lowest shore cell
    const open = shaped([
      { x: at.x, y: at.y, r: 12, set: 12 },
      { x: at.x, y: at.y, r: 30, set: 85 }
    ]);
    const op = (await h.ok("flow", { from: at, heights: { grid: open } })).paths as Obj[];
    assert.notEqual(op[0].end.type, "lake", JSON.stringify(op[0]));
    assert.deepEqual(op[0].throughLakes, ["a new lake"], JSON.stringify(op[0]));
    assert.ok(Array.isArray(pp.cells) && Array.isArray(pp.points));
    // fill:true fills nothing that is water already: the lake stays
    const filled = await h.ok("flow", { from: { x: at.x + 15, y: at.y }, heights: { grid: pit }, fill: true });
    assert.equal((filled.paths as Obj[])[0].end.type, "lake");
    // screenshot: an image, and the overlay is gone afterwards
    const shot = await h.call("flow", { from: { x: spots.land[0], y: spots.land[1] }, screenshot: true });
    assert.ok(!shot.isError, JSON.stringify(shot.content[0]).slice(0, 300));
    assert.ok(shot.content.some(c => c.type === "image"));
    assert.equal(await ev("return document.querySelectorAll('#tupaiaFlow').length"), 0);
    assert.equal(await digest(), d0, "flow changed nothing");
    const undoAfter = ((await h.ok("snapshot", { action: "list" })).undo as unknown[] | undefined)?.length;
    assert.equal(undoAfter, undoBefore, "no undo entry");
  });

  test("flow on proposed heights starts at the nearest grid cell (even where the map is open sea now), takes {gridCell}; a joined river says where it goes; lengths in the map's unit", async () => {
    const d0 = await digest();
    const [gw, gh] = (await ev("return [graphWidth, graphHeight]")) as number[];
    const deep = base.findIndex(
      (v, i) =>
        v < 10 &&
        pts[i][0] > 150 &&
        pts[i][1] > 150 &&
        pts[i][0] < gw - 150 &&
        pts[i][1] < gh - 150 &&
        base.every((u, j) => u < 20 || Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]) > 100)
    );
    assert.ok(deep >= 0, "demo.map has open sea away from land");
    const [cx, cy] = pts[deep];
    const island = shaped([
      { x: cx, y: cy, r: 30, set: 60 },
      { x: cx, y: cy, r: 70, set: 35 }
    ]);
    const at = { x: cx + 9, y: cy + 4 };
    let want = 0;
    for (let i = 1; i < n; i++)
      if (Math.hypot(pts[i][0] - at.x, pts[i][1] - at.y) < Math.hypot(pts[want][0] - at.x, pts[want][1] - at.y))
        want = i;
    const f = await h.ok("flow", { from: [at, { gridCell: want }], heights: { grid: island }, screenshot: true });
    const [p1, p2] = f.paths as Obj[];
    assert.equal(p1.from.cell, want, JSON.stringify(p1.from));
    assert.equal(p1.from.snapped, undefined, "within a cell of the asked point");
    assert.equal(p1.from.h, island[want]);
    assert.equal(p2.from.cell, want);
    assert.equal(p1.end.type, "sea", JSON.stringify(p1.end));
    assert.match(String(f.legend), /green tint = becomes land/);
    assert.equal(await ev("return document.querySelectorAll('#tupaiaFlow').length"), 0);
    // a start on an existing river (current map): the river, and where its water finally goes
    const onRiver = await ev(
      "const C = pack.cells; const r = pack.rivers.find(r => r.cells.length > 6 && r.cells.slice(0, -1).every(c => c >= 0 && C.h[c] >= 20)); return { cell: r.cells[2], i: r.i };"
    );
    const rf = ((await h.ok("flow", { from: { cell: onRiver.cell } })).paths as Obj[])[0];
    assert.equal(rf.end.type, "river");
    assert.equal(rf.steps, 0);
    assert.ok(["sea", "lake", "border"].includes(rf.end.goesTo?.type), JSON.stringify(rf.end));
    assert.match(String(rf.end.goesTo.river), /\(\d+\)$/);
    // lengths: km always, plus the map's own unit
    const unit0 = await ev("return document.getElementById('distanceUnitInput').value");
    try {
      await ev("document.getElementById('distanceUnitInput').value = 'mi'; return 1");
      const mi = ((await h.ok("flow", { from: at, heights: { grid: island } })).paths as Obj[])[0];
      assert.ok(mi.length.km > 0 && mi.length.mi > 0, JSON.stringify(mi.length));
      assert.ok(Math.abs(mi.length.km / mi.length.mi - 1.609) < 0.05);
      await ev("document.getElementById('distanceUnitInput').value = 'lg'; return 1");
      const lg = ((await h.ok("flow", { from: at, heights: { grid: island } })).paths as Obj[])[0];
      assert.ok(lg.length.km > 0 && lg.length.lg > 0, JSON.stringify(lg.length));
    } finally {
      await ev("document.getElementById('distanceUnitInput').value = args; return 1", unit0);
    }
    assert.equal(await digest(), d0, "flow changed nothing");
  });

  describe("sketch log and replay", () => {
    const files = { base: "", regrid: "", burg: "", other: "" };
    let next: number[] = [];
    let graphAfter = "";

    before(async () => {
      const out = h.env.TUPAIA_OUT;
      await h.ok("load_map", { path: DEMO_MAP });
      files.base = (await h.ok("save_map", { path: path.join(out, "terrain-base.map"), overwrite: true }))
        .path as string;
      // a regridded copy: one grid point moved (the grid digest differs)
      await h.ok("eval", { code: "grid.points[0][0] += 0.5; return 1;" });
      files.regrid = (await h.ok("save_map", { path: path.join(out, "terrain-regrid.map"), overwrite: true }))
        .path as string;
      await h.ok("load_map", { path: files.base });
      // an inland lake sunk into the land, the coast pushed out to sea
      next = shaped([
        { x: spots.land[0], y: spots.land[1], r: 14, set: 12 },
        { x: spots.coast.x, y: spots.coast.y, r: 30, set: 35 }
      ]);
      // someone else's copy has a burg where the sketch sinks the lake: the rebuild keeps that
      // cell land (height 20), so the replayed heights and cell graph differ
      await h.ok("eval", {
        code: "const id = Burgs.add([args.x, args.y]); pack.burgs[id].name = 'Driftwood'; return id;",
        args: { x: spots.land[0], y: spots.land[1] }
      });
      files.burg = (await h.ok("save_map", { path: path.join(out, "terrain-burg.map"), overwrite: true }))
        .path as string;
      await h.ok("load_map", { path: files.base });
    });

    test("set_heights, a risk paint and a keep import replay onto the same base to the same cells and heights", async () => {
      await h.ok("sketch", { action: "start", slug: "t-terrain" });
      const r = await h.ok("set_heights", { grid: next, fill: true }, 240_000);
      assert.equal(r.cellsRenumbered, true);
      graphAfter = await graph();
      // op 2: a literal cell list on the new graph
      const st = await ev("return pack.states.find(s => s.i && !s.removed).i");
      await h.ok("paint_cells", {
        select: { circle: { at: { x: spots.burg.x, y: spots.burg.y }, radius: 25 } },
        set: { state: st }
      });
      // op 3: a paint_cells height rebuild (risk) is replayable too (it records the graph it built)
      await h.ok(
        "paint_cells",
        {
          select: { circle: { at: { x: spots.coast.x, y: spots.coast.y }, radius: 40 } },
          set: { height: { delta: 4, rebuild: "risk" } }
        },
        240_000
      );
      const g3 = await graph();
      assert.notEqual(g3, graphAfter);
      // op 4: a land-only import that keeps the cells
      const now = (await ev("return Array.from(grid.cells.h)")) as number[];
      const hill = now.map((v, i) =>
        v >= 20 && Math.hypot(pts[i][0] - spots.burg.x, pts[i][1] - spots.burg.y) < 40 ? Math.min(100, v + 3) : v
      );
      const k = await h.ok("set_heights", { grid: hill, rebuild: "keep" }, 240_000);
      assert.equal(k.cellsRenumbered, false);
      const want = await ev("return __tupaia.fns.digest().cells");
      const s = await h.ok("sketch", { action: "status", full: true });
      assert.equal(s.blobOnly, false, JSON.stringify(s.blobOnlyReasons));
      const recs = s.records as Obj[];
      assert.deepEqual(
        recs.map(x => x.tool),
        ["set_heights", "paint_cells", "paint_cells", "set_heights"]
      );
      assert.match(recs[0].summary, /Set heights from grid/);
      assert.equal(recs[0].args.grid, `<${n} grid heights>`, "the log keeps a description, not the array");
      const res = recs[0].resolved as Obj;
      assert.equal(res.cells, n);
      assert.equal(res.graphAfter, graphAfter);
      assert.equal(typeof res.baseDigest, "string");
      assert.ok(res.changed > 0 && res.changed < n, JSON.stringify({ changed: res.changed }));
      assert.ok(
        res.changes.length < 4000,
        `only the changed cells are recorded (deflated): ${res.changes.length} chars`
      );
      assert.ok(Array.isArray(res.bbox) && res.bbox.length === 4);
      assert.equal(recs[1].resolved.graph, graphAfter, "the paint refers to the rebuilt graph");
      assert.equal(recs[2].resolved.graphAfter, g3, "the risk paint records the graph it built");
      const reb = await h.ok("sketch", { action: "rebase", onto: { path: files.base } }, 400_000);
      assert.equal(reb.completed, true, JSON.stringify(reb.conflicts));
      assert.deepEqual(reb.applied, [1, 2, 3, 4]);
      assert.equal(await graph(), g3, "same heights on the same grid give the same cells");
      assert.deepEqual(await ev("return __tupaia.fns.digest().cells"), want, "same heights, biomes, rivers, owners");
      assert.ok(!JSON.stringify(reb.notes ?? []).includes("another cell graph"));
    });

    test("a base with a burg on new sea: the import applies with a note, ops on the old cells conflict", async () => {
      const reb = await h.ok("sketch", { action: "rebase", onto: { path: files.burg }, onConflict: "skip" }, 400_000);
      // op 4 (the keep import) sets only its own cells, on top of what this base now holds
      assert.deepEqual(reb.applied, [1, 4]);
      const notes = JSON.stringify(reb.notes);
      assert.match(notes, /op 1: set_heights rebuilt another cell graph/);
      assert.doesNotMatch(notes, /op 1: set_heights: the target's heights differ/, "a burg changes no heights");
      assert.match(notes, /op 4: set_heights: the target's heights differ/, "ops 2-3 were skipped here");
      const conflicts = reb.conflicts as Obj[];
      assert.deepEqual(
        conflicts.map(c => c.seq),
        [2, 3]
      );
      assert.match(conflicts[0].reason, /renumbered/);
      assert.match(conflicts[1].reason, /renumbered/);
      const drift = await ev(
        "const b = pack.burgs.find(b => b && b.name === 'Driftwood'); return { found: !!b, removed: !!b?.removed, h: b ? pack.cells.h[b.cell] : null };"
      );
      assert.equal(drift.found, true);
      assert.equal(drift.removed, false, "the burg keeps its cell as land");
      assert.ok(drift.h >= 20);
    });

    test("a regridded base is a conflict", async () => {
      // the sketch now holds ops 1 and 4 (the skipped paints left the log)
      const reb = await h.ok("sketch", { action: "rebase", onto: { path: files.regrid } }, 400_000);
      assert.equal(reb.completed, false);
      const conflicts = reb.conflicts as Obj[];
      assert.equal(conflicts[0]?.seq, 1, JSON.stringify(reb).slice(0, 500));
      assert.match(conflicts[0].reason, /CONFLICT: the heights were recorded on another grid/);
    });

    test("replay onto a map whose terrain was edited since keeps those edits: only the op's cells are set, and the replay says so; the summary frames on the changed area", async () => {
      await h.ok("sketch", { action: "stop" });
      await h.ok("load_map", { path: files.base });
      // someone else raises a hill near the burg
      await h.ok("paint_cells", {
        select: { circle: { at: { x: spots.burg.x, y: spots.burg.y }, radius: 30 }, where: { land: true } },
        set: { height: { delta: 15 } }
      });
      const otherH = (await ev("return Array.from(grid.cells.h)")) as number[];
      files.other = (
        await h.ok("save_map", { path: path.join(h.env.TUPAIA_OUT, "terrain-other.map"), overwrite: true })
      ).path as string;
      await h.ok("load_map", { path: files.base });
      await h.ok("sketch", { action: "start", slug: "t-terrain-2" });
      // the sketch lifts one inland cell far from that hill by 3 (keep)
      const cell = await ev(
        "const C = pack.cells; return [...C.i].find(c => C.h[c] >= 40 && C.h[c] <= 90 && Math.hypot(C.p[c][0] - args.x, C.p[c][1] - args.y) > 150);",
        spots.burg
      );
      const ph = await ev(`return pack.cells.h[${cell}]`);
      await h.ok("set_heights", { pack: { [cell]: ph + 3 }, rebuild: "keep" }, 240_000);
      const g = await ev(`return pack.cells.g[${cell}]`);
      const gNew = await ev(`return grid.cells.h[${g}]`);
      const rec = ((await h.ok("sketch", { action: "status", full: true })).records as Obj[])[0].resolved as Obj;
      assert.equal(rec.changed, 1);
      assert.ok(rec.changes.length < 200, `a one-cell change is tiny in the log: ${rec.changes.length} chars`);
      const sum = await h.ok("sketch", { action: "summary", shots: false });
      assert.equal((sum.framedOn as Obj)?.type, "set_heights", JSON.stringify(sum.framedOn));
      const reb = await h.ok("sketch", { action: "rebase", onto: { path: files.other } }, 400_000);
      assert.deepEqual(reb.applied, [1], JSON.stringify(reb.conflicts));
      assert.match(
        JSON.stringify(reb.notes),
        /op 1: set_heights: the target's heights differ .*only the op's 1 changed grid cells were set/
      );
      const want = otherH.slice();
      want[g] = gNew;
      assert.deepEqual(
        await ev("return Array.from(grid.cells.h)"),
        want,
        "the other edit stays; the sketch's cell is set"
      );
    });
  });
});
