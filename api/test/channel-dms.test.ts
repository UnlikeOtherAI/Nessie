import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  findOrCreateAgentDmChannel,
  findOrCreateDmChannel,
  findOrCreatePrivateConversationChannel,
} from '../src/services/channel-dms.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const teamId = '00000000-0000-4000-8000-000000000003'
const userId = '00000000-0000-4000-8000-00000000000a'
const otherUserId = '00000000-0000-4000-8000-00000000000b'
const agentId = '00000000-0000-4000-8000-00000000000c'
const channelId = '00000000-0000-4000-8000-000000000010'
const threadId = '00000000-0000-4000-8000-000000000011'
const legacyChannelId = '00000000-0000-4000-8000-000000000012'

type ChannelUpsertArgs = {
  create: {
    dmKey: string
    label: string
    members: { create: Array<{ userId: string }> }
    projectId: string
  }
}

test('findOrCreateDmChannel creates a one-member self DM', async () => {
  let upsertArgs: ChannelUpsertArgs | null = null

  const prisma = {
    organizationMember: {
      count: async ({ where }: { where: { userId: { in: string[] } } }) =>
        where.userId.in.includes(userId) ? 1 : 0,
    },
    user: {
      findUnique: async () => ({ displayName: 'Owner' }),
    },
    team: {
      findUnique: async () => ({
        name: 'Default Team',
        project: {
          id: projectId,
          name: 'Default Project',
          organizationId,
        },
      }),
    },
    channel: {
      findUnique: async () => null,
      upsert: async (args: ChannelUpsertArgs) => {
        upsertArgs = args
        return {
          archivedAt: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          description: null,
          dmKey: args.create.dmKey,
          id: channelId,
          label: args.create.label,
          organizationId,
          systemChannelType: null,
          team: {
            name: 'Default Team',
            project: { id: projectId, name: 'Default Project' },
          },
          teamId,
          topic: null,
          type: 'dm',
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          visibility: 'private',
        }
      },
      findUniqueOrThrow: async () => {
        throw new Error('unexpected existing DM lookup')
      },
    },
    thread: {
      findFirst: async () => ({ id: threadId }),
    },
    $queryRaw: async () => [{ thread_id: threadId, unread_count: 0 }],
  } as unknown as PrismaClient

  const channel = await findOrCreateDmChannel(prisma, {
    currentUserId: userId,
    organizationId,
    targetUserId: userId,
    teamId,
  })

  assert.equal(channel?.id, channelId)
  assert.equal(channel?.label, 'Owner')
  assert.equal(upsertArgs?.create.dmKey, `${organizationId}:${teamId}:${userId}:${userId}`)
  assert.deepEqual(upsertArgs?.create.members.create, [{ userId }])
  assert.equal(upsertArgs?.create.projectId, projectId)
})

test('findOrCreateDmChannel migrates a legacy one-member self DM key', async () => {
  let updateArgs: { data: { dmKey?: string; projectId?: string }; where: { id: string } } | null =
    null
  const legacyDmKey = `${organizationId}:${teamId}:${userId}`
  const canonicalDmKey = `${organizationId}:${teamId}:${userId}:${userId}`

  const channelRecord = (id: string, dmKey: string) => ({
    archivedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    description: null,
    dmKey,
    id,
    label: 'Owner',
    organizationId,
    projectId,
    slug: null,
    systemChannelType: null,
    team: {
      name: 'Default Team',
      project: { id: projectId, name: 'Default Project' },
    },
    teamId,
    topic: null,
    type: 'dm',
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    visibility: 'private',
  })

  const prisma = {
    organizationMember: {
      count: async ({ where }: { where: { userId: { in: string[] } } }) =>
        where.userId.in.includes(userId) ? 1 : 0,
    },
    user: {
      findUnique: async () => ({ displayName: 'Owner' }),
    },
    team: {
      findUnique: async () => ({
        name: 'Default Team',
        project: {
          id: projectId,
          name: 'Default Project',
          organizationId,
        },
      }),
    },
    channel: {
      findUnique: async () => channelRecord(legacyChannelId, legacyDmKey),
      update: async (args: { data: { dmKey?: string; projectId?: string }; where: { id: string } }) => {
        updateArgs = args
        return channelRecord(legacyChannelId, canonicalDmKey)
      },
      upsert: async () => {
        throw new Error('unexpected self DM upsert')
      },
      findUniqueOrThrow: async () => {
        throw new Error('unexpected existing DM lookup')
      },
    },
    thread: {
      findFirst: async () => ({ id: threadId }),
    },
    $queryRaw: async () => [{ thread_id: threadId, unread_count: 0 }],
  } as unknown as PrismaClient

  const channel = await findOrCreateDmChannel(prisma, {
    currentUserId: userId,
    organizationId,
    targetUserId: userId,
    teamId,
  })

  assert.equal(channel?.id, legacyChannelId)
  assert.equal(updateArgs?.where.id, legacyChannelId)
  assert.equal(updateArgs?.data.dmKey, canonicalDmKey)
  assert.equal(updateArgs?.data.projectId, projectId)
})

