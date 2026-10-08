// Pure tests of the sketch ops log (src/ops.ts) and the replay helpers (src/replay.ts): no browser.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type AddResolved,
  blobOnlyReasons,
  createdSet,
  type EditResolved,
  type IdMap,
  isBlobOnly,
  type OpRecord,
  pairCreated,
  Rewriter,
  rewriteResolved,
  SketchStore,
  summarizeOp,
  Unmapped
} from "../src/ops.ts";
import { bothChanged, bridgeArgs } from "../src/replay.ts";
import type { HistoryEntry } from "../src/snapshots.ts";

function rec(tool: string, resolved: OpRecord["resolved"], extra: Partial<OpRecord> = {}): Omit<OpRecord, "seq"> {
  return {
    tool,
    args: {},
    resolved,
    summary: tool,
    at: "t",
    digestBefore: null,
    digestAfter: null,
    replayable: resolved !== null,
    ...extra
  };
}

const entry = (id: number, op = "edit burg"): HistoryEntry => ({
  id,
  op,
  argsSummary: "",
  at: "t",
  bytes: 0,
  text: "",
  provenance: { kind: "file", opsSince: 0 },
  baselineKey: `undo:${id}`
});

function store(): SketchStore {
  const s = new SketchStore();
  s.begin({ slug: "x", note: null, base: { kind: "file", path: "/m.map", at: "t" }, baseText: "", baseCounts: {} });
  return s;
}

const addBurg: AddResolved = {
  type: "burg",
  items: [{ at: { x: 1, y: 2 }, name: "Newtown" }],
  created: [
    [
      { type: "burg", i: 754 },
      { type: "route", i: 578 }
    ]
  ]
};

describe("ops log", () => {
  test("seq numbering, undo pops the matching op, redo re-appends it with the new undo id", () => {
    const s = store();
    const a = s.append({ ...rec("edit", { type: "burg", ops: [] }), undoId: 10 });
    const b = s.append({ ...rec("add", addBurg), undoId: 11 });
    assert.equal(a?.seq, 1);
    assert.equal(b?.seq, 2);
    const notes = s.onUndo([entry(11, "add burg")]);
    assert.equal(s.current?.ops.length, 1);
    assert.equal(s.current?.redo.length, 1);
    assert.match(notes[0], /op 2 \(add\) removed/);
    s.onRedo([{ from: 11, to: 12 }], ["add burg"]);
    assert.equal(s.current?.ops.length, 2);
    assert.equal(s.current?.ops[1].undoId, 12);
    assert.equal(isBlobOnly(s.current as never), false);
    // a new op after an undo reuses the free number
    s.onUndo([entry(12)]);
    const c = s.append({ ...rec("display", { on: ["zones"], off: [] }), undoId: 13 });
    assert.equal(c?.seq, 2);
    assert.equal(s.current?.redo.length, 0, "a new op clears redo");
  });

  test("undo past the sketch start and a foreign redo are sticky blockers", () => {
    const s = store();
    s.append({ ...rec("edit", { type: "burg", ops: [] }), undoId: 5 });
    s.onUndo([entry(5), entry(4, "load_map")]);
    assert.equal(s.current?.ops.length, 0);
    assert.equal(isBlobOnly(s.current as never), true);
    assert.match(blobOnlyReasons(s.current as never)[0], /undo stepped back past the start/);
    const t = store();
    t.onRedo([{ from: 99, to: 100 }], ["regenerate"]);
    assert.match(blobOnlyReasons(t.current as never)[0], /redo replayed 'regenerate'/);
  });

  test("a non-replayable op makes the sketch blob-only until it is undone", () => {
    const s = store();
    s.append({ ...rec("regenerate", null, { reason: "random" }), undoId: 7 });
    assert.equal(isBlobOnly(s.current as never), true);
    assert.match(blobOnlyReasons(s.current as never)[0], /op 1 \(regenerate\): random/);
    s.onUndo([entry(7, "regenerate")]);
    assert.equal(isBlobOnly(s.current as never), false);
  });

  test("a crash restore of the undo point before the last op drops that op; anything else is a blocker", () => {
    const s = store();
    s.append({ ...rec("edit", { type: "burg", ops: [] }), undoId: 3 });
    s.onCrashRestore("undo", 3, "undo point");
    assert.equal(s.current?.ops.length, 0);
    assert.equal(isBlobOnly(s.current as never), false);
    s.onCrashRestore("snapshot", undefined, "snapshot 2");
    assert.equal(isBlobOnly(s.current as never), true);
  });

  test("not recording: nothing is appended and changes mark the sketch diverged", () => {
    const s = store();
    (s.current as { recording: boolean }).recording = false;
    assert.equal(s.append(rec("edit", { type: "burg", ops: [] })), null);
    s.noteUnlogged("edit");
    assert.match(String(s.current?.diverged), /edit changed the page/);
  });
});

