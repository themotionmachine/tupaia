// load_map (this layer). save_map and export are added by a later layer.
import fs from "node:fs";
import { z } from "zod";
import type { ToolContext } from "../context.ts";
import { resolveReadPath } from "../paths.ts";
import { ToolError } from "../result.ts";
import { defineTools } from "./registry.ts";

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
        ctx.snapshots.setProvenance({ kind: "file", path: abs, seed: (s.seed as string) ?? null });
        return { ...brief(s), origin: ctx.provenanceView(), bytes: bytes.length, ms: Date.now() - t0 };
      }
      const blob = await ctx.shared.getMap();
      await scope.pushUndo("load_map", { source: "shared" });
      const s = await scope.loadMap({ b64: blob.bytes.toString("base64") });
      ctx.snapshots.setProvenance({
        kind: "shared",
        seed: (s.seed as string) ?? null,
        sharedVersion: blob.version ?? undefined,
        sharedUpdatedBy: blob.updatedBy,
        sharedUpdatedAt: blob.updatedAt,
        fetchedAt: new Date().toISOString()
      });
      return { ...brief(s), origin: ctx.provenanceView(), bytes: blob.bytes.length, ms: Date.now() - t0 };
    }
  );
}

defineTools("persist", register);
