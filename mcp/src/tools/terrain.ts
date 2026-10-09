// set_heights (terrain import) and flow (read-only water-flow preview). Page side:
// src/bridge-ext/terrain.js (setHeights, flow, flowOverlay).
//
// set_heights is phased (runPhased: validate -> dryRun? -> one auto-undo entry -> apply) and
// replayable: its resolved form holds the final grid heights (base64 bytes), the grid digest and
// the options, so a sketch that terraforms stays replayable; replay onto a regridded map is a
// conflict, and a replay whose rebuild yields another cell graph says so in the replay notes.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolContext } from "../context.ts";
import { registerReplayable } from "../ops.ts";
import { resolveReadPath } from "../paths.ts";
import { META_TEXT_HEAVY, ToolError, type WithImages } from "../result.ts";
import { Place, TIMEOUTS, TimeoutMs } from "../schemas.ts";
import { Redraw, runPhased } from "./edit.ts";
import { defineTools } from "./registry.ts";
import { takeScreenshot } from "./view.ts";

/** The logged form of set_heights (a heightmap rebuild from literal grid heights). */
export interface SetHeightsResolved {
  /** Base64 of the final grid heights (one byte per grid cell, grid cell order). */
  heights: string;
  /** Grid cell count. */
  cells: number;
  /** Fingerprint of the grid (cell count, cellsX x cellsY, points); replay refuses another grid. */
  gridDigest: string;
  /** Hash of the final heights. */
  heightsDigest: string;
  options: { rebuild: "risk" | "keep"; erosion: boolean; keepHeights: boolean; biomes: "redefine" | "keep" };
  /** Pack cell graph after the rebuild (bridge cellGraph); replay compares its own. */
  graphAfter: string | null;
  stats?: { changed: number; toLand: number; toWater: number; landPct: number };
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
    path: z
      .string()
      .min(1)
      .optional()
      .describe("Image file (png/jpeg/webp/gif/bmp); relative paths from the repo root"),
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
      heights: s.heights,
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
    if (!s || typeof s.heights !== "string" || typeof s.gridDigest !== "string" || !s.options)
      return "set_heights has no recorded heights array";
    return null;
  },
  summarize: (r, out) => {
    const s = r as unknown as SetHeightsResolved | null;
    if (!s) return "Set heights.";
    const st = (out as Record<string, unknown> | null) ?? null;
    const from = (st?.source as { from?: string } | undefined)?.from;
    const n = s.stats;
    const counts = n
      ? `${n.changed} grid cells changed, ${n.toLand} to land, ${n.toWater} to water; land ${n.landPct}%`
      : `heights ${s.heightsDigest}`;
    return `Set heights${from ? ` from ${from}` : ""} (${counts}); ${describeOptions(s.options)}.`;
  },
  timeout: "heavy",
  renumbers: r => (r as unknown as SetHeightsResolved).options?.rebuild === "risk",
  afterReplay: (recorded, _applied, out) => {
    if (out.graphMatches !== false) return null;
    const s = recorded as unknown as SetHeightsResolved;
    return `set_heights rebuilt another cell graph than the sketch recorded (${String(s.graphAfter)}): later literal cell lists will conflict. Likely causes: burgs on cells the heights make water (kept as land), or changed map settings (lake elevation limit, depression steps, precipitation, winds, temperatures)`;
  }
});

export function register(ctx: ToolContext): void {
  ctx.tool(
    "set_heights",
    {
      title: "Import terrain (set heights)",
      description:
        "Replace the heightmap in one call, then rebuild everything that depends on it. Exactly one source: grid (dense array, one 0-100 height per GRID cell; on a length mismatch the error gives the expected length), pack ({<packCellId>: h}, sparse; other grid cells keep their height) or image ({path | dataUrl, invert?, range?:[min,max] for pixel 0..255, channel?:'luma'|'r'|'g'|'b'|'a'}; stretched over the map). Sea level is 20. fill:true fills land depressions first (priority flood) so no unintended interior pits or lakes form. rebuild 'risk' (default) re-packs the map: coastline, lakes, climate, rivers and biomes are recomputed, cell ids change, burgs/states/cultures/religions/provinces/zones are kept where land remains (a burg on a cell that becomes water keeps it as land, height 20); 'keep' refuses any change that crosses height 20 and keeps cell ids, but still recomputes climate, rivers and biomes. The rebuild always runs, even when no height changed. erosion (default false): rivers are regenerated without lowering terrain; true re-runs the app's erosion. keepHeights (default true): land heights the rebuild or erosion changed are set back to the requested value (count in heightsRestored). biomes 'redefine' (default) recomputes every biome; 'keep' keeps painted biomes where land remains (risk only). Rivers are always regenerated (new river ids and names). dryRun:true returns counts (cells changed, land/water flips, land %, lakes before/after/formed, pits, fill raise) and changes nothing. One auto-undo entry; logged replayably in a sketch.",
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
      return out;
    }
  );

  ctx.tool(
    "flow",
    {
      title: "Preview water flow",
      description:
        "Read-only: where water runs downhill from one or more places, traced the way the river generator drains (lowest neighbour on depression-resolved heights, coastal cells pour into the nearest water, open lakes drain through their lowest shore cell). Per start: end {type: 'sea'|'lake'|'river' (joins an existing river, named)|'border' (off the map edge)|'pit' (an unresolved depression), x, y, cell, lake?/river?}, steps, length {px, km}, drop, throughLakes, climbs (cells the generator had to raise to drain: depressions in the real heights). Without heights it runs on the current map's cells; with heights {grid|pack|image, as in set_heights} or fill:true it runs on the proposed grid heights (cell ids are then grid ids, existing rivers are ignored because the rebuild regenerates them, and a lake's evaporation is not modelled). detail:true adds each path's cells and points. screenshot:true draws the paths on a temporary overlay, takes a framed shot and removes the overlay. Changes nothing.",
      inputSchema: z.object({
        from: z.union([Place, z.array(Place).min(1).max(50)]).describe("Start place(s)"),
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
      if (!args.screenshot) return out;
      let shot: WithImages;
      try {
        const o = await scope.call<{ bbox: [number, number, number, number] }>("flowOverlay", { paths: points });
        shot = await takeScreenshot(ctx, scope, { target: { bbox: o.bbox } });
      } finally {
        await scope.call("flowOverlay", { remove: true }, { noAlerts: true }).catch(() => {});
      }
      shot.value = { ...out, screenshot: shot.value };
      return shot;
    }
  );
}

defineTools("terrain", register);
