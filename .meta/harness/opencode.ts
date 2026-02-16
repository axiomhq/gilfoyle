/**
 * OpenCode Harness
 *
 * Runs Gilfoyle skill via OpenCode SDK with mocked scripts.
 * Uses promptAsync + event stream for full visibility into
 * what the agent is doing (tool calls, errors, retries).
 */

import type { HarnessRunner, IncidentScenario, RunConfig, RunTrace, ToolCall, ToolName, TokenUsage } from './types.js';
import { createOpencode } from '@opencode-ai/sdk';
import type { Part, ToolPart } from '@opencode-ai/sdk';
import { writeFileSync, mkdirSync, rmSync, readFileSync, copyFileSync, chmodSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const OPENCODE_CACHE_PACKAGE_JSON = JSON.stringify({
  dependencies: { 'opencode-anthropic-auth': '0.0.13', 'jose': '^5.9.6' },
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(__dirname, '../../skill/SKILL.md');
const MOCK_TOOL_PATH = join(__dirname, '../toolbox/mock-tool.ts');

const DEFAULT_PROVIDER = 'xai';
const DEFAULT_MODEL = 'grok-4-1-fast';
const DEFAULT_TIMEOUT_MS = 295_000;
const MIN_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 295_000;
const STATUS_POLL_INTERVAL_MS = 2_000;

function parseModel(config: RunConfig): { provider: string; model: string; format: 'colon' | 'slash' } {
  const raw = config.model ?? `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;
  const slash = raw.indexOf('/');
  if (slash > 0) return { provider: raw.slice(0, slash), model: raw.slice(slash + 1), format: 'slash' };
  const colon = raw.indexOf(':');
  if (colon > 0) return { provider: raw.slice(0, colon), model: raw.slice(colon + 1), format: 'colon' };
  return { provider: DEFAULT_PROVIDER, model: raw, format: 'slash' };
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
  const match = cmd.match(/scripts\/(init|axiom-query|grafana-query|slack|mem-write|rollback|flag-revert|axiom-link|grafana-link|pyroscope-link|sentry-link)/);
  if (match) return `scripts/${match[1]}` as ToolName;
  return null;
}

function isToolPart(part: Part): part is ToolPart {
  return part.type === 'tool';
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
    // Never shrink below default headroom; only stretch when budgets exceed it.
    return clampTimeoutMs(
      Math.max(DEFAULT_TIMEOUT_MS, (budgetMs ?? DEFAULT_TIMEOUT_MS) + 10_000),
    );
  }

  return DEFAULT_TIMEOUT_MS;
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

    const mockScripts = ['init', 'axiom-query', 'grafana-query', 'slack', 'mem-write', 'rollback', 'flag-revert', 'axiom-link', 'grafana-link', 'pyroscope-link', 'sentry-link'];
    for (const name of mockScripts) {
      const scriptPath = join(scriptsDir, name);
      writeFileSync(scriptPath, createMockScript(name, scenarioFile));
      chmodSync(scriptPath, 0o755);
    }

    const skillContent = readFileSync(SKILL_PATH, 'utf-8');
    writeFileSync(join(tmpDir, 'AGENTS.md'), skillContent);

    const elapsed = () => `${((Date.now() - start) / 1000).toFixed(0)}s`;
    const log = (msg: string) => console.error(`[opencode] ${scenario.id} (${elapsed()}): ${msg}`);
    const harnessTimeoutMs = resolveHarnessTimeoutMs(scenario);

    const port = await getFreePort();
    const { provider, model, format } = parseModel(config);
    log(`port=${port} provider=${provider} model=${model} format=${format} timeout=${harnessTimeoutMs}ms`);

    let opencode: Awaited<ReturnType<typeof createOpencode>> | undefined;
    let eventAbort: AbortController | undefined;
    const prevXdgCache = process.env.XDG_CACHE_HOME;

    try {
      // Isolate each server's cache to prevent concurrent processes from
      // corrupting each other's jose/opencode-anthropic-auth installs.
      const cacheHome = join(tmpDir, '.cache');
      const ocCacheDir = join(cacheHome, 'opencode');
      mkdirSync(ocCacheDir, { recursive: true });
      writeFileSync(join(ocCacheDir, 'package.json'), OPENCODE_CACHE_PACKAGE_JSON);
      execSync('bun install', { cwd: ocCacheDir, stdio: 'pipe' });
      process.env.XDG_CACHE_HOME = cacheHome;
      log(`isolated cache: ${cacheHome}`);

      opencode = await createOpencode({
        port,
        config: {
          model: format === 'colon' ? `${provider}:${model}` : `${provider}/${model}`,
          permission: {
            bash: 'allow',
            edit: 'allow',
          },
        },
      });

      // Restore XDG_CACHE_HOME now that the server process has inherited it
      if (prevXdgCache !== undefined) process.env.XDG_CACHE_HOME = prevXdgCache;
      else delete process.env.XDG_CACHE_HOME;

      // Subscribe to event stream for real-time visibility
      eventAbort = new AbortController();
      let lastError: string | undefined;
      const eventPromise = (async () => {
        try {
          const eventRes = await opencode!.client.global.event({ signal: eventAbort!.signal });
          if (!eventRes.stream) return;
          for await (const rawEvent of eventRes.stream) {
            // GlobalEvent wraps the real event: { directory, payload: Event }
            const raw = rawEvent as Record<string, unknown>;
            const e = (raw.payload ?? raw) as Record<string, unknown>;
            const type = (e.type as string) ?? 'unknown';
            const props = e.properties as Record<string, unknown> | undefined;

            if (type === 'session.status') {
              const status = (props?.status as Record<string, unknown>) ?? props;
              const statusType = (status?.type as string) ?? JSON.stringify(status);
              if (statusType === 'retry') {
                log(`EVT retry: attempt=${status?.attempt} msg="${status?.message}" next=${status?.next}`);
              }
            } else if (type === 'session.error') {
              const err = props?.error as Record<string, unknown> | undefined;
              const errMsg = (err?.message as string) ?? JSON.stringify(err ?? props);
              lastError = errMsg;
              log(`EVT ERROR: ${errMsg}`);
            } else if (type === 'permission.updated' || type === 'permission.asked') {
              const permId = props?.id as string | undefined;
              const permSession = props?.sessionID as string | undefined;
              const permTitle = props?.title as string | undefined;
              log(`EVT PERMISSION: "${permTitle}" — auto-approving`);
              if (permId && permSession) {
                opencode!.client.postSessionIdPermissionsPermissionId({
                  path: { id: permSession, permissionID: permId },
                  body: { response: 'always' },
                }).catch((err: Error) => log(`permission approve failed: ${err.message}`));
              }
            } else if (type === 'message.part.updated') {
              const part = props?.part as Record<string, unknown> | undefined;
              if (part?.type === 'tool') {
                const tool = part?.tool as string;
                const state = part?.state as Record<string, unknown> | undefined;
                const input = state?.input as Record<string, unknown> | undefined;
                const status = state?.status as string | undefined;
                if (status === 'running') {
                  log(`EVT TOOL ${tool}: ${JSON.stringify(input).slice(0, 120)}`);
                } else if (status === 'completed' || status === 'error') {
                  const output = String(state?.output ?? '').slice(0, 120);
                  log(`EVT TOOL ${tool} ${status}: ${output}`);
                }
              }
            } else if (type !== 'session.idle' && type !== 'message.updated') {
              log(`EVT ${type}`);
            }
          }
        } catch {
          // Event stream closed — expected on cleanup
        }
      })();

      // Wait for API readiness via /global/health — createOpencode resolves when
      // the port is listening, but routes aren't registered yet (known SDK issue,
      // see github.com/anomalyco/opencode/issues/7060). Without this, the first
      // session.create hits Bun's HTML fallback instead of JSON.
      const healthUrl = `${opencode.server.url}/global/health`;
      const MAX_READY_ATTEMPTS = 20;
      const READY_DELAY_MS = 250;
      for (let attempt = 1; attempt <= MAX_READY_ATTEMPTS; attempt++) {
        try {
          const res = await fetch(healthUrl);
          if (res.ok) {
            const body = await res.json() as { healthy?: boolean };
            if (body.healthy) {
              log(`API ready (attempt ${attempt})`);
              break;
            }
          }
        } catch {
          // fetch throws on connection refused — server not listening yet
        }
        if (attempt === MAX_READY_ATTEMPTS) {
          throw new Error(`Server never became healthy after ${MAX_READY_ATTEMPTS * READY_DELAY_MS}ms`);
        }
        await new Promise(r => setTimeout(r, READY_DELAY_MS));
      }

      const sessionRes = await opencode.client.session.create({
        body: { title: `eval-${scenario.id}` },
      });
      if (sessionRes.error) throw new Error(`Failed to create session: ${JSON.stringify(sessionRes.error)}`);
      const sessionId = sessionRes.data.id;

      const prompt = `You are Gilfoyle. Your working directory is ${tmpDir}. Investigate this incident:

${scenario.prompt}

Run scripts/init first to discover available environments, then use scripts/axiom-query and scripts/grafana-query to investigate. State your ROOT CAUSE clearly with evidence.

IMPORTANT: All scripts are in ${scriptsDir}. Run them with the full path. Examples:
  ${scriptsDir}/init
  ${scriptsDir}/axiom-query prod <<< "['app-logs'] | where level == 'error'"
  ${scriptsDir}/grafana-query prod prometheus-prod 'redis_memory_used_bytes'`;

      // Fire prompt asynchronously — don't block
      log('sending promptAsync');
      const promptRes = await opencode.client.session.promptAsync({
        path: { id: sessionId },
        body: {
          model: { providerID: provider, modelID: model },
          parts: [{ type: 'text', text: prompt }],
        },
      });
      if (promptRes.error) throw new Error(`promptAsync failed: ${JSON.stringify(promptRes.error)}`);

      // Poll session status until idle or timeout
      // OpenCode sessions go busy → idle, or busy → disappear from map
      const deadline = Date.now() + harnessTimeoutMs;
      let settled = false;
      let pollCount = 0;
      let sawBusy = false;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, STATUS_POLL_INTERVAL_MS));
        pollCount++;

        try {
          const statusRes = await opencode.client.session.status({});
          if (statusRes.error) {
            log(`status poll error: ${JSON.stringify(statusRes.error)}`);
            continue;
          }

          const statusMap = statusRes.data as Record<string, Record<string, unknown>>;
          const status = statusMap?.[sessionId];
          const statusType = (status?.type as string) ?? 'gone';

          if (statusType === 'busy') sawBusy = true;

          if (pollCount <= 3 || pollCount % 10 === 0) {
            log(`poll #${pollCount}: status=${statusType}`);
          }

          const isDone = statusType === 'idle'
            || (sawBusy && statusType === 'gone');

          if (isDone) {
            log(`session ${statusType === 'idle' ? 'idle' : 'completed'}`);
            settled = true;
            break;
          }
        } catch (pollErr) {
          log(`status poll threw: ${(pollErr as Error).message}`);
        }
      }

      if (!settled) {
        log('TIMEOUT — aborting session');
        try { await opencode.client.session.abort({ path: { id: sessionId } }); } catch {}
        if (lastError) {
          finalText += `\nHARNESS TIMEOUT (last error: ${lastError})\n`;
        } else {
          finalText += `\nHARNESS TIMEOUT after ${harnessTimeoutMs}ms\n`;
        }
      }

      // Collect messages
      const messagesRes = await opencode.client.session.messages({
        path: { id: sessionId },
      });
      if (messagesRes.error) throw new Error(`Failed to get messages: ${JSON.stringify(messagesRes.error)}`);

      for (const msg of messagesRes.data) {
        if (msg.info.role === 'assistant') {
          const info = msg.info as Record<string, unknown>;
          const tokens = info.tokens as Record<string, unknown> | undefined;
          if (tokens) {
            usage.inputTokens += (tokens.input as number) ?? 0;
            usage.outputTokens += (tokens.output as number) ?? 0;
            const cache = tokens.cache as Record<string, number> | undefined;
            usage.cacheReadTokens! += cache?.read ?? 0;
            usage.cacheWriteTokens! += cache?.write ?? 0;
            usage.reasoningTokens = (usage.reasoningTokens ?? 0) + ((tokens.reasoning as number) ?? 0);
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

      log(`done: ${messagesRes.data.length} messages, ${toolCalls.length} tool calls, in=${usage.inputTokens} out=${usage.outputTokens}`);

      // Stop event stream
      eventAbort.abort();
      await eventPromise.catch(() => {});
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`HARNESS ERROR: ${errMsg}`);
      finalText += `\nHARNESS ERROR: ${errMsg}\n`;
    } finally {
      if (prevXdgCache !== undefined) process.env.XDG_CACHE_HOME = prevXdgCache;
      else delete process.env.XDG_CACHE_HOME;
      eventAbort?.abort();
      try { opencode?.server.close(); } catch {}
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }

    if (usage.inputTokens === 0 && usage.outputTokens === 0 && !finalText.trim()) {
      const captured = finalText.trim().slice(0, 500);
      throw new Error(`[opencode] ${scenario.id}: zero tokens — the LLM never ran.\n${captured}`);
    }

    if (usage.inputTokens === 0 && usage.outputTokens === 0) {
      console.error(`[opencode] ${scenario.id}: warning — zero token usage (model may not report tokens)`);
    }

    return {
      finalText: finalText.trim(),
      toolCalls,
      elapsedMs: Date.now() - start,
      usage,
    };
  },
};
