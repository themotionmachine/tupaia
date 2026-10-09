// Tupaia MCP bridge extension 'regen': scoped, lock-aware regeneration of provinces and emblems
// with a literal (replayable) outcome. Injected after bridge.js and bridge-mutations.js (every
// src/bridge-ext/*.js, in name order). Same rules as bridge-mutations.js: app globals by bare
// name at call time, no locals that shadow app globals (emblems, provs, cells, labels, ...),
// every FNS function takes one args object.
//
// FNS.regenerate is wrapped: parts 'provinces' and 'emblems' run here, every other part goes to
// the previous FNS.regenerate, in the order given (Node sorts the parts by REGEN_PARTS).
// phase 'validate' checks the options and mutates nothing. The apply result carries
// `resolved` {parts, graph?, provinces?, emblems?}: the literal outcome (each new province with
// its run-length encoded cells and coa; each regenerated coa) that FNS.regenerateLiteral
// re-applies when a sketch is replayed. A call with any other part records only {parts}.
(root => {
  const T = root.__tupaia;
  if (!T?.fns || typeof T.fns.regenerate !== "function") return;
  const FNS = T.fns;
  const fail = T.fail;
  const hashStr = T.pure.hashStr;
  const baseRegenerate = FNS.regenerate;

  const LITERAL_PARTS = ["provinces", "emblems"];
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
  /** COA.getShield; stateId 0/null means the culture's own shield (a state's own emblem). */
  const shieldOf = (culture, stateId) => COA.getShield(culture, stateId || undefined);
  const cultureType = c => pack.cultures[c]?.type || "Generic";

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

  // ---------------------------------------------------------------- provinces: plan

  const PROV_KEYS = ["states", "centres", "count", "ratio", "keepLocked"];
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
      fail("BAD_ARGS", "provinces is {states?, centres?, count?, ratio?, keepLocked?}");
    const opt = o || {};
    checkKeys(opt, PROV_KEYS, "provinces");
    if ((opt.states !== undefined || opt.centres !== undefined) && parts.some(p => REFS_CHANGING.includes(p)))
      fail(
        "BAD_ARGS",
        `provinces states/centres name states and burgs, but parts ${parts.filter(p => REFS_CHANGING.includes(p)).join(", ")} replace them first; regenerate those in a call of their own`
      );
    if (opt.keepLocked !== undefined && typeof opt.keepLocked !== "boolean")
      fail("BAD_ARGS", "keepLocked must be true or false");
    const keepLocked = opt.keepLocked !== false;
    if (opt.count !== undefined && (!Number.isInteger(opt.count) || opt.count < 1 || opt.count > 100))
      fail("BAD_ARGS", "count must be an integer 1..100");
    if (opt.ratio !== undefined && (typeof opt.ratio !== "number" || !(opt.ratio >= 0 && opt.ratio <= 100)))
      fail("BAD_ARGS", "ratio must be a number 0..100");
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
    else targets = pack.states.filter(s => live(s) && !(keepLocked && s.lock)).map(s => s.i);
    if (keepLocked) {
      const locked = targets.filter(i => pack.states[i].lock);
      if (locked.length)
        fail(
          "REFUSED",
          `${locked.map(stateName).join(", ")} ${locked.length > 1 ? "are" : "is"} locked; unlock with edit state {lock:false} or pass keepLocked:false`
        );
    }
    if (!targets.length) fail("BAD_ARGS", "no unlocked state to regenerate provinces for");
    targets.sort((a, b) => a - b);
    const targetSet = new Set(targets);
    const kept = new Set();
    const replaced = [];
    for (const p of pack.provinces)
      if (live(p) && targetSet.has(p.state)) {
        if (keepLocked && p.lock) kept.add(p.i);
        else replaced.push(p.i);
      }
    for (const c of centres)
      if (kept.has(C.province[c.cell])) {
        const p = pack.provinces[C.province[c.cell]];
        fail(
          "REFUSED",
          `centres[${c.k}]: cell ${c.cell} is in locked province ${p.name} (${p.i}); pick another place or pass keepLocked:false`
        );
      }
    const ratio = opt.ratio ?? provincesRatioInput();
    return { keepLocked, ratio, count: opt.count, centres, targets, kept, replaced };
  }

  function modeOf(plan, sid) {
    if (plan.centres.some(c => c.state === sid)) return "centres";
    return plan.count ? "count" : "auto";
  }

  function provincesPlanView(plan) {
    return {
      keepLocked: plan.keepLocked,
      ...(plan.targets.some(i => modeOf(plan, i) === "auto") ? { ratio: plan.ratio } : {}),
      states: plan.targets.map(i => {
        const mode = modeOf(plan, i);
        const row = { i, name: pack.states[i].name, mode };
        if (mode === "centres") row.centres = plan.centres.filter(c => c.state === i).length;
        if (mode === "count") row.count = plan.count;
        row.replace = plan.replaced.filter(id => pack.provinces[id].state === i).length;
        const keep = [...plan.kept].filter(id => pack.provinces[id].state === i).length;
        if (keep) row.keepLocked = keep;
        return row;
      })
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
  function burgProvinceCoa(b, sid, center, name) {
    const coa = COA.generate(b.coa || null, name === b.name ? 0.8 : 0.4, null, Burgs.getType(center, b.port));
    coa.shield = shieldOf(burgCulture(b), sid);
    return coa;
  }

  /** COA of a province centred on a place without a burg. */
  function placeProvinceCoa(s, center, kinship, dominion) {
    const coa = COA.generate(s.coa || null, kinship, dominion ? 1 : 0, Burgs.getType(center, undefined));
    coa.shield = shieldOf(cellCulture(center), s.i);
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
   * count mode: `count` centres in state s for provinces of about equal area: k-means over the
   * free land cells (seeded at the capital, then farthest points), then each cluster is centred
   * on its biggest burg (the capital's cluster on the capital), or on the cell nearest its
   * middle when it holds no burg.
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
   * Spread province ids from their centres over the free land of state sid by elevation cost
   * (as Provinces.generate, without its growth limit): coastal water is crossed at a high cost,
   * other states' land and locked provinces are not entered.
   */
  function spreadState(sid, seeds, work) {
    const C = pack.cells;
    const n = C.i.length;
    const cost = new Float64Array(n).fill(Infinity);
    const owner = new Uint32Array(n);
    const mine = new Set(seeds.map(x => x.pid));
    const q = new FlatQueue();
    for (const x of seeds) {
      cost[x.center] = 0;
      owner[x.center] = x.pid;
      work[x.center] = x.pid;
      q.push(x.center, 0);
    }
    while (q.length) {
      const d = q.peekValue();
      const e = q.pop();
      if (d > cost[e]) continue;
      for (const x of C.c[e]) {
        if (C.h[x] >= 20) {
          if (C.state[x] !== sid || (work[x] && !mine.has(work[x]))) continue;
        } else if (!C.t[x]) continue;
        const t = d + elevationCost(C.h[x]);
        if (t < cost[x]) {
          cost[x] = t;
          owner[x] = owner[e];
          q.push(x, t);
        }
      }
    }
    for (let c = 0; c < n; c++) if (C.state[c] === sid && C.h[c] >= 20 && !work[c] && owner[c]) work[c] = owner[c];
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
  function autoState(s, own, work, alloc, put, maxGrowth, ratio) {
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
        coa: burgProvinceCoa(b, sid, b.cell, name)
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
      coa.shield = shieldOf(c, sid);
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

  /** count / centres mode for one state: one province per centre, spread over the whole state. */
  function centredState(s, own, work, alloc, put, centres) {
    const pickForm = formPicker(s);
    const made = [];
    for (const ct of centres) {
      const b = ct.burg ? pack.burgs[ct.burg] : null;
      const culture = b ? burgCulture(b) : cellCulture(ct.cell);
      const name = ct.name ?? (b && P(0.5) ? b.name : generatedName(culture));
      const formName = ct.formName ?? pickForm();
      const coa = b ? burgProvinceCoa(b, s.i, ct.cell, name) : placeProvinceCoa(s, ct.cell, 0.4, false);
      made.push(
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
    spreadState(
      s.i,
      made.map(p => ({ center: p.center, pid: p.i })),
      work
    );
    fillLeftovers(own, work, new Set(made.map(p => p.i)));
    return made;
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

  /** work = cells.province with the target states' replaced provinces cleared. */
  function clearedWork(targetSet, kept, replacedSet) {
    const C = pack.cells;
    const work = Uint16Array.from(C.province);
    for (let c = 0; c < work.length; c++) {
      const pid = work[c];
      if (replacedSet.has(pid) || (targetSet.has(C.state[c]) && !kept.has(pid))) work[c] = 0;
    }
    return work;
  }

  /** Write the new provinces, placeholders for the replaced ones, cells and state lists; redraw. */
  function commitProvinces(targets, kept, replaced, made, work) {
    const C = pack.cells;
    const list = pack.provinces;
    for (const id of replaced) {
      list[id] = { i: id, removed: true };
      document.getElementById(`provinceCOA${id}`)?.remove();
      for (const el of document.querySelectorAll(`#provinceEmblems > use[data-i="${id}"]`)) el.remove();
    }
    for (const p of made) list[p.i] = p;
    for (let c = 0; c < work.length; c++) C.province[c] = work[c];
    for (const sid of targets) {
      const s = pack.states[sid];
      s.provinces = [
        ...[...kept].filter(id => list[id].state === sid),
        ...made.filter(p => p.state === sid).map(p => p.i)
      ];
    }
    if (made.length) {
      const poles = getPolesOfInaccessibility(pack, cell => C.province[cell]);
      for (const p of made) p.pole = poles[p.i] || [C.p[p.center][0], C.p[p.center][1]];
    }
    T.resetMemo?.();
  }

  function provinceCells(made) {
    const C = pack.cells;
    const ids = new Map(made.map(p => [p.i, []]));
    for (let c = 0; c < C.province.length; c++) ids.get(C.province[c])?.push(c);
    return ids;
  }

  const IDENT_KEYS = ["name", "fullName", "formName", "color", "center", "burg"];
  const identRow = p => {
    const row = { i: p.i, state: p.state };
    for (const k of IDENT_KEYS) row[k] = p[k] ?? null;
    return row;
  };

  /** Literal outcome of a provinces run (built after any emblems run of the same call). */
  function provincesLiteral(run) {
    const cellsOf = provinceCells(run.made);
    return {
      states: run.targets,
      keepLocked: run.keepLocked,
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

  function provincesView(run, notesOut) {
    const cellsOf = provinceCells(run.made);
    const byState = run.targets.map(sid => {
      const made = run.made.filter(p => p.state === sid);
      const row = { i: sid, name: pack.states[sid].name, mode: run.modes.get(sid) ?? "literal", created: made.length };
      const replaced = run.replacedRows.filter(r => r.state === sid).length;
      if (replaced) row.replaced = replaced;
      const keep = [...run.kept].filter(id => pack.provinces[id].state === sid).length;
      if (keep) row.keptLocked = keep;
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
      out.list = run.made.map(p => ({ i: p.i, name: p.name, state: p.state, cells: cellsOf.get(p.i).length }));
    else notesOut.push(`provinces: ${run.made.length} created; find {type:'province'} lists them`);
    if (run.unassigned)
      notesOut.push(`provinces: ${run.unassigned} land cells of the regenerated states got no province`);
    return out;
  }

  /** Regenerate provinces from a plan. Returns the run record (literal and view built later). */
  function runProvinces(plan) {
    const targetSet = new Set(plan.targets);
    const replacedRows = plan.replaced.map(id => identRow(pack.provinces[id]));
    const work = clearedWork(targetSet, plan.kept, new Set(plan.replaced));
    const by = ownCells(plan.targets, work);
    let next = pack.provinces.length;
    const alloc = () => next++;
    const made = [];
    const put = p => {
      made.push(p);
      return p;
    };
    const maxGrowth = plan.ratio === 100 ? 1000 : gauss(20, 5, 5, 100) * plan.ratio ** 0.5;
    const modes = new Map();
    for (const sid of plan.targets) {
      const s = pack.states[sid];
      const own = by.get(sid);
      const mode = modeOf(plan, sid);
      modes.set(sid, mode);
      if (!own.length) continue;
      if (mode === "auto") autoState(s, own, work, alloc, put, maxGrowth, plan.ratio);
      else {
        const centres =
          mode === "centres"
            ? plan.centres.filter(c => c.state === sid).map(c => ({ ...c }))
            : pickCentres(s, own, plan.count, work);
        centredState(s, own, work, alloc, put, centres);
      }
    }
    made.sort((a, b) => a.i - b.i);
    let unassigned = 0;
    for (const sid of plan.targets) unassigned += by.get(sid).filter(c => !work[c]).length;
    commitProvinces(plan.targets, plan.kept, plan.replaced, made, work);
    return {
      targets: plan.targets,
      keepLocked: plan.keepLocked,
      kept: plan.kept,
      replacedRows,
      made,
      modes,
      unassigned
    };
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
    const targets = [];
    for (const id of L.states) {
      const s = pack.states[id];
      if (!live(s)) err("REMOVED", `state ${id} was removed; the sketch regenerated its provinces`);
      else targets.push(id);
    }
    const targetSet = new Set(targets);
    const kept = new Set();
    const replacedNow = [];
    for (const p of pack.provinces)
      if (live(p) && targetSet.has(p.state)) {
        if (keepLocked && p.lock) kept.add(p.i);
        else replacedNow.push(p.i);
      }
    const rows = new Set();
    for (const r of L.replaced) {
      rows.add(r.i);
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
      if (r.fresh) continue;
      const diff = IDENT_KEYS.filter(k => JSON.stringify(p[k] ?? null) !== JSON.stringify(r[k] ?? null));
      if (diff.length)
        err(
          "REFUSED",
          `${who} was changed since by someone else (${diff.map(k => `${k} ${show(r[k])} -> ${show(p[k])}`).join(", ")}); the sketch replaced it`
        );
    }
    for (const id of replacedNow)
      if (!rows.has(id)) {
        const p = pack.provinces[id];
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
    const targetSet = new Set(chk.targets);
    const replacedRows = chk.replacedNow.map(id => identRow(pack.provinces[id]));
    const work = clearedWork(targetSet, chk.kept, new Set(chk.replacedNow));
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
    // every land cell of each state (a zero array: nothing counts as taken), minus locked provinces
    const by = ownCells(chk.targets, new Uint16Array(work.length));
    let unassigned = 0;
    for (const sid of chk.targets) {
      const own = by.get(sid).filter(c => !chk.kept.has(work[c]));
      unassigned += fillLeftovers(own, work, new Set(made.filter(p => p.state === sid).map(p => p.i)));
    }
    commitProvinces(chk.targets, chk.kept, chk.replacedNow, made, work);
    return {
      targets: chk.targets,
      keepLocked: L.keepLocked !== false,
      kept: chk.kept,
      replacedRows,
      made,
      modes: new Map(),
      unassigned
    };
  }

  // ---------------------------------------------------------------- emblems

  const EMB_KEYS = ["states", "provinces", "burgs", "shieldOnly", "keepLocked"];

  function planEmblems(o, parts) {
    if (o !== undefined && o !== null && !isObj(o))
      fail("BAD_ARGS", "emblems is {states?, provinces?, burgs?, shieldOnly?, keepLocked?}");
    const opt = o || {};
    checkKeys(opt, EMB_KEYS, "emblems");
    for (const k of ["provinces", "burgs", "shieldOnly", "keepLocked"])
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
      keepLocked: opt.keepLocked !== false
    };
  }

  function emblemTargets(E) {
    const inScope = sid => E.stateIds === null || E.stateIds.includes(sid || 0);
    return {
      state: pack.states.filter(s => live(s) && inScope(s.i)),
      burg: E.burgs ? pack.burgs.filter(b => live(b) && inScope(b.state)) : [],
      province: E.provinces ? pack.provinces.filter(p => live(p) && inScope(p.state)) : []
    };
  }

  const skipWhy = (x, E) => (x.coa?.custom ? "custom" : E.keepLocked && x.lock ? "locked" : null);

  function emblemsPlanView(E) {
    const t = emblemTargets(E);
    const count = list => {
      const r = { regenerate: 0, keptLocked: 0, keptCustom: 0 };
      for (const x of list) {
        const why = skipWhy(x, E);
        if (why === "custom") r.keptCustom++;
        else if (why === "locked") r.keptLocked++;
        else r.regenerate++;
      }
      return r;
    };
    return {
      shieldOnly: E.shieldOnly,
      keepLocked: E.keepLocked,
      states: count(t.state),
      provinces: count(t.province),
      burgs: count(t.burg)
    };
  }

  function removeCoaDef(type, i) {
    document.getElementById(`${type}COA${i}`)?.remove();
  }

  /** Regenerate the coats of arms in scope (states, then burgs, then provinces, as the app). */
  function runEmblems(E) {
    const t = emblemTargets(E);
    const rows = { state: [], burg: [], province: [] };
    const kept = { locked: 0, custom: 0 };
    const set = (type, x, coa) => {
      rows[type].push({ i: x.i, was: coaHash(x.coa) });
      x.coa = coa;
      removeCoaDef(type, x.i);
    };
    for (const s of t.state) {
      const why = skipWhy(s, E);
      if (why) {
        kept[why]++;
        continue;
      }
      const culture = stateCulture(s);
      const coa = E.shieldOnly && s.coa ? { ...s.coa } : COA.generate(null, null, null, cultureType(culture));
      coa.shield = shieldOf(culture, null);
      set("state", s, coa);
    }
    for (const b of t.burg) {
      const why = skipWhy(b, E);
      if (why) {
        kept[why]++;
        continue;
      }
      let coa;
      if (E.shieldOnly && b.coa) coa = { ...b.coa };
      else {
        const st = pack.states[b.state];
        const hasState = !!st && typeof st === "object" && !st.removed;
        let kinship = hasState ? 0.25 : 0;
        if (b.capital) kinship += 0.1;
        else if (b.port) kinship -= 0.1;
        if (hasState && b.culture !== st.culture) kinship -= 0.25;
        coa = COA.generate(hasState ? st.coa || null : null, kinship, null, b.type);
      }
      coa.shield = shieldOf(burgCulture(b), b.state || 0);
      set("burg", b, coa);
    }
    for (const p of t.province) {
      const why = skipWhy(p, E);
      if (why) {
        kept[why]++;
        continue;
      }
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
      coa.shield = shieldOf(provinceCulture(p), p.state);
      set("province", p, coa);
    }
    return { rows, kept, shieldOnly: E.shieldOnly };
  }

  const EMB_TYPES = [
    ["state", "states"],
    ["province", "provinces"],
    ["burg", "burgs"]
  ];
  const listOf = type => (type === "state" ? pack.states : type === "province" ? pack.provinces : pack.burgs);

  /** Literal emblems outcome; provinces created by the same call are left to the provinces literal. */
  function emblemsLiteral(run, skipProvinces) {
    const out = {};
    for (const [type, key] of EMB_TYPES)
      out[key] = run.rows[type]
        .filter(r => !(type === "province" && skipProvinces.has(r.i)))
        .map(r => ({ i: r.i, was: r.was, coa: clone(listOf(type)[r.i].coa) }));
    return out;
  }

  function emblemsView(run) {
    return {
      states: run.rows.state.length,
      provinces: run.rows.province.length,
      burgs: run.rows.burg.length,
      ...(run.kept.locked || run.kept.custom ? { kept: run.kept } : {}),
      ...(run.shieldOnly ? { shieldOnly: true } : {})
    };
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
        const x = listOf(type)[r.i];
        if (!live(x) || r.fresh || r.was === undefined) continue;
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
        const x = listOf(type)[r.i];
        if (!live(x)) {
          gone++;
          continue;
        }
        rows[type].push({ i: x.i, was: coaHash(x.coa) });
        x.coa = clone(r.coa);
        removeCoaDef(type, x.i);
      }
    if (gone) notesOut.push(`emblems: ${gone} entities were removed since and were skipped`);
    return { rows, kept: { locked: 0, custom: 0 }, shieldOnly: false };
  }

  // ---------------------------------------------------------------- regenerate (wrapped)

  async function redrawLayers(layers) {
    if (!layers.size) return { redrawn: [], skippedHidden: [] };
    // as the app's regenerators: drop every emblem <use>, so turning a hidden emblems layer on
    // later redraws them all (toggleEmblems only draws into an empty layer)
    if (layers.has("emblems")) for (const el of document.querySelectorAll("#emblems use")) el.remove();
    return T.redraw({ layers: [...layers] });
  }

  FNS.regenerate = async (a, meta) => {
    const parts = Array.isArray(a.parts) ? [...new Set(a.parts)] : [];
    if (!parts.length) fail("BAD_ARGS", "parts must be a non-empty array");
    if (a.provinces !== undefined && !parts.includes("provinces"))
      fail("BAD_ARGS", "provinces options need 'provinces' in parts");
    if (a.emblems !== undefined && !parts.includes("emblems"))
      fail("BAD_ARGS", "emblems options need 'emblems' in parts");
    const PP = parts.includes("provinces") ? planProvinces(a.provinces, parts) : null;
    const EE = parts.includes("emblems") ? planEmblems(a.emblems, parts) : null;
    if (a.phase === "validate") {
      return {
        phase: "validate",
        parts,
        ...(PP ? { provinces: provincesPlanView(PP) } : {}),
        ...(EE ? { emblems: emblemsPlanView(EE) } : {})
      };
    }
    const { phase: _phase, provinces: _p, emblems: _e, ...rest } = a;
    if (!PP && !EE) {
      const out = await baseRegenerate({ ...rest, parts }, meta);
      return { ...out, resolved: { parts } };
    }

    const before = FNS.layersOn();
    const ran = [];
    const notesOut = [];
    const layers = new Set();
    let seg = [];
    const flush = async () => {
      if (!seg.length) return;
      const out = await baseRegenerate({ parts: seg, restoreLayers: false }, meta);
      ran.push(...(out.ran || []));
      notesOut.push(...(out.notes || []));
      seg = [];
      T.resetMemo?.();
    };
    let provRun = null;
    let embRun = null;
    let graph = null;
    for (const part of parts) {
      if (!LITERAL_PARTS.includes(part)) {
        seg.push(part);
        continue;
      }
      await flush();
      if (part === "provinces") {
        graph = T.cellGraph?.() ?? null;
        // planned again: an earlier part (burgs, states) may have changed the map since validation
        provRun = runProvinces(planProvinces(a.provinces, parts));
        for (const l of ["provinces", "borders", "emblems"]) layers.add(l);
      } else {
        embRun = runEmblems(planEmblems(a.emblems, parts));
        layers.add("emblems");
      }
      ran.push(part);
      T.resetMemo?.();
    }
    await flush();
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
    const literalOnly = parts.every(p => LITERAL_PARTS.includes(p));
    const resolved = { parts };
    if (literalOnly) {
      if (provRun) {
        resolved.provinces = provincesLiteral(provRun);
        if (graph) resolved.graph = graph;
      }
      if (embRun) resolved.emblems = emblemsLiteral(embRun, new Set(provRun ? provRun.made.map(p => p.i) : []));
    }
    return {
      ran,
      ...(provRun ? { provinces: provincesView(provRun, notesOut) } : {}),
      ...(embRun ? { emblems: emblemsView(embRun) } : {}),
      layerChanges: { turnedOn, turnedOff, restored },
      layersOn: FNS.layersOn(),
      notes: notesOut,
      resolved
    };
  };

  /**
   * Replay of a literal regenerate outcome (sketch rebase). Args: the resolved form {parts,
   * provinces?, emblems?} (ids already mapped by Node). phase 'validate' returns {errors}:
   * a removed target state, provinces someone else changed or added since, emblems both sides
   * changed. Otherwise applies: the provinces part replaces the unlocked provinces of its states
   * with the recorded ones (recorded cells still in the state; cells that joined the state since
   * go to the nearest recorded province), the emblems part sets the recorded coats of arms.
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
      ...(embRun ? { emblems: emblemsView(embRun) } : {}),
      notes: notesOut,
      resolved
    };
  };
})(globalThis);
