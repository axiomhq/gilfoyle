/**
 * Pi Harness
 *
 * Runs Gilfoyle skill via Pi Coding Agent with mocked scripts.
 * Captures tool calls + assistant output through Pi session events.
 */

import { getModel } from '@mariozechner/pi-ai';
import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from '@mariozechner/pi-coding-agent';
import { writeFileSync, mkdirSync, rmSync, readFileSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockProcessEnv, installGitShims } from './sandbox.js';
import type { HarnessRunner, IncidentScenario, RunConfig, RunTrace, ToolCall, ToolName, TokenUsage } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(__dirname, '../../skill/SKILL.md');
const MOCK_TOOL_PATH = join(__dirname, '../toolbox/mock-tool.ts');

const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_MODEL = 'claude-opus-4-6';
const DEFAULT_TIMEOUT_MS = 300_000;
const MIN_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 900_000;

type PiProvider = 'google' | 'anthropic' | 'openai';
type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

function createMockScript(name: string, scenarioFile: string): string {
  return `#!/bin/bash\nexport GILFOYLE_SCENARIO_FILE="${scenarioFile}"\nexec bun "${MOCK_TOOL_PATH}" scripts-${name} "$@"\n`;
}

function extractScriptFromBashCommand(cmd: string): ToolName | null {
  const match = cmd.match(
    /scripts\/(init|discover-axiom|discover-grafana|discover-pyroscope|discover-k8s|discover-slack|axiom-query|grafana-query|slack|mem-write|rollback|flag-revert|axiom-link|grafana-link|pyroscope-link|sentry-link)/,
  );
  if (match) return `scripts/${match[1]}` as ToolName;
  return null;
}

function extractBashCommand(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const record = args as Record<string, unknown>;
  if (typeof record.cmd === 'string') return record.cmd;
  if (typeof record.command === 'string') return record.command;
  return '';
}

function extractToolResultText(result: unknown): string {
  if (typeof result === 'string') return result;

  if (result && typeof result === 'object' && 'content' in result && Array.isArray((result as { content: unknown[] }).content)) {
    const textParts: string[] = [];
    for (const block of (result as { content: unknown[] }).content) {
      if (block && typeof block === 'object' && 'type' in block && (block as { type: string }).type === 'text') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string') textParts.push(text);
      }
    }
    if (textParts.length > 0) return textParts.join('\n');
  }

  return JSON.stringify(result);
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

function parseModel(config: RunConfig): { provider: PiProvider; modelID: string } {
  const raw = (config.model || '').trim();
  if (!raw) {
    return { provider: DEFAULT_PROVIDER, modelID: DEFAULT_MODEL };
  }

  let provider = DEFAULT_PROVIDER;
  let modelID = raw;
  const slash = raw.indexOf('/');
  const colon = raw.indexOf(':');
  if (slash > 0) {
    provider = raw.slice(0, slash).trim().toLowerCase();
    modelID = raw.slice(slash + 1).trim();
  } else if (colon > 0) {
    provider = raw.slice(0, colon).trim().toLowerCase();
    modelID = raw.slice(colon + 1).trim();
  }

  if (provider !== 'google' && provider !== 'anthropic' && provider !== 'openai') {
    throw new Error(`Unsupported Pi provider '${provider}'. Use one of: google, anthropic, openai.`);
  }
  if (!modelID) {
    throw new Error('Pi model id is empty.');
  }

  return {
    provider,
    modelID,
  };
}

function resolveThinkingLevel(): PiThinkingLevel {
  const raw = (process.env.PI_THINKING_LEVEL || '').trim().toLowerCase();
  if (raw === 'off' || raw === 'minimal' || raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh') {
    return raw;
  }
  return 'medium';
}

function requireProviderKey(provider: PiProvider): string {
  const keyByProvider: Record<PiProvider, string | undefined> = {
    anthropic: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    google: process.env.GEMINI_API_KEY,
  };
  const key = (keyByProvider[provider] || '').trim();
  if (!key) {
    const envNameByProvider: Record<PiProvider, string> = {
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      google: 'GEMINI_API_KEY',
    };
    throw new Error(`Missing required API key for Pi provider '${provider}': ${envNameByProvider[provider]}`);
  }
  return key;
}

