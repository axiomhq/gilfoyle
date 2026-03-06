const REQUIREMENT = 'Every scripts/axiom-query call must include an explicit time window via --since <duration> or --from <timestamp> --to <timestamp>. These wrapper flags are required even if the APL text also filters on _time.';

export interface AxiomTimeWindow {
  mode: 'since' | 'range';
  startTime: string;
  endTime: string;
  since?: string;
  from?: string;
  to?: string;
}

export interface ParsedAxiomQueryInput {
  deployment?: string;
  query?: string | null;
  timeWindow?: AxiomTimeWindow;
  errors: string[];
}

function looksLikeQuotedShellString(text: string): boolean {
  return text.length >= 2
    && ((text.startsWith('"') && text.endsWith('"'))
      || (text.startsWith('\'') && text.endsWith('\''))
      || (text.startsWith('`') && text.endsWith('`')));
}

function stripOuterQuotes(text: string): string {
  return looksLikeQuotedShellString(text) ? text.slice(1, -1) : text;
}

function splitHereString(text: string): { command: string; query: string | null } {
  const hereStringIndex = text.indexOf('<<<');
  if (hereStringIndex === -1) {
    return { command: text.trim(), query: null };
  }

  const command = text.slice(0, hereStringIndex).trim();
  const query = stripOuterQuotes(text.slice(hereStringIndex + 3).trim());
  return { command, query: query || null };
}

function tokenizeShell(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | '\'' | '`' | null = null;
  let escaping = false;

  for (const ch of text) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === '\\' && quote !== '\'') {
      escaping = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === '\'' || ch === '`') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

function normalizeSinceValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith('now') ? trimmed : `now-${trimmed}`;
}

function valueFromArg(arg: string, prefix: '--since=' | '--from=' | '--to='): string | null {
  return arg.startsWith(prefix) ? arg.slice(prefix.length).trim() : null;
}

export function parseAxiomTimeWindowArgs(args: string[]): { timeWindow?: AxiomTimeWindow; errors: string[] } {
  const errors: string[] = [];
  let since: string | undefined;
  let from: string | undefined;
  let to: string | undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;

    const inlineSince = valueFromArg(arg, '--since=');
    if (inlineSince != null) {
      since = inlineSince;
      continue;
    }

    const inlineFrom = valueFromArg(arg, '--from=');
    if (inlineFrom != null) {
      from = inlineFrom;
      continue;
    }

    const inlineTo = valueFromArg(arg, '--to=');
    if (inlineTo != null) {
      to = inlineTo;
      continue;
    }

    if (arg === '--since' || arg === '--from' || arg === '--to') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        errors.push(`Missing value for ${arg}`);
        continue;
      }
      if (arg === '--since') since = value;
      if (arg === '--from') from = value;
      if (arg === '--to') to = value;
      i += 1;
    }
  }

  if (since && (from || to)) {
    errors.push('Use either --since or --from/--to, not both');
  }

  if (!since && !from && !to) {
    errors.push('Missing time window. Pass --since <duration> or --from <timestamp> --to <timestamp>.');
  }

  if (!since && ((from && !to) || (!from && to))) {
    errors.push('Absolute windows require both --from and --to');
  }

  if (since?.trim()) {
    return {
      errors,
      timeWindow: {
        mode: 'since',
        since: since.trim(),
        startTime: normalizeSinceValue(since.trim()),
        endTime: 'now',
      },
    };
  }

  if (from?.trim() && to?.trim()) {
    return {
      errors,
      timeWindow: {
        mode: 'range',
        from: from.trim(),
        to: to.trim(),
        startTime: from.trim(),
        endTime: to.trim(),
      },
    };
  }

  return { errors };
}

function extractObjectQuery(input: Record<string, unknown>): string | null {
  const candidate = input.apl ?? input.query ?? input.stdin ?? input.command;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

function extractObjectWindow(input: Record<string, unknown>): AxiomTimeWindow | undefined {
  const startTime = typeof input.startTime === 'string' ? input.startTime.trim() : '';
  const endTime = typeof input.endTime === 'string' ? input.endTime.trim() : '';
  if (startTime && endTime) {
    return {
      mode: 'range',
      from: startTime,
      to: endTime,
      startTime,
      endTime,
    };
  }

  const since = typeof input.since === 'string' ? input.since.trim() : '';
  if (since) {
    return {
      mode: 'since',
      since,
      startTime: normalizeSinceValue(since),
      endTime: 'now',
    };
  }

  const from = typeof input.from === 'string' ? input.from.trim() : '';
  const to = typeof input.to === 'string' ? input.to.trim() : '';
  if (from && to) {
    return {
      mode: 'range',
      from,
      to,
      startTime: from,
      endTime: to,
    };
  }

  return undefined;
}

export function extractAxiomQuery(input: unknown): ParsedAxiomQueryInput {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return { errors: ['Missing command input'] };

    const { command, query } = splitHereString(trimmed);
    const tokens = tokenizeShell(command);
    if (tokens.length === 0) return { query, errors: ['Missing command input'] };

    const commandToken = tokens[0] ?? '';
    const args = /(^|\/)axiom-query$/.test(commandToken) ? tokens.slice(1) : tokens;
    const deployment = args[0];
    const window = parseAxiomTimeWindowArgs(args);
    return {
      deployment,
      query,
      timeWindow: window.timeWindow,
      errors: window.errors,
    };
  }

  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    const timeWindow = extractObjectWindow(record);
    return {
      deployment: typeof record.env === 'string'
        ? record.env
        : typeof record.deployment === 'string'
          ? record.deployment
          : undefined,
      query: extractObjectQuery(record),
      timeWindow,
      errors: timeWindow ? [] : ['Missing time window'],
    };
  }

  return { errors: ['Missing command input'] };
}

export function hasExplicitAxiomTimeBound(input: unknown): boolean {
  const parsed = extractAxiomQuery(input);
  return parsed.errors.length === 0 && parsed.timeWindow != null;
}

export function axiomTimeBoundError(): string {
  return REQUIREMENT;
}
