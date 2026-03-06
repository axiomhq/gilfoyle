import assert from 'node:assert/strict';
import { EfficiencyScorer } from '../scorers/efficiency.js';
import { QueryRepairScorer } from '../scorers/query-repair.js';
import { QueryValidityScorer } from '../scorers/query-validity.js';
import type { EvalInput, EvalOutput, ToolCall } from '../harness/types.js';
import { validateAxiomCLI } from '../toolbox/fixture-engine.js';

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

  // Regression #2: validateAxiomCLI must enforce wrapper time windows.
  const fixtures = {
    datasets: { 'app-logs': [{ _time: '2026-03-06T10:05:00Z', message: 'ok' }] },
    metrics: {},
    datasources: [],
    validDeployments: ['prod'],
  };

  const missingWindow = validateAxiomCLI(['prod'], "['app-logs'] | getschema", fixtures);
  const relativeWindow = validateAxiomCLI(['prod', '--since', '15m'], "['app-logs'] | getschema", fixtures);
  const absoluteWindow = validateAxiomCLI(
    ['prod', '--from', '2026-03-06T10:00:00Z', '--to', '2026-03-06T10:30:00Z'],
    "['app-logs'] | getschema",
    fixtures,
  );
  const mixedWindow = validateAxiomCLI(
    ['prod', '--since', '15m', '--from', '2026-03-06T10:00:00Z', '--to', '2026-03-06T10:30:00Z'],
    "['app-logs'] | getschema",
    fixtures,
  );
  const inlineTimeOnly = validateAxiomCLI(['prod'], "['app-logs'] | where _time > ago(15m) | getschema", fixtures);

  assert.equal(missingWindow.valid, false, 'validateAxiomCLI should reject missing time windows');
  assert.equal(relativeWindow.valid, true, 'validateAxiomCLI should accept --since windows');
  assert.equal(relativeWindow.startTime, 'now-15m', 'validateAxiomCLI should derive startTime from --since');
  assert.equal(relativeWindow.endTime, 'now', 'validateAxiomCLI should derive endTime for --since windows');
  assert.equal(absoluteWindow.valid, true, 'validateAxiomCLI should accept --from/--to windows');
  assert.equal(mixedWindow.valid, false, 'validateAxiomCLI should reject mixed relative and absolute windows');
  assert.equal(inlineTimeOnly.valid, false, 'validateAxiomCLI should not treat inline _time as a wrapper window');

  const missingWindowValidity = await QueryValidityScorer(buildArgs([
    {
      tool: 'scripts/axiom-query',
      input: "scripts/axiom-query prod <<< \"['app-logs'] | getschema\"",
      output: 'error: Missing time window. Pass --since <duration> or --from <timestamp> --to <timestamp>.',
      queryValid: false,
      queryErrors: ['Missing time window. Pass --since <duration> or --from <timestamp> --to <timestamp>.'],
    },
  ]));
  const boundedWindowValidity = await QueryValidityScorer(buildArgs([
    {
      tool: 'scripts/axiom-query',
      input: "scripts/axiom-query prod --since 15m <<< \"['app-logs'] | getschema\"",
      output: '# 1/1 rows, 10ms',
      queryValid: true,
    },
  ]));
  const missingWindowValidityScore = mustHaveScore('query-validity (missing window)', missingWindowValidity.score);
  const boundedWindowValidityScore = mustHaveScore('query-validity (bounded window)', boundedWindowValidity.score);

  assert.ok(
    missingWindowValidityScore < boundedWindowValidityScore,
    `query-validity should penalize missing wrapper windows; missing=${missingWindowValidityScore} bounded=${boundedWindowValidityScore}`,
  );

  // Regression #3: with identical failure-rate, repaired failures should
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
