import { type ExpansionInput, expandCultures, expandStates } from "./expansion-kernel";
import type { ExpansionOperation } from "./expansion-worker";

self.onmessage = (
  event: MessageEvent<{
    operation: ExpansionOperation;
    input: ExpansionInput;
    offsets: Uint32Array;
    neighbors: Uint32Array;
  }>
) => {
  try {
    const { operation, input, offsets, neighbors } = event.data;
    input.cells.c = Array.from({ length: offsets.length - 1 }, (_, i) =>
      neighbors.subarray(offsets[i], offsets[i + 1])
    );
    const result = operation === "expandStates" ? expandStates(input) : expandCultures(input);
    self.postMessage({ result }, { transfer: [result.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
