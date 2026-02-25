import { z } from 'zod';

/**
 * Parse Gemini judge output text against a scorer schema.
 */
export function parseJudgeOutput<T>(schema: z.ZodType<T>, text: string): T {
  const candidates = collectCandidates(text);

  for (const candidate of candidates) {
    const parsed = tryStrictParse(schema, candidate);
    if (parsed != null) {
      return parsed;
    }
  }

  for (const candidate of candidates) {
    const repaired = normalizeJsonish(candidate);
    if (repaired === candidate) continue;
    const parsed = tryStrictParse(schema, repaired);
    if (parsed != null) {
      return parsed;
    }
  }

  const salvaged = salvageBySchema(schema, candidates);
  if (salvaged != null) {
    return salvaged;
  }

  throw new Error('Gemini returned text but failed schema validation');
}

function tryStrictParse<T>(schema: z.ZodType<T>, text: string): T | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  try {
    const parsed = schema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function collectCandidates(text: string): string[] {
  const out = new Set<string>();
  const base = text.trim();
  if (base.length > 0) out.add(base);

  const stripped = stripCodeFences(base).trim();
  if (stripped.length > 0) out.add(stripped);

  for (const candidate of [...out]) {
    const objectSlice = sliceFirstJSONObject(candidate);
    if (objectSlice) out.add(objectSlice);
  }

  return [...out];
}

function stripCodeFences(text: string): string {
  return text
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```\s*/g, '')
    .replace(/^\s*json\s*/i, '');
}

function sliceFirstJSONObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  // Truncated response: return from first object start for best-effort salvage.
  return text.slice(start);
}

function normalizeJsonish(text: string): string {
  return stripCodeFences(text)
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
}

function salvageBySchema<T>(schema: z.ZodType<T>, candidates: string[]): T | null {
  if (!(schema instanceof z.ZodObject)) {
    return null;
  }

  const sources = candidates.length > 0 ? candidates : [''];
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const recovered: Record<string, unknown> = {};

  for (const [key, fieldSchema] of Object.entries(shape)) {
    const values = sources.flatMap((source) => extractValueCandidates(source, key));
    for (const value of values) {
      const parsed = fieldSchema.safeParse(value);
      if (parsed.success) {
        recovered[key] = parsed.data;
        break;
      }
    }
  }

  if (!('explanation' in recovered) && 'explanation' in shape) {
    const fallback = 'Recovered from malformed Gemini judge JSON';
    const explanation = shape.explanation.safeParse(fallback);
    if (explanation.success) {
      recovered.explanation = explanation.data;
    }
  }

  const parsed = schema.safeParse(recovered);
  return parsed.success ? parsed.data : null;
}

function extractValueCandidates(text: string, key: string): unknown[] {
  const escapedKey = escapeRegExp(key);
  const out: unknown[] = [];

  const numberMatch = text.match(new RegExp(`["']?${escapedKey}["']?\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'i'));
  if (numberMatch) {
    const num = Number(numberMatch[1]);
    if (Number.isFinite(num)) out.push(num);
  }

  const boolMatch = text.match(new RegExp(`["']?${escapedKey}["']?\\s*:\\s*(true|false)`, 'i'));
  if (boolMatch) {
    out.push(boolMatch[1].toLowerCase() === 'true');
  }

  const doubleQuoted = text.match(new RegExp(`["']?${escapedKey}["']?\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i'));
  if (doubleQuoted) {
    try {
      out.push(JSON.parse(`"${doubleQuoted[1]}"`));
    } catch {
      out.push(doubleQuoted[1]);
    }
  }

  const singleQuoted = text.match(new RegExp(`["']?${escapedKey}["']?\\s*:\\s*'((?:\\\\.|[^'\\\\])*)'`, 'i'));
  if (singleQuoted) {
    out.push(singleQuoted[1].replace(/\\'/g, "'"));
  }

  const lineValue = text.match(new RegExp(`["']?${escapedKey}["']?\\s*:\\s*([^\\n\\r}]*)`, 'i'));
  if (lineValue) {
    const normalized = normalizeLooseToken(lineValue[1]);
    if (normalized.length > 0) {
      out.push(normalized);
    }
  }

  return dedupeUnknown(out);
}

function normalizeLooseToken(raw: string): string {
  const token = raw.trim().replace(/,$/, '').trim();
  if (token.length === 0) return '';

  if (token.startsWith('"')) {
    return token.slice(1).replace(/"$/, '').trim();
  }
  if (token.startsWith("'")) {
    return token.slice(1).replace(/'$/, '').trim();
  }

  return token;
}

function dedupeUnknown(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const value of values) {
    const key = typeof value === 'string' ? `s:${value}` : JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
