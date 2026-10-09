// edit, add, paint_cells: batched map mutations. Each validates every op in the page first
// (nothing changes when validation fails), then takes one auto-undo entry, applies the ops and
// coalesces the redraws. dryRun stops after validation and returns the plan.
import { z } from "zod";
import { CHANGES_FULL_MAX, compactChanges } from "../compact.ts";
import type { CallScope, ToolContext } from "../context.ts";
import {
  type AddResolved,
  type EditResolved,
  type Resolved,
  summarizeOp,
  takeResolved,
  unreplayableReason
} from "../ops.ts";
import { META_TEXT_HEAVY, ToolError } from "../result.ts";
import { ENTITY_TYPES, EntityRef, EntityTarget, Place, RedrawLayer, TIMEOUTS, TimeoutMs } from "../schemas.ts";
import { defineTools } from "./registry.ts";

interface ErrRow {
  index?: number;
  ref?: unknown;
  code: string;
  message: string;
  candidates?: unknown[];
  details?: unknown;
}

interface ValidateResult {
  phase: "validate";
  errors?: ErrRow[];
  [k: string]: unknown;
}

interface ApplyResult {
  errors?: ErrRow[];
  aborted?: ErrRow | null;
  [k: string]: unknown;
}

export const Redraw = z
  .union([z.literal(false), z.array(RedrawLayer)])
  .optional()
  .describe("Override the computed redraw: false = redraw nothing, or the exact layers to redraw");

/**
 * Diff of the page against the undo point this call just pushed. Small diffs are listed in full;
 * a large one (more than CHANGES_FULL_MAX changed entities) comes back as exact per-type counts
 * plus the first few entries (compactChanges), so a 200-burg batch does not echo 200 changes.
 * map_info lists the rest (same baseline).
 */
export async function changesSinceUndo(ctx: ToolContext, scope: CallScope, limit = CHANGES_FULL_MAX): Promise<unknown> {
  const entry = ctx.snapshots.undoStack[ctx.snapshots.undoStack.length - 1];
  if (!entry) return undefined;
  // the call replaced the map (another epoch): a diff would list the whole old map against the new
  if (entry.provenance.epoch !== ctx.snapshots.provenance.epoch) return { mapReplaced: true };
  try {
    const d = await scope.call<{ available: boolean; changes?: unknown; empty?: boolean; truncated?: boolean }>(
      "diff",
      { key: entry.baselineKey, limit },
      { noAlerts: true }
    );
    if (!d.available) return undefined;
    return d.empty ? {} : compactChanges(d.changes as Record<string, unknown> | undefined);
  } catch {
    return undefined;
  }
}

function rowLabel(e: ErrRow): string {
  return e.index !== undefined ? `item ${e.index}: ` : "";
}

/**
 * validate -> (dryRun? plan) -> pushUndo -> apply -> diff. Shared by edit/add/paint_cells.
 * `fn` is the bridge function; `bridgeArgs` excludes phase.
 */
