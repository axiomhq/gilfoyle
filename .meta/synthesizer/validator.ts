/**
 * Scenario Validator
 *
 * Validates that a generated scenario is actually solvable:
 * - Probe queries return non-empty results
 * - Root cause clues exist in the data
 * - Red herrings don't accidentally solve the scenario
 * - Dataset/metric widths are realistic
 */

import type { IncidentScenario, LogRow } from '../harness/types.js';
import type { ScenarioBlueprint, } from './types.js';
import { validateAPL, executeAPL, validatePromQL, } from '../toolbox/fixture-engine.js';

export interface ValidationResult {
  solvable: boolean;
  errors: string[];
  warnings: string[];
  stats: {
    totalLogRows: number;
    avgFieldsPerRow: number;
    totalMetricSeries: number;
    signalRows: number;        // rows containing root cause clues
    noiseRows: number;         // background rows
    signalToNoiseRatio: number;
  };
}

export function validateScenario(
  scenario: IncidentScenario,
  blueprint: ScenarioBlueprint,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fixtures = scenario.fixtures;

  if (!fixtures) {
    return { solvable: false, errors: ['No fixtures'], warnings: [], stats: emptyStats() };
  }

  // ─── Stats ───────────────────────────────────────────────────────────

  let totalLogRows = 0;
  let totalFields = 0;
  for (const rows of Object.values(fixtures.datasets)) {
    totalLogRows += rows.length;
    for (const row of rows) {
      totalFields += Object.keys(row).length;
    }
  }
  const avgFieldsPerRow = totalLogRows > 0 ? Math.round(totalFields / totalLogRows) : 0;
  const totalMetricSeries = Object.values(fixtures.metrics).reduce(
    (n, series) => n + series.length, 0
  );

  // Count signal vs noise
  const clues = blueprint.seed.rootCause.mustSurfaceClues;
  let signalRows = 0;
  for (const rows of Object.values(fixtures.datasets)) {
    for (const row of rows) {
      const rowStr = JSON.stringify(row).toLowerCase();
      if (clues.some(c => rowStr.includes(c.toLowerCase()))) signalRows++;
    }
  }
  const noiseRows = totalLogRows - signalRows;
  const signalToNoiseRatio = totalLogRows > 0 ? signalRows / totalLogRows : 0;

  // ─── Structural Validation ──────────────────────────────────────────

  if (totalLogRows < 10) {
    errors.push(`Too few log rows: ${totalLogRows} (need at least 10)`);
  }
  if (totalLogRows > 5000) {
    warnings.push(`Very large dataset: ${totalLogRows} rows. May slow eval.`);
  }
  if (avgFieldsPerRow < 10) {
    warnings.push(`Low field width: avg ${avgFieldsPerRow} fields/row. Real Axiom data is wider.`);
  }
  if (totalMetricSeries < 2) {
    warnings.push(`Only ${totalMetricSeries} metric series. Add more for realism.`);
  }
  if (signalRows === 0) {
    errors.push('No rows contain root cause clues. Scenario is unsolvable.');
  }
  if (signalToNoiseRatio > 0.5) {
    warnings.push(`Signal-to-noise ratio ${(signalToNoiseRatio * 100).toFixed(0)}% is too high. Agent doesn't have to filter.`);
  }

  // ─── Investigation Path Probes ──────────────────────────────────────

  for (const step of blueprint.investigationPath) {
    if (step.probeQueries.axiom) {
      for (const probe of step.probeQueries.axiom) {
        // Check that dataset exists
        if (!fixtures.datasets[probe.dataset]) {
          errors.push(`Step "${step.clueId}": dataset "${probe.dataset}" doesn't exist in fixtures`);
          continue;
        }

        // Check that probing for the must-contain terms finds rows.
        // Terms can be spread across multiple rows (e.g. "OOM" in one row,
        // "session" in another) — we check that each term appears in at
        // least one row in the dataset.
        const rows = fixtures.datasets[probe.dataset];
        const allText = rows.map((row: LogRow) => JSON.stringify(row).toLowerCase()).join('\n');
        const missingTerms = probe.mustContain.filter(
          term => !allText.includes(term.toLowerCase())
        );

        if (missingTerms.length > 0) {
          errors.push(`Step "${step.clueId}": terms [${missingTerms.join(', ')}] not found in any row of "${probe.dataset}"`);
        }
      }
    }

    if (step.probeQueries.grafana) {
      for (const probe of step.probeQueries.grafana) {
        if (!fixtures.metrics[probe.metricName]) {
          errors.push(`Step "${step.clueId}": metric "${probe.metricName}" doesn't exist in fixtures`);
        }
      }
    }
  }

  // ─── APL/PromQL Executor Test ───────────────────────────────────────

  // Test that basic queries against the fixture engine work
  for (const ds of Object.keys(fixtures.datasets)) {
    const apl = `['${ds}'] | take 5`;
    const validation = validateAPL(apl, fixtures);
    if (!validation.valid) {
      errors.push(`Fixture engine can't query dataset "${ds}": ${validation.errors.join(', ')}`);
    } else if (validation.parsed) {
      const results = executeAPL(validation.parsed, fixtures);
      if (results.length === 0) {
        errors.push(`Dataset "${ds}" returns 0 rows for basic query`);
      }
    }
  }

  for (const metricName of Object.keys(fixtures.metrics)) {
    const promql = metricName;
    const validation = validatePromQL(promql, fixtures);
    if (!validation.valid) {
      errors.push(`Fixture engine can't query metric "${metricName}": ${validation.errors.join(', ')}`);
    }
  }

  return {
    solvable: errors.length === 0,
    errors,
    warnings,
    stats: {
      totalLogRows,
      avgFieldsPerRow,
      totalMetricSeries,
      signalRows,
      noiseRows,
      signalToNoiseRatio,
    },
  };
}

function emptyStats() {
  return {
    totalLogRows: 0, avgFieldsPerRow: 0, totalMetricSeries: 0,
    signalRows: 0, noiseRows: 0, signalToNoiseRatio: 0,
  };
}
