// Pure node-side helpers for bench/renderer-integration.ts: cohort sizing (INTEGRATION_COHORT), deterministic fixture
// selection and coverage/verdict arithmetic. Nothing here touches the browser; page-side code must stay self-contained
// (page.evaluate serializes functions), so the page receives only ids chosen by these helpers.

export const FIXTURE_KINDS = ["burg", "label", "route", "marker"] as const;
export type FixtureKind = (typeof FIXTURE_KINDS)[number];

// Minimum distinct canonical objects per kind in the labeled fixture (the acceptance floor, both modes).
export const FIXTURE_MIN = 50;

export type CohortMode = "short" | "full";

// INTEGRATION_COHORT: "short" (default, quick iteration) or "full" (the final run). Anything else is an error.
export function cohortMode(value: string | undefined): CohortMode {
  const mode = (value ?? "").trim() || "short";
  if (mode === "short" || mode === "full") return mode;
  throw new Error("INTEGRATION_COHORT must be short or full, got " + JSON.stringify(value));
}

// Stale-click cohort size per kind: eligible clicks required for a cohort to count as tested.
export function cohortSize(mode: CohortMode): number {
  return mode === "full" ? 50 : 10;
}

// Attempts budget for a cohort: enough headroom to reach its eligible size once some clicks are ineligible.
export function attemptBudget(size: number): number {
  return size * 3;
}

// Numeric-aware order over ids with an optional alphabetic prefix ("route12" after "route9"); stable and total.
export function compareIds(a: string, b: string): number {
  const split = (id: string) => {
    const m = /^(.*?)(\d*)$/.exec(id);
    return { prefix: m ? m[1] : id, num: m && m[2] ? Number(m[2]) : -1 };
  };
  const x = split(a),
    y = split(b);
  if (x.prefix !== y.prefix) return x.prefix < y.prefix ? -1 : 1;
  if (x.num !== y.num) return x.num - y.num;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Deterministic, evenly spread, distinct picks of up to n items (order of the input is preserved).
export function strideSample<T>(items: readonly T[], n: number): T[] {
  if (n <= 0 || items.length === 0) return [];
  if (n >= items.length) return items.slice();
  const out: T[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    const index = Math.floor((i * items.length) / n);
    if (!seen.has(index)) {
      seen.add(index);
      out.push(items[index]);
    }
  }
  return out;
}

export function distinctCount(values: readonly string[]): number {
  return new Set(values).size;
}

export interface KindCoverage {
  kind: FixtureKind;
  natural: number; // distinct objects clickable at the camera as it stood, without aiming
  census: number; // distinct objects of the kind in the world
  fixture: number; // distinct objects in the fixture with a verified click point at the camera they were aimed at
  required: number;
  meets: boolean; // fixture >= required (natural coverage never substitutes for the fixture)
}

export function coverage(kind: FixtureKind, natural: number, census: number, fixture: number, required = FIXTURE_MIN): KindCoverage {
  return { kind, natural, census, fixture, required, meets: fixture >= required };
}

export type CohortVerdict = "PASS" | "FAIL" | "UNTESTED" | "UNDERCOVERED";

// UNTESTED (no eligible sample) and UNDERCOVERED never count as PASS. Any failure wins over coverage.
export function cohortVerdict(input: { eligible: number; required: number; failures: number }): CohortVerdict {
  if (input.failures > 0) return "FAIL";
  if (input.eligible === 0) return "UNTESTED";
  if (input.eligible < input.required) return "UNDERCOVERED";
  return "PASS";
}
