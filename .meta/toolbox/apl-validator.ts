/**
 * APL Syntax Validator
 *
 * Loads the real Axiom APL parser compiled to WASM (via TinyGo)
 * and exposes a synchronous validation function.
 *
 * The WASM binary is built from axiom1's pkg/kirby/apl/parser/ast/v2.
 * See wasm/VERSION for the source commit and wasm/build.sh to rebuild.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_DIR = join(__dirname, 'wasm');

let initialized = false;
let validateFn: ((query: string) => { valid: boolean; error: string | null }) | null = null;

export async function initAPLValidator(): Promise<void> {
  if (initialized) return;

  // Load TinyGo's wasm_exec.js shim — it registers `Go` on globalThis
  await import(join(WASM_DIR, 'wasm_exec.js'));

  const go = new (globalThis as any).Go();
  const wasmBuf = readFileSync(join(WASM_DIR, 'apl-parser.wasm'));
  const result = await WebAssembly.instantiate(wasmBuf, go.importObject);
  go.run(result.instance);

  validateFn = (globalThis as any).ValidateAPL;
  if (!validateFn) throw new Error('ValidateAPL not found — WASM failed to initialize');
  initialized = true;
}

export interface APLSyntaxResult {
  valid: boolean;
  error: string | null;
}

export function validateAPLSyntax(query: string): APLSyntaxResult {
  if (!validateFn) {
    throw new Error('APL validator not initialized — call initAPLValidator() first');
  }
  return validateFn(query);
}
