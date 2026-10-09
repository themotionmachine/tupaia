// Read tools: map_info, find, inspect.
import { z } from "zod";
import type { CallScope, ShotRecord, ToolContext } from "../context.ts";
import { META_TEXT_HEAVY, ToolError } from "../result.ts";
import { EntityRef, EntityType, Place, ScreenPlace } from "../schemas.ts";
import { defineTools } from "./registry.ts";

/** View object the bridge's screenToMap() understands, from a stored shot. */
export function shotView(rec: ShotRecord): Record<string, unknown> {
  return {
    full: rec.full,
    imgW: rec.imgW,
    imgH: rec.imgH,
    cssW: rec.cssW,
    cssH: rec.cssH,
    x: rec.view.x,
    y: rec.view.y,
    scale: rec.view.scale,
    graphWidth: rec.graphWidth,
    graphHeight: rec.graphHeight
  };
}

/** Convert {screen, shot} into the bridge's {screen, view} place; other places pass through. */
export function bridgePlace(ctx: ToolContext, p: unknown): unknown {
  if (p && typeof p === "object" && "screen" in p && "shot" in p) {
    const sp = p as { screen: [number, number]; shot: string };
    return { screen: sp.screen, view: shotView(ctx.shots.get(sp.shot)) };
  }
  return p;
}

/** Resolve map_info's `since` to a baseline key. */
function sinceKey(ctx: ToolContext, since: string | number | undefined): { key: string; describe: string } | null {
  if (since === "none") return null;
  if (since === undefined || since === "snapshot") {
    const k = ctx.snapshots.latestBaselineKey();
    return k ?? { key: "", describe: "no snapshot or undo point yet" };
  }
  if (since === "checkpoint") return { key: "checkpoint", describe: "the previous map_info call" };
  const s = ctx.snapshots.find(since);
  if (!s) {
    throw new ToolError("NOT_FOUND", `no snapshot '${since}'`, {
      candidates: ctx.snapshots.snapshots.map(x => ({ i: x.id, name: x.label }))
    });
  }
  return { key: s.baselineKey, describe: `snapshot ${s.id}${s.label ? ` '${s.label}'` : ""}` };
}

export async function mapInfo(
  ctx: ToolContext,
  scope: CallScope,
  since: string | number | undefined,
  detail: "summary" | "full" = "summary"
): Promise<Record<string, unknown>> {
  const summary = await scope.call<Record<string, unknown>>("summary");
  const out: Record<string, unknown> = {
    ...summary,
    origin: ctx.provenanceView(),
    opsSince: ctx.snapshots.provenance.opsSince
  };
  const sk = sinceKey(ctx, since);
  if (sk) {
    out.since = sk.describe;
    if (!sk.key) {
      out.changed = null;
      out.changes = { available: false, reason: "take a snapshot (or make an edit) first" };
    } else {
      const d = await scope.call<{
        available: boolean;
        reason?: string;
        changes?: Record<string, unknown>;
        empty?: boolean;
        truncated?: boolean;
      }>("diff", { key: sk.key, limit: detail === "full" ? 1000 : 50 });
      if (!d.available) {
        out.changed = null;
        out.changes = { available: false, reason: d.reason };
      } else {
        out.changed = !d.empty;
        out.changes = d.changes;
        if (d.truncated) out.changesTruncated = "lists capped; pass detail:'full' for up to 1000 per type";
      }
    }
  }
  await scope.call("setBaseline", { key: "checkpoint" }, { noAlerts: true });
  return out;
}

