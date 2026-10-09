// compact (track 'compact'): removed entities become stubs that keep their slot, notes and SVG of
// removed or deleted entities go. Part 1 runs the page planner in node:vm on a fake pack (stub
// shapes, the referenced-records rule, note ownership, replay-mode ids). Part 2 drives the
// built app: demo.map gets hundreds of removed burgs plus removed states, provinces, cultures and
// religions (the app's own removal paths or faithful copies of them), deleted routes, rivers,
// zones and markers with leftover notes and SVG; then compact, save (plain and compact:true),
// load the compacted file, and exercise editors, overviews, charts, tooltips, regenerate and
// exports with no console errors. Part 3 checks the sketch log and replay of a compact op. Part 4
// runs compact:true through the token-gated writes (shared_save, sketch save, sketch_promote)
// against the in-process fake Worker on 127.0.0.1 (never the live site; safeEnv refuses it).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import vm from "node:vm";
import { FakeWorker } from "./fake-worker.ts";
import { alive, DEMO_MAP, errorBody, type Harness, MCP_ROOT, REPO_ROOT, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

// ---------------------------------------------------------------- part 1: planner in node:vm

const BRIDGE = fs.readFileSync(path.join(MCP_ROOT, "src", "bridge.js"), "utf8");
const EXT = fs.readFileSync(path.join(MCP_ROOT, "src", "bridge-ext", "compact.js"), "utf8");

function fakeWorld() {
  const n = 12;
  const cells = {
    i: Array.from({ length: n }, (_, c) => c),
    p: Array.from({ length: n }, (_, c) => [c * 10, 5]),
    h: new Uint8Array(n).fill(30),
    burg: new Uint16Array(n),
    state: new Uint16Array(n).fill(1),
    province: new Uint16Array(n).fill(1),
    culture: new Uint16Array(n).fill(1),
    religion: new Uint16Array(n).fill(1)
  };
  cells.burg[3] = 1;
  const full = (i: number, extra: Obj = {}) => ({
    i,
    name: `Old ${i}`,
    x: 1,
    y: 2,
    cell: 4,
    state: 1,
    culture: 1,
    population: 3,
    coa: { t1: "or" },
    production: [{ good: 1, units: 9 }],
    removed: true,
    ...extra
  });
  const pack = {
    cells,
    burgs: [
      {},
      { i: 1, name: "Live", x: 30, y: 5, cell: 3, state: 1, culture: 1, population: 5 },
      full(2),
      full(3),
      full(4),
      { i: 5, removed: true },
      full(6)
    ],
    states: [
      { i: 0, name: "Neutrals" },
      { i: 1, name: "Realm", capital: 1, culture: 1, provinces: [1], neighbors: [2], military: [{ i: 1 }] },
      { i: 2, name: "Merged", capital: 0, culture: 1, removed: true, diplomacy: ["x"], area: 50 },
      { i: 3, name: "Gone", capital: 0, culture: 1, removed: true, area: 10 }
    ],
    provinces: [0, { i: 1, name: "Shire", state: 1, burg: 4 }, { i: 2, name: "Old shire", state: 1, removed: true }],
    cultures: [
      { i: 0, name: "Wildlands", base: 1, origins: [null] },
      { i: 1, name: "Folk", base: 1, center: 2, origins: [0] },
      { i: 2, name: "Lost", base: 3, center: 7, color: "#fff", origins: [0], removed: true },
      { i: 3, name: "Remembered", base: 2, center: 8, origins: [0], removed: true }
    ],
    religions: [
      { i: 0, name: "No religion" },
      { i: 1, name: "Faith", culture: 3, origins: [2], center: 2 },
      { i: 2, name: "Old faith", culture: 1, origins: [0], removed: true },
      { i: 3, name: "Dead faith", culture: 2, origins: [0], center: 9, removed: true }
    ],
    markets: [{ i: 1, centerBurgId: 3 }],
    deals: [{ i: 0, seller: 6, sellerType: "burg", buyer: 1, buyerType: "market" }],
    markers: [{ i: 0 }],
    routes: [{ i: 0 }],
    rivers: [{ i: 5 }],
    zones: [{ i: 1 }],
    features: []
  };
  const notes = [
    "burg1",
    "burg2",
    "burg3",
    "stateLabel1",
    "stateLabel3",
    "province2",
    "culture0",
    "culture2",
    "religion3",
    "marker0",
    "marker7",
    "route0",
    "route9",
    "river5",
    "river6",
    "zone1",
    "zone2",
    "regiment1-1",
    "regiment1-2",
    "regiment3-0",
    "label7",
    "mapNote",
    "burg0"
  ].map(id => ({ id, name: id, legend: "" }));
  return { pack, notes };
}

function loadVm() {
  const world = fakeWorld();
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, pack: world.pack, notes: world.notes });
  vm.runInContext(BRIDGE, ctx, { filename: "bridge.js" });
  vm.runInContext(EXT, ctx, { filename: "compact.js" });
  return { T: ctx.__tupaia as Obj, world, ctx };
}

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("compact planner (node:vm)", () => {
  test("stubs unreferenced removed records, keeps referenced ones whole, drops orphan notes", async () => {
    const { T, world } = loadVm();
    const v = plain(await T.fns.compact({ phase: "validate", details: true }));
    assert.equal(v.phase, "validate");
    assert.deepEqual(v.compacted, { burg: 1, state: 1, province: 1, culture: 1, religion: 1 });
    assert.deepEqual(v.kept, { burg: 3, state: 1, culture: 1, religion: 1 });
    assert.deepEqual(v.keptBy, {
      burg: { market: 1, provinceBurg: 1, deal: 1 },
      state: { neighbors: 1 },
      culture: { religionCulture: 1 },
      religion: { origins: 1 }
    });
    assert.deepEqual(v.details.ids, { burg: "2", state: "3", province: "2", culture: "2", religion: "3" });
    const kept = Object.fromEntries(v.details.kept.map((k: Obj) => [`${k.type}${k.i}`, k.by]));
    assert.deepEqual(kept, {
      burg3: "market 1 centre",
      burg4: "province 1 burg",
      burg6: "deal 0 seller",
      state2: "state 1 neighbors list",
      culture3: "religion 1 culture",
      religion2: "religion 1 origins"
    });
    // every kind gets its own remedy line
    assert.match(v.keptWhy, /deal \(1\): regenerate \{parts:\['production'\]\}.*re-rolls/);
    assert.match(v.keptWhy, /provinceBurg \(1\): compact \{repointProvinces:true\}/);
    assert.match(v.keptWhy, /market \(1\): regenerate \{parts:\['markets','production'\]\}/);
    assert.deepEqual(v.details.notes.sort(), [
      "burg2",
      "burg3",
      "culture2",
      "label7",
      "marker7",
      "province2",
      "regiment1-2",
      "regiment3-0",
      "religion3",
      "river6",
      "route9",
      "stateLabel3",
      "zone2"
    ]);
    assert.ok(v.bytesSaved > 300, `bytesSaved ${v.bytesSaved}`);
    assert.equal(world.pack.burgs[2].name, "Old 2", "validate changes nothing");
    assert.equal(world.notes.length, 23);
  });

  test("apply writes the stubs in place (same slots, culture keeps base and center) and is idempotent", async () => {
    const { T, world } = loadVm();
    const { pack, notes } = world;
    const lengths = ["burgs", "states", "provinces", "cultures", "religions"].map(k => (pack as Obj)[k].length);
    const out = plain(await T.fns.compact({ phase: "apply" }));
    assert.ok(out.resolved.bytes > 300, "bytes saved, for the log summary");
    assert.equal(out.resolved.kept, 6);
    const { bytes: _b, kept: _k, ...resolved } = out.resolved;
    assert.deepEqual(resolved, {
      ids: { burg: [2], state: [3], province: [2], culture: [2], religion: [3] },
      notes: [
        "burg2",
        "burg3",
        "stateLabel3",
        "province2",
        "culture2",
        "religion3",
        "marker7",
        "route9",
        "river6",
        "zone2",
        "regiment1-2",
        "regiment3-0",
        "label7"
      ],
      svg: {}
    });
    assert.deepEqual(
      ["burgs", "states", "provinces", "cultures", "religions"].map(k => (pack as Obj)[k].length),
      lengths,
      "no slot is dropped"
    );
    assert.deepEqual(plain(pack.burgs[2]), { i: 2, removed: true });
    assert.deepEqual(plain(pack.states[3]), { i: 3, removed: true });
    assert.deepEqual(plain(pack.provinces[2]), { i: 2, removed: true });
    assert.deepEqual(plain(pack.cultures[2]), { i: 2, removed: true, base: 3, center: 7 });
    assert.deepEqual(plain(pack.religions[3]), { i: 3, removed: true });
    assert.equal(pack.burgs[3].name, "Old 3", "a market centre stays whole");
    assert.equal(pack.states[2].name, "Merged", "a state still in a live state's neighbors stays whole");
    assert.equal(notes.length, 10);
    assert.ok(
      notes.some(n => n.id === "burg0") && notes.some(n => n.id === "culture0") && notes.some(n => n.id === "mapNote")
    );
    const again = plain(await T.fns.compact({ phase: "validate" }));
    assert.equal(again.empty, true, "a second run finds nothing");
    // what editors write onto every record (cultures/religions statistics, burg.culture of a cell
    // that is undefined for a stub) leaves a stub a stub: no new undo entry or sketch op for it
    Object.assign(pack.cultures[2], { cells: 0, area: 0, rural: 0, urban: 0 });
    Object.assign(pack.religions[3], { cells: 0, area: 0, rural: 0, urban: 0 });
    (pack.burgs[2] as Obj).culture = undefined;
    assert.equal(plain(await T.fns.compact({ phase: "validate" })).empty, true, "editor fields are not work");
    // a real field is
    Object.assign(pack.religions[3], { name: "Back" });
    assert.deepEqual(plain(await T.fns.compact({ phase: "validate" })).compacted, { religion: 1 });
  });

  test("repointProvinces moves a province capital off a removed burg (the provinces editor's rule)", async () => {
    const { T, world } = loadVm();
    const pack = world.pack as Obj;
    const v = plain(await T.fns.compact({ phase: "validate", repointProvinces: true, details: true }));
    assert.equal(v.repointed, 1);
    assert.deepEqual(v.details.repointed, [{ province: 1, from: 4, to: 1 }], "first live burg in the province");
    assert.equal(v.compacted.burg, 2, "burg 4 is released");
    assert.equal(v.kept.burg, 2);
    assert.equal(pack.provinces[1].burg, 4, "validate changes nothing");
    const out = plain(await T.fns.compact({ phase: "apply", repointProvinces: true, types: ["burg"] }));
    assert.deepEqual(out.resolved.repoint, [[1, 4, 1]]);
    assert.deepEqual(out.resolved.ids, { burg: [2, 4] });
    assert.equal(pack.provinces[1].burg, 1);
    assert.deepEqual(plain(pack.burgs[4]), { i: 4, removed: true });
    // without burgs in types nothing is repointed
    const { T: T2, world: w2 } = loadVm();
    const v2 = plain(await T2.fns.compact({ phase: "apply", repointProvinces: true, types: ["culture"] }));
    assert.equal(v2.repointed, undefined);
    assert.equal((w2.pack as Obj).provinces[1].burg, 4);
  });

  test("replayed repoints apply only where the province still has that removed capital", async () => {
    const { T, world } = loadVm();
    const pack = world.pack as Obj;
    // a stale row (the province's capital is not 5 on this base) is skipped: burg 4 stays kept
    const stale = plain(await T.fns.compact({ phase: "apply", ids: { burg: [4] }, repoint: [[1, 5, 1]] }));
    assert.deepEqual(stale.resolved.ids, {});
    assert.equal(pack.provinces[1].burg, 4);
    // a row whose new capital is not live is skipped too
    const dead = plain(await T.fns.compact({ phase: "apply", ids: { burg: [4] }, repoint: [[1, 4, 6]] }));
    assert.deepEqual(dead.resolved.ids, {});
    const ok = plain(await T.fns.compact({ phase: "apply", ids: { burg: [4] }, repoint: [[1, 4, 0]] }));
    assert.deepEqual(ok.resolved.ids, { burg: [4] });
    assert.deepEqual(ok.resolved.repoint, [[1, 4, 0]]);
    assert.equal(pack.provinces[1].burg, 0);
  });

  test("details limit; notes byte count is exact when every note goes", async () => {
    const { T, world } = loadVm();
    const v = plain(await T.fns.compact({ phase: "validate", details: true, limit: 2 }));
    assert.equal(v.details.kept.length, 2);
    assert.equal(v.details.keptTruncated, 6);
    assert.equal(v.details.notes.length, 2);
    assert.equal(v.details.notesTruncated, 13);
    world.notes.length = 0;
    world.notes.push({ id: "route9", name: "x", legend: "" }, { id: "zone2", name: "y", legend: "" });
    const before = JSON.stringify(world.notes).length;
    const n = plain(await T.fns.compact({ phase: "validate", types: ["route", "zone"], svg: false }));
    assert.equal(n.notesDropped, 2);
    assert.equal(n.bytesSaved, before - "[]".length);
  });

  test("types limits the run; replay mode touches only the listed ids, notes and SVG owners", async () => {
    const { T, world } = loadVm();
    const v = plain(await T.fns.compact({ phase: "validate", types: ["burg", "marker"], details: true }));
    assert.deepEqual(v.compacted, { burg: 1 });
    assert.deepEqual(v.details.notes.sort(), ["burg2", "burg3", "marker7"]);
    const r = plain(
      await T.fns.compact({
        phase: "apply",
        ids: { burg: [1, 2, 3, 99], culture: [2] },
        noteIds: ["zone2", "zone1", "nope"],
        svgIds: {}
      })
    );
    // live burg 1, kept burg 3 and missing 99 are skipped; the live zone's note stays
    const { bytes: _b, ...resolved } = r.resolved;
    assert.deepEqual(resolved, { ids: { burg: [2], culture: [2] }, notes: ["zone2"], svg: {}, kept: 1 });
    assert.equal(world.pack.burgs[1].name, "Live");
    assert.equal(world.pack.states[3].name, "Gone", "unlisted types are untouched");
    const bad = await T.call("compact", { phase: "validate", types: ["feature"] });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, "BAD_ARGS");
  });

  test("ranges and stub helpers", () => {
    const { T } = loadVm();
    assert.equal(T.compact.ranges([5, 1, 2, 3, 9, 10, 3]), "1-3,5,9-10");
    assert.equal(T.compact.ranges([]), "");
    assert.equal(T.compact.u8("aé€😀"), 1 + 2 + 3 + 4);
    assert.deepEqual(plain(T.compact.noteOwner("stateLabel4")), { type: "state", i: 4 });
    assert.deepEqual(plain(T.compact.noteOwner("regiment2-7")), { type: "regiment", i: 2, sub: 7 });
    assert.equal(T.compact.noteOwner("burgLabel3"), null);
    assert.equal(T.compact.noteOwner("route-tunnels"), null);
  });
});

