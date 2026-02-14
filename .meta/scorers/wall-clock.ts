import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput } from '../harness/types.js';

const EVAL_TIMEOUT_MS = 300_000;
const MIN_BUDGET_MS = 45_000;
const MAX_BUDGET_MS = EVAL_TIMEOUT_MS - 5_000;

/**
 * Wall Clock Scorer
 *
 * Scores end-to-end elapsed runtime for each scenario.
 * - Honors scenario.budgets.maxElapsedMs when present.
 * - Otherwise derives a budget from maxToolCalls + scenario type.
 * - Adds a smaller cadence component (ms per tool call) to catch slow loops.
 */
export const WallClockScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'wall-clock',
  ({ input, output }) => {
    const elapsedMs = output.trace.elapsedMs;
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
      return {
        score: 0,
        metadata: {
          applicable: true,
          note: 'Missing or invalid elapsed runtime',
          elapsedMs,
        },
      };
    }

    const { budgetMs, source } = resolveBudgetMs(input);
    const absoluteScore = linearScore(elapsedMs, budgetMs, EVAL_TIMEOUT_MS);

    const toolCalls = output.trace.toolCalls.length;
    const normalizedCalls = Math.max(1, toolCalls);
    const msPerCall = elapsedMs / normalizedCalls;
    const targetPerCallMs = input.scenario.scoring?.allowNoQueries ? 40_000 : 22_000;
    const perCallScore = linearScore(msPerCall, targetPerCallMs, targetPerCallMs * 3);

    // Runtime dominates, but cadence catches step-wise stalls.
    const score = absoluteScore * 0.75 + perCallScore * 0.25;

    return {
      score,
      metadata: {
        applicable: true,
        elapsedMs: Math.round(elapsedMs),
        elapsedSec: Math.round(elapsedMs / 1000),
        budgetMs,
        budgetSec: Math.round(budgetMs / 1000),
        budgetSource: source,
        withinBudget: elapsedMs <= budgetMs,
        budgetUtilizationPct: Math.round((elapsedMs / budgetMs) * 100),
        speedTier: classifySpeed(elapsedMs, budgetMs),
        toolCalls,
        msPerCall: Math.round(msPerCall),
        targetPerCallMs,
        absoluteScore: Math.round(absoluteScore * 100),
        cadenceScore: Math.round(perCallScore * 100),
      },
    };
  },
);

function resolveBudgetMs(input: EvalInput): { budgetMs: number; source: 'scenario' | 'derived' } {
  const explicit = input.scenario.budgets?.maxElapsedMs;
  if (Number.isFinite(explicit) && (explicit ?? 0) > 0) {
    return { budgetMs: clampBudget(explicit ?? MIN_BUDGET_MS), source: 'scenario' };
  }

  const allowNoQueries = input.scenario.scoring?.allowNoQueries === true;
  const maxToolCalls = input.scenario.budgets?.maxToolCalls;

  const derived = Number.isFinite(maxToolCalls)
    ? (allowNoQueries ? 20_000 : 45_000) + Math.max(1, maxToolCalls ?? 1) * (allowNoQueries ? 12_000 : 15_000)
    : allowNoQueries
      ? 90_000
      : 220_000;

  return { budgetMs: clampBudget(derived), source: 'derived' };
}

function clampBudget(ms: number): number {
  return Math.min(MAX_BUDGET_MS, Math.max(MIN_BUDGET_MS, Math.round(ms)));
}

function linearScore(actual: number, softLimit: number, hardLimit: number): number {
  if (actual <= softLimit) return 1;
  const window = Math.max(1, hardLimit - softLimit);
  return Math.max(0, 1 - (actual - softLimit) / window);
}

function classifySpeed(elapsedMs: number, budgetMs: number): 'fast' | 'nominal' | 'slow' | 'critical' {
  if (elapsedMs <= budgetMs * 0.7) return 'fast';
  if (elapsedMs <= budgetMs) return 'nominal';
  if (elapsedMs <= budgetMs * 1.2) return 'slow';
  return 'critical';
}
