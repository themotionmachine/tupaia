import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { HistoryTextStore } from "../src/history-text.ts";
import { SnapshotStore } from "../src/snapshots.ts";

const marks = { writes: 0, launches: 1, callSeq: 1 };

function mapWithCells(values: number[]): string {
  const sections = Array.from({ length: 46 }, () => "");
  sections[0] = "1.130|History test";
  sections[5] = `<svg><text>Map 🗺️</text>${'<path d="M0 0L1 1"/>\n'.repeat(25000)}</svg>`;
  for (const section of [7, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 24, 25, 26, 27, 40, 44]) {
    sections[section] = values.join(",");
  }
  return sections.join("\r\n");
}

test("history preserves every code unit, line ending, empty section and numeric spelling", () => {
  const store = new HistoryTextStore();
  const samples = [
    "",
    "a",
    "a\r\nb\n\rc\r\n",
    "\r\n".repeat(48),
    `${"é🗺️".repeat(10000)}\ud800`,
    Array.from({ length: 46 }, (_, i) => (i === 21 ? "0,-0,1e-8,0.10000,NaN,,Infinity" : "{}")).join("\r\n")
  ];
  for (const text of samples) {
    const entry = store.attach({ text }, text);
    assert.equal(entry.text, text);
    assert.equal(store.encode(text).bytes, Buffer.byteLength(text));
  }
  const demo = fs.readFileSync(new URL("../../tests/fixtures/demo.map", import.meta.url), "utf8");
  const entry = store.attach({ text: demo }, demo);
  assert.equal(entry.text, demo);
  assert.deepEqual(Buffer.from(entry.text), Buffer.from(demo));
});

test("twelve sparse edits to 100K-cell maps retain changed array blocks, not twelve full maps", () => {
  const store = new SnapshotStore(3, 12);
  const values = Array.from({ length: 100000 }, (_, i) => i % 80);
  const sections = mapWithCells(values).split("\r\n");
  const states = values.map(() => 1);
  const expected: string[] = [];
  for (let step = 0; step < 12; step++) {
    states[step * 701] = step + 2;
    sections[25] = states.join(",");
    const text = sections.join("\r\n");
    expected.push(text);
    store.pushUndo("paint", String(step), text);
    store.setRestorePoint(text, `after ${step}`, marks);
  }
  for (let i = 0; i < 12; i++) assert.equal(store.undoStack[i].text, expected[i]);
  const stats = store.storage;
  assert.ok(stats.retainedBytes < Buffer.byteLength(expected[0]) * 1.05, JSON.stringify(stats));
  assert.ok(stats.retainedBytes < stats.logicalBytes / 10, JSON.stringify(stats));
});

test("multistep undo, redo, restore and eviction remain exact without delta parent chains", () => {
  const store = new SnapshotStore(2, 3);
  const texts = Array.from({ length: 6 }, (_, k) => mapWithCells(Array.from({ length: 256 }, (_, i) => i + k)));
  store.add(texts[0], "initial");
  for (let k = 0; k < 5; k++) store.pushUndo("edit", String(k), texts[k]);
  assert.equal(store.undoStack.length, 3);
  const plan = store.planUndo(3, texts[5]);
  assert.ok(plan);
  assert.equal(plan.load.text, texts[2]);
  assert.deepEqual(
    plan.redo.map(e => e.text),
    [texts[5], texts[4], texts[3]]
  );
  store.commitUndo(plan);
  const redo = store.planRedo(3);
  assert.ok(redo);
  assert.deepEqual(
    redo.map(e => e.text),
    [texts[3], texts[4], texts[5]]
  );
  store.commitRedo(redo, texts[2]);
  assert.deepEqual(
    store.undoStack.map(e => e.text),
    texts.slice(2, 5)
  );
  store.setRestorePoint(texts[5], "restored", marks);
  assert.equal(store.newestRestorable()?.text, texts[5]);
  const snap = store.add(texts[5], "last").snap;
  store.add(texts[3], "other");
  assert.equal(store.find("initial"), undefined);
  assert.equal(snap.text, texts[5]);
  assert.equal(store.find("other")?.text, texts[3]);
  assert.equal(store.drop("last")?.text, texts[5]);
});

test("dropping history releases obsolete payload; a divergent edit clears redo", () => {
  const store = new SnapshotStore(1, 1);
  const oldText = "old".repeat(100000);
  store.pushUndo("edit", "", oldText);
  const plan = store.planUndo(1, "after");
  assert.ok(plan);
  store.commitUndo(plan);
  assert.equal(store.redoStack[0].text, "after");
  store.pushUndo("edit", "", "new");
  assert.equal(store.redoStack.length, 0);
  assert.equal(store.storage.logicalBytes, 3);
  assert.equal(store.storage.retainedBytes, 3);
});

test("embedded SVG newlines do not change real demo cell-section chunk boundaries", () => {
  const store = new HistoryTextStore();
  const demo = fs.readFileSync(new URL("../../tests/fixtures/demo.map", import.meta.url), "utf8");
  const sections = demo.split("\r\n");
  assert.ok(sections[5].includes("\n"));
  const original = store.encode(demo);
  const states = sections[25].split(",");
  states[201] = states[201] === "9" ? "8" : "9";
  sections[25] = states.join(",");
  const expected = sections.join("\r\n");
  const changed = store.encode(expected);
  assert.equal(changed.blocks.map(block => block.text).join(""), expected);
  const old = new Set(original.blocks);
  const added = changed.blocks.filter(block => !old.has(block));
  assert.equal(added.length, 1, "a one-cell edit creates only its 128-cell block");
  assert.ok(added[0].bytes < 1500, `new payload was ${added[0].bytes} bytes`);
});
