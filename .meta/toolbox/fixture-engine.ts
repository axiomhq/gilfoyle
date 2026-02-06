/**
 * Fixture Engine
 *
 * Replaces keyword-matching mocks with a query execution engine
 * that validates CLI contracts, parses APL/PromQL, and returns
 * computed results from fixture data.
 *
 * This is what separates a real eval from a retrieval game.
 */

import type { LogRow, MetricSeries, ScenarioFixtures, } from '../harness/types.js';

// ─── APL Parser ──────────────────────────────────────────────────────────

interface ParsedAPL {
  dataset: string;
  stages: APLStage[];
}

type APLStage =
  | { type: 'where'; field: string; op: string; value: string }
  | { type: 'summarize'; agg: string; field?: string; by?: string[] }
  | { type: 'take'; count: number }
  | { type: 'sort'; field: string; order: 'asc' | 'desc' }
  | { type: 'project'; fields: string[] }
  | { type: 'extend'; expr: string }
  | { type: 'top'; count: number; by: string }
  | { type: 'raw'; text: string }; // passthrough for unrecognized stages

export interface APLValidation {
  valid: boolean;
  errors: string[];
  parsed?: ParsedAPL;
}

export function validateAPL(query: string, fixtures: ScenarioFixtures): APLValidation {
  const errors: string[] = [];
  const trimmed = query.trim();

  // Must start with dataset reference: ['dataset-name']
  const datasetMatch = trimmed.match(/^\[['"]([^'"]+)['"]\]/);
  if (!datasetMatch) {
    errors.push(`APL syntax error: query must start with ['dataset-name'], got: "${trimmed.slice(0, 50)}"`);
    return { valid: false, errors };
  }

  const dataset = datasetMatch[1];
  if (!fixtures.datasets[dataset]) {
    const available = Object.keys(fixtures.datasets).join(', ');
    errors.push(`Unknown dataset '${dataset}'. Available datasets: ${available}`);
    return { valid: false, errors };
  }

  // Split by pipe, parse stages
  const rest = trimmed.slice(datasetMatch[0].length).trim();
  const stages: APLStage[] = [];

  if (rest) {
    if (!rest.startsWith('|')) {
      errors.push(`APL syntax error: expected '|' after dataset reference, got: "${rest.slice(0, 30)}"`);
      return { valid: false, errors };
    }

    const stageTexts = splitPipes(rest.slice(1));
    for (const stageText of stageTexts) {
      const stage = parseAPLStage(stageText.trim());
      if (stage) {
        if (stage.type === 'where' && /\band\b/i.test(stageText)) {
          const parts = stageText.trim().replace(/^where\s+/i, '').split(/\s+and\s+/i);
          for (const part of parts) {
            const sub = parseAPLStage(`where ${part.trim()}`);
            if (sub) stages.push(sub);
          }
        } else {
          stages.push(stage);
        }
      }
    }
  }

  for (const stage of stages) {
    if (stage.type === 'raw') {
      errors.push(`Unsupported APL stage: "${stage.text}". Supported: where, summarize, take, sort, project, extend, top`);
    }
  }

  return { valid: errors.length === 0, errors, parsed: { dataset, stages } };
}

function splitPipes(text: string): string[] {
  const stages: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      current += ch;
      if (ch === stringChar && text[i - 1] !== '\\') inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === '|' && depth === 0) {
      if (current.trim()) stages.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) stages.push(current);
  return stages;
}

