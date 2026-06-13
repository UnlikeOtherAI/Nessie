import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { registerAgentRoutes } from '../src/routes/agents.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const otherOrganizationId = '00000000-0000-4000-8000-000000000099'
const projectId = '00000000-0000-4000-8000-000000000002'
const teamId = '00000000-0000-4000-8000-000000000003'
const userId = '00000000-0000-4000-8000-00000000000a'
const agentId = '00000000-0000-4000-8000-000000000020'
const imageAttachmentId = '00000000-0000-4000-8000-0000000000f1'
const textAttachmentId = '00000000-0000-4000-8000-0000000000f2'
const otherOrgAttachmentId = '00000000-0000-4000-8000-0000000000f3'

type AttachmentRow = {
  id: string
  organizationId: string
  messageId: string | null
  kind: string
}

const actorContext: AuthorizedActionContext = {
  actor: { actorType: 'user', actorId: userId, roles: ['member'] },
  tenant: { organizationId, projectId, teamId },
  actionContext: { requestId: 'req-agent-avatar' },
}

const makeAgent = (avatarAttachmentId: string | null) => ({
  agentKind: 'shared' as const,
  avatarAttachmentId,
  bindings: [],
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  delegationMode: 'none' as const,
  id: agentId,
  messages: [],
  model: null,
  name: 'QA Agent',
  parentAgentId: null,
  provider: null,
  role: 'assistant',
  runs: [],
  status: 'idle' as const,
  surfacePolicy: 'shared' as const,
  systemManaged: false,
  systemPrompt: null,
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
})

const makeApp = (attachments: AttachmentRow[]) => {
  let savedAvatarAttachmentId: string | null = null
  const prisma = {
    agent: {
      findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, true> }) => {
        if (where.id !== agentId) return null
        if (select?.systemManaged) return { systemManaged: false }
        if (select?.id) return { id: agentId }
        return makeAgent(savedAvatarAttachmentId)
      },
      update: async ({ data, where }: { data: { avatarAttachmentId: string | null }; where: { id: string } }) => {
        assert.equal(where.id, agentId)
        savedAvatarAttachmentId = data.avatarAttachmentId
        return makeAgent(savedAvatarAttachmentId)
      },
    },
    attachment: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        attachments.find((attachment) => attachment.id === where.id) ?? null,
    },
  } as unknown as PrismaClient

  const app = Fastify({ logger: false })
  registerAgentRoutes(app, {
    createAgentVisibilityScope: () => ({}),
    getChannelIfMember: async () => null,
    isAgentAccessibleToActor: async (_context: AuthorizedActionContext, id: string) => id === agentId,
    prisma,
    requireActorContext: () => actorContext,
    requireOwner: () => true,
  } as unknown as Parameters<typeof registerAgentRoutes>[1])

  return { app, getSavedAvatar: () => savedAvatarAttachmentId }
}

test('PATCH /api/agents/:agentId/avatar sets an accessible image attachment', async () => {
  const { app, getSavedAvatar } = makeApp([
    { id: imageAttachmentId, organizationId, messageId: null, kind: 'image' },
  ])

  try {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/avatar`,
      payload: { avatarAttachmentId: imageAttachmentId },
    })

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().data.avatarAttachmentId, imageAttachmentId)
    assert.equal(getSavedAvatar(), imageAttachmentId)
  } finally {
    await app.close()
  }
})

test('PATCH /api/agents/:agentId/avatar rejects non-image attachments', async () => {
  const { app, getSavedAvatar } = makeApp([
    { id: textAttachmentId, organizationId, messageId: null, kind: 'text' },
  ])

  try {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/avatar`,
      payload: { avatarAttachmentId: textAttachmentId },
    })

    assert.equal(response.statusCode, 400)
    assert.equal(getSavedAvatar(), null)
  } finally {
    await app.close()
  }
})

test('PATCH /api/agents/:agentId/avatar rejects attachments outside the organization', async () => {
  const { app, getSavedAvatar } = makeApp([
    {
      id: otherOrgAttachmentId,
      organizationId: otherOrganizationId,
      messageId: null,
      kind: 'image',
    },
  ])

  try {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/avatar`,
      payload: { avatarAttachmentId: otherOrgAttachmentId },
    })

    assert.equal(response.statusCode, 404)
    assert.equal(getSavedAvatar(), null)
  } finally {
    await app.close()
  }
})
