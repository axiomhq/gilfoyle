import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput, ToolCall } from '../harness/types.js';

/**
 * Memory Write Scorer (T03)
 *
 * Require ≥1 `scripts/mem-write` call. Validate category is one of
 * {facts, patterns, queries, incidents} and content length > 20 chars.
 * Bonus: at least one write before the final tool call.
 */

const VALID_CATEGORIES = ['facts', 'patterns', 'queries', 'incidents'];

export const MemoryWriteScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'memory-write',
  ({ input, output }) => {
    const required = input.scenario.scoring?.requireMemoryWrite ?? input.scenario.id !== 'first-run';
    if (!required) {
      return {
        score: 1,
        metadata: { applicable: false, note: 'Memory-write not required for this scenario' },
      };
    }

    const toolCalls = output.trace.toolCalls;
    const memWriteCalls = toolCalls.filter((tc: ToolCall) => tc.tool === 'scripts/mem-write');

    if (memWriteCalls.length === 0) {
      return {
        score: 0,
        metadata: { applicable: true, note: 'No mem-write calls made', totalCalls: toolCalls.length },
      };
    }

    // Parse mem-write calls to check category and content
    // Expected format: scripts/mem-write <category> <key> <content>
    // or with --org: scripts/mem-write --org <name> <category> <key> <content>
    const validWrites: { category: string; key: string; contentLength: number }[] = [];
    const invalidWrites: { input: string; reason: string }[] = [];

    for (const tc of memWriteCalls) {
      const inputStr = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input);
      const args = parseMemWriteInput(tc.input);
      if (!args) {
        invalidWrites.push({ input: inputStr.slice(0, 100), reason: 'Could not parse arguments' });
        continue;
      }

      const { category, key, content } = args;

      if (!VALID_CATEGORIES.includes(category)) {
        invalidWrites.push({
          input: inputStr.slice(0, 100),
          reason: `Invalid category '${category}'. Valid: ${VALID_CATEGORIES.join(', ')}`,
        });
        continue;
      }

      if (content.length < 20) {
        invalidWrites.push({
          input: inputStr.slice(0, 100),
          reason: `Content too short (${content.length} chars, need > 20)`,
        });
        continue;
      }

      validWrites.push({ category, key, contentLength: content.length });
    }

    if (validWrites.length === 0) {
      return {
        score: 0,
        metadata: {
          applicable: true,
          note: 'No valid mem-write calls',
          invalidWrites,
          totalMemWriteCalls: memWriteCalls.length,
        },
      };
    }

    // Check if at least one write happened before the last tool call
    const lastToolIndex = toolCalls.length - 1;
    const memWriteIndices = toolCalls
      .map((tc: ToolCall, i: number) => (tc.tool === 'scripts/mem-write' ? i : -1))
      .filter((i: number) => i >= 0);
    const hasWriteBeforeLast = memWriteIndices.some((i: number) => i < lastToolIndex);

    // Score: 70% for having valid writes, 30% bonus for writing before end
    const baseScore = 0.7;
    const bonusScore = hasWriteBeforeLast ? 0.3 : 0;
    const score = baseScore + bonusScore;

    return {
      score,
      metadata: {
        applicable: true,
        validWrites,
        invalidWrites,
        hasWriteBeforeLast,
        totalMemWriteCalls: memWriteCalls.length,
      },
    };
  }
);

function parseMemWriteInput(input: unknown): { category: string; key: string; content: string } | null {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const category = asString(obj.category);
    const key = asString(obj.key);
    const content = asString(obj.value ?? obj.content);
    if (category && key && content) {
      return { category, key, content };
    }
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const category = asString(parsed.category);
        const key = asString(parsed.key);
        const content = asString(parsed.value ?? parsed.content);
        if (category && key && content) {
          return { category, key, content };
        }
      } catch {
        // Fall back to CLI parser below.
      }
    }
    return parseMemWriteCliArgs(trimmed);
  }

  return null;
}

function parseMemWriteCliArgs(input: string): { category: string; key: string; content: string } | null {
  // Remove any leading script path (handles ./scripts/, bash scripts/, etc.)
  let cleaned = input.replace(/^(?:bash\s+)?(?:\.\/)?scripts\/mem-write\s*/, '').trim();

  // Handle --org flag
  if (cleaned.startsWith('--org')) {
    const orgMatch = cleaned.match(/^--org\s+\S+\s+(.+)/);
    if (orgMatch) {
      cleaned = orgMatch[1];
    } else {
      return null;
    }
  }

  // Split into category, key, content
  // Format: <category> <key> <content>
  // Content may be quoted or contain spaces
  const parts = cleaned.match(/^(\S+)\s+("[^"]+"|'[^']+'|\S+)\s+(.+)/);
  if (!parts) {
    // Try simpler split
    const simpleParts = cleaned.split(/\s+/);
    if (simpleParts.length >= 3) {
      return {
        category: simpleParts[0],
        key: simpleParts[1].replace(/^["']|["']$/g, ''),
        content: simpleParts.slice(2).join(' '),
      };
    }
    return null;
  }

  return {
    category: parts[1],
    key: parts[2].replace(/^["']|["']$/g, ''),
    content: parts[3],
  };
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