export async function runPhased(
  ctx: ToolContext,
  scope: CallScope,
  op: string,
  toolArgs: Record<string, unknown>,
  fn: string,
  bridgeArgs: Record<string, unknown>,
  opts: { dryRun?: boolean; continueOnError?: boolean; timeoutMs?: number; rows?: "full" | "ids" }
): Promise<Record<string, unknown>> {
  const timeoutMs = opts.timeoutMs ?? TIMEOUTS.edit;
  const plan = await scope.call<ValidateResult>(fn, { ...bridgeArgs, phase: "validate" }, { timeoutMs });
  const errors = plan.errors ?? [];
  if (errors.length && !opts.continueOnError) {
    const first = errors[0];
    const more = errors.length > 1 ? ` (+${errors.length - 1} more invalid; see details.errors)` : "";
    throw new ToolError(first.code, `${rowLabel(first)}${first.message}${more}. Nothing was changed.`, {
      candidates: first.candidates,
      details: { errors }
    });
  }
  const { phase: _phase, ...planBody } = plan;
  if (opts.dryRun) return { dryRun: true, ...planBody, note: "dry run: nothing was changed" };
  if (typeof plan.valid === "number" && plan.valid === 0) {
    throw new ToolError("BAD_ARGS", "no valid ops to apply. Nothing was changed.", { details: { errors } });
  }
  await scope.pushUndo(op, toolArgs);
  let out: ApplyResult;
  try {
    out = await scope.call<ApplyResult>(fn, { ...bridgeArgs, phase: "apply" }, { mutating: true, timeoutMs });
  } catch (e) {
    ctx.snapshots.noteMutation();
    if (e instanceof ToolError)
      e.message += " Part of the call may have been applied; snapshot {action:'undo'} reverts the whole call.";
    throw e;
  }
  ctx.snapshots.noteMutation();
  const rd = bridgeArgs.redraw;
  ctx.lastRedraw = {
    tool: op,
    at: Date.now(),
    ops: ctx.snapshots.provenance.opsSince,
    redrawn: Array.isArray(out.redrawn) ? (out.redrawn as string[]) : [],
    skippedHidden: Array.isArray(out.skippedHidden) ? (out.skippedHidden as string[]) : [],
    suppressed: rd === false || (Array.isArray(rd) && rd.length === 0)
  };
  // the sketch log gets the concrete form of what was applied (also for an aborted batch: the
  // ops before the failing one were applied)
  const resolved = takeResolved(out as Record<string, unknown>);
  const notReplayable = resolved ? unreplayableReason(scope.tool, resolved) : null;
  if (resolved && notReplayable)
    // e.g. a height rebuild: logged (it makes the sketch blob-only), but never replayed
    await scope.record(scope.tool, toolArgs, null, {
      replayable: false,
      reason: notReplayable,
      summary: summarizeOp(scope.tool, resolved, out as Record<string, unknown>, toolArgs)
    });
  else if (resolved && !isEmptyResolved(resolved))
    await scope.record(scope.tool, toolArgs, resolved, { out: out as Record<string, unknown> });
  else
    await scope.record(scope.tool, toolArgs, null, {
      replayable: true,
      noop: true,
      summary: `${scope.tool} applied nothing (no-op).`
    });
  if (out.aborted) {
    const a = out.aborted;
    throw new ToolError(
      a.code,
      `${rowLabel(a)}${a.message}. The ops before it were applied; snapshot {action:'undo'} reverts the whole call (or pass continueOnError:true to skip failing ops).`,
      { candidates: a.candidates, details: { result: out } }
    );
  }
  const { aborted: _aborted, ...rest } = out;
  const result: Record<string, unknown> = { ...rest };
  // the apply phase re-validates, so out.errors already holds the skipped invalid ops
  if (!out.errors?.length) delete result.errors;
  if (opts.rows === "ids") idsOnly(result);
  const changes = await changesSinceUndo(ctx, scope);
  if (changes !== undefined) result.changes = changes;
  result.undo = "snapshot {action:'undo'} reverts this whole call";
  return result;
}

/** rows:'ids': the per-op `applied` rows and the `created` rows become lists of ids. */
function idsOnly(result: Record<string, unknown>): void {
  const ids = (rows: unknown[]) =>
    rows.map(r => {
      const row = r as { i?: unknown; index?: unknown };
      return row.i ?? row.index ?? null;
    });
  if (Array.isArray(result.applied)) {
    result.appliedIds = ids(result.applied);
    delete result.applied;
  }
  if (Array.isArray(result.created)) {
    result.createdIds = ids(result.created);
    delete result.created;
  }
}

function isEmptyResolved(r: Resolved): boolean {
  // a map edit with no rows but a recalculation (the recalculate-only call) still did something
  if ("ops" in r) return !(r as EditResolved).ops.length && !(r as EditResolved).recalculate;
  if ("items" in r) return !(r as AddResolved).items.length;
  return false;
}

const EDIT_TYPES = [...ENTITY_TYPES.filter(t => t !== "namesbase"), "map"] as const;
const ADD_TYPES = [
  "burg",
  "state",
  "marker",
  "route",
  "routeGroup",
  "zone",
  "label",
  "note",
  "culture",
  "religion",
  "biome",
  "province",
  "river"
] as const;

const Common = {
  dryRun: z.boolean().optional().describe("Validate and return the plan (before/after) without changing anything"),
  continueOnError: z
    .boolean()
    .optional()
    .describe("Apply the valid ops and report the invalid ones instead of refusing the whole call"),
  redraw: Redraw,
  timeoutMs: TimeoutMs,
  rows: z
    .enum(["full", "ids"])
    .optional()
    .describe(
      "ids: answer with the ids only (appliedIds / createdIds) instead of one row per op (applied / created with before/after); far smaller for big batches"
    )
};

