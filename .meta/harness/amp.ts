/**
 * Amp Harness
 *
 * Runs Gilfoyle skill via the Amp SDK (@sourcegraph/amp-sdk).
 * Streams messages, logs tool calls + errors in real time,
 * collects token usage, and returns a RunTrace.
 */

import type { HarnessRunner, IncidentScenario, RunConfig, RunTrace, ToolCall, ToolName, TokenUsage } from './types.js';
import { execute } from '@sourcegraph/amp-sdk';
import { writeFileSync, mkdirSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(__dirname, '../../skill/SKILL.md');
const MOCK_TOOL_PATH = join(__dirname, '../toolbox/mock-tool.ts');

function extractScriptFromBashCmd(cmd: string): ToolName | null {
  const match = cmd.match(/scripts\/(init|discover-axiom|discover-grafana|discover-pyroscope|discover-k8s|discover-slack|axiom-query|grafana-query|slack|mem-write|rollback|flag-revert|axiom-link|grafana-link|pyroscope-link|sentry-link)/);
  if (match) return `scripts/${match[1]}` as ToolName;

  // Match git/gh commands for bug fix protocol
  if (/\bgit\s+log\b/.test(cmd)) return 'git_log';
  if (/\bgit\s+blame\b/.test(cmd)) return 'git_blame';
  if (/\bgh\s+pr\s+view\b/.test(cmd)) return 'gh_pr_view';
  if (/\bgh\s+pr\s+diff\b/.test(cmd)) return 'gh_pr_diff';
  if (/\bgh\s+repo\s+clone\b/.test(cmd)) return 'gh_repo_clone';

  return null;
}

function createMockScript(name: string): string {
  return `#!/bin/bash\nexec bun "${MOCK_TOOL_PATH}" scripts-${name} "$@"\n`;
}

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

export const ampHarness: HarnessRunner = {
  name: 'amp',

  async run(scenario: IncidentScenario, _config: RunConfig): Promise<RunTrace> {
    const start = Date.now();
    const toolCalls: ToolCall[] = [];
    let finalText = '';
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    const tmpDir = join(tmpdir(), `gilfoyle-eval-${Date.now()}`);
    const scriptsDir = join(tmpDir, 'scripts');
    const binDir = join(tmpDir, 'bin');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    const scenarioFile = join(tmpDir, 'scenario.json');
    writeFileSync(scenarioFile, JSON.stringify(scenario));
    copyFileSync(SKILL_PATH, join(tmpDir, 'SKILL.md'));

    const mockScripts = ['init', 'discover-axiom', 'discover-grafana', 'discover-pyroscope', 'discover-k8s', 'discover-slack', 'axiom-query', 'grafana-query', 'slack', 'mem-write', 'rollback', 'flag-revert', 'axiom-link', 'grafana-link', 'pyroscope-link', 'sentry-link'];
    for (const name of mockScripts) {
      const scriptPath = join(scriptsDir, name);
      writeFileSync(scriptPath, createMockScript(name));
      chmodSync(scriptPath, 0o755);
    }

    // Always install git/gh shims first in PATH so evals never hit real GitHub.
    const enableFixtureBackedMocks = Boolean(
      scenario.fixtures?.gitLog || scenario.fixtures?.gitBlame || scenario.fixtures?.pullRequests,
    );
    writeFileSync(join(binDir, 'git'), createGitShim(scenarioFile, enableFixtureBackedMocks));
    chmodSync(join(binDir, 'git'), 0o755);
    writeFileSync(join(binDir, 'gh'), createGhShim(scenarioFile, enableFixtureBackedMocks));
    chmodSync(join(binDir, 'gh'), 0o755);

    const elapsed = () => `${((Date.now() - start) / 1000).toFixed(0)}s`;
    const log = (msg: string) => console.error(`[amp] ${scenario.id} (${elapsed()}): ${msg}`);
    const pendingTools = new Map<string, { tool: ToolName; input: unknown }>();

    try {
      const bugfixHint = scenario.scoring?.requireBugfixDiligence
        ? `\n\nIf the root cause is a code bug, follow the Bug Fix Protocol: use git log, git blame, and gh pr view to trace the introducing change, understand intent, and report the full chain (PR → code change → failure mechanism).`
        : '';
      const prompt = `You are Gilfoyle. Investigate this incident:\n\n${scenario.prompt}\n\nRun scripts/init first to discover available environments, then use scripts/axiom-query and scripts/grafana-query to investigate. State your ROOT CAUSE clearly with evidence.${bugfixHint}`;

      log('starting');
      for await (const message of execute({
        prompt,
        options: {
          cwd: tmpDir,
          skills: tmpDir,
          env: {
            GILFOYLE_SCENARIO_FILE: scenarioFile,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_TOKEN: '__EVAL_BLOCKED__',
            GITHUB_TOKEN: '__EVAL_BLOCKED__',
          },
          dangerouslyAllowAll: true,
        },
      })) {
        if (message.type === 'assistant') {
          const msgUsage = message.message.usage;
          if (msgUsage) {
            usage.inputTokens += msgUsage.input_tokens ?? 0;
            usage.outputTokens += msgUsage.output_tokens ?? 0;
            usage.cacheReadTokens! += msgUsage.cache_read_input_tokens ?? 0;
            usage.cacheWriteTokens! += msgUsage.cache_creation_input_tokens ?? 0;
          }
          for (const block of message.message.content) {
            if (block.type === 'text') {
              finalText += `${block.text}\n`;
            } else if (block.type === 'tool_use') {
              if (block.name === 'Bash' && typeof block.input === 'object' && block.input !== null) {
                const cmd = (block.input as { cmd?: string }).cmd ?? '';
                const scriptName = extractScriptFromBashCmd(cmd);
                if (scriptName) {
                  log(`TOOL ${scriptName}: ${cmd.slice(0, 120)}`);
                  pendingTools.set(block.id, { tool: scriptName, input: cmd });
                }
              }
            }
          }
        } else if (message.type === 'user') {
          for (const block of message.message.content) {
            if (block.type === 'tool_result') {
              const pending = pendingTools.get(block.tool_use_id);
              if (pending) {
                const outputStr = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                const isError = outputStr.startsWith('error:');
                if (isError) log(`TOOL ${pending.tool} ERROR: ${outputStr.slice(0, 120)}`);
                const errorMessages = isError
                  ? outputStr.split('\n').filter(l => l.startsWith('error:')).map(l => l.slice(7).trim())
                  : [];
                toolCalls.push({
                  tool: pending.tool,
                  input: pending.input,
                  output: block.content,
                  queryValid: !isError,
                  queryErrors: errorMessages.length > 0 ? errorMessages : undefined,
                });
                pendingTools.delete(block.tool_use_id);
              }
            }
          }
        } else if (message.type === 'result') {
          const resultUsage = message.usage;
          if (resultUsage) {
            usage.inputTokens += resultUsage.input_tokens ?? 0;
            usage.outputTokens += resultUsage.output_tokens ?? 0;
            usage.cacheReadTokens! += resultUsage.cache_read_input_tokens ?? 0;
            usage.cacheWriteTokens! += resultUsage.cache_creation_input_tokens ?? 0;
          }
          if (message.is_error) {
            log(`RESULT ERROR: ${message.error}`);
          }
          finalText += (message.is_error ? `\nError: ${message.error}\n` : `${message.result}\n`);
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`HARNESS ERROR: ${errMsg}`);
      finalText += `\nHARNESS ERROR: ${errMsg}\n`;
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }

    log(`done: ${toolCalls.length} tool calls, in=${usage.inputTokens} out=${usage.outputTokens}`);
    return { finalText: finalText.trim(), toolCalls, elapsedMs: Date.now() - start, usage };
  },
};
