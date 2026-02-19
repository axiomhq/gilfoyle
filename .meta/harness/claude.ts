/**
 * Claude Agent SDK Harness
 *
 * Runs Gilfoyle skill via the Claude Agent SDK (claude-agent-sdk).
 * Spawns a Claude Code subprocess, streams messages, logs tool
 * calls + errors in real time, and returns a RunTrace.
 */

import type { HarnessRunner, IncidentScenario, RunConfig, RunTrace, ToolCall, ToolName, TokenUsage } from './types.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { writeFileSync, mkdirSync, rmSync, readFileSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(__dirname, '../../skill/SKILL.md');
const MOCK_TOOL_PATH = join(__dirname, '../toolbox/mock-tool.ts');

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const MAX_TURNS = 35;

function extractScriptFromBashCmd(cmd: string): ToolName | null {
  const match = cmd.match(/scripts\/(init|discover-axiom|discover-grafana|discover-pyroscope|discover-k8s|discover-slack|axiom-query|grafana-query|slack|mem-write|rollback|flag-revert|axiom-link|grafana-link|pyroscope-link|sentry-link)/);
  if (match) return `scripts/${match[1]}` as ToolName;
  return null;
}

function createMockScript(name: string): string {
  return `#!/bin/bash\nexec bun "${MOCK_TOOL_PATH}" scripts-${name} "$@"\n`;
}

function toolResultToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => typeof c === 'string' ? c : ('text' in c ? String(c.text) : JSON.stringify(c))).join('\n');
  return JSON.stringify(content);
}

export const claudeHarness: HarnessRunner = {
  name: 'claude',

  async run(scenario: IncidentScenario, config: RunConfig): Promise<RunTrace> {
    const start = Date.now();
    const toolCalls: ToolCall[] = [];
    let streamedText = '';
    let resultText: string | undefined;
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    const tmpDir = join(tmpdir(), `gilfoyle-eval-claude-${Date.now()}`);
    const scriptsDir = join(tmpDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });

    const scenarioFile = join(tmpDir, 'scenario.json');
    writeFileSync(scenarioFile, JSON.stringify(scenario));
    copyFileSync(SKILL_PATH, join(tmpDir, 'SKILL.md'));

    const mockScripts = ['init', 'discover-axiom', 'discover-grafana', 'discover-pyroscope', 'discover-k8s', 'discover-slack', 'axiom-query', 'grafana-query', 'slack', 'mem-write', 'rollback', 'flag-revert', 'axiom-link', 'grafana-link', 'pyroscope-link', 'sentry-link'];
    for (const name of mockScripts) {
      const scriptPath = join(scriptsDir, name);
      writeFileSync(scriptPath, createMockScript(name));
      chmodSync(scriptPath, 0o755);
    }

    const elapsed = () => `${((Date.now() - start) / 1000).toFixed(0)}s`;
    const log = (msg: string) => console.error(`[claude] ${scenario.id} (${elapsed()}): ${msg}`);
    const pendingTools = new Map<string, { tool: ToolName; input: unknown }>();
    const model = config.model ?? DEFAULT_MODEL;
    const skillContent = readFileSync(SKILL_PATH, 'utf-8');

    log(`model=${model}`);

    try {
      const prompt = `Investigate this incident:\n\n${scenario.prompt}\n\nRun scripts/init first to discover available environments, then use scripts/axiom-query and scripts/grafana-query to investigate. State your ROOT CAUSE clearly with evidence.`;

      for await (const message of query({
        prompt,
        options: {
          cwd: tmpDir,
          model,
          maxTurns: MAX_TURNS,
          allowDangerouslySkipPermissions: true,
          permissionMode: 'bypassPermissions',
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: skillContent,
          },
          env: {
            ...process.env as Record<string, string>,
            GILFOYLE_SCENARIO_FILE: scenarioFile,
          },
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
              streamedText += `${block.text}\n`;
            } else if (block.type === 'tool_use') {
              if (block.name === 'Bash' && typeof block.input === 'object' && block.input !== null) {
                const cmd = (block.input as { command?: string }).command ?? '';
                const scriptName = extractScriptFromBashCmd(cmd);
                if (scriptName) {
                  log(`TOOL ${scriptName}: ${cmd.slice(0, 120)}`);
                  pendingTools.set(block.id, { tool: scriptName, input: cmd });
                }
              }
            }
          }
        } else if (message.type === 'user') {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block !== 'string' && block.type === 'tool_result') {
                const pending = pendingTools.get(block.tool_use_id);
                if (pending) {
                  const outputStr = toolResultToString(block.content);
                  const isError = block.is_error === true || outputStr.startsWith('error:');
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
          }
        } else if (message.type === 'result') {
          const result = message as Record<string, unknown>;
          const u = result.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
          if (u) {
            usage.inputTokens = u.input_tokens ?? 0;
            usage.outputTokens = u.output_tokens ?? 0;
            usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
            usage.cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
          }
          if (typeof result.total_cost_usd === 'number') {
            usage.costUsd = result.total_cost_usd;
          }
          log(`RESULT: turns=${result.num_turns} cost=$${(result.total_cost_usd as number)?.toFixed(4)} is_error=${result.is_error}`);
          if (result.subtype === 'success') {
            resultText = String(result.result ?? '');
          } else {
            const errors = Array.isArray(result.errors) ? (result.errors as string[]).join('; ') : String(result.subtype);
            log(`RESULT ERROR: ${errors}`);
            streamedText += `\nError (${result.subtype}): ${errors}\n`;
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`HARNESS ERROR: ${errMsg}`);
      streamedText += `\nHARNESS ERROR: ${errMsg}\n`;
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }

    const finalText = (resultText ?? streamedText).trim();
    log(`done: ${toolCalls.length} tool calls, in=${usage.inputTokens} out=${usage.outputTokens}`);
    return { finalText, toolCalls, elapsedMs: Date.now() - start, usage };
  },
};
