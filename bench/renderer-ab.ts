// Pure helpers for renderer A/B parity runs. No browser imports: bench/renderer-ab-run.ts drives navigation.ts.
import { createHash } from "node:crypto";

export type RendererKind = "svg" | "gpu";
export type Arm = "A" | "B";

// Labels describe how input reaches the page. Neither supported method is physical input.
export type InputMethod = "synthetic-dom" | "cdp-input" | "os-native";
export const INPUT_METHODS: Record<InputMethod, { supported: boolean; native: boolean; description: string }> = {
  "synthetic-dom": {
    supported: true,
    native: false,
    description:
      "In-page dispatchEvent of MouseEvent/WheelEvent (bench/navigation.ts); bypasses browser hit testing, input routing and compositor scrolling"
  },
  "cdp-input": {
    supported: true,
    native: false,
    description:
      "Playwright page.mouse via CDP Input.dispatch* (bench/navigation-quality.ts); browser hit testing and routing, injected rather than OS input"
  },
  "os-native": { supported: false, native: true, description: "Physical or OS-level input; not available in this harness" }
};

export function parseRendererEnv(value: string | undefined): RendererKind | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "svg" || value === "gpu") return value;
  throw new Error("Invalid BENCH_RENDERER: " + value);
}

// Unset renderer leaves the benchmark URL byte-identical to earlier runs.
export function rendererQuery(renderer: RendererKind | undefined): string {
  return renderer ? "&renderer=" + renderer : "";
}

