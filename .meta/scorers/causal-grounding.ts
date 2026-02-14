import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput, ToolCall } from '../harness/types.js';
import { assessRunHealth } from './run-health.js';
import { classifyQueryFailure, isQueryTool } from './query-error-classification.js';

/**
 * Causal Grounding Scorer
 *
 * Rewards conclusions that are both expected and grounded in observed query data.
 * Penalizes cause keywords asserted without support in tool outputs.
 */
export const CausalGroundingScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'causal-grounding',
  ({ input, output }) => {
    const health = assessRunHealth(output);
    if (!health.valid) {
      return {
        score: 0,
        metadata: {
          applicable: true,
          invalidRun: true,
          runValidityReasons: health.reasons,
          note: 'Skipped causal grounding due to invalid run',
        },
      };
    }

    const allowNoQueries = input.scenario.scoring?.allowNoQueries === true;
    if (allowNoQueries) {
      return {
        score: 1,
        metadata: {
          applicable: false,
          note: 'Causal grounding skipped for setup-only scenario',
        },
      };
    }

    const expectedKeywords = input.scenario.expected.rootCauseMustMention ?? [];
    if (expectedKeywords.length === 0) {
      return {
        score: 1,
        metadata: {
          applicable: false,
          note: 'No rootCauseMustMention keywords configured',
        },
      };
    }

    const evidenceCorpus = collectValidQueryOutput(output.trace.toolCalls).toLowerCase();
    const conclusion = `${output.rootCause}\n${output.trace.finalText}`.toLowerCase();

    const keywordDetails = expectedKeywords.map((keyword) => {
      const mentioned = containsTerm(conclusion, keyword);
      const observed = containsTerm(evidenceCorpus, keyword);
      return {
        keyword,
        mentioned,
        observed,
        grounded: mentioned && observed,
      };
    });

    const mentioned = keywordDetails.filter((d) => d.mentioned).length;
    const grounded = keywordDetails.filter((d) => d.grounded).length;
    const unsupportedMentions = keywordDetails.filter((d) => d.mentioned && !d.observed).length;

    const mentionCoverage = mentioned / expectedKeywords.length;
    const groundedCoverage = grounded / expectedKeywords.length;
    const citationScore = estimateCitationScore(conclusion, evidenceCorpus);
    const hallucinationPenalty = unsupportedMentions > 0
      ? Math.max(0, 1 - (unsupportedMentions / Math.max(1, mentioned)))
      : 1;

    const raw = mentionCoverage * 0.45 + groundedCoverage * 0.4 + citationScore * 0.15;
    const score = raw * hallucinationPenalty;

    return {
      score,
      metadata: {
        applicable: true,
        mentionCoverage,
        groundedCoverage,
        citationScore,
        hallucinationPenalty,
        unsupportedMentions,
        keywordDetails,
      },
    };
  },
);

function collectValidQueryOutput(toolCalls: ToolCall[]): string {
  return toolCalls
    .filter((tc) => isQueryTool(tc))
    .filter((tc) => !classifyQueryFailure(tc).hasFailure)
    .map((tc) => {
      if (typeof tc.output === 'string') return tc.output;
      if (tc.output == null) return '';
      try {
        return JSON.stringify(tc.output);
      } catch {
        return '';
      }
    })
    .join('\n');
}

function containsTerm(text: string, term: string): boolean {
  const trimmed = term.trim();
  if (!trimmed) return false;
  const escaped = escapeRegex(trimmed.toLowerCase());
  if (/^[a-z0-9_]+$/i.test(trimmed)) {
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
  }
  return text.includes(trimmed.toLowerCase());
}

function estimateCitationScore(conclusion: string, evidence: string): number {
  if (!conclusion || !evidence) return 0;

  const hits = new Set<string>();
  for (const token of extractDataTokens(conclusion)) {
    if (token.length < 2) continue;
    if (evidence.includes(token)) hits.add(token);
  }

  return Math.min(1, hits.size / 3);
}

function extractDataTokens(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\b\d{2,}\b/g,
    /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
    /\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(?::\d{2})?z?\b/g,
    /\b\d+(?:\.\d+)?%\b/g,
  ];
  for (const pattern of patterns) {
    out.push(...(text.match(pattern) ?? []));
  }
  return out;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
