import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Row = Record<string, unknown>;

type AxiomField = { name: string };
type AxiomTable = { fields: AxiomField[]; columns: unknown[][] };
type AxiomResponse = { tables?: AxiomTable[] };

type ScenarioSummary = {
  id: string;
  name: string;
  index: number;
  scores: Record<string, number>;
  rawScores: Record<string, unknown>;
  elapsedMs?: number;
};

type LatestRun = {
  evalName: string;
  version: string;
  time: string;
  ts: number;
};

type RuntimeSummary = {
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  n: number;
};

type CaseCoverage = {
  countByRun: Map<string, number>;
  maxByEval: Map<string, number>;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const metaRoot = resolve(__dirname, '..');
const repoRoot = resolve(metaRoot, '..');
const deploy = process.env.EVAL_DEPLOYMENT ?? 'play';
const dataset =
  process.env.EVAL_DATASET_NAME ?? process.env.AXIOM_DATASET ?? 'gilfoyle-evals';
const targetEvalName = process.env.EVAL_TARGET_EVAL;
const minCaseCoverageRatio = clamp01(
  Number.parseFloat(process.env.EVAL_MIN_CASE_COVERAGE_RATIO ?? '0.8'),
);
const outputDir = resolve(
  process.env.EVAL_DIAGNOSTICS_OUTDIR ?? join(metaRoot, 'reports'),
);

main();

function main() {
  mkdirSync(outputDir, { recursive: true });

  const scoreRows = runAplRows(
    `['${dataset}'] | where name startswith 'score ' | sort by _time desc | limit 50000 | project _time, ['attributes.eval.name'], ['attributes.eval.version'], ['attributes.eval.score.name'], ['attributes.eval.score.value']`,
  );
  const caseCoverage = loadCaseCoverage();

  const latestByEval = latestScoredRunByEval(scoreRows, caseCoverage);
  const latestCaseRows = loadLatestCaseRows(latestByEval);
  const runtimeByConfig = buildRuntimeByConfig(latestCaseRows, latestByEval);
  const configReport = buildConfigReport(scoreRows, latestByEval, runtimeByConfig);
  const configReportPath = join(outputDir, 'eval-config-report.md');
  writeFileSync(configReportPath, configReport, 'utf8');

  const targetRuns = selectTargetRuns(latestByEval);
  if (targetRuns.length === 0) {
    console.error('[eval-diagnostics] No scored runs found.');
    console.error(`[eval-diagnostics] Wrote ${configReportPath}`);
    return;
  }

  const caseRows = loadCaseRowsForRuns(targetRuns);
  const writtenReports: string[] = [];

  for (const run of targetRuns) {
    const runRows = caseRows.filter((row) => matchesRun(row, run));
    const cases = parseCaseRows(runRows).sort((a, b) => a.index - b.index);
    const evalSlug = slugify(run.evalName);

    const caseReport = buildCaseReport(run.evalName, run.version, cases);
    const caseReportPath = join(
      outputDir,
      `${run.version}-${evalSlug}-case-diagnostics.md`,
    );
    writeFileSync(caseReportPath, caseReport, 'utf8');
    writtenReports.push(caseReportPath);

    const failureReport = buildFailureSignatureReport(
      run.evalName,
      run.version,
      cases,
    );
    const failureReportPath = join(
      outputDir,
      `${run.version}-${evalSlug}-query-failure-signatures.md`,
    );
    writeFileSync(failureReportPath, failureReport, 'utf8');
    writtenReports.push(failureReportPath);
  }

  console.error(`[eval-diagnostics] deployment=${deploy} dataset=${dataset}`);
  console.error(`[eval-diagnostics] latest scored configs=${latestByEval.size}`);
  console.error(`[eval-diagnostics] target runs=${targetRuns.length}`);
  console.error(`[eval-diagnostics] wrote ${configReportPath}`);
  for (const path of writtenReports) {
    console.error(`[eval-diagnostics] wrote ${path}`);
  }
}

function runAplRows(apl: string): Row[] {
  const query = JSON.stringify(apl);
  const cmd = `echo ${query} | ${join(repoRoot, 'scripts/axiom-query')} ${deploy} --raw`;
  const raw = execSync(cmd, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 512,
  });
  return toRows(JSON.parse(raw) as AxiomResponse);
}

