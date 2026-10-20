// Pure helpers of the legacy corpus (bench/host/corpus-load.ts, corpus-lib.test.ts): the migration gates read from
// src/io/auto-update.ts, the version ordering the loader uses (public/versioning.js), and the manifest rules. No
// browser and no I/O beyond what the caller passes in.

/** Parse "1.65.2"-style versions into [major, minor, patch] numbers. */
export const triple = (v: string): [number, number, number] => {
  const [a, b = "0", c = "0"] = v.split(".");
  return [Number.parseInt(a, 10) || 0, Number.parseInt(b, 10) || 0, Number.parseInt(c, 10) || 0];
};

/** public/versioning.js compareVersions(a, b).isOlder for two normalized versions. */
export const isOlder = (a: string, b: string): boolean => {
  const x = triple(a);
  const y = triple(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};

/** public/versioning.js parseMapVersion: "0.9b" -> 0.9.0, "1.732" -> 1.73.2 (compact), "1.90.01" -> 1.90.1. */
export const parseMapVersion = (version: string): string => {
  let [major, minor, patch] = version.split(".");
  if (patch === undefined) {
    const compact = minor ?? "";
    minor = compact.slice(0, 2);
    patch = compact.slice(2);
  }
  return `${Number.parseInt(major, 10) || 0}.${Number.parseInt(minor, 10) || 0}.${Number.parseInt(patch, 10) || 0}`;
};

/** Every `isOlderThan("x.y.z")` gate of auto-update.ts, in file order. */
export const gatesOf = (source: string): string[] => [...source.matchAll(/isOlderThan\("([\d.]+)"\)/g)].map(m => m[1]);

/** The gates a map written by `headerVersion` runs (header field 0, as the loader reads it). */
export const gatesTriggered = (headerVersion: string, gates: string[]): string[] => {
  const version = parseMapVersion(headerVersion);
  return gates.filter(gate => isOlder(version, gate));
};

export interface ManifestEntry {
  id: string;
  file: string;
  version: string;
  expect: "load" | "ancient";
  gates: string[];
  source: string;
  bytes: number;
  sha256: string;
  notes?: string;
}
export interface Manifest {
  schema: number;
  /** Gates no loadable map can trigger, with the reason. The coverage check allows exactly these and no others. */
  knownUnreachable: Array<{ gate: string; reason: string }>;
  /** Families whose golden is a known GPU fidelity gap (on the parity fixture too, or, with `maps`, only on those corpus maps). Their metric failures are reported, not gated, as long as they stay within the bounds (maxOver16, maxOver44 in percent, minSsim); an empty-arm or census failure is never excused. */
  goldenKnownGaps: Array<KnownGap & { reason: string; maps?: string[] }>;
  entries: ManifestEntry[];
}

/** Gates triggered by at least one entry that must load, and the ones nothing triggers. */
export function gateCoverage(gates: string[], entries: ManifestEntry[]): { exercised: Record<string, string[]>; unreached: string[] } {
  const exercised: Record<string, string[]> = {};
  for (const entry of entries) {
    if (entry.expect !== "load") continue;
    for (const gate of gatesTriggered(entry.version, gates)) (exercised[gate] ??= []).push(entry.id);
  }
  return { exercised, unreached: [...new Set(gates)].filter(gate => !exercised[gate]) };
}

export interface GoldenCell {
  family: string;
  pass: boolean;
  failures?: string[];
  gates?: Record<string, boolean>;
  domDrawables?: number;
  notes?: string[];
  metrics?: { inkSvg?: number; inkGpu?: number };
}

/**
 * A golden cell that paints nothing in either arm and whose layer has no drawable in the document is a layer this old
 * map does not have (a v1.0 map has no goods, markets or military). It is reported, not judged. Any cell that has
 * drawables, or a failure other than "painted nothing", stays judged.
 */
export const isEmptyGoldenCell = (cell: GoldenCell): boolean => cell.gates?.populated === false && !cell.domDrawables;

/** The ink floor of bench/golden-metrics.ts (MIN_INK_PIXELS); a unit test keeps the two equal. */
export const MIN_INK = 4;

/**
 * A cell whose layer has drawables but paints nothing in either arm (opacity 0, fully transparent, outside the camera,
 * a layer the file leaves hidden). SVG is the reference and shows nothing, and the GPU shows nothing either, so there is
 * nothing to compare: reported, not judged. It is only this when BOTH arms are below the ink floor and every failure is
 * an emptiness one; a GPU that paints what the SVG does not, or paints nothing where the SVG does, stays judged.
 */
export const paintsNothingInBothArms = (cell: GoldenCell): boolean =>
  !cell.pass &&
  (cell.failures ?? []).length > 0 &&
  (cell.failures ?? []).every(f => /^empty in (SVG|GPU) arm/.test(f)) &&
  (cell.metrics?.inkSvg ?? Number.POSITIVE_INFINITY) < MIN_INK &&
  (cell.metrics?.inkGpu ?? Number.POSITIVE_INFINITY) < MIN_INK;

/** A failure that is a metric gate (ssim, over16, over44, conservative drift). "empty in ... arm" and "census changed" are not: a layer that paints nothing, or routes differently, is never a known gap. */
export const isMetricFailure = (failure: string): boolean => /^(ssim |over16 |over44 |conservative:)/.test(failure);

/** A known gap's bound: the family may fail the listed metrics up to these values and no further. A metric with no bound has no tolerance: any failure of it gates. */
export interface KnownGap {
  family: string;
  /** Largest tolerated over16 fraction, in percent of the frame. */
  maxOver16?: number;
  /** Largest tolerated over44 fraction, in percent. */
  maxOver44?: number;
  /** Smallest tolerated ssim. */
  minSsim?: number;
}

/** Whether one metric failure string is inside the gap's bounds. A metric the gap declares no bound for is out of bounds. */
export function withinGap(failure: string, gap: KnownGap): boolean {
  if (!isMetricFailure(failure)) return false;
  const pctOf = (re: RegExp): number | null => {
    const m = re.exec(failure);
    return m ? Number(m[1]) : null;
  };
  const over16 = pctOf(/^over16 ([\d.]+)%/);
  if (over16 !== null) return gap.maxOver16 !== undefined && over16 <= gap.maxOver16;
  const over44 = pctOf(/^over44 ([\d.]+)%/);
  if (over44 !== null) return gap.maxOver44 !== undefined && over44 <= gap.maxOver44;
  const ssim = pctOf(/^ssim ([\d.]+)/);
  if (ssim !== null) return gap.minSsim !== undefined && ssim >= gap.minSsim;
  return false; // the conservative reading has no bound: the corpus golden runs over44
}

/**
 * Split judged golden cells into the ones that gate and the ones excused as known gaps: a failing cell of a listed
 * family whose every failure is a metric gate within the family's bounds. A cell with an empty-arm, census, harness
 * or gpu-path failure, or a metric beyond the bound, always gates.
 */
export function splitKnownGaps(cells: GoldenCell[], known: KnownGap[]): { gating: GoldenCell[]; excused: GoldenCell[] } {
  const gating: GoldenCell[] = [];
  const excused: GoldenCell[] = [];
  for (const cell of cells) {
    if (cell.pass) continue;
    const gap = known.find(k => k.family === cell.family);
    if (gap && (cell.failures ?? []).length > 0 && (cell.failures ?? []).every(f => withinGap(f, gap))) excused.push(cell);
    else gating.push(cell);
  }
  return { gating, excused };
}
