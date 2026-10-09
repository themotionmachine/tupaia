// Tupaia MCP bridge extension (track 'rivers'): river structure edits on `edit river`.
//   mainStem: <tributary ref>           make that tributary's course the river's main stem: its
//                                       upper course + the river's lower course keep the river's
//                                       id and name; the river's old upper course moves to the
//                                       tributary's id (still a tributary of the river)
//   split: {at: Place|cell, name?, type?}
//                                       cut the river at a cell: the upper part becomes a new
//                                       river (parent = this one), this one keeps the lower part
//   merge: true                         join this river into the river it continues (it ends at
//                                       its parent's source, as after a split): the inverse
//   reroute: {cells:[...]} | {from: Place, to: Place, through?: [Place...]}
//                                       run a stretch of the river through other cells
// Each op keeps pack.rivers, cells.r (the lowest river id owns a shared cell, as
// Rivers.generate does), cells.fl, cells.conf, tributary parents and basins, and lake
// inlets/outlets consistent, recomputes source, mouth, discharge, length and width the way
// Rivers.generate does, and redraws the rivers layer. The resolved (replayable) form is literal:
// mainStem is the tributary's id (replay maps it when the sketch created that river), split
// {at:{cell}, name, type}, merge true, reroute {cells}. A split reports the river it created.
// Same rules as bridge-mutations.js: bare app globals at call time, no locals that shadow app
// globals (rivers, cells, lakes, notes, ...), one args object per FNS function.
(root => {
  const T = root.__tupaia;
  if (!T?.mutations?.FIELDS?.river) return;
  const fail = T.fail;
  const FIELDS = T.mutations.FIELDS;
  const nameSpec = T.mutations.nameSpec;

  const STRUCT = ["mainStem", "split", "merge", "reroute"];
  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
  const rn2 = v => Math.round(v * 100) / 100;
  const isLandCell = c => Number.isInteger(c) && c >= 0 && pack.cells.h[c] >= 20;
  const isWaterCell = c => Number.isInteger(c) && c >= 0 && pack.cells.h[c] < 20;
  const isRootRiver = r => !r.parent || r.parent === r.i;
  const riverOf = id => (pack.rivers || []).find(r => r.i === id) || null;
  const tag = r => `${r.name || "river"} (${r.i})`;
  const lastOf = list => list[list.length - 1];

  function hashCells(list) {
    let h = 0x811c9dc5;
    const s = list.join(",");
    for (let k = 0; k < s.length; k++) {
      h ^= s.charCodeAt(k);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  /** One-line course: "<n> cells <source>-><mouth>[ into river <parent>] #<hash>". */
  function describe(list, parent, id) {
    const n = list.length;
    const mouth = n > 1 ? list[n - 2] : list[0];
    const into = parent && parent !== id ? ` into river ${parent}` : "";
    return `${n} cells ${list[0]}->${mouth}${into} #${hashCells(list)}`;
  }

  /** get() of the structural fields: the river's course (a merged river is out of the list). */
  function course(r) {
    if (!(pack.rivers || []).includes(r)) return `merged into river ${r.parent}`;
    return describe(r.cells || [], r.parent, r.i);
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

  /** Re-parent tributaries of re-cut rivers: owner(oldId, index in its old course) -> new id. */
  function reassignChildren(old, owner, skip, out) {
    for (const r of pack.rivers) {
      if (skip.has(r.i) || isRootRiver(r) || !old.has(r.parent)) continue;
      const k = joinIndex(r, old.get(r.parent));
      if (k < 0) {
        out.add(`${tag(r)}: could not tell where it joins river ${r.parent}; its parent was left as is`);
        continue;
      }
      r.parent = owner(r.parent, k);
    }
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

  /** source, mouth, discharge, length and width as Rivers.generate computes them. */
  function restat(r) {
    const n = r.cells.length;
    r.source = r.cells[0];
    r.mouth = n > 1 ? r.cells[n - 2] : r.cells[0];
    if (Array.isArray(r.points) && r.points.length !== n) delete r.points;
    const pts = Rivers.addMeandering(r.cells, r.points ?? null);
    r.discharge = pack.cells.fl[r.mouth] ?? 0;
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

  /** Add `delta` flux from r.cells[from] downstream, through parents, until water or the map edge. */
  function propagate(r, from, delta, touched) {
    const C = pack.cells;
    let cur = r;
    let k = from;
    for (let guard = 0; cur && delta && guard < 1000; guard++) {
      touched.add(cur);
      let reachedEnd = true;
      for (; k < cur.cells.length; k++) {
        const c = cur.cells[k];
        if (!isLandCell(c)) {
          reachedEnd = false;
          break;
        }
        C.fl[c] = Math.max(0, Math.min(65535, C.fl[c] + delta));
      }
      if (!reachedEnd) break;
      // the last cell is the junction on the parent (already updated): continue below it
      const parent = isRootRiver(cur) ? null : riverOf(cur.parent);
      const pk = parent ? parent.cells.indexOf(lastOf(cur.cells)) : -1;
      if (pk < 0) break;
      cur = parent;
      k = pk + 1;
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

  /** Rivers.generate gives a main stem 1.2x the default width factor; follow a role change. */
  function followRole(r, wasRoot) {
    const nowRoot = isRootRiver(r);
    const cellsDesired = Number(document.getElementById("pointsInput")?.dataset?.cells) || 10000;
    if (wasRoot === nowRoot) return;
    const base = rn2(1 / (cellsDesired / 10000) ** 0.25);
    const main = base * 1.2;
    if (wasRoot && Math.abs(r.widthFactor - main) < 0.011) r.widthFactor = base;
    else if (!wasRoot && Math.abs(r.widthFactor - base) < 0.011) r.widthFactor = main;
  }

  // ---------------------------------------------------------------- batch checks

  function onlyOne(set) {
    const keys = STRUCT.filter(k => set && k in set);
    if (keys.length > 1)
      fail("BAD_ARGS", `one structural river change per op (got ${keys.join(", ")}); put them in separate calls`);
  }

  /**
   * Every op in a batch validates against the map as it was before the batch, so two
   * structural ops that touch the same river cannot share a call.
   */
  function claim(c, ids, what) {
    if (!c.riverClaims) c.riverClaims = new Map();
    for (const id of ids) {
      const prev = c.riverClaims.get(id);
      if (prev !== undefined)
        fail(
          "REFUSED",
          `river ${id} is already restructured by the ${prev} in this call; make structural changes that touch the same rivers in separate edit calls`
        );
    }
    for (const id of new Set(ids)) c.riverClaims.set(id, what);
  }

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
    if (t === m) fail("BAD_ARGS", "mainStem is a tributary of this river, not the river itself");
    if (isRootRiver(t) || t.parent !== m.i)
      fail(
        "REFUSED",
        `${tag(t)} is not a tributary of ${tag(m)} (its parent is ${isRootRiver(t) ? "none" : t.parent}); mainStem takes a direct tributary`
      );
    const j = lastOf(t.cells);
    const k = m.cells.indexOf(j);
    if (k < 0 || t.cells.length < 2)
      fail(
        "REFUSED",
        `${tag(t)} does not end on ${tag(m)}'s course (it joins through a lake, or was edited); mainStem needs a shared junction cell`
      );
    if (k === 0)
      fail(
        "REFUSED",
        `${tag(t)} joins at ${tag(m)}'s source, so it already continues it; use merge:true on ${tag(t)} instead`
      );
    return { k, j, mCells: t.cells.slice(0, -1).concat(m.cells.slice(k)), tCells: m.cells.slice(0, k + 1) };
  }

  function applyMainStem(m, t, cc) {
    if (!t) fail("NOT_FOUND", "the tributary of mainStem no longer exists");
    const plan = planMainStem(m, t);
    const mOld = m.cells;
    const tOld = t.cells;
    const mPts = validPoints(m);
    const tPts = validPoints(t);
    m.cells = plan.mCells;
    t.cells = plan.tCells;
    if (mPts && tPts) {
      m.points = tPts.slice(0, -1).concat(mPts.slice(plan.k));
      t.points = mPts.slice(0, plan.k + 1);
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
    const owner = (id, k) => (id === m.i && k < plan.k ? t.i : m.i);
    reassignChildren(old, owner, new Set([m.i, t.i]), cc.notes);
    refreshLakes([m, t], [], cc.notes);
    reown(mOld.concat(tOld));
    restat(m);
    restat(t);
    cc.R.add("rivers");
    cc.notes.add(
      `${tag(m)} now rises at cell ${m.source} (${m.cells.length} cells); ${tag(t)} holds its old upper course (${t.cells.length} cells, joining at cell ${plan.j}): rename it with name/type if needed`
    );
  }

  // ---------------------------------------------------------------- split

  function splitIndex(x, at) {
    const p = placeOf(at);
    const n = x.cells.length;
    let s = x.cells.indexOf(p.cell);
    if (s === 0) fail("REFUSED", `cell ${p.cell} is the source of ${tag(x)}; split at a cell further down`);
    if (s >= n - 1)
      fail("REFUSED", `cell ${p.cell} is where ${tag(x)} ends (its mouth water or junction); split at a cell above it`);
    if (s < 0) {
      const near = nearestOnRiver(x, p, 1, n - 1);
      if (near.k < 0 || near.d > snapRadius())
        fail(
          "REFUSED",
          `the split place (${p.x}, ${p.y}) is ${Math.round(near.d)} px from ${tag(x)}'s course; pass a cell of its course or {entity:{type:'river', ref:${x.i}}, at:0..1}`
        );
      s = near.k;
    }
    if (!isLandCell(x.cells[s])) fail("REFUSED", `cell ${x.cells[s]} is in a lake; split at a land cell`);
    return s;
  }

  function applySplit(x, v, cc) {
    const s = x.cells.indexOf(v.cell);
    if (s < 1 || s > x.cells.length - 2) fail("REFUSED", `cell ${v.cell} is no longer inside ${tag(x)}'s course`);
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
    reassignChildren(old, owner, new Set([x.i, u.i]), cc.notes);
    refreshLakes([x, u], [], cc.notes);
    reown(xOld);
    restat(x);
    restat(u);
    FIELDS.river.name.set(u, v.name, cc); // literal text, or generated from the upper part's culture
    v.made = u.name;
    cc.created.push({ type: "river", i: u.i, name: u.name });
    cc.R.add("rivers");
    cc.notes.add(
      `${tag(x)} now starts at cell ${v.cell} (${x.cells.length} cells); its upper course is the new river ${tag(u)} (${u.cells.length} cells, parent ${x.i})`
    );
  }

  // ---------------------------------------------------------------- merge

  function planMerge(u) {
    if (isRootRiver(u)) fail("REFUSED", `${tag(u)} has no parent river to merge into`);
    const p = riverOf(u.parent);
    if (!p) fail("REFUSED", `${tag(u)}'s parent river ${u.parent} does not exist`);
    const j = lastOf(u.cells);
    if (j !== p.cells[0]) {
      const k = p.cells.indexOf(j);
      fail(
        "REFUSED",
        k > 0
          ? `${tag(u)} joins ${tag(p)} mid-course (cell ${j}); merge joins a river into the river it continues (one that ends at its parent's source, as after split). To make ${tag(u)} the main stem use edit river ${p.i} {mainStem: ${u.i}}`
          : `${tag(u)} does not end at ${tag(p)}'s source (cell ${p.cells[0]}); merge joins a river into the river it continues`
      );
    }
    return { p, j };
  }

  function applyMerge(u, cc) {
    const { p } = planMerge(u);
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
    restat(p);
    cc.R.add("rivers");
    cc.notes.add(`${tag(u)} merged into ${tag(p)}, which now rises at cell ${p.source} (${p.cells.length} cells)`);
    if ((notes || []).some(n => n.id === `river${u.i}`))
      cc.notes.add(
        `note river${u.i} now has no river; re-attach it with add note {entity:{type:'river', ref:${p.i}}} or remove it`
      );
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
        fail("BAD_ARGS", `cells ${a} and ${b} are not neighbours; reroute cells must be contiguous`);
    }
    const xc = x.cells;
    const n = xc.length;
    const first = path[0];
    const last = lastOf(path);
    const ia = xc.indexOf(first);
    const ib = last === -1 ? (xc[n - 1] === -1 ? n - 1 : -1) : xc.lastIndexOf(last);
    if (ia === n - 1)
      fail(
        "REFUSED",
        `cell ${first} is where ${tag(x)} ends (its mouth water or junction); start the reroute above it`
      );
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
      if (isWaterCell(xc[0]))
        fail("REFUSED", `${tag(x)} flows out of a lake; a new source would cut it off from the lake`);
      cellsNew = path.concat(xc.slice(ib + 1));
      kept = xc.slice(ib + 1);
    } else
      fail(
        "REFUSED",
        `a reroute starts or ends on ${tag(x)}'s course (cells ${xc[0]}..${xc[n - 2]}); neither ${first} nor ${last} is on it`
      );
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
            fail("REFUSED", `${tag(x)} would flow into the lake it (or its tributary ${tag(o)}) drains; a loop`);
        }
      } else {
        const hosts = (others.get(last) || []).slice().sort((a, b) => a.i - b.i);
        if (!hosts.length)
          fail(
            "REFUSED",
            `the path ends at cell ${last}, which is not on ${tag(x)}, on another river (a confluence), in water or off the map edge`
          );
        const r = hosts[0];
        if (isDescendant(r, x)) fail("REFUSED", `${tag(r)} flows into ${tag(x)}; joining it would make a loop`);
        target = { kind: "river", r, k: r.cells.indexOf(last) };
      }
    }

    // interior cells: land, not on the kept course (a loop), not on another river (a crossing)
    path.forEach((c, k) => {
      if (k === 0 && ia >= 0) return;
      if (k === path.length - 1 && (ib >= 0 || mode === "lower")) return;
      if (!isLandCell(c))
        fail("REFUSED", `cell ${c} is water; a reroute can end in water (a new mouth) but not cross it`);
      if (keptSet.has(c))
        fail("REFUSED", `cell ${c} is already on ${tag(x)} outside the rerouted stretch; the path would loop`);
      const crossed = others.get(c);
      if (crossed)
        fail(
          "REFUSED",
          `cell ${c} is on ${tag(crossed[0])}; a reroute cannot cross another river (it may end on one, as a confluence)`
        );
    });

    const climbs = [];
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1];
      const b = path[k];
      if (isLandCell(a) && isLandCell(b) && C.h[b] > C.h[a]) climbs.push(`${a} (h${C.h[a]}) -> ${b} (h${C.h[b]})`);
    }

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
        fail(
          "REFUSED",
          `tributary ${tag(y)} joins ${tag(x)} at cell ${j}, which the new course drops, and no cell of the new course neighbours it; run the path through or next to cell ${j}, or reroute ${tag(y)} first`
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

    let parentAfter = x.parent;
    if (target) {
      if (target.kind === "river") parentAfter = target.r.i;
      else if (target.kind === "water" && target.feature?.type === "lake" && target.feature.outlet)
        parentAfter = target.feature.outlet;
      else parentAfter = 0;
    }
    return { mode, ia, ib, path, cellsNew, target, orphans, climbs, parentAfter };
  }

  function applyReroute(x, path, cc) {
    const C = pack.cells;
    const plan = planReroute(x, path);
    const xOld = x.cells;
    const oldDelivered = C.fl[x.mouth] ?? 0;
    const oldEnd = lastOf(xOld);
    const oldParent = isRootRiver(x) ? null : riverOf(x.parent);
    const wasRoot = isRootRiver(x);
    const prec = c => grid.cells.prec?.[C.g[c]] ?? 0;

    // flux along the new cells: each cell's own drainage plus what flows in from upstream
    const posOld = new Map(xOld.map((c, k) => [c, k]));
    const own = c => {
      const k = posOld.get(c);
      if (k > 0 && isLandCell(xOld[k - 1])) return Math.max(0, C.fl[c] - C.fl[xOld[k - 1]]);
      return C.fl[c];
    };
    const newFl = new Map();
    let flowing = C.fl[path[0]];
    for (let k = 1; k < path.length - 1; k++) {
      flowing = Math.min(65535, own(path[k]) + flowing);
      newFl.set(path[k], flowing);
    }
    // inflow into the end cell before and after (a stretch or upper-course reroute ends on x)
    const endCell = lastOf(path);
    const kb = xOld.lastIndexOf(endCell);
    const oldInflow = kb > 0 && isLandCell(xOld[kb - 1]) ? C.fl[xOld[kb - 1]] : 0;

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
    // 2. cells the river left: no longer on any river -> back to precipitation (as Rivers.remove)
    const elsewhere = courseIndex(x.i);
    for (const c of dropped) {
      if (orphanEnds.has(c)) continue;
      if (!elsewhere.has(c) && !pack.rivers.some(r => r !== x && lastOf(r.cells) === c)) C.fl[c] = prec(c);
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
    if (plan.mode !== "lower" && isLandCell(endCell)) {
      const k = x.cells.lastIndexOf(endCell);
      propagate(x, k, flowing - oldInflow, touched);
    }
    for (const o of carriers) {
      propagate(x, x.cells.indexOf(o.to), C.fl[o.j], touched);
      markConf(o.to, C.fl[o.j]);
      refreshConf(o.j);
    }
    if (plan.mode === "lower") {
      // the old end stops receiving x's water, the new end starts
      if (oldParent && isLandCell(oldEnd)) {
        const k = oldParent.cells.indexOf(oldEnd);
        if (k >= 0) propagate(oldParent, k, -oldDelivered, touched);
        refreshConf(oldEnd);
      }
      const t = plan.target;
      const delivered = C.fl[x.cells[x.cells.length - 2]] ?? 0;
      if (t.kind === "river") {
        propagate(t.r, t.k, delivered, touched);
        markConf(lastOf(x.cells), delivered);
      }
      x.parent = plan.parentAfter;
      setBasin(x, x.parent ? (riverOf(x.parent)?.basin ?? Rivers.getBasin(x.parent)) : x.i);
      followRole(x, wasRoot);
      if (wasRoot !== isRootRiver(x) || (oldParent && oldParent.i !== x.parent))
        cc.notes.add(
          x.parent
            ? `${tag(x)} is now a tributary of river ${x.parent} (width factor ${x.widthFactor})`
            : `${tag(x)} now reaches ${t.kind === "edge" ? "the map edge" : "the sea or a lake"} on its own (width factor ${x.widthFactor})`
        );
    }
    // 5. lakes: x may enter a lake now (a new mouth) or no longer touch one
    refreshLakes([x, ...carriers.map(o => o.y)], [], cc.notes);
    reown(
      xOld.concat(
        x.cells,
        plan.orphans.flatMap(o => [o.j, o.to])
      )
    );
    // a new source gets the generator's source width for its flux
    if (plan.mode === "upper") x.sourceWidth = Rivers.getSourceWidth(C.fl[x.cells[0]]);
    for (const r of touched) restat(r);
    cc.R.add("rivers");
    const added = x.cells.filter(c => isLandCell(c) && !posOld.has(c)).length;
    cc.notes.add(
      `${tag(x)} rerouted (${plan.mode}): ${dropped.length} cells left, ${added} cells joined; now ${x.cells.length} cells, discharge ${x.discharge}`
    );
    if (plan.climbs.length)
      cc.notes.add(
        `warning: the new course of ${tag(x)} climbs at ${plan.climbs.length} step(s): ${plan.climbs.slice(0, 3).join(", ")}${plan.climbs.length > 3 ? ", ..." : ""}`
      );
  }

  /** Cheapest land path from `a` to `b` (uphill steps cost more); `ok(c)` filters cells. */
  function shortestPath(a, b, ok) {
    const C = pack.cells;
    if (a === b) return [a];
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
    dist[a] = 0;
    push(0, a);
    while (heap.length) {
      const [d, u] = pop();
      if (d > dist[u]) continue;
      if (u === b) break;
      for (const v of C.c[u]) {
        if (v !== b && !ok(v)) continue;
        const climb = Math.max(0, C.h[v] - C.h[u]);
        const w = Math.hypot(C.p[v][0] - C.p[u][0], C.p[v][1] - C.p[u][1]) * (1 + climb);
        if (d + w < dist[v]) {
          dist[v] = d + w;
          prev[v] = u;
          push(d + w, v);
        }
      }
    }
    if (dist[b] === Infinity) return null;
    const out = [b];
    for (let c = prev[b]; c >= 0; c = prev[c]) out.push(c);
    return out.reverse();
  }

  /** Literal reroute cells for {from, to, through}: ends snap to the river's course when near it. */
  function buildPath(x, v) {
    const _C = pack.cells;
    const xc = x.cells;
    const n = xc.length;
    const pf = placeOf(v.from);
    const pt = placeOf(v.to);
    const via = (Array.isArray(v.through) ? v.through : []).map(p => placeOf(p).cell);
    const others = courseIndex(x.i);
    let a = pf.cell;
    let ka = xc.indexOf(a);
    if (ka < 0 || ka > n - 2) {
      const near = nearestOnRiver(x, pf, 0, n - 1);
      if (near.k >= 0 && near.d <= snapRadius()) {
        a = xc[near.k];
        ka = near.k;
      } else ka = -1; // a new source
    }
    let b = pt.cell;
    let kb = xc.lastIndexOf(b);
    if (kb < 0 && !others.has(b) && !isWaterCell(b)) {
      const near = nearestOnRiver(x, pt, 0, n);
      if (near.k >= 0 && near.d <= snapRadius()) {
        b = xc[near.k];
        kb = near.k;
      } else
        fail(
          "REFUSED",
          `to (cell ${b}) is not on ${tag(x)}, on another river or in water; a reroute ends on the river, at a confluence or at a new mouth`
        );
    }
    if (ka >= 0 && kb >= 0 && kb <= ka)
      fail(
        "BAD_ARGS",
        `from (cell ${a}) is not upstream of to (cell ${b}) on ${tag(x)}'s course; a reroute runs downstream`
      );
    let kept;
    if (ka >= 0 && kb >= 0) kept = new Set(xc.slice(0, ka).concat(xc.slice(kb + 1)));
    else if (ka >= 0) kept = new Set(xc.slice(0, ka));
    else if (kb >= 0) kept = new Set(xc.slice(kb + 1));
    else fail("REFUSED", `from or to must be on (or within ${Math.round(snapRadius())} px of) ${tag(x)}'s course`);
    const stops = [a, ...via, b];
    const used = new Set([a]);
    const path = [a];
    for (let w = 1; w < stops.length; w++) {
      const seg = shortestPath(
        stops[w - 1],
        stops[w],
        c => isLandCell(c) && !kept.has(c) && !used.has(c) && !others.has(c)
      );
      if (!seg)
        fail(
          "NO_PATH",
          `no land path from cell ${stops[w - 1]} to cell ${stops[w]} that avoids other rivers, water and the rest of ${tag(x)}`
        );
      for (const c of seg.slice(1)) {
        path.push(c);
        used.add(c);
      }
    }
    return path;
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
      const t = T.resolve("river", v).entity;
      const plan = planMainStem(m, t);
      claim(c, [m.i, t.i], `mainStem of river ${m.i}`);
      return { t: t.i, after: describe(plan.mCells, m.parent, m.i) };
    },
    show: v => v.after,
    literal: v => v.t,
    get: course,
    set: (m, v, cc) => applyMainStem(m, riverOf(v.t), cc)
  };

  R.split = {
    check: (v, x, c, set) => {
      onlyOne(set);
      if (!isObj(v) || v.at === undefined || v.at === null)
        fail("BAD_ARGS", "split is {at: Place | cell, name?, type?}");
      const s = splitIndex(x, v.at);
      const name = v.name === undefined || v.name === null ? { gen: { label: "its own culture" } } : nameSpec(v.name);
      let type = x.type ?? "River";
      if (v.type !== undefined && v.type !== null) type = R.type.check(v.type);
      claim(c, [x.i], `split of river ${x.i}`);
      const up = x.cells.slice(0, s + 1);
      return {
        cell: x.cells[s],
        name,
        type,
        after: describe(x.cells.slice(s), x.parent, x.i),
        upper: `${describe(up, x.i, -1)}, ${name.text !== undefined ? `'${name.text}'` : `name generated from ${name.gen.label}`}, ${type}`
      };
    },
    show: v => `${v.after}; new upper river: ${v.upper}`,
    literal: v => ({ at: { cell: v.cell }, name: v.made ?? null, type: v.type }),
    get: course,
    set: (x, v, cc) => applySplit(x, v, cc)
  };

  R.merge = {
    check: (v, u, c, set) => {
      onlyOne(set);
      if (v !== true) fail("BAD_ARGS", "merge takes true (join this river into the river it continues)");
      const { p } = planMerge(u);
      claim(c, [u.i, p.i], `merge of river ${u.i}`);
      return {
        p: p.i,
        after: `merged into river ${p.i}: ${describe(u.cells.slice(0, -1).concat(p.cells), p.parent, p.i)}`
      };
    },
    show: v => v.after,
    literal: () => true,
    get: course,
    set: (u, _v, cc) => applyMerge(u, cc)
  };

  R.reroute = {
    check: (v, x, c, set) => {
      onlyOne(set);
      let path;
      if (isObj(v) && Array.isArray(v.cells))
        path = v.cells.map(k => (typeof k === "string" && /^-?\d+$/.test(k.trim()) ? Number(k) : k));
      else if (isObj(v) && v.from !== undefined && v.to !== undefined) path = buildPath(x, v);
      else fail("BAD_ARGS", "reroute is {cells:[...]} or {from: Place, to: Place, through?: [Place...]}");
      const plan = planReroute(x, path);
      const ids = [x.i, ...plan.orphans.map(o => o.y.i)];
      if (plan.target?.kind === "river") ids.push(plan.target.r.i);
      claim(c, ids, `reroute of river ${x.i}`);
      const climbs = plan.climbs.length ? ` (climbs at ${plan.climbs.length} step(s): ${plan.climbs[0]}...)` : "";
      return { cells: path, after: `${describe(plan.cellsNew, plan.parentAfter, x.i)}${climbs}` };
    },
    show: v => v.after,
    literal: v => ({ cells: v.cells }),
    get: course,
    set: (x, v, cc) => applyReroute(x, v.cells, cc)
  };

  // A structural river edit stores literal cell lists: record the cell graph they refer to, so a
  // replay onto a renumbered map (a heightmap rebuild) is a conflict instead of a wrong edit.
  const coreEdit = T.fns.edit;
  T.fns.edit = async a => {
    const out = await coreEdit(a);
    if (
      a?.type === "river" &&
      out &&
      !out.phase &&
      out.resolved?.ops?.some(o => o.set && STRUCT.some(k => k in o.set))
    ) {
      const g = T.cellGraph?.();
      if (g) out.resolved.graph = g;
    }
    return out;
  };
})(globalThis);
