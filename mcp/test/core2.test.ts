// Platform fixes (dx/core-2): argument checks, path rules, diff identity, snapshot fidelity,
// live entity stats, culture/route creation, app load repairs, risk-rebuild route points, map
// locks in settings, seed reproducibility, eval redraw:false. Local layer only, on
// tests/fixtures/demo.map (and crafted copies of it); never the live site.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { absolutizeInputs } from "../src/cli.ts";
import type { Config } from "../src/config.ts";
import { readCandidates, resolveReadPath } from "../src/paths.ts";
import { ToolError } from "../src/result.ts";
import { DEMO_MAP, errorBody, type Harness, REPO_ROOT, startServer, textOf } from "./helpers.ts";

type Obj = Record<string, any>;

describe("core-2: arguments", () => {
  let h: Harness;
  before(async () => {
    h = await startServer();
    await h.ok("load_map", { path: DEMO_MAP });
  });
  after(async () => h?.close());

  test("an unknown top-level key is BAD_ARGS naming the allowed keys (MCP)", async () => {
    const r = await h.call("regenerate", { parts: ["routes"], redraw: false });
    assert.ok(r.isError);
    const e = errorBody(r).error as Obj;
    assert.equal(e.code, "BAD_ARGS");
    assert.match(e.message, /regenerate does not take 'redraw'; allowed arguments: parts, /);
    assert.deepEqual(e.details.unknown, ["redraw"]);
    assert.ok(e.details.allowed.includes("restoreLayers"));
    // a schema error is BAD_ARGS too (it used to be the SDK's 'Input validation error')
    const bad = await h.call("find", { type: "burg", limit: -1 });
    assert.ok(bad.isError);
    assert.match(textOf(bad), /^BAD_ARGS: invalid arguments for find: limit/);
  });

  test("tools/list advertises additionalProperties:false on plain object schemas", async () => {
    const { tools } = await h.client.listTools();
    const find = tools.find(t => t.name === "find") as Obj;
    assert.equal(find.inputSchema.additionalProperties, false);
    assert.ok(find.inputSchema.properties.fields);
    // apply takes inline lists under any key: no additionalProperties:false there
    const apply = tools.find(t => t.name === "apply") as Obj;
    assert.notEqual(apply.inputSchema.additionalProperties, false);
  });

  test("defaults still apply and known keys pass", async () => {
    const s = await h.ok("session", {});
    assert.equal(typeof s.mode, "string");
  });

  test("find warns about unknown fields, where-fields and sort keys", async () => {
    const r = await h.ok("find", { type: "route", fields: ["joinsAt", "group"], limit: 2 });
    assert.equal((r.rows as Obj[]).length, 2);
    assert.match(String((r.warnings as string[])[0]), /no route has fields: joinsAt .*route fields: .*group/);
    const w = await h.ok("find", { type: "burg", where: { nosuch: 3 }, sort: "-alsoNot", limit: 1 });
    assert.equal(w.total, 0);
    assert.match(String((w.warnings as string[])[0]), /where: nosuch, sort: alsoNot/);
    // river joinsAt comes from bridge-ext/rivers.js: not unknown there
    const rv = await h.ok("find", { type: "river", fields: ["joinsAt"], limit: 1 });
    assert.equal(rv.warnings, undefined);
    // computed fields and Min/Max bounds are known
    const ok = await h.ok("find", { type: "burg", where: { populationMin: 1 }, fields: ["population"], limit: 1 });
    assert.equal(ok.warnings, undefined);
    const c = await h.call("find", { type: "route", fields: ["joinsAt"], limit: 1, format: "compact" });
    assert.match(textOf(c), /\nwarning: no route has fields: joinsAt/);
  });

  test("inspect warns about unknown field names", async () => {
    const r = await h.ok("inspect", { entity: { type: "burg", ref: 1 }, fields: ["state", "bogus"] });
    assert.ok((r.entity as Obj).state !== undefined);
    assert.match(String((r.warnings as string[])[0]), /no key bogus in burg 1/);
    const ok = await h.ok("inspect", { entity: { type: "burg", ref: 1 }, fields: ["state", "people"] });
    assert.equal(ok.warnings, undefined);
    const c = await h.call("inspect", { entity: { type: "burg", ref: 1 }, fields: ["bogus"], format: "compact" });
    assert.match(textOf(c), /\nwarning: no key bogus/);
  });

  test("eval takes redraw:false (redraw nothing) and still rejects unknown keys", async () => {
    const r = await h.ok("eval", { code: "return pack.burgs.length", readOnly: true, redraw: false });
    assert.equal(typeof r.value, "number");
    const bad = await h.call("eval", { code: "1", readOnly: true, redraws: ["states"] });
    assert.equal(errorBody(bad).error.code, "BAD_ARGS");
  });
});

