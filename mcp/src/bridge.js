// Tupaia MCP bridge. Injected with context.addInitScript before any app script runs, as a
// classic script with no imports. It defines globalThis.__tupaia; Node calls everything
// through ONE entry point: page.evaluate(([n, a, m]) => __tupaia.call(n, a, m), [...]).
//
// Rules for this file:
// - App globals (pack, grid, notes, svg, zoom, scale, viewX, ...) are read by bare name at
//   call time; never cache DOM selections (load replaces the SVG).
// - Never declare locals that shadow app globals (pack, grid, notes, svg, zoom, scale, viewX,
//   viewY, labels, rivers, markers, zones, routes, burgLabels, ...).
// - Pure helpers take their inputs as arguments so test/bridge.test.ts can run this file in
//   node:vm with a fake `pack`.
// - Every function registered in FNS takes one args object and returns JSON-safe data
//   (the envelope runs safeJson over it anyway).
(root => {
  const T = {};
  const FNS = {};

  // ---------------------------------------------------------------- errors

  function fail(code, message, extra) {
    const e = new Error(message);
    e.code = code;
    if (extra) Object.assign(e, extra);
    throw e;
  }

  function errorOf(e) {
    if (!e || typeof e !== "object") return { code: "PAGE_ERROR", message: String(e) };
    const out = { code: e.code || "PAGE_ERROR", message: String(e.message || e) };
    if (e.candidates) out.candidates = e.candidates;
    if (e.details) out.details = e.details;
    if (e.stackHead) out.stack = e.stackHead;
    return out;
  }

  // ---------------------------------------------------------------- pure helpers

  const rn = (v, d = 2) => {
    const m = 10 ** d;
    return Math.round(v * m) / m;
  };

  /** Case- and diacritic-insensitive key. */
  function fold(s) {
    return String(s ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function levenshtein(a, b, cap = 99) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > cap) return cap + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let best = i;
      for (let j = 1; j <= b.length; j++) {
        const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        cur.push(v);
        if (v < best) best = v;
      }
      if (best > cap) return cap + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  /**
   * Rank rows {name, alt?} against a query: prefix, then substring, then Levenshtein <= 2.
   * Returns at most `limit` rows (the original row objects), best first.
   */
  function rankCandidates(query, rows, limit = 8) {
    const q = fold(query);
    if (!q) return [];
    const scored = [];
    for (const r of rows) {
      const keys = [r.name, ...(r.alt || [])].filter(Boolean).map(fold);
      let score = Infinity;
      for (const k of keys) {
        if (k.startsWith(q)) score = Math.min(score, 0 + k.length / 1000);
        else if (k.includes(q)) score = Math.min(score, 1 + k.length / 1000);
        else {
          const d = levenshtein(q, k, 2);
          if (d <= 2) score = Math.min(score, 2 + d);
          // also compare against the same-length prefix (typo in a long name)
          else if (k.length > q.length) {
            const dp = levenshtein(q, k.slice(0, q.length), 2);
            if (dp <= 1 && q.length >= 4) score = Math.min(score, 5 + dp);
          }
        }
      }
      if (score < Infinity) scored.push([score, r]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    return scored.slice(0, limit).map(s => s[1]);
  }

  /**
   * Name matching over rows {i, name, alt?}: exact, then folded exact.
   * Returns {matches, how} where how is 'exact' | 'folded' | 'none'.
   */
  function matchName(query, rows) {
    const q = String(query);
    const exact = rows.filter(r => r.name === q || (r.alt || []).includes(q));
    if (exact.length) return { matches: exact, how: "exact" };
    const f = fold(q);
    const folded = rows.filter(r => fold(r.name) === f || (r.alt || []).some(a => fold(a) === f));
    if (folded.length) return { matches: folded, how: "folded" };
    return { matches: [], how: "none" };
  }

  function xyToLatLon(x, y, mc, gw, gh, decimals = 4) {
    const lon = mc.lonW + (x / gw) * mc.lonT;
    const lat = mc.latN - (y / gh) * mc.latT;
    return { lat: rn(lat, decimals), lon: rn(lon, decimals) };
  }

  /** Inverse of getCoordinates (src/utils/commonUtils.ts:218-253). */
  function latLonToXY(lat, lon, mc, gw, gh) {
    return { x: ((lon - mc.lonW) / mc.lonT) * gw, y: ((mc.latN - lat) / mc.latT) * gh };
  }

  /**
   * Map a pixel of a returned screenshot to map coordinates.
   * view: {full, imgW, imgH, cssW, cssH, x, y, scale, graphWidth, graphHeight}
   */
  function screenToMap(px, py, v) {
    if (!v?.imgW || !v.imgH) fail("BAD_VIEW", "screen place needs a stored shot view");
    if (v.full) return { x: (px * v.graphWidth) / v.imgW, y: (py * v.graphHeight) / v.imgH };
    const cx = (px * v.cssW) / v.imgW;
    const cy = (py * v.cssH) / v.imgH;
    return { x: (cx - v.x) / v.scale, y: (cy - v.y) / v.scale };
  }

  /** Point at fraction f (0..1) along a polyline [[x,y],...]. */
  function polylineAt(points, f) {
    const pts = points.filter(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (!pts.length) return null;
    if (pts.length === 1) return { x: pts[0][0], y: pts[0][1], index: 0, length: 0 };
    const segs = [];
    let total = 0;
    for (let k = 1; k < pts.length; k++) {
      const d = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      segs.push(d);
      total += d;
    }
    const target = Math.max(0, Math.min(1, f)) * total;
    let acc = 0;
    for (let k = 0; k < segs.length; k++) {
      if (acc + segs[k] >= target || k === segs.length - 1) {
        const t = segs[k] ? (target - acc) / segs[k] : 0;
        const a = pts[k];
        const b = pts[k + 1];
        return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, index: k, length: total };
      }
      acc += segs[k];
    }
    return null;
  }

  function hashStr(s) {
    let h = 0x811c9dc5;
    for (let k = 0; k < s.length; k++) {
      h ^= s.charCodeAt(k);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  function hashArray(a) {
    let h = 0x811c9dc5;
    for (let k = 0; k < a.length; k++) {
      const v = a[k];
      const s = typeof v === "number" ? v : JSON.stringify(v) || "";
      if (typeof s === "number") {
        h ^= s | 0;
        h = Math.imul(h, 0x01000193);
        h ^= Math.round((s % 1) * 1e6);
        h = Math.imul(h, 0x01000193);
      } else {
        for (let c = 0; c < s.length; c++) {
          h ^= s.charCodeAt(c);
          h = Math.imul(h, 0x01000193);
        }
      }
    }
    return (h >>> 0).toString(36);
  }

  /** Compact projection of an entity: primitives as-is, arrays/objects as length+hash tags. */
  function projection(x) {
    const o = {};
    for (const k of Object.keys(x)) {
      const v = x[k];
      if (typeof v === "function" || v === undefined) continue;
      if (v === null || typeof v !== "object") o[k] = v;
      else if (Array.isArray(v) || ArrayBuffer.isView(v)) o[k] = `#arr${v.length}:${hashArray(v)}`;
      else {
        let s = "";
        try {
          s = JSON.stringify(v) || "";
        } catch {
          s = "[unserialisable]";
        }
        o[k] = `#obj:${hashStr(s)}`;
      }
    }
    return o;
  }

  /**
   * Fractions equal to float noise (a sum recomputed in another order): not a change worth
   * reporting. Integers are compared exactly.
   */
  const sameNum = (p, q) =>
    typeof p === "number" &&
    typeof q === "number" &&
    !(Number.isInteger(p) && Number.isInteger(q)) &&
    Math.abs(p - q) <= 1e-7 * Math.max(1, Math.abs(p), Math.abs(q));

  /**
   * Diff two projection maps {id: projectionObject} (plain objects).
   * Returns {added:[id], removed:[id], modified:[{i, fields:{k:[old,new]|'changed'}}]}.
   */
  function diffProjections(base, cur, limit = 50) {
    const added = [];
    const removed = [];
    const modified = [];
    let truncated = false;
    for (const id of Object.keys(cur)) if (!(id in base)) added.push(id);
    for (const id of Object.keys(base)) if (!(id in cur)) removed.push(id);
    for (const id of Object.keys(cur)) {
      if (!(id in base)) continue;
      const a = base[id];
      const b = cur[id];
      const fields = {};
      let n = 0;
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (a[k] === b[k] || sameNum(a[k], b[k])) continue;
        const tagged = String(a[k]).startsWith("#") || String(b[k]).startsWith("#");
        fields[k] = tagged ? "changed" : [a[k] ?? null, b[k] ?? null];
        n++;
      }
      if (n) modified.push({ i: id, fields });
    }
    const cap = arr => {
      if (arr.length > limit) {
        truncated = true;
        return arr.slice(0, limit);
      }
      return arr;
    };
    const num = id => (/^-?\d+$/.test(id) ? Number(id) : id);
    return {
      added: cap(added).map(num),
      removed: cap(removed).map(num),
      modified: cap(modified).map(m => ({ i: num(m.i), fields: m.fields })),
      counts: { added: added.length, removed: removed.length, modified: modified.length },
      truncated
    };
  }

  /** Number of differing elements of two array-likes (or {resized}). */
  function diffArray(a, b) {
    if (!a || !b) return null;
    if (a.length !== b.length) return { resized: [a.length, b.length] };
    let n = 0;
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) n++;
    return n;
  }

  // Canonical redraw order; 'labels' covers stateLabels+burgLabels, 'all' covers everything.
  const REDRAW_ORDER = [
    "all",
    "features",
    "heightmap",
    "biomes",
    "cultures",
    "religions",
    "states",
    "provinces",
    "borders",
    "rivers",
    "routes",
    "zones",
    "markers",
    "burgIcons",
    "labels",
    "stateLabels",
    "burgLabels",
    "emblems"
  ];

  /**
   * Coalesce redraw requests (names or {layer, ids}) into one step per layer, in canonical
   * order. stateLabels ids are unioned; a request without ids means "all states".
   */
  function coalesceRedraws(requests) {
    const want = new Map();
    for (const r of requests || []) {
      const layer = typeof r === "string" ? r : r?.layer;
      if (!layer) continue;
      if (!REDRAW_ORDER.includes(layer))
        fail("BAD_LAYER", `unknown redraw layer '${layer}'`, { details: REDRAW_ORDER });
      const ids = typeof r === "object" && Array.isArray(r.ids) ? r.ids : null;
      if (!want.has(layer)) want.set(layer, ids ? new Set(ids) : null);
      else if (want.get(layer) && ids) for (const id of ids) want.get(layer).add(id);
      else want.set(layer, null);
    }
    if (want.has("all")) return [{ layer: "all" }];
    if (want.has("labels")) {
      want.delete("stateLabels");
      want.delete("burgLabels");
    }
    return REDRAW_ORDER.filter(l => want.has(l)).map(l => {
      const ids = want.get(l);
      return ids ? { layer: l, ids: [...ids].sort((a, b) => a - b) } : { layer: l };
    });
  }

  /** JSON-safe copy: typed arrays -> arrays, DOM nodes -> tags, caps depth/items/strings. */
  function safeJson(value, opts) {
    const o = opts || {};
    const maxDepth = o.maxDepth ?? 10;
    const maxItems = o.maxItems ?? 50000;
    const maxString = o.maxString ?? 500000;
    const ancestors = new Set();
    const walk = (x, d) => {
      if (x === undefined || x === null) return null;
      const t = typeof x;
      if (t === "number") return Number.isFinite(x) ? x : String(x);
      if (t === "string") return x.length > maxString ? `${x.slice(0, maxString)}…[+${x.length - maxString} chars]` : x;
      if (t === "boolean") return x;
      if (t === "bigint" || t === "symbol") return String(x);
      if (t === "function") return `[function ${x.name || "anonymous"}]`;
      if (ArrayBuffer.isView(x) && !(x instanceof DataView)) x = Array.from(x);
      if (typeof Node !== "undefined" && x instanceof Node) {
        const el = x;
        return `<${(el.nodeName || "node").toLowerCase()}${el.id ? `#${el.id}` : ""}>`;
      }
      if (x?._groups && typeof x.node === "function") return "[d3 selection]";
      if (typeof Window !== "undefined" && x instanceof Window) return "[window]";
      if (d >= maxDepth) return Array.isArray(x) ? `[array(${x.length})]` : "[object]";
      if (ancestors.has(x)) return "[circular]";
      ancestors.add(x);
      let out;
      try {
        if (x instanceof Date) out = x.toISOString();
        else if (x instanceof Error) out = { name: x.name, message: x.message };
        else if (x instanceof Map) out = walk([...x.entries()], d);
        else if (x instanceof Set) out = walk([...x], d);
        else if (Array.isArray(x)) {
          const n = Math.min(x.length, maxItems);
          out = [];
          for (let k = 0; k < n; k++) out.push(walk(x[k], d + 1));
          if (x.length > n) out.push(`…[+${x.length - n} items]`);
        } else {
          out = {};
          for (const k of Object.keys(x)) {
            const v = x[k];
            if (v === undefined) continue;
            out[k] = walk(v, d + 1);
          }
        }
      } finally {
        ancestors.delete(x);
      }
      return out;
    };
    return walk(value, 0);
  }

  // ---------------------------------------------------------------- app accessors

  const TYPES = [
    "burg",
    "state",
    "province",
    "culture",
    "religion",
    "river",
    "route",
    "marker",
    "zone",
    "feature",
    "note",
    "label",
    "namesbase"
  ];
  // Arrays whose index equals the id and whose slot 0 is a placeholder.
  const INDEXED = { burg: 1, state: 1, province: 1, culture: 1, religion: 1, feature: 1 };
  // Index 0 means something for these.
  const ZERO_OK = { state: "Neutrals", culture: "Wildlands", religion: "No religion" };
  // Fields that hold ids of other entities, per type.
  const REF_FIELDS = {
    burg: { state: "state", culture: "culture", feature: "feature", port: "feature" },
    state: { capital: "burg", culture: "culture" },
    province: { state: "state", burg: "burg" },
    culture: { base: "namesbase" },
    religion: { culture: "culture" },
    river: { parent: "river" },
    marker: {},
    zone: {},
    route: { feature: "feature" },
    feature: {},
    note: {},
    label: {},
    namesbase: {}
  };
  // pack.cells field holding membership for cell-based entities.
  const CELL_FIELD = {
    state: "state",
    province: "province",
    culture: "culture",
    religion: "religion",
    feature: "f",
    river: "r"
  };

  let memo = null; // per-call cache, reset by T.call
  const cached = (key, fn) => {
    if (!memo) memo = {};
    if (!(key in memo)) memo[key] = fn();
    return memo[key];
  };

  function checkType(type) {
    if (!TYPES.includes(type)) fail("BAD_TYPE", `unknown entity type '${type}'`, { details: TYPES });
  }

  function labelList() {
    if (typeof document === "undefined") return [];
    return cached("labels", () => {
      const out = [];
      for (const t of document.querySelectorAll('#labels text[id^="label"]')) {
        const g = t.parentNode;
        out.push({ id: t.id, i: t.id, name: (t.textContent || "").trim(), group: g?.id ? g.id : null, el: t });
      }
      return out;
    });
  }

  function rawList(type) {
    switch (type) {
      case "burg":
        return pack.burgs;
      case "state":
        return pack.states;
      case "province":
        return pack.provinces;
      case "culture":
        return pack.cultures;
      case "religion":
        return pack.religions;
      case "river":
        return pack.rivers || [];
      case "route":
        return pack.routes || [];
      case "marker":
        return pack.markers || [];
      case "zone":
        return pack.zones || [];
      case "feature":
        return pack.features;
      case "note":
        return typeof notes !== "undefined" ? notes : [];
      case "label":
        return labelList();
      case "namesbase":
        return cached("namesbases", () =>
          (typeof nameBases !== "undefined" ? nameBases : []).map((b, i) => (b ? Object.assign({}, b, { i }) : b))
        );
      default:
        return checkType(type);
    }
  }

  function idOf(type, x) {
    return type === "note" ? x.id : x.i;
  }

  function isLive(type, x, withZero) {
    if (!x || typeof x !== "object" || x.removed) return false;
    if (INDEXED[type]) return x.i > 0 || (withZero && x.i === 0 && type in ZERO_OK);
    return true;
  }

  function liveList(type, withZero) {
    return rawList(type).filter(x => isLive(type, x, withZero));
  }

  function noteMap() {
    return cached("noteMap", () => {
      const m = new Map();
      if (typeof notes !== "undefined" && Array.isArray(notes)) for (const n of notes) if (n?.id) m.set(n.id, n);
      return m;
    });
  }

  function nameOf(type, x) {
    if (!x || typeof x !== "object") return null;
    switch (type) {
      case "marker": {
        const n = noteMap().get(`marker${x.i}`);
        return n ? n.name : x.type || `marker ${x.i}`;
      }
      case "route":
        return x.name || `${x.group || "route"} ${x.i}`;
      case "feature":
        return x.name || x.group || x.type || `feature ${x.i}`;
      case "label":
        return x.name;
      default:
        return x.name ?? null;
    }
  }

  function altNames(type, x) {
    if (type === "state" || type === "province") return x.fullName ? [x.fullName] : [];
    if (type === "marker") return x.type ? [x.type] : [];
    return [];
  }

  function byId(type, id) {
    const list = rawList(type);
    if (type === "note" || type === "label") return list.find(x => x && x.id === id) || null;
    if (INDEXED[type] || type === "namesbase") return list[id] ?? null;
    return list.find(x => x && x.i === id) || null;
  }

  function cellP(c) {
    const p = pack.cells.p[c];
    return p ? { x: p[0], y: p[1] } : null;
  }

  function featureStats() {
    return cached("featureStats", () => {
      const f = pack.cells.f;
      const P = pack.cells.p;
      const s = new Map();
      for (let c = 0; c < f.length; c++) {
        const id = f[c];
        const p = P[c];
        let e = s.get(id);
        if (!e) {
          e = { n: 0, sx: 0, sy: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
          s.set(id, e);
        }
        e.n++;
        e.sx += p[0];
        e.sy += p[1];
        if (p[0] < e.x0) e.x0 = p[0];
        if (p[1] < e.y0) e.y0 = p[1];
        if (p[0] > e.x1) e.x1 = p[0];
        if (p[1] > e.y1) e.y1 = p[1];
      }
      return s;
    });
  }

  function cellsBox(cellIds) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const c of cellIds) {
      const p = pack.cells.p[c];
      if (!p) continue;
      n++;
      sx += p[0];
      sy += p[1];
      if (p[0] < x0) x0 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[0] > x1) x1 = p[0];
      if (p[1] > y1) y1 = p[1];
    }
    if (!n) return null;
    return { x0, y0, x1, y1, cx: sx / n, cy: sy / n, cells: n };
  }

  function cellsWhere(field, id) {
    const arr = pack.cells[field];
    const out = [];
    if (!arr) return out;
    for (let c = 0; c < arr.length; c++) if (arr[c] === id) out.push(c);
    return out;
  }

  function svgBox(el) {
    try {
      const b = el.getBBox();
      if (b && (b.width || b.height)) return { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height };
    } catch {}
    return null;
  }

  function labelPoint(lbl) {
    const b = svgBox(lbl.el);
    if (b) return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, box: b };
    const path = typeof document !== "undefined" ? document.getElementById(`textPath_${lbl.id}`) : null;
    const m = path && /M\s*(-?[\d.]+)[ ,](-?[\d.]+)/.exec(path.getAttribute("d") || "");
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  }

  function routePoints(r) {
    return (r.points || []).map(p => [p[0], p[1]]);
  }

  function riverPoints(r) {
    if (Array.isArray(r.points) && r.points.length) return r.points.map(p => [p[0], p[1]]);
    return (r.cells || []).filter(c => c >= 0 && pack.cells.p[c]).map(c => pack.cells.p[c]);
  }

  /** Representative point of an entity, or null. */
  function anchor(type, x) {
    switch (type) {
      case "burg":
      case "marker":
        return Number.isFinite(x.x) ? { x: x.x, y: x.y } : cellP(x.cell);
      case "state":
      case "province":
        if (Array.isArray(x.pole)) return { x: x.pole[0], y: x.pole[1] };
        return x.center != null ? cellP(x.center) : null;
      case "culture":
      case "religion":
        return x.center != null ? cellP(x.center) : null;
      case "zone": {
        const b = cellsBox(x.cells || []);
        return b ? { x: b.cx, y: b.cy } : null;
      }
      case "feature": {
        const s = featureStats().get(x.i);
        return s ? { x: s.sx / s.n, y: s.sy / s.n } : null;
      }
      case "route": {
        const p = polylineAt(routePoints(x), 0.5);
        return p ? { x: p.x, y: p.y } : null;
      }
      case "river": {
        const p = polylineAt(riverPoints(x), 0.5);
        return p ? { x: p.x, y: p.y } : null;
      }
      case "label":
        return labelPoint(x);
      case "note": {
        const m = /^(burg|marker|stateLabel|province|regiment)(\d+)/.exec(x.id || "");
        if (m && m[1] === "burg") {
          const b = byId("burg", Number(m[2]));
          return b ? anchor("burg", b) : null;
        }
        if (m && m[1] === "marker") {
          const mk = byId("marker", Number(m[2]));
          return mk ? anchor("marker", mk) : null;
        }
        if (m && m[1] === "stateLabel") {
          const s = byId("state", Number(m[2]));
          return s ? anchor("state", s) : null;
        }
        const el = typeof document !== "undefined" ? document.getElementById(x.id) : null;
        const b = el ? svgBox(el) : null;
        return b ? { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 } : null;
      }
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------- addressing

  function candidateRow(type, x) {
    const row = { i: idOf(type, x), name: nameOf(type, x) };
    if (type === "burg" && pack.states && pack.states[x.state]) row.state = pack.states[x.state].name;
    if (type === "province" && pack.states && pack.states[x.state]) row.state = pack.states[x.state].name;
    try {
      const a = anchor(type, x);
      if (a) {
        row.x = rn(a.x, 1);
        row.y = rn(a.y, 1);
      }
    } catch {}
    return row;
  }

  function parseRef(ref) {
    if (ref === null || ref === undefined) fail("BAD_REF", "missing entity ref");
    if (typeof ref === "number") return { id: ref };
    if (typeof ref === "string") {
      const s = ref.trim();
      if (/^-?\d+$/.test(s)) return { id: Number(s) };
      return { name: ref };
    }
    if (typeof ref === "object") {
      if ("id" in ref) return parseRef(ref.id).name !== undefined ? { id: ref.id } : parseRef(ref.id);
      if ("i" in ref) return parseRef(ref.i);
      if ("name" in ref) return { name: String(ref.name) };
    }
    return fail("BAD_REF", `cannot read entity ref ${JSON.stringify(ref)}`);
  }

  /**
   * Resolve an entity ref of `type`. Returns {type, i, name, entity}.
   * Errors: NOT_FOUND (with candidates), AMBIGUOUS (with candidates), REMOVED, BAD_REF.
   */
  function resolve(type, ref) {
    checkType(type);
    const r = parseRef(ref);
    if (r.id !== undefined) {
      const id = r.id;
      if (type === "note" || type === "label") {
        // string ids such as burg12 / label3; a bare number is never valid here
        const x = byId(type, String(id));
        if (!x) fail("NOT_FOUND", `no ${type} with id '${id}'`);
        return { type, i: x.id, name: nameOf(type, x), entity: x };
      }
      if (!Number.isInteger(id) || id < 0) fail("NOT_FOUND", `${type} id must be a non-negative integer, got ${id}`);
      if (id === 0 && INDEXED[type] && !(type in ZERO_OK)) {
        fail("NOT_FOUND", `${type} 0 is a placeholder, not an entity (ids start at 1)`);
      }
      const x = byId(type, id);
      if (!x || typeof x !== "object") fail("NOT_FOUND", `no ${type} with id ${id}`);
      if (x.removed) fail("REMOVED", `${type} ${id}${x.name ? ` (${x.name})` : ""} was removed`);
      return { type, i: idOf(type, x), name: nameOf(type, x), entity: x };
    }
    // by name: notes/labels also match their id string
    const live = liveList(type, true);
    if (type === "note" || type === "label") {
      const byStr = live.find(x => x.id === r.name);
      if (byStr) return { type, i: byStr.id, name: nameOf(type, byStr), entity: byStr };
    }
    const rows = live.map(x => ({ i: idOf(type, x), name: nameOf(type, x), alt: altNames(type, x), x }));
    const { matches } = matchName(r.name, rows);
    if (matches.length === 1) {
      const x = matches[0].x;
      return { type, i: idOf(type, x), name: nameOf(type, x), entity: x };
    }
    if (matches.length > 1) {
      fail("AMBIGUOUS", `${matches.length} ${type}s are named '${r.name}'; pass an id`, {
        candidates: matches.slice(0, 8).map(m => candidateRow(type, m.x))
      });
    }
    const removedHit = rawList(type).find(
      x => x && typeof x === "object" && x.removed && (x.name === r.name || fold(x.name) === fold(r.name))
    );
    if (removedHit) fail("REMOVED", `${type} '${r.name}' (${idOf(type, removedHit)}) was removed`);
    const cands = rankCandidates(r.name, rows, 8).map(m => candidateRow(type, m.x));
    return fail("NOT_FOUND", `no ${type} named '${r.name}'${cands.length ? "; see candidates" : ""}`, {
      candidates: cands
    });
  }

  function nearestCell(x, y) {
    if (typeof findCell === "function") return findCell(x, y);
    let best = -1;
    let bd = Infinity;
    const P = pack.cells.p;
    for (let c = 0; c < P.length; c++) {
      const d = (P[c][0] - x) ** 2 + (P[c][1] - y) ** 2;
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  /**
   * Resolve a Place to {x, y, cell, lat, lon}. Forms:
   * {x,y} | {lat,lon} | {cell} | {entity:{type,ref}, at?:0..1} | {screen:[px,py], view}
   */
  function place(p) {
    if (!p || typeof p !== "object") fail("BAD_PLACE", "a place is {x,y}, {lat,lon}, {cell} or {entity:{type,ref}}");
    let x;
    let y;
    let cell;
    let via;
    if (Array.isArray(p.screen)) {
      ({ x, y } = screenToMap(Number(p.screen[0]), Number(p.screen[1]), p.view));
      via = "screen";
    } else if (p.cell !== undefined) {
      cell = Number(p.cell);
      if (!Number.isInteger(cell) || cell < 0 || cell >= pack.cells.p.length) {
        fail("OUT_OF_BOUNDS", `cell ${p.cell} is outside 0..${pack.cells.p.length - 1}`);
      }
      [x, y] = pack.cells.p[cell];
      via = "cell";
    } else if (p.lat !== undefined && p.lon !== undefined) {
      ({ x, y } = latLonToXY(Number(p.lat), Number(p.lon), mapCoordinates, graphWidth, graphHeight));
      via = "latlon";
    } else if (p.x !== undefined && p.y !== undefined) {
      x = Number(p.x);
      y = Number(p.y);
      via = "xy";
    } else if (p.entity) {
      const r = resolve(p.entity.type, p.entity.ref);
      let pt;
      if (p.at !== undefined && p.at !== null) {
        const f = Number(p.at);
        if (!(f >= 0 && f <= 1)) fail("BAD_PLACE", "at must be a fraction 0..1");
        if (r.type === "route") pt = polylineAt(routePoints(r.entity), f);
        else if (r.type === "river") pt = polylineAt(riverPoints(r.entity), f);
        else fail("BAD_PLACE", "at (fraction along) works only for routes and rivers");
      } else {
        pt = anchor(r.type, r.entity);
        // A burg or marker belongs to its recorded cell; its x,y can sit nearer a neighbour's
        // centre (39 of 753 burgs in demo.map), so the nearest cell would be the wrong one.
        const ec = r.entity.cell;
        if ((r.type === "burg" || r.type === "marker") && Number.isInteger(ec) && ec >= 0 && ec < pack.cells.p.length)
          cell = ec;
      }
      if (!pt) fail("NO_POSITION", `${r.type} ${r.i} has no position`);
      x = pt.x;
      y = pt.y;
      via = `${r.type}:${r.i}`;
    } else {
      fail("BAD_PLACE", "a place is {x,y}, {lat,lon}, {cell}, {entity:{type,ref},at?} or {screen,shot}");
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) fail("BAD_PLACE", "place coordinates are not numbers");
    if (x < 0 || y < 0 || x > graphWidth || y > graphHeight) {
      const ll = xyToLatLon(x, y, mapCoordinates, graphWidth, graphHeight);
      fail(
        "OUT_OF_BOUNDS",
        `(${rn(x, 1)}, ${rn(y, 1)}) [lat ${ll.lat}, lon ${ll.lon}] is outside the map 0..${graphWidth} x 0..${graphHeight}`,
        { details: { bounds: [0, 0, graphWidth, graphHeight], mapCoordinates } }
      );
    }
    if (cell === undefined) cell = nearestCell(x, y);
    const ll = xyToLatLon(x, y, mapCoordinates, graphWidth, graphHeight);
    return { x: rn(x, 2), y: rn(y, 2), cell, lat: ll.lat, lon: ll.lon, via };
  }

  /** Bounding box {x0,y0,x1,y1,cx,cy} of an entity in map px. */
  function entityBox(type, ref) {
    const r = resolve(type, ref);
    const x = r.entity;
    let b = null;
    if (type === "burg" || type === "marker") {
      const a = anchor(type, x);
      if (a) b = { x0: a.x, y0: a.y, x1: a.x, y1: a.y, cx: a.x, cy: a.y };
    } else if (type === "feature") {
      const s = featureStats().get(x.i);
      if (s) b = { x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, cx: s.sx / s.n, cy: s.sy / s.n, cells: s.n };
    } else if (CELL_FIELD[type]) {
      b = cellsBox(cellsWhere(CELL_FIELD[type], x.i));
      if (b && (type === "state" || type === "province") && Array.isArray(x.pole)) {
        b.cx = x.pole[0];
        b.cy = x.pole[1];
      }
    } else if (type === "zone") {
      b = cellsBox(x.cells || []);
    } else if (type === "route") {
      const pts = routePoints(x);
      if (pts.length) {
        const xs = pts.map(p => p[0]);
        const ys = pts.map(p => p[1]);
        const mid = polylineAt(pts, 0.5);
        b = {
          x0: Math.min(...xs),
          y0: Math.min(...ys),
          x1: Math.max(...xs),
          y1: Math.max(...ys),
          cx: mid.x,
          cy: mid.y
        };
      }
    } else if (type === "label") {
      const lp = labelPoint(x);
      if (lp)
        b = lp.box ? { ...lp.box, cx: lp.x, cy: lp.y } : { x0: lp.x, y0: lp.y, x1: lp.x, y1: lp.y, cx: lp.x, cy: lp.y };
    } else if (type === "note") {
      const a = anchor(type, x);
      if (a) b = { x0: a.x, y0: a.y, x1: a.x, y1: a.y, cx: a.x, cy: a.y };
    }
    if (!b) fail("NO_POSITION", `${type} ${r.i} has no position on the map`);
    for (const k of ["x0", "y0", "x1", "y1", "cx", "cy"]) b[k] = rn(b[k], 2);
    return { type, i: r.i, name: r.name, ...b };
  }

  // ---------------------------------------------------------------- field access (find/where)

  function people(b) {
    const rate = typeof populationRate !== "undefined" ? populationRate : 1000;
    const urb = typeof urbanization !== "undefined" ? urbanization : 1;
    return Math.round((b.population || 0) * rate * urb);
  }

  function fieldValue(type, x, field) {
    if (type === "burg" && field === "population") return people(x);
    if (type === "burg" && field === "capital") return !!x.capital;
    if (type === "burg" && field === "port") return x.port || 0;
    if (type === "marker" && field === "note") {
      const n = noteMap().get(`marker${x.i}`);
      return n ? n.name : null;
    }
    if (type === "route" && field === "length") {
      const p = polylineAt(routePoints(x), 1);
      return p ? rn(p.length, 1) : 0;
    }
    if (type === "zone" && field === "cells") return (x.cells || []).length;
    if (type === "label" && field === "text") return x.name;
    if (type === "note" && field === "legend") {
      const s = String(x.legend || "").replace(/<[^>]+>/g, " ");
      return s.length > 160 ? `${s.slice(0, 160)}…` : s;
    }
    if (
      (type === "state" || type === "province" || type === "culture" || type === "religion") &&
      field === "population"
    ) {
      // not stored: the app shows rural + urban people (states editor)
      return fieldValue(type, x, "rural") + fieldValue(type, x, "urban");
    }
    if (
      (type === "state" || type === "province" || type === "culture" || type === "religion") &&
      (field === "rural" || field === "urban")
    ) {
      const rate = typeof populationRate !== "undefined" ? populationRate : 1000;
      const urb = typeof urbanization !== "undefined" ? urbanization : 1;
      return Math.round((x[field] || 0) * rate * (field === "urban" ? urb : 1));
    }
    const v = x[field];
    if (v && typeof v === "object") return ArrayBuffer.isView(v) ? Array.from(v) : v;
    return v;
  }

  function refName(refType, id) {
    if (id === null || id === undefined || id === "") return null;
    try {
      const x = byId(refType, id);
      return x && typeof x === "object" ? nameOf(refType, x) : null;
    } catch {
      return null;
    }
  }

  function matchWhere(type, x, where, resolvedRefs) {
    for (const key of Object.keys(where)) {
      const want = where[key];
      const mm = /^(.*)(Min|Max)$/.exec(key);
      if (mm && typeof want === "number") {
        const v = Number(fieldValue(type, x, mm[1]));
        if (!Number.isFinite(v)) return false;
        if (mm[2] === "Min" ? v < want : v > want) return false;
        continue;
      }
      const v = fieldValue(type, x, key);
      if (key in resolvedRefs) {
        const ids = resolvedRefs[key];
        if (!ids.includes(v)) return false;
        continue;
      }
      if (typeof want === "boolean") {
        if (!!v !== want) return false;
      } else if (Array.isArray(want)) {
        if (!want.some(w => w === v || (typeof w === "string" && fold(w) === fold(v)))) return false;
      } else if (typeof want === "string" && typeof v === "string") {
        if (fold(want) !== fold(v)) return false;
      } else if (want === null) {
        if (v !== null && v !== undefined && v !== 0 && v !== "") return false;
      } else if (v !== want) return false;
    }
    return true;
  }

  const DEFAULT_FIELDS = {
    burg: ["state", "population", "capital", "port", "group"],
    state: ["fullName", "form", "capital", "culture", "cells", "burgs", "area", "color"],
    province: ["fullName", "state", "burg", "color"],
    culture: ["type", "base", "color", "cells"],
    religion: ["type", "form", "culture", "color"],
    river: ["type", "length", "discharge", "parent"],
    route: ["group", "length"],
    marker: ["type", "icon", "note"],
    zone: ["type", "color", "cells"],
    feature: ["type", "group", "cells", "area"],
    note: ["legend"],
    label: ["group"],
    namesbase: ["min", "max"]
  };

  function rowOf(type, x, fields, withPos) {
    const row = { i: idOf(type, x), name: nameOf(type, x) };
    for (const f of fields) {
      const v = fieldValue(type, x, f);
      row[f] = v === undefined ? null : v;
      const refType = REF_FIELDS[type]?.[f];
      if (refType && v !== null && v !== undefined && v !== false && !(type === "burg" && f === "port" && !v)) {
        const nm = refName(refType, v);
        if (nm !== null) row[`${f}Name`] = nm;
      }
    }
    if (withPos) {
      const a = anchor(type, x);
      if (a) {
        row.x = rn(a.x, 1);
        row.y = rn(a.y, 1);
        const ll = xyToLatLon(a.x, a.y, mapCoordinates, graphWidth, graphHeight, 2);
        row.lat = ll.lat;
        row.lon = ll.lon;
      }
    }
    return row;
  }

  FNS.find = a => {
    const type = a.type;
    checkType(type);
    const limit = a.limit === undefined ? 25 : Math.max(0, Math.min(1000, a.limit));
    const offset = Math.max(0, a.offset || 0);
    let items = liveList(type, !!a.includeZero);
    const where = a.where || {};
    // resolve entity-valued filters once
    const resolvedRefs = {};
    for (const key of Object.keys(where)) {
      const refType = REF_FIELDS[type]?.[key];
      if (!refType) continue;
      const vals = Array.isArray(where[key]) ? where[key] : [where[key]];
      if (vals.every(v => typeof v === "boolean")) continue;
      resolvedRefs[key] = vals.map(v => resolve(refType, v).i);
    }
    if (Object.keys(where).length) items = items.filter(x => matchWhere(type, x, where, resolvedRefs));
    let matchedBy = null;
    if (a.name !== undefined && a.name !== null && a.name !== "") {
      const rows = items.map(x => ({ i: idOf(type, x), name: nameOf(type, x), alt: altNames(type, x), x }));
      const mode = a.match || "auto";
      const m = mode === "contains" ? { matches: [], how: "none" } : matchName(a.name, rows);
      if (m.matches.length) {
        items = m.matches.map(r => r.x);
        matchedBy = m.how;
      } else if (mode !== "exact") {
        const q = fold(a.name);
        const subs = rows.filter(r => fold(r.name).includes(q) || r.alt.some(s => fold(s).includes(q)));
        items = subs.map(r => r.x);
        matchedBy = "contains";
      } else items = [];
      if (!items.length) {
        const cands = rankCandidates(a.name, rows, 8).map(r => candidateRow(type, r.x));
        fail("NOT_FOUND", `no ${type} name matches '${a.name}'`, { candidates: cands });
      }
    }
    let near = null;
    if (a.near) near = place(a.near);
    const fields = Array.isArray(a.fields) && a.fields.length ? a.fields : DEFAULT_FIELDS[type];
    let rows = items.map(x => {
      const row = rowOf(type, x, fields, type !== "namesbase");
      if (near && row.x !== undefined) row.distance = rn(Math.hypot(row.x - near.x, row.y - near.y), 1);
      return row;
    });
    if (near && a.radius) rows = rows.filter(r => r.distance !== undefined && r.distance <= a.radius);
    const sort = a.sort || (near ? "distance" : null);
    if (sort) {
      const desc = sort.startsWith("-");
      const key = desc ? sort.slice(1) : sort;
      const val = r => {
        if (key in r) return r[key];
        const x = byId(type, r.i);
        return x ? fieldValue(type, x, key) : null;
      };
      rows.sort((p, q) => {
        const va = val(p);
        const vb = val(q);
        let c;
        if (va === vb) c = 0;
        else if (va === null || va === undefined) c = 1;
        else if (vb === null || vb === undefined) c = -1;
        else if (typeof va === "string" || typeof vb === "string") c = String(va).localeCompare(String(vb));
        else c = va < vb ? -1 : 1;
        return desc ? -c : c;
      });
    }
    const total = rows.length;
    return {
      type,
      total,
      offset,
      returned: Math.min(limit, Math.max(0, total - offset)),
      matchedBy,
      near: near ? { x: near.x, y: near.y, cell: near.cell } : undefined,
      rows: rows.slice(offset, offset + limit)
    };
  };

  // ---------------------------------------------------------------- inspect

  function ref(type, id) {
    const nm = refName(type, id);
    return id === null || id === undefined ? null : { i: id, name: nm };
  }

  function relationsOf(type, x) {
    const c = pack.cells;
    const rel = {};
    switch (type) {
      case "burg": {
        rel.state = ref("state", x.state);
        rel.province = ref("province", c.province ? c.province[x.cell] || 0 : 0);
        rel.culture = ref("culture", x.culture);
        rel.religion = ref("religion", c.religion ? c.religion[x.cell] : null);
        rel.feature = ref("feature", x.feature ?? c.f[x.cell]);
        if (x.port) rel.portFeature = ref("feature", x.port);
        rel.people = people(x);
        if (x.capital && pack.states[x.state]) rel.capitalOf = ref("state", x.state);
        const routesAt = c.routes?.[x.cell] ? [...new Set(Object.values(c.routes[x.cell]))] : [];
        rel.routes = routesAt;
        break;
      }
      case "state": {
        rel.capital = ref("burg", x.capital);
        rel.culture = ref("culture", x.culture);
        rel.provinces = (x.provinces || [])
          .filter(p => pack.provinces[p] && !pack.provinces[p].removed)
          .map(p => ref("province", p));
        rel.neighbors = (x.neighbors || [])
          .filter(n => pack.states[n] && !pack.states[n].removed)
          .map(n => {
            const r = ref("state", n);
            if (Array.isArray(x.diplomacy)) r.relation = x.diplomacy[n];
            return r;
          });
        rel.burgCount = pack.burgs.filter(b => b?.i && !b.removed && b.state === x.i).length;
        rel.rural = fieldValue("state", x, "rural");
        rel.urban = fieldValue("state", x, "urban");
        break;
      }
      case "province": {
        rel.state = ref("state", x.state);
        rel.capital = ref("burg", x.burg);
        rel.cells = cellsWhere("province", x.i).length;
        break;
      }
      case "culture":
        rel.namesbase = ref("namesbase", x.base);
        rel.cells = cellsWhere("culture", x.i).length;
        break;
      case "religion":
        rel.culture = ref("culture", x.culture);
        rel.cells = cellsWhere("religion", x.i).length;
        break;
      case "river":
        rel.parent = x.parent && x.parent !== x.i ? ref("river", x.parent) : null;
        rel.cells = (x.cells || []).length;
        break;
      case "route": {
        const pts = x.points || [];
        rel.length = fieldValue("route", x, "length");
        rel.pointCount = pts.length;
        const ends = [pts[0], pts[pts.length - 1]].filter(Boolean).map(p => c.burg[p[2]] || 0);
        rel.endBurgs = ends.map(b => (b ? ref("burg", b) : null));
        break;
      }
      case "marker":
        rel.state = ref("state", c.state[x.cell]);
        break;
      case "zone":
        rel.cells = (x.cells || []).length;
        break;
      case "feature": {
        const s = featureStats().get(x.i);
        if (s) rel.bbox = [rn(s.x0, 1), rn(s.y0, 1), rn(s.x1, 1), rn(s.y1, 1)];
        break;
      }
      default:
        break;
    }
    const noteId =
      type === "burg"
        ? `burg${x.i}`
        : type === "marker"
          ? `marker${x.i}`
          : type === "state"
            ? `stateLabel${x.i}`
            : null;
    if (noteId) {
      const n = noteMap().get(noteId);
      if (n) rel.note = { id: n.id, name: n.name, legend: n.legend };
    }
    return rel;
  }

  function inspectPlace(at) {
    const p = place(at);
    const c = pack.cells;
    const i = p.cell;
    const h = c.h[i];
    const out = { ...p, height: h, land: h >= 20 };
    try {
      if (typeof getFriendlyHeight === "function") out.heightLabel = getFriendlyHeight([p.x, p.y]);
    } catch {}
    if (typeof biomesData !== "undefined" && c.biome) out.biome = { i: c.biome[i], name: biomesData.name[c.biome[i]] };
    out.state = ref("state", c.state[i]);
    out.province = c.province?.[i] ? ref("province", c.province[i]) : null;
    out.culture = ref("culture", c.culture[i]);
    out.religion = c.religion ? ref("religion", c.religion[i]) : null;
    out.burg = c.burg[i] ? ref("burg", c.burg[i]) : null;
    const rv = c.r ? c.r[i] : 0;
    out.river = rv ? ref("river", rv) : null;
    const f = pack.features[c.f[i]];
    out.feature = f ? { i: f.i, type: f.type, group: f.group, name: f.name || null } : null;
    try {
      if (typeof getCellPopulation === "function") {
        const [rural, urban] = getCellPopulation(i);
        out.population = { rural: Math.round(rural), urban: Math.round(urban) };
      }
    } catch {}
    out.routes = c.routes?.[i] ? [...new Set(Object.values(c.routes[i]))] : [];
    out.zones = (pack.zones || [])
      .filter(z => z && !z.hidden && (z.cells || []).includes(i))
      .map(z => ({ i: z.i, name: z.name }));
    out.markers = (pack.markers || []).filter(m => m && m.cell === i).map(m => ({ i: m.i, type: m.type }));
    return out;
  }

  FNS.inspect = a => {
    if (a.at) return { kind: "place", ...inspectPlace(a.at) };
    if (!a.entity) fail("BAD_ARGS", "inspect needs {entity:{type,ref}} or {at:Place}");
    const r = resolve(a.entity.type, a.entity.ref);
    const x = r.entity;
    const out = { kind: "entity", type: r.type, i: r.i, name: r.name };
    const pt = anchor(r.type, x);
    if (pt) {
      out.x = rn(pt.x, 2);
      out.y = rn(pt.y, 2);
      const ll = xyToLatLon(pt.x, pt.y, mapCoordinates, graphWidth, graphHeight);
      out.lat = ll.lat;
      out.lon = ll.lon;
      out.cell = r.type === "burg" || r.type === "marker" ? x.cell : nearestCell(pt.x, pt.y);
    }
    let ent = x;
    if (r.type === "label") ent = { id: x.id, text: x.name, group: x.group };
    out.entity = safeJson(ent, { maxItems: 300, maxDepth: 6 });
    out.relations = relationsOf(r.type, x);
    if (r.type === "feature" && out.relations.bbox) out.bbox = out.relations.bbox;
    return out;
  };

  FNS.resolve = a => {
    const r = resolve(a.type, a.ref);
    return { type: r.type, i: r.i, name: r.name };
  };
  FNS.place = a => place(a.place || a);
  FNS.entityBox = a => entityBox(a.type, a.ref);

  // ---------------------------------------------------------------- summary / digest / diff

  const LAYERS = {
    texture: "toggleTexture",
    heightmap: "toggleHeight",
    lakes: "toggleLakes",
    biomes: "toggleBiomes",
    cells: "toggleCells",
    grid: "toggleGrid",
    coordinates: "toggleCoordinates",
    compass: "toggleCompass",
    rivers: "toggleRivers",
    relief: "toggleRelief",
    religions: "toggleReligions",
    cultures: "toggleCultures",
    states: "toggleStates",
    provinces: "toggleProvinces",
    zones: "toggleZones",
    borders: "toggleBorders",
    routes: "toggleRoutes",
    temperature: "toggleTemperature",
    ice: "toggleIce",
    goods: "toggleGoods",
    markets: "toggleMarketsLayer",
    trade: "toggleTrade",
    precipitation: "togglePrecipitation",
    population: "togglePopulation",
    emblems: "toggleEmblems",
    burgs: "toggleBurgIcons",
    labels: "toggleLabels",
    military: "toggleMilitary",
    markers: "toggleMarkers",
    rulers: "toggleRulers",
    scaleBar: "toggleScaleBar",
    vignette: "toggleVignette"
  };
  const LAYER_ALIASES = { height: "heightmap", burgIcons: "burgs", icons: "burgs" };
  const FADE_SELECTORS = "#labels,#ice,#compass,#terrain,#lakes,#scaleBar,#emblems,#vignette";

  function layerId(name) {
    const n = LAYER_ALIASES[name] || name;
    if (!LAYERS[n]) fail("BAD_LAYER", `unknown layer '${name}'`, { details: Object.keys(LAYERS) });
    return [n, LAYERS[n]];
  }

  function layersOn() {
    if (typeof document === "undefined" || typeof layerIsOn !== "function") return [];
    return Object.keys(LAYERS).filter(n => document.getElementById(LAYERS[n]) && layerIsOn(LAYERS[n]));
  }

  function countLive(list) {
    let n = 0;
    for (const x of list || []) if (x && typeof x === "object" && !x.removed) n++;
    return n;
  }

  function featureCounts() {
    const islands = { continent: 0, island: 0, isle: 0, lake_island: 0 };
    let lakes = 0;
    let oceans = 0;
    for (const f of pack.features || []) {
      if (!f || typeof f !== "object") continue;
      if (f.type === "island") islands[f.group] = (islands[f.group] || 0) + 1;
      else if (f.type === "lake") lakes++;
      else if (f.type === "ocean") oceans++;
    }
    return { islands, islandsTotal: Object.values(islands).reduce((s, v) => s + v, 0), lakes, oceans };
  }

  function getView() {
    const k = scale;
    return {
      x: rn(viewX, 3),
      y: rn(viewY, 3),
      scale: rn(k, 4),
      svgWidth,
      svgHeight,
      graphWidth,
      graphHeight,
      mapBboxShown: [
        rn(-viewX / k, 1),
        rn(-viewY / k, 1),
        rn((svgWidth - viewX) / k, 1),
        rn((svgHeight - viewY) / k, 1)
      ]
    };
  }

  function summary() {
    return {
      name: typeof mapName !== "undefined" && mapName ? mapName.value : null,
      seed: typeof seed !== "undefined" ? seed : null,
      version: typeof VERSION !== "undefined" ? VERSION : null,
      graph: { w: graphWidth, h: graphHeight },
      cells: pack.cells.i.length,
      gridCells: grid?.cells ? grid.cells.i.length : null,
      counts: {
        states: liveList("state").length,
        burgs: liveList("burg").length,
        provinces: liveList("province").length,
        cultures: liveList("culture").length,
        religions: liveList("religion").length,
        rivers: countLive(pack.rivers),
        routes: countLive(pack.routes),
        markers: countLive(pack.markers),
        zones: countLive(pack.zones),
        notes: typeof notes !== "undefined" && Array.isArray(notes) ? notes.length : 0,
        labels: labelList().length
      },
      features: featureCounts(),
      mapCoordinates: typeof mapCoordinates !== "undefined" ? mapCoordinates : null,
      view: typeof svgWidth !== "undefined" ? getView() : null,
      layersOn: layersOn(),
      customization: typeof customization !== "undefined" ? customization : 0,
      mapId: currentMapId()
    };
  }
  /**
   * The app's map identity: stamped on generate, read back from params[6] on load. It is a
   * global `let` (main.js); window.mapId is only refreshed on generate, so read the binding.
   */
  function currentMapId() {
    if (typeof mapId !== "undefined" && mapId !== undefined) return mapId;
    return typeof window !== "undefined" && window.mapId !== undefined ? window.mapId : null;
  }
  FNS.summary = () => summary();
  FNS.mapId = () => currentMapId();

  const DIFF_TYPES = [
    "burg",
    "state",
    "province",
    "culture",
    "religion",
    "river",
    "route",
    "marker",
    "zone",
    "feature",
    "note",
    "label"
  ];
  const CELL_ARRAYS = ["h", "state", "province", "culture", "religion", "biome", "burg", "f", "r"];

  function projections() {
    const out = {};
    for (const type of DIFF_TYPES) {
      const m = {};
      for (const x of liveList(type, true)) {
        if (type === "label") m[x.id] = { text: x.name, group: x.group };
        else if (type === "note") m[x.id] = { name: x.name, legend: hashStr(String(x.legend || "")) };
        else m[String(idOf(type, x))] = projection(x);
      }
      out[type] = m;
    }
    return out;
  }

  function cellCopies() {
    const c = {};
    for (const k of CELL_ARRAYS) if (pack.cells[k]) c[k] = Array.from(pack.cells[k]);
    if (grid?.cells?.h) c.gridH = Array.from(grid.cells.h);
    return c;
  }

  const baselines = new Map();

  FNS.setBaseline = a => {
    const key = String(a.key);
    baselines.set(key, { at: Date.now(), proj: projections(), cells: cellCopies() });
    return { key, baselines: baselines.size };
  };
  FNS.dropBaseline = a => {
    const keys = Array.isArray(a.keys) ? a.keys : [a.key];
    for (const k of keys) baselines.delete(String(k));
    return { baselines: baselines.size };
  };
  FNS.listBaselines = () => [...baselines.keys()];

  function diffAgainst(base, limit) {
    const cur = projections();
    const changes = {};
    let truncated = false;
    let empty = true;
    for (const type of DIFF_TYPES) {
      const d = diffProjections(base.proj[type] || {}, cur[type] || {}, limit);
      if (d.counts.added || d.counts.removed || d.counts.modified) {
        empty = false;
        if (d.truncated) truncated = true;
        const names = id => {
          const x = byId(type, id) || null;
          return x && typeof x === "object" ? nameOf(type, x) : null;
        };
        changes[type] = {
          counts: d.counts,
          added: d.added.map(i => ({ i, name: names(i) })),
          removed: d.removed,
          modified: d.modified.map(m => ({ i: m.i, name: names(m.i), fields: m.fields }))
        };
      }
    }
    const cells = {};
    const now = cellCopies();
    for (const k of Object.keys(now)) {
      const n = diffArray(base.cells[k], now[k]);
      if (n) {
        cells[k] = n;
        empty = false;
      }
    }
    if (Object.keys(cells).length) changes.cells = cells;
    return { changes, empty, truncated };
  }

  FNS.diff = a => {
    const base = baselines.get(String(a.key));
    if (!base) return { available: false, key: a.key, reason: "baseline unavailable (page relaunched or key unknown)" };
    const d = diffAgainst(base, a.limit || 50);
    return { available: true, key: a.key, since: new Date(base.at).toISOString(), ...d };
  };

  FNS.digest = () => {
    const proj = projections();
    const per = {};
    for (const t of DIFF_TYPES) per[t] = hashStr(JSON.stringify(proj[t]));
    const cells = cellCopies();
    const cellHash = {};
    for (const k of Object.keys(cells)) cellHash[k] = hashArray(cells[k]);
    return { hash: hashStr(JSON.stringify([per, cellHash])), types: per, cells: cellHash };
  };

  /**
   * Fingerprint of the pack cell graph (cell count + pack->grid mapping). A heightmap rebuild
   * (rebuild:'risk', or the app's heightmap editor) renumbers pack cells and changes it, so a
   * literal list of pack cell ids recorded on one graph does not point at the same places on
   * another.
   */
  function cellGraph() {
    if (!pack?.cells?.g) return null;
    return `${pack.cells.i.length}:${hashArray(Array.from(pack.cells.g))}`;
  }
  FNS.cellGraph = () => ({ graph: cellGraph() });

  // ---------------------------------------------------------------- view

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const raf2 = () =>
    new Promise(r => {
      if (typeof requestAnimationFrame !== "function") return setTimeout(r, 0);
      requestAnimationFrame(() => requestAnimationFrame(() => r()));
    });

  async function setView(v) {
    const k = Number(v.scale);
    if (!(k > 0) || !Number.isFinite(Number(v.x)) || !Number.isFinite(Number(v.y)))
      fail("BAD_VIEW", "view needs x, y, scale");
    svg.interrupt();
    // After a map load d3's zoom state is reset while the app's view globals (scale, viewX, viewY)
    // keep their old values; zooming to a view equal to those globals is then a no-op in the
    // app's zoom handler (zoomRaf), which leaves the viewbox transform, label visibility and the
    // scale bar drawn for another zoom. Nudge the globals so zoomRaf runs its full redraw.
    if (scale === k && viewX === Number(v.x) && viewY === Number(v.y)) {
      scale = 0;
      viewX = Number(v.x) + 1;
    }
    svg.call(zoom.transform, d3.zoomIdentity.translate(Number(v.x), Number(v.y)).scale(k));
    await raf2();
    // Fallback: if the handler still did not run, sync the DOM to the globals (as zoomRaf does).
    const want = `translate(${viewX} ${viewY}) scale(${scale})`;
    if (viewbox.attr("transform") !== want) {
      viewbox.attr("transform", want);
      if (typeof invokeActiveZooming === "function") invokeActiveZooming();
      await raf2();
    }
    return getView();
  }

  function clampTranslate(t, viewport, size) {
    if (size <= viewport) return (viewport - size) / 2;
    return Math.min(0, Math.max(viewport - size, t));
  }

  async function frame(a) {
    const target = a.target || {};
    let box;
    let label;
    if (target.entity) {
      box = entityBox(target.entity.type, target.entity.ref);
      label = `${box.type} ${box.i}${box.name ? ` (${box.name})` : ""}`;
    } else if (Array.isArray(target.bbox)) {
      const [ax, ay, bx, by] = target.bbox.map(Number);
      if (![ax, ay, bx, by].every(Number.isFinite)) fail("BAD_ARGS", "bbox is [x0, y0, x1, y1] in map px");
      box = { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
      box.cx = (box.x0 + box.x1) / 2;
      box.cy = (box.y0 + box.y1) / 2;
      label = "bbox";
    } else if (target.at) {
      const p = place(target.at);
      box = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, cx: p.x, cy: p.y };
      label = `place ${p.via}`;
    } else fail("BAD_ARGS", "frame needs target {entity} | {bbox} | {at}");
    const bw = box.x1 - box.x0;
    const bh = box.y1 - box.y0;
    const isPoint = bw < 1 && bh < 1;
    const [kmin, kmax] = zoom.scaleExtent();
    let k = a.zoom ? Number(a.zoom) : isPoint ? 8 : Math.min(svgWidth / (bw * 1.15 || 1), svgHeight / (bh * 1.15 || 1));
    k = Math.max(kmin, Math.min(kmax, k));
    const cx = box.cx ?? (box.x0 + box.x1) / 2;
    const cy = box.cy ?? (box.y0 + box.y1) / 2;
    const tx = clampTranslate(svgWidth / 2 - cx * k, svgWidth, graphWidth * k);
    const ty = clampTranslate(svgHeight / 2 - cy * k, svgHeight, graphHeight * k);
    const view = await setView({ x: tx, y: ty, scale: k });
    return { ...view, target: label, box: [rn(box.x0, 1), rn(box.y0, 1), rn(box.x1, 1), rn(box.y1, 1)] };
  }

  FNS.getView = () => getView();
  FNS.setView = a => setView(a.view || a);
  FNS.frame = a => frame(a);
  FNS.resetView = async () => {
    if (typeof fitMapToScreen === "function") fitMapToScreen();
    const [kmin] = zoom.scaleExtent();
    const k = Math.max(kmin, Math.min(svgWidth / graphWidth, svgHeight / graphHeight));
    return setView({
      x: clampTranslate(0, svgWidth, graphWidth * k),
      y: clampTranslate(0, svgHeight, graphHeight * k),
      scale: k
    });
  };

  /** Idempotent layer visibility. Returns {changed, previous, layersOn}. */
  async function setLayers(a) {
    const on = (a.on || []).map(layerId);
    const off = (a.off || []).map(layerId);
    const changed = [];
    const previous = { on: [], off: [] };
    let slow = false;
    const apply = ([name, id], want) => {
      const el = document.getElementById(id);
      const fn = root[id];
      if (!el || typeof fn !== "function") fail("BAD_LAYER", `layer '${name}' is not available in this build`);
      if (layerIsOn(id) === want) return;
      fn();
      if (layerIsOn(id) !== want) fn(); // toggles that decide by DOM content can need a second flip
      if (layerIsOn(id) !== want) fail("LAYER_STUCK", `could not turn ${name} ${want ? "on" : "off"}`);
      changed.push({ layer: name, to: want ? "on" : "off" });
      previous[want ? "off" : "on"].push(name);
      if (name === "precipitation" || name === "population") slow = true;
    };
    for (const l of on) apply(l, true);
    for (const l of off) apply(l, false);
    try {
      if (typeof $ === "function") $(FADE_SELECTORS).stop(true, true);
    } catch {}
    if (slow) await sleep(1100);
    await raf2();
    return { changed, previous, layersOn: layersOn() };
  }
  FNS.setLayers = a => setLayers(a);
  FNS.layersOn = () => layersOn();

  // ---------------------------------------------------------------- redraw

  const REDRAW = {
    features: ["drawFeatures", null],
    heightmap: ["drawHeightmap", "toggleHeight"],
    biomes: ["drawBiomes", "toggleBiomes"],
    cultures: ["drawCultures", "toggleCultures"],
    religions: ["drawReligions", "toggleReligions"],
    states: ["drawStates", "toggleStates"],
    provinces: ["drawProvinces", "toggleProvinces"],
    borders: ["drawBorders", "toggleBorders"],
    rivers: ["drawRivers", "toggleRivers"],
    routes: ["drawRoutes", "toggleRoutes"],
    zones: ["drawZones", "toggleZones"],
    markers: ["drawMarkers", "toggleMarkers"],
    burgIcons: ["drawBurgIcons", "toggleBurgIcons"],
    labels: ["drawLabels", "toggleLabels"],
    stateLabels: ["drawStateLabels", "toggleLabels"],
    burgLabels: ["drawBurgLabels", "toggleLabels"],
    emblems: ["drawEmblems", "toggleEmblems"]
  };

  async function redraw(a) {
    const plan = coalesceRedraws(a.layers || []);
    const redrawn = [];
    const skippedHidden = [];
    for (const step of plan) {
      if (step.layer === "all") {
        drawLayers();
        redrawn.push("all");
        continue;
      }
      const [fnName, toggle] = REDRAW[step.layer];
      if (toggle && typeof layerIsOn === "function" && !layerIsOn(toggle)) {
        skippedHidden.push(step.layer);
        continue;
      }
      const fn = root[fnName];
      if (typeof fn !== "function") fail("BAD_LAYER", `${fnName} is not available`);
      if (step.layer === "stateLabels" && step.ids) {
        const unlocked = [];
        for (const id of step.ids) {
          const s = pack.states[id];
          if (s?.lock) {
            s.lock = false;
            unlocked.push(s);
          }
        }
        try {
          fn(step.ids);
        } finally {
          for (const s of unlocked) s.lock = true;
        }
      } else fn();
      redrawn.push(step.ids ? { layer: step.layer, ids: step.ids } : step.layer);
    }
    if (typeof invokeActiveZooming === "function") invokeActiveZooming();
    await raf2();
    return { redrawn, skippedHidden };
  }
  FNS.redraw = a => redraw(a);

  // ---------------------------------------------------------------- alerts / readiness

  const ERROR_TITLES = [
    "Generation error",
    "Loading error",
    "Invalid file",
    "Ancient file",
    "Newer file",
    "Saving error"
  ];

  function visibleAlert() {
    if (typeof document === "undefined") return null;
    const el = document.getElementById("alert");
    const dlg = el?.closest(".ui-dialog");
    if (!dlg || dlg.style.display === "none" || getComputedStyle(dlg).display === "none") return null;
    const title = (dlg.querySelector(".ui-dialog-title")?.textContent || "").trim();
    const text = (document.getElementById("alertMessage")?.innerText || el.innerText || "").trim().slice(0, 2000);
    return { title, text, error: ERROR_TITLES.includes(title) };
  }

  function collectAlerts() {
    const out = [];
    for (let k = 0; k < 5; k++) {
      const a = visibleAlert();
      if (!a) break;
      out.push(a);
      try {
        $("#alert").dialog("close");
      } catch {
        document.getElementById("alert").closest(".ui-dialog").style.display = "none";
      }
    }
    return out;
  }

  /**
   * Let rendering catch up: a macrotask, then fonts and 2 rAF, repeated while fonts are still
   * loading (a font first needed at layout starts loading only after the frame; until it loads
   * or fails, Chrome draws its text invisibly). Bounded to about 3 s overall.
   */
  async function settle() {
    await sleep(0);
    const fonts = typeof document !== "undefined" ? document.fonts : null;
    const end = Date.now() + 3000;
    for (let i = 0; i < 4; i++) {
      if (fonts) await Promise.race([fonts.ready, sleep(Math.max(0, end - Date.now()))]);
      await raf2();
      if (!fonts || fonts.status !== "loading" || Date.now() >= end) break;
    }
  }

  /**
   * Run trigger() and wait for the next map:generated, racing error alerts and a timeout.
   * Then wait a macrotask, fonts (bounded 3 s) and 2 rAF.
   */
  async function awaitMap(trigger, timeoutMs, op) {
    let onEvt;
    let pollId;
    let toId;
    const evt = new Promise(res => {
      onEvt = e => res({ detail: e.detail || {} });
      addEventListener("map:generated", onEvt);
    });
    const alertP = new Promise(res => {
      pollId = setInterval(() => {
        const al = visibleAlert();
        if (al?.error) res({ alert: al });
      }, 100);
    });
    const toP = new Promise(res => {
      toId = setTimeout(() => res({ timeout: true }), timeoutMs || 110000);
    });
    try {
      await trigger();
      const r = await Promise.race([evt, alertP, toP]);
      if (r.alert) fail("APP_ALERT", `${r.alert.title}: ${r.alert.text}`);
      if (r.timeout) fail("TIMEOUT", `no map:generated within ${timeoutMs} ms`);
      if (op && T.activeOp !== op) fail("STALE_OP", "a newer operation started while this one was waiting");
      await settle();
      return r.detail;
    } finally {
      removeEventListener("map:generated", onEvt);
      clearInterval(pollId);
      clearTimeout(toId);
    }
  }
  T.awaitMap = awaitMap;
  T.settle = settle;

  FNS.settle = async () => {
    await settle();
    return { fonts: typeof document !== "undefined" && document.fonts ? document.fonts.status : null };
  };

  FNS.ready = async a => {
    const boot = root.__mcpBoot;
    const already = typeof window !== "undefined" && window.mapId !== undefined;
    if (!already) {
      let pollId;
      let toId;
      try {
        const r = await Promise.race([
          boot ? boot.then(d => ({ detail: d })) : new Promise(() => {}),
          new Promise(res => {
            pollId = setInterval(() => {
              const al = visibleAlert();
              if (al?.error) res({ alert: al });
              else if (window.mapId !== undefined) res({ detail: {} });
            }, 100);
          }),
          new Promise(res => {
            toId = setTimeout(() => res({ timeout: true }), a.timeoutMs || 60000);
          })
        ]);
        if (r.alert) fail("APP_ALERT", `${r.alert.title}: ${r.alert.text}`);
        if (r.timeout) fail("TIMEOUT", "the app did not finish its first map");
      } finally {
        clearInterval(pollId);
        clearTimeout(toId);
      }
    }
    await settle();
    return summary();
  };

  // ---------------------------------------------------------------- map io

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
    return out;
  }

  FNS.mapData = async () => {
    const { prepareMapData } = await lazy.save();
    const text = prepareMapData();
    let fileName = null;
    try {
      fileName = typeof getFileName === "function" ? getFileName() : null;
    } catch {}
    return {
      text,
      bytes: text.length,
      customization: typeof customization !== "undefined" ? customization : 0,
      fileName
    };
  };

  FNS.loadMap = async (a, meta) => {
    const blob = a.b64 ? new Blob([b64ToBytes(a.b64)]) : new Blob([String(a.text || "")]);
    const prevView = a.keepView ? getView() : null;
    const { uploadMap } = await lazy.load();
    if (typeof closeDialogs === "function") closeDialogs();
    await awaitMap(() => uploadMap(blob), a.timeoutMs || 110000, meta?.op);
    if (prevView && prevView.graphWidth === graphWidth && prevView.graphHeight === graphHeight) {
      await setView({ x: prevView.x, y: prevView.y, scale: prevView.scale });
    }
    return summary();
  };

  // ---------------------------------------------------------------- images

  async function decodeImage(b64, mime) {
    const blob = new Blob([b64ToBytes(b64)], { type: mime || "image/png" });
    return createImageBitmap(blob);
  }

  function canvasOf(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  function encodeCanvas(canvas, format, quality) {
    const mime = format === "png" ? "image/png" : "image/jpeg";
    const url = canvas.toDataURL(mime, quality ?? 0.85);
    return { b64: url.slice(url.indexOf(",") + 1), mime, width: canvas.width, height: canvas.height };
  }

  /** Re-encode an image, downscaling so the longest side is <= maxSide. */
  FNS.encodeImage = async a => {
    const bmp = await decodeImage(a.b64, a.mime);
    const s = Math.min(1, (a.maxSide || 1024) / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * s));
    const h = Math.max(1, Math.round(bmp.height * s));
    if (s === 1 && a.format === "png" && (a.mime || "image/png") === "image/png") {
      return { b64: a.b64, mime: "image/png", width: w, height: h };
    }
    const c = canvasOf(w, h);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    if (a.format !== "png") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(bmp, 0, 0, w, h);
    return encodeCanvas(c, a.format, a.quality);
  };

  /** Pixel diff of two same-size images: red = changed, grey = unchanged context. */
  FNS.diffImages = async a => {
    const [ia, ib] = await Promise.all([decodeImage(a.a), decodeImage(a.b)]);
    if (ia.width !== ib.width || ia.height !== ib.height) {
      fail("SIZE_MISMATCH", `cannot compare ${ia.width}x${ia.height} with ${ib.width}x${ib.height}`);
    }
    const w = ia.width;
    const h = ia.height;
    const ca = canvasOf(w, h).getContext("2d");
    const cb = canvasOf(w, h).getContext("2d");
    ca.drawImage(ia, 0, 0);
    cb.drawImage(ib, 0, 0);
    const da = ca.getImageData(0, 0, w, h).data;
    const out = cb.getImageData(0, 0, w, h);
    const db = out.data;
    const thr = a.threshold ?? 32;
    let changed = 0;
    for (let p = 0; p < db.length; p += 4) {
      const d = Math.max(Math.abs(da[p] - db[p]), Math.abs(da[p + 1] - db[p + 1]), Math.abs(da[p + 2] - db[p + 2]));
      if (d > thr) {
        changed++;
        db[p] = 230;
        db[p + 1] = 20;
        db[p + 2] = 30;
        db[p + 3] = 255;
      } else {
        const g = Math.round((db[p] * 0.3 + db[p + 1] * 0.59 + db[p + 2] * 0.11) * 0.35 + 255 * 0.65);
        db[p] = g;
        db[p + 1] = g;
        db[p + 2] = g;
        db[p + 3] = 255;
      }
    }
    cb.putImageData(out, 0, 0);
    const total = w * h;
    let canvas = cb.canvas;
    const s = Math.min(1, (a.maxSide || 1024) / Math.max(w, h));
    if (s < 1) {
      const c2 = canvasOf(Math.round(w * s), Math.round(h * s));
      c2.getContext("2d").drawImage(canvas, 0, 0, c2.width, c2.height);
      canvas = c2;
    }
    const img = encodeCanvas(canvas, a.format || "png", a.quality);
    const full = a.fullB64 ? encodeCanvas(cb.canvas, "png") : null;
    return { ...img, changed, total, changedPct: rn((changed / total) * 100, 3), fullPng: full ? full.b64 : null };
  };

  /** Rasterise the whole map (getMapURL fullMap) at graph size x scale. */
  FNS.rasterize = async a => {
    const { getMapURL } = await lazy.exportMap();
    const opts = Object.assign({ fullMap: true }, a.options || {});
    const url = await getMapURL("png", opts);
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error("could not rasterise the map SVG"));
      img.src = url;
    });
    const k = a.scale || 1;
    const c = canvasOf(Math.round(graphWidth * k), Math.round(graphHeight * k));
    const ctx = c.getContext("2d");
    if (a.format === "jpeg") {
      ctx.fillStyle = "#ffffff"; // JPEG has no alpha: paint transparent areas white, not black
      ctx.fillRect(0, 0, c.width, c.height);
    }
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return encodeCanvas(c, a.format || "png", a.quality);
  };

  // ---------------------------------------------------------------- export (save_map/export tools)

  function exportOptions(o) {
    const out = { fullMap: o?.fullMap !== false };
    for (const k of ["noLabels", "noWater", "noScaleBar", "noIce", "noVignette"]) if (o?.[k]) out[k] = true;
    return out;
  }
  T.exportOptions = exportOptions;

  function refuseWhileEditing() {
    if (typeof customization !== "undefined" && customization) {
      fail(
        "REFUSED",
        `an editor is active (customization=${customization}); close it first (eval: closeDialogs(); customization = 0)`
      );
    }
  }

  FNS.mapFileName = () => {
    let fileName = null;
    try {
      fileName = typeof getFileName === "function" ? getFileName() : null;
    } catch {}
    return { fileName, customization: typeof customization !== "undefined" ? customization : 0 };
  };

  /** SVG text of the map (getMapURL fetched inside this call: the blob URL dies after 5 s). */
  FNS.exportSvg = async a => {
    refuseWhileEditing();
    const { getMapURL } = await lazy.exportMap();
    const url = await getMapURL("svg", exportOptions(a.options));
    const text = await (await fetch(url)).text();
    return { text, bytes: text.length, graphWidth, graphHeight };
  };

  /** PNG/JPEG of the whole map: the same rasteriser as screenshot {full:true}. */
  FNS.exportRaster = async a => {
    refuseWhileEditing();
    return FNS.rasterize({
      scale: a.scale || 1,
      format: a.format,
      quality: a.quality,
      options: exportOptions(a.options)
    });
  };

  const JSON_KINDS = {
    "json-full": "Full",
    "json-minimal": "Minimal",
    "json-packcells": "PackCells",
    "json-gridcells": "GridCells"
  };
  const GEOJSON_FNS = {
    "geojson-cells": "saveGeoJsonCells",
    "geojson-routes": "saveGeoJsonRoutes",
    "geojson-rivers": "saveGeoJsonRivers",
    "geojson-markers": "saveGeoJsonMarkers",
    "geojson-zones": "saveGeoJsonZones"
  };

  /** Start one of the app's download-only exports; Node captures the download event. */
  FNS.triggerDownload = async a => {
    refuseWhileEditing();
    const kind = String(a.format || "");
    if (JSON_KINDS[kind]) {
      const { exportToJson } = await lazy.exportJson();
      exportToJson(JSON_KINDS[kind]);
      return { started: kind };
    }
    if (GEOJSON_FNS[kind]) {
      const mod = await lazy.exportMap();
      mod[GEOJSON_FNS[kind]]();
      return { started: kind };
    }
    fail("BAD_ARGS", `unknown download format '${kind}'`);
  };

  // ---------------------------------------------------------------- eval

  const INFLIGHT = new Set();

  FNS.evalUser = async a => {
    const AsyncFunction = (async () => {}).constructor;
    const code = String(a.code || "");
    const expr = code.trim().replace(/;+\s*$/, "");
    let fn;
    try {
      fn = new AsyncFunction("args", `return (\n${expr}\n);`);
    } catch {
      try {
        fn = new AsyncFunction("args", code);
      } catch (e) {
        fail("EVAL_SYNTAX", `syntax error: ${e.message}`);
      }
    }
    let value;
    // Hold a strong reference while awaiting: CDP only weakly tracks the awaited promise, so a
    // promise nothing else references (e.g. `new Promise(() => {})`) can be garbage-collected and
    // Playwright then reports "Execution context was destroyed" although nothing navigated.
    const pending = fn(a.args === undefined ? null : a.args);
    INFLIGHT.add(pending);
    try {
      value = await pending;
    } catch (e) {
      const err = new Error(e?.message ? e.message : String(e));
      err.code = "EVAL_ERROR";
      err.stackHead = e?.stack ? String(e.stack).split("\n").slice(0, 4).join("\n") : undefined;
      throw err;
    } finally {
      INFLIGHT.delete(pending);
    }
    const out = { value: value === undefined ? null : value };
    if (Array.isArray(a.redraw) && a.redraw.length) Object.assign(out, await redraw({ layers: a.redraw }));
    return out;
  };

  // Functions whose results are large strings (map text, base64 images) skip safeJson caps.
  for (const k of ["mapData", "encodeImage", "diffImages", "rasterize", "exportSvg", "exportRaster"]) FNS[k].raw = true;

  // ---------------------------------------------------------------- envelope

  T.activeOp = null;

  /**
   * The single entry point. Returns {ok, value?, error?, alerts?, ms, op}.
   * meta: {op?: token for mutating calls, json?: safeJson options, noAlerts?: bool}
   */
  // The promise CDP awaits is retained until it settles (see INFLIGHT above).
  T.call = (name, args, meta) => {
    const p = callImpl(name, args, meta);
    INFLIGHT.add(p);
    p.then(
      () => INFLIGHT.delete(p),
      () => INFLIGHT.delete(p)
    );
    return p;
  };

  const callImpl = async (name, args, meta) => {
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    const m = meta || {};
    if (m.op) T.activeOp = m.op;
    memo = null;
    const env = { ok: true, op: m.op || null };
    try {
      const fn = FNS[name];
      if (!fn) fail("UNKNOWN_FUNCTION", `bridge has no function '${name}'`);
      const v = await fn(args || {}, m);
      env.value = fn.raw ? v : safeJson(v, m.json);
    } catch (e) {
      env.ok = false;
      env.error = errorOf(e);
    } finally {
      memo = null;
    }
    if (!m.noAlerts) {
      try {
        const alerts = collectAlerts();
        if (alerts.length) {
          env.alerts = alerts;
          const bad = alerts.find(x => x.error);
          if (bad && env.ok) {
            env.ok = false;
            env.error = { code: "APP_ALERT", message: `${bad.title}: ${bad.text}` };
          }
        }
      } catch {}
    }
    env.ms = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0);
    return env;
  };

  T.version = 1;
  T.fns = FNS;
  T.resolve = resolve;
  T.place = place;
  T.entityBox = entityBox;
  T.cellGraph = cellGraph;
  T.summary = summary;
  T.collectAlerts = collectAlerts;
  T.getView = getView;
  T.setView = setView;
  T.redraw = redraw;
  T.fail = fail;
  T.resetMemo = () => {
    memo = null; // per-call caches (labels, notes) go stale after a mutation inside the call
  };
  // shared internals for later layers (edit/add/paint): resolve refs, anchors, cell scans
  T.internals = {
    rawList,
    liveList,
    byId,
    nameOf,
    idOf,
    anchor,
    cellsWhere,
    cellsBox,
    fieldValue,
    people,
    layerId,
    LAYERS
  };
  T.pure = {
    fold,
    levenshtein,
    rankCandidates,
    matchName,
    xyToLatLon,
    latLonToXY,
    screenToMap,
    polylineAt,
    projection,
    diffProjections,
    diffArray,
    coalesceRedraws,
    safeJson,
    hashStr,
    hashArray
  };

  root.__tupaia = T;
})(globalThis);
