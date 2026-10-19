// @vitest-environment happy-dom
// Characterization of buildScene routing for the data overlays (matrix row 21: temperature, precipitation,
// population, goods, markets) and for style filters / masks (row 42: pencil, turbulence, paper, crumpled, splotch
// filters; fog and vignette masks). Default preset applied; goods/prec start display:none like main.js.
// Tags: [PRIM] circle/line/rect-rx/% rect become native   [COMPAT] filter and mask handling
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStylePreset, buildStyled, createMapEnv, layerOrder, layerRouting, type MapEnv } from "./test/dom-env";

let env: MapEnv;
beforeEach(() => {
  env = createMapEnv();
});
afterEach(() => env.dispose());
const show = (id: string) => env.layer(id).setAttribute("style", "display:inline");

describe("row 21 data overlays", () => {
  it("temperature: isoline paths are native; tempLabels <text> and <circle> are compat", () => {
    env.fill(
      "temperature",
      '<path d="M0,0h10v10z" fill="#ff0000" stroke="#ff0000"/><g id="tempLabels"><text x="1" y="1">12</text><circle cx="1" cy="1" r="1"/></g>'
    );
    expect(layerRouting(buildStyled(env), "temperature")).toEqual(["shape", "compat(text; <circle>)"]);
  });

  it("[PRIM] population rural/urban strokes drawn as <line> are compat '<line>'", () => {
    env.fill(
      "population",
      '<g id="rural" stroke="#444444"><line x1="0" y1="0" x2="1" y2="1"/><line x1="2" y1="2" x2="3" y2="3"/></g>'
    );
    const scene = buildStyled(env);
    expect(layerRouting(scene, "population")).toEqual(["compat(<line>)"]);
    expect(scene.layers.population).toMatchObject({ native: 0, compat: 2 });
  });

  it("[PRIM] markets / goods <circle> and <rect rx> are compat; plain <rect> and <path> are native", () => {
    show("goods");
    env.fill("goods", '<circle cx="1" cy="1" r="2" fill="#ff0000"/>');
    env.fill("markets", '<rect x="0" y="0" width="5" height="5" rx="1" fill="#000000"/>');
    const scene = buildStyled(env);
    expect(layerRouting(scene, "goods")).toEqual(["compat(<circle>)"]);
    expect(layerRouting(scene, "markets")).toEqual(["compat(<rect>)"]);
    env.fill("markets", '<rect x="0" y="0" width="5" height="5" fill="#000000"/><path d="M0,0h5v5z" fill="#111111"/>');
    expect(layerRouting(env.build(), "markets")).toEqual(["shape", "shape"]);
  });

  it("[PRIM] <ellipse> is compat; a percentage-sized rect is compat (no viewport units)", () => {
    env.fill(
      "markets",
      '<ellipse cx="1" cy="1" rx="2" ry="1" fill="#000000"/><rect x="0" y="0" width="50%" height="50%" fill="#000000"/>'
    );
    expect(layerRouting(buildStyled(env), "markets")).toEqual(["compat(<ellipse>; <rect>)"]);
  });

  it("precipitation and goods are display:none by default (main.js) and emit nothing", () => {
    env.fill("prec", '<circle cx="1" cy="1" r="2"/>');
    env.fill("goods", '<circle cx="1" cy="1" r="2"/>');
    const scene = buildStyled(env);
    expect(layerRouting(scene, "prec")).toEqual([]);
    expect(layerRouting(scene, "goods")).toEqual([]);
    expect(scene.layers.prec).toBeUndefined();
  });
});

describe("row 42 style filters and masks", () => {
  it("[COMPAT] any style filter (pencil/turbulence/paper/crumpled/splotch) on a layer makes it one compat run", () => {
    for (const filter of [
      "url(#filter-pencil)",
      "url(#filter-turbulence)",
      "url(#filter-paper)",
      "url(#filter-crumpled)",
      "url(#filter-splotch)"
    ]) {
      env.fill("landmass", '<path d="M0,0h10v10z"/>');
      applyStylePreset(env);
      env.set("landmass", { filter });
      expect(layerRouting(env.build(), "landmass")).toEqual(["compat(group filter)"]);
    }
  });

  it("[COMPAT] a filter on a single child compiles that child to compat while siblings stay native", () => {
    env.fill(
      "landmass",
      '<path d="M0,0h10v10z"/><path d="M0,0h5v5z" filter="url(#filter-paper)"/><path d="M0,0h3v3z"/>'
    );
    applyStylePreset(env);
    expect(layerRouting(env.build(), "landmass")).toEqual(["shape", "compat(filter)", "shape"]);
  });

  it("[COMPAT] the default fog container (#fogging-cont mask=url(#fog)) is ALWAYS one compat run, even with fogging hidden", () => {
    // maskDraws rejects #fog: its <rect> carries x="0" (a truthy string) and percentage size.
    const scene = buildStyled(env);
    expect(layerRouting(scene, "fogging-cont")).toEqual(["compat(mask #fog)"]);
    expect(scene.layers["fogging-cont"]).toMatchObject({ native: 0, compat: 1, reasons: ["mask #fog"] });
  });

  it("[PRIM] the #water mask (viewport-% rect plus feature <use>) is rejected, so a layer masked by it is compat", () => {
    env.fill("rivers", '<path id="river1" d="M0,0L5,5Z"/>');
    applyStylePreset(env);
    env.set("rivers", { mask: "url(#water)" });
    expect(layerRouting(env.build(), "rivers")).toEqual(["compat(mask #water)"]);
  });

  it("[PRIM] the #land mask (feature <use> fills white/black) is accepted as a stencil", () => {
    env.fill("rivers", '<path id="river1" d="M0,0L5,5Z"/>');
    applyStylePreset(env);
    env.set("rivers", { mask: "url(#land)" });
    expect(layerRouting(env.build(), "rivers")).toEqual(["group{mask:1,op:1}[shape]"]);
  });

  it("the vignette (#vignette, mask vignette-mask) lives outside #viewbox and is not part of the scene", () => {
    applyStylePreset(env);
    const scene = env.build();
    expect(scene.draws.some(d => d.layer === "vignette")).toBe(false);
    expect(Object.keys(scene.layers)).not.toContain("vignette");
  });

  it("a visible #fogging with content stays inside the compat fog container run", () => {
    show("fogging");
    env.fill("fogging", '<path d="M0,0h10v10z"/>');
    applyStylePreset(env);
    env.layer("fogging").removeAttribute("style");
    expect(layerOrder(env.build()).at(-1)).toBe("fogging-cont");
    expect(layerRouting(env.build(), "fogging-cont")).toEqual(["compat(mask #fog)"]);
  });
});
