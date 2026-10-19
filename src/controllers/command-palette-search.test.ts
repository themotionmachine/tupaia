import { describe, expect, it } from "vitest";
import {
  buildPaletteIndex,
  defaultPaletteActive,
  normalizePaletteText,
  type PaletteWorld,
  paletteCandidate,
  resolvePaletteLocation,
  searchPalette
} from "./command-palette-search";

function world(): PaletteWorld {
  return {
    burgs: [
      { i: 0 },
      { i: 1, name: "Élan’s Rest", x: 100, y: 200, state: 1 },
      { i: 9, name: "Elan", x: 240, y: 400, state: 1 },
      { i: 4, removed: true },
      { i: 5, name: "Invalid", x: NaN, y: 5 }
    ],
    states: [
      { i: 0, name: "Neutral" },
      { i: 1, name: "Ellor", fullName: "Kingdom of Ellor", pole: [120, 220], center: 0, capital: 1 },
      { i: 2, removed: true, name: "Gone" },
      { i: 3, name: "Center", center: 0 },
      { i: 4, name: "Capital", center: 99, capital: 9 }
    ],
    routes: [
      {
        i: 0,
        group: "roads",
        points: [
          [100, 200, 1],
          [300, 200, 2]
        ]
      },
      {
        i: 17,
        name: "Élan Road",
        group: "trails",
        points: [
          [100, 200, 1],
          [500, 400, 2]
        ]
      },
      { i: 19, name: "Empty", group: "roads", points: [] }
    ],
    cells: { p: [[50, 70]] }
  };
}

describe("command palette search", () => {
  it("normalizes accents, decomposed Unicode, punctuation and spacing", () => {
    expect(normalizePaletteText("  ÉLAN’S   Re\u0301st!  ")).toBe("elan s rest");
    expect(normalizePaletteText("東京の道")).toBe("東京の道");
  });

  it("omits removed, neutral, invalid and empty entities while retaining route zero", () => {
    const entries = buildPaletteIndex(world());
    expect(entries.map(entry => `${entry.key.kind}:${entry.key.id}`)).toEqual([
      "burg:1",
      "burg:9",
      "state:1",
      "state:3",
      "state:4",
      "route:0",
      "route:17"
    ]);
    expect(entries.find(entry => entry.key.kind === "route" && entry.key.id === 0)?.label).toBe("Road 0");
  });

  it("ranks exact names first and matches context plus multiple accent-normalized tokens", () => {
    const entries = buildPaletteIndex(world());
    expect(searchPalette(entries, "elan").results.map(entry => entry.label)).toEqual([
      "Elan",
      "Élan’s Rest",
      "Élan Road"
    ]);
    expect(searchPalette(entries, "rest ellor").results.map(entry => entry.label)).toEqual(["Élan’s Rest"]);
    expect(searchPalette(entries, "trail").results.map(entry => entry.label)).toEqual(["Élan Road"]);
  });

  it("is deterministic for duplicate names and bounds output without losing total", () => {
    const entries = [12, 2, 1].map(id => paletteCandidate({ kind: "burg", id }, "Same", "Settlement"));
    const found = searchPalette(entries, "same", 2);
    expect(found.results.map(entry => entry.key.id)).toEqual([1, 2]);
    expect(found.total).toBe(3);
    expect(searchPalette(entries, "   ").results).toEqual([]);
  });

  it("does not name unnamed routes or mutate world data when indexing and searching", () => {
    const data = world();
    const before = JSON.stringify(data);
    for (const route of data.routes) Object.freeze(route);
    Object.freeze(data.routes);
    Object.freeze(data);
    searchPalette(buildPaletteIndex(data), "road");
    expect(JSON.stringify(data)).toBe(before);
    expect(data.routes[0].name).toBeUndefined();
  });

  it("resolves sparse entity IDs from the current world and rejects deletion", () => {
    const data = world();
    const key = { kind: "burg" as const, id: 9 };
    expect(resolvePaletteLocation(data, key, { width: 800, height: 600 })).toEqual({ x: 240, y: 400, scale: 6 });
    data.burgs[2].x = 300;
    expect(resolvePaletteLocation(data, key, { width: 800, height: 600 })?.x).toBe(300);
    data.burgs[2].removed = true;
    expect(resolvePaletteLocation(data, key, { width: 800, height: 600 })).toBeNull();
  });

  it("uses state pole, cell center, then capital coordinates", () => {
    const data = world();
    const viewport = { width: 800, height: 600 };
    expect(resolvePaletteLocation(data, { kind: "state", id: 1 }, viewport)).toEqual({ x: 120, y: 220, scale: 2.5 });
    expect(resolvePaletteLocation(data, { kind: "state", id: 3 }, viewport)).toEqual({ x: 50, y: 70, scale: 2.5 });
    expect(resolvePaletteLocation(data, { kind: "state", id: 4 }, viewport)).toEqual({ x: 240, y: 400, scale: 2.5 });
    expect(resolvePaletteLocation(data, { kind: "state", id: 0 }, viewport)).toBeNull();
  });

  it("fits route world points including horizontal routes and honors zoom limits", () => {
    const data = world();
    const viewport = { width: 800, height: 600 };
    const route = resolvePaletteLocation(data, { kind: "route", id: 17 }, viewport);
    expect(route?.x).toBe(300);
    expect(route?.y).toBe(300);
    expect(route?.scale).toBeCloseTo(800 / 520);
    expect(resolvePaletteLocation(data, { kind: "route", id: 0 }, viewport, [1, 2])).toEqual({
      x: 200,
      y: 200,
      scale: 2
    });
    expect(resolvePaletteLocation(data, { kind: "burg", id: 1 }, viewport, [1, 3])?.scale).toBe(3);
  });

  it("rejects malformed route geometry and zero viewports instead of passing NaN to the camera", () => {
    const data = world();
    data.routes[0].points = [
      [NaN, 10],
      [50, 20]
    ];
    expect(resolvePaletteLocation(data, { kind: "route", id: 0 }, { width: 800, height: 600 })).toBeNull();
    expect(resolvePaletteLocation(data, { kind: "route", id: 17 }, { width: 0, height: 0 })).toBeNull();
  });
});

describe("defaultPaletteActive", () => {
  const route = paletteCandidate({ kind: "route", id: 3 }, "Oom withdrawal from Hysham", "Route · Route");
  const draw = paletteCandidate({ kind: "action", id: "draw-route" }, "Draw a route", "Connect places on the map");

  it("preselects the best match when it is enabled", () => {
    expect(defaultPaletteActive([draw, route], "draw a route")).toBe(0);
  });

  it("does not fall through to a weaker match when the best match is disabled", () => {
    const blocked = { ...draw, disabled: "Close the current editor first" };
    const { results } = searchPalette([route, blocked], "Draw a route");
    expect(results.map(result => result.label)).toEqual(["Draw a route", "Oom withdrawal from Hysham"]);
    expect(defaultPaletteActive(results, "Draw a route")).toBe(-1);
  });

  it("preselects nothing for an empty query or no results", () => {
    expect(defaultPaletteActive([draw], "  ")).toBe(-1);
    expect(defaultPaletteActive([], "draw")).toBe(-1);
  });
});
