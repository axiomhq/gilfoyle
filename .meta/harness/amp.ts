/**
 * Amp Harness
 *
 * Runs Gilfoyle skill via Amp SDK with mocked tools via toolbox.
 * Tools are symlinked executables that read scenario from GILFOYLE_SCENARIO_FILE.
 */

import type { HarnessRunner, IncidentScenario, RunConfig, RunTrace, ToolCall, ToolName } from './types.js';
import { execute } from '@sourcegraph/amp-sdk';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLBOX_PATH = join(__dirname, '../toolbox');
const SKILL_PATH = join(__dirname, '../../SKILL.md');

function mapToolName(name: string): ToolName | null {
  const mapping: Record<string, ToolName> = {
    'scripts/init': 'scripts/init',
    'scripts/axiom-query': 'scripts/axiom-query',
    'scripts/grafana-query': 'scripts/grafana-query',
    'scripts/slack': 'scripts/slack',
    'scripts/mem-write': 'scripts/mem-write',
    'scripts-init': 'scripts/init',
    'scripts-axiom-query': 'scripts/axiom-query',
    'scripts-grafana-query': 'scripts/grafana-query',
    'scripts-slack': 'scripts/slack',
    'scripts-mem-write': 'scripts/mem-write',
  };
  return mapping[name] ?? null;
}

export const ampHarness: HarnessRunner = {
  name: 'amp',

  async run(scenario: IncidentScenario, config: RunConfig): Promise<RunTrace> {
    const start = Date.now();
    const toolCalls: ToolCall[] = [];
    let finalText = '';

    // Write scenario to temp file for toolbox scripts to read
    const scenarioFile = join(tmpdir(), `gilfoyle-scenario-${Date.now()}.json`);
    writeFileSync(scenarioFile, JSON.stringify(scenario));

    try {
      // Build the prompt with skill context
      const prompt = `Load the gilfoyle skill, then investigate this incident:

${scenario.prompt}

Use the available scripts/ tools to query logs and metrics. State your ROOT CAUSE clearly with evidence.`;

      for await (const message of execute({
        prompt,
        options: {
          cwd: dirname(SKILL_PATH),
          toolbox: TOOLBOX_PATH,
          skills: dirname(SKILL_PATH),
          env: {
            GILFOYLE_SCENARIO_FILE: scenarioFile,
          },
          // Disable built-in tools except what we need
          dangerouslyAllowAll: true,
        },
      })) {
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'text') {
              finalText += block.text + '\n';
            } else if (block.type === 'tool_use') {
              const toolName = mapToolName(block.name);
              if (toolName) {
                toolCalls.push({
                  tool: toolName,
                  input: block.input,
                });
              }
            }
          }
        } else if (message.type === 'result') {
          if (message.is_error) {
            finalText += `\nError: ${message.error}\n`;
          } else {
            finalText += message.result + '\n';
          }
        }
      }
    } finally {
      // Cleanup temp file
      try {
        unlinkSync(scenarioFile);
      } catch {
        // ignore
      }
    }

    return {
      finalText: finalText.trim(),
      toolCalls,
      elapsedMs: Date.now() - start,
    };
  },
};
