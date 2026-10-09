// Tupaia MCP bridge, part 2: mutations (edit, add, paint, generateMap, regenerate, display).
// Injected right after bridge.js as a second classic init script; it extends __tupaia.fns and
// reuses the core helpers (resolve, place, redraw, internals). Same rules as bridge.js: app
// globals by bare name at call time, no locals that shadow app globals (labels, routes,
// markers, zones, rivers, cells, ...), every FNS function takes one args object.
//
// Batch functions (edit, add, paint) run in two phases called from Node:
//   phase 'validate': resolve every ref and check every value, mutate nothing, return the plan;
//   phase 'apply':    validate again, then apply in order and coalesce the redraws.
// Node takes the auto-undo snapshot between the two (only when validation passed).
(root => {
  const T = root.__tupaia;
  if (!T) return;
  const FNS = T.fns;
  const fail = T.fail;
  const I = T.internals;
  const fold = T.pure.fold;
  const polylineAt = T.pure.polylineAt;

  const rn = (v, d = 2) => {
    const m = 10 ** d;
    return Math.round(v * m) / m;
  };
  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
  const isLive = x => !!x && typeof x === "object" && !x.removed;
  const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

  function errRow(index, ref, e) {
    const row = { index, code: e?.code || "PAGE_ERROR", message: String(e?.message || e) };
    if (ref !== undefined) row.ref = ref;
    if (e?.candidates) row.candidates = e.candidates;
    if (e?.details) row.details = e.details;
    return row;
  }

  function batchContext(a) {
    const req = [];
    const usedCache = {};
    return {
      args: a,
      notes: new Set(),
      claimed: new Set(),
      // hidden: layers drawn directly by an op (not through redraw) that were skipped as hidden
      // drawn: layers an op drew or patched in place itself (a route path, a label), listed in redrawn
      R: {
        add: (layer, ids) => req.push(ids ? { layer, ids } : layer),
        list: req,
        hidden: new Set(),
        drawn: new Set()
      },
      used(type) {
        if (!usedCache[type]) usedCache[type] = new Set(I.liveList(type).map(x => fold(I.nameOf(type, x))));
        return usedCache[type];
      }
    };
  }

  async function finishRedraw(a, R) {
    const direct = [...(R.hidden || [])];
    const drawn = [...(R.drawn || [])].filter(l => !direct.includes(l));
    if (a.redraw === false) return { redrawn: drawn, skippedHidden: direct };
    const layers = Array.isArray(a.redraw) ? a.redraw : R.list;
    if (!layers.length) return { redrawn: drawn, skippedHidden: direct };
    const out = await T.redraw({ layers });
    for (const l of direct) if (!out.skippedHidden.includes(l)) out.skippedHidden.push(l);
    for (const l of drawn) if (!out.redrawn.includes(l)) out.redrawn.push(l);
    return out;
  }

  /** Module-private app helpers exposed by the `tupaia-mcp:` hook in states-editor.ts. */
  async function stateInternals() {
    await lazy.statesEditor();
    const x = root.__tupaiaInternals;
    if (!x || typeof x.adjustProvinces !== "function" || typeof x.stateRemove !== "function")
      fail("PAGE_ERROR", "the states-editor export hook is missing; rebuild dist (CF_BUILD=1 npx vite build)");
    return x;
  }

  /** Rebuild closures exposed by the `tupaia-mcp:` hook in heightmap-editor.js. */
  function heightmapInternals() {
    const x = typeof editHeightmap === "function" ? editHeightmap({ tupaiaExport: true }) : null;
    if (!x || typeof x.restoreRiskedData !== "function")
      fail("PAGE_ERROR", "the heightmap-editor export hook is missing; rebuild dist (CF_BUILD=1 npx vite build)");
    return x;
  }

  // ---------------------------------------------------------------- value checks

  const str = field => v => {
    if (typeof v !== "string") fail("BAD_ARGS", `${field} must be a string`);
    return v;
  };
  const optStr = field => v => {
    if (v !== null && typeof v !== "string") fail("BAD_ARGS", `${field} must be a string or null`);
    return v;
  };
  const num = (field, min, max) => v => {
    if (typeof v !== "number" || !Number.isFinite(v)) fail("BAD_ARGS", `${field} must be a number`);
    if ((min !== undefined && v < min) || (max !== undefined && v > max))
      fail("BAD_ARGS", `${field} must be within ${min ?? "-inf"}..${max ?? "inf"}`);
    return v;
  };
  const bool = field => v => {
    if (typeof v !== "boolean") fail("BAD_ARGS", `${field} must be true or false`);
    return v;
  };
  const colorCheck = field => v => {
    if (typeof v !== "string" || !/^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|url\(#|[a-z]+$)/i.test(v.trim()))
      fail("BAD_ARGS", `${field} must be a CSS colour such as #aa3322`);
    return v.trim();
  };
  const refCheck = type => v => T.resolve(type, v).i;

  // ---------------------------------------------------------------- names

  /** Parse a name value: a string, or {generate:{base}|{culture}|{}}. */
  function nameSpec(v) {
    if (typeof v === "string") {
      if (!v.trim()) fail("BAD_ARGS", "name cannot be empty");
      return { text: v };
    }
    const g = isObj(v) ? v.generate : undefined;
    if (g === true || isObj(g)) {
      const gg = isObj(g) ? g : {};
      if (gg.base !== undefined && gg.culture !== undefined)
        fail("BAD_ARGS", "generate takes base or culture, not both");
      if (gg.base !== undefined) {
        const r = T.resolve("namesbase", gg.base);
        return { gen: { base: r.i, label: `namesbase ${r.name}` } };
      }
      if (gg.culture !== undefined) {
        const r = T.resolve("culture", gg.culture);
        return { gen: { culture: r.i, label: `culture ${r.name}` } };
      }
      return { gen: { label: "its own culture" } };
    }
    return fail(
      "BAD_ARGS",
      "name is a string or {generate:{base:<namesbase>}} | {generate:{culture:<culture>}} | {generate:{}}"
    );
  }

  function entityCulture(type, x) {
    const C = pack.cells;
    switch (type) {
      case "burg":
        return x.culture ?? C.culture[x.cell];
      case "state":
        return x.culture ?? C.culture[x.center];
      case "province":
        return C.culture[x.center];
      case "culture":
        return x.i;
      case "religion":
        return x.culture ?? C.culture[x.center];
      case "river": {
        // the generator names a river after its mouth's culture (Rivers.getName(mouth))
        const land = k => Number.isInteger(k) && k >= 0 && C.h[k] >= 20;
        const c = land(x.mouth) ? x.mouth : (x.cells || []).find(land);
        return c === undefined ? 0 : C.culture[c];
      }
      default:
        return 0;
    }
  }

  /** Generate a name for an entity of `type`, avoiding names already used by that type. */
  function generateName(type, x, gen, used) {
    let base = gen.base;
    const culture = gen.culture ?? (base === undefined ? entityCulture(type, x) : undefined);
    if (base === undefined) base = pack.cultures[culture]?.base ?? 0;
    const make = () =>
      type === "state" || type === "province"
        ? Names.getState(Names.getBaseShort(base), culture ?? 0, base)
        : Names.getBase(base);
    let name = make();
    for (let k = 0; k < 20 && (!name || used.has(fold(name))); k++) name = make();
    used.add(fold(name));
    return name;
  }

  function nameField(type, apply) {
    return {
      isName: true,
      check: v => nameSpec(v),
      get: x => (x ? (x.name ?? null) : null),
      show: p => p.text ?? `(generated from ${p.gen.label})`,
      set: (x, p, c) => apply(x, p.text ?? generateName(type, x, p.gen, c.used(type)), c)
    };
  }

  function placeCheck(v) {
    return T.place(v);
  }

  // ---------------------------------------------------------------- resolved (replayable) forms
  // Every batch apply also returns `resolved`: the concrete form of what it applied, which the
  // sketch ops log stores and replays. Refs are ids, generated names are literal strings, cell
  // selections are literal cell lists, places are {x,y} or {entity:{type, ref:id}, at?} (an
  // entity place keeps following the entity, so a replay can rewrite its id).

  /** Replayable form of a place: entity places keep the (resolved) entity, others become x,y. */
  function literalPlace(input, p) {
    if (isObj(input) && isObj(input.entity)) {
      const r = T.resolve(input.entity.type, input.entity.ref);
      const out = { entity: { type: r.type, ref: r.i } };
      if (input.at !== undefined && input.at !== null) out.at = input.at;
      return out;
    }
    return { x: p.x, y: p.y };
  }

  /** Replayable value of one checked edit/add field after it was applied to x. */
  function literalValue(key, f, v, x, input) {
    // a field whose checked value is a plan (bridge-ext) gives its own literal form
    if (f.literal) return clone(f.literal(v, x, input));
    if (f.isName) return clone(f.get(x));
    if (key === "move") return literalPlace(input, v);
    if (key === "port") return !!v.on;
    return clone(v);
  }

  const TRACKED_TYPES = [
    "burg",
    "state",
    "province",
    "culture",
    "religion",
    "route",
    "marker",
    "zone",
    "label",
    "biome"
  ];

  /** Ids of every entity of the tracked types (to find what one add item created). */
  function idSnapshot() {
    T.resetMemo?.();
    const s = {};
    for (const t of TRACKED_TYPES) {
      s[t] = new Set();
      for (const x of I.rawList(t)) if (x && typeof x === "object") s[t].add(I.idOf(t, x));
    }
    return s;
  }

  /** [{type, i}] of entities that exist now but not in snapshot s; `first` type leads. */
  function createdSince(s, first) {
    T.resetMemo?.();
    const out = [];
    for (const t of TRACKED_TYPES) {
      const ids = [];
      for (const x of I.rawList(t))
        if (x && typeof x === "object" && !x.removed && !s[t].has(I.idOf(t, x))) ids.push(I.idOf(t, x));
      ids.sort((a, b) => (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b))));
      for (const i of ids) out.push({ type: t, i });
    }
    out.sort((a, b) => (a.type === first ? 0 : 1) - (b.type === first ? 0 : 1));
    return out;
  }

  // ---------------------------------------------------------------- port helper

  function portFeatureFor(cell) {
    const C = pack.cells;
    const haven = C.haven?.[cell];
    if (haven) {
      const fid = C.f[haven];
      const feat = pack.features[fid];
      return feat?.type === "lake" && feat.outlet ? (Rivers.resolveLakeDrainFeature?.(fid) ?? fid) : fid;
    }
    return Rivers.resolveDrainFeature?.(cell) || 0;
  }

  function upsertNote(id, name, legend) {
    const n = notes.find(x => x.id === id);
    if (n) {
      if (name !== undefined) n.name = name;
      if (legend !== undefined) n.legend = legend;
      return n;
    }
    const created = { id, name: name ?? id, legend: legend ?? "" };
    notes.push(created);
    return created;
  }

  // ---------------------------------------------------------------- edit fields

  /** Setter that assigns one property and queues a redraw of `layer`. */
  const setAndRedraw = (key, layer) => (x, v, c) => {
    x[key] = v;
    c.R.add(layer);
  };

  const FIELDS = {
    burg: {
      name: nameField("burg", (b, n, c) => {
        b.name = n;
        drawBurgLabel(b);
        c?.R?.drawn?.add("burgLabels");
      }),
      population: {
        check: num("population (people)", 0),
        get: b => I.people(b),
        set: (b, v) => {
          b.population = rn(v / populationRate / urbanization, 4);
        }
      },
      group: {
        check: v => {
          const groups = (options.burgs?.groups || []).map(g => g.name);
          if (!groups.includes(v)) fail("BAD_ARGS", `unknown burg group '${v}'`, { details: groups });
          return v;
        },
        get: b => b.group ?? null,
        set: (b, v) => Burgs.changeGroup(b, v)
      },
      type: { check: str("type"), get: b => b.type ?? null, set: (b, v) => (b.type = v) },
      culture: { check: refCheck("culture"), get: b => b.culture, set: (b, v) => (b.culture = v) },
      lock: { check: bool("lock"), get: b => !!b.lock, set: (b, v) => (b.lock = v) },
      port: {
        check: (v, b) => {
          bool("port")(v);
          if (!v || b.port) return { on: v, feature: b.port || 0 };
          const feature = portFeatureFor(b.cell);
          if (!feature)
            fail("REFUSED", "no navigable water body next to or downstream of this burg; it cannot be a port");
          return { on: true, feature };
        },
        show: p => (p.on ? p.feature : 0),
        get: b => b.port || 0,
        set: (b, p, c) => {
          if (!p.on) {
            b.port = 0;
            document.querySelector(`#anchors [data-id='${b.i}']`)?.remove();
          } else if (!b.port) b.port = p.feature;
          c.R.add("burgIcons");
        }
      },
      move: {
        check: (v, b, c) => {
          const p = placeCheck(v);
          if (pack.cells.h[p.cell] < 20) fail("REFUSED", `cell ${p.cell} is water; a burg must be on land`);
          const other = pack.cells.burg[p.cell];
          if ((other && other !== b.i) || c.claimed.has(p.cell))
            fail("REFUSED", `cell ${p.cell} already holds a burg${other ? ` (${other})` : ""}`);
          if (b.capital && pack.cells.state[p.cell] !== b.state)
            fail("REFUSED", "a capital cannot move into another state; change the capital first");
          c.claimed.add(p.cell);
          return p;
        },
        show: p => ({ x: p.x, y: p.y, cell: p.cell }),
        get: b => ({ x: b.x, y: b.y, cell: b.cell }),
        set: (b, p, c) => {
          if (pack.cells.burg[b.cell] === b.i) pack.cells.burg[b.cell] = 0;
          b.cell = p.cell;
          b.x = p.x;
          b.y = p.y;
          pack.cells.burg[p.cell] = b.i;
          if (!b.capital) b.state = pack.cells.state[p.cell];
          // as the app's burg relocation does (burg-editor.js): a capital carries its state's centre
          if (b.capital && pack.states[b.state]) {
            pack.states[b.state].center = p.cell;
            c.R.add("stateLabels", [b.state]);
          }
          b.feature = pack.cells.f[p.cell];
          drawBurgIcon(b);
          drawBurgLabel(b);
          c.R.add("burgIcons");
          c.notes.add("moved burgs keep their emblem position and route links");
        }
      },
      capital: {
        check: () =>
          fail(
            "BAD_ARGS",
            "set a capital through the state: edit {type:'state', ops:[{ref:<state>, set:{capital:<burg>}}]}"
          )
      }
    },

    state: {
      name: nameField("state", (s, n, c) => {
        s.name = n;
        if (c.set.fullName === undefined) s.fullName = States.getFullName(s);
        c.R.add("stateLabels", [s.i]);
      }),
      fullName: {
        check: str("fullName"),
        get: s => s.fullName ?? null,
        set: (s, v, c) => {
          s.fullName = v;
          c.R.add("stateLabels", [s.i]);
        }
      },
      form: { check: str("form"), get: s => s.form ?? null, set: (s, v) => (s.form = v) },
      formName: {
        check: str("formName"),
        get: s => s.formName ?? null,
        set: (s, v, c) => {
          s.formName = v;
          if (c.set.fullName === undefined) s.fullName = States.getFullName(s);
          c.R.add("stateLabels", [s.i]);
        }
      },
      color: {
        check: colorCheck("color"),
        get: s => s.color ?? null,
        set: (s, v, c) => {
          s.color = v;
          c.R.add("states");
        }
      },
      capital: {
        check: (v, s) => {
          if (!s.i) fail("REFUSED", "Neutrals have no capital");
          const b = T.resolve("burg", v).entity;
          if (b.state !== s.i)
            fail(
              "REFUSED",
              `burg ${b.name} (${b.i}) belongs to ${pack.states[b.state]?.name ?? "Neutrals"}, not ${s.name}; paint or move it into the state first`
            );
          return b.i;
        },
        get: s => s.capital ?? null,
        set: (s, bid, c) => {
          if (s.capital === bid) return;
          const b = pack.burgs[bid];
          const old = pack.burgs[s.capital];
          s.capital = bid;
          s.center = b.cell;
          b.capital = 1;
          Burgs.changeGroup(b, null);
          if (old?.i && old !== b) {
            old.capital = 0;
            Burgs.changeGroup(old, null);
          }
          c.R.add("stateLabels", [s.i]);
        }
      },
      culture: { check: refCheck("culture"), get: s => s.culture ?? null, set: (s, v) => (s.culture = v) },
      lock: { check: bool("lock"), get: s => !!s.lock, set: (s, v) => (s.lock = v) }
    },

    province: {
      name: nameField("province", (p, n, c) => {
        p.name = n;
        if (c.set.fullName === undefined) p.fullName = p.formName ? `${n} ${p.formName}` : n;
        c.R.add("provinces");
      }),
      fullName: {
        check: str("fullName"),
        get: p => p.fullName ?? null,
        set: (p, v, c) => {
          p.fullName = v;
          c.R.add("provinces");
        }
      },
      formName: {
        check: str("formName"),
        get: p => p.formName ?? null,
        set: (p, v, c) => {
          p.formName = v;
          if (c.set.fullName === undefined) p.fullName = `${p.name} ${v}`;
          c.R.add("provinces");
        }
      },
      color: {
        check: colorCheck("color"),
        get: p => p.color ?? null,
        set: (p, v, c) => {
          p.color = v;
          c.R.add("provinces");
        }
      },
      capital: {
        check: (v, p) => {
          const b = T.resolve("burg", v).entity;
          if (pack.cells.province[b.cell] !== p.i)
            fail("REFUSED", `burg ${b.name} (${b.i}) is not inside province ${p.name}`);
          return b.i;
        },
        get: p => p.burg ?? null,
        set: (p, bid, c) => {
          p.burg = bid;
          p.center = pack.burgs[bid].cell;
          c.R.add("provinces");
        }
      },
      lock: { check: bool("lock"), get: p => !!p.lock, set: (p, v) => (p.lock = v) }
    },

    culture: {
      name: nameField("culture", (x, n, c) => {
        x.name = n;
        x.code = abbreviate(
          n,
          pack.cultures.filter(o => o && o.i !== x.i).map(o => o.code)
        );
        c.R.add("cultures");
      }),
      color: {
        check: colorCheck("color"),
        get: x => x.color ?? null,
        set: (x, v, c) => {
          x.color = v;
          c.R.add("cultures");
        }
      },
      type: { check: str("type"), get: x => x.type ?? null, set: (x, v) => (x.type = v) },
      base: { check: refCheck("namesbase"), get: x => x.base ?? null, set: (x, v) => (x.base = v) },
      expansionism: {
        check: num("expansionism", 0, 10),
        get: x => x.expansionism ?? null,
        set: (x, v) => (x.expansionism = v)
      },
      // the culture's coat-of-arms shield shape (emblems of its states, provinces and burgs use it
      // when the emblem shape option is 'culture')
      shield: {
        check: v => {
          const known = shieldNames();
          if (typeof v !== "string" || (known.length && !known.includes(v)))
            fail("BAD_ARGS", `shield must be one of the shield shapes`, { details: known });
          return v;
        },
        get: x => x.shield || null,
        set: (x, v) => (x.shield = v)
      },
      lock: { check: bool("lock"), get: x => !!x.lock, set: (x, v) => (x.lock = v) }
    },

    religion: {
      name: nameField("religion", (x, n, c) => {
        x.name = n;
        x.code = abbreviate(
          n,
          pack.religions.filter(o => o && o.i !== x.i).map(o => o.code)
        );
        c.R.add("religions");
      }),
      color: {
        check: colorCheck("color"),
        get: x => x.color ?? null,
        set: (x, v, c) => {
          x.color = v;
          c.R.add("religions");
        }
      },
      type: { check: str("type"), get: x => x.type ?? null, set: (x, v) => (x.type = v) },
      form: { check: str("form"), get: x => x.form ?? null, set: (x, v) => (x.form = v) },
      deity: { check: optStr("deity"), get: x => x.deity ?? null, set: (x, v) => (x.deity = v) },
      expansionism: {
        check: num("expansionism", 0, 10),
        get: x => x.expansionism ?? null,
        set: (x, v) => (x.expansionism = v)
      },
      lock: { check: bool("lock"), get: x => !!x.lock, set: (x, v) => (x.lock = v) }
    },

    river: {
      name: nameField("river", (r, n, c) => {
        const old = r.name;
        r.name = n;
        // the river's note keeps its own title: follow the rename when the title names the river
        const note = old ? notes.find(x => x.id === `river${r.i}`) : null;
        if (note && typeof note.name === "string" && note.name.includes(old)) {
          note.name = note.name.split(old).join(n);
          c?.notes?.add("a renamed river's note title follows the new name (where it held the old one)");
        } else if (note)
          c?.notes?.add(`river ${r.i}'s note keeps its title '${note.name}' (edit {type:'note'} changes it)`);
      }),
      type: { check: str("type"), get: r => r.type ?? null, set: (r, v) => (r.type = v) }
    },

    route: {
      group: {
        check: v => {
          if (typeof v !== "string" || !document.querySelector(`#routes > g#${CSS.escape(v)}`))
            fail("BAD_ARGS", `unknown route group '${v}'`, {
              details: [...document.querySelectorAll("#routes > g")].map(g => g.id)
            });
          return v;
        },
        get: r => r.group ?? null,
        set: (r, v, c) => {
          r.group = v;
          document.getElementById(`route${r.i}`)?.remove();
          if (layerIsOn("toggleRoutes")) {
            drawRoute(r);
            c.R.drawn?.add("routes");
          } else c.R.hidden.add("routes");
        }
      },
      name: { check: str("name"), get: r => r.name ?? null, set: (r, v) => (r.name = v) },
      lock: { check: bool("lock"), get: r => !!r.lock, set: (r, v) => (r.lock = v) }
    },

    marker: {
      type: { check: str("type"), get: m => m.type ?? null, set: setAndRedraw("type", "markers") },
      icon: { check: str("icon"), get: m => m.icon ?? null, set: setAndRedraw("icon", "markers") },
      size: {
        check: num("size", 1, 200),
        get: m => m.size ?? null,
        set: setAndRedraw("size", "markers")
      },
      pinned: { check: bool("pinned"), get: m => !!m.pinned, set: setAndRedraw("pinned", "markers") },
      lock: { check: bool("lock"), get: m => !!m.lock, set: (m, v) => (m.lock = v) },
      note: {
        check: v => {
          if (!isObj(v) || (v.name === undefined && v.legend === undefined))
            fail("BAD_ARGS", "note is {name?, legend?} (legend is HTML)");
          if (v.name !== undefined) str("note.name")(v.name);
          if (v.legend !== undefined) str("note.legend")(v.legend);
          return v;
        },
        get: m => {
          const n = notes.find(x => x.id === `marker${m.i}`);
          return n ? { name: n.name, legend: n.legend } : null;
        },
        set: (m, v) => upsertNote(`marker${m.i}`, v.name, v.legend)
      },
      move: {
        check: placeCheck,
        show: p => ({ x: p.x, y: p.y, cell: p.cell }),
        get: m => ({ x: m.x, y: m.y, cell: m.cell }),
        set: (m, p, c) => {
          m.x = p.x;
          m.y = p.y;
          m.cell = p.cell;
          c.R.add("markers");
        }
      }
    },

    zone: {
      name: { check: str("name"), get: z => z.name ?? null, set: setAndRedraw("name", "zones") },
      type: { check: str("type"), get: z => z.type ?? null, set: (z, v) => (z.type = v) },
      color: {
        check: colorCheck("color"),
        get: z => z.color ?? null,
        set: setAndRedraw("color", "zones")
      },
      hidden: { check: bool("hidden"), get: z => !!z.hidden, set: setAndRedraw("hidden", "zones") }
    },

    feature: {
      name: { check: str("name"), get: f => f.name ?? null, set: (f, v) => (f.name = v) },
      group: { check: str("group"), get: f => f.group ?? null, set: setAndRedraw("group", "features") }
    },

    note: {
      name: { check: str("name"), get: n => n.name ?? null, set: (n, v) => (n.name = v) },
      legend: { check: str("legend"), get: n => n.legend ?? null, set: (n, v) => (n.legend = v) }
    },

    label: {
      text: {
        check: v => {
          str("text")(v);
          if (!v.trim()) fail("BAD_ARGS", "text cannot be empty ('|' starts a new line)");
          return v;
        },
        get: l => (l.el.textContent || "").trim(),
        set: (l, v, c) => {
          setLabelText(l.el, v);
          c?.R?.drawn?.add("labels");
        }
      },
      move: {
        check: (v, l) => {
          const p = placeCheck(v);
          const path = document.getElementById(`textPath_${l.id}`);
          if (!path || !/^M\s*-?[\d.]+[ ,]-?[\d.]+\s*h\s*-?[\d.]+\s*$/.test(path.getAttribute("d") || ""))
            fail("REFUSED", `label ${l.id} follows a curved path; move it with eval`);
          return p;
        },
        show: p => ({ x: p.x, y: p.y }),
        get: l => {
          const d = document.getElementById(`textPath_${l.id}`)?.getAttribute("d") || "";
          const m = /^M\s*(-?[\d.]+)[ ,](-?[\d.]+)\s*h\s*(-?[\d.]+)/.exec(d);
          return m ? { x: rn(+m[1] + +m[3] / 2), y: rn(+m[2]) } : null;
        },
        set: (l, p, c) => {
          const path = document.getElementById(`textPath_${l.id}`);
          const m = /^M\s*(-?[\d.]+)[ ,](-?[\d.]+)\s*h\s*(-?[\d.]+)/.exec(path.getAttribute("d"));
          const w = +m[3];
          path.setAttribute("d", `M${rn(p.x - w / 2)},${rn(p.y)} h${w}`);
          c?.R?.drawn?.add("labels");
        }
      }
    },

    map: {
      name: {
        isName: true,
        check: v => nameSpec(v),
        get: () => mapName.value,
        show: p => p.text ?? "(generated)",
        set: (_x, p) => {
          if (p.text !== undefined) mapName.value = p.text;
          else Names.getMapName(true);
        }
      },
      populationRate: {
        check: num("populationRate", 1, 100000),
        get: () => populationRate,
        set: (_x, v) => {
          populationRate = v;
          const el = document.getElementById("populationRateInput");
          if (el) el.value = v;
        }
      },
      urbanization: {
        check: num("urbanization", 0.01, 5),
        get: () => urbanization,
        set: (_x, v) => {
          urbanization = v;
          const el = document.getElementById("urbanizationInput");
          if (el) el.value = v;
        }
      },
      year: {
        check: num("year", -100000, 100000),
        get: () => options.year,
        set: (_x, v) => {
          options.year = v;
          yearInput.value = v;
        }
      },
      era: {
        check: str("era"),
        get: () => options.era,
        set: (_x, v) => {
          options.era = v;
          eraInput.value = v;
          options.eraShort = v
            .split(" ")
            .filter(Boolean)
            .map(w => w[0].toUpperCase())
            .join("");
        }
      }
    }
  };

  function setLabelText(el, value) {
    const tp = el.querySelector("textPath");
    if (!tp) {
      el.textContent = value;
      return;
    }
    const lines = String(value).split("|");
    const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (lines.length > 1) {
      const top = (lines.length - 1) / -2;
      tp.innerHTML = lines.map((line, k) => `<tspan x="0" dy="${k ? 1 : top}em">${esc(line)}</tspan>`).join("");
    } else tp.innerHTML = `<tspan x="0">${esc(lines[0])}</tspan>`;
  }

  const NO_REMOVE = {
    province: "province removal is not implemented yet; reassign its cells with paint_cells or use eval",
    culture: "culture removal is not implemented yet; repaint its cells with paint_cells or use eval",
    religion: "religion removal is not implemented yet; repaint its cells with paint_cells or use eval",
    feature: "features (islands, lakes, oceans) cannot be removed; change heights with paint_cells",
    namesbase: "namesbases cannot be removed",
    map: "the map cannot be removed"
  };

  const REMOVE = {
    burg: {
      check: b => {
        if (b.capital)
          fail(
            "REFUSED",
            `${b.name} (${b.i}) is the capital of ${pack.states[b.state]?.name ?? "a state"}; make another burg the capital first (edit {type:'state', set:{capital}})`
          );
        if (pack.markets?.some(m => m.centerBurgId === b.i))
          fail("REFUSED", `${b.name} (${b.i}) is a market centre; remove the market first`);
      },
      apply: (b, c) => {
        Burgs.remove(b.i);
        c.notes.add("routes that touched removed burgs are left in place");
      }
    },
    state: {
      check: s => {
        if (!s.i) fail("REFUSED", "Neutrals cannot be removed");
      },
      apply: (s, c) => {
        // stateRemove expects the emblem element; it is only rendered once the emblems layer was shown
        const coaId = `stateCOA${s.i}`;
        if (!document.getElementById(coaId)) defs.append("g").attr("id", coaId);
        c.internals.stateRemove(s.i);
      }
    },
    marker: {
      apply: m => {
        Markers.deleteMarker(m.i);
        document.getElementById(`marker${m.i}`)?.remove();
      }
    },
    route: { apply: r => Routes.remove(r) },
    river: { apply: r => Rivers.remove(r.i) },
    zone: {
      apply: z => {
        pack.zones = pack.zones.filter(o => o.i !== z.i);
        document.getElementById(`zone${z.i}`)?.remove();
      }
    },
    note: {
      apply: n => {
        const k = notes.indexOf(n);
        if (k >= 0) notes.splice(k, 1);
      }
    },
    label: {
      apply: l => {
        document.getElementById(`textPath_${l.id}`)?.remove();
        l.el.remove();
      }
    }
  };

  // ---------------------------------------------------------------- identity (sketch replay)

  const shortHash = v => {
    const str = String(v ?? "");
    let h = 0x811c9dc5;
    for (let k = 0; k < str.length; k++) {
      h ^= str.charCodeAt(k);
      h = Math.imul(h, 0x01000193);
    }
    return `${str.length}:${(h >>> 0).toString(36)}`;
  };

  /** Route end cells (identity of a route). */
  function routeEnds(r) {
    const pts = Array.isArray(r.points) ? r.points : [];
    if (pts.length) return [pts[0]?.[2] ?? null, pts[pts.length - 1]?.[2] ?? null];
    const cells = Array.isArray(r.cells) ? r.cells : [];
    return cells.length ? [cells[0], cells[cells.length - 1]] : [];
  }

  /**
   * The identifying and main fields of an entity, recorded with each edit/remove op of a sketch.
   * Replay compares them with the target as it is then: ids of markers, routes and zones are
   * reused (max id + 1), and a removal must not drop someone else's later change. Plain values
   * only (no refs to other entities, which the sketch could have created).
   */
  const IDENT = {
    burg: b => ({
      name: b.name ?? null,
      cell: b.cell ?? null,
      population: b.population ?? null,
      type: b.type ?? null,
      capital: !!b.capital,
      port: !!b.port
    }),
    state: s => ({ name: s.name ?? null, fullName: s.fullName ?? null, form: s.form ?? null, color: s.color ?? null }),
    province: p => ({ name: p.name ?? null, fullName: p.fullName ?? null, color: p.color ?? null }),
    culture: x => ({ name: x.name ?? null, color: x.color ?? null }),
    religion: x => ({ name: x.name ?? null, color: x.color ?? null }),
    marker: m => ({ cell: m.cell ?? null, type: m.type ?? null, icon: m.icon ?? null }),
    route: r => ({ group: r.group ?? null, name: r.name ?? null, ends: routeEnds(r) }),
    zone: z => ({ name: z.name ?? null, type: z.type ?? null, cells: shortHash((z.cells || []).join(",")) }),
    river: r => ({ name: r.name ?? null, source: r.source ?? null, mouth: r.mouth ?? null }),
    note: n => ({ name: n.name ?? null, legend: shortHash(n.legend) })
  };

  function identOf(type, x) {
    const f = IDENT[type];
    if (!f || !x || typeof x !== "object") return null;
    try {
      return clone(f(x));
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- edit

  function prepareEditOp(type, op, index, c) {
    if (!isObj(op)) fail("BAD_ARGS", "each op is {ref, set:{...}} or {ref, remove:true}");
    let r;
    if (type === "map") r = { i: null, name: mapName.value, entity: null };
    else r = T.resolve(type, op.ref);
    if (op.remove) {
      if (op.set && Object.keys(op.set).length) fail("BAD_ARGS", "an op either sets fields or removes, not both");
      if (NO_REMOVE[type]) fail("REFUSED", NO_REMOVE[type]);
      // REMOVE[type].takesForce / takesMoveTo: the removal options a type's hooks understand
      if (op.moveTo !== undefined && !REMOVE[type].takesMoveTo)
        fail("BAD_ARGS", `moveTo applies only to removing a routeGroup, not a ${type}`);
      if (op.force !== undefined && !REMOVE[type].takesForce)
        fail("BAD_ARGS", `force applies only to removing a burg or a routeGroup, not a ${type}`);
      // check(entity, batch, op) may return plan info (shown by dryRun, e.g. a forced removal's
      // cascade preview); op carries force/moveTo/newCapital/orphanRoutes
      const info = REMOVE[type].check?.(r.entity, c, op);
      return {
        index,
        ref: op.ref,
        i: r.i,
        name: r.name,
        entity: r.entity,
        remove: true,
        op,
        info: isObj(info) ? info : null,
        ident: identOf(type, r.entity)
      };
    }
    if (!isObj(op.set) || !Object.keys(op.set).length) fail("BAD_ARGS", "op needs set:{...} or remove:true");
    if (op.force !== undefined || op.moveTo !== undefined) fail("BAD_ARGS", "force and moveTo go with remove:true");
    const table = FIELDS[type];
    const fs = [];
    for (const key of Object.keys(op.set)) {
      const f = table[key];
      if (!f) fail("BAD_FIELD", `${type} has no editable field '${key}'`, { details: Object.keys(table) });
      fs.push({ key, f, v: f.check(op.set[key], r.entity, c, op.set) });
    }
    return {
      index,
      ref: op.ref,
      i: r.i,
      name: r.name,
      entity: r.entity,
      set: op.set,
      fs,
      ident: identOf(type, r.entity)
    };
  }

  function planRow(p) {
    const row = { index: p.index, i: p.i, name: p.name };
    if (p.ident) row.ident = p.ident;
    if (p.remove) {
      row.remove = true;
      if (p.info) Object.assign(row, p.info);
      return row;
    }
    row.before = {};
    row.after = {};
    for (const { key, f, v } of p.fs) {
      row.before[key] = clone(f.get(p.entity));
      row.after[key] = clone(f.show ? f.show(v) : v);
    }
    return row;
  }

  function applyEditOp(type, p, c) {
    if (p.remove) {
      // apply(entity, batch, op, info) may return {row, resolved}: extra result fields and the
      // extra fields of the replayable form (a route group's force/moveTo, a burg's newCapital)
      const extra = REMOVE[type].apply(p.entity, c, p.op, p.info) || {};
      return {
        index: p.index,
        i: p.i,
        name: p.name,
        removed: true,
        ...(extra.row || {}),
        _r: { ref: p.i, name: p.name, remove: true, ident: p.ident ?? null, ...(extra.resolved || {}) }
      };
    }
    const before = {};
    for (const { key, f } of p.fs) before[key] = clone(f.get(p.entity));
    // created: entities a field's set() made ({type, i, name?}), e.g. edit river {split}; the
    // resolved op lists them so replay can map their ids (like add's created)
    const cc = Object.assign(Object.create(c), { set: p.set, created: [] });
    for (const { f, v } of p.fs) f.set(p.entity, v, cc);
    const after = {};
    for (const { key, f } of p.fs) after[key] = clone(f.get(p.entity));
    const name = type === "map" ? mapName.value : I.nameOf(type, p.entity);
    const lit = {};
    for (const { key, f, v } of p.fs) lit[key] = literalValue(key, f, v, p.entity, p.set[key]);
    const r = { name: p.name, set: lit, before, after };
    if (type !== "map") r.ref = p.i;
    if (p.ident) r.ident = p.ident;
    const row = { index: p.index, i: p.i, name, before, after, _r: r };
    if (cc.created.length) {
      r.created = cc.created.map(x => ({ type: x.type, i: x.i }));
      row.created = clone(cc.created);
    }
    return row;
  }

  async function runBatch(a, items, prepare, plan, apply, setup) {
    const c = batchContext(a);
    const prepared = [];
    const errors = [];
    items.forEach((item, k) => {
      try {
        prepared.push(prepare(item, k, c));
      } catch (e) {
        errors.push(errRow(k, isObj(item) ? item.ref : undefined, e));
      }
    });
    if (a.phase !== "apply") {
      return { phase: "validate", valid: prepared.length, total: items.length, errors, plan: prepared.map(plan) };
    }
    if (errors.length && !a.continueOnError) fail("BAD_ARGS", "validation failed", { details: errors });
    if (setup) await setup(c, prepared);
    const done = [];
    let aborted = null;
    for (const p of prepared) {
      try {
        done.push(await apply(p, c));
        T.resetMemo?.();
      } catch (e) {
        T.resetMemo?.();
        const row = errRow(p.index, p.ref, e);
        errors.push(row);
        if (!a.continueOnError) {
          aborted = row;
          break;
        }
      }
    }
    const rd = await finishRedraw(a, c.R);
    return { done, errors, aborted, ...rd, notes: [...c.notes] };
  }

  FNS.edit = async a => {
    const type = a.type;
    if (!FIELDS[type]) fail("BAD_TYPE", `edit does not handle '${type}'`, { details: Object.keys(FIELDS) });
    const ops = Array.isArray(a.ops) ? a.ops : [];
    if (!ops.length) fail("BAD_ARGS", "ops must be a non-empty array");
    const out = await runBatch(
      a,
      ops,
      (op, k, c) => prepareEditOp(type, op, k, c),
      planRow,
      (p, c) => applyEditOp(type, p, c),
      async (c, prepared) => {
        if (type === "state" && prepared.some(p => p.remove)) c.internals = await stateInternals();
      }
    );
    if (out.phase) return out;
    const resolved = { type, ops: out.done.map(d => d._r) };
    if (a.redraw !== undefined) resolved.redraw = a.redraw;
    return {
      applied: out.done.map(({ _r, ...row }) => row),
      resolved,
      errors: out.errors,
      aborted: out.aborted,
      redrawn: out.redrawn,
      skippedHidden: out.skippedHidden,
      notes: out.notes
    };
  };

  // ---------------------------------------------------------------- add

  function landPlace(v, what) {
    const p = T.place(v);
    if (pack.cells.h[p.cell] < 20)
      fail("REFUSED", `${what} must be on land; cell ${p.cell} is water (height ${pack.cells.h[p.cell]})`);
    return p;
  }

  /** Check `item` fields against FIELDS[type] (skipping `skip` keys); returns [{key,f,v}]. */
  function checkFields(type, item, pseudo, c, skip) {
    const out = [];
    for (const key of Object.keys(item)) {
      if (skip.includes(key)) continue;
      const f = FIELDS[type][key];
      if (!f)
        fail("BAD_FIELD", `${type} items take no field '${key}'`, { details: [...skip, ...Object.keys(FIELDS[type])] });
      out.push({ key, f, v: f.check(item[key], pseudo, c, item) });
    }
    return out;
  }

  function applyFields(fs, x, c, setObj) {
    const cc = Object.assign(Object.create(c), { set: setObj });
    for (const { f, v } of fs) f.set(x, v, cc);
  }

  const ROUTE_GROUPS = ["roads", "trails", "searoutes"];

  function routeCost(group) {
    const C = pack.cells;
    const d2 = (a, b) => (C.p[a][0] - C.p[b][0]) ** 2 + (C.p[a][1] - C.p[b][1]) ** 2;
    if (group === "searoutes") return (cur, next) => (C.h[next] >= 20 ? Infinity : d2(cur, next));
    return (cur, next) => Routes.getLandPathCost(cur, next);
  }

  function noPathReason(group, s, e) {
    const C = pack.cells;
    if (group === "searoutes") {
      const touches = c => C.h[c] < 20 || C.c[c].some(n => C.h[n] < 20);
      if (!touches(s) || !touches(e)) return "searoutes travel over water; both ends must be water or coastal cells";
      return "no water connection between the two places (separate water bodies, or ice)";
    }
    if (C.h[s] < 20 || C.h[e] < 20) return `${group} travel over land; one end is a water cell`;
    if (C.f[s] !== C.f[e])
      return `${group} travel over land and the two places are on different landmasses (features ${C.f[s]} and ${C.f[e]}); use group 'searoutes' between coastal places`;
    return "no passable land path (glaciers or other impassable cells in between)";
  }

  function pathLength(cellsList) {
    const C = pack.cells;
    let len = 0;
    for (let k = 1; k < cellsList.length; k++) {
      const a = C.p[cellsList[k - 1]];
      const b = C.p[cellsList[k]];
      len += Math.hypot(a[0] - b[0], a[1] - b[1]);
    }
    return len;
  }

  function distanceInfo(px) {
    const unit = document.getElementById("distanceUnitInput")?.value || "km";
    return { px: rn(px, 1), [unit]: rn(px * distanceScale, 1) };
  }

  /** Burgs.add links a new burg to its nearest neighbour with a route (as the app's burg tool does): say so. */
  function addBurgConnected(xy, c) {
    const before = (pack.routes || []).length;
    const id = Burgs.add(xy);
    const made = (pack.routes || []).slice(before).filter(r => r && !r.removed);
    if (made.length) {
      c.notes.add(
        "a new burg is linked to the nearest route by a new route (its row's routes), as the app's burg tool does; edit {type:'route', ops:[{ref, remove:true}]} removes one"
      );
      c.R?.drawn?.add("routes");
    }
    return { id, routes: made.map(r => r.i) };
  }

  const ADD = {
    burg: {
      check(item, c) {
        const p = landPlace(item.at, "a burg");
        if (pack.cells.burg[p.cell] || c.claimed.has(p.cell))
          fail(
            "REFUSED",
            `cell ${p.cell} already holds a burg${pack.cells.burg[p.cell] ? ` (${pack.cells.burg[p.cell]})` : ""}`
          );
        c.claimed.add(p.cell);
        const pseudo = {
          i: -1,
          cell: p.cell,
          port: 0,
          state: pack.cells.state[p.cell],
          culture: pack.cells.culture[p.cell]
        };
        return { p, fs: checkFields("burg", item, pseudo, c, ["at"]) };
      },
      plan: (q, row) => Object.assign(row, { x: q.p.x, y: q.p.y, cell: q.p.cell }),
      apply(q, c, item) {
        const { id, routes } = addBurgConnected([q.p.x, q.p.y], c);
        const b = pack.burgs[id];
        applyFields(q.fs, b, c, item);
        // literal name, population and group: Burgs.add draws them at random
        const lit = { at: literalPlace(item.at, q.p) };
        for (const { key, f, v } of q.fs) lit[key] = literalValue(key, f, v, b, item[key]);
        lit.name = b.name;
        lit.population = I.people(b);
        if (b.group) lit.group = b.group;
        return {
          i: id,
          name: b.name,
          x: rn(b.x),
          y: rn(b.y),
          cell: b.cell,
          state: b.state,
          group: b.group,
          ...(routes.length ? { routes } : {}),
          _r: lit
        };
      }
    },

    state: {
      check(item, c) {
        const C = pack.cells;
        const cap = item.capital ?? item.at;
        if (cap === undefined) fail("BAD_ARGS", "a state needs capital: Place | {burg: ref}");
        let center;
        let burgId = 0;
        let p = null;
        if (isObj(cap) && cap.burg !== undefined) {
          const b = T.resolve("burg", cap.burg).entity;
          if (b.capital) fail("REFUSED", `${b.name} (${b.i}) is already the capital of ${pack.states[b.state]?.name}`);
          center = b.cell;
          burgId = b.i;
        } else {
          p = landPlace(cap, "a state capital");
          center = p.cell;
          const bid = C.burg[center];
          if (bid && pack.burgs[bid].capital)
            fail("REFUSED", `cell ${center} holds ${pack.burgs[bid].name}, already a capital; pick another cell`);
          if (bid) burgId = bid;
        }
        if (c.claimed.has(center)) fail("REFUSED", `cell ${center} is already used by another item`);
        c.claimed.add(center);
        const q = { center, burgId, p };
        if (item.name !== undefined) q.name = nameSpec(item.name);
        if (item.color !== undefined) q.color = colorCheck("color")(item.color);
        if (item.culture !== undefined) q.culture = T.resolve("culture", item.culture).i;
        if (item.form !== undefined) q.form = str("form")(item.form);
        if (item.formName !== undefined) q.formName = str("formName")(item.formName);
        if (item.expand !== undefined) q.expand = bool("expand")(item.expand);
        if (item.capitalName !== undefined) {
          str("capitalName")(item.capitalName);
          if (!item.capitalName.trim()) fail("BAD_ARGS", "capitalName cannot be empty");
          q.capitalName = item.capitalName;
        }
        const STATE_KEYS = ["capital", "at", "name", "color", "culture", "form", "formName", "expand", "capitalName"];
        const extra = Object.keys(item).filter(k => !STATE_KEYS.includes(k));
        if (extra.length)
          fail("BAD_FIELD", `state items take no field '${extra[0]}'`, {
            details: STATE_KEYS.filter(k => k !== "at")
          });
        return q;
      },
      plan: (q, row) =>
        Object.assign(row, {
          center: q.center,
          capitalBurg: q.burgId || "(new burg)",
          name: q.name ? (q.name.text ?? `(generated from ${q.name.gen.label})`) : "(generated)"
        }),
      apply(q, c, item) {
        const C = pack.cells;
        const states = pack.states;
        const burgs = pack.burgs;
        const center = q.center;
        let bid = q.burgId;
        let routes = [];
        if (!bid) {
          ({ id: bid, routes } = addBurgConnected([q.p.x, q.p.y], c));
          // the new capital takes the state's culture (Burgs.add gives it the cell's), and a name in it
          if (q.culture !== undefined && burgs[bid].culture !== q.culture) {
            burgs[bid].culture = q.culture;
            if (!q.capitalName) burgs[bid].name = Names.getCulture(q.culture);
          }
          if (q.capitalName) burgs[bid].name = q.capitalName;
          drawBurgLabel(burgs[bid]);
        }
        const oldState = C.state[center];
        const oldProvince = C.province[center];
        const newState = states.length;
        burgs[bid].capital = 1;
        burgs[bid].state = newState;
        Burgs.changeGroup(burgs[bid], null);
        const culture = q.culture ?? C.culture[center];
        let name;
        if (q.name?.text) name = q.name.text;
        else if (q.name?.gen) name = generateName("state", { culture, center }, q.name.gen, c.used("state"));
        else {
          const basename = center % 5 === 0 ? burgs[bid].name : Names.getCulture(culture);
          name = Names.getState(basename, culture);
        }
        const color = q.color ?? getRandomColor();
        const cultureType = pack.cultures[culture].type;
        const coa = COA.generate(burgs[bid].coa, 0.4, null, cultureType);
        coa.shield = COA.getShield(culture, undefined);
        // diplomacy, as in states-editor.ts addState
        const diplomacy = states.map(s => {
          if (!s.i || s.removed) return "x";
          if (!oldState) {
            s.diplomacy.push("Neutral");
            return "Neutral";
          }
          let rel = states[oldState].diplomacy[s.i];
          if (s.i === oldState) rel = "Enemy";
          else if (rel === "Ally") rel = "Suspicion";
          else if (rel === "Friendly") rel = "Suspicion";
          else if (rel === "Suspicion") rel = "Neutral";
          else if (rel === "Enemy") rel = "Friendly";
          else if (rel === "Rival") rel = "Friendly";
          else if (rel === "Vassal") rel = "Suspicion";
          else if (rel === "Suzerain") rel = "Enemy";
          s.diplomacy.push(rel);
          return rel;
        });
        diplomacy.push("x");
        states[0].diplomacy.push([
          "Independance declaration",
          `${name} declared its independance from ${states[oldState].name}`
        ]);
        C.state[center] = newState;
        C.province[center] = 0;
        states.push({
          i: newState,
          name,
          diplomacy,
          provinces: [],
          color,
          expansionism: 0.5,
          capital: bid,
          type: "Generic",
          center,
          culture,
          military: [],
          alert: 1,
          coa
        });
        States.getPoles();
        States.findNeighbors();
        States.collectStatistics();
        States.defineStateForms([newState]);
        const s = states[newState];
        if (q.form) s.form = q.form;
        if (q.formName) s.formName = q.formName;
        if (q.form || q.formName) s.fullName = States.getFullName(s);
        if (oldProvince) c.internals.adjustProvinces([oldProvince]);
        if (q.expand) {
          States.expandStates();
          Provinces.generate();
          Provinces.getPoles();
          States.getPoles();
          States.collectStatistics();
          c.notes.add("expand:true re-expanded every unlocked state and regenerated provinces");
        }
        COArenderer.add("state", newState, coa, s.pole[0], s.pole[1]);
        c.R.add("states");
        c.R.add("borders");
        c.R.add("provinces");
        c.R.add("stateLabels", [newState]);
        const lit = {
          capital: q.burgId ? { burg: q.burgId } : literalPlace(item.capital ?? item.at, q.p),
          name: s.name,
          color: s.color
        };
        if (!q.burgId) lit.capitalName = burgs[bid].name;
        if (q.culture !== undefined) lit.culture = q.culture;
        if (q.form !== undefined) lit.form = q.form;
        if (q.formName !== undefined) lit.formName = q.formName;
        if (q.expand) lit.expand = true;
        return {
          _r: lit,
          i: newState,
          name: s.name,
          fullName: s.fullName,
          capital: { i: bid, name: burgs[bid].name },
          ...(routes.length ? { routes } : {}),
          center,
          cells: s.cells,
          x: rn(C.p[center][0]),
          y: rn(C.p[center][1])
        };
      }
    },

    marker: {
      check(item, c) {
        const p = T.place(item.at);
        const q = { p };
        const config = Markers.getConfig?.() || [];
        if (item.type !== undefined) str("type")(item.type);
        q.config = item.type !== undefined ? config.find(x => x.type === item.type) || null : null;
        if (item.icon !== undefined) q.icon = str("icon")(item.icon);
        if (item.size !== undefined) q.size = num("size", 1, 200)(item.size);
        if (item.pinned !== undefined) q.pinned = bool("pinned")(item.pinned);
        if (item.note !== undefined) q.note = FIELDS.marker.note.check(item.note);
        const extra = Object.keys(item).filter(k => !["at", "type", "icon", "size", "pinned", "note"].includes(k));
        if (extra.length)
          fail("BAD_FIELD", `marker items take no field '${extra[0]}'`, {
            details: ["at", "type", "icon", "size", "pinned", "note"]
          });
        void c;
        return q;
      },
      plan: (q, row) => Object.assign(row, { x: q.p.x, y: q.p.y, cell: q.p.cell, knownType: !!q.config }),
      apply(q, c, item) {
        const base = { x: q.p.x, y: q.p.y, cell: q.p.cell };
        if (item.type !== undefined) base.type = item.type;
        base.icon = q.icon ?? q.config?.icon ?? "❓";
        let m;
        try {
          m = Markers.add(base);
        } catch (e) {
          c.notes.add(
            `the app's note generator for marker type '${item.type}' failed (${e.message}); the marker was added without its generated note`
          );
          m = pack.markers[pack.markers.length - 1];
        }
        const stored = pack.markers.find(x => x.i === m.i) || m;
        if (q.size !== undefined) stored.size = q.size;
        if (q.pinned !== undefined) stored.pinned = q.pinned;
        if (q.note) upsertNote(`marker${stored.i}`, q.note.name ?? item.type ?? "Marker", q.note.legend);
        c.R.add("markers");
        const n = notes.find(x => x.id === `marker${stored.i}`);
        const lit = { at: literalPlace(item.at, q.p), icon: stored.icon };
        if (item.type !== undefined) lit.type = item.type;
        if (q.size !== undefined) lit.size = q.size;
        if (q.pinned !== undefined) lit.pinned = q.pinned;
        if (n) lit.note = { name: n.name, legend: n.legend ?? "" };
        return {
          _r: lit,
          i: stored.i,
          name: n ? n.name : I.nameOf("marker", stored),
          type: stored.type ?? null,
          x: rn(stored.x),
          y: rn(stored.y),
          cell: stored.cell,
          note: n ? n.id : null
        };
      }
    },

    route: {
      check(item) {
        const group = item.group ?? "roads";
        // roads, trails, searoutes, or a custom #routes group (bridge-ext/routes.js); custom groups pathfind over land
        if (
          typeof group !== "string" ||
          !(ROUTE_GROUPS.includes(group) || document.querySelector(`#routes > g#${CSS.escape(group)}`))
        )
          fail("BAD_ARGS", `unknown route group '${group}'`, {
            details: [...document.querySelectorAll("#routes > g")].map(g => g.id)
          });
        if (!Array.isArray(item.through) || item.through.length < 2)
          fail("BAD_ARGS", "through needs at least 2 places");
        if (item.name !== undefined) str("name")(item.name);
        const extra = Object.keys(item).filter(k => !["through", "group", "name"].includes(k));
        if (extra.length)
          fail("BAD_FIELD", `route items take no field '${extra[0]}'`, { details: ["through", "group", "name"] });
        const places = item.through.map(v => T.place(v));
        const cost = routeCost(group);
        const pathCells = [];
        for (let k = 0; k < places.length - 1; k++) {
          const s = places[k].cell;
          const e = places[k + 1].cell;
          if (s === e) continue;
          const leg = findPath(s, x => x === e, cost);
          if (!leg)
            fail("NO_PATH", `no ${group} path from leg ${k} to ${k + 1}: ${noPathReason(group, s, e)}`, {
              details: { from: places[k], to: places[k + 1] }
            });
          if (pathCells.length) leg.shift();
          pathCells.push(...leg);
        }
        if (pathCells.length < 2) fail("BAD_ARGS", "all places fall into the same cell");
        return { group, places, pathCells, name: item.name, through: item.through };
      },
      plan: (q, row) =>
        Object.assign(row, {
          group: q.group,
          cells: q.pathCells.length,
          length: distanceInfo(pathLength(q.pathCells))
        }),
      apply(q, c) {
        const C = pack.cells;
        const points = Routes.getPoints(q.group, q.pathCells, Routes.preparePointsArray());
        const id = Routes.getNextId();
        const route = { i: id, group: q.group, feature: C.f[q.pathCells[0]], points };
        if (q.name) route.name = q.name;
        pack.routes.push(route);
        const links = C.routes;
        for (let k = 0; k < q.pathCells.length - 1; k++) {
          const a = q.pathCells[k];
          const b = q.pathCells[k + 1];
          if (!links[a]) links[a] = {};
          links[a][b] = id;
          if (!links[b]) links[b] = {};
          links[b][a] = id;
        }
        if (layerIsOn("toggleRoutes")) {
          drawRoute(route);
          c.R.drawn?.add("routes");
        } else c.R.hidden.add("routes");
        const len =
          polylineAt(
            points.map(pt => [pt[0], pt[1]]),
            1
          )?.length ?? 0;
        const ends = [q.pathCells[0], q.pathCells[q.pathCells.length - 1]].map(cell =>
          C.burg[cell] ? { i: C.burg[cell], name: pack.burgs[C.burg[cell]].name } : null
        );
        const lit = { through: q.through.map((v, k) => literalPlace(v, q.places[k])), group: q.group };
        if (q.name) lit.name = q.name;
        return {
          _r: lit,
          i: id,
          name: I.nameOf("route", route),
          group: q.group,
          cells: q.pathCells.length,
          length: distanceInfo(len),
          endBurgs: ends,
          points:
            points.length > 400
              ? `${points.length} points (inspect the route for all)`
              : points.map(pt => [rn(pt[0]), rn(pt[1]), pt[2]])
        };
      }
    },

    zone: {
      check(item, c) {
        const q = {};
        if (item.name !== undefined) q.name = str("name")(item.name);
        if (item.type !== undefined) q.type = str("type")(item.type);
        if (item.color !== undefined) q.color = colorCheck("color")(item.color);
        if (item.cells !== undefined && item.select !== undefined) fail("BAD_ARGS", "pass cells or select, not both");
        if (item.cells !== undefined) q.cells = selectCells({ cells: item.cells });
        else if (item.select !== undefined) q.cells = selectCells(item.select);
        else q.cells = [];
        const extra = Object.keys(item).filter(k => !["name", "type", "color", "cells", "select"].includes(k));
        if (extra.length)
          fail("BAD_FIELD", `zone items take no field '${extra[0]}'`, {
            details: ["name", "type", "color", "cells", "select"]
          });
        void c;
        return q;
      },
      plan: (q, row) => Object.assign(row, { cells: q.cells.length }),
      apply(q, c) {
        const id = pack.zones.length ? Math.max(...pack.zones.map(z => z.i)) + 1 : 0;
        const z = {
          i: id,
          name: q.name ?? "Unknown zone",
          type: q.type ?? "Unknown",
          color: q.color ?? `url(#hatch${id % 42})`,
          cells: q.cells
        };
        pack.zones.push(z);
        c.R.add("zones");
        return {
          i: id,
          name: z.name,
          cells: z.cells.length,
          _r: { name: z.name, type: z.type, color: z.color, cells: z.cells.slice() }
        };
      }
    },

    label: {
      check(item) {
        const p = T.place(item.at);
        FIELDS.label.text.check(item.text);
        if (item.group !== undefined) str("group")(item.group);
        const extra = Object.keys(item).filter(k => !["at", "text", "group"].includes(k));
        if (extra.length)
          fail("BAD_FIELD", `label items take no field '${extra[0]}'`, { details: ["at", "text", "group"] });
        return { p, text: item.text, group: item.group ?? "addedLabels", at: item.at };
      },
      plan: (q, row) => Object.assign(row, { name: q.text, x: q.p.x, y: q.p.y, group: q.group }),
      apply(q) {
        const id = getNextId("label");
        let group = labels.select(`#${CSS.escape(q.group)}`);
        if (!group.size())
          group = labels
            .append("g")
            .attr("id", q.group)
            .attr("fill", "#3e3e4b")
            .attr("opacity", 1)
            .attr("stroke", "#3a3a3a")
            .attr("stroke-width", 0)
            .attr("font-family", "Almendra SC")
            .attr("font-size", 18)
            .attr("data-size", 18)
            .attr("filter", null);
        const probe = group.append("text").attr("x", 0).attr("y", 0).text(q.text.split("|")[0]);
        const width = probe.node().getBBox().width || q.text.length * 8;
        probe.remove();
        group.classed("hidden", false);
        const text = group.append("text").attr("text-rendering", "optimizeSpeed").attr("id", id);
        text
          .append("textPath")
          .attr("text-rendering", "optimizeSpeed")
          .attr("xlink:href", `#textPath_${id}`)
          .attr("startOffset", "50%")
          .attr("font-size", "100%");
        setLabelText(text.node(), q.text);
        defs
          .select("#textPaths")
          .append("path")
          .attr("id", `textPath_${id}`)
          .attr("d", `M${rn(q.p.x - width)},${rn(q.p.y)} h${rn(width * 2)}`);
        return {
          i: id,
          name: q.text,
          x: q.p.x,
          y: q.p.y,
          group: q.group,
          _r: { at: literalPlace(q.at, q.p), text: q.text, group: q.group }
        };
      }
    },

    note: {
      check(item, c) {
        let id = item.id;
        let owner = null;
        if (item.entity !== undefined) {
          if (id !== undefined) fail("BAD_ARGS", "pass id or entity, not both");
          const r = T.resolve(item.entity.type, item.entity.ref);
          const prefix = {
            burg: "burg",
            marker: "marker",
            state: "stateLabel",
            route: "route",
            river: "river",
            province: "province",
            zone: "zone"
          }[r.type];
          if (!prefix)
            fail("BAD_ARGS", `notes attach to burg, marker, state, route, river, province or zone, not ${r.type}`);
          id = `${prefix}${r.i}`;
          owner = { type: r.type, ref: r.i };
        }
        if (typeof id !== "string" || !id)
          fail("BAD_ARGS", "a note needs id (element id such as burg12) or entity:{type,ref}");
        if (notes.some(n => n.id === id) || c.claimed.has(id))
          fail("REFUSED", `note '${id}' exists; change it with edit {type:'note'}`);
        c.claimed.add(id);
        str("name")(item.name);
        if (item.legend !== undefined) str("legend")(item.legend);
        return { id, name: item.name, legend: item.legend ?? "", owner };
      },
      plan: (q, row) => Object.assign(row, { i: q.id, name: q.name }),
      apply(q) {
        notes.push({ id: q.id, name: q.name, legend: q.legend });
        const lit = q.owner ? { entity: q.owner } : { id: q.id };
        lit.name = q.name;
        lit.legend = q.legend;
        return { i: q.id, name: q.name, _r: lit };
      }
    },

    culture: {
      check(item, c) {
        const p = landPlace(item.at, "a culture centre");
        if (pack.cultures.some(x => isLive(x) && x.center === p.cell) || c.claimed.has(p.cell))
          fail("REFUSED", `cell ${p.cell} is already a culture centre`);
        c.claimed.add(p.cell);
        const fs = checkFields("culture", item, { i: -1, center: p.cell }, c, ["at", "expand"]);
        if (item.expand !== undefined) bool("expand")(item.expand);
        return { p, fs, expand: !!item.expand };
      },
      plan: (q, row) => Object.assign(row, { x: q.p.x, y: q.p.y, cell: q.p.cell }),
      apply(q, c, item) {
        Cultures.add(q.p.cell);
        const x = pack.cultures[pack.cultures.length - 1];
        applyFields(q.fs, x, c, item);
        // Cultures.add gives a shield only when the emblem shape option is 'random'; generated
        // cultures always have one (COA.getShield otherwise logs an error and falls back to heater)
        if (!x.shield) x.shield = cultureShield(x);
        if (q.expand) {
          Cultures.expand();
          for (const b of pack.burgs) if (b?.i && !b.removed) b.culture = pack.cells.culture[b.cell];
          c.notes.add("expand:true re-expanded every unlocked culture and updated burg cultures");
        }
        c.R.add("cultures");
        const lit = { at: literalPlace(item.at, q.p), name: x.name, color: x.color };
        if (typeof x.type === "string") lit.type = x.type;
        if (Number.isInteger(x.base)) lit.base = x.base;
        if (typeof x.shield === "string" && x.shield) lit.shield = x.shield;
        if (typeof x.expansionism === "number" && x.expansionism >= 0 && x.expansionism <= 10)
          lit.expansionism = x.expansionism;
        if (q.expand) lit.expand = true;
        return { i: x.i, name: x.name, cell: q.p.cell, x: q.p.x, y: q.p.y, base: x.base, _r: lit };
      }
    },

    religion: {
      check(item, c) {
        const p = landPlace(item.at, "a religion centre");
        if (pack.religions.some(x => isLive(x) && x.center === p.cell) || c.claimed.has(p.cell))
          fail("REFUSED", `cell ${p.cell} is already a religion centre`);
        c.claimed.add(p.cell);
        const fs = checkFields("religion", item, { i: -1, center: p.cell }, c, ["at", "expand"]);
        if (item.expand !== undefined) bool("expand")(item.expand);
        return { p, fs, expand: !!item.expand };
      },
      plan: (q, row) => Object.assign(row, { x: q.p.x, y: q.p.y, cell: q.p.cell }),
      apply(q, c, item) {
        // Religions.add picks type/form/deity at random and can throw for some picks (a null
        // deity name) before it changes anything; retry a few times
        const n0 = pack.religions.length;
        let lastErr = null;
        for (let k = 0; k < 6 && pack.religions.length === n0; k++) {
          try {
            Religions.add(q.p.cell);
          } catch (e) {
            lastErr = e;
          }
        }
        if (pack.religions.length === n0)
          fail("PAGE_ERROR", `the app's religion generator failed: ${lastErr?.message ?? "no religion added"}`);
        const x = pack.religions[pack.religions.length - 1];
        applyFields(q.fs, x, c, item);
        if (q.expand) {
          Religions.recalculate();
          c.notes.add("expand:true recalculated every religion's territory");
        }
        c.R.add("religions");
        const lit = { at: literalPlace(item.at, q.p), name: x.name, color: x.color };
        if (typeof x.type === "string") lit.type = x.type;
        if (typeof x.form === "string") lit.form = x.form;
        if (x.deity === null || typeof x.deity === "string") lit.deity = x.deity;
        if (typeof x.expansionism === "number" && x.expansionism >= 0 && x.expansionism <= 10)
          lit.expansionism = x.expansionism;
        if (q.expand) lit.expand = true;
        return { i: x.i, name: x.name, type: x.type, cell: q.p.cell, x: q.p.x, y: q.p.y, _r: lit };
      }
    }
  };

  /** Every shield shape name COA knows (empty when the emblem module is not loaded). */
  function shieldNames() {
    if (typeof COA === "undefined" || !COA.shields?.types) return [];
    return Object.keys(COA.shields.types).flatMap(t => Object.keys(COA.shields[t] || {}));
  }

  /**
   * A shield for a culture added without one: the default culture of that slot when Cultures.add
   * took one (its first cultures come from the current culture set, in order), else a culture of the
   * same names base, else a random one as the app's 'random' option does.
   */
  function cultureShield(x) {
    try {
      const def = Cultures.getDefault?.()?.[x.i];
      if (def?.shield && def.name === x.name) return def.shield;
    } catch {}
    const same = pack.cultures.find(o => o?.i && o !== x && !o.removed && o.base === x.base && o.shield);
    if (same) return same.shield;
    try {
      return Cultures.getRandomShield();
    } catch {
      return "heater";
    }
  }

  FNS.add = async a => {
    const type = a.type;
    const h = ADD[type];
    if (!h) fail("BAD_TYPE", `add does not handle '${type}'`, { details: Object.keys(ADD) });
    const items = Array.isArray(a.items) ? a.items : [];
    if (!items.length) fail("BAD_ARGS", "items must be a non-empty array");
    // zone items (and types whose handler says literalCells: province, river) keep literal cell
    // lists: record the graph they refer to
    const graph = (type === "zone" || h.literalCells) && a.phase === "apply" ? (T.cellGraph?.() ?? null) : null;
    const out = await runBatch(
      a,
      items,
      (item, k, c) => {
        if (!isObj(item)) fail("BAD_ARGS", "each item is an object");
        return { index: k, item, q: h.check(item, c) };
      },
      p => h.plan(p.q, { index: p.index }),
      async (p, c) => {
        const ids = idSnapshot();
        const row = await h.apply(p.q, c, p.item);
        return { index: p.index, ...row, _created: createdSince(ids, type) };
      },
      async c => {
        if (type === "state") c.internals = await stateInternals();
      }
    );
    if (out.phase) return out;
    const resolved = {
      type,
      items: out.done.map(d => d._r),
      created: out.done.map(d => d._created)
    };
    if (graph) resolved.graph = graph;
    if (a.redraw !== undefined) resolved.redraw = a.redraw;
    return {
      created: out.done.map(({ _r, _created, ...row }) => row),
      resolved,
      errors: out.errors,
      aborted: out.aborted,
      redrawn: out.redrawn,
      skippedHidden: out.skippedHidden,
      notes: out.notes
    };
  };

  // ---------------------------------------------------------------- cell selection

  const MEMBERSHIP = {
    state: "state",
    province: "province",
    culture: "culture",
    religion: "religion",
    feature: "f",
    river: "r",
    biome: "biome"
  };
  const CELL_WHERE = [
    "land",
    "water",
    "hMin",
    "hMax",
    "biome",
    "state",
    "province",
    "culture",
    "religion",
    "feature",
    "burg",
    "river"
  ];

  function biomeId(v) {
    const names = biomesData.name;
    if (typeof v === "number") {
      if (!Number.isInteger(v) || v < 0 || v >= names.length) fail("NOT_FOUND", `no biome ${v}`, { details: names });
      return v;
    }
    const k = names.findIndex(n => fold(n) === fold(v));
    if (k < 0)
      fail("NOT_FOUND", `no biome named '${v}'`, {
        candidates: T.pure.rankCandidates(
          String(v),
          names.map((n, i) => ({ i, name: n }))
        ),
        details: names
      });
    return k;
  }

  function radiusPx(circle) {
    const r = Number(circle.radius);
    if (!(r > 0)) fail("BAD_ARGS", "circle.radius must be positive");
    const unit = circle.unit ?? "px";
    if (unit === "px") return r;
    const mapUnit = document.getElementById("distanceUnitInput")?.value || "km";
    let inMapUnits = r;
    if (unit !== mapUnit) {
      if (unit === "km" && mapUnit === "mi") inMapUnits = r / 1.609344;
      else if (unit === "mi" && mapUnit === "km") inMapUnits = r * 1.609344;
      else fail("BAD_ARGS", `the map's distance unit is '${mapUnit}'; give the radius in px or ${mapUnit}`);
    }
    return inMapUnits / distanceScale;
  }

  function cellWhere(where) {
    if (!isObj(where)) fail("BAD_ARGS", "where is an object");
    for (const k of Object.keys(where))
      if (!CELL_WHERE.includes(k))
        fail(
          "BAD_FIELD",
          `unknown cell filter '${k}' in where; allowed: ${CELL_WHERE.join(", ")} (to leave cells out use select.except)`,
          {
            details: { unknown: k, allowed: CELL_WHERE }
          }
        );
    const C = pack.cells;
    const tests = [];
    if (where.land !== undefined) tests.push(c => C.h[c] >= 20 === !!where.land);
    if (where.water !== undefined) tests.push(c => C.h[c] < 20 === !!where.water);
    if (where.hMin !== undefined) tests.push(c => C.h[c] >= where.hMin);
    if (where.hMax !== undefined) tests.push(c => C.h[c] <= where.hMax);
    if (where.biome !== undefined) {
      const ids = (Array.isArray(where.biome) ? where.biome : [where.biome]).map(biomeId);
      tests.push(c => ids.includes(C.biome[c]));
    }
    for (const k of ["state", "province", "culture", "religion"]) {
      if (where[k] === undefined) continue;
      const ids = (Array.isArray(where[k]) ? where[k] : [where[k]]).map(v => T.resolve(k, v).i);
      tests.push(c => ids.includes(C[k][c]));
    }
    if (where.feature !== undefined) {
      const ids = (Array.isArray(where.feature) ? where.feature : [where.feature]).map(v => T.resolve("feature", v).i);
      tests.push(c => ids.includes(C.f[c]));
    }
    if (where.burg !== undefined) tests.push(c => !!C.burg[c] === !!where.burg);
    if (where.river !== undefined) tests.push(c => !!C.r[c] === !!where.river);
    return c => tests.every(t => t(c));
  }

  const SELECT_KEYS = ["cells", "circle", "polygon", "entity", "buffer", "where", "except"];

  /** Distance from point p to the outline of polygon pts ([[x,y]...], closed). */
  function polygonEdgeDistance(p, pts) {
    let best = Infinity;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k];
      const b = pts[(k + 1) % pts.length];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
      best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)));
    }
    return best;
  }

  /** Grow (px > 0) or shrink (px < 0) a cell set by centre distance to the set's other side. */
  function bufferCells(list, px) {
    const C = pack.cells;
    const inSet = new Uint8Array(C.i.length);
    for (const c of list) inSet[c] = 1;
    const r = Math.abs(px);
    const edge = list.filter(c => C.c[c].some(j => !inSet[j]));
    if (px > 0) {
      const out = new Set(list);
      for (const c of edge) for (const j of findAll(C.p[c][0], C.p[c][1], r)) out.add(j);
      return [...out];
    }
    const drop = new Set();
    for (const c of edge)
      for (const j of C.c[c])
        if (!inSet[j]) for (const k of findAll(C.p[j][0], C.p[j][1], r)) if (inSet[k]) drop.add(k);
    for (const c of edge) drop.add(c);
    return list.filter(c => !drop.has(c));
  }

  /**
   * Pack cell ids for a selection {cells?, circle?, polygon?, entity?, buffer?, where?, except?}:
   * the union of the shapes, grown/shrunk by buffer px, filtered by where, minus the cells of
   * except (a selection of its own). Unknown keys are refused, so a typo never widens a paint.
   */
  function selectCells(sel) {
    if (!isObj(sel)) fail("BAD_ARGS", "select is {cells?, circle?, polygon?, entity?, buffer?, where?, except?}");
    for (const k of Object.keys(sel))
      if (!SELECT_KEYS.includes(k))
        fail("BAD_FIELD", `select does not take '${k}'; allowed: ${SELECT_KEYS.join(", ")}`, {
          details: { unknown: k, allowed: SELECT_KEYS }
        });
    for (const [k, allowed] of [
      ["circle", ["at", "radius", "unit"]],
      ["entity", ["type", "ref"]]
    ])
      if (isObj(sel[k]))
        for (const x of Object.keys(sel[k]))
          if (!allowed.includes(x))
            fail("BAD_FIELD", `select.${k} does not take '${x}'; allowed: ${allowed.join(", ")}`, {
              details: { unknown: x, allowed }
            });
    const C = pack.cells;
    const n = C.i.length;
    let set = null;
    const add = list => {
      set = set || new Set();
      for (const c of list) set.add(c);
    };
    if (sel.cells !== undefined) {
      if (!Array.isArray(sel.cells)) fail("BAD_ARGS", "cells is an array of cell ids");
      for (const c of sel.cells)
        if (!Number.isInteger(c) || c < 0 || c >= n) fail("OUT_OF_BOUNDS", `cell ${c} is outside 0..${n - 1}`);
      add(sel.cells);
    }
    // a positive buffer grows a circle or polygon exactly (every cell whose centre lies within
    // buffer px of the shape: a polygon holding few cells still grows by the full buffer); the
    // cells and entity parts grow from their edge cells (bufferCells)
    const grow = typeof sel.buffer === "number" && Number.isFinite(sel.buffer) && sel.buffer > 0 ? sel.buffer : 0;
    let exact = null;
    if (sel.circle !== undefined) {
      if (!isObj(sel.circle)) fail("BAD_ARGS", "circle is {at: Place, radius, unit?:'px'|'km'|'mi'}");
      const p = T.place(sel.circle.at);
      const r = radiusPx(sel.circle);
      if (grow) {
        exact = exact || new Set();
        exact.add(p.cell);
        for (const c of findAll(p.x, p.y, r + grow)) exact.add(c);
      } else add([p.cell, ...findAll(p.x, p.y, r)]);
    }
    if (sel.polygon !== undefined) {
      if (!Array.isArray(sel.polygon) || sel.polygon.length < 3) fail("BAD_ARGS", "polygon needs at least 3 places");
      const pts = sel.polygon.map(v => {
        const p = T.place(v);
        return [p.x, p.y];
      });
      const inside = [];
      for (let c = 0; c < n; c++)
        if (d3.polygonContains(pts, C.p[c]) || (grow && polygonEdgeDistance(C.p[c], pts) <= grow)) inside.push(c);
      if (grow) {
        exact = exact || new Set();
        for (const c of inside) exact.add(c);
      } else add(inside);
    }
    if (sel.entity !== undefined) {
      if (!isObj(sel.entity)) fail("BAD_ARGS", "entity is {type, ref}");
      const r = T.resolve(sel.entity.type, sel.entity.ref);
      if (MEMBERSHIP[r.type]) add(I.cellsWhere(MEMBERSHIP[r.type], r.i));
      else if (r.type === "zone") add(r.entity.cells || []);
      else if (r.type === "burg" || r.type === "marker") add([r.entity.cell]);
      else if (r.type === "route") add((r.entity.points || []).map(p => p[2]).filter(c => c >= 0));
      else fail("BAD_ARGS", `cannot select cells by ${r.type}`);
    }
    let out;
    if (set || exact) out = set ? [...set] : [];
    else if (sel.where !== undefined) out = Array.from(C.i);
    else fail("BAD_ARGS", "select needs cells, circle, polygon, entity or where");
    if (sel.buffer !== undefined && sel.buffer !== 0) {
      if (typeof sel.buffer !== "number" || !Number.isFinite(sel.buffer) || Math.abs(sel.buffer) > 5000)
        fail("BAD_ARGS", "select.buffer is map px between -5000 and 5000 (> 0 grows the shapes, < 0 shrinks them)");
      if (!set && !exact) fail("BAD_ARGS", "select.buffer needs cells, circle, polygon or entity to grow");
      if (set) out = bufferCells(out, sel.buffer);
      if (exact) out = [...new Set([...out, ...exact])];
    }
    if (sel.where !== undefined) {
      const test = cellWhere(sel.where);
      out = out.filter(test);
    }
    if (sel.except !== undefined && sel.except !== null) {
      const minus = new Set(selectCells(sel.except));
      out = out.filter(c => !minus.has(c));
    }
    return out.sort((a, b) => a - b);
  }
  FNS.selectCells = a => {
    const list = selectCells(a.select || a);
    return { count: list.length, cells: list.slice(0, a.limit ?? 2000) };
  };

  // ---------------------------------------------------------------- paint

  const PAINT_KEYS = ["state", "province", "culture", "religion", "biome", "zone", "height"];

  function prepareHeight(h) {
    if (!isObj(h)) fail("BAD_ARGS", "height is {value|delta|smooth, rebuild:'keep'|'risk'|'erase'}");
    const HEIGHT_KEYS = ["value", "delta", "smooth", "rebuild", "clamp", "erosion", "confirmErase", "biomes"];
    for (const k of Object.keys(h))
      if (!HEIGHT_KEYS.includes(k))
        fail("BAD_FIELD", `height does not take '${k}'; allowed: ${HEIGHT_KEYS.join(", ")}`, {
          details: { unknown: k, allowed: HEIGHT_KEYS }
        });
    const modes = ["value", "delta", "smooth"].filter(k => h[k] !== undefined);
    if (modes.length !== 1) fail("BAD_ARGS", "height takes exactly one of value, delta, smooth");
    const rebuild = h.rebuild ?? "keep";
    if (!["keep", "risk", "erase"].includes(rebuild)) fail("BAD_ARGS", "rebuild is 'keep', 'risk' or 'erase'");
    if (rebuild === "erase" && h.confirmErase !== true)
      fail(
        "REFUSED",
        "rebuild:'erase' regenerates every state, burg, culture, religion and province; pass confirmErase:true if that is intended"
      );
    if (h.value !== undefined) num("height.value", 0, 100)(h.value);
    if (h.delta !== undefined) num("height.delta", -100, 100)(h.delta);
    if (h.smooth !== undefined) num("height.smooth", 1, 10)(h.smooth);
    if (h.clamp !== undefined) bool("height.clamp")(h.clamp);
    if (h.erosion !== undefined) bool("height.erosion")(h.erosion);
    if (h.biomes !== undefined && !["redefine", "keep"].includes(h.biomes))
      fail(
        "BAD_ARGS",
        "height.biomes is 'redefine' (default: the changed cells' biomes follow their new climate) or 'keep'"
      );
    if (h.biomes !== undefined && rebuild !== "keep")
      fail("BAD_ARGS", "height.biomes goes with rebuild:'keep' (risk and erase recompute every biome)");
    return { ...h, rebuild };
  }

  function preparePaint(a) {
    const set = a.set;
    if (!isObj(set) || !Object.keys(set).length) fail("BAD_ARGS", `set needs one or more of ${PAINT_KEYS.join(", ")}`);
    for (const k of Object.keys(set))
      if (!PAINT_KEYS.includes(k))
        fail("BAD_FIELD", `cannot paint '${k}'; set takes: ${PAINT_KEYS.join(", ")}`, {
          details: { unknown: k, allowed: PAINT_KEYS }
        });
    if (set.height !== undefined && Object.keys(set).length > 1)
      fail("BAD_ARGS", "paint height in its own call: rebuilding the heightmap renumbers cells");
    const cellsSel = selectCells(a.select);
    const P = { cells: cellsSel };
    if (set.state !== undefined) P.state = T.resolve("state", set.state).i;
    if (set.province !== undefined) P.province = T.resolve("province", set.province).i;
    if (set.culture !== undefined) P.culture = T.resolve("culture", set.culture).i;
    if (set.religion !== undefined) P.religion = T.resolve("religion", set.religion).i;
    if (set.biome !== undefined) P.biome = biomeId(set.biome);
    if (set.zone !== undefined) {
      const z = isObj(set.zone) && set.zone.ref !== undefined ? set.zone : { ref: set.zone };
      const op = z.op ?? "add";
      if (!["add", "remove"].includes(op)) fail("BAD_ARGS", "zone.op is 'add' or 'remove'");
      P.zone = { i: T.resolve("zone", z.ref).i, op };
    }
    if (set.height !== undefined) P.height = prepareHeight(set.height);
    return P;
  }

  function nameFor(type, id) {
    const x = I.byId(type, id);
    return x && typeof x === "object" ? `${I.nameOf(type, x)} (${id})` : `${type} ${id}`;
  }

  /** One territorial key; `write` false only counts. */
  function paintTerritory(key, target, cellsSel, write, info) {
    const C = pack.cells;
    const arr = C[key];
    const by = {};
    const skipped = {};
    const skip = why => {
      skipped[why] = (skipped[why] || 0) + 1;
    };
    const changedCells = [];
    const burgs = [];
    const prov = key === "province" ? pack.provinces[target] : null;
    for (const c of cellsSel) {
      if (C.h[c] < 20) {
        skip("water");
        continue;
      }
      const old = arr[c];
      if (old === target) {
        skip("unchanged");
        continue;
      }
      if (key === "state") {
        if (c === pack.states[old]?.center) {
          skip("stateCenter");
          continue;
        }
        if (C.burg[c] && pack.burgs[C.burg[c]].capital) {
          skip("capital");
          continue;
        }
      }
      if (key === "province") {
        if (!C.state[c] || C.state[c] !== prov.state) {
          skip("otherState");
          continue;
        }
        if (old && c === pack.provinces[old]?.center) {
          skip("provinceCenter");
          continue;
        }
      }
      const label = nameFor(key, old);
      by[label] = (by[label] || 0) + 1;
      changedCells.push(c);
      if (!write) continue;
      if (key === "state") {
        info.affectedStates.add(old);
        info.affectedStates.add(target);
        info.affectedProvinces.add(C.province[c]);
      }
      arr[c] = target;
      if (C.burg[c] && (key === "state" || key === "culture")) {
        const b = pack.burgs[C.burg[c]];
        b[key] = target;
        burgs.push({ i: b.i, name: b.name });
      }
    }
    return { changed: changedCells.length, byPrevious: by, skipped, burgsReassigned: burgs };
  }

  function provinceShape() {
    return pack.provinces.map(p => (isLive(p) && p.i ? { state: p.state } : null));
  }

  async function paintApply(P, write, c) {
    const out = {};
    const C = pack.cells;
    for (const key of ["state", "province", "culture", "religion"]) {
      if (P[key] === undefined) continue;
      const info = { affectedStates: new Set(), affectedProvinces: new Set() };
      const provBefore = write && key === "state" ? provinceShape() : null;
      const r = paintTerritory(key, P[key], P.cells, write, info);
      out[key] = { to: nameFor(key, P[key]), ...r };
      if (!write || !r.changed) continue;
      if (key === "state") {
        States.collectStatistics();
        States.getPoles();
        c.internals.adjustProvinces([...info.affectedProvinces]);
        Provinces.getPoles?.();
        const after = provinceShape();
        const adj = { changedOwner: [], removed: [], created: [] };
        for (let k = 0; k < after.length; k++) {
          const b = provBefore[k];
          const x = after[k];
          if (b && !x) adj.removed.push(k);
          else if (!b && x) adj.created.push(k);
          else if (b && x && b.state !== x.state) adj.changedOwner.push(k);
        }
        out.state.provincesAdjusted = adj;
        c.R.add("states");
        c.R.add("borders");
        c.R.add("provinces");
        c.R.add(
          "stateLabels",
          [...info.affectedStates].filter(s => s > 0)
        );
      } else if (key === "province") {
        Provinces.getPoles?.();
        c.R.add("borders");
        c.R.add("provinces");
      } else if (key === "culture") c.R.add("cultures");
      else c.R.add("religions");
    }
    if (P.biome !== undefined) {
      let changed = 0;
      let water = 0;
      const by = {};
      for (const cell of P.cells) {
        if (C.h[cell] < 20) {
          water++;
          continue;
        }
        if (C.biome[cell] === P.biome) continue;
        const nm = biomesData.name[C.biome[cell]];
        by[nm] = (by[nm] || 0) + 1;
        changed++;
        if (write) C.biome[cell] = P.biome;
      }
      out.biome = { to: biomesData.name[P.biome], changed, byPrevious: by, skipped: { water } };
      if (write && changed) c.R.add("biomes");
    }
    if (P.zone !== undefined) {
      const z = I.byId("zone", P.zone.i);
      const has = new Set(z.cells || []);
      let changed = 0;
      for (const cell of P.cells) if (P.zone.op === "add" ? !has.has(cell) : has.has(cell)) changed++;
      if (write && changed) {
        if (P.zone.op === "add") z.cells = [...new Set([...(z.cells || []), ...P.cells])];
        else {
          const rm = new Set(P.cells);
          z.cells = (z.cells || []).filter(cell => !rm.has(cell));
        }
        c.R.add("zones");
      }
      out.zone = {
        zone: nameFor("zone", P.zone.i),
        op: P.zone.op,
        changed,
        cellsNow: write ? z.cells.length : undefined
      };
    }
    if (P.height !== undefined) out.height = await paintHeight(P.height, P.cells, write, c);
    return out;
  }

  function featureSummary() {
    let lakes = 0;
    let islands = 0;
    let oceans = 0;
    for (const f of pack.features || []) {
      if (!f || typeof f !== "object") continue;
      if (f.type === "lake") lakes++;
      else if (f.type === "island") islands++;
      else if (f.type === "ocean") oceans++;
    }
    return {
      features: pack.features.length - 1,
      lakes,
      islands,
      oceans,
      landCells: pack.cells.h.filter(v => v >= 20).length,
      cells: pack.cells.i.length
    };
  }

  // grid ids of each river's cells, source and mouth (-1 kept), for rebuild:'risk' without erosion
  function saveRiversAsGrid() {
    const g = pack.cells.g;
    const toG = x => (x === -1 || x === undefined || x === null ? x : g[x]);
    return (pack.rivers || []).map(r => ({
      i: r.i,
      cells: Array.isArray(r.cells) ? r.cells.map(toG) : null,
      source: toG(r.source),
      mouth: toG(r.mouth)
    }));
  }

  function restoreRiversFromGrid(saved) {
    const first = new Map();
    for (const i of pack.cells.i) {
      const g = pack.cells.g[i];
      if (!first.has(g)) first.set(g, i);
    }
    const toP = x => (x === -1 || x === undefined || x === null ? x : first.get(x));
    const byId = new Map(saved.map(s => [s.i, s]));
    const kept = [];
    let dropped = 0;
    for (const r of pack.rivers || []) {
      const s = byId.get(r.i);
      if (!s?.cells) {
        kept.push(r);
        continue;
      }
      const cells = [];
      const points = [];
      const hasPoints = Array.isArray(r.points) && r.points.length === s.cells.length;
      s.cells.forEach((gc, j) => {
        const pc = toP(gc);
        if (pc === undefined) return;
        if (cells.length && cells[cells.length - 1] === pc) return;
        cells.push(pc);
        if (hasPoints) points.push(r.points[j]);
      });
      if (cells.filter(x => x !== -1).length < 2) {
        dropped++;
        continue;
      }
      r.cells = cells;
      if (hasPoints) r.points = points;
      else delete r.points;
      const src = toP(s.source);
      const mouth = toP(s.mouth);
      r.source = src === undefined ? cells[0] : src;
      r.mouth = mouth === undefined ? cells.filter(x => x !== -1).at(-1) : mouth;
      kept.push(r);
    }
    if (dropped) {
      const keptIds = new Set(kept.map(r => r.i));
      for (const i of pack.cells.i) if (pack.cells.r[i] && !keptIds.has(pack.cells.r[i])) pack.cells.r[i] = 0;
    }
    pack.rivers = kept;
    return dropped;
  }

  // the drawn coastline, lakes and ocean layers refer to the old features; a risk rebuild redraws them
  function clearFeatureShapes() {
    defs.selectAll("#land, #water").selectAll("path").remove();
    defs.select("#featurePaths").selectAll("path").remove();
    viewbox.selectAll("#coastline use, #lakes path, #oceanLayers path").remove();
  }

  // ---- carrying data over a heightmap rebuild. restoreRiskedData re-packs the cells (reGraph)
  // and keeps burgs, states, cultures, provinces and zones, but leaves route points and links,
  // marker cells, religion centres, capital-less state centres, regiments and burg ports on the
  // old cell/feature numbering, renames every lake, and (when rivers are regenerated) gives every
  // river a new id and name. These helpers carry all of that over: cells by grid cell + position,
  // features and rivers by overlap. Shared by paint_cells height rebuild:'risk' and set_heights.

  /** Each river's id, name, type and grid cells (call before the rivers are regenerated). */
  function captureRivers() {
    const g = pack.cells.g;
    return (pack.rivers || [])
      .filter(r => r?.i)
      .map(r => ({
        i: r.i,
        name: r.name,
        type: r.type,
        grid: [...new Set((r.cells || []).filter(x => x >= 0).map(x => g[x]))]
      }));
  }

  /** What a risk rebuild needs from the old pack (call before restoreRiskedData). */
  function captureCells() {
    const C = pack.cells;
    const n = C.i.length;
    const p = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      p[2 * i] = C.p[i][0];
      p[2 * i + 1] = C.p[i][1];
    }
    return {
      n,
      g: Uint32Array.from(C.g),
      p,
      h: Uint8Array.from(C.h),
      f: Uint32Array.from(C.f),
      biome: Uint8Array.from(C.biome),
      features: (pack.features || []).map(f => (f && typeof f === "object" ? { type: f.type, name: f.name } : null)),
      stateCenters: (pack.states || []).map(s => s?.center),
      burgCells: (pack.burgs || []).map(b => b?.cell),
      rivers: captureRivers()
    };
  }

  /** Old pack cell -> new pack cell: the new cell on the same grid cell nearest the old centre. */
  function cellRemap(old) {
    const C = pack.cells;
    const byGrid = new Map();
    for (const i of C.i) {
      const l = byGrid.get(C.g[i]);
      if (l) l.push(i);
      else byGrid.set(C.g[i], [i]);
    }
    const memo = new Map();
    return o => {
      if (!Number.isInteger(o) || o < 0 || o >= old.n) return o;
      let v = memo.get(o);
      if (v !== undefined) return v;
      const x = old.p[2 * o];
      const y = old.p[2 * o + 1];
      const cand = byGrid.get(old.g[o]);
      if (cand) {
        let bd = Infinity;
        for (const i of cand) {
          const d = (C.p[i][0] - x) ** 2 + (C.p[i][1] - y) ** 2;
          if (d < bd) {
            bd = d;
            v = i;
          }
        }
      } else v = findCell(x, y); // the grid cell left the pack (deep ocean now)
      memo.set(o, v);
      return v;
    };
  }

  /** Greedy one-to-one matching of [score, a, b] pairs, best first (ties by ids: deterministic). */
  function matchPairs(pairs) {
    pairs.sort((x, y) => y[0] - x[0] || x[1] - y[1] || x[2] - y[2]);
    const ab = new Map();
    const used = new Set();
    for (const [, a, b] of pairs) {
      if (ab.has(a) || used.has(b)) continue;
      ab.set(a, b);
      used.add(b);
    }
    return ab;
  }

  /** New features matched to old ones of the same type by shared grid cells; names carried. */
  function carryFeatures(old) {
    const C = pack.cells;
    const oldOfGrid = new Int32Array(grid.cells.i.length).fill(-1);
    for (let i = 0; i < old.n; i++) if (oldOfGrid[old.g[i]] < 0) oldOfGrid[old.g[i]] = old.f[i];
    const count = new Map();
    for (const i of C.i) {
      const o = oldOfGrid[C.g[i]];
      if (o < 0) continue;
      const key = C.f[i] * 65536 + o;
      count.set(key, (count.get(key) || 0) + 1);
    }
    const pairs = [];
    for (const [key, v] of count) {
      const nf = Math.floor(key / 65536);
      const o = key % 65536;
      if (pack.features[nf]?.type && pack.features[nf].type === old.features[o]?.type) pairs.push([v, nf, o]);
    }
    const newToOld = matchPairs(pairs);
    const oldToNew = new Map();
    let named = 0;
    for (const [nf, o] of newToOld) {
      oldToNew.set(o, nf);
      const nm = old.features[o].name;
      if (nm && pack.features[nf].name !== nm) {
        pack.features[nf].name = nm;
        named++;
      }
    }
    return { oldToNew, named };
  }

  /**
   * Regenerated rivers matched to the old ones by course (shared grid cells); a matched river
   * takes the old one's id, name and type, so notes and later references stay on it. Unmatched
   * new rivers get ids above every old id (an id never moves to another river).
   */
  function carryRivers(saved) {
    const C = pack.cells;
    const riverList = pack.rivers || [];
    const byGrid = new Map();
    saved.forEach((r, k) => {
      for (const g of r.grid) {
        const l = byGrid.get(g);
        if (l) l.push(k);
        else byGrid.set(g, [k]);
      }
    });
    const pairs = [];
    riverList.forEach((r, j) => {
      const course = new Set((r.cells || []).filter(x => x >= 0).map(x => C.g[x]));
      const cnt = new Map();
      for (const g of course) for (const k of byGrid.get(g) || []) cnt.set(k, (cnt.get(k) || 0) + 1);
      for (const [k, v] of cnt)
        if (v >= 2 && v >= 0.3 * Math.min(course.size, saved[k].grid.length)) pairs.push([v, j, k]);
    });
    const match = matchPairs(pairs);
    let next = saved.reduce((m, r) => Math.max(m, r.i), 0) + 1;
    const idMap = new Map();
    riverList.forEach((r, j) => {
      idMap.set(r.i, match.has(j) ? saved[match.get(j)].i : next++);
    });
    // an id the app left dangling (a lake inlet of a river too short to keep) gets a fresh one too
    const m = x => {
      if (!x) return x;
      if (!idMap.has(x)) idMap.set(x, next++);
      return idMap.get(x);
    };
    for (const r of riverList) {
      r.i = idMap.get(r.i);
      r.parent = m(r.parent);
      r.basin = m(r.basin);
    }
    riverList.forEach((r, j) => {
      if (!match.has(j)) return;
      const o = saved[match.get(j)];
      if (o.name) r.name = o.name;
      if (o.type) r.type = o.type;
    });
    for (const i of C.i) if (C.r[i]) C.r[i] = m(C.r[i]);
    for (const f of pack.features || []) {
      if (!f || f.type !== "lake") continue;
      if (f.river) f.river = m(f.river);
      if (f.outlet) f.outlet = m(f.outlet);
      if (Array.isArray(f.inlets)) f.inlets = f.inlets.map(m);
    }
    const live = new Set(riverList.map(r => r.i));
    const gone = saved.filter(r => !live.has(r.i));
    const orphaned = [];
    if (typeof notes !== "undefined" && Array.isArray(notes)) {
      const goneIds = new Set(gone.map(r => `river${r.i}`));
      for (const nt of notes) if (nt && goneIds.has(nt.id)) orphaned.push(`${nt.id}${nt.name ? ` ${nt.name}` : ""}`);
    }
    const out = { before: saved.length, after: riverList.length, kept: match.size, new: riverList.length - match.size };
    if (gone.length) out.gone = gone.length;
    if (orphaned.length) out.notesOrphaned = orphaned;
    return out;
  }

  /** The cell to record for a route point at x,y (cell `near` holds it): itself, or for a sea route on land the nearest water neighbour. */
  function pointCell(near, x, y, water) {
    const C = pack.cells;
    if (C.h[near] < 20 === water) return near;
    let best = near;
    let bd = Infinity;
    for (const k of C.c[near] || []) {
      if (C.h[k] < 20 !== water) continue;
      const d = (C.p[k][0] - x) ** 2 + (C.p[k][1] - y) ** 2;
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return best;
  }

  /** Cell and feature references the rebuild left on the old numbering, moved to the new one. */
  function carryCellRefs(old, features, opts = {}) {
    const C = pack.cells;
    const remap = cellRemap(old);
    const out = { routes: 0, markers: 0 };
    // the app puts each burg on the cell nearest its x,y, which is not always the cell it stood on
    // (a burg's x,y can sit nearer a neighbour's centre): put it back on its own cell when that
    // is still land and free, so its routes and province still meet it
    let burgsKept = 0;
    for (const b of pack.burgs || []) {
      if (!b?.i || b.removed || !Number.isInteger(old.burgCells[b.i])) continue;
      const nc = remap(old.burgCells[b.i]);
      if (nc === b.cell || !(C.h[nc] >= 20) || (C.burg[nc] && C.burg[nc] !== b.i)) continue;
      if (C.burg[b.cell] === b.i) C.burg[b.cell] = 0;
      C.burg[nc] = b.i;
      b.cell = nc;
      b.feature = C.f[nc];
      if (b.capital && pack.states[b.state]) pack.states[b.state].center = nc;
      for (const pr of pack.provinces || []) if (pr?.i && !pr.removed && pr.burg === b.i) pr.center = nc;
      burgsKept++;
    }
    if (burgsKept) out.burgsBackOnTheirCell = burgsKept;
    let bridged = 0;
    let repointed = 0;
    for (const r of pack.routes || []) {
      if (!r || !Array.isArray(r.points)) continue;
      const water = r.group === "searoutes";
      for (const pt of r.points) {
        if (!Number.isInteger(pt[2])) continue;
        pt[2] = remap(pt[2]);
        // a point keeps its x,y; its remapped cell (nearest the old cell's centre on the same grid
        // cell) can lie a cell away from it. Record the cell under the point instead (a sea route:
        // the nearest water cell around it), the way lint's route-point-cell fix does, so the
        // links built below join the cells the drawn route passes through.
        if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
        const near = findCell(pt[0], pt[1]);
        if (near === pt[2] || C.c[near]?.includes(pt[2])) continue;
        pt[2] = pointCell(near, pt[0], pt[1], water);
        repointed++;
      }
      // two cells that were neighbours can come out of the re-pack with an edge flipped between
      // them: step through the neighbour they share, so every route link joins neighbours
      for (let k = 1; k < r.points.length; k++) {
        const a = r.points[k - 1][2];
        const b = r.points[k][2];
        if (a === b || !Number.isInteger(a) || !Number.isInteger(b) || C.c[a]?.includes(b)) continue;
        const via = (C.c[a] || []).filter(x => C.c[x]?.includes(b));
        if (!via.length) continue;
        const mx = (C.p[a][0] + C.p[b][0]) / 2;
        const my = (C.p[a][1] + C.p[b][1]) / 2;
        const v = via.reduce((m, x) =>
          (C.p[x][0] - mx) ** 2 + (C.p[x][1] - my) ** 2 < (C.p[m][0] - mx) ** 2 + (C.p[m][1] - my) ** 2 ? x : m
        );
        r.points.splice(k, 0, [C.p[v][0], C.p[v][1], v]);
        bridged++;
        k++;
      }
      const first = r.points[0]?.[2];
      r.feature = features.oldToNew.get(r.feature) ?? (Number.isInteger(first) ? C.f[first] : r.feature);
      out.routes++;
    }
    if (bridged) out.routeLinksBridged = bridged;
    if (repointed) out.routePointsRepointed = repointed;
    if (typeof Routes !== "undefined" && typeof Routes.buildLinks === "function")
      C.routes = Routes.buildLinks(pack.routes || []);
    for (const mk of pack.markers || [])
      if (mk && Number.isInteger(mk.cell)) {
        mk.cell = remap(mk.cell);
        out.markers++;
      }
    for (const r of pack.religions || [])
      if (r?.i && !r.removed && Number.isInteger(r.center)) r.center = remap(r.center);
    (pack.states || []).forEach((s, k) => {
      if (!s?.i || s.removed) return;
      const cap = pack.burgs[s.capital];
      // the app moves a capital's state centre with its burg; the others still hold old ids
      if (!(cap?.i && !cap.removed) && Number.isInteger(old.stateCenters[k])) s.center = remap(old.stateCenters[k]);
      for (const reg of s.military || []) if (Number.isInteger(reg?.cell)) reg.cell = remap(reg.cell);
    });
    let portsLost = 0;
    for (const b of pack.burgs || []) {
      if (!b?.i || b.removed || !b.port) continue;
      let port = features.oldToNew.get(b.port);
      if (port === undefined) {
        const hv = C.haven?.[b.cell];
        port = hv && C.h[hv] < 20 ? C.f[hv] : 0;
      }
      if (!port) portsLost++;
      b.port = port;
    }
    if (portsLost) out.portsLost = portsLost;
    if (opts.keepBiomes)
      for (let o = 0; o < old.n; o++) {
        if (old.h[o] < 20) continue;
        const i = remap(o);
        if (C.h[i] >= 20) C.biome[i] = old.biome[o];
      }
    return out;
  }

  /**
   * restoreRiskedData plus the carrying above. opts: {restore (restoreRiskedData's opts),
   * keepRivers (the app keeps the rivers: map their cells back by grid), keepBiomes}.
   */
  function riskRebuild(opts = {}) {
    const old = captureCells();
    const riverGrid = opts.keepRivers ? saveRiversAsGrid() : null;
    clearFeatureShapes();
    heightmapInternals().restoreRiskedData(opts.restore);
    const info = {};
    if (riverGrid) {
      const dropped = restoreRiversFromGrid(riverGrid);
      if (dropped) info.riversDropped = dropped;
      finishRiskFeatures();
    }
    const features = carryFeatures(old);
    Object.assign(info, carryCellRefs(old, features, opts));
    if (features.named) info.featureNames = features.named;
    if (!riverGrid) info.rivers = carryRivers(old.rivers);
    return info;
  }

  // restoreRiskedData only groups and names features when erosion runs; do it here otherwise
  function finishRiskFeatures() {
    try {
      Features.defineGroups();
    } catch (e) {
      console.warn("tupaia-mcp: defineGroups after risk rebuild failed", e);
    }
    for (const f of pack.features || []) {
      if (!f || f.type !== "lake" || f.name) continue;
      try {
        f.name = Lakes.getName(f);
      } catch {
        /* unnamed lake; harmless */
      }
    }
  }

  // ---------------------------------------------------------------- local height update
  // rebuild:'keep' (paint_cells height, set_heights) is local: it recomputes only what the
  // changed cells' heights feed, never a global pass (no precipitation, river, biome, ice or
  // economy regeneration, so burg economies, state treasuries and far biomes stay as they were).

  /** Biome of pack cell i as Biomes.define gives it (same moisture formula and summing order). */
  function climateBiome(i) {
    const C = pack.cells;
    const prec = grid.cells.prec;
    const h = C.h[i];
    if (h < 20) return 0;
    let moisture = prec[C.g[i]];
    if (C.r[i]) moisture += Math.max(C.fl[i] / 10, 2);
    let s = 0;
    let k = 0;
    for (const nb of C.c[i])
      if (C.h[nb] >= 20) {
        s += prec[C.g[nb]];
        k++;
      }
    s += moisture;
    k++;
    return Biomes.getId(Math.round(4 + s / k), grid.cells.temp[C.g[i]], h, Boolean(C.r[i]));
  }

  /** Recompute the biome of these pack cells (land only); returns how many changed. */
  function localBiomes(cells) {
    const C = pack.cells;
    if (!grid.cells.prec || !grid.cells.temp || typeof Biomes?.getId !== "function") return 0;
    let n = 0;
    for (const i of cells) {
      if (C.h[i] < 20) continue;
      const b = climateBiome(i);
      if (b !== C.biome[i]) {
        C.biome[i] = b;
        n++;
      }
    }
    return n;
  }

  /** Rivers whose course holds a cell of `set` (pack ids), and the uphill steps next to those cells. */
  function riversThrough(set, before) {
    const C = pack.cells;
    const out = [];
    for (const r of pack.rivers || []) {
      const cs = r.cells || [];
      if (!cs.some(x => set.has(x))) continue;
      const climbs = [];
      for (let k = 1; k < cs.length; k++) {
        const a = cs[k - 1];
        const b = cs[k];
        if (!(set.has(a) || set.has(b)) || a < 0 || b < 0) continue;
        if (C.h[a] < 20 || C.h[b] < 20 || C.h[b] <= C.h[a]) continue;
        if (before?.has(`${a}>${b}`)) continue; // climbed before the change too
        climbs.push(before ? `${a} (h${C.h[a]}) -> ${b} (h${C.h[b]})` : `${a}>${b}`);
      }
      out.push({ i: r.i, name: r.name || "", climbs });
    }
    return out;
  }

  /**
   * The local part of a rebuild:'keep' height change on grid cells `edited` (grid.cells.h already
   * holds the new heights): their pack cells' heights, their temperature, the level of lakes on
   * their shore and (biomes !== 'keep') their biome. A neighbour's biome needs no update: its
   * inputs (its own temperature, precipitation and height, and which neighbours are land) do not
   * change. Returns counts and the rivers through the changed cells (kept, with climbs listed).
   */
  function localHeights(edited, opts = {}) {
    const C = pack.cells;
    const gset = edited instanceof Set ? edited : new Set(edited);
    const cells = [];
    for (const i of C.i) if (gset.has(C.g[i])) cells.push(i);
    const set = new Set(cells);
    const climbedBefore = new Set(riversThrough(set).flatMap(r => r.climbs));
    for (const i of cells) C.h[i] = grid.cells.h[C.g[i]];
    const out = { packCells: cells.length, temperature: 0, lakes: 0, biomes: 0, biomesKept: opts.biomes === "keep" };
    // temperature: the app's formula for the changed cells only (a whole-map pass would also
    // overwrite temperatures set by an earlier settings edit without recalculate)
    const old = grid.cells.temp;
    if (old && typeof calculateTemperatures === "function") {
      calculateTemperatures();
      const fresh = grid.cells.temp;
      grid.cells.temp = old;
      for (const g of gset)
        if (old[g] !== fresh[g]) {
          old[g] = fresh[g];
          out.temperature++;
        }
    }
    for (const ft of pack.features || []) {
      if (!ft || ft.type !== "lake" || !Array.isArray(ft.shoreline) || !ft.shoreline.some(x => set.has(x))) continue;
      const lvl = Lakes.getHeight(ft);
      if (lvl !== ft.height) {
        ft.height = lvl;
        out.lakes++;
      }
    }
    if (opts.biomes !== "keep") out.biomes = localBiomes(cells);
    out.rivers = riversThrough(set, climbedBefore);
    return out;
  }

  /** Notes for a local keep update (localHeights' result); returns the lean result block. */
  function localHeightNotes(L, c, hint, riversRegenerated = false) {
    const climbing = riversRegenerated ? [] : L.rivers.filter(r => r.climbs.length);
    c.notes.add(
      `rebuild:'keep' is local: heights, temperature${L.biomesKept ? "" : ", biome"} and lake levels of the ${L.packCells} changed cells were updated; precipitation, ${riversRegenerated ? "" : "rivers, "}other biomes, burg economies and state treasuries were not touched`
    );
    if (L.rivers.length && !riversRegenerated)
      c.notes.add(
        `rivers were kept: ${L.rivers.length} run through the changed cells${
          climbing.length
            ? `; ${climbing.length} now climb there: ${climbing
                .slice(0, 3)
                .map(r => `${r.name || "river"} (${r.i}) ${r.climbs[0]}`)
                .join(", ")}${climbing.length > 3 ? ", ..." : ""} (${hint})`
            : ""
        }`
      );
    const block = {
      packCells: L.packCells,
      temperature: L.temperature,
      biomes: L.biomes,
      lakes: L.lakes,
      rivers: { through: L.rivers.length }
    };
    if (climbing.length)
      block.rivers.climbing = climbing.slice(0, 10).map(r => ({ i: r.i, name: r.name, steps: r.climbs.length }));
    return block;
  }

  async function paintHeight(H, packCells, write, c) {
    const C = pack.cells;
    const gh = grid.cells.h;
    const gcells = [...new Set(packCells.map(x => C.g[x]))].sort((a, b) => a - b);
    const target = new Map();
    if (H.smooth !== undefined) {
      const cur = new Map(gcells.map(g => [g, gh[g]]));
      const inSel = new Set(gcells);
      for (let it = 0; it < H.smooth; it++) {
        const next = new Map();
        for (const g of gcells) {
          let nb = grid.cells.c[g].map(n => (inSel.has(n) ? cur.get(n) : gh[n]));
          // keep mode works on land only: like the app's land smoothing brush, average land
          // neighbours only, so smoothing never drags a coastal cell below 20
          if (H.rebuild === "keep" && cur.get(g) >= 20) nb = nb.filter(v => v >= 20);
          if (!nb.length) {
            next.set(g, cur.get(g));
            continue;
          }
          const mean = nb.reduce((s, v) => s + v, 0) / nb.length;
          next.set(g, (cur.get(g) + mean) / 2);
        }
        for (const [g, v] of next) cur.set(g, v);
      }
      for (const g of gcells) target.set(g, cur.get(g));
    } else {
      for (const g of gcells) target.set(g, H.value !== undefined ? H.value : gh[g] + H.delta);
    }
    for (const [g, v] of target) target.set(g, Math.max(0, Math.min(100, Math.round(v))));

    const stats = {
      gridCells: gcells.length,
      changed: 0,
      skippedWater: 0,
      crossing: 0,
      clamped: 0,
      rebuild: H.rebuild
    };
    const edits = [];
    for (const g of gcells) {
      const old = gh[g];
      let v = target.get(g);
      if (H.rebuild === "keep") {
        if (old < 20) {
          if (v >= 20) stats.crossing++;
          else stats.skippedWater++;
          continue;
        }
        if (v < 20) {
          if (H.clamp) {
            v = 20;
            stats.clamped++;
          } else {
            stats.crossing++;
            continue;
          }
        }
      }
      if (v !== old) edits.push([g, v]);
    }
    stats.changed = edits.length;
    if (H.rebuild === "keep" && stats.crossing)
      fail(
        "REFUSED",
        `${stats.crossing} selected cells would cross height 20 (land <-> water), which changes the coastline; rebuild:'keep' cannot do that. Use rebuild:'risk' to change the coastline while keeping burgs, states and other data, or select land only (where:{land:true}) / pass clamp:true to stop land at 20.`,
        { details: stats }
      );
    if (!write) {
      if (H.rebuild !== "keep") {
        let toLand = 0;
        let toWater = 0;
        for (const [g, v] of edits) {
          if (gh[g] < 20 && v >= 20) toLand++;
          if (gh[g] >= 20 && v < 20) toWater++;
        }
        stats.becomeLand = toLand;
        stats.becomeWater = toWater;
      }
      return stats;
    }
    if (!edits.length) return stats;
    const before = featureSummary();
    for (const [g, v] of edits) gh[g] = v;
    if (H.rebuild === "keep") {
      const edited = new Set(edits.map(e => e[0]));
      const L = localHeights(edited, { biomes: H.biomes });
      stats.local = localHeightNotes(L, c, "reroute them with edit river; rebuild:'risk' regenerates rivers");
      c.R.add("heightmap");
      if (L.biomes) c.R.add("biomes");
    } else {
      const hm = heightmapInternals();
      const erosionEl = document.getElementById("allowErosion");
      const prevErosion = erosionEl ? erosionEl.checked : true;
      if (erosionEl) erosionEl.checked = !!H.erosion;
      try {
        if (H.rebuild === "risk") {
          // Without erosion the app keeps pack.rivers, whose cells/source/mouth are pack ids of
          // the old graph; reGraph renumbers cells, so drawRivers would read p[staleId] and
          // throw: riskRebuild records them as grid ids and maps them back (keepRivers). It also
          // moves routes, markers and the other cell references to the new cells.
          const carried = riskRebuild({ keepRivers: !H.erosion });
          if (carried.riversDropped)
            c.notes.add(`${carried.riversDropped} rivers lost their course in the rebuild and were removed`);
          stats.carried = carried;
          c.notes.add(
            "rebuild:'risk' re-ran features, climate and the pack graph; cell ids changed, burgs were kept (non-capital burgs that ended in water were removed)"
          );
        } else {
          undraw();
          hm.regenerateErasedData();
          c.notes.add("rebuild:'erase' regenerated every entity from the new heightmap");
        }
      } finally {
        if (erosionEl) erosionEl.checked = prevErosion;
      }
      c.R.add("all");
    }
    stats.features = { before, after: featureSummary() };
    return stats;
  }

  const PAINT_VALUE_KEYS = ["state", "province", "culture", "religion", "biome"];

  function rleValues(values) {
    const out = [];
    for (const v of values) {
      const last = out[out.length - 1];
      if (last && last[0] === v) last[1]++;
      else out.push([v, 1]);
    }
    return out;
  }

  /** Current values of some cells for the paint keys (sketch replay's both-painted check). */
  FNS.cellValues = a => {
    const cells = Array.isArray(a.cells) ? a.cells : [];
    const out = {};
    for (const k of Array.isArray(a.keys) ? a.keys : [])
      if (PAINT_VALUE_KEYS.includes(k)) out[k] = cells.map(c => pack.cells[k][c] ?? null);
    return out;
  };

  FNS.paint = async a => {
    const P = preparePaint(a);
    // the graph the literal cell list refers to (taken before a height rebuild renumbers it)
    const graph = T.cellGraph?.() ?? null;
    if (a.phase !== "apply") {
      const c = batchContext(a);
      const out = await paintApply(P, false, c);
      return { phase: "validate", cells: P.cells.length, set: out };
    }
    const c = batchContext(a);
    if (P.state !== undefined) c.internals = await stateInternals();
    // the values the cells held before (run-length encoded): replay finds cells someone else
    // painted since and reports them as a conflict instead of overwriting them
    const base = {};
    for (const k of PAINT_VALUE_KEYS)
      if (P[k] !== undefined) base[k] = rleValues(P.cells.map(cell => pack.cells[k][cell]));
    const out = await paintApply(P, true, c);
    T.resetMemo?.();
    const rd = await finishRedraw(a, c.R);
    const set = {};
    for (const k of ["state", "province", "culture", "religion", "biome"]) if (P[k] !== undefined) set[k] = P[k];
    if (P.zone) set.zone = { ref: P.zone.i, op: P.zone.op };
    if (P.height) set.height = clone(P.height);
    const resolved = { select: { cells: P.cells.slice() }, set };
    if (Object.keys(base).length) resolved.base = base;
    if (graph) resolved.graph = graph;
    // a risk rebuild is deterministic (the app reseeds from the map seed): replay checks its graph
    if (P.height?.rebuild === "risk") resolved.graphAfter = T.cellGraph?.() ?? null;
    if (a.redraw !== undefined) resolved.redraw = a.redraw;
    return { cells: P.cells.length, set: out, resolved, ...rd, notes: [...c.notes] };
  };

  // ---------------------------------------------------------------- generate

  let generatorLocks = new Set();
  const DENSITY = {
    1: 1000,
    2: 2000,
    3: 5000,
    4: 10000,
    5: 20000,
    6: 30000,
    7: 40000,
    8: 50000,
    9: 60000,
    10: 70000,
    11: 80000,
    12: 90000,
    13: 100000
  };

  function densityOf(v) {
    if (!Number.isFinite(v) || v <= 0) fail("BAD_ARGS", "cells is a density 1-13 or a cell count (1000-100000)");
    if (v <= 13) {
      if (!Number.isInteger(v)) fail("BAD_ARGS", "cells density must be an integer 1-13");
      return v;
    }
    let best = 1;
    for (const k of Object.keys(DENSITY)) if (Math.abs(DENSITY[k] - v) < Math.abs(DENSITY[best] - v)) best = Number(k);
    return best;
  }

  FNS.generateMap = async (a, meta) => {
    const el = id => document.getElementById(id) || fail("BAD_ARGS", `no input #${id}`);
    const plan = []; // [lockId|null, apply()]
    const used = {};
    const intIn = (name, v, min, max) => {
      if (!Number.isInteger(v) || v < min || v > max) fail("BAD_ARGS", `${name} must be an integer ${min}..${max}`);
      return v;
    };
    if (a.template !== undefined) {
      const t = String(a.template);
      const known = typeof heightmapTemplates !== "undefined" && t in heightmapTemplates;
      const pre = typeof precreatedHeightmaps !== "undefined" && t in precreatedHeightmaps;
      if (!known && !pre)
        fail("BAD_ARGS", `unknown template '${t}'`, {
          details: [
            ...Object.keys(typeof heightmapTemplates !== "undefined" ? heightmapTemplates : {}),
            ...Object.keys(typeof precreatedHeightmaps !== "undefined" ? precreatedHeightmaps : {})
          ]
        });
      const name = known ? heightmapTemplates[t].name : precreatedHeightmaps[t].name;
      plan.push(["template", () => applyOption(el("templateInput"), t, name)]);
      used.template = t;
    }
    if (a.cells !== undefined) {
      const d = densityOf(Number(a.cells));
      plan.push(["points", () => changeCellsDensity(d)]);
      used.cells = { density: d, cells: DENSITY[d] };
    }
    const simple = [
      ["states", "statesNumber", "statesNumber", 0, 100],
      ["provincesRatio", "provincesRatio", "provincesRatio", 0, 100],
      ["religions", "religionsNumber", "religionsNumber", 0, 50],
      ["sizeVariety", "sizeVariety", "sizeVariety", 0, 10],
      ["growthRate", "growthRate", "growthRate", 0.1, 2]
    ];
    for (const [arg, id, lockId, min, max] of simple) {
      if (a[arg] === undefined) continue;
      const v = Number(a[arg]);
      if (!Number.isFinite(v) || v < min || v > max) fail("BAD_ARGS", `${arg} must be within ${min}..${max}`);
      plan.push([lockId, () => (el(id).value = v)]);
      used[arg] = v;
    }
    if (a.burgs !== undefined) {
      const v = intIn("burgs", Number(a.burgs), 0, 999);
      plan.push([
        "manors",
        () => {
          el("manorsInput").value = v;
          el("manorsOutput").value = v;
        }
      ]);
      used.burgs = v;
    }
    let setName = null;
    if (a.culturesSet !== undefined) {
      setName = String(a.culturesSet);
      const opt = [...el("culturesSet").options].find(o => o.value === setName);
      if (!opt)
        fail("BAD_ARGS", `unknown culturesSet '${setName}'`, {
          details: [...el("culturesSet").options].map(o => o.value)
        });
      plan.push([
        "culturesSet",
        () => {
          el("culturesSet").value = setName;
          changeCultureSet();
        }
      ]);
      used.culturesSet = setName;
    }
    if (a.cultures !== undefined) {
      const v = intIn("cultures", Number(a.cultures), 1, 100);
      const setEl = el("culturesSet");
      const opt = [...setEl.options].find(o => o.value === (setName ?? setEl.value));
      const max = Number(opt?.dataset.max ?? 100);
      if (v > max) fail("BAD_ARGS", `culture set '${opt?.value}' allows at most ${max} cultures`);
      plan.push([
        "cultures",
        () => {
          el("culturesInput").value = v;
          el("culturesOutput").value = v;
        }
      ]);
      if (setName === null) plan.push(["culturesSet", () => {}]);
      used.cultures = v;
    }
    if (a.width !== undefined || a.height !== undefined) {
      const w = intIn("width", Number(a.width ?? graphWidth), 240, 8192);
      const h = intIn("height", Number(a.height ?? graphHeight), 135, 8192);
      plan.push([
        null,
        () => {
          mapWidthInput.value = w;
          mapHeightInput.value = h;
          localStorage.setItem("mapWidth", String(w));
          localStorage.setItem("mapHeight", String(h));
        }
      ]);
      used.width = w;
      used.height = h;
    }
    if (a.options !== undefined) {
      if (!isObj(a.options)) fail("BAD_ARGS", "options is {<inputId>: value}");
      for (const [id, v] of Object.entries(a.options)) {
        const input = document.getElementById(id);
        if (!input || !("value" in input)) fail("BAD_ARGS", `no option input #${id}`);
        const lockId = input.dataset?.stored || null;
        plan.push([
          lockId,
          () => {
            if (input.type === "checkbox") input.checked = !!v;
            else input.value = v;
            const out = id.endsWith("Input") ? document.getElementById(`${id.slice(0, -5)}Output`) : null;
            if (out && "value" in out) out.value = v;
          }
        ]);
        used[`options.${id}`] = v;
      }
    }

    if (a.phase === "validate") return { phase: "validate", optionsUsed: used };

    // apply inputs, lock what was given, unlock what an earlier call locked and this one did not
    const locksNow = new Set();
    for (const [lockId, fn] of plan) {
      fn();
      if (lockId) locksNow.add(lockId);
    }
    for (const id of locksNow) lock(id);
    const unlocked = [];
    for (const id of generatorLocks) {
      // T.settingLocks (bridge-ext/settings.js): locks taken through edit map are not generator locks
      if (!locksNow.has(id) && !T.settingLocks?.has(id)) {
        unlock(id);
        unlocked.push(id);
      }
    }
    generatorLocks = locksNow;

    const seedStr = a.seed !== undefined && a.seed !== null && a.seed !== "" ? String(a.seed) : String(generateSeed());
    if (typeof closeDialogs === "function") closeDialogs();
    customization = 0;
    // Markers.add for a custom type marks its cell occupied until the next generateTypes run;
    // a stale set would make this generation differ from the same seed on a clean page
    if (typeof Markers !== "undefined" && Array.isArray(Markers.occupied)) Markers.occupied = [];
    // Names caches one Markov chain per name base for the page session, and the cached chains
    // depend on what was named before (the random boot map, earlier maps): the same seed then gave
    // other river and burg names in another session. Start every generation from fresh chains.
    if (typeof Names !== "undefined" && typeof Names.clearChains === "function") Names.clearChains();
    // Rivers caches the 'small river' length threshold from the first map of the session (the random
    // boot map) and never resets it, so river types (Brook, Stream, River) depended on it too
    if (typeof Rivers !== "undefined" && "smallLength" in Rivers) Rivers.smallLength = null;
    // randomizeOptions writes the random culture count into a range input whose max is still the
    // previous map's culture set max (changeCultureSet sets it, and it then clamps to the new
    // set's max): a range input clamps the value it is given, so after a map with a small culture
    // set the same seed gave fewer cultures. Drop the stale max; changeCultureSet sets it again.
    for (const id of ["culturesInput", "culturesOutput"]) document.getElementById(id)?.removeAttribute("max");
    undraw();
    // A precreated heightmap (an image template such as taklamakan) loads asynchronously after
    // HeightmapGenerator.generate seeded Math.random, and any task that draws a random number while
    // the image loads shifts the seeded stream: the same seed then gave other features, cultures and
    // states now and then. Loading the image draws no random number, so put the stream back to
    // where the seeding left it once the heights are in.
    const HG = typeof HeightmapGenerator !== "undefined" ? HeightmapGenerator : null;
    const hgGenerate = HG?.generate;
    if (HG && typeof hgGenerate === "function")
      HG.generate = async function (graph) {
        const id = document.getElementById("templateInput")?.value;
        const precreated = typeof heightmapTemplates === "undefined" || !(id in heightmapTemplates);
        const pending = hgGenerate.call(this, graph);
        const seeded = Math.random;
        const state = precreated && typeof seeded?.exportState === "function" ? seeded.exportState() : null;
        const heights = await pending;
        if (state) {
          seeded.importState(state);
          Math.random = seeded;
        }
        return heights;
      };
    try {
      await T.awaitMap(() => generate({ seed: seedStr }), a.timeoutMs || 110000, meta?.op);
    } finally {
      if (HG && typeof hgGenerate === "function") HG.generate = hgGenerate;
    }
    drawLayers();
    fitMapToScreen();
    await FNS.resetView();
    await T.settle();
    const s = T.summary();
    return {
      seed: s.seed,
      name: s.name,
      template: document.getElementById("templateInput")?.value ?? null,
      graph: s.graph,
      cells: s.cells,
      counts: s.counts,
      features: s.features,
      digest: FNS.digest().hash,
      optionsUsed: used,
      locked: [...locksNow],
      unlocked
    };
  };

  // ---------------------------------------------------------------- regenerate

  // each runs with the regenerate args; an object it returns is reported under details[part]
  const REGEN = [
    [
      "rivers",
      () => {
        // Rivers.generate erodes pack.cells.h, which a .map file does not keep (a load rebuilds pack
        // heights from the grid): put the heights back so the page stays what a save holds and a
        // second regenerate does not cut deeper (Configure World's updateWorld does the same)
        const h = pack.cells.h;
        regenerateRivers();
        if (pack.cells.h !== h && pack.cells.h.length === h.length) pack.cells.h = h;
      }
    ],
    ["biomes", a => FNS.defineBiomes({ ...(a.biomes || {}), phase: "apply" })], // bridge-ext/biomes.js
    [
      "population",
      () => {
        recalculatePopulation();
        States.collectStatistics(); // state rural/urban totals follow the new cell populations
      }
    ],
    ["cultures", () => regenerateCultures()],
    ["burgs", () => regenerateBurgs()],
    ["states", () => regenerateStates()],
    ["provinces", () => regenerateProvinces()],
    ["routes", () => regenerateRoutes()],
    ["religions", () => regenerateReligions()],
    ["emblems", () => regenerateEmblems()],
    ["military", () => regenerateMilitary()],
    ["markers", () => regenerateMarkers()],
    [
      "zones",
      () => {
        Zones.generate(1);
        if (layerIsOn("toggleZones")) drawZones();
      }
    ],
    ["ice", () => regenerateIce()],
    ["goods", () => regenerateGoods()],
    ["markets", () => regenerateMarkets()],
    ["economy", () => regenerateEconomy()],
    ["production", () => regenerateProduction()]
  ];
  const REGEN_NOTES = {
    states:
      "regenerateStates reseeds Math.random from a fresh random seed, so the result is not reproducible from the map seed",
    population: "recalculatePopulation turns the population layer on",
    cultures: "regenerateCultures turns the cultures layer on",
    religions: "regenerateReligions turns the religions layer on",
    ice: "regenerateIce turns the ice layer on",
    markers: "regenerateMarkers turns the markers layer on",
    military: "regenerateMilitary turns the military layer on",
    emblems: "regenerateEmblems turns the emblems layer on"
  };

  FNS.regenerate = async a => {
    const parts = Array.isArray(a.parts) ? a.parts : [];
    const known = REGEN.map(r => r[0]);
    if (!parts.length) fail("BAD_ARGS", "parts must be a non-empty array", { details: known });
    for (const p of parts) if (!known.includes(p)) fail("BAD_ARGS", `unknown part '${p}'`, { details: known });
    if (a.phase === "validate") {
      // the phased protocol (a wrapper validating a mixed call): check what can be, change nothing
      if (parts.includes("biomes") && typeof FNS.defineBiomes === "function")
        await FNS.defineBiomes({ ...(a.biomes || {}), phase: "validate" });
      return { phase: "validate" };
    }
    const before = FNS.layersOn();
    const ran = [];
    const notesOut = [];
    const details = {};
    for (const [part, fn] of REGEN) {
      if (!parts.includes(part)) continue;
      const v = await fn(a);
      if (isObj(v)) details[part] = v;
      ran.push(part);
      if (REGEN_NOTES[part]) notesOut.push(REGEN_NOTES[part]);
    }
    const after = FNS.layersOn();
    const turnedOn = after.filter(l => !before.includes(l));
    const turnedOff = before.filter(l => !after.includes(l));
    let restored = false;
    if (a.restoreLayers && (turnedOn.length || turnedOff.length)) {
      await FNS.setLayers({ on: turnedOff, off: turnedOn });
      restored = true;
    }
    await T.settle();
    const out = { ran, layerChanges: { turnedOn, turnedOff, restored }, layersOn: FNS.layersOn(), notes: notesOut };
    if (Object.keys(details).length) out.details = details;
    return out;
  };

  // ---------------------------------------------------------------- display

  FNS.display = async a => {
    const warnings = [];
    const want = new Map(); // layer name -> on?
    const norm = l => I.layerId(l)[0];
    if (a.layersPreset !== undefined) {
      if (typeof presets === "undefined" || !(a.layersPreset in presets))
        fail("BAD_ARGS", `unknown layers preset '${a.layersPreset}'`, {
          details: Object.keys(typeof presets !== "undefined" ? presets : {})
        });
      const ids = presets[a.layersPreset];
      for (const [n, id] of Object.entries(I.LAYERS)) if (document.getElementById(id)) want.set(n, ids.includes(id));
    }
    if (Array.isArray(a.only)) {
      const keep = new Set(a.only.map(norm));
      for (const n of FNS.layersOn()) if (!keep.has(n)) want.set(n, false);
      for (const n of keep) want.set(n, true);
    }
    const on = (a.on || []).map(norm);
    const off = (a.off || []).map(norm);
    const both = on.filter(n => off.includes(n));
    if (both.length) fail("BAD_ARGS", `layer${both.length > 1 ? "s" : ""} ${both.join(", ")} both on and off`);
    for (const n of on) want.set(n, true);
    for (const n of off) want.set(n, false);
    let stylePresetName = null;
    if (a.stylePreset !== undefined) {
      const p = String(a.stylePreset);
      const custom = Object.keys(localStorage).filter(k => k.startsWith("fmgStyle_"));
      const sys = typeof systemPresets !== "undefined" ? systemPresets : [];
      if (!sys.includes(p) && !custom.includes(p))
        fail("BAD_ARGS", `unknown style preset '${p}'`, { details: [...sys, ...custom] });
      stylePresetName = p;
    }
    if (a.styleRules !== undefined) {
      if (!isObj(a.styleRules)) fail("BAD_ARGS", "styleRules is {'<selector>': {attribute: value}}");
      for (const [sel, attrs] of Object.entries(a.styleRules)) {
        if (!isObj(attrs)) fail("BAD_ARGS", `styleRules['${sel}'] must be an object of attributes`);
        let found = null;
        try {
          found = document.querySelector(sel);
        } catch {
          fail("BAD_ARGS", `invalid selector '${sel}'`);
        }
        if (!found) warnings.push(`selector '${sel}' matches nothing; skipped`);
      }
    }
    if (a.phase === "validate") return { phase: "validate" };
    let changed = [];
    if (want.size) {
      const r = await FNS.setLayers({
        on: [...want].filter(([, v]) => v).map(([n]) => n),
        off: [...want].filter(([, v]) => !v).map(([n]) => n)
      });
      changed = r.changed;
    }
    if (a.layersPreset !== undefined && typeof setLayersPreset === "function") setLayersPreset(a.layersPreset);
    else if (changed.length && typeof getCurrentPreset === "function") getCurrentPreset();
    if (stylePresetName) {
      await changeStyle(stylePresetName);
      const sel = document.getElementById("stylePreset");
      if (sel && [...sel.options].some(o => o.value === stylePresetName)) {
        sel.value = stylePresetName;
        sel.dataset.old = stylePresetName;
      }
    }
    if (a.styleRules !== undefined) {
      applyStyle(a.styleRules);
      if (typeof invokeActiveZooming === "function") invokeActiveZooming();
    }
    await T.settle();
    const resolved = {
      on: [...want].filter(([, v]) => v).map(([n]) => n),
      off: [...want].filter(([, v]) => !v).map(([n]) => n)
    };
    if (a.layersPreset !== undefined) resolved.layersPreset = a.layersPreset;
    if (stylePresetName) resolved.stylePreset = stylePresetName;
    if (a.styleRules !== undefined) resolved.styleRules = clone(a.styleRules);
    return {
      resolved,
      layersOn: FNS.layersOn(),
      changed,
      stylePreset: localStorage.getItem("presetStyle"),
      styleApplied: stylePresetName,
      rulesApplied: a.styleRules ? Object.keys(a.styleRules).length : 0,
      warnings
    };
  };

  T.mutations = {
    FIELDS,
    ADD,
    REMOVE,
    IDENT,
    TRACKED_TYPES,
    selectCells,
    nameSpec,
    generateName,
    literalPlace,
    landPlace,
    // shared with bridge-ext (terrain): the heightmap rebuild helpers and the batch plumbing
    batchContext,
    finishRedraw,
    heightmapInternals,
    featureSummary,
    clearFeatureShapes,
    finishRiskFeatures,
    riskRebuild,
    captureRivers,
    carryRivers,
    localHeights,
    localHeightNotes,
    localBiomes
  };
  // removal hooks for bridge-ext/clear.js (province/culture/religion removal, forced burg removal)
  Object.assign(T.mutations, { NO_REMOVE, identOf, stateInternals, errRow });
})(globalThis);
