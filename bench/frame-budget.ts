export const budgetToleranceFraction = 0.1;
export function frameBudgets(values: number[]) {
  return Object.fromEntries(
    [16.7, 8.3].map(budgetMs => [
      String(budgetMs),
      {
        budgetMs,
        toleranceFraction: budgetToleranceFraction,
        rawIntervalsOverBudget: values.filter(ms => ms > budgetMs).length,
        framesOverBudget: values.filter(ms => ms > budgetMs * (1 + budgetToleranceFraction)).length,
        missedBudgets: values.reduce(
          (sum, ms) => sum + Math.max(0, Math.ceil(ms / budgetMs - budgetToleranceFraction) - 1),
          0
        )
      }
    ])
  );
}
