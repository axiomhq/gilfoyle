import type { ScenarioSeed } from '../types.js';

export const seed: ScenarioSeed = {
  id: 'goroutine-leak',
  name: 'Goroutine leak in websocket handler',
  archetype: 'resource_leak',

  topology: {
    services: ['websocket-gateway', 'api-gateway', 'presence-service', 'chat-service', 'message-broker'],
    primaryFaultService: 'websocket-gateway',
    affectedServices: ['websocket-gateway', 'presence-service'],
  },

  rootCause: {
    mechanism: 'WebSocket disconnect handler not cancelling context, leaving goroutines blocked on channel read. Goroutine count grows linearly with disconnects until OOM.',
    category: 'code',
    components: ['websocket-gateway', 'goroutines'],
    mustSurfaceClues: ['goroutine', 'websocket', 'disconnect', 'context', 'leak'],
  },

  alertPrompt: `Alert: websocket-gateway memory usage at 85% and climbing steadily.
Pod restarts happening every ~4 hours due to OOM.
No traffic increase. CPU normal. Connection count stable at ~5000.
Started 2 days ago after deploy v3.8.0.
Investigate and find the root cause.`,

  difficulty: {
    stepsToRootCause: 4,
    signalBuriedness: 2,
    redHerringCount: 3,
  },

  messiness: {
    fieldWidth: [30, 50],
    nullRate: 0.2,
    jsonEncodedRate: 0.12,
    casingDrift: 0.2,
    aliasRate: 0.3,
  },

  timeRangeMinutes: 240,
  variations: 3,
};

export default seed;
