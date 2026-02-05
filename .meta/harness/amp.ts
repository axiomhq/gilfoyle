/**
 * Amp Harness
 *
 * Runs Gilfoyle skill via Amp SDK with mocked tools.
 * Uses Claude Opus 4 (Amp's default model).
 *
 * The harness uses the Amp SDK execute() to run the agent, but because
 * Amp SDK doesn't support tool interception, we use a direct API approach
 * with the Anthropic SDK for deterministic mocked tool responses.
 */

import type { HarnessRunner, IncidentScenario, RunConfig, RunTrace, ToolCall, ToolName } from './types.js';
import { createMockTools } from '../tools/mock-tools.js';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MODEL_MAP: Record<string, string> = {
  'claude-opus-4': 'claude-opus-4-20250514',
  'claude-sonnet-4': 'claude-sonnet-4-20250514',
};

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
- scripts/init: Returns the discovery output above
- scripts/axiom-query: Query Axiom logs (pass env and query)
- scripts/grafana-query: Query Grafana metrics (pass env, datasource, promql)
- scripts/slack: Slack API (pass method and args)
- scripts/mem-write: Write to memory (always succeeds)

When you reach a conclusion, clearly state the ROOT CAUSE with evidence.`;
}

function mapToolName(toolName: string): ToolName | null {
  const mapping: Record<string, ToolName> = {
    'scripts_init': 'scripts/init',
    'scripts_axiom_query': 'scripts/axiom-query',
    'scripts_grafana_query': 'scripts/grafana-query',
    'scripts_slack': 'scripts/slack',
    'scripts_mem_write': 'scripts/mem-write',
  };
  return mapping[toolName] ?? null;
}

const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'scripts_init',
    description: 'Run scripts/init to discover available environments and datasets',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'scripts_axiom_query',
    description: 'Query Axiom logs. Use APL syntax.',
    input_schema: {
      type: 'object' as const,
      properties: {
        env: { type: 'string', description: 'Environment name (e.g., prod, staging)' },
        query: { type: 'string', description: 'APL query string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'scripts_grafana_query',
    description: 'Query Grafana Prometheus datasource',
    input_schema: {
      type: 'object' as const,
      properties: {
        env: { type: 'string', description: 'Environment name' },
        datasource: { type: 'string', description: 'Datasource UID' },
        promql: { type: 'string', description: 'PromQL query' },
      },
      required: ['promql'],
    },
  },
  {
    name: 'scripts_slack',
    description: 'Call Slack API method',
    input_schema: {
      type: 'object' as const,
      properties: {
        method: { type: 'string', description: 'Slack API method (e.g., chat.postMessage)' },
        args: { type: 'object', description: 'Method arguments' },
      },
      required: ['method'],
    },
  },
  {
    name: 'scripts_mem_write',
    description: 'Write to memory',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', description: 'Category (facts, patterns, queries, incidents)' },
        key: { type: 'string', description: 'Key name' },
        value: { type: 'string', description: 'Value to write' },
      },
      required: ['category', 'key', 'value'],
    },
  },
];

export const ampHarness: HarnessRunner = {
  name: 'amp',

  async run(scenario: IncidentScenario, config: RunConfig): Promise<RunTrace> {
    const start = Date.now();
    const skill = await loadSkill(config.skillPath);
    const mockTools = createMockTools(scenario);
    const toolCalls: ToolCall[] = [];

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not set');
    }

    const client = new Anthropic({ apiKey });
    const modelId = MODEL_MAP[config.model] ?? MODEL_MAP['claude-opus-4'];

    const systemPrompt = buildSystemPrompt(skill, scenario.initOutput);
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: scenario.prompt },
    ];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let finalText = '';
    let iterations = 0;
    const maxIterations = 20;

    while (iterations < maxIterations) {
      iterations++;

      const response = await client.messages.create({
        model: modelId,
        max_tokens: 4096,
        system: systemPrompt,
        tools: TOOL_DEFINITIONS,
        messages,
      });

      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;

      const assistantContent: Anthropic.ContentBlock[] = [];
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        assistantContent.push(block);

        if (block.type === 'text') {
          finalText += block.text + '\n';
        } else if (block.type === 'tool_use') {
          const toolName = mapToolName(block.name);
          if (!toolName) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify({ error: `Unknown tool: ${block.name}` }),
            });
            continue;
          }

          const callStart = Date.now();
          const output = await mockTools.call(toolName, block.input);
          const callDuration = Date.now() - callStart;

          toolCalls.push({
            tool: toolName,
            input: block.input,
            output,
            durationMs: callDuration,
          });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(output),
          });
        }
      }

      messages.push({ role: 'assistant', content: assistantContent });

      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
      }

      if (response.stop_reason === 'end_turn') {
        break;
      }
    }

    return {
      finalText: finalText.trim(),
      toolCalls,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
      },
      elapsedMs: Date.now() - start,
    };
  },
};
