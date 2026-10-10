// Terrain rebuilds that keep the rivers: set_heights / paint_cells height rebuild:'risk' with
// rivers:'retrace' (the default on a map with rivers) re-trace each river onto the new heights
// (bridge-ext/rivertrace.js, shared with regrid) instead of regenerating them. Ids, names,
// types, parents, basins, main stems and hand edits (mainStem, reroute, name) survive; climbs
// the change causes are carved; a river under water is removed and named; the op replays to
// the same map. On tests/fixtures/demo.map, and on the builder's real map (polish-final.map of
// the primordial-soup steward, copied; skipped when that file is absent) with a change crossing
// height 20 near the Spire and Ballantine.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { bridgeArgs } from "../src/replay.ts";
import "../src/tools/terrain.ts";
import { alive, DEMO_MAP, errorBody, type Harness, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

const POLISH = "/Users/mgm1/Desktop/primordial-soup/map/build/polish";
const REAL_MAP = `${POLISH}/polish-final.map`;
/** The v7 map the builder regridded to 50K, and the set_heights call that regenerated every river there. */
const V7_MAP = `${POLISH}/v7-backup.map`;
const V7_HEIGHTS = `${POLISH}/sh.json`;

/** Every river by id: name, type, parent, basin, tributaries, course points; plus gaps, loops and the climbing ids. */
const RIVERS = `
  const C = pack.cells;
  const kids = {};
  for (const r of pack.rivers) if (r.parent && r.parent !== r.i) (kids[r.parent] ||= []).push(r.i);
  let gaps = 0, loops = 0;
  const rows = {};
  for (const r of pack.rivers) {
    const cs = r.cells, seen = new Set();
    for (let k = 1; k < cs.length; k++) if (cs[k - 1] >= 0 && cs[k] >= 0 && !C.c[cs[k - 1]].includes(cs[k])) gaps++;
    for (const c of cs) { if (c >= 0 && seen.has(c)) loops++; seen.add(c); }
    rows[r.i] = { name: r.name, type: r.type, parent: r.parent, basin: r.basin,
      kids: (kids[r.i] || []).sort((a, b) => a - b),
      course: cs.filter(c => c >= 0).map(c => [C.p[c][0], C.p[c][1]]),
      onLand: cs.filter(c => c >= 0 && C.h[c] >= 20).length };
  }
  return { rows, gaps, loops, climbing: __tupaia.riverTrace.climbing(), spacing: grid.spacing };`;

/** Share of the points of `a` that have a point of `b` within `tol` px. */
function follows(a: number[][], b: number[][], tol: number): number {
  if (!a.length) return 1;
  let n = 0;
  for (const p of a) if (b.some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) <= tol)) n++;
  return n / a.length;
}

/** The cell arrays (heights, biomes, rivers, owners) and the river entities. */
const DIGEST = "const d = __tupaia.fns.digest(); return { cells: d.cells, river: d.types.river };";

const IDENT = ["name", "type", "parent", "basin", "kids"] as const;

/** Rivers of `after` whose identity fields differ from `before` (ids in both; tributaries that are gone are not counted). */
function identityDiffs(before: Obj, after: Obj): string[] {
  const out: string[] = [];
  const live = (ids: number[]) => ids.filter(i => after.rows[i]);
  for (const [id, r] of Object.entries(after.rows as Obj)) {
    const b = before.rows[id];
    if (!b) continue;
    for (const k of IDENT)
      if (JSON.stringify(k === "kids" ? live(b[k]) : b[k]) !== JSON.stringify(r[k]))
        out.push(`${id} ${b.name} ${k}: ${JSON.stringify(b[k])} -> ${JSON.stringify(r[k])}`);
  }
  return out;
}

