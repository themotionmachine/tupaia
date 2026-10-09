// River structure edits (edit river {type, name, mainStem, split, merge, reroute}) on
// tests/fixtures/demo.map, and their sketch replay (rebase {onto:{path}} test hook: no network).
// Rivers used (demo.map):
//   6 Maracenda (root, 18 cells) <- 7 Olsneske joins at cell 6188 (index 12); 95 Grenburg and
//     96 Dottinfel join 6 at 6802, 397 Vathos at 6679 (all above the junction); 28 Nevels and
//     196 Alrosinbach are tributaries of 7.
//   4 Nelbaz (root) <- 97 Honing joins at 5701 (index 14); 19 Sheunfaui joins 4 above it, at
//     6053; 75 and 388 are tributaries of 97.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { alive, errorBody, type Harness, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

// Data invariants every river edit must keep: source/mouth/discharge as the generator sets them,
// cells.r = lowest river id whose course holds the cell, parents exist and tributaries end on
// their parent (or in a lake), basin = the root of the parent chain, one svg path per river.
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

const RIVERS = `
const pick = r => r && { i: r.i, name: r.name, type: r.type, parent: r.parent, basin: r.basin, source: r.source,
  mouth: r.mouth, discharge: r.discharge, width: r.width, widthFactor: r.widthFactor, sourceWidth: r.sourceWidth, cells: r.cells };
return Object.fromEntries(args.ids.map(i => [i, pick(pack.rivers.find(r => r.i === i)) ?? null]));`;

const STATE = `JSON.stringify({ rivers: pack.rivers, r: Array.from(pack.cells.r), fl: Array.from(pack.cells.fl),
  conf: Array.from(pack.cells.conf), lakes: pack.features.filter(f => f && f.type === "lake").map(f => [f.i, f.outlet, f.inlets]) })`;

