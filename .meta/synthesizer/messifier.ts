/**
 * Messifier
 *
 * Transforms clean canonical events into realistic, wide, dirty
 * Axiom-like log rows. This is where the realism lives.
 *
 * Real Axiom datasets have:
 * - 30-80 fields per row, most irrelevant
 * - Inconsistent field naming (service vs svc vs app.service)
 * - Null values scattered throughout
 * - JSON-encoded strings in values
 * - Kubernetes metadata, trace IDs, request context
 * - Different field sets per service/event type
 */

import type { BlueprintEvent, BlueprintMetric, ScenarioBlueprint, ScenarioSeed } from './types.js';
import type { LogRow, MetricSeries, ScenarioFixtures } from '../harness/types.js';

// ─── Seeded PRNG ─────────────────────────────────────────────────────────

function createRng(seed: string): () => number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(31, h) + seed.charCodeAt(i) | 0;
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 13), 0x45d9f3b);
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 0x100000000;
  };
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function maybe<T>(rng: () => number, prob: number, val: T): T | undefined {
  return rng() < prob ? val : undefined;
}

// ─── Field Name Aliases ──────────────────────────────────────────────────

const FIELD_ALIASES: Record<string, string[]> = {
  'service': ['service', 'svc', 'app.service', 'kubernetes.container_name', 'resource.service.name', 'service_name'],
  'level': ['level', 'severity', 'log.level', 'severity_text', 'LEVEL', 'loglevel'],
  'message': ['message', 'msg', 'log', 'event.message', 'body', 'log.message'],
  'timestamp': ['_time', 'timestamp', '@timestamp', 'time', 'ts'],
  'trace_id': ['trace_id', 'traceId', 'trace.id', 'x-trace-id', 'dd.trace_id'],
  'span_id': ['span_id', 'spanId', 'span.id', 'dd.span_id'],
  'host': ['host', 'hostname', 'host.name', 'node', 'kubernetes.node_name'],
  'pod': ['pod', 'pod_name', 'kubernetes.pod_name', 'k8s.pod.name', 'pod_id'],
  'namespace': ['namespace', 'ns', 'kubernetes.namespace', 'k8s.namespace.name'],
  'container': ['container', 'container_name', 'kubernetes.container_name', 'container_id'],
  'status': ['status', 'status_code', 'http.status_code', 'response.status', 'statusCode'],
  'method': ['method', 'http.method', 'http.request.method', 'request.method', 'verb'],
  'path': ['path', 'url', 'http.url', 'http.target', 'request.path', 'uri', 'endpoint'],
  'latency': ['latency_ms', 'duration_ms', 'response_time_ms', 'elapsed_ms', 'http.duration'],
  'error': ['error', 'err', 'error.message', 'exception.message', 'err_msg'],
  'user_id': ['user_id', 'userId', 'user.id', 'uid', 'account_id'],
  'region': ['region', 'cloud.region', 'aws.region', 'datacenter', 'dc'],
};

function getFieldName(canonical: string, rng: () => number, casingDrift: number, aliasRate: number): string {
  const aliases = FIELD_ALIASES[canonical];
  if (!aliases) return canonical;

  let name: string;
  if (rng() < aliasRate && aliases.length > 1) {
    name = pick(rng, aliases);
  } else {
    name = aliases[0];
  }

  if (rng() < casingDrift) {
    const transforms = [
      (s: string) => s.toUpperCase(),
      (s: string) => s.toLowerCase(),
      (s: string) => s.charAt(0).toUpperCase() + s.slice(1),
      (s: string) => s.replace(/[._]/g, '-'),
    ];
    name = pick(rng, transforms)(name);
  }

  return name;
}

// ─── Noise Field Generators ──────────────────────────────────────────────