describe("core-2: read paths (pure)", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "tupaia-read-"));
  const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "tupaia-cwd-"));
  const cfg = { repoRoot: REPO_ROOT, outDir } as unknown as Config;
  const cwd0 = process.cwd();
  before(() => process.chdir(cwdDir));
  after(() => {
    process.chdir(cwd0);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(cwdDir, { recursive: true, force: true });
  });

  test("relative reads: server cwd first, then TUPAIA_OUT, then the repo root", () => {
    const real = (p: string) => fs.realpathSync.native(p);
    assert.deepEqual(
      readCandidates(cfg, "x/spec.json").map(p => path.dirname(path.dirname(p))),
      [process.cwd(), outDir, REPO_ROOT]
    );
    // only in the repo
    assert.equal(resolveReadPath(cfg, "tests/fixtures/demo.map"), DEMO_MAP);
    // TUPAIA_OUT beats the repo
    fs.mkdirSync(path.join(outDir, "tests", "fixtures"), { recursive: true });
    fs.writeFileSync(path.join(outDir, "tests", "fixtures", "demo.map"), "x");
    assert.equal(resolveReadPath(cfg, "tests/fixtures/demo.map"), path.join(outDir, "tests", "fixtures", "demo.map"));
    // the cwd beats both
    fs.mkdirSync(path.join(cwdDir, "tests", "fixtures"), { recursive: true });
    fs.writeFileSync(path.join(cwdDir, "tests", "fixtures", "demo.map"), "y");
    assert.equal(
      real(resolveReadPath(cfg, "tests/fixtures/demo.map")),
      real(path.join(cwdDir, "tests", "fixtures", "demo.map"))
    );
    // absolute is taken as is
    assert.equal(resolveReadPath(cfg, DEMO_MAP), DEMO_MAP);
  });

  test("a missing relative file names every place looked in", () => {
    assert.throws(
      () => resolveReadPath(cfg, "nope/missing.json"),
      (e: unknown) =>
        e instanceof ToolError && e.code === "NOT_FOUND" && e.message.includes(outDir) && e.message.includes(REPO_ROOT)
    );
  });

  test("the CLI makes apply, set_heights and flow input paths absolute from the caller's cwd", () => {
    const dir = path.dirname(DEMO_MAP);
    assert.deepEqual(absolutizeInputs("apply", { specPath: "demo.map" }, dir), { specPath: DEMO_MAP });
    assert.deepEqual(absolutizeInputs("set_heights", { image: { path: "demo.map" } }, dir), {
      image: { path: DEMO_MAP }
    });
    assert.deepEqual(absolutizeInputs("flow", { from: [], heights: { image: { path: "demo.map" } } }, dir), {
      from: [],
      heights: { image: { path: DEMO_MAP } }
    });
  });
});

