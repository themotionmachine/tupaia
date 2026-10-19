// What the parity fixture must contain, as data: each feature, the matrix rows it covers, and the census
// expectations that prove it is really populated. The builder asserts these before it writes anything, `--verify`
// re-asserts them against the committed file, and a golden run can import the table to check its own census.
import type { Expectation, FeatureEntry } from "./index.ts";

const e = (path: string, min?: number, equals?: unknown): Expectation => (equals === undefined ? { path, min } : { path, equals });

export const FEATURES: FeatureEntry[] = [
  {
    id: "halo",
    rows: [7],
    what: "State halo: shape rendering geometricPrecision, so #statesHalo and the per-state clip paths are drawn",
    expect: [e("features.halo.viewboxShapeRendering", undefined, "geometricPrecision"), e("features.halo.borderPaths", 6), e("features.halo.clipPaths", 6), e("features.halo.display", undefined, "block")]
  },
  {
    id: "halo-setting",
    rows: [7],
    what: "Options > Rendering reads Best quality, so the zoom styling keeps scaling the halo (the preamble matches the select to the file)",
    expect: [e("features.halo.shapeRendering", undefined, "geometricPrecision")],
    preamble: true
  },
  {
    id: "coastline-filter",
    rows: [11],
    what: "Coastline with auto-filter=1 and the drop-shadow filter active at k=1 (switches at k 1.5 / 2.6)",
    expect: [e("features.coastline.autoFilter", undefined, "1"), e("features.coastline.filter", undefined, "url(#dropShadow)"), e("features.coastline.features", 3)]
  },
  {
    id: "lakes",
    rows: [11],
    what: "Lakes spread over the six stock groups (freshwater, salt, sinkhole, frozen, lava, dry)",
    expect: ["freshwater", "salt", "sinkhole", "frozen", "lava", "dry"].map(g => e(`features.lakes.${g}`, 1))
  },
  {
    id: "regiments",
    rows: [18],
    what: "Regiments: plain, rotated (4 land, 2 naval), naval, data:image PNG and SVG icons, emoji icons",
    expect: [
      e("features.regiments.domGroups", 9),
      e("features.regiments.rotated", 6),
      e("features.regiments.naval", 3),
      e("features.regiments.navalRotated", 2),
      e("features.regiments.imageIcon", 3),
      e("features.regiments.imageElements", 3),
      e("features.regiments.emojiIcon", 6)
    ]
  },
  {
    id: "markers",
    rows: [17, 43],
    what: "Markers: every pin shape with colour emoji (ZWJ, skin tone, flag), data:image PNG and SVG icons, one pinned, with notes",
    expect: [
      e("features.markers.domSvgs", 20),
      e("features.markers.emoji", 12),
      e("features.markers.dataImage", 2),
      e("features.markers.pinned", 1),
      e("features.markers.notes", 16)
    ]
  },
  {
    id: "legend",
    rows: [24],
    what: "A drawn legend (states, two columns) at a non-default data-x/data-y",
    expect: [e("features.legend.box", undefined, true), e("features.legend.rects", 9), e("features.legend.texts", 9), e("features.legend.dataX", undefined, "96"), e("features.legend.dataY", undefined, "91")]
  },
  {
    id: "measurers",
    rows: [6],
    what: "All four measurers: ruler (the default one plus a polyline), opisometer, route opisometer, planimeter",
    expect: [e("features.measurers.Ruler", 2), e("features.measurers.Opisometer", 1), e("features.measurers.RouteOpisometer", 1), e("features.measurers.Planimeter", 1), e("features.measurers.domGroups", 5), e("features.measurers.serialized", 5)]
  },
  {
    id: "compass",
    rows: [6],
    what: "Compass rose on",
    expect: [e("features.compass.use", 1)]
  },
  {
    id: "scale-bar",
    rows: [6],
    what: "Scale bar on",
    expect: [e("layers.scaleBar.elements", 3)]
  },
  {
    id: "grid-dashed",
    rows: [5],
    what: "Hex grid with a dash pattern, round caps and a pattern offset (patternTransform scale/translate)",
    expect: [e("features.grid.dasharray", undefined, "5 3"), e("features.grid.linecap", undefined, "round"), e("features.grid.fillRects", 1)]
  },
  {
    id: "coordinates",
    rows: [5],
    what: "Coordinate graticule and labels",
    expect: [e("features.coordinates.paths", 1), e("features.coordinates.texts", 4)]
  },
  {
    id: "texture",
    rows: [23],
    what: "Texture layer with a same-origin image",
    expect: [e("features.texture.images", 1)]
  },
  {
    id: "debug",
    rows: [23],
    what: "Runtime-only #debug content (route control point, highlight)",
    expect: [e("layers.debug.elements", 2)],
    preamble: true
  },
  {
    id: "ice",
    rows: [19],
    what: "Ice: glaciers and icebergs, three icebergs and one glacier dragged (offset transform)",
    expect: [e("features.ice.glaciers", 1), e("features.ice.icebergs", 3), e("features.ice.dragged", 4), e("features.ice.draggedData", 4)]
  },
  {
    id: "zones-stock-hatch",
    rows: [10],
    what: "Zones using all 42 stock hatches (hatch0..hatch41) plus four solid-colour zones",
    expect: [e("features.zones.stockHatches", 42), e("features.zones.solid", 4), e("features.zones.paths", 46)]
  },
  {
    id: "data-layers",
    rows: [21],
    what: "Temperature, precipitation, population, goods and markets layers populated and visible",
    expect: ["temperature", "prec", "population", "goods", "markets"].map(id => e(`features.dataLayers.${id}.elements`, 1))
  },
  {
    id: "cells",
    rows: [4],
    what: "Cells layer (raster of the cell mesh); drawn by the preamble, not carried in the file",
    expect: [e("features.cells.buttonOn", undefined, true), e("features.cells.elements", 1)],
    preamble: true
  },
  {
    id: "fog",
    rows: [42],
    what: "Fog focus on two states through fog() with the #fogging veil on",
    expect: [e("features.fog.paths", 2), e("features.fog.display", undefined, "block"), e("features.fog.contMask", undefined, "url(#fog)")]
  },
  {
    id: "vignette",
    rows: [42],
    what: "Vignette on",
    expect: [e("features.vignette.rect", undefined, true)]
  },
  {
    id: "labels",
    rows: [15, 16],
    what: "Curved state labels, straight burg labels, custom labels with textPaths (straight, quadratic, cubic, multi-line, letter-spaced, haloed group)",
    expect: [
      e("features.labels.stateCurvedTextPath", 6),
      e("features.labels.burgStraight", 50),
      e("features.labels.customCurved", 3),
      e("features.labels.customStraight", 3),
      e("features.labels.customWithTextPath", 6),
      e("features.labels.multiLine", 1),
      e("features.labels.haloGroups", 1)
    ]
  },
  {
    id: "emblems",
    rows: [20],
    what: "Emblems (state, province and burg coats of arms)",
    expect: [e("features.emblems.uses", 5)]
  },
  {
    id: "trade",
    rows: [22],
    what: "Trade layer on with markets and deals (the animation starts by itself on load)",
    expect: [e("features.trade.deals", 1), e("features.trade.markets", 1)]
  },
  {
    id: "trade-animation-running",
    rows: [22],
    what: "Animated trade markers present a moment after load",
    expect: [e("features.trade.animationNodes", 1)],
    preamble: true
  }
];

export function resolvePath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

export interface ExpectationFailure {
  feature: string;
  path: string;
  want: string;
  got: unknown;
}

/** Check a census against the feature table. `withPreamble` selects which side of the preamble is being checked. */
export function checkCensus(census: unknown, opts: { withPreamble: boolean }): ExpectationFailure[] {
  const failures: ExpectationFailure[] = [];
  for (const f of FEATURES) {
    if (f.preamble && !opts.withPreamble) continue;
    for (const x of f.expect) {
      const got = resolvePath(census, x.path);
      if (x.min !== undefined) {
        if (typeof got !== "number" || got < x.min) failures.push({ feature: f.id, path: x.path, want: `>= ${x.min}`, got });
      } else if (JSON.stringify(got) !== JSON.stringify(x.equals)) {
        failures.push({ feature: f.id, path: x.path, want: `== ${JSON.stringify(x.equals)}`, got });
      }
    }
  }
  return failures;
}

/** rows -> feature ids, for the manifest. */
export function rowsCovered(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of FEATURES) for (const r of f.rows) (out[String(r)] ||= []).push(f.id);
  return Object.fromEntries(Object.entries(out).sort((a, b) => Number(a[0]) - Number(b[0])));
}
