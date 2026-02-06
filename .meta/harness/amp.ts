/**
 * Amp Harness
 *
 * Runs Gilfoyle skill via Amp SDK with mocked scripts.
 * Creates a temporary skill directory with mock scripts that read from GILFOYLE_SCENARIO_FILE.
 */

import type { HarnessRunner, IncidentScenario, RunConfig, RunTrace, ToolCall, ToolName } from './types.js';
import { execute } from '@sourcegraph/amp-sdk';
import { writeFileSync, mkdirSync, rmSync, readFileSync, copyFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(__dirname, '../../SKILL.md');
const MOCK_TOOL_PATH = join(__dirname, '../toolbox/mock-tool.ts');

function mapToolName(name: string): ToolName | null {
  // Match Bash calls to scripts/*
  if (name === 'Bash') return null; // We'll extract from the command
  const mapping: Record<string, ToolName> = {
    'scripts/init': 'scripts/init',
    'scripts/axiom-query': 'scripts/axiom-query',
    'scripts/grafana-query': 'scripts/grafana-query',
    'scripts/slack': 'scripts/slack',
    'scripts/mem-write': 'scripts/mem-write',
  };
  return mapping[name] ?? null;
}

function extractScriptFromBashCmd(cmd: string): ToolName | null {
  const match = cmd.match(/scripts\/(init|axiom-query|grafana-query|slack|mem-write)/);
  if (match) {
    return `scripts/${match[1]}` as ToolName;
  }
  return null;
}

function createMockScript(name: string): string {
  // Create a bash script that calls the mock-tool.ts with the right tool name
  // Pass all arguments and stdin through
  return `#!/bin/bash
# Mock ${name} for eval harness
exec bun "${MOCK_TOOL_PATH}" scripts-${name} "$@"
`;
}

export const ampHarness: HarnessRunner = {
  name: 'amp',

  async run(scenario: IncidentScenario, config: RunConfig): Promise<RunTrace> {
    const start = Date.now();
    const toolCalls: ToolCall[] = [];
    let finalText = '';

    // Create temp directory with mock scripts
    const tmpDir = join(tmpdir(), `gilfoyle-eval-${Date.now()}`);
    const scriptsDir = join(tmpDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });

    // Write scenario file
    const scenarioFile = join(tmpDir, 'scenario.json');
    writeFileSync(scenarioFile, JSON.stringify(scenario));

    // Copy SKILL.md
    copyFileSync(SKILL_PATH, join(tmpDir, 'SKILL.md'));

    // Create mock scripts
    const mockScripts = ['init', 'axiom-query', 'grafana-query', 'slack', 'mem-write'];
    for (const name of mockScripts) {
      const scriptPath = join(scriptsDir, name);
      writeFileSync(scriptPath, createMockScript(name));
      chmodSync(scriptPath, 0o755);
    }

    const debug = process.env.DEBUG_AMP_HARNESS === '1';
    if (debug) {
      console.error(`[amp-harness] Temp dir: ${tmpDir}`);
      console.error(`[amp-harness] Scenario: ${scenario.id}`);
    }

    try {
      const prompt = `You are Gilfoyle. Investigate this incident:

${scenario.prompt}

Run scripts/init first to discover available environments, then use scripts/axiom-query and scripts/grafana-query to investigate. State your ROOT CAUSE clearly with evidence.`;

      // Track pending tool calls by ID to match with results
      const pendingTools = new Map<string, { tool: ToolName; input: unknown }>();

      for await (const message of execute({
        prompt,
        options: {
          cwd: tmpDir,
          skills: tmpDir,
          env: {
            GILFOYLE_SCENARIO_FILE: scenarioFile,
          },
          dangerouslyAllowAll: true,
          logLevel: debug ? 'debug' : undefined,
        },
      })) {
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'text') {
              finalText += block.text + '\n';
            } else if (block.type === 'tool_use') {
              if (debug) {
                console.error(`[amp-harness] Tool: ${block.name}`, block.input);
              }
              // Check if it's a Bash call to our scripts
              if (block.name === 'Bash' && typeof block.input === 'object' && block.input !== null) {
                const cmd = (block.input as { cmd?: string }).cmd ?? '';
                const scriptName = extractScriptFromBashCmd(cmd);
                if (scriptName) {
                  pendingTools.set(block.id, { tool: scriptName, input: cmd });
                }
              } else {
                const toolName = mapToolName(block.name);
                if (toolName) {
                  pendingTools.set(block.id, { tool: toolName, input: block.input });
                }
              }
            }
          }
        } else if (message.type === 'user') {
          // Tool results come in user messages
          for (const block of message.message.content) {
            if (block.type === 'tool_result') {
              const pending = pendingTools.get(block.tool_use_id);
              if (pending) {
                toolCalls.push({
                  tool: pending.tool,
                  input: pending.input,
                  output: block.content,
                });
                pendingTools.delete(block.tool_use_id);
                if (debug) {
                  console.error(`[amp-harness] Tool result for ${pending.tool}:`, 
                    typeof block.content === 'string' ? block.content.slice(0, 100) : block.content);
                }
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
      // Cleanup temp directory
      try {
        rmSync(tmpDir, { recursive: true, force: true });
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
