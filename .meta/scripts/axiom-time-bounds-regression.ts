import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { AxiomTimeBoundsScorer } from '../scorers/axiom-time-bounds.js';
import type { EvalInput, EvalOutput, ToolCall } from '../harness/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_TOOL_PATH = join(__dirname, '../toolbox/mock-tool.ts');

const scenario = {
  id: 'axiom-time-bounds-regression',
  name: 'axiom-time-bounds-regression',
  description: 'Regression harness for explicit _time enforcement in Gilfoyle eval tooling',
  prompt: 'investigate',
  initOutput: 'mock init',
  discoveryOutputs: {
    axiom: 'Deployments:\n- prod: app-logs',
  },
  toolMocks: {},
  fixtures: {
    datasets: {
      'app-logs': [
        {
          _time: '2026-03-06T10:00:00Z',
          level: 'info',
          message: 'request completed',
          trace_id: 'fe9cef1c916f45af2116f0616e2332f2',
        },
      ],
    },
    metrics: {},
    datasources: [],
    validDeployments: ['prod'],
  },
  expected: {
    rootCauseMustMention: ['regression'],
    requiredEvidence: [],
  },
};

function buildScorerArgs(toolCalls: ToolCall[]): {
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
} {
  return {
    input: {
      scenario: {
        ...scenario,
        scoring: {},
      },
      config: {
        harness: 'amp',
      },
    },
    output: {
      trace: {
        finalText: 'done',
        toolCalls,
        elapsedMs: 100,
      },
      rootCause: 'regression',
      evidence: [],
    },
    expected: {
      rootCause: 'regression',
      evidence: [],
    },
  };
}

async function main(): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'gilfoyle-time-bounds-'));
  const scenarioFile = join(tempDir, 'scenario.json');
  writeFileSync(scenarioFile, JSON.stringify(scenario));

  const env = {
    ...process.env,
    GILFOYLE_SCENARIO_FILE: scenarioFile,
  };

  try {
    const discover = spawnSync('bun', [MOCK_TOOL_PATH, 'scripts-discover-axiom'], {
      encoding: 'utf-8',
      env,
    });
    assert.equal(discover.status, 0, discover.stderr || discover.stdout);

    const unboundedSchema = spawnSync('bun', [MOCK_TOOL_PATH, 'scripts-axiom-query', 'prod'], {
      encoding: 'utf-8',
      input: "['app-logs'] | getschema",
      env,
    });
    assert.notEqual(
      unboundedSchema.status,
      0,
      'bare getschema should be rejected by the eval mock tool because it lacks an explicit _time bound',
    );
    assert.match(
      unboundedSchema.stderr,
      /explicit _time bound/i,
      `expected explicit _time error, got: ${unboundedSchema.stderr || unboundedSchema.stdout}`,
    );

    const boundedSchema = spawnSync('bun', [MOCK_TOOL_PATH, 'scripts-axiom-query', 'prod'], {
      encoding: 'utf-8',
      input: "['app-logs'] | where _time > ago(15m) | getschema",
      env,
    });
    assert.equal(boundedSchema.status, 0, boundedSchema.stderr || boundedSchema.stdout);

    const idOnlyQuery = spawnSync('bun', [MOCK_TOOL_PATH, 'scripts-axiom-query', 'prod'], {
      encoding: 'utf-8',
      input: "['app-logs'] | where trace_id == 'fe9cef1c916f45af2116f0616e2332f2' | project _time",
      env,
    });
    assert.notEqual(
      idOnlyQuery.status,
      0,
      'trace_id-only queries should be rejected by the eval mock tool because they lack an explicit _time bound',
    );
    assert.match(
      idOnlyQuery.stderr,
      /explicit _time bound/i,
      `expected explicit _time error, got: ${idOnlyQuery.stderr || idOnlyQuery.stdout}`,
    );

    const unboundedScore = await AxiomTimeBoundsScorer(buildScorerArgs([
      {
        tool: 'scripts/axiom-query',
        input: `/tmp/scripts/axiom-query prod <<< "['app-logs'] | getschema"`,
        output: boundedSchema.stdout,
      },
    ]));
    assert.equal(unboundedScore.score, 0, `expected scorer to fail bare getschema, got ${unboundedScore.score}`);

    const boundedScore = await AxiomTimeBoundsScorer(buildScorerArgs([
      {
        tool: 'scripts/axiom-query',
        input: `/tmp/scripts/axiom-query prod <<< "['app-logs'] | where _time > ago(15m) | getschema"`,
        output: boundedSchema.stdout,
      },
    ]));
    assert.equal(boundedScore.score, 1, `expected scorer to accept bounded getschema, got ${boundedScore.score}`);

    console.log('axiom time-bound regression checks passed');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
