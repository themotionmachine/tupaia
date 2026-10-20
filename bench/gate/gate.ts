// Host gate for the opt-in WebGL renderer (?renderer=gpu). One CLI for every check the Codex harness ran from
// outside git (control/tupaia-checks-v15.py and control/opt-in-run-check.py), plus three tiers.
//
//   node bench/gate/gate.ts <check|tier> [key=value ...]      (npm run gate -- <check> ...)
//
// Browser/GPU checks take the host lock on /tmp/tupaia-host-gates.lock (host-lock.ts), across every worktree:
// correctness checks a SHARED slot (at most TUPAIA_GATE_SLOTS, default 2, at once), timing checks the EXCLUSIVE lock
// (nothing else in a browser; it is the same flock hostlock.py takes). Node-only checks take neither.
// Evidence goes to ${TUPAIA_GATE_OUT:-~/.tupaia-gates}/<worktree>/<check>-<timestamp>/, never into the repo.
// stdout gets exactly one compact JSON line; progress and the tier table go to stderr.
// Exit 0 = pass, 1 = check failed, 2 = usage or environment error. See docs/performance/webgl-rewrite/GATE.md.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { FAMILIES, FAMILY_NAMES, parsePresets, parseZooms, STYLE_PRESETS, selectFamilies } from "../host/golden-families.ts";
import { HostLock, type LockMode, slotCount } from "./host-lock.ts";
import { nonPassing } from "../integration-fixture.ts";
import { parseArms } from "../host/editor-replay-core.ts";
import { LAUNCHERS } from "../host/launcher.ts";
import { judgePresets, summarizePresets } from "../host/census-core.ts";

const REPO = resolve(import.meta.dirname, "../..");
const NODE = process.execPath;
const BIN = join(REPO, "node_modules/.bin");
const LOCK_PATH = process.env.TUPAIA_HOST_LOCK || "/tmp/tupaia-host-gates.lock";
const GATE_HOME = resolve(process.env.TUPAIA_GATE_OUT || join(homedir(), ".tupaia-gates"));
const OUT_BASE = join(GATE_HOME, basename(REPO));
const FIXTURE_SHA = "f5c0d703e4a21dc608981285644ba05618ed01f45d3d45fb34827087b679f5c0";
const FIXTURE_CACHE = join(GATE_HOME, "fixtures", `shared-v8-${FIXTURE_SHA.slice(0, 8)}.map`);
const DIST_BUILD_PREFIX = ".dist-build-"; // .gitignore
const DIST_OLD_PREFIX = ".dist-old-";
const FIXTURE_LEGACY = "/tmp/tupaia-navigation-shared-v8.map";

type Value = string | number | boolean;
type Args = Record<string, Value>;
type Json = any;

interface Result {
  check: string;
  exit_code: number;
  failure: string | null;
  seconds: number;
  args: Args;
  metrics: Json;
  dir: string;
  log: string;
  report: string | null;
  images?: Record<string, string>;
  log_tail?: string;
  lock_wait_s?: number;
  lock_mode?: LockMode;
}

interface Ctx {
  check: string;
  args: Args;
  dir: string;
  log: string;
  env(extra?: Record<string, string>): Record<string, string>;
  map(): string;
}

interface CheckDef {
  // host lock tier: "shared" for correctness checks, "exclusive" for timing checks, null for node-only checks.
  // Every check with a lock is a browser check: it needs dist/ and the fixture, and runs under nice.
  lock: LockMode | null;
  keys: string[];
  spec?: Record<string, Spec>; // per-check argument specs that override ARG_SPEC
  timeout: number; // seconds, per child process
  run(ctx: Ctx): Promise<Partial<Result>>;
}

// ---------------------------------------------------------------- arguments

// smoke/fidelity `layer=`: any #viewbox family of the golden (golden-families.ts), by element id
const LAYERS = FAMILIES.filter(f => !f.root).map(f => f.id);
interface Spec {
  type: "int" | "bool" | "enum" | "string";
  values?: Value[];
  default?: Value;
  check?: (text: string) => void; // throws on a bad string value
}
const listOf = (parse: (text: string) => unknown) => (text: string) => {
  try {
    parse(text);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
};
const ARG_SPEC: Record<string, Spec> = {
  dpr: { type: "int", values: [1, 2], default: 2 },
  zoom: { type: "int", values: [1, 2, 4, 8], default: 2 },
  block: { type: "int", values: [1, 2, 3, 4, 5], default: 1 },
  layer: { type: "enum", values: LAYERS },
  preamble: { type: "enum", values: ["none", "editors", "roundtrip", "fixture"], default: "none" },
  cohort: { type: "enum", values: ["short", "full"], default: "short" },
  focus: { type: "enum", values: ["all", "route"], default: "all" },
  // integration/replay browser: metal (host GPU, default) or swiftshader (CPU WebGL; reproduces the pre-W1 gate runs)
  launcher: { type: "enum", values: [...LAUNCHERS], default: "metal" },
  // replay (bench/host/editor-replay.ts): editor scripts under bench/host/editor-scripts/, and the arms that replay them
  editors: {
    type: "string",
    default: "all",
    check: text => {
      if (text === "all") return;
      const known = readdirSync(join(REPO, "bench/host/editor-scripts")).filter(f => f.endsWith(".ts") && f !== "common.ts").map(f => f.slice(0, -3));
      const bad = text.split(",").filter(name => !known.includes(name.trim()));
      if (bad.length) throw new UsageError(`editors: unknown ${bad.join(", ")} (have ${known.join(", ")})`);
    }
  },
  arms: { type: "string", default: "svg,gpu,gpu-select", check: listOf(parseArms) },
  denseLabels: { type: "bool", default: false },
  reliefMode: { type: "enum", values: ["compact", "materialized"], default: "compact" },
  phase: { type: "enum", values: ["settled", "motion"], default: "settled" },
  arm: { type: "enum", values: ["svg", "gpu"], default: "gpu" },
  headless: { type: "bool", default: false },
  trace: { type: "bool", default: false },
  world: { type: "enum", values: ["shared", "100k"], default: "100k" },
  gesture: { type: "enum", values: ["pan-near", "pan-wide", "wheel-zoom"], default: "wheel-zoom" },
  culling: { type: "enum", values: ["on", "off"], default: "on" },
  typecheck: { type: "bool", default: true },
  manifest: { type: "string", default: "fresh" },
  dirs: { type: "string" },
  skip: { type: "string", default: "" },
  keep_going: { type: "bool", default: false },
  mode: { type: "enum", values: ["shared", "exclusive"], default: "exclusive" },
  // golden (bench/host/layer-golden.ts)
  layers: { type: "string", default: "all", check: listOf(selectFamilies) },
  k: {
    type: "string",
    default: "1,4",
    check: listOf(text => {
      if (!parseZooms(text).length) throw new Error("k needs at least one zoom");
    })
  },
  coastk: { type: "string", default: "", check: listOf(parseZooms) },
  preset: { type: "string", default: "default", check: listOf(parsePresets) },
  fixture: { type: "string", default: "shared" },
  census: { type: "string" },
  bg: { type: "string", default: "#ffffff", check: listOf(text => { if (!/^#[\da-f]{6}$/i.test(text)) throw new Error("bg must be #rrggbb"); }) },
  // D11 (Ryan, 2026-10-19): over44 plus the per-layer coverage gate is the default; conservative is the strict
  // reading, kept available and always reported (golden-metrics.ts)
  reading: { type: "enum", values: ["over44", "conservative"], default: "over44" },
  keep: { type: "enum", values: ["all", "fail"], default: "all" },
  break: { type: "enum", values: ["none", "drop-batch", "thin-stroke", "drop-icon"], default: "none" },
  // how the golden captures its GPU arm: canvas alone over an opaque cover (default), composite, or probe (both)
  gpu_arm: { type: "enum", values: ["canvas", "composite", "probe"], default: "canvas" },
  // the SVG arm of a family shown as a perf bitmap of its vectors (burg icons, cell mesh): auto = per family, the form the
  // GPU is built to reproduce (vector for burgs, the bitmap as shown for cells); the other is always reported (W3 REF)
  svg_ref: { type: "enum", values: ["auto", "vector", "seen"], default: "auto" },
  // ms between SVG-arm shots that must agree before it counts as settled (0 = one shot)
  settle_ms: { type: "int", default: 400 },
  // emblem COA symbols: pre = rendered before the first capture (default), lazy = left to the app, late = held back
  // until the GPU frame is built and then returned (the lazy-COA race made deterministic; see `coa-race`)
  coa: { type: "enum", values: ["pre", "lazy", "late"], default: "pre" },
  // extra page URL flags for the GPU arm, e.g. params=gpu-native-shapes=1 (gpu-* keys only, "+"-joined for several)
  params: { type: "string", default: "", check: text => { for (const kv of text.split("+").filter(Boolean)) if (!/^gpu-[a-z0-9-]+=[\w.-]*$/.test(kv)) throw new UsageError(`params entry ${kv} must be gpu-<flag>=<value>`); } },
  // census checks (bench/host/{toggle-census,resize-print,customization,memory-cycles}.ts); `break` is overridden per check
  only: { type: "string", default: "" },
  passes: { type: "string", default: "isolated,trade,reorder" },
  steps: { type: "string", default: "" },
  modes: { type: "string", default: "states,heightmap-keep,heightmap-image" },
  strict: { type: "bool", default: false },
  cycles: { type: "int", default: 20 },
  resizes: { type: "int", default: 12 },
  allow: { type: "int", default: 0 }
};
// golden takes a list of device pixel ratios (D5 nightly runs 1,2)
const DPR_LIST: Spec = {
  type: "string",
  default: "2",
  check: text => {
    if (!text.split(",").every(d => d === "1" || d === "2")) throw new UsageError("dpr must be 1, 2 or 1,2");
  }
};

function parseArgs(check: string, raw: string[], allowed: string[], overrides: Record<string, Spec> = {}): Args {
  const args: Args = {};
  const specOf = (key: string) => overrides[key] ?? ARG_SPEC[key];
  for (const item of raw) {
    const at = item.indexOf("=");
    if (at < 1) throw new UsageError(`Bad argument "${item}": use key=value`);
    const key = item.slice(0, at);
    const text = item.slice(at + 1);
    const spec = specOf(key);
    if (!spec || !allowed.includes(key)) throw new UsageError(`Unknown argument "${key}" for ${check}; allowed: ${allowed.join(", ") || "none"}`);
    let value: Value = text;
    if (spec.type === "int") {
      value = Number(text);
      if (!Number.isInteger(value)) throw new UsageError(`${key} must be an integer`);
    } else if (spec.type === "bool") {
      if (!["1", "0", "true", "false"].includes(text)) throw new UsageError(`${key} must be true/false/1/0`);
      value = text === "1" || text === "true";
    }
    if (spec.values && !spec.values.includes(value)) throw new UsageError(`Invalid ${key}=${text}; one of ${spec.values.join(", ")}`);
    spec.check?.(text);
    args[key] = value;
  }
  for (const key of allowed) if (!(key in args) && specOf(key).default !== undefined) args[key] = specOf(key).default!;
  return args;
}

class UsageError extends Error {}
// A usage error about the environment rather than one step (dist/ missing): every later step would hit it too, so a
// tier stops with exit 2 instead of recording a FAIL and going on.
class EnvError extends UsageError {}

// ---------------------------------------------------------------- host lock

// host-lock.ts: shared slots for correctness checks, the exclusive lock for timing checks (GATE.md "Host lock").
const lock = new HostLock({ path: LOCK_PATH, slots: slotCount(), log });
// The per-worktree dist lock (W3b HARNESS; GATE.md "Building dist"). `build` writes a new dist/ off to the side and swaps
// it in under the EXCLUSIVE dist lock; a browser check holds the SHARED dist lock for as long as it reads dist/ (a tier:
// from its first browser step to its last). So a rebuild waits for the checks in this worktree to finish, a check never
// meets a half-written or a swapped-in-mid-run bundle, and checks in the same worktree still run side by side. The lock
// is per worktree (keyed by the repo path), unrelated to the host lock, which is per host.
const DIST_LOCK_PATH = `${LOCK_PATH}.dist-${createHash("sha1").update(REPO).digest("hex").slice(0, 10)}`;
const distLock = new HostLock({ path: DIST_LOCK_PATH, slots: 0, log, detectInherited: false, label: "dist lock" });
const releaseLocks = async () => {
  await distLock.release();
  await lock.release();
};

// ---------------------------------------------------------------- process running

let activeChild: ChildProcess | null = null;

function exec(command: string[], env: Record<string, string>, logPath: string, timeout: number, nice: boolean): Promise<number> {
  const argv = nice ? ["nice", "-n", "5", ...command] : command;
  const fd = openSync(logPath, "a");
  return new Promise(done => {
    // Own process group, so a timeout or ^C also kills Chromium and any grandchildren.
    const child = spawn(argv[0], argv.slice(1), { cwd: REPO, env, stdio: ["ignore", fd, fd], detached: true });
    activeChild = child;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), 5000).unref();
    }, timeout * 1000);
    child.on("error", error => {
      writeFileSync(logPath, `\n[gate] spawn failed: ${error}\n`, { flag: "a" });
    });
    child.on("close", code => {
      clearTimeout(timer);
      closeSync(fd);
      activeChild = null;
      if (timedOut) writeFileSync(logPath, `\n[gate] timed out after ${timeout}s; process group killed\n`, { flag: "a" });
      done(timedOut ? 124 : (code ?? 1));
    });
  });
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {}
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (activeChild) killGroup(activeChild, "SIGKILL");
    void releaseLocks().finally(() => process.exit(130));
  });
}

// ---------------------------------------------------------------- helpers

function log(message: string): void {
  process.stderr.write(`[gate] ${message}\n`);
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.(\d+)Z$/, "-$1Z");
}

function makeDir(check: string): string {
  mkdirSync(OUT_BASE, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    const dir = join(OUT_BASE, `${check}-${stamp()}${attempt ? `-${attempt}` : ""}`);
    try {
      mkdirSync(dir);
      return dir;
    } catch (error: any) {
      if (error.code !== "EEXIST" || attempt > 20) throw error;
    }
  }
}

function readJson(path: string | null): Json {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function tail(path: string, chars: number): string {
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8");
  return text.slice(-chars);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walk(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  if (existsSync(root)) visit(root);
  return files;
}

// Same construction as the python harness: sha256 over (relative path, bytes) of every dist file in path order.
function distFingerprint(): string | null {
  const dist = join(REPO, "dist");
  if (!existsSync(join(dist, "index.html"))) return null;
  const hash = createHash("sha256");
  const files = walk(dist).map(path => relative(dist, path));
  files.sort((a, b) => {
    const x = a.split("/");
    const y = b.split("/");
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return x.length - y.length;
  });
  for (const file of files) {
    hash.update(file);
    hash.update(readFileSync(join(dist, file)));
  }
  return hash.digest("hex");
}

function git(...args: string[]): string {
  return spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).stdout?.trim() ?? "";
}

function resolveFixture(): string {
  const override = process.env.TUPAIA_GATE_MAP;
  if (override) {
    if (!existsSync(override)) throw new UsageError(`TUPAIA_GATE_MAP does not exist: ${override}`);
    if (sha256File(override) !== FIXTURE_SHA) log(`warning: TUPAIA_GATE_MAP is not the shared-v8 fixture (${FIXTURE_SHA.slice(0, 8)})`);
    return override;
  }
  if (existsSync(FIXTURE_CACHE) && sha256File(FIXTURE_CACHE) === FIXTURE_SHA) return FIXTURE_CACHE;
  if (existsSync(FIXTURE_LEGACY) && sha256File(FIXTURE_LEGACY) === FIXTURE_SHA) {
    mkdirSync(dirname(FIXTURE_CACHE), { recursive: true });
    copyFileSync(FIXTURE_LEGACY, FIXTURE_CACHE);
    log(`cached shared-v8 fixture at ${FIXTURE_CACHE}`);
    return FIXTURE_CACHE;
  }
  throw new UsageError(
    `shared-v8 map fixture (sha256 ${FIXTURE_SHA}) not found. Put it at ${FIXTURE_CACHE} ` +
      `(or ${FIXTURE_LEGACY}, or set TUPAIA_GATE_MAP). See GATE.md "Fixture".`
  );
}

const pick = (value: Json, keys: string[]) =>
  value && typeof value === "object" ? Object.fromEntries(keys.filter(k => k in value).map(k => [k, value[k]])) : null;
const round = (value: unknown, digits = 4) => (typeof value === "number" ? Number(value.toFixed(digits)) : value);

function images(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const path of walk(dir)) if (path.endsWith(".png")) found[relative(dir, path).replace(/\.png$/, "")] = path;
  return found;
}

