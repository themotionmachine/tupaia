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
  "label-orphan",
  "marker-stacked",
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

export function register(ctx: ToolContext): void {
  ctx.tool(
    "lint",
    {
      title: "Lint the map",
      description:
        "Read-only quality check (no undo entry, nothing logged). Runs up to 20 checks: label-offcanvas / label-overlap / label-orphan (state, burg and custom labels measured with getBBox in map coordinates; need the labels layer drawn, else reported under skipped), marker-stacked, marker-in-water (land-only types), burg-in-water, burg-shared-cell, burg-cell-link, capital-outside, province-empty, state-empty, unnamed (river, lake, zone, route, state, province, burg, label), name-duplicate, river-uphill (cells rise downstream by >= riverTol), river-loop, river-gap, route-link (stale, wrong or missing pack.cells.routes links), route-point-cell, route-end-burg (route ends where a burg was removed), note-orphan. Output: totals by severity, counts per check, then per check the top `limit` rows {sev, e:[[type,id,name]], at:[x,y], msg, fix:{tool,args}|hint}; fix is a ready tool call (edit, paint_cells or eval) where one exists; fixAll holds one call for a whole check (route-link, note-orphan); clean lists checks that found nothing. Filters: checks (ids), types (entity types of the rows), bbox [x0,y0,x1,y1] or near+radius (map px), minSeverity (info|warn|error), limit per check (default 20, 0 = counts only), maxRows overall (default 100). Thresholds: overlapMin (fraction of the smaller label covered, default 0.15), markerGap (px, default 20), riverTol (height units, default 12). Bucket grids keep it under a few hundred ms on 10K cells.",
      inputSchema: z.object({
        checks: z.array(z.enum(LINT_CHECKS)).min(1).optional().describe("Check ids to run (default all)"),
        types: z.array(EntityType).min(1).optional().describe("Keep only rows that involve one of these entity types"),
        bbox: z
          .tuple([z.number(), z.number(), z.number(), z.number()])
          .optional()
          .describe("Area filter [x0, y0, x1, y1] in map px"),
        near: z.union([Place, ScreenPlace]).optional().describe("Area filter centre (with radius)"),
        radius: z.number().positive().optional().describe("Map px, with near"),
        minSeverity: z.enum(["info", "warn", "error"]).optional().describe("Drop rows below this severity"),
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
