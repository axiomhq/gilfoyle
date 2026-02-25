import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput } from '../harness/types.js';
import { analyzeQueryHealth } from './query-health.js';

/**
 * Query Repair Scorer
 *
 * Measures whether the agent recovers after making invalid queries.
 * A failure is considered repaired when a later query to the same tool
 * succeeds (no classified failure).
 */
export const QueryRepairScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'query-repair',
  ({ input, output }) => {
    const allowNoQueries = input.scenario.scoring?.allowNoQueries === true;
    const queryHealth = analyzeQueryHealth(output.trace.toolCalls);
    const queryCalls = queryHealth.queryCalls;

    if (queryCalls.length === 0) {
      return {
        score: allowNoQueries ? 1 : 0,
        metadata: {
          applicable: true,
          note: allowNoQueries ? 'No query calls expected for this scenario' : 'No query calls made',
          allowNoQueries,
          queryCalls: 0,
        },
      };
    }

    const failures = queryHealth.failures;
    if (failures.length === 0) {
      return {
        score: 1,
        metadata: {
          applicable: true,
          note: 'No query failures to repair',
          queryCalls: queryCalls.length,
          failures: 0,
          repaired: 0,
        },
      };
    }

    const score = queryHealth.repairScore;

    return {
      score,
      metadata: {
        applicable: true,
        queryCalls: queryCalls.length,
        failures: failures.length,
        repaired: queryHealth.repaired,
        unrepairedCount: queryHealth.unrepairedCount,
        unrepaired: queryHealth.unrepaired,
      },
    };
  },
);
