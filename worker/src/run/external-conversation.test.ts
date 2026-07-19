import assert from 'node:assert/strict'
import test from 'node:test'

import type { SecretResolver } from '@nessie/mcp-manage'
import type { LedgerAttribution } from '@nessie/runtime'
import type {
  McpTransportConfig,
  RunExecuteJobPayload,
} from '@nessie/schemas'

import { runExternalConversation, type ExternalChatCaller } from './external-conversation.js'
import type { ExecutionDependencies, RunContext } from './execute/types.js'

const ORG = '00000000-0000-4000-8000-000000000001'
const CHANNEL = '00000000-0000-4000-8000-000000000002'
const AGENT = '00000000-0000-4000-8000-000000000003'
const RUN = '00000000-0000-4000-8000-000000000004'
const THREAD = '00000000-0000-4000-8000-000000000005'
const TASK = '00000000-0000-4000-8000-000000000006'
const USER = '00000000-0000-4000-8000-000000000007'
const INSTANCE = '00000000-0000-4000-8000-000000000008'
const TEAM = '00000000-0000-4000-8000-000000000009'
const APP_KEY = `dsk_${'n'.repeat(32)}`

const DM_KEY = `extagent:deepsignal:${ORG}:${USER}`

type Captured = {
  messages: Array<{ content: string; metadata: unknown; role: string }>
  runStatus: string[]
  taskStatus: string[]
  agentStatus: string[]
  threadMetadata: unknown[]
  connectorUsage: Array<{ success: boolean | null | undefined }>
  sse: Array<{ event: string; data: unknown }>
  inboundUpdates: Array<{ id: string; metadata: unknown }>
  identities: Array<{
    attribution: LedgerAttribution
    audience: string
    toolCallId: string
  }>
}

type HarnessOptions = {
  canonicalCatalog?: boolean
  instance?: boolean
  lifecycleState?: string
  credentialRef?: string
  threadMetadata?: unknown
}

