import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import {
  fingerprintMcpToolDescriptor,
  MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY,
  mcpToolDescriptorAnnotationsFromMetadata,
} from '@nessie/mcp-manage'

import {
  backfillProtectedMcpToolGrants,
  setAgentToolPolicyForRegistryEntry,
} from '../src/services/agent-tool-policy-registry.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const organizationId = '00000000-0000-4000-8000-000000000001'
const agentId = '00000000-0000-4000-8000-000000000002'
const protectedToolId = '00000000-0000-4000-8000-000000000003'

type AgentFixture = {
  agentKind: 'personal_assistant' | 'shared'
  id: string
  name: string
  organizationId: string
  role: string
  systemManaged: boolean
  toolPolicy: Record<string, boolean>
}

type GrantFixture = {
  agentId: string | null
  config: unknown
  id: string
  roleId: string | null
  source: string
  state: string
  toolId: string
}

const protectedEntry = {
  description: 'Creates Linear issues from an approved project.',
  handlerKind: 'mcp',
  id: protectedToolId,
  inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
  mcpInstance: null,
  metadata: { requiresExplicitGrant: true },
  organizationId,
  outputSchema: { type: 'object', properties: { issueId: { type: 'string' } } },
  toolId: 'mcp:linear-instance:issue_create',
  transportConfig: { toolName: 'issue_create' },
}

const descriptorFingerprint = fingerprintMcpToolDescriptor({
  annotations: mcpToolDescriptorAnnotationsFromMetadata(protectedEntry.metadata),
  description: protectedEntry.description,
  inputSchema: protectedEntry.inputSchema,
  name: 'issue_create',
  outputSchema: protectedEntry.outputSchema,
})

const buildPrisma = (input: {
  agents: AgentFixture[]
  entries?: typeof protectedEntry[]
  grants?: GrantFixture[]
}) => {
  const agents = input.agents
  const entries = input.entries ?? [protectedEntry]
  const grants = input.grants ?? []
  let lockCalls = 0

  // `ToolRegistryEntry.id` is `@db.Uuid`, so Postgres refuses a filter value
  // that is not a UUID — it raises P2023 rather than simply not matching. A
  // fake that accepts any string cannot see that, which is how a backfill
  // feeding builtin policy names (`delegate`) into `id: { in }` reached
  // production and crash-looped the API at startup.
  const assertUuidFilter = (ids: string[]) => {
    const invalid = ids.find((id) => !UUID_PATTERN.test(id))
    if (invalid === undefined) return
    const error = new Error(
      `Inconsistent column data: Error creating UUID, invalid character: `
      + `expected an optional prefix of \`urn:uuid:\` followed by `
      + `[0-9a-fA-F-], found \`${invalid[2]}\` at 3`,
    ) as Error & { code: string }
    error.code = 'P2023'
    throw error
  }

  const matchingEntries = (where: {
    id?: { in: string[] }
  }) => {
    if (where.id) assertUuidFilter(where.id.in)
    return entries.filter((entry) =>
      (!where.id || where.id.in.includes(entry.id))
      && entry.handlerKind === 'mcp'
      && entry.metadata.requiresExplicitGrant === true,
    )
  }

  const tx = {
    $executeRaw: async () => {
      lockCalls += 1
      return 0
    },
    agent: {
      findFirst: async ({ where }: { where: { id: string; organizationId: string } }) =>
        agents.find((agent) =>
          agent.id === where.id && agent.organizationId === where.organizationId,
        ) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        agents.find((agent) => agent.id === where.id) ?? null,
      update: async ({ where, data }: {
        where: { id: string }
        data: { toolPolicy: Record<string, boolean> }
      }) => {
        const agent = agents.find((candidate) => candidate.id === where.id)
        assert.ok(agent)
        agent.toolPolicy = data.toolPolicy
        return agent
      },
    },
    productIntegrationRun: {
      findFirst: async () => null,
    },
    toolGrant: {
      create: async ({ data }: { data: Omit<GrantFixture, 'id'> }) => {
        const created = {
          ...data,
          id: `grant-${grants.length + 1}`,
        }
        grants.push(created)
        return created
      },
      updateMany: async ({ where, data }: {
        where: { agentId: string; roleId: null; toolId: string }
        data: Partial<Pick<GrantFixture, 'config' | 'source' | 'state'>>
      }) => {
        const matched = grants.filter((grant) =>
          grant.agentId === where.agentId
          && grant.roleId === where.roleId
          && grant.toolId === where.toolId,
        )
        for (const grant of matched) {
          if (data.config !== undefined) grant.config = data.config
          if (data.source !== undefined) grant.source = data.source
          if (data.state !== undefined) grant.state = data.state
        }
        return { count: matched.length }
      },
      findMany: async ({ where }: {
        where: { agentId: string; roleId: null; state?: string; toolId: { in: string[] } }
      }) => grants.filter((grant) =>
        grant.agentId === where.agentId
        && grant.roleId === where.roleId
        && (where.state === undefined || grant.state === where.state)
        && where.toolId.in.includes(grant.toolId),
      ),
    },
    toolRegistryEntry: {
      count: async () => 0,
      findFirst: async () => entries[0] ?? null,
      findMany: async ({ where }: { where: { id?: { in: string[] } } }) =>
        matchingEntries(where),
    },
  }
  const prisma = {
    $transaction: async <T>(action: (client: typeof tx) => Promise<T>) => action(tx),
    agent: {
      findMany: async () => agents,
    },
    toolRegistryEntry: {
      findFirst: async () => entries[0] ?? null,
    },
  } as unknown as PrismaClient

  return {
    agents,
    get grants() {
      return grants
    },
    get lockCalls() {
      return lockCalls
    },
    prisma,
  }
}