const SelectShape = {
  cells: z.array(z.number().int().min(0)).optional().describe("Pack cell ids"),
  circle: z
    .looseObject({
      at: Place,
      radius: z.number().positive(),
      unit: z.enum(["px", "km", "mi"]).optional().describe("Radius unit (default px; km/mi use the map scale)")
    })
    .optional(),
  polygon: z.array(Place).min(3).optional().describe("Polygon vertices (places)"),
  entity: EntityTarget.optional().describe("Cells of a state/province/culture/religion/feature/zone/river"),
  buffer: z
    .number()
    .min(-5000)
    .max(5000)
    .optional()
    .describe(
      "Map px: > 0 grows the union of cells/circle/polygon/entity by every cell whose centre lies within that distance of it (a polygon or territory offset outward); < 0 shrinks it. Applied before where and except"
    ),
  where: z
    .looseObject({
      land: z.boolean().optional(),
      water: z.boolean().optional(),
      hMin: z.number().optional(),
      hMax: z.number().optional(),
      biome: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]).optional(),
      state: z.union([EntityRef, z.array(EntityRef)]).optional(),
      province: z.union([EntityRef, z.array(EntityRef)]).optional(),
      culture: z.union([EntityRef, z.array(EntityRef)]).optional(),
      religion: z.union([EntityRef, z.array(EntityRef)]).optional(),
      feature: z.union([EntityRef, z.array(EntityRef)]).optional(),
      burg: z.boolean().optional(),
      river: z.boolean().optional()
    })
    .optional()
    .describe("Filter; alone it scans every cell. An unknown key is BAD_FIELD (never ignored)")
};

export const SelectSchema = z
  .looseObject({
    ...SelectShape,
    except: z
      .looseObject(SelectShape)
      .optional()
      .describe(
        "A selection of its own (same keys; may nest except) whose cells are left out, e.g. {where:{biome:'Glacier'}} for 'not Glacier' or {circle:{...}} for 'polygon minus circle'"
      )
  })
  .describe(
    "Cells: union of cells/circle/polygon/entity, grown by buffer, filtered by where, minus except. Unknown keys are BAD_FIELD"
  );

