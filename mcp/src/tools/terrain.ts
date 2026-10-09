// set_heights (terrain import) and flow (read-only water-flow preview). Page side:
// src/bridge-ext/terrain.js (setHeights, flow, flowOverlay); the rebuild's carrying of routes,
// markers, feature names and river identities over a re-pack is in bridge-mutations.js
// (riskRebuild, carryRivers; paint_cells height rebuild:'risk' uses it too).
//
// set_heights is phased (runPhased: validate -> dryRun? -> one auto-undo entry -> apply) and
// replayable: its resolved form holds the grid cells it changed (final and previous heights,
// deflated), the digest of the heights it started from, the grid digest and the options. Replay
// onto a regridded map is a conflict; onto a map whose heights differ from the recorded start it
// sets only the recorded cells (keeping the target's other terrain edits) and says so; a replay
// whose rebuild yields another cell graph says so too.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolContext } from "../context.ts";
import { registerReplayable } from "../ops.ts";
import { READ_RULE, resolveReadPath } from "../paths.ts";
import { META_TEXT_HEAVY, ToolError, type WithImages } from "../result.ts";
import { Place, TIMEOUTS, TimeoutMs } from "../schemas.ts";
import { Redraw, runPhased } from "./edit.ts";
import { defineTools } from "./registry.ts";
import { takeScreenshot } from "./view.ts";

/** The logged form of set_heights (a heightmap rebuild from literal grid heights). */
export interface SetHeightsResolved {
  /**
   * Base64 of deflate-raw(A ++ B): A = one byte per grid cell (the final height of a changed
   * cell, 255 = unchanged), B = the previous height of each changed cell, in cell order.
   */
  changes: string;
  /** Number of grid cells the op changed. */
  changed: number;
  /** Grid cell count. */
  cells: number;
  /** Fingerprint of the grid (cell count, cellsX x cellsY, points); replay refuses another grid. */
  gridDigest: string;
  /** Hash of the grid heights before the op; replay compares the target's (another terrain edit since). */
  baseDigest: string;
  /** Hash of the final heights. */
  heightsDigest: string;
  options: { rebuild: "risk" | "keep"; erosion: boolean; keepHeights: boolean; biomes: "redefine" | "keep" };
  /** Pack cell graph after the rebuild (bridge cellGraph); replay compares its own. */
  graphAfter: string | null;
  /** Box of the changed grid cells [x0, y0, x1, y1] in map px (the sketch summary frames on it). */
  bbox?: [number, number, number, number] | null;
  stats?: { changed: number; toLand: number; toWater: number; lakesFormed?: number; landPct: number };
  redraw?: unknown;
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp"
};
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const ImageSource = z
  .object({
    path: z.string().min(1).optional().describe(`Image file (png/jpeg/webp/gif/bmp): ${READ_RULE}`),
    dataUrl: z.string().optional().describe("data:image/...;base64,... instead of path"),
    invert: z.boolean().optional().describe("Dark = high"),
    range: z
      .tuple([z.number().min(0).max(100), z.number().min(0).max(100)])
      .optional()
      .describe("Heights for pixel 0 and pixel 255 (default [0,100]); the map's sea level is 20"),
    channel: z.enum(["luma", "r", "g", "b", "a"]).optional().describe("Default luma")
  })
  .describe("Grayscale heightmap stretched over the whole map, sampled at every grid point (bilinear)");

const HeightSource = {
  grid: z
    .array(z.number().min(0).max(100))
    .optional()
    .describe("Dense: one 0-100 height per GRID cell in grid order (length = grid.cells.i.length)"),
  pack: z
    .record(z.string(), z.number().min(0).max(100))
    .optional()
    .describe("Sparse {<packCellId>: height}; mapped to grid cells, every other grid cell keeps its height"),
  image: ImageSource.optional()
};

const FlowPlace = z.union([
  Place,
  z.object({ gridCell: z.number().int().min(0) }).describe("A grid cell (as in set_heights grid arrays)")
]);

type HeightArgs = {
  grid?: number[];
  pack?: Record<string, number>;
  image?: z.infer<typeof ImageSource>;
};

