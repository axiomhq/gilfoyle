#!/usr/bin/env bun
/**
 * Mock Tool v2 — Fixture-Driven
 *
 * Validates CLI contracts, parses APL/PromQL, and executes
 * queries against fixture data. Returns computed results,
 * not pre-baked answers.
 *
 * Falls back to legacy keyword matching if no fixtures present.
 */

import { readFileSync } from 'node:fs';
import type { ScenarioFixtures } from '../harness/types.js';
import {
  validateAPL, executeAPL, formatAxiomOutput,
  validatePromQL, executePromQL, formatGrafanaOutput,
  validateAxiomCLI, validateGrafanaCLI,
} from './fixture-engine.js';
import { initAllValidators } from './apl-validator.js';

const scriptName = process.argv[2] ?? 'unknown';
const toolArgs = process.argv.slice(3);
const scenarioFile = process.env.GILFOYLE_SCENARIO_FILE;

if (!scenarioFile) {
  console.error('error: GILFOYLE_SCENARIO_FILE not set');
  process.exit(1);
}

interface LegacyToolMock {
  when: { contains?: string[]; regex?: string };
  return: unknown;
}

interface Scenario {
  initOutput: string;
  toolMocks?: {
    axiom?: LegacyToolMock[];
    grafana?: LegacyToolMock[];
    slack?: LegacyToolMock[];
  };
  fixtures?: ScenarioFixtures;
}

function readStdin(): string {
  try { return readFileSync(0, 'utf-8').trim(); } catch { return ''; }
}

// Legacy fallback (for scenarios not yet migrated)
function matchMock(mocks: LegacyToolMock[] | undefined, queryText: string): unknown {
  if (!mocks || mocks.length === 0) return { error: 'No mock configured' };
  for (const mock of mocks) {
    if (mock.when.contains?.every(s => queryText.toLowerCase().includes(s.toLowerCase()))) return mock.return;
    if (mock.when.regex && new RegExp(mock.when.regex, 'i').test(queryText)) return mock.return;
  }
  return { error: 'No mock matched query', query: queryText.slice(0, 200) };
}

try {
  await initAllValidators();
  const scenario: Scenario = JSON.parse(readFileSync(scenarioFile, 'utf-8'));
  const fixtures = scenario.fixtures;

  switch (scriptName) {
    case 'scripts-init':
      console.log(scenario.initOutput);
      break;

    case 'scripts-axiom-query': {
      const stdinQuery = readStdin();

      if (fixtures) {
        // Validate CLI contract
        const cliCheck = validateAxiomCLI(toolArgs, stdinQuery, fixtures);
        if (!cliCheck.valid) {
          console.error(`error: ${cliCheck.errors.join('; ')}`);
          process.exit(1);
        }

        const aplCheck = validateAPL(stdinQuery, fixtures);
        if (!aplCheck.valid) {
          console.error(`error: ${aplCheck.errors.join('; ')}`);
          process.exit(1);
        }

        const results = executeAPL(aplCheck.parsed!, fixtures);
        const totalRows = fixtures.datasets[aplCheck.parsed!.dataset]?.length ?? 0;
        console.log(formatAxiomOutput(results, totalRows));
      } else {
        // Legacy fallback
        const result = matchMock(scenario.toolMocks?.axiom, stdinQuery);
        console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
      }
      break;
    }

    case 'scripts-grafana-query': {
      if (fixtures) {
        // Validate CLI contract
        const cliCheck = validateGrafanaCLI(toolArgs, fixtures);
        if (!cliCheck.valid) {
          console.error(`error: ${cliCheck.errors.join('; ')}`);
          process.exit(1);
        }

        // Validate and execute PromQL
        const promqlCheck = validatePromQL(cliCheck.query!, fixtures);
        if (!promqlCheck.valid) {
          console.error(`error: ${promqlCheck.errors.join('; ')}`);
          process.exit(1);
        }

        const series = executePromQL(cliCheck.query!, fixtures);
        console.log(formatGrafanaOutput(series, cliCheck.deployment!, cliCheck.datasourceUid!, cliCheck.query!));
      } else {
        // Legacy fallback
        const promql = toolArgs[2] ?? toolArgs.join(' ');
        const result = matchMock(scenario.toolMocks?.grafana, promql);
        console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
      }
      break;
    }

    case 'scripts-slack': {
      if (fixtures) {
        console.log(JSON.stringify({ ok: true, ts: `${Date.now()}.000100` }));
      } else {
        const method = toolArgs[1] ?? toolArgs.join(' ');
        const result = matchMock(scenario.toolMocks?.slack, method);
        console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
      }
      break;
    }

    case 'scripts-mem-write':
      console.log(JSON.stringify({ ok: true }));
      break;

    case 'scripts-rollback': {
      const version = toolArgs[1] ?? 'previous';
      const service = toolArgs[0] ?? 'unknown';
      console.log(JSON.stringify({ ok: true, rolled_back_to: version, service, message: `Rolled back ${service} to ${version}` }));
      break;
    }

    case 'scripts-flag-revert': {
      const flag = toolArgs[0] ?? 'unknown';
      console.log(JSON.stringify({ ok: true, reverted: flag, message: `Reverted feature flag: ${flag}` }));
      break;
    }

    case 'scripts-axiom-link': {
      const query = toolArgs[0] ?? '';
      const range = toolArgs[1] ?? '1h';
      console.log(`https://app.axiom.co/acme/explorer?q=${encodeURIComponent(query)}&t=${range}`);
      break;
    }

    default:
      console.error(`error: Unknown tool: ${scriptName}`);
      process.exit(1);
  }
} catch (e) {
  console.error(`error: ${e}`);
  process.exit(1);
}
