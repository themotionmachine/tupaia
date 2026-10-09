// The shared docs stay in step with the tool surface: every registered tool is in the cheatsheet's
// tool table, the README and the operating skill, the tool counts they state are right, and the
// server instructions fit the 2048-char budget and point at the cheatsheet. Pure: no browser.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, describe, test } from "node:test";
import { MCP_ROOT, REPO_ROOT } from "./helpers.ts";

const read = (...p: string[]) => fs.readFileSync(path.join(...p), "utf8");

describe("docs match the tools", () => {
  const names: string[] = [];
  const schemas = new Map<string, unknown>();

  before(async () => {
    const dir = path.join(MCP_ROOT, "src", "tools");
    for (const f of fs.readdirSync(dir).sort())
      if (f.endsWith(".ts") && f !== "registry.ts" && !f.endsWith(".d.ts")) await import(path.join(dir, f));
    const { registerAll } = await import("../src/tools/registry.ts");
    // a stand-in context that only records tool names (registration must not need a browser)
    const ctx = {
      tool: (name: string, spec: { inputSchema: unknown }) => {
        names.push(name);
        schemas.set(name, spec.inputSchema);
      },
      config: { testHooks: false, warnings: [] }
    };
    registerAll(ctx as never);
    assert.ok(names.length > 20, `only ${names.length} tools registered`);
  });

  test("cheatsheet: one table row per tool and the right count", () => {
    const text = read(MCP_ROOT, "resources", "cheatsheet.md");
    assert.match(text, new RegExp(`## The ${names.length} tools`));
    assert.match(text, new RegExp(`\\b${names.length} tools\\.`));
    const rows = [...text.matchAll(/^\| `([a-z_]+)[ `]/gm)].map(m => m[1]);
    for (const n of names) assert.ok(rows.includes(n), `cheatsheet tool table has no row for ${n}`);
  });

  test("cheatsheet: every optional argument a tool row shows is one the tool takes", async () => {
    // unknown top-level arguments are BAD_ARGS, so a stale name in the table would mislead
    const { allowedArgKeys } = await import("../src/context.ts");
    const text = read(MCP_ROOT, "resources", "cheatsheet.md");
    let checked = 0;
    for (const m of text.matchAll(/^\| `([a-z_]+) (\{[^`]*)` \|/gm)) {
      const allowed = allowedArgKeys(schemas.get(m[1]) as never);
      if (!allowed) continue; // apply: its lists go under any key
      for (const k of m[2].matchAll(/([A-Za-z]+)\?/g)) {
        assert.ok(allowed.includes(k[1]), `cheatsheet row ${m[1]} shows '${k[1]}?', which ${m[1]} does not take`);
        checked++;
      }
    }
    assert.ok(checked > 60, `only ${checked} arguments checked`);
  });

  test("README and SKILL name every tool and state the count", () => {
    const readme = read(MCP_ROOT, "README.md");
    const skill = read(REPO_ROOT, ".claude", "skills", "tupaia-dexterity", "SKILL.md");
    assert.match(readme, new RegExp(`registers ${names.length} tools`));
    assert.match(skill, new RegExp(`exposes ${names.length} tools`));
    for (const n of names) assert.ok(readme.includes(n), `README never mentions ${n}`);
  });

  test("INSTRUCTIONS fit 2048 chars and point at the cheatsheet", () => {
    const src = read(MCP_ROOT, "src", "server.ts");
    const m = /export const INSTRUCTIONS = `([\s\S]*?)`;/.exec(src);
    assert.ok(m, "INSTRUCTIONS not found in server.ts");
    const text = m[1];
    assert.ok(text.length > 100 && text.length <= 2048, `instructions length ${text.length}`);
    assert.ok(text.includes("tupaia://docs/cheatsheet.md"));
    // every snake_case word that looks like a tool name is one
    const toolish = new Set(
      [...text.matchAll(/\b([a-z]+_[a-z_]+)\b/g)].map(x => x[1]).filter(w => !["map_px"].includes(w))
    );
    for (const w of toolish) assert.ok(names.includes(w), `INSTRUCTIONS names '${w}', which is not a tool`);
  });
});
