import assert from 'node:assert/strict'
import test from 'node:test'

import { ConversationRefMetadataSchema } from '@nessie/schemas'

import { createConsumedSourceSink } from '../execute/disclosure-basis.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import {
  runAgentConversationStartTool,
  runAgentConversationsListTool,
  runConversationReferenceTool,
} from './agent-conversations.js'

/**
 * The three conversation tools, against fakes
 * (docs/plans/2026-09-08-agent-conversations.md §4).
 *
 * What is worth asserting here is everything that is *not* the happy path's
 * prose: who may be addressed and in what words a refusal comes, that the
 * opener carries the destination's basis rather than the origin's, that the
 * target's run is claimed against the opener and unattended, and that the
 * doorway shares the opener's transaction — so a claim that fails leaves no
 * card pointing at work that never started.
 *
 * Every delegate and relation the code touches is present on the fakes below.
 * A missing one is a runtime TypeError, not a skipped read, and it surfaces
 * looking like something else entirely.
 */

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001'
const PROJECT_ID = '00000000-0000-4000-8000-000000000002'
const TEAM_ID = '00000000-0000-4000-8000-000000000003'
const ORIGIN_CHANNEL_ID = '00000000-0000-4000-8000-000000000004'
const ORIGIN_THREAD_ID = '00000000-0000-4000-8000-000000000005'
const DESTINATION_CHANNEL_ID = '00000000-0000-4000-8000-000000000006'
const NEW_THREAD_ID = '00000000-0000-4000-8000-000000000007'
const ACTOR_ID = '00000000-0000-4000-8000-000000000008'
const PA_AGENT_ID = '00000000-0000-4000-8000-000000000009'
const TARGET_AGENT_ID = '00000000-0000-4000-8000-00000000000a'
const RUN_ID = '00000000-0000-4000-8000-00000000000b'
const OPENER_ID = '00000000-0000-4000-8000-00000000000c'
const DOORWAY_ID = '00000000-0000-4000-8000-00000000000d'
const PRIVATE_SOURCE_CHANNEL_ID = '00000000-0000-4000-8000-00000000000e'

type Written = {
  content: string
  metadata?: unknown
  threadId: string
  tx: unknown
}

type FixtureOptions = {
  /** Make the target's claim blow up, to prove the doorway rolls back with it. */
  claimThrows?: boolean
  /** Scopes the run has already consumed, which decide the opener's basis. */
  consumed?: Array<{ scopeId: string; scopeType: string }>
  /** `null` makes every agent invisible to the caller. */
  entitledAgentName?: string | null
  /** The id of the model's tool call, which keys the target run's enqueue. */
  toolCallId?: string | null
  /** No user actor and no delegated identity: an autonomous run. */
  unattended?: boolean
}

const agentRow = (name: string) => ({
  agentKind: 'shared' as const,
  avatarAttachmentId: null,
  bindings: [{ channelId: DESTINATION_CHANNEL_ID }],
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  delegationMode: 'none' as const,
  effort: 'medium' as const,
  id: TARGET_AGENT_ID,
  messages: [],
  model: null,
  name,
  parentAgentId: null,
  provider: null,
  role: 'assistant',
  runs: [],
  status: 'idle' as const,
  surfacePolicy: 'shared' as const,
  systemManaged: false,
  systemPrompt: null,
  todosEnabled: false,
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  visibility: 'team' as const,
})

const destinationRow = {
  id: DESTINATION_CHANNEL_ID,
  label: 'research',
  members: [{ userId: ACTOR_ID }, { userId: '00000000-0000-4000-8000-0000000000ff' }],
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  systemChannelType: null,
  team: { project: { channelRoot: false, name: 'Website' } },
  teamId: TEAM_ID,
  type: 'standard' as const,
}

