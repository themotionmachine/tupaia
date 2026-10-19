// @vitest-environment happy-dom
// Characterization of buildScene routing for routes (matrix row 13) and ice (row 19), plus rivers as the
// neighbouring plain-path layer. Default style preset applied. Tags: [PRIM] identity-transform normalization,
// [STROKE] dash/cap handling, [COMPAT] filter groups.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStylePreset, buildStyled, createMapEnv, flatten, idsOf, layerRouting, type MapEnv } from "./test/dom-env";

let env: MapEnv;
beforeEach(() => {
  env = createMapEnv();
});
afterEach(() => env.dispose());
const route = (id: string) => `<path id="${id}" d="M0,0L5,5" fill="none"/>`;

describe("row 13 routes", () => {
  it("each route type group (roads, trails, searoutes) is its own native opacity group, in DOM order", () => {
    env.fill("roads", route("route1"));
    env.fill("trails", route("route2"));
    env.fill("searoutes", route("route3"));
    applyStylePreset(env);
    const scene = env.build();
    expect(layerRouting(scene, "routes")).toEqual([
      "group{mask:none,op:0.9}[shape]",
      "group{mask:none,op:0.9}[shape]",
      "group{mask:none,op:0.9}[shape]"
    ]);
    const ids = flatten(scene.draws)
      .filter(d => d.kind === "shape" && d.layer === "routes")
      .map(d => d.element.id);
    expect(ids).toEqual(["route1", "route2", "route3"]);
  });

  it("[STROKE] dash patterns and caps come from each group's style", () => {
    env.fill("roads", route("route1"));
    env.fill("trails", route("route2"));
    env.fill("searoutes", route("route3"));
    applyStylePreset(env);
    const styles = flatten(env.build().draws).flatMap(d =>
      d.kind === "shape" && d.layer === "routes" ? [d.style] : []
    );
    expect(styles.map(s => s.dashes)).toEqual([[2], [0.8, 1.6], [1, 2]]);
    expect(styles.map(s => s.lineCap)).toEqual(["butt", "butt", "round"]);
    expect(styles.map(s => s.width)).toEqual([0.7, 0.25, 0.35]);
  });

  it("sibling order is draw order: moving a route group in the DOM reorders the draws (#routeTemp rename keeps place)", () => {
    env.fill("roads", route("route1"));
    env.fill("trails", route("route2"));
    applyStylePreset(env);
    const routes = env.layer("routes");
    routes.insertBefore(env.layer("trails"), env.layer("roads")); // trails first
    const ids = () =>
      flatten(env.build().draws)
        .filter(d => d.kind === "shape" && d.layer === "routes")
        .map(d => d.element.id);
    expect(ids()).toEqual(["route2", "route1"]);
    // A temporary id (route edit in progress) does not change routing, only the element id the draw carries.
    env.layer("route2").id = "routeTemp";
    expect(ids()).toEqual(["routeTemp", "route1"]);
  });

  it("a route with its own transform is compat 'transform'; a route with a percentage dash is compat", () => {
    env.fill("roads", `${route("route1")}<path id="route9" d="M0,0L5,5" fill="none" transform="translate(2,3)"/>`);
    applyStylePreset(env);
    expect(layerRouting(env.build(), "routes")[0]).toBe("group{mask:none,op:0.9}[shape,compat(transform)]");
    env.fill("roads", `<path id="route9" d="M0,0L5,5" fill="none" stroke-dasharray="10%"/>`);
    expect(layerRouting(env.build(), "routes")[0]).toBe("group{mask:none,op:0.9}[compat(stroke-dasharray)]");
  });

  it("a hidden route group (display:none) emits no draw; an EMPTY visible opacity group still emits an empty group draw", () => {
    env.fill("roads", route("route1"));
    env.fill("trails", route("route2"));
    applyStylePreset(env);
    env.layer("roads").setAttribute("style", "display:none");
    const scene = env.build();
    // trails -> one shape; #searoutes is visible but empty -> a group draw with no children (surprising but harmless).
    expect(layerRouting(scene, "routes")).toEqual(["group{mask:none,op:0.9}[shape]", "group{mask:none,op:0.9}[]"]);
    expect(scene.layers.routes).toMatchObject({ native: 1, compat: 0 });
  });
});

describe("rivers (plain native paths, no group)", () => {
  it("river paths are top-level native shapes with the layer fill", () => {
    env.fill("rivers", '<path id="river1" d="M0,0L5,5Z"/><path id="river2" d="M1,1L6,6Z"/>');
    applyStylePreset(env);
    const scene = env.build();
    expect(layerRouting(scene, "rivers")).toEqual(["shape", "shape"]);
    expect(scene.draws.filter(d => d.layer === "rivers").flatMap(idsOf)).toEqual(["river1", "river2"]);
  });
});

describe("row 19 ice", () => {
  const ice =
    '<polygon id="iceShield" points="0,0 5,0 5,5" transform="translate(1,2)"/><polygon id="iceberg1" points="0,0 5,0 5,5"/>';

  it("[COMPAT] under the default preset (drop-shadow filter) #ice is ONE compat run, bergs included", () => {
    env.fill("ice", ice);
    const scene = buildStyled(env);
    expect(layerRouting(scene, "ice")).toEqual(["compat(group filter)"]);
    expect(scene.layers.ice).toMatchObject({ native: 0, compat: 1 });
  });

  it("without the filter, glaciers/icebergs are native polygons and a translated one is compat 'transform'", () => {
    env.fill("ice", ice);
    applyStylePreset(env);
    env.layer("ice").removeAttribute("filter");
    const scene = env.build();
    // opacity .9 group; the translated polygon (offset glacier) is a compat child, in DOM order.
    expect(layerRouting(scene, "ice")).toEqual(["group{mask:none,op:0.9}[compat(transform),shape]"]);
  });

  it("[PRIM] identity translate(0,0), translate(0 0) and rotate(0) are all normalized to native", () => {
    env.fill(
      "ice",
      '<polygon id="a" points="0,0 5,0 5,5" transform="translate(0,0)"/><polygon id="b" points="0,0 5,0 5,5" transform="rotate(0)"/><polygon id="c" points="0,0 5,0 5,5" transform="translate(0 0)"/>'
    );
    applyStylePreset(env);
    env.layer("ice").removeAttribute("filter");
    expect(layerRouting(env.build(), "ice")).toEqual(["group{mask:none,op:0.9}[shape,shape,shape]"]);
  });

  it("polygon points become a closed native path", () => {
    env.fill("ice", '<polygon id="iceberg1" points="0,0 5,0 5,5"/>');
    applyStylePreset(env);
    env.layer("ice").removeAttribute("filter");
    const shape = flatten(env.build().draws).find(d => d.kind === "shape" && d.layer === "ice");
    expect(shape?.kind === "shape" && shape.d).toBe("M0,0L5,0L5,5Z");
  });
});
