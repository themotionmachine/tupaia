import Alea from "alea";
import { ensureEl, minmax } from "../utils";
import { HeightmapKernel } from "./heightmap-kernel";
import { generateHeightmapInWorker } from "./heightmap-worker";

declare global {
  var HeightmapGenerator: HeightmapModule;
}
class HeightmapModule extends HeightmapKernel {
  private generation: AbortController | null = null;
  override setGraph(graph: any) {
    this.width = graphWidth;
    this.height = graphHeight;
    super.setGraph(graph);
  }

  async generate(graph: any): Promise<Uint8Array> {
    this.generation?.abort();
    const generation = new AbortController();
    this.generation = generation;
    const ownsGlobalGraph = typeof grid !== "undefined" && grid === graph;
    TIME && console.time("defineHeightmap");
    try {
      const id = (ensureEl("templateInput")! as HTMLInputElement).value;
      const random = Alea(seed);
      Math.random = random;
      let heights: Uint8Array;
      if (id in heightmapTemplates && typeof Worker !== "undefined" && graph.cellsDesired >= 20000) {
        const result = await generateHeightmapInWorker(
          graph,
          heightmapTemplates[id].template,
          graphWidth,
          graphHeight,
          seed,
          generation.signal
        );
        if (generation.signal.aborted || (ownsGlobalGraph && grid !== graph))
          throw new DOMException("Terrain generation superseded", "AbortError");
        heights = result.heights;
        random.importState(result.randomState);
        Math.random = random;
      } else {
        heights = (
          id in heightmapTemplates ? this.fromTemplate(graph, id) : await this.fromPrecreated(graph, id)
        ) as Uint8Array;
      }
      if (generation.signal.aborted || (ownsGlobalGraph && grid !== graph))
        throw new DOMException("Terrain generation superseded", "AbortError");
      return heights;
    } finally {
      if (this.generation === generation) {
        this.generation = null;
        this.clearData();
      }
      TIME && console.timeEnd("defineHeightmap");
    }
  }

  fromTemplate(graph: any, id: string): Uint8Array | null {
    return this.fromTemplateText(graph, heightmapTemplates[id]?.template || "", id);
  }

  private getHeightsFromImageData(imageData: Uint8ClampedArray): void {
    if (!this.heights) return;
    for (let i = 0; i < this.heights.length; i++) {
      const lightness = imageData[i * 4] / 255;
      const powered = lightness < 0.2 ? lightness : 0.2 + (lightness - 0.2) ** 0.8;
      this.heights[i] = minmax(Math.floor(powered * 100), 0, 100);
    }
  }

  fromPrecreated(graph: any, id: string): Promise<Uint8Array> {
    return new Promise(resolve => {
      // create canvas where 1px corresponds to a cell
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      const { cellsX, cellsY } = graph;
      canvas.width = cellsX;
      canvas.height = cellsY;

      // load heightmap into image and render to canvas
      const img = new Image();
      img.src = `./heightmaps/${id}.png`;
      img.onload = () => {
        if (!ctx) {
          throw new Error("Could not get canvas context");
        }
        this.heights = this.heights || new Uint8Array(cellsX * cellsY);
        ctx.drawImage(img, 0, 0, cellsX, cellsY);
        const imageData = ctx.getImageData(0, 0, cellsX, cellsY);
        this.setGraph(graph);
        this.getHeightsFromImageData(imageData.data);
        canvas.remove();
        img.remove();
        resolve(this.heights);
      };
    });
  }
}

window.HeightmapGenerator = new HeightmapModule();
