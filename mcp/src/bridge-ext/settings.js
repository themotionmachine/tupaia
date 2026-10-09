// Tupaia MCP bridge extension: map settings (Configure World + Units editor) as edit-map fields.
// Injected after bridge.js and bridge-mutations.js (classic script; same rules: app globals by
// bare name at call time, no locals that shadow app globals, one args object per FNS function).
//
// What it adds:
//   - FIELDS.map: mapSize, latitude, longitude, temperatureEquator/NorthPole/SouthPole, winds,
//     precipitation, distanceScale, distanceUnit, areaUnit, heightUnit, heightExponent,
//     temperatureScale. Each takes a plain value or {value, lock:true|false}; the pseudo fields
//     lock:[names] / unlock:[names] (also accepted as op-level keys) use the app's lock()/unlock().
//   - edit {type:'map', recalculate:'none'|'climate'|'biomes'|'rivers+biomes'|'climate+biomes'}, with a
//     list of the derived layers that stay stale and how to refresh them.
//   - the setting locks travel inside the .map text (options JSON key `tupaiaLocks`, ignored by the
//     stock app), so undo, snapshot restore, a browser relaunch and save_map -> load_map keep them.
//   - a settings block in the page summary (map_info), and settings, locks, name/year/era/population
//     fields and the grid climate in digest and diff, so a settings-only or climate-only edit is a
//     change.
//   - generate_map fixes: temperature and distance-scale options reach the generator, and a lock
//     taken here is not undone by generate_map's "unlock stale generator locks" step.
(root => {
  const T = root.__tupaia;
  if (!T?.mutations) return;
  const FNS = T.fns;
  const fail = T.fail;
  const FIELDS = T.mutations.FIELDS;
  const hashStr = T.pure.hashStr;

  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const byId = id => document.getElementById(id);
  const fold = s =>
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  /** o[k] for an own property only (names come from callers: "constructor" is not a unit). */
  const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);

  // ---------------------------------------------------------------- value checks

  /**
   * Number within min..max, rounded to `decimals` (the step of the app's own input); a value that
   * had to be rounded is reported in the result's notes.
   */
  const ranged = (name, min, max, decimals) => (v, _entity, c) => {
    if (typeof v !== "number" || !Number.isFinite(v)) fail("BAD_ARGS", `${name} must be a number`);
    if (v < min || v > max) fail("BAD_ARGS", `${name} must be within ${min}..${max}`);
    const m = 10 ** decimals;
    const out = Math.round(v * m) / m;
    if (Math.abs(out - v) > 1e-9)
      c?.notes?.add(
        `${name.split(" ")[0]} ${v} was rounded to ${out} (${decimals ? `${decimals} decimal${decimals > 1 ? "s" : ""}` : "whole numbers"} are stored)`
      );
    return out;
  };

  /** Unit name: a known value, a synonym of one, or a custom name (the app adds it to the list). */
  const unitName = (name, aliases) => v => {
    if (typeof v !== "string" || !v.trim()) fail("BAD_ARGS", `${name} must be a non-empty string`);
    const s = v.trim();
    if (s.length > 24) fail("BAD_ARGS", `${name} is at most 24 characters`);
    if (/[|\r\n]/.test(s))
      fail("BAD_ARGS", `${name} cannot contain '|' or line breaks (the .map file is '|' separated)`);
    if (s === "custom_name") fail("BAD_ARGS", `${name}: give the custom name itself, not 'custom_name'`);
    return own(aliases, fold(s)) ?? s;
  };

  const DISTANCE_UNITS = {
    mi: "mi",
    mile: "mi",
    miles: "mi",
    km: "km",
    kilometer: "km",
    kilometers: "km",
    kilometre: "km",
    kilometres: "km",
    lg: "lg",
    league: "lg",
    leagues: "lg",
    vr: "vr",
    versta: "vr",
    verst: "vr",
    versts: "vr",
    nmi: "nmi",
    nauticalmile: "nmi",
    nauticalmiles: "nmi",
    nlg: "nlg",
    nauticalleague: "nlg",
    nauticalleagues: "nlg"
  };
  const HEIGHT_UNITS = {
    ft: "ft",
    foot: "ft",
    feet: "ft",
    m: "m",
    meter: "m",
    meters: "m",
    metre: "m",
    metres: "m",
    f: "f",
    fathom: "f",
    fathoms: "f"
  };
  const TEMPERATURE_SCALES = {
    c: "°C",
    celsius: "°C",
    degreecelsius: "°C",
    f: "°F",
    fahrenheit: "°F",
    degreefahrenheit: "°F",
    k: "K",
    kelvin: "K",
    r: "°R",
    rankine: "°R",
    de: "°De",
    delisle: "°De",
    n: "°N",
    newton: "°N",
    re: "°Ré",
    ré: "°Ré",
    reaumur: "°Ré",
    réaumur: "°Ré",
    ro: "°Rø",
    rø: "°Rø",
    romer: "°Rø",
    rømer: "°Rø"
  };
  const scaleName = v => {
    if (typeof v !== "string" || !v.trim()) fail("BAD_ARGS", "temperatureScale must be a string");
    const opts = [...(byId("temperatureScale")?.options || [])].map(o => o.value);
    const s = v.trim();
    const bare = s.replace(/^°\s*/, "");
    // exact option, then the alias table as typed; the folded lookup (which drops every character
    // outside a-z0-9, so 'Rø' would read as 'R') only for plain ASCII input
    const hit =
      opts.find(o => o === s) ||
      own(TEMPERATURE_SCALES, bare.toLowerCase()) ||
      (/^[\x20-\x7e]*$/.test(bare) ? own(TEMPERATURE_SCALES, fold(bare)) : undefined);
    if (!hit || (opts.length && !opts.includes(hit)))
      fail("BAD_ARGS", `temperatureScale must be one of ${opts.join(" ")}`, { details: opts });
    return hit;
  };

  /** 6 directions, or a partial {tier: degrees} (tiers 0..5, north to south) merged onto the current ones. */
  const windsCheck = v => {
    let list = v;
    if (isObj(v) && !("value" in v) && !("lock" in v)) {
      list = SETTINGS.winds.get();
      for (const [k, d] of Object.entries(v)) {
        if (!/^[0-5]$/.test(k)) fail("BAD_ARGS", `winds tier '${k}' must be 0..5 (north to south, 30 degrees each)`);
        list[Number(k)] = d;
      }
    }
    if (!Array.isArray(list) || list.length !== 6)
      fail(
        "BAD_ARGS",
        "winds must be 6 numbers (one per 30-degree latitude tier, north to south) or {tier: degrees} for some tiers"
      );
    return list.map((d, k) => {
      if (typeof d !== "number" || !Number.isFinite(d) || d < 0 || d > 360)
        fail("BAD_ARGS", `winds[${k}] must be a direction in degrees, 0..360`);
      return d === 360 ? 0 : d;
    });
  };

  // ---------------------------------------------------------------- the settings

  const DEFAULT_WINDS = [225, 45, 225, 315, 135, 315];
  const DEFAULT_TEMPS = { temperatureEquator: 27, temperatureNorthPole: -30, temperatureSouthPole: -15 };

  const num = id => {
    const n = Number(byId(id)?.value);
    return Number.isFinite(n) ? n : null;
  };
  const str = id => {
    const e = byId(id);
    return e ? String(e.value) : null;
  };
  const setAll = (ids, v) => {
    for (const id of ids) {
      const e = byId(id);
      if (e) e.value = v;
    }
  };
  const tempField = (key, label) => ({
    lock: key,
    check: ranged(label, -50, 50, 1),
    get: () => (Number.isFinite(options[key]) ? options[key] : DEFAULT_TEMPS[key]),
    apply: v => {
      options[key] = v;
      setAll([`${key}Input`, `${key}Output`], v);
    },
    sync: () => setAll([`${key}Input`, `${key}Output`], options[key] ?? DEFAULT_TEMPS[key])
  });
  /** A Configure World slider: the Output (range) is what the generator and the file read. */
  const outputField = (key, label, min, max, decimals) => ({
    lock: key,
    check: ranged(label, min, max, decimals),
    get: () => num(`${key}Output`),
    apply: v => setAll([`${key}Input`, `${key}Output`], v),
    sync: () => setAll([`${key}Input`], str(`${key}Output`))
  });
  const selectField = (id, key, check) => ({
    lock: key,
    check,
    get: () => str(id),
    apply: v => applyOption(byId(id), v)
  });

  const SETTINGS = {
    mapSize: outputField("mapSize", "mapSize (% of the world)", 1, 100, 1),
    latitude: outputField("latitude", "latitude (north-south shift, 0..100)", 0, 100, 1),
    longitude: outputField("longitude", "longitude (west-east shift, 0..100)", 0, 100, 1),
    temperatureEquator: tempField("temperatureEquator", "temperatureEquator"),
    temperatureNorthPole: tempField("temperatureNorthPole", "temperatureNorthPole"),
    temperatureSouthPole: tempField("temperatureSouthPole", "temperatureSouthPole"),
    winds: {
      lock: "winds",
      check: windsCheck,
      get: () =>
        Array.isArray(options.winds) && options.winds.length === 6 ? options.winds.slice() : DEFAULT_WINDS.slice(),
      apply: v => {
        options.winds = v.slice();
      }
    },
    precipitation: {
      lock: "prec",
      check: ranged("precipitation (%)", 0, 500, 0),
      get: () => num("precOutput"),
      apply: v => setAll(["precInput", "precOutput"], v),
      sync: () => setAll(["precInput"], str("precOutput"))
    },
    distanceScale: {
      lock: "distanceScale",
      check: ranged("distanceScale (distance units per map pixel)", 0.001, 1000, 4),
      get: () => (Number.isFinite(distanceScale) ? distanceScale : null),
      apply: v => {
        distanceScale = v;
        setAll(["distanceScaleInput"], v);
      },
      sync: () => setAll(["distanceScaleInput"], distanceScale)
    },
    distanceUnit: selectField("distanceUnitInput", "distanceUnit", unitName("distanceUnit", DISTANCE_UNITS)),
    areaUnit: {
      lock: "areaUnit",
      check: unitName("areaUnit", {}),
      get: () => str("areaUnit"),
      apply: v => setAll(["areaUnit"], v)
    },
    heightUnit: selectField("heightUnit", "heightUnit", unitName("heightUnit", HEIGHT_UNITS)),
    heightExponent: {
      lock: "heightExponent",
      check: ranged("heightExponent", 1.5, 2.2, 2),
      get: () => num("heightExponentInput"),
      apply: v => setAll(["heightExponentInput"], v)
    },
    temperatureScale: selectField("temperatureScale", "temperatureScale", scaleName)
  };
  const NAMES = Object.keys(SETTINGS);
  const ALIASES = { prec: "precipitation", precInput: "precipitation", temperatureUnit: "temperatureScale" };

  function settingsNow() {
    const out = {};
    for (const name of NAMES) {
      try {
        out[name] = SETTINGS[name].get();
      } catch {
        out[name] = null;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- locks

  T.settingLocks = new Set(); // lock ids taken through edit map (generate_map must not unlock them)

  function storage() {
    try {
      return root.localStorage;
    } catch {
      return null;
    }
  }

  function isLockedSetting(name) {
    const S = SETTINGS[name];
    const ls = storage();
    if (name === "winds") return !!ls && ls.getItem("winds") !== null;
    const icon = byId(`lock_${S.lock}`);
    if (icon) return icon.dataset.locked === "1";
    return !!ls && ls.getItem(S.lock) !== null;
  }

  function lockSetting(name) {
    const S = SETTINGS[name];
    S.sync?.(); // lock() stores the first data-stored input; make it hold the current value
    if (name === "winds") store("winds", SETTINGS.winds.get().join(","));
    else lock(S.lock);
    T.settingLocks.add(S.lock);
  }

  function unlockSetting(name) {
    const S = SETTINGS[name];
    if (name === "winds") storage()?.removeItem("winds");
    else unlock(S.lock);
    T.settingLocks.delete(S.lock);
  }

  /** Names of the settings that are locked now. */
  function lockedNames() {
    return NAMES.filter(n => {
      try {
        return isLockedSetting(n);
      } catch {
        return false;
      }
    });
  }

  // The locks ride inside the .map text as options.tupaiaLocks (the options JSON is a free-form bag
  // the stock app reads back whole and ignores keys it does not know). The text is what undo entries,
  // snapshots, crash restores and save_map keep, so they keep the locks too; a file without the key
  // (any file the stock app saved) leaves the page's locks as they are.
  const LOCKS_KEY = "tupaiaLocks";

  /** Make exactly `want` (setting names; unknown names are ignored) locked, at the values now in the page. */
  function applyLockSet(want) {
    const keep = new Set(want.filter(n => typeof n === "string" && own(SETTINGS, n)));
    for (const n of NAMES) {
      try {
        if (keep.has(n)) lockSetting(n);
        else if (isLockedSetting(n)) unlockSetting(n);
      } catch {}
    }
    return NAMES.filter(n => keep.has(n));
  }

  /** Setting names from a lock/unlock value (a name, a list, or 'all'); strict about unknown names. */
  function lockNames(field, v) {
    const list = typeof v === "string" ? [v] : v;
    if (!Array.isArray(list)) fail("BAD_ARGS", `${field} is a list of setting names, or 'all'`, { details: NAMES });
    const out = new Set();
    for (const raw of list) {
      if (typeof raw !== "string") fail("BAD_ARGS", `${field} entries are setting names`, { details: NAMES });
      const n = own(ALIASES, raw) ?? raw;
      if (n === "all") for (const x of NAMES) out.add(x);
      else if (own(SETTINGS, n)) out.add(n);
      else fail("BAD_ARGS", `unknown setting '${raw}' in ${field}`, { details: NAMES });
    }
    return NAMES.filter(n => out.has(n));
  }

  /** {lock:[], unlock:[]} an op's set asks for (lock/unlock lists and per-field {lock}); lenient. */
  function directivesOf(set) {
    const lockSet = new Set();
    const unlockSet = new Set();
    if (isObj(set)) {
      for (const [key, v] of Object.entries(set)) {
        if (key === "lock" || key === "unlock") {
          try {
            for (const n of lockNames(key, v)) (key === "lock" ? lockSet : unlockSet).add(n);
          } catch {}
        } else if (own(SETTINGS, key) && isObj(v) && typeof v.lock === "boolean")
          (v.lock ? lockSet : unlockSet).add(key);
      }
    }
    return { lock: NAMES.filter(n => lockSet.has(n)), unlock: NAMES.filter(n => unlockSet.has(n)) };
  }

  function noContradiction(set) {
    const d = directivesOf(set);
    const both = d.lock.filter(n => d.unlock.includes(n));
    if (both.length) fail("BAD_ARGS", `${both.join(", ")} cannot be locked and unlocked in the same op`);
  }

  // ---------------------------------------------------------------- FIELDS.map

  const isWrapped = v => isObj(v) && ("value" in v || "lock" in v);

  /** Accept a plain value or {value?, lock?}; returns the plain value or the normalised wrapper. */
  const withLock = (name, check) => (v, entity, c, set) => {
    if (!isWrapped(v)) return check(v, entity, c);
    const extra = Object.keys(v).filter(k => k !== "value" && k !== "lock");
    if (extra.length) fail("BAD_ARGS", `${name}: unexpected key '${extra[0]}' (use {value, lock})`);
    if ("lock" in v && typeof v.lock !== "boolean") fail("BAD_ARGS", `${name}.lock must be true or false`);
    const out = {};
    if ("value" in v) out.value = check(v.value, entity, c);
    if ("lock" in v) out.lock = v.lock;
    if (set) noContradiction(set);
    return out;
  };

  for (const name of NAMES) {
    const S = SETTINGS[name];
    FIELDS.map[name] = {
      check: withLock(name, S.check),
      get: () => S.get(),
      show: v => (isWrapped(v) ? ("value" in v ? v.value : S.get()) : v),
      set: (_x, v) => {
        const wrapped = isWrapped(v);
        if (!wrapped || "value" in v) S.apply(wrapped ? v.value : v);
        if (wrapped && typeof v.lock === "boolean") (v.lock ? lockSetting : unlockSetting)(name);
      },
      // whether the setting is locked now (apply compares a {value, lock} spec value with it)
      locked: () => isLockedSetting(name)
    };
  }
  for (const [key, act] of [
    ["lock", lockSetting],
    ["unlock", unlockSetting]
  ]) {
    FIELDS.map[key] = {
      check: (v, _entity, _c, set) => {
        const names = lockNames(key, v);
        if (set) noContradiction(set);
        return names;
      },
      get: () => null, // a directive, not a value: never part of before/after (the locks in force: state())
      show: v => v,
      set: (_x, names) => names.forEach(act),
      // the locks in force (they travel in the .map text): apply compares a spec's lock/unlock list with them
      state: () => lockedNames()
    };
  }

  // The .map settings line is '|' separated and its options JSON sits in the middle of it: a '|' or a
  // line break in the map name or era makes save_map write a file the app cannot load again.
  for (const [field, pick] of [
    ["name", p => p?.text],
    ["era", p => p]
  ]) {
    const f = FIELDS.map[field];
    const baseCheck = f.check;
    f.check = (...args) => {
      const out = baseCheck(...args);
      const text = pick(out);
      if (typeof text === "string" && /[|\r\n]/.test(text))
        fail("BAD_ARGS", `${field} cannot contain '|' or line breaks: the saved .map file would not load again`);
      return out;
    };
  }

  // A year is a whole number (the Options panel parses it as one; 1.5 would print as a fraction)
  {
    const y = FIELDS.map.year;
    const baseCheck = y.check;
    y.check = (...args) => {
      const out = baseCheck(...args);
      if (!Number.isInteger(out)) fail("BAD_ARGS", "year must be a whole number");
      return out;
    };
  }

  // ---------------------------------------------------------------- recalculation

  // The pieces of Configure World's "apply to the existing map" recipe (updateWorld), by mode.
  // updateWorld itself restores the heights its river erosion changed; erosion is simply off here.
  const STAGES = {
    none: [],
    climate: ["climate"],
    biomes: ["biomes"],
    "rivers+biomes": ["rivers", "biomes"],
    "climate+biomes": ["climate", "rivers", "biomes"]
  };
  const MODES = Object.keys(STAGES);
  const GEOMETRY = new Set(["mapSize", "latitude", "longitude"]);
  // which settings feed the temperature / precipitation model (longitude only moves the coordinates)
  const TEMP_FIELDS = new Set([
    "mapSize",
    "latitude",
    "temperatureEquator",
    "temperatureNorthPole",
    "temperatureSouthPole",
    "heightExponent"
  ]);
  const PREC_FIELDS = new Set(["mapSize", "latitude", "winds", "precipitation"]);
  // map-level fields (not world settings) that are watched for the stale report and the diff
  const MAP_WATCH = ["populationRate", "urbanization"];
  const WATCH = [...NAMES, ...MAP_WATCH];

  function modeOf(a) {
    const m = a.recalculate ?? "none";
    if (!own(STAGES, m)) fail("BAD_ARGS", `recalculate must be one of ${MODES.join(", ")}`, { details: MODES });
    return m;
  }

  /** The map-level fields edit {type:'map'} sets besides the world settings. */
  function mapFields() {
    return {
      name: typeof mapName !== "undefined" ? mapName.value : null,
      year: options.year ?? null,
      era: options.era ?? null,
      populationRate: typeof populationRate !== "undefined" ? populationRate : null,
      urbanization: typeof urbanization !== "undefined" ? urbanization : null
    };
  }
  /** The world settings plus populationRate and urbanization: what the stale report watches. */
  function watchNow() {
    const m = mapFields();
    return { ...settingsNow(), populationRate: m.populationRate, urbanization: m.urbanization };
  }

  /**
   * Derived layers that stay stale after `changed` settings were edited with recalculate `mode`,
   * as {"layer,layer": how to refresh}, or null.
   */
  function staleReport(changed, mode) {
    const ran = new Set(STAGES[mode]);
    let temp = changed.some(k => TEMP_FIELDS.has(k));
    let prec = changed.some(k => PREC_FIELDS.has(k));
    // a climate recalculation with no climate setting changed (ops omitted / the same value again):
    // what changed earlier is unknown, so everything downstream of it may be stale
    if (ran.has("climate") && !temp && !prec) temp = prec = true;
    const climate = temp || prec;
    const missing = new Set(climate ? ["climate", "rivers", "biomes"].filter(x => !ran.has(x)) : []);
    const out = {};
    if (missing.has("climate"))
      out[[...(temp ? ["temperature"] : []), ...(prec ? ["precipitation"] : [])].join(",")] =
        "edit map with recalculate 'climate' (no ops needed: it changes no setting)";
    if (missing.has("rivers") || missing.has("biomes")) {
      const how = missing.has("climate") ? "climate+biomes" : missing.has("rivers") ? "rivers+biomes" : "biomes";
      const layers = [
        ...(missing.has("rivers") ? ["rivers", "lakes"] : []),
        ...(missing.has("biomes") ? ["biomes"] : [])
      ];
      out[layers.join(",")] =
        `edit map with recalculate '${how}' (${how === "biomes" ? "" : "regenerates rivers: ids, names and river edits are replaced; "}biome cells are recomputed, hand-painted ones too)`;
    }
    const rest = [
      ...(temp ? ["ice"] : []),
      ...(climate || ran.has("rivers") || ran.has("biomes") ? ["goods", "routes", "population"] : [])
    ];
    if (rest.length)
      out[rest.join(",")] = `regenerate parts [${rest.map(l => `'${l}'`).join(",")}] (random; replaces hand edits)`;
    if (changed.includes("populationRate"))
      out.military =
        "regenerate parts ['military'] (troop totals were computed from populationRate when generated; burg populations are read through it and already follow)";
    return Object.keys(out).length ? out : null;
  }

  /** Mulberry32 seeded from the map seed: the coastal rainfall term and the river and lake names use Math.random. */
  function seededRandom(label, fn) {
    let h = 1779033703;
    for (const ch of `${seed}|${label}`) {
      h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    let s = (h ^ (h >>> 16)) >>> 0;
    const saved = Math.random;
    Math.random = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    try {
      return fn();
    } finally {
      Math.random = saved;
    }
  }

  /** Cells of the biomes Biomes.define never assigns (ids past the default list: custom biomes), flat [cell, id, ...]. */
  function customBiomeCells() {
    const C = pack.cells;
    const first = Biomes.getDefault().i.length;
    const out = [];
    for (let i = 0; i < C.biome.length; i++) if (C.biome[i] >= first && C.h[i] >= 20) out.push(i, C.biome[i]);
    return out;
  }

  /**
   * Fingerprint of the layers a rivers/biomes recalculation overwrites (biome cells, river cells and
   * rivers, lake names and groups). A sketch op records it; replay compares it with the target.
   */
  function derivedPrint() {
    const C = pack.cells;
    const rivers = (pack.rivers || []).map(r => [r.i, r.name, r.mouth, r.source, r.parent]);
    const lakes = (pack.features || []).filter(f => f?.type === "lake").map(f => [f.i, f.name, f.group]);
    return hashStr(JSON.stringify([T.pure.hashArray(C.biome), T.pure.hashArray(C.r), rivers, lakes]));
  }

  /** What a recalculation of `mode` would replace and keep (dry run and validate). */
  function replacesReport(mode) {
    const stages = STAGES[mode];
    const replaces = {};
    const keeps = {};
    if (stages.includes("rivers")) replaces.rivers = (pack.rivers || []).length;
    if (stages.includes("rivers")) {
      const named = (pack.features || []).filter(f => f?.type === "lake" && f.name).length;
      if (named) keeps.lakeNames = named;
    }
    if (stages.includes("biomes")) {
      // cells whose biome differs from what the climate now derives: hand-painted, or stale after a terrain edit
      const C = pack.cells;
      const saved = C.biome;
      let derived;
      try {
        Biomes.define();
        derived = C.biome;
      } finally {
        C.biome = saved;
      }
      const first = Biomes.getDefault().i.length;
      let edited = 0;
      let custom = 0;
      for (let i = 0; i < saved.length; i++) {
        if (saved[i] >= first && C.h[i] >= 20) custom++;
        else if (saved[i] !== derived[i]) edited++;
      }
      replaces.biomeCellsEdited = edited;
      if (custom) keeps.customBiomeCells = custom;
    }
    return { replaces, keeps };
  }

  /**
   * The app's own "apply to an existing map" path (Configure World > updateWorld), minus the
   * dialog, in stages: climate (temperature, precipitation), rivers (rivers, lake data and groups),
   * biomes. Lake names and custom biomes are kept. Redraws only layers that are on.
   */
  async function recalculate(mode, geometryChanged, draw) {
    const stages = STAGES[mode];
    const has = x => stages.includes(x);
    const t0 = performance.now();
    const done = [];
    const kept = {};
    const lakeNames = new Map();
    if (has("rivers"))
      for (const f of pack.features || []) if (f?.type === "lake" && f.name) lakeNames.set(f.i, f.name);
    const custom = has("biomes") ? customBiomeCells() : [];
    const biomeBefore = has("biomes") ? pack.cells.biome : null;
    let biomeCellsChanged = 0;
    // one seeded stream for the whole recalculation: same map, same result (so a replay matches)
    seededRandom("recalc", () => {
      calculateMapCoordinates();
      if (has("climate")) {
        calculateTemperatures();
        done.push("temperature");
        generatePrecipitation();
        done.push("precipitation");
      }
      if (has("rivers")) {
        Rivers.generate(false); // erosion off: heights stay as they are (updateWorld restores them)
        Rivers.specify();
        Features.defineGroups();
        for (const f of pack.features || [])
          if (f?.type === "lake") {
            const old = lakeNames.get(f.i);
            f.name = old ?? Lakes.getName(f);
          }
        done.push("rivers", "lakes");
        if (lakeNames.size) kept.lakeNames = lakeNames.size;
      }
      if (has("biomes")) {
        Biomes.define();
        const C = pack.cells;
        for (let k = 0; k < custom.length; k += 2) C.biome[custom[k]] = custom[k + 1];
        for (let i = 0; i < C.biome.length; i++) if (C.biome[i] !== biomeBefore[i]) biomeCellsChanged++;
        done.push("biomes");
        if (custom.length) kept.customBiomeCells = custom.length / 2;
      }
    });
    const redrawn = [];
    if (draw) {
      if (has("climate") && layerIsOn("toggleTemperature")) {
        drawTemperature();
        redrawn.push("temperature");
      }
      if (has("climate") && layerIsOn("togglePrecipitation")) {
        drawPrecipitation();
        redrawn.push("precipitation");
      }
      if (geometryChanged && layerIsOn("toggleCoordinates")) {
        drawCoordinates();
        redrawn.push("coordinates");
      }
      const layers = [...(has("biomes") ? ["biomes"] : []), ...(has("rivers") ? ["rivers"] : [])];
      if (layers.length) {
        const r = await T.redraw({ layers });
        redrawn.push(...r.redrawn);
      }
    }
    const report = { mode, done, redrawn, ms: Math.round(performance.now() - t0) };
    if (has("biomes")) report.biomeCellsChanged = biomeCellsChanged;
    if (Object.keys(kept).length) report.kept = kept;
    return report;
  }

  /** Cheap refreshes after settings changed (no derived data): coordinates, scale bar, labels. */
  function refreshDisplay(changed, draw) {
    const redrawn = [];
    const geometry = changed.some(k => GEOMETRY.has(k));
    if (geometry) {
      calculateMapCoordinates(); // the .map file stores mapCoordinates next to the sliders
      if (draw && layerIsOn("toggleCoordinates")) {
        drawCoordinates();
        redrawn.push("coordinates");
      }
    }
    if (changed.includes("distanceScale") || changed.includes("distanceUnit")) {
      try {
        if (typeof calculateFriendlyGridSize === "function") calculateFriendlyGridSize();
        if (draw) {
          drawScaleBar(scaleBar, scale);
          fitScaleBar(scaleBar, svgWidth, svgHeight);
          redrawn.push("scaleBar");
        }
      } catch {}
    }
    if (changed.includes("temperatureScale") && draw && layerIsOn("toggleTemperature")) {
      drawTemperature();
      redrawn.push("temperature");
    }
    return redrawn;
  }

  // ---------------------------------------------------------------- edit {type:'map'}

  /** Fold op-level lock/unlock lists into the op's set (the pseudo fields). */
  function foldOps(ops) {
    if (!Array.isArray(ops)) return ops;
    const asList = v => (Array.isArray(v) ? v : [v]);
    return ops.map(op => {
      if (!isObj(op) || (op.lock === undefined && op.unlock === undefined)) return op;
      const { lock: l, unlock: u, ...rest } = op;
      if (rest.set !== undefined && !isObj(rest.set)) return op; // the core check reports it
      const set = { ...(rest.set || {}) };
      for (const [key, v] of [
        ["lock", l],
        ["unlock", u]
      ]) {
        if (v !== undefined) set[key] = key in set ? [...asList(set[key]), ...asList(v)] : v;
      }
      return { ...rest, set };
    });
  }

  const dropPseudo = side => {
    if (isObj(side)) {
      delete side.lock;
      delete side.unlock;
    }
  };
  const hasContent = row =>
    !!row.locks || Object.keys(row.before || {}).length > 0 || Object.keys(row.after || {}).length > 0;

  function locksOf(set) {
    const d = directivesOf(set);
    const out = {};
    if (d.lock.length) out.lock = d.lock;
    if (d.unlock.length) out.unlock = d.unlock;
    return Object.keys(out).length ? out : null;
  }

  const baseEdit = FNS.edit;
  FNS.edit = async a => {
    if (a.type !== "map") {
      if (a.recalculate !== undefined && a.recalculate !== "none")
        fail("BAD_ARGS", "recalculate applies to edit type 'map' only");
      if (Array.isArray(a.ops) && a.ops.some(op => isObj(op) && (op.lock !== undefined || op.unlock !== undefined)))
        fail("BAD_ARGS", "op lock/unlock lists apply to edit type 'map' only (burgs and states: set {lock:true})");
      return baseEdit(a);
    }
    const mode = modeOf(a);
    const stages = STAGES[mode];
    // recalculate with no ops is the recalculate-only call
    let rawOps = a.ops;
    let recalcOnly = false;
    if (!Array.isArray(rawOps) || !rawOps.length) {
      if (mode === "none")
        fail("BAD_ARGS", "ops must be a non-empty array (pass recalculate and no ops to only refresh derived data)");
      rawOps = [{ set: { lock: [] } }];
      recalcOnly = true;
    }
    const ops = foldOps(rawOps);
    const directives = Array.isArray(ops) ? ops.map(op => (isObj(op) ? locksOf(op.set) : null)) : [];
    const before = watchNow();
    const touchesDerived = stages.includes("rivers") || stages.includes("biomes");
    const derived = touchesDerived ? derivedPrint() : null;
    const out = await baseEdit({ ...a, ops });

    if (out.phase === "validate") {
      const changed = new Set();
      for (const row of out.plan || []) {
        if (isObj(row.before) && isObj(row.after))
          for (const key of WATCH) if (key in row.after && !same(row.before[key], row.after[key])) changed.add(key);
        dropPseudo(row.before);
        dropPseudo(row.after);
        const lk = directives[row.index];
        if (lk) row.locks = lk;
      }
      if (recalcOnly) out.plan = [];
      const stale = staleReport([...changed], mode);
      if (stale) out.stale = stale;
      if (mode !== "none") out.recalculate = mode;
      if (touchesDerived) {
        const { replaces, keeps } = replacesReport(mode);
        out.replaces = replaces;
        if (Object.keys(keeps).length) out.keeps = keeps;
        out.derived = derived; // replay compares it with the page it replays onto
      }
      return out;
    }

    for (const row of out.applied || []) {
      dropPseudo(row.before);
      dropPseudo(row.after);
      const lk = directives[row.index];
      if (lk) row.locks = lk;
    }
    for (const op of out.resolved?.ops || []) {
      dropPseudo(op.before);
      dropPseudo(op.after);
    }
    if (!(out.applied || []).length) return out;

    const after = watchNow();
    const changed = WATCH.filter(k => !same(before[k], after[k]));
    // a locked setting that changed keeps its stored value current (a lock listed before the value in
    // the same call, or a plain set on a locked setting, would leave the old value in localStorage)
    for (const n of changed)
      if (own(SETTINGS, n) && isLockedSetting(n)) {
        try {
          lockSetting(n);
        } catch {}
      }
    const settingsChanged = changed.filter(k => own(SETTINGS, k));
    const draw = a.redraw !== false;
    const redrawn = [];
    if (mode === "none") redrawn.push(...refreshDisplay(settingsChanged, draw));
    else {
      const r = await recalculate(
        mode,
        settingsChanged.some(k => GEOMETRY.has(k)),
        draw
      );
      const { redrawn: drawn, ...report } = r;
      out.recalculated = report;
      redrawn.push(...drawn);
      out.resolved.recalculate = mode;
      if (derived !== null) out.resolved.derived = derived;
      out.notes = out.notes || [];
      if (stages.includes("rivers"))
        out.notes.push("rivers were regenerated: river ids, names and manual river edits are replaced");
      if (stages.includes("biomes"))
        out.notes.push(
          `biomes were recomputed (${r.biomeCellsChanged} cells changed): hand-painted biome cells are replaced${r.kept?.customBiomeCells ? `; ${r.kept.customBiomeCells} custom-biome cells were kept` : ""}`
        );
      redrawn.push(
        ...refreshDisplay(
          settingsChanged.filter(k => !GEOMETRY.has(k)),
          draw
        )
      ); // scale bar, labels
    }
    if (redrawn.length) {
      out.redrawn = [...new Set([...(out.redrawn || []), ...redrawn])];
      await T.settle();
    }
    // the recalculate-only form, and ops that only repeated a value, leave no empty rows behind
    if (out.resolved?.ops && out.applied.length === out.resolved.ops.length) {
      const keep = out.applied.map(hasContent);
      out.resolved.ops = out.resolved.ops.filter((_o, k) => keep[k]);
      out.applied = out.applied.filter((_r, k) => keep[k]);
    }
    const stale = staleReport(changed, mode);
    if (stale) out.stale = stale;
    return out;
  };

  // ---------------------------------------------------------------- map_info, digest, diff

  const baseSummary = FNS.summary;
  FNS.summary = a => {
    const s = baseSummary(a);
    const block = settingsNow();
    block.locked = lockedNames();
    return { ...s, settings: block };
  };

  const baseDigest = FNS.digest;
  FNS.digest = a => {
    const d = baseDigest(a);
    // the world settings, the other map-level fields edit {type:'map'} sets, which settings are
    // locked (they are part of the .map text) and the grid climate (temperature, precipitation)
    const climate = { temp: T.pure.hashArray(grid.cells.temp || []), prec: T.pure.hashArray(grid.cells.prec || []) };
    const s = hashStr(JSON.stringify([settingsNow(), mapFields(), lockedNames(), climate]));
    return { ...d, hash: hashStr(`${d.hash}|${s}`), settings: s, climate };
  };

  const copyOf = arr => (arr && typeof arr.slice === "function" ? arr.slice() : null);
  const stateBaselines = new Map();
  const baseSetBaseline = FNS.setBaseline;
  FNS.setBaseline = a => {
    const r = baseSetBaseline(a);
    stateBaselines.set(String(a.key), {
      settings: settingsNow(),
      map: mapFields(),
      locked: lockedNames(),
      temp: copyOf(grid.cells.temp),
      prec: copyOf(grid.cells.prec)
    });
    return r;
  };
  const baseDropBaseline = FNS.dropBaseline;
  FNS.dropBaseline = a => {
    const r = baseDropBaseline(a);
    for (const k of Array.isArray(a.keys) ? a.keys : [a.key]) stateBaselines.delete(String(k));
    return r;
  };
  const fromTo = (was, now, keys) => {
    const out = {};
    for (const k of keys) if (!same(was[k], now[k])) out[k] = { from: was[k], to: now[k] };
    return out;
  };
  const baseDiff = FNS.diff;
  FNS.diff = a => {
    const d = baseDiff(a);
    if (!d.available) return d;
    const was = stateBaselines.get(String(a.key));
    if (!was) return d;
    const changes = {};
    const settings = fromTo(was.settings, settingsNow(), NAMES);
    const nowLocked = lockedNames();
    if (!same(was.locked, nowLocked)) settings.locked = { from: was.locked, to: nowLocked };
    if (Object.keys(settings).length) changes.settings = settings;
    const map = fromTo(was.map, mapFields(), Object.keys(was.map));
    if (Object.keys(map).length) changes.map = map;
    // the grid climate has no projection of its own: count the changed grid cells
    const cells = {};
    for (const [key, arr, label] of [
      ["temp", grid.cells.temp, "gridTemp"],
      ["prec", grid.cells.prec, "gridPrec"]
    ]) {
      const n = was[key] && arr ? T.pure.diffArray(was[key], arr) : null;
      if (n) cells[label] = n;
    }
    if (Object.keys(cells).length) changes.cells = { ...(d.changes.cells || {}), ...cells };
    if (Object.keys(changes).length) {
      d.changes = { ...d.changes, ...changes };
      d.empty = false;
    }
    return d;
  };

  // ---------------------------------------------------------------- map io (locks ride in the text)

  const baseMapData = FNS.mapData;
  FNS.mapData = async a => {
    try {
      options[LOCKS_KEY] = lockedNames();
    } catch {}
    return baseMapData(a);
  };
  FNS.mapData.raw = true; // the map text is returned whole, not capped like a result value

  const baseLoadMap = FNS.loadMap;
  FNS.loadMap = async (a, meta) => {
    const out = await baseLoadMap(a, meta);
    try {
      const want = options?.[LOCKS_KEY];
      if (Array.isArray(want)) {
        const locked = applyLockSet(want);
        if (locked.length) out.locked = locked;
      }
    } catch {}
    return out;
  };

  // ---------------------------------------------------------------- generate_map

  const baseGenerate = FNS.generateMap;
  FNS.generateMap = async (a, meta) => {
    // generate_map options only set and lock the inputs; the generator reads the temperatures
    // from `options` and the distance scale from the global, so a locked input alone is ignored
    if (a.phase !== "validate" && isObj(a.options)) {
      for (const [id, v] of Object.entries(a.options)) {
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        const m = /^(temperature(?:Equator|NorthPole|SouthPole))(?:Input|Output)$/.exec(id);
        if (m) options[m[1]] = n;
        else if (id === "distanceScaleInput" && n > 0) distanceScale = n;
      }
    }
    const out = await baseGenerate(a, meta);
    // the setting locks in force (setting names, as edit map takes them; `locked` holds the app's ids)
    if (isObj(out) && out.phase !== "validate") out.settingsLocked = lockedNames();
    return out;
  };

  T.settings = { SETTINGS, NAMES, STAGES, settingsNow, lockedNames, isLockedSetting, recalculate };
})(globalThis);
