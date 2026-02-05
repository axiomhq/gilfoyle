#!/usr/bin/env bun
/**
 * Universal Mock Tool for Eval Harness
 *
 * Single script that handles all mocked tools. Symlink with different names:
 *   ln -s mock-tool.ts scripts-init
 *   ln -s mock-tool.ts scripts-axiom-query
 *   etc.
 *
 * The script checks its own name to determine which tool it's being called as.
 * Reads scenario from GILFOYLE_SCENARIO_FILE env var.
 */

import { readFileSync } from 'fs';
import { basename } from 'path';

// Tool name passed as first argument or via MOCK_TOOL_NAME env
const scriptName = process.argv[2] ?? process.env.MOCK_TOOL_NAME ?? 'unknown';
const action = process.env.TOOLBOX_ACTION;

// Tool definitions for describe phase
const TOOLS: Record<string, { description: string; args?: string[] }> = {
  'scripts-init': {
    description: 'Run scripts/init to discover available environments and datasets. MUST be called first.',
  },
  'scripts-axiom-query': {
    description: 'Query Axiom logs using APL syntax.',
    args: ['env: string environment name (e.g., prod, staging)', 'query: string APL query string'],
  },
  'scripts-grafana-query': {
    description: 'Query Grafana Prometheus datasource with PromQL.',
    args: ['env: string environment name', 'datasource: string datasource UID', 'promql: string PromQL query'],
  },
  'scripts-slack': {
    description: 'Call Slack API method.',
    args: ['method: string Slack API method (e.g., chat.postMessage)', 'args: object method arguments'],
  },
  'scripts-mem-write': {
    description: 'Write to memory.',
    args: ['category: string (facts, patterns, queries, incidents)', 'key: string key name', 'value: string value to write'],
  },
};

// Handle describe phase
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

try {
  const scenario: Scenario = JSON.parse(readFileSync(scenarioFile, 'utf-8'));

  switch (scriptName) {
    case 'scripts-init':
      console.log(scenario.initOutput);
      break;

    case 'scripts-axiom-query': {
      const query = process.env.TOOLBOX_ARG_query ?? '';
      console.log(JSON.stringify(matchMock(scenario.toolMocks.axiom, query), null, 2));
      break;
    }

    case 'scripts-grafana-query': {
      const promql = process.env.TOOLBOX_ARG_promql ?? '';
      console.log(JSON.stringify(matchMock(scenario.toolMocks.grafana, promql), null, 2));
      break;
    }

    case 'scripts-slack': {
      const method = process.env.TOOLBOX_ARG_method ?? '';
      console.log(JSON.stringify(matchMock(scenario.toolMocks.slack, method), null, 2));
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
