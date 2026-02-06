import { Scorer } from 'axiom/ai/evals';
import { generateText, Output } from 'ai';
import { google } from '@ai-sdk/google';
import { wrapAISDKModel } from 'axiom/ai';
import { z } from 'zod';
import type { EvalInput, EvalOutput, ToolCall, ToolName } from '../harness/types.js';

if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GEMINI_API_KEY) {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
}

const JUDGE_PROMPT = `You are evaluating the quality of evidence cited by an SRE agent during incident investigation.

## Agent's Conclusion
{agent_text}

## Tool Outputs (data the agent had access to)
{tool_outputs}

## Expected Root Cause Keywords
{expected_root_cause}

## Counterfactual Wrong Causes
{counterfactual_causes}

## Task
Evaluate three dimensions of evidence quality:

1. **Specificity** (0-100): Does the agent cite specific data points (timestamps, error counts, metric values, status codes) rather than vague summaries? High scores require concrete numbers, times, or identifiers pulled from tool outputs.

2. **Discrimination** (0-100): Would the cited evidence also support one of the counterfactual wrong causes? If the evidence is generic enough to fit multiple explanations (e.g., "errors increased" without identifying which component), score low. Evidence that uniquely identifies the correct root cause scores high.

3. **Contextualization** (0-100): Are data points interpreted and connected to the root cause, or just pasted from output? High scores require the agent to explain WHY a data point matters, not just THAT it exists.`;

const judgmentSchema = z.object({
  specificity: z.number().describe('Score 0-100: are specific data points cited?'),
  discrimination: z.number().describe('Score 0-100: does evidence uniquely support the correct cause over counterfactuals?'),
  contextualization: z.number().describe('Score 0-100: are data points interpreted, not just pasted?'),
  explanation: z.string().describe('One sentence explaining the judgment'),
});

function computeDeterministicScore(input: EvalInput, output: EvalOutput) {
  const requiredEvidence = input.scenario.expected.requiredEvidence ?? [];
  if (requiredEvidence.length === 0) {
    return { score: 1, checks: [], noRequirements: true };
  }

  const checks: {
    tool: ToolName;
    found: boolean;
    toolUsed: boolean;
    keywordInOutput: boolean;
    citedInText: boolean;
    details: string;
  }[] = [];

  for (const req of requiredEvidence) {
    const calls = output.trace.toolCalls.filter((tc: ToolCall) => tc.tool === req.tool);
    const toolUsed = calls.length > 0;

    if (!toolUsed) {
      checks.push({
        tool: req.tool,
        found: false,
        toolUsed: false,
        keywordInOutput: false,
        citedInText: false,
        details: 'Tool never called',
      });
      continue;
    }

    const outputText = calls
      .map((tc: ToolCall) => typeof tc.output === 'string' ? tc.output : JSON.stringify(tc.output))
      .join(' ')
      .toLowerCase();
    const foundInOutput = req.mustMention.filter((m: string) => outputText.includes(m.toLowerCase()));
    const keywordInOutput = foundInOutput.length === req.mustMention.length;

    const finalText = output.trace.finalText.toLowerCase();
    const dataPointsCited = extractDataPointReferences(finalText, outputText);

    checks.push({
      tool: req.tool,
      found: keywordInOutput && dataPointsCited > 0,
      toolUsed: true,
      keywordInOutput,
      citedInText: dataPointsCited > 0,
      details: `keywords: ${foundInOutput.length}/${req.mustMention.length}, data points cited: ${dataPointsCited}`,
    });
  }

  let score = 0;
  for (const check of checks) {
    let checkScore = 0;
    if (check.toolUsed) checkScore += 0.4;
    if (check.keywordInOutput) checkScore += 0.3;
    if (check.citedInText) checkScore += 0.3;
    score += checkScore;
  }
  score /= checks.length;

  return { score, checks, noRequirements: false };
}

function formatToolOutputs(toolCalls: ToolCall[]): string {
  return toolCalls
    .filter(tc => tc.output != null)
    .map((tc, i) => {
      const out = typeof tc.output === 'string' ? tc.output : JSON.stringify(tc.output);
      return `${i + 1}. [${tc.tool}]: ${out.slice(0, 1000)}`;
    })
    .join('\n');
}

export const EvidenceQualityScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'evidence-quality',
  async ({ input, output }) => {
    const det = computeDeterministicScore(input, output);

    if (det.noRequirements) {
      return { score: 1, metadata: { note: 'No evidence requirements' } };
    }

    try {
      const { scenario } = input;
      const prompt = JUDGE_PROMPT
        .replace('{agent_text}', output.trace.finalText.slice(0, 8000))
        .replace('{tool_outputs}', formatToolOutputs(output.trace.toolCalls).slice(0, 6000))
        .replace('{expected_root_cause}', scenario.expected.rootCauseMustMention.join(', '))
        .replace('{counterfactual_causes}', (scenario.expected.rootCauseMustNotMention?.length ? scenario.expected.rootCauseMustNotMention.join(', ') : 'None specified'));

      const { output: judgment } = await generateText({
        model: wrapAISDKModel(google('gemini-3-flash-preview')),
        prompt,
        output: Output.object({ schema: judgmentSchema }),
        maxOutputTokens: 1000,
      });

      const llmScore = (
        clamp01(judgment.specificity / 100) * 0.4 +
        clamp01(judgment.discrimination / 100) * 0.35 +
        clamp01(judgment.contextualization / 100) * 0.25
      );

      const score = det.score * 0.3 + llmScore * 0.7;

      return {
        score,
        metadata: {
          evidenceChecks: det.checks,
          llm: judgment,
          deterministicWeight: 0.3,
          llmWeight: 0.7,
          deterministicScore: det.score,
          llmScore,
        },
      };
    } catch (e) {
      console.error(`[evidence-quality] Gemini judge unavailable for ${input.scenario.id}, using deterministic fallback: ${e instanceof Error ? e.message : String(e)}`);
      return {
        score: det.score,
        metadata: {
          evidenceChecks: det.checks,
          fallback: true,
          fallbackReason: String(e),
        },
      };
    }
  }
);

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

function extractDataPointReferences(finalText: string, toolOutput: string): number {
  let count = 0;

  const numbers = toolOutput.match(/\d{3,}/g) ?? [];
  for (const num of numbers) {
    if (finalText.includes(num)) count++;
  }

  const timestamps = toolOutput.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g) ?? [];
  for (const ts of timestamps) {
    if (finalText.includes(ts) || finalText.includes(ts.split('T')[1])) count++;
  }

  const percentages = toolOutput.match(/\d+\.?\d*%/g) ?? [];
  for (const pct of percentages) {
    if (finalText.includes(pct)) count++;
  }

  return count;
}
