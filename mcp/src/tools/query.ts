// Read tools: map_info, find, inspect.
import { z } from "zod";
import {
  CHANGES_SAMPLE,
  changeTotal,
  compactChanges,
  compactFind,
  compactInspect,
  countChanges,
  cropScreenToMap
} from "../compact.ts";
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

/** map_info's default detail lists up to this many changed entities whole; more are counts plus a sample. */
export const MAP_INFO_FULL_MAX = 25;

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
    const top = u && u.baselineKey === k.key;
    if (top && (WHOLE_MAP_OP.test(u.op) || replacedSince(ctx, k.key)))
      return {
        key: k.key,
        describe: `${u.op} at ${u.at}${WHOLE_MAP_OP.test(u.op) ? "" : " replaced the map"}; no edits since`,
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

/**
 * Does the baseline hold a different map than the page (another epoch: something loaded,
 * generated or restored a different map since)? An entity diff between them compares two
 * unrelated maps and lists nearly everything.
 */
export function replacedSince(ctx: ToolContext, key: string): boolean {
  const then = ctx.snapshots.epochOf(key);
  const now = ctx.snapshots.provenance.epoch;
  return then !== undefined && now !== undefined && then !== now;
}

export async function mapInfo(
  ctx: ToolContext,
  scope: CallScope,
  since: string | number | undefined,
  detail: "summary" | "list" | "full" = "summary",
  diff: "list" | "counts" = "list",
  overview: boolean = diff !== "counts"
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  let summary: Record<string, unknown> | null = null;
  if (overview) {
    summary = await scope.call<Record<string, unknown>>("summary");
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
    } else if (replacedSince(ctx, sk.key) && detail === "summary") {
      // a different map came in since that baseline: say so, with the new map's counts
      summary ??= await scope.call<Record<string, unknown>>("summary", {}, { noAlerts: true });
      out.changed = true;
      out.changes = { mapReplaced: true, counts: summary.counts };
      out.mapReplaced = `a different map replaced the page since ${sk.describe} (load, generate, restore or sketch open); an entity diff would compare two unrelated maps. detail:'list' or 'full' diffs anyway.`;
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
      } else if (detail === "summary") {
        // counts first: a large diff is per-type counts plus the first few of each list
        const total = changeTotal(d.changes);
        out.changed = !d.empty;
        out.changes = d.empty ? {} : compactChanges(d.changes, { fullMax: MAP_INFO_FULL_MAX });
        if (total > MAP_INFO_FULL_MAX)
          out.changesTruncated = `${total} changed entities: per-type counts and the first ${CHANGES_SAMPLE} of each list; detail:'list' lists up to 50 per type, 'full' up to 1000`;
      } else {
        out.changed = !d.empty;
        out.changes = d.changes;
        if (d.truncated) out.changesTruncated = "lists capped; pass detail:'full' for up to 1000 per type";
      }
      if (replacedSince(ctx, sk.key))
        out.mapReplaced = `a different map replaced the page since ${sk.describe}: this diff compares two unrelated maps`;
    }
  }
  await scope.call("setBaseline", { key: "checkpoint" }, { noAlerts: true });
  ctx.snapshots.checkpointEpoch = ctx.snapshots.provenance.epoch;
  return out;
}

const PLACE_HEAD = ["kind", "x", "y", "cell", "lat", "lon", "via"];

/** inspect {fields}: the names that are not a key of the entity or its relations (or of a place). */
export function unknownInspectFields(r: Record<string, unknown>, fields: string[]): string[] {
  const keys = new Set<string>();
  const add = (o: unknown) => {
    if (o && typeof o === "object" && !Array.isArray(o)) for (const k of Object.keys(o)) keys.add(k);
  };
  if (r.kind === "entity") {
    add(r.entity);
    add(r.relations);
    // compact shows relations.people as pop
    if (keys.has("people")) keys.add("pop");
  } else add(r);
  const unknown = fields.filter(f => !keys.has(f) && !PLACE_HEAD.includes(f));
  if (!unknown.length) return [];
  const where = r.kind === "entity" ? `${String(r.type)} ${String(r.i)} (entity or relations)` : "this place";
  return [`no key ${unknown.join(", ")} in ${where}; keys: ${[...keys].slice(0, 60).join(", ")}`];
}

