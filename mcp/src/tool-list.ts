// The tool list without a daemon (`tupaia tools` when none runs for this TUPAIA_OUT): the tool
// modules register on a stand-in context that only records their specs, as GET /tools would
// list them. No browser, no daemon, nothing written. Imported lazily by cli.ts (zod is heavy).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Config } from "./config.ts";
import { jsonSchemaOf } from "./http.ts";
import { registerAll } from "./tools/registry.ts";

export interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: unknown;
}

export async function listToolsOffline(cfg: Config): Promise<ListedTool[]> {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "tools");
  // the same modules, in the same order, as server.ts
  for (const f of fs.readdirSync(dir).sort())
    if (f.endsWith(".ts") && f !== "registry.ts" && !f.endsWith(".d.ts"))
      await import(pathToFileURL(path.join(dir, f)).href);
  const tools: ListedTool[] = [];
  const stand = {
    tool: (
      name: string,
      spec: { title?: string; description?: string; inputSchema: unknown; annotations?: unknown }
    ) => {
      tools.push({
        name,
        title: spec.title,
        description: spec.description,
        inputSchema: jsonSchemaOf(spec.inputSchema),
        annotations: spec.annotations
      });
    },
    config: cfg
  };
  registerAll(stand as never);
  return tools;
}
