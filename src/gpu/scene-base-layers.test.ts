// @vitest-environment happy-dom
// Characterization of buildScene routing for the base layers: ocean (matrix row 1), biomes (3), cells grid (4) and
// texture/debug overlays (23). The default style preset is applied so masks/filters match a shipped map.
// These pin TODAY's routing, not the target. Test names carry a tag for the packet that flips them on purpose:
//   [PRIM] native primitives / viewport-% rects (scene.ts)   [RAS] pattern tiles   [CENSUS] report counting
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStylePreset, createMapEnv, layerRouting, type MapEnv } from "./test/dom-env";

let env: MapEnv;
beforeEach(() => {
  env = createMapEnv();
});
afterEach(() => env.dispose());
const build = () => {
  applyStylePreset(env);
  return env.build();
};

describe("row 1 ocean", () => {
  it("oceanLayers paths are native shapes", () => {
    env.fill(
      "oceanLayers",
      '<path d="M0,0h10v10z" fill="#ecf2f9" fill-opacity="0.3"/><path d="M0,0h20v20z" fill="#ecf2f9"/>'
    );
    const scene = build();
    expect(layerRouting(scene, "ocean")).toEqual(["shape", "shape"]);
    expect(scene.layers.ocean).toMatchObject({ native: 2, compat: 0 });
  });

  it("[PRIM] oceanPattern full-viewport rect (width/height 100%) is compat <rect>, whatever its fill", () => {
    env.fill("oceanPattern", '<rect x="0" y="0" width="100%" height="100%" fill="url(#oceanic)"/>');
    expect(layerRouting(build(), "ocean")).toEqual(["compat(<rect>)"]);
    env.fill("oceanPattern", '<rect x="0" y="0" width="100%" height="100%" fill="#ffffff"/>');
    expect(layerRouting(env.build(), "ocean")).toEqual(["compat(<rect>)"]);
  });

  it("[RAS] an absolute-size rect filled with url(#oceanic) is a native pattern-filled shape", () => {
    env.fill("oceanPattern", '<rect x="0" y="0" width="500" height="400" fill="url(#oceanic)"/>');
    const scene = build();
    const [draw] = scene.draws.filter(d => d.layer === "ocean");
    expect(draw.kind).toBe("shape");
    if (draw.kind === "shape") expect(draw.style.pattern).toBe("oceanic");
  });

  it("ocean paints before landmass (DOM order across layers)", () => {
    env.fill("oceanLayers", '<path d="M0,0h10v10z" fill="#ecf2f9"/>');
    env.fill("landmass", '<path d="M0,0h5v5z"/>');
    const layers = build().draws.map(d => d.layer);
    expect(layers.indexOf("ocean")).toBeLessThan(layers.indexOf("landmass"));
  });
});

describe("row 3 biomes", () => {
  it("under the default preset #biomes is a stencil group (mask #land) around native shapes", () => {
    env.fill("biomes", '<path d="M0,0h10v10z" fill="#aabbcc" stroke="#aabbcc"/>');
    expect(layerRouting(build(), "biomes")).toEqual(["group{mask:1,op:1}[shape]"]);
  });

  it("[CENSUS] mask geometry is counted as native draws of the masked layer (one per mask <use>)", () => {
    env.fill("biomes", '<path d="M0,0h10v10z" fill="#aabbcc"/>');
    const scene = build();
    // 1 biome path + 1 #land mask <use>: the census reports 2 although only 1 element is visible content.
    expect(scene.layers.biomes).toMatchObject({ native: 2, compat: 0 });
  });

  it("#temp staging group inside #biomes is walked like any group (children native, layer stays 'biomes')", () => {
    env.fill("biomes", '<g id="temp"><path d="M0,0h10v10z" fill="#aabbcc"/></g><path d="M0,0h5v5z" fill="#112233"/>');
    const [group] = build().draws.filter(d => d.layer === "biomes");
    expect(group.kind).toBe("group");
    if (group.kind === "group") expect(group.children.map(c => c.kind)).toEqual(["shape", "shape"]);
  });

  it("without the mask attribute biomes shapes are plain top-level native draws", () => {
    env.fill("biomes", '<path d="M0,0h10v10z" fill="#aabbcc"/>');
    applyStylePreset(env);
    env.layer("biomes").removeAttribute("mask");
    expect(layerRouting(env.build(), "biomes")).toEqual(["shape"]);
  });

  it("an unresolvable mask makes the whole layer one compat run", () => {
    env.fill("biomes", '<path d="M0,0h10v10z" fill="#aabbcc"/>');
    applyStylePreset(env);
    env.set("biomes", { mask: "url(#nope)" });
    expect(layerRouting(env.build(), "biomes")).toEqual(["compat(mask #nope)"]);
  });

  it("<image data-path-vectors> becomes cachedPaths (canonical raster cache), native, with parsed vector paths", () => {
    const vectors = '<path d="M0,0h10v10z" fill="#aabbcc"/><path d="M0,0h5v5z" fill="#112233"/>';
    env.fill("biomes", `<image data-path-vectors='${vectors}' href="data:," width="10" height="10"/>`);
    const scene = build();
    const [group] = scene.draws.filter(d => d.layer === "biomes");
    expect(group.kind).toBe("group");
    if (group.kind === "group") {
      expect(group.children.map(c => c.kind)).toEqual(["cachedPaths"]);
      const cached = group.children[0];
      if (cached.kind === "cachedPaths") expect(cached.paths).toHaveLength(2);
    }
    expect(scene.layers.biomes.source).toBe("canonical-raster-cache");
  });
});

