import { Scorer } from 'axiom/ai/evals';
import { generateText, Output } from 'ai';
import { google } from '@ai-sdk/google';
import { wrapAISDKModel } from 'axiom/ai';
import { z } from 'zod';
import type { EvalInput, EvalOutput } from '../harness/types.js';
import { assessRunHealth } from './run-health.js';

if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GEMINI_API_KEY) {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
}

const JUDGE_PROMPT = `You are evaluating an SRE agent's incident investigation.

## Scenario
{scenario_description}

## Expected Root Cause Keywords
The agent's conclusion MUST mention ALL of these: {expected_root_cause}

## Counterfactual Wrong Causes
{counterfactual_causes}

## Counterfactual Check
If the root cause were actually one of the counterfactual wrong causes listed above instead of the expected root cause, would the agent's cited evidence still fit? If the evidence is generic enough to support both the correct and incorrect causes (non-discriminative), score down significantly.

## Agent's Full Investigation Output
The agent produced the following output during its investigation. Look for the agent's FINAL root cause conclusion — it is typically in a "## ROOT CAUSE" section, a "Root cause:" line, or the final summary paragraph. Ignore intermediate notes like "let me check the root cause" or "validating with the oracle" — those are process steps, not conclusions.

{agent_output}

## Task
1. Find the agent's final root cause statement in the output above.
2. Evaluate whether it correctly identifies the root cause (must mention the expected keywords).
3. Check discriminativeness against the counterfactual causes.`;

export const RCAAccuracyScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'rca-accuracy',
  async ({ input, output }) => {
    const health = assessRunHealth(output);
    if (!health.valid) {
      return {
        score: 0,
        metadata: {
          invalidRun: true,
          runValidityReasons: health.reasons,
          note: 'Skipped semantic RCA scoring due to invalid run',
        },
      };
    }

    const { scenario } = input;
    // Pass full finalText to the judge — regex extraction was unreliable
    // (matched mid-investigation "root cause" mentions instead of final conclusion).
    // Strip HARNESS ERROR noise so it doesn't confuse the judge.
    const cleanText = output.trace.finalText
      .replace(/\nHARNESS ERROR:.*$/s, '')
      .replace(/\nHARNESS TIMEOUT.*$/s, '')
      .trim();
    // Truncate to last 6000 chars to stay within judge context window
    // while keeping the final conclusion (which is always at the end).
    const agentOutput = cleanText.length > 6000
      ? `[...earlier investigation truncated...]\n\n${cleanText.slice(-6000)}`
      : cleanText;
    const prompt = JUDGE_PROMPT
      .replace('{scenario_description}', `${scenario.name}\nPrompt: ${scenario.prompt}`)
      .replace('{expected_root_cause}', scenario.expected.rootCauseMustMention.join(', '))
      .replace('{counterfactual_causes}', (scenario.expected.rootCauseMustNotMention?.length ? scenario.expected.rootCauseMustNotMention.join(', ') : 'None specified'))
      .replace('{agent_output}', agentOutput);

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
        metadata: { ...judgment, agentOutputLength: agentOutput.length },
      };
    } catch (e) {
      console.error(`[rca-accuracy] Gemini judge unavailable for ${scenario.id}, using keyword fallback: ${e instanceof Error ? e.message : String(e)}`);
      const text = cleanText.toLowerCase();
      const mustMention = scenario.expected.rootCauseMustMention;
      if (mustMention.length === 0) {
        return { score: 1, metadata: { fallback: true, fallbackReason: String(e), note: 'No rootCauseMustMention defined' } };
      }
      const score = mustMention.filter(kw => text.includes(kw.toLowerCase())).length / mustMention.length;
      return { score, metadata: { fallback: true, fallbackReason: String(e) } };
    }
  }
);