const makeHarness = (opts: HarnessOptions = {}) => {
  const captured: Captured = {
    messages: [],
    runStatus: [],
    taskStatus: [],
    agentStatus: [],
    threadMetadata: [],
    connectorUsage: [],
    sse: [],
    inboundUpdates: [],
    identities: [],
  }

  let threadMeta: unknown = opts.threadMetadata ?? {}
  const inboundMessages = new Map<string, { metadata: unknown }>([
    ['msg-in', { metadata: { mentions: { userIds: [], agentIds: [], broadcast: null } } }],
  ])

  const prisma = {
    run: {
      updateMany: async () => ({ count: 1 }),
      update: async ({ data }: { data: { status: string } }) => {
        captured.runStatus.push(data.status)
        return {}
      },
    },
    task: {
      update: async ({ data }: { data: { status: string } }) => {
        captured.taskStatus.push(data.status)
        return {}
      },
    },
    agent: {
      update: async ({ data }: { data: { status: string } }) => {
        captured.agentStatus.push(data.status)
        return {}
      },
    },
    channel: {
      findUnique: async () => ({ dmKey: DM_KEY, label: 'DeepSignal' }),
    },
    mcpServerInstance: {
      findFirst: async (args: {
        where: {
          catalogEntry?: {
            integratedProducts?: { some: { slug: string } }
          }
        }
      }) =>
        opts.instance === false
        || opts.canonicalCatalog === false
        || args.where.catalogEntry?.integratedProducts?.some.slug !== 'deepsignal'
          ? null
          : {
              credentialRef:
                opts.credentialRef ?? 'DEEPSIGNAL_MCP_APP_KEY',
              id: INSTANCE,
            },
      findUnique: async () => ({
        id: INSTANCE,
        credentialRef: opts.credentialRef ?? 'DEEPSIGNAL_MCP_APP_KEY',
        transportConfig: {},
        lifecycleState: opts.lifecycleState ?? 'active',
        catalogEntry: {
          authConfig: { method: 'bearer' },
          authMethod: 'bearer',
          defaultTransportConfig: { transport: 'http', url: 'https://api.deepsignal.live/mcp' },
        },
      }),
    },
    mcpServerCredentialOverride: {
      findUnique: async () => null,
    },
    thread: {
      findUnique: async () => ({ metadata: threadMeta }),
      update: async ({ data }: { data: { metadata: unknown } }) => {
        threadMeta = data.metadata
        captured.threadMetadata.push(data.metadata)
        return {}
      },
    },
    message: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        inboundMessages.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { metadata: unknown } }) => {
        inboundMessages.set(where.id, { metadata: data.metadata })
        captured.inboundUpdates.push({ id: where.id, metadata: data.metadata })
        return { id: where.id }
      },
      create: async ({ data }: { data: { content: string; metadata: unknown; role: string } }) => {
        captured.messages.push({ content: data.content, metadata: data.metadata, role: data.role })
        return { id: 'msg-out', content: data.content, createdAt: new Date() }
      },
    },
    connectorUsageEvent: {
      create: async ({ data }: { data: { success: boolean | null | undefined } }) => {
        captured.connectorUsage.push({ success: data.success })
        return {}
      },
    },
  }

  const realtimeTransport = {
    publishSse: async (_threadId: string, event: string, data: unknown) => {
      captured.sse.push({ event, data })
    },
    publishWs: async () => undefined,
  }

  const modelClient = new Proxy(
    {},
    {
      get() {
        throw new Error('inference model client must never be touched by the external driver')
      },
    },
  )

  const deps = {
    prisma,
    realtimeTransport,
    modelClient,
    deepSignalMcpIdentity: {
      credentialRef: 'DEEPSIGNAL_MCP_APP_KEY',
      validateStoredCredentialSeparation: async () => undefined,
      requestHeaders: async (
        attribution: LedgerAttribution,
        options: { audience: string; toolCallId: string },
      ) => {
        captured.identities.push({ attribution, ...options })
        return {
          'X-Nessie-Context': `context:${options.toolCallId}`,
          'X-UOA-Delegation': 'delegation',
        }
      },
    },
    queueProvider: {},
    searchConfig: {},
  } as unknown as ExecutionDependencies

  const payload = {
    runId: RUN,
    taskId: TASK,
    messageId: 'msg-in',
    actorContext: {
      actor: { actorType: 'user', actorId: USER, roles: [] },
      tenant: { organizationId: ORG, teamId: TEAM },
      actionContext: { requestId: 'worker-request' },
    },
  } as unknown as RunExecuteJobPayload

  const context: RunContext = {
    agent: {
      agentKind: 'shared',
      executionMode: 'external_mcp',
      id: AGENT,
      name: 'DeepSignal',
      model: null,
      parentAgentId: null,
      provider: null,
      systemPrompt: null,
    },
    channel: { id: CHANNEL, organizationId: ORG, systemChannelType: 'external_agent' },
    run: { id: RUN, threadId: THREAD },
    task: { id: TASK },
  }

  return { deps, payload, context, captured }
}

const appKeyResolver: SecretResolver = {
  resolve: async (ref) =>
    ref === 'DEEPSIGNAL_MCP_APP_KEY' ? APP_KEY : null,
}

const optionsFor = (
  callChat: ExternalChatCaller,
): { callChat: ExternalChatCaller; secretResolver: SecretResolver } => ({
  callChat,
  secretResolver: appKeyResolver,
})

const assertDeepSignalTransport = (transport: McpTransportConfig): void => {
  assert.notEqual(transport.transport, 'stdio')
  if (transport.transport === 'stdio') return
  assert.equal(transport.headers?.Authorization, `Bearer ${APP_KEY}`)
  assert.equal(transport.headers?.['X-Nessie-Context'], `context:${RUN}:chat`)
  assert.equal(transport.headers?.['X-UOA-Delegation'], 'delegation')
}

const lastMessage = (captured: Captured): { content: string; metadata: unknown; role: string } => {
  const message = captured.messages.at(-1)
  if (!message) throw new Error('no assistant message was persisted')
  return message
}

const allCards = (captured: Captured): Array<Record<string, unknown>> => {
  const bag = lastMessage(captured).metadata as { uiCards?: unknown }
  return Array.isArray(bag.uiCards) ? (bag.uiCards as Array<Record<string, unknown>>) : []
}

const cardAt = (captured: Captured, index: number): Record<string, unknown> => {
  const card = allCards(captured)[index]
  if (!card) throw new Error(`no ui card at index ${index}`)
  return card
}

