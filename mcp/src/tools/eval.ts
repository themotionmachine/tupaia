// eval: the escape hatch. Runs JS in the page against the app's runtime globals.
import { z } from "zod";
import type { ToolContext } from "../context.ts";
import type { EvalResolved } from "../ops.ts";
import { META_TEXT_HEAVY, unwrap } from "../result.ts";
import { RedrawLayer, TIMEOUTS, TimeoutMs } from "../schemas.ts";
import { defineTools } from "./registry.ts";

export function register(ctx: ToolContext): void {
  ctx.tool(
    "eval",
    {
      title: "Evaluate JavaScript in the map page",
      description:
        "Escape hatch: run JavaScript in the page against the app's runtime globals and get a JSON-safe result (typed arrays become arrays; large values are capped). Read tupaia://docs/runtime-api.md first. code is an expression (auto-returned) or a function body using `return`; `args` is available as a variable; await works. Use bare globals (pack, grid, notes, svg, customization), never window.notes. Undoable by default: an auto-undo snapshot is taken first; pass readOnly:true for pure reads (faster, no undo entry). After mutating, list the layers to re-sync in redraw (e.g. ['states','borders','labels']). Never call regenerateMap, saveSharedMap, restoreSharedMap or cloudflare.save; page writes to /api are blocked with 403 anyway. Errors come back as EVAL_ERROR with the message; console errors and dismissed app dialogs are reported.",
      inputSchema: z.object({
        code: z.string().min(1),
        args: z.unknown().optional().describe("JSON value passed to the code as `args`"),
        readOnly: z.boolean().optional().describe("true: no undo snapshot (use for pure reads)"),
        redraw: z.array(RedrawLayer).optional().describe("Layers to redraw after the code ran"),
        timeoutMs: TimeoutMs
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: META_TEXT_HEAVY,
      kind: "edit"
    },
    async (args, scope) => {
      const readOnly = !!args.readOnly;
      if (!readOnly) await scope.pushUndo("eval", { code: args.code });
      const idBefore = await ctx.pageMapId();
      let replaced = false;
      let result: Record<string, unknown>;
      try {
        const env = await scope.envelope<Record<string, unknown>>(
          "evalUser",
          { code: args.code, args: args.args, redraw: args.redraw },
          { timeoutMs: args.timeoutMs ?? TIMEOUTS.edit, mutating: !readOnly }
        );
        const v = unwrap(env);
        result = { ...v, ms: env.ms, ...(readOnly ? {} : { undo: "available (snapshot {action:'undo'})" }) };
      } finally {
        // eval can replace the whole map (generate(), uploadMap(), ...). Lineage to the shared
        // map must not survive that: a new window.mapId drops provenance to 'unknown'.
        // (a dirty page is relaunched and the newest snapshot restored, with its provenance, next)
        const idAfter = ctx.browser.dirty ? idBefore : await ctx.pageMapId();
        if (idBefore !== idAfter) {
          replaced = true;
          ctx.snapshots.setProvenance({ kind: "unknown", mapId: idAfter });
          scope.notes.push(
            "eval replaced the map in the page (its map id changed); the origin is now 'unknown', so shared_save treats it as unrelated to the shared map"
          );
        } else if (!readOnly) ctx.snapshots.noteMutation();
      }
      if (!readOnly) {
        const resolved: EvalResolved = { code: args.code };
        if (args.args !== undefined) resolved.args = args.args;
        if (args.redraw !== undefined) resolved.redraw = args.redraw;
        await scope.record("eval", args, resolved, {
          unsafe: true,
          replayable: !replaced,
          reason: replaced ? "eval replaced the whole map" : undefined
        });
      }
      return result;
    }
  );
}

defineTools("eval", register);