const makeFixture = (options: FixtureOptions = {}) => {
  const committed: Written[] = []
  const committedThreads: string[] = []
  const enqueuedKeys: string[] = []
  const runsCreated: Array<{ triggerMessageId: string; replyPlacement: string }> = []
  const published: Array<{ event: string }> = []
  const basisRows: Array<{ messageId: string; scopeId: string; scopeType: string }> = []

  const consumedSources = createConsumedSourceSink()
  consumedSources.addAll(options.consumed ?? [])

  const makeTx = (staged: Written[], stagedThreads: string[]) => {
    const tx: Record<string, unknown> = {
      // `enqueueQueueJob` passes the idempotency key as a bound parameter, so
      // the key this tool chose is readable off the statement's values.
      $executeRaw: async (query: { values?: unknown[] }) => {
        for (const value of query.values ?? []) {
          if (typeof value === 'string' && value.startsWith('agent-conversation:')) {
            enqueuedKeys.push(value)
          }
        }
        return 1
      },
      // `loadLastMessageAtByChannel`, when the default-room path is taken.
      $queryRaw: async () => [],
      agent: {
        // `startAgentConversation` now runs inside the transaction, so its
        // tenant lookup and its "can this person see this agent at all" count
        // are reads on the transaction client.
        count: async () => (options.entitledAgentName === null ? 0 : 1),
        findFirst: async () => ({ id: TARGET_AGENT_ID }),
      },
      thread: {
        create: async () => {
          stagedThreads.push(NEW_THREAD_ID)
          return { channelId: DESTINATION_CHANNEL_ID, id: NEW_THREAD_ID }
        },
      },
      message: {
        create: async ({ data }: { data: { content: string; metadata?: unknown; threadId: string } }) => {
          staged.push({
            content: data.content,
            metadata: data.metadata,
            threadId: data.threadId,
            tx,
          })
          const id = staged.length === 1 ? OPENER_ID : DOORWAY_ID
          return {
            content: data.content,
            createdAt: new Date('2026-09-08T10:00:00.000Z'),
            id,
            role: 'assistant',
            threadId: data.threadId,
          }
        },
      },
      messageBasisScope: {
        createMany: async ({ data }: { data: Array<{ messageId: string; scopeId: string; scopeType: string }> }) => {
          basisRows.push(...data)
          return { count: data.length }
        },
      },
      messageDisclosureSource: { createMany: async () => ({ count: 0 }) },
      runBasisScope: { createMany: async () => ({ count: 0 }) },
      channel: {
        // `persistablePrivateConversationSources` resolves source channels that
        // still exist before it writes lineage rows.
        findMany: async () => [{ id: PRIVATE_SOURCE_CHANNEL_ID }],
        // The room resolvers, which are inside the transaction now.
        findFirst: async () => ({ id: DESTINATION_CHANNEL_ID, label: 'research' }),
        // The destination read the sole-audience decision and the opener's
        // basis are computed from — also inside, so the audience the basis was
        // computed for is the audience the opener was committed to.
        findUniqueOrThrow: async () => destinationRow,
      },
      run: {
        // Serves both of `claimThreadRunOrPend`'s reads: no run already
        // delivered for this message, and no run in flight on the thread.
        findFirst: async () => {
          if (options.claimThrows) throw new Error('claim exploded')
          return null
        },
        create: async ({ data }: { data: { replyPlacement: string; triggerMessageId: string } }) => {
          runsCreated.push({
            replyPlacement: data.replyPlacement,
            triggerMessageId: data.triggerMessageId,
          })
          return { id: RUN_ID }
        },
      },
      runThreadPendingMessage: {
        findFirst: async () => null,
        create: async () => ({}),
      },
      task: { create: async () => ({ id: '00000000-0000-4000-8000-0000000000aa' }) },
    }
    return tx
  }

  const prisma = {
    agent: {
      findMany: async () =>
        options.entitledAgentName === null ? [] : [agentRow(options.entitledAgentName ?? 'Researcher')],
      findFirst: async () => ({ id: TARGET_AGENT_ID }),
    },
    channel: {
      // Home DMs the caller belongs to; none in this fixture.
      findMany: async () => [],
      // Both room resolvers — this file's and `startAgentConversation`'s.
      findFirst: async () => ({ id: DESTINATION_CHANNEL_ID, label: 'research' }),
      findUniqueOrThrow: async () => destinationRow,
    },
    organizationMember: {
      findUnique: async () => ({ deactivatedAt: null, role: 'member' }),
    },
    thread: {
      // Deliberately absent: the conversation is created on the transaction
      // client now, so a `thread.create` reaching the base client at all is the
      // orphan-thread bug coming back.
      findFirst: async () => null,
    },
    // Emulates commit/rollback so "the conversation, the opener and the doorway
    // share one transaction" is an assertion and not a comment: staged writes
    // reach `committed` only when the callback resolves.
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      const staged: Written[] = []
      const stagedThreads: string[] = []
      const result = await work(makeTx(staged, stagedThreads))
      committed.push(...staged)
      committedThreads.push(...stagedThreads)
      return result
    },
    $queryRaw: async () => [],
  }

  const consumed = consumedSources
  const runContext = {
    agent: { agentKind: 'personal_assistant', id: PA_AGENT_ID, systemSlug: null },
    boundAgentIds: [PA_AGENT_ID],
    channel: {
      dmKey: null,
      id: ORIGIN_CHANNEL_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      systemChannelType: null,
      teamId: TEAM_ID,
      visibility: 'private',
    },
    consumedSources: consumed,
    run: { createdAt: new Date(), id: RUN_ID, replyPlacement: null, threadId: ORIGIN_THREAD_ID },
    task: { id: '00000000-0000-4000-8000-0000000000ab' },
  }

  const context = {
    actorContext: options.unattended
      ? {
        actionContext: { requestId: 'unattended' },
        actor: { actorId: PA_AGENT_ID, actorType: 'agent', roles: [] },
        tenant: { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID, teamId: TEAM_ID },
      }
      : {
        actionContext: { effectiveUserId: ACTOR_ID, requestId: 'live' },
        actor: { actorId: ACTOR_ID, actorType: 'user', roles: ['member'] },
        tenant: { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID, teamId: TEAM_ID },
      },
    agentId: PA_AGENT_ID,
    agentKind: 'personal_assistant',
    channel: {
      id: ORIGIN_CHANNEL_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      systemChannelType: null,
      teamId: TEAM_ID,
    },
    consumedSources: consumed,
    prisma,
    realtimeTransport: {
      publishSse: async () => undefined,
      publishWs: async (_scopes: unknown, event: { event: string }) => {
        published.push({ event: event.event })
      },
    },
    run: { id: RUN_ID, interactive: !options.unattended, messageId: OPENER_ID, threadId: ORIGIN_THREAD_ID },
    runContext,
    toolCallId: options.toolCallId ?? null,
  } as unknown as BuiltinToolRuntimeContext

  // The unattended run still needs an acting person to be *for*; a PA run in a
  // DM carries its owner as `effectiveUserId` even when nobody is at the
  // keyboard, which is exactly the case this tool must admit.
  if (options.unattended) {
    ;(context.actorContext.actionContext as { effectiveUserId?: string }).effectiveUserId = ACTOR_ID
  }

  return { basisRows, committed, committedThreads, context, enqueuedKeys, published, runsCreated }
}

