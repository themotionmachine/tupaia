// Shared zod schemas for tool inputs. Descriptions here surface in the tools' JSON Schema.
import { z } from "zod";

export const ENTITY_TYPES = [
  "burg",
  "state",
  "province",
  "culture",
  "religion",
  "river",
  "route",
  "routeGroup",
  "marker",
  "zone",
  "feature",
  "note",
  "label",
  "namesbase",
  "biome"
] as const;

export const EntityType = z.enum(ENTITY_TYPES).describe("Entity type");
export type EntityTypeName = z.infer<typeof EntityType>;

export const EntityRef = z
  .union([
    z.number().int().min(0),
    z.string().min(1),
    z.object({ id: z.union([z.number().int().min(0), z.string().min(1)]) }),
    z.object({ name: z.string().min(1) })
  ])
  .describe(
    "Entity id (number) or exact name (case/diacritics folded). Fuzzy matches are never applied: on NOT_FOUND/AMBIGUOUS read the candidates and retry with an id."
  );

export const EntityTarget = z.object({ type: EntityType, ref: EntityRef });

const XY = z.object({ x: z.number(), y: z.number() }).describe("Map px (graph space)");
const LatLon = z.object({ lat: z.number(), lon: z.number() });
const CellPlace = z.object({ cell: z.number().int().min(0) });
const EntityPlace = z.object({
  entity: EntityTarget,
  at: z.number().min(0).max(1).optional().describe("Fraction along a route/river (0..1)")
});

export const Place = z
  .union([XY, LatLon, CellPlace, EntityPlace])
  .describe("A place: {x,y} map px | {lat,lon} | {cell} | {entity:{type,ref}, at?}");
export type PlaceInput = z.infer<typeof Place>;

export const ScreenPlace = z.object({
  screen: z.tuple([z.number(), z.number()]).describe("Pixel [px, py] in the returned image of a screenshot"),
  shot: z.string().describe("shotId from that screenshot result")
});

export const LAYER_NAMES = [
  "texture",
  "heightmap",
  "lakes",
  "biomes",
  "cells",
  "grid",
  "coordinates",
  "compass",
  "rivers",
  "relief",
  "religions",
  "cultures",
  "states",
  "provinces",
  "zones",
  "borders",
  "routes",
  "temperature",
  "ice",
  "goods",
  "markets",
  "trade",
  "precipitation",
  "population",
  "emblems",
  "burgs",
  "labels",
  "military",
  "markers",
  "rulers",
  "scaleBar",
  "vignette",
  "height",
  "burgIcons"
] as const;
export const LayerName = z.enum(LAYER_NAMES);

export const REDRAW_LAYERS = [
  "all",
  "features",
  "heightmap",
  "biomes",
  "cultures",
  "religions",
  "states",
  "provinces",
  "borders",
  "rivers",
  "routes",
  "zones",
  "markers",
  "burgIcons",
  "labels",
  "stateLabels",
  "burgLabels",
  "emblems"
] as const;
export const RedrawLayer = z.enum(REDRAW_LAYERS);

export const TIMEOUT_CAP_MS = 300_000;
export const TimeoutMs = z
  .number()
  .int()
  .min(500)
  .max(TIMEOUT_CAP_MS)
  .optional()
  .describe("Per-call timeout in ms (capped at 300000)");

/** Default timeouts by tool class. */
export const TIMEOUTS = {
  read: 15_000,
  edit: 30_000,
  view: 30_000,
  heavy: 120_000
} as const;
