// add province / add river (bridge-ext regen.js ADD.province, rivers.js ADD.river) and apply
// creating provinces and rivers from a spec, on tests/fixtures/demo.map:
//   - a province around a burg grows over the state's cells nearer its centre than the other
//     provinces' centres; cells/select; refusals (a held centre, Neutrals, cells of another state);
//   - a river along points (extended to the sea or to its parent), or literal cells; flux,
//     discharge downstream and the river invariants; refusals; undo restores everything;
//   - apply creates both from a builder-style spec (states[].provinces, rivers_intended) and a
//     re-check is unchanged; entries without enough to create are error rows;
//   - the sketch log holds literal forms (cells, coa, cell graph) and a rebase onto a copy with
//     shifted ids replays them (a river whose parent the sketch created included).
// Fixture (demo.map): burg 22 Rineiguro (cell 6190) of state 9 Vexum is no province's capital or
// centre; river 4 Nelbaz runs past cell 6176 (a few cells east, other rivers in between); cell
// 4812 (h100) is 5+ cells from any river and 3 from the sea.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { normalizeEntry, normalizeSpec } from "../src/apply-spec.ts";
import { alive, errorBody, type Harness, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

describe("add province/river: spec normalization (no browser)", () => {
  test("nested provinces take their state (as mapped); rivers' from/via/to become points", () => {
    const s = normalizeSpec(
      {
        states: [
          {
            name: "Somnea",
            provinces: [
              { name: "P1", capital: "B" },
              { name: "P2", state: "Elsewhere" }
            ]
          },
          { ref: 3, provinces: [{ name: "P3" }] }
        ],
        rivers_intended: [{ name: "R", from: [1, 2], via: [[3, 4]], to: [-10, 6], note: "n" }]
      },
      {},
      { lists: { rivers_intended: "rivers" }, values: { states: { name: { Somnea: "Somnean Realm" } } } }
    );
    const prov = s.lists.find(l => l.key === "provinces")?.entries;
    assert.deepEqual(prov, [
      { name: "P1", capital: "B", state: "Somnean Realm" },
      { name: "P2", state: "Elsewhere" },
      { name: "P3", state: 3 }
    ]);
    assert.deepEqual(s.lists.find(l => l.key === "rivers")?.entries, [
      {
        name: "R",
        note: "n",
        points: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
          { x: -10, y: 6 }
        ]
      }
    ]);
    assert.deepEqual(normalizeEntry("river", { name: "R", points: [[1, 2], { cell: 5 }] }), {
      name: "R",
      points: [{ x: 1, y: 2 }, { cell: 5 }]
    });
    assert.deepEqual(normalizeEntry("river", { name: "R", to: [1, 2] }), { name: "R", points: [{ x: 1, y: 2 }] });
  });
});

// River data invariants (as test/rivers.test.ts): source/mouth/discharge, parents and junctions,
// basins, cells.r, one svg path per river.
const INVARIANTS = `
const C = pack.cells, out = [];
const byId = new Map(pack.rivers.map(r => [r.i, r]));
const own = new Map();
for (const r of pack.rivers) {
  const n = r.cells.length;
  if (r.source !== r.cells[0]) out.push(r.i + " source");
  if (r.mouth !== r.cells[n - 2]) out.push(r.i + " mouth");
  if (r.discharge !== C.fl[r.mouth]) out.push(r.i + " discharge " + r.discharge + " vs " + C.fl[r.mouth]);
  const isTrib = r.parent && r.parent !== r.i;
  if (isTrib && !byId.has(r.parent)) out.push(r.i + " parent " + r.parent + " missing");
  if (isTrib && byId.has(r.parent)) {
    const j = r.cells[n - 1];
    if (!byId.get(r.parent).cells.includes(j) && !(j >= 0 && C.h[j] < 20)) out.push(r.i + " does not end on " + r.parent);
  }
  let root = r;
  for (let g = 0; g < 60 && root.parent && root.parent !== root.i && byId.has(root.parent); g++) root = byId.get(root.parent);
  if (r.basin !== root.i) out.push(r.i + " basin " + r.basin + " vs " + root.i);
  for (const c of r.cells) if (c >= 0 && C.h[c] >= 20) own.set(c, Math.min(own.get(c) ?? Infinity, r.i));
}
for (const [c, m] of own) if (C.r[c] !== m) out.push("cell " + c + " r " + C.r[c] + " vs " + m);
for (const c of C.i) if (C.r[c] && !own.has(c)) out.push("cell " + c + " stray r " + C.r[c]);
const paths = document.querySelectorAll("#rivers path").length;
if (paths !== pack.rivers.length) out.push("svg paths " + paths + " vs " + pack.rivers.length);
return out.slice(0, 20);`;