describe("core-2: page fixes (browser)", () => {
  let h: Harness;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tupaia-core2-"));
  const ev = async (code: string, args?: unknown): Promise<any> =>
    (await h.ok("eval", { code, args, readOnly: true })).value;
  const evw = async (code: string, args?: unknown): Promise<any> => (await h.ok("eval", { code, args })).value;
  const reload = () => h.ok("load_map", { path: DEMO_MAP });
  before(async () => {
    h = await startServer();
    await reload();
  });
  after(async () => {
    await h?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("Q: edit map rows show the whole lock set before and after (dryRun: the set the op would leave)", async () => {
    await h.ok("edit", { type: "map", ops: [{ unlock: ["all"] }] });
    const dry = await h.ok("edit", {
      type: "map",
      dryRun: true,
      ops: [{ lock: ["winds"] }, { set: { mapSize: { value: 3, lock: true } }, unlock: ["winds"] }]
    });
    const plan = dry.plan as Obj[];
    assert.deepEqual(plan[0].locked, { before: [], after: ["winds"] });
    assert.deepEqual(plan[1].locked, { before: ["winds"], after: ["mapSize"] });
    assert.ok(!("lock" in plan[1].after), "the pseudo keys stay out of after");
    assert.deepEqual(
      ((await h.ok("map_info", { since: "none" })).settings as Obj).locked,
      [],
      "dryRun changed nothing"
    );
    const r = await h.ok("edit", { type: "map", ops: [{ lock: ["winds", "mapSize"] }] });
    assert.deepEqual((r.applied as Obj[])[0].locked, { before: [], after: ["mapSize", "winds"] });
    const u = await h.ok("edit", { type: "map", ops: [{ unlock: ["winds"] }] });
    assert.deepEqual((u.applied as Obj[])[0].locked, { before: ["mapSize", "winds"], after: ["mapSize"] });
    await h.ok("edit", { type: "map", ops: [{ unlock: ["all"] }] });
  });

  test("K: the diff pairs routes, markers and zones by identity: a regenerate is added/removed, an edit is a change", async () => {
    await reload();
    const r = await h.ok("regenerate", { parts: ["routes", "markers", "zones"], restoreLayers: true });
    const ch = r.changes as Obj;
    for (const t of ["route", "marker", "zone"]) {
      assert.equal(ch[t].counts.modified, 0, `${t}: ${JSON.stringify(ch[t].counts)}`);
      assert.ok(ch[t].counts.added > 0 && ch[t].counts.removed > 0, `${t}: ${JSON.stringify(ch[t].counts)}`);
    }
    // an edit to a kept route is a change of that route, not a remove + add
    const rt = await ev("return pack.routes.find(r => r && r.points?.length > 2).i");
    await h.ok("edit", { type: "route", ops: [{ ref: rt, set: { name: "Identity Way" } }] });
    const counts = (await h.ok("map_info", { diff: "counts" })).changes as Obj;
    assert.deepEqual(counts.route, { added: 0, removed: 0, changed: 1 });
  });

  test("M: culture, religion, state and province stats are read live from the cells", async () => {
    await reload();
    // move cells between two cultures behind the app's back (no stat refresh)
    const moved = await evw(`
      const c = pack.cells, from = pack.cells.culture[pack.burgs[1].cell];
      const to = pack.cultures.find(x => x.i && !x.removed && x.i !== from).i;
      let n = 0;
      for (const i of c.i) if (c.culture[i] === from && c.h[i] >= 20 && n < 12) { c.culture[i] = to; n++; }
      const live = k => Array.from(c.culture).filter(v => v === k).length;
      // a stored stat (the app's culture editor writes them) that no longer matches the cells
      pack.cultures[from].cells = 1;
      return { from, to, n, fromCells: live(from), toCells: live(to) };`);
    assert.equal(moved.n, 12);
    const rows = (await h.ok("find", { type: "culture", fields: ["cells"], limit: 100 })).rows as Obj[];
    assert.equal(rows.find(x => x.i === moved.from)?.cells, moved.fromCells);
    assert.equal(rows.find(x => x.i === moved.to)?.cells, moved.toCells);
    const ins = await h.ok("inspect", { entity: { type: "culture", ref: moved.from } });
    assert.equal((ins.entity as Obj).cells, moved.fromCells);
    assert.match(String(ins.statsNote), /^cells computed live from the cells/);
    // the fixture stores no culture stats: live values, no note
    await reload();
    const fresh = await h.ok("inspect", { entity: { type: "culture", ref: moved.from } });
    assert.equal(fresh.statsNote, undefined);
    const st = await h.ok("find", { type: "state", fields: ["cells", "burgs"], limit: 3, sort: "-cells" });
    assert.ok((st.rows as Obj[])[0].cells > 0 && (st.rows as Obj[])[0].burgs > 0);
  });

  test("N: add culture gives the culture a shield; a route laid over a road keeps the app's link rule", async () => {
    await reload();
    const cell = await ev(`
      const c = pack.cells, centres = new Set(pack.cultures.map(x => x.center));
      return c.i.find(i => c.h[i] >= 30 && !centres.has(i) && !c.burg[i]);`);
    const r = await h.ok("add", { type: "culture", items: [{ at: { cell }, name: "Shieldfolk" }] });
    const row = ((r.created ?? r.applied) as Obj[])[0];
    const shield = await ev("return pack.cultures[args].shield", row.i);
    assert.ok(typeof shield === "string" && shield.length > 0, `shield: ${shield}`);
    // a pathfinding route between the two ends of an existing road: the links are what the app
    // itself would build from pack.routes (last route wins), and both routes stay connected
    const ends = await ev(`
      const bAt = cell => pack.burgs.find(b => b && b.i && !b.removed && b.cell === cell);
      for (const r of pack.routes) {
        if (!r || r.group !== 'roads' || r.points.length < 6) continue;
        const a = bAt(r.points[0][2]), b = bAt(r.points.at(-1)[2]);
        if (a && b) return { route: r.i, a: a.i, b: b.i };
      }
      return null;`);
    assert.ok(ends, "the fixture has a road with a burg at each end");
    await h.ok("add", {
      type: "route",
      items: [{ through: [{ entity: { type: "burg", ref: ends.a } }, { entity: { type: "burg", ref: ends.b } }] }]
    });
    const same = await ev(`
      const built = Routes.buildLinks(pack.routes);
      const norm = o => JSON.stringify(Object.keys(o).sort((x, y) => x - y).map(k => [k, Object.entries(o[k]).sort()]));
      return norm(built) === norm(pack.cells.routes);`);
    assert.equal(same, true, "cells.routes equals Routes.buildLinks(pack.routes)");
    const lint = await h.ok("lint", { checks: ["route-link"] });
    assert.ok((lint.clean as string[]).includes("route-link"), JSON.stringify(lint).slice(0, 400));
  });

  test("P: a risk rebuild leaves every route point on the cell under it", async () => {
    await reload();
    // shallow water becomes land: the coast moves, the cells are re-packed and renumbered
    const heights = (await ev("return Array.from(grid.cells.h)")) as number[];
    const grid = heights.map(v => (v >= 16 && v < 20 ? 21 : v));
    const sh = await h.ok("set_heights", { grid }, 240_000);
    assert.equal(sh.cellsRenumbered, true);
    const carried = sh.carried as Obj;
    assert.ok(carried.routePointsRepointed > 0, JSON.stringify(carried));
    const lint = await h.ok("lint", { checks: ["route-point-cell", "route-link"], limit: 5 });
    for (const id of ["route-point-cell", "route-link"])
      assert.ok((lint.clean as string[]).includes(id), `${id}: ${JSON.stringify(lint).slice(0, 600)}`);
  });

  test("J: load_map and apply name the absolute file they read", async () => {
    const l = await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    assert.equal(l.path, DEMO_MAP);
    const spec = path.join(tmp, "spec.json");
    fs.writeFileSync(spec, JSON.stringify({ frame: { name: "Pathland" } }));
    const a = await h.ok("apply", { specPath: spec, mapping: { lists: { frame: "map" } } });
    assert.equal(a.specPath, spec);
    const miss = await h.call("load_map", { path: "no/such/file.map" });
    assert.equal(errorBody(miss).error.code, "NOT_FOUND");
    assert.ok(textOf(miss).includes(REPO_ROOT), textOf(miss));
  });

  test("O: load repairs invalid cultures (not provinces) and keeps state.capital on the promoted burg", async () => {
    const lines = fs.readFileSync(DEMO_MAP, "utf8").split("\r\n");
    const culture = lines[19].split(",").map(Number);
    const province = lines[27];
    const target = culture.find(v => v > 0) as number;
    const hit = culture.map((v, i) => (v === target ? i : -1)).filter(i => i >= 0);
    lines[19] = culture.map(v => (v === target ? 999 : v)).join(",");
    const states = JSON.parse(lines[14]) as Obj[];
    const burgs = JSON.parse(lines[15]) as Obj[];
    const live = (b: Obj) => b?.i && !b.removed;
    const st = states.find(s => s.i && !s.removed && burgs.filter(b => live(b) && b.state === s.i).length > 2) as Obj;
    // the capital burg is gone (removed, flag cleared): load promotes the state's first live burg
    Object.assign(burgs[st.capital], { removed: true, capital: 0 });
    const first = burgs.find(b => live(b) && b.state === st.i) as Obj;
    assert.notEqual(first.i, st.capital);
    lines[15] = JSON.stringify(burgs);
    const file = path.join(tmp, "broken.map");
    fs.writeFileSync(file, lines.join("\r\n"));
    await h.ok("load_map", { path: file });
    const got = await ev(
      `return { cult: args.hit.map(i => pack.cells.culture[i]), prov: Array.from(pack.cells.province).join(','),
        cap: pack.states[args.s].capital, flag: pack.burgs[args.first].capital }`,
      { hit: hit.slice(0, 50), s: st.i, first: first.i, old: st.capital }
    );
    assert.ok(
      got.cult.every((v: number) => v === 0),
      `cells of the invalid culture are reset to 0: ${got.cult}`
    );
    assert.equal(got.prov, province, "provinces are untouched");
    assert.equal(got.flag, 1);
    assert.equal(got.cap, first.i, "state.capital names the promoted burg");
  });

  test("L: after generate_map a snapshot restore gives back the same heights; regenerate rivers keeps heights", async () => {
    await h.ok("generate_map", { seed: "core2-fidelity", cells: 2 }, 240_000);
    const hs = "let s = 0; for (const v of pack.cells.h) s = (s * 31 + v) | 0; return [pack.cells.h.length, s]";
    const h0 = await ev(hs);
    const burg = await ev("return pack.burgs.find(b => b && b.i && !b.removed).i");
    await h.ok("edit", { type: "burg", ops: [{ ref: burg, set: { name: "Restoreton" } }] });
    await h.ok("snapshot", { action: "undo" });
    assert.deepEqual(await ev(hs), h0);
    await h.ok("regenerate", { parts: ["rivers"], restoreLayers: true });
    assert.deepEqual(await ev(hs), h0, "regenerate rivers keeps the pack heights");
  });

  test("R: a seed gives the same map across calls, session caches and an earlier call's size", async () => {
    const a = await h.ok("generate_map", { seed: "core2-seed", cells: 2 }, 240_000);
    await h.ok("generate_map", { seed: "core2-other", cells: 2, width: 900, height: 600 }, 240_000);
    // pollute the app's session caches the generator reads
    await evw("Names.getBase(0, 3); Rivers.smallLength = 1; return 1");
    const b = await h.ok("generate_map", { seed: "core2-seed", cells: 2 }, 240_000);
    assert.equal(b.digest, a.digest);
    const size = await ev("return [graphWidth, graphHeight]");
    assert.notDeepEqual(size, [900, 600], "the size is the server's default, not the earlier call's");
  });
});
