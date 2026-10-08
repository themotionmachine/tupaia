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
  sanitizeRecord,
  summarizeOp,
  Unmapped,
  unreplayableReason
} from "../src/ops.ts";
import { bothChanged, bridgeArgs, identityConflicts, replayOps } from "../src/replay.ts";
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

describe("replayability and saved logs", () => {
  test("a paint_cells height rebuild other than 'keep' is not replayable", () => {
    const paint = (rebuild?: string) => ({
      select: { cells: [1, 2] },
      set: { height: { delta: 5, ...(rebuild ? { rebuild } : {}) } }
    });
    assert.equal(unreplayableReason("paint_cells", paint("keep")), null);
    assert.equal(unreplayableReason("paint_cells", paint()), null);
    assert.match(String(unreplayableReason("paint_cells", paint("risk"))), /rebuild:'risk' renumbers every cell/);
    assert.match(String(unreplayableReason("paint_cells", paint("erase"))), /regenerates every state, burg/);
    assert.equal(unreplayableReason("paint_cells", { select: { cells: [1] }, set: { state: 2 } }), null);
    assert.match(String(unreplayableReason("regenerate", null)), /reseeds Math.random/);
  });

  test("sanitizeRecord recomputes replayable, unsafe and summary instead of trusting ops.json", () => {
    const evalRec = sanitizeRecord(
      {
        seq: 3,
        tool: "eval",
        args: { code: "pack.burgs[1].name = 'x'" },
        resolved: { code: "pack.burgs[1].name = 'x'" },
        summary: "Renamed a burg (harmless).",
        unsafe: false,
        replayable: true
      },
      0
    );
    assert.equal(evalRec.unsafe, true);
    assert.equal(evalRec.replayable, true);
    assert.match(evalRec.summary, /^Ran eval \(unsafe, replayed verbatim\): pack\.burgs\[1\]\.name/);
    assert.equal(evalRec.seq, 3);
    // a non-replayable tool claimed replayable
    const regen = sanitizeRecord(
      { seq: 1, tool: "regenerate", resolved: { type: "burg", ops: [] }, replayable: true },
      0
    );
    assert.equal(regen.replayable, false);
    assert.equal(regen.resolved, null);
    assert.match(String(regen.reason), /regenerate/);
    // a risk rebuild claimed replayable
    const risk = sanitizeRecord(
      { tool: "paint_cells", resolved: { select: { cells: [1] }, set: { height: { value: 30, rebuild: "risk" } } } },
      4
    );
    assert.equal(risk.seq, 5, "a missing seq is numbered by position");
    assert.equal(risk.replayable, false);
    // an op the file marks not replayable stays not replayable
    const kept = sanitizeRecord(
      { seq: 2, tool: "edit", resolved: { type: "burg", ops: [] }, replayable: false, reason: "failed part-way" },
      1
    );
    assert.equal(kept.replayable, false);
    assert.equal(kept.reason, "failed part-way");
    // junk
    const junk = sanitizeRecord("nope", 6);
    assert.equal(junk.replayable, false);
    assert.equal(junk.tool, "unknown");
    // undoId never comes from a file
    assert.equal(
      "undoId" in sanitizeRecord({ seq: 1, tool: "display", resolved: { on: [], off: [] }, undoId: 9 }, 0),
      false
    );
  });
});

describe("identity conflicts", () => {
  test("an edit of a reused-id type whose identifying fields changed is a different entity", () => {
    const r: EditResolved = {
      type: "marker",
      ops: [{ ref: 50, name: "Volcano", set: { icon: "x" }, ident: { cell: 10, type: "volcanoes", icon: "v" } }]
    };
    const now = (ident: Record<string, unknown>) => [{ index: 0, ident }];
    assert.deepEqual(identityConflicts(r, now({ cell: 10, type: "volcanoes", icon: "w" })), []);
    const c = identityConflicts(r, now({ cell: 99, type: "inns", icon: "v" }));
    assert.equal(c.length, 1);
    assert.match(
      c[0],
      /^target marker 'Volcano' \(50\) is not the entity the sketch edited \(cell 10 -> 99, type "volcanoes" -> "inns"\)/
    );
    assert.deepEqual(
      identityConflicts(r, now({ cell: 99, type: "inns" }), () => true),
      [],
      "sketch-created: skipped"
    );
    // a field the op sets itself is left to bothChanged
    const move: EditResolved = {
      type: "zone",
      ops: [{ ref: 7, set: { name: "Mine" }, ident: { name: "Old", type: "t" } }]
    };
    assert.deepEqual(identityConflicts(move, now({ name: "Theirs", type: "t" })), []);
    // burgs keep their ids: a rename by someone else is not an identity conflict for an edit
    const burg: EditResolved = {
      type: "burg",
      ops: [{ ref: 5, set: { population: 2 }, ident: { name: "A", cell: 1 } }]
    };
    assert.deepEqual(identityConflicts(burg, now({ name: "B", cell: 1 })), []);
  });

  test("a removal of an entity someone changed since is a conflict", () => {
    const r: EditResolved = {
      type: "burg",
      ops: [{ ref: 5, name: "Avon", remove: true, ident: { name: "Avon", cell: 1, population: 3 } }]
    };
    assert.deepEqual(identityConflicts(r, [{ index: 0, ident: { name: "Avon", cell: 1, population: 3 } }]), []);
    const c = identityConflicts(r, [{ index: 0, ident: { name: "Avon", cell: 1, population: 9 } }]);
    assert.equal(c.length, 1);
    assert.match(
      c[0],
      /^removed by the sketch, but burg 'Avon' \(5\) was changed since by someone else \(population 3 -> 9\)/
    );
  });
});

