// Tupaia MCP bridge extension (track 'relief'): relief icon settings and regenerate-on-load.
//
// The settings are attributes of #terrain (the app reads them on every relief draw, see
// src/renderers/relief-settings.ts, which also exports the helpers this file uses as the page
// global ReliefSettings), so every save carries them and every draw uses them: data-seed,
// data-scale, data-biomes, data-min-height, data-exclude, data-near-burgs and data-regenerate
// (saves drop the icons; a load draws them again). This file validates and writes them and
// draws the icons:
//   regenerate {parts:['relief'], relief:{...}}  (FNS.regenerate is wrapped; phased when relief-only)
//   edit map {set:{reliefOnLoad:true|false}}     (FIELDS.map.reliefOnLoad)
// On a reliefOnLoad map it also redraws the icons after any mutating call that changed what the
// renderer reads since the last draw (T.call and the app's drawReliefIcons are wrapped), so the page
// shows what a load will draw; and it adds a relief line to the map summary (map_info, load_map).
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
  const KEYS = [
    "density",
    "matchIcons",
    "perBiome",
    "minHeight",
    "exclude",
    "excludeAdd",
    "excludeRemove",
    "excludeGrid",
    "nearBurgs",
    "seed",
    "onLoad"
  ];
  const MAX_NEAR_PX = 1000;

  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
  const rn = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
  const same = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  const show = v => {
    const s = JSON.stringify(v ?? null);
    return s.length > 50 ? `${s.slice(0, 47)}...` : s;
  };
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

  /** The app's relief helpers (src/renderers/relief-settings.ts). */
  function RS() {
    const x = root.ReliefSettings;
    if (!x || typeof x.packCellKey !== "function")
      fail("PAGE_ERROR", "the app's relief settings hook is missing; rebuild dist (CF_BUILD=1 npx vite build)");
    return x;
  }

  const reliefOn = () => typeof layerIsOn !== "function" || layerIsOn("toggleRelief");

  // ---------------------------------------------------------------- exclusions

  /** Pack cells per grid cell (reGraph adds extra cells along the coast). */
  function packPerGrid() {
    const counts = new Uint16Array(grid.points.length);
    for (const g of pack.cells.g) counts[g]++;
    return counts;
  }

  /** Stored form of an excluded set of pack cells, or null when it is empty. */
  function encodeExclusion(packCells) {
    if (!packCells.size) return null;
    const rs = RS();
    const C = pack.cells;
    const byGrid = new Map();
    for (const c of packCells) {
      const g = C.g[c];
      if (!byGrid.has(g)) byGrid.set(g, []);
      byGrid.get(g).push(c);
    }
    const counts = packPerGrid();
    const full = [];
    const parts = [];
    for (const [g, list] of byGrid) {
      if (list.length >= counts[g]) full.push(g);
      else for (const c of list) parts.push(rs.packCellKey(g, C.p[c][0], C.p[c][1], grid.points, grid.cells.c));
    }
    parts.sort((x, y) => {
      const [a1, a2] = x.split(".").map(Number);
      const [b1, b2] = y.split(".").map(Number);
      return a1 - b1 || a2 - b2;
    });
    return `${rs.gridKey(grid.points)}:${rs.encodeRanges(full)}${parts.length ? `;${parts.join(",")}` : ""}`;
  }

  /** Pack cells a stored exclusion covers on this map (empty when absent or recorded on another grid). */
  function excludedCells(text) {
    const out = new Set();
    const info = exclusionInfo(text);
    if (!info || info.stale) return out;
    const rs = RS();
    const ex = rs.parseExclusion(text.slice(text.indexOf(":") + 1));
    const C = pack.cells;
    for (const c of C.i) {
      const g = C.g[c];
      if (ex.cells.has(g)) out.add(c);
      else if (ex.partGrids.has(g) && ex.parts.has(rs.packCellKey(g, C.p[c][0], C.p[c][1], grid.points, grid.cells.c)))
        out.add(c);
    }
    return out;
  }

  /** {key, cells, count, parts, max, stale} of a stored "<grid key>:<ranges>[;<g.e>,...]", or null. */
  function exclusionInfo(text) {
    const m = /^((\d+)-[0-9a-z]+):([\d,-]*)(?:;([\d.,]*))?$/.exec(String(text));
    if (!m) return null;
    let count = 0;
    let max = -1;
    for (const part of m[3].split(",")) {
      if (!part) continue;
      const [a, b] = part.split("-").map(Number);
      const last = Number.isInteger(b) ? b : a;
      if (!Number.isInteger(a) || last < a) return null;
      count += last - a + 1;
      max = Math.max(max, last);
    }
    const parts = (m[4] || "").split(",").filter(Boolean);
    for (const p of parts) {
      const [g, e] = p.split(".").map(Number);
      if (!Number.isInteger(g) || !Number.isInteger(e)) return null;
      max = Math.max(max, g, e);
    }
    return { key: m[1], cells: +m[2], count, parts: parts.length, max, stale: m[1] !== RS().gridKey(grid.points) };
  }

  /** Pack cells of a selection or a list of them (united); errors name the list item. */
  function cellsOf(field, v) {
    const sels = Array.isArray(v) ? v : [v];
    if (!sels.length || sels.length > 50) fail("BAD_ARGS", `${field} is a selection or a list of 1-50 selections`);
    const out = new Set();
    sels.forEach((sel, k) => {
      try {
        for (const c of M.selectCells(sel)) out.add(c);
      } catch (e) {
        if (e && typeof e === "object") e.message = `${Array.isArray(v) ? `${field}[${k}]` : field}: ${e.message}`;
        throw e;
      }
    });
    return out;
  }

  function literalGrid(v) {
    if (v === null) return null;
    const info = typeof v === "string" ? exclusionInfo(v) : null;
    if (!info) fail("BAD_ARGS", "relief.excludeGrid is '<grid key>:<ranges>[;<g.e>,...]'");
    if (info.stale)
      fail(
        "REFUSED",
        `the exclusion was recorded on another grid (${info.key}; this map's grid is ${RS().gridKey(grid.points)}): its cells would not be the same places`
      );
    if (info.max >= info.cells) fail("OUT_OF_BOUNDS", `grid cell ${info.max} is outside 0..${info.cells - 1}`);
    return v;
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

  /** The exclusion as tools report it: counts and the bbox of its grid points. */
  function exclusionView(text) {
    if (!text) return null;
    const info = exclusionInfo(text);
    if (!info) return { invalid: true };
    const out = { gridCells: info.count };
    if (info.parts) out.coastCells = info.parts;
    if (info.stale) {
      out.stale = "recorded on another grid (another map or a regrid); ignored";
      return out;
    }
    const ex = RS().parseExclusion(text.slice(text.indexOf(":") + 1));
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const g of [...ex.cells, ...ex.partGrids]) {
      const p = grid.points[g];
      if (!p) continue;
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
    }
    if (x0 <= x1) out.bbox = [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)];
    return out;
  }

  /** What tools report: biomes by name, the exclusion as counts. */
  function view(s) {
    const el = terrainEl();
    const perBiome = {};
    for (const [id, k] of Object.entries(s.perBiome)) perBiome[biomesData.name[id] ?? id] = k;
    return {
      density: s.match !== undefined ? { matchIcons: s.match } : s.density,
      perBiome,
      minHeight: s.minHeight,
      exclude: exclusionView(s.excludeGrid),
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

  /**
   * Check `input` against the stored settings `cur`. Returns {next, lit, notes}: the settings
   * after the call, the literal (replayable) form of the keys the call changes, and notes.
   * `next.match` is the icon count to match (matchIcons), resolved to a density by apply.
   */
  function parse(input, cur) {
    const a = input ?? {};
    if (!isObj(a))
      fail(
        "BAD_ARGS",
        "relief is {density?, matchIcons?, perBiome?, minHeight?, exclude?, excludeAdd?, excludeRemove?, nearBurgs?, seed?, onLoad?}"
      );
    for (const k of Object.keys(a))
      if (!KEYS.includes(k)) fail("BAD_ARGS", `unknown relief setting '${k}'`, { details: KEYS });
    const excl = ["exclude", "excludeGrid"].filter(k => a[k] !== undefined);
    if (excl.length > 1 || (excl.length && (a.excludeAdd !== undefined || a.excludeRemove !== undefined)))
      fail("BAD_ARGS", "give one of exclude, excludeGrid, or excludeAdd/excludeRemove");
    if (a.density !== undefined && a.matchIcons !== undefined) fail("BAD_ARGS", "give density or matchIcons, not both");
    const next = { ...cur, perBiome: { ...cur.perBiome } };
    const lit = {};
    const notes = [];
    if (a.density !== undefined)
      lit.density = next.density = a.density === null ? 1 : num("relief.density", 0, 2)(a.density);
    if (a.matchIcons !== undefined) {
      if (a.matchIcons === true) next.match = terrainEl().childElementCount;
      else next.match = num("relief.matchIcons", 0, 1e7)(a.matchIcons);
      if (!Number.isInteger(next.match)) fail("BAD_ARGS", "relief.matchIcons is true or a whole number of icons");
      if (a.matchIcons === true && !reliefOn())
        fail(
          "BAD_ARGS",
          "relief.matchIcons:true counts the icons on the page, but the relief layer is off; give a number"
        );
    }
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
    if (a.exclude !== undefined) {
      const cells = a.exclude === null ? new Set() : cellsOf("relief.exclude", a.exclude);
      lit.excludeGrid = next.excludeGrid = encodeExclusion(cells);
      if (a.exclude !== null && !cells.size) notes.push("relief.exclude selected no cells; nothing is excluded now");
    }
    if (a.excludeAdd !== undefined || a.excludeRemove !== undefined) {
      const info = cur.excludeGrid ? exclusionInfo(cur.excludeGrid) : null;
      if (info?.stale) notes.push("the stored exclusion was recorded on another grid; it is replaced");
      const cells = excludedCells(cur.excludeGrid);
      const added = a.excludeAdd === undefined ? new Set() : cellsOf("relief.excludeAdd", a.excludeAdd);
      const removed = a.excludeRemove === undefined ? new Set() : cellsOf("relief.excludeRemove", a.excludeRemove);
      const before = cells.size;
      for (const c of added) cells.add(c);
      const grew = cells.size - before;
      let dropped = 0;
      for (const c of removed) if (cells.delete(c)) dropped++;
      if (a.excludeAdd !== undefined && !grew)
        notes.push("relief.excludeAdd added no cells (none selected or all excluded already)");
      if (a.excludeRemove !== undefined && !dropped)
        notes.push("relief.excludeRemove removed no cells (none of them were excluded)");
      lit.excludeGrid = next.excludeGrid = encodeExclusion(cells);
    }
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
    if (next.seed === null) lit.seed = next.seed = String(seed); // a regenerated relief is always seeded
    return { next, lit, notes };
  }

  /** The stored values of the keys `lit` sets: the replay compares them with the target map's. */
  function baseOf(lit, cur) {
    const out = {};
    for (const k of Object.keys(lit)) out[k] = cur[k] ?? null;
    return out;
  }

  /** Replay check: keys both the sketch and someone else changed since the sketch recorded them. */
  function bothChanged(base, lit, cur) {
    const out = [];
    if (!isObj(base)) return out;
    for (const k of Object.keys(lit)) {
      if (!(k in base)) continue;
      const now = cur[k] ?? null;
      if (same(now, base[k]) || same(now, lit[k]) || same(base[k], lit[k])) continue;
      out.push({
        code: "CONFLICT",
        message: `both changed relief ${k}: base ${show(base[k])}, now ${show(now)}, sketch ${show(lit[k])}`
      });
    }
    return out;
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

  /** The density whose draw comes closest to `target` icons (the count goes with its square). */
  function matchDensity(s, target) {
    const count = d => {
      write({ ...s, density: d });
      drawReliefIcons();
      return terrainEl().childElementCount;
    };
    if (target === 0) return { density: 0, icons: count(0), tries: 1 };
    let d = s.density > 0 ? s.density : 1;
    let best = null;
    let lo = null;
    let hi = null;
    let tries = 0;
    for (; tries < 8; ) {
      const n = count(d);
      tries++;
      if (!best || Math.abs(n - target) < Math.abs(best.icons - target)) best = { density: d, icons: n };
      if (Math.abs(n - target) <= Math.max(2, target * 0.01)) break;
      if (n < target) lo = [d, n];
      else hi = [d, n];
      if (n < target && d >= 2) break;
      let nextD;
      if (lo && hi) {
        const t = (Math.sqrt(target) - Math.sqrt(lo[1])) / (Math.sqrt(hi[1]) - Math.sqrt(lo[1]) || 1);
        nextD = lo[0] + (hi[0] - lo[0]) * Math.min(0.9, Math.max(0.1, t));
      } else nextD = n > 0 ? d * Math.sqrt(target / n) : d * 2;
      nextD = Math.round(Math.min(2, Math.max(0.005, nextD)) * 1000) / 1000;
      if (nextD === d) break;
      d = nextD;
    }
    if (best.density !== d) count(best.density); // leave the best draw on the page
    return { ...best, tries };
  }

  /**
   * Draw the icons when the relief layer is shown. When it is hidden, clear them instead: the
   * layer toggle draws them (with the stored settings) when it is shown, and hidden icons would
   * only make saves bigger.
   */
  function refresh() {
    if (!reliefOn()) {
      terrainEl().replaceChildren();
      return { icons: 0, ms: 0, hidden: true };
    }
    const t0 = performance.now();
    drawReliefIcons();
    return { icons: terrainEl().childElementCount, ms: Math.round(performance.now() - t0) };
  }

  const HIDDEN_NOTE =
    "the relief layer is off: no icons are drawn now (and none are saved); display {on:['relief']} draws them with these settings";

  const ON_LOAD_NOTE =
    "saves now drop the relief icons and a load draws them again from the stored seed and settings; a build without this hook (e.g. an older deployed app) shows no relief until the Relief layer is toggled, so deploy before saving such a map to shared";

  /** Note when a redraw changed the icon count a lot (density 1 is the style default, not the old look). */
  function countNote(before, after, explicitDensity) {
    if (!before || explicitDensity) return null;
    const change = (after - before) / before;
    if (Math.abs(change) <= 0.05) return null;
    return `${after} icons where the map had ${before} (${change > 0 ? "+" : ""}${Math.round(change * 100)}%): density ${
      stored().density
    } is relative to the style default, not to the icons the map had; regenerate {parts:['relief'], relief:{matchIcons:${before}}} draws about as many as before`;
  }

  /** Phased: 'validate' returns the settings before/after; 'apply' writes them and redraws. */
  FNS.relief = async a => {
    const cur = stored();
    const { next, lit, notes } = parse(a.relief, cur);
    const errors = bothChanged(a.base, lit, cur);
    if (a.phase === "validate")
      return { phase: "validate", before: view(cur), after: view(next), ...(errors.length ? { errors } : {}) };
    if (errors.length) fail(errors[0].code, errors[0].message);
    const base = baseOf(lit, cur);
    const iconsBefore = terrainEl().childElementCount;
    let drawn;
    let matched = null;
    if (next.match !== undefined) {
      const t0 = performance.now();
      matched = matchDensity(next, next.match);
      lit.density = next.density = matched.density;
      if (!("density" in base)) base.density = cur.density;
      delete next.match;
      write(next);
      drawn = reliefOn() ? { icons: terrainEl().childElementCount, ms: Math.round(performance.now() - t0) } : refresh();
      notes.push(
        `matchIcons: density ${matched.density} draws ${matched.icons} icons (target ${a.relief.matchIcons === true ? `${iconsBefore}, the current count` : a.relief.matchIcons}; ${matched.tries} draws)`
      );
    } else {
      write(next);
      drawn = refresh();
    }
    if (drawn.hidden) notes.push(HIDDEN_NOTE);
    if (next.onLoad && !cur.onLoad) {
      notes.push(ON_LOAD_NOTE);
      const n = drawn.hidden ? null : countNote(iconsBefore, drawn.icons, "density" in (a.relief ?? {}) || matched);
      if (n) notes.push(n);
    }
    return {
      resolved: { parts: ["relief"], relief: lit, base },
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
  FNS.regenerate = async (a, meta) => {
    const parts = Array.isArray(a?.parts) ? a.parts : [];
    if (!parts.includes("relief")) {
      if (a?.relief !== undefined) fail("BAD_ARGS", "relief settings need 'relief' in parts");
      return baseRegenerate(a, meta);
    }
    const rest = parts.filter(p => p !== "relief");
    if (!rest.length) {
      // relief alone follows the phased protocol (dryRun, sketch replay)
      const out = await FNS.relief({ relief: a.relief, base: a.base, phase: a.phase ?? "apply" });
      return out.phase ? out : { ran: ["relief"], ...out };
    }
    if (a.phase === "validate") {
      // mixed with other parts: every wrapper below validates its own parts and changes nothing
      const v = await FNS.relief({ relief: a.relief, phase: "validate" });
      const inner = (await baseRegenerate({ ...a, parts: rest }, meta)) || {};
      const errors = [...(v.errors || []), ...(Array.isArray(inner.errors) ? inner.errors : [])];
      return { phase: "validate", ...(errors.length ? { errors } : {}) };
    }
    parse(a.relief, stored()); // invalid settings change nothing
    const out = await baseRegenerate({ ...a, parts: rest }, meta);
    const r = await FNS.relief({ relief: a.relief, phase: "apply" });
    // reliefResolved: the relief part's literal form, for a sketch op mixing replayable parts
    // (mcp/src/regen-replay.ts takes it out of the result)
    return {
      ...out,
      ran: [...out.ran, "relief"],
      relief: r.relief,
      notes: [...(out.notes || []), ...r.notes],
      reliefResolved: r.resolved
    };
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
      if (!reliefOn()) {
        if (el.childElementCount) el.replaceChildren();
        c.notes.add(HIDDEN_NOTE);
        return;
      }
      // what a reload will draw: seeded, so the page shows it now (manual relief edits are lost)
      const before = el.childElementCount;
      const drawn = refresh();
      c.notes.add(
        `relief icons redrawn from seed '${el.getAttribute(ATTR.seed)}' to match what a load draws: ${drawn.icons} icons (was ${before})`
      );
      const n = countNote(before, drawn.icons, false);
      if (n) c.notes.add(n);
    }
  };

  // ---------------------------------------------------------------- summary line (map_info, load_map)

  function brief() {
    const el = document.getElementById("terrain");
    if (!el) return null;
    const s = stored();
    const out = { icons: el.childElementCount };
    if (s.onLoad) out.onLoad = true;
    if (s.seed !== null) out.seed = s.seed;
    if (s.density !== 1) out.density = s.density;
    const pb = Object.keys(s.perBiome).length;
    if (pb) out.perBiome = pb;
    if (s.minHeight) out.minHeight = s.minHeight;
    if (s.excludeGrid) out.exclude = exclusionView(s.excludeGrid);
    if (s.nearBurgs) out.nearBurgs = s.nearBurgs;
    if (!reliefOn()) out.layer = "off";
    return out.icons || Object.keys(out).length > 1 ? out : null;
  }

  const baseSummary = FNS.summary;
  FNS.summary = a => {
    const s = baseSummary(a);
    try {
      const r = brief();
      if (r && isObj(s)) s.relief = r;
    } catch {}
    return s;
  };

  const baseLoadMap = FNS.loadMap;
  FNS.loadMap = async (a, meta) => {
    const s = await baseLoadMap(a, meta);
    try {
      const r = brief();
      if (r && isObj(s)) s.relief = r;
    } catch {}
    return s;
  };

  // ---------------------------------------------------------------- keep a reliefOnLoad map's page honest

  /**
   * Fingerprint of everything the relief renderer reads: the #terrain style and settings, heights,
   * biomes, rivers, cell numbering, temperatures (snowy icons), the biome icon tables, and burg
   * positions when nearBurgs is set.
   */
  function reliefInputs() {
    const el = document.getElementById("terrain");
    const C = pack?.cells;
    if (!el || !C?.h || !C.i) return "";
    let h = 0x811c9dc5;
    const add = v => {
      h = Math.imul(h ^ v, 0x01000193);
    };
    const addStr = s => {
      for (let k = 0; k < s.length; k++) add(s.charCodeAt(k));
    };
    for (const name of ["density", "size", "set", ...Object.values(ATTR)]) addStr(`${name}=${el.getAttribute(name)};`);
    const n = C.i.length;
    add(n);
    for (let i = 0; i < n; i++) {
      add(C.h[i]);
      add(C.biome[i]);
      add(C.r[i] ? 1 : 0);
      add(C.g[i]);
    }
    const temp = grid?.cells?.temp;
    if (temp) for (let i = 0; i < temp.length; i++) add(temp[i]);
    addStr(JSON.stringify(biomesData.iconsDensity) + JSON.stringify(biomesData.icons));
    if (el.getAttribute(ATTR.nearBurgs))
      for (const b of pack.burgs || [])
        if (b?.i && !b.removed) {
          add(Math.round(b.x * 10));
          add(Math.round(b.y * 10));
        }
    return (h >>> 0).toString(36);
  }

  const watching = () => !!document.getElementById("terrain")?.hasAttribute(ATTR.onLoad) && reliefOn();
  let lastDrawn = null; // reliefInputs() at the last relief draw (any caller: app, load hook, this file)

  /** Wrap the app's drawReliefIcons once it exists, to note what each draw was drawn from. */
  function ensureDrawHook() {
    const draw = root.drawReliefIcons;
    if (typeof draw !== "function" || draw.tupaiaRelief) return;
    const wrapped = (...args) => {
      const out = draw(...args);
      try {
        lastDrawn = reliefInputs();
      } catch {
        lastDrawn = null;
      }
      return out;
    };
    wrapped.tupaiaRelief = true;
    root.drawReliefIcons = wrapped;
  }

  function afterCall(env) {
    try {
      if (!env?.ok || !watching() || reliefInputs() === lastDrawn) return env;
      drawReliefIcons();
      const msg = `relief icons redrawn (${terrainEl().childElementCount}): this map draws them on load (reliefOnLoad), so the page now shows what a load will draw`;
      const v = env.value;
      if (isObj(v)) {
        if (v.notes === undefined) v.notes = [msg];
        else if (Array.isArray(v.notes)) v.notes.push(msg);
      }
    } catch (e) {
      console.warn("tupaia relief sync:", e);
    }
    return env;
  }

  const PENDING = new Set(); // retained until settled, like bridge.js INFLIGHT
  const baseCall = T.call;
  T.call = (name, args, meta) => {
    try {
      ensureDrawHook();
    } catch {}
    const p = baseCall(name, args, meta);
    if (!meta?.op) return p; // only mutating calls can change what the icons are drawn from
    const q = p.then(afterCall);
    PENDING.add(q);
    q.then(
      () => PENDING.delete(q),
      () => PENDING.delete(q)
    );
    return q;
  };

  // ---------------------------------------------------------------- for other bridge extensions

  /** The stored exclusion, by pack cell (regrid.js moves it to the new cells of a new grid). */
  T.relief = {
    exclusionText: () => document.getElementById("terrain")?.getAttribute(ATTR.excludeGrid) ?? null,
    exclusionInfo,
    excludedCells,
    encodeExclusion,
    setExclusion: text => {
      const el = terrainEl();
      if (text) el.setAttribute(ATTR.excludeGrid, text);
      else el.removeAttribute(ATTR.excludeGrid);
    }
  };
})(globalThis);
