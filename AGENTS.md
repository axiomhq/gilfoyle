# Agent Instructions

You're working on Gilfoyle. Act accordingly.

## Golden Rule

**Test before committing.** You don't guess. You verify.

## Commands

```bash
# Build SKILL.md from SKILL.core.md + persona
scripts/build-skill gilfoyle > SKILL.md

# Test the build pipeline
scripts/test-build

# Sync to external skills repo
scripts/sync-to-skills /path/to/skills/sre

# Validate config works
scripts/config --list axiom

# Run memory tests
scripts/memory-test

# Check memory health
scripts/mem-doctor
```

## Evals

The eval framework lives in `.meta/`. It runs incident scenarios through LLM harnesses and scores the results.

```bash
cd .meta
bun install

# Run all evals (uses EVAL_HARNESS env, defaults to amp)
npx axiom eval

# Run specific harness
EVAL_HARNESS=amp npx axiom eval
EVAL_HARNESS=opencode EVAL_MODEL=xai/grok-4-1-fast npx axiom eval
EVAL_HARNESS=codex EVAL_MODEL=gpt-5.2-codex npx axiom eval

# Typecheck + lint (run before committing)
bun run check

# Typecheck only
bun run typecheck

# Lint only
bun run lint

# Debug opencode harness
DEBUG_OPENCODE_HARNESS=1 EVAL_HARNESS=opencode npx axiom eval
```

Required env vars: `AXIOM_TOKEN`, `AXIOM_DATASET`, `AXIOM_ORG_ID`. Plus API keys for the harness (`AMP_API_KEY`, `XAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`).

CI runs on push to main when skill/script files change (`.github/workflows/eval.yml`).

## Pre-commit Checklist

After changing SKILL.core.md, reference files, or scripts:

```bash
# 1. Build SKILL.md from source
scripts/build-skill gilfoyle > SKILL.md

# 2. Run build tests (checks line count, placeholders, sections, idempotency)
scripts/test-build

# 3. Run evals (source env vars first)
source .envrc.dev
cd .meta && npx axiom eval
```

Steps 1-2 must pass. Step 3 produces a comparison against baseline — review the deltas and don't commit if key metrics regressed.

## Code Style

- Bash scripts: `set -euo pipefail`, use `${VAR:-}` for optional vars
- Config path: `${GILFOYLE_CONFIG_DIR:-$HOME/.config/gilfoyle}`
- Memory path: `$CONFIG_DIR/memory/`
- No secrets in code. Ever. I will find them.

## File Organization

```
gilfoyle/
├── SKILL.md              # Main skill definition (<500 lines)
├── SKILL.core.md         # Core skill without persona (build input)
├── personas/             # Persona overlays for build-skill
├── scripts/              # All executable tools
├── reference/            # Deep-dive documentation
├── templates/            # Memory system templates
├── .meta/                # Eval framework (bun project)
└── .github/workflows/    # CI (eval runs on push to main)
```

## Persona

When writing user-facing text (README, error messages, comments):
- Deadpan, sardonic, technically superior
- No pleasantries, no apologies
- Dark humor welcome
