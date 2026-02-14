import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput, ToolName } from '../harness/types.js';

/**
 * First Run Scorer (T10)
 *
 * Only applies to the 'first-run' scenario. Checks that the agent:
 * 1. Only uses allowed tools (init, mem-write) — no queries, no discovery, no slack
 * 2. Guides the user to configure their tools (mentions config.toml)
 * 3. Tells the user to re-run init after configuring
 *
 * Score breakdown:
 *   40% — Only allowlisted tools used (scripts/init, scripts/mem-write)
 *   30% — Mentions config file or configuration
 *   30% — Mentions re-running init after setup
 */

const ALLOWED_TOOLS: Set<ToolName> = new Set([
  'scripts/init',
  'scripts/mem-write',
]);

export const FirstRunScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'first-run',
  ({ input, output }) => {
    // Only score this for the first-run scenario
    if (input.scenario.id !== 'first-run') {
      return { score: 1, metadata: { applicable: false, note: 'Not a first-run scenario, skipped' } };
    }

    const toolCalls = output.trace.toolCalls;
    const finalText = output.trace.finalText.toLowerCase();
    let score = 0;
    const details: Record<string, unknown> = {};

    // 40%: Only allowlisted tools used
    const disallowedCalls = toolCalls.filter((tc) => !ALLOWED_TOOLS.has(tc.tool));
    if (disallowedCalls.length === 0) {
      score += 0.4;
      details.onlyAllowedTools = true;
    } else {
      details.onlyAllowedTools = false;
      details.disallowedCalls = disallowedCalls.map((tc) => tc.tool);
    }

    // 30%: Mentions config file or configuration
    const configMentioned =
      finalText.includes('config.toml') ||
      finalText.includes('configuration') ||
      finalText.includes('configure') ||
      finalText.includes('config file');
    if (configMentioned) {
      score += 0.3;
      details.configMentioned = true;
    } else {
      details.configMentioned = false;
    }

    // 30%: Mentions re-running init
    const rerunMentioned =
      finalText.includes('re-run') ||
      finalText.includes('rerun') ||
      finalText.includes('run scripts/init') ||
      finalText.includes('run init') ||
      finalText.includes('scripts/init again');
    if (rerunMentioned) {
      score += 0.3;
      details.rerunMentioned = true;
    } else {
      details.rerunMentioned = false;
    }

    return {
      score,
      metadata: {
        applicable: true,
        note:
          score >= 0.7
            ? 'Handled first-run correctly'
            : 'Failed to guide user through setup',
        ...details,
      },
    };
  }
);
