import { describe, expect, it } from "vitest";
import { cpuVsWait, diffMetrics, pickMetrics, summarizeCpuProfile } from "./route-state-probe";

describe("route-state probe summaries", () => {
  it("splits a CPU profile into idle and busy self time with callsites", () => {
    const frame = (functionName: string, url = "", lineNumber = -1) => ({ functionName, url, lineNumber });
    const profile = {
      nodes: [
        { id: 1, callFrame: frame("(root)"), children: [2, 3, 4] },
        { id: 2, callFrame: frame("(idle)") },
        { id: 3, callFrame: frame("isolate", "http://localhost/gpu/compat.js?v=1", 9) },
        { id: 4, callFrame: frame("(garbage collector)") }
      ],
      startTime: 0,
      endTime: 10000,
      samples: [2, 3, 3, 4, 2],
      timeDeltas: [0, 1000, 2000, 3000, 500, 0]
    };
    const s = summarizeCpuProfile(profile);
    // sample i spends timeDeltas[i + 1]: idle 1 + 0, isolate 2 + 3, gc 0.5
    expect(s.idleMs).toBe(1);
    expect(s.scriptMs).toBe(5);
    expect(s.gcMs).toBe(0.5);
    expect(s.busyMs).toBe(5.5);
    expect(s.wallMs).toBe(10);
    expect(s.top[0]).toEqual(["isolate compat.js:10", 5]);
    expect(s.top.find(([k]) => k === "(idle)")).toBeUndefined();
  });

  it("keeps, converts and diffs CDP metrics, and derives CPU vs wait", () => {
    const a = pickMetrics([{ name: "TaskDuration", value: 1.5 }, { name: "Nodes", value: 100 }, { name: "JSHeapUsedSize", value: 1048576 }, { name: "Other", value: 3 }]);
    expect(a).toEqual({ TaskMs: 1500, Nodes: 100, JSHeapUsedMB: 1 });
    const b = pickMetrics([{ name: "TaskDuration", value: 2.25 }, { name: "Nodes", value: 160 }, { name: "JSHeapUsedSize", value: 3145728 }]);
    const d = diffMetrics(a, b);
    expect(d).toEqual({ TaskMs: 750, Nodes: 60, JSHeapUsedMB: 2 });
    expect(cpuVsWait(1000, d)).toMatchObject({ taskMs: 750, waitMs: 250, taskFraction: 0.75 });
    expect(cpuVsWait(500, d).waitMs).toBe(0);
  });
});
