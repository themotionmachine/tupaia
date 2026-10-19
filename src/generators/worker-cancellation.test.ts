import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeightmapGraph } from "./heightmap-kernel";
import { generateHeightmapInWorker } from "./heightmap-worker";
import type { RiverInput } from "./river-kernel";
import { generateRiversInWorker } from "./river-worker";

class PendingWorker {
  static instances: PendingWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: unknown;
  terminated = false;
  constructor() {
    PendingWorker.instances.push(this);
  }
  postMessage() {}
  terminate() {
    this.terminated = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  PendingWorker.instances = [];
});

describe("terrain worker cancellation", () => {
  it("terminates a pending worker and rejects without changing live heights", async () => {
    vi.stubGlobal("Worker", PendingWorker);
    const heights = new Uint8Array([25]);
    const graph: HeightmapGraph = {
      cellsDesired: 1,
      cellsX: 1,
      cellsY: 1,
      spacing: 1,
      points: [[0, 0]],
      cells: { c: [[]], h: heights }
    };
    const controller = new AbortController();
    const pending = generateHeightmapInWorker(graph, "Hill 1 1 1 1", 1, 1, "cancel", controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await assertion;
    expect(PendingWorker.instances[0].terminated).toBe(true);
    PendingWorker.instances[0].onmessage?.({ data: { result: { heights: new Uint8Array([99]) } } });
    expect(Array.from(heights)).toEqual([25]);
  });

  it("does not copy or start work for an already aborted river job", async () => {
    vi.stubGlobal("Worker", PendingWorker);
    const controller = new AbortController();
    controller.abort();
    await expect(generateRiversInWorker({} as RiverInput, true, controller.signal)).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(PendingWorker.instances).toHaveLength(0);
  });
});
