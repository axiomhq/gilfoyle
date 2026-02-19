# Gilfoyle

[![Evals](https://img.shields.io/badge/evals-live_dashboard-blue)](https://play.axiom.co/axiom-play-qf1k/dashboards/2NztOZ2QWMNZtU83pv)

![Gilfoyle - SRE Debugging Agent](site/assets/hero.png)

An SRE agent that does what you can't. Queries your observability stack. Finds root causes. Doesn't panic. Doesn't guess. Doesn't care about your feelings.

You're welcome.

## What It Does

- **Finds root causes** — Hypothesis-driven investigation. No hunches. No vibes. Data.
- **Systematic triage** — Golden signals, USE/RED methods. The stuff you should already know.
- **Remembers everything** — Persistent memory for patterns, queries, and incidents. Unlike you, I learn.
- **Metrics querying** — OTel metrics via MPL. Logs via APL. One agent, both engines.
- **Unified observability** — One config, all your tools. Because having four config files is amateur hour.

## Installation

```bash
npx skills add axiomhq/gilfoyle/skill
```

### Requirements

Gilfoyle uses `timeout` (GNU coreutils). On macOS install it with:

```bash
brew install coreutils
```

## Setup

```bash
scripts/init
```

First run creates `~/.config/gilfoyle/config.toml`, initializes the memory system, and tells you what to configure. If you have existing configs lying around (`~/.axiom.toml`, `~/.grafana.toml`), run `scripts/init --migrate` and I'll consolidate them. You're welcome.

### Configuration

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
# Query logs (APL)
scripts/axiom-query prod "['dataset'] | where _time > ago(1h) | where status >= 500 | project _time, message, status | take 10"

# Query metrics (MPL)
scripts/axiom-metrics-query prod --range 1h <<< "otel-metrics:http.server.request.duration | align to 5m using avg | group by service.name"

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
| **Axiom** | `axiom-query`, `axiom-metrics-query`, `axiom-api`, `axiom-link`, `axiom-deployments` |
| **Grafana** | `grafana-query`, `grafana-alerts`, `grafana-datasources`, `grafana-api` |
| **Pyroscope** | `pyroscope-flamegraph`, `pyroscope-diff`, `pyroscope-services`, `pyroscope-api` |
| **Slack** | `slack` |
| **Memory** | `mem-write`, `mem-doctor`, `mem-sync` |
| **Setup** | `init`, `config` |
| **Tests** | `test-curl-auth`, `test-config-toml` |

## Testing

```bash
scripts/test-curl-auth      # Auth integration and secret handling
scripts/test-config-toml    # TOML parsing with indented sections
```

## Principles

1. **Never guess.** Query to verify. "I think" is not evidence.
2. **State facts.** "The logs show X" not "this is probably X."
3. **Disprove, don't confirm.** Design queries to falsify your hypothesis.
4. **Time filter first.** Always. No exceptions.
5. **Discover schema.** Run `getschema` (APL) or `--spec` (MPL) before querying unfamiliar datasets.

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