describe("riverkeep replay forms (no browser)", () => {
  test("a set_heights risk op logged before rivers:'retrace' replays as 'regenerate'; a new one replays as logged", () => {
    const base = {
      changes: "AAAA",
      changed: 2,
      cells: 3,
      gridDigest: "g",
      baseDigest: "b",
      heightsDigest: "h",
      graphAfter: "5:z"
    };
    const old = bridgeArgs("set_heights", {
      ...base,
      options: { rebuild: "risk", erosion: false, keepHeights: true, biomes: "redefine" }
    } as never);
    assert.equal(old.rivers, "regenerate");
    const now = bridgeArgs("set_heights", {
      ...base,
      options: { rebuild: "risk", erosion: false, keepHeights: true, biomes: "redefine", rivers: "retrace" }
    } as never);
    assert.equal(now.rivers, "retrace");
    const keep = bridgeArgs("set_heights", {
      ...base,
      options: { rebuild: "keep", erosion: false, keepHeights: true, biomes: "redefine" }
    } as never);
    assert.equal(keep.rivers, undefined, "a keep op without rivers replays as before (bridge default 'keep')");
  });

  test("a paint_cells risk op logged before height.rivers replays as it ran then ('grid', or 'regenerate' with erosion)", () => {
    const op = (height: Obj) => ({ select: { cells: [1, 2] }, set: { height }, graphAfter: "g" });
    const set = (a: Obj) => (a.set as Obj).height as Obj;
    assert.equal(set(bridgeArgs("paint_cells", op({ delta: 4, rebuild: "risk" }) as never)).rivers, "grid");
    assert.equal(
      set(bridgeArgs("paint_cells", op({ delta: 4, rebuild: "risk", erosion: true }) as never)).rivers,
      "regenerate"
    );
    assert.equal(
      set(bridgeArgs("paint_cells", op({ delta: 4, rebuild: "risk", rivers: "retrace" }) as never)).rivers,
      "retrace"
    );
    assert.equal(set(bridgeArgs("paint_cells", op({ delta: 4 }) as never)).rivers, undefined);
  });
});