// ---------------------------------------------------------------- check implementations

// Runs one child, then reads the JSON report and derives failure + key metrics.
async function runScript(
  ctx: Ctx,
  command: string[],
  env: Record<string, string>,
  report: string | null,
  timeout: number,
  judge: (report: Json, code: number) => { failure?: string | null; metrics?: Json }
): Promise<Partial<Result>> {
  const code = await exec(command, ctx.env(env), ctx.log, timeout, DEFS[ctx.check] ? DEFS[ctx.check].lock !== null : true);
  const data = readJson(report);
  let failure: string | null = null;
  let metrics: Json = {};
  try {
    const judged = judge(data, code);
    failure = judged.failure ?? null;
    metrics = judged.metrics ?? {};
  } catch (error) {
    failure = `could not read report: ${error}`;
  }
  if (!failure && code === 124) failure = `timed out after ${timeout}s`;
  if (!failure && code !== 0) failure = `exit ${code}`;
  if (!failure && report && !data) failure = "no report written";
  return { exit_code: code, failure, metrics, report: report && existsSync(report) ? report : null };
}

const reportFailure = (data: Json) => (data?.failure ? String(data.failure).slice(0, 2000) : null);
// Integration-family verdict tables: anything but PASS fails the check, whatever the script itself concluded
// (UNTESTED and UNDERCOVERED cohorts once let `integration` pass; 2026-10-19, gpu-main integration-20261019T202113).
const verdictFailure = (data: Json) => {
  if (!data) return null;
  if (!data.verdicts || typeof data.verdicts !== "object") return "report has no verdicts";
  const bad = nonPassing(data.verdicts);
  return bad.length ? `verdicts not PASS: ${bad.join(", ")}` : null;
};

function replayCheck(ctx: Ctx, fixed: Record<string, string>): Promise<Partial<Result>> {
  const report = join(ctx.dir, "replay.json");
  const env = {
    REPLAY_MAP: ctx.map(),
    REPLAY_EDITORS: String(ctx.args.editors ?? "all"),
    REPLAY_ARMS: String(ctx.args.arms ?? "svg,gpu,gpu-select"),
    REPLAY_DPR: String(ctx.args.dpr ?? 2),
    REPLAY_LAUNCHER: String(ctx.args.launcher),
    ...fixed
  };
  return runScript(ctx, nodeScript("bench/host/editor-replay.ts"), env, report, DEFS[ctx.check].timeout, data => ({
    failure: reportFailure(data) ?? verdictFailure(data),
    metrics: data && { summary: data.summary, selftest: data.selftest, adapters: data.adapters, failures: data.failures?.slice(0, 12) }
  }));
}

function vitestMetrics(text: string): Json {
  const files = /Test Files\s+(.+)/.exec(text)?.[1]?.trim();
  const tests = /Tests\s+(.+)/.exec(text)?.[1]?.trim();
  return { test_files: files ?? null, tests: tests ?? null };
}

const nodeScript = (path: string) => [NODE, path];

function smokeLike(script: string, extra: (ctx: Ctx) => Record<string, string> = () => ({})) {
  return async (ctx: Ctx) => {
    const name = ctx.check;
    const env: Record<string, string> = {
      SMOKE_NAME: name,
      SMOKE_DPR: String(ctx.args.dpr),
      SMOKE_ZOOM: String(ctx.args.zoom),
      NAV_RENDERER: "gpu",
      ...extra(ctx)
    };
    if (ctx.args.layer) env.SMOKE_ONLY_LAYER = String(ctx.args.layer);
    return runScript(ctx, nodeScript(`bench/host/${script}`), env, join(ctx.dir, `${name}.json`), DEFS[ctx.check].timeout, data => ({
      failure: reportFailure(data),
      metrics: smokeMetrics(ctx.check, data)
    }));
  };
}

function smokeMetrics(check: string, data: Json): Json {
  if (!data) return {};
  const status = data.status ?? {};
  const metrics: Json = {
    active: status.active ?? null,
    fallbackReason: status.fallbackReason || undefined,
    errors: data.errors?.length ?? 0,
    diff: data.diff && Object.fromEntries(Object.entries(pick(data.diff, ["changedFraction", "over16Fraction", "maxDelta", "meanMaxChannelDelta"])!).map(([k, v]) => [k, round(v, 6)])),
    refinementWaitMs: data.refinementWaitMs
  };
  if (data.animation) {
    const a = data.animation;
    const crops: Json[] = a.pixelCheck?.crops ?? [];
    metrics.animation = {
      ...pick(a, ["tradeLayerOn", "markerCount", "domMarkers", "gpuMarkers", "moved", "gpuFrameAdvance", "skipped", "failures"]),
      pixel: a.pixelCheck && (a.pixelCheck.skipped ? { skipped: a.pixelCheck.skipped } : { crops: a.pixelCheck.cropCount, minIou: round(a.pixelCheck.minIou, 3), inkRatios: crops.map(c => round(c.inkRatio, 3)) })
    };
  }
  if (data.lifecycle) metrics.heapGrowthBytes = data.lifecycle.heapGrowthBytes;
  if (data.contextRestore) metrics.contextRestore = { supported: data.contextRestore.supported, restored: data.contextRestore.restored?.state ?? null };
  if (data.hatchMotion) {
    metrics.hatch = {
      noReprepare: data.hatchMotion.noReprepare,
      maxOver16Fraction: Math.max(...data.hatchMotion.comparisons.map((r: Json) => r.over16Fraction)),
      comparisons: data.hatchMotion.comparisons
    };
  }
  if (Array.isArray(data.runs) && check === "navigation") {
    metrics.runs = data.runs.map((r: Json) => ({
      world: r.world,
      gesture: r.gesture,
      frameP95: round(r.frame?.p95, 2),
      eventToNextRafP95: round(r.eventToNextRaf?.p95, 2),
      gpuPresentedFraction: round(r.gpuPresentedFraction, 3)
    }));
  }
  return metrics;
}

function integrationMetrics(data: Json): Json {
  if (!data) return {};
  return {
    verdicts: data.verdicts,
    pageErrors: data.pageErrors?.length ?? null,
    blockedRequests: data.blockedRequests?.length ?? null,
    failures: data.failures?.length ?? null,
    resyncCohort: data.resyncCohort ? Object.fromEntries(Object.entries(data.resyncCohort).map(([k, v]: [string, Json]) => [k, pick(v, ["eligible", "resynced", "dropped"])])) : undefined,
    adapter: data.adapter?.renderer ?? undefined,
    staleWindow: Object.fromEntries(
      (["routeCohort", "markerCohort"] as const).filter(k => data[k]).map(k => [k, { eligible: data[k].eligible, ineligible: data[k].ineligible, wheelToClickMs: data[k].wheelToClickMs }])
    )
  };
}

function compactCpuProfiles(dir: string): Json[] {
  const out: Json[] = [];
  for (const path of walk(dir).filter(p => p.endsWith(".cpuprofile"))) {
    const profile = readJson(path);
    if (!profile) continue;
    const nodes = new Map<number, Json>((profile.nodes ?? []).map((n: Json) => [n.id, n]));
    const cost = new Map<number, number>();
    (profile.samples ?? []).forEach((id: number, i: number) => cost.set(id, (cost.get(id) ?? 0) + (profile.timeDeltas?.[i] ?? 0)));
    const top = [...cost.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, us]) => {
        const frame = nodes.get(id)?.callFrame ?? {};
        return { self_ms: round(us / 1000, 3), fn: frame.functionName || "(anonymous)", url: basename(frame.url || ""), line: frame.lineNumber };
      });
    out.push({ path, top_self: top });
  }
  return out;
}

async function pairedBlock(ctx: Ctx): Promise<Partial<Result>> {
  const before = distFingerprint();
  const env = {
    BENCH_AB_REPEATS: "2",
    BENCH_AB_SEED: String(7319 + Number(ctx.args.block)),
    BENCH_AB_OUTPUT: ctx.dir,
    ...benchNavEnv(ctx, String(ctx.args.dpr), false)
  };
  const code = await exec(nodeScript("bench/renderer-ab-run.ts"), ctx.env(env), ctx.log, DEFS.paired.timeout, true);
  const after = distFingerprint();
  const receipt = { check: "paired", dpr: ctx.args.dpr, block: ctx.args.block, exit_code: code, dist_before: before, dist_after: after, dist_unchanged: before === after, directory: ctx.dir };
  writeFileSync(join(ctx.dir, "host-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  const report = join(ctx.dir, "report.json");
  const data = readJson(report);
  let failure: string | null = null;
  if (code === 124) failure = `timed out after ${DEFS.paired.timeout}s`;
  else if (code !== 0) failure = `exit ${code}`;
  else if (before !== after) failure = "dist changed during the paired block";
  else if (!data) failure = "no report written";
  return { exit_code: code, failure, report: data ? report : null, metrics: { block: ctx.args.block, slots: data?.schedule?.length ?? null, dist: before?.slice(0, 12) } };
}

function benchNavEnv(ctx: Ctx, dpr: string, headless: boolean): Record<string, string> {
  return {
    BENCH_MAP: ctx.map(),
    BENCH_MAP_LABEL: "shared",
    BENCH_WORLDS: "shared,100k",
    BENCH_DPR: dpr,
    BENCH_SAMPLES: "1",
    BENCH_FRAMES: "120",
    BENCH_FONT_CDN: "1",
    BENCH_HEADLESS: headless ? "1" : "0",
    BENCH_CHANNEL: "chromium",
    BENCH_ANGLE: "metal",
    BENCH_GPU: "1"
  };
}

// The latest passing block 1..5 at this dpr, all built from one dist, preferring the current dist.
function findPairedBlocks(dpr: number): string[] {
  if (!existsSync(OUT_BASE)) return [];
  const receipts = readdirSync(OUT_BASE)
    .filter(name => name.startsWith("paired-"))
    .sort()
    .reverse()
    .map(name => ({ dir: join(OUT_BASE, name), receipt: readJson(join(OUT_BASE, name, "host-receipt.json")) }))
    .filter(({ receipt }) => receipt && receipt.exit_code === 0 && receipt.dist_unchanged && receipt.dpr === dpr);
  const current = distFingerprint();
  const fingerprints = [current, ...new Set(receipts.map(r => r.receipt.dist_before))];
  for (const fingerprint of fingerprints) {
    const blocks: string[] = [];
    for (let block = 1; block <= 5; block++) {
      const hit = receipts.find(r => r.receipt.block === block && r.receipt.dist_before === fingerprint);
      if (hit) blocks.push(hit.dir);
    }
    if (blocks.length === 5) return blocks;
  }
  return [];
}

async function metricsCheck(ctx: Ctx): Promise<Partial<Result>> {
  let manifestPath = String(ctx.args.manifest);
  const env: Record<string, string> = {};
  const captures: Json[] = [];
  if (manifestPath === "fresh") {
    // Capture the eight dpr x zoom cells from the current dist with the smoke harness, then measure them.
    const fingerprint = distFingerprint()!;
    const captureDir = join(ctx.dir, "captures");
    mkdirSync(captureDir);
    const pairs: Json[] = [];
    for (const dpr of [1, 2]) {
      for (const zoom of [1, 2, 4, 8]) {
        const name = `smoke-d${dpr}-z${zoom}`;
        log(`metrics: capturing ${name}`);
        const code = await exec(
          nodeScript("bench/host/gpu-smoke.ts"),
          ctx.env({ GATE_OUT_DIR: captureDir, SMOKE_NAME: name, SMOKE_DPR: String(dpr), SMOKE_ZOOM: String(zoom), NAV_RENDERER: "gpu" }),
          ctx.log,
          DEFS.smoke.timeout,
          true
        );
        const report = join(captureDir, `${name}.json`);
        const data = readJson(report);
        captures.push({ dpr, zoom, exit_code: code, failure: data?.failure ?? (data ? null : "no report") });
        if (code !== 0 || !data || data.failure) {
          return { exit_code: code || 1, failure: `capture ${name} failed: ${data?.failure ?? `exit ${code}`}`, metrics: { captures }, report: data ? report : null };
        }
        const gpu = join(captureDir, `${name}-gpu.png`);
        const svg = join(captureDir, `${name}-svg.png`);
        pairs.push({ dpr, zoom, gpu, svg, report, gpu_sha256: sha256File(gpu), svg_sha256: sha256File(svg) });
      }
    }
    if (distFingerprint() !== fingerprint) return { exit_code: 1, failure: "dist changed during capture", metrics: { captures } };
    manifestPath = join(ctx.dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ schema: 1, source_job: "gate metrics", render_dist_fingerprint: fingerprint, pairs }, null, 2) + "\n");
    env.BENCH_METRICS_EXPECTED_FINGERPRINT = fingerprint;
  } else {
    manifestPath = resolve(manifestPath);
    if (!existsSync(manifestPath)) throw new UsageError(`manifest not found: ${manifestPath}`);
    env.BENCH_METRICS_EXPECTED_FINGERPRINT = readJson(manifestPath)?.render_dist_fingerprint ?? "";
  }
  const report = join(ctx.dir, "report.json");
  Object.assign(env, { BENCH_METRICS_MANIFEST: manifestPath, BENCH_METRICS_OUTPUT: report });
  const result = await runScript(ctx, nodeScript("bench/fidelity-metrics-run.ts"), env, report, DEFS.metrics.timeout, data => {
    const summary = data?.summary;
    const rows = (data?.rows ?? []).map((r: Json) => ({
      cell: `${r.dpr}x${r.zoom}`,
      ssim: round(r.ssim?.ssim, 5),
      over16: round(r.rgb?.over16Fraction, 5),
      maxDelta: r.rgb?.maxDelta,
      gates: r.gates
    }));
    // Acceptance: every pair passes the SSIM gate. over16 is reported, not gated: the P2 baseline is 5/8.
    const failure = summary && summary.ssimPass < summary.pairs ? `ssim gate failed on ${summary.pairs - summary.ssimPass}/${summary.pairs} pairs` : null;
    return { failure, metrics: { summary, rows, manifest: manifestPath } };
  });
  if (captures.length) result.metrics = { ...result.metrics, captures: captures.length };
  return result;
}

// `fixture=` of the golden: the shared-v8 snapshot, the parity fixture (FIX packet), or a path to a .map file.
function resolveNamedFixture(name: string): string {
  if (name === "shared") return resolveFixture();
  if (name === "parity") {
    const candidates = [process.env.TUPAIA_GATE_PARITY_MAP, join(REPO, "tests/fixtures/parity/parity-v1.map"), join(REPO, "tests/fixtures/parity/parity.map"), join(GATE_HOME, "fixtures", "parity.map")];
    const found = candidates.find(path => path && existsSync(path));
    if (!found)
      throw new UsageError(
        `parity fixture not found (TUPAIA_GATE_PARITY_MAP, tests/fixtures/parity/parity.map or ${join(GATE_HOME, "fixtures", "parity.map")}); ` +
          "it comes from the FIX packet. Use fixture=shared meanwhile."
      );
    return found!;
  }
  const path = resolve(name);
  if (!existsSync(path)) throw new UsageError(`fixture not found: ${path}`);
  return path;
}