// ---------------------------------------------------------------- part 2: in the app

/** Which entities the setup removes (no capitals, market centres or removed states' burgs). */
const PICK = `
const states = pack.states.filter(s => s.i && !s.removed).sort((a, b) => (a.cells || 0) - (b.cells || 0));
const pairs = [];
for (const s of states) {
  if (pairs.length >= 2) break;
  const used = pairs.flat();
  if (used.includes(s.i)) continue;
  const into = (s.neighbors || []).find(n => n && !used.includes(n) && pack.states[n] && !pack.states[n].removed);
  if (into) pairs.push([s.i, into]);
}
const used = pairs.flat();
const removeStates = states.map(s => s.i).filter(i => !used.includes(i)).slice(0, 2);
const isMarket = new Set((pack.markets || []).map(m => m.centerBurgId));
const dealt = new Set();
for (const d of pack.deals || []) { if (d.sellerType === "burg") dealt.add(d.seller); if (d.buyerType === "burg") dealt.add(d.buyer); }
const centres = new Set(pack.provinces.filter(p => p && p.i && !p.removed && !removeStates.includes(p.state)).map(p => p.burg));
const anyCentre = new Set(pack.provinces.filter(p => p && p.i && !p.removed).map(p => p.burg));
const burgs = pack.burgs.filter(b => b && b.i && !b.removed && !b.capital && !isMarket.has(b.i));
// demo.map trades with nearly every burg; the setup regenerates production after removing these
const free = burgs.filter(b => !anyCentre.has(b.i)).slice(0, 280).map(b => b.i);
const provBurgs = burgs.filter(b => centres.has(b.i)).slice(0, 5).map(b => b.i);
const cultures = pack.cultures.filter(c => c.i && !c.removed).map(c => c.i);
const routes = pack.routes.slice(-3).map(r => r.i);
const zones = pack.zones.slice(-2).map(z => z.i);
const rivers = pack.rivers.filter(r => !pack.rivers.some(o => o.i !== r.i && (o.parent === r.i || o.basin === r.i))).slice(-2).map(r => r.i);
const markers = pack.markers.slice(-2).map(m => m.i);
return { free, provBurgs, pairs, removeStates, cultures: cultures.slice(-2), routes, zones, rivers, markers };`;

