import { analyzeAPL, type APLAnalysisResult } from './apl-validator.js';

const REQUIREMENT = 'Every Axiom APL query that scans datasets must include an explicit _time bound. Use where _time between (...), where _time > ago(...), or another explicit _time comparison. trace_id/session_id/thread_ts/getschema are not substitutes.';

function looksLikeQuotedShellString(text: string): boolean {
  return text.length >= 2
    && ((text.startsWith('"') && text.endsWith('"'))
      || (text.startsWith('\'') && text.endsWith('\'')));
}

function stripOuterQuotes(text: string): string {
  return looksLikeQuotedShellString(text) ? text.slice(1, -1) : text;
}

function extractHereStringQuery(text: string): string | null {
  const hereStringIndex = text.indexOf('<<<');
  if (hereStringIndex === -1) return null;

  const candidate = text.slice(hereStringIndex + 3).trim();
  if (!candidate) return null;
  return stripOuterQuotes(candidate);
}

function extractObjectQuery(input: Record<string, unknown>): string | null {
  const candidate = input.apl ?? input.query ?? input.stdin ?? input.command;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

export function extractAxiomQuery(input: unknown): string | null {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return null;
    return extractHereStringQuery(trimmed) ?? trimmed;
  }

  if (input && typeof input === 'object') {
    return extractObjectQuery(input as Record<string, unknown>);
  }

  return null;
}

export function analyzeAxiomQueryTimeBounds(query: string): APLAnalysisResult {
  return analyzeAPL(query.trim());
}

export function hasExplicitAxiomTimeBound(input: unknown): boolean {
  const query = extractAxiomQuery(input);
  if (!query) return false;

  const analysis = analyzeAxiomQueryTimeBounds(query);
  return analysis.valid && (!analysis.requiresTimeBound || analysis.hasExplicitTimeBound);
}

export function axiomTimeBoundError(): string {
  return REQUIREMENT;
}
