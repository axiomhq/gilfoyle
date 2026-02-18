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

const JUDGE_PROMPT = `You are evaluating whether an SRE agent provided source links for data it cited in its response.

## Rule Under Test
When an agent runs queries against data systems (Axiom, Grafana, Prometheus, etc.) and cites numbers or results from those queries in its response, it MUST include a verifiable source link (permalink, dashboard URL, or link-generation tool call) for each cited query. Users need to verify the data independently.

## Agent's Response
{agent_text}

## Tool Calls Made
{tool_calls}

## Task
Evaluate two dimensions:

1. **Data Citation** (0-100): Does the agent's response cite specific numbers, counts, rates, percentages, or metrics that came from query tool calls? Score 0 if the response contains no data-derived claims. Score high if the response references specific values from tool outputs.

2. **Source Link Coverage** (0-100): For each piece of cited data, did the agent provide a way for the user to verify it? This includes:
   - Calling a link-generation tool (scripts/axiom-link, scripts/grafana-link, scripts/pyroscope-link, scripts/sentry-link)
   - Including a permalink URL in the response
   - Referencing a dashboard or issue tracker with a direct URL
   Score 100 if every cited data point has a source link. Score 0 if data was cited but no links were provided at all. Score proportionally for partial coverage. If no data was cited (dataCitation=0), score 100 (nothing to link).`;

const judgmentSchema = z.object({
  dataCitation: z.number().describe('Score 0-100: does the response cite specific data from queries?'),
  sourceLinkCoverage: z.number().describe('Score 0-100: are cited data points backed by source links?'),
  explanation: z.string().describe('One sentence explaining the judgment'),
});

function formatToolCalls(toolCalls: ToolCall[]): string {
  return toolCalls
    .map((tc, i) => {
      const input = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input);
      const out = tc.output != null
        ? (typeof tc.output === 'string' ? tc.output : JSON.stringify(tc.output))
        : '(no output)';
      return `${i + 1}. [${tc.tool}] input: ${input.slice(0, 400)} → output: ${out.slice(0, 400)}`;
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
          `[source-links] Gemini attempt ${attempt + 1} failed for ${scenarioId}, retrying: ${err instanceof Error ? err.message : String(err)}`,
        );
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Unreachable');
}

export const SourceLinkScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'source-links',
  async ({ input, output }) => {
    const required = input.scenario.scoring?.requireSourceLinks === true;
    if (!required) {
      return {
        score: 1,
        metadata: { applicable: false, note: 'Source links not required for this scenario' },
      };
    }

    const health = assessRunHealth(output);
    if (!health.valid) {
      return {
        score: 0,
        metadata: {
          invalidRun: true,
          runValidityReasons: health.reasons,
          note: 'Skipped source-links scoring due to invalid run',
        },
      };
    }

    const text = output.trace.finalText
      .replace(/\s*HARNESS ERROR:.*$/s, '')
      .replace(/\s*HARNESS TIMEOUT.*$/s, '')
      .trim();

    const agentText =
      text.length > 8000
        ? `[...truncated...]\n\n${text.slice(-8000)}`
        : text;

    const prompt = JUDGE_PROMPT
      .replace('{agent_text}', agentText)
      .replace('{tool_calls}', formatToolCalls(output.trace.toolCalls));

    try {
      const judgment = await callJudge(prompt, input.scenario.id);

      const dataCitation = clamp01(judgment.dataCitation / 100);
      const linkCoverage = clamp01(judgment.sourceLinkCoverage / 100);

      // If no data was cited, the scorer is not applicable
      if (dataCitation < 0.1) {
        return {
          score: 1,
          metadata: {
            applicable: false,
            llm: judgment,
            note: 'No data cited in response — source links not applicable',
          },
        };
      }

      // Score is purely about link coverage when data is cited
      const score = linkCoverage;

      return {
        score,
        metadata: {
          applicable: true,
          llm: judgment,
          dataCitation,
          linkCoverage,
        },
      };
    } catch (e) {
      console.error(
        `[source-links] Gemini judge unavailable for ${input.scenario.id}: ${err(e)}`,
      );
      return {
        score: 0,
        metadata: {
          applicable: true,
          fallback: true,
          fallbackReason: err(e),
          note: 'Judge unavailable — scoring conservatively as 0',
        },
      };
    }
  },
);

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
