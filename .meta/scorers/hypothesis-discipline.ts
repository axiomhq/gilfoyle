import { Scorer } from 'axiom/ai/evals';
import { generateText, Output } from 'ai';
import { google } from '@ai-sdk/google';
import { wrapAISDKModel } from 'axiom/ai';
import { z } from 'zod';
import type { EvalInput, EvalOutput, ToolCall } from '../harness/types.js';

if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GEMINI_API_KEY) {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
}

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

const JUDGE_PROMPT = `You are evaluating whether an SRE agent followed proper hypothesis-driven investigation methodology.

## Agent's Investigation Text
{agent_text}

## Tool Calls (in order)
{tool_calls}

## Task
Evaluate three dimensions of hypothesis discipline:

1. **Hypothesis Quality** (0-100): Did the agent form a testable, specific hypothesis? Not just using the word "hypothesis" but stating a concrete, falsifiable claim about the root cause. A good hypothesis names a specific component, failure mode, or mechanism.

2. **Falsification Quality** (0-100): Did the agent's queries intentionally target disproof of the initial hypothesis? Look at the tool call inputs — were queries designed to find evidence that would contradict the hypothesis, or did the agent only seek confirming evidence? Deliberately querying alternative causes, checking control groups, or looking for contradicting metrics scores high.

3. **Transition Quality** (0-100): When the agent changed hypotheses, was the transition evidence-driven? Did they explicitly state what evidence disproved the prior hypothesis before moving on, or did they silently shift? Score 0 if there was only one hypothesis and no need for transitions.`;

const judgmentSchema = z.object({
  hypothesisQuality: z.number().describe('Score 0-100: was the hypothesis testable and specific?'),
  falsificationQuality: z.number().describe('Score 0-100: did queries intentionally target disproof?'),
  transitionQuality: z.number().describe('Score 0-100: were hypothesis changes evidence-driven?'),
  explanation: z.string().describe('One sentence explaining the judgment'),
});

function computeDeterministicScore(text: string) {
  const hasHypothesis = HYPOTHESIS_PATTERNS.some(p => p.test(text));
  const hypothesisScore = hasHypothesis ? 1 : 0;

  const falsificationMatches = FALSIFICATION_PATTERNS.filter(p => p.test(text));
  const falsificationScore = Math.min(1, falsificationMatches.length / 2);

  const hasTransition = TRANSITION_PATTERNS.some(p => p.test(text));
  const transitionScore = hasTransition ? 1 : 0;

  const score = hypothesisScore * 0.4 + falsificationScore * 0.4 + transitionScore * 0.2;

  return {
    score,
    hasHypothesis,
    falsificationMatches: falsificationMatches.length,
    hasTransition,
    hypothesisScore,
    falsificationScore,
    transitionScore,
  };
}

function formatToolCalls(toolCalls: ToolCall[]): string {
  return toolCalls
    .map((tc, i) => {
      const input = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input);
      return `${i + 1}. ${tc.tool}: ${input.slice(0, 500)}`;
    })
    .join('\n');
}

export const HypothesisDisciplineScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'hypothesis-discipline',
  async ({ input, output }) => {
    const text = output.trace.finalText;
    const det = computeDeterministicScore(text);

    if (det.score === 0) {
      return {
        score: 0,
        metadata: {
          ...det,
          llmSkipped: true,
          sampleMatches: {
            hypothesis: null,
            falsification: null,
            transition: null,
          },
        },
      };
    }

    try {
      const prompt = JUDGE_PROMPT
        .replace('{agent_text}', text.slice(0, 8000))
        .replace('{tool_calls}', formatToolCalls(output.trace.toolCalls));

      const { output: judgment } = await generateText({
        model: wrapAISDKModel(google('gemini-3-flash-preview')),
        prompt,
        output: Output.object({ schema: judgmentSchema }),
        maxOutputTokens: 1000,
      });

      const llmScore = (
        (clamp01(judgment.hypothesisQuality / 100) * 0.4) +
        (clamp01(judgment.falsificationQuality / 100) * 0.4) +
        (clamp01(judgment.transitionQuality / 100) * 0.2)
      );

      const score = det.score * 0.3 + llmScore * 0.7;

      return {
        score,
        metadata: {
          ...det,
          llm: judgment,
          deterministicWeight: 0.3,
          llmWeight: 0.7,
          deterministicScore: det.score,
          llmScore,
          sampleMatches: {
            hypothesis: det.hasHypothesis ? findFirstMatch(text, HYPOTHESIS_PATTERNS) : null,
            falsification: det.falsificationMatches > 0 ? findFirstMatch(text, FALSIFICATION_PATTERNS) : null,
            transition: det.hasTransition ? findFirstMatch(text, TRANSITION_PATTERNS) : null,
          },
        },
      };
    } catch (e) {
      console.error(`[hypothesis-discipline] Gemini judge unavailable for ${input.scenario.id}, using regex fallback: ${e instanceof Error ? e.message : String(e)}`);
      return {
        score: det.score,
        metadata: {
          ...det,
          fallback: true,
          fallbackReason: String(e),
          sampleMatches: {
            hypothesis: det.hasHypothesis ? findFirstMatch(text, HYPOTHESIS_PATTERNS) : null,
            falsification: det.falsificationMatches > 0 ? findFirstMatch(text, FALSIFICATION_PATTERNS) : null,
            transition: det.hasTransition ? findFirstMatch(text, TRANSITION_PATTERNS) : null,
          },
        },
      };
    }
  }
);

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

function findFirstMatch(text: string, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const match = text.match(p);
    if (match) {
      const start = Math.max(0, match.index! - 30);
      const end = Math.min(text.length, match.index! + match[0].length + 30);
      return `...${text.slice(start, end)}...`;
    }
  }
  return null;
}
