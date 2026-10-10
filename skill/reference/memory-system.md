# Memory System

Three-tier memory with automatic merging. All tiers use identical structure.

## Tiers

| Tier | Location | Scope | Sync |
|------|----------|-------|------|
| Personal | `~/.config/gilfoyle/memory/` | Just me | None |
| Project | `$GILFOYLE_PROJECT_MEMORY_DIR`, else `<git-toplevel>/.gilfoyle/memory/` | Everyone working on this repo | The project's own git (normal PRs) |
| Org | `~/.config/gilfoyle/memory/orgs/{org}/` | Team-wide | Own git repo (auto commit + push) |

## Reading Memory

Before investigating, read all memory tiers. **ALWAYS read full files.** NEVER use `head -n N` or other partial read operators; a partial knowledge base is worse than none.

```bash
# Personal tier
cat ~/.config/gilfoyle/memory/kb/*.md

# All org tiers (read each org that exists)
for org in ~/.config/gilfoyle/memory/orgs/*/kb; do
  cat "$org"/*.md 2>/dev/null
done

# Project tier (only if it exists; scripts/init prints the resolved path)
project_dir="${GILFOYLE_PROJECT_MEMORY_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)/.gilfoyle/memory}"
cat "$project_dir"/kb/*.md 2>/dev/null
```

When displaying entries, tag by source tier so user knows origin:
```
[org:axiom] Connection pool pattern: check for leaked connections...
[project] Payments logs live in the payments-prod dataset
[personal] I prefer 5m time bins for latency analysis
```

If same entry exists in multiple tiers: Personal overrides Project overrides Org.

## Writing Memory

Use `scripts/mem-write` to save entries:

```bash
# Personal tier (default)
scripts/mem-write facts "dataset-location" "Primary logs in k8s-logs-dev dataset"

# With type and tags
scripts/mem-write --type pattern --tags "db,timeout" patterns "conn-pool" "Connection pool exhaustion signature"

# Project tier (file only: no git add, commit or push)
scripts/mem-write --project facts "payments-dataset" "Payments logs live in ['payments-prod']"

# Org tier
scripts/mem-write --org axiom patterns "timeout-pattern" "How to detect timeouts"
```

| Trigger | Target | Example |
|---------|--------|---------|
| "remember this" | Personal | "Remember I prefer to DM @alice" |
| "save for this project" | Project | "Note in the repo that payments logs are in payments-prod" |
| "save for the team" | Org | "Save this pattern for the team" |
| Auto-learning | Personal | Query worked → saved automatically |

Org writes are automatically committed and pushed — no extra step needed.

Project writes are the opposite: `mem-write --project` appends to the file and stops. No `git add`, no commit, no push. The change shows up in `git status` and goes through the project's normal review. Never write to the project tier unprompted; every write is a diff in someone's repo.

`--project` fails if no project directory resolves. It does not fall back to the personal tier, and it does not create the directory. `--project` and `--org` are mutually exclusive; `--project` also beats `$MEMORY_ORG_NAME`.

## First-Time Setup

```bash
scripts/init    # Personal tier + orgs config; reports project memory if the repo has it
```

## Org Setup

```bash
# Add an org (one-time)
scripts/org-add axiom git@github.com:axiomhq/sre-memory.git

# Sync org memory (pull latest)
scripts/mem-sync

# Check for uncommitted org changes
scripts/mem-doctor
```

## Project Setup

The project tier lives in the repository it describes, so it is reviewed and versioned with the code. Nothing creates it for you. Opt in once, from the repo root:

```bash
mkdir -p .gilfoyle/memory/kb
scripts/mem-write --project facts "payments-dataset" "Payments logs live in ['payments-prod']"
git add .gilfoyle/memory && git commit    # your commit, your review. Git ignores empty directories; commit a file.
```

Location, in order:
1. `GILFOYLE_PROJECT_MEMORY_DIR`, when set. It is authoritative: if the directory has no `kb/`, the write fails. It does not quietly look elsewhere.
2. `<git-toplevel>/.gilfoyle/memory`, found from the current working directory.

The tier exists only if its `kb/` does. Same layout as the personal tier (`kb/facts.md`, `kb/patterns.md`, ...).

- **Secrets stay out.** `config.toml` and `cache/` remain in `~/.config/gilfoyle/` (or wherever `GILFOYLE_CONFIG_DIR` points). Do not point `GILFOYLE_CONFIG_DIR` at the project to get this tier. The tier is committed; never write credentials into it.
- **Sync is plain git.** `mem-sync` and `mem-share` handle org repos only. Pull the project tier the way you pull the project.
- **Sleep skips it.** `scripts/sleep` never rewrites the project tier: compaction of committed files makes noisy diffs. Dedupe by hand, in a normal change.
- **Health.** `scripts/init` and `scripts/mem-doctor` report it when it exists. `mem-doctor` warns if `GILFOYLE_PROJECT_MEMORY_DIR` points at a directory without `kb/`.

## Directory Structure

```
~/.config/gilfoyle/memory/
    ├── kb/
    │   ├── facts.md
    │   ├── patterns.md
    │   └── queries.md
    ├── journal/
    └── orgs/
        └── axiom/            # Org tier (git-tracked)
            └── kb/

<git-toplevel>/.gilfoyle/memory/   # Project tier (committed with the project)
    └── kb/
        ├── facts.md
        └── patterns.md
```

## Entry Format

```markdown
## M-2025-01-05T14:32:10Z connection-pool-exhaustion

- type: pattern
- tags: database, postgres
- used: 5
- last_used: 2025-01-12
- pinned: false
- schema_version: 1

**Summary**
Connection pool exhausted due to leaked connections.
```

## Learning

**You are always learning.** Every debugging session is an opportunity to get smarter.

**Automatic learning (no user prompt needed):**
- Query found root cause → record to `kb/queries.md`
- New failure pattern discovered → record to `kb/patterns.md`
- User corrects you → record what didn't work AND what did
- Debugging session succeeds → summarize learnings to `kb/incidents.md`

**User-triggered recording:**
- "Remember this", "save this" → record immediately to Personal
- "Save for this project" → record to Project (file only; the user commits it)
- "Save for the team" → record to Org + prompt to push

**Be proactive:** If something is worth remembering, record it.

## During Investigations

**Capture:** Append observations to `journal/journal-YYYY-MM.md`:

```markdown
## M-2025-01-05T14:32:10Z found-connection-leak

- type: note
- tags: orders, database
- schema_version: 1

Connection pool exhausted. Found leak in payment handler.
```

**End of session:** Create summary in `kb/incidents.md` with key learnings.

## Consolidation (Sleep)

Run after incidents or periodically:
```bash
scripts/sleep                           # default full preset: clean + share + prompt
scripts/sleep --org axiom               # same full preset, scoped to one org
scripts/sleep --org axiom --dry-run     # analyze + prompt only
```

Deep sleep phases:
- `N1 review` recent entries in the selected window.
- `N2 analysis` entry counts, duplicate keys, and type drift.
- `N3 apply` deterministic cleanup (keep newest duplicate, drop `Supersedes` targets, normalize `type` in incidents/patterns/queries).
- `REM share` commit/push org repo changes.

Safety defaults:
- no mode flags => full preset.
- `--dry-run` never modifies files and never pushes.
- the project tier is never a target. `--project` is rejected.

## Health Check

```bash
scripts/mem-doctor    # Check all tiers (personal, org, project if present), report issues
```

See `README.memory.md` in any memory directory for full entry format and maintenance instructions.
