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
import { validateAPLSyntax, validatePromQLSyntax } from './apl-validator.js';

// ─── APL Parser ──────────────────────────────────────────────────────────

interface ParsedAPL {
  dataset: string;
  stages: APLStage[];
}

type APLStage =
  | { type: 'where'; expr: string }
  | { type: 'summarize'; agg: string; field?: string; by?: string[] }
  | { type: 'take'; count: number }
  | { type: 'sort'; field: string; order: 'asc' | 'desc' }
  | { type: 'project'; fields: string[] }
  | { type: 'distinct'; fields: string[] }
  | { type: 'getschema' }
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

  // Real parser syntax check (Axiom APL parser via WASM)
  const syntaxCheck = validateAPLSyntax(trimmed);
  if (!syntaxCheck.valid) {
    errors.push(`APL syntax error: ${syntaxCheck.error}`);
    return { valid: false, errors };
  }

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
      if (stage) stages.push(stage);
    }
  }

  for (const stage of stages) {
    if (stage.type === 'raw') {
      errors.push(`Unsupported APL stage: "${stage.text}". Supported: where, summarize, take, sort, project, distinct, getschema, extend, top`);
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

function splitTopLevel(text: string, delimiter: string): string[] {
  const out: string[] = [];
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
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === delimiter && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }

  out.push(current);
  return out;
}

function parseAPLStage(text: string): APLStage {
  const lower = text.toLowerCase().trim();

  // where clause
  if (lower.startsWith('where ')) {
    return { type: 'where', expr: text.slice(6).trim() };
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
        by: splitTopLevel(byMatch[2], ',').map(s => s.trim()).filter(Boolean),
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
    return { type: 'project', fields: splitTopLevel(text.slice(8), ',').map(s => s.trim()).filter(Boolean) };
  }

  // distinct
  if (lower.startsWith('distinct ')) {
    return { type: 'distinct', fields: splitTopLevel(text.slice(9), ',').map(s => s.trim()).filter(Boolean) };
  }

  // getschema
  if (lower === 'getschema') {
    return { type: 'getschema' };
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
        rows = executeWhere(rows, stage.expr);
        break;
      case 'take':
        rows = rows.slice(0, stage.count);
        break;
      case 'sort':
        rows.sort((a, b) => {
          const va = getFieldValue(a, stage.field) ?? '';
          const vb = getFieldValue(b, stage.field) ?? '';
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
      case 'distinct':
        rows = executeDistinct(rows, stage.fields);
        break;
      case 'getschema':
        rows = executeGetSchema(rows);
        break;
      case 'top':
        rows = executeTop(rows, stage);
        break;
      // extend, raw: pass through
    }
  }

  return rows;
}

function executeWhere(rows: LogRow[], expr: string): LogRow[] {
  return rows.filter((row) => evaluateWhereExpression(row, expr));
}

function evaluateWhereExpression(row: LogRow, expr: string): boolean {
  const trimmed = trimOuterParens(expr.trim());
  if (!trimmed) return true;

  const orParts = splitByLogical(trimmed, 'or');
  if (orParts.length > 1) {
    return orParts.some((part) => evaluateWhereExpression(row, part));
  }

  const andParts = splitByLogical(trimmed, 'and');
  if (andParts.length > 1) {
    return andParts.every((part) => evaluateWhereExpression(row, part));
  }

  return evaluateAtomicWhereCondition(row, trimmed);
}

function evaluateAtomicWhereCondition(row: LogRow, expr: string): boolean {
  const inMatch = expr.match(/^([\w.]+)\s+in\s*(?:\((.+)\)|\[(.+)\])$/i);
  if (inMatch) {
    const field = inMatch[1];
    const listExpr = inMatch[2] ?? inMatch[3] ?? '';
    const listValues = splitTopLevel(listExpr, ',')
      .map((p) => parseLiteral(p.trim()))
      .filter((v) => v !== undefined);
    const fieldVal = getFieldValue(row, field);
    if (fieldVal === undefined) return false;
    return listValues.some((candidate) => literalEquals(fieldVal, candidate));
  }

  const cmpMatch = expr.match(/^([\w.]+)\s*(==|!=|>=|<=|>|<|contains_cs|has_cs|contains|has|startswith|!contains|!has|=~|!~)\s*(.+)$/i);
  if (cmpMatch) {
    const field = cmpMatch[1];
    const op = cmpMatch[2].toLowerCase();
    const right = parseLiteral(cmpMatch[3].trim());
    const fieldVal = getFieldValue(row, field);
    if (fieldVal === undefined || right === undefined) return false;
    return applyWhereOperator(fieldVal, op, right);
  }

  const rowStr = JSON.stringify(row).toLowerCase();
  return rowStr.includes(trimmedLower(expr));
}

function splitByLogical(expr: string, keyword: 'and' | 'or'): string[] {
  const out: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inString) {
      current += ch;
      if (ch === stringChar && expr[i - 1] !== '\\') inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;

    if (depth === 0) {
      const remaining = expr.slice(i);
      const logical = new RegExp(`^\\s+${keyword}\\s+`, 'i');
      const m = remaining.match(logical);
      if (m) {
        out.push(current.trim());
        current = '';
        i += m[0].length - 1;
        continue;
      }
    }

    current += ch;
  }

  out.push(current.trim());
  return out.filter(Boolean);
}

function trimOuterParens(expr: string): string {
  let out = expr.trim();
  while (out.startsWith('(') && out.endsWith(')')) {
    let depth = 0;
    let valid = true;
    for (let i = 0; i < out.length; i++) {
      const ch = out[i];
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (depth === 0 && i < out.length - 1) {
        valid = false;
        break;
      }
    }
    if (!valid) break;
    out = out.slice(1, -1).trim();
  }
  return out;
}

function parseLiteral(value: string): string | number | boolean | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  const numeric = Number(trimmed);
  if (!Number.isNaN(numeric)) return numeric;
  return trimmed;
}