/** Live burgs that a trade deal names (picked after production was regenerated). */
const TRADED = `
const isMarket = new Set((pack.markets || []).map(m => m.centerBurgId));
const centres = new Set(pack.provinces.filter(p => p && p.i && !p.removed).map(p => p.burg));
const dealt = new Set();
for (const d of pack.deals || []) { if (d.sellerType === "burg") dealt.add(d.seller); if (d.buyerType === "burg") dealt.add(d.buyer); }
const freeDealt = args.free.filter(i => dealt.has(i)).length;
const traded = pack.burgs.filter(b => b && b.i && !b.removed && !b.capital && !isMarket.has(b.i) && !centres.has(b.i) && dealt.has(b.i)).slice(0, 10).map(b => b.i);
return { traded, freeDealt };`;

/** Copies of the app's merge / culture / religion / province removal (module-private there). */
const REMOVE_REST = `
const { pairs, cultures } = args;
// mergeStates (states-editor.ts): the merged state keeps its whole record. For the first pair the
// other states' neighbors and campaigns are cleaned too; the second stays a neighbor of its ruler.
pairs.forEach(([from, into], k) => {
  pack.states[from].removed = true;
  for (const b of pack.burgs) if (b && b.state === from) { if (b.capital) { b.capital = 0; Burgs.changeGroup(b, null); } b.state = into; }
  for (const p of pack.provinces) if (p && p.state === from) p.state = into;
  pack.cells.state.forEach((v, c) => { if (v === from) pack.cells.state[c] = into; });
  if (k === 0)
    for (const o of pack.states) {
      if (!o || !o.i || o.removed) continue;
      if (o.neighbors) o.neighbors = o.neighbors.filter(n => n !== from);
      if (o.campaigns) o.campaigns = o.campaigns.filter(c => c.attacker !== from && c.defender !== from);
    }
  notes.push({ id: "regiment" + from + "-0", name: "Old regiment", legend: "" });
});
// removeReligion (religions-editor.ts): every religion of the first culture, and one more
const removeReligion = id => {
  pack.cells.religion.forEach((r, c) => { if (r === id) pack.cells.religion[c] = 0; });
  pack.religions[id].removed = true;
  for (const r of pack.religions) if (r.i && !r.removed) { r.origins = (r.origins || []).filter(o => o !== id); if (!r.origins.length) r.origins = [0]; }
};
const ofCulture = pack.religions.filter(r => r.i && !r.removed && r.culture === cultures[0]);
ofCulture.forEach(r => removeReligion(r.i));
const other = pack.religions.find(r => r.i && !r.removed && r.type !== "Folk" && r.culture !== cultures[1]);
if (other) removeReligion(other.i);
// removeCulture (cultures-editor.ts)
for (const id of cultures) {
  for (const b of pack.burgs) if (b && b.culture === id) b.culture = 0;
  for (const s of pack.states) if (s.culture === id) s.culture = 0;
  pack.cells.culture.forEach((c, i) => { if (c === id) pack.cells.culture[i] = 0; });
  pack.cultures[id].removed = true;
  for (const c of pack.cultures) if (c.i && !c.removed) { c.origins = (c.origins || []).filter(o => o !== id); if (!c.origins.length) c.origins = [0]; }
}
// heightmap-editor.js: a province left with no cells keeps its whole record
const prov = pack.provinces.find(p => p && p.i && !p.removed && !pack.states[p.state].removed && pack.states[p.state].provinces.length > 1 && p.burg && !pack.burgs[p.burg].removed && !pack.burgs[p.burg].capital);
if (prov) {
  const st = pack.states[prov.state];
  st.provinces = st.provinces.filter(x => x !== prov.i);
  pack.cells.province.forEach((v, c) => { if (v === prov.i) pack.cells.province[c] = 0; });
  prov.removed = true;
}
// leftovers compact clears: notes and SVG of removed burgs, a deleted label's note
const gone = args.free.slice(0, 3);
for (const i of gone) notes.push({ id: "burg" + i, name: "Stale " + i, legend: "" });
notes.push({ id: "label99999", name: "Label that was deleted", legend: "" });
const ns = "http://www.w3.org/2000/svg";
const icons = document.querySelector("#burgIcons g") || document.getElementById("burgIcons");
const use = document.createElementNS(ns, "use"); use.id = "burg" + gone[0]; icons.appendChild(use);
const sym = document.createElementNS(ns, "symbol"); sym.id = "burgCOA" + gone[1]; document.getElementById("defs-emblems").appendChild(sym);
const routesG = document.querySelector("#routes g") || document.getElementById("routes");
const path = document.createElementNS(ns, "path"); path.id = "route99999"; routesG.appendChild(path);
return { province: prov ? prov.i : null, religions: [...ofCulture.map(r => r.i), ...(other ? [other.i] : [])] };`;

