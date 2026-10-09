// Fixes from the real-world trials and the security review: paint_cells select/set validation,
// except and buffer, the feather note, item- and cell-level rebase conflicts, the stopped-rebase
// guard, inspect neighbours and bulk fields, find note ids, route typos and far pins, new burgs'
// routes, apply zone notes and UNSUPPORTED rows, lint river-gap/capital/duplicate-label rows,
// screenshot compare (no image for nothing, the compared shot's layers, scale), the Trade layer
// on save, the old-file biome note, set_heights burgsOnNewWater, recalculate skippedHidden, river
// note titles, and the CLI's live-daemon guard. Pure helpers run without a browser.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import zlib from "node:zlib";
import { isLoopbackHost, liveRefusal, schemaType } from "../src/cli.ts";
import { type DaemonState, writeState } from "../src/daemon-state.ts";
import { logSafe } from "../src/http.ts";
import { paintedSince, rle, unRle, withoutItems } from "../src/replay.ts";
import { oldBiomeNote } from "../src/tools/persist.ts";
import { FakeWorker } from "./fake-worker.ts";
import {
  alive,
  DEMO_MAP,
  errorBody,
  type Harness,
  MCP_ROOT,
  REPO_ROOT,
  safeEnv,
  startServer,
  textOf
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test data
type Obj = Record<string, any>;

describe("trial fixes: pure helpers", () => {
  test("rle/unRle round trip; malformed or oversized runs are ignored", () => {
    const v = [3, 3, 3, null, null, "a", 3];
    const runs = rle(v);
    assert.deepEqual(runs, [
      [3, 3],
      [null, 2],
      ["a", 1],
      [3, 1]
    ]);
    assert.deepEqual(unRle(runs, v.length), v);
    assert.equal(unRle(runs, v.length - 1), null, "more values than cells");
    assert.equal(unRle(runs, v.length + 1), null, "fewer values than cells");
    assert.equal(unRle([[1, -2]], 1), null);
    assert.equal(unRle("x", 1), null);
    assert.equal(unRle([[1, 1e9]], 10), null, "a huge run is refused before it is expanded");
  });

  test("withoutItems keeps the other items of an edit or add; null when none is left", () => {
    const edit = { type: "burg", ops: [{ ref: 1 }, { ref: 2 }, { ref: 3 }] } as never;
    assert.deepEqual((withoutItems("edit", edit, new Set([1])) as Obj).ops, [{ ref: 1 }, { ref: 3 }]);
    assert.equal(withoutItems("edit", edit, new Set([0, 1, 2])), null);
    const add = { type: "burg", items: [{ a: 1 }, { a: 2 }], created: [10, 11] } as never;
    const r = withoutItems("add", add, new Set([0])) as Obj;
    assert.deepEqual(r.items, [{ a: 2 }]);
    assert.deepEqual(r.created, [11], "created ids stay aligned with the items");
    assert.equal(withoutItems("paint_cells", add, new Set([0])), null);
  });

  test("paintedSince: a cell counts when its value is neither the base nor the sketch's value", () => {
    const cells = [10, 11, 12, 13];
    const base = { state: [1, 1, 2, 2] };
    const now = { state: [1, 5, 2, 7] };
    const r = paintedSince(cells, { state: 7 }, base, now);
    assert.deepEqual([...r.cells], [11], "cell 13 already holds the sketch's value");
    assert.deepEqual(r.byKey, { state: 1 });
    assert.equal(paintedSince(cells, { state: 7 }, { state: [1] }, now).cells.size, 0, "misaligned base");
  });

  test("liveRefusal: a live daemon refuses a local caller and a live caller of another origin", () => {
    const daemon = { pid: 7, mode: "live", liveOrigin: "https://a.example" };
    assert.match(
      String(liveRefusal({ envMode: "local", liveOrigin: "https://a.example" }, daemon)),
      /live mode .* your environment is local: refused, nothing ran.*--accept-live/
    );
    assert.match(
      String(liveRefusal({ envMode: "live", liveOrigin: "https://b.example" }, daemon)),
      /writes to https:\/\/a\.example but your TUPAIA_LIVE_ORIGIN is https:\/\/b\.example/
    );
    assert.equal(liveRefusal({ envMode: "live", liveOrigin: "https://a.example" }, daemon), null);
    assert.equal(liveRefusal({ envMode: "local", liveOrigin: null }, { pid: 7, mode: "local" }), null);
    // an older daemon's state file has no liveOrigin: only the mode is compared
    assert.equal(liveRefusal({ envMode: "live", liveOrigin: "https://b.example" }, { pid: 7, mode: "live" }), null);
  });

  test("isLoopbackHost and logSafe", () => {
    assert.ok(isLoopbackHost("127.0.0.1") && isLoopbackHost("localhost"));
    assert.ok(!isLoopbackHost("evil.example") && !isLoopbackHost("127.0.0.1.evil.example"));
    assert.equal(logSafe("a\nb\r\u0000c d"), "a b  c d");
  });

  test("help prints a long shape repeated under several arguments once", () => {
    const shape = {
      type: "object",
      properties: Object.fromEntries(
        ["circle", "polygon", "cells", "entity", "where", "buffer", "except", "more"].map(k => [
          k,
          { type: "object", properties: { alpha: { type: "number" }, beta: { type: "string" } } }
        ])
      )
    };
    const root = { type: "object", properties: { select: shape, exclude: shape } };
    const memo = { arg: "", long: new Map<string, string>() };
    memo.arg = "select";
    const a = schemaType(shape, root, 0, [], memo);
    memo.arg = "exclude";
    const b = schemaType(shape, root, 0, [], memo);
    assert.ok(a.length > 160);
    assert.equal(b, "{...same as in select}");
    assert.equal(schemaType(shape, root), a, "without a memo nothing is shortened");
  });

  test("oldBiomeNote: a 3-field biome line with custom biomes gets a note (plain or gzip); others none", () => {
    const names = [
      "Marine",
      "Hot desert",
      "Cold desert",
      "Savanna",
      "Grassland",
      "Tropical seasonal forest",
      "Temperate deciduous forest",
      "Tropical rainforest",
      "Temperate rainforest",
      "Taiga",
      "Tundra",
      "Glacier",
      "Wetland"
    ];
    const file = (biomeLine: string) => `1.108.0|x\nsettings\ncoords\n${biomeLine}\nrest`;
    const colors = (n: number) => Array(n).fill("#000").join(",");
    const old = file(`${colors(14)}|${Array(14).fill(50).join(",")}|${[...names, "Glass desert"].join(",")}`);
    const note = oldBiomeNote(Buffer.from(old));
    assert.match(String(note), /13 'Glass desert'.*iconsDensity 0, no icons and cost 50/);
    assert.match(String(oldBiomeNote(zlib.gzipSync(old))), /Glass desert/);
    const stock = file(`${colors(13)}|${Array(13).fill(50).join(",")}|${names.join(",")}`);
    assert.equal(oldBiomeNote(Buffer.from(stock)), null, "stock biomes only");
    assert.equal(oldBiomeNote(Buffer.from(`${old.split("\n")[3]}|{}`)), null, "not a map file");
    const fourth = file(
      `${colors(14)}|${Array(14).fill(50).join(",")}|${[...names, "Glass desert"].join(",")}|{"cost":[]}`
    );
    assert.equal(oldBiomeNote(Buffer.from(fourth)), null, "a file with the 4th field");
  });
});

describe("trial fixes: CLI live-daemon guard (fake daemon)", () => {
  let server: http.Server;
  let port = 0;
  let out = "";
  const calls: string[] = [];
  const CLI = path.join(MCP_ROOT, "bin", "tupaia");

  before(async () => {
    server = http.createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      if (req.url === "/health")
        return res.end(
          JSON.stringify({ ok: true, pid: process.pid, mode: "live", liveOrigin: "http://127.0.0.1:8", active: 0 })
        );
      if (req.url === "/call") return res.end(JSON.stringify({ isError: false, text: ["ran"], images: [] }));
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
    out = fs.mkdtempSync(path.join(os.tmpdir(), "tupaia-guard-"));
    const st: DaemonState = {
      pid: process.pid,
      port,
      url: `http://127.0.0.1:${port}`,
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
      ports: [port],
      mode: "live",
      liveOrigin: "http://127.0.0.1:8",
      startedAt: new Date().toISOString(),
      version: "0",
      appVersion: null,
      repoRoot: path.resolve(MCP_ROOT, ".."),
      outDir: out,
      idleMin: 0,
      token: "x".repeat(43)
    };
    writeState(out, st);
  });

  after(async () => {
    await new Promise<void>(r => server.close(() => r()));
    fs.rmSync(out, { recursive: true, force: true });
  });

  const cli = (args: string[], extra: Record<string, string> = {}) =>
    new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
      const env = { ...safeEnv(), TUPAIA_OUT: out, ...extra };
      const child = spawn(CLI, args, { env, cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", d => {
        stdout += d;
      });
      child.stderr.on("data", d => {
        stderr += d;
      });
      child.on("exit", code => resolve({ code: code ?? -1, stdout, stderr }));
    });

  test("a local caller is refused (exit 2, nothing sent to /call); --accept-live runs the call", async () => {
    calls.length = 0;
    const r = await cli(["call", "session", "{}"]);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /is in live mode .* your environment is local: refused, nothing ran/);
    assert.ok(!calls.includes("POST /call"), calls.join(", "));
    const ok = await cli(["call", "session", "{}", "--accept-live"]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /^ran$/m);
    assert.match(ok.stderr, /--accept-live: using the live daemon/);
  });

  test("a live caller naming another origin is refused; the same origin is not", async () => {
    const other = await cli(["call", "session", "{}"], {
      TUPAIA_MODE: "live",
      TUPAIA_LIVE_ORIGIN: "http://127.0.0.1:9"
    });
    assert.equal(other.code, 2, other.stderr);
    assert.match(
      other.stderr,
      /writes to http:\/\/127\.0\.0\.1:8 but your TUPAIA_LIVE_ORIGIN is http:\/\/127\.0\.0\.1:9/
    );
    const same = await cli(["call", "session", "{}"], {
      TUPAIA_MODE: "live",
      TUPAIA_LIVE_ORIGIN: "http://127.0.0.1:8"
    });
    assert.equal(same.code, 0, same.stderr);
  });

  test("headers: no token for a local caller of a live daemon, nor for a registered URL on another host", async () => {
    const r = await cli(["headers"]);
    assert.equal(r.code, 2);
    assert.doesNotMatch(r.stdout, /Bearer/);
    const evil = await cli(["headers"], {
      TUPAIA_MODE: "live",
      TUPAIA_LIVE_ORIGIN: "http://127.0.0.1:8",
      CLAUDE_CODE_MCP_SERVER_URL: "http://evil.example:7392/mcp"
    });
    assert.equal(evil.code, 2);
    assert.match(evil.stderr, /not 127\.0\.0\.1 or localhost/);
    assert.doesNotMatch(evil.stdout, /Bearer/);
  });

  test("tools (read-only) still lists a live daemon's tools for a local caller", async () => {
    calls.length = 0;
    await cli(["tools", "--names"]);
    assert.ok(calls.includes("GET /tools"), calls.join(", "));
  });
});

