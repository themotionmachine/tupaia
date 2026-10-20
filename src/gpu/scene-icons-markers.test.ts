// @vitest-environment happy-dom
// Characterization of buildScene routing for markers and notes (matrix row 17), military regiments (18) and
// emoji / image markers (43), plus burg icons/labels that share the icon stack. Default preset applied.
// Tags: [PRIM] circle/line/rect/skipped-empty-image   [COMPAT] compat-run fragmentation   [LABELS] text handling
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStylePreset, buildStyled, createMapEnv, idsOf, layerRouting, type MapEnv } from "./test/dom-env";

let env: MapEnv;
beforeEach(() => {
  env = createMapEnv();
});
afterEach(() => env.dispose());

const marker = (i: number, inner = "") =>
  `<svg id="marker${i}" viewbox="0 0 30 30" width="30" height="30" x="${i * 10}" y="5"><g><path d="M6,19 l9,10 L24,19" fill="#ff0000" stroke="none"/><circle cx="15" cy="15" r="10" fill="#ffffff" stroke="#000000"/></g><text x="50%" y="50%" font-size="12px">${inner || "*"}</text><image x="5%" y="5%" width="12px" height="12px" href=""/></svg>`;

describe("row 17 markers and notes", () => {
  it("every marker is a nested <svg>: all adjacent markers merge into ONE compat run '<svg>'", () => {
    env.fill("markers", marker(0) + marker(1) + marker(2));
    applyStylePreset(env);
    const scene = env.build();
    expect(layerRouting(scene, "markers")).toEqual(["compat(<svg>)"]);
    const [run] = scene.draws.filter(d => d.layer === "markers");
    // Notes are keyed by element id: the run keeps each marker element (and its id) in DOM order.
    expect(idsOf(run)).toEqual(["marker0", "marker1", "marker2"]);
    expect(scene.layers.markers).toMatchObject({ native: 0, compat: 3, reasons: ["<svg>"] });
  });

  it("[PRIM] the marker's inner <image href=''> and <text> are never examined: the <svg> decides", () => {
    env.fill("markers", marker(0));
    expect(layerRouting(buildStyled(env), "markers")).toEqual(["compat(<svg>)"]);
  });

  it("markers paint after armies and before fog (layer order)", () => {
    env.fill("markers", marker(0));
    env.fill("armies", '<g id="army1"><rect x="0" y="0" width="5" height="5"/></g>');
    const layers = buildStyled(env).draws.map(d => d.layer);
    expect(layers.indexOf("armies")).toBeLessThan(layers.indexOf("markers"));
    expect(layers.indexOf("markers")).toBeLessThan(layers.indexOf("fogging-cont"));
  });

  it("a filter on #markers makes the whole layer one compat group run", () => {
    env.fill("markers", marker(0));
    applyStylePreset(env);
    env.set("markers", { filter: "url(#blur)" });
    expect(layerRouting(env.build(), "markers")).toEqual(["compat(group filter)"]);
  });
});

describe("row 43 emoji and image markers", () => {
  it("[COMPAT] emoji text markers and external-image markers are both compat inside the <svg> run", () => {
    env.fill("markers", marker(0, "\u{1F600}") + marker(1, ""));
    const scene = buildStyled(env);
    expect(layerRouting(scene, "markers")).toEqual(["compat(<svg>)"]);
    expect(scene.layers.markers.native).toBe(0);
  });

  it("[TEXT] an emoji <text> in a non-label layer stays compat (color glyphs are never native)", () => {
    env.fill("markets", '<text x="1" y="1">⚖️</text>');
    expect(layerRouting(buildStyled(env), "markets")).toEqual(["compat(text emoji)"]);
  });
});

describe("row 18 military regiments", () => {
  const regiment = (i: number) =>
    `<g id="regiment${i}"><rect x="0" y="0" width="6" height="3"/><text x="1" y="2">12</text><rect x="0" y="0" width="2" height="3"/><text x="1" y="2">⚔</text><image x="0" y="0" width="2" height="2" href="data:,"/></g>`;

  it("[TEXT] rects and the number are native; the emoji icon and image are compat: shape / label / shape / compat", () => {
    env.fill("armies", `<g id="army1" fill="#ff0000">${regiment(1)}</g>`);
    expect(layerRouting(buildStyled(env), "armies")).toEqual(["shape", "label", "shape", "compat(text emoji; image)"]);
    expect(layerRouting(env.build({ nativeText: false }), "armies")).toEqual([
      "shape",
      "compat(text)",
      "shape",
      "compat(text; image)"
    ]);
  });

  it("[COMPAT] two regiments interleave native and compat runs in DOM order (no group-level compat run)", () => {
    env.fill("armies", `<g id="army1" fill="#ff0000">${regiment(1)}${regiment(2)}</g>`);
    const scene = buildStyled(env);
    expect(layerRouting(scene, "armies")).toEqual([
      "shape",
      "label",
      "shape",
      "compat(text emoji; image)",
      "shape",
      "label",
      "shape",
      "compat(text emoji; image)"
    ]);
    expect(scene.layers.armies).toMatchObject({ native: 6, compat: 4 });
  });

  it("[PRIM] an <image href=''> inside a regiment paints nothing and is skipped", () => {
    env.fill("armies", '<g id="army1"><image x="0" y="0" width="2" height="2" href=""/></g>');
    expect(layerRouting(buildStyled(env), "armies")).toEqual([]);
  });

  it("[PRIM] a regiment drawn with rotate(0) (drawRegiment) keeps its rects native", () => {
    env.fill(
      "armies",
      '<g id="army1" fill="#ff0000"><g id="regiment1-0" transform="rotate(0)" transform-origin="3px 1px"><rect x="0" y="0" width="6" height="3"/><image x="0" y="0" width="2" height="2" href=""/></g></g>'
    );
    expect(layerRouting(buildStyled(env), "armies")).toEqual(["shape"]);
    env.layer("regiment1-0").setAttribute("transform", "rotate(30)");
    expect(layerRouting(env.build(), "armies")).toEqual(["compat(group transform)"]);
  });
});

describe("burg icons and labels (rows 15/16 neighbours)", () => {
  it("[COMPAT] <use> burg icons with x/y offsets are compat 'use'", () => {
    env.fill("burgIcons", '<g id="towns"><use id="burg1" href="#icon-town" x="3" y="4"/></g>');
    expect(layerRouting(buildStyled(env), "icons")).toEqual(["compat(use)"]);
  });

  it("[LABELS] label <text> is compat unless it is a textPath label in #labels with no text-shadow", () => {
    const curved = '<g id="stateLabel1"><text><textPath href="#textPath_stateLabel1">Name</textPath></text></g>';
    env.fill("states", curved);
    applyStylePreset(env); // default preset: text-shadow white 0 0 4px on #states
    expect(layerRouting(env.build(), "labels")).toEqual(["compat(text)"]);
    env.layer("states").setAttribute("style", "text-shadow: none");
    expect(layerRouting(env.build(), "labels")).toEqual(["label"]);
  });

  it("[LABELS] a straight (non-textPath) burg label is compat 'text' even with no shadow", () => {
    env.fill("burgLabels", '<g id="towns"><text id="burgLabel1" x="1" y="1">Town</text></g>');
    applyStylePreset(env);
    env.layer("burgLabels").setAttribute("style", "text-shadow: none");
    expect(layerRouting(env.build(), "labels")).toEqual(["compat(text)"]);
  });
});
