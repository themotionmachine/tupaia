// edit, add, paint_cells: batched map mutations. Each validates every op in the page first
// (nothing changes when validation fails), then takes one auto-undo entry, applies the ops and
// coalesces the redraws. dryRun stops after validation and returns the plan.
import { z } from "zod";
import type { CallScope, ToolContext } from "../context.ts";
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

/** Diff of the page against the undo point this call just pushed. */
export async function changesSinceUndo(ctx: ToolContext, scope: CallScope, limit = 20): Promise<unknown> {
  const entry = ctx.snapshots.undoStack[ctx.snapshots.undoStack.length - 1];
  if (!entry) return undefined;
  try {
    const d = await scope.call<{ available: boolean; changes?: unknown; empty?: boolean; truncated?: boolean }>(
      "diff",
      { key: entry.baselineKey, limit },
      { noAlerts: true }
    );
    if (!d.available) return undefined;
    return d.empty ? {} : d.changes;
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
  opts: { dryRun?: boolean; continueOnError?: boolean; timeoutMs?: number }
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
  const changes = await changesSinceUndo(ctx, scope);
  if (changes !== undefined) result.changes = changes;
  result.undo = "snapshot {action:'undo'} reverts this whole call";
  return result;
}

const EDIT_TYPES = [...ENTITY_TYPES.filter(t => t !== "namesbase"), "map"] as const;
const ADD_TYPES = ["burg", "state", "marker", "route", "zone", "label", "note", "culture", "religion"] as const;

const Common = {
  dryRun: z.boolean().optional().describe("Validate and return the plan (before/after) without changing anything"),
  continueOnError: z
    .boolean()
    .optional()
    .describe("Apply the valid ops and report the invalid ones instead of refusing the whole call"),
  redraw: Redraw,
  timeoutMs: TimeoutMs
};

const SelectSchema = z
  .object({
    cells: z.array(z.number().int().min(0)).optional().describe("Pack cell ids"),
    circle: z
      .object({
        at: Place,
        radius: z.number().positive(),
        unit: z.enum(["px", "km", "mi"]).optional().describe("Radius unit (default px; km/mi use the map scale)")
      })
      .optional(),
    polygon: z.array(Place).min(3).optional().describe("Polygon vertices (places)"),
    entity: EntityTarget.optional().describe("Cells of a state/province/culture/religion/feature/zone/river"),
    where: z
      .object({
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
      .describe("Filter; alone it scans every cell")
  })
  .describe("Cells: union of cells/circle/polygon/entity, then filtered by where");

export function register(ctx: ToolContext): void {
  ctx.tool(
    "edit",
    {
      title: "Edit or remove entities",
      description:
        "Batch-edit entities of ONE type: ops [{ref, set:{field: value}} | {ref, remove:true}]. All ops are validated first; if any is invalid nothing changes (unless continueOnError). One auto-undo entry covers the call; redraws are coalesced. dryRun:true returns before/after per op. Fields per type are in tupaia://docs/cheatsheet.md, e.g. burg {name, population (people), group, type, culture, port, lock, move:Place}; state {name, fullName, form, formName, color, capital:burgRef, culture, lock}; marker {type, icon, size, pinned, note:{name, legend}, move}; label {text, move}; map (no ref) {name, populationRate, urbanization, year, era}. name can be {generate:{base:<namesbase>}} | {generate:{culture:<ref>}} | {generate:{}} (own culture). A state's capital changes only through edit state {capital}. remove works for burg (not capitals or market centres), state, marker, route, river, zone, note, label; provinces, cultures and religions are REFUSED (repaint their cells with paint_cells instead).",
      inputSchema: z.object({
        type: z.enum(EDIT_TYPES),
        ops: z
          .array(
            z.object({
              ref: EntityRef.optional().describe("Entity ref (omit for type 'map')"),
              set: z.record(z.string(), z.unknown()).optional(),
              remove: z.boolean().optional()
            })
          )
          .min(1)
          .max(500),
        ...Common
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: META_TEXT_HEAVY,
      kind: "edit"
    },
    async (args, scope) => {
      const { dryRun, timeoutMs, ...rest } = args;
      const continueOnError = args.continueOnError;
      return runPhased(ctx, scope, `edit ${args.type}`, args, "edit", rest, { dryRun, continueOnError, timeoutMs });
    }
  );

  ctx.tool(
    "add",
    {
      title: "Add entities",
      description:
        "Create entities of ONE type: items [...]. Validated first (nothing changes on an invalid item unless continueOnError); one auto-undo entry; dryRun:true returns the plan. Item shapes: burg {at:Place, name?, population?, group?, type?, culture?, port?}; state {capital: Place | {burg:ref}, name?, color?, culture?, form?, formName?, expand?} (expand:true re-expands all unlocked states and regenerates provinces); marker {at, type?, icon?, size?, pinned?, note?:{name, legend}}; route {through:[Place, Place, ...], group?:'roads'|'trails'|'searoutes', name?} (pathfinds; NO_PATH explains why, e.g. different landmasses); zone {name?, type?, color?, cells?|select?}; label {at, text, group?}; note {id | entity:{type,ref}, name, legend?}; culture {at, name?, color?, type?, base?, expansionism?, expand?}; religion {at, name?, color?, type?, form?, deity?, expansionism?, expand?}. name can be {generate:{base}|{culture}|{}}.",
      inputSchema: z.object({
        type: z.enum(ADD_TYPES),
        items: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
        ...Common
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: META_TEXT_HEAVY,
      kind: "edit"
    },
    async (args, scope) => {
      const { dryRun, timeoutMs, ...rest } = args;
      const continueOnError = args.continueOnError;
      return runPhased(ctx, scope, `add ${args.type}`, args, "add", rest, { dryRun, continueOnError, timeoutMs });
    }
  );

  ctx.tool(
    "paint_cells",
    {
      title: "Paint cells",
      description:
        "Assign cells to a state/province/culture/religion/biome/zone, or change their height. select picks cells (union of cells, circle {at, radius, unit?}, polygon [Place...], entity {type,ref}; then filtered by where {land, water, hMin, hMax, biome, state, ...}). Painting skips water cells and never moves a state's or province's centre cell or a capital; provinces are re-fitted after state painting. height {value|delta|smooth, rebuild}: rebuild 'keep' (default) changes land heights only (20..100) and refuses any change that crosses height 20; 'risk' rebuilds the coastline, lakes, rivers and climate while keeping burgs, states and other data (cell ids change; erosion:true also re-runs river erosion); 'erase' regenerates every entity and needs confirmErase:true. Paint height in its own call. dryRun:true counts what would change. One auto-undo entry.",
      inputSchema: z.object({
        select: SelectSchema,
        set: z.object({
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
            .object({
              value: z.number().min(0).max(100).optional(),
              delta: z.number().min(-100).max(100).optional(),
              smooth: z.number().int().min(1).max(10).optional().describe("Smoothing passes"),
              rebuild: z.enum(["keep", "risk", "erase"]).optional(),
              clamp: z.boolean().optional().describe("keep mode: stop land at 20 instead of refusing"),
              erosion: z.boolean().optional().describe("risk mode: re-run river erosion (default false)"),
              confirmErase: z.boolean().optional()
            })
            .optional()
        }),
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