function toRows(response: AxiomResponse): Row[] {
  const table = response.tables?.[0];
  if (!table) return [];
  const fields = table.fields.map((f) => f.name);
  const rowCount = table.columns[0]?.length ?? 0;
  const out: Row[] = [];
  for (let i = 0; i < rowCount; i++) {
    const row: Row = {};
    for (let j = 0; j < fields.length; j++) {
      row[fields[j]] = table.columns[j]?.[i];
    }
    out.push(row);
  }
  return out;
}

function latestScoredRunByEval(
  rows: Row[],
  coverage: CaseCoverage,
): Map<string, LatestRun> {
  const eligible = new Map<string, LatestRun>();
  const fallback = new Map<string, LatestRun>();

  for (const row of rows) {
    const evalName = asString(row['attributes.eval.name']);
    const version = asString(row['attributes.eval.version']);
    const time = asString(row._time);
    const ts = time ? Date.parse(time) : Number.NaN;
    if (!evalName || !version || !time || !Number.isFinite(ts)) continue;

    const prevFallback = fallback.get(evalName);
    if (!prevFallback || ts > prevFallback.ts) {
      fallback.set(evalName, { evalName, version, time, ts });
    }

    const runKey = keyEvalVersion(evalName, version);
    const count = coverage.countByRun.get(runKey) ?? 0;
    const maxForEval = coverage.maxByEval.get(evalName) ?? count;
    const ratio = maxForEval > 0 ? count / maxForEval : 1;
    if (ratio < minCaseCoverageRatio) continue;

    const prev = eligible.get(evalName);
    if (!prev || ts > prev.ts) {
      eligible.set(evalName, { evalName, version, time, ts });
    }
  }

  for (const [evalName, run] of fallback) {
    if (!eligible.has(evalName)) {
      eligible.set(evalName, run);
      console.error(
        `[eval-diagnostics] coverage fallback for ${evalName}: ${run.version}`,
      );
    }
  }

  return eligible;
}

function loadCaseCoverage(): CaseCoverage {
  const rows = runAplRows(
    `['${dataset}'] | where name startswith 'case ' | summarize caseCount=count() by ['attributes.eval.name'], ['attributes.eval.version'] | limit 50000`,
  );
  const countByRun = new Map<string, number>();
  const maxByEval = new Map<string, number>();

  for (const row of rows) {
    const evalName = asString(row['attributes.eval.name']);
    const version = asString(row['attributes.eval.version']);
    const count = asNumber(row.caseCount);
    if (!evalName || !version || count == null) continue;
    countByRun.set(keyEvalVersion(evalName, version), count);
    const prev = maxByEval.get(evalName) ?? 0;
    if (count > prev) maxByEval.set(evalName, count);
  }

  return { countByRun, maxByEval };
}

function loadLatestCaseRows(latestByEval: Map<string, LatestRun>): Row[] {
  const versions = [...new Set([...latestByEval.values()].map((v) => v.version))].filter(
    (v) => v.length > 0,
  );
  if (versions.length === 0) return [];

  const clause = versions
    .map((version) => `['attributes.eval.version'] == '${version}'`)
    .join(' or ');

  return runAplRows(
    `['${dataset}'] | where name startswith 'case ' and (${clause}) | sort by _time desc | limit 5000 | project _time, ['attributes.eval.name'], ['attributes.eval.version'], ['attributes.eval.case.output']`,
  );
}

