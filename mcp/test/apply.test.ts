// apply: one call that checks or brings the map in line with a spec (lists of entities keyed
// by name). Normalization runs without a browser; the rest against tests/fixtures/demo.map,
// including the sketch log (one undo entry, several replayable records) and a rebase replay.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { mapEntry, normalizeEntry, normalizeSpec, typeOfList } from "../src/apply-spec.ts";
import { shapeResult } from "../src/tools/apply.ts";
import { alive, errorBody, type Harness, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

describe("apply: spec normalization (no browser)", () => {
  test("the builder's shapes are accepted directly", () => {
    assert.deepEqual(normalizeEntry("burg", { name: "A", x: 10, y: 20, population: 5 }), {
      name: "A",
      population: 5,
      at: { x: 10, y: 20 }
    });
    assert.deepEqual(normalizeEntry("culture", { name: "C", at: [1, 2], namesbase: "English" }), {
      name: "C",
      at: { x: 1, y: 2 },
      base: "English"
    });
    const pf = normalizeEntry("route", { name: "R", draw: "pathfind", through: ["Ballantine", [997, 1020]] });
    assert.deepEqual(pf, {
      name: "R",
      through: [{ entity: { type: "burg", ref: "Ballantine" } }, { x: 997, y: 1020 }]
    });
    const pts = normalizeEntry("route", { name: "P", draw: "points", through: ["Ballantine", [1072, 985]] });
    assert.deepEqual(pts, {
      name: "P",
      points: [{ entity: { type: "burg", ref: "Ballantine" } }, { x: 1072, y: 985 }],
      noPathfind: true
    });
    const z = normalizeEntry("zone", {
      name: "Z",
      shape: {
        polygon: [
          [0, 0],
          [10, 0],
          [10, 10]
        ],
        circle: [5, 5, 30],
        where: { land: true }
      }
    });
    assert.deepEqual(z, {
      name: "Z",
      select: {
        polygon: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 }
        ],
        circle: { at: { x: 5, y: 5 }, radius: 30, unit: "px" },
        where: { land: true }
      }
    });
    assert.equal(typeOfList("burgs"), "burg");
    assert.equal(typeOfList("routeGroups"), "routeGroup");
    assert.equal(typeOfList("widgets"), "widget");
  });

  test("mapping renames lists and keys, maps values, then normalizes; nested provinces flatten", () => {
    assert.deepEqual(
      mapEntry(
        { type: "tunnel town", note: "x", name: "T" },
        { type: "group", note: null },
        {
          group: { "tunnel town": "town", "capital city": null }
        }
      ),
      { name: "T", group: "town" }
    );
    assert.deepEqual(mapEntry({ group: "peaks" }, undefined, { group: "lbl_{}" }), { group: "lbl_peaks" });
    assert.deepEqual(
      mapEntry({ type: "capital city", group: "x" }, { type: "group" }, { group: { "capital city": null } }),
      {}
    );
    const s = normalizeSpec(
      {
        seed: 194,
        pipeline: ["prose"],
        rivers_intended: [{ name: "R1", from: [1, 2] }],
        states: [{ name: "S", capital: "B", provinces: [{ name: "P1", capital: "B" }] }],
        labels: [{ text: "L", x: 1, y: 2, group: "peaks" }]
      },
      { burgs: [{ name: "B", x: 5, y: 6, type: "village" }] },
      {
        lists: { rivers_intended: "rivers" },
        keys: { burgs: { type: "group" } },
        values: { labels: { group: "lbl_{}" } }
      }
    );
    assert.deepEqual(
      s.lists.map(l => `${l.key}:${l.type}:${l.entries.length}`),
      ["burgs:burg:1", "states:state:1", "provinces:province:1", "rivers:river:1", "labels:label:1"],
      "lists come in stage order"
    );
    assert.deepEqual(s.lists[0].entries[0], { name: "B", group: "village", at: { x: 5, y: 6 } });
    assert.deepEqual(s.lists[1].entries[0], { name: "S", capital: "B" });
    assert.deepEqual(s.lists[4].entries[0], { text: "L", group: "lbl_peaks", at: { x: 1, y: 2 } });
    assert.deepEqual(s.skipped.sort(), ["pipeline", "seed"]);
    const only = normalizeSpec(null, { burgs: [{ name: "B" }], labels: [{ text: "L" }] }, {}, ["labels"]);
    assert.deepEqual(
      only.lists.map(l => l.key),
      ["labels"]
    );
  });

  test("value-table defaults, ignore, only by the name before a rename, the nested-provinces note only in scope", () => {
    const groups = { roads: "roads", "Oom flyways": "route-oom_flyways", "*": "route-{}" };
    assert.deepEqual(mapEntry({ group: "roads" }, undefined, { group: groups }), { group: "roads" });
    assert.deepEqual(mapEntry({ group: "Oom flyways" }, undefined, { group: groups }), {
      group: "route-oom_flyways"
    });
    assert.deepEqual(mapEntry({ group: "journeys" }, undefined, { group: groups }), { group: "route-journeys" });
    assert.deepEqual(mapEntry({ group: "x" }, undefined, { group: { "*": null } }), {});
    const spec = {
      frame: { name: "W", lock: ["winds"] },
      rivers_intended: [{ name: "R" }],
      states: [{ name: "S", form: "Monarchy (prose)", provinces: [{ name: "P" }] }],
      burgs: [{ name: "B", note: "n", population: 3 }]
    };
    const m = { lists: { frame: "map", rivers_intended: "rivers" } };
    const a = normalizeSpec(spec, {}, m, ["frame", "rivers_intended"], { map: ["lock"], "*": ["note"] });
    assert.deepEqual(a.map, { name: "W" });
    assert.deepEqual(
      a.lists.map(l => l.key),
      ["rivers"]
    );
    assert.deepEqual(a.notes, [], "provinces are not in scope");
    assert.deepEqual(a.present.sort(), ["burgs", "map", "provinces", "rivers", "states"]);
    const b = normalizeSpec(spec, {}, m, undefined, { "*": ["note"], states: ["form"] });
    assert.deepEqual(b.lists.find(l => l.key === "burgs")?.entries, [{ name: "B", population: 3 }]);
    assert.deepEqual(b.lists.find(l => l.key === "states")?.entries, [{ name: "S" }]);
    assert.equal(b.notes.length, 1);
  });

  test("result shape: actionable rows first, identical errors grouped, plain creates as ids", () => {
    const err = { code: "NOT_FOUND", message: "apply cannot create provinces" };
    const rows = [
      { at: "burgs[0]", key: "A", i: 7, status: "created" },
      { at: "burgs[1]", key: "B", i: 8, status: "created", diffs: [{ field: "capital" }] },
      { at: "burgs[2]", key: "C", i: 9, status: "unchanged" },
      { at: "burgs[0].note", key: "burg7", i: "burg7", name: "A", status: "created" },
      { at: "provinces[0]", key: "P1", status: "error", error: err },
      { at: "provinces[1]", key: "P2", status: "error", error: err },
      { at: "provinces[2]", key: "P3", status: "error", error: err },
      { at: "provinces[3]", key: "P4", status: "error", error: err },
      { at: "states[0]", key: "S", i: 2, status: "differs", diffs: [{ field: "form" }] },
      { at: "routes[0]", key: "R", status: "error", error: { code: "BAD_ARGS", message: "other" } }
    ];
    const res = { rows, ignored: {}, unsupported: [], steps: [], also: {}, notes: [], wouldChange: 0 };
    const out = shapeResult(res, { mode: "upsert" }) as Record<string, any>;
    assert.deepEqual(out.counts, { created: 3, unchanged: 1, differs: 1, error: 5 });
    assert.deepEqual(out.created, { burgs: { A: 7 }, "burgs.note": { A: "burg7" } });
    assert.deepEqual(
      out.rows.map((r: Obj) => r.at),
      [["provinces[0]", "provinces[1]", "provinces[2]"], "routes[0]", "states[0]", "burgs[1]"]
    );
    assert.deepEqual(out.rows[0], {
      status: "error",
      count: 4,
      at: ["provinces[0]", "provinces[1]", "provinces[2]"],
      keys: ["P1", "P2", "P3"],
      more: 1,
      error: err
    });
    const v = shapeResult(res, { mode: "upsert", verbose: true }) as Record<string, any>;
    assert.equal(v.rows.length, rows.length, "verbose: every row, ungrouped");
    assert.equal(v.created, undefined);
  });
});

