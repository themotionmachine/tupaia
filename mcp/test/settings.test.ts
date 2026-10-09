// Map settings through edit {type:'map'}: fields, locks, recalculate, map_info settings block,
// save/load persistence, undo, generate_map interplay, and sketch replay (both-changed check).
// Own servers on tests/fixtures/demo.map in local mode; never the live site.
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import { type EditResolved, summarizeOp } from "../src/ops.ts";
import { bothChanged, bridgeArgs } from "../src/replay.ts";
import { alive, errorBody, type Harness, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

const ALL = {
  mapSize: 12.5,
  latitude: 41.2,
  longitude: 63.7,
  temperatureEquator: 33,
  temperatureNorthPole: -35,
  temperatureSouthPole: -8,
  winds: [180, 90, 270, 0, 135, 45],
  precipitation: 222,
  distanceScale: 0.25,
  distanceUnit: "li",
  areaUnit: "acres",
  heightUnit: "f",
  heightExponent: 1.75,
  temperatureScale: "°R"
};

describe("tupaia-mcp map settings (edit map)", () => {
  let h: Harness;
  let _out = "";
  const evalRO = async (code: string, args?: unknown) =>
    ((await h.ok("eval", { code, args, readOnly: true })) as { value: any }).value;
  const settings = async () => ((await h.ok("map_info", { since: "none" })).settings as Obj) ?? {};
  const edit = (set: Obj, extra: Obj = {}) => h.ok("edit", { type: "map", ops: [{ set }], ...extra });
  const digest = () => evalRO("__tupaia.fns.digest().hash") as Promise<string>;
  const stored = (k: string) => evalRO(`localStorage.getItem(${JSON.stringify(k)})`);

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "40" });
    _out = fs.realpathSync(h.env.TUPAIA_OUT);
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("map_info carries a compact settings block with the locked names", async () => {
    const info = await h.ok("map_info", { since: "none" });
    const s = info.settings as Obj;
    for (const k of Object.keys(ALL)) assert.ok(k in s, `settings.${k}`);
    assert.deepEqual(s.locked, []);
    assert.equal(s.winds.length, 6);
    assert.ok(JSON.stringify(s).length < 600, `compact: ${JSON.stringify(s).length} chars`);
    // the same numbers the app computes the map from
    const app = await evalRO(
      `({ms: +mapSizeOutput.value, lat: +latitudeOutput.value, lon: +longitudeOutput.value, eq: options.temperatureEquator, prec: +precOutput.value})`
    );
    assert.deepEqual(app, {
      ms: s.mapSize,
      lat: s.latitude,
      lon: s.longitude,
      eq: s.temperatureEquator,
      prec: s.precipitation
    });
  });

  test("every field sets the app's own state (inputs, options, globals) and mapCoordinates", async () => {
    const r = await edit(ALL);
    const row = (r.applied as Obj[])[0];
    for (const k of Object.keys(ALL)) assert.deepEqual(row.after[k], (ALL as Obj)[k], `after.${k}`);
    assert.equal(row.before.mapSize !== 12.5, true);
    assert.equal(r.recalculated, undefined, "recalculate defaults to none");
    const app = await evalRO(`({
      ms: [mapSizeInput.value, mapSizeOutput.value], lat: [latitudeInput.value, latitudeOutput.value],
      lon: [longitudeInput.value, longitudeOutput.value], opts: [options.temperatureEquator, options.temperatureNorthPole,
      options.temperatureSouthPole], winds: options.winds, prec: [precInput.value, precOutput.value],
      ds: [distanceScale, distanceScaleInput.value], du: distanceUnitInput.value, au: areaUnit.value, hu: heightUnit.value,
      he: heightExponentInput.value, ts: temperatureScale.value, mc: mapCoordinates })`);
    assert.deepEqual(app.ms, ["12.5", "12.5"]);
    assert.deepEqual(app.lat, ["41.2", "41.2"]);
    assert.deepEqual(app.lon, ["63.7", "63.7"]);
    assert.deepEqual(app.opts, [33, -35, -8]);
    assert.deepEqual(app.winds, ALL.winds);
    assert.deepEqual(app.prec, ["222", "222"]);
    assert.deepEqual(app.ds, [0.25, "0.25"]);
    assert.deepEqual([app.du, app.au, app.hu, app.he, app.ts], ["li", "acres", "f", "1.75", "°R"]);
    // mapCoordinates follows mapSize / latitude / longitude (the .map file stores it next to them)
    assert.equal(app.mc.latT, 22.5);
    const mc = (await h.ok("map_info", { since: "none" })).mapCoordinates as Obj;
    assert.equal(mc.latT, 22.5);
    assert.equal(mc.latN, Math.round((90 - (180 - 22.5) * 0.412) * 10) / 10);
    assert.deepEqual(await settings(), { ...ALL, locked: [] });
  });

  test("synonyms and custom units; the '|' of the .map format and bad values are refused without changes", async () => {
    const r = await edit({ distanceUnit: "Kilometers", heightUnit: "meters", temperatureScale: "celsius" });
    assert.deepEqual((r.applied as Obj[])[0].after, { distanceUnit: "km", heightUnit: "m", temperatureScale: "°C" });
    const before = await digest();
    const bad: Array<[Obj, RegExp]> = [
      [{ mapSize: 0 }, /mapSize/],
      [{ mapSize: 101 }, /mapSize/],
      [{ latitude: "40" }, /latitude/],
      [{ temperatureEquator: 51 }, /temperatureEquator/],
      [{ winds: [1, 2, 3] }, /winds/],
      [{ winds: [0, 0, 0, 0, 0, 400] }, /winds\[5\]/],
      [{ precipitation: 501 }, /precipitation/],
      [{ heightExponent: 1 }, /heightExponent/],
      [{ distanceScale: 0 }, /distanceScale/],
      [{ distanceUnit: "a|b" }, /'\|'/],
      [{ areaUnit: "" }, /areaUnit/],
      [{ temperatureScale: "fizz" }, /temperatureScale/],
      [{ mapSize: { value: 5, lock: "yes" } }, /lock must be true or false/],
      [{ mapSize: { value: 5, color: "x" } }, /unexpected key/],
      [{ lock: ["nope"] }, /unknown setting/],
      [{ mapSize: { lock: true }, unlock: ["mapSize"] }, /locked and unlocked/]
    ];
    for (const [set, re] of bad) {
      const res = await h.call("edit", { type: "map", ops: [{ set }] });
      assert.equal(res.isError, true, JSON.stringify(set));
      assert.match(errorBody(res).error.message, re, JSON.stringify(set));
    }
    const unknown = await h.call("edit", { type: "map", ops: [{ set: { nonsense: 1 } }] });
    assert.equal(errorBody(unknown).error.code, "BAD_FIELD");
    const notMap = await h.call("edit", {
      type: "burg",
      ops: [{ ref: 1, set: { name: "x" } }],
      recalculate: "climate"
    });
    assert.match(errorBody(notMap).error.message, /recalculate applies to edit type 'map'/);
    assert.equal(await digest(), before, "nothing changed");
  });

  test("dryRun returns before/after, the locks that would change and the layers that would be stale", async () => {
    const r = await h.ok("edit", {
      type: "map",
      ops: [{ set: { mapSize: { value: 3, lock: true }, distanceScale: 2 }, lock: ["winds"], unlock: ["latitude"] }],
      dryRun: true
    });
    const row = ((r.plan as Obj[]) ?? [])[0];
    assert.deepEqual(row.after, { mapSize: 3, distanceScale: 2 });
    assert.equal(row.before.mapSize, 12.5);
    assert.deepEqual(row.locks, { lock: ["mapSize", "winds"], unlock: ["latitude"] });
    assert.ok(!("lock" in row.after) && !("unlock" in row.after));
    assert.ok(r.stale && Object.keys(r.stale).some(k => k.includes("temperature")), JSON.stringify(r.stale));
    assert.equal((await settings()).mapSize, 12.5, "dry run changed nothing");
    assert.deepEqual((await settings()).locked, []);
  });

  test("locks: {value, lock}, lock/unlock lists, lock-only ops and 'all' use the app's lock()/unlock()", async () => {
    const r = await h.ok("edit", {
      type: "map",
      ops: [
        {
          set: {
            mapSize: { value: 14, lock: true },
            temperatureEquator: { value: 31, lock: true },
            precipitation: 180
          },
          lock: ["winds", "distanceUnit", "heightUnit", "heightExponent", "temperatureScale", "areaUnit"]
        }
      ]
    });
    assert.deepEqual((r.applied as Obj[])[0].locks.lock, [
      "mapSize",
      "temperatureEquator",
      "winds",
      "distanceUnit",
      "areaUnit",
      "heightUnit",
      "heightExponent",
      "temperatureScale"
    ]);
    const s = await settings();
    assert.deepEqual(s.locked, [
      "mapSize",
      "temperatureEquator",
      "winds",
      "distanceUnit",
      "areaUnit",
      "heightUnit",
      "heightExponent",
      "temperatureScale"
    ]);
    // the app's own mechanism: icon state and the stored value the generator and the next start read
    const app = await evalRO(`({
      icon: document.getElementById('lock_mapSize').dataset.locked, ls: [localStorage.getItem('mapSize'),
      localStorage.getItem('temperatureEquator'), localStorage.getItem('winds'), localStorage.getItem('distanceUnit'),
      localStorage.getItem('heightExponent'), localStorage.getItem('prec')], isLocked: locked('temperatureEquator') })`);
    assert.equal(app.icon, "1");
    assert.deepEqual(app.ls, ["14", "31", ALL.winds.join(","), "km", "1.75", null]);
    assert.equal(app.isLocked, true);
    // a lock-only op keeps the current value (the input is synced first); {lock:false} unlocks one field
    await edit({ precipitation: { lock: true } });
    assert.equal(await stored("prec"), "180");
    await edit({ precipitation: { lock: false }, mapSize: { lock: false } });
    assert.equal(await stored("prec"), null);
    assert.equal(await stored("mapSize"), null);
    assert.equal(await evalRO("document.getElementById('lock_prec').dataset.locked"), "0");
    await h.ok("edit", { type: "map", ops: [{ unlock: ["all"] }] });
    assert.deepEqual((await settings()).locked, []);
    assert.equal(await stored("winds"), null);
    assert.equal(await stored("temperatureEquator"), null);
    await h.ok("edit", { type: "map", ops: [{ lock: ["prec"] }] });
    assert.deepEqual((await settings()).locked, ["precipitation"], "the app's id 'prec' is an alias");
    await h.ok("edit", { type: "map", ops: [{ unlock: ["prec"] }] });
    assert.deepEqual((await settings()).locked, []);
  });

  test("temperature locks hold the options value even when the Configure World inputs are stale", async () => {
    await h.ok("edit", { type: "map", ops: [{ unlock: ["all"] }] });
    await h.ok("eval", { code: "temperatureNorthPoleInput.value = 49; options.temperatureNorthPole = -12;" });
    await h.ok("edit", { type: "map", ops: [{ lock: ["temperatureNorthPole"] }] });
    assert.equal(await stored("temperatureNorthPole"), "-12");
    await h.ok("edit", { type: "map", ops: [{ unlock: ["temperatureNorthPole"] }] });
  });

  test("recalculate 'none' leaves climate stale and says how to refresh it; 'climate' refreshes temperature and precipitation", async () => {
    const snap = async () =>
      evalRO(`(() => { const sum = a => { let s = 0; for (const v of a) s += v; return s; };
        const bi = {}; for (const b of pack.cells.biome) bi[b] = (bi[b] || 0) + 1;
        return { temp: sum(grid.cells.temp), prec: sum(grid.cells.prec), biomes: JSON.stringify(bi), rivers: pack.rivers.length,
          riverIds: pack.rivers.map(r => r.i).join(), h: sum(pack.cells.h), hType: pack.cells.h.constructor.name }; })()`);
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    const s0 = await snap();
    const none = await edit({ temperatureEquator: 38 });
    assert.equal(none.recalculated, undefined);
    const groups = Object.keys(none.stale as Obj);
    assert.ok(
      groups.some(g => g.includes("temperature")),
      JSON.stringify(none.stale)
    );
    assert.ok(groups.some(g => g.includes("biomes")));
    assert.ok(groups.some(g => g.includes("ice") && g.includes("goods") && g.includes("routes")));
    assert.ok(!groups.some(g => g.includes("precipitation")), "temperature only: precipitation is not stale");
    assert.deepEqual(await snap(), s0, "no derived data changed");

    const clim = await edit({ temperatureEquator: 38 }, { recalculate: "climate" });
    assert.equal((clim.recalculated as Obj).mode, "climate");
    assert.deepEqual((clim.recalculated as Obj).done, ["temperature", "precipitation"]);
    const s1 = await snap();
    assert.notEqual(s1.temp, s0.temp, "temperature changed");
    assert.equal(s1.biomes, s0.biomes, "biomes stay as they were");
    assert.equal(s1.riverIds, s0.riverIds);
    assert.equal(s1.h, s0.h);
    const left = Object.keys(clim.stale as Obj);
    assert.ok(
      left.some(g => g.includes("biomes")) && !left.some(g => g.includes("temperature,")),
      JSON.stringify(left)
    );
    // deterministic: the same call again gives the same climate (the coastal rainfall RNG is seeded);
    // ops [{lock: []}] is the "recalculate only" form
    const only = await h.ok("edit", { type: "map", ops: [{ lock: [] }], recalculate: "climate" });
    assert.deepEqual((only.recalculated as Obj).done, ["temperature", "precipitation"]);
    const s2 = await snap();
    assert.equal(s2.temp, s1.temp);
    assert.equal(s2.prec, s1.prec);
  });

  test("recalculate 'climate+biomes' also rebuilds rivers, lakes and biomes, keeps heights and draws visible layers", async () => {
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("display", { on: ["biomes", "rivers", "temperature", "precipitation"] });
    const before = await evalRO(`(() => { const bi = {}; for (const b of pack.cells.biome) bi[b] = (bi[b] || 0) + 1;
      return { biomes: JSON.stringify(bi), hType: pack.cells.h.constructor.name, h: pack.cells.h.join().length,
        precDots: document.querySelectorAll('#prec circle').length }; })()`);
    const r = await edit({ precipitation: 350 }, { recalculate: "climate+biomes" });
    assert.deepEqual((r.recalculated as Obj).done, ["temperature", "precipitation", "rivers", "lakes", "biomes"]);
    assert.match(JSON.stringify(r.notes), /rivers were regenerated/);
    assert.deepEqual(Object.keys(r.stale as Obj), ["population"], "only the downstream layers are left");
    const redrawn = (r.redrawn as string[]).join();
    for (const l of ["temperature", "precipitation", "biomes", "rivers"])
      assert.ok(redrawn.includes(l), `${l} redrawn: ${redrawn}`);
    const after = await evalRO(`(() => { const bi = {}; for (const b of pack.cells.biome) bi[b] = (bi[b] || 0) + 1;
      return { biomes: JSON.stringify(bi), hType: pack.cells.h.constructor.name, h: pack.cells.h.join().length,
        precDots: document.querySelectorAll('#prec circle').length }; })()`);
    assert.notEqual(after.biomes, before.biomes, "more rain changes the biomes");
    assert.equal(after.hType, before.hType, "pack heights keep their type");
    assert.equal(after.h, before.h);
    assert.ok(after.precDots > 0);
    // the diff the edit returns is counts only (rivers renumber), and never repeats the settings
    const ch = r.changes as Obj;
    assert.ok(ch.river && typeof ch.river.added === "number", JSON.stringify(ch).slice(0, 300));
    assert.ok(!("settings" in ch));
    assert.ok(JSON.stringify(r).length < 4000, `lean result: ${JSON.stringify(r).length} chars`);
  });

  test("units edits refresh the scale bar; longitude only moves the coordinates (no stale climate)", async () => {
    const r = await edit({ distanceScale: 3, distanceUnit: "km" });
    assert.ok((r.redrawn as string[]).includes("scaleBar"));
    assert.equal(r.stale, undefined);
    const bar = await evalRO("document.querySelector('#scaleBar')?.textContent || ''");
    assert.match(bar, /km/);
    const lon = await edit({ longitude: 20 });
    assert.equal(lon.stale, undefined, "longitude does not feed the climate model");
    const mc = (await h.ok("map_info", { since: "none" })).mapCoordinates as Obj;
    assert.equal(mc.lonE, Math.round((180 - (360 - mc.lonT) * 0.2) * 10) / 10);
  });

  test("a settings-only edit changes the digest and shows in map_info's changes; undo reverts the values", async () => {
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    const s0 = await settings();
    const d0 = await digest();
    await edit({ heightUnit: "ft", areaUnit: "sq" });
    assert.notEqual(await digest(), d0);
    const info = await h.ok("map_info", {});
    const ch = (info.changes as Obj).settings as Obj;
    assert.deepEqual(ch.areaUnit, { from: s0.areaUnit, to: "sq" });
    await h.ok("snapshot", { action: "undo" });
    const s1 = await settings();
    assert.equal(s1.areaUnit, s0.areaUnit);
    assert.equal(s1.heightUnit, s0.heightUnit);
    assert.equal(await digest(), d0);
  });

  test("every field persists through save_map -> load_map (the .map settings line and options JSON)", async () => {
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await edit(ALL);
    const saved = await h.ok("save_map", { path: "settings-roundtrip.map", overwrite: true });
    const text = fs.readFileSync(saved.path as string, "utf8");
    const line = text.split("\n")[1].split("|");
    assert.deepEqual(
      [line[0], line[1], line[2], line[3], line[4], line[5], line[14], line[15], line[18], line[25]],
      ["li", "0.25", "acres", "f", "1.75", "°R", "12.5", "41.2", "222", "63.7"]
    );
    const opts = JSON.parse(line[19]);
    assert.deepEqual(opts.winds, ALL.winds);
    assert.deepEqual([opts.temperatureEquator, opts.temperatureNorthPole, opts.temperatureSouthPole], [33, -35, -8]);
    const mcSaved = JSON.parse(text.split("\n")[2]);
    const mcLive = (await h.ok("map_info", { since: "none" })).mapCoordinates;
    assert.deepEqual(mcSaved, mcLive, "mapCoordinates in the file match the live ones");
    // load something else, then the saved file: every field comes back
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    assert.notEqual((await settings()).mapSize, 12.5);
    await h.ok("load_map", { path: saved.path as string });
    const s = await settings();
    for (const k of Object.keys(ALL)) assert.deepEqual(s[k], (ALL as Obj)[k], `after load: ${k}`);
    assert.deepEqual((await h.ok("map_info", { since: "none" })).mapCoordinates, mcLive);
    assert.ok(
      !/lock/i.test(line.slice(0, 6).join()),
      "locks are not in the file: they are the browser's, not the map's"
    );
  });

  test("the locks are what the app's own start-up restore reads (applyStoredOptions brings the locked values back)", async () => {
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("edit", { type: "map", ops: [{ unlock: ["all"] }] });
    const want = {
      mapSize: 12.5,
      temperatureEquator: 33,
      winds: [180, 90, 270, 0, 135, 45],
      distanceScale: 0.25,
      heightExponent: 1.75,
      distanceUnit: "mi"
    };
    const locked = Object.fromEntries(Object.entries(want).map(([k, v]) => [k, { value: v, lock: true }]));
    await edit(locked);
    await h.ok("eval", {
      code: `mapSizeInput.value = mapSizeOutput.value = 3; options.temperatureEquator = 1; options.winds = [1,1,1,1,1,1];
        distanceScale = 9; distanceScaleInput.value = 9; heightExponentInput.value = 2; distanceUnitInput.value = 'km';
        applyStoredOptions();`
    });
    const s = await settings();
    for (const [k, v] of Object.entries(want)) assert.deepEqual(s[k], v, `restored ${k}`);
    await h.ok("edit", { type: "map", ops: [{ unlock: ["all"] }] });
  });

  test("one edit does what the primordial-soup frame script did with eval (same inputs, options, locks, coordinates)", async () => {
    // build/scripts/frame.js of the steward, trimmed to what it sets
    const FRAME = `
      const setv = (ids, v) => ids.forEach(id => { const e = document.getElementById(id); if (e) e.value = v; });
      setv(["mapSizeInput", "mapSizeOutput"], 1.1);
      setv(["latitudeInput", "latitudeOutput"], 38.8);
      options.temperatureEquator = 30; setv(["temperatureEquatorInput", "temperatureEquatorOutput"], 30);
      options.temperatureNorthPole = -28; setv(["temperatureNorthPoleInput", "temperatureNorthPoleOutput"], -28);
      options.winds = [225, 45, 45, 315, 135, 315];
      setv(["precInput", "precOutput"], 150);
      distanceScale = 0.1; setv(["distanceScaleInput"], 0.1);
      setv(["distanceUnitInput"], "mi"); setv(["heightUnit"], "m"); setv(["heightExponentInput"], 2);
      ["mapSize","latitude","temperatureEquator","temperatureNorthPole","prec","distanceScale","distanceUnit","heightUnit","heightExponent"].forEach(lock);
      store("winds", options.winds.join(",")); lock("winds");
      calculateMapCoordinates(); calculateTemperatures();`;
    const PROBE = `(() => { let t = 0; for (const v of grid.cells.temp) t += v;
      const ls = {}; for (const k of ["mapSize","latitude","temperatureEquator","temperatureNorthPole","prec","distanceScale","distanceUnit","heightUnit","heightExponent","winds"]) ls[k] = localStorage.getItem(k);
      const icons = {}; for (const k of ["mapSize","latitude","temperatureEquator","temperatureNorthPole","prec","distanceScale"]) icons[k] = document.getElementById("lock_" + k).dataset.locked;
      return { t, ls, icons, mc: mapCoordinates, winds: options.winds, eq: options.temperatureEquator, np: options.temperatureNorthPole,
        prec: precInput.value, ds: distanceScale, dsIn: distanceScaleInput.value, du: distanceUnitInput.value, hu: heightUnit.value,
        he: heightExponentInput.value, ms: mapSizeOutput.value, lat: latitudeOutput.value }; })()`;
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("edit", { type: "map", ops: [{ unlock: ["all"] }] });
    await h.ok("eval", { code: FRAME });
    const byEval = await evalRO(PROBE);
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("edit", { type: "map", ops: [{ unlock: ["all"] }] });
    await h.ok("edit", {
      type: "map",
      ops: [
        {
          set: {
            mapSize: 1.1,
            latitude: 38.8,
            temperatureEquator: 30,
            temperatureNorthPole: -28,
            winds: [225, 45, 45, 315, 135, 315],
            precipitation: 150,
            distanceScale: 0.1,
            distanceUnit: "mi",
            heightUnit: "m",
            heightExponent: 2
          },
          lock: [
            "mapSize",
            "latitude",
            "temperatureEquator",
            "temperatureNorthPole",
            "precipitation",
            "distanceScale",
            "distanceUnit",
            "heightUnit",
            "heightExponent",
            "winds"
          ]
        }
      ],
      recalculate: "climate"
    });
    const byEdit = await evalRO(PROBE);
    assert.deepEqual(byEdit, byEval);
  });

  test("a '|' or line break in the map name or era is refused (it would make the saved file unloadable)", async () => {
    const before = await digest();
    for (const set of [{ era: "Age | of pipes" }, { name: "A|B" }, { name: "two\nlines" }]) {
      const res = await h.call("edit", { type: "map", ops: [{ set }] });
      assert.equal(res.isError, true, JSON.stringify(set));
      assert.match(errorBody(res).error.message, /cannot contain '\|' or line breaks/);
    }
    const ok = await edit({ era: "Age of tests", name: "Plain name" });
    assert.equal((ok.applied as Obj[])[0].after.era, "Age of tests");
    assert.notEqual(await digest(), before);
    const lockOnNonMap = await h.call("edit", { type: "burg", ops: [{ ref: 1, lock: ["mapSize"] }] });
    assert.match(errorBody(lockOnNonMap).error.message, /lock\/unlock lists apply to edit type 'map' only/);
  });

  test("generate_map keeps locked settings, randomises unlocked ones, and honours temperature / distance options", async () => {
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("edit", { type: "map", ops: [{ unlock: ["all"] }] });
    await h.ok("edit", {
      type: "map",
      ops: [
        {
          set: {
            mapSize: { value: 9.5, lock: true },
            latitude: { value: 50, lock: true },
            temperatureEquator: { value: 35, lock: true },
            precipitation: { value: 133, lock: true },
            distanceScale: { value: 0.5, lock: true },
            distanceUnit: { value: "mi", lock: true }
          }
        }
      ]
    });
    const args = { seed: "settings-lock", template: "continents", cells: 2, states: 3, cultures: 3 };
    const g = await h.ok("generate_map", args, 240_000);
    const s = await settings();
    assert.equal(s.mapSize, 9.5);
    assert.equal(s.latitude, 50);
    assert.equal(s.temperatureEquator, 35);
    assert.equal(s.precipitation, 133);
    assert.equal(s.distanceScale, 0.5);
    assert.equal(s.distanceUnit, "mi");
    assert.ok(
      ["mapSize", "latitude", "temperatureEquator", "precipitation", "distanceScale", "distanceUnit"].every(n =>
        s.locked.includes(n)
      )
    );
    assert.ok(!(g.unlocked as string[]).includes("mapSize"), "generate_map leaves the edit-map locks alone");
    const climate = await evalRO(
      "(() => { let max = -999; for (const t of grid.cells.temp) if (t > max) max = t; return max; })()"
    );
    assert.ok(climate > 20, `the locked 35 degree equator is used by the model (hottest cell ${climate})`);
    // generate_map option inputs reach the generator (temperatures live in options, the scale in a global)
    await h.ok("edit", { type: "map", ops: [{ unlock: ["all"] }] });
    await h.ok(
      "generate_map",
      {
        ...args,
        options: { temperatureNorthPoleInput: -3, temperatureEquatorInput: 11, distanceScaleInput: 2.5 }
      },
      240_000
    );
    const s2 = await settings();
    assert.equal(s2.temperatureNorthPole, -3);
    assert.equal(s2.temperatureEquator, 11);
    assert.equal(s2.distanceScale, 2.5);
    // a lock edit map took over a generator lock survives the next generate_map
    await h.ok("edit", { type: "map", ops: [{ lock: ["temperatureNorthPole"] }] });
    const g3 = await h.ok("generate_map", { ...args, seed: "settings-lock-2" }, 240_000);
    assert.ok(!(g3.unlocked as string[]).includes("temperatureNorthPole"));
    assert.equal((await settings()).temperatureNorthPole, -3);
    assert.ok((await settings()).locked.includes("temperatureNorthPole"));
    // the same seed and options still give the same digest (settings are part of it)
    const g4 = await h.ok("generate_map", { ...args, seed: "settings-lock-2" }, 240_000);
    assert.equal(g4.digest, g3.digest);
  });
});