describe("row 4 cells grid", () => {
  const cells = '<image data-cell-mesh="1" href="data:," width="100" height="100"/>';

  it("the baked mesh image is one native `cells` draw with the group's stroke", () => {
    env.fill("cells", cells);
    const scene = build();
    expect(layerRouting(scene, "cells")).toEqual(["cells"]);
    const [draw] = scene.draws.filter(d => d.layer === "cells");
    if (draw.kind === "cells") {
      expect(draw.width).toBeCloseTo(0.1);
      expect(draw.stroke[3]).toBeCloseTo(1);
    }
    expect(scene.layers.cells).toMatchObject({ native: 1, compat: 0 });
  });

  it("stroke none: no draw is emitted but the layer is still reported native 1", () => {
    env.fill("cells", cells);
    applyStylePreset(env);
    env.set("cells", { stroke: "none" });
    const scene = env.build();
    expect(layerRouting(scene, "cells")).toEqual([]);
    expect(scene.layers.cells).toMatchObject({ native: 1, compat: 0 });
  });

  it("a filter on #cells turns it into one compat run (group filter)", () => {
    env.fill("cells", cells);
    applyStylePreset(env);
    env.set("cells", { filter: "url(#dropShadow)" });
    expect(layerRouting(env.build(), "cells")).toEqual(["compat(group filter)"]);
  });

  it("a resolvable mask makes #cells a stencil group; an unresolvable mask makes it compat", () => {
    env.fill("cells", cells);
    applyStylePreset(env);
    env.set("cells", { mask: "url(#land)" });
    expect(layerRouting(env.build(), "cells")).toEqual(["group{mask:1,op:1}[cells]"]);
    env.set("cells", { mask: "url(#missing)" });
    expect(layerRouting(env.build(), "cells")).toEqual(["compat(mask #missing)"]);
  });

  it("opacity < 1 on #cells wraps the mesh in a group", () => {
    env.fill("cells", cells);
    applyStylePreset(env);
    env.set("cells", { opacity: "0.5" });
    expect(layerRouting(env.build(), "cells")).toEqual(["group{mask:none,op:0.5}[cells]"]);
  });
});

describe("row 23 texture and debug overlays", () => {
  it("#texture <image> is a compat run, inside a stencil group because the preset masks it with #land", () => {
    env.fill("texture", '<image href="data:image/png;base64,AA" x="0" y="0" width="10" height="10"/>');
    expect(layerRouting(build(), "texture")).toEqual(["group{mask:1,op:1}[compat(image)]"]);
  });

  it("[CENSUS] layer 'texture' reports native >= 1 although #texture is a single compat <image>", () => {
    env.fill("texture", '<image href="data:image/png;base64,AA" x="0" y="0" width="10" height="10"/>');
    // The native count is the #land mask <use> shapes (one per land feature: 4-179 on real maps).
    expect(build().layers.texture).toMatchObject({ native: 1, compat: 1, reasons: ["image"] });
  });

  it("without the mask the texture image is a bare compat run", () => {
    env.fill("texture", '<image href="data:image/png;base64,AA" x="0" y="0" width="10" height="10"/>');
    applyStylePreset(env);
    env.layer("texture").removeAttribute("mask");
    expect(layerRouting(env.build(), "texture")).toEqual(["compat(image)"]);
  });

  it("[PRIM] an <image href=''> (cleared texture) is still compat 'image', not skipped", () => {
    env.fill("texture", '<image href="" x="0" y="0" width="10" height="10"/>');
    applyStylePreset(env);
    env.layer("texture").removeAttribute("mask");
    expect(layerRouting(env.build(), "texture")).toEqual(["compat(image)"]);
  });

  it("[PRIM] #debug circles and lines are compat; debug paths are native", () => {
    env.fill(
      "debug",
      '<circle cx="1" cy="1" r="2" fill="#ff0000"/><line x1="0" y1="0" x2="5" y2="5" stroke="#000000"/>'
    );
    expect(layerRouting(build(), "debug")).toEqual(["compat(<circle>; <line>)"]);
    env.fill("debug", '<path d="M0,0L5,5" fill="none" stroke="#000000"/>');
    expect(layerRouting(env.build(), "debug")).toEqual(["shape"]);
  });
});
