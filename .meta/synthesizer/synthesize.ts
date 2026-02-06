/**
 * Scenario Synthesizer
 *
 * Generates eval scenarios from seeds using a two-phase approach:
 * 1. LLM generates a structured blueprint (canonical events + metrics)
 * 2. Deterministic code expands it into messy fixtures
 *
 * Usage:
 *   bun synthesizer/synthesize.ts [--seed seeds/resource-exhaustion.ts] [--variants 3]
 *   bun synthesizer/synthesize.ts --all
 */

import { generateText } from 'ai';
import { google } from '@ai-sdk/google';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ScenarioSeed, ScenarioBlueprint } from './types.js';
import { expandBlueprint } from './messifier.js';
import { validateScenario } from './validator.js';
import type { IncidentScenario } from '../harness/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GEMINI_API_KEY) {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
}

const BLUEPRINT_PROMPT = `You are generating structured test data for an SRE agent evaluation framework.

Given a scenario seed describing an incident, generate a JSON blueprint that contains:
1. Canonical log events (the actual things that happened)
2. Metric series definitions (shapes and values)
3. An investigation path (steps an SRE would take to find the root cause)
4. Red herring events (plausible but unrelated issues)

CRITICAL RULES:
- Return ONLY valid JSON. No markdown, no prose, no explanation.
- Events should tell a realistic story but NEVER contain analysis text like "Root cause:" or "Analysis:"
- Events are raw observability data: log lines, error messages, status reports
- The root cause should require 2-5 query rounds to discover
- Include red herrings: unrelated errors/warnings that look suspicious but aren't the cause
- Metric shapes must be consistent with the log events timeline
- Keep event count between 30-80 canonical events total
- Keep metric count between 4-12 series

SEED:
{SEED_JSON}

OUTPUT JSON SCHEMA:
{
  "datasets": ["string"],
  "datasources": [{"uid": "string", "name": "string", "type": "prometheus"}],
  "deployments": ["string"],
  "events": [
    {
      "tsOffsetSec": number,      // seconds from scenario start
      "dataset": "string",        // which dataset this goes to
      "service": "string|null",
      "severity": "debug|info|warn|error",
      "message": "string",        // realistic log message, NOT analysis
      "attributes": {},           // additional key-value pairs
      "role": "breadcrumb|rootcause|background|red_herring",
      "clueId": "string|null"     // links to investigation steps
    }
  ],
  "metrics": [
    {
      "name": "string",           // prometheus metric name
      "labels": {},
      "shape": "baseline|spike|ramp|step_up|step_down|sawtooth",
      "baselineValue": number,
      "peakValue": number,
      "changeOffsetSec": number,  // when shape transitions
      "role": "symptom|rootcause|background|red_herring"
    }
  ],
  "investigationPath": [
    {
      "clueId": "string",
      "description": "string",
      "probeQueries": {
        "axiom": [{"dataset": "string", "mustContain": ["string"]}],
        "grafana": [{"metricName": "string"}]
      }
    }
  ],
  "expected": {
    "rootCauseMustMention": ["string"],
    "rootCauseMustNotMention": ["string"],
    "requiredQueries": [
      {
        "tool": "scripts/axiom-query|scripts/grafana-query",
        "mustMatch": "string (regex)",
        "description": "string"
      }
    ]
  }
}`;

function extractJSON(text: string): unknown {
  try { return JSON.parse(text); } catch {}

  const stripped = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '');
  try { return JSON.parse(stripped); } catch {}

  const start = stripped.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in LLM response');

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) return JSON.parse(stripped.slice(start, i + 1)); }
  }
  throw new Error('No complete JSON object found in LLM response');
}