const STATS = `
const count = list => list.filter(x => x && typeof x === "object" && x.removed).length;
const full = (list, keep) => list.filter(x => x && typeof x === "object" && x.removed && Object.keys(x).some(k => !["i", "removed", ...keep].includes(k))).length;
return {
  lengths: { burgs: pack.burgs.length, states: pack.states.length, provinces: pack.provinces.length, cultures: pack.cultures.length, religions: pack.religions.length },
  removed: { burgs: count(pack.burgs), states: count(pack.states), provinces: count(pack.provinces), cultures: count(pack.cultures), religions: count(pack.religions) },
  full: { burgs: full(pack.burgs, []), states: full(pack.states, []), provinces: full(pack.provinces, []), cultures: full(pack.cultures, ["base", "center"]), religions: full(pack.religions, []) },
  notes: notes.length,
  orphanSvg: ["route99999", "burg" + args.free[0], "burgCOA" + args.free[1]].filter(id => document.getElementById(id)).length
};`;

/** Open every editor and overview, click their refresh/chart/toggle buttons, hover the map. */
const EXERCISE = `
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = [];
const click = async (id, wait) => {
  const el = document.getElementById(id);
  if (!el) { log.push("missing " + id); return; }
  el.click();
  await sleep(wait);
};
const change = async (id, values) => {
  const el = document.getElementById(id);
  if (!el) { log.push("missing " + id); return; }
  for (const v of values) { el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); await sleep(150); }
};
const done = () => { closeDialogs(); customization = 0; };
const editors = {
  editStatesButton: ["statesEditorRefresh", "statesPercentage", "statesPercentage", "statesChart"],
  editProvincesButton: ["provincesEditorRefresh", "provincesPercentage", "provincesPercentage", "provincesChart"],
  editDiplomacyButton: ["diplomacyEditorRefresh", "diplomacyHistory", "diplomacyShowMatrix"],
  editCulturesButton: ["culturesEditorRefresh", "culturesPercentage", "culturesPercentage", "culturesHeirarchy"],
  editReligions: ["religionsEditorRefresh", "religionsExtinct", "religionsExtinct", "religionsPercentage", "religionsPercentage", "religionsHeirarchy"],
  editBiomesButton: ["biomesEditorRefresh"],
  editZonesButton: ["zonesEditorRefresh", "zonesPercentage", "zonesPercentage"],
  editNotesButton: [],
  editUnitsButton: [],
  editEmblemButton: [],
  editNamesBaseButton: [],
  editGoods: [],
  editTradeAnimationButton: [],
  overviewBurgsButton: ["burgsOverviewRefresh", "burgsChart"],
  overviewRoutesButton: ["routesOverviewRefresh"],
  overviewRiversButton: ["riversOverviewRefresh"],
  overviewMilitaryButton: ["militaryOverviewRefresh", "militaryPercentage", "militaryPercentage"],
  overviewMarkersButton: ["markersOverviewRefresh"],
  overviewMarketsButton: [],
  overviewChartsButton: [],
  overviewCellsButton: []
};
const appear = async id => {
  for (let k = 0; k < 250 && !document.getElementById(id)?.offsetParent; k++) await sleep(100);
};
for (const [open, inner] of Object.entries(editors)) {
  await click(open, 500);
  if (inner.length) await appear(inner[0]); // editors in lazy modules build their dialog on first open
  for (const id of inner) await click(id, 250);
  done();
  await sleep(100);
}
const burg = pack.burgs.find(b => b && b.i && !b.removed);
editBurg(burg.i);
await sleep(400);
done();
// tooltips and note boxes: hover a grid of points under four layer presets
const box = document.getElementById("map").getBoundingClientRect();
const vb = document.getElementById("viewbox");
for (const preset of ["political", "cultural", "religions", "provinces"]) {
  setLayersPreset(preset);
  await sleep(200);
  for (let gx = 1; gx < 5; gx++) for (let gy = 1; gy < 4; gy++) {
    const cx = box.left + viewX + ((graphWidth * gx) / 5) * scale;
    const cy = box.top + viewY + ((graphHeight * gy) / 4) * scale;
    const at = document.elementFromPoint(cx, cy);
    const target = at && vb.contains(at) ? at : vb;
    target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: cx, clientY: cy }));
    await sleep(130);
  }
}
setLayersPreset("political");
done();
return log;`;

