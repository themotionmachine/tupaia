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
  const reset = () => T.resetMemo?.();
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
    route: ["through", "points"],
    zone: ["select"],
    label: ["at"],
    culture: ["at", "expand"],
    religion: ["at", "expand"]
  };

  // Read-only keys an add would refuse: kept out of the item, compared once the entity exists.
  const CREATE_DROPS = { burg: ["state", "capital"] };

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

  /** Strings compare after: label text without '|' breaks, legends HTML-decoded, colours folded. */
  function textOf(field, v) {
    let s = String(v);
    if (field === "text") s = s.replace(/\|/g, "");
    if (field === "legend") s = decodeHtml(s);
    if (isColorField(field)) s = normColor(s);
    return s;
  }

  /** Does `have` (the entity's value) match `want` (the spec value as FIELDS shows it)? */
  function same(field, have, want, tol) {
    if (want === undefined) return true;
    if (have === want) return true;
    if (have === null || have === undefined || want === null) return (have ?? null) === (want ?? null);
    if (isNum(have) && isNum(want)) return Math.abs(have - want) <= tolFor(tol, field, "number");
    if (typeof have === "string" && typeof want === "string") return textOf(field, have) === textOf(field, want);
    if (typeof have === "boolean" || typeof want === "boolean") return !!have === !!want;
    if (isPlaceLike(have) && isPlaceLike(want))
      return Math.hypot(have.x - want.x, have.y - want.y) <= tolFor(tol, field, "px");
    if (Array.isArray(have) && Array.isArray(want)) {
      if (have.every(isNum) && want.every(isNum)) {
        // cell lists: as sets
        const a = new Set(have);
        return a.size === new Set(want).size && want.every(x => a.has(x));
      }
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
  function diffRow(type, field, have, want, extra) {
    if (isObj(have) && isObj(want) && !isPlaceLike(have) && !isPlaceLike(want)) {
      // e.g. a marker note {name, legend}: the first differing key
      const k = Object.keys(want).find(key => !same(key, have[key], want[key], {}));
      if (k) return diffRow(type, `${field}.${k}`, have[k] ?? null, want[k], extra);
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
    } else if (Array.isArray(have) && Array.isArray(want) && have.every(isNum) && want.every(isNum)) {
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
      h = Array.isArray(have) && have.length > 6 ? `${have.length} items` : have;
      w = Array.isArray(want) && want.length > 6 ? `${want.length} items` : want;
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

  function alts(type, x) {
    if ((type === "state" || type === "province") && x.fullName) return [x.fullName];
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

  /**
   * Every live entity of `type` named `name`: exact matches, else case/diacritic folded ones
   * (labels ignore '|' line breaks; states and provinces also match their full name), in id
   * order: [{i, name, entity, alt}], alt = matched the full name, not the name.
   */
  function allByName(type, name) {
    const key = type === "label" ? String(name).replace(/\|/g, "") : String(name);
    let live;
    try {
      live = I.liveList(type, false);
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
    const rows = live.map(x => ({ x, name: I.nameOf(type, x), alt: alts(type, x) }));
    let hits = rows.filter(r => r.name === key || r.alt.includes(key));
    const f = fold(key);
    if (!hits.length) hits = rows.filter(r => fold(r.name) === f || r.alt.some(a => fold(a) === f));
    return hits
      .map(h => ({ i: I.idOf(type, h.x), name: h.name, entity: h.x, alt: fold(h.name) !== f }))
      .sort((a, b) => cmpId(a.i, b.i));
  }

  /**
   * The existing entity an entry names. `nth`/`dups`: the list names it `dups` times and this
   * is occurrence `nth`, so duplicates pair with the map's entities of that name in id order.
   * One spec entry but several on the map: AMBIGUOUS (with candidates). null: none.
   */
  function findByName(type, name, nth = 0, dups = 1) {
    const hits = allByName(type, name);
    if (hits.length > 1 && dups === 1)
      fail("AMBIGUOUS", `${hits.length} ${type}s are named '${name}'; give the entry a ref (id)`, {
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
        own ?? rn(Math.max(tolFor(tol, field, "px"), Math.sqrt((graphWidth * graphHeight) / pack.cells.i.length)));
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
      return { same: false, have: { off: off.slice(0, 6), worstPx: rn(worst) }, want: `every place within ${lim} px` };
    };
  }

  const READ_ONLY = {
    burg: {
      state: (b, want) => {
        let wantId = null;
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
    label: {
      group: (l, want) => {
        const have = l.el?.parentNode?.id ?? null;
        return have === want ? { same: true } : { same: false, have, want };
      }
    },
    route: { through: routeCheck("through"), points: routeCheck("points") }
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
  function compare(type, x, F, tol) {
    const table = FIELDS[type] || {};
    const diffs = [];
    const set = {};
    const ignored = [];
    const ro = {};
    let blocked = null;
    for (const key of Object.keys(F)) {
      const want = F[key];
      const f = table[key];
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
          d.error = `${err.code}: ${err.message}`;
          diffs.push(d);
          blocked = blocked || { field: key, ...err };
          continue;
        }
        if (same(key, have, shown, tol)) continue;
        diffs.push(diffRow(type, key, have, shown));
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
    return { diffs, set, ignored, blocked, ro };
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

  function keyOf(type, e) {
    if (e.ref !== undefined) return { ref: e.ref };
    const name = type === "label" ? e.text : e.name;
    if (typeof name === "string" && name.trim()) return { name };
    return null;
  }

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
    // a marker's name is its note's name
    if (type === "marker") {
      const n = typeof e.note === "string" ? { legend: e.note } : isObj(e.note) ? { ...e.note } : {};
      if (typeof e.name === "string") n.name = e.name;
      delete e.name;
      if (hasKeys(n)) e.note = n;
      else delete e.note;
    }
    let found;
    try {
      found = key.ref !== undefined ? byRef(type, key.ref) : findByName(type, key.name, ctx.nth, ctx.dups);
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
      const cmp = compare(type, found.entity, F, ctx.tol);
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
    // not on the map
    if (ctx.mode !== "upsert") {
      row.status = "missing";
      return row;
    }
    if (key.ref !== undefined) {
      row.status = "error";
      row.error = { code: "NOT_FOUND", message: `no ${type} ${JSON.stringify(key.ref)} (an explicit ref must exist)` };
      return row;
    }
    if (!ADD[type]) {
      row.status = "error";
      row.error = { code: "NOT_FOUND", message: `no ${type} named '${key.name}', and apply cannot create ${type}s` };
      return row;
    }
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
    if (type === "label" && typeof item.group === "string") {
      const g = item.group;
      const own = document.querySelector(`#labels > g#${CSS.escape(g)}`);
      if (!own && document.getElementById(g)) {
        row.status = "error";
        row.error = {
          code: "REFUSED",
          message: `label group id '${g}' is taken by the map's #${g} element; use another id (e.g. mapping.values.labels.group: 'lbl_{}')`
        };
        return row;
      }
    }
    row.act = "create";
    row.status = "create";
    row.item = item;
    row.ro = ro;
    return row;
  }

  // ---------------------------------------------------------------- notes

  /** A notes-list entry -> {id, owner?:{type, i, name}, existing?}. Throws NOT_FOUND/AMBIGUOUS. */
  function resolveNote(e) {
    if (e.ref !== undefined) {
      const r = T.resolve("note", e.ref);
      return { id: r.i, existing: r.entity };
    }
    if (typeof e.id === "string" && e.id) return { id: e.id };
    const ownerTypes = [...Object.keys(NOTE_OWNER), "marker"];
    if (isObj(e.entity)) {
      const t = e.entity.type;
      if (!ownerTypes.includes(t)) fail("BAD_ARGS", `notes attach to ${ownerTypes.join(", ")}, not ${t}`);
      const ref = e.entity.ref ?? (e.entity.name !== undefined ? { name: e.entity.name } : undefined);
      const r = T.resolve(t, ref);
      return {
        id: t === "marker" ? `marker${r.i}` : NOTE_OWNER[t](r.entity),
        owner: { type: t, i: r.i, name: r.name }
      };
    }
    if (typeof e.entity === "string") {
      const hits = [];
      for (const t of ownerTypes) for (const h of allByName(t, e.entity)) if (h.entity) hits.push({ type: t, ...h });
      if (!hits.length) fail("NOT_FOUND", `no ${ownerTypes.join(", ")} named '${e.entity}'`);
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

  function planNote(e, ctx) {
    const row = { status: "unchanged", act: "none", ignored: [] };
    let r;
    try {
      r = resolveNote(e);
    } catch (err) {
      row.key = typeof e.entity === "string" ? e.entity : (e.id ?? e.name ?? null);
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
    for (const k of Object.keys(e)) if (!["ref", "id", "entity", "name", "legend"].includes(k)) row.ignored.push(k);
    if (existing) {
      row.name = existing.name;
      settle(row, compare("note", existing, F, ctx.tol), ctx.mode);
      return row;
    }
    if (ctx.mode !== "upsert") {
      row.status = "missing";
      return row;
    }
    const nm = F.name ?? r.owner?.name ?? r.id;
    row.name = nm;
    const item = { name: nm, legend: F.legend ?? "" };
    if (r.owner && NOTE_ENTITY_TYPES.includes(r.owner.type)) item.entity = { type: r.owner.type, ref: r.owner.i };
    else item.id = r.id;
    row.act = "create";
    row.status = "create";
    row.item = item;
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
          r.error = errOf(bad.get(k));
        } else r.status = "updated";
      });
      const st = stepOf("edit", out);
      if (st) S.steps.push(st);
      for (const n of out.notes || []) S.notes.add(n);
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
          r.status = "updated";
        } catch (e) {
          r.status = "error";
          r.error = errOf(e);
        }
      }
    }
  }

  async function runCreates(type, rows, S) {
    const todo = rows.filter(r => r.act === "create");
    if (!todo.length) return;
    // keys the add does not take: FIELDS fields are set right after it, the rest are dropped
    for (const r of todo) r.post = {};
    let pending = todo;
    for (let round = 0; round < 12 && pending.length; round++) {
      const v = await FNS.add({ type, items: pending.map(r => r.item), phase: "validate" });
      reset();
      const next = [];
      for (const err of v.errors || []) {
        const r = pending[err.index];
        if (!r) continue;
        const m = err.code === "BAD_FIELD" ? /no field '([^']+)'/.exec(err.message) : null;
        if (m && m[1] in r.item) {
          const f = FIELDS[type]?.[m[1]];
          if (f && typeof f.set === "function" && typeof f.get === "function") r.post[m[1]] = r.item[m[1]];
          else r.ignored.push(m[1]);
          delete r.item[m[1]];
          next.push(r);
        } else {
          r.status = "error";
          r.act = "none";
          r.error = errOf(err);
        }
      }
      pending = next;
    }
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
        r.error = bad.has(k) ? errOf(bad.get(k)) : { code: "PAGE_ERROR", message: "not created" };
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
    for (const n of out.notes || []) S.notes.add(n);
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
    return out;
  }

  /** The entity a row ended up with (after an apply), or null. */
  function rowEntity(type, r) {
    if (r.i === undefined || r.i === null || r.status === "error" || r.status === "missing") return null;
    if (r.entity && !r.entity.removed) return r.entity;
    try {
      return T.resolve(type, r.i).entity;
    } catch {
      return null;
    }
  }

  async function runSpec(a) {
    const mode = ["upsert", "check", "update"].includes(a.mode) ? a.mode : "upsert";
    const apply = a.phase === "apply" && mode !== "check";
    const tol = isObj(a.tolerance) ? a.tolerance : {};
    const S = { steps: [], notes: new Set(), also: {} };
    const ignored = {};
    const unsupported = [];
    const done = []; // {at, list, type, row}
    const listNotes = []; // {at, list, e}: notes-list entries
    const ownNotes = []; // entities' note shorthands (after the notes lists, which win a clash)

    // map fields (edit type 'map', no ref)
    if (hasKeys(a.map)) {
      const r = { key: null, status: "unchanged", act: "none", ignored: [] };
      settle(r, compare("map", null, a.map, tol), mode);
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
      const rows = entries.map((e, k) => {
        const f = keys[k];
        const nth = f !== null ? seen.get(f) || 0 : 0;
        if (f !== null) seen.set(f, nth + 1);
        return planEntry(type, isObj(e) ? e : {}, {
          mode,
          tol,
          clamp: !!a.clamp,
          nth,
          dups: f !== null ? count.get(f) : 1
        });
      });
      if (apply) {
        await runEdits(type, rows, S);
        await runCreates(type, rows, S);
      }
      rows.forEach((r, k) => {
        done.push({ at: `${L.key}[${k}]`, list: L.key, type, row: r });
        if (r.note === undefined || (!apply && r.act === "create")) return;
        const x = rowEntity(type, r);
        if (!x) return;
        const n = typeof r.note === "string" ? { legend: r.note } : isObj(r.note) ? r.note : null;
        if (!n) return;
        const ne = { name: n.name ?? I.nameOf(type, x) };
        if (n.legend !== undefined) ne.legend = n.legend;
        if (NOTE_ENTITY_TYPES.includes(type)) ne.entity = { type, ref: r.i };
        else ne.id = NOTE_OWNER[type](x);
        ownNotes.push({ at: `${L.key}[${k}].note`, list: L.key, e: ne });
      });
    }

    const pendingNotes = [...listNotes, ...ownNotes];
    if (pendingNotes.length) {
      // one entry per note: a second entry for the same note id (a notes-list entry and an
      // entity's note shorthand, say) would flip it back and forth on every apply
      const owner = new Map();
      const rows = pendingNotes.map(p => {
        const r = planNote(p.e, { mode, tol });
        if (r.status === "error" || r.key === null || r.key === undefined) return r;
        const first = owner.get(r.key);
        if (first === undefined) {
          owner.set(r.key, p.at);
          return r;
        }
        return {
          key: r.key,
          status: "error",
          act: "none",
          ignored: [],
          error: { code: "CONFLICT", message: `note '${r.key}' is already given by ${first}; give each note once` }
        };
      });
      if (apply) {
        await runEdits("note", rows, S);
        await runCreates("note", rows, S);
      }
      rows.forEach((r, j) => {
        done.push({ at: pendingNotes[j].at, list: pendingNotes[j].list, type: "note", row: r });
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
    const rowsOut = done.map(d => {
      if (d.row.act !== "none") wouldChange++;
      if (d.row.ignored?.length) ignored[d.list] = [...new Set([...(ignored[d.list] || []), ...d.row.ignored])];
      return shapeRow(d.at, d.row);
    });
    return {
      rows: rowsOut,
      ignored,
      unsupported,
      steps: S.steps,
      also: S.also,
      notes: [...S.notes],
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
    if (a.phase !== "apply" || a.mode === "check") return runSpec(a);
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
    }
    reset();
    const rd = pending.length ? await realRedraw({ layers: pending }) : { redrawn: [], skippedHidden: [] };
    return { ...res, redrawn: rd.redrawn, skippedHidden: rd.skippedHidden };
  };
})(globalThis);
