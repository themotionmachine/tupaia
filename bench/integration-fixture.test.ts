import { describe, expect, it } from "vitest";
import {
  attemptBudget,
  cohortMode,
  cohortSize,
  cohortVerdict,
  compareIds,
  coverage,
  distinctCount,
  strideSample
} from "./integration-fixture.ts";

describe("cohortMode / cohortSize", () => {
  it("defaults to short and sizes the cohorts", () => {
    expect(cohortMode(undefined)).toBe("short");
    expect(cohortMode("")).toBe("short");
    expect(cohortSize("short")).toBe(10);
    expect(cohortSize("full")).toBe(50);
    expect(attemptBudget(50)).toBe(150);
  });

  it("accepts full and rejects anything else", () => {
    expect(cohortMode("full")).toBe("full");
    expect(() => cohortMode("long")).toThrow(/INTEGRATION_COHORT/);
  });
});

describe("compareIds", () => {
  it("orders numeric suffixes numerically", () => {
    const ids = ["route10", "route9", "route100", "route2"].sort(compareIds);
    expect(ids).toEqual(["route2", "route9", "route10", "route100"]);
  });

  it("orders by prefix before number and is total on equal strings", () => {
    expect(compareIds("label3", "marker1")).toBeLessThan(0);
    expect(compareIds("marker1", "marker1")).toBe(0);
  });
});

describe("strideSample", () => {
  it("returns distinct, evenly spread picks in input order", () => {
    const items = Array.from({ length: 100 }, (_, i) => "m" + i);
    const picks = strideSample(items, 50);
    expect(picks).toHaveLength(50);
    expect(distinctCount(picks)).toBe(50);
    expect(picks[0]).toBe("m0");
    expect(picks[49]).toBe("m98");
  });

  it("returns everything when n exceeds the input and nothing for n <= 0", () => {
    expect(strideSample([1, 2, 3], 10)).toEqual([1, 2, 3]);
    expect(strideSample([1, 2, 3], 0)).toEqual([]);
    expect(strideSample([], 5)).toEqual([]);
  });
});

describe("coverage and verdicts", () => {
  it("reports fixture coverage separately from natural coverage", () => {
    const row = coverage("route", 3, 900, 49);
    expect(row.meets).toBe(false);
    expect(row.natural).toBe(3);
    expect(coverage("marker", 0, 373, 50).meets).toBe(true);
  });

  it("never passes an untested or undercovered cohort", () => {
    expect(cohortVerdict({ eligible: 0, required: 50, failures: 0 })).toBe("UNTESTED");
    expect(cohortVerdict({ eligible: 8, required: 10, failures: 0 })).toBe("UNDERCOVERED");
    expect(cohortVerdict({ eligible: 10, required: 10, failures: 0 })).toBe("PASS");
    expect(cohortVerdict({ eligible: 10, required: 10, failures: 1 })).toBe("FAIL");
    expect(cohortVerdict({ eligible: 0, required: 10, failures: 2 })).toBe("FAIL");
  });
});
