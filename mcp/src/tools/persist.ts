// load_map, save_map and export.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CallScope, ToolContext } from "../context.ts";
import { resolveReadPath, resolveWritePath } from "../paths.ts";
import { ToolError } from "../result.ts";
import { TimeoutMs } from "../schemas.ts";
import { sha256 } from "../shared-api.ts";
import { defineTools } from "./registry.ts";
import { pngSize } from "./view.ts";

function brief(s: Record<string, unknown>): Record<string, unknown> {
  return {
    name: s.name,
    seed: s.seed,
    version: s.version,
    graph: s.graph,
    cells: s.cells,
    counts: s.counts,
    features: s.features
  };
}

export function register(ctx: ToolContext): void {
  ctx.tool(
    "load_map",
    {
      title: "Load a map",
      description:
        "Replace the page's map with a .map file from disk ({path}, relative paths resolve from the repo root; plain, base64 or gzip) or with the live shared map ({source:'shared'}: a read-only GET from Node, safe in local mode; records the shared version and who last saved it). Undoable (snapshot {action:'undo'}). Take a snapshot first if the current map matters. Fails with APP_ALERT when the app rejects the file (Invalid/Ancient/Newer file).",
      inputSchema: z.object({
        path: z.string().min(1).optional(),
        source: z.enum(["shared"]).optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      kind: "heavy"
    },
    async (args, scope) => {
      if (!!args.path === !!args.source) throw new ToolError("BAD_ARGS", "pass exactly one of path or source:'shared'");
      const t0 = Date.now();
      if (args.path) {
        const abs = resolveReadPath(ctx.config, args.path);
        const bytes = fs.readFileSync(abs);
        await scope.pushUndo("load_map", { path: args.path });
        const s = await scope.loadMap({ b64: bytes.toString("base64") });
        ctx.snapshots.setProvenance({
          kind: "file",
          path: abs,
          seed: (s.seed as string) ?? null,
          mapId: (s.mapId as number) ?? null
        });
        return { ...brief(s), origin: ctx.provenanceView(), bytes: bytes.length, ms: Date.now() - t0 };
      }
      const { summary, bytes } = await loadShared(ctx, scope, "load_map");
      return { ...brief(summary), origin: ctx.provenanceView(), bytes, ms: Date.now() - t0 };
    }
  );

  ctx.tool(
    "save_map",
    {
      title: "Save the map to a .map file",
      description:
        "Write the current map (the app's prepareMapData, same as File > Save) to a .map file on disk. Relative paths go under TUPAIA_OUT (default <repo>/.tupaia-mcp-out); a path in the repo is allowed outside source/config folders; anything else needs allowOutside:true and only when the human asked for that place. Replacing an existing file needs overwrite:true. tests/fixtures is always refused. Refused while an app editor is active (customization != 0). Returns {path, bytes, sha256}. This never touches the live shared map (that is shared_save).",
      inputSchema: z.object({
        path: z.string().min(1).optional().describe("Target .map path (default TUPAIA_OUT/maps/<name>-<time>.map)"),
        overwrite: z.boolean().optional(),
        allowOutside: z.boolean().optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      kind: "heavy"
    },
    async (args, scope) => {
      const t0 = Date.now();
      const data = await scope.call<{ text: string; customization: number; fileName: string | null }>(
        "mapData",
        {},
        { noAlerts: true }
      );
      if (data.customization) {
        throw new ToolError(
          "REFUSED",
          `an app editor is active (customization=${data.customization}); close it first (eval: closeDialogs(); customization = 0)`
        );
      }
      const target = args.path ?? path.join("maps", `${slug(data.fileName)}-${stamp()}.map`);
      const file = resolveWritePath(ctx.config, target, {
        exts: [".map"],
        overwrite: args.overwrite,
        allowOutside: args.allowOutside
      });
      const buf = Buffer.from(data.text, "utf8");
      fs.writeFileSync(file, buf);
      return { path: file, bytes: buf.length, sha256: sha256(buf), name: data.fileName, ms: Date.now() - t0 };
    }
  );

  ctx.tool(
    "export",
    {
      title: "Export the map",
      description:
        "Export the map to a file. svg: the whole map as SVG (fullMap, fonts embedded). png/jpeg: the whole map rasterised at graph size x scale (the same renderer as screenshot {full:true}). json-full/json-minimal (also json-packcells/json-gridcells) and geojson-cells/-routes/-rivers/-markers/-zones: the app's own exporters, captured as downloads. Options for svg/png/jpeg: noLabels, noWater, noScaleBar, noIce, noVignette, fullMap (svg only: default true, false = the current view). Same path policy as save_map (relative paths under TUPAIA_OUT; overwrite:true to replace; allowOutside:true for elsewhere; tests/fixtures refused). Returns {path, bytes, width?, height?}.",
      inputSchema: z.object({
        format: z.enum(EXPORT_FORMATS),
        path: z.string().min(1).optional().describe("Target file (default TUPAIA_OUT/exports/<name>-<time>.<ext>)"),
        scale: z.number().min(0.25).max(4).optional().describe("png/jpeg: multiplier on the graph size (default 1)"),
        quality: z.number().min(0.3).max(1).optional().describe("jpeg quality (default 0.92)"),
        fullMap: z.boolean().optional(),
        noLabels: z.boolean().optional(),
        noWater: z.boolean().optional(),
        noScaleBar: z.boolean().optional(),
        noIce: z.boolean().optional(),
        noVignette: z.boolean().optional(),
        overwrite: z.boolean().optional(),
        allowOutside: z.boolean().optional(),
        timeoutMs: TimeoutMs
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      kind: "heavy"
    },
    async (args, scope) => exportMap(ctx, scope, args)
  );
}

const EXPORT_FORMATS = [
  "svg",
  "png",
  "jpeg",
  "json-full",
  "json-minimal",
  "json-packcells",
  "json-gridcells",
  "geojson-cells",
  "geojson-routes",
  "geojson-rivers",
  "geojson-markers",
  "geojson-zones"
] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

function extsFor(format: ExportFormat): string[] {
  if (format === "svg") return [".svg"];
  if (format === "png") return [".png"];
  if (format === "jpeg") return [".jpg", ".jpeg"];
  if (format.startsWith("geojson")) return [".geojson", ".json"];
  return [".json"];
}

function slug(name: string | null): string {
  const s = (name ?? "map")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || "map";
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function exportMap(
  ctx: ToolContext,
  scope: CallScope,
  args: {
    format: ExportFormat;
    path?: string;
    scale?: number;
    quality?: number;
    overwrite?: boolean;
    allowOutside?: boolean;
    fullMap?: boolean;
    noLabels?: boolean;
    noWater?: boolean;
    noScaleBar?: boolean;
    noIce?: boolean;
    noVignette?: boolean;
  }
): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const exts = extsFor(args.format);
  const { fileName } = await scope.call<{ fileName: string | null }>("mapFileName", {}, { noAlerts: true });
  const target = args.path ?? path.join("exports", `${slug(fileName)}-${stamp()}${exts[0]}`);
  const file = resolveWritePath(ctx.config, target, {
    exts,
    overwrite: args.overwrite,
    allowOutside: args.allowOutside
  });
  const options = {
    fullMap: args.fullMap,
    noLabels: args.noLabels,
    noWater: args.noWater,
    noScaleBar: args.noScaleBar,
    noIce: args.noIce,
    noVignette: args.noVignette
  };
  if (args.format === "svg") {
    const r = await scope.call<{ text: string; graphWidth: number; graphHeight: number }>(
      "exportSvg",
      { options },
      { noAlerts: true }
    );
    fs.writeFileSync(file, r.text);
    return {
      path: file,
      format: "svg",
      bytes: Buffer.byteLength(r.text),
      width: r.graphWidth,
      height: r.graphHeight,
      ms: Date.now() - t0
    };
  }
  if (args.format === "png" || args.format === "jpeg") {
    if (args.fullMap === false) {
      throw new ToolError("BAD_ARGS", "png/jpeg export is always the whole map; use screenshot for the current view");
    }
    const r = await scope.call<{ b64: string; width: number; height: number }>(
      "exportRaster",
      { format: args.format, scale: args.scale ?? 1, quality: args.quality ?? 0.92, options },
      { noAlerts: true }
    );
    const buf = Buffer.from(r.b64, "base64");
    if (args.format === "png") pngSize(buf); // sanity: a real PNG
    fs.writeFileSync(file, buf);
    return {
      path: file,
      format: args.format,
      bytes: buf.length,
      width: r.width,
      height: r.height,
      ms: Date.now() - t0
    };
  }
  // json-* / geojson-*: the app only offers these as downloads; capture the download event.
  const page = await ctx.browser.getPage();
  const download = page.waitForEvent("download", { timeout: scope.remainingMs });
  download.catch(() => {});
  await scope.call("triggerDownload", { format: args.format }, { noAlerts: true });
  let d: Awaited<typeof download>;
  try {
    d = await download;
  } catch (e) {
    throw new ToolError("TIMEOUT", `no download arrived for ${args.format}: ${(e as Error).message.split("\n")[0]}`);
  }
  if (fs.existsSync(file)) fs.rmSync(file); // overwrite was checked by resolveWritePath
  await d.saveAs(file);
  const bytes = fs.statSync(file).size;
  if (!bytes) throw new ToolError("PAGE_ERROR", `the ${args.format} export was empty`);
  return { path: file, format: args.format, bytes, suggestedName: d.suggestedFilename(), ms: Date.now() - t0 };
}

/**
 * Fetch the live shared map (read-only GET from Node) and load it into the page, with an
 * undo entry first. Sets provenance to shared at the fetched version.
 */
export async function loadShared(
  ctx: ToolContext,
  scope: CallScope,
  op: string
): Promise<{ summary: Record<string, unknown>; bytes: number; version: number | null }> {
  const blob = await ctx.shared.getMap();
  await scope.pushUndo(op, { source: "shared" });
  const summary = await scope.loadMap({ b64: blob.bytes.toString("base64") });
  ctx.snapshots.setProvenance({
    kind: "shared",
    seed: (summary.seed as string) ?? null,
    mapId: (summary.mapId as number) ?? null,
    sharedVersion: blob.version ?? undefined,
    sharedUpdatedBy: blob.updatedBy,
    sharedUpdatedAt: blob.updatedAt,
    fetchedAt: new Date().toISOString()
  });
  return { summary, bytes: blob.bytes.length, version: blob.version };
}

defineTools("persist", register);
