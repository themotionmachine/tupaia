// Tupaia MCP bridge extension: biomes. A classic script injected after bridge.js and
// bridge-mutations.js; same rules as those (app globals by bare name at call time, no locals
// that shadow app globals such as biomes, icons, cells, prec, temperature, color, seed, scale).
//
// - edit/add type 'biome' (FIELDS.biome, ADD.biome): name, color, habitability, iconsDensity,
//   icons, cost; add copies a base biome. Biome ids are indexes into biomesData's arrays.
// - FNS.defineBiomes (phased): re-derive biomes from the climate with deterministic low-frequency
//   noise (a domain warp of the climate, or jitter on temperature and moisture), then a boundary
//   majority filter and a small-region merge. Water, river cells (smoothing) and kept cells are
//   left alone: custom or listed biomes, cells that differ from their noise-free climate biome
//   (painted), and an exclude selection. regenerate {parts:['biomes'], biomes:{...}} runs it.
// - FNS.setBiomeCells (phased): the literal per-cell form the sketch log replays it with.
// - paint_cells feather: soft-edged biome painting; the dithered edge resolves to a literal cell
//   list, so the logged op replays as a plain paint.
(root => {
  const T = root.__tupaia;
  if (!T?.mutations) return;
  const FNS = T.fns;
  const fail = T.fail;
  const fold = T.pure.fold;
  const { FIELDS, ADD, selectCells } = T.mutations;

  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
  const rn = (v, d = 2) => {
    const m = 10 ** d;
    return Math.round(v * m) / m;
  };

  // ---------------------------------------------------------------- fields

  // relief icon types a biome can draw (index.html #relief-<type>-<n>); coniferSnow is picked
  // automatically for conifers below 0 °C
  const RELIEF_ICONS = [
    "acacia",
    "cactus",
    "conifer",
    "deadTree",
    "deciduous",
    "dune",
    "grass",
    "palm",
    "swamp",
    "hill",
    "mount",
    "mountSnow",
    "vulcan"
  ];
  /**
   * What happens to the relief icons drawn now. A map that draws them on load (reliefOnLoad,
   * bridge-ext/relief.js) has them redrawn after this MCP call when its relief layer is on.
   */
  function reliefNote() {
    const el = document.getElementById("terrain");
    const onLoad = !!el?.hasAttribute("data-regenerate");
    const shown = typeof layerIsOn !== "function" || layerIsOn("toggleRelief");
    if (onLoad && shown)
      return "iconsDensity and icons are drawn now: this map draws its relief icons on load (reliefOnLoad), so they are redrawn after this call (see the 'relief icons redrawn' note)";
    return "iconsDensity and icons take effect when relief icons are next drawn (regenerate {parts:['relief']} redraws them, seeded, for every biome); the icons on the map now are unchanged";
  }

  const num = (field, min, max) => v => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
      fail("BAD_ARGS", `${field} must be a number within ${min}..${max}`);
    return v;
  };

  function nameCheck(v, self, c) {
    if (typeof v !== "string" || !v.trim()) fail("BAD_ARGS", "biome name must be a non-empty string");
    const nm = v.trim();
    if (/[,|\r\n]/.test(nm))
      fail("BAD_ARGS", "a biome name cannot contain ',' or '|' (the .map file joins biome names with them)");
    if (nm.length > 64) fail("BAD_ARGS", "biome name is limited to 64 characters");
    if (fold(nm) === "removed") fail("BAD_ARGS", "'removed' is reserved: the app marks removed biomes with it");
    const taken = biomesData.name.findIndex((x, i) => i !== self && x !== "removed" && fold(x) === fold(nm));
    if (taken >= 0) fail("REFUSED", `biome ${taken} is already named '${biomesData.name[taken]}'`);
    c.biomeNames = c.biomeNames || new Set();
    if (c.biomeNames.has(fold(nm))) fail("REFUSED", `two items in this call name a biome '${nm}'`);
    c.biomeNames.add(fold(nm));
    return nm;
  }

  function colourCheck(v) {
    const s = typeof v === "string" ? v.trim() : "";
    const col = s && typeof d3 !== "undefined" ? d3.color(s) : null;
    if (!col?.displayable()) fail("BAD_ARGS", "biome color must be a colour such as #aa3322, 'teal' or rgb(170,51,34)");
    // stored as lowercase #rrggbb, as the biomes editor's colour picker writes it (and never with
    // commas: the .map joins biome colours with them); the page's d3 predates color.formatHex()
    const { r, g, b } = col.rgb();
    return `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  }

  function iconWeights(list) {
    const w = {};
    for (const k of list || []) w[k] = (w[k] || 0) + 1;
    return w;
  }

  function iconsCheck(v) {
    let w;
    if (Array.isArray(v)) {
      for (const s of v) if (typeof s !== "string") fail("BAD_ARGS", "icons array holds icon names");
      w = iconWeights(v);
    } else if (isObj(v)) {
      w = {};
      for (const [k, n] of Object.entries(v)) {
        if (!Number.isInteger(n) || n < 1 || n > 100) fail("BAD_ARGS", `icons.${k} weight must be an integer 1..100`);
        w[k] = n;
      }
    } else fail("BAD_ARGS", "icons is {iconName: weight} (e.g. {dune:3, cactus:6}) or [iconName, ...]; {} for none");
    for (const k of Object.keys(w))
      if (!RELIEF_ICONS.includes(k)) fail("BAD_ARGS", `unknown relief icon '${k}'`, { details: RELIEF_ICONS });
    if (Object.values(w).reduce((s, n) => s + n, 0) > 100) fail("BAD_ARGS", "icon weights add up to at most 100");
    return w;
  }

  const expandIcons = w => {
    const out = [];
    for (const [k, n] of Object.entries(w)) for (let j = 0; j < n; j++) out.push(k);
    return out;
  };

  function hasCells(i) {
    const b = pack.cells.biome;
    for (let c = 0; c < b.length; c++) if (b[c] === i) return true;
    return false;
  }

  // a biome with icon density but no icons makes the relief drawer reference missing symbols
  // (#relief-undefined-1), so the pair is checked together
  function iconPairCheck(density, weights) {
    if (density > 0 && !Object.keys(weights).length)
      fail(
        "BAD_ARGS",
        `iconsDensity ${density} with no icons would draw missing relief symbols: give icons too (e.g. icons:{grass:1}) or iconsDensity 0`
      );
  }

  /** Weights the op leaves the biome with (its own icons value if valid, else the current icons). */
  function iconsAfter(x, set) {
    if (set && set.icons !== undefined) {
      try {
        return iconsCheck(set.icons);
      } catch {
        return null; // reported by the icons field's own check
      }
    }
    return iconWeights(biomesData.icons[x.i]);
  }

  /**
   * Re-rank the cells of biome `id` after a habitability change. rankCells() recomputes every
   * cell (and the stored values of a curated map rarely match a fresh ranking), so every other
   * cell gets its old suitability and population back; state statistics are then refreshed.
   */
  function rerankBiome(id, c) {
    const C = pack.cells;
    const s0 = C.s;
    const p0 = C.pop;
    let before = 0;
    let n = 0;
    for (let i = 0; i < C.i.length; i++)
      if (C.biome[i] === id && C.h[i] >= 20) {
        before += p0?.[i] || 0;
        n++;
      }
    rankCells();
    let after = 0;
    for (let i = 0; i < C.i.length; i++) {
      if (C.biome[i] === id) {
        if (C.h[i] >= 20) after += C.pop[i];
      } else if (s0 && p0 && s0.length === C.s.length) {
        C.s[i] = s0[i];
        C.pop[i] = p0[i];
      }
    }
    if (typeof States !== "undefined" && States.collectStatistics) States.collectStatistics();
    const rate = typeof populationRate !== "undefined" ? populationRate : 1000;
    const people = v => Math.round(v * rate).toLocaleString("en-US");
    c.notes.add(
      `habitability of '${biomesData.name[id]}' re-ranked its ${n} land cells: rural population ${people(before)} -> ${people(after)} people (other cells unchanged; state statistics refreshed). Burg populations were kept (regenerate {parts:['population']} re-rolls them).`
    );
  }

  FIELDS.biome = {
    name: {
      check: (v, x, c) => nameCheck(v, x.i, c),
      get: x => biomesData.name[x.i] ?? null,
      set: (x, v) => {
        biomesData.name[x.i] = v;
      }
    },
    color: {
      check: colourCheck,
      get: x => biomesData.color[x.i] ?? null,
      set: (x, v, c) => {
        biomesData.color[x.i] = v;
        c.R.add("biomes");
      }
    },
    habitability: {
      check: num("habitability", 0, 9999),
      get: x => biomesData.habitability[x.i] ?? null,
      set: (x, v, c) => {
        biomesData.habitability[x.i] = v;
        if (x.i >= 0 && hasCells(x.i) && typeof rankCells === "function") rerankBiome(x.i, c);
      }
    },
    iconsDensity: {
      check: (v, x, _c, set) => {
        num("iconsDensity", 0, 500)(v);
        if (x.i >= 0) {
          const w = iconsAfter(x, set);
          if (w) iconPairCheck(v, w);
        }
        return v;
      },
      get: x => biomesData.iconsDensity[x.i] ?? null,
      set: (x, v, c) => {
        biomesData.iconsDensity[x.i] = v;
        c.notes.add(reliefNote());
      }
    },
    icons: {
      check: (v, x, _c, set) => {
        const w = iconsCheck(v);
        if (x.i >= 0) {
          const d = set && typeof set.iconsDensity === "number" ? set.iconsDensity : biomesData.iconsDensity[x.i];
          iconPairCheck(d, w);
        }
        return w;
      },
      get: x => iconWeights(biomesData.icons[x.i]),
      set: (x, w, c) => {
        biomesData.icons[x.i] = expandIcons(w);
        c.notes.add(reliefNote());
      }
    },
    cost: {
      check: num("cost", 0, 10000),
      get: x => biomesData.cost[x.i] ?? null,
      set: (x, v, c) => {
        biomesData.cost[x.i] = v;
        c.notes.add("cost is the movement cost states, cultures and religions pay when they expand (regenerate)");
      }
    }
  };

  const ADD_FIELDS = ["name", "base", "color", "habitability", "iconsDensity", "icons", "cost"];
  const MAX_BIOMES = 255; // pack.cells.biome is a Uint8Array

  ADD.biome = {
    check(item, c) {
      for (const k of Object.keys(item))
        if (!ADD_FIELDS.includes(k)) fail("BAD_FIELD", `biome items take no field '${k}'`, { details: ADD_FIELDS });
      if (item.name === undefined) fail("BAD_ARGS", "a new biome needs a name");
      const base = item.base !== undefined && item.base !== null ? T.resolve("biome", item.base) : null;
      c.biomeAdds = (c.biomeAdds || 0) + 1;
      const id = biomesData.i.length + c.biomeAdds - 1;
      if (id >= MAX_BIOMES)
        fail("REFUSED", `a map holds at most ${MAX_BIOMES} biomes (cells store the biome in a byte)`);
      const pseudo = { i: -1 };
      const fs = Object.keys(item)
        .filter(k => k !== "base")
        .map(key => ({ key, f: FIELDS.biome[key], v: FIELDS.biome[key].check(item[key], pseudo, c, item) }));
      // the values the new biome gets (explicit fields over the base's, else the editor's defaults)
      const d = biomesData;
      const b = base ? base.i : null;
      const given = Object.fromEntries(fs.map(f => [f.key, f.v]));
      const values = {
        name: given.name,
        color: given.color ?? (b !== null ? d.color[b] : "random"),
        habitability: given.habitability ?? (b !== null ? d.habitability[b] : 50),
        iconsDensity: given.iconsDensity ?? (b !== null ? d.iconsDensity[b] : 0),
        icons: given.icons ?? (b !== null ? iconWeights(d.icons[b]) : {}),
        cost: given.cost ?? (b !== null ? d.cost[b] : 50)
      };
      iconPairCheck(values.iconsDensity, values.icons);
      return { base: b, baseName: base ? base.name : null, fs, id, values };
    },
    plan: (q, row) => Object.assign(row, { i: q.id, ...q.values, base: q.baseName ?? undefined }),
    apply(q, c) {
      const d = biomesData;
      const i = d.i.length;
      if (i >= MAX_BIOMES) fail("REFUSED", `a map holds at most ${MAX_BIOMES} biomes`);
      const b = q.base;
      // defaults as the biomes editor's addCustomBiome, or a copy of the base biome
      d.i.push(i);
      d.name.push("Custom");
      d.color.push(b !== null ? d.color[b] : getRandomColor());
      d.habitability.push(b !== null ? d.habitability[b] : 50);
      d.iconsDensity.push(b !== null ? d.iconsDensity[b] : 0);
      d.icons.push(b !== null ? (d.icons[b] || []).slice() : []);
      d.cost.push(b !== null ? d.cost[b] : 50);
      for (const k of ["cells", "area", "rural", "urban"]) if (Array.isArray(d[k])) d[k].push(0);
      const x = { i };
      const cc = Object.assign(Object.create(c), { set: {} });
      for (const { f, v } of q.fs) f.set(x, v, cc);
      // literal values (the base is resolved away, so replay never re-reads it)
      const lit = {
        name: d.name[i],
        color: d.color[i],
        habitability: d.habitability[i],
        iconsDensity: d.iconsDensity[i],
        icons: iconWeights(d.icons[i]),
        cost: d.cost[i]
      };
      return { i, name: d.name[i], _r: lit };
    }
  };

  // edit {type:'biome', remove} would reach a REMOVE handler that does not exist: refuse plainly
  const baseEdit = FNS.edit;
  FNS.edit = async (a, meta) => {
    if (a && a.type === "biome" && Array.isArray(a.ops) && a.ops.some(o => isObj(o) && o.remove))
      fail(
        "REFUSED",
        "biomes cannot be removed (cells refer to biomes by index, so every id stays); rename the biome or repaint its cells with paint_cells"
      );
    return baseEdit(a, meta);
  };

  // ---------------------------------------------------------------- deterministic noise

  function seedOf(v) {
    if (typeof v === "number" && Number.isFinite(v)) return Math.abs(Math.trunc(v)) % 2147483647;
    const s = String(v ?? "");
    let h = 0x811c9dc5;
    for (let k = 0; k < s.length; k++) {
      h ^= s.charCodeAt(k);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0) % 2147483647;
  }

  /** [0,1) from a seed and two integers. */
  function hash01(s, x, y) {
    let h = (s ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  /** Smooth value noise in [-1,1] on a unit lattice. */
  function valueNoise(s, x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const a = hash01(s, xi, yi);
    const b = hash01(s, xi + 1, yi);
    const c = hash01(s, xi, yi + 1);
    const d = hash01(s, xi + 1, yi + 1);
    return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
  }

  /** Three octaves of value noise, roughly in [-1,1]; (x,y) in lattice units. */
  function fbm(s, x, y) {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = 1;
    for (let k = 0; k < 3; k++) {
      sum += amp * valueNoise(s + k * 1013, x * f, y * f);
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / norm;
  }

  // ---------------------------------------------------------------- regenerate biomes

  const TEMP_AMP = 4; // jitter: °C at noise 1
  const MOIST_AMP = 6; // jitter: moisture units at noise 1 (bands are 5 wide; hot desert is < 8)
  const WARP_AMP = 1; // warp: displacement in noise feature sizes at noise 1
  const KEPT_WHY = ["", "custom", "listed", "painted", "excluded"];

  function defaultBiomeCount() {
    return Biomes.getDefault().name.length;
  }

  function regenOptions(a) {
    const from = a.from ?? "climate";
    if (!["climate", "current"].includes(from)) fail("BAD_ARGS", "from is 'climate' (default) or 'current'");
    const mode = a.mode ?? "warp";
    if (!["warp", "jitter"].includes(mode)) fail("BAD_ARGS", "mode is 'warp' (default) or 'jitter'");
    const noise = a.noise === undefined ? 0 : num("noise", 0, 1)(a.noise);
    const smooth = a.smooth === undefined ? 0 : num("smooth", 0, 10)(a.smooth);
    if (!Number.isInteger(smooth)) fail("BAD_ARGS", "smooth is a number of passes (integer 0..10)");
    const minRegion = a.minRegion === undefined ? 0 : num("minRegion", 0, 1000)(a.minRegion);
    if (!Number.isInteger(minRegion)) fail("BAD_ARGS", "minRegion is a cell count (integer 0..1000)");
    if (from === "current" && noise) fail("BAD_ARGS", "noise perturbs the climate inputs, so it needs from:'climate'");
    if (from === "current" && !smooth && minRegion < 2)
      fail("BAD_ARGS", "from:'current' only cleans up the biomes as they are: give smooth >= 1 or minRegion >= 2");
    const featurePx =
      a.scale === undefined ? Math.round(Math.max(graphWidth, graphHeight) / 12) : num("scale", 10, 20000)(a.scale);
    if (a.seed !== undefined && typeof a.seed !== "number" && typeof a.seed !== "string")
      fail("BAD_ARGS", "seed is a number or a string");
    // default: derived from the map seed, so the same map and options give the same biomes
    const seedNum = seedOf(a.seed !== undefined ? a.seed : `${typeof seed !== "undefined" ? seed : ""}:biomes`);
    const keepPainted = a.keepPainted ?? true;
    if (![true, false, "custom"].includes(keepPainted))
      fail("BAD_ARGS", "keepPainted is true (default: custom biomes and painted cells), 'custom' or false");
    if (a.keepRivers !== undefined && typeof a.keepRivers !== "boolean")
      fail("BAD_ARGS", "keepRivers must be true or false");
    const keepRivers = a.keepRivers ?? true;
    if (a.keep !== undefined && !Array.isArray(a.keep)) fail("BAD_ARGS", "keep is a list of biome refs");
    const listedIds = new Set((a.keep || []).map(v => T.resolve("biome", v).i));
    const customFrom = keepPainted === false ? Infinity : defaultBiomeCount();
    const scope = a.select !== undefined ? new Set(selectCells(a.select)) : null;
    const exclude = a.exclude !== undefined ? new Set(selectCells(a.exclude)) : null;
    return {
      from,
      mode,
      noise,
      smooth,
      minRegion,
      featurePx,
      seedNum,
      keepPainted,
      keepRivers,
      listedIds,
      customFrom,
      scope,
      exclude
    };
  }

  /** Climate inputs as Biomes.define reads them, and the noise-free biome of a cell. */
  function climateKit() {
    const C = pack.cells;
    const { fl, r, h, g } = C;
    const precG = grid.cells.prec;
    const tempG = grid.cells.temp;
    const riverBonus = i => (r[i] ? Math.max(fl[i] / 10, 2) : 0);
    // own precipitation (+ the cell's river bonus) averaged with the land neighbours'
    const moistureAt = (j, bonus) => {
      let sum = precG[g[j]] + bonus;
      let k = 1;
      for (const nb of C.c[j])
        if (h[nb] >= 20) {
          sum += precG[g[nb]];
          k++;
        }
      return Math.round(4 + sum / k);
    };
    const climateOf = i =>
      h[i] < 20 ? 0 : Biomes.getId(moistureAt(i, riverBonus(i)), tempG[g[i]], h[i], Boolean(r[i]));
    return { C, tempG, riverBonus, moistureAt, climateOf };
  }

  /**
   * The noisy biome of a land cell. warp (default): the climate is read at a point displaced by
   * smooth noise (temperature corrected back to the cell's own altitude, the cell's own river and
   * height), so boundaries wiggle while biome totals stay close to the noise-free ones. jitter:
   * noise added to temperature and moisture; it shifts totals where moisture sits near its floor
   * (dry biomes grow).
   */
  function noisyClimate(K, o) {
    const C = K.C;
    const { h, g, r, p: P } = C;
    const seedA = o.seedNum;
    const seedB = (o.seedNum + 7919) % 2147483647;
    if (o.mode === "jitter") {
      return i => {
        const x = P[i][0] / o.featurePx;
        const y = P[i][1] / o.featurePx;
        const t = Math.round(K.tempG[g[i]] + fbm(seedA, x, y) * o.noise * TEMP_AMP);
        const m = Math.max(0, K.moistureAt(i, K.riverBonus(i)) + fbm(seedB, x, y) * o.noise * MOIST_AMP);
        return Biomes.getId(m, t, h[i], Boolean(r[i]));
      };
    }
    const hExp = Number(document.getElementById("heightExponentInput")?.value) || 2;
    const gh = grid.cells.h;
    // as calculateTemperatures: 6.5 °C per km of altitude
    const drop = hh => (hh < 20 ? 0 : Math.round(((hh - 18) ** hExp / 1000) * 6.5));
    const amp = o.noise * o.featurePx * WARP_AMP;
    const find = typeof findCell === "function" ? findCell : null;
    return i => {
      const x = P[i][0] / o.featurePx;
      const y = P[i][1] / o.featurePx;
      const dx = fbm(seedA, x, y) * amp;
      const dy = fbm(seedB, x, y) * amp;
      let j = i;
      // the displaced point must be land (else a shorter displacement, else the cell itself)
      for (const f of find ? [1, 0.5, 0.25] : []) {
        const qx = Math.min(graphWidth, Math.max(0, P[i][0] + dx * f));
        const qy = Math.min(graphHeight, Math.max(0, P[i][1] + dy * f));
        const k = find(qx, qy);
        if (k !== undefined && h[k] >= 20) {
          j = k;
          break;
        }
      }
      const t = j === i ? K.tempG[g[i]] : K.tempG[g[j]] + drop(gh[g[j]]) - drop(gh[g[i]]);
      return Biomes.getId(K.moistureAt(j, K.riverBonus(i)), t, h[i], Boolean(r[i]));
    };
  }

  /** The new biome per pack cell (a copy; nothing is written). */
  function computeBiomes(o) {
    const K = climateKit();
    const C = K.C;
    const h = C.h;
    const n = C.i.length;
    const before = C.biome;
    const next = Uint8Array.from(before);
    const inScope = i => !o.scope || o.scope.has(i);
    // why a land cell keeps its biome (KEPT_WHY index); kept cells neither change nor spread
    const kept = new Uint8Array(n);
    const keptBy = {};
    for (let i = 0; i < n; i++) {
      if (h[i] < 20) continue;
      const b = before[i];
      let why = 0;
      if (b >= o.customFrom) why = 1;
      else if (o.listedIds.has(b)) why = 2;
      else if (o.exclude?.has(i)) why = 4;
      else if (o.keepPainted === true && b !== K.climateOf(i)) why = 3;
      kept[i] = why;
      if (why && inScope(i)) keptBy[KEPT_WHY[why]] = (keptBy[KEPT_WHY[why]] || 0) + 1;
    }
    const held = i => kept[i] || (o.keepRivers && C.r[i]);
    let fromClimate = 0;
    if (o.from === "climate") {
      const noisy = o.noise > 0 ? noisyClimate(K, o) : null;
      for (let i = 0; i < n; i++) {
        if (!inScope(i) || kept[i]) continue;
        const b = h[i] < 20 ? 0 : noisy ? noisy(i) : K.climateOf(i);
        if (b !== next[i]) fromClimate++;
        next[i] = b;
      }
    }
    let smoothed = 0;
    for (let pass = 0; pass < o.smooth; pass++) {
      const upd = [];
      for (let i = 0; i < n; i++) {
        if (h[i] < 20 || !inScope(i) || held(i)) continue;
        // majority of the land neighbours that are not kept (river cells hold but still count)
        const counts = new Map();
        let land = 0;
        for (const j of C.c[i]) {
          if (h[j] < 20 || kept[j]) continue;
          land++;
          counts.set(next[j], (counts.get(next[j]) || 0) + 1);
        }
        if (!land) continue;
        let best = next[i];
        let bestN = counts.get(best) || 0;
        for (const [b, k] of counts)
          if (k > bestN) {
            best = b;
            bestN = k;
          }
        if (best !== next[i] && bestN * 2 > land) upd.push([i, best]);
      }
      if (!upd.length) break;
      for (const [i, b] of upd) next[i] = b;
      smoothed += upd.length;
    }
    let merged = 0;
    if (o.minRegion > 1) {
      // connected land regions of one biome under minRegion cells join their most common
      // neighbouring biome; regions holding a kept, held or out-of-scope cell stay
      const snap = Uint8Array.from(next);
      const comp = new Int32Array(n).fill(-1);
      let id = 0;
      for (let s = 0; s < n; s++) {
        if (h[s] < 20 || comp[s] >= 0) continue;
        const list = [s];
        comp[s] = id;
        for (let q = 0; q < list.length; q++)
          for (const j of C.c[list[q]])
            if (h[j] >= 20 && comp[j] < 0 && snap[j] === snap[s]) {
              comp[j] = id;
              list.push(j);
            }
        id++;
        if (list.length >= o.minRegion || list.some(c => !inScope(c) || held(c))) continue;
        const votes = new Map();
        for (const c of list)
          for (const j of C.c[c])
            if (h[j] >= 20 && snap[j] !== snap[s] && !kept[j]) votes.set(snap[j], (votes.get(snap[j]) || 0) + 1);
        let best = -1;
        let bestN = 0;
        for (const [b, k] of votes)
          if (k > bestN) {
            best = b;
            bestN = k;
          }
        if (best < 0) continue;
        for (const c of list) next[c] = best;
        merged += list.length;
      }
    }
    return { next, keptBy, fromClimate, smoothed, merged };
  }

  function changeStats(before, next) {
    const delta = {};
    const byBiome = {};
    const had = {};
    let changed = 0;
    for (let i = 0; i < next.length; i++) {
      had[before[i]] = (had[before[i]] || 0) + 1;
      if (next[i] === before[i]) continue;
      changed++;
      delta[before[i]] = (delta[before[i]] || 0) - 1;
      delta[next[i]] = (delta[next[i]] || 0) + 1;
      if (!byBiome[next[i]]) byBiome[next[i]] = [];
      byBiome[next[i]].push(i);
    }
    const net = {};
    const shifts = [];
    for (const [b, d] of Object.entries(delta)) {
      if (!d) continue;
      const nm = biomesData.name[b] ?? `biome ${b}`;
      net[nm] = d;
      const base = had[b] || 0;
      if (Math.abs(d) >= 20 && Math.abs(d) >= 0.15 * base)
        shifts.push(
          `${nm} ${d > 0 ? "+" : ""}${d}${base ? ` (${d > 0 ? "+" : ""}${Math.round((100 * d) / base)}%)` : ""}`
        );
    }
    return { changed, net, byBiome, shifts };
  }

  async function redrawBiomes(a, msgs) {
    if (a.redraw === false) return { redrawn: [], skippedHidden: [] };
    const layers = Array.isArray(a.redraw) ? a.redraw : ["biomes"];
    const out = await T.redraw({ layers });
    if (out.skippedHidden.includes("biomes")) msgs.push("the biomes layer is hidden, so it was not redrawn");
    return out;
  }

  FNS.defineBiomes = async a => {
    const o = regenOptions(a);
    const before = Uint8Array.from(pack.cells.biome);
    const r = computeBiomes(o);
    const st = changeStats(before, r.next);
    const keptTotal = Object.values(r.keptBy).reduce((s, v) => s + v, 0);
    const report = {
      from: o.from,
      ...(o.noise ? { mode: o.mode } : {}),
      noise: o.noise,
      smooth: o.smooth,
      ...(o.minRegion ? { minRegion: o.minRegion, merged: r.merged } : {}),
      scale: o.featurePx,
      seed: o.seedNum,
      cells: o.scope ? o.scope.size : pack.cells.i.length,
      kept: keptTotal,
      ...(keptTotal ? { keptBy: r.keptBy } : {}),
      changed: st.changed,
      smoothed: r.smoothed,
      net: st.net
    };
    const notes = [];
    if (o.noise && st.shifts.length)
      notes.push(
        `biome totals shifted: ${st.shifts.join(", ")}${o.mode === "jitter" ? "; mode:'warp' (default) keeps totals closer" : ""}`
      );
    if (r.keptBy.painted)
      notes.push(
        `${r.keptBy.painted} land cells differ from their climate biome (painted or edited) and were kept; keepPainted:'custom' re-derives them`
      );
    if (a.phase !== "apply") return { phase: "validate", ...report, ...(notes.length ? { notes } : {}) };
    const B = pack.cells.biome;
    for (let i = 0; i < r.next.length; i++) B[i] = r.next[i];
    T.resetMemo?.();
    if (st.changed) {
      notes.push(
        "population and relief icons were not recomputed: add 'population' to parts to re-rank cells, and redraw relief icons (regenerate {parts:['relief']}) to match the new biomes"
      );
    }
    const rd = st.changed ? await redrawBiomes(a, notes) : { redrawn: [], skippedHidden: [] };
    return {
      ...report,
      redrawn: rd.redrawn,
      notes,
      resolved: {
        cells: st.byBiome,
        graph: T.cellGraph?.() ?? null,
        ...(o.noise ? { seed: o.seedNum } : {}),
        net: st.net
      }
    };
  };

  // the replay form of a biomes regenerate: {cells: {<biome id>: [cell, ...]}}
  FNS.setBiomeCells = async a => {
    if (!isObj(a.cells)) fail("BAD_ARGS", "cells is {<biome id>: [cell ids]}");
    const C = pack.cells;
    const n = C.i.length;
    const plan = [];
    for (const [k, list] of Object.entries(a.cells)) {
      const id = T.resolve("biome", Number(k)).i;
      if (!Array.isArray(list)) fail("BAD_ARGS", `cells['${k}'] must be a list of cell ids`);
      for (const c of list)
        if (!Number.isInteger(c) || c < 0 || c >= n) fail("OUT_OF_BOUNDS", `cell ${c} is outside 0..${n - 1}`);
      plan.push([id, list]);
    }
    let changed = 0;
    let water = 0;
    let unchanged = 0;
    const delta = {};
    for (const [id, list] of plan) {
      for (const c of list) {
        if (C.h[c] < 20) {
          water++;
          continue;
        }
        if (C.biome[c] === id) {
          unchanged++;
          continue;
        }
        changed++;
        delta[C.biome[c]] = (delta[C.biome[c]] || 0) - 1;
        delta[id] = (delta[id] || 0) + 1;
        if (a.phase === "apply") C.biome[c] = id;
      }
    }
    const net = {};
    for (const [b, d] of Object.entries(delta)) if (d) net[biomesData.name[b] ?? `biome ${b}`] = d;
    const out = { changed, skipped: { water, unchanged }, net };
    if (a.phase !== "apply") return { phase: "validate", ...out };
    T.resetMemo?.();
    const msgs = [];
    const rd = changed ? await redrawBiomes(a, msgs) : { redrawn: [] };
    const resolved = { cells: a.cells, graph: T.cellGraph?.() ?? null, net };
    if (typeof a.seed === "number") resolved.seed = a.seed; // the original call's seed, for the op summary
    return { ...out, redrawn: rd.redrawn, notes: msgs, resolved };
  };

  // ---------------------------------------------------------------- feathered biome paint

  const SHAPE_KEYS = ["cells", "circle", "polygon", "entity", "buffer"];

  function featherOptions(a) {
    const f = a.feather;
    if (!isObj(f)) fail("BAD_ARGS", "feather is {width, unit?:'px'|'cells', seed?}");
    const keys = Object.keys(a.set || {});
    if (keys.length !== 1 || keys[0] !== "biome") fail("BAD_ARGS", "feather works with set:{biome} only");
    const unit = f.unit ?? "px";
    if (!["px", "cells"].includes(unit)) fail("BAD_ARGS", "feather.unit is 'px' (default) or 'cells'");
    const width = num("feather.width", 0.01, 5000)(f.width);
    const spacing = Math.sqrt((graphWidth * graphHeight) / pack.cells.i.length);
    const px = unit === "cells" ? width * spacing : width;
    if (f.seed !== undefined && typeof f.seed !== "number" && typeof f.seed !== "string")
      fail("BAD_ARGS", "feather.seed is a number or a string");
    return { px, unit, width, seed: f.seed };
  }

  /**
   * Cells of `sel` with a dithered edge: cells within width/2 of the selection's boundary are
   * painted with a probability that falls from 1 (inside) through 0.5 (on the boundary) to 0
   * (outside), by blobby noise plus per-cell jitter, so the edge frays both ways.
   */
  function featherCells(sel, biomeRef, f) {
    if (!isObj(sel)) fail("BAD_ARGS", "select is {cells?, circle?, polygon?, entity?, buffer?, where?, except?}");
    const C = pack.cells;
    const P = C.p;
    const n = C.i.length;
    selectCells(sel); // validates every key (unknown ones are BAD_FIELD) before the shape is split off
    const shapeKeys = SHAPE_KEYS.filter(k => sel[k] !== undefined && k !== "buffer");
    const shapeSel = shapeKeys.length
      ? Object.fromEntries([...shapeKeys, "buffer"].filter(k => sel[k] !== undefined).map(k => [k, sel[k]]))
      : sel;
    const shape = selectCells(shapeSel);
    const inShape = new Uint8Array(n);
    for (const c of shape) inShape[c] = 1;
    const seedNum = seedOf(f.seed !== undefined ? f.seed : `feather:${biomeRef}:${shape.join(",")}`);
    const half = f.px / 2;
    // distance to the nearest boundary point (midpoint of an inside/outside neighbour pair),
    // propagated over the cell graph within half the width
    const dist = new Float64Array(n).fill(Infinity);
    const sx = new Float64Array(n);
    const sy = new Float64Array(n);
    const queue = [];
    const offer = (k, mx, my) => {
      const d = Math.hypot(P[k][0] - mx, P[k][1] - my);
      if (d <= half && d < dist[k]) {
        dist[k] = d;
        sx[k] = mx;
        sy[k] = my;
        queue.push(k);
      }
    };
    for (const c of shape)
      for (const j of C.c[c])
        if (!inShape[j]) {
          const mx = (P[c][0] + P[j][0]) / 2;
          const my = (P[c][1] + P[j][1]) / 2;
          offer(c, mx, my);
          offer(j, mx, my);
        }
    for (let q = 0; q < queue.length; q++) {
      const k = queue[q];
      for (const j of C.c[k]) offer(j, sx[k], sy[k]);
    }
    const out = [];
    let band = 0;
    let added = 0;
    let dropped = 0;
    const lattice = Math.max(f.px * 0.75, 1);
    for (let c = 0; c < n; c++) {
      const inside = inShape[c] === 1;
      if (!(dist[c] <= half)) {
        if (inside) out.push(c);
        continue;
      }
      band++;
      const p = Math.min(1, Math.max(0, 0.5 + (inside ? dist[c] : -dist[c]) / f.px));
      const blob = Math.min(1, Math.max(0, (fbm(seedNum, P[c][0] / lattice, P[c][1] / lattice) + 1) / 2));
      const t = 0.5 * blob + 0.5 * hash01(seedNum + 1, c, 0);
      if (t < p) {
        out.push(c);
        if (!inside) added++;
      } else if (inside) dropped++;
    }
    // where and except (when the shape came from cells/circle/polygon/entity) filter the frayed result
    const post = {};
    if (shapeKeys.length && sel.where !== undefined) post.where = sel.where;
    if (sel.except !== undefined && sel.except !== null) post.except = sel.except;
    const cellsOut = Object.keys(post).length && out.length ? selectCells({ cells: out, ...post }) : out;
    return {
      cells: cellsOut,
      stats: {
        width: rn(f.px, 1),
        ...(f.unit === "cells" ? { widthCells: f.width } : {}),
        seed: seedNum,
        shape: shape.length,
        band,
        addedOutside: added,
        droppedInside: dropped,
        cells: cellsOut.length
      }
    };
  }

  const basePaint = FNS.paint;
  FNS.paint = async (a, meta) => {
    if (a.feather === undefined || a.feather === null) return basePaint(a, meta);
    const f = featherOptions(a);
    const lit = featherCells(a.select, a.set.biome, f);
    const { feather: _feather, ...rest } = a;
    const out = await basePaint({ ...rest, select: { cells: lit.cells } }, meta);
    const res = { ...out, feather: lit.stats };
    const spacing = Math.sqrt((graphWidth * graphHeight) / pack.cells.i.length);
    if (!lit.stats.band) {
      res.notes = [
        ...(Array.isArray(out.notes) ? out.notes : []),
        `feather width ${lit.stats.width} px is below the cell spacing (~${Math.round(spacing)} px), so no cell fell in the band and the edge stayed hard; use a wider width or unit:'cells' (2-4 cells frays visibly)`
      ];
    } else if (!lit.stats.addedOutside && !lit.stats.droppedInside) {
      res.notes = [
        ...(Array.isArray(out.notes) ? out.notes : []),
        `feather width ${lit.stats.width} px is about one cell spacing (~${Math.round(spacing)} px): ${lit.stats.band} cell(s) were in the band but none flipped, so the edge stayed hard; use unit:'cells' with width 2-4`
      ];
    }
    return res;
  };

  T.biomes = { seedOf, hash01, valueNoise, fbm, iconWeights, RELIEF_ICONS };
})(globalThis);
