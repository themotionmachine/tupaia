// Relief icons (track 'relief'): regenerate {parts:['relief'], relief:{...}} draws seeded icons
// with density / perBiome / minHeight / exclude / nearBurgs, and reliefOnLoad (edit map or
// relief.onLoad) makes every save drop the icons and every load draw the same ones again.
// Against tests/fixtures/demo.map (relief layer off, no icons stored). Local only.
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import { alive, errorBody, type Harness, startServer } from "./helpers.ts";

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

describe("tupaia-mcp relief icons", () => {
  let h: Harness;
  let mapSeed = "";
  let base: TerrainState;
  let copyPath = "";

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

  test("density scales the icon count with its square; null resets it", async () => {
    const half = await relief({ density: 0.5 });
    const ratio = (half.relief as Obj).icons / base.icons;
    assert.ok(ratio > 0.15 && ratio < 0.45, `density 0.5 kept ${ratio} of the icons`);
    assert.equal((await terrain()).attrs["data-scale"], "0.5");
    const none = await relief({ density: 0 });
    assert.equal((none.relief as Obj).icons, 0);
    await relief({ density: null });
    const t = await terrain();
    assert.equal(t.attrs["data-scale"], undefined);
    assert.equal(t.hash, base.hash);
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
               return { state: st, zone: zone.i, g: Array.from(pack.cells.g), stateOf: Array.from(pack.cells.state), zoneCells: zone.cells };`
      })
    ).value as { state: number; zone: number; g: number[]; stateOf: number[]; zoneCells: number[] };
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
    assert.match((await terrain()).attrs["data-exclude"], /^\d+:\d/);
    const excludedGrid = new Set([
      ...pick.stateOf.flatMap((s, c) => (s === pick.state ? [pick.g[c]] : [])),
      ...pick.zoneCells.map(c => pick.g[c])
    ]);
    const kept = await icons();
    assert.equal(kept.cells.filter(c => excludedGrid.has(pick.g[c])).length, 0, "no icons in excluded cells");
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
    await h.ok("sketch", { action: "stop" });
  });
});