const PICK = `
  const C = pack.cells;
  const live = pack.burgs.filter(b => b && b.i && !b.removed);
  const plain = live.filter(b => !b.capital && C.h[b.cell] >= 20);
  const states = pack.states.filter(s => s && s.i && !s.removed && s.cells > 30);
  // a land cell well inside a state, away from burgs
  const inside = s => {
    for (let i = 0; i < C.i.length; i++)
      if (C.state[i] === s.i && C.h[i] >= 25 && !C.burg[i] && C.c[i].every(n => C.state[n] === s.i && C.h[n] >= 20)) return i;
    return null;
  };
  const S1 = states[0], S2 = states[1];
  const c1 = inside(S1), c2 = inside(S2);
  return {
    A: { i: plain[0].i, name: plain[0].name },
    B: { i: plain[1].i, name: plain[1].name },
    S1: { i: S1.i, name: S1.name, culture: S1.culture },
    S2: { i: S2.i, name: S2.name },
    c1, at1: { x: C.p[c1][0], y: C.p[c1][1] },
    c2, at2: { x: C.p[c2][0], y: C.p[c2][1] },
    otherCulture: pack.cultures.find(c => c && c.i && !c.removed && c.i !== S1.culture).i,
    layersOn: [...document.querySelectorAll("#mapLayers li:not(.buttonoff)")].map(l => l.id)
  };
`;

