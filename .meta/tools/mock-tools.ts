/**
 * Mock Tool Router
 *
 * Routes tool calls to mocked responses based on scenario definitions.
 * Used by all harnesses to ensure deterministic, reproducible evals.
 */

import type { IncidentScenario, ToolCall, ToolMock, ToolName, RunTrace } from '../harness/types.js';

export interface MockToolRouter {
  call(tool: ToolName, input: unknown): Promise<unknown>;
  getTrace(): ToolCall[];
}

export function createMockTools(scenario: IncidentScenario): MockToolRouter {
  const trace: ToolCall[] = [];

  function matchMock(mocks: ToolMock[] | undefined, queryText: string): unknown {
    if (!mocks || mocks.length === 0) {
      return { error: 'No mock configured for this query', hint: 'Check scenario toolMocks' };
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
      hint: 'Try querying for: ' + (mocks[0]?.when.contains?.join(', ') ?? 'unknown'),
    };
  }

  async function call(tool: ToolName, input: unknown): Promise<unknown> {
    const start = Date.now();
    let output: unknown;
    let error: string | undefined;

    try {
      switch (tool) {
        case 'scripts/init':
          output = scenario.initOutput;
          break;

        case 'scripts/axiom-query': {
          const { query } = input as { env?: string; query: string };
          output = matchMock(scenario.toolMocks.axiom, query);
          break;
        }

        case 'scripts/grafana-query': {
          const { promql } = input as { env?: string; datasource?: string; promql: string };
          output = matchMock(scenario.toolMocks.grafana, promql);
          break;
        }

        case 'scripts/slack': {
          const { method } = input as { method: string; args?: Record<string, string> };
          output = matchMock(scenario.toolMocks.slack, method);
          break;
        }

        case 'scripts/mem-write':
          output = { ok: true };
          break;

        default:
          error = `Unknown tool: ${tool}`;
          output = { error };
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      output = { error };
    }

    trace.push({
      tool,
      input,
      output,
      error,
      durationMs: Date.now() - start,
    });

    return output;
  }

  return {
    call,
    getTrace: () => trace,
  };
}
