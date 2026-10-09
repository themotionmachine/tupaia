// regrid: the cell density changes and the map stays the same map (ids, names, lineage).
// Local runs on demo.map; the lineage and promote path against the in-process fake Worker in
// live mode; and the app's own client guard after the app's Transform tool changes the density.
// Never talks to the live site (safeEnv refuses it; every origin here is the fake on 127.0.0.1).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { FakeWorker } from "./fake-worker.ts";
import {
  alive,
  DEMO_MAP,
  errorBody,
  type Harness,
  openViewer,
  REPO_ROOT,
  startServer,
  viewerDialog,
  viewerLoads
} from "./helpers.ts";

type Obj = Record<string, any>;

const LOCAL_ENTRY = /src="\/(index-[^"]+\.js)"/.exec(
  fs.readFileSync(path.join(REPO_ROOT, "dist", "index.html"), "utf8")
)?.[1];

const PAGE_STATE = `return {
  cells: pack.cells.i.length,
  grid: grid.points.length,
  mapId,
  seed,
  digest: __tupaia.fns.digest().hash,
  notes: notes.length,
  burgNames: pack.burgs.filter(b => b.i && !b.removed).map(b => b.name).join("|")
};`;

describe("regrid on demo.map (local)", () => {
  let h: Harness;
  let before0: Obj;
  let applied: Obj;
  let labelId = "";

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "10" });
    await h.ok("load_map", { path: DEMO_MAP });
    const l = await h.ok("add", { type: "label", items: [{ at: { x: 700, y: 400 }, text: "Regrid label" }] });
    labelId = String((l.created as Obj[])[0].i);
    before0 = (await h.ok("eval", { code: PAGE_STATE, readOnly: true })).value as Obj;
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("dryRun estimates cells and file size and changes nothing", async () => {
    const r = await h.ok("regrid", { density: 20000, dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.cells.now, before0.cells);
    assert.ok(r.cells.est > 11000 && r.cells.est < 16000, `est ${r.cells.est}`);
    assert.equal(r.gridCells.now, before0.grid);
    assert.ok(r.gridCells.after > 19000 && r.gridCells.after < 21000);
    assert.deepEqual(r.density, { now: 4, after: 5 });
    assert.ok(r.bytes.est > r.bytes.now, JSON.stringify(r.bytes));
    assert.ok(r.bytes.est < 64_000_000);
    const now = (await h.ok("eval", { code: PAGE_STATE, readOnly: true })).value as Obj;
    assert.equal(now.digest, before0.digest);
    const slider = await h.ok("regrid", { density: 6, dryRun: true });
    assert.equal(slider.cellsDesired.after, 30000);
  });

  test("bad densities are refused before anything changes", async () => {
    const same = await h.call("regrid", { density: 4 });
    assert.equal(errorBody(same).error.code, "BAD_ARGS");
    assert.match(errorBody(same).error.message, /already/);
    const odd = await h.call("regrid", { density: 500 });
    assert.equal(errorBody(odd).error.code, "BAD_ARGS");
    const now = (await h.ok("eval", { code: PAGE_STATE, readOnly: true })).value as Obj;
    assert.equal(now.digest, before0.digest);
  });

  test("apply 20K: same map id and seed, every entity kept, lakes and islands kept with their names", async () => {
    applied = await h.ok("regrid", { density: 20000 }, 300_000);
    assert.equal(applied.cells.before, before0.cells);
    assert.ok(applied.cells.after > 12000, JSON.stringify(applied.cells));
    assert.equal(applied.gridCells.after > 19000, true);
    const e = applied.entities as Obj;
    for (const type of ["burg", "marker", "state", "province", "culture", "religion", "zone", "river", "route"])
      assert.equal(e[type].lost, 0, `${type}: ${JSON.stringify(e[type])}`);
    assert.equal(e.burg.kept, 753);
    assert.equal(e.note.kept, 200);
    assert.equal(e.note.orphaned, 0);
    assert.equal(e.label.kept, 1);
    assert.deepEqual(e.feature.lakes, { before: 8, after: 8 });
    assert.deepEqual(e.feature.islands, { before: 32, after: 32 });
    assert.equal(e.feature.named.after, e.feature.named.before);
    assert.equal(e.feature.namesLost, undefined);
    assert.ok(Math.abs(applied.landPct.after - applied.landPct.before) < 1, JSON.stringify(applied.landPct));
    assert.equal(applied.heights.method, "interpolate");
    assert.ok(Array.isArray(applied.regenerated));
    assert.ok(!(applied.warnings as string[]).some(w => /predates/.test(w)), "the dist keeps the map id itself");
    assert.match(String(applied.lineage), /unchanged: origin 'file'/);
    const now = (await h.ok("eval", { code: PAGE_STATE, readOnly: true })).value as Obj;
    assert.equal(now.mapId, before0.mapId);
    assert.equal(now.seed, before0.seed);
    assert.equal(now.cells, applied.cells.after);
    assert.equal(now.notes, before0.notes);
    assert.equal(now.burgNames, before0.burgNames);
    // the label is still drawn on its path
    const lab = await h.ok("eval", {
      code: `const t = document.getElementById(args.id); return t ? t.textContent : null;`,
      args: { id: labelId },
      readOnly: true
    });
    assert.match(String(lab.value), /Regrid label/);
  });

  test("details lists moved burgs; save and reload keep the new grid", async () => {
    const saved = await h.ok("save_map", { path: "regrid-20k.map", overwrite: true });
    await h.ok("load_map", { path: saved.path as string });
    const now = (await h.ok("eval", { code: PAGE_STATE, readOnly: true })).value as Obj;
    assert.equal(now.cells, applied.cells.after);
    assert.equal(now.burgNames, before0.burgNames);
    assert.equal(now.notes, before0.notes);
  });

  test("one undo entry returns to the previous grid", async () => {
    await h.ok("load_map", { path: DEMO_MAP });
    const start = (await h.ok("eval", { code: PAGE_STATE, readOnly: true })).value as Obj;
    const r = await h.ok("regrid", { density: 5000, details: true }, 300_000);
    assert.ok(r.cells.after < r.cells.before);
    assert.ok(Array.isArray(r.entities.burg.movedList), "details:true lists moved burgs");
    assert.ok((r.warnings as string[]).some(w => /lowering the density/.test(w)));
    await h.ok("snapshot", { action: "undo" }, 240_000);
    const back = (await h.ok("eval", { code: PAGE_STATE, readOnly: true })).value as Obj;
    assert.equal(back.cells, start.cells);
    assert.equal(back.grid, start.grid);
    assert.equal(back.digest, start.digest);
  });

  test("in a sketch it is logged as not replayable: blob-only with the reason; undo clears it", async () => {
    await h.ok("load_map", { path: DEMO_MAP });
    await h.ok("sketch", { action: "start", slug: "t-regrid" });
    await h.ok("regrid", { density: 15000 }, 300_000);
    const st = await h.ok("sketch", { action: "status" });
    assert.equal(st.blobOnly, true);
    assert.match(JSON.stringify(st.blobOnlyReasons), /regrid rebuilt the cell grid/);
    const log = st.log as Obj[];
    assert.equal(log[log.length - 1].tool, "regrid");
    assert.equal(log[log.length - 1].replayable, false);
    await h.ok("snapshot", { action: "undo" }, 240_000);
    const st2 = await h.ok("sketch", { action: "status" });
    assert.equal(st2.blobOnly, false);
    await h.ok("sketch", { action: "stop" });
  });
});

