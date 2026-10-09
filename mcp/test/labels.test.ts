// Label visibility overrides: display {labels} (stored on the SVG groups, honoured by the app's
// zoom handler, saved with the map, undoable, replayable) and the one-shot screenshot {labels:'all'}.
// Own server; the demo map has no label groups drawn until something redraws them.
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import { type DisplayResolved, sanitizeRecord, summarizeOp } from "../src/ops.ts";
import { bridgeArgs } from "../src/replay.ts";
import { alive, errorBody, type Harness, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

describe("label visibility overrides (pure: summaries and replay args)", () => {
  const r: DisplayResolved = {
    on: [],
    off: [],
    labels: { city: { minSize: 0 }, town: { alwaysShow: true, minSize: null }, states: null }
  };

  test("the display summary names the label groups instead of reading 'no change'", () => {
    assert.equal(
      summarizeOp("display", r, null),
      "Display: label visibility city min size 0; town default min size, always shown; states default."
    );
    assert.equal(summarizeOp("display", { on: ["zones"], off: [] }, null), "Display: on zones.");
  });

  test("bridgeArgs carries labels to the replay call, and only when present", () => {
    assert.deepEqual(bridgeArgs("display", r), { on: [], off: [], labels: r.labels });
    assert.deepEqual(bridgeArgs("display", { on: ["zones"], off: [] }), { on: ["zones"], off: [] });
  });

  test("a saved log keeps the labels field and recomputes the summary from it", () => {
    const rec = sanitizeRecord({ seq: 2, tool: "display", args: {}, resolved: r, summary: "harmless" }, 1);
    assert.equal(rec.replayable, true);
    assert.match(rec.summary, /label visibility city min size 0/);
    assert.deepEqual((rec.resolved as DisplayResolved).labels, r.labels);
  });
});

describe("tupaia-mcp label visibility overrides", () => {
  let h: Harness;
  let baseMap = "";
  const evalRO = async (code: string, args?: unknown) =>
    (await h.ok("eval", { code, args, readOnly: true })).value as any;
  const undoCount = async () => ((await h.ok("snapshot", { action: "list" })).undo as unknown[]).length;
  const digest = () => evalRO("__tupaia.fns.digest().hash") as Promise<string>;

  /** Label texts on screen, by independent means: computed display of every ancestor up to #map. */
  const COUNT = `
    const shown = t => { for (let n = t.parentElement; n && n.id !== 'map'; n = n.parentElement) if (getComputedStyle(n).display === 'none') return false; return true; };
    const by = {};
    let burgShown = 0, burgTotal = 0;
    for (const t of document.querySelectorAll('#burgLabels text, #states text, #addedLabels text')) {
      const g = t.parentElement.id;
      by[g] = by[g] || { shown: 0, total: 0 };
      by[g].total++;
      if (shown(t)) by[g].shown++;
      if (t.closest('#burgLabels')) { burgTotal++; if (shown(t)) burgShown++; }
    }
    return { scale, zoomMin: Math.max(svgWidth / graphWidth, svgHeight / graphHeight), by, burgShown, burgTotal };`;
  const counts = () =>
    evalRO(COUNT) as Promise<{
      scale: number;
      zoomMin: number;
      by: Record<string, { shown: number; total: number }>;
      burgShown: number;
      burgTotal: number;
    }>;
  /** An attribute of a label or emblem group (ids like 'city' are also used by the icon layers). */
  const attr = (group: string, name: string) =>
    evalRO(
      "[...document.querySelectorAll('#labels g, #emblems g')].find(g => g.id === args.group)?.getAttribute(args.name) ?? null",
      { group, name }
    );
  /** Full-map zoom, then redraw the labels so every burg group has its texts. */
  const fullMapZoom = () => h.ok("eval", { code: "await __tupaia.fns.resetView({}); return scale", readOnly: true });

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("eval", {
      code: "await __tupaia.fns.resetView({}); await __tupaia.fns.redraw({layers:['burgIcons','labels']}); return scale"
    });
    baseMap = (await h.ok("save_map", { path: "labels-base.map", overwrite: true })).path as string;
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("premise: at full-map zoom the burg label groups are hidden and the state labels show", async () => {
    const c = await counts();
    assert.ok(Math.abs(c.scale - c.zoomMin) < 0.01, `full-map zoom: ${c.scale} vs ${c.zoomMin}`);
    assert.ok(c.burgTotal > 100, `burg labels drawn: ${c.burgTotal}`);
    assert.equal(c.burgShown, 0, "every burg label group is under the 6 px rule");
    assert.ok(c.by.states.shown > 0 && c.by.states.shown === c.by.states.total, "state labels are shown");
  });

  test("display {labels}: hidden before, visible after; counts, attributes and the result agree", async () => {
    const before = await counts();
    const r = await h.ok("display", { labels: { city: { alwaysShow: true }, town: { minSize: 0 } } });
    const lab = r.labels as Obj;
    const after = await counts();
    assert.equal(after.by.city.shown, before.by.city.total, "city labels all show");
    assert.equal(after.by.town.shown, before.by.town.total, "town labels all show");
    assert.equal(after.by.village.shown, 0, "village labels are untouched and still hidden");
    assert.equal(after.burgShown, before.by.city.total + before.by.town.total);
    // the tool reports the same numbers, counts first and only for the groups it touched
    assert.deepEqual(lab.groups.city, { alwaysShow: true, visible: before.by.city.total, of: before.by.city.total });
    assert.deepEqual(lab.groups.town, { minSize: 0, visible: before.by.town.total, of: before.by.town.total });
    assert.equal(lab.visible.before, before.by.states.shown);
    assert.equal(lab.visible.after, after.burgShown + after.by.states.shown + (after.by.addedLabels?.shown ?? 0));
    assert.deepEqual(Object.keys(lab.groups).sort(), ["city", "town"]);
    // stored on the SVG groups, so they travel with the map
    assert.equal(await attr("city", "data-always-show"), "1");
    assert.equal(await attr("city", "data-min-size"), null);
    assert.equal(await attr("town", "data-min-size"), "0");
    assert.equal(await attr("village", "data-min-size"), null);
  });

  test("'*' covers every label group, a group's own spec is laid over it, null clears", async () => {
    await h.ok("display", { labels: { "*": { minSize: 0 } } });
    let c = await counts();
    assert.equal(c.burgShown, c.burgTotal, "all burg labels show");
    assert.equal(await attr("hamlet", "data-min-size"), "0");
    assert.equal(await attr("states", "data-min-size"), "0");
    assert.equal(await attr("burgEmblems", "data-min-size"), null, "'*' is label groups only");

    const r = await h.ok("display", { labels: { "*": null, states: { alwaysShow: true } } });
    c = await counts();
    assert.equal(c.burgShown, 0, "cleared: back to the automatic rule");
    assert.equal(await attr("city", "data-always-show"), null);
    assert.equal(await attr("town", "data-min-size"), null);
    assert.equal(await attr("states", "data-min-size"), null, "the clear came first, then the group's own field");
    assert.equal(await attr("states", "data-always-show"), "1");
    assert.equal((r.labels as Obj).groups.states.alwaysShow, true);
    await h.ok("display", { labels: { states: null } });
    assert.equal(await attr("states", "data-always-show"), null);
  });

  test("a bad call is refused before anything changes, with the group names to pick from", async () => {
    const n = await undoCount();
    const d0 = await digest();
    const bad = await h.call("display", { labels: { city: { alwaysShow: true }, nope: { minSize: 3 } } });
    assert.equal(bad.isError, true);
    const body = errorBody(bad).error as Obj;
    assert.equal(body.code, "BAD_ARGS");
    assert.match(body.message, /unknown label group 'nope'/);
    assert.ok(body.details.includes("city") && body.details.includes("states"), JSON.stringify(body.details));
    assert.equal(await attr("city", "data-always-show"), null, "the valid group was not applied either");
    const empty = await h.call("display", { labels: { city: {} } });
    assert.equal(errorBody(empty).error.code, "BAD_ARGS");
    assert.match(errorBody(empty).error.message, /sets nothing/);
    for (const labels of [{ city: { minSize: -1 } }, { city: { minsize: 3 } }, { city: { alwaysShow: "yes" } }]) {
      const r = await h.call("display", { labels });
      assert.equal(r.isError, true, JSON.stringify(labels));
    }
    assert.equal(await undoCount(), n, "no undo entry for refused calls");
    assert.equal(await digest(), d0);
  });

  test("undo reverts the override; redo brings it back", async () => {
    await h.ok("display", { labels: { city: { alwaysShow: true } } });
    assert.equal((await counts()).by.city.shown > 0, true);
    await h.ok("snapshot", { action: "undo" });
    assert.equal(await attr("city", "data-always-show"), null);
    await fullMapZoom();
    assert.equal((await counts()).by.city.shown, 0, "hidden again");
    await h.ok("snapshot", { action: "redo" });
    assert.equal(await attr("city", "data-always-show"), "1");
    await fullMapZoom();
    const c = await counts();
    assert.equal(c.by.city.shown, c.by.city.total, "the override is back");
    await h.ok("display", { labels: { city: null } });
  });

  test("persists through save_map -> load_map: hidden before, visible after, at full-map zoom", async () => {
    await h.ok("load_map", { path: baseMap });
    await fullMapZoom();
    const before = await counts();
    assert.equal(before.burgShown, 0);
    await h.ok("display", { labels: { city: { alwaysShow: true }, village: { minSize: 0.5 } } });
    const saved = await h.ok("save_map", { path: "labels-saved.map", overwrite: true });
    const text = fs.readFileSync(saved.path as string, "utf8");
    const burgLabels = text.slice(text.indexOf('id="burgLabels"'));
    const tag = (id: string) => new RegExp(`<g [^>]*id="${id}"[^>]*>`).exec(burgLabels)?.[0] ?? "";
    assert.ok(tag("city").includes('data-always-show="1"'), tag("city"));
    assert.ok(tag("village").includes('data-min-size="0.5"'), tag("village"));
    assert.ok(tag("town").includes("data-size") && !/data-(min-size|always-show)/.test(tag("town")), tag("town"));

    // a map without the override, then the saved one
    await h.ok("load_map", { path: baseMap });
    await fullMapZoom();
    assert.equal((await counts()).burgShown, 0);
    const loaded = await h.ok("load_map", { path: saved.path as string });
    assert.ok(loaded.name);
    await fullMapZoom();
    const after = await counts();
    assert.equal(await attr("city", "data-always-show"), "1");
    assert.equal(await attr("village", "data-min-size"), "0.5");
    assert.equal(after.by.city.shown, before.by.city.total, "city labels visible after the round trip");
    assert.equal(after.by.village.shown, before.by.village.total, "village labels visible after the round trip");
    assert.equal(after.by.town.shown, 0, "untouched groups still follow the rule");
  });

  test("an override survives a redraw of the burg labels (the groups are rebuilt from their attributes)", async () => {
    await h.ok("eval", { code: "drawBurgLabels(); invokeActiveZooming(); return 1" });
    assert.equal(await attr("city", "data-always-show"), "1");
    const c = await counts();
    assert.equal(c.by.city.shown, c.by.city.total);
    assert.equal(c.by.town.shown, 0);
  });

  test("the zoom rule still applies: minSize is a threshold on size x zoom, alwaysShow ignores zoom", async () => {
    await h.ok("display", { labels: { "*": null } });
    await h.ok("display", { labels: { capital: { minSize: 1 }, city: { minSize: 100 }, town: { alwaysShow: true } } });
    await fullMapZoom();
    let c = await counts();
    // capital: data-size 6 at zoom 0.85 is about 5.5 px >= 1; city is under 100; town is always shown
    assert.equal(c.by.capital.shown, c.by.capital.total);
    assert.equal(c.by.city.shown, 0);
    assert.equal(c.by.town.shown, c.by.town.total);
    // zoom far in: alwaysShow also skips the upper bound (size x zoom over 60)
    await h.ok("eval", {
      code: "await __tupaia.fns.setView({ view: { x: -5000, y: -2000, scale: 20 } }); invokeActiveZooming(); return scale",
      readOnly: true
    });
    c = await counts();
    assert.equal(c.by.town.shown, c.by.town.total, "alwaysShow also at zoom 20");
    assert.equal(c.by.capital.shown, 0, "minSize only moves the lower bound; the upper bound (60) still hides");
    await h.ok("display", { labels: { "*": null } });
    await fullMapZoom();
  });

  test("state labels take the override too, and a style preset leaves it alone", async () => {
    const before = await counts();
    assert.ok(before.by.states.shown > 0);
    await h.ok("display", { labels: { states: { minSize: 500 }, village: { alwaysShow: true } } });
    assert.equal((await counts()).by.states.shown, 0, "the state labels are now under their minimum");
    await h.ok("display", { stylePreset: "atlas" });
    assert.equal(await attr("states", "data-min-size"), "500", "applying a style keeps the override");
    assert.equal(await attr("village", "data-always-show"), "1");
    const c = await counts();
    assert.equal(c.by.states.shown, 0);
    assert.equal(c.by.village.shown, c.by.village.total);
    await h.ok("display", { labels: { "*": null } });
    assert.equal((await counts()).by.states.shown, before.by.states.shown);
  });

  test("emblem groups take the same override (default threshold 25)", async () => {
    // an emblem group with no emblems in it, drawn at 2 px: under 25 at any zoom up to 12
    const display0 = await evalRO("emblems.style('display')");
    await h.ok("eval", {
      code: "emblems.style('display', 'inline'); emblems.select('#burgEmblems').attr('font-size', 2); invokeActiveZooming(); return 1",
      readOnly: true
    });
    const hidden = () => evalRO("document.getElementById('burgEmblems').classList.contains('hidden')");
    assert.equal(await hidden(), true, "2 px x zoom is under the default 25");
    const r = await h.ok("display", { labels: { burgEmblems: { minSize: 1 } } });
    assert.equal(await hidden(), false, "minSize 1 lets it show");
    assert.equal((r.labels as Obj).groups.burgEmblems.minSize, 1);
    assert.equal(await attr("burgEmblems", "data-min-size"), "1");
    await h.ok("display", { labels: { burgEmblems: { minSize: null } } });
    assert.equal(await hidden(), true);
    await h.ok("display", { labels: { burgEmblems: { alwaysShow: true } } });
    assert.equal(await hidden(), false);
    await h.ok("display", { labels: { burgEmblems: null } });
    await h.ok("eval", {
      code: `emblems.style('display', ${JSON.stringify(display0)}); return 1`,
      readOnly: true
    });
  });

  test("a warning says when the labels layer is off (nothing can show)", async () => {
    await h.ok("display", { off: ["labels"] });
    const r = await h.ok("display", { labels: { city: { alwaysShow: true } } });
    assert.match(JSON.stringify(r.warnings), /labels layer is off/);
    assert.equal((r.labels as Obj).visible.after, 0);
    await h.ok("display", { on: ["labels"], labels: { city: null } });
  });

  test("screenshot {labels:'all'} shows the hidden labels for one shot and leaves no trace", async () => {
    await h.ok("load_map", { path: baseMap });
    await fullMapZoom();
    const c0 = await counts();
    assert.equal(c0.burgShown, 0);
    const d0 = await digest();
    const undo0 = await undoCount();
    const plain = await h.ok("screenshot", {});
    const all = await h.ok("screenshot", { labels: "all", compare: plain.shotId as string });
    assert.deepEqual((all.labels as Obj).mode, "all");
    assert.equal((all.labels as Obj).revealed, c0.burgTotal, "every zoom-hidden burg label was revealed");
    const pct = (r: Obj) => (r.compare as Obj).changedPct as number;
    const again = await h.ok("screenshot", { compare: plain.shotId as string });
    assert.ok(pct(all) > 10 * pct(again) && pct(all) > 0.05, `the shot differs: ${pct(all)}% vs ${pct(again)}% again`);
    assert.ok(pct(again) < 0.02, `afterwards the page renders as before: ${pct(again)}%`);
    assert.equal((await counts()).burgShown, 0, "still hidden on the page");
    assert.equal(await evalRO("!!document.getElementById('tupaia-labels-all')"), false, "the temporary style is gone");
    assert.equal(await undoCount(), undo0, "no undo entry");
    assert.equal(await digest(), d0, "the map itself did not change");
  });

  test("screenshot {labels:'all', full:true} shows them in the whole-map raster too", async () => {
    const plain = await h.ok("screenshot", { full: true });
    const all = await h.ok("screenshot", { full: true, labels: "all", compare: plain.shotId as string });
    assert.ok(((all.compare as Obj).changedPct as number) > 0.05, "the raster has the labels");
    assert.equal((await counts()).burgShown, 0);
  });

  test("screenshot {labels:'all'} turns the labels layer on for the shot and puts it back; layers.off labels is refused", async () => {
    await h.ok("display", { off: ["labels"] });
    const undo0 = await undoCount();
    const r = await h.ok("screenshot", { labels: "all" });
    assert.ok(((r.labels as Obj).revealed as number) > 0);
    assert.equal(await evalRO("layerIsOn('toggleLabels')"), false, "layer is off again");
    assert.equal(await undoCount(), undo0);
    const bad = await h.call("screenshot", { labels: "all", layers: { off: ["labels"] } });
    assert.equal(errorBody(bad).error.code, "BAD_ARGS");
    await h.ok("display", { on: ["labels"] });
  });

  test("a group hidden by hand (inline display:none) stays hidden in a labels:'all' shot", async () => {
    await h.ok("eval", { code: "document.querySelector('#burgLabels > #village').style.display = 'none'; return 1" });
    const r = await h.ok("screenshot", { labels: "all" });
    const c = await counts();
    assert.equal((r.labels as Obj).revealed, c.burgTotal - c.by.village.total);
    await h.ok("eval", { code: "document.querySelector('#burgLabels > #village').style.display = null; return 1" });
  });
});

describe("label visibility overrides in a sketch (record, summarize, replay)", () => {
  let h: Harness;
  let withLabels = "";
  let without = "";

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "30" });
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    without = (await h.ok("save_map", { path: "no-labels.map", overwrite: true })).path as string;
    await h.ok("eval", {
      code: "await __tupaia.fns.resetView({}); await __tupaia.fns.redraw({layers:['burgIcons','labels']}); return 1"
    });
    withLabels = (await h.ok("save_map", { path: "with-labels.map", overwrite: true })).path as string;
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  const overrides = async () =>
    (
      await h.ok("eval", {
        readOnly: true,
        code: `const out = {};
          for (const id of ['city', 'town', 'states']) {
            const el = [...document.querySelectorAll('#labels g')].find(g => g.id === id);
            out[id] = { 'data-always-show': el.getAttribute('data-always-show'), 'data-min-size': el.getAttribute('data-min-size') };
          }
          return out;`
      })
    ).value as Obj;

  test("the op is logged with a literal resolved form and a summary that names the groups", async () => {
    await h.ok("load_map", { path: withLabels });
    await h.ok("sketch", { action: "start", slug: "t-labels" });
    await h.ok("display", { labels: { city: { alwaysShow: true }, town: { minSize: 0 } } });
    await h.ok("display", { labels: { "*": { minSize: 2 }, states: null } });
    const st = await h.ok("sketch", { action: "status", full: true });
    const recs = st.records as Obj[];
    assert.equal(recs.length, 2);
    assert.equal(st.blobOnly, false);
    assert.deepEqual(recs[0].resolved.labels, { city: { alwaysShow: true }, town: { minSize: 0 } });
    assert.equal(recs[1].resolved.labels.states, null, "a cleared group is null");
    assert.deepEqual(recs[1].resolved.labels.hamlet, { minSize: 2 }, "'*' is recorded as the literal groups");
    assert.match(recs[0].summary, /^Display: label visibility city always shown; town min size 0\.$/);
    assert.equal(recs[0].replayable, true);
  });

  test("replay onto a copy of the map applies the override", async () => {
    // the sketch ran on withLabels; replay onto a fresh copy that never had the override
    const r = await h.ok("sketch", { action: "rebase", onto: { path: withLabels } }, 240_000);
    assert.equal(r.completed, true, JSON.stringify(r.conflicts));
    assert.deepEqual(r.applied, [1, 2]);
    // op 1 set city alwaysShow and town minSize 0; op 2 set minSize 2 on every group and cleared states
    assert.deepEqual(await overrides(), {
      city: { "data-always-show": "1", "data-min-size": "2" },
      town: { "data-always-show": null, "data-min-size": "2" },
      states: { "data-always-show": null, "data-min-size": null }
    });
  });

  test("replay onto a map without those groups is a conflict, not a silent drop", async () => {
    const r = await h.ok("sketch", { action: "rebase", onto: { path: without }, onConflict: "skip" }, 240_000);
    assert.ok((r.conflicts as Obj[]).length >= 1, JSON.stringify(r));
    assert.match(JSON.stringify(r.conflicts), /unknown label group/);
  });
});
