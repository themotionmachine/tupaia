import { test } from "node:test";
import assert from "node:assert/strict";
import { frameBudgets } from "./frame-budget.ts";
test("counts near-double cadence as one missed frame rather than flooring away the miss", () => {
  assert.equal(frameBudgets([33.3])["16.7"].missedBudgets, 1);
  assert.equal(frameBudgets([16.65])["8.3"].missedBudgets, 1);
});
test("tolerates small cadence jitter while retaining raw threshold counts", () => {
  const value = frameBudgets([8.3, 8.5, 8.7])["8.3"];
  assert.equal(value.rawIntervalsOverBudget, 2);
  assert.equal(value.framesOverBudget, 0);
  assert.equal(value.missedBudgets, 0);
});
