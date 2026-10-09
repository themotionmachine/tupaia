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
// Link policy (pack.cells.routes), the one Routes.buildLinks applies when the app rebuilds links
// from pack.routes (regenerate routes, resample), so the incremental state always equals a rebuild:
//   one symmetric cell-to-cell link per consecutive pair of points in different cells, whatever the
//   distance between the two cells (a "jump"); a pair inside one cell gets no link (no self-link);
//   a pair several routes pass through belongs to the LAST of them in pack.routes order.
// A new route is last, so it takes every pair it passes through. When a route is removed, or its
// points are edited away from a pair, the pair goes to the last remaining route through it.
// Routes.remove deletes exactly the links a route owns.
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
    box: groupBox,
    count: () => groupEls().length
  });

  // ---------------------------------------------------------------- value checks

  const COLOR_FALLBACK = /^(#[0-9a-f]{3,8}|rgba?\(.*\)|hsla?\(.*\)|[a-z]+)$/i;
  const colorCheck = field => v => {
    const s = typeof v === "string" ? v.trim() : "";
    // CSS closes a function left open at the end of the text, so require balanced brackets as well
    const balanced = (s.match(/\(/g) || []).length === (s.match(/\)/g) || []).length;
    const ok =
      !!s &&
      balanced &&
      (/^url\(#[\w-]+\)$/.test(s) ||
        (typeof CSS !== "undefined" && CSS.supports ? CSS.supports("color", s) : COLOR_FALLBACK.test(s)));
    if (!ok) fail("BAD_ARGS", `${field} must be a CSS colour such as #aa3322, rgb(170 51 34) or a colour name`);
    return s;
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

  /** A display name; one equal to another group's id is refused (a ref would then name two groups). */
  function nameCheck(v, selfId) {
    if (v === null) return null;
    if (typeof v !== "string" || !v.trim()) fail("BAD_ARGS", "name must be a non-empty string (null clears it)");
    const name = v.trim();
    const clash = groupEls().find(g => g.id !== selfId && g.id === name);
    if (clash) fail("BAD_ARGS", `name '${name}' is the id of another route group; pick a different display name`);
    return name;
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

  /** The group id for a route's `group` (add and edit): an id or a display name; roads when left out. */
  function checkRouteGroup(v) {
    const g = v === undefined ? "roads" : v;
    if (typeof g !== "string" || !g.trim()) fail("BAD_ARGS", "group must be a route group id or name (e.g. 'roads')");
    return groupRef(g.trim(), "group").i;
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

  /** A new group id: 'route-' + letters, digits, '_' or '-'; not taken by any element (or earlier in the batch). */
  function newGroupId(id, c) {
    if (typeof id !== "string" || !ID_RE.test(id))
      fail(
        "BAD_ARGS",
        "routeGroup needs id: letters, digits, '_' and '-', starting with a letter, e.g. 'route-tunnels'"
      );
    if (!id.startsWith("route-"))
      fail("BAD_ARGS", `route group ids start with 'route-' (as in the app's group editor): use 'route-${id}'`);
    if (c.claimed.has(`routeGroup:${id}`)) fail("REFUSED", `id '${id}' appears twice in this call; ids must be unique`);
    if (document.getElementById(id)) fail("REFUSED", `an element with id '${id}' already exists; pick another id`);
    c.claimed.add(`routeGroup:${id}`);
    return id;
  }

  FIELDS.routeGroup = {
    // The id is the group's identity (routes keep it in route.group). Renaming it re-points every
    // route of the group; the built-in groups keep theirs (the app looks them up by id).
    id: {
      check: (v, g, c) => {
        if (DEFAULT_GROUPS.includes(g.id))
          fail("REFUSED", `${g.id} is one of the app's built-in route groups; its id is fixed`);
        if (v === g.id) fail("BAD_ARGS", `the group's id is already '${v}'`);
        return newGroupId(v, c);
      },
      get: g => g.el.id,
      set: (g, v) => {
        for (const r of routesIn(g.el.id)) r.group = v;
        g.el.id = v;
      }
    },
    name: {
      check: (v, g) => nameCheck(v, g.id),
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

  // Ops of one call are all validated before any runs, against the page as it is. A group removed or
  // filled by an earlier op of the same call is tracked in the batch context (c.rgGone: ids removed,
  // c.rgInto: routes moved into a group) so that the checks see what the earlier ops will do.
  REMOVE.routeGroup = {
    takesForce: true,
    takesMoveTo: true,
    check(g, c, op) {
      if (DEFAULT_GROUPS.includes(g.id))
        fail("REFUSED", `${g.id} is one of the app's built-in route groups and cannot be removed`);
      if (!c.rgGone) {
        c.rgGone = new Set();
        c.rgInto = new Map();
      }
      const gone = c.rgGone;
      const into = c.rgInto;
      if (gone.has(g.id)) fail("BAD_ARGS", `route group ${g.id} is removed twice in this call`);
      const moved = into.get(g.id) || 0;
      const held = routesIn(g.id);
      const total = held.length + moved;
      let to = null;
      if (total) {
        if (!(op?.force ?? c?.args?.force)) {
          const names = held.slice(0, 3).map(r => I.nameOf("route", r));
          const what = held.length
            ? `${held.length} route(s) (${names.join(", ")}${held.length > 3 ? ", ..." : ""})${moved ? ` and ${moved} moved in by an earlier op of this call` : ""}`
            : `${moved} route(s) moved in by an earlier op of this call`;
          fail(
            "REFUSED",
            `route group ${g.id} still holds ${what}; move them first (edit route {set:{group}}) or pass force:true to move them all to '${op?.moveTo ?? FALLBACK_GROUP}'`
          );
        }
        to = fallbackGroup(g, op);
        if (gone.has(to))
          fail(
            "BAD_ARGS",
            `moveTo ${to} is removed earlier in this call; order the ops so the target outlives this one`
          );
        into.set(to, (into.get(to) || 0) + total);
      }
      gone.add(g.id);
      return total ? { routes: total, moveTo: to } : { routes: 0 };
    },
    apply(g, c, op) {
      const held = routesIn(g.id);
      let to = null;
      if (held.length) {
        // never move routes without force (check guarantees it; this guards a changed page)
        if (!(op?.force ?? c?.args?.force))
          fail("REFUSED", `route group ${g.id} now holds ${held.length} route(s); pass force:true to move them`);
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

  /** after/before of a new group: an existing group, or a group an earlier item of this call creates. */
  function anchorId(v, side, c) {
    if (typeof v === "string" && c.claimed.has(`routeGroup:${v}`)) return v;
    return groupRef(v, side).entity.id;
  }

  ADD.routeGroup = {
    check(item, c) {
      for (const k of Object.keys(item))
        if (!GROUP_KEYS.includes(k))
          fail("BAD_FIELD", `routeGroup items take no field '${k}'`, { details: GROUP_KEYS });
      const id = newGroupId(item.id, c);
      if (item.after !== undefined && item.before !== undefined) fail("BAD_ARGS", "pass after or before, not both");
      const q = { id, name: item.name === undefined ? null : nameCheck(item.name, id) };
      const checks = {
        stroke: colorCheck("stroke"),
        width: numCheck("width", 0.01, 50),
        dash: dashCheck,
        linecap: linecapCheck,
        opacity: numCheck("opacity", 0, 1)
      };
      for (const k of Object.keys(checks)) q[k] = item[k] === undefined ? DEFAULTS[k] : checks[k](item[k]);
      for (const side of ["after", "before"]) if (item[side] !== undefined) q[side] = anchorId(item[side], side, c);
      if (q.after === id || q.before === id) fail("BAD_ARGS", "a group cannot be placed next to itself");
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
      const anchor = q.after || q.before ? document.getElementById(q.after || q.before) : null;
      if ((q.after || q.before) && !anchor)
        fail(
          "NOT_FOUND",
          `${q.after ? "after" : "before"}: no routeGroup '${q.after || q.before}' (its own add failed)`
        );
      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("id", q.id);
      for (const k of Object.keys(ATTR)) if (q[k] !== null) g.setAttribute(ATTR[k], String(q[k]));
      g.setAttribute("fill", "none");
      if (q.name) g.setAttribute("data-name", q.name);
      const layer = document.getElementById("routes");
      if (!layer) fail("PAGE_ERROR", "the map has no #routes layer");
      if (q.after) anchor.after(g);
      else if (q.before) anchor.before(g);
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

  /**
   * One point of a freehand route: any Place, or a pinned [x, y, cell] / {x, y, cell} that keeps the
   * cell it names while x,y is where the line is drawn (a plain Place with x,y and cell would use only
   * the cell). Returns {x, y, cell, pinned}.
   */
  function pointOf(input) {
    let pin = null;
    if (Array.isArray(input)) {
      if (input.length !== 3) fail("BAD_PLACE", "a point is a Place, or [x, y, cell] to pin the cell");
      pin = { x: input[0], y: input[1], cell: input[2] };
    } else if (_isObj(input) && input.x !== undefined && input.y !== undefined && input.cell !== undefined) {
      pin = input;
    }
    if (!pin) return { ...T.place(input), pinned: false };
    const x = Number(pin.x);
    const y = Number(pin.y);
    const cell = Number(pin.cell);
    if (!Number.isFinite(x) || !Number.isFinite(y)) fail("BAD_PLACE", "x and y must be numbers");
    if (!Number.isInteger(cell) || cell < 0 || cell >= pack.cells.p.length)
      fail("OUT_OF_BOUNDS", `cell ${pin.cell} is outside 0..${pack.cells.p.length - 1}`);
    if (x < 0 || y < 0 || x > graphWidth || y > graphHeight)
      fail("OUT_OF_BOUNDS", `(${rn(x, 1)}, ${rn(y, 1)}) is outside the map 0..${graphWidth} x 0..${graphHeight}`, {
        details: { bounds: [0, 0, graphWidth, graphHeight] }
      });
    return { x: rn(x, 2), y: rn(y, 2), cell, pinned: true };
  }

  /** The replayable form of a checked point: places keep their entity refs, pinned points keep their cell. */
  const literalPoint = (input, pt) => (pt.pinned ? { x: pt.x, y: pt.y, cell: pt.cell } : literalPlace(input, pt));

  /** Validated points of a freehand route, or fail naming the bad one. */
  function checkPlaces(v, what) {
    if (!Array.isArray(v) || v.length < 2) fail("BAD_ARGS", `${what} needs at least 2 places`);
    if (v.length > MAX_POINTS) fail("BAD_ARGS", `${what} takes at most ${MAX_POINTS} places`);
    const pts = v.map((x, k) => {
      try {
        return pointOf(x);
      } catch (e) {
        e.message = `${what}[${k}]: ${e.message}`;
        throw e;
      }
    });
    if (pts.every(p => p.x === pts[0].x && p.y === pts[0].y))
      fail("BAD_ARGS", `all ${what} are the same spot; a route needs a length`);
    return pts;
  }

  const toPoints = pts => pts.map(p => [p.x, p.y, p.cell]);

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

  // ---- links (pack.cells.routes): see the link policy at the top of the file

  const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

  /** The distinct pairs of different cells among consecutive points: Map "a-b" -> [a, b]. */
  function pairsOf(pts) {
    const m = new Map();
    for (let k = 0; k < (pts?.length || 0) - 1; k++) {
      const a = pts[k][2];
      const b = pts[k + 1][2];
      if (a !== b) m.set(pairKey(a, b), [a, b]);
    }
    return m;
  }

  /** The pairs among a route's consecutive points that its id holds a link for. */
  function ownedPairs(r) {
    const L = pack.cells.routes || {};
    const m = new Map();
    for (const [key, [a, b]] of pairsOf(r.points)) if (L[a]?.[b] === r.i) m.set(key, [a, b]);
    return m;
  }

  function dropLink(L, a, b) {
    for (const [from, to] of [
      [a, b],
      [b, a]
    ]) {
      if (!L[from]) continue;
      delete L[from][to];
      if (!Object.keys(L[from]).length) delete L[from];
    }
  }

  /** Set each pair to the last route in pack.routes order that passes through it (Routes.buildLinks' rule), or no link. */
  function reown(pairs) {
    if (!pairs.size) return;
    if (!pack.cells.routes) pack.cells.routes = {};
    const L = pack.cells.routes;
    const owner = new Map();
    for (const r of pack.routes) {
      if (!r) continue;
      const pts = r.points || [];
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k][2];
        const b = pts[k + 1][2];
        if (a === b) continue;
        const key = pairKey(a, b);
        if (pairs.has(key)) owner.set(key, r.i);
      }
    }
    for (const [key, [a, b]] of pairs) {
      const id = owner.get(key);
      if (id === undefined) {
        dropLink(L, a, b);
        continue;
      }
      if (!L[a]) L[a] = {};
      if (!L[b]) L[b] = {};
      L[a][b] = id;
      L[b][a] = id;
    }
  }

  /** Link a route that was just pushed to the end of pack.routes: it takes every pair it passes through. Returns the pair count. */
  function linkRoute(r) {
    const pairs = pairsOf(r.points);
    reown(pairs);
    return pairs.size;
  }

  /** Redraw one route's path in place (or draw it when missing); note a hidden routes layer. */
  function redrawRoute(r, c) {
    const el = document.getElementById(`route${r.i}`);
    if (el) el.setAttribute("d", Routes.getPath(r));
    else if (layerIsOn("toggleRoutes")) drawRoute(r);
    else c.R.hidden.add("routes");
  }

  /** Replace a route's points, keeping pack.cells.routes what a rebuild from pack.routes would give. */
  function setRoutePoints(r, pts, c) {
    const affected = ownedPairs(r);
    r.points = pts.map(p => p.slice());
    r.feature = pack.cells.f[r.points[0][2]];
    delete r.length; // the route editor caches it; recomputed when needed
    delete r.cells;
    for (const [key, pair] of pairsOf(r.points)) affected.set(key, pair);
    reown(affected);
    redrawRoute(r, c);
  }

  // remove route: the app's Routes.remove, then hand the links it owned to the last other route through the same pairs
  const coreRemoveRoute = REMOVE.route.apply;
  REMOVE.route.apply = (r, c, op) => {
    const freed = ownedPairs(r);
    const out = coreRemoveRoute(r, c, op);
    reown(freed);
    return out;
  };

  // edit route: points (any route), group by id or name
  // The resolved [x, y, cell] points of a checked value are kept beside it, so applying does not look
  // the places up again (a place may name an entity an earlier op of the same call removes).
  const checkedPts = new WeakMap();
  const resolvePts = lit => checkedPts.get(lit) ?? toPoints(lit.map(pointOf));
  FIELDS.route.points = {
    // the checked value is the replayable form: places with entity refs resolved to ids
    check: (v, r, c, set) => {
      const pts = checkPlaces(v, "points");
      const lit = v.map((input, k) => literalPoint(input, pts[k]));
      const triples = toPoints(pts);
      checkedPts.set(lit, triples);
      if (!pairsOf(triples).size)
        c.notes.add(`route ${r.i}: all points fall into cell ${triples[0][2]}, so the route links no cells`);
      if (describePoints(r.points).h === describePoints(triples).h)
        c.notes.add(`route ${r.i}: the points are the same as before; nothing changes`);
      // a generated route becomes hand-drawn, but regenerating routes replaces unlocked routes
      const locked = set && set.lock !== undefined ? !!set.lock : !!r.lock;
      if (!locked)
        c.notes.add(
          `route ${r.i} is not locked: regenerating routes replaces it (add lock:true to keep an edited route)`
        );
      return lit;
    },
    show: lit => describePoints(resolvePts(lit)),
    get: r => describePoints(r.points),
    set: (r, lit, c) => setRoutePoints(r, resolvePts(lit), c)
  };

  FIELDS.route.group.check = v => {
    if (v === undefined) fail("BAD_ARGS", "group must be a route group id or name");
    return checkRouteGroup(v);
  };

  // ---------------------------------------------------------------- add route (freehand)

  const coreRoute = ADD.route;
  const FREEHAND_KEYS = ["points", "through", "noPathfind", "group", "name", "lock"];

  function freehandCheck(item, c) {
    if (item.noPathfind !== true)
      fail("BAD_ARGS", "points needs noPathfind:true (a route along exactly those points); use through to pathfind");
    if (item.points !== undefined && item.through !== undefined) fail("BAD_ARGS", "pass points or through, not both");
    for (const k of Object.keys(item))
      if (!FREEHAND_KEYS.includes(k)) fail("BAD_FIELD", `route items take no field '${k}'`, { details: FREEHAND_KEYS });
    if (item.name !== undefined && (typeof item.name !== "string" || !item.name.trim()))
      fail("BAD_ARGS", "name must be a non-empty string");
    if (item.lock !== undefined && typeof item.lock !== "boolean") fail("BAD_ARGS", "lock must be true or false");
    const group = checkRouteGroup(item.group);
    const input = item.points ?? item.through;
    const places = checkPlaces(input, "points");
    const name = item.name?.trim();
    const warn = [];
    if (name) {
      const same = (pack.routes || []).find(r => r && r.name === name);
      if (same) warn.push(`a route named '${name}' already exists (${same.i}); this adds another with the same name`);
      else if (c.claimed.has(`routeName:${name}`)) warn.push(`'${name}' is used twice in this call`);
      c.claimed.add(`routeName:${name}`);
    }
    const pts = toPoints(places);
    // legitimate (a short decorative line), but nothing is connected: say so
    if (!pairsOf(pts).size)
      warn.push(`all points fall into cell ${pts[0][2]}: the route is drawn, but it links no cells`);
    for (const n of warn) c.notes.add(n);
    // freehand routes are locked by default so that regenerating routes keeps them
    return {
      freehand: true,
      group,
      name,
      lock: item.lock ?? true,
      places,
      pts,
      input,
      links: pairsOf(pts).size,
      notes: warn
    };
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
      if (!q.freehand) {
        coreRoute.plan(q, row);
        // the core plan measures the cell-centre path; the route is drawn along smoothed, anchored points
        try {
          const drawn = Routes.getPoints(q.group, q.pathCells, Routes.preparePointsArray());
          const px = T.pure.polylineAt(
            drawn.map(p => [p[0], p[1]]),
            1
          )?.length;
          if (px) row.length = distanceInfo(px);
        } catch {}
        return row;
      }
      const px = T.pure.polylineAt(
        q.pts.map(p => [p[0], p[1]]),
        1
      )?.length;
      Object.assign(row, {
        group: q.group,
        freehand: true,
        points: q.pts.length,
        links: q.links,
        length: distanceInfo(px ?? 0)
      });
      if (q.name) row.name = q.name;
      if (q.notes.length) row.notes = q.notes;
      return row;
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
        points: q.input.map((v, k) => literalPoint(v, q.places[k])),
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

  // ---------------------------------------------------------------- find, inspect, summary, regenerate

  // find route where:{group}: ids or display names of route groups (an unknown group is NOT_FOUND, not 0 rows)
  const coreFind = T.fns.find;
  T.fns.find = a => {
    if (a?.type === "route" && _isObj(a.where) && a.where.group !== undefined) {
      const vals = Array.isArray(a.where.group) ? a.where.group : [a.where.group];
      a = { ...a, where: { ...a.where, group: vals.map(v => checkRouteGroup(v)) } };
    }
    return coreFind(a);
  };

  // inspect route: the length with its unit, whether it is locked, and its note
  const coreInspect = T.fns.inspect;
  T.fns.inspect = a => {
    const out = coreInspect(a);
    if (out?.kind === "entity" && out.type === "route" && out.relations) {
      const r = (pack.routes || []).find(x => x && x.i === out.i);
      if (r) {
        if (typeof out.relations.length === "number") out.relations.length = distanceInfo(out.relations.length);
        out.relations.lock = !!r.lock;
        const n = typeof notes !== "undefined" && Array.isArray(notes) ? notes.find(x => x.id === `route${r.i}`) : null;
        if (n) out.relations.note = { id: n.id, name: n.name, legend: n.legend };
      }
    }
    return out;
  };

  // Regenerating routes keeps the locked routes but renumbers them 0..k-1 (the app's regenerateRoutes),
  // and a route's note is keyed by its id ('route<i>'). Move the notes of kept routes to their new ids
  // and drop the notes of routes that were replaced, so no note ends up on a different route.
  const lockedRoutes = () =>
    (pack.routes || [])
      .filter(r => r?.lock)
      .map(r => ({ i: r.i, key: T.pure.hashStr(JSON.stringify([r.group, r.name ?? null, r.points])) }));
  const coreRegenerate = T.fns.regenerate;
  if (coreRegenerate)
    T.fns.regenerate = async a => {
      const listBefore = pack.routes;
      const before = lockedRoutes();
      const out = await coreRegenerate(a);
      if (pack.routes === listBefore) return out; // the routes were not regenerated
      const after = lockedRoutes();
      const notesOut = Array.isArray(out?.notes) ? out.notes : [];
      if (before.length !== after.length || before.some((b, k) => b.key !== after[k].key)) {
        notesOut.push("routes were regenerated; route notes ('route<id>') may now sit on different routes");
        if (out && typeof out === "object") out.notes = notesOut;
        return out;
      }
      const map = new Map(before.map((b, k) => [b.i, after[k].i]));
      const renumbered = [...map].filter(([from, to]) => from !== to);
      let moved = 0;
      let dropped = 0;
      if (typeof notes !== "undefined" && Array.isArray(notes)) {
        const next = [];
        for (const n of notes) {
          const m = /^route(\d+)$/.exec(n.id);
          if (!m) {
            next.push(n);
            continue;
          }
          const to = map.get(Number(m[1]));
          if (to === undefined) {
            dropped++;
            continue;
          }
          if (to !== Number(m[1])) {
            n.id = `route${to}`;
            moved++;
          }
          next.push(n);
        }
        if (moved || dropped) {
          notes.length = 0;
          notes.push(...next);
        }
      }
      if (renumbered.length || dropped) {
        const parts = [];
        if (renumbered.length)
          parts.push(
            `${renumbered.length} locked route(s) were renumbered (${renumbered
              .slice(0, 4)
              .map(([from, to]) => `${from}->${to}`)
              .join(", ")}${renumbered.length > 4 ? ", ..." : ""}), so the change report shows them as modified`
          );
        if (moved || dropped)
          parts.push(
            `${moved} route note(s) moved to the new ids${dropped ? `, ${dropped} note(s) of replaced routes removed` : ""}`
          );
        notesOut.push(`${parts.join("; ")}`);
      }
      if (renumbered.length && renumbered.length <= 100 && out && typeof out === "object")
        out.routeIds = Object.fromEntries(renumbered);
      if (out && typeof out === "object") out.notes = notesOut;
      return out;
    };
})(globalThis);
