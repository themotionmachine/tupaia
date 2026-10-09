// Tupaia MCP bridge extension: biomes. A classic script injected after bridge.js and
// bridge-mutations.js; same rules as those (app globals by bare name at call time, no locals
// that shadow app globals such as biomes, icons, cells, prec, temperature, color, seed, scale).
//
// - edit/add type 'biome' (FIELDS.biome, ADD.biome): name, color, habitability, iconsDensity,
//   icons, cost; add copies a base biome. Biome ids are indexes into biomesData's arrays.
// - FNS.defineBiomes (phased): re-derive biomes from the climate with deterministic low-frequency
//   noise on temperature and moisture, then a boundary majority filter that leaves water and kept
//   (custom / listed) biomes alone. regenerate {parts:['biomes'], biomes:{...}} runs it.
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
  const RELIEF_NOTE =
    "iconsDensity and icons take effect when relief icons are next drawn; the icons on the map now are unchanged";

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
    // biome colours are saved comma-joined, so rgb()/hsl() forms would corrupt the file
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s) && !/^[a-z]+$/i.test(s))
      fail("BAD_ARGS", "biome color must be a hex colour such as #aa3322 (or a CSS colour name)");
    return s;
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
        if (x.i >= 0 && hasCells(x.i) && typeof rankCells === "function") {
          rankCells();
          c.notes.add(
            "habitability re-ranked cell suitability and rural population (rankCells); burg populations were kept (regenerate {parts:['population']} re-rolls them)"
          );
        }
      }
    },
    iconsDensity: {
      check: num("iconsDensity", 0, 500),
      get: x => biomesData.iconsDensity[x.i] ?? null,
      set: (x, v, c) => {
        biomesData.iconsDensity[x.i] = v;
        c.notes.add(RELIEF_NOTE);
      }
    },
    icons: {
      check: iconsCheck,
      get: x => iconWeights(biomesData.icons[x.i]),
      set: (x, w, c) => {
        biomesData.icons[x.i] = expandIcons(w);
        c.notes.add(RELIEF_NOTE);
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
      return { base: base ? base.i : null, baseName: base ? base.name : null, fs, id };
    },
    plan: (q, row) =>
      Object.assign(row, { i: q.id, name: q.fs.find(f => f.key === "name").v, base: q.baseName ?? undefined }),
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

  const TEMP_AMP = 4; // °C at noise 1
  const MOIST_AMP = 6; // moisture units at noise 1 (bands are 5 wide; hot desert is < 8)

  function defaultBiomeCount() {
    return Biomes.getDefault().name.length;
  }

  function regenOptions(a) {
    const from = a.from ?? "climate";
    if (!["climate", "current"].includes(from)) fail("BAD_ARGS", "from is 'climate' (default) or 'current'");
    const noise = a.noise === undefined ? 0 : num("noise", 0, 1)(a.noise);
    const smooth = a.smooth === undefined ? 0 : num("smooth", 0, 10)(a.smooth);
    if (!Number.isInteger(smooth)) fail("BAD_ARGS", "smooth is a number of passes (integer 0..10)");
    if (from === "current" && noise) fail("BAD_ARGS", "noise perturbs the climate inputs, so it needs from:'climate'");
    if (from === "current" && !smooth)
      fail("BAD_ARGS", "from:'current' only smooths the biomes as they are: give smooth >= 1");
    const featurePx =
      a.scale === undefined ? Math.round(Math.max(graphWidth, graphHeight) / 12) : num("scale", 10, 20000)(a.scale);
    if (a.seed !== undefined && typeof a.seed !== "number" && typeof a.seed !== "string")
      fail("BAD_ARGS", "seed is a number or a string");
    // default: derived from the map seed, so the same map and options give the same biomes
    const seedNum = seedOf(a.seed !== undefined ? a.seed : `${typeof seed !== "undefined" ? seed : ""}:biomes`);
    if (a.keepPainted !== undefined && typeof a.keepPainted !== "boolean")
      fail("BAD_ARGS", "keepPainted must be true or false");
    const keepPainted = a.keepPainted ?? true;
    if (a.keep !== undefined && !Array.isArray(a.keep)) fail("BAD_ARGS", "keep is a list of biome refs");
    const keepIds = new Set((a.keep || []).map(v => T.resolve("biome", v).i));
    if (keepPainted) for (let i = defaultBiomeCount(); i < biomesData.name.length; i++) keepIds.add(i);
    const scope = a.select !== undefined ? new Set(selectCells(a.select)) : null;
    return { from, noise, smooth, featurePx, seedNum, keepPainted, keepIds, scope };
  }

  /** The new biome per pack cell (a copy; nothing is written). */
  function computeBiomes(o) {
    const C = pack.cells;
    const n = C.i.length;
    const before = C.biome;
    const next = Uint8Array.from(before);
    const keptCell = i => o.keepIds.has(before[i]);
    const inScope = i => !o.scope || o.scope.has(i);
    let kept = 0;
    for (let i = 0; i < n; i++) if (inScope(i) && C.h[i] >= 20 && keptCell(i)) kept++;
    let fromClimate = 0;
    if (o.from === "climate") {
      const { fl, r, h, g } = C;
      const tempGrid = grid.cells.temp;
      const precGrid = grid.cells.prec;
      const seedT = o.seedNum;
      const seedM = (o.seedNum + 7919) % 2147483647;
      // as Biomes.define: own precipitation (+ river flux) averaged with land neighbours
      const moisture = i => {
        let m = precGrid[g[i]];
        if (r[i]) m += Math.max(fl[i] / 10, 2);
        let sum = m;
        let k = 1;
        for (const j of C.c[i])
          if (h[j] >= 20) {
            sum += precGrid[g[j]];
            k++;
          }
        return Math.round(4 + sum / k);
      };
      for (let i = 0; i < n; i++) {
        if (!inScope(i) || keptCell(i)) continue;
        let m = h[i] < 20 ? 0 : moisture(i);
        let t = tempGrid[g[i]];
        if (o.noise > 0 && h[i] >= 20) {
          const x = C.p[i][0] / o.featurePx;
          const y = C.p[i][1] / o.featurePx;
          t = Math.round(t + fbm(seedT, x, y) * o.noise * TEMP_AMP);
          m = Math.max(0, m + fbm(seedM, x, y) * o.noise * MOIST_AMP);
        }
        const b = Biomes.getId(m, t, h[i], Boolean(r[i]));
        if (b !== next[i]) fromClimate++;
        next[i] = b;
      }
    }
    let smoothed = 0;
    for (let pass = 0; pass < o.smooth; pass++) {
      const upd = [];
      for (let i = 0; i < n; i++) {
        if (C.h[i] < 20 || !inScope(i) || keptCell(i)) continue;
        // majority of the land neighbours that are not kept (kept biomes neither change nor spread)
        const counts = new Map();
        let land = 0;
        for (const j of C.c[i]) {
          if (C.h[j] < 20 || keptCell(j)) continue;
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
    return { next, kept, fromClimate, smoothed };
  }

  function changeStats(before, next) {
    const delta = {};
    const byBiome = {};
    let changed = 0;
    for (let i = 0; i < next.length; i++) {
      if (next[i] === before[i]) continue;
      changed++;
      delta[before[i]] = (delta[before[i]] || 0) - 1;
      delta[next[i]] = (delta[next[i]] || 0) + 1;
      if (!byBiome[next[i]]) byBiome[next[i]] = [];
      byBiome[next[i]].push(i);
    }
    const net = {};
    for (const [b, d] of Object.entries(delta)) if (d) net[biomesData.name[b] ?? `biome ${b}`] = d;
    return { changed, net, byBiome };
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
    const report = {
      from: o.from,
      noise: o.noise,
      smooth: o.smooth,
      scale: o.featurePx,
      seed: o.seedNum,
      cells: o.scope ? o.scope.size : pack.cells.i.length,
      kept: r.kept,
      changed: st.changed,
      smoothed: r.smoothed,
      net: st.net
    };
    if (a.phase !== "apply") return { phase: "validate", ...report };
    const B = pack.cells.biome;
    for (let i = 0; i < r.next.length; i++) B[i] = r.next[i];
    T.resetMemo?.();
    const msgs = [];
    if (st.changed) {
      msgs.push(
        "population and relief icons were not recomputed: add 'population' to parts to re-rank cells, and redraw relief to match the new biomes"
      );
    }
    const rd = st.changed ? await redrawBiomes(a, msgs) : { redrawn: [], skippedHidden: [] };
    return {
      ...report,
      redrawn: rd.redrawn,
      notes: msgs,
      resolved: { cells: st.byBiome, graph: T.cellGraph?.() ?? null }
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
        if (a.phase === "apply") C.biome[c] = id;
      }
    }
    const out = { changed, skipped: { water, unchanged } };
    if (a.phase !== "apply") return { phase: "validate", ...out };
    T.resetMemo?.();
    const msgs = [];
    const rd = changed ? await redrawBiomes(a, msgs) : { redrawn: [] };
    return { ...out, redrawn: rd.redrawn, notes: msgs, resolved: { cells: a.cells, graph: T.cellGraph?.() ?? null } };
  };

  // ---------------------------------------------------------------- feathered biome paint

  const SHAPE_KEYS = ["cells", "circle", "polygon", "entity"];

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
    if (!isObj(sel)) fail("BAD_ARGS", "select is {cells?, circle?, polygon?, entity?, where?}");
    const C = pack.cells;
    const P = C.p;
    const n = C.i.length;
    const shapeKeys = SHAPE_KEYS.filter(k => sel[k] !== undefined);
    const shapeSel = shapeKeys.length ? Object.fromEntries(shapeKeys.map(k => [k, sel[k]])) : sel;
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
    const cellsOut = shapeKeys.length && sel.where !== undefined ? selectCells({ cells: out, where: sel.where }) : out;
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
    return { ...out, feather: lit.stats };
  };

  T.biomes = { seedOf, hash01, valueNoise, fbm, iconWeights, RELIEF_ICONS };
})(globalThis);
