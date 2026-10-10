// apply: matching by id and aliases, and the accepted-difference baseline (item 7 of the
// story-polish fixes). Pure parts (aliases merged into entries, baseline items and filtering,
// the compact result) run without a browser; the rest on tests/fixtures/demo.map:
//   - match order id > name (exact, folded) > aliases (declared, then a river's name + type word:
//     'Nelbaz river' finds Nelbaz, type River); none of id/alias renames; rows say `by`;
//   - upsert never creates an entity matched by alias (no duplicate river), and two entries
//     reaching one entity by alias are a CONFLICT, not a create;
//   - mode 'baseline' writes the check's differences; a check with baseline is clean, a change to
//     one entity is exactly the one new drift, a changed accepted value is reported again (stale).
// With the primordial-soup builder's data on this machine, the same against copies of its
// build-spec.json and polish-final.map (skipped elsewhere).
// Fixture (demo.map): rivers 2 Ngauping, 4 Nelbaz, 5 Lukfung, 6 Maracenda, 9 Weisental (type
// River), 3 Lungongmun (Fork); burgs 1 Longong (pop 15067), 2 Krar (30415).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { baselineOf, type CheckRow, canonical, filterBaseline } from "../src/apply-baseline.ts";
import { normalizeSpec, withAliases } from "../src/apply-spec.ts";
import { shapeResult } from "../src/tools/apply.ts";
import { errorBody, type Harness, startServer } from "./helpers.ts";

type Obj = Record<string, any>;

