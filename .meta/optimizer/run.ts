#!/usr/bin/env bun
/**
 * SKILL.md Optimizer CLI
 *
 * Runs all scenarios, analyzes failures, and suggests SKILL.md edits.
 *
 * Usage:
 *   bun optimizer/run.ts                    # Dry run
 *   bun optimizer/run.ts --apply            # Apply suggested fix
 *   bun optimizer/run.ts --harness=opencode # Use OpenCode harness
 *   bun optimizer/run.ts --verbose          # Show detailed output
 */

import { optimize, type OptimizeOptions } from './optimize.js';
import type { HarnessName, ModelName } from '../harness/types.js';

function parseArgs(): OptimizeOptions {
  const args = process.argv.slice(2);
  const options: OptimizeOptions = {};

  for (const arg of args) {
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg.startsWith('--harness=')) {
      options.harness = arg.split('=')[1] as HarnessName;
    } else if (arg.startsWith('--model=')) {
      options.model = arg.split('=')[1] as ModelName;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
SKILL.md Optimizer

Usage:
  bun optimizer/run.ts [options]

Options:
  --apply           Apply the suggested fix to SKILL.md
  --harness=NAME    Use harness (amp, opencode) [default: amp]
  --model=NAME      Use model [default: claude-opus-4]
  --verbose, -v     Show detailed output
  --help, -h        Show this help

Environment:
  ANTHROPIC_API_KEY   Required for amp harness and optimizer analysis
  XAI_API_KEY         Required for opencode harness
`);
      process.exit(0);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();

  console.log('=== Gilfoyle SKILL.md Optimizer ===\n');

  const result = await optimize(options);

  if (result.failedCount > 0 && !result.applied) {
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
