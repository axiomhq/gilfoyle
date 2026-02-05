/**
 * Direct API Harness
 *
 * Runs Gilfoyle skill directly via Vercel AI SDK.
 * Supports multiple providers (Anthropic, xAI, Google).
 */

import type { HarnessRunner, IncidentScenario, RunConfig, RunTrace, ToolCall, ToolName } from './types.js';
import { createMockTools } from '../tools/mock-tools.js';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { generateText, tool } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createXai } from '@ai-sdk/xai';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadSkill(skillPath?: string): Promise<string> {
  const path = skillPath ?? join(__dirname, '../../SKILL.md');
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

function getModel(modelName: string) {
  if (modelName.startsWith('claude')) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    const anthropic = createAnthropic({ apiKey });
    const modelId = modelName === 'claude-opus-4' ? 'claude-opus-4-20250514' : 'claude-sonnet-4-20250514';
    return anthropic(modelId);
  }

  if (modelName.startsWith('grok')) {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) throw new Error('XAI_API_KEY not set');
    const xai = createXai({ apiKey });
    return xai('grok-4-0709');
  }

  throw new Error(`Unsupported model: ${modelName}`);
}

export const directHarness: HarnessRunner = {
  name: 'direct',

  async run(scenario: IncidentScenario, config: RunConfig): Promise<RunTrace> {
    const start = Date.now();
    const skill = await loadSkill(config.skillPath);
    const mockTools = createMockTools(scenario);
    const toolCalls: ToolCall[] = [];

    const model = getModel(config.model);
    const systemPrompt = buildSystemPrompt(skill, scenario.initOutput);

    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: scenario.prompt,
      maxSteps: 20,
      tools: {
        scripts_init: tool({
          description: 'Run scripts/init to discover available environments and datasets',
          parameters: z.object({}),
          execute: async () => {
            const callStart = Date.now();
            const output = await mockTools.call('scripts/init', {});
            toolCalls.push({
              tool: 'scripts/init',
              input: {},
              output,
              durationMs: Date.now() - callStart,
            });
            return output;
          },
        }),
        scripts_axiom_query: tool({
          description: 'Query Axiom logs. Use APL syntax.',
          parameters: z.object({
            env: z.string().optional().describe('Environment name (e.g., prod, staging)'),
            query: z.string().describe('APL query string'),
          }),
          execute: async (input) => {
            const callStart = Date.now();
            const output = await mockTools.call('scripts/axiom-query', input);
            toolCalls.push({
              tool: 'scripts/axiom-query',
              input,
              output,
              durationMs: Date.now() - callStart,
            });
            return output;
          },
        }),
        scripts_grafana_query: tool({
          description: 'Query Grafana Prometheus datasource',
          parameters: z.object({
            env: z.string().optional().describe('Environment name'),
            datasource: z.string().optional().describe('Datasource UID'),
            promql: z.string().describe('PromQL query'),
          }),
          execute: async (input) => {
            const callStart = Date.now();
            const output = await mockTools.call('scripts/grafana-query', input);
            toolCalls.push({
              tool: 'scripts/grafana-query',
              input,
              output,
              durationMs: Date.now() - callStart,
            });
            return output;
          },
        }),
        scripts_slack: tool({
          description: 'Call Slack API method',
          parameters: z.object({
            method: z.string().describe('Slack API method (e.g., chat.postMessage)'),
            args: z.record(z.string()).optional().describe('Method arguments'),
          }),
          execute: async (input) => {
            const callStart = Date.now();
            const output = await mockTools.call('scripts/slack', input);
            toolCalls.push({
              tool: 'scripts/slack',
              input,
              output,
              durationMs: Date.now() - callStart,
            });
            return output;
          },
        }),
        scripts_mem_write: tool({
          description: 'Write to memory',
          parameters: z.object({
            category: z.string().describe('Category (facts, patterns, queries, incidents)'),
            key: z.string().describe('Key name'),
            value: z.string().describe('Value to write'),
          }),
          execute: async (input) => {
            const callStart = Date.now();
            const output = await mockTools.call('scripts/mem-write', input);
            toolCalls.push({
              tool: 'scripts/mem-write',
              input,
              output,
              durationMs: Date.now() - callStart,
            });
            return output;
          },
        }),
      },
    });

    return {
      finalText: result.text,
      toolCalls,
      usage: {
        inputTokens: result.usage?.promptTokens,
        outputTokens: result.usage?.completionTokens,
        totalTokens: result.usage ? result.usage.promptTokens + result.usage.completionTokens : undefined,
      },
      elapsedMs: Date.now() - start,
    };
  },
};
