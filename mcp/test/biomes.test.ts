// Biomes track: edit/add/find type 'biome', the save/load fix for icon density, icons and cost
// (the app bug: every reload reset them), regenerate {parts:['biomes']} with edge noise and
// smoothing, feathered biome painting, and sketch replay of all of them (ids shift when the
// target map gained its own custom biome). Local mode, demo.map, no network.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { type IdMap, type OpRecord, Rewriter, rewriteResolved, unreplayableReason } from "../src/ops.ts";
import { bridgeArgs } from "../src/replay.ts";
import { BIOMES_OP } from "../src/tools/biomes.ts";
import { alive, errorBody, type Harness, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

const DEMO = "tests/fixtures/demo.map";
const HOT_DESERT_ICONS = { dune: 3, cactus: 6, deadTree: 1 };

/** Biome array of the page, and its hash, read in the page. */
const BIOME_ARRAY = "Array.from(pack.cells.biome)";
const HASH_BIOMES = `{ let h = 0x811c9dc5; for (const b of pack.cells.biome) { h ^= b; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }`;

describe("tupaia-mcp biomes (local)", () => {
  let h: Harness;
  let out = "";

  async function biome(ref: string | number): Promise<Obj> {
    const r = await h.ok("find", {
      type: "biome",
      ...(typeof ref === "number" ? { where: { i: ref } } : { name: ref, match: "exact" }),
      fields: ["color", "habitability", "iconsDensity", "icons", "cost", "custom"]
    });
    return (r.rows as Obj[])[0];
  }

  async function code(name: string, args: Record<string, unknown>): Promise<string> {
    const r = await h.call(name, args);
    assert.equal(r.isError, true, `${name} should fail: ${JSON.stringify(args)}`);
    return errorBody(r).error.code;
  }

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    out = fs.realpathSync(h.env.TUPAIA_OUT);
    await h.ok("load_map", { path: DEMO });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("find and inspect biomes; fuzzy names give candidates", async () => {
    const f = await h.ok("find", { type: "biome" });
    assert.equal(f.total, 13);
    const rows = f.rows as Obj[];
    assert.deepEqual(rows.map(r => r.name).slice(0, 4), ["Marine", "Hot desert", "Cold desert", "Savanna"]);
    assert.deepEqual(Object.keys(rows[1]).sort(), [
      "cells",
      "color",
      "cost",
      "custom",
      "habitability",
      "i",
      "iconsDensity",
      "name"
    ]);
    assert.equal(rows[1].cost, 200);
    assert.equal(rows[1].custom, false);
    const miss = await h.call("find", { type: "biome", name: "Savana" });
    assert.equal(errorBody(miss).error.code, "NOT_FOUND");
    assert.equal(errorBody(miss).error.candidates?.[0]?.name, "Savanna");
    const ins = await h.ok("inspect", { entity: { type: "biome", ref: "Hot desert" } });
    assert.equal(ins.i, 1);
    assert.deepEqual((ins.entity as Obj).icons, HOT_DESERT_ICONS);
    assert.equal(typeof (ins.relations as Obj).cells, "number");
  });

  test("add biome copies its base; explicit fields win; invalid items change nothing", async () => {
    const a = await h.ok("add", {
      type: "biome",
      items: [
        { name: "Glass desert", base: "Hot desert", color: "#ECDCAE", habitability: 4 },
        { name: "Ash plain", color: "rgb(136, 136, 136)" }
      ]
    });
    const created = a.created as Obj[];
    assert.deepEqual(
      created.map(c => [c.i, c.name]),
      [
        [13, "Glass desert"],
        [14, "Ash plain"]
      ]
    );
    const g = await biome("Glass desert");
    assert.deepEqual(
      { ...g },
      {
        i: 13,
        name: "Glass desert",
        color: "#ecdcae",
        habitability: 4,
        iconsDensity: 3,
        icons: HOT_DESERT_ICONS,
        cost: 200,
        custom: true
      }
    );
    const ash = await biome("Ash plain");
    assert.deepEqual([ash.color, ash.habitability, ash.iconsDensity, ash.icons, ash.cost], ["#888888", 50, 0, {}, 50]);
    // the dry-run plan shows the values the new biome would get (base copy + explicit fields)
    const plan = await h.ok("add", {
      type: "biome",
      dryRun: true,
      items: [{ name: "Salt flats", base: "Cold desert", color: "Teal" }]
    });
    const row = (plan.plan as Obj[])[0];
    assert.deepEqual(
      [row.i, row.name, row.base, row.color, row.habitability, row.iconsDensity, row.icons, row.cost],
      [15, "Salt flats", "Cold desert", "#008080", 10, 2, { dune: 9, deadTree: 1 }, 150]
    );
    // icon density with no icons would draw missing relief symbols
    assert.equal(await code("add", { type: "biome", items: [{ name: "Bare", iconsDensity: 5 }] }), "BAD_ARGS");
    // invalid items: nothing changes
    assert.equal(await code("add", { type: "biome", items: [{ name: "glass DESERT" }] }), "REFUSED");
    assert.equal(await code("add", { type: "biome", items: [{ name: "Salt, flats" }] }), "BAD_ARGS");
    assert.equal(await code("add", { type: "biome", items: [{ name: "removed" }] }), "BAD_ARGS");
    assert.equal(await code("add", { type: "biome", items: [{ name: "X", color: "not-a-colour" }] }), "BAD_ARGS");
    assert.equal(await code("add", { type: "biome", items: [{ name: "X", icons: { cactis: 2 } }] }), "BAD_ARGS");
    assert.equal(await code("add", { type: "biome", items: [{ name: "X", speed: 2 }] }), "BAD_FIELD");
    assert.equal(await code("add", { type: "biome", items: [{ name: "X" }, { name: "x" }] }), "REFUSED");
    assert.equal(((await h.ok("find", { type: "biome", limit: 0 })) as Obj).total, 15);
  });

  test("edit biome fields; remove and duplicate names are refused", async () => {
    const e = await h.ok("edit", {
      type: "biome",
      ops: [
        { ref: "Glass desert", set: { iconsDensity: 40, icons: { dune: 2, cactus: 1 }, cost: 300 } },
        { ref: "Savanna", set: { cost: 75, icons: ["acacia", "grass", "grass"] } }
      ]
    });
    const applied = e.applied as Obj[];
    assert.deepEqual(applied[0].before, { iconsDensity: 3, icons: HOT_DESERT_ICONS, cost: 200 });
    assert.deepEqual(applied[0].after, { iconsDensity: 40, icons: { dune: 2, cactus: 1 }, cost: 300 });
    assert.deepEqual(applied[1].after, { cost: 75, icons: { acacia: 1, grass: 2 } });
    assert.match(JSON.stringify(e.notes), /relief icons/);
    const mod = ((e.changes as Obj).biome.modified as Obj[]).find(m => m.i === 13) as Obj;
    assert.deepEqual(Object.keys(mod.fields).sort(), ["cost", "icons", "iconsDensity"]);
    assert.equal(await code("edit", { type: "biome", ops: [{ ref: 13, remove: true }] }), "REFUSED");
    assert.equal(await code("edit", { type: "biome", ops: [{ ref: 14, set: { name: "Glass desert" } }] }), "REFUSED");
    assert.equal(await code("edit", { type: "biome", ops: [{ ref: 14, set: { iconsDensity: 9000 } }] }), "BAD_ARGS");
    // icon density needs icons (Ash plain has none); emptying the icons of a dense biome too
    assert.equal(
      await code("edit", { type: "biome", ops: [{ ref: "Ash plain", set: { iconsDensity: 9 } }] }),
      "BAD_ARGS"
    );
    assert.equal(await code("edit", { type: "biome", ops: [{ ref: 13, set: { icons: {} } }] }), "BAD_ARGS");
    const dry = await h.ok("edit", {
      type: "biome",
      dryRun: true,
      ops: [{ ref: "Ash plain", set: { iconsDensity: 9, icons: { grass: 1 } } }]
    });
    assert.equal((dry.plan as Obj[])[0].after.iconsDensity, 9);
    // habitability re-ranks the cells of that biome only, keeps burgs, refreshes state totals
    const SNAP =
      "[Array.from(pack.cells.pop), Array.from(pack.cells.biome), pack.burgs.reduce((s, b) => s + (b && b.population || 0), 0)]";
    const [pop0, biomes0, burgs0] = (await h.ok("eval", { readOnly: true, code: SNAP })).value as [
      number[],
      number[],
      number
    ];
    const hab = await h.ok("edit", {
      type: "biome",
      ops: [{ ref: "Temperate rainforest", set: { habitability: 10 } }]
    });
    assert.match(JSON.stringify(hab.notes), /re-ranked its \d+ land cells: rural population [\d,]+ -> [\d,]+ people/);
    const [pop1, , burgs1] = (await h.ok("eval", { readOnly: true, code: SNAP })).value as [number[], number[], number];
    let own0 = 0;
    let own1 = 0;
    for (let i = 0; i < pop0.length; i++) {
      if (biomes0[i] === 8) {
        own0 += pop0[i];
        own1 += pop1[i];
      } else assert.equal(pop1[i], pop0[i], `cell ${i} (biome ${biomes0[i]}) kept its population`);
    }
    assert.ok(own1 < own0, `rural population of the rainforest fell (${own0} -> ${own1})`);
    assert.equal(burgs1, burgs0, "burgs untouched");
    const STALE = `const r = new Map(); pack.cells.i.forEach(i => { if (pack.cells.h[i] >= 20) r.set(pack.cells.state[i], (r.get(pack.cells.state[i]) || 0) + pack.cells.pop[i]); });
        return pack.states.filter(s => s && !s.removed).reduce((m, s) => Math.max(m, Math.abs((s.rural || 0) - (r.get(s.i) || 0))), 0);`;
    const stale = await h.ok("eval", { readOnly: true, code: STALE });
    assert.ok((stale.value as number) < 0.01, `state rural totals follow the cells (max diff ${stale.value})`);
    await h.ok("snapshot", { action: "undo" });
    // regenerate population refreshes the state totals too
    await h.ok("regenerate", { parts: ["population"] });
    const stale2 = await h.ok("eval", { readOnly: true, code: STALE });
    assert.ok(
      (stale2.value as number) < 0.01,
      `state rural totals after regenerate population (max diff ${stale2.value})`
    );
    await h.ok("snapshot", { action: "undo" });
    assert.equal((await biome("Temperate rainforest")).habitability, 90);
  });

  test("the reload bug: icon density, icons and cost survive save/load and undo (4th field); old files load as before", async () => {
    // undo restores the map from its saved text: before the fix every undo reset these
    await h.ok("edit", {
      type: "biome",
      ops: [{ ref: "Ash plain", set: { cost: 333, iconsDensity: 12, icons: { grass: 1 } } }]
    });
    await h.ok("edit", { type: "map", ops: [{ set: { name: "Undo probe" } }] });
    await h.ok("snapshot", { action: "undo" });
    let ash = await biome("Ash plain");
    assert.deepEqual([ash.cost, ash.iconsDensity], [333, 12], "undo kept the biome values");

    const saved = await h.ok("save_map", { path: "biomes-new.map", overwrite: true });
    const text = fs.readFileSync(saved.path as string, "utf8");
    const line = text.split("\r\n")[3];
    const fields = line.split("|");
    assert.equal(fields.length, 4, "the biome line has a 4th field");
    const extra = JSON.parse(fields[3]);
    assert.equal(extra.iconsDensity[13], 40);
    assert.equal(extra.cost[13], 300);
    assert.deepEqual(extra.icons[13], ["dune", "dune", "cactus"]);
    assert.equal(extra.cost[3], 75, "edits of default biomes are kept too");

    await h.ok("load_map", { path: DEMO });
    await h.ok("load_map", { path: saved.path as string });
    const g = await biome("Glass desert");
    assert.deepEqual([g.iconsDensity, g.icons, g.cost], [40, { dune: 2, cactus: 1 }, 300]);
    ash = await biome("Ash plain");
    assert.deepEqual([ash.cost, ash.iconsDensity], [333, 12]);
    assert.equal((await biome("Savanna")).cost, 75);

    // an older file (no 4th field): today's behaviour, custom biomes get 0 / none / 50
    const old = text.replace(line, fields.slice(0, 3).join("|"));
    const oldPath = path.join(out, "biomes-old.map");
    fs.writeFileSync(oldPath, old);
    await h.ok("load_map", { path: oldPath });
    const og = await biome("Glass desert");
    assert.deepEqual([og.color, og.habitability, og.iconsDensity, og.icons, og.cost], ["#ecdcae", 4, 0, {}, 50]);
    assert.equal((await biome("Savanna")).cost, 60);
    await h.ok("load_map", { path: saved.path as string });
  });

  test("regenerate biomes without noise equals the app's Biomes.define, cell for cell", async () => {
    const define = await h.ok("eval", {
      readOnly: true,
      code: `const keep = Uint8Array.from(pack.cells.biome);
        Biomes.define();
        const out = Array.from(pack.cells.biome);
        pack.cells.biome = keep;
        return out;`
    });
    const expected = define.value as number[];
    const current = (await h.ok("eval", { readOnly: true, code: BIOME_ARRAY })).value as number[];
    const differ = expected.filter((b, i) => b !== current[i]).length;
    const dry = await h.ok("regenerate", { parts: ["biomes"], dryRun: true, biomes: { keepPainted: false } });
    assert.equal(dry.dryRun, true);
    assert.equal((dry.details as Obj).biomes.changed, differ);
    // the same cells painted away from the climate count as painted (and are kept by default)
    const def = await h.ok("regenerate", { parts: ["biomes"], dryRun: true });
    assert.equal(
      (def.details as Obj).biomes.keptBy?.painted ?? 0,
      differ - expected.filter((b, i) => b !== current[i] && current[i] >= 13).length
    );
    await h.ok("regenerate", { parts: ["biomes"], biomes: { keepPainted: false } });
    const got = (await h.ok("eval", { readOnly: true, code: BIOME_ARRAY })).value as number[];
    assert.deepEqual(got, expected);
    for (const mode of ["warp", "jitter"]) {
      const z = await h.ok("regenerate", {
        parts: ["biomes"],
        dryRun: true,
        biomes: { noise: 0, mode, keepPainted: false }
      });
      assert.equal((z.details as Obj).biomes.changed, 0, `noise 0 (${mode}) is the climate`);
    }
    await h.ok("snapshot", { action: "undo" });
  });

  test("regenerate biomes with noise and smoothing: deterministic per seed, keeps custom and listed biomes", async () => {
    // paint some cells with the custom biome first; keepPainted (default) leaves them
    const paint = await h.ok("paint_cells", {
      select: { circle: { at: { x: 900, y: 420 }, radius: 60 }, where: { land: true } },
      set: { biome: "Glass desert" }
    });
    const painted = ((paint.set as Obj).biome as Obj).changed as number;
    assert.ok(painted > 5, `painted ${painted}`);
    const wet0 = await h.ok("eval", { readOnly: true, code: "pack.cells.biome.filter(b => b === 12).length" });

    const opts = { noise: 0.8, smooth: 2, seed: 42, keep: ["Wetland"] };
    const r1 = await h.ok("regenerate", { parts: ["biomes"], biomes: opts });
    const d1 = (r1.details as Obj).biomes as Obj;
    assert.equal(d1.seed, 42);
    assert.ok(d1.changed > 0, JSON.stringify(d1));
    assert.ok(d1.kept >= painted + (wet0.value as number), `kept ${d1.kept}`);
    assert.equal(d1.resolved, undefined, "the literal form goes to the log, not the client");
    const check = await h.ok("eval", {
      readOnly: true,
      code: "[pack.cells.biome.filter(b => b === 13).length, pack.cells.biome.filter(b => b === 12).length]"
    });
    assert.ok((check.value as number[])[0] >= painted, "custom-biome cells kept");
    assert.ok((check.value as number[])[1] >= (wet0.value as number), "Wetland cells kept");
    const hash1 = (await h.ok("eval", { readOnly: true, code: HASH_BIOMES })).value;

    await h.ok("snapshot", { action: "undo" });
    await h.ok("regenerate", { parts: ["biomes"], biomes: opts });
    assert.equal((await h.ok("eval", { readOnly: true, code: HASH_BIOMES })).value, hash1, "same seed, same biomes");
    await h.ok("snapshot", { action: "undo" });
    await h.ok("regenerate", { parts: ["biomes"], biomes: { ...opts, seed: 43 } });
    assert.notEqual((await h.ok("eval", { readOnly: true, code: HASH_BIOMES })).value, hash1, "another seed differs");
    await h.ok("snapshot", { action: "undo" });

    // select: nothing outside it changes
    const before = (await h.ok("eval", { readOnly: true, code: BIOME_ARRAY })).value as number[];
    await h.ok("regenerate", {
      parts: ["biomes"],
      biomes: { noise: 1, seed: 5, select: { circle: { at: { x: 500, y: 400 }, radius: 150 } } }
    });
    const inside = (
      await h.ok("eval", {
        readOnly: true,
        code: "const s = new Set(__tupaia.fns.selectCells({select:{circle:{at:{x:500,y:400},radius:150}}, limit: 100000}).cells); return Array.from(pack.cells.biome).map((b, i) => s.has(i) ? -1 : b);"
      })
    ).value as number[];
    inside.forEach((b, i) => {
      if (b !== -1) assert.equal(b, before[i], `cell ${i} outside the selection changed`);
    });
    await h.ok("snapshot", { action: "undo" });

    // from:'current' only smooths
    const sm = await h.ok("regenerate", { parts: ["biomes"], dryRun: true, biomes: { from: "current", smooth: 3 } });
    assert.equal((sm.details as Obj).biomes.from, "current");
    assert.equal(
      await code("regenerate", { parts: ["biomes"], biomes: { from: "current", noise: 0.5, smooth: 1 } }),
      "BAD_ARGS"
    );
    assert.equal(await code("regenerate", { parts: ["rivers"], biomes: { noise: 0.5 } }), "BAD_ARGS");
    assert.equal(await code("regenerate", { parts: ["biomes", "population"], dryRun: true }), "BAD_ARGS");
    assert.equal(await code("regenerate", { parts: ["biomes"], biomes: { keep: ["Nowhere"] } }), "NOT_FOUND");
    // unknown option keys are refused, not ignored
    assert.equal((await h.call("regenerate", { parts: ["biomes"], biomes: { nois: 0.5 } })).isError, true);
  });

  test("painted default biomes, excluded cells and river cells survive a noisy regenerate", async () => {
    const CIRCLE = { circle: { at: { x: 640, y: 300 }, radius: 70 }, where: { land: true } };
    const cellsOf = async (sel: Obj) =>
      (
        await h.ok("eval", {
          readOnly: true,
          code: `return __tupaia.fns.selectCells({select: ${JSON.stringify(sel)}, limit: 100000}).cells;`
        })
      ).value as number[];
    const dry = async (biomes: Obj) =>
      ((await h.ok("regenerate", { parts: ["biomes"], dryRun: true, biomes })).details as Obj).biomes as Obj;
    // hand-paint a default biome (Hot desert) where the climate gives something else
    const p = await h.ok("paint_cells", { select: CIRCLE, set: { biome: "Hot desert" } });
    const painted = ((p.set as Obj).biome as Obj).changed as number;
    assert.ok(painted > 10, `painted ${painted}`);
    const paintedCells = await cellsOf(CIRCLE);
    const opts = { noise: 0.6, smooth: 2, seed: 9 };
    const whole = await dry(opts);
    assert.ok(whole.keptBy.painted >= painted, JSON.stringify(whole.keptBy));
    assert.match(JSON.stringify(whole.notes), /differ from their climate biome/);
    // kept cells are kept whatever the scope: none of the painted cells changes
    assert.equal((await dry({ ...opts, select: { cells: paintedCells } })).changed, 0);
    // keepPainted:'custom' (custom biomes only) re-derives most of them
    const loose = await dry({ ...opts, keepPainted: "custom", select: { cells: paintedCells } });
    assert.equal(loose.keptBy?.painted, undefined);
    assert.ok(loose.changed > painted / 2, `re-derived ${loose.changed} of ${painted}`);
    await h.ok("snapshot", { action: "undo" }); // the paint

    // exclude: a locked area keeps its biomes
    const EX = { circle: { at: { x: 500, y: 400 }, radius: 120 } };
    assert.ok((await dry({ noise: 1, smooth: 1, seed: 5, select: EX })).changed > 0, "the area would change");
    const ex = await dry({ noise: 1, smooth: 1, seed: 5, select: EX, exclude: EX });
    assert.equal(ex.changed, 0);
    assert.ok(ex.keptBy.excluded > 0);

    // smoothing and small-region merging leave river cells alone (keepRivers, default)
    const rivers = (
      await h.ok("eval", { readOnly: true, code: "pack.cells.i.filter(i => pack.cells.r[i] && pack.cells.h[i] >= 20)" })
    ).value as number[];
    assert.ok(rivers.length > 20);
    const CLEAN = { from: "current", smooth: 3, minRegion: 6, keepPainted: "custom" };
    assert.equal((await dry({ ...CLEAN, select: { cells: rivers } })).changed, 0);
    // minRegion merges small free regions (no river or custom cell, a mergeable neighbour)
    const SMALL = `const C = pack.cells, seen = new Uint8Array(C.i.length); let n = 0;
      for (const s of C.i) { if (C.h[s] < 20 || seen[s]) continue; const list = [s]; seen[s] = 1;
        for (let q = 0; q < list.length; q++) for (const j of C.c[list[q]]) if (C.h[j] >= 20 && !seen[j] && C.biome[j] === C.biome[s]) { seen[j] = 1; list.push(j); }
        if (list.length >= 6 || list.some(c => C.r[c] || C.biome[c] >= 13)) continue;
        if (list.some(c => C.c[c].some(j => C.h[j] >= 20 && C.biome[j] !== C.biome[s] && C.biome[j] < 13))) n++; }
      return n;`;
    const small0 = (await h.ok("eval", { readOnly: true, code: SMALL })).value as number;
    const sm = await h.ok("regenerate", { parts: ["biomes"], biomes: CLEAN });
    const smd = (sm.details as Obj).biomes as Obj;
    assert.ok(smd.changed > 0 && smd.merged > 0, JSON.stringify(smd));
    const small1 = (await h.ok("eval", { readOnly: true, code: SMALL })).value as number;
    assert.ok(small1 < small0 / 4, `small free regions ${small0} -> ${small1}`);
    await h.ok("snapshot", { action: "undo" });

    // jitter is the other noise mode; both are deterministic per seed
    const w = await dry({ noise: 0.6, seed: 4 });
    const j1 = await dry({ noise: 0.6, seed: 4, mode: "jitter" });
    const j2 = await dry({ noise: 0.6, seed: 4, mode: "jitter" });
    assert.equal(w.mode, "warp");
    assert.deepEqual(j1, j2);
    assert.notDeepEqual(w.net, j1.net);
  });

  test("feathered biome paint dithers the boundary and is deterministic", async () => {
    const args = {
      select: { circle: { at: { x: 640, y: 420 }, radius: 100 } },
      set: { biome: "Ash plain" },
      feather: { width: 60, seed: 7 }
    };
    const dry1 = await h.ok("paint_cells", { ...args, dryRun: true });
    const dry2 = await h.ok("paint_cells", { ...args, dryRun: true });
    assert.deepEqual(dry1.feather, dry2.feather);
    const f = dry1.feather as Obj;
    assert.ok(f.band > 0 && f.addedOutside > 0 && f.droppedInside > 0, JSON.stringify(f));
    const p = await h.ok("paint_cells", args);
    assert.deepEqual(p.feather, f);
    const geo = await h.ok("eval", {
      readOnly: true,
      code: `const C = pack.cells; let outside = 0, holes = 0;
        for (const i of C.i) { if (C.h[i] < 20) continue;
          const d = Math.hypot(C.p[i][0] - 640, C.p[i][1] - 420);
          if (d > 100 && C.biome[i] === 14) outside++;
          if (d < 100 && C.biome[i] !== 14) holes++;
          if (d > 131 && C.biome[i] === 14) return 'painted beyond the band at ' + i; }
        return [outside, holes];`
    });
    const [outside, holes] = geo.value as number[];
    assert.ok(outside > 0, "some cells outside the circle got the biome");
    assert.ok(holes > 0, "some cells inside the circle kept theirs");
    // unit 'cells' and refusals
    const dc = await h.ok("paint_cells", { ...args, feather: { width: 3, unit: "cells" }, dryRun: true });
    assert.equal((dc.feather as Obj).widthCells, 3);
    assert.equal(
      await code("paint_cells", { ...args, set: { state: 1 }, feather: { width: 30 } }),
      "BAD_ARGS",
      "feather is biome-only"
    );
    const thin = await h.ok("paint_cells", { ...args, feather: { width: 2 }, dryRun: true });
    assert.equal((thin.feather as Obj).band, 0);
    assert.match(JSON.stringify(thin.notes), /below the cell spacing/);
    await h.ok("snapshot", { action: "undo" });
  });
});

describe("tupaia-mcp biomes in a sketch (replay remaps biome ids)", () => {
  let h: Harness;
  let other = "";

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "40" });
    // "someone else" adds a custom biome first, so the sketch's new biome gets another id there
    await h.ok("load_map", { path: DEMO });
    await h.ok("add", { type: "biome", items: [{ name: "Their biome", color: "#123456" }] });
    other = (await h.ok("save_map", { path: "other-biome.map", overwrite: true })).path as string;
    await h.ok("load_map", { path: DEMO });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("add/edit/feathered paint/regenerate biomes are logged replayable and replay with biome 13 -> 14", async () => {
    await h.ok("sketch", { action: "start", slug: "t-biomes" });
    const add = await h.ok("add", {
      type: "biome",
      items: [{ name: "Glass desert", base: "Hot desert", color: "#ecdcae" }]
    });
    assert.equal((add.created as Obj[])[0].i, 13);
    await h.ok("edit", { type: "biome", ops: [{ ref: 13, set: { iconsDensity: 40, cost: 250 } }] });
    await h.ok("paint_cells", {
      select: { circle: { at: { x: 900, y: 420 }, radius: 80 } },
      set: { biome: 13 },
      feather: { width: 50 }
    });
    await h.ok("regenerate", { parts: ["biomes"], biomes: { noise: 0.6, smooth: 1, seed: 3 } });
    await h.ok("paint_cells", {
      select: { circle: { at: { x: 500, y: 400 }, radius: 40 } },
      set: { biome: "Savanna" }
    });
    const st = await h.ok("sketch", { action: "status" });
    const log = st.log as Obj[];
    assert.deepEqual(
      log.map(o => o.tool),
      ["add", "edit", "paint_cells", BIOMES_OP, "paint_cells"]
    );
    assert.equal(st.blobOnly, false, JSON.stringify(st));
    assert.match(log[3].summary, /Regenerated biomes .*warp noise 0\.6.*seed 3.*cells changed/);
    const sum = await h.ok("sketch", { action: "summary", shots: false });
    assert.match(sum.markdown as string, /\| biomes \| 13 \| 14 \| \+1 \|/);
    const sketchPage = (await h.ok("eval", { readOnly: true, code: BIOME_ARRAY })).value as number[];

    // a combined regenerate is not replayable (blob-only) until undone
    await h.ok("regenerate", { parts: ["biomes", "population"] });
    assert.equal((await h.ok("sketch", { action: "status" })).blobOnly, true);
    await h.ok("snapshot", { action: "undo" });
    assert.equal((await h.ok("sketch", { action: "status" })).blobOnly, false);

    const r = await h.ok("sketch", { action: "rebase", onto: { path: other } }, 240_000);
    assert.equal(r.completed, true, JSON.stringify(r.conflicts));
    assert.deepEqual(r.applied, [1, 2, 3, 4, 5]);
    assert.deepEqual((r.idMap as IdMap).biome, { "13": 14 });
    const ev = await h.ok("eval", {
      readOnly: true,
      code: `[biomesData.name[13], biomesData.name[14], biomesData.iconsDensity[14], biomesData.cost[14], ${BIOME_ARRAY}]`
    });
    const [n13, n14, dens, cost, cells] = ev.value as [string, string, number, number, number[]];
    assert.deepEqual([n13, n14, dens, cost], ["Their biome", "Glass desert", 40, 250]);
    const rebased = (await h.ok("sketch", { action: "status" })).log as Obj[];
    assert.match(rebased[3].summary, /seed 3/, "the rebased log keeps the seed");
    const expected = sketchPage.map(b => (b === 13 ? 14 : b));
    let diff = 0;
    for (let i = 0; i < expected.length; i++) if (cells[i] !== expected[i]) diff++;
    assert.equal(diff, 0, "the replayed map has the sketch's biomes, with 13 mapped to 14");
  });
});

describe("biomes ops log (pure)", () => {
  test("regenerate:biomes rewrites created biome ids, paint rewrites set.biome", () => {
    const rw = new Rewriter({ biome: { "13": 14 } }, new Set(["biome:13"]));
    const reg = { cells: { "13": [5, 6], "3": [7] }, graph: "g", seed: 3 };
    const out = rewriteResolved(BIOMES_OP, reg as never, rw) as unknown as { cells: Record<string, number[]> };
    assert.deepEqual(out.cells, { "14": [5, 6], "3": [7] });
    assert.deepEqual(bridgeArgs(BIOMES_OP, out as never), { cells: { "14": [5, 6], "3": [7] }, seed: 3 });
    assert.equal(unreplayableReason(BIOMES_OP, reg as never), null);
    assert.match(String(unreplayableReason(BIOMES_OP, null)), /literal cell list/);
    const paint = rewriteResolved("paint_cells", { select: { cells: [1] }, set: { biome: 13 } }, rw) as Obj;
    assert.equal(paint.set.biome, 14);
    const rec: Pick<OpRecord, "tool"> = { tool: BIOMES_OP };
    assert.equal(rec.tool, "regenerate:biomes");
  });
});