test('happy path: persists reply with mapped uiCards, external ids, and saved conversationId', async () => {
  const { deps, payload, context, captured } = makeHarness()
  let seenArgs: Record<string, unknown> | null = null
  const callChat: ExternalChatCaller = async ({ args, transport }) => {
    seenArgs = args
    assertDeepSignalTransport(transport)
    return {
      success: true,
      raw: {},
      output: JSON.stringify({
        conversationId: 'conv-9',
        userTurnId: 'uturn-2',
        turnId: 'turn-3',
        reply: 'Here are your signals.',
        activities: [{ label: 'Scan markets', status: 'complete' }],
        cards: [{ title: 'AAPL risk', status: 'warning', summary: 'Volatility rising.' }],
      }),
    }
  }

  await runExternalConversation(
    deps,
    payload,
    context,
    'What is new?',
    optionsFor(callChat),
  )

  assert.equal(captured.messages.length, 1)
  const message = lastMessage(captured)
  assert.equal(message.content, 'Here are your signals.')
  assert.equal(message.role, 'assistant')

  assert.equal(allCards(captured).length, 2)
  assert.equal(cardAt(captured, 0).kind, 'integration')
  assert.equal(cardAt(captured, 0).productSlug, 'deepsignal')
  assert.equal(cardAt(captured, 0).status, 'completed') // activity `complete` -> `completed`
  assert.equal(cardAt(captured, 1).status, 'warning')

  const external = (message.metadata as { external?: Record<string, unknown> }).external
  assert.deepEqual(external, { product: 'deepsignal', conversationId: 'conv-9', turnId: 'turn-3' })

  assert.deepEqual(captured.threadMetadata.at(-1), { deepsignal: { conversationId: 'conv-9' } })

  assert.deepEqual(seenArgs, { input: 'What is new?' })
  assert.equal(captured.identities.length, 1)
  assert.equal(captured.identities[0]?.audience, 'https://api.deepsignal.live')
  assert.equal(captured.identities[0]?.toolCallId, `${RUN}:chat`)
  assert.equal(captured.identities[0]?.attribution.userId, USER)
  assert.equal(captured.identities[0]?.attribution.teamId, TEAM)
  assert.equal(captured.identities[0]?.attribution.agentId, AGENT)
  assert.equal(captured.identities[0]?.attribution.runId, RUN)
  assert.ok(captured.runStatus.includes('completed'))
  assert.deepEqual(captured.connectorUsage, [{ success: true }])
  assert.ok(captured.sse.some((e) => e.event === 'stream.start'))
  assert.ok(captured.sse.some((e) => e.event === 'stream.done'))

  assert.equal(captured.inboundUpdates.length, 1)
  const inbound = captured.inboundUpdates[0]
  if (!inbound) throw new Error('expected an inbound message update')
  assert.equal(inbound.id, 'msg-in')
  const inboundMeta = inbound.metadata as { mentions?: unknown; external?: Record<string, unknown> }
  assert.ok(inboundMeta.mentions, 'existing mentions key is preserved')
  assert.deepEqual(inboundMeta.external, {
    product: 'deepsignal',
    conversationId: 'conv-9',
    turnId: 'uturn-2',
  })
})

test('older DeepSignal (no userTurnId) leaves the inbound user message untagged', async () => {
  const { deps, payload, context, captured } = makeHarness()
  const callChat: ExternalChatCaller = async () => ({
    success: true,
    raw: {},
    output: JSON.stringify({ conversationId: 'conv-9', turnId: 'turn-3', reply: 'ok' }),
  })

  await runExternalConversation(deps, payload, context, 'hi', optionsFor(callChat))

  assert.equal(captured.inboundUpdates.length, 0, 'no tagging without userTurnId')
})

test('same-name public catalog without the canonical product link is never dispatched', async () => {
  const { deps, payload, context, captured } = makeHarness({
    canonicalCatalog: false,
  })
  let dispatched = false

  await runExternalConversation(
    deps,
    payload,
    context,
    'hi',
    optionsFor(async () => {
      dispatched = true
      throw new Error('must not dispatch through a decoy catalog')
    }),
  )

  assert.equal(dispatched, false)
  assert.equal(captured.identities.length, 0)
  assert.match(lastMessage(captured).content, /not connected/i)
})