// the W3 REF knobs of the golden: SVG reference form, SVG settle shots, how emblem COA symbols arrive
const goldenRefEnv = (ctx: Ctx): Record<string, string> => ({
  GOLDEN_SVG_REF: String(ctx.args.svg_ref),
  GOLDEN_SETTLE_MS: String(ctx.args.settle_ms),
  GOLDEN_PRECOA: ctx.args.coa === "pre" ? "1" : "0",
  GOLDEN_COA_LATE: ctx.args.coa === "late" ? "1" : "0"
});

async function goldenCheck(ctx: Ctx): Promise<Partial<Result>> {
  const report = join(ctx.dir, "golden.json");
  const env: Record<string, string> = {
    GOLDEN_MAP: ctx.map(),
    GOLDEN_LAYERS: String(ctx.args.layers),
    GOLDEN_K: String(ctx.args.k),
    GOLDEN_COAST_K: String(ctx.args.coastk),
    GOLDEN_DPR: String(ctx.args.dpr),
    GOLDEN_PRESET: String(ctx.args.preset),
    GOLDEN_BG: String(ctx.args.bg),
    GOLDEN_READING: String(ctx.args.reading),
    GOLDEN_KEEP: String(ctx.args.keep),
    GOLDEN_BREAK: String(ctx.args.break),
    GOLDEN_GPU_ARM: String(ctx.args.gpu_arm),
    GOLDEN_PARAMS: String(ctx.args.params ?? ""),
    ...goldenRefEnv(ctx)
  };
  if (ctx.args.census) {
    const path = resolve(String(ctx.args.census));
    if (!existsSync(path)) throw new UsageError(`census expectations not found: ${path}`);
    env.GOLDEN_CENSUS = path;
  }
  const result = await runScript(ctx, nodeScript("bench/host/layer-golden.ts"), env, report, DEFS.golden.timeout, data => {
    const failing = (data?.cells ?? []).filter((c: Json) => !c.pass);
    return {
      failure: reportFailure(data),
      metrics: data && {
        summary: data.summary,
        fixture: data.fixture?.sha256?.slice(0, 12),
        break: data.args?.break,
        reading: data.args?.reading,
        arm: data.args?.gpuArm,
        // requests the route allowlist aborted (each logs "Failed to load resource: net::ERR_FAILED")
        aborted: data.aborted,
        failing: failing.slice(0, 20).map((c: Json) => ({
          cell: c.key,
          class: c.class,
          ssim: round(c.metrics?.ssim, 4),
          over16: round(c.metrics?.over16Fraction, 5),
          over44: round(c.metrics?.over44Fraction, 5),
          inkRatio: round(c.metrics?.inkRatio, 3),
          over16OfInk: round(c.metrics?.over16OfInk, 4),
          census: c.census,
          why: c.failures?.[0]
        }))
      }
    };
  });
  // Every cell's PNGs stay in the evidence dir; the result line lists the failing cells' only.
  const images: Record<string, string> = {};
  for (const cell of readJson(report)?.cells ?? [])
    if (!cell.pass && cell.images) for (const [kind, path] of Object.entries(cell.images)) images[`${cell.key}/${kind}`] = join(ctx.dir, String(path));
  result.images = images;
  return result;
}

// The lazy-COA race, made deterministic (W3 REF). The app inserts each emblem's COA symbol into #coas (inside
// svg#defElements, outside svg#map) only after fetching its charges, so a GPU prepare can precede it; the renderer
// observes svg#map alone, so it never learns the symbols arrived and keeps a frame without emblems. The golden pre-renders
// the symbols (`coa=pre`, its default), which is why it cannot see this. Here, per cell, the GPU frame is built with #coas
// empty (current and refined, emblems absent) and the symbols are then put back, exactly what a late fetch does; the
// emblems cell must then follow them. A renderer that does not fails with "empty in GPU arm" and a whole-frame gap, with
// `coaLate.reprepared` false in the report; only that is labelled a race. The renderer has observed #coas since W3 LIFE3.
async function coaRaceCheck(ctx: Ctx): Promise<Partial<Result>> {
  Object.assign(ctx.args, { layers: "emblems", coastk: "", preset: "default", bg: "#ffffff", reading: "over44", keep: "all", break: "none", gpu_arm: "canvas", params: "", svg_ref: "auto", settle_ms: 400, coa: "late" });
  const result = await goldenCheck(ctx);
  const cells: Json[] = readJson(join(ctx.dir, "golden.json"))?.cells ?? [];
  const problems: string[] = [];
  if (!cells.length) problems.push("no emblems cell was captured");
  for (const cell of cells) if (!cell.coaLate?.symbols) problems.push(`${cell.key}: the symbols were not held back (the check is vacuous)`);
  const late = cells.map(c => ({ cell: c.key, pass: c.pass, symbols: c.coaLate?.symbols, reprepared: c.coaLate?.reprepared, inkSvg: c.metrics?.inkSvg, inkGpu: c.metrics?.inkGpu }));
  // Only a cell whose renderer did not prepare again after the symbols came back is the race. Any other failure (GPU not
  // active, a harness error, a metric gap although it did re-prepare) is a golden failure and keeps its own label.
  const raced = cells.filter(c => !c.pass && c.coaLate && c.coaLate.reprepared === false).map(c => c.key);
  let label: string | null = null;
  if (result.failure && !problems.length) label = raced.length ? `lazy-COA race (no re-prepare after the symbols returned: ${raced.join(", ")}): ${result.failure}` : `golden failed, not the lazy-COA race (every failing cell re-prepared, or has no coaLate): ${result.failure}`;
  const failure = [label, ...problems].filter(Boolean).join(" | ") || null;
  return { ...result, exit_code: failure ? 1 : 0, failure, metrics: { ...result.metrics, late } };
}

// Re-proves that the golden harness can still tell pass from fail, on the shared fixture (so it does not wait for the
// parity map), centred cameras, k 1, dpr 2:
//   clean:       ocean, GOLDEN_SELFTEST_STROKE and GOLDEN_SELFTEST_ICON must pass, captured with GOLDEN_GPU_ARM=probe,
//                which also proves the GPU arm is the canvas alone (no pixel of the SVG under it shows through);
//   drop-batch:  ocean with its bottom-most fill batch dropped must fail on a whole-frame metric gate;
//   thin-stroke: rulers (two native strokes, 6.6K px) with every stroke batch at half width must fail the D11
//                coverage gate while every whole-frame gate passes: the case D11 exists for;
//   drop-icon:   goods (15K small native fills: the resource icons) with every 4th leaf batch dropped must fail the
//                coverage gate (its whole-frame gates fail too: a quarter of goods is 4 % of the frame).
// A broken arm that breaks nothing, or fails on a harness error instead of a metric, fails the self-test.
// shared fixture families that pass clean at k 1 and have the batch kinds the breaks need (2026-10-20 survey: relief,
// markers and burgs are single compat rasters there, and no family draws sprites)
const SELFTEST_STROKE = "rulers";
const SELFTEST_ICON = "goods";
async function goldenSelftestCheck(ctx: Ctx): Promise<Partial<Result>> {
  const base = { GOLDEN_MAP: ctx.map(), GOLDEN_K: "1", GOLDEN_DPR: "2", GOLDEN_PRESET: "default", GOLDEN_READING: String(ctx.args.reading), GOLDEN_KEEP: "all" };
  const runs = [
    { arm: "clean", layers: ["ocean", SELFTEST_STROKE, SELFTEST_ICON], brk: "none", gpuArm: "probe" },
    { arm: "drop-batch", layers: ["ocean"], brk: "drop-batch", gpuArm: "canvas" },
    { arm: "thin-stroke", layers: [SELFTEST_STROKE], brk: "thin-stroke", gpuArm: "canvas" },
    { arm: "drop-icon", layers: [SELFTEST_ICON], brk: "drop-icon", gpuArm: "canvas" },
    // W3 REF: the burg icons are shown by the app as a blurry bitmap of their vectors; the golden must judge the GPU against
    // the vector form (this cell passes) and still report the bitmap as shown (which fails the coverage gate at k 2)
    { arm: "dense-ref", layers: ["burgs"], brk: "none", gpuArm: "canvas", parity: true, k: "2" }
  ];
  const arms: Record<string, Json> = {};
  for (const run of runs) {
    const dir = join(ctx.dir, run.arm);
    mkdirSync(dir, { recursive: true });
    const env = { ...base, ...(run.parity ? { GOLDEN_MAP: resolveNamedFixture("parity"), GOLDEN_K: run.k ?? "1" } : {}), GATE_OUT_DIR: dir, GOLDEN_LAYERS: run.layers.join(","), GOLDEN_BREAK: run.brk, GOLDEN_GPU_ARM: run.gpuArm };
    const code = await exec(nodeScript("bench/host/layer-golden.ts"), ctx.env(env), ctx.log, DEFS["golden-selftest"].timeout, true);
    arms[run.arm] = { code, data: readJson(join(dir, "golden.json")) };
  }
  const cellOf = (arm: string, family: string): Json | undefined => (arms[arm].data?.cells ?? []).find((c: Json) => c.family === family);
  const problems: string[] = [];
  const clean = arms.clean;
  if (clean.code !== 0 || !clean.data) problems.push(`clean run exit ${clean.code}, report ${clean.data ? "written" : "missing"}`);
  else
    for (const family of runs[0].layers) {
      const cell = cellOf("clean", family);
      if (!cell) problems.push(`clean run captured no ${family} cell`);
      else if (!cell.pass) problems.push(`clean ${family} k=1 should pass and failed: ${cell.failures?.[0] ?? "?"}`);
      else if (!cell.showThrough || cell.showThrough.composite || cell.showThrough.magenta)
        problems.push(`clean ${family}: GPU arm not proven canvas-only (${JSON.stringify(cell.showThrough ?? null)})`);
    }
  const broken = (arm: string, family: string, tripped: (gates: Json) => boolean, what: string) => {
    const run = arms[arm];
    const cell = run.data && cellOf(arm, family);
    if (run.code !== 0 || !run.data) return problems.push(`${arm} run exit ${run.code}, report ${run.data ? "written" : "missing"}`);
    if (!cell) return problems.push(`${arm} run captured no ${family} cell`);
    if (!cell.dropped?.dropped) return problems.push(`break=${arm} changed nothing in ${family}: the self-test is vacuous`);
    if (cell.pass) return problems.push(`break=${arm} passed: the golden can no longer see ${what}`);
    if ((cell.failures ?? []).some((f: string) => f.startsWith("harness:"))) return problems.push(`${arm} failed on a harness error, not a metric: ${cell.failures[0]}`);
    if (!cell.gates || !tripped(cell.gates)) return problems.push(`${arm} failed but not on the gate that should see ${what}: ${cell.failures?.[0]}`);
  };
  broken("drop-batch", "ocean", g => !(g.ssim && g.over16 && g[String(ctx.args.reading)]), "a dropped path");
  broken("thin-stroke", SELFTEST_STROKE, g => g.coverage === false && g.ssim && g.over16 && g[String(ctx.args.reading)], "a thinner stroke the whole-frame gates miss");
  broken("drop-icon", SELFTEST_ICON, g => g.coverage === false, "dropped icons");
  const dense = arms["dense-ref"].data && cellOf("dense-ref", "burgs");
  if (arms["dense-ref"].code !== 0 && !dense) problems.push(`dense-ref run exit ${arms["dense-ref"].code}, no burgs cell`);
  else if (!dense) problems.push("dense-ref run captured no burgs cell");
  else if (!dense.pass) problems.push(`dense-ref: burgs k=2 should pass against the vector form and failed: ${dense.failures?.[0] ?? "?"}`);
  else if (dense.svgRef !== "vector") problems.push(`dense-ref: the burg reference was "${dense.svgRef}", not the vector form (the app shows a bitmap at k 2)`);
  else if (!dense.otherRef || dense.otherRef.ref !== "seen" || dense.otherRef.pass) problems.push(`dense-ref: the bitmap as shown should fail coverage against the GPU's crisp icons and did not (${JSON.stringify(dense.otherRef ?? null)}): the check no longer separates blur from a real gap`);
  const metricsOf = (c: Json) =>
    c && {
      pass: c.pass,
      ssim: round(c.metrics?.ssim, 4),
      over16: round(c.metrics?.over16Fraction, 5),
      over44: round(c.metrics?.over44Fraction, 5),
      inkRatio: round(c.metrics?.inkRatio, 3),
      over16OfInk: round(c.metrics?.over16OfInk, 4),
      wholeFrame: c.gates ? c.gates.ssim && c.gates.over16 && c.gates[String(ctx.args.reading)] : null,
      coverage: c.gates?.coverage ?? null,
      showThrough: c.showThrough ?? undefined,
      dropped: c.dropped?.dropped ?? undefined,
      why: c.failures?.[0] ?? null
    };
  const cells: Record<string, Json> = {};
  const images: Record<string, string> = {};
  for (const run of runs)
    for (const family of run.layers) {
      const cell = cellOf(run.arm, family);
      cells[`${run.arm}/${family}`] = metricsOf(cell);
      if (cell?.images) for (const [kind, path] of Object.entries(cell.images)) images[`${run.arm}/${family}/${kind}`] = join(ctx.dir, run.arm, String(path));
    }
  return { exit_code: problems.length ? 1 : 0, failure: problems.length ? problems.join(" | ") : null, metrics: { reading: ctx.args.reading, cells }, images };
}


// Consumers of the document (REWRITE-PLAN rows 31-38 and 40): save, export, 3D, minimap, dialogs, cloud, with the gpu
// arm compared against the svg arm of the same world and build (bench/host/consumers.ts). `break=` is the self-test:
// it deliberately perturbs the gpu arm's data and the run must then FAIL.
async function consumersCheck(ctx: Ctx): Promise<Partial<Result>> {
  const report = join(ctx.dir, "consumers.json");
  const worlds = String(ctx.args.worlds);
  const env: Record<string, string> = {
    CONSUMERS_WORLDS: worlds,
    CONSUMERS_MAP: ctx.map(),
    CONSUMERS_DPR: String(ctx.args.dpr),
    CONSUMERS_BREAK: String(ctx.args.break),
    CONSUMERS_CONTROL: ctx.args.control ? "1" : "0"
  };
  if (worlds.split(",").includes("parity")) env.CONSUMERS_PARITY_MAP = resolveNamedFixture("parity");
  const result = await runScript(ctx, nodeScript("bench/host/consumers.ts"), env, report, DEFS.consumers.timeout, data => {
    const checks: Json[] = data?.checks ?? [];
    const failing = checks.filter(c => c.status === "FAIL");
    return {
      failure: reportFailure(data),
      metrics: data && {
        rows: data.rows,
        checks: checks.length,
        failed: failing.length,
        break: data.args?.break,
        control: data.args?.control || undefined,
        fixtures: data.fixtures,
        failing: failing.slice(0, 20).map((c: Json) => ({ row: c.row, id: c.id, why: String(c.detail).slice(0, 240), evidence: c.evidence })),
        info: checks.filter(c => c.status === "INFO").slice(0, 20).map((c: Json) => `${c.id}: ${String(c.detail).slice(0, 160)}`)
      }
    };
  });
  // Evidence of a failing pixel check: the file from each arm (evidence is "<world>/{svg,gpu}/<file>").
  const images: Record<string, string> = {};
  for (const c of (readJson(report)?.checks ?? []).filter((c: Json) => c.status === "FAIL" && typeof c.evidence === "string" && c.evidence.endsWith(".png"))) {
    const m = /^(.+)\/\{(.+),(.+)\}\/(.+)$/.exec(c.evidence);
    if (m) for (const arm of [m[2], m[3]]) images[`${m[1]}/${arm}/${m[4]}`] = join(ctx.dir, m[1], arm, m[4]);
  }
  result.images = images;
  return result;
}

