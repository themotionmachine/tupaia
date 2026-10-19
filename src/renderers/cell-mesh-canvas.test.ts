import { afterEach, describe, expect, it, vi } from "vitest";
import { meshKey } from "./cell-mesh-canvas";

afterEach(() => vi.unstubAllGlobals());

function graph() {
  return {
    cells: {
      i: [0, 1],
      v: [
        [0, 1, 2],
        [1, 2, 3]
      ]
    },
    vertices: {
      p: [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10]
      ]
    }
  };
}

describe("cell mesh raster reuse", () => {
  it("keys on every vertex index and coordinate bit", () => {
    const base = graph();
    const key = meshKey(base.cells, base.vertices.p);
    expect(meshKey(graph().cells, graph().vertices.p)).toBe(key);
    const moved = graph();
    moved.vertices.p[3][1] = 10 + 1e-9;
    expect(meshKey(moved.cells, moved.vertices.p)).not.toBe(key);
    const rewired = graph();
    rewired.cells.v[1] = [1, 3, 2];
    expect(meshKey(rewired.cells, rewired.vertices.p)).not.toBe(key);
    const fewer = graph();
    fewer.cells.i = [0];
    expect(meshKey(fewer.cells, fewer.vertices.p)).not.toBe(key);
  });

  it("re-attaches the same raster for unchanged inputs and redraws when geometry or style changes", () => {
    const context = {
      scale: vi.fn(),
      stroke: vi.fn(),
      strokeStyle: "",
      lineWidth: 1,
      globalAlpha: 1
    };
    let encodes = 0;
    const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: () => `data:${++encodes}` };
    const hrefs: string[] = [];
    const image = { setAttribute: (name: string, value: string) => name === "href" && hrefs.push(value) };
    const group = { replaceChildren: vi.fn(), isConnected: true, querySelector: () => image };
    const style = { stroke: "#808080", strokeWidth: "0.1", strokeOpacity: "0.5" };
    const world = graph();
    vi.stubGlobal("document", {
      getElementById: () => group,
      createElementNS: () => image,
      createElement: () => canvas
    });
    vi.stubGlobal("getComputedStyle", () => style);
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe() {}
        disconnect() {}
      }
    );
    const paths: string[] = [];
    vi.stubGlobal(
      "Path2D",
      class {
        constructor(d: string) {
          paths.push(d);
        }
      }
    );
    vi.stubGlobal("customization", 0);
    vi.stubGlobal("pack", world);
    vi.stubGlobal("graphWidth", 100);
    vi.stubGlobal("graphHeight", 50);

    window.drawCellsCanvas();
    window.drawCellsCanvas();
    expect(context.stroke).toHaveBeenCalledTimes(1);
    expect(hrefs).toEqual(["data:1", "data:1"]);
    expect(group.replaceChildren).toHaveBeenCalledTimes(2);
    // every cell as one closed subpath, coordinates at full precision
    expect(paths).toEqual(["M0 0L10 0L10 10ZM10 0L10 10L0 10Z"]);

    world.vertices.p[2][0] = 11; // edited in place: same arrays, new geometry
    window.drawCellsCanvas();
    expect(hrefs.at(-1)).toBe("data:2");

    style.strokeOpacity = "0.6";
    window.drawCellsCanvas();
    expect(hrefs.at(-1)).toBe("data:3");
    expect(context.stroke).toHaveBeenCalledTimes(3);
  });
});
