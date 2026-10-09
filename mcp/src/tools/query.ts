// Read tools: map_info, find, inspect.
import { z } from "zod";
import { compactFind, compactInspect, countChanges, cropScreenToMap } from "../compact.ts";
import type { CallScope, ShotRecord, ToolContext } from "../context.ts";
import { META_TEXT_HEAVY, ToolError, WithText } from "../result.ts";
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

/**
 * Convert {screen, shot} into the bridge's {screen, view} place; other places pass through. A
 * crop-mode shot (screenshot crop:'changed') returned only part of its PNG, so its pixels are
 * mapped here, through the crop box, to a plain {x, y} place.
 */
export function bridgePlace(ctx: ToolContext, p: unknown): unknown {
  if (p && typeof p === "object" && "screen" in p && "shot" in p) {
    const sp = p as { screen: [number, number]; shot: string };
    const rec = ctx.shots.get(sp.shot);
    if (rec.crop) {
      const [x, y] = cropScreenToMap(Number(sp.screen[0]), Number(sp.screen[1]), rec);
      return { x, y };
    }
    return { screen: sp.screen, view: shotView(rec) };
  }
  return p;
}

/** Undo points that replace the whole map: diffing against one lists every entity as changed. */
const WHOLE_MAP_OP = /^(load_map|generate_map|shared_restore|sketch open)/;

interface Since {
  key: string;
  describe: string;
  /** The newest baseline is a whole-map load or generate and nothing happened since: no diff to show. */
  fresh?: boolean;
}