describe("tupaia-mcp map settings in a sketch (replay and the both-changed check)", () => {
  let h: Harness;
  const files: Record<string, string> = {};
  const settings = async () => ((await h.ok("map_info", { since: "none" })).settings as Obj) ?? {};

  /** Load demo.map, run `code` as "someone else", save the copy. */
  async function otherCopy(name: string, code: string): Promise<string> {
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    if (code) await h.ok("eval", { code });
    const r = await h.ok("save_map", { path: `${name}.map`, overwrite: true });
    return r.path as string;
  }

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    files.same = await otherCopy("settings-same", "");
    files.sameValue = await otherCopy(
      "settings-same-value",
      "mapSizeInput.value = mapSizeOutput.value = 7; calculateMapCoordinates();"
    );
    files.conflict = await otherCopy(
      "settings-conflict",
      "mapSizeInput.value = mapSizeOutput.value = 33; calculateMapCoordinates();"
    );
    files.disjoint = await otherCopy(
      "settings-disjoint",
      "precInput.value = precOutput.value = 99; options.temperatureSouthPole = -9;"
    );
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("records resolved forms with plain before/after values and replays them with locks and recalculate", async () => {
    await h.ok("sketch", { action: "start", slug: "settings-sketch" });
    const base = await settings();
    await h.ok("edit", {
      type: "map",
      ops: [{ set: { mapSize: { value: 7, lock: true }, temperatureEquator: 36, winds: [45, 45, 45, 225, 225, 225] } }],
      recalculate: "climate"
    });
    await h.ok("edit", { type: "map", ops: [{ lock: ["winds"], set: { distanceScale: 0.4, distanceUnit: "mi" } }] });
    const st = await h.ok("sketch", { action: "status" });
    const log = st.log as Obj[];
    assert.equal(log.length, 2);
    assert.ok(
      log.every(o => o.replayable !== false),
      JSON.stringify(log)
    );
    assert.match(log[0].summary, /mapSize 20\.3 -> 7/);
    assert.match(log[0].summary, /recalculated climate/);
    assert.equal(base.mapSize, 20.3);
  });

  test("replay onto an untouched copy applies both ops: values, locks and the recalculation", async () => {
    const r = await h.ok("sketch", { action: "rebase", onto: { path: files.same } }, 240_000);
    assert.equal(r.completed, true, JSON.stringify(r.conflicts));
    assert.deepEqual(r.applied, [1, 2]);
    const s = await settings();
    assert.equal(s.mapSize, 7);
    assert.equal(s.temperatureEquator, 36);
    assert.deepEqual(s.winds, [45, 45, 45, 225, 225, 225]);
    assert.equal(s.distanceScale, 0.4);
    assert.equal(s.distanceUnit, "mi");
    assert.deepEqual(s.locked.sort(), ["mapSize", "winds"]);
    // the recalculation ran: the hottest cell follows the new equator temperature
    const rec = await h.ok("eval", { code: "mapCoordinates.latT", readOnly: true });
    assert.equal(rec.value, 12.6);
  });

  test("both changed: someone else set the same field to another value -> conflict", async () => {
    const r = await h.ok("sketch", { action: "rebase", onto: { path: files.conflict } }, 240_000);
    assert.equal(r.completed, false);
    const c = (r.conflicts as Obj[])[0];
    assert.equal(c.seq, 1);
    assert.match(c.reason, /^both changed mapSize of the map: base 20\.3, now 33, sketch 7/);
    assert.equal((await settings()).temperatureEquator !== 36, true, "a stopped replay applied nothing of that op");
  });

  test("the same value on both sides is no conflict; a different field of theirs survives", async () => {
    const same = await h.ok("sketch", { action: "rebase", onto: { path: files.sameValue } }, 240_000);
    assert.equal(same.completed, true, JSON.stringify(same.conflicts));
    const dis = await h.ok("sketch", { action: "rebase", onto: { path: files.disjoint } }, 240_000);
    assert.equal(dis.completed, true, JSON.stringify(dis.conflicts));
    const s = await settings();
    assert.equal(s.mapSize, 7);
    assert.equal(s.precipitation, 99, "their change survives");
    assert.equal(s.temperatureSouthPole, -9, "their change survives");
    assert.equal(s.temperatureEquator, 36);
  });
});

