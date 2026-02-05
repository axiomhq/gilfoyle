/**
 * SKILL.md Optimizer
 *
 * Analyzes eval failures and suggests targeted edits to SKILL.md.
 * Follows the same pattern as webhook/router_optimize_test.go.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=xxx bun optimizer/run.ts
 */

export { optimize } from './optimize.js';
export type { FailedScenario, PromptFix, OptimizeResult } from './types.js';
