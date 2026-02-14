import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput } from '../harness/types.js';
import { classifyQueryFailure, isQueryTool } from './query-error-classification.js';

/**
 * Executor Coverage Scorer
 *
 * Measures how often parser-valid queries fail because the fixture executor
 * lacks feature support (e.g. unsupported APL stages).
 */
export const ExecutorCoverageScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'executor-coverage',
  ({ input, output }) => {
    const allowNoQueries = input.scenario.scoring?.allowNoQueries === true;
    const queryCalls = output.trace.toolCalls.filter(isQueryTool);

    if (queryCalls.length === 0) {
      return {
        score: allowNoQueries ? 1 : 0,
        metadata: {
          applicable: !allowNoQueries,
          note: allowNoQueries ? 'No queries expected for this scenario' : 'No query calls made',
          allowNoQueries,
        },
      };
    }

    const failures = queryCalls.map((tc) => classifyQueryFailure(tc)).filter((f) => f.hasFailure);
    const syntaxFailures = failures.filter((f) => f.kind === 'syntax').length;
    const unsupportedFailures = failures.filter((f) => f.kind === 'executor_unsupported').length;
    const parserValidCalls = queryCalls.length - syntaxFailures;

    const score = parserValidCalls <= 0
      ? 0
      : Math.max(0, (parserValidCalls - unsupportedFailures) / parserValidCalls);

    return {
      score,
      metadata: {
        applicable: true,
        queryCalls: queryCalls.length,
        parserValidCalls,
        syntaxFailures,
        unsupportedFailures,
        nonCoverageFailures: failures.length - syntaxFailures - unsupportedFailures,
      },
    };
  },
);
