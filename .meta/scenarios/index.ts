/**
 * Scenario Registry
 *
 * Exports all incident scenarios for evaluation.
 */

import type { IncidentScenario } from '../harness/types.js';
import { redisOomScenario } from './redis-oom.js';
import { deployRollbackScenario } from './deploy-rollback.js';
import { dbPoolExhaustionScenario } from './db-pool-exhaustion.js';

export const scenarios: IncidentScenario[] = [
  redisOomScenario,
  deployRollbackScenario,
  dbPoolExhaustionScenario,
];

export function loadScenarios(): IncidentScenario[] {
  return scenarios;
}

export { redisOomScenario, deployRollbackScenario, dbPoolExhaustionScenario };
