// lint: read-only automatic quality check of the map in the page. The checks live in the page
// (src/bridge-ext/lint.js); this module only validates arguments and shapes the call. No undo
// entry, no sketch ops-log entry, no checkpoint: it never changes the map.
import { z } from "zod";
import type { ToolContext } from "../context.ts";
import { META_TEXT_HEAVY } from "../result.ts";
import { EntityType, Place, ScreenPlace, TimeoutMs } from "../schemas.ts";
import { bridgePlace } from "./query.ts";
import { defineTools } from "./registry.ts";

/** Check ids, in report order (kept in step with DEFS in bridge-ext/lint.js; a test compares them). */
export const LINT_CHECKS = [
  "label-offcanvas",
  "label-overlap",
  "label-marker-overlap",
  "label-orphan",
  "marker-stacked",
  "marker-near-burg",
  "marker-cell-link",
  "marker-in-water",
  "burg-in-water",
  "burg-shared-cell",
  "burg-cell-link",
  "capital-outside",
  "province-empty",
  "state-empty",
  "unnamed",
  "name-duplicate",
  "river-uphill",
  "river-loop",
  "river-gap",
  "route-link",
  "route-point-cell",
  "route-end-burg",
  "note-orphan"
] as const;

/** Checks that run only when named in `checks` (noisy on generated maps). */
export const LINT_OPT_IN = ["label-marker-overlap", "marker-near-burg"] as const;

const NearPlace = z.union([Place, ScreenPlace], {
  error: "near is a Place: {x,y} | {lat,lon} | {cell} | {entity:{type,ref}, at?} | {screen:[px,py], shot}"
});

export function register(ctx: ToolContext): void {
  ctx.tool(
    "lint",
    {
      title: "Lint the map",
      description:
        "Read-only quality check (no undo entry, nothing logged). Checks by id: label-offcanvas, label-overlap (state, burg and custom labels measured with getBBox in map px; each label group at the lowest zoom where the hide-labels rule, with any display {labels} override, shows it, or at atScale; needs the labels drawn, else reported under skipped), label-orphan, marker-stacked, marker-cell-link, marker-in-water (land-only types), burg-in-water, burg-shared-cell, burg-cell-link, capital-outside, province-empty, state-empty, unnamed (river, lake, zone, state, province, burg, label; routes as one row), name-duplicate, river-uphill (cells rise downstream by >= riverTol), river-loop, river-gap, route-link (stale, wrong or missing pack.cells.routes links), route-point-cell, route-end-burg, note-orphan. Opt-in, only when named in checks (generated maps trip them everywhere): label-marker-overlap (a marker pin covering a label), marker-near-burg. Output: totals by severity, counts per check, then per check the top `limit` rows (an unfiltered overview lists warn and error rows and only counts info ones; name checks or pass minSeverity:'info' to list them) {sev, e:[[type,ref,name]] (ref is what edit/inspect take), at:[x,y], msg, fix:{tool,args}|hint, fixNote?}. fix is a ready tool call (edit, paint_cells or eval); fixAll holds one call for a whole check (route-link, route-point-cell, route-end-burg, marker-cell-link, note-orphan; its rows then carry no fix of their own, filter to one row to get it); clean lists checks that found nothing; unlocated counts rows an area filter could not place. Filters: checks, types (entity types of the rows), bbox [x0,y0,x1,y1] or near+radius (map px), minSeverity, ignore [{check?,type?,id?}] (known findings), limit per check (default 20, 0 = counts only), maxRows overall (default 100). Thresholds: overlapMin (0.15), markerGap (px, 20), riverTol (height units, 12), atScale (zoom). Bucket grids keep it fast on 10K+ cells.",
      inputSchema: z.object({
        checks: z
          .array(z.enum(LINT_CHECKS))
          .min(1)
          .optional()
          .describe("Check ids to run (default: all but the opt-in ones; named checks list their info rows too)"),
        types: z.array(EntityType).min(1).optional().describe("Keep only rows that involve one of these entity types"),
        bbox: z
          .tuple([z.number(), z.number(), z.number(), z.number()])
          .optional()
          .describe("Area filter [x0, y0, x1, y1] in map px"),
        near: NearPlace.optional().describe("Area filter centre (with radius)"),
        radius: z.number().positive().optional().describe("Map px, with near"),
        minSeverity: z
          .enum(["info", "warn", "error"])
          .optional()
          .describe("Drop findings below this severity; 'info' also lists info rows in an overview"),
        limit: z.number().int().min(0).max(200).optional().describe("Rows per check (default 20; 0 = counts only)"),
        maxRows: z.number().int().min(1).max(1000).optional().describe("Rows over all checks (default 100)"),
        fixes: z.boolean().optional().describe("false omits fix/hint (default true)"),
        overlapMin: z
          .number()
          .min(0.001)
          .max(1)
          .optional()
          .describe("label-overlap: fraction of the smaller box (0.15)"),
        markerGap: z.number().min(1).max(500).optional().describe("marker-stacked: px (20)"),
        riverTol: z.number().min(1).max(100).optional().describe("river-uphill: height units (12)"),
        atScale: z
          .number()
          .min(0.1)
          .max(100)
          .optional()
          .describe(
            "Label checks: measure at this zoom only (default: zoom 1 plus the zoom where each hidden group first shows)"
          ),
        ignore: z
          .array(
            z
              .object({
                check: z.enum(LINT_CHECKS).optional(),
                type: EntityType.optional(),
                id: z.union([z.string(), z.number()]).optional().describe("Entity ref as in a row's e")
              })
              .refine(g => g.check !== undefined || g.type !== undefined || g.id !== undefined, {
                error: "each ignore entry needs check, type or id"
              })
          )
          .max(500)
          .optional()
          .describe("Drop rows matching any entry (a check, an entity {type,id}, or both); counted in ignored"),
        timeoutMs: TimeoutMs
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: META_TEXT_HEAVY
    },
    async (args, scope) => {
      const { timeoutMs, near, ...rest } = args;
      const bridgeArgs: Record<string, unknown> = { ...rest };
      if (near) bridgeArgs.near = bridgePlace(ctx, near);
      // fix calls nest deeply (rows > check > row > fix > args > ops > op > set > name > generate)
      return scope.call<Record<string, unknown>>("lint", bridgeArgs, {
        json: { maxDepth: 16 },
        ...(timeoutMs ? { timeoutMs } : {})
      });
    }
  );
}

defineTools("lint", register);
