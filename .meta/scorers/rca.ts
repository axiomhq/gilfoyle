/**
 * RCA Accuracy Scorer
 *
 * Checks if the agent's final output mentions the expected root cause keywords
 * and avoids forbidden keywords. Deterministic, no LLM judge needed.
 */

import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput } from '../harness/types.js';

export const RCAAccuracyScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'rca-accuracy',
  ({ input, output }) => {
    const { expected } = input.scenario;
    const text = output.rootCause.toLowerCase();

    const mustMention = expected.rootCauseMustMention;
    const mentionedCount = mustMention.filter((kw: string) =>
      text.includes(kw.toLowerCase())
    ).length;

    const mustNotMention = expected.rootCauseMustNotMention ?? [];
    const forbiddenFound = mustNotMention.filter((kw: string) =>
      text.includes(kw.toLowerCase())
    );

    const mentionScore = mustMention.length > 0 ? mentionedCount / mustMention.length : 1;
    const score = forbiddenFound.length > 0 ? 0 : mentionScore;

    return {
      score,
      metadata: {
        requiredKeywords: mustMention,
        foundKeywords: mustMention.filter((kw: string) => text.includes(kw.toLowerCase())),
        missingKeywords: mustMention.filter((kw: string) => !text.includes(kw.toLowerCase())),
        forbiddenFound,
      },
    };
  }
);
