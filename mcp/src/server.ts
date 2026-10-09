// Tupaia MCP server entry point: `node mcp/src/server.ts` (Node >= 24 type stripping, no tsx).
// Startup only registers tools/resources and connects stdio: no browser, no network. The
// browser launches on the first tool call that needs it.
// `--http [--port N]` (or TUPAIA_HTTP_PORT) serves the same tools as a shared local daemon
// instead (see http.ts; mcp/bin/tupaia is its CLI). Stdio is the default.
import "./stdout-guard.ts"; // must stay the first import: it guards fd 1 before anything else loads
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.ts";
import { ToolContext } from "./context.ts";
import { argValue, type HttpDaemon, parseIdleMin, parsePort, startHttpDaemon } from "./http.ts";
import { protocolOut } from "./stdout-guard.ts";
import { createServer } from "./surface.ts";
import { registerAll } from "./tools/registry.ts";

// Tool modules: every src/tools/*.ts except registry.ts, in name order; each self-registers
// through tools/registry.ts at import time (so a new tool is just a new file).
{
  const toolsDir = path.join(path.dirname(new URL(import.meta.url).pathname), "tools");
  for (const f of fs.readdirSync(toolsDir).sort())
    if (f.endsWith(".ts") && f !== "registry.ts" && !f.endsWith(".d.ts"))
      await import(pathToFileURL(path.join(toolsDir, f)).href);
}

export const INSTRUCTIONS = `Tupaia MCP drives the Tupaia fantasy-map app (Azgaar's FMG fork) in headless Chromium.
- Mode is local unless the server was spawned with TUPAIA_MODE=live; nothing here writes the live shared map (map.activationlayer.org) except shared_save/shared_restore, and only when the human explicitly asks in this conversation: preview first, then confirm with the preview token.
- Start with session (status). The page boots a random map; use load_map {path} or {source:'shared'} (read-only) or generate_map {seed} to get the map you want.
- Refs: an id or an exact name (case/diacritics folded). Fuzzy matches are never applied: on NOT_FOUND/AMBIGUOUS read the candidates and retry with an id. Id 0 = Neutrals/Wildlands/No religion; removed entities stay in arrays.
- Places: {x,y} map px | {lat,lon} | {cell} | {entity:{type,ref}, at?} (at = fraction along a route/river). inspect {at:{screen:[px,py], shot}} maps a screenshot pixel to the map.
- Loop: find/inspect -> snapshot {action:'take', label} before multi-step or risky changes -> batch mutations -> map_info (diff since the last snapshot or undo point) -> screenshot framed on what changed -> snapshot {action:'undo'} or {action:'restore'} if wrong. Every mutating call is undoable; snapshot {action:'list'} shows the history.
- Screenshot after visual changes, not after pure reads (JPEG maxSide 1024 by default; the full PNG is saved to disk).
- eval is the last resort: read tupaia://docs/runtime-api.md first, use bare globals (pack, notes, svg), pass redraw layers after mutating, readOnly:true for reads.
- Results carry alerts (app dialogs, auto-dismissed), consoleErrors and notes: read them. After TIMEOUT or a relaunch note, call session and restore if needed.
- To propose a shared-map change without writing it: load_map {source:'shared'} -> sketch start -> edits -> summary -> save (view link). Promote only on the human's yes: rebase, then sketch_promote.
- Cheatsheet: tupaia://docs/cheatsheet.md. Data model: tupaia://docs/data-model.md.`;

const config = loadConfig();
const ctx = new ToolContext(config);
const pkg = JSON.parse(fs.readFileSync(path.join(config.mcpRoot, "package.json"), "utf8")) as { version: string };
registerAll(ctx);
/** A server with every tool and resource; all of them share `ctx`. */
const makeServer = () => createServer(ctx, pkg.version, INSTRUCTIONS);

const argv = process.argv.slice(2);
const httpMode = argv.includes("--http");
let daemon: HttpDaemon | null = null;

let closing = false;
async function shutdown(reason: string, code = 0): Promise<void> {
  if (closing) return;
  closing = true;
  process.stderr.write(`[tupaia-mcp] shutdown: ${reason}\n`);
  setTimeout(() => process.exit(code), daemon ? 25_000 : 5000).unref();
  if (daemon) await daemon.close(reason).catch(() => {});
  await ctx.browser.close().catch(() => {});
  process.exit(code);
}

if (httpMode) {
  try {
    daemon = await startHttpDaemon({
      ctx,
      config,
      makeServer,
      port: parsePort(argValue(argv, "--port") ?? process.env.TUPAIA_HTTP_PORT),
      idleMin: parseIdleMin(process.env.TUPAIA_HTTP_IDLE_MIN),
      version: pkg.version,
      log: msg => process.stderr.write(`[tupaia-mcp] ${msg}\n`),
      onStop: reason => void shutdown(reason)
    });
  } catch (e) {
    process.stderr.write(`[tupaia-mcp] cannot start the http daemon: ${(e as Error).message}\n`);
    await ctx.browser.close().catch(() => {});
    process.exit(1);
  }
} else {
  const server = makeServer();
  await server.connect(new StdioServerTransport(process.stdin, protocolOut));
  server.server.onclose = () => void shutdown("transport closed");
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => void shutdown(sig));
process.on("uncaughtException", e => {
  process.stderr.write(`[tupaia-mcp] uncaughtException: ${e.stack ?? e}\n`);
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", e => {
  process.stderr.write(`[tupaia-mcp] unhandledRejection: ${(e as Error)?.stack ?? e}\n`);
});
for (const w of config.warnings) process.stderr.write(`[tupaia-mcp] warning: ${w}\n`);
if (daemon) {
  const idle = daemon.state.idleMin ? `idle shutdown after ${daemon.state.idleMin} min` : "no idle shutdown";
  process.stderr.write(
    `[tupaia-mcp] ready: http ${daemon.url}/mcp (pid ${process.pid}), mode ${ctx.mode.mode}, ${ctx.toolNames.length} tools, live origin ${config.liveOrigin ?? "none"}, state ${path.join(config.outDir, "daemon.json")}, ${idle} (browser launches on first call)\n`
  );
} else {
  process.stderr.write(
    `[tupaia-mcp] ready: mode ${ctx.mode.mode}, ${ctx.toolNames.length} tools, live origin ${config.liveOrigin ?? "none"} (browser launches on first call)\n`
  );
}
