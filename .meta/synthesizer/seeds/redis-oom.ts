import type { ScenarioSeed } from '../types.js';

export const seed: ScenarioSeed = {
  id: 'redis-oom',
  name: 'Redis OOM from session cache leak',
  archetype: 'resource_exhaustion',

  topology: {
    services: ['api-gateway', 'auth-service', 'session-service', 'user-service', 'payment-service'],
    primaryFaultService: 'session-service',
    affectedServices: ['api-gateway', 'auth-service', 'session-service'],
  },

  rootCause: {
    mechanism: 'Session keys stored in Redis without TTL, causing unbounded memory growth until OOM',
    category: 'code',
    components: ['redis', 'session-service'],
    mustSurfaceClues: ['session', 'ttl', 'expire', 'memory', 'OOM'],
  },

  alertPrompt: `Alert: Redis memory usage at 98% in prod. Eviction rate spiking.
Pod redis-primary-0 is at risk of OOM kill.
Investigate and find the root cause.`,

  difficulty: {
    stepsToRootCause: 3,
    signalBuriedness: 1,
    redHerringCount: 2,
  },

  messiness: {
    fieldWidth: [25, 45],
    nullRate: 0.15,
    jsonEncodedRate: 0.1,
    casingDrift: 0.2,
    aliasRate: 0.3,
  },

  timeRangeMinutes: 60,
  variations: 3,
};

export default seed;
