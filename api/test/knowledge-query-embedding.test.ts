import assert from 'node:assert/strict'
import test from 'node:test'

import type { LedgerAttribution, ModelClient } from '@nessie/runtime'
import { getQueryEmbedding } from '../src/services/knowledge-query-embedding.js'

const usage: LedgerAttribution = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  actorId: '00000000-0000-4000-8000-000000000002',
}

const fakeModelClient = (embed: ModelClient['embed']): ModelClient =>
  ({ embed, embeddingModel: 'jina-embeddings-v3' }) as unknown as ModelClient

test('getQueryEmbedding returns null when there is no model client', async () => {
  const result = await getQueryEmbedding(null, 'hello world', usage)
  assert.equal(result, null)
})

test('getQueryEmbedding returns null and does not throw when embed rejects', async () => {
  const client = fakeModelClient(async () => {
    throw new Error('embedding provider down')
  })

  const result = await getQueryEmbedding(client, 'hello world', usage)
  assert.equal(result, null)
})

test('getQueryEmbedding calls embed once and caches by normalized query', async () => {
  let calls = 0
  const client = fakeModelClient(async () => {
    calls += 1
    return [0.1, 0.2, 0.3]
  })

  const first = await getQueryEmbedding(client, '  Hello World  ', usage)
  const second = await getQueryEmbedding(client, 'hello world', usage)

  assert.deepEqual(first, [0.1, 0.2, 0.3])
  assert.deepEqual(second, [0.1, 0.2, 0.3])
  assert.equal(calls, 1)
})

test('getQueryEmbedding treats distinct queries as distinct cache entries', async () => {
  let calls = 0
  const client = fakeModelClient(async (text) => {
    calls += 1
    return text === 'alpha' ? [1, 0] : [0, 1]
  })

  const alpha = await getQueryEmbedding(client, 'alpha', usage)
  const beta = await getQueryEmbedding(client, 'beta', usage)

  assert.deepEqual(alpha, [1, 0])
  assert.deepEqual(beta, [0, 1])
  assert.equal(calls, 2)
})
