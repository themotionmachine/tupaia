// screenshot: frame a target, apply temporary layers, capture, save the PNG, return a JPEG.
// Also: reuse a stored view (view:'last'|shotId) and pixel-diff against an earlier shot.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CallScope, ShotRecord, ToolContext } from "../context.ts";
import { resolveWritePath } from "../paths.ts";
import { type ImageBlock, ToolError, WithImages } from "../result.ts";
import { EntityRef, EntityType, LayerName, Place } from "../schemas.ts";
import { defineTools } from "./registry.ts";

interface ViewInfo {
  x: number;
  y: number;
  scale: number;
  svgWidth: number;
  svgHeight: number;
  graphWidth: number;
  graphHeight: number;
  mapBboxShown: [number, number, number, number];
  target?: string;
  box?: number[];
}

interface Encoded {
  b64: string;
  mime: string;
  width: number;
  height: number;
}

export function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new ToolError("PAGE_ERROR", "not a PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const Target = z.union([
  z.object({ entity: z.object({ type: EntityType, ref: EntityRef }) }),
  z.object({ bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).describe("[x0, y0, x1, y1] map px") }),
  z.object({ at: Place })
]);

export const ScreenshotInput = z.object({
  target: Target.optional().describe("Frame an entity, a bbox, or a place"),
  zoom: z
    .number()
    .min(0.1)
    .max(20)
    .optional()
    .describe("Absolute zoom (scale) 1-20; default fits the target (8 for points)"),
  full: z.boolean().optional().describe("Whole map rasterised at graph size x scale (ignores target/zoom)"),
  view: z.string().optional().describe("Reuse the exact view of an earlier shot: 'last' or a shotId"),
  layers: z.object({ on: z.array(LayerName).optional(), off: z.array(LayerName).optional() }).optional(),
  keepLayers: z
    .boolean()
    .optional()
    .describe("Keep the layer changes after the shot (default: revert); kept changes are undoable like display"),
  hideUi: z.boolean().optional().describe("Hide UI overlays and dialogs (default true)"),
  format: z.enum(["jpeg", "png"]).optional().describe("Returned image format (default jpeg)"),
  quality: z.number().min(0.3).max(1).optional().describe("JPEG quality (default 0.85)"),
  maxSide: z.number().int().min(256).max(2048).optional().describe("Longest side of the returned image (default 1024)"),
  scale: z.number().min(1).max(3).optional().describe("Render resolution multiplier for the saved PNG (default 1)"),
  saveTo: z
    .string()
    .optional()
    .describe(".png path for the full-resolution capture (default TUPAIA_OUT/shots/<id>.png)"),
  overwrite: z.boolean().optional().describe("saveTo: replace an existing file"),
  compare: z
    .string()
    .optional()
    .describe("shotId to diff against; returns a diff image and changedPct (same view by default)"),
  threshold: z
    .number()
    .int()
    .min(0)
    .max(255)
    .optional()
    .describe("Per-channel difference that counts as changed (default 32)")
});