describe("apply aliases and baseline (no browser)", () => {
  test("aliases beside the spec join its entries: strings as aliases, a number as id; unknown names are noted", () => {
    assert.deepEqual(withAliases({ name: "A", aliases: "x" }, ["y", 4]), { name: "A", aliases: ["x", "y"], id: 4 });
    assert.deepEqual(withAliases({ name: "A", id: 2 }, 7), { name: "A", id: 2 }, "the entry's own id wins");
    assert.deepEqual(withAliases({ text: "L" }, { id: "label3" }), { text: "L", id: "label3" });
    const s = normalizeSpec(
      {
        rivers_intended: [
          { name: "NE hollow brook", to: [1, 2] },
          { name: "Melstone brook", aliases: "Melstone" }
        ],
        labels: [{ text: "The Bay" }],
        aliases: { rivers_intended: { "NE hollow brook": "Northeast Hollow" } }
      },
      {},
      { lists: { rivers_intended: "rivers" } },
      undefined,
      undefined,
      { rivers: { "NE hollow brook": [8], Nope: "x" }, labels: { "The Bay": { id: "label16" } } }
    );
    assert.deepEqual(s.lists.find(l => l.key === "rivers")?.entries, [
      { name: "NE hollow brook", aliases: ["Northeast Hollow"], id: 8, points: [{ x: 1, y: 2 }] },
      { name: "Melstone brook", aliases: ["Melstone"] }
    ]);
    assert.deepEqual(s.lists.find(l => l.key === "labels")?.entries, [{ text: "The Bay", id: "label16" }]);
    assert.ok(!s.skipped.includes("aliases"), "the file's aliases is not a list");
    assert.ok(
      s.notes.some(n => n.includes("rivers 'Nope'")),
      s.notes.join(" | ")
    );
  });

  const rows: CheckRow[] = [
    { at: "map", status: "differs", diffs: [{ field: "lock", have: [], want: ["mapSize"] }] },
    { at: "burgs[0]", key: "A", i: 1, status: "unchanged" },
    {
      at: "burgs[1]",
      key: "B",
      i: 2,
      status: "differs",
      diffs: [
        { field: "population", have: 10, want: 12 },
        { field: "move", px: 3, have: { x: 1, y: 1 }, want: { x: 4, y: 1 } }
      ]
    },
    { at: "burgs[1].note", key: "burg2", status: "differs", diffs: [{ field: "legend", have: "a", want: "b" }] },
    { at: "rivers[0]", key: "R", status: "missing" },
    { at: "rivers[0].note", status: "missing" },
    { at: "labels[0]", key: "L", status: "error", error: { code: "REFUSED", message: "curved" } }
  ];

  test("a baseline holds one item per difference, missing entry and error (entity key + field + have + want)", () => {
    const b = baselineOf(rows, { specPath: "/s.json" });
    assert.equal(b.kind, "tupaia-apply-baseline");
    assert.equal(b.specPath, "/s.json");
    assert.deepEqual(b.items, [
      { list: "map", key: "map", field: "lock", have: [], want: ["mapSize"] },
      { list: "burgs", key: "B", field: "population", have: 10, want: 12 },
      { list: "burgs", key: "B", field: "move", px: 3, have: { x: 1, y: 1 }, want: { x: 4, y: 1 } },
      { list: "burgs.note", key: "burg2", field: "legend", have: "a", want: "b" },
      { list: "rivers", key: "R", status: "missing" },
      { list: "rivers.note", key: "R", status: "missing" },
      { list: "labels", key: "L", status: "error", error: { code: "REFUSED", message: "curved" } }
    ]);
    assert.equal(canonical({ b: 1, a: [{ d: 2, c: 1 }] }), canonical({ a: [{ c: 1, d: 2 }], b: 1 }));
  });

  test("filtering: accepted rows become 'accepted', new and changed differences stay, stale items are counted", () => {
    const b = baselineOf(rows);
    const same = filterBaseline(rows, b);
    assert.equal(same.baselined, 7);
    assert.deepEqual(same.stale, []);
    assert.deepEqual(
      same.rows.map(r => r.status),
      ["accepted", "unchanged", "accepted", "accepted", "accepted", "accepted", "accepted"]
    );
    // B's population changed again (12 wanted, now 11), and B gained a new difference
    const later = structuredClone(rows);
    later[2].diffs = [
      { field: "population", have: 11, want: 12 },
      { field: "move", px: 3, have: { x: 1, y: 1 }, want: { x: 4, y: 1 } },
      { field: "culture", have: "x", want: "y" }
    ];
    const f = filterBaseline(later, b);
    assert.equal(f.baselined, 6);
    assert.deepEqual(f.rows[2].diffs, [
      { field: "population", have: 11, want: 12 },
      { field: "culture", have: "x", want: "y" }
    ]);
    assert.deepEqual(f.stale, [{ list: "burgs", key: "B", field: "population", have: 10, want: 12 }]);
    // the compact result: accepted rows counted, not listed
    const shaped = shapeResult(
      {
        rows: f.rows as any,
        ignored: {},
        unsupported: [],
        steps: [],
        also: {},
        notes: [],
        wouldChange: 0
      },
      { mode: "check" }
    );
    assert.equal((shaped.counts as Obj).accepted, 5);
    assert.deepEqual(
      (shaped.rows as Obj[]).map(r => r.at),
      ["burgs[1]"]
    );
  });
});

