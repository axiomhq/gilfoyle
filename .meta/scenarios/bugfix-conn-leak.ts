import type { IncidentScenario } from '../harness/types.js';

/**
 * Bug Fix: Connection Leak in Error Path
 *
 * Investigation → Bug Fix transition scenario.
 *
 * The agent must:
 * 1. Init → discover datasets
 * 2. Query logs → find payment handler connection pool exhaustion
 * 3. Query metrics → see monotonically increasing active connections
 * 4. Recognize this is a code bug (leak in error path), not infra
 * 5. TRANSITION to bug fix protocol:
 *    - Clone repo, read the code
 *    - git log / git blame to find what changed
 *    - gh pr view to understand PR #287's intent
 *    - Write a failing test
 *    - Fix the bug (add conn.Release() in error path)
 *    - Run test (now passing)
 * 6. Report with: root cause, introduced-by PR, intent, red→green
 *
 * The git fixtures show PR #287 ("Retry failed payments") added a
 * retry loop that acquires a new connection but doesn't release the
 * original on error — classic resource leak in error path.
 */

export const bugfixConnLeakScenario: IncidentScenario = {
  id: 'bugfix-conn-leak',
  name: 'Investigation → Bug fix: connection leak in payment retry',
  description: 'DB pool exhaustion caused by connection leak in error path introduced by recent PR. Agent must investigate, find the PR, understand intent, and follow bug fix protocol.',
  prompt: `Alert: Database connection pool at 100% on payment-service in prod.
Requests queuing, p95 > 30s. No recent deploys in the last 24h but PR #287 merged 3 days ago.
The pool has been slowly leaking connections since then.
Investigate, find the root cause, and fix it. Open a PR.`,
  initOutput: `Gilfoyle Environment Discovery
==============================

Axiom Environments:
  prod:
    datasets: [app-logs, infra-metrics]

Grafana Environments:
  prod:
    datasources: [prometheus-prod (uid: prom-prod)]

GitHub:
  Available (repos: acme/payment-service)

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
        { _time: '2026-02-15T10:00:00Z', level: 'info', service: 'payment-service', handler: 'processPayment', message: 'payment completed', status: 200, latency_ms: 45 },
        { _time: '2026-02-15T10:05:00Z', level: 'error', service: 'payment-service', handler: 'processPayment', message: 'payment failed, retrying', error: 'card_declined', retry_attempt: 1, pool_active: 32, pool_max: 50 },
        { _time: '2026-02-15T10:05:01Z', level: 'error', service: 'payment-service', handler: 'processPayment', message: 'payment failed, retrying', error: 'card_declined', retry_attempt: 2, pool_active: 33, pool_max: 50 },
        { _time: '2026-02-15T10:10:00Z', level: 'warn', service: 'payment-service', handler: 'processPayment', message: 'db pool wait time elevated', pool_wait_ms: 3200, pool_active: 42, pool_max: 50 },
        { _time: '2026-02-15T10:20:00Z', level: 'error', service: 'payment-service', handler: 'processPayment', message: 'db connection pool exhausted', pool_active: 50, pool_max: 50, pool_waiting: 18 },
        { _time: '2026-02-15T10:25:00Z', level: 'error', service: 'payment-service', handler: 'processPayment', message: 'db connection pool exhausted', pool_active: 50, pool_max: 50, pool_waiting: 35 },
        // Other services unaffected
        { _time: '2026-02-15T10:20:00Z', level: 'info', service: 'user-service', handler: 'getUser', message: 'request completed', status: 200, latency_ms: 12 },
      ],
      'infra-metrics': [],
    },
    metrics: {
      'db_pool_active_connections': [
        {
          metric: 'db_pool_active_connections',
          labels: { service: 'payment-service' },
          values: [
            [1739613600, 15], // 10:00
            [1739614200, 25], // 10:10
            [1739614800, 38], // 10:20
            [1739615400, 48], // 10:30
            [1739616000, 50], // 10:40
            [1739616600, 50], // 10:50
          ],
        },
      ],
      'db_pool_waiting_requests': [
        {
          metric: 'db_pool_waiting_requests',
          labels: { service: 'payment-service' },
          values: [
            [1739613600, 0],
            [1739614200, 0],
            [1739614800, 5],
            [1739615400, 18],
            [1739616000, 35],
            [1739616600, 52],
          ],
        },
      ],
    },
    gitLog: {
      'internal/payment/handler.go': [
        { sha: 'a1b2c3d4e5f6', author: 'alice', date: '2026-02-12', message: 'feat: retry failed payments with backoff (#287)', files: ['internal/payment/handler.go', 'internal/payment/handler_test.go'] },
        { sha: '9f8e7d6c5b4a', author: 'bob', date: '2026-01-28', message: 'refactor: extract payment processing into handler', files: ['internal/payment/handler.go'] },
        { sha: '1a2b3c4d5e6f', author: 'alice', date: '2026-01-15', message: 'feat: add payment service with connection pool', files: ['internal/payment/handler.go', 'internal/payment/pool.go'] },
      ],
    },
    gitBlame: {
      'internal/payment/handler.go': [
        { sha: '1a2b3c4d5e6f', author: 'alice', date: '2026-01-15', lineStart: 1, lineEnd: 30, content: 'func (h *Handler) ProcessPayment(ctx context.Context, req *PaymentRequest) error {' },
        { sha: '1a2b3c4d5e6f', author: 'alice', date: '2026-01-15', lineStart: 31, lineEnd: 35, content: '    conn, err := h.pool.Acquire(ctx)' },
        { sha: '1a2b3c4d5e6f', author: 'alice', date: '2026-01-15', lineStart: 36, lineEnd: 38, content: '    defer conn.Release()' },
        { sha: 'a1b2c3d4e5f6', author: 'alice', date: '2026-02-12', lineStart: 39, lineEnd: 55, content: '    // Retry loop added in PR #287\n    for attempt := 0; attempt < maxRetries; attempt++ {\n        conn2, err := h.pool.Acquire(ctx)\n        if err != nil { return fmt.Errorf("acquire: %w", err) }\n        err = h.executePayment(ctx, conn2, req)\n        if err == nil { conn2.Release(); return nil }\n        // BUG: conn2 not released on error path\n        time.Sleep(backoff(attempt))\n    }' },
      ],
    },
    pullRequests: {
      '287': {
        number: 287,
        title: 'feat: retry failed payments with exponential backoff',
        body: 'Adds automatic retry with exponential backoff for failed payment attempts.\n\nMotivation: ~3% of payments fail transiently (network blips, temporary card processor issues). Retrying recovers most of these without user intervention.\n\nChanges:\n- Added retry loop in ProcessPayment with configurable max retries\n- Each retry acquires a fresh connection for isolation\n- Exponential backoff: 100ms, 200ms, 400ms',
        author: 'alice',
        mergedAt: '2026-02-12T16:30:00Z',
        files: ['internal/payment/handler.go', 'internal/payment/handler_test.go'],
        diff: `diff --git a/internal/payment/handler.go b/internal/payment/handler.go
@@ -36,6 +36,20 @@ func (h *Handler) ProcessPayment(ctx context.Context, req *PaymentRequest) error
     defer conn.Release()
 
+    // Retry failed payments with backoff
+    for attempt := 0; attempt < h.maxRetries; attempt++ {
+        conn2, err := h.pool.Acquire(ctx)
+        if err != nil {
+            return fmt.Errorf("retry acquire: %w", err)
+        }
+        err = h.executePayment(ctx, conn2, req)
+        if err == nil {
+            conn2.Release()
+            return nil
+        }
+        // Continue to next retry
+        time.Sleep(backoff(attempt))
+    }
     return h.executePayment(ctx, conn, req)
 }`,
      },
    },
  },
  expected: {
    rootCauseMustMention: ['connection', 'leak', 'retry', 'release'],
    rootCauseMustNotMention: ['DDoS', 'memory', 'CPU', 'deploy'],
    requiredEvidence: [
      { tool: 'scripts/axiom-query', mustMention: ['pool', 'payment'] },
    ],
    requiredQueries: [
      {
        tool: 'scripts/axiom-query',
        mustMatch: "\\['app-logs'\\]",
        description: 'Must query app-logs for pool exhaustion evidence',
      },
    ],
  },
  scoring: {
    requireBugfixDiligence: true,
    requireSourceLinks: true,
  },
  budgets: {
    maxToolCalls: 25,
    maxTotalTokens: 20000,
    maxElapsedMs: 600_000,
  },
};
