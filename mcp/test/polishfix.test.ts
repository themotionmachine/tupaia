// Final fix round of the polish integration (dx/polish-integrate): the idle-restart end-to-end
// run's friction and the audit's findings.
//   - lineage across output directories: a save_map file signed with another TUPAIA_OUT's key
//     (the stdio server's default out dir vs a daemon's --out) keeps shared lineage when the shared
//     map server verifies its base; its sketch comes back blob-only (the log is not trusted); an
//     unverifiable base keeps such a file unrelated;
//   - snapshot take saveTo writes the provenance line, so the file keeps its lineage;
//   - load_map of a file holding the active sketch at the same op logs no op and no undo entry;
//   - BUILD refusals: only a clean build check is cached, so a fixed deploy passes on the next
//     preview without a restart; sketch_promote takes skipBuildCheck like shared_save;
//   - regrid territories:'regrow' at the map's own density is a regrow-only pass;
//   - test/fake-worker-serve.ts --assets/--port (the deployed build is the local dist);
//   - `tupaia tools` without a daemon starts none and creates no TUPAIA_OUT.
// Local runs and the in-process fake Worker only (never the live site).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { PROV_MARK, type ProvBlock, withTrailer } from "../src/map-provenance.ts";
import { FakeWorker } from "./fake-worker.ts";
import { alive, DEMO_MAP, errorBody, type Harness, MCP_ROOT, REPO_ROOT, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

const LOCAL_ENTRY = /src="\/(index-[^"]+\.js)"/.exec(
  fs.readFileSync(path.join(REPO_ROOT, "dist", "index.html"), "utf8")
)?.[1] as string;

/** The file's map text and its provenance block. */
function split(file: string): { text: string; block: ProvBlock } {
  const all = fs.readFileSync(file, "utf8");
  const at = all.lastIndexOf(`\r\n${PROV_MARK}`);
  assert.ok(at > 0, `${file} has a provenance line`);
  return { text: all.slice(0, at), block: JSON.parse(all.slice(at + 2 + PROV_MARK.length)) as ProvBlock };
}

/** The same file signed with another key, as the server of another TUPAIA_OUT would write it. */
function resign(file: string, out: string, change: (b: Obj) => Obj = b => b): string {
  const { text, block } = split(file);
  const { sig: _s, sha256: _h, v: _v, ...rest } = block;
  fs.writeFileSync(out, withTrailer(text, change(rest) as never, crypto.randomBytes(32)));
  return out;
}