const STATE = `JSON.stringify({ rivers: pack.rivers, r: Array.from(pack.cells.r), fl: Array.from(pack.cells.fl),
  conf: Array.from(pack.cells.conf), province: Array.from(pack.cells.province), provinces: pack.provinces,
  states: pack.states.map(s => s.provinces), lakes: pack.features.filter(f => f && f.type === "lake").map(f => [f.i, f.outlet, f.inlets]) })`;

const PICK = `
const C = pack.cells;
const held = new Set();
for (const p of pack.provinces) if (p && p.i && !p.removed) { held.add(p.center); const b = pack.burgs[p.burg]; if (b) held.add(b.cell); }
const other = pack.burgs.find(b => b && b.i && !b.removed && C.state[b.cell] > 0 && C.state[b.cell] !== 9 && !held.has(b.cell));
const on = new Set(pack.rivers.flatMap(r => r.cells).filter(c => c >= 0));
const dist = new Map([...on].map(c => [c, 0]));
let fr = [...on];
for (let d = 1; d < 9; d++) { const nx = []; for (const c of fr) for (const n of C.c[c]) if (!dist.has(n) && C.h[n] >= 20) { dist.set(n, d); nx.push(n); } fr = nx; }
const inland = c => C.c[c].every(n => C.h[n] >= 20 && C.c[n].every(m => C.h[m] >= 20));
const far = C.i.find(c => dist.get(c) >= 5 && inland(c) && !C.b[c] && Math.hypot(C.p[c][0] - C.p[4812][0], C.p[c][1] - C.p[4812][1]) > 300);
const neutral = C.i.find(c => C.h[c] >= 20 && !C.state[c] && !C.burg[c]);
const foreign = C.i.find(c => C.h[c] >= 20 && C.state[c] > 0 && C.state[c] !== 9);
const nine = C.i.find(c => C.h[c] >= 20 && C.state[c] === 9 && !held.has(c) && c !== 6190 && !C.burg[c]);
const b22 = pack.burgs[22];
return { other: { i: other.i, name: other.name, state: C.state[other.cell] }, far, farXY: { x: C.p[far][0], y: C.p[far][1] }, neutral, foreign, nine,
  b22: { name: b22.name, cell: b22.cell, state: C.state[b22.cell], held: held.has(b22.cell) },
  provinces: pack.provinces.length, maxRiver: Math.max(...pack.rivers.map(r => r.i)),
  h4812: C.h[4812], d4812: dist.get(4812) ?? 99, nelbaz: pack.rivers.find(r => r.i === 4).name };`;

