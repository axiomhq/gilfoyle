import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput, ToolName } from '../harness/types.js';

/**
 * Discover First Scorer
 *
 * Checks whether the agent runs tool discovery (scripts/discover-*)
 * BEFORE issuing queries to that tool. Progressive discovery contract:
 * discover assets before querying them.
 *
 * Score 1.0 — every queried tool had discovery called first
 * Score 0.5 — some tools had discovery first, others didn't
 * Score 0.0 — agent jumped straight to querying without discovery
 *
 * Add new tool pairs here as query tools are added to the eval.
 */

const DISCOVER_TO_QUERY: Partial<Record<ToolName, ToolName[]>> = {
  'scripts/discover-axiom': ['scripts/axiom-query'],
  'scripts/discover-grafana': ['scripts/grafana-query'],
  // Future: 'scripts/discover-pyroscope': ['scripts/pyroscope-diff'],
  // Future: 'scripts/discover-slack': ['scripts/slack'],
};

// Invert: for each query tool, which discovery tool is required?
const TOOL_PAIRS: [ToolName, ToolName][] = Object.entries(DISCOVER_TO_QUERY).flatMap(
  ([discover, queryTools]) =>
    (queryTools ?? []).map((query): [ToolName, ToolName] => [discover as ToolName, query]),
);

export const DiscoverFirstScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'discover-first',
  ({ input, output }) => {
    const allowNoQueries = input.scenario.scoring?.allowNoQueries === true;
    const toolCalls = output.trace.toolCalls;

    if (toolCalls.length === 0) {
      return {
        score: allowNoQueries ? 1 : 0,
        metadata: {
          note: allowNoQueries ? 'No queries expected' : 'No tool calls made',
          allowNoQueries,
        },
      };
    }

    const results: { tool: string; discoveredFirst: boolean }[] = [];

    for (const [discoverTool, queryTool] of TOOL_PAIRS) {
      const queryIndices = toolCalls
        .map((tc, i) => tc.tool === queryTool ? i : -1)
        .filter((i) => i >= 0);

      if (queryIndices.length === 0) continue; // tool not used, skip

      const firstQueryIndex = queryIndices[0];
      const discoverIndex = toolCalls.findIndex((tc) => tc.tool === discoverTool);
      const discoveredFirst = discoverIndex >= 0 && discoverIndex < firstQueryIndex;

      results.push({ tool: queryTool, discoveredFirst });
    }

    if (results.length === 0) {
      return {
        score: allowNoQueries ? 1 : 1,
        metadata: {
          note: 'No query tools used that require discovery',
          allowNoQueries,
        },
      };
    }

    const discovered = results.filter((r) => r.discoveredFirst).length;
    const total = results.length;

    let score: number;
    if (discovered === total) {
      score = 1;
    } else if (discovered > 0) {
      score = 0.5;
    } else {
      score = 0;
    }

    return {
      score,
      metadata: {
        note: score === 1
          ? 'Discovery before querying on all tools'
          : score === 0.5
            ? 'Mixed — some tools discovered first, others not'
            : 'Agent queried without discovering first',
        toolsTotal: total,
        discoveredFirst: discovered,
        skippedDiscovery: total - discovered,
        details: Object.fromEntries(results.map((r) => [r.tool, r.discoveredFirst ? 'discovered' : 'skipped'])),
      },
    };
  },
);
