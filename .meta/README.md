# Gilfoyle Eval Framework

An eval framework for the Gilfoyle SRE skill. Measures whether the agent can actually investigate incidents, write valid APL/PromQL, and derive root causes from raw observability data — not whether it can pattern-match its way to a pre-baked answer.

Most agent evals are a retrieval game in disguise. This one isn't. The agent gets wide, dirty, realistic log rows and metric series. It has to query them, filter them, correlate across datasets, and reason about what it finds. No query returns `"Analysis: root cause is X"`. The agent earns its diagnosis or it doesn't.

## Architecture

```
                     ┌─────────────────────────────────────────────┐
                     │              gilfoyle.eval.ts                │
                     │         (Eval entrypoint, 5min timeout)      │
                     └──────────┬──────────────────────┬───────────┘
                                │                      │
                   ┌────────────▼──────────┐  ┌───────▼─────────┐
                   │     Scenario Loader    │  │     Scorers      │
                   │                        │  │                  │
                   │  Hand-crafted          │  │  query-validity  │
                   │    scenarios/*.ts      │  │  rca-accuracy    │
                   │                        │  │  evidence-quality│
                   │  Synthesized           │  │  efficiency      │
                   │    synthesizer/        │  │  wall-clock      │
                   │    generated/*.json    │  │  token-budget    │
                   │                        │  └──────────────────┘
                   └────────────┬──────────┘
                                │
                   ┌────────────▼──────────┐
                   │       Harness          │
                   │                        │
                   │  amp.ts   (@amp-sdk)   │
                   │  opencode.ts (@oc-sdk) │
                   └────────────┬──────────┘
                                │
                   ┌────────────▼──────────┐
                   │    Mock Tool v2        │
                   │   toolbox/mock-tool-   │
                   │        v2.ts          │
                   │                        │
                   │  Validates CLI args    │
                   │  Parses APL/PromQL     │
                   │  Executes against      │
                   │  fixture data          │
                   └────────────┬──────────┘
                                │
                   ┌────────────▼──────────┐
                   │    Fixture Engine      │
                   │  toolbox/fixture-      │
                   │      engine.ts         │
                   │                        │
                   │  APL parser/executor   │
                   │  PromQL validator      │
                   │  CLI contract enforcer │
                   │  Output formatter      │
                   └───────────────────────┘
```

**Pipeline:**

1. **Scenarios** — Hand-crafted incident scenarios (`scenarios/*.ts`) or synthesized from seeds via the two-phase synthesizer (`synthesizer/`). Each scenario includes fixture data: log rows and metric series the agent queries against.

2. **Harnesses** — Run an LLM agent against mock scripts in a temp directory.
   - `amp.ts` — Uses `@sourcegraph/amp-sdk` `execute()`. Intercepts tool_use/tool_result messages.
   - `opencode.ts` — Uses `@opencode-ai/sdk` `createOpencode()`. Allocates a random free port per session for parallel runs. Parses tool parts from message stream.
   - `codex.ts` — Uses direct OpenAI API calls via Vercel AI SDK (`@ai-sdk/openai`) for Codex/GPT model runs.

3. **Mock Tool v2** (`toolbox/mock-tool-v2.ts`) — Replaces simple keyword mocks. Backed by the fixture engine. Validates CLI contracts, parses APL/PromQL, executes queries against fixture data, returns computed results. Falls back to legacy keyword matching if no fixtures present.

4. **Fixture Engine** (`toolbox/fixture-engine.ts`) — The query execution layer. Parses APL (dataset bracket syntax, pipe stages), validates PromQL (metric names, label matchers, balanced syntax), enforces CLI contracts, and formats output to match real `scripts/axiom-query-fmt` and `scripts/grafana-query` output.

5. **Scorers** — Multiple scoring dimensions evaluated after each run. Details below.

## Quick Start

### Prerequisites

- Node.js and npm (or bun)
- API keys: `XAI_API_KEY` (for Grok via OpenCode), `GEMINI_API_KEY` (for RCA scorer and synthesizer)
- `source .envrc` to load keys (or set them manually)

### Install

```bash
cd .meta && npm install
```

### Run Evals

Hand-crafted scenarios only (default):
```bash
EVAL_HARNESS=opencode npx axiom eval --debug
```

Synthesized scenarios only:
```bash
EVAL_SYNTH_ONLY=1 EVAL_HARNESS=opencode npx axiom eval --debug
```

Both combined:
```bash
EVAL_SYNTHESIZED=1 EVAL_HARNESS=opencode npx axiom eval --debug
```

