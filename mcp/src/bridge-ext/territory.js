// Tupaia MCP bridge extension 'territory': regrow existing territories along the terrain.
// Classic script injected after bridge.js and bridge-mutations.js (every src/bridge-ext/*.js in
// name order); same rules: app globals by bare name at call time, no locals that shadow app
// globals (cells, grid, pack, states, provinces, ...), one args object per function.
//
// Used by regrid {territories:'regrow'} (cultures, religions and states, then provinces, after
// the cell-by-cell copy, so the old stepped outlines do not survive on the finer grid) and by
// regenerate provinces {regrow:true} (each province keeps its id, name, capital and emblem and
// about its size; its borders follow the terrain). The engine is a cost-based multi-source
// spread like the app's States/Cultures/Religions expand (terrain, biome, height, river costs;
// land only): each entity's interior (its cells further than `band` rings from a border) and its
// pinned cells (burgs, capitals, centres) stay; the band along the borders is spread again from
// them, with a per-entity start offset adjusted over a few rounds so every entity ends close to
// its target area (its current one). Locked entities keep their cells; a burg's cell keeps its
// owner. The outcome is literal (cells per province), so a regrow replays in a sketch.
(root => {
  const T = root.__tupaia;
  if (!T) return;
  const live = x => !!x && typeof x === "object" && !!x.i && !x.removed;
  const rn = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  // ---------------------------------------------------------------- cost model

  function hash(i, j, s) {
    let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  }
  function vnoise(x, y, s) {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const a = hash(i, j, s);
    const b = hash(i + 1, j, s);
    const c = hash(i, j + 1, s);
    const d = hash(i + 1, j + 1, s);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }

  /** The cell spacing of a 10K map of this size: the length unit of the costs (density-free). */
  const unit = () => Math.sqrt((graphWidth * graphHeight) / 1e4);
  const SEEDS = { culture: 23, religion: 37, state: 11, province: 51 };

  /**
   * Step cost from cell c to its neighbour j for an entity of `field` with id l: the distance,
   * raised on slopes, hills, mountains and costly biomes (biomesData.cost, as the app's expand),
   * with a deterministic value noise (no straight bisectors); a climb and entering a river cost
   * extra (borders settle on ridges and rivers). A state crossing into land of another culture
   * than its own pays more (borders follow the cultures, regrown first).
   */
  function makeCost(field) {
    const C = pack.cells;
    const U = unit();
    const bc = (typeof biomesData !== "undefined" && biomesData?.cost) || [];
    const seed = SEEDS[field] ?? 7;
    const n = C.i.length;
    const nz = new Float32Array(n);
    const ns = 1.5 * U;
    for (let c = 0; c < n; c++) nz[c] = 0.85 + 0.3 * vnoise(C.p[c][0] / ns, C.p[c][1] / ns, seed);
    const stateCulture =
      field === "state" ? pack.states.map(s => (s && typeof s === "object" ? s.culture || 0 : 0)) : null;
    return (c, j, l) => {
      const d = Math.hypot(C.p[j][0] - C.p[c][0], C.p[j][1] - C.p[c][1]);
      const h = C.h[j];
      const dh = h - C.h[c];
      let f = (1 + 0.03 * Math.abs(dh)) * nz[j];
      if (h >= 67) f *= 3;
      else if (h >= 44) f *= 1.5;
      const b = bc[C.biome[j]];
      if (b > 0) f *= 1 + Math.min(b, 400) / 400;
      if (stateCulture && l > 0 && stateCulture[l] && C.culture[j] !== stateCulture[l]) f *= 1.3;
      let w = d * f + 0.2 * U * Math.max(0, dh);
      if (C.r[j] && C.r[j] !== C.r[c]) w += U * Math.min(5, Math.max(1, (C.fl[j] || 0) / 200));
      return w;
    };
  }

  // ---------------------------------------------------------------- the engine

  /**
   * Regrow labels over `domain` (Uint8Array, 1 = may change). cur: Int32Array, the current label
   * of each domain cell (-1 = none: to fill). pins: Map cell -> label (stays). band: rings along
   * the borders that are spread again (cells deeper inside keep their label). targets: Map
   * label -> area (default: the current area). cost: (c, j, label) -> step cost.
   * Returns {label (Int32Array), size (Map label -> area), worst (max relative size error of
   * labels over ~8 cells), rounds, bandCells}.
   */
  function grow(o) {
    const C = pack.cells;
    const n = C.i.length;
    const { domain, cur, pins, cost } = o;
    const band = Math.max(1, o.band | 0);
    const area = o.cells ? () => 1 : c => Math.max(1, C.area[c] || 0); // weight: cells or area
    // rings to a border (a domain neighbour with another label, or a cell to fill)
    const ring = new Int16Array(n).fill(-1);
    let front = [];
    for (let c = 0; c < n; c++) {
      if (!domain[c]) continue;
      if (cur[c] < 0) {
        ring[c] = 0;
        front.push(c);
        continue;
      }
      for (const j of C.c[c])
        if (domain[j] && cur[j] !== cur[c]) {
          ring[c] = 0;
          front.push(c);
          break;
        }
    }
    for (let r = 1; r < band && front.length; r++) {
      const next = [];
      for (const c of front)
        for (const j of C.c[c])
          if (domain[j] && ring[j] < 0) {
            ring[j] = r;
            next.push(j);
          }
      front = next;
    }
    const free = new Uint8Array(n);
    const fixed = new Int32Array(n).fill(-1);
    let bandCells = 0;
    for (let c = 0; c < n; c++) {
      if (!domain[c]) continue;
      if (pins.has(c)) fixed[c] = pins.get(c);
      else if (ring[c] >= 0) {
        free[c] = 1;
        bandCells++;
      } else fixed[c] = cur[c];
    }
    // the skeleton stays too: a band cell at least as deep as every neighbour of its label (the
    // middle line of an arm or strip narrower than the band), so a thin entity keeps its shape
    // and only its edges move (a step of the old grid is not a skeleton: it deepens toward the body)
    // Only for labels with an interior: a small or thin label with none (all band) regrows
    // whole from its pins (burgs, capital, centre) and its deepest cell
    const deepLabel = new Set();
    for (let c = 0; c < n; c++) if (domain[c] && ring[c] < 0 && cur[c] >= 0) deepLabel.add(cur[c]);
    if (o.skeleton !== false)
      for (let c = 0; c < n; c++) {
        if (!free[c] || cur[c] < 0 || !deepLabel.has(cur[c])) continue;
        let top = true;
        for (const j of C.c[c])
          if (domain[j] && cur[j] === cur[c] && (ring[j] < 0 || ring[j] > ring[c])) {
            top = false;
            break;
          }
        if (!top) continue;
        free[c] = 0;
        fixed[c] = cur[c];
        bandCells--;
      }
    // every connected piece of a label (an exclave, an island part, a thin entity) with no fixed
    // cell keeps its deepest cell, so the spread cannot take it whole
    const seen = new Uint8Array(n);
    const anchors = new Set();
    for (let c0 = 0; c0 < n; c0++) {
      if (!free[c0] || seen[c0] || cur[c0] < 0) continue;
      const l = cur[c0];
      const stack = [c0];
      seen[c0] = 1;
      let deep = c0;
      let anchored = false;
      while (stack.length) {
        const c = stack.pop();
        if (ring[c] > ring[deep]) deep = c;
        for (const j of C.c[c]) {
          if (!domain[j] || cur[j] !== l) continue;
          if (fixed[j] === l) anchored = true;
          if (free[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
      if (anchored) continue;
      free[deep] = 0;
      fixed[deep] = l;
      anchors.add(deep);
      bandCells--;
    }
    // the spread starts from the fixed cells next to the band
    let frontier;
    let frontCount;
    let fixedArea;
    let freeList;
    let freeArea;
    function prep() {
      frontier = [];
      frontCount = new Map();
      fixedArea = new Map();
      for (let c = 0; c < n; c++) {
        if (fixed[c] < 0) continue;
        fixedArea.set(fixed[c], (fixedArea.get(fixed[c]) || 0) + area(c));
        if (C.c[c].some(j => free[j])) {
          frontier.push(c);
          frontCount.set(fixed[c], (frontCount.get(fixed[c]) || 0) + 1);
        }
      }
      freeList = [];
      freeArea = 0;
      for (let c = 0; c < n; c++)
        if (free[c]) {
          freeList.push(c);
          freeArea += area(c);
        }
    }
    prep();
    let targets = o.targets;
    if (!targets) {
      targets = new Map();
      for (let c = 0; c < n; c++)
        if (domain[c] && cur[c] >= 0) targets.set(cur[c], (targets.get(cur[c]) || 0) + area(c));
    }
    // mean step cost and cell area (the size controller's scale)
    let stepSum = 0;
    let stepN = 0;
    for (let k = 0; k < freeList.length && stepN < 4000; k += 1 + (freeList.length >> 12)) {
      const c = freeList[k];
      const j = C.c[c].find(x => domain[x]);
      if (j === undefined) continue;
      stepSum += cost(c, j, -1);
      stepN++;
    }
    const meanStep = stepN ? stepSum / stepN : unit();
    const meanArea = freeList.length ? freeArea / freeList.length : 1;

    // The spread: one queue of (cell, label) steps by cost; a band cell goes to the first label
    // that reaches it with room left (its target minus its area so far: a full label stops
    // growing and its neighbours take the rest). A label's offset delays (+) or advances (-) its
    // whole front; under-filled labels are advanced over a few rounds.
    const own = new Int32Array(n);
    function spread(offset) {
      own.fill(-1);
      const room = new Map();
      for (const [l, t] of targets) room.set(l, t - (fixedArea.get(l) || 0));
      const roomOf = l => (room.has(l) ? room.get(l) : Infinity);
      const q = new FlatQueue();
      const cellOf = [];
      const labOf = [];
      let k = 0;
      const push = (c, l, t) => {
        cellOf[k] = c;
        labOf[k] = l;
        q.push(k++, t);
      };
      for (const c of frontier) {
        const l = fixed[c];
        const o0 = offset.get(l) || 0;
        for (const j of C.c[c]) if (free[j]) push(j, l, o0 + cost(c, j, l));
      }
      while (q.length) {
        const d = q.peekValue();
        const e = q.pop();
        const c = cellOf[e];
        if (own[c] >= 0) continue;
        const l = labOf[e];
        const left = roomOf(l);
        if (left <= 0) continue; // full: another label takes it
        own[c] = l;
        room.set(l, left - area(c));
        for (const j of C.c[c]) if (free[j] && own[j] < 0) push(j, l, d + cost(c, j, l));
      }
      // pockets shut in by full labels: shared out by cost from the labels around them, as a
      // spread without targets (so one small label next to a pocket does not take it all)
      const labelAt = c => (fixed[c] >= 0 ? fixed[c] : own[c]);
      const pocket = freeList.filter(c => own[c] < 0);
      if (pocket.length) {
        const pq = new FlatQueue();
        const pb = new Map();
        for (const c of pocket)
          for (const j of C.c[c]) {
            if (!domain[j] || labelAt(j) < 0) continue;
            const l = labelAt(j);
            const t = cost(j, c, l);
            if (t < (pb.get(c)?.[0] ?? Infinity)) {
              pb.set(c, [t, l]);
              pq.push(c, t);
            }
          }
        while (pq.length) {
          const d = pq.peekValue();
          const c = pq.pop();
          if (own[c] >= 0 || d > pb.get(c)[0]) continue;
          const l = pb.get(c)[1];
          own[c] = l;
          room.set(l, roomOf(l) - area(c));
          for (const j of C.c[c]) {
            if (!free[j] || own[j] >= 0) continue;
            const t = d + cost(c, j, l);
            if (t < (pb.get(j)?.[0] ?? Infinity)) {
              pb.set(j, [t, l]);
              pq.push(j, t);
            }
          }
        }
      }
      const out = new Int32Array(n).fill(-1);
      for (let c = 0; c < n; c++) {
        if (!domain[c]) continue;
        if (fixed[c] >= 0) out[c] = fixed[c];
        else out[c] = own[c] >= 0 ? own[c] : cur[c];
      }
      return out;
    }
    const sizeOf = lab => {
      const s = new Map();
      for (let c = 0; c < n; c++) if (domain[c] && lab[c] >= 0) s.set(lab[c], (s.get(lab[c]) || 0) + area(c));
      return s;
    };
    const big = 8 * meanArea;
    const rounds = o.rounds ?? 20;
    const tol = o.tolerance ?? 0.03;
    const lim = (band + 2) * meanStep * 4;
    function control() {
      const offset = new Map();
      let pick = null;
      let r = 0;
      for (; r < rounds; r++) {
        const lab = spread(offset);
        const size = sizeOf(lab);
        let worst = 0;
        let sum = 0;
        let tot = 0;
        for (const [l, t] of targets) {
          const e = Math.max(0, Math.abs((size.get(l) || 0) - t) - meanArea); // one cell is no error
          sum += e;
          tot += t;
          if (t >= big) worst = Math.max(worst, e / t);
        }
        const score = worst + (tot ? (0.5 * sum) / tot : 0);
        if (o.trace)
          o.trace.push({
            r,
            worst: rn(worst, 3),
            score: rn(score, 3),
            off: [...targets]
              .filter(([l, t]) => t >= big && Math.abs((size.get(l) || 0) - t) > 0.15 * t)
              .map(([l, t]) => [l, rn(size.get(l) || 0), rn(t), rn(fixedArea.get(l) || 0), rn(offset.get(l) || 0)])
          });
        if (!pick || score < pick.score) pick = { lab, size, worst, score };
        if (worst <= tol || !freeList.length) break;
        // border cells per label in the band: how fast its area answers its offset
        const edge = new Map();
        for (const c of freeList)
          if (C.c[c].some(j => domain[j] && lab[j] !== lab[c])) edge.set(lab[c], (edge.get(lab[c]) || 0) + 1);
        for (const [l, t] of targets) {
          if (!frontCount.get(l)) continue;
          const deficit = t - (size.get(l) || 0);
          if (deficit <= Math.max(meanArea, tol * t)) continue;
          const perim = Math.max(1, edge.get(l) || 0);
          const delta = (2 * meanStep * deficit) / (perim * meanArea);
          offset.set(l, Math.max(-lim, (offset.get(l) || 0) - delta));
        }
      }
      return { pick, r };
    }
    let { pick, r } = control();
    let lab = pick.lab;
    let size = sizeOf(lab);
    const tgt = l => (targets.has(l) ? targets.get(l) : Infinity);
    // smoothing: a band cell joins a neighbouring label when the border then cuts dearer edges
    // (ridges, rivers, slopes) or fewer of them: cutting edge (c, j) costs meanStep / w(c, j).
    // Both labels stay near their targets, and no label is cut in two around the cell.
    const cutW = new Map();
    const cut = (c, j) => {
      const key = c < j ? c * n + j : j * n + c;
      let g = cutW.get(key);
      if (g === undefined) {
        g = meanStep / Math.max(1e-6, (cost(c, j, -1) + cost(j, c, -1)) / 2);
        cutW.set(key, g);
      }
      return g;
    };
    const slack = l => Math.max(4 * tol * tgt(l), 2 * meanArea);
    const splits = (c, l) => {
      const same = C.c[c].filter(j => domain[j] && lab[j] === l);
      if (same.length < 2) return false;
      const seen = new Set([same[0]]);
      const stack = [same[0]];
      while (stack.length) {
        const x = stack.pop();
        for (const y of same) if (!seen.has(y) && C.c[x].includes(y)) seen.add(y) && stack.push(y);
      }
      return seen.size < same.length;
    };
    const smooth = () => {
      for (let pass = 0; pass < 6; pass++) {
        let moved = 0;
        for (const c of freeList) {
          const l = lab[c];
          const gain = new Map();
          for (const j of C.c[c]) if (domain[j] && lab[j] >= 0) gain.set(lab[j], (gain.get(lab[j]) || 0) + cut(c, j));
          const mine = gain.get(l) || 0;
          let bm = -1;
          let bg = mine * 1.05 + 1e-9;
          for (const [m, g] of gain) if (m !== l && g > bg) [bm, bg] = [m, g];
          if (bm < 0) continue;
          const a = area(c);
          if (l >= 0 && mine > 0) {
            if ((size.get(l) || 0) - a < tgt(l) - slack(l)) continue;
            if ((size.get(bm) || 0) + a > tgt(bm) + slack(bm)) continue;
            if (splits(c, l)) continue;
          }
          lab[c] = bm;
          if (l >= 0) size.set(l, (size.get(l) || 0) - a);
          size.set(bm, (size.get(bm) || 0) + a);
          moved++;
        }
        if (!moved) break;
      }
    };
    smooth();
    // stubs: a one- or two-cell piece of a label with no pin or exclave anchor (a
    // skeleton or interior cell the spread went around) joins the label around it
    const holds = new Uint8Array(n);
    for (let c = 0; c < n; c++) if (domain[c] && fixed[c] >= 0 && (pins.has(c) || anchors.has(c))) holds[c] = 1;
    const findStubs = () => {
      const comp = new Int32Array(n).fill(-1);
      const stub = [];
      for (let c0 = 0; c0 < n; c0++) {
        if (!domain[c0] || comp[c0] >= 0 || lab[c0] < 0) continue;
        const l = lab[c0];
        const cells = [c0];
        comp[c0] = c0;
        let held = false;
        for (let k = 0; k < cells.length; k++) {
          const c = cells[k];
          if (holds[c] && fixed[c] === l) held = true;
          for (const j of C.c[c])
            if (domain[j] && comp[j] < 0 && lab[j] === l) {
              comp[j] = c0;
              cells.push(j);
            }
        }
        if (!held && cells.length <= 2) for (const c of cells) stub.push(c);
      }
      return stub;
    };
    // a fixed cell (skeleton or interior) left in such a piece was a poor seed: the spread runs
    // once more with it in the band
    const unseed = findStubs().filter(c => fixed[c] >= 0 && !holds[c]);
    if (unseed.length) {
      for (const c of unseed) {
        free[c] = 1;
        fixed[c] = -1;
        bandCells++;
      }
      prep();
      ({ pick, r } = control());
      lab = pick.lab;
      size = sizeOf(lab);
      smooth();
    }
    const unstub = () => {
      for (let pass = 0, todo = findStubs(); pass < 50 && todo.length; pass++) {
        const next = [];
        const set = new Set(todo);
        for (const c of todo) {
          const cnt = new Map();
          for (const j of C.c[c])
            if (domain[j] && lab[j] >= 0 && lab[j] !== lab[c] && !set.has(j))
              cnt.set(lab[j], (cnt.get(lab[j]) || 0) + 1);
          let bl = -1;
          let bn = 0;
          for (const [l, k] of cnt) if (k > bn) [bl, bn] = [l, k];
          if (bl >= 0) {
            lab[c] = bl;
            set.delete(c);
          } else next.push(c);
        }
        todo = next;
      }
      for (const [l, a] of sizeOf(lab)) size.set(l, a);
    };
    unstub();
    // balance: a band cell of a label over its target, on the border with one under it, changes
    // sides (where it already touches two cells of the other; a few passes)
    for (let pass = 0; pass < 4; pass++) {
      let moved = 0;
      for (const c of freeList) {
        const l = lab[c];
        if (l < 0 || size.get(l) - tgt(l) < area(c)) continue;
        const cnt = new Map();
        for (const j of C.c[c])
          if (domain[j] && lab[j] >= 0 && lab[j] !== l) cnt.set(lab[j], (cnt.get(lab[j]) || 0) + 1);
        let bm = -1;
        let bd = 0;
        for (const [m, k] of cnt) {
          const d = tgt(m) - (size.get(m) || 0);
          if (k >= 2 && d >= area(c) && d > bd) [bm, bd] = [m, d];
        }
        if (bm < 0) continue;
        // not where it would cut off a neighbour of its own label (no new one-cell pieces)
        if (C.c[c].some(j => domain[j] && lab[j] === l && !C.c[j].some(x => x !== c && domain[x] && lab[x] === l)))
          continue;
        lab[c] = bm;
        size.set(l, size.get(l) - area(c));
        size.set(bm, (size.get(bm) || 0) + area(c));
        moved++;
      }
      if (!moved) break;
    }
    unstub(); // pieces the balance cut off
    // cells to fill that the spread did not reach (cut off from every label inside the domain):
    // the label of the nearest labelled domain cell
    const left = [];
    const pts = [];
    for (let c = 0; c < n; c++) {
      if (!domain[c]) continue;
      if (lab[c] < 0) left.push(c);
      else pts.push([C.p[c][0], C.p[c][1], lab[c]]);
    }
    if (left.length && pts.length) {
      const qt = d3.quadtree(
        pts,
        p => p[0],
        p => p[1]
      );
      for (const c of left) lab[c] = qt.find(C.p[c][0], C.p[c][1])[2];
    }
    return {
      label: lab,
      size: sizeOf(lab),
      targets,
      worst: pick.worst,
      rounds: r + 1,
      bandCells
    };
  }

  // ---------------------------------------------------------------- cultures, religions, states

  const LISTS = {
    culture: "cultures",
    religion: "religions",
    state: "states",
    province: "provinces"
  };

  /** Is id a live entity of the list (0 is the "none" entity: Neutrals, Wildlands, No religion). */
  const known = (list, id) => Number.isInteger(id) && (id === 0 || live(pack[list][id]));

  /**
   * Regrow one of culture / religion / state over the land, in place. Pins: each burg's cell (its
   * burg's state and culture; its current religion), every centre inside its own territory, a
   * state's capital; for states also a province's centre (its state) and every cell of a locked
   * province (so provinces stay inside their states). Locked entities keep their cells.
   */
  function regrowField(field, band, trace, withLocked = false) {
    const C = pack.cells;
    const arr = C[field];
    const listName = LISTS[field];
    const list = pack[listName];
    const n = C.i.length;
    if (!arr || !Array.isArray(list)) return null;
    const locked = l => !withLocked && l > 0 && !!list[l]?.lock;
    const domain = new Uint8Array(n);
    const cur = new Int32Array(n).fill(-1);
    for (let c = 0; c < n; c++)
      if (C.h[c] >= 20 && !locked(arr[c])) {
        domain[c] = 1;
        cur[c] = arr[c];
      }
    const pins = new Map();
    const pin = (c, l) => {
      if (Number.isInteger(c) && c >= 0 && c < n && domain[c] && known(listName, l) && !locked(l)) pins.set(c, l);
    };
    for (const e of list) if (live(e) && !locked(e.i) && arr[e.center] === e.i) pin(e.center, e.i);
    if (field === "state") {
      const lockedProv = new Set();
      for (const p of pack.provinces || []) {
        if (!live(p)) continue;
        if (arr[p.center] === p.state) pin(p.center, p.state);
        if (p.lock && !withLocked) lockedProv.add(p.i);
      }
      if (lockedProv.size && C.province) for (let c = 0; c < n; c++) if (lockedProv.has(C.province[c])) pin(c, arr[c]);
      for (const s of list)
        if (live(s) && !locked(s.i) && live(pack.burgs[s.capital])) pin(pack.burgs[s.capital].cell, s.i);
    }
    const burgOwner = new Map();
    for (const b of pack.burgs) {
      if (!live(b) || !Number.isInteger(b.cell)) continue;
      let v = arr[b.cell];
      if (field === "state" && known(listName, b.state)) v = b.state;
      if (field === "culture" && known(listName, b.culture)) v = b.culture;
      pin(b.cell, v);
      burgOwner.set(b.i, v);
    }
    const before = new Map();
    const cellsBefore = new Map();
    for (let c = 0; c < n; c++)
      if (domain[c]) {
        before.set(cur[c], (before.get(cur[c]) || 0) + Math.max(1, C.area[c] || 0));
        cellsBefore.set(cur[c], (cellsBefore.get(cur[c]) || 0) + 1);
      }
    const res = grow({ domain, cur, pins, band, cost: makeCost(field), trace });
    let changed = 0;
    const cellsAfter = new Map();
    for (let c = 0; c < n; c++) {
      if (!domain[c] || res.label[c] < 0) continue;
      if (arr[c] !== res.label[c]) changed++;
      arr[c] = res.label[c];
      cellsAfter.set(arr[c], (cellsAfter.get(arr[c]) || 0) + 1);
    }
    let maxPct = 0;
    let maxOf = null;
    for (const [l, a] of before) {
      if (!l || (cellsBefore.get(l) || 0) < 20) continue; // a cell or two of a small one is no measure
      const pct = (100 * ((res.size.get(l) || 0) - a)) / a;
      if (Math.abs(pct) > Math.abs(maxPct)) {
        maxPct = pct;
        maxOf = `${list[l]?.name ?? field} (${l})`;
      }
    }
    let burgsOff = 0;
    for (const [bi, v] of burgOwner) if (arr[pack.burgs[bi].cell] !== v) burgsOff++;
    return {
      changed,
      bandCells: res.bandCells,
      rounds: res.rounds,
      maxAreaChangePct: rn(maxPct),
      ...(maxOf ? { maxAreaChangeOf: maxOf } : {}),
      ...(burgsOff ? { burgsOff } : {})
    };
  }

  // ---------------------------------------------------------------- provinces

  /**
   * Regrow the provinces of `states` inside each state, on `work` (a copy of cells.province,
   * changed in place). Each province keeps its id; its centre, its capital's cell and the cells
   * of its burgs stay; a cell of the state in no province of it (or another state's) is filled.
   * Size target: the current area, scaled so the targets cover the state's land. Provinces in
   * `keep` (locked) keep their cells. Returns rows {i, state, before, after} (cells).
   */
  function regrowProvinces({ states, band, keep, work, basis = null, trace = null }) {
    const C = pack.cells;
    const n = C.i.length;
    const rows = [];
    let filled = 0;
    let rounds = 0;
    let worst = 0;
    const cost = makeCost("province");
    const byState = new Map(states.map(s => [s, []]));
    for (const p of pack.provinces) if (live(p) && byState.has(p.state) && !keep.has(p.i)) byState.get(p.state).push(p);
    const burgsIn = new Map();
    for (const b of pack.burgs) if (live(b) && Number.isInteger(b.cell)) burgsIn.set(b.cell, b);
    for (const [sid, provs] of byState) {
      if (!provs.length) continue;
      const ids = new Set(provs.map(p => p.i));
      const domain = new Uint8Array(n);
      const cur = new Int32Array(n).fill(-1);
      let any = false;
      for (let c = 0; c < n; c++) {
        if (C.state[c] !== sid || C.h[c] < 20 || keep.has(work[c])) continue;
        domain[c] = 1;
        any = true;
        if (ids.has(work[c])) cur[c] = work[c];
        else filled++;
      }
      if (!any) continue;
      const pins = new Map();
      for (const c of burgsIn.keys()) if (domain[c] && cur[c] >= 0) pins.set(c, cur[c]);
      for (const p of provs) {
        if (domain[p.center]) pins.set(p.center, p.i);
        const cap = p.burg ? pack.burgs[p.burg] : null;
        if (live(cap) && domain[cap.cell]) pins.set(cap.cell, p.i);
      }
      // targets: the current areas, scaled to cover the state's land (cells to fill included)
      const cnt = new Map(provs.map(p => [p.i, 0]));
      const ar = new Map(provs.map(p => [p.i, 0]));
      let dom = 0;
      let sum = 0;
      for (let c = 0; c < n; c++) {
        if (!domain[c]) continue;
        const a = 1; // provinces: sizes in cells (as the editors and the result report them)
        dom += a;
        if (cur[c] >= 0) {
          cnt.set(cur[c], cnt.get(cur[c]) + 1);
          ar.set(cur[c], ar.get(cur[c]) + a);
          sum += a;
        }
      }
      // basis (regrid): the sizes before the states regrew, so a province is not shrunk twice
      if (basis) {
        sum = 0;
        for (const p of provs) {
          ar.set(p.i, ar.get(p.i) > 0 ? basis.get(p.i) || 0 : 0);
          sum += ar.get(p.i);
        }
      }
      const k = sum ? dom / sum : 1;
      const targets = new Map([...ar].filter(([, a]) => a > 0).map(([i, a]) => [i, a * k]));
      const res = grow({ domain, cur, pins, band, targets, cost, cells: true, trace: trace?.[sid] });
      rounds = Math.max(rounds, res.rounds);
      worst = Math.max(worst, res.worst);
      const after = new Map(provs.map(p => [p.i, 0]));
      for (let c = 0; c < n; c++) {
        if (!domain[c] || res.label[c] < 0) continue;
        work[c] = res.label[c];
        after.set(work[c], (after.get(work[c]) || 0) + 1);
      }
      for (const p of provs)
        rows.push({
          i: p.i,
          state: sid,
          before: cnt.get(p.i),
          after: after.get(p.i) || 0
        });
    }
    return { rows, filled, rounds, worst };
  }

  /** Signed % change of a row. */
  const pctOf = r => (r.before ? rn((100 * (r.after - r.before)) / r.before) : r.after ? 100 : 0);

  /** Compact size report: the rows with the largest relative change first (at most `max`). */
  function sizeReport(rows, max = 40) {
    const sorted = rows
      .map(r => ({ ...r, pct: pctOf(r) }))
      .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct) || a.i - b.i);
    const big = sorted.filter(r => r.before >= 8); // smaller ones swing by a cell or two
    const top = big[0];
    const within15 = big.filter(r => Math.abs(r.pct) <= 15).length;
    return {
      maxChangePct: top ? top.pct : 0,
      ...(top
        ? {
            maxChangeOf: `${pack.provinces[top.i]?.name ?? "province"} (${top.i})`
          }
        : {}),
      within15pct: `${within15}/${big.length}`,
      sizes: sorted.slice(0, max).map(r => [r.i, r.before, r.after]),
      ...(sorted.length > max ? { sizesMore: sorted.length - max } : {})
    };
  }

  // ---------------------------------------------------------------- regrid: everything

  /**
   * After the regrid copied the territories cell by cell: cultures, religions and states regrow
   * along the terrain from their cores (band rings), then every state's provinces inside it.
   * Returns the report for the regrid result (territories).
   */
  function regrowAll({ band, withLocked = false }) {
    const C = pack.cells;
    const n = C.i.length;
    const stateBefore = Uint16Array.from(C.state);
    const provBefore = new Map();
    if (C.province)
      for (let c = 0; c < n; c++)
        if (C.h[c] >= 20) provBefore.set(C.province[c], (provBefore.get(C.province[c]) || 0) + 1);
    const out = { mode: "regrow", band };
    for (const field of ["culture", "religion", "state"]) {
      const r = regrowField(field, band, null, withLocked);
      if (r) out[field] = r;
    }
    if (C.province && Array.isArray(pack.provinces)) {
      const keep = new Set(withLocked ? [] : pack.provinces.filter(p => live(p) && p.lock).map(p => p.i));
      const work = Uint16Array.from(C.province);
      // cells that changed state: into neutral land or a state with no provinces, they have none
      const hasProv = new Set(pack.provinces.filter(live).map(p => p.state));
      for (let c = 0; c < n; c++)
        if (C.state[c] !== stateBefore[c] && !keep.has(work[c]) && (!C.state[c] || !hasProv.has(C.state[c])))
          work[c] = 0;
      // a locked state keeps its provinces too
      const sids = pack.states.filter(s => live(s) && hasProv.has(s.i) && (withLocked || !s.lock)).map(s => s.i);
      const pr = regrowProvinces({ states: sids, band, keep, work, basis: provBefore });
      let changed = 0;
      for (let c = 0; c < n; c++)
        if (C.province[c] !== work[c]) {
          changed++;
          C.province[c] = work[c];
        }
      const rep = sizeReport(
        pr.rows.map(r => ({ ...r, before: provBefore.get(r.i) || r.before })),
        0
      );
      out.province = {
        changed,
        maxCellsChangePct: rep.maxChangePct,
        ...(rep.maxChangeOf ? { maxCellsChangeOf: rep.maxChangeOf } : {}),
        within15pct: rep.within15pct
      };
    }
    T.resetMemo?.();
    return out;
  }

  // ---------------------------------------------------------------- regenerate provinces {regrow}

  const hashStr = (...a) => T.pure.hashStr(...a);
  function toRuns(ids) {
    const s = [...ids].sort((a, b) => a - b);
    const out = [];
    for (let k = 0; k < s.length; k++) {
      if (out.length && s[k] === out[out.length - 2] + out[out.length - 1]) out[out.length - 1]++;
      else out.push(s[k], 1);
    }
    return out;
  }
  function fromRuns(runs) {
    const out = [];
    const n = pack.cells.i.length;
    if (!Array.isArray(runs)) return out;
    for (let k = 0; k + 1 < runs.length && out.length < n; k += 2) {
      const start = runs[k];
      const len = runs[k + 1];
      if (!Number.isInteger(start) || !Number.isInteger(len) || start < 0 || len < 1) continue;
      for (let j = 0; j < len && start + j < n && out.length < n; j++) out.push(start + j);
    }
    return out;
  }
  function cellsOf(arr, ids) {
    const out = new Map([...ids].map(i => [i, []]));
    for (let c = 0; c < arr.length; c++) out.get(arr[c])?.push(c);
    return out;
  }
  const cellHash = cells => hashStr(JSON.stringify(toRuns(cells)));
  /** Cells whose province a work copy changes. */
  function changedOf(work) {
    let k = 0;
    for (let c = 0; c < work.length; c++) if (work[c] !== pack.cells.province[c]) k++;
    return k;
  }
  const DEFAULT_BAND = 4;

  /** A run (regen.js's shape) for a regrow plan; changes nothing on the map. */
  function provincesRun(plan) {
    const keep = new Set(plan.kept);
    if (!plan.keepLocked) keep.clear();
    else for (const p of pack.provinces) if (live(p) && p.lock) keep.add(p.i);
    const work = Uint16Array.from(pack.cells.province);
    const band = plan.band ?? DEFAULT_BAND;
    const ids = pack.provinces.filter(p => live(p) && plan.targets.includes(p.state) && !keep.has(p.i)).map(p => p.i);
    const was = cellsOf(pack.cells.province, ids);
    const pr = regrowProvinces({ states: plan.targets, band, keep, work });
    const sizes = new Map(pr.rows.map(r => [r.i, r.after]));
    const notes = [...plan.notes];
    const without = plan.targets.filter(sid => !pr.rows.some(r => r.state === sid));
    if (without.length)
      notes.push(
        `provinces: ${without.length} state(s) have no unlocked province to regrow (${without
          .slice(0, 4)
          .map(i => `${pack.states[i]?.name} (${i})`)
          .join(", ")}): count or centres gives them new ones`
      );
    if (pr.filled)
      notes.push(
        `provinces: ${plural(pr.filled, "cell")} of the regrown states were in no province of their state; they joined the nearest one`
      );
    return {
      regrow: {
        band,
        rows: pr.rows,
        filled: pr.filled,
        changed: changedOf(work),
        was: new Map([...was].map(([i, c]) => [i, cellHash(c)]))
      },
      targets: plan.targets,
      keepLocked: plan.keepLocked,
      lockedStates: plan.lockedStates,
      kept: plan.kept,
      replaced: [],
      replacedRows: [],
      made: [],
      work,
      modes: new Map(plan.targets.map(s => [s, "regrow"])),
      fallback: new Map(),
      unassigned: 0,
      sizes,
      shields: 0,
      fx: { emptied: [], shrunk: [], orphaned: new Map() },
      notes
    };
  }

  /** Write a regrow run: cells, then each changed province's pole (centre and capital stay). */
  function commitProvinces(run) {
    const C = pack.cells;
    const touched = new Set();
    for (let c = 0; c < run.work.length; c++)
      if (C.province[c] !== run.work[c]) {
        touched.add(C.province[c]);
        touched.add(run.work[c]);
        C.province[c] = run.work[c];
      }
    touched.delete(0);
    if (touched.size) {
      const poles = getPolesOfInaccessibility(pack, cell => C.province[cell]);
      for (const id of touched) {
        const p = pack.provinces[id];
        if (live(p)) p.pole = poles[id] || [C.p[p.center][0], C.p[p.center][1]];
      }
    }
    T.resetMemo?.();
  }

  function provincesView(run, notesOut) {
    const rows = run.regrow.rows;
    const states = run.targets.slice(0, 20).map(sid => {
      const mine = rows.filter(r => r.state === sid);
      const row = {
        i: sid,
        name: pack.states[sid]?.name,
        mode: "regrow",
        regrown: mine.length
      };
      const keep = [...run.kept].filter(id => pack.provinces[id]?.state === sid).length;
      if (keep) row.keptLocked = keep;
      return row;
    });
    if (run.targets.length > 20)
      notesOut.push(`provinces: ${run.targets.length} states regrown; the first 20 are listed`);
    const rep = sizeReport(rows);
    if (rep.sizesMore)
      notesOut.push(
        `provinces: sizes lists the ${rep.sizes.length} largest changes; find {type:'province'} has the rest`
      );
    return {
      mode: "regrow",
      band: run.regrow.band,
      regrown: rows.length,
      keptLocked: run.kept.size,
      changedCells: run.regrow.changed,
      ...rep,
      sizesLegend:
        "[province, cells before, cells after], largest relative change first; maxChangePct and within15pct count provinces of 8+ cells",
      states
    };
  }

  /** Literal outcome: every regrown province with its cells (and a hash of its cells before). */
  function provincesLiteral(run) {
    const rows = run.regrow.rows;
    const after = cellsOf(
      run.work,
      rows.map(r => r.i)
    );
    const locked = run.targets.filter(i => pack.states[i]?.lock);
    return {
      mode: "regrow",
      band: run.regrow.band,
      states: run.targets,
      names: run.targets.map(i => pack.states[i]?.name ?? null),
      keepLocked: run.keepLocked,
      ...(run.lockedStates ? { lockedStates: true } : {}),
      ...(locked.length ? { locked } : {}),
      kept: [...run.kept],
      replaced: [],
      created: [],
      regrown: rows.map(r => {
        const p = pack.provinces[r.i];
        return {
          i: r.i,
          state: r.state,
          name: p?.name ?? null,
          center: p?.center ?? null,
          was: run.regrow.was.get(r.i),
          n: after.get(r.i).length,
          runs: toRuns(after.get(r.i))
        };
      })
    };
  }

  /** The province a literal row means now (a fresh state's unreported province: by state and centre). */
  function rowProvince(r) {
    if (r.locate) return pack.provinces.find(p => live(p) && p.state === r.state && p.center === r.center) ?? null;
    const p = pack.provinces[r.i];
    return live(p) ? p : null;
  }

  function checkLiteral(L) {
    const errors = [];
    const err = (code, message) => errors.push({ code, message });
    if (!Array.isArray(L.states) || !Array.isArray(L.regrown)) {
      err("BAD_ARGS", "a provinces regrow literal is {mode:'regrow', states, regrown}");
      return { errors };
    }
    const keepLocked = L.keepLocked !== false;
    const lockedThen = new Set(Array.isArray(L.locked) ? L.locked : []);
    const fresh = new Set(Array.isArray(L.fresh) ? L.fresh : []);
    const sname = id => `${pack.states[id]?.name ?? "state"} (${id})`;
    const targets = [];
    for (const id of L.states) {
      const s = pack.states[id];
      if (!live(s)) err("REMOVED", `state ${id} was removed; the sketch regrew its provinces`);
      else {
        targets.push(id);
        if (s.lock && !lockedThen.has(id) && !fresh.has(id) && L.lockedStates !== true)
          err("REFUSED", `${sname(id)} was locked since; the sketch regrew its provinces`);
      }
    }
    const rows = [];
    const seen = new Set();
    const now = cellsOf(pack.cells.province, L.regrown.map(r => r?.i).filter(Number.isInteger));
    for (const r of L.regrown) {
      if (!r || typeof r !== "object" || !Number.isInteger(r.i)) {
        err("BAD_ARGS", "a regrown row is {i, state, runs, was}");
        continue;
      }
      const p = rowProvince(r);
      const who = `province '${r.name}' (${r.i}) of ${sname(r.state)}`;
      if (!p || p.state !== r.state) {
        err("REMOVED", `${who} was removed or moved to another state since; the sketch regrew it`);
        continue;
      }
      if (keepLocked && p.lock) {
        err("REFUSED", `${who} was locked since; the sketch regrew it`);
        continue;
      }
      if (!r.fresh && !r.locate && typeof r.was === "string" && cellHash(now.get(p.i) || []) !== r.was)
        err("REFUSED", `${who} had its cells changed since by someone else; the sketch regrew it`);
      seen.add(p.i);
      rows.push({ r, p });
    }
    for (const p of pack.provinces)
      if (live(p) && targets.includes(p.state) && !seen.has(p.i) && !(keepLocked && p.lock) && !fresh.has(p.state))
        err(
          "REFUSED",
          `${sname(p.state)} has province '${p.name}' (${p.i}), added since; the sketch regrew that state's provinces without it`
        );
    return { errors, rows, targets };
  }

  /** Replay a regrow literal: each province takes its recorded cells (those still land of its state, not in a locked province). */
  function applyLiteral(L) {
    const chk = checkLiteral(L);
    if (chk.errors.length)
      T.fail(chk.errors[0].code, chk.errors[0].message, {
        details: chk.errors
      });
    const C = pack.cells;
    const keepLocked = L.keepLocked !== false;
    const keep = new Set();
    if (keepLocked) for (const p of pack.provinces) if (live(p) && p.lock) keep.add(p.i);
    const work = Uint16Array.from(C.province);
    const was = cellsOf(
      C.province,
      chk.rows.map(x => x.p.i)
    );
    const rows = [];
    for (const { r, p } of chk.rows) {
      const before = was.get(p.i).length;
      for (const c of fromRuns(r.runs)) if (C.h[c] >= 20 && C.state[c] === p.state && !keep.has(work[c])) work[c] = p.i;
      rows.push({ i: p.i, state: p.state, before });
    }
    const after = cellsOf(
      work,
      rows.map(r => r.i)
    );
    for (const r of rows) r.after = after.get(r.i).length;
    const kept = new Set(
      pack.provinces.filter(p => live(p) && keep.has(p.i) && chk.targets.includes(p.state)).map(p => p.i)
    );
    return {
      regrow: {
        band: L.band ?? DEFAULT_BAND,
        rows,
        filled: 0,
        changed: changedOf(work),
        was: new Map([...was].map(([i, c]) => [i, cellHash(c)]))
      },
      targets: chk.targets,
      keepLocked,
      lockedStates: L.lockedStates === true,
      kept,
      replaced: [],
      replacedRows: [],
      made: [],
      work,
      modes: new Map(chk.targets.map(s => [s, "regrow"])),
      fallback: new Map(),
      unassigned: 0,
      sizes: new Map(rows.map(r => [r.i, r.after])),
      shields: 0,
      fx: { emptied: [], shrunk: [], orphaned: new Map() },
      notes: []
    };
  }

  T.territory = {
    grow,
    makeCost,
    regrowField,
    regrowProvinces,
    regrowAll,
    provincesRun,
    commitProvinces,
    provincesView,
    provincesLiteral,
    checkLiteral,
    applyLiteral,
    DEFAULT_BAND
  };
})(globalThis);
