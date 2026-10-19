// Protocol v2 rules of bench/picking-parity.ts (the bench's own node:test file is not part of the unit run).
import { describe, expect, it } from "vitest";
import {
  type ChainDesc,
  classifyClick,
  domBranch,
  needsFallback,
  type SceneProbe,
  sceneChanges
} from "../../bench/picking-oracle";

const chain = (...ids: string[]): ChainDesc => ({
  chain: ids.map((id, i) => ({ tag: i ? "g" : "path", id }))
});

describe("picking oracle protocol v2", () => {
  it("queries the canvas fallbacks only when no DOM branch matched", () => {
    const regions = chain("state1", "statesBody", "regions", "viewbox", "map");
    expect(domBranch(regions)).toBeNull();
    expect(needsFallback(regions)).toBe(true);
    const river = chain("river2", "rivers", "viewbox", "map", "body");
    expect(domBranch(river)).toEqual({ kind: "river", id: "river2", branch: "rivers" });
    expect(needsFallback(river)).toBe(false);
    // no-ancestor returns before clicked() reaches the fallbacks
    expect(needsFallback({ chain: [{ tag: "svg", id: "map" }, null, null, null, null] })).toBe(false);
    expect(needsFallback(null)).toBe(false);
  });

  it("keeps the DOM branch ahead of burg, and burg ahead of relief", () => {
    const river = chain("river2", "rivers", "viewbox", "map", "body");
    expect(classifyClick(river, { available: true, burg: 4, relief: "|#a@1,2" }).branch).toBe("rivers");
    const regions = chain("state1", "statesBody", "regions", "viewbox", "map");
    expect(classifyClick(regions, { available: true, burg: 4, relief: "|#a@1,2" })).toMatchObject({ id: "4" });
    expect(classifyClick(regions, { available: true, relief: "|#a@1,2" })).toEqual({
      kind: "relief",
      id: "|#a@1,2",
      branch: "pickRelief"
    });
    expect(classifyClick(regions, { available: false, burg: 4 }).kind).toBe("none");
  });

  it("names a materialized glyph by its instance descriptor", () => {
    const glyph: ChainDesc = { ...chain("", "terrain", "viewbox", "map", "body"), instance: "|#relief-hill-1@3,4" };
    expect(domBranch(glyph)).toEqual({ kind: "relief", id: "|#relief-hill-1@3,4", branch: "terrain" });
  });

  const probe: SceneProbe = {
    regime: "compact",
    terrainHash: "a",
    terrainChildren: 1,
    revision: 3,
    prepared: 1,
    preparedRevision: 7,
    sourceRevision: 7,
    pickIndex: 1,
    camera: "translate(0,0) scale(2)|2,0,0",
    layout: "0,0,800,600|800x600@2"
  };
  const none = { childList: 0, attributes: 0, characterData: 0 };

  it("rejects a run on any structural change or committing call", () => {
    expect(sceneChanges(probe, { ...probe }, none, 0)).toEqual([]);
    expect(sceneChanges(probe, { ...probe, regime: "materialized", terrainChildren: 9, revision: 4 }, none, 0)).toEqual(
      ["regime: compact -> materialized", "terrainChildren: 1 -> 9", "revision: 3 -> 4"]
    );
    expect(sceneChanges(probe, probe, { ...none, childList: 2 }, 1)).toEqual([
      "childList mutations: 2",
      "pickRelief (committing) calls: 1"
    ]);
  });

  it("rejects attribute and text edits that move hit areas without adding a node", () => {
    expect(sceneChanges(probe, probe, { ...none, attributes: 1 }, 0)).toEqual(["attributes mutations: 1"]);
    expect(sceneChanges(probe, probe, { ...none, characterData: 1 }, 0)).toEqual(["characterData mutations: 1"]);
  });

  it("rejects prepared, index, source, camera and layout drift", () => {
    const drift: Partial<SceneProbe>[] = [
      { prepared: 2 },
      { preparedRevision: 8 },
      { sourceRevision: 8 },
      { pickIndex: 2 },
      { camera: "translate(0,0) scale(2)|2,0,0.5" },
      { layout: "0,1,800,600|800x600@2" }
    ];
    for (const change of drift) {
      const [key] = Object.keys(change);
      expect(sceneChanges(probe, { ...probe, ...change }, none, 0)).toEqual([
        `${key}: ${probe[key as keyof SceneProbe]} -> ${change[key as keyof SceneProbe]}`
      ]);
    }
  });
});
