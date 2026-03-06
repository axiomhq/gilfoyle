import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput, ToolCall } from '../harness/types.js';
import { axiomTimeBoundError, hasExplicitAxiomTimeBound } from '../toolbox/axiom-time-bounds.js';

function formatViolationInput(input: ToolCall['input']): string {
  if (typeof input === 'string') return input.slice(0, 240);
  try {
    return JSON.stringify(input).slice(0, 240);
  } catch {
    return String(input).slice(0, 240);
  }
}

export const AxiomTimeBoundsScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'axiom-time-bounds',
  async ({ output }) => {
    const axiomCalls = output.trace.toolCalls.filter((tc) => tc.tool === 'scripts/axiom-query');

    if (axiomCalls.length === 0) {
      return {
        score: 1,
        metadata: {
          applicable: false,
          note: 'No axiom-query calls made',
        },
      };
    }

    const violations = axiomCalls
      .map((call, index) => ({
        index,
        input: call.input,
      }))
      .filter(({ input }) => !hasExplicitAxiomTimeBound(input));

    return {
      score: violations.length === 0 ? 1 : 0,
      metadata: {
        applicable: true,
        totalCalls: axiomCalls.length,
        boundedCalls: axiomCalls.length - violations.length,
        unboundedCalls: violations.length,
        requirement: axiomTimeBoundError(),
        violations: violations.map(({ index, input }) => ({
          index,
          input: formatViolationInput(input),
        })),
      },
    };
  },
);
