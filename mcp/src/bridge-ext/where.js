// Tupaia MCP bridge extension (track 'condpaint'): condition predicates for select.where.
//
// A classic script injected after bridge.js, bridge-mutations.js and the bridge-ext files before
// it in name order (biomes.js: the deterministic noise). Same rules as bridge-mutations.js: app
// globals by bare name at call time, no locals that shadow app globals (prec, temperature, seed,
// scale, grid, pack, ...).
//
// It registers where keys in T.mutations.WHERE_EXT; bridge-mutations.js cellWhere compiles them
// next to its own (land, hMin, biome, state, ...), so every selection (paint_cells, zones,
// provinces, regenerate biomes select/exclude, relief exclude, apply) takes them:
//   all:[where...], any:[where...], not:where       combinators; a nested where takes every key
//   height, flux, precipitation, temperature         ranges {gte?, lte?, gt?, lt?} on the cell's value
//   x, y                                             ranges on the cell centre (map px)
//   slope {mode?:'max'|'mean', ...range}            height difference to the neighbours (water as 20)
//   riverDist {rivers?, tributaries?, minFlux?, ...range}   cells (graph steps over land) to the
//                                                    nearest river cell (river cells are 0)
//   aboveRiver {same options, ...range}              height above that nearest river cell
//   noise {scale, seed?, octaves?, ...range}         seeded value noise 0..1 (feature size scale px)
//   precipitation {smooth?, rainShadow?, ...range}    the precipitation regenerate biomes would read
//                                                    with the same rainShadow / smoothClimate options
//   temperature {smooth?, ...range}                  likewise smoothed
//   rainShadow {strength?, maxDistance?, unit?, ridge?, wind?, ...range}   the shadow's cut 0..1
//                                                    (share of precipitation the lee cell loses)
// Combinators nest at most MAX_DEPTH deep (a deeper where is BAD_ARGS, not a stack overflow).
// Nothing is evaluated from strings: every key and bound is checked, unknown ones are BAD_FIELD.
(root => {
  const T = root.__tupaia;
  if (!T?.mutations?.WHERE_EXT) return;
  const fail = T.fail;
  const EXT = T.mutations.WHERE_EXT;

  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
  const BOUNDS = ["gte", "lte", "gt", "lt"];

  /** A range {gte?, lte?, gt?, lt?} (plus the key's own options) -> x => boolean. */
  function rangeTest(name, v, options = []) {
    if (!isObj(v))
      fail(
        "BAD_ARGS",
        `where.${name} is a range {gte?, lte?, gt?, lt?}${options.length ? ` (+ ${options.join(", ")})` : ""}`
      );
    const allowed = [...BOUNDS, ...options];
    for (const k of Object.keys(v))
      if (!allowed.includes(k))
        fail("BAD_FIELD", `where.${name} does not take '${k}'; allowed: ${allowed.join(", ")}`, {
          details: { unknown: k, allowed }
        });
    const given = BOUNDS.filter(k => v[k] !== undefined);
    if (!given.length) fail("BAD_ARGS", `where.${name} needs at least one of gte, lte, gt, lt`);
    for (const k of given)
      if (typeof v[k] !== "number" || !Number.isFinite(v[k]))
        fail("BAD_ARGS", `where.${name}.${k} must be a finite number`);
    const { gte, lte, gt, lt } = v;
    return x =>
      (gte === undefined || x >= gte) &&
      (lte === undefined || x <= lte) &&
      (gt === undefined || x > gt) &&
      (lt === undefined || x < lt);
  }

  function biomesKit() {
    const B = T.biomes;
    if (!B?.shadowCuts) fail("UNAVAILABLE", "climate conditions need the biomes bridge extension");
    return B;
  }

  /** A value per cell computed on first use (one compile = one where tree = one map state). */
  function lazy(make) {
    let arr = null;
    return c => {
      if (!arr) arr = make();
      return arr[c];
    };
  }

  // ---------------------------------------------------------------- combinators

  const MAX_DEPTH = 32;
  let depth = 0; // compiling is synchronous, so one counter tracks the nesting of the tree being compiled

  /** Compile a nested where one level deeper (BAD_ARGS past MAX_DEPTH). */
  function nested(compile, w) {
    if (depth >= MAX_DEPTH) {
      depth = 0;
      fail("BAD_ARGS", `where nests all/any/not at most ${MAX_DEPTH} deep`);
    }
    depth++;
    try {
      return compile(w);
    } finally {
      depth = Math.max(0, depth - 1);
    }
  }

  function list(name, v, compile) {
    if (!Array.isArray(v) || !v.length) fail("BAD_ARGS", `where.${name} is a non-empty list of where objects`);
    return v.map((w, k) => {
      if (!isObj(w)) fail("BAD_ARGS", `where.${name}[${k}] is a where object`);
      return nested(compile, w);
    });
  }
  EXT.all = (v, compile) => {
    const tests = list("all", v, compile);
    return c => tests.every(t => t(c));
  };
  EXT.any = (v, compile) => {
    const tests = list("any", v, compile);
    return c => tests.some(t => t(c));
  };
  EXT.not = (v, compile) => {
    if (!isObj(v)) fail("BAD_ARGS", "where.not is a where object");
    const t = nested(compile, v);
    return c => !t(c);
  };

  // ---------------------------------------------------------------- cell values

  EXT.height = v => {
    const ok = rangeTest("height", v);
    const H = pack.cells.h;
    return c => ok(H[c]);
  };
  EXT.flux = v => {
    const ok = rangeTest("flux", v);
    const F = pack.cells.fl;
    return c => ok(F ? F[c] || 0 : 0);
  };
  // the grid's climate, as Biomes.define reads it: precipitation is the raw grid.cells.prec value
  // (the cell info shows it x 100 as mm: 12 there reads "1200 mm"), temperature in degrees Celsius.
  // smooth (passes of a land-neighbour mean) and rainShadow (precipitation only) give the inputs
  // regenerate biomes would read with smoothClimate / rainShadow.
  function passes(name, v) {
    if (v === undefined) return 0;
    if (!Number.isInteger(v) || v < 0 || v > 200)
      fail("BAD_ARGS", `where.${name}.smooth is a number of passes (integer 0..200)`);
    return v;
  }
  function climateField(name, v, key) {
    const smooth = passes(name, v.smooth);
    const rs = key === "prec" ? biomesKit().shadowOptions(v.rainShadow, `where.${name}.rainShadow`) : null;
    const G = pack.cells.g;
    const src = key === "prec" ? grid.cells.prec : grid.cells.temp;
    if (!smooth && !rs) return c => (src ? src[G[c]] || 0 : 0);
    return lazy(() => {
      const o = key === "prec" ? { rainShadow: rs, smoothPrec: smooth } : { smoothTemp: smooth };
      return biomesKit().adjustedClimate(o)[key];
    });
  }
  EXT.precipitation = v => {
    const ok = rangeTest("precipitation", v, ["smooth", "rainShadow"]);
    const at = climateField("precipitation", v, "prec");
    return c => ok(at(c));
  };
  EXT.temperature = v => {
    const ok = rangeTest("temperature", v, ["smooth"]);
    const at = climateField("temperature", v, "temp");
    return c => ok(at(c));
  };

  // the rain shadow's cut 0..1 (the share of precipitation a lee cell loses; 0 off the shadow)
  const SHADOW_KEYS = ["strength", "maxDistance", "unit", "ridge", "wind", "spread"];
  EXT.rainShadow = v => {
    const ok = rangeTest("rainShadow", v, SHADOW_KEYS);
    const opts = {};
    for (const k of SHADOW_KEYS) if (v[k] !== undefined) opts[k] = v[k];
    const rs = biomesKit().shadowOptions(opts, "where.rainShadow");
    const at = lazy(() => biomesKit().shadowCuts(rs).cuts);
    return c => ok(at(c));
  };

  // the cell centre in map px (a half-plane or band: "north of y 500" is y:{lt:500})
  for (const [k, axis] of [
    ["x", 0],
    ["y", 1]
  ])
    EXT[k] = v => {
      const ok = rangeTest(k, v);
      const P = pack.cells.p;
      return c => ok(P[c][axis]);
    };

  EXT.slope = v => {
    const ok = rangeTest("slope", v, ["mode"]);
    const mode = v.mode ?? "max";
    if (!["max", "mean"].includes(mode)) fail("BAD_ARGS", "where.slope.mode is 'max' (default) or 'mean'");
    const at = lazy(() => {
      const C = pack.cells;
      const H = C.h;
      const n = C.i.length;
      const out = new Float32Array(n);
      const eff = x => (x < 20 ? 20 : x); // water counts as sea level, so coasts are not cliffs
      for (let c = 0; c < n; c++) {
        let mx = 0;
        let sum = 0;
        let k = 0;
        for (const j of C.c[c]) {
          const d = Math.abs(eff(H[c]) - eff(H[j]));
          if (d > mx) mx = d;
          sum += d;
          k++;
        }
        out[c] = mode === "max" ? mx : k ? sum / k : 0;
      }
      return out;
    });
    return c => ok(at(c));
  };

  // ---------------------------------------------------------------- distance to rivers

  const RIVER_OPTS = ["rivers", "tributaries", "minFlux"];

  /** Which river cells count: all, or those of some rivers (and their tributaries), with flux >= minFlux. */
  function riverSources(name, v) {
    const C = pack.cells;
    let ids = null;
    if (v.rivers !== undefined) {
      const refs = Array.isArray(v.rivers) ? v.rivers : [v.rivers];
      if (!refs.length) fail("BAD_ARGS", `where.${name}.rivers is a non-empty list of river refs`);
      ids = new Set(refs.map(r => T.resolve("river", r).i));
      if (v.tributaries !== undefined && typeof v.tributaries !== "boolean")
        fail("BAD_ARGS", `where.${name}.tributaries must be true or false`);
      if (v.tributaries) {
        // every river whose parent chain reaches a listed river
        const parent = new Map((pack.rivers || []).map(r => [r.i, r.parent]));
        for (const r of pack.rivers || []) {
          let p = r.i;
          const seen = new Set();
          while (p && !seen.has(p) && !ids.has(p)) {
            seen.add(p);
            p = parent.get(p);
          }
          if (p && ids.has(p)) ids.add(r.i);
        }
      }
    } else if (v.tributaries !== undefined) fail("BAD_ARGS", `where.${name}.tributaries goes with rivers`);
    if (v.minFlux !== undefined && (typeof v.minFlux !== "number" || !Number.isFinite(v.minFlux) || v.minFlux < 0))
      fail("BAD_ARGS", `where.${name}.minFlux is a flux >= 0`);
    const minFlux = v.minFlux ?? 0;
    const out = [];
    for (let c = 0; c < C.i.length; c++) {
      const r = C.r[c];
      if (!r || C.h[c] < 20) continue;
      if (ids && !ids.has(r)) continue;
      if ((C.fl[c] || 0) < minFlux) continue;
      out.push(c);
    }
    return out;
  }

  /** Breadth-first over land from the source cells: steps and the nearest source's height. */
  function riverField(name, v) {
    const C = pack.cells;
    const H = C.h;
    const n = C.i.length;
    const dist = new Float64Array(n).fill(Infinity);
    const bed = new Float64Array(n).fill(NaN);
    const queue = riverSources(name, v);
    for (const c of queue) {
      dist[c] = 0;
      bed[c] = H[c];
    }
    for (let q = 0; q < queue.length; q++) {
      const c = queue[q];
      if (H[c] < 20) continue; // water cells get a distance but do not pass it on
      for (const j of C.c[c])
        if (dist[j] === Infinity) {
          dist[j] = dist[c] + 1;
          bed[j] = bed[c];
          queue.push(j);
        }
    }
    return { dist, bed };
  }

  EXT.riverDist = v => {
    const ok = rangeTest("riverDist", v, RIVER_OPTS);
    const at = lazy(() => riverField("riverDist", v).dist);
    return c => ok(at(c));
  };
  EXT.aboveRiver = v => {
    const ok = rangeTest("aboveRiver", v, RIVER_OPTS);
    const at = lazy(() => {
      const f = riverField("aboveRiver", v);
      const H = pack.cells.h;
      return Float64Array.from(f.bed, (b, c) => (Number.isNaN(b) ? Infinity : H[c] - b));
    });
    return c => ok(at(c));
  };

  // ---------------------------------------------------------------- noise

  EXT.noise = v => {
    const ok = rangeTest("noise", v, ["scale", "seed", "octaves"]);
    const B = T.biomes;
    if (!B?.valueNoise) fail("UNAVAILABLE", "noise needs the biomes bridge extension");
    if (typeof v.scale !== "number" || !Number.isFinite(v.scale) || v.scale < 1 || v.scale > 20000)
      fail("BAD_ARGS", "where.noise.scale is the feature size in map px (1..20000)");
    if (v.seed !== undefined && typeof v.seed !== "number" && typeof v.seed !== "string")
      fail("BAD_ARGS", "where.noise.seed is a number or a string");
    const oct = v.octaves ?? 3;
    if (!Number.isInteger(oct) || oct < 1 || oct > 6) fail("BAD_ARGS", "where.noise.octaves is an integer 1..6");
    const s = B.seedOf(v.seed ?? "noise");
    const sc = v.scale;
    const P = pack.cells.p;
    return c => {
      let sum = 0;
      let amp = 1;
      let norm = 0;
      let f = 1;
      for (let k = 0; k < oct; k++) {
        sum += amp * B.valueNoise(s + k * 1013, (P[c][0] / sc) * f, (P[c][1] / sc) * f);
        norm += amp;
        amp *= 0.5;
        f *= 2;
      }
      return ok(Math.min(1, Math.max(0, (sum / norm + 1) / 2)));
    };
  };
})(globalThis);
