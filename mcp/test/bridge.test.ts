// Pure tests of src/bridge.js in node:vm with a fake `pack` (no browser).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import vm from "node:vm";
import { MCP_ROOT } from "./helpers.ts";

const SRC = fs.readFileSync(path.join(MCP_ROOT, "src", "bridge.js"), "utf8");

type Bridge = {
  call: (name: string, args?: unknown, meta?: unknown) => Promise<{ ok: boolean; value?: any; error?: any }>;
  resolve: (type: string, ref: unknown) => { i: unknown; name: string };
  place: (p: unknown) => { x: number; y: number; cell: number; lat: number; lon: number };
  redraw: (a: unknown) => Promise<{ redrawn: unknown[]; skippedHidden: string[] }>;
  fns: Record<string, (a: unknown) => unknown>;
  pure: Record<string, (...a: any[]) => any>;
};

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function makeWorld() {
  const W = 1000;
  const H = 500;
  // 10 x 5 grid of cells, 100 px apart
  const p: [number, number][] = [];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 10; x++) p.push([x * 100 + 50, y * 100 + 50]);
  const n = p.length;
  const state = new Uint16Array(n).map((_, c) => (c % 10 < 5 ? 1 : 2));
  const cells = {
    i: new Uint16Array(n).map((_, c) => c),
    p,
    h: new Uint8Array(n).fill(30),
    f: new Uint16Array(n).fill(1),
    state,
    province: new Uint16Array(n),
    culture: new Uint16Array(n).fill(1),
    religion: new Uint16Array(n),
    biome: new Uint8Array(n),
    burg: new Uint16Array(n),
    r: new Uint16Array(n)
  };
  const burgs: any[] = [
    0,
    { i: 1, name: "Norvik", x: 150, y: 150, cell: 11, state: 1, culture: 1, population: 5 },
    { i: 2, name: "Ålborg", x: 250, y: 250, cell: 22, state: 1, culture: 1, population: 2 },
    { i: 3, name: "Twin", x: 650, y: 150, cell: 16, state: 2, culture: 1, population: 1 },
    { i: 4, name: "Twin", x: 750, y: 350, cell: 37, state: 2, culture: 1, population: 1 },
    { i: 5, name: "Gone", x: 50, y: 50, cell: 0, state: 1, removed: true }
  ];
  const pack = {
    cells,
    burgs,
    states: [
      { i: 0, name: "Neutrals" },
      { i: 1, name: "Chanland", fullName: "Kingdom of Chanland", pole: [250, 250], center: 22, capital: 1 },
      { i: 2, name: "Gazd", fullName: "Gazd Empire", pole: [750, 250], center: 27, capital: 3 }
    ],
    provinces: [0],
    cultures: [
      { i: 0, name: "Wildlands" },
      { i: 1, name: "Eldar", center: 22 }
    ],
    religions: [{ i: 0, name: "No religion" }],
    features: [0, { i: 1, type: "island", group: "continent", land: true, name: "Main" }],
    rivers: [],
    routes: [
      {
        i: 0,
        group: "roads",
        feature: 1,
        points: [
          [150, 150, 11],
          [650, 150, 16]
        ]
      }
    ],
    markers: [],
    zones: []
  };
  const mapCoordinates = { latT: 40, latN: 50, latS: 10, lonT: 80, lonW: -40, lonE: 40 };
  return { W, H, pack, mapCoordinates };
}

function load(extra: Record<string, unknown> = {}): {
  T: Bridge;
  ctx: vm.Context;
  world: ReturnType<typeof makeWorld>;
} {
  const world = makeWorld();
  const ctx = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    pack: world.pack,
    grid: { cells: { i: [], h: new Uint8Array(4) } },
    mapCoordinates: world.mapCoordinates,
    graphWidth: world.W,
    graphHeight: world.H,
    notes: [{ id: "burg1", name: "Norvik note", legend: "<b>hi</b>" }],
    nameBases: [
      { name: "German", min: 5, max: 12 },
      { name: "Hawaiian", min: 4, max: 8 }
    ],
    populationRate: 1000,
    urbanization: 1,
    ...extra
  });
  vm.runInContext(SRC, ctx, { filename: "bridge.js" });
  return { T: ctx.__tupaia as Bridge, ctx, world };
}

