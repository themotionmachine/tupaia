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
      "Display: label visibility city min size 0; town default min size, always shown; states override cleared."
    );
    assert.equal(summarizeOp("display", { on: ["zones"], off: [] }, null), "Display: on zones.");
  });

  test("groups with the same override are listed together, many groups are counted, maxSize reads", () => {
    const same: DisplayResolved = {
      on: [],
      off: [],
      labels: { city: { minSize: 0 }, town: { minSize: 0 }, states: { alwaysShow: true, maxSize: 200 } }
    };
    assert.equal(
      summarizeOp("display", same, null),
      "Display: label visibility city, town min size 0; states max size 200, always shown."
    );
    const many: DisplayResolved = {
      on: [],
      off: [],
      labels: Object.fromEntries(["a", "b", "c", "d", "e", "f", "g"].map(g => [g, { minSize: 2 }]))
    };
    assert.equal(summarizeOp("display", many, null), "Display: label visibility 7 groups (a, b, c, ...) min size 2.");
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
  /** The undo stack as text: it changes when an entry is pushed even though the depth cap keeps the count. */
  const undoSig = async () => JSON.stringify((await h.ok("snapshot", { action: "list" })).undo);
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
    const { city, town } = lab.groups;
    assert.deepEqual(
      [city.alwaysShow, city.visible, city.of, city.was, city.zoom],
      [true, before.by.city.total, before.by.city.total, 0, "any"]
    );
    assert.deepEqual(
      [town.minSize, town.visible, town.of, town.was],
      [0, before.by.town.total, before.by.town.total, 0]
    );
    // the zoom the result is for, and the ranges that explain the visibility: with the override the
    // town group shows from the smallest zoom up; by the automatic rule only from a higher one
    assert.ok(Math.abs(lab.zoom - before.scale) < 0.01, `${lab.zoom} vs ${before.scale}`);
    assert.ok(town.zoom[0] <= lab.zoom && town.autoZoom[0] > lab.zoom, JSON.stringify(town));
    assert.ok(lab.visible.inView > 0 && lab.visible.inView <= lab.visible.after, JSON.stringify(lab.visible));
    assert.equal(lab.note, undefined, "something changed, so no note");
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
    const r = await h.ok("display", { labels: { capital: { maxSize: 1000 } } });
    c = await counts();
    assert.equal(c.by.capital.shown, c.by.capital.total, "maxSize moves the upper bound");
    assert.equal((r.labels as Obj).groups.capital.maxSize, 1000);
    assert.equal(await attr("capital", "data-max-size"), "1000");
    await h.ok("display", { labels: { capital: { maxSize: null } } });
    assert.equal(await attr("capital", "data-max-size"), null);
    assert.equal((await counts()).by.capital.shown, 0, "back to the automatic upper bound");
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
    const button0 = await evalRO("layerIsOn('toggleEmblems')");
    await h.ok("eval", {
      code: "emblems.style('display', 'inline'); turnButtonOn('toggleEmblems'); emblems.select('#burgEmblems').attr('font-size', 2); invokeActiveZooming(); return 1",
      readOnly: true
    });
    const hidden = () => evalRO("document.getElementById('burgEmblems').classList.contains('hidden')");
    // two emblem elements in it (drawing real ones needs the Armoria renderer): they count like emblems
    await h.ok("eval", {
      code: "const g = document.getElementById('burgEmblems'); for (let i = 0; i < 2; i++) { const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#coa-x'); g.appendChild(u); } return 1",
      readOnly: true
    });
    assert.equal(await hidden(), true, "2 px x zoom is under the default 25");
    const r = await h.ok("display", { labels: { burgEmblems: { minSize: 1 } } });
    assert.equal(await hidden(), false, "minSize 1 lets it show");
    assert.equal((r.labels as Obj).groups.burgEmblems.minSize, 1);
    assert.deepEqual(
      [
        (r.labels as Obj).groups.burgEmblems.visible,
        (r.labels as Obj).groups.burgEmblems.of,
        (r.labels as Obj).groups.burgEmblems.was
      ],
      [2, 2, 0],
      "the emblems are counted, with the count before"
    );
    assert.equal(await attr("burgEmblems", "data-min-size"), "1");
    await h.ok("display", { labels: { burgEmblems: { minSize: null } } });
    assert.equal(await hidden(), true);
    await h.ok("display", { labels: { burgEmblems: { alwaysShow: true } } });
    assert.equal(await hidden(), false);
    await h.ok("display", { labels: { burgEmblems: null } });
    await h.ok("eval", {
      code: `document.getElementById('burgEmblems').replaceChildren(); emblems.style('display', ${JSON.stringify(display0)}); ${button0 ? "" : "turnButtonOff('toggleEmblems');"} return 1`,
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

  test("a layer turned on later shows the override: no stale hidden class (two calls, or setLayers)", async () => {
    await h.ok("load_map", { path: baseMap });
    await fullMapZoom();
    await h.ok("display", { off: ["labels"] });
    const r = await h.ok("display", { labels: { city: { alwaysShow: true } } });
    assert.match(JSON.stringify(r.warnings), /labels layer is off/);
    await h.ok("display", { on: ["labels"] });
    let c = await counts();
    assert.equal(c.by.city.shown, c.by.city.total, "city labels show after the layer is turned on");
    // the same through setLayers, which a screenshot's layers:{on} uses
    await h.ok("display", { off: ["labels"] });
    await h.ok("display", { labels: { town: { alwaysShow: true } } });
    await h.ok("eval", { code: "await __tupaia.fns.setLayers({ on: ['labels'] }); return 1", readOnly: true });
    c = await counts();
    assert.equal(c.by.town.shown, c.by.town.total, "town labels show after setLayers turned the layer on");
    await h.ok("display", { labels: { "*": null } });
  });

  test("display {labels:'list'} reads the overrides and changes nothing", async () => {
    await h.ok("load_map", { path: baseMap });
    await fullMapZoom();
    const l0 = (await h.ok("display", { labels: "list" })).labels as Obj;
    assert.equal(l0.overrides, 0);
    assert.ok(l0.groups.city.size > 0 && l0.groups.city.of > 0, JSON.stringify(l0.groups.city));
    assert.equal(l0.layers.labels, true);
    assert.equal(l0.autoHide.labels, true);
    assert.ok(l0.empty > 0, "groups with no labels are counted, not listed");
    assert.equal(l0.groups.hamlet, undefined);
    await h.ok("display", { labels: { city: { alwaysShow: true }, states: { minSize: 1, maxSize: 500 } } });
    const undo0 = await undoCount();
    const d0 = await digest();
    const l1 = (await h.ok("display", { labels: "list" })).labels as Obj;
    assert.equal(l1.overrides, 2);
    assert.equal(l1.groups.city.alwaysShow, true);
    assert.deepEqual([l1.groups.states.minSize, l1.groups.states.maxSize], [1, 500]);
    const c1 = await counts();
    assert.equal(l1.visible.now, c1.burgShown + (c1.by.states?.shown ?? 0) + (c1.by.addedLabels?.shown ?? 0));
    assert.ok(l1.visible.inView <= l1.visible.now);
    assert.equal(await undoCount(), undo0, "a read leaves no undo entry");
    assert.equal(await digest(), d0);
    const bad = await h.call("display", { labels: "list", on: ["zones"] });
    assert.equal(errorBody(bad).error.code, "BAD_ARGS");
    assert.match(errorBody(bad).error.message, /only reads/);
    await h.ok("display", { labels: { "*": null } });
  });

  test("the zoom range a group reports is where the app really shows it (with and without an override)", async () => {
    await h.ok("load_map", { path: baseMap });
    await fullMapZoom();
    await h.ok("display", { labels: { capital: { minSize: 12 }, village: { maxSize: 30 } } });
    const l = (await h.ok("display", { labels: "list" })).labels as Obj;
    const kmin = l.reachable[0] as number;
    const at = async (z: number, g: string) => {
      await h.ok("eval", {
        code: `await __tupaia.fns.setView({ view: { x: -100, y: -100, scale: ${z} } }); return scale`,
        readOnly: true
      });
      return (await counts()).by[g];
    };
    let checked = 0;
    for (const g of ["city", "town", "capital", "village"]) {
      const range = l.groups[g].zoom as [number, number | null];
      assert.ok(Array.isArray(range), `${g}: ${JSON.stringify(l.groups[g])}`);
      const [lo, hi] = range;
      const on = (c: { shown: number; total: number }) => c.shown === c.total;
      const off = (c: { shown: number }) => c.shown === 0;
      if (lo > kmin * 1.2) {
        assert.ok(off(await at(lo * 0.9, g)), `${g} hidden under ${lo}`);
        checked++;
      }
      if (hi === null || lo * 1.1 < hi) {
        assert.ok(on(await at(lo * 1.1, g)), `${g} shown over ${lo}`);
        checked++;
      }
      if (hi !== null) {
        assert.ok(on(await at(hi * 0.9, g)), `${g} shown under ${hi}`);
        assert.ok(off(await at(hi * 1.1, g)), `${g} hidden over ${hi}`);
        checked++;
      }
    }
    assert.ok(checked >= 6, `only ${checked} range edges were exercised`);
    await h.ok("display", { labels: { "*": null } });
    await fullMapZoom();
  });

  test("an identical override changes nothing: no undo entry, no recording", async () => {
    await h.ok("display", { labels: { city: { alwaysShow: true }, town: { minSize: 3 } } });
    const undo0 = await undoSig();
    const r = await h.ok("display", { labels: { city: { alwaysShow: true }, town: { minSize: 3 } } });
    assert.equal((r.labels as Obj).unchanged, true);
    assert.match(r.note as string, /unchanged/);
    assert.equal(await undoSig(), undo0);
    const clear = await h.ok("display", { labels: { village: null } });
    assert.equal((clear.labels as Obj).unchanged, true, "clearing a group that has no override is a no-op too");
    assert.equal(await undoSig(), undo0);
    const mixed = await h.ok("display", { labels: { city: { alwaysShow: true }, town: { minSize: 4 } } });
    assert.equal((mixed.labels as Obj).unchanged, undefined);
    assert.notEqual(await undoSig(), undo0, "one group differs, so it is a change with an undo entry");
    await h.ok("display", { labels: { "*": null } });
  });

  test("'*' folds label groups without labels into a count; 'emblems' reaches the three emblem groups", async () => {
    const r = (await h.ok("display", { labels: { "*": { minSize: 0 }, emblems: { minSize: 3 } } })).labels as Obj;
    assert.ok(r.empty > 0, "empty groups are counted");
    for (const [g, info] of Object.entries<Obj>(r.groups)) assert.ok(info.of > 0, `${g} has labels`);
    assert.equal(await attr("hamlet", "data-min-size"), "0", "an empty group still gets the override");
    for (const g of ["burgEmblems", "provinceEmblems", "stateEmblems"])
      assert.equal(await attr(g, "data-min-size"), "3", g);
    await h.ok("display", { labels: { "*": null, emblems: null } });
    assert.equal(await attr("stateEmblems", "data-min-size"), null);
    assert.equal(await attr("city", "data-min-size"), null);
  });

  test("minSize over maxSize is refused; alwaysShow with a size warns; typos get a did-you-mean", async () => {
    const n = await undoCount();
    const bad = await h.call("display", { labels: { city: { minSize: 10, maxSize: 5 } } });
    assert.match(errorBody(bad).error.message, /over maxSize/);
    const typo = errorBody(await h.call("display", { labels: { citys: { minSize: 1 } } })).error;
    assert.match(typo.message, /unknown label group 'citys' \(did you mean 'city'\?\)/);
    const box = errorBody(await h.call("display", { labels: { burgLabels: { minSize: 1 } } })).error;
    assert.match(box.message, /container of the burg label groups/);
    assert.equal(await undoCount(), n);
    const r = await h.ok("display", { labels: { city: { alwaysShow: true, minSize: 3 } } });
    assert.match(JSON.stringify(r.warnings), /do nothing on city/);
    await h.ok("display", { labels: { city: null } });
  });

  test("a warning says when the client's automatic hiding is off; a note says when nothing changed at this zoom", async () => {
    await fullMapZoom();
    const same = (await h.ok("display", { labels: { states: { minSize: 1 } } })).labels as Obj;
    assert.match(same.note, /^no label changed at zoom/, JSON.stringify(same));
    await h.ok("eval", { code: "document.getElementById('hideLabels').checked = false; return 1", readOnly: true });
    const r = await h.ok("display", { labels: { city: { alwaysShow: true } } });
    assert.match(JSON.stringify(r.warnings), /Toggle visibility automatically/);
    await h.ok("eval", { code: "document.getElementById('hideLabels').checked = true; return 1", readOnly: true });
    await h.ok("display", { labels: { "*": null } });
  });

  test("a burg group made later does not inherit the town override (it copies the town style, not the override)", async () => {
    await h.ok("load_map", { path: baseMap });
    await h.ok("display", { labels: { town: { alwaysShow: true, minSize: 2, maxSize: 90 } } });
    await h.ok("eval", {
      code: "options.burgs.groups.push({ ...options.burgs.groups[0], name: 'tp_extra', order: 99 }); drawBurgLabels(); return 1"
    });
    try {
      assert.equal(
        await evalRO("!![...document.querySelectorAll('#burgLabels > g')].find(g => g.id === 'tp_extra')"),
        true
      );
      for (const a of ["data-always-show", "data-min-size", "data-max-size"])
        assert.equal(await attr("tp_extra", a), null, `new group has no ${a}`);
      assert.ok((await attr("tp_extra", "data-size")) !== null, "but it did copy the town style");
      assert.equal(await attr("town", "data-always-show"), "1", "the town group keeps its override");
      assert.equal(await attr("town", "data-max-size"), "90");
    } finally {
      await h.ok("eval", {
        code: "options.burgs.groups = options.burgs.groups.filter(g => g.name !== 'tp_extra'); drawBurgLabels(); return 1"
      });
    }
    await h.ok("display", { labels: { town: null } });
  });

  test("a whole-map shot is taken at the full-map zoom whatever the camera was, and the camera is left alone", async () => {
    await h.ok("load_map", { path: baseMap });
    await fullMapZoom();
    const fontSize = () => evalRO("document.getElementById('states').getAttribute('font-size')");
    const fitSize = await fontSize();
    const a = await h.ok("screenshot", { full: true });
    await h.ok("screenshot", { target: { at: { x: 800, y: 400 } }, zoom: 8 });
    const zoomed = (await evalRO("scale")) as number;
    const zoomedSize = await fontSize();
    assert.ok(zoomed > 7, `zoomed to ${zoomed}`);
    assert.notEqual(zoomedSize, fitSize, "premise: state labels are sized for the zoom");
    const b = await h.ok("screenshot", { full: true, compare: a.shotId as string });
    assert.ok(((b.compare as Obj).changedPct as number) < 0.02, `changed ${(b.compare as Obj).changedPct}%`);
    assert.equal(await evalRO("scale"), zoomed, "the zoom is back");
    assert.equal(await fontSize(), zoomedSize, "and so are the label sizes");
    await fullMapZoom();
  });

  test("a labels:'all' shot that cannot clean up says so, and the next screenshot removes the leftover", async () => {
    await h.ok("eval", {
      code: "const f = __tupaia.fns.labelsShot; globalThis.__labelsShot0 = f; let n = 0; __tupaia.fns.labelsShot = async a => { if (!a.on && !n++) throw new Error('boom'); return f(a); }; return 1",
      readOnly: true
    });
    try {
      const r = await h.ok("screenshot", { labels: "all" });
      assert.match(JSON.stringify(r.notes), /could not be undone/);
      assert.equal(await evalRO("!!document.getElementById('tupaia-labels-all')"), true, "premise: the style stayed");
      await h.ok("screenshot", {});
      assert.equal(await evalRO("!!document.getElementById('tupaia-labels-all')"), false, "removed by the next shot");
    } finally {
      await h.ok("eval", { code: "__tupaia.fns.labelsShot = globalThis.__labelsShot0; return 1", readOnly: true });
    }
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
            out[id] = { 'data-always-show': el.getAttribute('data-always-show'), 'data-min-size': el.getAttribute('data-min-size'), 'data-max-size': el.getAttribute('data-max-size') };
          }
          return out;`
      })
    ).value as Obj;

  test("the op is logged with a literal resolved form and a summary that names the groups", async () => {
    await h.ok("load_map", { path: withLabels });
    await h.ok("sketch", { action: "start", slug: "t-labels" });
    await h.ok("display", { labels: { city: { alwaysShow: true }, town: { minSize: 0 } } });
    await h.ok("display", { labels: { "*": { minSize: 2 }, states: null } });
    await h.ok("display", { labels: { city: { maxSize: 200 } } });
    const again = await h.ok("display", { labels: { city: { alwaysShow: true } } });
    assert.equal((again.labels as Obj).unchanged, true);
    const st = await h.ok("sketch", { action: "status", full: true });
    const recs = st.records as Obj[];
    assert.equal(recs.length, 3, "the no-op call was not recorded");
    assert.equal(st.blobOnly, false);
    assert.deepEqual(recs[0].resolved.labels, { city: { alwaysShow: true }, town: { minSize: 0 } });
    assert.equal(recs[1].resolved.labels.states, null, "a cleared group is null");
    assert.deepEqual(recs[1].resolved.labels.hamlet, { minSize: 2 }, "'*' is recorded as the literal groups");
    assert.match(recs[0].summary, /^Display: label visibility city always shown; town min size 0\.$/);
    assert.match(
      recs[1].summary,
      /^Display: label visibility \d+ groups \(.*\) min size 2; states override cleared\.$/
    );
    assert.deepEqual(recs[2].resolved.labels, { city: { maxSize: 200 } });
    assert.equal(recs[0].replayable, true);
  });

  test("the sketch summary says label visibility depends on the zoom", async () => {
    const s = await h.ok("sketch", { action: "summary", shots: false });
    assert.match(s.markdown as string, /Label visibility depends on the zoom/);
  });

  test("replay onto a copy of the map applies the override", async () => {
    // the sketch ran on withLabels; replay onto a fresh copy that never had the override
    const r = await h.ok("sketch", { action: "rebase", onto: { path: withLabels } }, 240_000);
    assert.equal(r.completed, true, JSON.stringify(r.conflicts));
    assert.deepEqual(r.applied, [1, 2, 3]);
    // op 1 set city alwaysShow and town minSize 0; op 2 set minSize 2 on every group and cleared states;
    // op 3 set city maxSize 200
    assert.deepEqual(await overrides(), {
      city: { "data-always-show": "1", "data-min-size": "2", "data-max-size": "200" },
      town: { "data-always-show": null, "data-min-size": "2", "data-max-size": null },
      states: { "data-always-show": null, "data-min-size": null, "data-max-size": null }
    });
  });

  test("replay onto a map without those groups is a conflict, not a silent drop", async () => {
    const r = await h.ok("sketch", { action: "rebase", onto: { path: without }, onConflict: "skip" }, 240_000);
    assert.ok((r.conflicts as Obj[]).length >= 1, JSON.stringify(r));
    assert.match(JSON.stringify(r.conflicts), /unknown label group/);
  });
});
