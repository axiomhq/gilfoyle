import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput, ToolCall } from '../harness/types.js';

/**
 * Slack Comms Scorer (T10)
 *
 * Verifies the agent communicates via Slack during incident response.
 * 40% — announce/start message
 * 40% — resolve/conclusion message
 * 20% — no markdown tables in slack messages
 */

const START_KEYWORDS = ['investigating', 'incident', 'started', 'looking into', 'alert'];
const RESOLVE_KEYWORDS = ['resolved', 'root cause', 'found', 'conclusion', 'fixed', 'mitigated'];

function getSlackInput(tc: ToolCall): string {
  if (typeof tc.input === 'string') return tc.input;
  return JSON.stringify(tc.input ?? '');
}

export const SlackCommsScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'slack-comms',
  ({ output }) => {
    const slackCalls = output.trace.toolCalls.filter(tc => tc.tool === 'scripts/slack');

    if (slackCalls.length === 0) {
      return {
        score: 0,
        metadata: { note: 'No Slack messages sent', violation: 'no-slack-calls' },
      };
    }

    const slackInputs = slackCalls.map(getSlackInput);

    const hasStart = slackInputs.some(input => {
      const lower = input.toLowerCase();
      return START_KEYWORDS.some(kw => lower.includes(kw));
    });

    const hasResolve = slackInputs.some(input => {
      const lower = input.toLowerCase();
      return RESOLVE_KEYWORDS.some(kw => lower.includes(kw));
    });

    const hasMarkdownTable = slackInputs.some(input => /\|[\s]*---|\| ---/.test(input));

    let score = 0;
    if (hasStart) score += 0.4;
    if (hasResolve) score += 0.4;
    if (!hasMarkdownTable) score += 0.2;

    return {
      score,
      metadata: {
        note: [
          hasStart ? 'start message found' : 'MISSING start message',
          hasResolve ? 'resolve message found' : 'MISSING resolve message',
          hasMarkdownTable ? 'MARKDOWN TABLE in slack' : 'no markdown tables',
        ].join('; '),
        slackCallCount: slackCalls.length,
        hasStart,
        hasResolve,
        hasMarkdownTable,
      },
    };
  }
);