const NOISE_FIELDS: Record<string, () => unknown>[] = [
  { 'kubernetes.pod_ip': () => `10.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}` },
  { 'kubernetes.labels.app': () => pick(Math.random, ['api', 'worker', 'cron', 'web']) },
  { 'kubernetes.labels.version': () => `v${Math.floor(Math.random()*3)+1}.${Math.floor(Math.random()*20)}.${Math.floor(Math.random()*10)}` },
  { 'build.sha': () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10) },
  { 'env': () => pick(Math.random, ['production', 'prod', 'prd']) },
  { 'cloud.provider': () => 'aws' },
  { 'cloud.availability_zone': () => pick(Math.random, ['us-east-1a', 'us-east-1b', 'us-east-1c']) },
  { 'process.pid': () => Math.floor(Math.random() * 65000) + 1000 },
  { 'process.runtime': () => pick(Math.random, ['node', 'go', 'python', 'java']) },
  { 'process.runtime.version': () => pick(Math.random, ['20.11.0', '1.22.1', '3.12.0', '21.0.1']) },
  { 'request.id': () => `req-${Math.random().toString(36).slice(2, 14)}` },
  { 'correlation_id': () => crypto.randomUUID() },
  { 'x_forwarded_for': () => `${Math.floor(Math.random()*223)+1}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}` },
  { 'user_agent': () => pick(Math.random, ['Mozilla/5.0', 'curl/8.4.0', 'Go-http-client/2.0', 'python-requests/2.31.0']) },
  { 'content_length': () => Math.floor(Math.random() * 10000) },
  { 'protocol': () => pick(Math.random, ['HTTP/1.1', 'HTTP/2', 'h2c']) },
  { 'tls_version': () => pick(Math.random, ['TLSv1.2', 'TLSv1.3']) },
  { 'featureFlag.checkout_flow': () => pick(Math.random, ['enabled', 'disabled', 'canary']) },
  { 'tenant_id': () => `tenant-${Math.floor(Math.random() * 50)}` },
  { 'queue.depth': () => Math.floor(Math.random() * 1000) },
  { 'cache.hit': () => pick(Math.random, [true, false]) },
  { 'retry_count': () => Math.floor(Math.random() * 3) },
  { 'request.size_bytes': () => Math.floor(Math.random() * 50000) },
  { 'response.size_bytes': () => Math.floor(Math.random() * 100000) },
  { 'gc.pause_ms': () => Math.floor(Math.random() * 50) },
  { 'thread_count': () => Math.floor(Math.random() * 200) + 10 },
  { 'goroutine_count': () => Math.floor(Math.random() * 500) + 20 },
  { '_sysTime': () => new Date(Date.now() - Math.floor(Math.random() * 100)).toISOString() },
];

function generateNoiseFields(rng: () => number, targetWidth: number, currentWidth: number): Record<string, unknown> {
  const fieldsToAdd = Math.max(0, targetWidth - currentWidth);
  const noise: Record<string, unknown> = {};
  const available = [...NOISE_FIELDS];

  for (let i = 0; i < fieldsToAdd && available.length > 0; i++) {
    const idx = Math.floor(rng() * available.length);
    const field = available.splice(idx, 1)[0];
    const [name, gen] = Object.entries(field)[0];
    noise[name] = gen();
  }

  return noise;
}

// ─── Value Messification ─────────────────────────────────────────────────

function messifyValue(rng: () => number, value: unknown, jsonRate: number): unknown {
  if (value === null || value === undefined) return value;

  // Sometimes JSON-encode object values as strings
  if (typeof value === 'object' && rng() < jsonRate) {
    return JSON.stringify(value);
  }

  // Sometimes JSON-encode simple values too (like Axiom does with some fields)
  if (typeof value === 'string' && value.length > 20 && rng() < jsonRate * 0.3) {
    return JSON.stringify({ text: value });
  }

  return value;
}

// ─── Core Messification ─────────────────────────────────────────────────

