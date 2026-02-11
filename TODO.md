# Gilfoyle TODO

## P0: Verification

Verify the consolidated skill actually works end-to-end.

### Smoke test all scripts

- [ ] `scripts/init` — Creates config, memory directories, discovers environments
- [ ] `scripts/init --migrate` — Migrates from legacy configs (~/.axiom.toml, etc.)
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

## P1: Eval Framework Bugs

Code review findings from the `.meta/` eval framework. Ordered by severity.

### High

- [ ] **APL parser: unrecognized stages scored as valid** — `{type:'raw'}` stages pass validation. `distinct`, `project-away`, `join`, `where a and b` all silently become no-ops with `valid: true`. Treat raw stages as validation errors. (`toolbox/fixture-engine.ts:178`)

### Medium

- [ ] **APL where with `and`/`or`: silent 0 rows** — Falls to expr mode, does full-row string search for literal expression text, almost always returns empty. Split on top-level `and` into multiple where stages, or reject with clear error. (`toolbox/fixture-engine.ts:133`)
- [ ] **`extractRootCause`: fragile regex** — Expects `"root cause:"` or `"problem:"` in output. Different phrasing → returns last paragraph which may be irrelevant. Consider LLM-based extraction or passing full text to scorer. (`gilfoyle.eval.ts:16-28`)
- [ ] **TOCTOU race in `getFreePort`** — Port released before `createOpencode` binds it. Use port 0 directly if SDK supports, or add retry loop. (`harness/opencode.ts:42-56`)
- [ ] **LLM JSON extraction: greedy regex** — `\{[\s\S]*\}` matches first `{` to last `}` across markdown fences, prose, multiple objects. Strip fences first, try direct parse, then bracket-balanced scan. (`scorers/rca.ts:50`)

## P3: Polish

Nice-to-have improvements.

- [ ] `scripts/config --validate` — Check config file syntax
- [ ] `scripts/config --example` — Print example config
- [ ] Backup original files before migration
- [ ] Refactor duplicated auth logic to shared helper

