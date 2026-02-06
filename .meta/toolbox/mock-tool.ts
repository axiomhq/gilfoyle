#!/usr/bin/env bun
/**
 * Universal Mock Tool for Eval Harness
 *
 * Mimics the real gilfoyle scripts interface:
 * - scripts/init: no args, prints discovery output
 * - scripts/axiom-query <env> <<< "query": reads query from stdin
 * - scripts/grafana-query <env> <datasource> <promql>: takes promql as arg
 * - scripts/slack <env> <method> [args...]: takes method as arg
 * - scripts/mem-write <category> <key> <value>: always succeeds
 *
 * Reads scenario from GILFOYLE_SCENARIO_FILE env var.
 */

import { readFileSync } from 'fs';

// Tool name passed as first argument (e.g., "scripts-init")
const scriptName = process.argv[2] ?? 'unknown';
// Remaining args are passed to the tool
const toolArgs = process.argv.slice(3);

const action = process.env.TOOLBOX_ACTION;

// Tool definitions for describe phase (if used as toolbox)
const TOOLS: Record<string, { description: string; args?: string[] }> = {
  'scripts-init': {
    description: 'Run scripts/init to discover available environments and datasets. MUST be called first.',
  },
  'scripts-axiom-query': {
    description: 'Query Axiom logs using APL syntax. Pass env, query comes from stdin.',
    args: ['env: string environment name (e.g., prod, staging)'],
  },
  'scripts-grafana-query': {
    description: 'Query Grafana Prometheus datasource with PromQL.',
    args: ['env: string environment name', 'datasource: string datasource UID', 'promql: string PromQL query'],
  },
  'scripts-slack': {
    description: 'Call Slack API method.',
    args: ['env: string environment', 'method: string Slack API method'],
  },
  'scripts-mem-write': {
    description: 'Write to memory.',
    args: ['category: string', 'key: string', 'value: string'],
  },
};

// Handle describe phase (for toolbox compatibility)
if (action === 'describe') {
  const tool = TOOLS[scriptName];
  if (!tool) {
    console.error(`Unknown tool: ${scriptName}`);
    process.exit(1);
  }
  const lines = [`name: ${scriptName.replace('scripts-', 'scripts/')}`, `description: ${tool.description}`];
  if (tool.args) {
    lines.push(...tool.args);
  }
  process.stdout.write(lines.join('\n'));
  process.exit(0);
}

// Execute phase: load scenario and match mocks
const scenarioFile = process.env.GILFOYLE_SCENARIO_FILE;
if (!scenarioFile) {
  console.log(JSON.stringify({ error: 'GILFOYLE_SCENARIO_FILE not set' }));
  process.exit(1);
}

interface ToolMock {
  when: { contains?: string[]; regex?: string };
  return: unknown;
}

interface Scenario {
  initOutput: string;
  toolMocks: {
    axiom?: ToolMock[];
    grafana?: ToolMock[];
    slack?: ToolMock[];
  };
}

function matchMock(mocks: ToolMock[] | undefined, queryText: string): unknown {
  if (!mocks || mocks.length === 0) {
    return { error: 'No mock configured', hint: 'Check scenario toolMocks' };
  }

  for (const mock of mocks) {
    if (mock.when.contains) {
      const allMatch = mock.when.contains.every((substr) =>
        queryText.toLowerCase().includes(substr.toLowerCase())
      );
      if (allMatch) return mock.return;
    }
    if (mock.when.regex) {
      const re = new RegExp(mock.when.regex, 'i');
      if (re.test(queryText)) return mock.return;
    }
  }

  return {
    error: 'No mock matched query',
    query: queryText.slice(0, 200),
    hint: `Available mocks: ${mocks.map((m) => m.when.contains?.join(', ') ?? m.when.regex).join(' | ')}`,
  };
}

// Read stdin (for axiom-query which gets query via heredoc)
function readStdin(): string {
  try {
    return readFileSync(0, 'utf-8').trim();
  } catch {
    return '';
  }
}

try {
  const scenario: Scenario = JSON.parse(readFileSync(scenarioFile, 'utf-8'));

  switch (scriptName) {
    case 'scripts-init':
      console.log(scenario.initOutput);
      break;

    case 'scripts-axiom-query': {
      // Real usage: scripts/axiom-query prod <<< "query"
      // Query comes from stdin
      const query = readStdin();
      const result = matchMock(scenario.toolMocks.axiom, query);
      console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
      break;
    }

    case 'scripts-grafana-query': {
      // Real usage: scripts/grafana-query prod datasource 'promql'
      // promql is the 3rd arg (toolArgs[2])
      const promql = toolArgs[2] ?? toolArgs.join(' ');
      const result = matchMock(scenario.toolMocks.grafana, promql);
      console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
      break;
    }

    case 'scripts-slack': {
      // Real usage: scripts/slack prod chat.postMessage channel=C123 text="hello"
      // method is the 2nd arg (toolArgs[1])
      const method = toolArgs[1] ?? toolArgs.join(' ');
      const result = matchMock(scenario.toolMocks.slack, method);
      console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
      break;
    }

    case 'scripts-mem-write':
      console.log(JSON.stringify({ ok: true }));
      break;

    default:
      console.log(JSON.stringify({ error: `Unknown tool: ${scriptName}` }));
  }
} catch (e) {
  console.log(JSON.stringify({ error: `Failed: ${e}` }));
  process.exit(1);
}
