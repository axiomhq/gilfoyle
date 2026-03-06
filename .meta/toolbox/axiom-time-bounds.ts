const BETWEEN_RE = /\bwhere\s+_time\s+between\s*\(/i;
const AGO_WINDOW_RE = /\bwhere\s+_time\s*(>=|>)\s*ago\s*\(/i;
const MAKE_SERIES_RE = /\bmake-series\b.*\bon\s+_time\s+from\s+(ago\s*\(|datetime\s*\().*\bto\s+(ago\s*\(|datetime\s*\(|now\s*\()/i;
const LOWER_BOUND_RE = /\b_time\s*(>=|>)\s*(ago\s*\(|datetime\s*\()/i;
const UPPER_BOUND_RE = /\b_time\s*(<=|<)\s*(ago\s*\(|datetime\s*\(|now\s*\()/i;

export function normalizeAxiomTimeBoundInput(input: string): string {
  return input
    .replace(/[\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

export function hasExplicitAxiomTimeBound(input: string): boolean {
  const compact = normalizeAxiomTimeBoundInput(input);

  if (BETWEEN_RE.test(compact)) return true;
  if (AGO_WINDOW_RE.test(compact)) return true;
  if (MAKE_SERIES_RE.test(compact)) return true;

  return LOWER_BOUND_RE.test(compact) && UPPER_BOUND_RE.test(compact);
}

export function axiomTimeBoundError(): string {
  return 'Every Axiom APL query must include an explicit _time bound. Use where _time > ago(...), where _time between (...), or a bounded make-series window. trace_id/session_id/thread_ts/getschema are not substitutes.';
}
