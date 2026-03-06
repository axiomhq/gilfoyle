import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput, ToolCall } from '../harness/types.js';
import { axiomTimeBoundError, hasExplicitAxiomTimeBound } from '../toolbox/axiom-time-bounds.js';

function getInputText(tc: ToolCall): string {
  if (typeof tc.input === 'string') return tc.input;
  if (tc.input == null) return '';
  try {
    return JSON.stringify(tc.input);
  } catch {
    return String(tc.input);
  }
}

export const AxiomTimeBoundsScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'axiom-time-bounds',
  ({ output }) => {
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
        input: getInputText(call),
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
          input: input.slice(0, 240),
        })),
      },
    };
  },
);
