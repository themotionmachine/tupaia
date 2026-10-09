// regrid: the cell density changes and the map stays the same map (ids, names, lineage).
// Local runs on demo.map; the lineage and promote path against the in-process fake Worker in
// live mode; and the app's own client guard after the app's Transform tool changes the density.
// Never talks to the live site (safeEnv refuses it; every origin here is the fake on 127.0.0.1).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { blobOnlyReasons, SketchStore } from "../src/ops.ts";
import { REGRID_REASON } from "../src/tools/regrid.ts";
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

/** h.ok with a loosely typed body (these tests read nested fields). */
const ok = (h: Harness, name: string, args: Obj = {}, timeoutMs?: number) =>
  h.ok(name, args, timeoutMs) as Promise<Obj>;

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
  relief: document.querySelectorAll("#terrain use").length,
  riverAnchors: pack.rivers.reduce((s, r) => s + (r.points?.length ?? r.cells.length), 0),
  riversAligned: pack.rivers.every(r => !r.points || r.points.length === r.cells.length),
  burgNames: pack.burgs.filter(b => b.i && !b.removed).map(b => b.name).join("|")
};`;

describe("regrid in the sketch log (no browser)", () => {
  test("several regrids give one blob-only reason line, not one per op", () => {
    const s = new SketchStore();
    s.begin({
      slug: "x",
      note: null,
      base: { kind: "shared", version: 3, at: "t" } as never,
      baseText: "",
      baseCounts: {}
    });
    const op = (undoId: number) => ({
      tool: "regrid",
      args: {},
      resolved: null,
      summary: "Regridded",
      at: "t",
      digestBefore: null,
      digestAfter: null,
      replayable: false,
      reason: REGRID_REASON,
      undoId
    });
    s.append(op(1));
    s.append(op(2));
    const reasons = blobOnlyReasons(s.current as never);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /^ops 1, 2 \(regrid\): regrid rebuilt the cell grid/);
  });
});

/** Data consistency the app's generators guarantee, checked in the page. */
const CONSISTENCY = `const C = pack.cells, n = C.i.length;
const live = x => x && x.i && !x.removed;
const badCenters = [];
for (const [field, list] of [["state", "states"], ["province", "provinces"], ["culture", "cultures"], ["religion", "religions"]])
  for (const e of pack[list]) {
    if (!live(e)) continue;
    const has = C.i.some(i => C[field][i] === e.i);
    if (!has) continue;
    if (!Number.isInteger(e.center) || e.center < 0 || e.center >= n || C[field][e.center] !== e.i)
      badCenters.push(field + " " + e.i + " " + e.center);
  }