describe("terrain rebuild keeps the rivers (demo.map)", () => {
  let h: Harness;
  let base = "";
  let pts: number[][] = [];
  let edits: Obj = {};
  const ev = async (code: string, args?: unknown) => (await h.ok("eval", { readOnly: true, code, args })).value as any;
  const digest = () => ev("return __tupaia.fns.digest().hash");

  /** The change: a river's patch flooded (8), a lake beside the edited river (12), one of its middle cells raised. */
  let change: number[] = [];

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    await h.ok("load_map", { path: DEMO_MAP });
    // hand edits first: a main stem swap, a rename and a rerouted stretch
    edits = await ev(`
      const C = pack.cells, R = pack.rivers;
      const onRiver = new Set(); for (const r of R) for (const c of r.cells) if (c >= 0) onRiver.add(c);
      const land = c => c >= 0 && C.h[c] >= 20;
      const isMain = r => !r.parent || r.parent === r.i;
      let main = null, trib = null;
      for (const r of R.filter(r => isMain(r) && r.cells.length >= 20).sort((a, b) => b.cells.length - a.cells.length)) {
        const t = R.find(t => t.parent === r.i && t.i !== r.i && t.cells.length >= 6 &&
          (j => j > 3 && j < r.cells.length - 4)(r.cells.indexOf(t.cells.at(-1))));
        if (t) { main = r.i; trib = t.i; break; }
      }
      let q = null;
      for (const r of R) {
        if (r.i === main || r.i === trib || r.cells.length < 8) continue;
        const cs = r.cells;
        for (let k = 2; k + 4 < cs.length; k++) {
          const a = cs[k], b = cs[k + 2];
          if (!land(a) || !land(b)) continue;
          const x = C.c[a].find(x => C.c[b].includes(x) && x !== cs[k + 1] && !onRiver.has(x) && land(x) && C.h[x] <= Math.max(C.h[a], C.h[b]) + 2);
          if (x !== undefined) { q = { i: r.i, cells: [a, x, b], x: C.p[x] }; break; }
        }
        if (q) break;
      }
      return { main, trib, q };`);
    assert.ok(edits.main && edits.trib && edits.q, JSON.stringify(edits));
    await h.ok("edit", {
      type: "river",
      ops: [
        { ref: edits.main, set: { mainStem: edits.trib } },
        { ref: edits.main, set: { name: "Keepsake" } },
        { ref: edits.q.i, set: { reroute: { cells: edits.q.cells } } }
      ]
    });
    base = (await h.ok("save_map", { path: path.join(h.env.TUPAIA_OUT, "riverkeep-base.map"), overwrite: true }))
      .path as string;
    pts = await ev("return grid.points");
    const heights = (await ev("return Array.from(grid.cells.h)")) as number[];
    const spots = await ev(
      `
      const C = pack.cells, R = pack.rivers, sp = grid.spacing;
      const onRiver = new Set(); for (const r of R) for (const c of r.cells) if (c >= 0) onRiver.add(c);
      // a short river alone in its patch (no burg; no other river but the one it flows into,
      // which keeps some of its course): flooded, it is gone
      let flood = null;
      for (const f of R) {
        const cs = f.cells.filter(c => c >= 0);
        if (cs.length < 3 || cs.length > 6 || !cs.every(c => C.h[c] >= 25)) continue;
        const p = cs.map(c => C.p[c]);
        const cx = p.reduce((s, q) => s + q[0], 0) / p.length, cy = p.reduce((s, q) => s + q[1], 0) / p.length;
        const rad = Math.max(...p.map(q => Math.hypot(q[0] - cx, q[1] - cy))) + 1.2 * sp;
        const near = c => Math.hypot(C.p[c][0] - cx, C.p[c][1] - cy) < rad;
        if ([...C.i].some(i => C.burg[i] && near(i))) continue;
        if (R.some(g => g.i !== f.i && g.i !== f.parent && g.cells.some(c => c >= 0 && near(c)))) continue;
        const into = R.find(g => g.i === f.parent && g.i !== f.i);
        if (into && into.cells.filter(c => c >= 0 && !near(c)).length < 3) continue;
        flood = { i: f.i, name: f.name, x: cx, y: cy, r: rad };
        break;
      }
      // a lake dug beside the edited main river (land off every river, no burg)
      const m = R.find(r => r.i === args.main);
      const cs = m.cells.filter(c => c >= 0);
      let lake = null;
      for (let k = Math.floor(cs.length / 3); k < cs.length && !lake; k++)
        for (const c of C.c[cs[k]]) for (const d of C.c[c]) {
          if (lake || onRiver.has(d) || C.burg[d] || C.h[d] < 25) continue;
          const off = Math.min(...[...onRiver].map(o => Math.hypot(C.p[o][0] - C.p[d][0], C.p[o][1] - C.p[d][1])));
          if (off >= 1.5 * sp) lake = { x: C.p[d][0], y: C.p[d][1] };
        }
      // a middle land cell of its course raised (the river would climb there)
      const mid = cs.slice(3, -3).find(c => C.h[c] >= 22 && C.h[c] <= 80);
      return { flood, lake, raise: { x: C.p[mid][0], y: C.p[mid][1], h: C.h[mid] } };`,
      edits
    );
    assert.ok(spots.flood && spots.lake && spots.raise, JSON.stringify(spots));
    edits.spots = spots;
    const sp = (await ev("return grid.spacing")) as number;
    change = heights.map((v, i) => {
      const [x, y] = pts[i];
      if (Math.hypot(x - spots.flood.x, y - spots.flood.y) < spots.flood.r) return 8;
      if (Math.hypot(x - spots.lake.x, y - spots.lake.y) < 0.6 * sp) return 12;
      if (Math.hypot(x - spots.raise.x, y - spots.raise.y) < 0.5) return Math.min(100, v + 15);
      return v;
    });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("bad combinations are refused before anything changes", async () => {
    const d0 = await digest();
    const bad = [
      [{ grid: change, rivers: "retrace", erosion: true }, /erosion cuts the beds of regenerated rivers/],
      [{ grid: change, rebuild: "keep", rivers: "retrace" }, /rivers:'retrace' goes with rebuild:'risk'/],
      [{ grid: change, rivers: "keep" }, /rivers:'keep' goes with rebuild:'keep'/]
    ] as const;
    for (const [args, re] of bad) {
      const r = await h.call("set_heights", args as Obj, 240_000);
      assert.equal(r.isError, true);
      assert.match(errorBody(r).error.message, re);
    }
    const p = await h.call("paint_cells", {
      select: { circle: { at: { x: 500, y: 400 }, radius: 20 } },
      set: { height: { delta: 4, rebuild: "risk", rivers: "retrace", erosion: true } }
    });
    assert.match(errorBody(p).error.message, /erosion cuts the beds of regenerated rivers/);
    const k = await h.call("paint_cells", {
      select: { circle: { at: { x: 500, y: 400 }, radius: 20 } },
      set: { height: { delta: 4, rivers: "retrace" } }
    });
    assert.match(errorBody(k).error.message, /height.rivers goes with rebuild:'risk'/);
    assert.equal(await digest(), d0);
  });

  test("dryRun: rivers default to 'retrace' on a map with rivers and name the river the change puts under water", async () => {
    const d = await h.ok("set_heights", { grid: change, dryRun: true }, 240_000);
    assert.equal((d.options as Obj).rivers, "retrace");
    const rv = d.rivers as Obj;
    const f = edits.spots.flood;
    assert.ok((rv.underWater as string[]).includes(`${f.name} (${f.i})`), JSON.stringify(rv));
    assert.match(rv.effect, /re-traced on apply/);
  });

  test("set_heights rebuild:'risk' keeps ids, names, types, parents, main stems and hand edits; carves the climb it made; removes and names the drowned river; one undo", async () => {
    const d0 = await digest();
    const b = await ev(RIVERS);
    const r = await h.ok("set_heights", { grid: change }, 240_000);
    assert.equal(r.cellsRenumbered, true);
    assert.equal((r.options as Obj).rivers, "retrace");
    const rv = r.rivers as Obj;
    const f = edits.spots.flood;
    assert.deepEqual(rv.underWater, [`${f.name} (${f.i})`], JSON.stringify(rv));
    assert.equal(rv.before, Object.keys(b.rows).length);
    assert.ok(rv.unchanged > 0 && rv.retraced > 0, JSON.stringify(rv));
    assert.equal(rv.unchanged + rv.retraced + (rv.notRetraced?.length ?? 0) + 1, rv.before, JSON.stringify(rv));
    assert.ok(rv.carved?.cells >= 1, `the raised course cell is carved: ${JSON.stringify(rv)}`);
    const notes = JSON.stringify(r.notes);
    assert.match(notes, /rivers whose course is under water now were removed: /);
    assert.ok(notes.includes(`${f.name} (${f.i})`));
    const a = await ev(RIVERS);
    // every other river: same id, name, type, parent, basin and tributaries
    assert.deepEqual(
      Object.keys(a.rows).sort(),
      Object.keys(b.rows)
        .filter(id => Number(id) !== f.i)
        .sort()
    );
    assert.deepEqual(identityDiffs(b, a), []);
    assert.equal(a.gaps, 0, "every course is contiguous");
    assert.equal(a.loops, 0);
    // the hand-edited main stem (Keepsake: its tributary's old upper course) is where it was
    const sp = b.spacing as number;
    const kb = b.rows[edits.main];
    const ka = a.rows[edits.main];
    assert.equal(ka.name, "Keepsake");
    assert.ok(Math.hypot(ka.course[0][0] - kb.course[0][0], ka.course[0][1] - kb.course[0][1]) <= sp, "same source");
    assert.ok(follows(kb.course, ka.course, 1.5 * sp) >= 0.95, "the course follows the edited one");
    assert.ok(follows(ka.course, kb.course, 1.5 * sp) >= 0.95, "and nowhere else");
    assert.ok(!a.climbing.includes(edits.main), "the climb the raised cell made was carved");
    // the rerouted stretch still runs through the cell the reroute chose
    const q = a.rows[edits.q.i];
    assert.ok(q.course.some((p: number[]) => Math.hypot(p[0] - edits.q.x[0], p[1] - edits.q.x[1]) < 0.5 * sp));
    // rivers off the change keep their course exactly
    const untouched = Object.keys(a.rows).filter(
      id => JSON.stringify(a.rows[id].course) === JSON.stringify(b.rows[id].course)
    );
    assert.ok(untouched.length >= rv.unchanged * 0.9, `${untouched.length} of ${rv.unchanged}`);
    // nothing climbs that did not climb before
    const newClimbs = (a.climbing as number[]).filter(id => !b.climbing.includes(id));
    assert.deepEqual(newClimbs, []);
    await h.ok("snapshot", { action: "undo" }, 240_000);
    assert.equal(await digest(), d0);
  });

  test("rivers:'regenerate' still regenerates them (ids carried by course overlap only)", async () => {
    const d0 = await digest();
    const r = await h.ok("set_heights", { grid: change, rivers: "regenerate" }, 240_000);
    const rv = r.rivers as Obj;
    assert.ok(typeof rv.kept === "number" && typeof rv.new === "number", JSON.stringify(rv));
    assert.match(JSON.stringify(r.notes), /rivers were regenerated/);
    await h.ok("snapshot", { action: "undo" }, 240_000);
    assert.equal(await digest(), d0);
  });

  test("paint_cells height rebuild:'risk' re-traces too (default), logs rivers:'retrace'; 'regenerate' on request", async () => {
    await h.ok("load_map", { path: base });
    const d0 = await digest();
    const b = await ev(RIVERS);
    const at = { x: edits.spots.raise.x, y: edits.spots.raise.y };
    await h.ok("sketch", { action: "start", slug: "t-riverkeep-paint" });
    const p = await h.ok(
      "paint_cells",
      { select: { circle: { at, radius: 30 } }, set: { height: { delta: 8, rebuild: "risk" } } },
      240_000
    );
    const ph = (p.set as Obj).height as Obj;
    assert.ok(ph.rivers?.retraced > 0 && ph.rivers?.unchanged > 0, JSON.stringify(ph.rivers));
    assert.match(JSON.stringify(p.notes), /re-traced along their old lines/);
    const a = await ev(RIVERS);
    assert.deepEqual(Object.keys(a.rows).sort(), Object.keys(b.rows).sort());
    assert.deepEqual(identityDiffs(b, a), []);
    assert.equal(a.gaps, 0);
    const s = await h.ok("sketch", { action: "status", full: true });
    const rec = (s.records as Obj[])[0];
    assert.equal(rec.replayable, true, rec.reason);
    assert.equal(rec.resolved.set.height.rivers, "retrace", "the resolved form names the river mode");
    await h.ok("sketch", { action: "stop" });
    await h.ok("load_map", { path: base });
    const g = await h.ok(
      "paint_cells",
      { select: { circle: { at, radius: 30 } }, set: { height: { delta: 8, rebuild: "risk", rivers: "regenerate" } } },
      240_000
    );
    const gh = (g.set as Obj).height as Obj;
    assert.ok(typeof gh.rivers?.kept === "number", JSON.stringify(gh.rivers));
    assert.match(JSON.stringify(g.notes), /rivers were regenerated/);
    await h.ok("load_map", { path: base });
    assert.equal(await digest(), d0);
  });

  test("replay: the retrace ops rebase onto the same base to the same heights, rivers and cells", async () => {
    await h.ok("load_map", { path: base });
    await h.ok("sketch", { action: "start", slug: "t-riverkeep" });
    const r = await h.ok("set_heights", { grid: change }, 240_000);
    assert.ok(((r.rivers as Obj).carved?.cells ?? 0) >= 1, "the op carved (its log holds the traced heights)");
    await h.ok(
      "paint_cells",
      {
        select: { circle: { at: { x: edits.spots.lake.x, y: edits.spots.lake.y }, radius: 25 } },
        set: { height: { delta: -20, rebuild: "risk" } }
      },
      240_000
    );
    const want = await ev(DIGEST);
    const wantRivers = await ev(RIVERS);
    const s = await h.ok("sketch", { action: "status", full: true });
    assert.equal(s.blobOnly, false, JSON.stringify(s.blobOnlyReasons));
    const reb = await h.ok("sketch", { action: "rebase", onto: { path: base } }, 400_000);
    assert.equal(reb.completed, true, JSON.stringify(reb.conflicts));
    assert.deepEqual(reb.applied, [1, 2]);
    assert.ok(!JSON.stringify(reb.notes ?? []).includes("another cell graph"), JSON.stringify(reb.notes));
    assert.deepEqual(await ev(DIGEST), want);
    assert.deepEqual(await ev(RIVERS), wantRivers, "the same rivers, cell for cell");
    await h.ok("sketch", { action: "stop" });
  });
});

