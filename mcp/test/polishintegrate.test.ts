// Cross-track checks for the polish round (dx/polish-integrate): where two tracks touch the same
// map, each keeps its promise.
//   - riverkeep x territory: set_heights rebuild:'risk' re-traces the rivers (ids, names, parents
//     kept, no new climbs), then regrid {territories:'regrow'} on that map keeps the same rivers
//     (contiguous, never climbing) and the territory invariants (burgs, capitals, provinces);
//     a later identity set_heights on the regrown map keeps the rivers, capitals and provinces
//     (a burg off its state or culture only on a coastal twin cell); undo walks back to the start.
//   - condpaint x paintlabels: a state paint selected by where conditions (height range, river
//     distance, all/not) paints only the cells the condition holds for and keeps a hand-placed
//     state label (path, size, pole) and the layers, through paint_cells and apply's paint list.
//   - applyalias x territory paint x condpaint: an apply spec with a burg matched by alias and a
//     state paint entry with an entry-level where; mode 'baseline' records both differences, a
//     re-check is clean; the paint applied alone leaves only a stale baseline item, the
//     condition holds on every painted cell and the hand-placed label stays.
// Local runs on tests/fixtures/demo.map only (no live origin).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { alive, DEMO_MAP, type Harness, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

/** Rivers by id (name, parent), structure (gaps, loops, stale cells.r) and each river's largest climb. */
const RIVERS = `const C = pack.cells;
const live = pack.rivers.filter(r => r && !r.removed);
const byId = new Map(live.map(r => [r.i, r]));
let gaps = 0, loops = 0, stale = 0;
const rise = {};
for (const r of live) {
  const seen = new Set();
  r.cells.forEach((c, k) => {
    if (c < 0) return;
    const p = r.cells[k - 1];
    if (k && p >= 0 && p !== c && !C.c[p].includes(c)) gaps++;
    if (seen.has(c) && p !== c) loops++;
    seen.add(c);
  });
  rise[r.i] = __tupaia.riverTrace.riseOf(r.cells, C.h).max;
}
for (const i of C.i) if (C.r[i] && !byId.get(C.r[i])?.cells.includes(i)) stale++;
return { n: live.length, gaps, loops, stale, rise,
  ids: live.map(r => r.i + ":" + r.name + ":" + r.parent).join("|") };`;

/** Territory invariants: burgs on their state's and culture's cells, capitals inside, provinces inside their states. */
const TERRITORY = `const C = pack.cells, live = x => x && x.i && !x.removed;
let burgState = 0, burgCulture = 0, capitals = 0, provOutside = 0;
// pack cells per grid cell: the re-pack adds twin points along the coast (one grid cell, two pack cells)
const perG = new Map(); for (const c of C.i) perG.set(C.g[c], (perG.get(C.g[c]) || 0) + 1);
const offSingle = [];
for (const b of pack.burgs) {
  if (!live(b)) continue;
  const offS = C.state[b.cell] !== (b.state || 0), offC = C.culture[b.cell] !== (b.culture || 0);
  if (offS) burgState++;
  if (offC) burgCulture++;
  if ((offS || offC) && perG.get(C.g[b.cell]) < 2) offSingle.push(b.name + " (" + b.i + ")");
}
for (const s of pack.states) if (live(s) && live(pack.burgs[s.capital]) && C.state[pack.burgs[s.capital].cell] !== s.i) capitals++;
for (const c of C.i) {
  const p = pack.provinces[C.province[c]];
  if (C.h[c] >= 20 && C.province[c] && live(p) && p.state !== C.state[c]) provOutside++;
}
return { burgState, burgCulture, capitals, provOutside, offSingle };`;

const climbsMore = (b: Obj, a: Obj) =>
  Object.entries(a.rise as Record<string, number>)
    .filter(([id, r]) => r > (b.rise[id] ?? 0))
    .map(([id, r]) => `${id}: ${b.rise[id]} -> ${r}`);

