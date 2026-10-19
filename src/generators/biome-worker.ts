import { type BiomeInput, defineBiomes } from "./biome-kernel";

let cancelActive: (() => void) | undefined;
export async function defineBiomesInWorker(input: BiomeInput): Promise<Uint8Array> {
  cancelActive?.();
  cancelActive = undefined;
  if (typeof Worker === "undefined" || input.heights.length < 20000) return defineBiomes(input);
  let worker: Worker | undefined;
  let cancel: (() => void) | undefined;
  try {
    worker = new Worker(new URL("./biome.worker.ts", import.meta.url), { type: "module" });
    return await new Promise<Uint8Array>((resolve, reject) => {
      cancel = () => {
        worker?.terminate();
        reject(new DOMException("Biome generation superseded", "AbortError"));
      };
      cancelActive = cancel;
      worker!.onmessage = (event: MessageEvent<{ result?: Uint8Array; error?: string }>) => {
        if (event.data.result) resolve(event.data.result);
        else reject(new Error(event.data.error || "Biome worker returned no data"));
      };
      worker!.onerror = event => reject(new Error(event.message));
      // Transfer owned numeric copies; never detach live world arrays.
      const offsets = new Uint32Array(input.neighbors.length + 1);
      for (let cell = 0; cell < input.neighbors.length; cell++)
        offsets[cell + 1] = offsets[cell] + input.neighbors[cell].length;
      const adjacent = new Uint32Array(offsets[offsets.length - 1]);
      for (let cell = 0; cell < input.neighbors.length; cell++) adjacent.set(input.neighbors[cell], offsets[cell]);
      const owned = {
        ...input,
        neighbors: [],
        offsets,
        adjacent,
        heights: Uint8Array.from(input.heights),
        flux: Float64Array.from(input.flux),
        rivers: Uint32Array.from(input.rivers),
        reference: Uint32Array.from(input.reference),
        temperature: Float64Array.from(input.temperature),
        precipitation: Float64Array.from(input.precipitation)
      };
      worker!.postMessage(owned, [
        owned.heights.buffer,
        owned.flux.buffer,
        owned.rivers.buffer,
        owned.reference.buffer,
        owned.temperature.buffer,
        owned.precipitation.buffer,
        offsets.buffer,
        adjacent.buffer
      ]);
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    console.warn("Biome worker unavailable; generating on the main thread", error);
    return defineBiomes(input);
  } finally {
    worker?.terminate();
    if (cancelActive === cancel) cancelActive = undefined;
  }
}
