import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { ExecutorCodingSessionsFacts } from '@nessie/schemas'

import { CODING_SESSION_TOOL_NAME_SET } from './coding-session-tools.js'
import { CODING_WAIT_TOOL_TIMEOUT_MS } from './coding-session-wait.js'
import { executorToolTimeoutMs, ExecutorUnknownOutcomeError } from './executor-command-timing.js'
import { buildExecutorToolset } from './executor-toolset.js'
import type { TicketWorkCodingScope } from './ticket-work-coding-sessions.js'

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
  ticketWork?: TicketWorkCodingScope
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
      ...(input.ticketWork ? { ticketWork: input.ticketWork } : {}),
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

  // A wait has its own ten and a half minutes; every other coding tool is one mcp.call.
  assert.equal(offered.timeoutMsFor('coding_session_wait'), CODING_WAIT_TOOL_TIMEOUT_MS)
  assert.equal(CODING_WAIT_TOOL_TIMEOUT_MS, 630_000)
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
    // Nor does the generic pair name the bridge: the API would refuse every call to it.
    assert.deepEqual(serverEnum(offered.descriptors, 'executor_mcp_call'), ['kelpie'])
    assert.deepEqual(serverEnum(offered.descriptors, 'executor_mcp_tools'), ['kelpie'])
  }
  // Asked for anyway, it is refused as correctable before any command exists, and told why.
  const { built, transactions } = toolset({ actorUserId: '00000000-0000-4000-8000-000000000009' })
  const offered = await built
  const viaCall = await offered.dispatch('executor_mcp_call', { server: 'coding-sessions', tool: 'session_list' }, 'p1')
  assert.equal(viaCall.correctable, true)
  assert.match(viaCall.output, /^The coding-sessions bridge is not reachable from this run: coding sessions act as/)
  const viaCatalog = await offered.mcpCatalog('coding-sessions', 'p2')
  assert.ok('failure' in viaCatalog && viaCatalog.failure.correctable === true)
  assert.equal(transactions.length, 0)
})

test('a machine that names only the bridge offers the coding tools and no generic pair', async () => {
  const offered = await toolset({ mcpServers: ['coding-sessions'] }).built
  assert.deepEqual(
    offered.descriptors.map((descriptor) => descriptor.toolName).sort(),
    [...CODING_SESSION_TOOL_NAME_SET].sort(),
  )
})

test('a ticket’s work under standing machine access gets the coding tools and no other program', async () => {
  const ticketWork: TicketWorkCodingScope = {
    agentId, allowedRootNames: ['nessie'], codingAgents: ['claude'], contextId: `ticket:${runId}:${owner}`,
    executorId: '00000000-0000-4000-8000-000000000005', organizationId, ownerKey: 'sha256:owner',
    policyId: runId, runId, taskId: owner, title: 'NES-1 Fix login', workId: '00000000-0000-4000-8000-000000000006',
  }
  const { built, transactions } = toolset({ ticketWork })
  const offered = await built
  // The author's card consented to coding sessions, so the generic pair is not offered even though
  // the machine reviews another program and the agent's policy grants the pair.
  assert.deepEqual(
    offered.descriptors.map((descriptor) => descriptor.toolName).sort(),
    [...CODING_SESSION_TOOL_NAME_SET].sort(),
  )
  assert.ok(!offered.handledNames.has('executor_mcp_call'))
  assert.ok(!offered.handledNames.has('executor_mcp_tools'))
  // Asked for anyway, it is refused as correctable before any command exists, and told why.
  const viaCall = await offered.dispatch('executor_mcp_call', { server: 'kelpie', tool: 'screenshot' }, 'p1')
  assert.equal(viaCall.success, false)
  assert.equal(viaCall.correctable, true)
  assert.match(viaCall.output, /only coding sessions on this machine; no other program on it is offered to you/)
  const viaCatalog = await offered.mcpCatalog('kelpie', 'p2')
  assert.ok('failure' in viaCatalog && viaCatalog.failure.success === false)
  assert.equal(transactions.length, 0)
})
