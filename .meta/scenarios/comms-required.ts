import type { IncidentScenario } from '../harness/types.js';

/**
 * Comms Required Scenario — Disk Space Exhaustion on Log Aggregator
 *
 * The agent must:
 * 1. Run init → discover datasets and datasources
 * 2. Query log-aggregator-logs → find disk full errors, failed writes
 * 3. Query metrics → see disk usage climbing, ingest rate unchanged
 * 4. Investigate *why* → find log retention policy never applied, old indices piling up
 * 5. Communicate via Slack — announce investigation and post conclusion
 *
 * Scoring explicitly requires Slack comms (T10).
 */

export const commsRequiredScenario: IncidentScenario = {
  id: 'comms-required',
  name: 'Disk space exhaustion on log aggregator — comms required',
  description: 'Log aggregator disk at 97%. Retention policy misconfigured, old indices never pruned.',
  prompt: `Alert: Log aggregator node log-agg-01 disk usage at 97% in prod.
Ingest pipeline backing up, new logs being dropped.
Investigate, find root cause, and communicate status via Slack.`,
  initOutput: `Gilfoyle Environment Discovery
==============================

Axiom Environments:
  prod:
    datasets: [log-aggregator-logs, ingest-pipeline-logs, k8s-events]

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
      'log-aggregator-logs': [
        { _time: '2026-02-06T08:00:00Z', level: 'info', instance: 'log-agg-01', message: 'index rotation completed', index: 'logs-2026.02.05', size_gb: 42.3 },
        { _time: '2026-02-06T08:00:00Z', level: 'info', instance: 'log-agg-01', message: 'retention policy check', policy: 'retain-30d', status: 'skipped', reason: 'policy disabled since maintenance window 2026-01-15' },
        { _time: '2026-02-06T10:00:00Z', level: 'warn', instance: 'log-agg-01', message: 'disk usage above 80%', disk_used_pct: 82, disk_total_gb: 500, disk_used_gb: 410 },
        { _time: '2026-02-06T12:00:00Z', level: 'warn', instance: 'log-agg-01', message: 'disk usage above 90%', disk_used_pct: 91, disk_total_gb: 500, disk_used_gb: 455 },
        { _time: '2026-02-06T13:00:00Z', level: 'error', instance: 'log-agg-01', message: 'index write failed: no space left on device', index: 'logs-2026.02.06', error_code: 'ENOSPC' },
        { _time: '2026-02-06T13:05:00Z', level: 'error', instance: 'log-agg-01', message: 'index write failed: no space left on device', index: 'logs-2026.02.06', error_code: 'ENOSPC' },
        { _time: '2026-02-06T13:10:00Z', level: 'warn', instance: 'log-agg-01', message: 'oldest index on disk', index: 'logs-2025.12.08', age_days: 60, size_gb: 38.7 },
        { _time: '2026-02-06T13:10:00Z', level: 'info', instance: 'log-agg-01', message: 'index inventory', total_indices: 62, oldest_index: 'logs-2025.12.08', newest_index: 'logs-2026.02.06', total_size_gb: 487 },
        { _time: '2026-02-06T13:15:00Z', level: 'error', instance: 'log-agg-01', message: 'ingest pipeline stalled — buffer full', dropped_events: 14823 },
      ],
      'ingest-pipeline-logs': [
        { _time: '2026-02-06T12:00:00Z', level: 'info', service: 'ingest-router', message: 'routing logs to log-agg-01', events_per_sec: 4200 },
        { _time: '2026-02-06T13:00:00Z', level: 'warn', service: 'ingest-router', message: 'backpressure from log-agg-01', queue_depth: 85000, events_dropped: 320 },
        { _time: '2026-02-06T13:05:00Z', level: 'error', service: 'ingest-router', message: 'downstream write rejected', target: 'log-agg-01', error: 'ENOSPC', events_dropped: 4500 },
        { _time: '2026-02-06T13:10:00Z', level: 'error', service: 'ingest-router', message: 'downstream write rejected', target: 'log-agg-01', error: 'ENOSPC', events_dropped: 9800 },
        { _time: '2026-02-06T13:15:00Z', level: 'error', service: 'ingest-router', message: 'circuit breaker open for log-agg-01', events_dropped: 14823 },
      ],
      'k8s-events': [
        { _time: '2026-02-06T13:00:00Z', level: 'warn', namespace: 'logging', kind: 'Pod', name: 'log-agg-01', reason: 'DiskPressure', message: 'ephemeral storage usage exceeds threshold' },
        { _time: '2026-02-06T13:10:00Z', level: 'warn', namespace: 'logging', kind: 'Pod', name: 'log-agg-01', reason: 'Eviction', message: 'pod at risk of eviction due to disk pressure' },
      ],
    },
    metrics: {
      'node_filesystem_avail_bytes': [
        {
          metric: 'node_filesystem_avail_bytes',
          labels: { instance: 'log-agg-01', mountpoint: '/data', device: '/dev/sda1' },
          values: [
            [1738828800, 107374182400],  // 08:00 — 100G free
            [1738836000, 96636764160],   // 10:00 — 90G free
            [1738843200, 48318382080],   // 12:00 — 45G free
            [1738846800, 16106127360],   // 13:00 — 15G free
            [1738848600, 5368709120],    // 13:30 — 5G free
            [1738850400, 1073741824],    // 14:00 — 1G free
          ],
        },
      ],
      'node_filesystem_size_bytes': [
        {
          metric: 'node_filesystem_size_bytes',
          labels: { instance: 'log-agg-01', mountpoint: '/data', device: '/dev/sda1' },
          values: [
            [1738828800, 536870912000],  // 500G total
            [1738850400, 536870912000],
          ],
        },
      ],
      'log_aggregator_ingest_rate': [
        {
          metric: 'log_aggregator_ingest_rate',
          labels: { instance: 'log-agg-01' },
          values: [
            [1738828800, 4200],
            [1738836000, 4150],
            [1738843200, 4180],
            [1738846800, 1200],   // 13:00 — drops as writes fail
            [1738848600, 0],      // 13:30 — fully stalled
            [1738850400, 0],
          ],
        },
      ],
      'log_aggregator_indices_count': [
        {
          metric: 'log_aggregator_indices_count',
          labels: { instance: 'log-agg-01' },
          values: [
            [1738828800, 62],
            [1738836000, 62],
            [1738843200, 62],
            [1738850400, 62],
          ],
        },
      ],
      'log_aggregator_oldest_index_age_days': [
        {
          metric: 'log_aggregator_oldest_index_age_days',
          labels: { instance: 'log-agg-01' },
          values: [
            [1738828800, 60],
            [1738850400, 60],
          ],
        },
      ],
    },
  },
  expected: {
    rootCauseMustMention: ['retention', 'disk', 'indices'],
    rootCauseMustNotMention: ['memory', 'CPU', 'network', 'DDoS'],
    requiredEvidence: [
      { tool: 'scripts/axiom-query', mustMention: ['ENOSPC', 'retention'] },
      { tool: 'scripts/grafana-query', mustMention: ['filesystem', 'disk'] },
    ],
    requiredQueries: [
      {
        tool: 'scripts/axiom-query',
        mustMatch: "\\[(?:'|\")log-aggregator-logs(?:'|\")\\]",
        description: 'Must query log-aggregator-logs dataset for disk errors',
      },
      {
        tool: 'scripts/grafana-query',
        mustMatch: 'node_filesystem|ingest_rate',
        description: 'Must query disk usage or ingest rate metrics',
      },
    ],
  },
  budgets: {
    maxToolCalls: 14,
    maxTotalTokens: 9000,
  },
};