function resolveAuthStorageConfig(provider: PiProvider) {
  const requiredKey = requireProviderKey(provider);
  const anthropicKey = provider === 'anthropic' ? requiredKey : process.env.ANTHROPIC_API_KEY || '__unused__';
  const openaiKey = provider === 'openai' ? requiredKey : process.env.OPENAI_API_KEY || '__unused__';
  const googleKey = provider === 'google' ? requiredKey : process.env.GEMINI_API_KEY || '__unused__';

  return {
    anthropic: { type: 'api_key' as const, key: anthropicKey },
    openai: { type: 'api_key' as const, key: openaiKey },
    google: { type: 'api_key' as const, key: googleKey },
  };
}

function clampTimeoutMs(ms: number): number {
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(ms)));
}

function resolveHarnessTimeoutMs(scenario: IncidentScenario): number {
  const envOverride = parseInt(process.env.EVAL_TIMEOUT_MS ?? '', 10);
  if (Number.isFinite(envOverride) && envOverride > 0) {
    return clampTimeoutMs(envOverride);
  }

  const budgetMs = scenario.budgets?.maxElapsedMs;
  if (Number.isFinite(budgetMs) && (budgetMs ?? 0) > 0) {
    return clampTimeoutMs(Math.max(DEFAULT_TIMEOUT_MS, (budgetMs ?? DEFAULT_TIMEOUT_MS) + 10_000));
  }

  return DEFAULT_TIMEOUT_MS;
}

function removePendingOrderID(ids: string[], id: string): void {
  const idx = ids.indexOf(id);
  if (idx >= 0) ids.splice(idx, 1);
}