/** Exactly one source, with an image path read into a data URL (same read policy as load_map). */
function bridgeSource(ctx: ToolContext, a: HeightArgs): Record<string, unknown> {
  const given = (["grid", "pack", "image"] as const).filter(k => a[k] !== undefined);
  if (given.length !== 1)
    throw new ToolError("BAD_ARGS", "pass exactly one height source: grid (dense array), pack ({cellId: h}) or image");
  if (a.grid) return { grid: a.grid };
  if (a.pack) return { pack: a.pack };
  const img = a.image as z.infer<typeof ImageSource>;
  if (!!img.path === !!img.dataUrl) throw new ToolError("BAD_ARGS", "image takes exactly one of path or dataUrl");
  let dataUrl = img.dataUrl;
  if (img.path) {
    const abs = resolveReadPath(ctx.config, img.path);
    const mime = IMAGE_MIME[path.extname(abs).toLowerCase()];
    if (!mime)
      throw new ToolError("BAD_ARGS", `image.path must be one of ${Object.keys(IMAGE_MIME).join(", ")} (${abs})`);
    const size = fs.statSync(abs).size;
    if (size > MAX_IMAGE_BYTES) throw new ToolError("BAD_ARGS", `image is ${size} bytes; the limit is 25 MB`);
    dataUrl = `data:${mime};base64,${fs.readFileSync(abs).toString("base64")}`;
  } else if (!/^data:image\/[\w.+-]+;base64,/.test(String(dataUrl)))
    throw new ToolError("BAD_ARGS", "image.dataUrl must be data:image/<type>;base64,...");
  const { path: _p, dataUrl: _d, ...rest } = img;
  return { image: { ...rest, dataUrl } };
}

/** The absolute file an image source reads (results name it), or undefined. */
function imagePathOf(ctx: ToolContext, a: HeightArgs | undefined): string | undefined {
  return a?.image?.path ? resolveReadPath(ctx.config, a.image.path) : undefined;
}

/** The call as logged: big inputs (a dense array, an image) are described, not copied. */
function compactArgs(a: HeightArgs & Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  if (a.grid) out.grid = `<${a.grid.length} grid heights>`;
  if (a.pack) out.pack = `<${Object.keys(a.pack).length} pack cell heights>`;
  if (a.image) {
    const { dataUrl, ...img } = a.image;
    out.image = dataUrl ? { ...img, dataUrl: `<data URL, ${dataUrl.length} chars>` } : img;
  }
  return out;
}

function describeOptions(o: SetHeightsResolved["options"]): string {
  return `rebuild ${o.rebuild}, erosion ${o.erosion ? "on" : "off"}, biomes ${o.biomes}${o.keepHeights ? "" : ", keepHeights off"}`;
}

registerReplayable("set_heights", {
  bridgeFn: "setHeights",
  bridgeArgs: r => {
    const s = r as unknown as SetHeightsResolved;
    const args: Record<string, unknown> = {
      changes: s.changes,
      baseDigest: s.baseDigest,
      gridDigest: s.gridDigest,
      ...s.options,
      fill: false,
      expectGraph: s.graphAfter ?? undefined
    };
    if (s.redraw !== undefined) args.redraw = s.redraw;
    return args;
  },
  unreplayable: r => {
    const s = r as unknown as SetHeightsResolved | null;
    if (
      !s ||
      typeof s.changes !== "string" ||
      typeof s.gridDigest !== "string" ||
      typeof s.baseDigest !== "string" ||
      !s.options
    )
      return "set_heights has no recorded height changes";
    return null;
  },
  summarize: (r, out) => {
    const s = r as unknown as SetHeightsResolved | null;
    if (!s) return "Set heights.";
    const st = (out as Record<string, unknown> | null) ?? null;
    const from = (st?.source as { from?: string } | undefined)?.from;
    const n = s.stats;
    const lakes = n?.lakesFormed ? `, ${n.lakesFormed} lake${n.lakesFormed === 1 ? "" : "s"} formed` : "";
    const counts = n
      ? `${n.changed} grid cells changed, ${n.toLand} to land, ${n.toWater} to water${lakes}; land ${n.landPct}%`
      : `heights ${s.heightsDigest}`;
    const where = s.bbox ? ` in ${s.bbox.map(v => Math.round(v)).join(",")}` : "";
    return `Set heights${from ? ` from ${from}` : ""} (${counts})${where}; ${describeOptions(s.options)}.`;
  },
  timeout: "heavy",
  renumbers: r => (r as unknown as SetHeightsResolved).options?.rebuild === "risk",
  afterReplay: (recorded, _applied, out) => {
    const s = recorded as unknown as SetHeightsResolved;
    const parts: string[] = [];
    const base = out.replayBase as { matches?: boolean; changed?: number; overlap?: number } | undefined;
    if (base && base.matches === false)
      parts.push(
        `set_heights: the target's heights differ from the ones the sketch started from (terrain edited there since), so only the op's ${base.changed} changed grid cells were set and the target's other heights kept${base.overlap ? `; ${base.overlap} of those cells had been changed on the target too and now hold the sketch's value` : ""}`
      );
    if (out.graphMatches === false)
      parts.push(
        `set_heights rebuilt another cell graph than the sketch recorded (${String(s.graphAfter)}): later literal cell lists will conflict. Likely causes: different heights (above), burgs on cells the heights make water (kept as land), or changed map settings (lake elevation limit, depression steps, precipitation, winds, temperatures)`
      );
    return parts.length ? parts.join(". ") : null;
  },
  frame: r => {
    const s = r as unknown as SetHeightsResolved;
    if (!Array.isArray(s.bbox) || s.bbox.length !== 4) return null;
    return { bbox: s.bbox, label: `set_heights, ${s.changed} grid cells changed`, layers: ["heightmap"] };
  }
});

