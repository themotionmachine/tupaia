// Cross-track tests for the rebuild family (regen, biomes, relief, terrain, regrid), one or more
// per merge hazard:
// - one replay slot for 'regenerate' (regen-replay.ts): relief alone, and a mix of biomes,
//   provinces/emblems and relief, logged as literal outcomes, replay; single families keep
//   their own op names; any other part stays blob-only;
// - every FNS.regenerate wrapper follows the phased protocol (validate changes nothing);
// - the sketch and regenerate descriptions say which regenerate replays, within 2048 chars;
// - relief exclusions survive a set_heights risk rebuild and move to the new cells on regrid;
//   regrid keeps the reliefOnLoad settings;
// - a biome icon edit points at regenerate {parts:['relief']}, which redraws it (and a
//   reliefOnLoad map redraws at once);
// - paint_cells: feather stays biome-only, and a height rebuild:'risk' paint plus a feathered
//   biome paint replay onto the same base to the same cells.
// Against tests/fixtures/demo.map, local mode only.
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import {
  NOT_REPLAYABLE,
  REPLAY_EXT,
  Rewriter,
  registerReplayable,
  rewriteResolved,
  unreplayableReason
} from "../src/ops.ts";
import { REGEN_OP } from "../src/regen.ts";
import { combinedFamilies, REGENERATE_REPLAY } from "../src/regen-replay.ts";
import { bridgeArgs } from "../src/replay.ts";
import { BIOMES_OP } from "../src/tools/biomes.ts";
import "../src/tools/generate.ts";
import { alive, DEMO_MAP, errorBody, type Harness, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

/** The pack cell of each relief icon (the cell whose polygon holds its centre; findCell alone can miss). */
const CELLS_OF_ICONS = `const owner = (x, y) => {
  const c = findCell(x, y);
  if (d3.polygonContains(getPackPolygon(c), [x, y])) return c;
  return pack.cells.c[c].find(n => d3.polygonContains(getPackPolygon(n), [x, y])) ?? c;
};
const centres = [...document.querySelectorAll("#terrain use")].map(u => {
  const s = +u.getAttribute("width");
  return owner(+u.getAttribute("x") + s / 2, +u.getAttribute("y") + s / 2);
});`;

const literal = {
  parts: ["provinces", "emblems"],
  graph: "9:abc",
  provinces: {
    states: [30],
    replaced: [],
    created: [{ i: 210, state: 30, center: 40, burg: 0, name: "B", coa: {}, runs: [40, 2] }]
  },
  emblems: { states: [{ i: 30, coa: {} }], provinces: [], burgs: [] }
};
const biomes = { cells: { "13": [5, 6] }, graph: "9:abc", seed: 3 };
const relief = { parts: ["relief"], relief: { density: 0.6 }, base: { density: 1 } };
const combined = {
  parts: ["biomes", "provinces", "emblems", "relief"],
  combined: true,
  graph: "9:abc",
  biomes,
  literal,
  relief
};

describe("one replay slot for regenerate (pure)", () => {
  test("the slot holds the dispatcher; biomes and provinces/emblems alone keep their own ops", () => {
    assert.equal(REPLAY_EXT.regenerate, REGENERATE_REPLAY);
    assert.ok(REPLAY_EXT[REGEN_OP] && REPLAY_EXT[BIOMES_OP]);
    assert.throws(() => registerReplayable("regenerate", { bridgeFn: "x" }), /already has a replay spec/);
  });

  test("which calls are combined: two or more families of replayable parts and nothing else", () => {
    assert.deepEqual(combinedFamilies(["relief", "biomes"]), ["biomes", "relief"]);
    assert.deepEqual(combinedFamilies(["emblems", "provinces", "biomes"]), ["biomes", "literal"]);
    assert.equal(combinedFamilies(["provinces", "emblems"]), null, "one family keeps its own op");
    assert.equal(combinedFamilies(["biomes"]), null);
    assert.equal(combinedFamilies(["biomes", "relief", "states"]), null, "a random part: not combined");
  });

  test("replayable only when every part has its literal form", () => {
    assert.equal(unreplayableReason("regenerate", combined as never), null);
    assert.equal(unreplayableReason("regenerate", relief as never), null, "relief alone, as before");
    const noRelief = { ...combined, relief: undefined };
    assert.match(String(unreplayableReason("regenerate", noRelief as never)), /no relief part/);
    const badBiomes = { ...combined, biomes: { graph: "x" } };
    assert.match(String(unreplayableReason("regenerate", badBiomes as never)), /no literal cell list/);
    const random = { ...combined, parts: ["biomes", "relief", "zones"] };
    assert.equal(unreplayableReason("regenerate", random as never), NOT_REPLAYABLE.regenerate);
    assert.equal(unreplayableReason("regenerate", literal as never), NOT_REPLAYABLE.regenerate);
    assert.equal(unreplayableReason("regenerate", null), NOT_REPLAYABLE.regenerate);
  });

  test("bridge args: one form per family, in the order the parts ran; relief alone goes the same way", () => {
    const a = bridgeArgs("regenerate", combined as never) as Obj;
    assert.equal(REGENERATE_REPLAY.bridgeFn, "regenerateReplay");
    assert.deepEqual(
      a.forms.map((f: Obj) => [f.key, f.fn]),
      [
        ["biomes", "setBiomeCells"],
        ["literal", "regenerateLiteral"],
        ["relief", "regenerate"]
      ]
    );
    assert.deepEqual(a.forms[0].args, { cells: { "13": [5, 6] }, seed: 3 });
    assert.deepEqual(a.forms[2].args, { parts: ["relief"], relief: { density: 0.6 }, base: { density: 1 } });
    const r = bridgeArgs("regenerate", relief as never) as Obj;
    assert.deepEqual(r.forms, [{ key: "relief", fn: "regenerate", args: a.forms[2].args }]);
  });

  test("rewrite maps each part's sketch-made ids; created and focus come from provinces", () => {
    const rw = new Rewriter({ biome: { "13": 14 }, state: { "30": 31 } }, new Set(["biome:13", "state:30"]));
    const out = rewriteResolved("regenerate", structuredClone(combined) as never, rw) as unknown as Obj;
    assert.deepEqual(out.biomes.cells, { "14": [5, 6] });
    assert.deepEqual(out.literal.provinces.states, [31]);
    assert.deepEqual(out.literal.provinces.fresh, [31], "a state the sketch made is fresh");
    assert.deepEqual(out.relief, relief);
    assert.deepEqual(REGENERATE_REPLAY.created?.(combined as never), [[{ type: "province", i: 210 }]]);
    assert.equal(REGENERATE_REPLAY.focus?.(combined as never)[0].type, "state");
    const s = REGENERATE_REPLAY.summarize?.(combined as never, null, { parts: combined.parts }) ?? "";
    assert.match(
      s,
      /^Regenerated biomes .*; Gave state \(30\) 1 new province \(B\); new emblems .*; Regenerated relief icons: density 0\.6\.$/
    );
  });
});

describe("tupaia-mcp rebuild family: regenerate in a sketch", () => {
  let h: Harness;
  let copy = "";
  let S = 0;
  const ev = async (code: string, args?: unknown) => (await h.ok("eval", { readOnly: true, code, args })).value as any;
  /** What the combined regenerate changed: biomes, the state's province cells and coats of arms, relief. */
  const SNAP = `const C = pack.cells, S = args;
const el = document.getElementById("terrain");
const html = el.innerHTML;
let hash = 0;
for (let k = 0; k < html.length; k++) hash = (Math.imul(hash, 31) + html.charCodeAt(k)) | 0;
const attrs = {};
for (const a of el.attributes) if (a.name.startsWith("data-")) attrs[a.name] = a.value;
const provs = pack.provinces.filter(p => p && p.i && !p.removed && p.state === S);
return {
  biome: Array.from(C.biome).join(","),
  provinces: provs.map(p => [p.name, C.i.filter(c => C.province[c] === p.i).length, JSON.stringify(p.coa)]).sort(),
  stateCoa: JSON.stringify(pack.states[S].coa),
  icons: el.childElementCount, hash, attrs
};`;
  const ARGS = (s: number) => ({
    parts: ["relief", "emblems", "biomes", "provinces"],
    biomes: { noise: 0.5, seed: 4 },
    provinces: { states: [s], count: 2 },
    emblems: { states: [s] },
    relief: { density: 0.6, seed: "fam-a" }
  });

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    await h.ok("load_map", { path: DEMO_MAP });
    S = await ev(
      "const C = pack.cells; const n = {}; for (const c of C.i) if (C.state[c]) n[C.state[c]] = (n[C.state[c]] || 0) + 1; return +Object.entries(n).filter(([s]) => !pack.states[s].lock).sort((a, b) => b[1] - a[1])[0][0];"
    );
    // someone else's copy: an unrelated rename
    await h.ok("eval", {
      code: `pack.burgs.find(b => b && b.i && !b.removed && !b.capital).name = "Famton"; return 1;`
    });
    copy = (await h.ok("save_map", { path: path.join(h.env.TUPAIA_OUT, "fam-a-other.map"), overwrite: true }))
      .path as string;
    await h.ok("load_map", { path: DEMO_MAP });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("tool descriptions: regenerate within 2048 chars; sketch and regenerate say which regenerate replays", async () => {
    const { tools } = await h.client.listTools();
    const regen = tools.find(t => t.name === "regenerate");
    const sketch = tools.find(t => t.name === "sketch");
    assert.ok(regen && sketch);
    assert.ok((regen.description ?? "").length <= 2048, `regenerate: ${regen.description?.length}`);
    assert.match(regen.description ?? "", /only biomes, provinces, emblems and\/or relief replays/);
    assert.match(
      sketch.description ?? "",
      /regenerate \(unless its parts are only replayable ones: provinces\/emblems, biomes, relief\)/
    );
    const props = (regen.inputSchema as Obj).properties;
    for (const k of ["biomes", "provinces", "emblems", "relief", "dryRun"])
      assert.ok(String(props[k]?.description ?? "").length > 40, `${k} option keeps its detail`);
  });

  test("FNS.regenerate validates a mixed call through every wrapper and changes nothing", async () => {
    const out = await h.ok("eval", {
      code: `const d0 = __tupaia.fns.digest().hash;
const t0 = document.getElementById("terrain").outerHTML;
const v = await __tupaia.fns.regenerate({ ...args, parts: [...args.parts, "zones"], phase: "validate" });
return { v, same: __tupaia.fns.digest().hash === d0, terrain: document.getElementById("terrain").outerHTML === t0 };`,
      args: ARGS(S)
    });
    const r = out.value as Obj;
    assert.deepEqual(r.v, { phase: "validate" });
    assert.equal(r.same, true, "the map is unchanged");
    assert.equal(r.terrain, true, "the relief settings and icons are unchanged");
    const bad = await h.call("eval", {
      code: `return await __tupaia.fns.regenerate({ parts: ["provinces", "relief"], provinces: { states: [args] }, relief: { density: 9 }, phase: "validate" });`,
      args: S
    });
    assert.ok(bad.isError, "a bad relief option fails validation");
    assert.match(errorBody(bad).error.message, /density/);
  });

  test("biomes + provinces + emblems + relief: one replayable op that rebases to the same map", async () => {
    await h.ok("load_map", { path: DEMO_MAP });
    await h.ok("sketch", { action: "start", slug: "t-fam-a" });
    await h.ok("display", { on: ["relief"] });
    const out = await h.ok("regenerate", ARGS(S), 240_000);
    assert.deepEqual(out.ran, ["biomes", "provinces", "emblems", "relief"]);
    assert.equal(out.resolved, undefined, "no literal form reaches the client");
    assert.equal(out.reliefResolved, undefined);
    assert.equal((out.details as Obj).biomes.resolved, undefined);
    assert.ok((out.details as Obj).biomes.changed > 0);
    assert.equal((out.provinces as Obj).created, 2);
    const st = await h.ok("sketch", { action: "status", full: true });
    assert.equal(st.blobOnly, false, JSON.stringify(st.blobOnlyReasons));
    const rec = (st.records as Obj[])[1];
    assert.equal(rec.tool, "regenerate");
    assert.equal(rec.resolved.combined, true);
    assert.deepEqual(rec.resolved.parts, ["biomes", "provinces", "emblems", "relief"]);
    assert.ok(rec.resolved.biomes.cells && rec.resolved.literal.provinces && rec.resolved.relief.relief);
    assert.match(
      rec.summary,
      /^Regenerated biomes .*seed 4.*; (Replaced \d+ provinces? of|Gave) .*2 new.*; Regenerated relief icons: .*density 0\.6/
    );
    const mine = await ev(SNAP, S);

    // a random part in the mix: blob-only, with that part named; undo takes it out
    await h.ok("regenerate", { parts: ["relief", "biomes", "zones"] }, 240_000);
    const blob = await h.ok("sketch", { action: "status" });
    assert.equal(blob.blobOnly, true);
    assert.match(JSON.stringify(blob.blobOnlyReasons), /regenerate re-runs random generators/);
    await h.ok("snapshot", { action: "undo" });
    assert.equal((await h.ok("sketch", { action: "status" })).blobOnly, false);

    const r = await h.ok("sketch", { action: "rebase", onto: { path: copy } }, 300_000);
    assert.equal(r.completed, true, JSON.stringify(r.conflicts));
    assert.deepEqual(r.applied, [1, 2]);
    const replayed = await ev(SNAP, S);
    assert.equal(replayed.biome, mine.biome, "the same biomes");
    assert.deepEqual(replayed.provinces, mine.provinces, "the same provinces, cells and coats of arms");
    assert.equal(replayed.stateCoa, mine.stateCoa);
    assert.deepEqual(replayed.attrs, mine.attrs, "the same relief settings");
    assert.equal(replayed.hash, mine.hash, "the same relief icons (drawn after the biomes)");
    assert.equal(await ev(`pack.burgs.some(b => b && b.name === "Famton")`), true, "their edit survives");
    const log = (await h.ok("sketch", { action: "status" })).log as Obj[];
    assert.match(log[1].summary, /^Regenerated biomes .*; (Replaced|Gave) .*; Regenerated relief icons/);
    await h.ok("sketch", { action: "stop" });
  });

  test("a mix of a replayable part with a random one names the random one; biomes + provinces dryRun is refused", async () => {
    await h.ok("load_map", { path: DEMO_MAP });
    await h.ok("sketch", { action: "start", slug: "t-fam-a-2" });
    await h.ok("regenerate", { parts: ["provinces", "relief", "zones"], provinces: { states: [S] } }, 240_000);
    const st = await h.ok("sketch", { action: "status" });
    assert.equal(st.blobOnly, true);
    assert.match(JSON.stringify(st.blobOnlyReasons), /regenerate zones re-runs random generators/);
    await h.ok("sketch", { action: "stop" });
    const d = await h.call("regenerate", { parts: ["biomes", "provinces"], dryRun: true });
    assert.ok(d.isError);
    assert.match(errorBody(d).error.message, /dryRun works with parts provinces and\/or emblems only/);
  });
});

describe("tupaia-mcp rebuild family: relief settings across terrain and regrid; biome icons", () => {
  let h: Harness;
  let at = { x: 0, y: 0 };
  const R = 60;
  const ev = async (code: string, args?: unknown) => (await h.ok("eval", { readOnly: true, code, args })).value as any;
  /** Excluded pack cells: how many, how far the farthest is from the circle, and the share of cells well inside it. */
  const EXCL = `const R = __tupaia.relief, C = pack.cells, { x, y, r } = args;
const text = R.exclusionText();
const ex = text ? R.excludedCells(text) : new Set();
const spacing = Math.sqrt((graphWidth * graphHeight) / C.i.length);
let far = 0, inner = 0, innerEx = 0;
for (const c of C.i) {
  const d = Math.hypot(C.p[c][0] - x, C.p[c][1] - y);
  if (ex.has(c)) far = Math.max(far, d - r);
  if (d < 0.7 * r) { inner++; if (ex.has(c)) innerEx++; }
}
return { n: ex.size, far: far / spacing, inner: inner ? innerEx / inner : 1, stale: !!(text && R.exclusionInfo(text).stale) };`;
  /** Icons drawn in excluded cells (by the cell whose polygon holds each icon's centre). */
  const ICONS_IN = `${CELLS_OF_ICONS}
const R = __tupaia.relief;
const ex = R.excludedCells(R.exclusionText() || "");
return { n: centres.length, inEx: centres.filter(c => ex.has(c)).length };`;

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    await h.ok("load_map", { path: DEMO_MAP });
    at = await ev(
      "const b = pack.burgs.filter(b => b && b.i && !b.removed && b.capital).sort((a, b) => b.population - a.population)[0]; return { x: b.x, y: b.y };"
    );
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("an exclusion survives a set_heights risk rebuild and moves to the new cells on regrid; reliefOnLoad and the seed stay", async () => {
    await h.ok("display", { on: ["relief"] });
    await h.ok("regenerate", {
      parts: ["relief"],
      relief: { seed: "fam", density: 0.8, exclude: { circle: { at, radius: R } } }
    });
    await h.ok("edit", { type: "map", ops: [{ set: { reliefOnLoad: true } }] });
    const e0 = await ev(EXCL, { ...at, r: R });
    assert.ok(e0.n > 5 && e0.inner === 1 && e0.far < 1.5, JSON.stringify(e0));

    // a risk rebuild renumbers the pack cells; the exclusion is keyed by grid cell and survives
    const heights = await ev("return Array.from(grid.cells.h)");
    const sh = await h.ok("set_heights", { grid: heights }, 240_000);
    assert.equal(sh.cellsRenumbered !== undefined, true);
    const e1 = await ev(EXCL, { ...at, r: R });
    assert.equal(e1.stale, false);
    assert.ok(Math.abs(e1.n - e0.n) <= Math.max(2, e0.n * 0.1), JSON.stringify({ e0, e1 }));
    assert.ok(e1.inner > 0.95 && e1.far < 1.5, JSON.stringify(e1));
    assert.equal((await ev(ICONS_IN)).inEx, 0, "no icons in the excluded cells after the rebuild");

    // a regrid makes a new grid: the exclusion is moved to its cells, not left stale
    const rg = await h.ok("regrid", { density: 20000 }, 300_000);
    assert.ok(rg.reliefExclusion, JSON.stringify(rg.regenerated));
    assert.equal((rg.reliefExclusion as Obj).before, e1.n);
    assert.match(JSON.stringify(rg.regenerated), /relief icon exclusion moved to the new cells/);
    assert.match(JSON.stringify(rg.regenerated), /drawn as a load would, not kept/);
    const e2 = await ev(EXCL, { ...at, r: R });
    assert.equal(e2.stale, false);
    assert.equal(e2.n, (rg.reliefExclusion as Obj).after);
    assert.ok(e2.n > e1.n * 1.3, JSON.stringify({ e1, e2 }));
    assert.ok(e2.inner > 0.95 && e2.far < 2, JSON.stringify(e2));
    const info = (await h.ok("map_info", { since: "none" })).relief as Obj;
    assert.equal(info.onLoad, true, "reliefOnLoad is kept");
    assert.equal(info.seed, "fam");
    assert.equal(info.density, 0.8);
    assert.equal(info.exclude.stale, undefined, JSON.stringify(info.exclude));
    // a reliefOnLoad map is redrawn after the regrid, as a load would: none in the exclusion
    const icons = await ev(ICONS_IN);
    assert.ok(icons.n > 0);
    assert.equal(icons.inEx, 0);
  });

  test("a biome icon edit points at regenerate {parts:['relief']}, which redraws it; a reliefOnLoad map redraws at once", async () => {
    await h.ok("load_map", { path: DEMO_MAP });
    await h.ok("display", { on: ["relief"] });
    await h.ok("regenerate", { parts: ["relief"], relief: { seed: "b" } });
    // biome icons only: cells of height 50+ draw hill/mountain icons whatever their biome
    const BIOME_ICONS = `${CELLS_OF_ICONS}
const C = pack.cells, n = {};
for (const c of centres) if (C.h[c] < 50) n[C.biome[c]] = (n[C.biome[c]] || 0) + 1;
return n;`;
    const n0 = (await ev(BIOME_ICONS)) as Record<string, number>;
    // the biome with the most icons that are not hill/mountain icons (those depend on height)
    const b = +Object.entries(n0)
      .filter(([k]) => +k !== 0)
      .sort((x, y) => y[1] - x[1])[0][0];
    const dens = await ev("return biomesData.iconsDensity[args]", b);
    assert.ok(dens > 0);
    const ed = await h.ok("edit", { type: "biome", ops: [{ ref: b, set: { iconsDensity: 0 } }] });
    const note = JSON.stringify(ed.notes);
    assert.match(note, /regenerate \{parts:\['relief'\]\} redraws them/);
    assert.match(note, /icons on the map now are unchanged/);
    assert.equal(((await ev(BIOME_ICONS)) as Obj)[b], n0[b], "unchanged until the redraw");
    await h.ok("regenerate", { parts: ["relief"] });
    const n1 = (await ev(BIOME_ICONS)) as Obj;
    assert.ok((n1[b] ?? 0) < n0[b] * 0.5, JSON.stringify({ before: n0[b], after: n1[b] }));

    // reliefOnLoad: the edit is drawn at once (the page shows what a load draws)
    await h.ok("edit", { type: "map", ops: [{ set: { reliefOnLoad: true } }] });
    const back = await h.ok("edit", { type: "biome", ops: [{ ref: b, set: { iconsDensity: dens } }] });
    const notes = JSON.stringify(back.notes);
    assert.match(notes, /drawn now: this map draws its relief icons on load/);
    assert.match(notes, /relief icons redrawn \(\d+\)/);
    const n2 = (await ev(BIOME_ICONS)) as Obj;
    assert.ok(n2[b] > n0[b] * 0.8, JSON.stringify({ before: n0[b], after: n2[b] }));
  });
});

describe("tupaia-mcp rebuild family: paint_cells height risk and feather", () => {
  let h: Harness;
  let base = "";
  const ev = async (code: string, args?: unknown) => (await h.ok("eval", { readOnly: true, code, args })).value as any;

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    await h.ok("load_map", { path: DEMO_MAP });
    base = (await h.ok("save_map", { path: path.join(h.env.TUPAIA_OUT, "fam-a-base.map"), overwrite: true }))
      .path as string;
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("feather is biome-only; a risk height paint then a feathered biome paint replay to the same cells", async () => {
    const at = await ev(
      "const C = pack.cells; const c = C.i.find(c => C.h[c] >= 30 && C.h[c] < 50 && C.c[c].every(n => C.h[n] >= 25)); return { x: C.p[c][0], y: C.p[c][1] };"
    );
    const both = await h.call("paint_cells", {
      select: { circle: { at, radius: 30 } },
      set: { height: { delta: 5, rebuild: "risk" }, biome: "Wetland" },
      feather: { width: 20 }
    });
    assert.ok(both.isError);
    assert.equal(errorBody(both).error.code, "BAD_ARGS");

    await h.ok("sketch", { action: "start", slug: "t-fam-a-paint" });
    await h.ok(
      "paint_cells",
      { select: { circle: { at, radius: 40 } }, set: { height: { delta: 6, rebuild: "risk" } } },
      240_000
    );
    await h.ok("paint_cells", {
      select: { circle: { at, radius: 60 } },
      set: { biome: "Wetland" },
      feather: { width: 30, seed: 2 }
    });
    const st = await h.ok("sketch", { action: "status", full: true });
    assert.equal(st.blobOnly, false, JSON.stringify(st.blobOnlyReasons));
    const recs = st.records as Obj[];
    assert.equal(typeof recs[0].resolved.graphAfter, "string", "the risk paint records the graph it built");
    assert.equal(recs[1].resolved.graph, recs[0].resolved.graphAfter, "the feathered paint is on that graph");
    const want = await ev("return __tupaia.fns.digest().cells");
    const r = await h.ok("sketch", { action: "rebase", onto: { path: base } }, 400_000);
    assert.equal(r.completed, true, JSON.stringify(r.conflicts));
    assert.deepEqual(r.applied, [1, 2]);
    assert.deepEqual(await ev("return __tupaia.fns.digest().cells"), want, "same heights, cells and biomes");
    await h.ok("sketch", { action: "stop" });
  });
});