export async function takeScreenshot(
  ctx: ToolContext,
  scope: CallScope,
  args: z.infer<typeof ScreenshotInput>
): Promise<WithImages> {
  const compareRec = args.compare ? ctx.shots.get(args.compare) : null;
  const full = args.full ?? (compareRec ? compareRec.full : false);
  const viewRec = args.view ? ctx.shots.get(args.view) : compareRec && !args.target && !args.zoom ? compareRec : null;
  const scale = args.scale ?? 1;
  const format = args.format ?? "jpeg";
  const maxSide = args.maxSide ?? 1024;
  const hideUi = args.hideUi ?? true;

  let layerChange: { changed: unknown[]; previous: { on: string[]; off: string[] } } | null = null;
  let png: Buffer;
  let view: ViewInfo;
  try {
    if (args.layers && (args.layers.on?.length ?? 0) + (args.layers.off?.length ?? 0) > 0) {
      // kept layer changes are part of the saved map (the SVG), so they are undoable like display
      if (args.keepLayers) await scope.pushUndo("screenshot keepLayers", { layers: args.layers });
      layerChange = await scope.call("setLayers", { on: args.layers.on ?? [], off: args.layers.off ?? [] });
      if (args.keepLayers && layerChange?.changed.length) ctx.snapshots.noteMutation();
      // kept layers are a display change in a sketch's log
      if (args.keepLayers)
        await scope.record("display", args, { on: args.layers.on ?? [], off: args.layers.off ?? [] });
    }
    if (full) {
      const r = await scope.call<Encoded>("rasterize", { scale, format: "png" }, { noAlerts: true });
      png = Buffer.from(r.b64, "base64");
      view = await scope.call<ViewInfo>("getView");
    } else {
      if (args.target) {
        view = await scope.call<ViewInfo>("frame", { target: args.target, zoom: args.zoom });
      } else if (viewRec) {
        const cur = await scope.call<ViewInfo>("getView");
        if (viewRec.full)
          throw new ToolError("BAD_ARGS", `shot ${viewRec.id} is a full-map shot; pass full:true instead of view`);
        if (cur.graphWidth !== viewRec.graphWidth || cur.graphHeight !== viewRec.graphHeight) {
          throw new ToolError(
            "BAD_ARGS",
            `shot ${viewRec.id} was of a ${viewRec.graphWidth}x${viewRec.graphHeight} map; this map differs`
          );
        }
        view = await scope.call<ViewInfo>("setView", { view: viewRec.view });
      } else if (args.zoom) {
        const cur = await scope.call<ViewInfo>("getView");
        const [x0, y0, x1, y1] = cur.mapBboxShown;
        view = await scope.call<ViewInfo>("frame", {
          target: { at: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } },
          zoom: args.zoom
        });
      } else {
        view = await scope.call<ViewInfo>("getView");
      }
      await scope.call("settle", {}, { noAlerts: true });
      png = await ctx.browser.screenshotMap({ hideUi, scale, timeoutMs: scope.remainingMs });
    }
  } finally {
    if (layerChange && !args.keepLayers) {
      const prev = layerChange.previous;
      if (prev.on.length || prev.off.length)
        await scope.call("setLayers", { on: prev.on, off: prev.off }).catch(() => {});
    }
  }

  const id = ctx.shots.nextId();
  const file = args.saveTo
    ? resolveWritePath(ctx.config, args.saveTo, { exts: [".png"], overwrite: !!args.overwrite })
    : path.join(ctx.config.outDir, "shots", `${id}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
  const size = pngSize(png);
  const pngB64 = png.toString("base64");

  const images: ImageBlock[] = [];
  let compare: Record<string, unknown> | undefined;
  let returned: { width: number; height: number };
  if (compareRec) {
    if (!fs.existsSync(compareRec.file))
      throw new ToolError("NOT_FOUND", `the file of shot ${compareRec.id} is gone: ${compareRec.file}`);
    const before = fs.readFileSync(compareRec.file).toString("base64");
    const d = await scope.call<Encoded & { changed: number; total: number; changedPct: number }>(
      "diffImages",
      { a: before, b: pngB64, format, maxSide, threshold: args.threshold ?? 32, quality: args.quality },
      { noAlerts: true }
    );
    const diffFile = path.join(
      ctx.config.outDir,
      "shots",
      `${id}-vs-${compareRec.id}.${format === "png" ? "png" : "jpg"}`
    );
    fs.writeFileSync(diffFile, Buffer.from(d.b64, "base64"));
    images.push({ data: d.b64, mimeType: d.mime });
    returned = { width: d.width, height: d.height };
    compare = {
      with: compareRec.id,
      changedPct: d.changedPct,
      changedPixels: d.changed,
      totalPixels: d.total,
      diffFile,
      legend: "red = changed pixels, grey = unchanged; the returned image is the diff, the new capture is in file"
    };
  } else {
    const enc = await scope.call<Encoded>(
      "encodeImage",
      { b64: pngB64, mime: "image/png", format, quality: args.quality ?? 0.85, maxSide },
      { noAlerts: true }
    );
    images.push({ data: enc.b64, mimeType: enc.mime });
    returned = { width: enc.width, height: enc.height };
  }

  const rec: ShotRecord = {
    id,
    at: new Date().toISOString(),
    file,
    full,
    view: { x: view.x, y: view.y, scale: view.scale },
    graphWidth: view.graphWidth,
    graphHeight: view.graphHeight,
    pngW: size.width,
    pngH: size.height,
    cssW: full ? view.graphWidth : view.svgWidth,
    cssH: full ? view.graphHeight : view.svgHeight,
    imgW: returned.width,
    imgH: returned.height,
    layersOn: []
  };
  ctx.shots.add(rec);

  return new WithImages(
    {
      shotId: id,
      file,
      width: returned.width,
      height: returned.height,
      format: images[0].mimeType,
      png: { width: size.width, height: size.height },
      full,
      view: full ? undefined : { x: view.x, y: view.y, scale: view.scale },
      mapBboxShown: full ? [0, 0, view.graphWidth, view.graphHeight] : view.mapBboxShown,
      target: view.target,
      layersChanged: layerChange?.changed.length
        ? { changed: layerChange.changed, reverted: !args.keepLayers }
        : undefined,
      compare,
      pixelHint: `inspect {at:{screen:[px,py], shot:'${id}'}} maps a pixel of this ${returned.width}x${returned.height} image to the map`
    },
    images
  );
}

export function register(ctx: ToolContext): void {
  ctx.tool(
    "screenshot",
    {
      title: "Screenshot the map",
      description:
        "See the map. Frames target {entity:{type,ref}} | {bbox:[x0,y0,x1,y1]} | {at:Place} at an optional zoom (1-20; default fits the target, 8 for a point), or reuses an earlier shot's exact view (view:'last'|shotId), or keeps the current view. full:true rasterises the whole map instead. layers:{on,off} apply only for this shot (keepLayers:true keeps them). Returns a JPEG (maxSide 1024 by default) plus {shotId, file (full-resolution PNG), view, mapBboxShown}. compare:shotId diffs against that shot at the same view and returns the diff image (red = changed) with changedPct. Take one after any visual change, framed on what changed; skip it after pure reads.",
      inputSchema: ScreenshotInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
      kind: "view"
    },
    async (args, scope) => takeScreenshot(ctx, scope, args)
  );
}

defineTools("view", register);
