import type { HarnessRunner, IncidentScenario, RunConfig, RunTrace, ToolCall, ToolName } from './types.js';
import { installGitShims, blockProcessEnv } from './sandbox.js';
import { Codex, type ModelReasoningEffort } from '@openai/codex-sdk';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(__dirname, '../../skill/SKILL.md');
const MOCK_TOOL_PATH = join(__dirname, '../toolbox/mock-tool.ts');
const DEFAULT_MODEL = 'gpt-5.2-codex';

function normalizeModel(rawModel: string | undefined): string {
  const raw = rawModel?.trim();
  if (!raw) return DEFAULT_MODEL;
  if (raw.startsWith('openai/')) return raw.slice('openai/'.length);
  if (raw.startsWith('openai:')) return raw.slice('openai:'.length);
  return raw;
}

function extractScriptFromCmd(cmd: string): ToolName | null {
  const match = cmd.match(/scripts\/(init|discover-axiom|discover-grafana|discover-pyroscope|discover-k8s|discover-slack|axiom-query|grafana-query|slack|mem-write|rollback|flag-revert|axiom-link|grafana-link|pyroscope-link|sentry-link)/);
  if (match) return `scripts/${match[1]}` as ToolName;
  return null;
}

function createMockScript(name: string, scenarioFile: string): string {
  return `#!/bin/bash\nexport GILFOYLE_SCENARIO_FILE="${scenarioFile}"\nexec bun "${MOCK_TOOL_PATH}" scripts-${name} "$@"\n`;
}

function extractToolErrors(output: string): string[] | undefined {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().startsWith('error:'))
    .map((line) => line.replace(/^error:\s*/i, '').trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : undefined;
}

function buildPrompt(tmpDir: string, scriptsDir: string, scenario: IncidentScenario): string {
  return `You are Gilfoyle. Your working directory is ${tmpDir}. Investigate this incident:

${scenario.prompt}

Run scripts/init first to discover available environments, then use scripts/axiom-query and scripts/grafana-query to investigate. State your ROOT CAUSE clearly with evidence.
Do not inspect fixture or scenario files directly; use only the scripts for evidence gathering.

IMPORTANT: All scripts are in ${scriptsDir}. Run them with full paths. Examples:
  ${scriptsDir}/init
  ${scriptsDir}/axiom-query prod <<< "['app-logs'] | where level == 'error'"
  ${scriptsDir}/grafana-query prod prometheus-prod 'redis_memory_used_bytes'`;
}

function resolveReasoningEffort(): ModelReasoningEffort | undefined {
  const raw = (process.env.CODEX_REASONING_EFFORT ?? process.env.EVAL_REASONING_EFFORT ?? '').trim().toLowerCase();
  if (raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh') {
    return raw;
  }
  return undefined;
}

export const codexHarness: HarnessRunner = {
  name: 'codex',

  async run(scenario: IncidentScenario, config: RunConfig): Promise<RunTrace> {
    const start = Date.now();
    const toolCalls: ToolCall[] = [];
    let finalText = '';
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    const tmpDir = join(tmpdir(), `gilfoyle-eval-codex-${Date.now()}`);
    const scriptsDir = join(tmpDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });

    const scenarioFile = join(tmpdir(), `gilfoyle-eval-scenario-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(scenarioFile, JSON.stringify(scenario));
    copyFileSync(SKILL_PATH, join(tmpDir, 'SKILL.md'));

    const skillContent = readFileSync(SKILL_PATH, 'utf-8');
    writeFileSync(join(tmpDir, 'AGENTS.md'), skillContent);

    const mockScripts = ['init', 'discover-axiom', 'discover-grafana', 'discover-pyroscope', 'discover-k8s', 'discover-slack', 'axiom-query', 'grafana-query', 'slack', 'mem-write', 'rollback', 'flag-revert', 'axiom-link', 'grafana-link', 'pyroscope-link', 'sentry-link'];
    for (const name of mockScripts) {
      const scriptPath = join(scriptsDir, name);
      writeFileSync(scriptPath, createMockScript(name, scenarioFile));
      chmodSync(scriptPath, 0o755);
    }

    const binDir = installGitShims(tmpDir, scenarioFile, scenario);

    const apiKey = process.env.CODEX_API_KEY ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY (or CODEX_API_KEY) not set');
    }

    const model = normalizeModel(config.model);
    const reasoningEffort = resolveReasoningEffort();
    const codex = new Codex({
      apiKey,
      baseUrl: process.env.OPENAI_BASE_URL,
    });

    const restoreEnv = blockProcessEnv(binDir);

    try {
      const thread = codex.startThread({
        model,
        workingDirectory: tmpDir,
        skipGitRepoCheck: true,
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        webSearchMode: 'disabled',
        ...(reasoningEffort ? { modelReasoningEffort: reasoningEffort } : {}),
      });

      const { events } = await thread.runStreamed(buildPrompt(tmpDir, scriptsDir, scenario));

      for await (const event of events) {
        if (event.type === 'item.completed') {
          if (event.item.type === 'agent_message') {
            finalText += `${event.item.text}\n`;
          } else if (event.item.type === 'command_execution') {
            const scriptName = extractScriptFromCmd(event.item.command);
            if (!scriptName) continue;

            const output = event.item.aggregated_output ?? '';
            const errors = extractToolErrors(output);
            const isQueryTool = scriptName === 'scripts/axiom-query' || scriptName === 'scripts/grafana-query';
            const failed = event.item.status === 'failed' || (event.item.exit_code !== undefined && event.item.exit_code !== 0);
            const queryInvalid = isQueryTool ? (failed || errors !== undefined) : undefined;

            toolCalls.push({
              tool: scriptName,
              input: event.item.command,
              output,
              queryValid: isQueryTool ? !queryInvalid : undefined,
              queryErrors: isQueryTool ? errors : undefined,
            });
          }
        } else if (event.type === 'turn.completed') {
          const cachedInput = event.usage.cached_input_tokens ?? 0;
          // OpenAI includes cached tokens inside input_tokens — subtract
          // them so inputTokens means "net new" like other providers.
          usage.inputTokens += Math.max(0, (event.usage.input_tokens ?? 0) - cachedInput);
          usage.outputTokens += event.usage.output_tokens ?? 0;
          usage.cacheReadTokens += cachedInput;
        } else if (event.type === 'turn.failed') {
          finalText += `\nHARNESS ERROR: ${event.error.message}\n`;
        } else if (event.type === 'error') {
          finalText += `\nHARNESS ERROR: ${event.message}\n`;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      finalText += `\nHARNESS ERROR: ${msg}\n`;
    } finally {
      restoreEnv();
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
      try {
        rmSync(scenarioFile, { force: true });
      } catch {
        // ignore cleanup errors
      }
    }

    return {
      finalText: finalText.trim(),
      toolCalls,
      usage,
      elapsedMs: Date.now() - start,
    };
  },
};
