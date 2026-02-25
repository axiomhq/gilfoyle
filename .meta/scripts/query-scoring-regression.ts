import assert from 'node:assert/strict';
import { EfficiencyScorer } from '../scorers/efficiency.js';
import { QueryRepairScorer } from '../scorers/query-repair.js';
import { QueryValidityScorer } from '../scorers/query-validity.js';
import type { EvalInput, EvalOutput, ToolCall } from '../harness/types.js';

function mustHaveScore(label: string, score: number | null): number {
  if (score == null) {
    throw new Error(`${label} returned null score`);
  }
  return score;
}

function buildArgs(toolCalls: ToolCall[]): {
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
} {
  const input: EvalInput = {
    scenario: {
      id: 'query-scoring-regression',
      name: 'query-scoring-regression',
      description: 'regression harness for query scorer consistency',
      prompt: 'investigate',
      initOutput: 'init',
      toolMocks: {},
      expected: {
        rootCauseMustMention: ['foo'],
        requiredEvidence: [],
      },
      budgets: {
        maxToolCalls: 10,
      },
    },
    config: {
      harness: 'amp',
    },
  };

  const output: EvalOutput = {
    trace: {
      finalText: 'done',
      toolCalls,
      elapsedMs: 100,
    },
    rootCause: 'foo',
    evidence: [],
  };

  return {
    input,
    output,
    expected: {
      rootCause: 'foo',
      evidence: [],
    },
  };
}

async function main(): Promise<void> {
  // Regression #1: classifier-detected errors must penalize efficiency even if
  // queryValid is missing/undefined on the tool call.
  const classifierOnlyFailure: ToolCall[] = [
    {
      tool: 'scripts/axiom-query',
      input: "scripts/axiom-query prod <<< \"['app-logs'] | where level == 'error'\"",
      output: "error: Unknown metric 'foo'. Available: bar,baz",
    },
  ];

  const classifierArgs = buildArgs(classifierOnlyFailure);
  const classifierEfficiency = await EfficiencyScorer(classifierArgs);
  const classifierValidity = await QueryValidityScorer(classifierArgs);
  const classifierEfficiencyScore = mustHaveScore('efficiency (classifier regression)', classifierEfficiency.score);
  const classifierValidityScore = mustHaveScore('query-validity (classifier regression)', classifierValidity.score);

  assert.ok(
    classifierValidityScore < 1,
    `query-validity should penalize classifier-detected failures; got ${classifierValidityScore}`,
  );
  assert.ok(
    classifierEfficiencyScore < 1,
    `efficiency should penalize classifier-detected failures; got ${classifierEfficiencyScore}`,
  );

  // Regression #2: with identical failure-rate, repaired failures should
  // produce better efficiency than unrepaired failures.
  const fullyRepaired: ToolCall[] = [
    {
      tool: 'scripts/axiom-query',
      input: "q1: ['app-logs'] | where level == 'error'",
      output: 'error: APL syntax error: expected ]',
    },
    {
      tool: 'scripts/axiom-query',
      input: "q2: ['deploy-events'] | where event == 'deploy'",
      output: "error: Unknown dataset 'deploy-event'",
    },
    {
      tool: 'scripts/axiom-query',
      input: "q3: ['deploy-events'] | where event == 'deploy'",
      output: '# 1/1 rows, 10ms',
    },
  ];

  const partiallyRepaired: ToolCall[] = [
    {
      tool: 'scripts/axiom-query',
      input: "q1: ['app-logs'] | where level == 'error'",
      output: 'error: APL syntax error: expected ]',
    },
    {
      tool: 'scripts/axiom-query',
      input: "q2: ['deploy-events'] | where event == 'deploy'",
      output: '# 1/1 rows, 10ms',
    },
    {
      tool: 'scripts/axiom-query',
      input: "q3: ['deploy-events'] | where event == 'deploy'",
      output: "error: Unknown dataset 'deploy-event'",
    },
  ];

  const fullRepairScore = await QueryRepairScorer(buildArgs(fullyRepaired));
  const partialRepairScore = await QueryRepairScorer(buildArgs(partiallyRepaired));
  const fullEfficiency = await EfficiencyScorer(buildArgs(fullyRepaired));
  const partialEfficiency = await EfficiencyScorer(buildArgs(partiallyRepaired));
  const fullRepair = mustHaveScore('query-repair (fully repaired)', fullRepairScore.score);
  const partialRepair = mustHaveScore('query-repair (partially repaired)', partialRepairScore.score);
  const fullEfficiencyScore = mustHaveScore('efficiency (fully repaired)', fullEfficiency.score);
  const partialEfficiencyScore = mustHaveScore('efficiency (partially repaired)', partialEfficiency.score);

  assert.ok(
    fullRepair > partialRepair,
    `query-repair should distinguish repaired from unrepaired failures; full=${fullRepair} partial=${partialRepair}`,
  );
  assert.ok(
    fullEfficiencyScore > partialEfficiencyScore,
    `efficiency should reward repaired failures; full=${fullEfficiencyScore} partial=${partialEfficiencyScore}`,
  );

  console.log('query scoring regression checks passed');
}

await main();