async function generateBlueprint(seed: ScenarioSeed): Promise<ScenarioBlueprint> {
  const prompt = BLUEPRINT_PROMPT.replace('{SEED_JSON}', JSON.stringify(seed, null, 2));

  const { text } = await generateText({
    model: google('gemini-3-flash-preview'),
    prompt,
    maxOutputTokens: 8000,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = extractJSON(text) as any;

  // Ensure deployments always includes 'prod'
  if (!raw.deployments || !Array.isArray(raw.deployments) || !raw.deployments.includes('prod')) {
    raw.deployments = ['prod', ...(Array.isArray(raw.deployments) ? raw.deployments : [])];
  }

  const blueprint: ScenarioBlueprint = {
    seed,
    ...raw,
  };

  return blueprint;
}

function blueprintToScenario(
  blueprint: ScenarioBlueprint,
  variantIndex: number = 0,
): IncidentScenario {
  const seed = blueprint.seed;
  const fixtures = expandBlueprint(blueprint, variantIndex);

  // Generate init output from blueprint data
  const axiomDatasets = blueprint.datasets.join(', ');
  const grafanaDatasources = blueprint.datasources
    .map(ds => `${ds.name} (uid: ${ds.uid})`)
    .join(', ');

  const initOutput = `Gilfoyle Environment Discovery
==============================

Axiom Environments:
  ${blueprint.deployments[0]}:
    datasets: [${axiomDatasets}]

Grafana Environments:
  ${blueprint.deployments[0]}:
    datasources: [${grafanaDatasources}]

Slack:
  Available (workspace: acme)
`;

  const variantSuffix = variantIndex > 0 ? `-v${variantIndex}` : '';

  return {
    id: `${seed.id}${variantSuffix}`,
    name: `${seed.name}${variantIndex > 0 ? ` (variant ${variantIndex})` : ''}`,
    description: seed.rootCause.mechanism,
    prompt: seed.alertPrompt,
    initOutput,
    toolMocks: {},
    fixtures,
    expected: {
      rootCauseMustMention: blueprint.expected.rootCauseMustMention,
      rootCauseMustNotMention: blueprint.expected.rootCauseMustNotMention,
      requiredEvidence: [
        { tool: 'scripts/axiom-query', mustMention: seed.rootCause.mustSurfaceClues },
      ],
      requiredQueries: blueprint.expected.requiredQueries.map(q => ({
        tool: q.tool as 'scripts/axiom-query' | 'scripts/grafana-query',
        mustMatch: q.mustMatch,
        description: q.description,
      })),
    },
    budgets: {
      maxToolCalls: 8 + seed.difficulty.stepsToRootCause * 3,
      maxTotalTokens: 10000,
    },
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const seedsDir = join(__dirname, 'seeds');
  const outputDir = join(__dirname, 'generated');
  mkdirSync(outputDir, { recursive: true });

  let seedFiles: string[] = [];
  const variantCount = parseInt(args.find(a => a.startsWith('--variants='))?.split('=')[1] ?? '3');

  if (args.includes('--all')) {
    const { readdirSync } = await import('fs');
    seedFiles = readdirSync(seedsDir).filter(f => f.endsWith('.ts'));
  } else {
    const seedArg = args.find(a => a.startsWith('--seed='))?.split('=')[1];
    if (seedArg) seedFiles = [seedArg];
  }

  if (seedFiles.length === 0) {
    console.error('Usage: bun synthesizer/synthesize.ts --seed=<seed-file> [--variants=3]');
    console.error('       bun synthesizer/synthesize.ts --all');
    process.exit(1);
  }

  for (const seedFile of seedFiles) {
    const rawPath = seedFile.includes('/') ? seedFile : join(seedsDir, seedFile);
    const seedPath = rawPath.startsWith('/') ? rawPath : join(process.cwd(), rawPath);
    console.error(`\nSynthesizing from ${seedPath}...`);

    const seedModule = await import(seedPath);
    const seed: ScenarioSeed = seedModule.default ?? seedModule.seed;

    // Check for cached blueprint
    const blueprintPath = join(outputDir, `${seed.id}.blueprint.json`);
    let blueprint: ScenarioBlueprint;

    if (existsSync(blueprintPath) && !args.includes('--regenerate')) {
      console.error(`  Using cached blueprint: ${blueprintPath}`);
      blueprint = JSON.parse(readFileSync(blueprintPath, 'utf-8'));
      blueprint.seed = seed;
    } else {
      console.error(`  Generating blueprint via LLM...`);
      blueprint = await generateBlueprint(seed);
      writeFileSync(blueprintPath, JSON.stringify(blueprint, null, 2));
      console.error(`  Blueprint saved: ${blueprintPath}`);
    }

    // Generate variants
    const scenarios: IncidentScenario[] = [];
    for (let v = 0; v < variantCount; v++) {
      const scenario = blueprintToScenario(blueprint, v);

      // Validate solvability
      const validation = validateScenario(scenario, blueprint);
      if (!validation.solvable) {
        console.error(`  ⚠ Variant ${v} failed validation: ${validation.errors.join(', ')}`);
        continue;
      }

      scenarios.push(scenario);
      console.error(`  ✓ Variant ${v}: ${Object.values(scenario.fixtures!.datasets).reduce((n, rows) => n + rows.length, 0)} log rows, ${Object.values(scenario.fixtures!.metrics).reduce((n, series) => n + series.length, 0)} metric series`);
    }

    // Write scenarios
    const outPath = join(outputDir, `${seed.id}.scenarios.json`);
    writeFileSync(outPath, JSON.stringify(scenarios, null, 2));
    console.error(`  Wrote ${scenarios.length} scenarios to ${outPath}`);
  }
}

// Run if called directly
if (process.argv[1]?.includes('synthesize')) {
  main().catch(e => {
    console.error('Synthesis failed:', e);
    process.exit(1);
  });
}

export { generateBlueprint, blueprintToScenario };
