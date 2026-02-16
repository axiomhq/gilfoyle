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
const SKILL_PATH = join(__dirname, '../../SKILL.md');
const MOCK_TOOL_PATH = join(__dirname, '../toolbox/mock-tool.ts');

function extractScriptFromBashCmd(cmd: string): ToolName | null {
  const match = cmd.match(/scripts\/(init|axiom-query|grafana-query|slack|mem-write|rollback|flag-revert|axiom-link|grafana-link|pyroscope-link|sentry-link)/);
  if (match) return `scripts/${match[1]}` as ToolName;
  return null;
}

function createMockScript(name: string): string {
  return `#!/bin/bash\nexec bun "${MOCK_TOOL_PATH}" scripts-${name} "$@"\n`;
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
    mkdirSync(scriptsDir, { recursive: true });

    const scenarioFile = join(tmpDir, 'scenario.json');
    writeFileSync(scenarioFile, JSON.stringify(scenario));
    copyFileSync(SKILL_PATH, join(tmpDir, 'SKILL.md'));

    const mockScripts = ['init', 'axiom-query', 'grafana-query', 'slack', 'mem-write', 'rollback', 'flag-revert', 'axiom-link', 'grafana-link', 'pyroscope-link', 'sentry-link'];
    for (const name of mockScripts) {
      const scriptPath = join(scriptsDir, name);
      writeFileSync(scriptPath, createMockScript(name));
      chmodSync(scriptPath, 0o755);
    }

    const elapsed = () => `${((Date.now() - start) / 1000).toFixed(0)}s`;
    const log = (msg: string) => console.error(`[amp] ${scenario.id} (${elapsed()}): ${msg}`);
    const pendingTools = new Map<string, { tool: ToolName; input: unknown }>();

    try {
      const prompt = `You are Gilfoyle. Investigate this incident:\n\n${scenario.prompt}\n\nRun scripts/init first to discover available environments, then use scripts/axiom-query and scripts/grafana-query to investigate. State your ROOT CAUSE clearly with evidence.`;

      log('starting');
      for await (const message of execute({
        prompt,
        options: {
          cwd: tmpDir,
          skills: tmpDir,
          env: { GILFOYLE_SCENARIO_FILE: scenarioFile },
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
