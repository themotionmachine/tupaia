import { type BiomeInput, defineBiomes } from "./biome-kernel";

self.onmessage = (event: MessageEvent<BiomeInput & { offsets: Uint32Array; adjacent: Uint32Array }>) => {
  try {
    const { offsets, adjacent } = event.data;
    const neighbors = Array.from({ length: offsets.length - 1 }, (_, cell) =>
      adjacent.subarray(offsets[cell], offsets[cell + 1])
    );
    const result = defineBiomes({ ...event.data, neighbors });
    self.postMessage({ result }, { transfer: [result.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