/** A stand-in page for replayOps: `bridge(fn, args)` answers each bridge call. */
function fakePage(
  bridge: (fn: string, args: Record<string, unknown>) => { ok: boolean; value?: unknown; error?: unknown }
) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let undo = 0;
  const answer = (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    return bridge(fn, args);
  };
  const scope = {
    envelope: async (fn: string, args: Record<string, unknown>) => answer(fn, args),
    call: async (fn: string, args: Record<string, unknown>) => {
      const e = answer(fn, args);
      if (!e.ok) throw new Error(`${fn} failed`);
      return e.value;
    },
    digest: async () => null,
    pushUndo: async () => ++undo
  };
  const ctx = { snapshots: { noteMutation() {} } };
  return { scope: scope as never, ctx: ctx as never, calls };
}

const op = (seq: number, tool: string, resolved: OpRecord["resolved"]): OpRecord => ({ seq, ...rec(tool, resolved) });

describe("replayOps (fake page)", () => {
  test("created ids are positional: removing the highest marker, then adding one that reuses its id", async () => {
    // op 1 removes the pre-existing marker 7; op 2 adds a marker, which got id 7 at sketch time;
    // op 3 edits that new marker. On replay the new marker gets id 12.
    const ops = [
      op(1, "edit", { type: "marker", ops: [{ ref: 7, remove: true }] }),
      op(2, "add", { type: "marker", items: [{ at: { x: 1, y: 2 } }], created: [[{ type: "marker", i: 7 }]] }),
      op(3, "edit", {
        type: "marker",
        ops: [{ ref: 7, set: { icon: "x" }, before: { icon: "a" }, after: { icon: "x" } }]
      })
    ];
    const page = fakePage((fn, args) => {
      if (args.phase === "validate")
        return { ok: true, value: { phase: "validate", errors: [], plan: [{ index: 0, before: { icon: "a" } }] } };
      if (fn === "add")
        return {
          ok: true,
          value: { resolved: { type: "marker", items: args.items, created: [[{ type: "marker", i: 12 }]] } }
        };
      return { ok: true, value: { resolved: { type: args.type, ops: args.ops } } };
    });
    const res = await replayOps(page.ctx, page.scope, ops);
    assert.deepEqual(res.conflicts, []);
    assert.deepEqual(res.applied, [1, 2, 3]);
    const applies = page.calls.filter(c => c.args.phase === "apply");
    assert.deepEqual((applies[0].args.ops as Array<{ ref: number }>)[0].ref, 7, "the removal hits the pre-existing 7");
    assert.deepEqual((applies[2].args.ops as Array<{ ref: number }>)[0].ref, 12, "the edit follows the new marker");
    assert.deepEqual(res.idMap, { marker: { "7": 12 } });
  });

  test("a literal cell list recorded on another cell graph is a conflict; the same graph applies", async () => {
    const paint = op(1, "paint_cells", { select: { cells: [5, 6] }, set: { state: 2 }, graph: "100:abc" });
    for (const [graph, conflicts] of [
      ["100:abc", 0],
      ["104:xyz", 1]
    ] as const) {
      const page = fakePage((fn, args) => {
        if (fn === "cellGraph") return { ok: true, value: { graph } };
        if (args.phase === "validate") return { ok: true, value: { phase: "validate", cells: 2 } };
        return { ok: true, value: { resolved: { select: args.select, set: args.set } } };
      });
      const res = await replayOps(page.ctx, page.scope, [paint]);
      assert.equal(res.conflicts.length, conflicts, graph);
      if (conflicts) {
        assert.match(res.conflicts[0].reason, /cells were renumbered/);
        assert.equal(page.calls.filter(c => c.fn === "paint").length, 0, "nothing painted");
      }
    }
  });

  test("a logged risk rebuild is never replayed, even if a record claims it is", async () => {
    const page = fakePage(() => ({ ok: true, value: {} }));
    const res = await replayOps(page.ctx, page.scope, [
      op(1, "paint_cells", { select: { cells: [1] }, set: { height: { value: 10, rebuild: "risk" } } })
    ]);
    assert.equal(res.stopped, true);
    assert.match(res.conflicts[0].reason, /not replayable: paint_cells height rebuild:'risk'/);
    assert.equal(page.calls.length, 0);
  });

  test("a replayed eval keeps its unsafe mark and a summary built from its code", async () => {
    const e = { ...op(1, "eval", { code: "doSomething()" }), summary: "harmless" };
    const page = fakePage(() => ({ ok: true, value: { value: 1 } }));
    const res = await replayOps(page.ctx, page.scope, [e]);
    assert.equal(res.records[0].unsafe, true);
    assert.match(res.records[0].summary, /^Ran eval \(unsafe, replayed verbatim\): doSomething\(\)/);
  });
});
