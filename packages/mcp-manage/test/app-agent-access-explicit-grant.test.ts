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
    [{ id: 'account-connection', scopeId: 'user-1', scopeType: 'user' }],
    registryRows,
  )
}

test('a descriptor-bound PA grant gives it user-scoped protected app access without policy writes', async () => {
  const agents = await listAccess(null)

  assert.deepEqual(agents.map((agent) => agent.agentId), ['personal-assistant'])
})

test('a shared agent never reaches the caller\'s protected personal connection', async () => {
  const agents = await listAccess(
    { 'capability-0': true },
    [rows[0]!],
    [grantFor('personal-assistant'), grantFor('shared-agent')],
  )

  assert.deepEqual(agents.map((agent) => agent.agentId), ['personal-assistant'])
})

test('a revoked PA grant removes it from protected app access', async () => {
  const agents = await listAccess(
    { 'capability-0': false },
    [rows[0]!],
    [],
  )

  assert.deepEqual(agents, [])
})

test('a shared-agent policy cannot lift protected user-scoped app access', async () => {
  const agents = await listAccess(
    { 'capability-0': true },
    [rows[0]!],
    [grantFor('personal-assistant'), grantFor('shared-agent')],
  )

  assert.deepEqual(agents.map((agent) => agent.agentId), ['personal-assistant'])
})