describe("tupaia-mcp add province / add river", () => {
  let h: Harness;
  let pick: Obj;

  const read = async (code: string, args: Obj = {}): Promise<any> =>
    (await h.ok("eval", { code, args, readOnly: true })).value;
  const invariants = async (): Promise<string[]> => read(INVARIANTS);
  const state = async (): Promise<string> => read(STATE);
  const refused = async (tool: string, args: Obj): Promise<{ code: string; message: string }> => {
    const r = await h.call(tool, args);
    assert.equal(r.isError, true, `${tool} is refused`);
    const e = errorBody(r).error as Obj;
    const first = (e.details?.errors as Obj[] | undefined)?.[0];
    return first ? { code: first.code, message: first.message } : (e as { code: string; message: string });
  };
  const undo = (n = 1) => h.ok("snapshot", { action: "undo", n });

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    pick = await read(PICK);
    assert.deepEqual(pick.b22, { name: "Rineiguro", cell: 6190, state: 9, held: false }, "fixture: burg 22");
    assert.equal(pick.nelbaz, "Nelbaz");
    assert.ok(pick.h4812 >= 20 && pick.d4812 >= 4, "fixture: cell 4812 is land away from rivers");
    assert.ok(pick.far && pick.foreign && pick.nine && pick.other.i, JSON.stringify(pick));
    assert.deepEqual(await invariants(), []);
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("add province around a burg: grows over its state's nearer cells, refits the losers; refusals; undo", async () => {
    const before0 = await state();
    const dry = await h.ok("add", { type: "province", items: [{ centre: { burg: "Rineiguro" } }], dryRun: true });
    const plan = (dry.plan as Obj[])[0];
    assert.deepEqual([plan.state, plan.center, plan.burg], [9, 6190, 22]);
    assert.ok(plan.cells > 3, JSON.stringify(plan));
    const out = await h.ok("add", { type: "province", items: [{ centre: { burg: 22 }, name: "Testshire" }] });
    const row = (out.created as Obj[] | undefined)?.[0] ?? (out.createdIds as Obj | undefined);
    const id = pick.provinces as number;
    assert.equal((out.created as Obj[])[0].i, id, JSON.stringify(out));
    assert.equal((out.created as Obj[])[0].cells, plan.cells, JSON.stringify(row));
    assert.match(JSON.stringify(out.notes), /took cells from/);
    const v = await read(
      `const C = pack.cells, p = pack.provinces[args.id], cells = C.i.filter(c => C.province[c] === args.id);
       return { n: cells.length, inState: cells.every(c => C.state[c] === 9 && C.h[c] >= 20), centre: C.province[6190] === args.id,
         listed: pack.states[9].provinces.includes(args.id), burg: p.burg, full: p.fullName, form: p.formName,
         pole: Array.isArray(p.pole), shield: typeof p.coa?.shield, color: p.color,
         centresKept: pack.provinces.every(q => !q || !q.i || q.removed || C.province[q.center] === q.i) };`,
      { id }
    );
    assert.deepEqual(
      [v.n, v.inState, v.centre, v.listed, v.burg, v.pole, v.shield, v.centresKept],
      [plan.cells, true, true, true, 22, true, "string", true]
    );
    assert.equal(v.full, `Testshire ${v.form}`);
    assert.match(v.color, /^#[0-9a-f]{6}$/);

    // the same centre again, Neutrals, a cell of another state
    const again = await refused("add", { type: "province", items: [{ centre: { burg: 22 } }] });
    assert.equal(again.code, "REFUSED");
    assert.match(again.message, /already the centre of province Testshire/);
    if (pick.neutral !== undefined) {
      const n = await refused("add", { type: "province", items: [{ centre: { cell: pick.neutral } }] });
      assert.match(n.message, /Neutrals/);
    }
    const f = await refused("add", {
      type: "province",
      items: [{ centre: { cell: pick.nine }, cells: [pick.nine, pick.foreign] }]
    });
    assert.match(f.message, /not land of Vexum/);
    const wrong = await refused("add", {
      type: "province",
      items: [{ centre: { cell: pick.nine }, state: pick.other.state }]
    });
    assert.match(wrong.message, /is in Vexum/);
    const bad = await refused("add", { type: "province", items: [{ centre: { cell: pick.nine }, size: 3 }] });
    assert.equal(bad.code, "BAD_FIELD");

    // a place centre with literal cells and a generated name; a select is clipped to the state
    const lit = await h.ok("add", {
      type: "province",
      items: [{ centre: { cell: pick.nine }, cells: [pick.nine], name: { generate: {} }, formName: "March" }]
    });
    const l = (lit.created as Obj[])[0];
    assert.equal(l.cells, 1);
    assert.ok(typeof l.name === "string" && l.name.length > 1);
    assert.equal(await read(`pack.provinces[${l.i}].fullName`), `${l.name} March`);
    const sel = await h.ok("add", {
      type: "province",
      items: [
        {
          centre: { burg: pick.other.i },
          select: { circle: { at: { entity: { type: "burg", ref: pick.other.i } }, radius: 200 } }
        }
      ]
    });
    const s = (sel.created as Obj[])[0];
    assert.equal(s.state, pick.other.state);
    assert.ok(
      await read(
        `pack.cells.i.filter(c => pack.cells.province[c] === ${s.i}).every(c => pack.cells.state[c] === ${pick.other.state})`
      )
    );
    await undo(3);
    assert.equal(await state(), before0, "undo restores the provinces and their cells");
  });

  test("add river: points extend to the sea or to a parent; literal cells; flux downstream; refusals; undo", async () => {
    const before0 = await state();
    const disc = await read(`pack.rivers.find(r => r.i === 4).discharge`);
    const a = await h.ok("add", { type: "river", items: [{ points: [{ cell: 4812 }], name: "Testbrook" }] });
    const ra = (a.created as Obj[])[0];
    assert.equal(ra.i, pick.maxRiver + 1);
    assert.equal(ra.source, 4812);
    assert.match(ra.ends, /the sea at cell \d+/);
    assert.match(JSON.stringify(a.notes), /extended \d+ cell\(s\) from the last place/);
    const b = await h.ok("add", {
      type: "river",
      items: [{ points: [{ cell: 6176 }], parent: "Nelbaz", name: "Nelbrook" }]
    });
    const rb = (b.created as Obj[])[0];
    assert.equal(rb.parent, 4);
    assert.match(rb.ends, /Nelbaz \(4\) at cell \d+/);
    assert.match(JSON.stringify(b.notes), /discharge changed downstream: Nelbaz \(4\)/);
    const v = await read(
      `const R = i => pack.rivers.find(r => r.i === i), x = R(args.b), j = x.cells.at(-1);
       return { conf: pack.cells.conf[j] > 0, disc: R(4).discharge, basin: x.basin, r: pack.cells.r[x.cells[1]],
         wf: [x.widthFactor, R(args.a).widthFactor], type: typeof x.type, len: x.length > 0 };`,
      { a: ra.i, b: rb.i }
    );
    assert.equal(v.conf, true);
    assert.ok(v.disc > disc, `Nelbaz carries the new water: ${disc} -> ${v.disc}`);
    assert.deepEqual([v.basin, v.r, v.type, v.len], [4, rb.i, "string", true]);
    assert.ok(v.wf[1] > v.wf[0], "a main river is wider than a tributary (width factor)");
    assert.deepEqual(await invariants(), []);

    // literal cells: the recorded course again elsewhere is refused (it rises on the new river)
    const cells = (await read(`pack.rivers.find(r => r.i === ${ra.i}).cells`)) as number[];
    const on = await refused("add", { type: "river", items: [{ cells }] });
    assert.match(on.message, /cannot rise on another river/);
    const gap = await refused("add", { type: "river", items: [{ cells: [pick.far, cells[2], cells[3]] }] });
    assert.match(gap.message, /not neighbours/);
    const loose = await read(
      `const C = pack.cells, a = args.far, b = C.c[a].find(c => C.h[c] >= 20 && !C.r[c]), c = C.c[b].find(x => x !== a && C.h[x] >= 20 && !C.r[x] && !C.c[x].some(y => C.h[y] < 20));
       return [a, b, c];`,
      { far: pick.far }
    );
    const ends = await refused("add", { type: "river", items: [{ cells: loose }] });
    assert.match(ends.message, /is not water, another river's course or -1/);
    const two = await refused("add", { type: "river", items: [{ points: [{ cell: 4812 }], cells }] });
    assert.match(two.message, /exactly one/);
    const notParent = await refused("add", {
      type: "river",
      items: [{ cells: [...cells.slice(0, -1), cells.at(-1)], parent: 4 }]
    });
    assert.ok(/rise on|not on Nelbaz/.test(notParent.message), notParent.message);

    await undo(2);
    assert.equal(await state(), before0, "undo restores the rivers, flux and confluences");
  });

  test("apply creates provinces and rivers from a builder-style spec; a re-check is unchanged", async () => {
    const spec = {
      mapping: { lists: { rivers_intended: "rivers" } },
      states: [
        {
          name: "Vexum",
          provinces: [{ name: "Rineiguro March", capital: "Rineiguro", includes: ["the vale"] }, { name: "Nowhere" }]
        }
      ],
      rivers_intended: [
        { name: "Spec Brook", from: [837.94, 585.7], to: [850, 600], via: [], note: "A test brook." },
        { name: "Nelbrook", from: [271.54, 724.27], to: [230, 710], note: "joins Nelbaz" },
        { name: "Nameless" }
      ]
    };
    const c = await h.ok("apply", { ...spec, mode: "check" });
    const rowOf = (r: Obj, at: string) =>
      (r.rows as Obj[]).find(x => x.at === at || (x.at as string[])?.includes?.(at)) as Obj;
    assert.equal(rowOf(c, "provinces[0]").status, "missing", JSON.stringify(c.rows));
    assert.match(rowOf(c, "provinces[1]").error.message, /^missing; a new province needs a centre/);
    assert.match(rowOf(c, "rivers[2]").error.message, /^missing; a new river needs its course/);
    assert.equal(rowOf(c, "rivers[0]").status, "missing");
    const up = await h.ok("apply", spec);
    const made = up.created as Obj;
    assert.ok(made.provinces["Rineiguro March"] > 0, JSON.stringify(up));
    assert.ok(made.rivers["Spec Brook"] > 0 && made.rivers.Nelbrook > 0, JSON.stringify(up));
    assert.equal(made["rivers.note"]["Spec Brook"], `river${made.rivers["Spec Brook"]}`);
    assert.deepEqual(up.ignored, { provinces: ["includes"] });
    const again = await h.ok("apply", { ...spec, mode: "check" });
    assert.deepEqual(again.counts, { unchanged: 6, error: 2 }, JSON.stringify(again.rows));
    const p = await read(
      `const p = pack.provinces[${made.provinces["Rineiguro March"]}]; return [p.state, p.burg, p.name]`
    );
    assert.deepEqual(p, [9, 22, "Rineiguro March"]);
    assert.deepEqual(await invariants(), []);
    await undo();
  });

  test("apply: a new state's provinces are made after its territory is painted; province paints come after them", async () => {
    const { x, y } = pick.farXY as { x: number; y: number };
    const spec = {
      burgs: [{ name: "Newtown", x, y }],
      states: [
        {
          name: "Newland",
          capital: "Newtown",
          provinces: [
            { name: "Newmarch", capital: "Newtown" },
            { name: "Outmarch", at: { x: x + 30, y } }
          ]
        }
      ],
      paint: [
        { select: { circle: [x + 15, y, 70], where: { land: true } }, set: { province: "Outmarch" } },
        { select: { circle: [x, y, 90], where: { land: true } }, set: { state: "Newland" } }
      ]
    };
    const c = await h.ok("apply", { ...spec, mode: "check" });
    assert.deepEqual((c.lists as Obj).provinces, { missing: 2 }, JSON.stringify(c.rows));
    const up = await h.ok("apply", spec);
    assert.deepEqual((up.lists as Obj).provinces, { created: 2 }, JSON.stringify(up.rows));
    const v = await read(
      `const C = pack.cells, s = pack.states.find(x => x.name === "Newland"), ps = pack.provinces.filter(p => p && p.i && !p.removed);
       const named = n => ps.filter(p => p.name === n);
       const out = named("Outmarch")[0];
       return { n: [named("Newmarch").length, named("Outmarch").length], state: [named("Newmarch")[0].state, out.state].every(i => i === s.i),
         inState: C.i.filter(c => C.province[c] === out.i).every(c => C.state[c] === s.i),
         painted: C.i.filter(c => C.province[c] === out.i).length };`
    );
    assert.deepEqual(v.n, [1, 1], "no namesake province from a later state paint");
    assert.equal(v.state, true);
    assert.equal(v.inState, true);
    assert.ok(v.painted > 1, JSON.stringify(v));
    const again = await h.ok("apply", { ...spec, mode: "check" });
    assert.deepEqual(again.counts, { unchanged: 6 }, JSON.stringify(again.rows));
    await undo();
  });

  test("sketch: literal add records (cells, coa, cell graph) replay onto a copy with shifted ids", async () => {
    // someone else's copy: one more province and one more river, so the sketch's ids shift
    await h.ok("add", { type: "province", items: [{ centre: { burg: pick.other.i }, name: "Theirshire" }] });
    await h.ok("add", { type: "river", items: [{ points: [{ cell: pick.far }], name: "Theirbrook" }] });
    const shifted = (await h.ok("save_map", { path: "addprov-shifted.map", overwrite: true })).path as string;
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });

    await h.ok("sketch", { action: "start", slug: "t-addprov" });
    const p = (await h.ok("add", { type: "province", items: [{ centre: { burg: 22 }, name: "Sketchshire" }] })) as Obj;
    const a = (await h.ok("add", {
      type: "river",
      items: [{ points: [{ cell: 4812 }], name: "Sketch River" }]
    })) as Obj;
    const ai = (a.created as Obj[])[0].i as number;
    // a tributary of the river the sketch made: a land cell two steps from its course
    const src = await read(
      `const C = pack.cells, r = pack.rivers.find(x => x.i === args.ai), course = new Set(r.cells.slice(0, -1));
       const near = new Set(); for (const c of course) for (const n of C.c[c]) if (C.h[n] >= 20 && !C.r[n]) near.add(n);
       for (const c of near) for (const n of C.c[c]) if (C.h[n] >= 20 && !C.r[n] && !near.has(n) && !course.has(n) && C.h[n] >= C.h[c]) return n;
       return null;`,
      { ai }
    );
    assert.ok(Number.isInteger(src), "a source cell near the sketch's river");
    const t = (await h.ok("add", {
      type: "river",
      items: [{ points: [{ cell: src }], parent: ai, name: "Sketch Fork" }]
    })) as Obj;
    assert.equal((t.created as Obj[])[0].parent, ai);
    const full = await h.ok("sketch", { action: "status", full: true });
    const recs = full.records as Obj[];
    assert.equal(recs.length, 3);
    const pr = recs[0].resolved;
    assert.equal(pr.type, "province");
    assert.deepEqual(pr.items[0].centre, { burg: 22 });
    assert.equal(pr.items[0].state, 9);
    assert.ok(Array.isArray(pr.items[0].cells) && pr.items[0].cells.includes(6190));
    assert.equal(typeof pr.items[0].coa, "object");
    assert.match(String(pr.graph), /^\d+:\w+$/, "literal cells record the cell graph");
    assert.ok(Array.isArray(recs[1].resolved.items[0].cells));
    assert.equal(recs[2].resolved.items[0].parent, ai);
    assert.match(recs[1].summary, /Added river "Sketch River"/);

    const rb = await h.ok("sketch", { action: "rebase", onto: { path: shifted } }, 240_000);
    assert.equal(rb.completed, true, JSON.stringify(rb.conflicts));
    const idMap = rb.idMap as Record<string, Record<string, number>>;
    const pid = idMap.province[String((p.created as Obj[])[0].i)];
    const rid = idMap.river[String(ai)];
    assert.equal(pid, pick.provinces + 1, "their province took the id");
    assert.equal(rid, pick.maxRiver + 2, "their river took the id");
    const v = await read(
      `const R = i => pack.rivers.find(r => r.i === i), fork = pack.rivers.find(r => r.name === "Sketch Fork");
       return { prov: pack.provinces[args.pid].name, theirs: pack.provinces[args.pid - 1].name, river: R(args.rid).name,
         fork: fork.parent === args.rid, theirBrook: R(args.rid - 1).name };`,
      { pid, rid }
    );
    assert.deepEqual(v, {
      prov: "Sketchshire",
      theirs: "Theirshire",
      river: "Sketch River",
      fork: true,
      theirBrook: "Theirbrook"
    });
    assert.deepEqual(await invariants(), []);
    await h.ok("sketch", { action: "discard", confirm: true }).catch(() => h.ok("sketch", { action: "stop" }));
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
  });
});
