import type { HarnessName, HarnessRunner } from './types.js';
import { ampHarness } from './amp.js';
import { opencodeHarness } from './opencode.js';
import { directHarness } from './direct.js';

const harnesses: Record<HarnessName, HarnessRunner> = {
  amp: ampHarness,
  opencode: opencodeHarness,
  direct: directHarness,
};

export function getHarness(name: HarnessName): HarnessRunner {
  const harness = harnesses[name];
  if (!harness) throw new Error(`Unknown harness: ${name}. Available: ${Object.keys(harnesses).join(', ')}`);
  return harness;
}

export { ampHarness, opencodeHarness, directHarness };
export * from './types.js';