function loadCaseRowsForRuns(runs: LatestRun[]): Row[] {
  if (runs.length === 0) return [];
  const clause = runs
    .map(
      (run) =>
        `(['attributes.eval.name'] == '${escapeAplString(
          run.evalName,
        )}' and ['attributes.eval.version'] == '${escapeAplString(run.version)}')`,
    )
    .join(' or ');

  return runAplRows(
    `['${dataset}'] | where name startswith 'case ' and (${clause}) | sort by _time desc | limit 20000 | project _time, ['attributes.eval.name'], ['attributes.eval.version'], ['attributes.eval.case.index'], ['attributes.eval.case.input'], ['attributes.eval.case.scores'], ['attributes.eval.case.output']`,
  );
}

function buildRuntimeByConfig(
  rows: Row[],
  latestByEval: Map<string, LatestRun>,
): Map<string, RuntimeSummary> {
  const byConfig: Record<string, number[]> = {};

  for (const row of rows) {
    const evalName = asString(row['attributes.eval.name']);
    const version = asString(row['attributes.eval.version']);
    if (!evalName || !version) continue;

    const latest = latestByEval.get(evalName);
    if (!latest || latest.version !== version) continue;

    const elapsed = extractElapsedMs(asString(row['attributes.eval.case.output']));
    if (elapsed == null) continue;
    byConfig[evalName] ??= [];
    byConfig[evalName].push(elapsed);
  }

  const out = new Map<string, RuntimeSummary>();
  for (const [evalName, values] of Object.entries(byConfig)) {
    const summary = summarizeRuntimes(values);
    if (summary) out.set(evalName, summary);
  }
  return out;
}

function buildConfigReport(
  rows: Row[],
  latestByEval: Map<string, LatestRun>,
  runtimeByConfig: Map<string, RuntimeSummary>,
): string {
  const byConfig: Record<
    string,
    { version: string; time: string; scorers: Record<string, number[]> }
  > = {};

  for (const row of rows) {
    const evalName = asString(row['attributes.eval.name']);
    const version = asString(row['attributes.eval.version']);
    const scorer = asString(row['attributes.eval.score.name']);
    const score = asNumber(row['attributes.eval.score.value']);
    if (!evalName || !version || !scorer || score == null) continue;
    const latest = latestByEval.get(evalName);
    if (!latest || latest.version !== version) continue;

    byConfig[evalName] ??= { version, time: latest.time, scorers: {} };
    byConfig[evalName].scorers[scorer] ??= [];
    byConfig[evalName].scorers[scorer].push(score);
  }

  const scorerStats: Record<string, number[]> = {};
  for (const cfg of Object.values(byConfig)) {
    for (const [scorer, vals] of Object.entries(cfg.scorers)) {
      const mean = avg(vals);
      scorerStats[scorer] ??= [];
      scorerStats[scorer].push(mean);
    }
  }

  const ranking = Object.entries(scorerStats)
    .map(([scorer, vals]) => ({
      scorer,
      mean: avg(vals),
      min: Math.min(...vals),
      max: Math.max(...vals),
      spread: Math.max(...vals) - Math.min(...vals),
      count: vals.length,
    }))
    .sort((a, b) => a.mean - b.mean);

  let md = '# Eval Config Snapshot (latest scored run per config)\n\n';
  for (const [evalName, cfg] of Object.entries(byConfig).sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    md += `## ${evalName}\n`;
    md += `- version: ${cfg.version}\n`;
    md += `- time: ${cfg.time}\n`;
    const runtime = runtimeByConfig.get(evalName);
    if (runtime) {
      md += `- runtime: mean ${fmtSeconds(runtime.meanMs)} | p50 ${fmtSeconds(runtime.p50Ms)} | p95 ${fmtSeconds(runtime.p95Ms)} (n=${runtime.n})\n`;
    }
    md += '\n';
    md += '| scorer | mean | n |\n';
    md += '|---|---:|---:|\n';
    for (const [scorer, mean, count] of Object.entries(cfg.scorers)
      .map(([scorer, vals]) => [scorer, avg(vals), vals.length] as const)
      .sort((a, b) => a[0].localeCompare(b[0]))) {
      md += `| ${scorer} | ${pct(mean)} | ${count} |\n`;
    }
    md += '\n';
  }

  md += '## Scorer Cross-Config Ranking\n\n';
  md += '| scorer | mean across configs | min | max | spread | configs |\n';
  md += '|---|---:|---:|---:|---:|---:|\n';
  for (const stat of ranking) {
    md += `| ${stat.scorer} | ${pct(stat.mean)} | ${pct(stat.min)} | ${pct(stat.max)} | ${pct(stat.spread)} | ${stat.count} |\n`;
  }

  const runtimeRanking = [...runtimeByConfig.entries()]
    .map(([config, runtime]) => ({ config, ...runtime }))
    .sort((a, b) => a.meanMs - b.meanMs);

  if (runtimeRanking.length > 0) {
    md += '\n## Runtime Cross-Config Ranking\n\n';
    md += '| config | mean | p50 | p95 | min | max | n |\n';
    md += '|---|---:|---:|---:|---:|---:|---:|\n';
    for (const row of runtimeRanking) {
      md += `| ${row.config} | ${fmtSeconds(row.meanMs)} | ${fmtSeconds(row.p50Ms)} | ${fmtSeconds(row.p95Ms)} | ${fmtSeconds(row.minMs)} | ${fmtSeconds(row.maxMs)} | ${row.n} |\n`;
    }
  }
  return md;
}

