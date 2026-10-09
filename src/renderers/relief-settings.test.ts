import { describe, expect, it } from "vitest";
import {
  cellRandom,
  clearReliefSettings,
  encodeRanges,
  gridKey,
  hashString,
  keepOdds,
  packCellKey,
  parseExclusion,
  parseRanges,
  RELIEF_ATTRS,
  readReliefSettings,
  setReliefOnLoad,
  syncReliefOnLoad
} from "./relief-settings";

const attrs = (values: Record<string, string>) => ({ getAttribute: (name: string) => values[name] ?? null });

describe("relief settings", () => {
  it("encodes and parses id ranges", () => {
    expect(encodeRanges([12, 3, 4, 5, 7, 6, 3])).toBe("3-7,12");
    expect(encodeRanges([])).toBe("");
    expect(parseRanges("3-7,12")).toEqual([3, 4, 5, 6, 7, 12]);
    expect(parseRanges("")).toEqual([]);
  });

  it("reads nothing from a plain #terrain (upstream behaviour)", () => {
    const s = readReliefSettings(attrs({ density: "0.4", set: "simple" }), () => "100-x");
    expect(s).toMatchObject({ seed: null, scale: 1, minHeight: 0, exclude: null, nearBurgs: 0 });
    expect(s.biomes.size).toBe(0);
    expect(readReliefSettings(null, () => "100-x").scale).toBe(1);
  });

  it("clamps stored values to the limits the MCP writes (a load draws them without a click)", () => {
    const s = readReliefSettings(
      attrs({
        "data-scale": "100",
        "data-biomes": "6:50,8:-1",
        "data-min-height": "500",
        "data-near-burgs": "1e9"
      }),
      () => "100-x"
    );
    expect(s.scale).toBe(2);
    expect([...s.biomes]).toEqual([
      [6, 2],
      [8, 0]
    ]);
    expect(s.minHeight).toBe(100);
    expect(s.nearBurgs).toBe(10000);
  });

  it("reads the stored settings", () => {
    const s = readReliefSettings(
      attrs({
        "data-seed": "abc",
        "data-scale": "0.5",
        "data-biomes": "6:0,8:1.5,bad",
        "data-min-height": "35",
        "data-exclude": "100-x:3-5,9;12.12,12.40,bad",
        "data-near-burgs": "12"
      }),
      () => "100-x"
    );
    expect(s.seed).toBe("abc");
    expect(s.scale).toBe(0.5);
    expect([...s.biomes]).toEqual([
      [6, 0],
      [8, 1.5]
    ]);
    expect(s.minHeight).toBe(35);
    expect([...(s.exclude?.cells ?? [])]).toEqual([3, 4, 5, 9]);
    expect([...(s.exclude?.parts ?? [])]).toEqual(["12.12", "12.40"]);
    expect([...(s.exclude?.partGrids ?? [])]).toEqual([12]);
    expect(s.nearBurgs).toBe(12);
  });

  it("ignores an exclusion recorded on another grid", () => {
    expect(readReliefSettings(attrs({ "data-exclude": "100-y:3-5" }), () => "100-x").exclude).toBeNull();
    const a: [number, number][] = [
      [1.5, 2.25],
      [10, 20]
    ];
    expect(gridKey(a)).toBe(gridKey(a.map(p => [p[0], p[1]] as [number, number])));
    expect(gridKey(a)).toMatch(/^2-[0-9a-z]+$/);
    expect(gridKey([a[0], [10, 20.01]])).not.toBe(gridKey(a));
  });

  it("gives each cell position its own repeatable stream", () => {
    const seed = hashString("683028576");
    const take = (rng: () => number) => Array.from({ length: 5 }, rng);
    const a = take(cellRandom(seed, 10.25, 40.5));
    expect(take(cellRandom(seed, 10.25, 40.5))).toEqual(a);
    expect(take(cellRandom(seed, 10.26, 40.5))).not.toEqual(a);
    expect(take(cellRandom(hashString("other"), 10.25, 40.5))).not.toEqual(a);
    for (const v of a) expect(v >= 0 && v < 1).toBe(true);
  });

  it("names a pack cell by its grid cell and, on the coast, the neighbour it sits towards", () => {
    const points: [number, number][] = [
      [10, 10],
      [20, 10],
      [10, 20]
    ];
    const neighbours = [[1, 2], [0], [0]];
    expect(packCellKey(0, 10, 10, points, neighbours)).toBe("0.0");
    expect(packCellKey(0, 15, 10, points, neighbours)).toBe("0.1"); // reGraph midpoint, rounded to 0.1
    expect(packCellKey(0, 10, 15.04, points, neighbours)).toBe("0.2");
    expect(packCellKey(0, 13, 13, points, neighbours)).toBe("0.?");
    expect(parseExclusion("1-2").cells.size).toBe(2);
    expect(parseExclusion("").parts.size).toBe(0);
  });

  it("thins below a multiplier of 1 with no floor of one icon per cell", () => {
    expect(keepOdds(1, 10, 5)).toBe(1);
    expect(keepOdds(1.5, 1, 50)).toBe(1);
    expect(keepOdds(0.5, 1000, 2)).toBe(1); // room for many icons: the sampler thins
    expect(keepOdds(0.5, 10, 50)).toBe(0.25); // one icon at most: keep it with odds k^2
    expect(keepOdds(0.1, 10, 50)).toBeCloseTo(0.01);
    expect(keepOdds(0.5, 2000, 50)).toBeCloseTo(0.392); // between: the expected count at this spacing
    expect(keepOdds(0.2, 10, 50)).toBeCloseTo(0.04);
  });

  it("clears every relief attribute", () => {
    const removed: string[] = [];
    clearReliefSettings({ removeAttribute: (name: string) => removed.push(name) } as unknown as Element);
    expect(removed).toEqual([...RELIEF_ATTRS]);
    expect(globalThis.ReliefSettings.attrs).toBe(RELIEF_ATTRS);
  });

  describe("relief on load (in-app switch and sync)", () => {
    /** A fake #terrain with attributes and a child count, and a page whose draw adds `perDraw` icons. */
    const page = (attrs: Record<string, string> = {}, shown = true, icons = 5, perDraw = 7) => {
      const a = new Map(Object.entries(attrs));
      let count = icons;
      let draws = 0;
      const el = {
        hasAttribute: (n: string) => a.has(n),
        getAttribute: (n: string) => a.get(n) ?? null,
        setAttribute: (n: string, v: string) => void a.set(n, v),
        removeAttribute: (n: string) => void a.delete(n),
        replaceChildren: () => {
          count = 0;
        },
        get childElementCount() {
          return count;
        }
      } as unknown as Element;
      return {
        attrs: a,
        draws: () => draws,
        p: {
          el,
          shown: () => shown,
          draw: () => {
            draws++;
            count = perDraw;
          }
        }
      };
    };

    it("sync changes nothing on a map that stores its icons (upstream behaviour)", () => {
      const t = page({ "data-seed": "1" });
      expect(syncReliefOnLoad(t.p)).toBeNull();
      expect(t.draws()).toBe(0);
      expect(t.p.el.childElementCount).toBe(5);
      expect(syncReliefOnLoad({ ...t.p, el: null })).toBeNull();
    });

    it("sync redraws a relief-on-load map, or drops its icons when the layer is off", () => {
      const on = page({ "data-regenerate": "1" });
      expect(syncReliefOnLoad(on.p)).toEqual({ action: "drawn", icons: 7 });
      expect(on.draws()).toBe(1);
      const off = page({ "data-regenerate": "1" }, false);
      expect(syncReliefOnLoad(off.p)).toEqual({ action: "cleared", icons: 0 });
      expect(off.draws()).toBe(0);
      expect(off.p.el.childElementCount).toBe(0);
    });

    it("switching on seeds the draw with the map seed (unless seeded) and redraws; off keeps the icons", () => {
      const t = page();
      expect(setReliefOnLoad(true, "4242", t.p)).toEqual({ action: "drawn", icons: 7, before: 5 });
      expect(t.attrs.get("data-regenerate")).toBe("1");
      expect(t.attrs.get("data-seed")).toBe("4242");
      expect(setReliefOnLoad(true, "999", t.p)).toBeNull(); // already on: no redraw
      expect(t.draws()).toBe(1);
      expect(setReliefOnLoad(false, "999", t.p)).toBeNull();
      expect(t.attrs.has("data-regenerate")).toBe(false);
      expect(t.attrs.get("data-seed")).toBe("4242");
      expect(t.p.el.childElementCount).toBe(7);

      const seeded = page({ "data-seed": "abc" }, false);
      expect(setReliefOnLoad(true, "4242", seeded.p)).toEqual({ action: "cleared", icons: 0, before: 5 });
      expect(seeded.attrs.get("data-seed")).toBe("abc");
      expect(typeof globalThis.ReliefSettings.setOnLoad).toBe("function");
      expect(typeof globalThis.ReliefSettings.sync).toBe("function");
    });
  });
});
