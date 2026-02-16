import { Eval } from 'axiom/ai/evals';
import { withSpan } from 'axiom/ai';
import { loadScenarios } from './scenarios/index.js';
import { getHarness, type EvalInput, type EvalOutput, type HarnessName, type ModelName } from './harness/index.js';
import { RCAAccuracyScorer, EvidenceQualityScorer, EfficiencyScorer, QueryValidityScorer, QueryYieldScorer, QueryRepairScorer, ExecutorCoverageScorer, InitFirstScorer, SchemaFirstScorer, CounterfactualRejectionScorer, CausalGroundingScorer, MustNotMentionScorer, MemoryWriteScorer, HypothesisDisciplineScorer, SecretHygieneScorer, TriageFirstScorer, SlackCommsScorer, MemoryDistillationScorer, FirstRunScorer, RunValidityScorer, WallClockScorer, TokenBudgetScorer, SourceLinkScorer } from './scorers/index.js';

const DEFAULT_HARNESS: HarnessName = 'amp';
const DEFAULT_MODEL = 'xai/grok-4-1-fast';

function defaultModelForHarness(harness: HarnessName): ModelName | undefined {
  switch (harness) {
    case 'amp':
      return undefined;
    case 'opencode':
      return DEFAULT_MODEL;
    case 'claude':
      return 'claude-opus-4-6';
    case 'direct':
      return 'claude-sonnet-4';
    case 'codex':
      return 'gpt-5.2-codex';
    default:
      return DEFAULT_MODEL;
  }
}

function parseConfig(): { harness: HarnessName; model: ModelName | undefined } {
  const harness = (process.env.EVAL_HARNESS ?? DEFAULT_HARNESS) as HarnessName;
  const model = process.env.EVAL_MODEL ?? defaultModelForHarness(harness);
  return { harness, model };
}

function extractRootCause(text: string): string {
  const patterns = [
    /\broot\s*cause\b\s*(?:[:-]\s*)([^\n]+(?:\n(?![A-Z#*-])[^\n]+)*)/i,
    /(?:the\s+)?(?:underlying\s+)?(?:issue|problem|cause|reason)\s+(?:is|was)[:\s]*([^\n]+(?:\n(?![A-Z#*-])[^\n]+)*)/i,
    /(?:caused\s+by|due\s+to|attributed\s+to)[:\s]*([^\n]+(?:\n(?![A-Z#*-])[^\n]+)*)/i,
    /(?:diagnosis|conclusion|finding|determination)[:\s]*([^\n]+(?:\n(?![A-Z#*-])[^\n]+)*)/i,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) return m[1].trim();
  }
  const paragraphs = text.split('\n\n').filter((p) => p.trim());
  return paragraphs[paragraphs.length - 1] ?? text;
}

function extractEvidence(text: string): string[] {
  const evidence: string[] = [];
  const evidenceMatch = text.match(/evidence[:\s]*\n((?:[-•*]\s*[^\n]+\n?)+)/i);
  if (evidenceMatch) {
    const bullets = evidenceMatch[1].match(/[-•*]\s*([^\n]+)/g);
    if (bullets) evidence.push(...bullets.map((b) => b.replace(/^[-•*]\s*/, '')));
  }
  const toolRefs = text.match(/(?:logs? show|query (?:returned|shows?)|data shows?)[:\s]*([^\n]+)/gi);
  if (toolRefs) evidence.push(...toolRefs);
  return evidence;
}

type ExpectedOutput = { rootCause: string; evidence: string[] };

const { harness: harnessName, model: modelName } = parseConfig();
const evalName = modelName
  ? `gilfoyle-sre-${harnessName}-${modelName.replace(/[^a-z0-9]/gi, '-')}`
  : `gilfoyle-sre-${harnessName}`;

Eval<EvalInput, ExpectedOutput, EvalOutput>(evalName, {
  capability: 'sre-investigation',
  step: 'incident-rca',

  data: () => {
    const scenarios = loadScenarios();
    const config = parseConfig();
    return scenarios.map((scenario) => ({
      input: { scenario, config },
      expected: { rootCause: scenario.expected.rootCauseMustMention.join(' '), evidence: [] },
    }));
  },

  task: async ({ input }) => {
    const { scenario, config } = input;
    const harness = getHarness(config.harness);

    const result = await withSpan(
      { capability: 'sre-investigation', step: `${config.harness}-${scenario.id}` },
      async (span) => {
        const aiSystem = config.harness === 'amp'
          ? 'amp'
          : config.harness === 'codex'
            ? 'openai'
            : config.harness === 'claude'
              ? 'anthropic'
              : 'xai';
        span.setAttribute('gen_ai.system', aiSystem);
        span.setAttribute('gen_ai.operation.name', 'chat');
        span.setAttribute('eval.name', evalName);
        span.setAttribute('scenario.id', scenario.id);

        const trace = await harness.run(scenario, config);

        if (trace.usage) {
          span.setAttribute('gen_ai.usage.input_tokens', trace.usage.inputTokens);
          span.setAttribute('gen_ai.usage.output_tokens', trace.usage.outputTokens);
          span.setAttribute('llm.token_count.prompt', trace.usage.inputTokens);
          span.setAttribute('llm.token_count.completion', trace.usage.outputTokens);
          span.setAttribute('gen_ai.usage.cache_read_tokens', trace.usage.cacheReadTokens ?? 0);
          span.setAttribute('gen_ai.usage.cache_write_tokens', trace.usage.cacheWriteTokens ?? 0);
          span.setAttribute('gen_ai.usage.reasoning_tokens', trace.usage.reasoningTokens ?? 0);
          span.setAttribute('gen_ai.usage.cost', trace.usage.costUsd ?? 0);
          console.error(`[eval] ${scenario.id} token usage: in=${trace.usage.inputTokens} out=${trace.usage.outputTokens} cache_read=${trace.usage.cacheReadTokens ?? 0} cache_write=${trace.usage.cacheWriteTokens ?? 0} reasoning=${trace.usage.reasoningTokens ?? 0} cost=$${trace.usage.costUsd?.toFixed(4) ?? 'n/a'}`);
        }

        const rootCause = extractRootCause(trace.finalText);
        const evidence = extractEvidence(trace.finalText);
        return { trace, rootCause, evidence };
      },
    );

    return result;
  },

  scorers: [
    RunValidityScorer,
    QueryValidityScorer,
    QueryYieldScorer,
    QueryRepairScorer,
    ExecutorCoverageScorer,
    RCAAccuracyScorer,
    EvidenceQualityScorer,
    CausalGroundingScorer,
    EfficiencyScorer,
    WallClockScorer,
    TokenBudgetScorer,
    InitFirstScorer,
    SchemaFirstScorer,
    CounterfactualRejectionScorer,
    MustNotMentionScorer,
    MemoryWriteScorer,
    HypothesisDisciplineScorer,
    SecretHygieneScorer,
    TriageFirstScorer,
    SlackCommsScorer,
    MemoryDistillationScorer,
    FirstRunScorer,
    SourceLinkScorer,
  ],
  timeout: 900_000, // 15 minutes per scenario — LLM investigations take time, especially with slower models
  metadata: { description: 'Evaluate Gilfoyle SRE skill incident investigation', version: '0.2.0', harness: harnessName, ...(modelName && { model: modelName }), commit: process.env.GIT_COMMIT ?? '', branch: process.env.GIT_BRANCH ?? '' },
});
