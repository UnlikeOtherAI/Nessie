import assert from 'node:assert/strict'
import test from 'node:test'
import { EMBEDDING_DIMENSIONS } from '@nessie/schemas'
import { searchMessageCandidates } from '../src/messages.js'

test('message search keeps candidate text behind tenant, scope, and canonical-message filters', async () => {
  let query: { params: unknown[]; sql: string } | undefined
  const rows = [
    {
      createdAt: new Date('2026-09-08T10:00:00Z'),
      id: '11111111-1111-1111-1111-111111111111',
      lexicalRank: 2,
      semanticRank: 1,
    },
    {
      createdAt: new Date('2026-09-08T09:00:00Z'),
      id: '22222222-2222-2222-2222-222222222222',
      lexicalRank: 1,
      semanticRank: null,
    },
  ]
  const result = await searchMessageCandidates({
    channelIds: ['33333333-3333-3333-3333-333333333333'],
    embeddingModel: 'test-embedding',
    organizationId: '44444444-4444-4444-4444-444444444444',
    query: 'čau, kde je ten deploy?',
    queryEmbedding: Array<number>(EMBEDDING_DIMENSIONS).fill(0.1),
    runningAgentId: '55555555-5555-5555-5555-555555555555',
    scopeIds: ['33333333-3333-3333-3333-333333333333'],
    scopeTypes: ['channel'],
  }, {
    query: async (sql, params) => {
      query = { params: params ?? [], sql }
      return { rows }
    },
  })

  assert.equal(result.length, 2)
  assert.equal(result[0]?.id, rows[0]?.id)
  assert.match(query?.sql ?? '', /c\.organization_id = \$5::uuid/)
  assert.match(query?.sql ?? '', /message_basis_scopes/)
  assert.match(query?.sql ?? '', /websearch_to_tsquery\('english'/)
  assert.doesNotMatch(query?.sql ?? '', /encode\(digest\(e\.content/)
  assert.equal(query?.params[6], EMBEDDING_DIMENSIONS)
})

test('message search rejects malformed paired scope inputs before querying', async () => {
  let queried = false
  const result = await searchMessageCandidates({
    channelIds: ['33333333-3333-3333-3333-333333333333'],
    embeddingModel: 'test-embedding',
    organizationId: '44444444-4444-4444-4444-444444444444',
    query: 'hello',
    queryEmbedding: null,
    runningAgentId: '55555555-5555-5555-5555-555555555555',
    scopeIds: [],
    scopeTypes: ['channel'],
  }, {
    query: async () => {
      queried = true
      return { rows: [] }
    },
  })

  assert.deepEqual(result, [])
  assert.equal(queried, false)
})
