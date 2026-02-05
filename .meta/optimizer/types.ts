/**
 * Optimizer Types
 */

import type { IncidentScenario, RunTrace, EvalOutput } from '../harness/types.js';

export interface FailedScenario {
  scenario: IncidentScenario;
  output: EvalOutput;
  scores: {
    rcaAccuracy: number;
    evidenceQuality: number;
    efficiency: number;
  };
  failures: string[];
}

export interface PromptFix {
  analysis: string;
  oldText: string;
  newText: string;
  explanation: string;
  targetScenarios: string[];
}

export interface OptimizeResult {
  totalScenarios: number;
  failedCount: number;
  passedCount: number;
  failures: FailedScenario[];
  suggestedFix?: PromptFix;
  applied: boolean;
}
