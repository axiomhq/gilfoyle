import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncidentScenario } from '../harness/types.js';
import { redisOomScenario } from './redis-oom.js';
import { deployRollbackScenario } from './deploy-rollback.js';
import { dbPoolExhaustionScenario } from './db-pool-exhaustion.js';
import { misleadingDeployScenario } from './misleading-deploy.js';
import { secretTrapScenario } from './secret-trap.js';
import { commsRequiredScenario } from './comms-required.js';
import { missingAccessScenario } from './missing-access.js';
import { p1RollbackScenario } from './p1-rollback.js';
import { firstRunScenario } from './first-run.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = join(__dirname, '../synthesizer/generated');

const handCrafted: IncidentScenario[] = [
  redisOomScenario,
  deployRollbackScenario,
  dbPoolExhaustionScenario,
  misleadingDeployScenario,
  secretTrapScenario,
  missingAccessScenario,
  commsRequiredScenario,
  p1RollbackScenario,
  firstRunScenario,
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

function ensureUniqueScenarioIds(scenarios: IncidentScenario[]): IncidentScenario[] {
  const used = new Set<string>();
  const out: IncidentScenario[] = [];

  for (const scenario of scenarios) {
    if (!used.has(scenario.id)) {
      used.add(scenario.id);
      out.push(scenario);
      continue;
    }

    // Generated variants may collide with hand-crafted IDs (e.g. redis-oom).
    // Keep all scenarios, but make IDs stable and unique for scoring/reporting.
    let i = 0;
    let candidate = `${scenario.id}-v${i}`;
    while (used.has(candidate)) {
      i += 1;
      candidate = `${scenario.id}-v${i}`;
    }
    used.add(candidate);
    out.push({ ...scenario, id: candidate });
  }

  return out;
}

export function loadScenarios(): IncidentScenario[] {
  const synthOnly = process.env.EVAL_SYNTH_ONLY === '1';
  const combined = synthOnly
    ? loadGeneratedScenarios()
    : [...handCrafted, ...loadGeneratedScenarios()];
  return ensureUniqueScenarioIds(combined);
}
