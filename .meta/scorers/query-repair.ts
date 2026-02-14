import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput } from '../harness/types.js';
import { classifyQueryFailure, isQueryTool } from './query-error-classification.js';

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
    const queryCalls = output.trace.toolCalls.filter(isQueryTool);

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

    const classified = queryCalls.map((call, index) => ({
      call,
      index,
      failure: classifyQueryFailure(call),
    }));

    const failures = classified.filter((entry) => entry.failure.hasFailure);
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

    let repaired = 0;
    const unrepaired: Array<{ index: number; tool: string; class: string }> = [];

    for (const failed of failures) {
      const hasRecovery = classified
        .slice(failed.index + 1)
        .some((later) => later.call.tool === failed.call.tool && !later.failure.hasFailure);

      if (hasRecovery) {
        repaired += 1;
      } else {
        unrepaired.push({
          index: failed.index,
          tool: failed.call.tool,
          class: failed.failure.kind,
        });
      }
    }

    const score = repaired / failures.length;

    return {
      score,
      metadata: {
        applicable: true,
        queryCalls: queryCalls.length,
        failures: failures.length,
        repaired,
        unrepairedCount: unrepaired.length,
        unrepaired,
      },
    };
  },
);
