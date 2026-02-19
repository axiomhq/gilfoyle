import type { IncidentScenario } from '../harness/types.js';

/**
 * Misleading Deploy Correlation Scenario (T05)
 *
 * Tests cognitive traps — specifically recency bias and correlation ≠ causation.
 *
 * Setup:
 * - Deploy at 15:00
 * - Errors start at 15:02
 * - Obvious hypothesis: bad deploy
 *
 * Reality:
 * - External dependency started rate-limiting at 15:01
 * - 429s from upstream → retry storm → cascading failures
 * - Deploy config changes: none relevant
 *
 * The agent must:
 * 1. Resist blaming the deploy just because timing matches
 * 2. Find the upstream 429s
 * 3. Identify rate limiting as the actual cause
 */

export const misleadingDeployScenario: IncidentScenario = {
  id: 'misleading-deploy',
  name: 'Misleading deploy correlation — upstream rate limiting',
  description: 'Errors started 2 min after deploy. Obvious correlation, wrong causation.',
  prompt: `Alert: 5xx error rate spiked to 45% on payment-service at 15:02 UTC.
Last deploy was at 15:00 UTC.
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
  - upstream-calls`,
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
      'deploy-events': [
        {
          _time: '2026-02-06T15:00:00Z',
          level: 'info',
          event: 'deploy',
          service: 'payment-service',
          version: 'v2.3.45',
          previous_version: 'v2.3.44',
          deployer: 'ci-bot',
          changes: 'Updated logging format, added debug headers',
          config_changes: 'none',
          rollback_available: true,
        },
        {
          _time: '2026-02-06T14:30:00Z',
          level: 'info',
          event: 'deploy',
          service: 'notification-service',
          version: 'v1.8.12',
          previous_version: 'v1.8.11',
          deployer: 'ci-bot',
          changes: 'Bug fix for email templates',
          config_changes: 'none',
          rollback_available: true,
        },
      ],
      'app-logs': [
        // Pre-deploy: everything fine
        { _time: '2026-02-06T14:58:00Z', level: 'info', service: 'payment-service', message: 'payment processed', status: 200, latency_ms: 145, transaction_id: 'tx-001' },
        { _time: '2026-02-06T14:59:00Z', level: 'info', service: 'payment-service', message: 'payment processed', status: 200, latency_ms: 152, transaction_id: 'tx-002' },
        { _time: '2026-02-06T14:59:30Z', level: 'info', service: 'payment-service', message: 'payment processed', status: 200, latency_ms: 138, transaction_id: 'tx-003' },
        // Deploy happens at 15:00
        { _time: '2026-02-06T15:00:15Z', level: 'info', service: 'payment-service', message: 'service started v2.3.45', version: 'v2.3.45' },
        { _time: '2026-02-06T15:00:30Z', level: 'info', service: 'payment-service', message: 'payment processed', status: 200, latency_ms: 160, transaction_id: 'tx-004' },
        { _time: '2026-02-06T15:01:00Z', level: 'info', service: 'payment-service', message: 'payment processed', status: 200, latency_ms: 155, transaction_id: 'tx-005' },
        // Upstream starts rate limiting at 15:01:30
        { _time: '2026-02-06T15:01:45Z', level: 'warn', service: 'payment-service', message: 'upstream call slow', upstream: 'stripe-api', latency_ms: 2500, transaction_id: 'tx-006' },
        // Errors start at 15:02
        { _time: '2026-02-06T15:02:00Z', level: 'error', service: 'payment-service', message: 'upstream returned 429', upstream: 'stripe-api', status: 429, error: 'rate_limit_exceeded', retry_after: 60, transaction_id: 'tx-007' },
        { _time: '2026-02-06T15:02:05Z', level: 'error', service: 'payment-service', message: 'upstream returned 429', upstream: 'stripe-api', status: 429, error: 'rate_limit_exceeded', retry_after: 60, transaction_id: 'tx-008' },
        { _time: '2026-02-06T15:02:10Z', level: 'error', service: 'payment-service', message: 'upstream returned 429', upstream: 'stripe-api', status: 429, error: 'rate_limit_exceeded', retry_after: 60, transaction_id: 'tx-009' },
        { _time: '2026-02-06T15:02:15Z', level: 'error', service: 'payment-service', message: 'retrying upstream call', upstream: 'stripe-api', attempt: 2, transaction_id: 'tx-007' },
        { _time: '2026-02-06T15:02:20Z', level: 'error', service: 'payment-service', message: 'retrying upstream call', upstream: 'stripe-api', attempt: 2, transaction_id: 'tx-008' },
        { _time: '2026-02-06T15:02:30Z', level: 'error', service: 'payment-service', message: 'upstream returned 429', upstream: 'stripe-api', status: 429, error: 'rate_limit_exceeded', transaction_id: 'tx-007' },
        { _time: '2026-02-06T15:02:35Z', level: 'error', service: 'payment-service', message: 'upstream returned 429', upstream: 'stripe-api', status: 429, error: 'rate_limit_exceeded', transaction_id: 'tx-008' },
        { _time: '2026-02-06T15:02:40Z', level: 'error', service: 'payment-service', message: 'request failed after retries', status: 503, upstream: 'stripe-api', error: 'upstream_rate_limited', transaction_id: 'tx-007' },
        { _time: '2026-02-06T15:02:45Z', level: 'error', service: 'payment-service', message: 'request failed after retries', status: 503, upstream: 'stripe-api', error: 'upstream_rate_limited', transaction_id: 'tx-008' },
        { _time: '2026-02-06T15:03:00Z', level: 'error', service: 'payment-service', message: 'upstream returned 429', upstream: 'stripe-api', status: 429, error: 'rate_limit_exceeded', transaction_id: 'tx-010' },
        { _time: '2026-02-06T15:03:15Z', level: 'error', service: 'payment-service', message: 'request failed after retries', status: 503, upstream: 'stripe-api', error: 'upstream_rate_limited', transaction_id: 'tx-009' },
        { _time: '2026-02-06T15:03:30Z', level: 'error', service: 'payment-service', message: 'circuit breaker opened for stripe-api', upstream: 'stripe-api', state: 'open' },
        { _time: '2026-02-06T15:04:00Z', level: 'error', service: 'payment-service', message: 'fast-fail: circuit breaker open', upstream: 'stripe-api', status: 503, transaction_id: 'tx-011' },
        { _time: '2026-02-06T15:04:30Z', level: 'error', service: 'payment-service', message: 'fast-fail: circuit breaker open', upstream: 'stripe-api', status: 503, transaction_id: 'tx-012' },
      ],
      'upstream-calls': [
        // Baseline: successful calls pre-incident
        { _time: '2026-02-06T14:55:00Z', level: 'info', upstream: 'stripe-api', method: 'POST', path: '/v1/charges', status: 200, latency_ms: 120 },
        { _time: '2026-02-06T14:56:00Z', level: 'info', upstream: 'stripe-api', method: 'POST', path: '/v1/charges', status: 200, latency_ms: 115 },
        { _time: '2026-02-06T14:58:00Z', level: 'info', upstream: 'stripe-api', method: 'POST', path: '/v1/charges', status: 200, latency_ms: 125 },
        { _time: '2026-02-06T15:00:30Z', level: 'info', upstream: 'stripe-api', method: 'POST', path: '/v1/charges', status: 200, latency_ms: 130 },
        { _time: '2026-02-06T15:01:00Z', level: 'info', upstream: 'stripe-api', method: 'POST', path: '/v1/charges', status: 200, latency_ms: 128 },
        // Rate limiting starts
        { _time: '2026-02-06T15:01:30Z', level: 'warn', upstream: 'stripe-api', method: 'POST', path: '/v1/charges', status: 429, error: 'rate_limit_exceeded', headers: { 'retry-after': '60', 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '0' } },
        { _time: '2026-02-06T15:02:00Z', level: 'error', upstream: 'stripe-api', method: 'POST', path: '/v1/charges', status: 429, error: 'rate_limit_exceeded', headers: { 'retry-after': '55', 'x-ratelimit-remaining': '0' } },
        { _time: '2026-02-06T15:02:05Z', level: 'error', upstream: 'stripe-api', method: 'POST', path: '/v1/charges', status: 429, error: 'rate_limit_exceeded' },
        { _time: '2026-02-06T15:02:10Z', level: 'error', upstream: 'stripe-api', method: 'POST', path: '/v1/charges', status: 429, error: 'rate_limit_exceeded' },
        { _time: '2026-02-06T15:02:15Z', level: 'error', upstream: 'stripe-api', method: 'POST', path: '/v1/charges', status: 429, error: 'rate_limit_exceeded' },
        { _time: '2026-02-06T15:02:30Z', level: 'error', upstream: 'stripe-api', method: 'POST', path: '/v1/charges', status: 429, error: 'rate_limit_exceeded' },
        { _time: '2026-02-06T15:02:45Z', level: 'error', upstream: 'stripe-api', method: 'POST', path: '/v1/charges', status: 429, error: 'rate_limit_exceeded' },
        { _time: '2026-02-06T15:03:00Z', level: 'error', upstream: 'stripe-api', method: 'POST', path: '/v1/charges', status: 429, error: 'rate_limit_exceeded' },
      ],
    },
    metrics: {
      'http_requests_total': [
        {
          metric: 'http_requests_total',
          labels: { service: 'payment-service', status: '200' },
          values: [
            [1738850400, 12500],  // 14:00
            [1738851000, 13200],  // 14:10
            [1738851600, 13900],  // 14:20
            [1738852200, 14600],  // 14:30
            [1738852800, 15300],  // 14:40
            [1738853400, 16000],  // 14:50
            [1738854000, 16100],  // 15:00 (deploy)
            [1738854120, 16105],  // 15:02 (errors start - 200s plateau)
            [1738854300, 16108],  // 15:05
          ],
        },
        {
          metric: 'http_requests_total',
          labels: { service: 'payment-service', status: '503' },
          values: [
            [1738850400, 0],
            [1738851000, 0],
            [1738852200, 2],
            [1738854000, 5],      // 15:00 - minimal 503s
            [1738854120, 245],    // 15:02 - spike
            [1738854180, 580],    // 15:03
            [1738854240, 1230],   // 15:04
            [1738854300, 2100],   // 15:05
          ],
        },
      ],
      'upstream_request_duration_seconds': [
        {
          metric: 'upstream_request_duration_seconds',
          labels: { upstream: 'stripe-api', quantile: '0.99' },
          values: [
            [1738852200, 0.15],   // 14:30 - normal
            [1738853400, 0.14],   // 14:50 - normal
            [1738854000, 0.13],   // 15:00 - normal (deploy)
            [1738854090, 2.5],    // 15:01:30 - spikes (rate limiting starts)
            [1738854120, 30.0],   // 15:02 - timeout waiting for retries
            [1738854180, 30.0],   // 15:03
          ],
        },
      ],
      'upstream_requests_total': [
        {
          metric: 'upstream_requests_total',
          labels: { upstream: 'stripe-api', status: '200' },
          values: [
            [1738852200, 4500],
            [1738853400, 4950],
            [1738854000, 5050],   // 15:00
            [1738854090, 5070],   // 15:01:30 - stops growing
            [1738854120, 5070],   // 15:02
            [1738854180, 5070],   // 15:03
          ],
        },
        {
          metric: 'upstream_requests_total',
          labels: { upstream: 'stripe-api', status: '429' },
          values: [
            [1738852200, 0],
            [1738853400, 0],
            [1738854000, 0],
            [1738854090, 15],     // 15:01:30 - rate limiting starts
            [1738854120, 180],    // 15:02
            [1738854180, 450],    // 15:03
            [1738854240, 890],    // 15:04
          ],
        },
      ],
      'circuit_breaker_state': [
        {
          metric: 'circuit_breaker_state',
          labels: { upstream: 'stripe-api', state: 'open' },
          values: [
            [1738852200, 0],
            [1738854000, 0],
            [1738854210, 1],      // 15:03:30 - circuit opens
            [1738854300, 1],
          ],
        },
      ],
    },
  },
  expected: {
    rootCauseMustMention: ['rate_limit', 'upstream', '429', 'stripe'],
    rootCauseMustNotMention: ['deploy', 'config', 'rollback', 'version', 'v2.3.45'],
    requiredEvidence: [
      { tool: 'scripts/axiom-query', mustMention: ['429', 'rate_limit'] },
    ],
    requiredQueries: [
      {
        tool: 'scripts/axiom-query',
        mustMatch: "\\[(?:'|\")deploy-events(?:'|\")\\]|\\[(?:'|\")upstream-calls(?:'|\")\\]",
        description: 'Must query deploy-events OR upstream-calls to investigate correlation',
      },
      {
        tool: 'scripts/axiom-query',
        mustMatch: '429|rate_limit|upstream',
        description: 'Must look for rate limiting evidence',
      },
    ],
  },
  budgets: {
    maxToolCalls: 17,
    maxTotalTokens: 10000,
    maxElapsedMs: 285_000,
  },
};
