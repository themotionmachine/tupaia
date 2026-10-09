// River structure edits (edit river {type, name, mainStem, split, merge, reroute}) on
// tests/fixtures/demo.map, and their sketch replay (rebase {onto:{path}} test hook: no network).
// Rivers used (demo.map):
//   6 Maracenda (root, 18 cells) <- 7 Olsneske joins at cell 6188 (index 12); 95 Grenburg and
//     96 Dottinfel join 6 at 6802, 397 Vathos at 6679 (all above the junction); 28 Nevels and
//     196 Alrosinbach are tributaries of 7.
//   4 Nelbaz (root) <- 97 Honing joins at 5701 (index 14); 19 Sheunfaui joins 4 above it, at
//     6053; 75 and 388 are tributaries of 97.
//   158 Bidesowey crosses lake 3 (cells 408, 407); 439 ends in that lake at cell 482.
//   2 Ngauping crosses lake 40 (cell 7137) between 7024 and 7023; 6904 neighbours both.
//   622 (tributary of 657) ends at 7275, next to the border cell 7393.
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
  mouth: r.mouth, discharge: r.discharge, length: r.length, width: r.width, widthFactor: r.widthFactor,
  sourceWidth: r.sourceWidth, cells: r.cells };
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
  const read = async (code: string, args: Obj = {}): Promise<any> =>
    (await h.ok("eval", { code, args, readOnly: true })).value;
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
    const v = await read(`({ base: nameBases[1].name, maxId: Math.max(...pack.rivers.map(r => r.i)),
                 six: pack.rivers.find(r => r.i === 6).cells.length, seven: pack.rivers.find(r => r.i === 7).cells.at(-1) })`);
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
    assert.match(row.before.mainStem, /^18 cells 7262->5952 #\w+$/, "the course has no river ids");
    assert.match(row.after.mainStem, /^20 cells 6910->5952/);
    assert.match(row.after.mainStem, /becomes river 7 'Olsneske'.*5 tributaries re-parented/);
    const out = await edit([{ ref: 6, set: { mainStem: 7 } }]);
    assert.deepEqual(out.redrawn, ["rivers"]);
    assert.match(JSON.stringify(out.notes), /Olsneske \(7\) now holds Maracenda \(6\)'s old upper course/);
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
    const r0 = await rivers(4);
    await edit([{ ref: "Nelbaz", set: { mainStem: "Honing" } }]);
    const r = await rivers(4, 97, 19, 75, 388);
    assert.deepEqual(r[4].cells.slice(0, 8), [6423, 6303, 6178, 6056, 5939, 5819, 5702, 5701]);
    assert.equal(r[4].cells.at(-1), 3469, "the mouth stays");
    assert.equal(r[4].discharge, r0[4].discharge, "the discharge at the mouth is unchanged");
    assert.equal(r[97].cells.length, 15);
    assert.equal(r[97].cells.at(-1), 5701);
    assert.equal(r[19].parent, 97, "a tributary of the old upper course follows it");
    assert.deepEqual([r[75].parent, r[388].parent], [4, 4]);
    assert.deepEqual(await invariants(), []);
    await undo();
  });

  test("mainStem through a lake: the tributary ends in a lake the river crosses", async () => {
    const lake = `const f = pack.features[3]; return [f.outlet, f.inlets];`;
    const lake0 = await read(lake);
    const dry = await edit([{ ref: 158, set: { mainStem: 439 } }], { dryRun: true });
    assert.match((dry.plan as Obj[])[0].after.mainStem, /through the lake/);
    await edit([{ ref: 158, set: { mainStem: 439 } }]);
    const r = await rivers(158, 439);
    assert.deepEqual(r[158].cells, [558, 557, 482, 407, 336, 334, 265], "the tributary's course, then out of the lake");
    assert.deepEqual(r[439].cells, [413, 412, 338, 410, 408], "the old upper course ends in the lake");
    assert.equal(r[439].parent, 158);
    const [outlet, inlets] = await read(lake);
    assert.equal(outlet, 158);
    assert.ok(inlets.includes(439) && inlets.includes(158), JSON.stringify(inlets));
    assert.deepEqual(await invariants(), []);
    await undo();
    assert.deepEqual(await read(lake), lake0);
  });

  test("split and merge: a new upper river with its own name, and the exact inverse; notes follow", async () => {
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
    // a note on the upper river follows it into the merged river
    await h.ok("add", { type: "note", items: [{ entity: { type: "river", ref: u }, name: "Upper notes" }] });
    // merge it back by name
    const m = await edit([{ ref: "Upper Maracenda", set: { merge: true } }]);
    assert.equal((m.applied as Obj[])[0].after.merge, "merged into the river it continued");
    assert.match(JSON.stringify(m.notes), new RegExp(`note river${u} now belongs to Lower Maracenda \\(6\\)`));
    assert.equal(await read(`notes.find(n => n.id === "river6")?.name ?? null`), "Upper notes");
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
    // a generated name when none is given; a literal name another river has is a warning
    const g = await edit([{ ref: 6, set: { split: { at: { entity: { type: "river", ref: 6 }, at: 0.5 } } } }]);
    const gname = ((g.applied as Obj[])[0].created as Obj[])[0].name;
    assert.ok(typeof gname === "string" && gname.length > 1 && gname !== "Lower Maracenda", gname);
    const dup = await edit([{ ref: 4, set: { split: { at: 5935, name: "Olsneske" } } }]);
    assert.match(JSON.stringify(dup.notes), /warning: another river is also named 'Olsneske'/);
    for (let k = 0; k < 5; k++) await undo();
    assert.equal((await rivers(6))[6].name, "Maracenda");
    assert.equal(await read(`notes.some(n => n.id === "river6")`), false);
  });

  test("a river crossing a lake: the part that crosses it becomes the lake's inlet and outlet", async () => {
    // 72 Hungshun crosses lake 31 (cell 4259) and leaves the map; 32 Yengyuehoi ends in the lake
    const lake = `const f = pack.features[31]; return [f.outlet, f.inlets];`;
    assert.deepEqual(await read(lake), [72, [32, 72]]);
    const s = await edit([{ ref: 72, set: { split: { at: 4258, name: "Lake Reach" } } }]);
    const u = ((s.applied as Obj[])[0].created as Obj[])[0].i;
    assert.deepEqual(await read(lake), [u, [32, u]]);
    const r = await rivers(72, u, 32, 18);
    assert.deepEqual(r[72].cells, [4258, 4257, -1]);
    assert.deepEqual([r[32].parent, r[18].parent], [u, u], "tributaries above the cut follow the upper part");
    assert.deepEqual(await invariants(), []);
    await edit([{ ref: u, set: { merge: true } }]);
    assert.deepEqual(await read(lake), [72, [32, 72]]);
    assert.deepEqual(await invariants(), []);
    await undo();
    await undo();
  });

  test("refusals: merge mid-course, split too near an end or far away, non-tributary, no-op reroute", async () => {
    let e = await refused([{ ref: 7, set: { merge: true } }]);
    assert.equal(e.code, "REFUSED");
    assert.match(e.message, /mid-course/);
    assert.match(e.message, /mainStem: 7/);
    e = await refused([{ ref: 6, set: { split: { at: 7262 } } }]);
    assert.match(e.message, /source/);
    e = await refused([{ ref: 6, set: { split: { at: 5952 } } }]);
    assert.match(e.message, /lower part of 2 cells; each part needs at least 3/);
    e = await refused([{ ref: 6, set: { split: { at: { x: 10, y: 10 } } } }]);
    assert.match(e.message, /px from/);
    e = await refused([{ ref: 6, set: { mainStem: 97 } }]);
    assert.match(e.message, /not a tributary/);
    e = await refused([{ ref: 6, set: { mainStem: 28 } }]);
    assert.match(e.message, /not a tributary/);
    e = await refused([{ ref: 4, set: { split: { at: 5935 }, mainStem: 97 } }]);
    assert.equal(e.code, "BAD_ARGS");
    e = await refused([{ ref: 4, set: { merge: "yes" } }]);
    assert.equal(e.code, "BAD_ARGS");
    e = await refused([{ ref: 6, set: { reroute: { cells: [6799, 6800, 6802] } } }]);
    assert.match(e.message, /already runs through these cells/);
  });

  test("ops of one call apply in order: a reroute through a cell an earlier op frees", async () => {
    // Dottinfel (96) leaves cell 6801 by joining Maracenda one cell higher; Maracenda then runs
    // through 6801 (validated against the map before the call it would cross Dottinfel)
    const ops = [
      { ref: 96, set: { reroute: { cells: [6918, 6800] } } },
      { ref: 6, set: { reroute: { cells: [6800, 6801, 6802] } } }
    ];
    const dry = await edit(ops, { dryRun: true });
    assert.match(
      (dry.plan as Obj[])[1].after.reroute,
      /checked when applied: an earlier op of this call \(reroute of river 96\)/
    );
    const d0 = (await rivers(6))[6].discharge;
    const out = await edit(ops);
    assert.equal((out.applied as Obj[]).length, 2);
    const r = await rivers(6, 96);
    assert.deepEqual(r[96].cells, [7035, 6917, 6918, 6800]);
    assert.deepEqual(r[6].cells.slice(5, 9), [6799, 6800, 6801, 6802]);
    assert.ok(Math.abs(r[6].discharge - d0) < 40, `discharge ${d0} -> ${r[6].discharge}`);
    assert.deepEqual(await invariants(), []);
    await undo();
    // a split, then a mainStem of the same river (its lower part)
    await edit([
      { ref: 4, set: { split: { at: 5935, name: "Upper Nelbaz" } } },
      { ref: 4, set: { mainStem: 97 } }
    ]);
    const n = await rivers(4, 97, maxId + 1);
    assert.equal(n[4].source, 6423);
    assert.deepEqual(n[97].cells, [5935, 5816, 5817, 5700, 5701]);
    assert.equal(n[maxId + 1].parent, 97, "the split-off upper part continues the river now holding 4's old course");
    assert.deepEqual(await invariants(), []);
    await undo();
  });

  test("reroute a stretch: cells.r and cells.fl move with the river", async () => {
    const out = await edit([{ ref: 6, set: { reroute: { cells: [6799, 6677, 6802] } } }]);
    assert.match(
      JSON.stringify(out.notes),
      /rerouted \(stretch\): 1 cells left, 1 cells joined; now 18 cells, discharge \d+ -> \d+/
    );
    const v = await read(`const C = pack.cells; const x = pack.rivers.find(r => r.i === 6);
               return { cells: x.cells, r: [C.r[6800], C.r[6677]], fl: [C.fl[6800], C.fl[6677], C.fl[6799]], prec: grid.cells.prec[C.g[6800]] };`);
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

  test("reroute ends: a new mouth, a new confluence (root -> tributary), the map edge (tributary -> root), a new source", async () => {
    // new mouth into another sea cell
    await edit([{ ref: 6, set: { reroute: { cells: [5952, 5833] } } }]);
    assert.equal((await rivers(6))[6].cells.at(-1), 5833);
    assert.deepEqual(await invariants(), []);
    await undo();
    // Maracenda's lower course into river 781: it becomes a tributary, its basin follows
    const r0 = await rivers(781);
    const out = await edit([{ ref: 6, set: { reroute: { cells: [6069, 5951] } } }]);
    assert.match(JSON.stringify(out.notes), /now a tributary of \S+ \(781\)/);
    const r = await rivers(6, 7, 28, 781);
    assert.equal(r[6].parent, 781);
    assert.equal(r[6].widthFactor, 1, "a tributary gets the map's tributary width factor");
    assert.deepEqual([r[6].basin, r[7].basin, r[28].basin], [r0[781].basin, r0[781].basin, r0[781].basin]);
    assert.ok(r[781].discharge > r0[781].discharge, "river 781 now carries Maracenda's water");
    assert.deepEqual(await invariants(), []);
    await undo();
    // tributary 622 runs off the map edge: a main river, parent = itself (as Rivers.specify sets it)
    const t0 = await rivers(622, 657);
    const e = await edit([{ ref: 622, set: { reroute: { from: { cell: 7275 }, to: "edge" } } }]);
    const t = await rivers(622, 657);
    assert.equal(t[622].cells.at(-1), -1);
    assert.deepEqual([t[622].parent, t[622].basin], [622, 622]);
    assert.equal(t[622].widthFactor, 1.2, "a main river gets the main-stem width factor");
    assert.ok(t[657].discharge < t0[657].discharge, "its old parent lost its water");
    assert.match(JSON.stringify(e.notes), /reaches the map edge on its own: a main river/);
    assert.deepEqual(await invariants(), []);
    await undo();
    // Honing gets a new source above its old one (uphill: a warning, not a refusal)
    const up = await edit([{ ref: 97, set: { reroute: { cells: [6424, 6423] } } }]);
    assert.match(JSON.stringify(up.notes), /rerouted \(upper\)/);
    assert.equal((await rivers(97))[97].source, 6424);
    assert.deepEqual(await invariants(), []);
    await undo();
  });

  test("reroute flux: no double count past a lake or through a cell with stale flux", async () => {
    // around lake 40: the lake keeps draining into 7023; only 6904's own water is new
    const v0 = await read(`const C = pack.cells; return { fl6904: C.fl[6904], fl7023: C.fl[7023] };`);
    const r0 = await rivers(2);
    const out = await edit([{ ref: 2, set: { reroute: { cells: [7024, 6904, 7023] } } }]);
    assert.match(JSON.stringify(out.notes), /lake 40 lost its outlet river 2/);
    assert.match(JSON.stringify(out.notes), /0 cells left \(and the lake 40: the course no longer crosses it\)/);
    const v = await read(
      `const C = pack.cells; return { fl6904: C.fl[6904], fl7023: C.fl[7023], fl7024: C.fl[7024] };`
    );
    const added = v.fl6904 - v.fl7024; // 6904's own drainage
    assert.ok(added >= 0 && added <= v0.fl6904, `own drainage ${added}`);
    assert.equal(v.fl7023 - v0.fl7023, added, "the cell below the lake gains only the new cell's own water");
    assert.equal((await rivers(2))[2].discharge - r0[2].discharge, added);
    assert.deepEqual(await invariants(), []);
    await undo();
    // a hand edit (like the builder's rivfix) moved Maracenda off 6800 and left its flux there;
    // rerouting back through 6800 must not count the river's water twice
    const d0 = (await rivers(6))[6].discharge;
    const hand = await h.ok("eval", {
      code: `const C = pack.cells; const x = pack.rivers.find(r => r.i === 6);
        x.cells.splice(x.cells.indexOf(6800), 1, 6677); C.r[6677] = 6; C.r[6800] = 0; C.fl[6677] = C.fl[6800];
        return C.fl[6799];`
    });
    const fl6799 = hand.value as number;
    await edit([{ ref: 6, set: { reroute: { cells: [6799, 6800, 6802] } } }]);
    const d = (await rivers(6))[6].discharge;
    assert.ok(Math.abs(d - d0) < fl6799 / 4, `discharge ${d0} -> ${d} (river flux at 6799: ${fl6799})`);
    await undo();
    await undo();
    assert.equal((await rivers(6))[6].discharge, d0);
  });

  test("reroute {from, to, through}: snapping is reported, snap:false and the map edge", async () => {
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
    // an end near the course snaps onto it, and says so
    const dry = await edit(
      [{ ref: 6, set: { reroute: { from: { cell: 6677 }, to: { cell: 6679 }, through: [{ cell: 6678 }] } } }],
      { dryRun: true }
    );
    assert.match(
      (dry.plan as Obj[])[0].after.reroute,
      /from \(cell 6677\) snapped to cell \d+ of the course, \d+ px away/
    );
    let e = await refused([{ ref: 6, set: { reroute: { from: { cell: 6802 }, to: { cell: 6677 } } } }]);
    assert.match(e.message, /from \(cell 6802\) is not upstream of to \(cell 6677, snapped to \d+\)/);
    // snap:false: a from off the course is a new source
    const ns = await edit([{ ref: 6, set: { reroute: { from: { cell: 6677 }, to: { cell: 6802 }, snap: false } } }]);
    assert.match(JSON.stringify(ns.notes), /from \(cell 6677\) is off the course: it becomes the new source/);
    assert.equal((await rivers(6))[6].source, 6677);
    assert.deepEqual(await invariants(), []);
    await undo();
    // edge:true runs off the map past a border cell
    e = await refused([{ ref: 622, set: { reroute: { from: { cell: 7275 }, to: { cell: 7393 }, edge: true } } }]);
    assert.match(e.message, /cell 7393\) is on a river/);
    await edit([{ ref: 622, set: { reroute: { from: { cell: 7275 }, to: { cell: 7392 }, edge: true } } }]);
    assert.deepEqual((await rivers(622))[622].cells.slice(-2), [7392, -1]);
    assert.deepEqual(await invariants(), []);
    await undo();
    e = await refused([{ ref: 6, set: { reroute: { cells: [6916, 6917, 6799] } } }]);
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

  test("find and inspect show where a tributary joins and its tributaries", async () => {
    const f = await h.ok("find", { type: "river", name: "Olsneske", fields: ["joinsAt", "tributaries"] });
    assert.deepEqual(
      (f.rows as Obj[]).map(r => [r.joinsAt, r.tributaries]),
      [[6188, 2]]
    );
    const i = await h.ok("inspect", { entity: { type: "river", ref: 6 } });
    const rel = i.relations as Obj;
    assert.equal(rel.joinsAt, null);
    assert.equal(rel.tributaryCount, 5);
    assert.deepEqual(
      (rel.tributaries as Obj[]).find(t => t.i === 7),
      { i: 7, name: "Olsneske", joinsAt: 6188 }
    );
  });

  test("sketch replay: literal resolved forms, created ids remapped, re-cut rivers conflict, renames do not", async () => {
    // someone else's copies: one with an extra river (so the sketch's splits get other ids), one
    // where the same mainStem was already applied, one where Olsneske was split (re-cut)
    await h.ok("edit", { type: "river", ops: [{ ref: 846, set: { split: { at: 6025, name: "Theirs" } } }] });
    const shifted = (await h.ok("save_map", { path: "rivers-shifted.map", overwrite: true })).path as string;
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("edit", { type: "river", ops: [{ ref: 6, set: { mainStem: 7 } }] });
    const swapped = (await h.ok("save_map", { path: "rivers-swapped.map", overwrite: true })).path as string;
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("edit", { type: "river", ops: [{ ref: 7, set: { split: { at: 6670, name: "Upper Olsneske" } } }] });
    const recut = (await h.ok("save_map", { path: "rivers-recut.map", overwrite: true })).path as string;
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });

    await h.ok("sketch", { action: "start", slug: "t-rivers" });
    await edit([{ ref: 7, set: { name: "Olsneske Water" } }]); // 1
    const s = await edit([{ ref: 4, set: { split: { at: 5935, name: { generate: { base } } } } }]); // 2
    const a = ((s.applied as Obj[])[0].created as Obj[])[0];
    assert.equal(a.i, maxId + 1);
    await edit([{ ref: a.i, set: { type: "Creek", name: "Sketch Creek" } }]); // 3
    await edit([{ ref: 6, set: { mainStem: 7 } }]); // 4
    await edit([{ ref: 6, set: { reroute: { from: { cell: 6069 }, to: { cell: 5833 } } } }]); // 5
    const s2 = await edit([{ ref: a.i, set: { split: { at: 6171, name: "Sketch Brook" } } }]); // 6: parent is a.i
    const b = ((s2.applied as Obj[])[0].created as Obj[])[0];
    assert.equal(b.i, maxId + 2);
    await edit([{ ref: b.i, set: { merge: true } }]); // 7
    const full = await h.ok("sketch", { action: "status", full: true });
    const recs = full.records as Obj[];
    assert.equal(recs.length, 7);
    const split = recs[1].resolved;
    assert.deepEqual(split.ops[0].set.split, { at: { cell: 5935 }, name: a.name, type: "River" });
    assert.deepEqual(split.ops[0].created, [{ type: "river", i: a.i }]);
    assert.match(String(split.graph), /^\d+:\w+$/, "a structural river edit records the cell graph");
    assert.match(recs[1].summary, /split at cell 5935: the upper part is a new River ".+"; this river now rises there/);
    assert.match(recs[1].summary, new RegExp(`created river ${a.i}`));
    const ms = recs[3].resolved.ops[0].set.mainStem;
    assert.deepEqual([ms.ref, ms.name, typeof ms.expect], [7, "Olsneske Water", "string"]);
    assert.match(
      recs[3].summary,
      /main stem now follows "Olsneske Water" \(river 7\): rises at cell 6910, 20 cells \(was 7262, 18\); the old upper course is now river 7/
    );
    assert.match(recs[4].summary, /rerouted through \d+ cells \(6069 -> 5833\)/);
    assert.match(recs[6].summary, /merged into the river it continues/);
    assert.deepEqual(recs[4].resolved.ops[0].set.reroute.cells.at(-1), 5833);
    assert.equal(recs[2].resolved.graph, undefined, "a plain name/type edit records no graph");

    // onto the copy where Olsneske was split: the rename still applies (no id check), the swap
    // would give another course, so it conflicts
    const rc = await h.ok("sketch", { action: "rebase", onto: { path: recut } }, 240_000);
    assert.equal(rc.completed, false);
    assert.deepEqual(rc.applied, [1, 2, 3]);
    assert.equal((rc.conflicts as Obj[])[0].seq, 4);
    assert.match((rc.conflicts as Obj[])[0].reason, /recorded as giving Maracenda \(6\) the course/);
    // onto the copy where the swap was already applied: replaying it would swap back, a conflict
    const st = await h.ok("sketch", { action: "rebase", onto: { path: swapped } }, 240_000);
    assert.equal(st.completed, false);
    assert.equal((st.conflicts as Obj[])[0].seq, 4);
    assert.match((st.conflicts as Obj[])[0].reason, /already applied/);

    // onto the shifted copy: everything replays; both created rivers get the next ids, and the
    // merge of a river whose parent the sketch created is no conflict
    const ok = await h.ok("sketch", { action: "rebase", onto: { path: shifted } }, 240_000);
    assert.equal(ok.completed, true, JSON.stringify(ok.conflicts));
    assert.deepEqual(ok.applied, [1, 2, 3, 4, 5, 6, 7]);
    const idMap = ok.idMap as Record<string, Record<string, number>>;
    assert.equal(idMap.river[String(a.i)], maxId + 2, "their river took the id; the sketch's split got the next one");
    assert.equal(idMap.river[String(b.i)], maxId + 3);
    const v = await read(
      `const R = i => pack.rivers.find(r => r.i === i);
       return { mine: [R(args.mapped).name, R(args.mapped).type, R(args.mapped).parent, R(args.mapped).cells.length],
                gone: !!R(args.b), theirs: R(args.theirs).name, six: R(6).source, mouth: R(6).cells.at(-1), seven: R(7).name };`,
      { mapped: maxId + 2, b: maxId + 3, theirs: maxId + 1 }
    );
    assert.deepEqual(v.mine, ["Sketch Creek", "Creek", 4, 11]);
    assert.equal(v.gone, false, "the second split was merged back");
    assert.equal(v.theirs, "Theirs", "their river survives");
    assert.deepEqual([v.six, v.mouth, v.seven], [6910, 5833, "Olsneske Water"]);
    assert.deepEqual(await invariants(), []);
  });
});
