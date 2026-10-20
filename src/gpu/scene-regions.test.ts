// @vitest-environment happy-dom
// Characterization of buildScene routing for political layers: states body + halo (matrix row 7), provinces and
// borders (8), cultures and religions (9). Default style preset applied. Tags name the packet that flips a test:
//   [COMPAT] halo / group-opacity handling   [STROKE] hairline/dash handling   [LABELS] province labels
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStylePreset, createMapEnv, flatten, layerRouting, type MapEnv } from "./test/dom-env";

let env: MapEnv;
beforeEach(() => {
  env = createMapEnv();
});
afterEach(() => env.dispose());
const path = '<path d="M0,0h10v10z" fill="#ff0000" stroke="#ff0000"/>';

describe("row 7 states fill and halo", () => {
  it("#statesBody (opacity .4) is a group of native shapes", () => {
    env.fill("statesBody", path + path);
    applyStylePreset(env);
    expect(layerRouting(env.build(), "regions")).toEqual([
      "group{mask:none,op:0.4}[shape,shape]",
      "compat(group filter)"
    ]);
  });

  it("[COMPAT] the shipped #statesHalo has filter blur(3.5px): the halo is a compat run after the body", () => {
    env.fill("statesBody", path);
    env.fill("statesHalo", '<path d="M0,0h10v10z" fill="none" stroke="#ff0000"/>');
    applyStylePreset(env);
    const scene = env.build();
    expect(layerRouting(scene, "regions")).toEqual(["group{mask:none,op:0.4}[shape]", "compat(group filter)"]);
    expect(scene.layers.regions).toMatchObject({ native: 1, compat: 1, reasons: ["group filter"] });
  });

  it("with the halo filter removed the halo is a second opacity group, painted after the body (DOM order)", () => {
    env.fill("statesBody", path);
    env.fill("statesHalo", '<path d="M0,0h10v10z" fill="none" stroke="#ff0000"/>');
    applyStylePreset(env);
    env.layer("statesHalo").removeAttribute("filter");
    expect(layerRouting(env.build(), "regions")).toEqual([
      "group{mask:none,op:0.4}[shape]",
      "group{mask:none,op:0.4}[shape]"
    ]);
  });

  it("an opacity group inside an opacity group is compat 'nested group opacity/mask' (no layer-wide RT)", () => {
    env.fill("statesBody", path);
    applyStylePreset(env);
    env.set("regions", { opacity: "0.5" });
    // The nested body and the filtered halo are adjacent compat runs of one layer, so they merge into one run.
    expect(layerRouting(env.build(), "regions")).toEqual([
      "group{mask:none,op:0.5}[compat(nested group opacity/mask; group filter)]"
    ]);
  });

  it("a single path with opacity < 1 over both fill and stroke is compat; fill-only is native", () => {
    env.fill("statesBody", '<path d="M0,0h10v10z" fill="#ff0000" stroke="#00ff00" opacity="0.5"/>');
    expect(layerRouting(applyThen(), "regions")[0]).toContain("compat(opacity over fill and stroke)");
    env.fill("statesBody", '<path d="M0,0h10v10z" fill="#ff0000" stroke="none" opacity="0.5"/>');
    expect(layerRouting(env.build(), "regions")[0]).toBe("group{mask:none,op:0.4}[shape]");
  });

  function applyThen() {
    applyStylePreset(env);
    return env.build();
  }

  it("state fills keep DOM order and per-path fill colors", () => {
    env.fill(
      "statesBody",
      '<path id="state1" d="M0,0h10v10z" fill="#ff0000"/><path id="state2" d="M0,0h10v10z" fill="#00ff00"/>'
    );
    applyStylePreset(env);
    const ids = flatten(env.build().draws)
      .filter(d => d.kind === "shape" && d.layer === "regions")
      .map(d => d.element.id);
    expect(ids).toEqual(["state1", "state2"]);
  });
});

describe("row 8 provinces and borders", () => {
  it("#provs holds province labels: <text> children are native glyphs inside the opacity group (TEXT)", () => {
    env.fill("provs", '<path d="M0,0h10v10z" fill="#ff0000"/><text x="1" y="1">Province</text>');
    applyStylePreset(env);
    expect(layerRouting(env.build(), "provs")).toEqual(["group{mask:none,op:0.7}[shape,label]"]);
  });

  it("[STROKE] state borders carry dash [2], province borders dash [0,2] with round caps; both native, state first", () => {
    env.fill("stateBorders", '<path d="M0,0h10" fill="none"/>');
    env.fill("provinceBorders", '<path d="M0,0h10" fill="none"/>');
    applyStylePreset(env);
    const scene = env.build();
    expect(layerRouting(scene, "borders")).toEqual([
      "group{mask:none,op:0.8}[shape]",
      "group{mask:none,op:0.8}[shape]"
    ]);
    const shapes = flatten(scene.draws).filter(d => d.kind === "shape" && d.layer === "borders");
    expect(shapes.map(s => (s.kind === "shape" ? s.style.dashes : null))).toEqual([[2], [0, 2]]);
    expect(shapes.map(s => (s.kind === "shape" ? s.style.lineCap : null))).toEqual(["butt", "round"]);
    expect(shapes.map(s => (s.kind === "shape" ? s.style.width : null))).toEqual([1, 0.5]);
  });

  it("a percentage dasharray (user style) keeps the border compat", () => {
    env.fill("stateBorders", '<path d="M0,0h10" fill="none"/>');
    applyStylePreset(env);
    env.set("stateBorders", { "stroke-dasharray": "10%" });
    expect(layerRouting(env.build(), "borders")[0]).toBe("group{mask:none,op:0.8}[compat(stroke-dasharray)]");
  });

  it("a filter on #stateBorders makes only that child compat; the sibling stays a native group", () => {
    env.fill("stateBorders", '<path d="M0,0h10" fill="none"/>');
    env.fill("provinceBorders", '<path d="M0,0h10" fill="none"/>');
    applyStylePreset(env);
    env.set("stateBorders", { filter: "url(#blur)" });
    expect(layerRouting(env.build(), "borders")).toEqual(["compat(group filter)", "group{mask:none,op:0.8}[shape]"]);
  });
});

describe("row 9 cultures and religions", () => {
  it("#cults and #relig are opacity groups of native shapes; stroke-width 0 drops the religion stroke", () => {
    env.fill("cults", path);
    env.fill("relig", path);
    applyStylePreset(env);
    const scene = env.build();
    expect(layerRouting(scene, "cults")).toEqual(["group{mask:none,op:0.6}[shape]"]);
    expect(layerRouting(scene, "relig")).toEqual(["group{mask:none,op:0.7}[shape]"]);
    const relig = flatten(scene.draws).find(d => d.layer === "relig" && d.kind === "shape");
    expect(relig?.kind === "shape" && relig.style.stroke).toBeNull();
    const cults = flatten(scene.draws).find(d => d.layer === "cults" && d.kind === "shape");
    expect(cults?.kind === "shape" && cults.style.stroke).not.toBeNull();
  });

  it("g#relig restored by auto-update (no preset attributes) is plain native top-level shapes", () => {
    env.fill("relig", path);
    expect(layerRouting(env.build(), "relig")).toEqual(["shape"]);
  });

  it("cultures keep DOM order relative to religions (relig paints before cults)", () => {
    env.fill("cults", path);
    env.fill("relig", path);
    const layers = env.build().draws.map(d => d.layer);
    expect(layers.indexOf("relig")).toBeLessThan(layers.indexOf("cults"));
  });
});