// Legacy corpus (REWRITE-PLAN row 33): maps written by old versions load and migrate under svg and gpu, with the
// census, the save fixed point, and a per-map golden at k 1 judged against the SVG arm (bench/host/corpus-load.ts).
function corpusManifestIds(): string[] {
  return JSON.parse(readFileSync(join(REPO, "tests/fixtures/corpus/manifest.json"), "utf8")).entries.map((e: Json) => e.id);
}
async function corpusCheck(ctx: Ctx): Promise<Partial<Result>> {
  const report = join(ctx.dir, "corpus.json");
  const env: Record<string, string> = {
    CORPUS_MAPS: String(ctx.args.maps),
    CORPUS_DPR: String(ctx.args.dpr),
    CORPUS_GOLDEN: ctx.args.golden ? "1" : "0",
    CORPUS_CONTROL: ctx.args.control ? "1" : "0",
    CORPUS_STRICT: ctx.args.strict ? "1" : "0",
    CORPUS_BREAK: String(ctx.args.break)
  };
  const result = await runScript(ctx, nodeScript("bench/host/corpus-load.ts"), env, report, DEFS.corpus.timeout, data => {
    const checks: Json[] = data?.checks ?? [];
    const failing = checks.filter(c => c.status === "FAIL");
    return {
      failure: reportFailure(data),
      metrics: data && {
        maps: data.args?.maps,
        checks: checks.length,
        failed: failing.length,
        break: data.args?.break,
        coverage: data.coverage && { gates: data.coverage.gates, unreached: data.coverage.unreached },
        golden: Object.fromEntries(Object.entries(data.maps ?? {}).map(([id, m]: [string, Json]) => [id, m.golden])),
        failing: failing.slice(0, 20).map((c: Json) => ({ id: c.id, why: String(c.detail).slice(0, 240), evidence: c.evidence })),
        info: checks.filter(c => c.status === "INFO" && /unreachable|empty/.test(c.id)).slice(0, 20).map((c: Json) => `${c.id}: ${String(c.detail).slice(0, 160)}`)
      }
    };
  });
  // golden PNGs of failing cells stay in the evidence dir: <map>/golden/cells/...
  return result;
}

// Re-proves that the corpus harness can still tell pass from fail: the gpu arm's first save and census are perturbed
// (break=tamper, one small map, no golden) and the run must FAIL on exactly the save-equality and census-equality checks.
async function corpusSelftestCheck(ctx: Ctx): Promise<Partial<Result>> {
  const dir = join(ctx.dir, "broken");
  mkdirSync(dir, { recursive: true });
  const report = join(dir, "corpus.json");
  const env = { CORPUS_MAPS: "legacy-v1.123", CORPUS_DPR: "2", CORPUS_GOLDEN: "0", CORPUS_BREAK: "tamper", GATE_OUT_DIR: dir };
  const code = await exec(nodeScript("bench/host/corpus-load.ts"), ctx.env(env), ctx.log, DEFS["corpus-selftest"].timeout, true);
  const data = readJson(report);
  const failing: Json[] = (data?.checks ?? []).filter((c: Json) => c.status === "FAIL");
  const failed = (suffix: string) => failing.some(c => String(c.id).endsWith(suffix));
  const problems: string[] = [];
  if (!data) problems.push(`no report written (exit ${code})`);
  else if (String(data.failure ?? "").startsWith("harness:")) problems.push(`harness error: ${data.failure}`);
  else {
    if (!failed("save.arms-equal-1")) problems.push("break=tamper did not fail save.arms-equal-1: the harness can no longer see a changed save");
    if (!failed("census.arms-equal")) problems.push("break=tamper did not fail census.arms-equal: the harness can no longer see a changed census");
    const unexpected = failing.filter(c => !/(save\.arms-equal-1|census\.arms-equal|save\.gpu\.fixed-point|save\.arms-equal-[23])/.test(String(c.id)));
    if (unexpected.length) problems.push(`unexpected failures: ${unexpected.slice(0, 4).map(c => `${c.id} (${String(c.detail).slice(0, 80)})`).join("; ")}`);
  }
  return { exit_code: problems.length ? 1 : 0, failure: problems.length ? problems.join(" | ") : null, metrics: { broken_failing: failing.map(c => c.id).slice(0, 12), checks: data?.checks?.length ?? 0 } };
}

// Re-proves that the consumers harness can still tell pass from fail: the gpu arm's text save and PNG export are
// deliberately perturbed (break=tamper, save and export steps only, parity fixture) and the run must FAIL on exactly
// the save-equality and PNG-equality checks, not on a harness error.
async function consumersSelftestCheck(ctx: Ctx): Promise<Partial<Result>> {
  const dir = join(ctx.dir, "broken");
  mkdirSync(dir, { recursive: true });
  const report = join(dir, "consumers.json");
  const env = {
    CONSUMERS_WORLDS: "parity",
    CONSUMERS_PARITY_MAP: resolveNamedFixture("parity"),
    CONSUMERS_MAP: ctx.map(),
    CONSUMERS_DPR: "2",
    CONSUMERS_BREAK: "tamper",
    CONSUMERS_STEPS: "camera,save,export",
    GATE_OUT_DIR: dir
  };
  const code = await exec(nodeScript("bench/host/consumers.ts"), ctx.env(env), ctx.log, DEFS["consumers-selftest"].timeout, true);
  const data = readJson(report);
  const failing: Json[] = (data?.checks ?? []).filter((c: Json) => c.status === "FAIL");
  const failed = (suffix: string) => failing.some(c => String(c.id).endsWith(suffix));
  const problems: string[] = [];
  if (!data) problems.push(`no report written (exit ${code})`);
  else if (String(data.failure ?? "").startsWith("harness:")) problems.push(`harness error: ${data.failure}`);
  else {
    if (!failed("save.arms-equal")) problems.push("break=tamper did not fail save.arms-equal: the harness can no longer see a changed save");
    if (!failed("save.svg-section-identical")) problems.push("break=tamper did not fail save.svg-section-identical");
    if (!failed("export.png")) problems.push("break=tamper did not fail export.png: the harness can no longer see a changed image");
    const unexpected = failing.filter(c => !/(save\.arms-equal|save\.svg-section-identical|export\.png|export\.jpeg|export\.stable)/.test(String(c.id)) && c.row !== "run");
    if (unexpected.length) problems.push(`unexpected failures: ${unexpected.slice(0, 4).map(c => `${c.id} (${String(c.detail).slice(0, 80)})`).join("; ")}`);
  }
  return {
    exit_code: problems.length ? 1 : 0,
    failure: problems.length ? problems.join(" | ") : null,
    metrics: { broken_failing: failing.map(c => c.id).slice(0, 12), checks: data?.checks?.length ?? 0 }
  };
}


// ---------------------------------------------------------------- census checks (wave 2, CENSUS packet)

// The toggle census (rows 26, 27), resize / DPR / print / layers presets (row 39), customization (row 25) and memory
// cycles (gate gap 16) are one script each under bench/host/; they share the report shape: `checks` with PASS / FAIL /
// INFO and a `failure` that is null on a pass.
function censusMetrics(data: Json): Json {
  if (!data) return {};
  const checks: Json[] = data.checks ?? [];
  const brief = (c: Json) => `${c.id}: ${String(c.detail).slice(0, 180)}`;
  return {
    summary: data.summary,
    adapter: data.adapter?.renderer ?? data.adapter?.description ?? data.adapter ?? undefined,
    failing: checks.filter(c => c.status === "FAIL").slice(0, 12).map(brief),
    info: checks.filter(c => c.status === "INFO").slice(0, 8).map(brief),
    knownGaps: data.knownGaps ?? data.summary?.knownGaps,
    growth: data.growth
  };
}
const censusRun = (ctx: Ctx, script: string, reportName: string, env: Record<string, string>) =>
  runScript(ctx, nodeScript(`bench/host/${script}`), env, join(ctx.dir, reportName), DEFS[ctx.check].timeout, data => ({ failure: reportFailure(data), metrics: censusMetrics(data) }));

const togglesEnv = (ctx: Ctx): Record<string, string> => ({
  TOGGLE_MAP: resolveNamedFixture("parity"),
  TOGGLE_DPR: String(ctx.args.dpr),
  TOGGLE_LAUNCHER: String(ctx.args.launcher),
  TOGGLE_ONLY: String(ctx.args.only),
  TOGGLE_PASSES: String(ctx.args.passes),
  TOGGLE_READING: String(ctx.args.reading),
  TOGGLE_STRICT: ctx.args.strict ? "1" : "0",
  TOGGLE_BREAK: String(ctx.args.break)
});
const resizeEnv = (ctx: Ctx): Record<string, string> => ({
  RESIZE_MAP: resolveNamedFixture("parity"),
  RESIZE_DPR: String(ctx.args.dpr),
  RESIZE_LAUNCHER: String(ctx.args.launcher),
  ...(ctx.args.steps ? { RESIZE_STEPS: String(ctx.args.steps) } : {}),
  RESIZE_STRICT: ctx.args.strict ? "1" : "0",
  RESIZE_BREAK: String(ctx.args.break)
});
const customizationEnv = (ctx: Ctx): Record<string, string> => ({
  CUSTOM_MAP: resolveNamedFixture("parity"),
  CUSTOM_DPR: String(ctx.args.dpr),
  CUSTOM_LAUNCHER: String(ctx.args.launcher),
  CUSTOM_MODES: String(ctx.args.modes),
  CUSTOM_BREAK: String(ctx.args.break)
});
const memoryEnv = (ctx: Ctx): Record<string, string> => ({
  MEMORY_MAP: resolveNamedFixture("parity"),
  MEMORY_DPR: String(ctx.args.dpr),
  MEMORY_LAUNCHER: String(ctx.args.launcher),
  MEMORY_CYCLES: String(ctx.args.cycles),
  MEMORY_RESIZES: String(ctx.args.resizes),
  ...(ctx.args.steps ? { MEMORY_STEPS: String(ctx.args.steps) } : {}),
  MEMORY_BREAK: String(ctx.args.break)
});

// REWRITE-PLAN row 28: the layer golden per built-in style preset at gate scale, summarised by preset. A preset's
// failing cells are compared with the same cell under the baseline `default` preset: a cell that passes under `default`
// and fails under the preset is INDUCED by the preset. Hard failures (GPU fallback, a prepare that never settled, a
// harness error) fail under any preset; induced metric failures fail past `allow=` per preset. Baseline failures are the
// golden's own open gaps (checked by `golden`), reported here but not charged to the preset.
async function presetsCheck(ctx: Ctx): Promise<Partial<Result>> {
  const presets = parsePresets(String(ctx.args.preset));
  const withBaseline = presets.includes("default") ? presets : ["default", ...presets];
  const env: Record<string, string> = {
    GOLDEN_MAP: ctx.map(),
    GOLDEN_LAYERS: "all",
    GOLDEN_K: String(ctx.args.k),
    GOLDEN_DPR: String(ctx.args.dpr),
    GOLDEN_PRESET: withBaseline.join(","),
    GOLDEN_BG: "#ffffff",
    GOLDEN_READING: String(ctx.args.reading),
    GOLDEN_KEEP: "fail",
    GOLDEN_BREAK: "none"
  };
  const report = join(ctx.dir, "golden.json");
  const code = await exec(nodeScript("bench/host/layer-golden.ts"), ctx.env(env), ctx.log, DEFS.presets.timeout, true);
  const data = readJson(report);
  if (!data) return { exit_code: code || 1, failure: code === 124 ? `timed out after ${DEFS.presets.timeout}s` : `no golden report (exit ${code})`, metrics: {}, report: null };
  const cells: Json[] = data.cells ?? [];
  const { rows, byFamily } = summarizePresets(cells as never, "default", ctx.args.reading as "conservative" | "over44");
  const shown = rows.filter(r => presets.includes(r.preset));
  const problems = judgePresets(shown, Number(ctx.args.allow));
  for (const preset of presets) if (!shown.some(r => r.preset === preset)) problems.push(`${preset}: the golden produced no cells`);
  if ((data.errors ?? []).length) problems.push(`golden reported ${(data.errors as string[]).length} page/harness error(s): ${String(data.errors[0]).split("\n")[0].slice(0, 160)}`);
  writeFileSync(join(ctx.dir, "presets.json"), JSON.stringify({ schema: 1, allow: ctx.args.allow, k: ctx.args.k, dpr: ctx.args.dpr, fixture: data.fixture, rows, byFamily, problems }, null, 2) + "\n");
  const images: Record<string, string> = {};
  for (const cell of cells) if (!cell.pass && cell.images && shown.some(r => r.preset === cell.preset) && Object.keys(images).length < 60) for (const [kind, path] of Object.entries(cell.images)) images[`${cell.key}/${kind}`] = join(ctx.dir, String(path));
  return {
    exit_code: problems.length ? 1 : 0,
    failure: problems.length ? problems.join(" | ").slice(0, 2000) : null,
    metrics: {
      fixture: data.fixture?.sha256?.slice(0, 12),
      golden_exit: code,
      presets: shown.map(r => ({
        preset: r.preset,
        cells: r.cells,
        fail: r.fail,
        induced: r.induced,
        inducedGates: r.inducedGates,
        compatShare: round(r.compatShare, 4),
        hard: r.hard.length,
        worst: r.worst && `${r.worst.cell} ssim ${round(r.worst.ssim, 4)} over16 ${round(r.worst.over16, 4)}`,
        failing: r.failing.slice(0, 12),
        notApplicable: r.notApplicable
      }))
    },
    report: join(ctx.dir, "presets.json"),
    images
  };
}