function expectError(fn: () => unknown, code: string): any {
  try {
    fn();
  } catch (e: any) {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return e;
  }
  assert.fail(`expected ${code}`);
}

describe("resolve", () => {
  const { T } = load();
  test("exact name and numeric refs", () => {
    assert.equal(T.resolve("burg", "Norvik").i, 1);
    assert.equal(T.resolve("burg", 1).name, "Norvik");
    assert.equal(T.resolve("burg", "1").name, "Norvik");
    assert.equal(T.resolve("burg", { id: 2 }).name, "Ålborg");
    assert.equal(T.resolve("burg", { name: "Norvik" }).i, 1);
  });
  test("case and diacritic folding, fullName", () => {
    assert.equal(T.resolve("burg", "alborg").i, 2);
    assert.equal(T.resolve("burg", "NORVIK").i, 1);
    assert.equal(T.resolve("state", "kingdom of chanland").i, 1);
  });
  test("AMBIGUOUS lists both ids", () => {
    const e = expectError(() => T.resolve("burg", "Twin"), "AMBIGUOUS");
    assert.deepEqual(plain(e.candidates.map((c: any) => c.i)).sort(), [3, 4]);
  });
  test("NOT_FOUND with Levenshtein candidates, never auto-applied", () => {
    const e = expectError(() => T.resolve("burg", "Norvic"), "NOT_FOUND");
    assert.equal(e.candidates[0].name, "Norvik");
    assert.equal(e.candidates[0].state, "Chanland");
    expectError(() => T.resolve("burg", 99), "NOT_FOUND");
  });
  test("REMOVED by id and by name", () => {
    expectError(() => T.resolve("burg", 5), "REMOVED");
    expectError(() => T.resolve("burg", "Gone"), "REMOVED");
  });
  test("id 0 rules", () => {
    expectError(() => T.resolve("burg", 0), "NOT_FOUND");
    expectError(() => T.resolve("feature", 0), "NOT_FOUND");
    assert.equal(T.resolve("state", 0).name, "Neutrals");
    assert.equal(T.resolve("culture", 0).name, "Wildlands");
    assert.equal(T.resolve("religion", 0).name, "No religion");
    assert.equal(T.resolve("state", "Neutrals").i, 0);
    assert.equal(T.resolve("route", 0).i, 0); // routes legitimately start at 0
  });
  test("namesbase and note refs", () => {
    assert.equal(T.resolve("namesbase", "hawaiian").i, 1);
    const e = expectError(() => T.resolve("namesbase", "Hawaian"), "NOT_FOUND");
    assert.equal(e.candidates[0].name, "Hawaiian");
    assert.equal(T.resolve("note", "burg1").name, "Norvik note");
  });
});

