// Tupaia MCP bridge extension 'regen': scoped, lock-aware regeneration of provinces and emblems
// with a literal (replayable) outcome. Injected after bridge.js and bridge-mutations.js (every
// src/bridge-ext/*.js, in name order). Same rules as bridge-mutations.js: app globals by bare
// name at call time, no locals that shadow app globals (emblems, provs, cells, notes, color, ...),
// every FNS function takes one args object.
//
// FNS.regenerate is wrapped: parts 'provinces' and 'emblems' run here, every other part goes to
// the previous FNS.regenerate (in segments, so the dependency order holds: rivers..states, then
// provinces, then routes/religions, then emblems, then the rest). A call without those parts
// passes straight through, unchanged. The wrapper never sees a phase: Node validates (and
// previews a dryRun) through FNS.regenPlan, which changes nothing. When every part is
// provinces/emblems the result carries `resolved` {parts, graph?, provinces?, emblems?}: the
// literal outcome (each new province with its run-length encoded cells and coa; each
// regenerated coa) that FNS.regenerateLiteral re-applies when a sketch is replayed.
(root => {
  const T = root.__tupaia;
  if (!T?.fns || typeof T.fns.regenerate !== "function") return;
  const FNS = T.fns;
  const fail = T.fail;
  const hashStr = T.pure.hashStr;
  const baseRegenerate = FNS.regenerate;

  const LITERAL_PARTS = ["provinces", "emblems"];
  /** Parts that run before provinces, and between provinces and emblems; any other part runs after emblems. */
  const BEFORE_PROVINCES = ["rivers", "biomes", "population", "cultures", "burgs", "states"];
  const BEFORE_EMBLEMS = ["routes", "religions"];
  /** Parts that replace or renumber the states/burgs that provinces/emblems options name. */
  const REFS_CHANGING = ["cultures", "burgs", "states"];
  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
  const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const live = x => !!x && typeof x === "object" && !!x.i && !x.removed;
  const show = v => {
    const s = JSON.stringify(v ?? null);
    return s.length > 40 ? `${s.slice(0, 37)}...` : s;
  };
  const coaHash = coa => hashStr(JSON.stringify(coa ?? null));
  const stateName = id => {
    const s = pack.states[id];
    return s && typeof s === "object" ? `${s.name} (${id})` : `${id}`;
  };
  const listNames = (ids, max = 4) =>
    ids.length > max
      ? `${ids.slice(0, max).map(stateName).join(", ")} and ${ids.length - max} more`
      : ids.map(stateName).join(", ");
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  /** Parts in dependency order (the order they run in). */
  function sortParts(parts) {
    const a = parts.filter(p => BEFORE_PROVINCES.includes(p));
    const b = parts.filter(p => BEFORE_EMBLEMS.includes(p));
    const c = parts.filter(p => !LITERAL_PARTS.includes(p) && !a.includes(p) && !b.includes(p));
    return [
      ...a,
      ...(parts.includes("provinces") ? ["provinces"] : []),
      ...b,
      ...(parts.includes("emblems") ? ["emblems"] : []),
      ...c
    ];
  }

  function checkOptionParts(a, parts) {
    if (!parts.length) fail("BAD_ARGS", "parts must be a non-empty array");
    if (a.provinces !== undefined && !parts.includes("provinces"))
      fail("BAD_ARGS", "provinces options need 'provinces' in parts");
    if (a.emblems !== undefined && !parts.includes("emblems"))
      fail("BAD_ARGS", "emblems options need 'emblems' in parts");
  }

  // ---------------------------------------------------------------- cultures and shields

  const cultureOk = c => Number.isInteger(c) && !!pack.cultures[c] && typeof pack.cultures[c] === "object";
  const cellCulture = cell => (cultureOk(pack.cells.culture[cell]) ? pack.cells.culture[cell] : 0);
  const burgCulture = b => (cultureOk(b.culture) ? b.culture : cellCulture(b.cell));
  const stateCulture = s => (cultureOk(s.culture) ? s.culture : cellCulture(s.center));
  /** A province's culture: its capital burg's, else its centre cell's (as the generator). */
  function provinceCulture(p) {
    const b = p.burg ? pack.burgs[p.burg] : null;
    return live(b) ? burgCulture(b) : cellCulture(p.center);
  }
  const cultureType = c => pack.cultures[c]?.type || "Generic";

  /**
   * The shield for an emblem of culture `culture` in state `sid` (COA.getShield). A Wildlands
   * (culture 0) burg or province takes its state's culture instead, counted in sh.fallback, as
   * does every one when sh.stateCulture. stateId 0/null: a state's own emblem.
   */
  function shieldFor(culture, sid, sh) {
    const st = sid ? pack.states[sid] : null;
    const sc = live(st) && cultureOk(st.culture) ? st.culture : 0;
    let c = cultureOk(culture) ? culture : 0;
    if (sc && c !== sc && (sh.stateCulture || !c)) {
      if (!sh.stateCulture) sh.fallback++;
      c = sc;
    }
    return COA.getShield(c, sid || undefined);
  }

  // ---------------------------------------------------------------- cell runs

  /** Sorted cell ids -> [start, count, start, count, ...] (pack cell ids run along rows). */
  function toRuns(ids) {
    const s = [...ids].sort((a, b) => a - b);
    const out = [];
    for (let k = 0; k < s.length; k++) {
      if (out.length && s[k] === out[out.length - 2] + out[out.length - 1]) out[out.length - 1]++;
      else out.push(s[k], 1);
    }
    return out;
  }
  /** Runs back to cell ids; only ids of this map's cells, at most one per cell (a saved log is untrusted). */
  function fromRuns(runs) {
    const out = [];
    const n = pack.cells.i.length;
    if (!Array.isArray(runs)) return out;
    for (let k = 0; k + 1 < runs.length && out.length < n; k += 2) {
      const start = runs[k];
      const len = runs[k + 1];
      if (!Number.isInteger(start) || !Number.isInteger(len) || start < 0 || len < 1) continue;
      for (let j = 0; j < len && start + j < n && out.length < n; j++) out.push(start + j);
    }
    return out;
  }

  /** pid -> its cells in `arr` (cells.province or a work copy), for the given ids only. */
  function cellsByPid(arr, ids) {
    const out = new Map([...ids].map(i => [i, []]));
    for (let c = 0; c < arr.length; c++) out.get(arr[c])?.push(c);
    return out;
  }

  // ---------------------------------------------------------------- provinces: plan

  const PROV_KEYS = ["states", "centres", "count", "ratio", "keepLocked", "lockedStates", "crossForeign"];
  const CENTRE_KEYS = ["state", "burg", "at", "name", "formName", "fullName"];
  const elevationCost = h => (h >= 70 ? 100 : h >= 50 ? 30 : h >= 20 ? 10 : 100);

  function provincesRatioInput() {
    const v = document.getElementById("provincesRatio")?.valueAsNumber;
    return Number.isFinite(v) ? v : 30;
  }

  function checkKeys(o, keys, what) {
    const extra = Object.keys(o).filter(k => !keys.includes(k));
    if (extra.length) fail("BAD_FIELD", `${what} takes no field '${extra[0]}'`, { details: keys });
  }

  /** Validate provinces options against the page; mutates nothing. */
  function planProvinces(o, parts) {
    if (o !== undefined && o !== null && !isObj(o))
      fail("BAD_ARGS", "provinces is {states?, centres?, count?, ratio?, keepLocked?, lockedStates?, crossForeign?}");
    const opt = o || {};
    checkKeys(opt, PROV_KEYS, "provinces");
    if ((opt.states !== undefined || opt.centres !== undefined) && parts.some(p => REFS_CHANGING.includes(p)))
      fail(
        "BAD_ARGS",
        `provinces states/centres name states and burgs, but parts ${parts.filter(p => REFS_CHANGING.includes(p)).join(", ")} replace them first; regenerate those in a call of their own`
      );
    for (const k of ["keepLocked", "lockedStates", "crossForeign"])
      if (opt[k] !== undefined && typeof opt[k] !== "boolean") fail("BAD_ARGS", `provinces.${k} must be true or false`);
    const keepLocked = opt.keepLocked !== false;
    const lockedStates = opt.lockedStates === true;
    if (opt.count !== undefined && (!Number.isInteger(opt.count) || opt.count < 1 || opt.count > 100))
      fail("BAD_ARGS", "count must be an integer 1..100");
    if (opt.ratio !== undefined && (typeof opt.ratio !== "number" || !(opt.ratio >= 1 && opt.ratio <= 100)))
      fail("BAD_ARGS", "ratio must be a number 1..100");
    const C = pack.cells;

    const centres = [];
    if (opt.centres !== undefined) {
      if (!Array.isArray(opt.centres) || !opt.centres.length)
        fail("BAD_ARGS", "centres is a non-empty array of {state, burg | at, name?, formName?, fullName?}");
      const seen = new Map();
      opt.centres.forEach((c, k) => {
        const where = `centres[${k}]`;
        if (!isObj(c)) fail("BAD_ARGS", `${where} must be an object {state, burg | at, ...}`);
        checkKeys(c, CENTRE_KEYS, where);
        if (c.state === undefined) fail("BAD_ARGS", `${where}: state is required`);
        const s = T.resolve("state", c.state).entity;
        if (!s.i) fail("BAD_ARGS", `${where}: Neutrals (state 0) have no provinces`);
        if ((c.burg === undefined) === (c.at === undefined))
          fail("BAD_ARGS", `${where}: give burg or at (exactly one)`);
        let cell;
        let burg = 0;
        if (c.burg !== undefined) {
          const b = T.resolve("burg", c.burg).entity;
          if (C.state[b.cell] !== s.i)
            fail(
              "REFUSED",
              `${where}: burg ${b.name} (${b.i}) is in ${stateName(C.state[b.cell])}, not ${stateName(s.i)}`
            );
          cell = b.cell;
          burg = b.i;
        } else {
          const p = T.place(c.at);
          cell = p.cell;
          if (C.h[cell] < 20) fail("BAD_PLACE", `${where}: cell ${cell} is water; a province centre must be land`);
          if (C.state[cell] !== s.i)
            fail(
              "REFUSED",
              `${where}: cell ${cell} at (${p.x}, ${p.y}) is in ${stateName(C.state[cell])}, not ${stateName(s.i)}`
            );
          burg = C.burg[cell] || 0; // a burg on the cell becomes the province's capital
        }
        if (seen.has(cell)) fail("BAD_ARGS", `${where}: same cell ${cell} as centres[${seen.get(cell)}]`);
        seen.set(cell, k);
        for (const f of ["name", "formName", "fullName"])
          if (c[f] !== undefined && (typeof c[f] !== "string" || !c[f].trim()))
            fail("BAD_ARGS", `${where}: ${f} must be a non-empty string`);
        centres.push({ k, state: s.i, cell, burg, name: c.name, formName: c.formName, fullName: c.fullName });
      });
    }

    let targets;
    if (opt.states !== undefined) {
      if (!Array.isArray(opt.states) || !opt.states.length)
        fail("BAD_ARGS", "states is a non-empty array of state refs");
      targets = [];
      for (const ref of opt.states) {
        const s = T.resolve("state", ref).entity;
        if (!s.i) fail("BAD_ARGS", "Neutrals (state 0) have no provinces");
        if (!targets.includes(s.i)) targets.push(s.i);
      }
      for (const c of centres)
        if (!targets.includes(c.state))
          fail("BAD_ARGS", `centres[${c.k}] is in ${stateName(c.state)}, which is not in states`);
    } else if (centres.length) targets = [...new Set(centres.map(c => c.state))];
    else targets = pack.states.filter(s => live(s) && (lockedStates || !s.lock)).map(s => s.i);
    if (!lockedStates) {
      const locked = targets.filter(i => pack.states[i].lock);
      if (locked.length)
        fail(
          "REFUSED",
          `${listNames(locked)} ${locked.length > 1 ? "are" : "is"} locked: pass lockedStates:true to regenerate ${locked.length > 1 ? "their" : "its"} provinces anyway (locked provinces stay unless keepLocked:false), or unlock with edit state {lock:false}`
        );
    }
    if (!targets.length)
      fail("BAD_ARGS", "no state to regenerate provinces for: every state is locked (lockedStates:true includes them)");
    targets.sort((a, b) => a - b);
    const targetSet = new Set(targets);
    const kept = new Set();
    const replaced = [];
    for (const p of pack.provinces)
      if (live(p) && targetSet.has(p.state)) {
        if (keepLocked && p.lock) kept.add(p.i);
        else replaced.push(p.i);
      }
    for (const c of centres) {
      const pid = C.province[c.cell];
      const p = pack.provinces[pid];
      if (kept.has(pid) || (keepLocked && live(p) && p.lock && !targetSet.has(p.state)))
        fail(
          "REFUSED",
          `centres[${c.k}]: cell ${c.cell} is in locked province ${p.name} (${p.i}); pick another place or pass keepLocked:false`
        );
    }
    const ratio = opt.ratio ?? provincesRatioInput();
    const autoTargets = targets.filter(i => !centres.some(c => c.state === i) && !opt.count);
    // ratio 0 means no growth: the generator would make every free cell a one-cell province
    if (ratio < 1 && autoTargets.length)
      fail(
        "BAD_ARGS",
        `the options panel's provinces ratio is ${ratio}, which makes one-cell provinces; pass provinces.ratio 1..100 or count`
      );
    const notesOut = [];
    if (opt.count !== undefined && targets.every(i => centres.some(c => c.state === i)))
      notesOut.push("provinces: count was not used: every state has centres (count is for states without centres)");
    if (opt.ratio !== undefined && !autoTargets.length)
      notesOut.push("provinces: ratio was not used: it is for auto mode (states without centres or count)");
    return {
      keepLocked,
      lockedStates,
      crossForeign: opt.crossForeign === true,
      ratio,
      count: opt.count,
      centres,
      targets,
      kept,
      replaced,
      notes: notesOut
    };
  }

  function modeOf(plan, sid) {
    if (plan.centres.some(c => c.state === sid)) return "centres";
    return plan.count ? "count" : "auto";
  }

  /** The validation view (no generation). */
  function provincesPlanView(plan) {
    return {
      states: plan.targets.map(i => ({ i, name: pack.states[i].name, mode: modeOf(plan, i) })),
      replace: plan.replaced.length,
      keptLocked: plan.kept.size
    };
  }

  // ---------------------------------------------------------------- provinces: generate

  function formPicker(s) {
    const form = Object.assign({}, Provinces.forms[s.form] || { Province: 1 });
    return () => {
      const f = rw(form);
      form[f] += 10;
      return f;
    };
  }

  const generatedName = culture => Names.getState(Names.getCultureShort(culture), culture);

  /** COA of a province whose capital is burg b (as Provinces.generate). */
  function burgProvinceCoa(b, sid, center, name, sh) {
    const coa = COA.generate(b.coa || null, name === b.name ? 0.8 : 0.4, null, Burgs.getType(center, b.port));
    coa.shield = shieldFor(burgCulture(b), sid, sh);
    return coa;
  }

  /** COA of a province centred on a place without a burg. */
  function placeProvinceCoa(s, center, sh) {
    const coa = COA.generate(s.coa || null, 0.4, 0, Burgs.getType(center, undefined));
    coa.shield = shieldFor(cellCulture(center), s.i, sh);
    return coa;
  }

  /** Burgs of state sid on free cells: capital first, then by population (with jitter). */
  function rankedBurgs(sid, work) {
    const C = pack.cells;
    return pack.burgs
      .filter(b => live(b) && C.state[b.cell] === sid && !work[b.cell])
      .map(b => ({ b, score: (b.population || 0) * gauss(1, 0.2, 0.5, 1.5, 3) }))
      .sort((x, y) => (y.b.capital || 0) - (x.b.capital || 0) || y.score - x.score)
      .map(x => x.b);
  }

  /**
   * count mode: `count` centres in state s: k-means over the free land cells (seeded at the
   * capital, then farthest points), then each cluster is centred on its biggest burg (the
   * capital's cluster on the capital), or on the cell nearest its middle when it holds no burg.
   */
  function pickCentres(s, own, count, work) {
    const C = pack.cells;
    const k = Math.min(count, own.length);
    if (!k) return [];
    const X = own.map(c => C.p[c][0]);
    const Y = own.map(c => C.p[c][1]);
    const ranked = rankedBurgs(s.i, work); // capital first
    const capital = ranked[0]?.capital ? ranked[0] : null;
    const nearest = (x, y, skip) => {
      let best = -1;
      let bd = Infinity;
      own.forEach((c, j) => {
        if (skip?.has(c)) return;
        const d = (X[j] - x) ** 2 + (Y[j] - y) ** 2;
        if (d < bd) {
          bd = d;
          best = j;
        }
      });
      return best;
    };
    // seeds: the capital (or the cell nearest the state's pole), then farthest points
    const [px, py] = capital ? C.p[capital.cell] : s.pole || C.p[s.center];
    const first = nearest(px, py);
    const seeds = [[X[first], Y[first]]];
    const md = new Float64Array(own.length).fill(Infinity);
    while (seeds.length < k) {
      const [sx, sy] = seeds[seeds.length - 1];
      let far = 0;
      for (let j = 0; j < own.length; j++) {
        md[j] = Math.min(md[j], (X[j] - sx) ** 2 + (Y[j] - sy) ** 2);
        if (md[j] > md[far]) far = j;
      }
      seeds.push([X[far], Y[far]]);
    }
    // Lloyd steps
    const assign = new Int32Array(own.length);
    const assignAll = () => {
      for (let j = 0; j < own.length; j++) {
        let q = 0;
        let bd = Infinity;
        for (let i = 0; i < k; i++) {
          const d = (X[j] - seeds[i][0]) ** 2 + (Y[j] - seeds[i][1]) ** 2;
          if (d < bd) {
            bd = d;
            q = i;
          }
        }
        assign[j] = q;
      }
    };
    for (let it = 0; it < 8; it++) {
      assignAll();
      const sx = new Float64Array(k);
      const sy = new Float64Array(k);
      const n = new Uint32Array(k);
      for (let j = 0; j < own.length; j++) {
        sx[assign[j]] += X[j];
        sy[assign[j]] += Y[j];
        n[assign[j]]++;
      }
      for (let i = 0; i < k; i++) if (n[i]) seeds[i] = [sx[i] / n[i], sy[i] / n[i]];
    }
    assignAll();
    const clusterOf = new Map(own.map((c, j) => [c, assign[j]]));
    const out = [];
    const used = new Set();
    const order = [...seeds.keys()];
    if (capital) {
      const q = clusterOf.get(capital.cell);
      order.splice(order.indexOf(q), 1);
      order.unshift(q);
    }
    for (const q of order) {
      let b = capital && clusterOf.get(capital.cell) === q && !used.has(capital.cell) ? capital : null;
      if (!b) {
        for (const x of ranked)
          if (clusterOf.get(x.cell) === q && !used.has(x.cell) && (!b || (x.population || 0) > (b.population || 0)))
            b = x;
      }
      if (b) {
        used.add(b.cell);
        out.push({ cell: b.cell, burg: b.i });
        continue;
      }
      const j = nearest(seeds[q][0], seeds[q][1], new Set([...used, ...own.filter(c => C.burg[c])]));
      if (j < 0) continue;
      used.add(own[j]);
      out.push({ cell: own[j], burg: 0 });
    }
    return out;
  }

  /**
   * Spread province ids from their centres by elevation cost (as Provinces.generate, without its
   * growth limit). Coastal water is crossed at a high cost; other states' land (and locked
   * provinces) is entered only when `cross` (the travel cost is the same; only the state's own
   * free land is claimed). A centre starts at its seed's `offset` and is never taken by
   * another. Returns owner[cell] (0 = not reached).
   */
  function spreadOwners(sid, seeds, work, cross) {
    const C = pack.cells;
    const n = C.i.length;
    const cost = new Float64Array(n).fill(Infinity);
    const owner = new Uint32Array(n);
    const mine = new Set(seeds.map(x => x.pid));
    const centre = new Set(seeds.map(x => x.center));
    const q = new FlatQueue();
    for (const x of seeds) {
      cost[x.center] = x.offset || 0;
      owner[x.center] = x.pid;
      q.push(x.center, cost[x.center]);
    }
    while (q.length) {
      const d = q.peekValue();
      const e = q.pop();
      if (d > cost[e]) continue;
      for (const x of C.c[e]) {
        if (centre.has(x)) continue;
        if (C.h[x] >= 20) {
          const free = C.state[x] === sid && !(work[x] && !mine.has(work[x]));
          if (!free && !cross) continue;
        } else if (!C.t[x]) continue;
        const t = d + elevationCost(C.h[x]);
        if (t < cost[x]) {
          cost[x] = t;
          owner[x] = owner[e];
          q.push(x, t);
        }
      }
    }
    return owner;
  }

  /**
   * count mode: spread with per-centre start costs adjusted until the provinces are of about
   * equal size (a few rounds; the most even one is kept). Land the centres cannot reach and
   * disconnected parts limit how even they get.
   */
  function balancedOwners(sid, seeds, own, work, cross) {
    if (seeds.length < 2) return spreadOwners(sid, seeds, work, cross);
    const target = own.length / seeds.length;
    const cap = 10 * Math.sqrt(target);
    let best = null;
    for (let it = 0; it < 16; it++) {
      const owner = spreadOwners(sid, seeds, work, cross);
      const size = new Map(seeds.map(s => [s.pid, 0]));
      for (const c of own) if (size.has(owner[c])) size.set(owner[c], size.get(owner[c]) + 1);
      const vals = [...size.values()];
      const spread = Math.max(...vals) / Math.max(1, Math.min(...vals));
      if (!best || spread < best.spread) best = { owner, spread };
      if (spread <= 1.3) break;
      for (const s of seeds)
        s.offset = Math.min(cap, (s.offset || 0) + 4 * (Math.sqrt(size.get(s.pid)) - Math.sqrt(target)));
      const m = Math.min(...seeds.map(s => s.offset));
      for (const s of seeds) s.offset -= m;
    }
    return best.owner;
  }

  /**
   * Cells of `list` still without a province get the province of the nearest cell (by distance
   * through any cells) holding one of `ids` (exclaves the spread could not reach). Returns how
   * many stayed unassigned.
   */
  function fillLeftovers(list, work, ids) {
    const C = pack.cells;
    const left = list.filter(c => !work[c]);
    if (!left.length || !ids.size) return left.length;
    const n = C.i.length;
    const cost = new Float64Array(n).fill(Infinity);
    const owner = new Uint32Array(n);
    const q = new FlatQueue();
    for (const c of list)
      if (ids.has(work[c])) {
        cost[c] = 0;
        owner[c] = work[c];
        q.push(c, 0);
      }
    const want = new Set(left);
    let remaining = want.size;
    while (q.length && remaining) {
      const d = q.peekValue();
      const e = q.pop();
      if (d > cost[e]) continue;
      if (want.has(e) && !work[e]) {
        work[e] = owner[e];
        remaining--;
      }
      for (const x of C.c[e]) {
        const t = d + Math.hypot(C.p[x][0] - C.p[e][0], C.p[x][1] - C.p[e][1]);
        if (t < cost[x]) {
          cost[x] = t;
          owner[x] = owner[e];
          q.push(x, t);
        }
      }
    }
    return remaining;
  }

  /** Is there a land way inside state `sid` between two cells (Provinces.generate isPassable). */
  function isPassable(from, to) {
    const C = pack.cells;
    if (C.f[from] !== C.f[to]) return false;
    const stack = [from];
    const used = new Uint8Array(C.i.length);
    const st = C.state[from];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === to) return true;
      for (const c of C.c[cur]) {
        if (used[c] || C.h[c] < 20 || C.state[c] !== st) continue;
        stack.push(c);
        used[c] = 1;
      }
    }
    return false;
  }

  /**
   * auto mode for one state: Provinces.generate's own rules (burg provinces by ratio, growth
   * limit, shape smoothing, then "wild" provinces for the rest), except that a state with
   * fewer than 2 burgs still gets provinces (its burg's, then wild ones).
   */
  function autoState(s, own, work, alloc, put, maxGrowth, ratio, sh) {
    const C = pack.cells;
    const sid = s.i;
    const mine = new Set();
    const made = [];
    const pickForm = formPicker(s);
    const stateBurgs = rankedBurgs(sid, work);
    const number = stateBurgs.length
      ? Math.min(stateBurgs.length, Math.max(Math.ceil((stateBurgs.length * ratio) / 100), 2))
      : 0;
    for (let k = 0; k < number; k++) {
      const b = stateBurgs[k];
      const c = burgCulture(b);
      const name = P(0.5) ? b.name : generatedName(c);
      const formName = pickForm();
      const p = put({
        i: alloc(),
        state: sid,
        center: b.cell,
        burg: b.i,
        name,
        formName,
        fullName: `${name} ${formName}`,
        color: getMixedColor(s.color),
        coa: burgProvinceCoa(b, sid, b.cell, name, sh)
      });
      mine.add(p.i);
      made.push(p);
    }
    const blocked = x => work[x] && !mine.has(work[x]);

    // expand from the burg centres
    const queue = new FlatQueue();
    const cost = [];
    for (const p of made) {
      work[p.center] = p.i;
      queue.push({ e: p.center, province: p.i, p: 0 }, 0);
      cost[p.center] = 1;
    }
    while (queue.length) {
      const { e, p, province } = queue.pop();
      for (const x of C.c[e]) {
        if (blocked(x)) continue;
        const land = C.h[x] >= 20;
        if (!land && !C.t[x]) continue;
        if (land && C.state[x] !== sid) continue;
        const total = p + elevationCost(C.h[x]);
        if (total > maxGrowth) continue;
        if (!cost[x] || total < cost[x]) {
          if (land) work[x] = province;
          cost[x] = total;
          queue.push({ e: x, province, p: total }, total);
        }
      }
    }

    // justify the shapes a bit
    for (const i of own) {
      if (C.burg[i] || blocked(i)) continue;
      const neibs = C.c[i].filter(x => C.state[x] === C.state[i] && !blocked(x)).map(x => work[x]);
      const adversaries = neibs.filter(x => x !== work[i]);
      if (adversaries.length < 2) continue;
      const buddies = neibs.filter(x => x === work[i]).length;
      if (buddies > 2) continue;
      const competitors = adversaries.map(p => adversaries.reduce((acc, v) => (v === p ? acc + 1 : acc), 0));
      const maxBuddies = Math.max(...competitors);
      if (buddies >= maxBuddies) continue;
      work[i] = adversaries[competitors.indexOf(maxBuddies)];
    }

    // "wild" provinces for the cells left
    const pool = [s.name, ...made.map(p => p.name)].filter(x => x && !/new/i.test(x));
    const colonyName = () => {
      if (!pool.length) return null;
      const spliced = pool.splice(rand(pool.length - 1), 1);
      return spliced[0] ? `New ${spliced[0]}` : null;
    };
    let pending = own.filter(c => !work[c]);
    while (pending.length) {
      const pid = alloc();
      const burgCell = pending.find(c => C.burg[c]);
      const center = burgCell !== undefined ? burgCell : pending[0];
      const burgId = burgCell !== undefined ? C.burg[burgCell] : 0;
      work[center] = pid;
      const wcost = [];
      wcost[center] = 1;
      queue.push({ e: center, p: 0 }, 0);
      while (queue.length) {
        const { e, p } = queue.pop();
        for (const x of C.c[e]) {
          if (work[x]) continue;
          const land = C.h[x] >= 20;
          if (C.state[x] && C.state[x] !== sid) continue;
          const ter = land ? (C.state[x] === sid ? 3 : 20) : C.t[x] ? 10 : 30;
          const total = p + ter;
          if (total > maxGrowth) continue;
          if (!wcost[x] || total < wcost[x]) {
            if (land && C.state[x] === sid) work[x] = pid;
            wcost[x] = total;
            queue.push({ e: x, p: total }, total);
          }
        }
      }
      const c = cellCulture(center);
      const f = pack.features[C.f[center]];
      const provCells = pending.filter(x => work[x] === pid);
      const singleIsle = provCells.length === f.cells && !provCells.find(x => C.f[x] !== f.i);
      const isleGroup = !singleIsle && !provCells.find(x => pack.features[C.f[x]].group !== "isle");
      const colony = !singleIsle && !isleGroup && P(0.5) && !isPassable(s.center, center);
      const name = (() => {
        const cn = colony && P(0.8) && colonyName();
        if (cn) return cn;
        if (burgCell !== undefined && P(0.5)) return pack.burgs[burgId].name;
        return generatedName(c);
      })();
      const formName = singleIsle ? "Island" : isleGroup ? "Islands" : colony ? "Colony" : rw(Provinces.forms.Wild);
      const dominion = colony ? P(0.95) : singleIsle || isleGroup ? P(0.7) : P(0.3);
      const coa = COA.generate(
        s.coa || null,
        dominion ? 0 : 0.4,
        dominion ? 1 : 0,
        Burgs.getType(center, pack.burgs[burgId]?.port)
      );
      coa.shield = shieldFor(c, sid, sh);
      const p = put({
        i: pid,
        state: sid,
        center,
        burg: burgId,
        name,
        formName,
        fullName: `${name} ${formName}`,
        color: getMixedColor(s.color),
        coa
      });
      mine.add(p.i);
      made.push(p);
      pending = pending.filter(x => !work[x]);
    }
    return made;
  }

  /**
   * auto mode: merge burg-less, non-island provinces under 3% of the state's land (at least 3
   * cells) into the neighbouring province of the state they share the longest border with.
   * Returns the merged-away ids.
   */
  function mergeTiny(own, work, mine) {
    const C = pack.cells;
    const dropped = new Set();
    if (mine.length < 2) return dropped;
    const minCells = Math.max(3, Math.ceil(own.length * 0.03));
    const size = new Map(mine.map(p => [p.i, 0]));
    for (const c of own) if (size.has(work[c])) size.set(work[c], size.get(work[c]) + 1);
    const small = mine
      .filter(p => !p.burg && p.formName !== "Island" && p.formName !== "Islands" && size.get(p.i) < minCells)
      .sort((a, b) => size.get(a.i) - size.get(b.i));
    for (const p of small) {
      const border = new Map();
      for (const c of own) {
        if (work[c] !== p.i) continue;
        for (const x of C.c[c]) {
          const q = work[x];
          if (q !== p.i && size.has(q) && !dropped.has(q)) border.set(q, (border.get(q) || 0) + 1);
        }
      }
      if (!border.size) continue;
      const into = [...border].sort((a, b) => b[1] - a[1])[0][0];
      for (const c of own) if (work[c] === p.i) work[c] = into;
      size.set(into, size.get(into) + size.get(p.i));
      dropped.add(p.i);
    }
    return dropped;
  }

  /** count / centres mode for one state: one province per centre, spread over the whole state. */
  function centredState(s, own, work, alloc, put, centres, o) {
    const pickForm = formPicker(s);
    const mine = [];
    for (const ct of centres) {
      const b = ct.burg ? pack.burgs[ct.burg] : null;
      const culture = b ? burgCulture(b) : cellCulture(ct.cell);
      const name = ct.name ?? (b && P(0.5) ? b.name : generatedName(culture));
      const formName = ct.formName ?? pickForm();
      const coa = b ? burgProvinceCoa(b, s.i, ct.cell, name, o.sh) : placeProvinceCoa(s, ct.cell, o.sh);
      mine.push(
        put({
          i: alloc(),
          state: s.i,
          center: ct.cell,
          burg: b ? b.i : 0,
          name,
          formName,
          fullName: ct.fullName ?? `${name} ${formName}`,
          color: getMixedColor(s.color),
          coa
        })
      );
    }
    const seeds = mine.map(p => ({ center: p.center, pid: p.i, offset: 0 }));
    const owner = o.balance ? balancedOwners(s.i, seeds, own, work, o.cross) : spreadOwners(s.i, seeds, work, o.cross);
    for (const x of seeds) work[x.center] = x.pid;
    for (const c of own) if (!work[c] && owner[c]) work[c] = owner[c];
    const unreached = own.filter(c => !work[c]).length;
    const left = fillLeftovers(own, work, new Set(mine.map(p => p.i)));
    return { made: mine, fallback: unreached - left };
  }

  /** Free land cells of each target state (cells.province already cleared in `work`). */
  function ownCells(targets, work) {
    const C = pack.cells;
    const by = new Map(targets.map(i => [i, []]));
    for (let c = 0; c < C.i.length; c++) {
      const list = by.get(C.state[c]);
      if (list && C.h[c] >= 20 && !work[c]) list.push(c);
    }
    return by;
  }

  /**
   * work = cells.province with every cell of the target states and every cell of a replaced
   * province cleared, except cells of kept (locked) provinces, of any state.
   */
  function clearedWork(targetSet, keep, replacedSet) {
    const C = pack.cells;
    const work = Uint16Array.from(C.province);
    for (let c = 0; c < work.length; c++) {
      const pid = work[c];
      if (keep.has(pid)) continue;
      if (replacedSet.has(pid) || targetSet.has(C.state[c])) work[c] = 0;
    }
    return work;
  }

  /** Locked provinces (any state) that keep their cells, when keepLocked. */
  function keepSet(kept, keepLocked) {
    const out = new Set(kept);
    if (keepLocked) for (const p of pack.provinces) if (live(p) && p.lock) out.add(p.i);
    return out;
  }

  /**
   * What `work` does outside the target states' own provinces (read-only): provinces of other
   * states that lose cells lying in the target states (a state carved by repainting cells.state
   * leaves them there), each emptied (removed on commit) or shrunk (centre, capital and pole
   * refitted), and cells of other states that were in a replaced province and now have none.
   */
  function foreignEffects(targetSet, replacedSet, work) {
    const C = pack.cells;
    const lost = new Map();
    const orphaned = new Map();
    for (let c = 0; c < work.length; c++) {
      const was = C.province[c];
      if (!was || was === work[c]) continue;
      if (!targetSet.has(C.state[c])) {
        if (!work[c] && replacedSet.has(was)) orphaned.set(C.state[c], (orphaned.get(C.state[c]) || 0) + 1);
        continue;
      }
      if (replacedSet.has(was)) continue;
      const p = pack.provinces[was];
      if (live(p) && !targetSet.has(p.state)) lost.set(was, (lost.get(was) || 0) + 1);
    }
    const emptied = [];
    const shrunk = [];
    if (lost.size) {
      const rest = cellsByPid(work, lost.keys());
      for (const [pid, n] of lost) {
        const p = pack.provinces[pid];
        const cellsLeft = rest.get(pid);
        const row = { i: pid, state: p.state, name: p.name, lost: n };
        if (!cellsLeft.length) {
          emptied.push(row);
          continue;
        }
        if (!cellsLeft.includes(p.center)) {
          // the biggest burg left, else the cell nearest the old centre
          let center = -1;
          let best = -1;
          for (const c of cellsLeft) {
            const b = C.burg[c] ? pack.burgs[C.burg[c]] : null;
            if (live(b) && (b.population || 0) > best) {
              best = b.population || 0;
              center = c;
            }
          }
          if (center < 0) {
            const [x0, y0] = C.p[p.center];
            let bd = Infinity;
            for (const c of cellsLeft) {
              const d = (C.p[c][0] - x0) ** 2 + (C.p[c][1] - y0) ** 2;
              if (d < bd) {
                bd = d;
                center = c;
              }
            }
          }
          row.center = center;
        }
        const capital = p.burg ? pack.burgs[p.burg] : null;
        if (p.burg && (!live(capital) || work[capital.cell] !== pid))
          row.burg = row.center !== undefined && C.burg[row.center] ? C.burg[row.center] : 0;
        shrunk.push(row);
      }
    }
    return { emptied, shrunk, orphaned };
  }

  function foreignNotes(fx, notesOut, verb) {
    const lost = [...fx.emptied, ...fx.shrunk];
    if (lost.length) {
      const cellsLost = lost.reduce((s, r) => s + r.lost, 0);
      const names = fx.emptied
        .slice(0, 4)
        .map(r => `${r.name} (${r.i}) of ${stateName(r.state)}`)
        .join(", ");
      notesOut.push(
        `provinces: ${plural(lost.length, "province")} of other states ${verb} ${plural(cellsLost, "cell")} lying in the regenerated states${fx.emptied.length ? `; ${fx.emptied.length} ${verb === "lose" ? "would be" : "were"} left empty and removed: ${names}${fx.emptied.length > 4 ? ", ..." : ""}` : ""}`
      );
    }
    if (fx.orphaned.size) {
      const ids = [...fx.orphaned.keys()].filter(Boolean);
      const n = [...fx.orphaned.values()].reduce((s, v) => s + v, 0);
      notesOut.push(
        `provinces: ${plural(n, "cell")} of ${ids.length ? listNames(ids) : "Neutrals"} ${verb === "lose" ? "would be left" : "were left"} without a province (they were in a replaced province); regenerate ${ids.length > 1 ? "those states'" : "that state's"} provinces too`
      );
    }
  }

  /** Regenerate provinces from a plan, on a copy of cells.province: changes nothing on the map. */
  function generateProvinces(plan) {
    const targetSet = new Set(plan.targets);
    const replacedSet = new Set(plan.replaced);
    const keep = keepSet(plan.kept, plan.keepLocked);
    const replacedRows = identRows(plan.replaced);
    const work = clearedWork(targetSet, keep, replacedSet);
    const by = ownCells(plan.targets, work);
    const base = pack.provinces.length;
    let next = base;
    const alloc = () => next++;
    let made = [];
    const put = p => {
      made.push(p);
      return p;
    };
    const sh = { stateCulture: false, fallback: 0 };
    const maxGrowth = plan.ratio === 100 ? 1000 : gauss(20, 5, 5, 100) * plan.ratio ** 0.5;
    const modes = new Map();
    const fallback = new Map();
    let unassigned = 0;
    for (const sid of plan.targets) {
      const s = pack.states[sid];
      const own = by.get(sid);
      const mode = modeOf(plan, sid);
      modes.set(sid, mode);
      if (!own.length) continue;
      if (mode === "auto") {
        const mine = autoState(s, own, work, alloc, put, maxGrowth, plan.ratio, sh);
        const dropped = mergeTiny(own, work, mine);
        if (dropped.size) made = made.filter(p => !dropped.has(p.i));
      } else {
        const centres =
          mode === "centres"
            ? plan.centres.filter(c => c.state === sid).map(c => ({ ...c }))
            : pickCentres(s, own, plan.count, work);
        const r = centredState(s, own, work, alloc, put, centres, {
          balance: mode === "count",
          cross: plan.crossForeign,
          sh
        });
        if (r.fallback) fallback.set(sid, r.fallback);
      }
      unassigned += own.filter(c => !work[c]).length;
    }
    // compact the new ids (merged provinces leave gaps)
    made.sort((a, b) => a.i - b.i);
    const remap = new Map(made.map((p, k) => [p.i, base + k]));
    if (made.some(p => remap.get(p.i) !== p.i)) {
      for (let c = 0; c < work.length; c++) if (work[c] >= base) work[c] = remap.get(work[c]) ?? 0;
      for (const p of made) p.i = remap.get(p.i);
    }
    const sizes = new Map(made.map(p => [p.i, 0]));
    for (let c = 0; c < work.length; c++) if (sizes.has(work[c])) sizes.set(work[c], sizes.get(work[c]) + 1);
    const notesOut = [...plan.notes];
    let lockedForeign = 0;
    for (let c = 0; c < work.length; c++)
      if (work[c] && keep.has(work[c]) && !plan.kept.has(work[c]) && targetSet.has(pack.cells.state[c]))
        lockedForeign++;
    if (lockedForeign)
      notesOut.push(
        `provinces: ${plural(lockedForeign, "cell")} of the regenerated states stay in locked provinces of other states (keepLocked:false gives them to the new provinces)`
      );
    return {
      targets: plan.targets,
      keepLocked: plan.keepLocked,
      lockedStates: plan.lockedStates,
      kept: plan.kept,
      replaced: plan.replaced,
      replacedRows,
      made,
      work,
      modes,
      fallback,
      unassigned,
      sizes,
      shields: sh.fallback,
      fx: foreignEffects(targetSet, replacedSet, work),
      notes: notesOut
    };
  }

  function dropEmblem(id) {
    document.getElementById(`provinceCOA${id}`)?.remove();
    for (const el of document.querySelectorAll(`#provinceEmblems > use[data-i="${id}"]`)) el.remove();
  }

  /** Write a run: placeholders for the replaced provinces, the new ones, cells, state lists, poles. */
  function commitProvinces(run) {
    const C = pack.cells;
    const list = pack.provinces;
    const work = run.work;
    for (const id of run.replaced) {
      list[id] = { i: id, removed: true };
      dropEmblem(id);
    }
    for (const p of run.made) list[p.i] = p;
    for (const d of run.fx.emptied) {
      const st = pack.states[d.state];
      if (st && Array.isArray(st.provinces)) st.provinces = st.provinces.filter(x => x !== d.i);
      list[d.i] = { i: d.i, removed: true };
      dropEmblem(d.i);
    }
    const shrunk = [];
    for (const d of run.fx.shrunk) {
      const p = list[d.i];
      if (d.center !== undefined) p.center = d.center;
      if (d.burg !== undefined) p.burg = d.burg;
      shrunk.push(p);
    }
    for (let c = 0; c < work.length; c++) C.province[c] = work[c];
    for (const sid of run.targets) {
      const s = pack.states[sid];
      s.provinces = [
        ...[...run.kept].filter(id => list[id]?.state === sid),
        ...run.made.filter(p => p.state === sid).map(p => p.i)
      ];
    }
    const refit = [...run.made, ...shrunk];
    if (refit.length) {
      const poles = getPolesOfInaccessibility(pack, cell => C.province[cell]);
      for (const p of refit) p.pole = poles[p.i] || [C.p[p.center][0], C.p[p.center][1]];
    }
    T.resetMemo?.();
  }

  /** Notes on a run (preview: 'would'). */
  function runNotes(run, notesOut, preview) {
    notesOut.push(...run.notes);
    const fb = [...run.fallback].filter(([, n]) => n);
    if (fb.length)
      notesOut.push(
        `provinces: ${fb
          .slice(0, 4)
          .map(([sid, n]) => `${plural(n, "cell")} of ${stateName(sid)}`)
          .join(
            ", "
          )} could not be reached from a centre without leaving the state and went to the nearest province; crossForeign:true lets the spread cross other states' land`
      );
    // uneven areas (islands aside): count mode, and auto mode for a few named states (a whole-map
    // auto run is the generator's own spread)
    const uneven = [];
    for (const sid of run.targets) {
      const mode = run.modes.get(sid);
      if (mode !== "count" && !(mode === "auto" && run.targets.length <= 5)) continue;
      const sz = run.made
        .filter(p => p.state === sid && p.formName !== "Island" && p.formName !== "Islands")
        .map(p => run.sizes.get(p.i));
      if (sz.length < 2) continue;
      const hi = Math.max(...sz);
      const lo = Math.max(1, Math.min(...sz));
      if (hi / lo > 4) uneven.push(`${stateName(sid)} ${hi} vs ${lo} cells`);
    }
    if (uneven.length)
      notesOut.push(
        `provinces: uneven sizes (largest vs smallest) in ${uneven.slice(0, 3).join(", ")}${uneven.length > 3 ? ", ..." : ""}: count:N balances the areas (disconnected land limits it), centres place them exactly`
      );
    if (run.shields)
      notesOut.push(
        `provinces: ${plural(run.shields, "new emblem")} took the state's culture shield (the capital or centre is Wildlands; paint_cells {set:{culture}} gives the land a culture)`
      );
    if (run.unassigned)
      notesOut.push(`provinces: ${plural(run.unassigned, "land cell")} of the regenerated states got no province`);
    foreignNotes(run.fx, notesOut, preview ? "lose" : "lost");
  }

  const IDENT_KEYS = ["name", "fullName", "formName", "color", "center", "burg"];
  /** Rows of the provinces a run replaces, with hashes of their cells and coa (replay checks them). */
  function identRows(ids) {
    if (!ids.length) return [];
    const cellsOf = cellsByPid(pack.cells.province, ids);
    return ids.map(id => {
      const p = pack.provinces[id];
      const row = { i: p.i, state: p.state };
      for (const k of IDENT_KEYS) row[k] = p[k] ?? null;
      row.cells = hashStr(JSON.stringify(toRuns(cellsOf.get(id))));
      row.coa = coaHash(p.coa);
      return row;
    });
  }

  /** Literal outcome of a provinces run (built after any emblems run of the same call). */
  function provincesLiteral(run) {
    const cellsOf = cellsByPid(
      run.work,
      run.made.map(p => p.i)
    );
    const locked = run.targets.filter(i => pack.states[i]?.lock);
    return {
      states: run.targets,
      names: run.targets.map(i => pack.states[i]?.name ?? null),
      keepLocked: run.keepLocked,
      ...(run.lockedStates ? { lockedStates: true } : {}),
      ...(locked.length ? { locked } : {}),
      kept: [...run.kept],
      replaced: run.replacedRows,
      created: run.made.map(p => ({
        i: p.i,
        state: p.state,
        center: p.center,
        burg: p.burg,
        name: p.name,
        formName: p.formName,
        fullName: p.fullName,
        color: p.color,
        coa: clone(p.coa),
        n: cellsOf.get(p.i).length,
        runs: toRuns(cellsOf.get(p.i))
      }))
    };
  }

  /** Result view of a run (the same shape for a dryRun preview and the real call). */
  function provincesView(run, notesOut) {
    const byState = run.targets.map(sid => {
      const made = run.made.filter(p => p.state === sid);
      const row = { i: sid, name: pack.states[sid].name, mode: run.modes.get(sid) ?? "literal", created: made.length };
      const replaced = run.replacedRows.filter(r => r.state === sid).length;
      if (replaced) row.replaced = replaced;
      const keep = [...run.kept].filter(id => pack.provinces[id]?.state === sid).length;
      if (keep) row.keptLocked = keep;
      if (made.length) row.sizes = made.map(p => run.sizes.get(p.i));
      if (run.fallback.get(sid)) row.fallback = run.fallback.get(sid);
      return row;
    });
    const out = {
      created: run.made.length,
      replaced: run.replacedRows.length,
      keptLocked: run.kept.size,
      states: byState.slice(0, 20)
    };
    if (byState.length > 20) notesOut.push(`provinces: ${byState.length} states regenerated; the first 20 are listed`);
    if (run.made.length <= 12)
      out.list = run.made.map(p => ({
        i: p.i,
        name: p.name,
        state: p.state,
        cells: run.sizes.get(p.i),
        ...(p.burg ? { burg: p.burg } : { center: p.center })
      }));
    else notesOut.push(`provinces: ${run.made.length} created; find {type:'province'} lists them`);
    return out;
  }

  // ---------------------------------------------------------------- provinces: literal replay

  function checkProvincesLiteral(L) {
    const errors = [];
    const err = (code, message) => errors.push({ code, message });
    if (!isObj(L) || !Array.isArray(L.states) || !Array.isArray(L.created) || !Array.isArray(L.replaced)) {
      err("BAD_ARGS", "provinces literal is {states, replaced, created}");
      return { errors };
    }
    const C = pack.cells;
    const keepLocked = L.keepLocked !== false;
    const fresh = new Set(Array.isArray(L.fresh) ? L.fresh : []);
    const lockedThen = new Set(Array.isArray(L.locked) ? L.locked : []);
    const targets = [];
    for (const id of L.states) {
      const s = pack.states[id];
      if (!live(s)) err("REMOVED", `state ${id} was removed; the sketch regenerated its provinces`);
      else {
        targets.push(id);
        if (s.lock && !lockedThen.has(id) && !fresh.has(id) && L.lockedStates !== true)
          err("REFUSED", `${stateName(id)} was locked since; the sketch regenerated its provinces`);
      }
    }
    const targetSet = new Set(targets);
    const kept = new Set();
    const replacedNow = [];
    for (const p of pack.provinces)
      if (live(p) && targetSet.has(p.state)) {
        if (keepLocked && p.lock) kept.add(p.i);
        else replacedNow.push(p.i);
      }
    // the replaced rows are checked against the provinces as they are now (someone else's
    // change since is a conflict); a state the sketch created has nobody else's provinces, so
    // its rows (whose ids may have shifted) are not checked
    const rows = new Set();
    const nowRows = new Map();
    const checkRows = L.replaced.filter(r => isObj(r) && !r.fresh && !fresh.has(r.state));
    const live2 = checkRows.filter(r => live(pack.provinces[r.i]) && pack.provinces[r.i].state === r.state);
    for (const r of identRows(live2.map(r => r.i))) nowRows.set(r.i, r);
    for (const r of L.replaced) {
      if (!isObj(r)) continue;
      rows.add(r.i);
      if (r.fresh || fresh.has(r.state)) continue;
      const p = pack.provinces[r.i];
      const who = `province '${r.name}' (${r.i}) of ${stateName(r.state)}`;
      if (!live(p) || p.state !== r.state) {
        err("REMOVED", `${who} was removed or moved to another state since; the sketch replaced it`);
        continue;
      }
      if (kept.has(p.i)) {
        err("REFUSED", `${who} was locked since; the sketch replaced it`);
        continue;
      }
      const now = nowRows.get(r.i);
      const diff = IDENT_KEYS.filter(k => JSON.stringify(p[k] ?? null) !== JSON.stringify(r[k] ?? null)).map(
        k => `${k} ${show(r[k])} -> ${show(p[k])}`
      );
      if (r.cells !== undefined && now && now.cells !== r.cells) diff.push("its cells");
      if (r.coa !== undefined && now && now.coa !== r.coa) diff.push("its emblem");
      if (diff.length)
        err("REFUSED", `${who} was changed since by someone else (${diff.join(", ")}); the sketch replaced it`);
    }
    for (const id of replacedNow) {
      const p = pack.provinces[id];
      if (!rows.has(id) && !fresh.has(p.state))
        err(
          "REFUSED",
          `${stateName(p.state)} has province '${p.name}' (${id}), added since; replaying the sketch's regenerate would remove it`
        );
    }
    L.created.forEach((d, k) => {
      if (!isObj(d) || typeof d.name !== "string" || (d.coa !== null && !isObj(d.coa))) {
        err("BAD_ARGS", `created[${k}] is not a province {state, center, name, coa, runs, ...}`);
        return;
      }
      if (!targetSet.has(d.state)) {
        if (!L.states.includes(d.state)) err("BAD_ARGS", `created[${k}] is not in one of the states`);
        return;
      }
      const usable = fromRuns(d.runs).filter(
        c => c >= 0 && c < C.i.length && C.h[c] >= 20 && C.state[c] === d.state && !kept.has(C.province[c])
      );
      if (!usable.length)
        err(
          "REFUSED",
          `province '${d.name}' has none of its cells in ${stateName(d.state)} any more (repainted since)`
        );
    });
    return { errors, targets, kept, replacedNow };
  }

  function applyProvincesLiteral(L, notesOut) {
    const chk = checkProvincesLiteral(L);
    if (chk.errors.length) fail(chk.errors[0].code, chk.errors[0].message, { details: chk.errors });
    const C = pack.cells;
    const keepLocked = L.keepLocked !== false;
    const targetSet = new Set(chk.targets);
    const replacedSet = new Set(chk.replacedNow);
    const replacedRows = identRows(chk.replacedNow);
    const keep = keepSet(chk.kept, keepLocked);
    const work = clearedWork(targetSet, keep, replacedSet);
    let next = pack.provinces.length;
    const made = [];
    let burgsDropped = 0;
    for (const d of L.created) {
      const pid = next++;
      const usable = fromRuns(d.runs).filter(
        c => c >= 0 && c < C.i.length && C.h[c] >= 20 && C.state[c] === d.state && !work[c]
      );
      if (!usable.length) fail("REFUSED", `province '${d.name}' has no cell left in ${stateName(d.state)}`);
      for (const c of usable) work[c] = pid;
      const center = usable.includes(d.center) ? d.center : usable[0];
      let burg = Number.isInteger(d.burg) ? d.burg : 0;
      if (burg && !live(pack.burgs[burg])) {
        burg = 0;
        burgsDropped++;
      }
      made.push({
        i: pid,
        state: d.state,
        center,
        burg,
        name: d.name,
        formName: d.formName,
        fullName: d.fullName,
        color: d.color,
        coa: clone(d.coa)
      });
    }
    if (burgsDropped)
      notesOut.push(`provinces: ${burgsDropped} capital burg(s) were removed since; those provinces have none`);
    // every free land cell of each state (cells that joined it since go to the nearest province)
    const by = ownCells(chk.targets, new Uint16Array(work.length));
    let unassigned = 0;
    for (const sid of chk.targets) {
      const own = by.get(sid).filter(c => !keep.has(work[c]));
      unassigned += fillLeftovers(own, work, new Set(made.filter(p => p.state === sid).map(p => p.i)));
    }
    const sizes = new Map(made.map(p => [p.i, 0]));
    for (let c = 0; c < work.length; c++) if (sizes.has(work[c])) sizes.set(work[c], sizes.get(work[c]) + 1);
    const run = {
      targets: chk.targets,
      keepLocked,
      lockedStates: L.lockedStates === true,
      kept: chk.kept,
      replaced: chk.replacedNow,
      replacedRows,
      made,
      work,
      modes: new Map(),
      fallback: new Map(),
      unassigned,
      sizes,
      shields: 0,
      fx: foreignEffects(targetSet, replacedSet, work),
      notes: []
    };
    commitProvinces(run);
    return run;
  }

  // ---------------------------------------------------------------- emblems

  const EMB_KEYS = ["states", "provinces", "burgs", "shieldOnly", "keepLocked", "lockedStates", "stateCulture"];

  function planEmblems(o, parts) {
    if (o !== undefined && o !== null && !isObj(o))
      fail(
        "BAD_ARGS",
        "emblems is {states?, provinces?, burgs?, shieldOnly?, keepLocked?, lockedStates?, stateCulture?}"
      );
    const opt = o || {};
    checkKeys(opt, EMB_KEYS, "emblems");
    for (const k of EMB_KEYS.slice(1))
      if (opt[k] !== undefined && typeof opt[k] !== "boolean") fail("BAD_ARGS", `emblems.${k} must be true or false`);
    let stateIds = null;
    if (opt.states !== undefined) {
      if (parts.includes("states"))
        fail(
          "BAD_ARGS",
          "emblems states name states, but part states replaces them first; regenerate states in a call of its own"
        );
      if (!Array.isArray(opt.states) || !opt.states.length)
        fail("BAD_ARGS", "emblems.states is a non-empty array of state refs");
      stateIds = [];
      for (const ref of opt.states) {
        const r = T.resolve("state", ref);
        if (!stateIds.includes(r.i)) stateIds.push(r.i);
      }
    }
    return {
      stateIds,
      provinces: opt.provinces !== false,
      burgs: opt.burgs !== false,
      shieldOnly: opt.shieldOnly === true,
      keepLocked: opt.keepLocked !== false,
      lockedStates: opt.lockedStates === true,
      stateCulture: opt.stateCulture === true
    };
  }

  /** The entities in scope; `prov` (a provinces run not committed yet) stands in for the provinces it makes. */
  function emblemTargets(E, prov) {
    const inScope = sid => E.stateIds === null || E.stateIds.includes(sid || 0);
    let provList = [];
    if (E.provinces) {
      const gone = new Set(prov ? prov.replaced : []);
      provList = pack.provinces.filter(p => live(p) && !gone.has(p.i) && inScope(p.state));
      if (prov) provList.push(...prov.made.filter(p => inScope(p.state)));
    }
    return {
      state: pack.states.filter(s => live(s) && inScope(s.i)),
      burg: E.burgs ? pack.burgs.filter(b => live(b) && inScope(b.state)) : [],
      province: provList
    };
  }

  function skipWhy(x, type, E) {
    if (x.coa?.custom) return "custom";
    if (!x.lock || !E.keepLocked) return null;
    if (type === "state" && E.lockedStates) return null;
    return "locked";
  }

  /** Counts (and the locked states kept) of an emblems plan, in the result's shape. */
  function emblemsCount(E, prov) {
    const t = emblemTargets(E, prov);
    const out = { states: 0, provinces: 0, burgs: 0 };
    const kept = { locked: 0, custom: 0 };
    const lockedStates = [];
    for (const [type, key] of EMB_TYPES)
      for (const x of t[type]) {
        const why = skipWhy(x, type, E);
        if (!why) out[key]++;
        else {
          kept[why]++;
          if (type === "state" && why === "locked") lockedStates.push(x.i);
        }
      }
    return { out, kept, lockedStates };
  }

  function emblemsResult(counts, E) {
    return {
      ...counts.out,
      ...(counts.kept.locked || counts.kept.custom ? { kept: counts.kept } : {}),
      ...(E.shieldOnly ? { shieldOnly: true } : {}),
      ...(E.stateCulture ? { stateCulture: true } : {})
    };
  }

  function emblemsNotes(counts, shields, notesOut, preview) {
    if (counts.lockedStates.length)
      notesOut.push(
        `emblems: the emblems of locked ${counts.lockedStates.length > 1 ? "states" : "state"} ${listNames(counts.lockedStates)} ${preview ? "would be" : "were"} kept: pass lockedStates:true to regenerate them (or unlock with edit state {lock:false})`
      );
    if (shields)
      notesOut.push(
        `emblems: ${plural(shields, "shield")} took the state's culture (the burg's or province's culture is Wildlands; paint_cells {set:{culture}} gives the land a culture, stateCulture:true uses the state's for all)`
      );
  }

  function removeCoaDef(type, i) {
    document.getElementById(`${type}COA${i}`)?.remove();
  }

  /** Regenerate the coats of arms in scope (states, then burgs, then provinces, as the app). */
  function runEmblems(E) {
    const t = emblemTargets(E, null);
    const rows = { state: [], burg: [], province: [] };
    const sh = { stateCulture: E.stateCulture, fallback: 0 };
    const counts = { out: { states: 0, provinces: 0, burgs: 0 }, kept: { locked: 0, custom: 0 }, lockedStates: [] };
    const skip = (type, x) => {
      const why = skipWhy(x, type, E);
      if (!why) return false;
      counts.kept[why]++;
      if (type === "state" && why === "locked") counts.lockedStates.push(x.i);
      return true;
    };
    const set = (type, x, coa) => {
      const row = { i: x.i, was: coaHash(x.coa) };
      if (x.lock) row.locked = true;
      if (type === "province") {
        row.state = x.state;
        row.center = x.center;
      }
      rows[type].push(row);
      x.coa = coa;
      removeCoaDef(type, x.i);
    };
    for (const s of t.state) {
      if (skip("state", s)) continue;
      const culture = stateCulture(s);
      const coa = E.shieldOnly && s.coa ? { ...s.coa } : COA.generate(null, null, null, cultureType(culture));
      coa.shield = COA.getShield(culture, undefined);
      set("state", s, coa);
    }
    for (const b of t.burg) {
      if (skip("burg", b)) continue;
      let coa;
      if (E.shieldOnly && b.coa) coa = { ...b.coa };
      else {
        const st = pack.states[b.state];
        const hasState = !!st && typeof st === "object" && !st.removed && !!b.state;
        let kinship = hasState ? 0.25 : 0;
        if (b.capital) kinship += 0.1;
        else if (b.port) kinship -= 0.1;
        if (hasState && b.culture !== st.culture) kinship -= 0.25;
        coa = COA.generate(hasState ? st.coa || null : null, kinship, null, b.type);
      }
      coa.shield = shieldFor(burgCulture(b), b.state || 0, sh);
      set("burg", b, coa);
    }
    for (const p of t.province) {
      if (skip("province", p)) continue;
      let coa;
      if (E.shieldOnly && p.coa) coa = { ...p.coa };
      else {
        const pb = p.burg ? pack.burgs[p.burg] : null;
        const parent = live(pb) ? pb : pack.states[p.state];
        let dominion = false;
        if (!live(pb)) {
          dominion = P(0.2);
          if (p.formName === "Colony") dominion = P(0.95);
          else if (p.formName === "Island") dominion = P(0.6);
          else if (p.formName === "Islands") dominion = P(0.5);
          else if (p.formName === "Territory") dominion = P(0.4);
          else if (p.formName === "Land") dominion = P(0.3);
        }
        const nameByBurg = live(pb) && String(p.name).slice(0, 3) === String(pb.name).slice(0, 3);
        const kinship = dominion ? 0 : nameByBurg ? 0.8 : 0.4;
        coa = COA.generate(parent?.coa || null, kinship, dominion, Burgs.getType(p.center, parent?.port));
      }
      coa.shield = shieldFor(provinceCulture(p), p.state, sh);
      set("province", p, coa);
    }
    counts.out = { states: rows.state.length, provinces: rows.province.length, burgs: rows.burg.length };
    return { rows, counts, shields: sh.fallback, E };
  }

  const EMB_TYPES = [
    ["state", "states"],
    ["province", "provinces"],
    ["burg", "burgs"]
  ];
  const listOf = type => (type === "state" ? pack.states : type === "province" ? pack.provinces : pack.burgs);

  /** Literal emblems outcome; provinces created by the same call are left to the provinces literal. */
  function emblemsLiteral(run, skipProvinces) {
    const out = {
      keepLocked: run.E.keepLocked,
      ...(run.E.lockedStates ? { lockedStates: true } : {}),
      n: { ...run.counts.out }
    };
    for (const [type, key] of EMB_TYPES)
      out[key] = run.rows[type]
        .filter(r => !(type === "province" && skipProvinces.has(r.i)))
        .map(r => ({ ...r, coa: clone(listOf(type)[r.i].coa) }));
    return out;
  }

  /** The entity a literal row means now: by id, or (a province of a state the sketch created) by state and centre. */
  function rowEntity(type, r) {
    if (r.locate && type === "province")
      return pack.provinces.find(p => live(p) && p.state === r.state && p.center === r.center) ?? null;
    const x = listOf(type)[r.i];
    return live(x) ? x : null;
  }

  function checkEmblemsLiteral(L) {
    const errors = [];
    if (!isObj(L)) return { errors: [{ code: "BAD_ARGS", message: "emblems literal is {states, provinces, burgs}" }] };
    for (const [type, key] of EMB_TYPES) {
      const rows = L[key] ?? [];
      if (!Array.isArray(rows)) {
        errors.push({ code: "BAD_ARGS", message: `emblems.${key} must be an array` });
        continue;
      }
      for (const r of rows) {
        if (!isObj(r)) continue;
        const x = rowEntity(type, r);
        if (!x || r.fresh) continue;
        const lockHolds = type === "state" ? L.lockedStates !== true && L.keepLocked !== false : L.keepLocked !== false;
        if (x.lock && !r.locked && lockHolds) {
          errors.push({
            code: "REFUSED",
            message: `${type} '${x.name}' (${x.i}) was locked since; the sketch regenerated its emblem`
          });
          continue;
        }
        if (r.was === undefined) continue;
        const now = coaHash(x.coa);
        if (now !== r.was && now !== coaHash(r.coa))
          errors.push({
            code: "REFUSED",
            message: `both changed the emblem of ${type} '${x.name}' (${x.i}): someone else changed it since the sketch regenerated it`
          });
      }
    }
    return { errors };
  }

  function applyEmblemsLiteral(L, notesOut) {
    const chk = checkEmblemsLiteral(L);
    if (chk.errors.length) fail(chk.errors[0].code, chk.errors[0].message, { details: chk.errors });
    const rows = { state: [], burg: [], province: [] };
    let gone = 0;
    for (const [type, key] of EMB_TYPES)
      for (const r of L[key] ?? []) {
        const x = isObj(r) ? rowEntity(type, r) : null;
        if (!x) {
          gone++;
          continue;
        }
        const row = { i: x.i, was: coaHash(x.coa) };
        if (x.lock) row.locked = true;
        if (type === "province") {
          row.state = x.state;
          row.center = x.center;
        }
        rows[type].push(row);
        x.coa = clone(r.coa);
        removeCoaDef(type, x.i);
      }
    if (gone) notesOut.push(`emblems: ${plural(gone, "entity")} removed since ${gone > 1 ? "were" : "was"} skipped`);
    const n = isObj(L.n) ? L.n : null;
    return {
      rows,
      counts: {
        out: { states: rows.state.length, provinces: n?.provinces ?? rows.province.length, burgs: rows.burg.length },
        kept: { locked: 0, custom: 0 },
        lockedStates: []
      },
      shields: 0,
      E: { keepLocked: L.keepLocked !== false, lockedStates: L.lockedStates === true, shieldOnly: false }
    };
  }

  // ---------------------------------------------------------------- regenerate (wrapped)

  async function redrawLayers(layers) {
    if (!layers.size) return { redrawn: [], skippedHidden: [] };
    // as the app's regenerators: drop every emblem <use>, so turning a hidden emblems layer on
    // later redraws them all (toggleEmblems only draws into an empty layer)
    if (layers.has("emblems")) for (const el of document.querySelectorAll("#emblems use")) el.remove();
    return T.redraw({ layers: [...layers] });
  }

  /**
   * Validate the provinces/emblems options (and with preview, generate the provinces on a copy
   * to report sizes): changes nothing. Node calls this before taking the undo entry, and for a
   * dryRun.
   */
  FNS.regenPlan = async a => {
    const parts = Array.isArray(a.parts) ? sortParts([...new Set(a.parts)]) : [];
    checkOptionParts(a, parts);
    const PP = parts.includes("provinces") ? planProvinces(a.provinces, parts) : null;
    const EE = parts.includes("emblems") ? planEmblems(a.emblems, parts) : null;
    const notesOut = [];
    const out = { parts };
    let run = null;
    if (PP) {
      if (a.preview) {
        run = generateProvinces(PP);
        out.provinces = provincesView(run, notesOut);
        runNotes(run, notesOut, true);
      } else {
        out.provinces = provincesPlanView(PP);
        notesOut.push(...PP.notes);
      }
    }
    if (EE) {
      const counts = emblemsCount(EE, run);
      out.emblems = emblemsResult(counts, EE);
      emblemsNotes(counts, 0, notesOut, true);
    }
    if (notesOut.length) out.notes = notesOut;
    return out;
  };

  FNS.regenerate = async (a, meta) => {
    const parts = Array.isArray(a?.parts) ? [...new Set(a.parts)] : [];
    checkOptionParts(a, parts);
    if (!parts.some(p => LITERAL_PARTS.includes(p))) return baseRegenerate(a, meta);
    // checked up front: a bad option changes nothing
    if (parts.includes("provinces")) planProvinces(a.provinces, parts);
    if (parts.includes("emblems")) planEmblems(a.emblems, parts);
    const { provinces: _p, emblems: _e, phase: _phase, ...rest } = a;
    const order = sortParts(parts);
    const before = FNS.layersOn();
    const ran = [];
    const notesOut = [];
    const layers = new Set();
    const extra = {};
    const runBase = async seg => {
      if (!seg.length) return;
      const out = (await baseRegenerate({ ...rest, parts: seg, restoreLayers: false }, meta)) || {};
      for (const [k, v] of Object.entries(out)) {
        if (k === "ran") ran.push(...(v || []));
        else if (k === "notes") notesOut.push(...(v || []));
        else if (k === "details" && isObj(v)) extra.details = { ...(extra.details || {}), ...v };
        else if (k !== "layerChanges" && k !== "layersOn") extra[k] = v;
      }
      T.resetMemo?.();
    };
    let provRun = null;
    let embRun = null;
    let graph = null;
    await runBase(order.filter(p => BEFORE_PROVINCES.includes(p)));
    if (parts.includes("provinces")) {
      graph = T.cellGraph?.() ?? null;
      // planned again: an earlier part (burgs, states) may have changed the map since validation
      provRun = generateProvinces(planProvinces(a.provinces, parts));
      commitProvinces(provRun);
      runNotes(provRun, notesOut, false);
      for (const l of ["provinces", "borders", "emblems"]) layers.add(l);
      ran.push("provinces");
    }
    await runBase(order.filter(p => BEFORE_EMBLEMS.includes(p)));
    if (parts.includes("emblems")) {
      embRun = runEmblems(planEmblems(a.emblems, parts));
      emblemsNotes(embRun.counts, embRun.shields, notesOut, false);
      layers.add("emblems");
      ran.push("emblems");
      T.resetMemo?.();
    }
    await runBase(
      order.filter(p => !LITERAL_PARTS.includes(p) && !BEFORE_PROVINCES.includes(p) && !BEFORE_EMBLEMS.includes(p))
    );
    const rd = await redrawLayers(layers);
    if (rd.skippedHidden.length)
      notesOut.push(
        `layer${rd.skippedHidden.length > 1 ? "s" : ""} ${rd.skippedHidden.join(", ")} ${rd.skippedHidden.length > 1 ? "are" : "is"} hidden: not redrawn (display {on:[...]} shows ${rd.skippedHidden.length > 1 ? "them" : "it"})`
      );
    const after = FNS.layersOn();
    const turnedOn = after.filter(l => !before.includes(l));
    const turnedOff = before.filter(l => !after.includes(l));
    let restored = false;
    if (a.restoreLayers && (turnedOn.length || turnedOff.length)) {
      await FNS.setLayers({ on: turnedOff, off: turnedOn });
      restored = true;
    }
    await T.settle();
    const out = {
      ...extra,
      ran,
      ...(provRun ? { provinces: provincesView(provRun, notesOut) } : {}),
      ...(embRun ? { emblems: emblemsResult(embRun.counts, embRun.E) } : {}),
      layerChanges: { turnedOn, turnedOff, restored },
      layersOn: FNS.layersOn(),
      notes: notesOut
    };
    // the literal outcome, for the sketch log (Node logs it only when every part is provinces/emblems)
    if (parts.every(p => LITERAL_PARTS.includes(p))) {
      const resolved = { parts: order };
      if (provRun) {
        resolved.provinces = provincesLiteral(provRun);
        if (graph) resolved.graph = graph;
      }
      if (embRun) resolved.emblems = emblemsLiteral(embRun, new Set(provRun ? provRun.made.map(p => p.i) : []));
      out.resolved = resolved;
    }
    return out;
  };

  /**
   * Replay of a literal regenerate outcome (sketch rebase). Args: the resolved form {parts,
   * provinces?, emblems?} (ids already mapped by Node). phase 'validate' returns {errors}:
   * a removed or since-locked target state, provinces someone else changed (fields, cells,
   * emblem), locked or added since, emblems both sides changed or locked since. Otherwise
   * applies: the provinces part replaces the unlocked provinces of its states with the
   * recorded ones (recorded cells still in the state; cells that joined the state since go to
   * the nearest recorded province), the emblems part sets the recorded coats of arms.
   */
  FNS.regenerateLiteral = async a => {
    const parts = Array.isArray(a.parts) ? a.parts : [];
    if (!parts.length || parts.some(p => !LITERAL_PARTS.includes(p)))
      fail("BAD_ARGS", "regenerateLiteral replays parts provinces and emblems only");
    if (parts.includes("provinces") && !isObj(a.provinces)) fail("BAD_ARGS", "the provinces outcome is missing");
    if (parts.includes("emblems") && !isObj(a.emblems)) fail("BAD_ARGS", "the emblems outcome is missing");
    if (a.phase === "validate") {
      const errors = [
        ...(parts.includes("provinces") ? checkProvincesLiteral(a.provinces).errors : []),
        ...(parts.includes("emblems") ? checkEmblemsLiteral(a.emblems).errors : [])
      ];
      return { phase: "validate", errors };
    }
    const notesOut = [];
    const layers = new Set();
    let provRun = null;
    let embRun = null;
    const graph = T.cellGraph?.() ?? null;
    if (parts.includes("provinces")) {
      provRun = applyProvincesLiteral(a.provinces, notesOut);
      foreignNotes(provRun.fx, notesOut, "lost");
      for (const l of ["provinces", "borders", "emblems"]) layers.add(l);
      T.resetMemo?.();
    }
    if (parts.includes("emblems")) {
      embRun = applyEmblemsLiteral(a.emblems, notesOut);
      layers.add("emblems");
    }
    await redrawLayers(layers);
    await T.settle();
    const resolved = { parts: [...parts] };
    if (provRun) {
      resolved.provinces = provincesLiteral(provRun);
      if (graph) resolved.graph = graph;
    }
    if (embRun) resolved.emblems = emblemsLiteral(embRun, new Set());
    return {
      ran: parts,
      ...(provRun ? { provinces: provincesView(provRun, notesOut) } : {}),
      ...(embRun ? { emblems: emblemsResult(embRun.counts, embRun.E) } : {}),
      notes: notesOut,
      resolved
    };
  };
})(globalThis);
