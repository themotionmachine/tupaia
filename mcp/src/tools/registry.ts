// Tool modules register themselves here at import time, so server.ts only needs one
// `import "./tools/<file>.ts";` line per module.
import type { ToolContext } from "../context.ts";

const modules: Array<{ name: string; register: (ctx: ToolContext) => void }> = [];

export function defineTools(name: string, register: (ctx: ToolContext) => void): void {
  modules.push({ name, register });
}

export function registerAll(ctx: ToolContext): string[] {
  for (const m of modules) m.register(ctx);
  return modules.map(m => m.name);
}
