// Platform fixes (dx/core-2): argument checks, path rules, diff identity, snapshot fidelity,
// live entity stats, culture/route creation, app load repairs, risk-rebuild route points, map
// locks in settings, seed reproducibility, eval redraw:false. Local layer only, on
// tests/fixtures/demo.map (and crafted copies of it); never the live site.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { DEMO_MAP, errorBody, type Harness, startServer, textOf } from "./helpers.ts";

type Obj = Record<string, any>;

describe("core-2: arguments", () => {
  let h: Harness;
  before(async () => {
    h = await startServer();
    await h.ok("load_map", { path: DEMO_MAP });
  });
  after(async () => h?.close());

  test("an unknown top-level key is BAD_ARGS naming the allowed keys (MCP)", async () => {
    const r = await h.call("regenerate", { parts: ["routes"], redraw: false });
    assert.ok(r.isError);
    const e = errorBody(r).error as Obj;
    assert.equal(e.code, "BAD_ARGS");
    assert.match(e.message, /regenerate does not take 'redraw'; allowed arguments: parts, /);
    assert.deepEqual(e.details.unknown, ["redraw"]);
    assert.ok(e.details.allowed.includes("restoreLayers"));
    // a schema error is BAD_ARGS too (it used to be the SDK's 'Input validation error')
    const bad = await h.call("find", { type: "burg", limit: -1 });
    assert.ok(bad.isError);
    assert.match(textOf(bad), /^BAD_ARGS: invalid arguments for find: limit/);
  });

  test("tools/list advertises additionalProperties:false on plain object schemas", async () => {
    const { tools } = await h.client.listTools();
    const find = tools.find(t => t.name === "find") as Obj;
    assert.equal(find.inputSchema.additionalProperties, false);
    assert.ok(find.inputSchema.properties.fields);
    // apply takes inline lists under any key: no additionalProperties:false there
    const apply = tools.find(t => t.name === "apply") as Obj;
    assert.notEqual(apply.inputSchema.additionalProperties, false);
  });

  test("defaults still apply and known keys pass", async () => {
    const s = await h.ok("session", {});
    assert.equal(typeof s.mode, "string");
  });

  test("find warns about unknown fields, where-fields and sort keys", async () => {
    const r = await h.ok("find", { type: "route", fields: ["joinsAt", "group"], limit: 2 });
    assert.equal((r.rows as Obj[]).length, 2);
    assert.match(String((r.warnings as string[])[0]), /no route has fields: joinsAt .*route fields: .*group/);
    const w = await h.ok("find", { type: "burg", where: { nosuch: 3 }, sort: "-alsoNot", limit: 1 });
    assert.equal(w.total, 0);
    assert.match(String((w.warnings as string[])[0]), /where: nosuch, sort: alsoNot/);
    // river joinsAt comes from bridge-ext/rivers.js: not unknown there
    const rv = await h.ok("find", { type: "river", fields: ["joinsAt"], limit: 1 });
    assert.equal(rv.warnings, undefined);
    // computed fields and Min/Max bounds are known
    const ok = await h.ok("find", { type: "burg", where: { populationMin: 1 }, fields: ["population"], limit: 1 });
    assert.equal(ok.warnings, undefined);
    const c = await h.call("find", { type: "route", fields: ["joinsAt"], limit: 1, format: "compact" });
    assert.match(textOf(c), /\nwarning: no route has fields: joinsAt/);
  });

  test("inspect warns about unknown field names", async () => {
    const r = await h.ok("inspect", { entity: { type: "burg", ref: 1 }, fields: ["state", "bogus"] });
    assert.ok((r.entity as Obj).state !== undefined);
    assert.match(String((r.warnings as string[])[0]), /no key bogus in burg 1/);
    const ok = await h.ok("inspect", { entity: { type: "burg", ref: 1 }, fields: ["state", "people"] });
    assert.equal(ok.warnings, undefined);
    const c = await h.call("inspect", { entity: { type: "burg", ref: 1 }, fields: ["bogus"], format: "compact" });
    assert.match(textOf(c), /\nwarning: no key bogus/);
  });

  test("eval takes redraw:false (redraw nothing) and still rejects unknown keys", async () => {
    const r = await h.ok("eval", { code: "return pack.burgs.length", readOnly: true, redraw: false });
    assert.equal(typeof r.value, "number");
    const bad = await h.call("eval", { code: "1", readOnly: true, redraws: ["states"] });
    assert.equal(errorBody(bad).error.code, "BAD_ARGS");
  });
});
