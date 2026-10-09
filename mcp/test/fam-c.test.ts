// Cross-track checks for the surface family (tokens, labels, settings, lint, http): the places
// where two tracks touch the same tool or the same diff. Own servers on tests/fixtures/demo.map in
// local mode; never the live site.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { compactChanges, countChanges } from "../src/compact.ts";
import { alive, type Harness, startServer, textOf } from "./helpers.ts";

type Obj = Record<string, any>;

describe("fam-c: pure helpers", () => {
  test("settings/map field diffs pass through compactChanges and count as {changed, names}", () => {
    const changes = {
      burg: { counts: { added: 0, removed: 0, modified: 1 }, modified: [{ i: 1, name: { from: "a", to: "b" } }] },
      settings: { precipitation: { from: 100, to: 150 }, locked: { from: [], to: ["winds"] } },
      map: { name: { from: "A", to: "B" } },
      cells: { gridPrec: 12 }
    };
    const counted = countChanges(changes);
    assert.deepEqual(counted.settings, { changed: 2, names: ["precipitation", "locked"] });
    assert.deepEqual(counted.map, { changed: 1, names: ["name"] });
    assert.deepEqual(counted.burg, { added: 0, removed: 0, changed: 1 });
    assert.deepEqual(counted.cells, { gridPrec: 12 });
    const small = compactChanges(changes) as Obj;
    assert.deepEqual(small.settings, changes.settings, "small diff: settings kept whole");
    assert.deepEqual(small.map, changes.map);
    // a big entity diff is sampled, the field diffs still pass through whole
    const many = Array.from({ length: 20 }, (_, i) => ({ i }));
    const big = compactChanges({
      ...changes,
      burg: { counts: { added: 0, removed: 0, modified: 20 }, modified: many }
    }) as Obj;
    assert.equal(big.burg.modified.length, 3);
    assert.deepEqual(big.burg.more, { modified: 17 });
    assert.deepEqual(big.settings, changes.settings);
  });
});

