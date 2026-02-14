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
    const required = input.scenario.scoring?.requireMustNotMention ?? mustNotMention.length > 0;

    if (!required) {
      return {
        score: 1,
        metadata: { applicable: false, note: 'Must-not-mention not required for this scenario' },
      };
    }

    if (mustNotMention.length === 0) {
      return {
        score: 1,
        metadata: { applicable: false, note: 'No mustNotMention keywords defined, skipping check' },
      };
    }

    // Evaluate only the root-cause context, not the full transcript.
    const analysisText = extractRootCauseContext(output);

    const violations: string[] = [];
    const ignoredNegated: string[] = [];
    for (const keyword of mustNotMention) {
      const res = findKeywordViolations(analysisText, keyword);
      if (res.hasViolation) {
        violations.push(keyword);
      } else if (res.hadOnlyNegatedMatches) {
        ignoredNegated.push(keyword);
      }
    }

    if (violations.length > 0) {
      return {
        score: 0,
        metadata: {
          applicable: true,
          note: `Agent mentioned forbidden keywords: ${violations.join(', ')}`,
          violations,
          ignoredNegated,
          mustNotMention,
          analyzedTextSample: analysisText.slice(0, 500),
        },
      };
    }

    return {
      score: 1,
      metadata: {
        applicable: true,
        note: 'No forbidden keywords mentioned',
        ignoredNegated,
        mustNotMention,
        analyzedTextSample: analysisText.slice(0, 500),
      },
    };
  }
);

function extractRootCauseContext(output: EvalOutput): string {
  const rootCause = output.rootCause?.trim() ?? '';
  const fullText = output.trace.finalText ?? '';

  const rootHeading = fullText.match(/(?:^|\n)#{0,6}\s*root\s*cause[^\n]*\n([\s\S]*)/i);
  let selected = rootCause || fullText;

  if (rootHeading?.[1]) {
    const after = rootHeading[1];
    const nextHeadingIdx = after.search(/\n#{1,6}\s+/);
    selected = nextHeadingIdx >= 0 ? after.slice(0, nextHeadingIdx) : after;
  }

  // Remove markdown/code noise before keyword checks.
  return selected
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/^\s*>\s.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findKeywordViolations(text: string, keyword: string): { hasViolation: boolean; hadOnlyNegatedMatches: boolean } {
  const regex = toKeywordRegex(keyword);
  let hasViolation = false;
  let matchCount = 0;
  let negatedCount = 0;
  for (const match of text.matchAll(regex)) {
    matchCount++;
    const idx = match.index ?? -1;
    if (idx < 0) {
      continue;
    }
    const prefix = text.slice(Math.max(0, idx - 48), idx).toLowerCase();
    if (isNegatedContext(prefix)) {
      negatedCount++;
      continue;
    }
    hasViolation = true;
    break;
  }

  return {
    hasViolation,
    hadOnlyNegatedMatches: matchCount > 0 && negatedCount === matchCount,
  };
}

function toKeywordRegex(keyword: string): RegExp {
  const escaped = escapeRegex(keyword.trim());
  if (/^[A-Za-z0-9_]+$/.test(keyword)) {
    return new RegExp(`\\b${escaped}\\b`, 'gi');
  }
  return new RegExp(`(^|\\W)${escaped}(?=$|\\W)`, 'gi');
}

function isNegatedContext(prefix: string): boolean {
  return /(?:not|isn'?t|wasn'?t|ruled out|exclude[ds]?|instead of|rather than|not due to|not caused by)\s*$/.test(prefix);
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
