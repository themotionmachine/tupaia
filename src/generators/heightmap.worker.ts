import { computeHeightmap, type HeightmapInput } from "./heightmap-kernel";

self.onmessage = (event: MessageEvent<HeightmapInput>) => {
  try {
    const result = computeHeightmap(event.data);
    self.postMessage({ result }, { transfer: [result.heights.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
