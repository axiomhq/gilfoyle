import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput } from '../harness/types.js';
import { analyzeQueryHealth } from './query-health.js';

/**
 * Efficiency Scorer — v3
 *
 * Uses one shared query-health model across scorers and keeps
 * the weighted objective simple:
 * - 35% tool-call budget compliance
 * - 35% query validity
 * - 15% repair after failures
 * - 15% query non-redundancy
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

    const queryHealth = analyzeQueryHealth(toolCalls);
    const queryCalls = queryHealth.queryCalls;
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

    if (queryCalls.length === 0) {
      return {
        score: budgetScore,
        metadata: {
          applicable: true,
          note: 'No query calls expected for this scenario',
          toolCalls: actual,
          queryCalls: 0,
          allowNoQueries,
          budget,
          withinBudget: actual <= budget,
          budgetScore: Math.round(budgetScore * 100),
        },
      };
    }

    const validityScore = queryHealth.validityScore;
    const repairScore = queryHealth.repairScore;
    const redundancyPenalty = queryHealth.redundancyPenalty;
    const failedQueries = queryHealth.invalidCalls;
    const failureRate = queryHealth.failureRate;
    const failurePenalty = 1 - failureRate;

    const score = budgetScore * 0.35
      + validityScore * 0.35
      + repairScore * 0.15
      + redundancyPenalty * 0.15;

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
        repairedFailures: queryHealth.repaired,
        unrepairedFailures: queryHealth.unrepairedCount,
        redundantQueries: queryHealth.redundantQueries,
        uniqueQueries: queryHealth.uniqueQueries,
        budgetScore: Math.round(budgetScore * 100),
        validityScore: Math.round(validityScore * 100),
        repairScore: Math.round(repairScore * 100),
        failurePenalty: Math.round(failurePenalty * 100),
        redundancyPenalty: Math.round(redundancyPenalty * 100),
        formula: {
          budget: 0.35,
          validity: 0.35,
          repair: 0.15,
          redundancy: 0.15,
        },
      },
    };
  }
);
