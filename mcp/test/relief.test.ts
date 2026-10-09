// Relief icons (track 'relief'): regenerate {parts:['relief'], relief:{...}} draws seeded icons
// with density / perBiome / minHeight / exclude / nearBurgs, and reliefOnLoad (edit map or
// relief.onLoad) makes every save drop the icons and every load draw the same ones again.
// Against tests/fixtures/demo.map (relief layer off, no icons stored). Local mode, plus the
// shared_save / sketch save paths against the in-process fake Worker.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { FakeWorker } from "./fake-worker.ts";
import { alive, DEMO_MAP, errorBody, type Harness, REPO_ROOT, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

interface TerrainState {
  icons: number;
  hash: number;
  attrs: Record<string, string>;
  on: boolean;
}

const TERRAIN_CODE = `
const el = document.getElementById("terrain");
const html = el.innerHTML;
let hash = 0;
for (let k = 0; k < html.length; k++) hash = (Math.imul(hash, 31) + html.charCodeAt(k)) | 0;
const attrs = {};
for (const a of el.attributes) if (a.name.startsWith("data-")) attrs[a.name] = a.value;
return { icons: el.childElementCount, hash, attrs, on: layerIsOn("toggleRelief") };`;

/**
 * Icon centres with the pack cell whose polygon holds them (the cell that drew the icon; the
 * nearest cell centre is not always it).
 */
const CENTRES = `
const owner = (x, y) => {
  const c = findCell(x, y);
  if (d3.polygonContains(getPackPolygon(c), [x, y])) return c;
  return pack.cells.c[c].find(n => d3.polygonContains(getPackPolygon(n), [x, y])) ?? c;
};
const centres = [...document.querySelectorAll("#terrain use")].map(u => {
  const s = +u.getAttribute("width");
  const x = +u.getAttribute("x") + s / 2, y = +u.getAttribute("y") + s / 2;
  return { href: u.getAttribute("href"), x, y, cell: owner(x, y) };
});`;
const ICONS_CODE = `${CENTRES}\nreturn { cells: centres.map(c => c.cell), hrefs: [...new Set(centres.map(c => c.href))] };`;

const TERRAIN_RE = /<g id="terrain"[^>]*?(\/>|>[\s\S]*?<\/g>)/;

/** Icons per pack cell, and two land pack cells that share a coastal grid cell and both hold icons. */
const COAST_CODE = `${CENTRES}
const C = pack.cells, n = {};
for (const { cell } of centres) n[cell] = (n[cell] || 0) + 1;
const byG = new Map();
for (const c of C.i) { const g = C.g[c]; if (!byG.has(g)) byG.set(g, []); byG.get(g).push(c); }
for (const [g, cs] of byG) if (cs.length === 2 && cs.every(c => C.h[c] >= 20 && n[c] > 0)) return { g, a: cs[0], b: cs[1], na: n[cs[0]], nb: n[cs[1]] };
return null;`;

describe("tupaia-mcp relief icons", () => {
  let h: Harness;
  let mapSeed = "";
  let base: TerrainState;
  let copyPath = "";
  let theirsPath = "";

  const terrain = async () => (await h.ok("eval", { code: TERRAIN_CODE, readOnly: true })).value as TerrainState;
  const icons = async () =>
    (await h.ok("eval", { code: ICONS_CODE, readOnly: true })).value as { cells: number[]; hrefs: string[] };
  const relief = (relief: Obj = {}, extra: Obj = {}) => h.ok("regenerate", { parts: ["relief"], relief, ...extra });

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    // "someone else's" copy for the sketch rebase: an unrelated rename
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("eval", { code: `pack.burgs.find(b => b && b.i && !b.removed).name = "Otherton"; return 1;` });
    copyPath = (await h.ok("save_map", { path: "relief-other.map", overwrite: true })).path as string;
    // "someone else" thinned the relief: a sketch that sets another density conflicts on rebase
    await h.ok("display", { on: ["relief"] });
    await h.ok("regenerate", { parts: ["relief"], relief: { density: 0.4 } });
    theirsPath = (await h.ok("save_map", { path: "relief-theirs.map", overwrite: true })).path as string;
    const info = await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    mapSeed = String(info.seed);
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("an old file loads unchanged: no settings, no icons, relief off; dryRun reads the settings", async () => {
    const t = await terrain();
    assert.equal(t.icons, 0);
    assert.deepEqual(t.attrs, {});
    assert.equal(t.on, false);
    const dry = await relief({}, { dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal((dry.before as Obj).seed, null);
    assert.equal((dry.before as Obj).onLoad, false);
    assert.equal((dry.after as Obj).seed, mapSeed, "a regenerated relief is seeded with the map seed by default");
    assert.deepEqual((await terrain()).attrs, {}, "a dry run changes nothing");
  });

  test("regenerate relief is seeded: the same settings draw the same icons", async () => {
    // relief layer off: the settings are stored, nothing is drawn (the layer toggle draws them)
    const r = await relief();
    assert.deepEqual(r.ran, ["relief"]);
    const rel = r.relief as Obj;
    assert.deepEqual([rel.icons, rel.hidden, rel.settings.seed], [0, true, mapSeed]);
    assert.match(JSON.stringify(r.notes), /relief layer is off/);
    await h.ok("display", { on: ["relief"] });
    base = await terrain();
    assert.equal(base.attrs["data-seed"], mapSeed);
    assert.ok(base.icons > 500, `icons drawn: ${base.icons}`);
    assert.equal(base.on, true);
    const again = await relief();
    assert.equal((again.relief as Obj).icons, base.icons);
    assert.equal((again.relief as Obj).hidden, undefined);
    assert.equal((await terrain()).hash, base.hash, "identical icons");
    // the app's own redraw (style panel, drawLayers) reads the same settings
    await h.ok("eval", { code: "drawReliefIcons(); return 1;" });
    const t = await terrain();
    assert.equal(t.hash, base.hash);
    // another seed draws other icons
    await relief({ seed: "other" });
    assert.notEqual((await terrain()).hash, base.hash);
    await relief({ seed: null });
    assert.equal((await terrain()).hash, base.hash, "seed null goes back to the map seed");
  });

  test("density scales the icon count with its square, with no floor of one icon per cell", async () => {
    const half = await relief({ density: 0.5 });
    const ratio = (half.relief as Obj).icons / base.icons;
    assert.ok(ratio > 0.15 && ratio < 0.4, `density 0.5 kept ${ratio} of the icons`);
    assert.equal((await terrain()).attrs["data-scale"], "0.5");
    const quarter = ((await relief({ density: 0.25 })).relief as Obj).icons / base.icons;
    assert.ok(quarter > 0.02 && quarter < 0.11, `density 0.25 kept ${quarter} of the icons (about 1/16)`);
    const tenth = ((await relief({ density: 0.1 })).relief as Obj).icons / base.icons;
    assert.ok(tenth > 0 && tenth < 0.03, `density 0.1 kept ${tenth} of the icons (about 1%)`);
    const none = await relief({ density: 0 });
    assert.equal((none.relief as Obj).icons, 0);
    await relief({ density: null });
    const t = await terrain();
    assert.equal(t.attrs["data-scale"], undefined);
    assert.equal(t.hash, base.hash);
  });

  test("matchIcons picks the density that draws about that many icons", async () => {
    const target = Math.round(base.icons * 0.6);
    const r = await relief({ matchIcons: target });
    const rel = r.relief as Obj;
    assert.ok(Math.abs(rel.icons - target) <= target * 0.02, `${rel.icons} icons for ${target}`);
    assert.equal(typeof rel.settings.density, "number");
    assert.ok(rel.settings.density > 0.6 && rel.settings.density < 0.95, String(rel.settings.density));
    assert.equal((await terrain()).attrs["data-scale"], String(rel.settings.density));
    assert.match(JSON.stringify(r.notes), /matchIcons: density/);
    const dry = await relief({ matchIcons: true }, { dryRun: true });
    assert.deepEqual((dry.after as Obj).density, { matchIcons: rel.icons });
    await relief({ density: null });
    assert.equal((await terrain()).hash, base.hash);
  });

  test("minHeight, perBiome, exclude and nearBurgs keep icons out", async () => {
    // minHeight 50: hills and mountains only
    await relief({ minHeight: 50 });
    const hills = await icons();
    assert.ok(hills.cells.length > 0);
    assert.ok(
      hills.hrefs.every(href => /relief-(hill|mount)/.test(href)),
      hills.hrefs.join()
    );
    await relief({ minHeight: null });

    // perBiome: the biome with the most icons gets none, another one fewer
    const info = (
      await h.ok("eval", {
        readOnly: true,
        code: `${CENTRES}
               const n = {}; for (const { cell: c } of centres) n[pack.cells.biome[c]] = (n[pack.cells.biome[c]] || 0) + 1;
               const top = Object.entries(n).sort((a, b) => b[1] - a[1]); return { top: +top[0][0], name: biomesData.name[+top[0][0]], second: +top[1][0] };`
      })
    ).value as { top: number; name: string; second: number };
    const pb = await relief({ perBiome: { [info.name]: 0, [String(info.second)]: 0.5 } });
    assert.deepEqual(Object.keys((pb.relief as Obj).settings.perBiome).length, 2);
    const biomeOf = (await h.ok("eval", { readOnly: true, code: "return Array.from(pack.cells.biome);" }))
      .value as number[];
    const left = await icons();
    assert.equal(left.cells.filter(c => biomeOf[c] === info.top).length, 0, `no icons on ${info.name}`);
    assert.ok(left.cells.length < base.icons);
    await relief({ perBiome: null });
    assert.equal((await terrain()).hash, base.hash);

    // exclude: a state's cells (entity), a zone and a polygon, united
    const pick = (
      await h.ok("eval", {
        readOnly: true,
        code: `${CENTRES}
               const n = {}; for (const { cell: c } of centres) n[pack.cells.state[c]] = (n[pack.cells.state[c]] || 0) + 1;
               const st = +Object.entries(n).filter(e => +e[0] > 0).sort((a, b) => b[1] - a[1])[0][0];
               const zone = pack.zones.find(z => !z.hidden && z.cells.length > 5);
               return { state: st, zone: zone.i, stateOf: Array.from(pack.cells.state), zoneCells: zone.cells };`
      })
    ).value as { state: number; zone: number; stateOf: number[]; zoneCells: number[] };
    const ex = await relief({
      exclude: [
        { entity: { type: "state", ref: pick.state } },
        { entity: { type: "zone", ref: pick.zone } },
        {
          polygon: [
            { x: 0, y: 0 },
            { x: 200, y: 0 },
            { x: 0, y: 200 }
          ]
        }
      ]
    });
    const exSettings = (ex.relief as Obj).settings;
    assert.ok(exSettings.exclude.gridCells > 50, JSON.stringify(exSettings.exclude));
    assert.match((await terrain()).attrs["data-exclude"], /^\d+-[0-9a-z]+:\d/);
    // exact: the selected pack cells (not every pack cell of their grid cells, see the coast test)
    const excluded = new Set([...pick.stateOf.flatMap((s, c) => (s === pick.state ? [c] : [])), ...pick.zoneCells]);
    const kept = await icons();
    assert.equal(kept.cells.filter(c => excluded.has(c)).length, 0, "no icons in excluded cells");
    assert.ok(kept.cells.length > 0 && kept.cells.length < base.icons);

    // nearBurgs: no icon centre within the radius of a live burg (checked on every draw; the
    // stored icon x, y and size are rounded to 0.01, hence 14.95)
    await relief({ exclude: null, nearBurgs: 15 });
    const near = (
      await h.ok("eval", {
        readOnly: true,
        code: `const bs = pack.burgs.filter(b => b && b.i && !b.removed); let n = 0;
               for (const u of document.querySelectorAll("#terrain use")) { const s = +u.getAttribute("width"); const x = +u.getAttribute("x") + s / 2, y = +u.getAttribute("y") + s / 2; if (bs.some(b => Math.hypot(b.x - x, b.y - y) < 14.95)) n++; }
               return { n, icons: document.getElementById("terrain").childElementCount };`
      })
    ).value as { n: number; icons: number };
    assert.equal(near.n, 0);
    assert.ok(near.icons < base.icons);
    const t = await terrain();
    assert.equal(t.attrs["data-near-burgs"], "15");
    assert.equal(t.attrs["data-exclude"], undefined);
    await relief({ nearBurgs: null });
    assert.equal((await terrain()).hash, base.hash);

    // a bad item of a list is named; an empty selection says so
    const bad = await h.call("regenerate", {
      parts: ["relief"],
      relief: { exclude: [{ cells: [1] }, { entity: { type: "zone", ref: "Nowhere at all" } }] }
    });
    assert.equal(errorBody(bad).error.code, "NOT_FOUND");
    assert.match(errorBody(bad).error.message, /^relief\.exclude\[1\]: /);
    const empty = await relief({ exclude: { cells: [] } });
    assert.match(JSON.stringify(empty.notes), /selected no cells/);
    assert.equal((await terrain()).hash, base.hash);
  });

  test("exclude is exact on the coast; excludeAdd and excludeRemove change it in place", async () => {
    const pair = (await h.ok("eval", { readOnly: true, code: COAST_CODE })).value as Obj | null;
    assert.ok(pair, "demo.map has a coastal grid cell with two pack cells that both hold icons");
    const inCell = (cells: number[], c: number) => cells.filter(x => x === c).length;
    const one = await relief({ exclude: { cells: [pair.a] } });
    assert.equal((one.relief as Obj).settings.exclude.coastCells, 1);
    assert.match((await terrain()).attrs["data-exclude"], new RegExp(`:;${pair.g}\\.\\d+$`));
    let ic = await icons();
    assert.equal(inCell(ic.cells, pair.a), 0);
    assert.equal(inCell(ic.cells, pair.b), pair.nb, "the other pack cell of that grid cell keeps its icons");

    const both = await relief({ excludeAdd: { cells: [pair.b] } });
    assert.deepEqual(
      [both.relief as Obj].map(r => [r.settings.exclude.gridCells, r.settings.exclude.coastCells]),
      [[1, undefined]]
    );
    assert.ok(Array.isArray((both.relief as Obj).settings.exclude.bbox));
    ic = await icons();
    assert.equal(inCell(ic.cells, pair.a) + inCell(ic.cells, pair.b), 0);

    await relief({ excludeRemove: { cells: [pair.a] } });
    ic = await icons();
    assert.equal(inCell(ic.cells, pair.a), pair.na);
    assert.equal(inCell(ic.cells, pair.b), 0);
    const again = await relief({ excludeRemove: { cells: [pair.a] } });
    assert.match(JSON.stringify(again.notes), /removed no cells/);
    const mixed = await h.call("regenerate", {
      parts: ["relief"],
      relief: { exclude: { cells: [1] }, excludeAdd: { cells: [2] } }
    });
    assert.equal(errorBody(mixed).error.code, "BAD_ARGS");
    await relief({ exclude: null });
    assert.equal((await terrain()).hash, base.hash);
  });

  test("nearBurgs takes px, or km / mi converted with the map's distance scale", async () => {
    const m = (
      await h.ok("eval", {
        readOnly: true,
        code: `return { unit: document.getElementById("distanceUnitInput").value, scale: distanceScale };`
      })
    ).value as { unit: string; scale: number };
    const r = await relief({ nearBurgs: { radius: 3, unit: m.unit } });
    assert.equal((r.relief as Obj).settings.nearBurgs, Math.round((3 / m.scale) * 100) / 100);
    const other = m.unit === "mi" ? "km" : "mi";
    const factor = other === "km" ? 1 / 1.609344 : 1.609344;
    const r2 = await relief({ nearBurgs: { radius: 3, unit: other } });
    assert.equal((r2.relief as Obj).settings.nearBurgs, Math.round(((3 * factor) / m.scale) * 100) / 100);
    const px = await relief({ nearBurgs: { radius: 3 } });
    assert.equal((px.relief as Obj).settings.nearBurgs, 3, "unit defaults to px");
    await relief({ nearBurgs: null });
    assert.equal((await terrain()).hash, base.hash);
  });

  test("bad settings change nothing", async () => {
    const before = await terrain();
    const bad = async (args: Obj, code: string) => {
      const r = await h.call("regenerate", args);
      assert.equal(r.isError, true, JSON.stringify(args));
      if (code) assert.equal(errorBody(r).error.code, code);
    };
    await bad({ parts: ["zones"], relief: { density: 0.5 } }, "BAD_ARGS");
    await bad({ parts: ["relief"], relief: { perBiome: { Nowhere: 0 } } }, "NOT_FOUND");
    await bad({ parts: ["relief"], relief: { density: 3 } }, "");
    await bad({ parts: ["zones"], dryRun: true }, "BAD_ARGS");
    await bad({ parts: ["relief"], relief: { density: 0.5, matchIcons: 100 } }, "BAD_ARGS");
    const after = await terrain();
    assert.equal(after.hash, before.hash);
    assert.deepEqual(after.attrs, before.attrs);
  });

  test("undo puts the previous settings and icons back", async () => {
    await relief({ density: 0.6, minHeight: 40 });
    assert.notEqual((await terrain()).hash, base.hash);
    await h.ok("snapshot", { action: "undo" });
    const t = await terrain();
    assert.deepEqual(t.attrs, base.attrs);
    assert.equal(t.hash, base.hash);
  });

  test("reliefOnLoad: every save drops the icons and a load draws the same ones", async () => {
    await relief({ density: 0.8, nearBurgs: 8, exclude: { entity: { type: "zone", ref: 0 } } });
    const drawn = await terrain();
    const full = await h.ok("save_map", { path: "relief-full.map", overwrite: true });
    const fullText = fs.readFileSync(full.path as string, "utf8");
    assert.ok((TERRAIN_RE.exec(fullText)?.[0].match(/<use /g) ?? []).length === drawn.icons);

    const ed = await h.ok("edit", { type: "map", ops: [{ set: { reliefOnLoad: true } }] });
    const row = (ed.applied as Obj[])[0];
    assert.deepEqual([row.before.reliefOnLoad, row.after.reliefOnLoad], [false, true]);
    assert.match(JSON.stringify(ed.notes), /saves now drop the relief icons/);
    const on = await terrain();
    assert.equal(on.attrs["data-regenerate"], "1");
    assert.equal(on.hash, drawn.hash, "already seeded: the redraw is identical");

    const lean = await h.ok("save_map", { path: "relief-lean.map", overwrite: true });
    const leanText = fs.readFileSync(lean.path as string, "utf8");
    const g = TERRAIN_RE.exec(leanText)?.[0] ?? "";
    assert.match(g, /data-regenerate="1"/);
    assert.match(g, /\/>$/, "the terrain group is empty");
    assert.ok((lean.bytes as number) < (full.bytes as number) - drawn.icons * 40, `${lean.bytes} vs ${full.bytes}`);
    // the in-app save (File > Save, browser storage, autosave, cloud) uses the same prepareMapData
    const app = await h.ok("eval", {
      readOnly: true,
      code: `const { prepareMapData } = await lazy.save(); return /<g id="terrain"[^>]*\\/>/.test(prepareMapData());`
    });
    assert.equal(app.value, true);

    await h.ok("load_map", { path: lean.path as string });
    const loaded = await terrain();
    assert.equal(loaded.icons, drawn.icons);
    assert.equal(loaded.hash, drawn.hash, "the load draws the icons the page showed");
    assert.equal(loaded.on, true, "the Relief button is on again");
    assert.deepEqual(loaded.attrs, on.attrs);
    const info = await h.ok("map_info", { since: "none" });
    assert.deepEqual(
      [(info.relief as Obj).icons, (info.relief as Obj).onLoad, (info.relief as Obj).density],
      [drawn.icons, true, 0.8]
    );

    // a file that stored its icons loads them as stored (no redraw)
    await h.ok("load_map", { path: full.path as string });
    const stored = await terrain();
    assert.equal(stored.hash, drawn.hash);
    assert.equal(stored.attrs["data-regenerate"], undefined);

    // relief.onLoad is the same switch; a hidden relief layer is not drawn on load (drawn when shown)
    await relief({ onLoad: true });
    await h.ok("display", { off: ["relief"] });
    const hidden = await h.ok("save_map", { path: "relief-hidden.map", overwrite: true });
    await h.ok("load_map", { path: hidden.path as string });
    const off = await terrain();
    assert.equal(off.icons, 0);
    assert.equal(off.on, false);
    await h.ok("display", { on: ["relief"] });
    assert.equal((await terrain()).hash, drawn.hash);

    // off again: saves store the icons
    await h.ok("edit", { type: "map", ops: [{ set: { reliefOnLoad: false } }] });
    const back = await h.ok("save_map", { path: "relief-back.map", overwrite: true });
    assert.ok((back.bytes as number) > (lean.bytes as number) + drawn.icons * 40);
  });

  test("on a reliefOnLoad map, edits that change what relief is drawn from redraw it (page = next load)", async () => {
    await relief({ onLoad: true, density: 0.8, nearBurgs: null, exclude: null });
    const start = await terrain();
    const spot = (
      await h.ok("eval", {
        readOnly: true,
        code: `${CENTRES} const c = centres.find(x => pack.cells.h[x.cell] < 50 && pack.cells.h[x.cell] >= 20); return { x: c.x, y: c.y };`
      })
    ).value as { x: number; y: number };
    const p = await h.ok("paint_cells", {
      select: { circle: { at: spot, radius: 40 } },
      set: { biome: "Glacier" }
    });
    assert.match(JSON.stringify(p.notes), /relief icons redrawn/);
    const painted = await terrain();
    assert.notEqual(painted.hash, start.hash);
    const d = await h.ok("display", { styleRules: { "#terrain": { density: 0.3 } } });
    assert.match(JSON.stringify(d.notes), /relief icons redrawn/);
    const styled = await terrain();
    assert.notEqual(styled.hash, painted.hash);
    const lean = await h.ok("save_map", { path: "relief-sync.map", overwrite: true });
    await h.ok("load_map", { path: lean.path as string });
    assert.equal((await terrain()).hash, styled.hash, "the load draws what the page showed");
    // an edit that changes nothing relief reads leaves the icons alone
    const e = await h.ok("edit", { type: "map", ops: [{ set: { name: "Reliefland" } }] });
    assert.doesNotMatch(JSON.stringify(e.notes ?? []), /relief icons redrawn/);
    assert.equal((await terrain()).hash, styled.hash);
  });

  test("edit map reliefOnLoad reports a changed icon count and a hidden layer", async () => {
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    // relief layer off: nothing to redraw, says so
    const off = await h.ok("edit", { type: "map", ops: [{ set: { reliefOnLoad: true } }], dryRun: false });
    assert.match(JSON.stringify(off.notes), /relief layer is off/);
    await h.ok("snapshot", { action: "undo" });
    // a thinned (curated) unseeded set: switching redraws at density 1 and says how to keep the count
    await h.ok("display", { on: ["relief"] });
    const kept = (
      await h.ok("eval", {
        code: `const us = [...document.querySelectorAll("#terrain use")]; us.forEach((u, k) => { if (k % 3 === 0) u.remove(); }); return document.getElementById("terrain").childElementCount;`
      })
    ).value as number;
    const ed = await h.ok("edit", { type: "map", ops: [{ set: { reliefOnLoad: true } }] });
    const notes = JSON.stringify(ed.notes);
    assert.match(notes, new RegExp(`was ${kept}\\)`));
    assert.match(notes, new RegExp(`matchIcons:${kept}`));
    const m = await relief({ matchIcons: kept });
    assert.ok(Math.abs((m.relief as Obj).icons - kept) <= kept * 0.02);
  });

  // In-app UI (app hooks marked tupaia-mcp: style.js, biomes-editor.js, heightmap-editor.js). Each
  // eval reads the icons right after the UI action: the app redraws them itself, so the MCP's own
  // after-call redraw (bridge-ext/relief.js) finds nothing to do and adds no note.
  const HASH = `const terrainHash = () => { const html = document.getElementById("terrain").innerHTML; let hash = 0; for (let k = 0; k < html.length; k++) hash = (Math.imul(hash, 31) + html.charCodeAt(k)) | 0; return hash; };`;
  const MCP_REDRAW = /relief icons redrawn/;
  const reloads = async (slug: string) => {
    const saved = await h.ok("save_map", { path: `relief-ui-${slug}.map`, overwrite: true });
    await h.ok("load_map", { path: saved.path as string });
    return terrain();
  };

  test("in-app: the Style > Relief checkbox is the reliefOnLoad switch; save and load draw the same icons", async () => {
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("display", { on: ["relief"] });
    const ui = await h.ok("eval", {
      code: `editStyle("terrain");
        const cb = document.getElementById("styleReliefOnLoad");
        const row = { shown: styleRelief.style.display === "block", was: cb.checked, label: document.querySelector("label[for=styleReliefOnLoad]").textContent, tip: cb.closest("tr").dataset.tip };
        cb.click();
        return { ...row, checked: cb.checked };`
    });
    const v = ui.value as Obj;
    assert.deepEqual([v.shown, v.was, v.checked], [true, false, true]);
    assert.equal(v.label, "Redraw relief icons on load (smaller file)");
    assert.match(v.tip, /smaller/);
    assert.doesNotMatch(JSON.stringify(ui.notes ?? []), MCP_REDRAW, "the app redrew the icons itself");
    const drawn = await terrain();
    assert.equal(drawn.attrs["data-regenerate"], "1");
    assert.equal(drawn.attrs["data-seed"], mapSeed, "seeded with the map seed");
    assert.ok(drawn.icons > 0);
    const map = await h.ok("map_info", { since: "none" });
    assert.equal((map.relief as Obj).onLoad, true);

    // the MCP switch draws the very same icons
    await h.ok("snapshot", { action: "undo" });
    const undone = await terrain();
    assert.equal(undone.attrs["data-regenerate"], undefined, "undo takes the click back");
    await h.ok("edit", { type: "map", ops: [{ set: { reliefOnLoad: true } }] });
    assert.equal((await terrain()).hash, drawn.hash);

    const lean = await h.ok("save_map", { path: "relief-ui-lean.map", overwrite: true });
    assert.match(
      TERRAIN_RE.exec(fs.readFileSync(lean.path as string, "utf8"))?.[0] ?? "",
      /data-regenerate="1"[^>]*\/>$/
    );
    await h.ok("load_map", { path: lean.path as string });
    const loaded = await terrain();
    assert.equal(loaded.hash, drawn.hash, "the load draws the icons the page showed");
    // the checkbox shows the loaded map's setting; unchecking keeps the icons and saves them again
    const off = await h.ok("eval", {
      code: `editStyle("terrain"); const cb = document.getElementById("styleReliefOnLoad"); const was = cb.checked; cb.click(); return { was, checked: cb.checked };`
    });
    assert.deepEqual(off.value, { was: true, checked: false });
    const kept = await terrain();
    assert.equal(kept.attrs["data-regenerate"], undefined);
    assert.equal(kept.hash, loaded.hash, "switching off keeps the icons on the page");
    const full = await h.ok("save_map", { path: "relief-ui-full.map", overwrite: true });
    assert.equal(
      (TERRAIN_RE.exec(fs.readFileSync(full.path as string, "utf8"))?.[0].match(/<use /g) ?? []).length,
      loaded.icons
    );
  });

  test("in-app: on a relief-on-load map the biomes editor, heightmap editor and Tools > Regenerate redraw the icons (page = next load)", async () => {
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("display", { on: ["relief"] });
    await h.ok("edit", { type: "map", ops: [{ set: { reliefOnLoad: true } }] });

    // biomes editor: paint cells that hold icons Glacier, then Apply
    const paint = await h.ok("eval", {
      code: `${CENTRES} ${HASH}
        const before = terrainHash();
        editBiomes();
        document.getElementById("biomesManually").click();
        const glacier = biomesData.name.indexOf("Glacier");
        const cells = [...new Set(centres.map(c => c.cell))].filter(c => pack.cells.biome[c] !== glacier).slice(0, 60);
        for (const i of cells) biomes.select("#temp").append("polygon").attr("data-cell", i).attr("data-biome", glacier).attr("points", getPackPolygon(i));
        document.getElementById("biomesManuallyApply").click();
        const after = terrainHash();
        closeDialogs();
        return { before, after, painted: cells.filter(c => pack.cells.biome[c] === glacier).length };`
    });
    let v = paint.value as Obj;
    assert.ok(v.painted > 10, JSON.stringify(v));
    assert.notEqual(v.after, v.before, "Apply redrew the icons");
    assert.doesNotMatch(JSON.stringify(paint.notes ?? []), MCP_REDRAW);
    assert.equal((await reloads("paint")).hash, v.after, "a load draws what the page showed");

    // biomes editor: Restore defaults brings back icon densities (thinned here through the MCP)
    const dense = await h.ok("eval", {
      readOnly: true,
      code: `const n = new Array(biomesData.i.length).fill(0); for (const c of pack.cells.i) n[pack.cells.biome[c]] += pack.cells.h[c] >= 20 ? 1 : 0; return biomesData.i.filter(b => biomesData.iconsDensity[b] > 0).sort((a, b) => n[b] - n[a])[0];`
    });
    const top = dense.value as number;
    await h.ok("edit", { type: "biome", ops: [{ ref: top, set: { iconsDensity: 1 } }] });
    const thinned = await terrain();
    const restore = await h.ok("eval", {
      code: `${HASH} const before = terrainHash(); editBiomes(); document.getElementById("biomesRestore").click(); const after = terrainHash(); closeDialogs(); return { before, after, density: biomesData.iconsDensity[${top}] };`
    });
    v = restore.value as Obj;
    assert.equal(v.before, thinned.hash);
    assert.ok(v.density > 1);
    assert.notEqual(v.after, v.before, "Restore redrew the icons");
    assert.doesNotMatch(JSON.stringify(restore.notes ?? []), MCP_REDRAW);
    assert.equal((await reloads("restore")).hash, v.after);

    // heightmap editor, Keep mode: raise the land under icons, then Exit Customization
    const heights = await h.ok("eval", {
      code: `${CENTRES} ${HASH}
        const before = terrainHash();
        editHeightmap({ mode: "keep" });
        const gs = new Set(centres.map(c => pack.cells.g[c.cell]));
        for (const g of gs) if (grid.cells.h[g] >= 20) grid.cells.h[g] = Math.min(100, grid.cells.h[g] + 30);
        document.getElementById("finalizeHeightmap").click();
        return { before, after: terrainHash(), raised: gs.size, customization, relief: layerIsOn("toggleRelief") };`
    });
    v = heights.value as Obj;
    assert.deepEqual([v.customization, v.relief], [0, true], JSON.stringify(v));
    assert.notEqual(v.after, v.before, "finalizing the heightmap redrew the icons");
    assert.doesNotMatch(JSON.stringify(heights.notes ?? []), MCP_REDRAW);
    const loaded = await reloads("heights");
    assert.equal(loaded.hash, v.after);

    // Tools > Regenerate > Relief draws the stored, seeded icons (thinned by hand first)
    const regen = await h.ok("eval", {
      code: `${HASH}
        [...document.querySelectorAll("#terrain use")].forEach((u, k) => { if (k % 2) u.remove(); });
        const thinned = terrainHash();
        sessionStorage.setItem("regenerateFeatureDontAsk", true); // skip the confirm dialog
        document.getElementById("regenerateReliefIcons").click();
        sessionStorage.removeItem("regenerateFeatureDontAsk");
        return { thinned, after: terrainHash() };`
    });
    v = regen.value as Obj;
    assert.notEqual(v.thinned, loaded.hash);
    assert.equal(v.after, loaded.hash, "the regenerated icons are the ones a load draws");

    // a map that stores its icons: the editors leave them alone (upstream behaviour)
    await h.ok("edit", { type: "map", ops: [{ set: { reliefOnLoad: false } }] });
    const plain = await h.ok("eval", {
      code: `${HASH} const before = terrainHash(); editBiomes(); document.getElementById("biomesRestore").click(); const after = terrainHash(); closeDialogs(); return { before, after };`
    });
    v = plain.value as Obj;
    assert.equal(v.after, v.before);
  });

  test("sketch: relief-only regenerate and edit map replay onto another copy; other parts do not", async () => {
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("sketch", { action: "start", slug: "t-relief" });
    await h.ok("display", { on: ["relief"] });
    await relief({ density: 0.7, minHeight: 30, exclude: { entity: { type: "zone", ref: 1 } }, nearBurgs: 6 });
    await h.ok("edit", { type: "map", ops: [{ set: { reliefOnLoad: true } }] });
    const mine = await terrain();
    let st = await h.ok("sketch", { action: "status" });
    assert.equal(st.blobOnly, false, JSON.stringify(st.blobOnlyReasons));
    const log = st.log as Obj[];
    assert.equal(log.length, 3);
    assert.match(log[1].summary, /^Regenerated relief icons: density 0.7, minHeight 30, exclusion/);

    // a mixed regenerate is logged as not replayable; undo takes it out again
    await h.ok("regenerate", { parts: ["zones", "relief"] });
    st = await h.ok("sketch", { action: "status" });
    assert.equal(st.blobOnly, true);
    await h.ok("snapshot", { action: "undo" });
    st = await h.ok("sketch", { action: "status" });
    assert.equal(st.blobOnly, false);

    const r = await h.ok("sketch", { action: "rebase", onto: { path: copyPath } }, 240_000);
    assert.equal(r.completed, true, JSON.stringify(r.conflicts));
    assert.deepEqual(r.applied, [1, 2, 3]);
    const replayed = await terrain();
    assert.deepEqual(replayed.attrs, mine.attrs);
    assert.equal(replayed.hash, mine.hash, "the replay draws the same icons");
    const other = await h.ok("eval", { readOnly: true, code: `pack.burgs.some(b => b && b.name === "Otherton")` });
    assert.equal(other.value, true, "their edit survives");

    // someone else changed the density (0.4) since the sketch's base (1); the sketch sets 0.7
    const c = await h.ok("sketch", { action: "rebase", onto: { path: theirsPath }, onConflict: "skip" }, 240_000);
    assert.deepEqual(c.skipped, [2]);
    assert.match(JSON.stringify(c.conflicts), /both changed relief density: base 1, now 0.4, sketch 0.7/);
    assert.equal((await terrain()).attrs["data-scale"], "0.4", "their density is kept");
    await h.ok("sketch", { action: "stop" });
  });

  test("a new map starts without relief settings; an exclusion of another grid is stale", async () => {
    assert.ok(Object.keys((await terrain()).attrs).length > 0, "the page holds relief settings");
    await h.ok("generate_map", { seed: "relief-new-map" }, 240_000);
    assert.deepEqual((await terrain()).attrs, {});
    // an exclusion recorded on another grid is reported stale and refused as a literal
    await h.ok("eval", {
      code: `document.getElementById("terrain").setAttribute("data-exclude", "12-abc:1-3"); return 1;`
    });
    const dry = await relief({}, { dryRun: true });
    assert.match((dry.before as Obj).exclude.stale, /another grid/);
    const r = await h.ok("eval", {
      readOnly: true,
      code: `try { await __tupaia.fns.relief({ relief: { excludeGrid: "12-abc:1-3" }, phase: "validate" }); return "accepted"; } catch (e) { return e.code; }`
    });
    assert.equal(r.value, "REFUSED");
  });
});

describe("tupaia-mcp relief icons: shared and sketch saves (live mode, fake Worker)", () => {
  let fake: FakeWorker;
  let h: Harness;
  const localEntry = /src="\/(index-[^"]+\.js)"/.exec(
    fs.readFileSync(path.join(REPO_ROOT, "dist", "index.html"), "utf8")
  )?.[1] as string;
  const terrainOf = (b: Buffer | undefined) => TERRAIN_RE.exec(String(b))?.[0] ?? "";

  before(async () => {
    // the deployed build differs from the local one and its entry chunk cannot be fetched
    fake = new FakeWorker({ seedFile: DEMO_MAP, version: 2, entry: "index-FAKE.js" });
    const origin = await fake.start();
    h = await startServer({ TUPAIA_MODE: "live", TUPAIA_LIVE_ORIGIN: origin, TUPAIA_BUILD_CACHE_MS: "0" });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
    await fake?.stop();
  });

  test("shared_save refuses a reliefOnLoad map unless the deployed app has the load hook; the PUT drops the icons", async () => {
    await h.ok("display", { on: ["relief"] });
    await h.ok("regenerate", { parts: ["relief"], relief: { onLoad: true, density: 0.7 } });
    const icons = (await h.ok("map_info", { since: "none" })).relief as Obj;
    assert.ok(icons.icons > 500 && icons.onLoad === true, JSON.stringify(icons));

    const p = await h.ok("shared_save", {});
    assert.equal((p.buildCheck as Obj).verdict, "warn");
    assert.match(String(p.refusalReason), /relief load hook/);
    assert.equal(
      ((await h.ok("shared_save", { skipBuildCheck: true })).refusalReason as string | undefined) ?? "",
      "",
      "unverifiable: skipBuildCheck overrides"
    );

    fake.entry = localEntry; // the deployed build is the local one, which has the hook
    const ok = await h.ok("shared_save", {});
    assert.equal(ok.refusalReason, undefined, String(ok.refusalReason));
    const r = await h.ok("shared_save", { confirm: true, token: ok.token as string });
    assert.equal((r.saved as Obj).version, 3);
    const g = terrainOf(fake.current);
    assert.match(g, /data-regenerate="1"/);
    assert.match(g, /\/>$/, "the shared blob holds no relief icons");

    // a sketch save PUTs the same lean map
    await h.ok("load_map", { source: "shared" });
    assert.equal(((await h.ok("map_info", { since: "none" })).relief as Obj).icons, icons.icons);
    await h.ok("sketch", { action: "start", slug: "thin-relief" });
    await h.ok("regenerate", { parts: ["relief"], relief: { density: 0.5 } });
    await h.ok("sketch", { action: "save", confirm: true });
    const sg = terrainOf(fake.maps.get("sketch-thin-relief")?.current);
    assert.match(sg, /data-scale="0.5"/);
    assert.match(sg, /\/>$/, "the sketch blob holds no relief icons");
    await h.ok("sketch", { action: "stop" });
  });
});