/** Resolve map_info's `since` to a baseline key. */
function sinceKey(ctx: ToolContext, since: string | number | undefined): Since | null {
  if (since === "none") return null;
  if (since === undefined || since === "snapshot") {
    const k = ctx.snapshots.latestBaselineKey();
    if (!k) return { key: "", describe: "no snapshot or undo point yet" };
    const u = ctx.snapshots.undoStack[ctx.snapshots.undoStack.length - 1];
    if (u && u.baselineKey === k.key && WHOLE_MAP_OP.test(u.op))
      return {
        key: k.key,
        describe: `${u.op} at ${u.at}; no edits since`,
        fresh: true
      };
    return k;
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
  detail: "summary" | "full" = "summary",
  diff: "list" | "counts" = "list",
  overview: boolean = diff !== "counts"
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (overview) {
    const summary = await scope.call<Record<string, unknown>>("summary");
    Object.assign(out, summary, { origin: ctx.provenanceView(), opsSince: ctx.snapshots.provenance.opsSince });
  } else out.opsSince = ctx.snapshots.provenance.opsSince;
  const sk = sinceKey(ctx, since);
  if (sk) {
    out.since = sk.describe;
    if (sk.fresh) {
      out.changed = false;
      out.changes = {};
    } else if (!sk.key) {
      out.changed = null;
      out.changes = { available: false, reason: "take a snapshot (or make an edit) first" };
    } else {
      const d = await scope.call<{
        available: boolean;
        reason?: string;
        changes?: Record<string, unknown>;
        empty?: boolean;
        truncated?: boolean;
      }>("diff", { key: sk.key, limit: diff === "counts" ? 1 : detail === "full" ? 1000 : 50 });
      if (!d.available) {
        out.changed = null;
        out.changes = { available: false, reason: d.reason };
      } else if (diff === "counts") {
        // counts are exact whatever the list cap was; nothing to truncate
        out.changed = !d.empty;
        out.changes = countChanges(d.changes);
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

/** inspect {fields} in JSON mode: keep only the named keys of entity and relations (or of a place). */
function pickFields(r: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const keep = new Set(fields);
  const pick = (o: unknown) =>
    o && typeof o === "object" && !Array.isArray(o)
      ? Object.fromEntries(Object.entries(o as Record<string, unknown>).filter(([k]) => keep.has(k)))
      : o;
  if (r.kind === "entity") return { ...r, entity: pick(r.entity), relations: pick(r.relations) };
  const head = ["kind", "x", "y", "cell", "lat", "lon", "via"];
  return Object.fromEntries(Object.entries(r).filter(([k]) => head.includes(k) || keep.has(k)));
}

export function register(ctx: ToolContext): void {
  ctx.tool(
    "map_info",
    {
      title: "Map overview and changes",
      description:
        "Overview of the map in the page: name, seed, graph size, cell count, live entity counts (states, burgs, provinces, cultures, religions, rivers, routes, markers, zones, notes, labels), islands by group and lakes, mapCoordinates, the world settings (mapSize, latitude, longitude, temperatures, winds, precipitation, units, heightExponent) with the names of the locked ones, current view, layers on, provenance and ops since load. Also reports what changed since a baseline: since:'snapshot' (default: newest snapshot or auto-undo point, so right after an edit it shows that edit), 'checkpoint' (the previous map_info call; every call sets a new checkpoint), a snapshot index or label, or 'none'. Changes list added/removed/modified entities with old/new field values and changed-cell counts per cell array. diff:'counts' returns just {since, changed, changes:{burg:{added, removed, changed}, ..., cells:{h: n}}} without the overview (overview:true adds it back). Right after load_map or generate_map the default diff is empty (the map was replaced, nothing was edited).",
      inputSchema: z.object({
        since: z
          .union([z.enum(["snapshot", "checkpoint", "none"]), z.number().int(), z.string()])
          .optional()
          .describe("Baseline: 'snapshot' (default) | 'checkpoint' | snapshot index | snapshot label | 'none'"),
        detail: z
          .enum(["summary", "full"])
          .optional()
          .describe("full lists up to 1000 changed entities per type (default 50)"),
        diff: z
          .enum(["list", "counts"])
          .optional()
          .describe("counts: per entity type {added, removed, changed} instead of listing each change (default list)"),
        overview: z
          .boolean()
          .optional()
          .describe(
            "Include the map overview (default true; false with diff:'counts', which then returns only the diff)"
          )
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: META_TEXT_HEAVY
    },
    async (args, scope) => mapInfo(ctx, scope, args.since, args.detail, args.diff, args.overview)
  );

  ctx.tool(
    "find",
    {
      title: "Find entities",
      description:
        "List and filter entities of one type: burg, state, province, culture, religion, river, route, marker, zone, feature (islands, lakes, oceans), note, label, namesbase. name: exact or case/diacritic-folded matches win, otherwise substring matches; nothing matching gives NOT_FOUND with ranked candidates. where: generic field equality on any entity field ({group:'city'}, {type:'island'}, {capital:true}), arrays mean any-of, <field>Min/<field>Max give numeric bounds (burg population is in people), and entity-valued fields (state, culture, religion, province, burg, capital, base) accept names or ids. near: a Place, with radius in map px; rows then carry distance and sort by it. sort: field name, '-field' for descending, or 'distance'. fields: which fields to return (ref fields add <field>Name). limit default 25 (0 = count only), offset for paging. Rows include i, name, x, y, lat, lon. format:'compact': plain text, about half the size: a header, one line per row (burg 12 Agamathel pop=61419 state=3 capital at=(812,440); true flags are bare, false/null/empty left out, lat/lon only when named in fields, HTML reduced to text, strings cut at 80 chars unless named in fields), a names: legend for id fields, an 'empty in every row' line for requested fields nothing has, and a +N more line.",
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
        includeZero: z.boolean().optional().describe("Include Neutrals/Wildlands/No religion (id 0)"),
        format: z
          .enum(["json", "compact"])
          .optional()
          .describe("compact: plain-text lines instead of JSON rows (default json)")
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: META_TEXT_HEAVY
    },
    async (args, scope) => {
      const { format, ...bridgeArgs } = args;
      const r = await scope.call<Record<string, unknown>>("find", bridgeArgs);
      return format === "compact" ? new WithText(compactFind(r, args.fields)) : r;
    }
  );

  ctx.tool(
    "inspect",
    {
      title: "Inspect an entity or a place",
      description:
        "Everything about one entity, or about one place. {entity:{type, ref}}: the full object plus relations (a burg's state/province/culture/religion/feature/note/routes and population in people; a state's capital, provinces, neighbours with diplomacy, burg count; a route's length and end burgs; a feature's bbox; ...) and x, y, lat, lon, cell. {at: Place} gives the cell under that place: height and label, land, biome, state, province, culture, religion, burg, river, feature, population, routes, zones, markers. {at:{screen:[px,py], shot:'s3'}} maps a pixel of a returned screenshot (coordinates in the returned image) to the map first. format:'compact': key=value lines in [entity] and [relations] sections (refs as 3 (Name), nested data as its shape: coa={t1,division}, production=[50 items]; a value [relations] restates is shown once; pop is people, as in find), about a fifth of the JSON; strings are cut at 80 chars unless named in fields (inspect a note with fields:['legend'] to read it whole). fields limits the entity/relation keys (JSON: entity population is thousands, relations.people is people).",
      inputSchema: z.object({
        entity: z.object({ type: EntityType, ref: EntityRef }).optional(),
        at: z.union([Place, ScreenPlace]).optional(),
        format: z
          .enum(["json", "compact"])
          .optional()
          .describe("compact: key=value lines instead of JSON (default json)"),
        fields: z
          .array(z.string())
          .optional()
          .describe("Entity/relation keys to keep (all by default); for a place, the attributes to keep")
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: META_TEXT_HEAVY
    },
    async (args, scope) => {
      if (!args.entity && !args.at) throw new ToolError("BAD_ARGS", "pass entity:{type,ref} or at:Place");
      const r = args.at
        ? await scope.call<Record<string, unknown>>("inspect", { at: bridgePlace(ctx, args.at) })
        : await scope.call<Record<string, unknown>>("inspect", { entity: args.entity });
      if (args.format === "compact") return new WithText(compactInspect(r, args.fields));
      return args.fields?.length ? pickFields(r, args.fields) : r;
    }
  );
}

defineTools("query", register);