function parseAPLStage(text: string): APLStage {
  const lower = text.toLowerCase().trim();

  // where clause
  if (lower.startsWith('where ')) {
    const expr = text.slice(6).trim();
    const whereMatch = expr.match(/^([\w.]+)\s*(==|!=|>=|<=|>|<|contains|has|startswith|!contains|!has)\s*(.+)$/i);
    if (whereMatch) {
      return { type: 'where', field: whereMatch[1], op: whereMatch[2], value: whereMatch[3].replace(/^["']|["']$/g, '') };
    }
    return { type: 'where', field: expr, op: 'expr', value: expr };
  }

  // take/limit
  const takeMatch = lower.match(/^(?:take|limit)\s+(\d+)/);
  if (takeMatch) {
    return { type: 'take', count: parseInt(takeMatch[1], 10) };
  }

  // summarize
  if (lower.startsWith('summarize ')) {
    const sumText = text.slice(10).trim();
    const byMatch = sumText.match(/(.+?)\s+by\s+(.+)/i);
    if (byMatch) {
      return {
        type: 'summarize',
        agg: byMatch[1].trim(),
        by: byMatch[2].split(',').map(s => s.trim()),
      };
    }
    return { type: 'summarize', agg: sumText };
  }

  // sort/order by
  const sortMatch = lower.match(/^(?:sort|order)\s+by\s+(\w+)\s*(asc|desc)?/);
  if (sortMatch) {
    return { type: 'sort', field: sortMatch[1], order: (sortMatch[2] as 'asc' | 'desc') || 'desc' };
  }

  // project
  if (lower.startsWith('project ')) {
    return { type: 'project', fields: text.slice(8).split(',').map(s => s.trim()) };
  }

  // extend
  if (lower.startsWith('extend ')) {
    return { type: 'extend', expr: text.slice(7).trim() };
  }

  // top
  const topMatch = lower.match(/^top\s+(\d+)\s+by\s+(\w+)/);
  if (topMatch) {
    return { type: 'top', count: parseInt(topMatch[1], 10), by: topMatch[2] };
  }

  return { type: 'raw', text };
}

// ─── APL Executor ────────────────────────────────────────────────────────

export function executeAPL(parsed: ParsedAPL, fixtures: ScenarioFixtures): LogRow[] {
  let rows = [...(fixtures.datasets[parsed.dataset] ?? [])];

  for (const stage of parsed.stages) {
    switch (stage.type) {
      case 'where':
        rows = executeWhere(rows, stage);
        break;
      case 'take':
        rows = rows.slice(0, stage.count);
        break;
      case 'sort':
        rows.sort((a, b) => {
          const va = a[stage.field] ?? '';
          const vb = b[stage.field] ?? '';
          const cmp = String(va).localeCompare(String(vb), undefined, { numeric: true });
          return stage.order === 'asc' ? cmp : -cmp;
        });
        break;
      case 'project':
        rows = rows.map(row => {
          const projected: LogRow = { _time: row._time };
          for (const f of stage.fields) {
            if (f in row) projected[f] = row[f];
          }
          return projected;
        });
        break;
      case 'summarize':
        rows = executeSummarize(rows, stage);
        break;
      case 'top':
        rows = executeTop(rows, stage);
        break;
      // extend, raw: pass through
    }
  }

  return rows;
}

function executeWhere(rows: LogRow[], stage: { field: string; op: string; value: string }): LogRow[] {
  return rows.filter(row => {
    let fieldVal = row[stage.field];
    if (fieldVal === undefined && stage.field.includes('.')) {
      const parts = stage.field.split('.');
      let cur: unknown = row;
      for (const p of parts) {
        if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
          cur = (cur as Record<string, unknown>)[p];
        } else {
          cur = undefined;
          break;
        }
      }
      if (cur !== undefined) fieldVal = cur as string | number | boolean;
    }
    if (fieldVal === undefined) {
      if (stage.op === 'expr') {
        const rowStr = JSON.stringify(row).toLowerCase();
        return rowStr.includes(stage.value.toLowerCase());
      }
      return false;
    }
    const val = String(fieldVal).toLowerCase();
    const target = stage.value.toLowerCase();
    switch (stage.op) {
      case '==': return val === target;
      case '!=': return val !== target;
      case '>': return Number(fieldVal) > Number(stage.value);
      case '<': return Number(fieldVal) < Number(stage.value);
      case '>=': return Number(fieldVal) >= Number(stage.value);
      case '<=': return Number(fieldVal) <= Number(stage.value);
      case 'contains': return val.includes(target);
      case '!contains': return !val.includes(target);
      case 'has': return val.includes(target);
      case '!has': return !val.includes(target);
      case 'startswith': return val.startsWith(target);
      default: return val.includes(target);
    }
  });
}

function executeSummarize(rows: LogRow[], stage: { agg: string; by?: string[] }): LogRow[] {
  if (!stage.by || stage.by.length === 0) {
    // Single aggregation
    return [computeAgg(rows, stage.agg)];
  }
  // Group by
  const groups = new Map<string, LogRow[]>();
  for (const row of rows) {
    const key = stage.by.map(f => String(row[f] ?? '')).join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  return Array.from(groups.entries()).map(([key, groupRows]) => {
    const result = computeAgg(groupRows, stage.agg);
    const keyParts = key.split('|');
    for (let i = 0; i < stage.by!.length; i++) {
      result[stage.by![i]] = keyParts[i];
    }
    return result;
  });
}

function computeAgg(rows: LogRow[], agg: string): LogRow {
  const countMatch = agg.match(/^count\(\)$/i);
  if (countMatch) {
    return { _time: rows[0]?._time ?? '', count_: rows.length };
  }
  const dcountMatch = agg.match(/^dcount\((\w+)\)$/i);
  if (dcountMatch) {
    const field = dcountMatch[1];
    const unique = new Set(rows.map(r => String(r[field] ?? '')));
    return { _time: rows[0]?._time ?? '', [`dcount_${field}`]: unique.size };
  }
  const avgMatch = agg.match(/^avg\((\w+)\)$/i);
  if (avgMatch) {
    const field = avgMatch[1];
    const vals = rows.map(r => Number(r[field])).filter(v => !Number.isNaN(v));
    return { _time: rows[0]?._time ?? '', [`avg_${field}`]: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0 };
  }
  const sumMatch = agg.match(/^sum\((\w+)\)$/i);
  if (sumMatch) {
    const field = sumMatch[1];
    const vals = rows.map(r => Number(r[field])).filter(v => !Number.isNaN(v));
    return { _time: rows[0]?._time ?? '', [`sum_${field}`]: vals.reduce((a, b) => a + b, 0) };
  }
  const maxMatch = agg.match(/^max\((\w+)\)$/i);
  if (maxMatch) {
    const field = maxMatch[1];
    const vals = rows.map(r => Number(r[field])).filter(v => !Number.isNaN(v));
    return { _time: rows[0]?._time ?? '', [`max_${field}`]: Math.max(...vals) };
  }
  const minMatch = agg.match(/^min\((\w+)\)$/i);
  if (minMatch) {
    const field = minMatch[1];
    const vals = rows.map(r => Number(r[field])).filter(v => !Number.isNaN(v));
    return { _time: rows[0]?._time ?? '', [`min_${field}`]: Math.min(...vals) };
  }
  // Fallback: just count
  return { _time: rows[0]?._time ?? '', count_: rows.length, _agg: agg };
}

function executeTop(rows: LogRow[], stage: { count: number; by: string }): LogRow[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const val = String(row[stage.by] ?? '');
    counts.set(val, (counts.get(val) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, stage.count)
    .map(([val, count]) => ({ _time: '', [stage.by]: val, count_: count }));
}

// ─── PromQL Validator ────────────────────────────────────────────────────

export interface PromQLValidation {
  valid: boolean;
  errors: string[];
  metricName?: string;
  labels?: Record<string, { op: string; value: string }>;
}

export function validatePromQL(query: string, fixtures: ScenarioFixtures): PromQLValidation {
  const errors: string[] = [];
  const trimmed = query.trim();

  if (!trimmed) {
    errors.push('Empty PromQL query');
    return { valid: false, errors };
  }

  // Extract base metric name (handles functions wrapping metrics)
  let metricName: string | undefined;
  const labels: Record<string, { op: string; value: string }> = {};

  // Try to find metric name inside functions or at top level
  // Patterns: metric_name, metric_name{...}, func(metric_name{...}[5m])
  const metricPatterns = [
    /^([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(?:\{|$)/,  // bare metric or metric{
    /\(([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(?:\{|\[|$|\))/,  // func(metric
    /\(([a-zA-Z_:][a-zA-Z0-9_:]*)\s*\{/,  // func(metric{
  ];

  for (const pat of metricPatterns) {
    const m = trimmed.match(pat);
    if (m) {
      metricName = m[1];
      break;
    }
  }

  if (!metricName) {
    // Could be a complex expression - try to find any metric-like identifier
    const anyMetric = trimmed.match(/([a-zA-Z_:][a-zA-Z0-9_:]*)\s*[[{(]/);
    if (anyMetric) {
      const candidate = anyMetric[1];
      // Skip known PromQL functions
      const funcs = ['rate', 'increase', 'sum', 'avg', 'max', 'min', 'count',
        'histogram_quantile', 'irate', 'delta', 'deriv', 'abs', 'ceil', 'floor',
        'round', 'clamp', 'clamp_min', 'clamp_max', 'label_replace', 'label_join',
        'sort', 'sort_desc', 'topk', 'bottomk', 'by', 'without', 'on', 'ignoring',
        'group_left', 'group_right', 'offset', 'bool', 'time', 'vector', 'scalar'];
      if (!funcs.includes(candidate.toLowerCase())) {
        metricName = candidate;
      }
    }
  }

  // Parse label matchers if present
  const labelBlock = trimmed.match(/\{([^}]*)\}/);
  if (labelBlock) {
    const labelStr = labelBlock[1];
    const labelMatches = labelStr.matchAll(/(\w+)\s*(=~|!=|=|!~)\s*"([^"]*)"/g);
    for (const lm of labelMatches) {
      labels[lm[1]] = { op: lm[2], value: lm[3] };
    }
  }

  // Validate metric exists in fixtures
  if (metricName) {
    const knownMetrics = Object.keys(fixtures.metrics);
    if (knownMetrics.length > 0 && !knownMetrics.includes(metricName)) {
      // Check if it's a partial match or the metric is wrapped in a function
      const anyMatch = knownMetrics.some(m => m === metricName || m.startsWith(metricName));
      if (!anyMatch) {
        errors.push(`Unknown metric '${metricName}'. Available: ${knownMetrics.join(', ')}`);
      }
    }
  }

  // Basic syntax checks
  const openParens = (trimmed.match(/\(/g) || []).length;
  const closeParens = (trimmed.match(/\)/g) || []).length;
  if (openParens !== closeParens) {
    errors.push(`Unbalanced parentheses: ${openParens} open vs ${closeParens} close`);
  }
  const openBraces = (trimmed.match(/\{/g) || []).length;
  const closeBraces = (trimmed.match(/\}/g) || []).length;
  if (openBraces !== closeBraces) {
    errors.push(`Unbalanced braces: ${openBraces} open vs ${closeBraces} close`);
  }
  const openBrackets = (trimmed.match(/\[/g) || []).length;
  const closeBrackets = (trimmed.match(/\]/g) || []).length;
  if (openBrackets !== closeBrackets) {
    errors.push(`Unbalanced brackets: ${openBrackets} open vs ${closeBrackets} close`);
  }

  return { valid: errors.length === 0, errors, metricName, labels };
}

// ─── PromQL Executor ─────────────────────────────────────────────────────

export function executePromQL(query: string, fixtures: ScenarioFixtures): MetricSeries[] {
  const validation = validatePromQL(query, fixtures);
  if (!validation.metricName) return [];

  const metricName = validation.metricName;
  let series = fixtures.metrics[metricName] ?? [];

  // Apply label filters
  if (validation.labels && Object.keys(validation.labels).length > 0) {
    series = series.filter(s => {
      for (const [key, matcher] of Object.entries(validation.labels!)) {
        const actual = s.labels[key] ?? '';
        switch (matcher.op) {
          case '=':
            if (actual !== matcher.value) return false;
            break;
          case '!=':
            if (actual === matcher.value) return false;
            break;
          case '=~':
            if (!new RegExp(matcher.value).test(actual)) return false;
            break;
          case '!~':
            if (new RegExp(matcher.value).test(actual)) return false;
            break;
        }
      }
      return true;
    });
  }

  return series;
}

// ─── CLI Contract Validation ─────────────────────────────────────────────

export interface CLIValidation {
  valid: boolean;
  errors: string[];
  deployment?: string;
  datasourceUid?: string;
  query?: string;
}

export function validateAxiomCLI(args: string[], stdinQuery: string, fixtures: ScenarioFixtures): CLIValidation {
  const errors: string[] = [];

  // axiom-query <deployment> [options] <<< "query"
  if (args.length < 1) {
    errors.push('Missing deployment argument. Usage: axiom-query <deployment> [options]');
    return { valid: false, errors };
  }

  const deployment = args[0];
  if (!fixtures.validDeployments.includes(deployment)) {
    errors.push(`Unknown deployment '${deployment}'. Available: ${fixtures.validDeployments.join(', ')}`);
  }

  if (!stdinQuery.trim()) {
    errors.push('No query provided via stdin. Pipe a query: axiom-query prod <<< "query"');
  }

  // Check for invalid args
  const validFlags = ['--raw', '--ndjson', '--full', '--trace'];
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--') && !validFlags.includes(args[i])) {
      errors.push(`Unknown flag '${args[i]}'. Valid: ${validFlags.join(', ')}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    deployment,
    query: stdinQuery.trim(),
  };
}

export function validateGrafanaCLI(args: string[], fixtures: ScenarioFixtures): CLIValidation {
  const errors: string[] = [];

  // grafana-query <deployment> <datasource_uid> <query> [options]
  if (args.length < 3) {
    errors.push('Missing arguments. Usage: grafana-query <deployment> <datasource_uid> <query> [options]');
    return { valid: false, errors };
  }

  const deployment = args[0];
  const datasourceUid = args[1];
  const query = args[2];

  if (!fixtures.validDeployments.includes(deployment)) {
    errors.push(`Unknown deployment '${deployment}'. Available: ${fixtures.validDeployments.join(', ')}`);
  }

  const knownDs = fixtures.datasources.map(d => d.uid);
  if (knownDs.length > 0 && !knownDs.includes(datasourceUid)) {
    // Also accept name-based references
    const knownNames = fixtures.datasources.map(d => d.name);
    if (!knownNames.includes(datasourceUid)) {
      errors.push(`Unknown datasource '${datasourceUid}'. Available: ${fixtures.datasources.map(d => `${d.name} (${d.uid})`).join(', ')}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    deployment,
    datasourceUid,
    query,
  };
}

// ─── Output Formatting ──────────────────────────────────────────────────

/**
 * Format log rows like axiom-query-fmt text mode:
 * # 15/1000 rows, 42ms
 * _time=2026-02-06T14:32:10Z level=warn message="memory usage above 90%"
 */
export function formatAxiomOutput(rows: LogRow[], totalRows: number): string {
  const header = `# ${rows.length}/${totalRows} rows, ${Math.floor(Math.random() * 50 + 10)}ms`;
  if (rows.length === 0) return `${header}\n(no results)`;

  const lines = rows.map(row => {
    return Object.entries(row)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => {
        const str = String(v);
        return str.includes(' ') || str.includes('"') ? `${k}="${str}"` : `${k}=${str}`;
      })
      .join(' ');
  });

  return [header, ...lines].join('\n');
}

/**
 * Format metric series like grafana-query text mode
 */
export function formatGrafanaOutput(series: MetricSeries[], deployment: string, datasource: string, query: string): string {
  if (series.length === 0) {
    return `Deployment: ${deployment}\nDatasource: ${datasource}\nQuery: ${query}\n\nSeries: 0\n(no results)`;
  }

  const lines = [
    `Deployment: ${deployment}`,
    `Datasource: ${datasource}`,
    `Query: ${query}`,
    `Range: 1h (step: 1m)`,
    '',
    `Series: ${series.length}`,
    '',
  ];

  for (const s of series) {
    const labelStr = Object.entries(s.labels).map(([k, v]) => `${k}="${v}"`).join(', ');
    const metricLabel = labelStr ? `Metric: {${labelStr}}` : `Metric: ${s.metric}`;
    lines.push(metricLabel);
    lines.push(`Samples: ${s.values.length}`);

    if (s.values.length > 0) {
      const vals = s.values.map(v => v[1]);
      lines.push(`Min: ${Math.min(...vals)}`);
      lines.push(`Max: ${Math.max(...vals)}`);
      lines.push(`Avg: ${(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
