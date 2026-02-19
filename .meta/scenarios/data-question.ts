import type { IncidentScenario } from '../harness/types.js';

/**
 * Data Question Scenario — Evidence Links for Non-Incident Responses
 *
 * This is NOT an incident. The user asks a data question:
 * "What's the current error rate on the API?"
 *
 * The agent must:
 * 1. Init → discover datasets and datasources
 * 2. Query app-logs or metrics → get error counts / rates
 * 3. Cite specific numbers in its answer
 * 4. Generate source links (axiom-link, etc.) for every query it cites
 *
 * The trap: agents answer with numbers but no permalinks.
 * Without the source link rule, users can't verify the data.
 */

export const dataQuestionScenario: IncidentScenario = {
  id: 'data-question',
  name: 'Data question — error rate with source links',
  description: 'Non-incident data question. Agent must cite numbers AND provide source links.',
  prompt: `What's the current error rate on the API? Break it down by service if possible.`,
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
  Top datasets found (2)
  - app-logs
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
        // api-gateway: mostly healthy, some 5xx
        { _time: '2026-02-16T10:00:00Z', level: 'info', service: 'api-gateway', status: 200, method: 'GET', path: '/api/users', latency_ms: 42 },
        { _time: '2026-02-16T10:00:01Z', level: 'info', service: 'api-gateway', status: 200, method: 'GET', path: '/api/users', latency_ms: 38 },
        { _time: '2026-02-16T10:00:02Z', level: 'info', service: 'api-gateway', status: 200, method: 'POST', path: '/api/orders', latency_ms: 125 },
        { _time: '2026-02-16T10:00:03Z', level: 'error', service: 'api-gateway', status: 502, method: 'GET', path: '/api/products', latency_ms: 5020, error: 'upstream timeout' },
        { _time: '2026-02-16T10:00:04Z', level: 'info', service: 'api-gateway', status: 200, method: 'GET', path: '/api/products', latency_ms: 55 },
        { _time: '2026-02-16T10:01:00Z', level: 'error', service: 'api-gateway', status: 500, method: 'POST', path: '/api/orders', latency_ms: 3200, error: 'internal server error' },
        { _time: '2026-02-16T10:01:01Z', level: 'info', service: 'api-gateway', status: 200, method: 'GET', path: '/api/users', latency_ms: 40 },
        { _time: '2026-02-16T10:01:02Z', level: 'info', service: 'api-gateway', status: 200, method: 'GET', path: '/api/users', latency_ms: 44 },
        { _time: '2026-02-16T10:01:03Z', level: 'info', service: 'api-gateway', status: 200, method: 'POST', path: '/api/orders', latency_ms: 110 },
        { _time: '2026-02-16T10:01:04Z', level: 'info', service: 'api-gateway', status: 200, method: 'GET', path: '/api/products', latency_ms: 48 },
        // payment-service: higher error rate
        { _time: '2026-02-16T10:00:00Z', level: 'info', service: 'payment-service', status: 200, method: 'POST', path: '/pay', latency_ms: 250 },
        { _time: '2026-02-16T10:00:02Z', level: 'error', service: 'payment-service', status: 500, method: 'POST', path: '/pay', latency_ms: 1800, error: 'payment gateway timeout' },
        { _time: '2026-02-16T10:00:04Z', level: 'info', service: 'payment-service', status: 200, method: 'POST', path: '/pay', latency_ms: 230 },
        { _time: '2026-02-16T10:01:00Z', level: 'error', service: 'payment-service', status: 503, method: 'POST', path: '/pay', latency_ms: 5100, error: 'service unavailable' },
        { _time: '2026-02-16T10:01:02Z', level: 'info', service: 'payment-service', status: 200, method: 'POST', path: '/pay', latency_ms: 210 },
        // user-service: clean
        { _time: '2026-02-16T10:00:00Z', level: 'info', service: 'user-service', status: 200, method: 'GET', path: '/users', latency_ms: 22 },
        { _time: '2026-02-16T10:00:01Z', level: 'info', service: 'user-service', status: 200, method: 'GET', path: '/users', latency_ms: 25 },
        { _time: '2026-02-16T10:01:00Z', level: 'info', service: 'user-service', status: 200, method: 'GET', path: '/users', latency_ms: 20 },
        { _time: '2026-02-16T10:01:01Z', level: 'info', service: 'user-service', status: 200, method: 'GET', path: '/users', latency_ms: 23 },
      ],
      'k8s-events': [],
    },
    metrics: {
      'http_requests_total': [
        {
          metric: 'http_requests_total',
          labels: { service: 'api-gateway', status: '2xx' },
          values: [[1771236000, 84521], [1771236600, 84893]],
        },
        {
          metric: 'http_requests_total',
          labels: { service: 'api-gateway', status: '5xx' },
          values: [[1771236000, 342], [1771236600, 358]],
        },
        {
          metric: 'http_requests_total',
          labels: { service: 'payment-service', status: '2xx' },
          values: [[1771236000, 12340], [1771236600, 12412]],
        },
        {
          metric: 'http_requests_total',
          labels: { service: 'payment-service', status: '5xx' },
          values: [[1771236000, 891], [1771236600, 923]],
        },
        {
          metric: 'http_requests_total',
          labels: { service: 'user-service', status: '2xx' },
          values: [[1771236000, 45102], [1771236600, 45290]],
        },
        {
          metric: 'http_requests_total',
          labels: { service: 'user-service', status: '5xx' },
          values: [[1771236000, 3], [1771236600, 3]],
        },
      ],
    },
  },
  expected: {
    rootCauseMustMention: ['error', 'rate'],
    rootCauseMustNotMention: ['DDoS', 'OOM'],
    requiredEvidence: [],
    requiredQueries: [
      {
        tool: 'scripts/axiom-query',
        mustMatch: "\\['app-logs'\\]",
        description: 'Must query app-logs for error data',
      },
    ],
  },
  budgets: {
    maxToolCalls: 14,
    maxTotalTokens: 10000,
    maxElapsedMs: 180_000,
  },
  scoring: {
    requireSlackComms: false,
    requireMemoryWrite: false,
    requireMemoryDistillation: false,
    requireHypothesisDiscipline: false,
    requireMustNotMention: false,
    requireSourceLinks: true,
  },
};
