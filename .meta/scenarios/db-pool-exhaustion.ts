/**
 * Scenario: DB Connection Pool Exhaustion
 *
 * Database queries timing out. Connection pool at max capacity.
 * Root cause: Missing connection release in payment processing code.
 */

import type { IncidentScenario } from '../harness/types.js';

export const dbPoolExhaustionScenario: IncidentScenario = {
  id: 'db-pool-exhaustion',
  name: 'DB connection pool exhaustion',
  description: 'Queries timing out, pool at max. Missing conn.release() in payment handler.',

  prompt: `Alert: payments-api latency p99 at 45s (normal: 200ms).
Database connection pool at 100% utilization.
Users report checkout failures.
Investigate the root cause.`,

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

  toolMocks: {
    axiom: [
      {
        when: { contains: ['timeout', 'payment'] },
        return: {
          rows: [
            { _time: '2026-02-06T16:10:05Z', level: 'error', service: 'payments-api', message: 'query timeout after 30s', query: 'SELECT * FROM transactions WHERE user_id = ?' },
            { _time: '2026-02-06T16:10:08Z', level: 'error', service: 'payments-api', message: 'connection pool exhausted', waiting: 47 },
            { _time: '2026-02-06T16:10:12Z', level: 'error', service: 'payments-api', message: 'failed to acquire connection from pool', wait_time_ms: 30000 },
          ],
        },
      },
      {
        when: { contains: ['connection', 'acquire'] },
        return: {
          rows: [
            { _time: '2026-02-06T16:08:00Z', pool_active: 50, pool_max: 50, pool_waiting: 0, acquire_time_ms: 2 },
            { _time: '2026-02-06T16:09:00Z', pool_active: 50, pool_max: 50, pool_waiting: 23, acquire_time_ms: 8500 },
            { _time: '2026-02-06T16:10:00Z', pool_active: 50, pool_max: 50, pool_waiting: 67, acquire_time_ms: 30000 },
          ],
        },
      },
      {
        when: { contains: ['release', 'leak'] },
        return: {
          rows: [
            { _time: '2026-02-06T16:05:00Z', handler: 'processPayment', acquire_count: 1247, release_count: 892, delta: 355 },
            { _time: '2026-02-06T16:10:00Z', handler: 'processPayment', acquire_count: 2891, release_count: 1203, delta: 1688 },
            { message: 'Connection leak detected in processPayment handler - acquire/release mismatch' },
          ],
        },
      },
      {
        when: { contains: ['spotlight'] },
        return: {
          spotlight: {
            dimension: 'handler',
            delta_score: 0.89,
            differences: [
              { value: 'processPayment', frequency_ratio: 0.94, comparison_count: 120, problem_count: 2891 },
              { value: 'getBalance', frequency_ratio: -0.2, comparison_count: 500, problem_count: 380 },
            ],
          },
        },
      },
      {
        when: { contains: ['code', 'processPayment'] },
        return: {
          rows: [
            {
              file: 'src/handlers/payment.ts',
              line: 45,
              code: `
async function processPayment(req, res) {
  const conn = await pool.acquire();
  try {
    const result = await conn.query('INSERT INTO transactions...');
    if (result.affectedRows === 0) {
      return res.status(400).json({ error: 'Failed' });  // BUG: No conn.release()
    }
    conn.release();
    return res.json({ success: true });
  } catch (err) {
    // BUG: No conn.release() in error path
    return res.status(500).json({ error: err.message });
  }
}`,
            },
          ],
        },
      },
    ],
    grafana: [
      {
        when: { contains: ['db_pool'] },
        return: {
          series: [
            { metric: 'db_pool_active_connections', values: [[1738857600, 45], [1738857660, 50], [1738857720, 50]] },
            { metric: 'db_pool_max_connections', values: [[1738857600, 50], [1738857660, 50], [1738857720, 50]] },
            { metric: 'db_pool_waiting_requests', values: [[1738857600, 0], [1738857660, 23], [1738857720, 67]] },
          ],
        },
      },
      {
        when: { contains: ['latency', 'payment'] },
        return: {
          series: [
            { metric: 'http_request_duration_seconds{service="payments-api",quantile="0.99"}', values: [[1738857600, 0.18], [1738857660, 12.5], [1738857720, 45.2]] },
          ],
        },
      },
    ],
    slack: [
      {
        when: { contains: ['chat.postMessage'] },
        return: { ok: true, ts: '1738857800.000100' },
      },
    ],
  },

  expected: {
    rootCauseMustMention: ['connection', 'release', 'leak'],
    rootCauseMustNotMention: ['DDoS', 'network', 'CPU'],
    requiredEvidence: [
      { tool: 'scripts/axiom-query', mustMention: ['release', 'processPayment'] },
    ],
  },

  budgets: {
    maxToolCalls: 15,
    maxTotalTokens: 12000,
  },
};
