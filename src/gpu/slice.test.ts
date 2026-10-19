import { describe, expect, it, vi } from "vitest";
import { createSlicer, yieldToMain } from "./slice";

function clock() {
  let t = 0;
  return { now: () => t, at: (ms: number) => (t = ms) };
}

describe("createSlicer", () => {
  it("does not yield while the current slice is young", async () => {
    const { now, at } = clock();
    const yieldFn = vi.fn(async () => {});
    const slice = createSlicer(12, now, yieldFn);
    at(11);
    await slice.tick();
    expect(yieldFn).not.toHaveBeenCalled();
    expect(slice.yields).toBe(0);
  });

  it("yields once the slice has used its budget and starts a new slice after resuming", async () => {
    const { now, at } = clock();
    const yieldFn = vi.fn(async () => {});
    const slice = createSlicer(12, now, yieldFn);
    at(12);
    await slice.tick();
    expect(yieldFn).toHaveBeenCalledTimes(1);
    expect(slice.yields).toBe(1);
    // resumed at t=12: 11 ms of further work does not yield again, 12 ms does
    at(23);
    await slice.tick();
    expect(yieldFn).toHaveBeenCalledTimes(1);
    at(24);
    await slice.tick();
    expect(yieldFn).toHaveBeenCalledTimes(2);
  });

  it("measures the new slice from resume time, not from the yield call", async () => {
    const { now, at } = clock();
    let release!: () => void;
    const yieldFn = () => new Promise<void>(resolve => (release = () => resolve()));
    const slice = createSlicer(10, now, yieldFn);
    at(10);
    const parked = slice.tick();
    at(500); // the event loop ran other work for 490 ms while the job was parked
    release();
    await parked;
    at(505); // 5 ms after resume: under budget
    await slice.tick();
    expect(slice.yields).toBe(1);
  });

  it("stops a superseded loop at the checkpoint right after its yield", async () => {
    const { now, at } = clock();
    let stale = false;
    const processed: number[] = [];
    // a revision or gesture lands while the slice is parked
    const slice = createSlicer(5, now, async () => {
      stale = true;
    });
    const work = async (items: number[]) => {
      for (const item of items) {
        at(item * 3); // each item costs 3 ms of synchronous work
        await slice.tick();
        if (stale) return false;
        processed.push(item);
      }
      return true;
    };
    // item 1 ends at 3 ms (under budget); item 2 reaches 6 ms, yields, and the job stops before processing it
    await expect(work([1, 2, 3, 4, 5, 6])).resolves.toBe(false);
    expect(processed).toEqual([1]);
    expect(slice.yields).toBe(1);
  });

  it("completes an unsuperseded loop, yielding once per slice", async () => {
    const { now, at } = clock();
    const yieldFn = vi.fn(async () => {});
    const slice = createSlicer(12, now, yieldFn);
    // 100 items at 2 ms each: a yield at 12, 24, ... 192 ms (six items per slice)
    for (let i = 1; i <= 100; i++) {
      at(i * 2);
      await slice.tick();
    }
    expect(yieldFn).toHaveBeenCalledTimes(16);
    expect(slice.yields).toBe(16);
  });
});

describe("yieldToMain", () => {
  it("resolves after a macrotask hop, not synchronously", async () => {
    let settled = false;
    const pending = yieldToMain().then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    await pending;
    expect(settled).toBe(true);
  });
});
