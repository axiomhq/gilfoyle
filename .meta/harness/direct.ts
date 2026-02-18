/**
 * Direct API Harness
 *
 * Runs Gilfoyle skill directly via Vercel AI SDK.
 * Supports multiple providers (Anthropic, xAI, Google).
 */

import type { HarnessRunner, IncidentScenario, RunConfig, RunTrace, ToolCall, } from './types.js';
import { createMockRouter } from '../toolbox/mock-router.js';
import { initAllValidators } from '../toolbox/apl-validator.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateText, tool, stepCountIs, type LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createXai } from '@ai-sdk/xai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadSkill(skillPath?: string): Promise<string> {
  const path = skillPath ?? join(__dirname, '../../skill/SKILL.md');
  return readFile(path, 'utf-8');
}

function buildSystemPrompt(skill: string, initOutput: string): string {
  return `${skill}

## Mocked Environment

You are running in an EVAL environment with mocked tools. The scripts/init output is:

${initOutput}

Available tools:
- scripts_init: Returns the discovery output above
- scripts_axiom_query: Query Axiom logs (pass env and query)
- scripts_grafana_query: Query Grafana metrics (pass env, datasource, promql)
- scripts_slack: Slack API (pass method and args)
- scripts_mem_write: Write to memory (always succeeds)

When you reach a conclusion, clearly state the ROOT CAUSE with evidence.`;
}

function getModel(modelName: string): LanguageModel {
  const slash = modelName.indexOf('/');
  const colon = modelName.indexOf(':');
  const separator = slash > 0 ? slash : colon;
  const provider = separator > 0 ? modelName.slice(0, separator) : '';
  const rawId = separator > 0 ? modelName.slice(separator + 1) : modelName;

  if (rawId.startsWith('claude')) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    const anthropic = createAnthropic({ apiKey });
    const modelId = rawId === 'claude-opus-4' ? 'claude-opus-4-20250514' : 'claude-sonnet-4-20250514';
    return anthropic(modelId);
  }

  if (rawId.startsWith('grok') || provider === 'xai') {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) throw new Error('XAI_API_KEY not set');
    const xai = createXai({ apiKey });
    const modelId = rawId === 'grok-4-1-fast' ? 'grok-4-0709' : rawId;
    return xai(modelId) as unknown as LanguageModel;
  }

  if (provider === 'openai' || rawId.startsWith('gpt-') || rawId.startsWith('codex-')) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');
    const openai = createOpenAI({ apiKey });
    return openai(rawId);
  }

  throw new Error(`Unsupported model: ${modelName}. Try openai/gpt-5.3-codex, xai/grok-4-1-fast, or claude-opus-4`);
}

function extractToolError(output: unknown): string[] | undefined {
  if (output == null) return undefined;
  if (typeof output === 'string') {
    const lines = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.toLowerCase().startsWith('error:'))
      .map((line) => line.replace(/^error:\s*/i, '').trim())
      .filter(Boolean);
    return lines.length > 0 ? lines : undefined;
  }
  if (typeof output === 'object' && output && 'errors' in output && Array.isArray((output as { errors?: unknown }).errors)) {
    const errors = ((output as { errors?: unknown[] }).errors ?? [])
      .map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
      .filter(Boolean);
    return errors.length > 0 ? errors : undefined;
  }
  if (typeof output === 'object' && output && 'error' in output) {
    const msg = String((output as { error?: unknown }).error ?? '').trim();
    return msg ? [msg] : undefined;
  }
  return undefined;
}