const PICK_CODE = `
const C = pack.cells;
const cnt = new Map();
for (const b of pack.burgs) if (b?.i && !b.removed) cnt.set(b.name, (cnt.get(b.name) || 0) + 1);
const ok = b => b && b.i && !b.removed && !b.capital && cnt.get(b.name) === 1 && b.state > 0 && !(pack.markets || []).some(m => m.centerBurgId === b.i);
const bs = pack.burgs.filter(ok);
const free = c => C.h[c] >= 20 && !C.burg[c] && C.c[c].every(k => !C.burg[k]);
const near = (c, x, y, lo, hi) => { const d = Math.hypot(C.p[c][0] - x, C.p[c][1] - y); return d > lo && d < hi; };
let B = null, a = null, b2 = null, extra = [];
for (const cand of bs.slice(5)) {
  const land = [...C.i].filter(c => free(c) && C.f[c] === C.f[cand.cell] && C.p[c][1] > 40 && C.p[c][1] < graphHeight - 40);
  a = land.find(c => near(c, cand.x, cand.y, 60, 150));
  if (a === undefined) continue;
  b2 = land.find(c => c !== a && near(c, C.p[a][0], C.p[a][1], 40, 120) && C.c[c].every(k => k !== a));
  if (b2 === undefined) continue;
  // nine more free cells, apart from each other and from a and b2 (later burgs go there)
  const used = [a, b2];
  extra = [];
  for (const c of land) {
    if (extra.length === 9) break;
    if (used.some(u => near(c, C.p[u][0], C.p[u][1], -1, 40))) continue;
    extra.push(c);
    used.push(c);
  }
  if (extra.length === 9) { B = cand; break; }
}
const xy = c => ({ x: C.p[c][0], y: C.p[c][1] });
const people = b => Math.round(b.population * populationRate * urbanization);
const st = pack.states[B.state];
const m = pack.markers.find(x => notes.some(n => n.id === "marker" + x.i));
const mn = notes.find(n => n.id === "marker" + m.i);
const other = pack.burgs.find(x => ok(x) && x.i !== B.i && x.state !== B.state);
return {
  B: { i: B.i, name: B.name, x: B.x, y: B.y, pop: people(B), culture: pack.cultures[B.culture].name, state: st.name },
  O: { i: other.i, name: other.name, x: other.x, y: other.y },
  n1: xy(a),
  n2: xy(b2),
  x: extra.map(xy),
  S: { i: st.i, name: st.name, color: st.color },
  M: { i: m.i, name: mn.name, legend: mn.legend, x: m.x, y: m.y }
};`;