function literalEquals(actual: unknown, candidate: string | number | boolean): boolean {
  if (typeof candidate === 'number') {
    return Number(actual) === candidate;
  }
  if (typeof candidate === 'boolean') {
    return String(actual).toLowerCase() === String(candidate);
  }
  return String(actual) === candidate;
}

function applyWhereOperator(
  actual: unknown,
  op: string,
  right: string | number | boolean,
): boolean {
  const leftText = String(actual);
  const rightText = String(right);
  const leftLower = leftText.toLowerCase();
  const rightLower = rightText.toLowerCase();
  const leftNum = Number(actual);
  const rightNum = Number(right);
  const numeric = !Number.isNaN(leftNum) && !Number.isNaN(rightNum);

  switch (op) {
    case '==':
      return numeric ? leftNum === rightNum : leftLower === rightLower;
    case '!=':
      return numeric ? leftNum !== rightNum : leftLower !== rightLower;
    case '>':
      return numeric ? leftNum > rightNum : leftText > rightText;
    case '<':
      return numeric ? leftNum < rightNum : leftText < rightText;
    case '>=':
      return numeric ? leftNum >= rightNum : leftText >= rightText;
    case '<=':
      return numeric ? leftNum <= rightNum : leftText <= rightText;
    case 'contains':
    case 'has':
      return leftLower.includes(rightLower);
    case '!contains':
    case '!has':
      return !leftLower.includes(rightLower);
    case 'contains_cs':
    case 'has_cs':
      return leftText.includes(rightText);
    case 'startswith':
      return leftLower.startsWith(rightLower);
    case '=~':
      try {
        return new RegExp(rightText).test(leftText);
      } catch {
        return false;
      }
    case '!~':
      try {
        return !new RegExp(rightText).test(leftText);
      } catch {
        return false;
      }
    default:
      return leftLower.includes(rightLower);
  }
}

function getFieldValue(row: LogRow, field: string): unknown {
  const direct = row[field];
  if (direct !== undefined) return direct;
  if (!field.includes('.')) return undefined;

  const parts = field.split('.');
  let cur: unknown = row;
  for (const part of parts) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

function trimmedLower(text: string): string {
  return text.trim().toLowerCase();
}

function executeSummarize(rows: LogRow[], stage: { agg: string; by?: string[] }): LogRow[] {
  if (!stage.by || stage.by.length === 0) {
    // Single aggregation
    return [computeAgg(rows, stage.agg)];
  }
  const groupBy = stage.by;
  // Group by
  const groups = new Map<string, LogRow[]>();
  for (const row of rows) {
    const key = groupBy.map((expr) => getGroupValue(row, expr)).join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  return Array.from(groups.entries()).map(([key, groupRows]) => {
    const result = computeAgg(groupRows, stage.agg);
    const keyParts = key.split('|');
    for (let i = 0; i < groupBy.length; i++) {
      result[groupColumnName(groupBy[i])] = keyParts[i];
    }
    return result;
  });
}

function getGroupValue(row: LogRow, expr: string): string {
  const trimmed = expr.trim();
  const binMatch = trimmed.match(/^bin\(([\w.]+)\s*,\s*([^)]+)\)$/i);
  if (binMatch) {
    const field = binMatch[1];
    const intervalMs = parseDurationMs(binMatch[2].trim());
    const value = getFieldValue(row, field);
    if (value == null) return '';
    const epoch = valueToEpochMs(value);
    if (epoch == null || intervalMs == null || intervalMs <= 0) return String(value);
    const binned = Math.floor(epoch / intervalMs) * intervalMs;
    return new Date(binned).toISOString();
  }
  const value = getFieldValue(row, trimmed);
  return value == null ? '' : String(value);
}

function groupColumnName(expr: string): string {
  const trimmed = expr.trim();
  const binMatch = trimmed.match(/^bin\(([\w.]+)\s*,\s*([^)]+)\)$/i);
  if (!binMatch) return trimmed;
  const field = binMatch[1];
  if (field === '_time') return '_time';
  return `bin_${field}`;
}

