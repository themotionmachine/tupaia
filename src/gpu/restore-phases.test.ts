import { describe, expect, it } from "vitest";
import { RestoreClock } from "./restore-phases";

function clock() {
  let t = 0;
  const restore = new RestoreClock(() => t);
  return { restore, at: (ms: number) => (t = ms) };
}

describe("RestoreClock", () => {
  it("is null before any loss and leaves ordinary prepares untracked", () => {
    const { restore } = clock();
    expect(restore.snapshot()).toBeNull();
    expect(restore.prepareStart()).toBe(0);
  });

  it("splits loss -> first draw into contiguous phases", () => {
    const { restore, at } = clock();
    at(100);
    restore.lost();
    at(160);
    restore.restored();
    at(175);
    restore.graphReady();
    at(180);
    const token = restore.prepareStart();
    at(300);
    restore.prepareStep(token, "scene");
    at(420);
    restore.prepareStep(token, "world");
    at(430);
    restore.prepareEnd(token, true);
    at(445);
    restore.drawn();
    expect(restore.snapshot()).toEqual({
      outcome: "drawn",
      lossToRestoredMs: 60,
      restoredToGraphMs: 15,
      graphToPrepareMs: 5,
      prepareMs: 250,
      prepareToDrawMs: 15,
      lossToDrawMs: 345,
      failedPrepares: 0,
      steps: { scene: 120, world: 120 }
    });
  });

  it("keeps phases null while the restore event or a committed prepare is missing", () => {
    const { restore, at } = clock();
    restore.lost();
    expect(restore.prepareStart()).toBe(0); // no restored event yet: a pending prepare is not the recovery
    restore.drawn();
    at(50);
    restore.restored();
    restore.graphReady();
    restore.drawn(); // no committed prepare: not the first valid draw
    expect(restore.snapshot()).toMatchObject({
      outcome: "restoring",
      lossToRestoredMs: 50,
      prepareMs: null,
      lossToDrawMs: null,
      steps: null
    });
  });

  it("counts stale attempts and times only the committed prepare", () => {
    const { restore, at } = clock();
    restore.lost();
    restore.restored();
    restore.graphReady();
    at(10);
    const stale = restore.prepareStart();
    at(40);
    restore.prepareStep(stale, "scene");
    restore.prepareEnd(stale, false);
    at(60);
    const next = restore.prepareStart();
    restore.prepareStep(stale, "clone"); // the superseded job's late checkpoint is ignored
    at(90);
    restore.prepareStep(next, "scene");
    restore.prepareEnd(next, true);
    restore.drawn();
    expect(restore.snapshot()).toMatchObject({
      failedPrepares: 1,
      graphToPrepareMs: 60,
      prepareMs: 30,
      steps: { scene: 30 }
    });
  });

  it("supersedes a recovery interrupted by another loss and ignores the old job", () => {
    const { restore, at } = clock();
    restore.lost();
    restore.restored();
    restore.graphReady();
    const old = restore.prepareStart();
    at(200);
    restore.lost();
    restore.prepareEnd(old, true); // stale job from the previous context cannot close the new episode
    restore.drawn();
    expect(restore.snapshot()).toMatchObject({ outcome: "restoring", prepareMs: null, lossToRestoredMs: null });
  });

  it("marks a disposed recovery and freezes it", () => {
    const { restore, at } = clock();
    restore.lost();
    restore.restored();
    restore.dispose();
    at(20);
    restore.graphReady();
    expect(restore.prepareStart()).toBe(0);
    expect(restore.snapshot()).toMatchObject({ outcome: "disposed", restoredToGraphMs: null });
  });

  it("does not let a later draw rewrite a completed recovery", () => {
    const { restore, at } = clock();
    restore.lost();
    restore.restored();
    restore.graphReady();
    const token = restore.prepareStart();
    restore.prepareEnd(token, true);
    at(30);
    restore.drawn();
    at(500);
    restore.drawn();
    expect(restore.prepareStart()).toBe(0);
    expect(restore.snapshot()?.lossToDrawMs).toBe(30);
  });
});
