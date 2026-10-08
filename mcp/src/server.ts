// Tupaia MCP server entry point: `node mcp/src/server.ts` (Node >= 24 type stripping, no tsx).
// Startup only registers tools/resources and connects stdio: no browser, no network. The
// browser launches on the first tool call that needs it.
import "./stdout-guard.ts"; // must stay the first import: it guards fd 1 before anything else loads
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.ts";
import { ToolContext } from "./context.ts";
import { protocolOut } from "./stdout-guard.ts";
import { registerAll } from "./tools/registry.ts";
// Tool modules: one import line each; they self-register through tools/registry.ts.
import "./tools/session.ts";
import "./tools/query.ts";
import "./tools/view.ts";
import "./tools/history.ts";
import "./tools/eval.ts";
import "./tools/persist.ts";
import "./tools/edit.ts";
import "./tools/generate.ts";
import "./tools/display.ts";
import "./tools/shared.ts";
import "./tools/sketch.ts";

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

const server = new McpServer({ name: "tupaia", version: pkg.version }, { instructions: INSTRUCTIONS });
ctx.server = server;
registerAll(ctx);

function fileResource(name: string, uri: string, title: string, description: string, file: string, prefix = "") {
  server.registerResource(name, uri, { title, description, mimeType: "text/markdown" }, async u => {
    let text: string;
    try {
      text = prefix + fs.readFileSync(file, "utf8");
    } catch (e) {
      text = `# ${title}\n\n(unavailable: ${(e as Error).message})\n`;
    }
    return { contents: [{ uri: u.href, mimeType: "text/markdown", text }] };
  });
}

fileResource(
  "runtime-api",
  "tupaia://docs/runtime-api.md",
  "Tupaia runtime API reference",
  "Globals, lazy modules, generate/edit/redraw recipes and pitfalls for scripting the page (read before eval).",
  path.join(config.repoRoot, "docs", "architecture", "runtime_api.md")
);
fileResource(
  "cheatsheet",
  "tupaia://docs/cheatsheet.md",
  "Tupaia MCP cheatsheet",
  "Tools in one line each, ref/place grammar, error codes, layer names, recipes.",
  path.join(config.mcpRoot, "resources", "cheatsheet.md")
);
fileResource(
  "data-model",
  "tupaia://docs/data-model.md",
  "Tupaia data model",
  "Entity and cell data structures (pack, grid, burgs, states, ...).",
  path.join(config.repoRoot, "docs", "architecture", "data_model.md"),
  "> Note from tupaia-mcp: notes use the key `id` (e.g. burg12, marker3), not `i` as written below.\n\n"
);

let closing = false;
async function shutdown(reason: string, code = 0): Promise<void> {
  if (closing) return;
  closing = true;
  process.stderr.write(`[tupaia-mcp] shutdown: ${reason}\n`);
  setTimeout(() => process.exit(code), 5000).unref();
  await ctx.browser.close().catch(() => {});
  process.exit(code);
}

await server.connect(new StdioServerTransport(process.stdin, protocolOut));
server.server.onclose = () => void shutdown("transport closed");
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => void shutdown(sig));
process.on("uncaughtException", e => {
  process.stderr.write(`[tupaia-mcp] uncaughtException: ${e.stack ?? e}\n`);
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", e => {
  process.stderr.write(`[tupaia-mcp] unhandledRejection: ${(e as Error)?.stack ?? e}\n`);
});
for (const w of config.warnings) process.stderr.write(`[tupaia-mcp] warning: ${w}\n`);
process.stderr.write(
  `[tupaia-mcp] ready: mode ${ctx.mode.mode}, ${ctx.toolNames.length} tools, live origin ${config.liveOrigin ?? "none"} (browser launches on first call)\n`
);
