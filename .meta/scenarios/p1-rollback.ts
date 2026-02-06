import type { IncidentScenario } from '../harness/types.js';

/**
 * P1 Rollback Scenario (T09) — Fixture-Driven
 *
 * Tests triage-first behavior under P1 severity.
 *
 * Setup:
 * - Deploy at 14:58 introduces broken auth middleware
 * - 95% of requests return 500 immediately after
 * - Rollback is the correct and obvious mitigation
 *
 * The agent must:
 * 1. Init → discover datasets and datasources
 * 2. Recognize P1 severity → mitigate FIRST (rollback or flag-revert)
 * 3. Announce in Slack before deep investigation
 * 4. Query app-logs → see 500s with "auth middleware" errors
 * 5. Correlate with deploy-events → broken auth middleware in v3.1.0
 * 6. Confirm rollback was the correct call
 */

export const p1RollbackScenario: IncidentScenario = {
  id: 'p1-rollback',
  name: 'P1 — broken auth middleware deploy, 95% 5xx',
  description: 'Deploy introduced broken auth middleware. 95% 500s. Rollback required.',
  severity: 'P1',
  prompt: `P1 ALERT: 95% 5xx error rate on api-gateway in prod.
All authenticated endpoints returning 500. Started immediately after deploy v3.1.0 at 14:58 UTC.
Customer-facing outage. Investigate and mitigate immediately.`,
  initOutput: `Gilfoyle Environment Discovery
==============================

Axiom Environments:
  prod:
    datasets: [app-logs, deploy-events]

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
        { _time: '2026-02-06T14:55:00Z', level: 'info', service: 'api-gateway', message: 'request completed', status: 200, path: '/api/users', latency_ms: 32 },
        { _time: '2026-02-06T14:56:00Z', level: 'info', service: 'api-gateway', message: 'request completed', status: 200, path: '/api/orders', latency_ms: 41 },
        { _time: '2026-02-06T14:57:00Z', level: 'info', service: 'api-gateway', message: 'request completed', status: 200, path: '/api/products', latency_ms: 27 },
        { _time: '2026-02-06T14:58:05Z', level: 'info', service: 'api-gateway', message: 'pod restarting after deploy', version: 'v3.1.0' },
        { _time: '2026-02-06T14:58:10Z', level: 'info', service: 'api-gateway', message: 'startup complete', version: 'v3.1.0' },
        { _time: '2026-02-06T14:58:15Z', level: 'error', service: 'api-gateway', message: 'auth middleware threw unhandled exception', status: 500, path: '/api/users', error: 'TypeError: Cannot read properties of undefined (reading \'verify\')', stack: 'at AuthMiddleware.handle (auth.js:42)' },
        { _time: '2026-02-06T14:58:16Z', level: 'error', service: 'api-gateway', message: 'auth middleware threw unhandled exception', status: 500, path: '/api/orders', error: 'TypeError: Cannot read properties of undefined (reading \'verify\')', stack: 'at AuthMiddleware.handle (auth.js:42)' },
        { _time: '2026-02-06T14:58:17Z', level: 'error', service: 'api-gateway', message: 'auth middleware threw unhandled exception', status: 500, path: '/api/products', error: 'TypeError: Cannot read properties of undefined (reading \'verify\')', stack: 'at AuthMiddleware.handle (auth.js:42)' },
        { _time: '2026-02-06T14:58:20Z', level: 'error', service: 'api-gateway', message: 'auth middleware threw unhandled exception', status: 500, path: '/api/users', error: 'TypeError: Cannot read properties of undefined (reading \'verify\')' },
        { _time: '2026-02-06T14:58:25Z', level: 'error', service: 'api-gateway', message: 'auth middleware threw unhandled exception', status: 500, path: '/api/payments', error: 'TypeError: Cannot read properties of undefined (reading \'verify\')' },
        { _time: '2026-02-06T14:58:30Z', level: 'error', service: 'api-gateway', message: 'auth middleware threw unhandled exception', status: 500, path: '/api/orders', error: 'TypeError: Cannot read properties of undefined (reading \'verify\')' },
        { _time: '2026-02-06T14:59:00Z', level: 'info', service: 'api-gateway', message: 'health check passed', status: 200, path: '/healthz' },
        { _time: '2026-02-06T14:59:01Z', level: 'error', service: 'api-gateway', message: 'auth middleware threw unhandled exception', status: 500, path: '/api/users', error: 'TypeError: Cannot read properties of undefined (reading \'verify\')' },
        { _time: '2026-02-06T14:59:05Z', level: 'error', service: 'api-gateway', message: 'auth middleware threw unhandled exception', status: 500, path: '/api/orders', error: 'TypeError: Cannot read properties of undefined (reading \'verify\')' },
        { _time: '2026-02-06T14:59:10Z', level: 'error', service: 'api-gateway', message: 'auth middleware threw unhandled exception', status: 500, path: '/api/products', error: 'TypeError: Cannot read properties of undefined (reading \'verify\')' },
      ],
      'deploy-events': [
        { _time: '2026-02-06T14:00:00Z', event: 'deploy', version: 'v3.0.9', service: 'api-gateway', user: 'ci-bot', status: 'success', config_changes: 'none', rollback_available: true },
        { _time: '2026-02-06T14:58:00Z', event: 'deploy', version: 'v3.1.0', service: 'api-gateway', user: 'ci-bot', status: 'success', commit: 'f7a2c1d', author: 'dev-intern', changes: 'Refactored auth middleware to use new JWT library', config_changes: 'AUTH_JWT_LIBRARY=jsonwebtoken→jose', rollback_available: true },
        { _time: '2026-02-06T14:58:01Z', event: 'config_change', version: 'v3.1.0', service: 'api-gateway', key: 'AUTH_JWT_LIBRARY', old_value: 'jsonwebtoken', new_value: 'jose', commit: 'f7a2c1d', author: 'dev-intern' },
      ],
    },
    metrics: {
      'http_requests_total': [
        {
          metric: 'http_requests_total',
          labels: { status: '200', service: 'api-gateway' },
          values: [
            [1738853400, 15200],  // 14:50 - normal
            [1738853700, 15890],  // 14:55 - normal
            [1738853880, 16010],  // 14:58 - deploy
            [1738853940, 16015],  // 14:59 - nearly stops (only healthz)
            [1738854000, 16018],  // 15:00
            [1738854060, 16020],  // 15:01
          ],
        },
        {
          metric: 'http_requests_total',
          labels: { status: '500', service: 'api-gateway' },
          values: [
            [1738853400, 3],      // 14:50 - near zero
            [1738853700, 5],      // 14:55 - near zero
            [1738853880, 8],      // 14:58 - deploy moment
            [1738853895, 342],    // 14:58:15 - immediate spike
            [1738853940, 1850],   // 14:59 - 95% error rate
            [1738854000, 3400],   // 15:00
            [1738854060, 5100],   // 15:01
          ],
        },
      ],
      'http_request_duration_seconds': [
        {
          metric: 'http_request_duration_seconds',
          labels: { service: 'api-gateway', quantile: '0.99' },
          values: [
            [1738853400, 0.085],   // 14:50 - normal
            [1738853700, 0.091],   // 14:55 - normal
            [1738853880, 0.003],   // 14:58 - fast failures (middleware crash)
            [1738853940, 0.002],   // 14:59
            [1738854000, 0.002],   // 15:00
          ],
        },
      ],
      'http_error_rate': [
        {
          metric: 'http_error_rate',
          labels: { service: 'api-gateway' },
          values: [
            [1738853400, 0.002],   // 14:50 - 0.2%
            [1738853700, 0.003],   // 14:55 - 0.3%
            [1738853880, 0.005],   // 14:58 - deploy
            [1738853895, 0.85],    // 14:58:15 - 85%
            [1738853940, 0.95],    // 14:59 - 95%
            [1738854000, 0.96],    // 15:00
            [1738854060, 0.95],    // 15:01
          ],
        },
      ],
    },
  },
  expected: {
    rootCauseMustMention: ['deploy', 'auth', 'middleware', 'v3.1.0'],
    rootCauseMustNotMention: ['DDoS', 'upstream', 'rate_limit', 'memory'],
    requiredEvidence: [
      { tool: 'scripts/axiom-query', mustMention: ['auth', '500'] },
    ],
    requiredQueries: [
      {
        tool: 'scripts/axiom-query',
        mustMatch: "\\[(?:'|\")app-logs(?:'|\")\\]",
        description: 'Must query app-logs to see the auth middleware errors',
      },
      {
        tool: 'scripts/axiom-query',
        mustMatch: "\\[(?:'|\")deploy-events(?:'|\")\\]",
        description: 'Must query deploy-events to correlate with the deploy',
      },
    ],
  },
  budgets: {
    maxToolCalls: 12,
    maxTotalTokens: 8000,
  },
};
