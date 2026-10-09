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
- Mode is local unless spawned with TUPAIA_MODE=live. Only shared_save, shared_restore and sketch_promote write the live shared map (map.activationlayer.org), and only when the human explicitly asks in this conversation: preview first, then confirm with the preview token.
- Start with session. The page boots a random map: load_map {path} or {source:'shared'} (read-only), or generate_map {seed}.
- Refs: an id or an exact name (case/diacritics folded), never fuzzy; on NOT_FOUND/AMBIGUOUS retry with an id from candidates. Places: {x,y} map px | {lat,lon} | {cell} | {entity:{type,ref}, at?}.
- Loop: find/inspect -> snapshot take before risky steps -> batch mutation (dryRun for big ones) -> map_info {diff:'counts'} -> screenshot framed on the change (compare + crop:'changed') -> snapshot undo if wrong. Each mutating call is one undo entry.
- Prefer tools over eval: set_heights + flow (terrain), edit map (world settings, locks, recalculate), apply (spec; mode:'check' first), clear (wipe a base), compact (removed-record bloat), regrid (cell density), lint (quality, ready fixes), regenerate biomes/provinces/emblems/relief, display {labels}. eval is the last resort: read tupaia://docs/runtime-api.md first.
- Read cheaply: find/inspect format:'compact', edit/add rows:'ids'. Unknown arguments are BAD_ARGS. Results carry alerts, consoleErrors and notes: read them. After TIMEOUT or a relaunch note, call session.
- Propose a shared-map change as a sketch: load_map {source:'shared'} -> sketch start -> edits -> summary -> save (view link); on the human's yes: rebase, then sketch_promote. regrid, generate_map and most regenerate parts make it blob-only.
- Over --http (session shows serving) every caller shares the page, undo and sketch: coordinate before undo/restore. No tools in this session? Use the CLI mcp/bin/tupaia.
- Cheatsheet: tupaia://docs/cheatsheet.md. Data model: tupaia://docs/data-model.md.`;

const config = loadConfig();
const ctx = new ToolContext(config);
const pkg = JSON.parse(fs.readFileSync(path.join(config.mcpRoot, "package.json"), "utf8")) as { version: string };
registerAll(ctx);
/** A server with every tool and resource; all of them share `ctx`. */
const makeServer = (gone?: AbortSignal) => createServer(ctx, pkg.version, INSTRUCTIONS, gone);

const argv = process.argv.slice(2);
const httpMode = argv.includes("--http");
let daemon: HttpDaemon | null = null;

let closing = false;
async function shutdown(reason: string, code = 0): Promise<void> {
  if (closing) return;
  closing = true;
  process.stderr.write(`[tupaia-mcp] shutdown: ${reason}\n`);
  // a daemon drains its running call (15 s) and saves the page map (15 s) first
  setTimeout(() => process.exit(code), daemon ? 40_000 : 5000).unref();
  if (daemon) await daemon.close(reason).catch(() => {});
  await ctx.browser.close().catch(() => {});
  process.exit(code);
}

if (httpMode) {
  try {
    // the daemon is found through TUPAIA_OUT: never serve a fallback directory nobody looks in
    const asked = process.env.TUPAIA_OUT;
    if (asked && path.resolve(asked) !== config.outDir)
      throw new Error(`cannot use TUPAIA_OUT ${path.resolve(asked)} (not creatable or not writable)`);
    // --prefer-port N: N if free, else any free port (the CLI's remembered port)
    const preferred = argValue(argv, "--prefer-port");
    daemon = await startHttpDaemon({
      ctx,
      config,
      makeServer,
      port: parsePort(preferred ?? argValue(argv, "--port") ?? process.env.TUPAIA_HTTP_PORT),
      preferPort: preferred !== undefined,
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