describe("set_heights rivers retrace, then regrid territories regrow, on the same map (demo.map)", () => {
  let h: Harness;
  const ev = async (code: string, args?: unknown) => (await h.ok("eval", { readOnly: true, code, args })).value as any;
  const digest = () => ev("return __tupaia.fns.digest().hash");
  let d0 = "";
  let r0: Obj;
  let sh: Obj;
  let r1: Obj;
  let d1 = "";
  let rg: Obj;

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "10" });
    await h.ok("load_map", { path: DEMO_MAP });
    d0 = await digest();
    r0 = await ev(RIVERS);
    // one middle land cell of the longest main river raised by 15 (in the grid): the re-trace
    // would make it climb there, so it carves
    const raise = await ev(`const C = pack.cells;
      const main = pack.rivers.filter(r => r && !r.removed && (!r.parent || r.parent === r.i))
        .sort((a, b) => b.cells.length - a.cells.length)[0];
      const cs = main.cells.filter(c => c >= 0);
      const mid = cs.slice(3, -3).find(c => C.h[c] >= 22 && C.h[c] <= 80 && !C.burg[c]);
      return { river: main.i, g: C.g[mid] };`);
    const heights = (await ev("return Array.from(grid.cells.h)")) as number[];
    const change = heights.map((v, i) => (i === raise.g ? Math.min(100, v + 15) : v));
    sh = await h.ok("set_heights", { grid: change }, 240_000);
    r1 = await ev(RIVERS);
    d1 = await digest();
    rg = await h.ok("regrid", { density: 20000, territories: "regrow" }, 400_000);
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("set_heights re-traces: every river kept by id, name and parent, none climbs more than before", () => {
    assert.equal((sh.options as Obj).rivers, "retrace");
    const rv = sh.rivers as Obj;
    assert.equal(rv.underWater, undefined, JSON.stringify(rv));
    assert.equal(r1.ids, r0.ids);
    assert.deepEqual(climbsMore(r0, r1), []);
    assert.deepEqual([r1.gaps, r1.loops, r1.stale], [0, 0, 0]);
  });

  test("regrid regrow on the re-traced map: the same rivers, contiguous and never climbing; territory invariants hold", async () => {
    assert.equal((rg.territories as Obj).mode, "regrow");
    for (const f of ["state", "culture", "religion"]) assert.ok((rg.territories as Obj)[f].changed > 0, f);
    assert.equal((rg.rivers as Obj).retraced, r1.n, JSON.stringify(rg.rivers));
    const r2 = await ev(RIVERS);
    assert.equal(r2.ids, r1.ids, "regrid keeps the ids, names and parents the retrace kept");
    assert.deepEqual([r2.gaps, r2.loops, r2.stale], [0, 0, 0]);
    const rl = await h.ok("lint", { checks: ["river-gap", "river-loop", "river-uphill"] });
    assert.deepEqual(rl.counts, {}, JSON.stringify(rl.rows).slice(0, 400));
    assert.deepEqual(await ev(TERRITORY), { burgState: 0, burgCulture: 0, capitals: 0, provOutside: 0, offSingle: [] });
  });

  test("an identity set_heights on the regrown map keeps its rivers and territories; undo walks back to the start", async () => {
    const before2 = await ev(RIVERS);
    const states = await ev(
      "return pack.states.filter(s => s && s.i && !s.removed).map(s => s.i + ':' + s.name).join('|')"
    );
    const r = await h.ok("set_heights", { grid: await ev("return Array.from(grid.cells.h)") }, 300_000);
    const rv = r.rivers as Obj;
    assert.equal(rv.underWater, undefined, JSON.stringify(rv));
    assert.equal(rv.unchanged + rv.retraced, rv.before, JSON.stringify(rv));
    const after2 = await ev(RIVERS);
    assert.equal(after2.ids, before2.ids);
    assert.deepEqual(climbsMore(before2, after2), []);
    assert.equal(
      await ev("return pack.states.filter(s => s && s.i && !s.removed).map(s => s.i + ':' + s.name).join('|')"),
      states
    );
    // capitals and provinces stay inside; a burg can end a cell off its state or culture only on
    // a coastal twin cell (set_heights' carry-over, with either river mode and on demo.map as
    // loaded too: not a regrow effect)
    const t = await ev(TERRITORY);
    assert.deepEqual([t.capitals, t.provOutside, t.offSingle], [0, 0, []], JSON.stringify(t));
    await h.ok("snapshot", { action: "undo" }, 240_000);
    await h.ok("snapshot", { action: "undo" }, 240_000);
    assert.equal(await digest(), d1, "undo of the regrid returns to the re-traced map");
    await h.ok("snapshot", { action: "undo" }, 240_000);
    assert.equal(await digest(), d0, "undo of set_heights returns to demo.map as loaded");
  });
});

/** A state A (with a hand-placed label) and a neighbour B: B's land next to A, away from A's pole. */
const PICK = `
const C = pack.cells, S = pack.states;
const live = S.filter(s => s && s.i && !s.removed && s.cells > 80).sort((a, b) => b.cells - a.cells);
for (const A of live) {
  for (const b of A.neighbors || []) {
    const B = S[b];
    if (!B || !B.i || B.removed || B.cells < 60) continue;
    const [px, py] = A.pole;
    const edge = [];
    for (const c of C.i) {
      if (C.h[c] < 20 || C.state[c] !== B.i || !C.c[c].some(n => C.state[n] === A.i)) continue;
      if (Math.hypot(C.p[c][0] - px, C.p[c][1] - py) > 120) edge.push(c);
    }
    if (edge.length < 6) continue;
    const at = C.p[edge[Math.floor(edge.length / 2)]];
    // the B land within 45 px of that border point: its heights, to cut at the median
    const disc = [...C.i].filter(c => C.h[c] >= 20 && C.state[c] === B.i && Math.hypot(C.p[c][0] - at[0], C.p[c][1] - at[1]) <= 45);
    const hs = disc.map(c => C.h[c]).sort((a, b) => a - b);
    if (disc.length < 12 || hs[0] === hs.at(-1)) continue;
    return { A: A.i, aName: A.name, B: B.i, at: [at[0], at[1]], cut: hs[Math.floor(hs.length / 2)], pole: A.pole };
  }
}
return null;`;

