// Freehand routes and custom route groups (dx/routes): add route {points, noPathfind}, the
// routeGroup entity (add / edit / remove / find / inspect), edit route {points, group}, link
// handling, undo, save/load, regenerate, and sketch replay. Runs against tests/fixtures/demo.map
// with no live origin (helpers refuse activationlayer.org).
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import { type EditResolved, Rewriter, rewriteResolved, summarizeOp } from "../src/ops.ts";
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
    await bad({ id: "route-x", dash: "wavy" }, "BAD_ARGS", /dash/);
    await bad({ id: "route-x", width: 0 }, "BAD_ARGS", /width/);
    await bad({ id: "route-x", opacity: 2 }, "BAD_ARGS", /opacity/);
    await bad({ id: "route-x", linecap: "pointy" }, "BAD_ARGS", /linecap/);
    await bad({ id: "route-x", fill: "red" }, "BAD_FIELD", /no field 'fill'/);
    await bad({ id: "route-x", after: "roads", before: "trails" }, "BAD_ARGS", /after or before/);
    await bad({ id: "route-x", after: "route-missing" }, "NOT_FOUND", /route-missing/);
    const dup = await fail("add", { type: "routeGroup", items: [{ id: "route-x" }, { id: "route-x" }] });
    assert.match(dup.message, /already exists/);
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
      [{ id: "route-other" }, /no editable field 'id'/],
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
    const two = [
      { x: 100, y: 100 },
      { x: 200, y: 150 }
    ];
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

  test("a freehand route never steals a link another route holds, and removal leaves that link alone", async () => {
    const { road } = pick;
    assert.equal(await ev("pack.cells.routes[args.a][args.b]", road), road.i);
    const r = await h.ok("add", {
      type: "route",
      items: [{ points: [{ cell: road.a }, { cell: road.b }], noPathfind: true, group: "route-plain" }]
    });
    const row = created(r)[0];
    assert.equal(row.links, 0, "the only pair is held by the road");
    assert.equal(await ev("pack.cells.routes[args.a][args.b]", road), road.i);
    assert.deepEqual(await linksOf(row.i), []);
    await h.ok("edit", { type: "route", ops: [{ ref: row.i, remove: true }] });
    assert.equal(await ev("pack.cells.routes[args.a][args.b]", road), road.i, "the road keeps its link");
    await undo(2);
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
      [{ group: "route-nope" }, "BAD_ARGS", /unknown route group/]
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

  test("regenerate routes keeps locked freehand routes in their custom group and drops unlocked ones", async () => {
    await h.ok("add", {
      type: "route",
      items: [{ points: burgPts(), noPathfind: true, group: "route-plain", name: "Gone", lock: false }]
    });
    assert.ok(await routeNamed("Gone"));
    await h.ok("regenerate", { parts: ["routes"] }, 240_000);
    assert.equal(await routeNamed("Gone"), null, "an unlocked route is regenerated away");
    const kept = (await routeNamed("Short Tunnel")) as Obj;
    assert.ok(kept, "the locked freehand route survives");
    assert.equal(kept.group, "route-tunnels");
    assert.equal(kept.lock, true);
    const g = (await groupDom("route-tunnels")) as Obj;
    assert.ok(g.kids.includes(`route${kept.i}`), "and is drawn in its group");
    assert.equal(g.attrs.stroke, "#3d2b6b", "regenerating does not touch group styles");
    assert.equal((await linksOf(kept.i)).length, 2, "its links were rebuilt under the renumbered id");
    await undo(); // regenerate
    await undo(); // the "Gone" route
    assert.equal(((await routeNamed("Short Tunnel")) as Obj).i, tunnel);
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
            { x: pick.A.x + 40, y: pick.A.y + 20 },
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
      ops: [{ ref: sketchRoute, set: { points: [{ entity: { type: "burg", ref: pick.A.i } }, { x: 300, y: 300 }] } }]
    });
    await h.ok("edit", {
      type: "routeGroup",
      ops: [{ ref: "route-tunnels", set: { stroke: "#00aa00", after: "searoutes" } }]
    });
    await h.ok("add", { type: "routeGroup", items: [{ id: "route-spare", before: "route-tunnels" }] });
    await h.ok("edit", {
      type: "routeGroup",
      ops: [{ ref: "route-tunnels", remove: true, force: true, moveTo: "route-spare" }]
    });
    const st = await h.ok("sketch", { action: "status", full: true });
    assert.equal(st.blobOnly, false, JSON.stringify(st.blobOnlyReasons));
    const recs = st.records as Obj[];
    assert.deepEqual(
      recs.map(r => r.tool),
      ["display", "add", "add", "edit", "edit", "add", "edit"]
    );
    assert.ok(recs.every(r => r.replayable));
    const rr = recs[2].resolved;
    assert.equal(rr.items[0].noPathfind, true);
    assert.equal(rr.items[0].group, "route-tunnels");
    assert.equal(rr.items[0].lock, true);
    assert.deepEqual(rr.items[0].points[0], { entity: { type: "burg", ref: pick.A.i } });
    assert.equal(rr.items[0].points[1].x, pick.A.x + 40);
    assert.deepEqual(rr.created, [[{ type: "route", i: sketchRoute }]]);
    assert.deepEqual(recs[1].resolved.created, [[{ type: "routeGroup", i: "route-tunnels" }]]);
    assert.equal(recs[1].resolved.items[0].width, 1.2);
    assert.equal(recs[1].resolved.items[0].linecap, "butt", "defaults are recorded explicitly");
    assert.deepEqual(recs[3].resolved.ops[0].set.points[0], { entity: { type: "burg", ref: pick.A.i } });
    assert.equal(recs[6].resolved.ops[0].force, true);
    assert.equal(recs[6].resolved.ops[0].moveTo, "route-spare");
    assert.match(String(recs[2].summary), /Sketch Tunnel/);
    assert.match(String(recs[2].summary), /along 3 places/);
  });

  test("sketch: rebase replays onto a map with someone else's changes; ids shift, groups and points follow", async () => {
    const r = await h.ok("sketch", { action: "rebase", onto: { path: copies.routes } }, 240_000);
    assert.equal(r.completed, true, JSON.stringify(r.conflicts));
    assert.deepEqual(r.conflicts, []);
    assert.deepEqual(r.applied, [1, 2, 3, 4, 5, 6, 7]);
    const idMap = r.idMap as Obj;
    const newRoute = idMap.route[String(sketchRoute)];
    assert.ok(newRoute !== undefined && newRoute !== sketchRoute, `the route id shifted: ${JSON.stringify(idMap)}`);
    assert.equal(idMap.routeGroup["route-tunnels"], "route-tunnels");
    const v = await ev(
      `const r = pack.routes.find(x => x.i === args.i);
       return { r, theirs: pack.routes.some(x => x.name === 'Theirs'), far: pack.burgs[args.far].name,
         order: [...document.querySelectorAll('#routes > g')].map(g => g.id), tunnels: !!document.getElementById('route-tunnels'),
         spare: document.getElementById('route-spare')?.getAttribute('stroke-width'),
         path: document.getElementById('route-spare')?.querySelector('#route' + args.i)?.id };`,
      { i: newRoute, far: pick.far.i }
    );
    assert.equal(v.theirs, true, "their route survives");
    assert.equal(v.far, "Elsewhere", "their rename survives");
    assert.equal(v.tunnels, false, "the group was removed by the sketch's last op");
    assert.deepEqual(v.order, ["roads", "trails", "searoutes", "route-spare"]);
    assert.equal(v.r.group, "route-spare", "force moved the route to the fallback group");
    assert.equal(v.r.points.length, 2, "the edited points replayed");
    assert.deepEqual(v.r.points[1].slice(0, 2), [300, 300]);
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
});
