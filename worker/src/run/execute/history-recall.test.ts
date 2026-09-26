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
  boundAgentIds: [AGENT_ID],
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
    tenant: { organizationId: ORGANIZATION_ID },
  },
} as never

const historyDeps = (seed = message(), threadAgentId: string | null = null) => {
  const rows = [seed]
  // Every call's parameter list, so a test can assert what the query was
  // actually narrowed to rather than only what came back.
  const searchParams: unknown[][] = []
  return {
    searchParams,
    modelClient: {
      embedMany: async (
        _texts: string[],
        _options?: { usage?: Record<string, unknown> },
      ): Promise<number[][]> => [Array<number>(EMBEDDING_DIMENSIONS).fill(0.1)],
      embeddingModel: EMBEDDING_MODEL,
    },
    prisma: {
      message: {
        findMany: async (input: { where: { id?: { in: string[] } } }) =>
          input.where.id ? rows : rows,
      },
      // `Thread.agentId` is what says this thread is a conversation *with* an
      // agent rather than a room's own General thread, and it is what decides
      // whether recall may reach the rest of the channel.
      thread: {
        findFirst: async () => ({ agentId: threadAgentId }),
      },
    },
    searchConfig: {
      pool: {
        query: async (sql: string, params?: unknown[]) => {
          if (params) searchParams.push(params)
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

test('history recall signs its embed with the session identity and degrades when refused', async () => {
  const uoaIdentity = {
    organizationId: 'uoa-org',
    subject: 'uoa-subject',
    teamId: 'uoa-team',
    tokenVersion: 19,
  }
  const signedPayload = {
    actorContext: {
      actionContext: { requestId: 'history-test', sessionId: 'session-1', uoaIdentity },
      actor: { actorId: AGENT_ID, actorType: 'agent' },
      tenant: { organizationId: ORGANIZATION_ID },
    },
  } as never
  let usage: Record<string, unknown> | undefined
  const deps = historyDeps()
  deps.modelClient.embedMany = async (_texts: string[], options?: { usage?: Record<string, unknown> }) => {
    usage = options?.usage
    return [Array<number>(EMBEDDING_DIMENSIONS).fill(0.1)]
  }
  await retrieveRelevantHistory(deps as never, context() as never, signedPayload, {
    prompt: 'je deploy hotový?',
    tokenBudget: 1_000,
    viewer: agentViewer,
  })
  assert.deepEqual(usage?.['uoaIdentity'], uoaIdentity)
  assert.equal(usage?.['sessionId'], 'session-1')
  assert.equal(usage?.['systemComponent'], 'history-recall')

  const refused = historyDeps()
  refused.modelClient.embedMany = async () => {
    throw new Error('Ledger requires a linked UnlikeOtherAI SSO identity for the originating user.')
  }
  const degraded = await retrieveRelevantHistory(refused as never, context() as never, signedPayload, {
    prompt: 'je deploy hotový?',
    tokenBudget: 1_000,
    viewer: agentViewer,
  })
  assert.deepEqual(degraded, { context: null, messageIds: [], tokenCount: 0 })
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

/**
 * Two conversations with one agent are two threads in one channel.
 *
 * Recall is scoped by channel, which is right for a room — one room, one
 * history — and wrong here: without a thread narrowing, the sibling
 * conversation's messages are eligible candidates and the agent answers one
 * conversation using the other's. `Thread.agentId` is the line, because that
 * field means "the agent this thread is a conversation *with*" and is null for
 * a channel's own General thread.
 *
 * It stayed invisible while background embed jobs were refused: with no
 * `message_embeddings` rows the semantic arm returned nothing, so there was
 * nothing for the channel-wide scope to carry across.
 */
test('a conversation with an agent recalls only its own thread', async () => {
  const sink = createConsumedSourceSink()
  const deps = historyDeps(message(), AGENT_ID)
  await retrieveRelevantHistory(deps as never, context(sink) as never, payload, {
    prompt: 'what did we decide?',
    tokenBudget: 1_000,
    viewer: agentViewer,
  })

  const candidateCall = deps.searchParams.find((params) => params.length >= 11)
  assert.ok(candidateCall, 'the candidate search ran')
  assert.deepEqual(
    candidateCall[10],
    [THREAD_ID],
    'a conversation with an agent must not draw candidates from its siblings',
  )
})

test("a room's own thread still recalls the whole channel", async () => {
  const sink = createConsumedSourceSink()
  // `agentId: null` — the channel's General thread, which is one conversation
  // and whose history is the channel's.
  const deps = historyDeps(message(), null)
  await retrieveRelevantHistory(deps as never, context(sink) as never, payload, {
    prompt: 'what did we decide?',
    tokenBudget: 1_000,
    viewer: agentViewer,
  })

  const candidateCall = deps.searchParams.find((params) => params.length >= 11)
  assert.ok(candidateCall, 'the candidate search ran')
  assert.equal(candidateCall[10], null, 'a room must not be narrowed to one thread')
})

// F16: recalled history is recalled memory. A run lent a project write takes
// no passage whose lineage the project write gate would then refuse, and still
// takes the ones every project reader already has.
test('a run lent a project write recalls no private-room history', async () => {
  const sink = createConsumedSourceSink()
  const result = await retrieveRelevantHistory(historyDeps() as never, context(sink) as never, payload, {
    holdsProjectWriteTools: true,
    prompt: 'Čau, je deploy po migraci hotový?',
    tokenBudget: 1_000,
    viewer: agentViewer,
  })

  assert.equal(result.context, null)
  assert.deepEqual(result.messageIds, [])
  assert.deepEqual(sink.list(), [])
  assert.deepEqual(sink.privateConversationSources(), [])
})

test('a run lent a project write still recalls public, unrestricted history', async () => {
  const sink = createConsumedSourceSink()
  const publicMessage = { ...message(), thread: { channel: { id: CHANNEL_ID, visibility: 'public' } } }
  const result = await retrieveRelevantHistory(
    historyDeps(publicMessage) as never,
    context(sink) as never,
    payload,
    {
      holdsProjectWriteTools: true,
      prompt: 'Čau, je deploy po migraci hotový?',
      tokenBudget: 1_000,
      viewer: agentViewer,
    },
  )

  assert.deepEqual(result.messageIds, [MESSAGE_ID])
  assert.deepEqual(sink.list(), [])
})

// The lineage filter runs on the passages, after the search, so a contained
// run searches deeper to keep the recall from coming back short; a delegate in
// its own home judges nothing and searches at the normal depth. The last SQL
// parameter before the thread narrowing is each ranking arm's own limit, four
// times the take.
test('a contained run searches three times as deep as a delegate in its own home', async () => {
  const depthOf = async (
    runContext: ReturnType<typeof context>,
    runPayload: typeof payload,
    input: { holdsProjectWriteTools?: boolean; liveEntitlements?: unknown } = {},
  ): Promise<unknown> => {
    const deps = historyDeps()
    await retrieveRelevantHistory(deps as never, runContext as never, runPayload, {
      ...input,
      prompt: 'what did we decide?',
      tokenBudget: 1_000,
      viewer: agentViewer,
    } as never)
    return deps.searchParams.find((params) => params.length >= 11)?.[9]
  }

  assert.equal(await depthOf(context(), payload), 36 * 4)
  assert.equal(await depthOf(context(), payload, { holdsProjectWriteTools: true }), 36 * 4)

  const home = context()
  const homeRun = {
    ...home,
    agent: { agentKind: 'personal_assistant', id: AGENT_ID },
    channel: { ...home.channel, systemChannelType: 'personal_assistant' },
  }
  const ownerPayload = {
    actorContext: {
      actionContext: { effectiveUserId: AUTHOR_ID, requestId: 'history-test' },
      actor: { actorId: AUTHOR_ID, actorType: 'user' },
      tenant: { organizationId: ORGANIZATION_ID },
    },
  } as never
  assert.equal(await depthOf(homeRun as never, ownerPayload, {
    liveEntitlements: { kind: 'local', organizationId: ORGANIZATION_ID, userId: AUTHOR_ID },
  }), 12 * 4)
})

// A scheduled joke in a public room recalled its owner's DM with the agent,
// and the joke was withheld from everyone else in the room. Recall is context
// the platform assembles: in a contained run it may not be what restricts the
// reply, wherever the passage came from.
const OTHER_CHANNEL_ID = '88888888-8888-4888-8888-888888888888'
// The requester is in that conversation, so it is the gate — not the viewer —
// that keeps it out.
const dmMemberViewer = {
  ...agentViewer,
  scopes: [...agentViewer.scopes, { scopeId: OTHER_CHANNEL_ID, scopeType: 'channel' }],
}
const dmMessage = () => ({ ...message(), thread: { channel: { id: OTHER_CHANNEL_ID, visibility: 'private' } } })

test('a room recalls no passage from a private conversation elsewhere', async () => {
  const sink = createConsumedSourceSink()
  const result = await retrieveRelevantHistory(historyDeps(dmMessage()) as never, context(sink) as never, payload, {
    prompt: 'Čau, je deploy po migraci hotový?',
    tokenBudget: 1_000,
    viewer: dmMemberViewer,
  })

  assert.equal(result.context, null)
  assert.deepEqual(sink.list(), [])
  assert.deepEqual(sink.privateConversationSources(), [])
})

test('a room still recalls another public room, and what the run already holds', async () => {
  const publicRoom = { ...message(), thread: { channel: { id: OTHER_CHANNEL_ID, visibility: 'public' } } }
  const fromPublic = await retrieveRelevantHistory(
    historyDeps(publicRoom) as never,
    context() as never,
    payload,
    { prompt: 'kde je deploy?', tokenBudget: 1_000, viewer: agentViewer },
  )
  assert.deepEqual(fromPublic.messageIds, [MESSAGE_ID])

  // A run whose reply that conversation already restricts loses nothing more
  // by recalling it, so the passage is taken.
  const sink = createConsumedSourceSink()
  sink.addPrivateConversationSource({ sourceAuthorUserId: AUTHOR_ID, sourceChannelId: OTHER_CHANNEL_ID })
  const alreadyHeld = await retrieveRelevantHistory(
    historyDeps(dmMessage()) as never,
    context(sink) as never,
    payload,
    { prompt: 'kde je deploy?', tokenBudget: 1_000, viewer: dmMemberViewer },
  )
  assert.deepEqual(alreadyHeld.messageIds, [MESSAGE_ID])
})

test('a deeper project-write search still admits no more passages than the normal depth', async () => {
  const seeds = Array.from({ length: 36 }, (_, index) => {
    const id = `${String(index).padStart(8, '0')}-6666-4666-8666-666666666666`
    return {
      ...message(),
      id,
      threadId: `${String(index).padStart(8, '0')}-3333-4333-8333-333333333333`,
      thread: { channel: { id: CHANNEL_ID, visibility: 'public' } },
    }
  })
  const deps = historyDeps()
  deps.prisma.message.findMany = async (input: {
    where: { createdAt?: { lte?: Date }; id?: { in: string[] }; threadId?: string }
  }) => input.where.id
    ? seeds.filter((row) => input.where.id?.in.includes(row.id))
    : input.where.createdAt?.lte
      ? seeds.filter((row) => row.threadId === input.where.threadId)
      : []
  deps.searchConfig.pool.query = async (sql: string, params?: unknown[]) => {
    if (params) deps.searchParams.push(params)
    if (sql.includes('FROM channels c\n     JOIN agent_bindings')) {
      return { rows: [{ id: CHANNEL_ID, projectId: null, teamId: null }] }
    }
    if (sql.includes('FROM agents WHERE')) return { rows: [{ projectId: null, teamId: null }] }
    return {
      rows: seeds.map((row, index) => ({
        createdAt: row.createdAt,
        id: row.id,
        lexicalRank: index + 1,
        semanticRank: index + 1,
      })),
    }
  }

  const result = await retrieveRelevantHistory(deps as never, context() as never, payload, {
    holdsProjectWriteTools: true,
    prompt: 'Čau, je deploy po migraci hotový?',
    viewer: agentViewer,
  })

  assert.deepEqual(result.messageIds, seeds.slice(0, 12).map(({ id }) => id))
})

// The passage around a hit is read only for a hit the run can take: its seed
// is judged, and measured against what is left of the budget, first. A deeper
// project-write search past private hits must not multiply the reads.
test('a hit the run refuses, or that cannot fit, costs no passage read', async () => {
  const seeds = Array.from({ length: 36 }, (_, index) => ({
    ...message(),
    id: `${String(index).padStart(8, '0')}-6666-4666-8666-666666666666`,
    threadId: `${String(index).padStart(8, '0')}-3333-4333-8333-333333333333`,
    // The first two dozen are private-room hits a project write refuses.
    thread: { channel: { id: CHANNEL_ID, visibility: index < 24 ? 'private' : 'public' } },
  }))
  const recallWith = async (tokenBudget: number) => {
    const deps = historyDeps()
    let passageReads = 0
    deps.prisma.message.findMany = async (input: {
      where: { createdAt?: { lte?: Date }; id?: { in: string[] }; threadId?: string }
    }) => {
      if (input.where.id) return seeds.filter((row) => input.where.id?.in.includes(row.id))
      if (!input.where.createdAt?.lte) return []
      passageReads += 1
      return seeds.filter((row) => row.threadId === input.where.threadId)
    }
    deps.searchConfig.pool.query = async (sql: string) => {
      if (sql.includes('FROM channels c\n     JOIN agent_bindings')) {
        return { rows: [{ id: CHANNEL_ID, projectId: null, teamId: null }] }
      }
      if (sql.includes('FROM agents WHERE')) return { rows: [{ projectId: null, teamId: null }] }
      return {
        rows: seeds.map((row, index) => ({
          createdAt: row.createdAt,
          id: row.id,
          lexicalRank: index + 1,
          semanticRank: index + 1,
        })),
      }
    }
    const result = await retrieveRelevantHistory(deps as never, context() as never, payload, {
      holdsProjectWriteTools: true,
      prompt: 'Čau, je deploy po migraci hotový?',
      tokenBudget,
      viewer: agentViewer,
    })
    return { passageReads, result }
  }

  const roomy = await recallWith(4_000)
  assert.deepEqual(roomy.result.messageIds, seeds.slice(24).map(({ id }) => id))
  assert.equal(roomy.passageReads, 12, 'one read per admitted passage, none for a refused hit')

  // Room for one passage: every later hit is measured, not read.
  const tight = await recallWith(100)
  assert.deepEqual(tight.result.messageIds, [seeds[24]?.id])
  assert.equal(tight.passageReads, 1)
})
