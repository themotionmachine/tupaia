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
//   religions CSV export reads origin names, ...).
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

  function isStub(type, x) {
    return Object.keys(x).every(k => k === "i" || k === "removed" || KEEP[type].includes(k));
  }

  /** Removed records that live data points at: {type: Map(id -> first referrer)}. */
  function references() {
    const ref = {};
    for (const t of INDEXED) ref[t] = new Map();
    const add = (t, id, by) => {
      if (posId(id) && !ref[t].has(id)) ref[t].set(id, by);
    };
    for (const s of pack.states || []) {
      if (!live(s)) continue;
      add("burg", s.capital, `state ${s.i} capital`);
      add("culture", s.culture, `state ${s.i} culture`);
      for (const p of s.provinces || []) add("province", p, `state ${s.i} provinces`);
      for (const n of s.neighbors || []) add("state", n, `state ${s.i} neighbors`);
      for (const c of s.campaigns || []) {
        add("state", c?.attacker, `state ${s.i} campaigns`);
        add("state", c?.defender, `state ${s.i} campaigns`);
      }
    }
    for (const p of pack.provinces || []) {
      if (!live(p)) continue;
      add("burg", p.burg, `province ${p.i} burg`);
      add("state", p.state, `province ${p.i} state`);
    }
    for (const b of pack.burgs || []) {
      if (!live(b) || !b.i) continue;
      add("state", b.state, `burg ${b.i} state`);
      add("culture", b.culture, `burg ${b.i} culture`);
    }
    for (const c of pack.cultures || [])
      if (live(c)) for (const o of c.origins || []) add("culture", o, `culture ${c.i} origins`);
    for (const r of pack.religions || []) {
      if (!live(r)) continue;
      add("culture", r.culture, `religion ${r.i} culture`);
      for (const o of r.origins || []) add("religion", o, `religion ${r.i} origins`);
    }
    for (const m of pack.markets || []) if (isObj(m)) add("burg", m.centerBurgId, `market ${m.i} centre`);
    for (const d of pack.deals || []) {
      if (!isObj(d)) continue;
      if (d.sellerType === "burg") add("burg", d.seller, `deal ${d.i} seller`);
      if (d.buyerType === "burg") add("burg", d.buyer, `deal ${d.i} buyer`);
    }
    for (const t of INDEXED) {
      const arr = pack.cells?.[t];
      if (arr) for (const v of new Set(arr)) add(t, v, `cells (${t})`);
    }
    return ref;
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
    const replay = isObj(a.ids) || Array.isArray(a.noteIds) || isObj(a.svgIds);
    const want = (obj, t) => (replay ? new Set((isObj(obj) && Array.isArray(obj[t]) ? obj[t] : []).map(Number)) : null);
    const ref = references();
    const p = { stubs: [], kept: [], notes: [], svg: [] };
    const emblems = {};

    for (const t of INDEXED) {
      if (!types.includes(t)) continue;
      const list = pack[LIST[t]] || [];
      const onlyIds = want(a.ids, t);
      const onlySvg = want(a.svgIds, t);
      for (const x of list) {
        if (!isObj(x) || !x.removed || !posId(x.i) || list[x.i] !== x) continue;
        if (!replay || onlyIds.has(x.i)) {
          if (ref[t].has(x.i)) {
            if (!isStub(t, x)) p.kept.push({ type: t, i: x.i, by: ref[t].get(x.i) });
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

  /** Approximate .map bytes the plan saves. */
  function planBytes(p) {
    let n = 0;
    for (const s of p.stubs) n += s.bytes;
    for (const x of p.notes) n += u8(JSON.stringify(x)) + 1;
    for (const o of p.svg) n += u8(o.el.outerHTML || "");
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

  /** Compact result for Node (counts first, details opt-in). */
  function view(p, details) {
    const out = { compacted: countBy(p.stubs) };
    if (p.kept.length) out.kept = countBy(p.kept);
    Object.assign(out, {
      notesDropped: p.notes.length,
      svgDropped: p.svg.length,
      bytesSaved: planBytes(p),
      empty: !p.stubs.length && !p.notes.length && !p.svg.length
    });
    if (details) {
      out.details = {
        ids: Object.fromEntries(Object.entries(idsBy(p.stubs)).map(([t, ids]) => [t, ranges(ids)])),
        kept: p.kept.slice(0, 50).map(k => ({ type: k.type, i: k.i, by: k.by })),
        notes: p.notes.slice(0, 100).map(n => n.id),
        svg: Object.fromEntries(Object.entries(idsBy(p.svg)).map(([t, ids]) => [t, ranges(ids)]))
      };
      if (p.kept.length > 50) out.details.keptTruncated = p.kept.length;
      if (p.notes.length > 100) out.details.notesTruncated = p.notes.length;
    }
    if (p.kept.length) {
      const list = details ? "" : " (details:true lists them)";
      const deals = p.kept.some(k => /^deal /.test(k.by))
        ? "; trade deals hold removed burgs until regenerate {parts:['production']} rebuilds them"
        : "";
      out.keptWhy = `${p.kept.length} removed record(s) are still referenced by live data and stay whole${list}${deals}`;
    }
    return out;
  }

  /** Literal form for the sketch log: per-type ids compacted, note ids dropped, SVG owners. */
  function resolvedOf(p) {
    const svg = {};
    for (const o of p.svg) {
      if (!svg[o.type]) svg[o.type] = [];
      if (!svg[o.type].includes(o.i)) svg[o.type].push(o.i);
    }
    return { ids: idsBy(p.stubs), notes: p.notes.map(n => n.id), svg };
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
    const out = view(p, !!a.details);
    if (a.phase !== "apply") return { phase: "validate", ...out };
    applyPlan(p);
    return { ...out, resolved: resolvedOf(p) };
  };

  /**
   * The .map text with compact applied to a copy: the page itself is unchanged (the plan is
   * applied, the text prepared and everything put back in the same synchronous step).
   */
  FNS.compactMapData = async a => {
    const { prepareMapData } = await lazy.save();
    const p = plan({ types: a.types });
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
    // flat: {burg: n, ..., kept?: {type: n}, notesDropped, svgDropped, bytesSaved (exact)}
    const compacted = { ...countBy(p.stubs) };
    if (p.kept.length) compacted.kept = countBy(p.kept);
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

  T.compact = { plan, references, noteOwner, stubOf, isStub, ranges, u8, KEEP, TYPES };
})(globalThis);