test('protected MCP policy tombstones and restores only the direct agent grant', async () => {
  const state = buildPrisma({
    agents: [{
      agentKind: 'shared',
      id: agentId,
      name: 'Triage Agent',
      organizationId,
      role: 'assistant',
      systemManaged: false,
      toolPolicy: {},
    }],
    grants: [{
      agentId: null,
      config: {},
      id: 'role-grant',
      roleId: '00000000-0000-4000-8000-000000000004',
      source: 'role',
      state: 'allowed',
      toolId: protectedToolId,
    }],
  })

  await setAgentToolPolicyForRegistryEntry(state.prisma, {
    agentId,
    enabled: false,
    organizationId,
    toolRegistryEntryId: protectedToolId,
  })

  assert.equal(state.agents[0].toolPolicy[protectedToolId], undefined)
  assert.deepEqual(state.grants, [
    {
      agentId: null,
      config: {},
      id: 'role-grant',
      roleId: '00000000-0000-4000-8000-000000000004',
      source: 'role',
      state: 'allowed',
      toolId: protectedToolId,
    },
    {
      agentId,
      config: {},
      id: 'grant-2',
      roleId: null,
      source: 'agent_override',
      state: 'denied',
      toolId: protectedToolId,
    },
  ])

  await setAgentToolPolicyForRegistryEntry(state.prisma, {
    agentId,
    enabled: true,
    organizationId,
    toolRegistryEntryId: protectedToolId,
  })

  assert.equal(state.agents[0].toolPolicy[protectedToolId], true)
  assert.deepEqual(state.grants, [
    {
      agentId: null,
      config: {},
      id: 'role-grant',
      roleId: '00000000-0000-4000-8000-000000000004',
      source: 'role',
      state: 'allowed',
      toolId: protectedToolId,
    },
    {
      agentId,
      config: { [MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY]: descriptorFingerprint },
      id: 'grant-2',
      roleId: null,
      source: 'agent_override',
      state: 'allowed',
      toolId: protectedToolId,
    },
  ])
  assert.equal(state.lockCalls, 2)
})

test('startup backfill migrates legacy grants once without refreshing consent fingerprints', async () => {
  const missingGrantAgentId = agentId
  const legacyGrantAgentId = '00000000-0000-4000-8000-000000000005'
  const staleAgentId = '00000000-0000-4000-8000-000000000006'
  const state = buildPrisma({
    agents: [
      {
        agentKind: 'shared',
        id: missingGrantAgentId,
        name: 'Missing Grant Agent',
        organizationId,
        role: 'assistant',
        systemManaged: false,
        toolPolicy: { [protectedToolId]: true, ordinary_builtin: true },
      },
      {
        agentKind: 'shared',
        id: legacyGrantAgentId,
        name: 'Legacy Grant Agent',
        organizationId,
        role: 'assistant',
        systemManaged: false,
        toolPolicy: { [protectedToolId]: true },
      },
      {
        agentKind: 'shared',
        id: staleAgentId,
        name: 'Stale Consent Agent',
        organizationId,
        role: 'assistant',
        systemManaged: false,
        toolPolicy: { [protectedToolId]: true },
      },
    ],
    grants: [
      {
        agentId: null,
        config: {},
        id: 'role-grant',
        roleId: '00000000-0000-4000-8000-000000000004',
        source: 'role',
        state: 'allowed',
        toolId: protectedToolId,
      },
      {
        agentId: legacyGrantAgentId,
        config: {},
        id: 'legacy-agent-grant',
        roleId: null,
        source: 'agent_override',
        state: 'allowed',
        toolId: protectedToolId,
      },
      {
        agentId: staleAgentId,
        config: { [MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY]: 'sha256:stale' },
        id: 'stale-agent-grant',
        roleId: null,
        source: 'agent_override',
        state: 'allowed',
        toolId: protectedToolId,
      },
    ],
  })

  assert.deepEqual(
    await backfillProtectedMcpToolGrants(state.prisma),
    { agentCount: 2, grantCount: 2 },
  )
  assert.deepEqual(
    await backfillProtectedMcpToolGrants(state.prisma),
    { agentCount: 0, grantCount: 0 },
  )

  assert.deepEqual(state.grants, [{
    agentId: null,
    config: {},
    id: 'role-grant',
    roleId: '00000000-0000-4000-8000-000000000004',
    source: 'role',
    state: 'allowed',
    toolId: protectedToolId,
  }, {
    agentId: legacyGrantAgentId,
    config: { [MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY]: descriptorFingerprint },
    id: 'legacy-agent-grant',
    roleId: null,
    source: 'agent_override',
    state: 'allowed',
    toolId: protectedToolId,
  }, {
    agentId: staleAgentId,
    config: { [MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY]: 'sha256:stale' },
    id: 'stale-agent-grant',
    roleId: null,
    source: 'agent_override',
    state: 'allowed',
    toolId: protectedToolId,
  }, {
    agentId: missingGrantAgentId,
    config: { [MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY]: descriptorFingerprint },
    id: 'grant-4',
    roleId: null,
    source: 'agent_override',
    state: 'allowed',
    toolId: protectedToolId,
  }])
  assert.equal(state.lockCalls, 6)
})