const burgsOffState = pack.burgs.filter(b => live(b) && b.state && C.state[b.cell] !== b.state).map(b => b.name);
const staleStates = pack.states.filter(s => live(s) && s.cells !== C.i.filter(i => C.h[i] >= 20 && C.state[i] === s.i).length).map(s => s.name);
const wildProvinces = pack.provinces.filter(p => live(p) && !p.burg).length;
const emptyZones = pack.zones.filter(z => z && !z.removed && !(z.cells || []).length).map(z => z.name);
return { badCenters, burgsOffState, staleStates, wildProvinces, emptyZones };`;

describe("regrid on demo.map (local)", () => {
  let h: Harness;
  let before0: Obj;
  let applied: Obj;
  let labelId = "";

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "10" });
    await ok(h, "load_map", { path: DEMO_MAP });
    const l = await ok(h, "add", { type: "label", items: [{ at: { x: 700, y: 400 }, text: "Regrid label" }] });
    labelId = String((l.created as Obj[])[0].i);
    before0 = (await ok(h, "eval", { code: PAGE_STATE, readOnly: true })).value as Obj;
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("dryRun estimates cells and file size and changes nothing", async () => {
    const r = await ok(h, "regrid", { density: 20000, dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.cells.now, before0.cells);
    assert.ok(r.cells.est > 11000 && r.cells.est < 16000, `est ${r.cells.est}`);
    assert.equal(r.gridCells.now, before0.grid);
    assert.ok(r.gridCells.after > 19000 && r.gridCells.after < 21000);
    assert.deepEqual(r.density, { now: 4, after: 5 });
    assert.ok(r.bytes.est > r.bytes.now, JSON.stringify(r.bytes));
    assert.ok(r.bytes.est < 64_000_000);
    const now = (await ok(h, "eval", { code: PAGE_STATE, readOnly: true })).value as Obj;
    assert.equal(now.digest, before0.digest);
    const slider = await ok(h, "regrid", { density: 6, dryRun: true });
    assert.equal(slider.cellsDesired.after, 30000);
  });

  test("a dry run works with an editor open; the real regrid is refused with the way out", async () => {
    await ok(h, "eval", { code: "customization = 1; return 1" });
    try {
      const r = await ok(h, "regrid", { density: 20000, dryRun: true });
      assert.equal(r.dryRun, true);
      assert.match(String(r.bytes.note), /approximate/);
      const real = await h.call("regrid", { density: 20000 });
      assert.equal(errorBody(real).error.code, "REFUSED");
      assert.match(errorBody(real).error.message, /closeDialogs\(\); customization = 0/);
    } finally {
      await ok(h, "eval", { code: "customization = 0; return 0" });
    }
    const st = await ok(h, "snapshot", { action: "list" });
    assert.ok(!JSON.stringify(st).includes('"regrid"'), "a refused regrid leaves no undo entry");
  });

  test("bad densities are refused before anything changes", async () => {
    const same = await h.call("regrid", { density: 4 });
    assert.equal(errorBody(same).error.code, "BAD_ARGS");
    assert.match(errorBody(same).error.message, /already/);
    const odd = await h.call("regrid", { density: 500 });
    assert.equal(errorBody(odd).error.code, "BAD_ARGS");
    const now = (await ok(h, "eval", { code: PAGE_STATE, readOnly: true })).value as Obj;
    assert.equal(now.digest, before0.digest);
  });

  test("apply 20K: same map id and seed, every entity kept, lakes and islands kept with their names", async () => {
    applied = await ok(h, "regrid", { density: 20000 }, 300_000);
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
    assert.equal(typeof e.feature.oceans.after, "number");
    assert.equal(typeof e.province.maxAreaChangeOf, "string", "the province that changed most is named");
    assert.ok(Array.isArray(applied.layers.keptEmpty));
    assert.ok(!(applied.warnings as string[]).some(w => /lost: /.test(w)), JSON.stringify(applied.warnings));
    // every area has a center inside it (13 wild provinces have no capital burg), every state
    // burg sits on its state's cell, and the state statistics are recounted
    const c = (await ok(h, "eval", { code: CONSISTENCY, readOnly: true })).value as Obj;
    assert.ok(c.wildProvinces >= 13, JSON.stringify(c));
    assert.deepEqual(c.badCenters, []);
    assert.deepEqual(c.burgsOffState, []);
    assert.deepEqual(c.staleStates, []);
    assert.deepEqual(c.emptyZones, []);
    assert.ok(Math.abs(applied.landPct.after - applied.landPct.before) < 1, JSON.stringify(applied.landPct));
    assert.equal(applied.heights.method, "interpolate");
    assert.ok(Array.isArray(applied.regenerated));
    assert.ok(!(applied.warnings as string[]).some(w => /predates/.test(w)), "the dist keeps the map id itself");
    assert.match(String(applied.lineage), /unchanged: origin 'file'/);
    const now = (await ok(h, "eval", { code: PAGE_STATE, readOnly: true })).value as Obj;
    assert.equal(now.mapId, before0.mapId);
    assert.equal(now.seed, before0.seed);
    assert.equal(now.cells, applied.cells.after);
    assert.equal(now.notes, before0.notes);
    assert.equal(now.burgNames, before0.burgNames);
    assert.equal(now.relief, before0.relief, "relief icons are kept as drawn (relief:'keep' default)");
    // rivers keep their anchors (Resample stored the meandered line, so every regrid multiplied points)
    assert.equal(now.riversAligned, true);
    assert.ok(
      now.riverAnchors <= before0.riverAnchors * 1.05 && now.riverAnchors >= before0.riverAnchors * 0.9,
      `${before0.riverAnchors} -> ${now.riverAnchors}`
    );
    // layers that were on but undrawn stay undrawn
    const undrawn = await ok(h, "eval", {
      code: `return args.ids.map(id => document.getElementById(id).querySelectorAll("path, circle, polygon, line, text, use, image").length)`,
      args: { ids: applied.layers.keptEmpty },
      readOnly: true
    });
    assert.ok(
      (undrawn.value as number[]).every(n => n === 0),
      JSON.stringify(applied.layers)
    );
    // the label is still drawn on its path
    const lab = await ok(h, "eval", {
      code: `const t = document.getElementById(args.id); return t ? t.textContent : null;`,
      args: { id: labelId },
      readOnly: true
    });
    assert.match(String(lab.value), /Regrid label/);
  });

  test("save and reload keep the new grid and every province center", async () => {
    const saved = await ok(h, "save_map", { path: "regrid-20k.map", overwrite: true });
    await ok(h, "load_map", { path: saved.path as string });
    const now = (await ok(h, "eval", { code: PAGE_STATE, readOnly: true })).value as Obj;
    assert.equal(now.cells, applied.cells.after);
    assert.equal(now.burgNames, before0.burgNames);
    assert.equal(now.notes, before0.notes);
    const c = (await ok(h, "eval", { code: CONSISTENCY, readOnly: true })).value as Obj;
    assert.deepEqual(c.badCenters, [], "centers (wild provinces included) survive save and load");
  });

  test("lowering to 2K: dryRun names the risk; zones keep a cell; losses are named once", async () => {
    await ok(h, "load_map", { path: DEMO_MAP });
    const dry = await ok(h, "regrid", { density: 2, dryRun: true });
    assert.ok(dry.atRisk.burgsSharingACell > 0, JSON.stringify(dry.atRisk));
    assert.equal(typeof dry.atRisk.smallerThanACell.lakes, "number");
    const r = await ok(h, "regrid", { density: 2, details: true }, 300_000);
    const e = r.entities as Obj;
    assert.equal(e.zone.lost, 0, JSON.stringify(e.zone));
    assert.ok(e.burg.lost > 0 && e.burg.lostNames.length === Math.min(50, e.burg.lost));
    const w = (r.warnings as string[]).join("\n");
    assert.match(w, /lost: \d+ burg/);
    assert.ok(!w.includes(e.burg.lostNames[0]), "lost names are in entities, not repeated in warnings");
    assert.ok(Array.isArray(e.province.largestAreaChanges));
    assert.match(String(r.heights.legend), /claimed: /);
    if (e.burg.moved > 50) assert.equal(e.burg.movedMore, e.burg.moved - 50);
    const c = (await ok(h, "eval", { code: CONSISTENCY, readOnly: true })).value as Obj;
    assert.deepEqual(c.emptyZones, []);
    assert.deepEqual(c.badCenters, []);
  });

  test("one undo entry returns to the previous grid", async () => {
    await ok(h, "load_map", { path: DEMO_MAP });
    const start = (await ok(h, "eval", { code: PAGE_STATE, readOnly: true })).value as Obj;
    const r = await ok(h, "regrid", { density: 5000, details: true }, 300_000);
    assert.ok(r.cells.after < r.cells.before);
    assert.ok(Array.isArray(r.entities.burg.movedList), "details:true lists moved burgs");
    assert.ok((r.warnings as string[]).some(w => /lowering the density/.test(w)));
    await ok(h, "snapshot", { action: "undo" }, 240_000);
    const back = (await ok(h, "eval", { code: PAGE_STATE, readOnly: true })).value as Obj;
    assert.equal(back.cells, start.cells);
    assert.equal(back.grid, start.grid);
    assert.equal(back.digest, start.digest);
  });

  test("in a sketch it is logged as not replayable: blob-only with the reason; undo clears it", async () => {
    await ok(h, "load_map", { path: DEMO_MAP });
    await ok(h, "sketch", { action: "start", slug: "t-regrid" });
    await ok(h, "regrid", { density: 15000 }, 300_000);
    const st = await ok(h, "sketch", { action: "status" });
    assert.equal(st.blobOnly, true);
    assert.match(JSON.stringify(st.blobOnlyReasons), /regrid rebuilt the cell grid/);
    const log = st.log as Obj[];
    assert.equal(log[log.length - 1].tool, "regrid");
    assert.equal(log[log.length - 1].replayable, false);
    await ok(h, "snapshot", { action: "undo" }, 240_000);
    const st2 = await ok(h, "sketch", { action: "status" });
    assert.equal(st2.blobOnly, false);
    await ok(h, "sketch", { action: "stop" });
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
    const s = await ok(h, "session", { action: "status" });
    assert.equal((s.map as Obj).origin.sharedVersion, 3);
    await ok(h, "sketch", { action: "start", slug: "denser" });
    const r = await ok(h, "regrid", { density: 20000 }, 300_000);
    cells = r.cells.after;
    assert.match(String(r.lineage), /kept: still derived from the shared map v3/);
    const p = await ok(h, "shared_save", {});
    assert.equal(p.preview, true);
    assert.equal(p.lineage.related, true, JSON.stringify(p.lineage));
    assert.equal(p.refusalReason, undefined);
    assert.equal(p.stale, false);
    assert.equal(typeof p.token, "string");
    assert.ok(!(p.overrides ?? []).some((o: string) => /unrelated/.test(o)));
    // a blob-only sketch is not rebased: the refusal says to promote directly
    const rb = await h.call("sketch", { action: "rebase" });
    assert.equal(errorBody(rb).error.code, "REFUSED");
    assert.match(errorBody(rb).error.message, /still at v3 .*sketch_promote it directly/);
    assert.deepEqual(writes(), []);
  });

  test("sketch_promote: blob-only with the regrid reason; one PUT with X-Map-Version 3, no overwrite", async () => {
    const st = await ok(h, "sketch", { action: "status" });
    assert.equal(st.blobOnly, true);
    assert.match(JSON.stringify(st.blobOnlyReasons), /regrid rebuilt the cell grid/);
    const p = await ok(h, "sketch_promote", {});
    assert.equal(p.preview, true);
    assert.equal(p.wouldOverwrite.version, 3);
    assert.equal(p.lineage.related, true);
    assert.equal(p.refusalReason, undefined);
    assert.match(JSON.stringify(p.sketch), /blob-only sketch/);
    fake.clearLog();
    const r = await ok(h, "sketch_promote", { confirm: true, token: p.token });
    assert.deepEqual(writes(), ["PUT /api/map/shared"]);
    const put = fake.writes()[0];
    assert.equal(put.headers["x-map-version"], "3");
    assert.equal(put.headers["x-map-overwrite"], undefined);
    assert.equal(r.saved.version, 4);
    assert.equal(fake.row.version, 4);
    // the shared map is now the denser one
    await ok(h, "load_map", { source: "shared" });
    const n = await ok(h, "eval", { code: "return pack.cells.i.length", readOnly: true });
    assert.equal(n.value, cells);
  });
});

describe("app client guard after the app's own Transform (density change)", () => {
  let fake: FakeWorker;
  let origin = "";
  const puts = () => fake.writes().filter(r => r.method === "PUT");
  const save = (page: import("playwright").Page) =>
    page.evaluate(() => (globalThis as any).lazy.sharedMap().then((m: any) => m.saveSharedMap()));
  /**
   * Transform tool: density slider 5 (20K), optionally a zoom (scale input step; 15 is about 4x),
   * then Transform; resolves on map:resampled (same map) or map:generated (a new map). The
   * Transform resizes the canvas to Options > canvas size (the window size by default, 1280x720
   * here, smaller than the map): `fitCanvas` sets that option to the map's size first, as for a
   * pure density change; without it the Transform crops the map.
   */
  const transform = (page: import("playwright").Page, zoomStep = 0, fitCanvas = true) =>
    page.evaluate(
      ([zoom, fit]) =>
        new Promise<Obj>((resolve, reject) => {
          const w = globalThis as any;
          if (fit) {
            (document.getElementById("mapWidthInput") as HTMLInputElement).value = String(w.graphWidth);
            (document.getElementById("mapHeightInput") as HTMLInputElement).value = String(w.graphHeight);
          }
          const before = { mapId: w.mapId, notes: w.notes.length, cells: w.pack.cells.i.length };
          let generated = false;
          const done = () =>
            setTimeout(
              () =>
                resolve({
                  before,
                  after: { mapId: w.mapId, notes: w.notes.length, cells: w.pack.cells.i.length },
                  generated
                }),
              200
            );
          w.addEventListener(
            "map:generated",
            () => {
              generated = true;
              done();
            },
            { once: true }
          );
          w.addEventListener("map:resampled", done, { once: true });
          setTimeout(() => reject(new Error("no map:resampled or map:generated within 120 s")), 120_000);
          w.openTransformTool().then(() => {
            (document.getElementById("transformPointsInput") as HTMLInputElement).value = "5";
            if (zoom) {
              const scale = document.getElementById("transformScaleInput") as HTMLInputElement;
              scale.value = String(zoom);
              scale.dispatchEvent(new Event("input", { bubbles: true }));
            }
            const buttons = Array.from(document.querySelectorAll(".ui-dialog-buttonset button")) as HTMLElement[];
            const go = buttons.find(b => b.innerText.trim() === "Transform" && b.offsetParent !== null);
            if (!go) reject(new Error("no Transform button"));
            else go.click();
          });
        }),
      [zoomStep, fitCanvas] as const
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

  for (const [what, zoom, fit] of [
    ["a zoom", 15, true],
    ["a canvas resize (Options canvas size differs from the map)", 0, false]
  ] as const)
    test(`Transform with ${what} crops the map: a new map, so Save asks 'Replace the shared map?' first`, async () => {
      fake.clearLog();
      const v = await openViewer(`${origin}/`);
      try {
        await viewerLoads(v.page, 1);
        const t = await transform(v.page, zoom, fit);
        assert.equal(t.generated, true, "a cropping transform is a new map (map:generated)");
        assert.notEqual(t.after.mapId, t.before.mapId);
        await save(v.page);
        await v.page.waitForSelector(".ui-dialog:visible", { timeout: 30_000 });
        const d = await viewerDialog(v.page);
        assert.equal(d?.title, "Replace the shared map?");
        assert.deepEqual(puts(), [], "nothing sent before the human confirms");
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
