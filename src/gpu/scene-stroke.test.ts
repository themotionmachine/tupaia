// @vitest-environment happy-dom
// [STROKE] Stroke attributes the native stroke shader does not model route the element to compat.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStylePreset, createMapEnv, layerRouting, type MapEnv } from "./test/dom-env";

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