test('concurrent first turns reuse one conversation (per-thread race guard)', async () => {
  const { deps, payload, context } = makeHarness()
  const calls: Array<Record<string, unknown>> = []
  const callChat: ExternalChatCaller = async ({ args }) => {
    calls.push(args)
    if (!('conversationId' in args)) {
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    return {
      success: true,
      raw: {},
      output: JSON.stringify({
        conversationId: 'conv-race',
        userTurnId: 'uturn-x',
        turnId: 'turn-x',
        reply: 'ok',
      }),
    }
  }

  await Promise.all([
    runExternalConversation(deps, payload, context, 'first', optionsFor(callChat)),
    runExternalConversation(deps, payload, context, 'second', optionsFor(callChat)),
  ])

  assert.equal(calls.length, 2)
  const minted = calls.filter((a) => !('conversationId' in a))
  const reused = calls.filter((a) => a.conversationId === 'conv-race')
  assert.equal(minted.length, 1, 'only the first turn mints a conversation')
  assert.equal(reused.length, 1, 'the second turn reuses the stored conversationId')
})

test('reuses the stored conversationId on a follow-up turn', async () => {
  const { deps, payload, context } = makeHarness({
    threadMetadata: { deepsignal: { conversationId: 'conv-existing' } },
  })
  let seenArgs: Record<string, unknown> | null = null
  const callChat: ExternalChatCaller = async ({ args, transport }) => {
    seenArgs = args
    assertDeepSignalTransport(transport)
    return { success: true, raw: {}, output: JSON.stringify({ reply: 'ok', conversationId: 'conv-existing' }) }
  }

  await runExternalConversation(
    deps,
    payload,
    context,
    'follow up',
    optionsFor(callChat),
  )

  assert.deepEqual(seenArgs, { input: 'follow up', conversationId: 'conv-existing' })
})

test('missing user-scoped instance yields a needs_setup card and completes without calling MCP', async () => {
  const { deps, payload, context, captured } = makeHarness({ instance: false })
  let called = false
  const callChat: ExternalChatCaller = async () => {
    called = true
    return { success: true, raw: {}, output: '{}' }
  }

  await runExternalConversation(deps, payload, context, 'hi', optionsFor(callChat))

  assert.equal(called, false)
  assert.equal(captured.messages.length, 1)
  assert.equal(allCards(captured).length, 1)
  assert.equal(cardAt(captured, 0).status, 'needs_setup')
  assert.ok(captured.runStatus.includes('completed'))
  assert.equal(captured.connectorUsage.length, 0)
})

test('MCP transport error yields a failed card and marks the run failed', async () => {
  const { deps, payload, context, captured } = makeHarness()
  const callChat: ExternalChatCaller = async () => {
    throw new Error('HTTP 503 service unavailable')
  }

  await runExternalConversation(deps, payload, context, 'hi', optionsFor(callChat))

  assert.equal(cardAt(captured, 0).status, 'failed')
  assert.ok(captured.runStatus.includes('failed'))
  assert.deepEqual(captured.connectorUsage, [{ success: false }])
  assert.ok(captured.agentStatus.includes('error'))
})

test('app-key auth failure is an admin repair, never a user reconnect prompt', async () => {
  const { deps, payload, context, captured } = makeHarness()
  const callChat: ExternalChatCaller = async () => {
    throw new Error('401 Unauthorized: token expired')
  }

  await runExternalConversation(deps, payload, context, 'hi', optionsFor(callChat))

  assert.equal(cardAt(captured, 0).status, 'failed')
  assert.match(lastMessage(captured).content, /application credential/)
  assert.ok(captured.runStatus.includes('failed'))
  assert.deepEqual(captured.connectorUsage, [{ success: false }])
})

test('inactive managed app-key instance is surfaced as needs_setup', async () => {
  const { deps, payload, context, captured } = makeHarness({ lifecycleState: 'pending_setup' })
  let called = false
  const callChat: ExternalChatCaller = async () => {
    called = true
    return { success: true, raw: {}, output: '{}' }
  }

  await runExternalConversation(deps, payload, context, 'hi', optionsFor(callChat))

  assert.equal(called, false)
  assert.equal(cardAt(captured, 0).status, 'needs_setup')
  assert.ok(captured.runStatus.includes('completed'))
})

test('DeepSignal never falls back to a generic or per-user credential', async () => {
  const { deps, payload, context, captured } = makeHarness({
    credentialRef: 'secret_oauth_obsolete',
  })
  let called = false
  await runExternalConversation(
    deps,
    payload,
    context,
    'hi',
    optionsFor(async () => {
      called = true
      return { success: true, raw: {}, output: '{}' }
    }),
  )

  assert.equal(called, false)
  assert.equal(cardAt(captured, 0).status, 'needs_setup')
  assert.equal(captured.identities.length, 0)
})
