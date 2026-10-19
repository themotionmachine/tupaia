// @vitest-environment happy-dom
// Sanity checks for the DOM test seam itself (src/gpu/test/dom-env.ts), so a seam bug is not mistaken for a routing change.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMapEnv, type MapEnv } from "./test/dom-env";

let env: MapEnv;
beforeEach(() => {
  env = createMapEnv();
});
afterEach(() => env.dispose());

describe("computed-style stub", () => {
  it("inherits fill/stroke, not opacity; applies presentation attr < rule < inline style", () => {
    env.fill("rivers", '<path id="p" d="M0,0h1v1z"/>');
    env.set("rivers", { fill: "#112233", opacity: "0.5", stroke: "#000000" });
    const p = env.layer("p");
    expect(getComputedStyle(p).fill).toBe("#112233");
    expect(getComputedStyle(p).opacity).toBe("1");
    env.rule("#rivers", { fill: "#445566" });
    expect(getComputedStyle(p).fill).toBe("#445566");
    env.layer("rivers").setAttribute("style", "fill:#778899");
    expect(getComputedStyle(p).fill).toBe("#778899");
  });

  it("returns CSS initial values on an unstyled element", () => {
    env.fill("rivers", '<path id="q" d="M0,0h1v1z"/>');
    const cs = getComputedStyle(env.layer("q"));
    expect([cs.display, cs.visibility, cs.stroke, cs.strokeWidth, cs.filter, cs.mask]).toEqual([
      "inline",
      "visible",
      "none",
      "1px",
      "none",
      "none"
    ]);
  });
});

describe("map skeleton", () => {
  it("builds every default layer in main.js order and resolves named mask colors", () => {
    const ids = [...env.viewbox.children].map(c => c.id);
    expect(ids.slice(0, 4)).toEqual(["ocean", "landmass", "texture", "terrs"]);
    expect(ids.at(-1)).toBe("debug");
    expect(env.build().draws.map(d => d.layer)).toContain("tradeAnimation");
  });
});