export function register(ctx: ToolContext): void {
  ctx.tool(
    "set_heights",
    {
      title: "Import terrain (set heights)",
      description:
        "Replace the heightmap in one call, then rebuild what depends on it. Exactly one source: grid (dense, one 0-100 height per GRID cell in grid order; a length mismatch error gives the expected length and grid geometry; eval 'return grid.points' gives each cell's [x,y]), pack ({<packCellId>: h}, sparse) or image ({path | dataUrl, invert?, range?, channel?}, stretched over the map). Sea level is 20. fill:true fills land depressions first (priority flood). rebuild 'risk' (default) re-packs the map: coastline, lakes, climate, rivers and biomes are recomputed and cell ids change; burgs, states, cultures, religions, provinces, zones, routes, markers and regiments stay where land remains and move to the new cells (a burg on new water keeps its cell as land, height 20); lake and island names carry over. 'keep' refuses any change across height 20 and keeps cell ids, still recomputing climate, rivers and biomes. The rebuild always runs, even with no height changed (an identity import is not a no-op). Rivers are regenerated; a new river overlapping an old course keeps its id, name and type (notes stay on it); the result counts kept/new/gone rivers and lists notes left on gone ones. erosion (default false) lowers river beds; keepHeights (default true) sets land heights the rebuild changed back (heightsRestored). biomes 'redefine' (default) recomputes every biome; 'keep' keeps each surviving land cell's biome. dryRun:true changes nothing and returns cells changed, land/water flips, land %, lakes, pits, fill raise, grid geometry, burgs on new water, painted biomes 'redefine' would recompute; detail:true lists pit and fill-raised cells. One auto-undo entry; replayable in a sketch (only the changed cells are logged; replay onto a map whose terrain changed since keeps its other heights).",
      inputSchema: z.object({
        ...HeightSource,
        fill: z
          .boolean()
          .optional()
          .describe("Priority-flood fill of land depressions before applying (default false)"),
        rebuild: z.enum(["risk", "keep"]).optional().describe("Default 'risk'"),
        erosion: z.boolean().optional().describe("Default false"),
        keepHeights: z.boolean().optional().describe("Default true"),
        biomes: z.enum(["redefine", "keep"]).optional().describe("Default 'redefine'"),
        dryRun: z.boolean().optional().describe("Return the counts and change nothing"),
        detail: z
          .boolean()
          .optional()
          .describe("dryRun: also list pit cells and fill-raised cells (grid id, [x,y], h or raise)"),
        redraw: Redraw,
        timeoutMs: TimeoutMs
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: META_TEXT_HEAVY,
      kind: "heavy"
    },
    async (args, scope) => {
      const { dryRun, timeoutMs, grid: _g, pack: _p, image: _i, ...opts } = args;
      const bridgeArgs = { ...bridgeSource(ctx, args), ...opts };
      const out = await runPhased(ctx, scope, "set_heights", compactArgs(args), "setHeights", bridgeArgs, {
        dryRun,
        timeoutMs: timeoutMs ?? TIMEOUTS.heavy
      });
      // a rebuild touches every entity (cells renumbered): counts per type, not the entity lists
      const changes = out.changes as Record<string, { counts?: unknown }> | undefined;
      if (changes && typeof changes === "object")
        out.changes = Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v?.counts ?? v]));
      const imagePath = imagePathOf(ctx, args);
      return imagePath ? { ...out, imagePath } : out;
    }
  );

  ctx.tool(
    "flow",
    {
      title: "Preview water flow",
      description:
        "Read-only: where water runs downhill from one or more places, traced the way the river generator drains (lowest neighbour on depression-resolved heights, coastal cells pour into the nearest water, open lakes drain through their lowest shore cell). Per start: from {x, y (the start cell's centre), cell, h, asked?/snapped? (px) when the place was more than a cell away}, end {type: 'sea'|'lake'|'river' (an existing river: named, with goesTo {type, at, river, name?} = where that river's water finally goes)|'border' (off the map edge)|'pit' (an unresolved depression), x, y, cell, lake?/river?}, steps, length {px, km (km/mi/league/versta/nautical units), plus the map's own unit}, drop (or rise when the path ends above its start), throughLakes, climbs (cells the generator had to raise to drain: depressions in the real heights). Without heights it runs on the current map's cells; with heights {grid|pack|image, as in set_heights} or fill:true it runs on the proposed grid heights: cell ids are grid ids, a place resolves to the nearest GRID point (so a start where the current map is deep ocean is exact), {gridCell:N} names a grid cell directly, {cell:N} is the grid cell under current pack cell N; existing rivers are ignored there (the rebuild regenerates them) and a lake's evaporation and river flux thresholds are not modelled. detail:true adds each path's cells and points. screenshot:true draws the paths on a temporary overlay (one colour per path, numbered at its start; with proposed heights, cells that would become land are tinted green and water blue), takes a framed shot and removes the overlay. Changes nothing.",
      inputSchema: z.object({
        from: z.union([FlowPlace, z.array(FlowPlace).min(1).max(50)]).describe("Start place(s)"),
        heights: z.object(HeightSource).optional().describe("Proposed heights (same forms as set_heights)"),
        fill: z.boolean().optional().describe("Fill land depressions in the (proposed or current) heights first"),
        detail: z.boolean().optional().describe("Include each path's cells and points"),
        screenshot: z.boolean().optional().describe("Framed shot with the paths drawn (overlay removed afterwards)"),
        timeoutMs: TimeoutMs
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: META_TEXT_HEAVY,
      kind: "view"
    },
    async (args, scope) => {
      const bridge: Record<string, unknown> = { from: args.from, detail: args.detail, fill: args.fill };
      if (args.heights) bridge.heights = bridgeSource(ctx, args.heights);
      const out = await scope.call<{ paths: Array<Record<string, unknown>> } & Record<string, unknown>>(
        "flow",
        bridge,
        { timeoutMs: args.timeoutMs ?? TIMEOUTS.view }
      );
      const points = out.paths.map(p => p.points as number[][]);
      if (!args.detail) for (const p of out.paths) delete p.points;
      const imagePath = imagePathOf(ctx, args.heights);
      if (imagePath) out.imagePath = imagePath;
      if (!args.screenshot) return out;
      let shot: WithImages;
      let legend: string | undefined;
      try {
        const o = await scope.call<{ bbox: [number, number, number, number]; legend?: string }>("flowOverlay", {
          paths: points
        });
        legend = o.legend;
        shot = await takeScreenshot(ctx, scope, { target: { bbox: o.bbox } });
      } finally {
        await scope.cleanup(() => scope.call("flowOverlay", { remove: true }, { noAlerts: true }).catch(() => {}));
      }
      shot.value = { ...out, screenshot: shot.value, ...(legend ? { legend } : {}) };
      return shot;
    }
  );
}

defineTools("terrain", register);
