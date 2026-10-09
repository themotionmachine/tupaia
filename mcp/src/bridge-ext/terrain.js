// Tupaia MCP bridge extension: terrain (set_heights, flow). Injected after bridge.js and
// bridge-mutations.js; same rules: app globals by bare name at call time, no locals that shadow
// app globals (pack, grid, seed, rivers, lakes, ice, cells, ocean, routes, markers, notes, rn,
// round, ...), every FNS function takes one args object.
//
// setHeights follows the phased protocol: phase 'validate' resolves the source, fills, counts and
// checks, mutating nothing; phase 'apply' writes grid heights and rebuilds. The resolved form
// holds the grid cells the op changed (their final and their previous heights, deflated), the
// digest of the heights it started from and the digest it ended at, so replaying it needs no
// source, no fill and no image, and a replay onto a map whose terrain was edited since applies
// only this op's cells (and says how many of them the target had changed too). The rebuild is a
// deterministic function of (map seed, grid, heights, options, the map's entities). That comes
// from the app itself: its rebuild steps reseed Math.random from the map seed
// (Features.markupGrid, Rivers.generate). The call also seeds Math.random from the map seed and
// the heights digest before it starts (so nothing before those reseeds depends on earlier calls)
// and puts the caller's PRNG back afterwards.
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

  const roundTo = (v, d = 2) => {
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

  async function pipeBytes(u8, stream) {
    const s = new Blob([u8]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  /**
   * The heights an op changed, compactly: base64(deflate-raw(A ++ B)), where A has one byte per
   * grid cell (the final height of a changed cell, 255 for an unchanged one) and B holds the
   * previous height of each changed cell, in cell order. Returns {changes, changed}.
   */
  async function encodeChanges(before, after) {
    const n = after.length;
    const a = new Uint8Array(n).fill(255);
    const prev = [];
    for (let i = 0; i < n; i++)
      if (after[i] !== before[i]) {
        a[i] = after[i];
        prev.push(before[i]);
      }
    const all = new Uint8Array(n + prev.length);
    all.set(a);
    all.set(prev, n);
    return { changes: bytesToB64(await pipeBytes(all, new CompressionStream("deflate-raw"))), changed: prev.length };
  }

  /** encodeChanges undone: {after (255 = unchanged), before (per changed cell, in order), changed}. */
  async function decodeChanges(b64, n) {
    let all;
    try {
      all = await pipeBytes(b64ToBytes(b64), new DecompressionStream("deflate-raw"));
    } catch {
      fail("BAD_ARGS", "the recorded height changes could not be decoded");
    }
    let changed = 0;
    for (let i = 0; i < Math.min(n, all.length); i++) if (all[i] !== 255) changed++;
    if (all.length !== n + changed)
      fail("CONFLICT", `the recorded height changes do not fit this map's grid of ${n} cells`);
    const after = all.subarray(0, n);
    for (let i = 0; i < n; i++)
      if (after[i] !== 255 && after[i] > 100) fail("BAD_ARGS", `recorded height ${after[i]} is above 100`);
    return { after, before: all.subarray(n), changed };
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
  function pitCells(h, nbrs, border) {
    const out = [];
    for (let i = 0; i < h.length; i++) {
      if (h[i] < 20 || border[i]) continue;
      let low = true;
      for (const nb of nbrs[i])
        if (h[nb] <= h[i]) {
          low = false;
          break;
        }
      if (low) out.push(i);
    }
    return out;
  }

  function countPits(h, nbrs, border) {
    return pitCells(h, nbrs, border).length;
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
    const pct = v => roundTo((v / next.length) * 100, 1);
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
   * f (feature id per cell), lakeMap: Map<featureId, {shoreline, height, name?}>, seas: Set<featureId>,
   * haven (nearest water neighbour of a coastal land cell, 0 = none), r? (existing river ids)}.
   */
  function graphFromHeights(h, nbrs, pts, border) {
    const n = h.length;
    const { comp, bodies } = waterBodies(h, nbrs, border);
    const f = new Int32Array(n);
    const lakeMap = new Map();
    const seas = new Set();
    bodies.forEach((x, k) => {
      if (x.lake) lakeMap.set(k + 1, { shoreline: [], height: 0 });
      else seas.add(k + 1);
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
        const lake = lakeMap.get(comp[nb] + 1);
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
    for (const lake of lakeMap.values()) {
      let min = Infinity;
      for (const s of lake.shoreline) if (h[s] < min) min = h[s];
      lake.height = roundTo((Number.isFinite(min) ? min : 20) - 0.1, 2); // Lakes.getHeight
    }
    return { n, c: nbrs, p: pts, h, b: border, t, f, lakeMap, seas, haven };
  }

  /**
   * Heights water drains on, as Rivers.generate computes them: alterHeights, detectCloseLakes,
   * resolveDepressions, then each open lake's outlet (its lowest shore cell). `limits` =
   * {elevationLimit, maxIterations} (the app's lake elevation limit and depression steps).
   */
  function drainSurface(G, limits) {
    const { n, c, h, b, t, f, lakeMap } = G;
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
    const closedLakes = new Set();
    for (const [id, lake] of lakeMap) lakeH.set(id, lake.height);
    // detectCloseLakes
    for (const [id, lake] of lakeMap) {
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
            if (G.seas.has(other) || lake.height > (lakeH.get(other) ?? 0)) deep = false;
          }
          checked[nb] = 1;
          queue.push(nb);
        }
      }
      if (deep) closedLakes.add(id);
    }
    // resolveDepressions
    const maxIterations = limits.maxIterations;
    const checkLakeMax = maxIterations * 0.85;
    const elevateLakeMax = maxIterations * 0.75;
    const height = i => lakeH.get(f[i]) || hA[i];
    const landCells = [];
    for (let i = 0; i < n; i++) if (hA[i] >= 20 && !b[i]) landCells.push(i);
    landCells.sort((x, y) => hA[x] - hA[y]);
    const progress = [];
    let depressions = Infinity;
    let prev = null;
    for (let it = 0; depressions && it < maxIterations; it++) {
      if (progress.length > 5 && progress.reduce((s, v) => s + v, 0) > 0) break; // the generator gives up
      depressions = 0;
      if (it < checkLakeMax) {
        for (const [id, lake] of lakeMap) {
          if (closedLakes.has(id) || !lake.shoreline.length) continue;
          let minH = Infinity;
          for (const s of lake.shoreline) if (hA[s] < minH) minH = hA[s];
          if (minH >= 100 || lakeH.get(id) > minH) continue;
          if (it > elevateLakeMax) {
            for (const s of lake.shoreline) hA[s] = h[s];
            let m2 = Infinity;
            for (const s of lake.shoreline) if (hA[s] < m2) m2 = hA[s];
            lakeH.set(id, m2 - 1);
            closedLakes.add(id);
            continue;
          }
          depressions++;
          lakeH.set(id, minH + 0.2);
        }
      }
      for (const i of landCells) {
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
    for (const [id, lake] of lakeMap) {
      if (closedLakes.has(id) || !lake.shoreline.length) continue;
      const cell = lake.shoreline.reduce((m, s) => (hA[s] < hA[m] ? s : m));
      outCell.set(id, cell);
      outlets.set(cell, [...(outlets.get(cell) || []), id]);
    }
    return { hA, closed: closedLakes, outCell, outlets, unresolved: depressions === Infinity ? 0 : depressions };
  }

  /** Where water from cell `start` runs: {path, end:{type, cell, lake?, river?}, lakes, pitsOnPath}. */
  function traceFlow(G, D, start) {
    const { c, h, b, f, haven } = G;
    const hA = D.hA;
    const path = [start];
    const seen = new Set([start]);
    const via = [];
    let pitsOnPath = 0;
    const wet = i => h[i] < 20;
    const done = (type, cell, extra) => ({ path, end: { type, cell, ...extra }, lakes: via, pitsOnPath });
    let i = start;
    if (wet(i)) {
      if (G.seas.has(f[i])) return done("sea", i);
      const out = D.outCell.get(f[i]);
      if (out === undefined) return done("lake", i, { lake: f[i] });
      via.push(f[i]);
      path.push(out);
      seen.add(out);
      i = out;
    }
    for (let guard = 0; guard < G.n; guard++) {
      // water on a river cell is in that river (the start too)
      if (G.r?.[i]) return done("river", i, { river: G.r[i] });
      // the generator pours a border cell off the map only once it carries a river: a source
      // on the border (no river yet) flows to its lowest neighbour like any other cell
      if (b[i] && i !== start) return done("border", i);
      let min;
      const fromLakes = D.outlets.get(i) || [];
      if (fromLakes.length) {
        let best = -1;
        for (const nb of c[i]) if (!fromLakes.includes(f[nb]) && (best < 0 || hA[nb] < hA[best])) best = nb;
        min = best;
      } else if (haven[i]) min = haven[i];
      else min = c[i].reduce((m, nb) => (hA[nb] < hA[m] ? nb : m), c[i][0]);
      if (min === undefined || min < 0 || hA[i] <= hA[min]) return done(b[i] ? "border" : "pit", i);
      // a cell the generator had to raise to drain is a depression in the real heights
      if (!wet(min) && h[min] > h[i]) pitsOnPath++;
      if (seen.has(min)) return done("pit", i, { loop: true });
      path.push(min);
      seen.add(min);
      if (!wet(min)) {
        i = min;
        continue;
      }
      if (G.seas.has(f[min])) return done("sea", min);
      const out = D.outCell.get(f[min]);
      if (out === undefined) return done("lake", min, { lake: f[min], closed: true });
      if (seen.has(out)) return done("lake", min, { lake: f[min] });
      via.push(f[min]);
      path.push(out);
      seen.add(out);
      i = out;
    }
    return done("pit", i, { loop: true });
  }

  // ---------------------------------------------------------------- page accessors

  function gridDigest() {
    const GP = grid.points;
    const flat = new Float64Array(GP.length * 2);
    for (let k = 0; k < GP.length; k++) {
      flat[2 * k] = GP[k][0];
      flat[2 * k + 1] = GP[k][1];
    }
    return `${grid.cells.i.length}:${grid.cellsX}x${grid.cellsY}:${hashArray(flat)}`;
  }
  FNS.gridDigest = () => ({ gridDigest: gridDigest(), cells: grid.cells.i.length });

  function gridGeometry() {
    return {
      cells: grid.cells.i.length,
      cellsX: grid.cellsX,
      cellsY: grid.cellsY,
      spacing: grid.spacing,
      size: [graphWidth, graphHeight]
    };
  }

  /** The grid cell whose point is nearest (x, y): findGridCell, then a walk to closer neighbours. */
  function nearestGridCell(x, y) {
    const GP = grid.points;
    let g = findGridCell(x, y);
    if (!Number.isInteger(g) || g < 0 || g >= GP.length) g = 0;
    const d2 = k => (GP[k][0] - x) ** 2 + (GP[k][1] - y) ** 2;
    for (let moved = true; moved; ) {
      moved = false;
      for (const nb of grid.cells.c[g])
        if (d2(nb) < d2(g)) {
          g = nb;
          moved = true;
        }
    }
    return g;
  }

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
    const lakeMap = new Map();
    const seas = new Set();
    for (const ft of pack.features || []) {
      if (!ft || typeof ft !== "object") continue;
      if (ft.type === "lake") {
        // the height Features.markupPack gives a lake (a saved one holds what the last river run left)
        const shoreline = ft.shoreline || [];
        let min = Infinity;
        for (const s of shoreline) if (C.h[s] < min) min = C.h[s];
        const height = Number.isFinite(min) ? roundTo(min - 0.1, 2) : ft.height;
        lakeMap.set(ft.i, { shoreline, height, name: ft.name });
      } else if (ft.type === "ocean") seas.add(ft.i);
    }
    return { n: C.i.length, c: C.c, p: C.p, h: C.h, b: C.b, t: C.t, f: C.f, lakeMap, seas, haven: C.haven, r: C.r };
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
    const GP = grid.points;
    for (let i = 0; i < n; i++) {
      // the image is stretched over the whole map; bilinear sample at the grid point
      const u = Math.min(w - 1, Math.max(0, (GP[i][0] / graphWidth) * w - 0.5));
      const v = Math.min(hgt - 1, Math.max(0, (GP[i][1] / graphHeight) * hgt - 0.5));
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
    const info = { from: "image", width: w, height: hgt, channel, range: [lo, hi], invert: !!img.invert };
    const warn = [];
    const ratio = w / hgt / (graphWidth / graphHeight);
    if (Math.abs(ratio - 1) > 0.05)
      warn.push(
        `the image's aspect (${w}x${hgt}) differs from the map's (${graphWidth}x${graphHeight}) by ${Math.round(Math.abs(ratio - 1) * 100)}%: it is stretched to fit`
      );
    if (w < grid.cellsX / 2 || hgt < grid.cellsY / 2)
      warn.push(`the image is much smaller than the grid (${grid.cellsX}x${grid.cellsY} cells): it is upsampled`);
    if (warn.length) info.warnings = warn;
    return { h: out, info };
  }

  /** The requested grid heights (before fill) from exactly one source. */
  async function sourceHeights(a) {
    const n = grid.cells.i.length;
    const forms = ["grid", "pack", "image", "changes"].filter(k => a[k] !== undefined && a[k] !== null);
    if (forms.length !== 1)
      fail("BAD_ARGS", "pass exactly one height source: grid (dense array), pack ({cellId: h}) or image");
    const form = forms[0];
    if (form === "grid") {
      const g = a.grid;
      if (!Array.isArray(g)) fail("BAD_ARGS", "grid is an array with one 0-100 height per grid cell");
      if (g.length !== n)
        fail(
          "BAD_ARGS",
          `grid has ${g.length} values; this map's grid has ${n} cells (grid.cells.i.length), so the array must have exactly ${n} values in grid cell order (eval 'return grid.points' gives each grid cell's [x, y]; 'return Array.from(grid.cells.h)' the current heights)`,
          { details: { expected: n, got: g.length, grid: gridGeometry() } }
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
        if (!/^\d+$/.test(k)) fail("BAD_ARGS", `pack key '${k}' is not a pack cell id (an integer 0..${pn - 1})`);
        const id = Number(k);
        if (id >= pn) fail("OUT_OF_BOUNDS", `pack cell ${k} is outside 0..${pn - 1}`);
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
      if (!sum.size) info.warnings = ["pack is empty: no height changes, but the rebuild still runs"];
      return { h: out, info };
    }
    if (form === "image") return imageHeights(a.image, n);
    // replay: the recorded changes on top of this map's heights
    if (typeof a.changes !== "string") fail("BAD_ARGS", "changes is the recorded (encoded) height changes");
    const cur = grid.cells.h;
    const dec = await decodeChanges(a.changes, n);
    const out = Uint8Array.from(cur);
    let overlap = 0;
    for (let i = 0, k = 0; i < n; i++) {
      if (dec.after[i] === 255) continue;
      if (cur[i] !== dec.before[k]) overlap++;
      out[i] = dec.after[i];
      k++;
    }
    const baseMatches = a.baseDigest === undefined || hashArray(cur) === a.baseDigest;
    return {
      h: out,
      info: { from: "recorded changes", cells: dec.changed },
      replay: { baseMatches, overlap, changed: dec.changed }
    };
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

  /** Pack land cells whose height differs from `want` (grid-indexed); set back when `write`. */
  function packHeightsOff(want, write) {
    const C = pack.cells;
    let n = 0;
    for (const i of C.i) {
      const w = want[C.g[i]];
      const v = C.h[i];
      if (v === w || v >= 20 !== w >= 20) continue;
      if (write) C.h[i] = w;
      n++;
    }
    return n;
  }

  function liveBurgs() {
    return (pack.burgs || []).filter(b => b?.i && !b.removed);
  }

  /** Land cells whose biome differs from what Biomes.define gives on the current climate. */
  function paintedBiomes() {
    const C = pack.cells;
    const precip = grid.cells.prec;
    const temp = grid.cells.temp;
    if (!precip || !temp || typeof Biomes?.getId !== "function") return null;
    let n = 0;
    for (const i of C.i) {
      if (C.h[i] < 20) continue;
      let moisture = precip[C.g[i]];
      if (C.r[i]) moisture += Math.max(C.fl[i] / 10, 2);
      let s = moisture;
      let k = 1;
      for (const nb of C.c[i])
        if (C.h[nb] >= 20) {
          s += precip[C.g[nb]];
          k++;
        }
      const id = Biomes.getId(Math.round(4 + s / k), temp[C.g[i]], C.h[i], Boolean(C.r[i]));
      if (id !== C.biome[i]) n++;
    }
    return n;
  }

  /** What a dry run adds: burgs that would stand on new water, painted biomes, grid, cell lists. */
  function preview(cur, target, o, fill, a) {
    const C = pack.cells;
    const out = { grid: gridGeometry() };
    const drown = liveBurgs().filter(b => cur[C.g[b.cell]] >= 20 && target[C.g[b.cell]] < 20);
    if (drown.length)
      out.burgsOnNewWater = {
        count: drown.length,
        burgs: drown.slice(0, 10).map(b => `${b.name} (${b.i})${b.capital ? " capital" : ""}`),
        effect: "the rebuild keeps each such burg's cell as land at height 20 (an island or a spit)"
      };
    const painted = paintedBiomes();
    if (painted)
      out.paintedBiomes = {
        cells: painted,
        effect:
          o.biomes === "redefine"
            ? "land cells whose biome differs from their climate's (painted or older): biomes:'redefine' recomputes them, biomes:'keep' keeps them where land remains"
            : "land cells whose biome differs from their climate's: kept where land remains (biomes:'keep')"
      };
    out.rivers = {
      now: (pack.rivers || []).length,
      effect:
        "rivers are regenerated on apply; a new river whose course overlaps an old one keeps its id, name and type (notes stay on it)"
    };
    if (a.detail) {
      const GP = grid.points;
      const at = g => [roundTo(GP[g][0], 1), roundTo(GP[g][1], 1)];
      const pits = pitCells(target, grid.cells.c, grid.cells.b);
      out.pitCells = pits.slice(0, 50).map(g => ({ cell: g, at: at(g), h: target[g] }));
      if (pits.length > 50) out.pitCellsMore = pits.length - 50;
      if (fill?.cells) {
        const raised = fill.cells.sort((x, y) => y[1] - x[1] || x[0] - y[0]);
        out.filledCells = raised.slice(0, 100).map(([g, d]) => ({ cell: g, at: at(g), raise: d }));
        if (raised.length > 100) out.filledCellsMore = raised.length - 100;
      }
    }
    return out;
  }

  function afterRivers(target, o, info) {
    // erosion (and a burg's cell kept at 20) can leave land heights other than the requested ones
    info.rebuildChanged = packHeightsOff(target, false);
    if (o.keepHeights) info.heightsRestored = packHeightsOff(target, true);
  }

  function rebuildRisk(target, o, info) {
    const gh = grid.cells.h;
    for (let g = 0; g < gh.length; g++) gh[g] = target[g];
    return M.riskRebuild({
      restore: {
        erosion: o.erosion,
        regenerateRivers: true,
        redefineBiomes: o.biomes === "redefine",
        afterRivers: () => afterRivers(target, o, info)
      },
      keepBiomes: o.biomes === "keep"
    });
  }

  function rebuildKeep(target, o, info) {
    const C = pack.cells;
    const gh = grid.cells.h;
    for (let g = 0; g < gh.length; g++) gh[g] = target[g];
    for (const i of C.i) C.h[i] = gh[C.g[i]];
    for (const ft of pack.features || []) if (ft && ft.type === "lake") ft.height = Lakes.getHeight(ft);
    const saved = M.captureRivers();
    calculateTemperatures();
    generatePrecipitation();
    Rivers.generate(o.erosion);
    Features.defineGroups();
    afterRivers(target, o, info);
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
    const carried = { rivers: M.carryRivers(saved) };
    if (pack.goods?.length && typeof regenerateEconomy === "function") regenerateEconomy();
    Ice.generate();
    ice.selectAll("*").remove();
    return carried;
  }

  /** Box [x0, y0, x1, y1] of the grid points of the cells that changed, or null. */
  function changedBox(before, after) {
    const GP = grid.points;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < after.length; i++) {
      if (after[i] === before[i]) continue;
      x0 = Math.min(x0, GP[i][0]);
      y0 = Math.min(y0, GP[i][1]);
      x1 = Math.max(x1, GP[i][0]);
      y1 = Math.max(y1, GP[i][1]);
    }
    if (!Number.isFinite(x0)) return null;
    const pad = grid.spacing || 0;
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad].map(v => roundTo(v, 1));
  }

  function riverNotes(c, rv) {
    if (!rv) return;
    let s = `rivers were regenerated: ${rv.kept} of ${rv.before} kept their id, name and type (matched by course), ${rv.new} are new`;
    if (rv.gone) s += `, ${rv.gone} are gone`;
    c.notes.add(s);
    if (rv.notesOrphaned?.length)
      c.notes.add(
        `${rv.notesOrphaned.length} notes belong to rivers that are gone: ${rv.notesOrphaned.slice(0, 10).join("; ")}`
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
      fill = { cellsRaised: r.raised, maxRaise: r.maxRaise };
      if (a.detail) {
        fill.cells = [];
        for (let i = 0; i < n; i++) if (r.h[i] !== target[i]) fill.cells.push([i, r.h[i] - target[i]]);
      }
      target = r.h;
    }
    const cur = grid.cells.h;
    const stats = heightStats(cur, target, grid.cells.c, grid.cells.b);
    if (o.rebuild === "keep" && (stats.toLand || stats.toWater))
      fail(
        "REFUSED",
        `${stats.toLand + stats.toWater} grid cells would cross height 20 (${stats.toLand} water -> land, ${stats.toWater} land -> water), which changes the coastline; rebuild:'keep' cannot do that. Use rebuild:'risk' (the default) to rebuild the coastline while keeping burgs, states and other data.`,
        { details: stats }
      );
    const plan = { source: src.info, gridCells: n, ...stats, options: { ...o } };
    delete plan.options.fill;
    if (fill) plan.fill = { cellsRaised: fill.cellsRaised, maxRaise: fill.maxRaise };
    if (a.phase !== "apply") return { phase: "validate", ...plan, ...preview(cur, target, o, fill, a) };

    const c = M.batchContext(a);
    const info = { heightsRestored: 0, rebuildChanged: 0 };
    const before = M.featureSummary();
    const burgsBefore = liveBurgs().length;
    const graphBefore = T.cellGraph();
    const base = Uint8Array.from(cur);
    const heightsDigest = hashArray(target);
    // deterministic rebuild: the app's own steps reseed Math.random from the map seed; seed it
    // here too (map seed + heights) for anything before them, and put the caller's PRNG back
    const prevRandom = Math.random;
    Math.random = aleaPRNG(`${seed}:heights:${heightsDigest}`);
    let carried;
    try {
      carried = o.rebuild === "risk" ? rebuildRisk(target, o, info) : rebuildKeep(target, o, info);
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
    const graphAfter = T.cellGraph();
    const renumbered = graphAfter !== graphBefore;
    if (o.rebuild === "risk")
      c.notes.add(
        renumbered
          ? "rebuild:'risk' re-ran features, climate, lakes and rivers and re-packed the cells (cell ids changed); burgs, states, cultures, religions, provinces, zones, routes and markers were kept where land remains and moved to the new cells; lake and island names were carried over"
          : "rebuild:'risk' re-ran features, climate, lakes and rivers; the re-packed cells came out the same (cell ids unchanged)"
      );
    else
      c.notes.add(
        "rebuild:'keep' kept the coastline and cell ids; climate, rivers and lakes were recomputed on the new heights"
      );
    if (raisedForBurgs)
      c.notes.add(`${raisedForBurgs} grid cells set to water hold a burg and were kept as land (height 20)`);
    if (deepLakes) c.notes.add(`erosion turned ${deepLakes} grid cells of deep depressions into lakes`);
    if (o.erosion)
      c.notes.add(
        o.keepHeights
          ? `erosion cut river beds into ${info.rebuildChanged} land cells; keepHeights put their requested heights back`
          : `erosion cut river beds into ${info.rebuildChanged} land cells (kept: keepHeights is off)`
      );
    riverNotes(c, carried?.rivers);
    if (carried?.portsLost)
      c.notes.add(`${carried.portsLost} port burgs no longer stand by water; their port was cleared`);
    const out = {
      heightsDigest,
      ...plan,
      heightsRestored: info.heightsRestored,
      ...(o.keepHeights ? {} : { heightsLeftChanged: info.rebuildChanged }),
      raisedForBurgs,
      deepLakes,
      burgsRemoved: burgsBefore - liveBurgs().length,
      cellsRenumbered: renumbered,
      ...(carried?.rivers ? { rivers: carried.rivers } : {}),
      features: { before, after: M.featureSummary() }
    };
    const moved = { ...carried };
    delete moved.rivers;
    if (Object.keys(moved).length) out.carried = moved;
    if (src.replay) {
      out.replayBase = { matches: src.replay.baseMatches, changed: src.replay.changed, overlap: src.replay.overlap };
      if (!src.replay.baseMatches)
        c.notes.add(
          `this map's heights differ from the ones the changes were recorded on: only the ${src.replay.changed} recorded cells were set and its other heights kept${src.replay.overlap ? `; ${src.replay.overlap} of those cells had been changed here too and now hold the recorded value` : ""}`
        );
    }
    if (typeof a.expectGraph === "string") {
      out.graphMatches = a.expectGraph === graphAfter;
      if (!out.graphMatches)
        c.notes.add(
          "the rebuild produced another cell graph than when the sketch recorded it (the map's burgs, settings or seed differ), so later literal cell lists will not line up"
        );
    }
    const rd = await M.finishRedraw(a, c.R);
    const enc = await encodeChanges(base, final);
    const resolved = {
      changes: enc.changes,
      changed: enc.changed,
      cells: n,
      gridDigest: digestNow,
      baseDigest: hashArray(base),
      heightsDigest: hashArray(final),
      options: { rebuild: o.rebuild, erosion: o.erosion, keepHeights: o.keepHeights, biomes: o.biomes },
      graphAfter,
      bbox: changedBox(base, final),
      stats: {
        changed: enc.changed,
        toLand: stats.toLand,
        toWater: stats.toWater,
        lakesFormed: stats.lakes.formed,
        landPct: stats.landPct.after
      }
    };
    if (a.redraw !== undefined) resolved.redraw = a.redraw;
    return { ...out, resolved, ...rd, notes: [...c.notes] };
  };

  // ---------------------------------------------------------------- flow

  const FLOW_ID = "tupaiaFlow";
  const KM_PER = { km: 1, mi: 1.609344, lg: 4.828032, vr: 1.0668, nmi: 1.852, nlg: 5.556 };
  // a mask of the cells whose land/water status the last flow's proposed heights change
  let flowMask = null;

  function lengthOf(pts) {
    let px = 0;
    for (let k = 1; k < pts.length; k++) px += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    const sel = document.getElementById("distanceUnitInput");
    const unit = sel?.value || "km";
    const inUnit = px * distanceScale;
    const out = { px: roundTo(px, 1) };
    if (KM_PER[unit]) out.km = roundTo(inUnit * KM_PER[unit], 1);
    if (unit !== "km") {
      const unitName = unit === "custom_name" ? sel?.selectedOptions?.[0]?.textContent?.trim() || "units" : unit;
      out[unitName] = roundTo(inUnit, 1);
    }
    return out;
  }

  /** Where an existing river's water finally goes: its basin's mouth, through lakes with outlets. */
  function riverFate(id) {
    const C = pack.cells;
    const byId = new Map((pack.rivers || []).map(r => [r.i, r]));
    const label = r => `${r.name || "river"} (${r.i})`;
    const xy = cell => (cell >= 0 && C.p[cell] ? [roundTo(C.p[cell][0], 1), roundTo(C.p[cell][1], 1)] : null);
    let r = byId.get(id);
    const seen = new Set();
    const via = [];
    while (r && !seen.has(r.i)) {
      seen.add(r.i);
      const last = Array.isArray(r.cells) ? r.cells[r.cells.length - 1] : undefined;
      if (last === undefined) return null;
      if (last < 0)
        return { type: "border", at: xy(r.mouth), river: label(r), ...(via.length ? { throughLakes: via } : {}) };
      if (C.h[last] >= 20) {
        // a tributary ends on its parent river
        const up = byId.get(C.r[last]);
        r = up && up.i !== r.i ? up : byId.get(r.parent);
        continue;
      }
      const ft = pack.features[C.f[last]];
      if (ft?.type === "lake" && ft.outlet && byId.has(ft.outlet)) {
        via.push(ft.name ?? `lake ${ft.i}`);
        r = byId.get(ft.outlet);
        continue;
      }
      const out = { type: ft?.type === "lake" ? "lake" : "sea", at: xy(last), river: label(r) };
      if (ft?.name) out.name = ft.name;
      if (via.length) out.throughLakes = via;
      return out;
    }
    return null;
  }

  /** A flow start: {cell (graph id), x, y (the cell's centre), asked?, snapped?}. */
  function flowStart(p, mode) {
    let x;
    let y;
    let cell;
    if (isObj(p) && p.gridCell !== undefined) {
      const g = Number(p.gridCell);
      if (!Number.isInteger(g) || g < 0 || g >= grid.points.length)
        fail("OUT_OF_BOUNDS", `gridCell ${p.gridCell} is outside 0..${grid.points.length - 1}`);
      [x, y] = grid.points[g];
      cell = mode === "grid" ? g : findCell(x, y);
    } else {
      const s = T.place(p);
      x = s.x;
      y = s.y;
      // {cell} is a cell of the current map; in grid mode it means the grid cell under it
      if (mode === "grid") cell = isObj(p) && p.cell !== undefined ? pack.cells.g[s.cell] : nearestGridCell(x, y);
      else cell = s.cell;
    }
    const GP = mode === "grid" ? grid.points : pack.cells.p;
    const at = [roundTo(GP[cell][0], 1), roundTo(GP[cell][1], 1)];
    const out = { x: at[0], y: at[1], cell };
    const d = Math.hypot(GP[cell][0] - x, GP[cell][1] - y);
    if (d > (grid.spacing || 0)) {
      out.asked = [roundTo(x, 1), roundTo(y, 1)];
      out.snapped = roundTo(d, 1);
    }
    return out;
  }

  FNS.flow = async a => {
    const places = Array.isArray(a.from) ? a.from : [a.from];
    if (!places.length || places.length > 50) fail("BAD_ARGS", "from is a place or 1-50 places");
    let mode = "pack";
    let G;
    let source;
    flowMask = null;
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
      const cur = grid.cells.h;
      flowMask = { toLand: [], toWater: [] };
      for (let g = 0; g < h.length; g++) {
        if (cur[g] < 20 && h[g] >= 20) flowMask.toLand.push(g);
        else if (cur[g] >= 20 && h[g] < 20) flowMask.toWater.push(g);
      }
    } else G = packGraph();
    const starts = places.map(p => flowStart(p, mode));
    const D = drainSurface(G, drainLimits());
    // proposed lakes named after the current lake they overlap, if any
    const lakeName = id => {
      if (mode === "pack") return G.lakeMap.get(id)?.name ?? null;
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
      const tr = traceFlow(G, D, s.cell);
      const pts = tr.path.map(i => [roundTo(G.p[i][0], 1), roundTo(G.p[i][1], 1)]);
      const end = { type: tr.end.type, x: pts.at(-1)[0], y: pts.at(-1)[1], cell: tr.end.cell };
      if (tr.end.lake !== undefined) {
        const nm = lakeName(tr.end.lake);
        end.lake = nm ?? (mode === "pack" ? tr.end.lake : "a new lake");
        if (tr.end.closed) end.closed = true;
      }
      if (tr.end.river) {
        const r = (pack.rivers || []).find(x => x.i === tr.end.river);
        end.river = r ? `${r.name || "river"} (${r.i})` : tr.end.river;
        const fate = riverFate(tr.end.river);
        if (fate) end.goesTo = fate;
      }
      if (tr.end.loop) end.loop = true;
      const fall = G.h[s.cell] - G.h[tr.end.cell];
      const row = { from: { ...s, h: G.h[s.cell] }, end, steps: tr.path.length - 1, length: lengthOf(pts) };
      // a path can end above its start (water rises through a lake to its outlet, then stops)
      if (fall >= 0) row.drop = fall;
      else row.rise = -fall;
      if (tr.lakes.length) row.throughLakes = tr.lakes.map(id => lakeName(id) ?? (mode === "pack" ? id : "a new lake"));
      if (tr.pitsOnPath) row.climbs = tr.pitsOnPath;
      if (a.detail) row.cells = tr.path;
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

  const FLOW_COLORS = ["#ff2d6f", "#1f77ff", "#ff9f1c", "#8a2be2", "#00a86b", "#e6194b", "#0bb5c9", "#b8860b"];

  function gridCellPath(g) {
    const vs = grid.cells.v?.[g];
    const V = grid.vertices?.p;
    if (!vs?.length || !V) return null;
    return `M${vs.map(v => V[v].map(q => roundTo(q, 1)).join(",")).join("L")}Z`;
  }

  /**
   * Draw (paths: [[x,y]...][]) or remove ({remove:true}) the temporary flow overlay; returns its
   * bbox. Each path has its own colour and a number at its start (path k = paths[k-1]); with
   * proposed heights the cells that would become land (green) or water (blue) are tinted.
   */
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
    let masked = 0;
    if (flowMask) {
      const tintCells = (cellsList, color) => {
        const d = cellsList.map(gridCellPath).filter(Boolean).join("");
        if (d) g.append("path").attr("d", d).attr("fill", color).attr("fill-opacity", 0.45).attr("stroke", "none");
        masked += cellsList.length;
      };
      tintCells(flowMask.toLand, "#3fae49");
      tintCells(flowMask.toWater, "#2a7fff");
    }
    paths.forEach((p, k) => {
      const color = FLOW_COLORS[k % FLOW_COLORS.length];
      g.append("polyline")
        .attr("points", p.map(q => q.join(",")).join(" "))
        .attr("fill", "none")
        .attr("stroke", color)
        .attr("stroke-width", w * 2)
        .attr("stroke-linejoin", "round")
        .attr("stroke-linecap", "round");
      g.append("circle")
        .attr("cx", p[0][0])
        .attr("cy", p[0][1])
        .attr("r", w * 3)
        .attr("fill", color);
      const e = p[p.length - 1];
      g.append("circle")
        .attr("cx", e[0])
        .attr("cy", e[1])
        .attr("r", w * 3)
        .attr("fill", "#fff")
        .attr("stroke", color)
        .attr("stroke-width", w);
      g.append("text")
        .attr("x", p[0][0] + w * 4)
        .attr("y", p[0][1] - w * 4)
        .attr("font-size", w * 12)
        .attr("font-family", "sans-serif")
        .attr("font-weight", "bold")
        .attr("fill", color)
        .attr("stroke", "#fff")
        .attr("stroke-width", w * 1.5)
        .attr("paint-order", "stroke")
        .text(String(k + 1));
    });
    const legendText = `number k = paths[k-1]; filled dot = start, ring = end${masked ? "; green tint = becomes land, blue tint = becomes water (the map under it is the current one)" : ""}`;
    return { bbox: box.map(v => roundTo(v, 1)), legend: legendText };
  };

  T.terrain = {
    gridDigest,
    pure: {
      fillDepressions,
      waterBodies,
      countPits,
      pitCells,
      heightStats,
      graphFromHeights,
      drainSurface,
      traceFlow,
      bytesToB64,
      b64ToBytes,
      encodeChanges,
      decodeChanges
    }
  };
})(globalThis);
