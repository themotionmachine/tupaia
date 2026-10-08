// session: server status, one-way drop to local mode, browser restart, console clearing.
import { z } from "zod";
import type { CallScope, ToolContext } from "../context.ts";
import { ToolError } from "../result.ts";
import { defineTools } from "./registry.ts";

async function status(ctx: ToolContext, scope: CallScope, clear: boolean): Promise<Record<string, unknown>> {
  const b = ctx.browser;
  let map: Record<string, unknown> | null = null;
  if (b.isLaunched) {
    const s = await scope.call<Record<string, unknown>>("summary", {}, { noAlerts: true });
    map = {
      name: s.name,
      seed: s.seed,
      graph: s.graph,
      cells: s.cells,
      counts: s.counts,
      customization: s.customization,
      origin: ctx.provenanceView(),
      opsSince: ctx.snapshots.provenance.opsSince
    };
  }
  const origin = ctx.config.liveOrigin;
  const consoleErrors = b.consoleRing.slice(-20).map(e => ({ at: e.at, kind: e.kind, text: e.text }));
  if (clear) b.clearConsole();
  return {
    mode: ctx.mode.mode,
    envMode: ctx.config.envMode,
    ...(ctx.mode.droppedFromLive ? { modeNote: "dropped from live to local for the rest of this process" } : {}),
    liveOrigin: origin ?? "none",
    readsHit: origin
      ? `Node-side shared reads (load_map {source:'shared'}, shared_status) GET ${origin}`
      : "none: TUPAIA_LIVE_ORIGIN=none disables shared reads",
    pageApi:
      ctx.mode.mode === "live"
        ? `page GET /api/* is proxied to ${origin}; every page non-GET /api request gets 403`
        : "page GET /api/* returns 404; every page non-GET /api request gets 403",
    appVersion: b.appVersion,
    distEntry: b.distEntry,
    distDir: ctx.config.distDir,
    browser: b.state,
    launches: b.launches,
    lastRelaunch: b.lastRelaunch,
    url: b.url,
    viewport: ctx.config.viewport,
    map,
    snapshots: ctx.snapshots.snapshots.length,
    undoDepth: ctx.snapshots.undoStack.length,
    redoDepth: ctx.snapshots.redoStack.length,
    shots: ctx.shots.count,
    outDir: ctx.config.outDir,
    consoleErrors,
    consoleCleared: clear || undefined,
    outwardRequests: b.outward.slice(-50),
    blockedRequests: { count: b.blocked.length, recent: b.blocked.slice(-10) },
    testHooks: ctx.config.testHooks || undefined,
    warnings: ctx.config.warnings.length ? ctx.config.warnings : undefined
  };
}

export function register(ctx: ToolContext): void {
  const actions = ctx.config.testHooks
    ? (["status", "set_mode", "restart", "crash"] as const)
    : (["status", "set_mode", "restart"] as const);
  const Input = z.object({
    action: z.enum(actions).default("status"),
    mode: z
      .enum(["local"])
      .optional()
      .describe("set_mode only. 'local' is the only value: live mode comes only from TUPAIA_MODE=live at spawn"),
    restore: z
      .enum(["latest", "none"])
      .optional()
      .describe(
        "restart only: 'latest' (default) reloads the map that was in the page (or, if the page no longer answers, the newest snapshot/undo point); 'none' leaves a fresh random map"
      ),
    clear: z.boolean().optional().describe("status: clear the captured console errors after reporting them")
  });

  ctx.tool(
    "session",
    {
      title: "Server session",
      description:
        "Status of the Tupaia MCP server: mode (local by default), live origin that reads would hit, app/build version, browser state, the map's name/seed/provenance and ops since load, snapshot/undo counts, captured page console errors (clear:true clears) and the outward request log. The first status call launches headless Chromium (~1 s). action 'set_mode' {mode:'local'} drops live to local for the rest of the process (there is no way to switch to live at run time). action 'restart' relaunches the browser and, with restore:'latest' (default), reloads the map that was in the page (the newest snapshot or undo point only if the page no longer answers; lost calls are named).",
      inputSchema: Input,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      kind: "heavy",
      launch: false
    },
    async (args, scope) => {
      const action = args.action ?? "status";
      if (action === "set_mode") {
        if (args.mode !== "local") throw new ToolError("MODE", "only set_mode {mode:'local'} is allowed");
        const was = ctx.mode.mode;
        ctx.mode.dropToLocal();
        return {
          mode: ctx.mode.mode,
          was,
          note: was === "live" ? "dropped to local; live writes are off for this process" : "already local"
        };
      }
      if (action === "restart") {
        const restored = await ctx.restart(args.restore ?? "latest");
        scope.notes.push(...ctx.browser.pendingNotes.splice(0));
        return { restarted: true, restored, ...(await status(ctx, scope, false)) };
      }
      if (action === "crash") {
        if (!ctx.config.testHooks) throw new ToolError("REFUSED", "crash is a test hook (TUPAIA_TEST_HOOKS=1)");
        await ctx.browser.ensureHealthy(scope.notes);
        await ctx.browser.crashForTest();
        return { crashed: true };
      }
      await ctx.browser.ensureHealthy(scope.notes);
      return status(ctx, scope, !!args.clear);
    }
  );
}

defineTools("session", register);
