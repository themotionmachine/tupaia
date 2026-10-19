import { describe, expect, it } from "vitest";
import { describeMutation, prepareStale, prepareStart, settleAction } from "./motion";

const idle = { preparing: false, lost: false, hasFrame: true, moving: false, suspended: false };
const now = { generation: 1, revision: 4, moving: false, lost: false, disposed: false, suspended: false };
const job = { generation: 1, revision: 4, hadFrame: true };
const current = { wanted: false, revisionCurrent: true, bucketCurrent: true, refinable: true };

describe("prepareStart", () => {
  it("runs when idle, and always for a frame-less (replaced or restored) world", () => {
    expect(prepareStart(idle)).toBe("run");
    expect(prepareStart({ ...idle, hasFrame: false, moving: true })).toBe("run");
  });

  it("defers instead of dropping while a drawable frame is moving", () => {
    expect(prepareStart({ ...idle, moving: true })).toBe("defer");
  });

  it("skips while another prepare runs or the context is lost", () => {
    expect(prepareStart({ ...idle, preparing: true })).toBe("skip");
    expect(prepareStart({ ...idle, lost: true, hasFrame: false })).toBe("skip");
  });

  it("suspends a prepare under an open editor only when a frame exists", () => {
    expect(prepareStart({ ...idle, suspended: true })).toBe("suspend");
    expect(prepareStart({ ...idle, suspended: true, moving: true })).toBe("suspend");
    expect(prepareStart({ ...idle, suspended: true, hasFrame: false })).toBe("run");
    expect(prepareStart({ ...idle, suspended: true, hasFrame: false, moving: true })).toBe("run");
  });

  it("orders skip > suspend > defer > run", () => {
    expect(prepareStart({ ...idle, suspended: true, preparing: true, moving: true })).toBe("skip");
    expect(prepareStart({ ...idle, suspended: true, lost: true })).toBe("skip");
    expect(prepareStart({ ...idle, suspended: true, moving: true })).toBe("suspend");
    expect(prepareStart({ ...idle, moving: true })).toBe("defer");
    expect(prepareStart(idle)).toBe("run");
  });
});

describe("prepareStale", () => {
  it("keeps a current job", () => {
    expect(prepareStale(job, now)).toBe("");
  });

  it("supersedes on world, revision, loss or disposal before considering motion", () => {
    expect(prepareStale(job, { ...now, generation: 2, moving: true })).toBe("superseded");
    expect(prepareStale(job, { ...now, revision: 5 })).toBe("superseded");
    expect(prepareStale(job, { ...now, lost: true })).toBe("superseded");
    expect(prepareStale(job, { ...now, disposed: true })).toBe("superseded");
  });

  it("aborts for motion only when a previous frame can keep drawing", () => {
    expect(prepareStale(job, { ...now, moving: true })).toBe("motion");
    expect(prepareStale({ ...job, hadFrame: false }, { ...now, moving: true })).toBe("");
  });

  it("stops a job with a previous frame when an editor opens, and never a frame-less one", () => {
    expect(prepareStale(job, { ...now, suspended: true })).toBe("suspended");
    expect(prepareStale({ ...job, hadFrame: false }, { ...now, suspended: true })).toBe("");
  });

  it("lets superseded win over suspended and motion", () => {
    expect(prepareStale(job, { ...now, suspended: true, moving: true, revision: 5 })).toBe("superseded");
    expect(prepareStale(job, { ...now, suspended: true, moving: true, disposed: true })).toBe("superseded");
    expect(prepareStale(job, { ...now, suspended: true, moving: true })).toBe("suspended");
  });
});

describe("settleAction", () => {
  it("prepares a deferred job or a stale revision/bucket before refining", () => {
    expect(settleAction({ ...current, wanted: true })).toBe("prepare");
    expect(settleAction({ ...current, revisionCurrent: false })).toBe("prepare");
    expect(settleAction({ ...current, bucketCurrent: false })).toBe("prepare");
  });

  it("refines a current frame with world compat runs, else nothing", () => {
    expect(settleAction(current)).toBe("refine");
    expect(settleAction({ ...current, refinable: false })).toBe("none");
  });
});

// The renderer's composition of the helpers (renderer.ts prepare/settle/motion), replayed over event sequences: every
// invalidation that arrives or is interrupted during motion must end in a completed prepare once motion stops.
class Model {
  generation = 1;
  revision = 0;
  frame: { revision: number } | null = null;
  moving = false;
  suspended = false;
  wanted = false;
  running: { generation: number; revision: number; hadFrame: boolean } | null = null;
  lost = false;
  preparesWhileMoving = 0;

  prepare() {
    const start = prepareStart({
      preparing: !!this.running,
      lost: this.lost,
      hasFrame: !!this.frame,
      moving: this.moving,
      suspended: this.suspended
    });
    if (start === "defer" || start === "suspend") this.wanted = true;
    if (start !== "run") return;
    this.wanted = false;
    this.running = { generation: this.generation, revision: this.revision, hadFrame: !!this.frame };
  }

