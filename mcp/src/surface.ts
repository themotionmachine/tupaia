// What one McpServer exposes: every defined tool plus the doc resources. Called once for the
// stdio server and once per HTTP request under --http (createMcpHandler builds a fresh server
// per request); every server shares the one ToolContext, so nothing here holds state.
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import type { ToolContext } from "./context.ts";

function fileResource(
  server: McpServer,
  name: string,
  uri: string,
  title: string,
  description: string,
  file: string,
  prefix = ""
): void {
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

/** Register the tools and resources on `server`. */
export function registerSurface(server: McpServer, ctx: ToolContext): void {
  ctx.attach(server);
  const { repoRoot, mcpRoot } = ctx.config;
  fileResource(
    server,
    "runtime-api",
    "tupaia://docs/runtime-api.md",
    "Tupaia runtime API reference",
    "Globals, lazy modules, generate/edit/redraw recipes and pitfalls for scripting the page (read before eval).",
    path.join(repoRoot, "docs", "architecture", "runtime_api.md")
  );
  fileResource(
    server,
    "cheatsheet",
    "tupaia://docs/cheatsheet.md",
    "Tupaia MCP cheatsheet",
    "Tools in one line each, ref/place grammar, error codes, layer names, recipes.",
    path.join(mcpRoot, "resources", "cheatsheet.md")
  );
  fileResource(
    server,
    "data-model",
    "tupaia://docs/data-model.md",
    "Tupaia data model",
    "Entity and cell data structures (pack, grid, burgs, states, ...).",
    path.join(repoRoot, "docs", "architecture", "data_model.md"),
    "> Note from tupaia-mcp: notes use the key `id` (e.g. burg12, marker3), not `i` as written below.\n\n"
  );
}

/** A fresh server with the full surface. */
export function createServer(ctx: ToolContext, version: string, instructions: string): McpServer {
  const server = new McpServer({ name: "tupaia", version }, { instructions });
  registerSurface(server, ctx);
  return server;
}
