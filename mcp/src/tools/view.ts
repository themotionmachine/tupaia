// screenshot: frame a target, apply temporary layers, capture, save the PNG, return a JPEG.
// Also: reuse a stored view (view:'last'|shotId) and pixel-diff against an earlier shot.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { boxToMap, type CropView, pngPerMap } from "../compact.ts";
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

/** What the bridge's diffRegion returns: pixel boxes are [x0,y0,x1,y1] in the capture's pixels. */
interface RegionDiff {
  changed: number;
  total: number;
  changedPct: number;
  speckle: number;
  box: [number, number, number, number] | null;
  clusterCount: number;
  clusters: Array<{ px: number; box: [number, number, number, number] }>;
  cropBox?: [number, number, number, number];
  sheet?: { cw: number; ch: number; gap: number; scale: number };
  crop?: Encoded;
}

/**
 * Budget of a pixel diff on the page. The capture steps may have used up the call's own budget
 * (a loaded machine), and a diff that times out is taken for a hung page and relaunches it, so it
 * gets the snapshot housekeeping budget instead of the leftover.
 */
const DIFF_MS = 60_000;
/** Budget of the small page calls around a capture (freeze waits up to 1.5 s itself). */
const STEP_MS = 15_000;

/** A shot's view must match the new capture's for a pixel diff to mean anything. */
function assertSameFrame(rec: ShotRecord, view: ViewInfo, full: boolean): void {
  const hint = "drop target/zoom (compare reuses that shot's view) or pass view:<that shot>";
  if (rec.full !== full)
    throw new ToolError(
      "BAD_ARGS",
      `shot ${rec.id} is ${rec.full ? "a full-map shot" : "a viewport shot"}; compare it with ${rec.full ? "full:true" : "a viewport shot"}`
    );
  if (rec.graphWidth !== view.graphWidth || rec.graphHeight !== view.graphHeight)
    throw new ToolError(
      "BAD_ARGS",
      `shot ${rec.id} was of a ${rec.graphWidth}x${rec.graphHeight} map; this map differs, so they cannot be compared`
    );
  if (full) return;
  const a = rec.view;
  if (Math.abs(a.x - view.x) > 0.5 || Math.abs(a.y - view.y) > 0.5 || Math.abs(a.scale - view.scale) > 0.002 * a.scale)
    throw new ToolError(
      "BAD_ARGS",
      `shot ${rec.id} was framed differently (x ${a.x}, y ${a.y}, scale ${a.scale}; now x ${view.x}, y ${view.y}, scale ${view.scale}), so a pixel diff would compare unrelated frames: ${hint}`
    );
}

