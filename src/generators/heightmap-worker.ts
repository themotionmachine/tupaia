import { computeHeightmap, type HeightmapGraph, type HeightmapResult, heightmapInput } from "./heightmap-kernel";

export async function generateHeightmapInWorker(
  graph: HeightmapGraph,
  template: string,
  width: number,
  height: number,
  seed: string,
  signal?: AbortSignal
): Promise<HeightmapResult> {
  if (signal?.aborted) throw new DOMException("Generation aborted", "AbortError");
  const input = heightmapInput(graph, template, width, height, seed);
  if (typeof Worker === "undefined") return computeHeightmap(input);
  const worker = new Worker(new URL("./heightmap.worker.ts", import.meta.url), { type: "module" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<HeightmapResult>((resolve, reject) => {
      onAbort = () => reject(new DOMException("Generation aborted", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      timer = setTimeout(() => reject(new Error("Heightmap worker timed out")), 120_000);
      worker.onmessage = (event: MessageEvent<{ result?: HeightmapResult; error?: string }>) => {
        clearTimeout(timer);
        if (event.data.result) resolve(event.data.result);
        else reject(new Error(event.data.error || "Heightmap worker returned no heights"));
      };
      worker.onerror = event => {
        clearTimeout(timer);
        reject(new Error(event.message));
      };
      const transfer: Transferable[] = [input.points.buffer, input.offsets.buffer, input.neighbors.buffer];
      if (input.heights) transfer.push(input.heights.buffer);
      worker.postMessage(input, transfer);
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    worker.terminate();
  }
}
