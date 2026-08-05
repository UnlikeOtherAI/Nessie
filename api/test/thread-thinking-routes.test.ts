import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerThreadRoutes } from '../src/routes/threads.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000002'
const channelId = '00000000-0000-4000-8000-000000000003'
const threadId = '00000000-0000-4000-8000-000000000004'
const agentId = '00000000-0000-4000-8000-000000000005'
const runId = '00000000-0000-4000-8000-000000000006'
const rootMessageId = '00000000-0000-4000-8000-000000000007'

const actorContext: AuthorizedActionContext = {
  actionContext: { requestId: 'request-thread-thinking' },
  actor: { actorId: userId, actorType: 'user', roles: ['member'] },
  tenant: { organizationId },
} as unknown as AuthorizedActionContext

type ChunkRow = { id: bigint; kind: 'reasoning' | 'tool'; content: string; createdAt: Date }

const chunk = (id: number, kind: 'reasoning' | 'tool', content: string): ChunkRow => ({
  content,
  createdAt: new Date('2026-08-05T10:00:00.000Z'),
  id: BigInt(id),
  kind,
})

// Newest-first slice, mirroring the service's `orderBy: { id: 'desc' }` read.
const newestFirst = (rows: ChunkRow[], take: number): ChunkRow[] =>
  [...rows].sort((left, right) => Number(right.id - left.id)).slice(0, take)

const makeApp = (input: {
  chunks?: ChunkRow[]
  runInThread?: boolean
  runningRuns?: Array<{
    id: string
    agentId: string
    replyRootMessageId: string | null
    startedAt: Date | null
  }>
  threadVisible?: boolean
}) => {
  const prisma = {
    thread: {
      findFirst: async () =>
        input.threadVisible === false
          ? null
          : {
              id: threadId,
              channel: {
                id: channelId,
                organizationId,
                systemChannelType: null,
                type: 'standard',
              },
            },
    },
    run: {
      findFirst: async () =>
        input.runInThread === false
          ? null
          : {
              agentId,
              id: runId,
              replyRootMessageId: rootMessageId,
              status: 'running',
            },
      findMany: async () => input.runningRuns ?? [],
    },
    runThinkingChunk: {
      findMany: async (args: { take: number }) => newestFirst(input.chunks ?? [], args.take),
    },
  } as unknown as PrismaClient

  const app = Fastify({ logger: false })
  registerThreadRoutes(app, {
    allowedCorsOrigins: [],
    buildChannelRealtimeScopes: () => [],
    config: { mode: 'selfHosted' },
    prisma,
    realtimeHub: { publishWs: async () => undefined },
    requireActorContext: () => actorContext,
  } as unknown as Parameters<typeof registerThreadRoutes>[1])
  return app
}

test('a non-member gets 404 for both thinking routes (no run existence leak)', async () => {
  const app = makeApp({ threadVisible: false })
  try {
    const bootstrap = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/thinking`,
    })
    assert.equal(bootstrap.statusCode, 404)
    assert.equal(bootstrap.json().error.code, 'THREAD_NOT_FOUND')

    const log = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/runs/${runId}/thinking`,
    })
    assert.equal(log.statusCode, 404)
    assert.equal(log.json().error.code, 'THREAD_NOT_FOUND')
  } finally {
    await app.close()
  }
})

test('a run from another thread is indistinguishable from a missing one', async () => {
  const app = makeApp({ runInThread: false })
  try {
    const response = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/runs/${runId}/thinking`,
    })
    assert.equal(response.statusCode, 404)
    assert.equal(response.json().error.code, 'RUN_NOT_FOUND')
  } finally {
    await app.close()
  }
})

test('the run log returns ordered entries with string ids and the resolved anchor', async () => {
  const app = makeApp({
    chunks: [
      chunk(1, 'reasoning', 'Looking at the channels first.'),
      chunk(2, 'tool', 'channel_list: limit=5'),
      chunk(3, 'reasoning', 'That is everything I need.'),
    ],
  })
  try {
    const response = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/runs/${runId}/thinking`,
    })

    assert.equal(response.statusCode, 200)
    const { data } = response.json()
    assert.deepEqual(data.run, {
      agentId,
      id: runId,
      rootMessageId,
      status: 'running',
    })
    assert.equal(data.truncated, false)
    assert.deepEqual(data.entries.map((entry: { id: string }) => entry.id), ['1', '2', '3'])
    assert.deepEqual(
      data.entries.map((entry: { kind: string }) => entry.kind),
      ['reasoning', 'tool', 'reasoning'],
    )
    // BigInt ids must cross the wire as strings.
    for (const entry of data.entries) {
      assert.equal(typeof entry.id, 'string')
    }
  } finally {
    await app.close()
  }
})

test('a log longer than the cap returns the tail and flags truncation', async () => {
  const chunks = Array.from({ length: 520 }, (_, index) =>
    chunk(index + 1, 'reasoning', `thought ${index + 1}`))
  const app = makeApp({ chunks })
  try {
    const response = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/runs/${runId}/thinking`,
    })

    assert.equal(response.statusCode, 200)
    const { data } = response.json()
    assert.equal(data.truncated, true)
    assert.equal(data.entries.length, 500)
    // The tail is kept: the newest entry is last, the elided prefix is oldest.
    assert.equal(data.entries[0].id, '21')
    assert.equal(data.entries.at(-1).id, '520')
  } finally {
    await app.close()
  }
})

test('the thread bootstrap reports live runs with their anchor and last chunk id', async () => {
  const app = makeApp({
    chunks: [
      chunk(7, 'reasoning', 'still working'),
      chunk(8, 'tool', 'channel_list: limit=5'),
    ],
    runningRuns: [{
      agentId,
      id: runId,
      replyRootMessageId: rootMessageId,
      startedAt: new Date('2026-08-05T10:00:00.000Z'),
    }],
  })
  try {
    const response = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/thinking`,
    })

    assert.equal(response.statusCode, 200)
    const { data } = response.json()
    assert.equal(data.runs.length, 1)
    assert.equal(data.runs[0].runId, runId)
    assert.equal(data.runs[0].agentId, agentId)
    assert.equal(data.runs[0].rootMessageId, rootMessageId)
    assert.equal(data.runs[0].startedAt, '2026-08-05T10:00:00.000Z')
    assert.equal(data.runs[0].lastChunkId, '8')
    assert.deepEqual(data.runs[0].entries.map((entry: { id: string }) => entry.id), ['7', '8'])
  } finally {
    await app.close()
  }
})

test('a thread with no live runs bootstraps to an empty list', async () => {
  const app = makeApp({ runningRuns: [] })
  try {
    const response = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/thinking`,
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().data, { runs: [] })
  } finally {
    await app.close()
  }
})

test('a top-level run reports a null anchor rather than omitting it', async () => {
  const app = makeApp({
    runningRuns: [{ agentId, id: runId, replyRootMessageId: null, startedAt: null }],
  })
  try {
    const response = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/thinking`,
    })

    assert.equal(response.statusCode, 200)
    const run = response.json().data.runs[0]
    assert.equal(run.rootMessageId, null)
    assert.equal(run.startedAt, null)
    assert.equal(run.lastChunkId, null)
  } finally {
    await app.close()
  }
})
