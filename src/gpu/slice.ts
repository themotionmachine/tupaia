// Cooperative time slicing for long synchronous prepare loops. A slicer yields to the event loop once its current slice
// has run for `budget` ms, so input, rAF and the restore clock interleave with a long prepare. Yielding never changes
// results: callers re-check ctx.stale() after every tick, and a superseded job stops at that checkpoint.
export const SLICE_MS = 12;

// One macrotask hop (MessageChannel, not setTimeout, which clamps nested timers to 4 ms).
export function yieldToMain(): Promise<void> {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export interface Slicer {
  // Resolves immediately while the current slice is young; otherwise yields once and starts a new slice.
  tick(): Promise<void>;
  readonly yields: number;
}

export function createSlicer(
  budget = SLICE_MS,
  now: () => number = () => performance.now(),
  yieldFn: () => Promise<void> = yieldToMain
): Slicer {
  let slice = now();
  let yields = 0;
  return {
    get yields() {
      return yields;
    },
    async tick() {
      if (now() - slice < budget) return;
      yields++;
      await yieldFn();
      slice = now();
    }
  };
}
