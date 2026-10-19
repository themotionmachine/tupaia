import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  abbaSchedule,
  analyzeAb,
  type AbSlot,
  bootstrapMedianDelta,
  captureProblems,
  compareRgba,
  fileFixtureIdentity,
  generatedFixtureIdentity,
  INPUT_METHODS,
  parseRendererEnv,
  percentile,
  rendererQuery,
  sameFixture,
  unsupportedGpuCapture
} from "./renderer-ab.ts";

test("BENCH_RENDERER accepts only svg/gpu and leaves the URL unchanged when unset", () => {
  assert.equal(parseRendererEnv(undefined), undefined);
  assert.equal(parseRendererEnv(""), undefined);
  assert.equal(parseRendererEnv("gpu"), "gpu");
  assert.throws(() => parseRendererEnv("GPU"), /Invalid BENCH_RENDERER/);
  assert.throws(() => parseRendererEnv("webgl"), /Invalid BENCH_RENDERER/);
  assert.equal(rendererQuery(undefined), "");
  assert.equal(rendererQuery("svg"), "&renderer=svg");
});

test("ABBA schedule is balanced, alternates orientation and is reproducible per seed", () => {
  const schedule = abbaSchedule(4, 1);
  assert.equal(schedule.length, 8);
  assert.equal(schedule.filter(s => s.arm === "A").length, 4);
  const pairs = [0, 1, 2, 3].map(pair =>
    schedule
      .filter(s => s.pair === pair)
      .map(s => s.arm)
      .join("")
  );
  assert.ok(pairs.every(p => p === "AB" || p === "BA"));
  for (let i = 1; i < pairs.length; i++) assert.notEqual(pairs[i], pairs[i - 1]);
  assert.deepEqual(abbaSchedule(4, 1), schedule);
  assert.deepEqual(
    schedule.map(s => s.slot),
    [0, 1, 2, 3, 4, 5, 6, 7]
  );
  const firsts = new Set(Array.from({ length: 32 }, (_, seed) => abbaSchedule(1, seed)[0].arm));
  assert.deepEqual([...firsts].sort(), ["A", "B"]);
  assert.throws(() => abbaSchedule(0, 1));
});

test("nearest-rank percentiles match hand-computed values", () => {
  const values = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
  assert.equal(percentile(values, 0.5), 6);
  assert.equal(percentile(values, 0.95), 10);
  assert.equal(percentile([7], 0.95), 7);
  assert.ok(Number.isNaN(percentile([], 0.5)));
});

test("bootstrap CI collapses for constant arms and brackets a clear shift", () => {
  assert.deepEqual(bootstrapMedianDelta([10, 10, 10], [12, 12, 12], 3), [2, 2]);
  const a = [10, 11, 9, 10, 12, 10, 11, 9],
    b = a.map(n => n + 20);
  const [low, high] = bootstrapMedianDelta(a, b, 9);
  assert.ok(low > 15 && high < 25 && low <= 20 && high >= 20, `${low}..${high}`);
  assert.deepEqual(bootstrapMedianDelta([1, 2], [3, 4], 5), bootstrapMedianDelta([1, 2], [3, 4], 5));
});

test("fixture identity hashes the real demo map and its SVG section", () => {
  const text = readFileSync(new URL("../tests/fixtures/demo.map", import.meta.url), "utf8");
  const identity = fileFixtureIdentity("demo", text);
  assert.equal(identity.sections, 40);
  assert.match(identity.sha256 || "", /^[0-9a-f]{64}$/);
  assert.match(identity.svgSha256 || "", /^[0-9a-f]{64}$/);
  assert.notEqual(identity.sha256, identity.svgSha256);
  assert.ok(sameFixture(identity, fileFixtureIdentity("renamed", text)));
  assert.ok(!sameFixture(identity, fileFixtureIdentity("demo", text + " ")));
  const generated = generatedFixtureIdentity("100k", { cells: 100000, seed: "7319" });
  assert.ok(sameFixture(generated, generatedFixtureIdentity("100k", { cells: 100000, seed: "7319" })));
  assert.ok(!sameFixture(generated, identity));
  assert.equal(fileFixtureIdentity("plain", "no sections").svgSha256, undefined);
});

test("RGBA fidelity counts pixels beyond tolerance and refuses incomparable images", () => {
  const a = { width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 100, 100, 100, 255]) };
  const b = { width: 2, height: 1, data: new Uint8Array([0, 0, 2, 255, 100, 140, 100, 255]) };
  assert.deepEqual(compareRgba(a, b, 2), {
    comparable: true,
    pixels: 2,
    mismatchedPixels: 1,
    mismatchFraction: 0.5,
    maxChannelDelta: 40,
    meanAbsChannelDelta: 42 / 8
  });
  const strict = compareRgba(a, b, 0);
  assert.equal(strict.comparable && strict.mismatchedPixels, 2);
  assert.deepEqual(compareRgba(a, { ...b, width: 1, height: 2 }), { comparable: false, reason: "Image sizes differ" });
  assert.deepEqual(compareRgba(a, { width: 2, height: 1, data: new Uint8Array(3) }), {
    comparable: false,
    reason: "Malformed RGBA image"
  });
});

