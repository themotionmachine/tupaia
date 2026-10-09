// Cross-family tests for the final integration (dx/integrate) of family a (regen, biomes, relief,
// terrain, regrid), family b (routes, rivers, clear, compact, apply) and family c (tokens, labels,
// settings, lint, http). Each test covers a place where two families meet. The local layer runs
// on tests/fixtures/demo.map; the sketch end-to-end runs against the in-process fake Worker
// (test/fake-worker.ts on 127.0.0.1, as test/sketch.test.ts does), never the live site.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { FakeWorker } from "./fake-worker.ts";
import { alive, DEMO_MAP, type Harness, MCP_ROOT, REPO_ROOT, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

describe("integrate: replay specs (pure)", () => {
  test("every tool module imports together and no tool name holds two replay specs", async () => {
    // registerReplayable throws on a second spec for one tool, so importing every module proves it
    const dir = path.join(MCP_ROOT, "src", "tools");
    for (const f of fs.readdirSync(dir).sort())
      if (f.endsWith(".ts") && f !== "registry.ts") await import(path.join(dir, f));
    const { REPLAY_EXT } = await import("../src/ops.ts");
    assert.deepEqual(Object.keys(REPLAY_EXT).sort(), [
      "clear",
      "compact",
      "regenerate",
      "regenerate:biomes",
      "regenerate:provinces-emblems",
      "set_heights"
    ]);
  });
});

/** Plain burgs (no capital, market centre or province centre) on land, and a few landmarks. */
const PICK = `
const C = pack.cells;
const market = new Set((pack.markets || []).map(m => m.centerBurgId));
const centres = new Set(pack.provinces.filter(p => p && p.i && !p.removed).map(p => p.burg));
const live = pack.burgs.filter(b => b && b.i && !b.removed && C.h[b.cell] >= 20);
const count = new Map();
for (const b of live) count.set(b.name, (count.get(b.name) || 0) + 1);
const plain = live.filter(b => !b.capital && !market.has(b.i) && !centres.has(b.i) && count.get(b.name) === 1);
const A = plain[5];
const far = plain.find(b => b.feature === A.feature && b.i !== A.i && Math.hypot(A.x - b.x, A.y - b.y) > 100);
const B = plain.find(b => b.i !== A.i && b.i !== far.i && b.state !== A.state);
const U = plain.find(b => ![A.i, far.i, B.i].includes(b.i) && b.state !== A.state && b.state !== B.state);
const river = pack.rivers.find(r => r && r.name && r.cells && r.cells.length > 6 && count.get(r.name) === undefined);
const hill = [...C.i].find(c => C.h[c] >= 40 && C.h[c] <= 80 && !C.burg[c] && Math.hypot(C.p[c][0] - A.x, C.p[c][1] - A.y) > 150);
const row = b => ({ i: b.i, name: b.name, x: b.x, y: b.y, cell: b.cell });
const states = pack.states.filter(s => s.i && !s.removed);
return {
  A: row(A), far: row(far), B: row(B), U: row(U),
  river: { i: river.i, name: river.name },
  hill: { cell: hill, h: C.h[hill] },
  S: { i: states[1].i },
  free: (() => { const c = [...C.i].reverse().find(c => C.h[c] >= 20 && !C.burg[c] && C.c[c].every(k => !C.burg[k])); return { x: C.p[c][0], y: C.p[c][1] }; })()
};`;

describe("integrate: families a, b and c on one map", () => {
  let h: Harness;
  let pick: Obj;

  const ev = async (code: string, args?: unknown): Promise<any> =>
    (await h.ok("eval", { code, args, readOnly: true })).value;

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "40" });
    await h.ok("load_map", { path: DEMO_MAP });
    pick = (await ev(PICK)) as Obj;
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("apply: one spec with a biome, map settings (winds, locks), a routeGroup with a freehand route and a river rename; check then reports all unchanged", async () => {
    await h.ok("load_map", { path: DEMO_MAP });
    const { A, far, river } = pick;
    const winds = [200, 60, 225, 315, 135, 300];
    const prec = (((await h.ok("map_info", { since: "none" })).settings as Obj).precipitation as number) + 13;
    const spec = {
      // a lock list and a {value, lock} setting: the locks travel in the .map text, so apply compares them
      map: { winds, precipitation: { value: prec, lock: true }, lock: ["winds"] },
      biomes: [{ name: "Glimmer Fen", color: "#336655", habitability: 40, cost: 70 }],
      routeGroups: [{ id: "route-integ", name: "Integration Lanes", stroke: "#aa5500", width: 0.7 }],
      routes: [
        {
          name: "Integ Lane",
          draw: "points",
          through: [
            [A.x, A.y],
            [A.x + 30, A.y + 12],
            [far.x, far.y]
          ],
          group: "route-integ"
        }
      ],
      rivers: [{ ref: river.i, name: "Integ Water" }]
    };
    const pre = await h.ok("apply", { ...spec, mode: "check" });
    assert.equal((pre.counts as Obj).error, undefined, JSON.stringify(pre.rows));
    const up = await h.ok("apply", spec);
    const counts = up.counts as Obj;
    assert.equal(counts.error, undefined, JSON.stringify(up.rows));
    assert.equal(counts.created, 3, JSON.stringify(up));
    assert.equal(counts.updated, 2, JSON.stringify(up));
    assert.doesNotMatch(JSON.stringify(up.notes ?? []), /write-only/);

    // the page holds what the spec says, through each family's own fields
    const page = await ev(
      `const b = biomesData.name.indexOf("Glimmer Fen");
       const lane = pack.routes.find(r => r.name === "Integ Lane");
       return {
         biome: b > 0 ? { color: biomesData.color[b], hab: biomesData.habitability[b], cost: biomesData.cost[b] } : null,
         lane: lane ? { group: lane.group, n: lane.points.length, lock: !!lane.lock } : null,
         group: !!document.getElementById("route-integ"),
         river: pack.rivers.find(r => r.i === args.i).name
       };`,
      { i: river.i }
    );
    assert.deepEqual(page, {
      biome: { color: "#336655", hab: 40, cost: 70 },
      lane: { group: "route-integ", n: 3, lock: true },
      group: true,
      river: "Integ Water"
    });
    const info = await h.ok("map_info", { since: "none" });
    const st = info.settings as Obj;
    assert.deepEqual(st.winds, winds);
    assert.equal(st.precipitation, prec);
    assert.deepEqual([...(st.locked as string[])].sort(), ["precipitation", "winds"], JSON.stringify(st.locked));

    const chk = await h.ok("apply", { ...spec, mode: "check" });
    assert.deepEqual(chk.counts, { unchanged: 5 }, JSON.stringify(chk.rows));
    const again = await h.ok("apply", spec);
    assert.deepEqual(again.counts, { unchanged: 5 }, JSON.stringify(again));
    // a lock released by hand shows in check as a lock diff, and apply takes it again
    await h.ok("edit", { type: "map", ops: [{ set: { unlock: ["winds", "precipitation"] } }] });
    const off = await h.ok("apply", { map: spec.map, mode: "check" });
    const diffs = ((off.rows as Obj[]).find(r => r.at === "map")?.diffs ?? []) as Obj[];
    assert.deepEqual(diffs.map(d => d.field).sort(), ["lock", "precipitation.lock"], JSON.stringify(off.rows));
    const back = await h.ok("apply", { map: spec.map });
    assert.equal((back.counts as Obj).updated, 1, JSON.stringify(back));
    const relocked = ((await h.ok("map_info", { since: "none" })).settings as Obj).locked as string[];
    assert.deepEqual([...relocked].sort(), ["precipitation", "winds"]);
  });

  test("map_info {diff:'counts'} after set_heights, clear, compact and a settings edit: one coherent diff", async () => {
    await h.ok("load_map", { path: DEMO_MAP });
    const { B, hill } = pick;
    await h.ok("snapshot", { action: "take", label: "integ-diff" });

    await h.ok("set_heights", { pack: { [hill.cell]: hill.h + 4 }, rebuild: "keep" }, 240_000);
    await h.ok("clear", { types: ["burgs"], where: { i: [B.i] } });
    await h.ok("compact", {});
    const prec = ((await h.ok("map_info", { since: "none" })).settings as Obj).precipitation as number;
    await h.ok("edit", { type: "map", ops: [{ set: { precipitation: prec + 9 } }] });

    const c = await h.ok("map_info", { since: "integ-diff", diff: "counts" });
    assert.equal(c.changed, true);
    const ch = c.changes as Obj;
    assert.equal(ch.burg?.removed, 1, JSON.stringify(ch));
    assert.deepEqual(ch.settings, { changed: 1, names: ["precipitation"] }, JSON.stringify(ch));
    assert.ok(ch.cells && Object.keys(ch.cells).length > 0, `the height change is in cells: ${JSON.stringify(ch)}`);
    for (const [type, v] of Object.entries(ch)) {
      assert.ok(v && typeof v === "object", `${type}: ${JSON.stringify(v)}`);
      if (type === "cells" || type === "settings" || type === "map") continue;
      for (const k of ["added", "removed", "changed"])
        assert.equal(typeof (v as Obj)[k], "number", `${type}.${k}: ${JSON.stringify(v)}`);
    }
    // the list form agrees on the removed burg and the setting
    const list = await h.ok("map_info", { since: "integ-diff" });
    const lc = list.changes as Obj;
    assert.deepEqual(lc.settings?.precipitation, { from: prec, to: prec + 9 }, JSON.stringify(lc).slice(0, 400));
  });

  test("lint after clear, compact and regrid: stubs and the new cell numbering crash no check", async () => {
    await h.ok("load_map", { path: DEMO_MAP });
    const { A, B, U } = pick;
    await h.ok("clear", { types: ["burgs"], where: { i: [A.i, B.i] } });
    await h.ok("edit", { type: "burg", ops: [{ ref: U.i, remove: true }] });
    const cp = await h.ok("compact", {});
    assert.ok(JSON.stringify(cp).includes("burg"), JSON.stringify(cp).slice(0, 300));
    assert.equal(await ev("return pack.burgs[args.i].removed === true && pack.burgs[args.i].x === undefined", B), true);

    const lint0 = await h.ok("lint", { limit: 50, minSeverity: "info" }, 240_000);
    assert.doesNotMatch(JSON.stringify(lint0), /check failed/, JSON.stringify(lint0).slice(0, 600));

    const cells0 = await ev("return pack.cells.i.length");
    await h.ok("regrid", { density: 20000 }, 300_000);
    assert.notEqual(await ev("return pack.cells.i.length"), cells0, "the regrid renumbered the cells");
    assert.equal(await ev("return pack.burgs[args.i].removed === true", B), true, "the stub stays a stub");
    const lint1 = await h.ok("lint", { limit: 50, minSeverity: "info" }, 240_000);
    assert.doesNotMatch(JSON.stringify(lint1), /check failed/, JSON.stringify(lint1).slice(0, 600));
    assert.ok(Array.isArray(lint1.clean), JSON.stringify(lint1.clean));
    // the stubs are not reported as broken burgs
    const rows = JSON.stringify(lint1.rows ?? {});
    for (const id of [A.i, B.i, U.i]) assert.doesNotMatch(rows, new RegExp(`"burg ${id}"|burg:${id}\\b`));
  });
});

