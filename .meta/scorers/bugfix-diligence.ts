import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput, ToolName } from '../harness/types.js';
import { assessRunHealth } from './run-health.js';

/**
 * Bug Fix Diligence Scorer
 *
 * Checks whether the agent followed proper bug fix protocol when
 * transitioning from investigation to code fix:
 * 1. History investigation (git log / git blame tool calls)    — 0.3
 * 2. PR understanding (gh pr view / diff tool calls)           — 0.3
 * 3. Intent in output (mentions introducing PR/commit + why)   — 0.2
 * 4. Red→green signal (test failing before fix, passing after) — 0.2
 *
 * Checks both tool calls (definitive) and text patterns (supplementary).
 * Only scored when `scoring.requireBugfixDiligence` is true.
 */

const HISTORY_TOOLS: ToolName[] = ['git_log', 'git_blame', 'gh_pr_view'];
const PR_TOOLS: ToolName[] = ['gh_pr_view', 'gh_pr_diff'];

const INTENT_PATTERNS = [
  /\bintroduc(?:ed|ing)\b/i,
  /\bcaus(?:ed|ing)\s+by\b/i,
  /\bregress(?:ed|ion)\b/i,
  /\bthe\s+(?:PR|commit|change|diff)\s+(?:was\s+)?(?:intended|meant)\s+to\b/i,
  /\boriginal(?:ly)?\s+(?:intended|meant|designed)\b/i,
  /\bpurpose\s+(?:of|was)\b/i,
  /\bPR\s*#?\d+\b.*\b(?:to|for|in order to)\b/i,
];

const RED_GREEN_SEQUENCES: [RegExp, RegExp][] = [
  [/\bfail(?:s|ed|ing|ure)?\b/i, /\bpass(?:es|ed|ing)?\b/i],
  [/\bred\b/i, /\bgreen\b/i],
  [/\btest.*\bfail/i, /\btest.*\bpass/i],
  [/\bbefore\b.*\bfail/i, /\bafter\b.*\bpass/i],
];

function calledAnyTool(toolCalls: { tool: ToolName }[], tools: ToolName[]): boolean {
  return toolCalls.some((tc) => tools.includes(tc.tool));
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function hasRedGreenSequence(text: string): boolean {
  return RED_GREEN_SEQUENCES.some(([red, green]) => red.test(text) && green.test(text));
}

export const BugfixDiligenceScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'bugfix-diligence',
  ({ input, output }) => {
    if (!input.scenario.scoring?.requireBugfixDiligence) {
      return {
        score: 1,
        metadata: { note: 'Bug fix diligence not required for this scenario' },
      };
    }

    const health = assessRunHealth(output);
    if (!health.valid) {
      return {
        score: 0,
        metadata: {
          invalidRun: true,
          runValidityReasons: health.reasons,
          note: 'Skipped bugfix-diligence scoring due to invalid run',
        },
      };
    }

    const { toolCalls } = output.trace;
    const text = output.trace.finalText;

    // Check tool calls (definitive signal) — did the agent actually call these tools?
    const calledHistoryTool = calledAnyTool(toolCalls, HISTORY_TOOLS);
    const calledPRTool = calledAnyTool(toolCalls, PR_TOOLS);

    // Check text output (supplementary) — does the conclusion show understanding?
    const intentInOutput = matchesAny(text, INTENT_PATTERNS);
    const redGreenSignal = hasRedGreenSequence(text);

    const score =
      (calledHistoryTool ? 0.3 : 0) +
      (calledPRTool ? 0.3 : 0) +
      (intentInOutput ? 0.2 : 0) +
      (redGreenSignal ? 0.2 : 0);

    return {
      score,
      metadata: {
        calledHistoryTool,
        calledPRTool,
        intentInOutput,
        redGreenSignal,
        historyToolCalls: toolCalls.filter((tc) => HISTORY_TOOLS.includes(tc.tool)).map((tc) => tc.tool),
        prToolCalls: toolCalls.filter((tc) => PR_TOOLS.includes(tc.tool)).map((tc) => tc.tool),
      },
    };
  },
);
