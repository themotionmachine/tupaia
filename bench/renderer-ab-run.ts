// Interleaved renderer A/B: runs bench/navigation.ts once per ABBA slot with BENCH_RENDERER set, then pools results.
// Host-run only. A gpu arm that fell back to svg marks the report not comparable rather than faked.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { abbaSchedule, type AbSlot, analyzeAb, type Arm, type Metric, parseRendererEnv } from "./renderer-ab.ts";

const arms: Record<Arm, "svg" | "gpu"> = {
  A: parseRendererEnv(process.env.BENCH_AB_A || "svg") || "svg",
  B: parseRendererEnv(process.env.BENCH_AB_B || "gpu") || "gpu"
};
const repeats = Number(process.env.BENCH_AB_REPEATS || 2);
const seed = Number(process.env.BENCH_AB_SEED || 7319);
const directory = resolve(process.env.BENCH_AB_OUTPUT || "bench/results/renderer-ab");
if (!Number.isInteger(seed)) throw new Error("Invalid BENCH_AB_SEED");
const schedule = abbaSchedule(repeats, seed);
mkdirSync(directory, { recursive: true });
const slots: AbSlot[] = [];
for (const { slot, arm } of schedule) {
  const output = resolve(directory, `slot-${slot}-${arm}-${arms[arm]}.json`);
  console.log(JSON.stringify({ slot, arm, renderer: arms[arm], output }));
  const child = spawnSync(process.execPath, ["bench/navigation.ts"], {
    stdio: "inherit",
    env: { ...process.env, BENCH_RENDERER: arms[arm], BENCH_OUTPUT: output }
  });
  if (child.status !== 0) throw new Error(`navigation.ts failed for slot ${slot} (${arms[arm]})`);
  const data = JSON.parse(readFileSync(output, "utf8"));
  slots.push({
    slot,
    arm,
    requested: data.renderer,
    active: data.rendererStatus?.end?.active ?? null,
    fallbackReason: data.rendererStatus?.end?.fallbackReason || undefined,
    inputMethod: data.inputMethod,
    fixtures: data.fixtures || {},
    runs: data.runs
  });
}
const metrics: Metric[] = ["frame", "callback", "inputDispatch", "idleFrame"];
const report = {
  schema: 1,
  arms,
  repeats,
  seed,
  schedule,
  analyses: metrics.map(metric => analyzeAb(slots, metric, seed)),
  limitations:
    "Each slot is a fresh browser process running bench/navigation.ts with synthetic DOM input. Pooled values are per-iteration p95s; CIs are percentile bootstraps of the median difference (B - A). A gpu arm that ran svg is reported, never relabeled. Timing only: pixel fidelity, hit testing and final camera come from bench/navigation-quality.ts with BENCH_RENDERER (CDP input, bench/gpu-capture.ts adapter)."
};
writeFileSync(resolve(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
for (const analysis of report.analyses)
  console.log(JSON.stringify({ metric: analysis.metric, comparable: analysis.comparable, problems: analysis.problems }));
