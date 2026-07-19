import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify, { type FastifyReply } from 'fastify'

import { registerMcpToolsRoutes } from '../src/routes/mcp/tools.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const otherOrganizationId = '00000000-0000-4000-8000-000000000002'
const projectId = '00000000-0000-4000-8000-000000000003'
const teamId = '00000000-0000-4000-8000-000000000004'
const userId = '00000000-0000-4000-8000-000000000005'
const agentId = '00000000-0000-4000-8000-000000000006'
const toolId = '00000000-0000-4000-8000-000000000007'

const actorContext: AuthorizedActionContext = {
  actionContext: { requestId: 'request-mcp-policy-route' },
  actor: { actorId: userId, actorType: 'user', roles: ['owner'] },
  tenant: { organizationId, projectId, teamId },
}

const makeApp = (input: {
  agentOrganizationId: string
  role?: 'member' | 'owner'
  toolOrganizationId: string | null
}) => {
  const role = input.role ?? 'owner'
  let updateCalls = 0
  const tx = {
    $executeRaw: async () => 0,
    agent: {
      findFirst: async ({ where }: {
        where: { id: string; organizationId: string }
      }) =>
        where.id === agentId
        && where.organizationId === input.agentOrganizationId
          ? {
              agentKind: 'shared',
              id: agentId,
              name: 'Researcher',
              role: 'assistant',
              toolPolicy: {},
            }
          : null,
      update: async () => {
        updateCalls += 1
        return {
          agentKind: 'shared',
          id: agentId,
          name: 'Researcher',
          role: 'assistant',
          toolPolicy: { [toolId]: true },
        }
      },
    },
  }
  const prisma = {
    $transaction: async <T>(action: (client: typeof tx) => Promise<T>) =>
      action(tx),
    toolRegistryEntry: {
      findFirst: async ({
        where,
      }: {
        where: {
          id: string
          OR: Array<{ organizationId: string | null }>
        }
      }) => {
        const permittedOrganizations = where.OR.map(
          (clause) => clause.organizationId,
        )
        return where.id === toolId
          && permittedOrganizations.includes(input.toolOrganizationId)
          ? {
              handlerKind: 'mcp',
              id: toolId,
              metadata: { requiresExplicitGrant: true },
              toolId: 'mcp:deep-water:research_start',
            }
          : null
      },
    },
  } as unknown as PrismaClient
  const app = Fastify({ logger: false })
  registerMcpToolsRoutes(app, {
    prisma,
    requireActorContext: () => ({
      ...actorContext,
      actor: { ...actorContext.actor, roles: [role] },
    }),
    requireOwner: (
      _context: AuthorizedActionContext,
      reply: FastifyReply,
    ) => {
      if (role === 'owner') return true
      void reply.code(403).send({
        error: { code: 'FORBIDDEN', message: 'Owner access required' },
      })
      return false
    },
  } as unknown as Parameters<typeof registerMcpToolsRoutes>[1])
  return {
    app,
    get updateCalls() {
      return updateCalls
    },
  }
}

test('policy target list and mutations require an organization owner', async () => {
  const state = makeApp({
    agentOrganizationId: organizationId,
    role: 'member',
    toolOrganizationId: null,
  })
  try {
    const requests = [
      {
        method: 'GET' as const,
        url: '/api/mcp/tools/policy-targets',
      },
      {
        method: 'PATCH' as const,
        payload: { enabled: true },
        url: `/api/mcp/tools/${toolId}/policy-targets/${agentId}`,
      },
    ]

    for (const request of requests) {
      const response = await state.app.inject(request)
      assert.equal(response.statusCode, 403)
      assert.equal(response.json().error.code, 'FORBIDDEN')
    }
    assert.equal(state.updateCalls, 0)
  } finally {
    await state.app.close()
  }
})

test('targeted policy route rejects an explicit tool owned by another org', async () => {
  const state = makeApp({
    agentOrganizationId: organizationId,
    toolOrganizationId: otherOrganizationId,
  })
  try {
    const response = await state.app.inject({
      method: 'PATCH',
      payload: { enabled: true },
      url: `/api/mcp/tools/${toolId}/policy-targets/${agentId}`,
    })

    assert.equal(response.statusCode, 404)
    assert.equal(state.updateCalls, 0)
  } finally {
    await state.app.close()
  }
})

test('targeted policy route rejects an agent owned by another org', async () => {
  const state = makeApp({
    agentOrganizationId: otherOrganizationId,
    toolOrganizationId: null,
  })
  try {
    const response = await state.app.inject({
      method: 'PATCH',
      payload: { enabled: true },
      url: `/api/mcp/tools/${toolId}/policy-targets/${agentId}`,
    })

    assert.equal(response.statusCode, 404)
    assert.equal(state.updateCalls, 0)
  } finally {
    await state.app.close()
  }
})