describe("id map and rewriting", () => {
  test("rewrites created ids in places, refs, capitals, notes and paint targets", () => {
    const ops = [{ seq: 1, ...rec("add", addBurg) }] as OpRecord[];
    const idMap: IdMap = { burg: { "754": 760 }, route: { "578": 590 } };
    const rw = new Rewriter(idMap, createdSet(ops));
    const route = rewriteResolved(
      "add",
      {
        type: "route",
        items: [{ through: [{ entity: { type: "burg", ref: 3 } }, { entity: { type: "burg", ref: 754 } }] }],
        created: [[{ type: "route", i: 600 }]]
      },
      rw
    ) as AddResolved;
    assert.deepEqual(route.items[0].through, [
      { entity: { type: "burg", ref: 3 } },
      { entity: { type: "burg", ref: 760 } }
    ]);
    const edit = rewriteResolved(
      "edit",
      { type: "state", ops: [{ ref: 2, set: { capital: 754 }, before: { capital: 9 }, after: { capital: 754 } }] },
      rw
    ) as EditResolved;
    assert.equal(edit.ops[0].set?.capital, 760);
    assert.equal(edit.ops[0].after?.capital, 760);
    const note = rewriteResolved(
      "add",
      { type: "note", items: [{ entity: { type: "burg", ref: 754 }, name: "n" }], created: [[]] },
      rw
    ) as AddResolved;
    assert.deepEqual(note.items[0].entity, { type: "burg", ref: 760 });
    const noteEdit = rewriteResolved("edit", { type: "note", ops: [{ ref: "burg754", set: { name: "x" } }] }, rw);
    assert.equal((noteEdit as EditResolved).ops[0].ref, "burg760");
    const routeEdit = rewriteResolved("edit", { type: "route", ops: [{ ref: 578, set: { name: "r" } }] }, rw);
    assert.equal((routeEdit as EditResolved).ops[0].ref, 590);
    const paint = rewriteResolved(
      "paint_cells",
      { select: { cells: [1, 2] }, set: { state: 3, zone: { ref: 4, op: "add" } } },
      new Rewriter({ state: { "3": 7 } }, new Set(["state:3"]))
    );
    assert.deepEqual((paint as { set: unknown }).set, { state: 7, zone: { ref: 4, op: "add" } });
    // ids the sketch did not create pass through untouched
    const other = rewriteResolved("edit", { type: "burg", ops: [{ ref: 12, set: { name: "y" } }] }, rw);
    assert.equal((other as EditResolved).ops[0].ref, 12);
  });

  test("an unmapped sketch-created id is a dependency conflict", () => {
    const ops = [{ seq: 1, ...rec("add", addBurg) }] as OpRecord[];
    const rw = new Rewriter({}, createdSet(ops));
    assert.throws(
      () => rewriteResolved("edit", { type: "burg", ops: [{ ref: 754, set: { name: "z" } }] }, rw),
      (e: unknown) => e instanceof Unmapped && /burg 754/.test((e as Error).message)
    );
  });

  test("pairCreated pairs by type and order", () => {
    const idMap: IdMap = {};
    const unpaired = pairCreated(idMap, addBurg.created, [[{ type: "burg", i: 755 }]]);
    assert.deepEqual(idMap, { burg: { "754": 755 } });
    assert.deepEqual(unpaired, [{ type: "route", i: 578 }]);
  });
});

describe("replay helpers", () => {
  const r: EditResolved = {
    type: "burg",
    ops: [{ ref: 5, name: "Old", set: { name: "Mine" }, before: { name: "Old" }, after: { name: "Mine" } }]
  };
  test("bothChanged: only when both sides changed the field to different values", () => {
    assert.deepEqual(bothChanged(r, [{ index: 0, before: { name: "Old" } }]), []);
    assert.deepEqual(bothChanged(r, [{ index: 0, before: { name: "Mine" } }]), []);
    const c = bothChanged(r, [{ index: 0, before: { name: "Theirs" } }]);
    assert.equal(c.length, 1);
    assert.match(c[0], /^both changed name of burg 'Old' \(5\)/);
  });

  test("bridgeArgs strips the bookkeeping fields from edit ops", () => {
    assert.deepEqual(bridgeArgs("edit", r), { type: "burg", ops: [{ ref: 5, set: { name: "Mine" } }] });
    assert.deepEqual(bridgeArgs("edit", { type: "map", ops: [{ set: { name: "M" }, before: {}, after: {} }] }), {
      type: "map",
      ops: [{ set: { name: "M" } }]
    });
  });

  test("summaries are one sentence", () => {
    assert.equal(summarizeOp("edit", r, null), 'Edited burg "Old" (5): name "Old" -> "Mine".');
    assert.equal(summarizeOp("display", { on: ["zones"], off: ["labels"] }, null), "Display: on zones; off labels.");
  });
});
