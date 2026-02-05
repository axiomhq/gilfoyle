/**
 * Scenario: Redis OOM Kill
 *
 * Redis memory usage spiking, evictions increasing.
 * Root cause: Session cache has no TTL, memory grows unbounded.
 */

import type { IncidentScenario } from '../harness/types.js';

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

  toolMocks: {
    axiom: [
      {
        when: { contains: ['redis', 'memory', 'error'] },
        return: {
          rows: [
            { _time: '2026-02-06T14:32:10Z', level: 'warn', message: 'memory usage above 90%', used_memory_human: '7.2G', maxmemory_human: '8G' },
            { _time: '2026-02-06T14:35:22Z', level: 'error', message: 'OOM command not allowed when used memory > maxmemory', command: 'SET' },
          ],
        },
      },
      {
        when: { contains: ['redis', 'key', 'session'] },
        return: {
          rows: [
            { _time: '2026-02-06T14:30:00Z', key_pattern: 'session:*', count: 2847593, avg_ttl: -1, message: 'no TTL set' },
          ],
        },
      },
      {
        when: { contains: ['session', 'ttl'] },
        return: {
          rows: [
            { _time: '2026-02-06T14:30:00Z', key: 'session:user:12345', ttl: -1, size_bytes: 4096 },
            { _time: '2026-02-06T14:30:00Z', key: 'session:user:67890', ttl: -1, size_bytes: 3892 },
            { _time: '2026-02-06T14:30:00Z', message: 'Analysis: 2.8M session keys with no TTL consuming 6.1GB' },
          ],
        },
      },
      {
        when: { contains: ['evict'] },
        return: {
          rows: [
            { _time: '2026-02-06T14:32:00Z', evicted_keys: 15234, policy: 'volatile-lru' },
            { _time: '2026-02-06T14:33:00Z', evicted_keys: 28491, policy: 'volatile-lru' },
            { _time: '2026-02-06T14:34:00Z', evicted_keys: 41203, policy: 'volatile-lru' },
          ],
        },
      },
    ],
    grafana: [
      {
        when: { contains: ['redis_memory'] },
        return: {
          series: [
            { metric: 'redis_memory_used_bytes', values: [[1738850400, 7730941132], [1738850460, 7784628224], [1738850520, 7838315316]] },
          ],
        },
      },
      {
        when: { contains: ['redis_evicted'] },
        return: {
          series: [
            { metric: 'redis_evicted_keys_total', values: [[1738850400, 15234], [1738850460, 43725], [1738850520, 84928]] },
          ],
        },
      },
    ],
    slack: [
      {
        when: { contains: ['chat.postMessage'] },
        return: { ok: true, ts: '1738850600.000100' },
      },
    ],
  },

  expected: {
    rootCauseMustMention: ['session', 'TTL', 'memory'],
    rootCauseMustNotMention: ['DDoS', 'network', 'CPU'],
    requiredEvidence: [
      { tool: 'scripts/axiom-query', mustMention: ['session', 'TTL'] },
    ],
  },

  budgets: {
    maxToolCalls: 10,
    maxTotalTokens: 8000,
  },
};
