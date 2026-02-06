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

## P1: Eval Framework Bugs

Code review findings from the `.meta/` eval framework. Ordered by severity.

### Critical

- [ ] **Fixture engine: PromQL label operators ignored** — `!=`, `=~`, `!~` all treated as `=`. Queries like `rate{status!="200"}` return wrong results. Store operator in `validatePromQL` labels, switch on it in `executePromQL`. (`toolbox/fixture-engine.ts:418-426`)
- [ ] **AMP harness: never sets `queryValid`/`queryErrors`** — QueryValidityScorer treats `undefined !== false` as valid, so all AMP query errors score as valid. Parse tool_result content for `error:` prefix like opencode.ts does. (`harness/amp.ts:78`)

### High

- [ ] **APL where clause: `\w+` blocks dotted fields** — `http.status`, `k8s.pod.name` fail to parse. Agent writes correct APL, gets 0 rows, gets penalized. Change `(\w+)` to `([\w.]+)`. (`toolbox/fixture-engine.ts:113`)
- [ ] **APL parser: unrecognized stages scored as valid** — `{type:'raw'}` stages pass validation. `distinct`, `project-away`, `join`, `where a and b` all silently become no-ops with `valid: true`. Treat raw stages as validation errors. (`toolbox/fixture-engine.ts:107-163`)
- [ ] **RCA scorer: division by zero** — Fallback path divides by `mustMention.length`. Empty array → `0/0 = NaN` → poisons aggregates. Guard with `if (mustMention.length === 0) return { score: 1 }`. (`scorers/rca.ts:57`)
- [ ] **RCA scorer: LLM judge response not validated** — `judgment.score` could be missing, string, or out of range. `undefined / 100 = NaN`. Validate shape, clamp to 0-100. (`scorers/rca.ts:49`)
- [ ] **OpenCode harness: tmpDir leaks if `createOpencode` throws** — Called before try/finally. Move inside try block. (`harness/opencode.ts:86-96`)

### Medium

- [ ] **LLM JSON extraction: greedy regex** — `\{[\s\S]*\}` matches first `{` to last `}` across markdown fences, prose, multiple objects. Strip fences first, try direct parse, then bracket-balanced scan. (`synthesizer/synthesize.ts:111-114`)
- [ ] **APL where with `and`/`or`: silent 0 rows** — Falls to expr mode, does full-row string search for literal expression text, almost always returns empty. Split on top-level `and` into multiple where stages, or reject with clear error. (`toolbox/fixture-engine.ts:113-117`)
- [ ] **`extractRootCause`: fragile regex** — Expects `"root cause:"` or `"problem:"` in output. Different phrasing → returns last paragraph which may be irrelevant. Consider LLM-based extraction or passing full text to scorer. (`gilfoyle.eval.ts:15-22`)
- [ ] **TOCTOU race in `getFreePort`** — Port released before `createOpencode` binds it. Use port 0 directly if SDK supports, or add retry loop. (`harness/opencode.ts:25-39`)
- [ ] **OpenCode harness: LLM must prepend `GILFOYLE_SCENARIO_FILE=...`** — Wastes tokens, measures prompt compliance not SRE skill. Inject env var into mock scripts directly. (`harness/opencode.ts:104-115`)
- [ ] **No internal timeout on `session.prompt`/`session.messages`** — Hung SDK call relies on eval runner's 5min timeout which may not trigger finally. Add `Promise.race` with ~280s internal timeout. (`harness/opencode.ts:117-131`)

### Low

- [ ] **Efficiency scorer: budget 0 → division by zero** — `(actual - budget) / budget` with `maxToolCalls: 0`. Use `Math.max(1, ...)`. (`scorers/efficiency.ts:24`)
- [ ] **QueryValidityScorer: `new RegExp(req.mustMatch)` can throw** — Invalid regex in scenario config fails entire scorer. Wrap in try/catch. (`scorers/query-validity.ts:48`)

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
