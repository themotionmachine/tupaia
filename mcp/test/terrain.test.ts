// set_heights (terrain import) and flow (water-flow preview).
// Pure helpers of src/bridge-ext/terrain.js in node:vm on a tiny synthetic grid, then the tools
// on tests/fixtures/demo.map with synthetic height arrays: sources, dryRun, keep/risk, the
// rebuild without a sentinel, biomes, undo, the sketch log and its replay (same graph on the
// same base; a regridded base is a conflict; a base whose burgs differ is noted), and flow.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import vm from "node:vm";
import { sanitizeRecord, unreplayableReason } from "../src/ops.ts";
import "../src/tools/terrain.ts";
import { alive, DEMO_MAP, errorBody, type Harness, MCP_ROOT, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

// ---------------------------------------------------------------- pure (node:vm)

function loadPure(): Obj {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, btoa, atob, pack: {}, grid: {} });
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
    assert.equal(t3.cells.length, 3);
  });
});

describe("set_heights replay spec", () => {
  test("a recorded heights array is replayable; one without is not", () => {
    const good = {
      heights: "AAAA",
      cells: 3,
      gridDigest: "3:3x1:x",
      heightsDigest: "y",
      options: { rebuild: "risk", erosion: false, keepHeights: true, biomes: "redefine" },
      graphAfter: "5:z"
    };
    assert.equal(unreplayableReason("set_heights", good as never), null);
    assert.match(String(unreplayableReason("set_heights", { cells: 3 } as never)), /no recorded heights/);
    const rec = sanitizeRecord({ tool: "set_heights", seq: 1, resolved: good }, 0);
    assert.equal(rec.replayable, true);
    assert.match(rec.summary, /Set heights .*rebuild risk, erosion off, biomes redefine/);
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
    const e = errorBody(short).error;
    assert.equal(e.code, "BAD_ARGS");
    assert.match(e.message, new RegExp(`grid has 100 values; this map's grid has ${n} cells`));
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
    assert.ok((r.fill as Obj).raised >= 0);
    assert.deepEqual(r.options, { rebuild: "risk", erosion: false, keepHeights: true, biomes: "redefine" });
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

  describe("sketch log and replay", () => {
    const files = { base: "", regrid: "", burg: "" };
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
      assert.equal(Buffer.from(res.heights, "base64").length, n);
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
      assert.deepEqual(reb.applied, [1]);
      assert.match(JSON.stringify(reb.notes), /op 1: set_heights rebuilt another cell graph/);
      const conflicts = reb.conflicts as Obj[];
      assert.deepEqual(
        conflicts.map(c => c.seq),
        [2, 3, 4]
      );
      assert.match(conflicts[0].reason, /renumbered/);
      assert.match(conflicts[1].reason, /renumbered/);
      assert.match(conflicts[2].reason, /cross height 20/, "the keep import would sink the burg's cell");
      const drift = await ev(
        "const b = pack.burgs.find(b => b && b.name === 'Driftwood'); return { found: !!b, removed: !!b?.removed, h: b ? pack.cells.h[b.cell] : null };"
      );
      assert.equal(drift.found, true);
      assert.equal(drift.removed, false, "the burg keeps its cell as land");
      assert.ok(drift.h >= 20);
    });

    test("a regridded base is a conflict", async () => {
      // the sketch now holds op 1 only (the skipped paint left the log)
      const reb = await h.ok("sketch", { action: "rebase", onto: { path: files.regrid } }, 400_000);
      assert.equal(reb.completed, false);
      const conflicts = reb.conflicts as Obj[];
      assert.equal(conflicts[0]?.seq, 1, JSON.stringify(reb).slice(0, 500));
      assert.match(conflicts[0].reason, /CONFLICT: the heights were recorded on another grid/);
    });
  });
});