export function messifyEvent(
  event: BlueprintEvent,
  scenarioStart: Date,
  rng: () => number,
  seed: ScenarioSeed,
  variantIndex: number,
): LogRow {
  const time = new Date(scenarioStart.getTime() + event.tsOffsetSec * 1000);
  const m = seed.messiness;
  const targetWidth = m.fieldWidth[0] + Math.floor(rng() * (m.fieldWidth[1] - m.fieldWidth[0]));

  const row: LogRow = {
    _time: time.toISOString(),
  };

  // Core fields with aliased names
  row[getFieldName('level', rng, m.casingDrift, m.aliasRate)] = event.severity;
  row[getFieldName('message', rng, m.casingDrift, m.aliasRate)] = event.message;

  if (event.service) {
    row[getFieldName('service', rng, m.casingDrift, m.aliasRate)] = event.service;
  }

  // Add canonical attributes with possible aliasing and messification
  for (const [key, value] of Object.entries(event.attributes)) {
    if (rng() < m.nullRate) {
      row[key] = null;
      continue;
    }
    const fieldName = getFieldName(key, rng, m.casingDrift, m.aliasRate);
    row[fieldName] = messifyValue(rng, value, m.jsonEncodedRate);
  }

  // Add kubernetes/infrastructure noise
  const podSuffix = `${event.service ?? 'svc'}-${Math.random().toString(36).slice(2, 8)}`;
  row[getFieldName('pod', rng, m.casingDrift, m.aliasRate)] = podSuffix;
  row[getFieldName('namespace', rng, m.casingDrift, m.aliasRate)] = 'default';
  row[getFieldName('host', rng, m.casingDrift, m.aliasRate)] = `node-${pick(rng, ['a', 'b', 'c'])}`;
  row[getFieldName('trace_id', rng, m.casingDrift, m.aliasRate)] = crypto.randomUUID().replace(/-/g, '');
  row[getFieldName('region', rng, m.casingDrift, m.aliasRate)] = pick(rng, ['us-east-1', 'us-west-2', 'eu-west-1']);

  // Fill to target width with noise
  const currentWidth = Object.keys(row).length;
  const noise = generateNoiseFields(rng, targetWidth, currentWidth);
  Object.assign(row, noise);

  // Sprinkle nulls across non-essential fields
  for (const key of Object.keys(row)) {
    if (key === '_time' || key === getFieldName('message', rng, 0, 0)) continue;
    if (rng() < m.nullRate * 0.3) {
      row[key] = null;
    }
  }

  return row;
}

// ─── Background Noise Row Generation ─────────────────────────────────────

const BACKGROUND_MESSAGES = [
  'request completed successfully',
  'health check passed',
  'cache hit for session lookup',
  'connection pool stats reported',
  'metrics flushed',
  'config reload complete',
  'TLS handshake completed',
  'grpc stream opened',
  'worker heartbeat',
  'batch processing completed',
  'index refresh complete',
  'DNS resolution succeeded',
  'rate limiter check passed',
  'auth token validated',
  'feature flag evaluated',
  'middleware chain completed',
  'audit log written',
  'webhook delivery succeeded',
  'circuit breaker: closed',
  'scheduled task completed',
];

export function generateBackgroundRows(
  rng: () => number,
  seed: ScenarioSeed,
  datasets: string[],
  scenarioStart: Date,
  count: number,
): Map<string, LogRow[]> {
  const rows = new Map<string, LogRow[]>();
  for (const ds of datasets) rows.set(ds, []);

  for (let i = 0; i < count; i++) {
    const dataset = pick(rng, datasets);
    const offsetSec = Math.floor(rng() * seed.timeRangeMinutes * 60);
    const service = pick(rng, seed.topology.services);
    const event: BlueprintEvent = {
      tsOffsetSec: offsetSec,
      dataset,
      service,
      severity: pick(rng, ['info', 'info', 'info', 'debug', 'warn'] as const),
      message: pick(rng, BACKGROUND_MESSAGES),
      attributes: {
        status: pick(rng, [200, 200, 200, 201, 204]),
        latency_ms: Math.floor(rng() * 200) + 5,
      },
      role: 'background',
    };
    rows.get(dataset)!.push(messifyEvent(event, scenarioStart, rng, seed, 0));
  }

  return rows;
}

// ─── Metric Series Generation ────────────────────────────────────────────

