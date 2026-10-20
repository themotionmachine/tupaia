// @vitest-environment happy-dom
// Routing of the non-label text (packet TEXT, W2): straight <text> outside #labels is drawn as native glyphs, text-shadow
// included, so it is as sharp as the labels instead of as sharp as the budget-fitted compat world raster. Emoji,
// transformed groups and structures the glyph path does not model stay compat with a named reason; #labels keeps its
// own routing. The stylesheet stubs mirror public/index.css (the rules a computed style sees in the app).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStylePreset, createMapEnv, layerRouting, type MapEnv, type StyleRule } from "./test/dom-env";

const appRules: StyleRule[] = [
  {
    selector: "#prec text",
    declarations: { "font-size": "32px", stroke: "none", "text-shadow": "1px 1px 1px #9daac9" }
  },
  {
    selector: "#temperature",
    declarations: {
      "font-weight": "700",
      "text-anchor": "middle",
      "dominant-baseline": "central",
      "text-shadow": "0px 0px 10px white"
    }
  },
  {
    selector: "#armies text",
    declarations: {
      stroke: "none",
      fill: "#fff",
      "text-shadow": "0 0 4px #000",
      "dominant-baseline": "central",
      "text-anchor": "middle"
    }
  },
  {
    selector: "#ruler text",
    declarations: { fill: "#3d3d3d", "text-anchor": "middle", "text-shadow": "0 0 4px white" }
  }
];

let env: MapEnv;
beforeEach(() => {
  env = createMapEnv({ rules: appRules });
});
afterEach(() => env.dispose());
const show = (id: string) => env.layer(id).setAttribute("style", "display:inline");
const styled = (options = {}) => {
  applyStylePreset(env);
  return env.build(options);
};
// the stub does not resolve color keywords inside text-shadow; real Chromium computes rgb()
const computedShadows = () => {
  env.rule("#prec text", { "text-shadow": "rgb(157, 170, 201) 1px 1px 1px" });
  env.rule("#temperature", { "text-shadow": "rgb(255, 255, 255) 0px 0px 10px" });
  env.rule("#armies text", { "text-shadow": "rgb(0, 0, 0) 0px 0px 4px" });
  env.rule("#ruler text", { "text-shadow": "rgb(255, 255, 255) 0px 0px 4px" });
};

describe("non-label text is native glyphs", () => {
  it("temperature labels (°F), with their white glow", () => {
    computedShadows();
    // the preset's #temperature fill-opacity 0.3 is for the isoline fills; drawTemperature resets it on tempLabels
    env.fill(
      "temperature",
      '<g id="tempLabels" fill-opacity="1"><text x="10" y="20">72°F</text><text x="30" y="40">64°F</text></g>'
    );
    const scene = styled();
    expect(layerRouting(scene, "temperature")).toEqual(["label", "label"]);
    expect(scene.layers.temperature).toMatchObject({ native: 2, compat: 0 });
  });

  it("wind arrows (⇉ glyphs, #prec text: 32px, offset shadow) are native; the rain circles stay compat", () => {
    computedShadows();
    show("prec");
    env.fill(
      "prec",
      '<g id="wind"><text x="20" y="600" text-rendering="optimizeSpeed">⇉</text><text x="640" y="42">⇊</text></g><circle cx="1" cy="1" r="1"/>'
    );
    expect(layerRouting(styled(), "prec")).toEqual(["label", "label", "compat(<circle>)"]);
  });

  it("regiment numbers are native, the emoji icon stays compat, an empty icon text is skipped", () => {
    computedShadows();
    env.fill(
      "armies",
      '<g id="army1" fill="#66c2a5"><g id="regiment1-0"><rect x="0" y="0" width="6" height="3"/><text x="3" y="1.5">9670</text><rect x="0" y="0" width="2" height="3"/><text class="regimentIcon" x="1" y="1.5">⚔️</text><text class="regimentIcon" x="1" y="1.5"></text></g></g>'
    );
    expect(layerRouting(styled(), "armies")).toEqual(["shape", "label", "shape", "compat(text emoji)"]);
  });

  it("a rotated regiment stays one group-transform compat run", () => {
    computedShadows();
    env.fill(
      "armies",
      '<g id="army1"><g id="regiment1-0" transform="rotate(30)"><rect x="0" y="0" width="6" height="3"/><text x="3" y="1.5">12</text></g></g>'
    );
    expect(layerRouting(styled(), "armies")).toEqual(["compat(group transform)"]);
  });

  it("coordinate labels are native; the dashed vector-effect grid path stays compat", () => {
    env.fill(
      "coordinates",
      '<path d="M0,0H100" vector-effect="non-scaling-stroke" stroke="#d4d4d4"/><g id="coordinateLabels" font-size="12px" stroke-width="0"><text x="10" y="5">75°W</text><text x="40" y="5">0</text></g>'
    );
    expect(layerRouting(styled(), "coordinates")).toEqual(["compat(vector-effect)", "label", "label"]);
  });

  it("ruler distances (dx/dy offsets) are native; the planimeter area with a superscript too", () => {
    computedShadows();
    show("ruler");
    env.fill(
      "ruler",
      '<g><path d="M0,0L10,10" stroke="#3d3d3d"/><text dx="0" dy="-1" x="5" y="5" font-size="20px">2748 mi</text><text x="5" y="5" font-size="20px">40K mi²</text></g>'
    );
    expect(layerRouting(styled(), "ruler")).toEqual(["shape", "label", "label"]);
  });

  it("province labels stay inside the #provs opacity group as glyphs", () => {
    env.fill("provs", '<g id="provinceLabels"><text x="1" y="1" font-size="10px">Wal</text></g>');
    applyStylePreset(env);
    expect(layerRouting(env.build(), "provs")).toEqual(["group{mask:none,op:0.7}[label]"]);
  });
});

describe("what stays compat, by name", () => {
  it("market scales and marker-like emoji", () => {
    env.fill("markets", '<g id="market1"><text x="1" y="1">⚖️</text></g>');
    expect(layerRouting(styled(), "markets")).toEqual(["compat(text emoji)"]);
  });

  it("tspans, percentage positions, a shadow over a stroke", () => {
    env.fill(
      "temperature",
      '<text x="1" y="1">a<tspan>b</tspan></text><text x="50%" y="1">c</text><text x="1" y="1" stroke="#ff0000" stroke-width="1" style="text-shadow: rgb(0, 0, 0) 1px 1px 1px">d</text>'
    );
    expect(layerRouting(styled(), "temperature")).toEqual([
      "compat(text tspan structure; text text positioning; text text-shadow over stroke)"
    ]);
  });

  it("#labels is untouched: a straight burg label is still compat 'text'", () => {
    env.fill("burgLabels", '<g id="towns"><text id="burgLabel1" x="1" y="1">Town</text></g>');
    env.layer("burgLabels").setAttribute("style", "text-shadow: none");
    expect(layerRouting(env.build(), "labels")).toEqual(["compat(text)"]);
  });

  it("opt out (nativeText false, ?gpu-native-text=0): every non-label text is compat 'text' as before TEXT", () => {
    computedShadows();
    env.fill("temperature", '<g id="tempLabels" fill-opacity="1"><text x="10" y="20">72°F</text></g>');
    expect(layerRouting(styled(), "temperature")).toEqual(["label"]);
    expect(layerRouting(styled({ nativeText: false }), "temperature")).toEqual(["compat(text)"]);
  });
});
