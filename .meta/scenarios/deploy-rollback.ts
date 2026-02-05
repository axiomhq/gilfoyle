/**
 * Scenario: Bad Deploy Causes 500s
 *
 * API errors spike after deploy. Root cause: config change broke DB connection.
 */

import type { IncidentScenario } from '../harness/types.js';

export const deployRollbackScenario: IncidentScenario = {
  id: 'deploy-rollback',
  name: 'Bad deploy causes 500 errors',
  description: 'Error rate spiked 10x after v2.3.1 deploy. Config change broke DB pool settings.',

  prompt: `Alert: 500 error rate on orders-api jumped from 0.1% to 12% at 15:42 UTC.
This started 3 minutes after the v2.3.1 deploy.
Investigate and find the root cause.`,

  initOutput: `Gilfoyle Environment Discovery
==============================

Axiom Environments:
  prod:
    datasets: [app-logs, k8s-events, deploy-logs]

Grafana Environments:
  prod:
    datasources: [prometheus-prod (uid: prom-prod)]

Slack:
  Available (workspace: acme)
`,

  toolMocks: {
    axiom: [
      {
        when: { contains: ['error', '500'] },
        return: {
          rows: [
            { _time: '2026-02-06T15:42:15Z', level: 'error', service: 'orders-api', message: 'connection pool exhausted', status: 500 },
            { _time: '2026-02-06T15:42:18Z', level: 'error', service: 'orders-api', message: 'dial tcp: connection refused', status: 500 },
            { _time: '2026-02-06T15:42:22Z', level: 'error', service: 'orders-api', message: 'connection pool exhausted', status: 500 },
          ],
        },
      },
      {
        when: { contains: ['deploy', 'v2.3'] },
        return: {
          rows: [
            { _time: '2026-02-06T15:39:00Z', event: 'deploy_started', version: 'v2.3.1', user: 'ci-bot' },
            { _time: '2026-02-06T15:41:30Z', event: 'deploy_completed', version: 'v2.3.1', replicas: 5 },
            { _time: '2026-02-06T15:39:00Z', config_diff: 'DB_POOL_SIZE: 20 -> 2, DB_TIMEOUT: 30s -> 5s' },
          ],
        },
      },
      {
        when: { contains: ['config', 'pool'] },
        return: {
          rows: [
            { _time: '2026-02-06T15:41:35Z', service: 'orders-api', config: { DB_POOL_SIZE: 2, DB_TIMEOUT: '5s' } },
            { _time: '2026-02-06T15:30:00Z', service: 'orders-api', config: { DB_POOL_SIZE: 20, DB_TIMEOUT: '30s' } },
          ],
        },
      },
      {
        when: { contains: ['spotlight'] },
        return: {
          spotlight: {
            dimension: 'version',
            delta_score: 0.95,
            differences: [
              { value: 'v2.3.1', frequency_ratio: 1.0, comparison_count: 0, problem_count: 847 },
            ],
          },
        },
      },
    ],
    grafana: [
      {
        when: { contains: ['http_requests', 'status'] },
        return: {
          series: [
            { metric: 'http_requests_total{status="500"}', values: [[1738853400, 12], [1738853460, 89], [1738853520, 234]] },
            { metric: 'http_requests_total{status="200"}', values: [[1738853400, 1847], [1738853460, 1203], [1738853520, 892]] },
          ],
        },
      },
      {
        when: { contains: ['connection', 'pool'] },
        return: {
          series: [
            { metric: 'db_pool_active_connections', values: [[1738853400, 18], [1738853460, 2], [1738853520, 2]] },
            { metric: 'db_pool_waiting_requests', values: [[1738853400, 0], [1738853460, 45], [1738853520, 123]] },
          ],
        },
      },
    ],
    slack: [
      {
        when: { contains: ['chat.postMessage'] },
        return: { ok: true, ts: '1738853700.000100' },
      },
    ],
  },

  expected: {
    rootCauseMustMention: ['deploy', 'config', 'pool'],
    rootCauseMustNotMention: ['DDoS', 'network', 'memory'],
    requiredEvidence: [
      { tool: 'scripts/axiom-query', mustMention: ['deploy', 'config'] },
    ],
  },

  budgets: {
    maxToolCalls: 12,
    maxTotalTokens: 10000,
  },
};
