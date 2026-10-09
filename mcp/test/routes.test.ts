// Freehand routes and custom route groups (dx/routes): add route {points, noPathfind}, the
// routeGroup entity (add / edit / remove / find / inspect), edit route {points, group}, link
// handling, undo, save/load, regenerate, and sketch replay. Runs against tests/fixtures/demo.map
// with no live origin (helpers refuse activationlayer.org).
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import { type EditResolved, Rewriter, rewriteResolved, summarizeOp } from "../src/ops.ts";
import { bothChanged } from "../src/replay.ts";
import { alive, errorBody, type Harness, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

const PICK_CODE = `
const C = pack.cells;
const B = pack.burgs.filter(b => b && b.i && !b.removed && C.h[b.cell] >= 20);
const A = B[10];
const far = B.find(b => b.feature === A.feature && Math.hypot(A.x - b.x, A.y - b.y) > 100);
const other = B.find(b => b.feature !== A.feature);
const offCell = B.find(b => findCell(b.x, b.y) !== b.cell);
const ocean = C.i.find(c => C.h[c] < 20 && C.p[c][0] > 50 && C.p[c][1] > 50);
const road = pack.routes.find(r => r.group === 'roads' && r.points.length > 3 && r.points[0][2] !== r.points[1][2]);
const row = b => ({ i: b.i, name: b.name, x: b.x, y: b.y, cell: b.cell });
return {
  A: row(A), far: row(far), other: row(other), offCell: row(offCell),
  ocean: { cell: ocean, x: C.p[ocean][0], y: C.p[ocean][1] },
  road: { i: road.i, a: road.points[0][2], b: road.points[1][2] },
  landCell: { cell: A.cell, x: C.p[A.cell][0], y: C.p[A.cell][1] }
};`;

describe("tupaia-mcp routes (freehand routes, route groups)", () => {
  let h: Harness;
  let pick: Obj;

  const ev = async (code: string, args?: unknown): Promise<any> =>
    (await h.ok("eval", { code, args, readOnly: true })).value;
  const order = (): Promise<string[]> => ev("[...document.querySelectorAll('#routes > g')].map(g => g.id)");
  const groupDom = (id: string): Promise<Obj | null> =>
    ev(
      `const g = document.getElementById(args.id);
       return g ? { attrs: Object.fromEntries([...g.attributes].map(a => [a.name, a.value])), kids: [...g.children].map(c => c.id), parent: g.parentNode.id } : null;`,
      { id }
    );
  const routeOf = (i: number): Promise<Obj | null> => ev("pack.routes.find(r => r.i === args.i) ?? null", { i });
  const routeNamed = (name: string): Promise<Obj | null> =>
    ev("pack.routes.find(r => r.name === args.name) ?? null", { name });
  /** Every cell pair [a, b] whose link is owned by route i (a < b), from pack.cells.routes. */
  const linksOf = (i: number): Promise<number[][]> =>
    ev(
      `const L = pack.cells.routes; const out = [];
       for (const a in L) for (const b in L[a]) if (L[a][b] === args.i && +a < +b) out.push([+a, +b]);
       return out.sort((p, q) => p[0] - q[0] || p[1] - q[1]);`,
      { i }
    );
  const linkCount = (): Promise<number> =>
    ev("let n = 0; const L = pack.cells.routes; for (const a in L) n += Object.keys(L[a]).length; return n;");
  const asymmetric = (): Promise<number> =>
    ev(
      `let n = 0; const L = pack.cells.routes;
       for (const a in L) for (const b in L[a]) if (!L[b] || L[b][a] !== L[a][b]) n++;
       return n;`
    );
  const fail = async (name: string, args: Record<string, unknown>) => {
    const r = await h.call(name, args);
    assert.equal(r.isError, true, `${name} should fail: ${JSON.stringify(args).slice(0, 200)}`);
    return errorBody(r).error;
  };
  const created = (r: Obj): Obj[] => r.created as Obj[];
  const undo = (n = 1) =>
    (async () => {
      for (let k = 0; k < n; k++) await h.ok("snapshot", { action: "undo" });
    })();
  const burgPts = () => [
    { entity: { type: "burg", ref: pick.A.i } },
    { x: pick.A.x + 30, y: pick.A.y + 5 },
    { entity: { type: "burg", ref: pick.far.i } }
  ];

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "60" });
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("display", { on: ["routes"] });
    pick = (await h.ok("eval", { code: PICK_CODE, readOnly: true })).value as Obj;
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  // ------------------------------------------------------------ route groups

  test("add routeGroup: a <g> under #routes with the style attributes, last unless after/before", async () => {
    assert.deepEqual(await order(), ["roads", "trails", "searoutes"]);
    const dry = await h.ok("add", {
      type: "routeGroup",
      items: [{ id: "route-tunnels", stroke: "#3d2b6b" }],
      dryRun: true
    });
    assert.equal(dry.dryRun, true);
    assert.equal(await groupDom("route-tunnels"), null, "a dry run changes nothing");

    const r = await h.ok("add", {
      type: "routeGroup",
      items: [
        {
          id: "route-tunnels",
          name: "Tunnels",
          stroke: "#3d2b6b",
          width: 1.2,
          dash: "2, 1.2",
          linecap: "butt",
          opacity: 0.95
        },
        { id: "route-plain", after: "roads" }
      ]
    });
    const [tunnels, plain] = created(r);
    assert.equal(tunnels.i, "route-tunnels");
    assert.equal(tunnels.name, "Tunnels");
    assert.equal(tunnels.dash, "2 1.2", "dash is normalised");
    assert.deepEqual(await order(), ["roads", "route-plain", "trails", "searoutes", "route-tunnels"]);
    const g = (await groupDom("route-tunnels")) as Obj;
    assert.equal(g.parent, "routes");
    assert.deepEqual(g.attrs, {
      id: "route-tunnels",
      stroke: "#3d2b6b",
      "stroke-width": "1.2",
      "stroke-dasharray": "2 1.2",
      "stroke-linecap": "butt",
      opacity: "0.95",
      fill: "none",
      "data-name": "Tunnels"
    });
    // defaults: black, 0.5 wide, solid, butt, fully opaque
    assert.equal(plain.stroke, "#000000");
    assert.equal(plain.dash, null);
    const p = (await groupDom("route-plain")) as Obj;
    assert.equal(p.attrs["stroke-width"], "0.5");
    assert.equal("stroke-dasharray" in p.attrs, false, "a solid group has no dash attribute");
    // the change report lists the new groups
    assert.equal((r.changes as Obj).routeGroup.counts.added, 2);
  });

  test("add routeGroup validates ids, styles and fields, and changes nothing on error", async () => {
    const before = await order();
    const bad = async (item: Obj, code: string, match: RegExp) => {
      const e = await fail("add", { type: "routeGroup", items: [item] });
      assert.equal(e.code, code, `${JSON.stringify(item)}: ${e.message}`);
      assert.match(e.message, match);
    };
    await bad({ stroke: "#fff" }, "BAD_ARGS", /needs id/);
    await bad({ id: "tunnels" }, "BAD_ARGS", /start with 'route-'/);
    await bad({ id: "route tunnels" }, "BAD_ARGS", /needs id/);
    await bad({ id: "roads" }, "BAD_ARGS", /start with 'route-'/);
    await bad({ id: "route-tunnels" }, "REFUSED", /already exists/);
    await bad({ id: "route-x", stroke: "not a colour!" }, "BAD_ARGS", /CSS colour/);
    await bad({ id: "route-x", stroke: "banana" }, "BAD_ARGS", /CSS colour/);
    await bad({ id: "route-x", stroke: "rgb(1,2,3" }, "BAD_ARGS", /CSS colour/);
    await bad({ id: "route-x", name: "roads" }, "BAD_ARGS", /id of another route group/);
    await bad({ id: "route-x", dash: "wavy" }, "BAD_ARGS", /dash/);
    await bad({ id: "route-x", width: 0 }, "BAD_ARGS", /width/);
    await bad({ id: "route-x", opacity: 2 }, "BAD_ARGS", /opacity/);
    await bad({ id: "route-x", linecap: "pointy" }, "BAD_ARGS", /linecap/);
    await bad({ id: "route-x", fill: "red" }, "BAD_FIELD", /no field 'fill'/);
    await bad({ id: "route-x", after: "roads", before: "trails" }, "BAD_ARGS", /after or before/);
    await bad({ id: "route-x", after: "route-missing" }, "NOT_FOUND", /route-missing/);
    const dup = await fail("add", { type: "routeGroup", items: [{ id: "route-x" }, { id: "route-x" }] });
    assert.match(dup.message, /appears twice/);
    assert.deepEqual(await order(), before);
  });

  test("find and inspect routeGroup; a group resolves by id or by name", async () => {
    const f = await h.ok("find", { type: "routeGroup" });
    const rows = f.rows as Obj[];
    assert.deepEqual(
      rows.map(r => r.i),
      ["roads", "route-plain", "trails", "searoutes", "route-tunnels"]
    );
    const t = rows.find(r => r.i === "route-tunnels") as Obj;
    assert.deepEqual(
      { name: t.name, routes: t.routes, stroke: t.stroke, width: t.width, dash: t.dash, opacity: t.opacity },
      { name: "Tunnels", routes: 0, stroke: "#3d2b6b", width: 1.2, dash: "2 1.2", opacity: 0.95 }
    );
    assert.equal((rows.find(r => r.i === "roads") as Obj).routes > 0, true);
    const empty = await h.ok("find", { type: "routeGroup", where: { routes: 0 }, fields: ["order", "after"] });
    assert.deepEqual(
      (empty.rows as Obj[]).map(r => [r.i, r.after]),
      [
        ["route-plain", "roads"],
        ["route-tunnels", "searoutes"]
      ]
    );
    const byName = await h.ok("find", { type: "routeGroup", name: "Tunnels" });
    assert.equal((byName.rows as Obj[])[0].i, "route-tunnels");
    for (const ref of ["route-tunnels", "Tunnels", { id: "route-tunnels" }]) {
      const ins = await h.ok("inspect", { entity: { type: "routeGroup", ref } });
      assert.equal(ins.i, "route-tunnels");
      assert.equal((ins.entity as Obj).builtIn, false);
      assert.deepEqual((ins.entity as Obj).routes, []);
    }
    const roads = await h.ok("inspect", { entity: { type: "routeGroup", ref: "roads" } });
    assert.equal((roads.entity as Obj).builtIn, true);
    const missing = await fail("inspect", { entity: { type: "routeGroup", ref: "route-nope" } });
    assert.equal(missing.code, "NOT_FOUND");
    // an empty group has no position to frame
    const noPos = await fail("screenshot", { target: { entity: { type: "routeGroup", ref: "route-tunnels" } } });
    assert.equal(noPos.code, "NO_POSITION");
  });

  test("edit routeGroup: style, name, draw order; before/after are reported", async () => {
    const r = await h.ok("edit", {
      type: "routeGroup",
      ops: [
        {
          ref: "route-tunnels",
          set: { stroke: "#ff0000", width: 2, dash: [3, 1], linecap: "round", opacity: 0.5, name: "Deep tunnels" }
        }
      ]
    });
    const row = (r.applied as Obj[])[0];
    assert.deepEqual(row.before, {
      stroke: "#3d2b6b",
      width: 1.2,
      dash: "2 1.2",
      linecap: "butt",
      opacity: 0.95,
      name: "Tunnels"
    });
    assert.equal(row.after.dash, "3 1");
    assert.equal(row.name, "Deep tunnels");
    let g = (await groupDom("route-tunnels")) as Obj;
    assert.equal(g.attrs.stroke, "#ff0000");
    assert.equal(g.attrs["stroke-width"], "2");
    assert.equal(g.attrs["stroke-dasharray"], "3 1");
    assert.equal(g.attrs["stroke-linecap"], "round");
    assert.equal(g.attrs.opacity, "0.5");
    assert.equal(g.attrs["data-name"], "Deep tunnels");

    // dash null = solid (attribute removed); name null clears the label
    await h.ok("edit", { type: "routeGroup", ops: [{ ref: "Deep tunnels", set: { dash: null, name: null } }] });
    g = (await groupDom("route-tunnels")) as Obj;
    assert.equal("stroke-dasharray" in g.attrs, false);
    assert.equal("data-name" in g.attrs, false);
    await h.ok("edit", {
      type: "routeGroup",
      ops: [
        {
          ref: "route-tunnels",
          set: { stroke: "#3d2b6b", width: 1.2, dash: "2 1.2", linecap: "butt", opacity: 0.95, name: "Tunnels" }
        }
      ]
    });

    // draw order
    await h.ok("edit", { type: "routeGroup", ops: [{ ref: "route-tunnels", set: { before: "trails" } }] });
    assert.deepEqual(await order(), ["roads", "route-plain", "route-tunnels", "trails", "searoutes"]);
    await h.ok("edit", { type: "routeGroup", ops: [{ ref: "route-tunnels", set: { after: "searoutes" } }] });
    assert.deepEqual(await order(), ["roads", "route-plain", "trails", "searoutes", "route-tunnels"]);

    // built-in groups can be restyled (and undone)
    const roads = await h.ok("edit", { type: "routeGroup", ops: [{ ref: "roads", set: { stroke: "#112233" } }] });
    assert.equal((roads.applied as Obj[])[0].before.stroke, "#c44ac0");
    assert.equal(((await groupDom("roads")) as Obj).attrs.stroke, "#112233");
    await undo();
    assert.equal(((await groupDom("roads")) as Obj).attrs.stroke, "#c44ac0");

    for (const [set, match] of [
      [{ id: "tunnels" }, /start with 'route-'/],
      [{ id: "route-plain" }, /already exists/],
      [{ id: "route-tunnels" }, /already 'route-tunnels'/],
      [{ name: "route-plain" }, /id of another route group/],
      [{ after: "roads", before: "trails" }, /not both/],
      [{ after: "route-tunnels" }, /cannot be placed after itself/],
      [{ stroke: 5 }, /CSS colour/],
      [{ opacity: -1 }, /opacity/]
    ] as Array<[Obj, RegExp]>) {
      const e = await fail("edit", { type: "routeGroup", ops: [{ ref: "route-tunnels", set }] });
      assert.match(e.message, match);
    }
  });

  // ------------------------------------------------------------ freehand routes

  let tunnel = 0;

  test("add route {points, noPathfind}: exactly those points, water allowed, burg points use the burg's cell", async () => {
    const C = pick.landCell;
    const items = [
      {
        points: [
          { entity: { type: "burg", ref: pick.A.name } },
          { cell: C.cell },
          { x: C.x + 0.3, y: C.y + 0.3 }, // same cell as the previous point: no link
          pick.ocean,
          { entity: { type: "burg", ref: pick.far.i } },
          { entity: { type: "burg", ref: pick.other.i } }
        ],
        noPathfind: true,
        group: "route-tunnels",
        name: "Deep Tunnel"
      }
    ];
    const dry = await h.ok("add", { type: "route", items, dryRun: true });
    const plan = (dry.plan as Obj[])[0];
    assert.equal(plan.freehand, true);
    assert.equal(plan.points, 6);
    const count = await ev("pack.routes.length");
    const r = await h.ok("add", { type: "route", items });
    const row = created(r)[0];
    tunnel = row.i;
    assert.equal(row.freehand, true);
    assert.equal(row.points, 6);
    assert.equal(row.group, "route-tunnels");
    assert.equal(row.name, "Deep Tunnel");
    assert.ok(row.length.px > 100);
    assert.equal(row.endBurgs[0].i, pick.A.i);
    assert.equal(row.endBurgs[1].i, pick.other.i);
    assert.equal(await ev("pack.routes.length"), count + 1);

    const route = (await routeOf(tunnel)) as Obj;
    assert.equal(route.group, "route-tunnels");
    assert.equal(route.lock, true, "freehand routes are locked by default");
    assert.equal(route.name, "Deep Tunnel");
    assert.equal(route.points.length, 6);
    assert.equal(route.feature, await ev("pack.cells.f[args.c]", { c: route.points[0][2] }));
    // the first point is the burg's own cell, even where the nearest cell to its x,y differs
    assert.equal(route.points[0][2], pick.A.cell);
    assert.deepEqual(route.points[1].slice(0, 2), [C.x, C.y]);
    assert.equal(route.points[1][2], C.cell);
    assert.equal(route.points[2][2], C.cell, "the third point shares the cell");
    assert.equal(route.points[3][2], pick.ocean.cell, "a water cell is fine");
    assert.equal(route.points[4][2], pick.far.cell);

    // links: one symmetric link per consecutive pair of different cells, whatever their distance
    const cells = route.points.map((p: number[]) => p[2]);
    const want: number[][] = [];
    for (let k = 0; k < cells.length - 1; k++)
      if (cells[k] !== cells[k + 1]) want.push([Math.min(cells[k], cells[k + 1]), Math.max(cells[k], cells[k + 1])]);
    want.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    assert.deepEqual(await linksOf(tunnel), want);
    assert.equal(row.links, want.length);
    assert.equal(plan.links, want.length, "the plan predicts the links");
    assert.equal(await asymmetric(), 0, "every link has its mirror");
    const selfLinks = await ev(
      "Object.keys(pack.cells.routes).filter(a => pack.cells.routes[a][a] !== undefined).length"
    );
    assert.equal(selfLinks, 0, "no cell links to itself");
    const jump = await ev(
      "args.cells.slice(0, -1).some((a, k) => a !== args.cells[k + 1] && !pack.cells.c[a].includes(args.cells[k + 1]))",
      { cells }
    );
    assert.equal(jump, true, "the route holds links between cells that are not neighbours");

    // drawn in its own group, as one path
    const g = (await groupDom("route-tunnels")) as Obj;
    assert.deepEqual(g.kids, [`route${tunnel}`]);
    assert.match(await ev("document.getElementById('route' + args.i).getAttribute('d')", { i: tunnel }), /^M/);

    // find and inspect see it; the group counts it and can be framed
    const f = await h.ok("find", {
      type: "route",
      where: { group: "route-tunnels" },
      fields: ["group", "lock", "length"]
    });
    assert.deepEqual(
      (f.rows as Obj[]).map(x => [x.i, x.lock]),
      [[tunnel, true]]
    );
    const grp = await h.ok("find", { type: "routeGroup", name: "route-tunnels", fields: ["routes"] });
    assert.equal((grp.rows as Obj[])[0].routes, 1);
    const ins = await h.ok("inspect", { entity: { type: "routeGroup", ref: "route-tunnels" } });
    assert.deepEqual((ins.entity as Obj).routes, [tunnel]);
    const shot = await h.call("screenshot", { target: { entity: { type: "routeGroup", ref: "route-tunnels" } } });
    assert.notEqual(shot.isError, true);
    assert.equal((r.changes as Obj).route.counts.added, 1);
  });

  test("add route validates points, flags and groups", async () => {
    // two points in different cells (the demo's corner cells are large)
    const two = [{ cell: pick.A.cell }, { cell: pick.far.cell }];
    const bad = async (item: Obj, code: string, match: RegExp) => {
      const e = await fail("add", { type: "route", items: [item] });
      assert.equal(e.code, code, `${JSON.stringify(item).slice(0, 120)}: ${e.message}`);
      assert.match(e.message, match);
    };
    await bad({ points: two }, "BAD_ARGS", /noPathfind:true/);
    await bad({ points: two, noPathfind: false }, "BAD_ARGS", /noPathfind:true/);
    await bad({ points: [two[0]], noPathfind: true }, "BAD_ARGS", /at least 2/);
    await bad({ points: [two[0], two[0]], noPathfind: true }, "BAD_ARGS", /same spot/);
    await bad({ points: [two[0], { x: 5000, y: 5 }], noPathfind: true }, "OUT_OF_BOUNDS", /points\[1\]/);
    await bad({ points: two, noPathfind: true, group: "route-nope" }, "NOT_FOUND", /route-nope/);
    await bad({ points: two, noPathfind: true, through: two }, "BAD_ARGS", /not both/);
    await bad({ points: two, noPathfind: true, width: 3 }, "BAD_FIELD", /no field 'width'/);
    await bad({ points: two, noPathfind: true, lock: "yes" }, "BAD_ARGS", /lock/);
    await bad({ points: two, noPathfind: true, name: "" }, "BAD_ARGS", /name/);
    await bad({ points: Array.from({ length: 2001 }, () => two[0]), noPathfind: true }, "BAD_ARGS", /at most/);
    await bad({ through: two, noPathfind: "no" }, "BAD_ARGS", /true or false/);
  });

  test("freehand variants: through alias, lock:false, default group, a duplicate name is noted, hidden layer", async () => {
    const pts = burgPts();
    const r = await h.ok("add", {
      type: "route",
      items: [
        { through: pts, noPathfind: true, name: "Alias" },
        { points: pts, noPathfind: true, group: "route-plain", name: "Deep Tunnel", lock: false }
      ]
    });
    const [alias, unlocked] = created(r);
    assert.equal(alias.group, "roads", "roads is the default group");
    assert.equal(unlocked.group, "route-plain");
    assert.match(JSON.stringify(r.notes), /named 'Deep Tunnel' already exists/);
    assert.equal(((await routeOf(alias.i)) as Obj).lock, true);
    assert.equal("lock" in ((await routeOf(unlocked.i)) as Obj), false);
    // a hidden routes layer: nothing is drawn, and the result says so
    await h.ok("display", { off: ["routes"] });
    const hidden = await h.ok("add", {
      type: "route",
      items: [{ points: pts, noPathfind: true, group: "route-plain" }]
    });
    const hid = created(hidden)[0].i;
    assert.deepEqual(hidden.skippedHidden, ["routes"]);
    assert.equal(await ev("document.getElementById('route' + args.i)", { i: hid }), null);
    await h.ok("display", { on: ["routes"] });
    assert.ok(await ev("!!document.getElementById('route' + args.i)", { i: hid }), "drawn once the layer is on");
    // the first add, the layer off, the hidden add and the layer on are four undo entries
    await undo(4);
    assert.equal(await routeOf(alias.i), null);
    assert.equal(await routeOf(hid), null);
  });

  test("add route through: custom groups pathfind over land, and lock is accepted", async () => {
    const r = await h.ok("add", {
      type: "route",
      items: [
        {
          through: [{ entity: { type: "burg", ref: pick.A.i } }, { entity: { type: "burg", ref: pick.far.i } }],
          group: "route-plain",
          name: "Pathfound",
          lock: true
        }
      ]
    });
    const row = created(r)[0];
    assert.equal(row.group, "route-plain");
    assert.equal(row.freehand, undefined);
    const route = (await routeOf(row.i)) as Obj;
    assert.equal(route.lock, true);
    assert.ok(route.points.length > 2, "pathfound along cells");
    assert.ok(((await groupDom("route-plain")) as Obj).kids.includes(`route${row.i}`));
    const e = await fail("add", {
      type: "route",
      items: [
        {
          through: [
            { x: 1, y: 1 },
            { x: 9, y: 9 }
          ],
          group: "nope"
        }
      ]
    });
    assert.equal(e.code, "NOT_FOUND");
    await undo();
  });

  /** Pairs whose owner differs from what Routes.buildLinks gives for pack.routes (links must equal a rebuild). */
  const rebuildDiff = (): Promise<number> =>
    ev(
      `const want = Routes.buildLinks(pack.routes); const have = pack.cells.routes; let n = 0;
       const keys = new Set([...Object.keys(want), ...Object.keys(have)]);
       for (const a of keys) {
         const w = want[a] || {}, h = have[a] || {};
         for (const b of new Set([...Object.keys(w), ...Object.keys(h)])) if (w[b] !== h[b]) n++;
       }
       return n;`
    );

  test("the last route through a pair owns its link, as Routes.buildLinks has it; removal gives it back", async () => {
    const { road } = pick;
    assert.equal(await ev("pack.cells.routes[args.a][args.b]", road), road.i);
    assert.equal(await rebuildDiff(), 0, "the demo's links are what a rebuild gives");
    const r = await h.ok("add", {
      type: "route",
      items: [{ points: [{ cell: road.a }, { cell: road.b }], noPathfind: true, group: "route-plain" }]
    });
    const row = created(r)[0];
    assert.equal(row.links, 1, "the new route is last, so it takes the pair");
    assert.equal(await ev("pack.cells.routes[args.a][args.b]", road), row.i);
    assert.equal(await ev("pack.cells.routes[args.b][args.a]", road), row.i);
    assert.deepEqual(await linksOf(row.i), [[Math.min(road.a, road.b), Math.max(road.a, road.b)]]);
    assert.equal(await rebuildDiff(), 0, "and the links still equal a rebuild");
    await h.ok("edit", { type: "route", ops: [{ ref: row.i, remove: true }] });
    assert.equal(await ev("pack.cells.routes[args.a][args.b]", road), road.i, "the road has its link back");
    assert.equal(await ev("pack.cells.routes[args.b][args.a]", road), road.i);
    assert.equal(await rebuildDiff(), 0);
    await undo(2);
  });

  test("when the route that owns a shared link goes or moves away, the last other route through the pair takes it", async () => {
    const A = { cell: pick.A.cell };
    const far = { cell: pick.far.cell };
    const r = await h.ok("add", {
      type: "route",
      items: [
        { points: [A, far], noPathfind: true, group: "route-plain", name: "First" },
        { points: [A, far, { x: 100, y: 100 }], noPathfind: true, group: "route-plain", name: "Second" }
      ]
    });
    const [first, second] = created(r);
    const pair = [Math.min(A.cell, far.cell), Math.max(A.cell, far.cell)];
    const has = async (id: number) => (await linksOf(id)).some(p => p[0] === pair[0] && p[1] === pair[1]);
    assert.equal(first.links, 1);
    assert.equal(second.links, 2, "two distinct pairs");
    assert.equal(await has(first.i), false, "the second route, added last, owns the shared pair");
    assert.equal(await has(second.i), true);
    assert.equal(await rebuildDiff(), 0);
    // removing the owner hands the pair on
    await h.ok("edit", { type: "route", ops: [{ ref: second.i, remove: true }] });
    assert.equal(await has(first.i), true);
    assert.equal(await asymmetric(), 0);
    assert.equal(await rebuildDiff(), 0);
    await undo(); // the removal: the second route owns it again
    assert.equal(await has(second.i), true);
    // editing the owner's points away hands it on too
    await h.ok("edit", {
      type: "route",
      ops: [
        {
          ref: second.i,
          set: {
            points: [{ cell: pick.offCell.cell }, { cell: pick.other.cell }]
          }
        }
      ]
    });
    assert.equal(await has(first.i), true);
    assert.equal(await has(second.i), false);
    assert.equal(await asymmetric(), 0);
    assert.equal(await rebuildDiff(), 0);
    // editing the earlier route back over the pair does not take it from the later route
    await h.ok("edit", { type: "route", ops: [{ ref: second.i, set: { points: [A, far, { x: 100, y: 100 }] } }] });
    assert.equal(await has(second.i), true, "the later route owns it again");
    await h.ok("edit", { type: "route", ops: [{ ref: first.i, set: { points: [far, A, { x: 300, y: 300 }] } }] });
    assert.equal(await has(second.i), true, "the earlier route does not steal it");
    assert.equal(await rebuildDiff(), 0);
    await undo(4);
    assert.equal(await routeOf(first.i), null);
  });

  test("edit route {points}: path, links, feature and a cached length follow; other fields can ride along", async () => {
    const before = await linksOf(tunnel);
    assert.ok(before.length >= 3);
    const next = [{ x: 100, y: 100 }, { entity: { type: "burg", ref: pick.offCell.i } }, { x: 400, y: 300 }];
    // a cached length (the route editor sets it) would go stale
    await h.ok("eval", { code: "pack.routes.find(r => r.i === args.i).length = 123; return 1;", args: { i: tunnel } });
    const dry = await h.ok("edit", { type: "route", ops: [{ ref: tunnel, set: { points: next } }], dryRun: true });
    assert.equal((dry.plan as Obj[])[0].after.points.n, 3);
    assert.deepEqual(await linksOf(tunnel), before, "a dry run changes nothing");

    const r = await h.ok("edit", {
      type: "route",
      ops: [{ ref: tunnel, set: { points: next, name: "Short Tunnel" } }]
    });
    const row = (r.applied as Obj[])[0];
    assert.equal(row.before.points.n, 6);
    assert.equal(row.after.points.n, 3);
    assert.deepEqual(row.after.points.from.slice(0, 2), [100, 100]);
    assert.notEqual(row.before.points.h, row.after.points.h);
    const route = (await routeOf(tunnel)) as Obj;
    assert.equal(route.points.length, 3);
    assert.equal(route.points[1][2], pick.offCell.cell, "burg points use the burg's cell");
    assert.equal(route.name, "Short Tunnel");
    assert.equal(route.lock, true, "lock is untouched");
    assert.equal("length" in route, false, "the cached length is dropped");
    assert.equal(route.feature, await ev("pack.cells.f[args.c]", { c: route.points[0][2] }));
    const cells = route.points.map((p: number[]) => p[2]);
    const want = [
      [cells[0], cells[1]],
      [cells[1], cells[2]]
    ]
      .map(([a, b]) => [Math.min(a, b), Math.max(a, b)])
      .sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    assert.deepEqual(await linksOf(tunnel), want, "old links are gone, new ones made");
    assert.equal(await asymmetric(), 0);
    assert.match(await ev("document.getElementById('route' + args.i).getAttribute('d')", { i: tunnel }), /^M100,100/);
    assert.equal((r.changes as Obj).route.modified[0].fields.points, "changed");

    for (const [set, code, match] of [
      [{ points: [{ x: 1, y: 1 }] }, "BAD_ARGS", /at least 2/],
      [
        {
          points: [
            { x: 1, y: 1 },
            { x: 99999, y: 1 }
          ]
        },
        "OUT_OF_BOUNDS",
        /points\[1\]/
      ],
      [{ points: "no" }, "BAD_ARGS", /at least 2/],
      [{ group: "route-nope" }, "NOT_FOUND", /group: no routeGroup named 'route-nope'/],
      [{ group: "" }, "BAD_ARGS", /group must be/]
    ] as Array<[Obj, string, RegExp]>) {
      const e = await fail("edit", { type: "route", ops: [{ ref: tunnel, set }] });
      assert.equal(e.code, code);
      assert.match(e.message, match);
    }
  });

  test("edit route {group}: to a custom group by id or by name; the path moves to that <g>", async () => {
    await h.ok("edit", { type: "route", ops: [{ ref: tunnel, set: { group: "route-plain" } }] });
    assert.deepEqual(((await groupDom("route-tunnels")) as Obj).kids, []);
    assert.ok(((await groupDom("route-plain")) as Obj).kids.includes(`route${tunnel}`));
    assert.equal(((await routeOf(tunnel)) as Obj).group, "route-plain");
    const r = await h.ok("edit", { type: "route", ops: [{ ref: tunnel, set: { group: "Tunnels" } }] });
    assert.equal((r.applied as Obj[])[0].after.group, "route-tunnels", "a group name resolves to its id");
    assert.ok(((await groupDom("route-tunnels")) as Obj).kids.includes(`route${tunnel}`));
  });

  // ------------------------------------------------------------ removing groups

  test("remove routeGroup: only when empty; force moves the routes; built-in groups stay", async () => {
    await h.ok("add", { type: "routeGroup", items: [{ id: "route-rm" }, { id: "route-fb" }] });
    const m = created(
      await h.ok("add", {
        type: "route",
        items: [{ points: burgPts(), noPathfind: true, group: "route-rm", name: "Mover" }]
      })
    )[0];
    // moveTo belongs to removing a routeGroup; force to removing a routeGroup or (dx/clear) a burg
    const f1 = await fail("edit", { type: "burg", ops: [{ ref: pick.A.i, remove: true, moveTo: "roads" }] });
    assert.equal(f1.code, "BAD_ARGS");
    assert.match(f1.message, /only to removing a routeGroup/);
    const f1b = await fail("edit", { type: "state", ops: [{ ref: 1, remove: true, force: true }] });
    assert.equal(f1b.code, "BAD_ARGS");
    assert.match(f1b.message, /only to removing a burg or a routeGroup/);
    const f2 = await fail("edit", {
      type: "routeGroup",
      ops: [{ ref: "route-rm", set: { stroke: "#fff" }, force: true }]
    });
    assert.match(f2.message, /go with remove:true/);
    const full = await fail("edit", { type: "routeGroup", ops: [{ ref: "route-rm", remove: true }] });
    assert.equal(full.code, "REFUSED");
    assert.match(full.message, /holds 1 route/);
    assert.match(full.message, /force:true/);
    assert.ok(await groupDom("route-rm"), "still there");
    for (const ref of ["roads", "trails", "searoutes"]) {
      const e = await fail("edit", { type: "routeGroup", ops: [{ ref, remove: true, force: true }] });
      assert.equal(e.code, "REFUSED");
      assert.match(e.message, /built-in/);
    }
    const same = await fail("edit", {
      type: "routeGroup",
      ops: [{ ref: "route-rm", remove: true, force: true, moveTo: "route-rm" }]
    });
    assert.match(same.message, /another group/);
    const nope = await fail("edit", {
      type: "routeGroup",
      ops: [{ ref: "route-rm", remove: true, force: true, moveTo: "route-nope" }]
    });
    assert.equal(nope.code, "NOT_FOUND");

    const dry = await h.ok("edit", {
      type: "routeGroup",
      ops: [{ ref: "route-rm", remove: true, force: true, moveTo: "route-fb" }],
      dryRun: true
    });
    assert.deepEqual(
      { routes: (dry.plan as Obj[])[0].routes, moveTo: (dry.plan as Obj[])[0].moveTo },
      { routes: 1, moveTo: "route-fb" }
    );
    assert.ok(await groupDom("route-rm"), "a dry run removes nothing");

    const r = await h.ok("edit", {
      type: "routeGroup",
      ops: [{ ref: "route-rm", remove: true, force: true, moveTo: "route-fb" }]
    });
    const row = (r.applied as Obj[])[0];
    assert.deepEqual([row.removed, row.moved, row.moveTo], [true, 1, "route-fb"]);
    assert.equal(await groupDom("route-rm"), null);
    assert.equal(((await routeOf(m.i)) as Obj).group, "route-fb");
    assert.ok(((await groupDom("route-fb")) as Obj).kids.includes(`route${m.i}`), "redrawn in the fallback group");
    assert.equal((r.changes as Obj).routeGroup.counts.removed, 1);

    // force without moveTo falls back to roads
    const r2 = await h.ok("edit", { type: "routeGroup", ops: [{ ref: "route-fb", remove: true, force: true }] });
    assert.equal((r2.applied as Obj[])[0].moveTo, "roads");
    assert.equal(((await routeOf(m.i)) as Obj).group, "roads");
    assert.ok(((await groupDom("roads")) as Obj).kids.includes(`route${m.i}`));
    // an empty group needs no force
    await h.ok("add", { type: "routeGroup", items: [{ id: "route-empty" }] });
    const e = await h.ok("edit", { type: "routeGroup", ops: [{ ref: "route-empty", remove: true }] });
    assert.equal((e.applied as Obj[])[0].moved, undefined);
    assert.equal(await groupDom("route-empty"), null);
    await h.ok("edit", { type: "route", ops: [{ ref: m.i, remove: true }] });
  });

  test("group operations are undoable: the group, its style and its routes come back", async () => {
    const start = await order();
    await h.ok("add", {
      type: "routeGroup",
      items: [{ id: "route-undo", stroke: "#abcdef", width: 3, dash: "1 1", name: "Undo me" }]
    });
    const r = created(
      await h.ok("add", { type: "route", items: [{ points: burgPts(), noPathfind: true, group: "route-undo" }] })
    )[0];
    await h.ok("edit", { type: "routeGroup", ops: [{ ref: "route-undo", remove: true, force: true }] });
    assert.equal(await groupDom("route-undo"), null);
    assert.equal(((await routeOf(r.i)) as Obj).group, "roads");
    await undo(); // the removal
    const g = (await groupDom("route-undo")) as Obj;
    assert.equal(g.attrs.stroke, "#abcdef");
    assert.equal(g.attrs["stroke-dasharray"], "1 1");
    assert.equal(g.attrs["data-name"], "Undo me");
    assert.equal(((await routeOf(r.i)) as Obj).group, "route-undo");
    assert.deepEqual(g.kids, [`route${r.i}`], "the route is drawn in its group again");
    await undo(); // the route
    assert.equal(await routeOf(r.i), null);
    await undo(); // the group
    assert.equal(await groupDom("route-undo"), null);
    assert.deepEqual(await order(), start);
    // redo walks forward again
    await h.ok("snapshot", { action: "redo" });
    assert.ok(await groupDom("route-undo"));
    await undo();
  });

  // ------------------------------------------------------------ save, load, regenerate

  test("groups, styles, order and routes survive save_map and load_map", async () => {
    await h.ok("edit", { type: "route", ops: [{ ref: tunnel, set: { group: "route-tunnels" } }] });
    const saved = await h.ok("save_map", { path: "routes-roundtrip.map", overwrite: true });
    const text = fs.readFileSync(saved.path as string, "utf8");
    assert.match(text, /<g id="route-tunnels"[^>]*data-name="Tunnels"/);
    const orderBefore = await order();
    const tunnelBefore = (await routeOf(tunnel)) as Obj;
    const linksBefore = await linksOf(tunnel);
    const domBefore = (await groupDom("route-tunnels")) as Obj;
    await h.ok("load_map", { path: saved.path as string });
    assert.deepEqual(await order(), orderBefore, "custom groups load in their draw order");
    const domAfter = (await groupDom("route-tunnels")) as Obj;
    assert.deepEqual(domAfter.attrs, domBefore.attrs, "style attributes load unchanged");
    assert.deepEqual(domAfter.kids, domBefore.kids, "the route is drawn in its custom group after load");
    assert.deepEqual(await routeOf(tunnel), tunnelBefore);
    assert.deepEqual(await linksOf(tunnel), linksBefore, "freehand links load with the map");
    // drawRoutes (layer off/on) refills the existing groups and keeps their style
    await h.ok("display", { off: ["routes"] });
    await h.ok("display", { on: ["routes"] });
    const redrawn = (await groupDom("route-tunnels")) as Obj;
    assert.deepEqual(redrawn.attrs, domBefore.attrs);
    assert.ok(redrawn.kids.includes(`route${tunnel}`));
    const f = await h.ok("find", { type: "routeGroup", name: "Tunnels" });
    assert.equal((f.rows as Obj[])[0].i, "route-tunnels", "find works on a loaded map");
  });

  test("regenerate routes keeps locked freehand routes in their custom group, renumbers them, and moves their notes", async () => {
    await h.ok("add", {
      type: "route",
      items: [{ points: burgPts(), noPathfind: true, group: "route-plain", name: "Gone", lock: false }]
    });
    const gone = (await routeNamed("Gone")) as Obj;
    assert.ok(gone);
    // notes are keyed 'route<id>': one on the locked route, one on the route that will be replaced
    await h.ok("eval", {
      code: `notes.push({ id: 'route' + args.keep, name: 'Kept note', legend: 'k' }, { id: 'route' + args.gone, name: 'Gone note', legend: 'g' }, { id: 'burg1', name: 'Other', legend: 'o' }); return notes.length;`,
      args: { keep: tunnel, gone: gone.i }
    });
    const reg = await h.ok("regenerate", { parts: ["routes"] }, 240_000);
    assert.equal(await routeNamed("Gone"), null, "an unlocked route is regenerated away");
    const kept = (await routeNamed("Short Tunnel")) as Obj;
    assert.ok(kept, "the locked freehand route survives");
    assert.equal(kept.group, "route-tunnels");
    assert.equal(kept.lock, true);
    assert.equal(kept.i, 0, "locked routes are renumbered from 0");
    const g = (await groupDom("route-tunnels")) as Obj;
    assert.ok(g.kids.includes(`route${kept.i}`), "and is drawn in its group");
    assert.equal(g.attrs.stroke, "#3d2b6b", "regenerating does not touch group styles");
    assert.equal((await linksOf(kept.i)).length, 2, "its links were rebuilt under the renumbered id");
    assert.equal(await rebuildDiff(), 0);
    // the note followed its route; the replaced route's note is gone; other notes are untouched
    const ids = await ev("notes.filter(n => /^route|^burg1$/.test(n.id)).map(n => [n.id, n.name])");
    assert.deepEqual(ids, [
      ["route0", "Kept note"],
      ["burg1", "Other"]
    ]);
    assert.deepEqual(reg.routeIds, { [String(tunnel)]: 0 });
    assert.match(JSON.stringify(reg.notes), new RegExp(`renumbered \\(${tunnel}->0`));
    assert.match(JSON.stringify(reg.notes), /1 route note\(s\) moved/);
    assert.match(JSON.stringify(reg.notes), /1 note\(s\) of replaced routes removed/);
    await undo(); // regenerate
    assert.equal(((await routeNamed("Short Tunnel")) as Obj).i, tunnel);
    assert.equal(
      await ev("notes.some(n => n.id === 'route' + args.i)", { i: tunnel }),
      true,
      "undo restores the notes"
    );
    await undo(2); // the notes, the "Gone" route
    assert.equal(await routeNamed("Gone"), null);
  });

  test("removing a freehand route removes exactly its links", async () => {
    const mine = await linksOf(tunnel);
    assert.ok(mine.length > 0);
    const total = await linkCount();
    await h.ok("edit", { type: "route", ops: [{ ref: tunnel, remove: true }] });
    assert.deepEqual(await linksOf(tunnel), []);
    assert.equal(await linkCount(), total - mine.length * 2, "only the route's links went");
    assert.equal(await asymmetric(), 0);
    assert.equal(await ev("document.getElementById('route' + args.i)", { i: tunnel }), null);
    await undo();
    assert.deepEqual(await linksOf(tunnel), mine, "undo restores the links");
  });

  // ------------------------------------------------------------ review fixes

  test("a group whose display name equals another group's id cannot hide it: an exact id wins", async () => {
    // add/edit refuse such a name, so make one by hand (as a loaded map could hold)
    await h.ok("eval", {
      code: "document.getElementById('route-plain').setAttribute('data-name', 'roads'); return 1;"
    });
    const r = await h.ok("add", {
      type: "route",
      items: [{ points: burgPts(), noPathfind: true, name: "ShadowTest" }]
    });
    const row = created(r)[0];
    assert.equal(row.group, "roads", "no group given: the built-in roads, not an ambiguity");
    await h.ok("edit", { type: "route", ops: [{ ref: row.i, set: { group: "roads" } }] });
    await h.ok("edit", { type: "route", ops: [{ ref: row.i, set: { group: "route-plain" } }] });
    assert.equal(((await routeOf(row.i)) as Obj).group, "route-plain");
    const f = await h.ok("find", { type: "routeGroup", name: "roads", limit: 5 });
    assert.equal((f.rows as Obj[])[0].i, "roads");
    // a force remove falls back to roads (its default moveTo) even though another group is named 'roads'
    await h.ok("add", { type: "routeGroup", items: [{ id: "route-shadow" }] });
    await h.ok("edit", { type: "route", ops: [{ ref: row.i, set: { group: "route-shadow" } }] });
    const rm = await h.ok("edit", { type: "routeGroup", ops: [{ ref: "route-shadow", remove: true, force: true }] });
    assert.equal((rm.applied as Obj[])[0].moveTo, "roads");
    assert.equal(((await routeOf(row.i)) as Obj).group, "roads");
    await undo(7);
    assert.equal(await ev("document.getElementById('route-plain').getAttribute('data-name')"), null);
  });

  test("removing groups in one call: the checks see what the earlier ops of the call do", async () => {
    await h.ok("add", { type: "routeGroup", items: [{ id: "route-b1" }, { id: "route-b2" }] });
    const m = created(
      await h.ok("add", { type: "route", items: [{ points: burgPts(), noPathfind: true, group: "route-b1" }] })
    )[0];
    const intact = async () => {
      assert.ok(await groupDom("route-b1"));
      assert.ok(await groupDom("route-b2"));
      assert.equal(((await routeOf(m.i)) as Obj).group, "route-b1");
    };
    // moveTo names a group an earlier op removes
    const e1 = await fail("edit", {
      type: "routeGroup",
      ops: [
        { ref: "route-b2", remove: true },
        { ref: "route-b1", remove: true, force: true, moveTo: "route-b2" }
      ]
    });
    assert.equal(e1.code, "BAD_ARGS");
    assert.match(e1.message, /removed earlier in this call/);
    await intact();
    // a group an earlier op moves routes into is not empty any more
    const e2 = await fail("edit", {
      type: "routeGroup",
      ops: [
        { ref: "route-b1", remove: true, force: true, moveTo: "route-b2" },
        { ref: "route-b2", remove: true }
      ]
    });
    assert.equal(e2.code, "REFUSED");
    assert.match(e2.message, /moved in by an earlier op/);
    await intact();
    const e3 = await fail("edit", {
      type: "routeGroup",
      ops: [
        { ref: "route-b2", remove: true },
        { ref: "route-b2", remove: true }
      ]
    });
    assert.match(e3.message, /removed twice/);
    await intact();
    // a chain that is consistent applies in order
    const ok = await h.ok("edit", {
      type: "routeGroup",
      ops: [
        { ref: "route-b1", remove: true, force: true, moveTo: "route-b2" },
        { ref: "route-b2", remove: true, force: true }
      ]
    });
    assert.deepEqual(
      (ok.applied as Obj[]).map(a => [a.moved, a.moveTo]),
      [
        [1, "route-b2"],
        [1, "roads"]
      ]
    );
    assert.equal(((await routeOf(m.i)) as Obj).group, "roads");
    await undo(3);
  });

  test("a pinned point [x, y, cell] keeps its cell while the line is drawn at x,y", async () => {
    const C = pick.landCell;
    const other = pick.far.cell;
    const items = [
      {
        points: [[C.x + 3, C.y + 2, other], { x: C.x, y: C.y, cell: C.cell }, { x: C.x + 40, y: C.y + 40 }],
        noPathfind: true,
        group: "route-plain",
        name: "Pinned"
      }
    ];
    const r = await h.ok("add", { type: "route", items });
    const route = (await routeOf(created(r)[0].i)) as Obj;
    assert.deepEqual(route.points[0], [C.x + 3, C.y + 2, other], "x,y as given, the pinned cell");
    assert.deepEqual(route.points[1], [C.x, C.y, C.cell]);
    assert.equal(route.points[0][2] === (await ev("findCell(args.x, args.y)", { x: C.x + 3, y: C.y + 2 })), false);
    assert.equal(route.feature, await ev("pack.cells.f[args.c]", { c: other }));
    // edit with a pinned point (the builder moved a drawn coordinate and kept the cell)
    await h.ok("edit", {
      type: "route",
      ops: [
        {
          ref: route.i,
          set: { points: [[C.x + 9, C.y + 9, other], { x: C.x, y: C.y, cell: C.cell }, [C.x + 40, C.y + 40, other]] }
        }
      ]
    });
    const moved = (await routeOf(route.i)) as Obj;
    assert.deepEqual(moved.points[0], [C.x + 9, C.y + 9, other]);
    assert.deepEqual(moved.points[2], [C.x + 40, C.y + 40, other]);
    assert.equal(await rebuildDiff(), 0);
    for (const [pt, code, match] of [
      [[1, 2], "BAD_PLACE", /\[x, y, cell\]/],
      [[1, 2, 99999999], "OUT_OF_BOUNDS", /cell 99999999/],
      [{ x: 1, y: 2, cell: -1 }, "OUT_OF_BOUNDS", /cell -1/],
      [[99999, 2, other], "OUT_OF_BOUNDS", /outside the map/]
    ] as Array<[unknown, string, RegExp]>) {
      const e = await fail("add", {
        type: "route",
        items: [{ points: [pt, { x: 100, y: 100 }], noPathfind: true }]
      });
      assert.equal(e.code, code, e.message);
      assert.match(e.message, match);
      assert.match(e.message, /points\[0\]/);
    }
    await undo(2);
  });

  test("freehand add: dry-run rows carry the name and notes; points in one cell link nothing and say so", async () => {
    const dry = await h.ok("add", {
      type: "route",
      items: [{ points: burgPts(), noPathfind: true, name: "Short Tunnel", group: "route-plain" }],
      dryRun: true
    });
    const row = (dry.plan as Obj[])[0];
    assert.equal(row.name, "Short Tunnel");
    assert.match(String(row.notes), /named 'Short Tunnel' already exists/);
    // points that all fall into one cell are allowed (a short decorative line) with a note: nothing is linked
    const C = pick.landCell;
    const one = await h.ok("add", {
      type: "route",
      items: [
        {
          points: [{ x: C.x, y: C.y }, { x: C.x + 0.2, y: C.y + 0.1 }, { cell: C.cell }],
          noPathfind: true,
          group: "route-plain"
        }
      ]
    });
    assert.equal(created(one)[0].links, 0);
    assert.match(JSON.stringify(one.notes), /links no cells/);
    assert.deepEqual(await linksOf(created(one)[0].i), []);
    assert.equal(await rebuildDiff(), 0);
    await undo();
    const twice = await h.ok("add", {
      type: "route",
      items: [
        { points: burgPts(), noPathfind: true, name: "Twin", group: "route-plain" },
        { points: burgPts(), noPathfind: true, name: "Twin", group: "route-plain" }
      ]
    });
    assert.match(JSON.stringify(twice.notes), /'Twin' is used twice/);
    await undo();
  });

  test("a pathfound dry run measures the line that is drawn", async () => {
    const items = [
      {
        through: [{ entity: { type: "burg", ref: pick.A.i } }, { entity: { type: "burg", ref: pick.far.i } }],
        group: "route-plain"
      }
    ];
    const dry = await h.ok("add", { type: "route", items, dryRun: true });
    const planned = ((dry.plan as Obj[])[0].length as Obj).px;
    const real = created(await h.ok("add", { type: "route", items }))[0];
    assert.equal(planned, real.length.px, "the plan and the drawn route have the same length");
    await undo();
  });

  test("edit route {points}: batch order, locking and no-op notes", async () => {
    const made = created(
      await h.ok("add", {
        type: "route",
        items: [
          { points: burgPts(), noPathfind: true, group: "route-plain", name: "R1", lock: false },
          { points: burgPts(), noPathfind: true, group: "route-plain", name: "R2", lock: false }
        ]
      })
    );
    const [r1, r2] = made;
    // an unlocked route that becomes hand-drawn is lost on regenerate: say so
    const same = await h.ok("edit", { type: "route", ops: [{ ref: r1.i, set: { points: burgPts() } }] });
    assert.match(JSON.stringify(same.notes), /not locked/);
    assert.match(JSON.stringify(same.notes), /points are the same as before/);
    const kept = await h.ok("edit", {
      type: "route",
      ops: [
        {
          ref: r1.i,
          set: {
            points: [
              { x: 120, y: 120 },
              { x: 260, y: 200 }
            ],
            lock: true
          }
        }
      ]
    });
    assert.doesNotMatch(JSON.stringify(kept.notes ?? []), /not locked/, "lock:true in the same op is enough");
    // a place that names a route an earlier op of the same call removes still applies (it was resolved when checked)
    const batch = await h.ok("edit", {
      type: "route",
      ops: [
        { ref: r1.i, remove: true },
        {
          ref: r2.i,
          set: {
            points: [
              { entity: { type: "route", ref: r1.i }, at: 0.5 },
              { x: 400, y: 300 }
            ]
          }
        }
      ]
    });
    assert.deepEqual(batch.errors ?? [], []);
    assert.equal(await routeOf(r1.i), null);
    const r2now = (await routeOf(r2.i)) as Obj;
    assert.equal(r2now.points.length, 2);
    assert.deepEqual(r2now.points[0].slice(0, 2), [190, 160], "the middle of the removed route's line");
    assert.equal(await rebuildDiff(), 0);
    await undo(4);
  });

  test("find route where:{group} takes ids and names; inspect route shows unit, lock and note; counts include groups", async () => {
    const mk = created(
      await h.ok("add", {
        type: "route",
        items: [{ points: burgPts(), noPathfind: true, group: "route-tunnels", name: "Seen" }]
      })
    )[0];
    for (const g of ["route-tunnels", "Tunnels", ["Tunnels", "roads"]]) {
      const f = await h.ok("find", { type: "route", where: { group: g }, fields: ["group"], limit: 500 });
      assert.ok(
        (f.rows as Obj[]).some(x => x.i === mk.i),
        `group ${JSON.stringify(g)} finds the route`
      );
    }
    const nope = await fail("find", { type: "route", where: { group: "Ferries" } });
    assert.equal(nope.code, "NOT_FOUND");
    await h.ok("eval", {
      code: "notes.push({ id: 'route' + args.i, name: 'About it', legend: 'x' }); return 1;",
      args: { i: mk.i }
    });
    const ins = await h.ok("inspect", { entity: { type: "route", ref: mk.i } });
    const rel = ins.relations as Obj;
    assert.equal(rel.lock, true);
    assert.ok(rel.length.px > 0 && Object.keys(rel.length).length === 2, JSON.stringify(rel.length));
    assert.equal(rel.note.name, "About it");
    const info = await h.ok("map_info", {});
    assert.equal((info.counts as Obj).routeGroups, await ev("document.querySelectorAll('#routes > g').length"));
    await undo(2);
  });

  test("group ids: in-batch anchors, rename (routes follow), and the empty-group error", async () => {
    // an anchor created earlier in the same call
    const r = await h.ok("add", {
      type: "routeGroup",
      items: [{ id: "route-n1" }, { id: "route-n2", after: "route-n1" }, { id: "route-n3", before: "route-n1" }]
    });
    assert.equal(created(r).length, 3);
    const o = await order();
    assert.deepEqual(o.slice(o.indexOf("route-n3"), o.indexOf("route-n3") + 3), ["route-n3", "route-n1", "route-n2"]);
    const dup = await fail("add", { type: "routeGroup", items: [{ id: "route-n4", after: "route-n9" }] });
    assert.equal(dup.code, "NOT_FOUND");
    // rename: the group keeps its style and position, its routes follow, path elements stay drawn inside it
    await h.ok("edit", { type: "routeGroup", ops: [{ ref: "route-n1", set: { stroke: "#123456", width: 2 } }] });
    const m = created(
      await h.ok("add", { type: "route", items: [{ points: burgPts(), noPathfind: true, group: "route-n1" }] })
    )[0];
    const rn = await h.ok("edit", { type: "routeGroup", ops: [{ ref: "route-n1", set: { id: "route-renamed" } }] });
    assert.equal((rn.applied as Obj[])[0].before.id, "route-n1");
    assert.equal((rn.applied as Obj[])[0].after.id, "route-renamed");
    assert.equal(await groupDom("route-n1"), null);
    const g = (await groupDom("route-renamed")) as Obj;
    assert.equal(g.attrs.stroke, "#123456");
    assert.deepEqual(g.kids, [`route${m.i}`]);
    assert.equal(((await routeOf(m.i)) as Obj).group, "route-renamed");
    const o2 = await order();
    assert.equal(o2.indexOf("route-renamed"), o.indexOf("route-n1"), "same place in the draw order");
    // refused: built-ins, a taken id, a bad id
    for (const [ref, id, match] of [
      ["roads", "route-roads2", /built-in/],
      ["route-renamed", "route-n2", /already exists/],
      ["route-renamed", "plain", /start with 'route-'/]
    ] as Array<[string, string, RegExp]>) {
      const e = await fail("edit", { type: "routeGroup", ops: [{ ref, set: { id } }] });
      assert.match(e.message, match);
    }
    await undo(); // rename
    assert.equal(((await routeOf(m.i)) as Obj).group, "route-n1", "undo points the routes back");
    assert.ok(await groupDom("route-n1"));
    await undo(3);
    assert.equal(await groupDom("route-n1"), null);
  });

  test("route group errors are the same on add and edit; an empty group is a clear error", async () => {
    const two = [{ cell: pick.A.cell }, { cell: pick.far.cell }];
    const add = await fail("add", { type: "route", items: [{ points: two, noPathfind: true, group: "route-nope" }] });
    const edit = await fail("edit", { type: "route", ops: [{ ref: tunnel, set: { group: "route-nope" } }] });
    assert.equal(add.code, "NOT_FOUND");
    assert.equal(edit.code, "NOT_FOUND");
    const empty = await fail("edit", { type: "route", ops: [{ ref: tunnel, set: { group: "" } }] });
    assert.equal(empty.code, "BAD_ARGS");
    assert.doesNotMatch(empty.message, /querySelector/);
  });

  test("the change report shows a group's old and new colour", async () => {
    const r = await h.ok("edit", { type: "routeGroup", ops: [{ ref: "route-tunnels", set: { stroke: "#445566" } }] });
    const fields = ((r.changes as Obj).routeGroup.modified as Obj[])[0].fields;
    assert.deepEqual(fields.stroke, ["#3d2b6b", "#445566"]);
    await undo();
  });

  // ------------------------------------------------------------ sketch replay

  const copies = { routes: "", group: "" };
  let sketchRoute = 0;

  test("sketch: group and freehand ops are logged replayable with literal resolved forms", async () => {
    // copies of the demo that "someone else" changed (made before the sketch starts)
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("eval", {
      code: `const id = Routes.getNextId();
        pack.routes.push({ i: id, group: 'trails', feature: pack.cells.f[args.cell], points: [[args.x, args.y, args.cell], [args.x + 1, args.y + 1, args.cell]], name: 'Theirs' });
        pack.burgs[args.far].name = 'Elsewhere'; return id;`,
      args: { cell: pick.A.cell, x: pick.A.x, y: pick.A.y, far: pick.far.i }
    });
    copies.routes = (await h.ok("save_map", { path: "other-routes.map", overwrite: true })).path as string;
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("eval", {
      code: `const g = document.createElementNS('http://www.w3.org/2000/svg', 'g'); g.id = 'route-tunnels'; document.getElementById('routes').append(g); return 1;`
    });
    copies.group = (await h.ok("save_map", { path: "other-group.map", overwrite: true })).path as string;
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });

    await h.ok("sketch", { action: "start", slug: "t-routes", note: "Tunnels" });
    await h.ok("display", { on: ["routes"] });
    await h.ok("add", {
      type: "routeGroup",
      items: [{ id: "route-tunnels", name: "Tunnels", stroke: "#3d2b6b", width: 1.2, dash: "2 1.2" }]
    });
    const add = await h.ok("add", {
      type: "route",
      items: [
        {
          points: [
            { entity: { type: "burg", ref: pick.A.i } },
            { x: pick.A.x + 40, y: pick.A.y + 20, cell: pick.other.cell },
            { entity: { type: "burg", ref: pick.far.i } }
          ],
          noPathfind: true,
          group: "route-tunnels",
          name: "Sketch Tunnel"
        }
      ]
    });
    sketchRoute = created(add)[0].i;
    await h.ok("edit", {
      type: "route",
      ops: [
        {
          ref: sketchRoute,
          set: { points: [{ entity: { type: "burg", ref: pick.A.i } }, { x: 300, y: 300, cell: pick.far.cell }] }
        }
      ]
    });
    await h.ok("edit", {
      type: "routeGroup",
      ops: [{ ref: "route-tunnels", set: { stroke: "#00aa00", after: "searoutes" } }]
    });
    await h.ok("add", { type: "routeGroup", items: [{ id: "route-spare", before: "route-tunnels" }] });
    await h.ok("edit", { type: "routeGroup", ops: [{ ref: "route-spare", set: { id: "route-moved" } }] });
    await h.ok("edit", {
      type: "routeGroup",
      ops: [{ ref: "route-tunnels", remove: true, force: true, moveTo: "route-moved" }]
    });
    const st = await h.ok("sketch", { action: "status", full: true });
    assert.equal(st.blobOnly, false, JSON.stringify(st.blobOnlyReasons));
    const recs = st.records as Obj[];
    assert.deepEqual(
      recs.map(r => r.tool),
      ["display", "add", "add", "edit", "edit", "add", "edit", "edit"]
    );
    assert.ok(recs.every(r => r.replayable));
    const rr = recs[2].resolved;
    assert.equal(rr.items[0].noPathfind, true);
    assert.equal(rr.items[0].group, "route-tunnels");
    assert.equal(rr.items[0].lock, true);
    assert.deepEqual(rr.items[0].points[0], { entity: { type: "burg", ref: pick.A.i } });
    assert.equal(rr.items[0].points[1].x, pick.A.x + 40);
    assert.equal(rr.items[0].points[1].cell, pick.other.cell, "a pinned cell is kept in the resolved form");
    assert.deepEqual(rr.created, [[{ type: "route", i: sketchRoute }]]);
    assert.deepEqual(recs[1].resolved.created, [[{ type: "routeGroup", i: "route-tunnels" }]]);
    assert.equal(recs[1].resolved.items[0].width, 1.2);
    assert.equal(recs[1].resolved.items[0].linecap, "butt", "defaults are recorded explicitly");
    assert.deepEqual(recs[3].resolved.ops[0].set.points[0], { entity: { type: "burg", ref: pick.A.i } });
    assert.deepEqual(recs[6].resolved.ops[0].set, { id: "route-moved" });
    assert.equal(recs[7].resolved.ops[0].force, true);
    assert.equal(recs[7].resolved.ops[0].moveTo, "route-moved");
    assert.match(String(recs[3].summary), /points 3 -> 2 \(.* -> .* px\)/);
    assert.match(String(recs[7].summary), /[Rr]emoved routeGroup .*route-tunnels.* \(1 route moved to route-moved\)/);
    assert.match(String(recs[2].summary), /Sketch Tunnel/);
    assert.match(String(recs[2].summary), /along 3 places/);
  });

  test("sketch: rebase replays onto a map with someone else's changes; ids shift, groups and points follow", async () => {
    const r = await h.ok("sketch", { action: "rebase", onto: { path: copies.routes } }, 240_000);
    assert.equal(r.completed, true, JSON.stringify(r.conflicts));
    assert.deepEqual(r.conflicts, []);
    assert.deepEqual(r.applied, [1, 2, 3, 4, 5, 6, 7, 8]);
    const idMap = r.idMap as Obj;
    const newRoute = idMap.route[String(sketchRoute)];
    assert.ok(newRoute !== undefined && newRoute !== sketchRoute, `the route id shifted: ${JSON.stringify(idMap)}`);
    assert.equal(idMap.routeGroup["route-tunnels"], "route-tunnels");
    const v = await ev(
      `const r = pack.routes.find(x => x.i === args.i);
       return { r, theirs: pack.routes.some(x => x.name === 'Theirs'), far: pack.burgs[args.far].name,
         order: [...document.querySelectorAll('#routes > g')].map(g => g.id), tunnels: !!document.getElementById('route-tunnels'),
         spare: document.getElementById('route-moved')?.getAttribute('stroke-width'),
         gone: !!document.getElementById('route-spare'),
         path: document.getElementById('route-moved')?.querySelector('#route' + args.i)?.id };`,
      { i: newRoute, far: pick.far.i }
    );
    assert.equal(v.theirs, true, "their route survives");
    assert.equal(v.far, "Elsewhere", "their rename survives");
    assert.equal(v.tunnels, false, "the group was removed by the sketch's last op");
    assert.deepEqual(v.order, ["roads", "trails", "searoutes", "route-moved"]);
    assert.equal(v.gone, false, "the rename replayed");
    assert.equal(v.r.group, "route-moved", "force moved the route to the renamed fallback group");
    assert.equal(v.r.points.length, 2, "the edited points replayed");
    assert.deepEqual(v.r.points[1], [300, 300, pick.far.cell], "the pinned cell replayed");
    assert.equal(v.r.points[0][2], pick.A.cell, "the burg place still resolves to its own cell");
    assert.equal(v.r.lock, true);
    assert.equal(v.r.name, "Sketch Tunnel");
    assert.equal(v.path, `route${newRoute}`);
    assert.equal(v.spare, "0.5");
  });

  test("sketch: a rebase onto a map that already has the group stops with a conflict", async () => {
    const r = await h.ok("sketch", { action: "rebase", onto: { path: copies.group } }, 240_000);
    assert.equal(r.completed, false);
    const c = (r.conflicts as Obj[])[0];
    assert.equal(c.seq, 2);
    assert.match(c.reason, /already exists/);
  });

  // ------------------------------------------------------------ pure helpers (node side)

  test("replay rewriting maps points, group and moveTo through the id map", () => {
    const rw = new Rewriter(
      { burg: { "754": 760 }, routeGroup: { "route-a": "route-b" }, route: { "578": 590 } },
      new Set(["burg:754", "routeGroup:route-a", "route:578"])
    );
    const add = rewriteResolved(
      "add",
      {
        type: "route",
        items: [
          {
            points: [{ entity: { type: "burg", ref: 754 } }, { x: 1, y: 2 }],
            noPathfind: true,
            group: "route-a",
            lock: true
          }
        ],
        created: [[{ type: "route", i: 600 }]]
      },
      rw
    );
    assert.deepEqual((add as any).items[0].points[0], { entity: { type: "burg", ref: 760 } });
    assert.equal((add as any).items[0].group, "route-b");
    const edit = rewriteResolved(
      "edit",
      {
        type: "route",
        ops: [
          {
            ref: 578,
            set: { points: [{ entity: { type: "burg", ref: 754 } }, { x: 3, y: 4 }], group: "route-a" },
            before: { group: "route-a" },
            after: { group: "route-a" }
          }
        ]
      },
      rw
    ) as EditResolved;
    assert.equal(edit.ops[0].ref, 590);
    assert.equal((edit.ops[0].set as Obj).group, "route-b");
    assert.equal((edit.ops[0].set as Obj).points[0].entity.ref, 760);
    assert.equal((edit.ops[0].after as Obj).group, "route-b");
    const rm = rewriteResolved(
      "edit",
      { type: "routeGroup", ops: [{ ref: "route-a", remove: true, force: true, moveTo: "route-a" }] },
      rw
    ) as EditResolved;
    assert.deepEqual([rm.ops[0].ref, rm.ops[0].moveTo], ["route-b", "route-b"]);
    const ord = rewriteResolved(
      "edit",
      { type: "routeGroup", ops: [{ ref: "roads", set: { after: "route-a" } }] },
      rw
    ) as EditResolved;
    assert.equal((ord.ops[0].set as Obj).after, "route-b");
    // the one-line summary of a freehand add no longer assumes `through`
    const sum = summarizeOp(
      "add",
      {
        type: "route",
        items: [
          {
            points: [
              { x: 1, y: 2 },
              { x: 3, y: 4 }
            ],
            noPathfind: true,
            name: "T"
          }
        ],
        created: [[{ type: "route", i: 9 }]]
      },
      { created: [{ i: 9, name: "T" }] }
    );
    assert.match(sum, /route "T" \(9\) along 2 places/);
  });

  test("sketch summaries and conflicts read well for the new ops", () => {
    const pts = summarizeOp(
      "edit",
      {
        type: "route",
        ops: [
          {
            ref: 5,
            name: "R",
            set: { points: [{ x: 1, y: 2 }] },
            before: { points: { n: 3, px: 100.5 } },
            after: { points: { n: 2, px: 80 } }
          }
        ]
      } as EditResolved,
      null
    );
    assert.match(pts, /points 3 -> 2 \(100.5 -> 80 px\)/);
    const noBefore = summarizeOp(
      "edit",
      {
        type: "route",
        ops: [
          {
            ref: 5,
            set: {
              points: [
                { x: 1, y: 2 },
                { x: 3, y: 4 }
              ]
            }
          }
        ]
      } as EditResolved,
      null
    );
    assert.match(noBefore, /points 2 places/);
    const rm = summarizeOp(
      "edit",
      {
        type: "routeGroup",
        ops: [{ ref: "route-a", name: "A", remove: true, force: true, moveTo: "roads", ident: { routes: 3 } }]
      } as EditResolved,
      null
    );
    assert.match(rm, /[Rr]emoved routeGroup "A" \(route-a\) \(3 routes moved to roads\)/);
    // draw-order anchors name neighbours: a group added next to this one is not a competing change
    const move = {
      type: "routeGroup",
      ops: [{ ref: "route-t", set: { before: "trails" }, before: { before: null }, after: { before: "trails" } }]
    } as EditResolved;
    assert.deepEqual(bothChanged(move, [{ index: 0, before: { before: "route-u" } }]), []);
    const style = {
      type: "routeGroup",
      ops: [{ ref: "route-t", set: { stroke: "#fff" }, before: { stroke: "#111" }, after: { stroke: "#fff" } }]
    } as EditResolved;
    assert.equal(bothChanged(style, [{ index: 0, before: { stroke: "#222" } }]).length, 1, "a style both changed is");
  });
});
