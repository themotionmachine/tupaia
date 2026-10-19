// Cooperative time slicing for long synchronous prepare loops. A slicer yields to the event loop once its current slice
// has run for `budget` ms, so input, rAF and the restore clock interleave with a long prepare. Yielding never changes
// results: callers re-check ctx.stale() after every tick, and a superseded job stops at that checkpoint.
export const SLICE_MS = 12;
// The longest slice the input-pending policy runs without a pending input event (rendering still gets a turn).
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
}

// The default policy, or the B2 experiment override `?gpu-slice-ms=<ms>` / `?gpu-slice-ms=input` (yield on pending
// input via navigator.scheduling.isInputPending, else every SLICE_INPUT_CAP_MS). Read per slicer, so a bench switches
// arms with history.replaceState between prepares without reloading the page. Anything else keeps SLICE_MS.
export function slicePolicy(search: string = globalThis.location?.search ?? ""): SlicePolicy {
  let value: string | null = null;
  try {
    value = new URLSearchParams(search).get("gpu-slice-ms");
  } catch {}
  if (value === "input") {
    const scheduling = (globalThis.navigator as { scheduling?: { isInputPending?: () => boolean } } | undefined)
      ?.scheduling;
    if (typeof scheduling?.isInputPending === "function")
      return { budget: SLICE_INPUT_CAP_MS, inputPending: () => scheduling.isInputPending!() };
    return { budget: SLICE_MS, inputPending: null };
  }
  const ms = Number(value);
  return { budget: value !== null && Number.isFinite(ms) && ms > 0 ? ms : SLICE_MS, inputPending: null };
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
  inputPending: (() => boolean) | null = null
): Slicer {
  let slice = now();
  let yields = 0;
  return {
    get yields() {
      return yields;
    },
    async tick() {
      if (now() - slice < budget && !inputPending?.()) return;
      yields++;
      await yieldFn();
      slice = now();
    }
  };
}
