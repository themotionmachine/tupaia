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

const whereList = z.array(z.record(z.string(), z.unknown())).min(1);

/** Keys spread into SelectSchema's where (tools/edit.ts). */
export const WhereConditions = {
  all: whereList.optional().describe("Every where object in the list holds (same keys as where, nestable)"),
  any: whereList.optional().describe("At least one where object in the list holds"),
  not: z.record(z.string(), z.unknown()).optional().describe("The where object does not hold"),
  height: range("Cell height 0..100 (20 = sea level)"),
  flux: range("Water flux through the cell (river cells: hundreds to thousands)"),
  precipitation: range("The cell's precipitation in the app's units (as Biomes reads it; the cell info shows mm)"),
  temperature: range("The cell's temperature in °C"),
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
