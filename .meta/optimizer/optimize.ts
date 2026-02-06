/**
 * SKILL.md Optimizer
 *
 * Runs all scenarios, analyzes failures, and suggests SKILL.md edits.
 * Based on webhook/router_optimize_test.go pattern.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { loadScenarios } from '../scenarios/index.js';
import { getHarness } from '../harness/index.js';
import type { IncidentScenario, RunConfig, EvalOutput, HarnessName, ModelName } from '../harness/types.js';
import type { FailedScenario, PromptFix, OptimizeResult } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(__dirname, '../../SKILL.md');

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

function scoreRCA(scenario: IncidentScenario, rootCause: string): { score: number; failures: string[] } {
  const text = rootCause.toLowerCase();
  const failures: string[] = [];

  const mustMention = scenario.expected.rootCauseMustMention;
  const mentionedCount = mustMention.filter((kw) => text.includes(kw.toLowerCase())).length;

  const mustNotMention = scenario.expected.rootCauseMustNotMention ?? [];
  const forbiddenFound = mustNotMention.filter((kw) => text.includes(kw.toLowerCase()));

  if (forbiddenFound.length > 0) {
    failures.push(`Mentioned forbidden keywords: ${forbiddenFound.join(', ')}`);
  }

  const missingKeywords = mustMention.filter((kw) => !text.includes(kw.toLowerCase()));
  if (missingKeywords.length > 0) {
    failures.push(`Missing required keywords: ${missingKeywords.join(', ')}`);
  }

  const mentionScore = mustMention.length > 0 ? mentionedCount / mustMention.length : 1;
  const score = forbiddenFound.length > 0 ? 0 : mentionScore;

  return { score, failures };
}

function scoreEvidence(scenario: IncidentScenario, output: EvalOutput): { score: number; failures: string[] } {
  const requiredEvidence = scenario.expected.requiredEvidence ?? [];
  const failures: string[] = [];

  if (requiredEvidence.length === 0) {
    return { score: 1, failures: [] };
  }

  let passed = 0;
  for (const req of requiredEvidence) {
    const matchingCalls = output.trace.toolCalls.filter((tc) => tc.tool === req.tool);

    if (matchingCalls.length === 0) {
      failures.push(`Tool ${req.tool} never called`);
      continue;
    }

    const outputText = matchingCalls.map((tc) => JSON.stringify(tc.output)).join(' ').toLowerCase();
    const missing = req.mustMention.filter((m) => !outputText.includes(m.toLowerCase()));

    if (missing.length > 0) {
      failures.push(`Evidence missing for ${req.tool}: ${missing.join(', ')}`);
    } else {
      passed++;
    }
  }

  return { score: passed / requiredEvidence.length, failures };
}

function scoreEfficiency(scenario: IncidentScenario, output: EvalOutput): { score: number; failures: string[] } {
  const budgets = scenario.budgets ?? {};
  const failures: string[] = [];

  const toolCalls = output.trace.toolCalls.length;
  const maxToolCalls = budgets.maxToolCalls ?? 15;

  if (toolCalls > maxToolCalls) {
    failures.push(`Exceeded tool call budget: ${toolCalls} > ${maxToolCalls}`);
  }

  const totalTokens = (output.trace.usage?.inputTokens ?? 0) + (output.trace.usage?.outputTokens ?? 0);
  const maxTokens = budgets.maxTotalTokens ?? 10000;

  if (totalTokens > maxTokens) {
    failures.push(`Exceeded token budget: ${totalTokens} > ${maxTokens}`);
  }

  const toolScore = toolCalls <= maxToolCalls ? 1 : Math.max(0, 1 - (toolCalls - maxToolCalls) / maxToolCalls);
  const tokenScore = totalTokens === 0 || totalTokens <= maxTokens ? 1 : Math.max(0, 1 - (totalTokens - maxTokens) / maxTokens);

  return { score: (toolScore + tokenScore) / 2, failures };
}

async function runScenario(
  scenario: IncidentScenario,
  config: RunConfig
): Promise<{ output: EvalOutput; scores: FailedScenario['scores']; failures: string[] }> {
  const harness = getHarness(config.harness);
  const trace = await harness.run(scenario, config);

  const rootCause = extractRootCause(trace.finalText);
  const evidence = extractEvidence(trace.finalText);

  const output: EvalOutput = { trace, rootCause, evidence };

  const rcaResult = scoreRCA(scenario, rootCause);
  const evidenceResult = scoreEvidence(scenario, output);
  const efficiencyResult = scoreEfficiency(scenario, output);

  const allFailures = [...rcaResult.failures, ...evidenceResult.failures, ...efficiencyResult.failures];

  return {
    output,
    scores: {
      rcaAccuracy: rcaResult.score,
      evidenceQuality: evidenceResult.score,
      efficiency: efficiencyResult.score,
    },
    failures: allFailures,
  };
}

async function analyzeFails(failures: FailedScenario[], skillContent: string): Promise<PromptFix | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set for optimizer');
  }

  const client = new Anthropic({ apiKey });

  const failureSummary = failures
    .map((f) => {
      return `
## Scenario: ${f.scenario.id} - ${f.scenario.name}

**Prompt:** ${f.scenario.prompt.slice(0, 200)}...

**Expected keywords:** ${f.scenario.expected.rootCauseMustMention.join(', ')}

**Agent's root cause:** ${f.output.rootCause.slice(0, 300)}...

**Failures:**
${f.failures.map((fail) => `- ${fail}`).join('\n')}

**Scores:** RCA: ${f.scores.rcaAccuracy.toFixed(2)}, Evidence: ${f.scores.evidenceQuality.toFixed(2)}, Efficiency: ${f.scores.efficiency.toFixed(2)}
`;
    })
    .join('\n---\n');

  const prompt = `You are debugging a Gilfoyle SRE agent skill. Analyze the failures and suggest a surgical edit to SKILL.md.

## FAILING SCENARIOS

${failureSummary}

## CURRENT SKILL.MD

\`\`\`markdown
${skillContent}
\`\`\`

## YOUR TASK

Analyze WHY the agent failed to identify the correct root cause or gather proper evidence.

Common issues:
1. Not following the hypothesis-driven methodology
2. Missing specific query patterns for common issues
3. Not using spotlight/differential analysis effectively
4. Jumping to conclusions without evidence

Suggest a SURGICAL edit to SKILL.md that will help the agent perform better on these scenarios WITHOUT overfitting.

## RESPONSE FORMAT

Respond with JSON only:
{
  "analysis": "Root cause analysis of why the agent failed",
  "old_text": "EXACT text to find in SKILL.md (copy precisely, including whitespace)",
  "new_text": "Replacement text",
  "explanation": "Why this fix addresses the failure pattern",
  "target_scenarios": ["scenario-id-1", "scenario-id-2"]
}

CRITICAL:
1. old_text must be an EXACT substring that exists in SKILL.md
2. Keep edits minimal but effective
3. Target the root cause of failures, not symptoms
4. Don't add scenario-specific hacks
`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b: Anthropic.ContentBlock) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    return null;
  }

  try {
    const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      analysis: parsed.analysis,
      oldText: parsed.old_text,
      newText: parsed.new_text,
      explanation: parsed.explanation,
      targetScenarios: parsed.target_scenarios ?? [],
    };
  } catch {
    console.error('Failed to parse optimizer response:', textBlock.text);
    return null;
  }
}

async function applyFix(fix: PromptFix): Promise<boolean> {
  const content = await readFile(SKILL_PATH, 'utf-8');

  if (!content.includes(fix.oldText)) {
    console.error('old_text not found in SKILL.md');
    console.error('--- OLD TEXT ---');
    console.error(fix.oldText);
    return false;
  }

  const newContent = content.replace(fix.oldText, fix.newText);
  await writeFile(SKILL_PATH, newContent, 'utf-8');
  return true;
}

export interface OptimizeOptions {
  harness?: HarnessName;
  model?: ModelName;
  apply?: boolean;
  verbose?: boolean;
}

export async function optimize(options: OptimizeOptions = {}): Promise<OptimizeResult> {
  const harness = options.harness ?? 'amp';
  const model = options.model ?? 'claude-opus-4';
  const shouldApply = options.apply ?? false;
  const verbose = options.verbose ?? false;

  const scenarios = loadScenarios();
  const config: RunConfig = { harness, model };

  console.log(`Running ${scenarios.length} scenarios with harness=${harness}, model=${model}`);

  const failures: FailedScenario[] = [];
  let passedCount = 0;

  for (const scenario of scenarios) {
    console.log(`  Running: ${scenario.id}...`);

    try {
      const result = await runScenario(scenario, config);

      const passed = result.scores.rcaAccuracy >= 0.8 && result.scores.evidenceQuality >= 0.5;

      if (passed) {
        passedCount++;
        console.log(`    ✓ PASSED (RCA: ${result.scores.rcaAccuracy.toFixed(2)})`);
      } else {
        failures.push({
          scenario,
          output: result.output,
          scores: result.scores,
          failures: result.failures,
        });
        console.log(`    ✗ FAILED: ${result.failures[0] ?? 'Low scores'}`);
      }

      if (verbose) {
        console.log(`      Tool calls: ${result.output.trace.toolCalls.length}`);
        console.log(`      Root cause: ${result.output.rootCause.slice(0, 100)}...`);
      }
    } catch (err) {
      console.error(`    ✗ ERROR: ${err instanceof Error ? err.message : String(err)}`);
      failures.push({
        scenario,
        output: {
          trace: { finalText: '', toolCalls: [], elapsedMs: 0 },
          rootCause: '',
          evidence: [],
        },
        scores: { rcaAccuracy: 0, evidenceQuality: 0, efficiency: 0 },
        failures: [`Runtime error: ${err instanceof Error ? err.message : String(err)}`],
      });
    }
  }

  console.log(`\nResults: ${passedCount}/${scenarios.length} passed`);

  if (failures.length === 0) {
    console.log('All scenarios pass!');
    return {
      totalScenarios: scenarios.length,
      failedCount: 0,
      passedCount,
      failures: [],
      applied: false,
    };
  }

  console.log(`\nAnalyzing ${failures.length} failures...`);
  const skillContent = await readFile(SKILL_PATH, 'utf-8');
  const suggestedFix = await analyzeFails(failures, skillContent);

  if (!suggestedFix) {
    console.log('No fix suggested');
    return {
      totalScenarios: scenarios.length,
      failedCount: failures.length,
      passedCount,
      failures,
      applied: false,
    };
  }

  console.log('\n=== ANALYSIS ===');
  console.log(suggestedFix.analysis);
  console.log('\n=== EXPLANATION ===');
  console.log(suggestedFix.explanation);
  console.log('\n=== TARGET SCENARIOS ===');
  console.log(suggestedFix.targetScenarios.join(', '));

  let applied = false;
  if (shouldApply) {
    console.log('\nApplying fix...');
    applied = await applyFix(suggestedFix);
    if (applied) {
      console.log('Fix applied to SKILL.md');
      console.log('Re-run to verify: bun optimizer/run.ts');
    } else {
      console.log('Failed to apply fix');
    }
  } else {
    console.log('\n=== OLD TEXT ===');
    console.log(suggestedFix.oldText);
    console.log('\n=== NEW TEXT ===');
    console.log(suggestedFix.newText);
    console.log('\nTo apply: bun optimizer/run.ts --apply');
  }

  return {
    totalScenarios: scenarios.length,
    failedCount: failures.length,
    passedCount,
    failures,
    suggestedFix,
    applied,
  };
}