function selectTargetRuns(latestByEval: Map<string, LatestRun>): LatestRun[] {
  const explicit = process.env.EVAL_VERSION;
  if (explicit) {
    const matched = [...latestByEval.values()].filter(
      (run) => run.version === explicit,
    );
    if (matched.length === 0) {
      console.error(
        `[eval-diagnostics] EVAL_VERSION not found in latest runs: ${explicit}`,
      );
    }
    return matched.sort((a, b) => a.evalName.localeCompare(b.evalName));
  }

  if (targetEvalName) {
    const targeted = latestByEval.get(targetEvalName);
    if (targeted) return [targeted];
    console.error(
      `[eval-diagnostics] EVAL_TARGET_EVAL not found: ${targetEvalName}; falling back to all latest scored runs`,
    );
  }

  return [...latestByEval.values()].sort((a, b) =>
    a.evalName.localeCompare(b.evalName),
  );
}

function parseCaseRows(rows: Row[]): ScenarioSummary[] {
  const out: ScenarioSummary[] = [];

  for (const row of rows) {
    const idx = asNumber(row['attributes.eval.case.index']);
    const inputRaw = asString(row['attributes.eval.case.input']);
    const scoreMap = asRecord(row['attributes.eval.case.scores']);
    const outputRaw = asString(row['attributes.eval.case.output']);
    if (idx == null || !inputRaw || !scoreMap) continue;

    let scenarioId = `case-${idx}`;
    let scenarioName = scenarioId;
    try {
      const parsed = JSON.parse(inputRaw) as {
        scenario?: { id?: string; name?: string };
      };
      scenarioId = parsed.scenario?.id ?? scenarioId;
      scenarioName = parsed.scenario?.name ?? scenarioId;
    } catch {
      // keep fallback names
    }

    const scores: Record<string, number> = {};
    for (const [scorer, raw] of Object.entries(scoreMap)) {
      const entry = asRecord(raw);
      const value = entry ? asNumber(entry.score) : undefined;
      if (value != null) scores[scorer] = value;
    }

    out.push({
      id: scenarioId,
      name: scenarioName,
      index: idx,
      scores,
      rawScores: scoreMap,
      elapsedMs: extractElapsedMs(outputRaw),
    });
  }

  return out;
}

