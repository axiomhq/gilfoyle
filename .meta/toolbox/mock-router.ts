/**
 * Mock Tool Router (fixture-aware)
 *
 * Routes tool calls through the fixture engine when available,
 * falls back to legacy keyword matching for scenarios without fixtures.
 * The old mock-tools.ts is dead. Long live the fixture engine.
 */

import type {
  IncidentScenario,
  ToolCall,
  ToolMock,
  ToolName,
} from '../harness/types.js';

import {
  validateAPL,
  executeAPL,
  formatAxiomOutput,
  validatePromQL,
  executePromQL,
  formatGrafanaOutput,
  validateAxiomCLI,
  validateGrafanaCLI,
} from './fixture-engine.js';

export interface MockToolRouter {
  call(tool: ToolName, input: unknown): Promise<unknown>;
  getTrace(): ToolCall[];
}

export function createMockRouter(scenario: IncidentScenario): MockToolRouter {
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
      hint: `Try querying for: ${mocks[0]?.when.contains?.join(', ') ?? 'unknown'}`,
    };
  }

  async function call(tool: ToolName, input: unknown): Promise<unknown> {
    const start = Date.now();
    let output: unknown;
    let error: string | undefined;
    let queryValid: boolean | undefined;
    let queryErrors: string[] | undefined;

    try {
      switch (tool) {
        case 'scripts/init':
          output = scenario.initOutput;
          break;

        case 'scripts/axiom-query': {
          const { env, query } = input as { env?: string; query: string };

          if (scenario.fixtures) {
            const cliVal = validateAxiomCLI([env ?? 'prod'], query, scenario.fixtures);
            const aplVal = validateAPL(query, scenario.fixtures);

            if (!cliVal.valid || !aplVal.valid) {
              queryValid = false;
              queryErrors = [...cliVal.errors, ...aplVal.errors];
              output = { error: 'Query validation failed', errors: queryErrors };
              break;
            }

            queryValid = true;
            const rows = executeAPL(aplVal.parsed!, scenario.fixtures);
            const totalRows = scenario.fixtures.datasets[aplVal.parsed!.dataset]?.length ?? 0;
            output = formatAxiomOutput(rows, totalRows);
          } else {
            output = matchMock(scenario.toolMocks.axiom, query);
          }
          break;
        }

        case 'scripts/grafana-query': {
          const { env, datasource, promql } = input as {
            env?: string;
            datasource?: string;
            promql: string;
          };

          if (scenario.fixtures) {
            const args = [env ?? 'prod', datasource ?? 'prom-prod', promql];
            const cliVal = validateGrafanaCLI(args, scenario.fixtures);
            const promVal = validatePromQL(promql, scenario.fixtures);

            if (!cliVal.valid || !promVal.valid) {
              queryValid = false;
              queryErrors = [...cliVal.errors, ...promVal.errors];
              output = { error: 'Query validation failed', errors: queryErrors };
              break;
            }

            queryValid = true;
            const series = executePromQL(promql, scenario.fixtures);
            output = formatGrafanaOutput(
              series,
              cliVal.deployment!,
              cliVal.datasourceUid!,
              promql,
            );
          } else {
            output = matchMock(scenario.toolMocks.grafana, promql);
          }
          break;
        }

        case 'scripts/slack':
          output = { ok: true, ts: new Date().toISOString() };
          break;

        case 'scripts/mem-write':
          output = { ok: true };
          break;

        case 'scripts/rollback': {
          const { service, version } = input as { service?: string; version?: string };
          output = {
            ok: true,
            rolled_back_to: version ?? 'previous',
            service: service ?? 'unknown',
            message: `Rolled back ${service ?? 'service'} to ${version ?? 'previous version'}`,
          };
          break;
        }

        case 'scripts/flag-revert': {
          const { flag } = input as { flag?: string };
          output = {
            ok: true,
            reverted: flag ?? 'unknown',
            message: `Reverted feature flag: ${flag ?? 'unknown'}`,
          };
          break;
        }

        case 'scripts/axiom-link': {
          const { query, range } = input as { query?: string; range?: string };
          const encodedQuery = encodeURIComponent(query ?? '');
          output = `https://app.axiom.co/acme/explorer?q=${encodedQuery}&t=${range ?? '1h'}`;
          break;
        }

        default:
          error = `Unknown tool: ${tool}`;
          output = { error };
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      output = { error };
    }

    const entry: ToolCall = {
      tool,
      input,
      output,
      durationMs: Date.now() - start,
    };
    if (error) entry.error = error;
    if (queryValid !== undefined) entry.queryValid = queryValid;
    if (queryErrors) entry.queryErrors = queryErrors;

    trace.push(entry);
    return output;
  }

  return {
    call,
    getTrace: () => trace,
  };
}
