import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import type { ModelClient } from '@nessie/runtime'
import { EMBEDDING_DIMENSIONS } from '@nessie/schemas'
import {
  executeMessageEmbedJob,
  messageContentHash,
} from '../src/control/message-embed.js'

const ORGANIZATION_ID = '11111111-1111-1111-1111-111111111111'
const MESSAGE_ID = '22222222-2222-2222-2222-222222222222'
const EMBEDDING_MODEL = 'test-message-embedding'
const CONTENT = 'The Czech deploy is ready after the database migration.'

type SqlLike = { sql: string; values: unknown[] }

const payload = (content = CONTENT) => ({
  contentHash: messageContentHash(content),
  embeddingModel: EMBEDDING_MODEL,
  messageId: MESSAGE_ID,
  organizationId: ORGANIZATION_ID,
})

const source = (content = CONTENT) => ({
  agentId: null,
  content,
  onBehalfOfUserId: null,
  threadId: '33333333-3333-3333-3333-333333333333',
  userId: '44444444-4444-4444-4444-444444444444',
  thread: { channel: {
    id: '55555555-5555-5555-5555-555555555555',
    organizationId: ORGANIZATION_ID,
    projectId: '66666666-6666-6666-6666-666666666666',
    teamId: '77777777-7777-7777-7777-777777777777',
  } },
})

const prismaFor = (message: ReturnType<typeof source> | null, writes: SqlLike[]): PrismaClient => ({
  message: { findFirst: async () => message },
  $executeRaw: async (query: SqlLike) => {
    writes.push(query)
    return 1
  },
}) as unknown as PrismaClient

test('message embed writes an indexed projection only behind the source hash fence', async () => {
  const writes: SqlLike[] = []
  const modelClient = {
    embedMany: async (texts: string[]) => {
      assert.deepEqual(texts, [CONTENT])
      return [Array<number>(EMBEDDING_DIMENSIONS).fill(0.1)]
    },
    embeddingModel: EMBEDDING_MODEL,
  } as unknown as Pick<ModelClient, 'embedMany' | 'embeddingModel'>

  await executeMessageEmbedJob({ modelClient, prisma: prismaFor(source(), writes) }, payload())

  assert.equal(writes.length, 1)
  assert.ok(writes[0]!.sql.includes('m.deleted_at IS NULL'))
  assert.ok(writes[0]!.sql.includes('encode(digest(m.content'))
  assert.ok(writes[0]!.values.includes('indexed'))
  assert.ok(writes[0]!.values.includes(EMBEDDING_DIMENSIONS))
})

test('message embed discards deleted, changed, and superseded-model jobs before inference', async () => {
  let calls = 0
  const modelClient = {
    embedMany: async () => {
      calls += 1
      return [Array<number>(EMBEDDING_DIMENSIONS).fill(0.1)]
    },
    embeddingModel: EMBEDDING_MODEL,
  } as unknown as Pick<ModelClient, 'embedMany' | 'embeddingModel'>
  const writes: SqlLike[] = []

  await executeMessageEmbedJob({ modelClient, prisma: prismaFor(null, writes) }, payload())
  await executeMessageEmbedJob({ modelClient, prisma: prismaFor(source('edited'), writes) }, payload())
  await executeMessageEmbedJob({
    modelClient,
    prisma: prismaFor(source(), writes),
  }, { ...payload(), embeddingModel: 'newer-model' })

  assert.equal(calls, 0)
  assert.equal(writes.length, 0)
})

test('message embed records a failed retry state when the model returns a wrong width', async () => {
  const writes: SqlLike[] = []
  const modelClient = {
    embedMany: async () => [Array<number>(EMBEDDING_DIMENSIONS - 1).fill(0.1)],
    embeddingModel: EMBEDDING_MODEL,
  } as unknown as Pick<ModelClient, 'embedMany' | 'embeddingModel'>

  await assert.rejects(
    executeMessageEmbedJob({ modelClient, prisma: prismaFor(source(), writes) }, payload()),
    /embedding dimensions/,
  )
  assert.equal(writes.length, 1)
  assert.ok(writes[0]!.values.includes('failed'))
})

test('message embedding migration takes its vector width from the shared dimensions contract', async () => {
  const migration = await readFile(new URL(
    '../../api/prisma/migrations/20260911110002_message_embedding_projection/migration.sql',
    import.meta.url,
  ), 'utf8')
  assert.match(migration, new RegExp(`embedding vector\\(${EMBEDDING_DIMENSIONS}\\)`))
})
