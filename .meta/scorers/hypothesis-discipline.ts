import { Scorer } from 'axiom/ai/evals';
import { generateText, Output } from 'ai';
import { google } from '@ai-sdk/google';
import { wrapAISDKModel } from 'axiom/ai';
import { z } from 'zod';
import type { EvalInput, EvalOutput, ToolCall } from '../harness/types.js';
import { assessRunHealth } from './run-health.js';

if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GEMINI_API_KEY) {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
}

const JUDGE_PROMPT = `You are evaluating whether an SRE agent followed proper hypothesis-driven investigation methodology.

## Agent's Investigation Text
{agent_text}

## Tool Calls (in order)
{tool_calls}

## Task
Evaluate three dimensions of hypothesis discipline:

1. **Hypothesis Quality** (0-100): Did the agent form a testable, specific hypothesis? Not just using the word "hypothesis" but stating a concrete, falsifiable claim about the root cause. A good hypothesis names a specific component, failure mode, or mechanism. Agents often state hypotheses implicitly as causal claims (e.g., "the 500s are from X failing to connect to Y", "goroutines growing while connections stay flat = goroutine leak") — these count.

2. **Falsification Quality** (0-100): Did the agent's queries intentionally target disproof of the initial hypothesis? Look at the tool call inputs — were queries designed to find evidence that would contradict the hypothesis, or did the agent only seek confirming evidence? Deliberately querying alternative causes, checking control groups, comparing pre/post baselines, ruling out other error classes ("no DB errors, no network errors"), or using the Oracle for independent validation all count as falsification.

3. **Transition Quality** (0-100): When the agent changed hypotheses, was the transition evidence-driven? Did they explicitly state what evidence disproved the prior hypothesis before moving on, or did they silently shift? Score 0 if there was only one hypothesis and no need for transitions.`;

const judgmentSchema = z.object({
  hypothesisQuality: z.number().describe('Score 0-100: was the hypothesis testable and specific?'),
  falsificationQuality: z.number().describe('Score 0-100: did queries intentionally target disproof?'),
  transitionQuality: z.number().describe('Score 0-100: were hypothesis changes evidence-driven?'),
  explanation: z.string().describe('One sentence explaining the judgment'),
});

function formatToolCalls(toolCalls: ToolCall[]): string {
  return toolCalls
    .map((tc, i) => {
      const input = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input);
      return `${i + 1}. ${tc.tool}: ${input.slice(0, 500)}`;
    })
    .join('\n');
}

async function callJudge(
  prompt: string,
  scenarioId: string,
): Promise<z.infer<typeof judgmentSchema>> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const result = await generateText({
        model: wrapAISDKModel(google('gemini-3-flash-preview')),
        prompt,
        output: Output.object({ schema: judgmentSchema }),
        maxOutputTokens: 1000,
      });

      // AI SDK throws AI_NoOutputGeneratedError when finishReason !== "stop"
      // (known bug with Gemini: vercel/ai#11348, #11466).
      // Try .output first, fall back to parsing .text manually.
      try {
        return result.output;
      } catch {
        if (result.text) {
          const parsed = judgmentSchema.safeParse(JSON.parse(result.text));
          if (parsed.success) return parsed.data;
        }
        throw new Error('Gemini returned text but failed schema validation');
      }
    } catch (err) {
      if (attempt < MAX_ATTEMPTS - 1) {
        console.error(
          `[hypothesis-discipline] Gemini attempt ${attempt + 1} failed for ${scenarioId}, retrying: ${err instanceof Error ? err.message : String(err)}`,
        );
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Unreachable');
}

export const HypothesisDisciplineScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'hypothesis-discipline',
  async ({ input, output }) => {
    const health = assessRunHealth(output);
    if (!health.valid) {
      return {
        score: 0,
        metadata: {
          applicable: true,
          invalidRun: true,
          runValidityReasons: health.reasons,
          note: 'Skipped hypothesis-discipline scoring due to invalid run',
        },
      };
    }

    const required =
      input.scenario.scoring?.requireHypothesisDiscipline ?? input.scenario.id !== 'first-run';
    if (!required) {
      return {
        score: 1,
        metadata: {
          applicable: false,
          note: 'Hypothesis discipline not required for this scenario',
        },
      };
    }

    // Strip HARNESS ERROR/TIMEOUT noise before scoring.
    const text = output.trace.finalText
      .replace(/\s*HARNESS ERROR:.*$/s, '')
      .replace(/\s*HARNESS TIMEOUT.*$/s, '')
      .trim();
    const toolCalls = output.trace.toolCalls;
    if (toolCalls.length === 0) {
      return {
        score: 0,
        metadata: {
          applicable: true,
          note: 'No tool calls made; cannot evaluate investigation discipline',
          toolCalls: 0,
        },
      };
    }

    // Pass last 8000 chars to keep the final conclusion (always at the end).
    const agentText =
      text.length > 8000
        ? `[...earlier investigation truncated...]\n\n${text.slice(-8000)}`
        : text;
    const prompt = JUDGE_PROMPT.replace('{agent_text}', agentText).replace(
      '{tool_calls}',
      formatToolCalls(toolCalls),
    );

    const judgment = await callJudge(prompt, input.scenario.id);

    const score =
      clamp01(judgment.hypothesisQuality / 100) * 0.4 +
      clamp01(judgment.falsificationQuality / 100) * 0.4 +
      clamp01(judgment.transitionQuality / 100) * 0.2;

    return {
      score,
      metadata: {
        applicable: true,
        llm: judgment,
      },
    };
  },
);

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}
