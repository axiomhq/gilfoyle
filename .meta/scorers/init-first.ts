import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput } from '../harness/types.js';

/**
 * Init First Scorer (T01)
 *
 * Score 1 only if first tool call is `scripts/init` and no query tools
 * are called before it. The skill is explicit: "Run scripts/init immediately
 * upon activation."
 */

export const InitFirstScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'init-first',
  ({ output }) => {
    const toolCalls = output.trace.toolCalls;

    if (toolCalls.length === 0) {
      return {
        score: 0,
        metadata: { note: 'No tool calls made', violation: 'no-calls' },
      };
    }

    if (toolCalls[0].tool !== 'scripts/init') {
      return {
        score: 0,
        metadata: {
          note: `First tool call was ${toolCalls[0].tool}, not scripts/init`,
          violation: 'init-not-first',
          firstTool: toolCalls[0].tool,
        },
      };
    }

    return {
      score: 1,
      metadata: { note: 'Init called first' },
    };
  }
);
