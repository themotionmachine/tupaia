// Page-side half of the parity fixture. A classic script (no imports, no types): the builder injects it with
// addInitScript, and a golden or replay run can inject the same file to call `__parity.census()` and
// `__parity.preamble()` on any arm. Bare identifiers (pack, grid, notes, rulers, layerIsOn ...) are the app's
// own runtime globals, exactly as docs/architecture/runtime_api.md describes. Nothing here uses Math.random: every
// choice is a function of the generated map, so the same seed gives the same fixture.
(() => {
  const root = globalThis;
  const P = {};
  const LAYER_BUTTONS = [
    "toggleTexture", "toggleHeight", "toggleBiomes", "toggleCells", "toggleGrid", "toggleCoordinates",
    "toggleCompass", "toggleRivers", "toggleRelief", "toggleReligions", "toggleCultures", "toggleStates",
    "toggleProvinces", "toggleZones", "toggleBorders", "toggleRoutes", "toggleTemperature", "togglePopulation",
    "toggleIce", "togglePrecipitation", "toggleEmblems", "toggleLabels", "toggleBurgIcons", "toggleMilitary",
    "toggleMarkers", "toggleTrade", "toggleGoods", "toggleMarketsLayer", "toggleRulers", "toggleScaleBar",
    "toggleVignette", "toggleLakes"
  ];
  const r1 = v => Math.round(v * 10) / 10;
  const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  const isLand = c => pack.cells.h[c] >= 20;

  // ----------------------------------------------------------------- anchor and cameras

  /** The showcase anchor: the largest coastal state's biggest port, kept clear of the map edges. */
  P.anchor = () => {
    const states = pack.states.filter(s => s && s.i && !s.removed).sort((a, b) => (b.area || 0) - (a.area || 0));
    const inside = b => b.x > 190 && b.x < graphWidth - 190 && b.y > 120 && b.y < graphHeight - 120;
    for (const s of states) {
      const ports = pack.burgs
        .filter(b => b && b.i && !b.removed && b.state === s.i && b.port && inside(b))
        .sort((a, b) => (b.population || 0) - (a.population || 0) || a.i - b.i);
      if (ports.length) return { x: ports[0].x, y: ports[0].y, burg: ports[0].i, state: s.i };
    }
    const b = pack.burgs.find(b => b && b.i && !b.removed && inside(b)) || pack.burgs.find(b => b && b.i);
    return { x: b.x, y: b.y, burg: b.i, state: b.state };
  };

  /** Cells within `radius` of (x, y), nearest first, ties by id, filtered by `keep`. */
  const nearCells = (x, y, radius, keep) =>
    findAll(x, y, radius)
      .filter(keep)
      .map(c => ({ c, d: dist2(pack.cells.p[c], [x, y]) }))
      .sort((a, b) => a.d - b.d || a.c - b.c)
      .map(o => o.c);

  // ----------------------------------------------------------------- build steps (each is one user-level edit)

  /** Settings that make halo and coastline filter render: Best quality shape rendering. */
  P.settings = () => {
    const el = document.getElementById("shapeRendering");
    el.value = "geometricPrecision";
    setRendering("geometricPrecision");
    invokeActiveZooming();
    return {
      shapeRendering: el.value,
      haloPaths: document.querySelectorAll("#statesHalo > path").length,
      seaIslandFilter: coastline.select("#sea_island").attr("filter"),
      autoFilter: coastline.select("#sea_island").attr("auto-filter")
    };
  };

  /** Lakes: spread the lakes over the six stock groups so every group has a member. */
  P.lakes = () => {
    const groups = ["freshwater", "salt", "sinkhole", "frozen", "lava", "dry"];
    const lakesList = pack.features.filter(f => f && f.type === "lake").sort((a, b) => a.i - b.i);
    lakesList.forEach((f, n) => {
      f.group = groups[n % groups.length];
    });
    drawFeatures();
    return lakesList.map(f => f.group);
  };

  P.regiments = cfg => {
    const A = P.anchor();
    const state = pack.states[A.state];
    state.military = state.military || [];
    const military = state.military;
    const land = nearCells(A.x, A.y, 90, c => isLand(c));
    const water = nearCells(A.x, A.y, 160, c => !isLand(c));
    const next = () => (military.length ? Math.max(...military.map(m => m.i)) + 1 : 0);
    const made = [];
    const add = (name, a, cell, extra) => {
      const [x, y] = pack.cells.p[cell];
      const reg = Object.assign(
        { a, cell, i: next(), n: 0, u: { infantry: a }, x, y, bx: x, by: y, state: state.i, icon: "⚔️", name, t: a, s: 0, type: "infantry" },
        extra || {}
      );
      military.push(reg);
      notes.push({ id: `regiment${state.i}-${reg.i}`, name, legend: "Parity fixture regiment." });
      made.push(`${state.i}-${reg.i}`);
      return reg;
    };
    // land: plain, rotated three ways, wide number, image icon (data:), emoji icon
    const L = k => land[k % land.length];
    const W = k => water[k % water.length];
    add("Parity plain", 1200, L(6));
    add("Parity rot 30", 3400, L(14), { angle: 30, icon: "🏹" });
    add("Parity rot -60", 800, L(22), { angle: -60, icon: "🛡️" });
    add("Parity rot 90", 56000, L(30), { angle: 90, icon: "👑" });
    add("Parity image", 2100, L(38), { icon: cfg.pngDataUri });
    add("Parity svg image", 640, L(46), { icon: cfg.svgDataUri, angle: -15 });
    // naval: plain, rotated, image
    add("Parity fleet", 40, W(4), { n: 1, icon: "🌊" });
    add("Parity fleet rot 45", 1800, W(12), { n: 1, angle: 45, icon: "⚓" });
    add("Parity fleet image", 75, W(20), { n: 1, icon: cfg.pngDataUri, angle: -30 });
    drawMilitary();
    return made;
  };

  P.markers = cfg => {
    const A = P.anchor();
    const land = nearCells(A.x, A.y, 75, c => isLand(c) && !pack.cells.burg[c]);
    const shapes = ["bubble", "pin", "square", "squarish", "diamond", "hex", "hexy", "shieldy", "shield", "pentagon", "heptagon", "circle"];
    const emoji = ["🏰", "🗡️", "🇯🇵", "👩🏽‍🚀", "🏴‍☠️", "🧙🏿", "🐉", "💎"];
    const made = [];
    const push = (spec, k) => {
      const cell = land[k % land.length];
      const [x, y] = pack.cells.p[cell];
      const i = pack.markers.length ? Math.max(...pack.markers.map(m => m.i)) + 1 : 0;
      const m = Object.assign({ i, x, y, cell, type: "parity", dx: 50, dy: 50, px: 12, size: 30 }, spec);
      pack.markers.push(m);
      notes.push({ id: `marker${i}`, name: `Parity marker ${i}`, legend: `<p>Parity fixture marker ${i}.</p>` });
      made.push(i);
    };
    // every pin shape, each with an emoji; fills and strokes differ; sizes and offsets differ
    shapes.forEach((pin, n) =>
      push(
        {
          icon: emoji[n % emoji.length],
          pin,
          fill: ["#ffffff", "#ffd54f", "#4fc3f7", "#ef9a9a"][n % 4],
          stroke: ["#000000", "#5d4037", "#01579b", "#b71c1c"][n % 4],
          size: [30, 24, 36, 42][n % 4],
          px: [12, 14, 10, 16][n % 4],
          dx: [50, 46, 54][n % 3],
          dy: [50, 56, 44][n % 3]
        },
        2 + n * 4
      )
    );
    // external icons: a data:image PNG and a data:image SVG
    push({ icon: cfg.pngDataUri, pin: "bubble", fill: "#c5e1a5", stroke: "#33691e", size: 36, px: 20 }, 2 + shapes.length * 4);
    push({ icon: cfg.svgDataUri, pin: "pin", fill: "#ffe0b2", stroke: "#e65100", size: 36, px: 20 }, 4 + shapes.length * 4);
    // a pinned marker (the markers layer can show only pinned ones: #markers[pinned])
    push({ icon: "📌", pin: "circle", pinned: true }, 6 + shapes.length * 4);
    drawMarkers();
    return made;
  };

  P.zones = () => {
    // 42 small zones, one per stock hatch, on land cells spread by farthest-point sampling
    const used = new Set();
    pack.zones.forEach(z => z.cells.forEach(c => used.add(c)));
    const free = [];
    for (let c = 1; c < pack.cells.i.length; c++) if (isLand(c) && !used.has(c) && !pack.cells.burg[c]) free.push(c);
    const chosen = [free[0]];
    const minD = new Float64Array(free.length).fill(Infinity);
    while (chosen.length < 46) {
      const last = pack.cells.p[chosen[chosen.length - 1]];
      let best = -1;
      let bestD = -1;
      for (let k = 0; k < free.length; k++) {
        const d = dist2(pack.cells.p[free[k]], last);
        if (d < minD[k]) minD[k] = d;
        if (minD[k] > bestD) {
          bestD = minD[k];
          best = k;
        }
      }
      chosen.push(free[best]);
    }
    const claimed = new Set(used);
    const made = [];
    const base = pack.zones.length ? Math.max(...pack.zones.map(z => z.i)) + 1 : 0;
    chosen.forEach((seedCell, n) => {
      const cells = [seedCell];
      claimed.add(seedCell);
      for (let q = 0; q < cells.length && cells.length < 20; q++)
        for (const nb of pack.cells.c[cells[q]]) {
          if (cells.length >= 20) break;
          if (!isLand(nb) || claimed.has(nb)) continue;
          claimed.add(nb);
          cells.push(nb);
        }
      const hatched = n < 42;
      const color = hatched ? `url(#hatch${n})` : ["#c0392b", "#27ae60", "#2980b9", "#8e44ad"][n - 42];
      pack.zones.push({
        i: base + n,
        name: hatched ? `Parity hatch ${n}` : `Parity solid ${n - 42}`,
        type: hatched ? "Hatch" : "Solid",
        color,
        cells
      });
      made.push(base + n);
    });
    drawZones();
    return made;
  };

  /** Drag a few icebergs and one glacier, the way ice-editor's dragElement stores it (iceData.offset). */
  P.ice = () => {
    // a seed may grow no icebergs: add some the way the ice editor does (Ice.addIceberg on ocean grid cells at the top edge)
    const have = () => pack.ice.filter(e => e.type !== "glacier").length;
    if (have() < 8) {
      const cells = [];
      for (let c = 0; c < grid.cells.i.length; c++) if (grid.cells.h[c] < 20 && grid.points[c][1] < graphHeight * 0.1) cells.push(c);
      const sizes = [0.8, 1.2, 1.6, 1];
      for (let n = 0; have() < 8 && cells.length; n++) Ice.addIceberg(cells[Math.floor((n * cells.length) / 8)], sizes[n % sizes.length]);
    }
    // likewise a seed may be too warm for glaciers: grow one over the northernmost land cells with the generator's own
    // isoline code, so the polygon is shaped like a generated glacier
    if (!pack.ice.some(e => e.type === "glacier")) {
      let seedCell = -1;
      for (let c = 0; c < grid.cells.i.length; c++)
        if (grid.cells.h[c] >= 20 && (seedCell < 0 || grid.points[c][1] < grid.points[seedCell][1])) seedCell = c;
      const cluster = new Set([seedCell]);
      const queue = [seedCell];
      for (let q = 0; q < queue.length && cluster.size < 12; q++)
        for (const nb of grid.cells.c[queue[q]])
          if (cluster.size < 12 && grid.cells.h[nb] >= 20 && !cluster.has(nb)) {
            cluster.add(nb);
            queue.push(nb);
          }
      const iso = getIsolines(grid, c => (cluster.has(c) ? "iceShield" : null), { polygons: true });
      const id = pack.ice.length ? Math.max(...pack.ice.map(e => e.i)) + 1 : 0;
      pack.ice.push({ i: id, points: clipPoly(iso.iceShield.polygons[0]), type: "glacier" });
      redrawGlacier(id);
    }
    const bergs = pack.ice.filter(e => e.type !== "glacier").sort((a, b) => a.i - b.i);
    const glaciers = pack.ice.filter(e => e.type === "glacier").sort((a, b) => a.i - b.i);
    const moved = [];
    [[16, -9], [-22, 7], [9, 13]].forEach((off, n) => {
      const berg = bergs[Math.floor((n * bergs.length) / 3)];
      if (!berg) return;
      berg.offset = off;
      redrawIceberg(berg.i);
      moved.push({ i: berg.i, type: "iceberg", offset: off });
    });
    if (glaciers[0]) {
      glaciers[0].offset = [5, 6];
      redrawGlacier(glaciers[0].i);
      moved.push({ i: glaciers[0].i, type: "glacier", offset: [5, 6] });
    }
    return moved;
  };

  P.legend = () => {
    const data = pack.states
      .filter(s => s.i && !s.removed && s.cells)
      .sort((a, b) => (b.area || 0) - (a.area || 0))
      .slice(0, 10)
      .map(s => [s.i, s.color, s.name]);
    legend.attr("data-x", 96).attr("data-y", 91);
    drawLegend("States", data);
    return { items: data.length, box: !!document.getElementById("legendBox") };
  };

  P.measurers = () => {
    const A = P.anchor();
    const made = [];
    rulers.create(Ruler, [[A.x - 70 | 0, A.y + 40 | 0], [A.x - 10 | 0, A.y + 58 | 0], [A.x + 60 | 0, A.y + 44 | 0]]).draw();
    made.push("Ruler");
    const wave = [];
    for (let i = 0; i < 14; i++) wave.push([(A.x - 80 + i * 12) | 0, (A.y - 50 + 14 * Math.sin(i * 0.7)) | 0]);
    rulers.create(Opisometer, wave).draw();
    made.push("Opisometer");
    // route opisometer: a stretch of the route that passes nearest to the anchor
    const routes = pack.routes
      .filter(r => r && r.points && r.points.length >= 6)
      .map(r => ({ r, d: Math.min(...r.points.map(p => dist2(p, [A.x, A.y]))) }))
      .sort((a, b) => a.d - b.d || a.r.i - b.r.i);
    const pts = routes[0].r.points.slice(0, 8).map(p => [p[0] | 0, p[1] | 0]);
    rulers.create(RouteOpisometer, pts).draw();
    made.push("RouteOpisometer");
    const hex = [];
    for (let i = 0; i < 6; i++) hex.push([(A.x + 85 + 28 * Math.cos((i * Math.PI) / 3)) | 0, (A.y - 30 + 22 * Math.sin((i * Math.PI) / 3)) | 0]);
    rulers.create(Planimeter, hex).draw();
    made.push("Planimeter");
    return made;
  };

  /** Dashed grid: stock hex grid with a dash pattern, round caps and a pattern offset. */
  P.grid = () => {
    gridOverlay.attr("stroke-dasharray", "5 3").attr("stroke-linecap", "round").attr("stroke-width", 0.8).attr("dx", 3).attr("dy", 2);
    drawGrid();
    return { type: gridOverlay.attr("type"), dash: gridOverlay.attr("stroke-dasharray") };
  };

  /** Custom labels with their textPaths: straight, quadratic, cubic, multi-line, spaced, and a haloed group. */
  P.labels = () => {
    const A = P.anchor();
    const defsPaths = d3.select("#textPaths");
    let group = labels.select("#addedLabels");
    group.classed("hidden", false);
    let halo = labels.select("#parityLabels");
    if (!halo.size())
      halo = labels
        .append("g")
        .attr("id", "parityLabels")
        .attr("fill", "#fffbe6")
        .attr("opacity", 1)
        .attr("stroke", "#2b2118")
        .attr("stroke-width", 2.2)
        .attr("paint-order", "stroke")
        .attr("stroke-linejoin", "round")
        .attr("font-family", "Almendra SC")
        .attr("font-size", 14)
        .attr("data-size", 14);
    const specs = [
      { g: group, id: "label900", lines: ["Straight Name"], d: `M${A.x - 60},${A.y - 5} h120`, off: "50%", fs: "100%" },
      { g: group, id: "label901", lines: ["Quadratic Sea"], d: `M${A.x - 100},${A.y + 70} Q${A.x - 40},${A.y + 20} ${A.x + 20},${A.y + 70}`, off: "50%", fs: "120%" },
      { g: group, id: "label902", lines: ["Cubic Reach"], d: `M${A.x + 30},${A.y + 100} C${A.x + 70},${A.y + 40} ${A.x + 110},${A.y + 140} ${A.x + 150},${A.y + 80}`, off: "25%", fs: "90%" },
      { g: group, id: "label903", lines: ["Two", "Lines"], d: `M${A.x + 60},${A.y - 70} h80`, off: "50%", fs: "110%" },
      { g: halo, id: "label904", lines: ["Haloed Straight"], d: `M${A.x - 130},${A.y - 90} h110`, off: "50%", fs: "100%" },
      { g: halo, id: "label905", lines: ["Haloed Curve"], d: `M${A.x - 140},${A.y - 20} Q${A.x - 110},${A.y - 70} ${A.x - 70},${A.y - 30}`, off: "75%", fs: "130%", ls: "2px" }
    ];
    for (const s of specs) {
      const text = s.g.append("text").attr("text-rendering", "optimizeSpeed").attr("id", s.id);
      const tp = text.append("textPath").attr("text-rendering", "optimizeSpeed").attr("xlink:href", `#textPath_${s.id}`).attr("startOffset", s.off).attr("font-size", s.fs);
      if (s.ls) tp.attr("letter-spacing", s.ls);
      s.lines.forEach((line, n) => {
        const tspan = tp.append("tspan").attr("x", 0).text(line);
        if (s.lines.length > 1) tspan.attr("dy", n === 0 ? "-0.5em" : "1em");
      });
      defsPaths.append("path").attr("id", `textPath_${s.id}`).attr("d", s.d);
    }
    return specs.map(s => s.id);
  };

  /** Fog on two states through the app's own fog(), with the fade finished and the veil kept light. */
  P.fog = () => {
    const ids = pack.states.filter(s => s.i && !s.removed && s.cells).sort((a, b) => (b.area || 0) - (a.area || 0)).slice(0, 2).map(s => s.i);
    const veil = +fogging.attr("opacity");
    for (const i of ids) fog(`focusState${i}`, statesBody.select(`#state${i}`).attr("d"));
    d3.select("#fog").selectAll("path").interrupt().attr("opacity", 1);
    fogging.interrupt().style("display", "block").attr("opacity", 0.3);
    return { states: ids, veilWas: veil };
  };

  /** The camera framing for a set of world-space targets, in d3 zoom terms. */
  P.camera = (k, cx, cy) => ({ k, x: Math.round((svgWidth / 2 - cx * k) * 100) / 100, y: Math.round((svgHeight / 2 - cy * k) * 100) / 100 });

  /** World-space centres the camera presets frame. */
  P.targets = () => {
    const A = P.anchor();
    const centre = pts => {
      const xs = pts.map(p => p[0]);
      const ys = pts.map(p => p[1]);
      return [r1((Math.min(...xs) + Math.max(...xs)) / 2), r1((Math.min(...ys) + Math.max(...ys)) / 2)];
    };
    const ice = pack.ice
      .filter(e => e.offset)
      .sort((a, b) => a.i - b.i)
      .map(e => {
        const [cx, cy] = centre(e.points);
        return { i: e.i, type: e.type || "iceberg", cx: cx + e.offset[0], cy: cy + e.offset[1] };
      });
    const zoneCentre = n => {
      const z = pack.zones.find(z => z.name === `Parity hatch ${n}`);
      const [cx, cy] = centre(z.cells.map(c => pack.cells.p[c]));
      return { zone: z.i, cx, cy };
    };
    const zones = {};
    for (const n of [0, 5, 17, 29, 41]) zones[n] = zoneCentre(n);
    // the burg emblem nearest the anchor (the showcase window at k 4 and 8 holds none: emblems sit beside their burg)
    const emblems = [...document.querySelectorAll("#burgEmblems > *")]
      .map(e => ({ cx: +e.getAttribute("x"), cy: +e.getAttribute("y") }))
      .filter(e => Number.isFinite(e.cx) && Number.isFinite(e.cy))
      .sort((a, b) => dist2([a.cx, a.cy], [A.x, A.y]) - dist2([b.cx, b.cy], [A.x, A.y]) || a.cx - b.cx || a.cy - b.cy);
    // the centre of the compass layer's client rect in world space. The rhumb lines are symmetric about the origin, so this
    // is (0, 0) and the camera clamp frames the top-left corner, where the rose (about 80, 80) sits
    let compassCentre = null;
    const rose = document.querySelector("#compass use, #compass > *");
    if (rose) {
      const r = rose.getBoundingClientRect();
      const m = viewbox.node().getScreenCTM().inverse();
      const pt = new DOMPoint(r.left + r.width / 2, r.top + r.height / 2).matrixTransform(m);
      compassCentre = { cx: r1(pt.x), cy: r1(pt.y) };
    }
    // the largest lake: the showcase window at k 8 holds none
    const lakes = pack.features
      .filter(f => f && f.type === "lake" && f.cells > 0)
      .sort((a, b) => b.cells - a.cells || a.i - b.i)
      .map(f => {
        const pts = [];
        for (let c = 0; c < pack.cells.i.length; c++) if (pack.cells.f[c] === f.i) pts.push(pack.cells.p[c]);
        const [cx, cy] = centre(pts);
        return { feature: f.i, cx, cy };
      });
    const fogged = [...document.querySelectorAll("#fog > path")].map(p => p.id);
    return { anchor: A, ice, zones, emblems, lakes, compass: compassCentre, fogged, graph: [graphWidth, graphHeight] };
  };

  // ----------------------------------------------------------------- census

  const tagCounts = el => {
    const out = {};
    for (const n of el.querySelectorAll("*")) out[n.tagName] = (out[n.tagName] || 0) + 1;
    return out;
  };

  /** Everything the manifest asserts, measured from the live page. Pure read. */
  P.census = () => {
    const out = { layers: {}, features: {} };
    for (const el of document.querySelectorAll("#viewbox > *")) {
      if (!el.id) continue;
      out.layers[el.id] = {
        display: getComputedStyle(el).display,
        kids: el.childElementCount,
        elements: el.querySelectorAll("*").length,
        tags: tagCounts(el),
        layerOff: el.getAttribute("data-layer-off")
      };
    }
    for (const id of ["scaleBar", "legend", "vignette"]) {
      const el = document.getElementById(id);
      if (el) out.layers[id] = { display: getComputedStyle(el).display, kids: el.childElementCount, elements: el.querySelectorAll("*").length, tags: tagCounts(el) };
    }
    out.buttonsOn = LAYER_BUTTONS.filter(b => document.getElementById(b) && !document.getElementById(b).classList.contains("buttonoff")).sort();
    const F = out.features;
    const shape = document.getElementById("shapeRendering").value;
    F.halo = {
      shapeRendering: shape,
      viewboxShapeRendering: viewbox.attr("shape-rendering"),
      borderPaths: document.querySelectorAll("#statesHalo > path").length,
      clipPaths: document.querySelectorAll("#statePaths > clipPath").length,
      display: getComputedStyle(document.getElementById("statesHalo")).display
    };
    const regs = [];
    for (const s of pack.states) if (s && s.i && !s.removed) for (const m of s.military || []) regs.push(m);
    const external = m => /^(http|data:image)/.test(m.icon || "");
    F.regiments = {
      total: regs.length,
      domGroups: document.querySelectorAll("#armies g[id^=regiment]").length,
      rotated: regs.filter(m => m.angle).length,
      naval: regs.filter(m => m.n).length,
      navalRotated: regs.filter(m => m.n && m.angle).length,
      imageIcon: regs.filter(external).length,
      imageElements: document.querySelectorAll("#armies image[href^='data:image']").length,
      emojiIcon: regs.filter(m => !external(m)).length
    };
    const mk = pack.markers || [];
    F.markers = {
      total: mk.length,
      domSvgs: document.querySelectorAll("#markers > svg").length,
      emoji: mk.filter(m => !/^(http|data:image)/.test(m.icon || "")).length,
      dataImage: mk.filter(m => /^data:image/.test(m.icon || "")).length,
      pinShapes: [...new Set(mk.map(m => m.pin || "bubble"))].sort(),
      pinned: mk.filter(m => m.pinned).length,
      hidden: mk.filter(m => m.hidden).length,
      notes: notes.filter(n => /^marker\d+$/.test(n.id)).length
    };
    const lg = document.getElementById("legend");
    F.legend = { rects: lg.querySelectorAll("rect").length, texts: lg.querySelectorAll("text").length, box: !!document.getElementById("legendBox"), dataX: lg.getAttribute("data-x"), dataY: lg.getAttribute("data-y"), transform: lg.getAttribute("transform") };
    const kinds = { Ruler: 0, Opisometer: 0, RouteOpisometer: 0, Planimeter: 0 };
    for (const m of rulers.data) kinds[m.constructor.name] = (kinds[m.constructor.name] || 0) + 1;
    F.measurers = { ...kinds, domGroups: document.querySelectorAll("#ruler > g").length, serialized: rulers.toString().split("; ").length };
    F.compass = { use: document.querySelectorAll("#compass use").length, display: getComputedStyle(document.getElementById("compass")).display };
    const go = document.getElementById("gridOverlay");
    F.grid = { type: go.getAttribute("type"), dasharray: go.getAttribute("stroke-dasharray"), linecap: go.getAttribute("stroke-linecap"), fillRects: go.querySelectorAll("rect").length };
    F.coordinates = { paths: document.querySelectorAll("#coordinates path").length, texts: document.querySelectorAll("#coordinates text").length };
    F.texture = { images: document.querySelectorAll("#texture image").length, href: document.querySelector("#texture image")?.getAttribute("href") || null };
    F.ice = {
      polygons: document.querySelectorAll("#ice polygon").length,
      glaciers: document.querySelectorAll("#ice polygon[type=glacier]").length,
      icebergs: document.querySelectorAll("#ice polygon:not([type=glacier])").length,
      dragged: document.querySelectorAll("#ice polygon[transform]").length,
      draggedData: pack.ice.filter(e => e.offset).length,
      filter: document.getElementById("ice").getAttribute("filter") || getComputedStyle(document.getElementById("ice")).filter
    };
    const hatchIds = new Set();
    let solid = 0;
    for (const p of document.querySelectorAll("#zones > path")) {
      const f = p.getAttribute("data-zone-hatch-fill") || p.getAttribute("fill") || "";
      const m = /url\(#(hatch\d+)\)/.exec(f);
      if (m) hatchIds.add(m[1]);
      else solid++;
    }
    F.zones = { total: pack.zones.length, paths: document.querySelectorAll("#zones > path").length, stockHatches: hatchIds.size, solid };
    const sea = coastline.select("#sea_island");
    F.coastline = { autoFilter: sea.attr("auto-filter"), filter: sea.attr("filter"), features: document.querySelectorAll("#coastline use").length, scale: scale };
    F.lakes = {};
    for (const g of document.querySelectorAll("#lakes > g")) F.lakes[g.id] = g.childElementCount;
    F.dataLayers = {};
    for (const id of ["temperature", "prec", "population", "goods", "markets"]) {
      const el = document.getElementById(id);
      F.dataLayers[id] = { elements: el.querySelectorAll("*").length, display: getComputedStyle(el).display };
    }
    F.cells = { buttonOn: !document.getElementById("toggleCells").classList.contains("buttonoff"), elements: document.querySelectorAll("#cells > *").length };
    F.fog = { paths: document.querySelectorAll("#fog > path").length, display: getComputedStyle(document.getElementById("fogging")).display, opacity: document.getElementById("fogging").getAttribute("opacity"), contMask: document.getElementById("fogging-cont")?.getAttribute("mask") || null };
    F.vignette = { display: getComputedStyle(document.getElementById("vignette")).display, rect: !!document.getElementById("vignette-rect") };
    const curved = el => /[QCSTA]/i.test(document.getElementById(`textPath_${el.id}`)?.getAttribute("d") || "");
    const stateTexts = [...document.querySelectorAll("#states text")];
    const customTexts = [...document.querySelectorAll("#labels > g:not(#states):not(#burgLabels) text")];
    F.labels = {
      stateCurvedTextPath: stateTexts.filter(t => t.querySelector("textPath")).length,
      burgStraight: document.querySelectorAll("#burgLabels text").length,
      custom: customTexts.length,
      customCurved: customTexts.filter(curved).length,
      customStraight: customTexts.filter(t => !curved(t)).length,
      customWithTextPath: customTexts.filter(t => t.querySelector("textPath")).length,
      multiLine: customTexts.filter(t => t.querySelectorAll("tspan").length > 1).length,
      haloGroups: document.querySelectorAll("#labels > g[paint-order]").length,
      textPaths: document.querySelectorAll("#textPaths > path").length
    };
    F.emblems = { uses: document.querySelectorAll("#emblems use").length, groups: document.querySelectorAll("#emblems > g").length };
    F.trade = { deals: (pack.deals || []).length, markets: (pack.markets || []).length, animationNodes: document.querySelectorAll("#tradeAnimation > g").length, layerOff: document.getElementById("tradeAnimation").getAttribute("data-layer-off") };
    F.map = { cells: pack.cells.i.length, gridCells: grid.cells.i.length, states: pack.states.filter(s => s && s.i && !s.removed).length, burgs: pack.burgs.filter(b => b && b.i && !b.removed).length, graph: [graphWidth, graphHeight] };
    return out;
  };

  // ----------------------------------------------------------------- preamble

  /**
   * What a freshly loaded parity map needs before a golden: the content the file deliberately does not carry.
   * `cells` is a 0.8 MB raster the app redraws on toggle, so the file ships with the layer off and a run turns it
   * on. Idempotent. The trade animation needs nothing: TradeAnimation.sync() runs on load.
   */
  P.preamble = async (opts = {}) => {
    const did = [];
    // Options > Rendering is a browser preference, and load reads it from the previous map's viewbox, so a fresh page
    // shows "Best performance" over a map saved with "Best quality". Match the select to the file (as a user would).
    const sel = document.getElementById("shapeRendering");
    const saved = viewbox.attr("shape-rendering");
    if (opts.rendering !== false && saved && sel.value !== saved) {
      sel.value = saved;
      invokeActiveZooming();
      did.push("rendering");
    }
    if (opts.cells !== false && !layerIsOn("toggleCells")) {
      toggleCells();
      did.push("cells");
    }
    if (opts.debug !== false && debug.selectAll("*").size() === 0) {
      // the route editor's control points and a selection highlight: runtime-only #debug content
      const A = P.anchor();
      debug.append("circle").attr("cx", A.x).attr("cy", A.y).attr("r", 4).attr("fill", "#ff00ff").attr("stroke", "#000").attr("stroke-width", 0.5);
      debug.append("path").attr("class", "highlight").attr("d", `M${A.x - 20},${A.y - 20} h40 v40 h-40 Z`).attr("fill", "none").attr("stroke", "#ff00ff");
      did.push("debug");
    }
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return did;
  };

  root.__parity = P;
})();
