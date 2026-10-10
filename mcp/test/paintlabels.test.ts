// State painting keeps hand-placed state labels and the layers as they were (dx item 6):
//   - paint_cells set:state re-fits only the labels the renderer drew; a label placed by hand
//     (a straight/custom textPath, a dragged transform, or a locked state) keeps its textPath d,
//     font-size, startOffset, transform and its state's pole, and the result lists it as kept;
//   - a hand-placed label whose anchor the paint takes out of its state is re-fitted and reported
//     (set.state.stateLabels.moved and a note);
//   - apply's paint list does the same (one coalesced redraw at the end);
//   - layer buttons are unchanged, and a fill layer whose button is on but which drew nothing (a
//     v7-style file whose #provs group holds only whitespace loads with Provinces on) stays empty;
//     a provinces layer that shows fills is still redrawn.
// Fixture: tests/fixtures/demo.map (state labels are drawn first: the file has none).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import vm from "node:vm";
import { alive, type Harness, MCP_ROOT, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

describe("paint fill redraws (no browser)", () => {
  test("coalesceRedraws marks a layer ifDrawn only when every request for it asked so", () => {
    const ctx = vm.createContext({ console, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(path.join(MCP_ROOT, "src", "bridge.js"), "utf8"), ctx, { filename: "bridge.js" });
    const co = (ctx.__tupaia as Obj).pure.coalesceRedraws;
    const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
    assert.deepEqual(
      plain(
        co([
          { layer: "provinces", ifDrawn: true },
          { layer: "states", ifDrawn: true },
          "states",
          { layer: "stateLabels", ids: [2] }
        ])
      ),
      [{ layer: "states" }, { layer: "provinces", ifDrawn: true }, { layer: "stateLabels", ids: [2] }]
    );
    assert.deepEqual(plain(co([{ layer: "provinces", ifDrawn: true }, "all"])), [{ layer: "all" }]);
  });
});

/** A state A with a neighbour B: B's land cells on A's border away from A's label (to paint into
 * A), and one A border cell X (not a centre or capital) next to B (to paint out of A). */
const PICK = `
const C = pack.cells, S = pack.states;
const free = c => C.h[c] >= 20 && !S.some(s => s && s.center === c) && !(C.burg[c] && pack.burgs[C.burg[c]].capital);
const live = S.filter(s => s && s.i && !s.removed && s.cells > 80).sort((a, b) => b.cells - a.cells);
for (const A of live) {
  for (const b of A.neighbors || []) {
    const B = S[b];
    if (!B || !B.i || B.removed || B.cells < 40) continue;
    const [px, py] = A.pole;
    const into = [];
    const out = [];
    for (const c of C.i) {
      if (!free(c)) continue;
      const [x, y] = C.p[c];
      const far = Math.hypot(x - px, y - py) > 80;
      if (C.state[c] === B.i && far && C.c[c].some(n => C.state[n] === A.i)) into.push(c);
      if (C.state[c] === A.i && far && C.c[c].some(n => C.state[n] === B.i)) out.push(c);
    }
    if (into.length >= 4 && out.length) {
      const x = out[0];
      return { A: A.i, B: B.i, aName: A.name, into: into.slice(0, 6), x, xp: C.p[x], pole: A.pole };
    }
  }
}
return null;`;

const LABELS = `const out = {};
for (const i of args.ids) {
  const el = document.getElementById('stateLabel' + i);
  const tp = el && el.querySelector('textPath');
  out[i] = {
    d: document.getElementById('textPath_stateLabel' + i)?.getAttribute('d') ?? null,
    fs: tp?.getAttribute('font-size') ?? null,
    so: tp?.getAttribute('startOffset') ?? null,
    tr: el?.getAttribute('transform') ?? null,
    pole: pack.states[i].pole
  };
}
return out;`;

const LAYERS = `return {
  on: [...document.querySelectorAll('#mapLayers li:not(.buttonoff)')].map(l => l.id).sort(),
  provPaths: document.querySelectorAll('#provs path').length,
  statePaths: document.querySelectorAll('#statesBody path').length,
  borderPaths: document.querySelectorAll('#borders path').length
};`;

describe("paint keeps hand-placed state labels and layers", () => {
  let h: Harness;
  let pick: Obj;

  const val = async (code: string, args: Obj = {}) => (await h.ok("eval", { readOnly: true, code, args })).value as Obj;
  const run = async (code: string, args: Obj = {}) => (await h.ok("eval", { code, args })).value as Obj;
  const labels = (ids: number[]) => val(LABELS, { ids });
  const layers = () => val(LAYERS);
  const undo = () => h.ok("snapshot", { action: "undo" });
  /** The steward's hand placement: a straight path through (x, y), its own font size. */
  const straighten = (i: number, x: number, y: number) =>
    run(
      `document.getElementById('textPath_stateLabel' + args.i).setAttribute('d', 'M' + (args.x - 60) + ',' + args.y + 'L' + (args.x + 60) + ',' + args.y);
       document.querySelector('#stateLabel' + args.i + ' textPath').setAttribute('font-size', '58%'); return true`,
      { i, x, y }
    );

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "40" });
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    // demo.map carries no state labels: draw them (the renderer's own, unlocked) as the base
    await run("drawStateLabels(); return document.querySelectorAll('#labels #states text').length");
    pick = (await val(PICK)) as Obj;
    assert.ok(pick && pick.into.length >= 4, JSON.stringify(pick));
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("paint_cells set:state keeps a hand-placed label (path, size, pole) and the layers; auto labels are re-fitted", async () => {
    await straighten(pick.A, pick.pole[0], pick.pole[1]);
    const lb = await labels([pick.A, pick.B]);
    const ly = await layers();
    const poles = `return pack.states.map(s => (s && s.i && !s.removed ? s.pole : null))`;
    const pb = (await val(poles)) as unknown as unknown[];
    const r = await h.ok("paint_cells", { select: { cells: pick.into }, set: { state: pick.A } });
    const st = (r.set as Obj).state;
    assert.ok(st.changed > 0, JSON.stringify(r));
    const pa = (await val(poles)) as unknown as unknown[];
    pb.forEach((p, i) => {
      if (i !== pick.B) assert.deepEqual(pa[i], p, `state ${i} keeps its pole (only re-fitted B's moves)`);
    });
    assert.deepEqual(st.stateLabels.kept, [`${pick.aName} (${pick.A})`], JSON.stringify(st.stateLabels));
    assert.ok(st.stateLabels.refit >= 1, "B's renderer-drawn label is re-fitted");
    assert.equal(st.stateLabels.moved, undefined);
    const la = await labels([pick.A, pick.B]);
    assert.deepEqual(la[pick.A], lb[pick.A], "hand-placed label and pole unchanged");
    assert.match(String(la[pick.B].d), /C/, "B keeps a renderer path");
    assert.deepEqual(await layers(), ly, "layer buttons and fills unchanged");
    await undo();
    assert.deepEqual((await labels([pick.A]))[pick.A], lb[pick.A]);
    await undo(); // the straighten eval
  });

  test("a dragged label (transform) and a locked state's label are kept", async () => {
    await run(
      `document.getElementById('stateLabel' + args.i).setAttribute('transform', 'translate(12,-7)'); return true`,
      { i: pick.A }
    );
    await h.ok("edit", { type: "state", ops: [{ ref: pick.B, set: { lock: true } }] });
    const lb = await labels([pick.A, pick.B]);
    const ly = await layers();
    // B's cells into A, then A's border cell X into B: both states are touched twice
    const r1 = await h.ok("paint_cells", { select: { cells: pick.into }, set: { state: pick.A } });
    const r2 = await h.ok("paint_cells", { select: { cells: [pick.x] }, set: { state: pick.B } });
    const kept = [...(r1.set as Obj).state.stateLabels.kept, ...(r2.set as Obj).state.stateLabels.kept];
    assert.ok(kept.includes(`${pick.aName} (${pick.A})`), JSON.stringify(kept));
    assert.ok(
      kept.some(k => k.endsWith(`(${pick.B})`)),
      "the locked state's label is kept"
    );
    const la = await labels([pick.A, pick.B]);
    assert.deepEqual(la, lb, "both labels and poles unchanged");
    assert.deepEqual(await layers(), ly);
    for (let k = 0; k < 4; k++) await undo();
  });

  test("a hand-placed label whose anchor leaves its state is re-fitted and reported", async () => {
    await straighten(pick.A, pick.xp[0], pick.xp[1]);
    const lb = await labels([pick.A]);
    const r = await h.ok("paint_cells", { select: { cells: [pick.x] }, set: { state: pick.B } });
    const st = (r.set as Obj).state;
    assert.equal(st.changed, 1);
    assert.equal(st.stateLabels.moved?.length, 1, JSON.stringify(st.stateLabels));
    assert.equal(st.stateLabels.moved[0].state, `${pick.aName} (${pick.A})`);
    assert.match(st.stateLabels.moved[0].why, /custom path label's anchor left the state/);
    assert.ok(
      (r.notes as string[]).some(n => n.startsWith(`state label of ${pick.aName}`)),
      JSON.stringify(r.notes)
    );
    const la = await labels([pick.A]);
    assert.notEqual(la[pick.A].d, lb[pick.A].d, "re-fitted");
    assert.match(String(la[pick.A].d), /C/);
    await undo();
    await undo();
  });

  test("apply's paint path keeps the hand-placed label and the layers too", async () => {
    await straighten(pick.A, pick.pole[0], pick.pole[1]);
    const lb = await labels([pick.A]);
    const ly = await layers();
    const r = await h.ok("apply", { paint: [{ select: { cells: pick.into }, set: { state: pick.A } }] });
    assert.equal(r.changed, true, JSON.stringify(r));
    assert.deepEqual((await labels([pick.A]))[pick.A], lb[pick.A]);
    assert.deepEqual(await layers(), ly);
    // the anchor case through apply: reported in the notes
    await undo();
    await straighten(pick.A, pick.xp[0], pick.xp[1]);
    const r2 = await h.ok("apply", { paint: [{ select: { cells: [pick.x] }, set: { state: pick.B } }] });
    assert.ok(
      JSON.stringify(r2.notes ?? r2).includes(`state label of ${pick.aName} (${pick.A})`),
      JSON.stringify(r2).slice(0, 2000)
    );
    await undo();
    await undo();
    await undo();
  });

  test("a Provinces layer that is on but empty (whitespace-only #provs) gets no fills; a drawn one is redrawn", async () => {
    await run(`const g = document.getElementById('provs'); g.innerHTML = '\\n    \\n  '; return true`);
    const saved = (await h.ok("save_map", { path: "paintlabels-v7like.map", overwrite: true })).path as string;
    await h.ok("load_map", { path: saved });
    await run("drawStateLabels(); return true");
    const ly = await layers();
    assert.ok(ly.on.includes("toggleProvinces"), "the app turns Provinces on for a whitespace-only group");
    assert.equal(ly.provPaths, 0);
    const r = await h.ok("paint_cells", { select: { cells: pick.into }, set: { state: pick.A } });
    assert.deepEqual(await layers(), ly, "no province fills, no toggles");
    assert.ok((r.skippedHidden as string[]).includes("provinces"), JSON.stringify(r));
    assert.ok((r.notes as string[]).some(n => n.includes("provinces layer is on but drew nothing")));
    await undo();
    const a = await h.ok("apply", { paint: [{ select: { cells: pick.into }, set: { state: pick.A } }] });
    assert.equal(a.changed, true);
    assert.deepEqual(await layers(), ly, "apply: no province fills, no toggles");
    await undo();

    // control: a Provinces layer that shows fills is redrawn after the paint
    await h.ok("display", { off: ["provinces"] });
    await h.ok("display", { on: ["provinces"] });
    const on = await layers();
    assert.ok(on.provPaths > 0);
    const r2 = await h.ok("paint_cells", { select: { cells: pick.into }, set: { state: pick.A } });
    assert.ok((r2.redrawn as string[]).includes("provinces"), JSON.stringify(r2.redrawn));
    const after2 = await layers();
    assert.deepEqual(after2.on, on.on);
    assert.ok(after2.provPaths > 0);
  });
});
