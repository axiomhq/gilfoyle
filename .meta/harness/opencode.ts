/**
 * OpenCode Harness
 *
 * Runs Gilfoyle skill via OpenCode SDK with mocked scripts.
 * Starts an OpenCode server, creates a session, sends the
 * investigation prompt, and collects tool calls + final text.
 */

import type { HarnessRunner, IncidentScenario, RunConfig, RunTrace, ToolCall, ToolName, TokenUsage } from './types.js';
import { createOpencode } from '@opencode-ai/sdk';
import type { Part, ToolPart } from '@opencode-ai/sdk';
import { writeFileSync, mkdirSync, rmSync, readFileSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(__dirname, '../../SKILL.md');
const MOCK_TOOL_PATH = join(__dirname, '../toolbox/mock-tool.ts');

const DEFAULT_PROVIDER = 'xai';
const DEFAULT_MODEL = 'grok-4-1-fast';
const HARNESS_TIMEOUT_MS = 280_000;

function parseModel(config: RunConfig): { provider: string; model: string } {
  const raw = config.model ?? `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;
  const slash = raw.indexOf('/');
  if (slash > 0) return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
  return { provider: DEFAULT_PROVIDER, model: raw };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Failed to get port')));
      }
    });
    srv.on('error', reject);
  });
}

function createMockScript(name: string, scenarioFile: string): string {
  return `#!/bin/bash\nexport GILFOYLE_SCENARIO_FILE="${scenarioFile}"\nexec bun "${MOCK_TOOL_PATH}" scripts-${name} "$@"\n`;
}

function extractScriptFromCmd(cmd: string): ToolName | null {
  const match = cmd.match(/scripts\/(init|axiom-query|grafana-query|slack|mem-write|rollback|flag-revert|axiom-link)/);
  if (match) return `scripts/${match[1]}` as ToolName;
  return null;
}

function isToolPart(part: Part): part is ToolPart {
  return part.type === 'tool';
}

export const opencodeHarness: HarnessRunner = {
  name: 'opencode',

  async run(scenario: IncidentScenario, config: RunConfig): Promise<RunTrace> {
    const start = Date.now();
    const toolCalls: ToolCall[] = [];
    let finalText = '';
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    const tmpDir = join(tmpdir(), `gilfoyle-eval-oc-${Date.now()}`);
    const scriptsDir = join(tmpDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });

    const scenarioFile = join(tmpDir, 'scenario.json');
    writeFileSync(scenarioFile, JSON.stringify(scenario));
    copyFileSync(SKILL_PATH, join(tmpDir, 'SKILL.md'));

    const mockScripts = ['init', 'axiom-query', 'grafana-query', 'slack', 'mem-write', 'rollback', 'flag-revert', 'axiom-link'];
    for (const name of mockScripts) {
      const scriptPath = join(scriptsDir, name);
      writeFileSync(scriptPath, createMockScript(name, scenarioFile));
      chmodSync(scriptPath, 0o755);
    }

    const skillContent = readFileSync(SKILL_PATH, 'utf-8');
    writeFileSync(join(tmpDir, 'AGENTS.md'), skillContent);

    const debug = process.env.DEBUG_OPENCODE_HARNESS === '1';
    const port = await getFreePort();
    const { provider, model } = parseModel(config);

    if (debug) console.error(`[opencode] ${scenario.id}: using port ${port}, provider=${provider}, model=${model}`);

    let opencode: Awaited<ReturnType<typeof createOpencode>> | undefined;
    try {
      opencode = await createOpencode({
        port,
        config: {
          model: `${provider}/${model}`,
          permission: {
            bash: 'allow',
            edit: 'allow',
          },
        },
      });

      const sessionRes = await opencode.client.session.create({
        body: { title: `eval-${scenario.id}` },
      });
      if (sessionRes.error) throw new Error(`Failed to create session: ${JSON.stringify(sessionRes.error)}`);
      const session = sessionRes.data;

      const prompt = `You are Gilfoyle. Your working directory is ${tmpDir}. Investigate this incident:

${scenario.prompt}

Run scripts/init first to discover available environments, then use scripts/axiom-query and scripts/grafana-query to investigate. State your ROOT CAUSE clearly with evidence.

IMPORTANT: All scripts are in ${scriptsDir}. Run them with the full path. Examples:
  ${scriptsDir}/init
  ${scriptsDir}/axiom-query prod <<< "['app-logs'] | where level == 'error'"
  ${scriptsDir}/grafana-query prod prometheus-prod 'redis_memory_used_bytes'`;

      const promptRes = await withTimeout(
        opencode.client.session.prompt({
          path: { id: session.id },
          body: {
            model: {
              providerID: provider,
              modelID: model,
            },
            parts: [{ type: 'text', text: prompt }],
          },
        }),
        HARNESS_TIMEOUT_MS,
        'session.prompt',
      );
      if (promptRes.error) throw new Error(`Prompt failed: ${JSON.stringify(promptRes.error)}`);

      const messagesRes = await withTimeout(
        opencode.client.session.messages({
          path: { id: session.id },
        }),
        HARNESS_TIMEOUT_MS,
        'session.messages',
      );
      if (messagesRes.error) throw new Error(`Failed to get messages: ${JSON.stringify(messagesRes.error)}`);

      for (const msg of messagesRes.data) {
        if (msg.info.role === 'assistant') {
          const info = msg.info as any;
          if (info.tokens) {
            usage.inputTokens += info.tokens.input ?? 0;
            usage.outputTokens += info.tokens.output ?? 0;
            usage.cacheReadTokens! += info.tokens.cache?.read ?? 0;
            usage.cacheWriteTokens! += info.tokens.cache?.write ?? 0;
            usage.reasoningTokens = (usage.reasoningTokens ?? 0) + (info.tokens.reasoning ?? 0);
          }
          if (typeof info.cost === 'number') {
            usage.costUsd = (usage.costUsd ?? 0) + info.cost;
          }
          for (const part of msg.parts) {
            if (part.type === 'text') {
              finalText += `${part.text}\n`;
            } else if (isToolPart(part) && part.tool === 'bash') {
              const state = part.state as Record<string, unknown>;
              const cmd = ((state.input as { command?: string })?.command) ?? '';
              const scriptName = extractScriptFromCmd(cmd);
              if (scriptName) {
                const output = (state.output as string) ?? '';
                const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
                const isError = state.status !== 'completed' || outputStr.startsWith('error:');
                const errorMessages = isError
                  ? outputStr.split('\n').filter((l: string) => l.startsWith('error:')).map((l: string) => l.slice(7).trim())
                  : [];
                toolCalls.push({
                  tool: scriptName,
                  input: cmd,
                  output,
                  queryValid: !isError,
                  queryErrors: errorMessages.length > 0 ? errorMessages : undefined,
                });
              }
            }
          }
        }
      }

      if (debug) {
        console.error(`[opencode] ${scenario.id}: ${messagesRes.data.length} messages, ${toolCalls.length} tool calls`);
        console.error(`[opencode] token usage: input=${usage.inputTokens} output=${usage.outputTokens} cache_read=${usage.cacheReadTokens} cache_write=${usage.cacheWriteTokens} reasoning=${usage.reasoningTokens ?? 0} cost=$${usage.costUsd?.toFixed(4) ?? '0'}`);
        console.error(`[opencode] final text (first 300): ${finalText.slice(0, 300)}`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[opencode] harness error for ${scenario.id}: ${errMsg}`);
      finalText += `\nHARNESS ERROR: ${errMsg}\n`;
    } finally {
      try { opencode?.server.close(); } catch {}
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }

    return {
      finalText: finalText.trim(),
      toolCalls,
      elapsedMs: Date.now() - start,
      usage,
    };
  },
};
