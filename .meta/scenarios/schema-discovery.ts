import type { IncidentScenario } from '../harness/types.js';

/**
 * Schema Discovery Scenario — Tests mandatory schema-first querying
 *
 * Designed to catch agents that skip getschema and guess field names.
 *
 * The trap:
 * - Dataset is 'otel-traces-prod' (not 'traces' or 'spans')
 * - Field names are non-obvious: status is inside attributes.custom map,
 *   not top-level or in standard OTel paths
 * - If agent queries `attributes.http.status_code` without discovery,
 *   it won't find anything — the actual field is
 *   `['attributes.custom']['http.response.status_code']`
 * - Service name is in resource map, not a top-level 'service' field
 *
 * The agent must:
 * 1. Init → discover datasets (otel-traces-prod)
 * 2. Run getschema → see map[string] columns for attributes.custom, resource
 * 3. Sample/enumerate map fields → find actual key names
 * 4. Build correct queries using bracket notation
 * 5. Find the root cause: checkout-service has high latency due to
 *    unindexed DB query on the orders table
 */

export const schemaDiscoveryScenario: IncidentScenario = {
  id: 'schema-discovery',
  name: 'Schema discovery required — OTel traces with map fields',
  description: 'Non-obvious field names in OTel traces. Agent must run getschema and sample maps before filtering.',
  prompt: `Alert: p95 latency on checkout endpoint spiked to 12s (normally 200ms).
Started 30 minutes ago. Users reporting timeouts during checkout.
The traces are in our OTel pipeline. Investigate and find the root cause.`,
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
  - otel-traces-prod
  - k8s-logs-prod`,
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
      'otel-traces-prod': [
        // Normal checkout traces (before incident)
        {
          _time: '2026-02-06T14:00:00Z',
          trace_id: 'abc001',
          span_id: 's001',
          span_name: 'POST /api/checkout',
          duration: 180000000,  // 180ms in nanoseconds
          status_code: 'OK',
          'attributes.custom': { 'http.method': 'POST', 'http.route': '/api/checkout', 'http.response.status_code': '200', 'db.statement': 'SELECT * FROM orders WHERE user_id = $1', 'db.system': 'postgresql' },
          resource: { 'service.name': 'checkout-service', 'host.name': 'pod-checkout-a1', 'deployment.environment': 'production' },
        },
        {
          _time: '2026-02-06T14:05:00Z',
          trace_id: 'abc002',
          span_id: 's002',
          span_name: 'POST /api/checkout',
          duration: 195000000,
          status_code: 'OK',
          'attributes.custom': { 'http.method': 'POST', 'http.route': '/api/checkout', 'http.response.status_code': '200', 'db.statement': 'SELECT * FROM orders WHERE user_id = $1', 'db.system': 'postgresql' },
          resource: { 'service.name': 'checkout-service', 'host.name': 'pod-checkout-a2', 'deployment.environment': 'production' },
        },
        // Latency spike starts
        {
          _time: '2026-02-06T14:30:00Z',
          trace_id: 'abc003',
          span_id: 's003',
          span_name: 'POST /api/checkout',
          duration: 8500000000,  // 8.5s
          status_code: 'ERROR',
          'attributes.custom': { 'http.method': 'POST', 'http.route': '/api/checkout', 'http.response.status_code': '504', 'db.statement': 'SELECT * FROM orders WHERE user_id = $1 AND status IN ($2, $3) ORDER BY created_at DESC', 'db.system': 'postgresql', 'db.operation': 'SELECT', 'error.message': 'query timeout after 8s' },
          resource: { 'service.name': 'checkout-service', 'host.name': 'pod-checkout-a1', 'deployment.environment': 'production' },
        },
        {
          _time: '2026-02-06T14:31:00Z',
          trace_id: 'abc004',
          span_id: 's004',
          span_name: 'POST /api/checkout',
          duration: 12100000000,  // 12.1s
          status_code: 'ERROR',
          'attributes.custom': { 'http.method': 'POST', 'http.route': '/api/checkout', 'http.response.status_code': '504', 'db.statement': 'SELECT * FROM orders WHERE user_id = $1 AND status IN ($2, $3) ORDER BY created_at DESC', 'db.system': 'postgresql', 'db.operation': 'SELECT', 'error.message': 'query timeout after 12s' },
          resource: { 'service.name': 'checkout-service', 'host.name': 'pod-checkout-a2', 'deployment.environment': 'production' },
        },
        {
          _time: '2026-02-06T14:32:00Z',
          trace_id: 'abc005',
          span_id: 's005',
          span_name: 'POST /api/checkout',
          duration: 11800000000,  // 11.8s
          status_code: 'ERROR',
          'attributes.custom': { 'http.method': 'POST', 'http.route': '/api/checkout', 'http.response.status_code': '504', 'db.statement': 'SELECT * FROM orders WHERE user_id = $1 AND status IN ($2, $3) ORDER BY created_at DESC', 'db.system': 'postgresql', 'db.operation': 'SELECT', 'error.message': 'query timeout after 11s' },
          resource: { 'service.name': 'checkout-service', 'host.name': 'pod-checkout-a1', 'deployment.environment': 'production' },
        },
        {
          _time: '2026-02-06T14:33:00Z',
          trace_id: 'abc006',
          span_id: 's006',
          span_name: 'POST /api/checkout',
          duration: 13200000000,
          status_code: 'ERROR',
          'attributes.custom': { 'http.method': 'POST', 'http.route': '/api/checkout', 'http.response.status_code': '504', 'db.statement': 'SELECT * FROM orders WHERE user_id = $1 AND status IN ($2, $3) ORDER BY created_at DESC', 'db.system': 'postgresql', 'db.operation': 'SELECT', 'error.message': 'query timeout after 13s' },
          resource: { 'service.name': 'checkout-service', 'host.name': 'pod-checkout-a2', 'deployment.environment': 'production' },
        },
        // Other services are fine
        {
          _time: '2026-02-06T14:30:00Z',
          trace_id: 'abc010',
          span_id: 's010',
          span_name: 'GET /api/products',
          duration: 45000000,
          status_code: 'OK',
          'attributes.custom': { 'http.method': 'GET', 'http.route': '/api/products', 'http.response.status_code': '200' },
          resource: { 'service.name': 'catalog-service', 'host.name': 'pod-catalog-b1', 'deployment.environment': 'production' },
        },
        {
          _time: '2026-02-06T14:31:00Z',
          trace_id: 'abc011',
          span_id: 's011',
          span_name: 'GET /api/cart',
          duration: 62000000,
          status_code: 'OK',
          'attributes.custom': { 'http.method': 'GET', 'http.route': '/api/cart', 'http.response.status_code': '200' },
          resource: { 'service.name': 'cart-service', 'host.name': 'pod-cart-c1', 'deployment.environment': 'production' },
        },
      ],
      'k8s-logs-prod': [
        { _time: '2026-02-06T14:30:00Z', level: 'warn', namespace: 'default', kind: 'Pod', name: 'pod-checkout-a1', message: 'High memory usage detected', container: 'checkout' },
        { _time: '2026-02-06T14:32:00Z', level: 'warn', namespace: 'default', kind: 'Pod', name: 'pod-checkout-a2', message: 'High memory usage detected', container: 'checkout' },
      ],
    },
    metrics: {
      'http_server_request_duration_seconds': [
        {
          metric: 'http_server_request_duration_seconds',
          labels: { service: 'checkout-service', route: '/api/checkout', quantile: '0.95' },
          values: [
            [1738850400, 0.18],   // 14:00 - normal
            [1738851000, 0.19],   // 14:10
            [1738851600, 0.20],   // 14:20
            [1738852200, 8.5],    // 14:30 - spike
            [1738852800, 12.1],   // 14:40
            [1738853400, 11.8],   // 14:50
          ],
        },
        {
          metric: 'http_server_request_duration_seconds',
          labels: { service: 'catalog-service', route: '/api/products', quantile: '0.95' },
          values: [
            [1738850400, 0.04],
            [1738852200, 0.045],
            [1738853400, 0.042],
          ],
        },
      ],
      'db_query_duration_seconds': [
        {
          metric: 'db_query_duration_seconds',
          labels: { service: 'checkout-service', operation: 'SELECT', table: 'orders', quantile: '0.95' },
          values: [
            [1738850400, 0.05],   // 14:00 - normal
            [1738851600, 0.08],   // 14:20 - slightly rising
            [1738852200, 8.2],    // 14:30 - explodes
            [1738852800, 11.9],   // 14:40
            [1738853400, 12.5],   // 14:50
          ],
        },
      ],
    },
  },
  expected: {
    rootCauseMustMention: ['query', 'timeout', 'checkout', 'database'],
    rootCauseMustNotMention: ['DDoS', 'network', 'memory leak'],
    requiredEvidence: [
      { tool: 'scripts/axiom-query', mustMention: ['checkout', 'timeout'] },
    ],
    requiredQueries: [
      {
        tool: 'scripts/axiom-query',
        mustMatch: "\\['otel-traces-prod'\\].*getschema|getschema.*\\['otel-traces-prod'\\]",
        description: 'Must run getschema on otel-traces-prod before querying',
      },
      {
        tool: 'scripts/axiom-query',
        mustMatch: "\\['otel-traces-prod'\\]",
        description: 'Must query the correct dataset name from discovery',
      },
    ],
  },
  budgets: {
    maxToolCalls: 20,
    maxTotalTokens: 15000,
    maxElapsedMs: 285_000,
  },
};
