import assert from 'node:assert/strict'
import test from 'node:test'

import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext, WsScope } from '@nessie/schemas'

import { createRequestHelpers } from '../src/lib/request-helpers.js'
import {
  buildSnapshotForScopes,
  loadAgentActivity,
  loadAgentChildren,
  loadAgentStatus,
} from '../src/services/agent-read-model.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const otherOrganizationId = '00000000-0000-4000-8000-000000000002'
const userId = '00000000-0000-4000-8000-000000000003'
const parentId = '00000000-0000-4000-8000-000000000004'
const localChildId = '00000000-0000-4000-8000-000000000005'
const foreignChildId = '00000000-0000-4000-8000-000000000006'
const localTaskId = '00000000-0000-4000-8000-000000000007'
const foreignTaskId = '00000000-0000-4000-8000-000000000008'

const now = new Date('2026-07-19T12:00:00.000Z')
const visibility = {
  includeAllOrgChannels: true,
  organizationId,
  userId,
}

const makeChild = (
  id: string,
  childOrganizationId: string,
  taskId: string,
) => ({
  agentKind: 'shared' as const,
  createdAt: now,
  id,
  name: id === localChildId ? 'Local child' : 'Foreign child',
  organizationId: childOrganizationId,
  role: 'researcher',
  status: 'idle' as const,
  systemManaged: false,
  tasks: [{
    id: taskId,
    purpose: 'Research',
  }],
})

const children = [
  makeChild(localChildId, organizationId, localTaskId),
  makeChild(foreignChildId, otherOrganizationId, foreignTaskId),
]

test('agent access requires the agent itself to belong to the actor organization', async () => {
  const prisma = {
    agent: {
      count: async ({ where }: { where: Prisma.AgentWhereInput }) => {
        const organizationConstraintsMatch = (
          candidate: Prisma.AgentWhereInput,
        ): boolean => {
          if (
            candidate.organizationId !== undefined
            && candidate.organizationId !== otherOrganizationId
          ) return false

          const conjuncts = candidate.AND
          const clauses = Array.isArray(conjuncts)
            ? conjuncts
            : conjuncts ? [conjuncts] : []
          return clauses.every(organizationConstraintsMatch)
        }
        return (
          where.id === foreignChildId
          && organizationConstraintsMatch(where)
        )
          ? 1
          : 0
      },
    },
  } as unknown as PrismaClient
  const helpers = createRequestHelpers(prisma)
  const ownerContext: AuthorizedActionContext = {
    actionContext: { requestId: 'owner-request' },
    actor: { actorId: userId, actorType: 'user', roles: ['owner'] },
    tenant: { organizationId },
  }
  const memberContext: AuthorizedActionContext = {
    ...ownerContext,
    actionContext: { requestId: 'member-request' },
    actor: { ...ownerContext.actor, roles: ['member'] },
  }

  assert.equal(
    await helpers.isAgentAccessibleToActor(ownerContext, foreignChildId),
    false,
  )
  assert.equal(
    await helpers.isAgentAccessibleToActor(memberContext, foreignChildId),
    false,
  )
})

test('children listing excludes historical cross-organization parent links', async () => {
  const prisma = {
    agent: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; organizationId: string }
      }) =>
        where.id === parentId && where.organizationId === organizationId
          ? { agentKind: 'shared', systemManaged: false }
          : null,
      findMany: async ({
        where,
      }: {
        where: { organizationId?: string; parentAgentId: string }
      }) =>
        children.filter(
          (child) =>
            child.organizationId === (where.organizationId ?? child.organizationId),
        ),
    },
  } as unknown as PrismaClient

  const result = await loadAgentChildren(prisma, parentId, visibility)

  assert.deepEqual(result.map((child) => child.agentId), [localChildId])
})

test('status and activity exclude foreign children linked to a local parent', async () => {
  const parent = {
    agentKind: 'shared' as const,
    childAgents: [] as typeof children,
    id: parentId,
    messages: [],
    runs: [],
    status: 'idle' as const,
    systemManaged: false,
    updatedAt: now,
  }
  const findParent = async ({
    include,
    where,
  }: {
    include: {
      childAgents: { where?: { organizationId?: string } }
    }
    where: { id: string; organizationId?: string }
  }) => ({
    ...parent,
    childAgents: children.filter(
      (child) =>
        child.organizationId
        === (include.childAgents.where?.organizationId ?? child.organizationId),
    ),
    ...(where.id === parentId
      && where.organizationId === organizationId
      ? {}
      : { id: foreignChildId }),
  })
  const prisma = {
    agent: {
      findFirst: findParent,
      findUnique: findParent,
    },
  } as unknown as PrismaClient

  const status = await loadAgentStatus(prisma, parentId, { visibility })
  const activity = await loadAgentActivity(prisma, parentId, { visibility })

  assert.deepEqual(
    status?.activeSubAgents.map((child) => child.agentId),
    [localChildId],
  )
  assert.deepEqual(
    activity?.subAgents.map((child) => child.agentId),
    [localChildId],
  )
})

test('realtime snapshots exclude foreign agents from poisoned local bindings', async () => {
  const agentRows = [
    {
      agentKind: 'shared',
      id: localChildId,
      messages: [],
      organizationId,
      runs: [],
      status: 'idle',
      systemManaged: false,
      updatedAt: now,
    },
    {
      agentKind: 'shared',
      id: foreignChildId,
      messages: [],
      organizationId: otherOrganizationId,
      runs: [],
      status: 'idle',
      systemManaged: false,
      updatedAt: now,
    },
  ]
  const prisma = {
    agent: {
      findMany: async ({
        where,
      }: {
        where: {
          id: { in: string[] }
          organizationId?: string
        }
      }) =>
        agentRows.filter(
          (agent) =>
            where.id.in.includes(agent.id)
            && agent.organizationId
              === (where.organizationId ?? agent.organizationId),
        ),
    },
    agentBinding: {
      findMany: async () => [
        { agentId: localChildId },
        { agentId: foreignChildId },
      ],
    },
  } as unknown as PrismaClient
  const scopes: WsScope[] = [{ kind: 'organization', organizationId }]

  const snapshot = await buildSnapshotForScopes(prisma, scopes, { visibility })

  assert.deepEqual(snapshot.agents.map((agent) => agent.agentId), [localChildId])
})
