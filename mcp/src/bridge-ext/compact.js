// Tupaia MCP bridge extension (track 'compact'): compact removed entities.
//
// Removed burgs, states, provinces, cultures and religions stay in their arrays, usually as the
// whole old object (a removed burg keeps its name, coordinates and production records). Their
// slot must stay: ids are array indexes and the next id is the array length, and notes, routes,
// labels and sketch logs refer to ids. compact replaces each removed record with a stub that
// keeps the slot, drops notes of removed or deleted entities and drops their orphaned SVG.
//
// Stub per type, from an audit of app code that reads removed records:
// - state, province: {i, removed:true}. The app itself writes exactly this stub (stateRemove,
//   the provinces editor), so every iteration over states/provinces already handles it.
// - burg, religion: {i, removed:true}. Every iteration over burgs/religions that reads other
//   fields checks `removed` (or i/capital/group/coa/production) first; the only unguarded
//   reads come through ids held by live data (below). religions-generator checkCenters reads
//   `center`/`type`/`culture` of removed religions but only compares them (no throw).
// - culture: {i, removed:true, base, center}. Cultures.add copies `base` from a random culture
//   slot, removed ones included (cultures-generator add); the cultures CSV import
//   (uploadCulturesData) revives a removed slot by id, sets everything else, and the culture
//   centres layer then reads `center`.
// - A removed record that live data still points at is kept whole: a live state's capital,
//   culture, provinces, neighbors or campaign sides; a live province's burg or state; a live
//   burg's state or culture; a live culture's origins; a live religion's culture or origins; a
//   market centre; a deal party; any cell. App code dereferences those ids and reads fields
//   (regenerateEmblems reads the province burg's name, markets read the centre's cell, the
//   religions CSV export reads origin names, ...). keptBy counts them per kind and keptWhy names
//   what releases each kind. repointProvinces:true releases removed burgs that are only held as a
//   live province's capital: the province's capital becomes its first live burg (or 0), which is
//   what the app's provinces editor does whenever it opens.
// Rivers, routes, markers, zones, labels and regiments are deleted outright by the app, so they
// have no records to stub; compact only drops their leftover notes and SVG.
//
// Same rules as bridge-mutations.js: app globals by bare name at call time, no locals that
// shadow app globals (notes, labels, markers, routes, rivers, zones, burgs ...), one args
// object per FNS function. Validate mutates nothing; apply re-plans and applies.
(root => {
  const T = root.__tupaia;
  if (!T) return;
  const FNS = T.fns;
  const fail = T.fail;

  const INDEXED = ["burg", "state", "province", "culture", "religion"];
  const DELETED = ["marker", "route", "river", "zone", "label", "regiment"];
  const TYPES = [...INDEXED, ...DELETED];
  const LIST = { burg: "burgs", state: "states", province: "provinces", culture: "cultures", religion: "religions" };
  const KEEP = { burg: [], state: [], province: [], culture: ["base", "center"], religion: [] };

  const isObj = x => !!x && typeof x === "object";
  const live = x => isObj(x) && !x.removed;
  const posId = v => Number.isInteger(v) && v > 0;

  /** UTF-8 length of a string (what the .map file holds). */
  function u8(s) {
    let n = 0;
    for (let k = 0; k < s.length; k++) {
      const c = s.charCodeAt(k);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c < 0xdc00) {
        n += 4;
        k++;
      } else n += 3;
    }
    return n;
  }

  /** "1-5,8,10-12" for a list of integers. */
  function ranges(ids) {
    const s = [...new Set(ids)].sort((a, b) => a - b);
    const out = [];
    for (let k = 0; k < s.length; k++) {
      let j = k;
      while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
      out.push(j > k ? `${s[k]}-${s[j]}` : String(s[k]));
      k = j;
    }
    return out.join(",");
  }

  function stubOf(type, x) {
    const s = { i: x.i, removed: true };
    for (const k of KEEP[type]) if (x[k] !== undefined) s[k] = x[k];
    return s;
  }

  // Fields app code writes onto every record, stubs included, without making it bigger in any way
  // that matters: the cultures and religions editors' statistics (0 for a stub, whose id no cell
  // carries) and the cultures editor's `burg.culture = cells.culture[burg.cell]` (undefined for a
  // stub, which JSON drops). A stub carrying only these is still a stub: compact would otherwise
  // find "work" (an undo entry and a sketch op) after every editor visit.
  const STAT_KEYS = ["cells", "area", "rural", "urban", "burgs"];
  function isStub(type, x) {
    return Object.keys(x).every(
      k =>
        k === "i" ||
        k === "removed" ||
        KEEP[type].includes(k) ||
        x[k] === undefined ||
        (STAT_KEYS.includes(k) && x[k] === 0)
    );
  }

  // What holds a removed record, by kind, with the remedy keptWhy gives for it.
  const REMEDY = {
    deal: "regenerate {parts:['production']} rebuilds trade deals without removed burgs (it also re-rolls production, products and treasury of every live burg)",
    provinceBurg:
      "compact {repointProvinces:true} makes the first live burg in each such province its capital (or none), as the app's provinces editor does when it opens",
    market: "regenerate {parts:['markets','production']} picks new market centres",
    cells: "cells still carry the id (paint_cells reassigns them)"
  };
  const OTHER_REMEDY = "a live record still names it: change that record, or leave it (a kept record is safe)";

  /**
   * Removed records that live data points at: {type: Map(id -> {by: first referrer, kinds:
   * Map(kind -> first referrer of that kind)})}. skipProvinceBurg: provinces whose burg compact
   * is about to repoint (their old burg is no longer held by them).
   */
  function references(skipProvinceBurg) {
    const ref = {};
    for (const t of INDEXED) ref[t] = new Map();
    const add = (t, id, kind, by) => {
      if (!posId(id)) return;
      if (!ref[t].has(id)) ref[t].set(id, { by, kinds: new Map() });
      const r = ref[t].get(id);
      if (!r.kinds.has(kind)) r.kinds.set(kind, by);
    };
    for (const s of pack.states || []) {
      if (!live(s)) continue;
      const who = s.i ? `state ${s.i}` : "Neutrals (state 0)";
      add("burg", s.capital, "capital", `${who} capital`);
      add("culture", s.culture, "stateCulture", `${who} culture`);
      for (const p of s.provinces || []) add("province", p, "stateProvinces", `${who} provinces list`);
      for (const n of s.neighbors || []) add("state", n, "neighbors", `${who} neighbors list`);
      for (const c of s.campaigns || []) {
        add("state", c?.attacker, "campaigns", `${who} campaigns`);
        add("state", c?.defender, "campaigns", `${who} campaigns`);
      }
    }
    for (const p of pack.provinces || []) {
      if (!live(p)) continue;
      if (!skipProvinceBurg?.has(p.i)) add("burg", p.burg, "provinceBurg", `province ${p.i} burg`);
      add("state", p.state, "provinceState", `province ${p.i} state`);
    }
    for (const b of pack.burgs || []) {
      if (!live(b) || !b.i) continue;
      add("state", b.state, "burgState", `burg ${b.i} state`);
      add("culture", b.culture, "burgCulture", `burg ${b.i} culture`);
    }
    for (const c of pack.cultures || [])
      if (live(c)) for (const o of c.origins || []) add("culture", o, "origins", `culture ${c.i} origins`);
    for (const r of pack.religions || []) {
      if (!live(r)) continue;
      add("culture", r.culture, "religionCulture", `religion ${r.i} culture`);
      for (const o of r.origins || []) add("religion", o, "origins", `religion ${r.i} origins`);
    }
    for (const m of pack.markets || []) if (isObj(m)) add("burg", m.centerBurgId, "market", `market ${m.i} centre`);
    for (const d of pack.deals || []) {
      if (!isObj(d)) continue;
      if (d.sellerType === "burg") add("burg", d.seller, "deal", `deal ${d.i} seller`);
      if (d.buyerType === "burg") add("burg", d.buyer, "deal", `deal ${d.i} buyer`);
    }
    for (const t of INDEXED) {
      const arr = pack.cells?.[t];
      if (arr) for (const v of new Set(arr)) add(t, v, "cells", `cells (${t})`);
    }
    return ref;
  }

  /**
   * Live provinces whose capital (province.burg) is a removed burg: [{i, from, to}], `to` being
   * the first live burg in the province in cell order, or 0. This is what the app's provinces
   * editor does each time it opens (collectStatistics in provinces-editor.js).
   */
  function provinceRepoints() {
    const C = pack.cells;
    const need = new Set();
    for (const p of pack.provinces || []) {
      if (!live(p) || !p.i || !posId(p.burg)) continue;
      const b = pack.burgs?.[p.burg];
      if (isObj(b) && b.removed) need.add(p.i);
    }
    if (!need.size || !C?.province || !C?.burg) return [];
    const first = new Map();
    for (let c = 0; c < C.province.length; c++) {
      const pr = C.province[c];
      if (!need.has(pr) || first.has(pr)) continue;
      const b = C.burg[c];
      if (b && live(pack.burgs[b])) first.set(pr, b);
    }
    return [...need].map(i => ({ i, from: pack.provinces[i].burg, to: first.get(i) ?? 0 }));
  }

  /** Replay: the logged repoints that still hold on this base (same old capital, still removed). */
  function replayRepoints(list) {
    const out = [];
    for (const row of list) {
      if (!Array.isArray(row)) continue;
      const [i, from, to] = row.map(Number);
      const p = pack.provinces?.[i];
      if (!live(p) || p.burg !== from || !pack.burgs?.[from]?.removed) continue;
      if (to !== 0 && !live(pack.burgs?.[to])) continue;
      out.push({ i, from, to });
    }
    return out;
  }

  /** The entity a note belongs to by its id, or null. */
  function noteOwner(id) {
    const s = String(id ?? "");
    const r = /^regiment(\d+)-(\d+)$/.exec(s);
    if (r) return { type: "regiment", i: Number(r[1]), sub: Number(r[2]) };
    const m = /^(burg|stateLabel|province|culture|religion|marker|route|river|zone|label)(\d+)$/.exec(s);
    if (!m) return null;
    return { type: m[1] === "stateLabel" ? "state" : m[1], i: Number(m[2]) };
  }

  function idSet(list) {
    const s = new Set();
    for (const x of list || []) if (isObj(x)) s.add(x.i);
    return s;
  }

  /** The element with this id inside the map SVG (not a dialog that happens to share it). */
  function mapEl(id) {
    if (typeof document === "undefined") return null;
    const el = document.getElementById(id);
    if (!el) return null;
    if (el.closest("#map")) return el;
    return document.getElementById("map")?.querySelector(`[id="${id}"]`) ?? null;
  }

  /** Is the note's owner removed or gone? */
  function orphanNote(o, cache) {
    if (o.type === "regiment") {
      const st = pack.states?.[o.i];
      if (!live(st)) return true;
      return Array.isArray(st.military) && !st.military.some(r => r?.i === o.sub);
    }
    if (INDEXED.includes(o.type)) {
      if (!o.i) return false; // id 0: Neutrals, Wildlands, No religion, placeholders
      return !live(pack[LIST[o.type]]?.[o.i]);
    }
    if (o.type === "label") {
      return !mapEl(`label${o.i}`)?.closest("#labels");
    }
    const key = { marker: "markers", route: "routes", river: "rivers", zone: "zones" }[o.type];
    cache[key] ??= idSet(pack[key]);
    return !cache[key].has(o.i);
  }

  const SVG_IDS = {
    burg: i => [`burg${i}`, `anchor${i}`, `burgLabel${i}`, `burgCOA${i}`],
    state: i => [
      `stateLabel${i}`,
      `textPath_stateLabel${i}`,
      `stateCOA${i}`,
      `army${i}`,
      `state${i}`,
      `state-gap${i}`,
      `state-border${i}`,
      `state-clip${i}`
    ],
    province: i => [`provinceCOA${i}`, `province${i}`, `province-gap${i}`, `provinceLabel${i}`],
    culture: i => [`culture${i}`, `culture-gap${i}`, `cultureCenter${i}`],
    religion: i => [`religion${i}`, `religion-gap${i}`, `religionsCenter${i}`]
  };
  const EMBLEM_GROUP = { burg: "burgEmblems", state: "stateEmblems", province: "provinceEmblems" };
  const DELETED_SVG = {
    marker: ["markers", "marker"],
    route: ["routes", "route"],
    river: ["rivers", "river"],
    zone: ["zones", "zone"]
  };

  /** data-i -> emblem <use> of one emblems group (built once per plan). */
  function emblemIndex(type, cache) {
    if (cache[type]) return cache[type];
    const m = new Map();
    const g =
      EMBLEM_GROUP[type] && typeof document !== "undefined" ? document.getElementById(EMBLEM_GROUP[type]) : null;
    if (g) for (const use of g.children) if (use.tagName === "use") m.set(Number(use.getAttribute("data-i")), use);
    cache[type] = m;
    return m;
  }

  /** SVG elements that belong to removed entity `i` of an indexed type. */
  function svgOfRemoved(type, i, cache) {
    const out = [];
    for (const id of SVG_IDS[type](i)) {
      const el = mapEl(id);
      if (el) out.push(el);
    }
    const use = emblemIndex(type, cache).get(i);
    if (use) out.push(use);
    return out;
  }

  /** SVG elements of markers/routes/rivers/zones that no longer exist: [{i, el}]. */
  function svgOfDeleted(type, only) {
    const [group, prefix] = DELETED_SVG[type];
    const box = typeof document !== "undefined" ? document.getElementById(group) : null;
    if (!box?.closest("#map")) return [];
    const have = idSet(pack[group]);
    const re = new RegExp(`^${prefix}(\\d+)$`);
    const out = [];
    for (const el of box.querySelectorAll(`[id^="${prefix}"]`)) {
      const m = re.exec(el.id);
      if (!m) continue;
      const i = Number(m[1]);
      if (have.has(i) || (only && !only.has(i))) continue;
      out.push({ i, el });
    }
    return out;
  }

  /**
   * What compact would do. a: {types?, notes?, svg?} or, for replay, {ids?, noteIds?, svgIds?}
   * (only those, where they still qualify). Mutates nothing.
   */
  function plan(a) {
    const types = Array.isArray(a.types) && a.types.length ? a.types : TYPES;
    for (const t of types)
      if (!TYPES.includes(t)) fail("BAD_ARGS", `compact does not handle '${t}'`, { details: TYPES });
    const replay = isObj(a.ids) || Array.isArray(a.noteIds) || isObj(a.svgIds) || Array.isArray(a.repoint);
    const want = (obj, t) => (replay ? new Set((isObj(obj) && Array.isArray(obj[t]) ? obj[t] : []).map(Number)) : null);
    // repoint province capitals only when burgs are compacted
    const repoint = !types.includes("burg")
      ? []
      : replay
        ? replayRepoints(Array.isArray(a.repoint) ? a.repoint : [])
        : a.repointProvinces
          ? provinceRepoints()
          : [];
    const ref = references(new Set(repoint.map(r => r.i)));
    const p = { stubs: [], kept: [], notes: [], svg: [], repoint };
    const emblems = {};

    for (const t of INDEXED) {
      if (!types.includes(t)) continue;
      const list = pack[LIST[t]] || [];
      const onlyIds = want(a.ids, t);
      const onlySvg = want(a.svgIds, t);
      for (const x of list) {
        if (!isObj(x) || !x.removed || !posId(x.i) || list[x.i] !== x) continue;
        if (!replay || onlyIds.has(x.i)) {
          const held = ref[t].get(x.i);
          if (held) {
            if (!isStub(t, x)) p.kept.push({ type: t, i: x.i, by: held.by, kinds: held.kinds });
          } else if (!isStub(t, x)) {
            const stub = stubOf(t, x);
            p.stubs.push({ type: t, i: x.i, x, stub, bytes: u8(JSON.stringify(x)) - u8(JSON.stringify(stub)) });
          }
        }
        if (a.svg !== false && (!replay || onlySvg.has(x.i)))
          for (const el of svgOfRemoved(t, x.i, emblems)) p.svg.push({ type: t, i: x.i, el });
      }
    }
    if (a.svg !== false)
      for (const t of Object.keys(DELETED_SVG)) {
        if (!types.includes(t)) continue;
        if (replay && !(isObj(a.svgIds) && Array.isArray(a.svgIds[t]))) continue;
        for (const o of svgOfDeleted(t, want(a.svgIds, t))) p.svg.push({ type: t, i: o.i, el: o.el });
      }
    if (a.notes !== false && typeof notes !== "undefined" && Array.isArray(notes)) {
      const onlyNotes = replay ? new Set(Array.isArray(a.noteIds) ? a.noteIds.map(String) : []) : null;
      const cache = {};
      for (const n of notes) {
        if (!isObj(n) || (onlyNotes && !onlyNotes.has(String(n.id)))) continue;
        const o = noteOwner(n.id);
        if (o && types.includes(o.type) && orphanNote(o, cache)) p.notes.push(n);
      }
    }
    return p;
  }

  /**
   * .map bytes the plan saves: exact for records and notes (their JSON), close for SVG (its
   * markup; the save serializes a clone of the map SVG). A repointed province capital changes the
   * digits of one number.
   */
  function planBytes(p) {
    let n = 0;
    for (const s of p.stubs) n += s.bytes;
    for (const x of p.notes) n += u8(JSON.stringify(x)) + 1;
    // [a,b] -> [] loses one comma fewer than it has elements
    if (p.notes.length && typeof notes !== "undefined" && p.notes.length === notes.length) n -= 1;
    for (const o of p.svg) n += u8(o.el.outerHTML || "");
    for (const r of p.repoint) n += String(r.from).length - String(r.to).length;
    return n;
  }

  function countBy(rows) {
    const out = {};
    for (const r of rows) out[r.type] = (out[r.type] || 0) + 1;
    return out;
  }

  function idsBy(rows) {
    const out = {};
    for (const r of rows) {
      if (!out[r.type]) out[r.type] = [];
      out[r.type].push(r.i);
    }
    return out;
  }

  /** {type: {kind: n}} over kept records (a record held in several ways counts under each). */
  function keptByKind(kept) {
    const out = {};
    for (const k of kept) {
      if (!out[k.type]) out[k.type] = {};
      const t = out[k.type];
      for (const kind of k.kinds.keys()) t[kind] = (t[kind] || 0) + 1;
    }
    return out;
  }

  /** One line per kind: how many records it holds and what releases them. */
  function keptWhy(kept, details) {
    const kinds = new Map();
    for (const k of kept) for (const kind of k.kinds.keys()) kinds.set(kind, (kinds.get(kind) || 0) + 1);
    const lines = [...kinds]
      .sort((x, y) => y[1] - x[1])
      .map(([kind, n]) => `${kind} (${n}): ${REMEDY[kind] || OTHER_REMEDY}`);
    const list = details ? "" : " details:true lists them.";
    return `${kept.length} removed record(s) stay whole because live data still points at them (by kind; a record can be held in several ways).${list} ${lines.join(" | ")}`;
  }

  /** Compact result for Node (counts first, details opt-in). */
  function view(p, details, limit) {
    const out = { compacted: countBy(p.stubs) };
    if (p.kept.length) {
      out.kept = countBy(p.kept);
      out.keptBy = keptByKind(p.kept);
    }
    if (p.repoint.length) out.repointed = p.repoint.length;
    Object.assign(out, {
      notesDropped: p.notes.length,
      svgDropped: p.svg.length,
      bytesSaved: planBytes(p),
      empty: !p.stubs.length && !p.notes.length && !p.svg.length && !p.repoint.length
    });
    if (details) {
      const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 5000) : 50;
      out.details = {
        ids: Object.fromEntries(Object.entries(idsBy(p.stubs)).map(([t, ids]) => [t, ranges(ids)])),
        kept: p.kept.slice(0, n).map(k => {
          const also = [...k.kinds.values()].filter(by => by !== k.by);
          return { type: k.type, i: k.i, by: k.by, ...(also.length ? { also } : {}) };
        }),
        notes: p.notes.slice(0, n).map(x => x.id),
        svg: Object.fromEntries(Object.entries(idsBy(p.svg)).map(([t, ids]) => [t, ranges(ids)]))
      };
      if (p.repoint.length)
        out.details.repointed = p.repoint.slice(0, n).map(r => ({ province: r.i, from: r.from, to: r.to }));
      if (p.kept.length > n) out.details.keptTruncated = p.kept.length;
      if (p.notes.length > n) out.details.notesTruncated = p.notes.length;
      if (p.repoint.length > n) out.details.repointedTruncated = p.repoint.length;
    }
    if (p.kept.length) out.keptWhy = keptWhy(p.kept, details);
    return out;
  }

  /**
   * Literal form for the sketch log: per-type ids compacted, note ids dropped, SVG owners,
   * province capitals repointed [[province, from, to]]. bytes and kept are for the log summary.
   */
  function resolvedOf(p) {
    const svg = {};
    for (const o of p.svg) {
      if (!svg[o.type]) svg[o.type] = [];
      if (!svg[o.type].includes(o.i)) svg[o.type].push(o.i);
    }
    const r = { ids: idsBy(p.stubs), notes: p.notes.map(n => n.id), svg };
    if (p.repoint.length) r.repoint = p.repoint.map(x => [x.i, x.from, x.to]);
    r.bytes = planBytes(p);
    if (p.kept.length) r.kept = p.kept.length;
    return r;
  }

  /**
   * Apply a plan. Returns a function that puts everything back (compactMapData uses it; the
   * compact tool relies on Node's undo entry instead). A throw part-way puts back what was done.
   */
  function applyPlan(p) {
    const undo = [];
    const restore = () => {
      for (let k = undo.length - 1; k >= 0; k--) {
        try {
          undo[k]();
        } catch {}
      }
      T.resetMemo?.();
    };
    try {
      for (const r of p.repoint) {
        const prov = pack.provinces[r.i];
        prov.burg = r.to;
        undo.push(() => {
          prov.burg = r.from;
        });
      }
      for (const s of p.stubs) {
        const arr = pack[LIST[s.type]];
        arr[s.i] = s.stub;
        undo.push(() => {
          arr[s.i] = s.x;
        });
      }
      if (p.notes.length) {
        const before = notes.slice();
        const drop = new Set(p.notes);
        const keep = before.filter(n => !drop.has(n));
        notes.length = 0;
        notes.push(...keep);
        undo.push(() => {
          notes.length = 0;
          notes.push(...before);
        });
      }
      for (const o of p.svg) {
        const parent = o.el.parentNode;
        if (!parent) continue;
        const next = o.el.nextSibling;
        o.el.remove();
        undo.push(() => parent.insertBefore(o.el, next && next.parentNode === parent ? next : null));
      }
    } catch (e) {
      restore();
      throw e;
    }
    T.resetMemo?.();
    return restore;
  }

  /** compact: phase 'validate' plans; phase 'apply' re-plans and applies (Node took the undo entry). */
  FNS.compact = async a => {
    const p = plan(a);
    const out = view(p, !!a.details, a.limit);
    if (a.phase !== "apply")
      return { phase: "validate", ...out, customization: typeof customization !== "undefined" ? customization : 0 };
    applyPlan(p);
    return { ...out, resolved: resolvedOf(p) };
  };

  /**
   * The .map text with compact applied to a copy: the page itself is unchanged (the plan is
   * applied, the text prepared and everything put back in the same synchronous step).
   */
  FNS.compactMapData = async a => {
    const { prepareMapData } = await lazy.save();
    const p = plan({ types: a.types }); // never repoints: a compacted save changes no live record
    const full = prepareMapData();
    const restore = applyPlan(p);
    let text;
    try {
      text = prepareMapData();
    } finally {
      restore();
    }
    let fileName = null;
    try {
      fileName = typeof getFileName === "function" ? getFileName() : null;
    } catch {}
    // flat: {burg: n, ..., kept?: {type: n}, keptBy?: {type: {kind: n}}, notesDropped, svgDropped,
    // bytesSaved (exact)}
    const compacted = { ...countBy(p.stubs) };
    if (p.kept.length) {
      compacted.kept = countBy(p.kept);
      compacted.keptBy = keptByKind(p.kept);
    }
    Object.assign(compacted, {
      notesDropped: p.notes.length,
      svgDropped: p.svg.length,
      bytesSaved: u8(full) - u8(text)
    });
    return {
      text,
      bytes: text.length,
      customization: typeof customization !== "undefined" ? customization : 0,
      fileName,
      compacted
    };
  };
  FNS.compactMapData.raw = true;

  T.compact = { plan, references, provinceRepoints, noteOwner, stubOf, isStub, ranges, u8, KEEP, TYPES };
})(globalThis);
