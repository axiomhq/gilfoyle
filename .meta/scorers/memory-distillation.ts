import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput, ToolCall } from '../harness/types.js';

/**
 * Memory Distillation Scorer (T11)
 *
 * Require mem-write calls across all three knowledge categories:
 *   - incidents (30%)
 *   - facts (30%)
 *   - queries (30%)
 * Bonus 10%: at least one saved query matches an actual axiom-query or
 * grafana-query tool call input.
 */

const QUERY_TOOLS = ['scripts/axiom-query', 'scripts/grafana-query'] as const;

export const MemoryDistillationScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'memory-distillation',
  ({ output }) => {
    const toolCalls = output.trace.toolCalls;
    const memWriteCalls = toolCalls.filter((tc: ToolCall) => tc.tool === 'scripts/mem-write');

    if (memWriteCalls.length === 0) {
      return {
        score: 0,
        metadata: { note: 'No mem-write calls made', totalCalls: toolCalls.length },
      };
    }

    const categoriesFound = new Set<string>();
    const queryWrites: string[] = [];

    for (const tc of memWriteCalls) {
      const inputStr = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input);
      const args = parseMemWriteArgs(inputStr);
      if (!args) continue;

      const { category, content } = args;

      if (category === 'incidents') categoriesFound.add('incidents');
      if (category === 'facts') categoriesFound.add('facts');
      if (category === 'queries') {
        categoriesFound.add('queries');
        queryWrites.push(content);
      }
    }

    let score = 0;
    if (categoriesFound.has('incidents')) score += 0.3;
    if (categoriesFound.has('facts')) score += 0.3;
    if (categoriesFound.has('queries')) score += 0.3;

    // Bonus: check if any saved query matches an actual query tool call
    let queryMatchFound = false;
    if (queryWrites.length > 0) {
      const actualQueries = toolCalls
        .filter((tc: ToolCall) => (QUERY_TOOLS as readonly string[]).includes(tc.tool))
        .map((tc: ToolCall) => {
          const s = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input);
          return normalize(s);
        });

      for (const saved of queryWrites) {
        const normalizedSaved = normalize(saved);
        if (normalizedSaved.length < 10) continue;
        for (const actual of actualQueries) {
          if (actual.includes(normalizedSaved) || normalizedSaved.includes(actual)) {
            queryMatchFound = true;
            break;
          }
        }
        if (queryMatchFound) break;
      }
    }

    if (queryMatchFound) score += 0.1;

    return {
      score: Math.min(1, score),
      metadata: {
        categoriesFound: [...categoriesFound],
        queryWrites: queryWrites.length,
        queryMatchFound,
        totalMemWriteCalls: memWriteCalls.length,
      },
    };
  }
);

function normalize(s: string): string {
  return s.toLowerCase().replace(/["']/g, '').replace(/\s+/g, ' ').trim();
}

function parseMemWriteArgs(input: string): { category: string; key: string; content: string } | null {
  let cleaned = input.replace(/^(?:bash\s+)?(?:\.\/)?scripts\/mem-write\s*/, '').trim();

  if (cleaned.startsWith('--org')) {
    const orgMatch = cleaned.match(/^--org\s+\S+\s+(.+)/);
    if (orgMatch) cleaned = orgMatch[1];
    else return null;
  }

  const parts = cleaned.match(/^(\S+)\s+("[^"]+"|'[^']+'|\S+)\s+(.+)/);
  if (!parts) {
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
