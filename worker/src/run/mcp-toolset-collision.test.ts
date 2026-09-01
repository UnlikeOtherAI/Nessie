import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import type { DeepWaterHandoffGuard } from './deepwater-handoff-guard.js'
import { buildMcpToolset } from './mcp-toolset.js'

const registryRow = (input: {
  id: string
  managed: boolean
  toolName: string
}) => ({
  id: input.id,
  toolId: `mcp:inst-${input.id}:${input.toolName}`,
  label: 'Research start',
  description: '',
  inputSchema: { type: 'object' },
  transportConfig: {
    transport: 'mcp',
    serverId: `inst-${input.id}`,
    toolName: input.toolName,
  },
  metadata: input.managed ? { requiresExplicitGrant: true } : {},
  mcpInstanceId: `inst-${input.id}`,
  mcpInstance: {
    credentialRef: null,
    scopeType: input.managed ? 'team' : 'organization',
    scopeId: input.managed ? 'team-1' : 'org-1',
    transportConfig: {},
    catalogEntry: {
      label: input.managed ? 'Deep Water' : 'Private research',
      name: input.managed ? 'deep-water' : 'private-research',
      visibility: input.managed ? 'public' : 'private',
      integratedProducts: input.managed ? [{ slug: 'deep-water' }] : [],
      authMethod: 'none',
      authConfig: { method: 'none' },
      defaultTransportConfig: {
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
      },
    },
  },
})

type RowSeed = { id: string; managed: boolean; toolName: string }

// Deliberately returns the private collision first — Prisma has no `orderBy`
// here, so production row order is whatever Postgres yields.
const SEEDS: RowSeed[] = [
  { id: 'private', managed: false, toolName: 'research_start' },
  { id: 'private-status', managed: false, toolName: 'research_status' },
  { id: 'private-punctuation', managed: false, toolName: 'research-start' },
  { id: 'managed', managed: true, toolName: 'research_start' },
]

const makePrisma = (seeds: RowSeed[]): PrismaClient => ({
  toolRegistryEntry: {
    findMany: async () => seeds.map(registryRow),
  },
  mcpServerCredentialOverride: {
    findUnique: async () => null,
  },
  mcpServerInstance: {
    findUnique: async ({ where }: { where: { id: string } }) => ({
      credentialRef: null,
      id: where.id,
      scopeId: 'org-1',
      scopeType: 'organization',
      catalogEntry: { authMethod: 'none', authConfig: { method: 'none' } },
    }),
  },
} as unknown as PrismaClient)

const prisma = makePrisma(SEEDS)

const actorContext = {
  actor: { actorType: 'agent', actorId: 'agent-1', roles: [] },
  tenant: {
    organizationId: 'org-1',
    projectId: null,
    teamId: 'team-1',
  },
  actionContext: { effectiveUserId: 'user-1' },
} as unknown as AuthorizedActionContext

const build = (
  toolPolicy: Record<string, boolean> | null,
  deepWaterHandoffGuard?: DeepWaterHandoffGuard,
  client: PrismaClient = prisma,
) =>
  buildMcpToolset(
    client,
    'org-1',
    toolPolicy,
    actorContext,
    {
      agentId: 'agent-1',
      agentKind: 'personal_assistant',
      channelId: 'channel-1',
    },
    { actorId: 'agent-1', organizationId: 'org-1' },
    { deepWaterHandoffGuard },
  )

test('managed DeepWater owns the canonical exposed name despite row order', async () => {
  const toolset = await build({ managed: true })
  assert.deepEqual(
    toolset.entries.map((entry) => ({
      exposedName: entry.exposedName,
      instanceId: entry.instanceId,
    })),
    // Managed first, then the private rows by `toolId` — a fixed allocation
    // order, so a colliding connector keeps the same suffix between runs.
    [
      {
        exposedName: 'mcp_research_start',
        instanceId: 'inst-managed',
      },
      {
        exposedName: 'mcp_research_start_2',
        instanceId: 'inst-private-punctuation',
      },
      {
        exposedName: 'mcp_research_status_2',
        instanceId: 'inst-private-status',
      },
      {
        exposedName: 'mcp_research_start_3',
        instanceId: 'inst-private',
      },
    ],
  )
})

test('exposed names do not depend on the order Postgres returns rows in', async () => {
  const baseline = await build({ managed: true })
  const expected = baseline.entries.map((entry) => ({
    exposedName: entry.exposedName,
    instanceId: entry.instanceId,
  }))

  // Every permutation of the same fleet must allocate identically; otherwise a
  // colliding tool silently changes name between runs and the model's cached
  // tool prefix is invalidated on every reconnect.
  for (let rotation = 1; rotation < SEEDS.length; rotation += 1) {
    const rotated = [...SEEDS.slice(rotation), ...SEEDS.slice(0, rotation)]
    const toolset = await build({ managed: true }, undefined, makePrisma(rotated))
    assert.deepEqual(
      toolset.entries.map((entry) => ({
        exposedName: entry.exposedName,
        instanceId: entry.instanceId,
      })),
      expected,
    )
  }
})

test('personal-assistant defaults do not let a private collision take DeepWater\'s reserved name', async () => {
  const toolset = await build(null)
  assert.deepEqual(
    toolset.entries.map((entry) => entry.exposedName),
    [
      'mcp_research_start',
      'mcp_research_start_2',
      'mcp_research_status_2',
      'mcp_research_start_3',
    ],
  )
})

test('managed start delivery is acknowledged only by the owning loop', async () => {
  const deliveryToken = Symbol('start-delivery')
  let acknowledgements = 0
  const toolset = await build(
    { managed: true },
    {
      assertCompletion: () => undefined,
      dispatchDeepWater: async () => ({
        deliveryToken,
        result: {
          output: '{"id":"rs_ticket"}',
          raw: null,
          success: true,
        },
        transportInvoked: false,
      }),
      markDelivered: (token) => {
        assert.equal(token, deliveryToken)
        acknowledgements += 1
      },
      suppressBuiltin: async () => false,
      timeoutErrorFor: () => null,
    },
  )

  const result = await toolset.dispatch(
    'mcp_research_start',
    { query: 'test' },
    'tool-call-1',
  )
  assert.equal(acknowledgements, 0)
  assert.ok(result.acknowledgeDelivery)
  result.acknowledgeDelivery()
  assert.equal(acknowledgements, 1)
})
