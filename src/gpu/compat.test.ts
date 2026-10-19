import { describe, expect, it, vi } from "vitest";

const { prepareMapClone } = vi.hoisted(() => ({
  prepareMapClone: vi.fn((_type: string, _options?: unknown) => Promise.resolve({} as SVGSVGElement))
}));
vi.mock("../io/export", () => ({ prepareMapClone }));

import { compatClone, forgetCompatClone } from "./compat";

describe("compat clone", () => {
  // the scene walks the live #viewbox including #debug (editor overlays such as the route editor's #controlPoints);
  // a clone without #debug made every compat element there unresolvable and the renderer fell back to SVG
  it("keeps #debug so editor overlays resolve in the clone", async () => {
    forgetCompatClone();
    await compatClone(1);
    expect(prepareMapClone).toHaveBeenCalledWith("gpu", { debug: true });
  });

  it("reuses the clone within a revision and rebuilds it on the next", async () => {
    forgetCompatClone();
    prepareMapClone.mockClear();
    await compatClone(7);
    await compatClone(7);
    expect(prepareMapClone).toHaveBeenCalledTimes(1);
    await compatClone(8);
    expect(prepareMapClone).toHaveBeenCalledTimes(2);
  });
});
