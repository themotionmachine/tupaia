// @vitest-environment happy-dom
// [STROKE] Stroke attributes the native stroke shader does not model route the element to compat.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { crispRendering, type Draw } from "./scene";
import { applyStylePreset, createMapEnv, flatten, layerRouting, type MapEnv } from "./test/dom-env";

let env: MapEnv;
beforeEach(() => {
  env = createMapEnv();
});
afterEach(() => env.dispose());

describe("stroke-miterlimit", () => {
  const routing = (attrs: string) => {
    env.fill("roads", `<path id="route1" d="M0,0L5,5L10,0" fill="none" ${attrs}/>`);
    applyStylePreset(env);
    return layerRouting(env.build(), "routes").join(" ");
  };

  it("keeps the default limit 4 native", () => {
    expect(routing('stroke-miterlimit="4"')).toContain("[shape]");
  });

  it("routes another limit on a miter join to compat, but not on round or bevel joins", () => {
    expect(routing('stroke-miterlimit="10"')).not.toContain("[shape]");
    env.dispose();
    env = createMapEnv();
    expect(routing('stroke-miterlimit="10" stroke-linejoin="round"')).toContain("[shape]");
  });
});

describe("shape-rendering", () => {
  const shapes = (scene: ReturnType<MapEnv["build"]>) =>
    flatten(scene.draws).filter((d): d is Extract<Draw, { kind: "shape" }> => d.kind === "shape");
  const route = () => {
    env.fill("roads", `<path id="route1" d="M0,0L5,5L10,0" fill="none" stroke="#000" stroke-width="0.4"/>`);
    applyStylePreset(env);
    return shapes(env.build()).find(d => d.element.id === "route1")!;
  };

  it("inherits optimizeSpeed or crispEdges from #viewbox as a crisp style", () => {
    env.viewbox.setAttribute("shape-rendering", "optimizeSpeed");
    expect(route().style.crisp).toBe(true);
    env.viewbox.setAttribute("shape-rendering", "crispEdges");
    expect(route().style.crisp).toBe(true);
  });

  it("keeps geometricPrecision, auto and a nearer override anti-aliased", () => {
    env.viewbox.setAttribute("shape-rendering", "geometricPrecision");
    expect(route().style.crisp).toBe(false);
    env.viewbox.removeAttribute("shape-rendering");
    expect(route().style.crisp).toBe(false);
    env.viewbox.setAttribute("shape-rendering", "optimizeSpeed");
    env.set("roads", { "shape-rendering": "geometricPrecision" });
    expect(route().style.crisp).toBe(false);
  });

  it("reads the keywords case-insensitively", () => {
    expect(crispRendering("optimizespeed")).toBe(true);
    expect(crispRendering("CrispEdges")).toBe(true);
    expect(crispRendering("geometricPrecision")).toBe(false);
    expect(crispRendering(null)).toBe(false);
  });
});

describe("<use> source tag", () => {
  it("records the referenced element's tag, which decides analytic coverage (geometry.ts analyticShape)", () => {
    env.defs.innerHTML += `<circle id="dotSymbol" cx="0" cy="0" r="2"/>`;
    env.fill("roads", `<use id="dot1" href="#dotSymbol" fill="#000"/><path id="route1" d="M0,0L5,5" stroke="#000"/>`);
    applyStylePreset(env);
    const draws = flatten(env.build({ nativeShapes: true }).draws).filter(
      (d): d is Extract<Draw, { kind: "shape" }> => d.kind === "shape" && d.layer === "routes"
    );
    expect(draws.find(d => d.element.id === "dot1")?.sourceTag?.toLowerCase()).toBe("circle");
    expect(draws.find(d => d.element.id === "route1")?.sourceTag).toBeUndefined();
  });
});