describe("fam-c: screenshot, map_info and edit across tracks", () => {
  let h: Harness;
  const evalRO = async (code: string, args?: unknown) =>
    ((await h.ok("eval", { code, args, readOnly: true })) as { value: any }).value;
  const images = (r: { content: Array<{ type: string }> }) => r.content.filter(c => c.type === "image");

  before(async () => {
    h = await startServer({ TUPAIA_UNDO_DEPTH: "40" });
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
  });

  after(async () => {
    if (h && alive(h.pid)) await h.close();
  });

  test("screenshot {labels:'all', compare, crop:'changed'} crops the revealed labels and cleans up", async () => {
    // demo.map draws no burg labels until something redraws them: redraw first, let it settle
    await h.ok("edit", { type: "burg", ops: [{ ref: 1, set: { name: "Longong" } }] });
    await h.ok("eval", { code: "await new Promise(r => setTimeout(r, 1200)); return 1", readOnly: true });
    const plain = (await h.ok("screenshot", {})).shotId as string;
    // (after the plain shot: its setView runs the app's zoom handler, which hides the small groups)
    const hiddenBefore = (await evalRO(
      "document.querySelectorAll('#burgLabels g.hidden, #burgLabels text.hidden').length"
    )) as number;
    assert.ok(hiddenBefore > 0, "premise: some burg label groups are hidden at this zoom");

    const r = await h.call("screenshot", { labels: "all", compare: plain, crop: "changed" });
    assert.ok(!r.isError, textOf(r));
    const body = JSON.parse(textOf(r));
    assert.equal(images(r).length, 1, "the revealed labels are a change: one cropped image");
    assert.equal(body.labels.mode, "all");
    assert.ok(body.labels.revealed > 0, `revealed ${body.labels.revealed}`);
    assert.equal(body.compare.with, plain);
    assert.equal(body.compare.bbox.length, 4);
    assert.ok(body.compare.changedPixels > 0);
    // the shot's crop geometry is recorded: inspect maps a pixel of the returned crop
    const at = await h.ok("inspect", { at: { screen: [2, 2], shot: body.shotId } });
    assert.ok(at.kind, JSON.stringify(at).slice(0, 200));
    // nothing stays behind: the temporary style is gone, the labels are hidden again, no trade freeze
    assert.equal(await evalRO("!!document.getElementById('tupaia-labels-all')"), false);
    assert.equal(
      await evalRO("document.querySelectorAll('#burgLabels g.hidden, #burgLabels text.hidden').length"),
      hiddenBefore
    );

    // two labels:'all' shots of the same view: no visible change, a note and no image
    const again = await h.call("screenshot", { labels: "all", compare: body.shotId, crop: "changed" });
    const b2 = JSON.parse(textOf(again));
    assert.equal(images(again).length, 0, textOf(again));
    assert.match(b2.note, /^(nothing changed|no significant change) vs /);
    assert.equal(b2.labels.mode, "all");

    // sideBySide on top
    const sbs = await h.call("screenshot", { labels: "all", compare: plain, crop: "changed", sideBySide: true });
    const b3 = JSON.parse(textOf(sbs));
    assert.equal(images(sbs).length, 1);
    assert.match(b3.compare.sideBySide, /left = before/);
  });

  test("map_info {diff:'counts'} counts settings changes by name; edit map keeps entity counts only", async () => {
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    const s0 = ((await h.ok("map_info", { since: "none" })).settings as Obj).precipitation as number;
    const r = await h.ok("edit", { type: "map", ops: [{ set: { precipitation: s0 + 17 }, lock: ["winds"] }] });
    assert.ok(!r.changes || !("settings" in (r.changes as Obj)), "settings are in applied, not in changes");
    const counts = await h.ok("map_info", { diff: "counts" });
    assert.equal(counts.changed, true);
    const st = (counts.changes as Obj).settings as Obj;
    assert.equal(st.changed, 2, JSON.stringify(counts.changes));
    assert.deepEqual([...st.names].sort(), ["locked", "precipitation"]);
    assert.equal(st.added, undefined, "no added/removed rows for settings");
    assert.equal(counts.name, undefined, "counts has no overview");
    // the list form keeps the from/to values
    const list = await h.ok("map_info", { since: "snapshot" });
    assert.deepEqual(((list.changes as Obj).settings as Obj).precipitation, { from: s0, to: s0 + 17 });
    // rows:'ids' still works on a map edit (tokens' option through settings' handler)
    const ids = await h.ok("edit", { type: "map", ops: [{ set: { precipitation: s0 } }], rows: "ids" });
    assert.ok(Array.isArray(ids.appliedIds), JSON.stringify(ids).slice(0, 300));
    assert.equal(ids.applied, undefined);
  });

  test("lint's label checks follow display {labels} overrides (alwaysShow shows, a never-show bound hides)", async () => {
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    await h.ok("eval", { code: "1", readOnly: true, redraw: ["labels"] });
    // a burg label group with two labels that the app's rule hides at zoom 1: stack its two labels
    const hid = await evalRO(`
      for (const g of document.querySelectorAll('#burgLabels > g')) {
        const t = [...g.querySelectorAll('text')];
        const d = +g.dataset.size, rel = Math.max(Math.round(((d + d) / 2) * 100) / 100, 1);
        if (t.length >= 2 && d > 0 && rel < 6) return { g: g.id, a: t[0].id, b: t[1].id };
      }
      return null;`);
    assert.ok(hid, "premise: a burg label group hidden at zoom 1");
    await evalRO(
      `const a = document.getElementById(args.a), b = document.getElementById(args.b);
       b.setAttribute('x', a.getAttribute('x')); b.setAttribute('y', a.getAttribute('y')); return 1`,
      hid
    );
    const idA = Number(hid.a.replace("burgLabel", ""));
    const idB = Number(hid.b.replace("burgLabel", ""));
    const pairFound = (out: Obj) =>
      ((out.rows?.["label-overlap"] ?? []) as Obj[]).some(
        r =>
          r.e.some((t: unknown[]) => t[0] === "burg" && t[1] === idA) &&
          r.e.some((t: unknown[]) => t[0] === "burg" && t[1] === idB)
      );
    const lint = (args: Obj) => h.ok("lint", { checks: ["label-overlap"], limit: 200, ...args });

    assert.equal(pairFound(await lint({ atScale: 1 })), false, "hidden at zoom 1 by the app's rule");
    await h.ok("display", { labels: { [hid.g]: { alwaysShow: true } } });
    const shown = await lint({ atScale: 1 });
    assert.equal(pairFound(shown), true, `alwaysShow: the group shows at zoom 1 (${JSON.stringify(shown.notes)})`);

    // an upper bound under any reachable size: the group never shows, so lint does not measure it
    await h.ok("display", { labels: { [hid.g]: { alwaysShow: null, minSize: 0, maxSize: 0.5 } } });
    const never = await lint({});
    assert.equal(pairFound(never), false, JSON.stringify(never.notes));
    assert.ok(
      (never.notes as string[]).some(n => /never show/.test(n)),
      `the note counts never-shown labels: ${JSON.stringify(never.notes)}`
    );
    // and a raised lower bound moves the probe zoom up, where the pair is found again
    await h.ok("display", { labels: { [hid.g]: { minSize: 30, maxSize: null } } });
    const raised = await lint({});
    assert.equal(pairFound(raised), true, JSON.stringify(raised.notes));
    await h.ok("display", { labels: { [hid.g]: null } });
  });

  test("a float-noise-free digest: an unchanged map has an empty counts diff after a checkpoint", async () => {
    await h.ok("map_info", { since: "none" }); // sets the checkpoint
    const c = await h.ok("map_info", { since: "checkpoint", diff: "counts" });
    assert.equal(c.changed, false, JSON.stringify(c));
  });
});
