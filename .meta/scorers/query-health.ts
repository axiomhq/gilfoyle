import type { ToolCall } from '../harness/types.js';
import {
  classifyQueryFailure,
  isQueryTool,
  type QueryFailure,
  type QueryFailureKind,
} from './query-error-classification.js';

export type ClassifiedQueryCall = {
  call: ToolCall;
  index: number;
  failure: QueryFailure;
  inputText: string;
  normalizedInput: string;
};

export type QueryHealth = {
  queryCalls: ToolCall[];
  classified: ClassifiedQueryCall[];
  failures: ClassifiedQueryCall[];
  validCalls: number;
  invalidCalls: number;
  validityScore: number;
  syntaxFailures: number;
  syntaxScore: number;
  failureRate: number;
  failureClassCounts: Record<string, number>;
  uniqueQueries: number;
  redundantQueries: number;
  redundancyPenalty: number;
  repaired: number;
  unrepaired: Array<{ index: number; tool: string; class: QueryFailureKind }>;
  unrepairedCount: number;
  repairScore: number;
};

export function analyzeQueryHealth(toolCalls: ToolCall[]): QueryHealth {
  const queryCalls = toolCalls.filter((tc) => isQueryTool(tc));

  const classified = queryCalls.map((call, index) => {
    const inputText = getInputText(call);
    return {
      call,
      index,
      failure: classifyQueryFailure(call),
      inputText,
      normalizedInput: normalizeQuery(inputText),
    } satisfies ClassifiedQueryCall;
  });

  const failures = classified.filter((entry) => entry.failure.hasFailure);
  const invalidCalls = failures.length;
  const validCalls = queryCalls.length - invalidCalls;
  const validityScore = queryCalls.length > 0 ? validCalls / queryCalls.length : 0;
  const syntaxFailures = failures.filter((entry) => entry.failure.kind === 'syntax').length;
  const syntaxScore = queryCalls.length > 0 ? 1 - (syntaxFailures / queryCalls.length) : 0;
  const failureRate = queryCalls.length > 0 ? invalidCalls / queryCalls.length : 0;

  const uniqueQueries = new Set(classified.map((entry) => entry.normalizedInput));
  const redundantQueries = Math.max(0, queryCalls.length - uniqueQueries.size);
  const redundancyPenalty = queryCalls.length > 0
    ? 1 - (redundantQueries / queryCalls.length)
    : 1;

  let repaired = 0;
  const unrepaired: Array<{ index: number; tool: string; class: QueryFailureKind }> = [];

  for (const failed of failures) {
    const hasRecovery = classified
      .slice(failed.index + 1)
      .some((later) => later.call.tool === failed.call.tool && !later.failure.hasFailure);
    if (hasRecovery) {
      repaired += 1;
    } else {
      unrepaired.push({
        index: failed.index,
        tool: failed.call.tool,
        class: failed.failure.kind,
      });
    }
  }

  const repairScore = failures.length > 0 ? repaired / failures.length : 1;

  const failureClassCounts: Record<string, number> = {};
  for (const failed of failures) {
    const cls = failed.failure.kind;
    failureClassCounts[cls] = (failureClassCounts[cls] ?? 0) + 1;
  }

  return {
    queryCalls,
    classified,
    failures,
    validCalls,
    invalidCalls,
    validityScore,
    syntaxFailures,
    syntaxScore,
    failureRate,
    failureClassCounts,
    uniqueQueries: uniqueQueries.size,
    redundantQueries,
    redundancyPenalty,
    repaired,
    unrepaired,
    unrepairedCount: unrepaired.length,
    repairScore,
  };
}

function getInputText(tc: ToolCall): string {
  if (typeof tc.input === 'string') return tc.input;
  if (tc.input == null) return '';
  try {
    return JSON.stringify(tc.input);
  } catch {
    return String(tc.input);
  }
}

function normalizeQuery(q: string): string {
  return q.toLowerCase().replace(/\s+/g, ' ').replace(/['"]/g, '').trim();
}