describe("compact in the app (demo.map with removed entities)", () => {
  let h: Harness;
  let pick: Obj;
  let before0: Obj;
  const files = { plain: "", compact: "" };

  // the notes editor loads tinymce from the web, which the offline test browser blocks; the name
  // generator logs (and falls back) when a random word comes out shorter than 2 letters
  const OFFLINE = /Failed to fetch dynamically imported module: https:\/\/azgaar\.github\.io\/.*tinymce/;
  const BENIGN = /^Name is too short! Random name will be selected$/;
  const noErrors = (r: Obj, what: string) => {
    const errs = ((r.consoleErrors as string[]) ?? []).filter(e => !OFFLINE.test(e) && !BENIGN.test(e));
    assert.deepEqual(errs, [], `${what}: console errors ${JSON.stringify(errs)}`);
  };
  const stats = async () => (await h.ok("eval", { code: STATS, args: pick, readOnly: true })).value as Obj;

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    await h.ok("load_map", { path: DEMO_MAP });
    pick = (await h.ok("eval", { code: PICK, readOnly: true })).value as Obj;
    assert.equal(pick.free.length, 280, JSON.stringify(pick).slice(0, 300));
    assert.equal(pick.provBurgs.length, 5, JSON.stringify(pick).slice(0, 300));
    assert.equal(pick.pairs.length, 2, "two state merges");
    await h.ok("add", {
      type: "note",
      items: [
        { entity: { type: "route", ref: pick.routes[0] }, name: "Old road" },
        { entity: { type: "river", ref: pick.rivers[0] }, name: "Old river" },
        { id: `zone${pick.zones[0]}`, name: "Old zone" }
      ]
    });
    // the app's own removal paths through edit (Burgs.remove, stateRemove, Routes/Rivers.remove, ...)
    const rm = (type: string, ids: number[]) =>
      h.ok("edit", { type, ops: ids.map(ref => ({ ref, remove: true })), redraw: false });
    await rm("burg", [...pick.free, ...pick.provBurgs]);
    await rm("state", pick.removeStates);
    await rm("route", pick.routes);
    await rm("river", pick.rivers);
    await rm("zone", pick.zones);
    await rm("marker", pick.markers);
    // new deals leave the removed burgs out; burgs removed after this stay in deals (kept whole)
    await h.ok("regenerate", { parts: ["production"], restoreLayers: true }, 240_000);
    const t = (await h.ok("eval", { code: TRADED, args: pick, readOnly: true })).value as Obj;
    assert.equal(t.freeDealt, 0, "regenerated deals name no removed burg");
    assert.ok(t.traded.length >= 3, JSON.stringify(t));
    pick.traded = t.traded;
    await rm("burg", pick.traded);
    const rest = (await h.ok("eval", { code: REMOVE_REST, args: pick })).value as Obj;
    assert.ok(rest.province, "a province was removed the heightmap-editor way");
    assert.ok(rest.religions.length >= 1);
    before0 = await stats();
    assert.ok(before0.removed.burgs >= 290, JSON.stringify(before0));
    assert.equal(before0.orphanSvg, 3);
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("dryRun counts without changing anything; details lists ranges and the kept records", async () => {
    const r = await h.ok("compact", { dryRun: true, details: true });
    noErrors(r, "dryRun");
    assert.equal(r.dryRun, true);
    const c = r.compacted as Obj;
    assert.equal(c.burg, pick.free.length);
    assert.equal(c.state, 1, "the merge whose references were cleaned");
    assert.equal(c.province, 1, "the heightmap-editor province");
    assert.ok(c.culture >= 1 && c.religion >= 1, JSON.stringify(c));
    const kept = r.kept as Obj;
    assert.equal(kept.burg, pick.traded.length + pick.provBurgs.length, `deal parties and province centres stay whole`);
    assert.equal(kept.state, 1, "the merge still in a live state's neighbors stays whole");
    assert.match(String(r.keptWhy), /regenerate \{parts:\['production'\]\}/);
    const by = (r.keptBy as Obj).burg as Obj;
    assert.equal(by.provinceBurg, pick.provBurgs.length, JSON.stringify(r.keptBy));
    assert.equal(by.deal, pick.traded.length, JSON.stringify(r.keptBy));
    assert.match(String(r.keptWhy), /provinceBurg \(\d+\): compact \{repointProvinces:true\}/);
    const d = r.details as Obj;
    assert.ok(d.kept.some((k: Obj) => k.type === "burg" && /^deal /.test(k.by)));
    assert.ok(d.kept.some((k: Obj) => k.type === "burg" && /^province \d+ burg$/.test(k.by)));
    assert.ok(d.kept.some((k: Obj) => k.type === "state" && /neighbors|campaigns/.test(k.by)));
    for (const id of [
      "label99999",
      `burg${pick.free[0]}`,
      `route${pick.routes[0]}`,
      `river${pick.rivers[0]}`,
      `zone${pick.zones[0]}`,
      `regiment${pick.pairs[0][0]}-0`,
      `regiment${pick.pairs[1][0]}-0`
    ])
      assert.ok(d.notes.includes(id), `note ${id} is dropped: ${JSON.stringify(d.notes)}`);
    assert.ok((r.svgDropped as number) >= 3, `svg ${r.svgDropped}`);
    assert.ok((r.bytesSaved as number) > 100_000, `bytes ${r.bytesSaved}`);
    assert.deepEqual(await stats(), before0, "dryRun changed the map");
  });

  test("save_map compact:true writes a smaller file and leaves the page as it was", async () => {
    const p = await h.ok("save_map", { path: "plain.map", overwrite: true });
    const c = await h.ok("save_map", { path: "compact.map", overwrite: true, compact: true });
    noErrors(c, "save compact");
    files.plain = p.path as string;
    files.compact = c.path as string;
    const cc = c.compacted as Obj;
    assert.equal(cc.burg, pick.free.length);
    assert.equal(typeof cc.notesDropped, "number");
    const saved = cc.bytesSaved as number;
    assert.ok(saved > 100_000, `saved ${saved}`);
    const sizes = [fs.statSync(files.plain).size, fs.statSync(files.compact).size];
    assert.ok(Math.abs(sizes[0] - sizes[1] - saved) < 64, `${sizes} vs ${saved}`);
    assert.deepEqual(await stats(), before0, "save compact:true changed the page");
    assert.equal(p.compacted, undefined);
  });

  test("compact in the page: stubs keep every slot, ids continue at the array length, undo restores", async () => {
    const r = await h.ok("compact", {});
    noErrors(r, "compact");
    assert.match(String(r.undo), /undo/);
    assert.equal(r.resolved, undefined, "the resolved form goes to the sketch log, not the result");
    const now = await stats();
    assert.deepEqual(now.lengths, before0.lengths, "no slot dropped");
    assert.deepEqual(now.removed, before0.removed, "nothing revived or lost");
    assert.equal(now.full.burgs, pick.traded.length + pick.provBurgs.length);
    assert.equal(now.full.states, 1);
    assert.equal(now.full.provinces, 0);
    assert.equal(now.orphanSvg, 0);
    assert.ok(now.notes < before0.notes);
    const shape = await h.ok("eval", {
      code: `[pack.burgs[args.free[7]], pack.states[args.pairs[0][0]], pack.cultures[args.cultures[0]]]`,
      args: pick,
      readOnly: true
    });
    const [b, s, cu] = shape.value as Obj[];
    assert.deepEqual(b, { i: pick.free[7], removed: true });
    assert.deepEqual(s, { i: pick.pairs[0][0], removed: true });
    assert.deepEqual(Object.keys(cu).sort(), ["base", "center", "i", "removed"]);
    const again = await h.ok("compact", {});
    assert.match(String(again.note), /nothing to compact/);
    // a new burg takes the next id after the last slot (stubs included)
    const at = (
      await h.ok("eval", {
        code: `const c = pack.cells; const i = [...c.i].find(k => c.h[k] >= 20 && !c.burg[k] && c.c[k].every(n => !c.burg[n])); return { x: c.p[i][0], y: c.p[i][1] };`,
        readOnly: true
      })
    ).value as Obj;
    const added = await h.ok("add", { type: "burg", items: [{ at, name: "Newtown" }] });
    assert.equal((added.created as Obj[])[0].i, before0.lengths.burgs);
    // a compacted id still answers REMOVED
    const gone = await h.call("inspect", { entity: { type: "burg", ref: pick.free[5] } });
    assert.equal(gone.isError, true);
    assert.equal(errorBody(gone).error.code, "REMOVED");
    await h.ok("snapshot", { action: "undo", n: 2 });
    const back = await stats();
    const { orphanSvg: _a, ...b0 } = before0;
    const { orphanSvg: _b, ...b1 } = back;
    assert.deepEqual(b1, b0, "undo restores the whole records and notes");
  });

  test("repointProvinces releases burgs held only as province capitals; changes lists live edits; refused under an editor", async () => {
    await h.ok("eval", { code: "customization = 1; return 1" });
    const busy = await h.call("compact", {});
    await h.ok("eval", { code: "customization = 0; return 1" });
    assert.equal(errorBody(busy).error.code, "REFUSED");
    assert.match(errorBody(busy).error.message, /customization=1/);
    assert.deepEqual(await stats(), before0, "a refused compact changed the map");
    const r = await h.ok("compact", { repointProvinces: true, details: true, limit: 500 });
    noErrors(r, "compact repointProvinces");
    assert.equal(r.repointed, pick.provBurgs.length);
    assert.equal((r.compacted as Obj).burg, pick.free.length + pick.provBurgs.length);
    assert.equal((r.kept as Obj).burg, pick.traded.length, "only the deal parties stay whole");
    assert.equal((r.details as Obj).keptTruncated, undefined);
    const changes = r.changes as Obj;
    assert.equal(changes.province.counts.modified, pick.provBurgs.length, JSON.stringify(changes.province));
    assert.ok(changes.note.counts.removed >= 3, JSON.stringify(changes.note?.counts));
    assert.equal(changes.burg, undefined, "stubs are not live data");
    const prov = await h.ok("eval", {
      readOnly: true,
      args: pick,
      code: `return pack.provinces.filter(p => p && p.i && !p.removed && p.burg && pack.burgs[p.burg].removed).length;`
    });
    assert.equal(prov.value, 0, "no live province names a removed capital");
    await h.ok("snapshot", { action: "undo" });
    const back = await stats();
    const { orphanSvg: _a, ...b0 } = before0;
    const { orphanSvg: _b, ...b1 } = back;
    assert.deepEqual(b1, b0);
    const dry = await h.ok("compact", { dryRun: true });
    assert.equal((dry.kept as Obj).burg, pick.traded.length + pick.provBurgs.length, "undo put the capitals back");
  });

  test("the compacted file loads cleanly; editors, overviews, charts, tooltips and ?burg= run without errors", async () => {
    const l = await h.ok("load_map", { path: files.compact });
    noErrors(l, "load compacted");
    const s = await stats();
    assert.deepEqual(s.lengths, before0.lengths);
    assert.deepEqual(s.removed, before0.removed);
    assert.equal(s.full.burgs, pick.traded.length + pick.provBurgs.length);
    noErrors(await h.ok("map_info", {}), "map_info");
    const ex = await h.ok("eval", { code: EXERCISE, timeoutMs: 240_000 }, 270_000);
    noErrors(ex, "editors");
    assert.deepEqual(ex.value, [], `missing elements: ${JSON.stringify(ex.value)}`);
    // the culture name generator reads base from a culture slot picked at random, stubs included;
    // focusOn (every load) zooms to ?burg=<id>, which for a stub has no coordinates
    const misc = await h.ok("eval", {
      code: `
        const stub = pack.cultures.find(c => c.removed && !c.name);
        const name = Names.getCulture(stub.i, 5, 8, "");
        const before = [viewX, viewY, scale];
        history.replaceState(null, "", "?burg=" + args.free[9]);
        focusOn();
        history.replaceState(null, "", location.pathname);
        await new Promise(r => setTimeout(r, 300));
        return { name: typeof name, view: [viewX, viewY, scale].every(Number.isFinite), same: before.join() === [viewX, viewY, scale].join() };`,
      args: pick
    });
    noErrors(misc, "culture name / focusOn");
    assert.deepEqual(misc.value, { name: "string", view: true, same: true });
    // the editors just wrote statistics onto culture and religion stubs; the cultures editor's
    // auto-change writes burg.culture (undefined) onto burg stubs: none of that is work for compact.
    // The provinces editor, on opening, moved the provinces' capitals off the removed burgs (what
    // repointProvinces does), so those burgs are free to compact now.
    await h.ok("eval", {
      code: `for (const b of pack.burgs) if (b && b.removed && !b.name) b.culture = pack.cells.culture[b.cell]; return 1;`
    });
    const again = await h.ok("compact", { dryRun: true });
    assert.deepEqual(again.compacted, { burg: pick.provBurgs.length }, JSON.stringify(again));
    assert.equal(((again.keptBy as Obj).burg as Obj).provinceBurg, undefined);
    for (const type of ["burg", "state", "province", "culture", "religion"])
      noErrors(await h.ok("find", { type, limit: 3 }), `find ${type}`);
    noErrors(await h.ok("screenshot", { full: true, maxSide: 512 }), "screenshot");
  });

  test("exports of the compacted map", async () => {
    for (const [format, ext] of [
      ["json-full", "json"],
      ["json-minimal", "json"],
      ["geojson-cells", "geojson"],
      ["geojson-routes", "geojson"],
      ["geojson-markers", "geojson"],
      ["svg", "svg"]
    ]) {
      const r = await h.ok("export", { format, path: `exp/c-${format}.${ext}`, overwrite: true });
      noErrors(r, `export ${format}`);
      assert.ok((r.bytes as number) > 100, format);
    }
  });

  test("regenerate on the compacted map, then the editors again", async () => {
    for (const parts of [
      ["emblems"],
      ["population"],
      ["military"],
      ["markers"],
      ["zones"],
      ["routes"],
      ["provinces"],
      ["religions"],
      ["markets", "production"],
      ["states"],
      ["cultures"],
      ["burgs"]
    ]) {
      const r = await h.ok("regenerate", { parts, restoreLayers: true }, 240_000);
      noErrors(r, `regenerate ${parts}`);
    }
    const ex = await h.ok("eval", { code: EXERCISE, timeoutMs: 240_000 }, 270_000);
    noErrors(ex, "editors after regenerate");
  });

  test("the plain save still loads, and compacting it in the page matches the compact:true save", async () => {
    const l = await h.ok("load_map", { path: files.plain });
    noErrors(l, "load plain");
    const c = await h.ok("compact", {});
    noErrors(c, "compact after load");
    const v = await h.ok("save_map", { path: "via-page.map", overwrite: true });
    const diff = fs.statSync(v.path as string).size - fs.statSync(files.compact).size;
    assert.ok(Math.abs(diff) < 512, `via page vs compact:true: ${diff} bytes`);
  });
});

