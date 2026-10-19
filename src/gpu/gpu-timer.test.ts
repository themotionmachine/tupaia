import { afterEach, describe, expect, it } from "vitest";
import { GpuFrameTimer, MAX_IN_FLIGHT, Ring, timingRequested } from "./gpu-timer";

const frame = { cpuMs: 2, stateIssued: 10, composites: 1, stencilClears: 0 };

// Fake WebGL2 with the timer extension: results become available only when the test says so.
function fakeGl(supported = true) {
  let id = 0;
  const available = new Set<object>();
  const results = new Map<object, number>();
  const s = {
    created: 0,
    deleted: [] as object[],
    active: null as object | null,
    ended: [] as object[],
    disjoint: false,
    availabilityPolls: 0,
    resultReads: 0
  };
  const gl = {
    QUERY_RESULT_AVAILABLE: 0x8867,
    QUERY_RESULT: 0x8866,
    getExtension: (name: string) => (supported && name === "EXT_disjoint_timer_query_webgl2" ? {} : null),
    createQuery: () => {
      s.created++;
      return { id: id++ };
    },
    deleteQuery: (q: object) => s.deleted.push(q),
    beginQuery: (_target: number, q: object) => {
      if (s.active) throw new Error("nested query");
      s.active = q;
    },
    endQuery: () => {
      s.ended.push(s.active!);
      s.active = null;
    },
    getQueryParameter: (q: object, pname: number) => {
      if (pname === 0x8867) {
        s.availabilityPolls++;
        return available.has(q);
      }
      s.resultReads++;
      if (!available.has(q)) throw new Error("blocking result read");
      return results.get(q);
    },
    getParameter: (pname: number) => {
      if (pname !== 0x8fbb) throw new Error("unexpected parameter");
      const value = s.disjoint;
      s.disjoint = false;
      return value;
    }
  };
  const finish = (ns: number) => {
    for (const q of s.ended) if (!available.has(q)) {
      available.add(q);
      results.set(q, ns);
    }
  };
  return { gl: gl as unknown as WebGL2RenderingContext, s, finish };
}

describe("GpuFrameTimer", () => {
  afterEach(() => {
    delete (globalThis as { __tupaiaGpuTiming?: unknown }).__tupaiaGpuTiming;
  });

  it("is off unless the bench flag is exactly true", () => {
    expect(timingRequested()).toBe(false);
    (globalThis as { __tupaiaGpuTiming?: unknown }).__tupaiaGpuTiming = "yes";
    expect(timingRequested()).toBe(false);
    (globalThis as { __tupaiaGpuTiming?: unknown }).__tupaiaGpuTiming = true;
    expect(timingRequested()).toBe(true);
  });

  it("reports unsupported with a null GPU summary, never zero, and still records CPU", () => {
    const { gl, s } = fakeGl(false);
    const timer = new GpuFrameTimer(gl);
    timer.begin();
    timer.end(frame);
    const t = timer.telemetry();
    expect(t.status).toBe("unsupported");
    expect(t.gpuMs).toBeNull();
    expect(t.cpuMs).toMatchObject({ n: 1, p50: 2 });
    expect(s.created).toBe(0);
  });

  it("reads results only once available, in ms, without blocking reads", () => {
    const { gl, s, finish } = fakeGl();
    const timer = new GpuFrameTimer(gl);
    timer.begin();
    timer.end(frame);
    expect(timer.telemetry().gpuMs).toBeNull();
    expect(timer.telemetry().pending).toBe(1);
    finish(3_500_000);
    const t = timer.telemetry();
    expect(t.gpuMs).toMatchObject({ n: 1, p50: 3.5, max: 3.5 });
    expect(t.pending).toBe(0);
    expect(s.resultReads).toBe(1);
  });

  it("bounds queries in flight and reuses them", () => {
    const { gl, s, finish } = fakeGl();
    const timer = new GpuFrameTimer(gl);
    for (let i = 0; i < 10; i++) {
      timer.begin();
      timer.end(frame);
    }
    expect(s.created).toBe(MAX_IN_FLIGHT);
    expect(timer.telemetry()).toMatchObject({ pending: MAX_IN_FLIGHT, dropped: 10 - MAX_IN_FLIGHT });
    finish(1e6);
    for (let i = 0; i < 3; i++) {
      timer.begin();
      timer.end(frame);
    }
    expect(s.created).toBe(MAX_IN_FLIGHT);
    expect(timer.telemetry().cpuMs!.n).toBe(13);
  });

  it("discards every result in flight after a disjoint event", () => {
    const { gl, s, finish } = fakeGl();
    const timer = new GpuFrameTimer(gl);
    for (let i = 0; i < 3; i++) {
      timer.begin();
      timer.end(frame);
    }
    finish(2e6);
    s.disjoint = true;
    const t = timer.telemetry();
    expect(t).toMatchObject({ disjoint: 1, pending: 0, gpuMs: null });
  });

  it("forgets queries on loss without deleting them, re-attaches on restore and deletes on dispose", () => {
    const old = fakeGl();
    const timer = new GpuFrameTimer(old.gl);
    timer.begin();
    timer.end(frame);
    timer.lose();
    expect(timer.telemetry()).toMatchObject({ status: "lost", pending: 0 });
    expect(old.s.deleted).toHaveLength(0);
    const fresh = fakeGl();
    timer.restore(fresh.gl);
    timer.begin();
    timer.end(frame);
    expect(fresh.s.created).toBe(1);
    timer.dispose(false);
    expect(fresh.s.deleted).toHaveLength(1);
    expect(old.s.deleted).toHaveLength(0);
    expect(timer.telemetry().status).toBe("disposed");
    timer.restore(fresh.gl);
    expect(timer.status).toBe("disposed");
  });

  it("does not delete through a lost context on dispose", () => {
    const { gl, s } = fakeGl();
    const timer = new GpuFrameTimer(gl);
    timer.begin();
    timer.end(frame);
    timer.dispose(true);
    expect(s.deleted).toHaveLength(0);
  });
});

describe("Ring", () => {
  it("keeps the most recent samples and summarizes them", () => {
    const ring = new Ring(4);
    expect(ring.summary()).toBeNull();
    for (const v of [100, 1, 2, 3, 4]) ring.push(v);
    expect(ring.summary()).toEqual({ n: 4, total: 5, sum: 10, p50: 2, p95: 4, max: 4 });
  });
});
