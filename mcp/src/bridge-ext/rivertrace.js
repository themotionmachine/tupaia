// Tupaia MCP bridge extension: rivers traced again onto changed cells, and carved where they
// would climb. Shared by regrid (a new grid: bridge-ext/regrid.js) and the heightmap rebuild
// (set_heights / paint_cells height rebuild:'risk' with rivers:'retrace': bridge-mutations.js
// riskRebuild). Classic script injected after bridge.js and bridge-mutations.js; same rules: app
// globals by bare name at call time, no locals that shadow app globals. Exposes T.riverTrace:
//   capture(rivers)              on the old cells: each river's line, flux and how it ends (a plan)
//   retrace(plan, report, opts?) on the new cells: every river traced again (report.rivers)
//   carve(only?)                 lower river cells so no river climbs
//   climbing()                   ids of the rivers whose land heights rise downstream
//   lowerLakes(lowered)          a lake whose shore was carved below its level follows it down
// retrace without opts is regrid's (behaviour pinned by test/regrid.test.ts); opts.rebuild adds
// what a heightmap rebuild needs (the same grid, a new coastline): see retrace.
(root => {
  const T = root.__tupaia;
  if (!T) return;

  const rn = (v, d = 2) => {
    const m = 10 ** d;
    return Math.round(v * m) / m;
  };
  const isLive = x => !!x && typeof x === "object" && !x.removed;

  /**
   * Neighbour cells that join cell a to cell b (exclusive), walking greedily toward b's centre (on
   * a Delaunay graph the greedy walk reaches it); `avoid` cells are never stepped on. null when no
   * walk within maxSteps exists.
   */
  function bridgeCells(a, b, avoid, maxSteps = 64) {
    const C = pack.cells;
    const [tx, ty] = C.p[b];
    const path = [];
    const seen = new Set([a]);
    let cur = a;
    while (!C.c[cur].includes(b)) {
      if (path.length >= maxSteps) return null;
      let best = -1;
      let bd = Infinity;
      for (const j of C.c[cur]) {
        if (seen.has(j) || avoid.has(j)) continue;
        const d = (C.p[j][0] - tx) ** 2 + (C.p[j][1] - ty) ** 2;
        if (d < bd) {
          bd = d;
          best = j;
        }
      }
      if (best < 0) return null;
      path.push(best);
      seen.add(best);
      cur = best;
    }
    return path;
  }

  // ---------------------------------------------------------------- rivers (re-traced)
  //
  // Resample maps each river's meandered line point-wise to the new cells: on a finer grid two
  // consecutive points land in cells that are not neighbours (lint river-gap), on a coarser one
  // the line revisits cells, and cells.r/cells.fl/cells.conf keep the old cells' values around
  // the old course. Instead each river is traced again as a contiguous path of new-cell
  // neighbours that follows its old line (its control points, or its cell centres): the line is
  // sampled finely and a Viterbi pass picks, per sample, a cell among the nearby ones so that
  // consecutive cells are neighbours and the cells stay as close to the line as possible (the
  // cell holding each sample when that is contiguous). Water and other rivers' cells cost extra
  // where the old river had none, so the path goes round them when it can. Then: loops cut out,
  // the river ends where it ended (the sea or a lake, its parent at the confluence, or off the
  // map edge), lake outlets start in their lake; a parent is traced before its tributaries. Each
  // new cell gets one control point on the old line (the drawn river stays where it was), the
  // old flux along the line (never falling downstream), and cells.r/cells.conf are rebuilt from
  // the paths. Ids, names, types, parents and basins are kept; source, mouth, length, discharge
  // and width are recomputed (widthFactor scaled as a generation at the new density scales it).

  const STUCK = 25; // per-sample cost of a water or foreign river cell the old river did not have
  const CLIMB = 0.3; // cost per height unit of a step uphill
  /**
   * On the old map (before the grid is rebuilt or the cells re-packed): what each river needs to
   * be traced again. Returns the plan retrace() takes.
   */
  function capture(rivers) {
    const C = pack.cells;
    const list = (rivers || []).filter(r => isLive(r) && Array.isArray(r.cells) && r.cells.length >= 2);
    const body = new Map(); // old cell -> rivers whose body (all but the last cell) has it
    for (const r of list)
      for (let k = 0; k < r.cells.length - 1; k++) {
        const c = r.cells[k];
        if (c < 0) continue;
        const a = body.get(c);
        if (a) a.push(r.i);
        else body.set(c, [r.i]);
      }
    const plans = new Map();
    const lakes = new Map(); // lake feature id -> its grid cells
    const lakeAt = c => {
      const f = C.f[c];
      if (pack.features?.[f]?.type !== "lake") return null;
      let a = lakes.get(f);
      if (!a) {
        a = new Set();
        for (const i of C.i) if (C.f[i] === f) a.add(C.g[i]);
        a = [...a];
        lakes.set(f, a);
      }
      return a;
    };
    for (const r of list) {
      let pts;
      try {
        pts =
          typeof Rivers?.getRiverPoints === "function"
            ? Rivers.getRiverPoints(r.cells, r.points ?? null)
            : r.points || r.cells.map(c => C.p[c]);
      } catch {
        continue;
      }
      if (pts?.length !== r.cells.length || pts.some(q => !q || !Number.isFinite(q[0]) || !Number.isFinite(q[1])))
        continue;
      const last = r.cells.at(-1);
      let end = "land";
      let joinTo = 0;
      if (last === -1) end = "edge";
      else if (C.h[last] < 20) end = "water";
      else {
        // the river it flows into: its parent when the parent has that cell (in its body, or as
        // its own last cell: both join a third river there), else the river whose body has it
        const parent = r.parent !== r.i ? list.find(x => x.i === r.parent) : null;
        const owners = (body.get(last) || []).filter(x => x !== r.i);
        joinTo = parent?.cells.includes(last) ? parent.i : (owners[0] ?? 0);
        if (joinTo) end = "join";
      }
      const fl = r.cells.map((c, k) => (c >= 0 ? C.fl[c] : C.fl[r.cells[k - 1]] || 0));
      const pl = {
        i: r.i,
        pts: pts.map(q => [q[0], q[1]]),
        fl,
        water: r.cells.map(c => c >= 0 && C.h[c] < 20),
        end,
        joinTo,
        parent: r.parent,
        basin: r.basin,
        g: r.cells.map(c => (c >= 0 ? C.g[c] : -1)) // grid cell per point (a rebuild keeps the grid)
      };
      // the lake it ends in / starts in (a heightmap rebuild checks whether it is still there)
      const endLake = end === "water" ? lakeAt(last) : null;
      const startLake = r.cells[0] >= 0 && C.h[r.cells[0]] < 20 ? lakeAt(r.cells[0]) : null;
      if (endLake) pl.endLake = endLake;
      if (startLake) pl.startLake = startLake;
      // where the course already jumped (cells that are not neighbours): an unchanged course may keep it
      const gaps = [];
      for (let k = 1; k < r.cells.length; k++) {
        const a = r.cells[k - 1];
        const b = r.cells[k];
        if (a >= 0 && b >= 0 && a !== b && !C.c[a].includes(b)) gaps.push(k);
      }
      if (gaps.length) pl.gaps = gaps;
      plans.set(r.i, pl);
    }
    // flux of the old land cells off the rivers (for new cells the old course no longer crosses)
    const dry = [];
    for (const i of C.i) if (C.h[i] >= 20 && !C.r[i]) dry.push([C.p[i][0], C.p[i][1], C.fl[i]]);
    return { plans, dry, spacing: grid.spacing, cellsDesired: grid.cellsDesired };
  }

  /** Cells within two rings of c (c first). */
  function ring2(c, stamp, tick) {
    const C = pack.cells;
    const out = [c];
    stamp[c] = tick;
    for (let k = 0; k < out.length && k < 1 + C.c[c].length; k++)
      for (const nb of C.c[out[k]])
        if (stamp[nb] !== tick) {
          stamp[nb] = tick;
          out.push(nb);
        }
    return out;
  }

  /** Shortest walk (BFS over `pass` cells) from `from` to a cell that passes `goal`, within maxDepth steps; [] when none. */
  function walkTo(from, goal, pass, maxDepth = 12) {
    const C = pack.cells;
    const prev = new Map([[from, -1]]);
    let ring = [from];
    for (let d = 0; d < maxDepth && ring.length; d++) {
      const next = [];
      for (const x of ring)
        for (const y of C.c[x]) {
          if (prev.has(y)) continue;
          prev.set(y, x);
          if (goal(y)) {
            const path = [];
            for (let p = y; p !== from; p = prev.get(p)) path.push(p);
            return path.reverse();
          }
          if (pass(y)) next.push(y);
        }
      ring = next;
    }
    return [];
  }

  /**
   * One river traced on the new cells: [{c, x, y, f}] from source to its end (a terminal cell
   * last for 'water'/'join'; -1 last for 'edge'), or null when it is too short now.
   * owner: river id per cell for the rivers traced so far.
   */
  function traceRiver(plan, riverPlan, owner, stamp, out) {
    const C = pack.cells;
    const { pts, fl, water } = plan;
    const A = pts.length;
    const sp = grid.spacing;
    const step = Math.max(0.5, Math.min(sp, riverPlan.spacing) / 3);
    const clampX = v => Math.min(graphWidth, Math.max(0, v));
    const clampY = v => Math.min(graphHeight, Math.max(0, v));
    // samples along the old line: [x, y, segment, flux]
    const S = [];
    for (let k = 0; k + 1 < A; k++) {
      const [x0, y0] = pts[k];
      const [x1, y1] = pts[k + 1];
      const m = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
      for (let j = 0; j < m; j++)
        S.push([clampX(x0 + ((x1 - x0) * j) / m), clampY(y0 + ((y1 - y0) * j) / m), k, fl[k]]);
    }
    S.push([clampX(pts[A - 1][0]), clampY(pts[A - 1][1]), A - 2, plan.end === "edge" ? fl[A - 2] : fl[A - 1]]);
    const finalSeg = A - 2;
    const sp2 = sp * sp;
    const onJoin = c => !!out.joinCells?.has(c); // the cells of the river it flows into
    // rebuild: grid cells the change set to water that hold a burg (the app keeps them as land at
    // 20): part of the new water, so the river crosses the lake rather than the burg's spit
    const avoid = out.avoidGrid;
    const cost = (c, s) => {
      const d = ((C.p[c][0] - s[0]) ** 2 + (C.p[c][1] - s[1]) ** 2) / sp2;
      let pen = 0;
      if (C.h[c] < 20 && !water[s[2]] && !water[s[2] + 1]) pen += STUCK;
      else if (avoid?.has(C.g[c]) && !water[s[2]] && !water[s[2] + 1]) pen += 4 * STUCK;
      const o = owner[c];
      if (o && o !== plan.i && !(s[2] === finalSeg && onJoin(c))) pen += STUCK;
      return d + pen;
    };
    // Viterbi over the samples: a cell may follow itself or a neighbour
    const cands = [];
    const back = [];
    let prevCells = null;
    let prevCost = null;
    let prevIdx = null;
    out.extended = 0;
    for (let t = 0; t < S.length; t++) {
      const s = S[t];
      const c0 = findCell(s[0], s[1]);
      if (c0 === undefined) return null;
      const cs = ring2(c0, stamp, ++out.tick);
      const cc = new Float64Array(cs.length);
      const bk = new Int32Array(cs.length).fill(-1);
      if (!prevCells) for (let j = 0; j < cs.length; j++) cc[j] = cost(cs[j], s);
      else {
        let any = false;
        for (let j = 0; j < cs.length; j++) {
          const v = cs[j];
          let best = Infinity;
          let bi = -1;
          const u0 = prevIdx.get(v);
          if (u0 !== undefined) {
            best = prevCost[u0];
            bi = u0;
          }
          for (const u of C.c[v]) {
            const ui = prevIdx.get(u);
            if (ui === undefined) continue;
            // a step uphill costs (rivers run down: a cell on a ridge beside the line is avoided)
            const up = C.h[v] >= 20 && C.h[u] >= 20 ? Math.max(0, C.h[v] - C.h[u]) * CLIMB : 0;
            if (prevCost[ui] + up < best) {
              best = prevCost[ui] + up;
              bi = ui;
            }
          }
          cc[j] = best + cost(v, s);
          bk[j] = bi;
          if (bi >= 0) any = true;
        }
        if (!any) {
          // nothing within reach (a jump the samples cannot bridge): restart here; joined below
          let mi = 0;
          for (let u = 1; u < prevCost.length; u++) if (prevCost[u] < prevCost[mi]) mi = u;
          for (let j = 0; j < cs.length; j++) {
            cc[j] = prevCost[mi] + cost(cs[j], s);
            bk[j] = mi;
          }
        }
      }
      cands.push(cs);
      back.push(bk);
      prevCells = cs;
      prevCost = cc;
      prevIdx = new Map(cs.map((c, j) => [c, j]));
    }
    let j = 0;
    for (let u = 1; u < prevCost.length; u++) if (prevCost[u] < prevCost[j]) j = u;
    const seq = new Int32Array(S.length);
    for (let t = S.length - 1; t >= 0; t--) {
      seq[t] = cands[t][j];
      j = back[t][j];
    }
    // runs of one cell, each with its samples
    let runs = [];
    for (let t = 0; t < S.length; t++) {
      const last = runs[runs.length - 1];
      if (last && last.c === seq[t]) last.s.push(t);
      else runs.push({ c: seq[t], s: [t] });
    }
    // a jump the Viterbi could not bridge (rare): the cells between, greedily
    for (let k = 0; k + 1 < runs.length; k++) {
      const a = runs[k].c;
      const b = runs[k + 1].c;
      if (C.c[a].includes(b)) continue;
      const mid = bridgeCells(a, b, new Set()) || [];
      runs.splice(k + 1, 0, ...mid.map(c => ({ c, s: [] })));
      k += mid.length;
    }
    // loops cut out: back at a cell, the path goes on from its first visit
    const at = new Map();
    const path = [];
    for (const r of runs) {
      const k = at.get(r.c);
      if (k !== undefined) {
        for (const x of path.splice(k + 1)) at.delete(x.c);
        continue;
      }
      at.set(r.c, path.length);
      path.push(r);
    }
    runs = path;
    const isWater = c => C.h[c] < 20;
    // the source: a lake outlet starts in its lake (one water cell), any other river on land
    const firstLand = runs.findIndex(r => !isWater(r.c));
    if (firstLand < 0) return null;
    if (water[0] && plan.startOnLand) {
      // rebuild: the lake it flowed out of is gone; it starts where its old line left the lake
      const t0 = S.findIndex(s => s[2] >= plan.startOnLand);
      const k = t0 < 0 ? -1 : runs.findIndex(r => r.s.some(t => t >= t0));
      const j = k < 0 ? -1 : runs.findIndex((r, i) => i >= k && !isWater(r.c));
      runs = runs.slice(j < 0 ? firstLand : j);
    } else if (water[0]) {
      runs = runs.slice(Math.max(0, firstLand - 1));
      if (!isWater(runs[0].c)) {
        const lake = C.c[runs[0].c].find(c => isWater(c) && !runs.some(r => r.c === c));
        if (lake !== undefined) runs.unshift({ c: lake, s: [] });
      }
    } else runs = runs.slice(firstLand);
    // the end
    const free = c => !isWater(c) && (!owner[c] || owner[c] === plan.i);
    // the walk to a river's end goes round other rivers, else (a short one) across them
    const reach = goal => {
      const from = runs[runs.length - 1].c;
      const on = new Set(runs.map(r => r.c)); // never back over its own course
      const ok = c => !on.has(c) && goal(c);
      const ext = walkTo(from, ok, c => !on.has(c) && free(c), plan.reachMax ?? 12);
      return ext.length ? ext : walkTo(from, ok, c => !on.has(c) && !isWater(c), Math.min(6, plan.reachMax ?? 6));
    };
    let end = plan.end;
    let extended = 0;
    if (end === "edge" && isWater(runs[runs.length - 1].c)) end = "water"; // the map edge is sea now
    if (end === "water") {
      let e = runs.length;
      while (e > 0 && isWater(runs[e - 1].c)) e--;
      if (e < runs.length) runs = runs.slice(0, e + 1);
      else {
        const ext = reach(isWater);
        extended += ext.length;
        runs.push(...ext.map(c => ({ c, s: [] })));
      }
    } else if (end === "join") {
      let e = runs.findIndex(r => onJoin(r.c) && r.s.some(t => S[t][2] === finalSeg));
      if (e < 0) e = runs.findIndex(r => onJoin(r.c));
      if (e >= 0) runs = runs.slice(0, e + 1);
      else {
        const ext = reach(c => onJoin(c) && !isWater(c));
        extended += ext.length;
        runs.push(...ext.map(c => ({ c, s: [] })));
        // rebuild: an inflow of a lake that is gone joins the lake's outlet river when it is near
        if (!ext.length && plan.softJoin) end = "land";
      }
    } else if (end === "edge" && !C.b[runs[runs.length - 1].c]) {
      const ext = reach(c => !!C.b[c] && !isWater(c));
      extended += ext.length;
      runs.push(...ext.map(c => ({ c, s: [] })));
    }
    if (runs.length < 2 && end !== "edge") return null;
    out.extended = extended;
    // one control point per cell on the old line (its middle sample), the old flux along it
    // (never falling downstream on land; a lake on the way resets it, as its outflow does)
    let f = 0;
    const course = runs.map(r => {
      let x;
      let y;
      if (r.s.length) {
        [x, y] = S[r.s[r.s.length >> 1]];
        for (const t of r.s) f = Math.max(f, S[t][3]);
      } else [x, y] = C.p[r.c];
      const here = f;
      if (isWater(r.c)) f = 0;
      return { c: r.c, x: rn(x, 2), y: rn(y, 2), f: here };
    });
    if (end === "edge") {
      const [ex, ey] = pts[A - 1];
      course.push({ c: -1, x: rn(ex, 2), y: rn(ey, 2), f });
    }
    out.end = end;
    return course;
  }

  /** "Name (id)" of each river id, at most `k` of them (then "+N more"). */
  function riverTags(ids, byId, k = 25) {
    const out = ids.slice(0, k).map(id => {
      const r = byId.get(id);
      return r?.name ? `${r.name} (${id})` : `river ${id}`;
    });
    if (ids.length > k) out.push(`+${ids.length - k} more`);
    return out;
  }

  /**
   * opts.rebuild (the same grid, a new coastline): a river's line fitted to the new cells. Its
   * course is under water when no point of it is on land now, by the grid cell of the old cell
   * it stood for ({drowned}); it ends where it
   * first meets new sea (an ocean cell where its old course was land: the line is cut there,
   * {cut} when that drops some of it); a tributary of a river that drowned ends in water too.
   * {toWater}: it ends in water before its old confluence now.
   */
  function fitToCoast(pl, drowned, packOf) {
    const C = pack.cells;
    // land and water by the grid cell of each old point (the pack keeps only the water cells
    // near land, so findCell in open water can give a land cell); packOf: grid cell -> a pack
    // cell of it
    const gh = grid.cells.h;
    const gs = pl.g;
    const first = gs.findIndex(g => g >= 0 && gh[g] >= 20);
    if (first < 0) return { drowned: true };
    let out = pl;
    let toWater = false;
    if (pl.end === "join" && drowned.has(pl.joinTo)) {
      out = { ...pl, end: "water", joinTo: 0 };
      toWater = true;
    }
    for (let k = first + 1; k < gs.length; k++) {
      if (pl.water[k] || !(gs[k] >= 0 && gh[gs[k]] < 20)) continue;
      // the water there: a pack cell of that grid cell, else (the pack leaves out water two
      // cells from land: a large lake's middle, open sea) the nearest pack cell, if water
      const c = packOf.get(gs[k]) ?? findCell(pl.pts[k][0], pl.pts[k][1]);
      if (c !== undefined && C.h[c] < 20 && pack.features[C.f[c]]?.type !== "ocean") continue;
      return {
        plan: {
          ...out,
          pts: pl.pts.slice(0, k + 1),
          g: pl.g.slice(0, k + 1),
          fl: pl.fl.slice(0, k + 1),
          water: pl.water.slice(0, k + 1),
          end: "water",
          joinTo: 0
        },
        cut: k < gs.length - 1,
        toWater: toWater || out.end === "join"
      };
    }
    return { plan: out, toWater };
  }

  /**
   * opts.rebuild with opts.changedGrid (the grid cells whose height the rebuild changed): the
   * course of a river none of whose cells changed, as retrace() paths ({c, x, y, f}: its mapped
   * cells, its old line and flux), with its repeats and the jumps it already had. idx: for each
   * mapped cell, the index of the old cell it came from (the remap merges two old cells that land
   * on one new cell); without it the mapped cells must match the old ones one to one. The course
   * must still hold: land and water where they were, consecutive cells neighbours where they were
   * (the re-pack re-makes coastline cells, which can split a course), its end where it was (the
   * map edge, or a cell of the river it joins). Else null (the river is traced again).
   */
  function unchangedCourse(r, pl, changedGrid, joinCells, idx) {
    const C = pack.cells;
    const cs = r.cells;
    if (!changedGrid || !Array.isArray(cs) || !cs.length) return null;
    const at = Array.isArray(idx) && idx.length === cs.length ? idx : cs.length === pl.pts.length ? null : false;
    if (at === false) return null;
    const src = k => (at ? at[k] : k);
    for (let k = 0; k < cs.length; k++) {
      const c = cs[k];
      if (c === -1 && k === cs.length - 1 && pl.end === "edge") continue;
      if (!(c >= 0) || !(src(k) < pl.pts.length) || changedGrid.has(C.g[c]) || C.h[c] < 20 !== pl.water[src(k)])
        return null;
      // the re-pack re-makes the coastline cells: a course it split is traced again
      const b = cs[k - 1];
      if (k && b !== c && !C.c[b].includes(c) && !pl.gaps?.some(j => j > src(k - 1) && j <= src(k))) return null;
    }
    if (pl.end === "edge" && cs[cs.length - 1] !== -1) return null;
    if (pl.end === "join" && !joinCells?.has(cs[cs.length - 1])) return null;
    return cs.map((c, k) => ({ c, x: pl.pts[src(k)][0], y: pl.pts[src(k)][1], f: pl.fl[src(k)] }));
  }

  /** Distinct land cells among `cells` (pack ids). */
  const landCount = cells => new Set(cells.filter(c => c >= 0 && pack.cells.h[c] >= 20)).size;

  /**
   * After Resample.restoreRivers (identity projection): every river traced again on the new
   * cells, then cells.r, cells.conf and cells.fl rebuilt from the paths. Returns the counts.
   *
   * opts.rebuild: after a heightmap rebuild (the same grid, cells re-packed, each river's cells
   * already mapped to the new cells by grid cell). A river none of whose cells changed height
   * (opts.changedGrid) keeps its course as it was (unchangedCourse; its source, mouth, length
   * and width too). Any other river's line is fitted to the new coastline (fitToCoast) and traced
   * again; a river whose course is under water now (no point of its line on land, or fewer than
   * two land cells when it cannot be traced) is removed, and a tributary of it becomes a main
   * river (parent its own id, basins follow); a river that cannot be traced keeps its mapped
   * cells; widthFactor is kept. report.rivers adds `before`, `unchanged` and, when any, the
   * rivers by name ("Name (id)"): underWater (removed), notRetraced, shortened (meets the sea
   * higher up), toWaterNow (ends in water before its old confluence; parent kept), endsInland
   * (meant to end in water, none within reach), orphaned (tributaries of removed rivers).
   */
  function retrace(plan, report, opts = {}) {
    if (!plan) return;
    const rebuild = !!opts.rebuild;
    const C = pack.cells;
    const n = C.i.length;
    const byId = new Map((pack.rivers || []).map(r => [r.i, r]));
    const before = byId.size;
    const drowned = new Set();
    const rb = { notRetraced: [], shortened: [], toWaterNow: [], endsInland: [] };
    const lakeGone = []; // [id, what] (rebuild): its lake is gone
    const detached = new Set(); // rebuild: an inflow of a gone lake that ends inland (a main river now)
    // a river after the one it flows into
    const order = [];
    const seen = new Set();
    const visit = id => {
      if (seen.has(id)) return;
      seen.add(id);
      const p = plan.plans.get(id);
      if (p?.joinTo && plan.plans.has(p.joinTo)) visit(p.joinTo);
      order.push(id);
    };
    for (const id of [...plan.plans.keys()].sort((a, b) => a - b)) visit(id);
    const owner = new Uint16Array(n);
    const stamp = new Int32Array(n);
    const traced = new Map(); // id -> {path, end}
    const st = { retraced: 0, extended: 0, kept: 0 };
    const unchangedIds = new Set(); // rebuild: rivers that keep their course as it was
    const io = { tick: 0 };
    const packOf = new Map(); // rebuild: grid cell -> one of its pack cells
    if (rebuild) for (const i of C.i) if (!packOf.has(C.g[i])) packOf.set(C.g[i], i);
    const joinCellsOf = pl => {
      const into = pl.joinTo ? (traced.get(pl.joinTo)?.path.map(p => p.c) ?? byId.get(pl.joinTo)?.cells) : null;
      return into ? new Set(into.filter(c => c >= 0)) : null;
    };
    for (const id of order) {
      const r = byId.get(id);
      if (!r) continue;
      let pl = plan.plans.get(id);
      const same = rebuild ? unchangedCourse(r, pl, opts.changedGrid, joinCellsOf(pl), opts.keptIdx?.get(id)) : null;
      if (same) {
        // nothing on its course changed: it keeps its cells (on the new numbering) and its line
        const term = pl.end === "water" || pl.end === "join" || pl.end === "edge";
        for (let k = 0; k < (term ? same.length - 1 : same.length); k++)
          if (same[k].c >= 0 && !owner[same[k].c]) owner[same[k].c] = id;
        traced.set(id, { path: same, end: pl.end });
        unchangedIds.add(id);
        continue;
      }
      if (rebuild) {
        const fit = fitToCoast(pl, drowned, packOf);
        if (fit.drowned) {
          drowned.add(id);
          continue;
        }
        if (fit.plan !== pl) {
          pl = fit.plan;
          plan.plans.set(id, pl);
        }
        if (fit.cut) rb.shortened.push(id);
        if (fit.toWater) rb.toWaterNow.push(id);
        const gone = gs => !!gs && !gs.some(g => grid.cells.h[g] < 20);
        if (pl.end === "water" && gone(pl.endLake)) {
          // it ended in a lake that is gone: it joins the lake's outlet (its parent) when that
          // is near, else it ends where its line ended (a main river then)
          const p = pl.parent;
          pl =
            p && p !== id && byId.has(p) && !drowned.has(p)
              ? { ...pl, end: "join", joinTo: p, softJoin: true, reachMax: 6 }
              : { ...pl, end: "land", joinTo: 0 };
          plan.plans.set(id, pl);
          lakeGone.push([id, "end"]);
        }
        if (pl.water[0] && gone(pl.startLake)) {
          pl = {
            ...pl,
            startOnLand: Math.max(
              1,
              pl.water.findIndex(w => !w)
            )
          };
          plan.plans.set(id, pl);
          lakeGone.push([id, "start"]);
        }
      }
      io.joinCells = joinCellsOf(pl);
      io.avoidGrid = rebuild ? opts.avoidGrid : undefined;
      const path = traceRiver(pl, plan, owner, stamp, io);
      if (!path) {
        if (rebuild && landCount(r.cells) < 2) {
          drowned.add(id);
          continue;
        }
        if (rebuild) rb.notRetraced.push(id);
        // too short to trace now (lowering the density): Resample's line, one point per cell
        st.kept++;
        const keep = r.cells.map((c, k) => k === 0 || c !== r.cells[k - 1]);
        if (Array.isArray(r.points) && r.points.length === r.cells.length)
          r.points = r.points.filter((_, k) => keep[k]);
        r.cells = r.cells.filter((_, k) => keep[k]);
        for (const c of r.cells.slice(0, -1)) if (c >= 0 && !owner[c]) owner[c] = id;
        continue;
      }
      const term = io.end === "water" || io.end === "join" || io.end === "edge";
      const bodyLen = term ? path.length - 1 : path.length;
      for (let k = 0; k < bodyLen; k++) if (path[k].c >= 0 && !owner[path[k].c]) owner[path[k].c] = id;
      traced.set(id, { path, end: io.end });
      if (rebuild && io.end === "water" && C.h[path[path.length - 1].c] >= 20) rb.endsInland.push(id);
      if (rebuild && io.end === "land" && pl.end !== "land" && pl.softJoin) pl.end = "land";
      if (rebuild && pl.end === "land" && lakeGone.some(([x, w]) => x === id && w === "end")) {
        pl.parent = id;
        pl.basin = id;
        pl.joinTo = 0;
        detached.add(id);
      }
      st.retraced++;
      st.extended += io.extended ? 1 : 0;
    }
    let underWater = null;
    if (rebuild) {
      // a river capture() had no line for (under two cells, or no points): kept as mapped unless
      // its course is under water now
      for (const r of byId.values())
        if (!plan.plans.has(r.i) && !(Array.isArray(r.cells) && landCount(r.cells) >= 2)) drowned.add(r.i);
      if (drowned.size) {
        underWater = riverTags(
          [...drowned].sort((a, b) => a - b),
          byId
        );
        pack.rivers = pack.rivers.filter(r => !drowned.has(r.i));
        for (const id of drowned) byId.delete(id);
      }
    }
    // flux: the old flux along each new course; elsewhere on land the nearest old cell off the
    // rivers (Resample copied the old river cells' flux to every new cell near the old course)
    if (plan.dry.length) {
      const untraced = new Set();
      for (const r of byId.values()) if (!traced.has(r.i)) for (const c of r.cells) untraced.add(c);
      const q = d3.quadtree(
        plan.dry,
        d => d[0],
        d => d[1]
      );
      for (const i of C.i) if (C.h[i] >= 20 && !untraced.has(i)) C.fl[i] = q.find(C.p[i][0], C.p[i][1])?.[2] ?? C.fl[i];
    }
    C.r = new Uint16Array(n);
    C.conf = new Uint8Array(n);
    const ids = [...byId.keys()].sort((a, b) => a - b);
    const terminals = [];
    for (const id of ids) {
      const r = byId.get(id);
      const t = traced.get(id);
      if (!t) {
        for (const c of r.cells) if (c >= 0 && C.h[c] >= 20 && !C.r[c]) C.r[c] = id;
        continue;
      }
      const { path, end } = t;
      const term = end === "water" || end === "join" || end === "edge";
      for (let k = 0; k < path.length; k++) {
        const { c, f } = path[k];
        if (c < 0 || C.h[c] < 20) continue;
        if (term && k === path.length - 1) {
          terminals.push({ c, id, pre: path[k - 1]?.c });
          continue;
        }
        if (!C.r[c]) C.r[c] = id;
        else C.conf[c] = Math.max(C.conf[c], 1);
        C.fl[c] = Math.max(C.fl[c], Math.min(65535, Math.round(f)));
      }
      // a tributary's last point is its parent's point there, so the two lines meet
      const joined = end === "join" ? traced.get(plan.plans.get(id).joinTo)?.path : null;
      const meet = joined?.find(p => p.c === path[path.length - 1].c);
      if (meet) Object.assign(path[path.length - 1], { x: meet.x, y: meet.y });
      Object.assign(r, {
        cells: path.map(p => p.c),
        points: path.map(p => [p.x, p.y])
      });
    }
    // confluences: the tributary's last cell is on the river it joins; conf as the generator sums the lesser inflows
    for (const { c, id, pre } of terminals) {
      if (!C.r[c]) C.r[c] = id;
      else C.conf[c] = Math.min(255, C.conf[c] + Math.max(1, pre >= 0 ? C.fl[pre] : 1));
    }
    const scaleW = ((plan.cellsDesired || grid.cellsDesired) / grid.cellsDesired) ** 0.25;
    for (const r of byId.values()) {
      // an unchanged course keeps its source, mouth (mapped by grid cell), length and width
      if (!traced.has(r.i) || unchangedIds.has(r.i)) continue;
      r.source = r.cells[0];
      r.mouth = r.cells.at(-2) ?? r.cells[0];
      if (typeof r.widthFactor === "number" && !rebuild) r.widthFactor = rn(r.widthFactor * scaleW, 2);
      try {
        const meandered = Rivers.addMeandering(r.cells, r.points);
        r.length = Rivers.getApproximateLength(meandered.map(([x, y]) => [x, y]));
        r.discharge = C.fl[r.mouth] || r.discharge;
        r.width = Rivers.getWidth(
          Rivers.getOffset({
            flux: r.discharge,
            pointIndex: meandered.length,
            widthFactor: r.widthFactor,
            startingWidth: r.sourceWidth
          })
        );
      } catch {}
    }
    // parent and basin as they were (Resample re-derives them: a main river's parent 0 becomes its own id)
    for (const r of byId.values()) {
      const p = plan.plans.get(r.i);
      if (!p) continue;
      if (p.parent !== undefined) r.parent = p.parent;
      if (p.basin !== undefined) r.basin = p.basin;
    }
    const orphaned = [];
    if (drowned.size || detached.size) {
      // a tributary of a removed river is a main river now (as is an inflow of a gone lake that
      // ends inland); basins follow the parents
      for (const r of byId.values())
        if (drowned.has(r.parent)) {
          r.parent = r.i;
          orphaned.push(r.i);
        }
      const root = (r, depth = 0) =>
        !r.parent || r.parent === r.i || !byId.has(r.parent) || depth > 64 ? r.i : root(byId.get(r.parent), depth + 1);
      const heads = new Set([...orphaned, ...detached]);
      for (const r of byId.values()) {
        if (drowned.has(r.basin) || orphaned.includes(r.basin)) r.basin = root(r);
        else if (heads.size) {
          const top = root(r);
          if (heads.has(top)) r.basin = top;
        }
      }
    }
    report.rivers = rebuild
      ? { before, unchanged: unchangedIds.size, retraced: st.retraced }
      : { retraced: st.retraced };
    if (st.extended) report.rivers.extendedToTheirEnd = st.extended;
    if (rebuild) {
      if (underWater) report.rivers.underWater = underWater;
      for (const [k, ids] of Object.entries(rb)) if (ids.length) report.rivers[k] = riverTags(ids, byId);
      if (orphaned.length) report.rivers.orphaned = riverTags(orphaned, byId);
      if (lakeGone.length) {
        const tag = id => {
          const r = byId.get(id);
          return r?.name ? `${r.name} (${id})` : `river ${id}`;
        };
        const live = lakeGone.filter(([id]) => byId.has(id));
        report.rivers.lakeGone = live.slice(0, 25).map(([id, w]) => {
          if (w === "start") return `${tag(id)} starts where it left the lake`;
          if (detached.has(id)) return `${tag(id)} ends inland, a main river now`;
          const t = traced.get(id);
          return t?.end === "join" ? `${tag(id)} joins ${tag(byId.get(id).parent)}` : `${tag(id)} ends where it did`;
        });
        if (live.length > 25) report.rivers.lakeGone.push(`+${live.length - 25} more`);
      }
    } else if (st.kept) report.rivers.tooShortKeptAsMapped = st.kept;
  }

  // ---------------------------------------------------------------- river carving
  //
  // A retraced river follows its old line, but the new heights are sampled from the old surface
  // at other points: lowering the density, a new cell on the line can take its height from a
  // ridge beside it (the river climbs, lint river-uphill). Carving lowers each land cell of a
  // river that stands above the lowest land cell upstream of it on that river to that height,
  // so land heights never rise downstream; nothing else moves (water is skipped, as lint does;
  // nothing goes below 20, so no land becomes water). A pack cell shares its height with its
  // grid cell (and the coastline refinement cells of that grid cell), so they go down together;
  // that and confluences (a tributary's last cell is on its parent) can make another river climb,
  // so the passes repeat until none does. Heights only go down, so it ends.

  /** The live rivers with a course (two cells or more). */
  const riverCourses = () =>
    (pack.rivers || []).filter(r => isLive(r) && Array.isArray(r.cells) && r.cells.length >= 2);

  /** How a course climbs: {max: its largest rise over the lowest land upstream, at: the cells that rise}. */
  function riseOf(cells, H, skip = null) {
    let mn = Infinity;
    let max = 0;
    const at = [];
    for (const c of cells) {
      if (!(c >= 0) || H[c] < 20 || skip?.(c)) continue;
      if (H[c] > mn) {
        max = Math.max(max, H[c] - mn);
        at.push(c);
      }
      mn = Math.min(mn, H[c]);
    }
    return { max, at };
  }

  /** The rivers whose land heights rise downstream (any rise). */
  function climbing() {
    const H = pack.cells.h;
    return riverCourses()
      .filter(r => riseOf(r.cells, H).max > 0)
      .map(r => r.i);
  }

  /** Map river id -> riseOf its course (every live river with a course). */
  function rises() {
    const H = pack.cells.h;
    return new Map(riverCourses().map(r => [r.i, riseOf(r.cells, H)]));
  }

  /**
   * Lower river cells so no river climbs (only: a Set of the river ids to carve, default all);
   * returns {rivers, cells, maxDrop, lowered: Map(pack cell -> old height)}.
   * opts (a heightmap rebuild; regrid passes none): skipGrid, a Set of grid cells treated as
   * water (never lowered, not counted as the lowest land upstream); protect: a river outside
   * `only` is never made to climb (a cell it shares, or a cell of the same grid cell, goes no
   * lower than its highest land downstream of it; the carved river may climb there then); acc
   * (an object, reused across calls): the result counts every call that shared it; the result
   * adds perRiver: Map(id -> {cells, maxDrop}).
   */
  function carve(only = null, opts = null) {
    const C = pack.cells;
    const H = C.h;
    const gh = grid.cells.h;
    const siblings = new Map(); // grid cell -> its pack cells
    for (const i of C.i) {
      const g = C.g[i];
      const a = siblings.get(g);
      if (a) a.push(i);
      else siblings.set(g, [i]);
    }
    const skipGrid = opts?.skipGrid?.size ? opts.skipGrid : null;
    const skip = skipGrid ? c => skipGrid.has(C.g[c]) : null;
    // protect: pack cell -> [[river cells, index]] of the rivers outside `only`
    const kept = opts?.protect && only ? new Map() : null;
    if (kept)
      for (const r of riverCourses()) {
        if (only.has(r.i)) continue;
        r.cells.forEach((c, k) => {
          if (!(c >= 0)) return;
          const a = kept.get(c);
          if (a) a.push([r.cells, k]);
          else kept.set(c, [[r.cells, k]]);
        });
      }
    const floorOf = g => {
      let f = 0;
      for (const s of siblings.get(g) || [])
        for (const [cs, k] of kept.get(s) || [])
          for (let j = k + 1; j < cs.length; j++) {
            const x = cs[j];
            if (x >= 0 && H[x] >= 20 && !skip?.(x)) f = Math.max(f, H[x]);
          }
      return f;
    };
    const acc = opts?.acc || {};
    if (opts && !acc.lowered) Object.assign(acc, { lowered: new Map(), rivers: new Set(), sets: new Map() });
    const lowered = opts ? acc.lowered : new Map();
    const carvedRivers = opts ? acc.rivers : new Set();
    const sets = opts ? acc.sets : null; // river id -> the cells its carve lowered
    const lower = (c, v, id) => {
      const g = C.g[c];
      if (kept) v = Math.max(v, floorOf(g));
      if (H[c] <= v) return false;
      for (const s of siblings.get(g) || [c]) {
        if (H[s] < 20 || H[s] <= v) continue;
        if (!lowered.has(s)) lowered.set(s, H[s]);
        if (sets) {
          const e = sets.get(id) || new Set();
          e.add(s);
          sets.set(id, e);
        }
        H[s] = v;
      }
      if (gh[g] > v) gh[g] = v;
      return true;
    };
    const rivers = riverCourses().filter(r => !only || only.has(r.i));
    for (let pass = 0; pass < 50; pass++) {
      let changed = false;
      for (const r of rivers) {
        let mn = Infinity;
        for (const c of r.cells) {
          if (!(c >= 0) || H[c] < 20 || skip?.(c)) continue;
          if (H[c] > mn) {
            if (opts) {
              if (lower(c, Math.max(20, mn), r.i)) {
                carvedRivers.add(r.i);
                changed = true;
              }
            } else {
              lower(c, Math.max(20, mn));
              carvedRivers.add(r.i);
              changed = true;
            }
          }
          mn = Math.min(mn, H[c]);
        }
      }
      if (!changed) break;
    }
    let maxDrop = 0;
    for (const [c, h0] of lowered) maxDrop = Math.max(maxDrop, h0 - H[c]);
    const perRiver = sets ? new Map() : null;
    if (sets)
      for (const [id, set] of sets) {
        let d = 0;
        for (const c of set) d = Math.max(d, lowered.get(c) - H[c]);
        perRiver.set(id, { cells: set.size, maxDrop: d });
      }
    if (lowered.size && typeof calculateTemperatures === "function") {
      // the lowered cells are warmer now (the biomes, re-derived next, read it)
      const old = grid.cells.temp;
      calculateTemperatures();
      const fresh = grid.cells.temp;
      grid.cells.temp = old;
      for (const c of lowered.keys()) old[C.g[c]] = fresh[C.g[c]];
    }
    const out = { rivers: carvedRivers.size, cells: lowered.size, maxDrop, lowered };
    if (perRiver) out.perRiver = perRiver;
    return out;
  }

  /**
   * A heightmap rebuild's dry run (before anything changes): the rivers retrace() would remove
   * as under water, by its rule (no cell of the river's line on land, by grid cell; a river
   * without a line: under two land cells), and how many lose some of their land. landAfter(g): grid cell g is
   * land after the change (a burg's cell set to water stays land: the caller says so).
   * Returns {underWater: ids, partly: count}.
   */
  function preview(landAfter) {
    const C = pack.cells;
    const underWater = [];
    let partly = 0;
    for (const r of pack.rivers || []) {
      if (!isLive(r) || !Array.isArray(r.cells)) continue;
      const land = r.cells.filter(c => c >= 0 && landAfter(C.g[c]));
      let ok = r.cells.length >= 2;
      if (ok)
        try {
          const pts =
            typeof Rivers?.getRiverPoints === "function"
              ? Rivers.getRiverPoints(r.cells, r.points ?? null)
              : r.points || r.cells.map(c => C.p[c]);
          ok = pts?.length === r.cells.length && !pts.some(q => !q || !Number.isFinite(q[0]) || !Number.isFinite(q[1]));
        } catch {
          ok = false;
        }
      // a river with a line (capture's): under water when none of its cells' grid cells is land;
      // without one: under two land cells
      if (ok ? !land.length : new Set(land).size < 2) underWater.push(r.i);
      else if (r.cells.some(c => c >= 0 && C.h[c] >= 20 && !landAfter(C.g[c]))) partly++;
    }
    return { underWater, partly };
  }

  /** After the features are restored: a lake whose shore was carved below its level follows it down. */
  function lowerLakes(lowered) {
    let n = 0;
    for (const f of pack.features || []) {
      if (!f || f.type !== "lake" || !Array.isArray(f.shoreline) || !f.shoreline.some(c => lowered.has(c))) continue;
      try {
        const lvl = Lakes.getHeight(f);
        if (typeof f.height !== "number" || lvl < f.height) {
          f.height = lvl;
          n++;
        }
      } catch {}
    }
    return n;
  }

  T.riverTrace = { capture, retrace, carve, climbing, rises, riseOf, lowerLakes, preview };
})(globalThis);
