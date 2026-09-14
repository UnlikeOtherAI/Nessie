import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { listAgentsWithAppAccess } from '../src/apps/app-agent-access.js'
import { fingerprintMcpToolDescriptor } from '../src/mcp-tool-grant-fingerprint.js'

const actorContext = {
  actionContext: { requestId: 'app-access-explicit-grant' },
  actor: { actorId: 'user-1', actorType: 'user', roles: [] },
  tenant: { organizationId: 'org-1' },
} as unknown as AuthorizedActionContext

const rows = Array.from({ length: 67 }, (_, index) => ({
  description: `Capability ${index}`,
  enabled: true,
  id: `capability-${index}`,
  inputSchema: { type: 'object' },
  mcpInstanceId: 'account-connection',
  metadata: { requiresExplicitGrant: true },
  outputSchema: null,
  status: 'active',
  toolId: `mcp:account-connection:capability-${index}`,
  transportConfig: { toolName: `capability-${index}` },
}))

const grantFor = (agentId: string, row = rows[0]!) => ({
  agentId,
  config: {
    descriptorFingerprint: fingerprintMcpToolDescriptor({
      annotations: {},
      description: row.description,
      inputSchema: row.inputSchema,
      name: row.transportConfig.toolName,
      outputSchema: row.outputSchema,
    }),
  },
  roleId: null,
  state: 'allowed',
  toolId: row.id,
})

const listAccess = async (
  toolPolicy: unknown,
  registryRows = rows,
  directGrants = registryRows.map((row) => grantFor('personal-assistant', row)),
  connectionOwner = 'user-1',
) => {
  const prisma = {
    agent: {
      findMany: async () => [
        {
          agentKind: 'personal_assistant',
          bindings: [],
          id: 'personal-assistant',
          name: 'Personal Assistant',
          role: 'assistant',
          toolPolicy,
        },
        {
          agentKind: 'shared',
          bindings: [],
          id: 'shared-agent',
          name: 'Shared agent',
          role: 'assistant',
          toolPolicy,
        },
      ],
    },
    toolGrant: {
      findMany: async () => directGrants,
    },
  } as unknown as PrismaClient

  return listAgentsWithAppAccess(
    prisma,
    actorContext,
    [{ id: 'account-connection', scopeId: connectionOwner, scopeType: 'user' }],
    registryRows,
  )
}

test('the caller\'s own connection reaches every agent they talk to, with no grant', async () => {
  const agents = await listAccess(null, [rows[0]!], [])

  assert.deepEqual(
    agents.map((agent) => agent.agentId),
    ['personal-assistant', 'shared-agent'],
  )
})

test('an explicit per-tool deny withholds the caller\'s own connection', async () => {
  const agents = await listAccess({ 'capability-0': false }, [rows[0]!], [])

  assert.deepEqual(agents, [])
})

test('a colleague\'s personal connection reaches no agent in the caller\'s runs, grants or not', async () => {
  const agents = await listAccess(
    { 'capability-0': true },
    [rows[0]!],
    [grantFor('personal-assistant'), grantFor('shared-agent')],
    'user-2',
  )

  assert.deepEqual(agents, [])
})