Using Amp harness instead:
```bash
EVAL_HARNESS=amp npx axiom eval --debug
```

### Debug & Typecheck

```bash
# Verbose harness logging
DEBUG_OPENCODE_HARNESS=1 EVAL_HARNESS=opencode npx axiom eval --debug
DEBUG_AMP_HARNESS=1 EVAL_HARNESS=amp npx axiom eval --debug

# Score diagnostics:
# - config snapshot across all latest runs
# - per-config case + failure-signature reports for all latest runs
bun run eval:diagnostics

# Optional targeting knobs:
# - EVAL_DEPLOYMENT (default: play)
# - EVAL_DATASET_NAME (falls back to AXIOM_DATASET, then gilfoyle-evals)
# - EVAL_TARGET_EVAL (optional: limit to one eval config)
# - EVAL_VERSION (optional: limit to a specific version)
# - EVAL_MIN_CASE_COVERAGE_RATIO (default 0.8; ignore partial runs in config snapshots)
EVAL_DEPLOYMENT=play \
EVAL_DATASET_NAME=gilfoyle-evals \
EVAL_TARGET_EVAL=gilfoyle-sre-opencode-ollama-cloud-minimax-m2-5 \
bun run eval:diagnostics

# Typecheck
npx tsc --noEmit
```

## Scenario Synthesizer

The synthesizer exists because hand-crafting fixture-driven scenarios is tedious and humans are bad at generating realistic mess. It uses a two-phase pipeline: LLM for narrative, deterministic code for mess.

### Phase 1: Seeds → Blueprints

Seeds are ~25-line human-written configs in `synthesizer/seeds/*.ts`. They describe:

- **Incident archetype** (`resource_exhaustion`, `bad_deploy`, `dependency_failure`, `resource_leak`, etc.)
- **Service topology** (which services exist, which is the fault origin, which are affected)
- **Root cause mechanism** (what actually went wrong, in one sentence)
- **Difficulty knobs** (`stepsToRootCause`, `signalBuriedness`, `redHerringCount`)
- **Messiness knobs** (`fieldWidth`, `nullRate`, `jsonEncodedRate`, `casingDrift`, `aliasRate`)

The synthesizer sends the seed to Gemini, which generates a structured JSON **blueprint** containing:
- Canonical log events (30-80) with roles: `breadcrumb`, `rootcause`, `background`, `red_herring`
- Metric series definitions with shapes: `baseline`, `spike`, `ramp`, `step_up`, `step_down`, `sawtooth`
- An investigation path (the steps an SRE would follow to find the root cause)
- Expected outputs (required keywords, required queries)

Blueprints are cached in `synthesizer/generated/*.blueprint.json`. Pass `--regenerate` to force re-generation.

### Phase 2: Blueprints → Messy Fixtures

The **messifier** (`synthesizer/messifier.ts`) takes clean canonical events and deterministically expands them into wide, dirty Axiom-like log rows:

- **25-50 fields per row**, most irrelevant (k8s pod IPs, build SHAs, feature flags, GC pause times)
- **Inconsistent field naming**: `service` vs `svc` vs `app.service` vs `kubernetes.container_name` vs `resource.service.name`
- **Casing drift**: `level` vs `LEVEL` vs `Level` vs `log-level`
- **Null injection**: random fields set to null
- **JSON-encoded values**: string values that are actually stringified JSON objects
- **Background noise rows**: `"health check passed"`, `"config reload complete"`, `"metrics flushed"` — realistic clutter

Uses a seeded PRNG (`createRng`) keyed on `{seedId}-{variantIndex}` so variants are different but reproducible.

### Phase 3: Solvability Validation

The **validator** (`synthesizer/validator.ts`) runs probe queries against generated fixtures to ensure the scenario is actually solvable:

- Every dataset referenced in the investigation path exists and is non-empty
- Root cause clue terms appear in the dataset rows
- Every metric referenced exists in fixtures
- Basic APL/PromQL queries execute without errors
- Signal-to-noise ratio isn't too high (agent has to actually filter)
- Dataset sizes are realistic (10-5000 rows)

Unsolvable variants are rejected with a warning.

### Running the Synthesizer

```bash
# Single seed, 3 variants (default)
bun synthesizer/synthesize.ts --seed=synthesizer/seeds/redis-oom.ts --variants=3

# All seeds
bun synthesizer/synthesize.ts --all

# Force regenerate blueprints
bun synthesizer/synthesize.ts --all --regenerate
```

Output goes to `synthesizer/generated/`.

## Writing New Seeds

