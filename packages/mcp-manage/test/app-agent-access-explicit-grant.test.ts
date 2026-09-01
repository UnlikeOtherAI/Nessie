import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { listAgentsWithAppAccess } from '../src/apps/app-agent-access.js'

const actorContext = {
  actionContext: { requestId: 'app-access-explicit-grant' },
  actor: { actorId: 'user-1', actorType: 'user', roles: [] },
  tenant: { organizationId: 'org-1' },
} as unknown as AuthorizedActionContext

const rows = Array.from({ length: 67 }, (_, index) => ({
  enabled: true,
  id: `capability-${index}`,
  mcpInstanceId: 'account-connection',
  metadata: { requiresExplicitGrant: true },
  status: 'active',
}))

const listAccess = async (
  toolPolicy: unknown,
  registryRows = rows,
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
  } as unknown as PrismaClient

  return listAgentsWithAppAccess(
    prisma,
    actorContext,
    [{ id: 'account-connection', scopeId: 'user-1', scopeType: 'user' }],
    registryRows,
  )
}

test('an existing user-scoped explicit-grant connection gives the PA access without policy writes', async () => {
  const agents = await listAccess(null)

  assert.deepEqual(agents.map((agent) => agent.agentId), ['personal-assistant'])
})

test('a shared agent reaches the caller\'s personal connection only with an explicit grant', async () => {
  const agents = await listAccess({ 'capability-0': true }, [rows[0]])

  assert.deepEqual(agents.map((agent) => agent.agentId), [
    'personal-assistant',
    'shared-agent',
  ])
})

test('an explicit deny removes the PA from explicit-grant app access', async () => {
  const agents = await listAccess(
    { 'capability-0': false },
    [rows[0]],
  )

  assert.deepEqual(agents, [])
})

test('the viewing user can grant their own user-scoped account to a shared agent', async () => {
  const agents = await listAccess({ 'capability-0': true }, [rows[0]])

  assert.deepEqual(agents.map((agent) => agent.agentId), [
    'personal-assistant',
    'shared-agent',
  ])
})
