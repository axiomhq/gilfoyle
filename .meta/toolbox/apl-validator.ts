/**
 * Query Syntax Validators
 *
 * Loads the real Axiom APL parser and Prometheus PromQL parser,
 * both compiled to WASM, and exposes synchronous validation functions.
 *
 * APL: built from axiom1's pkg/kirby/apl/parser/ast/v2 (TinyGo)
 * PromQL: built from github.com/prometheus/prometheus/promql/parser (Go)
 *
 * See wasm/VERSION for source commits and wasm/build.sh to rebuild.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_DIR = join(__dirname, 'wasm');

export interface SyntaxResult {
  valid: boolean;
  error: string | null;
}

type ValidateFn = (query: string) => SyntaxResult;

let aplValidateFn: ValidateFn | null = null;
let promqlValidateFn: ValidateFn | null = null;
let aplInitialized = false;
let promqlInitialized = false;

async function loadWasm(wasmFile: string, shimFile: string, globalName: string): Promise<ValidateFn> {
  await import(join(WASM_DIR, shimFile));
  const go = new (globalThis as any).Go();
  const wasmBuf = readFileSync(join(WASM_DIR, wasmFile));
  const result = await WebAssembly.instantiate(wasmBuf, go.importObject);
  go.run(result.instance);
  const fn = (globalThis as any)[globalName];
  if (!fn) throw new Error(`${globalName} not found — WASM failed to initialize`);
  return fn;
}

export async function initAPLValidator(): Promise<void> {
  if (aplInitialized) return;
  aplValidateFn = await loadWasm('apl-parser.wasm', 'wasm_exec.js', 'ValidateAPL');
  aplInitialized = true;
}

export async function initPromQLValidator(): Promise<void> {
  if (promqlInitialized) return;
  promqlValidateFn = await loadWasm('promql-parser.wasm', 'wasm_exec_go.js', 'ValidatePromQL');
  promqlInitialized = true;
}

export async function initAllValidators(): Promise<void> {
  await Promise.all([initAPLValidator(), initPromQLValidator()]);
}

export function validateAPLSyntax(query: string): SyntaxResult {
  if (!aplValidateFn) throw new Error('APL validator not initialized — call initAPLValidator() first');
  return aplValidateFn(query);
}

export function validatePromQLSyntax(query: string): SyntaxResult {
  if (!promqlValidateFn) throw new Error('PromQL validator not initialized — call initPromQLValidator() first');
  return promqlValidateFn(query);
}
