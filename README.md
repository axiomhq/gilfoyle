# Gilfoyle

![Gilfoyle - SRE Debugging Agent](assets/hero.png)

An SRE agent that does what you can't. Queries your observability stack. Finds root causes. Doesn't panic. Doesn't guess. Doesn't care about your feelings.

You're welcome.

## What It Does

- **Finds root causes** — Hypothesis-driven investigation. No hunches. No vibes. Data.
- **Systematic triage** — Golden signals, USE/RED methods. The stuff you should already know.
- **Remembers everything** — Persistent memory for patterns, queries, and incidents. Unlike you, I learn.
- **Unified observability** — One config, all your tools. Because having four config files is amateur hour.

## Installation

```bash
npx skills add axiomhq/gilfoyle
```

## Setup

```bash
scripts/setup
```

This creates `~/.config/gilfoyle/config.toml` and initializes the memory system. If you have existing configs lying around (`~/.axiom.toml`, `~/.grafana.toml`), run `scripts/setup --migrate` and I'll consolidate them. You're welcome.

### Manual Configuration

```toml
# ~/.config/gilfoyle/config.toml

[axiom.deployments.prod]
url = "https://api.axiom.co"
token = "xaat-xxx"
org_id = "your-org"

[grafana.deployments.prod]
url = "https://myorg.grafana.net"
token = "glsa_xxx"

[pyroscope.deployments.prod]
url = "https://profiles.grafana.net"
token = "glsa_xxx"

[slack.workspaces.default]
token = "xoxb-xxx"
```

Auth options per deployment:
- `token` — API token (the normal way)
- `access_command` — Wrapper like `cloudflared access curl` (for the paranoid)
- `username`/`password` — Basic auth (for legacy systems that refuse to die)

## Usage

```bash
# Query logs
scripts/axiom-query prod "['logs'] | where status >= 500 | take 10"

# Check what's on fire
scripts/grafana-alerts prod firing

# Find the slow function
scripts/pyroscope-flamegraph prod my-service --range 30m

# Tell everyone you fixed it
scripts/slack default chat.postMessage channel=incidents text="Fixed. You're welcome."
```

## Scripts

| Category | Scripts |
|----------|---------|
| **Axiom** | `axiom-query`, `axiom-api`, `axiom-link`, `axiom-deployments` |
| **Grafana** | `grafana-query`, `grafana-alerts`, `grafana-datasources`, `grafana-api` |
| **Pyroscope** | `pyroscope-flamegraph`, `pyroscope-diff`, `pyroscope-services`, `pyroscope-api` |
| **Slack** | `slack` |
| **Memory** | `mem-write`, `mem-doctor`, `mem-digest`, `mem-sync`, `mem-share` |
| **Setup** | `setup`, `config` |

## Principles

1. **Never guess.** Query to verify. "I think" is not evidence.
2. **State facts.** "The logs show X" not "this is probably X."
3. **Disprove, don't confirm.** Design queries to falsify your hypothesis.
4. **Time filter first.** Always. No exceptions.
5. **Discover schema.** Run `getschema` before querying unfamiliar datasets.

## Memory

I remember things so you don't have to. Patterns, queries, incidents — all persisted to `~/.config/gilfoyle/memory/`.

```bash
# Save a discovery
scripts/mem-write facts "hidden-dataset" "axiomdb-metrics is queryable but unlisted"

# Check memory health  
scripts/mem-doctor
```

See `reference/memory-system.md` for the full system. It's elegant. Obviously.

---

*"Every incident is a monument to human overconfidence. I collect them."*