export const piHarness: HarnessRunner = {
  name: 'pi',

  async run(scenario: IncidentScenario, config: RunConfig): Promise<RunTrace> {
    const start = Date.now();
    const toolCalls: ToolCall[] = [];
    let finalText = '';
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    const tmpDir = join(tmpdir(), `gilfoyle-eval-pi-${Date.now()}`);
    const scriptsDir = join(tmpDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });

    const scenarioFile = join(tmpDir, 'scenario.json');
    writeFileSync(scenarioFile, JSON.stringify(scenario));
    copyFileSync(SKILL_PATH, join(tmpDir, 'SKILL.md'));

    const mockScripts = [
      'init',
      'discover-axiom',
      'discover-grafana',
      'discover-pyroscope',
      'discover-k8s',
      'discover-slack',
      'axiom-query',
      'grafana-query',
      'slack',
      'mem-write',
      'rollback',
      'flag-revert',
      'axiom-link',
      'grafana-link',
      'pyroscope-link',
      'sentry-link',
    ];
    for (const name of mockScripts) {
      const scriptPath = join(scriptsDir, name);
      writeFileSync(scriptPath, createMockScript(name, scenarioFile));
      chmodSync(scriptPath, 0o755);
    }

    const binDir = installGitShims(tmpDir, scenarioFile, scenario);
    const restoreEnv = blockProcessEnv(binDir);
    const previousScenarioFile = process.env.GILFOYLE_SCENARIO_FILE;
    process.env.GILFOYLE_SCENARIO_FILE = scenarioFile;

    const skillContent = readFileSync(SKILL_PATH, 'utf-8');
    const pendingTools = new Map<string, { tool: ToolName; input: string }>();
    const pendingToolOrder: string[] = [];
    let fallbackToolCallSeq = 0;

    const elapsed = () => `${((Date.now() - start) / 1000).toFixed(0)}s`;
    const log = (msg: string) => console.error(`[pi] ${scenario.id} (${elapsed()}): ${msg}`);

    const { provider, modelID } = parseModel(config);
    const thinkingLevel = resolveThinkingLevel();
    const timeoutMs = resolveHarnessTimeoutMs(scenario);

    log(`provider=${provider} model=${modelID} thinking=${thinkingLevel} timeout=${timeoutMs}ms`);

    let sessionHandle: Awaited<ReturnType<typeof createAgentSession>> | null = null;
    let unsubscribe: (() => void) | null = null;

    try {
      const authStorage = AuthStorage.inMemory(resolveAuthStorageConfig(provider));
      const modelRegistry = new ModelRegistry(authStorage);
      const resourceLoader = new DefaultResourceLoader({
        cwd: tmpDir,
        systemPrompt: skillContent,
      });
      await resourceLoader.reload();

      const model = getModel(provider as any, modelID as any);
      if (!model) {
        throw new Error(`Pi model not found (provider=${provider}, model=${modelID})`);
      }

      sessionHandle = await createAgentSession({
        sessionManager: SessionManager.inMemory(),
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
        authStorage,
        modelRegistry,
        resourceLoader,
        model,
        thinkingLevel,
        tools: createCodingTools(tmpDir),
        cwd: tmpDir,
      });

      sessionHandle.session.setAutoCompactionEnabled(false);

      unsubscribe = sessionHandle.session.subscribe((event: AgentSessionEvent) => {
        switch (event.type) {
          case 'message_end': {
            const message = event.message as { content?: unknown[]; usage?: Record<string, number> };
            if (Array.isArray(message.content)) {
              const textParts: string[] = [];
              for (const block of message.content) {
                if (block && typeof block === 'object' && 'type' in block && (block as { type: string }).type === 'text') {
                  const text = (block as { text?: unknown }).text;
                  if (typeof text === 'string') textParts.push(text);
                }
              }
              if (textParts.length > 0) {
                finalText += `${textParts.join('\n')}\n`;
              }
            }

            if (message.usage) {
              usage.inputTokens += message.usage.input ?? 0;
              usage.outputTokens += message.usage.output ?? 0;
              usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (message.usage.cacheRead ?? 0);
              usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (message.usage.cacheWrite ?? 0);
            }
            break;
          }

          case 'tool_execution_start': {
            const command = extractBashCommand(event.args);
            if (!command) return;

            const scriptName = extractScriptFromBashCommand(command);
            if (!scriptName) return;

            const eventRecord = event as Record<string, unknown>;
            const eventCallID = typeof eventRecord.toolCallId === 'string' ? eventRecord.toolCallId : '';
            const callID = eventCallID || `pi-tool-${fallbackToolCallSeq++}`;

            log(`TOOL ${scriptName}: ${command.slice(0, 120)}`);
            pendingTools.set(callID, { tool: scriptName, input: command });
            pendingToolOrder.push(callID);
            break;
          }

          case 'tool_execution_end': {
            const eventRecord = event as Record<string, unknown>;
            const eventCallID = typeof eventRecord.toolCallId === 'string' ? eventRecord.toolCallId : '';

            let resolvedCallID = eventCallID;
            if (!resolvedCallID || !pendingTools.has(resolvedCallID)) {
              resolvedCallID = pendingToolOrder[0] || '';
            }
            if (!resolvedCallID) return;

            const pending = pendingTools.get(resolvedCallID);
            if (!pending) return;

            pendingTools.delete(resolvedCallID);
            removePendingOrderID(pendingToolOrder, resolvedCallID);

            const output = extractToolResultText(event.result);
            const errors = extractToolErrors(output);
            const failed = event.isError === true || errors !== undefined;

            if (failed) {
              log(`TOOL ${pending.tool} ERROR: ${output.slice(0, 120)}`);
            }

            const isQueryTool = pending.tool === 'scripts/axiom-query' || pending.tool === 'scripts/grafana-query';
            toolCalls.push({
              tool: pending.tool,
              input: pending.input,
              output,
              queryValid: isQueryTool ? !failed : undefined,
              queryErrors: isQueryTool ? errors : undefined,
            });
            break;
          }
        }
      });

      const prompt = `You are Gilfoyle. Investigate this incident:\n\n${scenario.prompt}\n\nRun scripts/init first to discover available environments, then use scripts/axiom-query and scripts/grafana-query to investigate. State your ROOT CAUSE clearly with evidence.`;

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Pi harness timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      try {
        await Promise.race([sessionHandle.session.prompt(prompt), timeoutPromise]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`HARNESS ERROR: ${errMsg}`);
      finalText += `\nHARNESS ERROR: ${errMsg}\n`;
    } finally {
      try {
        unsubscribe?.();
      } catch {
        // ignore cleanup errors
      }
      try {
        if (sessionHandle) {
          await Promise.resolve(sessionHandle.session.dispose());
        }
      } catch {
        // ignore cleanup errors
      }

      restoreEnv();
      if (previousScenarioFile !== undefined) process.env.GILFOYLE_SCENARIO_FILE = previousScenarioFile;
      else delete process.env.GILFOYLE_SCENARIO_FILE;

      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }

    log(`done: ${toolCalls.length} tool calls, in=${usage.inputTokens} out=${usage.outputTokens}`);
    return {
      finalText: finalText.trim(),
      toolCalls,
      usage,
      elapsedMs: Date.now() - start,
    };
  },
};
