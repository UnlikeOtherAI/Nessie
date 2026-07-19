import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { McpToolResult } from '@nessie/mcp-client'
import type { SecretResolver } from '@nessie/mcp-manage'
import type {
  DeepSignalMcpIdentityService,
  LedgerAttribution,
} from '@nessie/runtime'
import type { McpTransportConfig } from '@nessie/schemas'

import { syncExternalAgentChannel } from '../src/services/external-agent-sync.js'

/**
 * Purpose-built in-memory Prisma fake for the DeepSignal history-hydration
 * service. Stateful message store so idempotency (turnId dedupe) is meaningful.
 */
const ORG = '00000000-0000-4000-8000-0000000000a1'
const USER = '00000000-0000-4000-8000-0000000000b2'
const CHANNEL = {
  id: '00000000-0000-4000-8000-0000000000c3',
  dmKey: `extagent:deepsignal:${ORG}:${USER}:uoa-team`,
}
const APP_KEY = `dsk_${'n'.repeat(32)}`

const attribution: LedgerAttribution = {
  actorId: USER,
  actorType: 'user',
  organizationId: ORG,
  requestId: 'sync-request',
  teamId: '00000000-0000-4000-8000-0000000000d4',
  userId: USER,
}

const appKeyResolver: SecretResolver = {
  resolve: async (ref) =>
    ref === 'DEEPSIGNAL_MCP_APP_KEY' ? APP_KEY : null,
}

const identityService = (
  calls: Array<{ audience: string; toolCallId: string }> = [],
): DeepSignalMcpIdentityService => ({
  credentialRef: 'DEEPSIGNAL_MCP_APP_KEY',
  validateStoredCredentialSeparation: async () => undefined,
  requestHeaders: async (_attribution, options) => {
    calls.push(options)
    return {
      'X-Nessie-Context': `context:${options.toolCallId}`,
      'X-UOA-Delegation': 'delegation',
    }
  },
})

type StoredMessage = { threadId: string; role: string; metadata: Record<string, unknown> }

const makeFake = (
  initialThreadMetadata: Record<string, unknown> = {},
  credentialRef = 'DEEPSIGNAL_MCP_APP_KEY',
) => {
  const messages: StoredMessage[] = []
  let threadMetadata: Record<string, unknown> = initialThreadMetadata
  const self = {
    messages,
    get threadMetadata() {
      return threadMetadata
    },
    mcpServerInstance: {
      findFirst: async () => ({
        credentialRef,
        id: 'inst-1',
      }),
      findUnique: async (args: { select: Record<string, unknown> }) => {
        if ('credentialRef' in args.select) {
          return {
            credentialRef,
            id: 'inst-1',
          }
        }
        return {
          transportConfig: {},
          lifecycleState: 'active',
          catalogEntry: {
            authConfig: { method: 'bearer' },
            authMethod: 'bearer',
            defaultTransportConfig: {
              transport: 'http',
              url: 'https://api.deepsignal.live/mcp',
            },
          },
        }
      },
    },
    mcpServerCredentialOverride: {
      findUnique: async () => null,
    },
    thread: {
      findFirst: async () => ({ id: 'thread-1' }),
      create: async () => ({ id: 'thread-1' }),
      findUnique: async () => ({ metadata: threadMetadata }),
      update: async (args: { data: { metadata: Record<string, unknown> } }) => {
        threadMetadata = args.data.metadata
        return { id: 'thread-1' }
      },
    },
    agentBinding: {
      findFirst: async () => ({ agentId: 'agent-1' }),
    },
    message: {
      findMany: async (args: { where: { threadId: string } }) =>
        messages.filter((m) => m.threadId === args.where.threadId).map((m) => ({ metadata: m.metadata })),
      create: async (args: { data: StoredMessage }) => {
        messages.push(args.data)
        return { id: `msg-${messages.length}` }
      },
    },
  }
  return self
}

const asPrisma = (fake: ReturnType<typeof makeFake>): PrismaClient => fake as unknown as PrismaClient

const toolResult = (value: unknown): McpToolResult => ({
  isError: false,
  content: [],
  structuredContent: value as Record<string, unknown>,
})

const historyTurns = () => [
  { id: 't2', role: 'colleague', reply: 'Second', activities: [], cards: [], createdAt: '2026-07-09T10:05:00Z' },
  { id: 't1', role: 'user', input: 'First', createdAt: '2026-07-09T10:00:00Z' },
]