function buildCaseReport(
  evalName: string,
  version: string,
  cases: ScenarioSummary[],
): string {
  const scorerNames = [...new Set(cases.flatMap((c) => Object.keys(c.scores)))].sort();
  const runtime = summarizeRuntimes(cases.map((c) => c.elapsedMs).filter(isNumber));

  const means: Record<string, number> = {};
  for (const scorer of scorerNames) {
    means[scorer] = avg(cases.map((c) => c.scores[scorer]).filter(isNumber));
  }

  const failureClassCounts: Record<string, number> = {};
  const yieldClassCounts: Record<string, number> = {};

  for (const scenario of cases) {
    const qv = asRecord(scenario.rawScores['query-validity']);
    const qvMeta = qv ? asRecord(qv.metadata) : undefined;
    const fcc = qvMeta ? asRecord(qvMeta.failureClassCounts) : undefined;
    if (fcc) {
      for (const [klass, value] of Object.entries(fcc)) {
        failureClassCounts[klass] =
          (failureClassCounts[klass] ?? 0) + (asNumber(value) ?? 0);
      }
    }

    const qy = asRecord(scenario.rawScores['query-yield']);
    const qyMeta = qy ? asRecord(qy.metadata) : undefined;
    const ycc = qyMeta ? asRecord(qyMeta.classCounts) : undefined;
    if (ycc) {
      for (const [klass, value] of Object.entries(ycc)) {
        yieldClassCounts[klass] =
          (yieldClassCounts[klass] ?? 0) + (asNumber(value) ?? 0);
      }
    }
  }

  const worst = [...cases]
    .map((c) => ({
      id: c.id,
      qv: c.scores['query-validity'] ?? 0,
      qy: c.scores['query-yield'] ?? 0,
      cg: c.scores['causal-grounding'] ?? 0,
      hd: c.scores['hypothesis-discipline'] ?? 0,
      rca: c.scores['rca-accuracy'] ?? 0,
      eff: c.scores.efficiency ?? 0,
    }))
    .sort(
      (a, b) => a.qv + a.qy + a.cg + a.hd - (b.qv + b.qy + b.cg + b.hd),
    );

  let md = `# ${version} Case Diagnostics\n\n`;
  md += `eval: ${evalName}\n\n`;
  md += `cases: ${cases.length}\n\n`;
  if (runtime) {
    md += '## Runtime Summary\n\n';
    md += '| mean | p50 | p95 | min | max | n |\n';
    md += '|---:|---:|---:|---:|---:|---:|\n';
    md += `| ${fmtSeconds(runtime.meanMs)} | ${fmtSeconds(runtime.p50Ms)} | ${fmtSeconds(runtime.p95Ms)} | ${fmtSeconds(runtime.minMs)} | ${fmtSeconds(runtime.maxMs)} | ${runtime.n} |\n\n`;
  }

  md += '## Mean Scores\n\n';
  md += '| scorer | mean |\n';
  md += '|---|---:|\n';
  for (const scorer of scorerNames) {
    md += `| ${scorer} | ${pct(means[scorer])} |\n`;
  }

  md += '\n## Query Failure Classes (total invalid query calls)\n\n';
  md += '| class | count |\n';
  md += '|---|---:|\n';
  for (const [klass, count] of Object.entries(failureClassCounts).sort(
    (a, b) => b[1] - a[1],
  )) {
    md += `| ${klass} | ${count} |\n`;
  }

  md += '\n## Query Yield Classes (all query calls)\n\n';
  md += '| class | count |\n';
  md += '|---|---:|\n';
  for (const [klass, count] of Object.entries(yieldClassCounts).sort(
    (a, b) => b[1] - a[1],
  )) {
    md += `| ${klass} | ${count} |\n`;
  }

  md += '\n## Worst Cases (by qv+qy+cg+hd)\n\n';
  md += '| scenario | qv | qy | cg | hd | rca | eff |\n';
  md += '|---|---:|---:|---:|---:|---:|---:|\n';
  for (const row of worst.slice(0, 8)) {
    md += `| ${row.id} | ${pct(row.qv)} | ${pct(row.qy)} | ${pct(row.cg)} | ${pct(row.hd)} | ${pct(row.rca)} | ${pct(row.eff)} |\n`;
  }

  const slowest = [...cases]
    .filter((c) => isNumber(c.elapsedMs))
    .sort((a, b) => (b.elapsedMs ?? 0) - (a.elapsedMs ?? 0))
    .slice(0, 8);
  if (slowest.length > 0) {
    md += '\n## Slowest Cases (wall clock)\n\n';
    md += '| scenario | elapsed |\n';
    md += '|---|---:|\n';
    for (const row of slowest) {
      md += `| ${row.id} | ${fmtSeconds(row.elapsedMs ?? 0)} |\n`;
    }
  }
  return md;
}

