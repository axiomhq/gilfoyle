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
  const discoveredTools = new Set<string>();

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

        case 'scripts/discover-axiom':
          discoveredTools.add('axiom');
          output = scenario.discoveryOutputs?.axiom ?? 'No Axiom deployments configured.';
          break;

        case 'scripts/discover-grafana':
          discoveredTools.add('grafana');
          output = scenario.discoveryOutputs?.grafana ?? 'No Grafana deployments configured.';
          break;

        case 'scripts/discover-pyroscope':
          output = scenario.discoveryOutputs?.pyroscope ?? 'No Pyroscope deployments configured.';
          break;

        case 'scripts/discover-k8s':
          output = scenario.discoveryOutputs?.k8s ?? 'No Kubernetes contexts found.';
          break;

        case 'scripts/discover-slack':
          output = scenario.discoveryOutputs?.slack ?? 'No Slack workspaces configured.';
          break;

        case 'scripts/axiom-query': {
          if (!discoveredTools.has('axiom')) {
            error = 'scripts/axiom-query called before scripts/discover-axiom. Run scripts/discover-axiom first to learn available datasets. Querying without discovery violates Golden Rule #9.';
            output = { error };
            break;
          }
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
          if (!discoveredTools.has('grafana')) {
            error = 'scripts/grafana-query called before scripts/discover-grafana. Run scripts/discover-grafana first to learn available datasources and UIDs. Querying without discovery violates Golden Rule #9.';
            output = { error };
            break;
          }
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
          output = `https://app.axiom.co/acme/query?q=${encodedQuery}&t=${range ?? '1h'}`;
          break;
        }

        case 'scripts/grafana-link': {
          const { datasource, query, range } = input as { env?: string; datasource?: string; query?: string; range?: string };
          const ds = datasource ?? 'prometheus';
          const panes = JSON.stringify({ a: { datasource: ds, queries: [{ refId: 'A', expr: query ?? '', datasource: { uid: ds } }], range: { from: `now-${range ?? '1h'}`, to: 'now' } } });
          output = `https://grafana.acme.co/explore?schemaVersion=1&panes=${encodeURIComponent(panes)}&orgId=1`;
          break;
        }

        case 'scripts/pyroscope-link': {
          const { query: pQuery, range: pRange } = input as { query?: string; range?: string };
          const encodedPQuery = encodeURIComponent(pQuery ?? '');
          output = `https://pyroscope.acme.co/?query=${encodedPQuery}&from=now-${pRange ?? '1h'}&until=now`;
          break;
        }

        case 'scripts/sentry-link': {
          const { path: sPath } = input as { path?: string };
          const cleanPath = (sPath ?? '').replace(/^\//, '');
          output = `https://sentry.acme.co/${cleanPath}`;
          break;
        }

        case 'gh_repo_clone': {
          const { repo } = input as { repo?: string };
          output = `Cloned ${repo ?? 'unknown'} to /tmp/${(repo ?? 'repo').split('/').pop()}`;
          break;
        }

        case 'git_log': {
          const { file } = input as { file?: string; args?: string };
          if (scenario.fixtures?.gitLog && file) {
            const entries = scenario.fixtures.gitLog[file];
            if (entries) {
              output = entries.map(e =>
                `${e.sha.slice(0, 7)} ${e.date} ${e.author} ${e.message}`
              ).join('\n');
            } else {
              output = `fatal: no such file: ${file}`;
            }
          } else {
            output = 'No git history available in fixtures';
          }
          break;
        }

        case 'git_blame': {
          const { file } = input as { file?: string };
          if (scenario.fixtures?.gitBlame && file) {
            const entries = scenario.fixtures.gitBlame[file];
            if (entries) {
              output = entries.map(e =>
                `${e.sha.slice(0, 7)} (${e.author} ${e.date}) ${e.lineStart}-${e.lineEnd}: ${e.content}`
              ).join('\n');
            } else {
              output = `fatal: no such file: ${file}`;
            }
          } else {
            output = 'No blame data available in fixtures';
          }
          break;
        }

        case 'gh_pr_view': {
          const { number: prNumber } = input as { number?: string };
          if (scenario.fixtures?.pullRequests && prNumber) {
            const pr = scenario.fixtures.pullRequests[prNumber];
            if (pr) {
              output = `#${pr.number} ${pr.title}\n\nAuthor: ${pr.author}\nMerged: ${pr.mergedAt}\nFiles: ${pr.files.join(', ')}\n\n${pr.body}`;
            } else {
              output = `Could not resolve to a PullRequest with the number of ${prNumber}`;
            }
          } else {
            output = 'No PR data available in fixtures';
          }
          break;
        }

        case 'gh_pr_diff': {
          const { number: diffPrNumber } = input as { number?: string };
          if (scenario.fixtures?.pullRequests && diffPrNumber) {
            const pr = scenario.fixtures.pullRequests[diffPrNumber];
            if (pr) {
              output = pr.diff;
            } else {
              output = `Could not resolve to a PullRequest with the number of ${diffPrNumber}`;
            }
          } else {
            output = 'No PR diff data available in fixtures';
          }
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
