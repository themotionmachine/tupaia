// Environment parsing for the Tupaia MCP server. Everything is read once at startup.
// Live mode can only come from TUPAIA_MODE=live in the spawn environment; at run time the
// mode can only drop from live to local (see dropToLocal), never the other way.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Mode = "local" | "live";

export interface Config {
  repoRoot: string;
  mcpRoot: string;
  distDir: string;
  outDir: string;
  /** Mode requested by the environment (never changes). */
  envMode: Mode;
  /** Live origin for Node-side reads (and live-mode page GET proxy); null when TUPAIA_LIVE_ORIGIN=none. */
  liveOrigin: string | null;
  viewport: { width: number; height: number };
  snapshotsMax: number;
  undoDepth: number;
  headed: boolean;
  offline: boolean;
  testHooks: boolean;
  warnings: string[];
}

export const DEFAULT_LIVE_ORIGIN = "https://map.activationlayer.org";

function findRepoRoot(warnings: string[]): string {
  // mcp/src/config.ts -> ../.. is the repo (or worktree) root.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fromUrl = path.resolve(here, "..", "..");
  if (fs.existsSync(path.join(fromUrl, "package.json")) && fs.existsSync(path.join(fromUrl, "mcp"))) return fromUrl;
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (fromEnv && fs.existsSync(path.join(fromEnv, "package.json"))) {
    warnings.push(`repo root from CLAUDE_PROJECT_DIR (${fromEnv}); import.meta.url gave ${fromUrl}`);
    return path.resolve(fromEnv);
  }
  return fromUrl;
}

function parseViewport(raw: string | undefined, warnings: string[]): { width: number; height: number } {
  const def = { width: 1280, height: 720 };
  if (!raw) return def;
  const m = /^(\d{3,5})x(\d{3,5})$/i.exec(raw.trim());
  if (!m) {
    warnings.push(`TUPAIA_VIEWPORT '${raw}' is not WxH; using 1280x720`);
    return def;
  }
  return { width: Number(m[1]), height: Number(m[2]) };
}

function parseOrigin(raw: string | undefined, warnings: string[]): string | null {
  if (raw === undefined || raw.trim() === "") return DEFAULT_LIVE_ORIGIN;
  const v = raw.trim();
  if (v.toLowerCase() === "none") return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
    return u.origin;
  } catch {
    warnings.push(`TUPAIA_LIVE_ORIGIN '${v}' is not an http(s) origin; shared reads are disabled`);
    return null;
  }
}

function flag(raw: string | undefined): boolean {
  return raw !== undefined && /^(1|true|yes|on)$/i.test(raw.trim());
}

function int(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const warnings: string[] = [];
  const repoRoot = findRepoRoot(warnings);
  const liveOrigin = parseOrigin(env.TUPAIA_LIVE_ORIGIN, warnings);

  let envMode: Mode = "local";
  const rawMode = (env.TUPAIA_MODE ?? "").trim().toLowerCase();
  if (rawMode === "live") {
    if (liveOrigin) envMode = "live";
    else warnings.push("TUPAIA_MODE=live ignored because TUPAIA_LIVE_ORIGIN is none/invalid; running local");
  } else if (rawMode && rawMode !== "local") {
    warnings.push(`TUPAIA_MODE '${env.TUPAIA_MODE}' is not local|live; running local`);
  }

  const distDir = path.resolve(env.TUPAIA_DIST || path.join(repoRoot, "dist"));
  let outDir = env.TUPAIA_OUT ? path.resolve(env.TUPAIA_OUT) : path.join(repoRoot, ".tupaia-mcp-out");
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch {
    const fallback = path.join(os.tmpdir(), "tupaia-mcp-out");
    warnings.push(`cannot create ${outDir}; using ${fallback}`);
    outDir = fallback;
    fs.mkdirSync(outDir, { recursive: true });
  }

  return {
    repoRoot,
    mcpRoot: path.join(repoRoot, "mcp"),
    distDir,
    outDir,
    envMode,
    liveOrigin,
    viewport: parseViewport(env.TUPAIA_VIEWPORT, warnings),
    snapshotsMax: int(env.TUPAIA_SNAPSHOTS, 10, 1, 50),
    undoDepth: int(env.TUPAIA_UNDO_DEPTH, 10, 1, 50),
    headed: flag(env.TUPAIA_HEADED),
    offline: flag(env.TUPAIA_OFFLINE),
    testHooks: flag(env.TUPAIA_TEST_HOOKS),
    warnings
  };
}

/** Mutable runtime mode. It starts at the env mode and can only drop to local. */
export class ModeState {
  #mode: Mode;
  #dropped = false;
  constructor(envMode: Mode) {
    this.#mode = envMode;
  }
  get mode(): Mode {
    return this.#mode;
  }
  get droppedFromLive(): boolean {
    return this.#dropped;
  }
  dropToLocal(): void {
    if (this.#mode === "live") this.#dropped = true;
    this.#mode = "local";
  }
}

/** VERSION string from dist/versioning.js, or null. */
export function readDistVersion(distDir: string): string | null {
  try {
    const src = fs.readFileSync(path.join(distDir, "versioning.js"), "utf8");
    return /const VERSION = "([^"]+)"/.exec(src)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The /index-*.js entry referenced by dist/index.html, or null. */
export function readDistEntry(distDir: string): string | null {
  try {
    const html = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
    return /src="\/(index-[^"]+\.js)"/.exec(html)?.[1] ?? null;
  } catch {
    return null;
  }
}
