// Cooperative time slicing for long synchronous prepare loops. A slicer yields to the event loop once its current slice
// has run for `budget` ms (or, under the opt-in input policy, earlier when input is pending), so input, rAF and the
// restore clock interleave with a long prepare. Yielding never changes results: callers re-check ctx.stale() after every
// tick, and a superseded job stops at that checkpoint.
//
// PERF B2 (2026-10-19, 100k world, Metal, DPR 2, 3 ABBA reps per arm): longer slices let fewer ~60 ms main-page SVG
// frames in, but the saving stays under the 15% stop-loss on a full (cold) restore prepare: 200 ms -13.4%
// (restore-20261019T213454-068Z), input-pending with a 12 ms floor and a 200 ms cap -12.2% idle
// (restore-20261019T215004-573Z) and +-0 under hover (restore-20261019T214824-846Z), while fixed 200 ms slices raised
// hover event-to-rAF p95 127 -> 173 ms. The default stays SLICE_MS; the other policies remain URL overrides.
export const SLICE_MS = 12;
// The longest slice the opt-in input-pending policy runs without a pending input event (rendering still gets a turn).
export const SLICE_INPUT_CAP_MS = 200;

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

export interface SlicePolicy {
  budget: number; // ms per slice
  inputPending: (() => boolean) | null; // yield early when this reports pending input (null: budget only)
  floor: number; // ms a slice runs before pending input can end it (continuous hover would otherwise yield per draw)
}

// The default policy (SLICE_MS), or the B2 experiment override `?gpu-slice-ms=<ms>` (a fixed budget) /
// `?gpu-slice-ms=input` (yield on pending input after SLICE_MS, else at SLICE_INPUT_CAP_MS; SLICE_MS without the API).
// Read per slicer, so a bench switches arms with history.replaceState between prepares without reloading the page. An
// invalid value keeps the default.
export function slicePolicy(search: string = globalThis.location?.search ?? ""): SlicePolicy {
  let value: string | null = null;
  try {
    value = new URLSearchParams(search).get("gpu-slice-ms");
  } catch {}
  const fixed = { budget: SLICE_MS, inputPending: null, floor: 0 };
  if (value === "input") {
    const scheduling = (
      globalThis.navigator as { scheduling?: { isInputPending?: (options?: object) => boolean } } | undefined
    )?.scheduling;
    // continuous events included: a wheel or a drag starting mid-prepare must abort it at once (motion), not in 200 ms
    if (typeof scheduling?.isInputPending === "function")
      return {
        budget: SLICE_INPUT_CAP_MS,
        inputPending: () => scheduling.isInputPending!({ includeContinuous: true }),
        floor: SLICE_MS
      };
    return fixed;
  }
  const ms = Number(value);
  if (value !== null && Number.isFinite(ms) && ms > 0) return { budget: ms, inputPending: null, floor: 0 };
  return fixed;
}

export interface Slicer {
  // Resolves immediately while the current slice is young; otherwise yields once and starts a new slice.
  tick(): Promise<void>;
  readonly yields: number;
}

export function createSlicer(
  budget = SLICE_MS,
  now: () => number = () => performance.now(),
  yieldFn: () => Promise<void> = yieldToMain,
  inputPending: (() => boolean) | null = null,
  floor = 0
): Slicer {
  let slice = now();
  let yields = 0;
  return {
    get yields() {
      return yields;
    },
    async tick() {
      const elapsed = now() - slice;
      if (elapsed < budget && !(elapsed >= floor && inputPending?.())) return;
      yields++;
      await yieldFn();
      slice = now();
    }
  };
}
