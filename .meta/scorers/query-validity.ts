import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput, ToolCall } from '../harness/types.js';
import { analyzeQueryHealth } from './query-health.js';

/**
 * Query Validity Scorer
 *
 * Measures what % of the agent's tool calls executed without
 * syntax or contract errors. This is a hard gate — if the agent
 * can't write valid APL/PromQL, nothing else matters.
 *
 * Also checks requiredQueries: did the agent query the right
 * datasets/metrics (not hallucinated ones)?
 */
export const QueryValidityScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'query-validity',
  ({ input, output }) => {
    const toolCalls = output.trace.toolCalls;
    const queryHealth = analyzeQueryHealth(toolCalls);
    const queryCalls = queryHealth.queryCalls;
    const allowNoQueries = input.scenario.scoring?.allowNoQueries === true;
    const requiredQueries = input.scenario.expected.requiredQueries ?? [];

    if (queryCalls.length === 0) {
      return {
        score: allowNoQueries ? 1 : 0,
        metadata: {
          applicable: true,
          note: allowNoQueries ? 'No query calls expected for this scenario' : 'No query tool calls made',
          totalCalls: toolCalls.length,
          allowNoQueries,
          requiredQueryCount: requiredQueries.length,
        },
      };
    }

    const validityScore = queryHealth.validityScore;
    const syntaxScore = queryHealth.syntaxScore;

    // Score 2: required queries check
    let requiredScore = 1;
    const requiredResults: { description: string; matched: boolean }[] = [];

    if (requiredQueries.length > 0) {
      for (const req of requiredQueries) {
        let matched = false;
        try {
          const regex = new RegExp(req.mustMatch, 'i');
          matched = toolCalls.some((tc: ToolCall) => {
            if (tc.tool !== req.tool) return false;
            const inputStr = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input);
            return regex.test(inputStr);
          });
        } catch {}
        requiredResults.push({ description: req.description, matched });
      }
      requiredScore = requiredResults.filter(r => r.matched).length / requiredQueries.length;
    }

    // Combined score: 60% execution validity, 40% required query coverage
    const score = validityScore * 0.6 + requiredScore * 0.4;

    return {
      score,
      metadata: {
        applicable: true,
        validityScore,
        syntaxScore,
        requiredScore,
        totalQueryCalls: queryCalls.length,
        validCalls: queryHealth.validCalls,
        invalidCalls: queryHealth.invalidCalls,
        failureClassCounts: queryHealth.failureClassCounts,
        invalidDetails: queryHealth.failures.map(({ call, failure, inputText }) => ({
          tool: call.tool,
          class: failure.kind,
          message: failure.message.slice(0, 300),
          errors: call.queryErrors,
          input: inputText.slice(0, 200),
        })),
        requiredResults,
      },
    };
  }
);