/** Why a compare found nothing visible, when the newest edit explains it. */
function redrawHint(ctx: ToolContext, rec: ShotRecord): string | null {
  const lr = ctx.lastRedraw;
  if (!lr || lr.at <= Date.parse(rec.at) || lr.ops !== ctx.snapshots.provenance.opsSince) return null;
  if (lr.suppressed)
    return `the last mutation (${lr.tool}) ran with redraw:[] so its changes are not drawn; redraw the layers it touched, then compare again`;
  if (!lr.redrawn.length && lr.skippedHidden.length)
    return `the last mutation (${lr.tool}) only touched hidden layers (${lr.skippedHidden.join(", ")}), which are not drawn`;
  return null;
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
    .describe(
      "Absolute zoom (scale) 0.1-20, raised to the full-map fit when lower (view.scale in the result is the zoom used); default fits the target (8 for points)"
    ),
  full: z
    .boolean()
    .optional()
    .describe(
      "Whole map rasterised at graph size x scale (ignores target/zoom); labels are sized and hidden for the full-map zoom, whatever the camera was"
    ),
  view: z.string().optional().describe("Reuse the exact view of an earlier shot: 'last' or a shotId"),
  layers: z.object({ on: z.array(LayerName).optional(), off: z.array(LayerName).optional() }).optional(),
  keepLayers: z
    .boolean()
    .optional()
    .describe("Keep the layer changes after the shot (default: revert); kept changes are undoable like display"),
  labels: z
    .enum(["all"])
    .optional()
    .describe(
      "'all': show every text label for this shot only, including the ones the zoom rule hides (not emblems; turns the labels layer on if it is off); nothing is kept and there is no undo entry"
    ),
  hideUi: z.boolean().optional().describe("Hide UI overlays and dialogs (default true)"),
  format: z.enum(["jpeg", "png"]).optional().describe("Returned image format (default jpeg)"),
  quality: z.number().min(0.3).max(1).optional().describe("JPEG quality (default 0.85)"),
  maxSide: z
    .number()
    .int()
    .min(256)
    .max(2048)
    .optional()
    .describe(
      "Longest side of the returned image, 256..2048 (default 1024; never upscales). The saved PNG (file) keeps the full resolution: a bigger full-map shot is shrunk to 2048 in the returned image only"
    ),
  scale: z.number().min(1).max(3).optional().describe("Render resolution multiplier for the saved PNG (default 1)"),
  saveTo: z
    .string()
    .optional()
    .describe(".png path for the full-resolution capture (default TUPAIA_OUT/shots/<id>.png)"),
  overwrite: z.boolean().optional().describe("saveTo: replace an existing file"),
  compare: z
    .string()
    .optional()
    .describe(
      "shotId to diff against; returns a diff image and changedPct (same view and, unless layers is given, the same layers as that shot, for this capture only; nothing changed = no image). Pass the same scale and full as that shot. For a legible small change, take the baseline zoomed in (target/zoom) and compare with view:<that shot>; crop:'changed' is the lean default"
    ),
  threshold: z
    .number()
    .int()
    .min(0)
    .max(255)
    .optional()
    .describe("Per-channel difference that counts as changed (default 32)"),
  crop: z
    .enum(["changed"])
    .optional()
    .describe(
      "With compare: return only the changed region of the new shot (cropped, not the diff image) with its bbox in map px; nothing changed = no image and a one-line note"
    ),
  pad: z
    .number()
    .min(0)
    .max(5000)
    .optional()
    .describe(
      "crop:'changed': context around the changed region in map px (default 10% of the region; a crop is never under 128 px)"
    ),
  sideBySide: z
    .boolean()
    .optional()
    .describe("crop:'changed': return before | after in one image instead of just the new shot")
});

/** Servers whose last labels:'all' shot could not clean up (the temporary <style> may still be in the page). */
const labelsShotDirty = new WeakSet<ToolContext>();

