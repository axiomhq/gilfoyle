import type { HarnessName, HarnessRunner } from './types.js';
import { ampHarness } from './amp.js';
import { opencodeHarness } from './opencode.js';
import { claudeHarness } from './claude.js';
import { codexHarness } from './codex.js';

const harnesses: Record<HarnessName, HarnessRunner> = {
  amp: ampHarness,
  opencode: opencodeHarness,
  claude: claudeHarness,
  codex: codexHarness,
};

export function getHarness(name: HarnessName): HarnessRunner {
  const harness = harnesses[name];
  if (!harness) throw new Error(`Unknown harness: ${name}. Available: ${Object.keys(harnesses).join(', ')}`);
  return harness;
}

export { ampHarness, opencodeHarness, claudeHarness, codexHarness };
export * from './types.js';