test('the opener and the doorway are written, and the doorway carries the ref', async () => {
  const fixture = makeFixture()
  const result = await runAgentConversationStartTool(fixture.context, {
    agent: 'Researcher',
    channel: DESTINATION_CHANNEL_ID,
    message: 'Check what our competitors charge for the team tier.',
  })

  assert.equal(result.toolName, 'agent_conversation_start')
  assert.equal(fixture.committed.length, 2)

  const [opener, doorway] = fixture.committed
  assert.ok(opener && doorway)
  // The opener lands in the NEW conversation; the doorway stays where the ask was.
  assert.equal(opener.threadId, NEW_THREAD_ID)
  assert.equal(opener.content, 'Check what our competitors charge for the team tier.')
  assert.equal(doorway.threadId, ORIGIN_THREAD_ID)
  assert.equal(
    doorway.content,
    'Started a conversation with Researcher: "Check what our competitors charge for the team tier.".',
  )

  // Same transaction, asserted by identity rather than by comment.
  assert.equal(opener.tx, doorway.tx)

  const ref = ConversationRefMetadataSchema.parse(
    (doorway.metadata as { conversationRef: unknown }).conversationRef,
  )
  assert.deepEqual(ref, {
    agentId: TARGET_AGENT_ID,
    channelId: DESTINATION_CHANNEL_ID,
    schemaVersion: 1,
    threadId: NEW_THREAD_ID,
  })

  // The output names the conversation and says the card exists, so the model
  // points at it instead of narrating a status it cannot see.
  const output = JSON.parse(result.outputPreview.split('\n')[0] ?? '{}')
  assert.equal(output.status, 'started')
  assert.equal(output.threadId, NEW_THREAD_ID)
  assert.equal(output.agentId, TARGET_AGENT_ID)
  assert.equal(output.where, '#research (Website)')
  assert.match(result.outputPreview, /live card/)
})

