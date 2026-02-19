import type { IncidentScenario } from '../harness/types.js';

/**
 * Deploy Rollback Scenario — Fixture-Driven
 *
 * The agent must:
 * 1. Init → discover datasets and datasources
 * 2. See high error rate → query app-logs for 500s
 * 3. Correlate with deploy timing → query deploy-events
 * 4. Find config change → DB_POOL_MAX changed from 20 to 2
 * 5. Confirm via metrics → pool connections dropped
 *
 * Raw data only. No "Analysis:" or "Root cause:" strings.
 */

export const deployRollbackScenario: IncidentScenario = {
  id: 'deploy-rollback',
  name: 'Bad deploy breaks DB connection pool',
  description: 'Deploy changed DB pool config, connections dropped to near-zero.',
  prompt: `Alert: API error rate spiked to 45% in prod after deploy.
500 errors on all /api/* endpoints. Started 3 minutes after deploy v2.14.0.
Investigate and find the root cause.`,
  initOutput: `Gilfoyle Environment Discovery
==============================

Configured tools:
  axiom: prod ✓
  grafana: prod ✓
  slack: acme ✓

Run scripts/discover-<tool> to see available assets before querying.
`,
  discoveryOutputs: {
    axiom: `=== Axiom Deployments ===
deployment: prod
  Top datasets found (3)
  - app-logs
  - deploy-events
  - k8s-events`,
    grafana: `=== Grafana Deployments ===
deployment: prod
  1 datasources found
  - prometheus-prod (prometheus) [uid: prom-prod]`,
    slack: `=== Slack Workspaces ===
workspace: acme
  Connected ✓`,
  },
  toolMocks: {},
  fixtures: {
    validDeployments: ['prod'],
    datasources: [
      { uid: 'prom-prod', name: 'prometheus-prod', type: 'prometheus' },
    ],
    datasets: {
      'app-logs': [
        { _time: '2026-02-06T14:55:00Z', level: 'info', service: 'api-gateway', status: 200, path: '/api/users', latency_ms: 35 },
        { _time: '2026-02-06T14:56:00Z', level: 'info', service: 'api-gateway', status: 200, path: '/api/orders', latency_ms: 42 },
        { _time: '2026-02-06T14:57:00Z', level: 'info', service: 'api-gateway', status: 200, path: '/api/products', latency_ms: 28 },
        { _time: '2026-02-06T15:00:05Z', level: 'info', service: 'api-gateway', message: 'pod restarting after deploy', version: 'v2.14.0' },
        { _time: '2026-02-06T15:00:10Z', level: 'info', service: 'api-gateway', message: 'startup complete', version: 'v2.14.0', config_db_pool_max: 2 },
        { _time: '2026-02-06T15:01:00Z', level: 'warn', service: 'api-gateway', message: 'connection pool at capacity', pool_active: 2, pool_max: 2, pool_waiting: 5 },
        { _time: '2026-02-06T15:02:00Z', level: 'error', service: 'api-gateway', status: 500, path: '/api/users', message: 'connection pool exhausted', error: 'timeout waiting for available connection', latency_ms: 30000 },
        { _time: '2026-02-06T15:02:15Z', level: 'error', service: 'api-gateway', status: 500, path: '/api/orders', message: 'connection pool exhausted', error: 'timeout waiting for available connection', latency_ms: 30000 },
        { _time: '2026-02-06T15:02:30Z', level: 'error', service: 'api-gateway', status: 500, path: '/api/products', message: 'connection pool exhausted', error: 'timeout waiting for available connection', latency_ms: 30000 },
        { _time: '2026-02-06T15:03:00Z', level: 'error', service: 'api-gateway', status: 500, path: '/api/users', message: 'connection pool exhausted', pool_active: 2, pool_max: 2, pool_waiting: 45, latency_ms: 30000 },
        { _time: '2026-02-06T15:03:30Z', level: 'error', service: 'api-gateway', status: 500, path: '/api/payments', message: 'connection pool exhausted', pool_active: 2, pool_max: 2, pool_waiting: 67, latency_ms: 30000 },
        { _time: '2026-02-06T15:04:00Z', level: 'error', service: 'api-gateway', status: 500, path: '/api/users', message: 'connection pool exhausted', pool_active: 2, pool_max: 2, pool_waiting: 123, latency_ms: 30000 },
      ],
      'deploy-events': [
        { _time: '2026-02-06T14:30:00Z', event: 'deploy', version: 'v2.13.2', service: 'api-gateway', user: 'ci-bot', status: 'success', config_changes: 'none' },
        { _time: '2026-02-06T15:00:00Z', event: 'deploy', version: 'v2.14.0', service: 'api-gateway', user: 'ci-bot', status: 'success', commit: 'abc123', author: 'junior-dev' },
        { _time: '2026-02-06T15:00:02Z', event: 'config_change', version: 'v2.14.0', service: 'api-gateway', key: 'DB_POOL_MAX', old_value: '20', new_value: '2', commit: 'abc123', author: 'junior-dev' },
        { _time: '2026-02-06T15:00:03Z', event: 'config_change', version: 'v2.14.0', service: 'api-gateway', key: 'DB_POOL_MIN', old_value: '5', new_value: '1', commit: 'abc123', author: 'junior-dev' },
      ],
      'k8s-events': [
        { _time: '2026-02-06T15:00:00Z', level: 'info', namespace: 'default', kind: 'Deployment', name: 'api-gateway', reason: 'ScalingReplicaSet', message: 'Scaled up replica set api-gateway-v2140 to 3' },
        { _time: '2026-02-06T15:00:05Z', level: 'info', namespace: 'default', kind: 'Pod', name: 'api-gateway-v2140-abc', reason: 'Started', message: 'Started container api-gateway' },
        { _time: '2026-02-06T15:03:00Z', level: 'warn', namespace: 'default', kind: 'Pod', name: 'api-gateway-v2140-abc', reason: 'Unhealthy', message: 'Readiness probe failed: connection refused' },
      ],
    },
    metrics: {
      'http_requests_total': [
        {
          metric: 'http_requests_total',
          labels: { status: '200', service: 'api-gateway' },
          values: [
            [1738853400, 1250],  // 14:50 - normal
            [1738853700, 1340],  // 14:55
            [1738854000, 1280],  // 15:00
            [1738854060, 340],   // 15:01 - drops
            [1738854120, 120],   // 15:02
            [1738854180, 45],    // 15:03
          ],
        },
        {
          metric: 'http_requests_total',
          labels: { status: '500', service: 'api-gateway' },
          values: [
            [1738853400, 2],     // 14:50 - near zero
            [1738853700, 1],     // 14:55
            [1738854000, 0],     // 15:00
            [1738854060, 89],    // 15:01 - starts spiking
            [1738854120, 567],   // 15:02
            [1738854180, 1234],  // 15:03
          ],
        },
      ],
      'db_pool_active_connections': [
        {
          metric: 'db_pool_active_connections',
          labels: { service: 'api-gateway' },
          values: [
            [1738853400, 18],   // 14:50 - normal
            [1738853700, 17],   // 14:55
            [1738854000, 0],    // 15:00 - restart
            [1738854060, 2],    // 15:01 - maxed at 2
            [1738854120, 2],    // 15:02
            [1738854180, 2],    // 15:03
          ],
        },
      ],
      'db_pool_max_connections': [
        {
          metric: 'db_pool_max_connections',
          labels: { service: 'api-gateway' },
          values: [
            [1738853400, 20],   // 14:50 - was 20
            [1738854000, 20],   // 15:00 - still 20 on old pods
            [1738854060, 2],    // 15:01 - new config: 2
            [1738854120, 2],    // 15:02
            [1738854180, 2],    // 15:03
          ],
        },
      ],
      'db_pool_waiting_requests': [
        {
          metric: 'db_pool_waiting_requests',
          labels: { service: 'api-gateway' },
          values: [
            [1738853400, 0],
            [1738853700, 0],
            [1738854000, 0],
            [1738854060, 5],
            [1738854120, 45],
            [1738854180, 123],
          ],
        },
      ],
    },
  },
  expected: {
    rootCauseMustMention: ['deploy', 'pool', 'config'],
    rootCauseMustNotMention: ['DDoS', 'network', 'memory'],
    requiredEvidence: [
      { tool: 'scripts/axiom-query', mustMention: ['deploy', 'pool'] },
    ],
    requiredQueries: [
      {
        tool: 'scripts/axiom-query',
        mustMatch: "\\['deploy-events'\\]|\\['app-logs'\\]",
        description: 'Must query deploy-events or app-logs to find the deploy correlation',
      },
      {
        tool: 'scripts/grafana-query',
        mustMatch: 'db_pool|http_requests',
        description: 'Must query pool or request metrics to see the impact',
      },
    ],
  },
  budgets: {
    maxToolCalls: 14,
    maxTotalTokens: 10000,
    maxElapsedMs: 210_000,
  },
};
