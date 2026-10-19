import { afterEach, describe, expect, it } from "vitest";
import type { Draw } from "./scene";
import { type CensusSink, SceneCensus } from "./scene-census";

const el = (tagName: string) => ({ tagName }) as unknown as Element;
const page = globalThis as { __gpuSceneCensus?: unknown };

describe("SceneCensus", () => {
  afterEach(() => {
    delete page.__gpuSceneCensus;
  });

  it("is off unless a page installs a sink", () => {
    expect(SceneCensus.open()).toBeNull();
    page.__gpuSceneCensus = true;
    expect(SceneCensus.open()).toBeNull();
  });

  it("counts native draws, compat elements and skips per layer and publishes the snapshot", () => {
    const sink: CensusSink = {};
    page.__gpuSceneCensus = sink;
    const census = SceneCensus.open()!;
    census.skip("ocean", el("g"), "display:none");
    census.skip("labels", el("path"), "no paint");
    const path = el("path");
    const draws = [
      { kind: "shape", element: path, layer: "ocean", subpaths: [], style: {}, d: "" },
      { kind: "compat", element: el("image"), elements: [el("image"), el("image")], layer: "texture", reason: "image" },
      {
        kind: "group",
        element: el("g"),
        layer: "regions",
        opacity: 0.5,
        mask: null,
        children: [{ kind: "shape", element: path, layer: "regions", subpaths: [], style: {}, d: "" }]
      },
      { kind: "trade", element: el("g"), layer: "tradeAnimation", opacity: 1, children: [], unsupported: "" }
    ] as unknown as Draw[];
    const snapshot = census.finish(draws);
    expect(sink.last).toBe(snapshot);
    expect(sink.builds).toBe(1);
    expect(snapshot.layers.ocean).toEqual({
      native: 1,
      compat: 0,
      skipped: 1,
      kinds: { "skipped display:none <g>": 1, "native shape <path>": 1 }
    });
    expect(snapshot.layers.texture).toMatchObject({ native: 0, compat: 2, kinds: { "compat <image> image": 2 } });
    expect(snapshot.layers.regions).toMatchObject({ native: 1, compat: 0, skipped: 0 });
    expect(snapshot.layers.labels).toMatchObject({ native: 0, skipped: 1 });
    expect(snapshot.layers.tradeAnimation.kinds).toEqual({ "native trade": 1 });
  });

  it("numbers successive builds and keeps only the latest snapshot", () => {
    const sink: CensusSink = {};
    page.__gpuSceneCensus = sink;
    SceneCensus.open()!.finish([]);
    const second = SceneCensus.open()!.finish([]);
    expect(second.build).toBe(2);
    expect(sink.last).toBe(second);
  });
});
