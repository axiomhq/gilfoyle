import { Scorer } from 'axiom/ai/evals';
import { generateText, Output } from 'ai';
import { google } from '@ai-sdk/google';
import { wrapAISDKModel } from 'axiom/ai';
import { z } from 'zod';
import type { EvalInput, EvalOutput } from '../harness/types.js';

if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GEMINI_API_KEY) {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
}

const JUDGE_PROMPT = `You are evaluating an SRE agent's incident investigation.

## Scenario
{scenario_description}

## Expected Root Cause Keywords
{expected_root_cause}

## Counterfactual Wrong Causes
{counterfactual_causes}

## Counterfactual Check
If the root cause were actually one of the counterfactual wrong causes listed above instead of the expected root cause, would the agent's cited evidence still fit? If the evidence is generic enough to support both the correct and incorrect causes (non-discriminative), score down significantly.

## Agent's Conclusion
{agent_conclusion}

## Task
Evaluate whether the agent correctly identified the root cause.`;

export const RCAAccuracyScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'rca-accuracy',
  async ({ input, output }) => {
    const { scenario } = input;
    const prompt = JUDGE_PROMPT
      .replace('{scenario_description}', `${scenario.name}\nPrompt: ${scenario.prompt}`)
      .replace('{expected_root_cause}', scenario.expected.rootCauseMustMention.join(', '))
      .replace('{counterfactual_causes}', (scenario.expected.rootCauseMustNotMention?.length ? scenario.expected.rootCauseMustNotMention.join(', ') : 'None specified'))
      .replace('{agent_conclusion}', output.rootCause);

    const judgmentSchema = z.object({
      score: z.number().describe('Score from 0 to 100 indicating how well the agent identified the root cause'),
      correct: z.boolean().describe('Whether the agent correctly identified the root cause'),
      discriminative: z.boolean().describe('Whether the evidence specifically supports the correct cause over the counterfactuals'),
      explanation: z.string().describe('One sentence explaining the judgment'),
    });

    try {
      const { output: judgment } = await generateText({
        model: wrapAISDKModel(google('gemini-3-flash-preview')),
        prompt,
        output: Output.object({ schema: judgmentSchema }),
        maxOutputTokens: 1000,
      });
      const rawScore = judgment.score;
      const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(1, rawScore / 100)) : 0;
      return {
        score,
        metadata: { ...judgment, agentConclusion: output.rootCause.slice(0, 500) },
      };
    } catch (e) {
      console.error(`[rca-accuracy] Gemini judge unavailable for ${scenario.id}, using keyword fallback: ${e instanceof Error ? e.message : String(e)}`);
      const text = output.rootCause.toLowerCase();
      const mustMention = scenario.expected.rootCauseMustMention;
      if (mustMention.length === 0) {
        return { score: 1, metadata: { fallback: true, fallbackReason: String(e), note: 'No rootCauseMustMention defined' } };
      }
      const score = mustMention.filter(kw => text.includes(kw.toLowerCase())).length / mustMention.length;
      return { score, metadata: { fallback: true, fallbackReason: String(e) } };
    }
  }
);