describe("tupaia-mcp apply", () => {
  let h: Harness;
  let pick: Obj;
  let out = "";

  const undoCount = async () => ((await h.ok("snapshot", { action: "list" })).undo as Obj[]).length;
  const rowAt = (r: Obj, at: string) => (r.rows as Obj[]).find(x => x.at === at) as Obj;

  /** The spec most tests use: two new burgs, a road between them by name, notes, a state. */
  const spec = () => ({
    burgs: [
      { name: "Applyton", x: pick.n1.x, y: pick.n1.y, population: 1234, note: "First <b>new</b> burg", lock: true },
      { name: "Specburg", x: pick.n2.x, y: pick.n2.y, population: 777 },
      { name: pick.B.name, population: pick.B.pop + 50 }
    ],
    routes: [
      { name: "Spec Road", group: "roads", draw: "pathfind", through: ["Applyton", "Specburg"], note: "Road note" }
    ],
    markers: [
      {
        name: "Spec Tower",
        x: pick.n1.x + 5,
        y: pick.n1.y + 5,
        type: "watchtowers",
        icon: "🗼",
        size: 30,
        note: "Tall"
      }
    ],
    labels: [{ text: "Spec|Lands", x: pick.n1.x, y: pick.n1.y - 30, group: "lbl_regions" }],
    zones: [{ name: "Spec Zone", type: "raid", color: "#A83A32", shape: { circle: [pick.n2.x, pick.n2.y, 30] } }],
    states: [{ name: "Testland", capital: "Specburg", color: "#123abc", lock: true, note: "A state" }],
    notes: [{ entity: { type: "state", name: pick.S.name }, legend: "Spec note for the state" }]
  });

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "40" });
    out = fs.realpathSync(h.env.TUPAIA_OUT);
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    pick = (await h.ok("eval", { code: PICK_CODE, readOnly: true })).value as Obj;
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("check: unchanged, differs (with have/want), missing; nothing changes", async () => {
    const before = await undoCount();
    const r = await h.ok("apply", {
      mode: "check",
      burgs: [
        { name: pick.B.name, population: pick.B.pop, culture: pick.B.culture, state: pick.B.state },
        { name: pick.O.name.toUpperCase(), population: 5, x: pick.O.x + 0.5, y: pick.O.y, state: pick.S.name },
        { name: "Zzyzx Nowhere", x: pick.n1.x, y: pick.n1.y },
        { name: "Zzyzx Water", x: 1, y: 1 }
      ],
      states: [{ name: pick.S.name, color: pick.S.color.toUpperCase(), territory: "prose" }],
      markers: [{ name: pick.M.name, note: `${pick.M.legend} (edited)` }]
    });
    assert.equal(r.changed, false);
    assert.deepEqual(r.counts, { unchanged: 2, differs: 2, missing: 1, error: 1 });
    const o = rowAt(r, "burgs[1]");
    assert.equal(o.i, pick.O.i, "case-folded name match");
    assert.equal(o.status, "differs");
    const fields = (o.diffs as Obj[]).map(d => d.field);
    // the name differs only in case (a rename), population differs, x is within 1 px, state is read-only
    assert.deepEqual(fields.sort(), ["name", "population", "state"]);
    const st = (o.diffs as Obj[]).find(d => d.field === "state") as Obj;
    assert.equal(st.readOnly, true);
    assert.equal(st.fix, "paint_cells");
    const m = rowAt(r, "markers[0]");
    assert.equal(m.diffs[0].field, "note.legend");
    assert.match(String(m.diffs[0].want), /\(edited\)$/, JSON.stringify(m.diffs[0]));
    if (pick.M.legend.length > 80)
      assert.equal(m.diffs[0].at, pick.M.legend.length, "long text: shown around the first difference");
    assert.equal(rowAt(r, "burgs[2]").status, "missing");
    const wet = rowAt(r, "burgs[3]");
    assert.equal(wet.status, "error", "check says what upsert would: this create cannot work");
    assert.match(wet.error.message, /^missing; creating it would fail: .*water/, JSON.stringify(wet));
    assert.equal((r.rows as Obj[])[0].at, "burgs[3]", "errors come first");
    assert.equal(rowAt(r, "burgs[0]"), undefined, "unchanged rows are left out");
    assert.deepEqual(r.ignored, { states: ["territory"] });
    assert.equal(await undoCount(), before, "check takes no undo entry");
    const v = await h.ok("apply", { mode: "check", verbose: true, burgs: [{ name: pick.B.name }] });
    assert.equal((v.rows as Obj[]).length, 1, "verbose lists unchanged rows");
  });

  test("upsert creates and updates in one undo entry; applying again changes nothing", async () => {
    const before = await undoCount();
    const r = await h.ok("apply", { ...spec(), verbose: true });
    assert.equal(r.changed, true);
    assert.deepEqual(r.counts, { created: 11, updated: 1 }, JSON.stringify(r.rows));
    assert.equal(await undoCount(), before + 1, "one auto-undo entry for the whole call");
    const ids = Object.fromEntries((r.rows as Obj[]).map(x => [x.at, x.i]));
    const v = (
      await h.ok("eval", {
        readOnly: true,
        args: { ids },
        code: `
          const I = args.ids;
          const b1 = pack.burgs[I["burgs[0]"]], b2 = pack.burgs[I["burgs[1]"]];
          const route = pack.routes.find(x => x.i === I["routes[0]"]);
          const ends = [route.points[0][2], route.points[route.points.length - 1][2]].map(c => pack.cells.burg[c]);
          const s = pack.states[I["states[0]"]];
          return {
            b1: [b1.name, Math.round(b1.population * populationRate * urbanization), !!b1.lock],
            ends,
            state: [s.name, s.color, pack.burgs[s.capital].name, !!s.lock],
            notes: ["burg" + b1.i, "stateLabel" + s.i, "route" + route.i, "stateLabel${pick.S.i}"].map(id => notes.find(n => n.id === id)?.legend ?? null),
            label: document.getElementById(I["labels[0]"])?.parentNode.id,
            zone: pack.zones.find(z => z.i === I["zones[0]"]).cells.length
          };`
      })
    ).value as Obj;
    assert.deepEqual(v.b1, ["Applyton", 1234, true]);
    assert.deepEqual(v.ends.sort(), [ids["burgs[0]"], ids["burgs[1]"]].sort(), "the road runs between the new burgs");
    assert.deepEqual(v.state, ["Testland", "#123abc", "Specburg", true]);
    assert.deepEqual(v.notes, ["First <b>new</b> burg", "A state", "Road note", "Spec note for the state"]);
    assert.equal(v.label, "lbl_regions");
    assert.ok(v.zone > 0);

    const again = await h.ok("apply", spec());
    assert.equal(again.changed, false);
    assert.equal(again.note, "nothing to change");
    assert.deepEqual(again.counts, { unchanged: 12 });
    assert.deepEqual(again.rows, []);
    assert.equal(await undoCount(), before + 1, "a no-op apply takes no undo entry");
  });

  test("update: changes differing fields (zone cells, label move, legend), never creates", async () => {
    const r = await h.ok("apply", {
      mode: "update",
      zones: [{ name: "Spec Zone", select: { circle: { at: pick.n2, radius: 45 } } }],
      labels: [{ text: "Spec|Lands", x: pick.n1.x + 12, y: pick.n1.y - 30 }],
      markers: [{ name: "Spec Tower", note: "Taller" }],
      burgs: [{ name: "Nowhere Else", x: pick.n1.x, y: pick.n1.y }]
    });
    assert.deepEqual(r.counts, { updated: 3, missing: 1 }, JSON.stringify(r.rows));
    const z = rowAt(r, "zones[0]").diffs[0];
    assert.equal(z.field, "cells");
    assert.ok(z.add > 0 && z.remove === 0, JSON.stringify(z));
    const l = rowAt(r, "labels[0]").diffs[0];
    assert.equal(l.field, "move");
    assert.ok(Math.abs(l.px - 12) < 0.5, JSON.stringify(l));
    const chk = await h.ok("apply", {
      mode: "check",
      zones: [{ name: "Spec Zone", select: { circle: { at: pick.n2, radius: 45 } } }],
      labels: [{ text: "Spec|Lands", x: pick.n1.x + 12, y: pick.n1.y - 30 }],
      markers: [{ name: "Spec Tower", note: "Taller" }]
    });
    assert.deepEqual(chk.counts, { unchanged: 3 });
  });

  test("errors: AMBIGUOUS with candidates, explicit refs, a note given twice, a label group id the map uses", async () => {
    await h.ok("add", {
      type: "burg",
      items: [
        { at: pick.x[2], name: "Twinford" },
        { at: pick.x[3], name: "Twinford" }
      ]
    });
    const r = await h.ok("apply", {
      mode: "check",
      burgs: [{ name: "Twinford" }, { ref: pick.O.i, name: pick.O.name }]
    });
    const amb = rowAt(r, "burgs[0]");
    assert.equal(amb.status, "error");
    assert.equal(amb.error.code, "AMBIGUOUS");
    assert.equal(amb.error.candidates.length, 2);
    assert.equal(rowAt(r, "burgs[1]"), undefined, "a ref row that matches is unchanged");
    const pair = await h.ok("apply", { mode: "check", burgs: [{ name: "Twinford" }, { name: "Twinford" }] });
    assert.deepEqual(pair.counts, { unchanged: 2 }, "a name the list repeats pairs with the map's in id order");
    const e = await h.ok("apply", {
      burgs: [{ name: "Applyton", note: "again" }],
      notes: [{ entity: { type: "burg", name: "Applyton" }, legend: "other" }],
      labels: [{ text: "Bad Group", x: pick.n1.x, y: pick.n1.y, group: "regions" }]
    });
    const conflict = rowAt(e, "burgs[0].note");
    assert.equal(conflict.error.code, "CONFLICT");
    assert.equal(rowAt(e, "notes[0]").status, "updated", "the notes list entry comes first");
    assert.equal(rowAt(e, "labels[0]").error.code, "REFUSED");
    const n0 = await undoCount();
    const bad = await h.ok("apply", {
      routes: [{ name: "Bad Road", through: ["Applyton", "Specburg"], group: "no-such-group" }]
    });
    assert.equal(bad.note, "nothing to change", JSON.stringify(bad));
    assert.equal(rowAt(bad, "routes[0]").status, "error");
    assert.equal(await undoCount(), n0, "a create that cannot work takes no undo entry");
    const nothing = await h.call("apply", { mode: "check", burgs: [{ name: "x" }], only: ["labels"] });
    assert.equal(nothing.isError, true);
    assert.equal(errorBody(nothing).error.code, "BAD_ARGS");
  });

  test("specPath: the builder's spec shape with a light mapping; undo reverts the whole call", async () => {
    const file = path.join(out, "spec.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        seed: 194,
        frame: { name: "Spec World", year: 194, era: "of Specs", distanceScale: 0.1 },
        cultures: [
          {
            name: "Specish",
            color: "#4f7fbf",
            type: "Highland",
            namesbase: "English",
            at: [pick.n2.x, pick.n2.y],
            territory: { rule: "prose" }
          }
        ],
        burgs: [
          {
            name: "Frameton",
            x: pick.x[0].x,
            y: pick.x[0].y,
            population: 3000,
            culture: "Specish",
            port: false,
            type: "tunnel town",
            note: "framed"
          },
          {
            name: "Capitol",
            x: pick.x[1].x,
            y: pick.x[1].y,
            population: 9000,
            culture: "Specish",
            port: false,
            type: "capital city",
            capital: true,
            note: "seat"
          }
        ],
        labels: [{ text: "Peak One", x: pick.n1.x, y: pick.n1.y + 30, group: "peaks", invented: true }]
      })
    );
    const before = await undoCount();
    const r = await h.ok("apply", {
      specPath: file,
      mapping: {
        lists: { frame: "map" },
        keys: { burgs: { type: "group" } },
        values: { burgs: { group: { "tunnel town": "town", "capital city": null } }, labels: { group: "lbl_{}" } }
      }
    });
    assert.equal(r.changed, true);
    assert.deepEqual(r.skipped, ["seed"]);
    assert.deepEqual(r.ignored, { map: ["distanceScale"], cultures: ["territory"], labels: ["invented"] });
    assert.equal(rowAt(r, "map").status, "updated");
    const cap = rowAt(r, "burgs[1]");
    assert.equal(cap.status, "created");
    assert.deepEqual(
      (cap.diffs as Obj[]).map(d => [d.field, d.readOnly]),
      [["capital", true]],
      "a burg the spec calls a capital, and no state makes it one, is reported"
    );
    const v = (
      await h.ok("eval", {
        readOnly: true,
        code: `const b = pack.burgs.find(x => x && x.name === "Frameton" && !x.removed);
               return [mapName.value, options.era, b.group, pack.cultures[b.culture].name, notes.find(n => n.id === "burg" + b.i)?.legend, document.querySelector("#lbl_peaks text")?.textContent];`
      })
    ).value;
    assert.deepEqual(v, ["Spec World", "of Specs", "town", "Specish", "framed", "Peak One"]);
    assert.equal(await undoCount(), before + 1);
    await h.ok("snapshot", { action: "undo" });
    const gone = await h.ok("apply", {
      mode: "check",
      specPath: file,
      mapping: { lists: { frame: "map" } },
      only: ["burgs", "cultures"]
    });
    // two burgs, their two note shorthands, the culture
    assert.deepEqual(gone.counts, { missing: 5 }, "undo removed everything the call made");
  });

  test("number lists compare by position; write-only fields are skipped; a marker's note belongs to its entry; an impossible create takes no undo entry", async () => {
    // map fields like the settings extension's winds (6 numbers) and its write-only lock
    await h.ok("eval", {
      readOnly: true,
      code: `const F = __tupaia.mutations.FIELDS.map;
        F.testWinds = { check: v => v, get: () => (options.testWinds || [225, 45, 225, 315, 135, 315]).slice(), set: (_x, v) => { options.testWinds = v.slice(); } };
        F.lock = { check: v => v, get: () => null, show: v => v, set: () => {} };
        return true;`
    });
    const winds = [225, 45, 45, 315, 135, 315]; // the same set of numbers as the default, in another order
    const c = await h.ok("apply", { mode: "check", map: { testWinds: winds, lock: ["winds"] } });
    const row = rowAt(c, "map");
    assert.equal(row.status, "differs", JSON.stringify(c));
    assert.deepEqual(row.diffs, [{ field: "testWinds", have: [225, 45, 225, 315, 135, 315], want: winds }]);
    assert.match(JSON.stringify(c.notes), /map lock: write-only/);
    const n0 = await undoCount();
    const u = await h.ok("apply", { map: { testWinds: winds, lock: ["winds"] } });
    assert.equal(rowAt(u, "map").status, "updated");
    const again = await h.ok("apply", { map: { testWinds: winds, lock: ["winds"] } });
    assert.equal(again.note, "nothing to change", JSON.stringify(again));
    assert.equal(await undoCount(), n0 + 1);

    // a marker's note given by its markers entry and by a notes entry: the notes entry is a CONFLICT
    const twice = {
      markers: [{ name: "Spec Tower", note: "Taller" }],
      notes: [{ entity: { type: "marker", name: "Spec Tower" }, legend: "Other" }]
    };
    const m = await h.ok("apply", twice);
    assert.equal(m.note, "nothing to change", JSON.stringify(m));
    const cf = rowAt(m, "notes[0]");
    assert.equal(cf.error.code, "CONFLICT");
    assert.match(cf.error.message, /markers\[0\]/);
    assert.equal((await h.ok("apply", twice)).note, "nothing to change");

    // a route through names nothing in the spec creates: an error in the preview, no undo entry
    const n1 = await undoCount();
    const g = await h.ok("apply", { routes: [{ name: "Ghost Road", through: ["Nowhere Atall", "Nowhere Either"] }] });
    assert.equal(g.note, "nothing to change", JSON.stringify(g));
    assert.equal(rowAt(g, "routes[0]").error.code, "NOT_FOUND");
    assert.equal(await undoCount(), n1);
  });

  test("check matches upsert: pending dependencies, notes of error rows, grouped errors, CONFLICT, x,y, label group, legend contains", async () => {
    const at = (k: number) => ({ x: pick.x[k].x, y: pick.x[k].y });
    // a culture, a burg of that culture, notes on both: all missing in check (not errors)
    const chain = {
      cultures: [{ name: "Pendish", at: [pick.x[5].x, pick.x[5].y], color: "#336699", namesbase: "English" }],
      burgs: [
        { name: "Pendton", ...at(6), culture: "Pendish", note: "a pending note" },
        { name: pick.B.name, culture: "Pendish" }
      ],
      notes: [{ entity: { type: "culture", name: "Pendish" }, legend: "culture note" }]
    };
    const c = await h.ok("apply", { ...chain, mode: "check" });
    assert.deepEqual(c.counts, { differs: 1, missing: 4 }, JSON.stringify(c.rows));
    const b = rowAt(c, "burgs[1]");
    assert.match(b.diffs[0].pending, /culture 'Pendish' is created by this spec/, JSON.stringify(b));
    const up = await h.ok("apply", chain);
    assert.deepEqual(up.counts, { created: 4, updated: 1 }, JSON.stringify(up));
    const made = up.created as Obj;
    assert.ok(made.burgs.Pendton > 0 && made.cultures.Pendish > 0, JSON.stringify(made));
    assert.deepEqual((await h.ok("apply", { ...chain, mode: "check" })).counts, { unchanged: 5 });

    // an entity row that is an error still gets its note; one whose create failed says so
    const e = await h.ok("apply", {
      burgs: [
        { name: pick.O.name, culture: "No Such Culture", note: "noted anyway" },
        { name: "Soggy", x: 1, y: 1, note: "never" }
      ]
    });
    assert.equal(rowAt(e, "burgs[0]").status, "error");
    assert.equal((e.created as Obj)["burgs.note"][pick.O.name], `burg${pick.O.i}`, JSON.stringify(e));
    assert.equal(rowAt(e, "burgs[1]").note, "skipped: the entity does not exist");

    const k = await h.ok("apply", {
      mode: "check",
      provinces: [{ name: "Pa" }, { name: "Pb" }, { name: "Pc" }],
      routes: [
        {
          name: "Free Way",
          draw: "points",
          through: [
            [pick.n1.x, pick.n1.y],
            [pick.n2.x, pick.n2.y]
          ]
        }
      ],
      burgs: [
        { ref: pick.O.i, population: 5 },
        { name: pick.O.name },
        { name: "Twinford", ...at(3) },
        { name: "Moved In", x: pick.O.x, y: pick.O.y }
      ]
    });
    const grouped = (k.rows as Obj[]).find(r => r.count === 3) as Obj;
    assert.deepEqual(grouped.keys, ["Pa", "Pb", "Pc"], JSON.stringify(k.rows));
    assert.match(grouped.error.message, /^missing; apply cannot create provinces/);
    assert.match(rowAt(k, "routes[0]").error.message, /need the routes extension/);
    assert.equal(rowAt(k, "burgs[1]").error.code, "CONFLICT");
    assert.equal(rowAt(k, "burgs[2]"), undefined, "x,y picks one of two Twinfords: unchanged");
    const refused = rowAt(k, "burgs[3]").error.message;
    assert.ok(refused.includes(`'${pick.O.name}'`), refused);

    // a label moves to another group; a legend that contains the spec's text matches with legend:'contains'
    const lg = await h.ok("apply", { mode: "update", labels: [{ text: "Spec|Lands", group: "lbl_moved" }] });
    assert.deepEqual(rowAt(lg, "labels[0]").diffs, [{ field: "group", have: "lbl_regions", want: "lbl_moved" }]);
    const parent = (
      await h.ok("eval", { readOnly: true, code: `return document.querySelector("#lbl_moved text")?.textContent` })
    ).value;
    assert.equal(parent, "SpecLands");
    const partial = { burgs: [{ name: "Applyton", note: "othe" }] };
    assert.equal(((await h.ok("apply", { ...partial, mode: "check" })).counts as Obj).differs, 1);
    assert.deepEqual((await h.ok("apply", { ...partial, mode: "check", tolerance: { legend: "contains" } })).counts, {
      unchanged: 2
    });
  });

  test("sketch: one apply = several replayable records under one undo entry; undo/redo move them together; rebase remaps ids", async () => {
    // someone else's copy of the base: one more burg, so ids the sketch creates shift on replay
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("eval", {
      code: `const id = Burgs.add([${pick.x[4].x}, ${pick.x[4].y}]); pack.burgs[id].name = "Theirford"; return id;`
    });
    const other = (await h.ok("save_map", { path: "other-apply.map", overwrite: true })).path as string;
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("sketch", { action: "start", slug: "t-apply" });
    const r = await h.ok("apply", { ...spec(), verbose: true });
    assert.equal(r.changed, true);
    const ids = Object.fromEntries((r.rows as Obj[]).map(x => [x.at, x.i]));
    let st = await h.ok("sketch", { action: "status" });
    const log = st.log as Obj[];
    assert.ok(log.length >= 8, JSON.stringify(log));
    assert.ok(
      log.every(o => /^apply \d+\/\d+: /.test(o.summary)),
      "every record says it came from apply"
    );
    assert.deepEqual([...new Set(log.map(o => o.tool))].sort(), ["add", "edit"]);
    assert.equal(st.blobOnly, false);
    const n = log.length;

    const u = await h.ok("snapshot", { action: "undo" });
    assert.match(JSON.stringify(u.notes), new RegExp(`ops 1-${n} \\(one apply call\\) removed`));
    st = await h.ok("sketch", { action: "status" });
    assert.equal((st.log as Obj[]).length, 0);
    assert.equal(st.redoAvailable, n);
    const re = await h.ok("snapshot", { action: "redo" });
    assert.match(JSON.stringify(re.notes), new RegExp(`ops 1-${n} are back`));
    st = await h.ok("sketch", { action: "status" });
    assert.equal((st.log as Obj[]).length, n);

    const rb = await h.ok("sketch", { action: "rebase", onto: { path: other } }, 240_000);
    assert.equal(rb.completed, true, JSON.stringify(rb.conflicts));
    const idMap = rb.idMap as Record<string, Record<string, number>>;
    const b1 = idMap.burg[String(ids["burgs[0]"])];
    const b2 = idMap.burg[String(ids["burgs[1]"])];
    assert.ok(b1 !== undefined && b1 !== ids["burgs[0]"], `created burg ids shift: ${JSON.stringify(idMap)}`);
    const v = (
      await h.ok("eval", {
        readOnly: true,
        args: { b1, b2 },
        code: `
          const route = pack.routes.find(x => x.name === "Spec Road");
          const ends = [route.points[0][2], route.points[route.points.length - 1][2]].map(c => pack.cells.burg[c]);
          const s = pack.states.find(x => x && x.name === "Testland" && !x.removed);
          return {
            names: [pack.burgs[args.b1].name, pack.burgs[args.b2].name],
            ends, theirs: pack.burgs.some(b => b && b.name === "Theirford" && !b.removed),
            note: notes.find(n => n.id === "burg" + args.b1)?.legend ?? null,
            capital: pack.burgs[s.capital].name,
            stateNote: notes.find(n => n.id === "stateLabel" + s.i)?.legend ?? null
          };`
      })
    ).value as Obj;
    assert.deepEqual(v.names, ["Applyton", "Specburg"]);
    assert.deepEqual(v.ends.sort(), [b1, b2].sort(), "the replayed road joins the replayed burgs");
    assert.equal(v.theirs, true);
    assert.equal(v.note, "First <b>new</b> burg", "the note follows the remapped burg id");
    assert.equal(v.capital, "Specburg");
    assert.equal(v.stateNote, "A state");
    const chk = await h.ok("apply", { ...spec(), mode: "check" });
    assert.deepEqual(chk.counts, { unchanged: 12 }, JSON.stringify(chk.rows));
  });
});