  // one await checkpoint of an in-flight prepare; `done` = the final one (renderer re-checks before commit)
  step(done = false) {
    const job = this.running;
    if (!job) return;
    const reason = prepareStale(job, { ...this, disposed: false });
    if (reason === "motion" || reason === "suspended") this.wanted = true;
    if (reason) {
      this.running = null;
      // renderer finally: behind -> reschedule
      if (job.generation !== this.generation || job.revision !== this.revision || !this.frame) this.prepare();
      return;
    }
    if (!done) return;
    this.running = null;
    this.frame = { revision: job.revision };
    if (this.moving) this.preparesWhileMoving++;
    if (job.revision !== this.revision) this.prepare();
  }

  invalidate() {
    this.revision++;
    this.prepare();
  }

  motion() {
    this.moving = true;
  }

  // exact camera or watchdog -> settle
  stop() {
    this.moving = false;
    if (!this.frame || this.running || this.moving) return;
    const action = settleAction({
      wanted: this.wanted,
      revisionCurrent: this.frame.revision === this.revision,
      bucketCurrent: true,
      refinable: false
    });
    if (action === "prepare") this.prepare();
  }

  drain() {
    for (let i = 0; i < 10 && this.running; i++) this.step(true);
  }

  settled() {
    return !!this.frame && this.frame.revision === this.revision && !this.wanted && !this.running;
  }
}

function ready(): Model {
  const model = new Model();
  model.prepare();
  model.drain();
  return model;
}

describe("prepare scheduling over gestures", () => {
  it("defers a mid-gesture invalidation and prepares it after the final exact paint", () => {
    const model = ready();
    model.motion();
    model.invalidate();
    expect(model.running).toBeNull();
    model.stop();
    model.drain();
    expect(model.settled()).toBe(true);
    expect(model.preparesWhileMoving).toBe(0);
  });

  it("aborts a prepare overtaken by a gesture and re-runs it once motion stops", () => {
    const model = ready();
    model.invalidate();
    model.step();
    model.motion();
    model.step(true);
    expect(model.frame!.revision).toBe(0); // previous frame keeps drawing
    expect(model.wanted).toBe(true);
    model.stop();
    model.drain();
    expect(model.settled()).toBe(true);
    expect(model.preparesWhileMoving).toBe(0);
  });

  it("parks a prepare overtaken by an editor and runs it once the editor closes", () => {
    const model = ready();
    model.invalidate();
    model.step();
    model.suspended = true;
    model.step(true);
    expect(model.frame!.revision).toBe(0); // previous frame keeps its place while the canvas is hidden
    expect(model.wanted).toBe(true);
    model.invalidate(); // a further revision while suspended only records the prepare
    expect(model.running).toBeNull();
    model.suspended = false;
    model.prepare(); // resume()
    model.drain();
    expect(model.settled()).toBe(true);
  });

  it("records a revision that arrives while an editor is already open, with no prepare in flight", () => {
    const model = ready();
    model.suspended = true;
    model.invalidate();
    expect(model.running).toBeNull();
    expect(model.wanted).toBe(true);
    expect(model.frame!.revision).toBe(0);
    model.suspended = false;
    model.prepare(); // resume()
    model.drain();
    expect(model.settled()).toBe(true);
  });

  it("prepares a replaced world during motion (nothing else could draw)", () => {
    const model = ready();
    model.motion();
    model.generation++;
    model.frame = null;
    model.prepare();
    model.drain();
    expect(model.frame).not.toBeNull();
    model.stop();
    expect(model.settled()).toBe(true);
  });

  it("does not prepare on a lost context and recovers once restored", () => {
    const model = ready();
    model.lost = true;
    model.generation++;
    model.frame = null;
    model.invalidate();
    expect(model.running).toBeNull();
    model.lost = false;
    model.prepare(); // restored()
    model.drain();
    expect(model.settled()).toBe(true);
  });

  it("restarts a superseded prepare at the new revision without waiting for motion to stop", () => {
    const model = ready();
    model.invalidate();
    model.step();
    model.invalidate();
    model.step();
    model.drain();
    expect(model.settled()).toBe(true);
  });
});

describe("describeMutation", () => {
  it("names the attribute, element and parent of the record", () => {
    const parent = { tagName: "g", id: "labels", parentElement: null };
    const target = { tagName: "text", id: "label3", parentElement: parent };
    expect(describeMutation({ type: "attributes", attributeName: "display", target, addedNodes: [], removedNodes: [] }))
      .toBe("@display <text#label3> in #labels");
    expect(describeMutation({ type: "childList", target: parent, addedNodes: [], removedNodes: [] })).toBe(
      "childList <g#labels>"
    );
  });
});
