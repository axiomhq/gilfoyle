import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { IncidentScenario } from '../harness/types.js';
import { redisOomScenario } from './redis-oom.js';
import { deployRollbackScenario } from './deploy-rollback.js';
import { dbPoolExhaustionScenario } from './db-pool-exhaustion.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = join(__dirname, '../synthesizer/generated');

const handCrafted: IncidentScenario[] = [
  redisOomScenario,
  deployRollbackScenario,
  dbPoolExhaustionScenario,
];

function loadGeneratedScenarios(): IncidentScenario[] {
  if (!existsSync(GENERATED_DIR)) return [];

  const scenarios: IncidentScenario[] = [];
  const files = readdirSync(GENERATED_DIR).filter(f => f.endsWith('.scenarios.json'));

  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(GENERATED_DIR, file), 'utf-8'));
      if (Array.isArray(data)) scenarios.push(...data);
    } catch {
      // Skip malformed files
    }
  }

  return scenarios;
}

export function loadScenarios(): IncidentScenario[] {
  const useSynthesized = process.env.EVAL_SYNTHESIZED === '1';
  const synthOnly = process.env.EVAL_SYNTH_ONLY === '1';

  if (synthOnly) return loadGeneratedScenarios();
  if (useSynthesized) return [...handCrafted, ...loadGeneratedScenarios()];
  return handCrafted;
}
