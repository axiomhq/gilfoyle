/**
 * Gilfoyle SRE Skill Evaluation
 *
 * Tests Gilfoyle's incident investigation capabilities across
 * different agent harnesses (Amp, OpenCode) and models.
 *
 * Usage:
 *   bun run eval                                    # Run all evals
 *   bun run eval --flag.harness=amp                 # Amp harness only
 *   bun run eval --flag.harness=opencode --flag.model=grok-4.1-fast
 */

import { Eval } from 'axiom/ai/evals';
import { loadScenarios } from './scenarios/index.js';
import { getHarness, type EvalInput, type EvalOutput, type HarnessName, type ModelName } from './harness/index.js';
import { RCAAccuracyScorer, EvidenceQualityScorer, EfficiencyScorer } from './scorers/index.js';

const DEFAULT_HARNESS: HarnessName = 'amp';
const DEFAULT_MODEL: ModelName = 'claude-opus-4';

function parseConfig(): { harness: HarnessName; model: ModelName } {
  const harness = (process.env.EVAL_HARNESS ?? DEFAULT_HARNESS) as HarnessName;
  const model = (process.env.EVAL_MODEL ?? DEFAULT_MODEL) as ModelName;
  return { harness, model };
}

function extractRootCause(text: string): string {
  const rcMatch = text.match(/root\s*cause[:\s]*([^\n]+(?:\n(?![A-Z])[^\n]+)*)/i);
  if (rcMatch) return rcMatch[1].trim();

  const conclusionMatch = text.match(/(?:cause|problem|issue)[:\s]*([^\n]+)/i);
  if (conclusionMatch) return conclusionMatch[1].trim();

  const paragraphs = text.split('\n\n').filter((p) => p.trim());
  return paragraphs[paragraphs.length - 1] ?? text;
}

function extractEvidence(text: string): string[] {
  const evidence: string[] = [];

  const evidenceMatch = text.match(/evidence[:\s]*\n((?:[-•*]\s*[^\n]+\n?)+)/i);
  if (evidenceMatch) {
    const bullets = evidenceMatch[1].match(/[-•*]\s*([^\n]+)/g);
    if (bullets) {
      evidence.push(...bullets.map((b) => b.replace(/^[-•*]\s*/, '')));
    }
  }

  const toolRefs = text.match(/(?:logs? show|query (?:returned|shows?)|data shows?)[:\s]*([^\n]+)/gi);
  if (toolRefs) {
    evidence.push(...toolRefs);
  }

  return evidence;
}

type ExpectedOutput = {
  rootCause: string;
  evidence: string[];
};

Eval<EvalInput, ExpectedOutput, EvalOutput>('gilfoyle-sre-incidents', {
  capability: 'sre-investigation',
  step: 'incident-rca',

  data: () => {
    const scenarios = loadScenarios();
    const config = parseConfig();

    return scenarios.map((scenario) => ({
      input: { scenario, config },
      expected: {
        rootCause: scenario.expected.rootCauseMustMention.join(' '),
        evidence: [],
      },
    }));
  },

  task: async ({ input }) => {
    const { scenario, config } = input;
    const harness = getHarness(config.harness);

    const trace = await harness.run(scenario, config);

    const rootCause = extractRootCause(trace.finalText);
    const evidence = extractEvidence(trace.finalText);

    return {
      trace,
      rootCause,
      evidence,
    };
  },

  scorers: [RCAAccuracyScorer, EvidenceQualityScorer, EfficiencyScorer],

  metadata: {
    description: 'Evaluate Gilfoyle SRE skill incident investigation across harnesses and models',
    version: '0.1.0',
  },
});