test('hydration adopts the most recent conversation from conversation_list', async () => {
  const fake = makeFake({})
  const calls: string[] = []
  const identityCalls: Array<{ audience: string; toolCallId: string }> = []
  const callTool = async (input: {
    toolName: string
    transport: McpTransportConfig
  }): Promise<McpToolResult> => {
    calls.push(input.toolName)
    assert.equal(
      input.transport.headers?.Authorization,
      `Bearer ${APP_KEY}`,
    )
    assert.equal(
      input.transport.headers?.['X-Nessie-Context'],
      `context:sync-request:${input.toolName}`,
    )
    assert.equal(
      input.transport.headers?.['X-UOA-Delegation'],
      'delegation',
    )
    if (input.toolName === 'conversation_list') {
      return toolResult({
        conversations: [
          { id: 'conv-old', updatedAt: '2026-07-01T00:00:00Z' },
          { id: 'conv-new', updatedAt: '2026-07-09T00:00:00Z' },
        ],
      })
    }
    return toolResult({ turns: historyTurns() })
  }

  const result = await syncExternalAgentChannel(
    asPrisma(fake),
    CHANNEL,
    {
      attribution,
      deepSignalIdentity: identityService(identityCalls),
      organizationId: ORG,
      userId: USER,
      callTool,
    },
    appKeyResolver,
  )

  assert.deepEqual(calls, ['conversation_list', 'conversation_history'])
  assert.deepEqual(identityCalls, [
    {
      audience: 'https://api.deepsignal.live',
      toolCallId: 'sync-request:conversation_list',
    },
    {
      audience: 'https://api.deepsignal.live',
      toolCallId: 'sync-request:conversation_history',
    },
  ])
  assert.equal(result.total, 2)
  assert.equal(result.imported, 2)
  // The newest conversation was adopted and stored on the thread.
  assert.equal((fake.threadMetadata.deepsignal as { conversationId: string }).conversationId, 'conv-new')
})

test('hydration is idempotent on turnId across repeated syncs', async () => {
  const fake = makeFake({ deepsignal: { conversationId: 'conv-x' } })
  const callTool = async (input: { toolName: string }): Promise<McpToolResult> => {
    // No conversation_list call expected — conversationId already on thread.
    assert.notEqual(input.toolName, 'conversation_list')
    return toolResult({ turns: historyTurns() })
  }

  const first = await syncExternalAgentChannel(
    asPrisma(fake),
    CHANNEL,
    {
      attribution,
      deepSignalIdentity: identityService(),
      organizationId: ORG,
      userId: USER,
      callTool,
    },
    appKeyResolver,
  )
  assert.equal(first.imported, 2)
  assert.equal(fake.messages.length, 2)

  const second = await syncExternalAgentChannel(
    asPrisma(fake),
    CHANNEL,
    {
      attribution,
      deepSignalIdentity: identityService(),
      organizationId: ORG,
      userId: USER,
      callTool,
    },
    appKeyResolver,
  )
  assert.equal(second.total, 2)
  assert.equal(second.imported, 0, 'already-seen turns are skipped')
  assert.equal(fake.messages.length, 2, 'no duplicate rows written')

  // Roles + external key mapped correctly.
  const colleague = fake.messages.find((m) => m.role === 'assistant')
  const user = fake.messages.find((m) => m.role === 'user')
  assert.equal((colleague?.metadata.external as { turnId: string }).turnId, 't2')
  assert.equal((user?.metadata.external as { turnId: string }).turnId, 't1')
})

test('hydration skips a user turn already tagged live by the worker driver', async () => {
  const fake = makeFake({ deepsignal: { conversationId: 'conv-x' } })
  // Simulate the live path: the worker driver already persisted the user turn
  // (metadata.mentions from the send path + metadata.external.turnId it tagged).
  fake.messages.push({
    threadId: 'thread-1',
    role: 'user',
    metadata: {
      mentions: { userIds: [], agentIds: [], broadcast: null },
      external: { product: 'deepsignal', conversationId: 'conv-x', turnId: 't1' },
    },
  })

  const callTool = async (): Promise<McpToolResult> => toolResult({ turns: historyTurns() })

  const result = await syncExternalAgentChannel(
    asPrisma(fake),
    CHANNEL,
    {
      attribution,
      deepSignalIdentity: identityService(),
      organizationId: ORG,
      userId: USER,
      callTool,
    },
    appKeyResolver,
  )

  assert.equal(result.total, 2)
  assert.equal(result.imported, 1, 'only the colleague turn is imported; the tagged user turn dedupes')
  // No second copy of the user turn t1 was created.
  const userTurns = fake.messages.filter((m) => m.role === 'user')
  assert.equal(userTurns.length, 1, 'the live-tagged user turn is not duplicated')
})

test('hydration is a no-op when no conversation exists yet', async () => {
  const fake = makeFake({})
  const callTool = async (input: { toolName: string }): Promise<McpToolResult> => {
    if (input.toolName === 'conversation_list') return toolResult({ conversations: [] })
    throw new Error('conversation_history should not be called with no conversation')
  }
  const result = await syncExternalAgentChannel(
    asPrisma(fake),
    CHANNEL,
    {
      attribution,
      deepSignalIdentity: identityService(),
      organizationId: ORG,
      userId: USER,
      callTool,
    },
    appKeyResolver,
  )
  assert.deepEqual(result, { imported: 0, total: 0 })
  assert.equal(fake.messages.length, 0)
})

test('hydration never falls back to a generic or per-user credential', async () => {
  const fake = makeFake({}, 'secret_oauth_obsolete')
  let callCount = 0
  const result = await syncExternalAgentChannel(
    asPrisma(fake),
    CHANNEL,
    {
      attribution,
      deepSignalIdentity: identityService(),
      organizationId: ORG,
      userId: USER,
      callTool: async () => {
        callCount += 1
        return toolResult({})
      },
    },
    appKeyResolver,
  )

  assert.deepEqual(result, { imported: 0, total: 0 })
  assert.equal(callCount, 0)
})
