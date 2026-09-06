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
      // `mapChannelRecord` computes `viewerCanManage` via `canManageChannel`,
      // which re-reads the channel's own membership rows for the viewer —
      // none of them grant management here. See `channel-last-message.test.ts`
      // for the fuller version of this fake and why each delegate is needed.
      findFirst: async () => null,
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
    teamMember: {
      findFirst: async () => null,
    },
    channelMember: {
      findUnique: async () => null,
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
      dmKey: string
      members: { create: { role: string; userId: string } }
      type: string
    }
  } | null = null
  const bindingRows: Array<{ agentId: string; channelId: string }> = []

  const prisma = {
    organizationMember: {
      count: async () => 1,
    },
    agent: {
      findFirst: async () => ({ id: agentId, name: 'Planner' }),
    },
    agentBinding: {
      createMany: async (args: {
        data: Array<{ agentId: string; channelId: string }>
        skipDuplicates?: boolean
      }) => {
        let count = 0
        for (const binding of args.data) {
          const duplicate = bindingRows.some((row) =>
            row.agentId === binding.agentId && row.channelId === binding.channelId)
          if (duplicate) {
            if (args.skipDuplicates) continue
            throw new Error('agent binding pair must be unique')
          }
          bindingRows.push({ ...binding })
          count += 1
        }
        return { count }
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
      // `mapChannelRecord`'s `viewerCanManage` re-reads the channel by id via
      // `canManageChannel`; a miss is enough to make it return `null`.
      findUnique: async () => null,
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
      // The route reads the channel back by id once `ensureSharedAgentDm` has
      // written it, so the record it returns is the stored one.
      findUniqueOrThrow: async () => ({
        archivedAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        description: null,
        dmKey: `${organizationId}:${teamId}:${userId}:agent:${agentId}`,
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
      }),
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
  // The binding is what makes the agent addressable in this DM at all, and
  // what a later wake checks before starting a run.
  assert.deepEqual(bindingRows, [{ agentId, channelId }])
})

test('findOrCreatePrivateConversationChannel creates a private mixed group DM', async () => {
  let createArgs: {
    data: {
      agentBindings?: { create: Array<{ agentId: string }> }
      dmKey: string
      label: string
      members: { create: Array<{ role: string; userId: string }> }
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
      // `mapChannelRecord`'s `viewerCanManage` re-reads the channel by id via
      // `canManageChannel`; a miss is enough to make it return `null`.
      findUnique: async () => null,
      upsert: async (args: { create: NonNullable<typeof createArgs>['data'] }) => {
        createArgs = { data: args.create }
        return {
          archivedAt: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          description: null,
          dmKey: args.create.dmKey,
          id: channelId,
          label: args.create.label,
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
  assert.equal(channel?.type, 'dm')
  assert.equal(channel?.isGroupDm, true)
  assert.equal(createArgs?.data.label, 'Member, Planner')
  assert.equal(
    createArgs?.data.dmKey,
    `${organizationId}:${teamId}:group:${userId}:${otherUserId}:agents:${agentId}`,
  )
  assert.equal(createArgs?.data.visibility, 'private')
  assert.deepEqual(createArgs?.data.members.create, [
    { userId, role: 'owner' },
    { userId: otherUserId, role: 'member' },
  ])
  assert.deepEqual(createArgs?.data.agentBindings?.create, [{ agentId }])
})