describe("place", () => {
  const { T, world } = load();
  test("lat/lon inverse round-trips within 0.5 px", () => {
    const { xyToLatLon } = T.pure;
    for (const [x, y] of [
      [0, 0],
      [123.4, 456.7],
      [999, 1],
      [500, 250],
      [731.2, 88.8]
    ]) {
      for (const decimals of [2, 4]) {
        const ll = xyToLatLon(x, y, world.mapCoordinates, world.W, world.H, decimals);
        const p = T.place({ lat: ll.lat, lon: ll.lon });
        assert.ok(Math.abs(p.x - x) <= 0.5 && Math.abs(p.y - y) <= 0.5, `${x},${y} -> ${p.x},${p.y} (${decimals} dp)`);
      }
    }
  });
  test("forms: xy, cell, entity, route fraction", () => {
    assert.equal(T.place({ x: 150, y: 150 }).cell, 11);
    assert.deepEqual(plain(T.place({ cell: 22 })).x, 250);
    const b = T.place({ entity: { type: "burg", ref: "Norvik" } });
    assert.equal(b.x, 150);
    const s = T.place({ entity: { type: "state", ref: "Gazd" } });
    assert.equal(s.x, 750);
    const mid = T.place({ entity: { type: "route", ref: 0 }, at: 0.5 });
    assert.equal(mid.x, 400);
    assert.equal(mid.y, 150);
  });
  test("a burg entity resolves to its recorded cell, not the cell nearest its x,y", () => {
    // x 401 is nearer cell 24's centre (450) than cell 23's (350)
    world.pack.burgs.push({ i: 6, name: "Edgeby", x: 401, y: 250, cell: 23, state: 1, culture: 1, population: 1 });
    try {
      assert.equal(T.place({ x: 401, y: 250 }).cell, 24);
      assert.equal(T.place({ entity: { type: "burg", ref: "Edgeby" } }).cell, 23);
      assert.equal(T.place({ entity: { type: "burg", ref: 6 } }).x, 401);
    } finally {
      world.pack.burgs.pop();
    }
  });
  test("OUT_OF_BOUNDS", () => {
    expectError(() => T.place({ x: -5, y: 10 }), "OUT_OF_BOUNDS");
    expectError(() => T.place({ lat: 80, lon: 0 }), "OUT_OF_BOUNDS");
    expectError(() => T.place({ cell: 9999 }), "OUT_OF_BOUNDS");
  });
  test("screen pixel of a stored view", () => {
    const view = {
      full: false,
      imgW: 640,
      imgH: 360,
      cssW: 1280,
      cssH: 720,
      x: -100,
      y: -50,
      scale: 2,
      graphWidth: 1000,
      graphHeight: 500
    };
    const p = T.place({ screen: [320, 180], view });
    // css (640, 360) -> map ((640+100)/2, (360+50)/2)
    assert.equal(p.x, 370);
    assert.equal(p.y, 205);
  });
});

describe("diff", () => {
  test("diffProjections reports added, removed, modified", () => {
    const { T } = load();
    const { projection, diffProjections } = T.pure;
    const base = { 1: projection({ i: 1, name: "A", pop: 1 }), 2: projection({ i: 2, name: "B" }) };
    const cur = { 1: projection({ i: 1, name: "A2", pop: 1 }), 3: projection({ i: 3, name: "C", cells: [1, 2] }) };
    const d = plain(diffProjections(base, cur));
    assert.deepEqual(d.added, [3]);
    assert.deepEqual(d.removed, [2]);
    assert.deepEqual(d.modified, [{ i: 1, fields: { name: ["A", "A2"] } }]);
  });
  test("setBaseline + diff over the fake pack", async () => {
    const { T, world } = load();
    const set = await T.call("setBaseline", { key: "k" });
    assert.ok(set.ok, JSON.stringify(set.error));
    world.pack.burgs[1].name = "Norvik II";
    world.pack.burgs[3].removed = true;
    world.pack.burgs.push({ i: 6, name: "New", x: 450, y: 450, cell: 44, state: 1 });
    world.pack.cells.state[0] = 2;
    const env = await T.call("diff", { key: "k" });
    assert.ok(env.ok, JSON.stringify(env.error));
    const d = plain(env.value);
    assert.equal(d.available, true);
    assert.equal(d.empty, false);
    assert.deepEqual(d.changes.burg.modified[0], {
      i: 1,
      name: "Norvik II",
      fields: { name: ["Norvik", "Norvik II"] }
    });
    assert.deepEqual(d.changes.burg.removed, [3]);
    assert.deepEqual(d.changes.burg.added, [{ i: 6, name: "New" }]);
    assert.equal(d.changes.cells.state, 1);
    const none = await T.call("diff", { key: "nope" });
    assert.equal(none.value.available, false);
  });
});