test('the target\'s run is claimed against the opener, unattended and threaded', async () => {
  const fixture = makeFixture()
  await runAgentConversationStartTool(fixture.context, {
    agent: 'Researcher',
    channel: DESTINATION_CHANNEL_ID,
    message: 'Check the pricing page.',
  })

  assert.deepEqual(fixture.runsCreated, [
    { replyPlacement: 'thread', triggerMessageId: OPENER_ID },
  ])
  // Two publications: the doorway on the run's own thread, and the opener on
  // the destination channel's lane.
  assert.deepEqual(fixture.published.map((entry) => entry.event), ['message.new', 'message.new'])
})

test('an unattended run may start a conversation', async () => {
  // Deliberately NOT `agent_handoff`'s rule: "every morning, ask the researcher
  // to…" is the point of this tool, so a scheduled run is admitted.
  const fixture = makeFixture({ unattended: true })
  const result = await runAgentConversationStartTool(fixture.context, {
    agent: 'Researcher',
    channel: DESTINATION_CHANNEL_ID,
    message: 'The morning scan.',
  })

  assert.equal(result.toolName, 'agent_conversation_start')
  assert.equal(fixture.committed.length, 2)
})

test('a failing claim leaves no doorway and no conversation', async () => {
  const fixture = makeFixture({ claimThrows: true })

  await assert.rejects(
    runAgentConversationStartTool(fixture.context, {
      agent: 'Researcher',
      channel: DESTINATION_CHANNEL_ID,
      message: 'Check the pricing page.',
    }),
    /claim exploded/,
  )
  // Nothing committed: a card pointing at work that never started is worse than
  // no card, and the opener would sit in a conversation nobody is answering.
  assert.deepEqual(fixture.committed, [])
  // The thread rolls back with them. Created before the transaction, it
  // survived every failure below it as an empty unnamed conversation sitting in
  // the target agent's list with nothing in it and nobody working on it.
  assert.deepEqual(fixture.committedThreads, [])
})

test('the target run is enqueued under a key the tool call owns', async () => {
  const toolCallId = 'call_5f3a9c'
  const fixture = makeFixture({ toolCallId })
  await runAgentConversationStartTool(fixture.context, {
    agent: 'Researcher',
    channel: DESTINATION_CHANNEL_ID,
    message: 'Check the pricing page.',
  })

  // The same shape peer delegation's `correlationId` uses. A key carrying the
  // new thread's id instead would be different on every redelivery of this very
  // tool call — which is the only thing it has to converge on.
  assert.deepEqual(fixture.enqueuedKeys, [`agent-conversation:${RUN_ID}:${toolCallId}`])
  assert.ok(!fixture.enqueuedKeys[0]?.includes(NEW_THREAD_ID))
})

test('the opener carries the destination\'s basis, not the origin\'s', async () => {
  // A shared destination: what the requester personally satisfies is NOT
  // subtracted, because the room has other readers.
  const fixture = makeFixture({
    consumed: [
      { scopeId: PRIVATE_SOURCE_CHANNEL_ID, scopeType: 'channel' },
      { scopeId: DESTINATION_CHANNEL_ID, scopeType: 'channel' },
      { scopeId: TARGET_AGENT_ID, scopeType: 'agent' },
    ],
  })
  await runAgentConversationStartTool(fixture.context, {
    agent: 'Researcher',
    channel: DESTINATION_CHANNEL_ID,
    message: 'Check the pricing page.',
  })

  const openerBasis = fixture.basisRows
    .filter((row) => row.messageId === OPENER_ID)
    .map((row) => `${row.scopeType}:${row.scopeId}`)
  // The destination channel and its own bound agent are implied there and drop
  // out; the private source the run read does not and is stamped.
  assert.deepEqual(openerBasis, [`channel:${PRIVATE_SOURCE_CHANNEL_ID}`])
})

test('an agent the caller cannot see is "not found", never "forbidden"', async () => {
  const fixture = makeFixture({ entitledAgentName: null })
  await assert.rejects(
    runAgentConversationStartTool(fixture.context, {
      agent: 'Researcher',
      message: 'anything',
    }),
    /can't find an agent called "Researcher"/,
  )
  assert.deepEqual(fixture.committed, [])
})

test('an agent is addressable by the name the person used', async () => {
  const fixture = makeFixture({ entitledAgentName: 'Market Researcher' })
  const result = await runAgentConversationStartTool(fixture.context, {
    // Not the full name: resolution is a filter over the entitlement list, not
    // a guess at an id.
    agent: 'market researcher',
    channel: DESTINATION_CHANNEL_ID,
    message: 'Check the pricing page.',
  })
  assert.equal(result.toolName, 'agent_conversation_start')
})

