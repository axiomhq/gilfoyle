/**
 * Gilfoyle Eval Harness Types
 *
 * Abstracts different agent frameworks (Amp, OpenCode, direct API)
 * so the same scenarios can run across all of them.
 */

export type HarnessName = 'amp' | 'opencode' | 'direct';

export type ModelName =
  | 'claude-opus-4'
  | 'claude-sonnet-4'
  | 'gpt-5'
  | 'grok-4.1-fast'
  | 'gemini-2.0-flash';

export type ToolName =
  | 'scripts/init'
  | 'scripts/axiom-query'
  | 'scripts/grafana-query'
  | 'scripts/slack'
  | 'scripts/mem-write';

export interface ToolCall {
  tool: ToolName;
  input: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface RunTrace {
  finalText: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
  elapsedMs: number;
}

export interface RunConfig {
  model: ModelName;
  harness: HarnessName;
  skillPath?: string;
}

export interface HarnessRunner {
  name: HarnessName;
  run(scenario: IncidentScenario, config: RunConfig): Promise<RunTrace>;
}

// Scenario types

export interface ToolMock {
  when: { contains?: string[]; regex?: string };
  return: unknown;
}

export interface IncidentScenario {
  id: string;
  name: string;
  description?: string;

  // Initial alert or question
  prompt: string;

  // What scripts/init returns (mocked discovery output)
  initOutput: string;

  // Mocked tool responses keyed by tool type
  toolMocks: {
    axiom?: ToolMock[];
    grafana?: ToolMock[];
    slack?: ToolMock[];
  };

  // Expected outcomes
  expected: {
    rootCauseMustMention: string[];
    rootCauseMustNotMention?: string[];
    requiredEvidence?: Array<{
      tool: ToolName;
      mustMention: string[];
    }>;
  };

  // Efficiency budgets
  budgets?: {
    maxToolCalls?: number;
    maxTotalTokens?: number;
  };
}

// Eval input/output types for Axiom Eval API
export interface EvalInput {
  scenario: IncidentScenario;
  config: RunConfig;
}

export interface EvalOutput {
  trace: RunTrace;
  rootCause: string;
  evidence: string[];
}
