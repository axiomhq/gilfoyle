import type { IncidentScenario } from '../harness/types.js';

/**
 * DB Pool Exhaustion Scenario — Fixture-Driven
 *
 * The agent must:
 * 1. Init → discover datasets and datasources
 * 2. Query app-logs for errors → see pool exhaustion, payment failures
 * 3. Notice pattern: errors concentrate in processPayment handler
 * 4. See gradual pool leak (active connections climb, never release)
 * 5. Find connection acquire without release in error paths
 * 6. Conclude: connection leak in processPayment error handling
 *
 * Critically: the data shows the *symptoms* (pool at max, waiting requests,
 * errors from one handler) — the agent must infer the *mechanism* (conn leak).
 */

export const dbPoolExhaustionScenario: IncidentScenario = {
  id: 'db-pool-exhaustion',
  name: 'DB connection pool leak in payment handler',
  description: 'DB connections at max, requests queuing. Connection leak in error path.',
  prompt: `Alert: Database connection pool at 100% capacity in prod.
Requests queuing, p95 latency > 30s on payment endpoints.
No recent deploys. Started gradually over the last 2 hours.
Investigate and find the root cause.`,
  initOutput: `Gilfoyle Environment Discovery
==============================

Axiom Environments:
  prod:
    datasets: [app-logs, db-logs, k8s-events]

Grafana Environments:
  prod:
    datasources: [prometheus-prod (uid: prom-prod)]

Slack:
  Available (workspace: acme)
`,
  toolMocks: {},
  fixtures: {
    validDeployments: ['prod'],
    datasources: [
      { uid: 'prom-prod', name: 'prometheus-prod', type: 'prometheus' },
    ],
    datasets: {
      'app-logs': [
        // Normal traffic, then growing problems
        { _time: '2026-02-06T14:00:00Z', level: 'info', service: 'payment-service', handler: 'processPayment', message: 'payment completed', status: 200, latency_ms: 120 },
        { _time: '2026-02-06T14:00:05Z', level: 'error', service: 'payment-service', handler: 'processPayment', message: 'payment processing failed', error: 'insufficient funds', status: 400, latency_ms: 85 },
        { _time: '2026-02-06T14:10:00Z', level: 'info', service: 'payment-service', handler: 'processPayment', message: 'payment completed', status: 200, latency_ms: 130 },
        { _time: '2026-02-06T14:15:00Z', level: 'error', service: 'payment-service', handler: 'processPayment', message: 'payment processing failed', error: 'card declined', status: 400, latency_ms: 92 },
        { _time: '2026-02-06T14:30:00Z', level: 'warn', service: 'payment-service', handler: 'processPayment', message: 'db pool connection wait time elevated', pool_wait_ms: 2500, pool_active: 38, pool_max: 50 },
        { _time: '2026-02-06T14:45:00Z', level: 'warn', service: 'payment-service', handler: 'processPayment', message: 'db pool connection wait time elevated', pool_wait_ms: 8200, pool_active: 45, pool_max: 50 },
        { _time: '2026-02-06T15:00:00Z', level: 'error', service: 'payment-service', handler: 'processPayment', message: 'db connection pool exhausted', pool_active: 50, pool_max: 50, pool_waiting: 12, latency_ms: 30000 },
        { _time: '2026-02-06T15:05:00Z', level: 'error', service: 'payment-service', handler: 'processPayment', message: 'db connection pool exhausted', pool_active: 50, pool_max: 50, pool_waiting: 28, latency_ms: 30000 },
        { _time: '2026-02-06T15:10:00Z', level: 'error', service: 'payment-service', handler: 'processPayment', message: 'db connection pool exhausted', pool_active: 50, pool_max: 50, pool_waiting: 45, latency_ms: 30000 },
        { _time: '2026-02-06T15:15:00Z', level: 'error', service: 'payment-service', handler: 'processPayment', message: 'db connection pool exhausted', pool_active: 50, pool_max: 50, pool_waiting: 67, latency_ms: 30000 },
        // Other services are fine
        { _time: '2026-02-06T15:00:00Z', level: 'info', service: 'user-service', handler: 'getUser', message: 'request completed', status: 200, latency_ms: 35 },
        { _time: '2026-02-06T15:05:00Z', level: 'info', service: 'order-service', handler: 'listOrders', message: 'request completed', status: 200, latency_ms: 42 },
        { _time: '2026-02-06T15:10:00Z', level: 'info', service: 'user-service', handler: 'getUser', message: 'request completed', status: 200, latency_ms: 38 },
      ],
      'db-logs': [
        { _time: '2026-02-06T14:00:00Z', level: 'info', instance: 'pg-primary', message: 'connection stats', active_connections: 22, idle_connections: 8, max_connections: 100 },
        { _time: '2026-02-06T14:15:00Z', level: 'info', instance: 'pg-primary', message: 'connection stats', active_connections: 35, idle_connections: 5, max_connections: 100 },
        { _time: '2026-02-06T14:30:00Z', level: 'info', instance: 'pg-primary', message: 'connection stats', active_connections: 48, idle_connections: 2, max_connections: 100 },
        { _time: '2026-02-06T14:30:05Z', level: 'info', instance: 'pg-primary', message: 'connection age analysis', client: 'payment-service', avg_conn_age_seconds: 3420, max_conn_age_seconds: 7200, connections_held: 38, connections_returned: 0 },
        { _time: '2026-02-06T14:45:00Z', level: 'warn', instance: 'pg-primary', message: 'long-held connections detected', client: 'payment-service', connections_older_than_30m: 32, connections_older_than_1h: 18 },
        { _time: '2026-02-06T15:00:00Z', level: 'warn', instance: 'pg-primary', message: 'connection stats', active_connections: 62, idle_connections: 0, max_connections: 100 },
        { _time: '2026-02-06T15:00:05Z', level: 'warn', instance: 'pg-primary', message: 'connection age analysis', client: 'payment-service', avg_conn_age_seconds: 5400, max_conn_age_seconds: 7200, connections_held: 50, connections_returned: 0 },
        { _time: '2026-02-06T15:15:00Z', level: 'error', instance: 'pg-primary', message: 'connection limit approaching', active_connections: 78, max_connections: 100 },
      ],
      'k8s-events': [
        { _time: '2026-02-06T15:10:00Z', level: 'warn', namespace: 'default', kind: 'Pod', name: 'payment-service-abc', reason: 'Unhealthy', message: 'Liveness probe failed: context deadline exceeded' },
      ],
    },
    metrics: {
      'db_pool_active_connections': [
        {
          metric: 'db_pool_active_connections',
          labels: { service: 'payment-service' },
          values: [
            [1738850400, 12],   // 14:00
            [1738851000, 22],   // 14:10
            [1738851600, 32],   // 14:20
            [1738852200, 38],   // 14:30
            [1738852800, 45],   // 14:40
            [1738853400, 50],   // 14:50
            [1738854000, 50],   // 15:00
            [1738854600, 50],   // 15:10
          ],
        },
        {
          metric: 'db_pool_active_connections',
          labels: { service: 'user-service' },
          values: [
            [1738850400, 3],
            [1738851000, 4],
            [1738852200, 3],
            [1738853400, 4],
            [1738854000, 3],
          ],
        },
        {
          metric: 'db_pool_active_connections',
          labels: { service: 'order-service' },
          values: [
            [1738850400, 5],
            [1738851000, 6],
            [1738852200, 5],
            [1738853400, 6],
            [1738854000, 5],
          ],
        },
      ],
      'db_pool_max_connections': [
        {
          metric: 'db_pool_max_connections',
          labels: { service: 'payment-service' },
          values: [
            [1738850400, 50],
            [1738854000, 50],
          ],
        },
      ],
      'db_pool_waiting_requests': [
        {
          metric: 'db_pool_waiting_requests',
          labels: { service: 'payment-service' },
          values: [
            [1738850400, 0],
            [1738851000, 0],
            [1738852200, 0],
            [1738853400, 5],
            [1738854000, 28],
            [1738854600, 67],
          ],
        },
      ],
      'http_request_duration_seconds': [
        {
          metric: 'http_request_duration_seconds',
          labels: { service: 'payment-service', handler: 'processPayment', quantile: '0.95' },
          values: [
            [1738850400, 0.15],
            [1738851000, 0.18],
            [1738852200, 2.5],
            [1738853400, 15.0],
            [1738854000, 30.0],
          ],
        },
        {
          metric: 'http_request_duration_seconds',
          labels: { service: 'user-service', handler: 'getUser', quantile: '0.95' },
          values: [
            [1738850400, 0.035],
            [1738851000, 0.038],
            [1738852200, 0.036],
            [1738854000, 0.040],
          ],
        },
      ],
    },
  },
  expected: {
    rootCauseMustMention: ['connection', 'leak', 'payment'],
    rootCauseMustNotMention: ['DDoS', 'network', 'CPU'],
    requiredEvidence: [
      { tool: 'scripts/axiom-query', mustMention: ['payment', 'pool'] },
    ],
    requiredQueries: [
      {
        tool: 'scripts/axiom-query',
        mustMatch: "\\['app-logs'\\]|\\['db-logs'\\]",
        description: 'Must query app-logs or db-logs to find pool exhaustion evidence',
      },
      {
        tool: 'scripts/grafana-query',
        mustMatch: 'db_pool',
        description: 'Must query db pool metrics to see the leak pattern',
      },
    ],
  },
  budgets: {
    maxToolCalls: 15,
    maxTotalTokens: 12000,
  },
};
