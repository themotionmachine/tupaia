// End-to-end smoke test over stdio against tests/fixtures/demo.map (core-layer tools).
// Letters refer to the verification plan in the design (stage1 VERIFY section).
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import {
  alive,
  chromeDescendants,
  errorBody,
  type Harness,
  imageSize,
  rawStdoutCheck,
  startServer,
  textOf,
  waitFor
} from "./helpers.ts";

const CORE_TOOLS = ["session", "map_info", "find", "inspect", "screenshot", "snapshot", "eval", "load_map"];

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