test('startup backfill preserves a legacy explicit deny and never overrides a direct denial', async () => {
  const deniedPolicyAgentId = agentId
  const directDeniedAgentId = '00000000-0000-4000-8000-000000000007'
  const directDeniedGrant: GrantFixture = {
    agentId: directDeniedAgentId,
    config: { reason: 'owner already revoked access' },
    id: 'direct-denied-grant',
    roleId: null,
    source: 'agent_override',
    state: 'denied',
    toolId: protectedToolId,
  }
  const state = buildPrisma({
    agents: [
      {
        agentKind: 'personal_assistant',
        id: deniedPolicyAgentId,
        name: 'Personal Assistant',
        organizationId,
        role: 'assistant',
        systemManaged: true,
        toolPolicy: { [protectedToolId]: false },
      },
      {
        agentKind: 'shared',
        id: directDeniedAgentId,
        name: 'Revoked Agent',
        organizationId,
        role: 'assistant',
        systemManaged: false,
        toolPolicy: { [protectedToolId]: true },
      },
    ],
    grants: [directDeniedGrant],
  })

  assert.deepEqual(
    await backfillProtectedMcpToolGrants(state.prisma),
    { agentCount: 1, grantCount: 1 },
  )
  assert.deepEqual(state.grants, [
    directDeniedGrant,
    {
      agentId: deniedPolicyAgentId,
      config: {},
      id: 'grant-2',
      roleId: null,
      source: 'agent_override',
      state: 'denied',
      toolId: protectedToolId,
    },
  ])
})

// Regression: production ran an agent whose `toolPolicy` carried the builtin
// names `delegate` and `spawn_subtask` beside registry ids. The startup
// backfill passed every key into `ToolRegistryEntry.id: { in }`, Postgres
// raised P2023 on the first non-UUID, and because the call sits unguarded in
// `buildApp` the API exited 1 and crash-looped behind a 502.
test('startup backfill ignores builtin tool-policy keys instead of failing on them', async () => {
  const state = buildPrisma({
    agents: [{
      agentKind: 'shared',
      id: agentId,
      name: 'Agent With Builtin Policy',
      organizationId,
      role: 'assistant',
      systemManaged: false,
      toolPolicy: { delegate: true, spawn_subtask: true, [protectedToolId]: true },
    }],
  })

  assert.deepEqual(
    await backfillProtectedMcpToolGrants(state.prisma),
    { agentCount: 1, grantCount: 1 },
  )
  assert.deepEqual(
    state.grants.map((grant) => grant.toolId),
    [protectedToolId],
  )
})

test('an agent carrying only builtin policy keys is skipped without taking a lock', async () => {
  const state = buildPrisma({
    agents: [{
      agentKind: 'shared',
      id: agentId,
      name: 'Builtin Only Agent',
      organizationId,
      role: 'assistant',
      systemManaged: false,
      toolPolicy: { delegate: true, spawn_subtask: false },
    }],
  })

  assert.deepEqual(
    await backfillProtectedMcpToolGrants(state.prisma),
    { agentCount: 0, grantCount: 0 },
  )
  assert.equal(state.lockCalls, 0)
  assert.deepEqual(state.grants, [])
})
