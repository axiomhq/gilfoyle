import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput, ToolCall } from '../harness/types.js';

/**
 * Efficiency Scorer — v2
 *
 * Beyond simple call counting, penalizes:
 * - Failed queries (syntax/contract errors)
 * - Redundant near-duplicate queries
 * - Exceeding budget
 */
export const EfficiencyScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'efficiency',
  ({ input, output }) => {
    const budget = Math.max(1, input.scenario.budgets?.maxToolCalls ?? 15);
    const toolCalls = output.trace.toolCalls;
    const actual = toolCalls.length;
    const allowNoQueries = input.scenario.scoring?.allowNoQueries === true;

    if (actual === 0) {
      return {
        score: 0,
        metadata: {
          applicable: true,
          note: 'No tool calls made',
          toolCalls: 0,
          budget,
          withinBudget: true,
        },
      };
    }

    // Budget compliance (0-1)
    const budgetScore = actual <= budget ? 1 : Math.max(0, 1 - (actual - budget) / budget);

    // Query-specific penalties
    const queryCalls = toolCalls.filter((tc: ToolCall) =>
      tc.tool === 'scripts/axiom-query' || tc.tool === 'scripts/grafana-query'
    );
    const expectsQueries = !allowNoQueries;

    if (expectsQueries && queryCalls.length === 0) {
      return {
        score: budgetScore * 0.2,
        metadata: {
          applicable: true,
          note: 'Expected investigative queries but none were issued',
          toolCalls: actual,
          budget,
          withinBudget: actual <= budget,
          queryCalls: 0,
          allowNoQueries,
          budgetScore: Math.round(budgetScore * 100),
        },
      };
    }

    // Failed query penalty (query calls only)
    const failedQueries = queryCalls.filter((tc: ToolCall) => tc.queryValid === false).length;
    const failureRate = queryCalls.length > 0 ? failedQueries / queryCalls.length : 0;
    const failurePenalty = 1 - failureRate;

    // Redundancy penalty — detect near-duplicate queries
    const queryInputs = queryCalls.map((tc: ToolCall) =>
      typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input)
    );
    const uniqueQueries = new Set(queryInputs.map(normalizeQuery));
    const redundantQueries = queryCalls.length - uniqueQueries.size;
    const redundancyPenalty = queryCalls.length > 0
      ? 1 - (redundantQueries / queryCalls.length)
      : (allowNoQueries ? 1 : 0);

    // Combined: 40% budget, 30% no failures, 30% no redundancy
    const score = budgetScore * 0.4 + failurePenalty * 0.3 + redundancyPenalty * 0.3;

    return {
      score,
      metadata: {
        applicable: true,
        toolCalls: actual,
        queryCalls: queryCalls.length,
        allowNoQueries,
        budget,
        withinBudget: actual <= budget,
        failedQueries,
        failureRate: Math.round(failureRate * 100),
        redundantQueries,
        uniqueQueries: uniqueQueries.size,
        budgetScore: Math.round(budgetScore * 100),
        failurePenalty: Math.round(failurePenalty * 100),
        redundancyPenalty: Math.round(redundancyPenalty * 100),
      },
    };
  }
);

function normalizeQuery(q: string): string {
  return q.toLowerCase().replace(/\s+/g, ' ').replace(/['"]/g, '').trim();
}