export interface FixtureIdentity {
  label: string;
  source: "file" | "generated";
  sha256?: string;
  bytes?: number;
  sections?: number;
  svgSha256?: string;
  generator?: Record<string, string | number>;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function fileFixtureIdentity(label: string, text: string): FixtureIdentity {
  const sections = text.split("\r\n");
  return {
    label,
    source: "file",
    sha256: sha256(text),
    bytes: Buffer.byteLength(text),
    sections: sections.length,
    svgSha256: sections.length > 5 && sections[5].startsWith("<svg") ? sha256(sections[5]) : undefined
  };
}

export function generatedFixtureIdentity(label: string, generator: Record<string, string | number>): FixtureIdentity {
  return { label, source: "generated", generator };
}

export function sameFixture(a: FixtureIdentity | undefined, b: FixtureIdentity | undefined): boolean {
  if (!a || !b || a.source !== b.source) return false;
  return a.source === "file" ? a.sha256 === b.sha256 : JSON.stringify(a.generator) === JSON.stringify(b.generator);
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Counterbalanced ABBA blocks: each pair alternates orientation and the seed picks the first one.
export function abbaSchedule(repeats: number, seed: number): { slot: number; pair: number; arm: Arm }[] {
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("A/B repeats must be a positive integer");
  const flip = seededRandom(seed)() < 0.5 ? 0 : 1;
  const slots: { slot: number; pair: number; arm: Arm }[] = [];
  for (let pair = 0; pair < repeats; pair++)
    for (const arm of (pair + flip) % 2 ? (["B", "A"] as const) : (["A", "B"] as const))
      slots.push({ slot: slots.length, pair, arm });
  return slots;
}

// Same nearest-rank definition as navigation.ts summary().
export function percentile(values: number[], p: number): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export function summary(values: number[]) {
  return { n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

// Percentile bootstrap of median(B) - median(A), resampling each arm independently.
export function bootstrapMedianDelta(a: number[], b: number[], seed: number, iterations = 2000): [number, number] {
  if (!a.length || !b.length) return [Number.NaN, Number.NaN];
  const random = seededRandom(seed),
    deltas: number[] = [];
  const resample = (values: number[]) =>
    percentile(
      values.map(() => values[Math.floor(random() * values.length)]),
      0.5
    );
  for (let i = 0; i < iterations; i++) deltas.push(resample(b) - resample(a));
  deltas.sort((x, y) => x - y);
  return [deltas[Math.floor(iterations * 0.025)], deltas[Math.min(iterations - 1, Math.floor(iterations * 0.975))]];
}

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export type Fidelity =
  | { comparable: false; reason: string }
  | {
      comparable: true;
      pixels: number;
      mismatchedPixels: number;
      mismatchFraction: number;
      maxChannelDelta: number;
      meanAbsChannelDelta: number;
    };

// Per-pixel RGBA comparison. A pixel mismatches when any channel differs by more than channelTolerance.
export function compareRgba(a: RgbaImage, b: RgbaImage, channelTolerance = 0): Fidelity {
  for (const image of [a, b])
    if (image.width <= 0 || image.height <= 0 || image.data.length !== image.width * image.height * 4)
      return { comparable: false, reason: "Malformed RGBA image" };
  if (a.width !== b.width || a.height !== b.height) return { comparable: false, reason: "Image sizes differ" };
  let mismatchedPixels = 0,
    maxChannelDelta = 0,
    total = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let pixelMax = 0;
    for (let c = 0; c < 4; c++) {
      const delta = Math.abs(a.data[i + c] - b.data[i + c]);
      total += delta;
      if (delta > pixelMax) pixelMax = delta;
    }
    if (pixelMax > channelTolerance) mismatchedPixels++;
    if (pixelMax > maxChannelDelta) maxChannelDelta = pixelMax;
  }
  const pixels = a.width * a.height;
  return {
    comparable: true,
    pixels,
    mismatchedPixels,
    mismatchFraction: mismatchedPixels / pixels,
    maxChannelDelta,
    meanAbsChannelDelta: total / a.data.length
  };
}

// Real capture comes from a registered adapter (bench/gpu-capture.ts, used by navigation-quality.ts). Without one,
// capture reports unsupported and never fabricates pixels.
export interface GpuCaptureRequest {
  renderer: RendererKind;
  world: string;
  viewport: [number, number];
  deviceScaleFactor: number;
}

export type GpuCaptureResult =
  | {
      supported: true;
      adapter: string;
      image: RgbaImage;
      gpu: { vendor: string; renderer: string };
      activeRenderer: RendererKind;
    }
  | { supported: false; adapter: string; reason: string };

export interface GpuCaptureAdapter {
  readonly name: string;
  capture(request: GpuCaptureRequest): Promise<GpuCaptureResult>;
}

export function unsupportedGpuCapture(reason = "No GPU capture adapter registered"): GpuCaptureAdapter {
  return { name: "unsupported", capture: async () => ({ supported: false, adapter: "unsupported", reason }) };
}

// Structural checks only; they cannot prove pixels came from a GPU, so adapters must report their own provenance.
export function captureProblems(request: GpuCaptureRequest, result: GpuCaptureResult): string[] {
  if (!result.supported) return [];
  const problems: string[] = [];
  const [width, height] = request.viewport.map(n => Math.round(n * request.deviceScaleFactor));
  if (result.image.width !== width || result.image.height !== height) problems.push("Capture size mismatch");
  if (result.image.data.length !== result.image.width * result.image.height * 4) problems.push("Malformed capture");
  if (result.activeRenderer !== request.renderer)
    problems.push(`Requested ${request.renderer} but captured ${result.activeRenderer}`);
  if (!result.gpu.vendor || !result.gpu.renderer) problems.push("Missing GPU provenance");
  return problems;
}

export type Metric = "frame" | "callback" | "inputDispatch" | "idleFrame";

export interface AbRun {
  world: string;
  gesture: string;
  iteration: number;
  modelUnchanged?: boolean;
  settledExact?: boolean;
  finalCameraExact?: boolean;
  gpuPresentedFraction?: number;
  frame?: { p95: number };
  callback?: { p95: number };
  inputDispatch?: { p95: number };
  idleFrame?: { p95: number };
}

export interface AbSlot {
  slot: number;
  arm: Arm;
  requested: RendererKind;
  active: RendererKind | null;
  fallbackReason?: string;
  inputMethod?: InputMethod;
  fixtures: Record<string, FixtureIdentity>;
  runs: AbRun[];
}

export interface AbCell {
  world: string;
  gesture: string;
  A: ReturnType<typeof summary>;
  B: ReturnType<typeof summary>;
  medianDeltaMs: number;
  ci95: [number, number];
}

// Pools per-iteration p95 values per arm. Any fallback, fixture drift or unsettled run makes the comparison invalid.
export function analyzeAb(slots: AbSlot[], metric: Metric, seed: number) {
  const problems: string[] = [];
  const arms: Record<Arm, AbSlot[]> = { A: [], B: [] };
  for (const slot of slots) arms[slot.arm].push(slot);
  if (!arms.A.length || !arms.B.length) problems.push("Both arms need at least one slot");
  for (const arm of ["A", "B"] as const) {
    const requested = new Set(arms[arm].map(slot => slot.requested));
    if (requested.size > 1) problems.push(`Arm ${arm} mixes renderers`);
  }
  for (const slot of slots) {
    if (slot.active !== slot.requested)
      problems.push(
        `Slot ${slot.slot} requested ${slot.requested} but ran ${slot.active ?? "unknown"}` +
          (slot.fallbackReason ? ": " + slot.fallbackReason : "")
      );
    if (!slot.inputMethod || !INPUT_METHODS[slot.inputMethod]?.supported)
      problems.push(`Slot ${slot.slot} has no supported input method label`);
    for (const run of slot.runs) {
      if (slot.requested === "gpu" && run.gpuPresentedFraction !== 1)
        problems.push(`Slot ${slot.slot} ${run.world}/${run.gesture}/${run.iteration} did not present GPU for every measured frame`);
      if (run.modelUnchanged === false || run.settledExact === false || run.finalCameraExact === false)
        problems.push(`Slot ${slot.slot} ${run.world}/${run.gesture}/${run.iteration} did not settle`);
    }
  }
  const first = slots[0];
  for (const slot of slots.slice(1)) {
    const worlds = new Set([...Object.keys(first.fixtures), ...Object.keys(slot.fixtures)]);
    for (const world of worlds)
      if (!sameFixture(first.fixtures[world], slot.fixtures[world]))
        problems.push(`Fixture ${world} differs between slot ${first.slot} and slot ${slot.slot}`);
    if (slot.inputMethod !== first.inputMethod) problems.push("Input method differs between slots");
  }
  const cells: AbCell[] = [];
  const keys = [...new Set(slots.flatMap(slot => slot.runs.map(run => run.world + "\u0000" + run.gesture)))].sort();
  for (const key of keys) {
    const [world, gesture] = key.split("\u0000");
    const values = (arm: Arm) =>
      arms[arm].flatMap(slot =>
        slot.runs
          .filter(run => run.world === world && run.gesture === gesture)
          .map(run => run[metric]?.p95)
          .filter((value): value is number => Number.isFinite(value))
      );
    const a = values("A"),
      b = values("B");
    const idle = (arm: Arm) => arms[arm].flatMap(slot => slot.runs.filter(run => run.world === world && run.gesture === gesture).map(run => run.idleFrame?.p95).filter((v): v is number => Number.isFinite(v)));
    const idleA = idle("A"), idleB = idle("B");
    if (idleA.length && idleB.length && Math.abs(percentile(idleA, 0.5) - percentile(idleB, 0.5)) > 2)
      problems.push(`Idle cadence differs by more than 2 ms for ${world}/${gesture}`);
    if (!a.length || !b.length) problems.push(`Missing ${metric} samples for ${world}/${gesture}`);
    cells.push({
      world,
      gesture,
      A: summary(a),
      B: summary(b),
      medianDeltaMs: percentile(b, 0.5) - percentile(a, 0.5),
      ci95: bootstrapMedianDelta(a, b, seed)
    });
  }
  return { metric, comparable: problems.length === 0, problems, cells };
}
