// apply's paint list and the territory parts of a spec: cell paints in order (later entries win
// their cells), check counts per entry, idempotent upserts, one undo entry, replayable
// paint_cells records with literal cells; the builder's selects (feature_polygon + buffer_px,
// selects, from paths, custom biomes); a burgs entry's state painted on its own cell; markers'
// places folded into the note; free-standing notes by entity:{id}; clear drops zone, culture and
// religion notes; paint_cells' exact polygon/circle buffer. Normalization runs without a browser.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { normalizeEntry, normalizePaint, normalizeSpec, shapeIndex, toPaintSelect } from "../src/apply-spec.ts";
import { alive, type Harness, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

const square = (x: number, y: number, r: number) => [
  [x - r, y - r],
  [x + r, y - r],
  [x + r, y + r],
  [x - r, y + r]
];

describe("apply paint: normalization (no browser)", () => {
  const root = {
    terrain: {
      features: [
        { id: "Floor", shape: { polygon: square(100, 100, 10) } },
        { id: "Hollow", shape: { circle: [300, 300, 20] } },
        {
          id: "Ridge",
          shape: {
            polyline: [
              [0, 0],
              [5, 5]
            ],
            width_px: 4
          }
        }
      ]
    },
    terrain_paint: {
      order: "prose",
      Hill: { select: { polygon: square(50, 50, 40), where: { land: true } } },
      Vale: { selects: [{ feature_polygon: "Floor", buffer_px: 15 }, { circle: [10, 10, 5] }] }
    },
    biomes_paint: [
      { biome: "Grassland", shape: { feature_polygon: "Floor" }, note: "comment" },
      {
        biome: "Glass desert",
        custom: true,
        base: "Hot desert",
        color: "#ecdcae",
        habitability: 4,
        shape: { feature_polygons: ["Floor", "Hollow"] },
        where: { hMax: 36 },
        except: { circle: [100, 100, 3] }
      }
    ],
    cultures: [{ name: "Hillfolk", territory: { rule: "prose", select: { polygon: square(0, 0, 5) } } }]
  };

  test("named shapes grow by buffer_px; selects and feature_polygons are unions; where and except stay outside", () => {
    const ix = shapeIndex(root);
    assert.deepEqual([...ix.keys()], ["Floor", "Hollow", "Ridge"]);
    const one = toPaintSelect({ feature_polygon: "Floor", buffer_px: 15 }, ix);
    assert.equal(one.buffer, 15);
    assert.deepEqual((one.polygon as Obj[])[0], { x: 90, y: 90 });
    // a circle grown by buffer px is the circle of radius r + buffer
    assert.deepEqual(toPaintSelect({ feature_polygon: "Hollow", buffer_px: 5 }, ix), {
      circle: { at: { x: 300, y: 300 }, radius: 25, unit: "px" }
    });
    const both = toPaintSelect(
      {
        polygon: [
          [0, 0],
          [9, 0],
          [9, 9]
        ],
        feature_polygons: ["Floor"],
        buffer_px: 15,
        where: { land: true }
      },
      ix
    );
    assert.equal((both.any as Obj[]).length, 2);
    assert.equal((both.any as Obj[])[0].buffer, undefined, "buffer_px grows the named shapes only");
    assert.equal((both.any as Obj[])[1].buffer, 15);
    assert.deepEqual(both.where, { land: true });
    const ex = toPaintSelect({ selects: [{ circle: [1, 2, 3] }], except: { circle: [1, 2, 1] } }, ix);
    assert.deepEqual(ex, {
      circle: { at: { x: 1, y: 2 }, radius: 3, unit: "px" },
      except: { circle: { at: { x: 1, y: 2 }, radius: 1, unit: "px" } }
    });
    assert.throws(() => toPaintSelect({ feature_polygon: "Flor" }, ix), /no shape named 'Flor'.*near: Floor/);
    assert.throws(() => toPaintSelect({ feature_polygon: "Ridge" }, ix), /polyline.*polygon or circle/);
  });

  test("entries: from paths (object, list, by name), flat keys, custom biomes, errors as entries", () => {
    const p = normalizePaint(
      [
        { from: "biomes_paint" },
        { from: "terrain_paint.Hill", set: { culture: "Hill", state: "Hill State" } },
        { from: "terrain_paint.Vale", culture: "Vale" },
        { from: "cultures.Hillfolk.territory", set: { culture: "Hillfolk" } },
        { select: { circle: [5, 5, 5] }, set: { height: { value: 30 } }, feather: { width: 3 } },
        { from: "terrain_paint.Nope", set: { culture: "X" } },
        { select: { feature_polygon: "Nope" }, set: { culture: "X" } },
        { select: { circle: [5, 5, 5] } }
      ],
      root,
      shapeIndex(root)
    );
    assert.deepEqual(
      p.entries.map(e => e.label),
      [
        "biomes_paint[0]",
        "biomes_paint[1]",
        "terrain_paint.Hill",
        "terrain_paint.Vale",
        "cultures.Hillfolk.territory",
        'height={"value":30}',
        "terrain_paint.Nope",
        "culture=X",
        "paint"
      ]
    );
    const [g, glass, hill, vale, folk, h, bad1, bad2, bad3] = p.entries;
    assert.deepEqual(g.set, { biome: "Grassland" });
    assert.equal(g.ignored, undefined, "note is a comment");
    assert.deepEqual(glass.set, { biome: "Glass desert" });
    assert.deepEqual(glass.select?.where, { hMax: 36 });
    assert.equal((glass.select?.any as Obj[]).length, 2);
    assert.ok(glass.select?.except, "the entry's except applies to the union");
    assert.deepEqual(hill.set, { culture: "Hill", state: "Hill State" });
    assert.deepEqual(hill.select?.where, { land: true });
    assert.deepEqual(vale.set, { culture: "Vale" });
    assert.equal((vale.select?.any as Obj[]).length, 2);
    assert.ok(folk.select?.polygon);
    assert.deepEqual(h.ignored, ["feather"]);
    assert.equal(bad1.error?.code, "NOT_FOUND");
    assert.match(String(bad1.error?.message), /nothing at 'terrain_paint\.Nope' \(keys: order, Hill, Vale\)/);
    assert.equal(bad2.error?.code, "NOT_FOUND");
    assert.match(String(bad3.error?.message), /sets one or more of state/);
    assert.deepEqual([...p.used].sort(), ["biomes_paint", "cultures", "terrain_paint"]);
    assert.deepEqual(p.biomes, [{ name: "Glass desert", base: "Hot desert", color: "#ecdcae", habitability: 4 }]);
  });

  test("normalizeSpec: paint stage before notes; used keys are not lists or skipped; custom biomes join biomes; territory notes", () => {
    const s = normalizeSpec(
      {
        ...root,
        notes: [{ id: "n", legend: "x" }],
        states: [{ name: "Hill State", territory: { rule: "Same as Hill" } }]
      },
      {
        paint: [{ from: "biomes_paint" }, { from: "terrain_paint.Hill", set: { culture: "Hill", state: "Hill State" } }]
      }
    );
    assert.deepEqual(
      s.lists.map(l => l.key),
      ["biomes", "cultures", "states", "paint", "notes"]
    );
    assert.deepEqual(s.skipped, ["terrain"], "terrain_paint and biomes_paint are read by the paint list");
    assert.deepEqual(s.lists[0].entries, [
      { name: "Glass desert", base: "Hot desert", color: "#ecdcae", habitability: 4 }
    ]);
    assert.deepEqual(s.lists[1].entries, [{ name: "Hillfolk" }], "territory never reaches the entity");
    assert.deepEqual(s.lists[2].entries, [{ name: "Hill State" }]);
    const t = s.notes.find(n => n.startsWith("territory not painted"));
    assert.ok(t, JSON.stringify(s.notes));
    assert.match(
      t,
      /cultures 'Hillfolk' \(has a select: paint \{from:'cultures\.Hillfolk\.territory', set:\{culture:'Hillfolk'\}\}\)/
    );
    assert.doesNotMatch(t, /Hill State/, "the paint list sets state 'Hill State'");
    // without a paint list: terrain_paint is skipped with a hint
    const bare = normalizeSpec({ terrain_paint: root.terrain_paint }, {});
    assert.deepEqual(bare.skipped, ["terrain_paint"]);
    assert.match(bare.notes.join(" "), /terrain_paint is not applied by itself: .*from:'terrain_paint/);
  });

  test("markers[].places join the note legend as the builder's translator wrote it (escaped)", () => {
    const m = normalizeEntry("marker", {
      name: "City places",
      x: 1,
      y: 2,
      note: "Places & things",
      places: [
        { name: "Court <main>", x: 1000, y: 1060, note: "Seat 'of' the Queen" },
        { name: "Barracks", x: 1004, y: 1060, note: "Templars" }
      ]
    });
    assert.equal(
      m.note,
      "Places &amp; things<br><b>Places:</b><ul><li><b>Court &lt;main&gt;</b> (1000,1060): Seat &#x27;of&#x27; the Queen</li><li><b>Barracks</b> (1004,1060): Templars</li></ul>"
    );
    assert.equal(m.places, undefined);
    const o = normalizeEntry("marker", { name: "M", note: { name: "N", legend: "L" }, places: [{ name: "P" }] });
    assert.deepEqual(o.note, { name: "N", legend: "L<br><b>Places:</b><ul><li><b>P</b></li></ul>" });
  });
});

/** Two live cultures, two states, a land centre with a 70 px land disc and a burg to paint around. */
const PICK = `
const C = pack.cells;
const cultures = pack.cultures.filter(c => c && c.i && !c.removed).slice(0, 2).map(c => c.name);
const states = pack.states.filter(s => s && s.i && !s.removed);
const ok = b => b && b.i && !b.removed && !b.capital && b.state > 0 && C.c[b.cell].every(k => C.h[k] >= 20);
let burg = null, other = null;
for (const b of pack.burgs.filter(ok)) {
  const disc = findAll(b.x, b.y, 40);
  if (disc.length < 8 || disc.some(c => C.h[c] < 20 || (C.burg[c] && pack.burgs[C.burg[c]].capital))) continue;
  if (disc.some(c => states.some(s => s.center === c))) continue;
  const o = states.find(s => s.i !== b.state);
  if (!o) continue;
  burg = b; other = o; break;
}
let at = null;
for (const c of C.i) {
  const [x, y] = C.p[c];
  if (x < 120 || y < 120 || x > graphWidth - 120 || y > graphHeight - 120) continue;
  const disc = findAll(x, y, 70);
  if (disc.length > 20 && disc.every(k => C.h[k] >= 20 && C.h[k] < 70)) { at = { x, y, cell: c }; break; }
}
return {
  cultures, at,
  burg: { i: burg.i, name: burg.name, x: burg.x, y: burg.y, cell: burg.cell, state: pack.states[burg.state].name },
  other: other.name,
  zone: pack.zones.find(z => z && !z.hidden && z.name)?.name ?? null
};`;

describe("tupaia-mcp apply paint", () => {
  let h: Harness;
  let pick: Obj;
  let out = "";

  const undoCount = async () => ((await h.ok("snapshot", { action: "list" })).undo as Obj[]).length;
  const rowAt = (r: Obj, at: string) => (r.rows as Obj[]).find(x => x.at === at) as Obj;
  const val = async (code: string, args: Obj = {}) => (await h.ok("eval", { readOnly: true, code, args })).value as Obj;

  /** An outer disc of culture A with an inner disc of culture B painted over it. */
  const discs = () => [
    {
      select: { circle: [pick.at.x, pick.at.y, 60], where: { land: true } },
      set: { culture: pick.cultures[0] }
    },
    {
      select: { circle: { at: { x: pick.at.x, y: pick.at.y }, radius: 25 } },
      culture: pick.cultures[1],
      note: "a comment"
    }
  ];

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "40" });
    out = fs.realpathSync(h.env.TUPAIA_OUT);
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    pick = (await h.ok("eval", { code: PICK, readOnly: true })).value as Obj;
    assert.ok(pick.at && pick.burg && pick.cultures.length === 2, JSON.stringify(pick));
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("check counts each entry's differing cells (later entries win theirs); upsert paints in one undo entry; again changes nothing", async () => {
    const before0 = await undoCount();
    const c = await h.ok("apply", { mode: "check", paint: discs() });
    assert.equal(c.changed, false);
    const r0 = rowAt(c, "paint[0]");
    const r1 = rowAt(c, "paint[1]");
    assert.equal(r1.status, "differs", JSON.stringify(c));
    const d0 = r0?.diffs?.[0] as Obj | undefined;
    const d1 = r1.diffs[0] as Obj;
    assert.equal(d1.field, "culture");
    assert.equal(d1.want, pick.cultures[1]);
    if (d0) assert.equal(d0.overridden, d1.cells, "the inner disc's cells belong to the later entry");
    assert.equal(await undoCount(), before0, "check takes no undo entry");

    const u = await h.ok("apply", { paint: discs() });
    assert.equal(u.changed, true);
    assert.equal(rowAt(u, "paint[1]").status, "updated");
    assert.equal(await undoCount(), before0 + 1);
    const v = await val(
      `const C = pack.cells, A = args.a, B = args.b;
       const name = c => pack.cultures[C.culture[c]].name;
       const inner = findAll(args.x, args.y, 25), outer = findAll(args.x, args.y, 60).filter(c => !inner.includes(c) && C.h[c] >= 20);
       return { inner: inner.filter(c => C.h[c] >= 20).every(c => name(c) === B), outer: outer.every(c => name(c) === A) };`,
      { a: pick.cultures[0], b: pick.cultures[1], x: pick.at.x, y: pick.at.y }
    );
    assert.deepEqual(v, { inner: true, outer: true });

    const again = await h.ok("apply", { paint: discs() });
    assert.equal(again.changed, false);
    assert.equal(again.note, "nothing to change");
    assert.deepEqual(again.counts, { unchanged: 2 });
    assert.equal(await undoCount(), before0 + 1, "a no-op apply takes no undo entry");
    const ck = await h.ok("apply", { mode: "check", paint: discs() });
    assert.deepEqual(ck.counts, { unchanged: 2 });
    await h.ok("snapshot", { action: "undo" });
  });

  test("a burgs entry's state is painted on its own cell, after (and over) the paint list; converges", async () => {
    const spec = {
      paint: [{ select: { circle: [pick.burg.x, pick.burg.y, 40] }, set: { state: pick.other } }],
      burgs: [{ name: pick.burg.name, state: pick.burg.state }]
    };
    const c = await h.ok("apply", { ...spec, mode: "check" });
    assert.equal(rowAt(c, "paint[0]").status, "differs", JSON.stringify(c));
    const u = await h.ok("apply", spec);
    assert.equal(u.changed, true);
    const v = await val(
      `const C = pack.cells;
       const ring = findAll(args.x, args.y, 40).filter(c => c !== args.cell);
       return { burg: pack.states[C.state[args.cell]].name, burgEntity: pack.states[pack.burgs[args.i].state].name,
                ring: [...new Set(ring.map(c => pack.states[C.state[c]].name))] };`,
      { x: pick.burg.x, y: pick.burg.y, cell: pick.burg.cell, i: pick.burg.i }
    );
    assert.equal(v.burg, pick.burg.state, "the burg's cell keeps its listed state");
    assert.equal(v.burgEntity, pick.burg.state);
    assert.deepEqual(v.ring, [pick.other]);
    const ck = await h.ok("apply", { ...spec, mode: "check" });
    assert.deepEqual(ck.counts, { unchanged: 2 }, JSON.stringify(ck.rows));
    const again = await h.ok("apply", spec);
    assert.equal(again.changed, false, JSON.stringify(again.rows));
    await h.ok("snapshot", { action: "undo" });
    // an existing burg in another state: check shows a plain difference, upsert paints its cell
    const moved = await h.ok("apply", { mode: "check", burgs: [{ name: pick.burg.name, state: pick.other }] });
    const d = (rowAt(moved, "burgs[0]").diffs as Obj[]).find(x => x.field === "state") as Obj;
    assert.equal(d.via, "cell");
    const m2 = await h.ok("apply", { burgs: [{ name: pick.burg.name, state: pick.other }] });
    assert.equal(rowAt(m2, "burgs[0]").status, "updated", JSON.stringify(m2));
    assert.equal(
      (await val(`return pack.states[pack.cells.state[args.cell]].name`, { cell: pick.burg.cell })) as unknown,
      pick.other
    );
    await h.ok("snapshot", { action: "undo" });
  });

  test("pending targets, height {value}, refused keys and bad selects are rows; created cultures are painted in the same call", async () => {
    const spec = {
      cultures: [{ name: "Paintfolk", at: [pick.at.x, pick.at.y], color: "#123456", type: "Generic", base: "English" }],
      paint: [
        { select: { circle: [pick.at.x, pick.at.y, 30] }, set: { culture: "Paintfolk" } },
        { select: { circle: [pick.at.x, pick.at.y, 10] }, set: { height: 60 } },
        { select: { circle: [pick.at.x, pick.at.y, 10] }, set: { height: { delta: 2 } } },
        { select: { circle: [pick.at.x, pick.at.y, 10] }, set: { zone: "x" } },
        { select: { circle: [pick.at.x, pick.at.y, 10], wher: { land: true } }, set: { culture: "Paintfolk" } }
      ]
    };
    const c = await h.ok("apply", { ...spec, mode: "check" });
    const p0 = rowAt(c, "paint[0]");
    assert.equal(p0.status, "differs");
    assert.match(String(p0.diffs[0].pending), /culture 'Paintfolk' is created by this spec/);
    assert.equal(rowAt(c, "paint[2]").error.code, "BAD_ARGS");
    assert.match(rowAt(c, "paint[2]").error.message, /height \{value\}/);
    assert.equal(rowAt(c, "paint[3]").error.code, "BAD_FIELD");
    assert.equal(rowAt(c, "paint[4]").error.code, "BAD_FIELD", "the page refuses unknown select keys");
    const u = await h.ok("apply", spec);
    assert.equal(rowAt(u, "paint[0]").status, "updated", JSON.stringify(u.rows));
    const v = await val(
      `const C = pack.cells; const id = pack.cultures.find(c => c.name === "Paintfolk" && !c.removed).i;
       const disc = findAll(args.x, args.y, 30).filter(c => C.h[c] >= 20);
       return { all: disc.every(c => C.culture[c] === id), h: findAll(args.x, args.y, 10).map(c => C.h[c]) };`,
      { x: pick.at.x, y: pick.at.y }
    );
    assert.equal(v.all, true);
    assert.ok(
      (v.h as number[]).every(x => x === 60),
      JSON.stringify(v.h)
    );
    const ck = await h.ok("apply", { ...spec, mode: "check" });
    assert.deepEqual(ck.counts, { unchanged: 3, error: 3 }, JSON.stringify(ck.rows));
    await h.ok("snapshot", { action: "undo" });
  });

  test("a height entry after a biome entry on the same cells keeps the painted biome (local keep re-derives the rest); converges", async () => {
    const disc = { circle: [pick.at.x, pick.at.y, 14], where: { land: true } };
    const ring = {
      circle: [pick.at.x, pick.at.y, 22],
      where: { land: true },
      except: { circle: [pick.at.x, pick.at.y, 14] }
    };
    const spec = {
      paint: [
        { select: disc, set: { biome: "Wetland" } },
        { select: { any: [disc, ring] }, set: { height: 72 } }
      ]
    };
    const u = await h.ok("apply", spec);
    assert.equal(u.changed, true, JSON.stringify(u.rows));
    const v = await val(
      `const C = pack.cells, wet = biomesData.name.indexOf("Wetland");
       const inner = findAll(args.x, args.y, 14).filter(c => C.h[c] >= 20);
       return { n: inner.length, wet: inner.every(c => C.biome[c] === wet), h: inner.every(c => C.h[c] === 72) };`,
      { x: pick.at.x, y: pick.at.y }
    );
    assert.ok(v.n > 0 && v.wet && v.h, JSON.stringify(v));
    const ck = await h.ok("apply", { ...spec, mode: "check" });
    assert.deepEqual(ck.counts, { unchanged: 2 }, JSON.stringify(ck.rows));
    await h.ok("snapshot", { action: "undo" });
  });

  test("sketch: the paint list logs replayable paint_cells records with literal cells; a rebase replays them", async () => {
    const base = (await h.ok("save_map", { path: "paint-base.map", overwrite: true })).path as string;
    await h.ok("sketch", { action: "start", slug: "t-paint" });
    const r = await h.ok("apply", { paint: discs() });
    assert.equal(r.changed, true);
    const st = await h.ok("sketch", { action: "status" });
    const log = st.log as Obj[];
    assert.ok(log.length >= 1 && log.every(o => o.tool === "paint_cells"), JSON.stringify(log));
    assert.ok(log.every(o => /^apply \d+\/\d+: /.test(o.summary)));
    assert.equal(st.blobOnly, false);
    const rb = await h.ok("sketch", { action: "rebase", onto: { path: base } }, 240_000);
    assert.equal(rb.completed, true, JSON.stringify(rb.conflicts));
    const ck = await h.ok("apply", { mode: "check", paint: discs() });
    assert.deepEqual(ck.counts, { unchanged: 2 }, JSON.stringify(ck.rows));
    await h.ok("sketch", { action: "discard", confirm: true }).catch(() => h.ok("sketch", { action: "stop" }));
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
  });

  test("specPath: from paths and named shapes read the spec file; custom biomes are created and painted", async () => {
    const file = path.join(out, "paint-spec.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        terrain: { features: [{ id: "Disc", shape: { circle: [pick.at.x, pick.at.y, 20] } }] },
        biomes_paint: [
          {
            biome: "Specglass",
            custom: true,
            base: "Hot desert",
            color: "#ecdcae",
            habitability: 4,
            shape: { feature_polygon: "Disc" },
            note: "for the look"
          }
        ]
      })
    );
    const r = await h.ok("apply", { specPath: file, paint: [{ from: "biomes_paint" }] });
    assert.equal(r.changed, true);
    assert.deepEqual(r.created, { biomes: { Specglass: (r.created as Obj).biomes.Specglass } });
    assert.equal(rowAt(r, "paint[0]").status, "updated");
    assert.deepEqual(r.skipped, ["terrain"], "biomes_paint is read by the paint list");
    const v = await val(
      `const id = biomesData.name.indexOf("Specglass");
       return findAll(args.x, args.y, 20).filter(c => pack.cells.h[c] >= 20).every(c => pack.cells.biome[c] === id);`,
      { x: pick.at.x, y: pick.at.y }
    );
    assert.equal(v, true);
    const ck = await h.ok("apply", { specPath: file, paint: [{ from: "biomes_paint" }], mode: "check" });
    assert.deepEqual(ck.counts, { unchanged: 2 }, JSON.stringify(ck.rows));
    await h.ok("snapshot", { action: "undo" });
  });

  test("paint_cells buffer grows a polygon by the full distance, also one holding a single cell", async () => {
    const poly = square(pick.at.x, pick.at.y, 3).map(([x, y]) => ({ x, y }));
    const v = await val(
      `const M = globalThis.__tupaia.mutations; const C = pack.cells;
       const P = args.poly.map(p => [p.x, p.y]);
       const seg = (p, a, b) => { const dx = b[0]-a[0], dy = b[1]-a[1], L = dx*dx+dy*dy; const t = Math.max(0, Math.min(1, ((p[0]-a[0])*dx+(p[1]-a[1])*dy)/L)); return Math.hypot(p[0]-(a[0]+t*dx), p[1]-(a[1]+t*dy)); };
       const dist = p => Math.min(...P.map((a, k) => seg(p, a, P[(k+1) % P.length])));
       const want = [...C.i].filter(c => d3.polygonContains(P, C.p[c]) || dist(C.p[c]) <= 25);
       const got = M.selectCells({ polygon: args.poly, buffer: 25 });
       const circle = M.selectCells({ circle: { at: { x: args.x, y: args.y }, radius: 10 }, buffer: 15 });
       const wide = M.selectCells({ circle: { at: { x: args.x, y: args.y }, radius: 25 } });
       return { want: want.length, got: got.length, same: want.every(c => got.includes(c)), circle: circle.length, wide: wide.length };`,
      { poly, x: pick.at.x, y: pick.at.y }
    );
    assert.ok((v.want as number) > 3, JSON.stringify(v));
    assert.equal(v.got, v.want);
    assert.equal(v.same, true);
    assert.equal(v.circle, v.wide, "a circle grown by 15 px is the circle of radius r + 15");
  });

  test("notes: entity:{id, name} makes a free-standing note; a label note by its text with '|' breaks", async () => {
    const lbl = "Paint|Label";
    const r = await h.ok("apply", {
      labels: [{ text: lbl, x: pick.at.x, y: pick.at.y }],
      notes: [
        { entity: { id: "mapNoteX", name: "The Whole Map" }, legend: "map legend" },
        { entity: { type: "label", name: lbl }, legend: "label legend" }
      ]
    });
    assert.equal(r.changed, true, JSON.stringify(r.rows));
    const v = await val(
      `const l = [...document.querySelectorAll("#labels text")].find(t => t.textContent.replace(/\\s/g, "") === "PaintLabel");
       return { map: notes.find(n => n.id === "mapNoteX"), label: l ? notes.find(n => n.id === l.id)?.legend ?? null : "no label" };`
    );
    assert.deepEqual(v.map, { id: "mapNoteX", name: "The Whole Map", legend: "map legend" });
    assert.equal(v.label, "label legend");
    await h.ok("snapshot", { action: "undo" });
  });

  test("clear drops the notes of the zones, cultures and religions it removes (and the dry run counts them)", async () => {
    const ids = await val(
      `const z = pack.zones.find(z => z && !z.hidden), c = pack.cultures.find(c => c && c.i && !c.removed), r = pack.religions.find(r => r && r.i && !r.removed);
       for (const id of ["zone" + z.i, "culture" + c.i, "religion" + r.i]) if (!notes.some(n => n.id === id)) notes.push({ id, name: id, legend: "x" });
       return { zone: z.i, culture: c.i, religion: r.i };`
    );
    const sel = {
      types: ["zones", "cultures", "religions"],
      where: { zones: { i: [ids.zone] }, cultures: { i: [ids.culture] }, religions: { i: [ids.religion] } },
      force: true
    };
    const dry = await h.ok("clear", { ...sel, dryRun: true });
    assert.match(JSON.stringify(dry), /"notesDropped":[3-9]/, JSON.stringify(dry));
    const z = await h.ok("clear", sel);
    assert.ok((z.cascade as Obj)?.notesDropped >= 3, JSON.stringify(z));
    const left = await val(
      `return ["zone" + args.z, "culture" + args.c, "religion" + args.r].filter(id => notes.some(n => n.id === id))`,
      {
        z: ids.zone,
        c: ids.culture,
        r: ids.religion
      }
    );
    assert.deepEqual(left, []);
    await h.ok("snapshot", { action: "undo", n: 2 });
  });
});
