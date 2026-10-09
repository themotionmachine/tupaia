// Tupaia MCP bridge extension: terrain (set_heights, flow). Injected after bridge.js and
// bridge-mutations.js; same rules: app globals by bare name at call time, no locals that shadow
// app globals (pack, grid, seed, rivers, lakes, ice, ...), every FNS function takes one args object.
//
// setHeights follows the phased protocol: phase 'validate' resolves the source, fills, counts and
// checks, mutating nothing; phase 'apply' writes grid heights and rebuilds. The resolved form
// holds the FINAL grid heights (base64 bytes), so replaying it needs no source, no fill and no
// image; the rebuild itself is a deterministic function of (map seed, grid, heights, options, the
// map's entities).
//
// flow is read-only: it traces where water runs from a place the way Rivers.generate drains
// (alterHeights, closed lakes, resolveDepressions, lake outlets, havens, lowest neighbour), on
// the page's pack cells, or on the grid cells when proposed heights (or fill) are given.
(root => {
  const T = root.__tupaia;
  if (!T?.mutations) return;
  const FNS = T.fns;
  const fail = T.fail;
  const M = T.mutations;
  const hashArray = T.pure.hashArray;

  const rn = (v, d = 2) => {
    const m = 10 ** d;
    return Math.round(v * m) / m;
  };
  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);

  // ---------------------------------------------------------------- pure helpers

  function bytesToB64(u8) {
    let s = "";
    for (let k = 0; k < u8.length; k += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(k, k + 0x8000));
    return btoa(s);
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
    return out;
  }

  /**
   * Priority-flood depression filling on land (a bucket queue, heights are 0..255 integers).
   * Seeds: water cells (h < 20) and map-border cells. Every other cell ends at least as high as
   * the lowest spill level on its way to a seed, so no interior land cell is lower than all its
   * neighbours. Water cells are never changed. Returns {h, raised, maxRaise}.
   */
  function fillDepressions(h, nbrs, border) {
    const n = h.length;
    const out = Uint8Array.from(h);
    const done = new Uint8Array(n);
    const buckets = Array.from({ length: 256 }, () => []);
    for (let i = 0; i < n; i++) {
      if (out[i] < 20 || border[i]) {
        done[i] = 1;
        buckets[out[i]].push(i);
      }
    }
    for (let level = 0; level < 256; level++) {
      const q = buckets[level];
      for (let k = 0; k < q.length; k++) {
        for (const nb of nbrs[q[k]]) {
          if (done[nb]) continue;
          done[nb] = 1;
          if (out[nb] < level) out[nb] = level;
          buckets[out[nb]].push(nb);
        }
      }
    }
    let raised = 0;
    let maxRaise = 0;
    for (let i = 0; i < n; i++) {
      const d = out[i] - h[i];
      if (d > 0) {
        raised++;
        if (d > maxRaise) maxRaise = d;
      }
    }
    return { h: out, raised, maxRaise };
  }

  /** Water bodies of a height array: comp[i] = body index (-1 on land); bodies [{lake, size}]. */
  function waterBodies(h, nbrs, border) {
    const n = h.length;
    const comp = new Int32Array(n).fill(-1);
    const bodies = [];
    for (let s = 0; s < n; s++) {
      if (h[s] >= 20 || comp[s] !== -1) continue;
      const id = bodies.length;
      let touches = false;
      let size = 0;
      const stack = [s];
      comp[s] = id;
      while (stack.length) {
        const i = stack.pop();
        size++;
        if (border[i]) touches = true;
        for (const nb of nbrs[i])
          if (h[nb] < 20 && comp[nb] === -1) {
            comp[nb] = id;
            stack.push(nb);
          }
      }
      bodies.push({ lake: !touches, size });
    }
    return { comp, bodies };
  }

  /** Interior land cells strictly lower than every neighbour (water and border cells never count). */
  function countPits(h, nbrs, border) {
    let pits = 0;
    for (let i = 0; i < h.length; i++) {
      if (h[i] < 20 || border[i]) continue;
      let low = true;
      for (const nb of nbrs[i])
        if (h[nb] <= h[i]) {
          low = false;
          break;
        }
      if (low) pits++;
    }
    return pits;
  }

  /** Counts for a proposed height array against the current one (all grid-indexed). */
  function heightStats(cur, next, nbrs, border) {
    let changed = 0;
    let toLand = 0;
    let toWater = 0;
    let landBefore = 0;
    let landAfter = 0;
    for (let i = 0; i < next.length; i++) {
      if (cur[i] >= 20) landBefore++;
      if (next[i] >= 20) landAfter++;
      if (next[i] === cur[i]) continue;
      changed++;
      if (cur[i] < 20 && next[i] >= 20) toLand++;
      else if (cur[i] >= 20 && next[i] < 20) toWater++;
    }
    const a = waterBodies(cur, nbrs, border);
    const b = waterBodies(next, nbrs, border);
    // a lake is new when none of its cells was lake water before
    const formed = new Set();
    const kept = new Set();
    for (let i = 0; i < next.length; i++) {
      const k = b.comp[i];
      if (k < 0 || !b.bodies[k].lake) continue;
      const was = a.comp[i];
      if (was >= 0 && a.bodies[was].lake) kept.add(k);
      else formed.add(k);
    }
    for (const k of kept) formed.delete(k);
    const pct = v => rn((v / next.length) * 100, 1);
    return {
      changed,
      toLand,
      toWater,
      landPct: { before: pct(landBefore), after: pct(landAfter) },
      lakes: {
        before: a.bodies.filter(x => x.lake).length,
        after: b.bodies.filter(x => x.lake).length,
        formed: formed.size
      },
      pits: { before: countPits(cur, nbrs, border), after: countPits(next, nbrs, border) }
    };
  }

  // ---------------------------------------------------------------- drainage (mirrors Rivers.generate)

  /**
   * A drainage graph: {n, c (neighbours), p (points), h (heights), b (border), t (coast distance),
   * f (feature id per cell), lakes: Map<featureId, {shoreline, height, name?}>, ocean: Set<featureId>,
   * haven (nearest water neighbour of a coastal land cell, 0 = none), r? (existing river ids)}.
   */
  function graphFromHeights(h, nbrs, pts, border) {
    const n = h.length;
    const { comp, bodies } = waterBodies(h, nbrs, border);
    const f = new Int32Array(n);
    const lakes = new Map();
    const ocean = new Set();
    bodies.forEach((x, k) => {
      if (x.lake) lakes.set(k + 1, { shoreline: [], height: 0 });
      else ocean.add(k + 1);
    });
    const t = new Int8Array(n);
    const haven = new Int32Array(n);
    let ring = [];
    for (let i = 0; i < n; i++) {
      f[i] = comp[i] + 1; // 0 = land
      if (h[i] < 20) continue;
      let best = -1;
      let bd = Infinity;
      for (const nb of nbrs[i]) {
        if (h[nb] >= 20) continue;
        const d = (pts[i][0] - pts[nb][0]) ** 2 + (pts[i][1] - pts[nb][1]) ** 2;
        if (d < bd) {
          bd = d;
          best = nb;
        }
        // only cell i is pushed while i is scanned, so the last entry tells whether it is in already
        const lake = lakes.get(comp[nb] + 1);
        if (lake && lake.shoreline[lake.shoreline.length - 1] !== i) lake.shoreline.push(i);
      }
      if (best >= 0) {
        t[i] = 1;
        haven[i] = best;
        ring.push(i);
      }
    }
    // land distance to the coast (1 = coast, 2, 3, ... like Features.markupPack)
    for (let d = 2; ring.length && d < 127; d++) {
      const next = [];
      for (const i of ring)
        for (const nb of nbrs[i])
          if (h[nb] >= 20 && !t[nb]) {
            t[nb] = d;
            next.push(nb);
          }
      ring = next;
    }
    for (const lake of lakes.values()) {
      let min = Infinity;
      for (const s of lake.shoreline) if (h[s] < min) min = h[s];
      lake.height = rn((Number.isFinite(min) ? min : 20) - 0.1, 2); // Lakes.getHeight
    }
    return { n, c: nbrs, p: pts, h, b: border, t, f, lakes, ocean, haven };
  }

  /**
   * Heights water drains on, as Rivers.generate computes them: alterHeights, detectCloseLakes,
   * resolveDepressions, then each open lake's outlet (its lowest shore cell). `limits` =
   * {elevationLimit, maxIterations} (the app's lake elevation limit and depression steps).
   */
  function drainSurface(G, limits) {
    const { n, c, h, b, t, f, lakes } = G;
    const hA = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (h[i] < 20 || t[i] < 1) {
        hA[i] = h[i];
        continue;
      }
      let s = 0;
      for (const nb of c[i]) s += t[nb];
      hA[i] = h[i] + t[i] / 100 + (c[i].length ? s / c[i].length : 0) / 10000;
    }
    const lakeH = new Map();
    const closed = new Set();
    for (const [id, lake] of lakes) lakeH.set(id, lake.height);
    // detectCloseLakes
    for (const [id, lake] of lakes) {
      if (!lake.shoreline.length) continue;
      const maxElevation = lake.height + limits.elevationLimit;
      if (maxElevation > 99) continue;
      let deep = true;
      const start = lake.shoreline.reduce((m, s) => (hA[s] < hA[m] ? s : m));
      const queue = [start];
      const checked = new Uint8Array(n);
      checked[start] = 1;
      while (queue.length && deep) {
        const q = queue.pop();
        for (const nb of c[q]) {
          if (checked[nb] || hA[nb] >= maxElevation) continue;
          if (hA[nb] < 20) {
            const other = f[nb];
            if (G.ocean.has(other) || lake.height > (lakeH.get(other) ?? 0)) deep = false;
          }
          checked[nb] = 1;
          queue.push(nb);
        }
      }
      if (deep) closed.add(id);
    }
    // resolveDepressions
    const maxIterations = limits.maxIterations;
    const checkLakeMax = maxIterations * 0.85;
    const elevateLakeMax = maxIterations * 0.75;
    const height = i => lakeH.get(f[i]) || hA[i];
    const land = [];
    for (let i = 0; i < n; i++) if (hA[i] >= 20 && !b[i]) land.push(i);
    land.sort((x, y) => hA[x] - hA[y]);
    const progress = [];
    let depressions = Infinity;
    let prev = null;
    for (let it = 0; depressions && it < maxIterations; it++) {
      if (progress.length > 5 && progress.reduce((s, v) => s + v, 0) > 0) break; // the generator gives up
      depressions = 0;
      if (it < checkLakeMax) {
        for (const [id, lake] of lakes) {
          if (closed.has(id) || !lake.shoreline.length) continue;
          let minH = Infinity;
          for (const s of lake.shoreline) if (hA[s] < minH) minH = hA[s];
          if (minH >= 100 || lakeH.get(id) > minH) continue;
          if (it > elevateLakeMax) {
            for (const s of lake.shoreline) hA[s] = h[s];
            let m2 = Infinity;
            for (const s of lake.shoreline) if (hA[s] < m2) m2 = hA[s];
            lakeH.set(id, m2 - 1);
            closed.add(id);
            continue;
          }
          depressions++;
          lakeH.set(id, minH + 0.2);
        }
      }
      for (const i of land) {
        let minH = Infinity;
        for (const nb of c[i]) {
          const v = height(nb);
          if (v < minH) minH = v;
        }
        if (minH >= 100 || hA[i] > minH) continue;
        depressions++;
        hA[i] = minH + 0.1;
      }
      if (prev !== null) progress.push(depressions - prev);
      prev = depressions;
    }
    // lake outlets (defineClimateData): the lowest shore cell of every open lake
    const outlets = new Map(); // cell -> [lake ids]
    const outCell = new Map(); // lake id -> cell
    for (const [id, lake] of lakes) {
      if (closed.has(id) || !lake.shoreline.length) continue;
      const cell = lake.shoreline.reduce((m, s) => (hA[s] < hA[m] ? s : m));
      outCell.set(id, cell);
      outlets.set(cell, [...(outlets.get(cell) || []), id]);
    }
    return { hA, closed, outCell, outlets, unresolved: depressions === Infinity ? 0 : depressions };
  }

  /** Where water from cell `start` runs: {cells, end:{type, cell, lake?, river?}, lakes, pitsOnPath}. */
  function traceFlow(G, D, start) {
    const { c, h, b, f, haven } = G;
    const hA = D.hA;
    const cells = [start];
    const seen = new Set([start]);
    const via = [];
    let pitsOnPath = 0;
    const isWater = i => h[i] < 20;
    const done = (type, cell, extra) => ({ cells, end: { type, cell, ...extra }, lakes: via, pitsOnPath });
    let i = start;
    if (isWater(i)) {
      if (G.ocean.has(f[i])) return done("sea", i);
      const out = D.outCell.get(f[i]);
      if (out === undefined) return done("lake", i, { lake: f[i] });
      via.push(f[i]);
      cells.push(out);
      seen.add(out);
      i = out;
    }
    for (let guard = 0; guard < G.n; guard++) {
      if (G.r?.[i] && i !== start) return done("river", i, { river: G.r[i] });
      if (b[i]) return done("border", i);
      let min;
      const fromLakes = D.outlets.get(i) || [];
      if (fromLakes.length) {
        let best = -1;
        for (const nb of c[i]) if (!fromLakes.includes(f[nb]) && (best < 0 || hA[nb] < hA[best])) best = nb;
        min = best;
      } else if (haven[i]) min = haven[i];
      else min = c[i].reduce((m, nb) => (hA[nb] < hA[m] ? nb : m), c[i][0]);
      if (min === undefined || min < 0 || hA[i] <= hA[min]) return done("pit", i);
      // a cell the generator had to raise to drain is a depression in the real heights
      if (!isWater(min) && h[min] > h[i]) pitsOnPath++;
      if (seen.has(min)) return done("pit", i, { loop: true });
      cells.push(min);
      seen.add(min);
      if (!isWater(min)) {
        i = min;
        continue;
      }
      if (G.ocean.has(f[min])) return done("sea", min);
      const out = D.outCell.get(f[min]);
      if (out === undefined) return done("lake", min, { lake: f[min], closed: true });
      if (seen.has(out)) return done("lake", min, { lake: f[min] });
      via.push(f[min]);
      cells.push(out);
      seen.add(out);
      i = out;
    }
    return done("pit", i, { loop: true });
  }

  // ---------------------------------------------------------------- page accessors

  function gridDigest() {
    const P = grid.points;
    const flat = new Float64Array(P.length * 2);
    for (let k = 0; k < P.length; k++) {
      flat[2 * k] = P[k][0];
      flat[2 * k + 1] = P[k][1];
    }
    return `${grid.cells.i.length}:${grid.cellsX}x${grid.cellsY}:${hashArray(flat)}`;
  }
  FNS.gridDigest = () => ({ gridDigest: gridDigest(), cells: grid.cells.i.length });

  function drainLimits() {
    const num = (id, d) => {
      const v = Number(document.getElementById(id)?.value);
      return Number.isFinite(v) ? v : d;
    };
    return {
      elevationLimit: num("lakeElevationLimitOutput", 20),
      maxIterations: num("resolveDepressionsStepsOutput", 250)
    };
  }

  function packGraph() {
    const C = pack.cells;
    const lakes = new Map();
    const ocean = new Set();
    for (const ft of pack.features || []) {
      if (!ft || typeof ft !== "object") continue;
      if (ft.type === "lake") lakes.set(ft.i, { shoreline: ft.shoreline || [], height: ft.height, name: ft.name });
      else if (ft.type === "ocean") ocean.add(ft.i);
    }
    return { n: C.i.length, c: C.c, p: C.p, h: C.h, b: C.b, t: C.t, f: C.f, lakes, ocean, haven: C.haven, r: C.r };
  }

  // ---------------------------------------------------------------- height sources

  const CHANNELS = ["luma", "r", "g", "b", "a"];

  async function imageHeights(img, n) {
    if (!isObj(img)) fail("BAD_ARGS", "image is {path | dataUrl, invert?, range?:[min,max], channel?}");
    if (typeof img.dataUrl !== "string" || !/^data:image\//.test(img.dataUrl))
      fail("BAD_ARGS", "image.dataUrl must be a data:image/... URL (Node turns image.path into one)");
    const channel = img.channel ?? "luma";
    if (!CHANNELS.includes(channel)) fail("BAD_ARGS", `image.channel is one of ${CHANNELS.join(", ")}`);
    const [lo, hi] = img.range ?? [0, 100];
    if (![lo, hi].every(v => typeof v === "number" && v >= 0 && v <= 100))
      fail("BAD_ARGS", "image.range is [min, max] within 0..100 (pixel 0 -> min, 255 -> max)");
    const el = new Image();
    el.src = img.dataUrl;
    try {
      await el.decode();
    } catch {
      fail("BAD_ARGS", "the image could not be decoded (png, jpeg, webp, gif or bmp)");
    }
    const w = el.naturalWidth;
    const hgt = el.naturalHeight;
    if (!w || !hgt) fail("BAD_ARGS", "the image is empty");
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = hgt;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(el, 0, 0);
    const data = ctx.getImageData(0, 0, w, hgt).data;
    const px = (x, y) => {
      const o = (y * w + x) * 4;
      if (channel === "luma") return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
      return data[o + CHANNELS.indexOf(channel) - 1];
    };
    const out = new Uint8Array(n);
    const P = grid.points;
    for (let i = 0; i < n; i++) {
      // the image is stretched over the whole map; bilinear sample at the grid point
      const u = Math.min(w - 1, Math.max(0, (P[i][0] / graphWidth) * w - 0.5));
      const v = Math.min(hgt - 1, Math.max(0, (P[i][1] / graphHeight) * hgt - 0.5));
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      const x1 = Math.min(w - 1, x0 + 1);
      const y1 = Math.min(hgt - 1, y0 + 1);
      const fx = u - x0;
      const fy = v - y0;
      let val =
        px(x0, y0) * (1 - fx) * (1 - fy) +
        px(x1, y0) * fx * (1 - fy) +
        px(x0, y1) * (1 - fx) * fy +
        px(x1, y1) * fx * fy;
      if (img.invert) val = 255 - val;
      out[i] = Math.max(0, Math.min(100, Math.round(lo + (val / 255) * (hi - lo))));
    }
    return { h: out, info: { from: "image", width: w, height: hgt, channel, range: [lo, hi], invert: !!img.invert } };
  }

  /** The requested grid heights (before fill) from exactly one source. */
  async function sourceHeights(a) {
    const n = grid.cells.i.length;
    const forms = ["grid", "pack", "image", "heights"].filter(k => a[k] !== undefined && a[k] !== null);
    if (forms.length !== 1)
      fail("BAD_ARGS", "pass exactly one height source: grid (dense array), pack ({cellId: h}) or image");
    const form = forms[0];
    if (form === "grid") {
      const g = a.grid;
      if (!Array.isArray(g)) fail("BAD_ARGS", "grid is an array with one 0-100 height per grid cell");
      if (g.length !== n)
        fail(
          "BAD_ARGS",
          `grid has ${g.length} values; this map's grid has ${n} cells (grid.cells.i.length), so the array must have exactly ${n} values in grid cell order`,
          { details: { expected: n, got: g.length } }
        );
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const v = g[i];
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100)
          fail("BAD_ARGS", `grid[${i}] is ${JSON.stringify(v)}; every value must be a number 0..100`);
        out[i] = Math.round(v);
      }
      return { h: out, info: { from: "grid", values: n } };
    }
    if (form === "pack") {
      if (!isObj(a.pack)) fail("BAD_ARGS", "pack is {<packCellId>: height}");
      const C = pack.cells;
      const pn = C.i.length;
      const sum = new Map();
      for (const [k, v] of Object.entries(a.pack)) {
        const id = Number(k);
        if (!Number.isInteger(id) || id < 0 || id >= pn)
          fail("OUT_OF_BOUNDS", `pack cell ${k} is outside 0..${pn - 1}`);
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100)
          fail("BAD_ARGS", `pack[${k}] is ${JSON.stringify(v)}; heights are numbers 0..100`);
        const g = C.g[id];
        const s = sum.get(g) || [];
        s.push(v);
        sum.set(g, s);
      }
      const out = Uint8Array.from(grid.cells.h);
      let mixed = 0;
      for (const [g, vals] of sum) {
        if (vals.some(v => v !== vals[0])) mixed++;
        out[g] = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
      }
      const info = { from: "pack", packCells: Object.keys(a.pack).length, gridCells: sum.size };
      if (mixed) info.averaged = mixed; // pack cells sharing a grid cell with different values
      return { h: out, info };
    }
    if (form === "image") return imageHeights(a.image, n);
    if (typeof a.heights !== "string") fail("BAD_ARGS", "heights is the base64 of the grid height bytes");
    const out = b64ToBytes(a.heights);
    if (out.length !== n)
      fail("CONFLICT", `the recorded heights hold ${out.length} grid cells; this map's grid has ${n}`);
    for (let i = 0; i < n; i++) if (out[i] > 100) fail("BAD_ARGS", `heights[${i}] is ${out[i]}, above 100`);
    return { h: out, info: { from: "recorded heights" } };
  }

  // ---------------------------------------------------------------- set_heights

  function heightOptions(a) {
    const rebuild = a.rebuild ?? "risk";
    if (!["risk", "keep"].includes(rebuild)) fail("BAD_ARGS", "rebuild is 'risk' or 'keep'");
    const biomes = a.biomes ?? "redefine";
    if (!["redefine", "keep"].includes(biomes)) fail("BAD_ARGS", "biomes is 'redefine' or 'keep'");
    for (const k of ["fill", "erosion", "keepHeights"])
      if (a[k] !== undefined && typeof a[k] !== "boolean") fail("BAD_ARGS", `${k} must be true or false`);
    return {
      rebuild,
      erosion: a.erosion === true,
      keepHeights: a.keepHeights !== false,
      biomes,
      fill: a.fill === true
    };
  }

  /** Pack land heights the rebuild or erosion changed are set back to `want` (grid-indexed). */
  function restorePackHeights(want) {
    const C = pack.cells;
    let n = 0;
    for (const i of C.i) {
      const w = want[C.g[i]];
      const v = C.h[i];
      if (v === w || v >= 20 !== w >= 20) continue;
      C.h[i] = w;
      n++;
    }
    return n;
  }

  function liveBurgs() {
    return (pack.burgs || []).filter(b => b?.i && !b.removed).length;
  }

  function rebuildRisk(target, o, c, info) {
    const gh = grid.cells.h;
    for (let g = 0; g < gh.length; g++) gh[g] = target[g];
    const hm = M.heightmapInternals();
    M.clearFeatureShapes();
    hm.restoreRiskedData({
      erosion: o.erosion,
      regenerateRivers: true,
      redefineBiomes: o.biomes === "redefine",
      afterRivers: o.keepHeights
        ? () => {
            info.heightsRestored = restorePackHeights(target);
          }
        : undefined
    });
    c.notes.add(
      "rebuild:'risk' re-ran features, climate, lakes and rivers and re-packed the cells (cell ids changed); burgs, states, cultures, religions, provinces and zones were kept where land remains"
    );
  }

  function rebuildKeep(target, o, c, info) {
    const C = pack.cells;
    const gh = grid.cells.h;
    for (let g = 0; g < gh.length; g++) gh[g] = target[g];
    for (const i of C.i) C.h[i] = gh[C.g[i]];
    for (const ft of pack.features || []) if (ft && ft.type === "lake") ft.height = Lakes.getHeight(ft);
    calculateTemperatures();
    generatePrecipitation();
    Rivers.generate(o.erosion);
    Features.defineGroups();
    if (o.keepHeights) info.heightsRestored = restorePackHeights(target);
    if (o.biomes === "redefine") Biomes.define();
    Rivers.specify();
    for (const ft of pack.features || []) {
      if (!ft || ft.type !== "lake" || ft.name) continue;
      try {
        ft.name = Lakes.getName(ft);
      } catch {
        /* unnamed lake; harmless */
      }
    }
    if (pack.goods?.length && typeof regenerateEconomy === "function") regenerateEconomy();
    Ice.generate();
    ice.selectAll("*").remove();
    c.notes.add(
      "rebuild:'keep' kept the coastline and cell ids; climate, rivers and lakes were recomputed on the new heights"
    );
  }

  FNS.setHeights = async a => {
    const o = heightOptions(a);
    const n = grid.cells.i.length;
    const digestNow = gridDigest();
    if (a.gridDigest !== undefined && a.gridDigest !== digestNow)
      fail(
        "CONFLICT",
        `the heights were recorded on another grid (${a.gridDigest}; this map's grid is ${digestNow}): the map was regridded, so its grid cells are other places`
      );
    const src = await sourceHeights(a);
    let target = src.h;
    let fill = null;
    if (o.fill) {
      const r = fillDepressions(target, grid.cells.c, grid.cells.b);
      fill = { raised: r.raised, maxRaise: r.maxRaise };
      target = r.h;
    }
    const stats = heightStats(grid.cells.h, target, grid.cells.c, grid.cells.b);
    if (o.rebuild === "keep" && (stats.toLand || stats.toWater))
      fail(
        "REFUSED",
        `${stats.toLand + stats.toWater} grid cells would cross height 20 (${stats.toLand} water -> land, ${stats.toWater} land -> water), which changes the coastline; rebuild:'keep' cannot do that. Use rebuild:'risk' (the default) to rebuild the coastline while keeping burgs, states and other data.`,
        { details: stats }
      );
    const plan = { source: src.info, gridCells: n, ...stats, ...(fill ? { fill } : {}), options: { ...o } };
    delete plan.options.fill;
    if (a.phase !== "apply") return { phase: "validate", ...plan };

    const c = M.batchContext(a);
    const info = { heightsRestored: 0 };
    const before = M.featureSummary();
    const burgsBefore = liveBurgs();
    const graphBefore = T.cellGraph();
    const heightsDigest = hashArray(target);
    // deterministic rebuild: the app's PRNG is seeded from the map seed and the heights (the
    // app's own rebuild steps reseed from the map seed), then put back as it was
    const prevRandom = Math.random;
    Math.random = aleaPRNG(`${seed}:heights:${heightsDigest}`);
    try {
      if (o.rebuild === "risk") rebuildRisk(target, o, c, info);
      else rebuildKeep(target, o, c, info);
    } finally {
      Math.random = prevRandom;
    }
    c.R.add("all");
    T.resetMemo?.();
    const final = Uint8Array.from(grid.cells.h);
    let raisedForBurgs = 0;
    let deepLakes = 0;
    for (let g = 0; g < n; g++) {
      if (final[g] === target[g]) continue;
      if (target[g] < 20 && final[g] >= 20) raisedForBurgs++;
      else if (target[g] >= 20 && final[g] < 20) deepLakes++;
    }
    if (raisedForBurgs)
      c.notes.add(`${raisedForBurgs} grid cells set to water hold a burg and were kept as land (height 20)`);
    if (deepLakes) c.notes.add(`erosion turned ${deepLakes} grid cells of deep depressions into lakes`);
    c.notes.add("rivers were regenerated (river ids and names are new)");
    const graphAfter = T.cellGraph();
    const out = {
      heightsDigest,
      ...plan,
      heightsRestored: info.heightsRestored,
      raisedForBurgs,
      deepLakes,
      burgsRemoved: burgsBefore - liveBurgs(),
      cellsRenumbered: graphAfter !== graphBefore,
      features: { before, after: M.featureSummary() }
    };
    if (typeof a.expectGraph === "string") {
      out.graphMatches = a.expectGraph === graphAfter;
      if (!out.graphMatches)
        c.notes.add(
          "the rebuild produced another cell graph than when the sketch recorded it (the map's burgs, settings or seed differ), so later literal cell lists will not line up"
        );
    }
    const rd = await M.finishRedraw(a, c.R);
    const resolved = {
      heights: bytesToB64(final),
      cells: n,
      gridDigest: digestNow,
      heightsDigest: hashArray(final),
      options: { rebuild: o.rebuild, erosion: o.erosion, keepHeights: o.keepHeights, biomes: o.biomes },
      graphAfter,
      stats: { changed: stats.changed, toLand: stats.toLand, toWater: stats.toWater, landPct: stats.landPct.after }
    };
    if (a.redraw !== undefined) resolved.redraw = a.redraw;
    return { ...out, resolved, ...rd, notes: [...c.notes] };
  };

  // ---------------------------------------------------------------- flow

  const FLOW_ID = "tupaiaFlow";

  function lengthOf(pts) {
    let px = 0;
    for (let k = 1; k < pts.length; k++) px += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    const unit = document.getElementById("distanceUnitInput")?.value || "km";
    const inUnit = px * distanceScale;
    const out = { px: rn(px, 1) };
    if (unit === "km") out.km = rn(inUnit, 1);
    else if (unit === "mi") out.km = rn(inUnit * 1.609344, 1);
    else out[unit] = rn(inUnit, 1);
    return out;
  }

  FNS.flow = async a => {
    const list = Array.isArray(a.from) ? a.from : [a.from];
    if (!list.length || list.length > 50) fail("BAD_ARGS", "from is a place or 1-50 places");
    const starts = list.map(p => T.place(p));
    let mode = "pack";
    let G;
    let source;
    if (a.heights !== undefined || a.fill) {
      mode = "grid";
      let h = grid.cells.h;
      if (a.heights !== undefined) {
        if (!isObj(a.heights)) fail("BAD_ARGS", "heights is {grid} | {pack} | {image}, as in set_heights");
        const src = await sourceHeights(a.heights);
        h = src.h;
        source = src.info;
      }
      if (a.fill) h = fillDepressions(h, grid.cells.c, grid.cells.b).h;
      G = graphFromHeights(h, grid.cells.c, grid.points, grid.cells.b);
    } else G = packGraph();
    const D = drainSurface(G, drainLimits());
    // proposed lakes named after the current lake they overlap, if any
    const lakeName = id => {
      if (mode === "pack") return G.lakes.get(id)?.name ?? null;
      const C = pack.cells;
      const first = new Map();
      for (const i of C.i) if (!first.has(C.g[i])) first.set(C.g[i], i);
      for (let g = 0; g < G.n; g++) {
        if (G.f[g] !== id) continue;
        const pc = first.get(g);
        const ft = pc !== undefined ? pack.features[C.f[pc]] : null;
        if (ft && ft.type === "lake" && C.h[pc] < 20) return ft.name ?? null;
      }
      return null;
    };
    const paths = starts.map(s => {
      const cell = mode === "pack" ? s.cell : pack.cells.g[s.cell];
      const tr = traceFlow(G, D, cell);
      const pts = tr.cells.map(i => [rn(G.p[i][0], 1), rn(G.p[i][1], 1)]);
      const end = { type: tr.end.type, x: pts.at(-1)[0], y: pts.at(-1)[1], cell: tr.end.cell };
      if (tr.end.lake !== undefined) {
        const nm = lakeName(tr.end.lake);
        end.lake = nm ?? (mode === "pack" ? tr.end.lake : "a new lake");
        if (tr.end.closed) end.closed = true;
      }
      if (tr.end.river) {
        const r = (pack.rivers || []).find(x => x.i === tr.end.river);
        end.river = r ? `${r.name || "river"} (${r.i})` : tr.end.river;
      }
      if (tr.end.loop) end.loop = true;
      const row = {
        from: { x: s.x, y: s.y, cell, h: G.h[cell] },
        end,
        steps: tr.cells.length - 1,
        length: lengthOf(pts),
        drop: G.h[cell] - G.h[tr.end.cell]
      };
      if (tr.lakes.length) row.throughLakes = tr.lakes.map(id => lakeName(id) ?? (mode === "pack" ? id : "a new lake"));
      if (tr.pitsOnPath) row.climbs = tr.pitsOnPath;
      if (a.detail) row.cells = tr.cells;
      row.points = pts;
      return row;
    });
    const ends = {};
    for (const p of paths) ends[p.end.type] = (ends[p.end.type] || 0) + 1;
    return {
      on: mode === "pack" ? "pack cells (current heights)" : "grid cells (proposed heights; cell ids are grid ids)",
      ...(source ? { source } : {}),
      ...(a.fill ? { filled: true } : {}),
      ends,
      ...(D.unresolved ? { unresolvedDepressions: D.unresolved } : {}),
      paths
    };
  };

  /** Draw (paths: [[x,y]...][]) or remove ({remove:true}) the temporary flow overlay; returns its bbox. */
  FNS.flowOverlay = a => {
    viewbox.select(`#${FLOW_ID}`).remove();
    if (a.remove) return { removed: true };
    const paths = Array.isArray(a.paths) ? a.paths.filter(p => Array.isArray(p) && p.length) : [];
    if (!paths.length) fail("BAD_ARGS", "flowOverlay needs paths");
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of paths)
      for (const [x, y] of p) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    const pad = Math.max(30, 0.15 * Math.max(x1 - x0, y1 - y0));
    const box = [
      Math.max(0, x0 - pad),
      Math.max(0, y0 - pad),
      Math.min(graphWidth, x1 + pad),
      Math.min(graphHeight, y1 + pad)
    ];
    const w = Math.max(0.6, Math.max(box[2] - box[0], box[3] - box[1]) / 400);
    const g = viewbox.append("g").attr("id", FLOW_ID).style("pointer-events", "none");
    for (const p of paths) {
      g.append("polyline")
        .attr("points", p.map(q => q.join(",")).join(" "))
        .attr("fill", "none")
        .attr("stroke", "#ff2d6f")
        .attr("stroke-width", w * 2)
        .attr("stroke-linejoin", "round")
        .attr("stroke-linecap", "round");
      g.append("circle")
        .attr("cx", p[0][0])
        .attr("cy", p[0][1])
        .attr("r", w * 3)
        .attr("fill", "#ff2d6f");
      const e = p[p.length - 1];
      g.append("circle")
        .attr("cx", e[0])
        .attr("cy", e[1])
        .attr("r", w * 3)
        .attr("fill", "#fff")
        .attr("stroke", "#ff2d6f")
        .attr("stroke-width", w);
    }
    return { bbox: box.map(v => rn(v, 1)) };
  };

  T.terrain = {
    gridDigest,
    pure: {
      fillDepressions,
      waterBodies,
      countPits,
      heightStats,
      graphFromHeights,
      drainSurface,
      traceFlow,
      bytesToB64,
      b64ToBytes
    }
  };
})(globalThis);
