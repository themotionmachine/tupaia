// Tupaia MCP bridge extension (track 'relief'): relief icon settings and regenerate-on-load.
//
// The settings are attributes of #terrain (the app reads them on every relief draw, see
// src/renderers/relief-settings.ts), so every save carries them and every draw uses them:
// data-seed, data-scale, data-biomes, data-min-height, data-exclude, data-near-burgs and
// data-regenerate (saves drop the icons; a load draws them again). This file validates and
// writes them and draws the icons:
//   regenerate {parts:['relief'], relief:{...}}  (FNS.regenerate is wrapped; phased when relief-only)
//   edit map {set:{reliefOnLoad:true|false}}     (FIELDS.map.reliefOnLoad)
// Same rules as bridge-mutations.js: app globals by bare name at call time, no locals that
// shadow app globals (terrain, seed, grid, pack, ...), one args object per FNS function.
(root => {
  const T = root.__tupaia;
  if (!T?.mutations) return;
  const FNS = T.fns;
  const fail = T.fail;
  const M = T.mutations;
  const fold = T.pure.fold;

  const ATTR = {
    onLoad: "data-regenerate",
    seed: "data-seed",
    density: "data-scale",
    perBiome: "data-biomes",
    minHeight: "data-min-height",
    excludeGrid: "data-exclude",
    nearBurgs: "data-near-burgs"
  };
  const KEYS = ["density", "perBiome", "minHeight", "exclude", "excludeGrid", "nearBurgs", "seed", "onLoad"];
  const MAX_NEAR_PX = 1000;

  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
  const rn = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
  const num = (field, min, max) => v => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
      fail("BAD_ARGS", `${field} must be a number within ${min}..${max}`);
    return v;
  };

  function terrainEl() {
    const el = document.getElementById("terrain");
    if (!el) fail("PAGE_ERROR", "the map has no #terrain group");
    return el;
  }

  const gridCount = () => grid.cells.i.length;

  // ---------------------------------------------------------------- grid cell ranges

  function encodeRanges(ids) {
    const s = [...new Set(ids)].sort((a, b) => a - b);
    const parts = [];
    for (let k = 0; k < s.length; k++) {
      const from = s[k];
      while (s[k + 1] === s[k] + 1) k++;
      parts.push(s[k] === from ? String(from) : `${from}-${s[k]}`);
    }
    return parts.join(",");
  }

  /** {cells, count} of a stored "n:ranges" exclusion; count = ids in it. */
  function rangesInfo(text) {
    const m = /^(\d+):([\d,-]*)$/.exec(String(text));
    if (!m) return null;
    let count = 0;
    let max = -1;
    for (const part of m[2].split(",")) {
      if (!part) continue;
      const [a, b] = part.split("-").map(Number);
      const last = Number.isInteger(b) ? b : a;
      if (!Number.isInteger(a) || last < a) return null;
      count += last - a + 1;
      max = Math.max(max, last);
    }
    return { cells: +m[1], count, max };
  }

  // ---------------------------------------------------------------- settings

  function biomeOf(key) {
    const names = biomesData.name;
    if (/^\d+$/.test(String(key).trim())) {
      const id = Number(key);
      if (id >= names.length) fail("NOT_FOUND", `no biome ${id}`, { details: names });
      return id;
    }
    const k = names.findIndex(n => fold(n) === fold(key));
    if (k < 0)
      fail("NOT_FOUND", `no biome named '${key}'`, {
        candidates: T.pure.rankCandidates(
          String(key),
          names.map((n, i) => ({ i, name: n }))
        ),
        details: names
      });
    return k;
  }

  /** The settings stored on #terrain (perBiome keyed by biome id). */
  function stored() {
    const el = terrainEl();
    const attr = n => el.getAttribute(n);
    const number = (n, d) => {
      const v = attr(n);
      return v !== null && v.trim() !== "" && Number.isFinite(+v) ? +v : d;
    };
    const perBiome = {};
    for (const pair of (attr(ATTR.perBiome) || "").split(",")) {
      const [id, k] = pair.split(":").map(Number);
      if (Number.isInteger(id) && Number.isFinite(k)) perBiome[id] = k;
    }
    return {
      onLoad: el.hasAttribute(ATTR.onLoad),
      seed: attr(ATTR.seed),
      density: number(ATTR.density, 1),
      perBiome,
      minHeight: number(ATTR.minHeight, 0),
      excludeGrid: attr(ATTR.excludeGrid),
      nearBurgs: number(ATTR.nearBurgs, 0)
    };
  }

  /** What tools report: biomes by name, the exclusion as a count. */
  function view(s) {
    const el = terrainEl();
    const perBiome = {};
    for (const [id, k] of Object.entries(s.perBiome)) perBiome[biomesData.name[id] ?? id] = k;
    let exclude = null;
    if (s.excludeGrid) {
      const info = rangesInfo(s.excludeGrid);
      exclude = info ? { gridCells: info.count } : { invalid: true };
      if (info && info.cells !== gridCount()) exclude.stale = `recorded on a grid of ${info.cells} cells; ignored`;
    }
    return {
      density: s.density,
      perBiome,
      minHeight: s.minHeight,
      exclude,
      nearBurgs: s.nearBurgs,
      seed: s.seed,
      onLoad: s.onLoad,
      style: {
        density: +el.getAttribute("density") || 0.4,
        size: +el.getAttribute("size") || 1,
        set: el.getAttribute("set") || "simple"
      }
    };
  }

  function nearBurgsPx(v) {
    if (typeof v === "number") return num("relief.nearBurgs", 0, MAX_NEAR_PX)(v);
    if (!isObj(v)) fail("BAD_ARGS", "relief.nearBurgs is a radius in px or {radius, unit:'px'|'km'|'mi'}");
    const r = num("relief.nearBurgs.radius", 0, Number.MAX_SAFE_INTEGER)(v.radius);
    const unit = v.unit ?? "px";
    if (!["px", "km", "mi"].includes(unit)) fail("BAD_ARGS", "relief.nearBurgs.unit is 'px', 'km' or 'mi'");
    let px = r;
    if (unit !== "px") {
      const mapUnit = document.getElementById("distanceUnitInput")?.value || "km";
      let inMapUnits = r;
      if (unit === "km" && mapUnit === "mi") inMapUnits = r / 1.609344;
      else if (unit === "mi" && mapUnit === "km") inMapUnits = r * 1.609344;
      else if (unit !== mapUnit)
        fail("BAD_ARGS", `the map's distance unit is '${mapUnit}'; give the radius in px or ${mapUnit}`);
      px = inMapUnits / distanceScale;
    }
    if (px > MAX_NEAR_PX) fail("BAD_ARGS", `relief.nearBurgs is ${rn(px)} px; at most ${MAX_NEAR_PX} px`);
    return rn(px);
  }

  /** Grid cells of a selection (or a list of them, united): pack cells -> their grid cells. */
  function excludeGridOf(v) {
    const sels = Array.isArray(v) ? v : [v];
    if (!sels.length || sels.length > 50)
      fail("BAD_ARGS", "relief.exclude is a selection or a list of 1-50 selections");
    const ids = new Set();
    for (const sel of sels) for (const c of M.selectCells(sel)) ids.add(pack.cells.g[c]);
    return ids.size ? `${gridCount()}:${encodeRanges(ids)}` : null;
  }

  function literalGrid(v) {
    if (v === null) return null;
    const info = typeof v === "string" ? rangesInfo(v) : null;
    if (!info) fail("BAD_ARGS", "relief.excludeGrid is '<grid cell count>:<ranges>'");
    if (info.cells !== gridCount())
      fail(
        "REFUSED",
        `the exclusion was recorded on a grid of ${info.cells} cells; this map's grid has ${gridCount()}`
      );
    if (info.max >= info.cells) fail("OUT_OF_BOUNDS", `grid cell ${info.max} is outside 0..${info.cells - 1}`);
    return v;
  }

  /**
   * Check `input` against the stored settings `cur`. Returns {next, lit}: the settings after the
   * call, and the literal (replayable) form of the keys the call gave.
   */
  function parse(input, cur) {
    const a = input ?? {};
    if (!isObj(a))
      fail("BAD_ARGS", "relief is {density?, perBiome?, minHeight?, exclude?, nearBurgs?, seed?, onLoad?}");
    for (const k of Object.keys(a))
      if (!KEYS.includes(k)) fail("BAD_ARGS", `unknown relief setting '${k}'`, { details: KEYS });
    if (a.exclude !== undefined && a.excludeGrid !== undefined)
      fail("BAD_ARGS", "give exclude or excludeGrid, not both");
    const next = { ...cur, perBiome: { ...cur.perBiome } };
    const lit = {};
    if (a.density !== undefined)
      lit.density = next.density = a.density === null ? 1 : num("relief.density", 0, 2)(a.density);
    if (a.perBiome !== undefined) {
      if (a.perBiome !== null && !isObj(a.perBiome))
        fail("BAD_ARGS", "relief.perBiome is {<biome name or id>: multiplier}");
      const table = {};
      for (const [key, k] of Object.entries(a.perBiome ?? {}))
        table[biomeOf(key)] = num(`relief.perBiome['${key}']`, 0, 2)(k);
      next.perBiome = table;
      lit.perBiome = { ...table };
    }
    if (a.minHeight !== undefined)
      lit.minHeight = next.minHeight = a.minHeight === null ? 0 : num("relief.minHeight", 0, 100)(a.minHeight);
    if (a.exclude !== undefined)
      lit.excludeGrid = next.excludeGrid = a.exclude === null ? null : excludeGridOf(a.exclude);
    if (a.excludeGrid !== undefined) lit.excludeGrid = next.excludeGrid = literalGrid(a.excludeGrid);
    if (a.nearBurgs !== undefined) lit.nearBurgs = next.nearBurgs = a.nearBurgs === null ? 0 : nearBurgsPx(a.nearBurgs);
    if (a.seed !== undefined) {
      if (a.seed !== null && typeof a.seed !== "string" && !Number.isInteger(a.seed))
        fail("BAD_ARGS", "relief.seed is a string or an integer");
      const s = a.seed === null ? String(seed) : String(a.seed);
      if (!s || s.length > 64) fail("BAD_ARGS", "relief.seed must be 1-64 characters");
      lit.seed = next.seed = s;
    }
    if (a.onLoad !== undefined) {
      if (typeof a.onLoad !== "boolean") fail("BAD_ARGS", "relief.onLoad must be true or false");
      lit.onLoad = next.onLoad = a.onLoad;
    }
    if (next.seed === null) next.seed = String(seed); // a regenerated relief is always seeded
    return { next, lit };
  }

  function write(s) {
    const el = terrainEl();
    const set = (name, v) =>
      v === null || v === undefined ? el.removeAttribute(name) : el.setAttribute(name, String(v));
    const biomes = Object.keys(s.perBiome)
      .map(Number)
      .sort((x, y) => x - y)
      .map(id => `${id}:${s.perBiome[id]}`)
      .join(",");
    set(ATTR.seed, s.seed);
    set(ATTR.density, s.density === 1 ? null : s.density);
    set(ATTR.perBiome, biomes || null);
    set(ATTR.minHeight, s.minHeight || null);
    set(ATTR.excludeGrid, s.excludeGrid);
    set(ATTR.nearBurgs, s.nearBurgs || null);
    set(ATTR.onLoad, s.onLoad ? "1" : null);
  }

  /**
   * Draw the icons when the relief layer is shown. When it is hidden, clear them instead: the
   * layer toggle draws them (with the stored settings) when it is shown, and hidden icons would
   * only make saves bigger.
   */
  function refresh() {
    if (typeof layerIsOn === "function" && !layerIsOn("toggleRelief")) {
      terrainEl().replaceChildren();
      return { icons: 0, ms: 0, hidden: true };
    }
    const t0 = performance.now();
    drawReliefIcons();
    return { icons: terrainEl().childElementCount, ms: Math.round(performance.now() - t0) };
  }

  const HIDDEN_NOTE =
    "the relief layer is off: no icons are drawn now; display {on:['relief']} draws them with these settings";

  const ON_LOAD_NOTE =
    "saves now drop the relief icons and a load draws them again from the stored seed and settings; a build without this hook (e.g. an older deployed app) shows no relief until the Relief layer is toggled, so deploy before saving such a map to shared";

  /** Phased: 'validate' returns the settings before/after; 'apply' writes them and redraws. */
  FNS.relief = async a => {
    const cur = stored();
    const { next, lit } = parse(a.relief, cur);
    if (a.phase === "validate") return { phase: "validate", before: view(cur), after: view(next) };
    const iconsBefore = terrainEl().childElementCount;
    write(next);
    const drawn = refresh();
    const notes = [];
    if (drawn.hidden) notes.push(HIDDEN_NOTE);
    if (next.onLoad && !cur.onLoad) notes.push(ON_LOAD_NOTE);
    if (a.relief?.exclude && next.excludeGrid === null)
      notes.push("relief.exclude selected no cells; nothing is excluded");
    return {
      resolved: { parts: ["relief"], relief: lit },
      relief: {
        icons: drawn.icons,
        iconsBefore,
        ms: drawn.ms,
        ...(drawn.hidden ? { hidden: true } : {}),
        settings: view(next)
      },
      notes
    };
  };

  // ---------------------------------------------------------------- regenerate {parts:[..., 'relief']}

  const baseRegenerate = FNS.regenerate;
  FNS.regenerate = async a => {
    const parts = Array.isArray(a?.parts) ? a.parts : [];
    if (!parts.includes("relief")) {
      if (a?.relief !== undefined) fail("BAD_ARGS", "relief settings need 'relief' in parts");
      return baseRegenerate(a);
    }
    const rest = parts.filter(p => p !== "relief");
    if (!rest.length) {
      // relief alone follows the phased protocol (dryRun, sketch replay)
      const out = await FNS.relief({ relief: a.relief, phase: a.phase ?? "apply" });
      return out.phase ? out : { ran: ["relief"], ...out };
    }
    parse(a.relief, stored()); // invalid settings change nothing
    const out = await baseRegenerate({ ...a, parts: rest });
    const r = await FNS.relief({ relief: a.relief, phase: "apply" });
    return { ...out, ran: [...out.ran, "relief"], relief: r.relief, notes: [...(out.notes || []), ...r.notes] };
  };

  // ---------------------------------------------------------------- edit map {set:{reliefOnLoad}}

  M.FIELDS.map.reliefOnLoad = {
    check: v => {
      if (typeof v !== "boolean") fail("BAD_ARGS", "reliefOnLoad must be true or false");
      return v;
    },
    get: () => !!document.getElementById("terrain")?.hasAttribute(ATTR.onLoad),
    set: (_x, v, c) => {
      const el = terrainEl();
      if (!v) {
        el.removeAttribute(ATTR.onLoad);
        return;
      }
      if (el.hasAttribute(ATTR.onLoad)) return;
      el.setAttribute(ATTR.onLoad, "1");
      if (!el.hasAttribute(ATTR.seed)) el.setAttribute(ATTR.seed, String(seed));
      c.notes.add(ON_LOAD_NOTE);
      if (el.childElementCount) {
        // what a reload will draw: seeded, so the page shows it now (manual relief edits are lost)
        const drawn = refresh();
        c.notes.add(
          drawn.hidden
            ? HIDDEN_NOTE
            : `relief icons redrawn from seed '${el.getAttribute(ATTR.seed)}' (${drawn.icons} icons) to match what a load draws`
        );
      }
    }
  };
})(globalThis);
