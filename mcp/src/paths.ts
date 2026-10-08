// File path policy for tools that read or write files.
// Writes: relative paths resolve under TUPAIA_OUT. Allowed without opt-in: anything under
// TUPAIA_OUT, or under the repo with an allowed extension. tests/fixtures is always refused.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import { ToolError } from "./result.ts";

export const WRITE_EXTS = [".map", ".svg", ".png", ".jpg", ".jpeg", ".json", ".geojson"];

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function real(p: string): string {
  // resolve symlinks of the nearest existing ancestor
  let cur = p;
  const tail: string[] = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  try {
    return path.join(fs.realpathSync(cur), ...tail);
  } catch {
    return p;
  }
}

export interface WriteOptions {
  exts?: string[];
  allowOutside?: boolean;
  overwrite?: boolean;
}

export function resolveWritePath(cfg: Config, p: string, opts: WriteOptions = {}): string {
  const exts = opts.exts ?? WRITE_EXTS;
  if (!path.isAbsolute(p) && /^(\.\/)?tests[\\/]fixtures([\\/]|$)/.test(p)) {
    throw new ToolError("REFUSED", `refusing to write under tests/fixtures (${p})`);
  }
  const abs = real(path.isAbsolute(p) ? path.resolve(p) : path.resolve(cfg.outDir, p));
  const fixtures = real(path.join(cfg.repoRoot, "tests", "fixtures"));
  if (inside(abs, fixtures)) throw new ToolError("REFUSED", `refusing to write under tests/fixtures (${abs})`);
  const ext = path.extname(abs).toLowerCase();
  const outDir = real(cfg.outDir);
  const repo = real(cfg.repoRoot);
  if (!exts.includes(ext)) {
    throw new ToolError("REFUSED", `extension '${ext || "(none)"}' not allowed here; use one of ${exts.join(", ")}`);
  }
  if (!inside(abs, outDir) && !inside(abs, repo) && !opts.allowOutside) {
    throw new ToolError(
      "REFUSED",
      `${abs} is outside TUPAIA_OUT (${outDir}) and the repo; pass allowOutside:true if the human asked for it`
    );
  }
  if (inside(abs, repo) && !inside(abs, outDir)) {
    const rel = path.relative(repo, abs);
    if (
      rel.split(path.sep).some(seg => seg.startsWith(".") && seg !== ".tupaia-mcp-out") ||
      /^(src|public|mcp|cloudflare|docs)\b/.test(rel)
    ) {
      if (!opts.allowOutside) {
        throw new ToolError(
          "REFUSED",
          `refusing to write into repo source/config path ${rel}; write under TUPAIA_OUT instead`
        );
      }
    }
  }
  if (fs.existsSync(abs) && !opts.overwrite) {
    throw new ToolError("REFUSED", `${abs} exists; pass overwrite:true to replace it`);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return abs;
}

/** Read paths resolve relative to the repo root. */
export function resolveReadPath(cfg: Config, p: string): string {
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cfg.repoRoot, p);
  if (!fs.existsSync(abs)) throw new ToolError("NOT_FOUND", `file not found: ${abs}`);
  if (!fs.statSync(abs).isFile()) throw new ToolError("BAD_ARGS", `${abs} is not a file`);
  return abs;
}
