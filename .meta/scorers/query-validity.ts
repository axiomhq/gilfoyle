import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput, ToolCall } from '../harness/types.js';

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
    const queryCalls = toolCalls.filter((tc: ToolCall) =>
      tc.tool === 'scripts/axiom-query' || tc.tool === 'scripts/grafana-query'
    );

    if (queryCalls.length === 0) {
      return {
        score: 0,
        metadata: { note: 'No query tool calls made', totalCalls: toolCalls.length },
      };
    }

    // Score 1: query syntax validity
    const validCalls = queryCalls.filter((tc: ToolCall) => tc.queryValid !== false);
    const invalidCalls = queryCalls.filter((tc: ToolCall) => tc.queryValid === false);
    const syntaxScore = validCalls.length / queryCalls.length;

    // Score 2: required queries check
    const requiredQueries = input.scenario.expected.requiredQueries ?? [];
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

    // Combined score: 60% syntax validity, 40% required queries
    const score = syntaxScore * 0.6 + requiredScore * 0.4;

    return {
      score,
      metadata: {
        syntaxScore,
        requiredScore,
        totalQueryCalls: queryCalls.length,
        validCalls: validCalls.length,
        invalidCalls: invalidCalls.length,
        invalidDetails: invalidCalls.map((tc: ToolCall) => ({
          tool: tc.tool,
          errors: tc.queryErrors,
          input: typeof tc.input === 'string' ? tc.input.slice(0, 200) : JSON.stringify(tc.input).slice(0, 200),
        })),
        requiredResults,
      },
    };
  }
);