Create a file in `synthesizer/seeds/` that exports a `ScenarioSeed`:

```typescript
import type { ScenarioSeed } from '../types.js';

export const seed: ScenarioSeed = {
  id: 'my-incident',                    // unique ID, used for filenames
  name: 'Human-readable incident name',
  archetype: 'resource_exhaustion',      // incident category

  topology: {
    services: ['svc-a', 'svc-b', 'svc-c'],  // all services in the system
    primaryFaultService: 'svc-b',             // where the bug lives
    affectedServices: ['svc-a', 'svc-b'],     // what breaks
  },

  rootCause: {
    mechanism: 'One sentence explaining what went wrong',
    category: 'code',                    // code | config | dependency | capacity | infra
    components: ['svc-b', 'redis'],      // involved components
    mustSurfaceClues: ['keyword1', 'keyword2'],  // must appear in generated data
  },

  alertPrompt: `What the on-call human sees in PagerDuty.`,

  difficulty: {
    stepsToRootCause: 3,    // 2-5: query rounds to reach RCA
    signalBuriedness: 1,    // 0-3: 0=obvious, 3=needle-in-haystack
    redHerringCount: 2,     // unrelated suspicious events
  },

  messiness: {
    fieldWidth: [25, 45],    // target fields per log row [min, max]
    nullRate: 0.15,          // 0-1: fraction of fields randomly nulled
    jsonEncodedRate: 0.1,    // 0-1: values stored as stringified JSON
    casingDrift: 0.2,        // 0-1: frequency of wrong-case field names
    aliasRate: 0.3,          // 0-1: same concept under different field names
  },

  timeRangeMinutes: 60,     // scenario time window
  variations: 3,            // number of variants to generate
};

export default seed;
```

**Difficulty knobs explained:**
- `stepsToRootCause: 2` — Agent can get to RCA in 2 queries after init. Easy.
- `stepsToRootCause: 5` — Needs 5 rounds of querying, each informed by the last. Hard.
- `signalBuriedness: 0` — Root cause clues are in obvious fields. `signalBuriedness: 3` — Buried in JSON-encoded values inside noise fields.
- `redHerringCount: 3` — Three unrelated suspicious events that look like they could be the cause but aren't.

**Messiness knobs explained:**
- `fieldWidth: [30, 50]` — Each log row has 30-50 fields. Most are noise. Real Axiom data looks like this.
- `nullRate: 0.2` — 20% of non-essential fields are null. Agents that assume all fields are populated will fail.
- `aliasRate: 0.3` — 30% of the time, `service` might appear as `svc` or `app.service`. Agents that hardcode field names will miss data.

## Scorers

### query-validity (hard gate)

**Weight: 60% syntax validity + 40% required queries**

Measures whether the agent can write valid APL and PromQL. If it can't, nothing else matters.

- **Syntax validity**: What fraction of query tool calls executed without errors? Invalid APL syntax, unknown datasets, unknown metrics, malformed PromQL — all count as failures.
- **Required queries**: Did the agent query the right datasets and metrics? Each scenario defines `requiredQueries` with regex patterns. An agent that queries `['application-logs']` when the dataset is `['app-logs']` fails this check.

Score 0 if no query tool calls were made at all.

### rca-accuracy (LLM judge)

**Primary scorer for correctness.**

Sends the agent's conclusion to Gemini with the scenario description and expected root cause keywords. Gemini scores 0-100 on whether the agent identified the actual root cause.

Falls back to keyword matching if the LLM judge fails: counts what fraction of `rootCauseMustMention` keywords appear in the agent's output.

### evidence-quality

**Weight: 40% tool used + 30% keywords in output + 30% specific data points cited**

Checks that the agent's final answer cites specific data points from tool outputs, not just vibes.

- **Tool used** (40%): Did the agent call the required tools at all?
- **Keywords in output** (30%): Did the tool outputs contain the required evidence keywords?
- **Data points cited** (30%): Does the agent's final text reference specific numbers, timestamps, or identifiers from tool outputs? Looks for numbers > 100, ISO timestamps, and percentages that appear in both tool output and final text.

### efficiency

**Weight: 40% budget compliance + 30% no failed queries + 30% no redundant queries**

- **Budget compliance** (40%): Did the agent stay within `maxToolCalls`? Linear penalty for exceeding budget.
- **Failed queries** (30%): What fraction of queries failed with syntax/contract errors? Each failure is wasted compute.
- **Redundant queries** (30%): Near-duplicate queries detected via normalization (lowercase, whitespace collapse, quote removal). Running the same query twice is a sign the agent lost track of what it already knows.

