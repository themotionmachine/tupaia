import type { RiverInput } from "./river-kernel";
import { computeRiverWorker, type RiverWorkerResult, riverWorkerInput } from "./river-worker-input";

export async function generateRiversInWorker(
  input: RiverInput,
  allowErosion: boolean,
  signal?: AbortSignal
): Promise<RiverWorkerResult> {
  if (signal?.aborted) throw new DOMException("Generation aborted", "AbortError");
  const owned = riverWorkerInput(input, allowErosion);
  if (typeof Worker === "undefined") return computeRiverWorker(owned);
  const worker = new Worker(new URL("./river.worker.ts", import.meta.url), { type: "module" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<RiverWorkerResult>((resolve, reject) => {
      onAbort = () => reject(new DOMException("Generation aborted", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      timer = setTimeout(() => reject(new Error("River worker timed out")), 120_000);
      worker.onmessage = (event: MessageEvent<{ result?: RiverWorkerResult; error?: string }>) => {
        clearTimeout(timer);
        if (event.data.result) resolve(event.data.result);
        else reject(new Error(event.data.error || "River worker returned no data"));
      };
      worker.onerror = event => {
        clearTimeout(timer);
        reject(new Error(event.message));
      };
      worker.postMessage(owned, [
        owned.offsets.buffer,
        owned.neighbors.buffer,
        owned.points.buffer,
        owned.indices.buffer,
        owned.borders.buffer,
        owned.heights.buffer,
        owned.terrain.buffer,
        owned.featuresByCell.buffer,
        owned.reference.buffer,
        owned.haven.buffer,
        owned.precipitation.buffer,
        owned.temperature.buffer
      ]);
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    worker.terminate();
  }
}