function buildFailureSignatureReport(
  evalName: string,
  version: string,
  scenarios: ScenarioSummary[],
): string {
  const byClass: Record<string, number> = {};
  const byTool: Record<string, number> = {};
  const signatures: Record<string, number> = {};

  for (const scenario of scenarios) {
    const qv = asRecord(scenario.rawScores['query-validity']);
    const qvMeta = qv ? asRecord(qv.metadata) : undefined;
    const invalidDetails = asArray(qvMeta?.invalidDetails);
    for (const detailRaw of invalidDetails) {
      const detail = asRecord(detailRaw);
      if (!detail) continue;

      const klass = asString(detail.class) ?? 'unknown';
      const tool = asString(detail.tool) ?? 'unknown';
      byClass[klass] = (byClass[klass] ?? 0) + 1;
      byTool[tool] = (byTool[tool] ?? 0) + 1;

      const message = pickFailureMessage(detail);
      const normalized = normalizeSignature(message);
      const key = `${klass} | ${tool} | ${normalized}`;
      signatures[key] = (signatures[key] ?? 0) + 1;
    }
  }

  const top = Object.entries(signatures)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  let md = `# ${version} Query Failure Signatures\n\n`;
  md += `eval: ${evalName}\n\n`;

  md += '## By Class\n\n';
  md += '| class | count |\n';
  md += '|---|---:|\n';
  for (const [klass, count] of Object.entries(byClass).sort(
    (a, b) => b[1] - a[1],
  )) {
    md += `| ${klass} | ${count} |\n`;
  }

  md += '\n## By Tool\n\n';
  md += '| tool | count |\n';
  md += '|---|---:|\n';
  for (const [tool, count] of Object.entries(byTool).sort((a, b) => b[1] - a[1])) {
    md += `| ${tool} | ${count} |\n`;
  }

  md += '\n## Top Signatures\n\n';
  md += '| count | signature |\n';
  md += '|---:|---|\n';
  for (const [signature, count] of top) {
    md += `| ${count} | ${signature.replace(/\|/g, '\\|')} |\n`;
  }

  return md;
}

function pickFailureMessage(detail: Row): string {
  const direct = asString(detail.message);
  if (direct) return direct;

  const errors = asArray(detail.errors).map((value) => String(value));
  if (errors.length > 0) return errors[0];

  const input = asString(detail.input);
  if (input) return input;

  return 'unknown';
}

function normalizeSignature(input: string): string {
  return input
    .toLowerCase()
    .replace(/\/var\/folders\/[\w/-]+/g, '$TMP')
    .replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}z/gi, '$TIME')
    .replace(/\d{2,}/g, '$N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function keyEvalVersion(evalName: string, version: string): string {
  return `${evalName}::${version}`;
}

function matchesRun(row: Row, run: LatestRun): boolean {
  return (
    asString(row['attributes.eval.name']) === run.evalName &&
    asString(row['attributes.eval.version']) === run.version
  );
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeAplString(input: string): string {
  return input.replace(/'/g, "''");
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.8;
  return Math.min(1, Math.max(0, value));
}

function extractElapsedMs(outputRaw: string | undefined): number | undefined {
  if (!outputRaw) return undefined;
  try {
    const parsed = JSON.parse(outputRaw) as {
      trace?: { elapsedMs?: unknown };
    };
    const elapsed = asNumber(parsed.trace?.elapsedMs);
    return elapsed != null ? elapsed : undefined;
  } catch {
    return undefined;
  }
}

function summarizeRuntimes(values: number[]): RuntimeSummary | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    meanMs: avg(sorted),
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    n: sorted.length,
  };
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const clamped = Math.min(1, Math.max(0, p));
  const idx = Math.ceil(clamped * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, idx))] ?? 0;
}

function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