function parseDurationMs(raw: string): number | null {
  const m = raw.trim().match(/^(\d+)\s*(ms|s|m|h|d)$/i);
  if (!m) return null;
  const value = Number.parseInt(m[1] ?? '0', 10);
  const unit = (m[2] ?? 'ms').toLowerCase();
  const factors: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * (factors[unit] ?? 1);
}

function valueToEpochMs(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value * (value > 1e12 ? 1 : 1000) : null;
  }
  const asDate = new Date(String(value));
  const epoch = asDate.getTime();
  return Number.isFinite(epoch) ? epoch : null;
}

function executeDistinct(rows: LogRow[], fields: string[]): LogRow[] {
  if (fields.length === 0) return [];
  const seen = new Set<string>();
  const out: LogRow[] = [];

  for (const row of rows) {
    const keyParts = fields.map((field) => String(getFieldValue(row, field) ?? ''));
    const key = keyParts.join('|');
    if (seen.has(key)) continue;
    seen.add(key);

    const distinctRow: LogRow = { _time: '' };
    for (let i = 0; i < fields.length; i++) {
      distinctRow[fields[i]] = keyParts[i];
    }
    out.push(distinctRow);
  }

  return out;
}

function executeGetSchema(rows: LogRow[]): LogRow[] {
  const fieldTypes = new Map<string, string>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (!fieldTypes.has(key) && value != null) {
        fieldTypes.set(key, inferType(value));
      }
      if (!fieldTypes.has(key)) {
        fieldTypes.set(key, 'null');
      }
    }
  }

  return Array.from(fieldTypes.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([field, type]) => ({ _time: '', field, type }));
}