// ---------------------------------------------------------------- part 3: sketch log and replay

const PICK3 = `
const C = pack.cells;
const market = new Set((pack.markets || []).map(m => m.centerBurgId));
const dealt = new Set();
for (const d of pack.deals || []) { if (d.sellerType === "burg") dealt.add(d.seller); if (d.buyerType === "burg") dealt.add(d.buyer); }
const centres = new Set(pack.provinces.filter(p => p && p.i && !p.removed).map(p => p.burg));
const bs = pack.burgs.filter(b => b && b.i && !b.removed && !b.capital && !market.has(b.i) && !centres.has(b.i));
const free = c => C.h[c] >= 20 && !C.burg[c] && C.c[c].every(k => !C.burg[k]);
const cells = [...C.i].filter(free);
const a = cells[Math.floor(cells.length / 3)], b = cells[Math.floor((cells.length * 2) / 3)];
// X: a burg a trade deal names (kept whole); Y: one no deal names, when demo.map has one
const X = bs.find(x => dealt.has(x.i)), Y = bs.find(x => !dealt.has(x.i));
return { X: X.i, Y: Y ? Y.i : null, zone: pack.zones[0].i, newAt: { x: C.p[a][0], y: C.p[a][1] }, otherAt: { x: C.p[b][0], y: C.p[b][1] } };`;

