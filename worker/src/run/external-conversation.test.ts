import assert from 'node:assert/strict'
import test from 'node:test'

import type { RunExecuteJobPayload } from '@nessie/schemas'

import { runExternalConversation, type ExternalChatCaller } from './external-conversation.js'
import type { ExecutionDependencies, RunContext } from './execute/types.js'

/**
 * External-conversation driver: proxies a DM turn to an external product over
 * MCP with ZERO Nessie inference. Uses fake prisma / realtime / MCP caller. The
 * injected model client throws on any access, so a regression that reintroduced
 * an inference call would fail the test loudly ("inference path never invoked").
 */

const ORG = '00000000-0000-4000-8000-000000000001'
const CHANNEL = '00000000-0000-4000-8000-000000000002'
const AGENT = '00000000-0000-4000-8000-000000000003'
const RUN = '00000000-0000-4000-8000-000000000004'
const THREAD = '00000000-0000-4000-8000-000000000005'
const TASK = '00000000-0000-4000-8000-000000000006'
const USER = '00000000-0000-4000-8000-000000000007'
const INSTANCE = '00000000-0000-4000-8000-000000000008'

const DM_KEY = `extagent:deepsignal:${ORG}:${USER}`

type Captured = {
  messages: Array<{ content: string; metadata: unknown; role: string }>
  runStatus: string[]
  taskStatus: string[]
  agentStatus: string[]
  threadMetadata: unknown[]
  connectorUsage: Array<{ success: boolean | null | undefined }>
  sse: Array<{ event: string; data: unknown }>
}

type HarnessOptions = {
  instance?: boolean
  lifecycleState?: string
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
  }

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
      findFirst: async () => (opts.instance === false ? null : { id: INSTANCE }),
      findUnique: async () => ({
        id: INSTANCE,
        credentialRef: null,
        transportConfig: {},
        lifecycleState: opts.lifecycleState ?? 'active',
        catalogEntry: {
          authConfig: { method: 'oauth2' },
          authMethod: 'oauth2',
          defaultTransportConfig: { transport: 'http', url: 'https://api.deepsignal.live/mcp' },
        },
      }),
    },
    mcpServerCredentialOverride: {
      findUnique: async () => null,
    },
    thread: {
      findUnique: async () => ({ metadata: opts.threadMetadata ?? {} }),
      update: async ({ data }: { data: { metadata: unknown } }) => {
        captured.threadMetadata.push(data.metadata)
        return {}
      },
    },
    message: {
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

  // Any access to the model client throws — proves inference is never invoked.
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
    queueProvider: {},
    searchConfig: {},
  } as unknown as ExecutionDependencies

  const payload = {
    runId: RUN,
    taskId: TASK,
    messageId: 'msg-in',
    actorContext: {
      actor: { actorType: 'user', actorId: USER, roles: [] },
      tenant: { organizationId: ORG },
      actionContext: {},
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
  const callChat: ExternalChatCaller = async ({ args }) => {
    seenArgs = args
    return {
      success: true,
      raw: {},
      output: JSON.stringify({
        conversationId: 'conv-9',
        turnId: 'turn-3',
        reply: 'Here are your signals.',
        activities: [{ label: 'Scan markets', status: 'complete' }],
        cards: [{ title: 'AAPL risk', status: 'warning', summary: 'Volatility rising.' }],
      }),
    }
  }

  await runExternalConversation(deps, payload, context, 'What is new?', { callChat })

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

  // conversationId persisted on the thread under the product slug.
  assert.deepEqual(captured.threadMetadata.at(-1), { deepsignal: { conversationId: 'conv-9' } })

  assert.deepEqual(seenArgs, { input: 'What is new?' })
  assert.ok(captured.runStatus.includes('completed'))
  assert.deepEqual(captured.connectorUsage, [{ success: true }])
  assert.ok(captured.sse.some((e) => e.event === 'stream.start'))
  assert.ok(captured.sse.some((e) => e.event === 'stream.done'))
})

test('reuses the stored conversationId on a follow-up turn', async () => {
  const { deps, payload, context } = makeHarness({
    threadMetadata: { deepsignal: { conversationId: 'conv-existing' } },
  })
  let seenArgs: Record<string, unknown> | null = null
  const callChat: ExternalChatCaller = async ({ args }) => {
    seenArgs = args
    return { success: true, raw: {}, output: JSON.stringify({ reply: 'ok', conversationId: 'conv-existing' }) }
  }

  await runExternalConversation(deps, payload, context, 'follow up', { callChat })

  assert.deepEqual(seenArgs, { input: 'follow up', conversationId: 'conv-existing' })
})

test('missing user-scoped instance yields a needs_setup card and completes without calling MCP', async () => {
  const { deps, payload, context, captured } = makeHarness({ instance: false })
  let called = false
  const callChat: ExternalChatCaller = async () => {
    called = true
    return { success: true, raw: {}, output: '{}' }
  }

  await runExternalConversation(deps, payload, context, 'hi', { callChat })

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

  await runExternalConversation(deps, payload, context, 'hi', { callChat })

  assert.equal(cardAt(captured, 0).status, 'failed')
  assert.ok(captured.runStatus.includes('failed'))
  assert.deepEqual(captured.connectorUsage, [{ success: false }])
  assert.ok(captured.agentStatus.includes('error'))
})

test('expired auth (401) yields a needs_setup card and completes cleanly', async () => {
  const { deps, payload, context, captured } = makeHarness()
  const callChat: ExternalChatCaller = async () => {
    throw new Error('401 Unauthorized: token expired')
  }

  await runExternalConversation(deps, payload, context, 'hi', { callChat })

  assert.equal(cardAt(captured, 0).status, 'needs_setup')
  assert.ok(captured.runStatus.includes('completed'))
  assert.deepEqual(captured.connectorUsage, [{ success: false }])
})

test('unconnected OAuth instance (pending) is surfaced as needs_setup', async () => {
  const { deps, payload, context, captured } = makeHarness({ lifecycleState: 'pending_setup' })
  let called = false
  const callChat: ExternalChatCaller = async () => {
    called = true
    return { success: true, raw: {}, output: '{}' }
  }

  await runExternalConversation(deps, payload, context, 'hi', { callChat })

  assert.equal(called, false)
  assert.equal(cardAt(captured, 0).status, 'needs_setup')
  assert.ok(captured.runStatus.includes('completed'))
})