// Re-proves that each census check can still tell pass from fail. For every script a small clean arm must pass, and the
// same arm with its `break` switch must fail on a real check (a check id of the expected family, not a harness error).
async function censusSelftestCheck(ctx: Ctx): Promise<Partial<Result>> {
  interface Arm {
    name: string;
    script: string;
    report: string;
    env: Record<string, string>;
    broken: Record<string, string>;
    fails: RegExp; // the check ids the broken arm must fail
    /** true: the clean arm of this script already ran under another arm; run only the broken one */
    skipClean?: boolean;
    timeout: number;
  }
  const parity = resolveNamedFixture("parity");
  const common = { DPR: "2", LAUNCHER: String(ctx.args.launcher) };
  const arms: Arm[] = [
    {
      name: "toggles",
      script: "toggle-census.ts",
      report: "toggles.json",
      env: { TOGGLE_MAP: parity, TOGGLE_DPR: common.DPR, TOGGLE_LAUNCHER: common.LAUNCHER, TOGGLE_ONLY: "rivers,borders", TOGGLE_PASSES: "isolated" },
      broken: { TOGGLE_BREAK: "freeze-gpu" },
      fails: /^toggle\./,
      timeout: 1200
    },
    {
      // the on-state fidelity gate of the toggles check: the GPU canvas alone is drawn hue-rotated after the layer
      // is turned back on (footprint intact, pixels wrong); only toggle.<layer>.on-fidelity can see that
      name: "toggles-on-state",
      script: "toggle-census.ts",
      report: "toggles.json",
      env: { TOGGLE_MAP: parity, TOGGLE_DPR: common.DPR, TOGGLE_LAUNCHER: common.LAUNCHER, TOGGLE_ONLY: "rivers,borders", TOGGLE_PASSES: "isolated" },
      broken: { TOGGLE_BREAK: "perturb-on" },
      fails: /^toggle\.\w+\.on-fidelity$/,
      skipClean: true,
      timeout: 1200
    },
    {
      name: "customization",
      script: "customization.ts",
      report: "customization.json",
      env: { CUSTOM_MAP: parity, CUSTOM_DPR: common.DPR, CUSTOM_LAUNCHER: common.LAUNCHER, CUSTOM_MODES: "states" },
      broken: { CUSTOM_BREAK: "no-watch" },
      fails: /\.(enter|camera)$/,
      timeout: 900
    },
    {
      name: "resize-print",
      script: "resize-print.ts",
      report: "resize-print.json",
      env: { RESIZE_MAP: parity, RESIZE_DPR: common.DPR, RESIZE_LAUNCHER: common.LAUNCHER, RESIZE_STEPS: "resize,print" },
      broken: { RESIZE_BREAK: "all" },
      fails: /^(resize|print)\./,
      timeout: 900
    },
    {
      name: "memory-cycles",
      script: "memory-cycles.ts",
      report: "memory.json",
      env: { MEMORY_MAP: parity, MEMORY_DPR: common.DPR, MEMORY_LAUNCHER: common.LAUNCHER, MEMORY_STEPS: "world", MEMORY_CYCLES: "5", MEMORY_WARMUP: "1" },
      broken: { MEMORY_BREAK: "leak" },
      fails: /^memory\.world-replace$/,
      timeout: 1500
    }
  ];
  const problems: string[] = [];
  const summary: Json = {};
  const only = String(ctx.args.only).split(",").filter(Boolean);
  for (const name of only) if (!arms.some(a => a.name === name)) throw new UsageError(`only=${name}: one of ${arms.map(a => a.name).join(", ")}`);
  for (const arm of arms) {
    if (only.length && !only.includes(arm.name)) continue;
    summary[arm.name] = {};
    for (const mode of ["clean", "broken"] as const) {
      if (mode === "clean" && arm.skipClean) continue;
      const dir = join(ctx.dir, arm.name, mode);
      mkdirSync(dir, { recursive: true });
      const env = { ...arm.env, ...(mode === "broken" ? arm.broken : {}), GATE_OUT_DIR: dir };
      const code = await exec(nodeScript(`bench/host/${arm.script}`), ctx.env(env), ctx.log, arm.timeout, true);
      const data = readJson(join(dir, arm.report));
      const failing: string[] = (data?.checks ?? []).filter((c: Json) => c.status === "FAIL").map((c: Json) => String(c.id));
      summary[arm.name][mode] = { code, failing: failing.slice(0, 6), failure: data?.failure ? String(data.failure).slice(0, 160) : null };
      if (!data) problems.push(`${arm.name} ${mode}: no report (exit ${code})`);
      else if (mode === "clean") {
        if (code !== 0 || data.failure) problems.push(`${arm.name} clean arm failed: ${String(data.failure ?? `exit ${code}`).slice(0, 200)}`);
      } else if (code === 0 && !data.failure) problems.push(`${arm.name}: the broken arm PASSED, the check can no longer see its break`);
      else if (String(data.failure).startsWith("harness:")) problems.push(`${arm.name}: the broken arm died on a harness error, not a check: ${String(data.failure).slice(0, 160)}`);
      else if (!failing.some(id => arm.fails.test(id))) problems.push(`${arm.name}: the broken arm failed, but not on ${arm.fails} (failing: ${failing.join(", ") || "none"})`);
    }
  }
  return { exit_code: problems.length ? 1 : 0, failure: problems.length ? problems.join(" | ") : null, metrics: summary };
}

// ---------------------------------------------------------------- check table

