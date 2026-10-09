// Tupaia MCP bridge extension (track 'clear'): entity removal with the app's own cascades, and
// the bulk `clear` function. Injected after bridge.js and bridge-mutations.js; same rules as
// those: app globals by bare name at call time, no locals that shadow app globals (labels,
// routes, markers, zones, rivers, notes, cells, emblems, ...), one args object per FNS function.
//
// - edit {remove:true} for province, culture and religion: ports of the editors' remove
//   functions (cells fall back to 0, tombstones, emblems, DOM, origins).
// - edit burg {remove:true, force:true, newCapital?, orphanRoutes?}: removes capitals and
//   market centres too, moving what depends on the burg (state capital, province capital,
//   its market, deals). Every burg removal keeps those dependants consistent.
// - Route integrity: removing burgs or routes sweeps pack.cells.routes so every link names a
//   live route on which the two cells are consecutive, and every consecutive pair has a link.
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
    for (const r of pack.routes || []) {
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
    const provinces = (pack.provinces || []).filter(p => alive(p) && p.i && p.burg === b.i).map(p => p.i);
    return { capitalOf, markets, provinces };
  }

  /**
   * Remove a burg and keep its dependants consistent. o: {exclude: Set of burg ids being removed
   * in the same call (never chosen as successors), newCapital?: burg id}. Returns the cascade;
   * out.markets lists the markets it centred, which the CALLER removes (removeMarkets, once).
   */
  function removeBurgFull(b, o) {
    const exclude = new Set(o.exclude || []);
    exclude.add(b.i);
    const out = {};
    const d = burgDependants(b);
    if (d.capitalOf) {
      const s = d.capitalOf;
      let next = o.newCapital ? pack.burgs[o.newCapital] : null;
      if (!next || !alive(next) || next.state !== b.state || exclude.has(next.i)) next = capitalSuccessor(b, exclude);
      if (next) {
        s.capital = next.i;
        s.center = next.cell;
        next.capital = 1;
        Burgs.changeGroup(next, null);
      } else s.capital = 0;
      out.capital = { state: s.i, to: next ? next.i : 0, name: next ? next.name : null };
    }
    if (b.capital) b.capital = 0;
    if (d.markets.length) out.markets = d.markets;
    if (d.provinces.length) {
      out.provinces = d.provinces.map(pid => {
        const p = pack.provinces[pid];
        const next = provinceSuccessor(p, exclude);
        p.burg = next ? next.i : 0;
        return { province: pid, to: p.burg };
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

  // ---------------------------------------------------------------- provinces, cultures, religions

  /** provinces-editor.js removeProvince; returns the note id to drop. */
  function removeProvinceData(p) {
    const C = pack.cells;
    for (let c = 0; c < C.province.length; c++) if (C.province[c] === p.i) C.province[c] = 0;
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
    return `province${p.i}`;
  }

  /** cultures-editor.ts removeCulture: burgs, states and cells fall back to culture 0. */
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

  /** Remove an entity's emblem (coa and its rendered elements). */
  function removeEmblem(type, x) {
    delete x.coa;
    document.getElementById(`${type}COA${x.i}`)?.remove();
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

  const OP_KEYS = ["ref", "remove", "set", "force", "newCapital", "orphanRoutes"];

  function checkOpKeys(type, op) {
    const extra = Object.keys(op || {}).filter(k => !OP_KEYS.includes(k));
    if (extra.length) fail("BAD_FIELD", `edit ops take no field '${extra[0]}'`, { details: OP_KEYS });
    if (type !== "burg" && (op.force !== undefined || op.newCapital !== undefined || op.orphanRoutes !== undefined))
      fail("BAD_ARGS", "force, newCapital and orphanRoutes apply only to burg removal");
  }

  REMOVE.burg = {
    check(b, c, op) {
      const o = op || {};
      checkOpKeys("burg", o);
      const d = burgDependants(b);
      if (!o.force) {
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
      const info = {};
      if (o.newCapital !== undefined && o.newCapital !== null) {
        if (!d.capitalOf)
          fail("BAD_ARGS", `newCapital applies only when removing a state capital; ${b.name} is not one`);
        const nb = T.resolve("burg", o.newCapital).entity;
        if (nb.i === b.i) fail("BAD_ARGS", "newCapital is the burg being removed");
        if (nb.state !== b.state)
          fail("REFUSED", `newCapital ${nb.name} (${nb.i}) is not in ${d.capitalOf.name}; pick a burg of that state`);
        if (batchBurgRemovals(c).has(nb.i))
          fail("REFUSED", `newCapital ${nb.name} (${nb.i}) is removed in this same call`);
        info.newCapital = { i: nb.i, name: nb.name };
      } else if (d.capitalOf) {
        const nb = capitalSuccessor(b, new Set([...batchBurgRemovals(c), b.i]));
        info.newCapital = nb ? { i: nb.i, name: nb.name } : null;
      }
      if (d.capitalOf) info.capitalOf = { i: d.capitalOf.i, name: d.capitalOf.name };
      if (d.markets.length) info.markets = d.markets;
      if (d.provinces.length) info.provinceCapitalOf = d.provinces;
      const n = routesAtCell(b.cell);
      if (n) info.routesThrough = n;
      if (o.orphanRoutes) {
        const removing = new Set([...batchBurgRemovals(c), b.i]);
        info.orphanRoutes = orphanRoutes([b.i], removing).map(r => r.i);
      }
      return Object.keys(info).length ? info : null;
    },
    apply(b, c, op, info) {
      const o = op || {};
      const cascade = removeBurgFull(b, {
        exclude: batchBurgRemovals(c),
        newCapital: info?.newCapital?.i
      });
      const moved = cascade.markets ? removeMarkets(cascade.markets) : 0;
      const deals = dropBurgDeals(new Set([b.i]));
      const row = {};
      if (cascade.capital) row.capital = cascade.capital;
      if (cascade.markets) row.marketsRemoved = cascade.markets;
      if (moved) row.burgsToOtherMarkets = moved;
      if (cascade.provinces) row.provinceCapitals = cascade.provinces;
      if (deals) row.dealsDropped = deals;
      const noteIds = [];
      if (o.orphanRoutes) {
        const gone = orphanRoutes([b.i], new Set([b.i]));
        for (const r of gone) noteIds.push(removeRouteData(r));
        if (gone.length) row.routesRemoved = gone.map(r => r.i);
      } else if (routesAtCell(b.cell))
        c.notes.add(
          "routes through removed burgs are kept; orphanRoutes:true also removes the routes that served only removed burgs"
        );
      dropNotes(noteIds);
      const sw = sweepRouteLinks();
      if (sw.removed || sw.added) row.routeLinksFixed = sw;
      if (cascade.capital) c.R.add("stateLabels", [cascade.capital.state]);
      const resolved = {};
      if (o.force) resolved.force = true;
      if (cascade.capital?.to) resolved.newCapital = cascade.capital.to;
      if (o.orphanRoutes) resolved.orphanRoutes = true;
      return { row, resolved };
    }
  };

  REMOVE.route = {
    apply(r, c) {
      dropNotes([removeRouteData(r)]);
      const sw = sweepRouteLinks();
      void c;
      return sw.removed || sw.added ? { row: { routeLinksFixed: sw } } : null;
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
    check(p, _c, op) {
      checkOpKeys("province", op);
      const n = I.cellsWhere("province", p.i).length;
      return { cells: n };
    },
    apply(p, c) {
      dropNotes([removeProvinceData(p)]);
      c.R.add("provinces");
      c.R.add("borders");
      return null;
    }
  };

  REMOVE.culture = {
    check(x, _c, op) {
      checkOpKeys("culture", op);
      if (!x.i) fail("REFUSED", "Wildlands (culture 0) cannot be removed");
      return {
        cells: I.cellsWhere("culture", x.i).length,
        burgs: pack.burgs.filter(b => alive(b) && b.i && b.culture === x.i).length,
        states: pack.states.filter(s => alive(s) && s.i && s.culture === x.i).length
      };
    },
    apply(x, c) {
      removeCultureData(x);
      c.R.add("cultures");
      return null;
    }
  };

  REMOVE.religion = {
    check(x, _c, op) {
      checkOpKeys("religion", op);
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
      checkOpKeys(type, op);
      return own ? own(x, c, op) : null;
    };
  }

  // a label's note goes with it (as a burg's or a marker's does)
  const labelApply = REMOVE.label.apply;
  REMOVE.label.apply = (l, c, op, info) => {
    const out = labelApply(l, c, op, info);
    dropNotes([l.id]);
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
  // ids of these get reused (max id + 1) or are strings: replay checks a fingerprint, not just the id
  const FINGERPRINTED = new Set(["note", "label", "marker", "route", "zone", "river"]);
  const KEPT_ROWS = 10;
  const ZERO_KEPT = new Set(["state", "culture", "religion"]);

  const idOfX = (type, x) => (type === "emblem" ? x.key : type === "note" || type === "label" ? x.id : x.i);

  function fingerprint(type, x) {
    if (type === "label") return hashStr(`${x.name ?? ""}|${x.group ?? ""}`);
    return hashStr(JSON.stringify(M.identOf(type, x) ?? null));
  }

  function emblemCandidates() {
    const out = [];
    for (const type of EMBLEM_OWNERS)
      for (const x of I.liveList(type)) if (x.coa) out.push({ type, x, key: `${type}:${x.i}` });
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

  function whereFilter(type, filter) {
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
    const refs = {};
    for (const key of Object.keys(filter)) {
      const refType = I.REF_FIELDS[type]?.[key];
      if (!refType) continue;
      const vals = Array.isArray(filter[key]) ? filter[key] : [filter[key]];
      if (vals.every(v => typeof v === "boolean")) continue;
      refs[key] = vals.map(v => T.resolve(refType, v).i);
    }
    return x => I.matchWhere(type, x, filter, refs);
  }

  /** keep [{type, ref}] -> {type: Set(ids)} (emblems are kept with their owner). */
  function parseKeep(keep) {
    const out = {};
    if (keep === undefined || keep === null) return out;
    if (!Array.isArray(keep)) fail("BAD_ARGS", "keep is an array of {type, ref}");
    keep.forEach((k, n) => {
      if (!isObj(k) || typeof k.type !== "string") fail("BAD_ARGS", `keep[${n}] must be {type, ref}`);
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

  /**
   * Choose what a clear removes. Returns {pick: {type: Map(id -> entity)}, kept: {type: [{i,
   * name, why}]}, orphans: Set(route ids), errors}. Literal mode (a.ids, used by replay): exactly
   * those ids, each must be live (and match its fingerprint where one was recorded).
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
              if (!r.entity.coa) fail("NOT_FOUND", `${owner} ${r.name} (${r.i}) has no emblem`);
              m.set(id, { type: owner, x: r.entity, key: id });
              continue;
            }
            const r = T.resolve(type, id);
            // Neutrals, Wildlands and No religion (markers, routes and zones do start at 0)
            if (r.i === 0 && ZERO_KEPT.has(type)) fail("REFUSED", `${type} 0 (${r.name}) cannot be cleared`);
            const want = fps[type]?.[String(id)];
            if (want !== undefined && FINGERPRINTED.has(type) && fingerprint(type, r.entity) !== want)
              fail(
                "CHANGED",
                `${type} ${r.name ? `'${r.name}' ` : ""}(${id}) is not the entity the clear removed: its id was reused or someone changed it`
              );
            m.set(r.i, r.entity);
          } catch (e) {
            errors.push(M.errRow(errors.length, { type, id }, e));
          }
        }
      }
      return { pick, kept, orphans, errors };
    }

    const types = Array.isArray(a.types) ? a.types : [];
    if (!types.length) fail("BAD_ARGS", "types must be a non-empty array", { details: CLEAR_ORDER });
    for (const t of types) if (!(t in ONE)) fail("BAD_ARGS", `unknown type '${t}'`, { details: CLEAR_ORDER });
    const where = parseWhere(types, a.where);
    const keep = parseKeep(a.keep);
    const force = !!a.force;
    const want = CLEAR_ORDER.filter(t => types.includes(t)).map(t => ONE[t]);

    for (const type of want) {
      if (type === "emblem") continue; // after the owners are known
      const match = whereFilter(type, where[type]);
      const m = new Map();
      pick[type] = m;
      for (const x of I.liveList(type)) {
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
    return { pick, kept, orphans, errors };
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

  /** Preview of the cascade (validate phase). */
  function cascadePreview(pick) {
    const out = {};
    const burgs = pick.burg ? [...pick.burg.values()] : [];
    if (burgs.length) {
      let capitals = 0;
      let markets = 0;
      let provinceCapitals = 0;
      for (const b of burgs) {
        const d = burgDependants(b);
        if (d.capitalOf && !pick.state?.has(d.capitalOf.i)) capitals++;
        markets += d.markets.length;
        for (const pid of d.provinces)
          if (!pick.province?.has(pid) && !pick.state?.has(pack.provinces[pid]?.state)) provinceCapitals++;
      }
      if (capitals) out.capitalsMoved = capitals;
      if (markets) out.marketsRemoved = markets;
      if (provinceCapitals) out.provinceCapitalsMoved = provinceCapitals;
    }
    if (pick.state?.size) {
      const n = I.liveList("province").filter(p => pick.state.has(p.state) && !pick.province?.has(p.i)).length;
      if (n) out.provincesWithStates = n;
    }
    return out;
  }

  FNS.clear = async a => {
    const { pick, kept, orphans, errors } = selectClear(a);
    const total = Object.values(pick).reduce((n, m) => n + m.size, 0);
    if (a.phase !== "apply") {
      const plan = { remove: countsOf(pick) };
      if (orphans.size) plan.orphanRoutes = orphans.size;
      if (Object.keys(kept).length) plan.kept = keptView(kept, a.detail);
      const cascade = cascadePreview(pick);
      if (Object.keys(cascade).length) plan.cascade = cascade;
      if (a.detail) plan.ids = Object.fromEntries(Object.entries(pick).map(([t, m]) => [MANY[t], [...m.keys()]]));
      return { phase: "validate", total, errors, plan };
    }
    if (errors.length) fail("BAD_ARGS", "validation failed", { details: errors });

    const c = M.batchContext(a);
    const removed = {};
    const cascade = {};
    const noteIds = [];
    const idents = {};
    const done = (type, id) => slot(removed, type, () => []).push(id);
    const bump = (k, n = 1) => {
      if (n) cascade[k] = (cascade[k] || 0) + n;
    };
    for (const type of Object.keys(pick))
      if (FINGERPRINTED.has(type))
        for (const [id, x] of pick[type]) slot(idents, type, () => ({}))[String(id)] = fingerprint(type, x);

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
    if (orphans.size) cascade.orphanRoutes = orphans.size;
    if (pick.river?.size) noteIds.push(...removeRiversData(new Set(pick.river.keys())));
    each("river", () => {});

    if (pick.burg?.size) {
      const exclude = new Set(pick.burg.keys());
      const markets = [];
      const capitals = [];
      const staying = pid => {
        const p = pack.provinces[pid];
        return !pick.province?.has(pid) && !pick.state?.has(p?.state);
      };
      each("burg", b => {
        const out = removeBurgFull(b, { exclude });
        if (out.capital && !pick.state?.has(out.capital.state)) capitals.push(out.capital);
        if (out.markets) markets.push(...out.markets);
        if (out.provinces) bump("provinceCapitalsMoved", out.provinces.filter(x => staying(x.province)).length);
      });
      if (capitals.length) cascade.capitalsMoved = capitals.slice(0, KEPT_ROWS);
      if (capitals.length > KEPT_ROWS) cascade.capitalsMovedTotal = capitals.length;
      bump("marketsRemoved", markets.length);
      bump("burgsToOtherMarkets", removeMarkets(markets));
      bump("dealsDropped", dropBurgDeals(exclude));
      for (const s of capitals) c.R.add("stateLabels", [s.state]);
    }

    each("province", p => noteIds.push(removeProvinceData(p)));
    if (pick.province?.size) {
      c.R.add("provinces");
      c.R.add("borders");
    }

    if (pick.state?.size) {
      const x = await M.stateInternals();
      each("state", s => {
        const owned = I.liveList("province").filter(p => p.state === s.i).length;
        bump("provincesWithStates", owned);
        // stateRemove expects the emblem element; it exists only once the emblems layer was shown
        const coaId = `stateCOA${s.i}`;
        if (!document.getElementById(coaId)) defs.append("g").attr("id", coaId);
        x.stateRemove(s.i);
        // stateRemove takes the state's own province list; a province missing from it goes too
        for (const p of I.liveList("province")) if (p.state === s.i) noteIds.push(removeProvinceData(p));
      });
    }

    each("religion", x => removeReligionData(x));
    if (pick.religion?.size) c.R.add("religions");
    each("culture", x => removeCultureData(x));
    if (pick.culture?.size) c.R.add("cultures");

    each("emblem", e => removeEmblem(e.type, e.x));
    if (pick.emblem?.size) c.R.add("emblems");

    bump("notesDropped", dropNotes(noteIds));
    if (pick.burg?.size || pick.route?.size) {
      const sw = sweepRouteLinks();
      if (sw.removed || sw.added) cascade.routeLinksFixed = sw;
    }
    T.resetMemo?.();
    const rd = await M.finishRedraw(a, c.R);

    const resolved = { removed };
    if (Object.keys(idents).length) resolved.idents = idents;
    if (orphans.size) resolved.orphanRoutes = orphans.size; // for the log summary only
    if (a.redraw !== undefined) resolved.redraw = a.redraw;
    const counts = {};
    for (const type of Object.keys(removed)) counts[MANY[type]] = removed[type].length;
    const out = { resolved, removed: counts, total };
    if (Object.keys(kept).length) out.kept = keptView(kept, a.detail);
    if (Object.keys(cascade).length) out.cascade = cascade;
    if (a.detail) out.ids = Object.fromEntries(Object.entries(removed).map(([t, v]) => [MANY[t], v]));
    return { ...out, ...rd, notes: [...c.notes] };
  };

  T.removal = { sweepRouteLinks, orphanRoutes, removeBurgFull, removeRouteData };
})(globalThis);