describe("compact in a sketch (logged with its resolved ids, replayed onto another base)", () => {
  let h: Harness;
  let pk: Obj;
  let other = "";
  let made = 0;

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    await h.ok("load_map", { path: DEMO_MAP });
    pk = (await h.ok("eval", { code: PICK3, readOnly: true })).value as Obj;
    // "someone else" adds a burg: it takes the id the sketch's burg will have
    await h.ok("eval", {
      code: `const id = Burgs.add([args.otherAt.x, args.otherAt.y]); pack.burgs[id].name = "Theirford"; return id;`,
      args: pk
    });
    other = (await h.ok("save_map", { path: "other.map", overwrite: true })).path as string;
    await h.ok("load_map", { path: DEMO_MAP });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("compact is logged replayable with the ids it compacted and a plain summary", async () => {
    const st = await h.ok("sketch", { action: "start", slug: "t-compact" });
    assert.equal((st.base as Obj).kind, "file");
    const add = await h.ok("add", { type: "burg", items: [{ at: pk.newAt, name: "Sketchburg" }] });
    made = (add.created as Obj[])[0].i;
    await h.ok("add", { type: "note", items: [{ id: `zone${pk.zone}`, name: "Old zone" }] });
    const stubbed = [pk.Y, made].filter(i => i !== null) as number[];
    await h.ok("edit", { type: "burg", ops: [pk.X, ...stubbed].map(ref => ({ ref, remove: true })) });
    await h.ok("edit", { type: "zone", ops: [{ ref: pk.zone, remove: true }] });
    const c = await h.ok("compact", {});
    assert.deepEqual(c.compacted, { burg: stubbed.length });
    assert.deepEqual(c.kept, { burg: 1 }, "the burg a deal names stays whole");
    assert.equal(c.notesDropped, 1);
    const status = await h.ok("sketch", { action: "status" });
    const log = status.log as Obj[];
    assert.deepEqual(
      log.map(o => o.tool),
      ["add", "add", "edit", "edit", "compact"]
    );
    const n = stubbed.length;
    assert.match(
      log[4].summary,
      new RegExp(
        `^Shrank ${n} removed burg records? to id-keeping stubs \\(no live entity changed\\); dropped 1 note; about \\d+ (KB|B) smaller; 1 still referenced and kept whole\\.$`
      ),
      log[4].summary
    );
    assert.equal(status.blobOnly, false);
    const full = await h.ok("sketch", { action: "status", full: true });
    const rec = (full.records as Obj[])[4];
    assert.deepEqual(
      [...rec.resolved.ids.burg].sort((a: number, b: number) => a - b),
      [...stubbed].sort((a, b) => a - b)
    );
    assert.deepEqual(rec.resolved.notes, [`zone${pk.zone}`]);
  });

  test("rebase onto a copy where someone else took the burg's id: compact follows the id map", async () => {
    const r = await h.ok("sketch", { action: "rebase", onto: { path: other } }, 240_000);
    assert.equal(r.completed, true, JSON.stringify(r.conflicts));
    assert.deepEqual(r.applied, [1, 2, 3, 4, 5]);
    const moved = (r.idMap as Obj).burg[String(made)];
    assert.equal(moved, made + 1, JSON.stringify(r.idMap));
    const ev = await h.ok("eval", {
      readOnly: true,
      args: { ...pk, made, moved },
      code: `return {
        X: pack.burgs[args.X], Y: args.Y === null ? null : pack.burgs[args.Y], moved: pack.burgs[args.moved],
        theirs: { name: pack.burgs[args.made].name, removed: !!pack.burgs[args.made].removed },
        note: notes.some(n => n.id === "zone" + args.zone)
      };`
    });
    const v = ev.value as Obj;
    assert.equal(v.X.removed, true);
    assert.ok(v.X.name, "the burg a deal names is still whole after replay");
    if (pk.Y !== null) assert.deepEqual(v.Y, { i: pk.Y, removed: true });
    assert.deepEqual(v.moved, { i: moved, removed: true });
    assert.deepEqual(
      v.theirs,
      { name: "Theirford", removed: false },
      "their burg in the sketch's old slot is untouched"
    );
    assert.equal(v.note, false);
  });
});

