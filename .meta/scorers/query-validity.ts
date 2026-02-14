import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput, ToolCall } from '../harness/types.js';
import { classifyQueryFailure, isQueryTool, type QueryFailureKind } from './query-error-classification.js';

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
    const queryCalls = toolCalls.filter((tc: ToolCall) => isQueryTool(tc));
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

    const failures = queryCalls.map((tc) => {
      const classified = classifyQueryFailure(tc);
      return { tc, classified };
    });
    const validCalls = failures.filter((f) => !f.classified.hasFailure);
    const invalidCalls = failures.filter((f) => f.classified.hasFailure);
    const validityScore = validCalls.length / queryCalls.length;
    const syntaxFailures = invalidCalls.filter((f) => f.classified.kind === 'syntax').length;
    const syntaxScore = 1 - (syntaxFailures / queryCalls.length);
    const failureClassCounts = countFailureClasses(invalidCalls.map((f) => f.classified.kind));

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
        validCalls: validCalls.length,
        invalidCalls: invalidCalls.length,
        failureClassCounts,
        invalidDetails: invalidCalls.map(({ tc, classified }) => ({
          tool: tc.tool,
          class: classified.kind,
          message: classified.message.slice(0, 300),
          errors: tc.queryErrors,
          input: typeof tc.input === 'string' ? tc.input.slice(0, 200) : JSON.stringify(tc.input).slice(0, 200),
        })),
        requiredResults,
      },
    };
  }
);

function countFailureClasses(classes: QueryFailureKind[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const cls of classes) {
    out[cls] = (out[cls] ?? 0) + 1;
  }
  return out;
}