describe("tupaia-mcp river structure edits", () => {
  let h: Harness;
  let base = ""; // a namesbase name
  let maxId = 0;

  const rivers = async (...ids: number[]): Promise<Record<string, Obj>> =>
    (await h.ok("eval", { code: RIVERS, args: { ids }, readOnly: true })).value as Record<string, Obj>;
  const invariants = async (): Promise<string[]> =>
    (await h.ok("eval", { code: INVARIANTS, readOnly: true })).value as string[];
  const state = async (): Promise<string> => (await h.ok("eval", { code: STATE, readOnly: true })).value as string;
  const edit = (ops: Obj[], extra: Obj = {}) => h.ok("edit", { type: "river", ops, ...extra });
  const refused = async (ops: Obj[]): Promise<{ code: string; message: string }> => {
    const r = await h.call("edit", { type: "river", ops });
    assert.equal(r.isError, true, "the edit is refused");
    return errorBody(r).error;
  };
  const undo = () => h.ok("snapshot", { action: "undo" });

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    const v = (
      await h.ok("eval", {
        readOnly: true,
        code: `({ base: nameBases[1].name, maxId: Math.max(...pack.rivers.map(r => r.i)),
                 six: pack.rivers.find(r => r.i === 6).cells.length, seven: pack.rivers.find(r => r.i === 7).cells.at(-1) })`
      })
    ).value as Obj;
    base = v.base;
    maxId = v.maxId;
    assert.equal(v.six, 18, "fixture: river 6 has 18 cells");
    assert.equal(v.seven, 6188, "fixture: river 7 joins 6 at cell 6188");
    assert.deepEqual(await invariants(), [], "the fixture satisfies the invariants");
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("type is editable; name {generate:{base}} works for rivers", async () => {
    const t = await edit([{ ref: 6, set: { type: "Brook" } }]);
    assert.deepEqual((t.applied as Obj[])[0].after, { type: "Brook" });
    const bad = await refused([{ ref: 6, set: { type: "  " } }]);
    assert.equal(bad.code, "BAD_ARGS");
    const dry = await edit([{ ref: 6, set: { name: { generate: { base } } } }], { dryRun: true });
    assert.match(JSON.stringify((dry.plan as Obj[])[0].after), new RegExp(`generated from namesbase ${base}`));
    const g = await edit([{ ref: 6, set: { name: { generate: { base } } } }]);
    const name = (g.applied as Obj[])[0].after.name as string;
    assert.ok(typeof name === "string" && name.length > 1 && name !== "Maracenda", name);
    const own = await edit([{ ref: 6, set: { name: { generate: {} } } }]);
    assert.ok(((own.applied as Obj[])[0].after.name as string).length > 1);
    const r = await rivers(6);
    assert.equal(r[6].type, "Brook");
    for (let k = 0; k < 3; k++) await undo();
    assert.deepEqual([(await rivers(6))[6].name, (await rivers(6))[6].type], ["Maracenda", "River"]);
  });

  test("mainStem: the tributary's upper course becomes the main river's; tributaries follow", async () => {
    const before0 = await state();
    const dry = await edit([{ ref: 6, set: { mainStem: "Olsneske" } }], { dryRun: true });
    const row = (dry.plan as Obj[])[0];
    assert.match(row.before.mainStem, /^18 cells 7262->5952/);
    assert.match(row.after.mainStem, /^20 cells 6910->5952/);
    const out = await edit([{ ref: 6, set: { mainStem: 7 } }]);
    assert.deepEqual(out.redrawn, ["rivers"]);
    assert.match(JSON.stringify(out.notes), /Olsneske \(7\) holds its old upper course/);
    const r = await rivers(6, 7, 28, 196, 95, 96, 397);
    assert.deepEqual(
      r[6].cells,
      [
        6910, 6792, 6669, 6670, 6671, 6672, 6548, 6549, 6427, 6428, 6429, 6310, 6311, 6187, 6188, 6189, 6190, 6069,
        5952, 5834
      ]
    );
    assert.deepEqual(r[7].cells, [7262, 7146, 7033, 7034, 6916, 6799, 6800, 6802, 6679, 6555, 6432, 6313, 6188]);
    assert.equal(r[6].name, "Maracenda", "the main river keeps its name");
    assert.equal(r[6].parent, 0);
    assert.equal(r[7].parent, 6);
    assert.equal(r[6].widthFactor, 1.2, "the main stem keeps the main-stem width factor");
    assert.equal(r[7].widthFactor, 1);
    assert.deepEqual([r[6].sourceWidth, r[7].sourceWidth], [0.17, 0.27], "the source widths follow their sources");
    assert.deepEqual([r[28].parent, r[196].parent], [6, 6], "the tributary's own tributaries now join the main river");
    assert.deepEqual(
      [r[95].parent, r[96].parent, r[397].parent],
      [7, 7, 7],
      "the old upper course keeps its tributaries"
    );
    assert.deepEqual(await invariants(), []);
    await undo();
    assert.equal(await state(), before0, "undo restores rivers, cells.r/fl/conf and lakes exactly");
  });

  test("mainStem nested: Honing becomes Nelbaz's main stem", async () => {
    await edit([{ ref: "Nelbaz", set: { mainStem: "Honing" } }]);
    const r = await rivers(4, 97, 19, 75, 388);
    assert.deepEqual(r[4].cells.slice(0, 8), [6423, 6303, 6178, 6056, 5939, 5819, 5702, 5701]);
    assert.equal(r[4].cells.at(-1), 3469, "the mouth stays");
    assert.equal(r[97].cells.length, 15);
    assert.equal(r[97].cells.at(-1), 5701);
    assert.equal(r[19].parent, 97, "a tributary of the old upper course follows it");
    assert.deepEqual([r[75].parent, r[388].parent], [4, 4]);
    assert.deepEqual(await invariants(), []);
    await undo();
  });

  test("split and merge: a new upper river with its own name, and the exact inverse", async () => {
    const before0 = JSON.parse(await state());
    const dry = await edit([{ ref: 6, set: { split: { at: 6555, name: "Upper Maracenda", type: "Brook" } } }], {
      dryRun: true
    });
    assert.match(JSON.stringify((dry.plan as Obj[])[0].after), /new upper river: 10 cells 7262->6679/);
    const s = await edit([
      { ref: 6, set: { split: { at: 6555, name: "Upper Maracenda", type: "Brook" }, name: "Lower Maracenda" } }
    ]);
    const created = (s.applied as Obj[])[0].created as Obj[];
    assert.deepEqual(created, [{ type: "river", i: maxId + 1, name: "Upper Maracenda" }]);
    const u = maxId + 1;
    const r = await rivers(6, u, 95, 96, 397, 7);
    assert.deepEqual(r[6].cells, [6555, 6432, 6313, 6188, 6189, 6190, 6069, 5952, 5834]);
    assert.equal(r[6].name, "Lower Maracenda");
    assert.deepEqual(r[u].cells, [7262, 7146, 7033, 7034, 6916, 6799, 6800, 6802, 6679, 6555]);
    assert.deepEqual([r[u].name, r[u].type, r[u].parent, r[u].basin], ["Upper Maracenda", "Brook", 6, 6]);
    assert.ok(r[6].sourceWidth > 0.27, "the lower part starts as wide as the river was there");
    assert.deepEqual([r[95].parent, r[96].parent, r[397].parent, r[7].parent], [u, u, u, 6]);
    assert.deepEqual(await invariants(), []);
    // merge it back by name
    const m = await edit([{ ref: "Upper Maracenda", set: { merge: true } }]);
    assert.equal((m.applied as Obj[])[0].after.merge, "merged into river 6");
    const after0 = JSON.parse(await state());
    assert.deepEqual(after0.r, before0.r, "cells.r is back");
    assert.deepEqual(after0.fl, before0.fl, "cells.fl is back");
    assert.deepEqual(after0.lakes, before0.lakes);
    const six = after0.rivers.find((x: Obj) => x.i === 6);
    const six0 = before0.rivers.find((x: Obj) => x.i === 6);
    for (const k of ["cells", "source", "mouth", "discharge", "sourceWidth", "widthFactor", "parent", "basin"])
      assert.deepEqual(six[k], six0[k], k);
    assert.ok(Math.abs(six.length - six0.length) < 1, "length recomputed the generator's way");
    assert.equal(after0.rivers.length, before0.rivers.length);
    assert.deepEqual(await invariants(), []);
    // a generated name when none is given
    const g = await edit([{ ref: 6, set: { split: { at: { entity: { type: "river", ref: 6 }, at: 0.5 } } } }]);
    const gname = ((g.applied as Obj[])[0].created as Obj[])[0].name;
    assert.ok(typeof gname === "string" && gname.length > 1 && gname !== "Lower Maracenda", gname);
    for (let k = 0; k < 3; k++) await undo();
    assert.equal((await rivers(6))[6].name, "Maracenda");
  });

  test("refusals: merge mid-course, split at the source or far away, non-tributary, two changes to one river", async () => {
    let e = await refused([{ ref: 7, set: { merge: true } }]);
    assert.equal(e.code, "REFUSED");
    assert.match(e.message, /mid-course/);
    assert.match(e.message, /mainStem: 7/);
    e = await refused([{ ref: 6, set: { split: { at: 7262 } } }]);
    assert.match(e.message, /source/);
    e = await refused([{ ref: 6, set: { split: { at: { x: 10, y: 10 } } } }]);
    assert.match(e.message, /px from/);
    e = await refused([{ ref: 6, set: { mainStem: 97 } }]);
    assert.match(e.message, /not a tributary/);
    e = await refused([{ ref: 6, set: { mainStem: 28 } }]);
    assert.match(e.message, /not a tributary/);
    e = await refused([
      { ref: 4, set: { split: { at: 5935 } } },
      { ref: 4, set: { mainStem: 97 } }
    ]);
    assert.match(e.message, /already restructured/);
    e = await refused([{ ref: 4, set: { split: { at: 5935 }, mainStem: 97 } }]);
    assert.equal(e.code, "BAD_ARGS");
    e = await refused([{ ref: 4, set: { merge: "yes" } }]);
    assert.equal(e.code, "BAD_ARGS");
  });

  test("reroute a stretch: cells.r and cells.fl move with the river", async () => {
    const out = await edit([{ ref: 6, set: { reroute: { cells: [6799, 6677, 6802] } } }]);
    assert.match(JSON.stringify(out.notes), /rerouted \(stretch\): 1 cells left, 1 cells joined/);
    const v = (
      await h.ok("eval", {
        readOnly: true,
        code: `const C = pack.cells; const x = pack.rivers.find(r => r.i === 6);
               return { cells: x.cells, r: [C.r[6800], C.r[6677]], fl: [C.fl[6800], C.fl[6677], C.fl[6799]], prec: grid.cells.prec[C.g[6800]] };`
      })
    ).value as Obj;
    assert.deepEqual(v.cells.slice(4, 8), [6916, 6799, 6677, 6802]);
    assert.deepEqual(v.r, [0, 6]);
    assert.equal(v.fl[0], v.prec, "the abandoned cell keeps only its rain (as Rivers.remove does)");
    assert.ok(v.fl[1] > v.fl[2], "the new cell carries the river's flux");
    assert.deepEqual(await invariants(), []);
    await undo();
  });

  test("reroute past a confluence: tributaries reconnect; a climb is a warning", async () => {
    const out = await edit([{ ref: 6, set: { reroute: { cells: [6800, 6677, 6678, 6679] } } }]);
    const notes = JSON.stringify(out.notes);
    assert.match(notes, /Grenburg \(95\) now joins at cell 6679/);
    assert.match(notes, /Dottinfel \(96\) now joins Grenburg \(95\) at cell 6802/);
    assert.match(notes, /warning: the new course of Maracenda \(6\) climbs/);
    const r = await rivers(95, 96);
    assert.deepEqual(r[95].cells.slice(-2), [6802, 6679]);
    assert.equal(r[96].parent, 95);
    assert.deepEqual(await invariants(), []);
    await undo();
  });

  test("reroute ends: a new mouth, a new confluence (root becomes a tributary), a new source", async () => {
    // new mouth into another sea cell
    await edit([{ ref: 6, set: { reroute: { cells: [5952, 5833] } } }]);
    assert.equal((await rivers(6))[6].cells.at(-1), 5833);
    assert.deepEqual(await invariants(), []);
    await undo();
    // Maracenda's lower course into river 781: it becomes a tributary, its basin follows
    const r0 = await rivers(781);
    const out = await edit([{ ref: 6, set: { reroute: { cells: [6069, 5951] } } }]);
    assert.match(JSON.stringify(out.notes), /now a tributary of river 781/);
    const r = await rivers(6, 7, 28, 781);
    assert.equal(r[6].parent, 781);
    assert.equal(r[6].widthFactor, 1, "a tributary gets the default width factor");
    assert.deepEqual([r[6].basin, r[7].basin, r[28].basin], [r0[781].basin, r0[781].basin, r0[781].basin]);
    assert.ok(r[781].discharge > r0[781].discharge, "river 781 now carries Maracenda's water");
    assert.deepEqual(await invariants(), []);
    await undo();
    // Honing gets a new source above its old one (uphill: a warning, not a refusal)
    const up = await edit([{ ref: 97, set: { reroute: { cells: [6424, 6423] } } }]);
    assert.match(JSON.stringify(up.notes), /rerouted \(upper\)/);
    assert.equal((await rivers(97))[97].source, 6424);
    assert.deepEqual(await invariants(), []);
    await undo();
  });

  test("reroute {from, to, through} finds a path; crossings, gaps and upstream order are refused", async () => {
    const out = await edit([
      { ref: 6, set: { reroute: { from: { cell: 6799 }, to: { cell: 6679 }, through: [{ cell: 6677 }] } } }
    ]);
    const x = (await rivers(6))[6];
    const k = x.cells.indexOf(6799);
    assert.ok(
      k >= 0 && x.cells.indexOf(6677) > k && x.cells.indexOf(6679) > x.cells.indexOf(6677),
      JSON.stringify(x.cells)
    );
    assert.equal(x.cells.includes(6800), false);
    assert.deepEqual(await invariants(), []);
    assert.ok(out.applied);
    await undo();
    let e = await refused([{ ref: 6, set: { reroute: { cells: [6916, 6917, 6799] } } }]);
    assert.match(e.message, /cannot cross another river/);
    e = await refused([{ ref: 6, set: { reroute: { cells: [6799, 6802] } } }]);
    assert.match(e.message, /not neighbours/);
    e = await refused([{ ref: 6, set: { reroute: { cells: [6802, 6800] } } }]);
    assert.match(e.message, /upstream/);
    e = await refused([{ ref: 6, set: { reroute: { cells: [6799, 6798, 6676] } } }]);
    assert.match(e.message, /loop/);
    e = await refused([{ ref: 6, set: { reroute: { cells: [7262] } } }]);
    assert.equal(e.code, "BAD_ARGS");
  });

  test("sketch replay: literal resolved forms, created river ids remapped, a repeated mainStem conflicts", async () => {
    // someone else's copies: one with an extra river (so the sketch's split gets another id),
    // one where the same mainStem was already applied
    await h.ok("edit", { type: "river", ops: [{ ref: 846, set: { split: { at: 6025, name: "Theirs" } } }] });
    const shifted = (await h.ok("save_map", { path: "rivers-shifted.map", overwrite: true })).path as string;
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("edit", { type: "river", ops: [{ ref: 6, set: { mainStem: 7 } }] });
    const swapped = (await h.ok("save_map", { path: "rivers-swapped.map", overwrite: true })).path as string;
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });

    await h.ok("sketch", { action: "start", slug: "t-rivers" });
    const s = await edit([{ ref: 4, set: { split: { at: 5935, name: { generate: { base } } } } }]);
    const made = ((s.applied as Obj[])[0].created as Obj[])[0];
    assert.equal(made.i, maxId + 1);
    await edit([{ ref: made.i, set: { type: "Creek", name: "Sketch Creek" } }]);
    await edit([{ ref: 6, set: { mainStem: 7 } }]);
    await edit([{ ref: 6, set: { reroute: { from: { cell: 6069 }, to: { cell: 5833 } } } }]);
    const full = await h.ok("sketch", { action: "status", full: true });
    const recs = full.records as Obj[];
    assert.equal(recs.length, 4);
    const split = recs[0].resolved;
    assert.deepEqual(split.ops[0].set.split, { at: { cell: 5935 }, name: made.name, type: "River" });
    assert.deepEqual(split.ops[0].created, [{ type: "river", i: made.i }]);
    assert.match(String(split.graph), /^\d+:\w+$/, "a structural river edit records the cell graph");
    assert.match(recs[0].summary, new RegExp(`created river ${made.i}`));
    assert.equal(recs[2].resolved.ops[0].set.mainStem, 7);
    assert.deepEqual(recs[3].resolved.ops[0].set.reroute.cells.at(-1), 5833);
    assert.equal(recs[1].resolved.graph, undefined, "a plain name/type edit records no graph");

    const ok = await h.ok("sketch", { action: "rebase", onto: { path: shifted } }, 240_000);
    assert.equal(ok.completed, true, JSON.stringify(ok.conflicts));
    assert.deepEqual(ok.applied, [1, 2, 3, 4]);
    const idMap = ok.idMap as Record<string, Record<string, number>>;
    const mapped = idMap.river[String(made.i)];
    assert.equal(mapped, maxId + 2, "their river took the id; the sketch's split got the next one");
    const v = (
      await h.ok("eval", {
        readOnly: true,
        args: { mapped, theirs: maxId + 1 },
        code: `const R = i => pack.rivers.find(r => r.i === i);
               return { mine: [R(args.mapped).name, R(args.mapped).type, R(args.mapped).parent], theirs: R(args.theirs).name,
                        six: R(6).source, mouth: R(6).cells.at(-1) };`
      })
    ).value as Obj;
    assert.deepEqual(v.mine, ["Sketch Creek", "Creek", 4]);
    assert.equal(v.theirs, "Theirs", "their river survives");
    assert.deepEqual([v.six, v.mouth], [6910, 5833]);
    assert.deepEqual(await invariants(), []);

    // onto the copy where Maracenda's main stem was already swapped: replaying the swap would
    // swap it back, so the changed source is a conflict
    const st = await h.ok("sketch", { action: "rebase", onto: { path: swapped }, onConflict: "skip" }, 240_000);
    const c = (st.conflicts as Obj[]).find(x => x.seq === 3);
    assert.ok(c, JSON.stringify(st.conflicts));
    assert.match(c.reason, /source 7262 -> 6910/);
  });
});
