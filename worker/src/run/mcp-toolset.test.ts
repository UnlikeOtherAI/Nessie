import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { buildMcpToolset, type McpToolPolicy } from './mcp-toolset.js'

/**
 * Scope-exposure rules for the MCP toolset: which instances' tools a given
 * run can see. Uses a mocked Prisma — no MCP traffic is exchanged (dispatch is
 * not invoked).
 */

type RowSeed = {
  id: string
  toolName: string
  scopeType: string
  scopeId: string
}

const makePrisma = (rows: RowSeed[]): PrismaClient => {
  return {
    toolRegistryEntry: {
      findMany: async () =>
        rows.map((row) => ({
          id: row.id,
          toolId: `mcp:inst-${row.id}:${row.toolName}`,
          label: row.toolName,
          description: '',
          inputSchema: { type: 'object' },
          transportConfig: {
            transport: 'mcp',
            serverId: `inst-${row.id}`,
            toolName: row.toolName,
          },
          mcpInstanceId: `inst-${row.id}`,
          mcpInstance: {
            credentialRef: null,
            scopeType: row.scopeType,
            scopeId: row.scopeId,
            transportConfig: {},
            catalogEntry: {
              authConfig: { method: 'none' },
              defaultTransportConfig: {
                transport: 'http',
                url: 'https://mcp.example.com/mcp',
              },
            },
          },
        })),
    },
    mcpServerInstance: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        credentialRef: null,
      }),
    },
    mcpServerCredentialOverride: {
      findUnique: async () => null,
    },
  } as unknown as PrismaClient
}

const actorContext = (overrides: {
  effectiveUserId?: string | null
  teamId?: string | null
  projectId?: string | null
} = {}): AuthorizedActionContext =>
  ({
    actor: { actorType: 'agent', actorId: 'agent-1', roles: [] },
    tenant: {
      organizationId: 'org-1',
      projectId: overrides.projectId ?? 'project-1',
      teamId: overrides.teamId ?? 'team-1',
    },
    actionContext: {
      effectiveUserId: overrides.effectiveUserId ?? 'user-1',
    },
  }) as unknown as AuthorizedActionContext

const exposedNames = async (
  rows: RowSeed[],
  options: {
    agentKind?: 'personal_assistant' | 'shared'
    toolPolicy?: McpToolPolicy
    effectiveUserId?: string | null
    channelId?: string
  } = {},
): Promise<string[]> => {
  const toolset = await buildMcpToolset(
    makePrisma(rows),
    'org-1',
    options.toolPolicy ?? null,
    actorContext({ effectiveUserId: options.effectiveUserId }),
    {
      agentId: 'agent-1',
      agentKind: options.agentKind ?? 'personal_assistant',
      channelId: options.channelId ?? 'channel-1',
    },
    { organizationId: 'org-1' },
  )
  return toolset.entries.map((entry) => entry.originalToolName)
}

test('org-scope instances expose tools to every run in the org', async () => {
  const names = await exposedNames(
    [{ id: 'r1', toolName: 'org_tool', scopeType: 'organization', scopeId: 'org-1' }],
    { agentKind: 'shared' },
  )
  assert.deepEqual(names, ['org_tool'])
})

test('user-scope instances expose tools only to the installing user\'s PA runs', async () => {
  const rows: RowSeed[] = [
    { id: 'r1', toolName: 'my_tool', scopeType: 'user', scopeId: 'user-1' },
  ]
  assert.deepEqual(await exposedNames(rows, { agentKind: 'personal_assistant' }), ['my_tool'])
  // Another user's PA run: hidden.
  assert.deepEqual(
    await exposedNames(rows, { agentKind: 'personal_assistant', effectiveUserId: 'user-2' }),
    [],
  )
  // A shared agent run for the same user: hidden (channel members could drive it).
  assert.deepEqual(await exposedNames(rows, { agentKind: 'shared' }), [])
})

test('team and channel scopes follow the run context', async () => {
  const rows: RowSeed[] = [
    { id: 'r1', toolName: 'team_tool', scopeType: 'team', scopeId: 'team-1' },
    { id: 'r2', toolName: 'chan_tool', scopeType: 'channel', scopeId: 'channel-1' },
    { id: 'r3', toolName: 'other_team', scopeType: 'team', scopeId: 'team-9' },
    { id: 'r4', toolName: 'other_chan', scopeType: 'channel', scopeId: 'channel-9' },
  ]
  assert.deepEqual(await exposedNames(rows, { agentKind: 'shared' }), [
    'team_tool',
    'chan_tool',
  ])
})

test('an explicit per-agent policy verdict overrides scope defaults both ways', async () => {
  const rows: RowSeed[] = [
    { id: 'allow-me', toolName: 'far_tool', scopeType: 'channel', scopeId: 'channel-9' },
    { id: 'deny-me', toolName: 'org_tool', scopeType: 'organization', scopeId: 'org-1' },
  ]
  const names = await exposedNames(rows, {
    agentKind: 'shared',
    toolPolicy: { 'allow-me': true, 'deny-me': false },
  })
  assert.deepEqual(names, ['far_tool'])
})
