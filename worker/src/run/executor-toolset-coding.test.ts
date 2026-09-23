import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { ExecutorCodingSessionsFacts } from '@nessie/schemas'

import { CODING_SESSION_TOOL_NAME_SET } from './coding-session-tools.js'
import { CODING_WAIT_TOOL_TIMEOUT_MS } from './coding-session-wait.js'
import { executorToolTimeoutMs, ExecutorUnknownOutcomeError } from './executor-command-timing.js'
import { buildExecutorToolset } from './executor-toolset.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const agentId = '00000000-0000-4000-8000-000000000002'
const runId = '00000000-0000-4000-8000-000000000003'
const owner = '00000000-0000-4000-8000-000000000004'

const facts: ExecutorCodingSessionsFacts = {
  agents: ['claude'], allowedToolCount: 3, configDigest: `sha256:${'c'.repeat(64)}`, environmentNames: [],
  permissionMode: { claude: 'acceptEdits' }, rootNames: ['nessie'], serverName: 'coding-sessions',
}

const policy = { 'executor.mcp.call': true, 'executor.mcp.tools': true }

const toolset = (input: {
  actorUserId?: string
  mcpServers?: string[]
  scopeKind?: 'private' | 'project'
  withFacts?: boolean
} = {}) => {
  const descriptor = {
    mcpServers: input.mcpServers ?? ['coding-sessions', 'kelpie'],
    ...(input.withFacts === false ? {} : { codingSessions: facts }),
  }
  const binding = (id: string, operationKey: string) => ({
    candidateHandleDigest: 'digest',
    capabilityRevision: { descriptor },
    executor: { pairingOwnerUserId: owner, scopeKind: input.scopeKind ?? 'private' },
    id,
    operationKey,
    session: null,
  })
  const transactions: unknown[] = []
  const prisma = {
    $transaction: async (work: unknown) => {
      transactions.push(work)
      throw new Error('no command was expected')
    },
    executorAvailabilityCandidate: { findUnique: async () => ({ actorUserId: input.actorUserId ?? owner }) },
    executorBinding: { findMany: async () => [binding('b-tools', 'mcp.tools'), binding('b-call', 'mcp.call')] },
    toolRegistryEntry: {
      deleteMany: async () => ({ count: 0 }),
      upsert: async ({ where }: { where: { organizationId_scopeKey_toolId: { toolId: string } } }) => ({
        id: where.organizationId_scopeKey_toolId.toolId,
      }),
    },
  } as unknown as PrismaClient
  return {
    built: buildExecutorToolset(prisma, {
      agentId, agentToolPolicy: policy, encryptionSecret: 'test-secret', hostOutput: null, organizationId, runId,
    }),
    transactions,
  }
}

const serverEnum = (descriptors: Awaited<ReturnType<typeof buildExecutorToolset>>['descriptors'], name: string) =>
  (descriptors.find((descriptor) => descriptor.toolName === name)?.inputSchema as {
    properties: { server: { enum: string[] } }
  } | undefined)?.properties.server.enum

test('the owner’s run gets the seven coding tools, and the generic pair stops naming the bridge', async () => {
  const { built, transactions } = toolset()
  const offered = await built
  const names = offered.descriptors.map((descriptor) => descriptor.toolName)
  for (const name of CODING_SESSION_TOOL_NAME_SET) assert.ok(names.includes(name), name)
  assert.ok(offered.codingSessions)
  assert.deepEqual(serverEnum(offered.descriptors, 'executor_mcp_call'), ['kelpie'])
  assert.deepEqual(serverEnum(offered.descriptors, 'executor_mcp_tools'), ['kelpie'])
  assert.ok(offered.handledNames.has('coding_session_wait'))

  // Asked for through the generic pair anyway, the bridge is refused before any command exists.
  const viaCall = await offered.dispatch('executor_mcp_call', { server: 'coding-sessions', tool: 'session_list' }, 'p1')
  assert.equal(viaCall.success, false)
  assert.equal(viaCall.correctable, true)
  assert.match(viaCall.output, /through the coding_session_\* tools/)
  const viaCatalog = await offered.mcpCatalog('coding-sessions', 'p2')
  assert.ok('failure' in viaCatalog && viaCatalog.failure.correctable === true)
  assert.equal(transactions.length, 0)

  // A wait has its own four and a half minutes; every other coding tool is one mcp.call.
  assert.equal(offered.timeoutMsFor('coding_session_wait'), CODING_WAIT_TOOL_TIMEOUT_MS)
  assert.equal(CODING_WAIT_TOOL_TIMEOUT_MS, 270_000)
  assert.equal(offered.timeoutMsFor('coding_session_start'), executorToolTimeoutMs('mcp.call'))
  assert.ok(offered.timeoutErrorFor('coding_session_wait', 'p3') instanceof ExecutorUnknownOutcomeError)
})

test('the start tool names the reviewed folders and agents, and its schema is real', async () => {
  const offered = await toolset().built
  const start = offered.descriptors.find((descriptor) => descriptor.toolName === 'coding_session_start')!
  assert.match(start.description, /^Start Claude Code on this machine with a task in one of these folders: nessie\. /)
  assert.match(start.description, /you never write code yourself/)
  const schema = start.inputSchema as { properties: Record<string, { enum?: string[] }>; required: string[] }
  assert.deepEqual(schema.required, ['root', 'task'])
  assert.deepEqual(schema.properties.root?.enum, ['nessie'])
  assert.deepEqual(schema.properties.agent?.enum, ['claude'])
})

test('no coding tools for anyone but the pairing owner, on a shared machine, or without the reviewed facts', async () => {
  for (const variant of [{ actorUserId: '00000000-0000-4000-8000-000000000009' }, { scopeKind: 'project' as const }, { withFacts: false }]) {
    const offered = await toolset(variant).built
    assert.equal(offered.codingSessions, null, JSON.stringify(variant))
    assert.ok(![...offered.handledNames].some((name) => CODING_SESSION_TOOL_NAME_SET.has(name)))
    // The generic pair still names the bridge, and the API's rule answers a call to it.
    assert.deepEqual(serverEnum(offered.descriptors, 'executor_mcp_call'), ['coding-sessions', 'kelpie'])
  }
})

test('a machine that names only the bridge offers the coding tools and no generic pair', async () => {
  const offered = await toolset({ mcpServers: ['coding-sessions'] }).built
  assert.deepEqual(
    offered.descriptors.map((descriptor) => descriptor.toolName).sort(),
    [...CODING_SESSION_TOOL_NAME_SET].sort(),
  )
})
