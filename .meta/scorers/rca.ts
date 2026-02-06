/**
 * RCA Accuracy Scorer
 *
 * Uses an LLM judge to semantically evaluate whether the agent
 * correctly identified the root cause.
 */

import { Scorer } from 'axiom/ai/evals';
import { generateText } from 'ai';
import { google } from '@ai-sdk/google';
import type { EvalInput, EvalOutput } from '../harness/types.js';

// Support both env var names
if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GEMINI_API_KEY) {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
}

const JUDGE_PROMPT = `You are evaluating an SRE agent's incident investigation.

## Scenario
{scenario_description}

## Expected Root Cause
{expected_root_cause}

## Agent's Conclusion
{agent_conclusion}

## Evaluation Criteria

Score the agent's root cause analysis on a scale of 0-100:

- **100**: Correctly identified the exact root cause with proper mechanism explanation
- **80-99**: Identified the correct root cause but missing some detail or mechanism
- **50-79**: Partially correct - identified a contributing factor but missed the primary cause
- **20-49**: Wrong root cause but reasonable investigation approach
- **0-19**: Completely wrong or blamed unrelated factors

Also check if the agent made any of these critical errors:
- Blamed something explicitly ruled out (e.g., said "DDoS" when it was a config issue)
- Stated conclusions without evidence
- Confused correlation with causation

Respond in JSON format:
{
  "score": <0-100>,
  "correct": <true if score >= 80>,
  "explanation": "<1-2 sentence explanation>",
  "criticalErrors": ["<error1>", "<error2>"] or []
}`;

export const RCAAccuracyScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'rca-accuracy',
  async ({ input, output }) => {
    const { scenario } = input;
    
    const prompt = JUDGE_PROMPT
      .replace('{scenario_description}', `${scenario.name}\n${scenario.description ?? ''}\n\nPrompt: ${scenario.prompt}`)
      .replace('{expected_root_cause}', scenario.expected.rootCauseMustMention.join(', '))
      .replace('{agent_conclusion}', output.rootCause);

    try {
      const { text } = await generateText({
        model: google('gemini-3-flash-preview'),
        prompt,
        maxTokens: 500,
      });

      // Parse JSON response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return {
          score: 0,
          metadata: { error: 'Failed to parse judge response', raw: text },
        };
      }

      const judgment = JSON.parse(jsonMatch[0]) as {
        score: number;
        correct: boolean;
        explanation: string;
        criticalErrors: string[];
      };

      return {
        score: judgment.score / 100, // Normalize to 0-1
        metadata: {
          rawScore: judgment.score,
          correct: judgment.correct,
          explanation: judgment.explanation,
          criticalErrors: judgment.criticalErrors,
          agentConclusion: output.rootCause.slice(0, 500),
        },
      };
    } catch (e) {
      // Fallback to keyword matching if LLM fails
      if (process.env.DEBUG_SCORER === '1') {
        console.error('[rca-scorer] LLM judge failed:', e);
      }
      const text = output.rootCause.toLowerCase();
      const mustMention = scenario.expected.rootCauseMustMention;
      const mentionedCount = mustMention.filter((kw: string) =>
        text.includes(kw.toLowerCase())
      ).length;
      const score = mustMention.length > 0 ? mentionedCount / mustMention.length : 1;

      return {
        score,
        metadata: {
          fallback: true,
          error: String(e),
          keywordMatch: { found: mentionedCount, total: mustMention.length },
        },
      };
    }
  }
);