test('findOrCreateAgentDmChannel creates a one-user agent DM', async () => {
  let upsertArgs: {
    create: {
      agentBindings: { create: { agentId: string } }
      dmKey: string
      members: { create: { role: string; userId: string } }
      type: string
    }
  } | null = null
  let bindingArgs: {
    create: { agentId: string; channelId: string }
    where: { agentId_channelId: { agentId: string; channelId: string } }
  } | null = null

  const prisma = {
    organizationMember: {
      count: async () => 1,
    },
    agent: {
      findFirst: async () => ({ id: agentId, name: 'Planner' }),
    },
    agentBinding: {
      upsert: async (args: typeof bindingArgs) => {
        bindingArgs = args
        return null
      },
    },
    team: {
      findUnique: async () => ({
        project: {
          id: projectId,
          organizationId,
        },
      }),
    },
    channel: {
      upsert: async (args: NonNullable<typeof upsertArgs>) => {
        upsertArgs = args
        return {
          archivedAt: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          description: null,
          dmKey: args.create.dmKey,
          id: channelId,
          label: 'Planner',
          organizationId,
          slug: null,
          systemChannelType: null,
          team: {
            name: 'Default Team',
            project: { id: projectId, name: 'Default Project' },
          },
          teamId,
          topic: null,
          type: 'dm',
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          visibility: 'private',
        }
      },
      findUniqueOrThrow: async () => {
        throw new Error('unexpected existing agent DM lookup')
      },
    },
    thread: {
      findFirst: async () => ({ id: threadId }),
    },
    $queryRaw: async () => [{ thread_id: threadId, unread_count: 0 }],
  } as unknown as PrismaClient

  const channel = await findOrCreateAgentDmChannel(prisma, {
    agentId,
    currentUserId: userId,
    organizationId,
    teamId,
  })

  assert.equal(channel?.id, channelId)
  assert.equal(channel?.label, 'Planner')
  assert.equal(upsertArgs?.create.type, 'dm')
  assert.equal(upsertArgs?.create.dmKey, `${organizationId}:${teamId}:${userId}:agent:${agentId}`)
  assert.deepEqual(upsertArgs?.create.members.create, { userId, role: 'owner' })
  assert.deepEqual(upsertArgs?.create.agentBindings.create, { agentId })
  assert.deepEqual(bindingArgs?.where.agentId_channelId, { agentId, channelId })
})

test('findOrCreatePrivateConversationChannel creates a private mixed channel', async () => {
  let createArgs: {
    data: {
      agentBindings?: { create: Array<{ agentId: string }> }
      label: string
      members: { create: Array<{ role: string; userId: string }> }
      slug: string
      type: string
      visibility: string
    }
  } | null = null

  const prisma = {
    user: {
      findMany: async () => [
        { id: userId, displayName: 'Owner' },
        { id: otherUserId, displayName: 'Member' },
      ],
    },
    agent: {
      findMany: async () => [{ id: agentId, name: 'Planner' }],
    },
    team: {
      findUnique: async () => ({
        project: {
          id: projectId,
          organizationId,
        },
      }),
    },
    channel: {
      findMany: async () => [],
      create: async (args: NonNullable<typeof createArgs>) => {
        createArgs = args
        return {
          archivedAt: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          description: null,
          dmKey: null,
          id: channelId,
          label: args.data.label,
          organizationId,
          slug: args.data.slug,
          systemChannelType: null,
          team: {
            name: 'Default Team',
            project: { id: projectId, name: 'Default Project' },
          },
          teamId,
          topic: null,
          type: 'standard',
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          visibility: 'private',
        }
      },
    },
    thread: {
      findFirst: async () => ({ id: threadId }),
    },
    $queryRaw: async () => [{ thread_id: threadId, unread_count: 0 }],
  } as unknown as PrismaClient

  const channel = await findOrCreatePrivateConversationChannel(prisma, {
    agentIds: [agentId],
    currentUserId: userId,
    organizationId,
    teamId,
    userIds: [otherUserId],
  })

  assert.equal(channel?.id, channelId)
  assert.equal(channel?.type, 'standard')
  assert.equal(createArgs?.data.label, 'Member, Planner')
  assert.equal(createArgs?.data.slug, 'member-planner')
  assert.equal(createArgs?.data.visibility, 'private')
  assert.deepEqual(createArgs?.data.members.create, [
    { userId, role: 'owner' },
    { userId: otherUserId, role: 'member' },
  ])
  assert.deepEqual(createArgs?.data.agentBindings?.create, [{ agentId }])
})
