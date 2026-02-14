import type { HarnessRunner, IncidentScenario, RunConfig, RunTrace } from './types.js';
import { directHarness } from './direct.js';

const DEFAULT_MODEL = 'gpt-5.2-codex';

function normalizeModel(rawModel: string | undefined): string {
  const raw = rawModel?.trim();
  if (!raw) return DEFAULT_MODEL;
  if (raw.startsWith('openai/')) return raw.slice('openai/'.length);
  if (raw.startsWith('openai:')) return raw.slice('openai:'.length);
  return raw;
}

/**
 * Codex Harness
 *
 * Thin wrapper over direct harness that routes to OpenAI Codex models
 * instead of OpenCode's local server workflow.
 */
export const codexHarness: HarnessRunner = {
  name: 'codex',

  async run(scenario: IncidentScenario, config: RunConfig): Promise<RunTrace> {
    const model = normalizeModel(config.model);
    return directHarness.run(scenario, {
      ...config,
      harness: 'direct',
      model,
    });
  },
};
