import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput } from '../harness/types.js';

/**
 * Schema First Scorer
 *
 * Checks whether the agent runs schema discovery (getschema, | take 1,
 * | distinct) on a dataset BEFORE issuing filter queries with field
 * conditions. Good SRE practice: understand the shape of data before
 * filtering on it.
 *
 * Score 1.0 — every dataset had discovery before filtering
 * Score 0.5 — some datasets had discovery first, others didn't
 * Score 0.0 — agent jumped straight to filtering on all datasets
 */

const DATASET_RE = /\['([^']+)'\]/;
const SCHEMA_DISCOVERY_RE = /\bgetschema\b|\|\s*take\s+1\b|\|\s*distinct\b/i;
// Matches `where <field> <op>` but ignores bare `where _time` since time
// scoping is not a field filter — it's just a time range.
const FILTER_RE = /\|\s*where\s+(?!_time\b)\w+/i;

export const SchemaFirstScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'schema-first',
  ({ input, output }) => {
    const allowNoQueries = input.scenario.scoring?.allowNoQueries === true;
    const toolCalls = output.trace.toolCalls;
    const axiomCalls = toolCalls.filter((tc) => tc.tool === 'scripts/axiom-query');

    if (axiomCalls.length === 0) {
      return {
        score: allowNoQueries ? 1 : 0,
        metadata: {
          note: allowNoQueries ? 'No queries expected for this scenario' : 'No axiom-query calls made',
          allowNoQueries,
        },
      };
    }

    // Track per-dataset: was the first query a discovery or a filter?
    const firstQueryKind = new Map<string, 'discovery' | 'filter'>();

    for (const tc of axiomCalls) {
      const inputStr = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input);
      const datasetMatch = inputStr.match(DATASET_RE);
      if (!datasetMatch) continue;

      const dataset = datasetMatch[1];
      if (firstQueryKind.has(dataset)) continue; // already classified

      const isDiscovery = SCHEMA_DISCOVERY_RE.test(inputStr);
      const isFilter = FILTER_RE.test(inputStr);

      if (isDiscovery) {
        firstQueryKind.set(dataset, 'discovery');
      } else if (isFilter) {
        firstQueryKind.set(dataset, 'filter');
      }
      // If neither (e.g. `| count`), skip — not a violation, not discovery
    }

    if (firstQueryKind.size === 0) {
      return {
        score: 1,
        metadata: { note: 'No dataset queries matched classification patterns' },
      };
    }

    const datasets = [...firstQueryKind.entries()];
    const discoveryFirst = datasets.filter(([, kind]) => kind === 'discovery').length;
    const filterFirst = datasets.filter(([, kind]) => kind === 'filter').length;
    const total = datasets.length;

    let score: number;
    if (filterFirst === 0) {
      score = 1;
    } else if (discoveryFirst > 0) {
      score = 0.5;
    } else {
      score = 0;
    }

    return {
      score,
      metadata: {
        note: score === 1
          ? 'Schema discovery before filtering on all datasets'
          : score === 0.5
            ? 'Mixed — some datasets had discovery first, others did not'
            : 'Agent jumped straight to filtering on all datasets',
        datasetsTotal: total,
        discoveryFirst,
        filterFirst,
        details: Object.fromEntries(datasets),
      },
    };
  }
);
