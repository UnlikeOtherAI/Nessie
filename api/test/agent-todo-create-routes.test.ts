import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerAgentRoutes } from '../src/routes/agents.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000003'
const teamId = '00000000-0000-4000-8000-000000000004'
const userId = '00000000-0000-4000-8000-000000000005'
const avatarAttachmentId = '00000000-0000-4000-8000-000000000030'

const makeCreatedAgent = (data: Record<string, unknown>) => ({
  agentKind: 'shared' as const,
  avatarAttachmentId: null,
  bindings: [] as Array<{ channelId: string }>,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  delegationMode: 'none' as const,
  id: '00000000-0000-4000-8000-000000000010',
  messages: [] as Array<{ createdAt: Date }>,
  model: 'gpt-5',
  name: 'Researcher',
  organizationId,
  parentAgentId: null,
  projectId,
  provider: 'openai',
  role: 'assistant',
  runs: [],
  status: 'idle' as const,
  surfacePolicy: 'shared' as const,
  systemManaged: false,
  systemPrompt: null,
  teamId,
  todosEnabled: false,
  toolPolicy: {},
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...data,
})

const makeApp = (role: 'member' | 'owner') => {
  let createCalls = 0
  const db = {
    $executeRaw: async () => 0,
    agent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createCalls += 1
        return makeCreatedAgent(data)
      },
    },
    attachment: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === avatarAttachmentId
          ? {
              id: avatarAttachmentId,
              kind: 'image',
              knowledgePageId: null,
              messageId: null,
              organizationId,
              uploaderId: userId,
            }
          : null,
    },
    knowledgePageVersion: {
      findFirst: async () => null,
    },
    organizationMember: {
      findFirst: async ({ where }: { where: { organizationId: string; userId: string } }) =>
        where.organizationId === organizationId && where.userId === userId
          ? { id: '00000000-0000-4000-8000-000000000099' }
          : null,
    },
    toolRegistryEntry: {
      findMany: async () => [],
    },
  }
  const prisma = {
    ...db,
    $transaction: async <T>(action: (tx: typeof db) => Promise<T>) => action(db),
  } as unknown as PrismaClient
  const actorContext: AuthorizedActionContext = {
    actionContext: { requestId: `request-${role}` },
    actor: { actorId: userId, actorType: 'user', roles: [role] },
    tenant: { organizationId, projectId, teamId },
  }
  const app = Fastify({ logger: false })
  registerAgentRoutes(app, {
    config: { model: {} },
    createAgentVisibilityScope: () => ({}),
    getChannelIfMember: async () => null,
    isAgentAccessibleToActor: async () => false,
    prisma,
    requireActorContext: () => actorContext,
    requireOwner: (_context: AuthorizedActionContext, reply) => {
      if (role === 'owner') return true
      void reply.code(403).send({ error: { code: 'FORBIDDEN' } })
      return false
    },
  } as unknown as Parameters<typeof registerAgentRoutes>[1])

  return {
    app,
    get createCalls() {
      return createCalls
    },
  }
}

test('only an owner can enable to-dos while creating an agent', async () => {
  const member = makeApp('member')
  try {
    const refused = await member.app.inject({
      method: 'POST',
      payload: { name: 'Member-enabled to-do agent', todosEnabled: true },
      url: '/api/agents',
    })

    assert.equal(refused.statusCode, 403)
    assert.equal(refused.json().error.code, 'AGENT_TODOS_OWNER_REQUIRED')
    assert.match(refused.json().error.message, /Only organization owners can enable to-dos/)
    assert.equal(member.createCalls, 0)
  } finally {
    await member.app.close()
  }

  const owner = makeApp('owner')
  try {
    const created = await owner.app.inject({
      method: 'POST',
      payload: {
        avatarAttachmentId,
        name: 'Owner-enabled to-do agent',
        todosEnabled: true,
      },
      url: '/api/agents',
    })

    assert.equal(created.statusCode, 201)
    assert.equal(created.json().data.todosEnabled, true)
    assert.equal(owner.createCalls, 1)
  } finally {
    await owner.app.close()
  }

  const ordinaryMember = makeApp('member')
  try {
    const created = await ordinaryMember.app.inject({
      method: 'POST',
      payload: { avatarAttachmentId, name: 'Member-default to-do agent' },
      url: '/api/agents',
    })

    assert.equal(created.statusCode, 201)
    assert.equal(created.json().data.todosEnabled, false)
    assert.equal(ordinaryMember.createCalls, 1)
  } finally {
    await ordinaryMember.app.close()
  }
})

test('agent creation refuses a credential before persistence', async () => {
  const member = makeApp('member')
  try {
    const response = await member.app.inject({
      method: 'POST',
      payload: {
        avatarAttachmentId,
        name: 'Unsafe agent',
        systemPrompt: `Use sk-proj-${'aB3_'.repeat(8)} for every request.`,
      },
      url: '/api/agents',
    })

    assert.equal(response.statusCode, 422)
    assert.equal(response.json().error.code, 'SECRET_INTERCEPTED')
    assert.equal(member.createCalls, 0)
  } finally {
    await member.app.close()
  }
})
