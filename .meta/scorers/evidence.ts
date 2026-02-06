import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput, ToolCall, ToolName } from '../harness/types.js';

/**
 * Evidence Quality Scorer — v2
 *
 * Checks that the agent's final text cites specific data points
 * from tool outputs (timestamps, values, counts), not just keywords.
 *
 * Also checks that the agent used the right tools and that
 * tool outputs actually contained the evidence.
 */
export const EvidenceQualityScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'evidence-quality',
  ({ input, output }) => {
    const requiredEvidence = input.scenario.expected.requiredEvidence ?? [];
    if (requiredEvidence.length === 0) {
      return { score: 1, metadata: { note: 'No evidence requirements' } };
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

      // Check if tool outputs contain the required keywords
      const outputText = calls
        .map((tc: ToolCall) => typeof tc.output === 'string' ? tc.output : JSON.stringify(tc.output))
        .join(' ')
        .toLowerCase();
      const foundInOutput = req.mustMention.filter((m: string) => outputText.includes(m.toLowerCase()));
      const keywordInOutput = foundInOutput.length === req.mustMention.length;

      // Check if agent's final text references specific values from outputs
      // Look for numbers, timestamps, or specific identifiers from tool outputs
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

    // Scoring: 
    // - 40% tool used correctly
    // - 30% keywords found in output
    // - 30% agent cited specific data from output
    let score = 0;
    for (const check of checks) {
      let checkScore = 0;
      if (check.toolUsed) checkScore += 0.4;
      if (check.keywordInOutput) checkScore += 0.3;
      if (check.citedInText) checkScore += 0.3;
      score += checkScore;
    }
    score /= checks.length;

    return { score, metadata: { evidenceChecks: checks } };
  }
);

/**
 * Count how many specific data points from tool output
 * appear in the agent's final text.
 * 
 * Looks for: numbers > 100, timestamps, percentages,
 * specific identifiers like service names or error codes.
 */
function extractDataPointReferences(finalText: string, toolOutput: string): number {
  let count = 0;

  // Find specific numbers from tool output that appear in final text
  const numbers = toolOutput.match(/\d{3,}/g) ?? [];
  for (const num of numbers) {
    if (finalText.includes(num)) count++;
  }

  // Find timestamps referenced
  const timestamps = toolOutput.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g) ?? [];
  for (const ts of timestamps) {
    if (finalText.includes(ts) || finalText.includes(ts.split('T')[1])) count++;
  }

  // Find percentage-like patterns
  const percentages = toolOutput.match(/\d+\.?\d*%/g) ?? [];
  for (const pct of percentages) {
    if (finalText.includes(pct)) count++;
  }

  return count;
}