export function generateMetricSeries(
  metric: BlueprintMetric,
  scenarioStart: Date,
  timeRangeMinutes: number,
  rng: () => number,
): MetricSeries {
  const stepSec = 60;
  const totalSteps = Math.floor(timeRangeMinutes * 60 / stepSec);
  const changeStep = Math.floor(metric.changeOffsetSec / stepSec);
  const startEpoch = Math.floor(scenarioStart.getTime() / 1000);
  const values: [number, number][] = [];

  for (let i = 0; i < totalSteps; i++) {
    const ts = startEpoch + i * stepSec;
    let value: number;

    const progress = i < changeStep ? 0 : Math.min(1, (i - changeStep) / Math.max(1, totalSteps - changeStep));

    switch (metric.shape) {
      case 'baseline':
        value = metric.baselineValue + (rng() - 0.5) * metric.baselineValue * 0.1;
        break;
      case 'spike':
        value = i >= changeStep && i < changeStep + 5
          ? metric.peakValue + (rng() - 0.5) * metric.peakValue * 0.05
          : metric.baselineValue + (rng() - 0.5) * metric.baselineValue * 0.1;
        break;
      case 'ramp':
        value = metric.baselineValue + (metric.peakValue - metric.baselineValue) * progress;
        value += (rng() - 0.5) * value * 0.05;
        break;
      case 'step_up':
        value = i < changeStep ? metric.baselineValue : metric.peakValue;
        value += (rng() - 0.5) * value * 0.03;
        break;
      case 'step_down':
        value = i < changeStep ? metric.peakValue : metric.baselineValue;
        value += (rng() - 0.5) * value * 0.03;
        break;
      case 'sawtooth':
        value = metric.baselineValue + (metric.peakValue - metric.baselineValue) * ((i % 10) / 10);
        break;
      default:
        value = metric.baselineValue;
    }

    values.push([ts, Math.round(value * 100) / 100]);
  }

  return {
    metric: metric.name,
    labels: metric.labels,
    values,
  };
}

// ─── Full Blueprint → Fixtures Expansion ─────────────────────────────────

export function expandBlueprint(
  blueprint: ScenarioBlueprint,
  variantIndex: number = 0,
): ScenarioFixtures {
  const seed = blueprint.seed;
  const rng = createRng(`${seed.id}-${variantIndex}`);

  const scenarioStart = new Date('2026-02-06T14:00:00Z');
  // Shift start time per variant
  scenarioStart.setMinutes(scenarioStart.getMinutes() + variantIndex * 30);

  // Group canonical events by dataset
  const datasetRows = new Map<string, LogRow[]>();
  for (const ds of blueprint.datasets) datasetRows.set(ds, []);

  for (const event of blueprint.events) {
    const ds = event.dataset;
    if (!datasetRows.has(ds)) datasetRows.set(ds, []);
    datasetRows.get(ds)!.push(messifyEvent(event, scenarioStart, rng, seed, variantIndex));
  }

  // Add background noise
  const noiseCount = seed.difficulty.signalBuriedness * 30 + 20;
  const backgroundRows = generateBackgroundRows(rng, seed, blueprint.datasets, scenarioStart, noiseCount);
  for (const [ds, rows] of backgroundRows) {
    if (!datasetRows.has(ds)) datasetRows.set(ds, []);
    datasetRows.get(ds)!.push(...rows);
  }

  // Sort all rows by _time
  for (const rows of datasetRows.values()) {
    rows.sort((a, b) => a._time.localeCompare(b._time));
  }

  // Build datasets record
  const datasets: Record<string, LogRow[]> = {};
  for (const [name, rows] of datasetRows) {
    datasets[name] = rows;
  }

  // Generate metrics
  const metrics: Record<string, MetricSeries[]> = {};
  for (const m of blueprint.metrics) {
    if (!metrics[m.name]) metrics[m.name] = [];
    metrics[m.name].push(
      generateMetricSeries(m, scenarioStart, seed.timeRangeMinutes, rng)
    );
  }

  return {
    datasets,
    metrics,
    datasources: blueprint.datasources.map(ds => ({
      uid: ds.uid,
      name: ds.name,
      type: ds.type,
    })),
    validDeployments: blueprint.deployments,
  };
}
