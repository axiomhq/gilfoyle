import type { ToolCall } from '../harness/types.js';

export const QUERY_TOOLS = new Set(['scripts/axiom-query', 'scripts/grafana-query']);

export type QueryFailureKind =
  | 'none'
  | 'syntax'
  | 'executor_unsupported'
  | 'contract'
  | 'unknown_target'
  | 'shell'
  | 'runtime';

export type QueryFailure = {
  hasFailure: boolean;
  kind: QueryFailureKind;
  message: string;
};

const PATTERNS: Record<Exclude<QueryFailureKind, 'none'>, RegExp[]> = {
  syntax: [/\bapl syntax error\b/i, /\bpromql syntax error\b/i],
  executor_unsupported: [/\bunsupported apl stage\b/i, /\bnot supported\b/i],
  contract: [
    /\bunknown deployment\b/i,
    /\bunknown datasource\b/i,
    /\bunknown flag\b/i,
    /\bmissing arguments?\b/i,
    /\bno query provided via stdin\b/i,
    /\busage:\s+(?:axiom-query|grafana-query)\b/i,
  ],
  unknown_target: [/\bunknown dataset\b/i, /\bunknown metric\b/i],
  shell: [
    /^zsh:/im,
    /^bash:/im,
    /command not found/i,
    /no such file or directory/i,
    /permission denied/i,
    /command too long/i,
  ],
  runtime: [/\berror:/i, /\btimeout\b/i, /\btrace_id\b/i, /\bexception\b/i],
};

export function isQueryTool(tc: ToolCall): boolean {
  return QUERY_TOOLS.has(tc.tool);
}

export function classifyQueryFailure(tc: ToolCall): QueryFailure {
  if (!isQueryTool(tc)) {
    return { hasFailure: false, kind: 'none', message: '' };
  }

  const message = getErrorText(tc);
  const normalized = message.toLowerCase();
  const hasErrorSignal = tc.queryValid === false || normalized.includes('error:') || /^zsh:|^bash:/im.test(message);
  if (!hasErrorSignal && !message.trim()) {
    return { hasFailure: false, kind: 'none', message: '' };
  }

  for (const kind of ['syntax', 'executor_unsupported', 'contract', 'unknown_target', 'shell'] as const) {
    if (PATTERNS[kind].some((p) => p.test(message))) {
      return { hasFailure: true, kind, message };
    }
  }

  if (PATTERNS.runtime.some((p) => p.test(message))) {
    return { hasFailure: true, kind: 'runtime', message };
  }

  if (tc.queryValid === false) {
    return { hasFailure: true, kind: 'runtime', message: message || 'query marked invalid' };
  }

  return { hasFailure: false, kind: 'none', message };
}

function getErrorText(tc: ToolCall): string {
  const parts: string[] = [];

  if (tc.queryErrors && tc.queryErrors.length > 0) {
    parts.push(tc.queryErrors.join('; '));
  }

  if (typeof tc.output === 'string') {
    parts.push(tc.output);
  } else if (tc.output != null) {
    try {
      parts.push(JSON.stringify(tc.output));
    } catch {
      // ignore stringify errors
    }
  }

  if (parts.length === 0 && tc.error) {
    parts.push(tc.error);
  }

  return parts.join(' \n ').trim();
}