describe("trial fixes (browser)", () => {
  let h: Harness;
  let pick: Obj;
  const reload = () => h.ok("load_map", { path: "tests/fixtures/demo.map" });
  const evalv = async (code: string, args?: unknown) => (await h.ok("eval", { code, args, readOnly: true })).value;
  const code = async (tool: string, args: Obj) => {
    const r = await h.call(tool, args);
    assert.equal(r.isError, true, `${tool} should fail: ${textOf(r).slice(0, 300)}`);
    return errorBody(r).error as Obj;
  };

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    await reload();
    pick = (await evalv(PICK)) as Obj;
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("paint_cells: unknown keys in select, a shape, where, set and height are BAD_FIELD", async () => {
    const circle = { at: pick.at1, radius: 40 };
    let e = await code("paint_cells", { select: { circle, exclude: { circle } }, set: { state: pick.S1.i } });
    assert.equal(e.code, "BAD_FIELD");
    assert.match(e.message, /exclude/);
    assert.match(e.message, /except/, "the message points at except");
    e = await code("paint_cells", { select: { circle: { ...circle, radious: 3 } }, set: { state: pick.S1.i } });
    assert.equal(e.code, "BAD_FIELD");
    e = await code("paint_cells", { select: { circle, where: { biomeNot: 3 } }, set: { state: pick.S1.i } });
    assert.equal(e.code, "BAD_FIELD");
    assert.match(e.message, /biomeNot/);
    e = await code("paint_cells", { select: { circle }, set: { stat: pick.S1.i } });
    assert.equal(e.code, "BAD_FIELD");
    e = await code("paint_cells", { select: { circle }, set: { height: { delta: 2, rebiuld: "keep" } } });
    assert.equal(e.code, "BAD_FIELD");
    e = await code("paint_cells", { select: { buffer: 10 }, set: { state: pick.S1.i } });
    assert.match(e.message, /select needs/, "a buffer alone selects nothing");
  });

  test("paint_cells: except subtracts, buffer grows and shrinks a shape", async () => {
    const n = async (select: Obj) =>
      Number((await h.ok("paint_cells", { select, set: { culture: pick.otherCulture }, dryRun: true })).cells);
    const big = { circle: { at: pick.at1, radius: 60 } };
    const small = { circle: { at: pick.at1, radius: 25 } };
    const all = await n(big);
    const inner = await n(small);
    assert.ok(all > inner && inner > 0, `${all} > ${inner} > 0`);
    assert.equal(await n({ ...big, except: small }), all - inner);
    assert.ok((await n({ ...small, buffer: 30 })) > inner, "a positive buffer grows the shape");
    assert.ok((await n({ ...big, buffer: -30 })) < all, "a negative buffer shrinks it");
    assert.equal(
      await n({ ...big, except: { where: { land: true } } }),
      await n({ ...big, where: { water: true } }),
      "except where land leaves the water cells"
    );
  });

  test("feather narrower than a cell: a note says it did nothing", async () => {
    const r = await h.ok("paint_cells", {
      select: { circle: { at: pick.at1, radius: 50 } },
      set: { biome: 1 },
      feather: { width: 0.5, unit: "px" },
      dryRun: true
    });
    assert.match(JSON.stringify(r), /about one cell spacing|unit:'cells'/);
  });

  test("inspect {at} lists neighbours; a burg's JSON elides long production lists", async () => {
    const r = await h.ok("inspect", { at: { cell: pick.c1 } });
    const nb = (r.neighbours ?? (r.cell as Obj)?.neighbours) as number[];
    assert.ok(Array.isArray(nb) && nb.length >= 3, JSON.stringify(r).slice(0, 400));
    const prod = (await evalv(
      `const b = pack.burgs.find(b => b && b.i && !b.removed && Array.isArray(b.production) && b.production.length > 10); return b ? b.i : null;`
    )) as number | null;
    if (prod !== null) {
      const b = await h.ok("inspect", { entity: { type: "burg", ref: prod } });
      assert.match(JSON.stringify(b), /items: fields:\['production'\] lists them/);
      const full = await h.ok("inspect", { entity: { type: "burg", ref: prod }, fields: ["production"] });
      assert.ok(Array.isArray(full.production ?? (full.entity as Obj)?.production), JSON.stringify(full).slice(0, 300));
    }
  });

  test("find notes: where {i} matches the note id as where {id} does", async () => {
    await h.ok("add", { type: "note", items: [{ entity: { type: "burg", ref: pick.A.i }, name: "Probe note" }] });
    const id = `burg${pick.A.i}`;
    const byI = await h.ok("find", { type: "note", where: { i: id } });
    const byId = await h.ok("find", { type: "note", where: { id } });
    assert.equal(byI.total, 1);
    assert.equal(byId.total, 1);
    await h.ok("snapshot", { action: "undo" });
  });

  test("add route: a mis-cased key is BAD_FIELD with a hint; a pin far from its point is warned", async () => {
    const e = await code("add", {
      type: "route",
      items: [{ points: [pick.at1, pick.at2], noPathFind: true }]
    });
    assert.equal(e.code === "BAD_FIELD" || /noPathFind/.test(JSON.stringify(e)), true, JSON.stringify(e));
    assert.match(JSON.stringify(e), /noPathfind/);
    const r = await h.ok("add", {
      type: "route",
      items: [{ points: [[pick.at1.x, pick.at1.y, pick.c2], pick.at2], noPathfind: true, name: "Far pin" }],
      dryRun: true
    });
    assert.match(JSON.stringify(r), /Far pin|spacing/);
    assert.match(JSON.stringify(r), /cell/);
  });

  test("add state at a Place: the new capital takes the state's culture; its route is listed", async () => {
    const r = await h.ok("add", {
      type: "state",
      items: [{ capital: pick.at2, name: "Probestate", culture: pick.otherCulture }]
    });
    const row = (r.created as Obj[])[0];
    const cap = row.capital.i as number;
    assert.equal(await evalv(`pack.burgs[${cap}].culture`), pick.otherCulture);
    const routes = (await evalv(
      `pack.routes.filter(r => r && !r.removed && r.points.some(p => p[2] === pack.burgs[${cap}].cell)).length`
    )) as number;
    if (routes) {
      assert.ok(Array.isArray(row.routes) && row.routes.length >= 1, JSON.stringify(row));
      assert.match(JSON.stringify(r.notes), /linked to the nearest route/);
    }
    await h.ok("snapshot", { action: "undo" });
  });

  test("apply: zone notes, UNSUPPORTED province rows with a how, identical differs grouped, created complete", async () => {
    const zone = (await evalv(`pack.zones.find(z => z && !z.hidden && z.name)?.name ?? null`)) as string | null;
    const spec: Obj = {
      burgs: [
        { name: "Applyton", at: pick.at1, note: "Founded by the spec" },
        { name: "Applyville", at: pick.at2 }
      ],
      provinces: [{ name: "Nowhere Province", state: pick.S1.name }]
    };
    if (zone) spec.zones = [{ name: zone, note: { name: "Zone note", legend: "from the spec" } }];
    const r = await h.ok("apply", spec);
    const s = JSON.stringify(r);
    assert.match(s, /UNSUPPORTED/);
    assert.match(s, /regenerate/, "the row says how to make a province");
    const created = r.created as Obj;
    assert.ok(created.burgs && Object.keys(created.burgs).length === 2, s.slice(0, 600));
    if (zone) {
      const id = (await evalv(`"zone" + pack.zones.find(z => z && z.name === ${JSON.stringify(zone)}).i`)) as string;
      assert.equal(await evalv(`notes.find(n => n.id === ${JSON.stringify(id)})?.name ?? null`), "Zone note");
    }
    await h.ok("snapshot", { action: "undo" });
    // identical differs rows group (3 or more): markers that all differ the same way
    const mk = (await evalv(
      `pack.markers.filter(m => m && !m.removed && m.type && !m.size).slice(0, 4).map(m => ({ i: m.i, type: m.type }))`
    )) as Obj[];
    assert.equal(mk.length, 4);
    const c = await h.ok("apply", { mode: "check", markers: mk.map(m => ({ ref: m.i, type: m.type, size: 37 })) });
    assert.match(
      JSON.stringify(c),
      /"status":"differs","count":4,"at":\["markers\[0\]","markers\[1\]","markers\[2\]"\],"keys":\[0,1,2\],"more":1/
    );
  });

  test("lint: a burg-less state is a warn with a hint; a custom label repeating a burg's is flagged with a remove fix", async () => {
    await h.ok("add", { type: "state", items: [{ capital: pick.at2, name: "Hollowstate" }] });
    const sid = (await evalv(`pack.states.find(s => s && s.name === "Hollowstate").i`)) as number;
    await h.ok("eval", {
      code: `const s = pack.states[${sid}]; const b = pack.burgs[s.capital]; Burgs.remove(b.i); s.capital = 0; return 1;`,
      redraw: false
    });
    const out = await h.ok("lint", { checks: ["capital-outside"], minSeverity: "info", limit: 50 });
    const rows = ((out.rows as Obj)["capital-outside"] ?? []) as Obj[];
    const row = rows.find(r => JSON.stringify(r.e).includes("Hollowstate"));
    assert.ok(row, JSON.stringify(out).slice(0, 800));
    assert.equal(row.sev, "warn");
    assert.match(row.msg, /no burg/);
    assert.ok(row.hint, JSON.stringify(row));
    await h.ok("snapshot", { action: "undo", n: 2 });

    await h.ok("add", {
      type: "label",
      items: [{ at: { entity: { type: "burg", ref: pick.A.i } }, text: pick.A.name }]
    });
    // the demo map is saved without its labels drawn; then every group shown at one zoom, so the
    // custom label and the burg label are measured together
    await h.ok("eval", { code: "1", readOnly: true, redraw: ["labels"] });
    await h.ok("display", { labels: { "*": { alwaysShow: true } } });
    const lo = await h.ok("lint", { checks: ["label-overlap"], minSeverity: "info", limit: 50, atScale: 3 });
    const dup = ((lo.rows as Obj)["label-overlap"] ?? []).find((r: Obj) => /repeat|duplicat/i.test(r.msg));
    assert.ok(dup, JSON.stringify(lo).slice(0, 800));
    assert.equal(dup.fix?.tool, "edit");
    assert.match(JSON.stringify(dup.fix.args), /remove/);
    await h.ok("snapshot", { action: "undo", n: 2 });
  });

  test("screenshot compare: nothing changed = no image; the compared shot's layers are reused", async () => {
    const base = await h.call("screenshot", { target: { at: pick.at1 }, zoom: 4 });
    const s1 = JSON.parse(textOf(base)).shotId as string;
    const same = await h.call("screenshot", { compare: s1 });
    const body = JSON.parse(textOf(same));
    assert.equal(body.compare.changedPixels, 0, JSON.stringify(body.compare));
    assert.equal(same.content.filter(c => c.type === "image").length, 0, "no grey diff image");
    assert.match(body.compare.note, /nothing changed/);
    // a shot with a layer override, compared without repeating it: the same layers are used
    const layer = pick.layersOn.includes("toggleRivers") ? { off: ["rivers"] } : { on: ["rivers"] };
    const s2 = JSON.parse(textOf(await h.call("screenshot", { target: { at: pick.at1 }, zoom: 4, layers: layer })))
      .shotId as string;
    const c = JSON.parse(textOf(await h.call("screenshot", { compare: s2, crop: "changed" })));
    assert.match(String(c.compare.layers), /captured with shot s\d+'s layers/);
    assert.ok(Number(c.compare.changedPct) < 1, JSON.stringify(c.compare));
    assert.deepEqual(
      (await evalv(`[...document.querySelectorAll("#mapLayers li:not(.buttonoff)")].map(l => l.id)`)) as string[],
      pick.layersOn,
      "the page's layers are as before"
    );
    const e = await code("screenshot", { compare: s1, scale: 2 });
    assert.equal(e.code, "BAD_ARGS");
    assert.match(e.message, /same scale/);
  });

  test("save keeps the Trade layer off: a reload of the saved file does not turn it on", async () => {
    await h.ok("display", { off: ["trade"] });
    const saved = await h.ok("save_map", { path: "trade-off.map", overwrite: true });
    await h.ok("load_map", { path: saved.path as string });
    const on = (await evalv(`layerIsOn("toggleTrade")`)) as boolean;
    assert.equal(on, false);
    assert.match(fs.readFileSync(saved.path as string, "utf8"), /id="tradeAnimation"[^>]*data-layer-off="1"/);
    await reload();
  });

  test("load_map: a file without the biome extras field and with a custom biome gets a note", async () => {
    await h.ok("add", { type: "biome", items: [{ name: "Glass desert", base: "Hot desert" }] });
    const saved = await h.ok("save_map", { path: "biome-new.map", overwrite: true });
    const lines = fs.readFileSync(saved.path as string, "utf8").split("\r\n");
    assert.equal(lines[3].split("|").length, 4, "this build writes the 4th field");
    lines[3] = lines[3].split("|").slice(0, 3).join("|");
    const oldFile = path.join(path.dirname(saved.path as string), "biome-old.map");
    fs.writeFileSync(oldFile, lines.join("\r\n"));
    const r = await h.ok("load_map", { path: oldFile });
    assert.match(String(r.note), /Glass desert.*iconsDensity 0/);
    const plain = await h.ok("load_map", { path: saved.path as string });
    assert.equal(plain.note, undefined);
    await reload();
  });

  test("set_heights dryRun always has burgsOnNewWater (count 0 included)", async () => {
    const r = await h.ok("set_heights", { pack: { [pick.c1]: 60 }, rebuild: "keep", dryRun: true }, 240_000);
    assert.deepEqual(r.burgsOnNewWater, { count: 0 });
  });

  test("edit map recalculate with the biomes layer hidden lists it under skippedHidden", async () => {
    await h.ok("display", { off: ["biomes"] });
    const r = await h.ok("edit", { type: "map", recalculate: "biomes" }, 240_000);
    assert.ok((r.skippedHidden as string[] | undefined)?.includes("biomes"), JSON.stringify(r).slice(0, 600));
    await reload();
  });

  test("regrid: river gaps are filled and any left have a reroute fix; biomes stay unless redefined", async () => {
    const r = await h.ok("regrid", { density: 5 }, 300_000);
    const fixed = r.fixed as Obj;
    assert.equal(typeof fixed?.riverGapCellsFilled, "number", JSON.stringify(r).slice(0, 800));
    assert.match(JSON.stringify(r.warnings ?? r.notes), /biome/i, "a warning says the biomes are stale");
    const lint = await h.ok("lint", { checks: ["river-gap"], limit: 5 });
    const rows = ((lint.rows as Obj)["river-gap"] ?? []) as Obj[];
    for (const row of rows) assert.ok(row.fix || row.hint || (lint.fixAll as Obj)?.["river-gap"], JSON.stringify(row));
    const before = Number((lint.counts as Obj)["river-gap"] ?? 0);
    const fix = (lint.fixAll as Obj)?.["river-gap"] ?? rows.find(r => r.fix)?.fix;
    if (fix) {
      assert.equal(fix.tool, "edit");
      assert.equal(fix.args.type, "river");
      await h.ok(fix.tool, fix.args);
      const again = await h.ok("lint", { checks: ["river-gap"], limit: 0 });
      assert.ok(Number((again.counts as Obj)["river-gap"] ?? 0) < before, "the reroute fix closes gaps");
    }
    await reload();
    const red = await h.ok("regrid", { density: 5, biomes: "redefine" }, 300_000);
    assert.doesNotMatch(JSON.stringify(red.warnings ?? []), /biomes .*stale|redefine/i);
    await reload();
  });

  test("a river rename carries its note title along when the title names the river", async () => {
    const rv = (await evalv(`pack.rivers.find(r => r && r.name && r.cells?.length > 5)`)) as Obj;
    await h.ok("add", { type: "note", items: [{ id: `river${rv.i}`, name: `${rv.name} crossing` }] });
    const r = await h.ok("edit", { type: "river", ops: [{ ref: rv.i, set: { name: "Probewater" } }] });
    assert.match(JSON.stringify(r.notes), /note title follows/);
    assert.equal(await evalv(`notes.find(n => n.id === "river${rv.i}").name`), "Probewater crossing");
    await reload();
  });
});

describe("trial fixes: rebase granularity and the stopped-rebase guard (file base, test hook)", () => {
  let h: Harness;
  let pick: Obj;
  const files: Record<string, string> = {};
  const evalv = async (code: string, args?: unknown) => (await h.ok("eval", { code, args, readOnly: true })).value;

  async function otherCopy(name: string, code: string): Promise<string> {
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("eval", { code, args: pick });
    return (await h.ok("save_map", { path: `${name}.map`, overwrite: true })).path as string;
  }

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    pick = (await evalv(PICK)) as Obj;
    // theirs: A renamed, and the cells around c1 given to S2
    files.theirs = await otherCopy(
      "theirs",
      `pack.burgs[args.A.i].name = "Theirname";
       const C = pack.cells; let n = 0;
       for (const j of [args.c1, ...C.c[args.c1]]) { C.state[j] = args.S2.i; n++; }
       return n;`
    );
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("skip drops only the conflicting item of an edit and the cells someone else painted", async () => {
    await h.ok("sketch", { action: "start", slug: "granular" });
    await h.ok("edit", {
      type: "burg",
      ops: [
        { ref: pick.A.i, set: { name: "Mine-A" } },
        { ref: pick.B.i, set: { name: "Mine-B" } }
      ]
    });
    await h.ok("paint_cells", { select: { circle: { at: pick.at1, radius: 40 } }, set: { state: pick.S1.i } });
    const r = await h.ok("sketch", { action: "rebase", onto: { path: files.theirs }, onConflict: "skip" }, 300_000);
    const conflicts = r.conflicts as Obj[];
    const items = conflicts.find(c => c.itemsSkipped);
    assert.deepEqual(items?.itemsSkipped, [0], JSON.stringify(conflicts));
    const cells = conflicts.find(c => c.cellsSkipped);
    assert.ok(cells && cells.cellsSkipped >= 1, JSON.stringify(conflicts));
    assert.equal(typeof r.replayMs, "number");
    const now = (await evalv(
      `[pack.burgs[args.A.i].name, pack.burgs[args.B.i].name, pack.cells.state[args.c1]]`,
      pick
    )) as unknown[];
    assert.deepEqual(now, ["Theirname", "Mine-B", pick.S2.i], "their rename and their cells survive; B is renamed");
    await h.ok("sketch", { action: "discard", confirm: true });
  });

  test("a stopped rebase refuses every other mutating call (SKETCH) until undone", async () => {
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("sketch", { action: "start", slug: "stopped" });
    await h.ok("edit", { type: "burg", ops: [{ ref: pick.A.i, set: { name: "Mine-A" } }] });
    const r = await h.ok("sketch", { action: "rebase", onto: { path: files.theirs }, onConflict: "stop" }, 300_000);
    assert.ok((r.conflicts as Obj[]).length >= 1, JSON.stringify(r).slice(0, 600));
    const e = await h.call("edit", { type: "burg", ops: [{ ref: pick.B.i, set: { name: "Sneaky" } }] });
    assert.equal(e.isError, true);
    assert.equal(errorBody(e).error.code, "SKETCH");
    assert.equal(await evalv(`pack.burgs[args.B.i].name`, pick), pick.B.name, "nothing changed");
    const st = await h.ok("sketch", { action: "status" });
    assert.equal(st.blobOnly, false, "the refused call did not make the sketch blob-only");
  });
});

describe("trial fixes: sketch_promote then (live mode, fake Worker)", () => {
  let fake: FakeWorker;
  let h: Harness;
  let burg = 0;
  const writes = () => fake.writes().map(r => `${r.method} ${r.path}`);
  /** sketch_promote args with its `then` parameter */
  // biome-ignore lint/suspicious/noThenProperty: sketch_promote's parameter is named 'then'
  const withThen = (v: string, o: Obj = {}): Obj => ({ ...o, then: v });

  before(async () => {
    fake = new FakeWorker({ seedFile: DEMO_MAP, version: 6, assetsDir: path.join(REPO_ROOT, "dist") });
    const origin = await fake.start();
    h = await startServer({ TUPAIA_MODE: "live", TUPAIA_LIVE_ORIGIN: origin, TUPAIA_BUILD_CACHE_MS: "0" });
    burg = (
      await h.ok("eval", { code: "pack.burgs.find(b => b && b.i && !b.removed && !b.capital).i", readOnly: true })
    ).value as number;
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
    await fake?.stop();
  });

  test("the token is bound to then; promoting an unsaved sketch with then:'discard' sends no DELETE", async () => {
    await h.ok("load_map", { source: "shared" });
    await h.ok("sketch", { action: "start", slug: "tok" });
    await h.ok("edit", { type: "burg", ops: [{ ref: burg, set: { name: "Tokenford" } }] });
    const p = await h.ok("sketch_promote", withThen("discard"));
    fake.clearLog();
    const bad = await h.call("sketch_promote", withThen("keep", { confirm: true, token: p.token }));
    assert.equal(bad.isError, true, "a token from a then:'discard' preview does not confirm then:'keep'");
    assert.deepEqual(writes(), []);
    const p2 = await h.ok("sketch_promote", withThen("discard"));
    const ok = await h.ok("sketch_promote", withThen("discard", { confirm: true, token: p2.token }));
    assert.match(JSON.stringify(ok.discarded), /never saved/);
    assert.ok(!writes().some(w => w.startsWith("DELETE")), writes().join(", "));
  });

  test("then:'keep' marks the saved copy promoted: open says so, rebase and promote refuse it", async () => {
    await h.ok("load_map", { source: "shared" });
    await h.ok("sketch", { action: "start", slug: "kept" });
    await h.ok("edit", { type: "burg", ops: [{ ref: burg, set: { name: "Keptford" } }] });
    await h.ok("sketch", { action: "save", confirm: true });
    const p = await h.ok("sketch_promote", {});
    const ok = await h.ok("sketch_promote", { confirm: true, token: p.token });
    assert.match(String(ok.keptMarked), /promoted/);
    const ops = JSON.parse(String(fake.maps.get("sketch-kept")?.ops)) as Obj;
    assert.equal(ops.promoted?.to, (ok.promoted as Obj).to);
    const o = await h.ok("sketch", { action: "open", slug: "kept" });
    assert.match(JSON.stringify(o), /already promoted/);
    const r = await h.call("sketch", { action: "rebase" });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /already promoted/);
    const again = await h.call("sketch_promote", {});
    assert.equal(again.isError, true);
    assert.match(textOf(again), /already promoted|rebase first/);
  });
});
