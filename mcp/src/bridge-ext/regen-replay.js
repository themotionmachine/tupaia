// Tupaia MCP bridge extension: replay of a logged 'regenerate' op (mcp/src/regen-replay.ts). A
// classic script injected after bridge.js and bridge-mutations.js; same rules as those.
//
// FNS.regenerateReplay (phased) takes {parts, forms:[{key, fn, args}]}: one sub-call per part
// family, each to that family's own phased replay function (setBiomeCells for biomes,
// regenerateLiteral for provinces/emblems, regenerate {parts:['relief']} for relief), in the
// order given (the order the parts ran). 'validate' validates every form and changes nothing
// (their errors are joined); 'apply' applies them in order and returns their results merged,
// with resolved = the combined form rebuilt from each one's resolved. A single form (relief
// alone) returns that form's result unchanged. It wraps nothing, so its file-name position does
// not matter.
(root => {
  const T = root.__tupaia;
  if (!T?.fns) return;
  const FNS = T.fns;
  const fail = T.fail;
  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);

  /** The only functions a logged form may name (a saved log is untrusted). */
  const ALLOWED = { biomes: "setBiomeCells", literal: "regenerateLiteral", relief: "regenerate" };

  function checkForms(a) {
    const forms = Array.isArray(a.forms) ? a.forms : [];
    if (!forms.length || forms.length > 3) fail("BAD_ARGS", "forms is a list of 1-3 {key, fn, args}");
    const seen = new Set();
    for (const f of forms) {
      if (!isObj(f) || ALLOWED[f.key] !== f.fn || seen.has(f.key) || !isObj(f.args))
        fail("BAD_ARGS", `regenerateReplay cannot replay form ${JSON.stringify(isObj(f) ? f.key : f)}`);
      if (typeof FNS[f.fn] !== "function") fail("PAGE_ERROR", `the bridge has no ${f.fn}`);
      seen.add(f.key);
    }
    return forms;
  }

  /** The sub-call's own args with the phase; relief replays through regenerate {parts:['relief']}. */
  const subArgs = (f, phase) => ({ ...f.args, ...(f.key === "relief" ? { parts: ["relief"] } : {}), phase });

  FNS.regenerateReplay = async a => {
    const forms = checkForms(a);
    if (a.phase === "validate") {
      if (forms.length === 1) return FNS[forms[0].fn](subArgs(forms[0], "validate"));
      const errors = [];
      for (const f of forms) {
        const v = await FNS[f.fn](subArgs(f, "validate"));
        for (const e of (isObj(v) && Array.isArray(v.errors) && v.errors) || [])
          errors.push(
            isObj(e)
              ? { ...e, message: `${f.key}: ${e.message ?? ""}` }
              : { code: "CONFLICT", message: `${f.key}: ${e}` }
          );
      }
      return { phase: "validate", ...(errors.length ? { errors } : {}) };
    }
    if (forms.length === 1) return FNS[forms[0].fn](subArgs(forms[0], "apply"));
    const out = { ran: [], notes: [] };
    const resolved = { parts: Array.isArray(a.parts) ? [...a.parts] : [], combined: true };
    for (const f of forms) {
      const o = (await FNS[f.fn](subArgs(f, "apply"))) || {};
      if (o.phase === "validate") fail("PAGE_ERROR", `${f.fn} only validated`);
      if (o.resolved !== undefined) resolved[f.key] = o.resolved;
      if (f.key === "biomes") {
        const { resolved: _r, notes, ...rest } = o;
        out.details = { ...(out.details || {}), biomes: rest };
        out.ran.push("biomes");
        if (Array.isArray(notes)) out.notes.push(...notes);
        if (typeof o.resolved?.graph === "string") resolved.graph = o.resolved.graph;
        continue;
      }
      for (const [k, v] of Object.entries(o)) {
        if (k === "resolved" || k === "phase") continue;
        if (k === "ran") out.ran.push(...(Array.isArray(v) ? v : []));
        else if (k === "notes") out.notes.push(...(Array.isArray(v) ? v : []));
        else out[k] = v;
      }
      if (f.key === "literal" && resolved.graph === undefined && typeof o.resolved?.graph === "string")
        resolved.graph = o.resolved.graph;
    }
    out.resolved = resolved;
    return out;
  };
})(globalThis);
