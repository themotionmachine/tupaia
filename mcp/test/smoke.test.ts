// End-to-end smoke test over stdio against tests/fixtures/demo.map (core-layer tools).
// Letters refer to the verification plan in the design (stage1 VERIFY section).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import {
  alive,
  chromeDescendants,
  errorBody,
  type Harness,
  imageSize,
  REPO_ROOT,
  rawStdoutCheck,
  startServer,
  textOf,
  waitFor
} from "./helpers.ts";

const CORE_TOOLS = ["session", "map_info", "find", "inspect", "screenshot", "snapshot", "eval", "load_map"];
const ALL_TOOLS = [
  "session",
  "map_info",
  "find",
  "inspect",
  "screenshot",
  "display",
  "edit",
  "add",
  "paint_cells",
  "generate_map",
  "regenerate",
  "snapshot",
  "eval",
  "load_map",
  "save_map",
  "export",
  "shared_status",
  "shared_save",
  "shared_restore"
];

describe("tupaia-mcp smoke (core layer)", () => {
  let h: Harness;
  let burg: { i: number; name: string; x: number; y: number };
  let shotQ = "";

  before(async () => {
    h = await startServer();
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("a. initialize, tools, resources, lazy launch", async () => {
    const { tools } = await h.client.listTools();
    const names = tools.map(t => t.name);
    for (const n of CORE_TOOLS) assert.ok(names.includes(n), `missing tool ${n}`);
    for (const t of tools) assert.ok((t.description ?? "").length <= 2048, `${t.name} description too long`);
    const instructions = h.client.getInstructions?.() ?? "";
    assert.ok(instructions.length > 100 && instructions.length <= 2048, `instructions length ${instructions.length}`);
    const { resources } = await h.client.listResources();
    assert.deepEqual(resources.map(r => r.uri).sort(), [
      "tupaia://docs/cheatsheet.md",
      "tupaia://docs/data-model.md",
      "tupaia://docs/runtime-api.md"
    ]);
    const rt = await h.client.readResource({ uri: "tupaia://docs/runtime-api.md" });
    const text = (rt.contents[0] as { text?: string }).text ?? "";
    assert.ok(text.length > 1000 && text.includes("Runtime API"), "runtime-api resource is empty");
    const dm = await h.client.readResource({ uri: "tupaia://docs/data-model.md" });
    assert.match((dm.contents[0] as { text?: string }).text ?? "", /notes use the key `id`/);
    assert.equal(chromeDescendants(h.pid).length, 0, "browser must not launch before the first tool call");
  });

  test("b. session status launches the browser", async () => {
    const s = await h.ok("session", { action: "status" });
    assert.equal(s.browser, "ready");
    assert.equal(s.mode, "local");
    assert.equal(s.liveOrigin, "none");
    assert.equal(s.appVersion, "1.130.1");
    assert.ok(chromeDescendants(h.pid).length > 0, "chrome should be running now");
    const sm = await h.ok("session", { action: "set_mode", mode: "local" });
    assert.equal(sm.mode, "local");
    const live = await h.call("session", { action: "set_mode", mode: "live" });
    assert.equal(live.isError, true, "set_mode live must be impossible");
  });

  test("c. load_map demo.map", async () => {
    const r = await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    assert.equal(r.name, "Chanland");
    const counts = r.counts as Record<string, number>;
    assert.equal(counts.states, 20); // pack.states.length 21 incl. Neutrals
    assert.equal(counts.burgs, 753); // pack.burgs.length 754 incl. placeholder 0
    assert.equal((r.origin as Record<string, unknown>).kind, "file");
    const shared = await h.call("load_map", { source: "shared" });
    assert.equal(shared.isError, true);
    assert.equal(errorBody(shared).error.code, "MODE");
  });

  test("d. map_info counts agree with eval", async () => {
    const info = await h.ok("map_info", { since: "none" });
    const ev = await h.ok("eval", {
      code: "({states: pack.states.filter(s => s.i && !s.removed).length, burgs: pack.burgs.filter(b => b && b.i && !b.removed).length, total: pack.states.length})",
      readOnly: true
    });
    const v = ev.value as Record<string, number>;
    const counts = info.counts as Record<string, number>;
    assert.equal(counts.states, v.states);
    assert.equal(counts.burgs, v.burgs);
    assert.equal(v.total, 21);
    assert.equal((info.graph as Record<string, number>).w, 1680);
  });

  test("e. snapshot take 'base'", async () => {
    const r = await h.ok("snapshot", { action: "take", label: "base" });
    const taken = r.taken as Record<string, unknown>;
    assert.equal(taken.label, "base");
    assert.ok((taken.bytes as number) > 1_000_000);
    const list = await h.ok("snapshot", { action: "list" });
    assert.equal((list.snapshots as unknown[]).length, 1);
    assert.equal((list.undo as Array<{ op: string }>)[0]?.op, "load_map");
  });

  test("f. find exact / NOT_FOUND candidates / AMBIGUOUS", async () => {
    const all = await h.ok("find", { type: "burg", limit: 1000, fields: [] });
    const rows = all.rows as Array<{ i: number; name: string; x: number; y: number }>;
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
    const unique = rows.filter(r => counts.get(r.name) === 1 && r.x > 300 && r.x < 1380 && r.y > 200 && r.y < 650);
    burg = unique[0];
    const other = unique[1];
    assert.ok(burg && other, "need two unique interior burgs");

    const one = await h.ok("find", { type: "burg", name: burg.name });
    assert.equal(one.total, 1);
    assert.equal((one.rows as Array<{ i: number }>)[0].i, burg.i);

    const typo = `${burg.name.slice(0, -1)}${burg.name.endsWith("x") ? "q" : "x"}`;
    const nf = await h.call("inspect", { entity: { type: "burg", ref: typo } });
    assert.equal(nf.isError, true);
    const nfBody = errorBody(nf);
    assert.equal(nfBody.error.code, "NOT_FOUND");
    assert.ok(
      nfBody.error.candidates?.some(c => c.name === burg.name),
      `candidates should include ${burg.name}`
    );
    const nf2 = await h.call("find", { type: "burg", name: "Zzqxwv Nowhere" });
    assert.equal(errorBody(nf2).error.code, "NOT_FOUND");

    // make a duplicate name (undoable eval), check AMBIGUOUS, then undo
    await h.ok("eval", { code: `pack.burgs[${other.i}].name = ${JSON.stringify(burg.name)}; return true` });
    const amb = await h.call("inspect", { entity: { type: "burg", ref: burg.name } });
    assert.equal(amb.isError, true);
    const ambBody = errorBody(amb);
    assert.equal(ambBody.error.code, "AMBIGUOUS");
    assert.deepEqual(
      ambBody.error.candidates?.map(c => c.i).sort((a, b) => Number(a) - Number(b)),
      [burg.i, other.i].sort((a, b) => a - b)
    );
    const two = await h.ok("find", { type: "burg", name: burg.name });
    assert.equal(two.total, 2);
    const undo = await h.ok("snapshot", { action: "undo" });
    assert.equal((undo.undone as Array<{ op: string }>)[0].op, "eval");
    const back = await h.ok("find", { type: "burg", name: burg.name });
    assert.equal(back.total, 1);
  });

  test("g. inspect entity / lat-lon / xy agree", async () => {
    const e = await h.ok("inspect", { entity: { type: "burg", ref: burg.i } });
    assert.equal(e.name, burg.name);
    assert.equal(typeof e.lat, "number");
    assert.equal(typeof e.lon, "number");
    const rel = e.relations as Record<string, unknown>;
    assert.ok(rel.state && rel.culture, "burg relations");
    const byLL = await h.ok("inspect", { at: { lat: e.lat, lon: e.lon } });
    const byXY = await h.ok("inspect", { at: { x: e.x, y: e.y } });
    assert.equal(byLL.cell, e.cell);
    assert.equal(byXY.cell, e.cell);
    assert.equal((byXY.burg as { i: number }).i, burg.i);
    const oob = await h.call("inspect", { at: { x: -10, y: 5 } });
    assert.equal(errorBody(oob).error.code, "OUT_OF_BOUNDS");
    const feat = await h.ok("find", { type: "feature", where: { type: "island" }, limit: 3, sort: "-cells" });
    assert.ok((feat.total as number) > 0);
    const f0 = (feat.rows as Array<{ i: number; x: number }>)[0];
    assert.equal(typeof f0.x, "number", "features have a centroid");
    const nb = await h.ok("find", { type: "namesbase", name: "Hawaiian" });
    assert.equal(nb.total, 1);
  });

  test("p. default screenshot", async () => {
    const r = await h.call("screenshot", {});
    assert.ok(!r.isError, textOf(r));
    const img = r.content.find(c => c.type === "image");
    assert.ok(img?.data, "image block");
    assert.equal(img.mimeType, "image/jpeg");
    const size = imageSize(Buffer.from(img.data, "base64"));
    assert.equal(size.type, "jpeg");
    assert.ok(Math.max(size.width, size.height) <= 1024, `returned ${size.width}x${size.height}`);
    const body = JSON.parse(textOf(r));
    assert.ok(fs.existsSync(body.file), "full PNG saved");
    assert.deepEqual(imageSize(fs.readFileSync(body.file)).width, 1280);
  });

  test("q. screenshot framed on a burg at zoom 8", async () => {
    const r = await h.ok("screenshot", { target: { entity: { type: "burg", ref: burg.i } }, zoom: 8 });
    shotQ = r.shotId as string;
    const view = r.view as { scale: number };
    assert.ok(Math.abs(view.scale - 8) < 0.01, `scale ${view.scale}`);
    const info = await h.ok("map_info", { since: "none" });
    assert.ok(Math.abs((info.view as { scale: number }).scale - 8) < 0.01);
    const [x0, y0, x1, y1] = r.mapBboxShown as number[];
    assert.ok(burg.x >= x0 && burg.x <= x1 && burg.y >= y0 && burg.y <= y1, "burg inside the shown bbox");
    // point-and-act: the image centre maps back to (about) the burg
    const at = await h.ok("inspect", {
      at: { screen: [(r.width as number) / 2, (r.height as number) / 2], shot: shotQ }
    });
    assert.ok(Math.hypot((at.x as number) - burg.x, (at.y as number) - burg.y) < 3, `screen centre -> ${at.x},${at.y}`);
  });

  test("r. screenshot bbox, full map, scale 2, view reuse and compare", async () => {
    const bbox = [400, 200, 800, 500];
    const r = await h.ok("screenshot", { target: { bbox } });
    const [x0, y0, x1, y1] = r.mapBboxShown as number[];
    assert.ok(x0 <= 400 && y0 <= 200 && x1 >= 800 && y1 >= 500, `shown ${r.mapBboxShown}`);
    assert.ok(x1 - x0 < 1000, "framed tighter than the whole map");

    const full = await h.ok("screenshot", { full: true });
    assert.deepEqual(full.png, { width: 1680, height: 849 });
    assert.ok(Math.max(full.width as number, full.height as number) <= 1024);

    const big = await h.ok("screenshot", { scale: 2, format: "png", maxSide: 512 });
    assert.deepEqual(big.png, { width: 2560, height: 1440 });
    assert.equal(big.format, "image/png");

    const same = await h.ok("screenshot", { compare: shotQ });
    const cmp = same.compare as { changedPct: number; diffFile: string };
    assert.ok(cmp.changedPct < 1, `unchanged view differs by ${cmp.changedPct}%`);
    assert.ok(fs.existsSync(cmp.diffFile));
    // demo.map ships with empty label groups, so hide a layer it does draw: the heightmap
    const noHeight = await h.ok("screenshot", { compare: shotQ, layers: { off: ["heightmap"] } });
    assert.ok((noHeight.compare as { changedPct: number }).changedPct > 0.05, "hiding the heightmap changes pixels");
    const layers = await h.ok("eval", { code: "layerIsOn('toggleHeight')", readOnly: true });
    assert.equal(layers.value, true, "temporary layer change reverted");
    const reuse = await h.ok("screenshot", { view: shotQ });
    assert.ok(Math.abs((reuse.view as { scale: number }).scale - 8) < 0.01);
  });

  test("s. undo right after an edit restores the checkpoint state; redo replays", async () => {
    await h.ok("map_info", { since: "none" }); // sets checkpoint
    await h.ok("eval", {
      code: `pack.burgs[${burg.i}].name = "Renamed by test"; drawBurgLabel(pack.burgs[${burg.i}]); return 1`
    });
    const changed = await h.ok("map_info"); // default since: newest undo point (before the eval)
    assert.equal(changed.changed, true);
    const mod = ((
      changed.changes as Record<string, { modified: Array<{ i: number; fields: Record<string, unknown> }> }>
    ).burg.modified ?? [])[0];
    assert.equal(mod.i, burg.i);
    assert.deepEqual(mod.fields.name, [burg.name, "Renamed by test"]);
    await h.ok("map_info", { since: "none" }); // checkpoint now includes the rename
    await h.ok("snapshot", { action: "undo" });
    const redo = await h.ok("snapshot", { action: "redo" });
    assert.equal((redo.redone as Array<{ op: string }>)[0].op, "eval");
    const after = await h.ok("map_info", { since: "checkpoint" });
    assert.equal(after.changed, false, JSON.stringify(after.changes).slice(0, 500));
    // and undo once more brings the original name back
    await h.ok("map_info", { since: "none" });
    await h.ok("snapshot", { action: "undo" });
    const name = await h.ok("eval", { code: `pack.burgs[${burg.i}].name`, readOnly: true });
    assert.equal(name.value, burg.name);
  });

  test("t. restore 'base' then map_info since 'base' is empty", async () => {
    const r = await h.ok("snapshot", { action: "restore", label: "base" });
    assert.equal((r.restored as { label: string }).label, "base");
    const info = await h.ok("map_info", { since: "base" });
    assert.equal(info.changed, false, JSON.stringify(info.changes).slice(0, 800));
    const list = await h.ok("snapshot", { action: "list" });
    assert.equal((list.undo as Array<{ op: string }>)[0].op, "snapshot restore");
  });

  test("w. eval semantics, firewall, console errors, alerts", async () => {
    const n = await h.ok("eval", { code: "pack.burgs.length", readOnly: true });
    assert.equal(n.value, 754);
    const arr = await h.ok("eval", { code: "return pack.cells.h", readOnly: true });
    assert.ok(Array.isArray(arr.value) && (arr.value as number[]).length === 7462);
    const withArgs = await h.ok("eval", { code: "args.a + args.b", args: { a: 2, b: 3 }, readOnly: true });
    assert.equal(withArgs.value, 5);
    const thrown = await h.call("eval", { code: "throw new Error('x')", readOnly: true });
    assert.equal(thrown.isError, true);
    const tb = errorBody(thrown);
    assert.equal(tb.error.code, "EVAL_ERROR");
    assert.equal(tb.error.message, "x");
    const probe = await h.ok("eval", { code: "console.error('probe'); return 1", readOnly: true });
    assert.deepEqual(probe.consoleErrors, ["probe"]);
    const put = await h.ok("eval", {
      code: "fetch('/api/map/shared', {method: 'PUT', body: 'x'}).then(r => r.status)",
      readOnly: true
    });
    assert.equal(put.value, 403);
    const putOther = await h.ok("eval", {
      code: "fetch('https://example.invalid/api/map/shared', {method: 'POST', body: 'x'}).then(r => r.status)",
      readOnly: true
    });
    assert.equal(putOther.value, 403, "non-GET /api to any host is refused in the page");
    const get = await h.ok("eval", { code: "fetch('/api/map/shared/meta').then(r => r.status)", readOnly: true });
    assert.equal(get.value, 404, "local mode: page GET /api is 404");
    const status = await h.ok("session", {});
    assert.deepEqual(status.outwardRequests, [], "no outward requests in local mode with origin none");
    const blocked = (status.blockedRequests as { recent: Array<{ action: string; method: string }> }).recent;
    assert.ok(blocked.some(b => b.action === "403" && b.method === "PUT"));
    const al = await h.ok("eval", {
      code: "alertMessage.innerHTML = 't'; $('#alert').dialog({title: 'T'}); return 1",
      readOnly: true
    });
    assert.deepEqual(al.alerts, [{ title: "T", text: "t", error: false }]);
    const open = await h.ok("eval", { code: "$('#alert').dialog('isOpen')", readOnly: true });
    assert.equal(open.value, false, "alert dismissed");
    const redrawn = await h.ok("eval", { code: "1", redraw: ["states", "borders", "states"] });
    assert.ok(Array.isArray(redrawn.redrawn) || Array.isArray(redrawn.skippedHidden));
  });

  test("raw stdout carries only JSON-RPC", async () => {
    const { bad, lines, responses } = await rawStdoutCheck([
      { name: "session", arguments: {} },
      { name: "eval", arguments: { code: "console.log('page log'); return 1", readOnly: true } }
    ]);
    assert.deepEqual(bad, []);
    assert.ok(lines.length >= 4);
    assert.ok(
      responses.every(r => !("error" in r)),
      JSON.stringify(responses).slice(0, 300)
    );
    assert.deepEqual(h.protocolErrors, []);
  });

  test("aa. timeout returns fast and the next call recovers", async () => {
    const t0 = Date.now();
    const r = await h.call("eval", { code: "new Promise(() => {})", timeoutMs: 2000 });
    const ms = Date.now() - t0;
    assert.equal(r.isError, true);
    assert.equal(errorBody(r).error.code, "TIMEOUT");
    assert.ok(ms < 3000, `timeout took ${ms} ms`);
    const info = await h.ok("map_info", { since: "none" });
    assert.ok(
      (info.notes as string[]).some(n => /relaunched/.test(n) && /Restored/.test(n)),
      JSON.stringify(info.notes)
    );
    assert.equal(info.name, "Chanland", "newest snapshot (the pre-eval undo point) restored");
  });

  test("bb. crash relaunches; restart restore:'latest' brings the map back", async () => {
    const c = await h.ok("session", { action: "crash" });
    assert.equal(c.crashed, true);
    const info = await h.ok("map_info", { since: "none" });
    assert.ok(
      (info.notes as string[]).some(n => /relaunched/.test(n)),
      JSON.stringify(info.notes)
    );
    const r = await h.ok("session", { action: "restart", restore: "latest" });
    assert.match(String(r.restored), /Restored/);
    const counts = (r.map as { counts: Record<string, number> }).counts;
    assert.equal(counts.states, 20);
    assert.equal(counts.burgs, 753);
  });

  test("cc. shutdown on stdin close leaves no chrome behind", async () => {
    const pids = chromeDescendants(h.pid);
    assert.ok(pids.length > 0);
    const t0 = Date.now();
    await h.close(); // ends stdin; the client only signals after 2 s, so a fast close proves EOF shutdown
    const ms = Date.now() - t0;
    assert.ok(ms < 2000, `server took ${ms} ms to exit after stdin EOF`);
    assert.ok(await waitFor(() => !alive(h.pid), 5000), "server exits within 5 s");
    assert.ok(await waitFor(() => pids.every(p => !alive(p)), 5000), "chrome processes gone");
  });
});

// Mutations layer: edit, add, paint_cells, display, regenerate, generate_map. Own server so the
// core block's shutdown test does not interfere.
describe("tupaia-mcp smoke (mutations)", () => {
  let h: Harness;
  const evalRO = async (code: string, args?: unknown) =>
    (await h.ok("eval", { code, args, readOnly: true })).value as any;
  const digest = () => evalRO("__tupaia.fns.digest().hash") as Promise<string>;
  // interior non-capital burgs with unique names: [i, name, x, y, feature, state]
  let plain: Array<{ i: number; name: string; x: number; y: number; feature: number; state: number }> = [];

  before(async () => {
    h = await startServer();
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    plain = await evalRO(`
      const counts = {};
      for (const b of pack.burgs) if (b && b.i && !b.removed) counts[b.name] = (counts[b.name] || 0) + 1;
      return pack.burgs.filter(b => b && b.i && !b.removed && !b.capital && counts[b.name] === 1
        && b.x > 200 && b.x < 1480 && b.y > 150 && b.y < 700 && !pack.markets?.some(m => m.centerBurgId === b.i))
        .map(b => ({ i: b.i, name: b.name, x: b.x, y: b.y, feature: b.feature, state: b.state }));`);
    assert.ok(plain.length > 20);
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("tools are listed", async () => {
    const { tools } = await h.client.listTools();
    const names = tools.map(t => t.name);
    for (const n of ["edit", "add", "paint_cells", "generate_map", "regenerate", "display"])
      assert.ok(names.includes(n), `missing tool ${n}`);
    for (const t of tools) assert.ok((t.description ?? "").length <= 2048, `${t.name} description too long`);
  });

  test("h. edit burg batch of 3: dryRun changes nothing; real call renames and relabels", async () => {
    const [a, b, c] = plain;
    const ops = [
      { ref: a.name, set: { name: "Alphaburg" } },
      { ref: b.name, set: { name: "Betaburg", population: 4321 } },
      { ref: c.i, set: { name: "Gammaburg" } }
    ];
    await h.ok("map_info", { since: "none" }); // checkpoint
    const before = await digest();
    const dry = await h.ok("edit", { type: "burg", ops, dryRun: true });
    assert.equal(dry.dryRun, true);
    const plan = dry.plan as Array<{ before: { name: string }; after: { name: string } }>;
    assert.equal(plan.length, 3);
    assert.equal(plan[0].after.name, "Alphaburg");
    assert.equal(await digest(), before, "dryRun must leave the digest unchanged");
    const still = await h.ok("map_info", { since: "checkpoint" });
    assert.equal(still.changed, false);

    const r = await h.ok("edit", { type: "burg", ops });
    assert.equal((r.applied as unknown[]).length, 3);
    const mod = (r.changes as { burg: { counts: { modified: number } } }).burg.counts.modified;
    assert.equal(mod, 3);
    const labels = await evalRO("args.map(i => burgLabels.select('#burgLabel' + i).text())", [a.i, b.i, c.i]);
    assert.deepEqual(labels, ["Alphaburg", "Betaburg", "Gammaburg"]);
    const pop = await evalRO(`__tupaia.internals.people(pack.burgs[${b.i}])`);
    assert.ok(Math.abs(pop - 4321) <= 2, `population ${pop}`);
    const list = await h.ok("snapshot", { action: "list" });
    assert.equal((list.undo as Array<{ op: string }>)[0].op, "edit burg");
  });

  test("name generation from namesbase Hawaiian gives non-empty distinct names", async () => {
    const ids = plain.slice(3, 7).map(b => b.i);
    const r = await h.ok("edit", {
      type: "burg",
      ops: ids.map(i => ({ ref: i, set: { name: { generate: { base: "Hawaiian" } } } }))
    });
    const names = (r.applied as Array<{ after: { name: string } }>).map(x => x.after.name);
    assert.equal(names.length, 4);
    for (const n of names) assert.ok(typeof n === "string" && n.length > 0);
    assert.equal(new Set(names).size, 4, `names should be distinct: ${names}`);
  });

  test("continueOnError applies the valid ops and reports the invalid ones", async () => {
    const strict = await h.call("edit", {
      type: "burg",
      ops: [
        { ref: 999999, set: { name: "Nope" } },
        { ref: plain[8].i, set: { name: "Deltaburg" } }
      ]
    });
    assert.equal(errorBody(strict).error.code, "NOT_FOUND");
    assert.equal(await evalRO(`pack.burgs[${plain[8].i}].name`), plain[8].name, "nothing applied");
    const r = await h.ok("edit", {
      type: "burg",
      continueOnError: true,
      ops: [
        { ref: 999999, set: { name: "Nope" } },
        { ref: plain[8].i, set: { name: "Deltaburg" } }
      ]
    });
    assert.equal((r.applied as unknown[]).length, 1);
    assert.deepEqual(
      (r.errors as Array<{ index: number; code: string }>).map(e => [e.index, e.code]),
      [[0, "NOT_FOUND"]]
    );
    assert.equal(await evalRO(`pack.burgs[${plain[8].i}].name`), "Deltaburg");
  });

  test("removing a capital via edit is refused; province removal is refused", async () => {
    const capital = await evalRO("pack.burgs.find(b => b && b.i && !b.removed && b.capital).i");
    const r = await h.call("edit", { type: "burg", ops: [{ ref: capital, remove: true }] });
    assert.equal(r.isError, true);
    const body = errorBody(r);
    assert.equal(body.error.code, "REFUSED");
    assert.match(body.error.message, /capital/);
    const still = await evalRO(`!pack.burgs[${capital}].removed`);
    assert.equal(still, true);
    const p = await h.call("edit", { type: "province", ops: [{ ref: 1, remove: true }] });
    assert.equal(errorBody(p).error.code, "REFUSED");
  });

  test("i. state colours, locked-state rename, capital change", async () => {
    await h.ok("display", { on: ["states", "borders"] });
    const states = (await evalRO(
      "pack.states.filter(s => s.i && !s.removed).slice(0, 2).map(s => ({i: s.i, name: s.name}))"
    )) as Array<{ i: number; name: string }>;
    const colors = ["#123456", "#abcdef"];
    await h.ok("edit", {
      type: "state",
      ops: states.map((s, k) => ({ ref: s.name, set: { color: colors[k] } }))
    });
    const fills = await evalRO(
      "args.map(i => document.getElementById('state' + i)?.getAttribute('fill'))",
      states.map(s => s.i)
    );
    assert.deepEqual(fills, colors);

    const s0 = states[0];
    await h.ok("edit", { type: "state", ops: [{ ref: s0.i, set: { lock: true } }] });
    const label0 = await evalRO(`document.getElementById('stateLabel${s0.i}')?.textContent ?? ''`);
    await h.ok("edit", { type: "state", ops: [{ ref: s0.i, set: { name: "Lockedland" } }] });
    const lab = await evalRO(
      `({text: document.getElementById('stateLabel${s0.i}')?.textContent ?? '', name: pack.states[${s0.i}].name, fullName: pack.states[${s0.i}].fullName})`
    );
    assert.equal(lab.name, "Lockedland");
    assert.notEqual(lab.text, label0, "the locked state's label was redrawn");
    const squash = (t: string) => t.replace(/\s+/g, "");
    assert.ok(
      [lab.name, lab.fullName].some(n => squash(n) === squash(lab.text)),
      `label '${lab.text}' shows the new name (${lab.name} / ${lab.fullName})`
    );
    const locked = await evalRO(`!!pack.states[${s0.i}].lock`);
    assert.equal(locked, true, "the lock survives the label redraw");

    // capital change only through the state; the old capital is demoted
    const pick = await evalRO(
      `const s = pack.states[${s0.i}]; const b = pack.burgs.find(b => b && b.i && !b.removed && b.state === s.i && !b.capital); return {old: s.capital, next: b.i}`
    );
    const bad = await h.call("edit", { type: "burg", ops: [{ ref: pick.next, set: { capital: true } }] });
    assert.equal(errorBody(bad).error.code, "BAD_ARGS");
    await h.ok("edit", { type: "state", ops: [{ ref: s0.i, set: { capital: pick.next } }] });
    const after = await evalRO(
      `({cap: pack.states[${s0.i}].capital, center: pack.states[${s0.i}].center, cell: pack.burgs[${pick.next}].cell, newCap: pack.burgs[${pick.next}].capital, oldCap: pack.burgs[${pick.old}].capital})`
    );
    assert.equal(after.cap, pick.next);
    assert.equal(after.center, after.cell);
    assert.equal(after.newCap, 1);
    assert.equal(after.oldCap, 0);
  });

  test("j. paint_cells state on a circle; centres stay; provinces stay consistent", async () => {
    const target = plain.find(b => b.state > 0) as (typeof plain)[number];
    const other = await evalRO(`pack.states.find(s => s.i && !s.removed && s.i !== ${target.state}).i`);
    const centersBefore = await evalRO(
      "pack.states.filter(s => s.i && !s.removed).map(s => [s.i, s.center, pack.cells.state[s.center]])"
    );
    // a circle around a capital too, to prove centre cells are skipped
    const cap = await evalRO(`pack.burgs[pack.states[${target.state}].capital]`);
    const r = await h.ok("paint_cells", {
      select: { cells: [cap.cell], circle: { at: { entity: { type: "burg", ref: target.i } }, radius: 30 } },
      set: { state: other }
    });
    const st = (
      r.set as { state: { changed: number; byPrevious: Record<string, number>; skipped: Record<string, number> } }
    ).state;
    assert.ok(st.changed > 0, "some cells change");
    const sum = Object.values(st.byPrevious).reduce((s, v) => s + v, 0);
    assert.equal(sum, st.changed);
    assert.ok((st.skipped.stateCenter ?? 0) + (st.skipped.capital ?? 0) >= 1, "the capital cell is skipped");
    const changedCells = await evalRO(`pack.cells.state.filter(s => s === ${other}).length`);
    assert.ok(changedCells > 0);
    const centersAfter = await evalRO(
      "pack.states.filter(s => s.i && !s.removed).map(s => [s.i, s.center, pack.cells.state[s.center]])"
    );
    assert.deepEqual(centersAfter, centersBefore, "state centres never move");
    const bad = await evalRO(`
      const bad = [];
      for (const p of pack.provinces) {
        if (!p || !p.i || p.removed) continue;
        for (let c = 0; c < pack.cells.province.length; c++)
          if (pack.cells.province[c] === p.i && pack.cells.state[c] !== p.state) { bad.push([p.i, c]); break; }
      }
      return bad;`);
    assert.deepEqual(bad, [], "every province's cells belong to its state");
  });

  test("k. paint_cells height keep: delta +5 changes grid heights in the selection only", async () => {
    const at = plain[10];
    const sel = { circle: { at: { x: at.x, y: at.y }, radius: 25 }, where: { land: true, hMax: 90 } };
    const cells = (
      await h.ok("eval", {
        code: "__tupaia.fns.selectCells({select: args}).cells.map(c => pack.cells.g[c])",
        args: sel,
        readOnly: true
      })
    ).value as number[];
    assert.ok(cells.length > 0);
    const before = (await evalRO("Array.from(grid.cells.h)")) as number[];
    const r = await h.ok("paint_cells", { select: sel, set: { height: { delta: 5 } } });
    assert.ok(((r.set as { height: { changed: number } }).height.changed ?? 0) > 0);
    const afterH = (await evalRO("Array.from(grid.cells.h)")) as number[];
    const inSel = new Set(cells);
    for (let g = 0; g < afterH.length; g++) {
      if (inSel.has(g)) assert.equal(afterH[g], Math.min(100, before[g] + 5), `grid cell ${g}`);
      else assert.equal(afterH[g], before[g], `grid cell ${g} outside the selection changed`);
    }
  });

  test("paint_cells keep mode refuses a change that crosses height 20", async () => {
    const at = plain[11];
    const before = await digest();
    const r = await h.call("paint_cells", {
      select: { circle: { at: { x: at.x, y: at.y }, radius: 15 } },
      set: { height: { value: 5 } }
    });
    assert.equal(r.isError, true);
    const body = errorBody(r);
    assert.equal(body.error.code, "REFUSED");
    assert.match(body.error.message, /risk/);
    assert.equal(await digest(), before);
    const erase = await h.call("paint_cells", {
      select: { cells: [at.i] },
      set: { height: { value: 50, rebuild: "erase" } }
    });
    assert.equal(errorBody(erase).error.code, "REFUSED", "erase needs confirmErase");
  });

  test("l. add a marker with a note, then remove it", async () => {
    await h.ok("display", { on: ["markers"] });
    const at = plain[12];
    const r = await h.ok("add", {
      type: "marker",
      items: [
        {
          at: { x: at.x + 3, y: at.y + 3 },
          type: "test-marker",
          icon: "T",
          note: { name: "Test cairn", legend: "<p>x</p>" }
        }
      ]
    });
    const m = (r.created as Array<{ i: number; name: string }>)[0];
    assert.equal(m.name, "Test cairn");
    const present = await evalRO(
      `({el: !!document.getElementById('marker${m.i}'), note: notes.find(n => n.id === 'marker${m.i}')?.legend})`
    );
    assert.deepEqual(present, { el: true, note: "<p>x</p>" });
    await h.ok("edit", { type: "marker", ops: [{ ref: m.i, remove: true }] });
    const gone = await evalRO(
      `({el: !!document.getElementById('marker${m.i}'), note: notes.some(n => n.id === 'marker${m.i}'), data: pack.markers.some(x => x.i === ${m.i})})`
    );
    assert.deepEqual(gone, { el: false, note: false, data: false });
  });

  test("m. add a route through two burgs: links symmetric, path drawn", async () => {
    await h.ok("display", { on: ["routes"] });
    const pair = await evalRO(`
      const B = pack.burgs.filter(b => b && b.i && !b.removed && pack.cells.h[b.cell] >= 20);
      for (const a of B) for (const b of B) {
        if (a.i >= b.i || a.feature !== b.feature) continue;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 60 && d < 120) return [a.i, b.i];
      }
      return null;`);
    assert.ok(pair, "need two burgs on the same landmass");
    const n0 = await evalRO("pack.routes.length");
    const r = await h.ok("add", {
      type: "route",
      items: [
        {
          through: [{ entity: { type: "burg", ref: pair[0] } }, { entity: { type: "burg", ref: pair[1] } }],
          group: "trails",
          name: "Test trail"
        }
      ]
    });
    const route = (r.created as Array<{ i: number; length: Record<string, number>; cells: number }>)[0];
    assert.ok(route.length.px > 0 && route.cells >= 2);
    const check = await evalRO(`
      const r = pack.routes.find(x => x.i === ${route.i});
      const cells = r.points.map(p => p[2]);
      let symmetric = true;
      for (let k = 0; k < cells.length - 1; k++) {
        const a = cells[k], b = cells[k + 1];
        if (pack.cells.routes[a]?.[b] !== r.i || pack.cells.routes[b]?.[a] !== r.i) symmetric = false;
      }
      return {n: pack.routes.length, symmetric, drawn: !!document.getElementById('route' + r.i), name: r.name};`);
    assert.equal(check.n, n0 + 1);
    assert.equal(check.symmetric, true);
    assert.equal(check.drawn, true);
    assert.equal(check.name, "Test trail");
    // a route between different landmasses explains why there is no path
    const far = await evalRO(`
      const B = pack.burgs.filter(b => b && b.i && !b.removed);
      const a = B[0]; const b = B.find(x => x.feature !== a.feature && pack.features[x.feature]?.type === 'island');
      return b ? [a.i, b.i] : null;`);
    if (far) {
      const np = await h.call("add", {
        type: "route",
        items: [{ through: [{ entity: { type: "burg", ref: far[0] } }, { entity: { type: "burg", ref: far[1] } }] }]
      });
      assert.equal(errorBody(np).error.code, "NO_PATH");
    }
  });

  test("n. add a burg at lat/lon, then remove it", async () => {
    const spot = await evalRO(`
      const used = new Set(pack.burgs.filter(b => b && b.i && !b.removed).map(b => b.cell));
      const c = pack.cells.i.find(c => pack.cells.h[c] >= 25 && !used.has(c) && pack.cells.c[c].every(n => !used.has(n)) && pack.cells.p[c][0] > 300);
      return {cell: c, x: pack.cells.p[c][0], y: pack.cells.p[c][1]};`);
    const ll = await h.ok("inspect", { at: { cell: spot.cell } });
    const r = await h.ok("add", {
      type: "burg",
      items: [{ at: { lat: ll.lat, lon: ll.lon }, name: "Testopolis", population: 2000 }]
    });
    const b = (r.created as Array<{ i: number; name: string; cell: number }>)[0];
    assert.equal(b.name, "Testopolis");
    assert.equal(b.cell, spot.cell);
    const found = await h.ok("find", { type: "burg", name: "Testopolis" });
    assert.equal(found.total, 1);
    const dup = await h.call("add", { type: "burg", items: [{ at: { cell: spot.cell } }] });
    assert.equal(errorBody(dup).error.code, "REFUSED");
    await h.ok("edit", { type: "burg", ops: [{ ref: "Testopolis", remove: true }] });
    const gone = await h.call("find", { type: "burg", name: "Testopolis" });
    assert.equal(gone.isError, true);
  });

  test("add state, zone, label, note; edit label and map", async () => {
    const spot = await evalRO(`
      const used = new Set(pack.burgs.filter(b => b && b.i && !b.removed).map(b => b.cell));
      const c = pack.cells.i.find(c => pack.cells.h[c] >= 25 && pack.cells.state[c] > 0 && !used.has(c) && pack.cells.p[c][0] > 600);
      return {cell: c};`);
    const st = await h.ok("add", {
      type: "state",
      items: [{ capital: { cell: spot.cell }, name: "Testonia", color: "#884422" }]
    });
    const s = (st.created as Array<{ i: number; name: string; center: number }>)[0];
    assert.equal(s.name, "Testonia");
    assert.equal(s.center, spot.cell);
    const sv = await evalRO(
      `({cell: pack.cells.state[${spot.cell}], cap: pack.burgs[pack.states[${s.i}].capital].capital})`
    );
    assert.deepEqual(sv, { cell: s.i, cap: 1 });
    const z = await h.ok("add", {
      type: "zone",
      items: [{ name: "Test zone", type: "Disease", select: { circle: { at: { cell: spot.cell }, radius: 20 } } }]
    });
    assert.ok((z.created as Array<{ cells: number }>)[0].cells > 0);
    const l = await h.ok("add", { type: "label", items: [{ at: { cell: spot.cell }, text: "Here be tests" }] });
    const lid = (l.created as Array<{ i: string }>)[0].i;
    await h.ok("edit", { type: "label", ops: [{ ref: lid, set: { text: "Renamed label" } }] });
    const lt = await evalRO(`document.getElementById('${lid}').textContent`);
    assert.equal(lt, "Renamed label");
    await h.ok("add", {
      type: "note",
      items: [{ entity: { type: "state", ref: s.i }, name: "Testonia", legend: "A test state" }]
    });
    const note = await evalRO(`notes.find(n => n.id === 'stateLabel${s.i}')?.legend`);
    assert.equal(note, "A test state");
    await h.ok("edit", { type: "map", ops: [{ set: { name: "Testmap", year: 1234 } }] });
    const m = await evalRO("({name: mapName.value, year: options.year})");
    assert.deepEqual(m, { name: "Testmap", year: 1234 });
    // removing the new state goes through the app's stateRemove
    await h.ok("edit", { type: "state", ops: [{ ref: s.i, remove: true }] });
    const removed = await evalRO(`!!pack.states[${s.i}].removed && pack.cells.state[${spot.cell}] !== ${s.i}`);
    assert.equal(removed, true);
  });

  test("o. display off labels is idempotent; on restores; stylePreset atlas applies", async () => {
    const r1 = await h.ok("display", { off: ["labels"] });
    assert.deepEqual(r1.changed, [{ layer: "labels", to: "off" }]);
    assert.equal(await evalRO("layerIsOn('toggleLabels')"), false);
    const r2 = await h.ok("display", { off: ["labels"] });
    assert.deepEqual(r2.changed, []);
    const r3 = await h.ok("display", { on: ["labels"], stylePreset: "atlas" });
    assert.deepEqual(r3.changed, [{ layer: "labels", to: "on" }]);
    assert.equal(await evalRO("layerIsOn('toggleLabels')"), true);
    assert.equal(await evalRO("localStorage.getItem('presetStyle')"), "atlas");
    const bad = await h.call("display", { stylePreset: "nope" });
    assert.equal(errorBody(bad).error.code, "BAD_ARGS");
    const only = await h.ok("display", { only: ["states", "borders", "labels"] });
    assert.deepEqual([...(only.layersOn as string[])].sort(), ["borders", "labels", "states"]);
  });

  test("x. eval with redraw lists the redrawn layers", async () => {
    const r = await h.ok("eval", { code: "1", redraw: ["states", "borders"] });
    const all = [...((r.redrawn as unknown[]) ?? []), ...((r.skippedHidden as unknown[]) ?? [])];
    assert.ok(all.includes("states") && all.includes("borders"), JSON.stringify(r));
  });

  test("u. regenerate routes and zones", async () => {
    const r = await h.ok("regenerate", { parts: ["zones", "routes"] });
    assert.deepEqual(r.ran, ["routes", "zones"]);
    const ch = r.changes as Record<string, { counts: Record<string, number> }>;
    assert.ok(ch.route, "routes changed");
    const c = ch.route.counts;
    assert.ok(c.added + c.removed + c.modified > 0);
    const list = await h.ok("snapshot", { action: "list" });
    assert.equal((list.undo as Array<{ op: string }>)[0].op, "regenerate");
  });

  test("paint_cells risk mode turns a lake into land and rebuilds features", async () => {
    const lake = await evalRO(
      "pack.features.filter(f => f && f.type === 'lake').sort((a, b) => a.cells - b.cells)[0]?.i"
    );
    assert.ok(lake, "the demo map has lakes");
    const lakeCell = await evalRO(`pack.cells.i.find(c => pack.cells.f[c] === ${lake})`);
    const g = await evalRO(`pack.cells.g[${lakeCell}]`);
    const lakes0 = await evalRO("pack.features.filter(f => f && f.type === 'lake').length");
    const r = await h.ok("paint_cells", {
      select: { entity: { type: "feature", ref: lake } },
      set: { height: { value: 25, rebuild: "risk" } }
    });
    const hs = (r.set as { height: { features: { before: { lakes: number }; after: { lakes: number } } } }).height;
    assert.ok(hs.features.after.lakes < hs.features.before.lakes, JSON.stringify(hs.features));
    const after = await evalRO(`
      const c = pack.cells.i.find(c => pack.cells.g[c] === ${g});
      return {h: pack.cells.h[c], type: pack.features[pack.cells.f[c]].type, lakes: pack.features.filter(f => f && f.type === 'lake').length, gh: grid.cells.h[${g}]};`);
    assert.ok(after.h >= 20, `cell is land now (h ${after.h})`);
    assert.equal(after.type, "island");
    assert.equal(after.gh, 25);
    assert.equal(after.lakes, lakes0 - 1);
  });

  test("v. generate_map twice with the same args gives the same digest", async () => {
    const args = {
      seed: "mcp-test",
      template: "continents",
      cells: 4,
      states: 7,
      cultures: 5,
      width: 1280,
      height: 720
    };
    const g1 = await h.ok("generate_map", args);
    const d1 = await evalRO("__tupaia.fns.digest()");
    const g2 = await h.ok("generate_map", args);
    const d2 = await evalRO("__tupaia.fns.digest()");
    assert.equal(g1.seed, "mcp-test");
    assert.equal(g2.seed, g1.seed);
    const differs = [
      ...Object.keys(d1.types).filter(k => d1.types[k] !== d2.types[k]),
      ...Object.keys(d1.cells)
        .filter(k => d1.cells[k] !== d2.cells[k])
        .map(k => `cells.${k}`)
    ];
    assert.equal(g2.digest, g1.digest, `differs: ${differs.join(", ")}`);
    const counts = g2.counts as Record<string, number>;
    assert.equal(counts.states, 7);
    assert.equal(counts.cultures, 5);
    assert.equal(g2.template, "continents");
    assert.deepEqual(g2.graph, { w: 1280, h: 720 });
    assert.equal((g2.origin as { kind: string }).kind, "generated");
    const tpl = await evalRO("document.getElementById('templateInput').value");
    assert.equal(tpl, "continents");
    // options no longer given are unlocked again
    const g3 = await h.ok("generate_map", { seed: "mcp-test-2" });
    assert.deepEqual(
      [...(g3.unlocked as string[])].sort(),
      ["culturesSet", "cultures", "points", "statesNumber", "template"].sort()
    );
    const undo = await h.ok("snapshot", { action: "undo" });
    assert.equal((undo.undone as Array<{ op: string }>)[0].op, "generate_map");
  });

  test("no outward requests from the mutation tools", async () => {
    const status = await h.ok("session", {});
    assert.deepEqual(status.outwardRequests, []);
  });
});

// Persistence layer: save_map and export (plan items y, z) plus the final 19-tool surface.
describe("tupaia-mcp smoke (persistence)", () => {
  let h: Harness;
  const outside: string[] = [];

  before(async () => {
    h = await startServer();
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
  });

  after(async () => {
    for (const f of outside) fs.rmSync(f, { force: true });
    if (h && alive(h.pid)) await h.close();
  });

  test("a. exactly the 19 tools; shared writes annotated destructive + open world", async () => {
    const { tools } = await h.client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), [...ALL_TOOLS].sort());
    for (const t of tools) assert.ok((t.description ?? "").length <= 2048, `${t.name} description too long`);
    for (const n of ["shared_save", "shared_restore"]) {
      const t = tools.find(x => x.name === n);
      assert.equal(t?.annotations?.destructiveHint, true, `${n} destructive`);
      assert.equal(t?.annotations?.openWorldHint, true, `${n} openWorld`);
    }
    assert.equal(tools.find(x => x.name === "shared_status")?.annotations?.readOnlyHint, true);
  });

  test("y. save_map writes a .map that loads back; overwrite and path policy", async () => {
    const r = await h.ok("save_map", { path: "saved/demo-copy.map" });
    const file = r.path as string;
    assert.ok(file.startsWith(fs.realpathSync(h.env.TUPAIA_OUT)), `${file} under TUPAIA_OUT`);
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /^1\.130\.1\|/);
    assert.equal(r.bytes, Buffer.byteLength(text));
    assert.equal(r.sha256, crypto.createHash("sha256").update(text).digest("hex"));

    const before = await h.ok("map_info", { since: "none" });
    const loaded = await h.ok("load_map", { path: file });
    assert.equal(loaded.name, "Chanland");
    assert.deepEqual(loaded.counts, before.counts);

    const again = await h.call("save_map", { path: "saved/demo-copy.map" });
    assert.equal(errorBody(again).error.code, "REFUSED");
    assert.match(errorBody(again).error.message, /overwrite:true/);
    const over = await h.ok("save_map", { path: "saved/demo-copy.map", overwrite: true });
    assert.equal(over.path, file);

    for (const p of ["tests/fixtures/x.map", path.join(REPO_ROOT, "tests", "fixtures", "demo.map")]) {
      const f = await h.call("save_map", { path: p, overwrite: true, allowOutside: true });
      assert.equal(errorBody(f).error.code, "REFUSED", p);
      assert.match(errorBody(f).error.message, /tests\/fixtures/);
    }
    const ext = await h.call("save_map", { path: "saved/demo.txt" });
    assert.equal(errorBody(ext).error.code, "REFUSED");
    const out = path.join(os.tmpdir(), `tupaia-outside-${process.pid}.map`);
    outside.push(out);
    const o1 = await h.call("save_map", { path: out });
    assert.equal(errorBody(o1).error.code, "REFUSED");
    assert.match(errorBody(o1).error.message, /allowOutside/);
    assert.equal(fs.existsSync(out), false);
    await h.ok("save_map", { path: out, allowOutside: true });
    assert.ok(fs.statSync(out).size > 1_000_000);
    const src = await h.call("save_map", { path: path.join(REPO_ROOT, "src", "x.map") });
    assert.equal(errorBody(src).error.code, "REFUSED");
  });

  test("save_map is refused while an app editor is active", async () => {
    await h.ok("eval", { code: "customization = 1", readOnly: true });
    const r = await h.call("save_map", { path: "saved/editing.map" });
    assert.equal(errorBody(r).error.code, "REFUSED");
    assert.match(errorBody(r).error.message, /customization/);
    const e = await h.call("export", { format: "svg", path: "exports/editing.svg" });
    assert.equal(errorBody(e).error.code, "REFUSED");
    await h.ok("eval", { code: "customization = 0", readOnly: true });
  });

  test("z. export svg, png, jpeg, json-full, geojson-cells, geojson-routes", async () => {
    const svg = await h.ok("export", { format: "svg", path: "exports/map.svg" });
    const svgText = fs.readFileSync(svg.path as string, "utf8");
    assert.match(svgText.slice(0, 200), /^<\?xml/);
    assert.match(svgText, /<svg[\s>]/);
    assert.match(svgText.trimEnd(), /<\/svg>$/);
    assert.equal(svg.width, 1680);

    const png = await h.ok("export", { format: "png", path: "exports/map.png" });
    const pngBuf = fs.readFileSync(png.path as string);
    const ps = imageSize(pngBuf);
    assert.equal(ps.type, "png");
    assert.deepEqual([ps.width, ps.height], [1680, 849]);

    const jpg = await h.ok("export", { format: "jpeg", path: "exports/map.jpg", scale: 0.5 });
    const js = imageSize(fs.readFileSync(jpg.path as string));
    assert.equal(js.type, "jpeg");
    assert.deepEqual([js.width, js.height], [840, 425]);

    const wrongExt = await h.call("export", { format: "png", path: "exports/map.jpg" });
    assert.equal(errorBody(wrongExt).error.code, "REFUSED");

    const full = await h.ok("export", { format: "json-full", path: "exports/full.json" });
    const fullJson = JSON.parse(fs.readFileSync(full.path as string, "utf8"));
    assert.ok(fullJson && typeof fullJson === "object" && (full.bytes as number) > 1000);

    for (const f of ["geojson-cells", "geojson-routes"]) {
      const g = await h.ok("export", { format: f, path: `exports/${f}.geojson` });
      const gj = JSON.parse(fs.readFileSync(g.path as string, "utf8"));
      assert.equal(gj.type, "FeatureCollection", f);
      assert.ok(Array.isArray(gj.features) && gj.features.length > 0, `${f} has features`);
    }
    const def = await h.ok("export", { format: "svg" });
    assert.match(def.path as string, /exports\/.+\.svg$/);
  });

  test("no outward requests from persistence tools", async () => {
    const s = await h.ok("session", { action: "status" });
    assert.deepEqual(s.outwardRequests, []);
  });
});
