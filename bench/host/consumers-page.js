// Page-side half of the consumers harness (bench/host/consumers.ts). A classic script (no imports, no types) injected
// with addInitScript. Every function runs inside the app page and returns JSON-serialisable data; the comparison and
// the verdicts live in Node (consumers.ts, consumers-lib.ts). Bare identifiers (pack, grid, scale, viewX ...) are the
// app's own runtime globals, as docs/architecture/runtime_api.md describes. Nothing here uses Math.random.
(() => {
  const root = globalThis;
  const C = {};
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const raf2 = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const SVG_NS = "http://www.w3.org/2000/svg";

  // ----------------------------------------------------------------- renderer state and settling

  /** What the renderer is doing right now: the arm's own proof that a probe ran on the path it claims to cover. */
  C.status = () => {
    const s = root.rendererStatus?.();
    const g = s?.gpu;
    return {
      requested: s?.requested ?? null,
      active: s?.active ?? null,
      fallbackReason: s?.fallbackReason || "",
      state: g?.state ?? null,
      pending: !!g?.pending,
      refinementPending: !!g?.refinementPending,
      moving: !!g?.moving,
      canvasVisible: !!g?.canvasVisible,
      suspendedReason: g?.suspendedReason || "",
      sourceCurrent: g?.sourceCurrent ?? null,
      frames: g?.frames ?? null,
      canvases: document.querySelectorAll("canvas[data-gpu-renderer]").length
    };
  };

  /**
   * Let the app and (for the gpu arm) the renderer finish: fonts, relief and burg rasters, then a presented frame with
   * no prepare or refinement pending. `allowSuspended` accepts a renderer that is deliberately suspended (a dialog is open).
   * Resolves with the status, never throws, so the caller can record a fallback instead of aborting the run.
   */
  C.idle = async ({ gpu, allowSuspended = false, timeoutMs = 240000 } = {}) => {
    try {
      await root.__tupaia.settle();
      await Promise.all([root.reliefRenderReady, root.burgRenderReady]);
      if (root.waitDenseZoomReady) await root.waitDenseZoomReady(15000);
    } catch (error) {
      return { ...C.status(), waitError: String(error) };
    }
    if (!gpu) {
      await raf2();
      return C.status();
    }
    const started = Date.now();
    const end = started + timeoutMs;
    let suspendedSince = 0;
    while (Date.now() < end) {
      const s = C.status();
      if (s.active === "svg" && s.fallbackReason) return { ...s, waitedMs: Date.now() - started }; // fell back: the caller reports it
      if (s.suspendedReason && !allowSuspended) {
        // a dialog the harness left open: not worth the full timeout
        suspendedSince ||= Date.now();
        if (Date.now() - suspendedSince > 3000) return { ...s, waitError: `renderer suspended (${s.suspendedReason})`, waitedMs: Date.now() - started };
      } else suspendedSince = 0;
      const settled = s.state === "active" && !s.pending && !s.refinementPending && !s.moving;
      if (settled && (allowSuspended ? true : s.canvasVisible)) {
        await raf2();
        const again = C.status();
        if (again.state === "active" && !again.pending && !again.refinementPending && !again.moving) return { ...again, waitedMs: Date.now() - started };
      }
      await sleep(50);
    }
    return { ...C.status(), waitError: "timeout waiting for the gpu renderer to settle", waitedMs: Date.now() - started };
  };

  // ----------------------------------------------------------------- camera

  const r6 = v => Math.round(v * 1e6) / 1e6;
  C.camera = () => ({
    scale: r6((0, eval)("scale")),
    viewX: r6((0, eval)("viewX")),
    viewY: r6((0, eval)("viewY")),
    viewboxTransform: document.querySelector("#viewbox")?.getAttribute("transform") ?? null,
    canonicalStale: root.gpuRenderer?.canonicalCameraStale?.() ?? null
  });

  /** A non-identity camera: zoom k, centred on the world point (fx, fy) given as fractions of the map. */
  C.setCamera = async ({ k, fx, fy }) => {
    const x = svgWidth / 2 - graphWidth * fx * k;
    const y = svgHeight / 2 - graphHeight * fy * k;
    // The svg arm's zoom handler does nothing when the transform equals the camera globals, and a map load resets the
    // #viewbox attribute but not those globals: so first move off the target, then onto it, to make both arms apply it.
    const zoom = (0, eval)("zoom");
    root.d3.select("#map").call(zoom.transform, root.d3.zoomIdentity.translate(x + 7, y + 5).scale(k * 0.9));
    await sleep(150);
    root.d3.select("#map").call(zoom.transform, root.d3.zoomIdentity.translate(x, y).scale(k));
    await sleep(350);
    return C.camera();
  };

  // ----------------------------------------------------------------- the world (row 40: read-only)

  const sha = async data => {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  };

  const hashValue = async value => {
    if (ArrayBuffer.isView(value)) return sha(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    try {
      return await sha(JSON.stringify(value) ?? "undefined");
    } catch (error) {
      return `unhashable:${String(error).slice(0, 60)}`;
    }
  };

  /** A hash per top-level member of pack, pack.cells, grid and grid.cells, plus the identity of the objects. */
  C.hashWorld = async () => {
    const out = {};
    const take = async (prefix, object, skip = []) => {
      for (const key of Object.keys(object).sort()) {
        if (skip.includes(key)) continue;
        out[`${prefix}.${key}`] = (await hashValue(object[key])).slice(0, 16);
      }
    };
    await take("pack", root.pack, ["cells"]);
    await take("pack.cells", root.pack.cells);
    await take("grid", root.grid, ["cells"]);
    await take("grid.cells", root.grid.cells);
    out.notes = (await hashValue(root.notes)).slice(0, 16);
    out.options = (await hashValue(root.options)).slice(0, 16);
    out.mapCoordinates = (await hashValue(root.mapCoordinates)).slice(0, 16);
    out.seed = String(root.seed);
    out.mapId = String(root.mapId);
    root.__consWorld = { pack: root.pack, grid: root.grid };
    return { keys: Object.keys(out).length, hash: out, total: (await sha(JSON.stringify(out))).slice(0, 16) };
  };

  /** Do window.pack and window.grid still point at the objects hashWorld saw (a renderer must not swap or replace them)? */
  C.sameWorldObjects = () => !!root.__consWorld && root.__consWorld.pack === root.pack && root.__consWorld.grid === root.grid;

  // ----------------------------------------------------------------- the saved SVG (rows 31, 32; I8, I9, I11, I15)

  const PLANT_ID = "consumersTempLeak";

  /** Facts the harness asserts on a saved SVG section. Parsed with DOMParser, like the loader's consumers would. */
  C.svgFacts = text => {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const parsed = !doc.querySelector("parsererror") && doc.documentElement?.localName === "svg";
    if (!parsed) return { parsed: false };
    const q = selector => doc.querySelector(selector);
    const trade = q("#tradeAnimation");
    const ruler = q("#ruler");
    return {
      parsed: true,
      rootId: doc.documentElement.getAttribute("id"),
      width: doc.documentElement.getAttribute("width"),
      height: doc.documentElement.getAttribute("height"),
      viewboxTransform: q("#viewbox")?.getAttribute("transform") ?? null,
      rulerChildren: ruler ? ruler.childNodes.length : null,
      tradeChildren: trade ? trade.childNodes.length : null,
      tradeLayerOff: trade ? trade.getAttribute("data-layer-off") : null,
      viewportCulled: doc.querySelectorAll(".viewport-culled").length,
      emptyClassAttrs: doc.querySelectorAll('[class=""]').length,
      canvases: doc.querySelectorAll("canvas").length,
      gpuMarkers: [...doc.querySelectorAll("*")].filter(e => e.getAttributeNames().some(n => /gpu/i.test(n)) || /gpu/i.test(e.getAttribute("id") || "")).length,
      tempGroups: doc.querySelectorAll('[id="temp"]').length,
      tempLeak: doc.getElementById(PLANT_ID) ? true : false,
      elements: doc.getElementsByTagName("*").length
    };
  };

  /**
   * prepareMapData. With `plant`, transient content is put into the live document for the length of the call, so the
   * clearing is not vacuous: a caravan in #tradeAnimation and a mark in #ruler (I9 must empty both), and a node in a
   * `#temp` staging group the way the cultures editor makes one (I15). `live` reports what the document held at save time.
   */
  C.save = async ({ plant = false } = {}) => {
    const save = await root.lazy.save();
    const planted = [];
    const live = {};
    if (plant) {
      const add = (host, build) => {
        if (!host) return null;
        const node = build();
        host.append(node);
        planted.push(node);
        return node;
      };
      const make = (tag, attrs = {}) => {
        const el = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        return el;
      };
      add(document.querySelector("#tradeAnimation"), () => make("g", { "data-consumers": "caravan" }));
      add(document.querySelector("#ruler"), () => make("g", { "data-consumers": "ruler-mark" }));
      const temp = add(document.querySelector("#cults") || document.querySelector("#regions") || document.querySelector("#viewbox"), () => make("g", { id: "temp" }));
      temp?.append(make("circle", { id: PLANT_ID, r: "1" }));
      live.tradeChildren = document.querySelector("#tradeAnimation")?.childNodes.length ?? null;
      live.rulerChildren = document.querySelector("#ruler")?.childNodes.length ?? null;
    }
    const before = C.camera();
    let text;
    try {
      text = save.prepareMapData();
    } finally {
      for (const node of planted) node.remove();
    }
    const after = C.camera();
    const svgText = text.split("\r\n")[5] ?? "";
    return { text, facts: C.svgFacts(svgText), live, cameraBefore: before, cameraAfter: after, graph: [root.graphWidth, root.graphHeight] };
  };

  // ----------------------------------------------------------------- bytes

  C.b64 = bytes => {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };

  C.blobBytes = async blob => C.b64(new Uint8Array(await blob.arrayBuffer()));

  /** prepareMapFile: the native binary save. */
  C.saveBinary = async () => {
    const save = await root.lazy.save();
    return C.b64(await save.prepareMapFile());
  };

  /** Replace the world with `base64` bytes through the same uploadMap path as File > Open and the ldb/cloud loaders. */
  C.loadBytes = async base64 => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const load = await root.lazy.load();
    await root.__tupaia.awaitMap(() => load.uploadMap(new Blob([bytes], { type: "application/octet-stream" })), 120000);
    return C.status();
  };

  /** Text of a blob: URL (getMapURL's result), fetched while it is still alive. */
  C.urlText = async url => (await fetch(url)).text();

  // ----------------------------------------------------------------- storage and customization (rows 32, 31/I12)

  // `ldb` is a top-level const of a classic script: a global binding, not a window property
  const ldb = () => (0, eval)("ldb");
  C.ldbGet = async () => {
    const value = await ldb().get("lastMap");
    if (value instanceof Blob) return { kind: "blob", size: value.size, base64: await C.blobBytes(value) };
    return { kind: typeof value, value: typeof value === "string" ? value : null };
  };

  /**
   * I12: with customization on, every save path refuses. A sentinel in ldb must survive saveMap('storage'), and
   * saveMap('machine') must not start a download (the harness counts download events around this call).
   */
  C.saveBlockedProbe = async () => {
    const save = await root.lazy.save();
    await ldb().set("lastMap", "consumers-sentinel");
    (0, eval)("customization = 1");
    let error = null;
    try {
      await save.saveMap("storage");
      await save.saveMap("machine");
    } catch (e) {
      error = String(e);
    } finally {
      (0, eval)("customization = 0");
    }
    const after = await ldb().get("lastMap");
    return { sentinelKept: after === "consumers-sentinel", error };
  };

  C.saveToStorage = async () => {
    const save = await root.lazy.save();
    await save.saveMap("storage");
    return C.ldbGet();
  };

  /** Load what ldb holds the way main.js does on boot (`uploadMap(blob)`). */
  C.loadFromLdb = async () => {
    const blob = await ldb().get("lastMap");
    if (!(blob instanceof Blob)) throw new Error("ldb lastMap is not a Blob");
    const load = await root.lazy.load();
    await root.__tupaia.awaitMap(() => load.uploadMap(blob), 120000);
    return C.status();
  };

  // ----------------------------------------------------------------- trade animation

  /** Stop the trade caravans so two exports of one state are byte-comparable (their transforms animate). */
  C.freezeTrade = async () => {
    root.d3.select("#tradeAnimation").selectAll("*").interrupt();
    try {
      root.TradeAnimation?.stop?.();
    } catch {
      /* the stop hook is optional */
    }
    await raf2();
    return document.querySelectorAll("#tradeAnimation > *").length;
  };

  // ----------------------------------------------------------------- exports

  C.runExport = async name => {
    const exporter = await root.lazy.exportMap();
    await exporter[name]();
  };

  C.mapUrl = async (type, options) => {
    const exporter = await root.lazy.exportMap();
    const url = await exporter.getMapURL(type, options);
    return C.urlText(url);
  };

  /** Facts about an exported/mesh SVG string: nothing the renderer adds may show up in it. */
  C.exportFacts = text => {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    if (doc.querySelector("parsererror")) return { parsed: false };
    return {
      parsed: true,
      width: doc.documentElement.getAttribute("width"),
      height: doc.documentElement.getAttribute("height"),
      viewboxTransform: doc.querySelector("#viewbox")?.getAttribute("transform") ?? null,
      canvases: doc.querySelectorAll("canvas").length,
      gpuMarkers: [...doc.querySelectorAll("*")].filter(e => e.getAttributeNames().some(n => /gpu/i.test(n)) || /gpu/i.test(e.getAttribute("id") || "")).length,
      viewportCulled: doc.querySelectorAll(".viewport-culled").length,
      emptyClassAttrs: doc.querySelectorAll('[class=""]').length,
      debugChildren: doc.querySelector("#debug")?.childNodes.length ?? 0,
      tempGroups: doc.querySelectorAll('[id="temp"]').length,
      elements: doc.getElementsByTagName("*").length
    };
  };

  // ----------------------------------------------------------------- transform tool preview (row 37)

  C.transformPreview = async () => {
    const before = C.status();
    await root.openTransformTool();
    const canvas = document.getElementById("transformPreviewCanvas");
    const width = Math.min(400, innerWidth * 0.5);
    const height = graphHeight * (width / graphWidth);
    const end = Date.now() + 60000;
    // loadPreview sets the canvas size inside img.onload, then draws; wait for pixels
    let ink = 0;
    while (Date.now() < end) {
      if (canvas.width === width * 4) {
        const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        ink = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i]) ink++;
        if (ink) break;
      }
      await sleep(100);
    }
    const png = canvas.toDataURL("image/png").split(",")[1];
    return { before, width: canvas.width, height: canvas.height, expected: [width * 4, height * 4], ink, png, camera: C.camera() };
  };

  C.closeTransformPreview = async () => {
    $("#transformTool").dialog("close");
    await sleep(200);
    return C.status();
  };

  // ----------------------------------------------------------------- minimap (row 35)

  C.openMinimap = async () => {
    const minimap = await root.lazy.minimap();
    minimap.openMinimapDialog();
    await sleep(300);
    const num = id => ["x", "y", "width", "height"].map(a => document.getElementById(id)?.getAttribute(a) ?? null);
    const surface = document.getElementById("minimapSurface");
    const rect = surface.getBoundingClientRect();
    return {
      status: C.status(),
      viewport: num("minimapViewport"),
      use: document.getElementById("minimapMapUse")?.getAttribute("transform") ?? null,
      viewBox: surface.getAttribute("viewBox"),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      camera: C.camera(),
      graph: [graphWidth, graphHeight],
      svgSize: [svgWidth, svgHeight]
    };
  };

  /** Where the app's own click handler will send the view for a click at client (x, y): the minimap CTM, clamped. */
  C.minimapTarget = (clientX, clientY) => {
    const minimap = document.getElementById("minimapSurface");
    const point = minimap.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const p = point.matrixTransform(minimap.getScreenCTM().inverse());
    return { x: Math.min(Math.max(p.x, 0), graphWidth), y: Math.min(Math.max(p.y, 0), graphHeight) };
  };

  /** The world point at the centre of the view, from the app's camera globals. */
  C.viewCentre = () => ({
    x: r6((svgWidth / 2 - (0, eval)("viewX")) / (0, eval)("scale")),
    y: r6((svgHeight / 2 - (0, eval)("viewY")) / (0, eval)("scale"))
  });

  C.closeMinimap = async () => {
    $("#minimap").dialog("close");
    await sleep(200);
    return C.status();
  };

  // ----------------------------------------------------------------- row 38 dialogs

  /** Elevation profile of the longest river that has a path: dialog content and its three downloads' buttons. */
  C.openElevationProfile = async () => {
    const rivers = root.pack.rivers.filter(r => r && r.cells && r.cells.length > 8).sort((a, b) => b.cells.length - a.cells.length || a.i - b.i);
    if (!rivers.length) return { skipped: "no river with a path in this world" };
    const river = rivers[0];
    const profile = await root.lazy.elevationProfile();
    profile.open(river.cells.slice(), river.length ?? river.cells.length, true);
    await sleep(600);
    const dialog = document.getElementById("elevationProfile");
    const graph = document.getElementById("elevationGraph");
    return {
      river: river.i,
      cells: river.cells.length,
      visible: !!dialog?.offsetParent,
      graphHtml: graph?.innerHTML ?? "",
      paths: graph?.querySelectorAll("path").length ?? 0,
      status: C.status()
    };
  };

  C.clickButton = async id => {
    document.getElementById(id).click();
    await sleep(50);
  };

  /** Close every jQuery dialog (including the ones closeDialogs() spares) and leave the 3D view. */
  C.closeAllDialogs = async () => {
    try {
      root.enterStandardView?.();
    } catch {
      /* not in a 3D view */
    }
    for (const el of document.querySelectorAll(".ui-dialog-content")) {
      try {
        if ($(el).dialog("isOpen")) $(el).dialog("close");
      } catch {
        /* not a dialog */
      }
    }
    await sleep(300);
    return C.status();
  };

  /** The state of the #alert dialog (the app's message/confirm box). */
  C.alertState = () => {
    const alertEl = document.getElementById("alert");
    let title = null;
    try {
      title = $(alertEl).dialog("option", "title");
    } catch {
      /* never opened */
    }
    return { visible: !!alertEl?.offsetParent, title, text: (document.getElementById("alertMessage")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160), rows: alertEl?.querySelectorAll("table tr").length ?? 0 };
  };

  /** Fix the timestamp rAF callbacks receive, so time-driven shaders (the 3D satellite water) render the same frame twice. */
  C.freezeRafTime = on => {
    if (on) {
      if (!root.__consRaf) {
        root.__consRaf = root.requestAnimationFrame.bind(root);
        root.requestAnimationFrame = cb => root.__consRaf(() => cb(5000));
      }
    } else if (root.__consRaf) {
      root.requestAnimationFrame = root.__consRaf;
      root.__consRaf = null;
    }
  };

  C.openCharts = async () => {
    const charts = await root.lazy.chartsOverview();
    charts.open();
    await sleep(800);
    const dialog = document.getElementById("chartsOverview");
    const figure = dialog?.querySelector("#chartsOverview__charts figure");
    return {
      visible: !!dialog?.offsetParent,
      figures: dialog?.querySelectorAll("#chartsOverview__charts figure").length ?? 0,
      bars: dialog?.querySelectorAll("#chartsOverview__charts svg rect, #chartsOverview__charts svg path").length ?? 0,
      html: figure?.outerHTML ?? "",
      buttons: [...(figure?.querySelectorAll("figcaption button") ?? [])].map(b => b.className),
      status: C.status()
    };
  };

  /** Click chart download button n (0 = csv, 1 = png, 2 = svg). */
  C.clickChartButton = async n => {
    const buttons = document.querySelectorAll("#chartsOverview__charts figure figcaption button");
    buttons[n]?.click();
    await sleep(100);
    return buttons.length;
  };

  /** Open the emblem editor on the first state with an emblem; returns what the editor resolved. */
  C.openEmblem = async () => {
    const state = root.pack.states.find(s => s && s.i && !s.removed && s.coa);
    if (!state) return { skipped: "no state with a coat of arms" };
    root.editEmblem("state", `stateCOA${state.i}`, state);
    await sleep(800);
    const image = document.getElementById("emblemImage");
    return {
      state: state.i,
      visible: !!document.getElementById("emblemEditor")?.offsetParent,
      imageHref: (image?.getAttribute("href") || image?.getAttribute("xlink:href") || "").slice(0, 60),
      coaInDoc: !!document.getElementById("stateCOA" + state.i),
      status: C.status()
    };
  };

  // ----------------------------------------------------------------- heightmap preview (row 38; enters customization)

  C.heightmapPreview = async () => {
    root.editHeightmap({ mode: "keep" });
    await sleep(800);
    document.getElementById("heightmapPreview").click();
    await sleep(500);
    const canvas = document.getElementById("preview");
    if (!canvas) return { error: "no #preview canvas" };
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let min = 255;
    let max = 0;
    for (let i = 0; i < data.length; i += 4) {
      min = Math.min(min, data[i]);
      max = Math.max(max, data[i]);
    }
    return { width: canvas.width, height: canvas.height, expected: [grid.cellsX, grid.cellsY], min, max, hash: (await sha(new Uint8Array(data.buffer))).slice(0, 32), status: C.status(), customization: (0, eval)("customization") };
  };

  root.__cons = C;
})();
