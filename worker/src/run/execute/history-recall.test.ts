import assert from 'node:assert/strict'
import test from 'node:test'
import { EMBEDDING_DIMENSIONS } from '@nessie/schemas'
import { createConsumedSourceSink } from './disclosure-basis.js'
import { retrieveRelevantHistory } from './history-recall.js'

const ORGANIZATION_ID = '11111111-1111-1111-1111-111111111111'
const CHANNEL_ID = '22222222-2222-2222-2222-222222222222'
const THREAD_ID = '33333333-3333-3333-3333-333333333333'
const AGENT_ID = '44444444-4444-4444-4444-444444444444'
const AUTHOR_ID = '55555555-5555-5555-5555-555555555555'
const MESSAGE_ID = '66666666-6666-6666-6666-666666666666'
const EMBEDDING_MODEL = 'test-embedding'

const message = (embedding: {
  contentHash: string
  embeddingModel: string
  status: string
} | null = null) => ({
  agentId: null,
  basisScopes: [],
  content: 'Nasazení je hotové, databáze je po migraci.',
  createdAt: new Date('2026-09-08T10:00:00Z'),
  deletedAt: null,
  disclosureSources: [],
  embedding,
  id: MESSAGE_ID,
  metadata: null,
  onBehalfOfUserId: null,
  role: 'user',
  threadId: THREAD_ID,
  userId: AUTHOR_ID,
  thread: { channel: { id: CHANNEL_ID, visibility: 'private' } },
})

const context = (sink = createConsumedSourceSink()) => ({
  agent: { agentKind: 'shared', id: AGENT_ID },
  channel: {
    dmKey: null,
    id: CHANNEL_ID,
    organizationId: ORGANIZATION_ID,
    projectId: null,
    systemChannelType: null,
    teamId: null,
  },
  consumedSources: sink,
  run: { id: '77777777-7777-7777-7777-777777777777', threadId: THREAD_ID },
})

const payload = {
  actorContext: {
    actionContext: { requestId: 'history-test' },
    actor: { actorId: AGENT_ID, actorType: 'agent' },
  },
} as never

const historyDeps = (seed = message()) => {
  const rows = [seed]
  return {
    modelClient: {
      embedMany: async () => [Array<number>(EMBEDDING_DIMENSIONS).fill(0.1)],
      embeddingModel: EMBEDDING_MODEL,
    },
    prisma: {
      message: {
        findMany: async (input: { where: { id?: { in: string[] } } }) =>
          input.where.id ? rows : rows,
      },
    },
    searchConfig: {
      pool: {
        query: async (sql: string) => {
          if (sql.includes('FROM channels c\n     JOIN agent_bindings')) {
            return { rows: [{ id: CHANNEL_ID, projectId: null, teamId: null }] }
          }
          if (sql.includes('FROM agents WHERE')) {
            return { rows: [{ projectId: null, teamId: null }] }
          }
          return { rows: [{ createdAt: seed.createdAt, id: seed.id, lexicalRank: 1, semanticRank: 1 }] }
        },
      },
    },
  }
}

const agentViewer = {
  agentId: AGENT_ID,
  kind: 'agent' as const,
  scopes: [{ scopeId: CHANNEL_ID, scopeType: 'channel' }],
}

test('history recall admits a bounded Czech passage with its full private source lineage', async () => {
  const sink = createConsumedSourceSink()
  const result = await retrieveRelevantHistory(historyDeps() as never, context(sink) as never, payload, {
    prompt: 'Čau, je deploy po migraci hotový?',
    tokenBudget: 1_000,
    viewer: agentViewer,
  })

  assert.match(result.context ?? '', /Nasazení je hotové/)
  assert.match(result.context ?? '', new RegExp(`sourceLink=/channels/${CHANNEL_ID}`))
  assert.deepEqual(result.messageIds, [MESSAGE_ID])
  assert.deepEqual(sink.list(), [{ scopeId: CHANNEL_ID, scopeType: 'channel' }])
  assert.deepEqual(sink.privateConversationSources(), [{
    sourceAuthorUserId: AUTHOR_ID,
    sourceChannelId: CHANNEL_ID,
  }])
})

test('history recall returns no text for a denied viewer or a stale projection', async () => {
  let modelCalls = 0
  const deniedDeps = historyDeps()
  deniedDeps.modelClient.embedMany = async () => {
    modelCalls += 1
    return []
  }
  const denied = await retrieveRelevantHistory(deniedDeps as never, context() as never, payload, {
    prompt: 'where is the deploy?',
    viewer: { kind: 'denied' },
  })
  assert.equal(denied.context, null)
  assert.equal(modelCalls, 0)

  const stale = message({
    contentHash: 'not-the-current-source-hash',
    embeddingModel: EMBEDDING_MODEL,
    status: 'indexed',
  })
  const staleResult = await retrieveRelevantHistory(historyDeps(stale) as never, context() as never, payload, {
    prompt: 'kde je deploy?',
    tokenBudget: 1_000,
    viewer: agentViewer,
  })
  assert.equal(staleResult.context, null)
})
