import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput, ToolCall, ToolName } from '../harness/types.js';

/**
 * Init First Scorer (T01)
 *
 * Score 1 only if first tool call is `scripts/init` and no query tools
 * are called before it. The skill is explicit: "Run scripts/init immediately
 * upon activation."
 */

const QUERY_TOOLS: ToolName[] = ['scripts/axiom-query', 'scripts/grafana-query'];

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

    const firstCall = toolCalls[0];

    // Check if first call is scripts/init
    if (firstCall.tool !== 'scripts/init') {
      return {
        score: 0,
        metadata: {
          note: `First tool call was ${firstCall.tool}, not scripts/init`,
          violation: 'init-not-first',
          firstTool: firstCall.tool,
        },
      };
    }

    // Check that no query tools were called before init (should be impossible if init is first, but check anyway)
    const initIndex = toolCalls.findIndex((tc: ToolCall) => tc.tool === 'scripts/init');
    const queryBeforeInit = toolCalls.slice(0, initIndex).some((tc: ToolCall) =>
      QUERY_TOOLS.includes(tc.tool)
    );

    if (queryBeforeInit) {
      return {
        score: 0,
        metadata: {
          note: 'Query tools called before init',
          violation: 'query-before-init',
        },
      };
    }

    return {
      score: 1,
      metadata: { note: 'Init called first, no queries before init' },
    };
  }
);
