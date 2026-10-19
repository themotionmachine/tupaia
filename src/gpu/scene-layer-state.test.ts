// @vitest-environment happy-dom
// Characterization of how layer toggles (matrix row 26) and layer reordering (row 27) reach buildScene.
// The scene reads only computed display/visibility plus a few marker attributes; it never reads the
// `buttonoff` class, `data-layer-off` or the layer registry. Tags: [CENSUS] toggle census, [LIFE] classify churn.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStylePreset, createMapEnv, layerOrder, layerRouting, type MapEnv } from "./test/dom-env";

let env: MapEnv;
beforeEach(() => {
  env = createMapEnv();
});
afterEach(() => env.dispose());
const path = '<path d="M0,0h10v10z" fill="#aabbcc"/>';
const order = (ids: string[]) => layerOrder(env.build()).filter(l => ids.includes(l));

describe("row 26 layer toggles", () => {
  it("display:none layers (how layers.js hides them) emit no draws and no report entry", () => {
    env.fill("rivers", path);
    env.fill("landmass", path);
    env.layer("rivers").setAttribute("style", "display:none");
    const scene = env.build();
    expect(layerRouting(scene, "rivers")).toEqual([]);
    expect(scene.layers.rivers).toBeUndefined();
    expect(layerRouting(scene, "landmass")).toEqual(["shape"]);
  });

  it("showing the layer again restores the draws (toggle round trip changes only the style)", () => {
    env.fill("rivers", path);
    env.layer("rivers").setAttribute("style", "display:none");
    expect(env.build().draws.some(d => d.layer === "rivers")).toBe(false);
    env.layer("rivers").removeAttribute("style");
    expect(layerRouting(env.build(), "rivers")).toEqual(["shape"]);
  });

  it("[CENSUS] the `buttonoff` class and `data-layer-off` are NOT read: only computed display/visibility counts", () => {
    env.fill("rivers", path);
    env.layer("rivers").setAttribute("data-layer-off", "1");
    env.layer("rivers").classList.add("buttonoff");
    expect(layerRouting(env.build(), "rivers")).toEqual(["shape"]);
  });

  it("[CENSUS] a hidden #tradeAnimation emits no trade draw; a visible one always emits one (even when empty)", () => {
    expect(env.build().draws.some(d => d.kind === "trade")).toBe(true);
    env.layer("tradeAnimation").setAttribute("style", "display:none");
    expect(env.build().draws.some(d => d.kind === "trade")).toBe(false);
  });

  it("visibility:hidden skips an element unless that element carries data-zoom-hidden", () => {
    env.fill("rivers", path);
    env.layer("rivers").setAttribute("style", "visibility:hidden");
    expect(layerRouting(env.build(), "rivers")).toEqual([]);
    // data-zoom-hidden exempts only the element that carries it; hidden descendants (inherited visibility) still skip.
    env.layer("rivers").setAttribute("data-zoom-hidden", "");
    expect(layerRouting(env.build(), "rivers")).toEqual([]);
    env.fill("rivers", '<path data-zoom-hidden="" d="M0,0h10v10z" fill="#aabbcc"/>');
    expect(layerRouting(env.build(), "rivers")).toEqual(["shape"]);
  });

  it("[LIFE] viewport-culled elements are still classified even though CSS hides them (label culling)", () => {
    env.rule(".viewport-culled", { display: "none" });
    env.fill(
      "rivers",
      `<path class="viewport-culled" d="M0,0L5,5Z"/><path class="other" d="M0,0L5,5Z" style="display:none"/>`
    );
    expect(layerRouting(env.build(), "rivers")).toEqual(["shape"]);
  });

  it("data-dense-zoom subtrees and non-rendered tags (defs, mask, symbol, ...) are skipped", () => {
    env.fill(
      "rivers",
      `<g data-dense-zoom="1">${path}</g><defs>${path}</defs><mask id="m">${path}</mask><symbol id="s">${path}</symbol>${path}`
    );
    expect(layerRouting(env.build(), "rivers")).toEqual(["shape"]);
  });

  it("the texture toggle removes the <image>: empty #texture emits nothing, but the preset's land mask still emits an empty stencil group", () => {
    env.fill("texture", "");
    expect(layerRouting(env.build(), "texture")).toEqual([]);
    applyStylePreset(env);
    expect(layerRouting(env.build(), "texture")).toEqual(["group{mask:1,op:1}[]"]);
  });

  it("[CENSUS] compass (display:none at start) is skipped; turning it on classifies its children normally", () => {
    env.fill("compass", path);
    expect(layerRouting(env.build(), "compass")).toEqual([]);
    env.layer("compass").setAttribute("style", "display:inline");
    expect(layerRouting(env.build(), "compass")).toEqual(["shape"]);
  });
});

describe("row 27 layer reorder", () => {
  it("the default stack paints in main.js order", () => {
    const ids = ["landmass", "biomes", "rivers", "ice", "armies"];
    for (const id of ids) env.fill(id, path);
    expect(order(ids)).toEqual(ids);
  });

  it("moveLayer (insertBefore/After in the DOM) is the whole reorder mechanism: draw order follows DOM order", () => {
    const ids = ["landmass", "biomes", "rivers"];
    for (const id of ids) env.fill(id, path);
    env.viewbox.insertBefore(env.layer("rivers"), env.layer("landmass"));
    expect(order(ids)).toEqual(["rivers", "landmass", "biomes"]);
  });

  it("nested layers reorder inside their parent (province borders above state borders)", () => {
    env.fill("stateBorders", '<path id="s" d="M0,0h10" fill="none" stroke="#000000"/>');
    env.fill("provinceBorders", '<path id="p" d="M0,0h10" fill="none" stroke="#000000"/>');
    env.layer("borders").insertBefore(env.layer("provinceBorders"), env.layer("stateBorders"));
    const ids = env
      .build()
      .draws.filter(d => d.layer === "borders")
      .map(d => d.element.id);
    expect(ids).toEqual(["p", "s"]);
  });

  it("moving a layer to the end of #viewbox puts it after the always-present trade layer", () => {
    env.fill("rivers", path);
    env.viewbox.append(env.layer("rivers"));
    const layers = layerOrder(env.build());
    expect(layers.indexOf("tradeAnimation")).toBeLessThan(layers.indexOf("rivers"));
  });
});