export function register(ctx: ToolContext): void {
  ctx.tool(
    "map_info",
    {
      title: "Map overview and changes",
      description:
        "Overview of the map in the page: name, seed, graph size, cell count, live entity counts (states, burgs, provinces, cultures, religions, rivers, routes, markers, zones, notes, labels), islands by group and lakes, mapCoordinates, the world settings (mapSize, latitude, longitude, temperatures, winds, precipitation, units, heightExponent) with the names of the locked ones, current view, layers on, provenance and ops since load. Also reports what changed since a baseline: since:'snapshot' (default: newest snapshot or auto-undo point, so right after an edit it shows that edit), 'checkpoint' (the previous map_info call; every call sets a new checkpoint), a snapshot index or label, or 'none'. Changes list added/removed/modified entities with old/new field values and changed-cell counts per cell array.",
      inputSchema: z.object({
        since: z
          .union([z.enum(["snapshot", "checkpoint", "none"]), z.number().int(), z.string()])
          .optional()
          .describe("Baseline: 'snapshot' (default) | 'checkpoint' | snapshot index | snapshot label | 'none'"),
        detail: z
          .enum(["summary", "full"])
          .optional()
          .describe("full lists up to 1000 changed entities per type (default 50)")
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: META_TEXT_HEAVY
    },
    async (args, scope) => mapInfo(ctx, scope, args.since, args.detail)
  );

  ctx.tool(
    "find",
    {
      title: "Find entities",
      description:
        "List and filter entities of one type: burg, state, province, culture, religion, river, route, marker, zone, feature (islands, lakes, oceans), note, label, namesbase. name: exact or case/diacritic-folded matches win, otherwise substring matches; nothing matching gives NOT_FOUND with ranked candidates. where: generic field equality on any entity field ({group:'city'}, {type:'island'}, {capital:true}), arrays mean any-of, <field>Min/<field>Max give numeric bounds (burg population is in people), and entity-valued fields (state, culture, religion, province, burg, capital, base) accept names or ids. near: a Place, with radius in map px; rows then carry distance and sort by it. sort: field name, '-field' for descending, or 'distance'. fields: which fields to return (ref fields add <field>Name). limit default 25 (0 = count only), offset for paging. Rows include i, name, x, y, lat, lon.",
      inputSchema: z.object({
        type: EntityType,
        name: z.string().optional(),
        match: z.enum(["auto", "exact", "contains"]).optional().describe("Name matching (default auto)"),
        where: z
          .record(
            z.string(),
            z.union([
              z.string(),
              z.number(),
              z.boolean(),
              z.null(),
              z.array(z.union([z.string(), z.number(), z.boolean()]))
            ])
          )
          .optional(),
        near: Place.optional(),
        radius: z.number().positive().optional().describe("Map px, with near"),
        sort: z.string().optional(),
        fields: z.array(z.string()).optional(),
        limit: z.number().int().min(0).max(1000).optional(),
        offset: z.number().int().min(0).optional(),
        includeZero: z.boolean().optional().describe("Include Neutrals/Wildlands/No religion (id 0)")
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: META_TEXT_HEAVY
    },
    async (args, scope) => scope.call<Record<string, unknown>>("find", args)
  );

  ctx.tool(
    "inspect",
    {
      title: "Inspect an entity or a place",
      description:
        "Everything about one entity, or about one place. {entity:{type, ref}}: the full object plus relations (a burg's state/province/culture/religion/feature/note/routes and population in people; a state's capital, provinces, neighbours with diplomacy, burg count; a route's length and end burgs; a feature's bbox; ...) and x, y, lat, lon, cell. {at: Place} gives the cell under that place: height and label, land, biome, state, province, culture, religion, burg, river, feature, population, routes, zones, markers. {at:{screen:[px,py], shot:'s3'}} maps a pixel of a returned screenshot (coordinates in the returned image) to the map first.",
      inputSchema: z.object({
        entity: z.object({ type: EntityType, ref: EntityRef }).optional(),
        at: z.union([Place, ScreenPlace]).optional()
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: META_TEXT_HEAVY
    },
    async (args, scope) => {
      if (!args.entity && !args.at) throw new ToolError("BAD_ARGS", "pass entity:{type,ref} or at:Place");
      if (args.at) return scope.call<Record<string, unknown>>("inspect", { at: bridgePlace(ctx, args.at) });
      return scope.call<Record<string, unknown>>("inspect", { entity: args.entity });
    }
  );
}

defineTools("query", register);
