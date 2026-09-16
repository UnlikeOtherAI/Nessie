import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

import { SPREADSHEET_ENGINE_VERSION } from '@nessie/schemas'

import { wrapNodeModel, wrapWasmModel, type SpreadsheetEngineModel } from './engine.js'

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

let wasmReady = false

/** The browser engine, running under Node — used by the engine-pair test that
 *  keeps the two published versions honest with each other. */
export async function loadWasmModelForTests(name: string): Promise<SpreadsheetEngineModel> {
  const wasm = (await import('@ironcalc/wasm')) as unknown as {
    initSync: (input: { module: Buffer }) => void
    Model: new (name: string, locale: string, timezone: string, language: string) => object
  }
  if (!wasmReady) {
    wasm.initSync({ module: readFileSync(require.resolve('@ironcalc/wasm/wasm_bg.wasm')) })
    wasmReady = true
  }
  return wrapWasmModel(new wasm.Model(name, 'en', 'UTC', 'en') as never)
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
