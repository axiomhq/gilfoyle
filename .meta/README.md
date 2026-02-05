# Gilfoyle Eval Framework

Systematic evaluation of the Gilfoyle SRE skill across agent harnesses and models.

## Quick Start

```bash
cd gilfoyle/.meta
bun install
bun run eval              # Run all evals
bun run optimize          # Analyze failures, suggest SKILL.md edits
bun run optimize --apply  # Apply suggested fix
```

## Architecture

```
.meta/
├── gilfoyle.eval.ts      # Main Axiom eval entrypoint
├── axiom.config.ts       # Axiom eval configuration
├── harness/              # Agent framework adapters
│   ├── types.ts          # Core types (scenarios, traces, configs)
│   ├── amp.ts            # Amp harness (Anthropic Claude via direct API)
│   ├── opencode.ts       # OpenCode harness (xAI Grok via AI SDK)
│   ├── direct.ts         # Direct API harness (multi-provider)
│   └── index.ts          # Harness registry
├── tools/
│   └── mock-tools.ts     # Mock tool router for deterministic evals
├── scenarios/            # SRE incident scenarios
│   ├── redis-oom.ts      # Redis OOM from session cache leak
│   ├── deploy-rollback.ts # Bad deploy causes 500s
│   ├── db-pool-exhaustion.ts # Connection pool leak
│   └── index.ts          # Scenario registry
├── scorers/              # Scoring functions
│   ├── rca.ts            # RCA accuracy (keyword matching)
│   ├── evidence.ts       # Evidence quality (trace-backed)
│   └── efficiency.ts     # Tool calls + token budget
└── optimizer/            # SKILL.md self-improvement
    ├── optimize.ts       # Run evals, analyze failures, suggest edits
    ├── run.ts            # CLI entry point
    └── types.ts          # Optimizer types
```

## Running Evals

```bash
# Default: Amp harness with Claude Opus 4
bun run eval

# Specific harness
bun run eval --flag.harness=amp
bun run eval --flag.harness=opencode
bun run eval --flag.harness=direct

# Specific model
bun run eval --flag.harness=opencode --flag.model=grok-4.1-fast
```

## SKILL.md Optimizer

The optimizer runs ALL scenarios, analyzes failures, and suggests surgical edits to SKILL.md.

```bash
# Dry run - show suggested fix
bun run optimize

# Apply fix to SKILL.md
bun run optimize --apply

# Use different harness/model
bun optimizer/run.ts --harness=opencode --model=grok-4.1-fast

# Verbose output
bun optimizer/run.ts --verbose
```

The optimizer follows the same pattern as `webhook/router_optimize_test.go`:
1. Runs all scenarios (prevents overfitting)
2. Collects failures with scores
3. Sends failures + current SKILL.md to Claude for analysis
4. Suggests `old_text` → `new_text` surgical edits
5. Optionally applies fix with `--apply`

## Scoring

Three dimensions (all must pass for scenario to pass):

1. **RCA Accuracy** (≥0.8) - Does the root cause mention required keywords?
2. **Evidence Quality** (≥0.5) - Is evidence backed by actual tool outputs?
3. **Efficiency** - Tool calls and tokens within budget?

## Adding Scenarios

1. Create a new file in `scenarios/`:

```typescript
import type { IncidentScenario } from '../harness/types.js';

export const myScenario: IncidentScenario = {
  id: 'my-incident',
  name: 'Description of the incident',
  prompt: 'Alert: Something is broken...',
  initOutput: `Gilfoyle Environment Discovery
==============================
Axiom Environments:
  prod:
    datasets: [app-logs, k8s-events]
`,
  toolMocks: {
    axiom: [
      { when: { contains: ['error', 'keyword'] }, return: { rows: [...] } },
    ],
    grafana: [
      { when: { contains: ['metric_name'] }, return: { series: [...] } },
    ],
  },
  expected: {
    rootCauseMustMention: ['keyword1', 'keyword2'],
    rootCauseMustNotMention: ['red-herring'],
    requiredEvidence: [
      { tool: 'scripts/axiom-query', mustMention: ['keyword1'] },
    ],
  },
  budgets: { maxToolCalls: 10, maxTotalTokens: 8000 },
};
```

2. Add to `scenarios/index.ts`

## Harness Implementation

| Harness | Model | Backend | Status |
|---------|-------|---------|--------|
| Amp | Claude Opus 4 | Anthropic API | ✅ Implemented |
| OpenCode | Grok 4.1 Fast | xAI API via AI SDK | ✅ Implemented |
| Direct | Any | AI SDK multi-provider | ✅ Implemented |

Note: Harnesses use direct API calls (not SDK wrappers) to enable tool mocking.
The Amp harness simulates Amp's behavior by using Claude with the same system
prompt and tools that Amp would provide.

## Environment Variables

```bash
# Required for Amp harness and optimizer
ANTHROPIC_API_KEY=sk-ant-...

# Required for OpenCode harness
XAI_API_KEY=xai-...

# For Axiom eval data export
AXIOM_URL=https://api.axiom.co
AXIOM_TOKEN=xaat-...
AXIOM_DATASET=gilfoyle-evals

# Override defaults
EVAL_HARNESS=amp
EVAL_MODEL=claude-opus-4
```

## Mocked Tools

All harnesses use the same mock tool router (`tools/mock-tools.ts`):

- `scripts/init` → Returns `scenario.initOutput`
- `scripts/axiom-query` → Matches query against `toolMocks.axiom`
- `scripts/grafana-query` → Matches promql against `toolMocks.grafana`
- `scripts/slack` → Matches method against `toolMocks.slack`
- `scripts/mem-write` → Always returns `{ ok: true }`

Mock matching uses `contains` (all substrings must match) or `regex` patterns.
