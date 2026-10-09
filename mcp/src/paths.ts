// File path policy for tools that read or write files.
// Reads: absolute, else the first existing of <server cwd>/p, TUPAIA_OUT/p, <repo>/p.
// Writes: relative paths resolve under TUPAIA_OUT. Allowed without opt-in: anything under
// TUPAIA_OUT, or a non-source subfolder of the repo with an allowed extension (never the repo
// root, src/, public/, mcp/, cloudflare/, docs/, dist/, tests/, node_modules/ or dot-folders,
// and never over a git-tracked file). tests/fixtures is always refused.
// macOS and Windows file systems are case-insensitive by default, so comparisons fold case there.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import { ToolError } from "./result.ts";

export const WRITE_EXTS = [".map", ".svg", ".png", ".jpg", ".jpeg", ".json", ".geojson"];

const FOLD_CASE = process.platform === "darwin" || process.platform === "win32";
const fold = (p: string): string => (FOLD_CASE ? p.toLowerCase() : p);

/** Top-level repo folders that writes never go into without allowOutside. */
const REPO_DENY = new Set(["src", "public", "mcp", "cloudflare", "docs", "dist", "tests", "node_modules"]);

function inside(child: string, parent: string): boolean {
  const rel = path.relative(fold(parent), fold(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function real(p: string): string {
  // resolve symlinks (and, where the platform supports it, the on-disk case) of the nearest
  // existing ancestor
  let cur = p;
  const tail: string[] = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  try {
    return path.join(fs.realpathSync.native(cur), ...tail);
  } catch {
    return p;
  }
}

function gitTracked(repo: string, abs: string): boolean {
  try {
    execFileSync("git", ["-C", repo, "ls-files", "--error-unmatch", "--", path.relative(repo, abs)], {
      stdio: "ignore",
      timeout: 5000
    });
    return true;
  } catch {
    return false;
  }
}

export interface WriteOptions {
  exts?: string[];
  allowOutside?: boolean;
  overwrite?: boolean;
}

export function resolveWritePath(cfg: Config, p: string, opts: WriteOptions = {}): string {
  const exts = opts.exts ?? WRITE_EXTS;
  if (!path.isAbsolute(p) && /^(\.\/)?tests[\\/]fixtures([\\/]|$)/i.test(p)) {
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
  if (inside(abs, repo) && !inside(abs, outDir) && !opts.allowOutside) {
    const rel = path.relative(repo, abs);
    const segs = fold(rel).split(path.sep);
    if (segs.length < 2) {
      throw new ToolError(
        "REFUSED",
        `refusing to write directly into the repo root (${rel}); write under TUPAIA_OUT or a subfolder instead`
      );
    }
    if (segs.some(seg => seg.startsWith(".") && seg !== ".tupaia-mcp-out") || REPO_DENY.has(segs[0])) {
      throw new ToolError(
        "REFUSED",
        `refusing to write into repo source/config/build path ${rel}; write under TUPAIA_OUT instead`
      );
    }
    if (fs.existsSync(abs) && gitTracked(repo, abs)) {
      throw new ToolError("REFUSED", `${rel} is tracked by git; refusing to replace it (write elsewhere)`);
    }
  }
  if (fs.existsSync(abs) && !opts.overwrite) {
    throw new ToolError("REFUSED", `${abs} exists; pass overwrite:true to replace it`);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return abs;
}

/** The read rule, for tool descriptions and errors. */
export const READ_RULE =
  "absolute, or relative to the server's working directory (the project it was started in), then TUPAIA_OUT, then the repo root; the first that exists";

/** Where a relative read path is looked for, in order. */
export function readCandidates(cfg: Config, p: string): string[] {
  if (path.isAbsolute(p)) return [path.resolve(p)];
  const out: string[] = [];
  for (const base of [process.cwd(), cfg.outDir, cfg.repoRoot]) {
    const abs = path.resolve(base, p);
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

/**
 * Read paths (load_map, apply specPath, set_heights/flow image.path, sketch onto.path): absolute,
 * else the first existing of the server's cwd, TUPAIA_OUT and the repo root. Returns the absolute
 * path that was found; every tool result names it.
 */
export function resolveReadPath(cfg: Config, p: string): string {
  const cands = readCandidates(cfg, p);
  const abs = cands.find(c => fs.existsSync(c));
  if (!abs) {
    throw new ToolError(
      "NOT_FOUND",
      cands.length > 1 ? `file not found: ${p} (looked in ${cands.join(", ")})` : `file not found: ${cands[0]}`
    );
  }
  if (!fs.statSync(abs).isFile()) throw new ToolError("BAD_ARGS", `${abs} is not a file`);
  return abs;
}
