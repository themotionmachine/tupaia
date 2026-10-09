// Tupaia MCP bridge extension: map settings (Configure World + Units editor) as edit-map fields.
// Injected after bridge.js and bridge-mutations.js (classic script; same rules: app globals by
// bare name at call time, no locals that shadow app globals, one args object per FNS function).
//
// What it adds:
//   - FIELDS.map: mapSize, latitude, longitude, temperatureEquator/NorthPole/SouthPole, winds,
//     precipitation, distanceScale, distanceUnit, areaUnit, heightUnit, heightExponent,
//     temperatureScale. Each takes a plain value or {value, lock:true|false}; the pseudo fields
//     lock:[names] / unlock:[names] (also accepted as op-level keys) use the app's lock()/unlock().
//   - edit {type:'map', recalculate:'none'|'climate'|'climate+biomes'}, with a list of the derived
//     layers that stay stale and how to refresh them.
//   - a settings block in the page summary (map_info), and settings in digest and diff, so a
//     settings-only edit is a change.
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

  // ---------------------------------------------------------------- value checks

  /** Number within min..max, rounded to `decimals` (the step of the app's own input). */
  const ranged = (name, min, max, decimals) => v => {
    if (typeof v !== "number" || !Number.isFinite(v)) fail("BAD_ARGS", `${name} must be a number`);
    if (v < min || v > max) fail("BAD_ARGS", `${name} must be within ${min}..${max}`);
    const m = 10 ** decimals;
    return Math.round(v * m) / m;
  };

  /** Unit name: a known value, a synonym of one, or a custom name (the app adds it to the list). */
  const unitName = (name, aliases) => v => {
    if (typeof v !== "string" || !v.trim()) fail("BAD_ARGS", `${name} must be a non-empty string`);
    const s = v.trim();
    if (s.length > 24) fail("BAD_ARGS", `${name} is at most 24 characters`);
    if (/[|\r\n]/.test(s))
      fail("BAD_ARGS", `${name} cannot contain '|' or line breaks (the .map file is '|' separated)`);
    if (s === "custom_name") fail("BAD_ARGS", `${name}: give the custom name itself, not 'custom_name'`);
    return aliases[fold(s)] ?? s;
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
    reaumur: "°Ré",
    réaumur: "°Ré",
    ro: "°Rø",
    romer: "°Rø",
    rømer: "°Rø"
  };
  const scaleName = v => {
    if (typeof v !== "string" || !v.trim()) fail("BAD_ARGS", "temperatureScale must be a string");
    const opts = [...(byId("temperatureScale")?.options || [])].map(o => o.value);
    const s = v.trim();
    const hit = opts.find(o => o === s) || TEMPERATURE_SCALES[fold(s)] || TEMPERATURE_SCALES[s.toLowerCase()];
    if (!hit || (opts.length && !opts.includes(hit)))
      fail("BAD_ARGS", `temperatureScale must be one of ${opts.join(" ")}`, { details: opts });
    return hit;
  };

  const windsCheck = v => {
    if (!Array.isArray(v) || v.length !== 6)
      fail("BAD_ARGS", "winds must be 6 numbers, one per 30-degree latitude tier from north to south");
    return v.map((d, k) => {
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

  /** Setting names from a lock/unlock value (a name, a list, or 'all'); strict about unknown names. */
  function lockNames(field, v) {
    const list = typeof v === "string" ? [v] : v;
    if (!Array.isArray(list) || !list.length)
      fail("BAD_ARGS", `${field} is a list of setting names, or 'all'`, { details: NAMES });
    const out = new Set();
    for (const raw of list) {
      if (typeof raw !== "string") fail("BAD_ARGS", `${field} entries are setting names`, { details: NAMES });
      const n = ALIASES[raw] ?? raw;
      if (n === "all") for (const x of NAMES) out.add(x);
      else if (SETTINGS[n]) out.add(n);
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
        } else if (SETTINGS[key] && isObj(v) && typeof v.lock === "boolean") (v.lock ? lockSet : unlockSet).add(key);
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
  const withLock = (name, check) => (v, _entity, _c, set) => {
    if (!isWrapped(v)) return check(v);
    const extra = Object.keys(v).filter(k => k !== "value" && k !== "lock");
    if (extra.length) fail("BAD_ARGS", `${name}: unexpected key '${extra[0]}' (use {value, lock})`);
    if ("lock" in v && typeof v.lock !== "boolean") fail("BAD_ARGS", `${name}.lock must be true or false`);
    const out = {};
    if ("value" in v) out.value = check(v.value);
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
      }
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
      get: () => null, // the lock state is a browser preference, not map state: never part of before/after
      show: v => v,
      set: (_x, names) => names.forEach(act)
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

  // ---------------------------------------------------------------- recalculation

  const MODES = ["none", "climate", "climate+biomes"];
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

  function modeOf(a) {
    const m = a.recalculate ?? "none";
    if (!MODES.includes(m)) fail("BAD_ARGS", `recalculate must be one of ${MODES.join(", ")}`, { details: MODES });
    return m;
  }

  /**
   * Derived layers that stay stale after `changed` settings were edited with recalculate `mode`,
   * as {"layer,layer": how to refresh}, or null.
   */
  function staleReport(changed, mode) {
    let temp = changed.some(k => TEMP_FIELDS.has(k));
    let prec = changed.some(k => PREC_FIELDS.has(k));
    // a recalculation with no climate setting changed (re-set to the same value): what changed
    // earlier is unknown, so everything downstream may be stale
    if (mode !== "none" && !temp && !prec) temp = prec = true;
    if (!temp && !prec) return null;
    const out = {};
    if (mode === "none") {
      const layers = [...(temp ? ["temperature"] : []), ...(prec ? ["precipitation"] : [])];
      out[layers.join(",")] = "edit map with recalculate 'climate' (set any setting to its current value)";
    }
    if (mode !== "climate+biomes")
      out["rivers,lakes,biomes"] =
        "edit map with recalculate 'climate+biomes' (regenerates rivers: ids, names and river edits are replaced)";
    const rest = [...(temp ? ["ice", "goods", "routes"] : []), "population"];
    out[rest.join(",")] = `regenerate parts [${rest.map(l => `'${l}'`).join(",")}] (random; replaces hand edits)`;
    return out;
  }

  /** Mulberry32 seeded from the map seed: the coastal rainfall term uses Math.random. */
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

  /**
   * The app's own "apply to an existing map" path (Configure World > updateWorld), minus the
   * dialog: temperature, precipitation and, for 'climate+biomes', rivers, lakes and biomes.
   * Redraws only layers that are on.
   */
  async function recalculate(mode, geometryChanged, draw) {
    const t0 = performance.now();
    const done = [];
    calculateMapCoordinates();
    calculateTemperatures();
    done.push("temperature");
    seededRandom("climate", () => generatePrecipitation());
    done.push("precipitation");
    if (mode === "climate+biomes") {
      Rivers.generate(false); // erosion off: heights stay as they are (updateWorld restores them)
      Rivers.specify();
      Features.defineGroups();
      Lakes.defineNames();
      Biomes.define();
      done.push("rivers", "lakes", "biomes");
    }
    const redrawn = [];
    if (draw) {
      if (layerIsOn("toggleTemperature")) {
        drawTemperature();
        redrawn.push("temperature");
      }
      if (layerIsOn("togglePrecipitation")) {
        drawPrecipitation();
        redrawn.push("precipitation");
      }
      if (geometryChanged && layerIsOn("toggleCoordinates")) {
        drawCoordinates();
        redrawn.push("coordinates");
      }
      if (mode === "climate+biomes") {
        const r = await T.redraw({ layers: ["biomes", "rivers"] });
        redrawn.push(...r.redrawn);
      }
    }
    return { mode, done, redrawn, ms: Math.round(performance.now() - t0) };
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
    const ops = foldOps(a.ops);
    const directives = Array.isArray(ops) ? ops.map(op => (isObj(op) ? locksOf(op.set) : null)) : [];
    const before = settingsNow();
    const out = await baseEdit({ ...a, ops });

    if (out.phase === "validate") {
      const changed = new Set();
      for (const row of out.plan || []) {
        if (isObj(row.before) && isObj(row.after))
          for (const key of NAMES) if (key in row.after && !same(row.before[key], row.after[key])) changed.add(key);
        dropPseudo(row.before);
        dropPseudo(row.after);
        const lk = directives[row.index];
        if (lk) row.locks = lk;
      }
      const stale = staleReport([...changed], mode);
      if (stale) out.stale = stale;
      if (mode !== "none") out.recalculate = mode;
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

    const after = settingsNow();
    const changed = NAMES.filter(k => !same(before[k], after[k]));
    const draw = a.redraw !== false;
    const redrawn = [];
    if (mode === "none") redrawn.push(...refreshDisplay(changed, draw));
    else {
      const r = await recalculate(
        mode,
        changed.some(k => GEOMETRY.has(k)),
        draw
      );
      out.recalculated = { mode: r.mode, done: r.done, ms: r.ms };
      redrawn.push(...r.redrawn);
      out.resolved.recalculate = mode;
      if (mode === "climate+biomes") {
        out.notes = out.notes || [];
        out.notes.push("rivers were regenerated: river ids, names and manual river edits are replaced");
      }
      redrawn.push(
        ...refreshDisplay(
          changed.filter(k => !GEOMETRY.has(k)),
          draw
        )
      ); // scale bar, labels
    }
    if (redrawn.length) {
      out.redrawn = [...new Set([...(out.redrawn || []), ...redrawn])];
      await T.settle();
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
    block.locked = NAMES.filter(n => {
      try {
        return isLockedSetting(n);
      } catch {
        return false;
      }
    });
    return { ...s, settings: block };
  };

  const baseDigest = FNS.digest;
  FNS.digest = a => {
    const d = baseDigest(a);
    // the world settings plus the other map-level fields edit {type:'map'} sets
    const extra = {
      name: typeof mapName !== "undefined" ? mapName.value : null,
      year: options.year ?? null,
      era: options.era ?? null,
      populationRate: typeof populationRate !== "undefined" ? populationRate : null,
      urbanization: typeof urbanization !== "undefined" ? urbanization : null
    };
    const s = hashStr(JSON.stringify([settingsNow(), extra]));
    return { ...d, hash: hashStr(`${d.hash}|${s}`), settings: s };
  };

  const settingsBaselines = new Map();
  const baseSetBaseline = FNS.setBaseline;
  FNS.setBaseline = a => {
    const r = baseSetBaseline(a);
    settingsBaselines.set(String(a.key), settingsNow());
    return r;
  };
  const baseDropBaseline = FNS.dropBaseline;
  FNS.dropBaseline = a => {
    const r = baseDropBaseline(a);
    for (const k of Array.isArray(a.keys) ? a.keys : [a.key]) settingsBaselines.delete(String(k));
    return r;
  };
  const baseDiff = FNS.diff;
  FNS.diff = a => {
    const d = baseDiff(a);
    if (!d.available) return d;
    const was = settingsBaselines.get(String(a.key));
    if (!was) return d;
    const now = settingsNow();
    const changes = {};
    for (const k of NAMES) if (!same(was[k], now[k])) changes[k] = { from: was[k], to: now[k] };
    if (Object.keys(changes).length) {
      d.changes = { ...d.changes, settings: changes };
      d.empty = false;
    }
    return d;
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
    return baseGenerate(a, meta);
  };

  T.settings = { SETTINGS, NAMES, settingsNow, isLockedSetting };
})(globalThis);