const CAMERA = ["dpr", "zoom"];
const DEFS: Record<string, CheckDef> = {
  typecheck: {
    lock: null,
    keys: [],
    timeout: 300,
    run: ctx =>
      runScript(ctx, [join(BIN, "tsc"), "-p", "tsconfig.json"], {}, null, 300, (_d, code) => {
        const errors = (tail(ctx.log, 1e7).match(/error TS\d+/g) ?? []).length;
        return { failure: code ? `${errors} TypeScript error(s)` : null, metrics: { errors } };
      })
  },
  // bench/ is outside tsconfig.json (src only). tsconfig.bench.json covers bench/host and bench/gate under the same strict
  // settings (labels.ts is excluded there, with a note); a type error there used to surface only when node stripped it.
  "typecheck-bench": {
    lock: null,
    keys: [],
    timeout: 300,
    run: ctx =>
      runScript(ctx, [join(BIN, "tsc"), "-p", "tsconfig.bench.json"], {}, null, 300, (_d, code) => {
        const errors = (tail(ctx.log, 1e7).match(/error TS\d+/g) ?? []).length;
        return { failure: code ? `${errors} TypeScript error(s) under bench/` : null, metrics: { errors } };
      })
  },
  unit: {
    lock: null,
    keys: [],
    timeout: 600,
    run: ctx =>
      runScript(ctx, [join(BIN, "vitest"), "run"], {}, null, 600, (_d, code) => {
        const metrics = vitestMetrics(tail(ctx.log, 4000).replace(/\x1b\[[0-9;]*m/g, ""));
        return { failure: code ? `vitest failed: ${metrics.tests ?? "see log"}` : null, metrics };
      })
  },
  build: {
    lock: null,
    keys: ["typecheck"],
    timeout: 600,
    run: async ctx => {
      if (ctx.args.typecheck) {
        const code = await exec([join(BIN, "tsc")], ctx.env(), ctx.log, 300, false);
        if (code) return { exit_code: code, failure: "tsc failed (npm run build = tsc && vite build)", metrics: {} };
      }
      // Atomic: vite writes a fresh directory next to dist/, and dist/ is swapped for it under the exclusive dist lock
      // (no check in this worktree is reading dist/ then). A failed build leaves dist/ exactly as it was.
      const fresh = join(REPO, `${DIST_BUILD_PREFIX}${process.pid}`);
      rmSync(fresh, { recursive: true, force: true });
      const result = await runScript(ctx, [join(BIN, "vite"), "build", "--outDir", fresh, "--emptyOutDir"], {}, null, 600, (_d, code) => ({
        failure: code ? "vite build failed" : !existsSync(join(fresh, "index.html")) ? "vite build wrote no index.html" : null,
        metrics: {}
      }));
      if (result.failure) {
        rmSync(fresh, { recursive: true, force: true });
        return result;
      }
      const waitStart = Date.now();
      if (distLock.held) throw new Error("build cannot swap dist/ while this gate process is itself reading it");
      log("build: taking the exclusive dist lock to swap in the new dist/ (waits for the checks that are reading this worktree's dist/)");
      await distLock.acquire("exclusive");
      const waited = (Date.now() - waitStart) / 1000;
      try {
        const old = join(REPO, `${DIST_OLD_PREFIX}${process.pid}`);
        rmSync(old, { recursive: true, force: true });
        const dist = join(REPO, "dist");
        if (existsSync(dist)) renameSync(dist, old);
        try {
          renameSync(fresh, dist);
        } catch (error) {
          if (existsSync(old)) renameSync(old, dist);
          throw error;
        }
        rmSync(old, { recursive: true, force: true });
      } finally {
        await distLock.release();
      }
      const fingerprint = distFingerprint();
      return { ...result, metrics: { dist: fingerprint?.slice(0, 16), files: walk(join(REPO, "dist")).length, dist_lock_wait_s: Number(waited.toFixed(1)) } };
    }
  },
  bench: {
    lock: null,
    keys: [],
    timeout: 600,
    run: ctx =>
      runScript(
        ctx,
        [
          NODE,
          "--test",
          ...["renderer-ab", "compare", "frame-budget", "trace", "fidelity-metrics", "golden-metrics", "picking-oracle"].map(n => `bench/${n}.test.ts`),
          "bench/gate/host-lock.test.ts",
          "bench/host/fixtures/fixtures.test.ts",
          "bench/host/consumers-lib.test.ts",
          "bench/host/corpus-lib.test.ts",
          "bench/integration-fixture.test.ts",
          "bench/host/editor-replay-core.test.ts",
          "bench/host/census-core.test.ts",
          "bench/host/labels-core.test.ts",
          "bench/host/reuse-fidelity-core.test.ts"
        ],
        {},
        null,
        600,
        (_d, code) => {
          const text = tail(ctx.log, 4000);
          const metrics = { pass: Number(/(?:#|ℹ) pass (\d+)/.exec(text)?.[1] ?? NaN), fail: Number(/(?:#|ℹ) fail (\d+)/.exec(text)?.[1] ?? NaN) };
          return { failure: code ? `${metrics.fail} node test(s) failed` : null, metrics };
        }
      )
  },
  smoke: { lock: "shared", keys: [...CAMERA, "layer"], timeout: 900, run: smokeLike("gpu-smoke.ts") },
  fidelity: { lock: "shared", keys: [...CAMERA, "layer"], timeout: 900, run: smokeLike("gpu-fidelity.ts") },
  hatch: { lock: "shared", keys: CAMERA, timeout: 900, run: smokeLike("hatch-motion.ts") },
  navigation: { lock: "exclusive", keys: CAMERA, timeout: 900, run: smokeLike("native-navigation-pilot.ts") },
  context: { lock: "shared", keys: CAMERA, timeout: 900, run: smokeLike("gpu-smoke.ts", () => ({ SMOKE_CONTEXT: "1" })) },
  lifecycle: { lock: "shared", keys: CAMERA, timeout: 900, run: smokeLike("gpu-smoke.ts", () => ({ SMOKE_LIFECYCLE: "1" })) },
  "native-recovery": {
    lock: "exclusive",
    keys: ["dpr", "world", "gesture", "culling", "trace"],
    timeout: 300,
    run: ctx => {
      const env = {
        SMOKE_NAME: "native-recovery",
        SMOKE_DPR: String(ctx.args.dpr),
        NAV_WORLD: String(ctx.args.world),
        NAV_GESTURE: String(ctx.args.gesture),
        NAV_RENDERER: "gpu",
        NAV_CULLING: String(ctx.args.culling),
        NAV_TRACE: ctx.args.trace ? "1" : "0",
        SMOKE_NO_MSAA: "0",
        SMOKE_OPAQUE_CANVAS: "0",
        SMOKE_HIDE_RELIEF: "0"
      };
      return runScript(ctx, nodeScript("bench/host/native-recovery.ts"), env, join(ctx.dir, "native-recovery.json"), 300, data => ({
        failure: reportFailure(data) ?? (data?.errors?.length ? `${data.errors.length} page error(s)` : null),
        metrics: data && {
          errors: data.errors?.length ?? 0,
          adapter: data.contextProperties?.adapter,
          movingProof: pick(data.movingProof, ["samples", "emblemHits", "mismatches", "restoredMismatches"]),
          recoveryWallMs: data.recoveryProfile?.wallMs,
          restore: data.recoveryProfile?.status?.restore,
          contextLossRestored: data.movingContextLoss?.restored?.state ?? null
        }
      }));
    }
  },
  // Context-loss restore timing (PERF: research B0/B1/B2): loss at rest on a settled camera, per-arm restore clock and
  // hover event-to-rAF during the restore, arms interleaved ABBA. Descriptive: fails only on errors or a missed restore.
  restore: {
    lock: "exclusive",
    keys: ["dpr", "world", "arms", "reps", "cold", "input", "rzoom"],
    spec: {
      arms: { type: "string", default: "base" },
      reps: { type: "int", default: 3 },
      cold: { type: "bool", default: false },
      input: { type: "bool", default: true },
      rzoom: { type: "string", default: "3.5" }
    },
    timeout: 1800,
    run: ctx => {
      const env = {
        RESTORE_DPR: String(ctx.args.dpr),
        RESTORE_WORLD: String(ctx.args.world),
        RESTORE_ARMS: String(ctx.args.arms),
        RESTORE_REPS: String(ctx.args.reps),
        RESTORE_COLD: ctx.args.cold ? "1" : "0",
        RESTORE_INPUT: ctx.args.input ? "1" : "0",
        RESTORE_ZOOM: String(ctx.args.rzoom)
      };
      return runScript(ctx, nodeScript("bench/host/restore-timing.ts"), env, join(ctx.dir, "restore-timing.json"), 1800, data => ({
        failure: reportFailure(data) ?? (data?.errors?.length ? `${data.errors.length} page error(s)` : null),
        metrics: data && { adapter: data.contextProperties?.adapter, world: data.world, cold: data.cold, summary: data.summary }
      }));
    }
  },
  // W3b PAINT: trade caravans live against frozen on the parity world (every layer on): idle fps, main-thread layerize
  // and forced prepare-to-current per arm. Fails when the live median prepare-to-current exceeds 2x the frozen one.
  "trade-live": {
    lock: "exclusive",
    keys: ["dpr", "reps"],
    spec: { reps: { type: "int", default: 3 } },
    timeout: 1200,
    run: ctx =>
      runScript(ctx, nodeScript("bench/host/trade-live.ts"), { TRADE_DPR: String(ctx.args.dpr), TRADE_REPS: String(ctx.args.reps) }, join(ctx.dir, "trade-live.json"), 1200, data => ({
        failure: reportFailure(data),
        metrics: data && { adapter: data.contextProperties?.adapter, summary: data.summary, caravans: data.status?.caravans }
      }))
  },
  palette: {
    lock: "shared",
    keys: [],
    timeout: 600,
    run: ctx =>
      runScript(ctx, nodeScript("bench/host/palette.ts"), { PALETTE_OUTPUT: "palette" }, join(ctx.dir, "palette.json"), 600, data => ({
        failure: reportFailure(data) ?? (data?.errors?.length ? `${data.errors.length} page error(s)` : null),
        metrics: data && {
          errors: data.errors?.length ?? 0,
          stages: { passed: data.stages?.filter((s: Json) => s.pass).length ?? 0, failed: data.stages?.filter((s: Json) => !s.pass).map((s: Json) => `${s.arm}/${s.name}`) ?? [] },
          parity: data.parity && pick(data.parity, ["equal", "stableWithinArms", "worldEqual", "cameraEqual", "classification"])
        }
      }))
  },
  "package-smoke": {
    lock: "shared",
    keys: [],
    timeout: 300,
    run: ctx => {
      const report = join(ctx.dir, "report.json");
      return runScript(ctx, nodeScript("bench/host/package-smoke.ts"), { PACKAGE_OUTPUT: report, PACKAGE_DIST: join(REPO, "dist") }, report, 300, data => ({
        failure: data && !data.pass ? String(data.failure ?? "package smoke failed").slice(0, 2000) : null,
        metrics: data && { pass: data.pass, missing: data.missing?.length ?? 0, modes: data.results?.map((r: Json) => r.mode) }
      }));
    }
  },
  canonical: {
    lock: "shared",
    keys: [],
    timeout: 300,
    run: ctx => {
      const report = join(ctx.dir, "report.json");
      const env = {
        INTEGRATION_DPR: "2",
        INTEGRATION_ZOOM: "2",
        INTEGRATION_COHORT: "short",
        INTEGRATION_FOCUS: "all",
        INTEGRATION_RENDER_ONLY: "1",
        INTEGRATION_NAME: basename(ctx.dir),
        INTEGRATION_OUTPUT: report,
        INTEGRATION_MAP: ctx.map()
      };
      return runScript(ctx, nodeScript("bench/direct-integration-metal-local-init.ts"), env, report, 300, data => ({
        failure: reportFailure(data) ?? verdictFailure(data),
        metrics: { ...integrationMetrics(data), canonicalFallback: data?.canonicalFallback && pick(data.canonicalFallback, ["active", "hookCleared", "rendererCleared", "canvases"]) }
      }));
    }
  },
  paint: {
    lock: "shared",
    keys: [],
    timeout: 120,
    run: ctx => {
      const report = join(ctx.dir, "report.json");
      return runScript(ctx, nodeScript("bench/direct-emblem-culling-contract.ts"), { EMBLEM_CULL_OUTPUT: report }, report, 120, data => ({
        failure: data && !data.pass ? `paint contract failed: ${JSON.stringify(Object.entries(data.assertions ?? {}).filter(([, v]) => v !== true).map(([k]) => k))}` : null,
        metrics: data && { pass: data.pass, reads: data.reads, initialReads: data.initialReads }
      }));
    }
  },
  // bench/host/stroke-probe.ts: synthetic probe lines, SVG vs GPU stroke width, dash pitch/phase and dot shape (STROKE)
  "stroke-probe": {
    lock: "shared",
    keys: ["dpr", "k", "params"],
    spec: { dpr: { type: "string", default: "1,2", check: text => { if (!text.split(",").every(d => d === "1" || d === "2")) throw new UsageError("dpr must be 1, 2 or 1,2"); } } },
    timeout: 600,
    run: ctx => {
      const report = join(ctx.dir, "stroke-probe.json");
      return runScript(ctx, nodeScript("bench/host/stroke-probe.ts"), { PROBE_DPR: String(ctx.args.dpr), PROBE_K: String(ctx.args.k), PROBE_PARAMS: String(ctx.args.params ?? "") }, report, 600, data => ({
        failure: reportFailure(data),
        metrics: data && {
          cells: (data.cells ?? []).map((c: Json) => {
            const n = (list: unknown, status: string) => ((list as Json[] | undefined) ?? []).filter(l => l.status === status).length;
            return `d${c.dpr} k${c.k}${c.mode ? ` ${c.mode}` : ""}: lines ${n(c.lines, "pass")} pass ${n(c.lines, "fail")} fail ${n(c.lines, "not comparable")} n/c, joins ${n(c.joins, "pass")}/${((c.joins as Json[] | undefined) ?? []).length}, shapes ${n(c.shapes, "pass")} pass ${n(c.shapes, "fail")} fail ${n(c.shapes, "not comparable")} n/c`;
          }),
          worstJoinNotches: Math.max(0, ...(data.cells ?? []).flatMap((c: Json) => ((c.joins as Json[] | undefined) ?? []).map(l => Number(l.notches) || 0))),
          worstWidthDeltaPx: Math.max(0, ...(data.cells ?? []).flatMap((c: Json) => (c.lines as Json[]).map(l => Math.abs(Number(l.widthDeltaPx) || 0)))),
          worstPhasePx: Math.max(0, ...(data.cells ?? []).flatMap((c: Json) => (c.lines as Json[]).map(l => Math.abs(Number(l.phasePx) || 0))))
        }
      }));
    }
  },
  "boundary-before": { lock: null, keys: [], timeout: 60, run: ctx => boundary(ctx, true) },
  "boundary-after": { lock: null, keys: [], timeout: 60, run: ctx => boundary(ctx, false) },
  picking: {
    lock: "shared",
    keys: [...CAMERA, "phase", "reliefMode", "denseLabels", "launcher"],
    timeout: 1500,
    // protocol v3 (W3 PICK): D3 semantic gate per cohort on parity, shared and the 100k world, multi-view, edge band
    run: ctx => {
      const report = join(ctx.dir, "report.json");
      const env = {
        PICK_DPR: String(ctx.args.dpr),
        PICK_ZOOM: String(ctx.args.zoom),
        PICK_PHASE: String(ctx.args.phase),
        PICK_RELIEF_MODE: String(ctx.args.reliefMode),
        PICK_NAME: basename(ctx.dir),
        PICK_OUTPUT: report,
        PICK_MAP: ctx.map(),
        PICK_PARITY_MAP: resolveNamedFixture("parity"),
        PICK_LAUNCHER: String(ctx.args.launcher),
        PICK_WORLDS: ctx.args.denseLabels ? "parity,shared,100k,100k-labels" : "parity,shared,100k"
      };
      return runScript(ctx, nodeScript("bench/picking-parity.ts"), env, report, 1500, data => ({
        failure: reportFailure(data),
        metrics: data && {
          pageErrors: data.pageErrors?.length ?? 0,
          adapter: data.config?.adapter?.renderer ?? null,
          worlds: data.results?.map((r: Json) => ({
            world: r.world,
            errors: r.errors?.length ?? 0,
            semanticMismatches: r.semantic?.mismatches?.length ?? null,
            pickP95Ms: r.views?.length
              ? round(Math.max(...(r.views as Json[]).map(v => Number(v.query?.pickMs?.p95) || 0)), 2)
              : null,
            cohorts:
              r.gate?.cohorts &&
              Object.fromEntries(
                Object.entries(r.gate.cohorts as Record<string, Json>).map(([k, c]) => [k, `${c.agree}/${c.n} ${c.status}${c.required ? "*" : ""}`])
              ),
            cells: r.gate?.cells && `${r.gate.cells.agree}/${r.gate.cells.n} ${r.gate.cells.pass ? "pass" : "fail"}`,
            edgeBand: r.gate?.edgeBand && {
              px: r.gate.edgeBand.px,
              excluded: r.gate.edgeBand.excluded,
              agree: r.gate.edgeBand.agree,
              failures: r.gate.edgeBand.failures
            },
            strictFailures: r.gate?.strict?.failures,
            failures: r.gate?.failures
          }))
        }
      }));
    }
  },
  integration: {
    lock: "shared",
    keys: [...CAMERA, "cohort", "focus", "preamble", "launcher"],
    timeout: 1800,
    run: ctx => {
      const report = join(ctx.dir, "report.json");
      const env = {
        INTEGRATION_DPR: String(ctx.args.dpr),
        INTEGRATION_ZOOM: String(ctx.args.zoom),
        INTEGRATION_NAME: basename(ctx.dir),
        INTEGRATION_OUTPUT: report,
        INTEGRATION_MAP: ctx.map(),
        INTEGRATION_COHORT: String(ctx.args.cohort),
        INTEGRATION_FOCUS: String(ctx.args.focus),
        INTEGRATION_PREAMBLE: String(ctx.args.preamble),
        INTEGRATION_LAUNCHER: String(ctx.args.launcher)
      };
      return runScript(ctx, nodeScript("bench/renderer-integration.ts"), env, report, 1800, data => ({
        failure: reportFailure(data) ?? verdictFailure(data),
        metrics: { ...integrationMetrics(data), summary: data?.summary }
      }));
    }
  },
  // Editor replay (W1 REPLAY): record each editor script on the SVG arm, replay it under gpu and gpu-select, diff
  // pack/grid hashes, the model DOM and its attribute deltas, dispatch counts and the camera; GPU arms must suspend
  // (canvas hidden) while the editor is open and resume after the close. Correctness only: resume latency here comes
  // from arms running side by side, so read it from `replay-resume`.
  replay: {
    lock: "shared",
    keys: ["editors", "arms", "dpr", "launcher", "fixture"],
    spec: { fixture: { type: "string", default: "parity" } },
    timeout: 3600, // 39 scripts × 3 arms, one fresh page per script
    run: ctx => replayCheck(ctx, {})
  },
  // The same replay, arms one after another under the exclusive lock: resume latency (current and refined frame) for PERF.
  "replay-resume": {
    lock: "exclusive",
    keys: ["editors", "launcher", "fixture"],
    spec: { fixture: { type: "string", default: "parity" } },
    timeout: 5400, // 39 scripts × 3 arms one after another, one fresh page per script (~45-60 min)
    run: ctx => replayCheck(ctx, { REPLAY_ARMS: "svg,gpu,gpu-select", REPLAY_PARALLEL: "0" })
  },
  // The replay must still fail: corrupt pack, the model DOM and the dispatch count on the replay arm, and reveal the GPU
  // canvas right after the close (a stale pre-edit frame, D13); each must be caught.
  "replay-selftest": {
    lock: "shared",
    keys: ["launcher", "fixture"],
    spec: { fixture: { type: "string", default: "parity" } },
    timeout: 600,
    run: ctx => replayCheck(ctx, { REPLAY_EDITORS: "label", REPLAY_ARMS: "svg,gpu", REPLAY_BREAK: "model,dom,dispatch,stale" })
  },
  timing: { lock: "exclusive", keys: ["arm", "headless", "trace"], timeout: 900, run: ctx => timing(ctx, "bench/navigation.ts") },
  profile: { lock: "exclusive", keys: ["arm", "headless", "trace"], timeout: 900, run: ctx => timing(ctx, "bench/profile-navigation.ts") },
  "gpu-timing": { lock: "exclusive", keys: ["arm", "headless", "trace"], timeout: 900, run: ctx => timing(ctx, "bench/timer-navigation.ts") },
  metrics: { lock: "shared", keys: ["manifest"], timeout: 900, run: metricsCheck },
  paired: { lock: "exclusive", keys: ["dpr", "block"], timeout: 1100, run: pairedBlock },
  // Takes and releases the host lock in the given mode without launching anything: shows who would wait and how long.
  "lock-probe": {
    lock: null,
    keys: ["mode"],
    timeout: 1,
    run: async ctx => {
      const mode = ctx.args.mode as LockMode;
      await lock.acquire(mode);
      const metrics = { lock: LOCK_PATH, mode, slots: lock.options.slots, slot: lock.slot, inherited: lock.inherited, waitSeconds: lock.waitSeconds };
      await lock.release();
      return { exit_code: 0, failure: null, metrics };
    }
  },
  // the document's consumers, gpu arm against svg arm: PNG-free of timing, so a shared slot. `break=save-tamper|export-tamper|tamper`
  // perturbs the gpu arm and the run must FAIL (see `consumers-selftest`)
  consumers: {
    lock: "shared",
    keys: ["worlds", "dpr", "break", "control"],
    spec: {
      worlds: { type: "string", default: "parity,shared", check: text => { if (!text.split(",").every(w => w === "parity" || w === "shared")) throw new UsageError("worlds must be parity, shared or parity,shared"); } },
      break: { type: "enum", values: ["none", "save-tamper", "export-tamper", "tamper"], default: "none" },
      control: { type: "bool", default: false }
    },
    timeout: 3600,
    run: consumersCheck
  },
  // census (wave 2): toggles + reorder + trade, resize/dpr/print/layers presets, customization, memory, preset golden
  toggles: {
    lock: "shared",
    keys: ["dpr", "launcher", "only", "passes", "reading", "strict", "break"],
    spec: { break: { type: "enum", values: ["none", "freeze-gpu", "perturb-on"], default: "none" } },
    timeout: 3600,
    run: ctx => censusRun(ctx, "toggle-census.ts", "toggles.json", togglesEnv(ctx))
  },
  "resize-print": {
    lock: "shared",
    keys: ["dpr", "launcher", "steps", "strict", "break"],
    spec: { break: { type: "enum", values: ["none", "no-resize", "no-print", "all"], default: "none" } },
    timeout: 1800,
    run: ctx => censusRun(ctx, "resize-print.ts", "resize-print.json", resizeEnv(ctx))
  },
  customization: {
    lock: "shared",
    keys: ["dpr", "launcher", "modes", "break"],
    spec: { break: { type: "enum", values: ["none", "no-watch"], default: "none" } },
    timeout: 1800,
    run: ctx => censusRun(ctx, "customization.ts", "customization.json", customizationEnv(ctx))
  },
  "memory-cycles": {
    lock: "shared",
    keys: ["dpr", "launcher", "cycles", "resizes", "steps", "break"],
    spec: { break: { type: "enum", values: ["none", "leak"], default: "none" } },
    timeout: 3600,
    run: ctx => censusRun(ctx, "memory-cycles.ts", "memory.json", memoryEnv(ctx))
  },
  presets: {
    lock: "shared",
    keys: ["preset", "k", "dpr", "fixture", "reading", "allow"],
    spec: { preset: { type: "string", default: "all", check: listOf(parsePresets) }, fixture: { type: "string", default: "parity" } },
    timeout: 14400,
    run: presetsCheck
  },
  "census-selftest": { lock: "shared", keys: ["launcher", "only"], timeout: 7200, run: censusSelftestCheck },
  // legacy corpus: maps written by old versions (tests/fixtures/corpus), svg arm against gpu arm (row 33)
  corpus: {
    lock: "shared",
    keys: ["maps", "dpr", "golden", "control", "strict", "break"],
    spec: {
      maps: { type: "string", default: "all", check: text => { if (text !== "all") { const known = corpusManifestIds(); const bad = text.split(",").filter(m => !known.includes(m)); if (bad.length) throw new UsageError(`maps: unknown ${bad.join(", ")} (have ${known.join(", ")})`); } } },
      golden: { type: "bool", default: true },
      control: { type: "bool", default: false },
      strict: { type: "bool", default: false }, // gate the manifest's known golden gaps too
      break: { type: "enum", values: ["none", "tamper"], default: "none" }
    },
    timeout: 5400,
    run: corpusCheck
  },
  "corpus-selftest": { lock: "shared", keys: [], timeout: 900, run: corpusSelftestCheck },
  "consumers-selftest": { lock: "shared", keys: [], timeout: 1200, run: consumersSelftestCheck },
  "golden-selftest": { lock: "shared", keys: ["reading"], timeout: 900, run: goldenSelftestCheck },
  // the lazy-COA race on its own (W3 REF); fails until the renderer follows #coas
  "coa-race": {
    lock: "shared",
    keys: ["k", "dpr", "fixture"],
    spec: { fixture: { type: "string", default: "parity" }, k: { type: "string", default: "2,4,8", check: listOf(text => { if (!parseZooms(text).length) throw new Error("k needs at least one zoom"); }) }, dpr: DPR_LIST },
    timeout: 900,
    run: coaRaceCheck
  },
  golden: {
    lock: "shared",
    keys: ["layers", "k", "coastk", "dpr", "preset", "fixture", "census", "bg", "reading", "keep", "break", "gpu_arm", "params", "svg_ref", "settle_ms", "coa"],
    spec: { dpr: DPR_LIST },
    timeout: 3600,
    run: goldenCheck
  },
  // ---- LABELS (W2): label fidelity, rows 15, 16, 41 (bench/host/labels.ts). Self-contained block.
  // Visible label set at ±0.01 k of every visibility threshold, glyph positions on a 200-label sample (pixel
  // registration for every label; the analytic position is info), measureText vs SVG advance per pinned font (judged on
  // what text.ts keeps native; shaping it routes to compat is reported), font switches through the Style panel, and
  // zoom (W3b: text-shadow goldens at non-power-of-two k, a frame carried within its raster bucket), each SVG against
  // GPU of one page. `worlds=parity,shared` (default both).
  labels: {
    lock: "shared",
    keys: ["worlds", "steps", "dpr", "sample", "keep", "break"],
    spec: {
      worlds: { type: "string", default: "parity,shared", check: text => { if (!text.split(",").every(w => w === "parity" || w === "shared")) throw new UsageError("worlds must be parity, shared or parity,shared"); } },
      steps: { type: "string", default: "thresholds,glyphs,advance,fonts,zoom", check: text => { if (!text.split(",").every(s => ["thresholds", "glyphs", "advance", "fonts", "zoom"].includes(s))) throw new UsageError("steps: thresholds,glyphs,advance,fonts,zoom"); } },
      sample: { type: "int", default: 200 },
      keep: { type: "enum", values: ["all", "fail"], default: "fail" },
      break: { type: "enum", values: ["none", "freeze", "measure", "shift", "drop"], default: "none" }
    },
    timeout: 3600,
    run: async ctx => {
      const report = join(ctx.dir, "labels.json");
      const maps = String(ctx.args.worlds).split(",").map(w => `${w}=${resolveNamedFixture(w)}`).join(",");
      const env = { LABELS_MAPS: maps, LABELS_STEPS: String(ctx.args.steps), LABELS_DPR: String(ctx.args.dpr), LABELS_SAMPLE: String(ctx.args.sample), LABELS_KEEP: String(ctx.args.keep), LABELS_BREAK: String(ctx.args.break) };
      return runScript(ctx, nodeScript("bench/host/labels.ts"), env, report, 3600, data => ({ failure: reportFailure(data), metrics: data && { summary: data.summary, break: data.args?.break, errors: data.errors?.slice(0, 4) } }));
    }
  },
  // COST (W3): a compat raster reused across an edit against the SVG (bench/host/reuse-fidelity.ts). Per edit and layer
  // family, the frame that reused the family's rasters across the edit and a forced fresh prepare of the same state are
  // each measured GPU against SVG; the reused one must be as close (the toggle census on-state margins). Cells where no
  // raster of the family was reused are INFO; an edit that no family reused across fails.
  "reuse-fidelity": {
    lock: "shared",
    keys: ["edits", "families", "dpr", "launcher", "break"],
    spec: {
      edits: { type: "string", default: "zoom,move,toggle,definition" },
      families: { type: "string", default: "" },
      break: { type: "enum", values: ["none", "stale", "definitions"], default: "none" }
    },
    timeout: 3600,
    run: async ctx => {
      const report = join(ctx.dir, "reuse-fidelity.json");
      const env = { REUSE_EDITS: String(ctx.args.edits), REUSE_FAMILIES: String(ctx.args.families), REUSE_DPR: String(ctx.args.dpr), REUSE_LAUNCHER: String(ctx.args.launcher), REUSE_BREAK: String(ctx.args.break), REUSE_MAP: resolveNamedFixture("parity") };
      return runScript(ctx, nodeScript("bench/host/reuse-fidelity.ts"), env, report, 3600, data => ({ failure: reportFailure(data), metrics: data && { summary: data.summary, failing: (data.checks ?? []).filter((c: Json) => c.status === "FAIL").map((c: Json) => c.id).slice(0, 8), exercised: (data.checks ?? []).filter((c: Json) => /\.exercised$/.test(c.id)).map((c: Json) => `${c.id}: ${c.detail}`) } }));
    }
  },
  // The reuse check must still fail, twice over. (1) With the reuse tracker blind to every edit (?gpu-compat-reuse-break=stale)
  // the markers family keeps its raster from before the move edit and must fail; emblems (untouched by the move) must pass.
  // (2) With the tracker blind to DEFINITION changes only (=definitions) the definition edit (the fog layer's mask and filter,
  // which live inside svg#map, so only the closure logic of compat-reuse.ts dirties the run; the definitions outside svg#map
  // are also dirtied globally by the renderer's definition watch, so they cannot show the blindness) must fail, while the move edit on markers in the same run must not fail (re-cut: INFO, or reused and right: PASS): the closure logic is
  // what is blinded, not the whole tracker.
  "reuse-fidelity-selftest": {
    lock: "shared",
    keys: ["launcher"],
    timeout: 2400,
    run: async ctx => {
      const base = { REUSE_DPR: "2", REUSE_LAUNCHER: String(ctx.args.launcher), REUSE_MAP: resolveNamedFixture("parity") };
      const arms = [
        { name: "stale", env: { ...base, REUSE_EDITS: "move", REUSE_FAMILIES: "markers,emblems", REUSE_BREAK: "stale" }, expect: { "reuse.move.markers": ["FAIL"], "reuse.move.emblems": ["PASS"] } },
        { name: "definitions", env: { ...base, REUSE_EDITS: "move,definition", REUSE_FAMILIES: "markers,fog", REUSE_BREAK: "definitions" }, expect: { "reuse.definition.fog": ["FAIL"], "reuse.move.markers": ["PASS", "INFO"] } }
      ];
      const problems: string[] = [];
      const summary: Json = {};
      for (const arm of arms) {
        const dir = join(ctx.dir, arm.name);
        mkdirSync(dir, { recursive: true });
        const code = await exec(nodeScript("bench/host/reuse-fidelity.ts"), ctx.env({ ...arm.env, GATE_OUT_DIR: dir }), ctx.log, 1200, true);
        const data = readJson(join(dir, "reuse-fidelity.json"));
        const status = (id: string) => (data?.checks ?? []).find((c: Json) => c.id === id)?.status;
        if (!data) problems.push(`${arm.name}: no report (exit ${code})`);
        else {
          for (const [id, want] of Object.entries(arm.expect)) if (!want.includes(status(id))) problems.push(`${arm.name}: ${id} should be ${want.join(" or ")} (got ${status(id)})`);
          if ((data.checks ?? []).some((c: Json) => c.id === "run.harness")) problems.push(`${arm.name}: harness error`);
        }
        summary[arm.name] = { code, ...Object.fromEntries(Object.keys(arm.expect).map(id => [id, status(id)])), summary: data?.summary };
      }
      return { exit_code: problems.length ? 1 : 0, failure: problems.length ? problems.join(" | ") : null, metrics: summary };
    }
  },
  // The label harness must still fail: on the parity fixture, a clean run and four broken ones. `freeze` stops the GPU
  // from seeing DOM changes (a missed invalidation) and must trip the visible-set and re-atlas checks; `measure`
  // scales measureText by 1.04: the advance model must see the drift and text.ts's shaping check must route the
  // pinned fonts' strings to compat (clean routes none of them); `shift` moves the GPU canvas 1 CSS
  // px and must trip pixel registration; `drop` blanks the right half of the GPU arm and must trip the presence check
  // (an empty GPU window is a missing glyph, never a 0 px shift). Each detector must pass clean.
  "labels-selftest": {
    lock: "shared",
    keys: [],
    timeout: 2400,
    run: async ctx => {
      const scope = { LABELS_MAPS: `parity=${resolveNamedFixture("parity")}`, LABELS_DPR: "2", LABELS_KEEP: "fail", LABELS_GROUPS: "town", LABELS_VARIANTS: "native", LABELS_GLYPH_K: "1", LABELS_SAMPLE: "20", LABELS_FONTS: "builtin,broken", LABELS_ADVANCE_FAMILIES: "Georgia,Almendra SC" };
      const runs: Record<string, Json> = {};
      for (const [arm, extra] of [
        ["clean", { LABELS_STEPS: "thresholds,glyphs,advance,fonts", LABELS_BREAK: "none" }],
        ["freeze", { LABELS_STEPS: "thresholds,fonts", LABELS_BREAK: "freeze" }],
        ["measure", { LABELS_STEPS: "glyphs,advance", LABELS_BREAK: "measure" }],
        ["shift", { LABELS_STEPS: "glyphs", LABELS_BREAK: "shift" }],
        ["drop", { LABELS_STEPS: "glyphs", LABELS_BREAK: "drop" }]
      ] as const) {
        const dir = join(ctx.dir, arm);
        mkdirSync(dir, { recursive: true });
        const code = await exec(nodeScript("bench/host/labels.ts"), ctx.env({ ...scope, ...extra, GATE_OUT_DIR: dir }), ctx.log, 1200, true);
        runs[arm] = { code, data: readJson(join(dir, "labels.json")) };
      }
      const step = (arm: string, name: string): Json | undefined => runs[arm].data?.worlds?.parity?.steps?.[name];
      const cells = (arm: string): Json[] => step(arm, "thresholds")?.cells ?? [];
      const font = (arm: string, id: string): Json | undefined => (step(arm, "fonts")?.switches ?? []).find((c: Json) => c.id === id);
      const has = (cell: Json | undefined, prefix: string) => (cell?.failures ?? []).some((f: string) => f.startsWith(prefix));
      const glyphs = (arm: string): Json | undefined => step(arm, "glyphs")?.variants?.native;
      const advance = (arm: string, family: string): number | undefined => (step(arm, "advance")?.rows ?? []).find((r: Json) => r.family === family)?.maxCumPx;
      const routed = (arm: string, family: string): number | undefined => (step(arm, "advance")?.rows ?? []).find((r: Json) => r.family === family)?.compat;
      const problems: string[] = [];
      for (const [arm, run] of Object.entries(runs)) if (!run.data) problems.push(`${arm}: no report (exit ${run.code})`);
      for (const arm of Object.keys(runs)) for (const e of runs[arm].data?.errors ?? []) if (String(e).includes("harness")) problems.push(`${arm}: ${String(e).slice(0, 160)}`);
      if (!problems.length) {
        const clean = cells("clean");
        if (!clean.length || clean.some(c => !c.pass)) problems.push(`clean: town threshold probes should pass (${clean.map(c => `${c.key} ${c.pass ? "PASS" : c.failures[0]}`).join("; ")})`);
        if (!cells("freeze").some(c => !c.pass && c.break === "freeze" && c.failures.some((f: string) => /missing on the GPU|GPU paints/.test(f)))) problems.push("freeze: no frozen threshold probe was caught by the visible-set check");
        if (!font("clean", "builtin") || has(font("clean", "builtin"), "re-atlas") || has(font("clean", "builtin"), "harness")) problems.push(`clean: builtin switch should re-atlas (${font("clean", "builtin")?.failures?.[0] ?? "no cell"})`);
        if (!has(font("freeze", "builtin"), "re-atlas")) problems.push("freeze: the builtin switch's missed re-atlas was not caught");
        if (!font("clean", "broken") || has(font("clean", "broken"), "broken font") || has(font("clean", "broken"), "harness")) problems.push(`clean: broken font routing should pass (${font("clean", "broken")?.failures?.[0] ?? "no cell"})`);
        // pixel registration and presence: clean registers every sampled glyph near 0, shift moves it, drop loses it
        const [cg, sg, dg] = [glyphs("clean"), glyphs("shift"), glyphs("drop")];
        if (!cg?.summary) problems.push("clean: no native glyph variant");
        else {
          if (cg.summary.missingLabels || cg.summary.pixel?.missing) problems.push(`clean: ${cg.summary.missingLabels} labels and ${cg.summary.pixel?.missing} glyphs missing on the GPU`);
          if (!(cg.summary.pixel?.p50 <= 1)) problems.push(`clean: pixel registration p50 ${cg.summary.pixel?.p50} should be within 1 device px`);
        }
        if (!(sg?.summary?.pixel?.p50 > 1.5) || !(sg?.failures ?? []).some((f: string) => f.startsWith("pixel:"))) problems.push(`shift: pixel registration should see the 2 device px shift (p50 ${sg?.summary?.pixel?.p50}, failures ${JSON.stringify(sg?.failures ?? null)})`);
        if (!(dg?.summary?.missingLabels > 0) || !(dg?.summary?.pixel?.missing > 0) || !(dg?.failures ?? []).some((f: string) => f.startsWith("presence:"))) problems.push(`drop: the blanked labels should be missing, not registered (missing labels ${dg?.summary?.missingLabels}, glyphs ${dg?.summary?.pixel?.missing})`);
        for (const family of ["Georgia", "Almendra SC"]) {
          const [c, b] = [advance("clean", family), advance("measure", family)];
          if (!(c !== undefined && c <= 1)) problems.push(`clean: ${family} advance ${c} should be within 1 device px`);
          if (!(b !== undefined && b > 1)) problems.push(`measure: ${family} advance ${b} should exceed 1 device px`);
          const [cr, br] = [routed("clean", family), routed("measure", family)];
          if (cr !== 0) problems.push(`clean: ${family} should route no advance case to compat (${cr})`);
          if (!(br !== undefined && br > 0)) problems.push(`measure: text.ts's shaping check should route ${family} to compat (${br} cases)`);
        }
      }
      return {
        exit_code: problems.length ? 1 : 0,
        failure: problems.length ? problems.join(" | ") : null,
        metrics: {
          thresholds: { clean: cells("clean").map(c => `${c.key}:${c.pass ? "PASS" : "FAIL"}`), freeze: cells("freeze").map(c => `${c.key}:${c.pass ? "PASS" : "FAIL"}`) },
          fonts: { clean: font("clean", "builtin")?.failures?.length ?? null, freeze: font("freeze", "builtin")?.failures?.filter((f: string) => f.startsWith("re-atlas")).length ?? null },
          advance: { clean: advance("clean", "Georgia"), measure: advance("measure", "Georgia") },
          routed: { clean: routed("clean", "Georgia"), measure: routed("measure", "Georgia") },
          pixel: Object.fromEntries(["clean", "shift", "drop"].map(arm => [arm, { p50: glyphs(arm)?.summary?.pixel?.p50, withinTol: glyphs(arm)?.summary?.pixel?.withinTol, missingGlyphs: glyphs(arm)?.summary?.pixel?.missing, missingLabels: glyphs(arm)?.summary?.missingLabels }]))
        }
      };
    }
  },
  // ---- end LABELS
  "paired-summary": {
    lock: null,
    keys: ["dpr", "dirs"],
    timeout: 60,
    run: ctx => {
      const dirs = ctx.args.dirs ? String(ctx.args.dirs).split(",") : findPairedBlocks(Number(ctx.args.dpr));
      if (dirs.length !== 5) {
        return Promise.resolve({ exit_code: 1, failure: `need five passing paired blocks at dpr ${ctx.args.dpr} from one dist; found ${dirs.length} (run gate paired block=1..5)`, metrics: {} });
      }
      const report = join(ctx.dir, "report.json");
      const env = { PAIRED_DPR: String(ctx.args.dpr), PAIRED_DIRS: dirs.join(","), PAIRED_OUTPUT: report };
      return runScript(ctx, nodeScript("bench/host/paired-summary.ts"), env, report, 60, data => {
        const analyses = data?.analyses ?? [];
        const bad = analyses.filter((a: Json) => !a.comparable);
        return {
          failure: bad.length ? `not comparable: ${bad.map((a: Json) => `${a.metric} (${(a.problems ?? []).join("; ")})`).join(", ")}` : null,
          metrics: {
            dist: data?.distFingerprint?.slice(0, 12),
            slots: data?.slotCount,
            frame: analyses
              .find((a: Json) => a.metric === "frame")
              ?.cells?.map((c: Json) => ({ cell: `${c.world}/${c.gesture}`, svgP50: round(c.A?.p50, 1), gpuP50: round(c.B?.p50, 1), deltaMs: round(c.medianDeltaMs, 1), ci95: c.ci95?.map((v: number) => round(v, 1)) }))
          }
        };
      });
    }
  }
};

function boundary(ctx: Ctx, before: boolean): Promise<Partial<Result>> {
  const report = join(ctx.dir, "report.json");
  const env: Record<string, string> = { BUNDLE_BOUNDARY_OUTPUT: report };
  if (before) env.BUNDLE_BOUNDARY_EXPECT = "present";
  return runScript(ctx, nodeScript("bench/renderer-bundle-boundary.ts"), env, report, 60, data => ({
    failure: data && !data.expectationMet ? `expectation not met: ${data.expectation}` : null,
    metrics: data && { boundaryClean: data.boundaryClean, expectation: data.expectation, expectationMet: data.expectationMet }
  }));
}

async function timing(ctx: Ctx, script: string): Promise<Partial<Result>> {
  const report = join(ctx.dir, "report.json");
  const env = {
    ...benchNavEnv(ctx, "2", Boolean(ctx.args.headless)),
    BENCH_RENDERER: String(ctx.args.arm),
    BENCH_OUTPUT: report,
    BENCH_TRACE: ctx.args.trace ? "1" : "0",
    BENCH_TRACE_DIR: join(ctx.dir, "traces")
  };
  const result = await runScript(ctx, nodeScript(script), env, report, 900, data => ({
    failure: reportFailure(data),
    metrics: data && {
      renderer: data.renderer,
      end: data.rendererStatus?.end?.active,
      runs: (data.runs ?? []).map((r: Json) => ({
        world: r.world,
        gesture: r.gesture,
        frameP95: round(r.frame?.p95, 2),
        inputDispatchP95: round(r.inputDispatch?.p95, 2),
        callbackP95: round(r.callback?.p95, 2)
      }))
    }
  }));
  const profiles = compactCpuProfiles(ctx.dir);
  if (profiles.length) result.metrics = { ...result.metrics, cpu_profiles: profiles };
  return result;
}

// ---------------------------------------------------------------- orchestration

// `mode` is the tier's lock mode when a tier runs the check (the strongest any of its steps needs).
// `dist`: keep = a tier holds the shared dist lock past this check; expect = the fingerprint the tier's dist must still have.
async function runCheck(check: string, args: Args, mode: LockMode | null = null, quiet = false, dist: { keep?: boolean; expect?: string | null } = {}): Promise<Result> {
  const def = DEFS[check];
  const dir = makeDir(check);
  const logPath = join(dir, "run.log");
  writeFileSync(logPath, "");
  let fixture: string | null = null;
  const ctx: Ctx = {
    check,
    args,
    dir,
    log: logPath,
    map: () => (fixture ??= args.fixture ? resolveNamedFixture(String(args.fixture)) : resolveFixture()),
    env: (extra = {}) => {
      const env: Record<string, string> = {
        PATH: [dirname(NODE), BIN, "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
        HOME: homedir(),
        TMPDIR: process.env.TMPDIR || "/tmp",
        CF_BUILD: "1",
        GATE_OUT_DIR: dir,
        TUPAIA_GATE_LOCK_HELD: "1"
      };
      for (const key of ["LANG", "PLAYWRIGHT_BROWSERS_PATH", "USER"]) if (process.env[key]) env[key] = process.env[key]!;
      if (def.lock) env.GATE_MAP = ctx.map();
      return { ...env, ...extra };
    }
  };
  if (!quiet) log(`${check} ${JSON.stringify(args)} -> ${dir}`);
  let started = Date.now();
  let lockWait = 0;
  let partial: Partial<Result>;
  let distHere = false;
  try {
    if (def.lock && !existsSync(join(REPO, "dist/index.html"))) throw new EnvError("dist/ is missing: run `gate build` first");
    if (def.lock) ctx.map(); // a missing fixture is a usage error before any lock wait
    if (def.lock && !lock.held) {
      // `toggles passes=...cost` records click-to-frame timings: those need the exclusive lock, not a shared slot
      const timed = check === "toggles" && String(args.passes).split(",").includes("cost");
      await lock.acquire(timed ? "exclusive" : (mode ?? def.lock));
      lockWait = lock.waitSeconds;
      started = Date.now(); // runtime excludes the wait for the host lock
    }
    if (def.lock && !distLock.held) {
      // shared: any number of checks read dist/ together; a `gate build` in this worktree waits for them (see distLock)
      await distLock.acquire("shared");
      distHere = true;
      started = Date.now();
    }
    if (def.lock && dist.expect && distFingerprint() !== dist.expect)
      throw new EnvError("dist/ changed since this tier started (another build in this worktree): results would mix two builds; rerun the tier");
    partial = await def.run(ctx);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    partial = { exit_code: 1, failure: `gate error: ${error instanceof Error ? error.stack : error}` };
  } finally {
    if (distHere && !dist.keep) await distLock.release();
  }
  const result: Result = {
    check,
    exit_code: partial.exit_code ?? 1,
    failure: partial.failure ?? null,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    args,
    metrics: partial.metrics ?? {},
    dir,
    log: logPath,
    report: partial.report ?? null
  };
  if (result.failure && result.exit_code === 0) result.exit_code = 1;
  if (lockWait > 1) result.lock_wait_s = Number(lockWait.toFixed(1));
  if (def.lock && lock.mode) result.lock_mode = lock.mode;
  if (partial.images) {
    if (Object.keys(partial.images).length) result.images = partial.images;
  }
  else if (def.lock) {
    const found = images(dir);
    if (Object.keys(found).length) result.images = found;
  }
  if (result.failure) result.log_tail = tail(logPath, 1500);
  const receipt = {
    ...result,
    git: { head: git("rev-parse", "HEAD"), branch: git("rev-parse", "--abbrev-ref", "HEAD"), dirty: git("status", "--porcelain").split("\n").filter(Boolean).length },
    dist: def.lock || check === "build" ? distFingerprint() : undefined,
    fixture: fixture ? { path: fixture, sha256: fixture === FIXTURE_CACHE ? FIXTURE_SHA : sha256File(fixture) } : undefined,
    lock: def.lock
      ? { path: LOCK_PATH, mode: lock.mode, slot: lock.slot, slots: lock.options.slots, inherited: lock.inherited, waitSeconds: lock.waitSeconds }
      : undefined,
    finishedUtc: new Date().toISOString(),
    worktree: REPO
  };
  writeFileSync(join(dir, "summary.json"), JSON.stringify(receipt, null, 2) + "\n");
  if (!quiet) log(`${check} ${result.failure ? "FAIL" : "PASS"} in ${result.seconds}s${result.failure ? `: ${result.failure.split("\n")[0].slice(0, 200)}` : ""}`);
  return result;
}

const TIERS: Record<string, Array<[string, Args]>> = {
  quick: [
    ["typecheck", {}],
    ["typecheck-bench", {}],
    ["unit", {}],
    ["build", { typecheck: false }]
  ],
  browser: [
    ["build", { typecheck: true }],
    ["canonical", {}],
    ["palette", {}],
    ["picking", {}],
    ["integration", { cohort: "short" }],
    // the golden harness can still fail (dropped GPU path) and still pass (ocean k=1), before its verdicts are trusted
    ["golden-selftest", {}],
    // D5 gate scale: default preset, k {1,4}, dpr 2, every layer family, on the parity fixture (FIX packet)
    ["golden", { layers: "all", k: "1,4", dpr: "2", preset: "default", fixture: "parity", census: "tests/fixtures/parity/census-expectations.json" }],
    // the lazy-COA race (emblems follow symbols that arrive after the GPU prepared; the renderer observes #coas since W3 LIFE3)
    ["coa-race", {}],
    // W3 COST: compat raster reuse against the SVG across a zoom, a move, a toggle and a definition edit, and the self-test that
    // it can still fail (a blind tracker, a tracker blind to definitions only). Together ~11 min measured, under the 25 min bar
    ["reuse-fidelity-selftest", {}],
    ["reuse-fidelity", {}],
    // G-E editor replay (svg recorded, gpu and gpu-select replayed) and the document consumers (rows 31-38, 40)
    ["replay-selftest", {}],
    ["replay", {}],
    ["consumers-selftest", {}],
    ["consumers", {}],
    // wave 2 census: layer toggles + reorder + trade (rows 26, 27), customization (row 25), resize / dpr / print / the
    // 12 layers presets (row 39). About 16 minutes together; memory-cycles and census-selftest are nightly (~35 minutes)
    ["toggles", {}],
    ["customization", {}],
    ["resize-print", {}],
    // wave 2: label fidelity (rows 15, 16, 41), the stroke width/dash/join probe, trade animation smoke (row 22)
    ["labels-selftest", {}],
    ["labels", {}],
    ["stroke-probe", {}],
    ["smoke", {}]
  ],
  // D5 nightly matrix: k {1,2,4,8} plus the coastline switch points, dpr {1,2}, the 12 built-in presets. One golden
  // step per (dpr, preset) so a failure names its cell and the rest keep going (keep_going is implied). PNGs are kept
  // for failing cells only: the full matrix is ~4 000 cells.
  nightly: [1, 2].flatMap(dpr =>
    STYLE_PRESETS.map(
      preset =>
        [
          "golden",
          { layers: "all", k: "1,2,4,8", coastk: "1.4,1.6,2.5,2.7", dpr: String(dpr), preset, fixture: "parity", keep: "fail" }
        ] as [string, Args]
    )
  ).concat([
    // W3 PICK: the picking gate at zoom 1 and 4 (the browser tier runs zoom 2 only). PICK2 makes them pass; nightly keeps
    // going past a failure, so a failing one is recorded here without stopping the matrix or the browser tier
    ["picking", { zoom: "1" }],
    ["picking", { zoom: "4" }],
    // gate gap 16: 20 world-replace cycles + resizes with no growth (~20 min); and the census checks' own self-tests (~20 min)
    ["memory-cycles", {}],
    ["census-selftest", {}],
    // row 33: legacy maps from old versions through load + auto-update, svg against gpu (~13 min)
    ["corpus-selftest", {}],
    ["corpus", {}]
  ] as Array<[string, Args]>)
};
TIERS.full = [
  ...TIERS.browser,
  ["fidelity", {}],
  ["navigation", {}],
  ["trade-live", {}],
  ["metrics", { manifest: "fresh" }],
  ...[1, 2, 3, 4, 5].map(block => ["paired", { dpr: 2, block }] as [string, Args]),
  ["paired-summary", { dpr: 2 }]
];

async function runTier(tier: string, args: Args): Promise<number> {
  const skip = new Set(String(args.skip || "").split(",").filter(Boolean));
  for (const name of skip) if (!TIERS[tier].some(([c]) => c === name)) throw new UsageError(`skip=${name}: not a step of ${tier}`);
  const tierDir = makeDir(tier);
  const started = Date.now();
  const steps: Json[] = [];
  let failedAt: string | null = null;
  const pairedDirs: string[] = [];
  // The dist this tier runs on: set when its build step passes (or at its first browser step when `build` is skipped).
  // A browser tier keeps the shared dist lock to its end, so a build in this worktree waits; nightly gives it back between
  // steps (it lasts hours) and relies on the fingerprint check to refuse a rebuilt dist/.
  let tierDist: string | null = null;
  // One lock for the whole tier, taken at its first browser step: exclusive if any step that will run needs it.
  // (nightly releases it after each step; see below.)
  const modes = TIERS[tier].filter(([check]) => !skip.has(check)).map(([check]) => DEFS[check].lock);
  const mode: LockMode | null = modes.includes("exclusive") ? "exclusive" : modes.includes("shared") ? "shared" : null;
  const keepGoing = Boolean(args.keep_going) || tier === "nightly";
  for (const [check, preset] of TIERS[tier]) {
    const label =
      check === "paired"
        ? `paired#${preset.block}`
        : check === "golden" && tier === "nightly"
          ? `golden[d${preset.dpr} ${preset.preset}]`
          : check === "picking" && preset.zoom
            ? `picking[k${preset.zoom}]`
            : check;
    if (skip.has(check)) {
      steps.push({ check: label, status: "SKIP" });
      continue;
    }
    if (failedAt && !keepGoing) {
      steps.push({ check: label, status: "NOT RUN" });
      continue;
    }
    const stepArgs = parseArgs(check, [], DEFS[check].keys, DEFS[check].spec);
    Object.assign(stepArgs, preset);
    if (check === "paired-summary" && pairedDirs.length === 5) stepArgs.dirs = pairedDirs.join(",");
    let result: Result;
    try {
      result = await runCheck(check, stepArgs, mode, false, { keep: tier !== "nightly", expect: tierDist });
    } catch (error) {
      if (!(error instanceof UsageError) || error instanceof EnvError) {
        await releaseLocks();
        throw error;
      }
      // e.g. the parity fixture is not there yet: this step fails, the tier reports it and goes on as configured
      steps.push({ check: label, status: "FAIL", exit_code: 2, failure: `usage: ${error.message}` });
      failedAt ??= label;
      continue;
    }
    if (check === "paired" && !result.failure) pairedDirs.push(result.dir);
    if (!result.failure && (check === "build" || (DEFS[check].lock && !tierDist))) tierDist = distFingerprint();
    steps.push({ check: label, status: result.failure ? "FAIL" : "PASS", seconds: result.seconds, exit_code: result.exit_code, failure: result.failure, metrics: result.metrics, dir: result.dir });
    if (result.failure) failedAt ??= label;
    // nightly: give the host lock back between golden steps, so a queued exclusive (timing) run gets in between
    // instead of waiting out the 3-4 h matrix behind one tier-wide shared hold
    if (tier === "nightly") await lock.release();
  }
  await releaseLocks();
  const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
  const pass = !failedAt;
  // Table on stderr; one JSON line on stdout.
  const width = Math.max(...steps.map(s => s.check.length), 8);
  const lines = [`${"check".padEnd(width)}  result   seconds  detail`];
  for (const s of steps) {
    const detail = s.failure ? s.failure.split("\n")[0].slice(0, 90) : s.dir ? basename(s.dir) : "";
    lines.push(`${s.check.padEnd(width)}  ${s.status.padEnd(7)}  ${String(s.seconds ?? "").padStart(7)}  ${detail}`);
  }
  lines.push(`${tier}: ${pass ? "PASS" : `FAIL at ${failedAt}`} in ${seconds}s  (evidence: ${tierDir})`);
  process.stderr.write("\n" + lines.join("\n") + "\n");
  const summary = { tier, pass, failed_at: failedAt, seconds, dir: tierDir, lock_mode: mode, steps: steps.map(({ metrics, ...rest }) => rest) };
  writeFileSync(join(tierDir, "summary.json"), JSON.stringify({ ...summary, steps, git: { head: git("rev-parse", "HEAD"), branch: git("rev-parse", "--abbrev-ref", "HEAD") }, worktree: REPO }, null, 2) + "\n");
  process.stdout.write(JSON.stringify(summary) + "\n");
  return pass ? 0 : 1;
}

function usage(): string {
  return [
    "usage: node bench/gate/gate.ts <check|tier> [key=value ...]",
    `tiers:  ${Object.keys(TIERS).join(", ")}   (key: skip=a,b  keep_going=1)`,
    `checks (lock: shared = correctness, at most TUPAIA_GATE_SLOTS=${lock.options.slots} at once; exclusive = timing, alone):`,
    ...Object.entries(DEFS).map(([name, def]) => {
      const spec = (k: string) => def.spec?.[k] ?? ARG_SPEC[k];
      return `  ${name.padEnd(16)} ${(def.lock ?? "").padEnd(9)} ${def.keys.map(k => `${k}=${spec(k).values?.join("|") ?? spec(k).type}`).join(" ")}`;
    }),
    `golden families: ${FAMILY_NAMES.join(", ")}`,
    `evidence: ${OUT_BASE}/<check>-<timestamp>/`
  ].join("\n");
}

async function main(): Promise<number> {
  const [target, ...rest] = process.argv.slice(2);
  if (!target || target === "help" || target === "--help" || target === "-h") {
    process.stderr.write(usage() + "\n");
    return target ? 0 : 2;
  }
  if (TIERS[target]) return runTier(target, parseArgs(target, rest, ["skip", "keep_going"]));
  const def = DEFS[target];
  if (!def) {
    process.stderr.write(usage() + "\n");
    throw new UsageError(`Unknown check "${target}"`);
  }
  const args = parseArgs(target, rest, def.keys, def.spec);
  if (args.layer && !["smoke", "fidelity"].includes(target)) throw new UsageError("layer is only valid for smoke/fidelity");
  const result = await runCheck(target, args);
  await releaseLocks();
  process.stdout.write(JSON.stringify(result) + "\n");
  return result.failure ? 1 : 0;
}

main().then(
  code => process.exit(code),
  async error => {
    await releaseLocks();
    if (error instanceof UsageError) {
      process.stderr.write(`gate: ${error.message}\n`);
      process.stdout.write(JSON.stringify({ check: process.argv[2] ?? null, exit_code: 2, failure: error.message }) + "\n");
      process.exit(2);
    }
    process.stderr.write(`gate: ${error instanceof Error ? error.stack : error}\n`);
    process.exit(2);
  }
);
