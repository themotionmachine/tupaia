// Tupaia MCP bridge extension (track 'clear'): entity removal with the app's own cascades, and
// the bulk `clear` function. Injected after bridge.js and bridge-mutations.js; same rules as
// those: app globals by bare name at call time, no locals that shadow app globals (labels,
// routes, markers, zones, rivers, notes, cells, emblems, ...), one args object per FNS function.
//
// - edit {remove:true} for province, culture and religion: ports of the editors' remove
//   functions (cells fall back to 0, tombstones, emblems, DOM, origins).
// - edit {remove:true} for state: a port of states-editor stateRemove that redraws through the
//   batch (the app's own re-renders every state's emblem per removal, in the background).
// - edit burg {remove:true, force:true, newCapital?, orphanRoutes?}: removes capitals and
//   market centres too, moving what depends on the burg (state capital, province capital,
//   its market, deals). Every burg removal keeps those dependants consistent.
// - Route integrity: removing burgs or routes sweeps pack.cells.routes (once per call) so every
//   link names a live route on which the two cells are consecutive, and every consecutive pair
//   has a link.
// - FNS.clear: bulk removal by type in dependency order, honouring keep refs and locks.
(root => {
  const T = root.__tupaia;
  if (!T?.mutations) return;
  const FNS = T.fns;
  const fail = T.fail;
  const I = T.internals;
  const M = T.mutations;
  const { REMOVE, NO_REMOVE } = M;
  const hashStr = T.pure.hashStr;

  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
  const alive = x => !!x && typeof x === "object" && !x.removed;
  const sel = (g, q) => (g && typeof g.select === "function" ? g.select(q).remove() : null);
  const layerOn = toggle => typeof layerIsOn === "function" && layerIsOn(toggle);
  /** o[k], created with make() when missing. */
  const slot = (o, k, make) => {
    if (o[k] === undefined) o[k] = make();
    return o[k];
  };
  const dealCount = () => (Array.isArray(pack.deals) ? pack.deals.length : 0);
  const noteCount = () => (typeof notes !== "undefined" && Array.isArray(notes) ? notes.length : 0);

  // ---------------------------------------------------------------- notes

  /** Remove the notes with these ids (in place: other scripts hold the array). */
  function dropNotes(ids) {
    const set = new Set(ids);
    if (!set.size || typeof notes === "undefined" || !Array.isArray(notes)) return 0;
    const kept = notes.filter(n => !(n && set.has(n.id)));
    const n = notes.length - kept.length;
    if (n) {
      notes.length = 0;
      for (const x of kept) notes.push(x);
    }
    return n;
  }

  // ---------------------------------------------------------------- routes

  /** Consecutive distinct cell pairs of a route's points. */
  function routePairs(r) {
    const out = [];
    const pts = Array.isArray(r?.points) ? r.points : [];
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k]?.[2];
      const b = pts[k + 1]?.[2];
      if (Number.isInteger(a) && Number.isInteger(b) && a !== b) out.push([a, b]);
    }
    return out;
  }

  /**
   * Make pack.cells.routes ({cell: {neighbourCell: routeId}}) match pack.routes: drop links whose
   * route is gone or on which the two cells are not consecutive, drop emptied maps, and add the
   * missing link of every consecutive pair (existing valid links keep their route id).
   */
  function sweepRouteLinks() {
    const C = pack.cells;
    if (!C.routes || typeof C.routes !== "object") C.routes = {};
    const L = C.routes;
    const pairs = new Map();
    for (const r of pack.routes || []) {
      const s = new Set();
      for (const [a, b] of routePairs(r)) {
        s.add(`${a},${b}`);
        s.add(`${b},${a}`);
      }
      pairs.set(r.i, s);
    }
    let removed = 0;
    let added = 0;
    for (const from of Object.keys(L)) {
      const m = L[from];
      if (!m || typeof m !== "object") {
        delete L[from];
        continue;
      }
      for (const to of Object.keys(m)) {
        if (pairs.get(m[to])?.has(`${from},${to}`)) continue;
        delete m[to];
        removed++;
      }
      if (!Object.keys(m).length) delete L[from];
    }
    // a missing link goes to the LAST route through the pair (Routes.buildLinks' rule, which
    // bridge-ext/routes.js keeps on add, edit and remove), so walk the routes from the end
    for (const r of [...(pack.routes || [])].reverse()) {
      for (const [a, b] of routePairs(r)) {
        for (const [x, y] of [
          [a, b],
          [b, a]
        ]) {
          if (L[x]?.[y] !== undefined) continue;
          if (!L[x]) L[x] = {};
          L[x][y] = r.i;
          added++;
        }
      }
    }
    return { removed, added };
  }

  // an edit call repairs the links once, after all its ops (the FNS.edit wrapper below)
  let batchSweep = null;
  function linksChanged() {
    if (batchSweep) batchSweep.on = true;
    else sweepRouteLinks();
  }

  /** Remove a route like Routes.remove, without throwing on one-sided links; returns its note id. */
  function removeRouteData(route) {
    const L = pack.cells.routes || {};
    for (const p of route.points || []) {
      const from = p?.[2];
      const m = L[from];
      if (!m) continue;
      for (const to of Object.keys(m)) {
        if (m[to] !== route.i) continue;
        delete m[to];
        if (L[to]?.[from] === route.i) delete L[to][from];
      }
      if (!Object.keys(m).length) delete L[from];
    }
    pack.routes = pack.routes.filter(r => r.i !== route.i);
    document.getElementById(`route${route.i}`)?.remove();
    return `route${route.i}`;
  }

  /**
   * Live routes with a point on a cell of one of `burgIds` and no point on a cell holding a live
   * burg outside `removing` (they served only removed burgs). Works before or after removal.
   */
  function orphanRoutes(burgIds, removing, skip) {
    const C = pack.cells;
    const cellsOf = new Set();
    for (const i of burgIds) {
      const c = pack.burgs[i]?.cell;
      if (Number.isInteger(c)) cellsOf.add(c);
    }
    if (!cellsOf.size) return [];
    const out = [];
    for (const r of pack.routes || []) {
      if (skip?.has(r.i)) continue;
      const pts = Array.isArray(r.points) ? r.points : [];
      if (!pts.some(p => cellsOf.has(p?.[2]))) continue;
      const served = pts.some(p => {
        const b = C.burg[p?.[2]];
        return b && !removing.has(b) && alive(pack.burgs[b]);
      });
      if (!served) out.push(r);
    }
    return out;
  }

  /** Number of live routes with a point on this cell. */
  function routesAtCell(cell) {
    let n = 0;
    for (const r of pack.routes || []) if ((r.points || []).some(p => p?.[2] === cell)) n++;
    return n;
  }

  // ---------------------------------------------------------------- burgs

  /** The most populous live burg of b's state outside `exclude` (ties: lowest id), or null. */
  function capitalSuccessor(b, exclude) {
    let best = null;
    for (const x of pack.burgs) {
      if (!x?.i || x.removed || x.i === b.i || x.state !== b.state || exclude.has(x.i)) continue;
      if (!best || (x.population || 0) > (best.population || 0)) best = x;
    }
    return best;
  }

  /** The provinces editor's rule: the first live burg (cell order) inside the province. */
  function provinceSuccessor(p, exclude) {
    const C = pack.cells;
    for (let c = 0; c < C.province.length; c++) {
      if (C.province[c] !== p.i) continue;
      const id = C.burg[c];
      if (id && !exclude.has(id) && alive(pack.burgs[id])) return pack.burgs[id];
    }
    return null;
  }

  /** What depends on a burg: the state it is capital of, markets it centres, provinces it heads. */
  function burgDependants(b) {
    const s = pack.states[b.state];
    const capitalOf = s?.i && !s.removed && s.capital === b.i ? s : null;
    const markets = (pack.markets || []).filter(m => m && m.centerBurgId === b.i).map(m => m.i);
    const provs = (pack.provinces || []).filter(p => alive(p) && p.i && p.burg === b.i).map(p => p.i);
    return { capitalOf, markets, provinces: provs };
  }

  const capitalRow = (s, next) => ({
    state: s.i,
    stateName: s.name ?? null,
    to: next ? next.i : 0,
    name: next ? next.name : null
  });

  /** The burg that takes over province pid: `want` when still valid, else the editor's rule. */
  function provinceHead(pid, want, exclude) {
    const next = want ? pack.burgs[want] : null;
    if (next && alive(next) && !exclude.has(next.i) && pack.cells.province[next.cell] === pid) return next;
    return provinceSuccessor(pack.provinces[pid], exclude);
  }

  /**
   * Remove a burg and keep its dependants consistent. o: {exclude: Set of burg ids removed in the
   * same call (never successors), newCapital?: burg id, heads?: Map(province id -> burg id),
   * statesGoing?: Set of state ids removed in the same call (their capital is not moved)}.
   * Returns the cascade; out.markets lists the markets it centred, which the CALLER removes
   * (removeMarkets, once).
   */
  function removeBurgFull(b, o) {
    const exclude = new Set(o.exclude || []);
    exclude.add(b.i);
    const out = {};
    const d = burgDependants(b);
    if (d.capitalOf && o.statesGoing?.has(d.capitalOf.i)) d.capitalOf.capital = 0;
    else if (d.capitalOf) {
      const s = d.capitalOf;
      let next = o.newCapital ? pack.burgs[o.newCapital] : null;
      if (!next || !alive(next) || next.state !== b.state || exclude.has(next.i)) next = capitalSuccessor(b, exclude);
      if (next) {
        s.capital = next.i;
        s.center = next.cell;
        next.capital = 1;
        Burgs.changeGroup(next, null);
      } else s.capital = 0;
      out.capital = capitalRow(s, next);
    }
    if (b.capital) b.capital = 0;
    if (d.markets.length) out.markets = d.markets;
    if (d.provinces.length) {
      out.provinces = d.provinces.map(pid => {
        const next = provinceHead(pid, o.heads?.get(pid), exclude);
        pack.provinces[pid].burg = next ? next.i : 0;
        return { province: pid, to: next ? next.i : 0 };
      });
    }
    Burgs.remove(b.i);
    return out;
  }

  /** Drop trade deals whose burg side is one of these burgs. */
  function dropBurgDeals(ids) {
    if (!Array.isArray(pack.deals) || !ids.size) return 0;
    const before = pack.deals.length;
    pack.deals = pack.deals.filter(
      d => !((d.sellerType === "burg" && ids.has(d.seller)) || (d.buyerType === "burg" && ids.has(d.buyer)))
    );
    return before - pack.deals.length;
  }

  /** Deals a removal drops: a burg side among burgIds or a market side among marketIds. */
  function dealsTouching(burgIds, marketIds) {
    let n = 0;
    const hit = (type, id) => (type === "burg" && burgIds.has(id)) || (type === "market" && marketIds.has(id));
    for (const d of pack.deals || []) if (hit(d.sellerType, d.seller) || hit(d.buyerType, d.buyer)) n++;
    return n;
  }

  /** Live burgs outside `removing` served by one of these markets (they move to other markets). */
  function burgsInMarkets(marketIds, removing) {
    if (!marketIds.size) return 0;
    let n = 0;
    for (const b of pack.burgs) if (alive(b) && b.i && !removing.has(b.i) && marketIds.has(b.market)) n++;
    return n;
  }

  /**
   * Markets.removeMarket for each id (it drops the market's deals and leaves its territory
   * without a market), then hand the cells and burgs those markets served to the remaining
   * markets: re-run the app's territory expansion and keep every other assignment as it was.
   * Returns the number of burgs that moved to another market.
   */
  function removeMarkets(ids) {
    const gone = new Set(ids);
    if (!gone.size) return 0;
    const C = pack.cells;
    const prevCells = C.market ? Uint16Array.from(C.market) : null;
    const prevBurgs = new Map();
    for (const b of pack.burgs) if (alive(b) && b.i) prevBurgs.set(b.i, b.market || 0);
    Markets.sync();
    for (const id of gone) Markets.removeMarket(id);
    let moved = 0;
    if (prevCells && C.good && (pack.markets || []).length) {
      Markets.expandTerritories();
      const fresh = pack.cells.market;
      for (let c = 0; c < fresh.length; c++) if (!gone.has(prevCells[c])) fresh[c] = prevCells[c];
      for (const b of pack.burgs) {
        if (!alive(b) || !b.i || !prevBurgs.has(b.i)) continue;
        const before = prevBurgs.get(b.i);
        if (!gone.has(before)) b.market = before;
        else if (b.market) moved++;
      }
    }
    if (layerOn("toggleMarketsLayer") && typeof drawMarketsLayer === "function") drawMarketsLayer();
    return moved;
  }

  // ---------------------------------------------------------------- provinces, states

  /**
   * provinces-editor.js removeProvince for several provinces (one pass over the cells); returns
   * their note ids.
   */
  function removeProvincesData(list) {
    const ids = new Set(list.map(p => p.i));
    if (!ids.size) return [];
    const C = pack.cells;
    for (let c = 0; c < C.province.length; c++) if (ids.has(C.province[c])) C.province[c] = 0;
    for (const p of list) {
      const s = pack.states[p.state];
      if (Array.isArray(s?.provinces)) {
        const k = s.provinces.indexOf(p.i);
        if (k >= 0) s.provinces.splice(k, 1);
      }
      if (typeof unfog === "function") unfog(`focusProvince${p.i}`);
      document.getElementById(`provinceCOA${p.i}`)?.remove();
      if (typeof emblems !== "undefined") sel(emblems, `#provinceEmblems > use[data-i='${p.i}']`);
      pack.provinces[p.i] = { i: p.i, removed: true };
      if (typeof provs !== "undefined") {
        const g = provs.select("#provincesBody");
        sel(g, `#province${p.i}`);
        sel(g, `#province-gap${p.i}`);
      }
    }
    return list.map(p => `province${p.i}`);
  }

  /**
   * states-editor.ts stateRemove for several states at once: cells and burgs fall back to
   * Neutrals (a capital loses its flag), the state's provinces go (its own list and any province
   * of the state missing from it), its emblem, label, regiments and neighbour links go, then a
   * tombstone. Redraws are left to the caller (states, borders, provinces); the app's editor
   * refresh is replaced by one statistics pass. Returns {provinces: count, noteIds}.
   */
  function removeStatesData(list) {
    const ids = new Set(list.map(s => s.i));
    const noteIds = [];
    for (const s of list) {
      if (typeof statesBody !== "undefined") {
        sel(statesBody, `#state${s.i}`);
        sel(statesBody, `#state-gap${s.i}`);
      }
      if (typeof statesHalo !== "undefined") sel(statesHalo, `#state-border${s.i}`);
      if (typeof labels !== "undefined") sel(labels, `#stateLabel${s.i}`);
      if (typeof defs !== "undefined") sel(defs, `#textPath_stateLabel${s.i}`);
      if (typeof unfog === "function") unfog(`focusState${s.i}`);
      document.getElementById(`stateCOA${s.i}`)?.remove();
      if (typeof emblems !== "undefined") sel(emblems, `#stateEmblems > use[data-i='${s.i}']`);
      for (const m of s.military || []) noteIds.push(`regiment${s.i}-${m.i}`);
      if (typeof armies !== "undefined") sel(armies, `g#army${s.i}`);
      noteIds.push(`stateLabel${s.i}`);
    }
    for (const b of pack.burgs) {
      if (!b?.i || !ids.has(b.state)) continue;
      b.state = 0;
      if (b.capital) {
        b.capital = 0;
        if (!b.removed) Burgs.changeGroup(b, null);
      }
    }
    const C = pack.cells;
    for (let c = 0; c < C.state.length; c++) if (ids.has(C.state[c])) C.state[c] = 0;
    const provIds = new Set();
    for (const s of list) for (const p of s.provinces || []) provIds.add(p);
    for (const p of pack.provinces) if (alive(p) && p.i && ids.has(p.state)) provIds.add(p.i);
    const provList = [...provIds].map(i => pack.provinces[i]).filter(p => alive(p) && p.i);
    noteIds.push(...removeProvincesData(provList));
    for (const s of pack.states) {
      if (!s.i || s.removed || !Array.isArray(s.neighbors)) continue;
      s.neighbors = s.neighbors.filter(n => !ids.has(n));
    }
    for (const s of list) pack.states[s.i] = { i: s.i, removed: true };
    if (typeof debug !== "undefined") debug.selectAll(".highlight").remove();
    if (typeof States !== "undefined" && typeof States.collectStatistics === "function") States.collectStatistics();
    return { provinces: provList.length, noteIds };
  }

  // ---------------------------------------------------------------- cultures, religions, rivers

  /**
   * cultures-editor.ts removeCulture: burgs, states and cells fall back to culture 0. Religions of
   * the culture also fall back to 0 (the editor leaves them naming the removed culture).
   * Returns the number of such religions.
   */
  function removeCultureData(x) {
    const id = x.i;
    if (typeof cults !== "undefined") sel(cults, `#culture${id}`);
    if (typeof debug !== "undefined") sel(debug, `#cultureCenter${id}`);
    for (const b of pack.burgs) if (b && b.culture === id) b.culture = 0;
    for (const s of pack.states) if (s && s.culture === id) s.culture = 0;
    const C = pack.cells.culture;
    for (let c = 0; c < C.length; c++) if (C[c] === id) C[c] = 0;
    x.removed = true;
    for (const o of pack.cultures) {
      if (!o?.i || o.removed) continue;
      o.origins = (o.origins ?? []).filter(v => v !== id);
      if (!o.origins.length) o.origins = [0];
    }
    let n = 0;
    for (const r of pack.religions || []) {
      if (!r?.i || r.removed || r.culture !== id) continue;
      r.culture = 0;
      n++;
    }
    return n;
  }

  /** religions-editor.ts removeReligion: cells fall back to religion 0. */
  function removeReligionData(x) {
    const id = x.i;
    if (typeof relig !== "undefined") {
      sel(relig, `#religion${id}`);
      sel(relig, `#religion-gap${id}`);
    }
    if (typeof debug !== "undefined") sel(debug, `#religionsCenter${id}`);
    const C = pack.cells.religion;
    for (let c = 0; c < C.length; c++) if (C[c] === id) C[c] = 0;
    x.removed = true;
    for (const o of pack.religions) {
      if (!o?.i || o.removed) continue;
      o.origins = (o.origins ?? []).filter(v => v !== id);
      if (!o.origins.length) o.origins = [0];
    }
  }

  /** Rivers.remove for exactly these river ids (no tributary cascade); returns their note ids. */
  function removeRiversData(ids) {
    const C = pack.cells;
    for (const id of ids) document.getElementById(`river${id}`)?.remove();
    for (let c = 0; c < C.r.length; c++) {
      if (!C.r[c] || !ids.has(C.r[c])) continue;
      C.r[c] = 0;
      C.fl[c] = grid.cells.prec[C.g[c]];
      C.conf[c] = 0;
    }
    pack.rivers = pack.rivers.filter(r => !ids.has(r.i));
    return [...ids].map(id => `river${id}`);
  }

  /** The rivers Rivers.remove(id) takes: the river, its direct tributaries and its basin. */
  function riverCascade(id) {
    return (pack.rivers || []).filter(r => r.i === id || r.parent === id || r.basin === id).map(r => r.i);
  }

  const EMBLEM_OWNERS = ["burg", "state", "province"];
  const hasEmblem = x => !!x.coa && x.coa.size !== 0;

  /**
   * Hide an entity's emblem the emblem editor's way (size 0: the renderer skips it, the coat of
   * arms stays for regeneration and the editors).
   */
  function removeEmblem(type, x) {
    x.coa.size = 0;
    if (typeof emblems !== "undefined") sel(emblems, `#${type}Emblems > use[data-i='${x.i}']`);
  }

  // ---------------------------------------------------------------- edit {remove} hooks

  delete NO_REMOVE.province;
  delete NO_REMOVE.culture;
  delete NO_REMOVE.religion;

  /** Burg ids that remove ops of this edit call target (never chosen as successors). */
  function batchBurgRemovals(c) {
    if (c.burgRemovals) return c.burgRemovals;
    const s = new Set();
    for (const op of Array.isArray(c.args?.ops) ? c.args.ops : []) {
      if (!isObj(op) || !op.remove) continue;
      try {
        s.add(T.resolve("burg", op.ref).i);
      } catch {}
    }
    c.burgRemovals = s;
    return s;
  }

  const OP_KEYS = ["ref", "remove", "set", "force", "newCapital", "orphanRoutes", "provinceHeads"];
  const BURG_ONLY = ["force", "newCapital", "orphanRoutes", "provinceHeads"];

  function checkOpKeys(type, op, c) {
    const extra = Object.keys(op || {}).filter(k => !OP_KEYS.includes(k));
    if (extra.length) fail("BAD_FIELD", `edit ops take no field '${extra[0]}'`, { details: OP_KEYS.slice(0, -1) });
    if (type !== "burg" && (BURG_ONLY.some(k => op?.[k] !== undefined) || c?.args?.force !== undefined))
      fail("BAD_ARGS", "force, newCapital and orphanRoutes apply only to burg removal");
  }

  /** An op's force, or the call's (edit {force:true} applies to every op). */
  const forceOf = (c, op) => !!(op?.force ?? c?.args?.force);

  /** The recorded province heads of a replayed removal (sketch log), checked against the map. */
  function recordedHeads(op, provIds, removing) {
    const heads = new Map();
    for (const h of Array.isArray(op.provinceHeads) ? op.provinceHeads : []) {
      if (!isObj(h) || !provIds.includes(h.province)) continue;
      const p = pack.provinces[h.province];
      let nb;
      try {
        nb = T.resolve("burg", h.burg).entity;
      } catch (e) {
        e.message = `the sketch made burg ${h.burg} head of province ${p.name} (${p.i}): ${e.message}`;
        throw e;
      }
      if (pack.cells.province[nb.cell] !== p.i || removing.has(nb.i))
        fail(
          "CHANGED",
          `the sketch made ${nb.name} (${nb.i}) head of province ${p.name} (${p.i}), but it is ${removing.has(nb.i) ? "removed in this same call" : "no longer in that province"}`
        );
      heads.set(p.i, nb.i);
    }
    return heads;
  }

  REMOVE.burg = {
    // lets force (with newCapital, orphanRoutes) past the core op guard in bridge-mutations.js
    takesForce: true,
    check(b, c, op) {
      const o = op || {};
      checkOpKeys("burg", o, c);
      const force = forceOf(c, o);
      const d = burgDependants(b);
      if (!force) {
        if (d.capitalOf)
          fail(
            "REFUSED",
            `${b.name} (${b.i}) is the capital of ${d.capitalOf.name}; pass force:true to remove it anyway (the capital moves to newCapital or the state's most populous other burg), or make another burg the capital first (edit {type:'state', set:{capital}})`
          );
        if (d.markets.length)
          fail(
            "REFUSED",
            `${b.name} (${b.i}) is a market centre; pass force:true to remove it together with its market`
          );
      }
      const removing = new Set([...batchBurgRemovals(c), b.i]);
      const info = {};
      if (o.newCapital !== undefined && o.newCapital !== null) {
        if (!d.capitalOf)
          fail("BAD_ARGS", `newCapital applies only when removing a state capital; ${b.name} is not one`);
        const nb = T.resolve("burg", o.newCapital).entity;
        if (nb.i === b.i) fail("BAD_ARGS", "newCapital is the burg being removed");
        if (nb.state !== b.state)
          fail("REFUSED", `newCapital ${nb.name} (${nb.i}) is not in ${d.capitalOf.name}; pick a burg of that state`);
        if (removing.has(nb.i)) fail("REFUSED", `newCapital ${nb.name} (${nb.i}) is removed in this same call`);
        info.capital = capitalRow(d.capitalOf, nb);
      } else if (d.capitalOf) info.capital = capitalRow(d.capitalOf, capitalSuccessor(b, removing));
      if (d.markets.length) {
        info.marketsRemoved = d.markets;
        const moving = burgsInMarkets(new Set(d.markets), removing);
        if (moving) info.burgsToOtherMarkets = moving;
      }
      if (d.provinces.length) {
        const heads = recordedHeads(o, d.provinces, removing);
        info.provinceCapitals = d.provinces.map(pid => {
          const next = provinceHead(pid, heads.get(pid), removing);
          return { province: pid, to: next ? next.i : 0 };
        });
      }
      const deals = dealsTouching(new Set([b.i]), new Set(d.markets));
      if (deals) info.dealsDropped = deals;
      const n = routesAtCell(b.cell);
      if (n) info.routesThrough = n;
      if (o.orphanRoutes) {
        const rs = orphanRoutes([b.i], removing);
        info.routesRemoved = rs.filter(r => force || !r.lock).map(r => r.i);
        const locked = rs.filter(r => r.lock && !force).map(r => r.i);
        if (locked.length) info.routesKeptLocked = locked;
      }
      return Object.keys(info).length ? info : null;
    },
    apply(b, c, op, info) {
      const o = op || {};
      const force = forceOf(c, o);
      const deals0 = dealCount();
      const heads = new Map((info?.provinceCapitals || []).map(x => [x.province, x.to]));
      const cascade = removeBurgFull(b, { exclude: batchBurgRemovals(c), newCapital: info?.capital?.to, heads });
      const moved = cascade.markets ? removeMarkets(cascade.markets) : 0;
      dropBurgDeals(new Set([b.i]));
      const row = {};
      if (cascade.capital) row.capital = cascade.capital;
      if (cascade.markets) row.marketsRemoved = cascade.markets;
      if (moved) row.burgsToOtherMarkets = moved;
      if (cascade.provinces) row.provinceCapitals = cascade.provinces;
      if (deals0 - dealCount()) row.dealsDropped = deals0 - dealCount();
      if (o.orphanRoutes) {
        const rs = orphanRoutes([b.i], new Set([b.i]));
        const gone = rs.filter(r => force || !r.lock);
        dropNotes(gone.map(r => removeRouteData(r)));
        if (gone.length) row.routesRemoved = gone.map(r => r.i);
        const locked = rs.filter(r => r.lock && !force).map(r => r.i);
        if (locked.length) {
          row.routesKeptLocked = locked;
          c.notes.add("locked orphan routes are kept; force:true removes them too");
        }
      } else if (routesAtCell(b.cell))
        c.notes.add(
          "routes through removed burgs are kept; orphanRoutes:true also removes the routes that served only removed burgs"
        );
      linksChanged();
      if (cascade.capital) c.R.add("stateLabels", [cascade.capital.state]);
      const resolved = {};
      if (force) resolved.force = true;
      if (cascade.capital?.to) resolved.newCapital = cascade.capital.to;
      if (o.orphanRoutes) resolved.orphanRoutes = true;
      const kept = (cascade.provinces || []).filter(x => x.to).map(x => ({ province: x.province, burg: x.to }));
      if (kept.length) resolved.provinceHeads = kept;
      return { row, resolved };
    }
  };

  REMOVE.route = {
    apply(r) {
      dropNotes([removeRouteData(r)]);
      linksChanged();
      return null;
    }
  };

  REMOVE.river = {
    apply(r) {
      const ids = riverCascade(r.i);
      Rivers.remove(r.i);
      dropNotes(ids.map(id => `river${id}`));
      return ids.length > 1 ? { row: { tributariesRemoved: ids.filter(id => id !== r.i) } } : null;
    }
  };

  REMOVE.province = {
    check(p, c, op) {
      checkOpKeys("province", op, c);
      return { cells: I.cellsWhere("province", p.i).length };
    },
    apply(p, c) {
      dropNotes(removeProvincesData([p]));
      c.R.add("provinces");
      c.R.add("borders");
      return null;
    }
  };

  REMOVE.culture = {
    check(x, c, op) {
      checkOpKeys("culture", op, c);
      if (!x.i) fail("REFUSED", "Wildlands (culture 0) cannot be removed");
      const info = {
        cells: I.cellsWhere("culture", x.i).length,
        burgs: pack.burgs.filter(b => alive(b) && b.i && b.culture === x.i).length,
        states: pack.states.filter(s => alive(s) && s.i && s.culture === x.i).length
      };
      const rel = pack.religions.filter(r => alive(r) && r.i && r.culture === x.i).length;
      if (rel) info.religions = rel;
      return info;
    },
    apply(x, c) {
      const rel = removeCultureData(x);
      c.R.add("cultures");
      return rel ? { row: { religions: rel } } : null;
    }
  };

  REMOVE.religion = {
    check(x, c, op) {
      checkOpKeys("religion", op, c);
      if (!x.i) fail("REFUSED", "No religion (religion 0) cannot be removed");
      return { cells: I.cellsWhere("religion", x.i).length };
    },
    apply(x, c) {
      removeReligionData(x);
      c.R.add("religions");
      return null;
    }
  };

  // the other types' own checks (state: not Neutrals) run after the op-key check
  for (const type of Object.keys(REMOVE)) {
    if (["burg", "province", "culture", "religion"].includes(type)) continue;
    const own = REMOVE[type].check;
    REMOVE[type].check = (x, c, op) => {
      checkOpKeys(type, op, c);
      return own ? own(x, c, op) : null;
    };
  }

  // a state goes through the stateRemove port: its provinces, label note and regiment notes too
  REMOVE.state.apply = (st, c) => {
    const res = removeStatesData([st]);
    dropNotes(res.noteIds);
    c.R.add("states");
    c.R.add("borders");
    c.R.add("provinces");
    return res.provinces ? { row: { provincesRemoved: res.provinces } } : null;
  };

  // a label's note goes with it (as a burg's or a marker's does)
  const labelApply = REMOVE.label.apply;
  REMOVE.label.apply = (l, c, op, info) => {
    const out = labelApply(l, c, op, info);
    dropNotes([l.id]);
    return out;
  };

  // one route-link repair per edit call, after all its ops, reported once for the call
  const editFn = FNS.edit;
  FNS.edit = async a => {
    if (a?.phase !== "apply") return editFn(a);
    const mine = { on: false };
    batchSweep = mine;
    let out;
    try {
      out = await editFn(a);
    } finally {
      if (batchSweep === mine) batchSweep = null;
    }
    if (mine.on) {
      const sw = sweepRouteLinks();
      if (sw.removed || sw.added) out.routeLinksFixed = sw;
    }
    return out;
  };

  // ---------------------------------------------------------------- clear

  // Removal order: what refers to an entity goes before it.
  const CLEAR_ORDER = [
    "notes",
    "labels",
    "markers",
    "zones",
    "routes",
    "rivers",
    "burgs",
    "provinces",
    "states",
    "religions",
    "cultures",
    "emblems"
  ];
  const ONE = {
    notes: "note",
    labels: "label",
    markers: "marker",
    zones: "zone",
    routes: "route",
    rivers: "river",
    burgs: "burg",
    provinces: "province",
    states: "state",
    religions: "religion",
    cultures: "culture",
    emblems: "emblem"
  };
  const MANY = Object.fromEntries(Object.entries(ONE).map(([k, v]) => [v, k]));
  const LOCKABLE = new Set(["burg", "state", "province", "culture", "religion", "route", "marker"]);
  const KEPT_ROWS = 10;
  const NAME_SAMPLE = 3;
  const ZERO_KEPT = new Set(["state", "culture", "religion"]);

  const idOfX = (type, x) => (type === "emblem" ? x.key : type === "note" || type === "label" ? x.id : x.i);

  /**
   * What the replay of a clear compares, per entity: its main fields (edit's identity fields),
   * so an id someone else reused, renumbered or changed since is a conflict, not a silent removal.
   */
  function fingerprint(type, x) {
    if (type === "label") return hashStr(`${x.name ?? ""}|${x.group ?? ""}`);
    if (type === "emblem") return hashStr(JSON.stringify(x.x.coa ?? null));
    const ident = M.identOf(type, x) ?? null;
    // a state takes its provinces with it: one added since is someone else's work
    if (type === "state") {
      const n = I.liveList("province").filter(p => p.state === x.i).length;
      return hashStr(JSON.stringify({ ident, provinces: n }));
    }
    return hashStr(JSON.stringify(ident));
  }

  function emblemCandidates() {
    const out = [];
    for (const type of EMBLEM_OWNERS)
      for (const x of I.liveList(type)) if (hasEmblem(x)) out.push({ type, x, key: `${type}:${x.i}` });
    return out;
  }

  /** where -> {singular type: filter}; a bare filter is allowed when exactly one type is cleared. */
  function parseWhere(types, where) {
    if (where === undefined || where === null) return {};
    if (!isObj(where)) fail("BAD_ARGS", "where is an object");
    const keys = Object.keys(where);
    const typeKeys = keys.filter(k => k in ONE);
    const out = {};
    if (typeKeys.length && typeKeys.length === keys.length) {
      for (const k of keys) {
        if (!types.includes(k)) fail("BAD_ARGS", `where.${k}: '${k}' is not one of the types being cleared`);
        if (!isObj(where[k])) fail("BAD_ARGS", `where.${k} is an object of field filters`);
        out[ONE[k]] = where[k];
      }
      return out;
    }
    if (typeKeys.length)
      fail("BAD_ARGS", `where mixes type keys (${typeKeys.join(", ")}) and field filters; key every filter by type`);
    if (types.length !== 1)
      fail(
        "BAD_ARGS",
        "with several types, key where by type, e.g. {burgs:{populationMax:500}, routes:{group:'trails'}}"
      );
    out[ONE[types[0]]] = where;
    return out;
  }

  // fields a filter may name although no entity carries them yet (optional flags)
  const OPTIONAL_FIELDS = {
    "*": ["i", "name", "lock"],
    marker: ["pinned", "note", "size", "hidden"],
    zone: ["hidden"],
    river: ["parent", "basin"],
    route: ["feature"],
    label: ["text"]
  };

  /** Every where field must be one this type has (else it silently matches nothing). */
  function checkWhereFields(type, filter, list) {
    if (!list.length) return;
    const sample = list.slice(0, 200);
    const known = k =>
      OPTIONAL_FIELDS["*"].includes(k) ||
      (OPTIONAL_FIELDS[type] || []).includes(k) ||
      sample.some(x => I.fieldValue(type, x, k) !== undefined);
    const valid = () => {
      const s = new Set([...OPTIONAL_FIELDS["*"], ...(OPTIONAL_FIELDS[type] || [])]);
      for (const x of sample.slice(0, 20)) for (const k of Object.keys(x)) if (k !== "removed") s.add(k);
      return [...s].slice(0, 40);
    };
    for (const key of Object.keys(filter)) {
      const want = filter[key];
      const mm = /^(.*)(Min|Max)$/.exec(key);
      if (mm && !known(key) && known(mm[1])) {
        if (typeof want !== "number" || !Number.isFinite(want))
          fail("BAD_ARGS", `where.${MANY[type]}.${key} takes a number, not ${JSON.stringify(want)}`);
        continue;
      }
      if (!known(key))
        fail("BAD_ARGS", `where.${MANY[type]}: no ${type} has a field '${key}', so it would match nothing`, {
          details: valid()
        });
    }
  }

  function whereFilter(type, filter, list) {
    if (!filter || !Object.keys(filter).length) return () => true;
    if (type === "emblem") {
      const extra = Object.keys(filter).filter(k => k !== "type");
      if (extra.length)
        fail("BAD_ARGS", `emblems filter only by type ('burg' | 'state' | 'province'), not '${extra[0]}'`);
      const want = Array.isArray(filter.type) ? filter.type : [filter.type];
      for (const t of want)
        if (!EMBLEM_OWNERS.includes(t)) fail("BAD_ARGS", `emblem type must be one of ${EMBLEM_OWNERS.join(", ")}`);
      return e => want.includes(e.type);
    }
    checkWhereFields(type, filter, list);
    const refs = {};
    for (const key of Object.keys(filter)) {
      const refType = I.REF_FIELDS[type]?.[key];
      if (!refType) continue;
      const vals = Array.isArray(filter[key]) ? filter[key] : [filter[key]];
      if (vals.every(v => typeof v === "boolean")) continue;
      refs[key] = vals.map(v => T.resolve(refType, v).i);
    }
    // a route's group by id or display name, when the routes extension (bridge-ext/routes.js, loaded
    // after this file) registers route groups; an unknown group is NOT_FOUND, not a silent zero match
    if (type === "route" && filter.group !== undefined && REMOVE.routeGroup) {
      const vals = Array.isArray(filter.group) ? filter.group : [filter.group];
      refs.group = vals.map(v => {
        if (typeof v !== "string" || !v.trim())
          fail("BAD_ARGS", "where.routes.group must be a route group id or name (e.g. 'roads')");
        try {
          return T.resolve("routeGroup", v.trim()).i;
        } catch (e) {
          e.message = `where.routes.group: ${e.message}`;
          throw e;
        }
      });
    }
    return x => I.matchWhere(type, x, filter, refs);
  }

  /**
   * keep [{type, ref}] -> {type: Set(ids)}. A keep entry must be able to keep something: a type
   * being cleared, a province when states are (it keeps its state), an emblem owner when emblems
   * are, a route when orphan routes go.
   */
  function parseKeep(keep, want, orphans) {
    const out = {};
    if (keep === undefined || keep === null) return out;
    if (!Array.isArray(keep)) fail("BAD_ARGS", "keep is an array of {type, ref}");
    const allowed = new Set(want);
    if (want.includes("state")) allowed.add("province");
    if (want.includes("emblem")) for (const t of EMBLEM_OWNERS) allowed.add(t);
    if (orphans && want.includes("burg")) allowed.add("route");
    keep.forEach((k, n) => {
      if (!isObj(k) || typeof k.type !== "string") fail("BAD_ARGS", `keep[${n}] must be {type, ref}`);
      if (!allowed.has(k.type))
        fail(
          "BAD_ARGS",
          `keep[${n}]: '${k.type}' is not one of the types being cleared, so it would keep nothing (types: ${want.map(t => MANY[t]).join(", ")})`
        );
      let r;
      try {
        r = T.resolve(k.type, k.ref);
      } catch (e) {
        e.message = `keep[${n}]: ${e.message}`;
        throw e;
      }
      slot(out, k.type, () => new Set()).add(r.i);
    });
    return out;
  }

  function nameOfX(type, x) {
    if (type === "emblem") return I.nameOf(x.type, x.x);
    return I.nameOf(type, x);
  }

  /** The capitals and province heads a replayed clear recorded, checked against the map. */
  function recordedSuccessors(a, pick, errors) {
    const caps = new Map();
    const heads = new Map();
    const C = pack.cells;
    const check = (list, kind, fn) => {
      for (const x of Array.isArray(list) ? list : []) {
        try {
          if (!isObj(x)) fail("BAD_ARGS", `${kind}: bad entry`);
          fn(x);
        } catch (e) {
          errors.push(M.errRow(errors.length, { type: kind, id: x?.burg }, e));
        }
      }
    };
    const burgFor = (x, what) => {
      try {
        return T.resolve("burg", x.burg).entity;
      } catch (e) {
        e.message = `the sketch made burg ${x.burg} ${what}: ${e.message}`;
        throw e;
      }
    };
    check(a.capitals, "capital", x => {
      const s = T.resolve("state", x.state).entity;
      if (pick.state?.has(s.i)) return;
      const nb = burgFor(x, `the capital of ${s.name} (${s.i})`);
      if (nb.state !== s.i || pick.burg?.has(nb.i))
        fail(
          "CHANGED",
          `the sketch made ${nb.name} (${nb.i}) the capital of ${s.name} (${s.i}), but it is ${pick.burg?.has(nb.i) ? "removed by this clear" : "no longer in that state"}`
        );
      caps.set(s.i, nb.i);
    });
    check(a.provinceHeads, "provinceHead", x => {
      const p = T.resolve("province", x.province).entity;
      if (pick.province?.has(p.i) || pick.state?.has(p.state)) return;
      const nb = burgFor(x, `head of province ${p.name} (${p.i})`);
      if (C.province[nb.cell] !== p.i || pick.burg?.has(nb.i))
        fail(
          "CHANGED",
          `the sketch made ${nb.name} (${nb.i}) head of province ${p.name} (${p.i}), but it is ${pick.burg?.has(nb.i) ? "removed by this clear" : "no longer in that province"}`
        );
      heads.set(p.i, nb.i);
    });
    return { caps, heads };
  }

  /**
   * Choose what a clear removes. Returns {pick: {type: Map(id -> entity)}, kept: {type: [{i,
   * name, why}]}, orphans: Set(route ids), errors, caps, heads, unfiltered}. Literal mode (a.ids,
   * used by replay): exactly those ids, each must be live and match its recorded fingerprint, and
   * the recorded capital and province-head successors must still be valid.
   */
  function selectClear(a) {
    const pick = {};
    const kept = {};
    const errors = [];
    const orphans = new Set();
    const keepRow = (type, x, why) =>
      slot(kept, type, () => []).push({ i: idOfX(type, x), name: nameOfX(type, x), why });

    if (a.ids !== undefined) {
      if (!isObj(a.ids)) fail("BAD_ARGS", "ids is {type: [ids]}");
      const fps = isObj(a.idents) ? a.idents : {};
      const changed = (type, id, x, label) => {
        const want = fps[type]?.[String(id)];
        if (want !== undefined && fingerprint(type, x) !== want)
          fail(
            "CHANGED",
            `${label} is not the entity the clear removed: someone changed it since (or its id was reused or renumbered)`
          );
      };
      for (const type of Object.keys(a.ids)) {
        if (!(type in MANY)) fail("BAD_ARGS", `ids: unknown type '${type}'`);
        const list = Array.isArray(a.ids[type]) ? a.ids[type] : [];
        const m = new Map();
        pick[type] = m;
        for (const id of list) {
          try {
            if (type === "emblem") {
              const [owner, n] = String(id).split(":");
              if (!EMBLEM_OWNERS.includes(owner)) fail("BAD_ARGS", `bad emblem id '${id}'`);
              const r = T.resolve(owner, Number(n));
              if (!r.i) fail("NOT_FOUND", `${owner} ${n} is a placeholder`);
              if (!hasEmblem(r.entity)) fail("NOT_FOUND", `${owner} ${r.name} (${r.i}) has no emblem`);
              const e = { type: owner, x: r.entity, key: id };
              changed(type, id, e, `the emblem of ${owner} '${r.name}' (${r.i})`);
              m.set(id, e);
              continue;
            }
            const r = T.resolve(type, id);
            // Neutrals, Wildlands and No religion (markers, routes and zones do start at 0)
            if (r.i === 0 && ZERO_KEPT.has(type)) fail("REFUSED", `${type} 0 (${r.name}) cannot be cleared`);
            const label = `${type} ${r.name ? `'${r.name}' ` : ""}(${id})`;
            // the clear kept locked entities (unless forced): a lock now is someone else's
            if (LOCKABLE.has(type) && r.entity.lock && !a.force)
              fail("CHANGED", `${label} was locked since by someone else; the clear would have kept it`);
            changed(type, id, r.entity, label);
            m.set(r.i, r.entity);
          } catch (e) {
            errors.push(M.errRow(errors.length, { type, id }, e));
          }
        }
      }
      const { caps, heads } = recordedSuccessors(a, pick, errors);
      return { pick, kept, orphans, errors, caps, heads, unfiltered: [] };
    }

    const types = Array.isArray(a.types) ? a.types : [];
    if (!types.length) fail("BAD_ARGS", "types must be a non-empty array", { details: CLEAR_ORDER });
    for (const t of types) if (!(t in ONE)) fail("BAD_ARGS", `unknown type '${t}'`, { details: CLEAR_ORDER });
    const where = parseWhere(types, a.where);
    const force = !!a.force;
    const want = CLEAR_ORDER.filter(t => types.includes(t)).map(t => ONE[t]);
    const keep = parseKeep(a.keep, want, !!a.orphanRoutes);
    // with a where keyed by type, a type without a filter is cleared entirely: say so
    const unfiltered = Object.keys(where).length ? want.filter(t => !where[t]).map(t => MANY[t]) : [];

    for (const type of want) {
      if (type === "emblem") continue; // after the owners are known
      const list = I.liveList(type);
      const match = whereFilter(type, where[type], list);
      const m = new Map();
      pick[type] = m;
      for (const x of list) {
        if (!match(x)) continue;
        const id = idOfX(type, x);
        if (keep[type]?.has(id)) keepRow(type, x, "keep");
        else if (LOCKABLE.has(type) && x.lock && !force) keepRow(type, x, "locked");
        else m.set(id, x);
      }
    }

    // a state's removal removes its provinces: a kept (or locked) province keeps its state
    if (pick.state?.size) {
      for (const p of I.liveList("province")) {
        if (!pick.state.has(p.state) || pick.province?.has(p.i)) continue;
        const why = keep.province?.has(p.i) ? "kept" : p.lock && !force ? "locked" : null;
        if (!why) continue;
        const s = pick.state.get(p.state);
        if (!s) continue;
        pick.state.delete(p.state);
        keepRow("state", s, `holds ${why} province ${p.name} (${p.i})`);
      }
    }

    // routes that served only the removed burgs
    if (a.orphanRoutes && pick.burg?.size) {
      const removing = new Set(pick.burg.keys());
      const skip = new Set(pick.route ? pick.route.keys() : []);
      for (const r of orphanRoutes([...removing], removing, skip)) {
        if (keep.route?.has(r.i)) keepRow("route", r, "keep");
        else if (r.lock && !force) keepRow("route", r, "locked");
        else {
          slot(pick, "route", () => new Map()).set(r.i, r);
          orphans.add(r.i);
        }
      }
    }

    if (want.includes("emblem")) {
      const match = whereFilter("emblem", where.emblem);
      const m = new Map();
      pick.emblem = m;
      for (const e of emblemCandidates()) {
        if (!match(e) || pick[e.type]?.has(e.x.i)) continue;
        if (keep[e.type]?.has(e.x.i)) keepRow("emblem", e, "keep");
        else if (e.x.lock && !force) keepRow("emblem", e, `${e.type} is locked`);
        else m.set(e.key, e);
      }
    }
    return { pick, kept, orphans, errors, caps: new Map(), heads: new Map(), unfiltered };
  }

  function countsOf(pick) {
    const out = {};
    for (const type of Object.keys(pick)) if (pick[type].size) out[MANY[type]] = pick[type].size;
    return out;
  }

  function keptView(kept, all) {
    const out = {};
    for (const type of Object.keys(kept)) {
      const rows = kept[type];
      out[MANY[type]] = all ? rows : { count: rows.length, items: rows.slice(0, KEPT_ROWS) };
    }
    return out;
  }

  /** "3 matched, all kept (locked: 2, keep: 1)" when nothing is removed but something matched. */
  function allKeptNote(kept) {
    const why = {};
    let n = 0;
    for (const rows of Object.values(kept))
      for (const r of rows) {
        const k = r.why === "keep" || r.why === "locked" ? r.why : "holds a kept or locked province";
        why[k] = (why[k] || 0) + 1;
        n++;
      }
    if (!n) return null;
    const parts = Object.entries(why).map(([k, v]) => `${k}: ${v}`);
    return `${n} matched, all kept (${parts.join(", ")})${why.locked ? "; force:true also removes locked ones" : ""}; nothing was changed`;
  }

  /** Note ids a clear drops besides the notes it clears (entities' own notes). */
  function predictedNotes(pick, orphans) {
    const ids = new Set();
    const add = (type, prefix) => {
      for (const id of pick[type]?.keys() || []) ids.add(`${prefix}${id}`);
    };
    for (const id of pick.label?.keys() || []) ids.add(id);
    add("marker", "marker");
    add("route", "route");
    add("river", "river");
    add("burg", "burg");
    add("province", "province");
    for (const r of orphans) ids.add(`route${r}`);
    for (const s of pick.state?.values() || []) {
      ids.add(`stateLabel${s.i}`);
      for (const m of s.military || []) ids.add(`regiment${s.i}-${m.i}`);
      for (const p of pack.provinces) if (alive(p) && p.i && p.state === s.i) ids.add(`province${p.i}`);
    }
    for (const id of pick.note?.keys() || []) ids.delete(id);
    let n = 0;
    for (const x of typeof notes !== "undefined" && Array.isArray(notes) ? notes : []) if (ids.has(x?.id)) n++;
    return n;
  }

  /** The cascade a clear will cause, in the shape the applied result reports it. */
  function cascadePreview(pick, orphans, caps) {
    const out = {};
    const burgList = pick.burg ? [...pick.burg.values()] : [];
    if (burgList.length) {
      const exclude = new Set(pick.burg.keys());
      const capitals = [];
      const markets = new Set();
      let provinceCapitals = 0;
      for (const b of burgList) {
        const d = burgDependants(b);
        if (d.capitalOf && !pick.state?.has(d.capitalOf.i)) {
          const want = caps.get(d.capitalOf.i);
          const next = want ? pack.burgs[want] : capitalSuccessor(b, exclude);
          capitals.push(capitalRow(d.capitalOf, next));
        }
        for (const m of d.markets) markets.add(m);
        for (const pid of d.provinces)
          if (!pick.province?.has(pid) && !pick.state?.has(pack.provinces[pid]?.state)) provinceCapitals++;
      }
      if (capitals.length) out.capitalsMoved = capitals.slice(0, KEPT_ROWS);
      if (capitals.length > KEPT_ROWS) out.capitalsMovedTotal = capitals.length;
      if (markets.size) out.marketsRemoved = markets.size;
      const moving = burgsInMarkets(markets, exclude);
      if (moving) out.burgsToOtherMarkets = moving;
      if (provinceCapitals) out.provinceCapitalsMoved = provinceCapitals;
      const deals = dealsTouching(exclude, markets);
      if (deals) out.dealsDropped = deals;
    }
    if (pick.state?.size) {
      const n = I.liveList("province").filter(p => pick.state.has(p.state) && !pick.province?.has(p.i)).length;
      if (n) out.provincesWithStates = n;
    }
    if (orphans.size) out.orphanRoutes = orphans.size;
    const notesN = predictedNotes(pick, orphans);
    if (notesN) out.notesDropped = notesN;
    return out;
  }

  function clearNotes(a, sel0) {
    const out = [];
    if (sel0.unfiltered.length)
      out.push(`${sel0.unfiltered.join(", ")}: no where filter, so every one of them (not kept or locked) is cleared`);
    if (a.orphanRoutes && !sel0.pick.burg?.size && a.ids === undefined)
      out.push("orphanRoutes applies only when burgs are cleared; it removed nothing");
    const emptied = emptiedRouteGroups(sel0.pick.route, sel0.orphans);
    if (emptied.length)
      out.push(
        `route groups are kept, even when this clear empties them (${emptied.slice(0, 5).join(", ")}${emptied.length > 5 ? ", ..." : ""}); edit {type:'routeGroup', ops:[{ref, remove:true}]} removes one`
      );
    return out;
  }

  /**
   * Custom route groups (bridge-ext/routes.js) that hold routes now and none once the routes in
   * `pick` and `orphans` are gone. clear keeps route groups deliberately: a group is a styled
   * layer, not map data, and a rebuild usually refills it; edit routeGroup remove deletes one.
   */
  function emptiedRouteGroups(pick, orphans) {
    if (!REMOVE.routeGroup || (!pick?.size && !orphans?.size)) return [];
    const held = new Map();
    const left = new Set();
    for (const r of pack.routes || []) {
      if (!r || typeof r.group !== "string") continue;
      held.set(r.group, (held.get(r.group) || 0) + 1);
      if (!pick?.has(r.i) && !orphans?.has(r.i)) left.add(r.group);
    }
    return [...held.keys()].filter(g => !left.has(g) && !["roads", "trails", "searoutes"].includes(g));
  }

  FNS.clear = async a => {
    const sel0 = selectClear(a);
    const { pick, kept, orphans, errors, caps, heads } = sel0;
    const total = Object.values(pick).reduce((n, m) => n + m.size, 0);
    if (a.phase !== "apply") {
      const plan = { remove: countsOf(pick) };
      if (Object.keys(kept).length) plan.kept = keptView(kept, a.detail);
      const cascade = cascadePreview(pick, orphans, caps);
      if (Object.keys(cascade).length) plan.cascade = cascade;
      if (a.detail) plan.ids = Object.fromEntries(Object.entries(pick).map(([t, m]) => [MANY[t], [...m.keys()]]));
      const notesOut = clearNotes(a, sel0);
      if (!total) {
        const n = allKeptNote(kept);
        if (n) notesOut.push(n);
      }
      if (notesOut.length) plan.notes = notesOut;
      return { phase: "validate", total, errors, plan };
    }
    if (errors.length) fail("BAD_ARGS", "validation failed", { details: errors });

    const c = M.batchContext(a);
    for (const n of clearNotes(a, sel0)) c.notes.add(n);
    const removed = {};
    const cascade = {};
    const noteIds = [];
    const idents = {};
    const names = {};
    const deals0 = dealCount();
    const notes0 = noteCount();
    const done = (type, id) => slot(removed, type, () => []).push(id);
    const bump = (k, n = 1) => {
      if (n) cascade[k] = (cascade[k] || 0) + n;
    };
    for (const type of Object.keys(pick)) {
      for (const [id, x] of pick[type]) {
        slot(idents, type, () => ({}))[String(id)] = fingerprint(type, x);
        const list = slot(names, MANY[type], () => []);
        if (list.length < NAME_SAMPLE) list.push(nameOfX(type, x));
      }
    }

    const each = (type, fn) => {
      const m = pick[type];
      if (!m?.size) return;
      for (const [id, x] of m) {
        fn(x, id);
        done(type, id);
      }
      T.resetMemo?.();
    };

    each("note", () => {});
    if (pick.note?.size) dropNotes([...pick.note.keys()]);
    each("label", l => {
      document.getElementById(`textPath_${l.id}`)?.remove();
      l.el?.remove();
      noteIds.push(l.id);
    });
    if (pick.marker?.size) {
      const ids = new Set(pick.marker.keys());
      pack.markers = pack.markers.filter(m => !ids.has(m.i));
    }
    each("marker", (_m, id) => {
      document.getElementById(`marker${id}`)?.remove();
      noteIds.push(`marker${id}`);
    });
    if (pick.zone?.size) {
      const ids = new Set(pick.zone.keys());
      pack.zones = pack.zones.filter(z => !ids.has(z.i));
    }
    each("zone", (_z, id) => document.getElementById(`zone${id}`)?.remove());
    each("route", r => noteIds.push(removeRouteData(r)));
    const orphanCount = a.ids !== undefined ? Number(a.orphanCount) || 0 : orphans.size;
    if (orphanCount) cascade.orphanRoutes = orphanCount;
    if (pick.river?.size) noteIds.push(...removeRiversData(new Set(pick.river.keys())));
    each("river", () => {});

    const capitalsLog = [];
    const headsLog = [];
    if (pick.burg?.size) {
      const exclude = new Set(pick.burg.keys());
      const markets = [];
      const capitals = [];
      const staying = pid => {
        const p = pack.provinces[pid];
        return !pick.province?.has(pid) && !pick.state?.has(p?.state);
      };
      each("burg", b => {
        const out = removeBurgFull(b, { exclude, newCapital: caps.get(b.state), heads, statesGoing: pick.state });
        if (out.capital) {
          capitals.push(out.capital);
          if (out.capital.to) capitalsLog.push({ state: out.capital.state, burg: out.capital.to });
        }
        if (out.markets) markets.push(...out.markets);
        for (const x of out.provinces || []) {
          if (!staying(x.province)) continue;
          bump("provinceCapitalsMoved");
          if (x.to) headsLog.push({ province: x.province, burg: x.to });
        }
      });
      if (capitals.length) cascade.capitalsMoved = capitals.slice(0, KEPT_ROWS);
      if (capitals.length > KEPT_ROWS) cascade.capitalsMovedTotal = capitals.length;
      bump("marketsRemoved", markets.length);
      bump("burgsToOtherMarkets", removeMarkets(markets));
      dropBurgDeals(exclude);
      for (const s of capitals) c.R.add("stateLabels", [s.state]);
    }

    if (pick.province?.size) {
      each("province", () => {});
      noteIds.push(...removeProvincesData([...pick.province.values()]));
      c.R.add("provinces");
      c.R.add("borders");
    }

    if (pick.state?.size) {
      each("state", () => {});
      const res = removeStatesData([...pick.state.values()]);
      bump("provincesWithStates", res.provinces);
      noteIds.push(...res.noteIds);
      c.R.add("states");
      c.R.add("borders");
      c.R.add("provinces");
    }

    each("religion", x => removeReligionData(x));
    if (pick.religion?.size) c.R.add("religions");
    each("culture", x => bump("religionsToCulture0", removeCultureData(x)));
    if (pick.culture?.size) c.R.add("cultures");

    each("emblem", e => removeEmblem(e.type, e.x));
    if (pick.emblem?.size) c.R.add("emblems");

    dropNotes(noteIds);
    bump("dealsDropped", deals0 - dealCount());
    bump("notesDropped", notes0 - noteCount() - (pick.note?.size || 0));
    if (pick.burg?.size || pick.route?.size) {
      const sw = sweepRouteLinks();
      if (sw.removed || sw.added) cascade.routeLinksFixed = sw;
    }
    T.resetMemo?.();
    const rd = await M.finishRedraw(a, c.R);

    const resolved = { removed };
    if (Object.keys(idents).length) resolved.idents = idents;
    if (capitalsLog.length) resolved.capitals = capitalsLog;
    if (headsLog.length) resolved.provinceHeads = headsLog;
    // how many of removed.route were orphans (the log summary only; replay passes it back)
    if (orphanCount) resolved.orphanRoutes = orphanCount;
    if (a.force) resolved.force = true;
    if (a.redraw !== undefined) resolved.redraw = a.redraw;
    const counts = {};
    for (const type of Object.keys(removed)) counts[MANY[type]] = removed[type].length;
    const out = { resolved, removed: counts, total, names };
    if (Object.keys(kept).length) out.kept = keptView(kept, a.detail);
    if (Object.keys(cascade).length) out.cascade = cascade;
    if (a.detail) out.ids = Object.fromEntries(Object.entries(removed).map(([t, v]) => [MANY[t], v]));
    return { ...out, ...rd, notes: [...c.notes] };
  };

  T.removal = { sweepRouteLinks, orphanRoutes, removeBurgFull, removeRouteData, removeStatesData };
})(globalThis);