const LABEL = `const el = document.getElementById('stateLabel' + args.i);
const tp = el && el.querySelector('textPath');
return { d: document.getElementById('textPath_stateLabel' + args.i)?.getAttribute('d') ?? null,
  fs: tp?.getAttribute('font-size') ?? null, tr: el?.getAttribute('transform') ?? null,
  tx: el?.textContent ?? null, pole: pack.states[args.i].pole };`;

const LAYERS = `return {
  on: [...document.querySelectorAll('#mapLayers li:not(.buttonoff)')].map(l => l.id).sort(),
  provPaths: document.querySelectorAll('#provs path').length,
  labels: document.querySelectorAll('#labels #states text').length
};`;

/** The cells of the disc: which are A's now, and whether each meets the condition (height <= cut, not a river cell: cells.r, as where.riverDist reads). */
const DISC = `const C = pack.cells;
const rows = [];
for (const c of C.i) {
  if (C.h[c] < 20 || Math.hypot(C.p[c][0] - args.at[0], C.p[c][1] - args.at[1]) > 45) continue;
  rows.push({ c, a: C.state[c] === args.A, b: C.state[c] === args.B, cond: C.h[c] <= args.cut && !C.r[c] });
}
return rows;`;

describe("condition paint of states keeps hand-placed labels; apply alias + baseline with territory paint (demo.map)", () => {
  let h: Harness;
  let pick: Obj;
  let out = "";
  const val = async (code: string, args: Obj = {}) => (await h.ok("eval", { readOnly: true, code, args })).value as any;
  const run = async (code: string, args: Obj = {}) => (await h.ok("eval", { code, args })).value as any;
  const undo = () => h.ok("snapshot", { action: "undo" });
  const label = () => val(LABEL, { i: pick.A });
  const where = () => ({ all: [{ height: { lte: pick.cut } }, { not: { riverDist: { lte: 0 } } }] });
  const disc = () => ({ circle: { at: { x: pick.at[0], y: pick.at[1] }, radius: 45 } });

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    out = fs.realpathSync(h.env.TUPAIA_OUT);
    await h.ok("load_map", { path: DEMO_MAP });
    // demo.map has no state labels: the renderer's own first, then A's placed by hand (a
    // straight path through its pole at its own size), as the steward does
    await run("drawStateLabels(); return true");
    pick = await val(PICK);
    assert.ok(pick, "a state with a neighbour to paint from");
    await run(
      `document.getElementById('textPath_stateLabel' + args.i).setAttribute('d', 'M' + (args.x - 60) + ',' + args.y + 'L' + (args.x + 60) + ',' + args.y);
       document.querySelector('#stateLabel' + args.i + ' textPath').setAttribute('font-size', '58%'); return true`,
      { i: pick.A, x: pick.pole[0], y: pick.pole[1] }
    );
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("paint_cells with where {all:[height, not riverDist]} paints only the matching cells and keeps the hand-placed label and layers", async () => {
    const lb = await label();
    const ly = await val(LAYERS);
    const rows0 = (await val(DISC, pick)) as Obj[];
    const want = rows0.filter(r => r.b && r.cond).length;
    assert.ok(want > 0 && want < rows0.filter(r => r.b).length, "the condition splits B's part of the disc");
    const dry = await h.ok("paint_cells", {
      select: { ...disc(), where: { state: pick.B, ...where() } },
      set: { state: pick.A },
      dryRun: true
    });
    assert.equal((dry.set as Obj).state.stateLabels?.wouldMove, undefined, JSON.stringify(dry.set));
    const r = await h.ok("paint_cells", {
      select: { ...disc(), where: { state: pick.B, ...where() } },
      set: { state: pick.A }
    });
    const st = (r.set as Obj).state;
    const rows = (await val(DISC, pick)) as Obj[];
    // every cell that went to A met the condition; B cells that did not meet it stay B
    const moved = rows.filter((x, k) => rows0[k].b && x.a);
    assert.equal(moved.length, st.changed, JSON.stringify(st));
    assert.ok(moved.length > 0 && moved.length <= want);
    assert.ok(
      moved.every(x => x.cond),
      "only cells the condition holds for are painted"
    );
    assert.ok(
      rows.every((x, k) => !rows0[k].b || rows0[k].cond || x.b),
      "B cells the condition fails on stay B"
    );
    assert.ok(st.stateLabels.kept.includes(`${pick.aName} (${pick.A})`), JSON.stringify(st.stateLabels));
    assert.equal(st.stateLabels.moved, undefined);
    assert.deepEqual(await label(), lb, "the hand-placed label (path, size, pole) is unchanged");
    assert.deepEqual(await val(LAYERS), ly, "no layer toggles, no new labels or fills");
    await undo();
    assert.deepEqual(
      ((await val(DISC, pick)) as Obj[]).map(x => x.b),
      rows0.map(x => x.b)
    );
  });

  test("apply's paint list with an entry where (combined with the select's where) does the same", async () => {
    const lb = await label();
    const ly = await val(LAYERS);
    const rows0 = (await val(DISC, pick)) as Obj[];
    // the entry's where shares no key with the select's: they merge flat; a height range on both
    // sides would be intersected
    const r = await h.ok("apply", {
      paint: [
        {
          select: { ...disc(), where: { state: pick.B, height: { lte: 100 } } },
          where: where(),
          set: { state: pick.A }
        }
      ]
    });
    assert.equal(r.changed, true, JSON.stringify(r.rows));
    const rows = (await val(DISC, pick)) as Obj[];
    const moved = rows.filter((x, k) => rows0[k].b && x.a);
    assert.ok(moved.length > 0 && moved.every(x => x.cond), JSON.stringify(moved));
    assert.deepEqual(await label(), lb);
    assert.deepEqual(await val(LAYERS), ly);
    await undo();
  });

  test("apply: a burg matched by alias and a condition territory paint; baseline, clean re-check, then the paint alone leaves only a stale item", async () => {
    const burg = await val(
      `const C = pack.cells; const b = pack.burgs.find(b => b && b.i && !b.removed && !b.capital && Math.hypot(b.x - args.at[0], b.y - args.at[1]) > 120);
       return { i: b.i, name: b.name, population: b.population };`,
      pick
    );
    const lb = await label();
    const spec = {
      burgs: [{ name: `${burg.name} Prime`, aliases: [burg.name], population: 12345 }],
      paint: [{ select: disc(), where: { state: pick.B, ...where() }, set: { state: pick.A } }]
    };
    const c = await h.ok("apply", { ...spec, mode: "check" });
    const row = (at: string, r: Obj = c) => (r.rows as Obj[]).find(x => x.at === at) as Obj;
    assert.equal(row("burgs[0]").status, "differs", JSON.stringify(c.rows));
    assert.equal(row("burgs[0]").by, `alias '${burg.name}'`);
    assert.equal(row("paint[0]").status, "differs");
    const b = await h.ok("apply", { ...spec, mode: "baseline", writeBaseline: "baselines/mix.json" });
    assert.equal(b.recorded, 2, JSON.stringify(b));
    const items = JSON.parse(fs.readFileSync(path.join(out, "baselines", "mix.json"), "utf8")).items as Obj[];
    assert.ok(
      items.some(it => it.list === "paint" && /^state=/.test(it.key)),
      JSON.stringify(items)
    );
    const clean = await h.ok("apply", { ...spec, mode: "check", baseline: "baselines/mix.json" });
    assert.equal(clean.clean, true, JSON.stringify(clean));
    assert.deepEqual(clean.rows, []);
    assert.equal(clean.baselined, 2);

    // the paint alone, applied: the condition holds on every painted cell, the label stays, the
    // burg is not renamed or duplicated; the re-check reports nothing new, the paint item stale
    const nBurgs = await val("return pack.burgs.filter(b => b && b.i && !b.removed).length");
    const rows0 = (await val(DISC, pick)) as Obj[];
    const u = await h.ok("apply", { paint: spec.paint });
    assert.equal(u.changed, true);
    const rows = (await val(DISC, pick)) as Obj[];
    assert.ok(rows.filter((x, k) => rows0[k].b && x.a).every(x => x.cond));
    assert.deepEqual(await label(), lb);
    const re = await h.ok("apply", { ...spec, mode: "check", baseline: "baselines/mix.json" });
    assert.deepEqual(re.rows, [], JSON.stringify(re));
    assert.equal(re.baselined, 1);
    assert.equal(re.baselineStale, 1, JSON.stringify(re));
    assert.equal(row("paint[0]", await h.ok("apply", { ...spec, mode: "check", verbose: true })).status, "unchanged");
    assert.equal(await val("return pack.burgs.filter(b => b && b.i && !b.removed).length"), nBurgs);
    assert.equal(await val(`return pack.burgs[${burg.i}].name`), burg.name, "an alias match never renames");
    await undo();
  });
});
