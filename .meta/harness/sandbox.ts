/**
 * Eval Sandbox — shared safety infrastructure for all harnesses.
 *
 * Prevents eval agents from hitting real GitHub (or other external services)
 * by installing CLI shims and blocking tokens.
 */

import { writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncidentScenario } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_TOOL_PATH = join(__dirname, '../toolbox/mock-tool.ts');

function createGitShim(scenarioFile: string, enableFixtureBackedMocks: boolean): string {
  if (enableFixtureBackedMocks) {
    return `#!/bin/bash
export GILFOYLE_SCENARIO_FILE="${scenarioFile}"
case "$1" in
  log)   shift; exec bun "${MOCK_TOOL_PATH}" mock-git-log "$@" ;;
  blame) shift; exec bun "${MOCK_TOOL_PATH}" mock-git-blame "$@" ;;
  *)
    echo "error: git command blocked by eval harness (allowed: log, blame)" >&2
    exit 1
    ;;
esac
`;
  }

  return `#!/bin/bash
echo "error: git command blocked by eval harness" >&2
exit 1
`;
}

function createGhShim(scenarioFile: string, enableFixtureBackedMocks: boolean): string {
  if (enableFixtureBackedMocks) {
    return `#!/bin/bash
export GILFOYLE_SCENARIO_FILE="${scenarioFile}"
case "$1:$2" in
  pr:view)   shift 2; exec bun "${MOCK_TOOL_PATH}" mock-gh-pr-view "$@" ;;
  pr:diff)   shift 2; exec bun "${MOCK_TOOL_PATH}" mock-gh-pr-diff "$@" ;;
  repo:clone) shift 2; exec bun "${MOCK_TOOL_PATH}" mock-gh-repo-clone "$@" ;;
  *)
    echo "error: gh command blocked by eval harness (allowed: pr view, pr diff, repo clone)" >&2
    exit 1
    ;;
esac
`;
  }

  return `#!/bin/bash
echo "error: gh command blocked by eval harness" >&2
exit 1
`;
}

/**
 * Install git/gh shims into binDir that intercept CLI calls during evals.
 * Returns the binDir path (must be prepended to PATH by the caller).
 */
export function installGitShims(tmpDir: string, scenarioFile: string, scenario: IncidentScenario): string {
  const binDir = join(tmpDir, 'bin');
  mkdirSync(binDir, { recursive: true });

  const enableFixtureBackedMocks = Boolean(
    scenario.fixtures?.gitLog || scenario.fixtures?.gitBlame || scenario.fixtures?.pullRequests,
  );

  writeFileSync(join(binDir, 'git'), createGitShim(scenarioFile, enableFixtureBackedMocks));
  chmodSync(join(binDir, 'git'), 0o755);
  writeFileSync(join(binDir, 'gh'), createGhShim(scenarioFile, enableFixtureBackedMocks));
  chmodSync(join(binDir, 'gh'), 0o755);

  return binDir;
}

/** Env overrides that block real GitHub access. Merge into your env config. */
export function blockedGitHubEnv(binDir: string): Record<string, string> {
  return {
    PATH: `${binDir}:${process.env.PATH}`,
    GH_TOKEN: '__EVAL_BLOCKED__',
    GITHUB_TOKEN: '__EVAL_BLOCKED__',
  };
}

/**
 * Temporarily mutate process.env to block GitHub access.
 * Returns a restore function to call in `finally`.
 *
 * Use this for harnesses (opencode, codex) that spawn subprocesses
 * inheriting process.env rather than accepting an env config object.
 */
export function blockProcessEnv(binDir: string): () => void {
  const prev = {
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    PATH: process.env.PATH,
  };

  process.env.GH_TOKEN = '__EVAL_BLOCKED__';
  process.env.GITHUB_TOKEN = '__EVAL_BLOCKED__';
  process.env.PATH = `${binDir}:${prev.PATH}`;

  return () => {
    for (const [key, val] of Object.entries(prev)) {
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    }
  };
}