describe("integrate: a cross-family sketch saved to the fake Worker and rebased", () => {
  let fake: FakeWorker;
  let h: Harness;
  let pick: Obj;
  let theirs: Buffer;
  const ev = async (code: string, args?: unknown): Promise<any> =>
    (await h.ok("eval", { code, args, readOnly: true })).value;

  before(async () => {
    fake = new FakeWorker({ seedFile: DEMO_MAP, version: 6, assetsDir: path.join(REPO_ROOT, "dist") });
    const origin = await fake.start();
    h = await startServer({
      TUPAIA_MODE: "live",
      TUPAIA_LIVE_ORIGIN: origin,
      TUPAIA_BUILD_CACHE_MS: "0",
      TUPAIA_UNDO_DEPTH: "40"
    });
    // a live server loads shared v6 on its first launch
    pick = (await ev(PICK)) as Obj;
    // "someone else's" v7: a rename, a recolour and a new burg (so burg ids shift)
    await h.ok("eval", {
      args: pick,
      code: `pack.burgs[args.U.i].name = "Otherton";
             pack.states[args.S.i].color = "#123456";
             const id = Burgs.add([args.free.x, args.free.y]);
             pack.burgs[id].name = "Theirford";
             return id;`
    });
    const saved = await h.ok("save_map", { path: "integ-theirs-v7.map", overwrite: true });
    theirs = fs.readFileSync(saved.path as string);
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
    await fake?.stop();
  });

  test("set_heights, routeGroup + freehand route, edit map, apply, clear and compact replay onto v7 with their edits kept", async () => {
    const { A, far, B, river, hill } = pick;
    await h.ok("load_map", { source: "shared" });
    const st = await h.ok("sketch", { action: "start", slug: "integrate", note: "Cross-family sketch" });
    assert.equal((st.base as Obj).version, 6);
    const prec = ((await h.ok("map_info", { since: "none" })).settings as Obj).precipitation as number;

    await h.ok("set_heights", { pack: { [hill.cell]: hill.h + 3 }, rebuild: "keep" }, 240_000);
    await h.ok("add", {
      type: "routeGroup",
      items: [{ id: "route-sketchy", name: "Sketch Lanes", stroke: "#3355aa", width: 0.6 }]
    });
    await h.ok("add", {
      type: "route",
      items: [
        {
          points: [
            { x: A.x, y: A.y },
            { x: (A.x + far.x) / 2, y: (A.y + far.y) / 2 + 8 },
            { x: far.x, y: far.y }
          ],
          noPathfind: true,
          group: "Sketch Lanes",
          name: "Sketch Lane"
        }
      ]
    });
    await h.ok("edit", { type: "map", ops: [{ set: { precipitation: prec + 7 }, lock: ["precipitation"] }] });
    await h.ok("apply", {
      rivers: [{ ref: river.i, name: "Sketchwater" }],
      burgs: [{ name: A.name, population: 2345 }]
    });
    await h.ok("clear", { types: ["burgs"], where: { i: [B.i] } });
    await h.ok("compact", {});

    const want = await ev(
      `const lane = pack.routes.find(r => r && r.name === "Sketch Lane");
       return {
         h: grid.cells.h[pack.cells.g[args.hill.cell]],
         lane: lane ? { group: lane.group, n: lane.points.length } : null,
         group: !!document.getElementById("route-sketchy"),
         river: pack.rivers.find(r => r.i === args.river.i).name,
         pop: Math.round(pack.burgs[args.A.i].population * populationRate * urbanization),
         b: !!pack.burgs[args.B.i].removed
       };`,
      pick
    );
    assert.deepEqual(want, {
      h: hill.h + 3,
      lane: { group: "route-sketchy", n: 3 },
      group: true,
      river: "Sketchwater",
      pop: 2345,
      b: true
    });
    const status = await h.ok("sketch", { action: "status", full: true });
    assert.equal(status.blobOnly, false, JSON.stringify(status.blobOnlyReasons));
    const tools = (status.records as Obj[]).map(r => r.tool);
    assert.deepEqual(tools, ["set_heights", "add", "add", "edit", "edit", "edit", "clear", "compact"], tools.join());
    const sum = await h.ok("sketch", { action: "summary", shots: false });
    assert.match(String(sum.markdown), /Sketch Lane/);
    assert.match(String(sum.markdown), /Sketchwater/);
    assert.match(String(sum.markdown), /precipitation/);

    fake.clearLog();
    const saved = await h.ok("sketch", { action: "save", confirm: true });
    assert.deepEqual(
      fake.writes().map(r => `${r.method} ${r.path}`),
      ["PUT /api/map/sketch-integrate", "PUT /api/map/sketch-integrate/ops"]
    );
    assert.equal((saved.saved as Obj).version, 1);
    const ops = JSON.parse(String(fake.maps.get("sketch-integrate")?.ops)) as Obj;
    assert.equal(ops.blobOnly, false);
    assert.equal(ops.ops.length, 8);

    // someone else saves v7; the sketch rebases onto it
    assert.equal(fake.externalSave("alice@example.test", theirs), 7);
    fake.clearLog();
    const r = await h.ok("sketch", { action: "rebase" }, 400_000);
    assert.equal(r.completed, true, JSON.stringify(r.conflicts));
    assert.deepEqual(r.applied, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(((r.sketch as Obj).base as Obj).version, 7);
    assert.deepEqual(fake.writes(), [], "rebase does not save");

    const got = await ev(
      `const lane = pack.routes.find(r => r && r.name === "Sketch Lane");
       const theirs = pack.burgs.find(b => b && b.name === "Theirford");
       return {
         h: grid.cells.h[pack.cells.g[args.hill.cell]],
         lane: lane ? { group: lane.group, n: lane.points.length } : null,
         group: !!document.getElementById("route-sketchy"),
         river: pack.rivers.find(r => r.i === args.river.i).name,
         pop: Math.round(pack.burgs[args.A.i].population * populationRate * urbanization),
         b: !!pack.burgs[args.B.i].removed,
         u: pack.burgs[args.U.i].name,
         color: pack.states[args.S.i].color,
         theirford: theirs ? !theirs.removed : null
       };`,
      pick
    );
    assert.deepEqual(got, {
      ...want,
      u: "Otherton",
      color: "#123456",
      theirford: true
    });
    const info = await h.ok("map_info", { since: "none" });
    assert.equal((info.settings as Obj).precipitation, prec + 7);
    assert.ok(((info.settings as Obj).locked as string[]).includes("precipitation"));
    assert.equal(((info.counts as Obj).routeGroups as number) > 0, true, JSON.stringify(info.counts));

    // the rebased sketch saves on top of its first save
    fake.clearLog();
    await h.ok("sketch", { action: "save", confirm: true });
    assert.deepEqual(
      fake.writes().map(r => `${r.method} ${r.path}`),
      ["PUT /api/map/sketch-integrate", "PUT /api/map/sketch-integrate/ops"]
    );
    assert.equal(fake.row.version, 7, "the shared map was not written");
  });
});
