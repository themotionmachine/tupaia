// Condition predicates for select.where (track 'condpaint'): the schema side. The page side is
// src/bridge-ext/where.js, which compiles them (no string is ever evaluated) and refuses unknown
// keys and bounds with BAD_FIELD. The combinators take where objects of the same shape; they are
// typed loosely here so the tool schemas stay small (no recursive $defs in every select).
import { z } from "zod";
import { EntityRef } from "./schemas.ts";

const bound = z.number().optional();
const RangeShape = { gte: bound, lte: bound, gt: bound, lt: bound };
const range = (what: string) =>
  z.looseObject(RangeShape).optional().describe(`${what}: a range {gte?, lte?, gt?, lt?} (at least one bound)`);

const RiverOpts = {
  rivers: z
    .union([EntityRef, z.array(EntityRef)])
    .optional()
    .describe("Only these rivers' cells count as sources (default: every river cell)"),
  tributaries: z.boolean().optional().describe("With rivers: their tributaries (any depth) count too"),
  minFlux: z.number().min(0).optional().describe("Only river cells with at least this flux count")
};

/** Rain-shadow options, shared by regenerate biomes.rainShadow and the where keys. */
export const RainShadowShape = {
  strength: z
    .number()
    .min(0)
    .max(5)
    .optional()
    .describe("0..5, default 1: a lee cell loses strength * crossed / 50 of its precipitation (capped at all)"),
  maxDistance: z.number().positive().max(20000).optional().describe("How far upwind to look (default 15)"),
  unit: z.enum(["cells", "px"]).optional().describe("maxDistance unit: cells (default, grid spacing) or px"),
  ridge: z
    .number()
    .min(20)
    .max(100)
    .optional()
    .describe("Only ground at least this high blocks the wind (default 50: hills and mountains)"),
  wind: z
    .number()
    .min(0)
    .max(360)
    .optional()
    .describe(
      "Direction the wind blows towards in degrees (90 = from the west, 0 = from the south); default: the map's winds setting of each cell's latitude tier"
    ),
  spread: z
    .number()
    .min(0)
    .max(60)
    .optional()
    .describe("Look along a fan of rays within ±spread degrees of upwind (default 0: one ray), so the shadow widens")
};
export const RainShadowOption = z.union([z.boolean(), z.strictObject(RainShadowShape)]);

// a pass averages a cell with its land neighbours: n passes blur over about 6 * sqrt(n) px on a
// 10 px cell spacing (150 passes ~ 75 px)
const smoothPasses = z.number().int().min(0).max(200).optional();

const whereList = z.array(z.record(z.string(), z.unknown())).min(1);

/** Keys spread into SelectSchema's where (tools/edit.ts). */
export const WhereConditions = {
  all: whereList.optional().describe("Every where object in the list holds (same keys as where, nestable)"),
  any: whereList.optional().describe("At least one where object in the list holds"),
  not: z.record(z.string(), z.unknown()).optional().describe("The where object does not hold"),
  height: range("Cell height 0..100 (20 = sea level)"),
  flux: range("Water flux through the cell (river cells: hundreds to thousands)"),
  precipitation: z
    .looseObject({
      ...RangeShape,
      smooth: smoothPasses.describe("Passes of a land-neighbour mean first (as regenerate smoothClimate)"),
      rainShadow: RainShadowOption.optional().describe(
        "Apply the rain shadow first (same options as regenerate biomes.rainShadow): the precipitation regenerate would read"
      )
    })
    .optional()
    .describe(
      "The cell's raw grid precipitation (grid.cells.prec, as Biomes reads it; the cell info shows it x 100 as mm, so 1200 mm there is 12): range + smooth, rainShadow"
    ),
  temperature: z
    .looseObject({ ...RangeShape, smooth: smoothPasses.describe("Passes of a land-neighbour mean first") })
    .optional()
    .describe("The cell's temperature in °C: range + smooth"),
  rainShadow: z
    .looseObject({ ...RangeShape, ...RainShadowShape })
    .optional()
    .describe(
      "The rain shadow's cut 0..1 (share of precipitation a lee cell loses; 0 outside the shadow), e.g. {gte:0.5, ridge:70, maxDistance:300, unit:'px'}: range + the rainShadow options"
    ),
  x: range("The cell centre's x in map px"),
  y: range("The cell centre's y in map px (north is up: y:{lt:500} is the north)"),
  slope: z
    .looseObject({
      ...RangeShape,
      mode: z.enum(["max", "mean"]).optional().describe("max (default) or mean height difference to the neighbours")
    })
    .optional()
    .describe("Height difference to the neighbouring cells (water counts as 20): range + mode"),
  riverDist: z
    .looseObject({ ...RangeShape, ...RiverOpts })
    .optional()
    .describe(
      "Cells (graph steps over land) to the nearest river cell; river cells are 0, cells no river reaches are Infinity. range + rivers/tributaries/minFlux"
    ),
  aboveRiver: z
    .looseObject({ ...RangeShape, ...RiverOpts })
    .optional()
    .describe(
      "Height above the nearest river cell (the one riverDist measures to): a valley floor is lte ~5. range + rivers/tributaries/minFlux"
    ),
  noise: z
    .looseObject({
      ...RangeShape,
      scale: z.number().min(1).max(20000).describe("Feature size in map px"),
      seed: z
        .union([z.number().int(), z.string().min(1)])
        .optional()
        .describe("Default 'noise'"),
      octaves: z.number().int().min(1).max(6).optional().describe("Default 3")
    })
    .optional()
    .describe(
      "Seeded smooth value noise 0..1 at the cell centre (blobs of about scale px): range + scale, seed, octaves"
    )
};
