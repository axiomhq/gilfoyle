import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput } from '../harness/types.js';

/**
 * Hypothesis Discipline Scorer (T06)
 *
 * Evaluates whether the agent follows proper hypothesis-driven investigation:
 * - 40%: explicit hypothesis statement
 * - 40%: falsification evidence (mentions disproof, compares alternatives)
 * - 20%: explicit transitions when changing hypothesis
 */

const HYPOTHESIS_PATTERNS = [
  /hypothesis[:\s]/i,
  /\bi\s+(?:suspect|believe|think)\s+(?:the\s+)?(?:root\s+)?cause/i,
  /\bmy\s+(?:initial\s+)?(?:theory|hypothesis)/i,
  /\blikely\s+(?:root\s+)?cause/i,
  /\btesting\s+(?:the\s+)?hypothesis/i,
  /\binitial\s+hypothesis/i,
];

const FALSIFICATION_PATTERNS = [
  /\brule[ds]?\s+out\b/i,
  /\bdisprove[ds]?\b/i,
  /\bfalsif(?:y|ied|ies|ication)\b/i,
  /\bnot\s+the\s+(?:root\s+)?cause\b/i,
  /\bexclude[ds]?\b/i,
  /\bcontradicts?\b/i,
  /\binconsistent\s+with\b/i,
  /\bdoesn'?t\s+explain\b/i,
  /\balternative\s+(?:hypothesis|explanation)/i,
  /\bcompare[ds]?\s+(?:with|to|against)\b/i,
  /\bcohort\s+comparison\b/i,
  /\bcontrol\s+group\b/i,
  /\bif\s+(?:this|it)\s+were\s+(?:the\s+)?cause/i,
  /\bwould\s+(?:also\s+)?expect\s+to\s+see\b/i,
];

const TRANSITION_PATTERNS = [
  /\bdisproved\b/i,
  /\bruled\s+out\b/i,
  /\bnot\s+the\s+cause\b/i,
  /\bmoving\s+on\s+to\b/i,
  /\bnew\s+hypothesis\b/i,
  /\brevising\s+(?:my\s+)?hypothesis\b/i,
  /\bactually[,\s]+(?:the|it)\b/i,
  /\binstead[,\s]+(?:the|it)\b/i,
  /\bhowever[,\s]+(?:the\s+)?(?:data|logs?|evidence)\b/i,
];

export const HypothesisDisciplineScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'hypothesis-discipline',
  ({ output }) => {
    const text = output.trace.finalText;

    // Check for explicit hypothesis statement (40%)
    const hasHypothesis = HYPOTHESIS_PATTERNS.some(p => p.test(text));
    const hypothesisScore = hasHypothesis ? 1 : 0;

    // Check for falsification evidence (40%)
    const falsificationMatches = FALSIFICATION_PATTERNS.filter(p => p.test(text));
    // Score based on how many falsification patterns are present
    const falsificationScore = Math.min(1, falsificationMatches.length / 2);

    // Check for explicit transitions (20%)
    const hasTransition = TRANSITION_PATTERNS.some(p => p.test(text));
    const transitionScore = hasTransition ? 1 : 0;

    // Combined score
    const score = hypothesisScore * 0.4 + falsificationScore * 0.4 + transitionScore * 0.2;

    return {
      score,
      metadata: {
        hasExplicitHypothesis: hasHypothesis,
        falsificationMatches: falsificationMatches.length,
        hasExplicitTransition: hasTransition,
        hypothesisScore,
        falsificationScore,
        transitionScore,
        // Sample of what was found
        sampleMatches: {
          hypothesis: hasHypothesis
            ? findFirstMatch(text, HYPOTHESIS_PATTERNS)
            : null,
          falsification:
            falsificationMatches.length > 0
              ? findFirstMatch(text, FALSIFICATION_PATTERNS)
              : null,
          transition: hasTransition
            ? findFirstMatch(text, TRANSITION_PATTERNS)
            : null,
        },
      },
    };
  }
);

function findFirstMatch(text: string, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const match = text.match(p);
    if (match) {
      // Return surrounding context (up to 50 chars before and after)
      const start = Math.max(0, match.index! - 30);
      const end = Math.min(text.length, match.index! + match[0].length + 30);
      return `...${text.slice(start, end)}...`;
    }
  }
  return null;
}
