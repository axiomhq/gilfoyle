import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput } from '../harness/types.js';

/**
 * Counterfactual Rejection Scorer
 *
 * Detects whether the agent actually attributes the incident to forbidden
 * counterfactual causes. Mentioning and ruling them out is fine; attributing
 * them as the cause is not.
 */
export const CounterfactualRejectionScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'counterfactual-rejection',
  ({ input, output }) => {
    const forbidden = input.scenario.expected.rootCauseMustNotMention ?? [];
    const required = input.scenario.scoring?.requireMustNotMention ?? forbidden.length > 0;

    if (!required) {
      return {
        score: 1,
        metadata: { applicable: false, note: 'Counterfactual rejection not required for this scenario' },
      };
    }

    if (forbidden.length === 0) {
      return {
        score: 1,
        metadata: { applicable: false, note: 'No forbidden counterfactuals defined' },
      };
    }

    const text = extractConclusionContext(output);
    const attributed: string[] = [];
    const mentioned: string[] = [];
    const negated: string[] = [];

    for (const term of forbidden) {
      const status = classifyMention(text, term);
      if (status === 'attributed') attributed.push(term);
      if (status === 'mentioned') mentioned.push(term);
      if (status === 'negated') negated.push(term);
    }

    if (attributed.length > 0) {
      return {
        score: 0,
        metadata: {
          applicable: true,
          note: `Attributed forbidden cause(s): ${attributed.join(', ')}`,
          attributed,
          mentioned,
          negated,
        },
      };
    }

    if (mentioned.length > 0) {
      return {
        score: 0.6,
        metadata: {
          applicable: true,
          note: `Forbidden terms mentioned without clear attribution: ${mentioned.join(', ')}`,
          attributed,
          mentioned,
          negated,
        },
      };
    }

    return {
      score: 1,
      metadata: {
        applicable: true,
        note: 'Counterfactual causes were rejected',
        attributed,
        mentioned,
        negated,
      },
    };
  }
);

type MentionClass = 'none' | 'negated' | 'mentioned' | 'attributed';

function classifyMention(text: string, term: string): MentionClass {
  const regex = toKeywordRegex(term);
  let hadMention = false;
  let hadNegated = false;

  for (const match of text.matchAll(regex)) {
    const idx = match.index ?? -1;
    if (idx < 0) continue;

    const prefix = text.slice(Math.max(0, idx - 64), idx).toLowerCase();
    const suffix = text.slice(idx, Math.min(text.length, idx + 96)).toLowerCase();
    hadMention = true;

    if (isNegated(prefix, suffix)) {
      hadNegated = true;
      continue;
    }

    if (isAttribution(prefix, suffix, term.toLowerCase())) {
      return 'attributed';
    }
  }

  if (!hadMention) return 'none';
  if (hadNegated) return 'negated';
  return 'mentioned';
}

function isNegated(prefix: string, suffix: string): boolean {
  return (
    /(?:not|isn'?t|wasn'?t|ruled out|exclude[ds]?|instead of|rather than|not due to|not caused by)\s*$/.test(prefix) ||
    /^(?:\s*(?:isn'?t|wasn'?t|not)\b)/.test(suffix)
  );
}

function isAttribution(prefix: string, suffix: string, term: string): boolean {
  const left = /(?:root cause|cause|caused by|due to|because|reason|culprit|attributed to|driven by|triggered by)\s*$/.test(prefix);
  const right = /(?:is|was|caused|causing|responsible|culprit|root cause|reason)/.test(suffix);

  if (left) return true;
  if (right) return true;

  const clause = `${prefix} ${term} ${suffix}`;
  return /(?:root cause|caused by|due to|because|reason|culprit)/.test(clause);
}

function extractConclusionContext(output: EvalOutput): string {
  const rootCause = output.rootCause?.trim() ?? '';
  const full = output.trace.finalText ?? '';
  const merged = `${rootCause}\n${full}`.trim();

  return merged
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/^\s*>\s.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

function toKeywordRegex(keyword: string): RegExp {
  const escaped = escapeRegex(keyword.trim());
  if (/^[A-Za-z0-9_]+$/.test(keyword)) {
    return new RegExp(`\\b${escaped}\\b`, 'gi');
  }
  return new RegExp(`(^|\\W)${escaped}(?=$|\\W)`, 'gi');
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