test("default GPU capture adapter reports unsupported and fabricates nothing", async () => {
  const request = { renderer: "gpu" as const, world: "demo", viewport: [1280, 720] as [number, number], deviceScaleFactor: 1 };
  const result = await unsupportedGpuCapture().capture(request);
  assert.equal(result.supported, false);
  assert.ok(!("image" in result));
  assert.deepEqual(captureProblems(request, result), []);
  const wrong = {
    supported: true as const,
    adapter: "test",
    image: { width: 640, height: 360, data: new Uint8Array(640 * 360 * 4) },
    gpu: { vendor: "", renderer: "" },
    activeRenderer: "svg" as const
  };
  assert.deepEqual(captureProblems(request, wrong), [
    "Capture size mismatch",
    "Requested gpu but captured svg",
    "Missing GPU provenance"
  ]);
});

test("input method labels never mark injected input as native", () => {
  assert.equal(INPUT_METHODS["synthetic-dom"].native, false);
  assert.equal(INPUT_METHODS["cdp-input"].native, false);
  assert.equal(INPUT_METHODS["os-native"].supported, false);
});

const demo = { label: "demo", source: "file" as const, sha256: "a".repeat(64) };
function slot(slot: number, arm: "A" | "B", requested: "svg" | "gpu", frames: number[], extra: Partial<AbSlot> = {}) {
  return {
    slot,
    arm,
    requested,
    active: requested,
    inputMethod: "synthetic-dom" as const,
    fixtures: { demo },
    runs: frames.map((p95, i) => ({
      world: "demo",
      gesture: "pan-near",
      iteration: i + 1,
      modelUnchanged: true,
      settledExact: true,
      frame: { p95 }
    })),
    ...extra
  } satisfies AbSlot;
}

test("A/B analysis pools per-arm samples and reports the median delta", () => {
  const report = analyzeAb(
    [slot(0, "A", "svg", [16, 17]), slot(1, "B", "svg", [20, 21]), slot(2, "B", "svg", [22]), slot(3, "A", "svg", [18])],
    "frame",
    1
  );
  assert.equal(report.comparable, true, report.problems.join("; "));
  assert.equal(report.cells.length, 1);
  assert.deepEqual(report.cells[0].A, { n: 3, p50: 17, p95: 18 });
  assert.deepEqual(report.cells[0].B, { n: 3, p50: 21, p95: 22 });
  assert.equal(report.cells[0].medianDeltaMs, 4);
});

test("A/B analysis is invalid when the GPU arm fell back, fixtures drift or input is unlabeled", () => {
  const fellBack = analyzeAb(
    [
      slot(0, "A", "svg", [16]),
      slot(1, "B", "gpu", [16], { active: "svg", fallbackReason: "GPU renderer unavailable until P1" })
    ],
    "frame",
    1
  );
  assert.equal(fellBack.comparable, false);
  assert.match(fellBack.problems.join("\n"), /Slot 1 requested gpu but ran svg: GPU renderer unavailable until P1/);
  const drift = analyzeAb(
    [slot(0, "A", "svg", [16]), slot(1, "B", "svg", [16], { fixtures: { demo: { ...demo, sha256: "b".repeat(64) } } })],
    "frame",
    1
  );
  assert.match(drift.problems.join("\n"), /Fixture demo differs/);
  const unlabeled = analyzeAb(
    [slot(0, "A", "svg", [16]), slot(1, "B", "svg", [16], { inputMethod: undefined })],
    "frame",
    1
  );
  assert.match(unlabeled.problems.join("\n"), /no supported input method/);
  assert.equal(analyzeAb([slot(0, "A", "svg", [16])], "frame", 1).comparable, false);
});


test("A/B GPU claims require presentation throughout each measured gesture", () => {
  const svg = slot(0, "A", "svg", [16]);
  const gpu = slot(1, "B", "gpu", [8]);
  const presented = { ...gpu, runs: gpu.runs.map(run => ({ ...run, gpuPresentedFraction: 1 })) };
  assert.equal(analyzeAb([svg, presented], "frame", 1).comparable, true);
  assert.match(analyzeAb([svg, gpu], "frame", 1).problems.join("\n"), /did not present GPU/);
  const partial = { ...gpu, runs: gpu.runs.map(run => ({ ...run, gpuPresentedFraction: 0.5 })) };
  assert.equal(analyzeAb([svg, partial], "frame", 1).comparable, false);
});


test("A/B analysis rejects idle cadence confounds even when GPU is presented", () => {
  const a = slot(0, "A", "svg", [16]);
  const b = slot(1, "B", "gpu", [8]);
  const withIdle = (s: typeof a, p95: number) => ({ ...s, runs: s.runs.map(r => ({ ...r, gpuPresentedFraction: 1, idleFrame: {p95} })) });
  assert.equal(analyzeAb([withIdle(a,8.3),withIdle(b,8.4)],"frame",1).comparable,true);
  assert.match(analyzeAb([withIdle(a,8.3),withIdle(b,33.3)],"frame",1).problems.join("\n"), /Idle cadence differs/);
});
