import type { ScenarioSeed } from '../types.js';

export const seed: ScenarioSeed = {
  id: 'kafka-lag',
  name: 'Kafka consumer lag from slow downstream',
  archetype: 'dependency_failure',

  topology: {
    services: ['event-processor', 'notification-service', 'email-gateway', 'api-gateway', 'analytics-worker'],
    primaryFaultService: 'email-gateway',
    affectedServices: ['event-processor', 'notification-service'],
  },

  rootCause: {
    mechanism: 'Email gateway SMTP connection pool exhausted due to rate limiting by upstream provider, causing consumer lag to spike as notification-service backs up',
    category: 'dependency',
    components: ['kafka', 'email-gateway', 'smtp'],
    mustSurfaceClues: ['consumer_lag', 'smtp', 'rate_limit', 'email', 'backpressure'],
  },

  alertPrompt: `Alert: Kafka consumer group "notifications" lag at 450,000 messages and growing.
notification-service pods healthy but processing rate near zero.
Users reporting delayed email notifications (30+ minutes).
Investigate and find the root cause.`,

  difficulty: {
    stepsToRootCause: 4,
    signalBuriedness: 2,
    redHerringCount: 2,
  },

  messiness: {
    fieldWidth: [30, 50],
    nullRate: 0.2,
    jsonEncodedRate: 0.15,
    casingDrift: 0.25,
    aliasRate: 0.35,
  },

  timeRangeMinutes: 120,
  variations: 3,
};

export default seed;
