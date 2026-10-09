// Tupaia MCP bridge extension: freehand routes and custom route groups.
// Classic script injected after bridge.js and bridge-mutations.js (src/browser.ts, name order).
// Same rules as the core bridge: app globals by bare name at call time, no locals that shadow
// app globals (routes, rivers, markers, ...), every FNS function takes one args object.
//
// What it adds
//   routeGroup  a new entity type: one `<g id>` under #routes (find, inspect, edit, add, remove,
//               ref resolution, diff). The group's style lives in SVG attributes, which the app
//               saves and loads with the rest of #map; drawRoutes only refills existing groups.
//   add route   {points: [Place...], noPathfind: true, group?, name?, lock?}: a route along
//               exactly those points (no pathfinding, may cross water). `through` + noPathfind
//               is accepted as an alias of `points`. Roads/trails/searoutes through `through`
//               without noPathfind are unchanged (custom groups pathfind over land).
//   edit route  {set: {points, group, name}}: replace the points of any route.
//
// Link policy (pack.cells.routes) for routes whose consecutive points are not neighbours, the
// same one Routes.buildLinks applies when the app rebuilds links from pack.routes:
//   one symmetric cell-to-cell link per consecutive pair of points, whatever the distance
//   between the two cells (a "jump"); a pair inside one cell gets no link; a pair another route
//   already holds keeps its owner. Routes.remove deletes exactly the links a route owns.
(root => {
  const T = root.__tupaia;
  if (!T?.mutations) return;
  const fail = T.fail;
  const I = T.internals;
  const { FIELDS, ADD, REMOVE, IDENT, TRACKED_TYPES, literalPlace } = T.mutations;

  const SVG_NS = "http://www.w3.org/2000/svg";
  const DEFAULT_GROUPS = ["roads", "trails", "searoutes"];
  const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
  const MAX_POINTS = 2000;
  const LINECAPS = ["butt", "round", "square"];
  // user-facing field -> SVG attribute, and the value a new group gets when it is left out
  const ATTR = {
    stroke: "stroke",
    width: "stroke-width",
    dash: "stroke-dasharray",
    linecap: "stroke-linecap",
    opacity: "opacity"
  };
  const DEFAULTS = { stroke: "#000000", width: 0.5, dash: null, linecap: "butt", opacity: 1 };

  const rn = (v, d = 2) => {
    const m = 10 ** d;
    return Math.round(v * m) / m;
  };
  const _isObj = v => !!v && typeof v === "object" && !Array.isArray(v);

  // ---------------------------------------------------------------- group rows (live DOM)

  const groupEls = () => [...document.querySelectorAll("#routes > g")];
  const routesIn = id => (pack.routes || []).filter(r => r && r.group === id);

  function readAttr(el, field) {
    const raw = el.getAttribute(ATTR[field]);
    if (raw === null || raw === "") return null;
    if (field === "width" || field === "opacity") {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    return raw;
  }

  /** A row over a `<g>`: every value is read from the DOM when asked, so edits show at once. */
  function groupRow(el) {
    return {
      el,
      i: el.id,
      id: el.id,
      get name() {
        return el.getAttribute("data-name") || el.id;
      },
      get stroke() {
        return readAttr(el, "stroke");
      },
      get width() {
        return readAttr(el, "width");
      },
      get dash() {
        return readAttr(el, "dash");
      },
      get linecap() {
        return readAttr(el, "linecap");
      },
      get opacity() {
        return readAttr(el, "opacity");
      },
      get routes() {
        return routesIn(el.id).length;
      },
      get order() {
        return groupEls().indexOf(el);
      },
      get after() {
        return el.previousElementSibling?.id ?? null;
      },
      get before() {
        return el.nextElementSibling?.id ?? null;
      }
    };
  }

  const listGroups = () => groupEls().map(groupRow);
  const styleOf = g => ({ stroke: g.stroke, width: g.width, dash: g.dash, linecap: g.linecap, opacity: g.opacity });

  function groupBox(g) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of routesIn(g.id))
      for (const p of r.points || []) {
        if (p[0] < x0) x0 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[0] > x1) x1 = p[0];
        if (p[1] > y1) y1 = p[1];
      }
    return Number.isFinite(x0) ? { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 } : null;
  }

  T.registerType("routeGroup", {
    list: listGroups,
    stringIds: true,
    alt: g => (g.name !== g.id ? [g.id] : []),
    fields: ["routes", "stroke", "width", "dash", "opacity"],
    project: g => ({ name: g.name, ...styleOf(g), routes: g.routes, after: g.after }),
    entity: g => ({
      id: g.id,
      name: g.name,
      ...styleOf(g),
      order: g.order,
      builtIn: DEFAULT_GROUPS.includes(g.id),
      routes: routesIn(g.id).map(r => r.i)
    }),
    relations: g => ({ routeCount: g.routes, after: g.after, before: g.before }),
    box: groupBox
  });

  // ---------------------------------------------------------------- value checks

  const colorCheck = field => v => {
    if (typeof v !== "string" || !/^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|url\(#|[a-z]+$)/i.test(v.trim()))
      fail("BAD_ARGS", `${field} must be a CSS colour such as #aa3322`);
    return v.trim();
  };
  const numCheck = (field, min, max) => v => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
      fail("BAD_ARGS", `${field} must be a number within ${min}..${max}`);
    return v;
  };

  /** "2.5 1.6" | "2.5,1.6" | [2.5, 1.6] -> "2.5 1.6"; null | "" | "none" | "solid" -> null (a solid line). */
  function dashCheck(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "string" && /^\s*(|none|solid)\s*$/i.test(v)) return null;
    const parts = Array.isArray(v) ? v : typeof v === "string" ? v.trim().split(/[\s,]+/) : null;
    const nums = parts?.map(Number);
    if (!nums?.length || nums.length > 8 || nums.some(n => !Number.isFinite(n) || n < 0) || !nums.some(n => n > 0))
      fail("BAD_ARGS", "dash is a pattern such as '2.5 1.6' (or [2.5, 1.6]); null or 'solid' for an unbroken line");
    return nums.join(" ");
  }

  function linecapCheck(v) {
    if (!LINECAPS.includes(v)) fail("BAD_ARGS", `linecap must be one of ${LINECAPS.join(", ")}`);
    return v;
  }

  function nameCheck(v) {
    if (v === null) return null;
    if (typeof v !== "string" || !v.trim()) fail("BAD_ARGS", "name must be a non-empty string (null clears it)");
    return v.trim();
  }

  function groupRef(v, what) {
    try {
      return T.resolve("routeGroup", v);
    } catch (e) {
      if (e.code === "NOT_FOUND" && !e.details) e.details = groupEls().map(g => g.id);
      if (e.code === "NOT_FOUND") e.message = `${what}: ${e.message}`;
      throw e;
    }
  }

  // ---------------------------------------------------------------- route group: edit

  function writeAttr(el, field, v) {
    if (v === null || v === undefined) el.removeAttribute(ATTR[field]);
    else el.setAttribute(ATTR[field], String(v));
  }

  const styleField = (field, check) => ({
    check,
    get: g => readAttr(g.el, field),
    set: (g, v) => writeAttr(g.el, field, v)
  });

  /** after/before: move the group in draw order (later groups draw on top). */
  const orderField = side => ({
    check: (v, g, _c, set) => {
      if (set && set.after !== undefined && set.before !== undefined) fail("BAD_ARGS", "set after or before, not both");
      const ref = groupRef(v, side).entity;
      if (ref.id === g.id) fail("BAD_ARGS", `a group cannot be placed ${side} itself`);
      return ref.id;
    },
    get: g => (side === "after" ? g.after : g.before),
    set: (g, id) => {
      const ref = document.getElementById(id);
      if (side === "after") ref.after(g.el);
      else ref.before(g.el);
    }
  });

  FIELDS.routeGroup = {
    name: {
      check: nameCheck,
      get: g => g.el.getAttribute("data-name"),
      set: (g, v) => (v === null ? g.el.removeAttribute("data-name") : g.el.setAttribute("data-name", v))
    },
    stroke: styleField("stroke", colorCheck("stroke")),
    width: styleField("width", numCheck("width", 0.01, 50)),
    dash: styleField("dash", dashCheck),
    linecap: styleField("linecap", linecapCheck),
    opacity: styleField("opacity", numCheck("opacity", 0, 1)),
    after: orderField("after"),
    before: orderField("before")
  };

  // identity recorded with each edit/remove op of a sketch (see IDENT in bridge-mutations.js)
  IDENT.routeGroup = g => ({
    name: g.el.getAttribute("data-name"),
    ...styleOf(g),
    routes: g.routes
  });

  // ---------------------------------------------------------------- route group: remove

  const FALLBACK_GROUP = "roads";

  function fallbackGroup(g, op) {
    const to = groupRef(op?.moveTo ?? FALLBACK_GROUP, "moveTo").entity;
    if (to.id === g.id) fail("BAD_ARGS", "moveTo must be another group");
    return to.id;
  }

  REMOVE.routeGroup = {
    takesForce: true,
    check(g, _c, op) {
      if (DEFAULT_GROUPS.includes(g.id))
        fail("REFUSED", `${g.id} is one of the app's built-in route groups and cannot be removed`);
      const held = routesIn(g.id);
      if (!held.length) return { routes: 0 };
      if (!op?.force) {
        const names = held.slice(0, 3).map(r => I.nameOf("route", r));
        fail(
          "REFUSED",
          `route group ${g.id} still holds ${held.length} route(s) (${names.join(", ")}${held.length > 3 ? ", ..." : ""}); move them first (edit route {set:{group}}) or pass force:true to move them all to '${op?.moveTo ?? FALLBACK_GROUP}'`
        );
      }
      return { routes: held.length, moveTo: fallbackGroup(g, op) };
    },
    apply(g, c, op) {
      const held = routesIn(g.id);
      let to = null;
      if (held.length) {
        to = fallbackGroup(g, op);
        for (const r of held) r.group = to;
        c.R.add("routes");
      }
      g.el.remove();
      return held.length ? { row: { moved: held.length, moveTo: to }, resolved: { force: true, moveTo: to } } : {};
    }
  };

  // ---------------------------------------------------------------- route group: add

  TRACKED_TYPES.push("routeGroup");

  const GROUP_KEYS = ["id", "name", "stroke", "width", "dash", "linecap", "opacity", "after", "before"];

  ADD.routeGroup = {
    check(item, c) {
      for (const k of Object.keys(item))
        if (!GROUP_KEYS.includes(k))
          fail("BAD_FIELD", `routeGroup items take no field '${k}'`, { details: GROUP_KEYS });
      const id = item.id;
      if (typeof id !== "string" || !ID_RE.test(id))
        fail(
          "BAD_ARGS",
          "routeGroup needs id: letters, digits, '_' and '-', starting with a letter, e.g. 'route-tunnels'"
        );
      if (!id.startsWith("route-"))
        fail("BAD_ARGS", `route group ids start with 'route-' (as in the app's group editor): use 'route-${id}'`);
      if (document.getElementById(id) || c.claimed.has(`routeGroup:${id}`))
        fail("REFUSED", `an element with id '${id}' already exists; pick another id`);
      if (item.after !== undefined && item.before !== undefined) fail("BAD_ARGS", "pass after or before, not both");
      const q = { id, name: item.name === undefined ? null : nameCheck(item.name) };
      const checks = {
        stroke: colorCheck("stroke"),
        width: numCheck("width", 0.01, 50),
        dash: dashCheck,
        linecap: linecapCheck,
        opacity: numCheck("opacity", 0, 1)
      };
      for (const k of Object.keys(checks)) q[k] = item[k] === undefined ? DEFAULTS[k] : checks[k](item[k]);
      for (const side of ["after", "before"])
        if (item[side] !== undefined) {
          const ref = groupRef(item[side], side).entity;
          q[side] = ref.id;
        }
      c.claimed.add(`routeGroup:${id}`);
      return q;
    },
    plan: (q, row) =>
      Object.assign(row, {
        id: q.id,
        stroke: q.stroke,
        width: q.width,
        dash: q.dash,
        linecap: q.linecap,
        opacity: q.opacity,
        position: q.after ? `after ${q.after}` : q.before ? `before ${q.before}` : "last (drawn on top)"
      }),
    apply(q) {
      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("id", q.id);
      for (const k of Object.keys(ATTR)) if (q[k] !== null) g.setAttribute(ATTR[k], String(q[k]));
      g.setAttribute("fill", "none");
      if (q.name) g.setAttribute("data-name", q.name);
      const layer = document.getElementById("routes");
      if (!layer) fail("PAGE_ERROR", "the map has no #routes layer");
      if (q.after) document.getElementById(q.after).after(g);
      else if (q.before) document.getElementById(q.before).before(g);
      else layer.append(g);
      const row = groupRow(g);
      const lit = { id: q.id, stroke: q.stroke, width: q.width, dash: q.dash, linecap: q.linecap, opacity: q.opacity };
      if (q.name) lit.name = q.name;
      if (q.after) lit.after = q.after;
      if (q.before) lit.before = q.before;
      return { _r: lit, i: q.id, name: row.name, ...styleOf(row), order: row.order };
    }
  };

  // ---------------------------------------------------------------- route points and links

  function distanceInfo(px) {
    const unit = document.getElementById("distanceUnitInput")?.value || "km";
    return { px: rn(px, 1), [unit]: rn(px * distanceScale, 1) };
  }

  /** Validated places of a points list, or fail naming the bad one. */
  function checkPlaces(v, what) {
    if (!Array.isArray(v) || v.length < 2) fail("BAD_ARGS", `${what} needs at least 2 places`);
    if (v.length > MAX_POINTS) fail("BAD_ARGS", `${what} takes at most ${MAX_POINTS} places`);
    const places = v.map((x, k) => {
      try {
        return T.place(x);
      } catch (e) {
        e.message = `${what}[${k}]: ${e.message}`;
        throw e;
      }
    });
    if (places.every(p => p.x === places[0].x && p.y === places[0].y))
      fail("BAD_ARGS", `all ${what} are the same spot; a route needs a length`);
    return places;
  }

  const toPoints = places => places.map(p => [p.x, p.y, p.cell]);

  /** Compact before/after/show form of a points list (token-lean, comparable). */
  function describePoints(pts) {
    const p = (pts || []).map(q => [q[0], q[1], q[2]]);
    const len = T.pure.polylineAt(
      p.map(q => [q[0], q[1]]),
      1
    )?.length;
    return {
      n: p.length,
      from: p[0] ?? null,
      to: p[p.length - 1] ?? null,
      px: rn(len ?? 0, 1),
      h: T.pure.hashStr(JSON.stringify(p))
    };
  }

  /** Delete every link the route owns (both directions) and prune emptied rows. Returns the freed [a, b] pairs. */
  function unlinkRoute(r) {
    const L = pack.cells.routes;
    const freed = [];
    if (!L) return freed;
    for (const pt of r.points || []) {
      const from = pt[2];
      const row = L[from];
      if (!row) continue;
      for (const [to, id] of Object.entries(row)) {
        if (id !== r.i) continue;
        freed.push([from, Number(to)]);
        delete row[to];
        const back = L[to];
        if (back) {
          if (back[from] === r.i) delete back[from];
          if (!Object.keys(back).length) delete L[to];
        }
      }
      if (L[from] && !Object.keys(L[from]).length) delete L[from];
    }
    return freed;
  }

  /**
   * A cell pair holds one route id. When its owner goes (removed, or its points edited away),
   * give each freed pair that nobody holds now to the first other route that still runs through it.
   */
  function healLinks(freed, exceptId) {
    const L = pack.cells.routes;
    if (!L || !freed.length) return;
    const key = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
    const open = new Map();
    for (const [a, b] of freed) if (a !== b && L[a]?.[b] === undefined) open.set(key(a, b), [a, b]);
    if (!open.size) return;
    for (const other of pack.routes) {
      if (!other || other.i === exceptId) continue;
      const pts = other.points || [];
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k][2];
        const b = pts[k + 1][2];
        const hit = a !== b && open.get(key(a, b));
        if (!hit) continue;
        if (!L[a]) L[a] = {};
        if (!L[b]) L[b] = {};
        L[a][b] = other.i;
        L[b][a] = other.i;
        open.delete(key(a, b));
      }
      if (!open.size) return;
    }
  }

  /**
   * One symmetric link per consecutive pair of different cells, whatever their distance; a pair
   * another route already holds keeps its owner. Returns the number of pairs this route linked.
   */
  function linkRoute(r) {
    if (!pack.cells.routes) pack.cells.routes = {};
    const L = pack.cells.routes;
    let made = 0;
    const pts = r.points;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k][2];
      const b = pts[k + 1][2];
      if (a === b) continue;
      const owner = L[a]?.[b];
      if (owner !== undefined) continue; // held by another route, or by this one (a repeated pair)
      if (!L[a]) L[a] = {};
      if (!L[b]) L[b] = {};
      L[a][b] = r.i;
      L[b][a] = r.i;
      made++;
    }
    return made;
  }

  /** The number of links linkRoute would make for these points (no changes). */
  function countLinks(pts, routeId) {
    const L = pack.cells.routes || {};
    const seen = new Set();
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k][2];
      const b = pts[k + 1][2];
      if (a === b || (L[a]?.[b] !== undefined && L[a][b] !== routeId)) continue;
      seen.add(a < b ? `${a}-${b}` : `${b}-${a}`);
    }
    return seen.size;
  }

  /** Redraw one route's path in place (or draw it when missing); note a hidden routes layer. */
  function redrawRoute(r, c) {
    const el = document.getElementById(`route${r.i}`);
    if (el) el.setAttribute("d", Routes.getPath(r));
    else if (layerIsOn("toggleRoutes")) drawRoute(r);
    else c.R.hidden.add("routes");
  }

  /** Replace a route's points, keeping pack.cells.routes consistent. */
  function setRoutePoints(r, pts, c) {
    const freed = unlinkRoute(r);
    r.points = pts.map(p => p.slice());
    r.feature = pack.cells.f[r.points[0][2]];
    delete r.length; // the route editor caches it; recomputed when needed
    delete r.cells;
    linkRoute(r);
    healLinks(freed, r.i); // pairs the route no longer uses go to another route through them
    redrawRoute(r, c);
  }

  // remove route: the app's Routes.remove, then hand its links to other routes through the same pairs
  const coreRemoveRoute = REMOVE.route.apply;
  REMOVE.route.apply = (r, c, op) => {
    const L = pack.cells.routes || {};
    const freed = [];
    for (const pt of r.points || [])
      for (const [to, id] of Object.entries(L[pt[2]] || {})) if (id === r.i) freed.push([pt[2], Number(to)]);
    const out = coreRemoveRoute(r, c, op);
    healLinks(freed, r.i);
    return out;
  };

  // edit route: points (any route), group by id or name
  FIELDS.route.points = {
    // the checked value is the replayable form: places with entity refs resolved to ids
    check: v => {
      const places = checkPlaces(v, "points");
      return v.map((input, k) => literalPlace(input, places[k]));
    },
    show: lit => describePoints(toPoints(lit.map(x => T.place(x)))),
    get: r => describePoints(r.points),
    set: (r, lit, c) => setRoutePoints(r, toPoints(lit.map(x => T.place(x))), c)
  };

  const coreGroupCheck = FIELDS.route.group.check;
  FIELDS.route.group.check = v => {
    if (typeof v === "string") {
      try {
        return T.resolve("routeGroup", v).i;
      } catch (e) {
        if (e.code !== "NOT_FOUND") throw e;
      }
    }
    return coreGroupCheck(v);
  };

  // ---------------------------------------------------------------- add route (freehand)

  const coreRoute = ADD.route;
  const FREEHAND_KEYS = ["points", "through", "noPathfind", "group", "name", "lock"];

  function checkRouteGroup(v) {
    const g = v === undefined ? "roads" : v;
    if (typeof g !== "string") fail("BAD_ARGS", "group must be a route group id");
    return groupRef(g, "group").i;
  }

  function freehandCheck(item, c) {
    if (item.noPathfind !== true)
      fail("BAD_ARGS", "points needs noPathfind:true (a route along exactly those points); use through to pathfind");
    if (item.points !== undefined && item.through !== undefined) fail("BAD_ARGS", "pass points or through, not both");
    for (const k of Object.keys(item))
      if (!FREEHAND_KEYS.includes(k)) fail("BAD_FIELD", `route items take no field '${k}'`, { details: FREEHAND_KEYS });
    if (item.name !== undefined && (typeof item.name !== "string" || !item.name.trim()))
      fail("BAD_ARGS", "name must be a non-empty string");
    if (item.lock !== undefined && typeof item.lock !== "boolean") fail("BAD_ARGS", "lock must be true or false");
    const input = item.points ?? item.through;
    const places = checkPlaces(input, "points");
    const group = checkRouteGroup(item.group);
    const name = item.name?.trim();
    if (name) {
      const same = (pack.routes || []).find(r => r && r.name === name);
      if (same) c.notes.add(`a route named '${name}' already exists (${same.i}); this adds another with the same name`);
    }
    const pts = toPoints(places);
    const links = countLinks(pts, -1);
    // freehand routes are locked by default so that regenerating routes keeps them
    return { freehand: true, group, name, lock: item.lock ?? true, places, pts, input, links };
  }

  ADD.route = {
    check(item, c) {
      if (item.noPathfind !== undefined && typeof item.noPathfind !== "boolean")
        fail("BAD_ARGS", "noPathfind must be true or false");
      if (item.noPathfind === true || item.points !== undefined) return freehandCheck(item, c);
      if (item.lock !== undefined && typeof item.lock !== "boolean") fail("BAD_ARGS", "lock must be true or false");
      const { lock, group, noPathfind: _off, ...rest } = item;
      const q = coreRoute.check(group === undefined ? rest : { ...rest, group: checkRouteGroup(group) }, c);
      q.lock = lock;
      return q;
    },
    plan(q, row) {
      if (!q.freehand) return coreRoute.plan(q, row);
      const px = T.pure.polylineAt(
        q.pts.map(p => [p[0], p[1]]),
        1
      )?.length;
      return Object.assign(row, {
        group: q.group,
        freehand: true,
        points: q.pts.length,
        links: q.links,
        length: distanceInfo(px ?? 0)
      });
    },
    apply(q, c, item) {
      if (!q.freehand) {
        const out = coreRoute.apply(q, c, item);
        if (q.lock !== undefined) {
          const r = pack.routes.find(x => x.i === out.i);
          if (r && q.lock) r.lock = true;
          out._r.lock = q.lock;
        }
        return out;
      }
      const C = pack.cells;
      const id = Routes.getNextId();
      const route = { i: id, group: q.group, feature: C.f[q.pts[0][2]], points: q.pts.map(p => p.slice()) };
      if (q.name) route.name = q.name;
      if (q.lock) route.lock = true;
      pack.routes.push(route);
      const links = linkRoute(route);
      if (layerIsOn("toggleRoutes")) drawRoute(route);
      else c.R.hidden.add("routes");
      const len = T.pure.polylineAt(
        route.points.map(p => [p[0], p[1]]),
        1
      )?.length;
      const ends = [route.points[0][2], route.points[route.points.length - 1][2]].map(cell =>
        C.burg[cell] ? { i: C.burg[cell], name: pack.burgs[C.burg[cell]].name } : null
      );
      const lit = {
        points: q.input.map((v, k) => literalPlace(v, q.places[k])),
        noPathfind: true,
        group: q.group,
        lock: q.lock
      };
      if (q.name) lit.name = q.name;
      return {
        _r: lit,
        i: id,
        name: I.nameOf("route", route),
        group: q.group,
        freehand: true,
        points: route.points.length,
        links,
        length: distanceInfo(len ?? 0),
        endBurgs: ends
      };
    }
  };
})(globalThis);
