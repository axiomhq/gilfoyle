import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput, ToolCall } from '../harness/types.js';
import { classifyQueryFailure, isQueryTool } from './query-error-classification.js';

type QueryYieldClass = 'productive' | 'empty' | 'invalid' | 'unknown';

export const QueryYieldScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'query-yield',
  ({ input, output }) => {
    const allowNoQueries = input.scenario.scoring?.allowNoQueries === true;
    const queryCalls = output.trace.toolCalls.filter(isQueryTool);

    if (queryCalls.length === 0) {
      return {
        score: allowNoQueries ? 1 : 0,
        metadata: {
          applicable: true,
          note: allowNoQueries ? 'No query calls expected for this scenario' : 'No query calls made',
          allowNoQueries,
          queryCalls: 0,
        },
      };
    }

    const classes = queryCalls.map(classifyQueryYield);
    const validCalls = classes.filter((c) => c !== 'invalid');
    if (validCalls.length === 0) {
      return {
        score: 0,
        metadata: {
          applicable: true,
          note: 'All query calls were invalid',
          allowNoQueries,
          queryCalls: queryCalls.length,
          classCounts: summarizeClasses(classes),
        },
      };
    }

    const productive = validCalls.filter((c) => c === 'productive').length;
    const score = productive / validCalls.length;

    return {
      score,
      metadata: {
        applicable: true,
        allowNoQueries,
        queryCalls: queryCalls.length,
        validCalls: validCalls.length,
        productiveCalls: productive,
        classCounts: summarizeClasses(classes),
      },
    };
  },
);

function classifyQueryYield(tc: ToolCall): QueryYieldClass {
  const failure = classifyQueryFailure(tc);
  if (failure.hasFailure) {
    return 'invalid';
  }

  const outputText = stringifyOutput(tc.output).toLowerCase();
  if (!outputText) {
    return 'unknown';
  }

  if (/\berror:/.test(outputText)) {
    return 'invalid';
  }
  if (/\(no results\)/.test(outputText)) {
    return 'empty';
  }

  const axiomRows = outputText.match(/#\s*(\d+)\s*\/\s*\d+\s+rows/);
  if (axiomRows) {
    return Number.parseInt(axiomRows[1] ?? '0', 10) > 0 ? 'productive' : 'empty';
  }

  const series = outputText.match(/\bseries:\s*(\d+)/);
  if (series) {
    return Number.parseInt(series[1] ?? '0', 10) > 0 ? 'productive' : 'empty';
  }

  if (/\bsamples:\s*[1-9]\d*/.test(outputText)) {
    return 'productive';
  }

  return 'unknown';
}

function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output == null) return '';
  try {
    return JSON.stringify(output);
  } catch {
    return '';
  }
}

function summarizeClasses(classes: QueryYieldClass[]): Record<QueryYieldClass, number> {
  const out: Record<QueryYieldClass, number> = {
    productive: 0,
    empty: 0,
    invalid: 0,
    unknown: 0,
  };
  for (const c of classes) {
    out[c]++;
  }
  return out;
}