test('agent_conversations_list prints one line per conversation', async () => {
  const fixture = makeFixture()
  const prisma = fixture.context.prisma as unknown as {
    thread: { findMany: (args: unknown) => Promise<unknown> }
  }
  prisma.thread.findMany = async () => [
    {
      agentId: TARGET_AGENT_ID,
      channel: {
        agentBindings: [{ agentId: TARGET_AGENT_ID, principalUserId: null }],
        id: DESTINATION_CHANNEL_ID,
        label: 'research',
        systemChannelType: null,
        team: { project: { channelRoot: false, name: 'Website' } },
        type: 'standard',
      },
      createdAt: new Date('2026-09-08T09:00:00.000Z'),
      id: NEW_THREAD_ID,
      startedByUserId: ACTOR_ID,
      title: 'Pricing scan',
    },
  ]

  const result = await runAgentConversationsListTool(fixture.context, { agent: 'Researcher' })

  assert.equal(result.toolName, 'agent_conversations_list')
  // No active run and no terminal one in the fakes, so the structural answer is
  // "idle" — never a status composed from what the conversation says.
  assert.match(
    result.outputPreview,
    new RegExp(`- Pricing scan · #research \\(Website\\) · idle · thread=${NEW_THREAD_ID}`),
  )
})

test('agent_conversations_list refuses an agent the caller cannot see', async () => {
  const fixture = makeFixture({ entitledAgentName: null })
  await assert.rejects(
    runAgentConversationsListTool(fixture.context, { agent: 'Researcher' }),
    /can't find an agent called "Researcher"/,
  )
})

test('conversation_reference refuses a thread the acting person cannot see', async () => {
  const fixture = makeFixture()
  await assert.rejects(
    runConversationReferenceTool(fixture.context, {
      conversation: '00000000-0000-4000-8000-0000000000c1',
    }),
    /can't find that conversation/,
  )
  assert.deepEqual(fixture.committed, [])
})

test('conversation_reference refuses an id that is not a thread id at all', async () => {
  const fixture = makeFixture()
  await assert.rejects(
    runConversationReferenceTool(fixture.context, { conversation: 'the pricing one' }),
    /thread id/,
  )
})

test('an autonomous run may only reference a conversation in its own channel', async () => {
  const fixture = makeFixture({ unattended: true })
  // No acting person at all: strip the delegated identity the fixture adds.
  delete (fixture.context.actorContext.actionContext as { effectiveUserId?: string }).effectiveUserId

  await assert.rejects(
    runConversationReferenceTool(fixture.context, {
      conversation: '00000000-0000-4000-8000-0000000000c2',
    }),
    /only show a conversation from this very channel/,
  )
  assert.deepEqual(fixture.committed, [])
})

test('a reference the run may make posts one message carrying the doorway', async () => {
  const fixture = makeFixture({ unattended: true })
  delete (fixture.context.actorContext.actionContext as { effectiveUserId?: string }).effectiveUserId
  const prisma = fixture.context.prisma as unknown as {
    thread: { findFirst: () => Promise<unknown> }
  }
  prisma.thread.findFirst = async () => ({
    agentId: TARGET_AGENT_ID,
    channel: { agentBindings: [{ agentId: TARGET_AGENT_ID }], id: ORIGIN_CHANNEL_ID, label: 'research' },
    id: NEW_THREAD_ID,
    title: 'Pricing scan',
  })

  const result = await runConversationReferenceTool(fixture.context, {
    conversation: NEW_THREAD_ID,
    note: 'This is the scan I mentioned.',
  })

  assert.equal(result.toolName, 'conversation_reference')
  assert.equal(fixture.committed.length, 1)
  const [posted] = fixture.committed
  assert.ok(posted)
  assert.equal(posted.threadId, ORIGIN_THREAD_ID)
  assert.equal(posted.content, 'This is the scan I mentioned.')
  assert.deepEqual(
    ConversationRefMetadataSchema.parse(
      (posted.metadata as { conversationRef: unknown }).conversationRef,
    ),
    {
      agentId: TARGET_AGENT_ID,
      channelId: ORIGIN_CHANNEL_ID,
      schemaVersion: 1,
      threadId: NEW_THREAD_ID,
    },
  )
})
