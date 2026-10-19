import { describe, expect, it } from "vitest";
import type { Draw, LayerReport, Scene } from "./scene";
import { cloneLayers, SceneCache, type SceneKey, sameSceneKey } from "./scene-cache";

const viewbox = {} as object;
const key = (over: Partial<SceneKey> = {}): SceneKey => ({
  revision: 3,
  worldEpoch: 1,
  curveTolerance: 0.2,
  viewbox,
  ...over
});

const layers = (): Record<string, LayerReport> => ({
  burgs: { native: 4, compat: 1, reasons: ["text", "<svg>"], source: "instanced-atlas" },
  rivers: { native: 2, compat: 0, reasons: [] }
});

const scene = (draws: Draw[] = [{ kind: "group" } as unknown as Draw]): Scene => ({ draws, layers: layers() });

describe("sameSceneKey", () => {
  it("matches identical keys", () => {
    expect(sameSceneKey(key(), key())).toBe(true);
  });

  it("invalidates on each field", () => {
    expect(sameSceneKey(key(), key({ revision: 4 }))).toBe(false);
    expect(sameSceneKey(key(), key({ worldEpoch: 2 }))).toBe(false);
    expect(sameSceneKey(key(), key({ curveTolerance: 0.5 }))).toBe(false);
  });

  it("compares the viewbox by identity, not shape", () => {
    expect(sameSceneKey(key(), key({ viewbox: {} }))).toBe(false);
    expect(sameSceneKey(key(), key({ viewbox }))).toBe(true);
  });
});

describe("cloneLayers", () => {
  it("copies values exactly", () => {
    expect(cloneLayers(layers())).toEqual(layers());
  });

  it("gives independent reports and reasons arrays", () => {
    const original = layers();
    const copy = cloneLayers(original);
    copy.burgs.native--;
    copy.burgs.compat++;
    copy.burgs.reasons.push("relief");
    copy.burgs.source = "canonical-raster-cache";
    copy.rivers.reasons.push("dash");
    expect(original.burgs).toEqual({ native: 4, compat: 1, reasons: ["text", "<svg>"], source: "instanced-atlas" });
    expect(original.rivers).toEqual({ native: 2, compat: 0, reasons: [] });
  });

  it("does not add a source key where none existed", () => {
    expect("source" in cloneLayers(layers()).rivers).toBe(false);
  });
});

describe("SceneCache", () => {
  it("misses while empty", () => {
    const cache = new SceneCache();
    expect(cache.get(key())).toBeNull();
    expect(cache.size).toBe(0);
  });

  it("hits with an equal key and returns the stored draws", () => {
    const cache = new SceneCache();
    const draws = [{ kind: "group" } as unknown as Draw];
    cache.store(key(), scene(draws));
    const hit = cache.get(key());
    expect(hit?.draws).toBe(draws);
    expect(hit?.layers).toEqual(layers());
    expect(cache.size).toBe(1);
  });

  it("misses on any differing key field", () => {
    const cache = new SceneCache();
    cache.store(key(), scene());
    expect(cache.get(key({ revision: 4 }))).toBeNull();
    expect(cache.get(key({ worldEpoch: 2 }))).toBeNull();
    expect(cache.get(key({ curveTolerance: 0.1 }))).toBeNull();
    expect(cache.get(key({ viewbox: {} }))).toBeNull();
  });

  it("hands out fresh layer reports on every hit", () => {
    const cache = new SceneCache();
    cache.store(key(), scene());
    const first = cache.get(key());
    first!.layers.burgs.native--;
    first!.layers.burgs.reasons.push("relief");
    const second = cache.get(key());
    expect(second!.layers).toEqual(layers());
  });

  it("snapshots layers at store time", () => {
    const cache = new SceneCache();
    const built = scene();
    cache.store(key(), built);
    built.layers.burgs.compat = 99;
    built.layers.burgs.reasons.push("mutated after store");
    expect(cache.get(key())!.layers).toEqual(layers());
  });

  it("keeps one entry: a new store evicts the previous key", () => {
    const cache = new SceneCache();
    cache.store(key(), scene());
    cache.store(key({ revision: 4 }), scene());
    expect(cache.get(key())).toBeNull();
    expect(cache.get(key({ revision: 4 }))).not.toBeNull();
    expect(cache.size).toBe(1);
  });

  it("clear drops the entry", () => {
    const cache = new SceneCache();
    cache.store(key(), scene());
    cache.clear();
    expect(cache.get(key())).toBeNull();
    expect(cache.size).toBe(0);
  });
});
