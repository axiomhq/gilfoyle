import type { EvalOutput } from '../harness/types.js';

export const RUN_FATAL_PATTERNS: RegExp[] = [
  /HARNESS ERROR/i,
  /HARNESS TIMEOUT/i,
  /\bmodel not found\b/i,
  /selected model/i,
  /\bunknownerror\b/i,
];

export type RunHealth = {
  valid: boolean;
  reasons: string[];
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
};

/**
 * Shared execution-health checks used by multiple scorers.
 * Invalid runs should not be interpreted as agent behavior.
 */
export function assessRunHealth(output: EvalOutput): RunHealth {
  const reasons: string[] = [];
  const text = output.trace.finalText ?? '';
  const trimmed = text.trim();
  const toolCalls = output.trace.toolCalls;
  const usage = output.trace.usage;

  if (!trimmed) {
    reasons.push('empty-final-text');
  }

  if (toolCalls.length === 0 && trimmed.length < 20) {
    reasons.push('no-tool-calls-and-minimal-output');
  }

  for (const pattern of RUN_FATAL_PATTERNS) {
    if (pattern.test(text)) {
      reasons.push(`fatal-pattern:${pattern.source}`);
    }
  }

  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  if (toolCalls.length === 0 && inputTokens === 0 && outputTokens === 0) {
    reasons.push('zero-usage-and-no-tools');
  }

  return {
    valid: reasons.length === 0,
    reasons,
    inputTokens,
    outputTokens,
    toolCalls: toolCalls.length,
  };
}