describe("map settings resolved forms (pure)", () => {
  const resolved: EditResolved = {
    type: "map",
    ops: [
      {
        name: "Chanland",
        set: { mapSize: { value: 7, lock: true }, winds: [1, 2, 3, 4, 5, 6], lock: ["winds"] },
        before: { mapSize: 20.3, winds: [225, 45, 225, 315, 135, 315] },
        after: { mapSize: 7, winds: [1, 2, 3, 4, 5, 6] }
      }
    ],
    recalculate: "climate+biomes"
  };

  test("bridgeArgs forwards ops and recalculate; summarizeOp says so", () => {
    const a = bridgeArgs("edit", resolved);
    assert.equal(a.recalculate, "climate+biomes");
    assert.deepEqual((a.ops as Obj[])[0].set, resolved.ops[0].set);
    assert.equal(bridgeArgs("edit", { ...resolved, recalculate: undefined }).recalculate, undefined);
    assert.match(
      summarizeOp("edit", resolved, null),
      /the map: mapSize 20\.3 -> 7, winds .* \(recalculated climate\+biomes\)\.$/
    );
  });

  test("bothChanged compares plain values and arrays; locks never conflict", () => {
    const plan = (before: Obj) => [{ index: 0, before }];
    // untouched elsewhere: no conflict
    assert.deepEqual(bothChanged(resolved, plan({ mapSize: 20.3, winds: [225, 45, 225, 315, 135, 315] })), []);
    // someone else already has the sketch's values: no conflict
    assert.deepEqual(bothChanged(resolved, plan({ mapSize: 7, winds: [1, 2, 3, 4, 5, 6] })), []);
    // both changed to different values
    const c = bothChanged(resolved, plan({ mapSize: 33, winds: [9, 9, 9, 9, 9, 9] }));
    assert.equal(c.length, 2);
    assert.match(c[0], /both changed mapSize of the map: base 20\.3, now 33, sketch 7/);
    assert.match(c[1], /both changed winds/);
  });
});