export function register(ctx: ToolContext): void {
  ctx.tool(
    "edit",
    {
      title: "Edit or remove entities",
      description:
        "Batch-edit entities of ONE type: ops [{ref, set:{field: value}} | {ref, remove:true}]. All ops are validated first; if any is invalid nothing changes (unless continueOnError). One auto-undo entry covers the call; redraws are coalesced. dryRun:true returns before/after per op. Fields per type are in tupaia://docs/cheatsheet.md, e.g. burg {name, population (people), group, type, culture, port, lock, move:Place}; state {name, fullName, form, formName, color, capital:burgRef, culture, lock}; marker {type, icon, size, pinned, note:{name, legend}, move}; label {text, move}; route {group, name, lock, points}; routeGroup {id (rename), name, stroke, width, dash, linecap, opacity, after|before}; river {name, type, mainStem, split, merge, reroute, end, joinAt}; biome {name, color, habitability, iconsDensity, icons, cost}; map (no ref) {name, populationRate, urbanization, year, era, reliefOnLoad} plus world settings (mapSize, latitude, longitude, temperatures, winds, precipitation, units: a value or {value, lock}; ops may lock/unlock; recalculate refreshes derived data, then ops may be omitted; the result lists stale layers). River structure, route points, biome values, world settings and reliefOnLoad: see ops.set. name can be {generate:{base:<namesbase>}} | {generate:{culture:<ref>}} | {generate:{}} (own culture). A state's capital changes only through edit state {capital}. remove works for burg, state, province, culture, religion, marker, route, river, zone, note, label, routeGroup (as in the editors it ignores lock; bulk with locks honoured: the clear tool). A capital or a market centre is refused unless force:true (per op, or edit {force:true} for all ops; see ops.force); a routeGroup only when empty, or with force:true (its routes move to moveTo, default 'roads'; roads/trails/searoutes stay). orphanRoutes:true also removes routes that served only removed burgs. Removing burgs or routes repairs the route links once per call (routeLinksFixed).",
      inputSchema: z.object({
        type: z.enum(EDIT_TYPES),
        ops: z
          .array(
            z.object({
              ref: EntityRef.optional().describe("Entity ref (omit for type 'map')"),
              set: z
                .record(z.string(), z.unknown())
                .optional()
                .describe(
                  "Fields to set. route points:[Place | [x,y,cell]...] replaces the path (links rebuilt; add lock:true to keep an edited generated route on regenerate); route group: a group id or name. routeGroup id renames the group (its routes follow). river: one structural change per op: mainStem:<tributary> (its upper course becomes this river's), split:{at, name?, type?} (the upper part becomes a new river, in created), merge:true (inverse of split), reroute:{cells:[...]} | {from, to:Place|'edge', through?, snap?, edge?} (a stretch, a new mouth/confluence/edge, or a new source; no crossings, climbs warned; a path that changes nothing is a no-op success with a note), end:{at:Place|cell} (the river stops at that course cell, dropping the cells below, or joins a neighbouring river/water cell there; a land end with no river or water is loose: reroute another river through it in a later op), joinAt:{river?:ref (default its parent), at:Place|cell} (re-route its lower course from the nearest course cell to that confluence cell); ops apply in order. biome: color any CSS colour (stored as #rrggbb), habitability 0-9999 (re-ranks that biome's cells), iconsDensity 0-500 (> 0 needs icons), icons {iconName: weight} | [iconName], cost 0-10000. map reliefOnLoad:true: saves drop the relief icons and loads redraw them (seeded). map world settings: mapSize (% of the world), latitude/longitude (shift 0..100), temperatureEquator/NorthPole/SouthPole (degrees Celsius), winds (6 tier angles north to south, or {tier: degrees}), precipitation (%), distanceScale, distanceUnit, areaUnit, heightUnit, heightExponent, temperatureScale; year is a whole number. A setting takes a value or {value, lock:true|false} (the app's own lock(): generate_map and the options panel keep the value; locks travel in the .map text, so undo, restore, relaunch and save/load keep them). Settings only set inputs: see recalculate"
                ),
              remove: z
                .boolean()
                .optional()
                .describe(
                  "Remove the entity. A province's cells become province-less; a culture's cells, burgs, states and religions fall back to culture 0 (Wildlands); a religion's cells to No religion; a state's provinces go with it"
                ),
              lock: z
                .union([z.literal("all"), z.array(z.string())])
                .optional()
                .describe("type 'map': setting names to lock (['all'] or 'all' = every setting)"),
              unlock: z
                .union([z.literal("all"), z.array(z.string())])
                .optional()
                .describe("type 'map': setting names to unlock (['all'] or 'all' = every setting)"),
              force: z
                .boolean()
                .optional()
                .describe(
                  "burg remove: also remove a state capital or a market centre (dependants are reassigned), and locked orphan routes; routeGroup remove: move its routes to moveTo (default 'roads') instead of refusing"
                ),
              moveTo: EntityRef.optional().describe("routeGroup remove with force: the group the routes move to"),
              newCapital: EntityRef.optional().describe("burg remove with force: the burg that becomes the capital"),
              orphanRoutes: z
                .boolean()
                .optional()
                .describe(
                  "burg remove: also remove routes that served only removed burgs (locked ones only with force)"
                )
            })
          )
          .max(500)
          .optional()
          .describe("Required (1+ ops), except type 'map' with recalculate: then omit it to only recalculate"),
        force: z.boolean().optional().describe("type burg or routeGroup: force:true for every remove op"),
        recalculate: z
          .enum(["none", "climate", "biomes", "rivers+biomes", "climate+biomes"])
          .optional()
          .describe(
            "type 'map': refresh derived data after settings changed (default none). climate = temperature + precipitation; biomes = biome cells only; rivers+biomes = rivers, lake data, biomes; climate+biomes = all. Rivers (ids, names, edits) and hand-painted biome cells are replaced; lake names and custom-biome cells are kept. dryRun reports the counts"
          ),
        ...Common
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: META_TEXT_HEAVY,
      kind: "edit"
    },
    async (args, scope) => {
      const { dryRun, timeoutMs, rows, ...rest } = args;
      const continueOnError = args.continueOnError;
      const recalculates = args.recalculate !== undefined && args.recalculate !== "none";
      if (!args.ops?.length && !(args.type === "map" && recalculates))
        throw new ToolError("BAD_ARGS", "ops must hold at least one op (only type 'map' with recalculate may omit it)");
      const result = await runPhased(ctx, scope, `edit ${args.type}`, args, "edit", rest, {
        dryRun,
        continueOnError,
        timeoutMs: timeoutMs ?? (recalculates ? TIMEOUTS.heavy : undefined),
        rows
      });
      // settings are already in `applied` (before/after), and a climate recalculation renumbers rivers:
      // a map edit reports counts only
      const diff = result.changes as Record<string, unknown> | undefined;
      if (args.type === "map" && diff && typeof diff === "object") {
        const counts: Record<string, unknown> = {};
        for (const [type, d] of Object.entries(diff))
          if (type !== "settings" && type !== "map") counts[type] = (d as { counts?: unknown } | null)?.counts ?? d;
        if (Object.keys(counts).length) result.changes = counts;
        else delete result.changes;
      }
      return result;
    }
  );

  ctx.tool(
    "add",
    {
      title: "Add entities",
      description:
        "Create entities of ONE type: items [...]. Validated first (nothing changes on an invalid item unless continueOnError); one auto-undo entry; dryRun:true returns the plan. Item shapes: burg {at:Place, name?, population?, group?, type?, culture?, port?}; state {capital: Place | {burg:ref}, name?, color?, culture?, form?, formName?, expand?} (expand:true re-expands all unlocked states and regenerates provinces); marker {at, type?, icon?, size?, pinned?, note?:{name, legend}}; route {through:[Place, Place, ...], group?:'roads'|'trails'|'searoutes'|<custom group>, name?} (pathfinds; NO_PATH explains why, e.g. different landmasses) or {points:[Place...], noPathfind:true, group?, name?, lock?} (freehand: exactly those points, see items); routeGroup {id:'route-...', name?, stroke?, width?, dash?, linecap?, opacity?, after?|before?} (a new group under #routes; usable as group by add/edit route); zone {name?, type?, color?, cells?|select?}; label {at, text, group?}; note {id | entity:{type,ref}, name, legend?}; culture {at, name?, color?, type?, base?, expansionism?, expand?}; religion {at, name?, color?, type?, form?, deity?, expansionism?, expand?}; biome {name, base?:<biome to copy>, color?, habitability?, iconsDensity?, icons?, cost?} (appended as a new id; defaults: see items); province {centre:{burg:ref} | Place, state?, name?, formName?, fullName?, color?, cells?|select?} (cells default: those of the state nearer its centre than other provinces' centres); river {points:[Place...] | cells:[...], name?, type?, parent?:ref} (a course ending in water, on a river or off the edge; see items). name can be {generate:{base}|{culture}|{}}.",
      inputSchema: z.object({
        type: z.enum(ADD_TYPES),
        items: z
          .array(z.record(z.string(), z.unknown()))
          .min(1)
          .max(200)
          .describe(
            "Items of the one type. Freehand route {points, noPathfind:true}: exactly those points, may cross water, locked by default so regenerating routes keeps it; a point may be [x, y, cell] to pin its cell; one cell-to-cell link per consecutive pair, the last route through a pair owns it. routeGroup: drawn last unless after/before. biome without base: habitability 50, iconsDensity 0, no icons, cost 50, random colour. province: centre {burg} is its capital (a Place with a burg makes that burg the capital); state defaults to the centre's; never takes another province's centre or capital cell; cells must all be land of the state (select is clipped to it); without either it takes the state's cells nearer (by elevation cost) its centre than any other unlocked province's centre; name defaults to the capital's (else generated), formName to the form of the province the centre was in, colour and emblem as the generator. river: cells is a literal contiguous course (source first) ending in a water cell, on another river's course (a confluence; on parent's when given) or -1 after a border cell; points are joined by the cheapest land path (uphill costs more) that avoids water and other rivers, the last may be off the map or 'edge' (runs off the nearest edge), and a last place on plain land is extended to the nearest water or river (parent's course when given), noted; at least 3 cells. Flux, discharge, width, the confluence and downstream discharge follow; name defaults to the generator's (mouth culture), type to the generator's. List main rivers before their tributaries"
          ),
        ...Common
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: META_TEXT_HEAVY,
      kind: "edit"
    },
    async (args, scope) => {
      const { dryRun, timeoutMs, rows, ...rest } = args;
      const continueOnError = args.continueOnError;
      return runPhased(ctx, scope, `add ${args.type}`, args, "add", rest, {
        dryRun,
        continueOnError,
        timeoutMs,
        rows
      });
    }
  );

  ctx.tool(
    "paint_cells",
    {
      title: "Paint cells",
      description:
        "Assign cells to a state/province/culture/religion/biome/zone, or change their height. select picks cells (union of cells, circle {at, radius, unit?}, polygon [Place...], entity {type,ref}; grown by buffer px; filtered by where {land, water, hMin, hMax, biome, state, ...}; minus except:<select>). Unknown keys in select, where or set are BAD_FIELD. Painting skips water cells and never moves a state's or province's centre cell or a capital; provinces are re-fitted after state painting. height {value|delta|smooth, rebuild, biomes?}: rebuild 'keep' (default) changes land heights only (20..100), refuses any change that crosses height 20 and is local: the changed cells' temperature, lake levels and biome (biomes:'keep' keeps it) follow; rivers, other cells and the economy stay (result local: rivers through the cells that now climb); 'risk' rebuilds the coastline, lakes, rivers and climate while keeping burgs, states and other data (cell ids change; erosion:true also re-runs river erosion); 'erase' regenerates every entity and needs confirmErase:true. Paint height in its own call. feather {width, unit?:'px'|'cells', seed?} (with set:{biome} only) dithers the edge: cells within width/2 of the selection boundary are painted with a probability falling from 1 inside to 0 outside (blobby noise plus jitter, deterministic per seed), so biome edges fray instead of following the selection; the result reports feather {width px, seed, shape: cells selected, band: cells within width/2 of the boundary, addedOutside / droppedInside: band cells painted outside / left unpainted inside the selection, cells: painted}; the op is logged as the literal cells painted. dryRun:true counts what would change. One auto-undo entry.",
      inputSchema: z.object({
        select: SelectSchema,
        set: z.looseObject({
          state: EntityRef.optional(),
          province: EntityRef.optional(),
          culture: EntityRef.optional(),
          religion: EntityRef.optional(),
          biome: z.union([z.string(), z.number().int()]).optional().describe("Biome name or id"),
          zone: z
            .union([EntityRef, z.object({ ref: EntityRef, op: z.enum(["add", "remove"]).optional() })])
            .optional()
            .describe("Zone ref (adds cells) or {ref, op:'add'|'remove'}"),
          height: z
            .looseObject({
              value: z.number().min(0).max(100).optional(),
              delta: z.number().min(-100).max(100).optional(),
              smooth: z.number().int().min(1).max(10).optional().describe("Smoothing passes"),
              rebuild: z.enum(["keep", "risk", "erase"]).optional(),
              clamp: z.boolean().optional().describe("keep mode: stop land at 20 instead of refusing"),
              erosion: z.boolean().optional().describe("risk mode: re-run river erosion (default false)"),
              confirmErase: z.boolean().optional(),
              biomes: z
                .enum(["redefine", "keep"])
                .optional()
                .describe(
                  "keep mode: 'redefine' (default) the changed cells' biomes from their new climate, or 'keep' them"
                )
            })
            .optional()
        }),
        feather: z
          .strictObject({
            width: z.number().positive().max(5000).describe("Width of the frayed band across the boundary"),
            unit: z.enum(["px", "cells"]).optional().describe("px (default) or cells (mean cell spacing)"),
            seed: z
              .union([z.number().int(), z.string().min(1)])
              .optional()
              .describe("Dither seed (default: derived from the selection)")
          })
          .optional()
          .describe("Soft-edged biome painting (set:{biome} only)"),
        dryRun: Common.dryRun,
        redraw: Redraw,
        timeoutMs: TimeoutMs
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: META_TEXT_HEAVY,
      kind: "heavy"
    },
    async (args, scope) => {
      const { dryRun, timeoutMs, ...rest } = args;
      const rebuild = args.set.height?.rebuild;
      const heavy = rebuild !== undefined && rebuild !== "keep";
      return runPhased(ctx, scope, "paint_cells", args, "paint", rest, {
        dryRun,
        timeoutMs: timeoutMs ?? (heavy ? TIMEOUTS.heavy : TIMEOUTS.edit)
      });
    }
  );
}

defineTools("edit", register);