describe("regrid keeps the shared lineage (live mode, fake Worker)", () => {
  let fake: FakeWorker;
  let h: Harness;
  const writes = () => fake.writes().map(r => `${r.method} ${r.path}`);

  before(async () => {
    fake = new FakeWorker({ seedFile: DEMO_MAP, version: 3, entry: LOCAL_ENTRY });
    const origin = await fake.start();
    h = await startServer({ TUPAIA_MODE: "live", TUPAIA_LIVE_ORIGIN: origin, TUPAIA_BUILD_CACHE_MS: "0" });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
    await fake?.stop();
  });

  let cells = 0;
  test("a regrid of shared v3 in a sketch: lineage kept, shared_save preview shows no lineage warning", async () => {
    const s = await h.ok("session", { action: "status" });
    assert.equal((s.map as Obj).origin.sharedVersion, 3);
    await h.ok("sketch", { action: "start", slug: "denser" });
    const r = await h.ok("regrid", { density: 20000 }, 300_000);
    cells = r.cells.after;
    assert.match(String(r.lineage), /kept: still derived from the shared map v3/);
    const p = await h.ok("shared_save", {});
    assert.equal(p.preview, true);
    assert.equal(p.lineage.related, true, JSON.stringify(p.lineage));
    assert.equal(p.refusalReason, undefined);
    assert.equal(p.stale, false);
    assert.equal(typeof p.token, "string");
    assert.ok(!(p.overrides ?? []).some((o: string) => /unrelated/.test(o)));
    assert.deepEqual(writes(), []);
  });

  test("sketch_promote: blob-only with the regrid reason; one PUT with X-Map-Version 3, no overwrite", async () => {
    const st = await h.ok("sketch", { action: "status" });
    assert.equal(st.blobOnly, true);
    assert.match(JSON.stringify(st.blobOnlyReasons), /regrid rebuilt the cell grid/);
    const p = await h.ok("sketch_promote", {});
    assert.equal(p.preview, true);
    assert.equal(p.wouldOverwrite.version, 3);
    assert.equal(p.lineage.related, true);
    assert.equal(p.refusalReason, undefined);
    assert.match(JSON.stringify(p.sketch), /blob-only sketch/);
    fake.clearLog();
    const r = await h.ok("sketch_promote", { confirm: true, token: p.token });
    assert.deepEqual(writes(), ["PUT /api/map/shared"]);
    const put = fake.writes()[0];
    assert.equal(put.headers["x-map-version"], "3");
    assert.equal(put.headers["x-map-overwrite"], undefined);
    assert.equal(r.saved.version, 4);
    assert.equal(fake.row.version, 4);
    // the shared map is now the denser one
    await h.ok("load_map", { source: "shared" });
    const n = await h.ok("eval", { code: "return pack.cells.i.length", readOnly: true });
    assert.equal(n.value, cells);
  });
});

