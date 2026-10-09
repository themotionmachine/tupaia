// Tupaia MCP bridge extension: lint, a read-only automatic map quality check.
// Injected after bridge.js and bridge-mutations.js (src/bridge-ext/*.js, name order). Same rules
// as bridge.js: app globals by bare name at call time, no locals that shadow app globals
// (labels, burgLabels, routes, rivers, markers, zones, cells, notes, scale, ...), every FNS
// function takes one args object. lint never mutates the map: no data writes, no redraws, no
// layer toggles (the one DOM touch is getBBox/getCTM reads).
//
// FNS.lint({checks?, types?, bbox?, near?+radius?, limit?, maxRows?, minSeverity?, fixes?,
//           overlapMin?, markerGap?, riverTol?}) runs the checks below and returns
//   {ms, map, totals, counts, rows, fixAll?, more?, clean, skipped?, notes?}
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
  const _SEV_BY_RANK = ["info", "warn", "error"];

  /** Check ids in report order, with their default severity and what they look at. */
  const DEFS = {
    "label-offcanvas": { sev: "warn", about: "label box outside the map rect" },
    "label-overlap": { sev: "info", about: "labels overlapping each other" },
    "label-orphan": { sev: "warn", about: "state/burg label whose state/burg was removed" },
    "marker-stacked": { sev: "warn", about: "markers within markerGap px (or in one cell)" },
    "marker-in-water": { sev: "error", about: "land-only marker on a water cell" },
    "burg-in-water": { sev: "error", about: "burg on a water or lake cell" },
    "burg-shared-cell": { sev: "warn", about: "several burgs in one cell" },
    "burg-cell-link": { sev: "warn", about: "pack.cells.burg disagrees with burg.cell" },
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
   * Returns [{a, b, frac, ox, oy, ix, iy}] (ox/oy/ix/iy: the biggest intersecting part pair).
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
      if (frac >= minFrac) out.push({ a: e.a, b: e.b, frac, ox: e.ox, oy: e.oy, ix: e.ix, iy: e.iy });
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
      types: Array.isArray(a.types) && a.types.length ? new Set(a.types) : null,
      area: parseArea(a),
      fixes: a.fixes !== false,
      overlapMin: num(a.overlapMin, 0.15, 0.001, 1, "overlapMin"),
      markerGap: num(a.markerGap, 20, 1, 500, "markerGap"),
      riverTol: num(a.riverTol, 12, 1, 100, "riverTol"),
      cellTol: 0.9,
      slots: new Map(),
      skipped: [],
      notes: [],
      claimed: new Set(),
      fixAll: {},
      memos: {}
    };
    cx.memo = (key, fn) => {
      if (!(key in cx.memos)) cx.memos[key] = fn();
      return cx.memos[key];
    };
    cx.skip = (check, reason) => cx.skipped.push({ check, reason });
    cx.emit = (check, row) => {
      const sev = row.sev || DEFS[check].sev;
      if (SEV_RANK[sev] < cx.minRank) return;
      if (cx.types && !row.e.some(t => cx.types.has(t[0]))) return;
      if (cx.area && !(row.at && inArea(cx.area, row.at[0], row.at[1]))) return;
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

  /** Visible label items {kind, id, num, text, el, box, e}, or {reason} when they cannot be measured. */
  function labelItems(cx) {
    return cx.memo("labelItems", () => {
      const res = { items: [], reason: null, hidden: 0 };
      if (typeof document === "undefined") {
        res.reason = "no page DOM";
        return res;
      }
      const root = document.getElementById("labels");
      const doms = domLabels(cx);
      if (!root) {
        res.reason = "the page has no #labels group";
        return res;
      }
      if (!doms.length) {
        res.reason =
          "no label elements are drawn (map saved without labels); eval {code:'1', readOnly:true, redraw:['labels']} draws them";
        return res;
      }
      if (getComputedStyle(root).display === "none") {
        res.reason = "the labels layer is off (display it first)";
        return res;
      }
      const inv = viewInverse(cx);
      for (const d of doms) {
        if (d.el.closest(".hidden") || d.el.style.display === "none") {
          res.hidden++;
          continue;
        }
        const box = mapBox(d.el, inv);
        if (!box) continue;
        let e;
        if (d.kind === "state") e = ["state", d.num, pack.states[d.num]?.name ?? d.text];
        else if (d.kind === "burg") e = ["burg", d.num, pack.burgs[d.num]?.name ?? d.text];
        else e = ["label", d.id, d.text];
        const parts = glyphParts(d.el, inv);
        res.items.push(parts ? { ...d, box, e, parts } : { ...d, box, e });
      }
      if (res.hidden) cx.notes.push(`${res.hidden} labels in hidden groups were not measured`);
      if (typeof scale === "number" && Math.abs(scale - 1) > 0.01)
        cx.notes.push(`labels measured at zoom ${rn(scale, 2)} (label font sizes rescale with zoom)`);
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
    if (!m) return { hint: `label ${it.id} follows a curved path; move it with eval` };
    const x = Math.max(0, Math.min(cx.gw, Number(m[1]) + Number(m[3]) / 2 + dx));
    const y = Math.max(0, Math.min(cx.gh, Number(m[2]) + dy));
    return editCall("label", [{ ref: it.id, set: { move: { x: rn(x, 1), y: rn(y, 1) } } }]);
  }

  function checkLabelOffcanvas(cx) {
    const li = labelItems(cx);
    if (li.reason) return cx.skip("label-offcanvas", li.reason);
    const tol = 0.5;
    for (const it of li.items) {
      const b = it.box;
      const left = Math.max(0, -b.x0);
      const top = Math.max(0, -b.y0);
      const right = Math.max(0, b.x1 - cx.gw);
      const bottom = Math.max(0, b.y1 - cx.gh);
      if (left <= tol && top <= tol && right <= tol && bottom <= tol) continue;
      const w = b.x1 - b.x0;
      const h = b.y1 - b.y0;
      const inter =
        Math.max(0, Math.min(b.x1, cx.gw) - Math.max(b.x0, 0)) * Math.max(0, Math.min(b.y1, cx.gh) - Math.max(b.y0, 0));
      const outFrac = w * h > 0 ? 1 - inter / (w * h) : 1;
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
        msg: `${KIND_NAME[it.kind]} ${q(it.text)} sticks out of the map by ${sides.join(", ")} px (${Math.round(outFrac * 100)}% outside)`,
        score: outFrac,
        fix: () => labelShift(cx, it, dx, dy)
      });
    }
  }

  const KIND_NAME = { state: "state label", burg: "burg label", label: "custom label" };

  function checkLabelOverlap(cx) {
    const li = labelItems(cx);
    if (li.reason) return cx.skip("label-overlap", li.reason);
    for (const p of overlapPairs(li.items, cx.overlapMin)) {
      const A = li.items[p.a];
      const B = li.items[p.b];
      cx.emit("label-overlap", {
        sev: p.frac >= 0.5 ? "warn" : "info",
        e: [A.e, B.e],
        at: [p.ix + p.ox / 2, p.iy + p.oy / 2],
        msg: `${KIND_NAME[A.kind]} ${q(A.text)} overlaps ${KIND_NAME[B.kind]} ${q(B.text)} (${Math.round(p.frac * 100)}% of the smaller)`,
        score: p.frac,
        fix: () => {
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
                `document.getElementById('${d.id}')?.remove(); document.getElementById('textPath_${d.id}')?.remove()`
              )
          });
      } else if (d.kind === "burg") {
        const b = pack.burgs[d.num];
        if (!b || b.removed || !b.i)
          cx.emit("label-orphan", {
            e: [["burg", d.num, d.text]],
            at: labelCenter(cx, d),
            msg: `burg label ${q(d.text)} belongs to ${b?.removed ? "removed " : "missing "}burg ${d.num}`,
            fix: () => evalCall(`document.getElementById('${d.id}')?.remove()`)
          });
      }
    }
  }

  function labelCenter(cx, d) {
    const b = mapBox(d.el, viewInverse(cx));
    return b ? [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] : null;
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

  function checkMarkerInWater(cx) {
    for (const m of I.liveList("marker")) {
      const p = markerPos(cx, m);
      const c = Number.isInteger(m.cell) && m.cell >= 0 && m.cell < cx.n ? m.cell : p ? nearestCellOf(p.x, p.y) : -1;
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

  // ---------------------------------------------------------------- burgs

  function moveBurgOps(cx, b) {
    const need = b.capital ? c => freeLand(cx, c) && cx.C.state[c] === b.state : c => freeLand(cx, c);
    const target = nearestCellWhere(cx, b.cell, need);
    if (target === null) return null;
    cx.claimed.add(target);
    return { ref: b.i, set: { move: { cell: target } } };
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
          const op = moveBurgOps(cx, b);
          return op ? editCall("burg", [op]) : { hint: "no free land cell nearby: remove the burg (edit burg remove)" };
        }
      });
    }
  }

  /** Live burgs grouped by their recorded cell (largest population first inside a group). */
  function burgsByCell(cx) {
    return cx.memo("burgsByCell", () => {
      const byCell = new Map();
      for (const b of liveBurgs(cx)) {
        if (!byCell.has(b.cell)) byCell.set(b.cell, []);
        byCell.get(b.cell).push(b);
      }
      // the burg that cells.burg points at keeps the cell; then the biggest
      for (const [cell, list] of byCell) {
        const owner = cx.C.burg ? cx.C.burg[cell] : 0;
        list.sort((x, y) => (y.i === owner) - (x.i === owner) || (y.population || 0) - (x.population || 0));
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
          const ops = list
            .slice(1)
            .map(b => moveBurgOps(cx, b))
            .filter(Boolean);
          return ops.length ? editCall("burg", ops) : { hint: "no free land cell nearby: remove the extra burgs" };
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
      if (C.burg[b.cell] === b.i || shared.has(b.cell)) continue;
      cx.emit("burg-cell-link", {
        e: [ref("burg", b)],
        at: [b.x, b.y],
        msg: `${b.name} (${b.i}) is in cell ${b.cell}, but cells.burg there holds ${C.burg[b.cell] || "nothing"}`,
        fix: () => evalCall(`pack.cells.burg[${b.cell}] = ${b.i}`)
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
        fix: () => evalCall(`pack.cells.burg[${c}] = 0`)
      });
    }
  }

  function checkCapitalOutside(cx) {
    const C = cx.C;
    for (const s of liveStates(cx)) {
      const b = pack.burgs[s.capital];
      let msg = null;
      if (!s.capital || !b || b.removed) msg = `${s.name} has no live capital (capital ${s.capital || "unset"})`;
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
          return { hint: "the state has no free land cell for a capital: add a burg inside it first" };
        }
      });
    }
  }

  function checkRegionEmpty(cx) {
    const C = cx.C;
    const provCells = new Map();
    const stateCells = new Map();
    for (let c = 0; c < cx.n; c++) {
      const p = C.province ? C.province[c] : 0;
      if (p) provCells.set(p, (provCells.get(p) || 0) + 1);
      const s = C.state[c];
      if (s) stateCells.set(s, (stateCells.get(s) || 0) + 1);
    }
    for (const p of liveProvinces(cx)) {
      if (provCells.get(p.i)) continue;
      const at = p.pole ? p.pole : C.p[p.center];
      cx.emit("province-empty", {
        e: [ref("province", p)],
        at: at ? [at[0], at[1]] : null,
        msg: `province ${q(p.name)} (${p.i}) has no cells`,
        fix: () =>
          evalCall(
            `const p = ${p.i}; const s = pack.states[pack.provinces[p].state]; if (s?.provinces) s.provinces = s.provinces.filter(x => x !== p); document.getElementById('province' + p)?.remove(); document.getElementById('province-gap' + p)?.remove(); pack.provinces[p] = { i: p, removed: true }`,
            ["borders", "provinces"]
          )
      });
    }
    for (const s of liveStates(cx)) {
      if (stateCells.get(s.i)) continue;
      const at = s.pole ? s.pole : C.p[s.center];
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
    for (const r of I.liveList("route"))
      if (blank(r.name)) add("route", r, "info", `route ${r.i} (${r.group || "route"})`, give("route", r));
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
        cx.emit("name-duplicate", {
          sev,
          e: members.slice(0, 6).map(x => ref(type, x)),
          at: posOf(type, members[0]),
          msg: `${members.length} ${type === "feature" ? "lake" : type}s are named ${q(members[0].name)}: ids ${members
            .slice(0, 8)
            .map(x => I.idOf(type, x))
            .join(", ")}${members.length > 8 ? ", ..." : ""}`,
          score: members.length,
          fix: () =>
            canGen
              ? editCall(
                  type,
                  members.slice(1, 11).map(x => ({ ref: x.i, set: { name: { generate: {} } } }))
                )
              : { hint: `rename all but one: edit ${type === "feature" ? "feature" : type} set name:"..."` }
        });
      }
    }
  }

  // ---------------------------------------------------------------- rivers

  function cellPoint(cx, c) {
    const p = cx.C.p[c];
    return p ? [p[0], p[1]] : null;
  }

  function checkRivers(cx, want) {
    const H = cx.C.h;
    for (const r of I.liveList("river")) {
      const cells = r.cells || [];
      if (cells.length < 2) continue;
      if (want.uphill) {
        const pr = riverProfile(cells, H);
        if (pr.rise >= cx.riverTol) {
          cx.emit("river-uphill", {
            sev: pr.rise >= cx.riverTol * 3 ? "error" : "warn",
            e: [ref("river", r)],
            at: cellPoint(cx, pr.at),
            msg: `${r.name || `river ${r.i}`} climbs ${pr.rise} downstream at cell ${pr.at} (height ${H[pr.at]}, lowest before it ${pr.min}${pr.from >= 0 ? ` at cell ${pr.from}` : ""})`,
            score: pr.rise,
            fix: () =>
              pr.min >= 20
                ? {
                    tool: "paint_cells",
                    args: { select: { cells: [pr.at] }, set: { height: { value: pr.min } } }
                  }
                : { hint: "lower the cell with paint_cells height, or remove the river (edit river remove)" }
          });
        }
      }
      if (want.loop) {
        const lp = riverLoop(cells);
        if (lp)
          cx.emit("river-loop", {
            e: [ref("river", r)],
            at: cellPoint(cx, lp.cell),
            msg: `${r.name || `river ${r.i}`} revisits cell ${lp.cell} (positions ${lp.first} and ${lp.again} of ${cells.length})`,
            score: lp.again - lp.first,
            fix: () => editCall("river", [{ ref: r.i, remove: true }])
          });
      }
      if (want.gap) {
        let prev = -1;
        for (let k = 0; k < cells.length; k++) {
          const c = cells[k];
          if (!(c >= 0)) {
            prev = -1;
            continue;
          }
          if (prev >= 0 && prev !== c && !(cx.C.c[prev] || []).includes(c)) {
            cx.emit("river-gap", {
              e: [ref("river", r)],
              at: cellPoint(cx, c),
              msg: `${r.name || `river ${r.i}`} jumps from cell ${prev} to ${c}, which are not neighbours (position ${k})`,
              fix: () => editCall("river", [{ ref: r.i, remove: true }])
            });
            break;
          }
          prev = c;
        }
      }
    }
  }

  // ---------------------------------------------------------------- routes

  function checkRoutes(cx, want) {
    const C = cx.C;
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
    if (want.link && C.routes) {
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
      for (const ak of Object.keys(C.routes)) {
        const row = C.routes[ak];
        const a = Number(ak);
        for (const bk of Object.keys(row)) {
          const b = Number(bk);
          const key = segKey(a, b);
          if (done.has(key)) continue; // links are symmetric: look at each segment once
          done.add(key);
          const ids = new Set([row[bk], C.routes[bk]?.[ak]].filter(v => v !== undefined));
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
        if (C.routes[a]?.[b] === undefined || C.routes[b]?.[a] === undefined) {
          const rid = set.values().next().value;
          addTo(missing, rid, a, b);
        }
      }
      const relink = evalCall(
        "pack.cells.routes = Routes.buildLinks(pack.routes); Object.keys(pack.cells.routes).length"
      );
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
      if (any) cx.fixAll["route-link"] = relink;
    }
    if (want.point) {
      const tol = cx.cellTol * cx.spacing;
      for (const r of list) {
        const pts = r.points || [];
        let bad = 0;
        let worst = 0;
        let worstK = -1;
        for (let k = 0; k < pts.length; k++) {
          const p = pts[k];
          const cp = C.p[p[2]];
          const d = cp ? Math.hypot(p[0] - cp[0], p[1] - cp[1]) : Infinity;
          if (d > tol) {
            bad++;
            if (d > worst) {
              worst = d;
              worstK = k;
            }
          }
        }
        if (!bad) continue;
        cx.emit("route-point-cell", {
          e: [ref("route", r)],
          at: pts[worstK] ? [pts[worstK][0], pts[worstK][1]] : null,
          msg: `route ${r.i}: ${bad} point(s) are farther than ${rn(tol, 0)} px from their recorded cell (worst: point ${worstK}, ${worst === Infinity ? "no such cell" : `${rn(worst, 0)} px`}, cell ${pts[worstK]?.[2]})`,
          score: Number.isFinite(worst) ? worst : 1e6,
          fix: () =>
            evalCall(
              `const r = pack.routes.find(r => r.i === ${r.i}); for (const p of r.points) p[2] = findCell(p[0], p[1]); pack.cells.routes = Routes.buildLinks(pack.routes)`
            )
        });
      }
    }
    if (want.end) {
      const removed = new Map();
      for (const b of pack.burgs)
        if (b && typeof b === "object" && b.removed && Number.isInteger(b.cell) && !C.burg[b.cell])
          removed.set(b.cell, b);
      if (removed.size) {
        for (const r of list) {
          const pts = r.points || [];
          const ends = pts.length ? [pts[0], pts[pts.length - 1]] : [];
          for (const p of ends) {
            const b = removed.get(p[2]);
            if (!b) continue;
            cx.emit("route-end-burg", {
              e: [ref("route", r), ["burg", b.i, b.name ?? null]],
              at: [p[0], p[1]],
              msg: `route ${r.i} (${r.group || "route"}) ends at cell ${p[2]}, where burg ${b.name ?? b.i} was removed`,
              fix: () => editCall("route", [{ ref: r.i, remove: true }])
            });
          }
        }
      }
    }
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
      orphans.push(n);
      cx.emit("note-orphan", {
        e: [["note", n.id, n.name ?? null]],
        msg: `note ${n.id} ${q(n.name)} points at a removed or missing ${kind}`
      });
    }
    if (orphans.length)
      cx.fixAll["note-orphan"] = editCall(
        "note",
        orphans.slice(0, 200).map(n => ({ ref: n.id, remove: true }))
      );
  }

  // ---------------------------------------------------------------- runner

  const RUNNERS = [
    ["label-offcanvas", checkLabelOffcanvas],
    ["label-overlap", checkLabelOverlap],
    ["label-orphan", checkLabelOrphan],
    ["marker-stacked", checkMarkerStacked],
    ["marker-in-water", checkMarkerInWater],
    ["burg-in-water", checkBurgInWater],
    ["burg-shared-cell", checkBurgSharedCell],
    ["burg-cell-link", checkBurgCellLink, ["burg-shared-cell"]],
    ["capital-outside", checkCapitalOutside],
    ["province-empty", checkRegionEmpty, ["state-empty"]],
    ["unnamed", checkUnnamed],
    ["name-duplicate", checkNameDuplicate],
    ["river-uphill", cx => checkRivers(cx, cx.wantRiver), ["river-loop", "river-gap"]],
    ["route-link", cx => checkRoutes(cx, cx.wantRoute), ["route-point-cell", "route-end-burg"]],
    ["note-orphan", checkNoteOrphan]
  ];

  function selectChecks(a) {
    if (a.checks === undefined || a.checks === null) return new Set(CHECK_IDS);
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
        clean.push(id);
        continue;
      }
      counts[id] = slot.n;
      if (KINDED.has(id)) kinds[id] = slot.kinds;
      for (const row of slot.items) totals[row.sev]++;
      slot.items.sort((x, y) => SEV_RANK[y.sev] - SEV_RANK[x.sev] || (y.score || 0) - (x.score || 0));
      slot.items.slice(0, cx.limit).forEach((row, k) => {
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
      if (cx.fixes && row.fix) {
        let f = null;
        try {
          f = typeof row.fix === "function" ? row.fix() : row.fix;
        } catch (err) {
          f = { hint: `no automatic fix (${err?.message || err})` };
        }
        if (f?.tool) out.fix = f;
        else if (f?.hint) out.hint = f.hint;
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
    cx.wantRiver = { uphill: ids.has("river-uphill"), loop: ids.has("river-loop"), gap: ids.has("river-gap") };
    cx.wantRoute = { link: ids.has("route-link"), point: ids.has("route-point-cell"), end: ids.has("route-end-burg") };
    for (const [id, fn, extra] of RUNNERS) {
      const group = [id, ...(extra || [])];
      if (!group.some(g => ids.has(g))) continue;
      // the checks of one runner share their precomputation; unselected ones emit nothing
      const mine = new Set(group.filter(g => ids.has(g)));
      const emit = cx.emit;
      cx.emit = (check, row) => {
        if (mine.has(check)) emit(check, row);
      };
      try {
        fn(cx);
      } catch (e) {
        for (const g of mine) cx.skip(g, `check failed: ${e?.message || e}`);
      } finally {
        cx.emit = emit;
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
    out.scanned = {
      burgs: liveBurgs(cx).length,
      markers: I.liveList("marker").length,
      rivers: I.liveList("river").length,
      routes: I.liveList("route").length,
      labels: cx.memos.labelItems ? cx.memos.labelItems.items.length : 0
    };
    if (cx.skipped.length) out.skipped = cx.skipped;
    if (cx.notes.length) out.notes = cx.notes;
    return out;
  };

  T.lint = { CHECK_IDS, DEFS, overlapPairs, closePairs, clusters, riverProfile, riverLoop };
})(globalThis);
