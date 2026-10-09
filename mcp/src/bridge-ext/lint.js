// Tupaia MCP bridge extension: lint, a read-only automatic map quality check.
// Injected after bridge.js and bridge-mutations.js (src/bridge-ext/*.js, name order). Same rules
// as bridge.js: app globals by bare name at call time, no locals that shadow app globals
// (labels, burgLabels, routes, rivers, markers, zones, cells, notes, scale, ...), every FNS
// function takes one args object. lint never mutates the map: no data writes, no redraws, no
// layer toggles. The one DOM touch besides getBBox/getCTM reads: while label boxes are measured at
// a zoom, the label groups' font-size attribute and hidden class are set the way the app's
// invokeActiveZooming would at that zoom, then put back in a finally block, all in one synchronous
// call (nothing paints in between).
//
// FNS.lint({checks?, types?, bbox?, near?+radius?, limit?, maxRows?, minSeverity?, fixes?,
//           overlapMin?, markerGap?, riverTol?, atScale?, ignore?}) runs the checks below and returns
//   {ms, map, totals, counts, rows, fixAll?, more?, clean, skipped?, notes?, unlocated?, ignored?}
// where rows[checkId] = [{sev, e:[[type,id,name]...], at:[x,y]?, msg, fix?:{tool,args}, hint?}].
// Overlap and stacking tests use a bucket grid, never all-pairs.
(root => {
  const T = root.__tupaia;
  if (!T) return;
  const FNS = T.fns;
  const fail = T.fail;
  const I = T.internals;
  const fold = T.pure.fold;

  const rn = (v, d = 2) => {
    const m = 10 ** d;
    return Math.round(v * m) / m;
  };
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const SEV_RANK = { info: 0, warn: 1, error: 2 };

  /** Check ids in report order, with their default severity and what they look at. */
  const DEFS = {
    "label-offcanvas": { sev: "warn", about: "label box outside the map rect" },
    "label-overlap": { sev: "info", about: "labels overlapping each other" },
    "label-marker-overlap": { sev: "info", about: "a marker pin covering a label", optIn: true },
    "label-orphan": { sev: "warn", about: "state/burg label whose state/burg was removed" },
    "marker-stacked": { sev: "warn", about: "markers within markerGap px (or in one cell)" },
    "marker-near-burg": { sev: "info", about: "marker within markerGap px of a burg or in its cell", optIn: true },
    "marker-cell-link": { sev: "warn", about: "marker.cell far from the cell at the marker's coordinates" },
    "marker-in-water": { sev: "error", about: "land-only marker on a water cell" },
    "burg-in-water": { sev: "error", about: "burg on a water or lake cell" },
    "burg-shared-cell": { sev: "warn", about: "several burgs in one cell" },
    "burg-cell-link": { sev: "warn", about: "pack.cells.burg or burg.cell disagrees with the burg" },
    "capital-outside": { sev: "error", about: "state capital missing or outside its state" },
    "province-empty": { sev: "warn", about: "province without cells" },
    "state-empty": { sev: "warn", about: "state without cells" },
    unnamed: { sev: "warn", about: "river, lake, zone, route, state, province, burg or label without a name" },
    "name-duplicate": { sev: "info", about: "same name twice within one entity type" },
    "river-uphill": { sev: "warn", about: "river cell heights rise downstream beyond riverTol" },
    "river-loop": { sev: "error", about: "river revisits a cell" },
    "river-gap": { sev: "warn", about: "river cells that are not neighbours" },
    "route-link": { sev: "warn", about: "pack.cells.routes stale, wrong or missing links" },
    "route-point-cell": { sev: "warn", about: "route point far from its recorded cell" },
    "route-end-burg": { sev: "warn", about: "route ends at a removed burg" },
    "note-orphan": { sev: "warn", about: "note whose entity was removed" }
  };
  const CHECK_IDS = Object.keys(DEFS);
  // checks that run only when named in `checks` (they are noisy on generated maps)
  const DEFAULT_IDS = CHECK_IDS.filter(id => !DEFS[id].optIn);
  // checks whose rows span several entity types: counts get a per-type breakdown
  const KINDED = new Set(["unnamed", "name-duplicate"]);

  // Marker types the generator places on land only (markers-generator.ts list* filters). Water
  // markers: sea-monsters, pirates (ocean) and lake-monsters (lake).
  const LAND_MARKERS = new Set([
    "volcanoes",
    "hot-springs",
    "water-sources",
    "mines",
    "bridges",
    "inns",
    "lighthouses",
    "waterfalls",
    "battlefields",
    "dungeons",
    "hill-monsters",
    "sacred-mountains",
    "sacred-forests",
    "sacred-pineries",
    "sacred-palm-groves",
    "brigands",
    "statues",
    "ruins",
    "libraries",
    "circuses",
    "jousts",
    "fairs",
    "canoes",
    "migration",
    "dances",
    "mirage",
    "caves",
    "portals",
    "rifts",
    "disturbed-burials",
    "necropolises",
    "encounters"
  ]);
  const WATER_MARKERS = new Set(["sea-monsters", "pirates", "lake-monsters"]);
  const WATERISH =
    /sea|lake|ocean|water|ship|pirate|whirl|reef|wreck|harbou?r|port\b|dock|anchor|buoy|fish|kraken|leviathan|boat|ferry|ford|bridge|island|isle/i;

  // ---------------------------------------------------------------- pure geometry (unit-tested in node:vm)

  /**
   * Pairs of items that overlap by at least minFrac of the smaller item's area. An item is a box
   * {x0,y0,x1,y1}, or {parts:[box...]} for curved text (one box per run of glyphs, so a long
   * state label does not claim the whole rectangle around its path). The overlap of two items is
   * the summed intersection of their parts; their size is the summed part area.
   * Bucket grid: only parts that share a bucket are compared, never all pairs.
   * Returns [{a, b, frac, inter, areaA, areaB, ox, oy, ix, iy}] (frac: inter over the smaller area;
   * ox/oy/ix/iy: the biggest intersecting part pair).
   */
  function overlapPairs(items, minFrac, bucket = 64) {
    const parts = [];
    const owner = [];
    const area = new Array(items.length).fill(0);
    items.forEach((it, k) => {
      for (const b of it.parts || (it.box ? [it.box] : [it])) {
        parts.push(b);
        owner.push(k);
        area[k] += Math.max(0, (b.x1 - b.x0) * (b.y1 - b.y0));
      }
    });
    const np = parts.length;
    const bkey = (gx, gy) => (gx + 4096) * 16384 + (gy + 4096); // collisions only add comparisons
    const grid = new Map();
    for (let k = 0; k < np; k++) {
      const b = parts[k];
      const gx1 = Math.floor(b.x1 / bucket);
      const gy1 = Math.floor(b.y1 / bucket);
      for (let gx = Math.floor(b.x0 / bucket); gx <= gx1; gx++) {
        for (let gy = Math.floor(b.y0 / bucket); gy <= gy1; gy++) {
          const key = bkey(gx, gy);
          const list = grid.get(key);
          if (list) list.push(k);
          else grid.set(key, [k]);
        }
      }
    }
    const acc = new Map();
    const n = items.length;
    for (const [key, list] of grid) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const pa = list[i];
          const pb = list[j];
          if (owner[pa] === owner[pb]) continue;
          const A = parts[pa];
          const B = parts[pb];
          const ix = Math.max(A.x0, B.x0);
          const iy = Math.max(A.y0, B.y0);
          const ox = Math.min(A.x1, B.x1) - ix;
          const oy = Math.min(A.y1, B.y1) - iy;
          if (!(ox > 0 && oy > 0)) continue;
          // count a part pair once: in the bucket that holds the corner of its intersection
          if (bkey(Math.floor(ix / bucket), Math.floor(iy / bucket)) !== key) continue;
          const a = Math.min(owner[pa], owner[pb]);
          const c = Math.max(owner[pa], owner[pb]);
          const akey = a * n + c;
          let e = acc.get(akey);
          if (!e) {
            e = { a, b: c, inter: 0, ox: 0, oy: 0, ix, iy, best: 0 };
            acc.set(akey, e);
          }
          e.inter += ox * oy;
          if (ox * oy > e.best) Object.assign(e, { best: ox * oy, ox, oy, ix, iy });
        }
      }
    }
    const out = [];
    for (const e of acc.values()) {
      const smaller = Math.min(area[e.a], area[e.b]);
      if (!(smaller > 0)) continue;
      const frac = Math.min(1, e.inter / smaller);
      if (frac >= minFrac)
        out.push({
          a: e.a,
          b: e.b,
          frac,
          inter: e.inter,
          areaA: area[e.a],
          areaB: area[e.b],
          ox: e.ox,
          oy: e.oy,
          ix: e.ix,
          iy: e.iy
        });
    }
    return out;
  }

  /** Index pairs of points {x,y} closer than gap (strictly), via a bucket grid. */
  function closePairs(pts, gap) {
    const grid = new Map();
    const out = [];
    const bucket = Math.max(gap, 1);
    for (let k = 0; k < pts.length; k++) {
      const gx = Math.floor(pts[k].x / bucket);
      const gy = Math.floor(pts[k].y / bucket);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const list = grid.get(`${gx + dx},${gy + dy}`);
          if (!list) continue;
          for (const j of list) {
            const d = Math.hypot(pts[k].x - pts[j].x, pts[k].y - pts[j].y);
            if (d < gap) out.push({ a: j, b: k, d });
          }
        }
      }
      const key = `${gx},${gy}`;
      const list = grid.get(key);
      if (list) list.push(k);
      else grid.set(key, [k]);
    }
    return out;
  }

  /** Union-find clusters (arrays of indices, size >= 2) from index pairs. */
  function clusters(n, pairs) {
    const parent = Array.from({ length: n }, (_, k) => k);
    const find = k => {
      while (parent[k] !== k) {
        parent[k] = parent[parent[k]];
        k = parent[k];
      }
      return k;
    };
    for (const p of pairs) parent[find(p.a)] = find(p.b);
    const groups = new Map();
    for (const p of pairs)
      for (const k of [p.a, p.b]) {
        const r = find(k);
        if (!groups.has(r)) groups.set(r, new Set());
        groups.get(r).add(k);
      }
    return [...groups.values()].map(s => [...s].sort((x, y) => x - y));
  }

  /**
   * Height profile of a river's land cells (cells.h >= 20), source to mouth:
   * {rise, at, from, min}: the largest rise above the lowest height reached so far, the cell
   * where it happens, the lowest cell before it and that height. -1 cells and water are skipped.
   */
  function riverProfile(cellIds, H) {
    let mn = Infinity;
    let mnCell = -1;
    let rise = 0;
    let at = -1;
    let from = -1;
    let lowest = Infinity;
    for (let k = 0; k < cellIds.length; k++) {
      const c = cellIds[k];
      if (!(c >= 0)) continue;
      const h = H[c];
      if (h === undefined || h < 20) continue;
      if (h - mn > rise) {
        rise = h - mn;
        at = c;
        from = mnCell;
        lowest = mn;
      }
      if (h < mn) {
        mn = h;
        mnCell = c;
      }
    }
    return { rise, at, from, min: lowest };
  }

  /**
   * Every land cell of a river (cells.h >= 20, source to mouth) that stands at least tol above the
   * lowest land cell before it: [{cell, rise, min}], plus first (the lowest height before the first
   * of them: one value that fixes all of them). -1 cells and water are skipped.
   */
  function riverRises(cellIds, H, tol) {
    const out = [];
    let mn = Infinity;
    let first = null;
    for (let k = 0; k < cellIds.length; k++) {
      const c = cellIds[k];
      if (!(c >= 0)) continue;
      const h = H[c];
      if (h === undefined || h < 20) continue;
      if (h - mn >= tol) {
        if (first === null) first = mn;
        out.push({ cell: c, rise: h - mn, min: mn });
      }
      if (h < mn) mn = h;
    }
    return { cells: out, first };
  }

  /** First revisit of a cell after other cells in between: {cell, first, again} or null. */
  function riverLoop(cellIds) {
    const seen = new Map();
    for (let k = 0; k < cellIds.length; k++) {
      const c = cellIds[k];
      if (!(c >= 0)) continue;
      if (seen.has(c) && k - seen.get(c) > 1) return { cell: c, first: seen.get(c), again: k };
      seen.set(c, k);
    }
    return null;
  }

  // ---------------------------------------------------------------- context

  function parseArea(a) {
    if (a.bbox !== undefined && a.bbox !== null) {
      if (a.near) fail("BAD_ARGS", "pass bbox or near+radius, not both");
      const b = Array.isArray(a.bbox) ? a.bbox.map(Number) : [];
      if (b.length !== 4 || b.some(v => !Number.isFinite(v))) fail("BAD_ARGS", "bbox is [x0, y0, x1, y1] in map px");
      return { x0: Math.min(b[0], b[2]), y0: Math.min(b[1], b[3]), x1: Math.max(b[0], b[2]), y1: Math.max(b[1], b[3]) };
    }
    if (a.near) {
      const r = Number(a.radius);
      if (!(r > 0)) fail("BAD_ARGS", "near needs a positive radius (map px)");
      const p = T.place(a.near);
      return { cx: p.x, cy: p.y, r };
    }
    if (a.radius !== undefined) fail("BAD_ARGS", "radius needs near");
    return null;
  }

  const inArea = (area, x, y) =>
    area.r !== undefined
      ? Math.hypot(x - area.cx, y - area.cy) <= area.r
      : x >= area.x0 && x <= area.x1 && y >= area.y0 && y <= area.y1;

  function num(v, dflt, lo, hi, name) {
    if (v === undefined || v === null) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) fail("BAD_ARGS", `${name} must be a number in ${lo}..${hi}`);
    return n;
  }

  /** ignore: [{check?, type?, id?}] entries; a row is dropped when one matches it. */
  function parseIgnore(v) {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) fail("BAD_ARGS", "ignore is an array of {check?, type?, id?}");
    return v.map(g => {
      if (!g || typeof g !== "object" || (g.check === undefined && g.type === undefined && g.id === undefined))
        fail("BAD_ARGS", "each ignore entry needs check, type or id");
      if (g.check !== undefined && !DEFS[g.check]) fail("BAD_ARGS", `unknown check '${g.check}' in ignore`);
      return { check: g.check, type: g.type, id: g.id === undefined ? undefined : String(g.id) };
    });
  }

  const ignoredBy = (ig, check, row) =>
    ig.some(g => {
      if (g.check !== undefined && g.check !== check) return false;
      if (g.type === undefined && g.id === undefined) return true;
      return row.e.some(
        t => (g.type === undefined || t[0] === g.type) && (g.id === undefined || String(t[1]) === g.id)
      );
    });

  function makeCtx(a) {
    const C = pack.cells;
    const n = C.p.length;
    const minSev = a.minSeverity ?? "info";
    if (!(minSev in SEV_RANK)) fail("BAD_ARGS", "minSeverity is info | warn | error");
    const cx = {
      a,
      C,
      n,
      gw: graphWidth,
      gh: graphHeight,
      spacing: Math.sqrt((graphWidth * graphHeight) / Math.max(1, n)),
      limit: Math.max(0, Math.min(200, Math.floor(num(a.limit, 20, 0, 200, "limit")))),
      maxRows: Math.max(1, Math.min(1000, Math.floor(num(a.maxRows, 100, 1, 1000, "maxRows")))),
      minRank: SEV_RANK[minSev],
      // An unfiltered overview counts every finding but lists only warn and error rows; naming
      // checks or a minSeverity asks for rows of that severity too.
      rowRank: a.minSeverity === undefined && !(Array.isArray(a.checks) && a.checks.length) ? 1 : SEV_RANK[minSev],
      types: Array.isArray(a.types) && a.types.length ? new Set(a.types) : null,
      area: parseArea(a),
      fixes: a.fixes !== false,
      overlapMin: num(a.overlapMin, 0.15, 0.001, 1, "overlapMin"),
      markerGap: num(a.markerGap, 20, 1, 500, "markerGap"),
      riverTol: num(a.riverTol, 12, 1, 100, "riverTol"),
      atScale: a.atScale === undefined || a.atScale === null ? null : num(a.atScale, 1, 0.1, 100, "atScale"),
      ignore: parseIgnore(a.ignore),
      cellTol: 1.5,
      slots: new Map(),
      skipped: [],
      notes: [],
      claimed: new Set(),
      fixAll: {},
      unlocated: {},
      ignored: 0,
      cellTarget: new Map(),
      memos: {}
    };
    cx.memo = (key, fn) => {
      if (!(key in cx.memos)) cx.memos[key] = fn();
      return cx.memos[key];
    };
    cx.skip = (check, reason) => cx.skipped.push({ check, reason });
    /** Offer a finding; true when it was kept (not dropped by severity, types, area or ignore). */
    cx.emit = (check, row) => {
      const sev = row.sev || DEFS[check].sev;
      if (SEV_RANK[sev] < cx.minRank) return false;
      if (cx.types && !row.e.some(t => cx.types.has(t[0]))) return false;
      if (cx.area && !(row.at && inArea(cx.area, row.at[0], row.at[1]))) {
        // a row with no location cannot be placed inside or outside the area: count it, so the
        // check is not reported as clean
        if (!row.at) cx.unlocated[check] = (cx.unlocated[check] || 0) + 1;
        return false;
      }
      if (cx.ignore.length && ignoredBy(cx.ignore, check, row)) {
        cx.ignored++;
        return false;
      }
      let slot = cx.slots.get(check);
      if (!slot) {
        slot = { n: 0, items: [], kinds: {} };
        cx.slots.set(check, slot);
      }
      slot.n++;
      const kind = row.e[0]?.[0];
      if (kind) slot.kinds[kind] = (slot.kinds[kind] || 0) + 1;
      row.sev = sev;
      if (row.at) row.at = [rn(row.at[0], 1), rn(row.at[1], 1)];
      slot.items.push(row);
      return true;
    };
    return cx;
  }

  const ref = (type, x) => [type, I.idOf(type, x), I.nameOf(type, x)];
  const clip = (s, n = 40) => {
    const t = String(s ?? "");
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const q = s => `"${clip(s)}"`;

  function liveBurgs(cx) {
    return cx.memo("burgs", () => pack.burgs.filter(b => b && typeof b === "object" && b.i && !b.removed));
  }

  function liveStates(cx) {
    return cx.memo("states", () => pack.states.filter(s => s && typeof s === "object" && s.i && !s.removed));
  }

  function liveProvinces(cx) {
    return cx.memo("provinces", () => pack.provinces.filter(p => p && typeof p === "object" && p.i && !p.removed));
  }

  function nearestCellOf(x, y) {
    if (typeof findCell === "function") return findCell(x, y);
    const P = pack.cells.p;
    let best = -1;
    let bd = Infinity;
    for (let c = 0; c < P.length; c++) {
      const d = (P[c][0] - x) ** 2 + (P[c][1] - y) ** 2;
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  /** Breadth-first search over cell neighbours for the nearest cell satisfying pred. */
  function nearestCellWhere(cx, from, pred, maxDepth = 40) {
    const seen = new Set([from]);
    let frontier = [from];
    for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
      const next = [];
      for (const c of frontier) {
        for (const nb of cx.C.c[c] || []) {
          if (seen.has(nb)) continue;
          seen.add(nb);
          if (pred(nb)) return nb;
          next.push(nb);
        }
      }
      frontier = next;
    }
    return null;
  }

  const isLand = (cx, c) => cx.C.h[c] >= 20;
  const freeLand = (cx, c) => isLand(cx, c) && !cx.C.burg[c] && !cx.claimed.has(c);

  const editCall = (type, ops) => ({ tool: "edit", args: { type, ops } });
  const evalCall = (code, redraw) => ({ tool: "eval", args: redraw ? { code, redraw } : { code } });

  // ---------------------------------------------------------------- labels (DOM, map coordinates)

  const checked = id => !!document.getElementById(id)?.checked;

  function domLabels(cx) {
    return cx.memo("domLabels", () => {
      const out = [];
      if (typeof document === "undefined") return out;
      for (const t of document.querySelectorAll("#labels text")) {
        const id = t.id || "";
        let kind = null;
        let id2 = null;
        const ms = /^stateLabel(\d+)$/.exec(id);
        const mb = /^burgLabel(\d+)$/.exec(id);
        if (ms) {
          kind = "state";
          id2 = Number(ms[1]);
        } else if (mb) {
          kind = "burg";
          id2 = Number(mb[1]);
        } else if (id.startsWith("label")) kind = "label";
        else continue;
        out.push({ el: t, id, kind, num: id2, text: (t.textContent || "").replace(/\s+/g, " ").trim() });
      }
      return out;
    });
  }

  /** Axis-aligned box of local-space corner points after the element-to-map matrix. */
  function toMapBox(el, inv, x0, y0, x1, y1) {
    let pts = [
      [x0, y0],
      [x1, y0],
      [x0, y1],
      [x1, y1]
    ];
    if (inv && typeof el.getCTM === "function") {
      const m = el.getCTM();
      if (m) {
        const r = inv.multiply(m);
        pts = pts.map(([x, y]) => [r.a * x + r.c * y + r.e, r.b * x + r.d * y + r.f]);
      }
    }
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  }

  /** Box of an element in map coordinates (the zoomed #viewbox space), or null when not rendered. */
  function mapBox(el, inv) {
    let b;
    try {
      b = el.getBBox();
    } catch {
      return null;
    }
    if (!b || !(b.width > 0 || b.height > 0)) return null;
    return toMapBox(el, inv, b.x, b.y, b.x + b.width, b.y + b.height);
  }

  /**
   * Boxes of runs of glyphs for text on a curved path (a state name along an arc fills only a
   * thin ribbon of its bounding box), or null for straight text. Runs of 3 characters.
   */
  function glyphParts(el, inv) {
    try {
      const tp = el.querySelector("textPath");
      const href = tp && (tp.getAttribute("href") || tp.getAttribute("xlink:href"));
      const path = href && document.getElementById(href.replace(/^#/, ""));
      const d = path ? path.getAttribute("d") || "" : "";
      if (!tp || /^M\s*-?[\d.]+[ ,]-?[\d.]+\s*h\s*-?[\d.]+\s*$/.test(d)) return null;
      const n = el.getNumberOfChars();
      if (!n || n > 160) return null;
      const out = [];
      for (let k = 0; k < n; k += 3) {
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (let j = k; j < Math.min(n, k + 3); j++) {
          const r = el.getExtentOfChar(j);
          if (!(r.width > 0 || r.height > 0)) continue;
          x0 = Math.min(x0, r.x);
          y0 = Math.min(y0, r.y);
          x1 = Math.max(x1, r.x + r.width);
          y1 = Math.max(y1, r.y + r.height);
        }
        if (x1 > x0 && y1 > y0) out.push(toMapBox(el, inv, x0, y0, x1, y1));
      }
      return out.length ? out : null;
    } catch {
      return null;
    }
  }

  /** Inverse of the zoomed #viewbox matrix: maps element space to map coordinates. */
  function viewInverse(cx) {
    return cx.memo("viewInverse", () => {
      try {
        const vb = document.getElementById("viewbox");
        const m = vb && typeof vb.getCTM === "function" ? vb.getCTM() : null;
        return m ? m.inverse() : null;
      } catch {
        return null;
      }
    });
  }

  /**
   * The on-screen size bounds of a label group: the app's 6 / 60 px, or the group's own override
   * that `display {labels}` (bridge-ext/labels.js) writes as data-min-size / data-max-size /
   * data-always-show and the app's zoom handler honours (public/main.js, `tupaia-mcp:` hook).
   */
  function groupBounds(g) {
    const min = parseFloat(g.dataset.minSize);
    const max = parseFloat(g.dataset.maxSize);
    const always = g.dataset.alwaysShow === "1" || g.dataset.alwaysShow === "true";
    return { min: Number.isFinite(min) ? min : 6, max: Number.isFinite(max) ? max : 60, always };
  }

  /**
   * What the app's invokeActiveZooming (public/main.js) does to a label group at zoom S:
   * {size, hidden}, size null when labels do not rescale; null for a group without data-size,
   * which the app leaves as drawn.
   */
  function groupAt(g, S) {
    const desired = +g.dataset.size;
    if (!(desired > 0)) return null;
    const relative = Math.max(rn((desired + desired / S) / 2, 2), 1);
    const b = groupBounds(g);
    return {
      size: checked("rescaleLabels") ? relative : null,
      hidden: checked("hideLabels") && !b.always && (relative * S < b.min || relative * S > b.max)
    };
  }

  /** Label groups (every g under #labels except the #burgLabels wrapper) that hold labels. */
  function labelGroups() {
    return [...document.querySelectorAll("#labels g")].filter(g => g.id !== "burgLabels" && g.querySelector("text"));
  }

  /**
   * Zooms to measure at. atScale pins one. By default: zoom 1, plus for each label group that the
   * hide-labels rule hides at zoom 1 the lowest zoom where it shows (its labels are largest there),
   * so every label is measured at the biggest size anyone sees it at.
   */
  function probeScales(cx) {
    if (cx.atScale !== null) return [cx.atScale];
    const out = new Set([1]);
    if (checked("hideLabels"))
      for (const g of labelGroups()) {
        const desired = +g.dataset.size;
        if (!(desired > 0) || !groupAt(g, 1).hidden) continue;
        // the on-screen size is about desired * (S + 1) / 2: the lower bound is met from 2 * min / desired - 1
        let S = Math.ceil(Math.max(1, (2 * groupBounds(g).min) / desired - 1) * 100) / 100;
        for (let k = 0; k < 400 && groupAt(g, S).hidden; k++) S = rn(S + 0.01, 2);
        if (!groupAt(g, S).hidden) out.add(S);
      }
    return [...out].sort((a, b) => a - b).slice(0, 8);
  }

  /**
   * Pin boxes of the markers at zoom S (the visible 60% of the pin; draw-markers.ts), computed from
   * the marker data as the renderer would draw them, so they are found while the markers layer is off.
   */
  function pinItems(S) {
    const layer = document.getElementById("markers");
    if (!layer) return [];
    const rescale = +layer.getAttribute("rescale");
    const pinnedOnly = +layer.getAttribute("pinned");
    const out = [];
    for (const m of I.liveList("marker")) {
      if (m.hidden || (pinnedOnly && !m.pinned) || !Number.isFinite(m.x) || !Number.isFinite(m.y)) continue;
      const size = m.size ?? 30;
      const zs = rescale ? Math.max(rn(size / 5 + 24 / S, 2), 1) : size;
      out.push({
        kind: "pin",
        id: `marker${m.i}`,
        text: m.type || `marker ${m.i}`,
        marker: m,
        box: { x0: m.x - zs * 0.3, y0: m.y - zs, x1: m.x + zs * 0.3, y1: m.y },
        e: ref("marker", m)
      });
    }
    return out;
  }

  /** Label items {kind, id, num, text, el, box, parts?, e} of every shown label at zoom S. */
  function measureAt(cx, S) {
    const inv = viewInverse(cx);
    const saved = [];
    const shown = new Set();
    const items = [];
    let hidden = 0;
    try {
      for (const g of labelGroups()) {
        const z = groupAt(g, S);
        const was = g.classList.contains("hidden");
        if (z ? z.hidden : was) {
          hidden += g.querySelectorAll("text").length;
          continue;
        }
        saved.push([g, g.getAttribute("font-size"), was]);
        if (z && z.size !== null) g.setAttribute("font-size", z.size);
        if (was) g.classList.remove("hidden");
        shown.add(g);
      }
      for (const d of domLabels(cx)) {
        const g = d.el.closest("g");
        if (!g || !shown.has(g) || d.el.style.display === "none") continue;
        const box = mapBox(d.el, inv);
        if (!box) continue;
        let e;
        if (d.kind === "state") e = ["state", d.num, pack.states[d.num]?.name ?? d.text];
        else if (d.kind === "burg") e = ["burg", d.num, pack.burgs[d.num]?.name ?? d.text];
        else e = ["label", d.id, d.text];
        const parts = glyphParts(d.el, inv);
        items.push(parts ? { ...d, box, e, parts } : { ...d, box, e });
      }
    } finally {
      for (const [g, fs, was] of saved) {
        if (fs === null) g.removeAttribute("font-size");
        else g.setAttribute("font-size", fs);
        if (was) g.classList.add("hidden");
      }
    }
    return { scale: S, items, hidden };
  }

  /** Measured labels per probe zoom: {probes:[{scale, items, hidden}]}, or {reason} when they cannot be measured. */
  function labelItems(cx) {
    return cx.memo("labelItems", () => {
      const res = { probes: [], reason: null };
      if (typeof document === "undefined") {
        res.reason = "no page DOM";
        return res;
      }
      const root = document.getElementById("labels");
      if (!root) {
        res.reason = "the page has no #labels group";
        return res;
      }
      if (!domLabels(cx).length) {
        // nothing to draw: the checks are trivially clean
        if (!liveBurgs(cx).length && !liveStates(cx).length) return res;
        res.reason =
          "no label elements are drawn (map saved without labels); eval {code:'1', readOnly:true, redraw:['labels']} draws them";
        return res;
      }
      if (getComputedStyle(root).display === "none") {
        res.reason = "the labels layer is off; turn it on first (display {on:['labels']})";
        return res;
      }
      const scales = probeScales(cx);
      for (const S of scales) res.probes.push(measureAt(cx, S));
      const total = domLabels(cx).length;
      const seen = new Set();
      for (const p of res.probes) for (const it of p.items) seen.add(it.id);
      const unseen = total - seen.size;
      const at = scales.map(s => rn(s, 2)).join(", ");
      cx.notes.push(
        cx.atScale !== null
          ? `labels measured at zoom ${at}${unseen ? ` (${unseen} of ${total} labels are hidden by the hide-labels rule at that zoom)` : ""}`
          : scales.length === 1
            ? `labels measured at zoom 1${unseen ? ` (${unseen} of ${total} never show)` : ""}`
            : `labels measured at zoom ${at}: label size follows the zoom rule, so each group is measured at the lowest zoom where it shows${unseen ? ` (${unseen} of ${total} never show)` : ""}; atScale pins one zoom`
      );
      return res;
    });
  }

  /** edit label move call that shifts a custom label by (dx, dy), or {hint} for curved paths. */
  function labelShift(cx, it, dx, dy) {
    if (it.kind !== "label")
      return {
        hint:
          it.kind === "state"
            ? `state labels have no move tool: shorten the state name (edit state name) or rewrite textPath_${it.id} with eval`
            : "burg labels follow their burg: move the burg (edit burg move) or shorten its name"
      };
    const d = document.getElementById(`textPath_${it.id}`)?.getAttribute("d") || "";
    const m = /^M\s*(-?[\d.]+)[ ,](-?[\d.]+)\s*h\s*(-?[\d.]+)\s*$/.exec(d);
    if (!m)
      return {
        hint: `label ${it.id} follows a curved path (edit label move takes straight labels only): edit {type:'label', ops:[{ref:'${it.id}', remove:true}]} then add a straight one, rewrite textPath_${it.id} with eval, or accept it with lint ignore:[{check:'label-overlap', type:'label', id:'${it.id}'}]`
      };
    const x = Math.max(0, Math.min(cx.gw, Number(m[1]) + Number(m[3]) / 2 + dx));
    const y = Math.max(0, Math.min(cx.gh, Number(m[2]) + dy));
    return editCall("label", [{ ref: it.id, set: { move: { x: rn(x, 1), y: rn(y, 1) } } }]);
  }

  const KIND_NAME = { state: "state label", burg: "burg label", label: "custom label" };

  /** Same text after folding, or a near repeat (one or two letters apart, e.g. a misspelt copy). */
  function sameText(a, b) {
    const x = fold(String(a || "").trim());
    const y = fold(String(b || "").trim());
    if (!x || !y) return false;
    if (x === y) return true;
    if (Math.min(x.length, y.length) < 5 || Math.abs(x.length - y.length) > 2) return false;
    // Levenshtein distance <= 2
    let prev = Array.from({ length: y.length + 1 }, (_, k) => k);
    for (let i = 1; i <= x.length; i++) {
      const cur = [i];
      for (let j = 1; j <= y.length; j++)
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[y.length] <= 2;
  }
  const atZoom = (cx, S) => (S !== 1 || cx.atScale !== null ? `, at zoom ${rn(S, 2)}` : "");

  function checkLabelOffcanvas(cx) {
    const li = labelItems(cx);
    if (li.reason) return cx.skip("label-offcanvas", li.reason);
    const tol = 2; // a sliver this thin is not worth a row
    const worst = new Map();
    for (const p of li.probes)
      for (const it of p.items) {
        const b = it.box;
        const left = Math.max(0, -b.x0);
        const top = Math.max(0, -b.y0);
        const right = Math.max(0, b.x1 - cx.gw);
        const bottom = Math.max(0, b.y1 - cx.gh);
        if (left <= tol && top <= tol && right <= tol && bottom <= tol) continue;
        const w = b.x1 - b.x0;
        const h = b.y1 - b.y0;
        const inter =
          Math.max(0, Math.min(b.x1, cx.gw) - Math.max(b.x0, 0)) *
          Math.max(0, Math.min(b.y1, cx.gh) - Math.max(b.y0, 0));
        const outFrac = w * h > 0 ? 1 - inter / (w * h) : 1;
        const old = worst.get(it.id);
        if (!old || outFrac > old.outFrac) worst.set(it.id, { it, b, left, top, right, bottom, outFrac, S: p.scale });
      }
    for (const { it, b, left, top, right, bottom, outFrac, S } of worst.values()) {
      const sides = [
        left > tol ? `left ${rn(left, 0)}` : null,
        top > tol ? `top ${rn(top, 0)}` : null,
        right > tol ? `right ${rn(right, 0)}` : null,
        bottom > tol ? `bottom ${rn(bottom, 0)}` : null
      ].filter(Boolean);
      const dx = left > tol ? left + 2 : right > tol ? -(right + 2) : 0;
      const dy = top > tol ? top + 2 : bottom > tol ? -(bottom + 2) : 0;
      cx.emit("label-offcanvas", {
        sev: outFrac >= 0.5 ? "error" : "warn",
        e: [it.e],
        at: [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2],
        msg: `${KIND_NAME[it.kind]} ${q(it.text)} sticks out of the map by ${sides.join(", ")} px (${Math.round(outFrac * 100)}% outside${atZoom(cx, S)})`,
        score: outFrac,
        fix: () => labelShift(cx, it, dx, dy)
      });
    }
  }

  /** The label-label and label-pin overlaps over all probe zooms, one entry per pair (the worst zoom). */
  function labelPairs(cx) {
    return cx.memo("labelPairs", () => {
      const li = labelItems(cx);
      const labelPairsOut = new Map();
      const pinPairsOut = new Map();
      const wantPins = cx.wants?.pins;
      if (wantPins && li.probes.length && typeof layerIsOn === "function" && !layerIsOn("toggleMarkers"))
        cx.notes.push("the markers layer is off: pins were measured as they would draw");
      for (const p of li.probes) {
        const items = wantPins ? [...p.items, ...pinItems(p.scale)] : p.items;
        for (const pr of overlapPairs(items, 0.02)) {
          const A = items[pr.a];
          const B = items[pr.b];
          const pinSide = A.kind === "pin" ? A : B.kind === "pin" ? B : null;
          if (pinSide) {
            const other = pinSide === A ? B : A;
            if (other.kind === "pin") continue; // pin against pin is marker-stacked's business
            const frac = pr.inter / (other === A ? pr.areaA : pr.areaB); // share of the label that is covered
            if (frac < cx.overlapMin) continue;
            const key = `${other.id}|${pinSide.id}`;
            const old = pinPairsOut.get(key);
            if (!old || frac > old.frac) pinPairsOut.set(key, { label: other, pin: pinSide, frac, p: pr, S: p.scale });
          } else {
            if (pr.frac < cx.overlapMin) continue;
            const key = A.id < B.id ? `${A.id}|${B.id}` : `${B.id}|${A.id}`;
            const old = labelPairsOut.get(key);
            if (!old || pr.frac > old.frac) labelPairsOut.set(key, { A, B, frac: pr.frac, p: pr, S: p.scale });
          }
        }
      }
      return { labels: [...labelPairsOut.values()], pins: [...pinPairsOut.values()] };
    });
  }

  function checkLabelOverlap(cx) {
    const li = labelItems(cx);
    if (li.reason) return cx.skip("label-overlap", li.reason);
    for (const { A, B, frac, p, S } of labelPairs(cx).labels) {
      // a state name runs in an arc across its land and so over burg labels by design: info only
      const stateOverBurg = (A.kind === "state" && B.kind === "burg") || (A.kind === "burg" && B.kind === "state");
      // a custom label that repeats (or nearly repeats) the burg or state label under it
      const custom = A.kind === "label" && B.kind !== "label" ? A : B.kind === "label" && A.kind !== "label" ? B : null;
      const twin = custom ? (custom === A ? B : A) : null;
      const dup = !!custom && sameText(custom.text, twin.text);
      cx.emit("label-overlap", {
        sev: frac >= 0.5 && !stateOverBurg ? "warn" : "info",
        e: [A.e, B.e],
        at: [p.ix + p.ox / 2, p.iy + p.oy / 2],
        msg: dup
          ? `custom label ${q(custom.text)} duplicates the ${KIND_NAME[twin.kind]} ${q(twin.text)} under it (${Math.round(frac * 100)}% overlap${atZoom(cx, S)})`
          : `${KIND_NAME[A.kind]} ${q(A.text)} overlaps ${KIND_NAME[B.kind]} ${q(B.text)} (${Math.round(frac * 100)}% of the smaller${atZoom(cx, S)})`,
        score: frac,
        fix: () => {
          if (dup)
            return {
              ...editCall("label", [{ ref: custom.id, remove: true }]),
              note: `removes the custom label: the ${KIND_NAME[twin.kind]} already shows the name (or keep it: lint ignore:[{check:'label-overlap', type:'label', id:'${custom.id}'}])`
            };
          // move a custom label out along the thinner overlap axis
          const mover = A.kind === "label" ? A : B.kind === "label" ? B : null;
          if (!mover) return { hint: "neither is a custom label: shorten a name or move a burg" };
          const other = mover === A ? B : A;
          const mx = (mover.box.x0 + mover.box.x1) / 2;
          const my = (mover.box.y0 + mover.box.y1) / 2;
          const ox = (other.box.x0 + other.box.x1) / 2;
          const oy = (other.box.y0 + other.box.y1) / 2;
          if (p.ox < p.oy) return labelShift(cx, mover, (mx >= ox ? 1 : -1) * (p.ox + 2), 0);
          return labelShift(cx, mover, 0, (my >= oy ? 1 : -1) * (p.oy + 2));
        }
      });
    }
  }

  function checkLabelMarkerOverlap(cx) {
    const li = labelItems(cx);
    if (li.reason) return cx.skip("label-marker-overlap", li.reason);
    for (const { label, pin, frac, p, S } of labelPairs(cx).pins) {
      cx.emit("label-marker-overlap", {
        sev: frac >= 0.5 ? "warn" : "info",
        e: [label.e, pin.e],
        at: [p.ix + p.ox / 2, p.iy + p.oy / 2],
        msg: `marker ${pin.marker.i} (${pin.marker.type || "no type"}) covers ${Math.round(frac * 100)}% of ${KIND_NAME[label.kind]} ${q(label.text)}${atZoom(cx, S)}`,
        score: frac,
        fix: () => {
          // nudge the pin out along the thinner overlap axis
          const m = pin.marker;
          const px = (pin.box.x0 + pin.box.x1) / 2;
          const py = (pin.box.y0 + pin.box.y1) / 2;
          const lx = (label.box.x0 + label.box.x1) / 2;
          const ly = (label.box.y0 + label.box.y1) / 2;
          const dx = p.ox < p.oy ? (px >= lx ? 1 : -1) * (p.ox + 2) : 0;
          const dy = p.ox < p.oy ? 0 : (py >= ly ? 1 : -1) * (p.oy + 2);
          const x = Math.max(0, Math.min(cx.gw, m.x + dx));
          const y = Math.max(0, Math.min(cx.gh, m.y + dy));
          return editCall("marker", [{ ref: m.i, set: { move: { x: rn(x, 1), y: rn(y, 1) } } }]);
        }
      });
    }
  }

  function checkLabelOrphan(cx) {
    for (const d of domLabels(cx)) {
      if (d.kind === "state") {
        const s = pack.states[d.num];
        if (!s || s.removed || !s.i)
          cx.emit("label-orphan", {
            e: [["state", d.num, d.text]],
            at: labelCenter(cx, d),
            msg: `state label ${q(d.text)} belongs to ${s?.removed ? "removed " : "missing "}state ${d.num}`,
            fix: () =>
              evalCall(
                `document.getElementById('${d.id}')?.remove(); document.getElementById('textPath_${d.id}')?.remove(); return 'removed'`
              )
          });
      } else if (d.kind === "burg") {
        const b = pack.burgs[d.num];
        if (!b || b.removed || !b.i)
          cx.emit("label-orphan", {
            e: [["burg", d.num, d.text]],
            at: labelCenter(cx, d),
            msg: `burg label ${q(d.text)} belongs to ${b?.removed ? "removed " : "missing "}burg ${d.num}`,
            fix: () => evalCall(`document.getElementById('${d.id}')?.remove(); return 'removed'`)
          });
      }
    }
  }

  /** Where a label is: its box when it is rendered, else the burg's place or the start of its path. */
  function labelCenter(cx, d) {
    const b = mapBox(d.el, viewInverse(cx));
    if (b) return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
    const burg = d.kind === "burg" ? pack.burgs[d.num] : null;
    if (burg && Number.isFinite(burg.x)) return [burg.x, burg.y];
    const tp = d.el.querySelector("textPath");
    const href = tp && (tp.getAttribute("href") || tp.getAttribute("xlink:href"));
    const m = /^M\s*(-?[\d.]+)[ ,](-?[\d.]+)/.exec(
      (href && document.getElementById(href.replace(/^#/, ""))?.getAttribute("d")) || ""
    );
    return m ? [Number(m[1]), Number(m[2])] : null;
  }

  // ---------------------------------------------------------------- markers

  function markerPos(cx, m) {
    if (Number.isFinite(m.x) && Number.isFinite(m.y)) return { x: m.x, y: m.y };
    const p = cx.C.p[m.cell];
    return p ? { x: p[0], y: p[1] } : null;
  }

  function checkMarkerStacked(cx) {
    const ms = I.liveList("marker").filter(m => !m.hidden);
    const pts = [];
    const owners = [];
    for (const m of ms) {
      const p = markerPos(cx, m);
      if (!p) continue;
      pts.push(p);
      owners.push(m);
    }
    const pairs = closePairs(pts, cx.markerGap);
    // markers sharing a cell count even when farther apart than the gap
    const byCell = new Map();
    owners.forEach((m, k) => {
      if (!Number.isInteger(m.cell)) return;
      if (!byCell.has(m.cell)) byCell.set(m.cell, []);
      byCell.get(m.cell).push(k);
    });
    const have = new Set(pairs.map(p => `${p.a},${p.b}`));
    for (const list of byCell.values())
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const a = Math.min(list[i], list[j]);
          const b = Math.max(list[i], list[j]);
          if (!have.has(`${a},${b}`)) {
            have.add(`${a},${b}`);
            pairs.push({ a, b, d: Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y) });
          }
        }
    for (const grp of clusters(owners.length, pairs)) {
      const members = grp.map(k => owners[k]);
      const _first = members[0];
      let minD = Infinity;
      for (const p of pairs) if (grp.includes(p.a) && grp.includes(p.b)) minD = Math.min(minD, p.d);
      const names = members
        .slice(0, 4)
        .map(m => `${m.i} (${m.type})`)
        .join(", ");
      cx.emit("marker-stacked", {
        e: members.slice(0, 6).map(m => ref("marker", m)),
        at: [pts[grp[0]].x, pts[grp[0]].y],
        msg: `${members.length} markers within ${cx.markerGap} px of each other (closest ${rn(Math.max(minD, 0), 1)} px): ${names}${members.length > 4 ? ", ..." : ""}`,
        score: cx.markerGap - minD + members.length,
        fix: () =>
          spreadMarkers(
            cx,
            grp.map(k => ({ m: owners[k], p: pts[k] }))
          )
      });
    }
  }

  /** Move every marker but the first to a free spot at least markerGap from the placed ones. */
  function spreadMarkers(cx, group) {
    const placed = [group[0].p];
    const ops = [];
    const gap = cx.markerGap + 2;
    for (const { m, p } of group.slice(1)) {
      let spot = null;
      const wantWater = WATER_MARKERS.has(m.type) || (!LAND_MARKERS.has(m.type) && WATERISH.test(m.type || ""));
      for (let ring = 1; ring <= 4 && !spot; ring++) {
        const r = gap * ring;
        const start = Math.atan2(p.y - group[0].p.y, p.x - group[0].p.x) || 0;
        for (let k = 0; k < 12 && !spot; k++) {
          const ang = start + (k * Math.PI) / 6;
          const x = group[0].p.x + Math.cos(ang) * r;
          const y = group[0].p.y + Math.sin(ang) * r;
          if (x < 0 || y < 0 || x > cx.gw || y > cx.gh) continue;
          if (placed.some(o => Math.hypot(o.x - x, o.y - y) < cx.markerGap)) continue;
          const c = nearestCellOf(x, y);
          if (c < 0 || isLand(cx, c) === wantWater) continue;
          spot = { x, y };
        }
      }
      if (!spot) return { hint: "no free spot of the right kind within 4 rings: move markers by hand" };
      placed.push(spot);
      ops.push({ ref: m.i, set: { move: { x: rn(spot.x, 1), y: rn(spot.y, 1) } } });
    }
    return editCall("marker", ops);
  }

  /**
   * The cell a thing at (x, y) is really in: its recorded cell while that still fits the
   * coordinates, else the cell there. A recorded cell goes stale when cell ids change (a height
   * rebuild, a regrid), but coordinates jitter inside a cell, so a point at a coast can be nearer a
   * neighbour of its own cell.
   */
  function cellAt(cx, p, recorded) {
    if (p && cellMatches(cx, p.x, p.y, recorded)) return recorded;
    if (p) return nearestCellOf(p.x, p.y);
    return Number.isInteger(recorded) && recorded >= 0 && recorded < cx.n ? recorded : -1;
  }

  /** Does the recorded cell still describe the point (x, y)? Same cell, a neighbour of the cell there, or close to its centre. */
  function cellMatches(cx, x, y, recorded) {
    if (!Number.isInteger(recorded) || recorded < 0 || recorded >= cx.n) return false;
    const cp = cx.C.p[recorded];
    if (Math.hypot(x - cp[0], y - cp[1]) <= cx.cellTol * cx.spacing) return true;
    const nearest = nearestCellOf(x, y);
    return nearest === recorded || (cx.C.c[nearest] || []).includes(recorded);
  }

  function checkMarkerInWater(cx) {
    for (const m of I.liveList("marker")) {
      const p = markerPos(cx, m);
      const c = cellAt(cx, p, m.cell);
      if (c < 0 || isLand(cx, c)) continue;
      const type = m.type || "";
      if (WATER_MARKERS.has(type)) continue;
      const known = LAND_MARKERS.has(type);
      if (!known && WATERISH.test(type)) continue;
      cx.emit("marker-in-water", {
        sev: known ? "error" : "warn",
        e: [ref("marker", m)],
        at: p ? [p.x, p.y] : null,
        msg: `${known ? "land-only " : ""}marker ${m.i} (${type || "no type"}) is on a water cell (${c}, height ${cx.C.h[c]})`,
        fix: () => {
          const land = nearestCellWhere(cx, c, k => isLand(cx, k));
          return land === null
            ? { hint: "no land within 40 cells; remove the marker or repaint land under it" }
            : editCall("marker", [{ ref: m.i, set: { move: { cell: land } } }]);
        }
      });
    }
  }

  function checkMarkerCellLink(cx) {
    const kept = [];
    let total = 0;
    for (const m of I.liveList("marker")) {
      const p = markerPos(cx, m);
      if (!p || cellMatches(cx, p.x, p.y, m.cell)) continue;
      total++;
      const real = nearestCellOf(p.x, p.y);
      const ok = cx.emit("marker-cell-link", {
        e: [ref("marker", m)],
        at: [p.x, p.y],
        msg: `marker ${m.i} (${m.type || "no type"}) records cell ${m.cell}, but its coordinates fall in cell ${real}`,
        fix: () =>
          evalCall(`const m = pack.markers.find(m => m.i === ${m.i}); m.cell = findCell(m.x, m.y); return m.cell`)
      });
      if (ok) kept.push(m.i);
    }
    if (kept.length > 1)
      cx.fixAll["marker-cell-link"] = evalCall(
        `const ids = ${kept.length < total ? `new Set(${JSON.stringify(kept)})` : "null"}; let n = 0; for (const m of pack.markers) { if (ids && !ids.has(m.i)) continue; const c = findCell(m.x, m.y); if (m.cell !== c && !pack.cells.c[c].includes(m.cell)) { m.cell = c; n++; } } return n`
      );
  }

  /** Markers on top of burgs: within markerGap px of one, or in its cell. Opt-in (generated maps have many). */
  function checkMarkerNearBurg(cx) {
    const burgs = liveBurgs(cx);
    const byCell = burgsByCell(cx);
    const pts = burgs.map(b => ({ x: b.x, y: b.y }));
    const mk = I.liveList("marker").filter(m => !m.hidden && markerPos(cx, m));
    const all = [...pts, ...mk.map(m => markerPos(cx, m))];
    const nb = burgs.length;
    const hits = new Map(); // marker index -> [{b, d}]
    for (const pr of closePairs(all, cx.markerGap)) {
      const lo = Math.min(pr.a, pr.b);
      const hi = Math.max(pr.a, pr.b);
      if (!(lo < nb && hi >= nb)) continue; // one burg, one marker
      const k = hi - nb;
      if (!hits.has(k)) hits.set(k, []);
      hits.get(k).push({ b: burgs[lo], d: pr.d });
    }
    mk.forEach((m, k) => {
      if (Number.isInteger(m.cell))
        for (const b of byCell.get(m.cell) || []) {
          if (!hits.has(k)) hits.set(k, []);
          if (!hits.get(k).some(h => h.b === b)) {
            const p = markerPos(cx, m);
            hits.get(k).push({ b, d: Math.hypot(b.x - p.x, b.y - p.y) });
          }
        }
    });
    for (const [k, list] of hits) {
      const m = mk[k];
      const p = markerPos(cx, m);
      list.sort((x, y) => x.d - y.d);
      const near = list[0];
      const sameCell = near.b.cell === m.cell;
      cx.emit("marker-near-burg", {
        sev: near.d < 8 || sameCell ? "warn" : "info",
        e: [ref("marker", m), ref("burg", near.b)],
        at: [p.x, p.y],
        msg: `marker ${m.i} (${m.type || "no type"}) is ${rn(near.d, 1)} px from ${near.b.name}${sameCell ? " (same cell)" : ""}${list.length > 1 ? `, and ${list.length - 1} more burg(s)` : ""}`,
        score: cx.markerGap - near.d,
        fix: () => {
          const spot = freeSpotAround(cx, near.b, m);
          return spot
            ? editCall("marker", [{ ref: m.i, set: { move: spot } }])
            : { hint: "no free spot of the right kind near it: move the marker by hand" };
        }
      });
    }
  }

  /** A spot at least markerGap px from every burg and other marker, around `centre`, on the kind of cell marker m needs. */
  function freeSpotAround(cx, centre, m) {
    const gap = cx.markerGap + 2;
    const wantWater = WATER_MARKERS.has(m.type) || (!LAND_MARKERS.has(m.type) && WATERISH.test(m.type || ""));
    const avoid = [
      ...liveBurgs(cx).map(b => ({ x: b.x, y: b.y })),
      ...I.liveList("marker")
        .filter(o => o !== m)
        .map(o => markerPos(cx, o))
        .filter(Boolean)
    ];
    for (let ring = 1; ring <= 4; ring++)
      for (let k = 0; k < 12; k++) {
        const ang = (k * Math.PI) / 6;
        const x = centre.x + Math.cos(ang) * gap * ring;
        const y = centre.y + Math.sin(ang) * gap * ring;
        if (x < 0 || y < 0 || x > cx.gw || y > cx.gh) continue;
        if (avoid.some(o => Math.hypot(o.x - x, o.y - y) < cx.markerGap)) continue;
        const c = nearestCellOf(x, y);
        if (c < 0 || isLand(cx, c) === wantWater) continue;
        return { x: rn(x, 1), y: rn(y, 1) };
      }
    return null;
  }

  // ---------------------------------------------------------------- burgs

  /**
   * Move op for a burg: the nearest free land cell of its own state (a moved burg takes the state
   * of the cell it lands in), else, for a non-capital, the nearest free land cell anywhere, which
   * changes its state (reported as note). A locked burg gets a hint instead.
   */
  function moveBurgOps(cx, b) {
    if (b.lock) return { hint: `${b.name} is locked: unlock it (edit burg set lock:false) before moving it` };
    let target = nearestCellWhere(cx, b.cell, c => freeLand(cx, c) && cx.C.state[c] === b.state);
    let note = null;
    if (target === null && !b.capital) {
      target = nearestCellWhere(cx, b.cell, c => freeLand(cx, c));
      if (target !== null) {
        const to = pack.states[cx.C.state[target]];
        note = `${b.name} has no free land cell in its own state nearby, so the fix moves it into ${to ? to.name : "no state"} (its state changes)`;
      }
    }
    if (target === null) return null;
    cx.claimed.add(target);
    return { op: { ref: b.i, set: { move: { cell: target } } }, note };
  }

  function checkBurgInWater(cx) {
    const C = cx.C;
    for (const b of liveBurgs(cx)) {
      const h = C.h[b.cell];
      if (h === undefined || h >= 20) continue;
      const f = pack.features[C.f[b.cell]];
      const where = f?.type === "lake" ? `lake ${f.name || f.i}` : "open water";
      cx.emit("burg-in-water", {
        e: [ref("burg", b)],
        at: [b.x, b.y],
        msg: `${b.name} sits in ${where} (cell ${b.cell}, height ${h})`,
        score: 20 - h,
        fix: () => {
          const m = moveBurgOps(cx, b);
          if (!m) return { hint: "no free land cell nearby: remove the burg (edit burg remove)" };
          if (m.hint) return m;
          return { ...editCall("burg", [m.op]), ...(m.note ? { note: m.note } : {}) };
        }
      });
    }
  }

  /** Live burgs grouped by their recorded cell (the owner of cells.burg first, then locked, then the biggest). */
  function burgsByCell(cx) {
    return cx.memo("burgsByCell", () => {
      const byCell = new Map();
      for (const b of liveBurgs(cx)) {
        if (!byCell.has(b.cell)) byCell.set(b.cell, []);
        byCell.get(b.cell).push(b);
      }
      for (const [cell, list] of byCell) {
        const owner = cx.C.burg ? cx.C.burg[cell] : 0;
        list.sort(
          (x, y) =>
            (y.i === owner) - (x.i === owner) ||
            !!y.lock - !!x.lock ||
            !!y.capital - !!x.capital ||
            (y.population || 0) - (x.population || 0)
        );
      }
      return byCell;
    });
  }

  function checkBurgSharedCell(cx) {
    for (const [cell, list] of burgsByCell(cx)) {
      if (list.length < 2) continue;
      cx.emit("burg-shared-cell", {
        e: list.slice(0, 6).map(b => ref("burg", b)),
        at: [list[0].x, list[0].y],
        msg: `${list.length} burgs share cell ${cell}: ${list
          .slice(0, 4)
          .map(b => `${b.name} (${b.i})`)
          .join(", ")}`,
        score: list.length,
        fix: () => {
          const moves = list.slice(1).map(b => ({ b, m: moveBurgOps(cx, b) }));
          const ops = moves.filter(x => x.m?.op);
          if (!ops.length) {
            const locked = moves.find(x => x.m?.hint);
            return { hint: locked ? locked.m.hint : "no free land cell nearby: remove the extra burgs" };
          }
          const notes = moves.map(x => x.m?.note || x.m?.hint).filter(Boolean);
          return {
            ...editCall(
              "burg",
              ops.map(x => x.m.op)
            ),
            ...(notes.length ? { note: notes.join("; ") } : {})
          };
        }
      });
    }
  }

  function checkBurgCellLink(cx) {
    const C = cx.C;
    if (!C.burg) return;
    const byCell = burgsByCell(cx);
    const shared = { has: cell => (byCell.get(cell)?.length || 0) > 1 };
    for (const b of liveBurgs(cx)) {
      if (!Number.isInteger(b.cell) || b.cell < 0 || b.cell >= cx.n) {
        cx.emit("burg-cell-link", {
          e: [ref("burg", b)],
          at: Number.isFinite(b.x) ? [b.x, b.y] : null,
          msg: `${b.name} has an invalid cell (${b.cell})`
        });
        continue;
      }
      if (Number.isFinite(b.x) && Number.isFinite(b.y) && !cellMatches(cx, b.x, b.y, b.cell)) {
        const real = nearestCellOf(b.x, b.y);
        cx.emit("burg-cell-link", {
          e: [ref("burg", b)],
          at: [b.x, b.y],
          msg: `${b.name} (${b.i}) records cell ${b.cell}, but its coordinates fall in cell ${real}`,
          fix: () =>
            freeLand(cx, real)
              ? editCall("burg", [{ ref: b.i, set: { move: { cell: real } } }])
              : { hint: `cell ${real} is not a free land cell: move the burg with edit burg move` }
        });
        continue;
      }
      if (C.burg[b.cell] === b.i || shared.has(b.cell)) continue;
      cx.emit("burg-cell-link", {
        e: [ref("burg", b)],
        at: [b.x, b.y],
        msg: `${b.name} (${b.i}) is in cell ${b.cell}, but cells.burg there holds ${C.burg[b.cell] || "nothing"}`,
        fix: () => evalCall(`pack.cells.burg[${b.cell}] = ${b.i}; return ${b.i}`)
      });
    }
    for (let c = 0; c < C.burg.length; c++) {
      const id = C.burg[c];
      if (!id) continue;
      const b = pack.burgs[id];
      if (b && !b.removed && b.cell === c) continue;
      if (b && !b.removed && shared.has(b.cell)) continue;
      const p = C.p[c];
      cx.emit("burg-cell-link", {
        e: [["burg", id, b?.name ?? null]],
        at: p ? [p[0], p[1]] : null,
        msg: `cells.burg[${c}] holds ${b?.removed ? "removed " : b ? "" : "missing "}burg ${id}${b && !b.removed ? ` whose cell is ${b.cell}` : ""}`,
        fix: () => evalCall(`pack.cells.burg[${c}] = 0; return 0`)
      });
    }
  }

  function checkCapitalOutside(cx) {
    const C = cx.C;
    for (const s of liveStates(cx)) {
      const b = pack.burgs[s.capital];
      let msg = null;
      const burgless = !s.capital || !b || b.removed ? !liveBurgs(cx).some(x => x.state === s.i) : false;
      if (!s.capital || !b || b.removed)
        msg = `${s.name} has no live capital (capital ${s.capital || "unset"})${burgless ? " and no burg" : ""}`;
      else if (C.state[b.cell] !== s.i) {
        const other = pack.states[C.state[b.cell]];
        msg = `capital ${b.name} (${b.i}) of ${s.name} lies in ${other ? other.name : "no state"} (cell ${b.cell})`;
      }
      if (!msg) continue;
      const at = b && Number.isFinite(b.x) ? [b.x, b.y] : s.pole ? [s.pole[0], s.pole[1]] : null;
      cx.emit("capital-outside", {
        e: b && !b.removed ? [ref("state", s), ref("burg", b)] : [ref("state", s)],
        at,
        msg,
        // a hand-made state left without burgs on purpose is a warning, not an error
        ...(burgless ? { sev: "warn" } : {}),
        fix: () => {
          const alt = liveBurgs(cx)
            .filter(x => x.state === s.i && C.state[x.cell] === s.i && (!b || x.i !== b.i))
            .sort((x, y) => (y.population || 0) - (x.population || 0))[0];
          if (alt) return editCall("state", [{ ref: s.i, set: { capital: alt.i } }]);
          if (b && !b.removed) {
            let best = -1;
            let bd = Infinity;
            for (let c = 0; c < cx.n; c++) {
              if (C.state[c] !== s.i || !freeLand(cx, c)) continue;
              const d = (C.p[c][0] - b.x) ** 2 + (C.p[c][1] - b.y) ** 2;
              if (d < bd) {
                bd = d;
                best = c;
              }
            }
            if (best >= 0) return editCall("burg", [{ ref: b.i, set: { move: { cell: best } } }]);
          }
          if (burgless)
            return {
              hint: `the state has no burg: add one inside it (add {type:'burg', items:[{at}]}), then edit {type:'state', ops:[{ref:${s.i}, set:{capital:<burg>}}]}; a state meant to have no burgs: lint ignore:[{check:'capital-outside', type:'state', id:${s.i}}]`
            };
          return {
            hint: "no burg of the state lies inside it and it has no free land cell: add a burg inside it (add burg), then edit state capital"
          };
        }
      });
    }
  }

  /** Cell counts per province id and per state id. */
  function regionCells(cx) {
    return cx.memo("regionCells", () => {
      const C = cx.C;
      const provCells = new Map();
      const stateCells = new Map();
      for (let c = 0; c < cx.n; c++) {
        const p = C.province ? C.province[c] : 0;
        if (p) provCells.set(p, (provCells.get(p) || 0) + 1);
        const s = C.state[c];
        if (s) stateCells.set(s, (stateCells.get(s) || 0) + 1);
      }
      return { provCells, stateCells };
    });
  }

  function checkProvinceEmpty(cx) {
    const { provCells } = regionCells(cx);
    for (const p of liveProvinces(cx)) {
      if (provCells.get(p.i)) continue;
      const at = p.pole ? p.pole : cx.C.p[p.center];
      cx.emit("province-empty", {
        e: [ref("province", p)],
        at: at ? [at[0], at[1]] : null,
        msg: `province ${q(p.name)} (${p.i}) has no cells`,
        // what the provinces editor's removeProvince does, minus its dialog and fog
        fix: () =>
          evalCall(
            `const p = ${p.i}; const s = pack.states[pack.provinces[p].state]; if (s?.provinces) s.provinces = s.provinces.filter(x => x !== p); document.getElementById('province' + p)?.remove(); document.getElementById('province-gap' + p)?.remove(); document.getElementById('provinceCOA' + p)?.remove(); document.querySelector("#emblems #provinceEmblems > use[data-i='" + p + "']")?.remove(); pack.provinces[p] = { i: p, removed: true }; return p`,
            ["borders", "provinces"]
          )
      });
    }
  }

  function checkStateEmpty(cx) {
    const { stateCells } = regionCells(cx);
    for (const s of liveStates(cx)) {
      if (stateCells.get(s.i)) continue;
      const at = s.pole ? s.pole : cx.C.p[s.center];
      cx.emit("state-empty", {
        e: [ref("state", s)],
        at: at ? [at[0], at[1]] : null,
        msg: `state ${q(s.name)} (${s.i}) has no cells`,
        fix: () => editCall("state", [{ ref: s.i, remove: true }])
      });
    }
  }

  // ---------------------------------------------------------------- names

  const blank = v => v === undefined || v === null || !String(v).trim();

  function posOf(type, x) {
    try {
      const a = I.anchor(type, x);
      return a ? [a.x, a.y] : null;
    } catch {
      return null;
    }
  }

  function checkUnnamed(cx) {
    const gen = (type, x) => () => editCall(type, [{ ref: x.i, set: { name: { generate: {} } } }]);
    const give = (type, x) => () => ({ hint: `name it: edit ${type} ${x.i} set name:"..."` });
    const add = (type, x, sev, what, fix) =>
      cx.emit("unnamed", {
        sev,
        e: [[type, I.idOf(type, x), null]],
        at: posOf(type, x),
        msg: `${what} has no name`,
        fix
      });
    for (const b of liveBurgs(cx)) if (blank(b.name)) add("burg", b, "warn", `burg ${b.i}`, gen("burg", b));
    for (const s of liveStates(cx)) if (blank(s.name)) add("state", s, "error", `state ${s.i}`, gen("state", s));
    for (const p of liveProvinces(cx))
      if (blank(p.name)) add("province", p, "warn", `province ${p.i}`, gen("province", p));
    for (const r of I.liveList("river")) if (blank(r.name)) add("river", r, "warn", `river ${r.i}`, gen("river", r));
    for (const f of pack.features)
      if (f && typeof f === "object" && f.type === "lake" && blank(f.name))
        add("feature", f, "warn", `lake (feature ${f.i})`, give("feature", f));
    for (const z of I.liveList("zone")) if (blank(z.name)) add("zone", z, "warn", `zone ${z.i}`, give("zone", z));
    // The generator never names a route (the route editor names one when it is opened), so on most
    // maps every route is "unnamed": that is one row, with one call that names them all.
    const routes = I.liveList("route");
    let nameless = routes.filter(r => blank(r.name));
    if (cx.area)
      nameless = nameless.filter(r => {
        const p = posOf("route", r);
        return p && inArea(cx.area, p[0], p[1]);
      });
    if (nameless.length)
      cx.emit("unnamed", {
        sev: "info",
        e: nameless.slice(0, 6).map(r => ["route", I.idOf("route", r), null]),
        at: posOf("route", nameless[0]),
        msg: `${nameless.length} of ${routes.length} routes have no name (the generator names none; the route editor names a route when it is opened)`,
        score: nameless.length,
        fix: () =>
          evalCall(
            cx.area
              ? `const ids = new Set(${JSON.stringify(nameless.slice(0, 500).map(r => r.i))}); let n = 0; for (const r of pack.routes) if (ids.has(r.i) && !r.name) { r.name = Routes.generateName(r); n++; } return n`
              : "let n = 0; for (const r of pack.routes) if (!r.name) { r.name = Routes.generateName(r); n++; } return n"
          )
      });
    for (const d of domLabels(cx))
      if (d.kind === "label" && !d.text)
        cx.emit("unnamed", {
          e: [["label", d.id, ""]],
          at: labelCenter(cx, d),
          msg: `label ${d.id} has no text`,
          fix: () => editCall("label", [{ ref: d.id, remove: true }])
        });
  }

  function checkNameDuplicate(cx) {
    const kinds = [
      ["burg", liveBurgs(cx), "info", true],
      ["state", liveStates(cx), "warn", true],
      ["province", liveProvinces(cx), "warn", true],
      ["culture", pack.cultures.filter(x => x?.i && !x.removed), "warn", true],
      ["religion", pack.religions.filter(x => x?.i && !x.removed), "warn", true],
      ["river", I.liveList("river"), "info", true],
      ["zone", I.liveList("zone"), "info", false],
      ["feature", pack.features.filter(f => f && typeof f === "object" && f.type === "lake" && f.name), "info", false]
    ];
    for (const [type, list, sev, canGen] of kinds) {
      const groups = new Map();
      for (const x of list) {
        if (blank(x.name)) continue;
        const key = fold(x.name);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(x);
      }
      for (const members of groups.values()) {
        if (members.length < 2) continue;
        members.sort((x, y) => !!y.lock - !!x.lock); // a locked one keeps its name
        cx.emit("name-duplicate", {
          sev,
          e: members.slice(0, 6).map(x => ref(type, x)),
          at: posOf(type, members[0]),
          msg: `${members.length} ${type === "feature" ? "lake" : type}s are named ${q(members[0].name)}: ids ${members
            .slice(0, 8)
            .map(x => I.idOf(type, x))
            .join(", ")}${members.length > 8 ? ", ..." : ""}`,
          score: members.length,
          fix: () => {
            const rename = members.slice(1).filter(x => !x.lock);
            if (!rename.length) return { hint: "all but one are locked: unlock one, then rename it" };
            return canGen
              ? editCall(
                  type,
                  rename.slice(0, 10).map(x => ({ ref: x.i, set: { name: { generate: {} } } }))
                )
              : { hint: `rename all but one: edit ${type === "feature" ? "feature" : type} set name:"..."` };
          }
        });
      }
    }
  }

  // ---------------------------------------------------------------- rivers

  function cellPoint(cx, c) {
    const p = cx.C.p[c];
    return p ? [p[0], p[1]] : null;
  }

  const riverName = r => r.name || `river ${r.i}`;
  const removeRiverHint = r =>
    `remove it with edit river {ref:${r.i}, remove:true} (its tributaries go with it), or repair r.cells with eval; no automatic fix because removing a river is the larger change`;

  function checkRiverUphill(cx) {
    const H = cx.C.h;
    const found = [];
    for (const r of I.liveList("river")) {
      const cells = r.cells || [];
      if (cells.length < 2) continue;
      const rises = riverRises(cells, H, cx.riverTol);
      if (!rises.cells.length) continue;
      const worst = rises.cells.reduce((a, b) => (b.rise > a.rise ? b : a));
      found.push({ r, rises, worst });
      // one target per cell, shared by every river that passes through it (tributaries meet there)
      for (const x of rises.cells) {
        const old = cx.cellTarget.get(x.cell);
        cx.cellTarget.set(x.cell, old === undefined ? x.min : Math.min(old, x.min));
      }
    }
    for (const { r, rises, worst } of found) {
      const n = rises.cells.length;
      cx.emit("river-uphill", {
        sev: worst.rise >= cx.riverTol * 3 ? "error" : "warn",
        e: [ref("river", r)],
        at: cellPoint(cx, worst.cell),
        msg: `${riverName(r)} climbs ${worst.rise} downstream at cell ${worst.cell} (height ${H[worst.cell]}, lowest before it ${worst.min})${
          n > 1
            ? `; ${n} cells rise in all: ${rises.cells
                .slice(0, 6)
                .map(x => `${x.cell} (+${x.rise})`)
                .join(", ")}${n > 6 ? ", ..." : ""}`
            : ""
        }`,
        score: worst.rise,
        fix: () => {
          // one height for all of this river's rising cells: the lowest land cell before the first
          let v = rises.first;
          for (const x of rises.cells) v = Math.min(v, cx.cellTarget.get(x.cell) ?? v);
          return {
            tool: "paint_cells",
            args: { select: { cells: rises.cells.map(x => x.cell) }, set: { height: { value: v } } }
          };
        }
      });
    }
  }

  function checkRiverLoop(cx) {
    for (const r of I.liveList("river")) {
      const cells = r.cells || [];
      if (cells.length < 2) continue;
      const lp = riverLoop(cells);
      if (lp)
        cx.emit("river-loop", {
          e: [ref("river", r)],
          at: cellPoint(cx, lp.cell),
          msg: `${riverName(r)} revisits cell ${lp.cell} (positions ${lp.first} and ${lp.again} of ${cells.length})`,
          score: lp.again - lp.first,
          fix: () => ({ hint: removeRiverHint(r) })
        });
    }
  }

  /**
   * Land cells joining river cells a and b (exclusive), walking greedily toward b; never on a
   * river (this one or another: a reroute cannot cross one) or water. null when there is none.
   */
  function gapBridge(cx, a, b, maxSteps = 64) {
    const C = cx.C;
    const [tx, ty] = C.p[b];
    const path = [];
    const seen = new Set([a]);
    let cur = a;
    while (!(C.c[cur] || []).includes(b)) {
      if (path.length >= maxSteps) return null;
      let best = -1;
      let bd = Infinity;
      for (const j of C.c[cur] || []) {
        if (seen.has(j) || C.h[j] < 20 || C.r?.[j]) continue;
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

  function checkRiverGap(cx) {
    const allOps = [];
    for (const r of I.liveList("river")) {
      const cells = r.cells || [];
      if (cells.length < 2) continue;
      const gaps = [];
      let prev = -1;
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        if (!(c >= 0)) {
          prev = -1;
          continue;
        }
        if (prev >= 0 && prev !== c && !(cx.C.c[prev] || []).includes(c)) gaps.push({ a: prev, b: c, k });
        prev = c;
      }
      if (!gaps.length) continue;
      // one stretch reroute per gap (ops of one edit call apply in order)
      const ops = [];
      for (const g of gaps) {
        const mid = gapBridge(cx, g.a, g.b);
        if (!mid) break;
        ops.push({ ref: r.i, set: { reroute: { cells: [g.a, ...mid, g.b] } } });
      }
      const all = ops.length === gaps.length;
      if (all) allOps.push(...ops);
      const g = gaps[0];
      cx.emit("river-gap", {
        e: [ref("river", r)],
        at: cellPoint(cx, g.b),
        msg: `${riverName(r)} jumps from cell ${g.a} to ${g.b}, which are not neighbours (position ${g.k})${gaps.length > 1 ? `; ${gaps.length} gaps in all` : ""}`,
        fix: () =>
          all
            ? {
                ...editCall("river", ops),
                note: "fills each gap with the land cells between (a stretch reroute per gap)"
              }
            : {
                hint: `a gap crosses water or another river, so no reroute fills it: edit {type:'map', recalculate:'rivers+biomes'} regenerates every river (new ids and names; biome cells recomputed), or ${removeRiverHint(r)}`
              }
      });
    }
    if (allOps.length > 1)
      cx.fixAll["river-gap"] = {
        tool: "edit",
        args: { type: "river", ops: allOps.slice(0, 500), continueOnError: true }
      };
  }

  // ---------------------------------------------------------------- routes

  /** Live routes, an id index, and the segments (cell pairs) each route walks. Shared by the route checks. */
  function routeData(cx) {
    return cx.memo("routeData", () => {
      const N = cx.n;
      const list = I.liveList("route");
      const byId = new Map();
      for (const r of list) byId.set(r.i, r);
      const segKey = (a, b) => (a < b ? a * N + b : b * N + a);
      const segs = new Map();
      for (const r of list) {
        const pts = r.points || [];
        for (let k = 0; k < pts.length - 1; k++) {
          const a = pts[k][2];
          const b = pts[k + 1][2];
          if (a === b) continue;
          const key = segKey(a, b);
          let set = segs.get(key);
          if (!set) {
            set = new Set();
            segs.set(key, set);
          }
          set.add(r.i);
        }
      }
      return { list, byId, segs, segKey, N };
    });
  }

  const RELINK = "pack.cells.routes = Routes.buildLinks(pack.routes); return Object.keys(pack.cells.routes).length";

  function checkRouteLink(cx) {
    const C = cx.C;
    const { byId, segs, segKey, N } = routeData(cx);
    // rows may be missing or undefined (a height rebuild leaves holes); links are symmetric
    const rows = C.routes && typeof C.routes === "object" ? C.routes : {};
    const link = (a, b) => rows[a]?.[b];
    const stale = new Map();
    const wrong = new Map();
    const addTo = (map, id, a, b) => {
      let e = map.get(id);
      if (!e) {
        e = { n: 0, a, b };
        map.set(id, e);
      }
      e.n++;
    };
    const done = new Set();
    for (const ak of Object.keys(rows)) {
      const row = rows[ak];
      if (!row || typeof row !== "object") continue;
      const a = Number(ak);
      for (const bk of Object.keys(row)) {
        const b = Number(bk);
        const key = segKey(a, b);
        if (done.has(key)) continue;
        done.add(key);
        const ids = new Set([row[bk], link(bk, ak)].filter(v => v !== undefined));
        for (const rid of ids) {
          if (!byId.has(rid)) addTo(stale, rid, a, b);
          else if (!segs.get(key)?.has(rid)) addTo(wrong, rid, a, b);
        }
      }
    }
    const missing = new Map();
    for (const [key, set] of segs) {
      const a = Math.floor(key / N);
      const b = key % N;
      if (link(a, b) === undefined || link(b, a) === undefined) addTo(missing, set.values().next().value, a, b);
    }
    let any = false;
    for (const [rid, e] of stale) {
      any = true;
      cx.emit("route-link", {
        e: [["route", rid, null]],
        at: cellPoint(cx, e.a),
        msg: `${e.n} cells.routes link(s) point at route ${rid}, which no longer exists (first: cells ${e.a}-${e.b})`,
        score: e.n
      });
    }
    for (const [rid, e] of wrong) {
      any = true;
      cx.emit("route-link", {
        e: [ref("route", byId.get(rid))],
        at: cellPoint(cx, e.a),
        msg: `${e.n} cells.routes link(s) tagged route ${rid} join cells the route does not pass (first: cells ${e.a}-${e.b})`,
        score: e.n
      });
    }
    for (const [rid, e] of missing) {
      any = true;
      cx.emit("route-link", {
        e: [ref("route", byId.get(rid))],
        at: cellPoint(cx, e.a),
        msg: `route ${rid} has ${e.n} segment(s) with no cells.routes link (first: cells ${e.a}-${e.b})`,
        score: e.n
      });
    }
    if (any) cx.fixAll["route-link"] = evalCall(RELINK);
  }

  /**
   * The cell to record for a route point: findCell, or for a sea route the nearest water cell
   * around it (sea lanes run in open water, far from the pack's coastal cells). One definition for
   * the page code and for the eval fix text, so the fix clears the row.
   */
  const POINT_CELL_FN =
    "const fixCell = (x, y, water) => { const c = findCell(x, y), C = pack.cells; if ((C.h[c] < 20) === water) return c; let best = c, bd = Infinity; for (const k of C.c[c]) { if ((C.h[k] < 20) !== water) continue; const d = (C.p[k][0] - x) ** 2 + (C.p[k][1] - y) ** 2; if (d < bd) { bd = d; best = k; } } return best; };";

  /** Is a route point further from its recorded cell than that cell could explain? */
  function pointOff(cx, p) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return true;
    return !cellMatches(cx, p[0], p[1], p[2]);
  }

  function checkRoutePointCell(cx) {
    const tol = cx.cellTol * cx.spacing;
    const kept = [];
    let total = 0;
    for (const r of routeData(cx).list) {
      const pts = r.points || [];
      let n = 0;
      let worst = 0;
      let worstK = -1;
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k];
        if (!pointOff(cx, p)) continue;
        n++;
        const cp = cx.C.p[p[2]];
        const d = cp ? Math.hypot(p[0] - cp[0], p[1] - cp[1]) : Infinity;
        if (d > worst || worstK < 0) {
          worst = d;
          worstK = k;
        }
      }
      if (!n) continue;
      total++;
      const w = pts[worstK];
      const ok = cx.emit("route-point-cell", {
        e: [ref("route", r)],
        at: w ? [w[0], w[1]] : null,
        msg: `route ${r.i}: ${n} point(s) lie away from their recorded cell (worst: point ${worstK}, ${worst === Infinity ? `cell ${w?.[2]} does not exist` : `${rn(worst, 0)} px from cell ${w?.[2]}; the cell there is ${nearestCellOf(w[0], w[1])}`})`,
        score: Number.isFinite(worst) ? worst : 1e6,
        fix: () => evalCall(repointCode(tol, [r.i]))
      });
      if (ok) kept.push(r.i);
    }
    if (kept.length > 1) cx.fixAll["route-point-cell"] = evalCall(repointCode(tol, kept.length < total ? kept : null));
  }

  /** eval text that re-derives the cell of every off point (of the given routes, or all), then relinks. */
  function repointCode(tol, ids) {
    return `${POINT_CELL_FN} const ids = ${ids ? `new Set(${JSON.stringify(ids)})` : "null"}, C = pack.cells, tol = ${rn(tol, 2)}; let n = 0; for (const r of pack.routes) { if (ids && !ids.has(r.i)) continue; for (const p of r.points) { const cp = C.p[p[2]]; if (cp && Math.hypot(p[0] - cp[0], p[1] - cp[1]) <= tol) continue; const near = findCell(p[0], p[1]); if (near === p[2] || C.c[near].includes(p[2])) continue; p[2] = fixCell(p[0], p[1], r.group === 'searoutes'); n++; } } pack.cells.routes = Routes.buildLinks(pack.routes); return n`;
  }

  function checkRouteEndBurg(cx) {
    const C = cx.C;
    const removed = new Map();
    for (const b of pack.burgs)
      if (b && typeof b === "object" && b.removed && Number.isInteger(b.cell) && !C.burg[b.cell])
        removed.set(b.cell, b);
    if (!removed.size) return;
    const kept = new Set();
    const all = new Set();
    for (const r of routeData(cx).list) {
      const pts = r.points || [];
      const ends = pts.length ? [pts[0], pts[pts.length - 1]] : [];
      for (const p of ends) {
        const b = removed.get(p[2]);
        if (!b) continue;
        all.add(r.i);
        const ok = cx.emit("route-end-burg", {
          e: [ref("route", r), ["burg", b.i, b.name ?? null]],
          at: [p[0], p[1]],
          msg: `route ${r.i} (${r.group || "route"}) ends at cell ${p[2]}, where burg ${b.name ?? b.i} was removed (the fix trims the dangling end; add the burg back at that spot instead if the road should still lead somewhere)`,
          fix: () => evalCall(trimEndsCode([r.i]), ["routes"])
        });
        if (ok) kept.add(r.i);
      }
    }
    if (kept.size)
      cx.fixAll["route-end-burg"] = evalCall(trimEndsCode(kept.size < all.size ? [...kept] : null), ["routes"]);
  }

  /** eval text that cuts route ends that stand in the cell of a removed burg (a route left with under 2 points is removed), then relinks. */
  function trimEndsCode(ids) {
    return `const ids = ${ids ? `new Set(${JSON.stringify(ids)})` : "null"}, C = pack.cells; const ghost = new Set(pack.burgs.filter(b => b && b.removed && Number.isInteger(b.cell) && !C.burg[b.cell]).map(b => b.cell)); let n = 0; const removed = []; for (const r of [...pack.routes]) { if (ids && !ids.has(r.i)) continue; const pts = r.points; while (pts.length >= 2 && ghost.has(pts[0][2])) { pts.shift(); n++; } while (pts.length >= 2 && ghost.has(pts[pts.length - 1][2])) { pts.pop(); n++; } if (pts.length < 2) { pack.routes = pack.routes.filter(x => x !== r); removed.push(r.i); } } pack.cells.routes = Routes.buildLinks(pack.routes); return { pointsTrimmed: n, routesRemoved: removed, note: removed.length ? removed.length + " route(s) left with under 2 points were removed: " + removed.join(", ") : "no route was removed" }`;
  }

  // ---------------------------------------------------------------- notes

  const NOTE_OWNERS = {
    burg: i => {
      const b = pack.burgs[i];
      return !!b && !b.removed && !!b.i;
    },
    marker: i => pack.markers?.some(m => m && m.i === i),
    route: i => pack.routes?.some(r => r && r.i === i),
    river: i => pack.rivers?.some(r => r && r.i === i),
    zone: i => pack.zones?.some(z => z && z.i === i),
    stateLabel: i => {
      const s = pack.states[i];
      return !!s && !s.removed;
    },
    province: i => {
      const p = pack.provinces[i];
      return !!p && !p.removed;
    },
    culture: i => {
      const c = pack.cultures[i];
      return !!c && !c.removed;
    },
    religion: i => {
      const r = pack.religions[i];
      return !!r && !r.removed;
    },
    lake: i => {
      const f = pack.features[i];
      return !!f && typeof f === "object" && f.type === "lake";
    }
  };

  function checkNoteOrphan(cx) {
    const live = new Set(domLabels(cx).map(d => d.id));
    const labelsDrawn = domLabels(cx).length > 0;
    const orphans = [];
    for (const n of typeof notes !== "undefined" && Array.isArray(notes) ? notes : []) {
      if (!n || typeof n.id !== "string") continue;
      const mr = /^regiment(\d+)-(\d+)$/.exec(n.id);
      const mo = /^(burg|marker|route|river|zone|stateLabel|province|culture|religion|lake)(\d+)$/.exec(n.id);
      let gone = false;
      let kind = null;
      if (mr) {
        kind = "regiment";
        const s = pack.states[Number(mr[1])];
        gone = !s || !!s.removed || !(s.military || []).some(x => x && x.i === Number(mr[2]));
      } else if (mo) {
        kind = mo[1];
        gone = !NOTE_OWNERS[kind](Number(mo[2]));
      } else if (/^label\d+$/.test(n.id)) {
        kind = "label";
        gone = labelsDrawn && !live.has(n.id);
      }
      if (!gone) continue;
      const ok = cx.emit("note-orphan", {
        e: [["note", n.id, n.name ?? null]],
        msg: `note ${n.id} ${q(n.name)} points at a removed or missing ${kind}`
      });
      if (ok) orphans.push(n);
    }
    if (orphans.length)
      cx.fixAll["note-orphan"] = editCall(
        "note",
        orphans.slice(0, 200).map(n => ({ ref: n.id, remove: true }))
      );
  }

  // ---------------------------------------------------------------- runner

  /** One function per check, so a check that throws is skipped alone and its siblings still report. */
  const RUNNERS = {
    "label-offcanvas": checkLabelOffcanvas,
    "label-overlap": checkLabelOverlap,
    "label-marker-overlap": checkLabelMarkerOverlap,
    "label-orphan": checkLabelOrphan,
    "marker-stacked": checkMarkerStacked,
    "marker-near-burg": checkMarkerNearBurg,
    "marker-cell-link": checkMarkerCellLink,
    "marker-in-water": checkMarkerInWater,
    "burg-in-water": checkBurgInWater,
    "burg-shared-cell": checkBurgSharedCell,
    "burg-cell-link": checkBurgCellLink,
    "capital-outside": checkCapitalOutside,
    "province-empty": checkProvinceEmpty,
    "state-empty": checkStateEmpty,
    unnamed: checkUnnamed,
    "name-duplicate": checkNameDuplicate,
    "river-uphill": checkRiverUphill,
    "river-loop": checkRiverLoop,
    "river-gap": checkRiverGap,
    "route-link": checkRouteLink,
    "route-point-cell": checkRoutePointCell,
    "route-end-burg": checkRouteEndBurg,
    "note-orphan": checkNoteOrphan
  };

  function selectChecks(a) {
    if (a.checks === undefined || a.checks === null) return new Set(DEFAULT_IDS);
    if (!Array.isArray(a.checks) || !a.checks.length) fail("BAD_ARGS", "checks is a non-empty array of check ids");
    for (const c of a.checks) if (!DEFS[c]) fail("BAD_ARGS", `unknown check '${c}'`, { details: CHECK_IDS });
    return new Set(a.checks);
  }

  function finalize(cx, ids) {
    const order = new Map(CHECK_IDS.map((id, k) => [id, k]));
    const totals = { error: 0, warn: 0, info: 0 };
    const counts = {};
    const kinds = {};
    const clean = [];
    const shown = [];
    for (const id of CHECK_IDS) {
      if (!ids.has(id) || cx.skipped.some(s => s.check === id)) continue;
      const slot = cx.slots.get(id);
      if (!slot?.n) {
        // an area filter drops rows that have no location: such a check is not known to be clean
        if (!cx.unlocated[id]) clean.push(id);
        continue;
      }
      counts[id] = slot.n;
      if (KINDED.has(id)) kinds[id] = slot.kinds;
      for (const row of slot.items) totals[row.sev]++;
      slot.items.sort((x, y) => SEV_RANK[y.sev] - SEV_RANK[x.sev] || (y.score || 0) - (x.score || 0));
      slot.items
        .filter(row => SEV_RANK[row.sev] >= cx.rowRank)
        .slice(0, cx.limit)
        .forEach((row, k) => {
          shown.push({ id, row, k });
        });
    }
    // overall cap: keep the most severe rows, in check order within a severity
    shown.sort((x, y) => SEV_RANK[y.row.sev] - SEV_RANK[x.row.sev] || order.get(x.id) - order.get(y.id) || x.k - y.k);
    const kept = shown.slice(0, cx.maxRows);
    const rows = {};
    for (const { id, row } of kept.sort((x, y) => order.get(x.id) - order.get(y.id) || x.k - y.k)) {
      const out = { sev: row.sev, e: row.e };
      if (row.at) out.at = row.at;
      out.msg = row.msg;
      // a check with a fixAll and several rows is repaired by that one call: rows carry no fix of their own
      // (filter to one row with near/bbox/types to get it)
      if (cx.fixes && row.fix) {
        const covered = !!(cx.fixAll[id] && counts[id] > 1);
        let f = null;
        try {
          f = typeof row.fix === "function" ? row.fix() : row.fix;
        } catch (err) {
          f = { hint: `no automatic fix (${err?.message || err})` };
        }
        // a row the fixAll cannot repair keeps its hint
        if (f?.tool && covered) f = null;
        if (f?.tool) {
          out.fix = { tool: f.tool, args: f.args };
          if (f.note) out.fixNote = f.note;
        } else if (f?.hint) out.hint = f.hint;
      }
      if (!rows[id]) rows[id] = [];
      rows[id].push(out);
    }
    const more = {};
    for (const id of Object.keys(counts)) {
      const hidden = counts[id] - (rows[id]?.length || 0);
      if (hidden > 0) more[id] = hidden;
    }
    const fixAll = {};
    if (cx.fixes) for (const id of Object.keys(counts)) if (cx.fixAll[id]) fixAll[id] = cx.fixAll[id];
    return { totals, counts, kinds, rows, more, fixAll, clean };
  }

  FNS.lint = a => {
    const t0 = now();
    const ids = selectChecks(a);
    const cx = makeCtx(a);
    cx.wants = { pins: ids.has("label-marker-overlap") };
    for (const id of CHECK_IDS) {
      if (!ids.has(id)) continue;
      // unselected checks never emit; the label checks share one memoised measurement
      try {
        RUNNERS[id](cx);
      } catch (e) {
        cx.skip(id, `check failed: ${e?.message || e}`);
      }
    }
    const f = finalize(cx, ids);
    const out = {
      ms: Math.round(now() - t0),
      map: { w: cx.gw, h: cx.gh, cells: cx.n },
      totals: f.totals,
      counts: f.counts,
      rows: f.rows
    };
    if (Object.keys(f.kinds).length) out.kinds = f.kinds;
    if (Object.keys(f.more).length) out.more = f.more;
    if (Object.keys(f.fixAll).length) out.fixAll = f.fixAll;
    out.clean = f.clean;
    const seen = new Set();
    for (const p of cx.memos.labelItems?.probes || []) for (const it of p.items) seen.add(it.id);
    out.scanned = {
      burgs: liveBurgs(cx).length,
      markers: I.liveList("marker").length,
      rivers: I.liveList("river").length,
      routes: I.liveList("route").length,
      labels: seen.size
    };
    if (cx.skipped.length) out.skipped = cx.skipped;
    if (Object.keys(cx.unlocated).length) out.unlocated = cx.unlocated;
    if (cx.ignored) out.ignored = cx.ignored;
    if (cx.notes.length) out.notes = cx.notes;
    return out;
  };

  T.lint = { CHECK_IDS, DEFS, overlapPairs, closePairs, clusters, riverProfile, riverRises, riverLoop };
})(globalThis);