describe("app client guard after the app's own Transform (density change)", () => {
  let fake: FakeWorker;
  let origin = "";
  const puts = () => fake.writes().filter(r => r.method === "PUT");
  const save = (page: import("playwright").Page) =>
    page.evaluate(() => (globalThis as any).lazy.sharedMap().then((m: any) => m.saveSharedMap()));
  /** Transform tool: Options density slider 5 (20K), Transform; resolves on map:resampled. */
  const transform = (page: import("playwright").Page) =>
    page.evaluate(
      () =>
        new Promise<Obj>((resolve, reject) => {
          const w = globalThis as any;
          const before = { mapId: w.mapId, notes: w.notes.length, cells: w.pack.cells.i.length };
          let generated = false;
          w.addEventListener("map:generated", () => {
            generated = true;
          });
          w.addEventListener(
            "map:resampled",
            () =>
              setTimeout(
                () =>
                  resolve({
                    before,
                    after: { mapId: w.mapId, notes: w.notes.length, cells: w.pack.cells.i.length },
                    generated
                  }),
                200
              ),
            { once: true }
          );
          setTimeout(() => reject(new Error("no map:resampled within 120 s")), 120_000);
          w.openTransformTool().then(() => {
            (document.getElementById("transformPointsInput") as HTMLInputElement).value = "5";
            const buttons = Array.from(document.querySelectorAll(".ui-dialog-buttonset button")) as HTMLElement[];
            const go = buttons.find(b => b.innerText.trim() === "Transform" && b.offsetParent !== null);
            if (!go) reject(new Error("no Transform button"));
            else go.click();
          });
        })
    );

  before(async () => {
    fake = new FakeWorker({ seedFile: DEMO_MAP, version: 4, assetsDir: path.join(REPO_ROOT, "dist") });
    origin = await fake.start();
  });

  after(async () => {
    await fake?.stop();
  });

  test("normal boot, Transform to 20K: same map id, notes kept, Save sends its version without asking", async () => {
    fake.clearLog();
    const v = await openViewer(`${origin}/`);
    try {
      await viewerLoads(v.page, 1);
      const t = await transform(v.page);
      assert.equal(t.generated, false, "no map:generated: the map stays the loaded one");
      assert.equal(t.after.mapId, t.before.mapId);
      assert.equal(t.after.notes, t.before.notes);
      assert.ok(t.after.cells > t.before.cells * 1.4, JSON.stringify(t));
      await save(v.page);
      for (let k = 0; k < 100 && !puts().length; k++) await new Promise(r => setTimeout(r, 100));
      assert.equal(puts().length, 1);
      assert.equal(puts()[0].headers["x-map-version"], "4");
      assert.equal(puts()[0].headers["x-map-overwrite"], undefined);
      assert.equal(await viewerDialog(v.page), null, "no 'Replace the shared map?' for the transformed shared map");
      assert.equal(fake.row.version, 5);
    } finally {
      await v.close();
    }
  });

  test("someone saved in between: the save answers 409 'Shared map changed' and overwrites nothing", async () => {
    fake.clearLog();
    const v = await openViewer(`${origin}/`);
    try {
      await viewerLoads(v.page, 1);
      await transform(v.page);
      const theirs = fake.externalSave();
      await save(v.page);
      await v.page.waitForSelector(".ui-dialog:visible", { timeout: 30_000 });
      const d = await viewerDialog(v.page);
      assert.equal(d?.title, "Shared map changed");
      assert.equal(puts().length, 1, "one PUT, answered 409");
      assert.equal(puts()[0].headers["x-map-version"], "5");
      assert.equal(puts()[0].headers["x-map-overwrite"], undefined);
      assert.equal(fake.row.version, theirs, "their version stays current");
      await v.page.locator(".ui-dialog-buttonset button", { hasText: "Reload" }).waitFor();
    } finally {
      await v.close();
    }
  });
});
