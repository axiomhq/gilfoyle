import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput } from '../harness/types.js';
import { assessRunHealth } from './run-health.js';

/**
 * Run Validity Scorer
 *
 * Hard gate for harness/model execution health. A run that never executed
 * the model or only produced harness failures should not be interpreted as
 * agent behavior.
 */
export const RunValidityScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'run-validity',
  ({ output }) => {
    const health = assessRunHealth(output);
    const score = health.valid ? 1 : 0;

    return {
      score,
      metadata: {
        applicable: true,
        valid: health.valid,
        reasons: health.reasons,
        toolCalls: health.toolCalls,
        inputTokens: health.inputTokens,
        outputTokens: health.outputTokens,
      },
    };
  },
);