function inferType(value: unknown): string {
  if (value == null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'object') return 'object';
  return t;
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
    const val = String(getFieldValue(row, stage.by) ?? '');
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

  // Real parser syntax check (Prometheus PromQL parser via WASM)
  const syntaxCheck = validatePromQLSyntax(trimmed);
  if (!syntaxCheck.valid) {
    errors.push(`PromQL syntax error: ${syntaxCheck.error}`);
    return { valid: false, errors };
  }

  // Extract base metric name (handles functions wrapping metrics)
  let metricName: string | undefined;
  const labels: Record<string, { op: string; value: string }> = {};

  const metricPatterns = [
    /^([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(?:\{|$)/,
    /\(([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(?:\{|\[|$|\))/,
    /\(([a-zA-Z_:][a-zA-Z0-9_:]*)\s*\{/,
  ];

  for (const pat of metricPatterns) {
    const m = trimmed.match(pat);
    if (m) {
      metricName = m[1];
      break;
    }
  }

  if (!metricName) {
    const anyMetric = trimmed.match(/([a-zA-Z_:][a-zA-Z0-9_:]*)\s*[[{(]/);
    if (anyMetric) {
      const candidate = anyMetric[1];
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

  const labelBlock = trimmed.match(/\{([^}]*)\}/);
  if (labelBlock) {
    const labelStr = labelBlock[1];
    const labelMatches = labelStr.matchAll(/(\w+)\s*(=~|!=|=|!~)\s*"([^"]*)"/g);
    for (const lm of labelMatches) {
      labels[lm[1]] = { op: lm[2], value: lm[3] };
    }
  }

  if (metricName) {
    const knownMetrics = Object.keys(fixtures.metrics);
    if (knownMetrics.length > 0 && !knownMetrics.includes(metricName)) {
      const anyMatch = knownMetrics.some(m => m === metricName || m.startsWith(metricName));
      if (!anyMatch) {
        errors.push(`Unknown metric '${metricName}'. Available: ${knownMetrics.join(', ')}`);
      }
    }
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

interface CLIValidationOptions {
  fallbackQuery?: string;
}

function stripWrappingQuotes(value: string): string {
  let out = value.trim();
  while (
    (out.startsWith('"') && out.endsWith('"'))
    || (out.startsWith("'") && out.endsWith("'"))
    || (out.startsWith('`') && out.endsWith('`'))
  ) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

function normalizeLoose(value: string): string {
  return stripWrappingQuotes(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeCompact(value: string): string {
  return normalizeLoose(value).replace(/[\s_-]+/g, '');
}

function resolveDeployment(input: string, fixtures: ScenarioFixtures): string | undefined {
  const requested = stripWrappingQuotes(input);
  if (!requested) return undefined;

  const exact = fixtures.validDeployments.find(d => d === requested);
  if (exact) return exact;

  const ci = fixtures.validDeployments.find(d => d.toLowerCase() === requested.toLowerCase());
  if (ci) return ci;

  const compactRequested = normalizeCompact(requested);
  const compact = fixtures.validDeployments.find(d => normalizeCompact(d) === compactRequested);
  if (compact) return compact;

  if (compactRequested === 'prod' || compactRequested === 'production') {
    const prodLike = fixtures.validDeployments.find(d => /\bprod\b|production/i.test(d));
    if (prodLike) return prodLike;

    // Synthetic scenarios often expose a single concrete deployment name.
    if (fixtures.validDeployments.length >= 1) return fixtures.validDeployments[0];
  }

  return undefined;
}

function resolveDatasource(input: string, fixtures: ScenarioFixtures): string | undefined {
  const requested = stripWrappingQuotes(input);
  if (!requested) return undefined;

  const byUid = fixtures.datasources.find(ds => ds.uid === requested || ds.uid.toLowerCase() === requested.toLowerCase());
  if (byUid) return byUid.uid;

  const requestedLoose = normalizeLoose(requested);
  const requestedCompact = normalizeCompact(requested);

  for (const ds of fixtures.datasources) {
    const aliases = [
      ds.uid,
      ds.name,
      `${ds.name} (${ds.uid})`,
      `${ds.name} (uid: ${ds.uid})`,
    ];

    const matched = aliases.some(alias => {
      const loose = normalizeLoose(alias);
      const compact = normalizeCompact(alias);
      return loose === requestedLoose || compact === requestedCompact;
    });

    if (matched) return ds.uid;
  }

  const prometheusLike = requestedCompact === 'prometheusprod'
    || requestedCompact === 'prometheusproduction'
    || requestedCompact === 'prometheus';
  if (prometheusLike) {
    const promDatasources = fixtures.datasources.filter(ds => /prometheus/i.test(ds.name) || /prom/i.test(ds.uid));
    if (promDatasources.length === 1) return promDatasources[0].uid;
  }

  if (fixtures.datasources.length === 1) {
    return fixtures.datasources[0].uid;
  }

  return undefined;
}

export function validateAxiomCLI(
  args: string[],
  stdinQuery: string,
  fixtures: ScenarioFixtures,
  options: CLIValidationOptions = {},
): CLIValidation {
  const errors: string[] = [];

  // axiom-query <deployment> [options]
  if (args.length < 1) {
    errors.push('Missing deployment argument. Usage: axiom-query <deployment> [options]');
    return { valid: false, errors };
  }

  const deploymentInput = args[0];
  const deployment = resolveDeployment(deploymentInput, fixtures);
  if (!deployment) {
    errors.push(`Unknown deployment '${deploymentInput}'. Available: ${fixtures.validDeployments.join(', ')}`);
  }

  const query = stdinQuery.trim() || options.fallbackQuery?.trim() || '';
  if (!query) {
    errors.push('No query provided. Pipe query via stdin or pass --query/--query-file.');
  }

  // Check for invalid args
  const validFlags = ['--raw', '--ndjson', '--full', '--trace', '--query', '--query-file'];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--query' || arg === '--query-file') {
      i += 1;
      continue;
    }
    if (arg.startsWith('--query=') || arg.startsWith('--query-file=')) {
      continue;
    }
    if (arg.startsWith('--') && !validFlags.includes(arg)) {
      errors.push(`Unknown flag '${args[i]}'. Valid: ${validFlags.join(', ')}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    deployment,
    query,
  };
}

export function validateGrafanaCLI(
  args: string[],
  fixtures: ScenarioFixtures,
  options: CLIValidationOptions = {},
): CLIValidation {
  const errors: string[] = [];

  // grafana-query <deployment> <datasource_uid> [query] [options]
  if (args.length < 2) {
    errors.push('Missing arguments. Usage: grafana-query <deployment> <datasource_uid> <query> [options]');
    return { valid: false, errors };
  }

  const deploymentInput = args[0];
  const datasourceInput = args[1];
  const query = args[2]?.trim() || options.fallbackQuery?.trim() || '';

  const deployment = resolveDeployment(deploymentInput, fixtures);
  if (!deployment) {
    errors.push(`Unknown deployment '${deploymentInput}'. Available: ${fixtures.validDeployments.join(', ')}`);
  }

  const datasourceUid = resolveDatasource(datasourceInput, fixtures);
  if (!datasourceUid) {
    errors.push(`Unknown datasource '${datasourceInput}'. Available: ${fixtures.datasources.map(d => `${d.name} (${d.uid})`).join(', ')}`);
  }

  if (!query) {
    errors.push('No query provided. Pass query as positional arg or --query/--query-file.');
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