export async function takeScreenshot(
  ctx: ToolContext,
  scope: CallScope,
  args: z.infer<typeof ScreenshotInput>
): Promise<WithImages> {
  if ((args.crop || args.pad !== undefined || args.sideBySide) && !args.compare)
    throw new ToolError(
      "BAD_ARGS",
      "crop/pad/sideBySide need compare:<shotId> (the shot to measure the change against)"
    );
  if ((args.pad !== undefined || args.sideBySide) && !args.crop)
    throw new ToolError("BAD_ARGS", "pad and sideBySide apply to crop:'changed'");
  const compareRec = args.compare ? ctx.shots.get(args.compare) : null;
  const full = args.full ?? (compareRec ? compareRec.full : false);
  const viewRec = args.view ? ctx.shots.get(args.view) : compareRec && !args.target && !args.zoom ? compareRec : null;
  const scale = args.scale ?? 1;
  const format = args.format ?? "jpeg";
  const maxSide = args.maxSide ?? 1024;
  const hideUi = args.hideUi ?? true;
  if (args.labels === "all" && args.layers?.off?.includes("labels"))
    throw new ToolError("BAD_ARGS", "labels:'all' needs the labels layer on, but layers.off lists 'labels'");
  // validated up front: a refused path leaves no shot id behind
  const saveTo = args.saveTo
    ? resolveWritePath(ctx.config, args.saveTo, { exts: [".png"], overwrite: !!args.overwrite })
    : null;
  let before: string | null = null;
  if (compareRec) {
    if (!fs.existsSync(compareRec.file))
      throw new ToolError("NOT_FOUND", `the file of shot ${compareRec.id} is gone: ${compareRec.file}`);
    before = fs.readFileSync(compareRec.file).toString("base64");
  }

  if (labelsShotDirty.has(ctx)) {
    // an earlier labels:'all' shot failed to clean up: drop its style tag before this shot sees it
    await scope.call("labelsShot", { on: false }).then(
      () => labelsShotDirty.delete(ctx),
      () => {}
    );
  }
  let labelsShot: { layerTurnedOn: boolean } | null = null;
  let labelsRevealed: number | undefined;
  let exactView = false;
  let layerChange: { changed: unknown[]; previous: { on: string[]; off: string[] } } | null = null;
  // compare without layers: capture with the compared shot's layers (temporarily), else the diff is all layer changes
  let layersFromCompare: { on: string[]; off: string[] } | null = null;
  let capturedLayers: string[] = [];
  let png: Buffer;
  let view: ViewInfo;
  let frozen = false;
  try {
    if (compareRec && !args.layers && compareRec.layersOn.length) {
      const now = await scope.call<string[]>("layersOn", {}, { noAlerts: true });
      const on = compareRec.layersOn.filter(l => !now.includes(l));
      const off = now.filter(l => !compareRec.layersOn.includes(l));
      if (on.length || off.length) {
        layersFromCompare = { on, off };
      }
    }
    if (layersFromCompare) {
      layerChange = await scope.call("setLayers", layersFromCompare);
    } else if (args.layers && (args.layers.on?.length ?? 0) + (args.layers.off?.length ?? 0) > 0) {
      // kept layer changes are part of the saved map (the SVG), so they are undoable like display
      if (args.keepLayers) await scope.pushUndo("screenshot keepLayers", { layers: args.layers });
      layerChange = await scope.call("setLayers", { on: args.layers.on ?? [], off: args.layers.off ?? [] });
      if (args.keepLayers && layerChange?.changed.length) ctx.snapshots.noteMutation();
      // kept layers are a display change in a sketch's log
      if (args.keepLayers)
        await scope.record("display", args, { on: args.layers.on ?? [], off: args.layers.off ?? [] });
    }
    if (args.labels === "all") {
      labelsShotDirty.add(ctx);
      labelsShot = await scope.call<{ layerTurnedOn: boolean }>("labelsShot", { on: true });
    }
    if (full) {
      view = await scope.call<ViewInfo>("getView");
      if (compareRec) assertSameFrame(compareRec, view, full);
      const r = await scope.call<Encoded>("rasterize", { scale, format: "png" }, { noAlerts: true });
      png = Buffer.from(r.b64, "base64");
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
        exactView = true;
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
      // getView rounds x, y and scale, and a later view:/compare: re-applies those rounded values,
      // which shifts the drawing by a fraction of a pixel and speckles thin strokes in the diff.
      // Capture at the rounded view too, so a shot and its replay are pixel-identical. (frame's
      // label and box are not part of the view setView returns: keep them.)
      if (!exactView) {
        const framed = { target: view.target, box: view.box };
        view = { ...(await scope.call<ViewInfo>("setView", { view })), ...framed };
      }
      if (compareRec) assertSameFrame(compareRec, view, full);
      await scope.call("settle", {}, { noAlerts: true });
      // the moving trade markers would show up as a change in every compare: hide them while capturing
      if (hideUi) {
        await scope.call("freeze", {}, { noAlerts: true, timeoutMs: STEP_MS });
        frozen = true;
      }
      png = await ctx.browser.screenshotMap({ hideUi, scale, timeoutMs: scope.remainingMs });
    }
    capturedLayers = await scope.call<string[]>("layersOn", {}, { noAlerts: true }).catch(() => []);
  } finally {
    // undone in the reverse order of setup: thaw (set last), then the labels:'all' style, then
    // layers; in cleanup(), so a cancelled or out-of-budget shot still puts the page back
    await scope.cleanup(async () => {
      if (frozen) await scope.call("thaw", {}, { noAlerts: true, timeoutMs: STEP_MS }).catch(() => {});
      if (labelsShot) {
        // a <style> tag and (maybe) the labels layer: removed/restored here, never in the map or the undo stack
        const r = await scope
          .call<{ revealed: number }>("labelsShot", { on: false, restoreLayer: labelsShot.layerTurnedOn })
          .catch(() => null);
        labelsRevealed = r?.revealed;
        if (r) labelsShotDirty.delete(ctx);
        else
          scope.notes.push(
            "labels:'all' could not be undone in the page (its temporary style may remain); the next screenshot retries, or reload the page"
          );
      }
      if (layerChange && (!args.keepLayers || layersFromCompare)) {
        const prev = layerChange.previous;
        if (prev.on.length || prev.off.length)
          await scope.call("setLayers", { on: prev.on, off: prev.off }).catch(() => {});
      }
    });
  }

  const size = pngSize(png);
  if (compareRec && (size.width !== compareRec.pngW || size.height !== compareRec.pngH))
    throw new ToolError(
      "BAD_ARGS",
      `shot ${compareRec.id} is ${compareRec.pngW}x${compareRec.pngH} px but this capture is ${size.width}x${size.height}: pass the same scale${compareRec.full ? " (and full:true)" : ""} as shot ${compareRec.id} (or the viewport changed since)`
    );
  const pngB64 = png.toString("base64");
  const cssW = full ? view.graphWidth : view.svgWidth;
  const cssH = full ? view.graphHeight : view.svgHeight;
  const cv: CropView = {
    full,
    pngW: size.width,
    pngH: size.height,
    cssW,
    cssH,
    graphWidth: view.graphWidth,
    graphHeight: view.graphHeight,
    x: view.x,
    y: view.y,
    scale: view.scale
  };

  // The comparison runs before the shot gets an id or a file, so a failed one leaves neither.
  const images: ImageBlock[] = [];
  let compare: Record<string, unknown> | undefined;
  let returned: { width: number; height: number } = { width: size.width, height: size.height };
  let cropped: Record<string, unknown> | null = null;
  let cropGeometry: ShotRecord["crop"];
  let plainDiff: (Encoded & { changed: number; total: number; changedPct: number }) | null = null;
  if (compareRec && before && args.crop === "changed") {
    const d = await scope.call<RegionDiff>(
      "diffRegion",
      {
        a: before,
        b: pngB64,
        threshold: args.threshold ?? 32,
        padPx: args.pad === undefined ? undefined : args.pad * pngPerMap(cv),
        sideBySide: !!args.sideBySide,
        format,
        quality: args.quality,
        maxSide
      },
      { noAlerts: true, timeoutMs: DIFF_MS }
    );
    if (!d.box || !d.crop || !d.cropBox || !d.sheet) {
      const pct = d.changedPct >= 0.001 ? ` (${d.changedPct}%)` : "";
      const hint = redrawHint(ctx, compareRec);
      compare = { with: compareRec.id, changedPct: d.changedPct, changedPixels: d.changed };
      cropped = {
        note: d.changed
          ? `no significant change vs ${compareRec.id}: only ${d.changed} scattered pixel${d.changed === 1 ? " differs" : `s${pct} differ`}, treated as render noise (drop crop to see them)${hint ? `; ${hint}` : ""}`
          : `nothing changed vs ${compareRec.id}: 0 of ${d.total} pixels differ${hint ? `; ${hint}` : ""}`
      };
    } else {
      images.push({ data: d.crop.b64, mimeType: d.crop.mime });
      returned = { width: d.crop.width, height: d.crop.height };
      cropGeometry = {
        box: d.cropBox,
        ...(args.sideBySide
          ? {
              half: {
                width: Math.round(d.sheet.cw * d.sheet.scale),
                right: Math.round((d.sheet.cw + d.sheet.gap) * d.sheet.scale)
              }
            }
          : {})
      };
      const edges = [
        ...(d.box[1] <= 0 ? ["top"] : []),
        ...(d.box[3] >= size.height ? ["bottom"] : []),
        ...(d.box[0] <= 0 ? ["left"] : []),
        ...(d.box[2] >= size.width ? ["right"] : [])
      ];
      const cropArea = ((d.cropBox[2] - d.cropBox[0]) * (d.cropBox[3] - d.cropBox[1])) / (size.width * size.height);
      const spread =
        cropArea > 0.6
          ? `the shown region is ${Math.round(cropArea * 100)}% of the frame, so the crop saves little${d.clusters.length > 1 ? "; frame one of the clusters with screenshot {target:{bbox}} for a tighter shot" : ""}`
          : null;
      compare = {
        with: compareRec.id,
        changedPct: d.changedPct,
        changedPixels: d.changed,
        bbox: boxToMap(d.box, cv),
        shown: boxToMap(d.cropBox, cv),
        // several separate changes: where each one is, for a tighter shot of one of them
        ...(d.clusters.length > 1
          ? {
              clusters: d.clusters.map(c => ({ bbox: boxToMap(c.box, cv), pixels: c.px })),
              ...(d.clusterCount > d.clusters.length ? { moreClusters: d.clusterCount - d.clusters.length } : {})
            }
          : {}),
        ...(edges.length ? { touchesEdge: edges } : {}),
        ...(spread ? { spread } : {}),
        ...(args.sideBySide ? { sideBySide: "left = before, right = after" } : {}),
        ...(d.speckle ? { ignoredSpeckle: d.speckle } : {})
      };
      cropped = { width: d.crop.width, height: d.crop.height, format: d.crop.mime };
    }
  } else if (compareRec && before) {
    plainDiff = await scope.call<Encoded & { changed: number; total: number; changedPct: number }>(
      "diffImages",
      { a: before, b: pngB64, format, maxSide, threshold: args.threshold ?? 32, quality: args.quality },
      { noAlerts: true, timeoutMs: DIFF_MS }
    );
    returned = { width: plainDiff.width, height: plainDiff.height };
  }

  const id = ctx.shots.nextId();
  const file = saveTo ?? path.join(ctx.config.outDir, "shots", `${id}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);

  if (compareRec && plainDiff && plainDiff.changed === 0) {
    // an all-grey diff says nothing: no image, one line (the capture is still saved in file)
    const hint = redrawHint(ctx, compareRec);
    returned = { width: size.width, height: size.height };
    compare = {
      with: compareRec.id,
      changedPct: 0,
      changedPixels: 0,
      note: `nothing changed vs ${compareRec.id}: 0 of ${plainDiff.total} pixels differ; no image returned${hint ? `; ${hint}` : ""}`
    };
  } else if (compareRec && plainDiff) {
    const diffFile = path.join(
      ctx.config.outDir,
      "shots",
      `${id}-vs-${compareRec.id}.${format === "png" ? "png" : "jpg"}`
    );
    fs.writeFileSync(diffFile, Buffer.from(plainDiff.b64, "base64"));
    images.push({ data: plainDiff.b64, mimeType: plainDiff.mime });
    const hint = plainDiff.changedPct < 0.05 ? redrawHint(ctx, compareRec) : null;
    compare = {
      with: compareRec.id,
      changedPct: plainDiff.changedPct,
      changedPixels: plainDiff.changed,
      totalPixels: plainDiff.total,
      diffFile,
      legend:
        "red = changed pixels, grey = unchanged; the returned image is the diff, the new capture is in file. Up to ~100 changed pixels on an unchanged view is render noise",
      ...(hint ? { hint } : {})
    };
  } else if (!compareRec) {
    const enc = await scope.call<Encoded>(
      "encodeImage",
      { b64: pngB64, mime: "image/png", format, quality: args.quality ?? 0.85, maxSide },
      { noAlerts: true, timeoutMs: DIFF_MS }
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
    cssW,
    cssH,
    imgW: returned.width,
    imgH: returned.height,
    layersOn: capturedLayers,
    ...(cropGeometry ? { crop: cropGeometry } : {})
  };
  ctx.shots.add(rec);

  if (compare && layersFromCompare)
    compare.layers = `captured with shot ${compareRec?.id}'s layers (this shot only): on [${layersFromCompare.on.join(", ")}], off [${layersFromCompare.off.join(", ")}]`;

  if (cropped) {
    // changed-region result: no repeat of the view metadata, the shot is already known
    return new WithImages(
      {
        shotId: id,
        ...(images.length ? { file } : {}),
        ...cropped,
        // labels:'all' with crop:'changed': still say how many hidden labels the shot revealed
        ...(args.labels === "all" ? { labels: { mode: "all", revealed: labelsRevealed } } : {}),
        compare
      },
      images
    );
  }

  return new WithImages(
    {
      shotId: id,
      file,
      ...(images.length ? { width: returned.width, height: returned.height, format: images[0].mimeType } : {}),
      png: { width: size.width, height: size.height },
      full,
      view: full ? undefined : { x: view.x, y: view.y, scale: view.scale },
      mapBboxShown: full ? [0, 0, view.graphWidth, view.graphHeight] : view.mapBboxShown,
      target: view.target,
      labels: args.labels === "all" ? { mode: "all", revealed: labelsRevealed } : undefined,
      layersChanged:
        layerChange?.changed.length && !layersFromCompare
          ? { changed: layerChange.changed, reverted: !args.keepLayers }
          : undefined,
      compare,
      pixelHint: images.length
        ? `inspect {at:{screen:[px,py], shot:'${id}'}} maps a pixel of this ${returned.width}x${returned.height} image to the map`
        : undefined
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
        "See the map. Frames target {entity:{type,ref}} | {bbox:[x0,y0,x1,y1]} | {at:Place} at an optional zoom (0.1-20, not below the full-map fit; default fits the target, 8 for a point), or reuses an earlier shot's exact view (view:'last'|shotId), or keeps the current view. full:true rasterises the whole map instead, with labels sized for the full-map zoom whatever the camera was. layers:{on,off} apply only for this shot (keepLayers:true keeps them). labels:'all' shows every text label for this shot only, including the ones the zoom rule hides (display {labels} changes that for good). Returns a JPEG (maxSide 1024 by default) plus {shotId, file (full-resolution PNG), view, mapBboxShown}. The animated trade markers are hidden while capturing, so two shots of one view are pixel-identical. compare:shotId diffs against that shot at the same view (a different frame is refused: BAD_ARGS) and returns the diff image (red = changed) with changedPct. crop:'changed' (with compare) returns only the changed region of the new shot instead (pad in map px; sideBySide = before | after), with compare.bbox and compare.shown (the box the image maps onto) in map px, compare.clusters (each separate change, largest first, when there are several), touchesEdge and spread notes; nothing changed = no image and a one-line note (which says when the newest edit ran with redraw:[] or only touched hidden layers, so it was not drawn). inspect {at:{screen,shot}} works on a crop shot (pixels of the returned image). Take one after any visual change, framed on what changed; skip it after pure reads.",
      inputSchema: ScreenshotInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
      kind: "view"
    },
    async (args, scope) => takeScreenshot(ctx, scope, args)
  );
}

defineTools("view", register);
