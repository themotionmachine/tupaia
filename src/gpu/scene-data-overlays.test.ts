// @vitest-environment happy-dom
// Characterization of buildScene routing for the data overlays (matrix row 21: temperature, precipitation,
// population, goods, markets) and for style filters / masks (row 42: pencil, turbulence, paper, crumpled, splotch
// filters; fog and vignette masks). Default preset applied; goods/prec start display:none like main.js.
// Tags: [PRIM] circle/line/rect-rx/% rect become native   [COMPAT] filter and mask handling
// PRIM (W1): native basic shapes (nativeShapes / ?gpu-native-shapes=1) and viewport-% mask rects (maskRects /
// ?gpu-mask-rects=1) are both opt-in: the parity golden regressed on precipitation/population and on compass, so the
// default routing stays compat for them.
const shapes = { nativeShapes: true };
const masks = { maskRects: true };
const styled = (options = {}) => {
  applyStylePreset(env);
  return env.build(options);
};

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStylePreset, buildStyled, createMapEnv, layerOrder, layerRouting, type MapEnv } from "./test/dom-env";

let env: MapEnv;
beforeEach(() => {
  env = createMapEnv();
});
afterEach(() => env.dispose());
const show = (id: string) => env.layer(id).setAttribute("style", "display:inline");

