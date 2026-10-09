// Tupaia MCP bridge extension (track 'rivers'): river structure edits on `edit river`.
//   mainStem: <tributary ref>           make that tributary's course the river's main stem: its
//                                       upper course + the river's lower course keep the river's
//                                       id and name; the river's old upper course moves to the
//                                       tributary's id (still a tributary of the river). The
//                                       junction may be a lake the river crosses.
//   split: {at: Place|cell, name?, type?}
//                                       cut the river at a cell: the upper part becomes a new
//                                       river (parent = this one), this one keeps the lower part
//   merge: true                         join this river into the river it continues (it ends at
//                                       its parent's source, as after a split): the inverse
//   reroute: {cells:[...]} | {from: Place, to: Place | 'edge', through?: [Place...], snap?, edge?}
//                                       run a stretch, the lower course or the upper course of
//                                       the river through other cells (a path that changes
//                                       nothing is a no-op success with a note; a path through
//                                       another river's loose end, e.g. after end, joins it)
//   end: {at: Place|cell}               cut the river so it ends at `at`: a cell of its course
//                                       (the cells below are dropped; it ends there, in water,
//                                       on another river or loose for a later op to join), or
//                                       a cell of another river / water next to its course (it
//                                       joins there from the lowest course cell next to it)
//   joinAt: {river?: ref, at: Place|cell}
//                                       move where the river joins `river` (default its parent):
//                                       its lower course is re-routed from the course cell
//                                       nearest `at` to that confluence cell (cheapest land path,
//                                       uphill steps cost more), as a lower-course reroute
// Each op keeps pack.rivers, cells.r (the lowest river id owns a shared cell, as
// Rivers.generate does), cells.fl, cells.conf, tributary parents and basins, lake
// inlets/outlets and river notes consistent, recomputes source, mouth, discharge, length and
// width the way Rivers.generate does (length and width only where their inputs changed), and
// redraws the rivers layer. Ops of one call apply in order; an op on rivers an earlier op of the
// call restructures is checked when it is applied.
// Resolved (replayable) form: literal. mainStem {ref: tributary id, expect: hash of the course it
// produced, name}, split {at:{cell}, name, type}, merge true, reroute {cells}, end {at:{cell}},
// joinAt {ref, at:{cell}, cells} (the literal path); a split reports the
// river it created. before/after of a structural field is the river's course without river ids
// ("<n> cells <source>-><mouth> #<cell hash>"), as it was before the call.
// Same rules as bridge-mutations.js: bare app globals at call time, no locals that shadow app
// globals (rivers, cells, lakes, notes, ...), one args object per FNS function.
(root => {
  const T = root.__tupaia;
  if (!T?.mutations?.FIELDS?.river) return;
  const fail = T.fail;
  const FIELDS = T.mutations.FIELDS;
  const nameSpec = T.mutations.nameSpec;
  const fold = T.pure.fold;

  const STRUCT = ["mainStem", "split", "merge", "reroute", "end", "joinAt"];
  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
  const rn2 = v => Math.round(v * 100) / 100;
  const isLandCell = c => Number.isInteger(c) && c >= 0 && pack.cells.h[c] >= 20;
  const isWaterCell = c => Number.isInteger(c) && c >= 0 && pack.cells.h[c] < 20;
  const isRootRiver = r => !r.parent || r.parent === r.i;
  const riverOf = id => (pack.rivers || []).find(r => r.i === id) || null;
  const tag = r => `${r.name || "river"} (${r.i})`;
  const lastOf = list => list[list.length - 1];
  const mouthOf = list => (list.length > 1 ? list[list.length - 2] : list[0]);
  const kids = id => pack.rivers.filter(r => r.i !== id && !isRootRiver(r) && r.parent === id);
  const kidIds = id => kids(id).map(r => r.i);

  /** REFUSED, naming the other rivers involved (see planOrDefer). */
  const refuse = (message, rivers = []) => fail("REFUSED", message, { rivers });

  function hashCells(list) {
    let h = 0x811c9dc5;
    const s = list.join(",");
    for (let k = 0; k < s.length; k++) {
      h ^= s.charCodeAt(k);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  /** One-line course, free of river ids: "<n> cells <source>-><mouth> #<hash>". */
  function describe(list) {
    return `${list.length} cells ${list[0]}->${mouthOf(list)} #${hashCells(list)}`;
  }

  /** get() of the structural fields: the river's course (a merged river is out of the list). */
  function course(r) {
    if (!(pack.rivers || []).includes(r)) return "merged into the river it continued";
    return describe(r.cells || []);
  }

  const validPoints = r => (Array.isArray(r.points) && r.points.length === r.cells.length ? r.points : null);

  /** Position in `list` where `child` joins it (its last cell, or the first cell of the lake it ends in). */
  function joinIndex(child, list) {
    const j = lastOf(child.cells);
    if (!Number.isInteger(j) || j < 0) return -1;
    const k = list.indexOf(j);
    if (k >= 0) return k;
    if (!isWaterCell(j)) return -1;
    const f = pack.cells.f[j];
    return list.findIndex(c => isWaterCell(c) && pack.cells.f[c] === f);
  }

  /** Rivers other than `exceptId` with each cell as a non-terminal course cell: Map cell -> [river]. */
  function courseIndex(exceptId) {
    const m = new Map();
    for (const r of pack.rivers) {
      if (r.i === exceptId) continue;
      for (let k = 0; k < r.cells.length - 1; k++) {
        const c = r.cells[k];
        if (c < 0) continue;
        const a = m.get(c);
        if (a) a.push(r);
        else m.set(c, [r]);
      }
    }
    return m;
  }

  function isDescendant(r, of) {
    const seen = new Set();
    let cur = r;
    while (cur && !isRootRiver(cur) && !seen.has(cur.i)) {
      if (cur.parent === of.i) return true;
      seen.add(cur.i);
      cur = riverOf(cur.parent);
    }
    return false;
  }

  // ---------------------------------------------------------------- shared upkeep

  /** Tributaries of re-cut rivers and where they go: owner(oldId, index in its old course) -> id. */
  function childMoves(old, owner, skip) {
    const out = [];
    for (const r of pack.rivers) {
      if (skip.has(r.i) || isRootRiver(r) || !old.has(r.parent)) continue;
      const k = joinIndex(r, old.get(r.parent));
      out.push({ r, to: k < 0 ? null : owner(r.parent, k) });
    }
    return out;
  }

  /** Re-parent tributaries of re-cut rivers; returns how many changed parent. */
  function reassignChildren(old, owner, skip, out) {
    let moved = 0;
    for (const { r, to } of childMoves(old, owner, skip)) {
      if (to === null) {
        out.add(`${tag(r)}: could not tell where it joins river ${r.parent}; its parent was left as is`);
        continue;
      }
      if (r.parent !== to) moved++;
      r.parent = to;
    }
    return moved;
  }

  /**
   * Lake inlets and outlets of the re-cut rivers `rs` (and of the river ids `gone`), from their
   * courses as Rivers.generate records them: a river is an inlet of a lake where its course
   * enters the lake's water from outside, and the outlet where it leaves the lake (a river
   * crossing a lake is both). Other rivers' entries keep their place.
   */
  function refreshLakes(rs, gone, out) {
    const ids = new Set([...rs.map(r => r.i), ...gone]);
    const inLake = (c, f) => isWaterCell(c) && pack.cells.f[c] === f;
    for (const f of pack.features || []) {
      if (!f || f.type !== "lake") continue;
      const enters = new Set();
      const exits = [];
      for (const r of rs)
        r.cells.forEach((c, k) => {
          if (!inLake(c, f.i)) return;
          if (k > 0 && !inLake(r.cells[k - 1], f.i)) enters.add(r.i);
          if (k < r.cells.length - 1 && !inLake(r.cells[k + 1], f.i) && !exits.includes(r.i)) exits.push(r.i);
        });
      const had = Array.isArray(f.inlets) ? f.inlets : [];
      if (had.some(id => ids.has(id)) || enters.size) {
        const inlets = had.filter(id => !ids.has(id) || enters.has(id));
        for (const id of enters) if (!inlets.includes(id)) inlets.push(id);
        if (inlets.length) f.inlets = inlets;
        else delete f.inlets;
      }
      if (ids.has(f.outlet) && !exits.includes(f.outlet)) {
        if (exits.length) f.outlet = exits[0];
        else {
          out.add(`lake ${f.i} lost its outlet river ${f.outlet}`);
          delete f.outlet;
        }
      }
    }
  }

  /** cells.r for `list`: the lowest id among the rivers whose course holds the cell (generator rule). */
  function reown(list) {
    const touched = new Set(list.filter(isLandCell));
    if (!touched.size) return;
    const owner = new Map();
    for (const r of pack.rivers)
      for (const c of r.cells) if (touched.has(c)) owner.set(c, Math.min(owner.get(c) ?? Infinity, r.i));
    for (const c of touched) pack.cells.r[c] = owner.get(c) ?? 0;
  }

  /** What a river's length and width depend on. */
  const sigOf = r =>
    `${hashCells(r.cells)}|${pack.cells.fl[mouthOf(r.cells)] ?? 0}|${r.widthFactor}|${r.sourceWidth}|${Array.isArray(r.points) ? r.points.length : "-"}`;
  const signatures = () => new Map(pack.rivers.map(r => [r, sigOf(r)]));

  /**
   * source, mouth, discharge, length and width as Rivers.generate computes them. Length and width
   * are kept when nothing they depend on changed since `sigs` (they may have been set by hand).
   */
  function restat(r, sigs) {
    const n = r.cells.length;
    r.source = r.cells[0];
    r.mouth = mouthOf(r.cells);
    if (Array.isArray(r.points) && r.points.length !== n) delete r.points;
    r.discharge = pack.cells.fl[r.mouth] ?? 0;
    if (sigs?.get(r) === sigOf(r)) return;
    const pts = Rivers.addMeandering(r.cells, r.points ?? null);
    r.length = Rivers.getApproximateLength(pts.map(([x, y]) => [x, y]));
    r.width = Rivers.getWidth(
      Rivers.getOffset({
        flux: r.discharge,
        pointIndex: pts.length,
        widthFactor: r.widthFactor,
        startingWidth: r.sourceWidth
      })
    );
  }

  /** Course index just below where river r leaves lake feature f (-1: it does not leave it). */
  function exitIndex(r, f) {
    let q = -1;
    r.cells.forEach((c, k) => {
      if (isWaterCell(c) && pack.cells.f[c] === f) q = k;
    });
    return q < 0 || q >= r.cells.length - 1 ? -1 : q + 1;
  }

  /**
   * Add `delta` flux from r.cells[from] downstream: along the course (across the lakes it
   * crosses), then below the junction on the parent, or below the lake it ends in on that lake's
   * outlet river, until the sea or the map edge.
   */
  function propagate(r, from, delta, touched) {
    const C = pack.cells;
    let cur = r;
    let k = from;
    for (let guard = 0; cur && delta && k >= 0 && guard < 500; guard++) {
      touched.add(cur);
      const n = cur.cells.length;
      for (; k < n; k++) {
        const c = cur.cells[k];
        if (isLandCell(c)) C.fl[c] = Math.max(0, Math.min(65535, C.fl[c] + delta));
      }
      const end = cur.cells[n - 1];
      let next = null;
      k = -1;
      if (isLandCell(end)) {
        // the junction (the last cell, updated above) is on the parent: continue below it
        next = isRootRiver(cur) ? null : riverOf(cur.parent);
        const pk = next ? next.cells.indexOf(end) : -1;
        k = pk < 0 ? -1 : pk + 1;
      } else if (isWaterCell(end)) {
        const f = pack.features[C.f[end]];
        if (f?.type === "lake" && f.outlet && f.outlet !== cur.i) {
          next = riverOf(f.outlet);
          k = next ? exitIndex(next, f.i) : -1;
        }
      }
      cur = next;
    }
  }

  /** `amount` of water where river `self` ends at `end`: into `host` there, or out of the lake there. */
  function deliverAt(end, host, amount, touched, self) {
    if (!amount) return;
    if (isLandCell(end)) {
      const k = host ? host.cells.indexOf(end) : -1;
      if (k >= 0) propagate(host, k, amount, touched);
    } else if (isWaterCell(end)) {
      const f = pack.features[pack.cells.f[end]];
      const o = f?.type === "lake" && f.outlet && f.outlet !== self.i ? riverOf(f.outlet) : null;
      const k = o ? exitIndex(o, f.i) : -1;
      if (k > 0) propagate(o, k, amount, touched);
    }
  }

  /** cells.conf: clear a cell that no longer is a confluence. */
  function refreshConf(c) {
    if (!isLandCell(c)) return;
    const ends = pack.rivers.filter(r => lastOf(r.cells) === c);
    const hosts = pack.rivers.filter(r => {
      const k = r.cells.indexOf(c);
      return k >= 0 && k < r.cells.length - 1;
    });
    if (!ends.length || !hosts.length) pack.cells.conf[c] = 0;
  }

  function markConf(c, flux) {
    if (!isLandCell(c)) return;
    pack.cells.conf[c] = Math.min(255, pack.cells.conf[c] + Math.max(1, Math.round(flux)));
  }

  function setBasin(r, basin) {
    const stack = [r];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur.i)) continue;
      seen.add(cur.i);
      cur.basin = basin;
      for (const o of pack.rivers) if (o !== cur && !isRootRiver(o) && o.parent === cur.i) stack.push(o);
    }
  }

  function modal(values) {
    const n = new Map();
    let best = null;
    let bn = 0;
    for (const v of values) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const c = (n.get(v) ?? 0) + 1;
      n.set(v, c);
      if (c > bn) {
        bn = c;
        best = v;
      }
    }
    return best;
  }

  /** The map's default (tributary) width factor: the commonest among its tributaries, else main stems / 1.2. */
  function baseWidthFactor(except) {
    const others = pack.rivers.filter(r => r !== except);
    const trib = modal(others.filter(r => !isRootRiver(r)).map(r => r.widthFactor));
    if (trib !== null) return trib;
    const main = modal(others.filter(isRootRiver).map(r => r.widthFactor));
    if (main !== null) return rn2(main / 1.2);
    return rn2(1 / (pack.cells.i.length / 10000) ** 0.25);
  }

  /** Rivers.generate gives a main stem 1.2x the default width factor; follow a role change. */
  function followRole(r, wasRoot) {
    const nowRoot = isRootRiver(r);
    if (wasRoot === nowRoot) return;
    const base = baseWidthFactor(r);
    const main = base * 1.2;
    if (wasRoot && Math.abs(r.widthFactor - main) < 0.011) r.widthFactor = base;
    else if (!wasRoot && Math.abs(r.widthFactor - base) < 0.011) r.widthFactor = main;
  }

  // ---------------------------------------------------------------- batch: order and claims

  function onlyOne(set) {
    const keys = STRUCT.filter(k => set && k in set);
    if (keys.length > 1)
      fail("BAD_ARGS", `one structural river change per op (got ${keys.join(", ")}); put them in separate ops`);
  }

  function claimedBy(c, ids) {
    if (!c.riverClaims) return undefined;
    for (const id of ids) {
      const w = c.riverClaims.get(id);
      if (w !== undefined) return w;
    }
    return undefined;
  }

  function claim(c, ids, what) {
    if (!c.riverClaims) c.riverClaims = new Map();
    for (const id of ids) if (!c.riverClaims.has(id)) c.riverClaims.set(id, what);
  }

  /**
   * Ops of one edit call are all checked against the map as it was before the call, then applied
   * in order. A structural op touching rivers that an earlier op of the call restructures (or
   * failing because of one) cannot be checked that way: it is checked when it is applied, after
   * the earlier ops (a failure then stops the call; undo reverts it). `plan()` checks the op
   * against the map before the call, `idsOf(plan)` names the other rivers it touches.
   */
  function planOrDefer(c, x, what, plan, idsOf) {
    let p = null;
    let ids;
    try {
      p = plan();
      ids = [x.i, ...idsOf(p)];
    } catch (e) {
      ids = [x.i, ...(Array.isArray(e?.rivers) ? e.rivers : [])];
      if (claimedBy(c, ids) === undefined) throw e;
      p = null;
    }
    const by = claimedBy(c, ids);
    claim(c, ids, what);
    return by === undefined ? { plan: p } : { plan: null, deferredBy: by };
  }

  const deferredText = by =>
    `checked when applied: an earlier op of this call (${by}) restructures rivers this op touches, and ops apply in order`;

  /** op.set object -> the target river's course before the call (see the FNS.edit wrapper). */
  const preCourse = new WeakMap();

  const snapRadius = () =>
    2.5 * (grid?.spacing || Math.sqrt((graphWidth * graphHeight) / Math.max(1, pack.cells.i.length)));

  const placeOf = v => (Number.isInteger(v) ? T.place({ cell: v }) : T.place(v));

  /** Course index (within [from, to)) of the cell of r nearest to point p. */
  function nearestOnRiver(r, p, from, to) {
    let best = -1;
    let bd = Infinity;
    for (let k = Math.max(0, from); k < Math.min(to, r.cells.length); k++) {
      const c = r.cells[k];
      if (c < 0) continue;
      const q = pack.cells.p[c];
      const d = Math.hypot(q[0] - p.x, q[1] - p.y);
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return { k: best, d: bd };
  }

  // ---------------------------------------------------------------- mainStem

  function planMainStem(m, t) {
    const C = pack.cells;
    if (t === m) fail("BAD_ARGS", "mainStem is a tributary of this river, not the river itself");
    if (isRootRiver(t) || t.parent !== m.i)
      refuse(
        `${tag(t)} is not a tributary of ${tag(m)} (${isRootRiver(t) ? "it is a main river" : `its parent is river ${t.parent}`}); mainStem takes a direct tributary`,
        [t.i]
      );
    if (t.cells.length < 2) refuse(`${tag(t)} has no course to promote`, [t.i]);
    const j = lastOf(t.cells);
    let enter = m.cells.indexOf(j);
    let exit = enter;
    let viaLake = false;
    if (enter < 0 && isWaterCell(j)) {
      // t ends in a lake m crosses: the new main course leaves the lake where m leaves it
      const f = C.f[j];
      enter = m.cells.findIndex(c => isWaterCell(c) && C.f[c] === f);
      exit = enter;
      while (exit >= 0 && exit + 1 < m.cells.length && isWaterCell(m.cells[exit + 1]) && C.f[m.cells[exit + 1]] === f)
        exit++;
      viaLake = enter >= 0;
      if (viaLake && exit >= m.cells.length - 1)
        refuse(`${tag(m)} ends in the lake ${tag(t)} ends in, so there is no lower course to continue`, [t.i]);
    }
    if (enter < 0)
      refuse(
        `${tag(t)} does not end on ${tag(m)}'s course (it ends at cell ${j}); mainStem needs a junction on the course or in a lake the river crosses`,
        [t.i]
      );
    if (enter === 0)
      refuse(
        viaLake
          ? `${tag(m)} flows out of the lake ${tag(t)} ends in, so it has no upper course to hand over`
          : `${tag(t)} joins at ${tag(m)}'s source, so it already continues it; use merge:true on ${tag(t)} instead`,
        [t.i]
      );
    const tTake = viaLake ? t.cells.length : t.cells.length - 1;
    const owner = (id, k) => (id === m.i && k < enter ? t.i : m.i);
    const old = new Map([
      [m.i, m.cells],
      [t.i, t.cells]
    ]);
    const moves = childMoves(old, owner, new Set([m.i, t.i])).filter(x => x.to !== null && x.to !== x.r.parent);
    return {
      enter,
      exit,
      tTake,
      j: m.cells[enter],
      viaLake,
      owner,
      moves: moves.length,
      mCells: t.cells.slice(0, tTake).concat(m.cells.slice(exit)),
      tCells: m.cells.slice(0, enter + 1)
    };
  }

  function expectFailed(m, t, plan, expect) {
    refuse(
      `this mainStem was recorded as giving ${tag(m)} the course #${expect}, but it would now give ${describe(plan.mCells)}: ${tag(m)} or ${tag(t)} changed since (re-cut by someone else, or this swap was already applied)`,
      [t.i]
    );
  }

  function applyMainStem(m, t, v, cc) {
    if (!pack.rivers.includes(m)) refuse(`${tag(m)} no longer exists (an earlier op of this call merged it)`);
    if (!t || !pack.rivers.includes(t)) refuse("the tributary of mainStem no longer exists");
    const plan = planMainStem(m, t);
    const expect = hashCells(plan.mCells);
    if (v.expect !== undefined && v.expect !== expect) expectFailed(m, t, plan, v.expect);
    const sigs = signatures();
    const mOld = m.cells;
    const tOld = t.cells;
    const mPts = validPoints(m);
    const tPts = validPoints(t);
    m.cells = plan.mCells;
    t.cells = plan.tCells;
    if (mPts && tPts) {
      m.points = tPts.slice(0, plan.tTake).concat(mPts.slice(plan.exit));
      t.points = mPts.slice(0, plan.enter + 1);
    } else {
      delete m.points;
      delete t.points;
    }
    // the source width belongs to the source (generator: getSourceWidth(fl[source]))
    [m.sourceWidth, t.sourceWidth] = [t.sourceWidth, m.sourceWidth];
    const old = new Map([
      [m.i, mOld],
      [t.i, tOld]
    ]);
    // tributaries of the old upper course follow it to t's id; t's own tributaries now join m
    const moved = reassignChildren(old, plan.owner, new Set([m.i, t.i]), cc.notes);
    refreshLakes([m, t], [], cc.notes);
    reown(mOld.concat(tOld));
    restat(m, sigs);
    restat(t, sigs);
    v.done = { expect };
    cc.R.add("rivers");
    cc.notes.add(
      `${tag(m)} now rises at cell ${m.source} (${m.cells.length} cells, ${tag(t)}'s old upper course); ${tag(t)} now holds ${tag(m)}'s old upper course (${t.cells.length} cells, joining at cell ${plan.j}) and keeps its name: rename it with name/type if needed${moved ? `; ${moved} tributar${moved === 1 ? "y" : "ies"} re-parented` : ""}`
    );
  }

  // ---------------------------------------------------------------- split

  function splitIndex(x, at) {
    const p = placeOf(at);
    const n = x.cells.length;
    if (n < 5) refuse(`${tag(x)} has ${n} cells, too short to split into two rivers of at least 3 cells`);
    let s = x.cells.indexOf(p.cell);
    if (s === 0) refuse(`cell ${p.cell} is the source of ${tag(x)}; split at a cell further down`);
    if (s >= n - 1)
      refuse(`cell ${p.cell} is where ${tag(x)} ends (its mouth water or junction); split at a cell above it`);
    if (s < 0) {
      const near = nearestOnRiver(x, p, 1, n - 1);
      if (near.k < 0 || near.d > snapRadius())
        refuse(
          `the split place (${p.x}, ${p.y}) is ${Math.round(near.d)} px from ${tag(x)}'s course; pass a cell of its course or {entity:{type:'river', ref:${x.i}}, at:0..1}`
        );
      s = near.k;
    }
    if (!isLandCell(x.cells[s])) refuse(`cell ${x.cells[s]} is in a lake; split at a land cell`);
    if (s < 2 || s > n - 3)
      refuse(
        `a split at cell ${x.cells[s]} would leave a ${s < 2 ? "upper" : "lower"} part of ${s < 2 ? s + 1 : n - s} cells; each part needs at least 3 (the generator's shortest river), so split at a cell from ${x.cells[2]} to ${x.cells[n - 3]}`
      );
    return s;
  }

  function applySplit(x, v, cc) {
    if (!pack.rivers.includes(x)) refuse(`${tag(x)} no longer exists (an earlier op of this call merged it)`);
    let s;
    if (v.deferredBy !== undefined) s = splitIndex(x, v.at);
    else {
      s = x.cells.indexOf(v.cell);
      if (s < 2 || s > x.cells.length - 3) refuse(`cell ${v.cell} is no longer inside ${tag(x)}'s course`);
    }
    v.cell = x.cells[s];
    const sigs = signatures();
    const xOld = x.cells;
    const pts = validPoints(x);
    const up = xOld.slice(0, s + 1);
    const u = {
      i: Rivers.getNextId(pack.rivers),
      source: up[0],
      mouth: up[up.length - 2],
      discharge: 0,
      length: 0,
      width: 0,
      widthFactor: x.widthFactor,
      sourceWidth: x.sourceWidth,
      parent: x.i,
      cells: up,
      basin: x.basin ?? Rivers.getBasin(x.i),
      name: "",
      type: v.type
    };
    if (pts) {
      u.points = pts.slice(0, s + 1);
      x.points = pts.slice(s);
    } else delete x.points;
    // the lower part starts as wide as the river was at the split point (flux part aside)
    const upPoints = Rivers.addMeandering(up, u.points ?? null);
    x.sourceWidth = rn2(
      Rivers.getOffset({
        flux: 0,
        pointIndex: upPoints.length - 1,
        widthFactor: x.widthFactor,
        startingWidth: x.sourceWidth
      })
    );
    x.cells = xOld.slice(s);
    pack.rivers.push(u);
    const old = new Map([[x.i, xOld]]);
    const owner = (_id, k) => (k < s ? u.i : x.i);
    const moved = reassignChildren(old, owner, new Set([x.i, u.i]), cc.notes);
    refreshLakes([x, u], [], cc.notes);
    reown(xOld);
    restat(x, sigs);
    restat(u, null);
    FIELDS.river.name.set(u, v.name, cc); // literal text, or generated from the upper part's culture
    v.made = u.name;
    cc.created.push({ type: "river", i: u.i, name: u.name });
    cc.R.add("rivers");
    cc.notes.add(
      `${tag(x)} now starts at cell ${v.cell} (${x.cells.length} cells); its upper course is the new river ${tag(u)} (${u.cells.length} cells, parent ${x.i})${moved ? `, with ${moved} tributar${moved === 1 ? "y" : "ies"}` : ""}`
    );
    if (pack.rivers.some(r => r !== u && fold(r.name || "") === fold(u.name || "")))
      cc.notes.add(
        `warning: another river is also named '${u.name}'; refs by that name are now AMBIGUOUS (use ids, or rename one)`
      );
  }

  // ---------------------------------------------------------------- merge

  function planMerge(u) {
    if (isRootRiver(u)) refuse(`${tag(u)} has no parent river to merge into`);
    const p = riverOf(u.parent);
    if (!p) refuse(`${tag(u)}'s parent river ${u.parent} does not exist`, [u.parent]);
    const j = lastOf(u.cells);
    if (j !== p.cells[0]) {
      const k = p.cells.indexOf(j);
      refuse(
        k > 0
          ? `${tag(u)} joins ${tag(p)} mid-course (cell ${j}); merge joins a river into the river it continues (one that ends at its parent's source, as after split). To make ${tag(u)} the main stem use edit river ${p.i} {mainStem: ${u.i}}`
          : `${tag(u)} does not end at ${tag(p)}'s source (cell ${p.cells[0]}); merge joins a river into the river it continues`,
        [p.i]
      );
    }
    return { p, j };
  }

  function applyMerge(u, cc) {
    if (!pack.rivers.includes(u)) refuse(`${tag(u)} no longer exists (an earlier op of this call merged it)`);
    const { p } = planMerge(u);
    const sigs = signatures();
    const uOld = u.cells;
    const pOld = p.cells;
    const uPts = validPoints(u);
    const pPts = validPoints(p);
    p.cells = uOld.slice(0, -1).concat(pOld);
    if (uPts && pPts) p.points = uPts.slice(0, -1).concat(pPts);
    else delete p.points;
    p.sourceWidth = u.sourceWidth;
    pack.rivers.splice(pack.rivers.indexOf(u), 1);
    document.getElementById(`river${u.i}`)?.remove();
    const old = new Map([[u.i, uOld]]);
    reassignChildren(old, () => p.i, new Set([u.i, p.i]), cc.notes);
    refreshLakes([p], [u.i], cc.notes);
    reown(uOld);
    restat(p, sigs);
    cc.R.add("rivers");
    cc.notes.add(`${tag(u)} merged into ${tag(p)}, which now rises at cell ${p.source} (${p.cells.length} cells)`);
    // a note on the merged river follows its course (as rivfix moved river notes by hand)
    const nid = `river${u.i}`;
    const pid = `river${p.i}`;
    const note = (notes || []).find(n => n.id === nid);
    if (note) {
      if (!(notes || []).some(n => n.id === pid)) {
        note.id = pid;
        cc.notes.add(`note ${nid} now belongs to ${tag(p)} (id ${pid})`);
      } else
        cc.notes.add(
          `note ${nid} now has no river (${tag(p)} already has note ${pid}); merge their texts with edit note, then remove ${nid}`
        );
    }
  }

  // ---------------------------------------------------------------- reroute

  /** Validate a reroute path for river x and work out what it changes (nothing is mutated). */
  function planReroute(x, path) {
    const C = pack.cells;
    const total = C.i.length;
    if (!Array.isArray(path) || path.length < 2) fail("BAD_ARGS", "a reroute needs at least 2 cells");
    path.forEach((c, k) => {
      if (c === -1 && k === path.length - 1 && k > 0) return;
      if (!Number.isInteger(c) || c < 0 || c >= total)
        fail(
          "BAD_ARGS",
          `reroute cell ${JSON.stringify(c)} is not a cell id 0..${total - 1}${k === path.length - 1 ? " (or -1: off the map edge)" : ""}`
        );
    });
    if (new Set(path).size !== path.length)
      fail("BAD_ARGS", "a cell appears twice in the reroute; a river cannot loop");
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1];
      const b = path[k];
      if (b === -1) {
        if (!C.b[a]) fail("BAD_ARGS", `-1 (off the map edge) must follow a border cell; cell ${a} is not one`);
      } else if (!C.c[a].includes(b))
        fail(
          "BAD_ARGS",
          `cells ${a} and ${b} are not neighbours; reroute cells must be contiguous. Cell ${a}'s neighbours: ${Array.from(C.c[a]).join(", ")}; cell ${b}'s: ${Array.from(C.c[b]).join(", ")} (inspect {at:{cell}} lists them too)`,
          { details: { neighbours: { [a]: Array.from(C.c[a]), [b]: Array.from(C.c[b]) } } }
        );
    }
    const xc = x.cells;
    const n = xc.length;
    const first = path[0];
    const last = lastOf(path);
    const ia = xc.indexOf(first);
    const ib = last === -1 ? (xc[n - 1] === -1 ? n - 1 : -1) : xc.lastIndexOf(last);
    if (ia === n - 1)
      refuse(`cell ${first} is where ${tag(x)} ends (its mouth water or junction); start the reroute above it`);
    let mode;
    let cellsNew;
    let kept;
    if (ia >= 0 && ib >= 0) {
      if (ib <= ia)
        fail(
          "BAD_ARGS",
          `the cells run upstream (${first} is at position ${ia} of ${tag(x)}'s course, ${last} at ${ib}); list them from upstream to downstream`
        );
      mode = "stretch";
      cellsNew = xc.slice(0, ia).concat(path, xc.slice(ib + 1));
      kept = xc.slice(0, ia).concat(xc.slice(ib + 1));
    } else if (ia >= 0) {
      mode = "lower";
      cellsNew = xc.slice(0, ia).concat(path);
      kept = xc.slice(0, ia);
    } else if (ib >= 0) {
      mode = "upper";
      if (isWaterCell(xc[0])) refuse(`${tag(x)} flows out of a lake; a new source would cut it off from the lake`);
      cellsNew = path.concat(xc.slice(ib + 1));
      kept = xc.slice(ib + 1);
    } else
      refuse(
        `a reroute starts or ends on ${tag(x)}'s course (cells ${xc[0]}..${xc[n - 2]}); neither ${first} nor ${last} is on it`
      );
    if (cellsNew.length === n && cellsNew.every((c, k) => c === xc[k]))
      return { noop: true, mode, path, cellsNew, orphans: [], captured: [], target: null, climbs: [] };
    const keptSet = new Set(kept);
    const others = courseIndex(x.i);

    // where a lower-course reroute ends: another river (confluence), water, or the map edge
    let target = null;
    if (mode === "lower") {
      if (last === -1) target = { kind: "edge" };
      else if (isWaterCell(last)) {
        const f = pack.features[C.f[last]];
        target = { kind: "water", feature: f };
        if (f?.type === "lake" && f.outlet) {
          const o = riverOf(f.outlet);
          if (o && (o === x || isDescendant(o, x)))
            refuse(`${tag(x)} would flow into the lake it (or its tributary ${tag(o)}) drains; a loop`, [o.i]);
        }
      } else {
        const hosts = (others.get(last) || []).slice().sort((a, b) => a.i - b.i);
        if (!hosts.length)
          refuse(
            `the path ends at cell ${last}, which is not on ${tag(x)}, on another river (a confluence), in water or off the map edge`
          );
        const r = hosts[0];
        if (isDescendant(r, x)) refuse(`${tag(r)} flows into ${tag(x)}; joining it would make a loop`, [r.i]);
        target = { kind: "river", r, k: r.cells.indexOf(last) };
      }
    }

    // interior cells: land, not on the kept course (a loop), not on another river (a crossing)
    path.forEach((c, k) => {
      if (k === 0 && ia >= 0) return;
      if (k === path.length - 1 && (ib >= 0 || mode === "lower")) return;
      if (!isLandCell(c)) refuse(`cell ${c} is water; a reroute can end in water (a new mouth) but not cross it`);
      if (keptSet.has(c)) refuse(`cell ${c} is already on ${tag(x)} outside the rerouted stretch; the path would loop`);
      const crossed = others.get(c);
      if (crossed)
        refuse(
          `cell ${c} is on ${tag(crossed[0])}; a reroute cannot cross another river (it may end on one, as a confluence). To free the cell, reroute ${tag(crossed[0])} first (an earlier op of the same call works)`,
          crossed.map(r => r.i)
        );
    });

    const climbs = [];
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1];
      const b = path[k];
      if (isLandCell(a) && isLandCell(b) && C.h[b] > C.h[a]) climbs.push(`${a} (h${C.h[a]}) -> ${b} (h${C.h[b]})`);
    }

    // rivers that end loose on a cell the new course takes (not on a river or in water, e.g. after
    // edit river {end}) join x there
    const xcAll = new Set(xc);
    const captured = [];
    path.forEach((c, k) => {
      if (k === path.length - 1 || !isLandCell(c) || xcAll.has(c)) return;
      for (const y of pack.rivers) {
        if (y === x || lastOf(y.cells) !== c) continue;
        if (isDescendant(x, y))
          refuse(
            `${tag(y)} ends at cell ${c} and ${tag(x)} flows into it; running ${tag(x)} through there would make a loop`,
            [y.i]
          );
        captured.push({ y, c });
      }
    });

    // tributaries that joined a dropped cell reconnect to a neighbouring cell of the new course
    const keepNew = new Set(cellsNew);
    const orphans = [];
    for (const y of pack.rivers) {
      if (y === x || isRootRiver(y) || y.parent !== x.i) continue;
      const j = lastOf(y.cells);
      if (keepNew.has(j)) continue;
      if (isWaterCell(j) && cellsNew.some(c => isWaterCell(c) && C.f[c] === C.f[j])) continue;
      if (joinIndex(y, xc) < 0) continue; // joins somewhere we cannot tell; left alone
      const to = C.c[j]
        .filter(
          c => keepNew.has(c) && isLandCell(c) && cellsNew.indexOf(c) < cellsNew.length - 1 && !y.cells.includes(c)
        )
        .sort((a, b) => C.h[a] - C.h[b]);
      if (!to.length || !isLandCell(j))
        refuse(
          `tributary ${tag(y)} joins ${tag(x)} at cell ${j}, which the new course drops, and no cell of the new course neighbours it; run the path through or next to cell ${j}, or reroute ${tag(y)} first`,
          [y.i]
        );
      orphans.push({ y, j, to: to[0], into: null });
    }
    // several tributaries met at the same dropped cell: the biggest carries on to the new
    // course, the others now end there as its tributaries (as the generator joins rivers)
    const mouthFlux = y => C.fl[y.cells[y.cells.length - 2]] ?? 0;
    const byCell = new Map();
    for (const o of orphans) byCell.set(o.j, [...(byCell.get(o.j) ?? []), o]);
    for (const group of byCell.values()) {
      group.sort((a, b) => mouthFlux(b.y) - mouthFlux(a.y) || a.y.i - b.y.i);
      for (const o of group.slice(1)) {
        o.into = group[0].y;
        o.to = null;
      }
    }

    // a root river stays a root (parent kept); a tributary that becomes one gets parent = itself
    let parentAfter = x.parent;
    if (target) {
      if (target.kind === "river") parentAfter = target.r.i;
      else if (target.kind === "water" && target.feature?.type === "lake" && target.feature.outlet)
        parentAfter = target.feature.outlet;
      else parentAfter = isRootRiver(x) ? x.parent : x.i;
    }
    const dropped = xc.filter(c => isLandCell(c) && !keepNew.has(c)).length;
    const xcSet = new Set(xc);
    const added = cellsNew.filter(c => isLandCell(c) && !xcSet.has(c)).length;
    const lakes = new Set(
      xc.filter(c => isWaterCell(c) && !keepNew.has(c) && pack.features[C.f[c]]?.type === "lake").map(c => C.f[c])
    );
    const left = `${dropped} cells left${lakes.size ? ` (and the lake${lakes.size > 1 ? "s" : ""} ${[...lakes].join(", ")}: the course no longer crosses ${lakes.size > 1 ? "them" : "it"})` : ""}`;
    return { mode, ia, ib, path, cellsNew, target, orphans, captured, climbs, parentAfter, dropped, added, left };
  }

  const noopText = (x, how) =>
    `unchanged: ${tag(x)} already runs through these cells${how ? ` ${how}` : ""}; nothing changed (to make it end earlier use end:{at}, to move a confluence joinAt)`;

  function rerouteText(x, plan, snaps) {
    if (plan.noop) return noopText(x, "in this order");
    const parts = [`${plan.mode}: ${plan.left}, ${plan.added} joined; ${describe(plan.cellsNew)}`];
    const wasRoot = isRootRiver(x);
    if (plan.parentAfter !== x.parent) {
      const p = riverOf(plan.parentAfter);
      parts.push(plan.parentAfter === x.i || !p ? "now a main river" : `now a tributary of ${tag(p)}`);
    } else if (!wasRoot && plan.target) parts.push(`still a tributary of river ${x.parent}`);
    if (plan.orphans.length)
      parts.push(`${plan.orphans.length} tributar${plan.orphans.length === 1 ? "y" : "ies"} reconnect`);
    if (plan.captured.length)
      parts.push(`${plan.captured.map(o => tag(o.y)).join(", ")} join${plan.captured.length === 1 ? "s" : ""} it`);
    if (plan.climbs.length)
      parts.push(`climbs at ${plan.climbs.length} step(s): ${plan.climbs[0]}${plan.climbs.length > 1 ? ", ..." : ""}`);
    for (const s of snaps ?? []) parts.push(s);
    return parts.join("; ");
  }

  function applyReroute(x, path, cc) {
    const C = pack.cells;
    const plan = planReroute(x, path);
    if (plan.noop) {
      cc.notes.add(noopText(x, "in this order"));
      return;
    }
    const sigs = signatures();
    const discharges = new Map(pack.rivers.map(r => [r, r.discharge]));
    const xOld = x.cells;
    const oldMouth = mouthOf(xOld);
    const oldDelivered = isLandCell(oldMouth) ? C.fl[oldMouth] : 0;
    const oldEnd = lastOf(xOld);
    const oldParent = isRootRiver(x) ? null : riverOf(x.parent);
    const wasRoot = isRootRiver(x);
    const prec = c => grid.cells.prec?.[C.g[c]] ?? 0;

    // flux along the new cells: each cell's own drainage plus what flows in from upstream
    const posOld = new Map();
    xOld.forEach((c, k) => {
      if (c >= 0 && !posOld.has(c)) posOld.set(c, k);
    });
    // what the old course brought into position k; past a lake, what entered the lake (the lake
    // keeps draining the rest of its water into its outlet cell)
    const inflowAt = k => {
      for (let q = k - 1; q >= 0; q--) if (isLandCell(xOld[q])) return C.fl[xOld[q]];
      return 0;
    };
    const accounted = new Set([...xOld, ...path]);
    const lowest = u => C.c[u].reduce((m, w) => (C.h[w] < C.h[m] ? w : m), C.c[u][0]);
    // a cell off the old course: its rain plus the flux of off-river neighbours that drain into
    // it, at most its stored flux (which may still hold the water of a river that ran there)
    // a river that ends loose there (plan.captured) brings its water too
    const capturedAt = new Map();
    for (const o of plan.captured) {
      const m = mouthOf(o.y.cells);
      capturedAt.set(o.c, (capturedAt.get(o.c) ?? 0) + (isLandCell(m) && m !== o.c ? C.fl[m] : 0));
    }
    const overland = c => {
      let s = prec(c) + (capturedAt.get(c) ?? 0);
      for (const u of C.c[c])
        if (isLandCell(u) && !accounted.has(u) && !C.r[u] && C.h[u] > C.h[c] && lowest(u) === c) s += C.fl[u];
      return Math.min(C.fl[c], s);
    };
    const own = c => {
      const k = posOld.get(c);
      if (k === undefined) return overland(c);
      return k > 0 ? Math.max(0, C.fl[c] - inflowAt(k)) : C.fl[c];
    };
    const newFl = new Map();
    let flowing = C.fl[path[0]];
    for (let k = 1; k < path.length - 1; k++) {
      flowing = Math.min(65535, own(path[k]) + flowing);
      newFl.set(path[k], flowing);
    }
    // inflow into the end cell before and after (a stretch or upper-course reroute ends on x)
    const endCell = lastOf(path);
    const kb = plan.mode === "lower" ? -1 : xOld.lastIndexOf(endCell);
    const oldInflow = kb > 0 ? inflowAt(kb) : 0;

    const keepNew = new Set(plan.cellsNew);
    const dropped = xOld.filter(c => isLandCell(c) && !keepNew.has(c));
    const orphanEnds = new Set(plan.orphans.map(o => o.j));

    // 1. the course
    x.cells = plan.cellsNew;
    if (x.points) {
      delete x.points;
      cc.notes.add(`${tag(x)}'s hand-placed control points were reset to cell centres`);
    }
    for (const [c, v] of newFl) C.fl[c] = v;
    const touched = new Set([x]);
    // 2. cells the river left: no longer on any river -> back to their rain (as Rivers.remove)
    const elsewhere = courseIndex(x.i);
    for (const c of dropped) {
      if (orphanEnds.has(c)) continue;
      if (!elsewhere.has(c) && !pack.rivers.some(r => r !== x && lastOf(r.cells) === c)) {
        C.fl[c] = prec(c);
        C.conf[c] = 0;
      }
    }
    // 3. tributaries of dropped cells: the biggest at each cell carries on by one cell onto the
    // new course; the dropped cell holds the water of every tributary that met there
    const mouthFlux = y => {
      const c = y.cells[y.cells.length - 2];
      return isLandCell(c) ? C.fl[c] : 0;
    };
    const carriers = plan.orphans.filter(o => o.to !== null);
    for (const o of carriers) {
      const met = plan.orphans.filter(p => p.j === o.j);
      C.fl[o.j] = Math.min(65535, met.reduce((s, p) => s + mouthFlux(p.y), 0) + prec(o.j));
      o.y.cells = o.y.cells.concat(o.to);
      if (Array.isArray(o.y.points)) delete o.y.points;
      touched.add(o.y);
      cc.notes.add(`tributary ${tag(o.y)} now joins at cell ${o.to} (it joined at the dropped cell ${o.j})`);
    }
    for (const o of plan.orphans.filter(p => p.into)) {
      markConf(o.j, mouthFlux(o.y));
      o.y.parent = o.into.i;
      cc.notes.add(`tributary ${tag(o.y)} now joins ${tag(o.into)} at cell ${o.j}`);
    }
    // 4. downstream flux
    if (plan.mode !== "lower") propagate(x, x.cells.lastIndexOf(endCell), flowing - oldInflow, touched);
    for (const o of carriers) {
      propagate(x, x.cells.indexOf(o.to), C.fl[o.j], touched);
      markConf(o.to, C.fl[o.j]);
      refreshConf(o.j);
    }
    if (plan.mode === "lower") {
      // the old end stops receiving x's water, the new end starts
      deliverAt(oldEnd, oldParent, -oldDelivered, touched, x);
      refreshConf(oldEnd);
      const t = plan.target;
      const newMouth = mouthOf(x.cells);
      const delivered = isLandCell(newMouth) ? C.fl[newMouth] : 0;
      deliverAt(lastOf(x.cells), t.kind === "river" ? t.r : null, delivered, touched, x);
      if (t.kind === "river") markConf(lastOf(x.cells), delivered);
      x.parent = plan.parentAfter;
      setBasin(x, isRootRiver(x) ? x.i : (riverOf(x.parent)?.basin ?? Rivers.getBasin(x.parent)));
      followRole(x, wasRoot);
      if (wasRoot !== isRootRiver(x) || (oldParent && oldParent.i !== x.parent)) {
        const p = isRootRiver(x) ? null : riverOf(x.parent);
        cc.notes.add(
          p
            ? `${tag(x)} is now a tributary of ${tag(p)} (width factor ${rn2(x.widthFactor)})`
            : `${tag(x)} now reaches ${t.kind === "edge" ? "the map edge" : "the sea or a lake"} on its own: a main river (width factor ${rn2(x.widthFactor)})`
        );
      }
    }
    // 5. rivers that ended loose on the new course now join x there
    for (const o of plan.captured) {
      markConf(o.c, capturedAt.get(o.c) ?? 0);
      const was = o.y.parent;
      const wasRootY = isRootRiver(o.y);
      o.y.parent = x.i;
      setBasin(o.y, x.basin ?? Rivers.getBasin(x.i));
      followRole(o.y, wasRootY);
      touched.add(o.y);
      cc.notes.add(
        `${tag(o.y)} ended loose at cell ${o.c}; it now joins ${tag(x)} there${was !== x.i ? ` (parent ${was} -> ${x.i})` : ""}`
      );
    }
    // 6. lakes: x may enter a lake now (a new mouth) or no longer touch one
    refreshLakes([x, ...carriers.map(o => o.y)], [], cc.notes);
    reown(
      xOld.concat(
        x.cells,
        plan.orphans.flatMap(o => [o.j, o.to])
      )
    );
    // a new source gets the generator's source width for its flux
    if (plan.mode === "upper") x.sourceWidth = Rivers.getSourceWidth(C.fl[x.cells[0]]);
    for (const r of touched) restat(r, sigs);
    cc.R.add("rivers");
    cc.notes.add(
      `${tag(x)} rerouted (${plan.mode}): ${plan.left}, ${plan.added} cells joined; now ${x.cells.length} cells, discharge ${discharges.get(x)} -> ${x.discharge}`
    );
    const downstream = [...touched].filter(r => r !== x && discharges.has(r) && discharges.get(r) !== r.discharge);
    if (downstream.length)
      cc.notes.add(
        `discharge also changed on ${downstream
          .slice(0, 4)
          .map(r => `${tag(r)} ${discharges.get(r)} -> ${r.discharge}`)
          .join(", ")}${downstream.length > 4 ? `, and ${downstream.length - 4} more` : ""}`
      );
    if (plan.climbs.length)
      cc.notes.add(
        `warning: the new course of ${tag(x)} climbs at ${plan.climbs.length} step(s): ${plan.climbs.slice(0, 3).join(", ")}${plan.climbs.length > 3 ? ", ..." : ""}`
      );
  }

  /** Cheapest land path from `a` (a cell or several) to `goal` (a cell, or a predicate); uphill steps cost more; `ok(c)` filters the way. */
  function shortestPath(a, goal, ok) {
    const C = pack.cells;
    const isGoal = typeof goal === "function" ? goal : c => c === goal;
    const starts = Array.isArray(a) ? a : [a];
    if (!Array.isArray(a) && isGoal(a)) return [a];
    const n = C.i.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const heap = [];
    const push = (d, c) => {
      heap.push([d, c]);
      let i = heap.length - 1;
      while (i > 0) {
        const pi = (i - 1) >> 1;
        if (heap[pi][0] <= heap[i][0]) break;
        [heap[pi], heap[i]] = [heap[i], heap[pi]];
        i = pi;
      }
    };
    const pop = () => {
      const top = heap[0];
      const end = heap.pop();
      if (heap.length) {
        heap[0] = end;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    for (const s0 of starts) {
      dist[s0] = 0;
      push(0, s0);
    }
    const startSet = new Set(starts);
    let found = -1;
    while (heap.length) {
      const [d, u] = pop();
      if (d > dist[u]) continue;
      if (!startSet.has(u) && isGoal(u)) {
        found = u;
        break;
      }
      for (const v of C.c[u]) {
        if (!isGoal(v) && !ok(v)) continue;
        const climb = Math.max(0, C.h[v] - C.h[u]);
        const w = Math.hypot(C.p[v][0] - C.p[u][0], C.p[v][1] - C.p[u][1]) * (1 + climb);
        if (d + w < dist[v]) {
          dist[v] = d + w;
          prev[v] = u;
          push(d + w, v);
        }
      }
    }
    if (found < 0) return null;
    const out = [found];
    for (let c = prev[found]; c >= 0; c = prev[c]) out.push(c);
    return out.reverse();
  }

  /**
   * Literal reroute cells for {from, to, through, snap, edge}: an end within 2.5 cells of the
   * course snaps onto it (unless snap:false), reported in `notes`; from off the course starts a
   * new source; to:'edge' (or -1) runs to the nearest map edge, edge:true off the map past `to`.
   */
  function buildPath(x, v) {
    const C = pack.cells;
    const xc = x.cells;
    const n = xc.length;
    const snap = v.snap !== false;
    const radius = snapRadius();
    const notes = [];
    const others = courseIndex(x.i);
    const pf = placeOf(v.from);
    let a = pf.cell;
    let ka = xc.indexOf(a);
    if (ka > n - 2) ka = -1;
    if (ka < 0 && snap) {
      const near = nearestOnRiver(x, pf, 0, n - 1);
      if (near.k >= 0 && near.d <= radius) {
        notes.push(
          `from (cell ${a}) snapped to cell ${xc[near.k]} of the course, ${Math.round(near.d)} px away (snap:false keeps it as a new source)`
        );
        a = xc[near.k];
        ka = near.k;
      }
    }
    const fromText = a !== pf.cell ? `from (cell ${pf.cell}, snapped to ${a})` : `from (cell ${a})`;
    let b = null;
    let kb = -1;
    let toEdge = false;
    let toText = "to (the map edge)";
    if (v.to === "edge" || v.to === -1) toEdge = true;
    else {
      const pt = placeOf(v.to);
      b = pt.cell;
      kb = xc.lastIndexOf(b);
      if (v.edge === true) {
        if (!C.b[b] || !isLandCell(b))
          fail(
            "BAD_ARGS",
            `edge:true runs the river off the map past 'to', which must be a land border cell; cell ${b} is not one (or use to:'edge')`
          );
        if (kb >= 0 || others.has(b))
          refuse(`to (cell ${b}) is on a river; with edge:true it must be a free border cell`);
        toEdge = true;
        kb = -1;
      } else if (kb < 0 && !others.has(b) && !isWaterCell(b)) {
        const near = snap ? nearestOnRiver(x, pt, 0, n) : { k: -1, d: Infinity };
        if (near.k >= 0 && near.d <= radius) {
          notes.push(
            `to (cell ${b}) snapped to cell ${xc[near.k]} of the course, ${Math.round(near.d)} px away (snap:false to keep it)`
          );
          b = xc[near.k];
          kb = near.k;
        } else
          refuse(
            `to (cell ${b}) is not on ${tag(x)}, on another river or in water${snap ? ` (nor within ${Math.round(radius)} px of the course)` : ""}; a reroute ends on the river, at a confluence (another river), at a new mouth (water) or off the map edge (to:'edge', or edge:true with a border cell)`
          );
      }
      toText = b !== pt.cell ? `to (cell ${pt.cell}, snapped to ${b})` : `to (cell ${b})`;
    }
    if (ka >= 0 && kb >= 0 && kb <= ka)
      fail("BAD_ARGS", `${fromText} is not upstream of ${toText} on ${tag(x)}'s course; a reroute runs downstream`);
    if (ka < 0 && kb < 0)
      refuse(
        `${fromText} is off ${tag(x)}'s course and ${toText} is not on it: a reroute starts or ends on the river (a from off the course is a new source)`
      );
    if (ka < 0) {
      if (!isLandCell(a)) fail("BAD_ARGS", `${fromText} is water; a new source must be on land`);
      if (others.has(a))
        refuse(
          `${fromText} is on ${tag(others.get(a)[0])}; a new source must be off other rivers`,
          others.get(a).map(r => r.i)
        );
      notes.push(`${fromText} is off the course: it becomes the new source`);
    }
    let kept;
    if (ka >= 0 && kb >= 0) kept = new Set(xc.slice(0, ka).concat(xc.slice(kb + 1)));
    else if (ka >= 0) kept = new Set(xc.slice(0, ka));
    else kept = new Set(xc.slice(kb + 1));
    const via = (Array.isArray(v.through) ? v.through : []).map(p => placeOf(p).cell);
    const used = new Set([a]);
    const ok = c => isLandCell(c) && !kept.has(c) && !used.has(c) && !others.has(c);
    const path = [a];
    for (const s of [...via, b]) {
      const from = lastOf(path);
      const seg = shortestPath(from, s === null ? c => !!C.b[c] && ok(c) : s, ok);
      if (!seg)
        fail(
          "NO_PATH",
          `no land path from cell ${from} to ${s === null ? "the map edge" : `cell ${s}`} that avoids other rivers, water and the rest of ${tag(x)}`
        );
      for (const c of seg.slice(1)) {
        path.push(c);
        used.add(c);
      }
    }
    if (toEdge) path.push(-1);
    return { path, notes };
  }

  // ---------------------------------------------------------------- end

  const isLiteralCell = v =>
    Number.isInteger(v) || (isObj(v) && Number.isInteger(v.cell) && Object.keys(v).length === 1);

  /** Where the cut course of x ends: water, another river (a confluence) or loose land. */
  function endTarget(x, e, others) {
    const C = pack.cells;
    if (isWaterCell(e)) {
      const f = pack.features[C.f[e]];
      if (f?.type === "lake" && f.outlet && f.outlet !== x.i) {
        const o = riverOf(f.outlet);
        if (o && isDescendant(o, x))
          refuse(`${tag(x)} would end in the lake its tributary ${tag(o)} drains; a loop`, [o.i]);
      }
      return { kind: "water", feature: f };
    }
    const hosts = (others.get(e) || []).slice().sort((a, b) => a.i - b.i);
    if (hosts.length) {
      const r = hosts[0];
      if (isDescendant(r, x)) refuse(`${tag(r)} flows into ${tag(x)}; ending ${tag(x)} on it would make a loop`, [r.i]);
      return { kind: "river", r };
    }
    return { kind: "loose" };
  }

  /** Plan end:{at} for river x (nothing is mutated). */
  function planEnd(x, at) {
    const C = pack.cells;
    const xc = x.cells;
    const n = xc.length;
    const p = placeOf(at);
    let c = p.cell;
    const notes = [];
    if (c === lastOf(xc)) return { noop: true, cell: c, notes };
    const others = courseIndex(x.i);
    let k = xc.indexOf(c);
    let extra = null;
    if (k < 0 && (isWaterCell(c) || others.has(c))) {
      // another river or water next to the course: join it from the lowest course cell beside it
      for (let q = n - 2; q >= 0; q--)
        if (isLandCell(xc[q]) && C.c[xc[q]].includes(c)) {
          k = q;
          extra = c;
          break;
        }
    }
    if (k < 0 && !isLiteralCell(at)) {
      const near = nearestOnRiver(x, p, 0, n);
      if (near.k >= 0 && near.d <= snapRadius()) {
        k = near.k;
        notes.push(`at (cell ${c}) snapped to cell ${xc[k]} of the course, ${Math.round(near.d)} px away`);
        c = xc[k];
        if (k === n - 1) return { noop: true, cell: c, notes };
      }
    }
    if (k < 0)
      refuse(
        `cell ${c} is not on ${tag(x)}'s course (cells ${xc[0]}..${xc[n - 2]}) nor water or another river next to it; end takes a cell of the course (the river stops there) or a neighbouring cell of another river or of water (it joins there)`
      );
    if (!extra && isWaterCell(xc[k])) {
      // a lake the course crosses: end where the course enters it
      const f = C.f[xc[k]];
      while (k > 0 && isWaterCell(xc[k - 1]) && C.f[xc[k - 1]] === f) k--;
    }
    if (k === 0 && !extra)
      refuse(
        `cell ${xc[0]} is the source of ${tag(x)}; ending there leaves no river (remove it instead: {remove:true})`
      );
    const cellsNew = xc.slice(0, k + 1);
    if (extra !== null) cellsNew.push(extra);
    const e = lastOf(cellsNew);
    const target = endTarget(x, e, others);
    // tributaries that join below the new end lose their way
    // (one that ends where x ended, on the river x joined or in water, stays there: it then
    // joins that river, see applyEnd)
    const lost = [];
    const oldEnd = lastOf(xc);
    const endStays = isWaterCell(oldEnd) || others.has(oldEnd);
    for (const y of kids(x.i)) {
      const j = joinIndex(y, xc);
      if (j < 0 || (j === n - 1 && endStays && lastOf(y.cells) === oldEnd)) continue;
      if (j > k || (j === k && !extra && target.kind !== "water")) lost.push({ y, j: xc[j] });
    }
    if (lost.length)
      refuse(
        `${lost.map(o => `${tag(o.y)} joins ${tag(x)} at cell ${o.j}`).join(", ")}, ${lost.length === 1 ? "which is" : "which are"} at or below the new end (cell ${e}); move ${lost.length === 1 ? "it" : "them"} first (joinAt, reroute or end, an earlier op of the same call works) or end ${tag(x)} lower`,
        lost.map(o => o.y.i)
      );
    let parentAfter = x.parent;
    if (target.kind === "river") parentAfter = target.r.i;
    else if (target.kind === "water")
      parentAfter =
        target.feature?.type === "lake" && target.feature.outlet && target.feature.outlet !== x.i
          ? target.feature.outlet
          : isRootRiver(x)
            ? x.parent
            : x.i;
    const kept = new Set(cellsNew);
    const dropped = xc.filter(q => isLandCell(q) && !kept.has(q) && q !== lastOf(xc)).length;
    return { k, cell: e, extra, cellsNew, target, parentAfter, dropped, notes };
  }

  function endText(x, plan) {
    if (plan.noop) return `unchanged: ${tag(x)} already ends at cell ${plan.cell}`;
    const t = plan.target;
    const where =
      t.kind === "river"
        ? `joins ${tag(t.r)} there`
        : t.kind === "water"
          ? `flows into ${t.feature?.type === "lake" ? `lake ${t.feature.i}` : "the sea"} there`
          : "ends loose on land there (no river or water): run another river through that cell (e.g. reroute, a later op of this call) to join them";
    return `${describe(plan.cellsNew)}: ends at cell ${plan.cell}${plan.extra !== null ? " (a neighbour of the course)" : ""}, ${plan.dropped} cells dropped; ${where}${plan.notes.length ? `; ${plan.notes.join("; ")}` : ""}`;
  }

  function applyEnd(x, plan, cc) {
    const C = pack.cells;
    const prec = c => grid.cells.prec?.[C.g[c]] ?? 0;
    const sigs = signatures();
    const discharges = new Map(pack.rivers.map(r => [r, r.discharge]));
    const xOld = x.cells;
    const oldMouth = mouthOf(xOld);
    const oldDelivered = isLandCell(oldMouth) ? C.fl[oldMouth] : 0;
    const oldEnd = lastOf(xOld);
    const oldParent = isRootRiver(x) ? null : riverOf(x.parent);
    const wasRoot = isRootRiver(x);
    const pts = validPoints(x);
    x.cells = plan.cellsNew;
    if (pts && plan.extra === null) x.points = pts.slice(0, x.cells.length);
    else delete x.points;
    const touched = new Set([x]);
    // tributaries that ended where x ended now join the river (or water) there
    for (const y of kids(x.i)) {
      if (lastOf(y.cells) !== oldEnd) continue;
      const host = oldParent?.cells.includes(oldEnd) ? oldParent : null;
      y.parent = host ? host.i : y.i;
      setBasin(y, host ? (host.basin ?? Rivers.getBasin(host.i)) : y.i);
      followRole(y, false);
      touched.add(y);
      cc.notes.add(
        `${tag(y)} ended where ${tag(x)} did (cell ${oldEnd}); it now ${host ? `joins ${tag(host)}` : "flows into the water there on its own"}`
      );
    }
    // the old end stops receiving x's water; the cells x left go back to their rain
    deliverAt(oldEnd, oldParent, -oldDelivered, touched, x);
    refreshConf(oldEnd);
    const elsewhere = courseIndex(x.i);
    const keepNew = new Set(x.cells);
    for (const c of xOld) {
      if (!isLandCell(c) || keepNew.has(c) || elsewhere.has(c)) continue;
      if (pack.rivers.some(r => r !== x && lastOf(r.cells) === c)) continue;
      C.fl[c] = prec(c);
      C.conf[c] = 0;
    }
    // the new end receives it
    const t = plan.target;
    const newMouth = mouthOf(x.cells);
    const delivered = isLandCell(newMouth) ? C.fl[newMouth] : 0;
    if (t.kind === "river") {
      if (plan.extra !== null) deliverAt(plan.cell, t.r, delivered, touched, x);
      markConf(plan.cell, delivered);
    } else if (t.kind === "water" && plan.extra !== null) deliverAt(plan.cell, null, delivered, touched, x);
    x.parent = plan.parentAfter;
    setBasin(x, isRootRiver(x) ? x.i : (riverOf(x.parent)?.basin ?? Rivers.getBasin(x.parent)));
    followRole(x, wasRoot);
    refreshLakes([x], [], cc.notes);
    reown(xOld.concat(x.cells));
    for (const r of touched) restat(r, sigs);
    cc.R.add("rivers");
    cc.notes.add(
      `${tag(x)} now ends at cell ${plan.cell} (${x.cells.length} cells, ${plan.dropped} dropped), discharge ${discharges.get(x)} -> ${x.discharge}`
    );
    if (t.kind === "river" && (wasRoot || oldParent?.i !== t.r.i))
      cc.notes.add(`${tag(x)} is now a tributary of ${tag(t.r)}`);
    if (t.kind === "loose")
      cc.notes.add(
        `warning: ${tag(x)} ends loose at cell ${plan.cell} (no river or water there); reroute a river through cell ${plan.cell} to join them (lint lists rivers that do not end on their parent)`
      );
    const downstream = [...touched].filter(r => r !== x && discharges.has(r) && discharges.get(r) !== r.discharge);
    if (downstream.length)
      cc.notes.add(
        `discharge also changed on ${downstream
          .slice(0, 4)
          .map(r => `${tag(r)} ${discharges.get(r)} -> ${r.discharge}`)
          .join(", ")}${downstream.length > 4 ? `, and ${downstream.length - 4} more` : ""}`
      );
  }

  // ---------------------------------------------------------------- joinAt

  /** Plan joinAt:{river?, at, cells?} for river x: the literal lower-course reroute path and its plan. */
  function planJoinAt(x, v) {
    const _C = pack.cells;
    const yRef = v.ref ?? v.river ?? (isRootRiver(x) ? undefined : x.parent);
    if (yRef === undefined || yRef === null)
      fail("BAD_ARGS", `${tag(x)} is a main river: joinAt needs river (the river to join)`);
    const y = T.resolve("river", yRef).entity;
    if (y === x) fail("BAD_ARGS", "joinAt.river is the river to join, not this river");
    if (isDescendant(y, x)) refuse(`${tag(y)} flows into ${tag(x)}; joining it would make a loop`, [y.i]);
    const notes = [];
    let path;
    let c;
    if (Array.isArray(v.cells)) {
      path = v.cells.map(asCell);
      c = lastOf(path);
    } else {
      if (v.at === undefined || v.at === null) fail("BAD_ARGS", "joinAt is {river?: ref, at: Place | cell}");
      const yc = y.cells;
      const p = placeOf(v.at);
      c = p.cell;
      const k = yc.indexOf(c);
      if (k < 0 || k >= yc.length - 1 || !isLandCell(c)) {
        const near = isLiteralCell(v.at) ? { k: -1, d: Infinity } : nearestOnRiver(y, p, 0, yc.length - 1);
        if (near.k >= 0 && near.d <= snapRadius() && isLandCell(yc[near.k])) {
          notes.push(`at (cell ${c}) snapped to cell ${yc[near.k]} of ${tag(y)}, ${Math.round(near.d)} px away`);
          c = yc[near.k];
        } else
          refuse(
            `cell ${c} is not a land cell of ${tag(y)}'s course (cells ${yc[0]}..${yc[yc.length - 2]}); joinAt.at is the confluence cell on the river to join`,
            [y.i]
          );
      }
      if (lastOf(x.cells) === c) return { noop: true, y, c, notes, path: null };
      const xc = x.cells;
      const xs = new Set(xc);
      const others = courseIndex(x.i);
      const starts = xc.slice(0, -1).filter(isLandCell);
      const seg = shortestPath(starts, c, q => isLandCell(q) && !xs.has(q) && !others.has(q));
      if (!seg)
        fail(
          "NO_PATH",
          `no land path from ${tag(x)}'s course to cell ${c} on ${tag(y)} that avoids other rivers and water`
        );
      path = seg;
    }
    const plan = planReroute(x, path);
    if (plan.noop) return { noop: true, y, c, notes, path };
    if (plan.mode !== "lower" || plan.target?.kind !== "river")
      refuse(
        `the joinAt path does not end on ${tag(y)} (cell ${c}): it must run from ${tag(x)}'s course to a cell of ${tag(y)}`,
        [y.i]
      );
    return { y, c, notes, path, plan };
  }

  // ---------------------------------------------------------------- the fields

  const R = FIELDS.river;

  R.type = {
    check: v => {
      if (typeof v !== "string" || !v.trim())
        fail("BAD_ARGS", "type is a non-empty string, e.g. River, Creek, Brook, Stream, Fork or Branch");
      return v.trim();
    },
    get: r => r.type ?? null,
    set: (r, v) => {
      r.type = v;
    }
  };

  R.mainStem = {
    check: (v, m, c, set) => {
      onlyOne(set);
      const spec = isObj(v) && "ref" in v ? v : { ref: v };
      if (spec.expect !== undefined && typeof spec.expect !== "string")
        fail("BAD_ARGS", "mainStem.expect is the course hash a sketch recorded (a string)");
      const t = T.resolve("river", spec.ref).entity;
      const d = planOrDefer(
        c,
        m,
        `mainStem of river ${m.i}`,
        () => planMainStem(m, t),
        () => [t.i, ...kidIds(m.i), ...kidIds(t.i)]
      );
      preCourse.set(set, course(m));
      const out = { t: t.i, tName: t.name ?? null, expect: spec.expect, deferredBy: d.deferredBy };
      if (d.deferredBy !== undefined) out.after = deferredText(d.deferredBy);
      else {
        const p = d.plan;
        if (spec.expect !== undefined && hashCells(p.mCells) !== spec.expect) expectFailed(m, t, p, spec.expect);
        out.after = `${describe(p.mCells)}: ${tag(t)}'s upper course + the lower course${p.viaLake ? " (through the lake)" : ""}; the old upper course (${p.tCells.length} cells, joining at cell ${p.j}) becomes river ${t.i} '${t.name ?? ""}' (rename it with name/type if needed)${p.moves ? `; ${p.moves} tributar${p.moves === 1 ? "y" : "ies"} re-parented` : ""}`;
      }
      return out;
    },
    show: v => v.after,
    literal: v => ({ ref: v.t, expect: v.done?.expect ?? v.expect, name: v.tName }),
    get: course,
    set: (m, v, cc) => applyMainStem(m, riverOf(v.t), v, cc)
  };

  R.split = {
    check: (v, x, c, set) => {
      onlyOne(set);
      if (!isObj(v) || v.at === undefined || v.at === null)
        fail("BAD_ARGS", "split is {at: Place | cell, name?, type?}");
      const name = v.name === undefined || v.name === null ? { gen: { label: "its own culture" } } : nameSpec(v.name);
      let type = x.type ?? "River";
      if (v.type !== undefined && v.type !== null) type = R.type.check(v.type);
      const d = planOrDefer(
        c,
        x,
        `split of river ${x.i}`,
        () => splitIndex(x, v.at),
        () => kidIds(x.i)
      );
      preCourse.set(set, course(x));
      const nameText = name.text !== undefined ? `'${name.text}'` : `name generated from ${name.gen.label}`;
      const dupe =
        name.text !== undefined && pack.rivers.some(r => fold(r.name || "") === fold(name.text))
          ? ` (warning: another river is already named '${name.text}')`
          : "";
      const out = { at: v.at, name, type, deferredBy: d.deferredBy };
      if (d.deferredBy !== undefined) {
        out.after = `${deferredText(d.deferredBy)}; new upper river: ${nameText}, ${type}${dupe}`;
        return out;
      }
      const s = d.plan;
      out.cell = x.cells[s];
      out.after = `${describe(x.cells.slice(s))}; new upper river: ${describe(x.cells.slice(0, s + 1))}, ${nameText}, ${type}${dupe}`;
      return out;
    },
    show: v => v.after,
    literal: v => ({ at: { cell: v.cell }, name: v.made ?? null, type: v.type }),
    get: course,
    set: (x, v, cc) => applySplit(x, v, cc)
  };

  R.merge = {
    check: (v, u, c, set) => {
      onlyOne(set);
      if (v !== true) fail("BAD_ARGS", "merge takes true (join this river into the river it continues)");
      const d = planOrDefer(
        c,
        u,
        `merge of river ${u.i}`,
        () => planMerge(u),
        p => [p.p.i, ...kidIds(u.i)]
      );
      preCourse.set(set, course(u));
      if (d.deferredBy !== undefined) return { after: deferredText(d.deferredBy) };
      const { p } = d.plan;
      return { after: `merged into ${tag(p)}, which becomes ${describe(u.cells.slice(0, -1).concat(p.cells))}` };
    },
    show: v => v.after,
    literal: () => true,
    get: course,
    set: (u, _v, cc) => applyMerge(u, cc)
  };

  const asCell = k => (typeof k === "string" && /^-?\d+$/.test(k.trim()) ? Number(k) : k);

  R.reroute = {
    check: (v, x, c, set) => {
      onlyOne(set);
      const given = isObj(v) && Array.isArray(v.cells) ? v.cells.map(asCell) : null;
      if (!given && !(isObj(v) && v.from !== undefined && v.to !== undefined))
        fail(
          "BAD_ARGS",
          "reroute is {cells:[...]} or {from: Place, to: Place | 'edge', through?: [Place...], snap?: false, edge?: true}"
        );
      if (v.snap !== undefined && typeof v.snap !== "boolean") fail("BAD_ARGS", "reroute.snap is true or false");
      const d = planOrDefer(
        c,
        x,
        `reroute of river ${x.i}`,
        () => {
          const b = given ? { path: given, notes: [] } : buildPath(x, v);
          try {
            return { ...b, plan: planReroute(x, b.path) };
          } catch (e) {
            // say how the path was built (an end that snapped onto the course, a new source)
            if (b.notes.length && e && typeof e === "object") e.message = `${e.message} (${b.notes.join("; ")})`;
            throw e;
          }
        },
        r => [...r.plan.orphans.map(o => o.y.i), ...(r.plan.target?.kind === "river" ? [r.plan.target.r.i] : [])]
      );
      preCourse.set(set, course(x));
      if (d.deferredBy !== undefined) return { spec: v, cells: given, after: deferredText(d.deferredBy) };
      const { path, notes, plan } = d.plan;
      return { spec: v, cells: path, snaps: notes, after: rerouteText(x, plan, notes) };
    },
    show: v => v.after,
    literal: v => ({ cells: v.cells }),
    get: course,
    set: (x, v, cc) => {
      if (!pack.rivers.includes(x)) refuse(`${tag(x)} no longer exists (an earlier op of this call merged it)`);
      if (!v.cells) {
        const b = buildPath(x, v.spec);
        v.cells = b.path;
        v.snaps = b.notes;
      }
      for (const s of v.snaps ?? []) cc.notes.add(`${tag(x)}: ${s}`);
      applyReroute(x, v.cells, cc);
    }
  };

  R.end = {
    check: (v, x, c, set) => {
      onlyOne(set);
      const at = isObj(v) && "at" in v ? v.at : undefined;
      if (at === undefined || at === null) fail("BAD_ARGS", "end is {at: Place | cell}");
      const d = planOrDefer(
        c,
        x,
        `end of river ${x.i}`,
        () => planEnd(x, at),
        pl => [...kidIds(x.i), ...(pl.target?.kind === "river" ? [pl.target.r.i] : [])]
      );
      preCourse.set(set, course(x));
      if (d.deferredBy !== undefined) return { at, after: deferredText(d.deferredBy) };
      return { at, cell: d.plan.cell, noop: !!d.plan.noop, after: endText(x, d.plan) };
    },
    show: v => v.after,
    literal: v => ({ at: { cell: v.cell } }),
    get: course,
    set: (x, v, cc) => {
      if (!pack.rivers.includes(x)) refuse(`${tag(x)} no longer exists (an earlier op of this call merged it)`);
      const plan = planEnd(x, v.cell ?? v.at);
      v.cell = plan.cell;
      if (plan.noop) {
        cc.notes.add(endText(x, plan));
        return;
      }
      for (const s of plan.notes) cc.notes.add(`${tag(x)}: ${s}`);
      applyEnd(x, plan, cc);
    }
  };

  R.joinAt = {
    check: (v, x, c, set) => {
      onlyOne(set);
      if (!isObj(v) || (v.at === undefined && !Array.isArray(v.cells)))
        fail("BAD_ARGS", "joinAt is {river?: ref (default: its parent), at: Place | cell}");
      const d = planOrDefer(
        c,
        x,
        `joinAt of river ${x.i}`,
        () => planJoinAt(x, v),
        j => [
          j.y.i,
          ...(j.plan ? j.plan.orphans.map(o => o.y.i) : []),
          ...(j.plan ? j.plan.captured.map(o => o.y.i) : [])
        ]
      );
      preCourse.set(set, course(x));
      if (d.deferredBy !== undefined) return { spec: v, after: deferredText(d.deferredBy) };
      const j = d.plan;
      const after = j.noop
        ? `unchanged: ${tag(x)} already joins ${tag(j.y)} at cell ${j.c}`
        : `joins ${tag(j.y)} at cell ${j.c}: ${rerouteText(x, j.plan, j.notes)}`;
      return { spec: v, ref: j.y.i, cell: j.c, cells: j.path, noop: !!j.noop, after };
    },
    show: v => v.after,
    literal: v => ({ ref: v.ref, at: { cell: v.cell }, cells: v.cells }),
    get: course,
    set: (x, v, cc) => {
      if (!pack.rivers.includes(x)) refuse(`${tag(x)} no longer exists (an earlier op of this call merged it)`);
      const j = planJoinAt(x, v.cells ? { ref: v.ref, cells: v.cells } : v.spec);
      Object.assign(v, { ref: j.y.i, cell: j.c, cells: j.path });
      for (const s of j.notes) cc.notes.add(`${tag(x)}: ${s}`);
      if (j.noop) {
        cc.notes.add(`unchanged: ${tag(x)} already joins ${tag(j.y)} at cell ${j.c}`);
        return;
      }
      applyReroute(x, j.path, cc);
    }
  };

  // ---------------------------------------------------------------- wrappers

  // A structural river edit stores literal cell lists: record the cell graph they refer to, so a
  // replay onto a renumbered map (a heightmap rebuild) is a conflict instead of a wrong edit. Its
  // resolved `before` is the course before the call, which is what a replay's validation sees,
  // also when an earlier op of the call changed that river.
  const coreEdit = T.fns.edit;
  T.fns.edit = async a => {
    const out = await coreEdit(a);
    if (a?.type !== "river" || !out || out.phase || !Array.isArray(out.resolved?.ops)) return out;
    let structural = false;
    out.resolved.ops.forEach((o, j) => {
      const key = STRUCT.find(k => o.set && k in o.set);
      if (!key) return;
      structural = true;
      const set = a.ops?.[out.applied?.[j]?.index]?.set;
      const was = isObj(set) ? preCourse.get(set) : undefined;
      if (was !== undefined && isObj(o.before) && key in o.before) o.before[key] = was;
    });
    if (structural) {
      const g = T.cellGraph?.();
      if (g) out.resolved.graph = g;
    }
    return out;
  };

  /** Where a tributary ends (its junction on the parent, or the lake cell it ends in); null for a main river. */
  const joinsAt = r => (isRootRiver(r) ? null : (lastOf(r.cells || []) ?? null));
  const later = (out, post) => (out && typeof out.then === "function" ? out.then(post) : post(out));

  // find river fields:['joinsAt', 'tributaries' (count)]
  const coreFind = T.fns.find;
  T.addFindFields?.("river", ["joinsAt", "tributaries"]);
  T.fns.find = a =>
    later(coreFind(a), out => {
      const want = Array.isArray(a?.fields) ? a.fields.filter(f => f === "joinsAt" || f === "tributaries") : [];
      if (out?.type !== "river" || !want.length || !Array.isArray(out.rows)) return out;
      const counts = new Map();
      for (const r of pack.rivers) if (!isRootRiver(r)) counts.set(r.parent, (counts.get(r.parent) ?? 0) + 1);
      for (const row of out.rows) {
        const r = riverOf(row.i);
        if (!r) continue;
        if (want.includes("joinsAt")) row.joinsAt = joinsAt(r);
        if (want.includes("tributaries")) row.tributaries = counts.get(r.i) ?? 0;
      }
      return out;
    });

  // inspect river: relations.joinsAt, tributaryCount and tributaries [{i, name, joinsAt}]
  const coreInspect = T.fns.inspect;
  T.fns.inspect = a =>
    later(coreInspect(a), out => {
      if (out?.kind !== "entity" || out.type !== "river" || !isObj(out.relations)) return out;
      const r = riverOf(out.i);
      if (!r) return out;
      const ks = kids(r.i);
      out.relations.joinsAt = joinsAt(r);
      out.relations.tributaryCount = ks.length;
      out.relations.tributaries = ks.slice(0, 25).map(k => ({ i: k.i, name: k.name ?? null, joinsAt: joinsAt(k) }));
      return out;
    });
})(globalThis);
