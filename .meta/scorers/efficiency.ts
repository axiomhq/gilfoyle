/**
 * Efficiency Scorer
 *
 * Measures tool call count and token usage against scenario budgets.
 * Rewards efficient investigations that don't waste resources.
 */

import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput } from '../harness/types.js';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export const EfficiencyScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'efficiency',
  ({ input, output }) => {
    const budgets = input.scenario.budgets ?? {};
    const trace = output.trace;

    const toolCalls = trace.toolCalls.length;
    const maxToolCalls = budgets.maxToolCalls ?? 15;

    const totalTokens = trace.usage?.totalTokens ?? 0;
    const maxTokens = budgets.maxTotalTokens ?? 10000;

    const toolOverage = toolCalls - maxToolCalls;
    const toolScore = toolOverage <= 0 ? 1 : clamp01(1 - toolOverage / maxToolCalls);

    let tokenScore = 1;
    if (totalTokens > 0) {
      const tokenOverage = totalTokens - maxTokens;
      tokenScore = tokenOverage <= 0 ? 1 : clamp01(1 - tokenOverage / maxTokens);
    }

    const hasTokenData = totalTokens > 0;
    const score = hasTokenData ? 0.7 * toolScore + 0.3 * tokenScore : toolScore;

    return {
      score,
      metadata: {
        toolCalls,
        maxToolCalls,
        toolScore,
        totalTokens: totalTokens || 'N/A',
        maxTokens,
        tokenScore: hasTokenData ? tokenScore : 'N/A',
        elapsedMs: trace.elapsedMs,
      },
    };
  }
);
