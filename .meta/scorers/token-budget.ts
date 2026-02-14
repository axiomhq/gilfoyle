import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput } from '../harness/types.js';

/**
 * Token Budget Scorer
 *
 * Scores total token usage against scenario.maxTotalTokens.
 * Keeps spend visible in the scorecard instead of only in debug logs.
 */
export const TokenBudgetScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'token-budget',
  ({ input, output }) => {
    const budgetRaw = input.scenario.budgets?.maxTotalTokens;
    if (!Number.isFinite(budgetRaw) || (budgetRaw ?? 0) <= 0) {
      return {
        score: 1,
        metadata: {
          applicable: false,
          note: 'No token budget defined for this scenario',
        },
      };
    }
    const budget = Math.round(budgetRaw ?? 0);

    const inputTokens = output.trace.usage?.inputTokens ?? 0;
    const outputTokens = output.trace.usage?.outputTokens ?? 0;
    const totalTokens = inputTokens + outputTokens;

    if (totalTokens <= 0) {
      return {
        score: 1,
        metadata: {
          applicable: false,
          note: 'Token usage unavailable from harness/provider',
          budget,
          inputTokens,
          outputTokens,
          totalTokens,
        },
      };
    }

    const hardLimit = Math.max(budget + 1, Math.round(budget * 2));
    const score = linearScore(totalTokens, budget, hardLimit);

    return {
      score,
      metadata: {
        applicable: true,
        budget,
        hardLimit,
        inputTokens,
        outputTokens,
        totalTokens,
        withinBudget: totalTokens <= budget,
        utilizationPct: Math.round((totalTokens / budget) * 100),
      },
    };
  },
);

function linearScore(actual: number, softLimit: number, hardLimit: number): number {
  if (actual <= softLimit) return 1;
  const window = Math.max(1, hardLimit - softLimit);
  return Math.max(0, 1 - (actual - softLimit) / window);
}
