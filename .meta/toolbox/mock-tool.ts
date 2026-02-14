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

interface ParsedInvocation {
  args: string[];
  fallbackQuery?: string;
  errors: string[];
}

function readQueryFile(path: string): { query?: string; error?: string } {
  const trimmed = path.trim();
  if (!trimmed) return { error: 'Missing query file path' };
  try {
    return { query: readFileSync(trimmed, 'utf-8').trim() };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { error: `Failed to read query file '${trimmed}': ${msg}` };
  }
}

function appendQuery(current: string | undefined, next: string): string {
  const value = next.trim();
  if (!value) return current ?? '';
  return current ? `${current} ${value}` : value;
}

function parseAxiomInvocation(rawArgs: string[]): ParsedInvocation {
  if (rawArgs.length === 0) return { args: rawArgs, errors: [] };

  const args: string[] = [rawArgs[0]];
  const errors: string[] = [];
  let fallbackQuery: string | undefined;

  for (let i = 1; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--query') {
      const value = rawArgs[i + 1];
      if (!value || value.startsWith('--')) {
        errors.push('Missing value for --query');
      } else {
        fallbackQuery = appendQuery(fallbackQuery, value);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--query=')) {
      fallbackQuery = appendQuery(fallbackQuery, arg.slice('--query='.length));
      continue;
    }
    if (arg === '--query-file') {
      const path = rawArgs[i + 1];
      if (!path || path.startsWith('--')) {
        errors.push('Missing value for --query-file');
      } else {
        const loaded = readQueryFile(path);
        if (loaded.error) errors.push(loaded.error);
        else if (loaded.query) fallbackQuery = appendQuery(fallbackQuery, loaded.query);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--query-file=')) {
      const loaded = readQueryFile(arg.slice('--query-file='.length));
      if (loaded.error) errors.push(loaded.error);
      else if (loaded.query) fallbackQuery = appendQuery(fallbackQuery, loaded.query);
      continue;
    }
    if (arg.startsWith('--')) {
      args.push(arg);
      continue;
    }
    fallbackQuery = appendQuery(fallbackQuery, arg);
  }

  return { args, fallbackQuery, errors };
}

function parseGrafanaInvocation(rawArgs: string[]): ParsedInvocation {
  if (rawArgs.length < 2) return { args: rawArgs, errors: [] };

  const args: string[] = [rawArgs[0], rawArgs[1]];
  const errors: string[] = [];
  let fallbackQuery: string | undefined;

  for (let i = 2; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--query') {
      const value = rawArgs[i + 1];
      if (!value || value.startsWith('--')) {
        errors.push('Missing value for --query');
      } else {
        fallbackQuery = appendQuery(fallbackQuery, value);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--query=')) {
      fallbackQuery = appendQuery(fallbackQuery, arg.slice('--query='.length));
      continue;
    }
    if (arg === '--query-file') {
      const path = rawArgs[i + 1];
      if (!path || path.startsWith('--')) {
        errors.push('Missing value for --query-file');
      } else {
        const loaded = readQueryFile(path);
        if (loaded.error) errors.push(loaded.error);
        else if (loaded.query) fallbackQuery = appendQuery(fallbackQuery, loaded.query);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--query-file=')) {
      const loaded = readQueryFile(arg.slice('--query-file='.length));
      if (loaded.error) errors.push(loaded.error);
      else if (loaded.query) fallbackQuery = appendQuery(fallbackQuery, loaded.query);
      continue;
    }
    if (arg.startsWith('--')) {
      args.push(arg);
      continue;
    }
    fallbackQuery = appendQuery(fallbackQuery, arg);
  }

  return { args, fallbackQuery, errors };
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
        const parsed = parseAxiomInvocation(toolArgs);
        if (parsed.errors.length > 0) {
          console.error(`error: ${parsed.errors.join('; ')}`);
          process.exit(1);
        }

        // Validate CLI contract
        const cliCheck = validateAxiomCLI(parsed.args, stdinQuery, fixtures, { fallbackQuery: parsed.fallbackQuery });
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
        const parsed = parseGrafanaInvocation(toolArgs);
        if (parsed.errors.length > 0) {
          console.error(`error: ${parsed.errors.join('; ')}`);
          process.exit(1);
        }

        // Validate CLI contract
        const cliCheck = validateGrafanaCLI(parsed.args, fixtures, { fallbackQuery: parsed.fallbackQuery });
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
      console.log(`https://app.axiom.co/acme/query?q=${encodeURIComponent(query)}&t=${range}`);
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
