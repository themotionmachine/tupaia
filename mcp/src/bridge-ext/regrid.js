// Tupaia MCP bridge extension: regrid (change the cell density of the map in the page and keep
// it the same map). Classic script injected after bridge.js and bridge-mutations.js; same rules:
// app globals by bare name at call time, no locals that shadow app globals (labels, notes, ice,
// rulers, routes, zones, cells, grid, pack, options, scale, ...), one args object per function.
//
// It drives the app's own resampler (Resample.process, the engine of the Transform and Submap
// tools) with an identity projection at scale 1, which rebuilds the grid at the new density
// and remaps heights, cell data, burgs, states, provinces, cultures, religions, routes, rivers,
// markers and zones by coordinates. Around it, it patches what that path loses or degrades:
// - heights: Resample copies the nearest old cell (the old Voronoi staircase survives at any
//   density); 'interpolate' (default) samples the old surface over its Delaunay triangulation,
//   with land/water decided by the interpolated land fraction (a smooth coastline through the
//   midpoints between old land and water cells) and every old cell keeping at least one new
//   cell of its class (single-cell islands, lakes and straits survive);
// - burgs: two burgs that land in one new cell are not dropped but moved to the nearest free
//   land cell; burg.feature and burg.port (feature ids) are re-pointed at the new features;
// - features: names, groups and heights come from the old feature of the same type that most
//   of the new feature's cells came from (Resample takes any type from one cell);
// - routes: points that ended at a burg follow the burg's new cell;
// - zones: cells re-derived by nearest old cell (Resample unions discs, a rounder shape);
// - notes, custom labels (and their text paths), rulers, custom emblems, ice (unless
//   ice:'regenerate') and the map id (lineage) are carried over; undraw() and process() would
//   otherwise drop them.
// Node takes the auto-undo snapshot between the validate and apply phases.
(root => {
  const T = root.__tupaia;
  if (!T) return;
  const FNS = T.fns;
  const fail = T.fail;
  const I = T.internals;

  const rn = (v, d = 2) => {
    const m = 10 ** d;
    return Math.round(v * m) / m;
  };
  const isLive = x => !!x && typeof x === "object" && !x.removed;
  const IDENTITY = (x, y) => [x, y];

  /** The Options "cells density" slider: position -> points. */
  const DENSITY = {
    1: 1000,
    2: 2000,
    3: 5000,
    4: 10000,
    5: 20000,
    6: 30000,
    7: 40000,
    8: 50000,
    9: 60000,
    10: 70000,
    11: 80000,
    12: 90000,
    13: 100000
  };
  const LAKE_KEYS = ["temp", "flux", "evaporation", "inlets", "outlet", "closed"];
  const AREA_FIELDS = ["province", "state", "culture", "religion"];
  const BREACH_HEIGHT = 22; // openNearSeaLakes' LIMIT
  const HEIGHTS_LEGEND =
    "claimed: new points given their own old cell's land/water; forced: old features or areas with no point left that got one (keptAreas: of them, provinces/states/cultures/religions); rejoined: split features joined back (carved: points flipped for it); dropped: 1-2 point fragments removed; separated: points flipped so two old features do not merge; spurious: blobs with no old feature flipped; dams: land raised so a lake is not drained into the sea; outsideHull: points outside the old samples (nearest one used)";
  const WORKER_MAX_BYTES = 64 * 1024 * 1024;

  function targetCells(v) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= 13) return DENSITY[n];
    if (Number.isInteger(n) && n >= 1000 && n <= 100000) return n;
    return fail(
      "BAD_ARGS",
      "density is the Options cells density: a slider position 1-13 or a points count 1000-100000"
    );
  }

  function sliderOf(cellsDesired) {
    let best = 1;
    for (const k of Object.keys(DENSITY))
      if (Math.abs(DENSITY[k] - cellsDesired) < Math.abs(DENSITY[best] - cellsDesired)) best = Number(k);
    return best;
  }

  /** Grid the app's placePoints would build for `want` points on this canvas. */
  function gridShape(want) {
    const spacing = rn(Math.sqrt((graphWidth * graphHeight) / want), 2);
    const cellsX = Math.floor((graphWidth + 0.5 * spacing - 1e-10) / spacing);
    const cellsY = Math.floor((graphHeight + 0.5 * spacing - 1e-10) / spacing);
    return { spacing, cellsX, cellsY, points: cellsX * cellsY };
  }

  // How each .map line grows with the cell count (save.ts prepareMapData order): grid arrays
  // with the grid points, pack arrays with the pack cells, pack features and rivers by a power of
  // the pack ratio. The svg (line 5) by drawn layer: the redraw makes area outlines grow about
  // with ratio^0.6, heightmap contours ^0.73; rivers (re-anchored on their old control points),
  // labels, markers, routes, burg icons and defs stay (measured on demo.map and terraform-v3.map,
  // 10K -> 50K and 30K -> 10K). Relief icons are
  // placed by area (a Poisson disc per cell), so a fresh draw grows only ^0.1-0.2 (terraform-v3 10K
  // <-> 30K, 50K); a saved relief layer can be far from what a redraw at the same density draws, so
  // the estimate starts from a fresh draw (freshLength).
  const GRID_LINES = [6, 7, 8, 9, 10, 11];
  const PACK_LINES = [16, 17, 18, 19, 20, 21, 22, 24, 25, 26, 27, 38, 40, 44];
  const PACK_EXPONENT = { 12: 0.6 }; // features; rivers (32) keep their anchors, so stay
  const SVG_LINE = 5;
  const SVG_EXPONENT = { terrs: 0.73, terrain: 0.15, cells: 1 };
  for (const id of [
    "biomes",
    "regions",
    "provs",
    "cults",
    "relig",
    "borders",
    "ocean",
    "coastline",
    "lakes",
    "zones",
    "ice",
    "landmass",
    "temperature",
    "prec",
    "population"
  ])
    SVG_EXPONENT[id] = 0.6;

  /**
   * The relief layer as a redraw at the current density would draw it (it is put back as it
   * was right after: the dry run changes nothing); other layers as they are.
   */
  function freshLength(g, now) {
    if (g.id !== "terrain" || !g.querySelector("use") || typeof drawReliefIcons !== "function") return now;
    const saved = g.innerHTML;
    try {
      drawReliefIcons();
      return g.outerHTML.length;
    } catch {
      return now;
    } finally {
      g.innerHTML = saved;
    }
  }

  async function bytesEstimate(gridRatio, packRatio, relief) {
    const { prepareMapData } = await lazy.save();
    const lines = prepareMapData().split("\r\n");
    let svgGrowth = 0;
    for (const g of document.getElementById("viewbox")?.children || []) {
      if (!SVG_EXPONENT[g.id] || (g.id === "terrain" && relief === "keep")) continue;
      const now = g.outerHTML.length;
      svgGrowth += freshLength(g, now) * packRatio ** SVG_EXPONENT[g.id] - now;
    }
    let now = 0;
    let est = 0;
    lines.forEach((l, k) => {
      const n = l.length + 2;
      now += n;
      if (GRID_LINES.includes(k)) est += n * gridRatio;
      else if (PACK_LINES.includes(k)) est += n * packRatio;
      else if (PACK_EXPONENT[k]) est += n * packRatio ** PACK_EXPONENT[k];
      else if (k === SVG_LINE) est += Math.max(n / 4, n + svgGrowth);
      else est += n;
    });
    return { now, est: Math.round(est) };
  }

  function prepare(a) {
    if (typeof Resample === "undefined" || typeof Resample.process !== "function")
      fail("PAGE_ERROR", "the app's Resample is missing; rebuild dist (CF_BUILD=1 npx vite build)");
    // a dry run changes nothing, so an open editor only blocks a real regrid (its validate and apply)
    if ((a.phase === "apply" || !a.dryRun) && typeof customization !== "undefined" && customization)
      fail(
        "REFUSED",
        `an editor is active (customization=${customization}); close it first (eval: closeDialogs(); customization = 0)`
      );
    const heights = a.heights ?? "interpolate";
    if (!["interpolate", "nearest"].includes(heights)) fail("BAD_ARGS", "heights is 'interpolate' or 'nearest'");
    const iceMode = a.ice ?? "keep";
    if (!["keep", "regenerate"].includes(iceMode)) fail("BAD_ARGS", "ice is 'keep' or 'regenerate'");
    const relief = a.relief ?? "keep";
    if (!["keep", "redraw"].includes(relief)) fail("BAD_ARGS", "relief is 'keep' or 'redraw'");
    if (a.density === undefined) fail("BAD_ARGS", "density is required (1-13 or 1000-100000)");
    const want = targetCells(a.density);
    const shape = gridShape(want);
    const nowShape = { spacing: grid.spacing, cellsX: grid.cellsX, cellsY: grid.cellsY };
    if (
      want === grid.cellsDesired &&
      shape.spacing === nowShape.spacing &&
      shape.cellsX === nowShape.cellsX &&
      shape.cellsY === nowShape.cellsY
    )
      fail("BAD_ARGS", `the map already has this density (${want} points, ${pack.cells.i.length} cells)`);
    const gridNow = grid.points.length;
    const packNow = pack.cells.i.length;
    // pack = land grid cells (scale with the point count) + the water rings and coastline
    // refinement points along the coasts (scale with the coast length in cells, the square root)
    const ratio = shape.points / gridNow;
    const landGrid = new Set();
    for (const i of pack.cells.i) if (pack.cells.h[i] >= 20) landGrid.add(pack.cells.g[i]);
    const landNow = landGrid.size;
    const packEst = Math.round(landNow * ratio + (packNow - landNow) * Math.sqrt(ratio));
    const warnings = [];
    if (shape.points < gridNow)
      warnings.push(
        "lowering the density merges cells: burgs that end in one cell are moved to a free neighbour (or lost if there is none), and islands, lakes and zones smaller than a new cell can vanish"
      );
    if (want > 50000)
      warnings.push("over 50K cells the app gets slow to draw and edit (the Options slider marks it red)");
    return { want, shape, heights, iceMode, relief, gridNow, packNow, packEst, warnings };
  }

  /**
   * Lowering the density: about how many burgs will share a new cell (moved to a free neighbour,
   * lost if none) and how many lakes and islands are smaller than one new cell (kept as one cell
   * by 'interpolate' where there is room; 'nearest' can lose them).
   */
  function lowerRisk(spacing) {
    const buckets = new Map();
    for (const b of pack.burgs) {
      if (!isLive(b) || !b.i) continue;
      const k = `${Math.floor(b.x / spacing)},${Math.floor(b.y / spacing)}`;
      buckets.set(k, (buckets.get(k) || 0) + 1);
    }
    let sharing = 0;
    for (const n of buckets.values()) if (n > 1) sharing += n - 1;
    const cellArea = spacing * spacing;
    const small = { lakes: 0, islands: 0 };
    for (const f of pack.features || []) {
      if (!f || typeof f !== "object" || !(f.area < cellArea)) continue;
      if (f.type === "lake") small.lakes++;
      else if (f.type === "island") small.islands++;
    }
    return { burgsSharingACell: sharing, smallerThanACell: small };
  }

  // ---------------------------------------------------------------- inventory (before/after)

  const AREA_LISTS = () => [
    ["state", pack.states, "state"],
    ["province", pack.provinces, "province"],
    ["culture", pack.cultures, "culture"],
    ["religion", pack.religions, "religion"]
  ];

  function areaBy(field) {
    const C = pack.cells;
    const out = new Map();
    const arr = C[field];
    if (!arr) return out;
    for (const i of C.i) {
      const v = arr[i];
      if (v) out.set(v, (out.get(v) || 0) + C.area[i]);
    }
    return out;
  }

  function zoneArea(z) {
    const C = pack.cells;
    let s = 0;
    for (const c of z.cells || []) if (c >= 0 && c < C.i.length) s += C.area[c];
    return s;
  }

  function inventory() {
    T.resetMemo?.();
    const inv = {};
    inv.burg = new Map();
    for (const b of pack.burgs) if (isLive(b) && b.i) inv.burg.set(b.i, { name: b.name, x: b.x, y: b.y });
    for (const [type, list, field] of AREA_LISTS()) {
      const area = areaBy(field);
      inv[type] = new Map();
      for (const x of list) if (isLive(x) && x.i) inv[type].set(x.i, { name: x.name, area: area.get(x.i) || 0 });
    }
    inv.river = new Map();
    for (const r of pack.rivers || []) if (isLive(r)) inv.river.set(r.i, { name: I.nameOf("river", r) });
    inv.route = new Map();
    for (const r of pack.routes || []) if (isLive(r)) inv.route.set(r.i, { name: I.nameOf("route", r) });
    inv.marker = new Map();
    for (const m of pack.markers || [])
      if (isLive(m))
        inv.marker.set(m.i, { name: I.nameOf("marker", m), x: m.x, y: m.y, land: pack.cells.h[m.cell] >= 20 });
    inv.zone = new Map();
    for (const z of pack.zones || []) if (isLive(z)) inv.zone.set(z.i, { name: z.name, area: zoneArea(z) });
    inv.label = new Map();
    for (const l of I.rawList("label")) inv.label.set(l.id, { name: l.name });
    inv.note = new Map();
    for (const n of Array.isArray(notes) ? notes : []) if (n?.id) inv.note.set(n.id, { name: n.name });
    const C = pack.cells;
    let land = 0;
    let total = 0;
    for (const i of C.i) {
      total += C.area[i];
      if (C.h[i] >= 20) land += C.area[i];
    }
    const feats = { lakes: 0, islands: 0, oceans: 0, named: new Set() };
    for (const f of pack.features || []) {
      if (!f || typeof f !== "object") continue;
      if (f.type === "lake") feats.lakes++;
      if (f.type === "island") feats.islands++;
      if (f.type === "ocean") feats.oceans++;
      if (f.name) feats.named.add(`${f.type}: ${f.name}`);
    }
    return {
      inv,
      cells: C.i.length,
      gridCells: grid.points.length,
      cellsDesired: grid.cellsDesired,
      landPct: rn((100 * land) / (graphWidth * graphHeight), 2),
      packAreaPct: rn((100 * total) / (graphWidth * graphHeight), 2),
      feats,
      ice: (pack.ice || []).length
    };
  }

  const POINT_TYPES = ["burg", "marker"];
  const AREA_TYPES = ["state", "province", "culture", "religion", "zone"];
  const OTHER_TYPES = ["river", "route", "label", "note"];

  function compare(b, a, details) {
    const out = {};
    const lostAll = {};
    const wet = []; // markers that were on land and whose cell is water now (the coast moved)
    for (const type of [...POINT_TYPES, ...AREA_TYPES, ...OTHER_TYPES]) {
      const B = b.inv[type];
      const A = a.inv[type];
      const row = { kept: 0, lost: 0 };
      const lost = [];
      const moved = [];
      const areaChanges = [];
      let maxMove = 0;
      for (const [id, x] of B) {
        const y = A.get(id);
        // an area that had territory and has none now is lost too (its object may remain)
        if (!y || (AREA_TYPES.includes(type) && x.area > 0 && !(y.area > 0))) {
          row.lost++;
          lost.push(`${x.name ?? type} (${id})`);
          continue;
        }
        row.kept++;
        if (type === "marker" && x.land && y.land === false) wet.push(`${x.name ?? "marker"} (${id})`);
        if (POINT_TYPES.includes(type)) {
          const d = Math.hypot((y.x ?? 0) - (x.x ?? 0), (y.y ?? 0) - (x.y ?? 0));
          if (d > 0.5) moved.push({ name: x.name, i: id, px: rn(d, 1) });
          maxMove = Math.max(maxMove, d);
        }
        if (AREA_TYPES.includes(type) && x.area > 0)
          areaChanges.push({ name: `${x.name ?? type} (${id})`, pct: rn((100 * (y.area - x.area)) / x.area, 1) });
      }
      if (POINT_TYPES.includes(type)) {
        row.moved = moved.length;
        row.maxMovePx = rn(maxMove, 1);
        if (details && moved.length) {
          row.movedList = moved.sort((p, q) => q.px - p.px).slice(0, 50);
          if (moved.length > 50) row.movedMore = moved.length - 50;
        }
      }
      if (AREA_TYPES.includes(type)) {
        areaChanges.sort((p, q) => Math.abs(q.pct) - Math.abs(p.pct));
        const top = areaChanges[0];
        row.maxAreaChangePct = top ? Math.abs(top.pct) : 0;
        if (top?.pct) row.maxAreaChangeOf = top.name;
        // signed % change of the areas that changed most (area = territory on the new grid)
        if (details && areaChanges.length) row.largestAreaChanges = areaChanges.slice(0, 5);
      }
      if (lost.length) {
        row.lostNames = lost.slice(0, 50);
        lostAll[type] = lost;
      }
      out[type] = row;
    }
    const namedLost = [...b.feats.named].filter(n => !a.feats.named.has(n));
    out.feature = {
      lakes: { before: b.feats.lakes, after: a.feats.lakes },
      islands: { before: b.feats.islands, after: a.feats.islands },
      oceans: { before: b.feats.oceans, after: a.feats.oceans },
      named: { before: b.feats.named.size, after: a.feats.named.size }
    };
    if (namedLost.length) out.feature.namesLost = namedLost.slice(0, 50);
    if (wet.length) out.marker.nowOnWater = wet.length;
    return { entities: out, lostAll, namedLost, wet };
  }

  /** Notes whose entity did not survive (the note itself is kept). */
  function orphanedNotes(lostAll) {
    const PREFIX = { burg: "burg", marker: "marker", route: "route", river: "river", zone: "zone" };
    const gone = new Set();
    for (const [type, prefix] of Object.entries(PREFIX))
      for (const s of lostAll[type] || []) {
        const m = /\((\d+)\)$/.exec(s);
        if (m) gone.add(`${prefix}${m[1]}`);
      }
    return (Array.isArray(notes) ? notes : []).filter(n => n?.id && gone.has(n.id)).map(n => n.id);
  }

  // ---------------------------------------------------------------- what undraw()/process() drop

  function capture() {
    const labelNodes = [];
    // custom labels, and state labels (drawStateLabels skips locked states, so theirs would go)
    for (const t of document.querySelectorAll('#labels text[id^="label"], #labels text[id^="stateLabel"]')) {
      const tp = t.querySelector("textPath");
      const href = tp ? tp.getAttribute("href") || tp.getAttribute("xlink:href") : null;
      const path = href?.startsWith("#") ? document.getElementById(href.slice(1)) : null;
      labelNodes.push({
        group: t.parentNode?.id || null,
        node: t.cloneNode(true),
        path: path ? path.cloneNode(true) : null
      });
    }
    const emblemDefs = [...document.querySelectorAll("#defs-emblems > [id]")].map(n => n.cloneNode(true));
    const icebergCenters = new Map();
    for (const e of pack.ice || [])
      if (e?.type === "iceberg" && grid.points[e.cellId]) icebergCenters.set(e.i, grid.points[e.cellId]);
    // territory-less states, provinces, cultures and religions (Resample removes them)
    const empty = [];
    for (const [type, list, field] of AREA_LISTS()) {
      const used = new Set(pack.cells[field]);
      for (const x of list) {
        if (!isLive(x) || !x.i || used.has(x.i)) continue;
        const c = pack.cells.p[x.center];
        empty.push({ type, i: x.i, lock: x.lock, at: c ? [c[0], c[1]] : null });
      }
    }
    return {
      empty,
      layers: layerCounts(),
      reliefHTML: document.getElementById("terrain")?.innerHTML ?? null,
      textPathIds: new Set([...(document.getElementById("textPaths")?.children || [])].map(e => e.id)),
      notes: Array.isArray(notes) ? notes : [],
      labelNodes,
      emblemDefs,
      rulers: typeof rulers !== "undefined" && rulers ? rulers.toString() : "",
      ice: JSON.parse(JSON.stringify(pack.ice || [])),
      icebergCenters,
      mapId: T.summary ? T.summary().mapId : null,
      view: T.getView(),
      density: { value: pointsInput.value, cells: pointsInput.dataset.cells }
    };
  }

  // the svg leaves main.js undraw() removes (and the per-item groups it removes in these layers)
  const LEAVES = "path, circle, polygon, line, text, use, image";
  const ITEM_GROUPS = new Set(["zones", "armies", "ruler"]);
  // geography: what the redraw shows there is the new data (a new lake or coast is real)
  const DATA_LAYERS = new Set(["ocean", "lakes", "landmass", "coastline"]);
  // animated, restarted after the redraw: its element count says nothing
  const TRANSIENT_LAYERS = new Set(["tradeAnimation"]);

  /** Layer groups (#viewbox children and their child groups) and how many elements each draws. */
  function layerCounts() {
    const out = new Map();
    for (const g of document.getElementById("viewbox")?.children || []) {
      if (g.tagName !== "g" || !g.id) continue;
      out.set(g.id, { el: g, n: g.querySelectorAll(LEAVES).length, parent: null });
      for (const c of g.children)
        if (c.tagName === "g" && c.id && !out.has(c.id))
          out.set(c.id, { el: c, n: c.querySelectorAll(LEAVES).length, parent: g.id });
    }
    return out;
  }

  /**
   * A layer that is on but was not drawn before (an empty group: the saved svg never had it, say
   * province fills or state labels) would show up after the full redraw although nothing about
   * it changed; it is emptied again so the map looks as before (the data is all there: toggling
   * the layer draws it). Returns the ids kept empty and the layers whose drawn element count
   * changed a lot (a redraw at the new density: relief icons, contours).
   */
  function keepLayerLook(before, textPathIds, iceMode) {
    const now = layerCounts();
    const keptEmpty = [];
    for (const [id, b] of before) {
      if (b.n || DATA_LAYERS.has(id) || DATA_LAYERS.has(b.parent) || TRANSIENT_LAYERS.has(id)) continue;
      if (b.parent && before.get(b.parent)?.n === 0) continue; // its parent is kept empty
      if ((id === "ice" || b.parent === "ice") && iceMode === "regenerate") continue;
      const a = now.get(id);
      if (!a?.n) continue;
      for (const el of a.el.querySelectorAll(LEAVES)) el.remove();
      if (ITEM_GROUPS.has(id)) for (const el of a.el.querySelectorAll(":scope > g")) el.remove();
      keptEmpty.push(id);
    }
    if (keptEmpty.length) {
      // text paths the emptied labels drew, which nothing uses now
      const used = new Set();
      for (const tp of document.querySelectorAll("textPath")) {
        const href = tp.getAttribute("href") || tp.getAttribute("xlink:href") || "";
        if (href.startsWith("#")) used.add(href.slice(1));
      }
      for (const el of [...(document.getElementById("textPaths")?.children || [])])
        if (el.id && !textPathIds.has(el.id) && !used.has(el.id)) el.remove();
    }
    const changed = {};
    const after = layerCounts();
    for (const [id, b] of before) {
      if (b.parent || keptEmpty.includes(id) || TRANSIENT_LAYERS.has(id)) continue;
      const n = after.get(id)?.n ?? 0;
      if (Math.abs(n - b.n) > Math.max(20, 0.25 * b.n)) changed[id] = `${b.n} -> ${n}`;
    }
    return { keptEmpty, changed };
  }

  function restoreLabels(saved) {
    const host = document.querySelector("#textPaths");
    const labelRoot = document.getElementById("labels");
    const restored = { labels: 0, stateLabels: 0 };
    for (const s of saved) {
      if (s.path && host && !document.getElementById(s.path.id)) host.appendChild(s.path);
      if (document.getElementById(s.node.id)) continue;
      let g = s.group ? document.getElementById(s.group) : null;
      if (!g && labelRoot) {
        g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        if (s.group) g.id = s.group;
        labelRoot.appendChild(g);
      }
      if (!g) continue;
      g.appendChild(s.node);
      if (s.node.id.startsWith("stateLabel")) restored.stateLabels++;
      else restored.labels++;
    }
    return restored;
  }

  function setDensity(want) {
    const el = document.getElementById("pointsInput");
    if (typeof changeCellsDensity === "function") changeCellsDensity(sliderOf(want));
    el.dataset.cells = String(want);
    const out = document.getElementById("pointsOutputFormatted");
    if (out) out.value = `${rn(want / 1000, 1)}K`;
  }

  function resetDensity(d) {
    const el = document.getElementById("pointsInput");
    el.value = d.value;
    el.dataset.cells = d.cells;
    const out = document.getElementById("pointsOutputFormatted");
    if (out) out.value = `${rn(Number(d.cells) / 1000, 1)}K`;
  }

  // ---------------------------------------------------------------- Resample patches

  function orient(ax, ay, bx, by, cx, cy) {
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  }

  /** Point location in a Delaunator triangulation by walking from the last hit (-1 outside). */
  function triangleWalker(X, Y, tri, half) {
    let t = 0;
    return (x, y) => {
      if (!tri.length) return -1;
      for (let steps = 0; steps < 50000; steps++) {
        const e0 = 3 * t;
        const s = orient(X(tri[e0]), Y(tri[e0]), X(tri[e0 + 1]), Y(tri[e0 + 1]), X(tri[e0 + 2]), Y(tri[e0 + 2]));
        let moved = false;
        for (let k = 0; k < 3; k++) {
          const u = tri[e0 + k];
          const v = tri[e0 + ((k + 1) % 3)];
          if (orient(X(u), Y(u), X(v), Y(v), x, y) * s < 0) {
            const h = half[e0 + k];
            if (h < 0) {
              t = 0;
              return -1;
            }
            t = Math.floor(h / 3);
            moved = true;
            break;
          }
        }
        if (!moved) return t;
      }
      t = 0;
      return -1;
    };
  }

  /**
   * Heights by interpolation over the old surface instead of Resample's nearest old cell.
   * Samples: the old pack cells (what the map shows, coastline refinement points included) plus
   * the old grid cells the pack dropped (open sea). A new point is land when the barycentric
   * land fraction is at least 0.5 (the coast runs through the midpoints between old land and
   * water samples, smoothly), with the height interpolated over the samples of its class only
   * (the coast neither sinks nor rises). Then the topology is repaired against the old pack
   * features: one that has no new point left (a one-cell island or lake) gets the free new point
   * nearest to it; a feature split into pieces is rejoined by the cheapest carve, preferring its
   * own nearest-sample region; an ocean keeps a path to the map edge (else it becomes a lake).
   */
  function interpolateGrid(parentMap, projection, inverse, report) {
    const n = grid.points.length;
    const PC = parentMap.pack.cells;
    const PG = parentMap.grid;
    const inPack = new Uint8Array(PG.points.length);
    const xy = [];
    const hs = [];
    const gs = [];
    for (const i of PC.i) {
      xy.push(PC.p[i][0], PC.p[i][1]);
      hs.push(PC.h[i]);
      gs.push(PC.g[i]);
      inPack[PC.g[i]] = 1;
    }
    const packN = hs.length;
    for (let g = 0; g < PG.points.length; g++) {
      if (inPack[g]) continue;
      xy.push(PG.points[g][0], PG.points[g][1]);
      hs.push(PG.cells.h[g]);
      gs.push(g);
    }
    const m = hs.length;
    const X = k => xy[2 * k];
    const Y = k => xy[2 * k + 1];
    // sample features are the old pack features (what the map showed); an open-sea grid sample
    // takes the pack feature most pack cells of its grid feature belong to
    const PF = parentMap.pack.features;
    const votes = new Map();
    for (const i of PC.i) {
      const key = `${PG.cells.f[PC.g[i]]}:${PC.f[i]}`;
      votes.set(key, (votes.get(key) || 0) + 1);
    }
    const gridToPack = new Map();
    for (const [key, k] of votes) {
      const [gf, pf] = key.split(":").map(Number);
      if (!gridToPack.has(gf) || k > gridToPack.get(gf).k) gridToPack.set(gf, { pf, k });
    }
    const sampleF = k => (k < packN ? PC.f[k] : (gridToPack.get(PG.cells.f[gs[k]])?.pf ?? 0));
    const landF = f => !!PF[f]?.land;
    const del = new Delaunator(Float64Array.from(xy));
    const locate = triangleWalker(X, Y, del.triangles, del.halfedges);
    const tri = del.triangles;
    const q = d3.quadtree(
      Array.from({ length: m }, (_, k) => k),
      k => X(k),
      k => Y(k)
    );
    const cls = new Uint8Array(n); // 1 = land
    const conf = new Float32Array(n); // how far the land fraction is from the 0.5 threshold
    const nnF = new Int32Array(n); // old pack feature of the nearest sample
    const nnS = new Int32Array(n); // the nearest sample
    const hLand = new Float32Array(n).fill(-1);
    const hWater = new Float32Array(n).fill(-1);
    const temp = new Int8Array(n);
    const prec = new Uint8Array(n);
    let outside = 0;
    for (let g = 0; g < n; g++) {
      const [x, y] = inverse(grid.points[g][0], grid.points[g][1]);
      const tt = locate(x, y);
      let ids;
      let ws;
      if (tt < 0) {
        outside++;
        ids = [q.find(x, y)];
        ws = [1];
      } else {
        const a = tri[3 * tt];
        const b = tri[3 * tt + 1];
        const c = tri[3 * tt + 2];
        const den = orient(X(a), Y(a), X(b), Y(b), X(c), Y(c));
        const wa = Math.max(0, orient(X(b), Y(b), X(c), Y(c), x, y) / den);
        const wb = Math.max(0, orient(X(c), Y(c), X(a), Y(a), x, y) / den);
        const wc = Math.max(0, orient(X(a), Y(a), X(b), Y(b), x, y) / den);
        const sum = wa + wb + wc || 1;
        ids = [a, b, c];
        ws = [wa / sum, wb / sum, wc / sum];
      }
      let landW = 0;
      let lh = 0;
      let wh = 0;
      let tp = 0;
      let pr = 0;
      let best = ids[0];
      let bd = Infinity;
      for (let k = 0; k < ids.length; k++) {
        const v = ids[k];
        if (hs[v] >= 20) {
          landW += ws[k];
          lh += ws[k] * hs[v];
        } else wh += ws[k] * hs[v];
        tp += ws[k] * PG.cells.temp[gs[v]];
        pr += ws[k] * PG.cells.prec[gs[v]];
        const d = (X(v) - x) ** 2 + (Y(v) - y) ** 2;
        if (d < bd) {
          bd = d;
          best = v;
        }
      }
      cls[g] = landW >= 0.5 ? 1 : 0;
      conf[g] = Math.abs(landW - 0.5);
      if (landW > 0) hLand[g] = lh / landW;
      if (landW < 1) hWater[g] = wh / (1 - landW);
      nnF[g] = sampleF(best);
      nnS[g] = best;
      temp[g] = Math.max(-128, Math.min(127, Math.round(tp)));
      prec[g] = Math.max(0, Math.min(255, Math.round(pr)));
    }

    // 1. every old pack sample keeps the class of the new point nearest to it when that point
    // lies in its own region (interpolation alone rounds off thin peninsulas and inlets)
    const C = grid.cells.c;
    const B = grid.cells.b;
    const qNew = d3.quadtree(
      Array.from({ length: n }, (_, g) => g),
      g => grid.points[g][0],
      g => grid.points[g][1]
    );
    const fallbackH = new Int16Array(n).fill(-1);
    let claimed = 0;
    for (let v = 0; v < packN; v++) {
      const [px, py] = projection(X(v), Y(v));
      const g = qNew.find(px, py);
      if (g === undefined || nnS[g] !== v) continue;
      const land = hs[v] >= 20 ? 1 : 0;
      if (cls[g] === land) continue;
      cls[g] = land;
      conf[g] = 0;
      fallbackH[g] = hs[v];
      claimed++;
    }

    // 2. an old feature with no new point of its class left (a one-cell island or lake that fell
    // between the new points) gets the free new point nearest to one of its samples
    const inClass = g => cls[g] === (landF(nnF[g]) ? 1 : 0);
    const alive = new Set();
    for (let g = 0; g < n; g++) if (inClass(g)) alive.add(nnF[g]);
    const vanished = new Map();
    for (let v = 0; v < packN; v++) {
      const f = sampleF(v);
      if (alive.has(f) || !PF[f]) continue;
      const list = vanished.get(f);
      if (list) list.push(v);
      else vanished.set(f, [v]);
    }
    const forcedH = new Int16Array(n).fill(-1);
    let forced = 0;
    if (vanished.size) {
      const d2 = (g, px, py) => (grid.points[g][0] - px) ** 2 + (grid.points[g][1] - py) ** 2;
      for (const [f, samples] of vanished) {
        let best = -1;
        let bv = -1;
        let bd = Infinity;
        for (const v of samples) {
          const [px, py] = projection(X(v), Y(v));
          const g0 = qNew.find(px, py);
          if (g0 === undefined) continue;
          for (const g of [g0, ...C[g0]]) {
            if (forcedH[g] >= 0) continue;
            const d = d2(g, px, py);
            if (d < bd) {
              bd = d;
              best = g;
              bv = v;
            }
          }
        }
        if (best < 0) continue;
        cls[best] = landF(f) ? 1 : 0;
        nnF[best] = f;
        forcedH[best] = hs[bv];
        forced++;
      }
    }

    // and an old province, state, culture or religion whose land all falls between the new
    // points (Resample gives a new land cell the area of its nearest old land cell, and drops
    // areas left without cells) gets a new land point whose nearest old land cell is its own
    const landSamples = [];
    for (let v = 0; v < packN; v++) if (hs[v] >= 20) landSamples.push(v);
    const qLand = d3.quadtree(landSamples, X, Y);
    const nearestLand = g => qLand.find(...inverse(grid.points[g][0], grid.points[g][1]));
    const fields = AREA_FIELDS.filter(k => PC[k]);
    const areaAlive = fields.map(() => new Set());
    const markAlive = s => {
      fields.forEach((k, j) => {
        areaAlive[j].add(PC[k][s]);
      });
    };
    for (let g = 0; g < n; g++) {
      if (!cls[g]) continue;
      const s = nearestLand(g);
      if (s !== undefined) markAlive(s);
    }
    let keptAreas = 0;
    fields.forEach((k, j) => {
      const missing = new Map();
      for (const v of landSamples) {
        const id = PC[k][v];
        if (!id || areaAlive[j].has(id)) continue;
        const list = missing.get(id);
        if (list) list.push(v);
        else missing.set(id, [v]);
      }
      for (const [id, samples] of missing) {
        if (areaAlive[j].has(id)) continue;
        let best = -1;
        let bv = -1;
        let bd = Infinity;
        for (const v of samples) {
          const [px, py] = projection(X(v), Y(v));
          const g0 = qNew.find(px, py);
          if (g0 === undefined) continue;
          for (const g of [g0, ...C[g0]]) {
            if (forcedH[g] >= 0) continue;
            const s = nearestLand(g);
            if (s === undefined || PC[k][s] !== id) continue;
            const d = (grid.points[g][0] - px) ** 2 + (grid.points[g][1] - py) ** 2;
            if (d < bd) {
              bd = d;
              best = g;
              bv = s;
            }
          }
        }
        if (best < 0) continue;
        cls[best] = 1;
        nnF[best] = sampleF(bv);
        forcedH[best] = hs[bv];
        markAlive(bv);
        keptAreas++;
      }
    });

    // 3. rejoin features that came apart (a piece of one or two points that cannot be rejoined
    // is dropped). A carve is the cheapest path: points already of the
    // class and feature are free, flipping a point near the feature costs 1, flipping another
    // feature's point 3, running through another feature of the class (merging it) 4.
    const components = () => {
      const comp = new Int32Array(n).fill(-1);
      const comps = [];
      for (let g = 0; g < n; g++) {
        if (comp[g] >= 0 || !inClass(g)) continue;
        const f = nnF[g];
        const id = comps.length;
        const members = [g];
        comp[g] = id;
        let edge = !!B[g];
        for (let k = 0; k < members.length; k++)
          for (const y of C[members[k]])
            if (comp[y] < 0 && nnF[y] === f && cls[y] === cls[g]) {
              comp[y] = id;
              members.push(y);
              if (B[y]) edge = true;
            }
        comps.push({ f, members, edge });
      }
      const byF = new Map();
      comps.forEach((c, id) => {
        const a = byF.get(c.f);
        if (a) a.push(id);
        else byF.set(c.f, [id]);
      });
      for (const ids of byF.values()) ids.sort((a, b) => comps[b].members.length - comps[a].members.length);
      return { comp, comps, byF };
    };
    let joined = 0;
    let dropped = 0;
    let carved = 0;
    const MAX_COST = 6;
    const cost = new Int8Array(n);
    const prev = new Int32Array(n);
    const carve = (from, f, land, isGoal) => {
      cost.fill(-1);
      const buckets = Array.from({ length: MAX_COST + 1 }, () => []);
      for (const g of from) {
        cost[g] = 0;
        prev[g] = -1;
        buckets[0].push(g);
      }
      for (let c = 0; c <= MAX_COST; c++) {
        const bucket = buckets[c];
        for (let k = 0; k < bucket.length; k++) {
          const x = bucket[k];
          if (cost[x] !== c) continue;
          if (prev[x] !== -1 && isGoal(x)) {
            for (let p = x; p !== -1; p = prev[p])
              if (cls[p] !== land || nnF[p] !== f) {
                if (cls[p] !== land) carved++;
                cls[p] = land;
                nnF[p] = f;
              }
            return true;
          }
          for (const y of C[x]) {
            const own = nnF[y] === f;
            const step = cls[y] === land ? (own ? 0 : 4) : own ? 1 : 3;
            const cy = c + step;
            if (cy > MAX_COST || (cost[y] >= 0 && cost[y] <= cy)) continue;
            cost[y] = cy;
            prev[y] = x;
            buckets[cy].push(y);
          }
        }
      }
      return false;
    };
    {
      const { comp, comps, byF } = components();
      for (const [f, ids] of byF) {
        const body = ids[0];
        for (const other of ids.slice(1)) {
          const { members } = comps[other];
          if (carve(members, f, landF(f) ? 1 : 0, y => comp[y] === body)) {
            for (const g of members) comp[g] = body;
            joined++;
          } else if (members.length <= 2 && members.every(g => forcedH[g] < 0)) {
            for (const g of members) cls[g] = cls[g] ? 0 : 1;
            dropped++;
          }
        }
      }
    }

    // 4. keep old features apart. Every point takes the old feature of its class it connects to;
    // where two old features (two islands, or a lake and other water) touch, the less certain
    // point of the contact flips; a blob that connects to no old feature of its class flips too.
    const label = new Int32Array(n);
    const relabel = () => {
      label.fill(-1);
      const queue = [];
      for (let g = 0; g < n; g++)
        if (inClass(g)) {
          label[g] = nnF[g];
          queue.push(g);
        }
      for (let k = 0; k < queue.length; k++) {
        const x = queue[k];
        for (const y of C[x])
          if (label[y] < 0 && cls[y] === cls[x]) {
            label[y] = label[x];
            queue.push(y);
          }
      }
    };
    const flip = g => {
      cls[g] = cls[g] ? 0 : 1;
      label[g] = -1;
    };
    let separated = 0;
    let spurious = 0;
    for (let round = 0; round < 3; round++) {
      relabel();
      const size = new Map();
      for (let g = 0; g < n; g++) if (label[g] >= 0) size.set(label[g], (size.get(label[g]) || 0) + 1);
      const score = g =>
        forcedH[g] >= 0 || (size.get(label[g]) || 0) <= 1 ? Infinity : (inClass(g) ? 1 : 0) + conf[g];
      let changed = 0;
      for (let g = 0; g < n; g++) {
        if (label[g] >= 0) continue;
        if (cls[g] === 0 && B[g]) continue; // open water on the edge is never spurious
        flip(g);
        spurious++;
        changed++;
      }
      for (let g = 0; g < n; g++) {
        if (label[g] < 0) continue;
        for (const y of C[g]) {
          if (label[g] < 0) break;
          if (label[y] < 0 || cls[y] !== cls[g] || label[y] === label[g]) continue;
          if (!cls[g] && PF[label[g]]?.type !== "lake" && PF[label[y]]?.type !== "lake") continue;
          const sg = score(g);
          const sy = score(y);
          if (sg === Infinity && sy === Infinity) continue;
          flip(sg <= sy ? g : y);
          separated++;
          changed++;
        }
      }
      if (!changed) break;
    }

    // 5. an old ocean (water on the map edge) must stay on the edge, or markup calls it a lake
    {
      const { comps, byF } = components();
      for (const [f, ids] of byF) {
        if (PF[f]?.type !== "ocean" || ids.some(id => comps[id].edge)) continue;
        carve(comps[ids[0]].members, f, 0, y => !!B[y]);
      }
    }

    grid.cells.h = new Uint8Array(n);
    for (let g = 0; g < n; g++) {
      if (cls[g]) {
        const v =
          forcedH[g] >= 20 ? forcedH[g] : hLand[g] >= 0 ? Math.round(hLand[g]) : fallbackH[g] >= 20 ? fallbackH[g] : 20;
        grid.cells.h[g] = Math.min(100, Math.max(20, v));
      } else {
        const fb = fallbackH[g] >= 0 && fallbackH[g] < 20 ? fallbackH[g] : 18;
        const v = forcedH[g] >= 0 && forcedH[g] < 20 ? forcedH[g] : hWater[g] >= 0 ? Math.round(hWater[g]) : fb;
        grid.cells.h[g] = Math.max(0, Math.min(19, v));
      }
    }
    // a land point between an old lake and an old ocean stays above the app's breach height
    // (openNearSeaLakes turns a lake into sea through a coast cell of height 22 or less)
    relabel();
    let dams = 0;
    for (let g = 0; g < n; g++) {
      if (!cls[g] || grid.cells.h[g] > BREACH_HEIGHT) continue;
      let lake = false;
      let ocean = false;
      for (const y of C[g]) {
        const t = cls[y] ? null : PF[label[y]]?.type;
        if (t === "lake") lake = true;
        else if (t === "ocean") ocean = true;
      }
      if (lake && ocean) {
        grid.cells.h[g] = BREACH_HEIGHT + 1;
        dams++;
      }
    }
    grid.cells.temp = temp;
    grid.cells.prec = prec;
    report.heights = {
      method: "interpolate",
      samples: m,
      claimed,
      forced,
      keptAreas,
      rejoined: joined,
      dropped,
      separated,
      spurious,
      dams,
      carved,
      outsideHull: outside
    };
  }

  /** The cell within `maxDepth` rings of `start` that passes `ok` and is closest to (x, y), or -1. */
  function nearestCellWhere(start, x, y, ok, maxDepth) {
    const C = pack.cells;
    const seen = new Set([start]);
    let ring = [start];
    for (let depth = 0; depth <= maxDepth && ring.length; depth++) {
      let best = -1;
      let bd = Infinity;
      for (const c of ring) {
        if (!ok(c)) continue;
        const d = (C.p[c][0] - x) ** 2 + (C.p[c][1] - y) ** 2;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      if (best >= 0) return best;
      const next = [];
      for (const c of ring)
        for (const nb of C.c[c])
          if (!seen.has(nb)) {
            seen.add(nb);
            next.push(nb);
          }
      ring = next;
    }
    return -1;
  }

  function edgePoint(cell, haven) {
    try {
      return Resample.getCloseToEdgePoint(cell, haven);
    } catch {
      return [pack.cells.p[cell][0], pack.cells.p[cell][1]];
    }
  }

  /**
   * After Resample.restoreBurgs: a burg it dropped because its new cell already held one moves
   * to the nearest free land cell; a coastal port whose new cell is inland moves to the nearest
   * free coastal cell (before states, provinces, routes and markets read the burg cells).
   */
  function fixBurgs(parentMap, report) {
    const C = pack.cells;
    const PH = parentMap.pack.cells.haven;
    const freeLand = c => C.h[c] >= 20 && !C.burg[c];
    const rehoused = [];
    const portsMoved = [];
    for (const pb of parentMap.pack.burgs) {
      if (!pb?.i || pb.removed) continue;
      const b = pack.burgs[pb.i];
      if (!b) continue;
      const coastalPort = !!(pb.port && PH?.[pb.cell]);
      if (b.removed) {
        const start = findCell(pb.x, pb.y);
        const best = nearestCellWhere(start, pb.x, pb.y, coastalPort ? c => freeLand(c) && C.haven[c] : freeLand, 8);
        const cell = best >= 0 ? best : nearestCellWhere(start, pb.x, pb.y, freeLand, 8);
        if (cell < 0) continue;
        const nb = { ...b, cell };
        delete nb.removed;
        if (pb.lock !== undefined) nb.lock = pb.lock;
        else delete nb.lock;
        let xy = cell === start ? [pb.x, pb.y] : [C.p[cell][0], C.p[cell][1]];
        if (nb.port && C.haven[cell]) xy = edgePoint(cell, C.haven[cell]);
        nb.x = rn(xy[0], 2);
        nb.y = rn(xy[1], 2);
        pack.burgs[pb.i] = nb;
        C.burg[cell] = pb.i;
        rehoused.push(`${pb.name} (${pb.i})`);
        continue;
      }
      if (!coastalPort || C.haven[b.cell]) continue;
      const cell = nearestCellWhere(b.cell, pb.x, pb.y, c => C.h[c] >= 20 && C.haven[c] && !C.burg[c], 3);
      if (cell < 0) continue;
      C.burg[b.cell] = 0;
      C.burg[cell] = b.i;
      const xy = edgePoint(cell, C.haven[cell]);
      Object.assign(b, { cell, x: rn(xy[0], 2), y: rn(xy[1], 2) });
      portsMoved.push(`${b.name} (${b.i})`);
    }
    report.burgsRehoused = rehoused;
    report.portsMovedToCoast = portsMoved;
  }

  /**
   * After fixBurgs: a burg of a state whose new cell carries another state (the border moved a
   * little) takes its cell for its state, as generation leaves it (cells.state[burg.cell] is the
   * burg's state), with the province of its state around it. Never the last cell of an area.
   */
  function claimBurgCells(parentMap, report) {
    const C = pack.cells;
    const PS = parentMap.pack.states || [];
    const PP = parentMap.pack.provinces || [];
    const tally = field => {
      const m = new Map();
      for (const i of C.i) m.set(C[field][i], (m.get(C[field][i]) || 0) + 1);
      return m;
    };
    const states = tally("state");
    const provinces = C.province ? tally("province") : new Map();
    const capitalOf = new Map();
    for (const p of PP) if (isLive(p) && p.i && p.burg) capitalOf.set(p.burg, p);
    const claimed = [];
    const neutral = [];
    for (const b of pack.burgs) {
      if (!isLive(b) || !b.i || !(b.cell >= 0)) continue;
      const s = b.state || 0;
      const was = C.state[b.cell];
      if (was === s) continue;
      if (!s) {
        neutral.push(`${b.name} (${b.i})`);
        continue;
      }
      if (!isLive(PS[s])) continue;
      const wasP = C.province ? C.province[b.cell] : 0;
      if ((was && states.get(was) <= 1) || (wasP && provinces.get(wasP) <= 1)) continue;
      let prov = 0;
      const cap = capitalOf.get(b.i);
      if (cap && cap.state === s) prov = cap.i;
      else if (C.province) {
        const votes = new Map();
        for (const nb of C.c[b.cell])
          if (C.state[nb] === s && C.province[nb]) votes.set(C.province[nb], (votes.get(C.province[nb]) || 0) + 1);
        let best = 0;
        for (const [k, v] of votes) if (!prov || v > best) [prov, best] = [k, v];
      }
      states.set(was, states.get(was) - 1);
      states.set(s, (states.get(s) || 0) + 1);
      C.state[b.cell] = s;
      if (C.province) {
        provinces.set(wasP, provinces.get(wasP) - 1);
        provinces.set(prov, (provinces.get(prov) || 0) + 1);
        C.province[b.cell] = prov;
      }
      claimed.push(`${b.name} (${b.i})`);
    }
    report.burgCellsClaimed = claimed;
    report.neutralBurgsInStates = neutral;
  }

  const CENTER_FIELDS = [
    ["state", "states"],
    ["province", "provinces"],
    ["culture", "cultures"],
    ["religion", "religions"]
  ];

  /**
   * After Resample.restoreProvinces (all four area types restored): every live state, province,
   * culture and religion gets a center inside its own territory. Resample leaves a province with
   * no capital burg (burg 0) without one (it reads pack.burgs[0].cell), and a center found by
   * coordinates can fall just outside after the borders moved. A state or province keeps its
   * capital's cell when that is inside; otherwise the cell of its own nearest to the old center.
   */
  function recenter(parentMap, report) {
    const C = pack.cells;
    const PC = parentMap.pack.cells;
    const n = C.i.length;
    const moved = [];
    for (const [field, list] of CENTER_FIELDS) {
      const arr = C[field];
      if (!arr || !Array.isArray(pack[list])) continue;
      let byId = null; // id -> its cells, built on first need
      for (const e of pack[list]) {
        if (!isLive(e) || !e.i) continue;
        const inside = c => Number.isInteger(c) && c >= 0 && c < n && arr[c] === e.i;
        const capId = field === "state" ? e.capital : field === "province" ? e.burg : 0;
        const cap = capId ? pack.burgs[capId] : null;
        if (isLive(cap) && inside(cap.cell)) {
          e.center = cap.cell;
          continue;
        }
        if (inside(e.center)) continue;
        const old = parentMap.pack[list]?.[e.i]?.center;
        const at = PC.p[old] || (Array.isArray(e.pole) ? e.pole : null);
        let cell = -1;
        if (at) cell = nearestCellWhere(findCell(at[0], at[1]), at[0], at[1], inside, 6);
        if (cell < 0) {
          if (!byId) {
            byId = new Map();
            for (const i of C.i) {
              const a = byId.get(arr[i]);
              if (a) a.push(i);
              else byId.set(arr[i], [i]);
            }
          }
          const own = byId.get(e.i) || [];
          let bd = Infinity;
          for (const c of own) {
            const d = at ? (C.p[c][0] - at[0]) ** 2 + (C.p[c][1] - at[1]) ** 2 : 0;
            if (d < bd) {
              bd = d;
              cell = c;
            }
          }
        }
        if (cell < 0) continue; // no territory: restored later from its old position
        e.center = cell;
        moved.push(`${field} ${e.name ?? ""} (${e.i})`);
      }
    }
    report.centersMoved = moved;
  }

  /** Recount the territory statistics the editors and find/inspect read (cells, area, people). */
  function collectAreaStats() {
    const C = pack.cells;
    if (typeof States?.collectStatistics === "function") States.collectStatistics();
    for (const [field, list] of CENTER_FIELDS.slice(1)) {
      const items = pack[list];
      const arr = C[field];
      if (!Array.isArray(items) || !arr) continue;
      const stats = new Map();
      for (const i of C.i) {
        if (C.h[i] < 20) continue;
        let t = stats.get(arr[i]);
        if (!t) {
          t = { cells: 0, area: 0, rural: 0, urban: 0 };
          stats.set(arr[i], t);
        }
        t.cells++;
        t.area += C.area[i];
        t.rural += C.pop[i];
        if (C.burg[i]) t.urban += pack.burgs[C.burg[i]]?.population || 0;
      }
      for (const e of items) {
        if (!e || typeof e !== "object" || e.removed) continue;
        const t = stats.get(e.i) || { cells: 0, area: 0, rural: 0, urban: 0 };
        // only the fields the app keeps on this object (provinces carry no cell count)
        for (const k of ["cells", "area", "rural", "urban"]) if (typeof e[k] === "number") e[k] = t[k];
      }
    }
  }

  /**
   * Each river's anchors before the regrid: its control points, or its cell centers (what the
   * renderer meanders). Resample stores the meandered line as the new control points, so every
   * resample meanders the river again: it wiggles more and its points multiply (terraform-v3:
   * the rivers data grew 60 -> 159 -> 270 KB over 10K -> 30K -> 10K).
   */
  let riverAnchors = null;
  function saveRiverAnchors(rivers) {
    riverAnchors = new Map();
    for (const r of rivers || []) {
      if (!r || !Array.isArray(r.cells) || r.cells.length < 2) continue;
      try {
        const pts =
          typeof Rivers?.getRiverPoints === "function"
            ? Rivers.getRiverPoints(r.cells, r.points ?? null)
            : r.points || r.cells.map(c => pack.cells.p[c]);
        if (pts?.length === r.cells.length)
          riverAnchors.set(r.i, { cells: [...r.cells], points: pts.map(q => [q[0], q[1]]), length: r.length });
      } catch {}
    }
  }

  /** After Resample.restoreRivers: each river follows its old anchors (one per new cell), as the rivers editor stores it. */
  function reanchorRivers(projection) {
    if (!riverAnchors) return 0;
    const R = pack.cells.r;
    let n = 0;
    for (const r of pack.rivers || []) {
      const a = riverAnchors.get(r.i);
      if (!a) continue;
      const cells = [];
      const points = [];
      a.points.forEach((pt, k) => {
        const [x, y] = projection(pt[0], pt[1]);
        if (!(x >= 0 && x <= graphWidth && y >= 0 && y <= graphHeight) && a.cells[k] !== -1) return;
        const c = a.cells[k] === -1 ? -1 : findCell(x, y);
        if (cells.length && cells[cells.length - 1] === c) return;
        cells.push(c);
        points.push([rn(x, 2), rn(y, 2)]);
      });
      if (cells.filter(c => c >= 0).length < 2) continue; // too short now: keep Resample's line
      for (const c of cells) if (c >= 0 && R && !R[c]) R[c] = r.i;
      Object.assign(r, { cells, points, source: cells[0], mouth: cells.at(-2) ?? cells[0] });
      if (typeof a.length === "number") r.length = a.length;
      n++;
    }
    return n;
  }
  let parentQ = null;
  /** Nearest old pack cell to (x, y) in old coordinates. */
  function parentCellAt(parentMap, x, y) {
    if (!parentQ || parentQ.map !== parentMap) {
      const PC = parentMap.pack.cells;
      parentQ = {
        map: parentMap,
        q: d3.quadtree(
          Array.from(PC.i),
          i => PC.p[i][0],
          i => PC.p[i][1]
        )
      };
    }
    return parentQ.q.find(x, y);
  }

  /** A group for a feature no old feature of its type matched (the app's size rules). */
  function defaultGroup(f) {
    const n = grid.cells.i.length;
    if (f.type === "island") return f.cells > n / 10 ? "continent" : f.cells > n / 1000 ? "island" : "isle";
    if (f.type === "ocean") return f.cells > n / 25 ? "ocean" : f.cells > n / 1000 ? "sea" : "gulf";
    return "freshwater";
  }

  /** The water feature a coastal port on `cell` trades on (burgs-generator's rule). */
  function portFeatureOf(cell) {
    const wf = pack.cells.f[pack.cells.haven[cell]];
    const lake = pack.features[wf];
    if (lake?.type === "lake" && lake.outlet && typeof Rivers?.resolveLakeDrainFeature === "function") {
      try {
        return Rivers.resolveLakeDrainFeature(wf) ?? wf;
      } catch {}
    }
    return wf;
  }

  /**
   * Feature details from the same-type old feature most of the new feature's cells came from
   * (Resample copies them from whatever feature one cell lands in). Features with no old
   * counterpart get the app's default group (and a lake a generated name). Then the feature
   * ids burgs hold (feature, port) are re-pointed at the new features.
   */
  function featureDetails(parentMap, inverse, report) {
    const C = pack.cells;
    const PC = parentMap.pack.cells;
    const PF = parentMap.pack.features;
    // vote by the nearest old cell of the same feature type, within two old cell spacings
    const byType = new Map();
    for (const i of PC.i) {
      const t = PF[PC.f[i]]?.type;
      if (!t) continue;
      const a = byType.get(t);
      if (a) a.push(i);
      else byType.set(t, [i]);
    }
    const qs = new Map(
      [...byType].map(([t, ids]) => [
        t,
        d3.quadtree(
          ids,
          i => PC.p[i][0],
          i => PC.p[i][1]
        )
      ])
    );
    const radius = 2 * (parentMap.grid.spacing || grid.spacing);
    const pairs = new Map(); // "newF:oldF" -> count
    for (const i of C.i) {
      const nf = pack.features[C.f[i]];
      if (!nf || !qs.has(nf.type)) continue;
      const [x, y] = inverse(C.p[i][0], C.p[i][1]);
      const pc = qs.get(nf.type).find(x, y, radius);
      if (pc === undefined) continue;
      const pf = PC.f[pc];
      const key = `${nf.i}:${pf}`;
      pairs.set(key, (pairs.get(key) || 0) + 1);
    }
    const fromOld = new Map(); // new feature -> {pf, n}
    const toNew = new Map(); // old feature -> {f, n}
    for (const [key, k] of pairs) {
      const [nf, pf] = key.split(":").map(Number);
      if (!fromOld.has(nf) || k > fromOld.get(nf).n) fromOld.set(nf, { pf, n: k });
      if (!toNew.has(pf) || k > toNew.get(pf).n) toNew.set(pf, { f: nf, n: k });
    }
    const named = [];
    for (const nf of pack.features) {
      if (!nf || typeof nf !== "object") continue;
      const pf = fromOld.get(nf.i)?.pf;
      const p = pf !== undefined ? PF[pf] : null;
      if (p) {
        // a name goes to one new feature only: the one most of the old feature went to
        const keys = toNew.get(pf)?.f === nf.i ? ["name", "group", "height"] : ["group", "height"];
        for (const k of keys) if (p[k] !== undefined && p[k] !== null && p[k] !== "") nf[k] = p[k];
        if (nf.type === "lake")
          for (const k of LAKE_KEYS)
            if (nf[k] === undefined && p[k] !== undefined) nf[k] = JSON.parse(JSON.stringify(p[k]));
      }
      if (!nf.group) nf.group = defaultGroup(nf);
      if (nf.type === "lake" && !nf.name) {
        try {
          if (nf.height === undefined) nf.height = Lakes.getHeight(nf);
          nf.name = Lakes.getName(nf);
          named.push(nf.name);
        } catch {}
      }
    }
    // feature ids held by burgs (Resample keeps the old ones)
    const dry = [];
    for (const b of pack.burgs) {
      if (!isLive(b) || !b.i) continue;
      b.feature = C.f[b.cell];
      if (!b.port) continue;
      if (C.haven[b.cell]) b.port = portFeatureOf(b.cell);
      else {
        const np = toNew.get(b.port)?.f;
        if (np) b.port = np;
        if (PC.haven?.[parentMap.pack.burgs[b.i]?.cell]) dry.push(`${b.name} (${b.i})`);
      }
    }
    report.portsWithoutWater = dry;
    report.newLakesNamed = named;
  }

  /** Route points that ended at a burg follow the burg (Resample snaps them to the nearest cell). */
  function fixRouteEnds(parentMap) {
    const PB = parentMap.pack.cells.burg;
    const parentRoutes = new Map((parentMap.pack.routes || []).map(r => [r.i, r]));
    let fixed = 0;
    for (const r of pack.routes || []) {
      const pr = parentRoutes.get(r.i);
      if (!pr || !Array.isArray(r.points) || pr.points?.length !== r.points.length) continue;
      r.points.forEach((pt, k) => {
        const oldCell = pr.points[k]?.[2];
        const bid = oldCell !== undefined ? PB[oldCell] : 0;
        const b = bid ? pack.burgs[bid] : null;
        if (!isLive(b) || pt[2] === b.cell) return;
        r.points[k] = [b.x, b.y, b.cell];
        fixed++;
      });
      if (r.points.length) r.feature = pack.cells.f[r.points[0][2]];
    }
    if (fixed) pack.cells.routes = Routes.buildLinks(pack.routes);
    return fixed;
  }

  /** Zone cells by nearest old cell (Resample unions discs around the old cell centres). */
  function zonesByNearest(parentMap, projection, inverse, report) {
    const C = pack.cells;
    const owners = new Map();
    (parentMap.pack.zones || []).forEach((z, k) => {
      for (const c of z.cells || []) {
        const a = owners.get(c);
        if (a) a.push(k);
        else owners.set(c, [k]);
      }
    });
    const lists = (parentMap.pack.zones || []).map(() => []);
    for (const i of C.i) {
      const [x, y] = inverse(C.p[i][0], C.p[i][1]);
      const ks = owners.get(parentCellAt(parentMap, x, y));
      if (ks) for (const k of ks) lists[k].push(i);
    }
    // a zone smaller than a new cell (no new cell has one of its old cells nearest) keeps the new
    // cells nearest to its old cells instead of vanishing
    const PC = parentMap.pack.cells;
    const rescued = [];
    (parentMap.pack.zones || []).forEach((z, k) => {
      if (lists[k].length || !z || z.removed) return;
      const old = (z.cells || []).filter(c => c >= 0 && PC.p[c]);
      if (!old.length) return;
      lists[k] = [...new Set(old.map(c => findCell(...projection(PC.p[c][0], PC.p[c][1]))))].filter(c => c >= 0);
      if (lists[k].length) rescued.push(`zone ${z.name ?? ""} (${z.i})`);
    });
    if (rescued.length) report.areasRescued = [...(report.areasRescued || []), ...rescued];
    pack.zones = (parentMap.pack.zones || []).map((z, k) => ({ ...z, cells: lists[k] }));
  }

  /**
   * After Resample.restoreCellData: a culture, state, religion or province that had cells but
   * got none (smaller than a new cell) takes the land cell nearest to its old centre from an
   * area that keeps others (a province only within its own state), so Resample keeps it.
   */
  function rescueAreas(parentMap, projection, report) {
    const C = pack.cells;
    const PC = parentMap.pack.cells;
    const rescued = [];
    for (const [k, list] of [
      ["culture", "cultures"],
      ["state", "states"],
      ["religion", "religions"],
      ["province", "provinces"]
    ]) {
      if (!PC[k] || !C[k]) continue;
      const had = new Set(PC[k]);
      const count = new Map();
      for (const i of C.i) count.set(C[k][i], (count.get(C[k][i]) || 0) + 1);
      for (const e of parentMap.pack[list] || []) {
        if (!e?.i || e.removed || !had.has(e.i) || count.get(e.i)) continue;
        const at = PC.p[e.center];
        if (!at) continue;
        const [x, y] = projection(at[0], at[1]);
        const ok = c => C.h[c] >= 20 && (count.get(C[k][c]) || 0) > 1 && (k !== "province" || C.state[c] === e.state);
        const cell = nearestCellWhere(findCell(x, y), x, y, ok, 4);
        if (cell < 0) continue;
        count.set(C[k][cell], count.get(C[k][cell]) - 1);
        C[k][cell] = e.i;
        count.set(e.i, 1);
        rescued.push(`${k} ${e.name} (${e.i})`);
      }
    }
    report.areasRescued = rescued;
  }

  /** Instance overrides on window.Resample for one process() call; returns the undo. */
  function patchResample(P, report) {
    const R = Resample;
    for (const k of [
      "resamplePrimaryGridData",
      "restoreCellData",
      "restoreBurgs",
      "restoreFeatureDetails",
      "restoreZones",
      "restoreRoutes"
    ])
      if (typeof R[k] !== "function")
        fail(
          "PAGE_ERROR",
          `the app's Resample has no ${k}(); this bridge needs a matching build (CF_BUILD=1 npx vite build)`
        );
    const own = {};
    if (P.heights === "interpolate")
      own.resamplePrimaryGridData = parentMap => interpolateGrid(parentMap, IDENTITY, IDENTITY, report);
    const origCells = R.restoreCellData;
    own.restoreCellData = function (parentMap, inverse, sc) {
      origCells.call(this, parentMap, inverse, sc);
      rescueAreas(parentMap, IDENTITY, report);
    };
    const origBurgs = R.restoreBurgs;
    own.restoreBurgs = function (parentMap, projection, sc) {
      origBurgs.call(this, parentMap, projection, sc);
      fixBurgs(parentMap, report);
      claimBurgCells(parentMap, report);
    };
    if (typeof R.restoreProvinces === "function") {
      const origProvinces = R.restoreProvinces;
      own.restoreProvinces = function (parentMap, ...rest) {
        origProvinces.call(this, parentMap, ...rest);
        recenter(parentMap, report);
      };
    }
    if (typeof R.restoreEconomy === "function") {
      // the economy runs once more on the new cells (deals, production, market stock, state
      // treasuries); burg treasuries are a running total (each run adds to them), so they stay
      const origEconomy = R.restoreEconomy;
      own.restoreEconomy = function (parentMap, ...rest) {
        collectAreaStats(); // state taxes read the state populations
        origEconomy.call(this, parentMap, ...rest);
        let kept = 0;
        for (const pb of parentMap.pack.burgs || []) {
          const b = pb?.i ? pack.burgs[pb.i] : null;
          if (!isLive(b)) continue;
          if (pb.treasury === undefined) delete b.treasury;
          else b.treasury = pb.treasury;
          kept++;
        }
        report.treasuriesKept = kept;
      };
    }
    if (typeof R.saveRiversData === "function" && typeof R.restoreRivers === "function") {
      const origSave = R.saveRiversData;
      own.saveRiversData = function (rivers) {
        saveRiverAnchors(rivers);
        return origSave.call(this, rivers);
      };
      const origRivers = R.restoreRivers;
      own.restoreRivers = function (riversData, projection, ...rest) {
        origRivers.call(this, riversData, projection, ...rest);
        report.riversReanchored = reanchorRivers(projection);
      };
    }
    const origRoutes = R.restoreRoutes;
    own.restoreRoutes = function (parentMap, projection) {
      origRoutes.call(this, parentMap, projection);
      report.routeEndsFixed = fixRouteEnds(parentMap);
    };
    own.restoreFeatureDetails = parentMap => featureDetails(parentMap, IDENTITY, report);
    own.restoreZones = parentMap => zonesByNearest(parentMap, IDENTITY, IDENTITY, report);
    const saved = {};
    for (const k of Object.keys(own)) {
      if (Object.hasOwn(R, k)) saved[k] = R[k];
      R[k] = own[k];
    }
    return () => {
      for (const k of Object.keys(own)) {
        if (k in saved) R[k] = saved[k];
        else delete R[k];
      }
      parentQ = null;
      riverAnchors = null;
    };
  }

  // ---------------------------------------------------------------- the call

  FNS.regrid = async a => {
    const P = prepare(a);
    const plan = {
      cells: { now: P.packNow, est: P.packEst },
      gridCells: { now: P.gridNow, after: P.shape.points },
      cellsDesired: { now: grid.cellsDesired, after: P.want },
      density: { now: sliderOf(grid.cellsDesired), after: sliderOf(P.want) },
      spacing: { now: grid.spacing, after: P.shape.spacing },
      heights: P.heights,
      ice: P.iceMode,
      relief: P.relief
    };
    if (a.phase !== "apply") {
      if (!a.dryRun) return { phase: "validate", ...plan, warnings: P.warnings }; // apply follows
      const bytes = await bytesEstimate(P.shape.points / P.gridNow, P.packEst / P.packNow, P.relief);
      if (bytes.est > WORKER_MAX_BYTES)
        P.warnings.push(
          `about ${rn(bytes.est / 1e6, 1)} MB: over the shared map's 64 MB limit, so it could not be saved there`
        );
      const atRisk = P.shape.points < P.gridNow ? lowerRisk(P.shape.spacing) : undefined;
      return {
        phase: "validate",
        ...plan,
        bytes: { ...bytes, note: "approximate (layer growth measured on two maps); now = what the page would save" },
        ...(atRisk ? { atRisk } : {}),
        warnings: P.warnings
      };
    }

    const t0 = performance.now();
    const report = {};
    const before = inventory();
    const keep = capture();
    if (typeof closeDialogs === "function") closeDialogs();
    setDensity(P.want);
    const unpatch = patchResample(P, report);
    try {
      undraw();
      notes = keep.notes; // undraw() empties notes; process() carries them over from here
      Resample.process({ projection: IDENTITY, inverse: IDENTITY, scale: 1, keepId: true });
    } catch (e) {
      resetDensity(keep.density);
      throw e;
    } finally {
      unpatch();
    }
    const regenerated = [
      "lakes and coastline features (re-detected from the new heights)",
      "temperature (recomputed from latitude and height)",
      "economy (regenerateEconomy on the new cells: burg product and production, deals, market stock and state treasuries are recomputed; burg treasuries are kept)",
      P.relief === "keep"
        ? "every drawn layer from the data except relief icons, kept as drawn (relief:'redraw' places them on the new cells)"
        : "every drawn layer from the data, relief icons included (their count follows the cells; see layers)"
    ];
    const generatedIce = (pack.ice || []).length;
    if (P.iceMode === "keep") {
      pack.ice = keep.ice.map(e => {
        const c = e.type === "iceberg" ? keep.icebergCenters.get(e.i) : null;
        return c ? { ...e, cellId: findGridCell(c[0], c[1]) } : e;
      });
    } else
      regenerated.push(
        `ice (${generatedIce} pieces from the new temperatures; the old ${keep.ice.length} were dropped)`
      );
    // Resample removes a state/province/culture/religion that has no cells; one that had none
    // before (a folk religion absorbed by another, say) is the same entity still: put it back
    const lists = Object.fromEntries(AREA_LISTS().map(([type, list]) => [type, list]));
    for (const e of keep.empty) {
      const x = lists[e.type][e.i];
      if (!x?.removed) continue;
      delete x.removed;
      if (e.lock !== undefined) x.lock = e.lock;
      else delete x.lock;
      if (e.at) x.center = findCell(e.at[0], e.at[1]);
    }
    if (keep.rulers) {
      rulers = new Rulers();
      rulers.fromString(keep.rulers);
    }
    collectAreaStats();
    drawLayers();
    const reliefEl = document.getElementById("terrain");
    if (P.relief === "keep" && reliefEl && keep.reliefHTML !== null) reliefEl.innerHTML = keep.reliefHTML;
    const labelsRestored = restoreLabels(keep.labelNodes);
    const layers = keepLayerLook(keep.layers, keep.textPathIds, P.iceMode);
    const emblemHost = document.getElementById("defs-emblems");
    if (emblemHost) for (const n of keep.emblemDefs) if (!document.getElementById(n.id)) emblemHost.appendChild(n);
    const warnings = [...P.warnings];
    if (keep.mapId !== null && T.summary().mapId !== keep.mapId) {
      // an app build without the tupaia-mcp Resample change stamps a new id; the map is the same map
      mapId = keep.mapId;
      window.mapId = keep.mapId;
      warnings.push("this dist predates the lineage-keeping Resample (rebuild dist); the map id was put back");
    }
    await T.setView({ x: keep.view.x, y: keep.view.y, scale: keep.view.scale });
    if (typeof invokeActiveZooming === "function") invokeActiveZooming();
    await T.settle();
    const after = inventory();
    const cmp = compare(before, after, !!a.details);
    const orphaned = orphanedNotes(cmp.lostAll);
    cmp.entities.note.orphaned = orphaned.length;
    if (orphaned.length) cmp.entities.note.orphanedIds = orphaned.slice(0, 50);
    cmp.entities.label.restored = labelsRestored.labels;
    if (labelsRestored.stateLabels) cmp.entities.label.stateLabelsKept = labelsRestored.stateLabels;
    cmp.entities.ice = { before: before.ice, after: after.ice, mode: P.iceMode };
    const names = (list, k = 10) =>
      `${list.slice(0, k).join(", ")}${list.length > k ? ` (+${list.length - k} more)` : ""}`;
    if (report.burgsRehoused?.length)
      warnings.push(
        `${report.burgsRehoused.length} burg(s) shared a new cell with another and were moved to the nearest free land cell: ${names(report.burgsRehoused)}`
      );
    if (report.portsMovedToCoast?.length)
      warnings.push(
        `${report.portsMovedToCoast.length} port(s) ended inland and were moved to the nearest free coastal cell: ${names(report.portsMovedToCoast)}`
      );
    if (report.areasRescued?.length)
      warnings.push(
        `${report.areasRescued.length} area(s) fell between the new cells and were given the cells nearest their old ones: ${names(report.areasRescued)}`
      );
    if (report.portsWithoutWater?.length)
      warnings.push(`port burg(s) with no water next to them now: ${names(report.portsWithoutWater)}`);
    if (report.neutralBurgsInStates?.length)
      warnings.push(
        `${report.neutralBurgsInStates.length} burg(s) of no state now sit on a state's cell: ${names(report.neutralBurgsInStates)}`
      );
    if (cmp.wet.length)
      warnings.push(`${cmp.wet.length} marker(s) on land before now sit on water (the coast moved): ${names(cmp.wet)}`);
    if (report.newLakesNamed?.length)
      regenerated.push(
        `${report.newLakesNamed.length} new lake(s) with no old counterpart, named: ${names(report.newLakesNamed, 5)}`
      );
    if (P.iceMode === "keep" && keep.ice.length)
      warnings.push(
        "ice was kept as drawn: glacier outlines follow the old cell edges (ice:'regenerate' redraws them)"
      );
    // the names are in entities.<type>.lostNames and entities.feature.namesLost
    const lostCounts = Object.entries(cmp.lostAll).map(([type, list]) => `${list.length} ${type}`);
    if (lostCounts.length) warnings.push(`lost: ${lostCounts.join(", ")} (names in entities.*.lostNames)`);
    if (cmp.namedLost.length)
      warnings.push(`${cmp.namedLost.length} feature name(s) lost (entities.feature.namesLost)`);
    if (layers.keptEmpty.length)
      warnings.push(
        `layer(s) on but not drawn before were kept undrawn so the map looks the same: ${layers.keptEmpty.join(", ")} (toggling the layer draws it)`
      );
    const fixed = {};
    for (const [k, v] of [
      ["burgsRehoused", report.burgsRehoused],
      ["portsMovedToCoast", report.portsMovedToCoast],
      ["areasRescued", report.areasRescued],
      ["burgCellsClaimed", report.burgCellsClaimed],
      ["centersMoved", report.centersMoved]
    ])
      if (v?.length) fixed[k] = a.details ? v.slice(0, 50) : v.length;
    if (report.routeEndsFixed) fixed.routeEndsFixed = report.routeEndsFixed;
    const heights = report.heights ?? { method: "nearest" };
    if (a.details && report.heights) heights.legend = HEIGHTS_LEGEND;
    const { prepareMapData } = await lazy.save();
    return {
      cells: { before: before.cells, after: after.cells },
      gridCells: { before: before.gridCells, after: after.gridCells },
      cellsDesired: { before: before.cellsDesired, after: after.cellsDesired },
      density: plan.density,
      landPct: { before: before.landPct, after: after.landPct },
      heights,
      entities: cmp.entities,
      fixed,
      layers: {
        keptEmpty: layers.keptEmpty,
        ...(Object.keys(layers.changed).length ? { redrawn: layers.changed } : {})
      },
      regenerated,
      warnings,
      bytes: prepareMapData().length,
      mapId: T.summary().mapId,
      digest: FNS.digest().hash,
      ms: Math.round(performance.now() - t0)
    };
  };
})(globalThis);