### wall-clock

**Explicit end-to-end runtime score (elapsed wall time).**

- Uses `trace.elapsedMs` from the harness run.
- Honors scenario `budgets.maxElapsedMs` where provided.
- Otherwise derives a budget from scenario shape (`maxToolCalls`, setup-only vs query-heavy scenarios).
- Adds a cadence component (`ms/tool-call`) to penalize slow loops.

### token-budget

**Token spend score against per-scenario `maxTotalTokens`.**

- Uses harness-reported `inputTokens + outputTokens`.
- Score is 1 within budget; linear decay to 0 at 2x budget.
- Marked non-applicable if a scenario has no token budget or provider does not report usage.

## Fixture Engine

The fixture engine (`toolbox/fixture-engine.ts`) is what separates this from a retrieval game. Instead of keyword-matching mock responses, it actually parses and executes queries against fixture data.

### APL Support

- **Dataset bracket syntax**: `['dataset-name']` — validates dataset exists in fixtures
- **Pipe stages**: `|` delimited, handles nested strings and parentheses
- **where**: `field == value`, `field contains value`, `field > value`, `field startswith value`, `field has value`, negations
- **summarize**: `count()`, `dcount(field)`, `avg(field)`, `sum(field)`, `max(field)`, `min(field)`, with optional `by field1, field2`
- **take/limit**: `take N`
- **sort/order by**: `sort by field asc|desc`
- **project**: `project field1, field2`
- **extend**: passthrough (recognized but not executed)
- **top**: `top N by field`

### PromQL Support

- **Metric name extraction**: handles bare metrics, `metric{labels}`, `func(metric{labels}[range])`, nested functions
- **Label matchers**: `=`, `!=`, `=~`, `!~` — filters series by label values
- **Syntax validation**: balanced parentheses, braces, brackets
- **Metric existence**: validates against known metrics in fixtures, provides available metric names on miss
- **Known function skip list**: `rate`, `increase`, `sum`, `avg`, `max`, `min`, `count`, `histogram_quantile`, `irate`, `delta`, `deriv`, and 20+ others

### CLI Contract Enforcement

**axiom-query:**
```
axiom-query <deployment> [--raw|--ndjson|--full|--trace] [--query "<APL>"|--query-file /path/to/query.apl]
```
- Deployment accepts aliases (for example `prod` in single-deployment fixtures)
- Query accepted via stdin, `--query`, or `--query-file`
- Unknown flags rejected

**grafana-query:**
```
grafana-query <deployment> <datasource_uid> [<promql_query>] [--query "<PromQL>"|--query-file /path/to/query.promql]
```
- Deployment accepts aliases (for example `prod` in single-deployment fixtures)
- Datasource accepts UID, name, and `name (uid)` forms
- Query accepted as positional arg, `--query`, or `--query-file`

### Output Formatting

APL results formatted like `scripts/axiom-query-fmt` text mode:
```
# 15/1000 rows, 42ms
_time=2026-02-06T14:32:10Z level=warn message="memory usage above 90%"
```

PromQL results formatted like `scripts/grafana-query` text mode:
```
Deployment: prod
Datasource: prom-prod
Query: redis_memory_used_bytes
Range: 1h (step: 1m)

Series: 1

Metric: {instance="redis-primary-0", pod="redis-primary-0"}
Samples: 7
Min: 5368709120
Max: 8556380160
Avg: 7212753218.4
```

## File Structure

