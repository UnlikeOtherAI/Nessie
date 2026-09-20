import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  OllamaObservationError,
  assertLocalOllamaResult,
  isStructurallyLocalOllamaModel,
  observeOllamaInventory,
} from '../src/ollama-observed.js'
import type { OllamaFetch } from '../src/ollama-client.js'

const DIGEST = 'a'.repeat(64)

const json = (value: unknown): Response => new Response(JSON.stringify(value), {
  headers: { 'content-type': 'application/json' },
})

const inventoryFetch = (remote = false): OllamaFetch => (url) => {
  if (url.endsWith('/api/version')) return Promise.resolve(json({ version: '0.34.1' }))
  if (url.endsWith('/api/tags')) {
    return Promise.resolve(json({ models: [{
      digest: DIGEST,
      name: remote ? 'looks-local:latest' : 'local:latest',
      ...(remote ? { remote_host: 'cloud.ollama.com' } : {}),
      size: 123,
    }] }))
  }
  return Promise.resolve(json({
    capabilities: ['completion', 'tools'],
    details: { family: 'gemma' },
    model_info: { 'general.context_length': 8192 },
    ...(remote ? { remote_model: 'gemma3:cloud' } : {}),
  }))
}

test('observes installed models through tags and show without mutating Ollama', async () => {
  const inventory = await observeOllamaInventory(undefined, inventoryFetch())
  assert.equal(inventory.models.length, 1)
  const [model] = inventory.models
  assert.ok(model)
  assert.equal(model.manifestDigest, DIGEST)
  assert.equal(model.remoteHost, null)
  assert.equal(model.remoteModel, null)
  assert.equal(isStructurallyLocalOllamaModel(model), true)
})

test('a cloud marker wins over a friendly local-looking model name', async () => {
  const inventory = await observeOllamaInventory(undefined, inventoryFetch(true))
  const [model] = inventory.models
  assert.ok(model)
  assert.equal(model.name, 'looks-local:latest')
  assert.equal(isStructurallyLocalOllamaModel(model), false)
})

test('a result with any remote marker or changed digest is refused before acceptance', () => {
  assert.doesNotThrow(() => assertLocalOllamaResult({ digest: DIGEST }, DIGEST))
  assert.throws(
    () => assertLocalOllamaResult({ digest: DIGEST, remote_model: 'cloud' }, DIGEST),
    OllamaObservationError,
  )
  assert.throws(
    () => assertLocalOllamaResult({ digest: 'b'.repeat(64) }, DIGEST),
    OllamaObservationError,
  )
})

test('a malformed or oversized inventory fails closed rather than becoming an empty list', async () => {
  await assert.rejects(
    () => observeOllamaInventory(undefined, () => Promise.resolve(new Response('not-json'))),
    OllamaObservationError,
  )
})
