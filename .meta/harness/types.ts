export type HarnessName = 'amp' | 'opencode';
export type ModelName = string;
export type ToolName = 'scripts/init' | 'scripts/axiom-query' | 'scripts/grafana-query' | 'scripts/slack' | 'scripts/mem-write';

export interface ToolCall {
  tool: ToolName;
  input: unknown;
  output?: unknown;
  queryValid?: boolean;
  queryErrors?: string[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
}

export interface RunTrace {
  finalText: string;
  toolCalls: ToolCall[];
  elapsedMs: number;
  usage?: TokenUsage;
}

// Legacy mock types (kept for backward compat)
export interface ToolMock {
  when: { contains?: string[]; regex?: string };
  return: unknown;
}

// New fixture-based types
export interface LogRow {
  _time: string;
  [field: string]: unknown;
}

export interface MetricSeries {
  metric: string;
  labels: Record<string, string>;
  values: [number, number][]; // [timestamp_epoch, value]
}

export interface DataSourceInfo {
  uid: string;
  name: string;
  type: string; // 'prometheus' | 'loki' | etc
}

export interface ScenarioFixtures {
  datasets: Record<string, LogRow[]>; // dataset name → log rows
  metrics: Record<string, MetricSeries[]>; // metric name → series
  datasources: DataSourceInfo[];
  validDeployments: string[]; // e.g. ['prod', 'staging']
}

export interface IncidentScenario {
  id: string;
  name: string;
  description: string;
  prompt: string;
  initOutput: string;
  // Legacy keyword mocks (deprecated)
  toolMocks: {
    axiom?: ToolMock[];
    grafana?: ToolMock[];
    slack?: ToolMock[];
  };
  // New fixture-based data
  fixtures?: ScenarioFixtures;
  expected: {
    rootCauseMustMention: string[];
    rootCauseMustNotMention?: string[];
    requiredEvidence: { tool: ToolName; mustMention: string[] }[];
    requiredQueries?: {
      tool: ToolName;
      mustMatch: string; // regex that at least one query to this tool must match
      description: string; // what this query should accomplish
    }[];
  };
  budgets?: {
    maxToolCalls?: number;
    maxTotalTokens?: number;
  };
}

export interface RunConfig {
  harness: HarnessName;
  model?: ModelName;
}

export interface EvalInput {
  scenario: IncidentScenario;
  config: RunConfig;
}

export interface EvalOutput {
  trace: RunTrace;
  rootCause: string;
  evidence: string[];
}

export type HarnessRunner = {
  name: HarnessName;
  run: (scenario: IncidentScenario, config: RunConfig) => Promise<RunTrace>;
};