describe("redraw coalescing", () => {
  test("coalesceRedraws merges, orders and unions ids", () => {
    const { T } = load();
    const plan = plain(
      T.pure.coalesceRedraws([
        "states",
        "borders",
        "states",
        { layer: "stateLabels", ids: [3] },
        { layer: "stateLabels", ids: [1] },
        "features"
      ])
    );
    assert.deepEqual(plan, [
      { layer: "features" },
      { layer: "states" },
      { layer: "borders" },
      { layer: "stateLabels", ids: [1, 3] }
    ]);
    assert.deepEqual(plain(T.pure.coalesceRedraws(["labels", "stateLabels", "burgLabels"])), [{ layer: "labels" }]);
    assert.deepEqual(plain(T.pure.coalesceRedraws(["states", "all"])), [{ layer: "all" }]);
    assert.throws(() => T.pure.coalesceRedraws(["nope"]), /unknown redraw layer/);
  });
  test("redraw calls each draw function once and unlocks locked state labels", async () => {
    const calls: Record<string, unknown[]> = {};
    const rec =
      (name: string) =>
      (...a: unknown[]) => {
        calls[name] = [...(calls[name] ?? []), a];
      };
    let lockSeen: boolean | undefined;
    const { T, world } = load({
      layerIsOn: (id: string) => id !== "toggleRoutes",
      drawStates: rec("drawStates"),
      drawBorders: rec("drawBorders"),
      drawRoutes: rec("drawRoutes"),
      drawStateLabels: (ids: number[]) => {
        lockSeen = (world.pack.states[1] as { lock?: boolean }).lock;
        rec("drawStateLabels")(ids);
      },
      invokeActiveZooming: rec("invokeActiveZooming")
    });
    (world.pack.states[1] as any).lock = true;
    const r = await T.redraw({ layers: ["states", "borders", "states", "routes", { layer: "stateLabels", ids: [1] }] });
    assert.equal(calls.drawStates.length, 1);
    assert.equal(calls.drawBorders.length, 1);
    assert.equal(calls.drawRoutes, undefined); // hidden layer skipped
    assert.deepEqual(plain(r.skippedHidden), ["routes"]);
    assert.equal(lockSeen, false);
    assert.equal((world.pack.states[1] as any).lock, true); // lock restored
    assert.equal(calls.invokeActiveZooming.length, 1);
  });
});

describe("envelope and safeJson", () => {
  test("call envelope carries errors with codes and candidates", async () => {
    const { T } = load();
    const env = await T.call("resolve", { type: "burg", ref: "Norvic" });
    assert.equal(env.ok, false);
    assert.equal(env.error.code, "NOT_FOUND");
    assert.equal(env.error.candidates[0].name, "Norvik");
    const unknown = await T.call("nope", {});
    assert.equal(unknown.error.code, "UNKNOWN_FUNCTION");
  });
  test("safeJson converts typed arrays, cycles and functions", () => {
    const { T } = load();
    const o: any = { a: new Uint8Array([1, 2]), f: function named() {}, n: Number.NaN };
    o.self = o;
    assert.deepEqual(plain(T.pure.safeJson(o)), { a: [1, 2], f: "[function named]", n: "NaN", self: "[circular]" });
  });
  test("find filters by where with entity names and sorts", async () => {
    const { T } = load();
    const env = await T.call("find", { type: "burg", where: { state: "Chanland" }, sort: "-population" });
    assert.ok(env.ok, JSON.stringify(env.error));
    assert.deepEqual(plain(env.value.rows.map((r: any) => r.name)), ["Norvik", "Ålborg"]);
    assert.equal(env.value.rows[0].population, 5000);
    const near = await T.call("find", { type: "burg", near: { x: 640, y: 160 }, radius: 50 });
    assert.deepEqual(plain(near.value.rows.map((r: any) => r.i)), [3]);
  });
});
