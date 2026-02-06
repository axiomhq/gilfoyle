import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput } from '../harness/types.js';

/**
 * Must Not Mention Scorer (T02)
 *
 * Score 0 if any forbidden keyword from `rootCauseMustNotMention` appears
 * in the agent's conclusion. This prevents gaming — an agent that says
 * "DDoS" on a redis-oom scenario is wrong even if it mentions redis.
 */
export const MustNotMentionScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'must-not-mention',
  ({ input, output }) => {
    const mustNotMention = input.scenario.expected.rootCauseMustNotMention ?? [];

    if (mustNotMention.length === 0) {
      return {
        score: 1,
        metadata: { note: 'No mustNotMention keywords defined, skipping check' },
      };
    }

    const conclusionLower = output.rootCause.toLowerCase();
    const finalTextLower = output.trace.finalText.toLowerCase();
    const combinedText = `${conclusionLower} ${finalTextLower}`;

    const violations: string[] = [];
    for (const keyword of mustNotMention) {
      if (combinedText.includes(keyword.toLowerCase())) {
        violations.push(keyword);
      }
    }

    if (violations.length > 0) {
      return {
        score: 0,
        metadata: {
          note: `Agent mentioned forbidden keywords: ${violations.join(', ')}`,
          violations,
          mustNotMention,
        },
      };
    }

    return {
      score: 1,
      metadata: {
        note: 'No forbidden keywords mentioned',
        mustNotMention,
      },
    };
  }
);
