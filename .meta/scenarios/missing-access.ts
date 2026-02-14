import type { IncidentScenario } from '../harness/types.js';

/**
 * Missing Access Scenario (T07) — Grafana Unavailable
 *
 * Tests degraded-tooling resilience. Grafana timed out during init,
 * so the agent has zero datasources and no metrics access.
 *
 * The agent must:
 * 1. Run init → see Grafana timed out, only Axiom available
 * 2. Query kafka-logs → find consumer lag errors, rebalancing events
 * 3. Query app-logs → find processing timeouts correlating with lag
 * 4. Synthesize root cause from logs alone (consumer group rebalancing)
 * 5. Explicitly note that Grafana metrics are unavailable and would
 *    help confirm lag magnitude / partition assignment
 *
 * No Grafana queries should succeed. The fixture engine handles this
 * naturally because datasources is empty.
 */

export const missingAccessScenario: IncidentScenario = {
  id: 'missing-access',
  name: 'Kafka consumer lag with Grafana unavailable',
  description: 'Consumer group rebalancing causing message delays. Grafana timed out — Axiom only.',
  prompt: `Alert: order-processor message processing latency exceeded 30s SLO.
Consumer lag growing on partition 0-5 of orders-topic.
Multiple processing timeout errors in the last 10 minutes.
Investigate and find the root cause.`,
  initOutput: `Gilfoyle Environment Discovery
==============================

Axiom Environments:
  prod:
    datasets: [kafka-logs, app-logs]

Grafana Environments:
  prod:
    ⚠ Connection timed out after 10s (prometheus-prod unreachable)
    datasources: [] (discovery failed)

Slack:
  Available (workspace: acme)
`,
  toolMocks: {},
  fixtures: {
    validDeployments: ['prod'],
    datasources: [],
    datasets: {
      'kafka-logs': [
        { _time: '2026-02-06T14:20:00Z', level: 'info', component: 'kafka-consumer', consumer_group: 'order-processor-cg', message: 'consumer heartbeat ok', partition_count: 6, assigned_partitions: [0, 1, 2, 3, 4, 5], lag_total: 120 },
        { _time: '2026-02-06T14:25:00Z', level: 'info', component: 'kafka-consumer', consumer_group: 'order-processor-cg', message: 'consumer heartbeat ok', partition_count: 6, assigned_partitions: [0, 1, 2, 3, 4, 5], lag_total: 95 },
        { _time: '2026-02-06T14:30:00Z', level: 'warn', component: 'kafka-consumer', consumer_group: 'order-processor-cg', message: 'consumer member left group', reason: 'session timeout exceeded', member_id: 'order-processor-2', session_timeout_ms: 10000 },
        { _time: '2026-02-06T14:30:01Z', level: 'warn', component: 'kafka-consumer', consumer_group: 'order-processor-cg', message: 'rebalance triggered', reason: 'member_left', rebalance_protocol: 'eager', generation_id: 42 },
        { _time: '2026-02-06T14:30:02Z', level: 'info', component: 'kafka-consumer', consumer_group: 'order-processor-cg', message: 'revoking partitions', revoked_partitions: [0, 1, 2, 3, 4, 5], member_id: 'order-processor-0' },
        { _time: '2026-02-06T14:30:02Z', level: 'info', component: 'kafka-consumer', consumer_group: 'order-processor-cg', message: 'revoking partitions', revoked_partitions: [0, 1, 2, 3, 4, 5], member_id: 'order-processor-1' },
        { _time: '2026-02-06T14:30:15Z', level: 'info', component: 'kafka-consumer', consumer_group: 'order-processor-cg', message: 'partition assignment complete', generation_id: 43, assigned: { 'order-processor-0': [0, 1, 2], 'order-processor-1': [3, 4, 5] }, total_members: 2 },
        { _time: '2026-02-06T14:31:00Z', level: 'warn', component: 'kafka-consumer', consumer_group: 'order-processor-cg', message: 'consumer lag increasing', partition: 0, lag: 4200, topic: 'orders-topic' },
        { _time: '2026-02-06T14:31:00Z', level: 'warn', component: 'kafka-consumer', consumer_group: 'order-processor-cg', message: 'consumer lag increasing', partition: 1, lag: 3800, topic: 'orders-topic' },
        { _time: '2026-02-06T14:31:00Z', level: 'warn', component: 'kafka-consumer', consumer_group: 'order-processor-cg', message: 'consumer lag increasing', partition: 3, lag: 5100, topic: 'orders-topic' },
        { _time: '2026-02-06T14:32:00Z', level: 'warn', component: 'kafka-consumer', consumer_group: 'order-processor-cg', message: 'consumer member left group', reason: 'session timeout exceeded', member_id: 'order-processor-1', session_timeout_ms: 10000 },
        { _time: '2026-02-06T14:32:01Z', level: 'warn', component: 'kafka-consumer', consumer_group: 'order-processor-cg', message: 'rebalance triggered', reason: 'member_left', rebalance_protocol: 'eager', generation_id: 43 },
        { _time: '2026-02-06T14:32:10Z', level: 'info', component: 'kafka-consumer', consumer_group: 'order-processor-cg', message: 'partition assignment complete', generation_id: 44, assigned: { 'order-processor-0': [0, 1, 2, 3, 4, 5] }, total_members: 1 },
        { _time: '2026-02-06T14:33:00Z', level: 'error', component: 'kafka-consumer', consumer_group: 'order-processor-cg', message: 'consumer lag critical', partition: 0, lag: 18200, topic: 'orders-topic' },
        { _time: '2026-02-06T14:33:00Z', level: 'error', component: 'kafka-consumer', consumer_group: 'order-processor-cg', message: 'consumer lag critical', partition: 3, lag: 22400, topic: 'orders-topic' },
        { _time: '2026-02-06T14:33:00Z', level: 'error', component: 'kafka-consumer', consumer_group: 'order-processor-cg', message: 'consumer lag critical', partition: 5, lag: 19800, topic: 'orders-topic' },
        { _time: '2026-02-06T14:34:00Z', level: 'warn', component: 'kafka-consumer', consumer_group: 'order-processor-cg', message: 'single consumer handling all 6 partitions — throughput degraded', partitions_assigned: 6, max_poll_records: 500, processing_rate_msg_per_sec: 85 },
        { _time: '2026-02-06T14:35:00Z', level: 'error', component: 'kafka-consumer', consumer_group: 'order-processor-cg', message: 'consumer lag critical', partition: 0, lag: 34500, partition_4_lag: 28900, topic: 'orders-topic' },
      ],
      'app-logs': [
        { _time: '2026-02-06T14:25:00Z', level: 'info', service: 'order-processor', message: 'order processed', order_id: 'ord-10001', latency_ms: 145, partition: 2 },
        { _time: '2026-02-06T14:26:00Z', level: 'info', service: 'order-processor', message: 'order processed', order_id: 'ord-10002', latency_ms: 132, partition: 0 },
        { _time: '2026-02-06T14:27:00Z', level: 'info', service: 'order-processor', message: 'order processed', order_id: 'ord-10003', latency_ms: 158, partition: 4 },
        { _time: '2026-02-06T14:30:05Z', level: 'warn', service: 'order-processor', message: 'partition revoked during processing', order_id: 'ord-10010', partition: 3, error: 'rebalance_in_progress' },
        { _time: '2026-02-06T14:30:20Z', level: 'warn', service: 'order-processor', message: 'rebalance complete, resuming consumption', instance: 'order-processor-0', assigned_partitions: [0, 1, 2] },
        { _time: '2026-02-06T14:31:00Z', level: 'warn', service: 'order-processor', message: 'processing backlog detected', pending_messages: 4200, instance: 'order-processor-0' },
        { _time: '2026-02-06T14:32:00Z', level: 'error', service: 'order-processor', message: 'processing timeout exceeded SLO', order_id: 'ord-10045', latency_ms: 32000, slo_ms: 30000, partition: 1 },
        { _time: '2026-02-06T14:32:15Z', level: 'warn', service: 'order-processor', message: 'second rebalance — partitions reassigned', instance: 'order-processor-0', assigned_partitions: [0, 1, 2, 3, 4, 5] },
        { _time: '2026-02-06T14:33:00Z', level: 'error', service: 'order-processor', message: 'processing timeout exceeded SLO', order_id: 'ord-10078', latency_ms: 45000, slo_ms: 30000, partition: 3 },
        { _time: '2026-02-06T14:33:30Z', level: 'error', service: 'order-processor', message: 'processing timeout exceeded SLO', order_id: 'ord-10092', latency_ms: 51000, slo_ms: 30000, partition: 5 },
        { _time: '2026-02-06T14:34:00Z', level: 'error', service: 'order-processor', message: 'message processing falling behind — single instance overloaded', active_threads: 50, max_threads: 50, queue_depth: 12400, instance: 'order-processor-0' },
        { _time: '2026-02-06T14:34:30Z', level: 'error', service: 'order-processor', message: 'processing timeout exceeded SLO', order_id: 'ord-10131', latency_ms: 62000, slo_ms: 30000, partition: 0 },
        { _time: '2026-02-06T14:35:00Z', level: 'error', service: 'order-processor', message: 'downstream order-fulfillment service seeing stale orders', stale_order_count: 847, oldest_pending_minutes: 5 },
      ],
    },
    metrics: {},
  },
  expected: {
    rootCauseMustMention: ['rebalance', 'consumer', 'lag'],
    rootCauseMustNotMention: ['deploy', 'OOM', 'network partition'],
    requiredEvidence: [
      { tool: 'scripts/axiom-query', mustMention: ['rebalance', 'lag'] },
    ],
    requiredQueries: [
      {
        tool: 'scripts/axiom-query',
        mustMatch: "\\[(?:'|\")kafka-logs(?:'|\")\\]",
        description: 'Must query kafka-logs dataset for consumer group events',
      },
      {
        tool: 'scripts/axiom-query',
        mustMatch: "\\[(?:'|\")app-logs(?:'|\")\\]",
        description: 'Must query app-logs dataset for processing timeout evidence',
      },
    ],
  },
  budgets: {
    maxToolCalls: 12,
    maxTotalTokens: 8000,
    maxElapsedMs: 210_000,
  },
};