describe("tupaia-mcp apply: ids, aliases, baseline (demo.map)", () => {
  let h: Harness;
  let out: string;
  const rivers = async (): Promise<number> =>
    (await h.ok("eval", { code: "return pack.rivers.length", readOnly: true })).value as number;
  const riverName = async (i: number): Promise<string> =>
    (await h.ok("eval", { code: `return pack.rivers.find(r => r.i === ${i}).name`, readOnly: true })).value as string;
  const rowAt = (r: Obj, at: string) => (r.rows as Obj[]).find(x => x.at === at) as Obj;
  // a course apply can create a river along (addprov.test.ts 'Spec Brook')
  const COURSE = { from: [837.94, 585.7], to: [850, 600], via: [] };
  const mapping = { lists: { rivers_intended: "rivers" } };

  before(async () => {
    h = await startServer();
    out = fs.realpathSync(h.env.TUPAIA_OUT);
    await h.ok("load_map", { path: "tests/fixtures/demo.map" });
    const names = (await h.ok("eval", {
      code: "return [2,3,4,5,6,9].map(i => { const r = pack.rivers.find(x => x.i === i); return r.name + ' ' + r.type; })",
      readOnly: true
    })) as Obj;
    assert.deepEqual(names.value, [
      "Ngauping River",
      "Lungongmun Fork",
      "Nelbaz River",
      "Lukfung River",
      "Maracenda River",
      "Weisental River"
    ]);
  });
  after(async () => h?.close());

  test("match order: id, then name, then aliases (declared, then name + type word); rows say how", async () => {
    const c = await h.ok("apply", {
      mode: "check",
      verbose: true,
      rivers: [
        { name: "Nelbaz river" }, // name + type word
        { name: "The Great Ngauping", aliases: ["Ngauping"] }, // declared alias
        { id: 5, name: "Maracenda" }, // id beats the name (Maracenda is river 6)
        { name: "Lungongmun", aliases: ["Weisental"] }, // the name beats an alias
        { id: 99999, name: "Weisental river" }, // no such id: then the name tiers
        { name: "Lukfung brook" } // Lukfung is a River, not a Brook: not found
      ]
    });
    const r = (k: number) => rowAt(c, `rivers[${k}]`);
    assert.equal(r(0).status, "unchanged", JSON.stringify(c.rows));
    assert.equal(r(0).i, 4);
    assert.equal(r(0).by, "name+type 'Nelbaz River'");
    assert.deepEqual([r(1).i, r(1).by, r(1).name], [2, "alias 'Ngauping'", "Ngauping"]);
    assert.deepEqual([r(2).i, r(2).by, r(2).status], [5, "id", "unchanged"]);
    assert.deepEqual([r(3).i, r(3).by], [3, undefined]);
    assert.deepEqual([r(4).i, r(4).by], [9, "name+type 'Weisental River' (no river 99999)"]);
    assert.equal(r(5).status, "error");
    assert.match(r(5).error.message, /^missing; a new river needs its course/);
    assert.deepEqual(c.matched, { "name+type": 2, alias: 1, id: 1 });

    // an id or alias match never renames; a burg by id compares its other fields
    const up = await h.ok("apply", {
      rivers: [
        { name: "The Great Ngauping", aliases: ["Ngauping"] },
        { id: 5, name: "Maracenda" }
      ],
      burgs: [{ id: 1, name: "Longong Prime", population: 15067 }]
    });
    assert.equal(up.changed, false, JSON.stringify(up));
    assert.deepEqual(up.counts, { unchanged: 3 });
    assert.equal(await riverName(2), "Ngauping");
    assert.equal(await riverName(5), "Lukfung");
  });

  test("upsert never duplicates an entity matched by alias or name + type word", async () => {
    const n0 = await rivers();
    // without the alias it would be created (check: missing, and the create would work)
    const plain = await h.ok("apply", { mapping, rivers_intended: [{ name: "Spec Brook", ...COURSE }], mode: "check" });
    assert.equal(rowAt(plain, "rivers[0]").status, "missing", JSON.stringify(plain.rows));
    const spec = {
      mapping,
      rivers_intended: [
        { name: "Spec Brook", aliases: ["Weisental"], ...COURSE, note: "a brook" },
        { name: "Olsneske river", ...COURSE }
      ]
    };
    const up = await h.ok("apply", spec);
    assert.equal(up.created && (up.created as Obj).rivers, undefined, JSON.stringify(up));
    assert.equal(await rivers(), n0, "no river was created");
    assert.equal(await riverName(9), "Weisental", "not renamed");
    const again = await h.ok("apply", { ...spec, mode: "check" });
    assert.deepEqual(again.counts, { unchanged: 3 }, JSON.stringify(again.rows));
    assert.deepEqual(again.matched, { alias: 1, "name+type": 1 });
    await h.ok("snapshot", { action: "undo" }); // the note

    // two entries reaching one river (by name and by alias): a CONFLICT row, nothing created
    const two = await h.ok("apply", {
      rivers: [{ name: "Nelbaz" }, { name: "Nelbaz Water", aliases: ["Nelbaz"], points: [{ x: 838, y: 586 }] }],
      mode: "update"
    });
    assert.equal(rowAt(two, "rivers[1]").status, "error");
    assert.equal(rowAt(two, "rivers[1]").error.code, "CONFLICT");
    // aliases that reach two rivers: AMBIGUOUS, with candidates
    const amb = await h.ok("apply", { rivers: [{ name: "Twin", aliases: ["Nelbaz", "Lukfung"] }], mode: "check" });
    assert.equal(rowAt(amb, "rivers[0]").error.code, "AMBIGUOUS");
    assert.equal(rowAt(amb, "rivers[0]").error.candidates.length, 2);
    assert.equal(await rivers(), n0);
  });

  test("baseline: written by mode 'baseline', a re-check is clean, one change is exactly one drift", async () => {
    const spec = {
      burgs: [
        { name: "Longong", population: 15000 },
        { name: "Krar", population: 30415 },
        { name: "Newtown", x: 838, y: 586 }
      ],
      rivers: [{ name: "Nelbaz", note: "The Nelbaz." }, { name: "Spec Brook" }]
    };
    const raw = await h.ok("apply", { ...spec, mode: "check" });
    assert.deepEqual(raw.counts, { unchanged: 2, differs: 1, missing: 2, error: 1 }, JSON.stringify(raw.rows));
    const file = path.join(out, "baselines", "demo.json");
    const b = await h.ok("apply", { ...spec, mode: "baseline", writeBaseline: "baselines/demo.json" });
    assert.equal(b.wroteBaseline, file);
    assert.equal(b.recorded, 4);
    assert.equal(b.clean, true);
    const items = JSON.parse(fs.readFileSync(file, "utf8")).items as Obj[];
    assert.deepEqual(items[0], { list: "burgs", key: "Longong", field: "population", have: 15067, want: 15000 });
    assert.ok(items.some(it => it.list === "rivers.note" && it.key === "river4" && it.status === "missing"));

    const clean = await h.ok("apply", { ...spec, mode: "check", baseline: file });
    assert.equal(clean.clean, true, JSON.stringify(clean));
    assert.equal(clean.baselined, 4);
    assert.deepEqual(clean.counts, { unchanged: 2, accepted: 4 });
    assert.deepEqual(clean.rows, []);
    assert.equal(clean.baselineStale, undefined);

    // one entity changes: exactly that drift is reported
    await h.ok("edit", { type: "burg", ops: [{ ref: "Krar", set: { population: 31000 } }] });
    const one = await h.ok("apply", { ...spec, mode: "check", baseline: "baselines/demo.json" });
    assert.equal(one.clean, false);
    assert.deepEqual(one.counts, { unchanged: 1, accepted: 4, differs: 1 });
    assert.deepEqual(one.rows, [
      {
        at: "burgs[1]",
        key: "Krar",
        i: 2,
        status: "differs",
        diffs: [{ field: "population", have: 31000, want: 30415 }]
      }
    ]);
    // an accepted difference whose value changed is reported again (and its item is stale)
    await h.ok("edit", { type: "burg", ops: [{ ref: "Longong", set: { population: 14000 } }] });
    const moved = await h.ok("apply", { ...spec, mode: "check", baseline: file });
    assert.deepEqual(
      (moved.rows as Obj[]).map(r => [r.key, r.diffs[0].have]),
      [
        ["Longong", 14000],
        ["Krar", 31000]
      ]
    );
    assert.equal(moved.baselined, 3);
    assert.equal(moved.baselineStale, 1);
    assert.deepEqual(moved.staleItems, ["burgs 'Longong' population"]);
    await h.ok("snapshot", { action: "undo", n: 2 });

    // an inline baseline object works the same; the write rules hold; upsert refuses a baseline
    const inline = await h.ok("apply", { ...spec, mode: "check", baseline: JSON.parse(fs.readFileSync(file, "utf8")) });
    assert.equal(inline.clean, true);
    const again = await h.call("apply", { ...spec, mode: "check", writeBaseline: "baselines/demo.json" });
    assert.equal(errorBody(again).error.code, "REFUSED");
    const up = await h.call("apply", { ...spec, baseline: file });
    assert.equal(errorBody(up).error.code, "BAD_ARGS");
    const none = await h.call("apply", { ...spec, mode: "baseline" });
    assert.equal(errorBody(none).error.code, "BAD_ARGS");
    const bad = await h.call("apply", { ...spec, mode: "check", baseline: { nope: 1 } });
    assert.equal(errorBody(bad).error.code, "BAD_ARGS");
  });

  // ------------------------------------------------- the builder's data (when on this machine)
  const SOUP = "/Users/mgm1/Desktop/primordial-soup/map";
  const files = {
    spec: path.join(SOUP, "design", "build-spec.json"),
    map: path.join(SOUP, "build", "polish", "polish-final.map"),
    args: path.join(SOUP, "build", "polish", "apply-base.json")
  };
  const have = Object.values(files).every(f => fs.existsSync(f));

  test("the builder's spec on a copy of polish-final.map: rivers match by name+type or alias, baseline, one drift, no duplicate", {
    skip: !have && "no primordial-soup builder data on this machine",
    timeout: 600_000
  }, async () => {
    // copies only: the builder's files are read, never written
    const spec = path.join(out, "build-spec.json");
    const map = path.join(out, "polish-final.map");
    fs.copyFileSync(files.spec, spec);
    fs.copyFileSync(files.map, map);
    await h.ok("load_map", { path: map });
    const base = JSON.parse(fs.readFileSync(files.args, "utf8")) as Obj;
    const args = {
      ...base,
      specPath: spec,
      // the five rivers whose map names differ by more than the type word
      aliases: {
        rivers_intended: {
          "NE hollow brook": "Northeast Hollow",
          "Klein river (with the Corvallis gorge)": "Klein",
          "The Spire": "Spire",
          "Glassward south-face stream": "Glassward",
          "Unclaimed valley outlet": "Unclaimed Valley"
        }
      }
    };
    const c = await h.ok("apply", { ...args, mode: "check", limit: 2000 }, 300_000);
    assert.deepEqual((c.lists as Obj).rivers, { unchanged: 12 }, JSON.stringify(c.rows).slice(0, 2000));
    assert.deepEqual(c.matched, { "name+type": 7, alias: 5 });
    assert.ok((c.counts as Obj).differs > 80, JSON.stringify(c.counts));

    const b = await h.ok("apply", { ...args, mode: "baseline", writeBaseline: "polish-baseline.json" }, 300_000);
    assert.equal(b.clean, true);
    assert.ok((b.recorded as number) > 90, JSON.stringify(b));
    const clean = await h.ok("apply", { ...args, mode: "check", baseline: "polish-baseline.json" }, 300_000);
    assert.equal(clean.clean, true, JSON.stringify(clean.rows).slice(0, 2000));
    assert.equal(clean.baselined, b.recorded);
    assert.deepEqual(clean.rows, []);

    await h.ok("edit", { type: "burg", ops: [{ ref: "Ballantine", set: { population: 31234 } }] });
    const one = await h.ok("apply", { ...args, mode: "check", baseline: "polish-baseline.json" }, 300_000);
    assert.equal(one.clean, false);
    assert.equal((one.counts as Obj).differs, 1);
    assert.deepEqual(one.rows, [
      {
        at: "burgs[0]",
        key: "Ballantine",
        i: 677,
        status: "differs",
        diffs: [{ field: "population", have: 31234, want: 30000 }]
      }
    ]);
    await h.ok("snapshot", { action: "undo" });

    // upsert of the rivers: every one matched, none created (271 rivers before and after)
    const n0 = await rivers();
    const up = await h.ok("apply", { ...args, only: ["rivers_intended"] }, 300_000);
    assert.deepEqual((up.lists as Obj).rivers, { unchanged: 12 }, JSON.stringify(up));
    assert.equal((up.created as Obj | undefined)?.rivers, undefined);
    assert.equal(await rivers(), n0);
  });
});
