// Tupaia MCP bridge extension: label visibility overrides ("labels" track).
//
// The app hides a label group while its on-screen size is under 6 px (public/main.js,
// invokeActiveZooming). `display {labels: {<group>: {minSize?, alwaysShow?}}}` stores a per-group
// override on the SVG group itself (data-min-size / data-always-show, so it rides in the .map
// file); the zoom handler reads them. This file wraps FNS.display to validate and apply that
// field, and adds FNS.labelsShot, the non-persistent "show every label for one screenshot".
// Same rules as bridge-mutations.js: bare app globals at call time, no locals that shadow app
// globals, every FNS function takes one args object.
(root => {
  const T = root.__tupaia;
  if (!T) return;
  const FNS = T.fns;
  const fail = T.fail;

  const ATTR_MIN = "data-min-size";
  const ATTR_ALWAYS = "data-always-show";
  const SHOT_STYLE_ID = "tupaia-labels-all";
  const EMBLEM_GROUPS = ["burgEmblems", "provinceEmblems", "stateEmblems"];
  const MAX_MIN_SIZE = 1000;

  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
  const isG = el => el.tagName.toLowerCase() === "g";

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

  /** Label elements on screen right now: {visible, of} over the label groups (not emblems). */
  function countLabels(groups) {
    let visible = 0;
    let of = 0;
    for (const g of groups) {
      if (g.kind !== "label") continue;
      const items = itemsOf(g);
      of += items.length;
      if (groupLayerOn(g)) for (const it of items) if (isShown(it)) visible++;
    }
    return { visible, of };
  }

  /** The override a group carries now, only the fields that are set. */
  const readGroup = g => {
    const minAttr = parseFloat(g.el.getAttribute(ATTR_MIN));
    const always = g.el.getAttribute(ATTR_ALWAYS);
    const out = {};
    if (Number.isFinite(minAttr)) out.minSize = minAttr;
    if (always === "1" || always === "true") out.alwaysShow = true;
    return out;
  };

  /**
   * Validate the labels argument against the live groups. Returns a Map of group key -> override
   * {minSize?: number|null, alwaysShow?: boolean|null} (null = clear that attribute): a null spec
   * clears both, '*' (every label group) is expanded and a group's own spec is laid over it
   * field by field.
   */
  function planOf(arg, groups) {
    if (!isObj(arg)) fail("BAD_ARGS", "labels is {'<group>': {minSize?, alwaysShow?} | null}");
    const byKey = new Map(groups.map(g => [g.key, g]));
    const check = (key, spec) => {
      if (spec === null) return { minSize: null, alwaysShow: null }; // back to the app default
      if (!isObj(spec))
        fail("BAD_ARGS", `labels['${key}'] must be {minSize?, alwaysShow?} or null (clear the override)`);
      const bad = Object.keys(spec).filter(k => k !== "minSize" && k !== "alwaysShow");
      if (bad.length) fail("BAD_ARGS", `labels['${key}']: unknown field ${bad.join(", ")} (minSize, alwaysShow)`);
      const out = {};
      if (spec.minSize !== undefined) {
        const m = spec.minSize;
        if (m !== null && !(typeof m === "number" && Number.isFinite(m) && m >= 0 && m <= MAX_MIN_SIZE))
          fail("BAD_ARGS", `labels['${key}'].minSize must be a number 0-${MAX_MIN_SIZE} or null (default)`);
        out.minSize = m;
      }
      if (spec.alwaysShow !== undefined) {
        const v = spec.alwaysShow;
        if (v !== null && typeof v !== "boolean")
          fail("BAD_ARGS", `labels['${key}'].alwaysShow must be true, false or null`);
        out.alwaysShow = v;
      }
      if (!Object.keys(out).length)
        fail("BAD_ARGS", `labels['${key}'] sets nothing: pass minSize and/or alwaysShow, or null to clear`);
      return out;
    };
    const plan = new Map();
    if (arg["*"] !== undefined) {
      const star = check("*", arg["*"]);
      for (const g of groups) if (g.kind === "label") plan.set(g.key, { ...star });
    }
    for (const [key, spec] of Object.entries(arg)) {
      if (key === "*") continue;
      if (!byKey.has(key))
        fail("BAD_ARGS", `unknown label group '${key}'`, {
          details: [...groups.map(g => g.key), "* (every label group)"]
        });
      plan.set(key, { ...(plan.get(key) || {}), ...check(key, spec) });
    }
    if (!plan.size) fail("BAD_ARGS", "labels names no group");
    return plan;
  }

  /** The literal form of a plan entry for the sketch log: null when it clears the group. */
  const literalOf = spec => (spec.minSize === null && spec.alwaysShow === null ? null : { ...spec });

  /** Write one group's override; also keep the app's per-group style cache in step. */
  function writeGroup(g, spec) {
    const el = g.el;
    if ("minSize" in spec) {
      if (spec.minSize === null) el.removeAttribute(ATTR_MIN);
      else el.setAttribute(ATTR_MIN, String(spec.minSize));
    }
    if ("alwaysShow" in spec) {
      if (spec.alwaysShow === true) el.setAttribute(ATTR_ALWAYS, "1");
      else el.removeAttribute(ATTR_ALWAYS);
    }
    // burgLabels rebuilds its groups from style.burgLabels[<group>] (createLabelGroups)
    try {
      const cache = el.parentElement?.id === "burgLabels" && typeof style !== "undefined" && style.burgLabels;
      if (cache?.[g.key]) {
        for (const a of [ATTR_MIN, ATTR_ALWAYS]) {
          if (el.hasAttribute(a)) cache[g.key][a] = el.getAttribute(a);
          else delete cache[g.key][a];
        }
      }
    } catch {}
  }

  const baseDisplay = FNS.display;
  if (typeof baseDisplay !== "function") return;

  FNS.display = async a => {
    if (a.labels === undefined) return baseDisplay(a);
    const { labels: arg, ...rest } = a;
    const plan = planOf(arg, groupList()); // throws before anything is touched
    if (a.phase === "validate") return baseDisplay(rest);

    if (typeof invokeActiveZooming === "function") invokeActiveZooming(); // classes current before counting
    const before = countLabels(groupList());
    const out = await baseDisplay(rest);
    if (!Array.isArray(out.warnings)) out.warnings = [];
    const warnings = out.warnings;
    const live = groupList(); // the base call may have restyled or redrawn the groups
    const liveByKey = new Map(live.map(g => [g.key, g]));
    const resolvedLabels = {};
    for (const [key, spec] of plan) {
      const g = liveByKey.get(key);
      if (!g) {
        warnings.push(`label group '${key}' disappeared during the call; skipped`);
        continue;
      }
      writeGroup(g, spec);
      resolvedLabels[key] = literalOf(spec);
    }
    if (typeof invokeActiveZooming === "function") invokeActiveZooming();
    await T.settle();

    const groups = {};
    let labelsTouched = false;
    let emblemsTouched = false;
    for (const key of Object.keys(resolvedLabels)) {
      const g = liveByKey.get(key);
      const items = itemsOf(g);
      groups[key] = {
        ...readGroup(g),
        visible: groupLayerOn(g) ? items.filter(it => isShown(it)).length : 0,
        of: items.length
      };
      if (g.kind === "emblem") emblemsTouched = true;
      else labelsTouched = true;
    }
    if (labelsTouched && !layerOn("toggleLabels"))
      warnings.push("the labels layer is off, so no label shows; display {on:['labels']} turns it on");
    if (emblemsTouched && !layerOn("toggleEmblems"))
      warnings.push("the emblems layer is off, so no emblem shows; display {on:['emblems']} turns it on");
    const after = countLabels(live);
    out.labels = { visible: { before: before.visible, after: after.visible, of: after.of }, groups };
    out.resolved = { ...(out.resolved || { on: [], off: [] }), labels: resolvedLabels };
    return out;
  };

  /**
   * screenshot {labels:'all'}: for one shot, show every label group the zoom handler hid (a
   * <style> tag, nothing in the map changes) and turn the labels layer on if it is off.
   *   {on: true}                      -> {layerTurnedOn}
   *   {on: false, restoreLayer?: true} -> {revealed}: label elements that were zoom-hidden
   * Both steps are idempotent; neither touches the map data, the undo stack or the sketch log.
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
          await FNS.setLayers({ on: ["labels"] });
        } catch (e) {
          tag.remove();
          throw e;
        }
        if (typeof invokeActiveZooming === "function") invokeActiveZooming();
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
})(globalThis);
