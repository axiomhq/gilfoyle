# Gilfoyle TODO

## P0: Verification

Verify the consolidated skill actually works end-to-end.

### Smoke test all scripts

- [ ] `scripts/setup` — Creates config and memory directories
- [ ] `scripts/setup --migrate` — Migrates from legacy configs (~/.axiom.toml, etc.)
- [ ] `scripts/config axiom <deployment>` — Returns correct env vars
- [ ] `scripts/axiom-query` — Runs APL query successfully
- [ ] `scripts/axiom-api` — Makes API call successfully
- [ ] `scripts/axiom-link` — Generates valid shareable URL
- [ ] `scripts/axiom-deployments` — Lists deployments without exposing secrets
- [ ] `scripts/grafana-query` — Runs PromQL query successfully
- [ ] `scripts/grafana-alerts` — Lists firing alerts
- [ ] `scripts/pyroscope-flamegraph` — Gets flame graph data
- [ ] `scripts/slack` — Posts message successfully
- [ ] `scripts/mem-write` — Writes entry to kb/
- [ ] `scripts/mem-doctor` — Reports correct status

### Error handling

- [ ] Helpful error when config file missing
- [ ] Helpful error when deployment not found
- [ ] Helpful error when auth fails (token expired, wrong creds)

## P1: Evals

Create eval framework to validate skill behavior.

### Setup

- [ ] Create `.meta/gilfoyle.eval.ts` using eval-tooling harness
- [ ] Define eval cases structure

### Query Generation Evals

Test that given a scenario, the skill produces valid APL:

- [ ] Time range queries (always filter _time first)
- [ ] Error analysis (status >= 500, summarize by service)
- [ ] Latency percentiles (percentiles_array)
- [ ] Spotlight queries (correct is_comparison param)
- [ ] Field escaping (kubernetes labels with dots)

### Investigation Methodology Evals

Test that the skill follows correct process:

- [ ] Reads memory before investigating
- [ ] States hypotheses before querying
- [ ] Discovers schema before querying unfamiliar datasets
- [ ] Doesn't guess — queries to verify
- [ ] Generates Axiom links for findings

### Tool Selection Evals

Test that given a problem, it picks the right tool:

- [ ] Log analysis → Axiom
- [ ] Infrastructure metrics → Grafana
- [ ] CPU/memory profiling → Pyroscope
- [ ] Alert status → Grafana alerts

## P2: Content

Seed memory templates with actually useful content.

- [ ] `templates/kb/patterns.md` — Common failure patterns (connection pool, OOM, cascading failure)
- [ ] `templates/kb/queries.md` — Useful APL query templates
- [ ] `templates/kb/facts.md` — Example organizational facts

## P3: Polish

Nice-to-have improvements.

- [ ] `scripts/config --validate` — Check config file syntax
- [ ] `scripts/config --example` — Print example config
- [ ] Backup original files before migration
- [ ] Refactor duplicated auth logic to shared helper

---

## Completed

- [x] Unified config at `~/.config/gilfoyle/config.toml`
- [x] All scripts updated to use unified config
- [x] All memory scripts use `~/.config/gilfoyle/memory/`
- [x] README.md rebranded to Gilfoyle
- [x] All reference docs updated with new paths
- [x] SKILL.md under 500 lines (491)
- [x] Gilfoyle persona integrated
