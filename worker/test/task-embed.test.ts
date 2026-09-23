import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { taskContentHash } from '@nessie/db'
import type { ModelClient } from '@nessie/runtime'
import { EMBEDDING_DIMENSIONS } from '@nessie/schemas'

import {
  executeTaskEmbedJob,
  TASK_EMBED_IDENTITY_UNAVAILABLE,
} from '../src/control/task-embed.js'

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111'
const TASK_ID = '22222222-2222-4222-8222-222222222222'
const EMBEDDING_MODEL = 'test-task-embedding'

type SqlLike = { sql: string; values: unknown[] }

const source = (title = 'Ship the launch plan') => ({
  agentId: null,
  createdByUserId: '33333333-3333-4333-8333-333333333333',
  detail: 'Coordinate the release train.',
  project: { teamId: '44444444-4444-4444-8444-444444444444' },
  projectId: '55555555-5555-4555-8555-555555555555',
  purpose: 'Launch safely',
  title,
})

const payload = () => ({
  contentHash: taskContentHash(source()),
  embeddingModel: EMBEDDING_MODEL,
  organizationId: ORGANIZATION_ID,
  taskId: TASK_ID,
})

const prismaFor = (task: ReturnType<typeof source> | null, writes: SqlLike[]): PrismaClient => ({
  task: { findFirst: async () => task },
  $executeRaw: async (query: SqlLike) => {
    writes.push(query)
    return 1
  },
}) as unknown as PrismaClient

test('task embed indexes canonical title, purpose, and detail behind the source hash fence', async () => {
  const writes: SqlLike[] = []
  const modelClient = {
    embedMany: async (texts: string[]) => {
      assert.deepEqual(texts, ['Ship the launch plan\n\nLaunch safely\n\nCoordinate the release train.'])
      return [Array<number>(EMBEDDING_DIMENSIONS).fill(0.1)]
    },
    embeddingModel: EMBEDDING_MODEL,
  } as unknown as Pick<ModelClient, 'embedMany' | 'embeddingModel'>

  await executeTaskEmbedJob({ modelClient, prisma: prismaFor(source(), writes) }, payload())

  assert.equal(writes.length, 1)
  assert.ok(writes[0]?.sql.includes('t.organization_id'))
  assert.ok(writes[0]?.sql.includes('p.deleted_at IS NULL'))
  assert.ok(writes[0]?.sql.includes('p.channel_root = false'))
  assert.ok(writes[0]?.sql.includes('encode(digest(concat_ws'))
  assert.ok(writes[0]?.values.includes('indexed'))
  assert.ok(writes[0]?.values.includes(EMBEDDING_DIMENSIONS))
})

test('task embed discards changed and superseded-model jobs before inference', async () => {
  let calls = 0
  const writes: SqlLike[] = []
  const modelClient = {
    embedMany: async () => {
      calls += 1
      return [Array<number>(EMBEDDING_DIMENSIONS).fill(0.1)]
    },
    embeddingModel: EMBEDDING_MODEL,
  } as unknown as Pick<ModelClient, 'embedMany' | 'embeddingModel'>

  await executeTaskEmbedJob({ modelClient, prisma: prismaFor(null, writes) }, payload())
  await executeTaskEmbedJob({ modelClient, prisma: prismaFor(source('Edited'), writes) }, payload())
  await executeTaskEmbedJob(
    { modelClient, prisma: prismaFor(source(), writes) },
    { ...payload(), embeddingModel: 'newer-model' },
  )

  assert.equal(calls, 0)
  assert.equal(writes.length, 0)
})

test('task embed records a failed projection when the provider returns the wrong width', async () => {
  const writes: SqlLike[] = []
  const modelClient = {
    embedMany: async () => [Array<number>(EMBEDDING_DIMENSIONS - 1).fill(0.1)],
    embeddingModel: EMBEDDING_MODEL,
  } as unknown as Pick<ModelClient, 'embedMany' | 'embeddingModel'>

  await assert.rejects(
    executeTaskEmbedJob({ modelClient, prisma: prismaFor(source(), writes) }, payload()),
    /embedding dimensions/,
  )
  assert.ok(writes[0]?.values.includes('failed'))
})

test('task embed carries the captured UOA origin in signed deployments', async () => {
  const writes: SqlLike[] = []
  let usage: Record<string, unknown> | undefined
  const origin = {
    userId: '66666666-6666-4666-8666-666666666666',
    uoaIdentity: {
      organizationId: 'uoa-org',
      subject: 'uoa-subject',
      teamId: 'uoa-team',
      tokenVersion: 5,
    },
  }
  const modelClient = {
    embedMany: async (_texts: string[], options: { usage: Record<string, unknown> }) => {
      usage = options.usage
      return [Array<number>(EMBEDDING_DIMENSIONS).fill(0.1)]
    },
    embeddingModel: EMBEDDING_MODEL,
  } as unknown as Pick<ModelClient, 'embedMany' | 'embeddingModel'>

  await executeTaskEmbedJob(
    { ledgerSigningConfigured: true, modelClient, prisma: prismaFor(source(), writes) },
    { ...payload(), origin },
  )

  assert.deepEqual(usage?.['uoaIdentity'], origin.uoaIdentity)
  assert.equal(usage?.['userId'], origin.userId)
  assert.ok(writes[0]?.values.includes('indexed'))
})

test('task embed terminally skips an origin-less signed claim', async () => {
  const writes: SqlLike[] = []
  let calls = 0
  const modelClient = {
    embedMany: async () => {
      calls += 1
      return [Array<number>(EMBEDDING_DIMENSIONS).fill(0.1)]
    },
    embeddingModel: EMBEDDING_MODEL,
  } as unknown as Pick<ModelClient, 'embedMany' | 'embeddingModel'>

  await executeTaskEmbedJob(
    { ledgerSigningConfigured: true, modelClient, prisma: prismaFor(source(), writes) },
    payload(),
  )

  assert.equal(calls, 0)
  assert.ok(writes[0]?.values.includes('skipped'))
  assert.ok(writes[0]?.values.includes(TASK_EMBED_IDENTITY_UNAVAILABLE))
})

test('task embedding migration uses the shared vector dimensions', async () => {
  const migration = await readFile(new URL(
    '../../api/prisma/migrations/20260923090000_task_embedding_projection/migration.sql',
    import.meta.url,
  ), 'utf8')
  assert.match(migration, new RegExp(`"embedding" vector\\(${EMBEDDING_DIMENSIONS}\\)`))
})
