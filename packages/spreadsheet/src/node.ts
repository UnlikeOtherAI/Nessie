import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

import { SPREADSHEET_ENGINE_VERSION } from '@nessie/schemas'

import { wrapNodeModel, wrapWasmModel, type SpreadsheetEngineModel } from './engine.js'
import { setFormulaTokenizer, type MarkedToken } from './formula-shift.js'

// Engine loading, kept in its own entry point so the browser bundle never pulls
// the native binding in. The pinned pair is @ironcalc/nodejs 0.8.3 (this file)
// and @ironcalc/wasm 0.8.4 (the admin, and `loadWasmModelForTests` below).

const require = createRequire(import.meta.url)

interface NodeBinding {
  UserModel: {
    new (name: string, locale?: string, timezone?: string, languageId?: string): object
    fromBytes(bytes: Uint8Array, languageId?: string): object
  }
}

let nodeBinding: NodeBinding | null = null

function binding(): NodeBinding {
  nodeBinding ??= require('@ironcalc/nodejs') as NodeBinding
  return nodeBinding
}

export function engineVersion(): string {
  return SPREADSHEET_ENGINE_VERSION
}

export function createNodeModel(name: string, locale = 'en', timezone = 'UTC', language = 'en'): SpreadsheetEngineModel {
  const { UserModel } = binding()
  return wrapNodeModel(new UserModel(name, locale, timezone, language) as never)
}

export function loadNodeModel(bytes: Uint8Array, language = 'en'): SpreadsheetEngineModel {
  const { UserModel } = binding()
  return wrapNodeModel(UserModel.fromBytes(bytes, language) as never)
}

interface WasmBinding {
  initSync: (input: { module: Buffer }) => void
  getTokens: (formula: string) => MarkedToken[]
  Model: new (name: string, locale: string, timezone: string, language: string) => object
}

let wasm: WasmBinding | null = null

/** One init per process; every wasm export throws before `initSync` has run. */
async function initWasm(): Promise<WasmBinding> {
  if (wasm) return wasm
  const loaded = (await import('@ironcalc/wasm')) as unknown as WasmBinding
  loaded.initSync({ module: readFileSync(require.resolve('@ironcalc/wasm/wasm_bg.wasm')) })
  wasm = loaded
  return loaded
}

/**
 * Register IronCalc's own lexer as the formula tokenizer `formula-shift.ts`,
 * `sort.ts` and `find.ts` rewrite formulas through. `getTokens` is a wasm-only
 * export — the Node binding does not have it — so a server process that sorts
 * or replaces inside formulas has to load the wasm module even though its
 * workbook lives in the Node binding. It is a one-off ~10 ms cost per process.
 */
export async function initFormulaTokenizer(): Promise<void> {
  const binding = await initWasm()
  setFormulaTokenizer((formula) => binding.getTokens(formula))
}

/** The browser engine, running under Node — used by the engine-pair test that
 *  keeps the two published versions honest with each other. */
export async function loadWasmModelForTests(name: string): Promise<SpreadsheetEngineModel> {
  const binding = await initWasm()
  return wrapWasmModel(new binding.Model(name, 'en', 'UTC', 'en') as never)
}

/** Every apply goes through here: un-paused, 200 000 diffs took 38 minutes
 *  against 164 ms paused. */
export function applyDiffsPaused(model: SpreadsheetEngineModel, diffs: Uint8Array): void {
  model.pauseEvaluation()
  try {
    model.applyExternalDiffs(diffs)
  } finally {
    model.resumeEvaluation()
  }
  model.evaluate()
}