describe("polishfix: lineage, snapshot files, same-op loads and the build check (live mode, fake Worker)", () => {
  let fake: FakeWorker;
  let h: Harness;
  let out = "";
  const status = async () => (await h.ok("shared_status", {})).local as Obj;
  const sketch = async () => await h.ok("sketch", { action: "status" });
  /** The newest undo entry (the depth is capped, so a push can evict the oldest one). */
  const undoTop = async () => JSON.stringify(((await h.ok("snapshot", { action: "list" })).undo as unknown[])[0]);

  before(async () => {
    // the deployed build differs from the local one and its entry chunk answers 404 (the stub)
    fake = new FakeWorker({ seedFile: DEMO_MAP, version: 3 });
    const origin = await fake.start();
    // the default build cache (5 min): a fixed deploy must still show on the next preview
    h = await startServer({ TUPAIA_MODE: "live", TUPAIA_LIVE_ORIGIN: origin });
    out = h.env.TUPAIA_OUT;
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
    await fake?.stop();
  });

  test("snapshot take saveTo writes the provenance line: load_map of the file keeps the lineage", async () => {
    await h.ok("load_map", { source: "shared" });
    await h.ok("edit", { type: "burg", ops: [{ ref: 1, set: { name: "Snapford" } }] });
    const t = (await h.ok("snapshot", { action: "take", label: "fx", saveTo: "fx-snap.map" })).taken as Obj;
    assert.match(String(t.lineage), /^shared v3, 1 op\(s\) since$/);
    assert.equal(split(t.savedTo).block.base?.version, 3);
    await h.ok("load_map", { path: DEMO_MAP });
    assert.equal((await status()).lineage, "unrelated");
    const l = (await h.ok("load_map", { path: t.savedTo })).lineage as Obj;
    assert.equal(l.file, "valid");
    assert.equal(l.lineage, "shared");
    assert.equal(l.baseCheck, "verified");
    const s = await status();
    assert.equal(s.lineage, "shared");
    assert.equal(s.opsSince, 1);
  });

  test("another TUPAIA_OUT's key: shared lineage only with a verified base", async () => {
    await h.ok("load_map", { source: "shared" });
    const own = (await h.ok("save_map", { path: "fx-plain.map" })).path as string;
    // verified base (the current version, same sha256): shared, with a signer note
    const f = (await h.ok("load_map", { path: resign(own, path.join(out, "fx-plain-foreign.map")) })).lineage as Obj;
    assert.equal(f.file, "foreign");
    assert.equal(f.lineage, "shared", JSON.stringify(f));
    assert.equal(f.baseCheck, "verified");
    assert.match(String(f.note), /another TUPAIA_OUT's key/);
    assert.equal((await status()).lineage, "shared");
    // a retained base whose size was not recorded cannot be verified: unrelated for a foreign file
    const unver = resign(own, path.join(out, "fx-unverifiable.map"), b => ({
      ...b,
      base: { version: 1, updatedAt: null, updatedBy: null }
    }));
    const u = (await h.ok("load_map", { path: unver })).lineage as Obj;
    assert.equal(u.file, "foreign");
    assert.equal(u.lineage, "unrelated");
    assert.equal(u.baseCheck, "unverifiable");
    assert.match(String(u.note), /verifies its base/);
    assert.equal((await status()).lineage, "unrelated");
    // a contradicted base stays unrelated too
    const bad = resign(own, path.join(out, "fx-mismatch.map"), b => ({ ...b, base: { ...b.base, version: 9 } }));
    const m = (await h.ok("load_map", { path: bad })).lineage as Obj;
    assert.equal(m.lineage, "unrelated");
    assert.equal(m.baseCheck, "mismatch");
  });

  test("a foreign file's sketch comes back blob-only; promote needs no replaceWithUnrelated", async () => {
    await h.ok("load_map", { source: "shared" });
    await h.ok("sketch", { action: "start", slug: "fx-sketch" });
    await h.ok("edit", { type: "burg", ops: [{ ref: 1, set: { name: "Foreignford" } }] });
    const own = (await h.ok("save_map", { path: "fx-sketch.map" })).path as string;
    const foreign = resign(own, path.join(out, "fx-sketch-foreign.map"));
    // leave no sketch with unsaved ops behind (another slug, stopped), so the file's sketch comes back
    await h.ok("snapshot", { action: "undo" });
    await h.ok("sketch", { action: "stop" });
    await h.ok("sketch", { action: "start", slug: "fx-other" });
    await h.ok("sketch", { action: "stop" });
    assert.equal((await sketch()).ops, 0);
    const l = (await h.ok("load_map", { path: foreign })).lineage as Obj;
    assert.equal(l.file, "foreign");
    assert.equal(l.lineage, "shared");
    assert.equal(l.sketch, "fx-sketch");
    assert.match(String(l.note), /not trusted/);
    const sk = await sketch();
    assert.equal(sk.slug, "fx-sketch");
    assert.equal(sk.ops, 1);
    assert.equal(sk.blobOnly, true);
    assert.match(JSON.stringify(sk.blobOnlyReasons), /signed with another TUPAIA_OUT's key/);
    const burg = await h.ok("eval", { code: "return pack.burgs[1].name", readOnly: true });
    assert.equal(burg.value, "Foreignford");
    const p = await h.ok("sketch_promote", {});
    assert.equal((p.lineage as Obj).related, true, JSON.stringify(p.lineage));
    assert.doesNotMatch(String(p.refusalReason ?? ""), /LINEAGE|unrelated/);
  });

  test("load_map of a file holding the active sketch at the same op logs no op and no undo entry", async () => {
    const same = (await h.ok("save_map", { path: "fx-same.map" })).path as string;
    const ops0 = (await sketch()).ops as number;
    const undo0 = await undoTop();
    const r = await h.ok("load_map", { path: same });
    assert.match(JSON.stringify(r.notes ?? r), /no op logged/);
    const sk = await sketch();
    assert.equal(sk.ops, ops0, "no op added");
    assert.equal(sk.recording, true);
    assert.equal(await undoTop(), undo0, "no undo entry");
    assert.equal((await status()).lineage, "shared");
  });

  test("BUILD: a fixed deploy passes on the next preview (no restart); sketch_promote takes skipBuildCheck", async () => {
    await h.ok("display", { on: ["relief"] });
    // a legacy reliefOnLoad map: the flag with an empty relief group (saves now keep drawn icons,
    // so only such a map needs the deployed load hook)
    await h.ok("regenerate", { parts: ["relief"], relief: { onLoad: true, density: 0 } });
    const p1 = await h.ok("sketch_promote", {});
    assert.match(String(p1.refusalReason), /relief load hook/);
    assert.match(String(p1.refusalReason), /the next preview reads it again/);
    // the human agreed to save without that check
    const p2 = await h.ok("sketch_promote", { skipBuildCheck: true });
    assert.equal(p2.refusalReason, undefined, String(p2.refusalReason));
    assert.match(String(p2.next), /sketch_promote \{confirm:true, token:'[^']+', skipBuildCheck:true\}/);
    // the deployed build is now the local one (it has the hook): no restart, no cache wait
    fake.entry = LOCAL_ENTRY;
    const p3 = await h.ok("sketch_promote", {});
    assert.equal(p3.refusalReason, undefined, String(p3.refusalReason));
    const c = await h.ok("sketch_promote", { confirm: true, token: p3.token as string });
    assert.equal((c.promoted as Obj).to, 4);
    assert.equal(fake.row.version, 4);
    assert.match(String(fake.current), /Foreignford/);
    const puts = fake.requests.filter(r => r.method === "PUT" && r.path === "/api/map/shared");
    assert.equal(puts.length, 1);
    assert.equal(puts[0].headers["x-map-version"], "3");
  });
});

describe("polishfix: regrid territories:'regrow' at the map's own density (demo.map, local)", () => {
  let h: Harness;
  const ev = async (code: string) => (await h.ok("eval", { readOnly: true, code })).value as any;
  const CHECK = `const C = pack.cells, live = x => x && x.i && !x.removed;
let capitals = 0, provOutside = 0;
for (const s of pack.states) if (live(s) && live(pack.burgs[s.capital]) && C.state[pack.burgs[s.capital].cell] !== s.i) capitals++;
for (const c of C.i) { const p = pack.provinces[C.province[c]]; if (C.h[c] >= 20 && C.province[c] && live(p) && p.state !== C.state[c]) provOutside++; }
return { capitals, provOutside, n: C.i.length, h: __tupaia.pure.hashStr(Array.from(C.h).join(",")), state: __tupaia.pure.hashStr(Array.from(C.state).join(",")) };`;

  before(async () => {
    h = await startServer({});
    await h.ok("load_map", { path: DEMO_MAP });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("regrow-only: borders move, cells and heights stay, logged non-replayable, undoable", async () => {
    const density = (await ev("return grid.cellsDesired")) as number;
    const d0 = await ev("return __tupaia.fns.digest().hash");
    const c0 = await ev(CHECK);
    const plain = errorBody(await h.call("regrid", { density }));
    assert.equal(plain.error.code, "BAD_ARGS");
    assert.match(plain.error.message, /already has this density.*territories:'regrow'/);
    const mixed = errorBody(await h.call("regrid", { density, territories: "regrow", heights: "nearest" }));
    assert.match(mixed.error.message, /only the territories regrow; heights is for a density change/);
    const dry = await h.ok("regrid", { density, territories: "regrow", dryRun: true });
    assert.equal(dry.mode, "regrow-only");
    assert.equal(dry.territoryBand, 3);

    await h.ok("sketch", { action: "start", slug: "fx-regrow" });
    const r = await h.ok("regrid", { density, territories: "regrow" });
    assert.equal(r.mode, "regrow-only");
    assert.equal((r.cells as Obj).before, (r.cells as Obj).after);
    const t = r.territories as Obj;
    assert.equal(t.mode, "regrow");
    assert.equal(typeof t.state?.changed, "number");
    assert.ok(t.province, JSON.stringify(t));
    const c1 = await ev(CHECK);
    assert.equal(c1.n, c0.n, "same cells");
    assert.equal(c1.h, c0.h, "same heights");
    assert.notEqual(c1.state, c0.state, "the state borders moved");
    assert.equal(c1.capitals, 0);
    assert.equal(c1.provOutside, 0);
    const sk = await h.ok("sketch", { action: "status" });
    const log = sk.log as Obj[];
    assert.equal(log.length, 1);
    assert.equal(log[0].replayable, false);
    assert.match(String(log[0].summary), /Regrew the state, culture, religion and province borders/);
    await h.ok("snapshot", { action: "undo" });
    assert.equal(await ev("return __tupaia.fns.digest().hash"), d0);
    await h.ok("sketch", { action: "stop" });
  });
});

describe("polishfix: fake-worker-serve --assets/--port and tupaia tools without a daemon", () => {
  test("fake-worker-serve --port N --assets serves the built app on that port", async () => {
    const port = await new Promise<number>(r => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => r(p));
      });
    });
    const child = spawn(
      process.execPath,
      [
        path.join(MCP_ROOT, "test", "fake-worker-serve.ts"),
        DEMO_MAP,
        "--version",
        "7",
        "--port",
        String(port),
        "--assets"
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    try {
      const origin = await new Promise<string>((resolve, reject) => {
        let buf = "";
        child.stdout.on("data", d => {
          buf += String(d);
          if (buf.includes("\n")) resolve(buf.trim());
        });
        child.once("exit", c => reject(new Error(`exited ${c}`)));
      });
      assert.equal(origin, `http://127.0.0.1:${port}`);
      const index = await (await fetch(`${origin}/`)).text();
      assert.ok(index.includes(`/${LOCAL_ENTRY}`), "/ is dist/index.html");
      const entry = await fetch(`${origin}/${LOCAL_ENTRY}`);
      assert.equal(entry.status, 200);
      assert.ok((await entry.text()).includes("data-regenerate"), "the relief load hook is in the entry chunk");
      const meta = (await (await fetch(`${origin}/api/map/shared/meta`)).json()) as Obj;
      assert.equal(meta.version, 7);
    } finally {
      child.kill("SIGTERM");
    }
  });

  test("tupaia tools lists the tools without starting a daemon or creating TUPAIA_OUT", () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tupaia-polishfix-")), "never-made");
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? os.homedir(), TUPAIA_OUT: dir };
    const bin = path.join(MCP_ROOT, "bin", "tupaia");
    const names = execFileSync(process.execPath, [bin, "tools", "--names"], { env, encoding: "utf8" });
    assert.ok(names.split("\n").includes("regrid"), names);
    assert.ok(names.split("\n").includes("sketch_promote"));
    const one = execFileSync(process.execPath, [bin, "tools", "sketch_promote"], { env, encoding: "utf8" });
    assert.match(one, /skipBuildCheck\?: boolean/);
    assert.equal(fs.existsSync(dir), false, "no TUPAIA_OUT was created (no daemon, no state)");
  });
});