```
.meta/
├── gilfoyle.eval.ts              # Eval entrypoint — Eval() config, scorers, timeout
├── package.json                  # Dependencies: amp-sdk, opencode-sdk, ai, axiom, zod
├── tsconfig.json                 # TypeScript config
│
├── harness/
│   ├── index.ts                  # Harness registry and getHarness()
│   ├── types.ts                  # Core types: IncidentScenario, RunTrace, ScenarioFixtures
│   ├── amp.ts                    # Amp harness — @sourcegraph/amp-sdk execute()
│   └── opencode.ts               # OpenCode harness — @opencode-ai/sdk, random port per session
│
├── scenarios/
│   ├── index.ts                  # Scenario loader — hand-crafted + generated, env var switches
│   ├── redis-oom.ts              # Redis OOM from session cache leak (fixture-driven)
│   ├── deploy-rollback.ts        # Bad deploy breaks DB connection pool (fixture-driven)
│   └── db-pool-exhaustion.ts     # DB connection pool leak in payment handler (fixture-driven)
│
├── scorers/
│   ├── index.ts                  # Scorer exports
│   ├── query-validity.ts         # Syntax validity + required queries (hard gate)
│   ├── rca.ts                    # LLM judge (Gemini) with keyword fallback
│   ├── evidence.ts               # Tool usage + keyword presence + data point citations
│   └── efficiency.ts             # Budget compliance + failure rate + redundancy detection
│
├── synthesizer/
│   ├── index.ts                  # Synthesizer exports
│   ├── types.ts                  # Seed, Blueprint, BlueprintEvent, BlueprintMetric types
│   ├── synthesize.ts             # Two-phase synthesis pipeline — seed → blueprint → scenario
│   ├── messifier.ts              # Deterministic expansion into wide dirty log rows
│   ├── validator.ts              # Solvability probes — ensures generated scenarios work
│   ├── seeds/
│   │   ├── redis-oom.ts          # Resource exhaustion: session cache without TTL
│   │   ├── goroutine-leak.ts     # Resource leak: websocket handler goroutine leak
│   │   └── kafka-consumer-lag.ts # (Dependency failure / consumer lag)
│   └── generated/                # Output directory for synthesized scenarios + blueprints
│
└── toolbox/
    ├── mock-tool-v2.ts           # Fixture-driven mock — validates CLI, parses queries, executes
    ├── mock-tool.ts              # Legacy keyword mock (deprecated)
    └── fixture-engine.ts         # APL parser/executor, PromQL validator, CLI contract enforcer
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `EVAL_HARNESS` | No | `amp` | Which harness to use: `amp`, `opencode`, `claude`, or `codex` |
| `EVAL_MODEL` | No | depends on harness | Model identifier for the selected harness |
| `EVAL_SYNTHESIZED` | No | — | Set to `1` to include synthesized scenarios alongside hand-crafted |
| `EVAL_SYNTH_ONLY` | No | — | Set to `1` to run only synthesized scenarios |
| `XAI_API_KEY` | For OpenCode | — | xAI API key (Grok models via OpenCode harness) |
| `OPENAI_API_KEY` | For Codex | — | OpenAI API key (Codex/GPT models via Codex harness) |
| `GEMINI_API_KEY` | For scorers/synth | — | Google Gemini API key (RCA scorer + synthesizer) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Alt for Gemini | — | Alternative env var for Gemini (auto-set from `GEMINI_API_KEY`) |
| `DEBUG_OPENCODE_HARNESS` | No | — | Set to `1` for verbose OpenCode harness logging |
| `DEBUG_AMP_HARNESS` | No | — | Set to `1` for verbose Amp harness logging |
| `GILFOYLE_SCENARIO_FILE` | Internal | — | Set by harnesses. Points mock tools to scenario JSON. Don't set manually. |

## Design Decisions

### Fixture-driven over keyword mocks

The original `mock-tool.ts` used keyword matching: if the query contained `"redis"` and `"error"`, return a pre-baked response. This creates false confidence. The agent learns to say magic words, not to investigate. It's a retrieval game wearing an SRE costume.

Fixture-driven mocks fix this. The agent writes real APL (`['redis-logs'] | where level == 'error' | take 10`), the engine parses it, executes it against actual data, and returns computed results. Bad syntax fails. Wrong dataset names fail. The agent has to know what it's doing.

### Two-phase synthesis

LLMs are good at narrative structure (what events happen in what order, what makes a plausible red herring) but bad at generating realistic wide data (they'll give you 5 clean fields per row when real Axiom data has 40 messy ones).

So the LLM generates the narrative blueprint — canonical events, metric shapes, investigation path — and deterministic code handles the mess. The messifier adds noise fields, aliases field names, injects nulls, JSON-encodes values, and generates background chatter. Reproducible via seeded PRNG.

### Solvability validation

Generating scenarios from LLM blueprints means some will be unsolvable — the LLM might reference a metric that the messifier didn't create, or the root cause clues might get diluted past findability. The validator catches this before the scenario reaches the eval runner, so you don't waste 5 minutes of LLM time on an impossible scenario.

### 5-minute timeout

LLM investigations are inherently slow. The agent needs to: read init output, formulate a hypothesis, write a query, read results, refine, write another query, maybe two more, then synthesize a conclusion. At typical LLM speeds with tool-use round trips, 60 seconds isn't enough. 300 seconds is.

### Random ports for parallel OpenCode runs

OpenCode requires a local server. Running multiple eval scenarios in parallel means multiple servers. Each one binds to `127.0.0.1:0`, gets an OS-assigned port, and tears down after the run. No port conflicts, no sequential bottleneck.
