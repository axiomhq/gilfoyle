/**
 * Evidence Quality Scorer
 *
 * Checks if the agent's evidence is backed by actual tool outputs.
 * Gilfoyle's golden rule: "Never guess. Follow the data."
 */

import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput, ToolCall, ToolName } from '../harness/types.js';

interface EvidenceResult {
  tool: ToolName;
  found: boolean;
  reason?: string;
  foundMentions?: string[];
  missingMentions?: string[];
  referencedInEvidence?: boolean;
}

export const EvidenceQualityScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'evidence-quality',
  ({ input, output }) => {
    const { expected } = input.scenario;
    const requiredEvidence = expected.requiredEvidence ?? [];

    if (requiredEvidence.length === 0) {
      return { score: 1, metadata: { note: 'No evidence requirements specified' } };
    }

    const results: EvidenceResult[] = requiredEvidence.map((req: { tool: ToolName; mustMention: string[] }) => {
      const matchingCalls = output.trace.toolCalls.filter((tc: ToolCall) => tc.tool === req.tool);

      if (matchingCalls.length === 0) {
        return {
          tool: req.tool,
          found: false,
          reason: 'Tool never called',
        };
      }

      const outputText = matchingCalls
        .map((tc: ToolCall) => JSON.stringify(tc.output))
        .join(' ')
        .toLowerCase();

      const foundMentions = req.mustMention.filter((m: string) =>
        outputText.includes(m.toLowerCase())
      );

      const evidenceText = output.evidence.join(' ').toLowerCase();
      const evidenceReferences = req.mustMention.filter((m: string) =>
        evidenceText.includes(m.toLowerCase())
      );

      return {
        tool: req.tool,
        found: foundMentions.length === req.mustMention.length,
        foundMentions,
        missingMentions: req.mustMention.filter((m: string) => !outputText.includes(m.toLowerCase())),
        referencedInEvidence: evidenceReferences.length > 0,
      };
    });

    const passedCount = results.filter((r: EvidenceResult) => r.found).length;
    const score = requiredEvidence.length > 0 ? passedCount / requiredEvidence.length : 1;

    return {
      score,
      metadata: { evidenceChecks: results },
    };
  }
);