/** inspect {fields} in JSON mode: keep only the named keys of entity and relations (or of a place). */
function pickFields(r: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const keep = new Set(fields);
  const pick = (o: unknown) =>
    o && typeof o === "object" && !Array.isArray(o)
      ? Object.fromEntries(Object.entries(o as Record<string, unknown>).filter(([k]) => keep.has(k)))
      : o;
  if (r.kind === "entity") return { ...r, entity: pick(r.entity), relations: pick(r.relations) };
  return Object.fromEntries(Object.entries(r).filter(([k]) => PLACE_HEAD.includes(k) || keep.has(k)));
}

export function register(ctx: ToolContext): void {
  ctx.tool(
    "map_info",
    {
      title: "Map overview and changes",
      description:
        "Overview of the map in the page: name, seed, graph size, cell count, live entity counts (states, burgs, provinces, cultures, religions, rivers, routes, markers, zones, notes, labels), islands by group and lakes, mapCoordinates, the world settings (mapSize, latitude, longitude, temperatures, winds, precipitation, units, heightExponent) with the names of the locked ones, current view, layers on, provenance and ops since load. Also reports what changed since a baseline: since:'snapshot' (default: newest snapshot or auto-undo point, so right after an edit it shows that edit), 'checkpoint' (the previous map_info call; every call sets a new checkpoint), a snapshot index or label, or 'none'. Changes list added/removed/modified entities with old/new field values and changed-cell counts per cell array; more than 25 changed entities come back as per-type counts plus the first 3 of each list (detail:'list' or 'full' for more), and a baseline from a different map (loaded, generated or restored since) gives {mapReplaced:true, counts} instead of a diff. diff:'counts' returns just {since, changed, changes:{burg:{added, removed, changed}, ..., cells:{h: n}}} without the overview (overview:true adds it back). Right after load_map or generate_map the default diff is empty (the map was replaced, nothing was edited).",
      inputSchema: z.object({
        since: z
          .union([z.enum(["snapshot", "checkpoint", "none"]), z.number().int(), z.string()])
          .optional()
          .describe("Baseline: 'snapshot' (default) | 'checkpoint' | snapshot index | snapshot label | 'none'"),
        detail: z
          .enum(["summary", "list", "full"])
          .optional()
          .describe(
            "summary (default): up to 25 changed entities whole, else per-type counts plus the first 3 of each list; list: up to 50 per type; full: up to 1000 per type. list/full also diff against a baseline from a different map"
          ),
        diff: z
          .enum(["list", "counts"])
          .optional()
          .describe(
            "counts: per entity type {added, removed, changed} (world settings and map fields: {changed, names}) instead of listing each change (default list)"
          ),
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
        "List and filter entities of one type: burg, state, province, culture, religion, river, route, routeGroup (ids are strings such as 'route-tunnels'), marker, zone, feature (islands, lakes, oceans), note, label, namesbase, biome (rows: color, habitability, iconsDensity, cost, cells, custom; inspect shows icons). name: exact or case/diacritic-folded matches win, otherwise substring matches; nothing matching gives NOT_FOUND with ranked candidates. where: generic field equality on any entity field ({group:'city'}, {type:'island'}, {capital:true}), arrays mean any-of, <field>Min/<field>Max give numeric bounds (burg population is in people), and entity-valued fields (state, culture, religion, province, burg, capital, base) accept names or ids. near: a Place, with radius in map px; rows then carry distance and sort by it. sort: field name, '-field' for descending, or 'distance'. fields: which fields to return (ref fields add <field>Name). limit default 25 (0 = count only), offset for paging. Rows include i, name, x, y, lat, lon. format:'compact': plain text, about half the size: a header, one line per row (burg 12 Agamathel pop=61419 state=3 capital at=(812,440); true flags are bare, false/null/empty left out, lat/lon only when named in fields, HTML reduced to text, strings cut at 80 chars unless named in fields), a names: legend for id fields, an 'empty in every row' line for requested fields nothing has, and a +N more line.",
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
      const warnings = args.fields?.length ? unknownInspectFields(r, args.fields) : [];
      if (args.format === "compact")
        return new WithText([compactInspect(r, args.fields), ...warnings.map(w => `warning: ${w}`)].join("\n"));
      const out = args.fields?.length ? pickFields(r, args.fields) : r;
      return warnings.length ? { ...out, warnings } : out;
    }
  );
}

defineTools("query", register);
