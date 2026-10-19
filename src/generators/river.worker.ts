import { computeRiverWorker, type RiverWorkerInput } from "./river-worker-input";

self.onmessage = (event: MessageEvent<RiverWorkerInput>) => {
  try {
    const result = computeRiverWorker(event.data);
    self.postMessage(
      { result },
      { transfer: [result.heights.buffer, result.flux.buffer, result.rivers.buffer, result.confluence.buffer] }
    );
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