// ---------------------------------------------------------------- part 4: the gated writes

const LOCAL_ENTRY = /src="\/(index-[^"]+\.js)"/.exec(
  fs.readFileSync(path.join(REPO_ROOT, "dist", "index.html"), "utf8")
)?.[1];
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const sendsBytes = (p: Obj) => Number(/\((\d+) bytes/.exec(String((p.sends as string[])[0]))?.[1]);

describe("compact:true on shared_save, sketch save and sketch_promote (live mode, fake Worker)", () => {
  let fake: FakeWorker;
  let h: Harness;
  let pick: Obj;
  const puts = () => fake.requests.filter(r => r.method === "PUT");
  const N = 40;

  before(async () => {
    fake = new FakeWorker({ seedFile: DEMO_MAP, version: 3, entry: LOCAL_ENTRY });
    const origin = await fake.start();
    h = await startServer({ TUPAIA_MODE: "live", TUPAIA_LIVE_ORIGIN: origin, TUPAIA_BUILD_CACHE_MS: "0" });
    // the first launch loads shared v3: remove N burgs nothing else names, then rebuild the deals
    pick = (await h.ok("eval", { code: PICK, readOnly: true })).value as Obj;
    await h.ok("edit", {
      type: "burg",
      ops: (pick.free as number[]).slice(0, N).map(ref => ({ ref, remove: true })),
      redraw: false
    });
    await h.ok("regenerate", { parts: ["production"], restoreLayers: true }, 240_000);
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
    await fake?.stop();
  });

  test("shared_save: the preview shows the saving; the token holds only with the same flag; the PUT body is compacted", async () => {
    const plainPrev = await h.ok("shared_save", {});
    const p = await h.ok("shared_save", { compact: true });
    assert.equal(typeof p.token, "string", String(p.refusalReason));
    assert.equal(plainPrev.compacted, undefined);
    const c = p.compacted as Obj;
    assert.equal(c.burg, N);
    assert.ok(c.bytesSaved > 10_000, JSON.stringify(c));
    assert.equal((plainPrev.bytes as number) - (p.bytes as number), c.bytesSaved, "bytesSaved is exact");
    assert.match(String(p.next), /shared_save \{confirm:true, token:'[0-9a-f]+', compact:true\}/);
    assert.equal(puts().length, 0);
    // a compact preview's token does not confirm a plain write, nor a plain preview's a compact one
    const plainConfirm = await h.call("shared_save", { confirm: true, token: p.token as string });
    assert.equal(errorBody(plainConfirm).error.code, "REFUSED");
    assert.match(errorBody(plainConfirm).error.message, /flags differ/);
    const crossed = await h.call("shared_save", { confirm: true, token: plainPrev.token as string, compact: true });
    assert.equal(errorBody(crossed).error.code, "REFUSED");
    assert.match(errorBody(crossed).error.message, /flags differ/);
    assert.equal(puts().length, 0);
    const r = await h.ok("shared_save", { confirm: true, token: p.token as string, compact: true });
    assert.equal((r.saved as Obj).version, 4);
    assert.equal(puts().length, 1);
    assert.equal(sha(fake.current), p.sha256, "the PUT body is the previewed compacted text");
    assert.equal(fake.current.length, p.bytes);
    assert.equal((r.compacted as Obj).bytesSaved, c.bytesSaved);
    const ev = await h.ok("eval", { readOnly: true, code: `return typeof pack.burgs[${pick.free[0]}].name` });
    assert.equal(ev.value, "string", "the page keeps its whole records");
  });

  test("sketch save compact:true writes a compacted sketch blob; sketch_promote compact:true gates and PUTs the compacted map", async () => {
    await h.ok("sketch", { action: "start", slug: "slim" });
    await h.ok("edit", { type: "burg", ops: [{ ref: pick.free[N + 1], set: { name: "Slimford" } }] });
    const plainSave = await h.ok("sketch", { action: "save" });
    const p = await h.ok("sketch", { action: "save", compact: true });
    assert.equal(plainSave.compacted, undefined);
    const c = p.compacted as Obj;
    assert.equal(c.burg, N);
    assert.equal(sendsBytes(plainSave) - sendsBytes(p), c.bytesSaved);
    assert.match(String(p.next), /sketch \{action:'save', confirm:true, compact:true\}/);
    fake.clearLog();
    const r = await h.ok("sketch", { action: "save", confirm: true, compact: true });
    assert.deepEqual(
      fake.writes().map(q => `${q.method} ${q.path}`),
      ["PUT /api/map/sketch-slim", "PUT /api/map/sketch-slim/ops"]
    );
    assert.equal(fake.maps.get("sketch-slim")?.current.length, sendsBytes(p), "the sketch blob is compacted");
    assert.equal((r.compacted as Obj).bytesSaved, c.bytesSaved);

    fake.clearLog();
    const pp = await h.ok("sketch_promote", { compact: true });
    assert.equal(typeof pp.token, "string", String(pp.refusalReason));
    assert.equal((pp.compacted as Obj).burg, N);
    assert.match(String(pp.next), /sketch_promote \{confirm:true, token:'[0-9a-f]+', compact:true\}/);
    const plainConfirm = await h.call("sketch_promote", { confirm: true, token: pp.token as string });
    assert.equal(errorBody(plainConfirm).error.code, "REFUSED");
    assert.match(errorBody(plainConfirm).error.message, /flags differ/);
    assert.deepEqual(fake.writes(), []);
    const done = await h.ok("sketch_promote", { confirm: true, token: pp.token as string, compact: true });
    assert.deepEqual(
      fake.writes().map(q => `${q.method} ${q.path}`),
      ["PUT /api/map/shared"]
    );
    assert.equal(fake.writes()[0].headers["x-map-version"], "4");
    assert.equal((done.saved as Obj).version, 5);
    assert.equal(sha(fake.current), pp.sha256);
    assert.equal((done.compacted as Obj).burg, N);
  });

  test("the compacted shared map loads with stubs in the removed slots", async () => {
    const l = await h.ok("load_map", { source: "shared" });
    assert.equal((l.origin as Obj).sharedVersion, 5);
    assert.deepEqual(l.consoleErrors ?? [], []);
    const ev = await h.ok("eval", {
      readOnly: true,
      args: pick,
      code: `return { stub: pack.burgs[args.free[0]], renamed: pack.burgs[args.free[${N + 1}]].name, n: pack.burgs.length };`
    });
    const v = ev.value as Obj;
    assert.deepEqual(v.stub, { i: pick.free[0], removed: true });
    assert.equal(v.renamed, "Slimford");
    const nothing = await h.ok("compact", { dryRun: true });
    assert.deepEqual(nothing.compacted, {});
  });
});
