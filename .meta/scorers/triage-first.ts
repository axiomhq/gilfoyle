import { Scorer } from 'axiom/ai/evals';
import type { EvalInput, EvalOutput } from '../harness/types.js';

/**
 * Triage First Scorer (T09)
 *
 * For P1 incidents, mitigation must come before investigation.
 * You stop the bleeding, then figure out why it's bleeding.
 *
 * Scoring:
 *   50% — Mitigation (rollback/flag-revert) within first 3 tool calls after init
 *   30% — Slack announce before any investigation queries
 *   20% — Correct overall ordering: init → {slack, mitigation} → investigation
 */

const MITIGATION_TOOLS = new Set(['scripts/rollback', 'scripts/flag-revert']);
const INVESTIGATION_TOOLS = new Set(['scripts/axiom-query', 'scripts/grafana-query']);

export const TriageFirstScorer = Scorer<{
  input: EvalInput;
  output: EvalOutput;
  expected: { rootCause: string; evidence: string[] };
}>(
  'triage-first',
  ({ input, output }) => {
    if (input.scenario.severity !== 'P1') {
      return {
        score: 1,
        metadata: { applicable: false, note: 'Not a P1 scenario, triage-first not applicable' },
      };
    }

    const toolCalls = output.trace.toolCalls;

    if (toolCalls.length === 0) {
      return {
        score: 0,
        metadata: { applicable: true, note: 'No tool calls made', violation: 'no-calls' },
      };
    }

    let score = 0;
    const details: Record<string, unknown> = {};

    // --- 50%: Mitigation within first 3 tool calls after init ---
    const postInit = toolCalls.slice(
      toolCalls[0]?.tool === 'scripts/init' ? 1 : 0
    );
    const firstThree = postInit.slice(0, 3);
    const earlyMitigation = firstThree.some(tc =>
      MITIGATION_TOOLS.has(tc.tool)
    );

    if (earlyMitigation) {
      score += 0.5;
      details.earlyMitigation = true;
    } else {
      details.earlyMitigation = false;
      details.firstThreeAfterInit = firstThree.map(tc => tc.tool);
    }

    // --- 30%: Slack before any investigation query ---
    const slackIdx = toolCalls.findIndex(tc => tc.tool === 'scripts/slack');
    const firstInvestigationIdx = toolCalls.findIndex(tc =>
      INVESTIGATION_TOOLS.has(tc.tool)
    );

    if (slackIdx !== -1 && (firstInvestigationIdx === -1 || slackIdx < firstInvestigationIdx)) {
      score += 0.3;
      details.slackBeforeInvestigation = true;
    } else {
      details.slackBeforeInvestigation = false;
      details.slackIdx = slackIdx;
      details.firstInvestigationIdx = firstInvestigationIdx;
    }

    // --- 20%: Correct overall ordering ---
    // Valid orderings:
    //   init → slack → mitigation → investigation
    //   init → mitigation → slack → investigation
    // Key invariant: both slack and mitigation come before investigation
    const mitigationIdx = toolCalls.findIndex(tc =>
      MITIGATION_TOOLS.has(tc.tool)
    );
    const initIdx = toolCalls.findIndex(tc => tc.tool === 'scripts/init');

    const initOk = initIdx === 0 || initIdx === -1;
    const mitigationBeforeInvestigation =
      mitigationIdx !== -1 &&
      (firstInvestigationIdx === -1 || mitigationIdx < firstInvestigationIdx);
    const slackBeforeInvestigation =
      slackIdx !== -1 &&
      (firstInvestigationIdx === -1 || slackIdx < firstInvestigationIdx);

    if (initOk && mitigationBeforeInvestigation && slackBeforeInvestigation) {
      score += 0.2;
      details.correctOrdering = true;
    } else {
      details.correctOrdering = false;
      details.ordering = { initIdx, slackIdx, mitigationIdx, firstInvestigationIdx };
    }

    return {
      score,
      metadata: {
        applicable: true,
        note: score >= 0.8
          ? 'Triage-first discipline maintained'
          : `Triage-first violations detected (score: ${score})`,
        ...details,
      },
    };
  }
);
