// Tupaia MCP bridge extension 'apply': match a spec's entries to the map by name and report, or
// apply, the differences (FNS.applySpec). A classic script injected after bridge.js and
// bridge-mutations.js, with their rules: app globals by bare name at call time, no locals that
// shadow app globals (labels, routes, markers, zones, rivers, notes, population, legend,
// options, ...), one args object per FNS function.
//
// It never sets a field itself. Comparisons use FIELDS[type][field] (check -> show -> get) and
// every change goes through FNS.edit / FNS.add / FNS.paint (phase 'apply', continueOnError) for
// whatever types and fields the page has at call time, so types other extensions add (biome,
// routeGroup, freehand route points, ...) work here without changes. Each of those calls is one
// "step"; Node logs every step's resolved form as its own edit/add/paint_cells record (all under
// the call's one auto-undo entry), so sketch replay, its conflict checks and its id remapping
// of created entities work exactly as for those tools.
//
// It also adds one edit field, FIELDS.label.group (move a label into another #labels group),
// unless another extension defines it, so a spec's label group is settable like any field.
(root => {
  const T = root.__tupaia;
  if (!T?.mutations) return;
  const FNS = T.fns;
  const fail = T.fail;
  const I = T.internals;
  const fold = T.pure.fold;
  const M = T.mutations;
  const FIELDS = M.FIELDS;
  const ADD = M.ADD;

  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
  const isNum = v => typeof v === "number" && Number.isFinite(v);
  const rn = (v, d = 1) => {
    const m = 10 ** d;
    return Math.round(v * m) / m;
  };
  const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  // after every page call: the page's memo and our name indexes (names may have changed)
  const reset = () => {
    T.resetMemo?.();
    nameIndexes.clear();
  };
  const hasKeys = o => isObj(o) && Object.keys(o).length > 0;

  // Types whose entries own a note through the `note` shorthand (a marker's note is the field
  // FIELDS.marker.note); value: the note id of an entity of that type.
  const NOTE_OWNER = {
    burg: x => `burg${x.i}`,
    state: x => `stateLabel${x.i}`,
    route: x => `route${x.i}`,
    river: x => `river${x.i}`,
    province: x => `province${x.i}`,
    culture: x => `culture${x.i}`,
    religion: x => `religion${x.i}`,
    label: x => x.id
  };
  // ADD.note attaches through entity:{type,ref} for these; the others take a literal id.
  const NOTE_ENTITY_TYPES = ["burg", "marker", "state", "route", "river", "province"];

  // Keys used only to create an entity (not compared on an existing one, not reported ignored).
  const CREATE_ONLY = {
    burg: ["at"],
    state: ["at", "expand", "capitalName"],
    marker: ["at"],
    route: ["through", "points", "noPathfind"],
    zone: ["select"],
    label: ["at"],
    culture: ["at", "expand"],
    religion: ["at", "expand"]
  };

  // Read-only keys an add would refuse: kept out of the item, compared once the entity exists.
  const CREATE_DROPS = { burg: ["state", "capital"] };

  // Fields with nothing to compare (a set-only action): never compared or set by apply. A FIELDS
  // entry can also say so itself with writeOnly:true.
  const WRITE_ONLY = { map: ["lock", "unlock"] };

  // The core types (numeric ids, or note/label string ids that are never created by id). An entry
  // `id` of any other type (a route group 'route-tunnels') is its key and may create it.
  const CORE_TYPES = [
    "map",
    "burg",
    "state",
    "province",
    "culture",
    "religion",
    "marker",
    "route",
    "zone",
    "river",
    "feature",
    "note",
    "label",
    "namesbase"
  ];

  // Fields whose values are ids of other entities: shown as "name (id)".
  const REF_SHOW = {
    burg: { culture: "culture" },
    state: { capital: "burg", culture: "culture" },
    province: { capital: "burg" },
    culture: { base: "namesbase" }
  };

  // ---------------------------------------------------------------- comparison

  const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  function normColor(v) {
    const s = String(v).trim().toLowerCase();
    const m = HEX.exec(s);
    if (m && m[1].length === 3)
      return `#${m[1]
        .split("")
        .map(ch => ch + ch)
        .join("")}`;
    return s;
  }

  let decoder = null;
  function decodeHtml(s) {
    if (typeof document === "undefined") return s;
    decoder = decoder || document.createElement("textarea");
    decoder.innerHTML = s;
    return decoder.value;
  }

  const isColorField = f => /colou?r$/i.test(f);
  const isPlaceLike = v => isObj(v) && isNum(v.x) && isNum(v.y);
  const isPoint = v => isPlaceLike(v) || (Array.isArray(v) && v.length >= 2 && isNum(v[0]) && isNum(v[1]));
  const ptXY = v => (Array.isArray(v) ? { x: v[0], y: v[1] } : v);

  function tolFor(tol, field, kind) {
    if (isObj(tol.fields) && isNum(tol.fields[field])) return tol.fields[field];
    if (kind === "px") return isNum(tol.px) ? tol.px : 1;
    return isNum(tol.number) ? tol.number : 0;
  }

  const lastKey = field => String(field).split(".").pop();
  /** A field holding a set of cell ids (order and repeats do not matter). */
  const isCellsField = field => lastKey(field) === "cells";

  /** Strings compare after: label text without '|' breaks, legends HTML-decoded, colours folded. */
  function textOf(field, v) {
    const f = lastKey(field);
    let s = String(v);
    if (f === "text") s = s.replace(/\|/g, "");
    if (f === "legend") s = decodeHtml(s);
    if (isColorField(f)) s = normColor(s);
    return s;
  }

  /**
   * Does `have` (the entity's value) match `want` (the spec value as FIELDS shows it)?
   * tol.legend 'contains': a legend that contains the spec's text matches (a legend composed of
   * the spec text plus more, e.g. a prefix or a list appended).
   */
  function same(field, have, want, tol) {
    if (want === undefined) return true;
    if (have === want) return true;
    if (have === null || have === undefined || want === null) return (have ?? null) === (want ?? null);
    if (isNum(have) && isNum(want)) return Math.abs(have - want) <= tolFor(tol, field, "number");
    if (typeof have === "string" && typeof want === "string") {
      const a = textOf(field, have);
      const b = textOf(field, want);
      if (tol?.legend === "contains" && lastKey(field) === "legend") return a.includes(b);
      return a === b;
    }
    if (typeof have === "boolean" || typeof want === "boolean") return !!have === !!want;
    if (isPlaceLike(have) && isPlaceLike(want))
      return Math.hypot(have.x - want.x, have.y - want.y) <= tolFor(tol, field, "px");
    if (Array.isArray(have) && Array.isArray(want)) {
      if (isCellsField(field) && have.every(isNum) && want.every(isNum)) {
        // cell lists: as sets
        const a = new Set(have);
        return a.size === new Set(want).size && want.every(x => a.has(x));
      }
      // any other list (winds, a numbers list): by position
      if (have.length !== want.length) return false;
      if (have.every(isPoint) && want.every(isPoint))
        return have.every((p, k) => {
          const a = ptXY(p);
          const b = ptXY(want[k]);
          return Math.hypot(a.x - b.x, a.y - b.y) <= tolFor(tol, field, "px");
        });
      return have.every((x, k) => same(field, x, want[k], tol));
    }
    // objects (e.g. a marker note): only the keys the spec gives
    if (isObj(have) && isObj(want)) return Object.keys(want).every(k => same(k, have[k], want[k], tol));
    return JSON.stringify(have) === JSON.stringify(want);
  }

  function refName(type, id) {
    if (id === null || id === undefined) return null;
    try {
      const x = I.byId(type, id);
      const n = x ? I.nameOf(type, x) : null;
      return n ? `${n} (${id})` : id;
    } catch {
      return id;
    }
  }

  /** A short, readable {field, have, want, ...} for one difference. */
  function diffRow(type, field, have, want, extra, tol = {}) {
    if (isObj(have) && isObj(want) && !isPlaceLike(have) && !isPlaceLike(want)) {
      // e.g. a marker note {name, legend}: the first differing key
      const k = Object.keys(want).find(key => !same(key, have[key], want[key], tol));
      if (k) return diffRow(type, `${field}.${k}`, have[k] ?? null, want[k], extra, tol);
    }
    const row = { field };
    const refType = REF_SHOW[type]?.[field];
    let h = have;
    let w = want;
    if (refType) {
      h = refName(refType, have);
      w = refName(refType, want);
    } else if (field === "port") {
      h = !!have;
      w = !!want;
    } else if (isPlaceLike(have) || isPlaceLike(want)) {
      if (isPlaceLike(have) && isPlaceLike(want)) row.px = rn(Math.hypot(have.x - want.x, have.y - want.y));
      h = isPlaceLike(have) ? { x: rn(have.x), y: rn(have.y) } : have;
      w = isPlaceLike(want) ? { x: rn(want.x), y: rn(want.y) } : want;
    } else if (
      isCellsField(field) &&
      Array.isArray(have) &&
      Array.isArray(want) &&
      have.every(isNum) &&
      want.every(isNum)
    ) {
      const a = new Set(have);
      const b = new Set(want);
      h = `${a.size} cells`;
      w = `${b.size} cells`;
      row.add = [...b].filter(x => !a.has(x)).length;
      row.remove = [...a].filter(x => !b.has(x)).length;
    } else if (typeof have === "string" && typeof want === "string" && (have.length > 80 || want.length > 80)) {
      // long text (legends): around the first difference
      const a = textOf(field, have);
      const b = textOf(field, want);
      let d = 0;
      while (d < a.length && d < b.length && a[d] === b[d]) d++;
      const from = Math.max(0, d - 20);
      const cut = s => `${from > 0 ? "…" : ""}${s.slice(from, from + 60)}${from + 60 < s.length ? "…" : ""}`;
      h = cut(a);
      w = cut(b);
      row.at = d;
      row.len = [a.length, b.length];
    } else if (Array.isArray(have) || Array.isArray(want)) {
      // short lists (winds) in full; long ones as a count and the first differing position
      if (Array.isArray(have) && Array.isArray(want) && (have.length > 12 || want.length > 12)) {
        let d = 0;
        while (d < have.length && d < want.length && same(field, have[d], want[d], {})) d++;
        row.at = d;
      }
      h = Array.isArray(have) && have.length > 12 ? `${have.length} items` : have;
      w = Array.isArray(want) && want.length > 12 ? `${want.length} items` : want;
    }
    row.have = clone(h);
    row.want = clone(w);
    if (extra) Object.assign(row, extra);
    return row;
  }

  // ---------------------------------------------------------------- lookup

  const cmpId = (a, b) =>
    typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b), "en", { numeric: true });

  /** Other names an entity matches: a state's or province's full name, an extension type's string id. */
  function alts(type, x, i) {
    if ((type === "state" || type === "province") && x.fullName) return [x.fullName];
    // e.g. a route group 'route-journeys' named 'Journeys' (ids of notes/labels are not names)
    if (typeof i === "string" && type !== "note" && type !== "label") return [i];
    return [];
  }

  function candidate(type, x) {
    const row = { type, i: I.idOf(type, x), name: I.nameOf(type, x) };
    try {
      const p = I.anchor(type, x);
      if (p) Object.assign(row, { x: rn(p.x), y: rn(p.y) });
    } catch {}
    return row;
  }

  // Per type: {exact, folded} maps from a name (or alt name) to the live entities so named, in
  // id order. Built once and dropped after every page call (reset), so a spec of n entries on a
  // map of m entities costs O(n + m) per list, not O(n * m).
  const nameIndexes = new Map();

  function nameIndex(type) {
    let ix = nameIndexes.get(type);
    if (ix) return ix;
    const rows = I.liveList(type, false).map(x => {
      const i = I.idOf(type, x);
      return { x, i, name: I.nameOf(type, x) };
    });
    rows.sort((a, b) => cmpId(a.i, b.i));
    const exact = new Map();
    const folded = new Map();
    const put = (m, k, r) => {
      let list = m.get(k);
      if (!list) {
        list = [];
        m.set(k, list);
      }
      if (list[list.length - 1] !== r) list.push(r);
    };
    for (const r of rows)
      for (const n of [r.name, ...alts(type, r.x, r.i)]) {
        if (typeof n !== "string" || !n) continue;
        put(exact, n, r);
        put(folded, fold(n), r);
      }
    ix = { exact, folded };
    nameIndexes.set(type, ix);
    return ix;
  }

  /**
   * Every live entity of `type` named `name`: exact matches, else case/diacritic folded ones
   * (labels ignore '|' line breaks; states and provinces also match their full name), in id
   * order: [{i, name, entity, alt}], alt = matched an alt name (full name, id), not the name.
   */
  function allByName(type, name) {
    const key = type === "label" ? String(name).replace(/\|/g, "") : String(name);
    let ix;
    try {
      ix = nameIndex(type);
    } catch (e) {
      if (e?.code !== "BAD_TYPE") throw e;
      // a type the core lists do not know (an extension's): its resolve decides
      try {
        const r = T.resolve(type, { name: key });
        return [{ i: r.i, name: r.name, entity: r.entity, alt: false }];
      } catch (e2) {
        if (e2?.code === "NOT_FOUND") return [];
        if (e2?.code === "AMBIGUOUS")
          return (e2.candidates || []).map(c => ({ i: c.i, name: c.name, entity: null, alt: false }));
        throw e2;
      }
    }
    const f = fold(key);
    const hits = ix.exact.get(key) || ix.folded.get(f) || [];
    return hits.map(h => ({ i: h.i, name: h.name, entity: h.x, alt: fold(h.name) !== f }));
  }

  /** The one hit whose position lies within the px tolerance of `at`, or null. */
  function nearHit(type, hits, at, tol) {
    if (!isPlaceLike(at)) return null;
    const lim = tolFor(tol, "move", "px");
    const near = hits.filter(h => {
      try {
        const p = h.entity ? I.anchor(type, h.entity) : null;
        return !!p && Math.hypot(p.x - at.x, p.y - at.y) <= lim;
      } catch {
        return false;
      }
    });
    return near.length === 1 ? near[0] : null;
  }

  /**
   * The existing entity an entry names. Several of that name: the one at the entry's place
   * (within the px tolerance), else, when the list names it `dups` times and this is occurrence
   * `nth`, the nth in id order. One spec entry but several on the map and no place to tell them
   * apart: AMBIGUOUS (with candidates). null: none.
   */
  function findByName(type, name, nth = 0, dups = 1, at = null, tol = {}) {
    const hits = allByName(type, name);
    if (hits.length > 1) {
      const near = nearHit(type, hits, at, tol);
      if (near) return near;
    }
    if (hits.length > 1 && dups === 1)
      fail("AMBIGUOUS", `${hits.length} ${type}s are named '${name}'; give the entry a ref (id) or its x,y`, {
        candidates: hits.slice(0, 8).map(h => (h.entity ? candidate(type, h.entity) : { type, i: h.i, name: h.name }))
      });
    return hits[nth] ?? null;
  }

  function byRef(type, ref) {
    const r = T.resolve(type, ref);
    return { i: r.i, name: r.name, entity: r.entity, alt: false };
  }

  // ---------------------------------------------------------------- read-only checks
  // Fields apply compares but cannot set (another tool changes them); used only while FIELDS
  // has no such field. Each returns {same} or {same:false, have, want, fix?}.

  function distToPolyline(p, pts) {
    let best = Infinity;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k];
      const b = pts[k + 1] || a;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const L = dx * dx + dy * dy;
      let t = L ? ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / L : 0;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(p.x - (a[0] + t * dx), p.y - (a[1] + t * dy)));
    }
    return best;
  }

  /** Route through/points: every place lies near the drawn route (default: one cell spacing). */
  function routeCheck(field) {
    return (r, want, tol) => {
      if (!Array.isArray(want)) return { same: true };
      const pts = (r.points || []).map(p => [p[0], p[1]]);
      const own = isObj(tol.fields) && isNum(tol.fields[field]) ? tol.fields[field] : null;
      const lim =
        own ?? Math.max(tolFor(tol, field, "px"), Math.sqrt((graphWidth * graphHeight) / pack.cells.i.length));
      const off = [];
      let worst = 0;
      want.forEach((w, k) => {
        let p;
        try {
          p = T.place(w);
        } catch (e) {
          off.push({ k, error: `${e.code}: ${e.message}` });
          return;
        }
        const d = distToPolyline(p, pts);
        worst = Math.max(worst, d);
        if (d > lim) off.push({ k, px: rn(d) });
      });
      if (!off.length) return { same: true };
      return {
        same: false,
        have: { off: off.slice(0, 6), worstPx: rn(worst) },
        want: `every place within ${rn(lim)} px (tolerance.fields.${field})`,
        fix: "edit route {remove:true}, then apply again to re-create it along the spec"
      };
    };
  }

  const READ_ONLY = {
    burg: {
      state: (b, want) => {
        let wantId = null;
        // "", null, "Neutral(s)": no state
        if (want === null || (typeof want === "string" && /^(neutrals?)?$/i.test(want.trim()))) wantId = 0;
        else
          try {
            wantId = T.resolve("state", want).i;
          } catch {}
        const have = pack.states[b.state]?.name ?? "Neutrals";
        if (wantId === null)
          return fold(have) === fold(String(want))
            ? { same: true }
            : { same: false, have, want: `${want} (no such state)`, fix: "paint_cells" };
        return wantId === b.state ? { same: true } : { same: false, have, want: String(want), fix: "paint_cells" };
      },
      capital: (b, want) =>
        !!b.capital === !!want
          ? { same: true }
          : { same: false, have: !!b.capital, want: !!want, fix: "edit state {capital}" }
    },
    route: { through: routeCheck("through"), points: routeCheck("points") }
  };

  // ---------------------------------------------------------------- label group (edit field)
  // edit label {set:{group}} moves a label's text into another #labels group, made like add
  // label makes one when it does not exist. Defined here unless another extension has it.

  const LABEL_GROUP_RE = /^[A-Za-z][\w-]*$/;

  /** A label group id apply/edit may use: its own #labels group, or a new id nothing else uses. */
  function labelGroupCheck(v) {
    if (typeof v !== "string" || !LABEL_GROUP_RE.test(v))
      fail("BAD_ARGS", "group is a label group id: letters, digits, '_' and '-', starting with a letter");
    const own = document.querySelector(`#labels > g#${CSS.escape(v)}`);
    if (!own && document.getElementById(v))
      fail(
        "REFUSED",
        `label group id '${v}' is taken by the map's #${v} element; use another id (e.g. mapping.values.labels.group: 'lbl_{}')`
      );
    return v;
  }

  if (FIELDS.label && !FIELDS.label.group)
    FIELDS.label.group = {
      check: labelGroupCheck,
      get: l => l.el?.parentNode?.id ?? null,
      // the text moves as is (no redraw; add label draws directly too)
      set: (l, v) => {
        let g = labels.select(`#${CSS.escape(v)}`);
        if (!g.size())
          g = labels
            .append("g")
            .attr("id", v)
            .attr("fill", "#3e3e4b")
            .attr("opacity", 1)
            .attr("stroke", "#3a3a3a")
            .attr("stroke-width", 0)
            .attr("font-family", "Almendra SC")
            .attr("font-size", 18)
            .attr("data-size", 18)
            .attr("filter", null);
        g.classed("hidden", false);
        g.node().appendChild(l.el);
        l.group = v;
      }
    };

  // ---------------------------------------------------------------- compare one entity

  function stubContext(setObj) {
    return {
      args: {},
      notes: new Set(),
      claimed: new Set(),
      R: { add() {}, list: [], hidden: new Set() },
      used: () => new Set(),
      set: setObj || {}
    };
  }

  function errOf(e) {
    const out = { code: e?.code || "PAGE_ERROR", message: String(e?.message || e) };
    if (e?.candidates) out.candidates = e.candidates;
    return out;
  }

  /**
   * Compare spec fields F with entity x of `type` (null for the map). Returns {diffs, set (the
   * spec values to edit), ignored, blocked (a field the page refuses), ro (read-only fields)}.
   */
  function compare(type, x, F, tol, pending) {
    const table = FIELDS[type] || {};
    const diffs = [];
    const set = {};
    const ignored = [];
    const writeOnly = [];
    const ro = {};
    let blocked = null;
    for (const key of Object.keys(F)) {
      const want = F[key];
      const f = table[key];
      if (f && (f.writeOnly || WRITE_ONLY[type]?.includes(key))) {
        writeOnly.push(key);
        continue;
      }
      if (f && typeof f.get === "function" && typeof f.set === "function") {
        if (f.isName && typeof want !== "string") continue; // a generated name never compares
        const have = clone(f.get(x));
        let shown;
        let err = null;
        try {
          const v = f.check(want, x, stubContext(F), F);
          shown = clone(f.show ? f.show(v) : v);
        } catch (e) {
          err = errOf(e);
        }
        if (err) {
          if (same(key, have, want, tol)) continue;
          const d = diffRow(type, key, have, want);
          const dep = pendingDep(err, pending);
          if (dep) {
            // e.g. a burg's culture that an earlier list of this spec creates: a change, not an error
            d.pending = `${dep} is created by this spec`;
            diffs.push(d);
            set[key] = want;
            continue;
          }
          d.error = `${err.code}: ${err.message}`;
          diffs.push(d);
          blocked = blocked || { field: key, ...err };
          continue;
        }
        if (same(key, have, shown, tol)) continue;
        diffs.push(diffRow(type, key, have, shown, null, tol));
        set[key] = want;
        continue;
      }
      if (READ_ONLY[type]?.[key]) {
        ro[key] = want;
        continue;
      }
      if ((CREATE_ONLY[type] || []).includes(key)) continue;
      ignored.push(key);
    }
    diffs.push(...readOnlyDiffs(type, x, ro, tol));
    return { diffs, set, ignored, writeOnly, blocked, ro };
  }

  /**
   * Validate/check only: when `err` is a NOT_FOUND/REMOVED for an entity that an earlier list of
   * this spec would create (pending: Map type -> Set of folded names), a short "type 'name'".
   */
  function pendingDep(err, pending) {
    if (!pending || !err) return null;
    const msg = String(err.message || "");
    let m = null;
    if (err.code === "NOT_FOUND") m = /no (\w+) named '(.*)'(?:; see candidates)?$/.exec(msg);
    else if (err.code === "REMOVED") m = /(\w+) '(.*)' \([^)]*\) was removed$/.exec(msg);
    if (!m) return null;
    return pending.get(m[1])?.has(fold(m[2])) ? `${m[1]} '${m[2]}'` : null;
  }

  /** Add/edit error text with a hint where the page's own message leaves the cause unclear. */
  function decorate(err, type) {
    let msg = String(err.message || "");
    // name the burg that already holds the cell (a renamed burg is the usual cause)
    msg = msg.replace(/already holds a burg \((\d+)\)/, (all, id) => {
      const b = pack.burgs?.[+id];
      return b?.name ? `already holds burg ${id} '${b.name}' (renamed? give the entry ref ${id})` : all;
    });
    if (type === "route" && /route group/.test(msg))
      msg += ADD.routeGroup
        ? "; add the group in a routeGroups list (id 'route-<name>') or map the name with mapping.values.routes.group"
        : "; this build has only these route groups: map other names with mapping.values.routes.group";
    return { ...err, message: msg };
  }

  function readOnlyDiffs(type, x, ro, tol) {
    const out = [];
    for (const [key, want] of Object.entries(ro || {})) {
      const r = READ_ONLY[type][key](x, want, tol);
      if (r && !r.same) {
        const d = diffRow(type, key, r.have, r.want, { readOnly: true });
        if (r.fix) d.fix = r.fix;
        out.push(d);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- per-entry plan

  /**
   * The key of an entry: {ref} (explicit, must exist), {ref, byId} (the `id` of an extension
   * type such as a route group, which may then create it) or {name} (labels: text). A core
   * type's `id` is not a key (a spec may number its entries its own way): ref is.
   */
  function keyOf(type, e) {
    if (e.ref !== undefined) return { ref: e.ref };
    if (!CORE_TYPES.includes(type) && typeof e.id === "string" && e.id.trim()) return { ref: e.id, byId: true };
    const name = type === "label" ? e.text : e.name;
    if (typeof name === "string" && name.trim()) return { name };
    return null;
  }

  /** An entity of `type` the add creates under the id the entry gives (not a core type). */
  const creatableById = type => !CORE_TYPES.includes(type) && !!ADD[type];

  const nameField = type => (type === "label" ? "text" : "name");

  function clampPlace(p) {
    if (!isPlaceLike(p)) return p;
    return { ...p, x: Math.min(Math.max(p.x, 1), graphWidth - 1), y: Math.min(Math.max(p.y, 1), graphHeight - 1) };
  }

  /** Row status from a comparison: differs / update (to apply) / error (refused field). */
  function settle(row, cmp, mode) {
    row.ignored.push(...cmp.ignored);
    row.ro = cmp.ro;
    if (cmp.diffs.length) row.diffs = cmp.diffs;
    const fixable = Object.keys(cmp.set).length > 0 || !!row.zoneCells;
    if (cmp.writeOnly?.length) row.writeOnly = cmp.writeOnly;
    if (cmp.blocked) {
      row.status = mode === "check" ? "differs" : "error";
      if (mode !== "check") row.error = cmp.blocked;
    } else if (fixable && mode !== "check") {
      row.act = "update";
      row.status = "update";
      row.set = cmp.set;
    } else if (cmp.diffs.length) row.status = "differs";
  }

  /**
   * The plan of one entry: {act:'none'|'update'|'create', status, key, i?, name?, diffs?, set?,
   * item?, error?, ignored, note?, ro?}. Errors become rows; nothing throws.
   */
  function planEntry(type, raw, ctx) {
    const row = { status: "unchanged", act: "none", ignored: [] };
    const e = { ...raw };
    const key = keyOf(type, e);
    row.key = key ? (key.ref ?? key.name) : null;
    if (!key) {
      row.status = "error";
      row.error = { code: "BAD_ARGS", message: `a ${type} entry needs ${nameField(type)} (or ref)` };
      return row;
    }
    // note shorthand: the entity's note is handled with the notes, once the entity exists
    if (e.note !== undefined && !FIELDS[type]?.note) {
      if (NOTE_OWNER[type]) row.note = e.note;
      else row.ignored.push("note");
      delete e.note;
    }
    if (ctx.clamp) {
      if (e.at !== undefined) e.at = clampPlace(e.at);
      if (e.move !== undefined) e.move = clampPlace(e.move);
    }
    // a marker's name is its note's name; the markers entry owns that note (see runSpec)
    if (type === "marker") {
      const n = typeof e.note === "string" ? { legend: e.note } : isObj(e.note) ? { ...e.note } : {};
      if (typeof e.name === "string") n.name = e.name;
      delete e.name;
      if (hasKeys(n)) {
        e.note = n;
        row.ownsNote = true;
      } else delete e.note;
    }
    let found;
    try {
      if (key.ref === undefined) found = findByName(type, key.name, ctx.nth, ctx.dups, e.at, ctx.tol);
      else
        try {
          found = byRef(type, key.byId ? { id: key.ref } : key.ref);
        } catch (err) {
          // an extension entity named by its id (a route group) that does not exist yet
          if (!(key.byId && err?.code === "NOT_FOUND" && creatableById(type))) throw err;
          found = null;
        }
    } catch (err) {
      row.status = "error";
      row.error = errOf(err);
      return row;
    }
    if (found) {
      row.i = found.i;
      row.name = found.name;
      row.entity = found.entity;
      const F = { ...e };
      delete F.ref;
      if (key.byId) delete F.id;
      // matched by name: a different case still renames; a full-name match never does
      if (key.ref === undefined && (found.alt || !FIELDS[type]?.[nameField(type)])) delete F[nameField(type)];
      if (FIELDS[type]?.move && F.at !== undefined && F.move === undefined) {
        F.move = F.at;
        delete F.at;
      }
      if (type === "state" && isObj(F.capital) && F.capital.burg !== undefined) F.capital = F.capital.burg;
      if (type === "zone" && F.cells === undefined && F.select !== undefined) {
        F.cells = F.select;
        delete F.select;
      }
      // zone cells: compared here, changed with paint_cells zone add/remove (unless FIELDS has cells)
      const zoneCells = type === "zone" && !FIELDS.zone?.cells ? F.cells : undefined;
      if (zoneCells !== undefined) delete F.cells;
      const cmp = compare(type, found.entity, F, ctx.tol, ctx.pending);
      if (zoneCells !== undefined) {
        try {
          const want = Array.isArray(zoneCells) ? M.selectCells({ cells: zoneCells }) : M.selectCells(zoneCells);
          const have = (found.entity.cells || []).slice();
          if (!same("cells", have, want, ctx.tol)) {
            cmp.diffs.push(diffRow(type, "cells", have, want));
            const a = new Set(have);
            const b = new Set(want);
            row.zoneCells = { add: want.filter(c => !a.has(c)), remove: have.filter(c => !b.has(c)) };
          }
        } catch (err) {
          const d = { field: "cells", error: `${err.code}: ${err.message}` };
          cmp.diffs.push(d);
          cmp.blocked = cmp.blocked || { field: "cells", ...errOf(err) };
        }
      }
      settle(row, cmp, ctx.mode);
      return row;
    }
    // not on the map. update: reported missing. check: what upsert would do (a create that
    // cannot work is an error row in both modes).
    if (ctx.mode === "update") {
      row.status = "missing";
      return row;
    }
    const cannot = (code, message) => {
      row.status = "error";
      row.error = { code, message: ctx.mode === "check" ? `missing; ${message}` : message };
      return row;
    };
    if (!ADD[type]) return cannot("NOT_FOUND", `apply cannot create ${type}s (this build has no add type '${type}')`);
    if (type === "route" && e.points !== undefined && !FIELDS.route?.points)
      return cannot(
        "BAD_ARGS",
        "freehand routes (draw:'points' / points) need the routes extension, which this build does not have; give through to pathfind instead"
      );
    const item = { ...e };
    delete item.ref;
    // read-only fields the add does not take (a burg's state) are compared once it exists
    const ro = {};
    for (const k of CREATE_DROPS[type] || [])
      if (k in item && !FIELDS[type]?.[k]?.set) {
        ro[k] = item[k];
        delete item[k];
      }
    if (type === "state" && item.capital !== undefined && !isObj(item.capital)) item.capital = { burg: item.capital };
    if (type === "label" && item.group !== undefined)
      try {
        labelGroupCheck(item.group);
      } catch (err) {
        return cannot(err.code, err.message);
      }
    row.item = item;
    row.ro = ro;
    if (ctx.mode === "check") {
      row.status = "missing";
      row.probe = true; // previewCreates checks the add would work
      return row;
    }
    row.act = "create";
    row.status = "create";
    return row;
  }

  // ---------------------------------------------------------------- notes

  const NOTE_OWNER_TYPES = [...Object.keys(NOTE_OWNER), "marker"];

  /**
   * A notes-list entry -> {id, owner?:{type, i, name}, existing?}. Throws NOT_FOUND/AMBIGUOUS.
   * entity:'Name' names an entity of any owner type, else an existing note of that name (a map
   * note keyed by its title).
   */
  function resolveNote(e) {
    if (e.ref !== undefined) {
      const r = T.resolve("note", e.ref);
      return { id: r.i, existing: r.entity };
    }
    if (typeof e.id === "string" && e.id) return { id: e.id };
    if (isObj(e.entity)) {
      const t = e.entity.type;
      if (!NOTE_OWNER_TYPES.includes(t)) fail("BAD_ARGS", `notes attach to ${NOTE_OWNER_TYPES.join(", ")}, not ${t}`);
      const ref = e.entity.ref ?? (e.entity.name !== undefined ? { name: e.entity.name } : undefined);
      const r = T.resolve(t, ref);
      return {
        id: t === "marker" ? `marker${r.i}` : NOTE_OWNER[t](r.entity),
        owner: { type: t, i: r.i, name: r.name }
      };
    }
    if (typeof e.entity === "string") {
      const hits = [];
      for (const t of NOTE_OWNER_TYPES)
        for (const h of allByName(t, e.entity)) if (h.entity) hits.push({ type: t, ...h });
      if (!hits.length) {
        const f = findByName("note", e.entity);
        if (f) return { id: f.i, existing: f.entity };
        fail(
          "NOT_FOUND",
          `no ${NOTE_OWNER_TYPES.join(", ")} or note named '${e.entity}' (a new free-standing note needs id)`
        );
      }
      if (hits.length > 1)
        fail("AMBIGUOUS", `'${e.entity}' names ${hits.length} entities; pass entity:{type, name} or id`, {
          candidates: hits.slice(0, 8).map(h => ({ type: h.type, i: h.i, name: h.name }))
        });
      const h = hits[0];
      return {
        id: h.type === "marker" ? `marker${h.i}` : NOTE_OWNER[h.type](h.entity),
        owner: { type: h.type, i: h.i, name: h.name }
      };
    }
    if (typeof e.name === "string") {
      const f = findByName("note", e.name);
      if (f) return { id: f.i, existing: f.entity };
      fail("NOT_FOUND", `no note named '${e.name}'; a new note needs id or entity`);
    }
    return fail("BAD_ARGS", "a note entry needs id, entity, ref or name");
  }

  /** A note's entity an earlier list of this spec creates (validate/check only), or null. */
  function notePending(e, err, pending) {
    if (!pending || !err) return null;
    if (typeof e.entity === "string" && err.code === "NOT_FOUND") {
      const f = fold(e.entity);
      for (const t of NOTE_OWNER_TYPES) if (pending.get(t)?.has(f)) return `${t} '${e.entity}'`;
      return null;
    }
    return pendingDep(err, pending);
  }

  function planNote(e, ctx) {
    const row = { status: "unchanged", act: "none", ignored: [] };
    let r;
    try {
      r = resolveNote(e);
    } catch (err) {
      row.key = typeof e.entity === "string" ? e.entity : (e.id ?? e.name ?? e.entity?.name ?? null);
      const dep = notePending(e, err, ctx.pending);
      if (dep) {
        // its entity comes from this spec: missing (check), or a create once it exists (upsert)
        if (ctx.mode === "check") row.status = "missing";
        else {
          row.act = "create";
          row.status = "create";
          row.deferred = true;
        }
        return row;
      }
      row.status = "error";
      row.error = errOf(err);
      return row;
    }
    row.key = r.id;
    row.i = r.id;
    const existing = r.existing ?? notes.find(n => n.id === r.id);
    const F = {};
    if (e.name !== undefined) F.name = e.name;
    if (e.legend !== undefined) F.legend = e.legend;
    for (const k of Object.keys(e))
      if (!["ref", "id", "entity", "name", "legend", "_name"].includes(k)) row.ignored.push(k);
    if (existing) {
      row.name = existing.name;
      settle(row, compare("note", existing, F, ctx.tol), ctx.mode);
      return row;
    }
    if (ctx.mode === "update") {
      row.status = "missing";
      return row;
    }
    const nm = F.name ?? e._name ?? r.owner?.name ?? r.id;
    row.name = nm;
    const item = { name: nm, legend: F.legend ?? "" };
    if (r.owner && NOTE_ENTITY_TYPES.includes(r.owner.type)) item.entity = { type: r.owner.type, ref: r.owner.i };
    else item.id = r.id;
    row.item = item;
    if (ctx.mode === "check") {
      row.status = "missing";
      row.probe = true;
      return row;
    }
    row.act = "create";
    row.status = "create";
    return row;
  }

  // ---------------------------------------------------------------- steps

  function stepOf(tool, out) {
    const resolved = out?.resolved;
    if (!resolved) return null;
    if (tool === "edit" && !resolved.ops?.length) return null;
    if (tool === "add" && !resolved.items?.length) return null;
    const step = { tool, resolved };
    if (tool === "add") step.out = { created: (out.created || []).map(c => ({ i: c.i, name: c.name })) };
    return step;
  }

  /** After a page call in the apply phase: its notes and the hidden layers it skipped. */
  function collect(S, out) {
    for (const n of out?.notes || []) S.notes.add(n);
    for (const l of out?.skippedHidden || []) S.hidden.add(l);
  }

  async function runEdits(type, rows, S) {
    const todo = rows.filter(r => r.act === "update" && hasKeys(r.set));
    if (todo.length) {
      const ops = todo.map(r => (type === "map" ? { set: r.set } : { ref: r.i, set: r.set }));
      const out = await FNS.edit({ type, ops, continueOnError: true, phase: "apply" });
      reset();
      const bad = new Map((out.errors || []).map(e => [e.index, e]));
      todo.forEach((r, k) => {
        if (bad.has(k)) {
          r.status = "error";
          r.error = decorate(errOf(bad.get(k)), type);
        } else r.status = "updated";
      });
      const st = stepOf("edit", out);
      if (st) S.steps.push(st);
      collect(S, out);
    }
    // zone cells: paint_cells zone add/remove (replayable, with the cell graph fingerprint)
    for (const r of rows.filter(x => x.act === "update" && x.zoneCells && x.status !== "error")) {
      for (const op of ["add", "remove"]) {
        const list = r.zoneCells[op];
        if (!list.length) continue;
        try {
          const out = await FNS.paint({ select: { cells: list }, set: { zone: { ref: r.i, op } }, phase: "apply" });
          reset();
          const st = stepOf("paint_cells", out);
          if (st) S.steps.push(st);
          collect(S, out);
          r.status = "updated";
        } catch (e) {
          r.status = "error";
          r.error = errOf(e);
        }
      }
    }
  }

  /**
   * Validate the create rows with FNS.add (phase validate). A key the add does not take moves to
   * r.post when FIELDS can set it right after the add, else it is dropped (r.ignored). Any other
   * error makes the row an error, except, in a preview, a NOT_FOUND/REMOVED for something an
   * earlier list of the spec creates (a route through a burg the burgs list adds).
   */
  async function probeCreates(type, todo, ctx) {
    for (const r of todo) r.post = {};
    let left = todo;
    for (let round = 0; round < 12 && left.length; round++) {
      const v = await FNS.add({ type, items: left.map(r => r.item), phase: "validate" });
      reset();
      const next = [];
      for (const err of v.errors || []) {
        const r = left[err.index];
        if (!r) continue;
        const m = err.code === "BAD_FIELD" ? /no field '([^']+)'/.exec(err.message) : null;
        if (m && m[1] in r.item) {
          const f = FIELDS[type]?.[m[1]];
          if (f && typeof f.set === "function" && typeof f.get === "function") r.post[m[1]] = r.item[m[1]];
          else r.ignored.push(m[1]);
          delete r.item[m[1]];
          next.push(r);
          continue;
        }
        if (pendingDep(err, ctx.pending)) continue;
        const e = decorate(errOf(err), type);
        if (ctx.mode === "check") e.message = `missing; creating it would fail: ${e.message}`;
        r.status = "error";
        r.act = "none";
        r.probe = false;
        r.error = e;
      }
      left = next;
    }
  }

  // Validate/check: the creates that cannot work (a bad route group, a taken cell) become error
  // rows, so they do not count as changes (a re-apply where only those remain changes nothing and
  // takes no undo entry) and check reports what upsert would.
  async function previewCreates(type, rows, ctx) {
    const todo = rows.filter(r => r.item && (r.act === "create" || r.probe));
    if (todo.length) await probeCreates(type, todo, ctx);
  }

  async function runCreates(type, rows, S) {
    const todo = rows.filter(r => r.act === "create");
    if (!todo.length) return;
    await probeCreates(type, todo, { mode: "upsert", pending: null });
    const ok = todo.filter(r => r.act === "create");
    if (!ok.length) return;
    const out = await FNS.add({ type, items: ok.map(r => r.item), continueOnError: true, phase: "apply" });
    reset();
    const bad = new Map((out.errors || []).map(e => [e.index, e]));
    const made = new Map((out.created || []).map(c => [c.index, c]));
    ok.forEach((r, k) => {
      if (bad.has(k) || !made.has(k)) {
        r.status = "error";
        r.act = "none";
        r.error = bad.has(k) ? decorate(errOf(bad.get(k)), type) : { code: "PAGE_ERROR", message: "not created" };
        return;
      }
      const c = made.get(k);
      r.status = "created";
      r.i = c.i;
      r.name = c.name ?? r.name;
    });
    for (const list of out.resolved?.created || [])
      for (const c of list.slice(1)) S.also[c.type] = (S.also[c.type] || 0) + 1;
    const st = stepOf("add", out);
    if (st) S.steps.push(st);
    collect(S, out);
    const post = ok.filter(r => r.status === "created" && hasKeys(r.post));
    if (!post.length) return;
    const pout = await FNS.edit({
      type,
      ops: post.map(r => ({ ref: r.i, set: r.post })),
      continueOnError: true,
      phase: "apply"
    });
    reset();
    for (const e of pout.errors || []) {
      const r = post[e.index];
      if (r)
        r.error = {
          ...errOf(e),
          message: `created, but setting ${Object.keys(r.post).join(", ")} failed: ${e.message}`
        };
    }
    const pst = stepOf("edit", pout);
    if (pst) S.steps.push(pst);
    collect(S, pout);
  }

  // ---------------------------------------------------------------- the spec

  function shapeRow(at, r) {
    const out = { at };
    if (r.key !== null && r.key !== undefined) out.key = r.key;
    if (r.i !== undefined && r.i !== null && r.i !== r.key) out.i = r.i;
    if (r.name && r.name !== (typeof r.key === "string" ? r.key.replace(/\|/g, "") : r.key)) out.name = r.name;
    out.status = r.status;
    if (r.diffs?.length) out.diffs = r.diffs;
    if (r.error) out.error = r.error;
    if (r.noteSkipped) out.note = "skipped: the entity does not exist";
    return out;
  }

  /** The entity a row ended up with (after an apply), or null (missing, or a create that failed). */
  function rowEntity(type, r) {
    if (r.i === undefined || r.i === null || r.status === "missing") return null;
    if (r.entity && !r.entity.removed) return r.entity;
    if (r.status === "error") return null;
    try {
      return T.resolve(type, r.i).entity;
    } catch {
      return null;
    }
  }

  const errorRow = (r, code, message) => ({
    key: r.key,
    i: r.i,
    name: r.name,
    status: "error",
    act: "none",
    ignored: [],
    error: { code, message }
  });

  async function runSpec(a) {
    const mode = ["upsert", "check", "update"].includes(a.mode) ? a.mode : "upsert";
    const apply = a.phase === "apply" && mode !== "check";
    const tol = isObj(a.tolerance) ? a.tolerance : {};
    const S = { steps: [], notes: new Set(), also: {}, hidden: new Set() };
    const ignored = {};
    const unsupported = [];
    const done = []; // {at, list, type, row}
    const listNotes = []; // {at, list, e}: notes-list entries
    const ownNotes = []; // entities' note shorthands (after the notes lists, which win a clash)
    // validate/check of a spec that creates: what its creates will add, per type (folded names),
    // so a reference to one of them is a pending dependency, not an error
    const pending = !apply && mode !== "update" ? new Map() : null;
    const claimed = new Map(); // "type:i" -> the entry that matched that entity first
    const planned = []; // apply: {type, entries, ctxs, rows} per list, for the settle pass
    const noteOwners = new Map(); // note id -> the markers entry that gives that marker's note

    // map fields (edit type 'map', no ref)
    if (hasKeys(a.map)) {
      const r = { key: null, status: "unchanged", act: "none", ignored: [] };
      settle(r, compare("map", null, a.map, tol, pending), mode);
      if (apply) await runEdits("map", [r], S);
      done.push({ at: "map", list: "map", type: "map", row: r });
    }

    for (const L of Array.isArray(a.lists) ? a.lists : []) {
      const type = L.type;
      const entries = Array.isArray(L.entries) ? L.entries : [];
      if (type === "note") {
        // the notes lists wait until every entity exists (and come before the shorthand notes)
        listNotes.push(...entries.map((e, k) => ({ at: `${L.key}[${k}]`, list: L.key, e: isObj(e) ? e : {} })));
        continue;
      }
      if (!FIELDS[type] && !ADD[type]) {
        unsupported.push(`${L.key} (no edit/add type '${type}' in this build)`);
        continue;
      }
      // a name the list repeats pairs with the map's entities of that name in id order
      const count = new Map();
      const keys = entries.map(e => {
        const kk = isObj(e) ? keyOf(type, e) : null;
        const f = kk?.name !== undefined ? fold(type === "label" ? kk.name.replace(/\|/g, "") : kk.name) : null;
        if (f !== null) count.set(f, (count.get(f) || 0) + 1);
        return f;
      });
      const seen = new Map();
      const ctxs = [];
      const rows = entries.map((e, k) => {
        const f = keys[k];
        const nth = f !== null ? seen.get(f) || 0 : 0;
        if (f !== null) seen.set(f, nth + 1);
        ctxs[k] = { mode, tol, pending, clamp: !!a.clamp, nth, dups: f !== null ? count.get(f) : 1 };
        const r = planEntry(type, isObj(e) ? e : {}, ctxs[k]);
        // two entries for one entity would fight over it on every apply
        if (r.entity && r.status !== "error") {
          const id = `${type}:${r.i}`;
          const first = claimed.get(id);
          if (first !== undefined)
            return errorRow(r, "CONFLICT", `the same ${type} as ${first}; give each ${type} once`);
          claimed.set(id, `${L.key}[${k}]`);
        }
        return r;
      });
      if (apply) planned.push({ type, entries, ctxs, rows });
      if (apply) {
        await runEdits(type, rows, S);
        await runCreates(type, rows, S);
        rows.forEach((r, k) => {
          if (r.status === "created") claimed.set(`${type}:${r.i}`, `${L.key}[${k}]`);
        });
      } else if (mode !== "update") {
        await previewCreates(type, rows, { mode, pending });
        // what this list will create: later lists may refer to it
        for (const [k, r] of rows.entries()) {
          if (!(r.act === "create" || (r.status === "missing" && r.probe))) continue;
          let set = pending.get(type);
          if (!set) {
            set = new Set();
            pending.set(type, set);
          }
          const e = entries[k];
          for (const n of [r.key, e?.name, e?.text, e?.id])
            if (typeof n === "string" && n) set.add(fold(type === "label" ? n.replace(/\|/g, "") : n));
        }
      }
      rows.forEach((r, k) => {
        const at = `${L.key}[${k}]`;
        done.push({ at, list: L.key, type, row: r });
        if (type === "marker" && r.ownsNote && r.i !== undefined && r.i !== null && r.status !== "error")
          noteOwners.set(`marker${r.i}`, at);
        if (r.note === undefined) return;
        // validate of a create: the note comes with it; check: missing with it
        if (!apply && r.act === "create") return;
        if (mode === "check" && r.status === "missing") {
          done.push({
            at: `${at}.note`,
            list: L.key,
            type: "note",
            row: { status: "missing", act: "none", ignored: [] }
          });
          return;
        }
        const x = rowEntity(type, r);
        if (!x) {
          if (r.status === "error") r.noteSkipped = true;
          return;
        }
        const n = typeof r.note === "string" ? { legend: r.note } : isObj(r.note) ? r.note : null;
        if (!n) return;
        // without a name the note is named after the entity when created, and its name is
        // not compared afterwards (the spec did not give one)
        const ne = n.name !== undefined ? { name: n.name } : { _name: I.nameOf(type, x) };
        if (n.legend !== undefined) ne.legend = n.legend;
        if (NOTE_ENTITY_TYPES.includes(type)) ne.entity = { type, ref: r.i };
        else ne.id = NOTE_OWNER[type](x);
        ownNotes.push({ at: `${at}.note`, list: L.key, e: ne });
      });
    }

    const pendingNotes = [...listNotes, ...ownNotes];
    if (pendingNotes.length) {
      // one entry per note: a second entry for the same note id (a notes-list entry and an
      // entity's note shorthand, or a marker's own note) would flip it on every apply
      const owner = new Map(noteOwners);
      const rows = pendingNotes.map(p => {
        const r = planNote(p.e, { mode, tol, pending });
        if (r.status === "error" || r.key === null || r.key === undefined) return r;
        const first = owner.get(r.key);
        if (first === undefined) {
          owner.set(r.key, p.at);
          return r;
        }
        const why = noteOwners.has(r.key) ? " (a marker's note and name belong to its markers entry)" : "";
        return errorRow(
          { key: r.key },
          "CONFLICT",
          `note '${r.key}' is already given by ${first}${why}; give each note once`
        );
      });
      if (apply) {
        await runEdits("note", rows, S);
        await runCreates("note", rows, S);
      } else if (mode !== "update") await previewCreates("note", rows, { mode, pending });
      rows.forEach((r, j) => {
        done.push({ at: pendingNotes[j].at, list: pendingNotes[j].list, type: "note", row: r });
      });
    }

    // a later list can change what an earlier one set (a state's capital turns its burg's group
    // into 'capital'): one more pass edits such fields back, so a single apply converges
    if (apply)
      for (const P of planned) {
        const idx = [];
        P.rows.forEach((r, k) => {
          if (["created", "updated", "unchanged"].includes(r.status) && isObj(P.entries[k])) idx.push(k);
        });
        if (!idx.length) continue;
        const again = idx.map(k => planEntry(P.type, P.entries[k], { ...P.ctxs[k], mode: "update", pending: null }));
        const todo = again.filter(r => r.act === "update");
        if (!todo.length) continue;
        await runEdits(P.type, todo, S);
        again.forEach((r2, j) => {
          if (r2.act !== "update") return;
          const r = P.rows[idx[j]];
          if (r2.status === "error") {
            r.status = "error";
            r.error = r2.error;
            return;
          }
          // created stays created (it now matches the spec); otherwise it was changed now
          if (r.status !== "created") {
            r.status = "updated";
            r.diffs = [
              ...(r.diffs || []).filter(d => !r2.diffs?.some(d2 => d2.field === d.field)),
              ...(r2.diffs || [])
            ];
          }
        });
      }

    // read-only fields again at the end: later lists can change them (a state makes a burg its capital)
    if (apply)
      for (const d of done) {
        const r = d.row;
        if (!hasKeys(r.ro) || !READ_ONLY[d.type]) continue;
        const x = rowEntity(d.type, r);
        if (!x) continue;
        const fresh = readOnlyDiffs(d.type, x, r.ro, tol);
        const kept = (r.diffs || []).filter(df => !df.readOnly);
        r.diffs = [...kept, ...fresh];
        if (r.status === "unchanged" && fresh.length) r.status = "differs";
        else if (r.status === "differs" && !r.diffs.length) r.status = "unchanged";
      }

    let wouldChange = 0;
    const writeOnly = {};
    const rowsOut = done.map(d => {
      if (d.row.act !== "none") wouldChange++;
      if (d.row.ignored?.length) ignored[d.list] = [...new Set([...(ignored[d.list] || []), ...d.row.ignored])];
      for (const k of d.row.writeOnly || []) {
        writeOnly[d.type] ??= new Set();
        writeOnly[d.type].add(k);
      }
      return shapeRow(d.at, d.row);
    });
    for (const [type, keys] of Object.entries(writeOnly))
      S.notes.add(
        `${type} ${[...keys].join(", ")}: write-only (nothing to compare; a setting lock is a browser preference), so apply skips it; set it with edit ${type}`
      );
    return {
      rows: rowsOut,
      ignored,
      unsupported,
      steps: S.steps,
      also: S.also,
      notes: [...S.notes],
      hidden: [...S.hidden],
      wouldChange
    };
  }

  /**
   * applySpec {mode:'upsert'|'check'|'update', lists:[{key, type, entries}], map?, tolerance?,
   * clamp?, phase:'validate'|'apply'}. validate (and every check) changes nothing: it returns
   * the plan rows and wouldChange. apply re-plans list by list (later lists see what earlier
   * ones created), changes the map through FNS.edit/add/paint and returns the rows, the steps
   * (resolved forms for the sketch log) and one coalesced redraw.
   */
  FNS.applySpec = async a => {
    if (!isObj(a)) fail("BAD_ARGS", "applySpec takes {mode, lists, map?, tolerance?, phase}");
    // the map may have changed since the last call (another tool, a load): no stale index
    nameIndexes.clear();
    if (a.phase !== "apply" || a.mode === "check") {
      try {
        return await runSpec(a);
      } finally {
        nameIndexes.clear();
      }
    }
    // the steps' redraws are collected and run once at the end
    const realRedraw = T.redraw;
    const pending = [];
    T.redraw = async r => {
      for (const l of r?.layers || []) pending.push(l);
      return { redrawn: [], skippedHidden: [] };
    };
    let res;
    try {
      res = await runSpec(a);
    } finally {
      T.redraw = realRedraw;
      nameIndexes.clear();
    }
    reset();
    const rd = pending.length ? await realRedraw({ layers: pending }) : { redrawn: [], skippedHidden: [] };
    const skippedHidden = [...new Set([...(rd.skippedHidden || []), ...(res.hidden || [])])];
    return { ...res, redrawn: rd.redrawn, skippedHidden };
  };
})(globalThis);
