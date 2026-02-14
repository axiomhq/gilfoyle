import type { IncidentScenario } from '../harness/types.js';

/**
 * Redis OOM Scenario — Fixture-Driven
 *
 * The agent must:
 * 1. Run init → discover datasets and datasources
 * 2. Query redis-logs for errors → see OOM errors, SET failures
 * 3. Query metrics → see memory climbing, evictions spiking
 * 4. Investigate *why* → dig into key patterns, find session:* keys
 * 5. Discover session keys have ttl=-1 → that's the root cause
 *
 * No query returns "Analysis: root cause is X". The agent must
 * derive the conclusion from raw observability data.
 */

export const redisOomScenario: IncidentScenario = {
  id: 'redis-oom',
  name: 'Redis OOM from session cache leak',
  description: 'Redis memory at 98%, evictions spiking. Session cache missing TTL.',
  prompt: `Alert: Redis memory usage at 98% in prod. Eviction rate spiking.
Pod redis-primary-0 is at risk of OOM kill.
Investigate and find the root cause.`,
  initOutput: `Gilfoyle Environment Discovery
==============================

Axiom Environments:
  prod:
    datasets: [app-logs, redis-logs, k8s-events]

Grafana Environments:
  prod:
    datasources: [prometheus-prod (uid: prom-prod)]

Slack:
  Available (workspace: acme)
`,
  // Legacy mocks empty — fixture-driven
  toolMocks: {},
  fixtures: {
    validDeployments: ['prod'],
    datasources: [
      { uid: 'prom-prod', name: 'prometheus-prod', type: 'prometheus' },
    ],
    datasets: {
      'app-logs': [
        { _time: '2026-02-06T14:30:00Z', level: 'info', service: 'api-gateway', message: 'request completed', status: 200, latency_ms: 45 },
        { _time: '2026-02-06T14:31:00Z', level: 'info', service: 'api-gateway', message: 'request completed', status: 200, latency_ms: 52 },
        { _time: '2026-02-06T14:32:00Z', level: 'warn', service: 'session-service', message: 'redis SET latency elevated', latency_ms: 1200 },
        { _time: '2026-02-06T14:33:00Z', level: 'error', service: 'session-service', message: 'redis SET failed: OOM command not allowed', error_code: 'REDIS_OOM' },
        { _time: '2026-02-06T14:33:30Z', level: 'error', service: 'auth-service', message: 'failed to create session', error: 'REDIS_OOM', user_id: 'u-89012' },
        { _time: '2026-02-06T14:34:00Z', level: 'error', service: 'session-service', message: 'redis SET failed: OOM command not allowed', error_code: 'REDIS_OOM' },
        { _time: '2026-02-06T14:34:30Z', level: 'error', service: 'auth-service', message: 'failed to create session', error: 'REDIS_OOM', user_id: 'u-34567' },
        { _time: '2026-02-06T14:35:00Z', level: 'warn', service: 'api-gateway', message: 'upstream timeout on /api/login', status: 504, latency_ms: 30000 },
      ],
      'redis-logs': [
        { _time: '2026-02-06T14:00:00Z', level: 'info', instance: 'redis-primary-0', message: 'background saving started', used_memory_bytes: 5368709120, used_memory_human: '5.0G', maxmemory_bytes: 8589934592 },
        { _time: '2026-02-06T14:10:00Z', level: 'info', instance: 'redis-primary-0', message: 'keyspace stats', db: 'db0', keys: 1892341, expires: 234102, avg_ttl_ms: 3600000 },
        { _time: '2026-02-06T14:15:00Z', level: 'info', instance: 'redis-primary-0', used_memory_bytes: 6442450944, used_memory_human: '6.0G', maxmemory_bytes: 8589934592 },
        { _time: '2026-02-06T14:20:00Z', level: 'warn', instance: 'redis-primary-0', message: 'memory usage above 75%', used_memory_bytes: 6871947674, used_memory_human: '6.4G', maxmemory_bytes: 8589934592, eviction_policy: 'volatile-lru' },
        { _time: '2026-02-06T14:25:00Z', level: 'warn', instance: 'redis-primary-0', message: 'eviction started', evicted_keys: 3421, eviction_policy: 'volatile-lru' },
        { _time: '2026-02-06T14:30:00Z', level: 'warn', instance: 'redis-primary-0', message: 'memory usage above 90%', used_memory_bytes: 7730941132, used_memory_human: '7.2G', maxmemory_bytes: 8589934592 },
        { _time: '2026-02-06T14:30:00Z', level: 'info', instance: 'redis-primary-0', message: 'keyspace stats', db: 'db0', keys: 2847593, expires: 198412, avg_ttl_ms: 1800000 },
        { _time: '2026-02-06T14:31:00Z', level: 'warn', instance: 'redis-primary-0', message: 'eviction rate increasing', evicted_keys: 15234, eviction_policy: 'volatile-lru' },
        { _time: '2026-02-06T14:32:00Z', level: 'warn', instance: 'redis-primary-0', message: 'volatile-lru eviction ineffective - most keys have no expire', keys_no_expire: 2649181, keys_with_expire: 198412 },
        { _time: '2026-02-06T14:33:00Z', level: 'error', instance: 'redis-primary-0', message: 'OOM command not allowed when used memory > maxmemory', command: 'SET', key_prefix: 'session:user:', used_memory_bytes: 8418263449 },
        { _time: '2026-02-06T14:34:00Z', level: 'error', instance: 'redis-primary-0', message: 'OOM command not allowed when used memory > maxmemory', command: 'SET', key_prefix: 'session:user:', used_memory_bytes: 8504682168 },
        { _time: '2026-02-06T14:35:00Z', level: 'error', instance: 'redis-primary-0', message: 'OOM command not allowed when used memory > maxmemory', command: 'SET', key_prefix: 'session:user:', used_memory_bytes: 8556380160 },
      ],
      'k8s-events': [
        { _time: '2026-02-06T14:33:00Z', level: 'warn', namespace: 'default', kind: 'Pod', name: 'redis-primary-0', reason: 'MemoryPressure', message: 'container memory near limit' },
        { _time: '2026-02-06T14:35:00Z', level: 'warn', namespace: 'default', kind: 'Pod', name: 'redis-primary-0', reason: 'OOMKillRisk', message: 'memory usage 99%, OOM kill imminent' },
      ],
    },
    metrics: {
      'redis_memory_used_bytes': [
        {
          metric: 'redis_memory_used_bytes',
          labels: { instance: 'redis-primary-0', pod: 'redis-primary-0' },
          values: [
            [1738850400, 5368709120],   // 14:00 - 5.0G
            [1738851000, 6442450944],   // 14:10 - 6.0G
            [1738851600, 6871947674],   // 14:20 - 6.4G
            [1738852200, 7730941132],   // 14:30 - 7.2G
            [1738852500, 8100000000],   // 14:35 - 7.5G
            [1738852800, 8418263449],   // 14:40 - 7.8G
            [1738853100, 8556380160],   // 14:45 - 7.97G
          ],
        },
      ],
      'redis_maxmemory_bytes': [
        {
          metric: 'redis_maxmemory_bytes',
          labels: { instance: 'redis-primary-0' },
          values: [
            [1738850400, 8589934592],
            [1738852800, 8589934592],
          ],
        },
      ],
      'redis_evicted_keys_total': [
        {
          metric: 'redis_evicted_keys_total',
          labels: { instance: 'redis-primary-0' },
          values: [
            [1738850400, 0],
            [1738851000, 0],
            [1738851600, 124],
            [1738852200, 3421],
            [1738852500, 15234],
            [1738852800, 43725],
            [1738853100, 84928],
          ],
        },
      ],
      'redis_db_keys': [
        {
          metric: 'redis_db_keys',
          labels: { db: 'db0', instance: 'redis-primary-0' },
          values: [
            [1738850400, 1200000],
            [1738851000, 1892341],
            [1738852200, 2847593],
            [1738852800, 2847593],
          ],
        },
      ],
      'redis_db_keys_expiring': [
        {
          metric: 'redis_db_keys_expiring',
          labels: { db: 'db0', instance: 'redis-primary-0' },
          values: [
            [1738850400, 280000],
            [1738851000, 234102],
            [1738852200, 198412],
            [1738852800, 162301],
          ],
        },
      ],
      'redis_connected_clients': [
        {
          metric: 'redis_connected_clients',
          labels: { instance: 'redis-primary-0' },
          values: [
            [1738850400, 45],
            [1738851000, 48],
            [1738852200, 52],
            [1738852800, 51],
          ],
        },
      ],
    },
  },
  expected: {
    rootCauseMustMention: ['session', 'TTL', 'memory'],
    rootCauseMustNotMention: ['DDoS', 'network', 'CPU'],
    requiredEvidence: [
      { tool: 'scripts/axiom-query', mustMention: ['session', 'OOM'] },
      { tool: 'scripts/grafana-query', mustMention: ['memory', 'evict'] },
    ],
    requiredQueries: [
      {
        tool: 'scripts/axiom-query',
        mustMatch: "\\['redis-logs'\\]",
        description: 'Must query redis-logs dataset (not guess a dataset name)',
      },
      {
        tool: 'scripts/grafana-query',
        mustMatch: 'redis_memory|redis_evicted',
        description: 'Must query redis memory or eviction metrics',
      },
    ],
  },
  budgets: {
    maxToolCalls: 12,
    maxTotalTokens: 8000,
    maxElapsedMs: 220_000,
  },
};