describe("row 21 data overlays", () => {
  it("temperature: isoline paths are native; tempLabels <text> and <circle> are compat (circle native opt-in)", () => {
    env.fill(
      "temperature",
      '<path d="M0,0h10v10z" fill="#ff0000" stroke="#ff0000"/><g id="tempLabels"><text x="1" y="1">12</text><circle cx="1" cy="1" r="1"/></g>'
    );
    expect(layerRouting(styled(), "temperature")).toEqual(["shape", "compat(text; <circle>)"]);
    expect(layerRouting(styled(shapes), "temperature")).toEqual(["shape", "compat(text)", "shape"]);
  });

  it("[PRIM] population <line> strokes are compat by default; opt-in native strokes with no fill", () => {
    env.fill(
      "population",
      '<g id="rural" stroke="#444444"><line x1="0" y1="0" x2="1" y2="1"/><line x1="2" y1="2" x2="3" y2="3"/></g>'
    );
    expect(layerRouting(styled(), "population")).toEqual(["compat(<line>)"]);
    const scene = styled(shapes);
    expect(layerRouting(scene, "population")).toEqual(["shape", "shape"]);
    expect(scene.layers.population).toMatchObject({ native: 2, compat: 0 });
    const [line] = scene.draws.filter(d => d.layer === "population");
    // the inherited default fill (black) never paints a line, and never refuses it either
    expect(line.kind === "shape" && line.style.fill).toBeNull();
    expect(line.kind === "shape" && line.d).toBe("M0,0L1,1");
  });

  it("[PRIM] a <line> with no stroke paints nothing and is not drawn", () => {
    env.fill("population", '<g id="rural"><line x1="0" y1="0" x2="1" y2="1" fill="#ff0000" stroke="none"/></g>');
    expect(layerRouting(styled(shapes), "population")).toEqual([]);
  });

  it("[PRIM] markets / goods <circle> and <rect rx> are compat by default, native opt-in; plain <rect>/<path> native", () => {
    show("goods");
    env.fill("goods", '<circle cx="1" cy="1" r="2" fill="#ff0000"/>');
    env.fill("markets", '<rect x="0" y="0" width="5" height="5" rx="1" fill="#000000"/>');
    const before = styled();
    expect(layerRouting(before, "goods")).toEqual(["compat(<circle>)"]);
    expect(layerRouting(before, "markets")).toEqual(["compat(<rect>)"]);
    const scene = styled(shapes);
    expect(layerRouting(scene, "goods")).toEqual(["shape"]);
    expect(layerRouting(scene, "markets")).toEqual(["shape"]);
    env.fill("markets", '<rect x="0" y="0" width="5" height="5" fill="#000000"/><path d="M0,0h5v5z" fill="#111111"/>');
    expect(layerRouting(env.build(), "markets")).toEqual(["shape", "shape"]);
  });

  it("[PRIM] <ellipse> is native opt-in; a percentage-sized rect outside a mask stays compat (no viewport units)", () => {
    env.fill(
      "markets",
      '<ellipse cx="1" cy="1" rx="2" ry="1" fill="#000000"/><rect x="0" y="0" width="50%" height="50%" fill="#000000"/>'
    );
    expect(layerRouting(styled(), "markets")).toEqual(["compat(<ellipse>; <rect>)"]);
    expect(layerRouting(styled(shapes), "markets")).toEqual(["shape", "compat(<rect>)"]);
  });

  it("[PRIM] shapes it cannot reproduce exactly stay compat: em units, negative radius, auto ellipse radius", () => {
    env.fill(
      "markets",
      '<circle cx="1em" cy="1" r="2" fill="#000000"/><circle cx="1" cy="1" r="-2" fill="#000000"/><ellipse cx="1" cy="1" rx="2" fill="#000000"/>'
    );
    expect(layerRouting(styled(shapes), "markets")).toEqual(["compat(<circle>; <ellipse>)"]);
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
    // maskDraws rejects #fog by default: its <rect> carries x="0" (a truthy string) and percentage size.
    const scene = buildStyled(env);
    expect(layerRouting(scene, "fogging-cont")).toEqual(["compat(mask #fog)"]);
    expect(scene.layers["fogging-cont"]).toMatchObject({ native: 0, compat: 1, reasons: ["mask #fog"] });
  });

  it("[PRIM] opt-in maskRects: the fog container is a native stencil group, not a compat run", () => {
    // #fog's 100% rect resolves against the root <svg> viewport (1000x800 in the seam), in the masked user space.
    const scene = styled(masks);
    expect(layerRouting(scene, "fogging-cont")).toEqual(["group{mask:1,op:1}[]"]);
    expect(scene.layers["fogging-cont"]).toMatchObject({ compat: 0 });
    const [group] = scene.draws.filter(d => d.layer === "fogging-cont");
    const [rect] = group.kind === "group" ? (group.mask ?? []) : [];
    expect(rect.kind === "shape" && rect.d).toBe("M0,0h1000v800h-1000Z");
  });

  it("[PRIM] the #water mask (viewport-% rect plus feature <use>) is compat by default, a native stencil opt-in", () => {
    env.fill("rivers", '<path id="river1" d="M0,0L5,5Z"/>');
    applyStylePreset(env);
    env.set("rivers", { mask: "url(#water)" });
    expect(layerRouting(env.build(), "rivers")).toEqual(["compat(mask #water)"]);
    expect(layerRouting(env.build(masks), "rivers")).toEqual(["group{mask:2,op:1}[shape]"]);
  });

  it("[PRIM] a mask <use> with a non-zero x/y offset is still rejected", () => {
    env.fill("rivers", '<path id="river1" d="M0,0L5,5Z"/>');
    applyStylePreset(env);
    env.layer("land").innerHTML = '<use href="#featurePaths-f1" fill="white" x="3"/>';
    env.set("rivers", { mask: "url(#land)" });
    expect(layerRouting(env.build(masks), "rivers")).toEqual(["compat(mask #land)"]);
  });

  it("[PRIM] a fog focus path with a stroke (fog() markup) still sends the fog container to compat", () => {
    env.layer("fog").insertAdjacentHTML("beforeend", '<path d="M0,0h10v10z" fill="black"/>');
    expect(layerRouting(styled(masks), "fogging-cont")).toEqual(["compat(mask #fog)"]);
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

  it("[PRIM] opt-in maskRects: a visible #fogging (preset opacity .98) is a compat run inside the fog stencil group", () => {
    env.fill("fogging", '<path d="M0,0h10v10z" fill="#e8f0f6"/>');
    applyStylePreset(env);
    show("fogging");
    expect(layerOrder(env.build()).at(-1)).toBe("fogging-cont");
    expect(layerRouting(env.build(), "fogging-cont")).toEqual(["compat(mask #fog)"]);
    expect(layerRouting(env.build(masks), "fogging-cont")).toEqual([
      "group{mask:1,op:1}[compat(nested group opacity/mask)]"
    ]);
  });
});