export const directHarness: HarnessRunner = {
  name: 'direct',

  async run(scenario: IncidentScenario, config: RunConfig): Promise<RunTrace> {
    const start = Date.now();
    await initAllValidators();
    const skill = await loadSkill(config.skillPath);
    const mockTools = createMockRouter(scenario);
    const toolCalls: ToolCall[] = [];

    const model = getModel(config.model ?? 'claude-sonnet-4');
    const systemPrompt = buildSystemPrompt(skill, scenario.initOutput);

    const axiomParams = z.object({
      env: z.string().optional().describe('Environment name (e.g., prod, staging)'),
      query: z.string().describe('APL query string'),
    });

    const grafanaParams = z.object({
      env: z.string().optional().describe('Environment name'),
      datasource: z.string().optional().describe('Datasource UID'),
      promql: z.string().describe('PromQL query'),
    });

    const slackParams = z.object({
      method: z.string().describe('Slack API method (e.g., chat.postMessage)'),
      args: z.record(z.string()).optional().describe('Method arguments'),
    });

    const memWriteParams = z.object({
      category: z.string().describe('Category (facts, patterns, queries, incidents)'),
      key: z.string().describe('Key name'),
      value: z.string().describe('Value to write'),
    });

    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: scenario.prompt,
      stopWhen: stepCountIs(20),
      tools: {
        scripts_init: tool({
          description: 'Run scripts/init to discover available environments and datasets',
          inputSchema: z.object({}),
          execute: async (): Promise<string> => {
            const callStart = Date.now();
            const output = await mockTools.call('scripts/init', {});
            toolCalls.push({
              tool: 'scripts/init',
              input: {},
              output,
              durationMs: Date.now() - callStart,
            });
            return output as string;
          },
        }),
        scripts_axiom_query: tool({
          description: 'Query Axiom logs. Use APL syntax.',
          inputSchema: axiomParams,
          execute: async (input: z.infer<typeof axiomParams>): Promise<string> => {
            const callStart = Date.now();
            const output = await mockTools.call('scripts/axiom-query', input);
            const errors = extractToolError(output);
            toolCalls.push({
              tool: 'scripts/axiom-query',
              input,
              output,
              queryValid: errors == null,
              queryErrors: errors,
              durationMs: Date.now() - callStart,
            });
            return output as string;
          },
        }),
        scripts_grafana_query: tool({
          description: 'Query Grafana Prometheus datasource',
          inputSchema: grafanaParams,
          execute: async (input: z.infer<typeof grafanaParams>): Promise<string> => {
            const callStart = Date.now();
            const output = await mockTools.call('scripts/grafana-query', input);
            const errors = extractToolError(output);
            toolCalls.push({
              tool: 'scripts/grafana-query',
              input,
              output,
              queryValid: errors == null,
              queryErrors: errors,
              durationMs: Date.now() - callStart,
            });
            return output as string;
          },
        }),
        scripts_slack: tool({
          description: 'Call Slack API method',
          inputSchema: slackParams,
          execute: async (input: z.infer<typeof slackParams>): Promise<string> => {
            const callStart = Date.now();
            const output = await mockTools.call('scripts/slack', input);
            toolCalls.push({
              tool: 'scripts/slack',
              input,
              output,
              durationMs: Date.now() - callStart,
            });
            return output as string;
          },
        }),
        scripts_mem_write: tool({
          description: 'Write to memory',
          inputSchema: memWriteParams,
          execute: async (input: z.infer<typeof memWriteParams>): Promise<string> => {
            const callStart = Date.now();
            const output = await mockTools.call('scripts/mem-write', input);
            toolCalls.push({
              tool: 'scripts/mem-write',
              input,
              output,
              durationMs: Date.now() - callStart,
            });
            return output as string;
          },
        }),
        gh_repo_clone: tool({
          description: 'Clone a GitHub repository',
          inputSchema: z.object({
            repo: z.string().describe('Repository in owner/name format'),
          }),
          execute: async (input): Promise<string> => {
            const callStart = Date.now();
            const output = await mockTools.call('gh_repo_clone', input);
            toolCalls.push({ tool: 'gh_repo_clone', input, output, durationMs: Date.now() - callStart });
            return output as string;
          },
        }),
        git_log: tool({
          description: 'View git log for a file. Pass file path and optional args (e.g., "-L :FunctionName:file")',
          inputSchema: z.object({
            file: z.string().optional().describe('File path'),
            args: z.string().optional().describe('Additional git log arguments'),
          }),
          execute: async (input): Promise<string> => {
            const callStart = Date.now();
            const output = await mockTools.call('git_log', input);
            toolCalls.push({ tool: 'git_log', input, output, durationMs: Date.now() - callStart });
            return output as string;
          },
        }),
        git_blame: tool({
          description: 'View git blame for a file',
          inputSchema: z.object({
            file: z.string().describe('File path'),
          }),
          execute: async (input): Promise<string> => {
            const callStart = Date.now();
            const output = await mockTools.call('git_blame', input);
            toolCalls.push({ tool: 'git_blame', input, output, durationMs: Date.now() - callStart });
            return output as string;
          },
        }),
        gh_pr_view: tool({
          description: 'View a GitHub pull request',
          inputSchema: z.object({
            number: z.string().describe('PR number'),
          }),
          execute: async (input): Promise<string> => {
            const callStart = Date.now();
            const output = await mockTools.call('gh_pr_view', input);
            toolCalls.push({ tool: 'gh_pr_view', input, output, durationMs: Date.now() - callStart });
            return output as string;
          },
        }),
        gh_pr_diff: tool({
          description: 'View the diff of a GitHub pull request',
          inputSchema: z.object({
            number: z.string().describe('PR number'),
          }),
          execute: async (input): Promise<string> => {
            const callStart = Date.now();
            const output = await mockTools.call('gh_pr_diff', input);
            toolCalls.push({ tool: 'gh_pr_diff', input, output, durationMs: Date.now() - callStart });
            return output as string;
          },
        }),
      },
    });

    return {
      finalText: result.text,
      toolCalls,
      usage: {
        inputTokens: result.totalUsage.inputTokens ?? 0,
        outputTokens: result.totalUsage.outputTokens ?? 0,
      },
      elapsedMs: Date.now() - start,
    };
  },
};
