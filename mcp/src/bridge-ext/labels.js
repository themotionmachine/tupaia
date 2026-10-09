// Tupaia MCP bridge extension: label visibility overrides ("labels" track).
//
// The app hides a label group while its on-screen size is outside 6-60 px (public/main.js,
// invokeActiveZooming; emblems 25-300). `display {labels: {<group>: {minSize?, maxSize?,
// alwaysShow?}}}` stores a per-group override on the SVG group itself (data-min-size /
// data-max-size / data-always-show, so it rides in the .map file); the zoom handler reads them.
// This file wraps FNS.display to validate and apply that field (and to read it back, labels:'list'),
// keeps the hidden classes current when a layer is turned on, adds FNS.labelsShot (the
// non-persistent "show every label for one screenshot") and renders the whole-map raster/SVG at the
// full-map zoom whatever the camera was.
// Same rules as bridge-mutations.js: bare app globals at call time, no locals that shadow app
// globals, every FNS function takes one args object.
(root => {
  const T = root.__tupaia;
  if (!T) return;
  const FNS = T.fns;
  const fail = T.fail;

  const ATTR_MIN = "data-min-size";
  const ATTR_MAX = "data-max-size";
  const ATTR_ALWAYS = "data-always-show";
  const ATTRS = [ATTR_MIN, ATTR_MAX, ATTR_ALWAYS];
  const SHOT_STYLE_ID = "tupaia-labels-all";
  const EMBLEM_GROUPS = ["burgEmblems", "provinceEmblems", "stateEmblems"];
  const MAX_MIN_SIZE = 1000;
  const MAX_MAX_SIZE = 5000;
  // the app's own bounds (px on screen) while a group has no override
  const DEFAULTS = { label: { lo: 6, hi: 60 }, emblem: { lo: 25, hi: 300 } };

  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
  const isG = el => el.tagName.toLowerCase() === "g";
  const round2 = v => Math.round(v * 100) / 100;

  /**
   * Every group an override can sit on: the burg label groups (#burgLabels > g), the other label
   * groups (#labels > g: states, addedLabels, custom), then the emblem groups. [{key, el, kind}]
   */
  function groupList() {
    const out = [];
    const seen = new Set();
    const add = (el, kind) => {
      if (!el.id || seen.has(el.id)) return;
      seen.add(el.id);
      out.push({ key: el.id, el, kind });
    };
    const lab = document.getElementById("labels");
    const others = [];
    if (lab) {
      for (const g of lab.children) {
        if (!isG(g)) continue;
        if (g.id === "burgLabels") {
          for (const b of g.children) if (isG(b)) add(b, "label");
        } else others.push(g);
      }
    }
    for (const g of others) add(g, "label");
    const emb = document.getElementById("emblems");
    if (emb) for (const id of EMBLEM_GROUPS) for (const g of emb.children) if (g.id === id) add(g, "emblem");
    return out;
  }

  /** Items a group draws: label texts, or emblem <use> elements. */
  const itemsOf = g => [...g.el.querySelectorAll(g.kind === "emblem" ? "use" : "text")];

  /** False when the item sits under a zoom-hidden group (class hidden) or an inline display:none. */
  function isShown(node, opts) {
    const stop = document.getElementById("map");
    for (let n = node.parentElement; n && n !== stop; n = n.parentElement) {
      if (n.style && n.style.display === "none") return false;
      if (!opts?.ignoreZoom && n.classList && n.classList.contains("hidden")) return false;
    }
    return true;
  }

  const layerOn = id => typeof layerIsOn === "function" && !!document.getElementById(id) && layerIsOn(id);
  const groupLayerOn = g => layerOn(g.kind === "emblem" ? "toggleEmblems" : "toggleLabels");

  /** Re-run the app's zoom handler (hidden classes) when a label or emblem layer is showing. */
  function rezoom() {
    try {
      if (typeof invokeActiveZooming === "function" && (layerOn("toggleLabels") || layerOn("toggleEmblems")))
        invokeActiveZooming();
    } catch {}
  }

  /** Does the item's box touch the map viewport (what a screenshot shows)? */
  function inViewport(el, box) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom;
  }

  /** Label elements on screen right now: {visible, of[, inView]} over the label groups (not emblems). */
  function countLabels(groups, withView) {
    let visible = 0;
    let of = 0;
    let inView = 0;
    const box = withView ? document.getElementById("map").getBoundingClientRect() : null;
    for (const g of groups) {
      if (g.kind !== "label") continue;
      const items = itemsOf(g);
      of += items.length;
      if (!groupLayerOn(g)) continue;
      for (const it of items) {
        if (!isShown(it)) continue;
        visible++;
        if (box && inViewport(it, box)) inView++;
      }
    }
    return withView ? { visible, of, inView } : { visible, of };
  }

  const visibleIn = g => (groupLayerOn(g) ? itemsOf(g).filter(it => isShown(it)).length : 0);

  /** The override a group carries now, only the fields that are set. */
  const readGroup = g => {
    const minAttr = parseFloat(g.el.getAttribute(ATTR_MIN));
    const maxAttr = parseFloat(g.el.getAttribute(ATTR_MAX));
    const always = g.el.getAttribute(ATTR_ALWAYS);
    const out = {};
    if (Number.isFinite(minAttr)) out.minSize = minAttr;
    if (Number.isFinite(maxAttr)) out.maxSize = maxAttr;
    if (always === "1" || always === "true") out.alwaysShow = true;
    return out;
  };

  // ---------------------------------------------------------------- the zoom range a group shows at

  function zoomExtent() {
    try {
      const [kmin, kmax] = zoom.scaleExtent();
      if (kmin > 0 && kmax > kmin) return [kmin, kmax];
    } catch {}
    return [0.1, 20];
  }

  /** Smallest zoom in [0.001, 100000] where px(zoom) >= v (px never decreases with zoom). */
  function crossing(px, v) {
    let lo = 0.001;
    let hi = 100000;
    if (px(lo) >= v) return lo;
    if (px(hi) < v) return Infinity;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (px(mid) >= v) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  /** On-screen size of a group at a zoom: the app's own formula (labels rescale, emblems do not). */
  function pxFn(g) {
    if (g.kind === "emblem") {
      const fs = parseFloat(g.el.getAttribute("font-size"));
      return Number.isFinite(fs) ? s => fs * s : null;
    }
    const d = parseFloat(g.el.dataset.size);
    return Number.isFinite(d) ? s => Math.max(round2((d + d / s) / 2), 1) * s : null;
  }

  /**
   * Where a group shows: "any" (alwaysShow, or no size to test), "never", or [from, to|null] zoom,
   * limited to the zoom range this view can reach (null = no upper limit within it).
   */
  function zoomRange(g, spec) {
    if (spec.alwaysShow) return "any";
    const px = pxFn(g);
    if (!px) return "any";
    const def = DEFAULTS[g.kind];
    const lo = spec.minSize ?? def.lo;
    const hi = spec.maxSize ?? def.hi;
    const [kmin, kmax] = zoomExtent();
    const from = Math.max(crossing(px, lo), kmin);
    const to = crossing(px, hi * (1 + 1e-9) + 1e-9);
    if (from >= to || from > kmax) return "never";
    return [round2(from), to >= kmax ? null : round2(to)];
  }

  /** The per-group record every result shares: override fields, zoom range, counts. */
  function infoOf(g) {
    const spec = readGroup(g);
    const info = { ...spec, zoom: zoomRange(g, spec) };
    if (Object.keys(spec).length) {
      const auto = zoomRange(g, {});
      if (JSON.stringify(auto) !== JSON.stringify(info.zoom)) info.autoZoom = auto;
    }
    info.visible = visibleIn(g);
    info.of = itemsOf(g).length;
    return info;
  }

  const hideAuto = g => {
    try {
      return g.kind === "emblem" ? !hideEmblems.checked : !hideLabels.checked;
    } catch {
      return false;
    }
  };

  // ---------------------------------------------------------------- display {labels}

  /** Edit distance, for the did-you-mean in the unknown-group error. */
  function distance(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const keep = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = keep;
      }
    }
    return row[b.length];
  }

  function unknownGroup(key, groups) {
    const names = groups.map(g => g.key);
    const containers = {
      burgLabels: "the container of the burg label groups; name one of them (capital, city, town, ...) or use '*'",
      labels: "the container of all label groups; use '*' for every label group"
    };
    let hint = "";
    if (containers[key]) hint = ` ('${key}' is ${containers[key]})`;
    else {
      const low = key.toLowerCase();
      const best = names
        .map(n => ({ n, d: distance(low, n.toLowerCase()) }))
        .sort((x, y) => x.d - y.d)
        .find(
          c => c.d <= Math.max(2, Math.floor(c.n.length / 3)) || (low.length >= 3 && c.n.toLowerCase().includes(low))
        );
      if (best) hint = ` (did you mean '${best.n}'?)`;
    }
    fail("BAD_ARGS", `unknown label group '${key}'${hint}`, {
      details: [...names, "* (every label group)", "emblems (the three emblem groups)"]
    });
  }

  /**
   * Validate the labels argument against the live groups. Returns {plan, named}: plan is a Map of
   * group key -> override {minSize?, maxSize?: number|null, alwaysShow?: boolean|null} (null = clear
   * that attribute): a null spec clears all three, '*' (every label group) and 'emblems' (the three
   * emblem groups) are expanded and a group's own spec is laid over them field by field; named is
   * the set of group keys the call named itself.
   */
  function planOf(arg, groups) {
    if (!isObj(arg)) fail("BAD_ARGS", "labels is {'<group>': {minSize?, maxSize?, alwaysShow?} | null} or 'list'");
    const byKey = new Map(groups.map(g => [g.key, g]));
    const num = (key, field, v, max) => {
      if (v !== null && !(typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max))
        fail("BAD_ARGS", `labels['${key}'].${field} must be a number 0-${max} or null (default)`);
    };
    const check = (key, spec) => {
      if (spec === null) return { minSize: null, maxSize: null, alwaysShow: null }; // the app default
      if (!isObj(spec))
        fail("BAD_ARGS", `labels['${key}'] must be {minSize?, maxSize?, alwaysShow?} or null (clear the override)`);
      const bad = Object.keys(spec).filter(k => k !== "minSize" && k !== "maxSize" && k !== "alwaysShow");
      if (bad.length)
        fail("BAD_ARGS", `labels['${key}']: unknown field ${bad.join(", ")} (minSize, maxSize, alwaysShow)`);
      const out = {};
      if (spec.minSize !== undefined) {
        num(key, "minSize", spec.minSize, MAX_MIN_SIZE);
        out.minSize = spec.minSize;
      }
      if (spec.maxSize !== undefined) {
        num(key, "maxSize", spec.maxSize, MAX_MAX_SIZE);
        out.maxSize = spec.maxSize;
      }
      if (spec.alwaysShow !== undefined) {
        const v = spec.alwaysShow;
        if (v !== null && typeof v !== "boolean")
          fail("BAD_ARGS", `labels['${key}'].alwaysShow must be true, false or null`);
        out.alwaysShow = v;
      }
      if (!Object.keys(out).length)
        fail("BAD_ARGS", `labels['${key}'] sets nothing: pass minSize, maxSize and/or alwaysShow, or null to clear`);
      if (typeof out.minSize === "number" && typeof out.maxSize === "number" && out.minSize > out.maxSize)
        fail(
          "BAD_ARGS",
          `labels['${key}']: minSize ${out.minSize} is over maxSize ${out.maxSize}, so it would never show`
        );
      return out;
    };
    const plan = new Map();
    const named = new Set();
    const spread = (key, kind) => {
      if (arg[key] === undefined) return;
      const spec = check(key, arg[key]);
      for (const g of groups) if (g.kind === kind) plan.set(g.key, { ...(plan.get(g.key) || {}), ...spec });
    };
    spread("*", "label");
    spread("emblems", "emblem");
    for (const [key, spec] of Object.entries(arg)) {
      if (key === "*" || key === "emblems") continue;
      if (!byKey.has(key)) unknownGroup(key, groups);
      named.add(key);
      plan.set(key, { ...(plan.get(key) || {}), ...check(key, spec) });
    }
    if (!plan.size) fail("BAD_ARGS", "labels names no group");
    return { plan, named };
  }

  /** The literal form of a plan entry for the sketch log: null when it clears the group. */
  const literalOf = spec =>
    "minSize" in spec && "maxSize" in spec && "alwaysShow" in spec && Object.values(spec).every(v => v === null)
      ? null
      : { ...spec };

  /** Would writing this plan entry leave the group exactly as it is? */
  function isNoop(g, spec) {
    const now = readGroup(g);
    if ("minSize" in spec && (spec.minSize === null ? now.minSize !== undefined : now.minSize !== spec.minSize))
      return false;
    if ("maxSize" in spec && (spec.maxSize === null ? now.maxSize !== undefined : now.maxSize !== spec.maxSize))
      return false;
    if ("alwaysShow" in spec && (spec.alwaysShow === true) !== (now.alwaysShow === true)) return false;
    return true;
  }

  /** Write one group's override; also keep the app's per-group style cache in step. */
  function writeGroup(g, spec) {
    const el = g.el;
    const put = (attr, v) => {
      if (v === null) el.removeAttribute(attr);
      else el.setAttribute(attr, String(v));
    };
    if ("minSize" in spec) put(ATTR_MIN, spec.minSize);
    if ("maxSize" in spec) put(ATTR_MAX, spec.maxSize);
    if ("alwaysShow" in spec) put(ATTR_ALWAYS, spec.alwaysShow === true ? "1" : null);
    // burgLabels rebuilds its groups from style.burgLabels[<group>] (createLabelGroups)
    try {
      const cache = el.parentElement?.id === "burgLabels" && typeof style !== "undefined" && style.burgLabels;
      if (cache?.[g.key]) {
        for (const a of ATTRS) {
          if (el.hasAttribute(a)) cache[g.key][a] = el.getAttribute(a);
          else delete cache[g.key][a];
        }
      }
    } catch {}
  }

  /** The result's `labels` for the groups a plan touched. */
  function describePlan(keys, named, live, was, counts) {
    const byKey = new Map(live.map(g => [g.key, g]));
    const groups = {};
    const warnings = [];
    let empty = 0;
    let labelsTouched = false;
    let emblemsTouched = false;
    const dead = [];
    const never = [];
    for (const key of keys) {
      const g = byKey.get(key);
      const info = infoOf(g);
      if (g.kind === "emblem") emblemsTouched = true;
      else labelsTouched = true;
      if (!info.of && !named.has(key)) {
        empty++; // a '*' reached a group with no labels yet; the override is stored all the same
        continue;
      }
      if (was.has(key) && was.get(key) !== info.visible) info.was = was.get(key);
      groups[key] = info;
      if (info.alwaysShow && (info.minSize !== undefined || info.maxSize !== undefined)) dead.push(key);
      if (info.zoom === "never") never.push(key);
    }
    if (labelsTouched && !layerOn("toggleLabels"))
      warnings.push("the labels layer is off, so no label shows; display {on:['labels']} turns it on");
    if (emblemsTouched && !layerOn("toggleEmblems"))
      warnings.push("the emblems layer is off, so no emblem shows; display {on:['emblems']} turns it on");
    if (labelsTouched && hideAuto({ kind: "label" }))
      warnings.push(
        "'Toggle visibility automatically' (labels) is off in this client, so nothing is zoom-hidden here; the override is saved for other viewers"
      );
    if (emblemsTouched && hideAuto({ kind: "emblem" }))
      warnings.push(
        "'Toggle visibility automatically' (emblems) is off in this client, so nothing is zoom-hidden here; the override is saved for other viewers"
      );
    if (dead.length) warnings.push(`alwaysShow skips both bounds, so minSize/maxSize do nothing on ${dead.join(", ")}`);
    if (never.length) warnings.push(`never shown at any zoom this view can reach: ${never.join(", ")}`);
    const out = { zoom: round2(scale), groups };
    if (counts) out.visible = counts;
    if (empty) out.empty = empty;
    const moved = Object.values(groups).some(i => i.was !== undefined);
    if (counts && !moved && counts.before === counts.after && Object.keys(groups).length && labelsTouched) {
      const differs = Object.values(groups).some(i => i.autoZoom !== undefined);
      out.note = `no label changed at zoom ${out.zoom}: ${
        differs
          ? "groups with autoZoom differ from the automatic rule only at other zooms; the rest behave as before at every zoom"
          : "the override leaves every group's zoom range as it was, so nothing differs at any zoom"
      }`;
    }
    return { labels: out, warnings };
  }

  const baseDisplay = FNS.display;
  if (typeof baseDisplay !== "function") return;

  /** display {labels:'list'}: every label/emblem group with an override or labels, read only. */
  function listLabels() {
    rezoom();
    const groups = groupList();
    const out = {};
    let empty = 0;
    let overrides = 0;
    for (const g of groups) {
      const info = infoOf(g);
      const has = Object.keys(readGroup(g)).length > 0;
      if (!info.of && !has) {
        empty++;
        continue;
      }
      if (has) overrides++;
      const size = g.kind === "emblem" ? parseFloat(g.el.getAttribute("font-size")) : parseFloat(g.el.dataset.size);
      out[g.key] = { ...(Number.isFinite(size) ? { size } : {}), ...info };
    }
    const c = countLabels(groups, true);
    const [kmin, kmax] = zoomExtent();
    return {
      labels: {
        zoom: round2(scale),
        reachable: [round2(kmin), kmax],
        autoHide: { labels: !hideAuto({ kind: "label" }), emblems: !hideAuto({ kind: "emblem" }) },
        layers: { labels: layerOn("toggleLabels"), emblems: layerOn("toggleEmblems") },
        visible: { now: c.visible, of: c.of, inView: c.inView },
        overrides,
        groups: out,
        ...(empty ? { empty } : {})
      }
    };
  }

  FNS.display = async a => {
    if (a.labels === "list") return listLabels();
    if (a.labels === undefined) {
      const out = await baseDisplay(a);
      if (a.phase !== "validate") rezoom(); // a layer turned on can hold classes from a zoom it missed
      return out;
    }
    const { labels: arg, ...rest } = a;
    const live0 = groupList();
    const { plan, named } = planOf(arg, live0); // throws before anything is touched
    if (a.phase === "validate") {
      const out = await baseDisplay(rest);
      const only = Object.keys(rest).every(k => k === "phase" || rest[k] === undefined);
      const byKey = new Map(live0.map(g => [g.key, g]));
      if (only && [...plan].every(([key, spec]) => isNoop(byKey.get(key), spec))) {
        rezoom();
        const d = describePlan([...plan.keys()], named, live0, new Map(), null);
        out.labelsNoop = { ...d.labels, unchanged: true, ...(d.warnings.length ? { warnings: d.warnings } : {}) };
      }
      return out;
    }

    rezoom(); // classes current before counting
    const before = countLabels(live0);
    const was = new Map(live0.filter(g => plan.has(g.key)).map(g => [g.key, visibleIn(g)]));
    const out = await baseDisplay(rest);
    if (!Array.isArray(out.warnings)) out.warnings = [];
    const live = groupList(); // the base call may have restyled or redrawn the groups
    const liveByKey = new Map(live.map(g => [g.key, g]));
    const resolvedLabels = {};
    for (const [key, spec] of plan) {
      const g = liveByKey.get(key);
      if (!g) {
        out.warnings.push(`label group '${key}' disappeared during the call; skipped`);
        continue;
      }
      writeGroup(g, spec);
      resolvedLabels[key] = literalOf(spec);
    }
    rezoom();
    await T.settle();

    const after = countLabels(live, true);
    const d = describePlan(Object.keys(resolvedLabels), named, live, was, {
      before: before.visible,
      after: after.visible,
      of: after.of,
      inView: after.inView
    });
    out.warnings.push(...d.warnings);
    out.labels = d.labels;
    out.resolved = { ...(out.resolved || { on: [], off: [] }), labels: resolvedLabels };
    return out;
  };

  // A layer turned on after the zoom handler ran skips it (it ignores a hidden layer), so its groups
  // keep the classes of the last zoom it saw; any layer change in this tool re-runs the handler.
  const baseSetLayers = FNS.setLayers;
  FNS.setLayers = async a => {
    const r = await baseSetLayers(a);
    if (r?.changed?.some(c => c.to === "on" && (c.layer === "labels" || c.layer === "emblems"))) rezoom();
    return r;
  };

  // ---------------------------------------------------------------- screenshot {labels:'all'}

  /**
   * screenshot {labels:'all'}: for one shot, show every label group the zoom handler hid (a
   * <style> tag, nothing in the map changes) and turn the labels layer on if it is off.
   *   {on: true}                      -> {layerTurnedOn}
   *   {on: false, restoreLayer?: true} -> {revealed}: label elements that were zoom-hidden
   * Both steps are idempotent; neither touches the map data, the undo stack or the sketch log.
   * Emblems are not revealed (their drawing waits for the zoom handler to show them).
   */
  FNS.labelsShot = async a => {
    document.getElementById(SHOT_STYLE_ID)?.remove();
    if (a.on) {
      const tag = document.createElement("style");
      tag.id = SHOT_STYLE_ID;
      // not a group the user hid by hand (inline display:none); !important beats .hidden's own
      tag.textContent =
        '#labels g.hidden:not([style*="display: none"]):not([style*="display:none"]){display:inline!important}';
      document.head.appendChild(tag);
      const layerTurnedOn = !layerOn("toggleLabels");
      if (layerTurnedOn) {
        try {
          await FNS.setLayers({ on: ["labels"] }); // also re-runs the zoom handler
        } catch (e) {
          tag.remove();
          throw e;
        }
      }
      return { layerTurnedOn };
    }
    // the style is already removed above; count what it was revealing (zoom-hidden, not user-hidden)
    let revealed = 0;
    for (const g of groupList()) {
      if (g.kind !== "label") continue;
      for (const it of itemsOf(g)) if (isShown(it, { ignoreZoom: true }) && !isShown(it)) revealed++;
    }
    if (a.restoreLayer) await FNS.setLayers({ off: ["labels"] });
    return { revealed };
  };

  // ---------------------------------------------------------------- whole-map raster / SVG

  /**
   * Label and emblem sizes and zoom-hiding follow the camera (invokeActiveZooming), so a whole-map
   * raster or SVG taken after a zoomed shot had tiny labels. Run it with the zoom handler set to the
   * full-map (fit) zoom, the state of a freshly loaded map, then put the camera's state back.
   */
  async function atFullMapZoom(run) {
    let k = 0;
    try {
      const [kmin] = zoomExtent();
      k = Math.max(kmin, Math.min(svgWidth / graphWidth, svgHeight / graphHeight));
    } catch {}
    if (typeof invokeActiveZooming !== "function" || !(k > 0) || Math.abs(k - scale) < 1e-6) return run();
    const saved = scale;
    scale = k;
    try {
      invokeActiveZooming();
      return await run();
    } finally {
      scale = saved;
      invokeActiveZooming();
    }
  }

  for (const name of ["rasterize", "exportSvg"]) {
    const base = FNS[name];
    // keep the function's flags (raw: skip the JSON size caps for base64 results)
    if (typeof base === "function") FNS[name] = Object.assign(a => atFullMapZoom(() => base(a)), base);
  }
})(globalThis);
