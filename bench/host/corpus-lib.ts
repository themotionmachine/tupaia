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
  /** Families whose golden is a known GPU fidelity gap (on the parity fixture too, or, with `maps`, only on those corpus maps). Their metric failures are reported, not gated. */
  goldenKnownGaps: Array<{ family: string; reason: string; maps?: string[] }>;
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
}

/**
 * A golden cell that paints nothing in either arm and whose layer has no drawable in the document is a layer this old
 * map does not have (a v1.0 map has no goods, markets or military). It is reported, not judged. Any cell that has
 * drawables, or a failure other than "painted nothing", stays judged.
 */
export const isEmptyGoldenCell = (cell: GoldenCell): boolean => cell.gates?.populated === false && !cell.domDrawables;

/** A failure that is a metric gate (ssim, over16, over44, coverage), not a harness problem or a renderer that is not on the gpu path. */
export const isMetricFailure = (failure: string): boolean => !/^(GPU not active|GPU frame did not|harness:|toggle )/.test(failure);

/**
 * Split judged golden cells into the ones that gate and the ones excused as known gaps: a failing cell of a listed
 * family whose every failure is a metric gate. A cell with a harness or gpu-path failure always gates.
 */
export function splitKnownGaps(cells: GoldenCell[], known: string[]): { gating: GoldenCell[]; excused: GoldenCell[] } {
  const gating: GoldenCell[] = [];
  const excused: GoldenCell[] = [];
  for (const cell of cells) {
    if (cell.pass) continue;
    if (known.includes(cell.family) && (cell.failures ?? []).length > 0 && (cell.failures ?? []).every(isMetricFailure)) excused.push(cell);
    else gating.push(cell);
  }
  return { gating, excused };
}