describe("the builder's map: a change crossing 20 near the Spire and Ballantine", {
  skip: !fs.existsSync(REAL_MAP)
}, () => {
  let h: Harness;
  const ev = async (code: string, args?: unknown) => (await h.ok("eval", { readOnly: true, code, args })).value as any;

  before(async () => {
    h = await startServer();
    const copy = path.join(h.env.TUPAIA_OUT, "polish-final.map");
    fs.copyFileSync(REAL_MAP, copy);
    await h.ok("load_map", { path: copy }, 240_000);
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("set_heights {pack} rebuild:'risk': every river keeps its id, name, type, parent, basin and tributaries; the Spire and Ballantine keep their main stems", async () => {
    const b = await ev(RIVERS);
    // the coast pushed out at the Spire's mouth (sea -> 24), a lake dug beside the Spire's and
    // beside Ballantine's lower course (land -> 12), and a cell on Ballantine's course sunk (15)
    const ch = await ev(`
      const C = pack.cells, R = pack.rivers, sp = grid.spacing;
      const S = R.find(r => r.name === 'Spire'), B = R.find(r => r.name === 'Ballantine');
      const onRiver = new Set(); for (const r of R) for (const c of r.cells) if (c >= 0) onRiver.add(c);
      const d = (i, x, y) => Math.hypot(C.p[i][0] - x, C.p[i][1] - y);
      const out = {};
      const [mx, my] = C.p[S.cells.at(-1)];
      for (const i of C.i) if (C.h[i] < 20 && d(i, mx, my) < 3 * sp) out[i] = 24;
      const beside = r => {
        const cs = r.cells.filter(c => c >= 0);
        for (let k = Math.floor(cs.length / 2); k < cs.length; k++) {
          const [x, y] = C.p[cs[k]];
          for (const i of C.i) {
            if (C.h[i] < 25 || onRiver.has(i) || C.burg[i]) continue;
            const dd = d(i, x, y);
            if (dd < 4 * sp || dd > 6 * sp) continue;
            let m = Infinity; for (const j of onRiver) m = Math.min(m, d(j, C.p[i][0], C.p[i][1]));
            if (m >= 3 * sp) return i;
          }
        }
        return -1;
      };
      const lakes = [beside(S), beside(B)];
      for (const c of lakes) if (c >= 0) for (const i of C.i) if (d(i, ...C.p[c]) < 1.6 * sp && !onRiver.has(i) && !C.burg[i]) out[i] = 12;
      out[B.cells[Math.floor(B.cells.length / 2)]] = 15;
      return { pack: out, spire: S.i, ballantine: B.i, southern: B.parent, lakes };`);
    assert.ok(
      ch.lakes.every((c: number) => c >= 0),
      JSON.stringify(ch.lakes)
    );
    const r = await h.ok("set_heights", { pack: ch.pack }, 300_000);
    assert.ok((r.toLand as number) > 0 && (r.toWater as number) > 0, "the change crosses height 20 both ways");
    assert.equal((r.options as Obj).rivers, "retrace");
    const rv = r.rivers as Obj;
    assert.equal(rv.retraced + rv.unchanged, rv.before, JSON.stringify(rv));
    assert.equal(rv.underWater, undefined);
    const a = await ev(RIVERS);
    assert.deepEqual(Object.keys(a.rows).sort(), Object.keys(b.rows).sort(), "no river gone, none new");
    assert.deepEqual(identityDiffs(b, a), []);
    assert.equal(a.gaps, 0);
    assert.equal(a.loops, 0);
    const sp = b.spacing as number;
    for (const id of [ch.spire, ch.ballantine]) {
      const [x, y] = [b.rows[id], a.rows[id]];
      assert.ok(
        Math.hypot(y.course[0][0] - x.course[0][0], y.course[0][1] - x.course[0][1]) <= sp,
        `${x.name}: same source`
      );
      // its main stem: the old course (but the mouth the new coast moves) is still its course
      assert.ok(follows(x.course.slice(0, -3), y.course, 1.5 * sp) >= 0.97, `${x.name} keeps its course`);
    }
    assert.equal(a.rows[ch.spire].parent, ch.spire, "the Spire is still a main river");
    assert.equal(a.rows[ch.ballantine].parent, ch.southern, "Ballantine still flows into its parent");
    const last = a.rows[ch.ballantine].course.at(-1);
    assert.ok(
      a.rows[ch.southern].course.some((p: number[]) => p[0] === last[0] && p[1] === last[1]),
      "Ballantine ends on its parent's course"
    );
    assert.equal(a.rows[ch.spire].kids.length, b.rows[ch.spire].kids.length);
    const newClimbs = (a.climbing as number[]).filter(id => !b.climbing.includes(id));
    assert.deepEqual(newClimbs, []);
  });
});

describe("the builder's own call: set_heights sh.json on v7 regridded to 50K", {
  skip: !(fs.existsSync(V7_MAP) && fs.existsSync(V7_HEIGHTS))
}, () => {
  let h: Harness;
  const ev = async (code: string, args?: unknown) => (await h.ok("eval", { readOnly: true, code, args })).value as any;

  before(async () => {
    h = await startServer();
    const copy = path.join(h.env.TUPAIA_OUT, "v7-backup.map");
    fs.copyFileSync(V7_MAP, copy);
    await h.ok("load_map", { path: copy }, 240_000);
    await h.ok("regrid", { density: 50000 }, 400_000);
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("its rebuild:'risk' (143 cells crossing 20, which regenerated ~450 rivers) now keeps all 270, the Spire a main river and Ballantine whole", async () => {
    const b = await ev(RIVERS);
    const args = JSON.parse(fs.readFileSync(V7_HEIGHTS, "utf8")) as Obj;
    assert.equal(args.rebuild, "risk");
    assert.equal(args.rivers, undefined, "the builder passed no rivers option");
    const r = await h.ok("set_heights", args, 300_000);
    assert.equal((r.toLand as number) + (r.toWater as number), 143);
    assert.equal((r.options as Obj).rivers, "retrace");
    const rv = r.rivers as Obj;
    assert.equal(rv.before, 270);
    assert.equal(rv.unchanged + rv.retraced, 270, JSON.stringify(rv));
    const a = await ev(RIVERS);
    assert.deepEqual(Object.keys(a.rows).sort(), Object.keys(b.rows).sort());
    assert.deepEqual(identityDiffs(b, a), []);
    assert.equal(a.gaps, 0);
    assert.equal(a.loops, 0);
    assert.deepEqual(a.climbing, [], "climbs the new heights made were carved");
    const id = (name: string) => Number(Object.keys(a.rows).find(k => a.rows[k].name === name));
    const sp = b.spacing as number;
    const spire = id("Spire");
    const ball = id("Ballantine");
    assert.equal(a.rows[spire].parent, spire, "the Spire is still a main river");
    assert.ok(follows(b.rows[spire].course.slice(0, -3), a.rows[spire].course, 1.5 * sp) >= 0.97);
    assert.ok(follows(b.rows[ball].course, a.rows[ball].course, 1.5 * sp) >= 0.97, "Ballantine is not a stub");
    assert.equal(a.rows[ball].parent, b.rows[ball].parent);
  });
});
